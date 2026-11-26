// Chords tab: an omnichord-style chord pad. Chord buttons (major / minor / 7th on every root, the song's
// key highlighted), number keys 1–7 for the chords in the key, and a strum plate you sweep with the mouse.
// Everything plays on the selected instrument or sampler track, and records like the keyboard does.
import { h } from './dom.js';
import { noteName } from '../timing.js';

export const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const QUAL = {
  maj: { iv: [0, 4, 7], suffix: '' },
  min: { iv: [0, 3, 7], suffix: 'm' },
  dom7: { iv: [0, 4, 7, 10], suffix: '7' },
  dim: { iv: [0, 3, 6], suffix: '°' },
  maj7: { iv: [0, 4, 7, 11], suffix: 'maj7' },
  min7: { iv: [0, 3, 7, 10], suffix: 'm7' },
};
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10];
const MAJOR_Q = ['maj', 'min', 'min', 'maj', 'maj', 'min', 'dim'];
const MINOR_Q = ['min', 'dim', 'maj', 'min', 'min', 'maj', 'maj'];
const MAJOR_RN = ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'];
const MINOR_RN = ['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII'];

export function songKey(p) { return { tonic: p.key?.tonic ?? 0, mode: p.key?.mode || 'major' }; }
export function keyName(k) { return `${NOTE_NAMES[k.tonic]} ${k.mode === 'minor' ? 'minor' : 'major'}`; }

/** The 7 chords of a key: [{ root (0..11), q, rn }] */
export function diatonic(k) {
  const steps = k.mode === 'minor' ? MINOR_STEPS : MAJOR_STEPS;
  const qs = k.mode === 'minor' ? MINOR_Q : MAJOR_Q;
  const rns = k.mode === 'minor' ? MINOR_RN : MAJOR_RN;
  return steps.map((s, i) => ({ root: (k.tonic + s) % 12, q: qs[i], rn: rns[i] }));
}

export function chordName(root, q) { return NOTE_NAMES[root] + QUAL[q].suffix; }

/** MIDI notes for a chord: root in the octave around `low`, close voicing, optional bass note. */
export function voicing(root, q, low = 52, bass = true) {
  let r = low - ((low - root) % 12 + 12) % 12; // root at or below `low`
  if (r < low - 6) r += 12;
  const notes = QUAL[q].iv.map((iv) => r + iv);
  if (bass) notes.unshift(r - 12);
  return notes;
}

export class ChordPad {
  constructor({ store, engine, root, liveTrack }) {
    this.store = store;
    this.engine = engine;
    this.root = root;
    this.liveTrack = liveTrack;
    this.current = null; // { root, q, notes, trackId }
    this.strumNotes = [];
    this.ringing = new Set(); // strum notes still sounding
    this.held = new Map(); // key code -> chord
  }

  get opts() {
    const u = this.store.ui;
    u.chordOpts ||= { showAll: false, bass: true, low: 52, mode: 'hold' };
    return u.chordOpts;
  }

  chordsList() {
    const k = songKey(this.store.project);
    return diatonic(k);
  }

  /** Start a chord (stops the previous one). `how` = hold | strum | both */
  play(root, q) {
    const id = this.liveTrack();
    if (!id) { this.flash('Select an instrument or sampler track to play chords.'); return; }
    this.stop();
    const o = this.opts;
    const notes = voicing(root, q, o.low, o.bass);
    this.current = { root, q, notes, trackId: id };
    // the strum plate covers this chord's notes across about three octaves
    this.strumNotes = [];
    const base = voicing(root, q, o.low, false);
    for (let oct = 0; oct < 4; oct++) for (const n of base) this.strumNotes.push(n + 12 * oct - 12);
    this.strumNotes = this.strumNotes.filter((n) => n >= 36 && n <= 96).sort((a, b) => a - b).slice(0, 14);
    if (o.mode !== 'strum') {
      for (const n of notes) this.engine.liveNoteOn(id, n, this.store.ui.kbVelocity);
    } else {
      notes.forEach((n, i) => setTimeout(() => { if (this.current?.notes === notes) this.engine.liveNoteOn(id, n, this.store.ui.kbVelocity); }, i * 35));
    }
    this.renderState();
  }

