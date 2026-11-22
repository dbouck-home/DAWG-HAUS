// Track headers (left column) and mixer strips.
import { PRESETS, colorForTrack, CATEGORY_COLORS, TRACK_COLORS } from '../audio/presets.js';
import { h, confirmBox } from './dom.js';
import { KITS } from '../audio/drums.js';
import { targetsFor, activeLane } from '../automation.js';
import { uid } from '../project.js';

export const fmtDb = (db) => (db <= -60 ? '-∞ dB' : `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`);
const fmtPan = (p) => (Math.abs(p) < 0.01 ? 'C' : p < 0 ? `L${Math.round(-p * 100)}` : `R${Math.round(p * 100)}`);

function instrumentSelect(track, onChange) {
  const sel = h('select', { title: 'Instrument', onchange: (e) => onChange(e.target.value), onpointerdown: (e) => e.stopPropagation() });
  const cats = [...new Set(PRESETS.map((p) => p.category))];
  for (const cat of cats) {
    const og = h('optgroup', { label: cat });
    for (const p of PRESETS.filter((x) => x.category === cat)) {
      og.append(h('option', { value: p.id, selected: track.instrument?.preset === p.id }, p.name));
    }
    sel.append(og);
  }
  return sel;
}

export class TrackHeaders {
  constructor({ store, engine, onShowFx }) {
    this.store = store;
    this.engine = engine;
    this.onShowFx = onShowFx;
    this.el = document.getElementById('track-headers');
    this.meters = new Map();
  }

  /** Show automation lanes for a track (adding a lane for `target` if given). */
  showAutomation(trackId, target) {
    this.store.mutate((p) => {
      const t = p.tracks.find((x) => x.id === trackId);
      if (!t) return;
      t.automation ||= [];
      if (target && !t.automation.some((a) => a.target === target)) t.automation.push({ id: uid('au'), target, points: [] });
      if (!t.automation.length) t.automation.push({ id: uid('au'), target: 'volume', points: [] });
      t.showAuto = true;
    });
  }

  autoHeader(t, lane) {
    const targets = targetsFor(t);
    const used = new Set((t.automation || []).map((a) => a.target));
    const sel = h('select', {
      title: 'What this lane controls',
      onchange: (e) => this.store.mutate((p) => {
        const a = p.tracks.find((x) => x.id === t.id).automation.find((x) => x.id === lane.id);
        a.target = e.target.value;
        a.points = [];
      }),
    }, targets.map((tg) => h('option', { value: tg.key, selected: tg.key === lane.target, disabled: tg.key !== lane.target && used.has(tg.key) }, tg.label)));
    const unused = targets.find((tg) => !used.has(tg.key));
    return h('div', { class: 'ah', 'data-track': t.id },
      h('div', { class: 'row' }, sel,
        h('button', {
          class: 'sb', title: 'Clear all points in this lane',
          onclick: () => this.store.mutate((p) => { p.tracks.find((x) => x.id === t.id).automation.find((x) => x.id === lane.id).points = []; }),
        }, '⌫'),
        h('button', {
          class: 'sb del', title: 'Remove this lane (and its automation)',
          onclick: () => this.store.mutate((p) => {
            const x = p.tracks.find((y) => y.id === t.id);
            x.automation = x.automation.filter((a) => a.id !== lane.id);
            if (!x.automation.length) x.showAuto = false;
          }),
        }, '✕')),
      h('div', { class: 'row' },
        h('span', { class: 'alabel' }, lane.points.length ? `${lane.points.length} point${lane.points.length === 1 ? '' : 's'}` : 'click the lane to add points'),
        h('div', { class: 'spacer' }),
        unused ? h('button', { class: 'pbtn', title: 'Add another automation lane', onclick: () => this.showAutomation(t.id, unused.key) }, '+ Lane') : null));
  }

