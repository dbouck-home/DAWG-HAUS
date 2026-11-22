// Project data model and helpers.
import { PPQ } from './timing.js';
import { getPreset } from './audio/presets.js';
import { getKit, PATTERNS } from './audio/drums.js';

export const PROJECT_VERSION = 1;

export function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}

export function baseLabel(track) {
  if (track.type === 'audio') return 'Audio';
  if (track.type === 'drums') return getKit(track.drums?.kit).name;
  return getPreset(track.instrument?.preset).name;
}

/**
 * Tracks label themselves after their instrument unless the user renamed them.
 * Duplicates get a number: "Synth String Pad", "Synth String Pad 2", ...
 */
export function applyAutoLabels(project) {
  const counts = {};
  for (const t of project.tracks) {
    if (t.customName) continue;
    const base = baseLabel(t);
    counts[base] = (counts[base] || 0) + 1;
    t.name = counts[base] === 1 ? base : `${base} ${counts[base]}`;
  }
}

export function newTrack(type = 'instrument', preset = 'soft-keys') {
  const t = {
    id: uid('trk'),
    type,
    name: '',
    customName: false,
    volume: 0, // dB
    pan: 0, // -1..1
    mute: false,
    solo: false,
    clips: [],
    fx: [],
    automation: [],
    showAuto: false,
  };
  if (type === 'instrument') t.instrument = { preset, params: {} };
  if (type === 'drums') t.drums = { kit: preset || '808', pads: {} };
  return t;
}

export function newClip(start, length, notes = []) {
  return { id: uid('clp'), start, length, notes };
}

export function newProject(name = 'Untitled Song') {
  const now = Date.now();
  const p = {
    version: PROJECT_VERSION,
    id: uid('prj'),
    name,
    created: now,
    modified: now,
    tempos: [{ tick: 0, bpm: 120 }],
    meters: [{ bar: 0, num: 4, den: 4, group: '' }],
    loop: { enabled: false, start: 0, end: PPQ * 4 * 4 },
    metronome: { enabled: false, volume: 0.6 },
    countIn: 0, // bars of count-in before recording
    masterVolume: 0,
    lengthBars: 64,
    tracks: [],
    masterFx: [],
  };
  return p;
}

/** A small demo song so there is something to hear on first launch. */
export function demoProject() {
  const p = newProject('Welcome to the DAWG HAUS');
  const q = PPQ;
  const pad = newTrack('instrument', 'string-pad');
  const bass = newTrack('instrument', 'sub-bass');
  const keys = newTrack('instrument', 'grand-piano');

  // Am - F - C - G, one bar each, repeated twice
  const chords = [
    [57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62],
  ];
  const roots = [45, 41, 48, 43];
  const padNotes = [];
  const bassNotes = [];
  const keyNotes = [];
  for (let rep = 0; rep < 2; rep++) {
    chords.forEach((ch, i) => {
      const bar = rep * 4 + i;
      ch.forEach((pitch) => padNotes.push({ t: bar * 4 * q, d: 4 * q - 30, p: pitch, v: 80 }));
      for (let b = 0; b < 4; b++) {
        bassNotes.push({ t: bar * 4 * q + b * q, d: q * 0.8, p: roots[i] - 12 + (b === 3 ? 12 : 0), v: 100 });
      }
      [0, 1, 2, 1, 0, 2, 1, 2].forEach((ci, k) => {
        keyNotes.push({ t: bar * 4 * q + k * (q / 2), d: q / 2 - 20, p: ch[ci] + 12, v: 70 + (k % 2 ? 0 : 20) });
      });
    });
  }
  pad.clips.push(newClip(0, 8 * 4 * q, padNotes));
  bass.clips.push(newClip(0, 8 * 4 * q, bassNotes));
  keys.clips.push(newClip(4 * 4 * q, 4 * 4 * q, keyNotes.filter((n) => n.t >= 4 * 4 * q).map((n) => ({ ...n, t: n.t - 4 * 4 * q }))));
  const drums = newTrack('drums', 'boombap');
  const beat = PATTERNS.find((x) => x.name === 'Boom Bap');
  const hits = [];
  for (let bar = 0; bar < 8; bar++) {
    for (const [note, str] of Object.entries(beat.rows)) {
      [...str].forEach((ch, i) => { if (ch !== '-') hits.push({ t: bar * 4 * q + i * (q / 4), d: q / 4, p: +note, v: ch === 'X' ? 127 : 96 }); });
    }
  }
  drums.clips.push(newClip(0, 8 * 4 * q, hits));
  p.tracks.push(drums, pad, bass, keys);
  p.loop = { enabled: false, start: 0, end: 8 * 4 * q };
  applyAutoLabels(p);
  return p;
}

/** Bring older/imported project files up to the current shape. */
export function migrateProject(p) {
  const d = newProject(p?.name || 'Imported Song');
  const out = { ...d, ...p };
  out.version = PROJECT_VERSION;
  out.loop = { ...d.loop, ...(p.loop || {}) };
  out.metronome = { ...d.metronome, ...(p.metronome || {}) };
  out.tracks = (p.tracks || []).map((t) => ({ ...newTrack(t.type, t.instrument?.preset || t.drums?.kit), ...t }));
  if (!out.id) out.id = uid('prj');
  applyAutoLabels(out);
  return out;
}

// ---------- repeating clips ----------
// A clip may repeat its pattern: clip.loop = pattern length (ticks). The clip's length can then be
// longer than the pattern, and the notes play again every `loop` ticks.

/** Length of the clip's own pattern (what the editors show). */
export function patternLength(clip) {
  return clip.loop && clip.loop > 0 ? clip.loop : clip.length;
}

/** How many times the pattern plays (may be fractional when the last repeat is cut short). */
export function repeatCount(clip) {
  return clip.length / patternLength(clip);
}

/** Every note the clip plays, with repeats written out (times relative to the clip start). */
export function expandNotes(clip) {
  const L = patternLength(clip);
  if (!clip.loop || clip.length <= L) return clip.notes.map((n) => ({ ...n }));
  const out = [];
  for (let base = 0; base < clip.length; base += L) {
    for (const n of clip.notes) {
      if (n.t >= L) continue;
      const t = base + n.t;
      if (t >= clip.length) continue;
      out.push({ ...n, id: undefined, t, d: Math.min(n.d, L - n.t, clip.length - t) });
    }
  }
  return out;
}

/**
 * Split a clip at song tick `at`. Returns [left, right] (new objects) or null if `at` isn't inside it.
 * Repeats are written out so both halves sound exactly like before.
 */
export function splitClip(clip, at) {
  const rel = Math.round(at - clip.start);
  if (rel <= 0 || rel >= clip.length) return null;
  const notes = expandNotes(clip);
  const base = { ...clip };
  delete base.loop;
  const left = { ...base, id: uid('clp'), length: rel, notes: [] };
  const right = { ...base, id: uid('clp'), start: clip.start + rel, length: clip.length - rel, notes: [] };
  for (const n of notes) {
    if (n.t < rel) left.notes.push({ ...n, d: Math.min(n.d, rel - n.t) });
    else right.notes.push({ ...n, t: n.t - rel });
  }
  return [left, right];
}
