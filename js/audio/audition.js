// Audition: play a short phrase on an instrument or kit before adding it (▶ buttons).
import { Synth } from './synth.js';
import { Sampler, loadSampleSet } from './sampler.js';
import { DrumKit, getKit } from './drums.js';
import { getPreset } from './presets.js';

let current = null; // { inst, out, timer }

export function stopAudition() {
  if (!current) return;
  const { inst, out, timer } = current;
  clearTimeout(timer);
  try { inst.allNotesOff?.(); } catch { /* ignore */ }
  const ctx = out.context;
  out.gain.setTargetAtTime(0, ctx.currentTime, 0.03);
  setTimeout(() => { try { out.disconnect(); inst.dispose?.(); } catch { /* ignore */ } }, 400);
  current = null;
}

async function sampleRange(ctx, set) {
  try {
    const m = await loadSampleSet(ctx, set);
    const keys = [...m.keys()];
    return [Math.min(...keys), Math.max(...keys)];
  } catch { return null; }
}

/**
 * @param engine  the app Engine (for its AudioContext and master bus)
 * @param what    { type: 'instrument', preset } | { type: 'drums', kit }
 * @returns       seconds the phrase lasts
 */
export async function audition(engine, what) {
  engine.ensureContext();
  stopAudition();
  const ctx = engine.ctx;
  const out = ctx.createGain();
  out.gain.value = 0.9;
  out.connect(engine.master);
  const token = {};
  current = { inst: null, out, timer: 0, token };

  if (what.type === 'drums') {
    const track = { drums: { kit: what.kit, pads: {} } };
    const inst = new DrumKit(ctx, track, out);
    current.inst = inst;
    if (inst.loading) await inst.loading.catch(() => null);
    if (current?.token !== token) return 0;
    return playBeat(ctx, inst, getKit(what.kit), token);
  }

  const pr = getPreset(what.preset);
  const inst = pr.kind === 'sample' ? new Sampler(ctx, pr, out) : new Synth(ctx, pr, out);
  current.inst = inst;
  let root = 60;
  if (pr.kind === 'sample') {
    await inst.loading.catch(() => null);
    if (current?.token !== token) return 0;
    const r = await sampleRange(ctx, pr.sample);
    if (r) {
      const mid = (r[0] + r[1]) / 2 + (pr.transpose || 0);
      root = Math.round((mid - 6) / 12) * 12; // a C a little below the middle of the range
    }
  } else if (pr.category === 'Bass') root = 36;
  else if (pr.category === 'Lead') root = 72;
  return playPhrase(ctx, inst, root, !!pr.mono, token);
}

function playPhrase(ctx, inst, root, mono, token) {
  const t0 = ctx.currentTime + 0.05;
  const step = 0.2;
  const melody = [0, 4, 7, 12, 7, 4];
  melody.forEach((iv, i) => {
    inst.noteOn(root + iv, 96, t0 + i * step);
    inst.noteOff(root + iv, t0 + i * step + step * 0.9);
  });
  let end = t0 + melody.length * step;
  if (mono) {
    inst.noteOn(root, 100, end); inst.noteOff(root, end + 0.8); end += 0.8;
  } else {
    for (const iv of [0, 4, 7, 12]) { inst.noteOn(root + iv, 88, end); inst.noteOff(root + iv, end + 1.1); }
    end += 1.1;
  }
  return finish(ctx, end + 1.2, token);
}

function playBeat(ctx, kit, kitDef, token) {
  const has = (n) => kitDef.pads.some((p) => p.note === n);
  const pick = (...ns) => ns.find(has);
  const bpm = 100;
  const sx = 60 / bpm / 4; // 16th note
  const t0 = ctx.currentTime + 0.05;
  const kick = pick(36, 35, 64, 41);
  const snare = pick(38, 40, 39, 37, 62, 63);
  const hat = pick(42, 44, 70, 82, 54, 75);
  const open = pick(46);
  const rows = [
    [kick, 'x-----x-x-------x-----x-x-------'],
    [snare, '----x-------x-------x-------x---'],
    [hat, 'x-x-x-x-x-x-x-x-x-x-x-x-x-x-x---'],
    [open, '------------------------------x-'],
  ];
  for (const [note, pat] of rows) {
    if (note == null) continue;
    [...pat].forEach((c, i) => { if (c === 'x') kit.noteOn(note, i % 4 === 0 ? 112 : 90, t0 + i * sx); });
  }
  // latin kit: no kick/snare — let its pads take turns
  if (kick == null && snare == null) {
    kitDef.pads.forEach((p, i) => kit.noteOn(p.note, 100, t0 + i * sx * 2));
  }
  return finish(ctx, t0 + 32 * sx + 1.0, token);
}

function finish(ctx, endTime, token) {
  const secs = endTime - ctx.currentTime;
  if (current?.token === token) current.timer = setTimeout(() => { if (current?.token === token) stopAudition(); }, secs * 1000);
  return secs;
}

export function isAuditioning() { return !!current; }
