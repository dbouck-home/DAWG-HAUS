// Audio engine: mixer channels, instruments, transport scheduler, metronome,
// live input and MIDI recording.
import { MeterMap, TempoMap } from '../timing.js';
import { Synth } from './synth.js';
import { effectivePreset } from './presets.js';
import { Sampler } from './sampler.js';
import { DrumKit } from './drums.js';
import { SampleInstrument } from './sampleinst.js';
import { createFx, updateFx } from './effects.js';
import { valueAt, activeLane } from '../automation.js';
import { loadAudio } from '../storage.js';

const LOOKAHEAD = 0.12; // seconds scheduled ahead
const INTERVAL = 25; // ms between scheduler runs

/** Load the AudioWorklet processors (recorder, autotune) into a context once. */
export function loadWorklets(ctx) {
  if (!ctx.__dawgWorkletsLoading) {
    ctx.__dawgWorkletsLoading = ctx.audioWorklet.addModule(new URL('./worklets.js', import.meta.url))
      .then(() => { ctx.__dawgWorklets = true; });
  }
  return ctx.__dawgWorkletsLoading;
}

export const dbToGain = (db) => (db <= -60 ? 0 : Math.pow(10, db / 20));

/** An insert-effects chain between two nodes. Rebuilds connections only when the chain changes. */
class FxChain {
  constructor(ctx, from, to) {
    this.ctx = ctx;
    this.from = from;
    this.to = to;
    this.insts = new Map();
    this.key = null;
    from.connect(to);
  }

  sync(list = []) {
    const key = JSON.stringify(list.map((f) => [f.id, f.type, f.on !== false]));
    if (key !== this.key) {
      this.key = key;
      const ids = new Set(list.map((f) => f.id));
      for (const [id, inst] of this.insts) {
        if (!ids.has(id)) { try { inst.output.disconnect(); inst.dispose?.(); } catch { /* ignore */ } this.insts.delete(id); }
      }
      this.from.disconnect();
      for (const inst of this.insts.values()) { try { inst.output.disconnect(); } catch { /* ignore */ } }
      let node = this.from;
      for (const f of list) {
        let inst = this.insts.get(f.id);
        if (!inst) { inst = createFx(this.ctx, f); this.insts.set(f.id, inst); }
        if (f.on === false) continue;
        node.connect(inst.input);
        node = inst.output;
      }
      node.connect(this.to);
    }
    for (const f of list) { const inst = this.insts.get(f.id); if (inst) updateFx(inst, f); }
  }

  /** Recreate effects that were only placeholders (worklet not loaded yet). */
  rebuildPending() {
    for (const [id, inst] of this.insts) {
      if (inst.pending) { try { inst.output.disconnect(); } catch { /* ignore */ } this.insts.delete(id); this.key = null; }
    }
  }

  tempo(bpm, at) {
    for (const inst of this.insts.values()) {
      if (inst.tempo && inst.lastBpm !== bpm) { inst.lastBpm = bpm; inst.tempo(bpm, at); }
    }
  }

  dispose() { for (const inst of this.insts.values()) { try { inst.dispose?.(); } catch { /* ignore */ } } }
}

