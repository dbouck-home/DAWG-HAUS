// Timing math for benDAWmin.
// All musical positions are stored in ticks. PPQ = ticks per quarter note.
// Meters (time signatures) are stored by bar index; tempo changes by tick.

export const PPQ = 960;
export const VALID_DENOMINATORS = [1, 2, 4, 8, 16, 32, 64];

/** Ticks in one beat unit of a meter (a 1/den note). */
export function beatTicks(den) {
  return (PPQ * 4) / den;
}

/** Ticks in one bar of a meter. */
export function barTicksOf(meter) {
  return meter.num * beatTicks(meter.den);
}

/**
 * Parse a beat grouping like "4+4+4+5" for 17/16.
 * Returns an array of group sizes, or null if the grouping is empty/invalid.
 */
export function parseGrouping(str, num) {
  if (!str) return null;
  const parts = String(str).split('+').map((s) => parseInt(s.trim(), 10));
  if (parts.some((n) => !Number.isFinite(n) || n <= 0)) return null;
  const sum = parts.reduce((a, b) => a + b, 0);
  if (sum !== num) return null;
  return parts;
}

/** Sorted copy of meter changes; guarantees one at bar 0. */
export function normalizeMeters(meters) {
  const list = [...(meters || [])]
    .filter((m) => m && Number.isFinite(m.bar))
    .sort((a, b) => a.bar - b.bar);
  if (!list.length || list[0].bar !== 0) list.unshift({ bar: 0, num: 4, den: 4 });
  // drop duplicates on the same bar (keep last)
  const out = [];
  for (const m of list) {
    if (out.length && out[out.length - 1].bar === m.bar) out[out.length - 1] = m;
    else out.push(m);
  }
  return out;
}

/**
 * MeterMap converts between bar numbers (0-based) and ticks.
 */
export class MeterMap {
  constructor(meters) {
    this.meters = normalizeMeters(meters);
    // precompute start tick of each meter segment
    this.segments = [];
    let tick = 0;
    for (let i = 0; i < this.meters.length; i++) {
      const m = this.meters[i];
      if (i > 0) {
        const prev = this.segments[i - 1];
        tick = prev.startTick + (m.bar - prev.bar) * prev.barTicks;
      }
      this.segments.push({
        ...m,
        startTick: tick,
        barTicks: barTicksOf(m),
        beatTicks: beatTicks(m.den),
        groups: parseGrouping(m.group, m.num),
      });
    }
  }

  segmentForBar(bar) {
    let seg = this.segments[0];
    for (const s of this.segments) {
      if (s.bar <= bar) seg = s;
      else break;
    }
    return seg;
  }

  segmentForTick(tick) {
    let seg = this.segments[0];
    for (const s of this.segments) {
      if (s.startTick <= tick) seg = s;
      else break;
    }
    return seg;
  }

  meterAtBar(bar) {
    return this.segmentForBar(bar);
  }

  barToTick(bar) {
    const s = this.segmentForBar(bar);
    return s.startTick + (bar - s.bar) * s.barTicks;
  }

  /** Fractional bar position of a tick. */
  tickToBar(tick) {
    const s = this.segmentForTick(tick);
    return s.bar + (tick - s.startTick) / s.barTicks;
  }

  /** { bar (0-based), beat (0-based), tickInBeat, meter } */
  tickToBBT(tick) {
    const s = this.segmentForTick(Math.max(0, tick));
    const rel = Math.max(0, tick) - s.startTick;
    const barIn = Math.floor(rel / s.barTicks);
    const inBar = rel - barIn * s.barTicks;
    const beat = Math.floor(inBar / s.beatTicks);
    return { bar: s.bar + barIn, beat, tickInBeat: inBar - beat * s.beatTicks, meter: s };
  }

  /**
   * Snap a tick to a grid. grid: 'off' | 'bar' | 'beat' | number (ticks).
   * mode: 'round' | 'floor'
   */
  snap(tick, grid, mode = 'round') {
    if (grid === 'off' || !grid) return Math.max(0, Math.round(tick));
    const t = Math.max(0, tick);
    const s = this.segmentForTick(t);
    let unit;
    if (grid === 'bar') unit = s.barTicks;
    else if (grid === 'beat') unit = s.beatTicks;
    else unit = grid;
    const rel = t - s.startTick;
    const n = mode === 'floor' ? Math.floor(rel / unit) : Math.round(rel / unit);
    return s.startTick + n * unit;
  }

  /** Snap grid size in ticks at a position (for nudging/resizing). */
  gridTicksAt(tick, grid) {
    const s = this.segmentForTick(tick);
    if (grid === 'bar') return s.barTicks;
    if (grid === 'beat') return s.beatTicks;
    if (grid === 'off' || !grid) return 1;
    return grid;
  }

  /**
   * Iterate the beats (clicks) between two ticks.
   * Yields {tick, accent: 2 (downbeat) | 1 (group start) | 0}.
   */
  *beatsBetween(fromTick, toTick) {
    let { bar } = this.tickToBBT(fromTick);
    for (let guard = 0; guard < 10000; guard++) {
      const s = this.segmentForBar(bar);
      const barStart = this.barToTick(bar);
      if (barStart >= toTick) return;
      // accent positions from grouping
      const groupStarts = new Set([0]);
      if (s.groups) {
        let acc = 0;
        for (const g of s.groups) { groupStarts.add(acc); acc += g; }
      }
      for (let b = 0; b < s.num; b++) {
        const t = barStart + b * s.beatTicks;
        if (t >= toTick) return;
        if (t >= fromTick) {
          const accent = b === 0 ? 2 : groupStarts.has(b) ? 1 : 0;
          yield { tick: t, accent, beat: b, bar };
        }
      }
      bar++;
    }
  }
}

/**
 * TempoMap converts between ticks and seconds. Tempo changes are steps.
 * tempos: [{tick, bpm}] (bpm = quarter notes per minute)
 */
export class TempoMap {
  constructor(tempos) {
    const list = [...(tempos || [])].sort((a, b) => a.tick - b.tick);
    if (!list.length || list[0].tick !== 0) list.unshift({ tick: 0, bpm: 120 });
    this.points = [];
    let sec = 0;
    for (let i = 0; i < list.length; i++) {
      if (i > 0) {
        const p = this.points[i - 1];
        sec = p.sec + ((list[i].tick - p.tick) / PPQ) * (60 / p.bpm);
      }
      this.points.push({ tick: list[i].tick, bpm: list[i].bpm, sec });
    }
  }

  bpmAt(tick) {
    let p = this.points[0];
    for (const q of this.points) { if (q.tick <= tick) p = q; else break; }
    return p.bpm;
  }

  tickToSec(tick) {
    let p = this.points[0];
    for (const q of this.points) { if (q.tick <= tick) p = q; else break; }
    return p.sec + ((tick - p.tick) / PPQ) * (60 / p.bpm);
  }

  secToTick(sec) {
    let p = this.points[0];
    for (const q of this.points) { if (q.sec <= sec) p = q; else break; }
    return p.tick + (sec - p.sec) * (p.bpm / 60) * PPQ;
  }
}

export function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** Snap options shown in the UI. */
export const SNAP_OPTIONS = [
  { label: 'Bar', value: 'bar' },
  { label: 'Beat', value: 'beat' },
  { label: '1/8', value: PPQ / 2 },
  { label: '1/16', value: PPQ / 4 },
  { label: '1/32', value: PPQ / 8 },
  { label: 'Off', value: 'off' },
];
