// Beat editor: step sequencer for clips on drum tracks.
// Click a cell to add or remove a hit (drag to paint). Shift-click = accent, Alt-click = soft hit.
// Click a pad name to hear it and to show its velocities in the lane below.
import { PPQ, MeterMap } from '../timing.js';
import { getKit, PATTERNS } from '../audio/drums.js';
import { CATEGORY_COLORS } from '../audio/presets.js';
import { h, toast } from './dom.js';
import { setup, ensureNoteIds } from './pianoroll.js';
import { shade } from './timeline.js';
import { patternLength } from '../project.js';

const ROW_H = 26;
const NAMES_W = 130;
const VEL_H = 64;
const RULER_H = 20;
const GRIDS = [
  { label: '1/4', value: PPQ }, { label: '1/8', value: PPQ / 2 }, { label: '1/16', value: PPQ / 4 },
  { label: '1/32', value: PPQ / 8 }, { label: '1/8 T', value: PPQ / 3 }, { label: '1/16 T', value: PPQ / 6 },
  { label: '1/32 T', value: PPQ / 12 },
];
let seq = 1;
const nid = () => `d${Date.now().toString(36)}${(seq++).toString(36)}`;

export class BeatEditor {
  constructor({ store, engine, root }) {
    this.store = store;
    this.engine = engine;
    this.root = root;
    this.clipId = null;
    this.grid = PPQ / 4;
    this.vel = 100;
    this.cellW = 26; // px per 1/16
    this.selRow = 36;
    this.work = null;
    this.active = false;
    this.build();
  }

  get found() { return this.clipId ? this.store.findClip(this.clipId) : null; }
  get clip() { return this.found?.clip || null; }
  get track() { return this.found?.track || null; }
  get kit() { return getKit(this.track?.drums?.kit); }
  get notes() { return this.work || this.clip?.notes || []; }
  get ppt() { return (this.cellW / (PPQ / 4)); }
  get meter() { return new MeterMap(this.store.project.meters); }

  open(clipId) {
    this.clipId = clipId;
    const c = this.clip;
    if (c) {
      ensureNoteIds(c);
      // pick a grid that fits what's already there
      if (c.swingGrid) this.grid = c.swingGrid;
      this.gridSel.value = String(this.grid);
    }
    this.refresh();
  }

