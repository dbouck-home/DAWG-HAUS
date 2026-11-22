// Instrument presets. The preset `name` is what tracks label themselves with.
// kind 'synth' = built-in synthesizer; kind 'sample' = recorded samples in /samples.

export const CATEGORY_COLORS = {
  Piano: '#4f8cff',
  Keys: '#5aa0ff',
  Synth: '#b36bff',
  Pad: '#3fc1c9',
  Lead: '#7ddc4f',
  Bass: '#ff5d73',
  Brass: '#ffb020',
  Woodwinds: '#e3c84a',
  Strings: '#ff8a4c',
  'Guitar & Plucked': '#3ddc97',
  Mallets: '#ff7ad9',
  Audio: '#e8e8e8',
  Drums: '#ff4fa3',
};

const S = (id, name, category, sample, opts = {}) => ({
  id, name, category, kind: 'sample', sample,
  transpose: 0, attack: 0.003, release: 0.4, cutoff: 18000, q: 0.7, gain: 0.9,
  ...opts,
});

export const PRESETS = [
  // ---- sampled ----
  S('grand-piano', 'Grand Piano', 'Piano', 'grand-piano', { release: 0.6, gain: 1.0 }),
  S('organ', 'Organ', 'Keys', 'organ', { release: 0.12, attack: 0.01, gain: 0.6 }),
  S('harmonium', 'Harmonium', 'Keys', 'harmonium', { release: 0.2, attack: 0.03, gain: 0.7 }),
  S('flute', 'Flute', 'Woodwinds', 'flute', { attack: 0.02, release: 0.25 }),
  S('clarinet', 'Clarinet', 'Woodwinds', 'clarinet', { attack: 0.015, release: 0.25 }),
  S('bass-clarinet', 'Bass Clarinet', 'Woodwinds', 'clarinet', { transpose: -12, attack: 0.02, release: 0.3, cutoff: 3200, gain: 1.0 }),
  S('bassoon', 'Bassoon', 'Woodwinds', 'bassoon', { attack: 0.015, release: 0.25 }),
  S('saxophone', 'Saxophone', 'Woodwinds', 'saxophone', { attack: 0.01, release: 0.25 }),
  S('trumpet', 'Trumpet', 'Brass', 'trumpet', { attack: 0.01, release: 0.25 }),
  S('trombone', 'Trombone', 'Brass', 'trombone', { attack: 0.015, release: 0.3 }),
  S('french-horn', 'French Horn', 'Brass', 'french-horn', { attack: 0.03, release: 0.4 }),
  S('tuba', 'Tuba', 'Brass', 'tuba', { attack: 0.02, release: 0.3, gain: 1.0 }),
  S('violin', 'Violin', 'Strings', 'violin', { attack: 0.04, release: 0.4 }),
  S('cello', 'Cello', 'Strings', 'cello', { attack: 0.04, release: 0.45 }),
  S('contrabass', 'Double Bass', 'Strings', 'contrabass', { attack: 0.03, release: 0.4, gain: 1.0 }),
  S('harp', 'Harp', 'Guitar & Plucked', 'harp', { release: 0.9 }),
  S('guitar-acoustic', 'Acoustic Guitar', 'Guitar & Plucked', 'guitar-acoustic', { release: 0.5 }),
  S('guitar-nylon', 'Nylon Guitar', 'Guitar & Plucked', 'guitar-nylon', { release: 0.5 }),
  S('guitar-electric', 'Electric Guitar', 'Guitar & Plucked', 'guitar-electric', { release: 0.4 }),
  S('bass-electric', 'Electric Bass', 'Bass', 'bass-electric', { release: 0.2, gain: 1.0 }),
  S('xylophone', 'Xylophone', 'Mallets', 'xylophone', { release: 0.6 }),

  // ---- synthesizers ----
  // osc: [{type, detune (cents), octave, gain}]; envelopes: attack, decay, sustain (0..1), release (s)
  {
    id: 'soft-keys', name: 'Soft Keys', category: 'Keys', kind: 'synth',
    mono: false,
    osc: [
      { type: 'sine', detune: 0, octave: 0, gain: 0.7 },
      { type: 'triangle', detune: 3, octave: 1, gain: 0.18 },
    ],
    filter: { type: 'lowpass', cutoff: 5000, q: 0.5, envAmount: 0 },
    amp: { attack: 0.004, decay: 1.4, sustain: 0.15, release: 0.35 },
    filterEnv: { attack: 0.01, decay: 0.3, sustain: 1, release: 0.3 },
    gain: 0.5,
  },
  {
    id: 'analog-mono', name: 'Analog Mono Synth', category: 'Synth', kind: 'synth',
    mono: true, glide: 0.06,
    osc: [
      { type: 'sawtooth', detune: -6, octave: 0, gain: 0.5 },
      { type: 'square', detune: 6, octave: 0, gain: 0.35 },
      { type: 'square', detune: 0, octave: -1, gain: 0.25 },
    ],
    filter: { type: 'lowpass', cutoff: 700, q: 7, envAmount: 2600 },
    amp: { attack: 0.005, decay: 0.25, sustain: 0.75, release: 0.15 },
    filterEnv: { attack: 0.005, decay: 0.35, sustain: 0.25, release: 0.2 },
    gain: 0.35,
  },
  {
    id: 'string-pad', name: 'Synth String Pad', category: 'Pad', kind: 'synth',
    mono: false,
    osc: [
      { type: 'sawtooth', detune: -12, octave: 0, gain: 0.3 },
      { type: 'sawtooth', detune: 0, octave: 0, gain: 0.3 },
      { type: 'sawtooth', detune: 12, octave: 0, gain: 0.3 },
    ],
    filter: { type: 'lowpass', cutoff: 2200, q: 0.7, envAmount: 600 },
    amp: { attack: 0.6, decay: 0.5, sustain: 0.85, release: 1.3 },
    filterEnv: { attack: 0.8, decay: 1, sustain: 0.6, release: 1.2 },
    gain: 0.28,
  },
  {
    id: 'brass-hit', name: 'Brass Synth Hit', category: 'Brass', kind: 'synth',
    mono: false,
    osc: [
      { type: 'sawtooth', detune: -5, octave: 0, gain: 0.45 },
      { type: 'sawtooth', detune: 5, octave: 0, gain: 0.45 },
    ],
    filter: { type: 'lowpass', cutoff: 600, q: 2, envAmount: 4200 },
    amp: { attack: 0.012, decay: 0.35, sustain: 0.55, release: 0.25 },
    filterEnv: { attack: 0.03, decay: 0.28, sustain: 0.3, release: 0.25 },
    gain: 0.35,
  },
  {
    id: 'sub-bass', name: 'Sub Bass', category: 'Bass', kind: 'synth',
    mono: true, glide: 0.03,
    osc: [
      { type: 'sine', detune: 0, octave: 0, gain: 0.8 },
      { type: 'triangle', detune: 0, octave: 1, gain: 0.15 },
    ],
    filter: { type: 'lowpass', cutoff: 900, q: 0.5, envAmount: 0 },
    amp: { attack: 0.005, decay: 0.2, sustain: 0.9, release: 0.12 },
    filterEnv: { attack: 0.01, decay: 0.2, sustain: 1, release: 0.1 },
    gain: 0.6,
  },
  {
    id: 'square-lead', name: 'Square Lead', category: 'Lead', kind: 'synth',
    mono: false,
    osc: [
      { type: 'square', detune: 0, octave: 0, gain: 0.4 },
      { type: 'square', detune: 8, octave: 0, gain: 0.25 },
    ],
    filter: { type: 'lowpass', cutoff: 2400, q: 3, envAmount: 1500 },
    amp: { attack: 0.005, decay: 0.15, sustain: 0.7, release: 0.18 },
    filterEnv: { attack: 0.005, decay: 0.2, sustain: 0.5, release: 0.2 },
    gain: 0.3,
  },
];

