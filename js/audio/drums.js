// Drum machine: synthesized drum kits (808/909-style circuits modelled in Web Audio).
// Pads use General MIDI drum note numbers, so patterns survive kit changes and
// MIDI drum pads/keyboards play the right sounds.

// ---------- shared helpers ----------
const noiseCache = new WeakMap();
function noiseBuffer(ctx) {
  let b = noiseCache.get(ctx);
  if (!b) {
    const len = ctx.sampleRate * 2;
    b = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    noiseCache.set(ctx, b);
  }
  return b;
}

function noise(ctx, t, dur) {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuffer(ctx);
  s.start(t, Math.random() * 1.5);
  s.stop(t + dur + 0.05);
  return s;
}

function osc(ctx, type, freq, t, dur) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  o.start(t);
  o.stop(t + dur + 0.05);
  return o;
}

function envGain(ctx, t, peak, attack, decay) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  return g;
}

function filt(ctx, type, freq, q = 0.7) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

const driveCurves = new Map();
function driveCurve(amount) {
  const k = Math.round(amount * 100);
  if (!driveCurves.has(k)) {
    const n = 2048;
    const c = new Float32Array(n);
    const a = 1 + amount * 12;
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(a * x) / Math.tanh(a); }
    driveCurves.set(k, c);
  }
  return driveCurves.get(k);
}

// 808 hi-hat oscillator ratios (six detuned square waves)
const METAL = [2, 3, 4.16, 5.43, 6.79, 8.21];
function metal(ctx, t, dur, base = 40) {
  const sum = ctx.createGain();
  sum.gain.value = 0.3;
  for (const r of METAL) osc(ctx, 'square', base * r, t, dur).connect(sum);
  return sum;
}

