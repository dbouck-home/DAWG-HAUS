// Bottom dock: Piano Roll, Instrument, Mixer and on-screen Keyboard tabs.
import { PRESETS, CATEGORY_COLORS, getPreset, paramDefs, paramValue, colorForTrack } from '../audio/presets.js';
import { KEYMAP } from '../midi.js';
import { KITS, getKit, PAD_PARAMS, padSetting } from '../audio/drums.js';
import { noteName } from '../timing.js';
import { h } from './dom.js';

export const DOCK_TABS = [
  { id: 'pianoroll', label: 'Editor' },
  { id: 'instrument', label: 'Instrument' },
  { id: 'mixer', label: 'Mixer' },
  { id: 'keyboard', label: 'Keyboard' },
];

export class Dock {
  constructor({ store, onChange }) {
    this.store = store;
    this.onChange = onChange;
    this.el = document.getElementById('dock');
    this.tabsEl = document.getElementById('dock-tabs');
    this.tabBtns = {};
    for (const t of DOCK_TABS) {
      const b = h('button', { class: 'dtab', onclick: () => this.show(t.id) }, t.label);
      this.tabBtns[t.id] = b;
      this.tabsEl.append(b);
    }
    this.tabsEl.append(h('div', { class: 'spacer' }), h('button', { class: 'dtab close', title: 'Hide panel', onclick: () => this.close() }, '✕'));
    // drag the top edge to resize
    const grip = document.getElementById('dock-resize');
    grip.addEventListener('pointerdown', (e) => {
      grip.setPointerCapture(e.pointerId);
      const startY = e.clientY;
      const startH = this.el.getBoundingClientRect().height;
      const move = (ev) => {
        const hgt = Math.max(180, Math.min(window.innerHeight - 220, startH + (startY - ev.clientY)));
        this.store.ui.dockHeight = hgt;
        this.el.style.height = `${hgt}px`;
      };
      const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); this.onChange?.('resize'); };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
    });
    this.apply();
  }

  get open() { return this.store.ui.dockOpen; }
  get tab() { return this.store.ui.dockTab; }

  show(tab) {
    this.store.ui.dockOpen = true;
    this.store.ui.dockTab = tab;
    this.apply();
    this.onChange?.(tab);
  }

  toggle(tab) {
    if (this.open && this.tab === tab) this.close(); else this.show(tab);
  }

  close() {
    this.store.ui.dockOpen = false;
    this.apply();
    this.onChange?.(null);
  }

  apply() {
    const { dockOpen, dockTab, dockHeight } = this.store.ui;
    this.el.hidden = !dockOpen;
    this.el.style.height = `${dockHeight}px`;
    for (const [id, b] of Object.entries(this.tabBtns)) b.classList.toggle('active', id === dockTab);
    this.el.querySelectorAll('.dock-pane').forEach((p) => { p.hidden = p.dataset.pane !== dockTab; });
  }
}

// ---------- instrument panel ----------

