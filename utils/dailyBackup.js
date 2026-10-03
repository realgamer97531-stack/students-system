// النسخة الاحتياطية اليومية لقاعدة البيانات.
//
// - بتقرا بس من الداتابيز (SELECT) جوه transaction واحدة، فكل الجداول بتتاخد من نفس اللحظة
//   ومن غير ما تقفل أي جدول (المستخدمين مش هيحسوا بحاجة).
// - بتطلع ملف .sql عادي (CREATE TABLE IF NOT EXISTS + INSERT) ينفع يترجع في phpMyAdmin أو أي MySQL/MariaDB.
// - الملف بيتضغط (gzip) وبيتشفر (AES-256-GCM) بباسورد BACKUP_ENCRYPTION_PASSWORD قبل ما يخرج من السيرفر.
// - بيترفع على Cloudinary كملف خاص (authenticated) — بره السيرفر، فأي تحديث/deploy مش بيمسحه.
// - بيمسح النسخ الأقدم من BACKUP_RETENTION_DAYS (افتراضي 30 يوم) بعد ما النسخة الجديدة تترفع بنجاح بس.
//
// فك التشفير: node scripts/decrypt_backup.js <file.sql.gz.enc>
const crypto = require('crypto');
const zlib = require('zlib');
const fs = require('fs');
const { QueryTypes, Transaction } = require('sequelize');
const cloudinary = require('cloudinary').v2;

const BACKUP_FOLDER = process.env.BACKUP_CLOUDINARY_FOLDER || 'student-system-backups';
const FILE_MAGIC = Buffer.from('STBK1'); // علامة بداية الملف المشفر (نسخة 1 من الصيغة)
const INSERT_BATCH_SIZE = 200;
// حد Cloudinary للملفات (raw) في الخطة المجانية 10MB
const CLOUDINARY_RAW_LIMIT_BYTES = 10 * 1024 * 1024;

let running = null;
let lastResult = null;

function getRetentionDays() {
  const days = Number.parseInt(process.env.BACKUP_RETENTION_DAYS, 10);
  return Number.isInteger(days) && days > 0 ? days : 30;
}

function getEncryptionPassword() {
  const password = process.env.BACKUP_ENCRYPTION_PASSWORD;
  if (!password || password.length < 12) {
    throw new Error('BACKUP_ENCRYPTION_PASSWORD مش متظبط (لازم 12 حرف على الأقل) — النسخة الاحتياطية متعملتش عشان البيانات حساسة ومينفعش تترفع من غير تشفير');
  }
  return password;
}

function quoteIdentifier(name) {
  return '`' + String(name).replace(/`/g, '``') + '`';
}

function sqlValue(sequelize, value) {
  // أعمدة JSON في MySQL بترجع كـ object؛ بنكتبها نص JSON عادي
  if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    return sequelize.escape(JSON.stringify(value));
  }
  return sequelize.escape(value);
}

// بيبني ملف SQL كامل للداتابيز من لقطة واحدة متسقة
async function buildSqlDump(sequelize) {
  const databaseName = sequelize.config.database;
  const lines = [];
  const summary = [];

  await sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ }, async (transaction) => {
    const tables = await sequelize.query(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
      { replacements: [databaseName], type: QueryTypes.SELECT, transaction }
    );

    lines.push(`-- Student tracking system database backup`);
    lines.push(`-- Database: ${databaseName}`);
    lines.push(`-- Created at (UTC): ${new Date().toISOString()}`);
    lines.push(`-- Restore into an EMPTY database. Existing rows are never overwritten.`);
    lines.push('SET NAMES utf8mb4;');
    lines.push("SET time_zone = '+00:00';");
    lines.push('SET FOREIGN_KEY_CHECKS = 0;');
    lines.push('');

    for (const { TABLE_NAME: tableName } of tables) {
      const createResult = await sequelize.query(`SHOW CREATE TABLE ${quoteIdentifier(tableName)}`, { type: QueryTypes.SELECT, transaction });
      const createSql = createResult[0] && (createResult[0]['Create Table'] || createResult[0]['Create table']);
      if (createSql) {
        lines.push(createSql.replace(/^CREATE TABLE /i, 'CREATE TABLE IF NOT EXISTS ') + ';');
      }

      const rows = await sequelize.query(`SELECT * FROM ${quoteIdentifier(tableName)}`, { type: QueryTypes.SELECT, transaction });
      summary.push({ table: tableName, rows: rows.length });
      if (!rows.length) {
        lines.push('');
        continue;
      }

      const columns = Object.keys(rows[0]);
      const columnList = columns.map(quoteIdentifier).join(', ');
      for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
        const values = rows.slice(i, i + INSERT_BATCH_SIZE)
          .map((row) => '(' + columns.map((column) => sqlValue(sequelize, row[column])).join(', ') + ')');
        lines.push(`INSERT INTO ${quoteIdentifier(tableName)} (${columnList}) VALUES\n${values.join(',\n')};`);
      }
      lines.push('');
    }

    lines.push('SET FOREIGN_KEY_CHECKS = 1;');
  });

  return { sql: lines.join('\n'), summary };
}

// صيغة الملف: STBK1 | salt(16) | iv(12) | authTag(16) | البيانات المشفرة
function encryptBuffer(plain, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([FILE_MAGIC, salt, iv, cipher.getAuthTag(), encrypted]);
}

