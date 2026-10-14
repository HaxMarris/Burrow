// Your voice and video settings: devices, noise filtering, the voice changer.
// Part of Burrow's client: plain scripts that index.html loads in order, sharing one global scope.
'use strict';

// ---------------------------------------------------------------- your voice and video settings
//
// Which microphone, speakers and camera to use, how loud you are, how loud everyone else is, and
// how much background noise to take out. All kept on this device. Everything but voice quality
// changes straight away, even in the middle of a call.

const VOICE_QUALITY = {
  standard: { bitrate: 48000, label: 'Standard (48 kbps)' },
  high: { bitrate: 64000, label: 'High (64 kbps)' },
  best: { bitrate: 96000, label: 'Best (96 kbps)' },
};
// "strong" and "strongest" run a small noise-removal model on your device (RNNoise and GTCRN,
// in vendor/noise), on your voice before it's encrypted, so they work with end-to-end encryption.
const NOISE_LEVELS = {
  off: { label: 'Off', hint: 'Nothing is filtered. Best for music or an instrument.' },
  light: { label: 'Light', hint: "Your browser's own filter. Takes out steady hums and hiss." },
  strong: { label: 'Strong', model: 'rnnoise', hint: 'Takes out fans, typing, clicks and chatter behind you.' },
  strongest: { label: 'Strongest', model: 'gtcrn', hint: 'Takes out even more noise, but your voice sounds a little flatter.' },
};
const voicePrefs = (() => {
  const defaults = {
    quality: 'high', noise: 'strong', inputVolume: 1, outputVolume: 1,
    mode: 'voice', // or 'ptt': push to talk
    autoGate: true, // send your voice only when the noise filter hears speech
    sensitivity: null, // dB your voice must pass to be sent (with autoGate off); null: send whenever the mic hears something
    fx: 'off', // voice changer
    music: false, // stereo, no filters, higher bitrate
    soundboard: true, soundboardVolume: 0.6, listenVolume: 0.6,
    background: 'off', // camera background: 'off', 'blur' or 'picture'
    keys: { ptt: { code: 'Backquote' }, mute: { code: 'KeyM', ctrl: true, shift: true }, deafen: { code: 'KeyD', ctrl: true, shift: true } },
  };
  try {
    const saved = JSON.parse(store.get('voicePrefs')) ?? {};
    // Noise suppression used to be just on or off.
    if (saved.noiseSuppression === false && !saved.noise) saved.noise = 'off';
    delete saved.noiseSuppression;
    // People who had set a sensitivity before the automatic gate keep their line.
    if (saved.autoGate === undefined && typeof saved.sensitivity === 'number') saved.autoGate = false;
    return { ...defaults, ...saved, keys: { ...defaults.keys, ...saved.keys } };
  } catch { return defaults; }
})();
const saveVoicePrefs = () => store.set('voicePrefs', JSON.stringify(voicePrefs));

/**
 * What the browser itself does to your microphone. The stronger filters replace its noise filter
 * rather than stack on it. Music mode turns it all off and keeps both channels.
 */
function micConstraints() {
  if (voicePrefs.music) return { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 };
  const level = voicePrefs.noise;
  return { echoCancellation: true, noiseSuppression: level === 'light', autoGainControl: level !== 'off', channelCount: 1 };
}
/** How your voice is sent: Opus at your quality, or in music mode stereo at 128 kbps that never cuts out. */
function micPublishOptions() {
  const quality = VOICE_QUALITY[voicePrefs.quality] ?? VOICE_QUALITY.high;
  return voicePrefs.music
    ? { audioPreset: { maxBitrate: Math.max(128_000, quality.bitrate) }, forceStereo: true, dtx: false, red: false }
    : { audioPreset: { maxBitrate: quality.bitrate }, dtx: true, red: true };
}
const noiseModel = () => (voicePrefs.music ? null : NOISE_LEVELS[voicePrefs.noise]?.model ?? null);
const voiceFx = () => (voicePrefs.music ? VOICE_FX.off : VOICE_FX[voicePrefs.fx] ?? VOICE_FX.off);
/** Any filtering at all: off and music mode leave your sound alone. */
const filtersOn = () => !voicePrefs.music && voicePrefs.noise !== 'off';
/** The automatic gate: your voice is sent only while RNNoise thinks you're talking. */
const autoGate = () => voicePrefs.mode !== 'ptt' && voicePrefs.autoGate && filtersOn();
/** Push to talk, the automatic gate, or a sensitivity you set: your voice goes through Burrow's gate. */
const wantsGate = () => voicePrefs.mode === 'ptt' || autoGate() || (voicePrefs.sensitivity !== null && !voicePrefs.music);
const wantsMicProcessor = () => filtersOn() || voiceFx() !== VOICE_FX.off || voicePrefs.inputVolume !== 1 || wantsGate();

// The voice changer. Each one is a few Web Audio nodes (and the pitch shifter in voice-worklet.js)
// between your noise filter and your volume, so what's sent and encrypted is the changed voice.
const VOICE_FX = {
  off: { label: 'Off' },
  deeper: { label: 'Deeper', pitch: 0.75 },
  higher: { label: 'Higher', pitch: 1.4 },
  robot: { label: 'Robot', robot: true },
  echo: { label: 'Echo', echo: true },
  radio: { label: 'Radio', radio: true },
  cave: { label: 'Cave', cave: true },
};

