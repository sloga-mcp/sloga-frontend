/**
 * Camera tone (glam, low light, touch up, brightness): the PURE decisions
 * behind the WebGL tone stage. Extracted so `node --test` can load it (the house
 * no-vitest split; this module must stay dependency-free: no DOM, no i18n,
 * no imports).
 *
 * What lives here:
 *
 * 1. Low light metering. `meanLuma` reduces a small RGBA readback of the
 *    SOURCE frame to one number, and `LowLightMeter` turns a stream of those
 *    into a gain. Three rules keep the picture from pumping: the luma is
 *    smoothed over about a second, so one dark frame (a hand over the lens)
 *    does nothing; engage and release use different thresholds, so a room
 *    that sits between them never flaps; and the gain itself is slewed, so
 *    it never steps, including on release, where it ramps back down to 1
 *    instead of snapping.
 *
 * 2. Touch up without landmarks. `plainTouchUpStrength` maps the stored
 *    `cameraBeautify` value to the whole-frame smoothing strength, at twice
 *    the stored fraction so that what the in-call switch writes can be seen,
 *    and caps it short of 1, because smoothing the whole frame blurs
 *    everything, not skin.
 *
 * 3. The watchdog. `ToneWatchdog` sheds the costliest active stage when the
 *    processed frame rate stays under a fraction of the source frame rate
 *    for a whole window. It is ratio-only on purpose (an absolute floor
 *    would misfire in a dark room, where the camera itself slows down), it
 *    sheds one stage per window, and it never re-arms a shed stage: an
 *    effect that slowed the video once stays off for the call. A stage that
 *    was given up for a reason the frame rate does not show (the face
 *    tracker running over its own time budget) is recorded in the same
 *    place with `shedNow`, so there is one list of what is off.
 *
 * 4. Robustness tables. `tonePageMode` says how frames are driven while the
 *    page is hidden (`toneTimerHolds` is its "the timer still delivers"
 *    input), and `ContextLossLadder` allows one rebuild at a time after a
 *    lost WebGL context before the stage fails open to raw video: a loss
 *    taken on a hidden page is free, and the rebuild is handed back once the
 *    stage has drawn steadily for `CONTEXT_LOSS_REARM_MS`. `toneStageBlind`
 *    is the one-time check that a freshly built stage is not drawing black,
 *    and `toneTurnedOn` says when the user switching a tone setting on earns
 *    a failed stage one fresh attempt.
 *    Every stage here is cosmetic, so every failure is fail open.
 */

export const LOW_LIGHT_SAMPLE_EVERY_FRAMES = 12;
export const LOW_LIGHT_MAX_GAIN = 2;
/** Engage when the smoothed luma falls below this. */
export const LOW_LIGHT_ENGAGE_LUMA = 0.3;
/** Release when the smoothed luma rises above this. */
export const LOW_LIGHT_RELEASE_LUMA = 0.4;
export const LOW_LIGHT_TARGET_LUMA = 0.45;
export const LOW_LIGHT_SMOOTHING_MS = 1000;
/** The most time one sample may stand in for, however long the gap before it. */
export const LOW_LIGHT_MAX_STEP_MS = 500;
/** The `cameraBeautify` value the in-call switch writes. */
export const TOUCH_UP_SWITCH_STRENGTH = 40;
/** Cap of the whole-frame smooth strength (no landmarks). */
export const TOUCH_UP_PLAIN_MAX = 0.9;

/** The most the low-light gain may move in one second, up or down. */
const LOW_LIGHT_GAIN_RATE_PER_S = 0.5;
/** Floor for the smoothed luma in the gain division (a black frame). */
const LUMA_EPSILON = 1e-3;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** Mean Rec.601 luma of RGBA bytes, 0..1. Empty input -> 0. */
export function meanLuma(rgba: ArrayLike<number>): number {
  // A trailing partial pixel is not a pixel.
  const pixels = Math.floor(rgba.length / 4);
  if (pixels === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pixels * 4; i += 4) {
    sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  }
  return clamp(sum / (pixels * 255), 0, 1);
}

