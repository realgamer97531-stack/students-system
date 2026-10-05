// تشغيل قاعدة البيانات المحلية (MariaDB) على الجهاز: أول مرة بيتعملها تجهيز، وبعد كده بتشتغل مع البرنامج وتقفل معاه.
// البيانات بتتحفظ في فولدر البرنامج في AppData، فالتحديثات مش بتمسحها.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

let child = null;
let current = null;

function hasNonAscii(value) {
  return /[^\x00-\x7F]/.test(value);
}

// MariaDB مش بتحب المسارات اللي فيها حروف عربي (لو اسم يوزر ويندوز عربي)، فبنستخدم مسار إنجليزي بديل
function safeRoot(preferred, programName) {
  if (!hasNonAscii(preferred)) return preferred;
  return path.join(process.env.SystemDrive || 'C:', `${programName}Data`);
}

function prepareBinaries(resourcesMariaDB, dataRoot) {
  if (!hasNonAscii(resourcesMariaDB)) return resourcesMariaDB;
  const version = fs.readFileSync(path.join(resourcesMariaDB, '.version'), 'utf8').trim();
  const target = path.join(dataRoot, `mariadb-${version}`);
  if (!fs.existsSync(path.join(target, '.version'))) {
    fs.cpSync(resourcesMariaDB, target, { recursive: true });
  }
  return target;
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function pickPort(preferred) {
  for (let port = preferred; port < preferred + 50; port++) {
    if (await portFree(port)) return port;
  }
  throw new Error('مفيش بورت فاضي لقاعدة البيانات');
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
  });
}

function runFile(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 120000, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.message += `\n${stdout}\n${stderr}`;
        reject(error);
      } else resolve(stdout);
    });
  });
}

async function adminPing(binDir, port, password) {
  try {
    await runFile(path.join(binDir, 'mariadb-admin.exe'), ['-h127.0.0.1', `-P${port}`, '-uroot', `-p${password}`, '--connect-timeout=2', 'ping'], { timeout: 5000 });
    return true;
  } catch (e) {
    return false;
  }
}

async function start({ resourcesMariaDB, dataRoot, password, preferredPort, logFile }) {
  const binDir = path.join(prepareBinaries(resourcesMariaDB, dataRoot), 'bin');
  const dataDir = path.join(dataRoot, 'mariadb-data');

  // لو البرنامج اتقفل غلط قبل كده والقاعدة لسه شغالة بنفس الباسورد: نكمل عليها
  if (preferredPort && await canConnect(preferredPort) && await adminPing(binDir, preferredPort, password)) {
    current = { port: preferredPort, binDir, password, external: true };
    return current;
  }

  const port = await pickPort(preferredPort || 33406);
  if (!fs.existsSync(path.join(dataDir, 'mysql'))) {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.mkdirSync(dataRoot, { recursive: true });
    await runFile(path.join(binDir, 'mariadb-install-db.exe'), [`--datadir=${dataDir}`, `--password=${password}`, `--port=${port}`]);
  }

  const out = fs.openSync(logFile, 'a');
  child = spawn(path.join(binDir, 'mariadbd.exe'), [
    `--defaults-file=${path.join(dataDir, 'my.ini')}`,
    `--datadir=${dataDir}`,
    `--port=${port}`,
    '--bind-address=127.0.0.1',
    '--skip-name-resolve',
    '--character-set-server=utf8mb4',
    '--collation-server=utf8mb4_unicode_ci',
    '--innodb-buffer-pool-size=256M',
    '--max-connections=60',
    '--max-allowed-packet=256M',
    '--console',
  ], { windowsHide: true, stdio: ['ignore', out, out] });
  child.once('exit', () => { child = null; });

  const startedAt = Date.now();
  while (!(await adminPing(binDir, port, password))) {
    if (!child) throw new Error(`قاعدة البيانات المحلية مقدرتش تشتغل — راجع ${logFile}`);
    if (Date.now() - startedAt > 90000) throw new Error('قاعدة البيانات المحلية اتأخرت جدًا في التشغيل');
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  current = { port, binDir, password, external: false };
  return current;
}

async function stop() {
  if (!current) return;
  const { binDir, port, password } = current;
  try {
    await runFile(path.join(binDir, 'mariadb-admin.exe'), ['-h127.0.0.1', `-P${port}`, '-uroot', `-p${password}`, 'shutdown'], { timeout: 30000 });
  } catch (e) {
    if (child) child.kill();
  }
  const waitStart = Date.now();
  while (child && Date.now() - waitStart < 30000) await new Promise(resolve => setTimeout(resolve, 200));
  current = null;
}

module.exports = { start, stop, safeRoot };