  stop() {
    const c = this.current;
    if (!c) return;
    for (const n of c.notes) this.engine.liveNoteOff(c.trackId, n);
    this.current = null;
    this.renderState();
  }

  pluck(i) {
    const id = this.current?.trackId || this.liveTrack();
    const n = this.strumNotes[i];
    if (!id || n == null) return;
    this.engine.liveNoteOn(id, n, Math.min(127, this.store.ui.kbVelocity + 5));
    // plucks ring briefly then let go, like the omnichord's strum plate
    clearTimeout(this['ring' + n]);
    this['ring' + n] = setTimeout(() => this.engine.liveNoteOff(id, n), 900);
    const cell = this.plate?.children[i];
    if (cell) { cell.classList.add('hit'); setTimeout(() => cell.classList.remove('hit'), 120); }
  }

  flash(msg) { if (this.msgEl) { this.msgEl.textContent = msg; this.msgEl.classList.add('warn'); } }

  /** Number keys 1–7 (Shift = 7th chord) while the Chords tab is open. Returns true if handled. */
  handleKey(e, down) {
    const m = /^Digit([1-7])$/.exec(e.code);
    if (!m) return false;
    e.preventDefault();
    if (down) {
      if (e.repeat || this.held.has(e.code)) return true;
      const c = this.chordsList()[+m[1] - 1];
      const q = e.shiftKey ? (c.q === 'maj' ? 'dom7' : c.q === 'min' ? 'min7' : c.q) : c.q;
      this.held.set(e.code, true);
      this.play(c.root, q);
    } else {
      this.held.delete(e.code);
      if (!this.held.size && this.opts.mode !== 'latch') this.stop();
    }
    return true;
  }

  renderState() {
    if (!this.root.isConnected) return;
    this.root.querySelectorAll('.ochord').forEach((b) => b.classList.toggle('on', !!this.current && +b.dataset.root === this.current.root && b.dataset.q === this.current.q));
    if (this.plate) {
      [...this.plate.children].forEach((cell, i) => { cell.dataset.note = this.strumNotes[i] != null ? noteName(this.strumNotes[i]) : ''; });
      this.plate.classList.toggle('armed', !!this.current);
    }
    if (this.nowEl) this.nowEl.textContent = this.current ? chordName(this.current.root, this.current.q) : '—';
  }

