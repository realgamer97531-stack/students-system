// برنامج الديسكتوب: بيشغل قاعدة بيانات + نفس السيستم على الجهاز، وبيعرضه في شباك فوقه شريط المزامنة.
const {
  app, BaseWindow, BrowserWindow, WebContentsView, ipcMain, safeStorage, shell, dialog, Menu, utilityProcess, session, net,
} = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const mariadb = require('./mariadb');
const cdnCache = require('./cdn-cache');

const PROGRAM_NAME = 'Studyisfunny';
const DEFAULT_SERVER_URL = 'https://students-system-production-6b89.up.railway.app';
const TOOLBAR_HEIGHT = 56;

// للاختبار بس: فولدر بيانات منفصل
if (process.env.STUDYISFUNNY_USER_DATA) app.setPath('userData', process.env.STUDYISFUNNY_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'staging');
const userData = app.getPath('userData');
const dataRoot = mariadb.safeRoot(userData, PROGRAM_NAME);
const logsDir = path.join(userData, 'logs');
fs.mkdirSync(logsDir, { recursive: true });
const configFile = path.join(userData, 'config.json');

let mainWindow = null;
let toolbarView = null;
let contentView = null;
let setupWindow = null;
let problemsWindow = null;
let serverProcess = null;
let appPort = null;
let controlSecret = crypto.randomBytes(24).toString('hex');
let quitting = false;
let lastStatus = null;
let updateState = { state: 'idle' };

function logMain(message) {
  fs.appendFileSync(path.join(logsDir, 'main.log'), `[${new Date().toISOString()}] ${message}\n`);
}

// ===== الإعدادات (الأسرار متشفرة بحساب ويندوز) =====
function readConfig() {
  try { return JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch (e) { return {}; }
}
function writeConfig(config) {
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
}
function seal(value) {
  return safeStorage.encryptString(value).toString('base64');
}
function unseal(value) {
  return value ? safeStorage.decryptString(Buffer.from(value, 'base64')) : null;
}
function secret(config, key, length) {
  if (!config[key]) {
    config[key] = seal(crypto.randomBytes(length).toString('hex'));
    writeConfig(config);
  }
  return unseal(config[key]);
}

// ===== الشباك الرئيسي =====
function sendToolbar(channel, payload) {
  if (toolbarView && !toolbarView.webContents.isDestroyed()) toolbarView.webContents.send(channel, payload);
}

function layout() {
  if (!mainWindow) return;
  const { width, height } = mainWindow.getContentBounds();
  toolbarView.setBounds({ x: 0, y: 0, width, height: TOOLBAR_HEIGHT });
  contentView.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width, height: Math.max(0, height - TOOLBAR_HEIGHT) });
}

function isAppUrl(url) {
  return appPort && url.startsWith(`http://127.0.0.1:${appPort}`);
}

function createMainWindow() {
  mainWindow = new BaseWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: PROGRAM_NAME,
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    show: false,
  });

  toolbarView = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true } });
  contentView = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true } });
  mainWindow.contentView.addChildView(contentView);
  mainWindow.contentView.addChildView(toolbarView);
  toolbarView.webContents.loadFile(path.join(__dirname, 'toolbar.html'));
  contentView.webContents.loadFile(path.join(__dirname, 'loading.html'));
  mainWindow.on('resize', layout);
  mainWindow.on('maximize', layout);
  mainWindow.on('unmaximize', layout);
  mainWindow.show();
  mainWindow.maximize();
  layout();

  const wc = contentView.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: path.join(__dirname, 'icon.png') } };
    }
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    if (!isAppUrl(url) && !url.startsWith('file:') && /^https?:/i.test(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  wc.on('did-navigate', () => sendToolbar('nav-state', navState()));
  wc.on('did-navigate-in-page', () => sendToolbar('nav-state', navState()));
  wc.on('context-menu', (event, params) => {
    const items = [];
    if (params.isEditable) items.push({ role: 'cut', label: 'قص' }, { role: 'copy', label: 'نسخ' }, { role: 'paste', label: 'لصق' }, { role: 'selectAll', label: 'تحديد الكل' });
    else if (params.selectionText) items.push({ role: 'copy', label: 'نسخ' });
    if (items.length) Menu.buildFromTemplate(items).popup();
  });

  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      shutdownAndQuit();
    }
  });
}