/** Builds the voice changer: an input and an output node, and a way to tear it down. */
async function fxNodes(ctx, fx) {
  const input = ctx.createGain(), output = ctx.createGain();
  const parts = [input, output];
  const stops = [];
  if (fx.pitch) {
    const pitch = new AudioWorkletNode(ctx, 'burrow-pitch', { numberOfInputs: 1, outputChannelCount: [1], processorOptions: { ratio: fx.pitch } });
    input.connect(pitch).connect(output);
    parts.push(pitch);
  } else if (fx.robot) {
    // Ring modulation: your voice multiplied by a low hum, which gives it the metal edge.
    const ring = ctx.createGain();
    ring.gain.value = 0;
    const osc = ctx.createOscillator();
    osc.frequency.value = 55;
    osc.connect(ring.gain);
    osc.start();
    stops.push(() => osc.stop());
    const lift = ctx.createGain();
    lift.gain.value = 1.6;
    input.connect(ring).connect(lift).connect(output);
    parts.push(ring, osc, lift);
  } else if (fx.echo || fx.cave) {
    input.connect(output); // the dry voice
    const wet = ctx.createGain();
    if (fx.echo) {
      const delay = ctx.createDelay(1);
      delay.delayTime.value = 0.28;
      const feedback = ctx.createGain();
      feedback.gain.value = 0.35;
      wet.gain.value = 0.5;
      input.connect(delay).connect(feedback).connect(delay);
      delay.connect(wet).connect(output);
      parts.push(delay, feedback, wet);
    } else {
      // A made-up echoey room: a burst of noise that dies away over two seconds.
      const length = Math.round(ctx.sampleRate * 2);
      const impulse = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = impulse.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
      const verb = ctx.createConvolver();
      verb.buffer = impulse;
      wet.gain.value = 0.45;
      input.connect(verb).connect(wet).connect(output);
      parts.push(verb, wet);
    }
  } else if (fx.radio) {
    const low = ctx.createBiquadFilter(), high = ctx.createBiquadFilter(), crush = ctx.createWaveShaper();
    low.type = 'highpass';
    low.frequency.value = 500;
    high.type = 'lowpass';
    high.frequency.value = 3200;
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) { const x = (i / (curve.length - 1)) * 2 - 1; curve[i] = Math.tanh(3 * x); }
    crush.curve = curve;
    input.connect(low).connect(high).connect(crush).connect(output);
    parts.push(low, high, crush);
  } else input.connect(output);
  return { input, output, destroy() { stops.forEach((f) => f()); parts.forEach((n) => n.disconnect()); } };
}

// ---- devices

const DEVICE_NAMES = { audioinput: 'Microphone', audiooutput: 'Speakers', videoinput: 'Camera' };
const savedDevices = (() => { try { return JSON.parse(store.get('devices')) ?? {}; } catch { return {}; } })();
// Burrow mixes voices with Web Audio, which can only be sent to another output where AudioContext
// has setSinkId: Chrome, Edge and the desktop app. Safari, every iPhone browser and Firefox can't.
const canPickOutput = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
const isAppleMobile = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

async function listDevices() {
  try {
    // "default" and "communications" are Chrome's aliases for real devices; "System default" covers them.
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
  } catch { return []; }
}

/** The device you picked: by its id, or by its name, since some browsers change ids between visits. */
async function deviceIdFor(kind) {
  const saved = savedDevices[kind];
  if (!saved) return undefined;
  const list = (await listDevices()).filter((d) => d.kind === kind);
  const found = list.find((d) => d.deviceId === saved.id) ?? list.find((d) => saved.label && d.label === saved.label);
  // A microphone or camera that isn't listed yet (no permission) is still worth asking for: the browser falls back if it's gone.
  return found?.deviceId ?? (kind === 'audiooutput' ? undefined : saved.id);
}

async function pickDevice(kind, id, label) {
  if (id) savedDevices[kind] = { id, label };
  else delete savedDevices[kind];
  store.set('devices', JSON.stringify(savedDevices));
  if (kind === 'audiooutput') setChimeOutput();
  const room = state.voice?.room;
  if (!room) return;
  try {
    await room.switchActiveDevice(kind, id || 'default', !!id);
  } catch (err) {
    alert(mediaError(err, DEVICE_NAMES[kind].toLowerCase()));
  }
}

/** Chimes play through the speakers you picked too. */
async function setChimeOutput() {
  if (!soundCtx?.setSinkId) return;
  try { await soundCtx.setSinkId((await deviceIdFor('audiooutput')) ?? ''); } catch {}
}

// ---- your microphone, through the noise filter

// Both filters want 48 kHz.
const newMicContext = () => keepAwake(new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' }));

/** Browsers start audio paused until you've clicked; if that happened, the next click starts it. */
function keepRunning(ctx) {
  if (ctx.state === 'running') return;
  ctx.resume().catch(() => {});
  const resume = () => ctx.state !== 'closed' && ctx.resume().catch(() => {});
  document.addEventListener('pointerdown', resume, { once: true });
  document.addEventListener('keydown', resume, { once: true });
}

const noiseWasm = new Map(); // model -> Promise<ArrayBuffer>, downloaded once
async function noiseFilter(ctx, model, withSpeech = false) {
  if (!noiseWasm.has(model)) {
    const loading = fetch(`vendor/noise/${model}.wasm`).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.arrayBuffer();
    });
    loading.catch(() => noiseWasm.delete(model));
    noiseWasm.set(model, loading);
  }
  const [wasmBinary] = await Promise.all([noiseWasm.get(model), ctx.audioWorklet.addModule(`vendor/noise/${model}.worklet.js`)]);
  const node = new AudioWorkletNode(ctx, `@sapphi-red/web-noise-suppressor/${model}`, {
    channelCount: 1, channelCountMode: 'explicit', processorOptions: { maxChannels: 1, wasmBinary },
    // RNNoise can add a second channel: how sure it is that you're talking (see the patch in its worklet).
    ...(withSpeech ? { outputChannelCount: [2] } : {}),
  });
  node.onprocessorerror = () => console.warn(`The ${model} noise filter stopped working.`);
  return node;
}

/**
 * Microphone in, filtered and turned up or down, out as a new track. If the filter can't load,
 * your voice still goes through, just unfiltered. With the automatic gate, RNNoise also says when
 * you're talking: from the filter itself on Strong, or from a copy run only for that on Light and
 * Strongest.
 */
