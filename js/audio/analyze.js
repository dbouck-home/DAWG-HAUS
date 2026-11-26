// Tempo and key analysis for recorded audio and MIDI notes, and drum-hit detection (used by "Make MIDI").

// Krumhansl–Kessler key profiles
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function corr(a, b) {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** Best key for a 12-bin pitch-class profile: { tonic, mode, score, runnerUp } */
export function keyFromChroma(chroma) {
  const results = [];
  for (let t = 0; t < 12; t++) {
    const rot = (prof) => prof.map((_, i) => prof[(i - t + 12) % 12]);
    results.push({ tonic: t, mode: 'major', score: corr(chroma, rot(MAJOR)) });
    results.push({ tonic: t, mode: 'minor', score: corr(chroma, rot(MINOR)) });
  }
  results.sort((a, b) => b.score - a.score);
  return { ...results[0], runnerUp: results[1] };
}

/** Key of MIDI notes [{p, d}] (duration-weighted). */
export function keyFromNotes(notes) {
  const ch = new Array(12).fill(0);
  for (const n of notes) ch[((n.p % 12) + 12) % 12] += Math.max(60, n.d || 240);
  if (ch.every((x) => x === 0)) return null;
  return keyFromChroma(ch);
}

/** Mono, optionally downsampled copy of a section of an AudioBuffer. */
export function monoSection(buf, startSec = 0, endSec = buf.duration, maxSec = 90, factor = 1) {
  const sr = buf.sampleRate;
  const a = Math.max(0, Math.floor(startSec * sr));
  const b = Math.min(buf.length, Math.floor(Math.min(endSec, startSec + maxSec) * sr));
  const n = Math.max(0, Math.floor((b - a) / factor));
  const out = new Float32Array(n);
  const chans = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < factor; k++) for (const d of chans) s += d[a + i * factor + k];
    out[i] = s / (factor * chans.length);
  }
  return { data: out, sr: sr / factor };
}

// in-place radix-2 FFT
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k + len / 2] = re[i + k] - ar; im[i + k + len / 2] = im[i + k] - ai;
        re[i + k] += ar; im[i + k] += ai;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

/** Pitch-class energy of audio (for key detection). */
export function chromaOf(data, sr) {
  const N = 4096;
  const hop = 2048;
  const ch = new Array(12).fill(0);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const binPc = new Int8Array(N / 2).fill(-1);
  for (let k = 1; k < N / 2; k++) {
    const f = (k * sr) / N;
    if (f < 60 || f > 2200) continue;
    binPc[k] = ((Math.round(69 + 12 * Math.log2(f / 440)) % 12) + 12) % 12;
  }
  const re = new Float32Array(N), im = new Float32Array(N);
  for (let s = 0; s + N <= data.length; s += hop) {
    for (let i = 0; i < N; i++) { re[i] = data[s + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 1; k < N / 2; k++) {
      if (binPc[k] < 0) continue;
      ch[binPc[k]] += Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    }
  }
  return ch;
}

/** Onset-strength envelope: half-wave rectified energy rise per frame. */
function onsetEnvelope(data, sr, hop = 256) {
  const frames = Math.floor(data.length / hop);
  const env = new Float32Array(frames);
  let prev = 0;
  // emphasise attacks with a first difference (cheap high-pass)
  let last = 0;
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = 0; i < hop; i++) { const x = data[f * hop + i]; const d = x - last; last = x; e += d * d; }
    e = Math.log1p(1000 * e);
    env[f] = Math.max(0, e - prev);
    prev = e;
  }
  return { env, rate: sr / hop };
}

/** Tempo estimate { bpm, confidence (0..1), alternatives } from audio. */
export function tempoOf(data, sr) {
  const { env, rate } = onsetEnvelope(data, sr);
  if (env.length < rate * 3) return null;
  const mean = env.reduce((a, b) => a + b, 0) / env.length;
  for (let i = 0; i < env.length; i++) env[i] -= mean;
  const minLag = Math.floor((rate * 60) / 200);
  const maxLag = Math.ceil((rate * 60) / 55);
  const ac = new Float32Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = 0; i + lag < env.length; i++) s += env[i] * env[i + lag];
    ac[lag] = s / (env.length - lag);
  }
  let best = -1, bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * rate) / lag;
    // favour common tempos (log-normal around 115 BPM) and add the double-period evidence
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 115) / 0.9) ** 2);
    const dbl = lag * 2 <= maxLag + 1 ? ac[lag * 2] : 0;
    const score = (ac[lag] + 0.5 * dbl) * prior;
    if (score > bestScore) { bestScore = score; best = lag; }
  }
  if (best < 0) return null;
  // parabolic refinement
  let lagF = best;
  if (best > minLag && best < maxLag) {
    const y0 = ac[best - 1], y1 = ac[best], y2 = ac[best + 1];
    const den = y0 - 2 * y1 + y2;
    if (den) lagF = best + 0.5 * (y0 - y2) / den;
  }
  const bpm = (60 * rate) / lagF;
  const peak = ac[best];
  const zero = env.reduce((a, b) => a + b * b, 0) / env.length;
  return { bpm: Math.round(bpm * 10) / 10, confidence: Math.max(0, Math.min(1, peak / (zero || 1))), half: Math.round(bpm * 5) / 10, double: Math.round(bpm * 20) / 10 };
}

/** Analyze a section of recorded audio. */
export function analyzeAudio(buf, startSec, endSec) {
  const factor = buf.sampleRate > 30000 ? 4 : 2;
  const { data, sr } = monoSection(buf, startSec, endSec, 90, factor);
  const tempo = tempoOf(data, sr);
  const key = keyFromChroma(chromaOf(data, sr));
  return { tempo, key };
}

