'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');
const { startServer } = require('../server');

// Where the app keeps its data (accounts, messages, certificate, logs, caches).
// A pointer file in the default folder can move it, e.g. to another drive:
//   %APPDATA%\LanChat Host\location.json  ->  { "userData": "E:\\LanChat Data" }
// Must run before anything touches userData (single-instance lock, server, ...).
// The rule: if a pointer file exists, the app runs on that folder or not at all.
// It never falls back to the default folder, which would silently run a second,
// empty database (e.g. one copy on C: and one on E:).
// (LANCHAT_POINTER_DIR / LANCHAT_DRIVE_WAIT_MS exist so this can be tested.)
{
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const fatal = (msg) => {
    require('electron').dialog.showErrorBox('LanChat Host', msg);
    process.exit(1);
  };
  const pointer = path.join(process.env.LANCHAT_POINTER_DIR || path.join(app.getPath('appData'), 'LanChat Host'), 'location.json');

  let target = null;
  if (fs.existsSync(pointer)) {
    // Retry: a virus scanner or sync tool can briefly lock the file.
    for (let i = 0; i < 5 && !target; i++) {
      try {
        const t = JSON.parse(fs.readFileSync(pointer, 'utf8')).userData;
        if (typeof t === 'string' && t.trim()) target = t;
      } catch { /* try again */ }
      if (!target) sleep(300);
    }
    if (!target) fatal(`Could not read the data folder location from:\n${pointer}\n\nFix or delete that file, then start the app again.`);
  }

  if (target) {
    // At Windows login a secondary drive can take a while to appear, so wait for it.
    const root = path.parse(target).root;
    const giveUp = Date.now() + Number(process.env.LANCHAT_DRIVE_WAIT_MS || 90_000);
    while (!fs.existsSync(root) && Date.now() < giveUp) sleep(1000);
    if (!fs.existsSync(root)) fatal(`The data folder is on a drive that isn't available:\n${target}\n\nConnect it and start the app again.`);

    try { fs.mkdirSync(target, { recursive: true }); } catch (e) { fatal(`Could not open the data folder:\n${target}\n\n${e.message}`); }
    app.setPath('userData', target);
    // Belt and braces: make sure Electron really adopted it before anything uses it.
    if (path.resolve(app.getPath('userData')).toLowerCase() !== path.resolve(target).toLowerCase()) {
      fatal(`The data folder could not be applied:\n${target}`);
    }
  }
}

const PORT = 3000;
const startHidden = process.argv.includes('--hidden');

let win = null;
let tray = null;
let chat = null;          // running server handle
let quitting = false;
let updateState = { status: app.isPackaged ? 'idle' : 'dev', message: app.isPackaged ? '' : 'Updates are only checked in the installed app.' };

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else app.on('second-instance', showWindow);

function hostInfo() {
  return {
    version: app.getVersion(),
    port: chat ? chat.port : null,
    urls: chat ? chat.urls() : [],
    secureUrls: chat ? chat.secureUrls() : [],
    local: chat ? chat.localUrl : null,
    stats: chat ? chat.stats() : { users: 0, online: 0 },
    autoLaunch: app.getLoginItemSettings().openAtLogin,
    dataDir: path.join(app.getPath('userData'), 'data'),
    update: updateState,
  };
}

function logUpdate(line) {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'updater.log'), `${new Date().toISOString()} ${line}\n`); } catch { /* ignore */ }
}

function setUpdate(state) {
  updateState = state;
  logUpdate(`${state.status}: ${state.message}`);
  if (win && !win.isDestroyed()) win.webContents.send('update', state);
}

function showWindow() {
  if (!win) createWindow();
  else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
}

function createWindow() {
  win = new BrowserWindow({
    width: 560, height: 640, minWidth: 440, minHeight: 480,
    title: 'LanChat Host',
    backgroundColor: '#1e1f22',
    autoHideMenuBar: true,
    show: !startHidden,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, 'host.html'));
  // Closing the window keeps the server running in the tray.
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => { win = null; });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('LanChat Host - server running');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show host window', click: showWindow },
    { label: 'Open chat in browser', click: () => chat && shell.openExternal(chat.localUrl) },
    { type: 'separator' },
    { label: 'Quit (stops the server)', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

// ---------- auto update ----------
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // testing aid: point the updater at any folder served over http instead of GitHub
  if (process.env.LANCHAT_UPDATE_URL) autoUpdater.setFeedURL({ provider: 'generic', url: process.env.LANCHAT_UPDATE_URL });
  logUpdate(`starting v${app.getVersion()}, feed: ${process.env.LANCHAT_UPDATE_URL || 'GitHub releases'}`);
  autoUpdater.on('checking-for-update', () => setUpdate({ status: 'checking', message: 'Checking for updates...' }));
  autoUpdater.on('update-available', (i) => setUpdate({ status: 'downloading', message: `Downloading v${i.version}...` }));
  autoUpdater.on('update-not-available', () => setUpdate({ status: 'idle', message: 'You are up to date.' }));
  autoUpdater.on('download-progress', (p) => setUpdate({ status: 'downloading', message: `Downloading update... ${Math.round(p.percent)}%` }));
  autoUpdater.on('update-downloaded', (i) => setUpdate({ status: 'ready', message: `v${i.version} is ready to install.` }));
  autoUpdater.on('error', (e) => setUpdate({ status: 'error', message: 'Update check failed: ' + (e && e.message ? e.message.split('\n')[0] : e) }));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 4 * 60 * 60 * 1000);
}

ipcMain.handle('host:info', () => hostInfo());
ipcMain.handle('host:copy', (_e, text) => { clipboard.writeText(String(text)); });
ipcMain.handle('host:open', (_e, url) => { if (/^http:\/\/(localhost|\d+\.\d+\.\d+\.\d+):\d+$/.test(url)) shell.openExternal(url); });
ipcMain.handle('host:autolaunch', (_e, on) => {
  app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] });
  return app.getLoginItemSettings().openAtLogin;
});
ipcMain.handle('host:check-update', () => {
  if (!app.isPackaged) return;
  autoUpdater.checkForUpdates().catch(() => {});
});
ipcMain.handle('host:install-update', () => {
  quitting = true;
  autoUpdater.quitAndInstall(false, true);
});

app.whenReady().then(async () => {
  if (!gotLock) return;
  try {
    chat = await startServer({ port: PORT, dataDir: path.join(app.getPath('userData'), 'data') });
  } catch (e) {
    require('electron').dialog.showErrorBox('LanChat Host', 'Could not start the server:\n' + e.message);
    app.quit();
    return;
  }
  createTray();
  createWindow();
  setupAutoUpdate();
});

app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { if (chat) chat.close(); });
// keep running in tray when all windows are closed
app.on('window-all-closed', () => {});
