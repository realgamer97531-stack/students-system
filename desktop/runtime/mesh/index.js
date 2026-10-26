// شبكة الأجهزة على برنامج الديسكتوب (جوه عملية السيرفر المحلي):
//   - بيدخل الشبكة بالواي فاي (lan.js) ويتكلم مع الموبايلات والأجهزة التانية بنفس البروتوكول
//   - عمليات الموبايلات (حضور/واجب) بتتنفذ على قاعدة البيانات اللي على الجهاز فتبان في السيستم على طول،
//     من غير ما تدخل طابور الرفع بتاع الجهاز (اللي عملها أو "الرافع" هو اللي بيرفعها) — ومستحيل تتنفذ مرتين
//   - عمليات المسح اللي اتعملت على الكمبيوتر بتتبعت للشبكة (متوقعة بمفتاح الجهاز)
//   - بيدي الموبايلات نسخة البيانات (من قاعدة البيانات اللي على الجهاز) لما يطلبوها
//   - ينفع يبقى "الرافع": يرفع عمليات كل الأجهزة أول ما يلاقي نت
const crypto = require('crypto');
const os = require('os');
const { MeshLog, MeshNode, computeStatuses, OpState, hmacHex, pcWifiCredentials } = require('./core');
const { LanTransport } = require('./lan');
const { PcHotspot, allowInFirewall } = require('./hotspot');

const SCAN_PATHS = new Set(['/attendance/scan', '/homework/scan/save']);
const sha = v => crypto.createHash('sha256').update(String(v)).digest('hex');

const state = {
  ready: false,
  enabled: false,
  running: false,
  message: '',
  uploading: false,
  meshKey: '',
  nodeId: null,
  hotspot: true, // الكمبيوتر يعمل واي فاي بنفسه للموبايلات (تقدر تقفله لو فيه راوتر)
  firewall: false, // اتعمل "سماح في الفايروول" على الجهاز ده
};

const hotspot = new PcHotspot();
function syncHotspot() {
  if (node && state.hotspot && state.meshKey) hotspot.start(pcWifiCredentials(state.meshKey));
  else hotspot.stop();
}

let deps = null; // { sequelize, engine, store, buildMobileSnapshot, ensureSyncSchema, replayLocally }
let log = new MeshLog();
let node = null;
let statusesCache = null;
let saveTimer = null;
let snapshotCache = null;
const applyQueue = [];
let applying = false;

function statuses() {
  if (!statusesCache) statusesCache = computeStatuses(log);
  return statusesCache;
}
function dirty() { statusesCache = null; }

function deviceToken() { return process.env.SYNC_DEVICE_TOKEN || ''; }

const host = {
  get meshKey() { return state.meshKey; },
  get displayName() { return process.env.DESKTOP_DEVICE_NAME || os.hostname(); },
  userName: '',
  role: 'كمبيوتر',
  wantsSnapshots: false, // الكمبيوتر عنده قاعدة البيانات كاملة — مش محتاج نسخة الموبايل
  get snapshotAt() {
    const at = deps && deps.engine.state.lastPullAt;
    return at ? new Date(at).getTime() : 0;
  },
  get pendingCount() { return 0; },
  async snapshotRaw() {
    if (snapshotCache && Date.now() - snapshotCache.at < 60 * 1000) return snapshotCache.raw;
    const snap = await deps.buildMobileSnapshot(deps.sequelize, { meshKey: state.meshKey, excludeLocalIds: true });
    snapshotCache = { at: Date.now(), raw: JSON.stringify(snap) };
    return snapshotCache.raw;
  },
  onSnapshot() {},
  onEntries(added) {
    dirty();
    for (const e of added) if (e.k === 'op' && e.o !== state.nodeId) applyQueue.push(e);
    drainApply();
  },
  saveLog() {
    dirty();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      log.prune(Date.now() - 3 * 24 * 60 * 60 * 1000, isDone);
      deps.store.setKv('mesh_log', log.toJSON()).catch(() => {});
    }, 800);
  },
};