  build() {
    this.gridSel = h('select', { title: 'Step size', onchange: (e) => { this.grid = +e.target.value; this.draw(); e.target.blur(); } },
      GRIDS.map((g) => h('option', { value: String(g.value), selected: g.value === this.grid }, g.label)));
    this.swingIn = h('input', {
      type: 'range', min: 0, max: 100, step: 1, value: 0, title: 'Swing: delays every second step',
      oninput: (e) => {
        this.swingLabel.textContent = `${e.target.value}%`;
        const id = this.clipId; const grid = this.grid; const v = +e.target.value;
        this.store.mutate((p) => { for (const t of p.tracks) for (const c of t.clips) if (c.id === id) { c.swing = v; c.swingGrid = grid; } }, { merge: `swing:${id}`, silent: true });
      },
    });
    this.swingLabel = h('span', { class: 'qv' }, '0%');
    const velIn = h('input', { type: 'number', min: 1, max: 127, value: this.vel, title: 'Velocity of new hits (Shift-click = accent 127, Alt-click = soft)', onchange: (e) => { this.vel = Math.max(1, Math.min(127, +e.target.value || 100)); e.target.value = this.vel; } });
    velIn.addEventListener('keydown', (e) => e.stopPropagation());
    const patSel = h('select', {
      title: 'Fill this clip with a starter beat',
      onchange: (e) => { const i = +e.target.value; e.target.value = ''; e.target.blur(); if (i >= 0) this.applyPattern(PATTERNS[i]); },
    }, h('option', { value: '' }, 'Starter beat…'), PATTERNS.map((pt, i) => h('option', { value: String(i) }, pt.name)));
    this.title = h('div', { class: 'pr-title' });
    const toolbar = h('div', { class: 'pr-toolbar' },
      this.title,
      h('label', { class: 'pfield' }, 'Steps', this.gridSel),
      h('label', { class: 'pfield' }, 'Swing', this.swingIn, this.swingLabel),
      h('label', { class: 'pfield' }, 'Velocity', velIn),
      h('label', { class: 'pfield' }, patSel),
      h('div', { class: 'pgroup' },
        h('button', { class: 'pbtn', title: 'Make the clip one bar shorter', onclick: () => this.changeBars(-1) }, '− Bar'),
        h('button', { class: 'pbtn', title: 'Make the clip one bar longer', onclick: () => this.changeBars(1) }, '+ Bar'),
        h('button', { class: 'pbtn', title: 'Remove every hit in this clip', onclick: () => this.clearAll() }, 'Clear')),
      h('div', { class: 'spacer' }),
      h('div', { class: 'pgroup' },
        h('button', { class: 'pbtn', title: 'Narrower steps', onclick: () => { this.cellW = Math.max(10, this.cellW / 1.2); this.draw(); } }, '−'),
        h('button', { class: 'pbtn', title: 'Wider steps', onclick: () => { this.cellW = Math.min(80, this.cellW * 1.2); this.draw(); } }, '+')));

    this.rulerCanvas = h('canvas');
    this.namesCanvas = h('canvas');
    this.gridCanvas = h('canvas', { class: 'pr-grid' });
    this.spacer = h('div', { class: 'pr-spacer' }, this.gridCanvas);
    this.scroll = h('div', { class: 'pr-scroll' }, this.spacer);
    this.velCanvas = h('canvas');
    this.velLabel = h('div', { class: 'pr-vel-label' }, 'Velocity');
    this.empty = h('div', { class: 'pr-empty' }, 'Double-click a drum clip to program a beat.');
    this.body = h('div', { class: 'pr-body be-body' },
      h('div', { class: 'pr-corner' }),
      h('div', { class: 'pr-ruler-wrap' }, this.rulerCanvas),
      h('div', { class: 'pr-keys-wrap be-names' }, this.namesCanvas),
      this.scroll,
      this.velLabel,
      h('div', { class: 'pr-vel-wrap' }, this.velCanvas));
    this.root.append(h('div', { class: 'pr' }, toolbar, this.body, this.empty));
    this.scroll.addEventListener('scroll', () => this.draw());
    new ResizeObserver(() => this.draw()).observe(this.scroll);
    this.root.addEventListener('pointerdown', () => { this.active = true; }, true);
    this.bindGrid();
    this.bindNames();
    this.bindVel();
  }

  refresh() {
    const c = this.clip;
    this.empty.hidden = !!c;
    this.body.style.visibility = c ? 'visible' : 'hidden';
    if (!c) { this.title.textContent = 'Beat Editor'; return; }
    ensureNoteIds(c);
    this.swingIn.value = c.swing || 0;
    this.swingLabel.textContent = `${c.swing || 0}%`;
    if (!this.kit.pads.some((p) => p.note === this.selRow)) this.selRow = this.kit.pads[0].note;
    const bar = Math.floor(this.meter.tickToBar(c.start)) + 1;
    this.title.innerHTML = '';
    this.title.append(h('span', { class: 'dot', style: { background: CATEGORY_COLORS.Drums } }), h('b', {}, this.track.name), h('small', {}, ` · bar ${bar} · ${c.notes.length} hits`));
    this.draw();
  }

  rows() { return this.kit.pads; }

  // ---------- geometry ----------
  cells() {
    // step start ticks (relative to clip), restarting at each barline so odd meters line up
    const c = this.clip;
    const m = this.meter;
    const out = [];
    const len = patternLength(c);
    let bar = Math.floor(m.tickToBar(c.start) + 1e-9);
    for (let guard = 0; guard < 500; guard++, bar++) {
      const bs = m.barToTick(bar) - c.start;
      const be = m.barToTick(bar + 1) - c.start;
      if (bs >= len) break;
      for (let t = Math.max(0, bs); t < Math.min(be, len) - 1; t += this.grid) {
        out.push({ t, len: Math.min(this.grid, be - t, len - t), barStart: t === Math.max(0, bs) && bs >= 0 });
      }
    }
    return out;
  }