function decryptBuffer(file, password) {
  if (!file.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)) {
    throw new Error('الملف ده مش نسخة احتياطية مشفرة من النظام');
  }
  let offset = FILE_MAGIC.length;
  const salt = file.subarray(offset, offset += 16);
  const iv = file.subarray(offset, offset += 12);
  const tag = file.subarray(offset, offset += 16);
  const key = crypto.scryptSync(password, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(file.subarray(offset)), decipher.final()]);
}

function uploadToCloudinary(buffer, publicId) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({
      resource_type: 'raw',
      type: 'authenticated', // خاص: مينفعش يتفتح غير بلينك موقّع
      folder: BACKUP_FOLDER,
      public_id: publicId,
      overwrite: false,
    }, (error, result) => (error ? reject(error) : resolve(result)));
    stream.end(buffer);
  });
}

async function listBackups() {
  const all = [];
  let nextCursor;
  do {
    const page = await cloudinary.api.resources({
      resource_type: 'raw',
      type: 'authenticated',
      prefix: BACKUP_FOLDER + '/',
      max_results: 500,
      next_cursor: nextCursor,
    });
    all.push(...(page.resources || []));
    nextCursor = page.next_cursor;
  } while (nextCursor);

  return all
    .map((r) => ({ publicId: r.public_id, bytes: r.bytes, createdAt: new Date(r.created_at) }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

// بيمسح النسخ القديمة بس، وبيسيب دايمًا آخر 7 نسخ على الأقل مهما كان عمرهم
async function pruneOldBackups() {
  const cutoff = Date.now() - getRetentionDays() * 24 * 60 * 60 * 1000;
  const backups = await listBackups();
  const toDelete = backups.slice(7).filter((b) => b.createdAt.getTime() < cutoff).map((b) => b.publicId);
  for (let i = 0; i < toDelete.length; i += 100) {
    await cloudinary.api.delete_resources(toDelete.slice(i, i + 100), { resource_type: 'raw', type: 'authenticated' });
  }
  return toDelete.length;
}

function getDownloadUrl(publicId) {
  return cloudinary.utils.private_download_url(publicId, '', {
    resource_type: 'raw',
    type: 'authenticated',
    attachment: true,
    expires_at: Math.floor(Date.now() / 1000) + 5 * 60, // اللينك صالح 5 دقايق بس
  });
}

function timestampForName(date = new Date()) {
  // بتوقيت السيرفر (مصر)
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
}

async function doBackup(sequelize, { reason = 'daily', extraFiles = [] } = {}) {
  const startedAt = new Date();
  const password = getEncryptionPassword();
  const stamp = timestampForName(startedAt);
  const safeReason = String(reason).replace(/[^a-z0-9-]/gi, '-');

  const { sql, summary } = await buildSqlDump(sequelize);
  const encrypted = encryptBuffer(zlib.gzipSync(Buffer.from(sql, 'utf8'), { level: 9 }), password);
  if (encrypted.length > CLOUDINARY_RAW_LIMIT_BYTES) {
    console.warn(`⚠️ حجم النسخة الاحتياطية ${(encrypted.length / 1024 / 1024).toFixed(1)}MB — قرب من حد Cloudinary (10MB)`);
  }

  const uploaded = await uploadToCloudinary(encrypted, `db-backup_${stamp}_${safeReason}.sql.gz.enc`);

  // ملفات إضافية صغيرة (زي دفتر أكواد السناتر) بتترفع مشفرة جنب النسخة
  for (const file of extraFiles) {
    try {
      if (!file || !fs.existsSync(file.path)) continue;
      const content = encryptBuffer(zlib.gzipSync(fs.readFileSync(file.path)), password);
      await uploadToCloudinary(content, `${file.name}_${stamp}_${safeReason}.gz.enc`);
    } catch (error) {
      console.error(`⚠️ فشل رفع ملف إضافي (${file.name}) مع النسخة الاحتياطية:`, error.message);
    }
  }

  let pruned = 0;
  try {
    pruned = await pruneOldBackups();
  } catch (error) {
    console.error('⚠️ فشل مسح النسخ الاحتياطية القديمة (النسخة الجديدة اترفعت عادي):', error.message);
  }

  const totalRows = summary.reduce((sum, t) => sum + t.rows, 0);
  return {
    ok: true,
    reason,
    startedAt,
    finishedAt: new Date(),
    publicId: uploaded.public_id,
    bytes: encrypted.length,
    tables: summary.length,
    totalRows,
    studentsCount: (summary.find((t) => t.table === 'students') || {}).rows,
    pruned,
  };
}

// بتشغّل نسخة احتياطية (ولو فيه واحدة شغالة بالفعل بترجع نفس النتيجة بدل ما تبدأ تانية)
function runBackup(sequelize, options = {}) {
  if (running) return running;
  running = doBackup(sequelize, options)
    .then((result) => {
      lastResult = result;
      console.log(`✅ نسخة احتياطية (${result.reason}) اترفعت: ${result.publicId} — ${result.tables} جدول، ${result.totalRows} صف، ${(result.bytes / 1024).toFixed(0)}KB`);
      return result;
    })
    .catch((error) => {
      lastResult = { ok: false, reason: options.reason || 'daily', finishedAt: new Date(), error: error.message };
      console.error(`❌ فشل النسخة الاحتياطية (${options.reason || 'daily'}):`, error.message);
      throw error;
    })
    .finally(() => {
      running = null;
    });
  return running;
}

function getLastResult() {
  return lastResult;
}

module.exports = {
  buildSqlDump,
  runBackup,
  listBackups,
  getDownloadUrl,
  getLastResult,
  decryptBuffer,
  BACKUP_FOLDER,
};