// ---------- voice types ----------
// Each voice: (ctx, out, t, vel 0..1, p params, s {tune semis, decay mult}) -> { stop(at) } | void
const VOICES = {
  kick(ctx, out, t, v, p, s) {
    const tune = Math.pow(2, s.tune / 12);
    const dec = p.decay * s.decay;
    const o = osc(ctx, p.wave || 'sine', p.fStart * tune, t, dec + 0.1);
    o.frequency.exponentialRampToValueAtTime(p.f0 * tune, t + p.pitchDecay);
    const g = envGain(ctx, t, v, 0.002, dec);
    let node = o.connect(g);
    if (p.drive) {
      const ws = ctx.createWaveShaper();
      ws.curve = driveCurve(p.drive);
      node = node.connect(ws);
    }
    node.connect(out);
    if (p.click) {
      const n = noise(ctx, t, 0.02);
      const cg = envGain(ctx, t, v * p.click, 0.0005, 0.012);
      n.connect(filt(ctx, 'highpass', 1500)).connect(cg).connect(out);
    }
  },
  snare(ctx, out, t, v, p, s) {
    const tune = Math.pow(2, s.tune / 12);
    for (const f of p.tones) {
      const o = osc(ctx, 'triangle', f * tune * 1.3, t, p.toneDecay * s.decay + 0.05);
      o.frequency.exponentialRampToValueAtTime(f * tune, t + 0.02);
      o.connect(envGain(ctx, t, v * (p.toneLevel ?? 0.5), 0.001, p.toneDecay * s.decay)).connect(out);
    }
    const n = noise(ctx, t, p.noiseDecay * s.decay + 0.05);
    n.connect(filt(ctx, 'highpass', p.noiseHp || 1200))
      .connect(filt(ctx, 'lowpass', (p.noiseLp || 9000) * tune))
      .connect(envGain(ctx, t, v * (p.snappy ?? 0.7), 0.001, p.noiseDecay * s.decay))
      .connect(out);
  },
  clap(ctx, out, t, v, p, s) {
    const bp = filt(ctx, 'bandpass', p.freq * Math.pow(2, s.tune / 12), p.q || 1.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    const bursts = p.bursts || 3;
    for (let i = 0; i < bursts; i++) {
      const bt = t + i * 0.011;
      g.gain.setValueAtTime(v * 2.5, bt);
      g.gain.exponentialRampToValueAtTime(v * 0.5, bt + 0.009);
    }
    const tailStart = t + bursts * 0.011;
    g.gain.setValueAtTime(v * 2, tailStart);
    g.gain.exponentialRampToValueAtTime(0.0001, tailStart + p.decay * s.decay);
    noise(ctx, t, bursts * 0.011 + p.decay * s.decay + 0.05).connect(bp).connect(g).connect(out);
  },
  hat(ctx, out, t, v, p, s) {
    const dec = p.decay * s.decay;
    const src = p.noiseOnly ? noise(ctx, t, dec + 0.05) : metal(ctx, t, dec + 0.05, (p.base || 40) * Math.pow(2, s.tune / 12));
    // metallic hats lose most of their energy in the filters, so they need more gain than noise hats
    const g = envGain(ctx, t, v * (p.level || 0.8) * (p.noiseOnly ? 1 : 4.5), 0.001, dec);
    src.connect(filt(ctx, 'bandpass', p.freq || 10000, 0.8)).connect(filt(ctx, 'highpass', p.hp || 7000)).connect(g).connect(out);
    if (p.noiseMix) {
      noise(ctx, t, dec + 0.05).connect(filt(ctx, 'highpass', 8000)).connect(envGain(ctx, t, v * p.noiseMix, 0.001, dec)).connect(out);
    }
    return { stop: (at) => { g.gain.cancelScheduledValues(at); g.gain.setTargetAtTime(0.0001, at, 0.008); } };
  },
  cymbal(ctx, out, t, v, p, s) {
    const dec = p.decay * s.decay;
    const src = metal(ctx, t, dec + 0.1, (p.base || 40) * Math.pow(2, s.tune / 12));
    src.connect(filt(ctx, 'bandpass', p.freq || 6500, 0.6)).connect(filt(ctx, 'highpass', p.hp || 4000))
      .connect(envGain(ctx, t, v * 0.7, 0.002, dec)).connect(out);
    noise(ctx, t, dec + 0.1).connect(filt(ctx, 'highpass', 5000)).connect(envGain(ctx, t, v * (p.wash ?? 0.35), 0.003, dec * 0.8)).connect(out);
    if (p.bell) {
      for (const f of [p.bell, p.bell * 1.5, p.bell * 2.7]) {
        osc(ctx, 'sine', f * Math.pow(2, s.tune / 12), t, dec).connect(envGain(ctx, t, v * 0.12, 0.001, dec * 0.6)).connect(out);
      }
    }
  },
  tom(ctx, out, t, v, p, s) {
    const tune = Math.pow(2, s.tune / 12);
    const dec = p.decay * s.decay;
    const o = osc(ctx, 'sine', p.fStart * tune, t, dec + 0.05);
    o.frequency.exponentialRampToValueAtTime(p.f0 * tune, t + p.pitchDecay);
    o.connect(envGain(ctx, t, v * 0.9, 0.002, dec)).connect(out);
    if (p.noise) noise(ctx, t, 0.05).connect(filt(ctx, 'lowpass', 3000)).connect(envGain(ctx, t, v * p.noise, 0.001, 0.04)).connect(out);
    if (p.ring) osc(ctx, 'triangle', p.ring * tune, t, dec).connect(envGain(ctx, t, v * 0.15, 0.001, dec)).connect(out);
  },
  rim(ctx, out, t, v, p, s) {
    const tune = Math.pow(2, s.tune / 12);
    osc(ctx, 'triangle', p.freq * tune, t, 0.08).connect(filt(ctx, 'highpass', 600)).connect(envGain(ctx, t, v * 0.8, 0.0005, p.decay * s.decay)).connect(out);
    noise(ctx, t, 0.03).connect(filt(ctx, 'bandpass', 3000, 1.5)).connect(envGain(ctx, t, v * 0.4, 0.0005, 0.015)).connect(out);
  },
  cowbell(ctx, out, t, v, p, s) {
    const tune = Math.pow(2, s.tune / 12);
    const dec = p.decay * s.decay;
    const sum = ctx.createGain();
    sum.gain.value = 0.5;
    for (const f of p.freqs) osc(ctx, 'square', f * tune, t, dec + 0.05).connect(sum);
    sum.connect(filt(ctx, 'bandpass', p.freqs[1] * tune, 2)).connect(envGain(ctx, t, v * 1.2, 0.001, dec)).connect(out);
  },
  shaker(ctx, out, t, v, p, s) {
    const dec = p.decay * s.decay;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(v * 0.6, t + (p.attack || 0.012));
    g.gain.exponentialRampToValueAtTime(0.0001, t + (p.attack || 0.012) + dec);
    noise(ctx, t, dec + 0.05).connect(filt(ctx, 'highpass', (p.freq || 6000) * Math.pow(2, s.tune / 12))).connect(g).connect(out);
  },
  conga(ctx, out, t, v, p, s) {
    const tune = Math.pow(2, s.tune / 12);
    const dec = p.decay * s.decay;
    const o = osc(ctx, 'sine', p.f0 * tune * 1.15, t, dec + 0.05);
    o.frequency.exponentialRampToValueAtTime(p.f0 * tune, t + 0.03);
    o.connect(envGain(ctx, t, v * 0.9, 0.001, dec)).connect(out);
    if (p.slap) noise(ctx, t, 0.04).connect(filt(ctx, 'bandpass', 2500, 1)).connect(envGain(ctx, t, v * p.slap, 0.0005, 0.025)).connect(out);
  },
  claves(ctx, out, t, v, p, s) {
    osc(ctx, 'sine', p.freq * Math.pow(2, s.tune / 12), t, 0.1).connect(envGain(ctx, t, v * 0.8, 0.0005, p.decay * s.decay)).connect(out);
  },
  zap(ctx, out, t, v, p, s) {
    const tune = Math.pow(2, s.tune / 12);
    const o = osc(ctx, 'square', p.fStart * tune, t, p.decay * s.decay + 0.05);
    o.frequency.exponentialRampToValueAtTime(p.f0 * tune, t + p.decay * s.decay * 0.8);
    o.connect(filt(ctx, 'lowpass', 3000)).connect(envGain(ctx, t, v * 0.75, 0.001, p.decay * s.decay)).connect(out);
  },
};

// ---------- kits ----------
const P = (note, name, voice, params, extra = {}) => ({ note, name, voice, params, ...extra });

const K808 = [
  P(36, 'Kick', 'kick', { f0: 48, fStart: 140, pitchDecay: 0.06, decay: 0.9, click: 0.12 }),
  P(38, 'Snare', 'snare', { tones: [238, 476], toneDecay: 0.1, noiseDecay: 0.17, snappy: 0.6 }),
  P(39, 'Clap', 'clap', { freq: 1100, decay: 0.22 }),
  P(37, 'Rimshot', 'rim', { freq: 1700, decay: 0.03 }),
  P(42, 'Closed Hat', 'hat', { decay: 0.05 }, { choke: 'hat' }),
  P(46, 'Open Hat', 'hat', { decay: 0.4 }, { chokeBy: 'hat' }),
  P(41, 'Low Tom', 'tom', { f0: 80, fStart: 110, pitchDecay: 0.2, decay: 0.5 }),
  P(45, 'Mid Tom', 'tom', { f0: 120, fStart: 160, pitchDecay: 0.2, decay: 0.4 }),
  P(48, 'High Tom', 'tom', { f0: 170, fStart: 220, pitchDecay: 0.2, decay: 0.35 }),
  P(49, 'Cymbal', 'cymbal', { decay: 1.6 }),
  P(56, 'Cowbell', 'cowbell', { freqs: [540, 800], decay: 0.3 }),
  P(75, 'Claves', 'claves', { freq: 2500, decay: 0.05 }),
  P(70, 'Maracas', 'shaker', { decay: 0.05, freq: 7000, attack: 0.004 }),
];

export const KITS = [
  { id: '808', name: '808 Kit', pads: K808 },
  {
    id: '909', name: '909 Kit',
    pads: [
      P(36, 'Kick', 'kick', { f0: 52, fStart: 230, pitchDecay: 0.035, decay: 0.38, click: 0.45, drive: 0.25 }),
      P(38, 'Snare', 'snare', { tones: [190, 345], toneDecay: 0.08, noiseDecay: 0.22, snappy: 0.9, noiseHp: 1800 }),
      P(39, 'Clap', 'clap', { freq: 1300, decay: 0.28, bursts: 4 }),
      P(37, 'Rimshot', 'rim', { freq: 1900, decay: 0.025 }),
      P(42, 'Closed Hat', 'hat', { decay: 0.045, freq: 11000, noiseMix: 0.3 }, { choke: 'hat' }),
      P(46, 'Open Hat', 'hat', { decay: 0.32, freq: 11000, noiseMix: 0.3 }, { chokeBy: 'hat' }),
      P(41, 'Low Tom', 'tom', { f0: 90, fStart: 150, pitchDecay: 0.1, decay: 0.35, noise: 0.15 }),
      P(45, 'Mid Tom', 'tom', { f0: 130, fStart: 210, pitchDecay: 0.1, decay: 0.3, noise: 0.15 }),
      P(48, 'High Tom', 'tom', { f0: 180, fStart: 280, pitchDecay: 0.1, decay: 0.28, noise: 0.15 }),
      P(49, 'Crash', 'cymbal', { decay: 1.8, freq: 7500, wash: 0.5 }),
      P(51, 'Ride', 'cymbal', { decay: 1.4, freq: 8500, wash: 0.2, bell: 1150 }),
    ],
  },
  {
    id: 'trap', name: 'Trap Kit',
    pads: [
      P(36, '808 Boom', 'kick', { f0: 43, fStart: 120, pitchDecay: 0.09, decay: 1.8, click: 0.15, drive: 0.35 }),
      P(35, 'Punch Kick', 'kick', { f0: 55, fStart: 260, pitchDecay: 0.03, decay: 0.3, click: 0.5, drive: 0.2 }),
      P(38, 'Snare', 'snare', { tones: [220, 410], toneDecay: 0.07, noiseDecay: 0.16, snappy: 1.0, noiseHp: 2200 }),
      P(39, 'Clap', 'clap', { freq: 1400, decay: 0.3, bursts: 4 }),
      P(42, 'Closed Hat', 'hat', { decay: 0.03, freq: 12000, noiseMix: 0.2 }, { choke: 'hat' }),
      P(46, 'Open Hat', 'hat', { decay: 0.28, freq: 11000 }, { chokeBy: 'hat' }),
      P(37, 'Rim', 'rim', { freq: 2100, decay: 0.03 }),
      P(56, 'Cowbell', 'cowbell', { freqs: [560, 830], decay: 0.18 }),
      P(47, 'Perc', 'conga', { f0: 330, decay: 0.12, slap: 0.3 }),
      P(49, 'Crash', 'cymbal', { decay: 1.5, wash: 0.5 }),
    ],
  },
  {
    id: 'boombap', name: 'Boom Bap Kit', lowpass: 7000, drive: 0.25,
    pads: [
      P(36, 'Kick', 'kick', { f0: 55, fStart: 180, pitchDecay: 0.04, decay: 0.45, click: 0.35, drive: 0.3 }),
      P(38, 'Snare', 'snare', { tones: [200, 300], toneDecay: 0.12, noiseDecay: 0.2, snappy: 0.85, noiseLp: 7000 }),
      P(39, 'Clap', 'clap', { freq: 1000, decay: 0.2 }),
      P(42, 'Closed Hat', 'hat', { decay: 0.06, freq: 9000, noiseOnly: true, hp: 6000 }, { choke: 'hat' }),
      P(46, 'Open Hat', 'hat', { decay: 0.3, freq: 9000, noiseOnly: true, hp: 6000 }, { chokeBy: 'hat' }),
      P(37, 'Rim', 'rim', { freq: 1500, decay: 0.04 }),
      P(70, 'Shaker', 'shaker', { decay: 0.07, freq: 6500 }),
      P(51, 'Ride', 'cymbal', { decay: 1.2, wash: 0.2, bell: 1000, freq: 6000 }),
    ],
  },
  {
    id: 'lofi', name: 'Lo-Fi Kit', lowpass: 3800, drive: 0.4,
    pads: [
      P(36, 'Kick', 'kick', { f0: 52, fStart: 120, pitchDecay: 0.05, decay: 0.4, click: 0.1 }),
      P(38, 'Snare', 'snare', { tones: [180, 260], toneDecay: 0.1, noiseDecay: 0.22, snappy: 0.6, noiseLp: 5000 }),
      P(37, 'Rim', 'rim', { freq: 1300, decay: 0.05 }),
      P(42, 'Closed Hat', 'hat', { decay: 0.05, noiseOnly: true, freq: 8000, hp: 5000, level: 0.6 }, { choke: 'hat' }),
      P(46, 'Open Hat', 'hat', { decay: 0.25, noiseOnly: true, freq: 8000, hp: 5000, level: 0.6 }, { chokeBy: 'hat' }),
      P(70, 'Shaker', 'shaker', { decay: 0.09, freq: 5000, attack: 0.02 }),
      P(75, 'Wood Block', 'claves', { freq: 1200, decay: 0.06 }),
      P(63, 'Bongo', 'conga', { f0: 260, decay: 0.15, slap: 0.15 }),
    ],
  },
  {
    id: 'electro', name: 'Electro Kit',
    pads: [
      P(36, 'Kick', 'kick', { f0: 50, fStart: 300, pitchDecay: 0.025, decay: 0.4, click: 0.6, drive: 0.5, wave: 'triangle' }),
      P(38, 'Snare', 'snare', { tones: [250, 500], toneDecay: 0.06, noiseDecay: 0.14, snappy: 1.0, noiseHp: 2500 }),
      P(39, 'Clap', 'clap', { freq: 1600, decay: 0.18, bursts: 4, q: 2 }),
      P(42, 'Closed Hat', 'hat', { decay: 0.035, base: 52, freq: 12000 }, { choke: 'hat' }),
      P(46, 'Open Hat', 'hat', { decay: 0.22, base: 52, freq: 12000 }, { chokeBy: 'hat' }),
      P(41, 'Zap Low', 'zap', { fStart: 1200, f0: 60, decay: 0.25 }),
      P(48, 'Zap High', 'zap', { fStart: 3000, f0: 200, decay: 0.15 }),
      P(56, 'Cowbell', 'cowbell', { freqs: [600, 900], decay: 0.15 }),
      P(37, 'Rim', 'rim', { freq: 2400, decay: 0.02 }),
      P(49, 'Crash', 'cymbal', { decay: 1.2, base: 52, freq: 9000 }),
    ],
  },
  {
    id: 'studio', name: 'Studio Kit',
    pads: [
      P(36, 'Kick', 'kick', { f0: 58, fStart: 120, pitchDecay: 0.04, decay: 0.3, click: 0.5 }),
      P(38, 'Snare', 'snare', { tones: [185, 330], toneDecay: 0.1, noiseDecay: 0.28, snappy: 0.9, noiseHp: 900, noiseLp: 8000, toneLevel: 0.6 }),
      P(37, 'Side Stick', 'rim', { freq: 1100, decay: 0.05 }),
      P(42, 'Closed Hat', 'hat', { decay: 0.06, base: 34, freq: 8000, hp: 6000, noiseMix: 0.4 }, { choke: 'hat' }),
      P(44, 'Pedal Hat', 'hat', { decay: 0.04, base: 34, freq: 7000, hp: 5000, level: 0.5 }, { choke: 'hat' }),
      P(46, 'Open Hat', 'hat', { decay: 0.5, base: 34, freq: 8000, hp: 6000, noiseMix: 0.4 }, { chokeBy: 'hat' }),
      P(43, 'Floor Tom', 'tom', { f0: 75, fStart: 95, pitchDecay: 0.3, decay: 0.6, noise: 0.25, ring: 150 }),
      P(45, 'Rack Tom', 'tom', { f0: 115, fStart: 140, pitchDecay: 0.3, decay: 0.45, noise: 0.25, ring: 230 }),
      P(48, 'High Tom', 'tom', { f0: 160, fStart: 190, pitchDecay: 0.3, decay: 0.4, noise: 0.25, ring: 320 }),
      P(49, 'Crash', 'cymbal', { decay: 2.2, base: 34, freq: 6000, wash: 0.6 }),
      P(51, 'Ride', 'cymbal', { decay: 2.0, base: 36, freq: 7000, wash: 0.25, bell: 900 }),
      P(53, 'Ride Bell', 'cymbal', { decay: 1.2, base: 38, freq: 5000, wash: 0.1, bell: 1100 }),
    ],
  },
  {
    id: 'latin', name: 'Latin Percussion',
    pads: [
      P(64, 'Low Conga', 'conga', { f0: 160, decay: 0.35, slap: 0.15 }),
      P(63, 'High Conga', 'conga', { f0: 230, decay: 0.28, slap: 0.15 }),
      P(62, 'Conga Slap', 'conga', { f0: 250, decay: 0.08, slap: 0.6 }),
      P(61, 'Low Bongo', 'conga', { f0: 300, decay: 0.15, slap: 0.25 }),
      P(60, 'High Bongo', 'conga', { f0: 420, decay: 0.12, slap: 0.25 }),
      P(65, 'Timbale', 'tom', { f0: 330, fStart: 360, pitchDecay: 0.05, decay: 0.35, noise: 0.2, ring: 980 }),
      P(75, 'Claves', 'claves', { freq: 2500, decay: 0.05 }),
      P(56, 'Cowbell', 'cowbell', { freqs: [540, 800], decay: 0.3 }),
      P(70, 'Maracas', 'shaker', { decay: 0.06, freq: 6500, attack: 0.008 }),
      P(82, 'Shaker', 'shaker', { decay: 0.12, freq: 5000, attack: 0.03 }),
      P(54, 'Tambourine', 'hat', { decay: 0.18, base: 60, freq: 9000, noiseMix: 0.5 }),
    ],
  },
];

export function getKit(id) {
  return KITS.find((k) => k.id === id) || KITS[0];
}

export const PAD_PARAMS = [
  { key: 'level', label: 'Level', min: 0, max: 1.5, step: 0.01, def: 1 },
  { key: 'tune', label: 'Tune', min: -12, max: 12, step: 1, def: 0 },
  { key: 'decay', label: 'Decay', min: 0.2, max: 3, step: 0.01, def: 1 },
  { key: 'pan', label: 'Pan', min: -1, max: 1, step: 0.01, def: 0 },
];

export function padSetting(track, note, key) {
  const v = track.drums?.pads?.[note]?.[key];
  return v == null ? PAD_PARAMS.find((d) => d.key === key).def : v;
}

// ---------- the instrument ----------
export class DrumKit {
  constructor(ctx, track, output) {
    this.ctx = ctx;
    this.output = output;
    this.kitOut = ctx.createGain();
    this.chokeVoices = new Map();
    this.setTrack(track);
  }

  get ready() { return true; }

  setTrack(track) {
    const kit = getKit(track.drums?.kit);
    const kitChanged = this.kit?.id !== kit.id;
    this.kit = kit;
    this.track = JSON.parse(JSON.stringify(track));
    if (kitChanged) this.buildKitChain();
  }

  // kept for engine compatibility (instrument param changes)
  setPreset() {}

  buildKitChain() {
    try { this.kitOut.disconnect(); } catch { /* first build */ }
    let node = this.kitOut;
    if (this.kit.drive) {
      const ws = this.ctx.createWaveShaper();
      ws.curve = driveCurve(this.kit.drive);
      const pre = this.ctx.createGain();
      pre.gain.value = 0.8;
      node = node.connect(pre).connect(ws);
    }
    if (this.kit.lowpass) node = node.connect(filt(this.ctx, 'lowpass', this.kit.lowpass, 0.5));
    node.connect(this.output);
  }

  pad(note) { return this.kit.pads.find((p) => p.note === note); }

  noteOn(note, velocity = 100, time = this.ctx.currentTime) {
    const pad = this.pad(note);
    if (!pad) return null;
    const ctx = this.ctx;
    const t = Math.max(time, ctx.currentTime);
    const s = {
      tune: padSetting(this.track, note, 'tune'),
      decay: padSetting(this.track, note, 'decay'),
    };
    const level = padSetting(this.track, note, 'level');
    const pan = padSetting(this.track, note, 'pan');
    const out = ctx.createGain();
    out.gain.value = level;
    const pn = ctx.createStereoPanner();
    pn.pan.value = pan;
    out.connect(pn).connect(this.kitOut);
    const v = Math.pow(Math.max(0.02, velocity / 127), 1.3);
    // closing hats cut off ringing open hats
    if (pad.choke) {
      for (const voice of this.chokeVoices.get(pad.choke) || []) voice.stop(t);
      this.chokeVoices.set(pad.choke, []);
    }
    const voice = VOICES[pad.voice](ctx, out, t, v, pad.params, s);
    if (pad.chokeBy && voice) {
      const list = this.chokeVoices.get(pad.chokeBy) || [];
      list.push(voice);
      if (list.length > 8) list.shift();
      this.chokeVoices.set(pad.chokeBy, list);
    }
    setTimeout(() => { try { pn.disconnect(); } catch { /* ignore */ } }, (t - ctx.currentTime + 6) * 1000);
    return voice;
  }

  noteOff() {}
  setSustain() {}

  allNotesOff() {
    const now = this.ctx.currentTime;
    for (const list of this.chokeVoices.values()) for (const v of list) v.stop(now);
    this.chokeVoices.clear();
    // fade the kit briefly so scheduled hits stop
    const g = this.kitOut.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + 0.02);
    g.setValueAtTime(1, now + 0.2);
  }

  dispose() {
    try { this.kitOut.disconnect(); } catch { /* ignore */ }
  }
}

