// شبكة الأجهزة أوفلاين (الموبايلات + برنامج الديسكتوب بيتبادلوا العمليات من غير نت):
//   GET  /api/sync/mesh/key    مفتاح الشبكة: أي جهاز متسجل بياخده، ومن غيره ميقدرش يدخل الشبكة
//   POST /api/sync/mesh/relay  جهاز "الرافع" بيرفع عمليات أجهزة تانية
// كل عملية متوقعة من الجهاز اللي عملها (HMAC بمفتاح مشتق من توكن الجهاز — السيرفر عنده نفس المفتاح: token_hash)،
// فالجهاز اللي بيرفع مايقدرش يغير أو يألف عملية. السيرفر بيتأكد من التوقيع وبعدين بيشغل العملية
// بنفس الطريقة اللي الجهاز كان هيرفعها بيها بنفسه (X-Sync-Op-Id) — فمستحيل تتسجل مرتين.
// مفيش جداول جديدة ولا تعديل على جداول موجودة.
const crypto = require('crypto');
const http = require('http');
const https = require('https');

// الصفحات اللي ينفع تترفع عن طريق جهاز تاني (المسح بس)
const RELAY_PATHS = new Set(['/attendance/scan', '/homework/scan/save']);
const MAX_RELAY_OPS = 200;
const RELAY_SECRET = crypto.randomBytes(32).toString('hex'); // جوه السيرفر بس، بيتغير مع كل تشغيل

let refCache = { at: 0, map: new Map() };

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function meshKey() {
  if (process.env.MESH_KEY) return process.env.MESH_KEY;
  const secret = process.env.SESSION_SECRET || process.env.JWT_SECRET || 'studyisfunny';
  return crypto.createHmac('sha256', secret).update('sif-mesh-v1').digest('hex');
}

// "ref" الجهاز = sha256(token_hash): رقم ثابت يعرّف الجهاز من غير ما يكشف أي سر
async function deviceByRef(db, ref) {
  if (Date.now() - refCache.at > 60 * 1000) {
    const [rows] = await db.query('SELECT id, name, token_hash FROM sync_devices WHERE revoked_at IS NULL');
    const map = new Map();
    for (const row of rows) map.set(sha256(row.token_hash), { id: row.id, name: row.name, tokenHash: row.token_hash });
    refCache = { at: Date.now(), map };
  }
  return refCache.map.get(String(ref || '')) || null;
}

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a || ''), 'hex');
  const y = Buffer.from(String(b || ''), 'hex');
  return x.length === 32 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

// p = نص JSON بالظبط زي ما الجهاز وقّعه: [id, path, body, userId, activeSessionId, clientTime]
function verifyOp(op, device) {
  if (!op || typeof op.p !== 'string' || !device) return null;
  const expected = crypto.createHmac('sha256', device.tokenHash).update(op.p).digest('hex');
  if (!safeEqualHex(expected, op.sig)) return null;
  let parts;
  try { parts = JSON.parse(op.p); } catch (e) { return null; }
  if (!Array.isArray(parts) || parts.length < 6) return null;
  const [id, path, body, userId, activeSessionId, clientTime] = parts;
  if (String(id) !== String(op.id) || !RELAY_PATHS.has(path) || !body || typeof body !== 'object') return null;
  if (!Number.isInteger(Number(userId))) return null;
  return { id: String(id).slice(0, 64), path, body, userId: Number(userId), activeSessionId: activeSessionId == null ? null : Number(activeSessionId), clientTime: Number(clientTime) || Date.now() };
}

