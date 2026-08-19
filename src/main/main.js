const { app, BrowserWindow, Menu, clipboard, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

app.setName('BetterBoard');

const isMac = process.platform === 'darwin';

const userData = () => app.getPath('userData');
const autosavePath = () => path.join(userData(), 'autosave.json');
const windowStatePath = () => path.join(userData(), 'window.json');
const settingsPath = () => path.join(userData(), 'settings.json');

let win = null;

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function createWindow() {
  const saved = readJSON(windowStatePath());
  win = new BrowserWindow({
    width: saved?.width ?? 1440,
    height: saved?.height ?? 900,
    x: saved?.x,
    y: saved?.y,
    minWidth: 720,
    minHeight: 480,
    ...(isMac ? { titleBarStyle: 'hiddenInset' } : {}),
    backgroundColor: '#15161a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });

  win.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'));

  win.on('close', () => {
    try {
      fs.writeFileSync(windowStatePath(), JSON.stringify(win.getBounds()));
    } catch {}
  });
  win.on('closed', () => {
    win = null;
  });
}

function send(action) {
  win?.webContents.send('menu', action);
}

function buildMenu() {
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Board', accelerator: 'CmdOrCtrl+N', click: () => send('new') },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
        { type: 'separator' },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: 'Export PNG…', accelerator: 'CmdOrCtrl+E', click: () => send('export') },
        { type: 'separator' },
        { label: 'Insert Image…', accelerator: 'CmdOrCtrl+Shift+I', click: () => send('insert-image') },
        { type: 'separator' },
        { label: 'Ask Claude About a Region', accelerator: 'CmdOrCtrl+Alt+A', click: () => send('ask-region') },
        { label: 'Claude API Key…', click: () => send('ai-key') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: () => send('redo') },
        { type: 'separator' },
        { type: 'separator' },
        // Chromium only runs its own paste for editable targets, so pressing
        // Cmd+V over the canvas fires nothing at all. This routes it to the
        // renderer, which reads the clipboard through the main process.
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: () => send('paste') },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Clear Frame', accelerator: 'CmdOrCtrl+Backspace', click: () => send('clear') },
      ],
    },
    {
      label: 'Animate',
      submenu: [
        // Plain Return / arrows are handled in the renderer instead: as menu
        // accelerators they would be swallowed app-wide and break typing in
        // the rename and fps fields.
        { label: 'Play / Pause', accelerator: 'CmdOrCtrl+Return', click: () => send('play') },
        { type: 'separator' },
        { label: 'New Frame', accelerator: 'CmdOrCtrl+Alt+F', click: () => send('frame-new') },
        { label: 'Duplicate Frame', accelerator: 'CmdOrCtrl+Alt+D', click: () => send('frame-duplicate') },
        { label: 'Delete Frame', click: () => send('frame-delete') },
        { type: 'separator' },
        { label: 'Previous Frame', accelerator: 'CmdOrCtrl+Alt+Left', click: () => send('frame-prev') },
        { label: 'Next Frame', accelerator: 'CmdOrCtrl+Alt+Right', click: () => send('frame-next') },
        { type: 'separator' },
        { label: 'Onion Skin', accelerator: 'CmdOrCtrl+Alt+O', click: () => send('toggle-onion') },
        { label: 'Timeline', accelerator: 'CmdOrCtrl+T', click: () => send('toggle-timeline') },
      ],
    },
    {
      label: 'Layer',
      submenu: [
        { label: 'New Layer', accelerator: 'CmdOrCtrl+Alt+N', click: () => send('layer-new') },
        { label: 'Delete Layer', accelerator: 'CmdOrCtrl+Alt+Backspace', click: () => send('layer-delete') },
        { type: 'separator' },
        { label: 'Hide/Show Layer', accelerator: 'CmdOrCtrl+Alt+H', click: () => send('layer-toggle-visible') },
        { label: 'Layers Panel', accelerator: 'CmdOrCtrl+L', click: () => send('toggle-layers') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => send('zoom-in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => send('zoom-out') },
        { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', click: () => send('zoom-reset') },
        { label: 'Zoom to Fit', accelerator: 'CmdOrCtrl+1', click: () => send('zoom-fit') },
        { label: 'Normalize Zoom', accelerator: 'Shift+CmdOrCtrl+N', click: () => send('normalize') },
        { type: 'separator' },
        { label: 'Toggle Dot Grid', accelerator: 'CmdOrCtrl+G', click: () => send('toggle-grid') },
        { label: 'Toggle Light/Dark Board', accelerator: 'Shift+CmdOrCtrl+L', click: () => send('toggle-theme') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- Claude ---------------------------------------------------------------
// The request lives in the main process rather than the renderer: the
// renderer's CSP allows no external origins, and the key stays out of page
// context entirely. It is read from disk per request and never logged, echoed
// back, or sent anywhere but the API.

const { askClaude } = require('./claude');

// Overridable so the request path can be pointed at a local server under test.
const API_URL = process.env.BETTERBOARD_API_URL || undefined;

function readKey() {
  return readJSON(settingsPath())?.anthropicKey ?? '';
}

function writeSettings(patch) {
  const current = readJSON(settingsPath()) ?? {};
  fs.writeFileSync(settingsPath(), JSON.stringify({ ...current, ...patch }), { mode: 0o600 });
  try {
    fs.chmodSync(settingsPath(), 0o600); // an existing file keeps its old mode
  } catch {}
}

let inFlight = null;

function aiSend(channel, payload) {
  win?.webContents.send(channel, payload);
}

async function runAsk({ messages, model }) {
  inFlight?.abort();
  const controller = new AbortController();
  inFlight = controller;
  await askClaude({
    url: API_URL,
    key: readKey(),
    model,
    messages,
    signal: controller.signal,
    onDelta: (text) => aiSend('ai:delta', text),
    onError: (message) => aiSend('ai:error', message),
    onDone: () => aiSend('ai:done'),
  });
  if (inFlight === controller) inFlight = null;
}

function registerIpc() {
  // Only ever reports whether a key exists and its last four characters, so the
  // secret itself never travels back into the renderer.
  ipcMain.handle('ai:key-status', () => {
    const key = readKey();
    return { set: key.length > 0, hint: key ? key.slice(-4) : '' };
  });

  ipcMain.handle('ai:set-key', (_e, key) => {
    writeSettings({ anthropicKey: typeof key === 'string' ? key.trim() : '' });
    const stored = readKey();
    return { set: stored.length > 0, hint: stored ? stored.slice(-4) : '' };
  });

  ipcMain.handle('ai:ask', (_e, payload) => {
    void runAsk(payload);
  });

  ipcMain.handle('ai:cancel', () => {
    inFlight?.abort();
    inFlight = null;
  });

  ipcMain.handle('board:autosave', (_e, json) => {
    fs.writeFileSync(autosavePath(), json);
  });

  ipcMain.handle('board:load-autosave', () => {
    try {
      return fs.readFileSync(autosavePath(), 'utf8');
    } catch {
      return null;
    }
  });

  ipcMain.handle('board:save', async (_e, json) => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: 'board.betterboard.json',
      filters: [{ name: 'BetterBoard', extensions: ['json'] }],
    });
    if (canceled || !filePath) return false;
    fs.writeFileSync(filePath, json);
    return true;
  });

  ipcMain.handle('board:open', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'BetterBoard', extensions: ['json'] }],
    });
    if (canceled || filePaths.length === 0) return null;
    return fs.readFileSync(filePaths[0], 'utf8');
  });

  // Returns data URLs rather than paths: the renderer embeds pictures in the
  // board, and this way it never needs filesystem access of its own.
  // The renderer has no clipboard access of its own worth relying on: a page
  // that is not editable never sees a paste event.
  ipcMain.handle('clipboard:image', () => {
    const image = clipboard.readImage();
    return image.isEmpty() ? null : image.toDataURL();
  });

  ipcMain.handle('clipboard:text', () => clipboard.readText());

  ipcMain.handle('image:open', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
    });
    if (canceled) return [];
    const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
    const out = [];
    for (const file of filePaths) {
      const ext = path.extname(file).slice(1).toLowerCase();
      const mime = types[ext];
      if (!mime) continue;
      try {
        out.push(`data:${mime};base64,${fs.readFileSync(file).toString('base64')}`);
      } catch {}
    }
    return out;
  });

  ipcMain.handle('board:export-png', async (_e, dataURL) => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: 'board.png',
      filters: [{ name: 'PNG Image', extensions: ['png'] }],
    });
    if (canceled || !filePath) return false;
    fs.writeFileSync(filePath, Buffer.from(dataURL.split(',')[1], 'base64'));
    return true;
  });

  ipcMain.handle('ui:confirm', async (_e, message, detail) => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Cancel', 'OK'],
      defaultId: 1,
      cancelId: 0,
      message,
      detail,
    });
    return response === 1;
  });
}

app.whenReady().then(() => {
  registerIpc();
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
