// Piano roll editor for MIDI clips.
// Draw mode: click empty space to add a note (drag to set its length), drag notes to move,
// drag a note's right edge to resize, double-click or right-click a note to delete it.
// Select mode (or Shift+drag in draw mode): drag a box to select notes.
import { PPQ, MeterMap, NOTE_GRIDS, noteName } from '../timing.js';
import { colorForTrack } from '../audio/presets.js';
import { h, openModal, toast } from './dom.js';
import { shade } from './timeline.js';

const ROW_H = 14;
const KEYS_W = 64;
const VEL_H = 74;
const RULER_H = 22;
const BLACK = new Set([1, 3, 6, 8, 10]);
let noteSeq = 1;
const newId = () => `n${Date.now().toString(36)}${(noteSeq++).toString(36)}`;

export function ensureNoteIds(clip) {
  for (const n of clip.notes) if (!n.id) n.id = newId();
}

export class PianoRoll {
  constructor({ store, engine, root }) {
    this.store = store;
    this.engine = engine;
    this.root = root;
    this.clipId = null;
    this.grid = PPQ / 4;
    this.noteLen = 'grid';
    this.newVel = 100;
    this.tool = 'draw';
    this.pxPerQuarter = 96;
    this.sel = new Set();
    this.work = null; // notes being edited during a drag
    this.box = null;
    this.active = false;
    this.lastLen = null;
    this.quant = { grid: PPQ / 4, strength: 100, swing: 0, ends: false };
    this.build();
  }

  // ---------- data helpers ----------
  get found() { return this.clipId ? this.store.findClip(this.clipId) : null; }
  get clip() { return this.found?.clip || null; }
  get track() { return this.found?.track || null; }
  get notes() { return this.work || this.clip?.notes || []; }
  get ppt() { return this.pxPerQuarter / PPQ; }
  get meter() { return new MeterMap(this.store.project.meters); }

  open(clipId) {
    this.clipId = clipId;
    this.sel.clear();
    const c = this.clip;
    if (c) {
      ensureNoteIds(c);
      // scroll to the notes (or middle C)
      requestAnimationFrame(() => {
        const ps = c.notes.map((n) => n.p);
        const center = ps.length ? (Math.max(...ps) + Math.min(...ps)) / 2 : 60;
        this.scroll.scrollTop = Math.max(0, (127 - center) * ROW_H - this.scroll.clientHeight / 2);
        this.scroll.scrollLeft = 0;
        this.draw();
      });
    }
    this.refresh();
  }

