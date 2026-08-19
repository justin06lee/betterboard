const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('betterboard', {
  platform: process.platform,
  autosave: (json) => ipcRenderer.invoke('board:autosave', json),
  loadAutosave: () => ipcRenderer.invoke('board:load-autosave'),
  saveBoard: (json) => ipcRenderer.invoke('board:save', json),
  openBoard: () => ipcRenderer.invoke('board:open'),
  openImages: () => ipcRenderer.invoke('image:open'),
  clipboardImage: () => ipcRenderer.invoke('clipboard:image'),
  clipboardText: () => ipcRenderer.invoke('clipboard:text'),
  exportPNG: (dataURL) => ipcRenderer.invoke('board:export-png', dataURL),
  confirm: (message, detail) => ipcRenderer.invoke('ui:confirm', message, detail),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, action) => cb(action)),

  aiKeyStatus: () => ipcRenderer.invoke('ai:key-status'),
  aiSetKey: (key) => ipcRenderer.invoke('ai:set-key', key),
  aiAsk: (payload) => ipcRenderer.invoke('ai:ask', payload),
  aiCancel: () => ipcRenderer.invoke('ai:cancel'),
  onAiDelta: (cb) => ipcRenderer.on('ai:delta', (_e, text) => cb(text)),
  onAiDone: (cb) => ipcRenderer.on('ai:done', () => cb()),
  onAiError: (cb) => ipcRenderer.on('ai:error', (_e, message) => cb(message)),
});