  render() {
    const { project, ui } = this.store;
    this.el.innerHTML = '';
    this.meters.clear();
    if (ui.showTempo) {
      const n = project.tempos.length;
      this.el.append(h('div', { class: 'ah tempo' },
        h('div', { class: 'row' }, h('b', {}, '⏱ Tempo'), h('div', { class: 'spacer' }),
          h('button', { class: 'sb', title: 'Remove tempo changes (keep the starting tempo)', onclick: () => this.store.mutate((p) => { p.tempos = [{ tick: 0, bpm: p.tempos[0].bpm }]; }) }, '⌫')),
        h('span', { class: 'alabel' }, n > 1 ? `${n} tempo points — the song speeds up / slows down` : 'click the lane to add tempo changes')));
    }
    project.tracks.forEach((t) => {
      const selected = t.id === ui.selectedTrackId;
      const nameEl = h('div', {
        class: `name ${t.customName ? 'custom' : ''}`,
        title: t.customName ? 'Custom name — double-click to rename (clear it to go back to automatic naming)' : 'Named automatically after its instrument — double-click to rename',
        ondblclick: (e) => { e.stopPropagation(); this.rename(t, nameEl); },
      }, t.name);
      const meter = h('i');
      this.meters.set(t.id, meter);
      const volLabel = h('span', { class: 'vol-label' }, fmtDb(t.volume));
      const row2 = t.type === 'instrument'
        ? instrumentSelect(t, (v) => this.store.mutate((p) => { p.tracks.find((x) => x.id === t.id).instrument = { preset: v, params: {} }; }))
        : t.type === 'drums'
          ? h('select', {
            class: 'kit', title: 'Drum kit', onpointerdown: (e) => e.stopPropagation(),
            onchange: (e) => this.store.mutate((p) => { p.tracks.find((x) => x.id === t.id).drums = { kit: e.target.value, pads: {} }; }),
          }, KITS.map((k) => h('option', { value: k.id, selected: k.id === t.drums.kit }, k.name)))
          : h('span', { class: 'type-tag' }, 'Audio track · recording arrives in Phase 5');
      const el = h('div', {
        class: `th ${selected ? 'selected' : ''}`,
        'data-track': t.id,
        onpointerdown: () => { if (this.store.ui.selectedTrackId !== t.id) this.store.setUI({ selectedTrackId: t.id }); },
      },
      h('div', { class: 'color', title: 'Track color — click to change', style: { background: colorForTrack(t) }, onclick: (e) => this.colorPicker(e, t) }),
      h('div', { class: 'body' },
        h('div', { class: 'row' },
          nameEl,
          this.engine.isLoading(t.id) ? h('span', { class: 'loading-tag', title: 'Downloading instrument samples' }, '⏳') : null,
          t.type !== 'audio' ? h('span', { class: 'live-ind', title: 'Your MIDI keyboard and computer keyboard play this track' }, '🎹') : null,
          h('button', { class: `sb m ${t.mute ? 'active' : ''}`, title: 'Mute', onclick: () => this.toggle(t, 'mute') }, 'M'),
          h('button', { class: `sb s ${t.solo ? 'active' : ''}`, title: 'Solo', onclick: () => this.toggle(t, 'solo') }, 'S'),
          h('button', {
            class: `sb fxb ${(t.fx || []).length ? 'active' : ''}`, title: `Effects${(t.fx || []).length ? ` (${t.fx.length})` : ''}`,
            onclick: () => this.onShowFx?.(t.id),
          }, 'FX'),
          h('button', {
            class: `sb a ${t.showAuto ? 'active' : ''}`, title: 'Show / hide automation lanes',
            onclick: () => { if (t.showAuto) this.store.mutate((p) => { p.tracks.find((x) => x.id === t.id).showAuto = false; }); else this.showAutomation(t.id); },
          }, 'A'),
          h('button', { class: 'sb del', title: 'Delete track', onclick: () => this.remove(t) }, '✕')),
        h('div', { class: 'row' }, row2),
        h('div', { class: 'row' },
          h('input', {
            type: 'range', min: -60, max: 6, step: 0.1, value: t.volume,
            title: activeLane(t, 'volume') ? 'Volume is automated — edit its lane (this level is used when there are no points)' : 'Volume (double-click to reset)',
            oninput: (e) => { const v = +e.target.value; volLabel.textContent = fmtDb(v); this.setVol(t, v); },
            onchange: () => this.store.emit('project'),
            ondblclick: () => { this.setVol(t, 0); this.store.emit('project'); },
          }),
          volLabel)),
      h('div', { class: 'hmeter' }, meter));
      this.el.append(el);
      if (t.showAuto) for (const lane of t.automation || []) this.el.append(this.autoHeader(t, lane));
    });
  }

