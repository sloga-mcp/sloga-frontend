// Extension-qualified: this module is covered by a `node --test` spec, which
// resolves relative imports itself rather than through Vite.
import { VAD_OPEN_FRAMES } from "./vadLevel.ts";

/** Everything one voice-activity tick decides from. */
export type VadGateInputs = {
  /** 0-100 loudness this tick (`levelFromFrequencyData`). */
  level: number;
  /** The threshold in force — hand-set, or the tracked automatic one. */
  threshold: number;
  /** Nominal 60 fps frames this tick stands in for (>= 1). */
  frames: number;
  /** Frames above the threshold before this tick. */
  openStreak: number;
  /** Whether the published room microphone is live right now. */
  micLive: boolean;
  /**
   * The user's OWN mute or deafen — their explicit intent, not the state of
   * the published track (voice activity drives that from tick to tick).
   */
  userMuted: boolean;
  /** An aside is in progress; the room mic is deliberately suppressed. */
  whispering: boolean;
  /**
   * The analyser's `AudioContext` is `running`, so `level` is a real reading.
   * A suspended context (autoplay policy, an OS audio interruption) leaves
   * the analyser on silence, or on its last frame frozen, whatever the user
   * is saying.
   */
  analyserLive: boolean;
};

export type VadGateDecision = {
  /** Streak to carry into the next tick. */
  openStreak: number;
  /** Voice activity holds the gate open this tick. */
  speaking: boolean;
  /** The room microphone should be unmuted now. */
  open: boolean;
  /**
   * The silence countdown may run this tick. False cancels a pending one.
   */
  countdown: boolean;
};

/**
 * One tick of the voice-activity gate.
 *
 * Pure so the ways this gate can overrule its user are pinned by a spec
 * instead of by a live call:
 *
 * 1. **The user's own mute outranks voice activity.** The gate analyzes its
 *    OWN `getUserMedia` stream, which is a different capture from the one the
 *    call publishes — `setMicrophoneEnabled(false)` mutes the published track
 *    and leaves the gate's stream running at full level. Without `userMuted`
 *    here, a muted user who started talking was unmuted about 50 ms later and
 *    broadcast to the call while the button still read "muted" (reported
 *    2026-09-10; muting on the user's audio interface DID hold, because that
 *    silences the gate's stream as well, which is what identified this).
 *
 * 2. **The streak is counted in frames, not ticks.** The caller's timer can
 *    be stretched by a throttled window, and `VAD_OPEN_FRAMES` is expressed
 *    in 60 fps frames.
 *
 * 3. **No silence verdict without a live analyser.** A context that never
 *    ran reads zero, which is indistinguishable from a quiet room, and the
 *    countdown then mutes a working microphone for the rest of the call
 *    (reported 2026-10-18: "I join the call and can't talk"). While the
 *    analyser is not live the gate fails open: the countdown never runs and
 *    the microphone follows the user's own mute, deafen and whisper state,
 *    exactly as open mic would.
 *
 * The closing half stays with the caller: it owns the silence countdown, and
 * `countdown: true` only means the countdown may run, never that the
 * microphone is cut this instant.
 */
export function vadGateDecision(inputs: VadGateInputs): VadGateDecision {
  const suppressed = inputs.whispering || inputs.userMuted;

  if (!inputs.analyserLive) {
    return {
      openStreak: 0,
      speaking: false,
      open: !suppressed && !inputs.micLive,
      countdown: false,
    };
  }

  const speaking = inputs.level > inputs.threshold && !suppressed;

  if (!speaking) {
    return { openStreak: 0, speaking: false, open: false, countdown: true };
  }

  const openStreak = inputs.openStreak + Math.max(1, inputs.frames);
  return {
    openStreak,
    speaking: true,
    open: openStreak >= VAD_OPEN_FRAMES && !inputs.micLive,
    countdown: false,
  };
}
