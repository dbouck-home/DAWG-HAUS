// Pitch bend + global tuning shared by the melodic instruments.
// Each voice keeps a list of detune params; `tuning.cents` (song tuning, A4 ≠ 440) is read when a note
// starts, and setBend() glides every sounding voice to the new bend.

export function detuneNow(inst) {
  return (inst.tuning?.cents || 0) + (inst.bend || 0);
}

/** Remember a voice's detune params so a later bend can move them. base = the param's own detune in cents. */
export function trackDetune(inst, voice, params) {
  voice.tune = inst.tuning?.cents || 0;
  voice.detunes = params;
}

export function applyBend(inst, cents, time = inst.ctx.currentTime) {
  inst.bend = cents;
  for (const v of inst.voices) {
    if (!v.detunes || (v.releasedAt && v.releasedAt < time)) continue;
    for (const d of v.detunes) {
      d.param.cancelScheduledValues(time);
      d.param.setTargetAtTime(d.base + v.tune + cents, time, 0.006);
    }
  }
}