/**
 * Smoothed, hysteretic low-light gain. Starts released at gain 1.
 *
 * - The first sample seeds the average; later samples are blended in with
 *   the time constant `LOW_LIGHT_SMOOTHING_MS`, driven by the `nowMs` delta,
 *   so the result does not depend on how often the caller samples. The
 *   delta is clamped to 0..`LOW_LIGHT_MAX_STEP_MS`: after a long gap (a
 *   hidden page) one sample cannot flip the state or snap the gain.
 * - Engages when the smoothed luma falls below `LOW_LIGHT_ENGAGE_LUMA` and
 *   releases when it rises above `LOW_LIGHT_RELEASE_LUMA`. In between, the
 *   state it already has is kept.
 * - While engaged the gain heads for `LOW_LIGHT_TARGET_LUMA / smoothed`,
 *   clamped to 1..`LOW_LIGHT_MAX_GAIN`; while released it heads for 1. It
 *   moves at most `LOW_LIGHT_GAIN_RATE_PER_S` per second either way, so a
 *   meter that starts in a dark room ramps up from 1 and a released meter
 *   ramps down to exactly 1 and stays there.
 * - A non-finite luma or time is ignored: no state changes at all.
 */
export class LowLightMeter {
  #smoothed: number | undefined;
  #lastMs = 0;
  #engaged = false;
  #gain = 1;

