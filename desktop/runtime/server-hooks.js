// الجزء اللي بيتركب جوه server.js على برنامج الديسكتوب بس (DESKTOP_MODE=1):
//   earlyMiddleware  (قبل قراءة الفورمز): أوامر التحكم من شريط البرنامج + قراءة الطلبات اللي محتاجة إنترنت زي ما هي
//   sessionMiddleware (بعد الجلسة): تسجيل كل عملية بتكتب في قاعدة البيانات في طابور الرفع،
//                     وتحويل العمليات اللي محتاجة إنترنت للسيرفر مباشرة (أو رسالة لو مفيش نت)
const crypto = require('crypto');
const syncContext = require('../../utils/sync/context');
const { judgeOutcome } = require('../../utils/sync/outcome');
const store = require('./store');
const engine = require('./engine');

const CAPTURE_LIMIT = 64 * 1024;

// العمليات اللي مينفعش تتعمل أوفلاين: إضافة طلاب (عشان الـ ids/الأكواد متتداخلش)، رفع ملفات وصور،
// الكول سنتر، النسخ الاحتياطي، مسح/استيراد قاعدة البيانات، وحاجات بتتخزن على السيرفر بس.
const ONLINE_ONLY_ANY_METHOD = [
  /^\/admin\/backups(\/|$)/,
  /^\/admin\/deleted-students(\/|$)/,
  /^\/admin\/sync-devices(\/|$)/,
  /^\/admin\/recharge-codes(\/|$)/,
  /^\/settings\/(export-database|import-database|clear-)/,
  /^\/api\/(portal|public|internal)\//,
];
const ONLINE_ONLY_WRITE = [
  /^\/students\/?$/,
  /^\/students\/quick-add(\/|$)/,
  /^\/students\/bulk-upload(\/|$)/,
  /^\/settings(\/|$)/,
  /^\/users(\/|$)/,
  /^\/user\/profile-photo(\/|$)/,
  /^\/admin\/videos(\/|$)/,
  /^\/admin\/ads(\/|$)/,
  /^\/admin\/video-broadcasts(\/|$)/,
  /^\/admin\/popup-questions(\/|$)/,
  /^\/follow-up-dashboard\/send-to-callcenter(\/|$)/,
  /^\/sessions\/[^/]+\/report\/send-(present|absent)(\/|$)/,
];
const SECRET_KEYS = /pass|token|secret/i;

function isOnlineOnly(req) {
  const path = req.path;
  if (ONLINE_ONLY_ANY_METHOD.some(rule => rule.test(path))) return true;
  const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (!isWrite) return false;
  if (/multipart\/form-data/i.test(req.get('content-type') || '')) return true;
  return ONLINE_ONLY_WRITE.some(rule => rule.test(path));
}

function wantsJson(req) {
  return req.xhr || /json/i.test(req.get('accept') || '') || /json/i.test(req.get('content-type') || '')
    || req.path.startsWith('/api/') || req.path.startsWith('/attendance/scan') || req.path.startsWith('/homework/scan')
    || req.path.startsWith('/door/scan');
}

