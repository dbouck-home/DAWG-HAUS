// Instrument presets. The preset `name` is what tracks label themselves with.
// Phase 1 ships synthesized instruments; sampled instruments arrive in Phase 2.

export const CATEGORY_COLORS = {
  Keys: '#4f8cff',
  Synth: '#b36bff',
  Pad: '#3fc1c9',
  Brass: '#ffb020',
  Bass: '#ff5d73',
  Lead: '#7ddc4f',
  Audio: '#e8e8e8',
};

// osc: [{type, detune (cents), octave, gain}]
// amp / filt env: attack, decay, sustain (0..1), release (seconds)
export const PRESETS = [
  {
    id: 'soft-keys', name: 'Soft Keys', category: 'Keys',
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
    id: 'analog-mono', name: 'Analog Mono Synth', category: 'Synth',
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
    id: 'string-pad', name: 'Synth String Pad', category: 'Pad',
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
    id: 'brass-hit', name: 'Brass Synth Hit', category: 'Brass',
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
    id: 'sub-bass', name: 'Sub Bass', category: 'Bass',
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
    id: 'square-lead', name: 'Square Lead', category: 'Lead',
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

export function colorForTrack(track) {
  if (track.type === 'audio') return CATEGORY_COLORS.Audio;
  return CATEGORY_COLORS[getPreset(track.instrument?.preset).category] || '#888';
}