  noteIn(cell, pitch) {
    return this.notes.find((n) => n.p === pitch && n.t >= cell.t - 1 && n.t < cell.t + cell.len - 1);
  }

  // ---------- drawing ----------
  draw() {
    const c = this.clip;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const W = this.scroll.clientWidth;
    const H = this.scroll.clientHeight;
    if (!W || !H) return;
    const ppt = this.ppt;
    const x0 = this.scroll.scrollLeft;
    const y0 = this.scroll.scrollTop;
    const rows = this.rows();
    this.spacer.style.width = `${Math.ceil(patternLength(c) * ppt) + 40}px`;
    this.spacer.style.height = `${rows.length * ROW_H}px`;
    const cells = this.cells();
    const color = CATEGORY_COLORS.Drums;
    const m = this.meter;

    const g = setup(this.gridCanvas, W, H, dpr);
    this.gridCanvas.style.left = `${x0}px`;
    this.gridCanvas.style.top = `${y0}px`;
    g.fillStyle = '#14171c';
    g.fillRect(0, 0, W, H);
    const playRel = this.engine.currentTick() - c.start;
    rows.forEach((pad, ri) => {
      const y = ri * ROW_H - y0;
      if (y > H || y + ROW_H < 0) return;
      for (const cell of cells) {
        const x = cell.t * ppt - x0;
        const w = cell.len * ppt;
        if (x > W || x + w < 0) continue;
        const absT = c.start + cell.t;
        const bbt = m.tickToBBT(absT);
        const onBeat = bbt.tickInBeat < 1;
        const beatIdx = bbt.beat;
        const shadeBeat = Math.floor(beatIdx) % 2 === 1;
        g.fillStyle = shadeBeat ? '#20242c' : '#252a33';
        if (pad.note === this.selRow) g.fillStyle = shadeBeat ? '#262c38' : '#2c3340';
        g.fillRect(x + 1, y + 2, Math.max(2, w - 2), ROW_H - 4);
        const n = this.noteIn(cell, pad.note);
        if (n) {
          const a = 0.35 + 0.65 * (n.v / 127);
          g.fillStyle = shade(color, 0.5 + 0.8 * a);
          g.fillRect(x + 2, y + 3, Math.max(2, w - 4), ROW_H - 6);
          if (n.v >= 120) { g.fillStyle = '#fff'; g.fillRect(x + 2, y + 3, Math.max(2, w - 4), 3); }
        }
        if (playRel >= cell.t && playRel < cell.t + cell.len && this.engine.playing) {
          g.fillStyle = 'rgba(255,255,255,0.12)';
          g.fillRect(x, y, w, ROW_H);
        }
        if (cell.barStart || onBeat) {
          g.fillStyle = cell.barStart ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.1)';
          g.fillRect(x, y, 1, ROW_H);
        }
      }
    });

    // ruler
    const r = setup(this.rulerCanvas, W, RULER_H, dpr);
    r.fillStyle = '#181b21'; r.fillRect(0, 0, W, RULER_H);
    r.font = '11px system-ui, sans-serif';
    r.textBaseline = 'middle';
    let stepInBar = 0;
    for (const cell of cells) {
      if (cell.barStart) stepInBar = 0;
      const x = cell.t * ppt - x0;
      if (x > W) break;
      if (x + cell.len * ppt >= 0) {
        if (cell.barStart) {
          r.fillStyle = '#c9ced8';
          r.fillText(String(Math.floor(m.tickToBar(c.start + cell.t)) + 1), x + 3, RULER_H / 2);
          r.fillStyle = '#5a6270'; r.fillRect(x, 0, 1, RULER_H);
        } else if (cell.len * ppt > 14) {
          r.fillStyle = '#4a5260';
          r.fillText(String(stepInBar + 1), x + 3, RULER_H / 2 + 1);
        }
      }
      stepInBar++;
    }

