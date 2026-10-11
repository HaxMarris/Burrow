// Drawing on a shared screen: when friends draw on the screen you're sharing, the strokes also
// show on that screen itself, in a see-through window on top that clicks pass straight through.
// It's left out of screen captures, so the people watching don't see every stroke twice.
const { BrowserWindow, screen } = require('electron');
const path = require('node:path');

let win = null;
let latest = [];
let ready = false;

function close() {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
  ready = false;
}

/** Shows strokes on the display with this id (desktopCapturer's display_id), or closes when strokes is null. */
function show(displayId, strokes) {
  if (!strokes) return close();
  const display = screen.getAllDisplays().find((d) => String(d.id) === String(displayId));
  if (!display) return close(); // a window is shared, not a whole screen
  latest = strokes;
  if (!win || win.isDestroyed()) {
    if (!strokes.length) return;
    win = new BrowserWindow({
      ...display.bounds,
      transparent: true,
      frame: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, 'draw-overlay-preload.js') },
    });
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setContentProtection(true);
    ready = false;
    win.webContents.on('did-finish-load', () => {
      ready = true;
      win.showInactive();
      win.webContents.send('strokes', latest);
    });
    win.loadFile(path.join(__dirname, 'draw-overlay.html'));
    return;
  }
  if (String(win.getBounds().x) !== String(display.bounds.x) || win.getBounds().width !== display.bounds.width) win.setBounds(display.bounds);
  if (ready) win.webContents.send('strokes', strokes);
}

module.exports = { show, close };
