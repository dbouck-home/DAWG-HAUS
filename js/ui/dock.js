// Bottom dock: Piano Roll, Instrument, Mixer and on-screen Keyboard tabs.
import { PRESETS, CATEGORY_COLORS, getPreset, paramDefs, paramValue, colorForTrack } from '../audio/presets.js';
import { KEYMAP } from '../midi.js';
import { KITS, getKit, PAD_PARAMS, padSetting } from '../audio/drums.js';
import { audition } from '../audio/audition.js';
import { AUDIO_KINDS } from '../project.js';

/** "Pitch: A3 +12¢ · 220.8 Hz" for the part of the recording between the markers */
function pitchReadout(buf, s) {
  if (!buf) return null;
  const f = detectPitchExact(buf, s.start, s.end > s.start ? s.end : buf.duration);
  if (f == null) return h('span', { class: 'pitch-readout muted', title: 'No steady pitch found (drums and noises have none)' }, 'Pitch: —');
  const r = Math.round(f);
  const cents = Math.round((f - r) * 100);
  const hz = 440 * Math.pow(2, (f - 69) / 12);
  const off = r !== s.root || cents !== (s.fine || 0);
  return h('span', { class: `pitch-readout ${off ? 'off' : ''}`, title: off ? 'The root note setting doesn’t match — press Detect pitch to fix it' : 'The keyboard plays this sound in tune' },
    'Pitch: ', h('b', {}, noteName(r)), ` ${cents >= 0 ? '+' : ''}${cents}¢ · ${hz.toFixed(1)} Hz`);
}

/** small ▶ inside a picker button: hear the instrument/kit without choosing it */
function playChip(engine, what) {
  return h('span', {
    class: 'chip-play', role: 'button', title: 'Hear it',
    onclick: async (e) => {
      e.stopPropagation();
      const el = e.currentTarget;
      el.classList.add('playing');
      const secs = await audition(engine, what);
      setTimeout(() => el.classList.remove('playing'), secs * 1000);
    },
  }, '▶');
}
import { noteName, TempoMap } from '../timing.js';
import { SAMPLER_DEFAULTS, detectTrim, detectPitch, detectPitchExact } from '../audio/sampleinst.js';
import { saveAudio } from '../storage.js';
import { h } from './dom.js';

export const DOCK_TABS = [
  { id: 'pianoroll', label: 'Editor' },
  { id: 'instrument', label: 'Instrument' },
  { id: 'effects', label: 'Effects' },
  { id: 'mixer', label: 'Mixer' },
  { id: 'keyboard', label: 'Keyboard' },
  { id: 'chords', label: 'Chords' },
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
    if (t?.type === 'audio') { this.renderAudio(t); return; }
    if (t?.type === 'sampler') { this.renderSampler(t); return; }
    if (!t || t.type !== 'instrument') {
      this.root.append(h('div', { class: 'pane-empty' }, 'Select a track to see its sound settings.'));
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
        }, playChip(this.engine, { type: 'instrument', preset: p.id }), p.name, p.kind === 'synth' ? h('small', {}, ' synth') : null));
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
        h('div', { class: 'hint' }, 'Press ▶ on any instrument to hear it before switching. Effects live in the Effects tab.'))));
  }
}

