// Audio engine: mixer channels, instruments, transport scheduler, metronome,
// live input and MIDI recording.
import { MeterMap, TempoMap } from '../timing.js';
import { Synth } from './synth.js';
import { effectivePreset } from './presets.js';
import { Sampler } from './sampler.js';

const LOOKAHEAD = 0.12; // seconds scheduled ahead
const INTERVAL = 25; // ms between scheduler runs

export const dbToGain = (db) => (db <= -60 ? 0 : Math.pow(10, db / 20));

class Channel {
  constructor(ctx, dest) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    // Phase 4: insert effects chain goes between input and fader
    this.fader = ctx.createGain();
    this.panner = ctx.createStereoPanner();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.input.connect(this.fader).connect(this.panner).connect(this.analyser).connect(dest);
    this.instrument = null;
    this.presetId = null;
    this.meterBuf = new Float32Array(this.analyser.fftSize);
  }

  setGain(g) { this.fader.gain.setTargetAtTime(g, this.ctx.currentTime, 0.015); }
  setPan(p) { this.panner.pan.setTargetAtTime(p, this.ctx.currentTime, 0.015); }

  peak() {
    this.analyser.getFloatTimeDomainData(this.meterBuf);
    let m = 0;
    for (let i = 0; i < this.meterBuf.length; i++) { const a = Math.abs(this.meterBuf[i]); if (a > m) m = a; }
    return m;
  }

  dispose() {
    this.instrument?.dispose();
    try { this.analyser.disconnect(); } catch { /* ignore */ }
  }
}

export class Engine {
  constructor(getProject) {
    this.getProject = getProject;
    this.ctx = null;
    this.channels = new Map();
    this.playing = false;
    this.recording = false;
    this.positionTick = 0; // when stopped
    this.anchors = [];
    this.timer = null;
    this.listeners = {};
    this.recordTrackId = null;
    this.recorded = [];
    this.openRec = new Map();
  }

