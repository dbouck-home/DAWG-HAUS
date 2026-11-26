// Automation lanes in the arrangement: drawing and editing breakpoints.
// Click empty space to add a point, drag points to move them, double-click a point to type its value
// (e.g. an exact BPM), right-click a point for a menu (type value / delete).
// Hold Alt while dragging to ignore the snap grid.
import { targetInfo, valueAt, toNorm, fromNorm, formatValue, TEMPO_TARGET, TUNING_TARGET } from '../automation.js';
import { fxParamDef } from '../audio/effects.js';
import { colorForTrack } from '../audio/presets.js';
import { promptText, popupMenu, toast } from './dom.js';

export const AUTO_H = 60;

/** Read a lane: { info, points [{t,v}], staticValue, color } */
export function laneData(project, trackId, laneId) {
  if (laneId === 'tempo') {
    return {
      info: TEMPO_TARGET,
      points: project.tempos.map((x) => ({ t: x.tick, v: x.bpm })),
      staticValue: project.tempos[0]?.bpm ?? 120,
      color: '#b5d6ec',
      isTempo: true,
    };
  }
  if (laneId === 'tuning') {
    return {
      info: TUNING_TARGET,
      points: project.tuning?.points || [],
      staticValue: project.tuning?.a4 || 440,
      color: '#c9a7ff',
    };
  }
  const t = project.tracks.find((x) => x.id === trackId);
  const lane = t?.automation?.find((a) => a.id === laneId);
  if (!lane) return null;
  const info = targetInfo(t, lane.target);
  if (!info) return null;
  let staticValue = info.def;
  if (lane.target === 'volume') staticValue = t.volume;
  else if (lane.target === 'pan') staticValue = t.pan || 0;
  else if (lane.target.startsWith('fx:')) {
    const [, id, key] = lane.target.split(':');
    const fx = t.fx?.find((f) => f.id === id);
    staticValue = fx?.params?.[key] ?? fxParamDef(fx?.type, key)?.def ?? info.def;
  }
  return { info, points: lane.points, staticValue, color: colorForTrack(t) };
}

/** Write a lane's points back into the project (inside store.mutate). */
export function setLanePoints(project, trackId, laneId, points) {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  if (laneId === 'tempo') {
    if (!sorted.length) sorted.push({ t: 0, v: project.tempos[0]?.bpm ?? 120 });
    project.tempos = sorted.map((p) => ({ tick: Math.round(p.t), bpm: Math.round(p.v * 10) / 10 }));
    return;
  }
  if (laneId === 'tuning') {
    project.tuning = { a4: project.tuning?.a4 || 440, ...(project.tuning || {}), points: sorted.map((p) => ({ t: Math.round(p.t), v: Math.round(p.v * 10) / 10 })) };
    return;
  }
  const t = project.tracks.find((x) => x.id === trackId);
  const lane = t?.automation?.find((a) => a.id === laneId);
  if (lane) lane.points = sorted.map((p) => ({ t: Math.round(p.t), v: p.v }));
}