async function micChain(ctx, track) {
  const model = noiseModel();
  const auto = autoGate();
  let filter = null, speech = null;
  if (model) {
    try { filter = await noiseFilter(ctx, model, auto && model === 'rnnoise'); } catch (err) { console.warn(`Couldn't load the ${model} noise filter:`, err); }
  }
  if (auto) {
    try { speech = filter && model === 'rnnoise' ? filter : await noiseFilter(ctx, 'rnnoise', true); } catch (err) { console.warn("Couldn't load the speech detector:", err); }
  }
  const channels = voicePrefs.music ? 2 : 1;
  const needsWorklet = wantsGate() || !!voiceFx().pitch;
  if (needsWorklet) {
    try { await ctx.audioWorklet.addModule('voice-worklet.js'); } catch (err) { console.warn("Couldn't load the voice gate:", err); }
  }
  let fx = null;
  try { fx = await fxNodes(ctx, voiceFx()); } catch (err) { console.warn("Couldn't start the voice changer:", err); fx = await fxNodes(ctx, VOICE_FX.off); }
  // Takes out rumble under 90 Hz (desk thumps, hum, a bumped mic) before anything else hears it.
  let front = ctx.createGain();
  if (filtersOn()) {
    front = ctx.createBiquadFilter();
    front.type = 'highpass';
    front.frequency.value = 90;
  }
  const gain = ctx.createGain();
  gain.gain.value = voicePrefs.inputVolume;
  let gate = null;
  if (wantsGate()) {
    try { gate = new AudioWorkletNode(ctx, 'burrow-gate', { numberOfInputs: 2, outputChannelCount: [channels] }); } catch (err) { console.warn("Couldn't start the voice gate:", err); }
  }
  const out = ctx.createMediaStreamDestination();
  out.channelCount = channels;
  // The speech channel goes to the gate; on Strong, the voice channel carries on as usual.
  const split = speech && gate ? ctx.createChannelSplitter(2) : null;
  if (split) {
    speech.connect(split);
    split.connect(gate, 1, 1);
    if (speech !== filter) front.connect(speech);
  }
  if (filter) {
    if (split && speech === filter) split.connect(fx.input, 0);
    else filter.connect(fx.input);
    front.connect(filter);
  } else front.connect(fx.input);
  fx.output.connect(gain);
  if (gate) gain.connect(gate).connect(out);
  else gain.connect(out);
  let source = null;
  const chain = {
    track: out.stream.getAudioTracks()[0],
    filtered: !!filter,
    gain, // how loud you are before the gate, for the level meter
    gated: !!gate,
    auto: !!split, // the gate follows your speech
    setInput(t) {
      source?.disconnect();
      source = ctx.createMediaStreamSource(new MediaStream([t]));
      source.connect(front);
    },
    setVolume(v) { gain.gain.setTargetAtTime(v, ctx.currentTime, 0.02); },
    /** Push to talk held or not, and the sensitivity, for the gate. */
    setGate(settings) { gate?.port.postMessage({ ...settings, auto: settings.auto && !!split }); },
    destroy() {
      source?.disconnect();
      front.disconnect();
      for (const node of new Set([filter, speech])) {
        node?.port.postMessage('destroy');
        node?.disconnect();
      }
      split?.disconnect();
      fx.destroy();
      gain.disconnect();
      gate?.disconnect();
      chain.track.stop();
    },
  };
  chain.setGate(gateSettings());
  chain.setInput(track);
  return chain;
}

let pttHeld = false; // your push-to-talk key is down
/** What the gate needs to know: push to talk and whether it's held, the automatic gate, or the sensitivity. */
const gateSettings = () => ({
  ptt: voicePrefs.mode === 'ptt',
  held: pttHeld,
  auto: autoGate(),
  threshold: voicePrefs.music ? null : voicePrefs.sensitivity,
});
function updateGate() {
  state.voice?.micChain?.setGate(gateSettings());
  micTest?.chain?.setGate(gateSettings());
}

/** The same chain as a LiveKit track processor, so what's sent (and encrypted) is the filtered voice. */
function micProcessor(voice) {
  let chain = null;
  const proc = {
    name: 'burrow-mic',
    processedTrack: undefined,
    async init({ track }) {
      voice.micCtx ??= newMicContext();
      keepRunning(voice.micCtx);
      chain?.destroy();
      chain = await micChain(voice.micCtx, track);
      proc.processedTrack = chain.track;
      voice.micChain = chain;
    },
    // A new microphone: same filter, new input, so nothing needs re-sending.
    async restart({ track }) { if (chain) chain.setInput(track); else await proc.init({ track }); },
    async destroy() {
      chain?.destroy();
      if (voice.micChain === chain) voice.micChain = null;
      chain = null;
    },
  };
  return proc;
}

const micTrack = () => state.voice?.room?.localParticipant.getTrackPublication(window.LivekitClient.Track.Source.Microphone)?.audioTrack;

/** Push to talk or the sensitivity changed: the gate is told, or put in (or taken out) if it wasn't there. */
function applyGateChange() {
  const chain = state.voice?.micChain;
  if (chain && chain.gated === wantsGate() && chain.auto === autoGate()) updateGate();
  else applyNoiseLevel();
  if (micTest) startMicTest();
  renderVoiceBar();
}

/** The noise level (or the voice changer) changed mid-call: new browser settings, and the filter swapped. */
async function applyNoiseLevel() {
  const voice = state.voice, track = micTrack();
  if (!voice || !track) return;
  try {
    const deviceId = voice.room.getActiveDevice('audioinput');
    voice.room.options.audioCaptureDefaults = { ...voice.room.options.audioCaptureDefaults, ...micConstraints() };
    await track.restartTrack({ ...micConstraints(), ...(deviceId ? { deviceId } : {}) });
    if (wantsMicProcessor()) await track.setProcessor(micProcessor(voice));
    else if (track.getProcessor()) await track.stopProcessor();
  } catch (err) {
    console.warn("Couldn't change noise isolation:", err);
  }
}

function applyInputVolume() {
  const track = micTrack();
  if (!track) return;
  if (state.voice.micChain) state.voice.micChain.setVolume(voicePrefs.inputVolume);
  else if (wantsMicProcessor()) track.setProcessor(micProcessor(state.voice)).catch((err) => console.warn("Couldn't change your volume:", err));
}

// ---- trying your microphone and camera

let micTest = null; // { stream, ctx, chain, audio, frame }