InstrumentPanel.prototype.renderAudio = function renderAudio(t) {
  const eng = this.engine;
  const inp = t.input || {};
  const setInput = (patch, opts) => this.store.mutate((pp) => {
    const x = pp.tracks.find((y) => y.id === t.id);
    x.input = { ...(x.input || {}), ...patch };
  }, opts);
  const left = h('div', { class: 'inst-right' });
  const open = async (deviceId, channel) => {
    try { await eng.openInput(deviceId, channel); eng.syncInput(t.id); } catch (e) { alert(`That input could not be opened: ${e.message}`); }
    this.render();
  };
  // input list (names appear once the browser has microphone permission)
  const devSel = h('select', {
    onchange: (e) => { setInput({ deviceId: e.target.value }); if (eng.input) open(e.target.value, inp.channel || 'both'); },
  }, h('option', { value: '' }, 'Default input (set by your computer)'));
  navigator.mediaDevices?.enumerateDevices().then((devs) => {
    const ins = devs.filter((x) => x.kind === 'audioinput' && x.deviceId !== 'default' && x.deviceId !== 'communications');
    ins.forEach((d, i) => devSel.append(h('option', { value: d.deviceId, selected: d.deviceId === inp.deviceId }, d.label || `Input ${i + 1} (turn on the microphone to see its name)`)));
  });
  const chanSel = h('select', {
    title: 'Audio interfaces put each mic or instrument on its own input',
    onchange: (e) => { setInput({ channel: e.target.value }); if (eng.input) open(inp.deviceId, e.target.value); },
  },
  h('option', { value: 'both', selected: (inp.channel || 'both') === 'both' }, 'Inputs 1 + 2 (mixed)'),
  h('option', { value: '1', selected: inp.channel === '1' }, 'Input 1 only (left)'),
  h('option', { value: '2', selected: inp.channel === '2' }, 'Input 2 only (right)'));
  left.append(
    h('div', { class: 'prow' }, h('span', { class: 'plabel' }, 'Input device'), devSel,
      h('button', { class: 'pbtn', title: 'Look for newly plugged-in devices', onclick: () => this.render() }, '↻')),
    h('div', { class: 'prow' }, h('span', { class: 'plabel' }, 'Input channel'), chanSel,
      h('span', { class: 'pval' }, eng.input ? `${eng.input.channels} ch` : '')));
  if (!eng.input) {
    left.append(
      h('div', { class: 'hint' }, 'To record vocals or an instrument, DAWG HAUS needs to use your microphone or audio interface. Chrome will ask for permission the first time.'),
      h('button', { class: 'pbtn accent big', onclick: () => open(inp.deviceId, inp.channel || 'both') }, '🎙 Turn on input'));
  } else {
    this.inputMeter = h('i');
    const gainLabel = h('span', { class: 'pval' }, `${(inp.gain || 0) > 0 ? '+' : ''}${(inp.gain || 0).toFixed(1)} dB`);
    const lat = +localStorage.getItem('dawg:latencyMs') || 0;
    const latLabel = h('span', { class: 'pval' }, `${lat > 0 ? '+' : ''}${lat} ms`);
    left.append(
      h('div', { class: 'prow' }, h('span', { class: 'plabel' }, 'Input level'), h('div', { class: 'in-meter' }, this.inputMeter), h('span', { class: 'pval' }, '')),
      h('div', { class: 'prow' }, h('span', { class: 'plabel' }, 'Input gain'),
        h('input', {
          type: 'range', min: -24, max: 24, step: 0.5, value: inp.gain || 0,
          oninput: (e) => { const v = +e.target.value; gainLabel.textContent = `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`; setInput({ gain: v }, { merge: `ingain:${t.id}`, silent: true }); eng.syncInput(t.id); },
        }), gainLabel),
      h('label', { class: 'prow chkrow' }, h('span', { class: 'plabel' }, 'Monitoring'),
        h('span', { class: 'chk' }, h('input', { type: 'checkbox', checked: !!inp.monitor, onchange: (e) => { setInput({ monitor: e.target.checked }); } }), ' hear yourself through this track (with its effects) — use headphones'), h('span')),
      h('div', { class: 'prow' }, h('span', { class: 'plabel', title: 'If recordings land a little late or early, nudge this' }, 'Timing adjust'),
        h('input', {
          type: 'range', min: -100, max: 300, step: 1, value: lat,
          oninput: (e) => { localStorage.setItem('dawg:latencyMs', e.target.value); latLabel.textContent = `${+e.target.value > 0 ? '+' : ''}${e.target.value} ms`; },
        }), latLabel),
      h('div', { class: 'hint' }, `Using “${eng.input.label}”. If the level meter doesn’t move, try the other Input channel, or check the interface’s gain knob and that its USB cable is plugged in. Recordings are lined up automatically (about ${Math.round(eng.recordLatency * 1000)} ms of delay removed).`));
  }
  const hasTune = (t.fx || []).some((f) => f.type === 'autotune');
  const right = h('div', { class: 'inst-right' },
    h('div', { class: 'inst-cat-name', style: { color: CATEGORY_COLORS.Audio } }, 'How to record'),
    h('ol', { class: 'steps' },
      h('li', {}, 'Pick your input device (audio interface or mic) and channel, then turn it on.'),
      h('li', {}, 'Select this track, put the playhead where you want to start (Count-in helps).'),
      h('li', {}, 'Press ● Record (or R). Press it again, or Stop, to finish the take.')),
    h('div', { class: 'inst-cat-name', style: { color: CATEGORY_COLORS.Audio } }, 'Autotune'),
    hasTune
      ? h('div', { class: 'hint' }, 'Autotune is on this track. Set the key, scale and retune speed in the Effects tab (it works on playback and while monitoring).')
      : h('button', {
        class: 'pbtn accent', onclick: () => {
          this.store.mutate((pp) => {
            const x = pp.tracks.find((y) => y.id === t.id);
            x.fx = [{ id: `fx_${Date.now().toString(36)}`, type: 'autotune', on: true, params: { key: '0', scale: 'major', speed: 20, amount: 1, mix: 1 } }, ...(x.fx || [])];
          });
          this.onShowEffects?.();
        },
      }, '+ Add Autotune'),
    h('div', { class: 'hint' }, 'Retune speed 0 ms gives the robotic "hard tune" sound; 50–150 ms sounds natural. Set the song\u2019s key and scale for the best result.'));
  this.root.append(
    h('div', { class: 'inst-head' },
      h('span', { class: 'dot', style: { background: colorForTrack(t) } }), h('b', {}, t.name),
      h('span', { class: 'muted' }, eng.input ? ` · 🎙 ${eng.input.label}` : ' · input off'),
      h('div', { class: 'spacer' }),
      h('label', { class: 'field', title: 'What this track records — it names the track, and Drum Recording tracks can be turned into MIDI' }, h('span', {}, 'Type'),
        h('select', { onchange: (e) => this.store.mutate((pp) => { pp.tracks.find((y) => y.id === t.id).audioKind = e.target.value; }) },
          AUDIO_KINDS.map(([id, label]) => h('option', { value: id, selected: (t.audioKind || 'other') === id }, label))))),
    h('div', { class: 'inst-body' }, left, right));
};