  colorPicker(e, t) {
    e.stopPropagation();
    document.querySelector('.popmenu')?.remove();
    const set = (c) => { menu.remove(); this.store.mutate((p) => { const x = p.tracks.find((y) => y.id === t.id); if (c) x.color = c; else delete x.color; }); };
    const cur = colorForTrack(t);
    const menu = h('div', { class: 'popmenu colorpop' },
      h('div', { class: 'swatches' }, TRACK_COLORS.map((c) => h('button', { class: `swatch ${c === cur ? 'on' : ''}`, style: { background: c }, title: c, onclick: () => set(c) }))),
      h('label', { class: 'popitem custom-color' }, 'Custom…', h('input', { type: 'color', value: cur, onchange: (ev) => set(ev.target.value) })),
      h('button', { class: 'popitem', onclick: () => set(null) }, 'Automatic', h('small', {}, 'by instrument type')));
    document.body.append(menu);
    const r = e.target.getBoundingClientRect();
    menu.style.left = `${r.right + 6}px`;
    menu.style.top = `${Math.min(r.top, window.innerHeight - menu.getBoundingClientRect().height - 8)}px`;
    const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('pointerdown', close, true); } };
    setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
  }

  updateSelection() {
    const id = this.store.ui.selectedTrackId;
    this.el.querySelectorAll('.th').forEach((e) => e.classList.toggle('selected', e.dataset.track === id));
  }

  setVol(t, v) {
    this.store.mutate((p) => { p.tracks.find((x) => x.id === t.id).volume = v; }, { merge: `vol:${t.id}`, silent: true });
  }

  toggle(t, key) {
    this.store.mutate((p) => { const x = p.tracks.find((y) => y.id === t.id); x[key] = !x[key]; });
  }

  async remove(t) {
    const hasClips = t.clips.length > 0;
    if (hasClips && !(await confirmBox('Delete track?', `"${t.name}" and its ${t.clips.length} clip(s) will be deleted. You can undo this.`, 'Delete', true))) return;
    this.store.mutate((p) => { p.tracks = p.tracks.filter((x) => x.id !== t.id); });
    this.store.fixSelection();
    this.store.emit('project');
  }

  rename(t, nameEl) {
    const input = h('input', { type: 'text', value: t.name, maxlength: 60 });
    nameEl.innerHTML = '';
    nameEl.append(input);
    input.focus(); input.select();
    let done = false;
    const finish = (save) => {
      if (done) return; done = true;
      if (!save) { this.render(); return; }
      const v = input.value.trim();
      this.store.mutate((p) => {
        const x = p.tracks.find((y) => y.id === t.id);
        if (v) { x.name = v; x.customName = true; } else { x.customName = false; }
      });
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  updateMeters() {
    for (const [id, el] of this.meters) {
      const pk = this.engine.trackPeak(id);
      el.style.height = `${Math.min(100, Math.sqrt(pk) * 100)}%`;
    }
  }
}

export class Mixer {
  constructor({ store, engine }) {
    this.store = store;
    this.engine = engine;
    this.el = document.getElementById('mixer-strips');
    this.meters = new Map();
  }

  render() {
    const { project, ui } = this.store;
    this.el.innerHTML = '';
    this.meters.clear();
    for (const t of project.tracks) {
      this.el.append(this.strip({
        id: t.id,
        name: t.name,
        color: colorForTrack(t),
        volume: t.volume,
        pan: t.pan,
        selected: t.id === ui.selectedTrackId,
        track: t,
      }));
    }
    this.el.append(this.strip({ id: 'master', name: 'Master', color: CATEGORY_COLORS.Brass, volume: project.masterVolume, master: true }));
  }

  strip({ id, name, color, volume, pan, selected, master, track }) {
    const meter = h('i');
    this.meters.set(id, meter);
    const db = h('div', { class: 'db' }, fmtDb(volume));
    const setVol = (v) => {
      db.textContent = fmtDb(v);
      this.store.mutate((p) => {
        if (master) p.masterVolume = v; else p.tracks.find((x) => x.id === id).volume = v;
      }, { merge: `vol:${id}`, silent: true });
    };
    const fader = h('input', {
      class: 'fader', type: 'range', min: -60, max: 6, step: 0.1, value: volume, title: 'Volume (double-click to reset)',
      oninput: (e) => setVol(+e.target.value),
      onchange: () => this.store.emit('project'),
      ondblclick: () => { setVol(0); this.store.emit('project'); },
    });
    const kids = [
      h('div', { class: 'sname', style: { background: color }, title: name }, name),
      h('div', { class: 'fader-wrap' }, fader, h('div', { class: 'vmeter' }, meter)),
      db,
    ];
    if (!master) {
      const plabel = h('div', { class: 'plabel' }, `Pan ${fmtPan(pan)}`);
      kids.push(h('input', {
        class: 'pan', type: 'range', min: -1, max: 1, step: 0.01, value: pan, title: 'Pan (double-click to center)',
        oninput: (e) => {
          const v = +e.target.value; plabel.textContent = `Pan ${fmtPan(v)}`;
          this.store.mutate((p) => { p.tracks.find((x) => x.id === id).pan = v; }, { merge: `pan:${id}`, silent: true });
        },
        onchange: () => this.store.emit('project'),
        ondblclick: () => this.store.mutate((p) => { p.tracks.find((x) => x.id === id).pan = 0; }),
      }), plabel);
      kids.push(h('div', { class: 'btns' },
        h('button', { class: `sb m ${track.mute ? 'active' : ''}`, onclick: () => this.store.mutate((p) => { const x = p.tracks.find((y) => y.id === id); x.mute = !x.mute; }) }, 'M'),
        h('button', { class: `sb s ${track.solo ? 'active' : ''}`, onclick: () => this.store.mutate((p) => { const x = p.tracks.find((y) => y.id === id); x.solo = !x.solo; }) }, 'S')));
    }
    return h('div', {
      class: `strip ${master ? 'master' : ''} ${selected ? 'selected' : ''}`,
      'data-track': id,
      onpointerdown: () => { if (!master && this.store.ui.selectedTrackId !== id) this.store.setUI({ selectedTrackId: id }); },
    }, ...kids);
  }

  updateSelection() {
    const id = this.store.ui.selectedTrackId;
    this.el.querySelectorAll('.strip').forEach((e) => e.classList.toggle('selected', e.dataset.track === id));
  }

  updateMeters() {
    for (const [id, el] of this.meters) {
      const pk = id === 'master' ? this.engine.masterPeak() : this.engine.trackPeak(id);
      el.style.height = `${Math.min(100, Math.sqrt(pk) * 100)}%`;
    }
  }
}