async function startMicTest() {
  stopMicTest();
  const test = {};
  micTest = test;
  test.ctx = newMicContext(); // made during the click, so it isn't paused
  try {
    const deviceId = await deviceIdFor('audioinput');
    test.stream = await navigator.mediaDevices.getUserMedia({ audio: { ...micConstraints(), ...(deviceId ? { deviceId } : {}) } });
    if (micTest !== test) return test.stream.getTracks().forEach((t) => t.stop());
    test.chain = await micChain(test.ctx, test.stream.getAudioTracks()[0]);
    if (micTest !== test) return stopMicTest(test);
    const analyser = test.ctx.createAnalyser();
    analyser.fftSize = 1024;
    // The meter shows how loud you are before the gate, so you can see where your sensitivity sits.
    test.chain.gain.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const draw = () => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += v * v;
      const db = 20 * Math.log10(Math.sqrt(sum / samples.length) || 1e-8);
      const bar = $('#vs-level');
      if (bar) bar.style.width = `${Math.max(0, Math.min(100, (db + 60) * (100 / 60)))}%`;
      test.frame = requestAnimationFrame(draw);
    };
    draw();
    // "Hear yourself": played back through the speakers you picked.
    test.audio = new Audio();
    test.audio.srcObject = new MediaStream([test.chain.track]);
    test.audio.muted = !$('#vs-loopback')?.checked;
    const out = await deviceIdFor('audiooutput');
    if (out && test.audio.setSinkId) await test.audio.setSinkId(out).catch(() => {});
    test.audio.play().catch(() => {});
    $('#vs-test-status').textContent = test.chain.filtered || !NOISE_LEVELS[voicePrefs.noise].model ? '' : "This device couldn't load the noise filter, so it's off.";
  } catch (err) {
    if (micTest === test) {
      stopMicTest();
      $('#vs-test-status').textContent = mediaError(err, 'microphone');
    }
    return;
  }
  fillDeviceLists(); // names show once there's permission
  renderMicTest();
}

function stopMicTest(test = micTest) {
  if (!test) return;
  if (micTest === test) micTest = null;
  cancelAnimationFrame(test.frame);
  test.audio?.pause();
  test.chain?.destroy();
  test.stream?.getTracks().forEach((t) => t.stop());
  test.ctx?.close().catch(() => {});
  if ($('#vs-level')) $('#vs-level').style.width = '0';
  renderMicTest();
}
function renderMicTest() {
  if ($('#vs-test')) $('#vs-test').textContent = micTest ? 'Stop' : 'Test';
}

let cameraPreview = null;
async function startCameraPreview() {
  stopCameraPreview();
  const preview = {};
  cameraPreview = preview;
  try {
    const deviceId = await deviceIdFor('videoinput');
    preview.stream = await navigator.mediaDevices.getUserMedia({ video: deviceId ? { deviceId } : true });
    if (cameraPreview !== preview) return preview.stream.getTracks().forEach((t) => t.stop());
    let shown = preview.stream;
    if (cameraBackground() !== 'off') {
      $('#vs-cam-status').textContent = 'Getting the background ready…';
      try {
        preview.background = await startBackground(preview.stream.getVideoTracks()[0]);
        shown = new MediaStream([preview.background.track]);
        $('#vs-cam-status').textContent = '';
      } catch (err) {
        $('#vs-cam-status').textContent = `Couldn't change the background: ${err.message}`;
      }
      if (cameraPreview !== preview) { preview.background?.stop(); return preview.stream.getTracks().forEach((t) => t.stop()); }
    }
    $('#vs-preview').srcObject = shown;
    $('#vs-preview').classList.remove('hidden');
    $('#vs-cam').textContent = 'Stop preview';
    fillDeviceLists();
  } catch (err) {
    if (cameraPreview === preview) stopCameraPreview();
    $('#vs-cam-status').textContent = mediaError(err, 'camera');
  }
}
function stopCameraPreview() {
  cameraPreview?.background?.stop();
  cameraPreview?.stream?.getTracks().forEach((t) => t.stop());
  cameraPreview = null;
  if (!$('#vs-preview')) return;
  $('#vs-preview').srcObject = null;
  $('#vs-preview').classList.add('hidden');
  $('#vs-cam').textContent = 'Preview camera';
}

// ---- camera background: blurred, or swapped for a picture, on your own device before it's sent
//
// MediaPipe's selfie segmenter (vendor/mediapipe) finds you in each frame; the rest is blurred or
// replaced. It's only downloaded the first time someone turns this on.

const BACKGROUNDS = { off: 'Off', blur: 'Blur', picture: 'A picture' };
const cameraBackground = () => (BACKGROUNDS[voicePrefs.background] ? voicePrefs.background : 'off');
let backgroundPicture = null; // an ImageBitmap of the picture, once loaded
let segmenterLoading = null;
let segmentTime = 0;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = src;
    tag.onload = resolve;
    tag.onerror = () => reject(new Error(`Couldn't load ${src}`));
    document.head.append(tag);
  });
}
function loadSegmenter() {
  segmenterLoading ??= (async () => {
    if (!window.MediaPipeVision) await loadScript('vendor/mediapipe/vision.js');
    const { ImageSegmenter } = window.MediaPipeVision;
    const model = new Uint8Array(await (await fetch('vendor/mediapipe/selfie_segmenter.tflite')).arrayBuffer());
    const base = new URL('vendor/mediapipe/', location.href).href;
    return ImageSegmenter.createFromOptions(
      { wasmLoaderPath: base + 'vision_wasm_internal.js', wasmBinaryPath: base + 'vision_wasm_internal.wasm' },
      { baseOptions: { modelAssetBuffer: model, delegate: 'CPU' }, runningMode: 'VIDEO', outputCategoryMask: false, outputConfidenceMasks: true },
    );
  })().catch((err) => {
    segmenterLoading = null;
    throw err;
  });
  return segmenterLoading;
}
async function loadBackgroundPicture() {
  const data = store.get('cameraPicture');
  if (!data) return (backgroundPicture = null);
  try { backgroundPicture = await createImageBitmap(await (await fetch(data)).blob()); } catch { backgroundPicture = null; }
  return backgroundPicture;
}

/**
 * Draws one camera frame with its background changed. `source` is a video element or a
 * VideoFrame; the result lands on `out`.
 */