  // ---------- DOM ----------
  build() {
    const gridSel = h('select', { title: 'Grid / snap', onchange: (e) => { this.grid = e.target.value === 'off' ? 'off' : +e.target.value; this.draw(); e.target.blur(); } },
      NOTE_GRIDS.map((g) => h('option', { value: String(g.value), selected: g.value === this.grid }, g.label)));
    const lenSel = h('select', { title: 'Length of new notes', onchange: (e) => { this.noteLen = e.target.value === 'grid' ? 'grid' : e.target.value === 'last' ? 'last' : +e.target.value; e.target.blur(); } },
      h('option', { value: 'grid' }, '= Grid'), h('option', { value: 'last' }, 'Last used'),
      NOTE_GRIDS.filter((g) => g.value !== 'off').map((g) => h('option', { value: String(g.value) }, g.label)));
    const velIn = h('input', { type: 'number', min: 1, max: 127, value: this.newVel, title: 'Velocity of new notes', onchange: (e) => { this.newVel = Math.max(1, Math.min(127, +e.target.value || 100)); e.target.value = this.newVel; } });
    velIn.addEventListener('keydown', (e) => e.stopPropagation());
    this.toolBtns = {
      draw: h('button', { class: 'pbtn', title: 'Draw: click to add notes', onclick: () => this.setTool('draw') }, '✎ Draw'),
      select: h('button', { class: 'pbtn', title: 'Select: drag a box around notes', onclick: () => this.setTool('select') }, '⬚ Select'),
    };
    this.title = h('div', { class: 'pr-title' });
    const toolbar = h('div', { class: 'pr-toolbar' },
      this.title,
      h('div', { class: 'pgroup' }, this.toolBtns.draw, this.toolBtns.select),
      h('label', { class: 'pfield' }, 'Grid', gridSel),
      h('label', { class: 'pfield' }, 'Length', lenSel),
      h('label', { class: 'pfield' }, 'Velocity', velIn),
      h('div', { class: 'pgroup' },
        h('button', { class: 'pbtn accent', title: 'Quantize the selected notes (or all notes) — Q', onclick: () => this.quantizeDialog() }, 'Quantize…'),
        h('button', { class: 'pbtn', title: 'Transpose down a semitone (↓, Shift = octave)', onclick: () => this.transpose(-1) }, '♭'),
        h('button', { class: 'pbtn', title: 'Transpose up a semitone (↑, Shift = octave)', onclick: () => this.transpose(1) }, '♯'),
        h('button', { class: 'pbtn', title: 'Select all (Ctrl+A)', onclick: () => this.selectAll() }, 'All'),
        h('button', { class: 'pbtn', title: 'Delete selected notes (Del)', onclick: () => this.deleteSelected() }, 'Delete')),
      h('div', { class: 'spacer' }),
      h('div', { class: 'pgroup' },
        h('button', { class: 'pbtn', title: 'Zoom out (Ctrl + scroll)', onclick: () => this.zoom(1 / 1.25) }, '−'),
        h('button', { class: 'pbtn', title: 'Zoom in (Ctrl + scroll)', onclick: () => this.zoom(1.25) }, '+')));

    this.rulerCanvas = h('canvas', { class: 'pr-ruler' });
    this.keysCanvas = h('canvas', { class: 'pr-keys' });
    this.gridCanvas = h('canvas', { class: 'pr-grid' });
    this.spacer = h('div', { class: 'pr-spacer' }, this.gridCanvas);
    this.scroll = h('div', { class: 'pr-scroll' }, this.spacer);
    this.velCanvas = h('canvas', { class: 'pr-vel' });
    this.empty = h('div', { class: 'pr-empty' }, 'Double-click a clip in the timeline to edit its notes here. (Double-click an empty spot in a lane to make a new clip.)');
    this.body = h('div', { class: 'pr-body' },
      h('div', { class: 'pr-corner' }),
      h('div', { class: 'pr-ruler-wrap' }, this.rulerCanvas),
      h('div', { class: 'pr-keys-wrap' }, this.keysCanvas),
      this.scroll,
      h('div', { class: 'pr-vel-label' }, 'Velocity'),
      h('div', { class: 'pr-vel-wrap' }, this.velCanvas));
    this.root.append(h('div', { class: 'pr' }, toolbar, this.body, this.empty));
    this.setTool('draw');

    this.scroll.addEventListener('scroll', () => this.draw());
    this.scroll.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      this.zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX);
    }, { passive: false });
    new ResizeObserver(() => this.draw()).observe(this.scroll);
    this.root.addEventListener('pointerdown', () => { this.active = true; }, true);
    this.bindGrid();
    this.bindKeys();
    this.bindVelocity();
  }

  setTool(t) {
    this.tool = t;
    for (const [k, b] of Object.entries(this.toolBtns)) b.classList.toggle('active', k === t);
  }

  refresh() {
    const c = this.clip;
    this.empty.hidden = !!c;
    this.body.style.visibility = c ? 'visible' : 'hidden';
    if (!c) { this.title.textContent = 'Piano Roll'; return; }
    ensureNoteIds(c);
    for (const id of [...this.sel]) if (!c.notes.some((n) => n.id === id)) this.sel.delete(id);
    const bar = Math.floor(this.meter.tickToBar(c.start)) + 1;
    this.title.innerHTML = '';
    this.title.append(h('span', { class: 'dot', style: { background: colorForTrack(this.track) } }), h('b', {}, this.track.name), h('small', {}, ` · clip at bar ${bar} · ${c.notes.length} notes`));
    this.draw();
  }

  zoom(f, clientX) {
    const rect = this.scroll.getBoundingClientRect();
    const xIn = clientX != null ? clientX - rect.left : this.scroll.clientWidth / 2;
    const tick = (this.scroll.scrollLeft + xIn) / this.ppt;
    this.pxPerQuarter = Math.max(12, Math.min(800, this.pxPerQuarter * f));
    this.draw();
    this.scroll.scrollLeft = Math.max(0, tick * this.ppt - xIn);
    this.draw();
  }

  contentTicks() {
    const c = this.clip;
    if (!c) return PPQ * 16;
    let end = c.length;
    for (const n of this.notes) end = Math.max(end, n.t + n.d);
    return end + PPQ * 16;
  }

  // ---------- drawing ----------
  draw() {
    const c = this.clip;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const W = this.scroll.clientWidth;
    const H = this.scroll.clientHeight;
    if (!W || !H) return;
    const x0 = this.scroll.scrollLeft;
    const y0 = this.scroll.scrollTop;
    const ppt = this.ppt;
    const totalW = Math.ceil(this.contentTicks() * ppt);
    this.spacer.style.width = `${totalW}px`;
    this.spacer.style.height = `${128 * ROW_H}px`;
    const m = this.meter;
    const color = colorForTrack(this.track);

    // grid canvas
    const g = setup(this.gridCanvas, W, H, dpr);
    this.gridCanvas.style.left = `${x0}px`;
    this.gridCanvas.style.top = `${y0}px`;
    const firstRow = Math.floor(y0 / ROW_H);
    const lastRow = Math.ceil((y0 + H) / ROW_H);
    for (let r = firstRow; r <= lastRow && r < 128; r++) {
      const p = 127 - r;
      const y = r * ROW_H - y0;
      g.fillStyle = BLACK.has(p % 12) ? '#15181d' : '#1b1f26';
      g.fillRect(0, y, W, ROW_H);
      g.fillStyle = p % 12 === 0 ? '#323a47' : '#20252d';
      g.fillRect(0, y + ROW_H - 1, W, 1);
    }
    // time lines
    const t0 = x0 / ppt;
    const t1 = (x0 + W) / ppt;
    this.drawTimeLines(g, m, c.start, t0, t1, x0, ppt, H, true);
    // area past the clip end
    const endX = c.length * ppt - x0;
    if (endX < W) {
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(Math.max(0, endX), 0, W, H);
      g.fillStyle = color;
      g.fillRect(endX - 1, 0, 2, H);
    }
    // notes
    const notes = this.notes;
    g.font = '10px system-ui, sans-serif';
    g.textBaseline = 'middle';
    for (const n of notes) {
      const x = n.t * ppt - x0;
      const w = Math.max(3, n.d * ppt);
      const y = (127 - n.p) * ROW_H - y0;
      if (x > W || x + w < 0 || y > H || y + ROW_H < 0) continue;
      const sel = this.sel.has(n.id);
      const a = 0.45 + 0.55 * (n.v / 127);
      g.fillStyle = sel ? shade(color, 1.45) : shade(color, 0.55 + 0.6 * a);
      g.fillRect(x + 0.5, y + 1, w - 1, ROW_H - 2);
      g.strokeStyle = sel ? '#ffffff' : 'rgba(0,0,0,0.55)';
      g.lineWidth = sel ? 1.5 : 1;
      g.strokeRect(x + 0.5, y + 1, w - 1, ROW_H - 2);
      if (w > 30) {
        g.fillStyle = 'rgba(0,0,0,0.75)';
        g.fillText(noteName(n.p), x + 4, y + ROW_H / 2 + 0.5);
      }
    }
    // playhead
    const ph = (this.engine.currentTick() - c.start) * ppt - x0;
    if (ph >= 0 && ph <= W) { g.fillStyle = '#ff7a2f'; g.fillRect(ph, 0, 2, H); }
    // selection box
    if (this.box) {
      const bx = Math.min(this.box.x1, this.box.x2) - x0;
      const by = Math.min(this.box.y1, this.box.y2) - y0;
      g.fillStyle = 'rgba(79,140,255,0.15)';
      g.strokeStyle = '#4f8cff';
      g.fillRect(bx, by, Math.abs(this.box.x2 - this.box.x1), Math.abs(this.box.y2 - this.box.y1));
      g.strokeRect(bx + 0.5, by + 0.5, Math.abs(this.box.x2 - this.box.x1), Math.abs(this.box.y2 - this.box.y1));
    }

    // ruler
    const r = setup(this.rulerCanvas, W, RULER_H, dpr);
    r.fillStyle = '#181b21'; r.fillRect(0, 0, W, RULER_H);
    this.drawTimeLines(r, m, c.start, t0, t1, x0, ppt, RULER_H, false);
    if (endX < W) { r.fillStyle = 'rgba(0,0,0,0.35)'; r.fillRect(Math.max(0, endX), 0, W, RULER_H); }

    // keys
    const k = setup(this.keysCanvas, KEYS_W, H, dpr);
    k.font = '10px system-ui, sans-serif';
    k.textBaseline = 'middle';
    for (let row = firstRow; row <= lastRow && row < 128; row++) {
      const p = 127 - row;
      const y = row * ROW_H - y0;
      const black = BLACK.has(p % 12);
      const lit = this.litKey === p;
      k.fillStyle = lit ? '#ff7a2f' : black ? '#22262d' : '#d9dde4';
      k.fillRect(0, y, KEYS_W, ROW_H);
      if (black && !lit) { k.fillStyle = '#d9dde4'; k.fillRect(KEYS_W - 16, y, 16, ROW_H); k.fillStyle = '#22262d'; k.fillRect(0, y + 1, KEYS_W - 16, ROW_H - 2); }
      k.fillStyle = 'rgba(0,0,0,0.25)'; k.fillRect(0, y + ROW_H - 1, KEYS_W, 1);
      if (p % 12 === 0) { k.fillStyle = '#333'; k.fillText(noteName(p), 4, y + ROW_H / 2); }
    }

    // velocity lane
    const v = setup(this.velCanvas, W, VEL_H, dpr);
    v.fillStyle = '#14171c'; v.fillRect(0, 0, W, VEL_H);
    v.fillStyle = '#20252d';
    for (const f of [0.25, 0.5, 0.75]) v.fillRect(0, Math.round(VEL_H * f), W, 1);
    for (const n of notes) {
      const x = n.t * ppt - x0;
      if (x < -6 || x > W + 6) continue;
      const hgt = (n.v / 127) * (VEL_H - 6);
      const sel = this.sel.has(n.id);
      v.fillStyle = sel ? '#ffffff' : shade(color, 1.1);
      v.fillRect(x, VEL_H - hgt, 3, hgt);
      v.beginPath(); v.arc(x + 1.5, VEL_H - hgt, 3, 0, Math.PI * 2); v.fill();
    }
  }

  drawTimeLines(g, m, clipStart, t0, t1, x0, ppt, H, full) {
    const abs0 = clipStart + Math.max(0, t0);
    const abs1 = clipStart + t1;
    let bar = Math.max(0, Math.floor(m.tickToBar(abs0)));
    g.font = '11px system-ui, sans-serif';
    g.textBaseline = 'middle';
    for (let guard = 0; guard < 2000; guard++, bar++) {
      const seg = m.meterAtBar(bar);
      const bs = m.barToTick(bar);
      if (bs > abs1) break;
      const bx = (bs - clipStart) * ppt - x0;
      // fine grid
      if (full && this.grid !== 'off' && this.grid * ppt >= 5) {
        g.fillStyle = 'rgba(255,255,255,0.035)';
        for (let t = this.grid; t < seg.barTicks - 1; t += this.grid) g.fillRect(Math.round(bx + t * ppt), 0, 1, H);
      }
      if (seg.beatTicks * ppt >= 6) {
        g.fillStyle = full ? 'rgba(255,255,255,0.08)' : '#3a414e';
        for (let b = 1; b < seg.num; b++) {
          const x = Math.round(bx + b * seg.beatTicks * ppt);
          if (full) g.fillRect(x, 0, 1, H); else g.fillRect(x, H - 6, 1, 6);
        }
      }
      g.fillStyle = full ? 'rgba(255,255,255,0.2)' : '#5a6270';
      g.fillRect(Math.round(bx), 0, 1, H);
      if (!full) { g.fillStyle = '#c9ced8'; g.fillText(`${bar + 1}`, bx + 4, H / 2); }
    }
  }

  // ---------- hit testing ----------
  toContent(e) {
    const rect = this.scroll.getBoundingClientRect();
    return { x: e.clientX - rect.left + this.scroll.scrollLeft, y: e.clientY - rect.top + this.scroll.scrollTop };
  }

  noteAt(x, y) {
    const p = 127 - Math.floor(y / ROW_H);
    const t = x / this.ppt;
    const list = this.notes;
    for (let i = list.length - 1; i >= 0; i--) {
      const n = list[i];
      if (n.p === p && t >= n.t && t <= n.t + n.d) {
        const xEnd = (n.t + n.d) * this.ppt;
        const edge = xEnd - x <= Math.min(7, (n.d * this.ppt) / 3);
        return { note: n, edge };
      }
    }
    return null;
  }

  snapRel(t, mode = 'round') {
    const c = this.clip;
    if (this.grid === 'off') return Math.max(0, Math.round(t));
    return Math.max(0, this.meter.snap(c.start + t, this.grid, mode) - c.start);
  }

  gridLen() { return this.grid === 'off' ? PPQ / 4 : this.grid; }

  newNoteLen() {
    if (this.noteLen === 'grid') return this.gridLen();
    if (this.noteLen === 'last') return this.lastLen || this.gridLen();
    return this.noteLen;
  }

  // ---------- editing ----------
  beginWork() { this.work = this.clip.notes.map((n) => ({ ...n })); }

  commit(label) {
    const work = this.work;
    this.work = null;
    if (!work) return;
    const clipId = this.clipId;
    const meter = this.meter;
    this.store.mutate((p) => {
      for (const t of p.tracks) {
        const c = t.clips.find((x) => x.id === clipId);
        if (!c) continue;
        c.notes = work.filter((n) => n.d > 0).sort((a, b) => a.t - b.t || a.p - b.p);
        // grow the clip to fit notes drawn past its end
        const end = Math.max(0, ...c.notes.map((n) => n.t + n.d));
        if (end > c.length) {
          const endBar = Math.ceil(meter.tickToBar(c.start + end) - 1e-9);
          c.length = meter.barToTick(endBar) - c.start;
        }
      }
    });
    if (label) toast(label);
  }

  audition(p, v = 100) {
    if (!this.track) return;
    this.engine.preview(this.track.id, p, v, 0.3);
  }

  bindGrid() {
    const el = this.scroll;
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const { x, y } = this.toContent(e);
      const hit = this.noteAt(x, y);
      if (hit) { this.beginWork(); this.work = this.work.filter((n) => n.id !== hit.note.id); this.sel.delete(hit.note.id); this.commit(); }
    });
    el.addEventListener('dblclick', (e) => {
      const { x, y } = this.toContent(e);
      const hit = this.noteAt(x, y);
      if (hit && this.tool === 'draw') { this.beginWork(); this.work = this.work.filter((n) => n.id !== hit.note.id); this.sel.delete(hit.note.id); this.commit(); }
    });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.clip) return;
      // ignore clicks on the scrollbars
      if (e.offsetX > el.clientWidth || e.offsetY > el.clientHeight) return;
      const { x, y } = this.toContent(e);
      const hit = this.noteAt(x, y);
      const ppt = this.ppt;
      el.setPointerCapture(e.pointerId);
      let moveFn = null;

      if (hit) {
        const n = hit.note;
        if (e.shiftKey) { if (this.sel.has(n.id)) this.sel.delete(n.id); else this.sel.add(n.id); }
        else if (!this.sel.has(n.id)) { this.sel.clear(); this.sel.add(n.id); }
        this.beginWork();
        const ids = new Set(this.sel);
        const orig = new Map(this.work.filter((w) => ids.has(w.id)).map((w) => [w.id, { ...w }]));
        const anchor = orig.get(n.id) || { ...n };
        if (!hit.edge) this.audition(n.p, n.v);
        let lastPitch = n.p;
        if (hit.edge) {
          moveFn = (ev) => {
            const cx = this.toContent(ev).x;
            const endT = ev.altKey ? cx / ppt : this.snapRel(cx / ppt);
            const delta = endT - (anchor.t + anchor.d);
            for (const w of this.work) {
              const o = orig.get(w.id);
              if (o) w.d = Math.max(this.grid === 'off' || ev.altKey ? 15 : Math.min(this.gridLen(), o.d), o.d + delta);
            }
            this.lastLen = this.work.find((w) => w.id === n.id)?.d;
          };
        } else {
          moveFn = (ev) => {
            const c2 = this.toContent(ev);
            const dt = (c2.x - x) / ppt;
            let newStart = ev.altKey ? anchor.t + dt : this.snapRel(anchor.t + dt);
            const minT = Math.min(...[...orig.values()].map((o) => o.t));
            let shift = newStart - anchor.t;
            if (minT + shift < 0) shift = -minT;
            const dp = Math.round((y - c2.y) / ROW_H);
            for (const w of this.work) {
              const o = orig.get(w.id);
              if (o) { w.t = Math.max(0, o.t + shift); w.p = Math.max(0, Math.min(127, o.p + dp)); }
            }
            const np = Math.max(0, Math.min(127, anchor.p + dp));
            if (np !== lastPitch) { lastPitch = np; this.audition(np, n.v); }
          };
        }
      } else if (this.tool === 'select' || e.shiftKey) {
        if (!e.shiftKey) this.sel.clear();
        const before = new Set(this.sel);
        this.box = { x1: x, y1: y, x2: x, y2: y };
        moveFn = (ev) => {
          const c2 = this.toContent(ev);
          this.box.x2 = c2.x; this.box.y2 = c2.y;
          const tx1 = Math.min(x, c2.x) / ppt; const tx2 = Math.max(x, c2.x) / ppt;
          const pHi = 127 - Math.floor(Math.min(y, c2.y) / ROW_H);
          const pLo = 127 - Math.floor(Math.max(y, c2.y) / ROW_H);
          this.sel = new Set(before);
          for (const n of this.clip.notes) if (n.t + n.d >= tx1 && n.t <= tx2 && n.p >= pLo && n.p <= pHi) this.sel.add(n.id);
        };
      } else {
        // draw a new note
        const p = 127 - Math.floor(y / ROW_H);
        if (p < 0 || p > 127) return;
        const t = this.snapRel(x / ppt, 'floor');
        const len = this.newNoteLen();
        this.beginWork();
        const n = { id: newId(), t, d: len, p, v: this.newVel };
        this.work.push(n);
        this.sel.clear(); this.sel.add(n.id);
        this.audition(p, this.newVel);
        moveFn = (ev) => {
          const cx = this.toContent(ev).x;
          if (cx - x < 4) return;
          const endT = this.snapRel(cx / ppt, 'round');
          n.d = Math.max(this.grid === 'off' ? 15 : this.gridLen(), endT - t);
          this.lastLen = n.d;
        };
      }
      this.draw();
      const onMove = (ev) => { moveFn?.(ev); this.draw(); };
      const onUp = () => {
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onUp);
        if (this.box) { this.box = null; this.draw(); return; }
        // skip committing a click that changed nothing
        if (this.work && JSON.stringify(this.work) === JSON.stringify(this.clip.notes)) { this.work = null; this.draw(); return; }
        this.commit();
      };
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
    });
    el.addEventListener('pointermove', (e) => {
      if (e.buttons) return;
      const { x, y } = this.toContent(e);
      const hit = this.noteAt(x, y);
      el.style.cursor = hit ? (hit.edge ? 'ew-resize' : 'grab') : this.tool === 'draw' ? 'crosshair' : 'default';
    });
  }

  bindKeys() {
    const c = this.keysCanvas;
    let held = null;
    const pitchAt = (e) => {
      const rect = c.getBoundingClientRect();
      return 127 - Math.floor((e.clientY - rect.top + this.scroll.scrollTop) / ROW_H);
    };
    const on = (p) => { held = p; this.litKey = p; if (this.track) this.engine.liveNoteOn(this.track.id, p, 100); this.draw(); };
    const off = () => { if (held != null && this.track) this.engine.liveNoteOff(this.track.id, held); held = null; this.litKey = null; this.draw(); };
    c.addEventListener('pointerdown', (e) => { c.setPointerCapture(e.pointerId); on(pitchAt(e)); });
    c.addEventListener('pointermove', (e) => { if (held == null) return; const p = pitchAt(e); if (p !== held) { off(); on(p); } });
    c.addEventListener('pointerup', off);
    c.addEventListener('pointercancel', off);
    c.addEventListener('wheel', (e) => { this.scroll.scrollTop += e.deltaY; e.preventDefault(); }, { passive: false });
  }

  bindVelocity() {
    const c = this.velCanvas;
    c.addEventListener('pointerdown', (e) => {
      if (!this.clip) return;
      c.setPointerCapture(e.pointerId);
      this.beginWork();
      const rect = c.getBoundingClientRect();
      const onlySel = this.sel.size > 0;
      let lastX = e.clientX - rect.left;
      const apply = (ev) => {
        const x = ev.clientX - rect.left;
        const y = ev.clientY - rect.top;
        const v = Math.max(1, Math.min(127, Math.round((1 - (y - 3) / (VEL_H - 6)) * 127)));
        const a = Math.min(lastX, x) - 4; const b = Math.max(lastX, x) + 4;
        for (const n of this.work) {
          if (onlySel && !this.sel.has(n.id)) continue;
          const nx = n.t * this.ppt - this.scroll.scrollLeft;
          if (nx >= a && nx <= b) n.v = v;
        }
        lastX = x;
        this.draw();
      };
      apply(e);
      const move = (ev) => apply(ev);
      const up = () => { c.removeEventListener('pointermove', move); c.removeEventListener('pointerup', up); this.commit(); };
      c.addEventListener('pointermove', move);
      c.addEventListener('pointerup', up);
    });
  }

  // ---------- commands ----------
  targets() {
    const notes = this.work || this.clip.notes;
    return this.sel.size ? notes.filter((n) => this.sel.has(n.id)) : notes;
  }

  selectAll() { if (!this.clip) return; this.sel = new Set(this.clip.notes.map((n) => n.id)); this.draw(); }

  deleteSelected() {
    if (!this.clip || !this.sel.size) return;
    this.beginWork();
    this.work = this.work.filter((n) => !this.sel.has(n.id));
    this.sel.clear();
    this.commit();
  }

  transpose(semis) {
    if (!this.clip) return;
    this.beginWork();
    for (const n of this.targets()) n.p = Math.max(0, Math.min(127, n.p + semis));
    this.commit();
  }

  nudge(dir) {
    if (!this.clip || !this.sel.size) return;
    this.beginWork();
    const step = this.gridLen();
    const tg = this.targets();
    const minT = Math.min(...tg.map((n) => n.t));
    const shift = dir < 0 ? -Math.min(step, minT) : step;
    for (const n of tg) n.t += shift;
    this.commit();
  }

  duplicate() {
    if (!this.clip || !this.sel.size) return;
    this.beginWork();
    const tg = this.targets();
    const start = Math.min(...tg.map((n) => n.t));
    const end = Math.max(...tg.map((n) => n.t + n.d));
    const span = this.snapRel(end - start) || this.gridLen();
    const copies = tg.map((n) => ({ ...n, id: newId(), t: n.t + span }));
    this.work.push(...copies);
    this.sel = new Set(copies.map((n) => n.id));
    this.commit();
  }

  copy() {
    if (!this.clip || !this.sel.size) return;
    const tg = this.clip.notes.filter((n) => this.sel.has(n.id));
    const start = Math.min(...tg.map((n) => n.t));
    this.clipboard = tg.map((n) => ({ ...n, t: n.t - start }));
    toast(`Copied ${tg.length} note${tg.length === 1 ? '' : 's'}.`);
  }

  paste() {
    if (!this.clip || !this.clipboard?.length) return;
    // paste at the playhead if it's inside this clip, otherwise right after the selection
    const c = this.clip;
    let at = this.engine.currentTick() - c.start;
    if (at < 0 || at > c.length) {
      const sel = c.notes.filter((n) => this.sel.has(n.id));
      at = sel.length ? Math.max(...sel.map((n) => n.t + n.d)) : 0;
    }
    at = this.snapRel(at);
    this.beginWork();
    const copies = this.clipboard.map((n) => ({ ...n, id: newId(), t: n.t + at }));
    this.work.push(...copies);
    this.sel = new Set(copies.map((n) => n.id));
    this.commit();
  }

  quantize({ grid, strength, swing, ends }) {
    if (!this.clip) return;
    const c = this.clip;
    const m = this.meter;
    this.beginWork();
    const tg = this.targets();
    const s = strength / 100;
    for (const n of tg) {
      const abs = c.start + n.t;
      let target = m.snap(abs, grid);
      if (swing && m.gridIndexInBar(target, grid) % 2 === 1) target += (swing / 100) * (grid / 3);
      const oldEnd = n.t + n.d;
      const newT = Math.max(0, n.t + (target - c.start - n.t) * s);
      n.t = Math.round(newT);
      if (ends) {
        const endTarget = m.snap(c.start + oldEnd, grid) - c.start;
        const newEnd = oldEnd + (endTarget - oldEnd) * s;
        n.d = Math.max(Math.round(grid / 4), Math.round(newEnd - n.t));
      }
      // without "note ends", notes keep their length and just move
    }
    this.commit(`Quantized ${tg.length} note${tg.length === 1 ? '' : 's'}.`);
  }

  quantizeDialog() {
    if (!this.clip) return;
    const q = this.quant;
    const gridSel = h('select', {}, NOTE_GRIDS.filter((g) => g.value !== 'off').map((g) => h('option', { value: String(g.value), selected: Math.abs(g.value - q.grid) < 0.01 }, g.label)));
    const str = h('input', { type: 'range', min: 0, max: 100, step: 1, value: q.strength });
    const strL = h('span', { class: 'qv' }, `${q.strength}%`);
    str.oninput = () => { strL.textContent = `${str.value}%`; };
    const sw = h('input', { type: 'range', min: 0, max: 100, step: 1, value: q.swing });
    const swL = h('span', { class: 'qv' }, `${q.swing}%`);
    sw.oninput = () => { swL.textContent = `${sw.value}%`; };
    const ends = h('input', { type: 'checkbox', checked: q.ends });
    const count = this.sel.size || this.clip.notes.length;
    openModal({
      title: `Quantize ${this.sel.size ? `${count} selected` : `all ${count}`} note${count === 1 ? '' : 's'}`,
      body: h('div', {},
        h('label', { class: 'row' }, h('span', {}, 'Grid'), gridSel),
        h('label', { class: 'row' }, h('span', {}, 'Strength'), str, strL),
        h('label', { class: 'row' }, h('span', {}, 'Swing'), sw, swL),
        h('label', { class: 'row' }, h('span', {}, 'Note ends'), h('span', { class: 'chk' }, ends, ' also snap note lengths')),
        h('div', { class: 'hint' }, 'Strength below 100% moves notes only part of the way to the grid, keeping some human feel. Swing delays every second grid step (100% = triplet shuffle). Press Q to quantize again with these settings.')),
      buttons: [{ label: 'Cancel' }, {
        label: 'Quantize', kind: 'primary',
        onClick: () => {
          this.quant = { grid: +gridSel.value, strength: +str.value, swing: +sw.value, ends: ends.checked };
          this.quantize(this.quant);
        },
      }],
    });
  }

  /** Keyboard shortcuts while the piano roll is in use. Returns true when handled. */
  handleKey(e) {
    if (!this.clip || !this.active) return false;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.code === 'KeyA') { this.selectAll(); return true; }
    if (ctrl && e.code === 'KeyC') { this.copy(); return true; }
    if (ctrl && e.code === 'KeyV') { this.paste(); return true; }
    if (ctrl && e.code === 'KeyD') { this.duplicate(); return true; }
    if (ctrl) return false;
    if (e.code === 'Delete' || e.code === 'Backspace') { this.deleteSelected(); return true; }
    if (e.code === 'ArrowUp') { this.transpose(e.shiftKey ? 12 : 1); return true; }
    if (e.code === 'ArrowDown') { this.transpose(e.shiftKey ? -12 : -1); return true; }
    if (e.code === 'ArrowLeft') { this.nudge(-1); return true; }
    if (e.code === 'ArrowRight') { this.nudge(1); return true; }
    if (e.code === 'KeyQ') { this.quantize(this.quant); return true; }
    if (e.code === 'Escape') { this.sel.clear(); this.draw(); return true; }
    return false;
  }
}

function setup(canvas, w, hgt, dpr) {
  const W = Math.max(1, Math.floor(w * dpr));
  const H = Math.max(1, Math.floor(hgt * dpr));
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${hgt}px`;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, hgt);
  return g;
}
