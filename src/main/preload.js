const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('betterboard', {
  platform: process.platform,
  // Set by performance runs (BETTERBOARD_BENCH=1) so a driver can reach the
  // board's internals; off for everyone else.
  bench: process.env.BETTERBOARD_BENCH === '1',
  // The autosave: a folder of bucket files and a manifest the main process
  // keeps. See src/renderer/persist.ts.
  storeLoad: () => ipcRenderer.invoke('store:load'),
  storeRead: (name) => ipcRenderer.invoke('store:read', name),
  storeReadText: (name) => ipcRenderer.invoke('store:read-text', name),
  storePut: (name, data) => ipcRenderer.invoke('store:put', name, data),
  storeCommit: (manifest) => ipcRenderer.invoke('store:commit', manifest),
  storeQuarantine: () => ipcRenderer.invoke('store:quarantine'),
  // Board files go back and forth in pieces, so no board is ever one string.
  fileReadBegin: (kind) => ipcRenderer.invoke('file:read-begin', kind),
  fileRead: (token, max) => ipcRenderer.invoke('file:read', token, max),
  fileReadEnd: (token) => ipcRenderer.invoke('file:read-end', token),
  fileWriteBegin: () => ipcRenderer.invoke('file:write-begin'),
  fileWrite: (token, text) => ipcRenderer.invoke('file:write', token, text),
  fileWriteEnd: (token, ok) => ipcRenderer.invoke('file:write-end', token, ok),
  // The window asks for a last save before it closes.
  onFlush: (cb) => ipcRenderer.on('app:flush', () => cb()),
  flushed: () => ipcRenderer.send('app:flushed'),
  openImages: () => ipcRenderer.invoke('image:open'),
  clipboardImage: () => ipcRenderer.invoke('clipboard:image'),
  clipboardText: () => ipcRenderer.invoke('clipboard:text'),
  clipboardWriteImage: (dataURL, text) => ipcRenderer.invoke('clipboard:write-image', dataURL, text),
  clipboardWriteText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
  loadStickers: () => ipcRenderer.invoke('stickers:load'),
  saveStickers: (stickers) => ipcRenderer.invoke('stickers:save', stickers),
  exportPNG: (dataURL) => ipcRenderer.invoke('board:export-png', dataURL),
  exportAnimation: (bytes, format) => ipcRenderer.invoke('board:export-animation', bytes, format),
  confirm: (message, detail) => ipcRenderer.invoke('ui:confirm', message, detail),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, action) => cb(action)),

  aiConnections: () => ipcRenderer.invoke('ai:connections'),
  aiLocalProviders: () => ipcRenderer.invoke('ai:local-providers'),
  aiSaveConnection: (connection) => ipcRenderer.invoke('ai:save-connection', connection),
  aiSetActive: (id) => ipcRenderer.invoke('ai:set-active', id),
  aiDeleteConnection: (id) => ipcRenderer.invoke('ai:delete-connection', id),
  aiAsk: (payload) => ipcRenderer.invoke('ai:ask', payload),
  aiCancel: () => ipcRenderer.invoke('ai:cancel'),
  onAiDelta: (cb) => ipcRenderer.on('ai:delta', (_e, text) => cb(text)),
  onAiDone: (cb) => ipcRenderer.on('ai:done', () => cb()),
  onAiError: (cb) => ipcRenderer.on('ai:error', (_e, message) => cb(message)),
  onAiDraw: (cb) => ipcRenderer.on('ai:draw', (_e, payload) => cb(payload)),
});
