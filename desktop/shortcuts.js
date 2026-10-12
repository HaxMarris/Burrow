// Peiskos used to be called Burrow, and the update renamed Burrow.exe to Peiskos.exe. Shortcuts
// still pointing at the old file (a pinned taskbar icon, the Start menu, the desktop) show a blank
// page and won't open, so point them at this copy of the app instead.
const { app, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

function fixOldShortcuts() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const roaming = app.getPath('appData');
  const folders = [
    path.join(roaming, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'),
    path.join(roaming, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'StartMenu'),
    path.join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    app.getPath('desktop'),
  ];
  for (const folder of folders) {
    let names;
    try { names = fs.readdirSync(folder); } catch { continue; }
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.lnk')) continue;
      const file = path.join(folder, name);
      try {
        const link = shell.readShortcutLink(file);
        if (path.basename(link.target).toLowerCase() !== 'burrow.exe' || fs.existsSync(link.target)) continue;
        shell.writeShortcutLink(file, 'update', {
          target: process.execPath,
          cwd: path.dirname(process.execPath),
          icon: process.execPath,
          iconIndex: 0,
          appUserModelId: 'chat.burrow.desktop',
        });
      } catch {}
    }
  }
}

module.exports = { fixOldShortcuts };