function paintBackground(seg, source, w, h, parts) {
  const { out, person, mask, small } = parts;
  out.width = person.width = w;
  out.height = person.height = h;
  let maskData = null;
  segmentTime = Math.max(segmentTime + 1, performance.now());
  seg.segmentForVideo(source, segmentTime, (result) => {
    const conf = result.confidenceMasks?.[0];
    if (!conf) return;
    const values = conf.getAsFloat32Array();
    if (mask.width !== conf.width || mask.height !== conf.height) Object.assign(mask, { width: conf.width, height: conf.height });
    maskData = new ImageData(conf.width, conf.height);
    for (let i = 0; i < values.length; i++) maskData.data[i * 4 + 3] = Math.min(255, Math.max(0, (values[i] - 0.15) * 340));
    result.close?.();
  });
  const ctx = out.getContext('2d');
  // The background: blurred, or the picture filling the frame.
  if (cameraBackground() === 'picture' && backgroundPicture) {
    const p = backgroundPicture;
    const scale = Math.max(w / p.width, h / p.height);
    ctx.drawImage(p, (w - p.width * scale) / 2, (h - p.height * scale) / 2, p.width * scale, p.height * scale);
  } else if ('filter' in ctx) {
    ctx.filter = 'blur(14px)';
    ctx.drawImage(source, -20, -20, w + 40, h + 40);
    ctx.filter = 'none';
  } else {
    // No canvas blur (older Safari): drawing it tiny and back up is close enough.
    small.width = Math.max(1, Math.round(w / 24));
    small.height = Math.max(1, Math.round(h / 24));
    small.getContext('2d').drawImage(source, 0, 0, small.width, small.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(small, 0, 0, w, h);
  }
  if (!maskData) return;
  mask.getContext('2d').putImageData(maskData, 0, 0);
  // You, cut out along the mask with soft edges, on top.
  const pc = person.getContext('2d');
  pc.globalCompositeOperation = 'copy';
  pc.drawImage(source, 0, 0, w, h);
  pc.globalCompositeOperation = 'destination-in';
  if ('filter' in pc) pc.filter = 'blur(2px)';
  pc.drawImage(mask, 0, 0, w, h);
  if ('filter' in pc) pc.filter = 'none';
  pc.globalCompositeOperation = 'source-over';
  ctx.drawImage(person, 0, 0);
}

/** Starts changing a camera track's background. Resolves to { track, stop }. */
async function startBackground(track) {
  const seg = await loadSegmenter();
  if (cameraBackground() === 'picture' && !backgroundPicture) await loadBackgroundPicture();
  const make = () => document.createElement('canvas');
  const parts = { out: make(), person: make(), mask: make(), small: make() };
  let stopped = false;
  // Chrome, Edge and the desktop app hand over frames directly, which keeps going in a background tab.
  if (window.MediaStreamTrackProcessor && window.MediaStreamTrackGenerator) {
    const processor = new MediaStreamTrackProcessor({ track });
    const generator = new MediaStreamTrackGenerator({ kind: 'video' });
    const reader = processor.readable.getReader();
    const writer = generator.writable.getWriter();
    (async () => {
      while (!stopped) {
        const { value: frame, done } = await reader.read().catch(() => ({ done: true }));
        if (done || !frame) break;
        try {
          if (cameraBackground() === 'off' || stopped) { await writer.write(frame); continue; }
          paintBackground(seg, frame, frame.displayWidth, frame.displayHeight, parts);
          const next = new VideoFrame(parts.out, { timestamp: frame.timestamp });
          frame.close();
          await writer.write(next);
        } catch (err) {
          try { frame.close(); } catch {}
          if (!stopped) console.warn('Camera background:', err);
        }
      }
    })();
    return {
      track: generator,
      stop() {
        stopped = true;
        reader.cancel().catch(() => {});
        generator.stop();
      },
    };
  }
  // Elsewhere: through a video element and a canvas.
  const video = Object.assign(document.createElement('video'), { muted: true, playsInline: true, srcObject: new MediaStream([track]) });
  await video.play().catch(() => {});
  const out = parts.out.captureStream(30).getVideoTracks()[0];
  const tick = () => {
    if (stopped) return;
    if (video.videoWidth) {
      try { paintBackground(seg, video, video.videoWidth, video.videoHeight, parts); } catch (err) { console.warn('Camera background:', err); }
    }
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick);
    else setTimeout(tick, 33);
  };
  tick();
  return {
    track: out,
    stop() {
      stopped = true;
      out.stop();
      video.srcObject = null;
    },
  };
}

/** The same, as a LiveKit track processor, so it's applied before the camera is sent. */
function backgroundProcessor() {
  let run = null;
  const processor = {
    name: 'burrow-background',
    processedTrack: undefined,
    async init({ track }) {
      run = await startBackground(track);
      processor.processedTrack = run.track;
    },
    async restart({ track }) {
      run?.stop();
      run = await startBackground(track);
      processor.processedTrack = run.track;
    },
    async destroy() {
      run?.stop();
      run = null;
    },
  };
  return processor;
}

/** Turns the background change on or off on a camera that's already on. */
async function applyCameraBackground() {
  const LK = window.LivekitClient;
  const track = state.voice?.room?.localParticipant.getTrackPublication(LK?.Track.Source.Camera)?.track;
  if (!track) return;
  const has = track.getProcessor?.()?.name === 'burrow-background';
  try {
    if (cameraBackground() !== 'off' && !has) await track.setProcessor(backgroundProcessor());
    else if (cameraBackground() === 'off' && has) await track.stopProcessor();
  } catch (err) {
    toast(`Couldn't change your background: ${err.message}`);
  }
}

/** A picture picked for the background, kept on this device only. */
async function pickBackgroundPicture(file) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  img.close();
  store.set('cameraPicture', canvas.toDataURL('image/jpeg', 0.85));
  return loadBackgroundPicture();
}

// ---- the settings themselves: in your account, and from the gear on the voice bar

/** The sensitivity line on the level meter: only when you've set one yourself. */
const showsLine = () => voicePrefs.mode !== 'ptt' && !voicePrefs.autoGate && voicePrefs.sensitivity !== null;

