// Subtractive synthesizer used by the Phase 1 instrument presets.
// Polyphonic, or monophonic with glide for mono presets.

const MAX_VOICES = 32;

export function midiToFreq(p) {
  return 440 * Math.pow(2, (p - 69) / 12);
}

export class Synth {
  constructor(ctx, preset, output) {
    this.ctx = ctx;
    this.preset = preset;
    this.output = output;
    this.voices = [];
    this.lastFreq = null;
    this.sustain = false;
    this.sustained = new Set(); // voices waiting for pedal up
  }

  get ready() { return true; }

  setPreset(pr) { this.preset = pr; }

  noteOn(pitch, velocity = 100, time = this.ctx.currentTime) {
    const ctx = this.ctx;
    const pr = this.preset;
    const t = Math.max(time, ctx.currentTime);
    const freq = midiToFreq(pitch);

    if (pr.mono) {
      // retrigger: quickly fade out any voice still sounding
      for (const v of this.voices) if (!v.releasedAt || v.releasedAt > t) this.release(v, t, 0.015);
    } else if (this.voices.length >= MAX_VOICES) {
      this.kill(this.voices[0]);
    }

    const vel = Math.max(0.05, velocity / 127);
    const peak = pr.gain * (0.25 + 0.75 * vel * vel);

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(peak, t + pr.amp.attack);
    amp.gain.setTargetAtTime(peak * pr.amp.sustain, t + pr.amp.attack, Math.max(0.005, pr.amp.decay / 3));

    const filter = ctx.createBiquadFilter();
    filter.type = pr.filter.type;
    filter.Q.value = pr.filter.q;
    const base = pr.filter.cutoff;
    const envAmt = pr.filter.envAmount * (0.4 + 0.6 * vel);
    const fe = pr.filterEnv;
    filter.frequency.setValueAtTime(base, t);
    if (envAmt > 0) {
      filter.frequency.linearRampToValueAtTime(Math.min(18000, base + envAmt), t + fe.attack);
      filter.frequency.setTargetAtTime(base + envAmt * fe.sustain, t + fe.attack, Math.max(0.005, fe.decay / 3));
    }

    filter.connect(amp);
    amp.connect(this.output);

    const glideFrom = pr.mono && this.lastFreq && pr.glide ? this.lastFreq : null;
    const oscs = pr.osc.map((o) => {
      const osc = ctx.createOscillator();
      osc.type = o.type;
      const mult = Math.pow(2, o.octave || 0);
      if (glideFrom) {
        osc.frequency.setValueAtTime(glideFrom * mult, t);
        osc.frequency.exponentialRampToValueAtTime(freq * mult, t + pr.glide);
      } else {
        osc.frequency.setValueAtTime(freq * mult, t);
      }
      osc.detune.value = o.detune || 0;
      const g = ctx.createGain();
      g.gain.value = o.gain;
      osc.connect(g).connect(filter);
      osc.start(t);
      return osc;
    });

    this.lastFreq = freq;
    const voice = { pitch, start: t, amp, filter, oscs, releasedAt: null };
    oscs[0].onended = () => this.cleanup(voice);
    this.voices.push(voice);
    return voice;
  }

  noteOff(pitch, time = this.ctx.currentTime, live = false) {
    for (const v of this.voices) {
      if (v.pitch !== pitch || v.releasedAt) continue;
      if (v.start > time) continue; // scheduled later than this off
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

  release(v, time, releaseOverride) {
    const t = Math.max(time, this.ctx.currentTime, v.start + 0.003);
    const r = releaseOverride ?? this.preset.amp.release;
    v.releasedAt = t;
    const g = v.amp.gain;
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t);
    else { g.cancelScheduledValues(t); }
    g.setTargetAtTime(0, t, Math.max(0.003, r / 4));
    const fr = v.filter.frequency;
    if (this.preset.filter.envAmount > 0) {
      if (fr.cancelAndHoldAtTime) fr.cancelAndHoldAtTime(t);
      fr.setTargetAtTime(this.preset.filter.cutoff, t, Math.max(0.003, this.preset.filterEnv.release / 4));
    }
    const stopAt = t + r * 1.6 + 0.05;
    for (const o of v.oscs) { try { o.stop(stopAt); } catch { /* already stopped */ } }
  }

  kill(v) {
    const now = this.ctx.currentTime;
    try {
      v.amp.gain.cancelScheduledValues(0);
      v.amp.gain.setValueAtTime(v.amp.gain.value, now);
      v.amp.gain.linearRampToValueAtTime(0, now + 0.01);
      for (const o of v.oscs) o.stop(now + 0.02);
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

  /** Stop everything immediately (transport stop / panic). */
  allNotesOff() {
    for (const v of [...this.voices]) this.kill(v);
    this.sustained.clear();
    this.lastFreq = null;
  }

  dispose() {
    this.allNotesOff();
  }
}
