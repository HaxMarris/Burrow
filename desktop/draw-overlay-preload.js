// The drawing overlay only ever receives strokes to show.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  onStrokes: (fn) => ipcRenderer.on('strokes', (_e, strokes) => fn(strokes)),
});
