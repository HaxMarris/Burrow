// Keeps the desktop app up to date from the project's GitHub releases.
//
// Windows, Linux (AppImage) and signed Mac builds download the new version in the
// background; macOS can only install updates for code-signed apps, so an unsigned Mac build
// just learns a new version is out. Either way the page shows an update button in the top bar
// (as Discord does), and installing waits until it's clicked and confirmed. Anything not
// installed by then goes in the next time the app quits.
const { app, ipcMain, shell } = require('electron');

const REPO = 'HaxMarris/Burrow';
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

const canSelfInstall = process.platform === 'win32' || process.platform === 'darwin' || (process.platform === 'linux' && !!process.env.APPIMAGE);

// The update waiting to go in: { version, install: true } once downloaded, or
// { version, install: false } when it has to be downloaded by hand from the release page.
let ready = null;
let installNow = null;

function startUpdateChecks(getWindow) {
  const tell = (update) => {
    ready = update;
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('update-ready', ready);
  };
  ipcMain.on('update-status', (e) => { e.returnValue = ready; });
  ipcMain.on('update-install', () => {
    if (ready?.install && installNow) installNow();
    else if (ready) shell.openExternal(RELEASES_PAGE);
  });
  if (!app.isPackaged) return;
  let check = canSelfInstall ? selfInstallingCheck(tell, () => { check = notifyOnlyCheck(tell); check(); }) : notifyOnlyCheck(tell);
  setTimeout(() => check(), 10 * 1000);
  setInterval(() => check(), CHECK_EVERY_MS);
}

/** fallBack() is called if this copy can't update itself after all (an unsigned Mac build). */
function selfInstallingCheck(tell, fallBack) {
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  installNow = () => autoUpdater.quitAndInstall();

  autoUpdater.on('update-downloaded', (info) => tell({ version: info.version, install: true }));
  let gaveUp = false;
  autoUpdater.on('error', (err) => {
    const message = String(err?.message || err);
    console.error('Update check failed:', message);
    if (process.platform === 'darwin' && !gaveUp && /code ?sign|signature/i.test(message)) {
      gaveUp = true;
      installNow = null;
      fallBack();
    }
  });

  return () => { if (!gaveUp) autoUpdater.checkForUpdates().catch(() => {}); };
}

function notifyOnlyCheck(tell) {
  return async () => {
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { accept: 'application/vnd.github+json' },
      });
      if (!res.ok) return;
      const latest = String((await res.json()).tag_name || '').replace(/^v/, '');
      if (!isNewer(latest, app.getVersion()) || ready?.version === latest) return;
      tell({ version: latest, install: false });
    } catch {}
  };
}

// Compares plain x.y.z versions; anything unparseable never counts as newer.
function isNewer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  if (pa.length !== 3 || pa.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

module.exports = { startUpdateChecks, isNewer };