function navState() {
  const history = contentView.webContents.navigationHistory;
  return { canGoBack: history.canGoBack(), canGoForward: history.canGoForward() };
}

function setLoadingMessage(message, isError) {
  if (contentView && !contentView.webContents.isDestroyed()) contentView.webContents.send('loading-message', { message, isError: Boolean(isError) });
}

// ===== التسجيل أول مرة =====
function showSetup() {
  return new Promise((resolve) => {
    setupWindow = new BrowserWindow({
      width: 560,
      height: 640,
      resizable: false,
      title: `${PROGRAM_NAME} — تسجيل الجهاز`,
      icon: path.join(__dirname, 'icon.png'),
      autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
    });
    setupWindow.loadFile(path.join(__dirname, 'setup.html'));
    setupWindow.on('closed', () => {
      setupWindow = null;
      resolve(Boolean(readConfig().deviceToken));
    });
  });
}

ipcMain.handle('setup:defaults', () => ({
  serverUrl: readConfig().serverUrl || DEFAULT_SERVER_URL,
  deviceName: os.hostname(),
  version: app.getVersion(),
}));

ipcMain.handle('setup:register', async (event, { serverUrl, username, password, deviceName }) => {
  const url = String(serverUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(url)) return { success: false, message: 'عنوان السيرفر لازم يبدأ بـ https://' };
  try {
    const response = await net.fetch(`${url}/api/sync/register-device`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password, device_name: deviceName, app_version: app.getVersion() }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.success) return { success: false, message: body.message || `السيرفر رد بخطأ (${response.status})` };
    const config = readConfig();
    config.serverUrl = url;
    config.deviceName = body.deviceName;
    config.deviceToken = seal(body.token);
    writeConfig(config);
    setTimeout(() => setupWindow && setupWindow.close(), 300);
    return { success: true };
  } catch (error) {
    return { success: false, message: `مش قادر يوصل للسيرفر — اتأكد إن النت شغال (${error.message})` };
  }
});

// ===== تشغيل السيستم =====
async function startSystem() {
  const config = readConfig();
  const dbPassword = secret(config, 'dbPassword', 16);
  const outboxKey = secret(config, 'outboxKey', 32);
  const sessionSecret = secret(config, 'sessionSecret', 32);

  setLoadingMessage('بيشغل قاعدة البيانات على الجهاز...');
  const db = await mariadb.start({
    resourcesMariaDB: path.join(resources, 'mariadb'),
    dataRoot,
    password: dbPassword,
    preferredPort: config.dbPort || 33406,
    logFile: path.join(logsDir, 'mariadb.log'),
  });
  if (config.dbPort !== db.port) { config.dbPort = db.port; writeConfig(config); }

  appPort = await pickAppPort(config.appPort || 43180);
  if (config.appPort !== appPort) { config.appPort = appPort; writeConfig(config); }

  const serverDir = path.join(resources, 'server');
  const serverLog = fs.openSync(path.join(logsDir, 'server.log'), 'a');
  serverProcess = utilityProcess.fork(path.join(serverDir, 'desktop', 'runtime', 'bootstrap.js'), [], {
    cwd: serverDir,
    serviceName: `${PROGRAM_NAME} Server`,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      SystemRoot: process.env.SystemRoot,
      SystemDrive: process.env.SystemDrive,
      PATH: process.env.PATH,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      USERPROFILE: process.env.USERPROFILE,
      APPDATA: process.env.APPDATA,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      ComSpec: process.env.ComSpec,
      DB_HOST: '127.0.0.1',
      DB_PORT: String(db.port),
      DB_USER: 'root',
      DB_PASSWORD: dbPassword,
      DB_NAME: 'studyisfunny_local',
      DESKTOP_META_DB: 'studyisfunny_desktop',
      PORT: String(appPort),
      SESSION_SECRET: sessionSecret,
      JWT_SECRET: sessionSecret,
      SYNC_SERVER_URL: config.serverUrl,
      SYNC_DEVICE_TOKEN: unseal(config.deviceToken),
      DESKTOP_CONTROL_SECRET: controlSecret,
      DESKTOP_OUTBOX_KEY: outboxKey,
      APP_VERSION: app.getVersion(),
      CENTER_LEDGER_PATH: path.join(userData, 'center-recharge-ledger.json'),
    },
  });
  serverProcess.stdout.on('data', chunk => fs.writeSync(serverLog, chunk));
  serverProcess.stderr.on('data', chunk => fs.writeSync(serverLog, chunk));
  serverProcess.on('message', handleServerMessage);
  serverProcess.on('exit', (code) => {
    logMain(`server process exited with code ${code}`);
    serverProcess = null;
    if (!quitting) {
      setLoadingMessage('السيستم وقف فجأة — هيتقفل البرنامج، افتحه تاني. لو المشكلة اتكررت ابعت فولدر السجلات.', true);
      dialog.showMessageBox({ type: 'error', title: PROGRAM_NAME, message: 'السيستم وقف فجأة. البرنامج هيتقفل، افتحه تاني.\nالعمليات اللي ماترفعتش محفوظة على الجهاز ومش هتضيع.' })
        .then(() => shutdownAndQuit());
    }
  });
}

