// benDAWmin — app entry point. Wires the store, audio engine and UI together.
import { MeterMap, TempoMap, SNAP_OPTIONS, VALID_DENOMINATORS, formatTime, parseGrouping, PPQ } from './timing.js';
import { Store } from './store.js';
import { Engine } from './audio/engine.js';
import { PRESETS, CATEGORY_COLORS } from './audio/presets.js';
import { demoProject, newProject, newTrack, newClip, migrateProject } from './project.js';
import { loadProject, lastProjectId, listProjects, deleteProject, exportProjectFile, pickProjectFile, saveProject } from './storage.js';
import { MidiInput, KEYMAP } from './midi.js';
import { Timeline } from './ui/timeline.js';
import { TrackHeaders, Mixer } from './ui/tracks.js';
import { h, openModal, promptText, confirmBox, toast, isModalOpen } from './ui/dom.js';

const $ = (id) => document.getElementById(id);

async function boot() {
  let project = null;
  const last = lastProjectId();
  if (last) {
    try { const p = await loadProject(last); if (p) project = migrateProject(p); } catch (e) { console.warn(e); }
  }
  if (!project) project = demoProject();

  const store = new Store(project);
  const engine = new Engine(() => store.project);
  const timeline = new Timeline({ store, engine, onEditMeter: (bar) => meterDialog(bar) });
  const headers = new TrackHeaders({ store, engine });
  const mixer = new Mixer({ store, engine });
  window.benDAWmin = { store, engine }; // handy for debugging
  let lastMeterLabel = null;

  // ---------- rendering ----------
  function renderAll() {
    const p = store.project;
    $('project-name').textContent = p.name;
    document.title = `${p.name} — benDAWmin`;
    headers.render();
    timeline.render();
    if (store.ui.mixerOpen) mixer.render();
    renderTransportFields();
    $('btn-undo').disabled = !store.canUndo();
    $('btn-redo').disabled = !store.canRedo();
  }

  function renderTransportFields() {
    const p = store.project;
    const bpmInput = $('inp-bpm');
    if (document.activeElement !== bpmInput) bpmInput.value = +p.tempos[0].bpm.toFixed(2);
    $('btn-loop').classList.toggle('active', p.loop.enabled);
    $('btn-metro').classList.toggle('active', p.metronome.enabled);
    $('inp-click-vol').value = p.metronome.volume;
    $('btn-play').classList.toggle('active', engine.playing);
    $('btn-record').classList.toggle('active', engine.recording);
    $('btn-mixer').classList.toggle('active', store.ui.mixerOpen);
    $('mixer').hidden = !store.ui.mixerOpen;
    $('sel-snap').value = String(store.ui.snap);
    lastMeterLabel = null;
  }

  function renderStatus() {
    const oct = store.ui.octave;
    $('status-kb').innerHTML = `Computer keyboard: <kbd>A</kbd>–<kbd>K</kbd> play notes · <kbd>Z</kbd>/<kbd>X</kbd> octave (C${oct}) · <kbd>C</kbd>/<kbd>V</kbd> velocity (${store.ui.kbVelocity}) · <kbd>Space</kbd> play · <kbd>R</kbd> record · <kbd>Del</kbd> delete clip · double-click a lane for an empty clip`;
  }

  function renderSave() {
    const el = $('save-status');
    const s = store.saveStatus;
    el.className = `save-status ${s}`;
    el.textContent = s === 'saved' ? 'Saved' : s === 'saving' ? 'Saving…' : s === 'error' ? 'Save failed' : 'Unsaved changes';
  }

  store.subscribe((kind) => {
    if (kind === 'project' || kind === 'load') { engine.sync(); renderAll(); }
    else if (kind === 'silent') { engine.sync(); }
    else if (kind === 'ui' || kind === 'selection') {
      headers.updateSelection(); mixer.updateSelection(); timeline.updateSelection();
      renderTransportFields(); renderStatus(); timeline.drawStatic();
    } else if (kind === 'save') renderSave();
    if (kind === 'project' || kind === 'silent' || kind === 'load') {
      $('btn-undo').disabled = !store.canUndo();
      $('btn-redo').disabled = !store.canRedo();
    }
  });
  engine.on('transport', renderTransportFields);

  // ---------- transport ----------
  const snapSel = $('sel-snap');
  for (const o of SNAP_OPTIONS) snapSel.append(h('option', { value: String(o.value) }, o.label));
  snapSel.addEventListener('change', () => {
    const v = snapSel.value;
    store.setUI({ snap: Number.isNaN(+v) ? v : +v });
    snapSel.blur();
  });

  const togglePlay = () => {
    engine.ensureContext();
    if (engine.playing) engine.stop(); else engine.play();
  };
  $('btn-play').onclick = togglePlay;
  $('btn-stop').onclick = () => { engine.stop(); };
  $('btn-home').onclick = () => { engine.setPosition(0); timeline.arrange.scrollLeft = 0; };
  $('btn-record').onclick = () => toggleRecord();
  $('btn-loop').onclick = () => store.mutate((p) => { p.loop.enabled = !p.loop.enabled; });
  $('btn-metro').onclick = () => { engine.ensureContext(); store.mutate((p) => { p.metronome.enabled = !p.metronome.enabled; }); };
  $('inp-click-vol').oninput = (e) => store.mutate((p) => { p.metronome.volume = +e.target.value; }, { merge: 'clickvol', silent: true });
  $('btn-zoom-in').onclick = () => timeline.zoom(1.3);
  $('btn-zoom-out').onclick = () => timeline.zoom(1 / 1.3);
  $('btn-mixer').onclick = () => {
    store.ui.mixerOpen = !store.ui.mixerOpen;
    if (store.ui.mixerOpen) mixer.render();
    renderTransportFields();
    timeline.layout();
  };
  $('btn-undo').onclick = () => store.undo();
  $('btn-redo').onclick = () => store.redo();
  $('inp-bpm').addEventListener('change', (e) => {
    let v = parseFloat(e.target.value);
    if (!Number.isFinite(v)) v = store.project.tempos[0].bpm;
    v = Math.min(400, Math.max(20, v));
    store.mutate((p) => { p.tempos[0].bpm = v; });
    e.target.blur();
  });
  $('inp-bpm').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); });
  $('btn-meter').onclick = () => {
    const m = new MeterMap(store.project.meters);
    meterDialog(m.tickToBBT(engine.currentTick()).bar);
  };

  function toggleRecord() {
    engine.ensureContext();
    if (engine.recording) { engine.stopRecording(); return; }
    const t = store.selectedTrack();
    if (!t || t.type !== 'instrument') { toast('Select an instrument track to record MIDI onto.'); return; }
    if (!engine.playing) engine.play();
    engine.startRecording(t.id);
    toast(`Recording on "${t.name}" — play your MIDI or computer keyboard.`);
  }

  engine.on('recorded', ({ trackId, notes }) => {
    const m = new MeterMap(store.project.meters);
    const first = Math.min(...notes.map((n) => n.tick));
    const last = Math.max(...notes.map((n) => n.tick + n.d));
    const start = m.snap(first, 'bar', 'floor');
    let end = m.snap(last, 'bar', 'floor');
    if (end < last) end = m.barToTick(Math.round(m.tickToBar(end)) + 1);
    const clip = newClip(start, Math.max(end - start, 1), notes.map((n) => ({ t: n.tick - start, d: n.d, p: n.p, v: n.v })));
    store.mutate((p) => { p.tracks.find((t) => t.id === trackId)?.clips.push(clip); });
    store.ui.selectedClipId = clip.id;
    timeline.updateSelection();
    toast(`Recorded ${notes.length} note${notes.length === 1 ? '' : 's'}.`);
  });

  // ---------- time signature dialog ----------
  function meterDialog(bar) {
    const p = store.project;
    const m = new MeterMap(p.meters);
    const cur = m.meterAtBar(bar);
    const existing = p.meters.find((x) => x.bar === bar);
    const barIn = h('input', { type: 'number', min: 1, max: 9999, value: bar + 1 });
    const numIn = h('input', { type: 'number', min: 1, max: 99, value: cur.num });
    const denSel = h('select', {}, VALID_DENOMINATORS.map((d) => h('option', { value: d, selected: d === cur.den }, String(d))));
    const grpIn = h('input', { type: 'text', value: cur.group || '', placeholder: 'e.g. 4+4+4+5 (optional)' });
    const err = h('div', { class: 'err' });
    const body = h('div', {},
      h('label', { class: 'row' }, h('span', {}, 'Starting at bar'), barIn),
      h('label', { class: 'row' }, h('span', {}, 'Beats per bar'), numIn),
      h('label', { class: 'row' }, h('span', {}, 'Beat unit'), denSel),
      h('label', { class: 'row' }, h('span', {}, 'Beat grouping'), grpIn),
      h('div', { class: 'hint' }, 'Any number of beats works — 4/4, 7/8, 11/8, 17/16, 13/32… Grouping sets where the metronome accents fall (17/16 as 4+4+4+5, 7/8 as 2+2+3). The change applies from that bar until the next change.'),
      err);
    const buttons = [{ label: 'Cancel' }];
    if (existing && bar > 0) {
      buttons.unshift({
        label: 'Remove change', kind: 'danger', left: true,
        onClick: () => store.mutate((pp) => { pp.meters = pp.meters.filter((x) => x.bar !== bar); }),
      });
    }
    buttons.push({
      label: 'Apply', kind: 'primary',
      onClick: () => {
        const b = Math.max(1, Math.floor(+barIn.value || 1)) - 1;
        const num = Math.floor(+numIn.value);
        const den = +denSel.value;
        const group = grpIn.value.replace(/\s+/g, '');
        if (!(num >= 1 && num <= 99)) { err.textContent = 'Beats per bar must be between 1 and 99.'; return false; }
        if (group && !parseGrouping(group, num)) { err.textContent = `Grouping must add up to ${num} (like ${suggestGroup(num)}).`; return false; }
        store.mutate((pp) => {
          pp.meters = pp.meters.filter((x) => x.bar !== b);
          pp.meters.push({ bar: b, num, den, group });
          pp.meters.sort((x, y) => x.bar - y.bar);
          // drop a redundant change identical to the one before it
          pp.meters = pp.meters.filter((x, i, arr) => i === 0 || !(arr[i - 1].num === x.num && arr[i - 1].den === x.den && (arr[i - 1].group || '') === (x.group || '')));
        });
        return true;
      },
    });
    openModal({ title: 'Time signature', body, buttons });
  }

  function suggestGroup(n) {
    const parts = [];
    let left = n;
    while (left > 4) { parts.push(left === 5 ? 3 : 4); left -= parts[parts.length - 1]; }
    if (left) parts.push(left);
    return parts.join('+');
  }

  // ---------- add track ----------
  $('btn-add-track').onclick = () => {
    const grid = h('div', { class: 'choice-grid' });
    let closeFn;
    const add = (type, preset) => {
      const t = newTrack(type, preset);
      store.mutate((p) => { p.tracks.push(t); });
      store.setUI({ selectedTrackId: t.id, selectedClipId: null });
      closeFn();
    };
    for (const pr of PRESETS) {
      grid.append(h('button', { class: 'choice', onclick: () => add('instrument', pr.id) },
        h('b', {}, h('span', { class: 'dot', style: { background: CATEGORY_COLORS[pr.category] } }), pr.name),
        h('small', {}, `${pr.category}${pr.mono ? ' · mono' : ''}`)));
    }
    grid.append(h('button', { class: 'choice', onclick: () => add('audio') },
      h('b', {}, h('span', { class: 'dot', style: { background: CATEGORY_COLORS.Audio } }), 'Audio Track'),
      h('small', {}, 'Vocals & mics · recording arrives in Phase 5')));
    closeFn = openModal({
      title: 'Add a track',
      body: h('div', {}, h('div', { class: 'section-label' }, 'Instruments'), grid,
        h('div', { class: 'hint', style: { marginTop: '10px' } }, 'Sampled instruments (grand piano, bass clarinet, strings…), the drum machine and the sampler arrive in the next phases.')),
      buttons: [{ label: 'Cancel' }],
      width: '520px',
    });
  };

  // ---------- songs (projects) ----------
  $('project-name').onclick = async () => {
    const v = await promptText('Rename song', store.project.name);
    if (v && v.trim()) store.mutate((p) => { p.name = v.trim(); });
  };

  $('btn-projects').onclick = async () => {
    await store.saveNow();
    const list = h('div', { class: 'proj-list' });
    let closeFn;
    const refresh = async () => {
      list.innerHTML = '';
      const items = await listProjects();
      if (!items.length) list.append(h('div', { class: 'hint' }, 'No saved songs yet.'));
      for (const it of items) {
        const isCur = it.id === store.project.id;
        list.append(h('div', { class: `proj ${isCur ? 'current' : ''}` },
          h('div', { class: 'pinfo' }, h('b', {}, it.name), h('small', {}, `${it.tracks} track${it.tracks === 1 ? '' : 's'} · ${new Date(it.modified).toLocaleString()}${isCur ? ' · open now' : ''}`)),
          isCur ? null : h('button', { class: 'btn', onclick: async () => { await openSong(it.id); closeFn(); } }, 'Open'),
          h('button', {
            class: 'btn danger',
            onclick: async () => {
              if (!(await confirmBox('Delete song?', `"${it.name}" will be permanently deleted from this computer.`, 'Delete', true))) return;
              await deleteProject(it.id);
              if (isCur) { closeFn(); store.load(newProject()); return; }
              refresh();
            },
          }, 'Delete')));
      }
    };
    await refresh();
    closeFn = openModal({
      title: 'Songs on this computer',
      body: h('div', {}, list,
        h('div', { class: 'hint', style: { marginTop: '10px' } }, 'Songs are saved automatically on this device. Use “Back up to file” to move a song to another computer, then “Open file” there.')),
      buttons: [
        { label: 'Back up to file', left: true, onClick: () => { exportProjectFile(store.project); return false; } },
        { label: 'Open file…', onClick: () => { importSong(); } },
        { label: 'Demo song', onClick: () => { store.load(demoProject()); } },
        { label: 'New song', kind: 'primary', onClick: () => { newSong(); } },
      ],
      width: '560px',
    });
  };

  async function openSong(id) {
    engine.stop();
    await store.saveNow();
    const p = await loadProject(id);
    if (p) store.load(migrateProject(p));
  }

  async function newSong() {
    engine.stop();
    await store.saveNow();
    const p = newProject();
    p.tracks.push(newTrack('instrument', 'soft-keys'));
    store.load(p);
    toast('New song created.');
  }

  async function importSong() {
    try {
      const data = await pickProjectFile();
      if (!data) return;
      engine.stop();
      await store.saveNow();
      const p = migrateProject(data);
      const existing = await loadProject(p.id);
      if (existing) p.id = `${p.id}_copy${Date.now().toString(36)}`;
      store.load(p);
      toast(`Opened "${p.name}".`);
    } catch (e) { toast(e.message); }
  }

  // ---------- live playing: MIDI + computer keyboard ----------
  const held = new Map(); // key -> {pitch, trackId}
  const liveTrack = () => {
    const t = store.selectedTrack();
    return t && t.type === 'instrument' ? t.id : null;
  };
  const midiHeld = new Map();
  const midi = new MidiInput({
    noteOn: (p, v) => { const id = liveTrack(); if (!id) return; midiHeld.set(p, id); engine.liveNoteOn(id, p, v); },
    noteOff: (p) => { const id = midiHeld.get(p) ?? liveTrack(); midiHeld.delete(p); if (id) engine.liveNoteOff(id, p); },
    sustain: (on) => { const id = liveTrack(); if (id) engine.liveSustain(id, on); },
    panic: () => engine.allLiveOff(),
    status: (text, devices) => {
      const el = $('midi-status');
      el.textContent = text;
      el.classList.toggle('on', devices.length > 0);
      el.title = devices.length ? devices.join('\n') : 'Plug in a USB MIDI keyboard — it will appear here automatically.';
    },
  });
  midi.init();

  const isTyping = (e) => ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) && e.target.type !== 'range';

  document.addEventListener('keydown', (e) => {
    if (isModalOpen() || isTyping(e)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) store.redo(); else store.undo(); return; }
    if (ctrl && e.code === 'KeyY') { e.preventDefault(); store.redo(); return; }
    if (ctrl && e.code === 'KeyS') { e.preventDefault(); store.saveNow(); toast('Saved.'); return; }
    if (ctrl && e.code === 'KeyD') { e.preventDefault(); duplicateClip(); return; }
    if (ctrl) return;
    if (e.code === 'Space') { e.preventDefault(); if (e.repeat) return; if (document.activeElement?.blur) document.activeElement.blur(); togglePlay(); return; }
    if (e.code === 'Home' || e.code === 'Enter') { e.preventDefault(); engine.setPosition(0); timeline.arrange.scrollLeft = 0; return; }
    if (e.code === 'KeyR') { if (!e.repeat) toggleRecord(); return; }
    if (e.code === 'Delete' || e.code === 'Backspace') { deleteClip(); return; }
    if (e.code === 'KeyZ') { store.ui.octave = Math.max(0, store.ui.octave - 1); renderStatus(); return; }
    if (e.code === 'KeyX') { store.ui.octave = Math.min(8, store.ui.octave + 1); renderStatus(); return; }
    if (e.code === 'KeyC') { store.ui.kbVelocity = Math.max(10, store.ui.kbVelocity - 10); renderStatus(); return; }
    if (e.code === 'KeyV') { store.ui.kbVelocity = Math.min(127, store.ui.kbVelocity + 10); renderStatus(); return; }
    if (e.code in KEYMAP) {
      e.preventDefault();
      if (e.repeat || held.has(e.code)) return;
      const id = liveTrack();
      if (!id) { toast('Select an instrument track to play it.'); return; }
      const pitch = 12 * (store.ui.octave + 1) + KEYMAP[e.code];
      held.set(e.code, { pitch, trackId: id });
      engine.liveNoteOn(id, pitch, store.ui.kbVelocity);
    }
  });
  document.addEventListener('keyup', (e) => {
    const n = held.get(e.code);
    if (n) { held.delete(e.code); engine.liveNoteOff(n.trackId, n.pitch); }
  });
  window.addEventListener('blur', () => {
    for (const n of held.values()) engine.liveNoteOff(n.trackId, n.pitch);
    held.clear();
  });

  function deleteClip() {
    const id = store.ui.selectedClipId;
    if (!id) return;
    store.mutate((p) => { for (const t of p.tracks) t.clips = t.clips.filter((c) => c.id !== id); });
    store.ui.selectedClipId = null;
  }

  function duplicateClip() {
    const found = store.findClip(store.ui.selectedClipId);
    if (!found) return;
    const copy = { ...JSON.parse(JSON.stringify(found.clip)), id: newClip(0, 0).id, start: found.clip.start + found.clip.length };
    store.mutate((p) => { p.tracks.find((t) => t.id === found.track.id).clips.push(copy); });
    store.ui.selectedClipId = copy.id;
    timeline.updateSelection();
  }

  // ---------- animation loop: playhead, position display, meters ----------
  function frame() {
    const tick = engine.currentTick();
    const p = store.project;
    const m = new MeterMap(p.meters);
    const tempo = new TempoMap(p.tempos);
    const bbt = m.tickToBBT(tick);
    const sub = Math.floor((bbt.tickInBeat / bbt.meter.beatTicks) * 1000);
    $('pos-bbt').textContent = `${bbt.bar + 1}.${bbt.beat + 1}.${String(sub).padStart(3, '0')}`;
    $('pos-time').textContent = `${formatTime(tempo.tickToSec(tick))} · ${bbt.meter.num}/${bbt.meter.den}`;
    const label = `${bbt.meter.num}/${bbt.meter.den}`;
    if (label !== lastMeterLabel) { $('btn-meter').textContent = label; lastMeterLabel = label; }
    timeline.updatePlayhead();
    if (engine.ctx) {
      headers.updateMeters();
      if (store.ui.mixerOpen) mixer.updateMeters();
    }
    requestAnimationFrame(frame);
  }

  // Audio can only start after a click/keypress — make the first one count.
  const unlock = () => { engine.ensureContext(); window.removeEventListener('pointerdown', unlock, true); window.removeEventListener('keydown', unlock, true); };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);

  // Save before the tab closes.
  window.addEventListener('beforeunload', () => { if (store.saveStatus !== 'saved') saveProject(store.project); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) store.saveNow(); });

  renderAll();
  renderStatus();
  renderSave();
  store.saveNow();
  requestAnimationFrame(frame);
  setupPWA();
}

function setupPWA() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker failed', e));
  }
  let deferred = null;
  const btn = $('btn-install');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    btn.hidden = false;
  });
  btn.onclick = async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    btn.hidden = true;
  };
  window.addEventListener('appinstalled', () => { btn.hidden = true; toast('benDAWmin is installed.'); });
}

boot().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<div style="padding:40px;color:#fff;font-family:system-ui">benDAWmin failed to start: ${String(e.message || e)}</div>`;
});

export { PPQ };
