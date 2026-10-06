// محرك المزامنة على برنامج الديسكتوب:
//   الرفع (push): العمليات اللي في الطابور بتتبعت للسيرفر بالترتيب، والسيرفر بينفذها بنفس قواعده
//                (فالرصيد والنقط بيتجمعوا صح ومفيش ids بتتداخل — السيرفر هو اللي بيدي الـ ids).
//   التنزيل (pull): بعد ما الطابور يفضى، بننزل التغييرات من السيرفر: أول ما البرنامج يفتح، وكل 5 دقايق، ومع زرار "تنزيل".
//   التنزيل نفسه في الخلفية (البرنامج شغال عادي)، والحفظ بس هو اللي بيأخر الكتابة ثواني.
const store = require('./store');

const PULL_INTERVAL_MS = 5 * 60 * 1000;
const PING_INTERVAL_MS = 30 * 1000;
const FULL_REFRESH_EVERY_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60 * 1000;
const INSERT_CHUNK = 500;
const MAX_SERVER_ERROR_ATTEMPTS = 3;
const STALE_STARTED_MS = 2 * 60 * 1000;

const state = {
  online: false,
  deviceRevoked: false,
  pushing: false,
  pulling: false,
  lastPullAt: null,
  lastPushAt: null,
  lastError: null,
  clockOffsetMs: 0,
  initialDataReady: false,
  progress: null,
};

const inflight = new Map(); // op_id → وقت البداية (طلبات شغالة دلوقتي على الجهاز)
let gate = null; // وعد شغال وقت حفظ التنزيل: العمليات الجديدة (الكتابة) بتستنى لحد ما يخلص
let fullApplying = false; // شكل جدول بيتغير (DROP/CREATE): حتى الصفحات بتستنى
let writeSeq = 0; // بيزيد مع كل عملية كتابة: لو حصلت كتابة وقت التنزيل بنأجل الحفظ للمرة الجاية
let pushTimer = null;
let listeners = [];

function serverUrl(path) {
  return `${String(process.env.SYNC_SERVER_URL || '').replace(/\/+$/, '')}${path}`;
}

function deviceHeaders(extra = {}) {
  return {
    'x-sync-device-token': process.env.SYNC_DEVICE_TOKEN || '',
    'x-app-version': process.env.APP_VERSION || '',
    ...extra,
  };
}

function notify() {
  for (const fn of listeners) {
    try { fn(); } catch (e) { /* ignore listener errors */ }
  }
}

function onChange(fn) {
  listeners.push(fn);
}

function correctedNow() {
  return Date.now() + state.clockOffsetMs;
}

async function serverFetch(path, options = {}) {
  const response = await fetch(serverUrl(path), {
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeout || REQUEST_TIMEOUT_MS),
    ...options,
    headers: deviceHeaders(options.headers || {}),
  });
  if (response.status === 401) {
    const body = await response.json().catch(() => ({}));
    if (body.code === 'DEVICE_NOT_AUTHORIZED') {
      state.deviceRevoked = true;
      notify();
      const error = new Error('الجهاز ده اتلغى تسجيله من السيرفر');
      error.code = 'DEVICE_REVOKED';
      throw error;
    }
  }
  return response;
}

async function ping() {
  try {
    const response = await serverFetch('/api/sync/ping', { timeout: 10000 });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    // فرق الساعة بين الجهاز والسيرفر عشان وقت العمليات الأوفلاين يتسجل صح حتى لو ساعة الجهاز غلط
    if (body.serverNow) state.clockOffsetMs = Number(body.serverNow) - Date.now();
    state.deviceRevoked = false;
    setOnline(true);
    return true;
  } catch (error) {
    setOnline(false, error);
    return false;
  }
}

function setOnline(online, error) {
  const changed = state.online !== online;
  state.online = online;
  if (error && error.code !== 'DEVICE_REVOKED') state.lastError = online ? null : `مفيش اتصال بالسيرفر (${error.message})`;
  if (online) state.lastError = null;
  if (changed) notify();
  if (changed && online) schedulePush(0);
}

// ===== بوابة الكتابة =====
async function waitForGate() {
  while (gate) await gate;
}

// الصفحات (قراءة بس) مش بتستنى التحديثات العادية، بس بتستنى النسخة الكاملة (اللي بتفضي الجداول وتملاها)
async function waitForFullApply() {
  while (gate && fullApplying) await gate;
}

function opStarted(opId) {
  inflight.set(opId, Date.now());
}

