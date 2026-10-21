const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('viewedDesktop', {
  getSecret: (name) => ipcRenderer.invoke('secret:get', name),
  setSecret: (name, value) => ipcRenderer.invoke('secret:set', name, value),
  git: {
    pick: () => ipcRenderer.invoke('repo:pick'),
    list: () => ipcRenderer.invoke('repo:list'),
    info: (repo) => ipcRenderer.invoke('repo:info', repo),
    run: (repo, op, a, b, c) => ipcRenderer.invoke('repo:git', repo, op, a, b, c),
  },
  ask: {
    start: (req) => ipcRenderer.invoke('ask:start', req),
    cancel: (id) => ipcRenderer.invoke('ask:cancel', id),
    onProgress: (cb) => {
      const h = (_e, p) => cb(p);
      ipcRenderer.on('ask:progress', h);
      return () => ipcRenderer.removeListener('ask:progress', h);
    },
  },
});
