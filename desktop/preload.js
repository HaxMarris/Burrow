// The one bridge between the app window and Electron: picking what to share on screen.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('burrowDesktop', {
  /** Electron has no screen picker of its own, so the page shows one. */
  onPickScreen: (show) => ipcRenderer.on('pick-screen', (_e, sources) => show(sources)),
  /** The id of the chosen screen or window, or null if they cancelled. */
  pickedScreen: (id) => ipcRenderer.send('picked-screen', id),
});
