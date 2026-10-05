// تخزين برنامج الديسكتوب على الجهاز (قاعدة بيانات منفصلة عن بيانات السيستم نفسه):
//   outbox  طابور العمليات اللي اتعملت على الجهاز ولسه هتترفع (بيفضل موجود حتى لو الجهاز اتقفل)
//   id_map  الـ id اللي اتعمل أوفلاين على الجهاز ← الـ id الحقيقي اللي السيرفر إداه
//   kv      إعدادات وحالة المزامنة
// محتوى العمليات (اللي ممكن يكون فيه باسوردات زي باسورد الأدمن) بيتحفظ متشفر.
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const LOCAL_ID_BASE = 2000000000;
const LOCAL_ID_SPAN = 1000000;

let dataPool = null;
let metaPool = null;

function config() {
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    dataDb: process.env.DB_NAME,
    metaDb: process.env.DESKTOP_META_DB || `${process.env.DB_NAME}_meta`,
  };
}

function poolOptions(database) {
  const c = config();
  return {
    host: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    database,
    connectionLimit: 4,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    timezone: 'Z',
    charset: 'utf8mb4',
    multipleStatements: false,
  };
}

async function init() {
  const c = config();
  const admin = await mysql.createConnection({ host: c.host, port: c.port, user: c.user, password: c.password, charset: 'utf8mb4' });
  await admin.query(`CREATE DATABASE IF NOT EXISTS \`${c.dataDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await admin.query(`CREATE DATABASE IF NOT EXISTS \`${c.metaDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await admin.end();

  dataPool = mysql.createPool(poolOptions(c.dataDb));
  metaPool = mysql.createPool(poolOptions(c.metaDb));

  await metaPool.query(`CREATE TABLE IF NOT EXISTS outbox (
    seq BIGINT AUTO_INCREMENT PRIMARY KEY,
    op_id CHAR(36) NOT NULL UNIQUE,
    state VARCHAR(16) NOT NULL,
    method VARCHAR(10) NOT NULL,
    url TEXT NOT NULL,
    payload LONGBLOB NOT NULL,
    summary VARCHAR(1000) NULL,
    user_name VARCHAR(255) NULL,
    client_time BIGINT NOT NULL,
    local_ok TINYINT(1) NULL,
    local_message TEXT NULL,
    local_created MEDIUMTEXT NULL,
    local_tables TEXT NULL,
    attempts INT NOT NULL DEFAULT 0,
    last_error TEXT NULL,
    server_message TEXT NULL,
    dismissed TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL,
    finished_at DATETIME NULL,
    KEY idx_outbox_state (state, seq)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await metaPool.query(`CREATE TABLE IF NOT EXISTS id_map (
    local_id BIGINT NOT NULL PRIMARY KEY,
    server_id BIGINT NOT NULL,
    table_name VARCHAR(128) NOT NULL,
    op_id CHAR(36) NULL,
    created_at DATETIME NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await metaPool.query(`CREATE TABLE IF NOT EXISTS kv (
    k VARCHAR(64) NOT NULL PRIMARY KEY,
    v MEDIUMTEXT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

const data = () => dataPool;
const meta = () => metaPool;

// ===== kv =====
async function getKv(key, fallback = null) {
  const [rows] = await metaPool.query('SELECT v FROM kv WHERE k = ?', [key]);
  if (!rows.length || rows[0].v === null) return fallback;
  try { return JSON.parse(rows[0].v); } catch (e) { return fallback; }
}

async function setKv(key, value) {
  await metaPool.query('INSERT INTO kv (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [key, JSON.stringify(value)]);
}

// ===== التشفير =====
function outboxKey() {
  const hex = process.env.DESKTOP_OUTBOX_KEY || '';
  return /^[0-9a-f]{64}$/i.test(hex) ? Buffer.from(hex, 'hex') : null;
}

function seal(object) {
  const plain = Buffer.from(JSON.stringify(object), 'utf8');
  const key = outboxKey();
  if (!key) return Buffer.concat([Buffer.from('P1'), plain]);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from('E1'), iv, cipher.getAuthTag(), encrypted]);
}

function unseal(buffer) {
  const tag = buffer.subarray(0, 2).toString();
  if (tag === 'P1') return JSON.parse(buffer.subarray(2).toString('utf8'));
  if (tag !== 'E1') throw new Error('Unknown outbox payload format');
  const key = outboxKey();
  if (!key) throw new Error('Outbox key missing');
  const iv = buffer.subarray(2, 14);
  const authTag = buffer.subarray(14, 30);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return JSON.parse(Buffer.concat([decipher.update(buffer.subarray(30)), decipher.final()]).toString('utf8'));
}

function mysqlNow() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// ===== outbox =====
async function insertOp(op) {
  await metaPool.query(
    `INSERT INTO outbox (op_id, state, method, url, payload, summary, user_name, client_time, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [op.opId, op.state, op.method, op.url, seal(op.payload), op.summary, op.userName, op.clientTime, mysqlNow()],
  );
}

async function finishLocalOp(opId, { ok, message, created, tables }) {
  await metaPool.query(
    `UPDATE outbox SET state = 'ready', local_ok = ?, local_message = ?, local_created = ?, local_tables = ?
     WHERE op_id = ? AND state = 'started'`,
    [ok ? 1 : 0, message ? String(message).slice(0, 2000) : null, JSON.stringify(created || []), JSON.stringify(tables || []), opId],
  );
}

async function deleteOp(opId) {
  await metaPool.query("DELETE FROM outbox WHERE op_id = ? AND state = 'started'", [opId]);
}

async function nextPendingOps(limit = 50) {
  const [rows] = await metaPool.query(
    "SELECT * FROM outbox WHERE state IN ('started', 'ready') ORDER BY seq LIMIT ?", [limit],
  );
  return rows;
}

async function countByState() {
  const [rows] = await metaPool.query(
    'SELECT state, dismissed, COUNT(*) AS c FROM outbox GROUP BY state, dismissed',
  );
  const out = { pending: 0, failed: 0, done: 0 };
  for (const row of rows) {
    if (row.state === 'started' || row.state === 'ready') out.pending += Number(row.c);
    else if (row.state === 'failed' && !row.dismissed) out.failed += Number(row.c);
    else if (row.state === 'done') out.done += Number(row.c);
  }
  return out;
}

async function markOp(seq, fields) {
  const keys = Object.keys(fields);
  await metaPool.query(
    `UPDATE outbox SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE seq = ?`,
    [...keys.map(k => fields[k]), seq],
  );
}

async function listProblems() {
  const [rows] = await metaPool.query(
    `SELECT seq, op_id, method, url, summary, user_name, client_time, local_message, server_message, last_error, attempts
     FROM outbox WHERE state = 'failed' AND dismissed = 0 ORDER BY seq DESC LIMIT 500`,
  );
  return rows;
}

async function failedTablesNeedingRefresh() {
  return getKv('refresh_tables', []);
}

async function purgeOldHistory() {
  await metaPool.query("DELETE FROM outbox WHERE state = 'done' AND finished_at < (UTC_TIMESTAMP() - INTERVAL 30 DAY)");
  await metaPool.query("DELETE FROM outbox WHERE state = 'failed' AND dismissed = 1 AND finished_at < (UTC_TIMESTAMP() - INTERVAL 30 DAY)");
  await metaPool.query('DELETE FROM id_map WHERE created_at < (UTC_TIMESTAMP() - INTERVAL 30 DAY)');
}

// ===== id_map =====
const idMapCache = new Map();

async function loadIdMap() {
  const [rows] = await metaPool.query('SELECT local_id, server_id FROM id_map');
  idMapCache.clear();
  for (const row of rows) idMapCache.set(Number(row.local_id), Number(row.server_id));
}

async function addIdMapping(localId, serverId, table, opId) {
  await metaPool.query(
    'INSERT INTO id_map (local_id, server_id, table_name, op_id, created_at) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE server_id = VALUES(server_id)',
    [localId, serverId, table, opId, mysqlNow()],
  );
  idMapCache.set(Number(localId), Number(serverId));
}

function mapLocalId(value) {
  return idMapCache.get(Number(value));
}

function isLocalId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= LOCAL_ID_BASE && n < 2147483648;
}

module.exports = {
  LOCAL_ID_BASE, LOCAL_ID_SPAN,
  init, data, meta, getKv, setKv, seal, unseal, mysqlNow,
  insertOp, finishLocalOp, deleteOp, nextPendingOps, countByState, markOp, listProblems, failedTablesNeedingRefresh, purgeOldHistory,
  loadIdMap, addIdMapping, mapLocalId, isLocalId,
};