async function pickAppPort(preferred) {
  const netModule = require('net');
  for (let port = preferred; port < preferred + 50; port++) {
    const free = await new Promise((resolve) => {
      const server = netModule.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => server.close(() => resolve(true)));
      server.listen(port, '127.0.0.1');
    });
    if (free) return port;
  }
  throw new Error('مفيش بورت فاضي للسيستم');
}

function handleServerMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'progress') setLoadingMessage(message.message, message.error);
  if (message.type === 'status') {
    lastStatus = message.status;
    sendToolbar('status', lastStatus);
  }
  if (message.type === 'ready') {
    contentView.webContents.loadURL(`http://127.0.0.1:${appPort}/login`);
    pollStatus();
    setTimeout(reportFinishedUpdate, 2500);
    setTimeout(() => checkForUpdates(false), 15000);
    setInterval(() => checkForUpdates(false), 6 * 60 * 60 * 1000);
  }
  if (message.type === 'fatal') setLoadingMessage(`مشكلة في التشغيل: ${message.message}`, true);
}

async function control(method, urlPath) {
  const response = await net.fetch(`http://127.0.0.1:${appPort}/__desktop${urlPath}`, {
    method,
    headers: { 'x-desktop-control': controlSecret },
  });
  return response.json();
}

function pollStatus() {
  const tick = async () => {
    try {
      lastStatus = await control('GET', '/status');
      sendToolbar('status', lastStatus);
    } catch (e) { /* server busy */ }
    if (!quitting) setTimeout(tick, 3000);
  };
  tick();
}

