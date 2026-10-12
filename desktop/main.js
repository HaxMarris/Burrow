// Desktop wrapper: loads the bundled chat client, which asks the user for the
// server address on first launch and remembers it.
const { app, BrowserWindow, shell, Menu, desktopCapturer, ipcMain, nativeImage, powerMonitor } = require('electron');
const path = require('node:path');
const { startUpdateChecks } = require('./updater');
const appAudio = require('./app-audio');
const hotkeys = require('./hotkeys');
const activity = require('./activity');
const drawOverlay = require('./draw-overlay');
const tray = require('./tray');
const { fixOldShortcuts } = require('./shortcuts');

// Peiskos used to be called Burrow. Keep the old settings folder (logins, servers, settings),
// which is named after the app, so renaming it doesn't log anyone out.
app.setPath('userData', path.join(app.getPath('appData'), 'Burrow'));

// The page asks how long the computer has been left alone, to show you as away.
ipcMain.on('idle-seconds', (e) => { e.returnValue = powerMonitor.getSystemIdleTime(); });

// The page asks once, at start, whether it can share just one program's sound.
ipcMain.on('app-audio-supported', (e) => { e.returnValue = appAudio.supported(); });

// Keep running in the tray when the window is closed, and start with the computer.
ipcMain.on('desktop-settings', (e) => { e.returnValue = tray.readSettings(); });
ipcMain.handle('desktop-settings-set', (_e, change) => tray.saveSettings({
  ...('closeToTray' in change ? { closeToTray: !!change.closeToTray } : {}),
  ...('openAtLogin' in change ? { openAtLogin: !!change.openAtLogin } : {}),
}));

// Only one copy of the app: opening it again brings back the window that's already running.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => showWindow());

function showWindow() {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow({ hidden = false } = {}) {
  const win = new BrowserWindow({
    show: !hidden,
    width: 1280,
    height: 800,
    minWidth: 480,
    minHeight: 400,
    backgroundColor: '#f3f1ea',
    title: 'Peiskos',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // What was last picked to share, so its sound can follow (and, for a whole screen, which one it is).
  let pickedSource = null;
  let pickedDisplay = null;
  // Friends drawing on the screen you're sharing.
  ipcMain.on('draw-overlay', (_e, strokes) => drawOverlay.show(pickedDisplay, strokes));
  ipcMain.handle('app-audio-start', () => {
    if (!pickedSource) return null;
    return appAudio.start(pickedSource, (chunk) => { if (!win.isDestroyed()) win.webContents.send('app-audio-chunk', chunk); });
  });
  ipcMain.on('app-audio-stop', () => appAudio.stop());
  win.webContents.on('did-start-navigation', (e) => { if (e.isMainFrame && !e.isSameDocument) appAudio.stop(); });
  // Voice hotkeys that work while another program is in front.
  ipcMain.handle('hotkeys-set', (_e, binds) => hotkeys.set(binds, (name, down) => {
    if (!win.isDestroyed()) win.webContents.send('hotkey', name, down);
  }));
  ipcMain.on('hotkeys-permission', () => hotkeys.askPermission());

  // The game you're playing, for "Playing …" under your name.
  const games = activity.watch((name) => { if (!win.isDestroyed()) win.webContents.send('activity', name); });
  ipcMain.on('activity-refresh', () => games.repeat());
  win.webContents.on('did-finish-load', () => games.repeat());

  // Unread mentions on the dock or taskbar icon. Windows shows a small picture the page draws.
  ipcMain.on('set-badge', (_e, count, image) => {
    if (process.platform === 'win32') {
      win.setOverlayIcon(count && image ? nativeImage.createFromDataURL(image) : null, count ? `${count} unread` : '');
    } else app.setBadgeCount(count);
    tray.setUnread(count);
  });
  // Closing the window keeps Burrow running in the tray (unless that's turned off), so
  // messages still arrive and voice stays connected.
  win.on('close', (e) => {
    if (app.isQuitting || !tray.readSettings().closeToTray || (!tray.active() && process.platform !== 'darwin')) return;
    e.preventDefault();
    win.hide();
    if (process.platform === 'darwin') app.dock?.hide();
  });
  win.on('show', () => { if (process.platform === 'darwin') app.dock?.show(); });
  win.webContents.on('did-start-navigation', (e) => { if (e.isMainFrame && !e.isSameDocument) hotkeys.stop(); });

  // YouTube's player (listen together) won't play without knowing which site it's on, and an
  // app page has no web address of its own to tell it.
  win.webContents.session.webRequest.onBeforeSendHeaders({ urls: ['https://www.youtube-nocookie.com/*'] }, (details, callback) => {
    const headers = details.requestHeaders;
    if (!headers.Referer || headers.Referer.startsWith('file:')) headers.Referer = 'https://github.com/HaxMarris/Burrow';
    callback({ requestHeaders: headers });
  });

  win.on('closed', () => {
    appAudio.stop();
    drawOverlay.close();
    ipcMain.removeAllListeners('draw-overlay');
    hotkeys.stop();
    games.stop();
    ipcMain.removeAllListeners('activity-refresh');
    ipcMain.removeAllListeners('set-badge');
    ipcMain.removeHandler('hotkeys-set');
    ipcMain.removeAllListeners('hotkeys-permission');
    ipcMain.removeHandler('app-audio-start');
    ipcMain.removeAllListeners('app-audio-stop');
  });

  // Screen sharing: list screens and windows, let the page show a picker, then hand over the choice.
  win.webContents.session.setDisplayMediaRequestHandler(async (request, callback) => {
    // Electron throws when told "nothing chosen", though the page does get its "cancelled".
    const cancel = () => { try { callback({}); } catch {} };
    const thumbnailSize = { width: 320, height: 180 };
    let sources;
    try {
      // Windows are listed separately, and given up on if listing them stalls (it can on some Linux desktops).
      const [screens, windows] = await Promise.all([
        desktopCapturer.getSources({ types: ['screen'], thumbnailSize }),
        Promise.race([
          desktopCapturer.getSources({ types: ['window'], thumbnailSize }),
          new Promise((resolve) => setTimeout(() => resolve([]), 3000)),
        ]).catch(() => []),
      ]);
      sources = [...screens, ...windows];
    } catch {
      return cancel(); // no permission to see the screen (macOS: System Settings > Privacy > Screen Recording)
    }
    ipcMain.emit('picked-screen', {}, null); // an earlier picker still open counts as cancelled
    ipcMain.once('picked-screen', (_e, id) => {
      const source = sources.find((s) => s.id === id);
      if (!source) return cancel();
      pickedSource = source.id;
      pickedDisplay = source.display_id || null;
      drawOverlay.close();
      // Where the program's own sound can be shared, the page adds it itself. Otherwise Windows
      // can share all of the computer's sound; other systems share none.
      const loopback = request.audioRequested && process.platform === 'win32' && !appAudio.supported();
      callback({ video: source, ...(loopback ? { audio: 'loopback' } : {}) });
    });
    win.webContents.send('pick-screen', sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() })));
  });

  // Links in messages open in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  win.loadFile(path.join(__dirname, 'app', 'index.html'));
}

if (process.platform === 'win32') app.setAppUserModelId('chat.burrow.desktop'); // needed for notifications

app.on('before-quit', () => { app.isQuitting = true; });

app.whenReady().then(() => {
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  createWindow({ hidden: tray.openedHidden() });
  tray.createTray(showWindow);
  startUpdateChecks(() => BrowserWindow.getAllWindows()[0]);
  fixOldShortcuts();
  app.on('activate', () => showWindow());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
