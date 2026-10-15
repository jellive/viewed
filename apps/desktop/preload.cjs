const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('viewedDesktop', {
  getSecret: (name) => ipcRenderer.invoke('secret:get', name),
  setSecret: (name, value) => ipcRenderer.invoke('secret:set', name, value),
  git: {
    pick: () => ipcRenderer.invoke('repo:pick'),
    list: () => ipcRenderer.invoke('repo:list'),
    info: (repo) => ipcRenderer.invoke('repo:info', repo),
    run: (repo, op, a, b) => ipcRenderer.invoke('repo:git', repo, op, a, b),
  },
});
