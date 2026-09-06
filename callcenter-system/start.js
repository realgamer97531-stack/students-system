/*
 * One-click launcher for the Call Center system.
 *
 * What this does:
 *  1. Installs backend/frontend dependencies the first time (skips if already done).
 *  2. Starts the backend API and the frontend dev server.
 *  3. Figures out your computer's local network address.
 *  4. Prints a QR code IN THE TERMINAL that phones on the same WiFi can scan
 *     to join instantly, and saves the same QR code as an image file.
 *  5. Opens your browser to the admin dashboard automatically.
 *
 * Run with:  npm start   (from this folder)
 * Or just double-click start.command (Mac) / start.bat (Windows).
 */

const { spawn, execSync, exec } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const BACKEND_DIR = path.join(ROOT, 'backend');
const FRONTEND_DIR = path.join(ROOT, 'frontend');
const FRONTEND_PORT = 5173;

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function log(msg) {
  console.log(`\x1b[36m[launcher]\x1b[0m ${msg}`);
}

function ensureInstalled(dir, label) {
  const nodeModules = path.join(dir, 'node_modules');
  if (fs.existsSync(nodeModules)) return;
  log(`Installing ${label} dependencies for the first time (this can take a minute)…`);
  execSync(`${npmCmd} install`, { cwd: dir, stdio: 'inherit' });
}

function ensureBackendEnv() {
  const envPath = path.join(BACKEND_DIR, '.env');
  const examplePath = path.join(BACKEND_DIR, '.env.example');
  if (!fs.existsSync(envPath) && fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, envPath);
    log('Created backend/.env from the example file (edit it to set a real password/secret).');
  }
}

function ensureSeeded() {
  // Seed only creates a user if one doesn't already exist, so this is safe to run every time.
  try {
    execSync(`${npmCmd} run seed`, { cwd: BACKEND_DIR, stdio: 'inherit' });
  } catch (e) {
    log('Seeding skipped (this is fine if an admin account already exists).');
  }
}

function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

function openBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? `open "${url}"` :
    process.platform === 'win32' ? `start "" "${url}"` :
    `xdg-open "${url}"`;
  exec(cmd, () => {}); // best-effort; ignore failures (e.g. headless servers)
}

async function main() {
  log('Checking dependencies…');
  ensureInstalled(BACKEND_DIR, 'backend');
  ensureInstalled(FRONTEND_DIR, 'frontend');
  ensureInstalled(ROOT, 'launcher');
  ensureBackendEnv();
  ensureSeeded();

  log('Starting backend API…');
  const backend = spawn(npmCmd, ['start'], { cwd: BACKEND_DIR, stdio: 'inherit', shell: true });

  log('Starting frontend…');
  const frontend = spawn(npmCmd, ['run', 'dev'], { cwd: FRONTEND_DIR, stdio: 'inherit', shell: true });

  const shutdown = () => {
    log('Shutting down…');
    backend.kill();
    frontend.kill();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Give the dev server a moment to actually start listening before we show the QR code.
  setTimeout(async () => {
    const ips = getLocalIPs();
    const localUrl = `http://localhost:${FRONTEND_PORT}`;

    console.log('\n' + '─'.repeat(56));
    console.log(`  On THIS computer (admin):  ${localUrl}`);

    if (ips.length === 0) {
      console.log('  Could not detect a local network address.');
      console.log('  Make sure this computer is connected to WiFi/ethernet');
      console.log('  if you want phones to be able to join.');
    } else {
      const phoneUrl = `http://${ips[0]}:${FRONTEND_PORT}`;
      console.log(`  For CALLERS on the same WiFi:  ${phoneUrl}`);
      if (ips.length > 1) {
        console.log(`  (other network addresses detected: ${ips.slice(1).join(', ')})`);
      }
      console.log('─'.repeat(56) + '\n');

      try {
        const qrcodeTerminal = require('qrcode-terminal');
        console.log('Scan this with a phone camera to join:\n');
        qrcodeTerminal.generate(phoneUrl, { small: true });
      } catch (e) {
        console.log('(Install "qrcode-terminal" to see a scannable QR code here.)');
      }

      try {
        const QRCode = require('qrcode');
        const qrPath = path.join(ROOT, 'join-qr.png');
        await QRCode.toFile(qrPath, phoneUrl, { width: 500 });
        log(`Also saved a scannable QR code image to: ${qrPath}`);
      } catch (e) {
        // Non-fatal — terminal QR code above still works.
      }
    }

    console.log('\nPress Ctrl+C to stop both servers.\n');
    openBrowser(localUrl);
  }, 3500);
}

main();
