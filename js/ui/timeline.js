// Arrangement timeline: ruler, grid, lanes, clips, playhead and editing.
import { PPQ, MeterMap, TempoMap } from '../timing.js';
import { colorForTrack } from '../audio/presets.js';
import { newClip, patternLength, expandNotes, repeatCount } from '../project.js';
import { h, popupMenu } from './dom.js';
import { AUTO_H, laneData, drawLane, bindLaneRow } from './autolanes.js';

const LOOP_STRIP = 22;
const RULER_H = 54;

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
    const autoRow = (trackId, laneId) => {
      const row = h('div', { class: 'alane', 'data-track': trackId, 'data-lane': laneId }, h('canvas', { class: 'acanvas' }));
      bindLaneRow(row, { store: this.store, timeline: this });
      return row;
    };
    if (ui.showTempo) this.rows.append(autoRow('', 'tempo'));
    for (const t of project.tracks) {
      const lane = h('div', { class: `lane ${t.id === ui.selectedTrackId ? 'selected' : ''}`, 'data-track': t.id });
      const color = colorForTrack(t);
      for (const c of t.clips) lane.append(this.renderClip(t, c, color));
      this.rows.append(lane);
      if (t.showAuto) for (const a of t.automation || []) this.rows.append(autoRow(t.id, a.id));
    }
    this.layout();
    this.drawStatic();
  }

  renderClip(track, clip, color) {
    const sel = this.store.isClipSelected(clip.id);
    const x = this.tickToX(clip.start);
    const w = Math.max(6, this.tickToX(clip.length));
    const el = h('div', {
      class: `clip ${sel ? 'selected' : ''}`,
      'data-clip': clip.id,
      style: { left: `${x}px`, width: `${w}px`, background: `linear-gradient(${shade(color, 0.55)}, ${shade(color, 0.35)})` },
    },
    h('div', { class: 'clip-name' }, clip.name || track.name, clip.loop && repeatCount(clip) > 1.01 ? h('span', { class: 'rep-count' }, ` ×${+repeatCount(clip).toFixed(2)}`) : null),
    h('div', { class: 'resize', 'data-resize': '1' }));
    if (track.type !== 'audio' && clip.notes.length) el.append(this.miniNotes(clip, w, color));
    if (clip.audioId) el.append(this.waveform(clip, w, color));
    // repeat seams
    const L = patternLength(clip);
    if (clip.loop && clip.length > L) {
      for (let x2 = L; x2 < clip.length - 1; x2 += L) el.append(h('div', { class: 'rep-seam', style: { left: `${this.tickToX(x2)}px` } }));
    }
    {
      el.append(h('div', {
        class: 'repeat', 'data-repeat': '1',
        title: 'Repeat · click: one more time · drag right/left: repeat more or less (drag back to remove repeats, stop halfway for half a repeat) · Shift-click: to the end of the song · right-click: more options',
      }, '⟳'));
    }
    return el;
  }

  waveform(clip, w, color) {
    const H = this.laneH - 8 - 2 - 16 - 4;
    const cw = Math.max(1, Math.floor(Math.min(w, 4000)));
    const c = h('canvas', { width: cw, height: H, style: { width: `${w}px`, height: `${H}px` } });
    const pk = this.engine.peaks(clip.audioId, 128);
    if (!pk) return c; // drawn once the recording has loaded
    const g = c.getContext('2d');
    const tempo = new TempoMap(this.store.project.tempos);
    const off = clip.srcOffset || 0;
    const n = pk.data.length / 2;
    g.fillStyle = shade(color, 1.4);
    const mid = H / 2;
    const gainMul = Math.pow(10, (clip.gain || 0) / 20);
    const L = clip.loop && clip.loop > 0 ? clip.loop : clip.length;
    for (let x = 0; x < cw; x++) {
      // which repeat this pixel is in, and where inside the recording that is
      const tick = clip.start + (x / cw) * clip.length;
      const k = Math.floor((tick - clip.start) / L);
      const base = clip.start + k * L;
      const s0 = off + tempo.tickToSec(tick) - tempo.tickToSec(base);
      const s1 = s0 + (tempo.tickToSec(clip.start + ((x + 1) / cw) * clip.length) - tempo.tickToSec(tick));
      const i0 = Math.floor((s0 * pk.sampleRate) / pk.per);
      const i1 = Math.max(i0 + 1, Math.ceil((s1 * pk.sampleRate) / pk.per));
      if (i0 >= n) continue;
      let lo = 0; let hi = 0;
      for (let i = i0; i < Math.min(i1, n); i++) { lo = Math.min(lo, pk.data[i * 2]); hi = Math.max(hi, pk.data[i * 2 + 1]); }
      const y1 = mid - Math.min(1, hi * gainMul) * mid;
      const y2 = mid - Math.max(-1, lo * gainMul) * mid;
      g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
    return c;
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
    for (const n of expandNotes(clip)) {
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
    const { project, ui } = this.store;
    let contentH = project.tracks.length * this.laneH + (ui.showTempo ? AUTO_H : 0);
    for (const t of project.tracks) if (t.showAuto) contentH += (t.automation || []).length * AUTO_H;
    const lanesH = Math.max(contentH, this.arrange.clientHeight - RULER_H);
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
      g.fillStyle = 'rgba(123,175,212,0.05)';
      g.fillRect(p.loop.start * ppt - x0, 0, (p.loop.end - p.loop.start) * ppt, lanesH);
    }

    // ---- ruler ----
    const rc = this.rulerCanvas;
    const RH = RULER_H;
    rc.width = Math.floor(w * dpr); rc.height = Math.floor(RH * dpr);
    rc.style.width = `${w}px`; rc.style.height = `${RH}px`; rc.style.left = `${x0}px`;
    const r = rc.getContext('2d');
    r.setTransform(dpr, 0, 0, dpr, 0, 0);
    r.clearRect(0, 0, w, RH);
    this.drawLoopStrip(r, w, x0, ppt, p.loop);

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
        r.fillText(String(bar + 1), bx + 4, LOOP_STRIP + 11);
        lastLabelX = bx;
      }
      const isChange = p.meters.some((mm) => mm.bar === bar);
      if (isChange) {
        const label = `${seg.num}/${seg.den}${seg.groups ? ` (${seg.group})` : ''}`;
        const tw = r.measureText(label).width + 8;
        r.fillStyle = '#1b2d3d';
        r.fillRect(bx + 1, RH - 15, tw, 13);
        r.fillStyle = '#b5d6ec';
        r.fillText(label, bx + 5, RH - 8);
        this.meterMarkers.push({ bar, x: bx + x0, w: tw });
      }
    }
    this.drawLanes();
    this.updatePlayhead();
  }

  /** Draw every visible automation lane (each canvas covers only the visible width). */
  drawLanes() {
    const dpr = window.devicePixelRatio || 1;
    const { x0, w } = this.viewport();
    const playTick = this.engine.currentTick();
    for (const row of this.rows.querySelectorAll('.alane')) {
      const data = laneData(this.store.project, row.dataset.track, row.dataset.lane);
      if (data) drawLane(row.firstChild, { data, x0, w, ppt: this.pxPerTick, dpr, playTick });
    }
  }

  previewLane(row, data) {
    const { x0, w } = this.viewport();
    drawLane(row.firstChild, { data, x0, w, ppt: this.pxPerTick, dpr: window.devicePixelRatio || 1 });
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
    const sel = new Set(this.store.clipSelection());
    this.rows.querySelectorAll('.clip').forEach((c) => c.classList.toggle('selected', sel.has(c.dataset.clip)));
  }

  // ---------- loop strip ----------
  drawLoopStrip(r, w, x0, ppt, loop) {
    const H = LOOP_STRIP;
    r.fillStyle = '#0f1216';
    r.fillRect(0, 0, w, H);
    r.fillStyle = '#2a303a';
    r.fillRect(0, H - 1, w, 1);
    const has = loop.end > loop.start;
    const lx = loop.start * ppt - x0;
    const lw = (loop.end - loop.start) * ppt;
    r.font = '600 11px system-ui, sans-serif';
    r.textBaseline = 'middle';
    if (!has) {
      r.fillStyle = '#6b7383';
      r.fillText('⟲ Drag here to set a loop', 8, H / 2);
      return;
    }
    const on = loop.enabled;
    // region
    r.fillStyle = on ? '#7bafd4' : '#3a404c';
    r.beginPath();
    r.roundRect ? r.roundRect(lx, 2, lw, H - 4, 5) : r.rect(lx, 2, lw, H - 4);
    r.fill();
    if (!on) {
      r.strokeStyle = '#8b93a3';
      r.setLineDash([4, 3]);
      r.strokeRect(lx + 0.5, 2.5, lw - 1, H - 5);
      r.setLineDash([]);
    }
    // grab handles at both ends
    for (const hx of [lx, lx + lw - 8]) {
      r.fillStyle = on ? '#3a72a0' : '#252a33';
      r.fillRect(hx, 2, 8, H - 4);
      r.fillStyle = on ? '#e6f2fa' : '#8b93a3';
      r.fillRect(hx + 2.5, 6, 1, H - 12);
      r.fillRect(hx + 4.5, 6, 1, H - 12);
    }
    // label
    const m = this.meter;
    const b1 = +(m.tickToBar(loop.start) + 1).toFixed(2);
    const b2 = +(m.tickToBar(loop.end) + 1).toFixed(2);
    const full = on ? `⟲ Loop bars ${b1}–${b2} · click to turn off · drag the ends to resize` : `⟲ Loop off (bars ${b1}–${b2}) · click to turn on`;
    const short = on ? `⟲ ${b1}–${b2}` : '⟲ off';
    r.fillStyle = on ? '#06121c' : '#c9ced8';
    const avail = lw - 24;
    const text = r.measureText(full).width <= avail ? full : r.measureText(short).width <= avail ? short : '';
    if (text) r.fillText(text, Math.max(lx + 12, Math.min(lx + 12, w)), H / 2 + 0.5);
  }

  loopZone(x) {
    const loop = this.store.project.loop;
    if (!(loop.end > loop.start)) return 'outside';
    const lx = this.tickToX(loop.start);
    const rx = this.tickToX(loop.end);
    if (Math.abs(x - lx) <= 9 && x < (lx + rx) / 2) return 'start';
    if (Math.abs(x - rx) <= 9) return 'end';
    if (x > lx && x < rx) return 'inside';
    return 'outside';
  }

  /** Loop strip: drag the ends to resize, drag the middle to move, drag elsewhere for a new loop, click to toggle. */
  loopDrag(e, rect) {
    const m = this.meter;
    const snapOpt = this.store.ui.snap === 'off' ? 'beat' : this.store.ui.snap;
    const sn = (t) => m.snap(Math.max(0, t), snapOpt);
    const x = e.clientX - rect.left;
    const zone = this.loopZone(x);
    const orig = { ...this.store.project.loop };
    const t0 = this.xToTick(x);
    let next = { ...orig };
    let moved = false;
    this.ruler.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const xx = ev.clientX - rect.left;
      if (Math.abs(xx - x) > 3) moved = true;
      if (!moved) return;
      const t = this.xToTick(xx);
      if (zone === 'start') next = { ...orig, enabled: true, start: Math.min(sn(t), orig.end - 1) };
      else if (zone === 'end') next = { ...orig, enabled: true, end: Math.max(sn(t), orig.start + 1) };
      else if (zone === 'inside') {
        const len = orig.end - orig.start;
        const ns = sn(orig.start + (t - t0));
        next = { ...orig, enabled: true, start: ns, end: ns + len };
      } else {
        const a = sn(Math.min(t0, t)); const b = sn(Math.max(t0, t));
        next = { enabled: true, start: a, end: Math.max(b, a + 1) };
      }
      // keep a sensible minimum (one snap step)
      if (next.end - next.start < 30) next.end = next.start + m.gridTicksAt(next.start, snapOpt);
      this.store.project.loop = next;
      this.drawStatic();
    };
    const up = () => {
      this.ruler.removeEventListener('pointermove', move);
      this.ruler.removeEventListener('pointerup', up);
      this.store.project.loop = orig; // so undo restores the previous loop
      if (moved) this.store.mutate((p) => { p.loop = next; });
      else if (zone === 'inside' || zone === 'start' || zone === 'end') this.store.mutate((p) => { p.loop.enabled = !p.loop.enabled; });
      else this.store.emit('project');
    };
    this.ruler.addEventListener('pointermove', move);
    this.ruler.addEventListener('pointerup', up);
  }

  // ---------- ruler interaction ----------
  bindRuler() {
    this.ruler.addEventListener('pointermove', (e) => {
      if (e.buttons) return;
      const rect = this.ruler.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (e.clientY - rect.top >= LOOP_STRIP) { this.ruler.style.cursor = 'pointer'; return; }
      const z = this.loopZone(x);
      this.ruler.style.cursor = z === 'start' || z === 'end' ? 'ew-resize' : z === 'inside' ? 'grab' : 'crosshair';
    });
    this.ruler.addEventListener('pointerdown', (e) => {
      const rect = this.ruler.getBoundingClientRect();
      const x = e.clientX - rect.left; // ruler element starts at lane x=0
      const y = e.clientY - rect.top;
      const tick = this.xToTick(x);
      const m = this.meter;
      const snap = this.store.ui.snap;
      if (y < LOOP_STRIP) { this.loopDrag(e, rect); return; }
      const marker = this.meterMarkers.find((mk) => x >= mk.x && x <= mk.x + mk.w && y >= RULER_H - 17);
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
      if (e.clientY - rect.top < LOOP_STRIP) return;
      const bar = Math.floor(this.meter.tickToBar(this.xToTick(e.clientX - rect.left)));
      this.onEditMeter(bar);
    });
  }

  // ---------- lane / clip interaction ----------
  /** Index (in project.tracks) of the track row under a screen y, or -1. */
  laneIndexAtY(clientY) {
    const rows = [...this.rows.querySelectorAll('.lane')];
    for (const r of rows) {
      const rect = r.getBoundingClientRect();
      if (clientY >= rect.top && clientY < rect.bottom) return this.store.project.tracks.findIndex((t) => t.id === r.dataset.track);
    }
    return -1;
  }

  /**
   * The ⟳ repeat handle.
   * Click: one more repeat · drag right/left: repeat more or less (stops at the snap grid, with a pull toward
   * whole repeats; drag all the way back to remove repeats) · Shift-click: to the end of the song ·
   * right-click: menu (remove repeats, half repeat, double, …).
   */
  repeatDrag(e, clipEl, clip, track) {
    e.stopPropagation();
    if (e.button === 2) return;
    const L = patternLength(clip);
    const startX = e.clientX;
    const origLen = clip.length;
    const m = this.meter;
    const snapOpt = this.store.ui.snap === 'off' ? 'beat' : this.store.ui.snap;
    let newLen = origLen;
    let moved = false;
    const el = e.target;
    el.setPointerCapture(e.pointerId);
    const label = h('div', { class: 'rep-tip' });
    clipEl.append(label);
    const move = (ev) => {
      if (Math.abs(ev.clientX - startX) > 3) moved = true;
      if (!moved) return;
      const raw = origLen + this.xToTick(ev.clientX - startX);
      let len = m.snap(clip.start + raw, snapOpt) - clip.start;
      // pull toward whole repeats (within 10px) so "exactly 2×" is easy to hit
      const whole = Math.round(raw / L) * L;
      if (Math.abs(this.tickToX(whole - raw)) < 10) len = whole;
      newLen = Math.max(m.gridTicksAt(clip.start, snapOpt), len);
      clipEl.style.width = `${this.tickToX(newLen)}px`;
      const reps = newLen / L;
      label.textContent = reps <= 1.0001 ? (reps < 0.999 ? 'shorter than the pattern' : 'plays once (no repeats)') : `plays ${+reps.toFixed(2)}×`;
    };
    const up = (ev) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      label.remove();
      if (!moved) {
        if (ev.shiftKey) this.setRepeat(clip, track, 'end');
        else this.setRepeat(clip, track, (Math.floor(origLen / L + 1e-6) + 1) * L);
        return;
      }
      if (newLen === origLen) return;
      this.setRepeat(clip, track, newLen);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  }

  repeatMenu(e, clip, track) {
    e.preventDefault();
    e.stopPropagation();
    const L = patternLength(clip);
    const reps = clip.length / L;
    popupMenu(e.clientX, e.clientY, [
      { label: 'Remove repeats', hint: 'play once', disabled: reps <= 1.0001, onClick: () => this.setRepeat(clip, track, L) },
      { label: 'Remove last repeat', disabled: reps <= 1.0001, onClick: () => this.setRepeat(clip, track, Math.max(L, (Math.ceil(reps - 1e-6) - 1) * L)) },
      '-',
      { label: 'Add half a repeat', hint: '+½', onClick: () => this.setRepeat(clip, track, clip.length + L / 2) },
      { label: 'Add one repeat', hint: '+1', onClick: () => this.setRepeat(clip, track, (Math.floor(reps + 1e-6) + 1) * L) },
      { label: 'Double it', hint: `→ ${+(reps * 2).toFixed(2)}×`, onClick: () => this.setRepeat(clip, track, clip.length * 2) },
      { label: 'Repeat to the end of the song', onClick: () => this.setRepeat(clip, track, 'end') },
    ]);
  }

  /** Set how long a repeating clip plays (ticks), or 'end' to fill to the end of the song. */
  setRepeat(clip, track, len) {
    const L = patternLength(clip);
    if (len === 'end') {
      let end = 0;
      for (const t of this.store.project.tracks) for (const c of t.clips) if (c.id !== clip.id) end = Math.max(end, c.start + c.length);
      len = Math.max(Math.ceil((end - clip.start) / L), Math.ceil(clip.length / L) + 4) * L;
    }
    len = Math.max(1, Math.round(len));
    this.store.mutate((p) => {
      const c = p.tracks.find((t) => t.id === track.id)?.clips.find((x) => x.id === clip.id);
      if (!c) return;
      if (Math.abs(len - L) < 1) { c.length = L; delete c.loop; } // back to a plain clip
      else if (len < L) { c.length = len; delete c.loop; } // shorter than the pattern: just a shorter clip
      else { c.loop = L; c.length = len; }
    });
  }

  /** Drag several selected clips together (time only; each stays on its own track). */
  groupDrag(e, clip, ids) {
    const startX = e.clientX;
    const snap = this.store.ui.snap;
    const els = ids.map((id) => this.rows.querySelector(`.clip[data-clip="${id}"]`)).filter(Boolean);
    const starts = new Map(ids.map((id) => [id, this.store.findClip(id)?.clip.start ?? 0]));
    const minStart = Math.min(...starts.values());
    let delta = 0;
    let moved = false;
    const target = e.target.closest('.clip');
    target.setPointerCapture(e.pointerId);
    const move = (ev) => {
      if (Math.abs(ev.clientX - startX) > 3) moved = true;
      if (!moved) return;
      const ns = this.meter.snap(clip.start + this.xToTick(ev.clientX - startX), snap);
      delta = Math.max(-minStart, ns - clip.start);
      for (const el of els) el.style.left = `${this.tickToX(starts.get(el.dataset.clip) + delta)}px`;
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      if (!moved || !delta) return;
      this.store.mutate((p) => {
        for (const t of p.tracks) for (const c of t.clips) if (starts.has(c.id)) c.start = starts.get(c.id) + delta;
      });
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  }

  bindLanes() {
    this.rows.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const clipEl = e.target.closest('.clip');
      const laneEl = e.target.closest('.lane');
      if (!laneEl) return;
      const trackId = laneEl.dataset.track;
      if (!clipEl) {
        this.store.ui.focus = 'track';
        this.store.setUI({ selectedTrackId: trackId, selectedClipId: null });
        return;
      }
      this.store.ui.focus = 'clip';
      const found = this.store.findClip(clipEl.dataset.clip);
      if (!found) return;
      const { clip, track } = found;
      const ui = this.store.ui;
      // Ctrl+Shift-click (or Ctrl-click) adds/removes clips — on any track — to the selection
      if ((e.ctrlKey || e.metaKey) && !e.target.dataset.resize && !e.target.dataset.repeat) {
        const cur = this.store.clipSelection();
        let ids = cur.includes(clip.id) ? cur.filter((id) => id !== clip.id) : [...cur, clip.id];
        if (!ids.length) ids = [clip.id];
        ui.selectedClipIds = ids;
        ui.selectedClipId = ids.includes(clip.id) ? clip.id : ids[ids.length - 1];
        const f2 = this.store.findClip(ui.selectedClipId);
        ui.selectedTrackId = f2.track.id;
        ui.selectedTrackIds = [f2.track.id];
        this.updateSelection();
        this.store.emit('selection');
        return;
      }
      const group = this.store.clipSelection();
      const groupDrag = group.length > 1 && group.includes(clip.id) && !e.target.dataset.resize && !e.target.dataset.repeat;
      ui.selectedTrackId = track.id;
      ui.selectedTrackIds = [track.id];
      ui.selectedClipId = clip.id;
      if (!groupDrag) ui.selectedClipIds = [clip.id];
      this.updateSelection();
      this.store.emit('selection');
      if (groupDrag) { this.groupDrag(e, clip, group); return; }

      if (e.target.dataset.repeat) { this.repeatDrag(e, clipEl, clip, track); return; }
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
          const li = this.laneIndexAtY(ev.clientY);
          const target = this.store.project.tracks[li];
          if (target && target.type === track.type) {
            newLane = li;
            const from = this.rows.querySelector(`.lane[data-track="${track.id}"]`).getBoundingClientRect().top;
            const to = this.rows.querySelector(`.lane[data-track="${target.id}"]`).getBoundingClientRect().top;
            clipEl.style.transform = `translateY(${to - from}px)`;
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

    this.rows.addEventListener('contextmenu', (e) => {
      if (!e.target.dataset?.repeat) { this.onClipMenu?.(e); return; }
      const found = this.store.findClip(e.target.closest('.clip').dataset.clip);
      if (found) this.repeatMenu(e, found.clip, found.track);
    });

    this.rows.addEventListener('dblclick', (e) => {
      const laneEl = e.target.closest('.lane');
      const clipEl = e.target.closest('.clip');
      if (clipEl) { this.onOpenClip?.(clipEl.dataset.clip); return; }
      if (!laneEl) return;
      const track = this.store.track(laneEl.dataset.track);
      if (!track || track.type === 'audio') return;
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
