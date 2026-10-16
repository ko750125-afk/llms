const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  send: (text, targets) => ipcRenderer.invoke('send-prompt', { text, targets }),
  newChat: () => ipcRenderer.send('new-chat'),
  resetLayout: () => ipcRenderer.invoke('reset-layout'),
  moveMonitor: () => ipcRenderer.invoke('move-monitor'),
  minimizeAll: () => ipcRenderer.invoke('minimize-all'),
  closeAll: () => ipcRenderer.invoke('close-all'),
  toggleNotepad: () => ipcRenderer.invoke('toggle-notepad'),
  onSetPrompt: (callback) => ipcRenderer.on('set-prompt', (_e, text) => callback(text)),
  openExplorer: () => ipcRenderer.invoke('open-explorer'),
  openUrl: (url) => ipcRenderer.invoke('open-url', url),
  setBarHeight: (expanded) => ipcRenderer.invoke('set-bar-height', expanded),
  toggleSettings: () => ipcRenderer.invoke('toggle-settings'),
  getSkills: () => ipcRenderer.invoke('get-skills'),
  getSites: () => ipcRenderer.invoke('get-sites'),
  onSyncData: (callback) => ipcRenderer.on('sync-data', (_e, data) => callback(data)),
});

