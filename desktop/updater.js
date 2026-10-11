// Keeps the desktop app up to date from the project's GitHub releases.
//
// Windows, Linux (AppImage) and signed Mac builds download the new version in the
// background and install it on restart. macOS can only install updates for code-signed
// apps, so an unsigned Mac build just says a new version is out and opens the download page.
const { app, dialog, shell } = require('electron');

const REPO = 'HaxMarris/Burrow';
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

const canSelfInstall = process.platform === 'win32' || process.platform === 'darwin' || (process.platform === 'linux' && !!process.env.APPIMAGE);

function startUpdateChecks(getWindow) {
  if (!app.isPackaged) return;
  let check = canSelfInstall ? selfInstallingCheck(getWindow, () => { check = notifyOnlyCheck(getWindow); check(); }) : notifyOnlyCheck(getWindow);
  setTimeout(() => check(), 10 * 1000);
  setInterval(() => check(), CHECK_EVERY_MS);
}

/** fallBack() is called if this copy can't update itself after all (an unsigned Mac build). */
function selfInstallingCheck(getWindow, fallBack) {
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  let asked = false;

  autoUpdater.on('update-downloaded', async (info) => {
    if (asked) return;
    asked = true;
    const { response } = await ask(getWindow(), {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Peiskos ${info.version} is ready`,
      detail: 'Restart to finish updating. If you pick Later, it installs the next time you quit Peiskos.',
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  let gaveUp = false;
  autoUpdater.on('error', (err) => {
    const message = String(err?.message || err);
    console.error('Update check failed:', message);
    if (process.platform === 'darwin' && !gaveUp && /code ?sign|signature/i.test(message)) {
      gaveUp = true;
      fallBack();
    }
  });

  return () => { if (!gaveUp) autoUpdater.checkForUpdates().catch(() => {}); };
}

function notifyOnlyCheck(getWindow) {
  let toldAbout = null;
  return async () => {
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { accept: 'application/vnd.github+json' },
      });
      if (!res.ok) return;
      const latest = String((await res.json()).tag_name || '').replace(/^v/, '');
      if (!isNewer(latest, app.getVersion()) || toldAbout === latest) return;
      toldAbout = latest;
      const { response } = await ask(getWindow(), {
        type: 'info',
        buttons: ['Download', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Update available',
        message: `Peiskos ${latest} is out`,
        detail: `You have ${app.getVersion()}. Download the new version and install it over this one.`,
      });
      if (response === 0) shell.openExternal(RELEASES_PAGE);
    } catch {}
  };
}

function ask(win, options) {
  return win && !win.isDestroyed() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
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
