const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('betterboard', {
  autosave: (json) => ipcRenderer.invoke('board:autosave', json),
  loadAutosave: () => ipcRenderer.invoke('board:load-autosave'),
  saveBoard: (json) => ipcRenderer.invoke('board:save', json),
  openBoard: () => ipcRenderer.invoke('board:open'),
  exportPNG: (dataURL) => ipcRenderer.invoke('board:export-png', dataURL),
  confirm: (message, detail) => ipcRenderer.invoke('ui:confirm', message, detail),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, action) => cb(action)),
});
