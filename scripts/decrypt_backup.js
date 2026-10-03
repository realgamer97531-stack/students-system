// فك تشفير نسخة احتياطية نازلة من Cloudinary وتحويلها لملف .sql عادي.
//
// الاستخدام:
//   node scripts/decrypt_backup.js <path/to/db-backup_....sql.gz.enc>
//
// الباسورد بيتقري من BACKUP_ENCRYPTION_PASSWORD (في .env أو الـ environment).
// السكريبت ده بيقرا الملف ويكتب ملف جديد جنبه بس — مش بيلمس قاعدة البيانات خالص.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { decryptBuffer } = require('../utils/dailyBackup');

const input = process.argv[2];
if (!input) {
  console.error('Usage: node scripts/decrypt_backup.js <backup-file.gz.enc>');
  process.exit(1);
}

const password = process.env.BACKUP_ENCRYPTION_PASSWORD;
if (!password) {
  console.error('BACKUP_ENCRYPTION_PASSWORD is not set (put it in .env or the environment).');
  process.exit(1);
}

try {
  const plain = zlib.gunzipSync(decryptBuffer(fs.readFileSync(input), password));
  const output = path.join(path.dirname(input), path.basename(input).replace(/\.gz\.enc$/, '').replace(/\.enc$/, ''));
  if (fs.existsSync(output)) {
    console.error(`Refusing to overwrite existing file: ${output}`);
    process.exit(1);
  }
  fs.writeFileSync(output, plain);
  console.log(`Decrypted: ${output} (${(plain.length / 1024).toFixed(0)} KB)`);
} catch (error) {
  console.error('Failed to decrypt (wrong password or damaged file):', error.message);
  process.exit(1);
}