export function getPreset(id) {
  return PRESETS.find((p) => p.id === id) || PRESETS[0];
}

export const TRACK_COLORS = [
  '#7bafd4', '#4f8cff', '#3fc1c9', '#3ddc97', '#7ddc4f', '#e3c84a', '#ffb020', '#ff8a4c',
  '#ff5d73', '#ff4fa3', '#ff7ad9', '#b36bff', '#8c7bff', '#9aa3b2', '#e8e8e8', '#c49a6c',
];

export function colorForTrack(track) {
  if (track.color) return track.color;
  if (track.type === 'audio') return CATEGORY_COLORS.Audio;
  if (track.type === 'drums') return CATEGORY_COLORS.Drums;
  return CATEGORY_COLORS[getPreset(track.instrument?.preset).category] || '#888';
}

// ---------- adjustable parameters ----------
// Each parameter reads its default from the preset and is saved per track in track.instrument.params.

const SYNTH_PARAMS = [
  { key: 'volume', label: 'Gain', min: -24, max: 12, step: 0.5, unit: 'dB', get: () => 0 },
  { key: 'cutoff', label: 'Brightness', min: 100, max: 18000, step: 1, unit: 'Hz', log: true, get: (p) => p.filter.cutoff },
  { key: 'q', label: 'Resonance', min: 0.1, max: 20, step: 0.1, get: (p) => p.filter.q },
  { key: 'envAmount', label: 'Filter sweep', min: 0, max: 8000, step: 10, unit: 'Hz', get: (p) => p.filter.envAmount },
  { key: 'attack', label: 'Attack', min: 0.001, max: 3, step: 0.001, unit: 's', log: true, get: (p) => p.amp.attack },
  { key: 'decay', label: 'Decay', min: 0.01, max: 4, step: 0.01, unit: 's', log: true, get: (p) => p.amp.decay },
  { key: 'sustain', label: 'Sustain', min: 0, max: 1, step: 0.01, get: (p) => p.amp.sustain },
  { key: 'release', label: 'Release', min: 0.01, max: 5, step: 0.01, unit: 's', log: true, get: (p) => p.amp.release },
  { key: 'detune', label: 'Detune spread', min: 0, max: 50, step: 1, unit: '¢', get: () => 0 },
  { key: 'glide', label: 'Glide', min: 0, max: 1, step: 0.005, unit: 's', get: (p) => p.glide || 0, monoOnly: true },
];

