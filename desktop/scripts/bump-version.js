// بيزود رقم الإصدار (1.0.3 → 1.0.4) قبل كل نشر، عشان الأجهزة تعرف إن فيه تحديث جديد
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
const [major, minor, patch] = pkg.version.split('.').map(Number);
pkg.version = `${major}.${minor}.${patch + 1}`;
fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`version → ${pkg.version}`);
