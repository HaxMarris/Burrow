// Desktop wrapper: loads the bundled chat client, which asks the user for the
// server address on first launch and remembers it.
const { app, BrowserWindow, shell, Menu, desktopCapturer, ipcMain } = require('electron');
const path = require('node:path');
const { startUpdateChecks } = require('./updater');
const appAudio = require('./app-audio');

// The page asks once, at start, whether it can share just one program's sound.
ipcMain.on('app-audio-supported', (e) => { e.returnValue = appAudio.supported(); });

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 480,
    minHeight: 400,
    backgroundColor: '#f3f1ea',
    title: 'Burrow',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // What was last picked to share, so its sound can follow.
  let pickedSource = null;
  ipcMain.handle('app-audio-start', () => {
    if (!pickedSource) return null;
    return appAudio.start(pickedSource, (chunk) => { if (!win.isDestroyed()) win.webContents.send('app-audio-chunk', chunk); });
  });
  ipcMain.on('app-audio-stop', () => appAudio.stop());
  win.webContents.on('did-start-navigation', (e) => { if (e.isMainFrame && !e.isSameDocument) appAudio.stop(); });
  win.on('closed', () => {
    appAudio.stop();
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

app.whenReady().then(() => {
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  createWindow();
  startUpdateChecks(() => BrowserWindow.getAllWindows()[0]);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
