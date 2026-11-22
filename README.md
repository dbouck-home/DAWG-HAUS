# benDAWmin — Phase 1

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

Upload the changed files, then raise `VERSION` in `sw.js` (for example `v0.1.1`).
Installed copies pick up the update the next time they're opened.

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
js/audio/presets.js         instrument presets
js/ui/*.js                  timeline, track headers, mixer, modal helpers
sw.js, manifest.webmanifest PWA (offline + install)
```

## Next phases

2. Piano roll (grid down to 1/32, triplets, velocity, quantize) and sampled instruments
3. Drum machine with preset kits
4. Effects and automation (including tempo automation)
5. Audio/vocal recording with monitoring and autotune
6. Sampler
7. WAV/MP3 export
