// Effects tab: insert effects for the selected track or the master bus.
import { FX_TYPES, FX_ORDER, fxDefaults } from '../audio/effects.js';
import { AUTO_KEYS } from '../automation.js';
import { colorForTrack } from '../audio/presets.js';
import { uid } from '../project.js';
import { h } from './dom.js';

const toSlider = (d, v) => (d.log ? (Math.log(v / d.min) / Math.log(d.max / d.min)) * 1000 : v);
const fromSlider = (d, s) => (d.log ? d.min * Math.pow(d.max / d.min, s / 1000) : s);
export function fmtParam(d, v) {
  if (d.type === 'select') return '';
  if (d.unit === 'Hz') return v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`;
  if (d.unit === 's') return v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`;
  if (d.unit === 'ms') return `${Math.round(v)} ms`;
  if (d.unit === 'dB') return `${v > 0 ? '+' : ''}${(+v).toFixed(1)} dB`;
  if (d.unit === ':1') return `${(+v).toFixed(1)}:1`;
  if (d.max <= 1 && d.min >= 0) return `${Math.round(v * 100)}%`;
  return (+v).toFixed(2);
}

export class FxPanel {
  constructor({ store, root, onAutomate }) {
    this.store = store;
    this.root = root;
    this.onAutomate = onAutomate;
    this.target = 'track'; // 'track' | 'master'
  }

  list(p = this.store.project) {
    if (this.target === 'master') return p.masterFx || (p.masterFx = []);
    const t = p.tracks.find((x) => x.id === this.store.ui.selectedTrackId);
    if (!t) return null;
    if (!t.fx) t.fx = [];
    return t.fx;
  }

  edit(fn, opts) {
    this.store.mutate((p) => { const l = this.list(p); if (l) fn(l, p); }, opts);
  }

  render() {
    this.root.innerHTML = '';
    const t = this.store.selectedTrack();
    const list = this.list();
    const tabs = h('div', { class: 'pgroup' },
      h('button', { class: `pbtn ${this.target === 'track' ? 'active' : ''}`, onclick: () => { this.target = 'track'; this.render(); } },
        t ? h('span', {}, h('span', { class: 'dot', style: { background: colorForTrack(t) } }), t.name) : 'Track'),
      h('button', { class: `pbtn ${this.target === 'master' ? 'active' : ''}`, onclick: () => { this.target = 'master'; this.render(); } }, 'Master'));
    const addSel = h('select', {
      class: 'add-fx',
      onchange: (e) => {
        const type = e.target.value;
        e.target.value = '';
        if (!type) return;
        this.edit((l) => { l.push({ id: uid('fx'), type, on: true, params: fxDefaults(type) }); });
      },
    }, h('option', { value: '' }, '+ Add effect…'), FX_ORDER.map((k) => h('option', { value: k }, FX_TYPES[k].name)));
    this.root.append(h('div', { class: 'inst-head' }, h('b', {}, 'Effects for '), tabs, h('div', { class: 'spacer' }), list ? addSel : null));

    if (!list) { this.root.append(h('div', { class: 'pane-empty' }, 'Select a track to add effects.')); return; }
    const chain = h('div', { class: 'fx-chain' });
    if (!list.length) {
      chain.append(h('div', { class: 'pane-empty' }, `No effects yet. Use “+ Add effect” — they run left to right, in order. ${this.target === 'master' ? 'Master effects apply to the whole song.' : ''}`));
    }
    list.forEach((fx, i) => chain.append(this.card(fx, i, list.length, t)));
    this.root.append(chain);
  }

  card(fx, i, n, track) {
    const def = FX_TYPES[fx.type];
    const params = { ...fxDefaults(fx.type), ...(fx.params || {}) };
    const autoKeys = new Set(AUTO_KEYS[fx.type] || []);
    const rows = def.params.map((d) => {
      const v = params[d.key];
      let input;
      const label = h('span', { class: 'pval' }, fmtParam(d, v));
      if (d.type === 'select') {
        input = h('select', {
          onchange: (e) => this.edit((l) => { l[i].params = { ...l[i].params, [d.key]: e.target.value }; }),
        }, d.options.map(([val, lab]) => h('option', { value: val, selected: String(v) === val }, lab)));
      } else {
        input = h('input', {
          type: 'range', min: d.log ? 0 : d.min, max: d.log ? 1000 : d.max, step: d.log ? 1 : d.step, value: toSlider(d, v),
          title: 'Double-click to reset',
          oninput: (e) => {
            let nv = fromSlider(d, +e.target.value);
            if (!d.log) nv = Math.round(nv / d.step) * d.step;
            label.textContent = fmtParam(d, nv);
            this.edit((l) => { l[i].params = { ...l[i].params, [d.key]: nv }; }, { merge: `fx:${fx.id}:${d.key}`, silent: true });
          },
          ondblclick: () => this.edit((l) => { l[i].params = { ...l[i].params, [d.key]: d.def }; }),
        });
      }
      const auto = this.target === 'track' && autoKeys.has(d.key)
        ? h('button', { class: 'auto-btn', title: 'Automate this over time', onclick: () => this.onAutomate?.(track.id, `fx:${fx.id}:${d.key}`) }, '⤴')
        : h('span');
      return h('div', { class: 'fx-row' }, h('span', { class: 'plabel' }, d.label), input, label, auto);
    });
    return h('div', { class: `fx-card ${fx.on === false ? 'off' : ''}` },
      h('div', { class: 'fx-head' },
        h('button', { class: `fx-power ${fx.on === false ? '' : 'on'}`, title: fx.on === false ? 'Turn on' : 'Bypass', onclick: () => this.edit((l) => { l[i].on = l[i].on === false; }) }, '⏻'),
        h('b', {}, def.name),
        h('div', { class: 'spacer' }),
        h('button', { class: 'sb', title: 'Move earlier', disabled: i === 0, onclick: () => this.edit((l) => { [l[i - 1], l[i]] = [l[i], l[i - 1]]; }) }, '◀'),
        h('button', { class: 'sb', title: 'Move later', disabled: i === n - 1, onclick: () => this.edit((l) => { [l[i + 1], l[i]] = [l[i], l[i + 1]]; }) }, '▶'),
        h('button', {
          class: 'sb del', title: 'Remove',
          onclick: () => this.store.mutate((p) => {
            const l = this.list(p);
            const removed = l.splice(i, 1)[0];
            // drop automation lanes that pointed at the removed effect
            for (const tr of p.tracks) tr.automation = (tr.automation || []).filter((a) => !a.target.startsWith(`fx:${removed.id}:`));
          }),
        }, '✕')),
      h('div', { class: 'fx-body' }, rows));
  }
}
