# Vendored libraries

- `livekit-client.umd.js`: [livekit-client](https://github.com/livekit/client-sdk-js) 2.22.3,
  the browser SDK for LiveKit voice. Apache License 2.0. Copied from the npm package's
  `dist/` folder (source map reference removed). Loaded only when someone joins a voice room.
- `livekit-client.e2ee.worker.source.js`: the same package's `dist/livekit-client.e2ee.worker.js`
  (voice encryption), wrapped as a JavaScript string so the app can start it from a Blob. Regenerate
  it from a new version with:
  `node -e "const s=require('fs').readFileSync('livekit-client.e2ee.worker.js','utf8'); console.log('window.LivekitE2EEWorkerSource = ' + JSON.stringify(s) + ';')"`
