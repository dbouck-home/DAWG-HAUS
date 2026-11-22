// Background MP3 encoder (classic worker). Uses LAME (vendor/lame.min.js, LGPL — see vendor/LAME-LICENSE.txt).
/* global lamejs */
importScripts('../vendor/lame.min.js');

self.onmessage = (e) => {
  try {
    const { left, right, sampleRate, kbps } = e.data;
    const enc = new lamejs.Mp3Encoder(2, sampleRate, kbps);
    const block = 1152 * 20;
    const chunks = [];
    for (let i = 0; i < left.length; i += block) {
      const out = enc.encodeBuffer(left.subarray(i, i + block), right.subarray(i, i + block));
      if (out.length) chunks.push(new Uint8Array(out));
      if ((i / block) % 20 === 0) self.postMessage({ progress: i / left.length });
    }
    const end = enc.flush();
    if (end.length) chunks.push(new Uint8Array(end));
    self.postMessage({ done: true, chunks });
  } catch (err) {
    self.postMessage({ error: String(err && err.message || err) });
  }
};
