// تجهيز ملفات البرنامج قبل البناء (desktop/staging):
//   staging/server   نسخة من السيستم (server.js + views + models ...) + الـ node_modules بتاعته — من غير .env أبدًا
//   staging/mariadb  قاعدة بيانات MariaDB مصغرة (نفس محرك Hostinger) بتشتغل على الجهاز
//   staging/cdn      ملفات Bootstrap والخطوط والأيقونات اللي الصفحات بتجيبها من النت، عشان تشتغل أوفلاين
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DESKTOP = path.resolve(__dirname, '..');
const REPO = path.resolve(DESKTOP, '..');
const STAGING = path.join(DESKTOP, 'staging');
const CACHE = path.join(DESKTOP, '.cache');

const MARIADB_VERSION = '11.4.13';
const MARIADB_URL = `https://archive.mariadb.org/mariadb-${MARIADB_VERSION}/winx64-packages/mariadb-${MARIADB_VERSION}-winx64.zip`;
const MARIADB_FILES = [
  'mariadbd.exe', 'mysqld.exe', 'server.dll', 'mariadb-install-db.exe', 'mariadb-admin.exe',
  'msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll', 'msvcp140_atomic_wait.dll', 'msvcp140_codecvt_ids.dll',
  'vcruntime140.dll', 'vcruntime140_1.dll', 'concrt140.dll', 'zlib1.dll',
];

// اللي بيتنسخ من السيستم للبرنامج (أي حاجة تانية زي سكريبتات الصيانة والـ callcenter مش محتاجينها)
const SERVER_INCLUDE = [
  /^server\.js$/, /^permissions\.js$/, /^package(-lock)?\.json$/,
  /^config\//, /^models\//, /^routes\//, /^utils\//, /^views\//, /^public\//, /^desktop\/runtime\//,
];
const FORBIDDEN = [/(^|\/)\.env/, /(^|\/)env$/, /\.pem$/, /^data\//, /^backups\//];

// كل روابط الـ CDN اللي الصفحات بتستخدمها
const CDN_URLS = [
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.rtl.min.css',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js',
  'https://unpkg.com/html5-qrcode',
  'https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap',
  'https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700;800&display=swap',
  'https://cdn.jsdelivr.net/npm/chart.js',
  'https://code.jquery.com/jquery-3.6.0.min.js',
  'https://cdn.jsdelivr.net/npm/select2@4.1.0-rc.0/dist/js/select2.min.js',
  'https://cdn.jsdelivr.net/npm/select2@4.1.0-rc.0/dist/css/select2.min.css',
  'https://cdn.jsdelivr.net/npm/select2-bootstrap-5-theme@1.3.0/dist/select2-bootstrap-5-theme.min.css',
  'https://cdn.jsdelivr.net/npm/select2-bootstrap-5-theme@1.3.0/dist/select2-bootstrap-5-theme.bundle.min.js',
  'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css',
];
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

function log(message) {
  console.log(`[prepare] ${message}`);
}

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options });
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ===== 1) السيستم =====
function prepareServer() {
  const target = path.join(STAGING, 'server');
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: REPO })
    .toString('utf8').split('\0').filter(Boolean)
    .filter(file => SERVER_INCLUDE.some(rule => rule.test(file)))
    .filter(file => fs.existsSync(path.join(REPO, file)));

  const forbidden = files.filter(file => FORBIDDEN.some(rule => rule.test(file)));
  if (forbidden.length) throw new Error(`Refusing to package secret/private files: ${forbidden.join(', ')}`);

  // نمسح كل حاجة ماعدا node_modules (بنعيد استخدامها لو package-lock ماتغيرش)
  if (fs.existsSync(target)) {
    for (const entry of fs.readdirSync(target)) {
      if (entry !== 'node_modules' && entry !== '.lock-hash') fs.rmSync(path.join(target, entry), { recursive: true, force: true });
    }
  }
  for (const file of files) copyFile(path.join(REPO, file), path.join(target, file));
  log(`copied ${files.length} server files`);

  const lockHash = hashFile(path.join(REPO, 'package-lock.json'));
  const lockMarker = path.join(target, '.lock-hash');
  if (!fs.existsSync(path.join(target, 'node_modules')) || !fs.existsSync(lockMarker) || fs.readFileSync(lockMarker, 'utf8') !== lockHash) {
    log('installing server dependencies (npm ci --omit=dev)...');
    fs.rmSync(path.join(target, 'node_modules'), { recursive: true, force: true });
    run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: target });
    fs.writeFileSync(lockMarker, lockHash);
  } else {
    log('server dependencies unchanged');
  }

  // تأكيد أخير: مفيش أي .env اتنسخ
  const leaked = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/^\.env/.test(entry.name) || entry.name === 'env') leaked.push(full);
    }
  })(target);
  if (leaked.length) throw new Error(`Secret file in staging: ${leaked.join(', ')}`);
}

// ===== 2) MariaDB =====
async function download(url, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const response = await fetch(url, { headers: { 'user-agent': CHROME_UA } });
  if (!response.ok) throw new Error(`Download failed ${response.status}: ${url}`);
  fs.writeFileSync(`${file}.part`, Buffer.from(await response.arrayBuffer()));
  fs.renameSync(`${file}.part`, file);
}

