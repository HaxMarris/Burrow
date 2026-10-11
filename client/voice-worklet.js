// Two small processors for your microphone, run on the audio thread:
//
// burrow-gate lets your voice through only while you're talking: louder than your sensitivity
// setting, or while you hold your push-to-talk key. It stays open a moment after you stop, so
// the ends of words aren't cut off, and fades rather than clicks.
//
// burrow-pitch makes your voice deeper or higher. It reads your voice back from a short buffer
// at a different speed, through two overlapping windows, so the length stays the same.

class Gate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.threshold = null; // dB; null lets everything through
    this.ptt = false;
    this.held = false;
    this.openUntil = 0; // in frames
    this.gain = 1;
    this.frame = 0;
    this.port.onmessage = (e) => Object.assign(this, e.data);
  }

  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    const n = output[0]?.length ?? 128;
    let sum = 0, count = 0;
    for (const ch of input) for (let i = 0; i < ch.length; i++) { sum += ch[i] * ch[i]; count++; }
    const db = 20 * Math.log10(Math.sqrt(sum / (count || 1)) || 1e-8);
    let open;
    if (this.ptt) {
      if (this.held) this.openUntil = this.frame + 0.15 * sampleRate;
      open = this.frame < this.openUntil;
    } else if (this.threshold === null) open = true;
    else {
      if (db > this.threshold) this.openUntil = this.frame + 0.3 * sampleRate;
      open = this.frame < this.openUntil;
    }
    // About 10 ms to fade in or out.
    const target = open ? 1 : 0, step = 1 / (0.01 * sampleRate);
    for (let c = 0; c < output.length; c++) {
      const from = input[c] ?? input[0];
      let g = this.gain;
      for (let i = 0; i < n; i++) {
        g = g < target ? Math.min(target, g + step) : Math.max(target, g - step);
        output[c][i] = from ? from[i] * g : 0;
      }
      if (c === output.length - 1) this.gain = g;
    }
    this.frame += n;
    return true;
  }
}

class Pitch extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ratio = options.processorOptions?.ratio ?? 1;
    this.size = 1 << 15;
    this.buf = new Float32Array(this.size);
    this.write = 0;
    this.window = Math.round(0.06 * sampleRate);
    this.phase = 0;
    this.port.onmessage = (e) => { if (e.data.ratio) this.ratio = e.data.ratio; };
  }

  read(delay) {
    const pos = this.write - delay;
    const i = Math.floor(pos), f = pos - i, m = this.size - 1;
    return this.buf[i & m] * (1 - f) + this.buf[(i + 1) & m] * f;
  }

  process(inputs, outputs) {
    const input = inputs[0][0], out = outputs[0];
    const n = out[0].length;
    const w = this.window, step = (1 - this.ratio) / w;
    for (let i = 0; i < n; i++) {
      this.buf[this.write & (this.size - 1)] = input ? input[i] : 0;
      // Two read points half a window apart; each fades in and out (sin²) so together they're steady.
      const a = this.phase, b = (this.phase + 0.5) % 1;
      const y = this.read(a * w + 2) * Math.sin(Math.PI * a) ** 2 + this.read(b * w + 2) * Math.sin(Math.PI * b) ** 2;
      for (const ch of out) ch[i] = y;
      this.write++;
      this.phase = (this.phase + step + 1) % 1;
    }
    return true;
  }
}

registerProcessor('burrow-gate', Gate);
registerProcessor('burrow-pitch', Pitch);
