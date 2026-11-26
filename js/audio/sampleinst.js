import { detuneNow, trackDetune, applyBend } from './bend.js';
// Sampler instrument: plays a recorded or imported sound across the keyboard.
// Settings live in track.sampler:
// { audioId, name, start, end (seconds), root (MIDI note), mode: 'pitched' | 'oneshot',
//   loop, attack, release (seconds), gain (dB), reverse }

export const SAMPLER_DEFAULTS = {
  audioId: null, name: '', start: 0, end: 0, root: 60, mode: 'pitched', loop: false,
  attack: 0.003, release: 0.25, gain: 0, reverse: false,
};

const MAX_VOICES = 32;
const reversedCache = new WeakMap();

function reversed(ctx, buf) {
  let r = reversedCache.get(buf);
  if (!r) {
    r = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const src = buf.getChannelData(c);
      const dst = r.getChannelData(c);
      for (let i = 0, n = src.length; i < n; i++) dst[i] = src[n - 1 - i];
    }
    reversedCache.set(buf, r);
  }
  return r;
}

export class SampleInstrument {
  constructor(ctx, track, output, getBuffer) {
    this.ctx = ctx;
    this.output = output;
    this.getBuffer = getBuffer; // (audioId) => AudioBuffer | null (starts loading if needed)
    this.voices = [];
    this.sustain = false;
    this.sustained = new Set();
    this.setTrack(track);
  }

  get ready() { return true; }

  setTrack(track) { this.s = { ...SAMPLER_DEFAULTS, ...(track.sampler || {}) }; }
  setPreset() {}

  setBend(cents, time) { if (this.s.mode === 'pitched') applyBend(this, cents, time); }

  noteOn(pitch, velocity = 100, time = this.ctx.currentTime) {
    const s = this.s;
    if (!s.audioId) return null;
    let buf = this.getBuffer(s.audioId);
    if (!buf) return null;
    const ctx = this.ctx;
    const t = Math.max(time, ctx.currentTime);
    let start = Math.max(0, Math.min(s.start || 0, buf.duration));
    let end = s.end > start ? Math.min(s.end, buf.duration) : buf.duration;
    if (end - start < 0.005) return null;
    if (s.reverse) {
      buf = reversed(ctx, buf);
      [start, end] = [buf.duration - end, buf.duration - start];
    }
    if (this.voices.length >= MAX_VOICES) this.kill(this.voices[0]);
    if (s.mode === 'oneshot') {
      // one-shot: a key retriggers its own sound instead of stacking
      for (const v of this.voices) if (v.pitch === pitch && !v.releasedAt) this.release(v, t, 0.01);
    }
    const rate = s.mode === 'pitched' ? Math.pow(2, (pitch - s.root - (s.fine || 0) / 100) / 12) : 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    if (s.mode === 'pitched') src.detune.value = detuneNow(this);
    if (s.loop) {
      src.loop = true;
      src.loopStart = start;
      src.loopEnd = end;
    }
    const vel = Math.max(0.03, velocity / 127);
    const peak = Math.pow(10, (s.gain || 0) / 20) * (0.2 + 0.8 * vel * vel);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(peak, t + Math.max(0.002, s.attack));
    src.connect(amp).connect(this.output);
    src.start(t, start);
    const voice = { pitch, start: t, src, amp, releasedAt: null };
    if (s.mode === 'pitched') trackDetune(this, voice, [{ param: src.detune, base: 0 }]);
    if (!s.loop) {
      // play to the end marker, with a short fade so it doesn't click
      const len = (end - start) / rate;
      amp.gain.setValueAtTime(peak, t + Math.max(0.003, len - 0.01));
      amp.gain.linearRampToValueAtTime(0, t + len);
      src.stop(t + len + 0.02);
      voice.endsAt = t + len;
    }
    src.onended = () => this.cleanup(voice);
    this.voices.push(voice);
    return voice;
  }

  noteOff(pitch, time = this.ctx.currentTime, live = false) {
    if (this.s.mode === 'oneshot' && !this.s.loop) return; // one-shots always play to the end
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

  release(v, time, override) {
    const t = Math.max(time, this.ctx.currentTime, v.start + 0.003);
    if (v.endsAt && t >= v.endsAt) return;
    const r = override ?? this.s.release;
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

/** Find where the sound starts and ends (ignoring quiet edges). */
export function detectTrim(buf, threshold = 0.02) {
  const d = buf.getChannelData(0);
  let a = 0;
  let b = d.length - 1;
  while (a < d.length && Math.abs(d[a]) < threshold) a++;
  while (b > a && Math.abs(d[b]) < threshold) b--;
  const pad = Math.round(buf.sampleRate * 0.005);
  return { start: Math.max(0, a - pad) / buf.sampleRate, end: Math.min(d.length, b + pad * 4) / buf.sampleRate };
}

/** Guess the pitch of a sound (MIDI note) so pitched playback is in tune; null if unclear. */
export function detectPitch(buf, start, end) {
  const f = detectPitchExact(buf, start, end);
  return f == null ? null : Math.round(f);
}

/** Pitch of the sound as a fractional MIDI note (69 = A4 = 440 Hz), or null. */
export function detectPitchExact(buf, start, end) {
  const sr = buf.sampleRate;
  const d = buf.getChannelData(0);
  const a = Math.floor(start * sr + Math.min(0.05, (end - start) / 4) * sr);
  const W = Math.min(4096, Math.floor((end - start) * sr) - (a - Math.floor(start * sr)) - 1000);
  if (W < 1024) return null;
  const tauMin = Math.floor(sr / 1200);
  const tauMax = Math.floor(sr / 50);
  let running = 0;
  const dd = new Float32Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let s = 0;
    for (let i = 0; i < W; i++) { const x = d[a + i] - d[a + i + tau]; s += x * x; }
    running += s;
    dd[tau] = running ? (s * tau) / running : 1;
  }
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (dd[tau] < 0.12) {
      while (tau + 1 <= tauMax && dd[tau + 1] < dd[tau]) tau++;
      // parabolic interpolation between lags for sub-sample accuracy (cents)
      let t = tau;
      if (tau > 1 && tau < tauMax) {
        const y0 = dd[tau - 1], y1 = dd[tau], y2 = dd[tau + 1];
        const den = y0 - 2 * y1 + y2;
        if (den) t = tau + 0.5 * (y0 - y2) / den;
      }
      const f = sr / t;
      return 69 + 12 * Math.log2(f / 440);
    }
  }
  return null;
}