    // pad names
    const k = setup(this.namesCanvas, NAMES_W, H, dpr);
    k.font = '12px system-ui, sans-serif';
    k.textBaseline = 'middle';
    rows.forEach((pad, ri) => {
      const y = ri * ROW_H - y0;
      if (y > H || y + ROW_H < 0) return;
      const sel = pad.note === this.selRow;
      const lit = this.lit === pad.note;
      k.fillStyle = lit ? '#ff7a2f' : sel ? '#2c3340' : '#1e222a';
      k.fillRect(0, y + 1, NAMES_W, ROW_H - 2);
      k.fillStyle = sel ? color : '#3a414e';
      k.fillRect(0, y + 1, 3, ROW_H - 2);
      k.fillStyle = lit ? '#111' : '#e6e8ec';
      k.fillText(pad.name, 10, y + ROW_H / 2);
    });

    // velocity lane (selected row)
    const v = setup(this.velCanvas, W, VEL_H, dpr);
    v.fillStyle = '#14171c'; v.fillRect(0, 0, W, VEL_H);
    v.fillStyle = '#20252d';
    for (const f of [0.25, 0.5, 0.75]) v.fillRect(0, Math.round(VEL_H * f), W, 1);
    for (const cell of cells) {
      const n = this.noteIn(cell, this.selRow);
      if (!n) continue;
      const x = cell.t * ppt - x0;
      if (x < -20 || x > W) continue;
      const hh = (n.v / 127) * (VEL_H - 6);
      v.fillStyle = shade(color, 1.1);
      v.fillRect(x + 3, VEL_H - hh, Math.max(3, cell.len * ppt - 6), hh);
    }
    const pad = this.kit.pads.find((p) => p.note === this.selRow);
    this.velLabel.textContent = pad ? `Velocity · ${pad.name}` : 'Velocity';
  }

  // ---------- editing ----------
  beginWork() { this.work = this.clip.notes.map((n) => ({ ...n })); }

  commit() {
    const work = this.work;
    this.work = null;
    if (!work) return;
    const id = this.clipId;
    this.store.mutate((p) => {
      for (const t of p.tracks) {
        const c = t.clips.find((x) => x.id === id);
        if (c) c.notes = work.sort((a, b) => a.t - b.t || a.p - b.p);
      }
    });
  }

  hit(note, vel) { if (this.track) this.engine.preview(this.track.id, note, vel ?? this.vel, 0.1); }

  cellAt(e) {
    const rect = this.scroll.getBoundingClientRect();
    const x = e.clientX - rect.left + this.scroll.scrollLeft;
    const y = e.clientY - rect.top + this.scroll.scrollTop;
    const row = this.rows()[Math.floor(y / ROW_H)];
    const t = x / this.ppt;
    const cell = this.cells().find((c) => t >= c.t && t < c.t + c.len);
    return row && cell ? { row, cell } : null;
  }

  bindGrid() {
    const el = this.scroll;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.clip) return;
      if (e.offsetX > el.clientWidth || e.offsetY > el.clientHeight) return;
      const hit = this.cellAt(e);
      if (!hit) return;
      el.setPointerCapture(e.pointerId);
      this.beginWork();
      const existing = this.noteIn(hit.cell, hit.row.note);
      const adding = !existing || e.shiftKey || e.altKey;
      const vel = e.shiftKey ? 127 : e.altKey ? 50 : this.vel;
      const done = new Set();
      const apply = (h2) => {
        const key = `${h2.row.note}:${h2.cell.t}`;
        if (done.has(key)) return;
        done.add(key);
        const n = this.noteIn(h2.cell, h2.row.note);
        if (adding) {
          if (n) n.v = vel;
          else this.work.push({ id: nid(), t: h2.cell.t, d: h2.cell.len, p: h2.row.note, v: vel });
          this.hit(h2.row.note, vel);
        } else if (n) {
          this.work = this.work.filter((x) => x !== n);
        }
        this.draw();
      };
      this.selRow = hit.row.note;
      apply(hit);
      const move = (ev) => { const h2 = this.cellAt(ev); if (h2) apply(h2); };
      const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); this.commit(); };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
    el.addEventListener('wheel', (e) => {
      // scroll wheel over a hit changes its velocity
      if (!e.altKey) return;
      const hit = this.cellAt(e);
      if (!hit) return;
      const n = this.noteIn(hit.cell, hit.row.note);
      if (!n) return;
      e.preventDefault();
      this.beginWork();
      const w = this.noteIn(hit.cell, hit.row.note);
      w.v = Math.max(1, Math.min(127, w.v + (e.deltaY < 0 ? 8 : -8)));
      this.commit();
    }, { passive: false });
  }

  bindNames() {
    const c = this.namesCanvas;
    c.addEventListener('pointerdown', (e) => {
      const rect = c.getBoundingClientRect();
      const pad = this.rows()[Math.floor((e.clientY - rect.top + this.scroll.scrollTop) / ROW_H)];
      if (!pad) return;
      this.selRow = pad.note;
      this.lit = pad.note;
      this.hit(pad.note, 110);
      this.draw();
      setTimeout(() => { this.lit = null; this.draw(); }, 150);
    });
    c.addEventListener('wheel', (e) => { this.scroll.scrollTop += e.deltaY; e.preventDefault(); }, { passive: false });
  }

  bindVel() {
    const c = this.velCanvas;
    c.addEventListener('pointerdown', (e) => {
      if (!this.clip) return;
      c.setPointerCapture(e.pointerId);
      this.beginWork();
      const rect = c.getBoundingClientRect();
      const apply = (ev) => {
        const x = ev.clientX - rect.left + this.scroll.scrollLeft;
        const v = Math.max(1, Math.min(127, Math.round((1 - (ev.clientY - rect.top - 3) / (VEL_H - 6)) * 127)));
        const t = x / this.ppt;
        const cell = this.cells().find((cc) => t >= cc.t && t < cc.t + cc.len);
        if (!cell) return;
        const n = this.noteIn(cell, this.selRow);
        if (n) { n.v = v; this.draw(); }
      };
      apply(e);
      const move = (ev) => apply(ev);
      const up = () => { c.removeEventListener('pointermove', move); c.removeEventListener('pointerup', up); this.commit(); };
      c.addEventListener('pointermove', move);
      c.addEventListener('pointerup', up);
    });
  }

  applyPattern(pt) {
    const c = this.clip;
    if (!c) return;
    const m = this.meter;
    const step = PPQ / 4;
    this.beginWork();
    const notes = [];
    let bar = Math.floor(m.tickToBar(c.start) + 1e-9);
    for (let guard = 0; guard < 500; guard++, bar++) {
      const bs = m.barToTick(bar) - c.start;
      const be = m.barToTick(bar + 1) - c.start;
      if (bs >= patternLength(c)) break;
      const stepsInBar = Math.floor((be - bs) / step);
      for (const [note, str] of Object.entries(pt.rows)) {
        for (let i = 0; i < stepsInBar; i++) {
          const ch = str[i % str.length];
          const t = bs + i * step;
          if (t < 0 || t >= patternLength(c) || ch === '-') continue;
          notes.push({ id: nid(), t, d: step, p: +note, v: ch === 'X' ? 127 : 100 });
        }
      }
    }
    this.work = notes;
    this.grid = step;
    this.gridSel.value = String(step);
    this.commit();
    toast(`Added the "${pt.name}" beat — edit any step to make it yours.`);
  }

  clearAll() {
    if (!this.clip?.notes.length) return;
    this.beginWork();
    this.work = [];
    this.commit();
  }

  changeBars(dir) {
    const c = this.clip;
    if (!c) return;
    const m = this.meter;
    const endBar = Math.round(m.tickToBar(c.start + patternLength(c)));
    const startBar = Math.floor(m.tickToBar(c.start) + 1e-9);
    const nb = Math.max(startBar + 1, endBar + dir);
    const id = this.clipId;
    this.store.mutate((p) => {
      for (const t of p.tracks) {
        const cc = t.clips.find((x) => x.id === id);
        if (!cc) continue;
        const nl = m.barToTick(nb) - cc.start;
        if (cc.loop) { cc.length = Math.round((cc.length / cc.loop) * nl); cc.loop = nl; } else cc.length = nl;
      }
    });
  }

  handleKey(e) {
    if (!this.clip || !this.active) return false;
    // Delete does nothing here (so it doesn't delete the whole clip by accident) — use Clear
    if (e.code === 'Delete' || e.code === 'Backspace') return true;
    return false;
  }
}