export function drawLane(canvas, { data, x0, w, ppt, dpr, playTick }) {
  const H = AUTO_H - 1;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(H * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${H}px`;
  canvas.style.left = `${x0}px`;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, H);
  const { info, points, staticValue, color } = data;
  const yOf = (v) => 6 + (1 - toNorm(info, v)) * (H - 12);
  g.fillStyle = 'rgba(0,0,0,0.25)';
  g.fillRect(0, 0, w, H);
  if (!points.length || (data.isTempo && points.length === 1)) {
    const y = yOf(points.length ? points[0].v : staticValue);
    g.strokeStyle = 'rgba(255,255,255,0.25)';
    g.setLineDash([4, 4]);
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
    g.setLineDash([]);
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.font = '11px system-ui, sans-serif';
    g.fillText(`${formatValue(info, points.length ? points[0].v : staticValue)} — click to add points`, 8, Math.max(14, y - 6));
    if (data.isTempo && points.length === 1) drawPoint(g, points[0].t * ppt - x0, y, color);
    return;
  }
  // line + fill
  g.beginPath();
  g.moveTo(0, yOf(valueAt(points, x0 / ppt)));
  for (const p of points) {
    const x = p.t * ppt - x0;
    if (x < -50 || x > w + 50) continue;
    g.lineTo(x, yOf(p.v));
  }
  g.lineTo(w, yOf(valueAt(points, (x0 + w) / ppt)));
  g.strokeStyle = color;
  g.lineWidth = 2;
  g.stroke();
  g.lineTo(w, H); g.lineTo(0, H); g.closePath();
  g.globalAlpha = 0.15; g.fillStyle = color; g.fill(); g.globalAlpha = 1;
  for (const p of points) {
    const x = p.t * ppt - x0;
    if (x < -8 || x > w + 8) continue;
    drawPoint(g, x, yOf(p.v), color);
  }
  if (playTick != null) {
    g.fillStyle = 'rgba(255,255,255,0.8)';
    g.font = '10px system-ui, sans-serif';
    g.fillText(formatValue(info, valueAt(points, playTick)), w - 70, 12);
  }
}

function drawPoint(g, x, y, color) {
  g.beginPath();
  g.arc(x, y, 4.5, 0, Math.PI * 2);
  g.fillStyle = '#fff';
  g.fill();
  g.lineWidth = 2;
  g.strokeStyle = color;
  g.stroke();
}

/**
 * Pointer editing for a lane row. timeline gives tick<->x conversion and snapping.
 */
// rows are rebuilt after every edit, so double-clicks are detected here rather than with 'dblclick'
let lastDown = { time: 0, lane: null, t: null };

export function bindLaneRow(row, { store, timeline }) {
  const ctxFor = () => {
    const data = laneData(store.project, row.dataset.track, row.dataset.lane);
    const rect = row.getBoundingClientRect();
    return { data, rect };
  };
  const hitPoint = (data, rect, e) => {
    const ppt = timeline.pxPerTick;
    const H = AUTO_H - 1;
    const yOf = (v) => 6 + (1 - toNorm(data.info, v)) * (H - 12);
    for (let i = 0; i < data.points.length; i++) {
      const p = data.points[i];
      const x = p.t * ppt + rect.left;
      const y = yOf(p.v) + rect.top;
      if (Math.abs(e.clientX - x) <= 7 && Math.abs(e.clientY - y) <= 7) return i;
    }
    return -1;
  };
  const valueFromY = (data, rect, clientY) => {
    const H = AUTO_H - 1;
    const n = 1 - (clientY - rect.top - 6) / (H - 12);
    let v = fromNorm(data.info, n);
    if (data.info.key === 'pan' && Math.abs(v) < 0.04) v = 0;
    if (data.info.unit === 'dB' && Math.abs(v) < 0.4) v = 0;
    return v;
  };
  const commit = (points) => store.mutate((p) => setLanePoints(p, row.dataset.track, row.dataset.lane, points));

  // typed values: percentages and pan are entered as -100..100, everything else in its own unit
  const pct = (info) => info.key === 'pan' || (info.max <= 1 && info.min >= 0 && !info.unit);
  const editValue = async (data, i) => {
    const info = data.info;
    const cur = data.points[i].v;
    const shown = pct(info) ? Math.round(cur * 100) : Math.round(cur * 100) / 100;
    const unit = info.unit || (pct(info) ? (info.key === 'pan' ? 'L −100 … R 100' : '%') : '');
    const txt = await promptText(info.key === 'tempo' ? 'Tempo at this point' : info.key === 'tuning' ? 'Tuning at this point (A4 in Hz)' : `${info.label} at this point`, String(shown), unit || 'Value');
    if (txt == null) return;
    let v = parseFloat(String(txt).replace(',', '.'));
    if (!Number.isFinite(v)) { toast('Please type a number.'); return; }
    if (pct(info)) v /= 100;
    const lo = info.min, hi = info.max;
    if (v < lo || v > hi) toast(`Kept within ${formatValue(info, lo)} – ${formatValue(info, hi)}.`);
    v = Math.min(hi, Math.max(lo, v));
    commit(data.points.map((p, j) => (j === i ? { ...p, v } : p)));
  };

  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const { data, rect } = ctxFor();
    const i = hitPoint(data, rect, e);
    if (i < 0) return;
    popupMenu(e.clientX, e.clientY, [
      { label: data.isTempo ? 'Type BPM…' : 'Type value…', onClick: () => editValue(data, i) },
      { label: 'Delete point', onClick: () => commit(data.points.filter((_, j) => j !== i)) },
    ]);
  });
  // the point a click lands on, counting clicks that snapped onto an existing point's time
  const pointAt = (data, rect, e) => {
    const i = hitPoint(data, rect, e);
    if (i >= 0) return i;
    const t = e.altKey ? null : timeline.meter.snap(timeline.xToTick(e.clientX - rect.left), store.ui.snap);
    return t == null ? -1 : data.points.findIndex((p) => p.t === t);
  };
  row.addEventListener('dblclick', (e) => {
    const { data, rect } = ctxFor();
    const i = pointAt(data, rect, e);
    if (i >= 0) editValue(data, i);
  });
  row.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const { data, rect } = ctxFor();
    if (!data) return;
    let pts = data.points.map((p) => ({ ...p }));
    let idx = pointAt(data, rect, e);
    const now = performance.now();
    const laneKey = `${row.dataset.track}|${row.dataset.lane}`;
    if (idx >= 0 && now - lastDown.time < 450 && lastDown.lane === laneKey && lastDown.t === data.points[idx].t) {
      lastDown = { time: 0, lane: null, t: null };
      editValue(data, idx);
      return;
    }
    const snap = (clientX, alt) => {
      const tick = timeline.xToTick(clientX - rect.left);
      return alt ? Math.max(0, Math.round(tick)) : timeline.meter.snap(tick, store.ui.snap);
    };
    if (idx < 0) {
      // new point
      const t = snap(e.clientX, e.altKey);
      const v = valueFromY(data, rect, e.clientY);
      // the first point of an empty lane starts from the current setting so nothing jumps
      pts.push({ t, v });
      pts.sort((a, b) => a.t - b.t);
      idx = pts.findIndex((p) => p.t === t && p.v === v);
    }
    const moving = pts[idx];
    row.setPointerCapture(e.pointerId);
    const draw = () => { timeline.previewLane(row, { ...data, points: [...pts].sort((a, b) => a.t - b.t) }); };
    draw();
    const move = (ev) => {
      moving.t = snap(ev.clientX, ev.altKey);
      moving.v = valueFromY(data, rect, ev.clientY);
      draw();
    };
    const up = () => {
      row.removeEventListener('pointermove', move);
      row.removeEventListener('pointerup', up);
      lastDown = { time: performance.now(), lane: laneKey, t: moving.t };
      commit(pts);
    };
    row.addEventListener('pointermove', move);
    row.addEventListener('pointerup', up);
  });
}
