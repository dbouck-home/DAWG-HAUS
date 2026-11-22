# DAWG HAUS — Phase 2

A browser-based digital audio workstation (PWA) for Windows 11 and Chromebooks.
Plain HTML/CSS/JavaScript with no build step: upload the folder to any static host and it runs.

## Put it online (GitHub Pages, free)

1. Create a new repository on GitHub (for example `bendawmin`).
2. Upload everything in this folder to the repository's main branch (on the GitHub website: **Add file → Upload files**, then drag the contents in).
3. Go to **Settings → Pages**, set **Source** to *Deploy from a branch*, pick `main` and `/ (root)`, then click **Save**.
4. After a minute, the app is at `https://<your-username>.github.io/bendawmin/`.
5. Open that link in Chrome on the Chromebook or Windows PC and click **Install app** (in the top bar, or the install icon in the address bar).

Netlify Drop (app.netlify.com/drop) also works: drag the folder onto the page.

To try it on your own PC first, run `python -m http.server 8000` in this folder and open `http://localhost:8000`.
Opening `index.html` directly from disk will **not** work, because browsers block app modules on `file://`.

## Updating

Upload the changed files, then raise `VERSION` in `sw.js` (for example `dawghaus-v0.2.1`).
Installed copies pick up the update the next time they're opened.

## New in Phase 2

- Renamed to DAWG HAUS, with a dog-house icon. Click the dog house to make it growl.
- 21 sampled instruments: Grand Piano, Organ, Harmonium, Flute, Clarinet, Bass Clarinet, Bassoon, Saxophone, Trumpet, Trombone, French Horn, Tuba, Violin, Cello, Double Bass, Harp, Acoustic/Nylon/Electric Guitar, Electric Bass and Xylophone. Samples download the first time an instrument is used, then work offline.
- Instrument panel: gain, brightness, resonance, attack, release, transpose and velocity response for sampled instruments, plus filter sweep, decay, sustain, detune and glide for synths. Settings are saved per track; double-click a slider to reset it.
- Piano roll (double-click a clip):
  - grid 1/1 to 1/32, plus triplets (1/4T, 1/8T, 1/16T, 1/32T)
  - draw, move, resize and delete notes; box-select
  - velocity lane: drag across the bars to set velocity
  - quantize with strength, swing and optional note ends; Q repeats the last quantize
  - transpose, nudge, copy/paste and duplicate
  - click the piano keys to hear notes
- On-screen keyboard tab (click or drag across the keys; it also lights up when you play MIDI)
- Bottom panel with Piano Roll, Instrument, Mixer and Keyboard tabs; drag its top edge to resize it

### Piano roll shortcuts
Click empty grid: add a note (drag to set its length) · Shift+drag: box-select · double-click or right-click a note: delete ·
drag a note's right edge: resize · Alt while dragging: ignore the grid · ↑/↓: transpose (Shift = octave) · ←/→: nudge by the grid ·
Ctrl+A/C/V/D: select all / copy / paste / duplicate · Q: quantize · Del: delete selected notes

## What's in Phase 1

- Transport: play/pause (Space), stop, go to start (Home), record (R), loop, metronome with accents
- Any time signature (1–99 beats over 1/2/4/8/16/32/64), with changes mid-song and beat grouping such as 17/16 = 4+4+4+5
- Tempo (BPM)
- Tracks that name themselves after their instrument ("Synth String Pad", "Synth String Pad 2", "Audio"). Double-click a name to rename it; clear the name to go back to automatic naming.
- Six synth instruments: Soft Keys, Analog Mono Synth (mono with glide), Synth String Pad, Brass Synth Hit, Sub Bass, Square Lead
- MIDI keyboards work automatically (hot-plug, velocity, sustain pedal), and the computer keyboard plays notes too (A–K; Z/X octave; C/V velocity)
- MIDI recording onto the selected track
- Clips: move (including to another track), resize, delete (Del), duplicate (Ctrl+D), and double-click a lane to make an empty clip
- Mixer with volume, pan, mute/solo and level meters, plus a master channel with a safety limiter
- Undo/redo, songs auto-saved on the device, and backing up/opening song files to move songs between computers
- Works offline once installed

## Code map

```
index.html, css/app.css     layout + dark theme
js/main.js                  wiring, dialogs, keyboard, MIDI routing
js/timing.js                ticks, time signatures, tempo map, snapping
js/store.js                 project state, undo/redo, autosave
js/project.js               song data model, automatic track names, demo song
js/storage.js               IndexedDB + song backup files
js/midi.js                  Web MIDI input
js/audio/engine.js          scheduler, mixer channels, metronome, recording
js/audio/synth.js           synthesizer voice engine
js/audio/presets.js         instrument presets + adjustable parameters
js/audio/sampler.js         sampled-instrument engine
js/audio/growl.js           the dog house growl
js/ui/pianoroll.js          piano roll editor
js/ui/dock.js               bottom panel, instrument panel, on-screen keyboard
samples/                    instrument samples (see samples/CREDITS.txt)
js/ui/*.js                  timeline, track headers, mixer, modal helpers
sw.js, manifest.webmanifest PWA (offline + install)
```

## Next phases

3. Drum machine with preset kits
4. Effects and automation (including tempo automation)
5. Audio/vocal recording with monitoring and autotune
6. Sampler
7. WAV/MP3 export
