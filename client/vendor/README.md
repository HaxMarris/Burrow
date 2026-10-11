# Vendored libraries

- `livekit-client.umd.js`: [livekit-client](https://github.com/livekit/client-sdk-js) 2.22.3,
  the browser SDK for LiveKit voice. Apache License 2.0. Copied from the npm package's
  `dist/` folder (source map reference removed). Loaded only when someone joins a voice room.
- `livekit-client.e2ee.worker.source.js`: the same package's `dist/livekit-client.e2ee.worker.js`
  (voice encryption), wrapped as a JavaScript string so the app can start it from a Blob. Regenerate
  it from a new version with:
  `node -e "const s=require('fs').readFileSync('livekit-client.e2ee.worker.js','utf8'); console.log('window.LivekitE2EEWorkerSource = ' + JSON.stringify(s) + ';')"`
- `noise/`: noise filters from [@sapphi-red/web-noise-suppressor](https://github.com/sapphi-red/web-noise-suppressor)
  0.4.1 (MIT): `rnnoise.worklet.js` + `rnnoise.wasm` ([RNNoise](https://github.com/xiph/rnnoise), BSD; the
  package's `rnnoise_simd.wasm`) and `gtcrn.worklet.js` + `gtcrn.wasm` ([GTCRN](https://github.com/Xiaobin-Rong/gtcrn),
  MIT). Copied from the package's `dist/` folder (`<model>/workletProcessor.js`, source map reference removed).
  Loaded only when someone uses the Strong or Strongest noise isolation.
- `emoji.js`: the emoji list for the message box's emoji picker, from
  [unicode-emoji-json](https://github.com/muan/unicode-emoji-json) 0.9.0 by Mu-An Chiou (MIT License),
  grouped and kept to Emoji 15.0 so everything listed shows on current systems. Loaded the first time
  someone opens the emoji picker.
- `mediapipe/`: [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) 0.10.14 (Apache License 2.0)
  for the camera background. `vision.js` is the npm package's `vision_bundle.cjs` wrapped for a plain script tag
  (`window.MediaPipeVision`, source map reference removed); `vision_wasm_internal.js` and `.wasm` are its `wasm/`
  files; `selfie_segmenter.tflite` is the [selfie segmenter model](https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter#selfie-model)
  (float16, Apache License 2.0). Loaded only when someone turns on a camera background.
- `qrcode.js`: [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4 by Kazuhiko Arase
  (MIT License), the npm package's `qrcode.js` unchanged. Draws the QR code for setting up two-step login in an
  authenticator app. Loaded only then.
