// Web MIDI input. Every connected MIDI keyboard plays the selected track.
// Devices can be plugged in or removed at any time.

export class MidiInput {
  constructor(handlers) {
    this.h = handlers; // { noteOn(p, v), noteOff(p), sustain(on), status(text, devices) }
    this.access = null;
    this.devices = [];
  }

  get supported() { return typeof navigator !== 'undefined' && !!navigator.requestMIDIAccess; }

  async init() {
    if (!this.supported) {
      this.h.status('MIDI not supported in this browser — use Chrome or Edge', []);
      return;
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (e) {
      this.h.status('MIDI access was blocked', []);
      return;
    }
    this.access.onstatechange = () => this.bind();
    this.bind();
  }

  bind() {
    this.devices = [];
    for (const input of this.access.inputs.values()) {
      if (input.state !== 'connected') continue;
      input.onmidimessage = (e) => this.onMessage(e.data);
      this.devices.push(input.name || 'MIDI device');
    }
    const text = this.devices.length
      ? `MIDI: ${this.devices.length === 1 ? this.devices[0] : `${this.devices.length} devices`}`
      : 'MIDI: no device';
    this.h.status(text, this.devices);
  }

  onMessage(data) {
    const [st, d1, d2] = data;
    const type = st & 0xf0;
    if (type === 0x90 && d2 > 0) this.h.noteOn(d1, d2);
    else if (type === 0x80 || (type === 0x90 && d2 === 0)) this.h.noteOff(d1);
    else if (type === 0xb0 && d1 === 64) this.h.sustain(d2 >= 64);
    else if (type === 0xb0 && (d1 === 123 || d1 === 120)) this.h.panic?.();
  }
}

// Computer keyboard as a piano: A W S E D F T G Y H U J K O L P
export const KEYMAP = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7,
  KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15,
  Semicolon: 16,
};
