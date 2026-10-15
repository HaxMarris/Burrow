// The app's icon in the system tray (the menu bar on a Mac), with a red dot while there's
// something unread, and the desktop-only settings: keep running in the tray when the window is
// closed, and start with the computer.
const { app, Menu, Tray, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const settingsFile = () => path.join(app.getPath('userData'), 'desktop-settings.json');
// Closing the window quits the app unless you turn the tray on. Staying in the tray used to be
// the default and every save wrote it down, so a saved closeToTray only counts once trayChosen
// says you picked it yourself.
const defaults = { closeToTray: false, openAtLogin: false };

function readSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    if (!saved.trayChosen) delete saved.closeToTray;
    return { ...defaults, ...saved };
  } catch {
    return { ...defaults };
  }
}

function saveSettings(change) {
  const next = { ...readSettings(), ...change };
  if ('closeToTray' in change) next.trayChosen = true;
  try { fs.writeFileSync(settingsFile(), JSON.stringify(next)); } catch {}
  if ('openAtLogin' in change) setOpenAtLogin(!!next.openAtLogin);
  return next;
}

/** Started by the computer at login: open quietly, in the tray only. */
function openedHidden() {
  if (process.argv.includes('--hidden')) return true;
  return process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin === true && readSettings().openAtLogin;
}

// Windows and macOS have this built in; Linux desktops read ~/.config/autostart.
function setOpenAtLogin(on) {
  if (process.platform === 'linux') {
    const file = path.join(os.homedir(), '.config', 'autostart', 'burrow.desktop');
    try {
      if (!on) return fs.rmSync(file, { force: true });
      const exe = process.env.APPIMAGE || process.execPath;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Peiskos\nExec="${exe}" --hidden\nX-GNOME-Autostart-enabled=true\n`);
    } catch {}
    return;
  }
  app.setLoginItemSettings({ openAtLogin: on, args: on ? ['--hidden'] : [] });
}

// The app icon at tray size, and the same with a red dot in the corner.
function icons() {
  const size = process.platform === 'darwin' ? 18 : process.platform === 'win32' ? 16 : 22;
  const base = nativeImage.createFromPath(path.join(__dirname, 'app', 'icon-192.png'));
  const scale = 2; // drawn at double size so it's sharp on high-resolution screens
  const big = base.resize({ width: size * scale, height: size * scale, quality: 'best' });
  const { width, height } = big.getSize();
  const pixels = Buffer.from(big.toBitmap()); // BGRA
  const r = width * 0.22;
  const cx = width - r - 1;
  const cy = r + 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d > r + 1.5) continue;
      const i = (y * width + x) * 4;
      if (d > r) { pixels[i] = pixels[i + 1] = pixels[i + 2] = 0; pixels[i + 3] = 0; continue; } // a gap around the dot
      pixels[i] = 0x3a; pixels[i + 1] = 0x47; pixels[i + 2] = 0xc4; pixels[i + 3] = 255;
    }
  }
  const plain = nativeImage.createEmpty();
  plain.addRepresentation({ scaleFactor: scale, width, height, buffer: big.toBitmap() });
  const dotted = nativeImage.createEmpty();
  dotted.addRepresentation({ scaleFactor: scale, width, height, buffer: pixels });
  return { plain, dotted };
}

let tray = null;
let pictures = null;

function createTray(showWindow) {
  try {
    pictures = icons();
    tray = new Tray(pictures.plain);
  } catch {
    return null; // some Linux desktops have no tray
  }
  tray.setToolTip('Peiskos');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Peiskos', click: showWindow },
    { type: 'separator' },
    { label: 'Quit Peiskos', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
  return tray;
}

function setUnread(count) {
  if (!tray || tray.isDestroyed()) return;
  tray.setImage(count ? pictures.dotted : pictures.plain);
  tray.setToolTip(count ? `Peiskos (${count} unread)` : 'Peiskos');
}

const active = () => !!tray && !tray.isDestroyed();

module.exports = { active, createTray, setUnread, readSettings, saveSettings, openedHidden };