// ---------- sampler ----------
InstrumentPanel.prototype.renderSampler = function renderSampler(t) {
  const eng = this.engine;
  const s = { ...SAMPLER_DEFAULTS, ...(t.sampler || {}) };
  const set = (patch, opts) => this.store.mutate((pp) => {
    const x = pp.tracks.find((y) => y.id === t.id);
    x.sampler = { ...SAMPLER_DEFAULTS, ...(x.sampler || {}), ...patch };
  }, opts);

  // store a new sound and point the sampler at it
  const useSound = async (data, sampleRate, name) => {
    const audioId = `aud_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await saveAudio({ id: audioId, sampleRate, data });
    const buf = eng.ctx.createBuffer(1, data.length, sampleRate);
    buf.copyToChannel(data, 0);
    eng.audioBuffers.set(audioId, buf);
    const trim = detectTrim(buf);
    const f = detectPitchExact(buf, trim.start, trim.end);
    const root = f == null ? 60 : Math.round(f);
    set({ audioId, name, start: trim.start, end: trim.end, root, fine: f == null ? 0 : Math.round((f - root) * 100) });
  };

  const left = h('div', { class: 'inst-right' });
  // --- sources ---
  const recBtn = h('button', { class: 'pbtn' }, '🎙 Record a sound');
  let recTimer = null;
  recBtn.onclick = async () => {
    if (eng.sampleRec) { eng.stopSampleRecording(); return; }
    try {
      const devId = this.store.project.tracks.find((x) => x.type === 'audio' && x.input?.deviceId)?.input.deviceId;
      await eng.openInput(devId);
    } catch (e) { alert(`The microphone could not be opened: ${e.message}`); return; }
    const t0 = Date.now();
    recBtn.classList.add('recording');
    recTimer = setInterval(() => {
      const sec = (Date.now() - t0) / 1000;
      recBtn.textContent = `■ Stop recording (${sec.toFixed(1)} s)`;
      if (sec > 60) eng.stopSampleRecording();
    }, 100);
    const res = await eng.startSampleRecording();
    clearInterval(recTimer);
    if (res && res.data.length > res.sampleRate * 0.05) await useSound(res.data, res.sampleRate, 'Recording');
    else this.render();
  };
  const fileIn = h('input', { type: 'file', accept: 'audio/*,.wav,.mp3,.ogg,.m4a,.flac', hidden: true });
  fileIn.onchange = async () => {
    const f = fileIn.files?.[0];
    if (!f) return;
    try {
      eng.ensureContext();
      const buf = await eng.ctx.decodeAudioData(await f.arrayBuffer());
      const mono = new Float32Array(buf.length);
      for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) mono[i] += d[i] / buf.numberOfChannels; }
      await useSound(mono, buf.sampleRate, f.name.replace(/\.[^.]+$/, '').slice(0, 30));
    } catch (e) { alert('That file could not be read as audio.'); }
  };
  const takes = [];
  for (const tr of this.store.project.tracks) for (const c of tr.clips) if (c.audioId) takes.push({ tr, c });
  const takeSel = h('select', {
    title: 'Use part of a recording from an audio track',
    onchange: (e) => {
      const tk = takes[+e.target.value];
      e.target.value = '';
      if (!tk) return;
      const tm = new TempoMap(this.store.project.tempos);
      const secs = tm.tickToSec(tk.c.start + tk.c.length) - tm.tickToSec(tk.c.start);
      set({ audioId: tk.c.audioId, name: tk.c.name || 'Take', start: tk.c.srcOffset || 0, end: (tk.c.srcOffset || 0) + secs });
    },
  }, h('option', { value: '' }, takes.length ? 'Use a recorded take…' : 'No recorded takes yet'), takes.map((tk, i) => h('option', { value: String(i) }, `${tk.tr.name} · ${tk.c.name || 'Take'}`)));
  left.append(h('div', { class: 'pgroup wrap' }, recBtn, h('button', { class: 'pbtn', onclick: () => fileIn.click() }, '📁 Import audio file'), takeSel, fileIn));

  // --- waveform with start / end markers ---
  const cv = h('canvas', { class: 'smp-wave' });
  const buf = s.audioId ? eng.audioBuffers.get(s.audioId) : null;
  if (s.audioId && !buf) eng.loadAudioBuffer(s.audioId)?.then(() => this.render());
  const drawWave = (st = s.start, en = s.end) => {
    const W = cv.clientWidth || 500;
    const H = 130;
    const dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#0b0d10'; g.fillRect(0, 0, W, H);
    if (!buf) {
      g.fillStyle = '#8b93a3'; g.font = '13px system-ui, sans-serif';
      g.fillText(s.audioId ? 'Loading…' : 'Record a sound, import a file, or pick a recorded take to start.', 12, H / 2);
      return;
    }
    const pk = eng.peaks(s.audioId, 256);
    const dur = buf.duration;
    const n = pk.data.length / 2;
    const x0 = (st / dur) * W; const x1 = ((en > st ? en : dur) / dur) * W;
    g.fillStyle = 'rgba(123,175,212,0.12)'; g.fillRect(x0, 0, x1 - x0, H);
    for (let x = 0; x < W; x++) {
      const i0 = Math.floor((x / W) * n); const i1 = Math.max(i0 + 1, Math.floor(((x + 1) / W) * n));
      let lo = 0; let hi = 0;
      for (let i = i0; i < i1 && i < n; i++) { lo = Math.min(lo, pk.data[i * 2]); hi = Math.max(hi, pk.data[i * 2 + 1]); }
      g.fillStyle = x >= x0 && x <= x1 ? '#7bafd4' : '#3a414e';
      g.fillRect(x, H / 2 - hi * H / 2, 1, Math.max(1, (hi - lo) * H / 2));
    }
    for (const [x, lab] of [[x0, 'START'], [x1, 'END']]) {
      g.fillStyle = '#e6f2fa'; g.fillRect(x - 1, 0, 2, H);
      g.fillRect(lab === 'START' ? x : x - 40, 0, 40, 14);
      g.fillStyle = '#06121c'; g.font = 'bold 9px system-ui, sans-serif';
      g.fillText(lab, lab === 'START' ? x + 5 : x - 35, 10);
    }
    g.fillStyle = '#8b93a3'; g.font = '11px system-ui, sans-serif';
    g.fillText(`${(en - st).toFixed(2)} s of ${dur.toFixed(2)} s${s.loop ? ' · loops between the markers' : ''}`, 8, H - 8);
  };
  cv.addEventListener('pointerdown', (e) => {
    if (!buf) return;
    const rect = cv.getBoundingClientRect();
    const dur = buf.duration;
    const secAt = (cx) => Math.max(0, Math.min(dur, ((cx - rect.left) / rect.width) * dur));
    const end0 = s.end > s.start ? s.end : dur;
    const sx = (s.start / dur) * rect.width; const ex = (end0 / dur) * rect.width;
    const x = e.clientX - rect.left;
    const which = Math.abs(x - sx) <= Math.abs(x - ex) ? 'start' : 'end';
    let st = s.start; let en = end0;
    cv.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const v = secAt(ev.clientX);
      if (which === 'start') st = Math.min(v, en - 0.01); else en = Math.max(v, st + 0.01);
      drawWave(st, en);
    };
    move(e);
    const up = () => { cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up); set({ start: st, end: en }); };
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up);
  });
  left.append(cv,
    h('div', { class: 'pgroup wrap' },
      h('button', { class: 'pbtn accent', disabled: !buf, onclick: () => eng.preview(t.id, s.root, 110, 1.5) }, '▶ Preview'),
      h('button', { class: 'pbtn', disabled: !buf, title: 'Move the markers to where the sound starts and ends', onclick: () => { const tr = detectTrim(buf); set({ start: tr.start, end: tr.end }); } }, '✂ Auto-trim'),
      h('button', {
        class: 'pbtn', disabled: !buf, title: 'Detect the sound\u2019s pitch so the keyboard plays it in tune',
        onclick: () => {
          const f = detectPitchExact(buf, s.start, s.end > s.start ? s.end : buf.duration);
          if (f == null) { alert('No clear pitch found — set the root note by hand.'); return; }
          const r = Math.round(f);
          set({ root: r, fine: Math.round((f - r) * 100) });
        },
      }, '🎯 Detect pitch'),
      pitchReadout(buf, s)),
    h('div', { class: 'hint' }, 'Drag the START and END markers on the waveform to choose the part that plays.'));
  requestAnimationFrame(() => drawWave());

  // --- settings ---
  const rootSel = h('select', { onchange: (e) => set({ root: +e.target.value, fine: 0 }) });
  for (let p = 24; p <= 96; p++) rootSel.append(h('option', { value: p, selected: p === s.root }, noteName(p)));
  const slider = (label, key, min, max, step, fmt) => {
    const lab = h('span', { class: 'pval' }, fmt(s[key]));
    return h('div', { class: 'prow' }, h('span', { class: 'plabel' }, label),
      h('input', { type: 'range', min, max, step, value: s[key], oninput: (e) => { const v = +e.target.value; lab.textContent = fmt(v); set({ [key]: v }, { merge: `smp:${t.id}:${key}`, silent: true }); } }), lab);
  };
  const ms = (v) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`);
  const right = h('div', { class: 'inst-right' },
    h('div', { class: 'prow' }, h('span', { class: 'plabel', title: 'The key that plays the sound at its original pitch' }, 'Root note'), rootSel, h('span')),
    h('div', { class: 'prow' }, h('span', { class: 'plabel' }, 'Play mode'),
      h('select', { onchange: (e) => set({ mode: e.target.value }) },
        h('option', { value: 'pitched', selected: s.mode === 'pitched' }, 'Pitched — keys change the pitch'),
        h('option', { value: 'oneshot', selected: s.mode === 'oneshot' }, 'One-shot — same sound on every key')), h('span')),
    h('label', { class: 'prow chkrow' }, h('span', { class: 'plabel' }, 'Loop'), h('span', { class: 'chk' }, h('input', { type: 'checkbox', checked: s.loop, onchange: (e) => set({ loop: e.target.checked }) }), ' repeat between the markers while a key is held'), h('span')),
    h('label', { class: 'prow chkrow' }, h('span', { class: 'plabel' }, 'Reverse'), h('span', { class: 'chk' }, h('input', { type: 'checkbox', checked: s.reverse, onchange: (e) => set({ reverse: e.target.checked }) }), ' play the sound backwards'), h('span')),
    slider('Attack', 'attack', 0.001, 2, 0.001, ms),
    slider('Release', 'release', 0.01, 4, 0.01, ms),
    slider('Gain', 'gain', -24, 12, 0.5, (v) => `${v > 0 ? '+' : ''}${(+v).toFixed(1)} dB`),
    h('div', { class: 'hint' }, 'Play the sample on your MIDI keyboard, the computer keys, the Keyboard tab, or draw notes in the piano roll. Add effects in the Effects tab.'));
  this.root.append(
    h('div', { class: 'inst-head' },
      h('span', { class: 'dot', style: { background: colorForTrack(t) } }), h('b', {}, t.name),
      h('span', { class: 'muted' }, s.audioId ? ` · root ${noteName(s.root)} · ${s.mode === 'pitched' ? 'pitched' : 'one-shot'}` : ' · no sound loaded yet'),
      h('div', { class: 'spacer' }),
      s.name ? h('input', { class: 'smp-name', value: s.name, title: 'Sample name (the track is named after it)', onchange: (e) => set({ name: e.target.value.slice(0, 30) }) }) : null),
    h('div', { class: 'inst-body' }, left, right));
};

