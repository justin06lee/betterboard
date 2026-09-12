const { app, BrowserWindow, Menu, clipboard, ipcMain, dialog, nativeImage } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
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
// The autosave is a folder (see src/renderer/persist.ts); autosave.json is the
// single file every version before it wrote, read once and carried over.
const storeDir = () => path.join(userData(), 'autosave');
const legacyAutosavePath = () => path.join(userData(), 'autosave.json');
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

  // Closing waits for the renderer to write its last changes: the autosave is
  // debounced, so an edit made just before quitting would otherwise be lost.
  // It gets a few seconds, never more, so a stuck page cannot hold the window.
  let flushed = false;
  let flushing = false;
  win.on('close', (e) => {
    try {
      fs.writeFileSync(windowStatePath(), JSON.stringify(win.getBounds()));
    } catch {}
    if (flushed) return;
    e.preventDefault();
    if (flushing) return;
    flushing = true;
    const target = win;
    const finish = () => {
      if (flushed) return;
      flushed = true;
      ipcMain.removeListener('app:flushed', onFlushed);
      clearTimeout(timer);
      if (!target.isDestroyed()) target.close();
    };
    const onFlushed = (event) => {
      if (event.sender === target.webContents) finish();
    };
    const timer = setTimeout(finish, 5000);
    ipcMain.on('app:flushed', onFlushed);
    target.webContents.send('app:flush');
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
        // M and Shift+M are handled in the renderer: as menu accelerators they
        // would be swallowed app-wide and break typing an M in any text field.
        { label: 'Flip Canvas Horizontally', click: () => send('flip-h') },
        { label: 'Flip Canvas Vertically', click: () => send('flip-v') },
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

  // ---- the autosave store ----
  // The renderer decides what to write; this side only keeps the folder. A
  // save puts its new files first and commits by renaming the manifest into
  // place, after which anything the manifest no longer names is deleted — so
  // a crash mid-save leaves the previous save exactly as it was.
  const STORE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/;
  const storeFile = (name) => {
    if (typeof name !== 'string' || !STORE_NAME.test(name)) throw new Error('bad autosave file name');
    return path.join(storeDir(), name);
  };

  ipcMain.handle('store:load', async () => {
    let manifest = null;
    try {
      manifest = await fsp.readFile(path.join(storeDir(), 'manifest.json'), 'utf8');
    } catch {}
    return { manifest, legacy: fs.existsSync(legacyAutosavePath()) };
  });

  ipcMain.handle('store:read', (_e, name) => fsp.readFile(storeFile(name)));
  ipcMain.handle('store:read-text', (_e, name) => fsp.readFile(storeFile(name), 'utf8'));

  ipcMain.handle('store:put', async (_e, name, data) => {
    const file = storeFile(name);
    await fsp.mkdir(storeDir(), { recursive: true });
    await fsp.writeFile(file, typeof data === 'string' ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  });

  ipcMain.handle('store:commit', async (_e, manifest) => {
    const dir = storeDir();
    await fsp.mkdir(dir, { recursive: true });
    const keep = new Set(['manifest.json']);
    for (const name of Object.values(manifest?.files ?? {})) keep.add(path.basename(storeFile(name)));
    for (const im of manifest?.images ?? []) keep.add(path.basename(storeFile(`i-${im.key}.txt`)));
    const tmp = path.join(dir, 'manifest.json.tmp');
    await fsp.writeFile(tmp, JSON.stringify(manifest));
    await fsp.rename(tmp, path.join(dir, 'manifest.json'));
    for (const name of await fsp.readdir(dir)) {
      if (!keep.has(name)) await fsp.rm(path.join(dir, name), { force: true, recursive: true });
    }
    // The first save into the store has carried the old single-file autosave
    // over. It is kept beside it under another name rather than deleted.
    if (fs.existsSync(legacyAutosavePath())) {
      await fsp.rename(legacyAutosavePath(), path.join(userData(), 'autosave.pre-v6.json')).catch(() => {});
    }
  });

  // An autosave the renderer could not read is moved aside, never overwritten.
  ipcMain.handle('store:quarantine', async () => {
    const stamp = Date.now();
    await fsp.rename(storeDir(), path.join(userData(), `autosave-unreadable-${stamp}`)).catch(() => {});
    await fsp.rename(legacyAutosavePath(), path.join(userData(), `autosave-unreadable-${stamp}.json`)).catch(() => {});
  });

  // ---- board files, in pieces ----
  // A board of a million strokes is far more text than fits in one string, so
  // files are read and written a chunk at a time and the renderer does the
  // rest. Writes go to a .partial file that only replaces the target once
  // every piece has landed.
  const readers = new Map();
  const writers = new Map();
  let nextToken = 1;

  ipcMain.handle('file:read-begin', async (_e, kind) => {
    let file = legacyAutosavePath();
    if (kind !== 'legacy-autosave') {
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: [{ name: 'BetterBoard', extensions: ['json'] }],
      });
      if (canceled || filePaths.length === 0) return null;
      file = filePaths[0];
    }
    let handle;
    try {
      handle = await fsp.open(file, 'r');
    } catch {
      return null;
    }
    const { size } = await handle.stat();
    const token = nextToken++;
    readers.set(token, handle);
    return { token, size, name: path.basename(file) };
  });

  ipcMain.handle('file:read', async (_e, token, max) => {
    const handle = readers.get(token);
    if (!handle) return null;
    const buf = Buffer.allocUnsafe(Math.max(1 << 16, Math.min(Number(max) || 0, 32 << 20)));
    const { bytesRead } = await handle.read(buf, 0, buf.length, null);
    if (bytesRead === 0) return null;
    // A short read is copied out, or the whole buffer would cross the bridge.
    return bytesRead === buf.length ? buf : Buffer.from(buf.subarray(0, bytesRead));
  });

  ipcMain.handle('file:read-end', async (_e, token) => {
    const handle = readers.get(token);
    readers.delete(token);
    await handle?.close();
  });

  ipcMain.handle('file:write-begin', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: 'board.betterboard.json',
      filters: [{ name: 'BetterBoard', extensions: ['json'] }],
    });
    if (canceled || !filePath) return null;
    const tmp = `${filePath}.partial`;
    const handle = await fsp.open(tmp, 'w');
    const token = nextToken++;
    writers.set(token, { handle, tmp, filePath });
    return token;
  });

  ipcMain.handle('file:write', async (_e, token, text) => {
    const w = writers.get(token);
    if (!w) throw new Error('that save has already finished');
    await w.handle.write(String(text));
  });

  ipcMain.handle('file:write-end', async (_e, token, ok) => {
    const w = writers.get(token);
    if (!w) return false;
    writers.delete(token);
    await w.handle.close();
    if (ok) {
      await fsp.rename(w.tmp, w.filePath);
      return true;
    }
    await fsp.rm(w.tmp, { force: true });
    return false;
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
