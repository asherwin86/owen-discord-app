'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, clipboard } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const { startServer } = require('../server');

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
    local: chat ? chat.localUrl : null,
    stats: chat ? chat.stats() : { users: 0, online: 0 },
    autoLaunch: app.getLoginItemSettings().openAtLogin,
    dataDir: path.join(app.getPath('userData'), 'data'),
    update: updateState,
  };
}

function setUpdate(state) {
  updateState = state;
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
