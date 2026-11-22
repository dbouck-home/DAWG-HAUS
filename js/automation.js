// Automation lanes: which settings can be automated, and how lane values are read.
// A lane is { id, target, points: [{ t (song ticks), v (value in the setting's units) }] }.
import { FX_TYPES, fxParamDef } from './audio/effects.js';

// effect settings that can change smoothly over time (the rest need a restart of the effect)
export const AUTO_KEYS = {
  eq: ['low', 'mid', 'midFreq', 'high'],
  compressor: ['threshold', 'ratio', 'attack', 'release', 'makeup'],
  distortion: ['drive', 'tone', 'mix', 'level'],
  filter: ['cutoff', 'q', 'depth'],
  chorus: ['rate', 'depth', 'mix'],
  phaser: ['rate', 'depth', 'feedback', 'mix'],
  delay: ['feedback', 'tone', 'mix'],
  reverb: ['mix'],
  tremolo: [],
};

export const TEMPO_TARGET = { key: 'tempo', label: 'Tempo', min: 30, max: 240, unit: 'BPM', def: 120 };

/** Every automatable target of a track: [{ key, label, min, max, unit, log, def }] */
export function targetsFor(track) {
  const list = [
    { key: 'volume', label: 'Volume', min: -60, max: 6, unit: 'dB', def: 0 },
    { key: 'pan', label: 'Pan', min: -1, max: 1, unit: '', def: 0 },
  ];
  (track.fx || []).forEach((fx, i) => {
    const name = `${FX_TYPES[fx.type]?.name || fx.type}${countBefore(track.fx, i) ? ` ${countBefore(track.fx, i) + 1}` : ''}`;
    for (const k of AUTO_KEYS[fx.type] || []) {
      const d = fxParamDef(fx.type, k);
      if (d) list.push({ key: `fx:${fx.id}:${k}`, label: `${name} · ${d.label}`, min: d.min, max: d.max, unit: d.unit || '', log: d.log, def: d.def });
    }
  });
  return list;
}

function countBefore(list, i) {
  return list.slice(0, i).filter((f) => f.type === list[i].type).length;
}

export function targetInfo(track, key) {
  if (key === 'tempo') return TEMPO_TARGET;
  return targetsFor(track).find((t) => t.key === key) || null;
}

/** Value of a lane at a tick (linear between points; flat before the first and after the last). */
export function valueAt(points, tick, fallback) {
  if (!points?.length) return fallback;
  if (tick <= points[0].t) return points[0].v;
  for (let i = 1; i < points.length; i++) {
    const b = points[i];
    if (tick <= b.t) {
      const a = points[i - 1];
      return b.t === a.t ? b.v : a.v + ((b.v - a.v) * (tick - a.t)) / (b.t - a.t);
    }
  }
  return points[points.length - 1].v;
}

export function activeLane(track, key) {
  const lane = (track.automation || []).find((l) => l.target === key);
  return lane && lane.points.length ? lane : null;
}

export function formatValue(info, v) {
  if (!info) return String(v);
  if (info.key === 'pan') return Math.abs(v) < 0.01 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`;
  if (info.unit === 'Hz') return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)} Hz`;
  if (info.unit === 'dB') return `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
  if (info.unit === 'BPM') return `${v.toFixed(1)} BPM`;
  if (info.unit === 's') return v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`;
  if (info.max <= 1 && info.min >= 0) return `${Math.round(v * 100)}%`;
  return v.toFixed(2);
}

// value <-> 0..1 position in a lane (log scale for frequencies)
export function toNorm(info, v) {
  if (info.log) return Math.log(v / info.min) / Math.log(info.max / info.min);
  return (v - info.min) / (info.max - info.min);
}
export function fromNorm(info, n) {
  n = Math.max(0, Math.min(1, n));
  if (info.log) return info.min * Math.pow(info.max / info.min, n);
  return info.min + n * (info.max - info.min);
}
