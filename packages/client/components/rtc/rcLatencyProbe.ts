/**
 * Press-to-photon measurement for the remote-control latency gate
 * (couch co-op §2.6 part 2). DEV INSTRUMENTATION — gated behind
 * `VITE_CFG_RC_LATENCY_PROBE`, loaded as its own lazy chunk, and referenced
 * from exactly one guarded call site so a production bundle never fetches it.
 *
 * # Why this exists at all
 *
 * The gate wants press-to-photon: the controller actuates a key, and some
 * number of milliseconds later the change appears on the controller's own
 * screen. Four camera attempts could not produce it. A fingertip pressing a
 * laptop key is a few pixels of low-contrast, motion-blurred travel; even at
 * 238 fps, event-triggered averaging over 20 presses put the best candidate
 * signal at 3.34 against a 2.14 noise floor — i.e. nothing. The actuation
 * instant is simply not recoverable from footage of a hand.
 *
 * It IS recoverable in software, and more precisely than any camera: the
 * keydown event carries its own high-resolution `timeStamp`, and
 * `requestVideoFrameCallback` reports when each decoded frame is expected to
 * be displayed. Both are on the same clock, on the same machine, so no
 * cross-machine sync is needed and there is no actuation ambiguity.
 *
 * # What it measures, stated precisely
 *
 * From `event.timeStamp` of the keydown — the browser's own stamp for when
 * the event occurred, NOT when our handler ran, so handler-queue jitter is
 * excluded — to `expectedDisplayTime` of the first video frame whose sampled
 * luminance departs from the pre-press baseline.
 *
 * It therefore EXCLUDES the hardware/OS leg ahead of the browser (key
 * actuation to `keydown`, a few ms) and the display's own leg after
 * `expectedDisplayTime` (which is the compositor's estimate of scan-out, not
 * of photons). Both are small and both are present for any input on any
 * application; a camera would include them. Report the number as
 * "keydown-to-frame", and treat it as a floor for true press-to-photon.
 *
 * # Why it works with a real game, which the flip target does not
 *
 * It detects a CHANGE against a rolling baseline rather than a specific
 * target page, so the host can be running an actual game — which matters,
 * because the video leg turned out to be strongly content-dependent (110 ms
 * on a static clock, 273 ms on a full-screen strobe, N=66). Pick an in-game
 * action with a sharp visual onset and raise `threshold` if the scene is
 * busy.
 */

/** One completed measurement. */
export type ProbeSample = {
  /** `event.timeStamp` of the keydown. */
  pressAt: number;
  /** `expectedDisplayTime` of the first changed frame. */
  photonAt: number;
  /** photonAt - pressAt, in ms. */
  ms: number;
  /** Which key, so a sample taken with the wrong key can be discarded. */
  key: string;
  /** How much the luminance had moved when it tripped, for triage. */
  delta: number;
  /** Video frames sampled between the press and the trip. */
  frames: number;
};

export type ProbeConfig = {
  /**
   * Mean-luminance change (0-255) that counts as "the frame changed".
   *
   * 6 is comfortably above sensor/codec noise on a static scene and far
   * below a full-screen flip (~200). A busy game scene may need more: too
   * low and ordinary motion trips it before the action arrives, which
   * reports a latency SHORTER than the truth — the dangerous direction.
   */
  threshold: number;
  /** Give up on a press after this long and record a miss. */
  timeoutMs: number;
  /**
   * After a trip, wait until luminance is back within this of baseline
   * before arming again. Without it the flip's own decay trips the next
   * press instantly and reports absurdly low numbers.
   */
  settleWithin: number;
};

export const DEFAULT_PROBE_CONFIG: ProbeConfig = {
  threshold: 6,
  timeoutMs: 2000,
  settleWithin: 3,
};

/**
 * Percentile summary. Sorted copy, nearest-rank — no interpolation, because
 * an interpolated p95 of 30 samples invents precision the sample size does
 * not have.
 */
export function summarise(values: number[]) {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return {
    n: s.length,
    min: s[0],
    p25: at(0.25),
    p50: at(0.5),
    p75: at(0.75),
    p95: at(0.95),
    max: s[s.length - 1],
    mean: s.reduce((a, b) => a + b, 0) / s.length,
  };
}

/**
 * The press → change state machine, kept free of DOM and timers so it can be
 * tested directly. `onPress` arms it; `onFrame` is fed one video frame at a
 * time; it returns a sample the moment a frame trips the threshold.
 *
 * Baseline is the luminance of the last frame seen BEFORE the press, not a
 * running average across it: an average that straddles the press is already
 * contaminated by the thing being detected.
 */