function opFinished(opId, wrote) {
  inflight.delete(opId);
  if (wrote) writeSeq += 1;
  if (wrote) schedulePush(300);
  notify();
}

async function holdGate(fn) {
  await waitForGate();
  let release;
  gate = new Promise(resolve => { release = resolve; });
  try {
    const waitStart = Date.now();
    while (inflight.size && Date.now() - waitStart < 30000) await new Promise(r => setTimeout(r, 100));
    return await fn();
  } finally {
    gate = null;
    release();
  }
}

// ===== الرفع =====
function schedulePush(delay) {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    push().catch(() => {});
  }, delay);
}

function remapValue(value, unresolved) {
  if (typeof value === 'number' || (typeof value === 'string' && /^[1-9]\d{9}$/.test(value))) {
    if (store.isLocalId(value)) {
      const mapped = store.mapLocalId(value);
      if (mapped === undefined) {
        unresolved.push(value);
        return value;
      }
      return typeof value === 'number' ? mapped : String(mapped);
    }
  }
  return value;
}

function remapDeep(value, unresolved) {
  if (Array.isArray(value)) return value.map(item => remapDeep(item, unresolved));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = remapDeep(item, unresolved);
    return out;
  }
  return remapValue(value, unresolved);
}

function remapUrl(url, unresolved) {
  return url.replace(/(^|[^0-9])([1-9]\d{9})(?=[^0-9]|$)/g, (match, prefix, digits) => prefix + remapValue(digits, unresolved));
}

function pairCreated(localCreated, serverCreated) {
  const byTable = new Map();
  for (const row of serverCreated || []) {
    if (!byTable.has(row.table)) byTable.set(row.table, []);
    byTable.get(row.table).push(row.id);
  }
  const pairs = [];
  const seen = new Map();
  for (const row of localCreated || []) {
    const index = seen.get(row.table) || 0;
    seen.set(row.table, index + 1);
    const serverIds = byTable.get(row.table) || [];
    if (index < serverIds.length && store.isLocalId(row.id)) pairs.push({ table: row.table, localId: row.id, serverId: serverIds[index] });
  }
  return pairs;
}

async function addRefreshTables(tables) {
  if (!tables || !tables.length) return;
  const current = new Set(await store.getKv('refresh_tables', []));
  for (const table of tables) current.add(table);
  await store.setKv('refresh_tables', [...current]);
}

async function failOp(op, fields) {
  await store.markOp(op.seq, { state: 'failed', finished_at: store.mysqlNow(), ...fields });
  // الجهاز كان عدّل حاجات محليًا للعملية دي، والسيرفر رفضها: ننزل الجداول دي كاملة عشان نرجع لبيانات السيرفر
  let tables = [];
  try { tables = JSON.parse(op.local_tables || '[]'); } catch (e) { tables = []; }
  await addRefreshTables(tables);
}