function voiceSettings() {
  const pct = (v) => Math.round(v * 100);
  const outputNote = isAppleMobile
    ? 'Sound plays wherever your iPhone or iPad sends it. To switch to AirPods or a speaker, use Control Center.'
    : "This browser can't pick where sound plays, so it uses your system's choice. Chrome, Edge and the Peiskos desktop app can pick.";
  return `<h3>Voice and video</h3>
    <div class="voice-settings">
      <label>Microphone<select id="vs-audioinput"></select></label>
      <div class="mic-test">
        <div class="level-meter" title="How loud you are, after the noise filter"><span id="vs-level"></span><i id="vs-line" class="${showsLine() ? '' : 'hidden'}" style="left:${((voicePrefs.sensitivity ?? -45) + 60) * (100 / 60)}%"></i></div>
        <button type="button" class="btn secondary" id="vs-test">Test</button>
      </div>
      <label class="check"><input type="checkbox" id="vs-loopback" /> Hear yourself while testing (wear headphones)</label>
      <span class="small muted" id="vs-test-status"></span>
      <label>Your volume <span class="range-value" id="vs-in-val">${pct(voicePrefs.inputVolume)}%</span>
        <input type="range" id="vs-in" min="0" max="200" step="5" value="${pct(voicePrefs.inputVolume)}" /></label>
      <label>Noise isolation
        <select id="vs-noise">${Object.entries(NOISE_LEVELS).map(([k, n]) => `<option value="${k}" ${voicePrefs.noise === k ? 'selected' : ''}>${n.label}</option>`).join('')}</select></label>
      <span class="small muted" id="vs-noise-hint">${NOISE_LEVELS[voicePrefs.noise]?.hint ?? ''}</span>
      <div class="vs-group">
        <span class="vs-label">How you talk</span>
        <div class="kind-choice">
          <label><input type="radio" name="vs-mode" value="voice" ${voicePrefs.mode !== 'ptt' ? 'checked' : ''} /> When you speak</label>
          <label><input type="radio" name="vs-mode" value="ptt" ${voicePrefs.mode === 'ptt' ? 'checked' : ''} /> Push to talk</label>
        </div>
        <div class="key-row ${voicePrefs.mode === 'ptt' ? '' : 'hidden'}" id="vs-ptt-row"><span>Hold to talk</span><button type="button" class="btn secondary key-btn" id="vs-key-ptt">${escapeHtml(keyLabel(voicePrefs.keys.ptt))}</button></div>
        <div class="${voicePrefs.mode === 'ptt' ? 'hidden' : ''}" id="vs-sens-row">
          <label class="check"><input type="checkbox" id="vs-auto" ${voicePrefs.autoGate ? 'checked' : ''} /> Only send my voice when I'm talking (automatic)</label>
          <span class="small muted">Leaves out typing, clicks and noise between your words. Needs noise isolation on.</span>
          <div class="${voicePrefs.autoGate ? 'hidden' : ''}" id="vs-manual">
            <label class="check"><input type="checkbox" id="vs-sens-on" ${voicePrefs.sensitivity !== null ? 'checked' : ''} /> Only send my voice when it's louder than the line</label>
            <input type="range" id="vs-sens" min="-60" max="0" step="1" value="${voicePrefs.sensitivity ?? -45}" ${voicePrefs.sensitivity === null ? 'disabled' : ''} aria-label="Sensitivity" />
            <span class="small muted">Press Test and talk: the bar should pass the line when you speak, and stay under it when you don't.</span>
          </div>
        </div>
      </div>
      <label>Voice changer
        <select id="vs-fx">${Object.entries(VOICE_FX).map(([k, f]) => `<option value="${k}" ${voicePrefs.fx === k ? 'selected' : ''}>${f.label}</option>`).join('')}</select>
        <span class="small muted">Changes how you sound to everyone. Test it with "Hear yourself".</span></label>
      <label class="check"><input type="checkbox" id="vs-music" ${voicePrefs.music ? 'checked' : ''} /> Music mode</label>
      <span class="small muted">For playing music or an instrument: stereo at 128 kbps, with noise isolation, the voice changer and echo removal off. Use headphones.</span>
      ${canPickOutput ? '<label>Speakers or headset<select id="vs-audiooutput"></select></label>' : `<span class="small muted">${outputNote}</span>`}
      <label>Everyone's volume <span class="range-value" id="vs-out-val">${pct(voicePrefs.outputVolume)}%</span>
        <input type="range" id="vs-out" min="0" max="200" step="5" value="${pct(voicePrefs.outputVolume)}" /></label>
      <button type="button" class="link-btn" id="vs-chime">Play a test sound</button>
      <label class="check"><input type="checkbox" id="vs-board" ${voicePrefs.soundboard ? 'checked' : ''} /> Play soundboard sounds</label>
      <div class="vs-group">
        <span class="vs-label">Hotkeys</span>
        <div class="key-row"><span>Mute</span><button type="button" class="btn secondary key-btn" id="vs-key-mute">${escapeHtml(keyLabel(voicePrefs.keys.mute))}</button></div>
        <div class="key-row"><span>Deafen</span><button type="button" class="btn secondary key-btn" id="vs-key-deafen">${escapeHtml(keyLabel(voicePrefs.keys.deafen))}</button></div>
        <span class="small muted" id="vs-hotkey-note"></span>
      </div>
      <label>Camera<select id="vs-videoinput"></select></label>
      <video id="vs-preview" class="cam-preview hidden" autoplay muted playsinline></video>
      <div class="mic-test"><button type="button" class="btn secondary" id="vs-cam">Preview camera</button><span class="small muted" id="vs-cam-status"></span></div>
      <label>Camera background
        <select id="vs-background">${Object.entries(BACKGROUNDS).map(([k, label]) => `<option value="${k}" ${cameraBackground() === k ? 'selected' : ''}>${label}</option>`).join('')}</select>
        <span class="small muted">Done on this device, before your camera is sent.</span></label>
      <div class="mic-test ${cameraBackground() === 'picture' ? '' : 'hidden'}" id="vs-picture-row"><button type="button" class="btn secondary" id="vs-picture">${store.get('cameraPicture') ? 'Change the picture' : 'Pick a picture'}</button><input type="file" id="vs-picture-file" accept="image/*" hidden /></div>
      <label>Your voice quality
        <select id="voice-quality">${Object.entries(VOICE_QUALITY).map(([k, q]) => `<option value="${k}" ${voicePrefs.quality === k ? 'selected' : ''}>${q.label}</option>`).join('')}</select>
      </label>
      <span class="small muted">Voice quality changes the next time you join a voice room. Everything else changes straight away.</span>
    </div>`;
}

