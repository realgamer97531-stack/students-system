// مخزن جلسات تسجيل الدخول في قاعدة البيانات بدل ذاكرة السيرفر،
// عشان أي ديبلوي أو ريستارت للسيرفر ميخرجش حد من السيستم ولا يضيع الجلسة المختارة.
// الجدول بيتعمل بـ CREATE TABLE IF NOT EXISTS بس — مفيش أي تعديل على جداول موجودة.
// لو قاعدة البيانات وقعت لحظة: الطلب بيكمل كأنه مش داخل (وبيرجع لصفحة الدخول) بدل ما السيرفر يقع.
const session = require('express-session');
const { QueryTypes } = require('sequelize');

const TABLE = 'web_sessions';
const TOUCH_EVERY_MS = 15 * 60 * 1000; // مبنحدثش وقت الانتهاء في كل طلب، كل ربع ساعة كفاية
const PRUNE_EVERY_MS = 60 * 60 * 1000;

class DbSessionStore extends session.Store {
  constructor(sequelize, { ttlMs }) {
    super();
    this.sequelize = sequelize;
    this.ttlMs = ttlMs;
    this.ready = null;
    this.lastTouch = new Map(); // sid -> آخر مرة اتحدث فيها وقت الانتهاء
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_EVERY_MS);
    if (this.pruneTimer.unref) this.pruneTimer.unref();
  }

  ensure() {
    if (!this.ready) {
      this.ready = this.sequelize.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
        sid VARCHAR(128) NOT NULL,
        data MEDIUMTEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        PRIMARY KEY (sid),
        KEY idx_web_sessions_expires (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch((error) => {
        this.ready = null;
        throw error;
      });
    }
    return this.ready;
  }

  expiryOf(sess) {
    const cookieExpires = sess && sess.cookie && sess.cookie.expires;
    const ms = cookieExpires ? new Date(cookieExpires).getTime() : NaN;
    return Number.isFinite(ms) ? ms : Date.now() + this.ttlMs;
  }

  get(sid, callback) {
    this.ensure()
      .then(() => this.sequelize.query(`SELECT data, expires_at FROM ${TABLE} WHERE sid = ? LIMIT 1`, {
        replacements: [sid], type: QueryTypes.SELECT,
      }))
      .then((rows) => {
        const row = rows[0];
        if (!row) return callback(null, null);
        if (Number(row.expires_at) <= Date.now()) {
          this.destroy(sid, () => {});
          return callback(null, null);
        }
        let data = null;
        try { data = JSON.parse(row.data); } catch (e) { data = null; }
        callback(null, data);
      })
      .catch((error) => {
        console.error('Session store read failed:', error.message);
        callback(null, null);
      });
  }

  set(sid, sess, callback) {
    // جلسة مؤقتة لطلب واحد من أجهزة المزامنة (بتتمسح أول ما الطلب يخلص) — ملهاش لازمة في قاعدة البيانات
    if (sess && sess.syncTemp) return callback && callback(null);
    const expiresAt = this.expiryOf(sess);
    this.ensure()
      .then(() => this.sequelize.query(
        `INSERT INTO ${TABLE} (sid, data, expires_at) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE data = VALUES(data), expires_at = VALUES(expires_at)`,
        { replacements: [sid, JSON.stringify(sess), expiresAt] },
      ))
      .then(() => {
        this.lastTouch.set(sid, Date.now());
        if (callback) callback(null);
      })
      .catch((error) => {
        console.error('Session store write failed:', error.message);
        if (callback) callback(null); // منوقفش الطلب عشان الجلسة متحفظتش
      });
  }

  touch(sid, sess, callback) {
    if (sess && sess.syncTemp) return callback && callback(null);
    const last = this.lastTouch.get(sid) || 0;
    if (Date.now() - last < TOUCH_EVERY_MS) return callback && callback(null);
    if (this.lastTouch.size > 50000) this.lastTouch.clear();
    this.lastTouch.set(sid, Date.now());
    this.ensure()
      .then(() => this.sequelize.query(`UPDATE ${TABLE} SET expires_at = ? WHERE sid = ?`, {
        replacements: [this.expiryOf(sess), sid],
      }))
      .then(() => callback && callback(null))
      .catch((error) => {
        console.error('Session store touch failed:', error.message);
        if (callback) callback(null);
      });
  }

  destroy(sid, callback) {
    this.lastTouch.delete(sid);
    this.ensure()
      .then(() => this.sequelize.query(`DELETE FROM ${TABLE} WHERE sid = ?`, { replacements: [sid] }))
      .then(() => callback && callback(null))
      .catch((error) => {
        console.error('Session store delete failed:', error.message);
        if (callback) callback(null);
      });
  }

  prune() {
    this.ensure()
      .then(() => this.sequelize.query(`DELETE FROM ${TABLE} WHERE expires_at < ?`, { replacements: [Date.now()] }))
      .catch(() => {});
  }
}

module.exports = { DbSessionStore, SESSION_TABLE: TABLE };
