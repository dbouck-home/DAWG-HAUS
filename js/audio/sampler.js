// Sample-based instrument: plays the nearest recorded note, re-pitched to the requested note.
// Samples load on demand and are shared between tracks using the same instrument.

let indexPromise = null;
const bufferCache = new Map(); // sampleSet -> Promise<Map<midi, AudioBuffer>>

function loadIndex() {
  if (!indexPromise) {
    indexPromise = fetch('samples/index.json').then((r) => {
      if (!r.ok) throw new Error('Sample index missing');
      return r.json();
    }).catch((e) => { indexPromise = null; throw e; });
  }
  return indexPromise;
}

export function loadSampleSet(ctx, set) {
  if (!bufferCache.has(set)) {
    const p = (async () => {
      const index = await loadIndex();
      const notes = index[set];
      if (!notes) throw new Error(`Unknown sample set ${set}`);
      const map = new Map();
      await Promise.all(notes.map(async (n) => {
        const res = await fetch(`samples/${set}/${n}.mp3`);
        if (!res.ok) throw new Error(`Missing sample ${set}/${n}`);
        map.set(n, await ctx.decodeAudioData(await res.arrayBuffer()));
      }));
      return map;
    })();
    p.catch(() => bufferCache.delete(set));
    bufferCache.set(set, p);
  }
  return bufferCache.get(set);
}

const MAX_VOICES = 48;

export class Sampler {
  constructor(ctx, preset, output) {
    this.ctx = ctx;
    this.preset = preset;
    this.output = output;
    this.voices = [];
    this.buffers = null;
    this.sustain = false;
    this.sustained = new Set();
    this.loading = loadSampleSet(ctx, preset.sample).then((m) => { this.buffers = m; this.sortedKeys = [...m.keys()].sort((a, b) => a - b); return m; });
    this.loading.catch((e) => console.warn(e));
  }

  get ready() { return !!this.buffers; }

  setPreset(pr) { this.preset = pr; }

  pick(pitch) {
    // sample notes are shifted by the preset's transpose (e.g. bass clarinet = clarinet an octave down)
    const tr = this.preset.transpose || 0;
    let best = this.sortedKeys[0];
    let bestDist = Infinity;
    for (const k of this.sortedKeys) {
      const d = Math.abs(pitch - (k + tr));
      // prefer pitching a sample down rather than up (sounds more natural)
      const score = d + (pitch < k + tr ? -0.1 : 0);
      if (score < bestDist) { bestDist = score; best = k; }
    }
    return { key: best, semis: pitch - (best + tr) };
  }

  noteOn(pitch, velocity = 100, time = this.ctx.currentTime) {
    if (!this.buffers) return null;
    const ctx = this.ctx;
    const pr = this.preset;
    const t = Math.max(time, ctx.currentTime);
    const played = pitch + (pr.tune || 0);
    if (this.voices.length >= MAX_VOICES) this.kill(this.voices[0]);
    const { key, semis } = this.pick(played);
    const src = ctx.createBufferSource();
    src.buffer = this.buffers.get(key);
    src.playbackRate.value = Math.pow(2, semis / 12);

    const vel = Math.max(0.03, velocity / 127);
    const sens = pr.velSens ?? 0.8;
    const level = (1 - sens) + sens * Math.pow(vel, 1.6);
    const peak = pr.gain * level;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = pr.q;
    // softer notes are a little darker, like real instruments
    filter.frequency.value = Math.min(20000, pr.cutoff * (0.45 + 0.55 * Math.pow(vel, 0.7 * sens + 0.01)));

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(peak, t + Math.max(0.002, pr.attack));
    src.connect(filter).connect(amp).connect(this.output);
    src.start(t);
    const voice = { pitch, start: t, src, amp, releasedAt: null };
    src.onended = () => this.cleanup(voice);
    this.voices.push(voice);
    return voice;
  }

  noteOff(pitch, time = this.ctx.currentTime, live = false) {
    for (const v of this.voices) {
      if (v.pitch !== pitch || v.releasedAt || v.start > time) continue;
      if (live && this.sustain) { this.sustained.add(v); continue; }
      this.release(v, time);
    }
  }

  setSustain(on) {
    this.sustain = on;
    if (!on) {
      const now = this.ctx.currentTime;
      for (const v of this.sustained) if (!v.releasedAt) this.release(v, now);
      this.sustained.clear();
    }
  }

  release(v, time) {
    const t = Math.max(time, this.ctx.currentTime, v.start + 0.003);
    const r = this.preset.release;
    v.releasedAt = t;
    const g = v.amp.gain;
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t); else g.cancelScheduledValues(t);
    g.setTargetAtTime(0, t, Math.max(0.004, r / 4));
    try { v.src.stop(t + r * 1.6 + 0.05); } catch { /* ignore */ }
  }

  kill(v) {
    const now = this.ctx.currentTime;
    try {
      v.amp.gain.cancelScheduledValues(0);
      v.amp.gain.setValueAtTime(v.amp.gain.value, now);
      v.amp.gain.linearRampToValueAtTime(0, now + 0.01);
      v.src.stop(now + 0.02);
    } catch { /* ignore */ }
    v.releasedAt = v.releasedAt || now;
    this.cleanup(v);
  }

  cleanup(v) {
    const i = this.voices.indexOf(v);
    if (i >= 0) this.voices.splice(i, 1);
    this.sustained.delete(v);
    setTimeout(() => { try { v.amp.disconnect(); } catch { /* ignore */ } }, 100);
  }

  allNotesOff() {
    for (const v of [...this.voices]) this.kill(v);
    this.sustained.clear();
  }

  dispose() { this.allNotesOff(); }
}