async function prepareMariaDB() {
  const target = path.join(STAGING, 'mariadb');
  const marker = path.join(target, '.version');
  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === MARIADB_VERSION) {
    log(`MariaDB ${MARIADB_VERSION} ready`);
    return;
  }
  const zip = path.join(CACHE, `mariadb-${MARIADB_VERSION}-winx64.zip`);
  if (!fs.existsSync(zip)) {
    log(`downloading MariaDB ${MARIADB_VERSION} (~95MB)...`);
    await download(MARIADB_URL, zip);
  }
  const extractDir = path.join(CACHE, `mariadb-${MARIADB_VERSION}`);
  if (!fs.existsSync(extractDir)) {
    log('extracting MariaDB...');
    fs.mkdirSync(extractDir, { recursive: true });
    // tar بتاع ويندوز نفسه (اللي مع Git مابيفهمش مسارات C:)
    run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', extractDir], { shell: false });
  }
  const source = path.join(extractDir, `mariadb-${MARIADB_VERSION}-winx64`);
  fs.rmSync(target, { recursive: true, force: true });
  for (const file of MARIADB_FILES) copyFile(path.join(source, 'bin', file), path.join(target, 'bin', file));
  fs.cpSync(path.join(source, 'share'), path.join(target, 'share'), { recursive: true });
  for (const file of ['COPYING', 'THIRDPARTY']) if (fs.existsSync(path.join(source, file))) copyFile(path.join(source, file), path.join(target, file));
  fs.writeFileSync(marker, MARIADB_VERSION);
  log('MariaDB staged');
}

// ===== 3) ملفات الـ CDN =====
function cacheName(url) {
  return crypto.createHash('sha1').update(url).digest('hex');
}

async function prepareCdn() {
  const target = path.join(STAGING, 'cdn');
  const indexFile = path.join(target, 'index.json');
  const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : {};
  const queue = [...CDN_URLS];
  const seen = new Set();
  while (queue.length) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    const name = cacheName(url);
    let type = index[url] && index[url].type;
    let body;
    if (index[url] && fs.existsSync(path.join(target, name))) {
      body = fs.readFileSync(path.join(target, name));
    } else {
      const response = await fetch(url, { headers: { 'user-agent': CHROME_UA } });
      if (!response.ok) {
        // رابط مكسور أصلًا في الصفحات (بيرجع 404 أونلاين كمان) — نتخطاه
        log(`cdn: SKIPPED ${response.status} ${url}`);
        continue;
      }
      body = Buffer.from(await response.arrayBuffer());
      type = response.headers.get('content-type') || 'application/octet-stream';
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, name), body);
      index[url] = { file: name, type };
      log(`cdn: ${url}`);
    }
    // ملفات الخطوط والأيقونات اللي جوه الـ CSS
    if (/css/.test(type || '')) {
      const css = body.toString('utf8');
      for (const match of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
        const ref = match[1];
        if (ref.startsWith('data:')) continue;
        const absolute = new URL(ref, url);
        absolute.hash = '';
        queue.push(absolute.toString());
      }
    }
  }
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
  log(`cdn: ${Object.keys(index).length} files cached`);
}

// ===== 4) الأيقونة =====
function writePng(file, size, pixel) {
  const zlib = require('zlib');
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      raw[offset] = r; raw[offset + 1] = g; raw[offset + 2] = b; raw[offset + 3] = a;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

function prepareIcon() {
  const file = path.join(DESKTOP, 'build', 'icon.png');
  const appIcon = path.join(DESKTOP, 'app', 'icon.png');
  if (fs.existsSync(file)) {
    copyFile(file, appIcon);
    return;
  }
  const size = 256;
  const S = 4; // supersampling
  const inside = (px, py) => {
    // مربع بحواف دايرية بلون السيستم + علامة صح بيضا
    const r = 56, m = 8;
    const cx = Math.min(Math.max(px, m + r), size - m - r);
    const cy = Math.min(Math.max(py, m + r), size - m - r);
    if ((px - cx) ** 2 + (py - cy) ** 2 > r * r) return 0;
    const dist = (x1, y1, x2, y2) => {
      const dx = x2 - x1, dy = y2 - y1;
      const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
      return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
    };
    const check = Math.min(dist(70, 132, 112, 176), dist(112, 176, 190, 86));
    return check < 17 ? 2 : 1;
  };
  writePng(file, size, (x, y) => {
    let bg = 0, fg = 0;
    for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) {
      const v = inside(x + (i + 0.5) / S, y + (j + 0.5) / S);
      if (v === 1) bg++; else if (v === 2) fg++;
    }
    const total = S * S;
    const alpha = (bg + fg) / total;
    if (!alpha) return [0, 0, 0, 0];
    const f = fg / (bg + fg);
    return [Math.round(67 + (255 - 67) * f), Math.round(56 + (255 - 56) * f), Math.round(202 + (255 - 202) * f), Math.round(alpha * 255)];
  });
  copyFile(file, appIcon);
  log('icon generated');
}

(async () => {
  fs.mkdirSync(STAGING, { recursive: true });
  prepareServer();
  await prepareMariaDB();
  await prepareCdn();
  prepareIcon();
  log('done');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
