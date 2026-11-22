// DAWG HAUS — app entry point. Wires the store, audio engine and UI together.
import { MeterMap, TempoMap, SNAP_OPTIONS, VALID_DENOMINATORS, formatTime, parseGrouping, PPQ } from './timing.js';
import { Store } from './store.js';
import { Engine } from './audio/engine.js';
import { PRESETS, CATEGORY_COLORS } from './audio/presets.js';
import { growl } from './audio/growl.js';
import { PianoRoll } from './ui/pianoroll.js';
import { Dock, InstrumentPanel, OnscreenKeyboard } from './ui/dock.js';
import { BeatEditor } from './ui/drumeditor.js';
import { FxPanel } from './ui/fxpanel.js';
import { renderSong, encodeWav, encodeMp3, normalize, download, songEndTick } from './export.js';
import { KITS, getKit } from './audio/drums.js';
import { demoProject, newProject, newTrack, newClip, migrateProject, splitClip, uid } from './project.js';
import { loadProject, lastProjectId, listProjects, deleteProject, exportProjectFile, pickProjectFile, saveProject, importEmbeddedAudio, saveAudio } from './storage.js';
import { MidiInput, KEYMAP } from './midi.js';
import { Timeline } from './ui/timeline.js';
import { TrackHeaders, Mixer } from './ui/tracks.js';
import { h, openModal, promptText, confirmBox, toast, isModalOpen, popupMenu } from './ui/dom.js';

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
  Object.assign(store.ui, { dockOpen: false, dockTab: 'pianoroll', dockHeight: 340 });
  const timeline = new Timeline({ store, engine, onEditMeter: (bar) => meterDialog(bar), onOpenClip: (id) => openClip(id) });
  const headers = new TrackHeaders({
    store, engine,
    onMenu: (e, ids) => trackMenu(e, ids),
    onShowFx: (id) => { store.setUI({ selectedTrackId: id }); fxPanel.target = 'track'; dock.show('effects'); },
    onShowInstrument: (id) => { store.setUI({ selectedTrackId: id }); dock.show('instrument'); },
  });
  const mixer = new Mixer({ store, engine });
  const pianoRoll = new PianoRoll({ store, engine, root: $('pr-root') });
  const beatEditor = new BeatEditor({ store, engine, root: $('beat-root') });
  let editorMode = 'piano'; // 'piano' | 'beat'
  const editor = () => (editorMode === 'beat' ? beatEditor : pianoRoll);
  function setEditorMode(mode) {
    editorMode = mode;
    $('pr-root').hidden = mode !== 'piano';
    $('beat-root').hidden = mode !== 'beat';
  }
  const instPanel = new InstrumentPanel({ store, engine, root: $('inst-root') });
  instPanel.onShowEffects = () => dock.show('effects');
  const fxPanel = new FxPanel({ store, root: $('fx-root'), onAutomate: (trackId, target) => { headers.showAutomation(trackId, target); } });
  Object.assign(store.ui, { showTempo: false });
  const liveTrackId = () => { const t = store.selectedTrack(); return t && t.type !== 'audio' ? t.id : null; };
  const onscreenKb = new OnscreenKeyboard({ store, engine, root: $('kb-root'), liveTrack: liveTrackId });
  const dock = new Dock({ store, onChange: () => { renderDock(); renderTransportFields(); timeline.layout(); } });

  function renderDock() {
    if (!dock.open) return;
    if (dock.tab === 'pianoroll') editor().refresh();
    if (dock.tab === 'instrument') instPanel.render();
    if (dock.tab === 'effects') fxPanel.render();
    if (dock.tab === 'mixer') mixer.render();
    if (dock.tab === 'keyboard') onscreenKb.render();
  }

  function openClip(id) {
    const f = store.findClip(id);
    if (!f) return;
    if (f.track.type === 'audio') { store.setUI({ selectedTrackId: f.track.id, selectedClipId: id }); dock.show('instrument'); return; }
    store.ui.selectedClipId = id;
    store.ui.selectedTrackId = f.track.id;
    store.emit('selection');
    setEditorMode(f.track.type === 'drums' ? 'beat' : 'piano');
    editor().open(id);
    dock.show('pianoroll');
    editor().active = true;
  }
  window.dawgHaus = { store, engine }; // handy for debugging
  let lastMeterLabel = null;

  // ---------- rendering ----------
  function renderAll() {
    const p = store.project;
    $('project-name').textContent = p.name;
    document.title = `${p.name} — DAWG HAUS`;
    headers.render();
    timeline.render();
    renderDock();
    renderTransportFields();
    $('btn-undo').disabled = !store.canUndo();
    $('btn-redo').disabled = !store.canRedo();
  }

  function renderTransportFields() {
    const p = store.project;
    const bpmInput = $('inp-bpm');
    if (document.activeElement !== bpmInput) bpmInput.value = +p.tempos[0].bpm.toFixed(2);
    $('btn-loop').classList.toggle('active', p.loop.enabled);
    const ci = p.countIn || 0;
    $('btn-countin').textContent = ci ? `Count-in: ${ci} bar${ci > 1 ? 's' : ''}` : 'Count-in: off';
    $('btn-countin').classList.toggle('active', ci > 0);
    $('btn-metro').classList.toggle('active', p.metronome.enabled);
    $('inp-click-vol').value = p.metronome.volume;
    $('btn-play').classList.toggle('active', engine.playing);
    $('btn-record').classList.toggle('active', engine.recording);
    for (const tab of ['pianoroll', 'instrument', 'effects', 'mixer', 'keyboard']) $(`btn-tab-${tab}`).classList.toggle('active', dock.open && dock.tab === tab);
    $('btn-tempo-lane').classList.toggle('active', !!store.ui.showTempo);
    $('btn-panels').classList.toggle('active', dock.open);
    bpmInput.readOnly = p.tempos.length > 1;
    bpmInput.title = p.tempos.length > 1 ? 'The tempo changes during this song — edit it in the Tempo lane' : 'Tempo in beats (quarter notes) per minute';
    $('sel-snap').value = String(store.ui.snap);
    lastMeterLabel = null;
  }

  function renderStatus() {
    const oct = store.ui.octave;
    $('status-kb').innerHTML = `Computer keyboard: <kbd>A</kbd>–<kbd>K</kbd> play notes · <kbd>Z</kbd>/<kbd>X</kbd> octave (C${oct}) · <kbd>C</kbd>/<kbd>V</kbd> velocity (${store.ui.kbVelocity}) · <kbd>Space</kbd> play · <kbd>R</kbd> record · <kbd>Ctrl</kbd>+<kbd>S</kbd> split at playhead · <kbd>Del</kbd> delete · double-click a clip to edit notes · click the dog house 🐕`;
  }

  function renderSave() {
    const el = $('save-status');
    const s = store.saveStatus;
    el.className = `save-status ${s}`;
    el.textContent = s === 'saved' ? 'Saved' : s === 'saving' ? 'Saving…' : s === 'error' ? 'Save failed' : 'Unsaved changes';
  }

  store.subscribe((kind) => {
    if (kind === 'project' || kind === 'load') { engine.sync(); renderAll(); }
    if (kind !== 'save') engine.syncInput(store.ui.selectedTrackId);
    else if (kind === 'silent') { engine.sync(); }
    else if (kind === 'ui' || kind === 'selection') {
      headers.updateSelection(); mixer.updateSelection(); timeline.updateSelection();
      if (dock.open && (dock.tab === 'instrument' || dock.tab === 'keyboard' || dock.tab === 'effects')) renderDock();
      renderTransportFields(); renderStatus(); timeline.drawStatic();
    } else if (kind === 'save') renderSave();
    if (kind === 'project' || kind === 'silent' || kind === 'load') {
      $('btn-undo').disabled = !store.canUndo();
      $('btn-redo').disabled = !store.canRedo();
    }
  });
  engine.on('transport', renderTransportFields);
  engine.on('audio-loaded', () => timeline.render());
  engine.on('audio-recorded', async ({ trackId, startTick, data, sampleRate }) => {
    const audioId = `aud_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    try { await saveAudio({ id: audioId, sampleRate, data }); } catch (e) { toast(`Could not save the recording: ${e.message}`); return; }
    const buf = engine.ctx.createBuffer(1, data.length, sampleRate);
    buf.copyToChannel(data, 0);
    engine.audioBuffers.set(audioId, buf);
    const tm = new TempoMap(store.project.tempos);
    const endTick = Math.round(tm.secToTick(tm.tickToSec(startTick) + data.length / sampleRate));
    const tr = store.track(trackId);
    const n = (tr?.clips.length || 0) + 1;
    const clip = { ...newClip(startTick, endTick - startTick, []), audioId, srcOffset: 0, name: `Take ${n}` };
    store.mutate((p) => { p.tracks.find((t) => t.id === trackId)?.clips.push(clip); });
    store.ui.selectedClipId = clip.id;
    timeline.updateSelection();
    toast(`Saved Take ${n} (${(data.length / sampleRate).toFixed(1)} s).`);
  });
  engine.on('loading', () => { headers.render(); if (dock.open && dock.tab === 'instrument') instPanel.render(); });

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
  $('btn-countin').onclick = () => store.mutate((p) => { p.countIn = ((p.countIn || 0) + 1) % 3; });
  $('btn-loop').onclick = () => store.mutate((p) => { p.loop.enabled = !p.loop.enabled; });
  $('btn-metro').onclick = () => { engine.ensureContext(); store.mutate((p) => { p.metronome.enabled = !p.metronome.enabled; }); };
  $('inp-click-vol').oninput = (e) => store.mutate((p) => { p.metronome.volume = +e.target.value; }, { merge: 'clickvol', silent: true });
  $('btn-zoom-in').onclick = () => timeline.zoom(1.3);
  $('btn-zoom-out').onclick = () => timeline.zoom(1 / 1.3);
  $('btn-panels').onclick = () => { if (dock.open) dock.close(); else dock.show(dock.tab); };
  $('btn-tempo-lane').onclick = () => { store.ui.showTempo = !store.ui.showTempo; renderAll(); };
  for (const tab of ['pianoroll', 'instrument', 'effects', 'mixer', 'keyboard']) {
    $(`btn-tab-${tab}`).onclick = () => {
      if (tab === 'pianoroll' && !editor().clipId && store.ui.selectedClipId) { openClip(store.ui.selectedClipId); return; }
      dock.toggle(tab);
    };
  }
  $('arrange').addEventListener('pointerdown', () => { pianoRoll.active = false; beatEditor.active = false; }, true);
  $('logo').onclick = () => {
    const ctx = engine.ensureContext();
    growl(ctx);
    const logo = $('logo');
    logo.classList.add('growling');
    setTimeout(() => logo.classList.remove('growling'), 1300);
  };
  $('btn-undo').onclick = () => store.undo();
  $('btn-redo').onclick = () => store.redo();
  $('inp-bpm').addEventListener('change', (e) => {
    let v = parseFloat(e.target.value);
    if (!Number.isFinite(v)) v = store.project.tempos[0].bpm;
    v = Math.min(400, Math.max(20, v));
    if (store.project.tempos.length > 1) return;
    store.mutate((p) => { p.tempos[0].bpm = v; });
    e.target.blur();
  });
  $('inp-bpm').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); });
  $('btn-meter').onclick = () => {
    const m = new MeterMap(store.project.meters);
    meterDialog(m.tickToBBT(engine.currentTick()).bar);
  };

  async function toggleRecord() {
    engine.ensureContext();
    if (engine.audioRec) { engine.stopAudioRecording(); return; }
    if (engine.recording) { engine.stopRecording(); return; }
    const t = store.selectedTrack();
    if (!t) { toast('Select a track to record onto.'); return; }
    if (t.type === 'audio') {
      try {
        await engine.openInput(t.input?.deviceId, t.input?.channel || 'both');
      } catch (e) {
        toast('The microphone is blocked — allow it in Chrome (the camera/mic icon in the address bar).');
        return;
      }
      engine.syncInput(t.id);
      if (!engine.playing) engine.play(engine.positionTick, { countInBars: store.project.countIn || 0 });
      engine.startAudioRecording(t.id);
      toast(`Recording audio on "${t.name}" — press ● or R again to stop.`);
      if (dock.open && dock.tab === 'instrument') instPanel.render();
      return;
    }
    if (!engine.playing) engine.play(engine.positionTick, { countInBars: store.project.countIn || 0 });
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
    if (dock.open && dock.tab === 'pianoroll') openClip(clip.id);
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
    let closeFn;
    const add = (type, preset) => {
      const t = newTrack(type, preset);
      let clip = null;
      if (type === 'drums') {
        // start drum tracks with an empty 2-bar clip at the playhead's bar, ready to program
        const m = new MeterMap(store.project.meters);
        const bar = m.tickToBBT(engine.currentTick()).bar;
        const start = m.barToTick(bar);
        clip = newClip(start, m.barToTick(bar + 2) - start, []);
        t.clips.push(clip);
      }
      store.mutate((p) => { p.tracks.push(t); });
      store.setUI({ selectedTrackId: t.id, selectedClipId: clip?.id || null });
      closeFn();
      if (clip) openClip(clip.id);
    };
    const body = h('div', {});
    for (const cat of [...new Set(PRESETS.map((x) => x.category))]) {
      const g = h('div', { class: 'choice-grid' });
      for (const pr of PRESETS.filter((x) => x.category === cat)) {
        g.append(h('button', { class: 'choice', onclick: () => add('instrument', pr.id) },
          h('b', {}, h('span', { class: 'dot', style: { background: CATEGORY_COLORS[pr.category] } }), pr.name),
          h('small', {}, `${pr.kind === 'sample' ? 'sampled' : 'synth'}${pr.mono ? ' · mono' : ''}`)));
      }
      body.append(h('div', { class: 'section-label' }, cat), g);
    }
    const drumGrid = h('div', { class: 'choice-grid' });
    for (const k of KITS) {
      drumGrid.append(h('button', { class: 'choice', onclick: () => add('drums', k.id) },
        h('b', {}, h('span', { class: 'dot', style: { background: CATEGORY_COLORS.Drums } }), k.name),
        h('small', {}, `drum machine · ${k.pads.length} pads`)));
    }
    body.prepend(h('div', { class: 'section-label' }, 'Drums'), drumGrid);
    body.append(h('div', { class: 'section-label' }, 'Sampler'), h('div', { class: 'choice-grid' },
      h('button', { class: 'choice', onclick: () => { add('sampler'); dock.show('instrument'); } },
        h('b', {}, h('span', { class: 'dot', style: { background: CATEGORY_COLORS.Sampler } }), 'Sampler'),
        h('small', {}, 'record or import a sound, play it on the keys'))));
    body.append(h('div', { class: 'section-label' }, 'Audio'), h('div', { class: 'choice-grid' },
      h('button', { class: 'choice', onclick: () => add('audio') },
        h('b', {}, h('span', { class: 'dot', style: { background: CATEGORY_COLORS.Audio } }), 'Audio Track'),
        h('small', {}, 'vocals & mics · recording in Phase 5'))),
      h('div', { class: 'hint', style: { marginTop: '10px' } }, ''));
    closeFn = openModal({ title: 'Add a track', body, buttons: [{ label: 'Cancel' }], width: '720px' });
  };

  // ---------- export ----------
  $('btn-export').onclick = () => {
    const p = store.project;
    const hasLoop = p.loop.end > p.loop.start;
    const fmtSel = h('select', {},
      h('option', { value: 'mp3-320' }, 'MP3 · 320 kbps (best quality)'),
      h('option', { value: 'mp3-192', selected: true }, 'MP3 · 192 kbps (smaller file)'),
      h('option', { value: 'mp3-128' }, 'MP3 · 128 kbps (smallest)'),
      h('option', { value: 'wav-16' }, 'WAV · 16-bit (CD quality, large)'),
      h('option', { value: 'wav-24' }, 'WAV · 24-bit (studio, largest)'));
    const rangeSel = h('select', {},
      h('option', { value: 'song' }, 'Whole song'),
      hasLoop ? h('option', { value: 'loop' }, 'Loop region only') : null);
    const srSel = h('select', {}, h('option', { value: '44100', selected: true }, '44.1 kHz'), h('option', { value: '48000' }, '48 kHz'));
    const tailIn = h('input', { type: 'number', min: 0, max: 15, step: 0.5, value: 2 });
    const normChk = h('input', { type: 'checkbox', checked: true });
    const nameIn = h('input', { type: 'text', value: (p.name || 'song').replace(/[^\w\- ]+/g, '').trim() || 'song' });
    const bar = h('div', { class: 'xbar' }, h('i'));
    const status = h('div', { class: 'hint' }, `Renders every track with its instruments, effects, automation and tempo changes. Length: ${formatTime(new TempoMap(p.tempos).tickToSec(songEndTick(p)))}.`);
    let busy = false;
    openModal({
      title: 'Export song',
      body: h('div', {},
        h('label', { class: 'row' }, h('span', {}, 'File name'), nameIn),
        h('label', { class: 'row' }, h('span', {}, 'Format'), fmtSel),
        h('label', { class: 'row' }, h('span', {}, 'What to export'), rangeSel),
        h('label', { class: 'row' }, h('span', {}, 'Sample rate'), srSel),
        h('label', { class: 'row' }, h('span', {}, 'Ending tail (s)'), tailIn),
        h('label', { class: 'row' }, h('span', {}, 'Normalize'), h('span', { class: 'chk' }, normChk, ' make it as loud as possible without clipping')),
        bar, status),
      buttons: [
        { label: 'Close' },
        {
          label: 'Export', kind: 'primary',
          onClick: () => {
            if (busy) return false;
            busy = true;
            const [kind, q] = fmtSel.value.split('-');
            const setP = (f, msg) => { bar.firstChild.style.width = `${Math.round(f * 100)}%`; status.textContent = msg; };
            (async () => {
              try {
                engine.stop();
                setP(0, 'Rendering the song…');
                const buf = await renderSong(store.project, engine, {
                  range: rangeSel.value, sampleRate: +srSel.value, tail: Math.max(0, +tailIn.value || 0),
                  onProgress: (f) => setP(kind === 'mp3' ? f * 0.6 : f * 0.95, `Rendering… ${Math.round(f * 100)}%`),
                });
                if (normChk.checked) normalize(buf);
                let blob;
                if (kind === 'wav') { setP(0.97, 'Writing the WAV file…'); blob = encodeWav(buf, +q); }
                else blob = await encodeMp3(buf, +q, (f) => setP(0.6 + f * 0.4, `Encoding MP3… ${Math.round(f * 100)}%`));
                const fname = `${nameIn.value.trim() || 'song'}.${kind}`;
                download(blob, fname);
                setP(1, `Done — saved ${fname} (${(blob.size / 1048576).toFixed(1)} MB, ${formatTime(buf.duration)}). Check your Downloads folder.`);
              } catch (e) {
                console.error(e);
                setP(0, `Export failed: ${e.message}`);
              }
              busy = false;
            })();
            return false;
          },
        },
      ],
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
    p.tracks.push(newTrack('instrument', 'grand-piano'));
    store.load(p);
    toast('New song created.');
  }

  async function importSong() {
    try {
      const data = await pickProjectFile();
      if (!data) return;
      engine.stop();
      await store.saveNow();
      await importEmbeddedAudio(data);
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
    return t && t.type !== 'audio' ? t.id : null;
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

  // audio interfaces / mics plugged in or removed while the app is open
  let knownInputs = null;
  const scanInputs = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
    const ids = new Map(devs.map((d) => [d.deviceId, d.label || 'audio input']));
    if (knownInputs) {
      for (const [id, label] of ids) if (!knownInputs.has(id)) toast(`New audio input connected: ${label}. Choose it in an audio track's Instrument tab.`);
      for (const [id, label] of knownInputs) if (!ids.has(id)) toast(`Audio input disconnected: ${label}.`);
    }
    knownInputs = ids;
    if (dock.open && dock.tab === 'instrument' && store.selectedTrack()?.type === 'audio') instPanel.render();
  };
  scanInputs();
  navigator.mediaDevices?.addEventListener?.('devicechange', scanInputs);

  const isTyping = (e) => ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) && e.target.type !== 'range';

  document.addEventListener('keydown', (e) => {
    if (isModalOpen() || isTyping(e)) return;
    if (dock.open && dock.tab === 'pianoroll' && editor().handleKey(e)) { e.preventDefault(); return; }
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) store.redo(); else store.undo(); return; }
    if (ctrl && e.code === 'KeyY') { e.preventDefault(); store.redo(); return; }
    if (ctrl && e.code === 'KeyS') { e.preventDefault(); splitAtPlayhead(); return; }
    if (ctrl && e.code === 'KeyD') { e.preventDefault(); duplicateClip(); return; }
    if (ctrl && e.code === 'KeyC') { e.preventDefault(); copySelection(); return; }
    if (ctrl && e.code === 'KeyV') { e.preventDefault(); paste(); return; }
    if (ctrl) return;
    if (e.code === 'Space') { e.preventDefault(); if (e.repeat) return; if (document.activeElement?.blur) document.activeElement.blur(); togglePlay(); return; }
    if (e.code === 'Home' || e.code === 'Enter') { e.preventDefault(); engine.setPosition(0); timeline.arrange.scrollLeft = 0; return; }
    if (e.code === 'KeyR') { if (!e.repeat) toggleRecord(); return; }
    if (e.code === 'Delete' || e.code === 'Backspace') { deleteClip(); return; }
    if (e.code === 'KeyZ') { store.ui.octave = Math.max(0, store.ui.octave - 1); store.emit('ui'); return; }
    if (e.code === 'KeyX') { store.ui.octave = Math.min(7, store.ui.octave + 1); store.emit('ui'); return; }
    if (e.code === 'KeyC') { store.ui.kbVelocity = Math.max(10, store.ui.kbVelocity - 10); renderStatus(); return; }
    if (e.code === 'KeyV') { store.ui.kbVelocity = Math.min(127, store.ui.kbVelocity + 10); renderStatus(); return; }
    if (e.code in KEYMAP) {
      e.preventDefault();
      if (e.repeat || held.has(e.code)) return;
      const id = liveTrack();
      if (!id) { toast('Select an instrument or drum track to play it.'); return; }
      const sel = store.track(id);
      let pitch = 12 * (store.ui.octave + 1) + KEYMAP[e.code];
      if (sel.type === 'drums') {
        // computer keys play the kit's pads in order: A = first pad, W = second, ...
        const pad = getKit(sel.drums.kit).pads[KEYMAP[e.code]];
        if (!pad) return;
        pitch = pad.note;
      }
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

  /** Ctrl+S: cut clips in two at the playhead (the selected clip, or every clip under the playhead on the selected track). */
  function splitAtPlayhead() {
    const at = Math.round(engine.currentTick());
    const sel = store.findClip(store.ui.selectedClipId);
    let targets = [];
    // the selected clip wins, as long as it's on the selected track
    if (sel && sel.track.id === store.ui.selectedTrackId && at > sel.clip.start && at < sel.clip.start + sel.clip.length) targets = [{ track: sel.track, clip: sel.clip }];
    else {
      const t = store.selectedTrack();
      if (t) targets = t.clips.filter((c) => at > c.start && at < c.start + c.length).map((c) => ({ track: t, clip: c }));
    }
    if (!targets.length) { toast('Put the playhead over a clip (or select one) to split it with Ctrl+S.'); return; }
    let rightId = null;
    store.mutate((p) => {
      for (const { track, clip } of targets) {
        const tr = p.tracks.find((x) => x.id === track.id);
        const i = tr.clips.findIndex((c) => c.id === clip.id);
        const tm = new TempoMap(p.tempos);
        const parts = splitClip(tr.clips[i], at, (tk) => tm.tickToSec(tk));
        if (!parts) continue;
        tr.clips.splice(i, 1, ...parts);
        rightId = parts[1].id;
      }
    });
    if (rightId) { store.ui.selectedClipId = rightId; timeline.updateSelection(); }
    toast(`Split ${targets.length} clip${targets.length === 1 ? '' : 's'} at the playhead.`);
  }

  // ---------- track menu: merge, copy / paste, duplicate, delete ----------
  let clipboard = null; // { kind: 'tracks', tracks } | { kind: 'clip', trackType, clip }
  const family = (t) => (t.type === 'audio' ? 'audio' : 'notes');

  /** Deep copy of tracks with fresh ids (effects, lanes and clips too). */
  function cloneTracks(tracks) {
    return tracks.map((t) => {
      const c = JSON.parse(JSON.stringify(t));
      c.id = uid('trk');
      const fxMap = {};
      for (const f of c.fx || []) { const nid = uid('fx'); fxMap[f.id] = nid; f.id = nid; }
      for (const a of c.automation || []) {
        a.id = uid('au');
        if (a.target.startsWith('fx:')) { const [, id, k] = a.target.split(':'); a.target = `fx:${fxMap[id] || id}:${k}`; }
      }
      for (const cl of c.clips) cl.id = uid('clp');
      return c;
    });
  }

  function mergeTracks(ids) {
    const tracks = store.project.tracks.filter((t) => ids.includes(t.id));
    if (tracks.length < 2) return;
    if (new Set(tracks.map(family)).size > 1) { toast('Audio tracks can only be merged with other audio tracks.'); return; }
    const target = tracks[0];
    const others = tracks.slice(1).map((t) => t.id);
    let moved = 0;
    store.mutate((p) => {
      const tgt = p.tracks.find((t) => t.id === target.id);
      for (const t of p.tracks.filter((x) => others.includes(x.id))) { tgt.clips.push(...t.clips); moved += t.clips.length; }
      tgt.clips.sort((a, b) => a.start - b.start);
      p.tracks = p.tracks.filter((t) => !others.includes(t.id));
    });
    store.setUI({ selectedTrackId: target.id, selectedTrackIds: [target.id] });
    toast(`Merged ${tracks.length} tracks into "${store.track(target.id).name}" (${moved} clip${moved === 1 ? '' : 's'} moved; it keeps that track's sound and effects).`);
  }

  function copySelection() {
    if (store.ui.focus === 'clip' && store.ui.selectedClipId) {
      const f = store.findClip(store.ui.selectedClipId);
      if (f) { clipboard = { kind: 'clip', trackType: family(f.track), clip: JSON.parse(JSON.stringify(f.clip)) }; toast('Copied the clip — Ctrl+V pastes it at the playhead on the selected track.'); return; }
    }
    const ids = headers.multi();
    if (!ids.length) return;
    clipboard = { kind: 'tracks', tracks: JSON.parse(JSON.stringify(store.project.tracks.filter((t) => ids.includes(t.id)))) };
    toast(`Copied ${ids.length} track${ids.length === 1 ? '' : 's'} — Ctrl+V pastes ${ids.length === 1 ? 'it' : 'them'} below the selected track.`);
  }

  function paste() {
    if (!clipboard) { toast('Nothing copied yet — select a track (or clip) and press Ctrl+C.'); return; }
    if (clipboard.kind === 'tracks') {
      const copies = cloneTracks(clipboard.tracks);
      store.mutate((p) => {
        const sel = headers.multi();
        const lastSel = sel.length ? Math.max(...sel.map((id) => p.tracks.findIndex((t) => t.id === id))) : p.tracks.length - 1;
        p.tracks.splice(lastSel + 1, 0, ...copies);
      });
      store.setUI({ selectedTrackId: copies[0].id, selectedTrackIds: copies.map((t) => t.id) });
      toast(`Pasted ${copies.length} track${copies.length === 1 ? '' : 's'}.`);
      return;
    }
    const t = store.selectedTrack();
    if (!t || family(t) !== clipboard.trackType) { toast(clipboard.trackType === 'audio' ? 'Select an audio track to paste this clip.' : 'Select an instrument, drum or sampler track to paste this clip.'); return; }
    const m = new MeterMap(store.project.meters);
    const clip = { ...JSON.parse(JSON.stringify(clipboard.clip)), id: uid('clp'), start: m.snap(engine.currentTick(), store.ui.snap === 'off' ? 'beat' : store.ui.snap) };
    store.mutate((p) => { p.tracks.find((x) => x.id === t.id).clips.push(clip); });
    store.ui.selectedClipId = clip.id;
    store.ui.focus = 'clip';
    timeline.updateSelection();
  }

  function trackMenu(e, ids) {
    const tracks = store.project.tracks.filter((t) => ids.includes(t.id));
    const n = tracks.length;
    const canMerge = n >= 2 && new Set(tracks.map(family)).size === 1;
    popupMenu(e.clientX, e.clientY, [
      {
        label: n >= 2 ? `Merge ${n} tracks into one` : 'Merge tracks…',
        hint: n >= 2 ? (canMerge ? `→ ${tracks[0].name}` : 'audio + instruments can\u2019t mix') : 'Ctrl-click another track first',
        disabled: !canMerge, onClick: () => mergeTracks(ids),
      },
      '-',
      { label: n > 1 ? `Copy ${n} tracks` : 'Copy track', hint: 'Ctrl+C', onClick: () => { store.ui.focus = 'track'; copySelection(); } },
      { label: clipboard?.kind === 'tracks' ? `Paste ${clipboard.tracks.length > 1 ? `${clipboard.tracks.length} tracks` : 'track'}` : 'Paste track', hint: 'Ctrl+V', disabled: clipboard?.kind !== 'tracks', onClick: () => paste() },
      { label: n > 1 ? `Duplicate ${n} tracks` : 'Duplicate track', onClick: () => { store.ui.focus = 'track'; copySelection(); paste(); } },
      '-',
      {
        label: n > 1 ? `Delete ${n} tracks` : 'Delete track',
        onClick: async () => {
          if (!(await confirmBox('Delete tracks?', `${tracks.map((t) => `"${t.name}"`).join(', ')} will be deleted. You can undo this.`, 'Delete', true))) return;
          store.mutate((p) => { p.tracks = p.tracks.filter((t) => !ids.includes(t.id)); });
          store.fixSelection();
          store.emit('project');
        },
      },
    ]);
  }

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
    const left = engine.countInLeft();
    $('pos-bbt').textContent = left ? `Count ${left}` : `${bbt.bar + 1}.${bbt.beat + 1}.${String(sub).padStart(3, '0')}`;
    document.querySelector('.lcd').classList.toggle('counting', left > 0);
    $('pos-time').textContent = `${formatTime(tempo.tickToSec(tick))} · ${bbt.meter.num}/${bbt.meter.den}`;
    if (p.tempos.length > 1 && document.activeElement !== $('inp-bpm')) $('inp-bpm').value = tempo.bpmAt(tick).toFixed(1);
    if (engine.playing && (store.ui.showTempo || p.tracks.some((t) => t.showAuto))) timeline.drawLanes();
    const label = `${bbt.meter.num}/${bbt.meter.den}`;
    if (label !== lastMeterLabel) { $('btn-meter').textContent = label; lastMeterLabel = label; }
    timeline.updatePlayhead();
    if (engine.playing && dock.open && dock.tab === 'pianoroll') editor().draw();
    if (engine.ctx) {
      headers.updateMeters();
      if (instPanel.inputMeter?.isConnected) instPanel.inputMeter.style.width = `${Math.min(100, Math.sqrt(engine.inputPeak()) * 100)}%`;
      if (dock.open && dock.tab === 'mixer') mixer.updateMeters();
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
  window.addEventListener('appinstalled', () => { btn.hidden = true; toast('DAWG HAUS is installed.'); });
}

boot().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<div style="padding:40px;color:#fff;font-family:system-ui">DAWG HAUS failed to start: ${String(e.message || e)}</div>`;
});

export { PPQ };