async function sendOp(op) {
  const payload = store.unseal(op.payload);
  const unresolved = [];
  const url = remapUrl(op.url, unresolved);
  const body = remapDeep(payload.body || {}, unresolved);
  const context = remapDeep(payload.context || {}, unresolved);
  if (unresolved.length) {
    await failOp(op, {
      server_message: 'العملية دي كانت معتمدة على حاجة اتعملت أوفلاين (زي حصة جديدة) والحاجة دي ماترفعتش على السيرفر، فماتنفذتش.',
    });
    return 'failed';
  }

  const headers = {
    'content-type': 'application/json',
    accept: payload.headers?.accept || '*/*',
    'x-sync-op-id': op.op_id,
    'x-sync-context': Buffer.from(JSON.stringify({ ...context, clientTime: Number(op.client_time) }), 'utf8').toString('base64'),
  };
  if (payload.headers?.['x-requested-with']) headers['x-requested-with'] = payload.headers['x-requested-with'];

  const hasBody = !['GET', 'HEAD'].includes(op.method);
  const response = await serverFetch(url, { method: op.method, headers, body: hasBody ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let envelope = null;
  try { envelope = JSON.parse(text); } catch (e) { envelope = null; }

  if (!envelope || !envelope.envelope) {
    // رد مش من نظام المزامنة (السيرفر رفض قبل ما ينفذ: جهاز/يوزر/عملية لسه شغالة)
    const code = envelope && envelope.code;
    if (response.status === 409 && code === 'OP_IN_PROGRESS') return 'retry-later';
    if (response.status === 503 || response.status === 502 || response.status === 504) return 'retry-later';
    if (code === 'OP_STUCK' || code === 'USER_GONE' || response.status === 400 || response.status === 403) {
      await failOp(op, { server_message: (envelope && envelope.message) || `HTTP ${response.status}` });
      return 'failed';
    }
    return countServerError(op, `رد غير متوقع من السيرفر (HTTP ${response.status})`);
  }

  if (envelope.status >= 500) return countServerError(op, envelope.message || `HTTP ${envelope.status}`);

  let localCreated = [];
  try { localCreated = JSON.parse(op.local_created || '[]'); } catch (e) { localCreated = []; }
  for (const pair of pairCreated(localCreated, envelope.created)) {
    await store.addIdMapping(pair.localId, pair.serverId, pair.table, op.op_id);
  }

  const localOk = op.local_ok === null || Number(op.local_ok) === 1;
  if (envelope.ok || !localOk) {
    // نجحت على السيرفر، أو كانت مرفوضة على الجهاز كمان (يعني محدش اتفاجئ بالنتيجة)
    await store.markOp(op.seq, { state: 'done', finished_at: store.mysqlNow(), server_message: envelope.message || null });
    return 'done';
  }
  await failOp(op, { server_message: envelope.message || 'السيرفر رفض العملية' });
  return 'failed';
}

async function countServerError(op, message) {
  const attempts = Number(op.attempts) + 1;
  if (attempts >= MAX_SERVER_ERROR_ATTEMPTS) {
    await failOp(op, { attempts, server_message: `السيرفر طلع خطأ ${attempts} مرات: ${message}` });
    return 'failed';
  }
  await store.markOp(op.seq, { attempts, last_error: message });
  return 'retry-later';
}

async function push({ force = false } = {}) {
  if (state.pushing) return { busy: true };
  if (!process.env.SYNC_DEVICE_TOKEN) return { skipped: 'not-registered' };
  state.pushing = true;
  notify();
  const summary = { sent: 0, failed: 0, remaining: 0 };
  try {
    if (!state.online && !(await ping())) {
      summary.offline = true;
      return summary;
    }
    for (;;) {
      const ops = await store.nextPendingOps(25);
      if (!ops.length) break;
      let stop = false;
      for (const op of ops) {
        if (op.state === 'started') {
          const startedAt = inflight.get(op.op_id);
          // لسه بتتنفذ على الجهاز: نستنى (الترتيب مهم)
          if (startedAt && Date.now() - startedAt < STALE_STARTED_MS) { stop = true; break; }
        }
        let result;
        try {
          result = await sendOp(op);
        } catch (error) {
          if (error.code === 'DEVICE_REVOKED') { stop = true; break; }
          await store.markOp(op.seq, { last_error: error.message });
          setOnline(false, error);
          summary.offline = true;
          stop = true;
          break;
        }
        if (result === 'retry-later') { stop = true; break; }
        if (result === 'failed') summary.failed += 1; else summary.sent += 1;
        notify();
      }
      if (stop) break;
    }
    if (summary.sent || summary.failed) {
      state.lastPushAt = new Date().toISOString();
      // اللي اترفع لازم يرجع من السيرفر بالـ ids الحقيقية
      setTimeout(() => pull().catch(() => {}), 200);
    }
    return summary;
  } finally {
    summary.remaining = (await store.countByState().catch(() => ({ pending: 0 }))).pending;
    state.pushing = false;
    notify();
    if (force && summary.remaining && state.online) schedulePush(2000);
  }
}

// ===== التنزيل =====
function quoteId(name) {
  return '`' + String(name).replace(/`/g, '``') + '`';
}

function decodeRow(row) {
  return row.map(value => (value && typeof value === 'object' && value.$b64 !== undefined ? Buffer.from(value.$b64, 'base64') : value));
}

async function tableBase(table) {
  const bases = await store.getKv('id_bases', {});
  if (bases[table] === undefined) {
    const used = Object.values(bases);
    bases[table] = used.length ? Math.max(...used) + 1 : 0;
    await store.setKv('id_bases', bases);
  }
  return store.LOCAL_ID_BASE + bases[table] * store.LOCAL_ID_SPAN;
}

async function localFingerprint(conn, table) {
  const [[row]] = await conn.query(`SELECT COUNT(*) AS c, COALESCE(SUM(id), 0) AS s, MAX(updatedAt) AS m FROM ${quoteId(table)}`);
  return `${row.c}|${row.s}|${row.m || ''}`;
}

async function applyTable(conn, table, entry) {
  if (entry.ddl) {
    await conn.query(`DROP TABLE IF EXISTS ${quoteId(table)}`);
    await conn.query(entry.ddl);
  }
  if (entry.mode === 'skip' && !entry.ddl) {
    if (!entry.idColumn) return false;
    const [result] = await conn.query(`DELETE FROM ${quoteId(table)} WHERE id >= ?`, [store.LOCAL_ID_BASE]);
    return result.affectedRows > 0;
  }
  const columns = entry.columns.map(quoteId).join(', ');
  const rows = (entry.rows || []).map(decodeRow);
  if (entry.idColumn) {
    const idIndex = entry.columns.indexOf('id');
    if (rows.some(row => Number(row[idIndex]) >= store.LOCAL_ID_BASE)) {
      throw new Error(`السيرفر فيه ids كبيرة جدًا في جدول ${table} — المزامنة وقفت للأمان`);
    }
  }
  await conn.beginTransaction();
  try {
    if (entry.mode === 'full') {
      await conn.query(`DELETE FROM ${quoteId(table)}`);
    } else if (entry.idColumn) {
      // الصفوف اللي اتعملت أوفلاين على الجهاز اترفعت خلاص ورجعت بالـ ids الحقيقية
      await conn.query(`DELETE FROM ${quoteId(table)} WHERE id >= ?`, [store.LOCAL_ID_BASE]);
    }
    const onDuplicate = entry.mode === 'full' ? ''
      : ` ON DUPLICATE KEY UPDATE ${entry.columns.map(c => `${quoteId(c)} = VALUES(${quoteId(c)})`).join(', ')}`;
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      await conn.query(`INSERT INTO ${quoteId(table)} (${columns}) VALUES ?${onDuplicate}`, [rows.slice(i, i + INSERT_CHUNK)]);
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  }
  return true;
}

async function resetAutoIncrement(conn, table, entry) {
  if (!entry.autoIncrement || !entry.idColumn) return;
  await conn.query(`ALTER TABLE ${quoteId(table)} AUTO_INCREMENT = ${await tableBase(table)}`);
}

async function requestPull(body) {
  const response = await serverFetch('/api/sync/pull', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept-encoding': 'gzip' },
    body: JSON.stringify(body),
    timeout: 5 * 60 * 1000,
  });
  if (!response.ok) throw new Error(`فشل التنزيل من السيرفر (HTTP ${response.status})`);
  return response.json();
}

async function pull({ full = false } = {}) {
  if (state.pulling) return { busy: true };
  if (!process.env.SYNC_DEVICE_TOKEN) return { skipped: 'not-registered' };
  state.pulling = true;
  notify();
  try {
    // لازم الطابور يفضى الأول: لو نزلنا بيانات السيرفر فوق تعديلات لسه ماترفعتش هتختفي من الشاشة
    const counts = await store.countByState();
    if (counts.pending) {
      await push();
      if ((await store.countByState()).pending) {
        return { skipped: 'pending-uploads' };
      }
    }
    // التنزيل من النت بيحصل في الخلفية والبرنامج شغال عادي؛ الحفظ بس هو اللي بيوقف الكتابة ثواني
    const prepared = await downloadPull(full);
    const seqBefore = prepared.seq;
    return await holdGate(async () => {
      if (writeSeq !== seqBefore) return { skipped: 'writes-during-download' };
      // كل جدول بيتحفظ جوه transaction، فالصفحات بتشوف البيانات القديمة لحد ما الجديدة تخلص.
      // الاستثناء الوحيد: تغيير شكل جدول (DROP/CREATE) — ساعتها بس الصفحات تستنى
      fullApplying = Object.values(prepared.response.tables || {}).some(entry => entry.ddl);
      try {
        return await applyPull(prepared);
      } finally {
        fullApplying = false;
      }
    });
  } catch (error) {
    if (error.code !== 'DEVICE_REVOKED') {
      if (error.name === 'TimeoutError' || error.name === 'TypeError') setOnline(false, error);
      else state.lastError = `فشل التنزيل: ${error.message}`;
    }
    throw error;
  } finally {
    state.pulling = false;
    state.progress = null;
    notify();
  }
}

async function downloadPull(full) {
  const seq = writeSeq;
  const lastFull = await store.getKv('last_full_pull', 0);
  // نسخة كاملة مرة واحدة بعد إصلاح الجداول اللي أساميها بتفرق في الحروف الكبيرة بس (عشان ترجع البيانات اللي اتمسحت)
  const caseFixed = await store.getKv('case_fix_v1', false);
  const doFull = full || !caseFixed || !lastFull || Date.now() - lastFull > FULL_REFRESH_EVERY_MS;
  const tablesState = await store.getKv('tables', {});
  const refreshTables = await store.getKv('refresh_tables', []);
  const since = await store.getKv('last_server_time', null);

  state.progress = doFull ? 'بينزل نسخة كاملة من السيرفر...' : 'بينزل التحديثات...';
  notify();
  const response = await requestPull({ full: doFull, since, tables: tablesState, fullTables: refreshTables });
  setOnline(true);
  return { seq, doFull, tablesState, response };
}

// السيرفر (لينكس) ممكن يكون فيه جدولين الفرق بينهم الحروف الكبيرة بس (VideoSessions و videosessions)،
// وويندوز بيعتبرهم جدول واحد — فلو اتحفظوا الاتنين، الفاضي بيمسح اللي فيه بيانات.
// بنحتفظ باللي فيه صفوف أكتر بس.
function rowCount(entry) {
  const fromFingerprint = Number(String(entry.fingerprint || '').split('|')[0]);
  if (Number.isFinite(fromFingerprint) && !String(entry.fingerprint).startsWith('checksum|')) return fromFingerprint;
  return (entry.rows || []).length;
}

function dropCaseDuplicates(tables) {
  const byLower = new Map();
  for (const name of Object.keys(tables)) {
    const key = name.toLowerCase();
    if (!byLower.has(key)) byLower.set(key, []);
    byLower.get(key).push(name);
  }
  const dropped = [];
  for (const names of byLower.values()) {
    if (names.length < 2) continue;
    names.sort((a, b) => rowCount(tables[b]) - rowCount(tables[a]));
    for (const loser of names.slice(1)) {
      delete tables[loser];
      dropped.push(loser);
    }
  }
  return dropped;
}

async function applyPull({ doFull, tablesState, response }) {
  const dropped = dropCaseDuplicates(response.tables);
  for (const name of dropped) delete tablesState[name];

  const conn = await store.data().getConnection();
  const mismatched = [];
  try {
    await conn.query("SET FOREIGN_KEY_CHECKS = 0, sql_mode = 'NO_AUTO_VALUE_ON_ZERO'");
    const tableNames = Object.keys(response.tables);
    const rebuild = [];
    let index = 0;
    for (const table of tableNames) {
      index += 1;
      const entry = response.tables[table];
      if (entry.mode !== 'skip' || entry.ddl) {
        state.progress = `${doFull ? 'نسخة كاملة' : 'تحديثات'}: ${index}/${tableNames.length} (${table})`;
        notify();
      }
      let touched;
      try {
        touched = await applyTable(conn, table, entry);
      } catch (error) {
        // شكل الجدول على الجهاز مش مطابق للسيرفر (مثلاً قيد unique مش موجود هناك): نعيد بناءه بشكل السيرفر
        if (!['ER_DUP_ENTRY', 'ER_BAD_FIELD_ERROR', 'ER_WRONG_VALUE_COUNT_ON_ROW', 'ER_NO_DEFAULT_FOR_FIELD'].includes(error.code)) throw error;
        console.error(`Sync: rebuilding ${table} with the server structure:`, error.message);
        rebuild.push(table);
        delete tablesState[table];
        continue;
      }
      if (touched) await resetAutoIncrement(conn, table, entry);
      if (touched && entry.idColumn && entry.fingerprint && !entry.fingerprint.startsWith('checksum|')) {
        if (await localFingerprint(conn, table) !== entry.fingerprint) mismatched.push(table);
      }
      tablesState[table] = { ddlHash: entry.ddlHash, fingerprint: entry.fingerprint };
    }

    if (rebuild.length) await rebuildTables(conn, rebuild, tablesState);
    if (mismatched.length) await reconcileIds(conn, mismatched, tablesState);
  } finally {
    await conn.query('SET FOREIGN_KEY_CHECKS = 1').catch(() => {});
    conn.release();
  }

  await store.setKv('tables', tablesState);
  await store.setKv('last_server_time', response.serverTime);
  await store.setKv('refresh_tables', []);
  if (doFull) {
    await store.setKv('last_full_pull', Date.now());
    await store.setKv('case_fix_v1', true);
  }
  await store.purgeOldHistory().catch(() => {});
  state.lastPullAt = new Date().toISOString();
  state.initialDataReady = true;
  return { ok: true, full: doFull, mismatched };
}

// جداول شكلها على الجهاز غلط: بنطلبها تاني من غير ما نقول للسيرفر إننا عارفين شكلها، فبيبعت الشكل (DDL) + كل الصفوف
async function rebuildTables(conn, tables, tablesState) {
  state.progress = `إعادة بناء: ${tables.join(', ')}`;
  notify();
  const response = await requestPull({ full: false, since: await store.getKv('last_server_time', null), tables: tablesState, fullTables: tables });
  dropCaseDuplicates(response.tables);
  for (const table of tables) {
    const entry = response.tables[table];
    if (!entry) continue;
    if (!entry.ddl) throw new Error(`مش قادر يعيد بناء جدول ${table}`);
    await applyTable(conn, table, { ...entry, mode: 'full' });
    await resetAutoIncrement(conn, table, entry);
    tablesState[table] = { ddlHash: entry.ddlHash, fingerprint: entry.fingerprint };
  }
}

// بعد التحديثات لو عدد الصفوف لسه مختلف عن السيرفر: يبقى فيه صفوف اتحذفت على السيرفر (أو فاتتنا)
async function reconcileIds(conn, tables, tablesState) {
  const response = await serverFetch('/api/sync/ids', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tables }),
    timeout: 5 * 60 * 1000,
  });
  if (!response.ok) throw new Error(`فشل التحقق من الصفوف (HTTP ${response.status})`);
  const { tables: serverIds } = await response.json();
  const needFull = [];
  for (const table of tables) {
    const ids = new Set((serverIds[table] || []).map(Number));
    const [localRows] = await conn.query({ sql: `SELECT id FROM ${quoteId(table)}`, rowsAsArray: true });
    const localIds = new Set(localRows.map(row => Number(row[0])));
    const toDelete = [...localIds].filter(id => !ids.has(id));
    for (let i = 0; i < toDelete.length; i += 1000) {
      await conn.query(`DELETE FROM ${quoteId(table)} WHERE id IN (?)`, [toDelete.slice(i, i + 1000)]);
    }
    if ([...ids].some(id => !localIds.has(id))) needFull.push(table);
  }
  if (needFull.length) {
    // فيه صفوف على السيرفر مش عندنا: ننزل الجداول دي كاملة
    const response2 = await requestPull({ full: false, since: null, tables: {}, fullTables: needFull });
    for (const table of needFull) {
      const entry = response2.tables[table];
      if (!entry) continue;
      await applyTable(conn, table, { ...entry, ddl: undefined, mode: 'full' });
      await resetAutoIncrement(conn, table, entry);
      tablesState[table] = { ddlHash: entry.ddlHash, fingerprint: entry.fingerprint };
    }
  }
}