export class PressToChange {
  #config: ProbeConfig;
  #lastLuma?: number;
  #armed?: { pressAt: number; key: string; baseline: number; frames: number };
  /** True while waiting for the scene to return to baseline. */
  #settling?: number;
  #timeouts = 0;

  constructor(config: ProbeConfig = DEFAULT_PROBE_CONFIG) {
    this.#config = config;
  }

  get busy() {
    return this.#armed !== undefined;
  }

  get settling() {
    return this.#settling !== undefined;
  }

  /**
   * Presses abandoned without a visible change, cumulative.
   *
   * A run that silently drops half its presses otherwise looks like a clean
   * run with fewer samples — the same "empty result reads as success" trap
   * that release verification keeps hitting. Callers mirror this and report
   * any growth.
   */
  get timeouts() {
    return this.#timeouts;
  }

  /**
   * Wall-clock timeout check, for the case `onFrame` cannot cover: if the
   * video pipeline stalls completely there are NO frames, so a frame-time
   * timeout never fires and an armed press would block every later one
   * forever. Returns true if it just abandoned a press.
   */
  checkTimeout(now: number): boolean {
    const armed = this.#armed;
    if (!armed) return false;
    if (now - armed.pressAt <= this.#config.timeoutMs) return false;
    this.#armed = undefined;
    this.#timeouts++;
    return true;
  }

  /**
   * Arm on a keydown. Refuses while a press is outstanding or the scene has
   * not settled — a sample taken then would measure the previous press.
   */
  onPress(pressAt: number, key: string): "armed" | "busy" | "settling" | "no-frames" {
    if (this.#armed) return "busy";
    if (this.#settling !== undefined) return "settling";
    if (this.#lastLuma === undefined) return "no-frames";
    this.#armed = { pressAt, key, baseline: this.#lastLuma, frames: 0 };
    return "armed";
  }

  /** Feed one frame. Returns a sample if this frame tripped the threshold. */
  onFrame(luma: number, displayAt: number): ProbeSample | undefined {
    this.#lastLuma = luma;

    if (this.#settling !== undefined) {
      if (Math.abs(luma - this.#settling) <= this.#config.settleWithin) {
        this.#settling = undefined;
      }
      return undefined;
    }

    const armed = this.#armed;
    if (!armed) return undefined;
    armed.frames++;

    const delta = Math.abs(luma - armed.baseline);
    if (delta < this.#config.threshold) {
      // Timeout is checked against FRAME time, not wall time: if the video
      // pipeline stalls entirely there are no frames, and a wall-clock
      // timeout would then report a miss for a press whose change simply
      // has not arrived yet. Either way it is a miss, but this way the
      // frame count tells you which.
      if (displayAt - armed.pressAt > this.#config.timeoutMs) {
        this.#armed = undefined;
        this.#timeouts++;
      }
      return undefined;
    }

    this.#armed = undefined;
    this.#settling = armed.baseline;
    return {
      pressAt: armed.pressAt,
      photonAt: displayAt,
      ms: displayAt - armed.pressAt,
      key: armed.key,
      delta,
      frames: armed.frames,
    };
  }

  /**
   * Abandon an outstanding press (feed lost, surface unmounted).
   *
   * Does NOT count as a timeout: the press did not fail to land, the
   * measurement was torn down underneath it, and folding those together
   * would make a mid-run remount look like packet loss.
   */
  reset() {
    this.#armed = undefined;
    this.#settling = undefined;
    this.#lastLuma = undefined;
  }
}

/**
 * Mean luminance of the centre of a video frame, 0-255.
 *
 * Centre-cropped on purpose: `object-fit: contain` letterboxes the tile, and
 * including the bars dilutes the signal by a constant factor — which moves
 * the effective threshold without anyone noticing. Rec.601 luma, matching
 * what ffmpeg's `signalstats` reports, so numbers from this probe and from
 * frame-by-frame video analysis are comparable.
 */
export function sampleLuma(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  centreFraction = 0.6,
): number | undefined {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return undefined;
  const cw = vw * centreFraction;
  const ch = vh * centreFraction;
  ctx.drawImage(
    video,
    (vw - cw) / 2,
    (vh - ch) / 2,
    cw,
    ch,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return sum / (data.length / 4);
}