function needsInternetResponse(req, res) {
  const message = 'العملية دي محتاجة إنترنت (زي إضافة طالب جديد أو رفع صور). اتأكد إن النت شغال وجرب تاني.';
  if (wantsJson(req)) return res.status(503).json({ success: false, offline: true, message });
  res.status(503).send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>محتاج إنترنت</title>
<style>body{font-family:Cairo,Tahoma,sans-serif;background:#F4F5FC;color:#181527;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{background:#fff;border-radius:16px;box-shadow:0 10px 28px rgba(30,27,75,.12);padding:32px 40px;max-width:520px;text-align:center}
h1{font-size:22px;margin:0 0 12px}p{color:#6B7280;line-height:1.8;margin:0 0 20px}
a,button{background:#4338CA;color:#fff;border:0;border-radius:11px;padding:10px 22px;font-size:15px;text-decoration:none;cursor:pointer;font-family:inherit}</style></head>
<body><div class="box"><h1>📡 مفيش اتصال بالإنترنت</h1><p>${message}</p><button onclick="history.back()">رجوع</button></div></body></html>`);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function controlAuthorized(req) {
  const secret = process.env.DESKTOP_CONTROL_SECRET || '';
  const given = req.get('x-desktop-control') || '';
  return secret && given.length === secret.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));
}

async function handleControl(req, res) {
  if (!controlAuthorized(req)) return res.status(403).json({ success: false });
  const path = req.path.replace(/^\/__desktop/, '');
  try {
    if (req.method === 'GET' && path === '/status') return res.json(await engine.status());
    if (req.method === 'POST' && path === '/pull') {
      const full = req.query.full === '1';
      const result = await engine.pull({ full });
      return res.json({ success: !result.skipped, ...result });
    }
    if (req.method === 'POST' && path === '/push') return res.json({ success: true, ...(await engine.push({ force: true })) });
    if (req.method === 'GET' && path === '/problems') return res.json({ success: true, problems: await store.listProblems() });
    const dismiss = /^\/problems\/(\d+)\/dismiss$/.exec(path);
    if (req.method === 'POST' && dismiss) {
      await store.markOp(Number(dismiss[1]), { dismissed: 1 });
      return res.json({ success: true });
    }
    const retry = /^\/problems\/(\d+)\/retry$/.exec(path);
    if (req.method === 'POST' && retry) {
      // نفس العملية برقم جديد (الرقم القديم السيرفر سجّل إنه رفضه) في آخر الطابور
      const [[op]] = await store.meta().query("SELECT * FROM outbox WHERE seq = ? AND state = 'failed'", [Number(retry[1])]);
      if (!op) return res.status(404).json({ success: false });
      await store.meta().query(
        `INSERT INTO outbox (op_id, state, method, url, payload, summary, user_name, client_time, local_ok, local_created, local_tables, created_at)
         VALUES (?, 'ready', ?, ?, ?, ?, ?, ?, 1, '[]', ?, ?)`,
        [crypto.randomUUID(), op.method, op.url, op.payload, op.summary, op.user_name, op.client_time, op.local_tables, store.mysqlNow()],
      );
      await store.markOp(op.seq, { dismissed: 1 });
      engine.schedulePush(0);
      return res.json({ success: true });
    }
    res.status(404).json({ success: false });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

async function earlyMiddleware(req, res, next) {
  if (req.path.startsWith('/__desktop/')) return handleControl(req, res);
  if (isOnlineOnly(req)) {
    req.desktopOnlineOnly = true;
    if (!['GET', 'HEAD'].includes(req.method)) {
      try {
        req.desktopRawBody = await readRawBody(req);
      } catch (error) {
        return next(error);
      }
    }
  }
  next();
}

function sessionContext(req) {
  const s = req.session || {};
  return {
    userId: s.userId,
    userName: s.userName,
    userRole: s.userRole,
    activeSessionId: s.activeSessionId,
    closingUnlocked: s.closingUnlocked,
  };
}

const PASS_THROUGH_HEADERS = ['content-type', 'location', 'content-disposition', 'cache-control'];

async function proxyToServer(req, res) {
  // العمليات اللي قبلها في الطابور لازم تترفع الأول (الترتيب مهم)
  await engine.push();
  if ((await store.countByState()).pending) return needsInternetResponse(req, res);

  const headers = {
    'x-sync-context': Buffer.from(JSON.stringify({ ...sessionContext(req), clientTime: engine.correctedNow() }), 'utf8').toString('base64'),
    'x-sync-device-token': process.env.SYNC_DEVICE_TOKEN || '',
    accept: req.get('accept') || '*/*',
  };
  if (req.get('content-type')) headers['content-type'] = req.get('content-type');
  if (req.get('x-requested-with')) headers['x-requested-with'] = req.get('x-requested-with');

  let response;
  try {
    response = await fetch(`${String(process.env.SYNC_SERVER_URL).replace(/\/+$/, '')}${req.originalUrl}`, {
      method: req.method,
      headers,
      body: req.desktopRawBody && req.desktopRawBody.length ? req.desktopRawBody : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(5 * 60 * 1000),
    });
  } catch (error) {
    engine.ping();
    return needsInternetResponse(req, res);
  }
  const body = Buffer.from(await response.arrayBuffer());
  const isWrite = !['GET', 'HEAD'].includes(req.method);
  if (isWrite) {
    // نجيب نتيجة العملية دي على الجهاز قبل ما نعرض الرد (مثلاً الطالب الجديد لازم يبقى موجود)
    await engine.pull().catch(() => {});
  }
  res.status(response.status);
  for (const name of PASS_THROUGH_HEADERS) {
    const value = response.headers.get(name);
    if (value) res.setHeader(name, name === 'location' ? value.replace(/^https?:\/\/[^/]+/i, '') : value);
  }
  res.end(body);
}

function summarize(req) {
  const parts = [`${req.method} ${req.path}`];
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const fields = Object.entries(body)
    .filter(([key, value]) => !SECRET_KEYS.test(key) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'))
    .slice(0, 8)
    .map(([key, value]) => `${key}=${String(value).slice(0, 60)}`);
  if (fields.length) parts.push(fields.join('، '));
  return parts.join(' — ').slice(0, 1000);
}

function teeResponse(res) {
  const chunks = [];
  let size = 0;
  const originalWrite = res.write;
  const originalEnd = res.end;
  const collect = (chunk, encoding) => {
    if (!chunk || typeof chunk === 'function' || size >= CAPTURE_LIMIT) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
    chunks.push(buffer.subarray(0, CAPTURE_LIMIT - size));
    size += buffer.length;
  };
  res.write = function write(chunk, encoding, ...rest) {
    collect(chunk, encoding);
    return originalWrite.call(res, chunk, encoding, ...rest);
  };
  res.end = function end(chunk, encoding, ...rest) {
    collect(chunk, encoding);
    return originalEnd.call(res, chunk, encoding, ...rest);
  };
  return () => Buffer.concat(chunks).toString('utf8');
}

async function sessionMiddleware(req, res, next) {
  // لو الحصة الشغالة اتعملت أوفلاين واترفعت، نحولها للـ id الحقيقي اللي السيرفر إداه
  if (req.session && store.isLocalId(req.session.activeSessionId)) {
    const mapped = store.mapLocalId(req.session.activeSessionId);
    if (mapped !== undefined) req.session.activeSessionId = mapped;
  }

  if (req.desktopOnlineOnly) {
    if (!req.session || !req.session.userId) return res.redirect('/login');
    if (!engine.state.online && !(await engine.ping())) return needsInternetResponse(req, res);
    try {
      return await proxyToServer(req, res);
    } catch (error) {
      return next(error);
    }
  }

  if (!req.session || !req.session.userId) return next();

  const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  await engine.waitForGate();

  const opId = crypto.randomUUID();
  const ctx = syncContext.newContext({ desktop: true });
  const op = {
    opId,
    method: req.method,
    url: req.originalUrl,
    clientTime: engine.correctedNow(),
    userName: req.session.userName || null,
    summary: summarize(req),
    payload: {
      body: req.body || {},
      headers: { accept: req.get('accept') || '', 'x-requested-with': req.get('x-requested-with') || '' },
      context: sessionContext(req),
    },
  };

  if (isWrite) {
    // بنسجل العملية في الطابور قبل ما تتنفذ، عشان لو البرنامج وقع في النص متضيعش
    try {
      await store.insertOp({ ...op, state: 'started' });
    } catch (error) {
      console.error('Desktop outbox insert failed:', error);
      return res.status(500).send('❌ مش قادر أسجل العملية على الجهاز، جرب تاني');
    }
    engine.opStarted(opId);
  }

  const readBody = teeResponse(res);
  res.on('finish', async () => {
    try {
      if (!ctx.wrote) {
        if (isWrite) await store.deleteOp(opId);
        return;
      }
      const outcome = judgeOutcome(res.statusCode, String(res.getHeader('content-type') || ''), readBody());
      const result = { ok: outcome.ok, message: outcome.message, created: ctx.created, tables: [...ctx.tables] };
      if (!isWrite) await store.insertOp({ ...op, state: 'started' });
      await store.finishLocalOp(opId, result);
    } catch (error) {
      console.error('Desktop outbox finish failed:', error);
    } finally {
      if (isWrite) engine.opFinished(opId, ctx.wrote);
      else if (ctx.wrote) engine.opFinished(opId, true);
    }
  });

  syncContext.run(ctx, next);
}

module.exports = { earlyMiddleware, sessionMiddleware, isOnlineOnly };
