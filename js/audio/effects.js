// Insert effects for tracks and the master bus.
// Every effect has input/output nodes, a parameter list, set(key, value), and
// automatable(key) -> { param: AudioParam, map(v) } for parameters that can be automated.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export const NOTE_TIMES = [
  { label: '1/2', beats: 2 }, { label: '1/4', beats: 1 }, { label: '1/4 dotted', beats: 1.5 }, { label: '1/4 T', beats: 2 / 3 },
  { label: '1/8', beats: 0.5 }, { label: '1/8 dotted', beats: 0.75 }, { label: '1/8 T', beats: 1 / 3 },
  { label: '1/16', beats: 0.25 }, { label: '1/16 dotted', beats: 0.375 }, { label: '1/32', beats: 0.125 },
];
const SYNC_RATES = [
  { label: 'Free (Hz)', beats: 0 }, { label: '4 bars', beats: 16 }, { label: '2 bars', beats: 8 }, { label: '1 bar', beats: 4 },
  { label: '1/2', beats: 2 }, { label: '1/4', beats: 1 }, { label: '1/8', beats: 0.5 }, { label: '1/8 T', beats: 1 / 3 }, { label: '1/16', beats: 0.25 },
];

function mixPair(ctx, input, output, wetIn, wetOut) {
  // dry/wet crossfade helper: returns {dry, wet} gains
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  input.connect(dry).connect(output);
  input.connect(wetIn);
  wetOut.connect(wet).connect(output);
  return { dry, wet };
}
function setMix(ctx, pair, m) {
  const t = ctx.currentTime;
  // equal-power crossfade
  pair.dry.gain.setTargetAtTime(Math.cos(m * Math.PI / 2), t, 0.01);
  pair.wet.gain.setTargetAtTime(Math.sin(m * Math.PI / 2), t, 0.01);
}
const mixAuto = (pair) => ({ param: pair.wet.gain, map: (v) => Math.sin(clamp(v, 0, 1) * Math.PI / 2), also: { param: pair.dry.gain, map: (v) => Math.cos(clamp(v, 0, 1) * Math.PI / 2) } });

function lfo(ctx, rate, depth) {
  const o = ctx.createOscillator();
  o.frequency.value = rate;
  const g = ctx.createGain();
  g.gain.value = depth;
  o.connect(g);
  o.start();
  return { osc: o, gain: g };
}

const tanhCurves = new Map();
function curve(kind) {
  if (!tanhCurves.has(kind)) {
    const n = 4096;
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      if (kind === 'soft') c[i] = Math.tanh(x * 2) / Math.tanh(2);
      else if (kind === 'hard') c[i] = clamp(x * 1.6, -1, 1);
      else if (kind === 'fuzz') c[i] = Math.sign(x) * (1 - Math.exp(-Math.abs(x) * 6));
      else if (kind === 'crush') c[i] = Math.round(x * 8) / 8;
    }
    tanhCurves.set(kind, c);
  }
  return tanhCurves.get(kind);
}

function impulse(ctx, seconds, damping, predelay) {
  const rate = ctx.sampleRate;
  const pre = Math.floor(predelay * rate);
  const len = Math.max(1, Math.floor(seconds * rate)) + pre;
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const tt = (i - pre) / rate;
      const env = Math.pow(1 - (i - pre) / (len - pre), 2.2) * Math.exp(-tt * 0.5);
      const n = Math.random() * 2 - 1;
      // simple one-pole lowpass; more damping = darker tail as it decays
      const k = clamp(0.05 + (1 - damping) * 0.9 - (tt / seconds) * damping * 0.5, 0.02, 1);
      lp += k * (n - lp);
      d[i] = lp * env;
    }
  }
  return buf;
}

// ---------------- effect definitions ----------------

const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const SCALE_OPTIONS = [
  ['chromatic', 'Chromatic (every note)'], ['major', 'Major'], ['minor', 'Minor'], ['harmonicMinor', 'Harmonic minor'],
  ['majorPentatonic', 'Major pentatonic'], ['minorPentatonic', 'Minor pentatonic'], ['blues', 'Blues'], ['dorian', 'Dorian'], ['mixolydian', 'Mixolydian'],
];