// ===== الحالة + التشغيل =====
async function status() {
  const counts = await store.countByState().catch(() => ({ pending: 0, failed: 0 }));
  return {
    online: state.online,
    deviceRevoked: state.deviceRevoked,
    pushing: state.pushing,
    pulling: state.pulling,
    progress: state.progress,
    pending: counts.pending,
    problems: counts.failed,
    lastPullAt: state.lastPullAt,
    lastPushAt: state.lastPushAt,
    lastError: state.lastError,
    serverUrl: process.env.SYNC_SERVER_URL || '',
    appVersion: process.env.APP_VERSION || '',
  };
}

async function init() {
  await store.init();
  await store.loadIdMap();
  // أي عملية كانت شغالة لما البرنامج اتقفل فجأة: نعتبرها حصلت (أأمن من إننا نضيعها)
  await store.meta().query("UPDATE outbox SET state = 'ready' WHERE state = 'started'");
  const lastPull = await store.getKv('last_server_time', null);
  state.initialDataReady = Boolean(lastPull);
  const lastPullAt = await store.getKv('last_pull_at_local', null);
  state.lastPullAt = lastPullAt;
  onChange(() => {
    if (state.lastPullAt) store.setKv('last_pull_at_local', state.lastPullAt).catch(() => {});
  });
}

function start() {
  ping().then(() => pull().catch(() => {}));
  setInterval(() => pull().catch(() => {}), PULL_INTERVAL_MS);
  setInterval(() => {
    if (!state.online) ping();
    else schedulePush(0);
  }, PING_INTERVAL_MS);
}

module.exports = {
  state, init, start, ping, push, pull, status, onChange, correctedNow,
  waitForGate, waitForFullApply, opStarted, opFinished, schedulePush,
};