  render() {
    const p = this.store.project;
    const k = songKey(p);
    const o = this.opts;
    this.root.innerHTML = '';
    const setKey = (patch) => this.store.mutate((pp) => { pp.key = { ...songKey(pp), ...patch }; });
    const tonicSel = h('select', { onchange: (e) => setKey({ tonic: +e.target.value }) }, NOTE_NAMES.map((n, i) => h('option', { value: i, selected: i === k.tonic }, n)));
    const modeSel = h('select', { onchange: (e) => setKey({ mode: e.target.value }) },
      h('option', { value: 'major', selected: k.mode === 'major' }, 'major'), h('option', { value: 'minor', selected: k.mode === 'minor' }, 'minor'));
    const chk = (key, label, title) => h('label', { class: 'field', title }, h('input', { type: 'checkbox', checked: !!o[key], onchange: (e) => { o[key] = e.target.checked; this.render(); } }), h('span', {}, label));
    const modeSel2 = h('select', { title: 'Hold: the chord sounds while you hold the button. Latch: it keeps sounding until you pick another chord (or click Stop). Strum: notes roll in quickly.', onchange: (e) => { o.mode = e.target.value; } },
      [['hold', 'Hold'], ['latch', 'Latch'], ['strum', 'Strum in']].map(([v, l]) => h('option', { value: v, selected: o.mode === v }, l)));
    const rangeSel = h('select', { title: 'How high the chords sit', onchange: (e) => { o.low = +e.target.value; } },
      [[40, 'Low'], [52, 'Middle'], [60, 'High']].map(([v, l]) => h('option', { value: v, selected: o.low === v }, l)));
    this.nowEl = h('b', { class: 'ochord-now' }, '—');
    this.msgEl = h('span', { class: 'muted' }, this.liveTrack() ? `playing ${this.store.track(this.liveTrack())?.name}` : 'select an instrument track to play');
    const head = h('div', { class: 'okb-head' },
      h('label', { class: 'field' }, h('span', {}, 'Key'), tonicSel, modeSel),
      h('label', { class: 'field' }, h('span', {}, 'Play'), modeSel2),
      h('label', { class: 'field' }, h('span', {}, 'Range'), rangeSel),
      chk('bass', 'Bass note', 'Add the root an octave below'),
      chk('showAll', 'All chords', 'Show every major, minor and 7th chord (the song’s key is highlighted)'),
      h('button', { class: 'pbtn', onclick: () => this.stop() }, '■ Stop'),
      h('span', { class: 'muted' }, 'Now:'), this.nowEl, this.msgEl);

    const btn = (root, q, label, sub, inKey, keyHint) => {
      const b = h('button', {
        class: `ochord ${inKey ? 'inkey' : ''}`, 'data-root': root, 'data-q': q,
        title: `${chordName(root, q)}${keyHint ? ` — key ${keyHint}${q === 'maj' || q === 'min' ? ` (Shift+${keyHint} = 7th)` : ''}` : ''}`,
      }, h('b', {}, label), sub ? h('small', {}, sub) : null, keyHint ? h('kbd', {}, keyHint) : null);
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); this.play(root, q); });
      const up = () => { if (o.mode !== 'latch' && this.current?.root === root && this.current?.q === q) this.stop(); };
      b.addEventListener('pointerup', up);
      b.addEventListener('pointerleave', (e) => { if (e.buttons) up(); });
      return b;
    };

    const dia = diatonic(k);
    const inKey = new Set(dia.map((c) => `${c.root}:${c.q}`));
    const keyRow = h('div', { class: 'ochord-row key' }, dia.map((c, i) => btn(c.root, c.q, chordName(c.root, c.q), c.rn, true, String(i + 1))));
    const grid = h('div', { class: 'ochord-grid' });
    if (o.showAll) {
      // circle-of-fifths order with the key's tonic in the middle, like an omnichord's button rows
      const order = [];
      for (let i = -5; i <= 6; i++) order.push(((k.tonic + 7 * i) % 12 + 12) % 12);
      for (const [q, label] of [['maj', 'Major'], ['min', 'Minor'], ['dom7', '7th']]) {
        grid.append(h('div', { class: 'ochord-row' }, h('span', { class: 'ochord-label' }, label),
          order.map((r) => btn(r, q, chordName(r, q), null, inKey.has(`${r}:${q}`)))));
      }
    }

    // strum plate
    this.plate = h('div', { class: 'strum', title: 'Strum plate: pick a chord, then sweep across here with the mouse button held down' });
    for (let i = 0; i < 14; i++) this.plate.append(h('div', { class: 'scell', 'data-i': i }));
    let last = -1;
    let strumming = false;
    const at = (e) => { const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('.scell'); return el && this.plate.contains(el) ? +el.dataset.i : -1; };
    this.plate.addEventListener('pointerdown', (e) => { strumming = true; this.plate.setPointerCapture(e.pointerId); last = at(e); if (last >= 0) this.pluck(last); });
    this.plate.addEventListener('pointermove', (e) => {
      if (!strumming) return;
      const i = at(e);
      if (i < 0 || i === last) return;
      // sweeping fast skips cells — play everything in between
      const dir = i > last ? 1 : -1;
      for (let j = last < 0 ? i : last + dir; j !== i + dir; j += dir) this.pluck(j);
      last = i;
    });
    const end = () => { strumming = false; last = -1; };
    this.plate.addEventListener('pointerup', end);
    this.plate.addEventListener('pointercancel', end);

    this.root.append(head,
      h('div', { class: 'ochord-body' },
        h('div', { class: 'ochord-left' }, h('div', { class: 'section-label' }, `Chords in ${keyName(k)} — keys 1–7, Shift for 7ths`), keyRow, grid),
        h('div', { class: 'ochord-right' }, h('div', { class: 'section-label' }, 'Strum plate'), this.plate)));
    this.renderState();
  }
}