const SAMPLE_PARAMS = [
  { key: 'volume', label: 'Gain', min: -24, max: 12, step: 0.5, unit: 'dB', get: () => 0 },
  { key: 'cutoff', label: 'Brightness', min: 200, max: 18000, step: 1, unit: 'Hz', log: true, get: (p) => p.cutoff },
  { key: 'q', label: 'Resonance', min: 0.1, max: 15, step: 0.1, get: (p) => p.q },
  { key: 'attack', label: 'Attack', min: 0.001, max: 3, step: 0.001, unit: 's', log: true, get: (p) => p.attack },
  { key: 'release', label: 'Release', min: 0.01, max: 5, step: 0.01, unit: 's', log: true, get: (p) => p.release },
  { key: 'tune', label: 'Transpose', min: -24, max: 24, step: 1, unit: 'st', get: () => 0 },
  { key: 'velSens', label: 'Velocity response', min: 0, max: 1, step: 0.01, get: () => 0.8 },
];

export function paramDefs(preset) {
  const list = preset.kind === 'sample' ? SAMPLE_PARAMS : SYNTH_PARAMS;
  return list.filter((d) => !d.monoOnly || preset.mono);
}

export function paramValue(preset, params, key) {
  const def = paramDefs(preset).find((d) => d.key === key);
  if (!def) return undefined;
  const v = params?.[key];
  return v == null ? def.get(preset) : v;
}

/** Preset with the track's parameter changes applied. */
export function effectivePreset(track) {
  const base = getPreset(track.instrument?.preset);
  const pr = JSON.parse(JSON.stringify(base));
  const v = (k) => paramValue(base, track.instrument?.params, k);
  const gainMul = Math.pow(10, v('volume') / 20);
  if (pr.kind === 'sample') {
    pr.cutoff = v('cutoff'); pr.q = v('q'); pr.attack = v('attack'); pr.release = v('release');
    pr.tune = v('tune'); pr.velSens = v('velSens'); pr.gain *= gainMul;
  } else {
    pr.filter.cutoff = v('cutoff'); pr.filter.q = v('q'); pr.filter.envAmount = v('envAmount');
    pr.amp.attack = v('attack'); pr.amp.decay = v('decay'); pr.amp.sustain = v('sustain'); pr.amp.release = v('release');
    if (pr.mono) pr.glide = v('glide');
    const spread = v('detune');
    if (spread) pr.osc = pr.osc.map((o, i) => ({ ...o, detune: (o.detune || 0) + (i - (pr.osc.length - 1) / 2) * spread }));
    pr.gain *= gainMul;
  }
  return pr;
}
