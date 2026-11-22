// AudioWorklet processors (run on the audio thread).
// - dawg-recorder: passes audio through and, while recording, sends the samples to the app.
// - dawg-autotune: pitch detection (YIN) + pitch shifting to the nearest note of a key/scale.

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.buf = [];
    this.size = 0;
    this.port.onmessage = (e) => {
      if (e.data.cmd === 'start') {
        this.recording = true;
        this.buf = [];
        this.size = 0;
        this.port.postMessage({ type: 'started', time: currentTime, frame: currentFrame });
      } else if (e.data.cmd === 'stop') {
        this.flush();
        this.recording = false;
        this.port.postMessage({ type: 'stopped' });
      }
    };
  }

  flush() {
    if (!this.size) return;
    const out = new Float32Array(this.size);
    let o = 0;
    for (const b of this.buf) { out.set(b, o); o += b.length; }
    this.port.postMessage({ type: 'data', data: out }, [out.buffer]);
    this.buf = [];
    this.size = 0;
  }

  process(inputs, outputs) {
    const inp = inputs[0];
    const out = outputs[0];
    if (inp && inp.length) {
      for (let c = 0; c < out.length; c++) out[c].set(inp[Math.min(c, inp.length - 1)]);
      if (this.recording) {
        // mono mix of the input
        const n = inp[0].length;
        const m = new Float32Array(n);
        for (let c = 0; c < inp.length; c++) { const ch = inp[c]; for (let i = 0; i < n; i++) m[i] += ch[i] / inp.length; }
        this.buf.push(m);
        this.size += n;
        if (this.size >= 16384) this.flush();
      }
    }
    return true;
  }
}
registerProcessor('dawg-recorder', RecorderProcessor);

// ---------------- autotune ----------------
const SCALES = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
};

class AutotuneProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'amount', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'speed', defaultValue: 0.02, minValue: 0, maxValue: 1, automationRate: 'k-rate' }, // seconds
      { name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.key = 0;
    this.scale = SCALES.major;
    this.port.onmessage = (e) => {
      if (e.data.key != null) this.key = e.data.key;
      if (e.data.scale) this.scale = SCALES[e.data.scale] || SCALES.chromatic;
      if (e.data.debug) this.debug = true;
    };
    // analysis ring buffer (downsampled by 2)
    this.anaSize = 2048;
    this.ana = new Float32Array(this.anaSize);
    this.anaPos = 0;
    this.dsToggle = 0;
    this.hop = 256; // downsampled samples between pitch detections
    this.sinceHop = 0;
    this.shift = 0; // current shift in semitones (smoothed)
    this.target = 0;
    // pitch shifter delay line
    this.N = Math.round(sampleRate * 0.03); // grain window
    this.lineSize = 8192;
    this.line = new Float32Array(this.lineSize);
    this.w = 0;
    this.phase = 0;
    this.d = new Float32Array(400);
    this.detected = 0;
  }

  detect() {
    // YIN on the newest 1024 downsampled samples
    const sr = sampleRate / 2;
    const W = 512;
    const tauMin = Math.floor(sr / 1000);
    const tauMax = Math.min(380, Math.floor(sr / 70));
    const a = this.ana;
    const S = this.anaSize;
    const start = (this.anaPos - W - tauMax + S * 4) % S;
    const x = (i) => a[(start + i) % S];
    let energy = 0;
    for (let i = 0; i < W; i++) { const v = x(i); energy += v * v; }
    if (energy / W < 1e-5) return 0; // silence
    const d = this.d;
    let running = 0;
    d[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) {
      let sum = 0;
      for (let i = 0; i < W; i++) { const df = x(i) - x(i + tau); sum += df * df; }
      running += sum;
      d[tau] = running > 0 ? (sum * tau) / running : 1;
    }
    let best = -1;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (d[tau] < 0.15) {
        while (tau + 1 <= tauMax && d[tau + 1] < d[tau]) tau++;
        best = tau;
        break;
      }
    }
    if (best < 0) return 0;
    // parabolic interpolation
    const y0 = d[best - 1] ?? d[best];
    const y1 = d[best];
    const y2 = d[best + 1] ?? d[best];
    const den = y0 - 2 * y1 + y2;
    const t = den !== 0 ? best + (0.5 * (y0 - y2)) / den : best;
    return sr / t;
  }

  targetFor(midi) {
    const sc = this.scale;
    let bestNote = Math.round(midi);
    let bestDist = Infinity;
    for (let n = Math.floor(midi) - 2; n <= Math.ceil(midi) + 2; n++) {
      const pc = (((n - this.key) % 12) + 12) % 12;
      if (!sc.includes(pc)) continue;
      const dist = Math.abs(n - midi);
      if (dist < bestDist) { bestDist = dist; bestNote = n; }
    }
    return bestNote;
  }

  process(inputs, outputs, params) {
    const inp = inputs[0];
    const out = outputs[0];
    if (!inp || !inp.length) return true;
    const amount = params.amount[0];
    const speed = params.speed[0];
    const mix = params.mix[0];
    const n = inp[0].length;
    const mono = inp[0];
    const N = this.N;
    for (let i = 0; i < n; i++) {
      const s = inp.length > 1 ? (inp[0][i] + inp[1][i]) * 0.5 : mono[i];
      // analysis buffer at half rate
      this.dsToggle ^= 1;
      if (this.dsToggle) {
        this.ana[this.anaPos] = s;
        this.anaPos = (this.anaPos + 1) % this.anaSize;
        if (++this.sinceHop >= this.hop) {
          this.sinceHop = 0;
          const f = this.detect();
          if (f > 0) {
            const midi = 69 + 12 * Math.log2(f / 440);
            this.detected = midi;
            this.target = Math.max(-12, Math.min(12, (this.targetFor(midi) - midi) * amount));
            if (this.debug) this.port.postMessage({ f, midi, target: this.target, shift: this.shift });
          } else {
            this.target = 0;
          }
        }
      }
      // smooth toward the target (retune speed)
      if (speed <= 0.001) this.shift = this.target;
      else this.shift += (this.target - this.shift) * (1 - Math.exp(-1 / (speed * sampleRate)));
      const ratio = Math.pow(2, this.shift / 12);
      // write into the delay line
      this.line[this.w] = s;
      // two crossfaded read heads moving at (1 - ratio) samples per sample
      this.phase += (1 - ratio) / N;
      if (this.phase >= 1) this.phase -= 1;
      if (this.phase < 0) this.phase += 1;
      let y = 0;
      for (let k = 0; k < 2; k++) {
        const ph = (this.phase + k * 0.5) % 1;
        const delay = ph * N + 2;
        let rp = this.w - delay;
        while (rp < 0) rp += this.lineSize;
        const i0 = Math.floor(rp);
        const fr = rp - i0;
        const a = this.line[i0 % this.lineSize];
        const b = this.line[(i0 + 1) % this.lineSize];
        const win = Math.sin(Math.PI * ph);
        y += (a + (b - a) * fr) * win * win;
      }
      this.w = (this.w + 1) % this.lineSize;
      const o = y * mix + s * (1 - mix);
      for (let c = 0; c < out.length; c++) out[c][i] = o;
    }
    return true;
  }
}
registerProcessor('dawg-autotune', AutotuneProcessor);
