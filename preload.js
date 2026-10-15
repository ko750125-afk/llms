const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  send: (text, targets) => ipcRenderer.invoke('send-prompt', { text, targets }),
  newChat: () => ipcRenderer.send('new-chat'),
  resetLayout: () => ipcRenderer.invoke('reset-layout'),
  moveMonitor: () => ipcRenderer.invoke('move-monitor'),
});
