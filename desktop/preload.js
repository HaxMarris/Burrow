// The one bridge between the app window and Electron: picking what to share on screen, its sound, voice hotkeys, the game you're playing, the icon badge, zoom and the tray settings.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

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
  /**
   * Push to talk, mute and deafen keys heard even while another program is in front.
   * set(binds) resolves to { global, needsPermission }; set(null) stops listening.
   */
  /** The game the app sees running (a name, or null), whenever it changes. */
  activity: {
    onChange: (fn) => ipcRenderer.on('activity', (_e, name) => fn(name)),
    refresh: () => ipcRenderer.send('activity-refresh'),
  },
  /** Strokes friends draw on the screen you're sharing, shown on that screen too; null closes it. */
  drawOverlay: (strokes) => ipcRenderer.send('draw-overlay', strokes),
  /** Unread count on the app's icon; Windows also wants a picture of it. */
  setBadge: (count, image) => ipcRenderer.send('set-badge', count, image),
  /** Seconds since the keyboard or mouse was last used anywhere on the computer. */
  idleSeconds: () => ipcRenderer.sendSync('idle-seconds'),
  /** Text size: the whole window zooms, as Ctrl+plus does in a browser. */
  setZoom: (factor) => webFrame.setZoomFactor(Math.min(2, Math.max(0.5, Number(factor) || 1))),
  /** Desktop-only settings: { closeToTray, openAtLogin }. set() resolves to the new settings. */
  settings: {
    get: () => ipcRenderer.sendSync('desktop-settings'),
    set: (change) => ipcRenderer.invoke('desktop-settings-set', change),
  },
  platform: process.platform,
  hotkeys: {
    set: (binds) => ipcRenderer.invoke('hotkeys-set', binds),
    onKey: (fn) => ipcRenderer.on('hotkey', (_e, name, down) => fn(name, down)),
    askPermission: () => ipcRenderer.send('hotkeys-permission'),
  },
});
