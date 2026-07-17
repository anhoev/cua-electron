const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cua', {
  run: (task, target, baseUrl) => ipcRenderer.invoke('cua:run', { task, target, baseUrl }),
  stop: () => ipcRenderer.invoke('cua:stop'),
  getConfig: () => ipcRenderer.invoke('cua:config'),
  onEvent: (cb) => {
    const listener = (_e, evt) => cb(evt);
    ipcRenderer.on('cua:event', listener);
    return () => ipcRenderer.removeListener('cua:event', listener);
  },
});