class Channel {
  constructor(ctx, dest) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.fader = ctx.createGain(); // volume (automatable)
    this.muteGain = ctx.createGain(); // mute / solo
    this.panner = ctx.createStereoPanner();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.fx = new FxChain(ctx, this.input, this.fader);
    this.fader.connect(this.muteGain).connect(this.panner).connect(this.analyser).connect(dest);
    this.instrument = null;
    this.presetId = null;
    this.meterBuf = new Float32Array(this.analyser.fftSize);
  }

  setGain(g) { this.fader.gain.setTargetAtTime(g, this.ctx.currentTime, 0.015); }
  setMute(m) { this.muteGain.gain.setTargetAtTime(m ? 0 : 1, this.ctx.currentTime, 0.01); }
  setPan(p) { this.panner.pan.setTargetAtTime(p, this.ctx.currentTime, 0.015); }

  peak() {
    this.analyser.getFloatTimeDomainData(this.meterBuf);
    let m = 0;
    for (let i = 0; i < this.meterBuf.length; i++) { const a = Math.abs(this.meterBuf[i]); if (a > m) m = a; }
    return m;
  }

  dispose() {
    this.instrument?.dispose();
    this.fx.dispose();
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
    this.sources = new Set();
    this.audioBuffers = new Map();
    this.audioLoading = new Map();
    this.peakCache = new Map();
    this.input = null;
    this.audioRec = null;
  }

  on(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  emit(ev, ...a) { (this.listeners[ev] || []).forEach((f) => f(...a)); }

  /** Create the AudioContext (must follow a user gesture). */
  ensureContext() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.setupContext(new AC({ latencyHint: 'interactive' }));
    }
    if (this.ctx.state === 'suspended' && this.ctx.resume) this.ctx.resume();
    return this.ctx;
  }

  /** Build the master bus on a context (a live AudioContext, or an OfflineAudioContext for export). */
  setupContext(ctx) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.1;
    this.masterAnalyser = ctx.createAnalyser();
    this.masterAnalyser.fftSize = 512;
    this.masterBuf = new Float32Array(512);
    this.masterFx = new FxChain(ctx, this.master, this.limiter);
    this.limiter.connect(this.masterAnalyser).connect(ctx.destination);
    this.clickGain = ctx.createGain();
    this.clickGain.connect(ctx.destination);
    this.workletsReady = loadWorklets(ctx).then(() => {
      // effects created before the worklets loaded (autotune) get rebuilt now
      for (const ch of this.channels.values()) ch.fx.rebuildPending();
      this.masterFx.rebuildPending();
      this.sync();
    }).catch((e) => console.warn('Audio worklets failed to load', e));
    this.sync();
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
      if (t.type === 'drums') {
        const key = JSON.stringify(t.drums || {});
        if (!(ch.instrument instanceof DrumKit)) {
          if (ch.instrument instanceof SampleInstrument) ch.presetId = null;
          ch.instrument?.dispose();
          ch.instrument = new DrumKit(this.ctx, t, ch.input);
          ch.presetId = null;
          ch.paramKey = key;
        } else if (key !== ch.paramKey) { ch.instrument.setTrack(t); ch.paramKey = key; }
      }
      if (t.type === 'sampler') {
        const key = JSON.stringify(t.sampler || {});
        if (!(ch.instrument instanceof SampleInstrument)) {
          ch.instrument?.dispose();
          ch.instrument = new SampleInstrument(this.ctx, t, ch.input, (id) => this.audioBuffers.get(id) || (this.loadAudioBuffer(id), null));
          ch.presetId = null;
          ch.paramKey = key;
        } else if (key !== ch.paramKey) { ch.instrument.setTrack(t); ch.paramKey = key; }
        if (t.sampler?.audioId && !this.audioBuffers.has(t.sampler.audioId)) this.loadAudioBuffer(t.sampler.audioId);
      }
      if (t.type === 'instrument') {
        if (ch.instrument instanceof DrumKit || ch.instrument instanceof SampleInstrument) { ch.instrument.dispose(); ch.instrument = null; ch.presetId = null; }
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
      ch.setMute(!(!t.mute && (!anySolo || t.solo)));
      ch.fx.sync(t.fx || []);
      // automated settings follow their lane; while playing the scheduler drives them
      if (!this.playing) {
        const pos = this.positionTick;
        const vol = activeLane(t, 'volume');
        const pan = activeLane(t, 'pan');
        ch.setGain(dbToGain(vol ? valueAt(vol.points, pos) : t.volume));
        ch.setPan(pan ? valueAt(pan.points, pos) : (t.pan || 0));
        for (const lane of t.automation || []) {
          if (!lane.points.length || !lane.target.startsWith('fx:')) continue;
          for (const pr of this.resolve(t, lane.target)) pr.param.setTargetAtTime(pr.map(valueAt(lane.points, pos)), this.ctx.currentTime, 0.01);
        }
      } else {
        if (!activeLane(t, 'volume')) ch.setGain(dbToGain(t.volume));
        if (!activeLane(t, 'pan')) ch.setPan(t.pan || 0);
      }
    }
    this.masterFx.sync(p.masterFx || []);
    const tempo = new TempoMap(p.tempos);
    const bpm = tempo.bpmAt(this.playing ? this.currentTick() : this.positionTick);
    for (const ch of this.channels.values()) ch.fx.tempo(bpm, this.ctx.currentTime);
    this.masterFx.tempo(bpm, this.ctx.currentTime);
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

  /**
   * Start playback. opts.countInBars: play that many bars of metronome clicks first
   * (in the time signature and tempo at the start point), then start.
   */
  play(fromTick = this.positionTick, opts = {}) {
    this.ensureContext();
    if (this.playing) return;
    let startTime = this.ctx.currentTime + 0.06;
    this.countIn = null;
    if (opts.countInBars > 0) {
      const { meter, tempo } = this.maps();
      const seg = meter.segmentForTick(fromTick);
      const beatSec = (60 / tempo.bpmAt(fromTick)) * (4 / seg.den);
      const beats = seg.num * opts.countInBars;
      const t0 = this.ctx.currentTime + 0.1;
      this.countGain = this.ctx.createGain();
      this.countGain.connect(this.clickGain);
      const groupStarts = new Set([0]);
      if (seg.groups) { let a = 0; for (const g of seg.groups) { groupStarts.add(a); a += g; } }
      for (let i = 0; i < beats; i++) {
        const b = i % seg.num;
        this.click(t0 + i * beatSec, b === 0 ? 2 : groupStarts.has(b) ? 1 : 0, this.countGain, true);
      }
      startTime = t0 + beats * beatSec;
      this.countIn = { t0, beatSec, beats, until: startTime };
    }
    this.anchors = [{ tick: fromTick, time: startTime }];
    this.cursorTick = fromTick;
    this.playing = true;
    this.autoFresh = true;
    this.tickScheduler();
    this.timer = setInterval(() => this.tickScheduler(), INTERVAL);
    this.emit('transport');
  }

  stop() {
    if (this.audioRec) this.stopAudioRecording();
    if (this.countGain) { try { this.countGain.disconnect(); } catch { /* ignore */ } this.countGain = null; }
    this.countIn = null;
    if (!this.playing) { this.positionTick = 0; this.emit('transport'); return; }
    const t = this.currentTick();
    this.finishRecording(t);
    this.playing = false;
    clearInterval(this.timer);
    for (const ch of this.channels.values()) ch.instrument?.allNotesOff();
    this.stopSources();
    this.positionTick = Math.max(0, Math.round(t));
    this.releaseAutomation();
    this.emit('transport');
  }

  /** Cancel scheduled automation and go back to the static (or stopped-position) values. */
  releaseAutomation() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const t of this.getProject().tracks) {
      for (const lane of t.automation || []) {
        for (const pr of this.resolve(t, lane.target)) {
          pr.param.cancelScheduledValues(now);
          pr.param.setValueAtTime(pr.param.value, now);
        }
      }
    }
    this.sync();
  }

  /** The AudioParams a lane drives: [{ param, map(value) }]. */
  resolve(track, target) {
    const ch = this.channels.get(track.id);
    if (!ch) return [];
    if (target === 'volume') return [{ param: ch.fader.gain, map: dbToGain }];
    if (target === 'pan') return [{ param: ch.panner.pan, map: (v) => v }];
    if (target.startsWith('fx:')) {
      const [, id, key] = target.split(':');
      const inst = ch.fx.insts.get(id);
      const a = inst?.automatable(key);
      if (!a) return [];
      return a.also ? [a, a.also] : [a];
    }
    return [];
  }

  setPosition(tick) {
    if (this.audioRec) this.stopAudioRecording();
    const wasPlaying = this.playing;
    if (wasPlaying) {
      this.finishRecording(this.currentTick());
      this.playing = false;
      clearInterval(this.timer);
      for (const ch of this.channels.values()) ch.instrument?.allNotesOff();
      this.stopSources();
      this.releaseAutomation();
    }
    this.positionTick = Math.max(0, Math.round(tick));
    if (!wasPlaying) this.sync();
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
    // no looping while recording audio (a take is one continuous recording)
    const looping = loop.enabled && loop.end > loop.start && !this.audioRec;
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
        this.autoFresh = true;
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
    const fresh = this.autoFresh;
    for (const t of p.tracks) {
      if (t.type === 'audio') { this.scheduleAudio(t, from, to, time, tempo, cutTick, fresh); continue; }
      const ch = this.channels.get(t.id);
      if (!ch?.instrument) continue;
      for (const c of t.clips) {
        const cEnd = c.start + c.length;
        if (cEnd <= from || c.start >= to) continue;
        const swing = c.swing ? (c.swing / 100) * ((c.swingGrid || 240) / 3) : 0;
        const sg = c.swingGrid || 240;
        // repeating clips play their pattern again every `loop` ticks
        const L = c.loop && c.loop > 0 ? c.loop : c.length;
        const kFrom = Math.max(0, Math.floor((from - c.start - L) / L));
        const kTo = Math.floor((to - c.start) / L);
        for (let k = kFrom; k <= kTo; k++) {
          const base = c.start + k * L;
          if (base >= cEnd) break;
          const repEnd = Math.min(base + L, cEnd);
          for (const n of c.notes) {
            if (n.t >= L) continue;
            let on = base + n.t;
            if (swing) {
              // delay every second grid step (shuffle feel)
              const step = Math.round(n.t / sg);
              if (step % 2 === 1 && Math.abs(n.t - step * sg) < sg * 0.25) on += swing;
            }
            if (on < from || on >= to || on >= repEnd) continue;
            const off = Math.min(on + n.d, repEnd, cutTick);
            ch.instrument.noteOn(n.p, n.v, time(on));
            ch.instrument.noteOff(n.p, time(Math.max(on + 1, off)));
          }
        }
      }
    }
    if (p.metronome.enabled) {
      for (const b of meter.beatsBetween(from, to)) this.click(time(b.tick), b.accent);
    }
    this.scheduleAutomation(from, to, time, tempo, p);
  }

  /** Start the recorded-audio clips that begin in this window (or that we start in the middle of). */
  scheduleAudio(t, from, to, time, tempo, cutTick, fresh) {
    const ch = this.channels.get(t.id);
    if (!ch) return;
    for (const c of t.clips) {
      if (!c.audioId) continue;
      const cEnd = c.start + c.length;
      if (cEnd <= from || c.start >= to) continue;
      const buf = this.audioBuffers.get(c.audioId);
      if (!buf) { this.loadAudioBuffer(c.audioId); continue; }
      // a looped recording repeats its section every `loop` ticks
      const L = c.loop && c.loop > 0 ? c.loop : c.length;
      const kFrom = Math.max(0, Math.floor((from - c.start) / L));
      const kTo = Math.floor((to - c.start) / L);
      for (let k = kFrom; k <= kTo; k++) {
        const base = c.start + k * L;
        const repEnd = Math.min(base + L, cEnd);
        if (repEnd <= from || base >= to || base >= cEnd) continue;
        let startTick;
        if (base >= from && base < to) startTick = base;
        else if (fresh && base < from && repEnd > from) startTick = from; // playback starts inside it
        else continue;
        this.playAudioSegment(ch, c, buf, startTick, base, Math.min(repEnd, cutTick), time, tempo);
      }
    }
  }

  /** Play part of a recording: the section that starts at `base` (song ticks), from `startTick` to `endTick`. */
  playAudioSegment(ch, c, buf, startTick, base, endTick, time, tempo) {
    if (endTick <= startTick) return;
    const when = time(startTick);
    const offset = (c.srcOffset || 0) + (tempo.tickToSec(startTick) - tempo.tickToSec(base));
    const dur = time(endTick) - when;
    if (offset >= buf.duration || dur <= 0) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    const lvl = dbToGain(c.gain || 0);
    // tiny fades avoid clicks at the edges
    const now = Math.max(when, this.ctx.currentTime);
    const len = Math.max(0, dur - (now - when));
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(lvl, now + 0.004);
    g.gain.setValueAtTime(lvl, now + Math.max(0.005, len - 0.006));
    g.gain.linearRampToValueAtTime(0, now + len);
    src.connect(g).connect(ch.input);
    src.start(now, offset + (now - when), len);
    this.sources.add(src);
    src.onended = () => { this.sources.delete(src); try { g.disconnect(); } catch { /* ignore */ } };
  }

  stopSources() {
    for (const s of this.sources) { try { s.stop(); } catch { /* ignore */ } }
    this.sources.clear();
  }

  /** Load a recording from storage into an AudioBuffer (cached). */
  loadAudioBuffer(id) {
    if (!this.ctx || this.audioLoading.has(id)) return this.audioLoading.get(id);
    const p = (async () => {
      const rec = await loadAudio(id);
      if (!rec) return null;
      const buf = this.ctx.createBuffer(1, rec.data.length, rec.sampleRate);
      buf.copyToChannel(rec.data, 0);
      this.audioBuffers.set(id, buf);
      this.emit('audio-loaded', id);
      return buf;
    })();
    this.audioLoading.set(id, p);
    return p;
  }

  /** Min/max pairs for drawing a waveform (one pair per `per` samples). */
  peaks(id, per = 256) {
    const key = `${id}:${per}`;
    if (this.peakCache.has(key)) return this.peakCache.get(key);
    const buf = this.audioBuffers.get(id);
    if (!buf) { this.loadAudioBuffer(id); return null; }
    const d = buf.getChannelData(0);
    const n = Math.ceil(d.length / per);
    const out = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      let lo = 0; let hi = 0;
      for (let j = i * per, e = Math.min(d.length, j + per); j < e; j++) { const v = d[j]; if (v < lo) lo = v; if (v > hi) hi = v; }
      out[i * 2] = lo; out[i * 2 + 1] = hi;
    }
    const res = { data: out, per, sampleRate: buf.sampleRate };
    this.peakCache.set(key, res);
    return res;
  }

  // ---------- microphone input, monitoring and audio recording ----------

  /** Open (or switch) the microphone. Returns the device label. */
  /**
   * Open (or switch) the microphone / audio interface.
   * channel: 'both' (mix the first two inputs), '1' (input 1 / left) or '2' (input 2 / right) —
   * audio interfaces usually put a mic on just one of their inputs.
   */
  async openInput(deviceId, channel = 'both') {
    this.ensureContext();
    await this.workletsReady;
    const live = this.input?.stream.getAudioTracks().some((tr) => tr.readyState === 'live');
    if (this.input && live && this.input.deviceId === (deviceId || '') && this.input.channel === channel) return this.input.label;
    this.closeInput();
    const constraints = (id) => ({
      audio: {
        deviceId: id ? { exact: id } : undefined,
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        channelCount: { ideal: 2 },
      },
    });
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints(deviceId));
    } catch (e) {
      // the saved device is gone (unplugged) — fall back to the default input
      if (deviceId && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) stream = await navigator.mediaDevices.getUserMedia(constraints(''));
      else throw e;
    }
    const ctx = this.ctx;
    const src = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    const chCount = stream.getAudioTracks()[0]?.getSettings?.().channelCount || 1;
    if (channel !== 'both' && chCount > 1) {
      const split = ctx.createChannelSplitter(2);
      src.connect(split);
      split.connect(gain, channel === '2' ? 1 : 0);
    } else {
      src.connect(gain);
    }
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    const recorder = new AudioWorkletNode(ctx, 'dawg-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    const monitor = ctx.createGain();
    monitor.gain.value = 0;
    const sink = ctx.createGain();
    sink.gain.value = 0;
    gain.connect(analyser);
    gain.connect(recorder);
    recorder.connect(sink).connect(ctx.destination); // keeps the recorder running
    recorder.connect(monitor);
    const track = stream.getAudioTracks()[0];
    const settings = track.getSettings?.() || {};
    this.input = {
      stream, src, gain, analyser, recorder, monitor, sink, deviceId: deviceId || '', channel, channels: chCount,
      label: track.label || 'Microphone', latency: settings.latency || 0.01, buf: new Float32Array(1024), monitorTo: null,
    };
    recorder.port.onmessage = (e) => this.onRecorderMessage(e.data);
    this.syncInput();
    return this.input.label;
  }

  closeInput() {
    if (!this.input) return;
    try { this.input.stream.getTracks().forEach((tr) => tr.stop()); this.input.src.disconnect(); this.input.recorder.disconnect(); } catch { /* ignore */ }
    this.input = null;
  }

  inputPeak() {
    if (!this.input) return 0;
    this.input.analyser.getFloatTimeDomainData(this.input.buf);
    let m = 0;
    for (const v of this.input.buf) { const a = Math.abs(v); if (a > m) m = a; }
    return m;
  }

  /** Route the mic to the selected audio track when monitoring is on; apply input gain. */
  syncInput(selectedTrackId = this.monitorTrackId) {
    this.monitorTrackId = selectedTrackId;
    const inp = this.input;
    if (!inp) return;
    const p = this.getProject();
    const t = p.tracks.find((x) => x.id === selectedTrackId && x.type === 'audio');
    inp.gain.gain.setTargetAtTime(dbToGain(t?.input?.gain ?? 0), this.ctx.currentTime, 0.02);
    const target = t && t.input?.monitor ? this.channels.get(t.id)?.input : null;
    if (inp.monitorTo !== target) {
      try { inp.monitor.disconnect(); } catch { /* ignore */ }
      if (target) inp.monitor.connect(target);
      inp.monitorTo = target;
    }
    inp.monitor.gain.setTargetAtTime(target ? 1 : 0, this.ctx.currentTime, 0.02);
  }

  /** Seconds between a sound being played and the same moment arriving back through the mic. */
  get recordLatency() {
    const extra = (+localStorage.getItem('dawg:latencyMs') || 0) / 1000;
    return this.latency + (this.input?.latency || 0) + extra;
  }

  /** Tick that plays at a given AudioContext time. */
  tickAtTime(time) {
    const { tempo } = this.maps();
    let a = this.anchors[0];
    for (const x of this.anchors) { if (x.time <= time) a = x; else break; }
    return Math.max(0, tempo.secToTick(tempo.tickToSec(a.tick) + (time - a.time)));
  }

  startAudioRecording(trackId) {
    if (!this.input || !this.playing) return false;
    const startTime = Math.max(this.anchors[0].time, this.ctx.currentTime + 0.02);
    this.audioRec = { trackId, startTime, startTick: Math.round(this.tickAtTime(startTime)), chunks: [], t0: null, sampleRate: this.ctx.sampleRate };
    this.input.recorder.port.postMessage({ cmd: 'start' });
    this.recording = true;
    this.recordTrackId = trackId;
    this.emit('transport');
    return true;
  }

  /** Record a sample from the mic (no transport needed). Resolves with { data, sampleRate } on stop. */
  startSampleRecording() {
    if (!this.input) return false;
    this.sampleRec = { chunks: [], t0: null, startTime: this.ctx.currentTime + 0.02 };
    this.sampleRec.done = new Promise((res) => { this.sampleRec.resolve = res; });
    this.input.recorder.port.postMessage({ cmd: 'start' });
    return this.sampleRec.done;
  }

  stopSampleRecording() {
    if (!this.sampleRec) return;
    this.input?.recorder.port.postMessage({ cmd: 'stop' });
  }

  onRecorderMessage(m) {
    if (this.sampleRec) {
      const r = this.sampleRec;
      if (m.type === 'started') r.t0 = m.time;
      else if (m.type === 'data') r.chunks.push(m.data);
      else if (m.type === 'stopped') {
        this.sampleRec = null;
        let total = 0;
        for (const c of r.chunks) total += c.length;
        const all = new Float32Array(total);
        let o = 0;
        for (const c of r.chunks) { all.set(c, o); o += c.length; }
        r.resolve({ data: all, sampleRate: this.ctx.sampleRate });
      }
      return;
    }
    const r = this.audioRec;
    if (!r) return;
    if (m.type === 'started') r.t0 = m.time;
    else if (m.type === 'data') r.chunks.push(m.data);
    else if (m.type === 'stopped') this.finishAudioRecording();
  }

  stopAudioRecording() {
    if (!this.audioRec || this.audioRec.stopping) return;
    this.audioRec.stopping = true;
    this.audioRec.endTime = this.ctx.currentTime;
    this.input?.recorder.port.postMessage({ cmd: 'stop' });
  }

  finishAudioRecording() {
    const r = this.audioRec;
    this.audioRec = null;
    this.recording = false;
    this.emit('transport');
    if (!r || r.t0 == null) return;
    let total = 0;
    for (const c of r.chunks) total += c.length;
    const all = new Float32Array(total);
    let o = 0;
    for (const c of r.chunks) { all.set(c, o); o += c.length; }
    // skip what came in before the take started, plus the round-trip latency
    const skip = Math.max(0, Math.round((r.startTime - r.t0 + this.recordLatency) * r.sampleRate));
    const wanted = Math.max(0, Math.round((r.endTime - r.startTime) * r.sampleRate));
    const data = all.slice(skip, skip + wanted);
    if (data.length < r.sampleRate * 0.05) return; // too short to keep
    this.emit('audio-recorded', { trackId: r.trackId, startTick: r.startTick, data, sampleRate: r.sampleRate });
  }

  scheduleAutomation(from, to, time, tempo, p) {
    const fresh = this.autoFresh;
    this.autoFresh = false;
    const tFrom = Math.max(time(from), this.ctx.currentTime);
    for (const t of p.tracks) {
      for (const lane of t.automation || []) {
        if (!lane.points.length) continue;
        const prs = this.resolve(t, lane.target);
        if (!prs.length) continue;
        const pts = lane.points;
        for (const { param, map } of prs) {
          if (fresh) {
            param.cancelScheduledValues(tFrom);
            param.setValueAtTime(map(valueAt(pts, from)), tFrom);
          }
          for (const pt of pts) if (pt.t > from && pt.t <= to) param.linearRampToValueAtTime(map(pt.v), time(pt.t));
          param.linearRampToValueAtTime(map(valueAt(pts, to)), time(to));
        }
      }
    }
    // tempo-synced effects (delays, wobbles) follow tempo changes
    if (p.tempos.length > 1 || fresh) {
      const bpm = tempo.bpmAt(from);
      for (const ch of this.channels.values()) ch.fx.tempo(bpm, tFrom);
      this.masterFx.tempo(bpm, tFrom);
    }
  }

  /** Beats left in the count-in (0 when not counting in). */
  countInLeft() {
    const c = this.countIn;
    if (!c || !this.ctx || this.ctx.currentTime >= c.until) return 0;
    return Math.max(1, c.beats - Math.floor((this.ctx.currentTime - c.t0) / c.beatSec));
  }

  click(time, accent, dest = this.clickGain, loud = false) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = accent === 2 ? 1760 : accent === 1 ? 1320 : 990;
    const peak = accent === 2 ? 0.9 : accent === 1 ? 0.65 : 0.45;
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(peak, time + 0.001);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
    // count-in clicks play even if the metronome volume is turned all the way down
    if (loud && this.getProject().metronome.volume < 0.3) g.gain.value *= 2;
    o.connect(g).connect(dest);
    o.start(time);
    o.stop(time + 0.06);
  }

  // ---------- live input ----------

  liveNoteOn(trackId, pitch, vel) {
    this.ensureContext();
    const ch = this.channels.get(trackId);
    ch?.instrument?.noteOn(pitch, vel, this.ctx.currentTime);
    this.emit('live', pitch, true, trackId);
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
    this.emit('live', pitch, false, trackId);
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
