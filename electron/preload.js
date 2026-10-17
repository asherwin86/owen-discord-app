'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('host', {
  info: () => ipcRenderer.invoke('host:info'),
  copy: (t) => ipcRenderer.invoke('host:copy', t),
  open: (u) => ipcRenderer.invoke('host:open', u),
  setAutoLaunch: (on) => ipcRenderer.invoke('host:autolaunch', on),
  checkUpdate: () => ipcRenderer.invoke('host:check-update'),
  installUpdate: () => ipcRenderer.invoke('host:install-update'),
  onUpdate: (cb) => ipcRenderer.on('update', (_e, s) => cb(s)),
});
