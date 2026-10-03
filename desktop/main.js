// Desktop wrapper: loads the bundled chat client, which asks the user for the
// server address on first launch and remembers it.
const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('node:path');
const { startUpdateChecks } = require('./updater');

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
    },
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
