// Arrangement timeline: ruler, grid, lanes, clips, playhead and editing.
import { PPQ, MeterMap } from '../timing.js';
import { colorForTrack } from '../audio/presets.js';
import { newClip } from '../project.js';
import { h } from './dom.js';

const LOOP_STRIP = 15;

export class Timeline {
  constructor({ store, engine, onEditMeter, onOpenClip }) {
    this.store = store;
    this.engine = engine;
    this.onEditMeter = onEditMeter;
    this.onOpenClip = onOpenClip;
    this.arrange = document.getElementById('arrange');
    this.inner = document.getElementById('arrange-inner');
    this.ruler = document.getElementById('ruler');
    this.rulerCanvas = document.getElementById('ruler-canvas');
    this.rulerCap = document.getElementById('ruler-playhead');
    this.lanes = document.getElementById('lanes');
    this.rows = document.getElementById('lane-rows');
    this.gridCanvas = document.getElementById('grid-canvas');
    this.playhead = document.getElementById('playhead');
    this.emptyHint = document.getElementById('empty-hint');
    this.headerW = 250;
    this.laneH = 76;
    this.meterMarkers = [];

    this.arrange.addEventListener('scroll', () => this.drawStatic());
    window.addEventListener('resize', () => this.layout());
    this.arrange.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      this.zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX);
    }, { passive: false });
    this.bindRuler();
    this.bindLanes();
  }

  get pxPerTick() { return this.store.ui.pxPerQuarter / PPQ; }
  get meter() { return new MeterMap(this.store.project.meters); }

  tickToX(t) { return t * this.pxPerTick; }
  xToTick(x) { return x / this.pxPerTick; }

  songEndTick() {
    const p = this.store.project;
    const m = this.meter;
    let end = m.barToTick(p.lengthBars);
    for (const t of p.tracks) for (const c of t.clips) end = Math.max(end, c.start + c.length + m.barToTick(4));
    return end;
  }

  viewport() {
    const w = Math.max(100, this.arrange.clientWidth - this.headerW);
    return { x0: this.arrange.scrollLeft, w };
  }

  zoom(factor) {
    const vp = this.viewport();
    this.zoomAt(factor, this.arrange.getBoundingClientRect().left + this.headerW + vp.w / 2);
  }

  zoomAt(factor, clientX) {
    const rect = this.arrange.getBoundingClientRect();
    const xInView = clientX - rect.left - this.headerW;
    const tickAt = this.xToTick(this.arrange.scrollLeft + xInView);
    const next = Math.min(600, Math.max(6, this.store.ui.pxPerQuarter * factor));
    this.store.ui.pxPerQuarter = next;
    this.layout();
    this.arrange.scrollLeft = Math.max(0, this.tickToX(tickAt) - xInView);
    this.drawStatic();
  }

  /** Full rebuild of lanes + clips. */
  render() {
    this.layout();
    const { project, ui } = this.store;
    this.rows.innerHTML = '';
    this.emptyHint.hidden = project.tracks.length > 0;
    for (const t of project.tracks) {
      const lane = h('div', { class: `lane ${t.id === ui.selectedTrackId ? 'selected' : ''}`, 'data-track': t.id });
      const color = colorForTrack(t);
      for (const c of t.clips) lane.append(this.renderClip(t, c, color));
      this.rows.append(lane);
    }
    this.drawStatic();
  }

  renderClip(track, clip, color) {
    const sel = clip.id === this.store.ui.selectedClipId;
    const x = this.tickToX(clip.start);
    const w = Math.max(6, this.tickToX(clip.length));
    const el = h('div', {
      class: `clip ${sel ? 'selected' : ''}`,
      'data-clip': clip.id,
      style: { left: `${x}px`, width: `${w}px`, background: `linear-gradient(${shade(color, 0.55)}, ${shade(color, 0.35)})` },
    },
    h('div', { class: 'clip-name' }, clip.name || track.name),
    h('div', { class: 'resize', 'data-resize': '1' }));
    if (track.type === 'instrument' && clip.notes.length) el.append(this.miniNotes(clip, w, color));
    return el;
  }

  miniNotes(clip, w, color) {
    const H = this.laneH - 8 - 2 - 16 - 4;
    const cw = Math.min(w, 4000);
    const c = h('canvas', { width: Math.max(1, Math.floor(cw)), height: H, style: { width: `${w}px`, height: `${H}px` } });
    const g = c.getContext('2d');
    let lo = 127; let hi = 0;
    for (const n of clip.notes) { lo = Math.min(lo, n.p); hi = Math.max(hi, n.p); }
    lo -= 1; hi += 1;
    const range = Math.max(8, hi - lo);
    const sx = cw / clip.length;
    g.fillStyle = shade(color, 1.35);
    for (const n of clip.notes) {
      if (n.t >= clip.length) continue;
      const y = H - ((n.p - lo) / range) * H;
      const nh = Math.max(2, H / range - 1);
      g.globalAlpha = 0.45 + 0.55 * (n.v / 127);
      g.fillRect(n.t * sx, y - nh, Math.max(1.5, Math.min(n.d, clip.length - n.t) * sx - 1), nh);
    }
    return c;
  }

  layout() {
    const end = this.songEndTick();
    const width = Math.ceil(this.tickToX(end)) + 300;
    this.contentWidth = width;
    this.inner.style.gridTemplateColumns = `${this.headerW}px ${width}px`;
    const tracks = this.store.project.tracks.length;
    const lanesH = Math.max(tracks * this.laneH, this.arrange.clientHeight - 44);
    this.lanes.style.height = `${lanesH}px`;
    // update clip positions (cheap) without rebuilding
    this.drawStatic();
  }

  /** Grid + ruler, redrawn on scroll/zoom. Both canvases cover only the visible area. */
  drawStatic() {
    const dpr = window.devicePixelRatio || 1;
    const { x0, w } = this.viewport();
    const lanesH = parseFloat(this.lanes.style.height) || 400;
    const p = this.store.project;
    const m = this.meter;
    const ppt = this.pxPerTick;

    // ---- grid ----
    const gc = this.gridCanvas;
    gc.width = Math.floor(w * dpr); gc.height = Math.floor(lanesH * dpr);
    gc.style.width = `${w}px`; gc.style.height = `${lanesH}px`; gc.style.left = `${x0}px`;
    const g = gc.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, lanesH);

    const firstBar = Math.max(0, Math.floor(m.tickToBar(this.xToTick(x0))));
    const lastTick = this.xToTick(x0 + w);
    const snap = this.store.ui.snap;
    for (let bar = firstBar; bar < firstBar + 5000; bar++) {
      const seg = m.meterAtBar(bar);
      const bt = m.barToTick(bar);
      if (bt > lastTick) break;
      const bx = bt * ppt - x0;
      const barW = seg.barTicks * ppt;
      if (bar % 2 === 1) { g.fillStyle = 'rgba(255,255,255,0.018)'; g.fillRect(bx, 0, barW, lanesH); }
      // subdivisions
      const sub = typeof snap === 'number' && snap < seg.beatTicks ? snap : null;
      if (sub && sub * ppt >= 6) {
        g.strokeStyle = 'rgba(255,255,255,0.035)';
        g.beginPath();
        for (let t = sub; t < seg.barTicks; t += sub) {
          if (t % seg.beatTicks === 0) continue;
          const x = Math.round(bx + t * ppt) + 0.5; g.moveTo(x, 0); g.lineTo(x, lanesH);
        }
        g.stroke();
      }
      if (seg.beatTicks * ppt >= 5) {
        const groupStarts = groupStartSet(seg);
        for (let b = 1; b < seg.num; b++) {
          const x = Math.round(bx + b * seg.beatTicks * ppt) + 0.5;
          g.strokeStyle = groupStarts.has(b) ? 'rgba(255,255,255,0.11)' : 'rgba(255,255,255,0.06)';
          g.beginPath(); g.moveTo(x, 0); g.lineTo(x, lanesH); g.stroke();
        }
      }
      g.strokeStyle = 'rgba(255,255,255,0.16)';
      g.beginPath(); g.moveTo(Math.round(bx) + 0.5, 0); g.lineTo(Math.round(bx) + 0.5, lanesH); g.stroke();
    }
    if (p.loop.enabled) {
      g.fillStyle = 'rgba(255,122,47,0.05)';
      g.fillRect(p.loop.start * ppt - x0, 0, (p.loop.end - p.loop.start) * ppt, lanesH);
    }

    // ---- ruler ----
    const rc = this.rulerCanvas;
    const RH = 44;
    rc.width = Math.floor(w * dpr); rc.height = Math.floor(RH * dpr);
    rc.style.width = `${w}px`; rc.style.height = `${RH}px`; rc.style.left = `${x0}px`;
    const r = rc.getContext('2d');
    r.setTransform(dpr, 0, 0, dpr, 0, 0);
    r.clearRect(0, 0, w, RH);
    r.fillStyle = '#14171c';
    r.fillRect(0, 0, w, LOOP_STRIP);
    // loop region
    const lx = p.loop.start * ppt - x0;
    const lw = (p.loop.end - p.loop.start) * ppt;
    r.fillStyle = p.loop.enabled ? 'rgba(255,122,47,0.75)' : 'rgba(140,150,165,0.35)';
    r.fillRect(lx, 2, lw, LOOP_STRIP - 4);

    // bar numbers
    const minLabelPx = 34;
    this.meterMarkers = [];
    r.font = '11px system-ui, sans-serif';
    r.textBaseline = 'middle';
    let lastLabelX = -1e9;
    for (let bar = firstBar; bar < firstBar + 5000; bar++) {
      const seg = m.meterAtBar(bar);
      const bt = m.barToTick(bar);
      if (bt > lastTick) break;
      const bx = bt * ppt - x0;
      r.strokeStyle = '#4a5260';
      r.beginPath(); r.moveTo(Math.round(bx) + 0.5, LOOP_STRIP); r.lineTo(Math.round(bx) + 0.5, RH); r.stroke();
      if (seg.beatTicks * ppt >= 7) {
        r.strokeStyle = '#2f3540';
        r.beginPath();
        for (let b = 1; b < seg.num; b++) {
          const x = Math.round(bx + b * seg.beatTicks * ppt) + 0.5; r.moveTo(x, RH - 6); r.lineTo(x, RH);
        }
        r.stroke();
      }
      if (bx - lastLabelX >= minLabelPx) {
        r.fillStyle = '#c9ced8';
        r.fillText(String(bar + 1), bx + 4, 24);
        lastLabelX = bx;
      }
      const isChange = p.meters.some((mm) => mm.bar === bar);
      if (isChange) {
        const label = `${seg.num}/${seg.den}${seg.groups ? ` (${seg.group})` : ''}`;
        const tw = r.measureText(label).width + 8;
        r.fillStyle = '#3b2a1e';
        r.fillRect(bx + 1, 30, tw, 13);
        r.fillStyle = '#ffb36b';
        r.fillText(label, bx + 5, 37);
        this.meterMarkers.push({ bar, x: bx + x0, w: tw });
      }
    }
    this.updatePlayhead();
  }

  updatePlayhead() {
    const tick = this.engine.currentTick();
    const x = this.tickToX(tick);
    this.playhead.style.left = `${x}px`;
    this.rulerCap.style.left = `${x}px`;
    if (this.engine.playing && this.store.ui.follow !== false) {
      const { x0, w } = this.viewport();
      if (x > x0 + w - 40 || x < x0) this.arrange.scrollLeft = Math.max(0, x - 60);
    }
  }

  updateSelection() {
    const { selectedTrackId, selectedClipId } = this.store.ui;
    this.rows.querySelectorAll('.lane').forEach((l) => l.classList.toggle('selected', l.dataset.track === selectedTrackId));
    this.rows.querySelectorAll('.clip').forEach((c) => c.classList.toggle('selected', c.dataset.clip === selectedClipId));
  }

  // ---------- ruler interaction ----------
  bindRuler() {
    this.ruler.addEventListener('pointerdown', (e) => {
      const rect = this.ruler.getBoundingClientRect();
      const x = e.clientX - rect.left; // ruler element starts at lane x=0
      const y = e.clientY - rect.top;
      const tick = this.xToTick(x);
      const m = this.meter;
      const snap = this.store.ui.snap;
      if (y < LOOP_STRIP) {
        const start = m.snap(tick, snap === 'off' ? 'beat' : snap);
        let endTick = start;
        const origLoop = { ...this.store.project.loop };
        this.ruler.setPointerCapture(e.pointerId);
        const move = (ev) => {
          const t = m.snap(this.xToTick(ev.clientX - rect.left), snap === 'off' ? 'beat' : snap);
          endTick = t;
          const a = Math.min(start, t); const b = Math.max(start, t);
          if (b > a) { this.store.project.loop = { ...this.store.project.loop, start: a, end: b, enabled: true }; this.drawStatic(); }
        };
        const up = () => {
          this.ruler.removeEventListener('pointermove', move);
          this.ruler.removeEventListener('pointerup', up);
          const a = Math.min(start, endTick); const b = Math.max(start, endTick);
          this.store.project.loop = origLoop; // so undo restores the previous loop
          if (b > a) this.store.mutate((p) => { p.loop = { enabled: true, start: a, end: b }; });
          else this.store.emit('project');
        };
        this.ruler.addEventListener('pointermove', move);
        this.ruler.addEventListener('pointerup', up);
        return;
      }
      const marker = this.meterMarkers.find((mk) => x >= mk.x && x <= mk.x + mk.w && y >= 28);
      if (marker) { this.onEditMeter(marker.bar); return; }
      const setPos = (cx) => this.engine.setPosition(m.snap(this.xToTick(cx - rect.left), snap === 'off' ? 'off' : 'beat'));
      setPos(e.clientX);
      this.ruler.setPointerCapture(e.pointerId);
      const move = (ev) => { if (!this.engine.playing) { setPos(ev.clientX); this.updatePlayhead(); } };
      const up = () => { this.ruler.removeEventListener('pointermove', move); this.ruler.removeEventListener('pointerup', up); };
      this.ruler.addEventListener('pointermove', move);
      this.ruler.addEventListener('pointerup', up);
    });
    this.ruler.addEventListener('dblclick', (e) => {
      const rect = this.ruler.getBoundingClientRect();
      if (e.clientY - rect.top < LOOP_STRIP) {
        this.store.mutate((p) => { p.loop.enabled = !p.loop.enabled; });
        return;
      }
      const bar = Math.floor(this.meter.tickToBar(this.xToTick(e.clientX - rect.left)));
      this.onEditMeter(bar);
    });
  }

  // ---------- lane / clip interaction ----------
  laneIndexAtY(clientY) {
    const rect = this.rows.getBoundingClientRect();
    return Math.floor((clientY - rect.top) / this.laneH);
  }

  bindLanes() {
    this.rows.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const clipEl = e.target.closest('.clip');
      const laneEl = e.target.closest('.lane');
      if (!laneEl) return;
      const trackId = laneEl.dataset.track;
      if (!clipEl) {
        this.store.setUI({ selectedTrackId: trackId, selectedClipId: null });
        return;
      }
      const found = this.store.findClip(clipEl.dataset.clip);
      if (!found) return;
      const { clip, track } = found;
      this.store.ui.selectedTrackId = track.id;
      this.store.ui.selectedClipId = clip.id;
      this.rows.querySelectorAll('.clip.selected').forEach((c) => c.classList.remove('selected'));
      clipEl.classList.add('selected');
      this.rows.querySelectorAll('.lane').forEach((l) => l.classList.toggle('selected', l.dataset.track === track.id));
      this.store.emit('selection');

      const resizing = !!e.target.dataset.resize;
      const startX = e.clientX;
      const m = this.meter;
      const snap = this.store.ui.snap;
      const origStart = clip.start;
      const origLen = clip.length;
      const origLane = this.store.project.tracks.indexOf(track);
      // keep the clip's offset from the grid when moving
      let newStart = origStart; let newLen = origLen; let newLane = origLane;
      let moved = false;
      clipEl.setPointerCapture(e.pointerId);
      clipEl.classList.add('dragging');
      const move = (ev) => {
        const dxTicks = this.xToTick(ev.clientX - startX);
        if (Math.abs(ev.clientX - startX) > 3 || Math.abs(ev.clientY - e.clientY) > 3) moved = true;
        if (!moved) return;
        if (resizing) {
          const endT = m.snap(origStart + origLen + dxTicks, snap);
          const minLen = Math.max(1, m.gridTicksAt(origStart, snap === 'off' ? PPQ / 8 : snap));
          newLen = Math.max(minLen, endT - origStart);
          clipEl.style.width = `${this.tickToX(newLen)}px`;
        } else {
          newStart = m.snap(origStart + dxTicks, snap);
          clipEl.style.left = `${this.tickToX(newStart)}px`;
          const li = Math.max(0, Math.min(this.store.project.tracks.length - 1, this.laneIndexAtY(ev.clientY)));
          const target = this.store.project.tracks[li];
          if (target && target.type === track.type) {
            newLane = li;
            clipEl.style.transform = `translateY(${(li - origLane) * this.laneH}px)`;
          }
        }
      };
      const up = () => {
        clipEl.removeEventListener('pointermove', move);
        clipEl.removeEventListener('pointerup', up);
        clipEl.classList.remove('dragging');
        if (!moved) return;
        this.store.mutate((p) => {
          const src = p.tracks[origLane];
          const c = src.clips.find((x) => x.id === clip.id);
          c.start = newStart; c.length = newLen;
          if (newLane !== origLane) {
            src.clips = src.clips.filter((x) => x.id !== c.id);
            p.tracks[newLane].clips.push(c);
            this.store.ui.selectedTrackId = p.tracks[newLane].id;
          }
        });
      };
      clipEl.addEventListener('pointermove', move);
      clipEl.addEventListener('pointerup', up);
    });

    this.rows.addEventListener('dblclick', (e) => {
      const laneEl = e.target.closest('.lane');
      const clipEl = e.target.closest('.clip');
      if (clipEl) { this.onOpenClip?.(clipEl.dataset.clip); return; }
      if (!laneEl) return;
      const track = this.store.track(laneEl.dataset.track);
      if (!track || track.type !== 'instrument') return;
      const rect = this.rows.getBoundingClientRect();
      const m = this.meter;
      const tick = this.xToTick(e.clientX - rect.left);
      const bar = Math.floor(m.tickToBar(tick));
      const start = m.barToTick(bar);
      const len = m.meterAtBar(bar).barTicks;
      const clip = newClip(start, len, []);
      this.store.mutate((p) => { p.tracks.find((t) => t.id === track.id).clips.push(clip); });
      this.store.setUI({ selectedClipId: clip.id });
      this.onOpenClip?.(clip.id);
    });
  }
}

function groupStartSet(seg) {
  const s = new Set();
  if (seg.groups) { let a = 0; for (const g of seg.groups) { s.add(a); a += g; } }
  return s;
}

/** Multiply a #rrggbb color's brightness. */
export function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${c((n >> 16) & 255)}, ${c((n >> 8) & 255)}, ${c(n & 255)})`;
}
