# DAWG HAUS — Phase 6

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

## New in Phase 6

- Sampler tracks (+ Add Track → Sampler): get a sound by recording it from the mic, importing an audio file (WAV, MP3, OGG, M4A, FLAC), or picking a recorded take from an audio track
- The sound is trimmed to where it starts and ends, and its pitch is detected so the keys play it in tune
- Drag the START / END markers on the waveform; set the root note, Pitched (keys change pitch) or One-shot mode, Loop, Reverse, Attack, Release and Gain
- Play it on a MIDI keyboard, the computer keys, the Keyboard tab, or draw notes in the piano roll; record it like any instrument

## New in Phase 5

- Record vocals or any instrument onto Audio tracks: select the track and press ● (or R); press again to stop. Count-in works here too.
- Recording settings (Instrument tab on an audio track): microphone choice, input level meter, input gain, monitoring (hear yourself through the track and its effects — use headphones), and a timing adjust in case takes land early or late
- Takes are lined up automatically to remove the computer's audio delay, show as waveforms, can be moved, trimmed and split (Ctrl+S), and are saved on the device and inside Songs → Back up to file
- Autotune effect: key, scale (major, minor, pentatonic, blues, modes, chromatic), retune speed (0 ms = robotic "hard tune", 50–150 ms = natural), amount and mix. Works on playback and live while monitoring. "+ Add Autotune" on an audio track adds it in one click.

## Recent improvements

- New Carolina blue color scheme (and a blue dog house)
- Track colors: click the colored strip at the left of a track to pick a color (or go back to automatic)
- Count-in before recording: the Count-in button switches between off, 1 bar and 2 bars; the display counts down
- Piano roll: new notes copy the length of the last note you placed, resized or clicked; playing a key (side keyboard, MIDI or computer keys) lights up every note of that pitch
- On screens narrower than 1500px the panel buttons fold into one "Panels" button so the toolbar stays on one line

- ⟳ Repeat button on every MIDI and drum clip: click to play the section one more time; drag it right or left to repeat more or less (drag back to remove repeats, stop partway for half a repeat); Shift-click repeats to the end of the song; right-click for a menu (remove repeats, add half a repeat, double…). Editing the clip changes every repeat.
- Bigger loop strip at the top of the ruler: drag its ends to resize, drag the middle to move it, drag empty space for a new loop, click it to turn looping on/off
- Piano roll keys are narrower and rows shorter so more octaves fit; ↕−/↕+ change the row height (or Shift+Ctrl+scroll)
- Ctrl+S splits clips at the playhead (the selected clip, or every clip under the playhead on the selected track). Songs still save automatically.
- Piano roll: double-click to add a note; drag empty space to select notes

## New in Phase 4

- Effects on every track and on the master: EQ, Compressor, Distortion (overdrive, distortion, fuzz, bit crush), Filter (with tempo-synced wobble), Chorus, Phaser, Delay (tempo-synced, ping-pong), Reverb, and Tremolo / Auto-pan
  - Effects tab (or the FX button on a track): add, reorder, bypass and remove effects; double-click a slider to reset it
- Automation (A button on a track, or ⤴ next to an effect setting): lanes for volume, pan and effect settings
  - click to add points, drag to move them, double-click or right-click to delete; Alt ignores the grid
- Tempo lane (Tempo ⤴ button): add points to speed up or slow down the whole song; changes ramp smoothly, and tempo-synced delays and wobbles follow along

## New in Phase 3

- Drum machine tracks with 8 kits: 808, 909, Trap, Boom Bap, Lo-Fi, Electro, Studio and Latin Percussion (all synthesized, so they load instantly and work offline)
- Beat editor (double-click a drum clip):
  - step grid 1/4 to 1/32, plus triplets
  - click or drag to paint hits; Shift-click for an accent, Alt-click for a soft hit
  - swing control and a velocity lane for the selected pad
  - starter beats (Four on the Floor, Rock, Boom Bap, Trap, Disco, Reggaeton, Bossa Nova)
  - ± Bar to change the clip length
- Per-pad level, tune, decay and pan in the Instrument tab; switch kits at any time and the pattern keeps playing
- Keyboard tab shows drum pads; computer keys A, W, S, E… play pads in order; MIDI drum pads use standard General MIDI notes
- Drum hits record live like any other track

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
Double-click empty grid: add a note · drag empty grid: box-select (Shift adds) · double-click or right-click a note: delete ·
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
js/audio/drums.js           drum kits (synthesized voices) + starter beats
js/ui/drumeditor.js         beat editor (step sequencer)
js/audio/effects.js         insert effects
js/automation.js            automation targets + lane math
js/ui/fxpanel.js            Effects tab
js/ui/autolanes.js          automation + tempo lanes in the timeline
samples/                    instrument samples (see samples/CREDITS.txt)
js/ui/*.js                  timeline, track headers, mixer, modal helpers
sw.js, manifest.webmanifest PWA (offline + install)
```

## Next phases

7. WAV/MP3 export
