// عدد مستخدمي تطبيق الموبايل: بنسجل كل حساب (طالب / ولي أمر / موظف) أول وآخر مرة استخدم التطبيق.
// التطبيق بيتعرف من الـ User-Agent بتاعه (Dart — المتصفحات مبتبعتهوش أبدًا) أو من هيدر X-App-Client في النسخ الجديدة.
// الجدول بيتعمل بـ CREATE TABLE IF NOT EXISTS بس، والتسجيل مش بيأخر أي طلب (بيتعمل في الخلفية ومرة كل نص ساعة للحساب).
const jwt = require('jsonwebtoken');

const TABLE = 'mobile_app_users';
const THROTTLE_MS = 30 * 60 * 1000;
const MAX_CACHE = 20000;

let ensurePromise = null;
const lastRecorded = new Map(); // "type:id" -> وقت آخر تسجيل
const tokenCache = new Map();   // التوكن -> { type, id } عشان منفكش نفس التوكن كل طلب

function ensureAppUsageSchema(sequelize) {
  if (!ensurePromise) {
    ensurePromise = sequelize.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
      account_type VARCHAR(10) NOT NULL,
      account_id INT NOT NULL,
      app_version VARCHAR(30) NULL,
      first_seen_at DATETIME NOT NULL,
      last_seen_at DATETIME NOT NULL,
      PRIMARY KEY (account_type, account_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch((error) => {
      ensurePromise = null;
      throw error;
    });
  }
  return ensurePromise;
}

function isMobileAppRequest(req) {
  const ua = String(req.headers['user-agent'] || '');
  return /^Dart\//.test(ua) || Boolean(req.headers['x-app-client']);
}

function appVersionOf(req) {
  const match = /(\d+\.\d+\.\d+)/.exec(String(req.headers['x-app-client'] || ''));
  return match ? match[1] : null;
}

function remember(map, key, value) {
  if (map.size > MAX_CACHE) map.clear();
  map.set(key, value);
}

function recordAppUser(sequelize, type, id, version) {
  const accountId = Number.parseInt(id, 10);
  if (!['student', 'parent', 'staff'].includes(type) || !Number.isInteger(accountId) || accountId < 1) return;
  const key = `${type}:${accountId}`;
  const now = Date.now();
  if ((lastRecorded.get(key) || 0) > now - THROTTLE_MS) return;
  remember(lastRecorded, key, now);
  ensureAppUsageSchema(sequelize)
    .then(() => sequelize.query(
      `INSERT INTO ${TABLE} (account_type, account_id, app_version, first_seen_at, last_seen_at) VALUES (?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())
       ON DUPLICATE KEY UPDATE last_seen_at = UTC_TIMESTAMP(), app_version = COALESCE(VALUES(app_version), app_version)`,
      { replacements: [type, accountId, version] },
    ))
    .catch((error) => {
      lastRecorded.delete(key);
      console.error('⚠️ تسجيل مستخدم التطبيق فشل:', error.message);
    });
}

function portalAccountFromToken(token) {
  if (tokenCache.has(token)) return tokenCache.get(token);
  let account = null;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if ((decoded.type === 'student' || decoded.type === 'parent') && decoded.studentId) account = { type: decoded.type, id: decoded.studentId };
  } catch (e) { account = null; }
  remember(tokenCache, token, account);
  return account;
}

function staffUserFromSyncContext(req) {
  if (!req.headers['x-sync-device-token'] || !req.headers['x-sync-context']) return null;
  try {
    const context = JSON.parse(Buffer.from(String(req.headers['x-sync-context']), 'base64').toString('utf8'));
    return context && context.userId ? context.userId : null;
  } catch (e) { return null; }
}

// Middleware: مش بيغير أي حاجة في الطلب، بس بيسجل لو الطلب جاي من التطبيق
function appUsageMiddleware(sequelize) {
  return (req, res, next) => {
    try {
      if (isMobileAppRequest(req)) {
        const version = appVersionOf(req);
        const auth = String(req.headers.authorization || '');
        if (auth.startsWith('Bearer ') && req.path.startsWith('/api/portal/')) {
          const account = portalAccountFromToken(auth.slice(7));
          if (account) recordAppUser(sequelize, account.type, account.id, version);
        }
        const staffId = staffUserFromSyncContext(req);
        if (staffId) recordAppUser(sequelize, 'staff', staffId, version);
      }
    } catch (e) { /* التسجيل مينفعش يوقف أي طلب */ }
    next();
  };
}

async function getAppUsageStats(sequelize, { activeDays = 30 } = {}) {
  await ensureAppUsageSchema(sequelize);
  const [totals] = await sequelize.query(
    `SELECT account_type,
            COUNT(*) AS total,
            SUM(last_seen_at >= UTC_TIMESTAMP() - INTERVAL ? DAY) AS active,
            SUM(last_seen_at >= UTC_TIMESTAMP() - INTERVAL 1 DAY) AS today
     FROM ${TABLE} GROUP BY account_type`,
    { replacements: [activeDays] },
  );
  const [recent] = await sequelize.query(
    `SELECT a.account_type, a.account_id, a.app_version, a.first_seen_at, a.last_seen_at,
            COALESCE(s.name, u.name) AS name, s.student_code AS code, u.role AS staff_role
     FROM ${TABLE} a
     LEFT JOIN students s ON a.account_type IN ('student', 'parent') AND s.id = a.account_id
     LEFT JOIN users u ON a.account_type = 'staff' AND u.id = a.account_id
     ORDER BY a.last_seen_at DESC LIMIT 1000`,
  );
  const byType = { student: { total: 0, active: 0, today: 0 }, parent: { total: 0, active: 0, today: 0 }, staff: { total: 0, active: 0, today: 0 } };
  totals.forEach((row) => {
    if (byType[row.account_type]) {
      byType[row.account_type] = { total: Number(row.total) || 0, active: Number(row.active) || 0, today: Number(row.today) || 0 };
    }
  });
  return { byType, recent, activeDays };
}

module.exports = { ensureAppUsageSchema, appUsageMiddleware, recordAppUser, getAppUsageStats, isMobileAppRequest, appVersionOf, TABLE };