/** Fills in the device lists. Before Burrow may use your microphone, browsers hide the names. */
async function fillDeviceLists() {
  const devices = await listDevices();
  let unnamed = false;
  for (const kind of Object.keys(DEVICE_NAMES)) {
    const select = $(`#vs-${kind}`);
    if (!select) continue;
    const list = devices.filter((d) => d.kind === kind);
    const saved = savedDevices[kind];
    const chosen = saved && (list.find((d) => d.deviceId === saved.id) ?? list.find((d) => saved.label && d.label === saved.label));
    select.replaceChildren(new Option('System default', ''), ...list.map((d, i) => {
      unnamed ||= !d.label;
      const o = new Option(d.label || `${DEVICE_NAMES[kind]} ${i + 1}`, d.deviceId);
      o.dataset.label = d.label;
      return o;
    }));
    if (saved && !chosen) {
      const o = new Option(`${saved.label || DEVICE_NAMES[kind]} (not found)`, saved.id);
      o.dataset.label = saved.label ?? '';
      select.append(o);
    }
    select.value = chosen?.deviceId ?? saved?.id ?? '';
  }
  const status = $('#vs-test-status');
  if (status && unnamed && !micTest && !status.textContent) status.textContent = 'Press Test to see your devices by name.';
  if (status && !unnamed && status.textContent.startsWith('Press Test')) status.textContent = '';
}

function wireVoiceSettings() {
  fillDeviceLists();
  navigator.mediaDevices?.addEventListener('devicechange', fillDeviceLists);
  for (const kind of Object.keys(DEVICE_NAMES)) {
    const select = $(`#vs-${kind}`);
    if (!select) continue;
    select.onchange = async () => {
      await pickDevice(kind, select.value, select.selectedOptions[0]?.dataset.label ?? '');
      if (kind === 'audioinput' && micTest) startMicTest();
      if (kind === 'audiooutput' && micTest?.audio?.setSinkId) micTest.audio.setSinkId((await deviceIdFor('audiooutput')) ?? '').catch(() => {});
      if (kind === 'videoinput' && cameraPreview) startCameraPreview();
    };
  }
  $('#vs-test').onclick = () => (micTest ? stopMicTest() : startMicTest());
  $('#vs-loopback').onchange = (e) => { if (micTest?.audio) micTest.audio.muted = !e.target.checked; };
  const slider = (sel, key, apply) => {
    $(sel).oninput = (e) => {
      voicePrefs[key] = Number(e.target.value) / 100;
      $(`${sel}-val`).textContent = `${e.target.value}%`;
      apply();
    };
    $(sel).onchange = saveVoicePrefs;
  };
  slider('#vs-in', 'inputVolume', () => { micTest?.chain?.setVolume(voicePrefs.inputVolume); applyInputVolume(); });
  slider('#vs-out', 'outputVolume', applyAllVolumes);
  $('#vs-noise').onchange = (e) => {
    voicePrefs.noise = e.target.value;
    saveVoicePrefs();
    $('#vs-noise-hint').textContent = NOISE_LEVELS[voicePrefs.noise].hint;
    if (state.voice && wantsMicProcessor()) state.voice.micCtx ??= newMicContext(); // during the click, so it isn't paused
    applyNoiseLevel();
    if (micTest) startMicTest();
  };
  $('#vs-chime').onclick = () => playSound('join', true);
  $('#vs-board').onchange = (e) => { voicePrefs.soundboard = e.target.checked; saveVoicePrefs(); };
  for (const r of document.querySelectorAll('#modal-card [name="vs-mode"]')) r.onchange = () => {
    voicePrefs.mode = r.value;
    saveVoicePrefs();
    $('#vs-ptt-row').classList.toggle('hidden', r.value !== 'ptt');
    $('#vs-sens-row').classList.toggle('hidden', r.value === 'ptt');
    $('#vs-line').classList.toggle('hidden', !showsLine());
    if (state.voice && wantsMicProcessor()) state.voice.micCtx ??= newMicContext();
    applyGateChange();
    syncHotkeys();
  };
  const showLine = () => {
    $('#vs-line').style.left = `${(Number($('#vs-sens').value) + 60) * (100 / 60)}%`;
    $('#vs-line').classList.toggle('hidden', !showsLine());
  };
  $('#vs-auto').onchange = (e) => {
    voicePrefs.autoGate = e.target.checked;
    saveVoicePrefs();
    $('#vs-manual').classList.toggle('hidden', voicePrefs.autoGate);
    showLine();
    if (state.voice && wantsMicProcessor()) state.voice.micCtx ??= newMicContext();
    applyGateChange();
  };
  $('#vs-sens-on').onchange = (e) => {
    voicePrefs.sensitivity = e.target.checked ? Number($('#vs-sens').value) : null;
    $('#vs-sens').disabled = !e.target.checked;
    saveVoicePrefs();
    showLine();
    if (state.voice && wantsMicProcessor()) state.voice.micCtx ??= newMicContext();
    applyGateChange();
  };
  $('#vs-sens').oninput = () => {
    voicePrefs.sensitivity = Number($('#vs-sens').value);
    showLine();
    updateGate();
  };
  $('#vs-sens').onchange = saveVoicePrefs;
  $('#vs-fx').onchange = (e) => {
    voicePrefs.fx = e.target.value;
    saveVoicePrefs();
    if (state.voice && wantsMicProcessor()) state.voice.micCtx ??= newMicContext();
    applyNoiseLevel();
    if (micTest) startMicTest();
  };
  $('#vs-music').onchange = (e) => {
    voicePrefs.music = e.target.checked;
    saveVoicePrefs();
    if (state.voice && wantsMicProcessor()) state.voice.micCtx ??= newMicContext();
    republishMic();
    if (micTest) startMicTest();
  };
  for (const name of ['ptt', 'mute', 'deafen']) $(`#vs-key-${name}`).onclick = (e) => captureKey(name, e.currentTarget);
  renderHotkeyNote();
  $('#vs-cam').onclick = () => (cameraPreview ? stopCameraPreview() : startCameraPreview());
  const backgroundChanged = () => {
    applyCameraBackground();
    if (cameraPreview) startCameraPreview();
  };
  $('#vs-background').onchange = (e) => {
    voicePrefs.background = e.target.value;
    saveVoicePrefs();
    $('#vs-picture-row').classList.toggle('hidden', e.target.value !== 'picture');
    if (e.target.value === 'picture' && !store.get('cameraPicture')) return $('#vs-picture-file').click();
    if (e.target.value === 'picture') loadBackgroundPicture();
    backgroundChanged();
  };
  $('#vs-picture').onclick = () => $('#vs-picture-file').click();
  $('#vs-picture-file').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      await pickBackgroundPicture(file);
      $('#vs-picture').textContent = 'Change the picture';
      backgroundChanged();
    } catch {
      alert("Couldn't open that picture.");
    }
  };
  $('#voice-quality').onchange = (e) => { voicePrefs.quality = e.target.value; saveVoicePrefs(); };
  // Whatever closes the settings stops the test and the preview.
  const closing = onModalClose;
  onModalClose = () => {
    closing?.();
    stopMicTest();
    stopCameraPreview();
    navigator.mediaDevices?.removeEventListener('devicechange', fillDeviceLists);
  };
}

