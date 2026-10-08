// جزء المزامنة على السيرفر الأونلاين (برنامج الديسكتوب بيكلمه):
//   POST /api/sync/register-device  تسجيل جهاز جديد بيوزر وباسورد أدمن
//   GET  /api/sync/ping             اختبار الاتصال + وقت السيرفر
//   POST /api/sync/pull             تنزيل التغييرات (أو نسخة كاملة)
//   POST /api/sync/ids              قايمة الـ ids في جداول معينة (لاكتشاف الصفوف المحذوفة)
// وكمان middleware بيخلي الجهاز ينفذ أي عملية باسم اليوزر اللي عملها على الجهاز (X-Sync-Device-Token)،
// وكل عملية ليها رقم مميز (X-Sync-Op-Id) بيتسجل في sync_applied_ops عشان مستحيل تتنفذ مرتين.
//
// الجداول الجديدة بتتعمل بـ CREATE TABLE IF NOT EXISTS بس — مفيش أي تعديل على جداول موجودة.
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const syncContext = require('./context');
const { judgeOutcome } = require('./outcome');

// جداول مش بتنزل على الأجهزة
const EXCLUDED_TABLES = new Set(['sync_devices', 'sync_applied_ops', 'deleted_student_archive', 'mobile_app_users']);
const RESPONSE_CAPTURE_LIMIT = 256 * 1024;
const STUCK_OP_MS = 10 * 60 * 1000;

let pool = null;
let schemaPromise = null;
const deviceCache = new Map();