function isDone(e) {
  if (e.k === 'cfg') return false;
  if (e.k !== 'op') return true;
  const s = statuses().get(String(e.d && e.d.id));
  return s && s.state !== OpState.pending && s.state !== OpState.review;
}

// ===== تنفيذ عمليات الموبايلات على قاعدة البيانات اللي على الجهاز =====
async function drainApply() {
  if (applying || !deps) return;
  applying = true;
  try {
    while (applyQueue.length) {
      const e = applyQueue.shift();
      const d = e.d || {};
      if (d.local || !SCAN_PATHS.has(d.path) || !d.body || !Number.isInteger(Number(d.userId))) continue;
      if (Number(d.sid) >= 2000000000) continue;
      const s = statuses().get(String(d.id));
      if (s && s.state !== OpState.pending && s.state !== OpState.uploaded) continue;
      try {
        await deps.replayLocally(
          { id: `mesh:${d.id}`.slice(0, 64), path: d.path, body: d.body, userId: Number(d.userId), activeSessionId: d.sid == null ? null : Number(d.sid), clientTime: Number(d.ct) || Date.now() },
          { id: 0, name: 'شبكة الأجهزة' },
        );
      } catch (error) {
        console.error('Mesh local apply failed:', error.message);
      }
    }
  } finally {
    applying = false;
  }
}

// بعد ما الجهاز ينزل بيانات من السيرفر (ممكن يمسح صفوف لسه مترفعتش): نعيد تنفيذ عمليات الشبكة اللي لسه مارفعتش
async function reapplyPending() {
  const pending = log.ofKind('op').filter(e => e.o !== state.nodeId && (statuses().get(String(e.d.id)) || {}).state === OpState.pending);
  if (!pending.length) return;
  const ids = pending.map(e => `mesh:${e.d.id}`.slice(0, 64));
  await deps.sequelize.query('DELETE FROM sync_applied_ops WHERE op_id IN (?)', { replacements: [ids] }).catch(() => {});
  applyQueue.push(...pending);
  drainApply();
}

// ===== عمليات الكمبيوتر نفسه =====
function publish(kind, data) {
  if (node) return node.publish(kind, data);
  const seq = log.maxSeq(state.nodeId) + 1;
  const entry = { e: `${state.nodeId}:${seq}`, o: state.nodeId, s: seq, k: kind, at: Date.now(), d: data };
  log.add(entry);
  host.saveLog();
  return entry;
}

/** بيتنادي من server-hooks بعد أي عملية كتابة نجحت على الجهاز */
function recordDesktopOp(op, context) {
  if (!state.ready || !state.nodeId) return;
  let path;
  try { path = new URL(op.url, 'http://x').pathname; } catch (e) { return; }
  if (!SCAN_PATHS.has(path)) return;
  const sid = context && context.activeSessionId;
  if (sid == null || Number(sid) >= 2000000000) return; // حصة اتعملت أوفلاين: الموبايلات متعرفهاش
  const userId = Number(context.userId);
  const body = op.payload.body || {};
  const data = {
    id: op.opId, kind: path === '/attendance/scan' ? 'attendance' : 'homework', path, body, userId, sid: Number(sid),
    ct: op.clientTime, label: op.summary || path, user: op.userName || host.displayName,
  };
  const token = deviceToken();
  if (token) {
    const tokenHash = sha(token);
    const p = JSON.stringify([op.opId, path, body, userId, Number(sid), op.clientTime]);
    Object.assign(data, { dev: sha(tokenHash), p, sig: hmacHex(tokenHash, p) });
  }
  publish('op', data);
}

// إيصالات العمليات اللي الكمبيوتر رفعها بنفسه (من طابور الرفع بتاعه)
async function publishOwnReceipts() {
  const mine = log.ofKind('op').filter(e => e.o === state.nodeId && (statuses().get(String(e.d.id)) || {}).state === OpState.pending);
  if (!mine.length) return;
  const [rows] = await deps.store.meta().query('SELECT op_id, state, server_message FROM outbox WHERE op_id IN (?)', [mine.map(e => e.d.id)]);
  const byId = new Map(rows.map(r => [r.op_id, r]));
  for (const e of mine) {
    const row = byId.get(e.d.id);
    if (!row) publish('rc', { op: e.d.id, ok: true, msg: '', by: host.displayName }); // اترفعت واتمسحت من السجل القديم
    else if (row.state === 'done') publish('rc', { op: e.d.id, ok: true, msg: row.server_message || '', by: host.displayName });
    else if (row.state === 'failed') publish('rc', { op: e.d.id, ok: false, msg: row.server_message || 'السيرفر رفض العملية', by: host.displayName });
  }
}