  on(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  emit(ev, ...a) { (this.listeners[ev] || []).forEach((f) => f(...a)); }

  /** Create the AudioContext (must follow a user gesture). */
  ensureContext() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -1;
      this.limiter.knee.value = 0;
      this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.002;
      this.limiter.release.value = 0.1;
      this.masterAnalyser = this.ctx.createAnalyser();
      this.masterAnalyser.fftSize = 512;
      this.masterBuf = new Float32Array(512);
      this.master.connect(this.limiter).connect(this.masterAnalyser).connect(this.ctx.destination);
      this.clickGain = this.ctx.createGain();
      this.clickGain.connect(this.ctx.destination);
      this.sync();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  get latency() {
    if (!this.ctx) return 0;
    return (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
  }

  /** Bring audio graph in line with the project (tracks, gains, presets). */
  sync() {
    if (!this.ctx) return;
    const p = this.getProject();
    const ids = new Set(p.tracks.map((t) => t.id));
    for (const [id, ch] of this.channels) {
      if (!ids.has(id)) { ch.dispose(); this.channels.delete(id); }
    }
    const anySolo = p.tracks.some((t) => t.solo);
    for (const t of p.tracks) {
      let ch = this.channels.get(t.id);
      if (!ch) { ch = new Channel(this.ctx, this.master); this.channels.set(t.id, ch); }
      if (t.type === 'instrument') {
        const pid = t.instrument?.preset;
        const pr = effectivePreset(t);
        if (ch.presetId !== pid) {
          ch.instrument?.dispose();
          ch.instrument = pr.kind === 'sample' ? new Sampler(this.ctx, pr, ch.input) : new Synth(this.ctx, pr, ch.input);
          ch.presetId = pid;
          ch.paramKey = JSON.stringify(t.instrument.params || {});
          if (!ch.instrument.ready) {
            const inst = ch.instrument;
            this.emit('loading', t.id, true);
            inst.loading.then(() => this.emit('loading', t.id, false), () => this.emit('loading', t.id, 'error'));
          }
        } else {
          const key = JSON.stringify(t.instrument.params || {});
          if (key !== ch.paramKey) { ch.instrument.setPreset(pr); ch.paramKey = key; }
        }
      }
      const audible = !t.mute && (!anySolo || t.solo);
      ch.setGain(audible ? dbToGain(t.volume) : 0);
      ch.setPan(t.pan || 0);
    }
    this.master.gain.setTargetAtTime(dbToGain(p.masterVolume), this.ctx.currentTime, 0.015);
    this.clickGain.gain.value = p.metronome.volume;
  }

  // ---------- transport ----------

  maps() {
    const p = this.getProject();
    return { meter: new MeterMap(p.meters), tempo: new TempoMap(p.tempos), p };
  }

  /** Current playhead tick, compensated for output latency. */
  currentTick() {
    if (!this.playing || !this.ctx) return this.positionTick;
    const { tempo } = this.maps();
    const now = this.ctx.currentTime - this.latency;
    let a = this.anchors[0];
    for (const x of this.anchors) { if (x.time <= now) a = x; else break; }
    const sec = tempo.tickToSec(a.tick) + (now - a.time);
    // before playback actually starts (latency/start offset), hold at the start tick
    if (now < a.time) return a.tick;
    return Math.max(0, tempo.secToTick(sec));
  }

  play(fromTick = this.positionTick) {
    this.ensureContext();
    if (this.playing) return;
    const startTime = this.ctx.currentTime + 0.06;
    this.anchors = [{ tick: fromTick, time: startTime }];
    this.cursorTick = fromTick;
    this.playing = true;
    this.tickScheduler();
    this.timer = setInterval(() => this.tickScheduler(), INTERVAL);
    this.emit('transport');
  }

  stop() {
    if (!this.playing) { this.positionTick = 0; this.emit('transport'); return; }
    const t = this.currentTick();
    this.finishRecording(t);
    this.playing = false;
    clearInterval(this.timer);
    for (const ch of this.channels.values()) ch.instrument?.allNotesOff();
    this.positionTick = Math.max(0, Math.round(t));
    this.emit('transport');
  }

  setPosition(tick) {
    const wasPlaying = this.playing;
    if (wasPlaying) {
      this.finishRecording(this.currentTick());
      this.playing = false;
      clearInterval(this.timer);
      for (const ch of this.channels.values()) ch.instrument?.allNotesOff();
    }
    this.positionTick = Math.max(0, Math.round(tick));
    if (wasPlaying) {
      const rec = this.recording;
      this.play(this.positionTick);
      if (rec) this.startRecording(this.recordTrackId);
    } else this.emit('transport');
  }

  timeOfTick(tick, anchor, tempo) {
    return anchor.time + (tempo.tickToSec(tick) - tempo.tickToSec(anchor.tick));
  }

  tickScheduler() {
    if (!this.playing) return;
    const { meter, tempo, p } = this.maps();
    const targetTime = this.ctx.currentTime + LOOKAHEAD;
    const loop = p.loop;
    const looping = loop.enabled && loop.end > loop.start;
    const songEnd = meter.barToTick(p.lengthBars);
    for (let guard = 0; guard < 8; guard++) {
      const anchor = this.anchors[this.anchors.length - 1];
      const targetTick = tempo.secToTick(tempo.tickToSec(anchor.tick) + (targetTime - anchor.time));
      if (targetTick <= this.cursorTick) break;
      if (looping && this.cursorTick < loop.end && targetTick >= loop.end) {
        this.scheduleRange(this.cursorTick, loop.end, anchor, meter, tempo, p, loop.end);
        const wrapTime = this.timeOfTick(loop.end, anchor, tempo);
        this.anchors.push({ tick: loop.start, time: wrapTime });
        this.cursorTick = loop.start;
        continue;
      }
      this.scheduleRange(this.cursorTick, targetTick, anchor, meter, tempo, p, looping ? loop.end : Infinity);
      this.cursorTick = targetTick;
      break;
    }
    // forget anchors that are long past
    while (this.anchors.length > 2 && this.anchors[1].time < this.ctx.currentTime - 1) this.anchors.shift();
    if (!looping && this.currentTick() > songEnd) this.stop();
  }

  scheduleRange(from, to, anchor, meter, tempo, p, cutTick) {
    const time = (tick) => this.timeOfTick(tick, anchor, tempo);
    for (const t of p.tracks) {
      if (t.type !== 'instrument') continue;
      const ch = this.channels.get(t.id);
      if (!ch?.instrument) continue;
      for (const c of t.clips) {
        const cEnd = c.start + c.length;
        if (cEnd <= from || c.start >= to) continue;
        for (const n of c.notes) {
          const on = c.start + n.t;
          if (on < from || on >= to || on >= cEnd) continue;
          const off = Math.min(on + n.d, cEnd, cutTick);
          ch.instrument.noteOn(n.p, n.v, time(on));
          ch.instrument.noteOff(n.p, time(Math.max(on + 1, off)));
        }
      }
    }
    if (p.metronome.enabled) {
      for (const b of meter.beatsBetween(from, to)) this.click(time(b.tick), b.accent);
    }
  }

  click(time, accent) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = accent === 2 ? 1760 : accent === 1 ? 1320 : 990;
    const peak = accent === 2 ? 0.9 : accent === 1 ? 0.65 : 0.45;
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(peak, time + 0.001);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
    o.connect(g).connect(this.clickGain);
    o.start(time);
    o.stop(time + 0.06);
  }

  // ---------- live input ----------

  liveNoteOn(trackId, pitch, vel) {
    this.ensureContext();
    const ch = this.channels.get(trackId);
    ch?.instrument?.noteOn(pitch, vel, this.ctx.currentTime);
    this.emit('live', pitch, true);
    if (this.recording && this.playing && trackId === this.recordTrackId) {
      const tick = Math.round(this.currentTick());
      const n = { tick, p: pitch, v: vel, d: null };
      this.recorded.push(n);
      this.openRec.set(pitch, n);
    }
  }

  liveNoteOff(trackId, pitch) {
    if (!this.ctx) return;
    const ch = this.channels.get(trackId);
    ch?.instrument?.noteOff(pitch, this.ctx.currentTime, true);
    this.emit('live', pitch, false);
    const n = this.openRec.get(pitch);
    if (n) { this.closeRec(n, Math.round(this.currentTick())); this.openRec.delete(pitch); }
  }

  liveSustain(trackId, on) {
    this.channels.get(trackId)?.instrument?.setSustain(on);
  }

  closeRec(n, offTick) {
    const loop = this.getProject().loop;
    if (offTick <= n.tick) offTick = loop.enabled ? loop.end : n.tick + 120; // wrapped around a loop
    n.d = Math.max(30, offTick - n.tick);
  }

  allLiveOff() {
    for (const ch of this.channels.values()) ch.instrument?.allNotesOff();
  }

  startRecording(trackId) {
    this.recording = true;
    this.recordTrackId = trackId;
    this.recorded = [];
    this.openRec.clear();
    this.emit('transport');
  }

  stopRecording() {
    if (!this.recording) return;
    this.finishRecording(this.currentTick());
  }

  finishRecording(atTick) {
    if (!this.recording) return;
    for (const n of this.openRec.values()) this.closeRec(n, Math.round(atTick));
    this.openRec.clear();
    this.recording = false;
    const notes = this.recorded.filter((n) => n.d);
    this.recorded = [];
    if (notes.length) this.emit('recorded', { trackId: this.recordTrackId, notes });
    this.emit('transport');
  }

  /** True while a track's samples are still downloading. */
  isLoading(trackId) {
    const ch = this.channels.get(trackId);
    return !!ch?.instrument && !ch.instrument.ready;
  }

  /** Short preview of a note (piano roll clicks). */
  preview(trackId, pitch, vel = 100, dur = 0.35) {
    this.ensureContext();
    const inst = this.channels.get(trackId)?.instrument;
    if (!inst) return;
    const t = this.ctx.currentTime;
    inst.noteOn(pitch, vel, t);
    inst.noteOff(pitch, t + dur);
  }

  // ---------- meters ----------

  trackPeak(id) { return this.channels.get(id)?.peak() || 0; }

  masterPeak() {
    if (!this.masterAnalyser) return 0;
    this.masterAnalyser.getFloatTimeDomainData(this.masterBuf);
    let m = 0;
    for (const v of this.masterBuf) { const a = Math.abs(v); if (a > m) m = a; }
    return m;
  }
}