  push(luma: number, nowMs: number): void {
    if (!Number.isFinite(luma) || !Number.isFinite(nowMs)) return;
    const sample = clamp(luma, 0, 1);

    // A clock that stepped backwards counts as no time passed, and a long
    // gap (a hidden page) counts as one step: the sample after it is still
    // one sample, not the whole gap's worth of evidence. The same clamped
    // delta drives both the smoothing and the gain slew below.
    const dtMs =
      this.#smoothed === undefined
        ? 0
        : clamp(nowMs - this.#lastMs, 0, LOW_LIGHT_MAX_STEP_MS);
    this.#lastMs = nowMs;

    if (this.#smoothed === undefined) {
      this.#smoothed = sample;
    } else {
      const alpha = 1 - Math.exp(-dtMs / LOW_LIGHT_SMOOTHING_MS);
      this.#smoothed += alpha * (sample - this.#smoothed);
    }

    if (!this.#engaged && this.#smoothed < LOW_LIGHT_ENGAGE_LUMA) {
      this.#engaged = true;
    } else if (this.#engaged && this.#smoothed > LOW_LIGHT_RELEASE_LUMA) {
      this.#engaged = false;
    }

    const target = this.#engaged
      ? clamp(
          LOW_LIGHT_TARGET_LUMA / Math.max(this.#smoothed, LUMA_EPSILON),
          1,
          LOW_LIGHT_MAX_GAIN,
        )
      : 1;
    const maxStep = (LOW_LIGHT_GAIN_RATE_PER_S * dtMs) / 1000;
    const delta = target - this.#gain;
    // Landing exactly on the target keeps a settled released meter at 1.
    this.#gain =
      Math.abs(delta) <= maxStep
        ? target
        : this.#gain + Math.sign(delta) * maxStep;
  }

  /** 1..`LOW_LIGHT_MAX_GAIN`. */
  get gain(): number {
    return this.#gain;
  }

  get engaged(): boolean {
    return this.#engaged;
  }

  /** Back to a new meter: released, gain 1, and the next sample seeds. */
  reset(): void {
    this.#smoothed = undefined;
    this.#lastMs = 0;
    this.#engaged = false;
    this.#gain = 1;
  }
}

export type ToneStageName = "glam" | "touchUp" | "lowLight" | "brightness";

/** What the tone stage draws. Neutral = { lowLightGain: 1, brightness: 1, smooth: 0 }. */
export interface ToneConfig {
  /** 1..2 */
  lowLightGain: number;
  /** Multiplier, 1 = neutral (0.5..1.5). */
  brightness: number;
  /** 0..1 */
  smooth: number;
}

export const NEUTRAL_TONE: Readonly<ToneConfig> = Object.freeze({
  lowLightGain: 1,
  brightness: 1,
  smooth: 0,
});

/**
 * Exact comparison on purpose: a neutral config must be a visually exact
 * passthrough, so "nearly neutral" still has to be drawn.
 */
export function toneIsNeutral(c: ToneConfig): boolean {
  return c.lowLightGain === 1 && c.brightness === 1 && c.smooth === 0;
}

/**
 * cameraBeautify (0..100) -> whole-frame smooth strength: twice the stored
 * fraction, capped at TOUCH_UP_PLAIN_MAX (reached at 45). The doubling is
 * what makes the switch value visible: 40 gives 0.8, where the plain
 * fraction (0.4) could not be told from off on a phone. A non-finite or
 * non-positive value is 0 (off).
 */
export function plainTouchUpStrength(beautify: number): number {
  if (!Number.isFinite(beautify) || beautify <= 0) return 0;
  return Math.min((2 * beautify) / 100, TOUCH_UP_PLAIN_MAX);
}

/**
 * Costliest first: the order stages are shed in. Glam leads because it adds
 * face tracking on top of its drawing.
 */
export const TONE_SHED_ORDER: readonly ToneStageName[] = Object.freeze([
  "glam",
  "touchUp",
  "lowLight",
  "brightness",
]);

const WATCHDOG_DEFAULT_RATIO = 0.6;
const WATCHDOG_DEFAULT_WINDOW_MS = 5000;

const positiveOr = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;

/**
 * Sheds the costliest active stage when processed fps < ratio * source fps
 * for windowMs. Never re-arms.
 *
 * The window opens at the first slow sample and every sample in it must be
 * slow: one healthy sample closes it. It also restarts (nothing is shed)
 * when there is nothing to judge, which is `sourceFps <= 0`, a non-finite
 * frame rate or time, a clock that stepped backwards, or no active stage
 * that is not already shed; and when two samples are more than `windowMs`
 * apart, because the time between them was not measured. After a shed a NEW window starts for the remaining stages, so
 * one bad window costs one stage, never two.
 */
export class ToneWatchdog {
  readonly #ratio: number;
  readonly #windowMs: number;
  readonly #shed = new Set<ToneStageName>();
  /** When the current run of slow samples began. */
  #windowStart: number | undefined;
  #lastSample: number | undefined;

  constructor(opts?: { ratio?: number; windowMs?: number }) {
    this.#ratio = positiveOr(opts?.ratio, WATCHDOG_DEFAULT_RATIO);
    this.#windowMs = positiveOr(opts?.windowMs, WATCHDOG_DEFAULT_WINDOW_MS);
  }

  /** Returns the stage shed by THIS sample, else undefined. Cost order: glam, touchUp, lowLight, brightness. */
  sample(
    sourceFps: number,
    processedFps: number,
    nowMs: number,
    active: readonly ToneStageName[],
  ): ToneStageName | undefined {
    const candidates = TONE_SHED_ORDER.filter(
      (stage) => active.includes(stage) && !this.#shed.has(stage),
    );
    const last = this.#lastSample;
    // An idle sample: nothing can be judged from it, so nothing is shed and
    // the next usable sample starts from scratch.
    if (
      !(Number.isFinite(sourceFps) && sourceFps > 0) ||
      !Number.isFinite(processedFps) ||
      !Number.isFinite(nowMs) ||
      (last !== undefined && nowMs < last) ||
      candidates.length === 0
    ) {
      this.#windowStart = undefined;
      this.#lastSample = undefined;
      return undefined;
    }

    this.#lastSample = nowMs;
    if (last !== undefined && nowMs - last > this.#windowMs) {
      this.#windowStart = undefined;
    }

    if (!(processedFps < this.#ratio * sourceFps)) {
      this.#windowStart = undefined;
      return undefined;
    }
    if (this.#windowStart === undefined) {
      this.#windowStart = nowMs;
      return undefined;
    }
    if (nowMs - this.#windowStart < this.#windowMs) return undefined;

    const stage = candidates[0];
    this.#shed.add(stage);
    this.#windowStart = nowMs;
    return stage;
  }

  /**
   * Records a shed that was decided somewhere else (the face tracker ran
   * over its own time budget). True only when the stage was not shed
   * already. From here on it is a shed like any other: it shows in `shed`,
   * `sample` never picks it again and only `reset()` clears it.
   *
   * A newly recorded shed also closes the open window, the same as a shed
   * made by `sample`. A slow face tracker is exactly what drags the frame
   * rate down, so the slow time measured so far belongs to the stage that
   * has just gone: the next one gets a full window of its own, and one bad
   * window still costs one stage, never two. A stage that was shed already
   * changes nothing, the window included.
   */
  shedNow(stage: ToneStageName): boolean {
    if (this.#shed.has(stage)) return false;
    this.#shed.add(stage);
    this.#windowStart = undefined;
    return true;
  }

  /** Survives processor rebuilds (the controller owns the instance). */
  get shed(): ReadonlySet<ToneStageName> {
    return this.#shed;
  }

  /** New call only. */
  reset(): void {
    this.#shed.clear();
    this.#windowStart = undefined;
    this.#lastSample = undefined;
  }
}

export type TonePageMode = "frame" | "timer" | "bypass";

/**
 * Visible -> "frame". Hidden -> "timer" while the timer keeps delivering
 * frames, else "bypass" (raw passthrough draw).
 */
export function tonePageMode(a: {
  hidden: boolean;
  timerHolds: boolean;
}): TonePageMode {
  if (!a.hidden) return "frame";
  return a.timerHolds ? "timer" : "bypass";
}

/**
 * Clear of the 1 s background-timer throttle: a throttled tab that still
 * delivers once a second must read as holding, not flip on jitter.
 */
export const TONE_TIMER_STALL_MS = 1500;

/**
 * While hidden: true while the timer delivered a frame within
 * TONE_TIMER_STALL_MS. Non-finite or negative age -> false.
 */
export function toneTimerHolds(msSinceLastFrame: number): boolean {
  // NaN fails both comparisons and +Infinity the second.
  return msSinceLastFrame >= 0 && msSinceLastFrame <= TONE_TIMER_STALL_MS;
}

/** Low light / touch up are allowed only off iOS and off macOS Tauri, and only where canvas capture exists. */
export function toneAllowedOnPlatform(p: {
  ios: boolean;
  macTauri: boolean;
  canvasCapture: boolean;
}): boolean {
  return !p.ios && !p.macTauri && p.canvasCapture;
}

/**
 * The least source luma (times the brightness multiplier) at which a stage
 * output of exactly 0 cannot be the picture: about 5/255.
 */
export const TONE_BLIND_SOURCE_FLOOR = 0.02;

/**
 * One-time check after a stage build: true when the stage drew pure black
 * from a camera frame that is not black. `sourceLuma` and `outputLuma` are
 * mean lumas (0..1) of the same frame, raw and as the stage drew it;
 * `brightness` is the multiplier the stage applied. Low light only ever
 * lifts and smoothing keeps the mean, so the output can be exactly 0 only
 * when `sourceLuma * brightness` is next to nothing. A covered lens or a
 * brightness of 0 is therefore never called blind, and neither is a
 * non-finite input.
 */
export function toneStageBlind(a: {
  sourceLuma: number;
  outputLuma: number;
  brightness: number;
}): boolean {
  return (
    a.outputLuma === 0 && a.sourceLuma * a.brightness >= TONE_BLIND_SOURCE_FLOOR
  );
}

/** The tone settings that need the stage built. Brightness alone never does. */
export interface ToneWants {
  lowLight: boolean;
  /** Whole-frame touch up (the stage's smooth), not the landmark beautify. */
  touchUp: boolean;
  /** The face-tracked look. Left out means off. */
  glam?: boolean;
}

/**
 * True when a tone setting that was off is on now: the user turned one on.
 * That is the one event that gives a stage that failed open a fresh build
 * attempt. A setting that stays on (a slider drag) or goes off is not one.
 */
export function toneTurnedOn(was: ToneWants, now: ToneWants): boolean {
  return (
    (now.lowLight && !was.lowLight) ||
    (now.touchUp && !was.touchUp) ||
    (now.glam === true && was.glam !== true)
  );
}

export type ContextLossAction = "rebuild" | "fail-open";

/** How long the stage must draw steadily after a counted loss to earn the rebuild back. */
export const CONTEXT_LOSS_REARM_MS = 10_000;
/** Two successful draws further apart than this are not one steady run. */
export const CONTEXT_LOSS_REARM_MAX_GAP_MS = 2000;

/**
 * One rebuild at a time. A counted loss -> "rebuild"; another counted loss
 * before the rebuild is earned back, or a failed rebuild -> "fail-open".
 *
 * - A loss taken while the page is hidden is not counted: a backgrounded
 *   WebView may drop its GL contexts on every app switch, and that says
 *   nothing about the stage. It gets "rebuild" every time.
 * - The rebuild is earned back by `CONTEXT_LOSS_REARM_MS` of successful
 *   draws (`onDraw`). The run starts at the first successful draw after the
 *   counted loss and restarts on a refused draw, on any loss, on two draws
 *   more than `CONTEXT_LOSS_REARM_MAX_GAP_MS` apart, and on a clock that
 *   stepped backwards or is not finite.
 * - A failed rebuild is final: every later loss, hidden or not, is
 *   "fail-open" and no run of draws changes that. Only `reset()` does.
 */
export class ContextLossLadder {
  /** The one rebuild is out, until a steady run of draws hands it back. */
  #spent = false;
  /** A rebuild failed: nothing but `reset()` hands a rebuild out again. */
  #forfeited = false;
  /** Start of the current steady run of successful draws. */
  #stableSince: number | undefined;
  #lastDraw: number | undefined;

  /** `hidden`: the page was hidden when the context was lost. */
  onLost(hidden = false): ContextLossAction {
    this.#stableSince = undefined;
    this.#lastDraw = undefined;
    if (this.#forfeited) return "fail-open";
    if (hidden) return "rebuild";
    if (this.#spent) return "fail-open";
    this.#spent = true;
    return "rebuild";
  }

  /** Always "fail-open", and no later loss gets a rebuild. */
  onRebuildFailed(): ContextLossAction {
    this.#forfeited = true;
    this.#stableSince = undefined;
    this.#lastDraw = undefined;
    return "fail-open";
  }

  /** One stage draw: `drew` false = the stage refused it. */
  onDraw(drew: boolean, nowMs: number): void {
    // Nothing to earn back; after a failed rebuild `onLost` never looks.
    if (!this.#spent) return;
    if (!drew || !Number.isFinite(nowMs)) {
      this.#stableSince = undefined;
      this.#lastDraw = undefined;
      return;
    }
    const last = this.#lastDraw;
    this.#lastDraw = nowMs;
    if (
      this.#stableSince === undefined ||
      last === undefined ||
      nowMs < last ||
      nowMs - last > CONTEXT_LOSS_REARM_MAX_GAP_MS
    ) {
      this.#stableSince = nowMs;
      return;
    }
    if (nowMs - this.#stableSince >= CONTEXT_LOSS_REARM_MS) {
      this.#spent = false;
      this.#stableSince = undefined;
      this.#lastDraw = undefined;
    }
  }

  reset(): void {
    this.#spent = false;
    this.#forfeited = false;
    this.#stableSince = undefined;
    this.#lastDraw = undefined;
  }
}
