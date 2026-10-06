// The one bridge between the app window and Electron: picking what to share on screen, and its sound.
const { contextBridge, ipcRenderer } = require('electron');

const appAudioSupported = ipcRenderer.sendSync('app-audio-supported');

contextBridge.exposeInMainWorld('burrowDesktop', {
  /** Electron has no screen picker of its own, so the page shows one. */
  onPickScreen: (show) => ipcRenderer.on('pick-screen', (_e, sources) => show(sources)),
  /** The id of the chosen screen or window, or null if they cancelled. */
  pickedScreen: (id) => ipcRenderer.send('picked-screen', id),
  /**
   * Sharing the picked program's own sound (Windows 10 2004+ only): start() resolves to
   * 'program', 'all-but-burrow' (a whole screen), or null; sound arrives as 48 kHz stereo
   * 16-bit chunks.
   */
  appAudio: appAudioSupported ? {
    start: () => ipcRenderer.invoke('app-audio-start'),
    stop: () => ipcRenderer.send('app-audio-stop'),
    onChunk: (fn) => ipcRenderer.on('app-audio-chunk', (_e, chunk) => fn(chunk)),
  } : null,
});