// ---------- drum hits for "Make MIDI" ----------

/** One-pole filters over a whole signal. */
function lowpass(x, sr, fc) { const a = Math.exp((-2 * Math.PI * fc) / sr); const y = new Float32Array(x.length); let s = 0; for (let i = 0; i < x.length; i++) { s = (1 - a) * x[i] + a * s; y[i] = s; } return y; }
function highpass(x, sr, fc) { const lp = lowpass(x, sr, fc); const y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) y[i] = x[i] - lp[i]; return y; }

/**
 * Find drum hits in a recording and guess kick / snare / hi-hat for each.
 * Returns [{ time (s from section start), pitch (GM drum note), vel }].
 */
export function detectDrumHits(buf, startSec, endSec, sensitivity = 0.5) {
  const { data, sr } = monoSection(buf, startSec, endSec, 600, buf.sampleRate > 30000 ? 2 : 1);
  const low = lowpass(lowpass(data, sr, 150), sr, 150);
  const high = highpass(highpass(data, sr, 6000), sr, 6000);
  const mid = highpass(lowpass(data, sr, 4000), sr, 300);
  const hop = Math.round(sr * 0.005); // 5 ms frames
  const frames = Math.floor(data.length / hop);
  const en = (x) => { const e = new Float32Array(frames); for (let f = 0; f < frames; f++) { let s = 0; for (let i = 0; i < hop; i++) { const v = x[f * hop + i]; s += v * v; } e[f] = s / hop; } return e; };
  const eAll = en(data), eLow = en(low), eMid = en(mid), eHigh = en(high);
  // onset function: rise in log energy
  const odf = new Float32Array(frames);
  for (let f = 1; f < frames; f++) odf[f] = Math.max(0, Math.log10(eAll[f] + 1e-9) - Math.log10(eAll[f - 1] + 1e-9));
  // adaptive threshold
  const W = 40; // ±200 ms
  const cands = [];
  let last = null;
  const peakAll = eAll.reduce((m, x) => Math.max(m, x), 0) || 1;
  const thrScale = 0.9 - 0.6 * sensitivity; // higher sensitivity → lower threshold
  const mean = (e, a, b) => { let s = 0, n = 0; for (let k = Math.max(0, a); k < Math.min(frames, b); k++) { s += e[k]; n++; } return n ? s / n : 0; };
  for (let f = 0; f < frames - 2; f++) {
    const isPeak = f === 0 ? eAll[0] > peakAll * 0.01 : odf[f] > odf[f - 1] && odf[f] >= odf[f + 1];
    if (!isPeak) continue;
    if (f > 0) {
      let s = 0; let c = 0;
      for (let k = Math.max(0, f - W); k < Math.min(frames, f + W); k++) { s += odf[k]; c++; }
      if (odf[f] < (s / c) * 1.5 + thrScale) continue;
    }
    let all = 0;
    for (let k = f; k < Math.min(frames, f + 6); k++) all = Math.max(all, eAll[k]);
    if (all < peakAll * 0.002 * (1.5 - sensitivity)) continue; // too quiet to be a hit
    const gap = last ? (f - last.f) * hop / sr : Infinity;
    if (gap < 0.045) continue; // 45 ms minimum gap
    // a quiet bump in the tail of a louder hit may just be drum resonance — decided after normalising
    const tail = gap < 0.35 && all < last.all * 0.45;
    // how much each band jumps at this onset
    const rise = (e) => Math.max(0, mean(e, f, f + 6) - mean(e, f - 8, f - 1));
    cands.push({ f, all, tail, lo: rise(eLow), mi: rise(eMid), hi: rise(eHigh) });
    if (!tail) last = { f, all };
  }
  // normalise each band by its typical strong rise in this recording, so a dull hi-hat still counts as "high"
  const p90 = (key) => { const v = cands.filter((c) => !c.tail).map((c) => c[key]).sort((a, b) => a - b); return v[Math.floor(v.length * 0.9)] || 1e-12; };
  const nLo = p90('lo'), nMi = p90('mi'), nHi = p90('hi');
  const hits = [];
  for (const c of cands) {
    const lo = c.lo / nLo, mi = c.mi / nMi, hi = c.hi / nHi;
    if (c.tail && hi < 0.25 && mi < 0.4) continue; // resonance, not a new hit
    const vel = Math.max(30, Math.min(127, Math.round(40 + 87 * Math.sqrt(c.all / peakAll))));
    const time = (c.f * hop) / sr;
    const notes = [];
    if (lo > 0.35 && lo > mi * 0.6) notes.push(36); // kick
    if (mi > 0.4 && mi > lo * 0.8) notes.push(38); // snare
    else if (hi > 0.25) notes.push(42); // hi-hat (a snare hides the hat it lands with)
    if (!notes.length) notes.push(lo >= mi && lo >= hi ? 36 : mi >= hi ? 38 : 42);
    for (const pitch of notes) hits.push({ time, pitch, vel: pitch === 42 ? Math.round(vel * 0.85) : vel, f: c.f, lo, mi, hi });
  }
  // long-ringing hi-hat-type hits → open hat or crash
  for (const hit of hits) {
    if (hit.pitch !== 42) continue;
    const after = mean(eHigh, hit.f + 36, hit.f + 44); // ~200 ms later
    const at = mean(eHigh, hit.f, hit.f + 4) || 1e-12;
    if (after / at > 0.3) hit.pitch = 46;
  }
  return hits;
}