function openVoiceSettings() {
  modal(`${voiceSettings().replace('<h3>Voice and video</h3>', '<h2>Voice and video</h2>')}
    <div class="modal-row"><button class="btn secondary" data-close>Done</button></div>`, 'sheet');
  wireVoiceSettings();
}

// Your own theme color, on a color wheel: the angle is the hue, the distance from the middle is
// how strong it is. theme.js turns it into the actual colors for light and dark.
const THEME_PRESETS = [
  { name: 'Glød', color: null },
  { name: 'Forest', color: { h: 147, s: 45 } },
  { name: 'Fjord', color: { h: 205, s: 70 } },
  { name: 'Heather', color: { h: 280, s: 55 } },
  { name: 'Cloudberry', color: { h: 32, s: 85 } },
  { name: 'Lingonberry', color: { h: 355, s: 75 } },
  { name: 'Slate', color: { h: 215, s: 10 } },
];
const savedThemeColor = () => { try { return JSON.parse(store.get('themeColor')); } catch { return null; } };
const OWN_EMBER = { h: 21, s: 75 }; // where the dot sits for Peiskos's own colors

function themeSettings() {
  const chip = (p, i) => {
    const c = p.color ?? OWN_EMBER;
    return `<button type="button" class="swatch" data-preset="${i}" title="${p.name}" style="background: hsl(${c.h} ${c.s}% 42%)"></button>`;
  };
  return `<h3>Theme color</h3>
    <div class="theme-picker">
      <div class="wheel" id="theme-wheel" tabindex="0" role="slider" aria-label="Theme color"><span class="wheel-dot" id="theme-dot"></span></div>
      <div class="theme-side">
        <div class="color-row">${THEME_PRESETS.map(chip).join('')}</div>
        <span class="small muted">Drag around the wheel to pick a color; nearer the middle is softer. It works with both light and dark, and only changes Peiskos for you.</span>
        <div><button type="button" class="btn secondary" id="theme-reset">Back to ember</button></div>
      </div>
    </div>`;
}

function wireThemeSettings() {
  const wheel = $('#theme-wheel');
  let color = savedThemeColor();
  const show = () => {
    const c = color ?? OWN_EMBER;
    const r = (c.s / 100) * 50, a = (c.h * Math.PI) / 180;
    $('#theme-dot').style.left = `${50 + Math.sin(a) * r}%`;
    $('#theme-dot').style.top = `${50 - Math.cos(a) * r}%`;
    $('#theme-dot').style.background = `hsl(${c.h} ${c.s}% 50%)`;
    wheel.setAttribute('aria-valuetext', color ? `hue ${Math.round(c.h)}, strength ${Math.round(c.s)}%` : 'ember');
  };
  const use = (c, save) => {
    color = c;
    window.applyThemeColor(c);
    if (save) store.set('themeColor', c ? JSON.stringify(c) : null);
    show();
  };
  const pick = (e) => {
    const box = wheel.getBoundingClientRect();
    const dx = e.clientX - (box.left + box.width / 2), dy = e.clientY - (box.top + box.height / 2);
    const h = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
    const s = Math.min(1, Math.hypot(dx, dy) / (box.width / 2)) * 100;
    use({ h: Math.round(h), s: Math.round(s) }, false);
  };
  wheel.onpointerdown = (e) => { wheel.setPointerCapture(e.pointerId); pick(e); };
  wheel.onpointermove = (e) => { if (wheel.hasPointerCapture(e.pointerId)) pick(e); };
  wheel.onpointerup = () => use(color, true);
  wheel.onkeydown = (e) => {
    const c = { ...(color ?? OWN_EMBER) };
    if (e.key === 'ArrowLeft') c.h = (c.h + 355) % 360;
    else if (e.key === 'ArrowRight') c.h = (c.h + 5) % 360;
    else if (e.key === 'ArrowUp') c.s = Math.min(100, c.s + 5);
    else if (e.key === 'ArrowDown') c.s = Math.max(0, c.s - 5);
    else return;
    e.preventDefault();
    use(c, true);
  };
  $('#modal-card').querySelectorAll('[data-preset]').forEach((b) => (b.onclick = () => use(THEME_PRESETS[b.dataset.preset].color, true)));
  $('#theme-reset').onclick = () => use(null, true);
  show();
}

function soundSettings() {
  return `<h3>Sounds</h3>
    <label class="check"><input type="checkbox" id="sound-messages" ${soundPrefs.messages ? 'checked' : ''} /> New messages</label>
    <label class="check"><input type="checkbox" id="sound-voice" ${soundPrefs.voice ? 'checked' : ''} /> People joining and leaving voice</label>
    <label>Sound volume
      <div class="sound-volume"><input type="range" id="sound-volume" min="0" max="100" step="5" value="${Math.round(soundPrefs.volume * 100)}" /><button type="button" class="btn secondary" id="sound-test">Test</button></div>
    </label>`;
}
function wireSoundSettings() {
  $('#sound-messages').onchange = (e) => { soundPrefs.messages = e.target.checked; saveSoundPrefs(); };
  $('#sound-voice').onchange = (e) => { soundPrefs.voice = e.target.checked; saveSoundPrefs(); };
  $('#sound-volume').oninput = (e) => { soundPrefs.volume = Number(e.target.value) / 100; saveSoundPrefs(); };
  $('#sound-volume').onchange = () => playSound('message', true);
  $('#sound-test').onclick = () => playSound('message', true);
}
