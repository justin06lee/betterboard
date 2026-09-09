const { app, BrowserWindow, Menu, clipboard, ipcMain, dialog, nativeImage } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.setName('BetterBoard');

// Lets automated drivers point the app at a scratch profile, so a test run
// never touches the real autosave, window state, or settings.
if (process.env.BETTERBOARD_USER_DATA) {
  app.setPath('userData', process.env.BETTERBOARD_USER_DATA);
}

const isMac = process.platform === 'darwin';

// Finder-launched apps inherit a minimal PATH, so Yagami would miss binaries
// that work normally in the user's terminal. Recover the login-shell PATH and
// append the common user install directories before the engine is constructed.
function fixExecutablePath() {
  if (isMac) {
    try {
      const shell = process.env.SHELL || '/bin/zsh';
      const output = execFileSync(shell, ['-ilc', 'printf "__BETTERBOARD__%s__BETTERBOARD__" "$PATH"'], {
        encoding: 'utf8',
        timeout: 5000,
      });
      const match = /__BETTERBOARD__(.*)__BETTERBOARD__/s.exec(output);
      if (match?.[1]) process.env.PATH = match[1];
    } catch {}
  }
  const extra = [
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  const current = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  process.env.PATH = [...current, ...extra.filter((dir) => !current.includes(dir))].join(path.delimiter);
}

fixExecutablePath();

const userData = () => app.getPath('userData');
const autosavePath = () => path.join(userData(), 'autosave.json');
const windowStatePath = () => path.join(userData(), 'window.json');
const settingsPath = () => path.join(userData(), 'settings.json');
const stickersPath = () => path.join(userData(), 'stickers.json');

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
  const appRoot = app.getAppPath();
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
      preload: path.join(appRoot, 'src', 'main', 'preload.js'),
      contextIsolation: true,
    },
  });

  win.loadFile(path.join(appRoot, 'dist', 'index.html'));

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
        { label: 'Export Animation…', accelerator: 'Shift+CmdOrCtrl+E', click: () => send('export-animation') },
        { type: 'separator' },
        { label: 'Insert Image…', accelerator: 'CmdOrCtrl+Shift+I', click: () => send('insert-image') },
        { type: 'separator' },
        { label: 'Ask / Draw About a Region', accelerator: 'CmdOrCtrl+Alt+A', click: () => send('ask-region') },
        { label: 'Yagami Connections…', click: () => send('ai-connections') },
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
        // Chromium only runs cut/copy/paste for editable targets, so over the
        // canvas none of them fire at all. All three are routed to the renderer
        // instead, which serves the canvas or the focused text field itself.
        { label: 'Cut', accelerator: 'CmdOrCtrl+X', click: () => send('cut') },
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: () => send('copy') },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: () => send('paste') },
        { label: 'Duplicate', accelerator: 'CmdOrCtrl+D', click: () => send('duplicate') },
        { type: 'separator' },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: () => send('select-all') },
        { type: 'separator' },
        { label: 'Save Selection as Sticker', accelerator: 'Shift+CmdOrCtrl+D', click: () => send('sticker-save') },
        { label: 'Stickers', accelerator: 'CmdOrCtrl+Alt+S', click: () => send('toggle-stickers') },
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
        // No accelerator: Cmd+D is Edit ▸ Duplicate, which duplicates whatever
        // is selected and only falls through to the frame when the timeline is
        // already open. Opening the timeline is never a side effect of it.
        { label: 'Duplicate Frame', click: () => send('frame-duplicate') },
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
        {
          label: 'Toolbar Position',
          submenu: [
            { label: 'Top', click: () => send('dock-top') },
            { label: 'Left', click: () => send('dock-left') },
            { label: 'Right', click: () => send('dock-right') },
            { label: 'Bottom', click: () => send('dock-bottom') },
          ],
        },
        { label: 'Choose Workspace…', click: () => send('choose-workspace') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- Yagami connections ---------------------------------------------------
// The request lives in the main process rather than the renderer: the
// renderer's CSP allows no external origins, and the key stays out of page
// context entirely. Secrets are only reported back as a boolean and last-four
// hint; the renderer never receives a Yagami personal API key.

const crypto = require('crypto');
const { askAI, endpointFor, localProviderState } = require('./ai');

function defaultConnection() {
  return {
    id: 'embedded',
    name: 'This computer',
    kind: 'embedded',
    model: '',
    url: '',
    key: '',
  };
}

function writeSettings(patch) {
  const current = readJSON(settingsPath()) ?? {};
  fs.writeFileSync(settingsPath(), JSON.stringify({ ...current, ...patch }), { mode: 0o600 });
  try {
    fs.chmodSync(settingsPath(), 0o600); // an existing file keeps its old mode
  } catch {}
}

function readConnectionState() {
  const settings = readJSON(settingsPath()) ?? {};
  const source = Array.isArray(settings.aiConnections) && settings.aiConnections.length
    ? settings.aiConnections
    : [defaultConnection()];
  const connections = [];
  for (const raw of source) {
    const id = String(raw?.id ?? '');
    // The short-lived Yagami-only connection format represented remote
    // servers as `yagami`; preserve those settings during this migration.
    const kind = raw?.kind === 'yagami' ? 'remote' : raw?.kind;
    if ((kind !== 'embedded' && kind !== 'remote') || !id || connections.some((connection) => connection.id === id)) continue;
    connections.push({
      id,
      name: String(raw.name ?? (kind === 'embedded' ? 'This computer' : 'Yagami server')).trim().slice(0, 40)
        || (kind === 'embedded' ? 'This computer' : 'Yagami server'),
      kind,
      model: String(raw.model ?? '').trim().slice(0, 120),
      url: kind === 'remote' ? String(raw.url ?? '').trim().slice(0, 2048) : '',
      key: kind === 'remote' ? String(raw.key ?? '') : '',
    });
  }
  if (connections.length === 0) connections.push(defaultConnection());
  const active = connections.some((connection) => connection.id === settings.activeAiConnection)
    ? settings.activeAiConnection
    : connections[0].id;
  return { connections, active };
}

function publicConnectionState() {
  const { connections, active } = readConnectionState();
  return {
    active,
    connections: connections.map(({ key, ...connection }) => ({
      ...connection,
      keySet: key.length > 0,
      keyHint: key ? key.slice(-4) : '',
    })),
  };
}

function saveConnections(connections, active) {
  writeSettings({ aiConnections: connections, activeAiConnection: active });
}

function saveConnection(input) {
  const state = readConnectionState();
  const existing = state.connections.find((connection) => connection.id === input?.id);
  const kind = input?.kind === 'remote' || input?.kind === 'embedded'
    ? input.kind
    : existing?.kind ?? 'embedded';
  const fallbackName = kind === 'embedded' ? 'This computer' : 'Yagami server';
  const connection = {
    id: existing?.id ?? crypto.randomUUID(),
    name: String(input?.name ?? existing?.name ?? fallbackName).trim().slice(0, 40) || fallbackName,
    kind,
    model: String(input?.model ?? existing?.model ?? '').trim().slice(0, 120),
    url: kind === 'remote'
      ? String(input?.url ?? (existing?.kind === 'remote' ? existing.url : '') ?? '').trim().slice(0, 2048)
      : '',
    key: kind === 'remote' && !input?.clearKey
      ? (String(input?.key ?? '').trim() || (existing?.kind === 'remote' ? existing.key : '') || '')
      : '',
  };
  if (kind === 'remote' && !connection.url) throw new Error('A remote Yagami connection needs a URL.');
  if (kind === 'remote') endpointFor(connection); // validates URL and fills its API path
  const at = existing ? state.connections.indexOf(existing) : state.connections.length;
  state.connections.splice(at, existing ? 1 : 0, connection);
  saveConnections(state.connections, connection.id);
  return publicConnectionState();
}

let inFlight = null;

function aiSend(channel, payload) {
  win?.webContents.send(channel, payload);
}

async function runAsk({ connectionId, messages, requestId }) {
  inFlight?.abort();
  const controller = new AbortController();
  inFlight = controller;
  const state = readConnectionState();
  const connection = state.connections.find((item) => item.id === connectionId)
    ?? state.connections.find((item) => item.id === state.active)
    ?? state.connections[0];
  const currentSend = (channel, payload) => {
    if (inFlight === controller) aiSend(channel, payload);
  };
  await askAI({
    connection,
    messages,
    signal: controller.signal,
    onDelta: (text) => currentSend('ai:delta', text),
    onDraw: (drawing) => currentSend('ai:draw', { requestId, drawing }),
    onError: (message) => currentSend('ai:error', message),
    onDone: () => currentSend('ai:done'),
  });
  if (inFlight === controller) inFlight = null;
}

function registerIpc() {
  ipcMain.handle('ai:connections', () => publicConnectionState());
  ipcMain.handle('ai:local-providers', () => localProviderState());
  ipcMain.handle('ai:save-connection', (_e, input) => {
    try {
      return { ...saveConnection(input), error: '' };
    } catch (error) {
      return { ...publicConnectionState(), error: error?.message ?? 'Could not save that connection.' };
    }
  });
  ipcMain.handle('ai:set-active', (_e, id) => {
    const state = readConnectionState();
    if (state.connections.some((connection) => connection.id === id)) {
      saveConnections(state.connections, id);
    }
    return publicConnectionState();
  });
  ipcMain.handle('ai:delete-connection', (_e, id) => {
    const state = readConnectionState();
    const connections = state.connections.filter((connection) => connection.id !== id);
    if (connections.length === 0) connections.push(defaultConnection());
    const active = connections.some((connection) => connection.id === state.active)
      ? state.active
      : connections[0].id;
    saveConnections(connections, active);
    return publicConnectionState();
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

  ipcMain.handle('clipboard:write-text', (_e, text) => {
    clipboard.writeText(String(text ?? ''));
  });

  // Copying a selection also puts a picture of it on the system clipboard, so
  // it can be pasted into any other app. The renderer keeps the data URL it
  // wrote and compares it on paste: still there means the board's own copy is
  // the live one, gone means something else was copied since.
  ipcMain.handle('clipboard:write-image', (_e, dataURL, text) => {
    const image = nativeImage.createFromDataURL(dataURL);
    if (image.isEmpty()) return false;
    if (text) clipboard.write({ image, text });
    else clipboard.writeImage(image);
    return true;
  });

  ipcMain.handle('stickers:load', () => {
    const saved = readJSON(stickersPath());
    return Array.isArray(saved) ? saved : [];
  });

  ipcMain.handle('stickers:save', (_e, stickers) => {
    try {
      fs.writeFileSync(stickersPath(), JSON.stringify(stickers));
      return true;
    } catch {
      return false;
    }
  });

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

  // Formats the animation export can write. The renderer has already encoded
  // the bytes; all that is left is asking where they go.
  const ANIMATION_FORMATS = {
    mp4: { ext: 'mp4', name: 'MP4 Video' },
    webm: { ext: 'webm', name: 'WebM Video' },
    gif: { ext: 'gif', name: 'Animated GIF' },
  };

  ipcMain.handle('board:export-animation', async (_e, bytes, format) => {
    const kind = ANIMATION_FORMATS[format];
    if (!kind) return false;
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `animation.${kind.ext}`,
      filters: [{ name: kind.name, extensions: [kind.ext] }],
    });
    if (canceled || !filePath) return false;
    fs.writeFileSync(filePath, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
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
