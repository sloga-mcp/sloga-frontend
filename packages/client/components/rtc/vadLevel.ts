/**
 * Shared microphone-level and voice-activity arithmetic.
 *
 * ONE definition of "level" for the VAD gate (state.tsx `#startVAD`), the
 * Voice-settings sensitivity meter and the input-level test, so a threshold
 * the user sets against the meter is exactly the threshold the call gate
 * compares against. Byte-frequency average × 2.5, clamped to 0–100.
 */

/** Analyser configuration every consumer must use for the numbers to agree. */
export const VAD_FFT_SIZE = 512;

/**
 * Capture constraints for every VAD analysis stream (gate and meters alike).
 *
 * The browser's autoGainControl adapts PER STREAM over time: the gate's
 * long-lived stream winds its gain up while the user sits quiet, so soft
 * speech measures far louder there than on a freshly opened settings-meter
 * stream — the two can never agree with AGC on, and the gate creeps more
 * trigger-happy the longer a call runs. Noise suppression is off for the
 * same reason: the level must be a stable property of the room, not of a
 * per-stream filter state. Echo cancellation stays ON so other people's
 * voices coming out of the speakers do not open the gate.
 */
export const VAD_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  autoGainControl: false,
  noiseSuppression: false,
  echoCancellation: true,
};

/**
 * Consecutive frames the level must sit above the threshold before the gate
 * opens (~50 ms at 60 fps): a single 16 ms transient poking over the line —
 * a keyboard tap, a plosive — must not unmute the microphone while the
 * meter visibly sits in the red.
 */
export const VAD_OPEN_FRAMES = 3;

/**
 * Length of the nominal frame the constants above are expressed in.
 *
 * The gate no longer rides `requestAnimationFrame` (a hidden or minimized
 * window stops it dead, freezing the gate in whatever state it was last in —
 * see `#startVAD`), so it has to convert its own elapsed time back into the
 * frame unit `VAD_OPEN_FRAMES` and the noise-floor rates are tuned in.
 */
export const VAD_FRAME_MS = 1000 / 60;

/**
 * How often the call gate samples the analyser. One nominal frame, so a
 * foreground call behaves exactly as it did on `requestAnimationFrame`; a
 * throttled window stretches it and the gate scales its arithmetic by the
 * span it actually measured rather than assuming this one.
 */
export const VAD_TICK_MS = Math.round(VAD_FRAME_MS);

/**
 * How long the call gate waits for its analyser context to leave
 * `suspended` before it starts ticking anyway. Without a user gesture
 * Chromium may hold `resume()` pending indefinitely; the gate fails open
 * while the context is not running, so starting late costs nothing.
 */
export const VAD_RESUME_TIMEOUT_MS = 1500;

/**
 * Ceiling on how many frames one late `update()` may stand in for. Beyond
 * about half a second of catch-up the floor has no useful history left, and
 * an unbounded exponent lets a single resumed tick settle it straight onto
 * one sample.
 */
const NOISE_FLOOR_MAX_CATCHUP_FRAMES = 30;

/** 0–100 loudness from an analyser's byte-frequency snapshot. */
export function levelFromFrequencyData(buf: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i];
  const avg = buf.length ? sum / buf.length : 0;
  return Math.min(100, avg * 2.5);
}

/** Threshold bounds in automatic mode (same 0–100 scale as the level). */
export const AUTO_THRESHOLD_MIN = 12;
export const AUTO_THRESHOLD_MAX = 60;
/** How far above the tracked noise floor the gate opens. */
export const AUTO_THRESHOLD_MARGIN = 12;

/** Threshold implied by a given ambient noise floor. */
export function autoThresholdFor(noiseFloor: number): number {
  // Margin grows with the floor: a noisy room needs more headroom above its
  // average than a quiet one, because its peaks sit further above it.
  return Math.min(
    AUTO_THRESHOLD_MAX,
    Math.max(
      AUTO_THRESHOLD_MIN,
      noiseFloor + AUTO_THRESHOLD_MARGIN + noiseFloor * 0.5,
    ),
  );
}

/**
 * Adaptive noise-floor tracker for "automatically adjust input sensitivity".
 *
 * The floor is a SMOOTHED estimate of the ambient level, not its minimum:
 * a raw minimum locks onto the near-zero frames every room produces between
 * sounds and then the ordinary hiss opens the gate. It settles downward in
 * about a second (rate 0.03/frame at 60 fps) and rises only slowly (0.003),
 * so a pause between phrases pulls it back to the real room noise while
 * sustained speech barely moves it. `update()` returns the current auto
 * threshold.
 */
export function createNoiseFloorTracker() {
  let floor = 100;
  return {
    /**
     * @param level Current 0-100 level.
     * @param frames How many nominal 60 fps frames this update stands in for.
     *   The settings meters tick once per animation frame and pass nothing;
     *   the call gate runs on a timer whose cadence a hidden window can
     *   stretch, and passes the span it actually measured so a late tick
     *   settles the floor by as much as the frames it replaced would have.
     */
    update(level: number, frames = 1): number {
      const perFrame = level < floor ? 0.03 : 0.003;
      // Compounded over the span, never `perFrame * frames`: that overshoots
      // for a long gap and crosses 1 outright at ~33 frames, which would slam
      // the floor onto (or past) whatever single sample the late tick read.
      const rate =
        1 -
        Math.pow(
          1 - perFrame,
          Math.min(Math.max(frames, 1), NOISE_FLOOR_MAX_CATCHUP_FRAMES),
        );
      floor += (level - floor) * rate;
      return autoThresholdFor(floor);
    },
    get floor() {
      return floor;
    },
    reset() {
      floor = 100;
    },
  };
}
