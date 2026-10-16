const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  hide: () => ipcRenderer.send('hide-settings'),
  toggleMaximize: () => ipcRenderer.invoke('toggle-maximize-settings'),
  getSites: () => ipcRenderer.invoke('get-sites'),
  saveSites: (sites) => ipcRenderer.invoke('save-sites', sites),
  getSkills: () => ipcRenderer.invoke('get-skills'),
  saveSkills: (skills) => ipcRenderer.invoke('save-skills', skills),
});
