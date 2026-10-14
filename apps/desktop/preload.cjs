const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('viewedDesktop', {
  getSecret: (name) => ipcRenderer.invoke('secret:get', name),
  setSecret: (name, value) => ipcRenderer.invoke('secret:set', name, value),
});