// ===== أزرار الشريط =====
ipcMain.handle('sync:pull', async () => {
  try {
    const result = await control('POST', '/pull?full=1');
    if (result.skipped === 'pending-uploads') {
      return { success: false, message: 'فيه عمليات على الجهاز لسه ماترفعتش (مفيش نت؟). لازم تترفع الأول قبل التنزيل عشان متضيعش.' };
    }
    if (result.success === false) return { success: false, message: result.message || 'التنزيل فشل — اتأكد إن النت شغال' };
    return { success: true };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('sync:push', async () => {
  try {
    const result = await control('POST', '/push');
    if (result.offline) return { success: false, message: 'مفيش اتصال بالسيرفر دلوقتي — العمليات محفوظة على الجهاز وهتترفع لوحدها أول ما النت يرجع.' };
    return { success: true, ...result };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('nav', (event, action) => {
  const wc = contentView.webContents;
  if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  if (action === 'reload') wc.reload();
  if (action === 'home' && appPort) wc.loadURL(`http://127.0.0.1:${appPort}/sessions`);
  return navState();
});

ipcMain.handle('problems:open', () => {
  if (problemsWindow) { problemsWindow.focus(); return; }
  problemsWindow = new BrowserWindow({
    width: 980,
    height: 680,
    title: 'عمليات السيرفر رفضها',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  problemsWindow.loadFile(path.join(__dirname, 'problems.html'));
  problemsWindow.on('closed', () => { problemsWindow = null; });
});
ipcMain.handle('problems:list', async () => (await control('GET', '/problems')).problems || []);
ipcMain.handle('problems:dismiss', (event, seq) => control('POST', `/problems/${Number(seq)}/dismiss`));
ipcMain.handle('problems:retry', (event, seq) => control('POST', `/problems/${Number(seq)}/retry`));

ipcMain.handle('settings:open', async () => {
  const config = readConfig();
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: PROGRAM_NAME,
    message: `${PROGRAM_NAME} — إصدار ${app.getVersion()}`,
    detail: `اسم الجهاز: ${config.deviceName || '-'}\nالسيرفر: ${config.serverUrl || '-'}\nالبيانات محفوظة في: ${dataRoot}`,
    buttons: ['تمام', 'فتح فولدر السجلات', 'إعادة تسجيل الجهاز'],
    cancelId: 0,
  });
  if (response === 1) shell.openPath(logsDir);
  if (response === 2) {
    const confirm = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: PROGRAM_NAME,
      message: 'إعادة تسجيل الجهاز',
      detail: 'هتحتاج يوزر وباسورد أدمن تاني. البيانات اللي على الجهاز والعمليات اللي ماترفعتش مش هتتمسح.',
      buttons: ['إلغاء', 'إعادة التسجيل'],
      cancelId: 0,
    });
    if (confirm.response === 1) {
      delete config.deviceToken;
      writeConfig(config);
      app.relaunch();
      shutdownAndQuit();
    }
  }
});

ipcMain.handle('status:get', () => ({ status: lastStatus, update: updateState, version: app.getVersion() }));

// ===== التحديثات (من GitHub Releases) =====
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.logger = { info: logMain, warn: logMain, error: logMain, debug: () => {} };

function setUpdateState(state) {
  updateState = state;
  sendToolbar('update', updateState);
}

autoUpdater.on('checking-for-update', () => setUpdateState({ state: 'checking' }));
autoUpdater.on('update-available', info => setUpdateState({ state: 'available', version: info.version }));
autoUpdater.on('update-not-available', () => setUpdateState({ state: 'latest' }));
autoUpdater.on('download-progress', progress => setUpdateState({ state: 'downloading', percent: Math.round(progress.percent) }));
autoUpdater.on('update-downloaded', info => setUpdateState({ state: 'downloaded', version: info.version }));
let manualCheck = false;
function friendlyUpdateError(error) {
  const text = String((error && (error.stack || error.message)) || '');
  if (/404|No published versions|Cannot find latest/i.test(text)) return 'مفيش تحديثات منشورة لسه';
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ERR_INTERNET|ERR_NAME|net::/i.test(text)) return 'مفيش اتصال بالإنترنت — جرب تاني لما النت يرجع';
  return 'تعذر التحقق من التحديثات دلوقتي';
}
// لو الفحص تلقائي وفشل (مثلاً مفيش نت) مش بنزعج حد برسالة
autoUpdater.on('error', (error) => {
  logMain(`update error: ${error && error.message}`);
  if (updateState.state === 'downloading') setUpdateState({ state: 'error', message: 'تنزيل التحديث وقف — اضغط تاني لما النت يبقى كويس' });
  else setUpdateState(manualCheck ? { state: 'error', message: friendlyUpdateError(error) } : { state: 'idle' });
});

function checkForUpdates(manual) {
  manualCheck = manual;
  if (!app.isPackaged) {
    if (manual) setUpdateState({ state: 'error', message: 'التحديثات بتشتغل في النسخة المتسطبة بس' });
    return;
  }
  autoUpdater.checkForUpdates().catch(() => { /* بيتعامل معاه في autoUpdater.on('error') */ });
}

// ===== شاشة "جاري التثبيت" (عشان المستخدم يعرف إن فيه حاجة بتحصل) =====
const updateMarker = path.join(userData, 'updating.json');
let installingWindow = null;

function showInstallingWindow(version) {
  const html = `<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><style>
    body{margin:0;font-family:Segoe UI,Tahoma,sans-serif;background:#312E81;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;text-align:center}
    .s{width:46px;height:46px;border:5px solid rgba(255,255,255,.25);border-top-color:#14B8A6;border-radius:50%;animation:r 1s linear infinite;margin-bottom:18px}
    @keyframes r{to{transform:rotate(360deg)}} h2{margin:0 0 8px;font-size:20px} p{margin:0 24px;opacity:.85;line-height:1.7}
  </style></head><body><div class="s"></div><h2>جاري تثبيت التحديث ${version || ''}</h2>
  <p>البرنامج هيتقفل ثواني ويفتح لوحده خلال دقيقة تقريبًا.<br>متقفلش الجهاز. بياناتك محفوظة.</p></body></html>`;
  installingWindow = new BrowserWindow({
    width: 460, height: 260, frame: false, resizable: false, alwaysOnTop: true, center: true, skipTaskbar: false,
    title: PROGRAM_NAME, icon: path.join(__dirname, 'icon.png'),
  });
  installingWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
}

// بعد ما البرنامج يفتح تاني: نقول للمستخدم إن التحديث تم (أو إنه فشل)
function reportFinishedUpdate() {
  let marker = null;
  try { marker = JSON.parse(fs.readFileSync(updateMarker, 'utf8')); } catch (_) { return; }
  try { fs.unlinkSync(updateMarker); } catch (_) {}
  if (!marker) return;
  if (marker.version === app.getVersion()) setUpdateState({ state: 'installed', version: marker.version });
  else setUpdateState({ state: 'error', message: `تثبيت الإصدار ${marker.version} ماكملش — اضغط "تحديثات البرنامج" وجرب تاني` });
}

ipcMain.handle('update:action', async () => {
  if (updateState.state === 'available') {
    autoUpdater.downloadUpdate().catch(error => setUpdateState({ state: 'error', message: error.message }));
  } else if (updateState.state === 'downloaded') {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: PROGRAM_NAME,
      message: `تثبيت الإصدار ${updateState.version} دلوقتي؟`,
      detail: 'البرنامج هيتقفل ويتحدث ويفتح تاني لوحده (أقل من دقيقة). البيانات والعمليات اللي ماترفعتش محفوظة.',
      buttons: ['بعدين', 'ثبّت دلوقتي'],
      cancelId: 0,
    });
    if (response === 1) {
      showInstallingWindow(updateState.version);
      try { fs.writeFileSync(updateMarker, JSON.stringify({ version: updateState.version, at: Date.now() })); } catch (_) {}
      await shutdownAndQuit({ install: true });
    }
  } else if (updateState.state !== 'downloading' && updateState.state !== 'checking') {
    checkForUpdates(true);
  }
  return updateState;
});

// ===== القفل =====
let shuttingDown = null;
function shutdownAndQuit({ install = false } = {}) {
  if (shuttingDown) return shuttingDown;
  quitting = true;
  shuttingDown = (async () => {
    try {
      if (serverProcess) {
        const proc = serverProcess;
        const exited = new Promise(resolve => proc.once('exit', resolve));
        proc.kill();
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
      }
      await mariadb.stop();
    } catch (error) {
      logMain(`shutdown error: ${error.stack || error.message}`);
    }
    if (install) {
      autoUpdater.quitAndInstall(true, true);
    } else {
      app.exit(0);
    }
  })();
  return shuttingDown;
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => { /* بنقفل بنفسنا في shutdownAndQuit */ });

app.whenReady().then(async () => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{
    label: 'عرض',
    submenu: [
      { role: 'reload', label: 'إعادة تحميل' },
      { role: 'zoomIn', label: 'تكبير' },
      { role: 'zoomOut', label: 'تصغير' },
      { role: 'resetZoom', label: 'الحجم الأصلي' },
      { role: 'toggleDevTools', label: 'أدوات المطور' },
    ],
  }]));

  cdnCache.install({ bundledDir: path.join(resources, 'cdn'), runtimeDir: path.join(userData, 'cdn-cache') });

  // الكاميرا لازمة لصفحات مسح الـ QR
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(['media', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen'].includes(permission));
  });

  if (!readConfig().deviceToken) {
    const registered = await showSetup();
    if (!registered) {
      app.exit(0);
      return;
    }
  }

  createMainWindow();
  try {
    await startSystem();
  } catch (error) {
    logMain(`start error: ${error.stack || error.message}`);
    setLoadingMessage(`البرنامج مقدرش يشتغل: ${error.message}`, true);
  }
});

process.on('uncaughtException', (error) => logMain(`uncaught: ${error.stack || error.message}`));