const toSlider = (d, v) => (d.log ? (Math.log(v / d.min) / Math.log(d.max / d.min)) * 1000 : v);
const fromSlider = (d, s) => (d.log ? d.min * Math.pow(d.max / d.min, s / 1000) : s);
function fmt(d, v) {
  if (d.unit === 'Hz') return v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`;
  if (d.unit === 's') return v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`;
  if (d.unit === 'dB') return `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
  if (d.unit === 'st') return `${v > 0 ? '+' : ''}${v} st`;
  if (d.unit === '¢') return `${v}¢`;
  if (d.key === 'sustain' || d.key === 'velSens') return `${Math.round(v * 100)}%`;
  return (+v).toFixed(1);
}

export class InstrumentPanel {
  constructor({ store, engine, root }) {
    this.store = store;
    this.engine = engine;
    this.root = root;
  }

  render() {
    const t = this.store.selectedTrack();
    this.root.innerHTML = '';
    if (t?.type === 'drums') { this.renderDrums(t); return; }
    if (!t || t.type !== 'instrument') {
      this.root.append(h('div', { class: 'pane-empty' }, t ? 'Audio tracks get their settings in Phase 5.' : 'Select an instrument track.'));
      return;
    }
    const pr = getPreset(t.instrument.preset);
    const pick = h('div', { class: 'inst-pick' });
    const cats = [...new Set(PRESETS.map((p) => p.category))];
    for (const cat of cats) {
      const group = h('div', { class: 'inst-cat' }, h('div', { class: 'inst-cat-name', style: { color: CATEGORY_COLORS[cat] } }, cat));
      for (const p of PRESETS.filter((x) => x.category === cat)) {
        group.append(h('button', {
          class: `inst-btn ${p.id === pr.id ? 'active' : ''}`,
          title: p.kind === 'sample' ? 'Recorded samples' : 'Synthesizer',
          onclick: () => this.store.mutate((pp) => {
            const x = pp.tracks.find((y) => y.id === t.id);
            x.instrument = { preset: p.id, params: {} };
          }),
        }, p.name, p.kind === 'synth' ? h('small', {}, ' synth') : null));
      }
      pick.append(group);
    }

    const params = h('div', { class: 'inst-params' });
    for (const d of paramDefs(pr)) {
      const v = paramValue(pr, t.instrument.params, d.key);
      const label = h('span', { class: 'pval' }, fmt(d, v));
      const changed = t.instrument.params?.[d.key] != null;
      const input = h('input', {
        type: 'range',
        min: d.log ? 0 : d.min, max: d.log ? 1000 : d.max, step: d.log ? 1 : d.step,
        value: toSlider(d, v),
        title: 'Double-click to reset',
        oninput: (e) => {
          let nv = fromSlider(d, +e.target.value);
          if (!d.log) nv = Math.round(nv / d.step) * d.step;
          label.textContent = fmt(d, nv);
          this.store.mutate((pp) => {
            const x = pp.tracks.find((y) => y.id === t.id);
            x.instrument.params = { ...(x.instrument.params || {}), [d.key]: nv };
          }, { merge: `param:${t.id}:${d.key}`, silent: true });
        },
        onchange: () => this.store.emit('project'),
        ondblclick: () => this.store.mutate((pp) => {
          const x = pp.tracks.find((y) => y.id === t.id);
          const np = { ...(x.instrument.params || {}) };
          delete np[d.key];
          x.instrument.params = np;
        }),
      });
      params.append(h('div', { class: `prow ${changed ? 'changed' : ''}` }, h('span', { class: 'plabel' }, d.label), input, label));
    }

    const loading = this.engine.isLoading(t.id);
    this.root.append(
      h('div', { class: 'inst-head' },
        h('span', { class: 'dot', style: { background: colorForTrack(t) } }),
        h('b', {}, t.name),
        h('span', { class: 'muted' }, ` · ${pr.name} (${pr.kind === 'sample' ? 'sampled' : 'synth'})`),
        loading ? h('span', { class: 'loading' }, ' · loading samples…') : null,
        h('div', { class: 'spacer' }),
        h('button', {
          class: 'pbtn', title: 'Put every setting back to the preset',
          onclick: () => this.store.mutate((pp) => { pp.tracks.find((y) => y.id === t.id).instrument.params = {}; }),
        }, 'Reset settings')),
      h('div', { class: 'inst-body' }, pick, h('div', { class: 'inst-right' }, params,
        h('div', { class: 'hint' }, 'Chorus, delay, distortion, reverb and the other effects come in Phase 4 as per-track effects with automation.'))));
  }
}

InstrumentPanel.prototype.renderDrums = function renderDrums(t) {
  const kit = getKit(t.drums.kit);
  const pick = h('div', { class: 'inst-pick' });
  const group = h('div', { class: 'inst-cat' }, h('div', { class: 'inst-cat-name', style: { color: CATEGORY_COLORS.Drums } }, 'Drum kits'));
  for (const k of KITS) {
    group.append(h('button', {
      class: `inst-btn ${k.id === kit.id ? 'active' : ''}`,
      onclick: () => this.store.mutate((pp) => { pp.tracks.find((y) => y.id === t.id).drums = { kit: k.id, pads: {} }; }),
    }, k.name, h('small', {}, ` ${k.pads.length} pads`)));
  }
  pick.append(group);
  const table = h('div', { class: 'padtable' }, h('span', { class: 'hd' }, 'Pad'), PAD_PARAMS.map((d) => h('span', { class: 'hd' }, d.label)));
  for (const pad of kit.pads) {
    table.append(h('span', { class: 'pn', title: 'Click to hear', onclick: () => this.engine.preview(t.id, pad.note, 110, 0.1) }, pad.name));
    for (const d of PAD_PARAMS) {
      table.append(h('input', {
        type: 'range', min: d.min, max: d.max, step: d.step, value: padSetting(t, pad.note, d.key),
        title: `${pad.name} ${d.label.toLowerCase()} (double-click to reset)`,
        oninput: (e) => {
          const v = +e.target.value;
          this.store.mutate((pp) => {
            const x = pp.tracks.find((y) => y.id === t.id);
            x.drums.pads = { ...(x.drums.pads || {}), [pad.note]: { ...(x.drums.pads?.[pad.note] || {}), [d.key]: v } };
          }, { merge: `pad:${t.id}:${pad.note}:${d.key}`, silent: true });
        },
        onchange: () => this.engine.preview(t.id, pad.note, 110, 0.1),
        ondblclick: () => this.store.mutate((pp) => {
          const x = pp.tracks.find((y) => y.id === t.id);
          const ps = { ...(x.drums.pads?.[pad.note] || {}) };
          delete ps[d.key];
          x.drums.pads = { ...(x.drums.pads || {}), [pad.note]: ps };
        }),
      }));
    }
  }
  this.root.append(
    h('div', { class: 'inst-head' },
      h('span', { class: 'dot', style: { background: CATEGORY_COLORS.Drums } }), h('b', {}, t.name),
      h('span', { class: 'muted' }, ` · ${kit.name} (synthesized drum machine)`),
      h('div', { class: 'spacer' }),
      h('button', { class: 'pbtn', onclick: () => this.store.mutate((pp) => { pp.tracks.find((y) => y.id === t.id).drums.pads = {}; }) }, 'Reset pads')),
    h('div', { class: 'inst-body' }, pick, h('div', { class: 'inst-right' }, table,
      h('div', { class: 'hint' }, 'Patterns keep working when you switch kits — every kit uses the standard General MIDI drum notes, so MIDI drum pads play the right sounds too.'))));
};

// ---------- on-screen keyboard ----------

export class OnscreenKeyboard {
  constructor({ store, engine, root, liveTrack }) {
    this.store = store;
    this.engine = engine;
    this.root = root;
    this.liveTrack = liveTrack;
    this.keys = new Map();
    this.down = new Set();
    engine.on('live', (p, on) => this.light(p, on));
  }

  render() {
    this.root.innerHTML = '';
    this.keys.clear();
    const sel = this.store.selectedTrack();
    if (sel?.type === 'drums') { this.renderPads(sel); return; }
    const oct = this.store.ui.octave;
    const start = 12 * oct; // one octave below the computer-keyboard octave
    const end = start + 12 * 4;
    const kbLabels = {};
    for (const [code, off] of Object.entries(KEYMAP)) kbLabels[12 * (oct + 1) + off] = code.replace('Key', '').replace('Semicolon', ';');
    const wrap = h('div', { class: 'okb' });
    const whites = [];
    for (let p = start; p <= end; p++) if (![1, 3, 6, 8, 10].includes(p % 12)) whites.push(p);
    const ww = 100 / whites.length;
    whites.forEach((p, i) => {
      const k = h('div', { class: 'okey white', style: { left: `${i * ww}%`, width: `${ww}%` }, 'data-p': p },
        h('span', { class: 'kl' }, kbLabels[p] || ''), p % 12 === 0 ? h('span', { class: 'nl' }, noteName(p)) : null);
      this.keys.set(p, k); wrap.append(k);
    });
    for (let p = start; p <= end; p++) {
      if (![1, 3, 6, 8, 10].includes(p % 12)) continue;
      const wi = whites.indexOf(p - 1);
      const k = h('div', { class: 'okey black', style: { left: `${(wi + 1) * ww - ww * 0.32}%`, width: `${ww * 0.64}%` }, 'data-p': p },
        h('span', { class: 'kl' }, kbLabels[p] || ''));
      this.keys.set(p, k); wrap.append(k);
    }
    let held = null;
    const on = (p) => { const id = this.liveTrack(); if (!id) return; held = { p, id }; this.engine.liveNoteOn(id, p, this.store.ui.kbVelocity); };
    const off = () => { if (held) { this.engine.liveNoteOff(held.id, held.p); held = null; } };
    wrap.addEventListener('pointerdown', (e) => {
      const k = e.target.closest('.okey'); if (!k) return;
      wrap.setPointerCapture(e.pointerId);
      on(+k.dataset.p);
    });
    wrap.addEventListener('pointermove', (e) => {
      if (!held) return;
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('.okey');
      if (el && +el.dataset.p !== held.p) { off(); on(+el.dataset.p); }
    });
    wrap.addEventListener('pointerup', off);
    wrap.addEventListener('pointercancel', off);
    const t = this.store.selectedTrack();
    this.root.append(
      h('div', { class: 'okb-head' },
        h('button', { class: 'pbtn', onclick: () => { this.store.ui.octave = Math.max(0, oct - 1); this.store.emit('ui'); } }, '◀ Octave'),
        h('span', { class: 'muted' }, `${noteName(start)} – ${noteName(end)}`),
        h('button', { class: 'pbtn', onclick: () => { this.store.ui.octave = Math.min(7, oct + 1); this.store.emit('ui'); } }, 'Octave ▶'),
        h('span', { class: 'muted' }, t && t.type === 'instrument' ? ` · playing ${t.name} (click, drag across keys, or use the letters shown)` : ' · select an instrument track to play')),
      wrap);
  }

  renderPads(t) {
    const kit = getKit(t.drums.kit);
    const keyNames = Object.keys(KEYMAP).map((c) => c.replace('Key', '').replace('Semicolon', ';'));
    const grid = h('div', { class: 'pads' });
    kit.pads.forEach((pad, i) => {
      const el = h('button', {
        class: 'pad',
        onpointerdown: (e) => { e.preventDefault(); this.engine.liveNoteOn(t.id, pad.note, e.shiftKey ? 127 : this.store.ui.kbVelocity); },
        onpointerup: () => this.engine.liveNoteOff(t.id, pad.note),
      }, pad.name, h('small', {}, keyNames[i] ? `key ${keyNames[i]}` : ''));
      this.keys.set(pad.note, el);
      grid.append(el);
    });
    this.root.append(h('div', { class: 'okb-head' }, h('b', {}, `${t.name} pads`), h('span', { class: 'muted' }, ' · click the pads or use the computer keys shown · Shift-click for an accent · hits record when ● Record is on')), grid);
  }

  light(p, on) {
    const k = this.keys.get(p);
    if (k) k.classList.toggle('lit', on);
  }
}
