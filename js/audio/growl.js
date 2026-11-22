// A little dog growl, synthesized (no sample needed).
// Low buzzy voice + breath noise, chopped by a fast irregular flutter, through "mouth" formant filters.

export function growl(ctx, dest = ctx.destination) {
  const t = ctx.currentTime + 0.02;
  const dur = 1.1 + Math.random() * 0.4;
  const out = ctx.createGain();
  out.gain.value = 0.9;
  out.connect(dest);

  // overall envelope: swell in, rumble, fade
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(0.7, t + 0.18);
  env.gain.setValueAtTime(0.7, t + dur * 0.55);
  env.gain.linearRampToValueAtTime(0.95, t + dur * 0.7); // little snarl
  env.gain.exponentialRampToValueAtTime(0.001, t + dur);

  // flutter: amplitude chopped ~25-35 times a second (the "rrrr")
  const flutter = ctx.createGain();
  flutter.gain.value = 0.5;
  const lfo = ctx.createOscillator();
  lfo.type = 'square';
  lfo.frequency.setValueAtTime(27, t);
  lfo.frequency.linearRampToValueAtTime(34, t + dur * 0.7);
  lfo.frequency.linearRampToValueAtTime(24, t + dur);
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 0.45;
  lfo.connect(lfoDepth).connect(flutter.gain);

  // voice: low sawtooth with a wobbly pitch
  const voice = ctx.createOscillator();
  voice.type = 'sawtooth';
  const f0 = 70 + Math.random() * 15;
  voice.frequency.setValueAtTime(f0, t);
  voice.frequency.linearRampToValueAtTime(f0 * 1.25, t + dur * 0.65);
  voice.frequency.linearRampToValueAtTime(f0 * 0.9, t + dur);
  const wob = ctx.createOscillator();
  wob.frequency.value = 6.5;
  const wobDepth = ctx.createGain();
  wobDepth.gain.value = 6;
  wob.connect(wobDepth).connect(voice.frequency);
  const voiceGain = ctx.createGain();
  voiceGain.gain.value = 0.55;

  // breath: filtered noise
  const len = Math.ceil(ctx.sampleRate * (dur + 0.1));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = buf;
  const noiseBand = ctx.createBiquadFilter();
  noiseBand.type = 'bandpass';
  noiseBand.frequency.value = 500;
  noiseBand.Q.value = 0.8;
  const noiseGain = ctx.createGain();
  noiseGain.gain.value = 0.35;

  // grit
  const shaper = ctx.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) { const x = (i / 1023) * 2 - 1; curve[i] = Math.tanh(x * 3.5); }
  shaper.curve = curve;

  // mouth formants
  const f1 = ctx.createBiquadFilter(); f1.type = 'bandpass'; f1.frequency.value = 320; f1.Q.value = 2.5;
  const f2 = ctx.createBiquadFilter(); f2.type = 'bandpass'; f2.frequency.value = 850; f2.Q.value = 3;
  f2.frequency.linearRampToValueAtTime(1100, t + dur * 0.7);
  const f2g = ctx.createGain(); f2g.gain.value = 0.6;
  const low = ctx.createBiquadFilter(); low.type = 'lowpass'; low.frequency.value = 2200;

  voice.connect(voiceGain).connect(shaper);
  noise.connect(noiseBand).connect(noiseGain).connect(shaper);
  shaper.connect(flutter);
  flutter.connect(f1).connect(env);
  flutter.connect(f2).connect(f2g).connect(env);
  env.connect(low).connect(out);

  for (const o of [lfo, voice, wob, noise]) { o.start(t); o.stop(t + dur + 0.05); }
  setTimeout(() => { try { out.disconnect(); } catch { /* ignore */ } }, (dur + 0.3) * 1000);
}
