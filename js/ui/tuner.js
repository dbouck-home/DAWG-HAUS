// Chromatic tuner: listens to the audio input and shows the nearest note, how many cents off, and Hz.
// Uses the song's tuning (A4 = 440 Hz unless changed) as the reference.
import { h, openModal } from './dom.js';
import { noteName } from '../timing.js';

/** YIN pitch detection on one frame; returns Hz or null. */
export function yinHz(buf, sr, minHz = 40, maxHz = 1500, thresh = 0.12) {
  const tauMin = Math.floor(sr / maxHz);
  const tauMax = Math.min(Math.floor(sr / minHz), Math.floor(buf.length / 2));
  const W = buf.length - tauMax;
  if (W < 256) return null;
  let rms = 0;
  for (let i = 0; i < W; i++) rms += buf[i] * buf[i];
  if (Math.sqrt(rms / W) < 0.008) return null; // too quiet
  const d = new Float32Array(tauMax + 1);
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    let s = 0;
    for (let i = 0; i < W; i++) { const x = buf[i] - buf[i + tau]; s += x * x; }
    running += s;
    d[tau] = running ? (s * tau) / running : 1;
  }
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (d[tau] < thresh) {
      while (tau + 1 <= tauMax && d[tau + 1] < d[tau]) tau++;
      let t = tau;
      if (tau > 1 && tau < tauMax) {
        const den = d[tau - 1] - 2 * d[tau] + d[tau + 1];
        if (den) t = tau + 0.5 * (d[tau - 1] - d[tau + 1]) / den;
      }
      return sr / t;
    }
  }
  return null;
}

export async function openTuner({ engine, store }) {
  engine.ensureContext();
  const t = store.selectedTrack();
  const inp = t?.type === 'audio' ? (t.input || {}) : {};
  const status = h('div', { class: 'tuner-status muted' }, 'Turning on the input…');
  const note = h('div', { class: 'tuner-note' }, '—');
  const cents = h('div', { class: 'tuner-cents' }, '');
  const hz = h('div', { class: 'tuner-hz muted' }, '');
  const needle = h('div', { class: 'tuner-needle' });
  const scale = h('div', { class: 'tuner-scale' },
    ...[-50, -25, 0, 25, 50].map((c) => h('span', { style: { left: `${50 + c}%` } }, c === 0 ? '0' : `${c > 0 ? '+' : ''}${c}`)),
    h('div', { class: 'tuner-zone' }), needle);
  const ref = () => store.project.tuning?.a4 || 440;
  const refLabel = h('div', { class: 'muted', style: { textAlign: 'center', marginTop: '8px' } });
  const body = h('div', { class: 'tuner' }, status, note, cents, scale, hz, refLabel);
  let running = true;
  let analyser = null;
  openModal({ title: 'Tuner', body, width: '440px', buttons: [{ label: 'Close', kind: 'primary' }], onClose: () => { running = false; try { engine.input?.gain.disconnect(analyser); } catch { /* ignore */ } } });
  try {
    await engine.openInput(inp.deviceId || '', inp.channel || 'both');
  } catch (e) {
    status.textContent = `The input could not be turned on: ${e.message}`;
    return;
  }
  if (!running) return;
  status.textContent = `Listening to ${engine.input.label}${inp.channel && inp.channel !== 'both' ? ` · input ${inp.channel}` : ''} — play one note at a time.`;
  const ctx = engine.ctx;
  analyser = ctx.createAnalyser();
  analyser.fftSize = 4096;
  engine.input.gain.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  let smooth = null;
  let lastHeard = 0;
  const frame = () => {
    if (!running) return;
    refLabel.textContent = `Reference: A4 = ${ref()} Hz (change it with the A4 button in the transport)`;
    analyser.getFloatTimeDomainData(buf);
    const f = yinHz(buf, ctx.sampleRate);
    const now = performance.now();
    if (f) {
      const m = 69 + 12 * Math.log2(f / ref());
      smooth = smooth == null || Math.abs(m - smooth) > 0.5 ? m : smooth * 0.75 + m * 0.25;
      lastHeard = now;
      const r = Math.round(smooth);
      const c = Math.round((smooth - r) * 100);
      note.textContent = noteName(r);
      cents.textContent = `${c > 0 ? '+' : ''}${c} cents ${Math.abs(c) <= 5 ? '· in tune' : c < 0 ? '· flat ↑' : '· sharp ↓'}`;
      hz.textContent = `${f.toFixed(1)} Hz`;
      needle.style.left = `${50 + Math.max(-50, Math.min(50, c))}%`;
      body.classList.toggle('in-tune', Math.abs(c) <= 5);
    } else if (now - lastHeard > 1200) {
      note.textContent = '—'; cents.textContent = ''; hz.textContent = ''; smooth = null;
      body.classList.remove('in-tune');
    }
    requestAnimationFrame(frame);
  };
  frame();
}
