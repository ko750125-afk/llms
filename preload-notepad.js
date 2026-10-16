const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('notepadApi', {
  hide: () => ipcRenderer.send('hide-notepad'),
  toggleMaximize: () => ipcRenderer.invoke('toggle-maximize-notepad'),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  copyImage: (dataUrl) => ipcRenderer.invoke('copy-image', dataUrl),
  saveTextFile: (text) => ipcRenderer.invoke('save-text-file', text),
  saveImageFile: (dataUrl) => ipcRenderer.invoke('save-image-file', dataUrl),
  sendToControlBar: (text) => ipcRenderer.invoke('send-to-control-bar', text),
});
