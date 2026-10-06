// Plays a shared program's sound (sent over by the desktop app in chunks) into the stream.
// Keeps a short buffer so uneven chunks still play smoothly, and drops the oldest sound if
// it falls behind so the stream stays in step with the video.
const CAPACITY = 48000;  // 1 s per channel
const MAX_DELAY = 9600;  // 200 ms: more than this buffered and we skip ahead...
const CATCH_UP = 2880;   // ...to 60 ms
const PRIME = 1440;      // after running dry, wait for 30 ms of sound before playing again

class AppAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = new Float32Array(CAPACITY);
    this.right = new Float32Array(CAPACITY);
    this.read = 0;
    this.size = 0;
    this.playing = false;
    this.port.onmessage = (e) => this.push(e.data);
  }

  /** Interleaved 16-bit stereo, as an ArrayBuffer. */
  push(buffer) {
    const pcm = new Int16Array(buffer);
    const frames = pcm.length >> 1;
    for (let i = 0; i < frames; i++) {
      const at = (this.read + this.size) % CAPACITY;
      this.left[at] = pcm[2 * i] / 32768;
      this.right[at] = pcm[2 * i + 1] / 32768;
      if (this.size < CAPACITY) this.size++;
      else this.read = (this.read + 1) % CAPACITY;
    }
    if (this.size > MAX_DELAY) {
      this.read = (this.read + this.size - CATCH_UP) % CAPACITY;
      this.size = CATCH_UP;
    }
  }

  process(_inputs, outputs) {
    const [l, r] = outputs[0];
    if (!this.playing && this.size >= PRIME) this.playing = true;
    const n = this.playing ? Math.min(l.length, this.size) : 0;
    if (this.playing && this.size <= n) this.playing = false;
    for (let i = 0; i < n; i++) {
      l[i] = this.left[this.read];
      if (r) r[i] = this.right[this.read];
      this.read = (this.read + 1) % CAPACITY;
    }
    this.size -= n;
    l.fill(0, n);
    r?.fill(0, n);
    return true;
  }
}

registerProcessor('app-audio', AppAudio);
