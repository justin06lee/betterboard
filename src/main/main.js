const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

app.setName('BetterBoard');

const isMac = process.platform === 'darwin';

const userData = () => app.getPath('userData');
const autosavePath = () => path.join(userData(), 'autosave.json');
const windowStatePath = () => path.join(userData(), 'window.json');

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
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: () => send('redo') },
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

function registerIpc() {
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