InstrumentPanel.prototype.renderDrums = function renderDrums(t) {
  const kit = getKit(t.drums.kit);
  const pick = h('div', { class: 'inst-pick' });
  const group = h('div', { class: 'inst-cat' }, h('div', { class: 'inst-cat-name', style: { color: CATEGORY_COLORS.Drums } }, 'Drum kits'));
  for (const k of KITS) {
    group.append(h('button', {
      class: `inst-btn ${k.id === kit.id ? 'active' : ''}`,
      onclick: () => this.store.mutate((pp) => { pp.tracks.find((y) => y.id === t.id).drums = { kit: k.id, pads: {} }; }),
    }, playChip(this.engine, { type: 'drums', kit: k.id }), k.name, h('small', {}, ` ${k.pads.length} pads`)));
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
    engine.on('bend', (v) => this.showBend?.(v));
  }

  /** Pitch-bend wheel: drag up/down, springs back to the middle when let go. */
  bendWheel() {
    const range = () => this.store.ui.bendRange || 2;
    const knob = h('div', { class: 'bend-knob' });
    const slot = h('div', { class: 'bend-slot', title: 'Pitch bend — drag up or down; it springs back when you let go' }, h('div', { class: 'bend-mid' }), knob);
    const readout = h('div', { class: 'bend-val' }, '0');
    const show = (v) => {
      knob.style.top = `${50 - v * 42}%`;
      readout.textContent = v === 0 ? '0' : `${v > 0 ? '+' : ''}${(v * range()).toFixed(1)}`;
    };
    this.showBend = show;
    const apply = (v) => { const id = this.liveTrack(); if (id) this.engine.liveBend(id, v * range()); show(v); };
    let dragging = false;
    const fromY = (y) => { const r = slot.getBoundingClientRect(); return Math.max(-1, Math.min(1, ((r.top + r.height / 2) - y) / (r.height * 0.42))); };
    slot.addEventListener('pointerdown', (e) => { dragging = true; slot.setPointerCapture(e.pointerId); apply(fromY(e.clientY)); });
    slot.addEventListener('pointermove', (e) => { if (dragging) apply(fromY(e.clientY)); });
    const release = () => {
      if (!dragging) return;
      dragging = false;
      // glide back to centre like a real spring-loaded wheel
      const id = this.liveTrack();
      if (id) this.engine.liveBend(id, 0);
      knob.classList.add('spring'); show(0);
      setTimeout(() => knob.classList.remove('spring'), 160);
    };
    slot.addEventListener('pointerup', release);
    slot.addEventListener('pointercancel', release);
    const rangeSel = h('select', { class: 'bend-range', title: 'How far the wheel bends', onchange: (e) => { this.store.ui.bendRange = +e.target.value; } },
      [1, 2, 7, 12].map((n) => h('option', { value: n, selected: n === range() }, `±${n}`)));
    show(0);
    return h('div', { class: 'bend' }, h('div', { class: 'bend-label' }, 'Bend'), slot, readout, rangeSel);
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
      h('div', { class: 'okb-row' }, this.bendWheel(), wrap));
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
