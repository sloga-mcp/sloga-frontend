/**
 * Voice changer: a pitch shift on the local microphone, set in semitones
 * from a single slider (left = lower, right = higher, centre = off).
 *
 * The shift itself runs on the audio thread in the self-hosted worklet
 * `public/voice-pitch/VoicePitchWorklet.js`, as one more stage inside the mic
 * pipeline (`voiceAudioPipeline.ts`): capture → noise filter → pitch →
 * voice shaper → input gain. Pitch goes before the shaper so a preset's EQ
 * shapes the voice people actually hear.
 *
 * This module is pure (no DOM, no AudioContext) so `node --test` can load
 * it: the range, the clamp the settings store applies, and the ratio the
 * worklet is driven with.
 *
 * Copy rule: this is a toy for messing around on calls. It moves your pitch
 * (formants move with it, which is the fun part); it does not make you
 * anonymous, and nothing in the UI may say or imply that it does.
 */

/** Lowest setting: one octave down. */
export const VOICE_PITCH_MIN = -12;

/** Highest setting: one octave up. */
export const VOICE_PITCH_MAX = 12;

/** Off. The pipeline wires straight past the pitch stage at 0. */
export const VOICE_PITCH_DEFAULT = 0;

/**
 * Normalize any stored or slider value to a whole semitone inside the range.
 * Non-numbers and NaN fall back to off rather than persisting garbage.
 */
export function clampVoicePitch(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return VOICE_PITCH_DEFAULT;
  }
  const rounded = Math.round(value);
  // `Math.round(-0.4)` is -0; keep the stored value a plain 0.
  if (rounded === 0) return 0;
  return Math.max(VOICE_PITCH_MIN, Math.min(VOICE_PITCH_MAX, rounded));
}

/** True when the pitch stage would change the signal at all. */
export function voicePitchIsActive(semitones: number): boolean {
  return clampVoicePitch(semitones) !== VOICE_PITCH_DEFAULT;
}

/** Playback-rate ratio for a shift of `semitones` (12 semitones = 2x). */
export function voicePitchRatio(semitones: number): number {
  return 2 ** (clampVoicePitch(semitones) / 12);
}

/** Slider / label text: "+3", "-5", "0". */
export function formatVoicePitch(semitones: number): string {
  const value = clampVoicePitch(semitones);
  return value > 0 ? `+${value}` : `${value}`;
}
