// Export: render the song offline (faster than real time) and encode it as WAV or MP3.
import { MeterMap, TempoMap } from './timing.js';
import { Engine } from './audio/engine.js';

/** Last tick where anything plays. */
export function songEndTick(project) {
  let end = 0;
  for (const t of project.tracks) for (const c of t.clips) end = Math.max(end, c.start + c.length);
  return end;
}

/**
 * Render the song (or the loop region) to an AudioBuffer.
 * opts: { range: 'song' | 'loop', sampleRate, tail (seconds), onProgress(0..1) }
 */
export async function renderSong(project, mainEngine, opts) {
  const p = JSON.parse(JSON.stringify(project));
  p.metronome.enabled = false;
  const useLoop = opts.range === 'loop' && project.loop.end > project.loop.start;
  p.loop.enabled = false; // render straight through
  const meter = new MeterMap(p.meters);
  const tempo = new TempoMap(p.tempos);
  const start = useLoop ? project.loop.start : 0;
  const end = useLoop ? project.loop.end : songEndTick(p);
  if (end <= start) throw new Error('There is nothing to export yet — add some clips first.');
  const seconds = tempo.tickToSec(end) - tempo.tickToSec(start) + (opts.tail ?? 2);
  const sr = opts.sampleRate || 44100;
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sr), sr);

  const eng = new Engine(() => p);
  // recordings already in memory can be reused (AudioBuffers work in any context)
  for (const [id, buf] of mainEngine.audioBuffers) eng.audioBuffers.set(id, buf);
  eng.setupContext(ctx);
  await eng.workletsReady;
  eng.sync();
  // wait for sampled instruments and recordings to be ready
  const waits = [];
  for (const ch of eng.channels.values()) if (ch.instrument?.loading) waits.push(ch.instrument.loading.catch(() => null));
  for (const t of p.tracks) {
    for (const c of t.clips) if (c.audioId && !eng.audioBuffers.has(c.audioId)) waits.push(eng.loadAudioBuffer(c.audioId));
    if (t.sampler?.audioId && !eng.audioBuffers.has(t.sampler.audioId)) waits.push(eng.loadAudioBuffer(t.sampler.audioId));
  }
  await Promise.all(waits);

  // schedule everything at once
  eng.playing = true;
  eng.anchors = [{ tick: start, time: 0 }];
  eng.autoFresh = true;
  eng.scheduleRange(start, end, eng.anchors[0], meter, tempo, p, end);

  // progress: pause the render every second of audio to report how far it got
  if (opts.onProgress) {
    for (let t = 1; t < seconds; t += 1) {
      ctx.suspend(t).then(() => { opts.onProgress(t / seconds); ctx.resume(); });
    }
  }
  const buf = await ctx.startRendering();
  opts.onProgress?.(1);
  return buf;
}

export function peakOf(buf) {
  let m = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > m) m = a; }
  }
  return m;
}

/** Scale so the loudest sample is at -1 dBFS. */
export function normalize(buf) {
  const pk = peakOf(buf);
  if (pk <= 0) return;
  const g = 0.891 / pk;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= g;
  }
}

export function encodeWav(buf, bits = 16) {
  const ch = buf.numberOfChannels;
  const n = buf.length;
  const bytes = bits / 8;
  const dataLen = n * ch * bytes;
  const out = new ArrayBuffer(44 + dataLen);
  const v = new DataView(out);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, buf.sampleRate, true); v.setUint32(28, buf.sampleRate * ch * bytes, true);
  v.setUint16(32, ch * bytes, true); v.setUint16(34, bits, true);
  str(36, 'data'); v.setUint32(40, dataLen, true);
  const chans = [];
  for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      if (bits === 16) { v.setInt16(o, Math.round(s * 32767), true); o += 2; }
      else { const x = Math.round(s * 8388607); v.setUint8(o, x & 255); v.setUint8(o + 1, (x >> 8) & 255); v.setUint8(o + 2, (x >> 16) & 255); o += 3; }
    }
  }
  return new Blob([out], { type: 'audio/wav' });
}

/** MP3 encoding runs in a background worker (LAME). */
export function encodeMp3(buf, kbps = 192, onProgress) {
  return new Promise((resolve, reject) => {
    const toI16 = (d) => { const o = new Int16Array(d.length); for (let i = 0; i < d.length; i++) o[i] = Math.max(-32768, Math.min(32767, Math.round(d[i] * 32767))); return o; };
    const left = toI16(buf.getChannelData(0));
    const right = toI16(buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0));
    const w = new Worker(new URL('./mp3worker.js', import.meta.url));
    w.onmessage = (e) => {
      if (e.data.progress != null) onProgress?.(e.data.progress);
      if (e.data.done) { w.terminate(); resolve(new Blob(e.data.chunks, { type: 'audio/mpeg' })); }
      if (e.data.error) { w.terminate(); reject(new Error(e.data.error)); }
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'MP3 encoder failed')); };
    w.postMessage({ left, right, sampleRate: buf.sampleRate, kbps }, [left.buffer, right.buffer]);
  });
}

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