// ===== الرافع =====
function uploaderNode() {
  let latest = null;
  for (const e of log.ofKind('cfg')) {
    if (!e.d || !Object.prototype.hasOwnProperty.call(e.d, 'uploader')) continue;
    if (!latest || e.at > latest.at) latest = e;
  }
  return latest ? latest.d.uploader : null;
}

async function serverFetch(path, options = {}) {
  const base = String(process.env.SYNC_SERVER_URL || '').replace(/\/+$/, '');
  return fetch(`${base}${path}`, {
    ...options,
    headers: { 'x-sync-device-token': deviceToken(), accept: 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(60 * 1000),
  });
}

async function uploadForOthers({ force = false } = {}) {
  if (!state.ready || state.uploading) return 0;
  if (!force && uploaderNode() !== state.nodeId) return 0;
  if (!deps.engine.state.online) return 0;
  const pending = log.ofKind('op').filter((e) => {
    const d = e.d;
    return e.o !== state.nodeId && !d.local && d.sig && (statuses().get(String(d.id)) || {}).state === OpState.pending;
  }).sort((a, b) => (a.d.ct || 0) - (b.d.ct || 0));
  if (!pending.length) return 0;
  state.uploading = true;
  let sent = 0;
  try {
    for (let i = 0; i < pending.length; i += 100) {
      const batch = pending.slice(i, i + 100).map(e => ({ id: e.d.id, dev: e.d.dev, p: e.d.p, sig: e.d.sig }));
      const response = await serverFetch('/api/sync/mesh/relay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops: batch }) });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || !json.success) throw new Error(json.message || `HTTP ${response.status}`);
      for (const r of json.results || []) {
        if (r.retry) continue;
        publish('rc', { op: r.id, ok: r.ok === true, msg: r.message || '', dup: r.duplicate === true, by: host.displayName });
        sent++;
      }
    }
  } catch (error) {
    state.message = `الرفع وقف: ${error.message}`;
  } finally {
    state.uploading = false;
  }
  return sent;
}

async function refreshKey() {
  if (!deviceToken() || !deps.engine.state.online) return;
  try {
    const response = await serverFetch('/api/sync/mesh/key');
    const json = await response.json();
    if (json && json.meshKey && json.meshKey !== state.meshKey) {
      state.meshKey = json.meshKey;
      await deps.store.setKv('mesh_key', state.meshKey);
      syncHotspot();
    }
  } catch (e) { /* أوفلاين */ }
}

// ===== تشغيل =====
async function startNode() {
  if (node || !state.meshKey) {
    if (!state.meshKey) state.message = 'لازم البرنامج يتصل بالسيرفر مرة (فيه نت) عشان ياخد مفتاح الشبكة';
    return;
  }
  const transport = new LanTransport({ alwaysConnect: true, extraTargets: () => hotspot.clientIps() });
  node = new MeshNode(transport, host, { nodeId: state.nodeId, log, maxDirect: 12 });
  node.on('change', dirty);
  try {
    await node.start();
    state.running = true;
    state.message = '';
    syncHotspot();
  } catch (error) {
    node = null;
    state.running = false;
    state.message = `الشبكة مش راضية تشتغل: ${error.message}`;
  }
}

async function stopNode() {
  if (!node) return;
  const n = node;
  node = null;
  syncHotspot();
  await n.stop().catch(() => {});
  state.running = false;
}

async function init(dependencies) {
  deps = dependencies;
  await deps.ensureSyncSchema(deps.sequelize).catch(() => {});
  state.nodeId = await deps.store.getKv('mesh_node', null);
  if (!state.nodeId) {
    state.nodeId = `pc${crypto.randomBytes(6).toString('hex')}`;
    await deps.store.setKv('mesh_node', state.nodeId);
  }
  log = MeshLog.fromJSON(await deps.store.getKv('mesh_log', null));
  state.meshKey = (await deps.store.getKv('mesh_key', '')) || '';
  state.enabled = (await deps.store.getKv('mesh_enabled', false)) === true;
  state.hotspot = (await deps.store.getKv('mesh_hotspot', true)) !== false;
  state.firewall = (await deps.store.getKv('mesh_firewall', false)) === true;
  process.once('exit', () => hotspot.stop());
  state.ready = true;
  let lastPull = deps.engine.state.lastPullAt;
  deps.engine.onChange(() => {
    if (deps.engine.state.lastPullAt !== lastPull) {
      lastPull = deps.engine.state.lastPullAt;
      snapshotCache = null;
      reapplyPending().catch(() => {});
    }
  });
  const loop = setInterval(async () => {
    await refreshKey();
    if (state.enabled && !node && state.meshKey) await startNode();
    await publishOwnReceipts().catch(() => {});
    await uploadForOthers().catch(() => {});
  }, 20 * 1000);
  if (loop.unref) loop.unref();
  await refreshKey();
  if (state.enabled) await startNode();
}

// ===== للشاشة (برنامج الديسكتوب) =====
function view() {
  const st = statuses();
  const peers = node ? node.visiblePeers().map(p => ({ ...p, online: node.isOnline(p) })) : [];
  const review = log.ofKind('op')
    .filter(e => (st.get(String(e.d.id)) || {}).state === OpState.review)
    .map((e) => {
      const s = st.get(String(e.d.id));
      return { id: e.d.id, label: e.d.label, user: e.d.user, money: require('./core').opMoney(e), firstUser: s.firstBy && s.firstBy.d.user, firstMoney: s.firstBy ? require('./core').opMoney(s.firstBy) : 0, message: s.message };
    });
  let waiting = 0;
  for (const s of st.values()) if (s.state === OpState.pending) waiting++;
  return {
    ...state,
    me: { node: state.nodeId, name: host.displayName },
    direct: node ? node.directCount : 0,
    peers,
    uploader: uploaderNode(),
    isUploader: uploaderNode() === state.nodeId,
    review,
    waiting,
    problem: node ? node.lastProblem : '',
    online: deps ? deps.engine.state.online : false,
    wifi: hotspot.view(),
  };
}

async function action(name, body = {}) {
  if (!state.ready) return { success: false, message: 'لسه بيجهز' };
  switch (name) {
    case 'enable':
      state.enabled = true;
      await deps.store.setKv('mesh_enabled', true);
      await refreshKey();
      await startNode();
      return { success: Boolean(node), message: state.message };
    case 'disable':
      state.enabled = false;
      await deps.store.setKv('mesh_enabled', false);
      await stopNode();
      return { success: true };
    case 'reconnect':
      if (!node) await startNode();
      else await node.reconnect();
      return { success: true };
    case 'hotspot':
      state.hotspot = body.on === 'true' || body.on === true;
      await deps.store.setKv('mesh_hotspot', state.hotspot);
      syncHotspot();
      return { success: true };
    case 'firewall': {
      const r = await allowInFirewall(process.execPath);
      if (r.success) {
        state.firewall = true;
        await deps.store.setKv('mesh_firewall', true);
      }
      return r;
    }
    case 'take-all':
      return { success: Boolean(node && node.requestSnapshot()) };
    case 'uploader':
      publish('cfg', { uploader: body.node || null, by: host.displayName });
      return { success: true };
    case 'decide':
      if (!['upload', 'dismiss'].includes(body.action)) return { success: false };
      publish('dec', { op: String(body.op), action: body.action, by: host.displayName });
      return { success: true };
    case 'upload-now':
      return { success: true, sent: await uploadForOthers({ force: true }) };
    default:
      return { success: false };
  }
}

module.exports = { init, recordDesktopOp, view, action, state };