// بنبعت العملية للسيرفر نفسه، فبتعدي على نفس الحماية والتسجيل بتوع أي عملية من جهاز
function replayLocally(op, device) {
  const port = Number(process.env.PORT) || 3000;
  const production = process.env.NODE_ENV === 'production';
  const lib = production ? http : https;
  const context = Buffer.from(JSON.stringify({ userId: op.userId, activeSessionId: op.activeSessionId, clientTime: op.clientTime })).toString('base64');
  const payload = JSON.stringify(op.body);
  return new Promise((resolve) => {
    const req = lib.request({
      host: '127.0.0.1',
      port,
      path: op.path,
      method: 'POST',
      rejectUnauthorized: false, // السيرفر المحلي (للتجربة) بشهادة self-signed
      timeout: 60 * 1000,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        accept: 'application/json',
        'x-sync-relay-secret': RELAY_SECRET,
        'x-sync-relay-device': String(device.id),
        'x-sync-context': context,
        'x-sync-op-id': op.id,
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(data); } catch (e) { json = {}; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ status: 503, json: {} }));
    req.end(payload);
  });
}

function relayResult(id, { status, json }) {
  if (status >= 500 || status === 409) {
    if (json.code === 'OP_STUCK') return { id, ok: false, message: json.message || 'العملية اتعلقت على السيرفر' };
    return { id, retry: true, message: json.message || 'السيرفر مشغول — هتترفع تاني' };
  }
  if (json.envelope) {
    let inner = {};
    try { inner = JSON.parse(json.body || '{}') || {}; } catch (e) { inner = {}; }
    return { id, ok: json.ok === true, duplicate: json.duplicate === true, message: inner.message || json.message || (json.ok ? 'تم' : 'السيرفر رفض العملية') };
  }
  return { id, ok: false, message: json.message || `السيرفر رد بخطأ (${status})` };
}

function install(app, { requireDevice, getPool, sequelize }) {
  app.get('/api/sync/mesh/key', requireDevice(sequelize), (req, res) => {
    res.json({ success: true, meshKey: meshKey() });
  });

  app.post('/api/sync/mesh/relay', requireDevice(sequelize), async (req, res) => {
    const ops = Array.isArray(req.body && req.body.ops) ? req.body.ops.slice(0, MAX_RELAY_OPS) : [];
    const db = getPool(sequelize);
    const checked = [];
    const results = [];
    for (const raw of ops) {
      const id = String((raw && raw.id) || '').slice(0, 64);
      let device = null;
      try {
        device = await deviceByRef(db, raw && raw.dev);
      } catch (error) {
        return res.status(503).json({ success: false, message: 'السيرفر مش قادر يوصل لقاعدة البيانات دلوقتي' });
      }
      const op = verifyOp(raw, device);
      if (!op) {
        results.push({ id, ok: false, invalid: true, message: device ? 'توقيع العملية مش سليم أو نوعها مش مسموح' : 'الجهاز اللي عمل العملية مش متسجل أو اتلغى تسجيله' });
        continue;
      }
      checked.push({ op, device });
    }
    // بالترتيب الزمني (عشان الرصيد يتحسب صح)
    checked.sort((a, b) => a.op.clientTime - b.op.clientTime || a.op.id.localeCompare(b.op.id));
    for (const { op, device } of checked) {
      results.push(relayResult(op.id, await replayLocally(op, device)));
    }
    res.json({ success: true, results });
  });
}

// بيستخدمه deviceRequestMiddleware: طلب جاي من الرافع جوه السيرفر نفسه
async function relayDevice(req, db) {
  const secret = req.get('x-sync-relay-secret');
  if (!secret || secret.length !== RELAY_SECRET.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(RELAY_SECRET))) return null;
  const id = Number(req.get('x-sync-relay-device'));
  if (!Number.isInteger(id)) return null;
  // برنامج الديسكتوب: عمليات الموبايلات اللي وصلت من الشبكة بتتنفذ على قاعدة البيانات اللي على الجهاز
  if (process.env.DESKTOP_MODE === '1' && id === 0) return { id: 0, name: 'شبكة الأجهزة', meshForeign: true };
  const [rows] = await db.query('SELECT id, name, revoked_at FROM sync_devices WHERE id = ? LIMIT 1', [id]);
  return rows[0] && !rows[0].revoked_at ? { id: rows[0].id, name: rows[0].name } : null;
}

module.exports = { install, relayDevice, replayLocally, meshKey, verifyOp, RELAY_PATHS };