function getPool(sequelize) {
  if (!pool) {
    const c = sequelize.config;
    pool = mysql.createPool({
      host: c.host,
      port: c.port,
      user: c.username,
      password: c.password,
      database: c.database,
      connectionLimit: 2,
      maxIdle: 0,
      idleTimeout: 60000,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      timezone: 'Z',
      charset: 'utf8mb4',
      connectTimeout: 20000,
    });
  }
  return pool;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function quoteId(name) {
  return '`' + String(name).replace(/`/g, '``') + '`';
}

function utcNowString(date = new Date()) {
  return date.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
}

function ensureSyncSchema(sequelize) {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await sequelize.query(`CREATE TABLE IF NOT EXISTS sync_devices (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        token_hash CHAR(64) NOT NULL UNIQUE,
        registered_by INT NULL,
        app_version VARCHAR(50) NULL,
        last_seen_at DATETIME NULL,
        revoked_at DATETIME NULL,
        createdAt DATETIME NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      await sequelize.query(`CREATE TABLE IF NOT EXISTS sync_applied_ops (
        op_id VARCHAR(64) NOT NULL PRIMARY KEY,
        device_id INT NOT NULL,
        status VARCHAR(20) NOT NULL,
        http_status INT NULL,
        ok TINYINT(1) NULL,
        method VARCHAR(10) NULL,
        path VARCHAR(500) NULL,
        user_id INT NULL,
        client_time DATETIME NULL,
        result_json MEDIUMTEXT NULL,
        createdAt DATETIME NOT NULL,
        finishedAt DATETIME NULL,
        KEY idx_sync_ops_device (device_id, createdAt)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

async function authenticateDevice(sequelize, token) {
  if (!token) return null;
  const key = hashToken(token);
  const cached = deviceCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.device;
  const [rows] = await getPool(sequelize).query(
    'SELECT id, name, revoked_at FROM sync_devices WHERE token_hash = ? LIMIT 1', [key],
  );
  const device = rows[0] && !rows[0].revoked_at ? { id: rows[0].id, name: rows[0].name } : null;
  deviceCache.set(key, { device, expiresAt: Date.now() + 60 * 1000 });
  if (device) {
    getPool(sequelize).query('UPDATE sync_devices SET last_seen_at = ? WHERE id = ?', [utcNowString(), device.id]).catch(() => {});
  }
  return device;
}

function requireDevice(sequelize) {
  return async (req, res, next) => {
    try {
      const device = await authenticateDevice(sequelize, req.get('x-sync-device-token'));
      if (!device) return res.status(401).json({ success: false, code: 'DEVICE_NOT_AUTHORIZED', message: 'الجهاز ده مش متسجل أو اتلغى تسجيله' });
      req.syncDevice = device;
      next();
    } catch (error) {
      console.error('Sync device auth error:', error.message);
      res.status(503).json({ success: false, message: 'السيرفر مش قادر يوصل لقاعدة البيانات دلوقتي' });
    }
  };
}

// ===== التنزيل =====

async function listSyncTables(db) {
  const [rows] = await db.query("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'");
  return rows.map(row => Object.values(row)[0]).filter(name => !EXCLUDED_TABLES.has(name)).sort();
}

async function describeTable(db, table) {
  const [columns] = await db.query(`SHOW COLUMNS FROM ${quoteId(table)}`);
  const names = columns.map(c => c.Field);
  const primary = columns.filter(c => c.Key === 'PRI').map(c => c.Field);
  const idColumn = primary.length === 1 && primary[0] === 'id' && /int/i.test(columns.find(c => c.Field === 'id').Type) ? 'id' : null;
  const [[createRow]] = await db.query(`SHOW CREATE TABLE ${quoteId(table)}`);
  const ddl = String(createRow['Create Table']).replace(/\s+AUTO_INCREMENT=\d+/i, '');
  return {
    columns: names,
    idColumn,
    hasUpdatedAt: names.includes('updatedAt'),
    autoIncrement: columns.some(c => /auto_increment/i.test(c.Extra || '')),
    ddl,
    ddlHash: crypto.createHash('sha256').update(ddl).digest('hex').slice(0, 16),
  };
}

async function tableFingerprint(db, table, info) {
  if (info.idColumn && info.hasUpdatedAt) {
    const [[row]] = await db.query(`SELECT COUNT(*) AS c, COALESCE(SUM(id), 0) AS s, MAX(updatedAt) AS m FROM ${quoteId(table)}`);
    return `${row.c}|${row.s}|${row.m || ''}`;
  }
  const [[row]] = await db.query(`CHECKSUM TABLE ${quoteId(table)}`);
  return `checksum|${row.Checksum}`;
}

function encodeRows(rows) {
  return rows.map(row => row.map(value => (Buffer.isBuffer(value) ? { $b64: value.toString('base64') } : value)));
}

async function handlePull(sequelize, req, res) {
  const db = getPool(sequelize);
  const body = req.body || {};
  const full = Boolean(body.full);
  const clientTables = body.tables || {};
  const forceFull = new Set(Array.isArray(body.fullTables) ? body.fullTables : []);
  // نرجع 10 دقايق ورا عشان أي عملية كانت لسه شغالة وقت آخر تنزيل متتنسيش (التكرار مش بيضر)
  const since = !full && body.since ? new Date(new Date(`${body.since}Z`).getTime() - 10 * 60 * 1000) : null;
  const serverTime = utcNowString();
  const out = { serverTime, tables: {} };

  for (const table of await listSyncTables(db)) {
    const info = await describeTable(db, table);
    const fingerprint = await tableFingerprint(db, table, info);
    const known = clientTables[table] || {};
    const entry = {
      ddlHash: info.ddlHash,
      fingerprint,
      idColumn: info.idColumn,
      autoIncrement: info.autoIncrement,
      columns: info.columns,
    };
    const ddlChanged = known.ddlHash !== info.ddlHash;
    const tableFull = full || forceFull.has(table);
    if (ddlChanged) entry.ddl = info.ddl;

    if (!tableFull && !ddlChanged && known.fingerprint === fingerprint) {
      entry.mode = 'skip';
    } else if (!tableFull && !ddlChanged && since && info.idColumn && info.hasUpdatedAt) {
      entry.mode = 'delta';
      const [rows] = await db.query({
        sql: `SELECT * FROM ${quoteId(table)} WHERE updatedAt >= ?`,
        values: [utcNowString(since)],
        rowsAsArray: true,
      });
      entry.rows = encodeRows(rows);
    } else {
      entry.mode = 'full';
      const [rows] = await db.query({ sql: `SELECT * FROM ${quoteId(table)}`, rowsAsArray: true });
      entry.rows = encodeRows(rows);
    }
    out.tables[table] = entry;
  }
  res.json(out);
}

async function handleIds(sequelize, req, res) {
  const db = getPool(sequelize);
  const allowed = new Set(await listSyncTables(db));
  const out = {};
  for (const table of (req.body && req.body.tables) || []) {
    if (!allowed.has(table)) continue;
    const [rows] = await db.query({ sql: `SELECT id FROM ${quoteId(table)} ORDER BY id`, rowsAsArray: true });
    out[table] = rows.map(row => Number(row[0]));
  }
  res.json({ tables: out });
}

// ===== تنفيذ العمليات اللي جاية من الأجهزة =====

function decodeContextHeader(value) {
  if (!value) return {};
  try {
    return JSON.parse(Buffer.from(String(value), 'base64').toString('utf8')) || {};
  } catch (e) {
    return null;
  }
}

async function claimOp(db, opId, device, req, user, clientTime) {
  try {
    await db.query(
      'INSERT INTO sync_applied_ops (op_id, device_id, status, method, path, user_id, client_time, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [opId, device.id, 'processing', req.method, req.originalUrl.slice(0, 500), user.id, clientTime ? utcNowString(new Date(clientTime)) : null, utcNowString()],
    );
    return { claimed: true };
  } catch (error) {
    if (error.code !== 'ER_DUP_ENTRY') throw error;
    const [rows] = await db.query('SELECT status, result_json, createdAt FROM sync_applied_ops WHERE op_id = ?', [opId]);
    return { claimed: false, existing: rows[0] };
  }
}

// بنمسك رد الصفحة كله بدل ما يتبعت، وبنرجع للجهاز "ظرف" JSON فيه النتيجة + الصفوف الجديدة اللي اتعملت
function captureResponse(res, onDone) {
  const chunks = [];
  let size = 0;
  const originalEnd = res.end;
  const originalWrite = res.write;
  const originalWriteHead = res.writeHead;
  const collect = (chunk, encoding) => {
    if (!chunk || typeof chunk === 'function') return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
    if (size < RESPONSE_CAPTURE_LIMIT) chunks.push(buffer.subarray(0, RESPONSE_CAPTURE_LIMIT - size));
    size += buffer.length;
  };
  res.writeHead = function writeHead(status, ...rest) {
    res.statusCode = status;
    const headers = rest.find(item => item && typeof item === 'object');
    if (headers) for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
    return res;
  };
  res.write = function write(chunk, encoding, callback) {
    collect(chunk, encoding);
    const cb = typeof encoding === 'function' ? encoding : callback;
    if (typeof cb === 'function') process.nextTick(cb);
    return true;
  };
  res.end = function end(chunk, encoding, callback) {
    collect(chunk, encoding);
    const result = {
      status: res.statusCode,
      location: res.getHeader('location') || null,
      contentType: String(res.getHeader('content-type') || ''),
      body: Buffer.concat(chunks).toString('utf8'),
    };
    Promise.resolve(onDone(result)).catch(() => {}).then((envelope) => {
      // نرجع الدوال الأصلية قبل ما نبعت الظرف (Node بينادي writeHead جوه end)
      res.writeHead = originalWriteHead;
      res.write = originalWrite;
      for (const header of ['location', 'content-type', 'content-length', 'content-disposition', 'etag']) res.removeHeader(header);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      originalEnd.call(res, JSON.stringify(envelope || { envelope: true, error: 'no result' }), 'utf8', typeof callback === 'function' ? callback : undefined);
    });
    return res;
  };
}

function deviceRequestMiddleware({ sequelize, User }) {
  return async (req, res, next) => {
    const token = req.get('x-sync-device-token');
    if (!token || req.path.startsWith('/api/sync/')) return next();

    const db = getPool(sequelize);
    let device;
    try {
      device = await authenticateDevice(sequelize, token);
    } catch (error) {
      return res.status(503).json({ success: false, message: 'السيرفر مش قادر يوصل لقاعدة البيانات دلوقتي' });
    }
    if (!device) return res.status(401).json({ success: false, code: 'DEVICE_NOT_AUTHORIZED', message: 'الجهاز ده مش متسجل أو اتلغى تسجيله' });

    const context = decodeContextHeader(req.get('x-sync-context'));
    if (!context || !context.userId) return res.status(400).json({ success: false, message: 'بيانات العملية ناقصة' });
    const user = await User.findByPk(context.userId, { attributes: ['id', 'name', 'role'] });
    if (!user) return res.status(403).json({ success: false, code: 'USER_GONE', message: 'اليوزر اللي عمل العملية مبقاش موجود' });

    // جلسة مؤقتة للطلب ده بس، بنفس بيانات اليوزر على الجهاز، وبتتمسح بعد ما الطلب يخلص
    req.session.userId = user.id;
    req.session.userName = user.name;
    req.session.userRole = user.role;
    if (context.activeSessionId !== undefined && context.activeSessionId !== null) req.session.activeSessionId = context.activeSessionId;
    if (context.closingUnlocked) req.session.closingUnlocked = context.closingUnlocked;
    res.on('finish', () => req.session.destroy(() => {}));

    const opId = req.get('x-sync-op-id');
    if (!opId) {
      // عملية "أونلاين بس" (زي إضافة طالب) الجهاز بيبعتها مباشرة وبيعرض الرد زي ما هو
      return syncContext.run(syncContext.newContext({ device }), next);
    }

    const clientTime = Number(context.clientTime) || null;
    let claim;
    try {
      claim = await claimOp(db, String(opId).slice(0, 64), device, req, user, clientTime);
    } catch (error) {
      console.error('Sync claim error:', error.message);
      return res.status(503).json({ success: false, message: 'السيرفر مش قادر يسجل العملية دلوقتي' });
    }
    if (!claim.claimed) {
      const existing = claim.existing || {};
      if (existing.status === 'done') {
        const stored = existing.result_json ? JSON.parse(existing.result_json) : {};
        return res.json({ ...stored, envelope: true, opId, duplicate: true });
      }
      const ageMs = Date.now() - new Date(`${existing.createdAt}Z`).getTime();
      return res.status(409).json({
        success: false,
        code: ageMs > STUCK_OP_MS ? 'OP_STUCK' : 'OP_IN_PROGRESS',
        message: ageMs > STUCK_OP_MS
          ? 'العملية دي بدأت على السيرفر قبل كده ومش معروف هل كملت ولا لأ — راجعها يدويًا'
          : 'العملية دي لسه بتتنفذ على السيرفر',
      });
    }

    const shiftMs = clientTime && clientTime < Date.now() - 60 * 1000 ? clientTime - Date.now() : 0;
    const ctx = syncContext.newContext({ device, shiftMs, opId });

    captureResponse(res, async (result) => {
      const outcome = judgeOutcome(result.status, result.contentType, result.body);
      const envelope = {
        envelope: true,
        opId,
        status: result.status,
        location: result.location,
        contentType: result.contentType,
        ok: outcome.ok,
        message: outcome.message,
        created: ctx.created,
        body: result.body.slice(0, 64 * 1024),
      };
      try {
        if (result.status >= 500) {
          // خطأ في السيرفر: نسيب العملية تتعاد تاني بدل ما نعتبرها اتنفذت
          await db.query('DELETE FROM sync_applied_ops WHERE op_id = ?', [opId]);
        } else {
          const stored = { ...envelope, body: envelope.body.slice(0, 8 * 1024) };
          await db.query(
            'UPDATE sync_applied_ops SET status = ?, http_status = ?, ok = ?, result_json = ?, finishedAt = ? WHERE op_id = ?',
            ['done', result.status, outcome.ok ? 1 : 0, JSON.stringify(stored), utcNowString(), opId],
          );
        }
      } catch (error) {
        console.error('Sync op bookkeeping error:', error.message);
      }
      return envelope;
    });

    syncContext.run(ctx, next);
  };
}

// ===== التركيب =====

function install(app, { sequelize, User, bcrypt, onMobileStaffLogin }) {
  syncContext.install(sequelize);

  app.post('/api/sync/register-device', async (req, res) => {
    try {
      await ensureSyncSchema(sequelize);
      const { username, password, device_name: deviceName, app_version: appVersion } = req.body || {};
      const user = username ? await User.findOne({ where: { username } }) : null;
      const valid = user && user.role === 'admin' && await bcrypt.compare(String(password || ''), user.password);
      if (!valid) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        return res.status(403).json({ success: false, message: 'لازم يوزر وباسورد أدمن صحيحين' });
      }
      const token = crypto.randomBytes(32).toString('hex');
      const name = String(deviceName || 'جهاز بدون اسم').slice(0, 255);
      await getPool(sequelize).query(
        'INSERT INTO sync_devices (name, token_hash, registered_by, app_version, createdAt) VALUES (?, ?, ?, ?, ?)',
        [name, hashToken(token), user.id, appVersion ? String(appVersion).slice(0, 50) : null, utcNowString()],
      );
      res.json({ success: true, token, deviceName: name, serverTime: utcNowString() });
    } catch (error) {
      console.error('Sync register error:', error);
      res.status(500).json({ success: false, message: 'حصلت مشكلة أثناء تسجيل الجهاز' });
    }
  });

  app.get('/api/sync/ping', requireDevice(sequelize), (req, res) => {
    if (req.get('x-app-version')) {
      getPool(sequelize).query('UPDATE sync_devices SET app_version = ? WHERE id = ?', [String(req.get('x-app-version')).slice(0, 50), req.syncDevice.id]).catch(() => {});
    }
    res.json({ success: true, serverTime: utcNowString(), serverNow: Date.now(), deviceName: req.syncDevice.name });
  });

  app.post('/api/sync/pull', requireDevice(sequelize), async (req, res) => {
    try {
      await handlePull(sequelize, req, res);
    } catch (error) {
      console.error('Sync pull error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.post('/api/sync/ids', requireDevice(sequelize), async (req, res) => {
    try {
      await handleIds(sequelize, req, res);
    } catch (error) {
      console.error('Sync ids error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  });

  installMobileRoutes(app, { sequelize, User, bcrypt, onMobileStaffLogin });

  app.use(deviceRequestMiddleware({ sequelize, User }));
}

// ===== تطبيق الموبايل (مسح الحضور/الواجب/الباب) =====
// الموبايل جهاز متسجل زي اللابتوب بالظبط، بس مش بينزل الداتابيز كلها:
//   POST /api/sync/mobile/staff-login  يتأكد من يوزر وباسورد الموظف ويرجع بياناته وصلاحياته
//   GET  /api/sync/mobile/snapshot     نسخة صغيرة للمسح أوفلاين: الحصص الأخيرة + الطلاب + حضورهم وواجبهم فيها
// والعمليات نفسها بتتبعت لنفس صفحات السيستم بـ X-Sync-Device-Token (نفس طريقة الديسكتوب).
const MOBILE_SNAPSHOT_SESSIONS = 150;

function installMobileRoutes(app, { sequelize, User, bcrypt, onMobileStaffLogin }) {
  app.post('/api/sync/mobile/staff-login', requireDevice(sequelize), async (req, res) => {
    try {
      const { username, password } = req.body || {};
      const user = username ? await User.findOne({ where: { username: String(username).trim() } }) : null;
      const valid = user && await bcrypt.compare(String(password || ''), user.password);
      if (!valid) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        return res.status(401).json({ success: false, message: 'اليوزرنيم أو الباسورد غلط' });
      }
      let permissions = [];
      try { permissions = JSON.parse(user.permissions || '[]') || []; } catch (e) { permissions = []; }
      if (typeof onMobileStaffLogin === 'function') {
        try { onMobileStaffLogin(user, req); } catch (e) { /* التسجيل مينفعش يوقف الدخول */ }
      }
      res.json({ success: true, user: { id: user.id, name: user.name, role: user.role, permissions } });
    } catch (error) {
      console.error('Mobile staff login error:', error);
      res.status(500).json({ success: false, message: 'حصلت مشكلة في السيرفر' });
    }
  });

  app.get('/api/sync/mobile/snapshot', requireDevice(sequelize), async (req, res) => {
    try {
      const db = getPool(sequelize);
      const [sessions] = await db.query(
        `SELECT id, lesson_number, week_number, serial_number, session_date, status, CenterId, SubjectId, createdAt
         FROM sessions ORDER BY createdAt DESC, id DESC LIMIT ?`, [MOBILE_SNAPSHOT_SESSIONS],
      );
      const sessionIds = sessions.map(s => s.id);
      const [[centers], [subjects], [students], [attendance], [homework]] = await Promise.all([
        db.query('SELECT id, name FROM centers ORDER BY name'),
        db.query('SELECT id, name FROM subjects ORDER BY name'),
        db.query({
          // أعمدة جديدة بتتضاف في الآخر بس (عشان الإصدارات القديمة من البرنامج تفضل شغالة)
          sql: `SELECT id, student_code, name, SubjectId, CenterId, balance, price_per_session, is_blocked, admin_note,
                phone, parent_phone, points
                FROM students ORDER BY name`,
          rowsAsArray: true,
        }),
        sessionIds.length
          ? db.query({ sql: 'SELECT StudentId, SessionId FROM attendances WHERE SessionId IN (?)', values: [sessionIds], rowsAsArray: true })
          : [[]],
        sessionIds.length
          ? db.query({ sql: 'SELECT StudentId, SessionId, status FROM homeworkchecks WHERE SessionId IN (?)', values: [sessionIds], rowsAsArray: true })
          : [[]],
      ]);
      res.json({
        success: true,
        serverTime: utcNowString(),
        centers,
        subjects,
        sessions,
        studentColumns: ['id', 'code', 'name', 'subjectId', 'centerId', 'balance', 'price', 'blocked', 'note', 'phone', 'parentPhone', 'points'],
        students,
        attendance,
        homework,
      });
    } catch (error) {
      console.error('Mobile snapshot error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  });
}

// صفحة الأدمن: الأجهزة المتسجلة + إلغاء تسجيل جهاز
function installAdminRoutes(app, { sequelize, requireAdmin }) {
  app.get('/admin/sync-devices', requireAdmin, async (req, res) => {
    try {
      await ensureSyncSchema(sequelize);
      const db = getPool(sequelize);
      const [devices] = await db.query(`SELECT d.*, u.name AS registered_by_name,
          (SELECT COUNT(*) FROM sync_applied_ops o WHERE o.device_id = d.id) AS ops_count,
          (SELECT COUNT(*) FROM sync_applied_ops o WHERE o.device_id = d.id AND o.ok = 0) AS rejected_count
        FROM sync_devices d LEFT JOIN users u ON u.id = d.registered_by ORDER BY d.id DESC`);
      const [recentRejected] = await db.query(`SELECT o.*, d.name AS device_name, u.name AS user_name
        FROM sync_applied_ops o JOIN sync_devices d ON d.id = o.device_id LEFT JOIN users u ON u.id = o.user_id
        WHERE o.ok = 0 OR o.status <> 'done' ORDER BY o.createdAt DESC LIMIT 100`);
      for (const op of recentRejected) {
        try { op.result = op.result_json ? JSON.parse(op.result_json) : null; } catch (e) { op.result = null; }
      }
      res.render('sync-devices', { devices, recentRejected, message: req.query.message || null });
    } catch (error) {
      console.error(error);
      res.status(500).send('❌ ' + error.message);
    }
  });

  app.post('/admin/sync-devices/:id/revoke', requireAdmin, async (req, res) => {
    await ensureSyncSchema(sequelize);
    await getPool(sequelize).query('UPDATE sync_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [utcNowString(), req.params.id]);
    deviceCache.clear();
    res.redirect('/admin/sync-devices?message=' + encodeURIComponent('تم إلغاء تسجيل الجهاز'));
  });
}

module.exports = { install, installAdminRoutes, ensureSyncSchema, EXCLUDED_TABLES };