export const FX_TYPES = {
  autotune: {
    name: 'Autotune',
    params: [
      { key: 'key', label: 'Key', type: 'select', options: KEY_NAMES.map((n, i) => [String(i), n]), def: '0' },
      { key: 'scale', label: 'Scale', type: 'select', options: SCALE_OPTIONS, def: 'major' },
      { key: 'speed', label: 'Retune speed', min: 0, max: 400, step: 1, def: 20, unit: 'ms' },
      { key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, def: 1 },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, def: 1 },
    ],
    create(ctx) {
      // needs the worklet module; until it's loaded, pass audio straight through
      if (!ctx.__dawgWorklets) {
        const g = ctx.createGain();
        return { input: g, output: g, pending: true, set() {}, automatable: () => null };
      }
      const node = new AudioWorkletNode(ctx, 'dawg-autotune', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      const p = (k) => node.parameters.get(k);
      return {
        input: node, output: node,
        set(k, v) {
          const t = ctx.currentTime;
          if (k === 'key') node.port.postMessage({ key: +v });
          if (k === 'scale') node.port.postMessage({ scale: v });
          if (k === 'speed') p('speed').setValueAtTime(v / 1000, t);
          if (k === 'amount') p('amount').setValueAtTime(v, t);
          if (k === 'mix') p('mix').setValueAtTime(v, t);
        },
        automatable: (k) => ({
          amount: { param: p('amount'), map: (v) => v },
          mix: { param: p('mix'), map: (v) => v },
        })[k] || null,
        dispose() { node.disconnect(); },
      };
    },
  },

  eq: {
    name: 'EQ',
    params: [
      { key: 'low', label: 'Low', min: -18, max: 18, step: 0.5, def: 0, unit: 'dB' },
      { key: 'mid', label: 'Mid', min: -18, max: 18, step: 0.5, def: 0, unit: 'dB' },
      { key: 'midFreq', label: 'Mid freq', min: 150, max: 8000, step: 1, def: 1000, unit: 'Hz', log: true },
      { key: 'high', label: 'High', min: -18, max: 18, step: 0.5, def: 0, unit: 'dB' },
    ],
    create(ctx) {
      const lo = ctx.createBiquadFilter(); lo.type = 'lowshelf'; lo.frequency.value = 200;
      const mid = ctx.createBiquadFilter(); mid.type = 'peaking'; mid.Q.value = 0.9;
      const hi = ctx.createBiquadFilter(); hi.type = 'highshelf'; hi.frequency.value = 5000;
      lo.connect(mid).connect(hi);
      const map = { low: lo.gain, mid: mid.gain, midFreq: mid.frequency, high: hi.gain };
      return {
        input: lo, output: hi,
        set(k, v) { map[k]?.setTargetAtTime(v, ctx.currentTime, 0.01); },
        automatable: (k) => (map[k] ? { param: map[k], map: (v) => v } : null),
      };
    },
  },

  compressor: {
    name: 'Compressor',
    params: [
      { key: 'threshold', label: 'Threshold', min: -60, max: 0, step: 0.5, def: -18, unit: 'dB' },
      { key: 'ratio', label: 'Ratio', min: 1, max: 20, step: 0.1, def: 4, unit: ':1' },
      { key: 'attack', label: 'Attack', min: 0.001, max: 0.3, step: 0.001, def: 0.01, unit: 's', log: true },
      { key: 'release', label: 'Release', min: 0.02, max: 1, step: 0.01, def: 0.2, unit: 's', log: true },
      { key: 'makeup', label: 'Makeup', min: 0, max: 24, step: 0.5, def: 4, unit: 'dB' },
    ],
    create(ctx) {
      const c = ctx.createDynamicsCompressor();
      c.knee.value = 6;
      const g = ctx.createGain();
      c.connect(g);
      const db = (v) => Math.pow(10, v / 20);
      const map = { threshold: [c.threshold, (v) => v], ratio: [c.ratio, (v) => v], attack: [c.attack, (v) => v], release: [c.release, (v) => v], makeup: [g.gain, db] };
      return {
        input: c, output: g,
        set(k, v) { const m = map[k]; if (m) m[0].setTargetAtTime(m[1](v), ctx.currentTime, 0.01); },
        automatable: (k) => (map[k] ? { param: map[k][0], map: map[k][1] } : null),
        meter: () => c.reduction,
      };
    },
  },

  distortion: {
    name: 'Distortion',
    params: [
      { key: 'mode', label: 'Type', type: 'select', options: [['soft', 'Overdrive'], ['hard', 'Distortion'], ['fuzz', 'Fuzz'], ['crush', 'Bit crush']], def: 'soft' },
      { key: 'drive', label: 'Drive', min: 0, max: 1, step: 0.01, def: 0.4 },
      { key: 'tone', label: 'Tone', min: 300, max: 16000, step: 1, def: 6000, unit: 'Hz', log: true },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, def: 1 },
      { key: 'level', label: 'Output', min: -24, max: 6, step: 0.5, def: -6, unit: 'dB' },
    ],
    create(ctx) {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const pre = ctx.createGain();
      const ws = ctx.createWaveShaper();
      ws.oversample = '4x';
      const tone = ctx.createBiquadFilter(); tone.type = 'lowpass';
      const lvl = ctx.createGain();
      pre.connect(ws).connect(tone).connect(lvl);
      const pair = mixPair(ctx, input, output, pre, lvl);
      const drive = (v) => 1 + v * v * 40;
      return {
        input, output,
        set(k, v) {
          const t = ctx.currentTime;
          if (k === 'mode') ws.curve = curve(v);
          if (k === 'drive') pre.gain.setTargetAtTime(drive(v), t, 0.01);
          if (k === 'tone') tone.frequency.setTargetAtTime(v, t, 0.01);
          if (k === 'mix') setMix(ctx, pair, v);
          if (k === 'level') lvl.gain.setTargetAtTime(Math.pow(10, v / 20), t, 0.01);
        },
        automatable: (k) => ({
          drive: { param: pre.gain, map: drive },
          tone: { param: tone.frequency, map: (v) => v },
          mix: mixAuto(pair),
          level: { param: lvl.gain, map: (v) => Math.pow(10, v / 20) },
        })[k] || null,
      };
    },
  },

  filter: {
    name: 'Filter',
    params: [
      { key: 'mode', label: 'Type', type: 'select', options: [['lowpass', 'Low-pass'], ['highpass', 'High-pass'], ['bandpass', 'Band-pass'], ['notch', 'Notch']], def: 'lowpass' },
      { key: 'cutoff', label: 'Cutoff', min: 20, max: 20000, step: 1, def: 2000, unit: 'Hz', log: true },
      { key: 'q', label: 'Resonance', min: 0.1, max: 20, step: 0.1, def: 1 },
      { key: 'sync', label: 'Wobble rate', type: 'select', options: SYNC_RATES.map((r, i) => [String(i), r.label]), def: '0' },
      { key: 'rate', label: 'Wobble Hz', min: 0.05, max: 12, step: 0.01, def: 1, unit: 'Hz', log: true },
      { key: 'depth', label: 'Wobble depth', min: 0, max: 1, step: 0.01, def: 0 },
    ],
    create(ctx) {
      const f = ctx.createBiquadFilter();
      const l = lfo(ctx, 1, 0);
      l.gain.connect(f.detune);
      let syncIdx = 0; let rate = 1; let bpm = 120;
      const applyRate = () => {
        const s = SYNC_RATES[syncIdx];
        const hz = s.beats ? bpm / 60 / s.beats : rate;
        l.osc.frequency.setTargetAtTime(hz, ctx.currentTime, 0.02);
      };
      return {
        input: f, output: f,
        set(k, v) {
          const t = ctx.currentTime;
          if (k === 'mode') f.type = v;
          if (k === 'cutoff') f.frequency.setTargetAtTime(v, t, 0.01);
          if (k === 'q') f.Q.setTargetAtTime(v, t, 0.01);
          if (k === 'depth') l.gain.gain.setTargetAtTime(v * 2400, t, 0.01); // up to ±2 octaves
          if (k === 'rate') { rate = v; applyRate(); }
          if (k === 'sync') { syncIdx = +v; applyRate(); }
        },
        tempo(b) { bpm = b; if (SYNC_RATES[syncIdx].beats) applyRate(); },
        automatable: (k) => ({
          cutoff: { param: f.frequency, map: (v) => v },
          q: { param: f.Q, map: (v) => v },
          depth: { param: l.gain.gain, map: (v) => v * 2400 },
        })[k] || null,
        dispose() { l.osc.stop(); },
      };
    },
  },

  chorus: {
    name: 'Chorus',
    params: [
      { key: 'rate', label: 'Rate', min: 0.05, max: 5, step: 0.01, def: 0.8, unit: 'Hz', log: true },
      { key: 'depth', label: 'Depth', min: 0, max: 1, step: 0.01, def: 0.5 },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, def: 0.5 },
    ],
    create(ctx) {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const wetIn = ctx.createGain();
      const wetOut = ctx.createGain();
      const merger = ctx.createChannelMerger(2);
      const lfos = [];
      [0, 1].forEach((ch) => {
        const d = ctx.createDelay(0.1);
        d.delayTime.value = 0.018 + ch * 0.006;
        const l = lfo(ctx, 0.8, 0.004);
        // offset the right voice's phase so the chorus spreads in stereo
        if (ch === 1) l.osc.frequency.value = 0.8 * 1.11;
        l.gain.connect(d.delayTime);
        wetIn.connect(d).connect(merger, 0, ch);
        lfos.push(l);
      });
      merger.connect(wetOut);
      const pair = mixPair(ctx, input, output, wetIn, wetOut);
      return {
        input, output,
        set(k, v) {
          const t = ctx.currentTime;
          if (k === 'rate') lfos.forEach((l, i) => l.osc.frequency.setTargetAtTime(v * (i ? 1.11 : 1), t, 0.02));
          if (k === 'depth') lfos.forEach((l) => l.gain.gain.setTargetAtTime(0.0005 + v * 0.007, t, 0.02));
          if (k === 'mix') setMix(ctx, pair, v);
        },
        automatable: (k) => ({
          rate: { param: lfos[0].osc.frequency, map: (v) => v, also: { param: lfos[1].osc.frequency, map: (v) => v * 1.11 } },
          depth: { param: lfos[0].gain.gain, map: (v) => 0.0005 + v * 0.007, also: { param: lfos[1].gain.gain, map: (v) => 0.0005 + v * 0.007 } },
          mix: mixAuto(pair),
        })[k] || null,
        dispose() { lfos.forEach((l) => l.osc.stop()); },
      };
    },
  },

  phaser: {
    name: 'Phaser',
    params: [
      { key: 'rate', label: 'Rate', min: 0.05, max: 8, step: 0.01, def: 0.5, unit: 'Hz', log: true },
      { key: 'depth', label: 'Depth', min: 0, max: 1, step: 0.01, def: 0.7 },
      { key: 'feedback', label: 'Feedback', min: 0, max: 0.9, step: 0.01, def: 0.5 },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, def: 0.5 },
    ],
    create(ctx) {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const wetIn = ctx.createGain();
      const stages = [];
      let node = wetIn;
      const l = lfo(ctx, 0.5, 600);
      for (let i = 0; i < 6; i++) {
        const ap = ctx.createBiquadFilter();
        ap.type = 'allpass';
        ap.frequency.value = 900;
        ap.Q.value = 0.6;
        l.gain.connect(ap.frequency);
        node = node.connect(ap);
        stages.push(ap);
      }
      const fb = ctx.createGain();
      fb.gain.value = 0.5;
      const fbDelay = ctx.createDelay(0.01); // feedback loops need a delay in Web Audio
      fbDelay.delayTime.value = 0.001;
      node.connect(fb).connect(fbDelay).connect(stages[0]);
      const pair = mixPair(ctx, input, output, wetIn, node);
      return {
        input, output,
        set(k, v) {
          const t = ctx.currentTime;
          if (k === 'rate') l.osc.frequency.setTargetAtTime(v, t, 0.02);
          if (k === 'depth') l.gain.gain.setTargetAtTime(50 + v * 800, t, 0.02);
          if (k === 'feedback') fb.gain.setTargetAtTime(v, t, 0.02);
          if (k === 'mix') setMix(ctx, pair, v);
        },
        automatable: (k) => ({
          rate: { param: l.osc.frequency, map: (v) => v },
          depth: { param: l.gain.gain, map: (v) => 50 + v * 800 },
          feedback: { param: fb.gain, map: (v) => v },
          mix: mixAuto(pair),
        })[k] || null,
        dispose() { l.osc.stop(); },
      };
    },
  },

  delay: {
    name: 'Delay',
    params: [
      { key: 'time', label: 'Time', type: 'select', options: [['ms', 'Free (ms)'], ...NOTE_TIMES.map((n, i) => [String(i), n.label])], def: '5' },
      { key: 'ms', label: 'Time (ms)', min: 10, max: 2000, step: 1, def: 375, unit: 'ms', log: true },
      { key: 'feedback', label: 'Feedback', min: 0, max: 0.95, step: 0.01, def: 0.35 },
      { key: 'tone', label: 'Tone', min: 500, max: 16000, step: 1, def: 5000, unit: 'Hz', log: true },
      { key: 'pingpong', label: 'Ping-pong', type: 'select', options: [['0', 'Off'], ['1', 'On']], def: '1' },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, def: 0.3 },
    ],
    create(ctx) {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const wetIn = ctx.createGain();
      const wetOut = ctx.createGain();
      const dl = ctx.createDelay(4); const dr = ctx.createDelay(4);
      const fl = ctx.createGain(); const fr = ctx.createGain();
      const tl = ctx.createBiquadFilter(); tl.type = 'lowpass';
      const tr = ctx.createBiquadFilter(); tr.type = 'lowpass';
      const merger = ctx.createChannelMerger(2);
      const mono = ctx.createGain(); // mono sum feeding the left line
      wetIn.connect(mono).connect(dl);
      dl.connect(tl); dr.connect(tr);
      tl.connect(merger, 0, 0); tr.connect(merger, 0, 1);
      merger.connect(wetOut);
      let ping = true;
      tl.connect(fl); tr.connect(fr);
      const route = () => {
        fl.disconnect(); fr.disconnect();
        try { mono.disconnect(dr); } catch { /* not connected */ }
        if (ping) {
          // feedback crosses sides: left echo -> right echo -> left ...
          fl.connect(dr); fr.connect(dl);
        } else {
          // both sides get the input and repeat on their own side
          fl.connect(dl); fr.connect(dr); mono.connect(dr);
        }
      };
      route();
      const pair = mixPair(ctx, input, output, wetIn, wetOut);
      let timeIdx = '5'; let ms = 375; let bpm = 120;
      const seconds = () => (timeIdx === 'ms' ? ms / 1000 : (NOTE_TIMES[+timeIdx].beats * 60) / bpm);
      const applyTime = (at = ctx.currentTime) => {
        const s = clamp(seconds(), 0.005, 3.9);
        dl.delayTime.setTargetAtTime(s, at, 0.02); dr.delayTime.setTargetAtTime(s, at, 0.02);
      };
      return {
        input, output,
        set(k, v) {
          const t = ctx.currentTime;
          if (k === 'time') { timeIdx = v; applyTime(); }
          if (k === 'ms') { ms = v; applyTime(); }
          if (k === 'feedback') { fl.gain.setTargetAtTime(v, t, 0.01); fr.gain.setTargetAtTime(v, t, 0.01); }
          if (k === 'tone') { tl.frequency.setTargetAtTime(v, t, 0.01); tr.frequency.setTargetAtTime(v, t, 0.01); }
          if (k === 'pingpong') { ping = v === '1'; route(); }
          if (k === 'mix') setMix(ctx, pair, v);
        },
        tempo(b, at) { bpm = b; if (timeIdx !== 'ms') applyTime(at); },
        automatable: (k) => ({
          feedback: { param: fl.gain, map: (v) => v, also: { param: fr.gain, map: (v) => v } },
          tone: { param: tl.frequency, map: (v) => v, also: { param: tr.frequency, map: (v) => v } },
          mix: mixAuto(pair),
        })[k] || null,
      };
    },
  },

  reverb: {
    name: 'Reverb',
    params: [
      { key: 'size', label: 'Size', min: 0.3, max: 8, step: 0.1, def: 2.2, unit: 's', log: true },
      { key: 'damping', label: 'Damping', min: 0, max: 1, step: 0.01, def: 0.5 },
      { key: 'predelay', label: 'Pre-delay', min: 0, max: 0.2, step: 0.001, def: 0.02, unit: 's' },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, def: 0.3 },
    ],
    create(ctx) {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const conv = ctx.createConvolver();
      const pair = mixPair(ctx, input, output, conv, conv);
      const st = { size: 2.2, damping: 0.5, predelay: 0.02 };
      let timer = null;
      const rebuild = () => { clearTimeout(timer); timer = setTimeout(() => { conv.buffer = impulse(ctx, st.size, st.damping, st.predelay); }, 60); };
      conv.buffer = impulse(ctx, st.size, st.damping, st.predelay);
      return {
        input, output,
        set(k, v) {
          if (k in st) { st[k] = v; rebuild(); }
          if (k === 'mix') setMix(ctx, pair, v);
        },
        automatable: (k) => (k === 'mix' ? mixAuto(pair) : null),
      };
    },
  },

  tremolo: {
    name: 'Tremolo / Auto-pan',
    params: [
      { key: 'mode', label: 'Mode', type: 'select', options: [['trem', 'Tremolo'], ['pan', 'Auto-pan']], def: 'trem' },
      { key: 'sync', label: 'Rate', type: 'select', options: SYNC_RATES.map((r, i) => [String(i), r.label]), def: '6' },
      { key: 'rate', label: 'Rate Hz', min: 0.1, max: 20, step: 0.01, def: 5, unit: 'Hz', log: true },
      { key: 'depth', label: 'Depth', min: 0, max: 1, step: 0.01, def: 0.6 },
    ],
    create(ctx) {
      const input = ctx.createGain();
      const amp = ctx.createGain();
      const pan = ctx.createStereoPanner();
      input.connect(amp).connect(pan);
      const l = lfo(ctx, 5, 0);
      let mode = 'trem'; let depth = 0.6; let syncIdx = 6; let rate = 5; let bpm = 120;
      const route = () => {
        try { l.gain.disconnect(); } catch { /* ignore */ }
        const t = ctx.currentTime;
        if (mode === 'trem') {
          amp.gain.setValueAtTime(1 - depth / 2, t);
          l.gain.gain.setValueAtTime(depth / 2, t);
          l.gain.connect(amp.gain);
          pan.pan.setValueAtTime(0, t);
        } else {
          amp.gain.setValueAtTime(1, t);
          l.gain.gain.setValueAtTime(depth, t);
          l.gain.connect(pan.pan);
        }
      };
      const applyRate = () => {
        const s = SYNC_RATES[syncIdx];
        l.osc.frequency.setTargetAtTime(s.beats ? bpm / 60 / s.beats : rate, ctx.currentTime, 0.02);
      };
      route();
      return {
        input, output: pan,
        set(k, v) {
          if (k === 'mode') { mode = v; route(); }
          if (k === 'depth') { depth = v; route(); }
          if (k === 'rate') { rate = v; applyRate(); }
          if (k === 'sync') { syncIdx = +v; applyRate(); }
        },
        tempo(b) { bpm = b; if (SYNC_RATES[syncIdx].beats) applyRate(); },
        automatable: () => null,
        dispose() { l.osc.stop(); },
      };
    },
  },
};

export const FX_ORDER = ['autotune', 'eq', 'compressor', 'distortion', 'filter', 'chorus', 'phaser', 'delay', 'reverb', 'tremolo'];

export function fxDefaults(type) {
  const out = {};
  for (const p of FX_TYPES[type].params) out[p.key] = p.def;
  return out;
}

export function fxParamDef(type, key) {
  return FX_TYPES[type]?.params.find((p) => p.key === key);
}

/** Build a live effect from saved settings. */
export function createFx(ctx, fx) {
  const def = FX_TYPES[fx.type];
  const inst = def.create(ctx);
  inst.type = fx.type;
  inst.id = fx.id;
  inst.values = {};
  const params = { ...fxDefaults(fx.type), ...(fx.params || {}) };
  for (const [k, v] of Object.entries(params)) { inst.set(k, v); inst.values[k] = v; }
  return inst;
}

/** Apply changed settings to a live effect. */
export function updateFx(inst, fx) {
  const params = { ...fxDefaults(fx.type), ...(fx.params || {}) };
  for (const [k, v] of Object.entries(params)) {
    if (inst.values[k] !== v) { inst.set(k, v); inst.values[k] = v; }
  }
}