// ---------- starter patterns (16 steps per bar; x = hit, X = accent, - = rest) ----------
export const PATTERNS = [
  { name: 'Four on the Floor', rows: { 36: 'x---x---x---x---', 39: '----x-------x---', 42: '--x---x---x---x-', 46: '------------x---' } },
  { name: 'Basic Rock', rows: { 36: 'x-------x-x-----', 38: '----X-------X---', 42: 'x-x-x-x-x-x-x-x-' } },
  { name: 'Boom Bap', rows: { 36: 'x------xx-x-----', 38: '----X-------X---', 42: 'x-x-x-x-x-x-x-xx' } },
  { name: 'Trap', rows: { 36: 'x------x--x-----', 38: '--------X-------', 42: 'x-x-xxx-x-x-x-xx', 46: '--------------x-' } },
  { name: 'Disco', rows: { 36: 'x---x---x---x---', 38: '----x-------x---', 46: '--x---x---x---x-', 42: 'x---x---x---x---' } },
  { name: 'Reggaeton', rows: { 36: 'x---x---x---x---', 38: '---x--x----x--x-', 42: 'x-x-x-x-x-x-x-x-' } },
  { name: 'Bossa Nova', rows: { 36: 'x--xx--xx--xx--x', 37: 'x--x--x---x--x--', 42: 'xxxxxxxxxxxxxxxx' } },
];
