/**
 * Face-filter processor: AR stickers + beautify + color looks on the camera
 * track, occupying the single LiveKit processor slot (see camera-face-filters
 * plan §2/§5 and cameraEffects.ts for the slot policy).
 *
 * Per-frame pipeline:
 *   source video frame
 *     → ctx.filter = [color look] + [non-HW brightness]
 *     → draw to canvas
 *     → beautify (face-masked smoothing, landmarks required)
 *     → AR stickers (landmark-anchored bitmaps)
 *     → canvas.captureStream() → processedTrack
 *
 * Lifecycle contract (plan §2, re-verify NEW-1):
 *  - `init()` = FULL build from scratch; callable again after `destroy()` on
 *    the same instance (resets #disposed/#stopped, rebuilds canvases, clears
 *    and re-decodes the bitmap cache, landmarker stays lazy).
 *  - `restart()` = live rebind ONLY (device switch): swap the hidden video's
 *    source + `this.source`, keep landmarker/canvases/bitmaps.
 *  - `destroy()` = cancel frame callback, close+null landmarker, close AND
 *    CLEAR the bitmap cache, set #disposed.
 *
 * Failure taxonomy (re-verify NEW-3): landmarker failures (fetch/init after
 * GPU→CPU retry, repeated detect throws) are NON-FATAL — the processor
 * degrades to look-only and reports via `onStatus`; only pipeline failures
 * (canvas/captureStream/video) reject `init`/`restart`.
 *
 * Tone (low light, whole-frame touch up, brightness): an optional WebGL
 * stage draws the BASE layer. Per frame the stage draws the video and, in the
 * same task, its canvas is copied onto the 2D canvas in place of the raw
 * video draw; beautify and stickers composite on top as before. The published
 * track always captures the 2D canvas and nothing captures the stage, so
 * building, losing, shedding or dropping the stage is never a sender
 * operation. Every tone failure is fail open: that frame (or every frame
 * until the user next switches a tone setting on) draws the raw video. With
 * no tone setting the stage is never built and the frame path is the one
 * above.
 *
 * Tone recovery budget: one rebuild after a context loss and one after a run
 * of refused draws. A loss on a hidden page is free, each rebuild is earned
 * back by a steady run of draws (`ContextLossLadder`), and switching a tone
 * setting on after tone failed open gives it one fresh attempt. The first
 * frame a new or rebuilt stage draws is compared with the raw frame once, so
 * a stage that draws black is refused instead of published.
 *
 * `landmarks: false` in the config means MediaPipe is never imported, fetched
 * or created: stickers and the masked beautify are simply not drawn, and
 * touch up is the stage's whole-frame smooth instead.
 *
 * Hidden page: rVFC/rAF stop firing, so a timer drives the frames instead.
 * If that timer is throttled past the stall limit the stage is bypassed (raw
 * frames) until the page is visible again.
 */
import type { FaceLandmarker } from "@mediapipe/tasks-vision";

import { CONFIGURATION } from "@revolt/common";
import type {
  CameraColorLookId,
  CameraFaceFilterId,
} from "@revolt/state/stores/Voice";

import {
  type ToneConfig,
  type TonePageMode,
  type ToneStageName,
  type ToneWants,
  type ToneWatchdog,
  ContextLossLadder,
  LOW_LIGHT_SAMPLE_EVERY_FRAMES,
  LowLightMeter,
  meanLuma,
  plainTouchUpStrength,
  toneIsNeutral,
  tonePageMode,
  toneStageBlind,
  toneTimerHolds,
  toneTurnedOn,
} from "./cameraTonePolicy";
import { CameraToneStage } from "./cameraToneStage";
import {
  type NormalizedLandmark,
  beautifyAlpha,
  beautifyBlurPx,
  COLOR_LOOKS,
  computeFaceFrame,
  DEGRADE,
  DegradeLadder,
  FACE_FILTERS,
  FACE_OVAL,
  MASK_CUTOUTS,
  placeLayer,
} from "./faceFilterCatalog";

/**
 * Base URL for the self-hosted MediaPipe assets. Mirrors SEGMENTATION_BASE in
 * cameraEffects.ts (kept local — cameraEffects imports THIS module, so the
 * shared constant can't live there without a cycle).
 */
const MEDIAPIPE_BASE = (
  CONFIGURATION.SEGMENTATION_ASSETS_URL ||
  `${import.meta.env.BASE_URL}mediapipe`
).replace(/\/$/, "");

/** Sticker art base — BASE_URL-aware so non-root deployments resolve (plan §3).
 *  Exported so the UI (gallery thumbnails) resolves from the SAME base. */
export const FILTER_ASSETS_BASE = `${import.meta.env.BASE_URL}filters`.replace(
  /\/$/,
  "",
);

/** Consecutive per-frame detect throws before the landmarker is declared dead. */
const DETECT_FAIL_LIMIT = 5;

/** How many frames a stale landmark result may bridge a detection dropout. */
const LANDMARK_HOLD_FRAMES = 3;

/** Frame period of the hidden-page timer driver (about 15 fps). */
const HIDDEN_FRAME_INTERVAL_MS = 66;

/** Wall-clock window of the frame-rate measurement and the watchdog feed. */
const FPS_WINDOW_MS = 1000;

/**
 * How long the stage may keep refusing to draw, with no context-loss event
 * and the page visible, before one `rebuild()` is tried (and, if draws still
 * fail for this long after it, tone fails open).
 */
const TONE_STUCK_MS = 2000;

/** Edge of the 2D canvas the one-time blind check reads back. */
const PROBE_SIZE = 16;

/**
 * How long a lost context may stay lost, on a visible page, before tone
 * fails open exactly as it does on a second loss.
 */
const TONE_RESTORE_DEADLINE_MS = 3000;

export interface FaceFilterConfig {
  filterId?: CameraFaceFilterId;
  /** 0–100; 0 = off. */
  beautify: number;
  lookId?: CameraColorLookId;
  /** 0–200, 100 = neutral. Non-HW-brightness sources only (plan §5). */
  brightness: number;
  /** Low light switch. */
  lowLight: boolean;
  /**
   * False: MediaPipe is never loaded. Stickers are not drawn and touch up is
   * the whole-frame shader smooth (`plainTouchUpStrength(beautify)`).
   */
  landmarks: boolean;
  /** Tone stage allowed on this device (`cameraToneSupported()`). */
  tone: boolean;
  /**
   * Owned by the controller and outlives this processor. The processor feeds
   * it and keeps every stage in `watchdog.shed` neutral.
   */
  watchdog?: ToneWatchdog;
  onToneShed?: (stage: ToneStageName) => void;
  /** Tone failed open for this processor; the raw 2D path continues. */
  onToneFailed?: () => void;
}

export interface CameraToneStats {
  /** Stage built and not failed open. */
  toneLive: boolean;
  /** Stages drawn right now. */
  stages: ToneStageName[];
  /** Measured, 0 if unknown. */
  sourceFps: number;
  processedFps: number;
  pageMode: TonePageMode;
  lowLightGain: number;
}

export interface FaceFilterStatusReport {
  /** True when landmark-dependent features were requested but tracking is dead. */
  landmarksFailed: boolean;
  /** Current degrade-ladder step (0 = full quality … 3 = beautify off). */
  degraded: number;
}

/**
 * Whether this config needs face landmarks at all. `landmarks: false` wins
 * over every setting: it is the one gate in front of every MediaPipe path
 * (import, wasm/model fetch, creation, detection).
 */
function wantsLandmarks(cfg: FaceFilterConfig): boolean {
  return cfg.landmarks && (!!cfg.filterId || cfg.beautify > 0);
}

/**
 * Whether this config has tone work that needs the stage built: low light,
 * or touch up on a device without landmarks. Brightness alone never builds
 * it (it stays on the 2D filter), but rides in the shader once it is live.
 */
function wantsToneStage(cfg: FaceFilterConfig): boolean {
  return cfg.tone && (cfg.lowLight || (!cfg.landmarks && cfg.beautify > 0));
}

/** The same test as `wantsToneStage`, one setting at a time. */
function toneWants(cfg: FaceFilterConfig): ToneWants {
  return {
    lowLight: cfg.tone && cfg.lowLight,
    touchUp: cfg.tone && !cfg.landmarks && cfg.beautify > 0,
  };
}

/** Brightness setting (0–200, 100 = neutral) as the shader multiplier. */
function brightnessMultiplier(brightness: number): number {
  return Number.isFinite(brightness) ? Math.max(0, brightness) / 100 : 1;
}

/**
 * TrackProcessor implementation (init/restart/destroy — LiveKit calls
 * `restart` unconditionally on device switch, plan §2).
 */
export class FaceFilterProcessor {
  name = "face-filter-processor";
  processedTrack: MediaStreamTrack | undefined;
  /**
   * The RAW camera track this processor consumes. The effects controller
   * targets hardware-brightness constraints here — `track.mediaStreamTrack`
   * returns the PROCESSED track once a processor is attached (plan §5).
   */
  source: MediaStreamTrack | undefined;

  /** Status callback (landmark failure + degrade step). */
  onStatus?: (s: FaceFilterStatusReport) => void;

  #cfg: FaceFilterConfig;
  #disposed = false;
  #stopped = false;
  /** Bumped on every setConfig/destroy so stale async continuations self-discard. */
  #cfgGen = 0;

  #video: HTMLVideoElement | undefined;
  #canvas: HTMLCanvasElement | undefined;
  #ctx: CanvasRenderingContext2D | undefined;
  #smoothCanvas: HTMLCanvasElement | undefined;
  #smoothCtx: CanvasRenderingContext2D | undefined;
  #maskCanvas: HTMLCanvasElement | undefined;
  #maskCtx: CanvasRenderingContext2D | undefined;

  #vfcId: number | undefined;
  #rafId: number | undefined;

  #landmarker: FaceLandmarker | undefined;
  /** Set once landmarker init (incl. CPU retry) has failed — no re-attempts. */
  #landmarkerFailed = false;
  #landmarkerInitInFlight = false;
  #detectFails = 0;
  #lastTimestampMs = 0;

  #lastLandmarks: NormalizedLandmark[] | undefined;
  #lastLandmarksAge = 0;
  #frameCounter = 0;

  #ladder = new DegradeLadder();
  #bitmaps = new Map<string, ImageBitmap>();

  // --- Tone stage (never captured; see the file header) ---
  #stage: CameraToneStage | undefined;
  /**
   * Tone failed open: no stage is built again until the next `init()` or
   * until a tone setting is switched on (`setConfig`).
   */
  #toneFailed = false;
  /** Context lost, waiting for the restore event. */
  #stageLost = false;
  /** Start of the wait for the restore event (visible-page time). */
  #lostAt = 0;
  #lossLadder = new ContextLossLadder();
  /** When the current run of refused draws began; -1 = none. */
  #missSince = -1;
  /**
   * The budget of the stuck-draw rebuild. Same rule as the loss ladder (one
   * rebuild, earned back by a steady run of draws); a stuck run is only ever
   * judged on a visible page, so it never reports a hidden loss.
   */
  #stuckLadder = new ContextLossLadder();
  /** The stage was built or rebuilt and its first drawn frame is unchecked. */
  #blindCheckDue = false;
  /** The blind check failed: draws count as refused until a rebuild. */
  #stageBlind = false;
  #probeCanvas: HTMLCanvasElement | undefined;
  #probeCtx: CanvasRenderingContext2D | undefined;
  #meter = new LowLightMeter();
  /** Last source luma read back from the stage. */
  #heldLuma: number | undefined;
  #framesToSample = 0;
  /** Reused every frame: the config handed to the stage. */
  #tone: ToneConfig = { lowLightGain: 1, brightness: 1, smooth: 0 };
  /** Reused every frame: the stages the last frame drew. */
  #activeStages: ToneStageName[] = [];

  // --- Frame driver + page mode ---
  #timerId: ReturnType<typeof setInterval> | undefined;
  /** True while requestVideoFrameCallback drives the loop. */
  #vfcDriver = false;
  /** Last driver tick, drawn or idle: the stall clock of the hidden timer. */
  #lastTickAt = 0;
  /** `video.currentTime` of the last drawn frame; -1 = nothing drawn yet. */
  #drawnMediaTime = -1;
  /** Reused every frame: the argument of `tonePageMode`. */
  #pageArgs = { hidden: false, timerHolds: true };
  #pageMode: TonePageMode = "frame";
  /** The hidden-page timer stalled: raw frames until visible again. */
  #bypass = false;

  // --- Frame-rate measurement (stats + watchdog) ---
  /** Latest `presentedFrames` from the rVFC metadata. */
  #presentedFrames = 0;
  /** -1 = the next frame opens a new window. */
  #fpsWindowStart = -1;
  #fpsFrames = 0;
  #fpsPresentedBase = 0;
  #sourceFps = 0;
  #processedFps = 0;

  constructor(config: FaceFilterConfig) {
    this.#cfg = { ...config };
  }

  get degradeStep(): number {
    return this.#ladder.step;
  }

  /** Snapshot for the stats overlay. */
  toneStats(): CameraToneStats {
    return {
      toneLive: !!this.#stage && !this.#stageLost && !this.#stageBlind,
      stages: [...this.#activeStages],
      sourceFps: this.#sourceFps,
      processedFps: this.#processedFps,
      pageMode: this.#pageMode,
      lowLightGain:
        this.#stage && !this.#stageLost ? this.#tone.lowLightGain : 1,
    };
  }

  /**
   * Live config update (slider drags, sticker swaps) — no processor rebuild.
   * May lazily start landmarker init when landmarks become needed, and frees
   * the landmarker (WASM + delegate memory) when they stop being needed. The
   * tone stage follows the same rule. A pure tune: the processed track and
   * its canvas are never replaced here.
   *
   * Switching a tone setting on (low light, or whole-frame touch up) after
   * tone failed open gives tone one fresh attempt with a fresh recovery
   * budget; `onToneFailed` fires again only if that attempt fails too.
   */
  setConfig(config: FaceFilterConfig) {
    const lowLightWas = this.#cfg.lowLight;
    const wantsWas = toneWants(this.#cfg);
    this.#cfgGen++;
    this.#cfg = { ...config };
    if (this.#disposed) return;
    // Low light switched off: forget the room, so the gain is 1 at once and
    // the next switch-on ramps up from 1.
    if (lowLightWas && !this.#cfg.lowLight) this.#resetMeter();
    if (this.#toneFailed && toneTurnedOn(wantsWas, toneWants(this.#cfg))) {
      this.#toneFailed = false;
      this.#lossLadder.reset();
      this.#stuckLadder.reset();
    }
    void this.#syncBitmaps();
    if (wantsLandmarks(this.#cfg)) {
      this.#ensureLandmarker();
    } else if (this.#landmarker) {
      // Look-only config: release detection resources (lazily re-inits later).
      this.#landmarker.close();
      this.#landmarker = undefined;
      this.#lastLandmarks = undefined;
    }
    this.#syncStage();
    this.#reportStatus();
  }

  async init(opts: { track: MediaStreamTrack }) {
    // FULL build from scratch — also the recover path after destroy() (the
    // bitmap cache was cleared and the landmarker closed; nothing resumes).
    this.#disposed = false;
    this.#stopped = false;
    this.#detectFails = 0;
    this.#frameCounter = 0;
    this.#lastLandmarks = undefined;
    this.#ladder.reset(this.#landmarker ? 0 : this.#ladder.step);
    // A full build gets a fresh tone budget: one context-loss rebuild, one
    // stuck rebuild, and `onToneFailed` may fire once more.
    this.#dropStage();
    this.#toneFailed = false;
    this.#stuckLadder.reset();
    this.#lossLadder.reset();
    this.#bypass = false;
    this.#pageMode = "frame";
    this.#drawnMediaTime = -1;
    this.#resetFpsWindow();

    this.source = opts.track;

    // Pipeline failures below (canvas/video/captureStream) REJECT init — the
    // controller's fail-safe teardown handles it (raw track keeps publishing).
    this.#video = document.createElement("video");
    this.#video.srcObject = new MediaStream([opts.track]);
    this.#video.muted = true;
    await this.#video.play();

    this.#canvas = document.createElement("canvas");
    this.#canvas.width = this.#video.videoWidth || 640;
    this.#canvas.height = this.#video.videoHeight || 480;
    const ctx = this.#canvas.getContext("2d");
    if (!ctx) throw new Error("face-filter: no 2d context");
    this.#ctx = ctx;

    const stream = this.#canvas.captureStream(30);
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error("face-filter: captureStream yielded no track");
    this.processedTrack = track;

    await this.#syncBitmaps();
    this.#ensureLandmarker();
    // Never throws: a stage that cannot be built leaves the 2D path running.
    this.#syncStage();
    // A destroy() that ran during the awaits above must not leave a listener.
    if (!this.#disposed) {
      document.addEventListener("visibilitychange", this.#onVisibility);
    }
    this.#scheduleFrame();
    this.#reportStatus();
  }

  /**
   * Live rebind after a device switch (LiveKit calls this unconditionally
   * inside LocalTrack.restart). Keep landmarker/canvases/bitmaps.
   */
  async restart(opts: { track: MediaStreamTrack }) {
    if (this.#disposed || !this.#video) {
      // Defensive: a restart on a torn-down instance behaves like init.
      await this.init(opts);
      return;
    }
    const video = this.#video;
    this.source = opts.track;
    video.srcObject = new MediaStream([opts.track]);
    try {
      await video.play();
    } catch (e) {
      // destroy() pauses the video, which rejects a pending play(): a
      // teardown that raced this rebind is not a failure of it.
      if (this.#disposed) return;
      throw e;
    }
    // destroy() can land during the await (LiveKit calls it outside its
    // track lock). Nothing is left to rebind then: return quietly.
    if (this.#disposed || this.#video !== video) return;
    this.#lastLandmarks = undefined;
    this.#detectFails = 0;
    // The new device counts its frames and its media time from scratch.
    this.#drawnMediaTime = -1;
    this.#resetFpsWindow();
    this.#syncStage();
    // The stage follows the new source at once. The 2D canvas is resized in
    // the frame loop, in the same task as the draw that refills it, so the
    // captured canvas is never left cleared between the two.
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      this.#stage?.resize(video.videoWidth, video.videoHeight);
    }
    this.#scheduleFrame();
  }

  async destroy() {
    this.#disposed = true;
    this.#stopped = true;
    this.#cfgGen++;
    this.#cancelFrame();
    document.removeEventListener("visibilitychange", this.#onVisibility);
    this.#dropStage();
    // LiveKit's stopProcessor stops processedTrack on the normal path; stop it
    // here too so the controller's direct destroy() paths (superseded init,
    // failed setProcessor) don't leave a live canvas-capture track dangling.
    this.processedTrack?.stop();
    this.#video?.pause();
    this.#video = undefined;
    this.#canvas = undefined;
    this.#ctx = undefined;
    this.#smoothCanvas = undefined;
    this.#smoothCtx = undefined;
    this.#maskCanvas = undefined;
    this.#maskCtx = undefined;
    this.#probeCanvas = undefined;
    this.#probeCtx = undefined;
    this.processedTrack = undefined;
    this.source = undefined;
    this.#landmarker?.close();
    this.#landmarker = undefined;
    for (const bmp of this.#bitmaps.values()) bmp.close();
    this.#bitmaps.clear();
    this.#lastLandmarks = undefined;
  }

  // -------------------------------------------------------------------------
  // Frame loop
  // -------------------------------------------------------------------------

  /**
   * (Re)start the frame driver that fits the page: rVFC (rAF where it is
   * missing) while visible, a timer while hidden, because neither rVFC nor
   * rAF fires on a hidden page and the published picture would freeze.
   */
  #scheduleFrame() {
    this.#cancelFrame();
    const video = this.#video;
    if (!video || this.#stopped) return;
    // The stall clock of the hidden timer starts with the driver.
    this.#lastTickAt = performance.now();
    if (document.visibilityState === "hidden") {
      this.#timerId = setInterval(this.#onTimer, HIDDEN_FRAME_INTERVAL_MS);
      return;
    }
    if ("requestVideoFrameCallback" in video) {
      this.#vfcDriver = true;
      const tick = (_now: number, metadata: VideoFrameCallbackMetadata) => {
        if (this.#stopped) return;
        this.#presentedFrames = metadata.presentedFrames;
        this.#drawFrame();
        this.#vfcId = video.requestVideoFrameCallback(tick);
      };
      this.#vfcId = video.requestVideoFrameCallback(tick);
    } else {
      const tick = () => {
        if (this.#stopped) return;
        this.#drawFrame();
        this.#rafId = requestAnimationFrame(tick);
      };
      this.#rafId = requestAnimationFrame(tick);
    }
  }

  #cancelFrame() {
    if (this.#vfcId !== undefined) {
      // rVFC must be cancelled on the VIDEO element, not via cancelAnimationFrame.
      this.#video?.cancelVideoFrameCallback?.(this.#vfcId);
      this.#vfcId = undefined;
    }
    if (this.#rafId !== undefined) {
      cancelAnimationFrame(this.#rafId);
      this.#rafId = undefined;
    }
    if (this.#timerId !== undefined) {
      clearInterval(this.#timerId);
      this.#timerId = undefined;
    }
    this.#vfcDriver = false;
  }

  /**
   * Whether the camera can be delivering frames at all. Camera off is a
   * LiveKit mute: the source track is stopped ("ended") but this processor
   * stays attached, so nothing else says "no frames".
   */
  #sourceLive(): boolean {
    const source = this.source;
    return !!source && source.readyState === "live" && !source.muted;
  }

  /**
   * Hidden-page tick. Unlike rVFC, a timer fires whether or not the camera
   * produced anything, so it draws only a NEW frame of a LIVE source. An idle
   * tick does no drawing, no detection and no GL: it only keeps the stall
   * clock running, so a long spell without frames is not taken for a stalled
   * timer when frames come back.
   */
  #onTimer = () => {
    if (this.#stopped) return;
    const video = this.#video;
    if (!video) return;
    if (
      !this.#sourceLive() ||
      video.videoWidth === 0 ||
      video.currentTime === this.#drawnMediaTime
    ) {
      this.#updatePageMode(performance.now());
      this.#resetFpsWindow();
      return;
    }
    this.#drawFrame();
  };

  /** Swap the frame driver when the page is hidden or shown. */
  #onVisibility = () => {
    if (this.#disposed || this.#stopped) return;
    // A new hidden spell gets a fresh chance at the timer; a visible page
    // never bypasses.
    this.#bypass = false;
    // The restore deadline counts visible time only: a hidden page may not
    // get its context back until it is shown.
    if (this.#stageLost) {
      this.#lostAt = performance.now();
      // Back on screen with the context already usable (a restore that came
      // while hidden and could not rebuild then): rebuild now. A failure
      // here is not counted; the restore event or the deadline settles it.
      if (document.visibilityState !== "hidden" && this.#stage?.rebuild()) {
        this.#noteStageRebuilt();
      }
    }
    this.#resetFpsWindow();
    this.#scheduleFrame();
  };

  /**
   * One driver tick's page mode. Once the hidden timer has stalled, the mode
   * stays "bypass" until the page is visible again. The stall is judged on
   * the gap between TICKS (drawn or idle), never between drawn frames.
   */
  #updatePageMode(now: number): TonePageMode {
    const args = this.#pageArgs;
    args.hidden = document.visibilityState === "hidden";
    if (!args.hidden) this.#bypass = false;
    let mode: TonePageMode = "bypass";
    if (!this.#bypass) {
      args.timerHolds = toneTimerHolds(now - this.#lastTickAt);
      mode = tonePageMode(args);
      if (mode === "bypass") this.#bypass = true;
    }
    this.#lastTickAt = now;
    this.#pageMode = mode;
    return mode;
  }

  #drawFrame() {
    const video = this.#video;
    const canvas = this.#canvas;
    const ctx = this.#ctx;
    if (!video || !canvas || !ctx || video.videoWidth === 0) return;
    // A dead source has nothing new to show: no draw, no detect, no GL. This
    // is what keeps the rAF fallback from spinning on a stopped camera.
    if (!this.#sourceLive()) return;

    const start = performance.now();
    this.#frameCounter++;
    this.#drawnMediaTime = video.currentTime;

    // Track source resolution changes (LiveKit restarts/simulcast, a camera
    // flip that swaps the aspect ratio). The stage is resized to the same
    // size right before it draws.
    if (
      canvas.width !== video.videoWidth ||
      canvas.height !== video.videoHeight
    ) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      this.#smoothCanvas = undefined; // rebuilt lazily at the right size
      this.#maskCanvas = undefined;
    }

    const cfg = this.#cfg;
    const step = this.#ladder.step;

    // 0. Page mode.
    const pageMode = this.#updatePageMode(start);
    const hidden = this.#pageArgs.hidden;

    // A lost context that is not restored in time fails open exactly like a
    // second loss (the stage is gone before the tone block below reads it).
    if (
      this.#stageLost &&
      !hidden &&
      start - this.#lostAt >= TONE_RESTORE_DEADLINE_MS
    ) {
      this.#failTone();
    }

    const look =
      cfg.lookId && COLOR_LOOKS[cfg.lookId]
        ? COLOR_LOOKS[cfg.lookId].cssFilter
        : undefined;

    // 1a. Tone base layer: the stage draws the video and its canvas is copied
    //     here in the SAME task (its drawing buffer does not outlive it).
    const stage = this.#stage;
    const shed = cfg.watchdog?.shed;
    const tone = this.#tone;
    let stageDrew = false;
    let toneMs = 0;
    if (stage && !this.#stageLost && pageMode !== "bypass") {
      const metering = cfg.lowLight && !shed?.has("lowLight");
      if (metering) {
        // The HELD luma goes in every frame so the gain moves smoothly; the
        // readback that refreshes it runs every few frames only.
        if (this.#heldLuma !== undefined) {
          this.#meter.push(this.#heldLuma, start);
        }
        tone.lowLightGain = this.#meter.gain;
      } else {
        tone.lowLightGain = 1;
      }
      tone.brightness = shed?.has("brightness")
        ? 1
        : brightnessMultiplier(cfg.brightness);
      // With landmarks the masked beautify below does the touch up.
      tone.smooth =
        cfg.landmarks || shed?.has("touchUp")
          ? 0
          : plainTouchUpStrength(cfg.beautify);

      const sampleDue = metering && this.#framesToSample <= 0;
      if (metering && !sampleDue) this.#framesToSample--;
      const neutral = toneIsNeutral(tone);
      // A neutral config skips the stage, except for the frames low light
      // needs to see the room: those upload the source for the meter only
      // and the raw video is still what gets drawn.
      if (!neutral || sampleDue) {
        const toneStart = performance.now();
        let drew = false;
        try {
          // A blind stage draws nothing: its frames count as refused, which
          // walks the stuck-draw path below to a rebuild or to fail open.
          if (!this.#stageBlind) {
            stage.resize(canvas.width, canvas.height);
            stage.setConfig(tone);
            drew = stage.draw(video);
          }
          // Once per build, before anything is copied or metered: a stage
          // that drew black from a camera frame that is not black.
          if (drew && this.#blindCheckDue) {
            this.#blindCheckDue = false;
            if (this.#stageDrewBlind(stage, video, tone.brightness)) {
              this.#stageBlind = true;
              drew = false;
            }
          }
          if (drew && !neutral) {
            ctx.filter = look ?? "none";
            ctx.drawImage(stage.canvas, 0, 0, canvas.width, canvas.height);
            stageDrew = true;
          }
          if (drew && sampleDue) {
            this.#framesToSample = LOW_LIGHT_SAMPLE_EVERY_FRAMES - 1;
            const luma = stage.sampleLuma();
            if (luma !== undefined) this.#heldLuma = luma;
          }
        } catch {
          // Fail open for this frame; a run of these ends in #noteStageDraw.
          drew = false;
        }
        ctx.filter = "none";
        this.#noteStageDraw(drew, start, hidden);
        toneMs = performance.now() - toneStart;
      }
    }

    const active = this.#activeStages;
    active.length = 0;
    if (stageDrew) {
      if (tone.smooth > 0) active.push("touchUp");
      if (tone.lowLightGain > 1) active.push("lowLight");
      if (tone.brightness !== 1) active.push("brightness");
    } else {
      // 1b. Raw base layer: color look + non-HW brightness on the source
      //     draw. Brightness is applied by exactly one mechanism per frame:
      //     the shader when the stage drew the frame, this filter otherwise.
      //     A shed brightness stage stays off while the stage is live.
      const brightnessShed = !!this.#stage && !!shed?.has("brightness");
      const filters: string[] = [];
      if (look) filters.push(look);
      if (cfg.brightness !== 100 && !brightnessShed) {
        filters.push(`brightness(${cfg.brightness}%)`);
      }
      ctx.filter = filters.length ? filters.join(" ") : "none";
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      ctx.filter = "none";
    }

    // 2. Landmarks (only when needed; cadence-halved at ladder step ≥ 1).
    let landmarks: NormalizedLandmark[] | undefined;
    if (wantsLandmarks(cfg) && this.#landmarker) {
      const skipDetect = step >= 1 && this.#frameCounter % 2 === 1;
      if (!skipDetect) {
        // detectForVideo timestamps must be strictly monotonic.
        const ts = Math.max(start, this.#lastTimestampMs + 1);
        this.#lastTimestampMs = ts;
        try {
          const result = this.#landmarker.detectForVideo(video, ts);
          this.#detectFails = 0;
          const face = result.faceLandmarks?.[0];
          if (face && face.length) {
            this.#lastLandmarks = face as NormalizedLandmark[];
            this.#lastLandmarksAge = 0;
          } else {
            this.#lastLandmarksAge++;
          }
        } catch (e) {
          if (++this.#detectFails >= DETECT_FAIL_LIMIT) {
            console.error("face-filter: landmark detection died", e);
            this.#failLandmarker();
          }
        }
      } else {
        this.#lastLandmarksAge++;
      }
      if (this.#lastLandmarksAge <= LANDMARK_HOLD_FRAMES) {
        landmarks = this.#lastLandmarks;
      }
    }

    const frame = landmarks
      ? computeFaceFrame(landmarks, canvas.width, canvas.height)
      : null;

    // 3. Beautify (masked smoothing) — needs a face; off at ladder step 3.
    if (frame && cfg.beautify > 0 && step < 3) {
      this.#applyBeautify(frame, landmarks!, cfg.beautify, step);
    }

    // 4. Stickers.
    if (frame && cfg.filterId && FACE_FILTERS[cfg.filterId]) {
      for (const layer of FACE_FILTERS[cfg.filterId].layers) {
        const bmp = this.#bitmaps.get(layer.src);
        if (!bmp) continue;
        const p = placeLayer(frame, layer);
        const h = (p.width * bmp.height) / bmp.width;
        ctx.setTransform(1, 0, 0, 1, p.cx, p.cy);
        ctx.rotate(p.rotation);
        ctx.drawImage(bmp, -p.width / 2, -h / 2, p.width, h);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
    }

    // The degrade ladder judges the landmark path only: tone time is the
    // watchdog's to judge, so it is taken out of the frame cost here.
    const prevStep = this.#ladder.step;
    const newStep = this.#ladder.record(
      performance.now() - start - toneMs,
      start,
    );
    if (newStep !== prevStep) this.#reportStatus();

    this.#measureFrameRate(start, hidden);
  }

  // -------------------------------------------------------------------------
  // Tone stage lifecycle (lazy; every failure is fail open)
  // -------------------------------------------------------------------------

  /**
   * Build the stage when the config needs it and release it when it no
   * longer does. Never throws: a stage that cannot be built fails tone open.
   */
  #syncStage() {
    const canvas = this.#canvas;
    if (this.#disposed || !canvas) return;
    if (!wantsToneStage(this.#cfg)) {
      if (this.#stage) this.#dropStage();
      return;
    }
    if (this.#stage || this.#toneFailed) return;
    try {
      const stage = new CameraToneStage();
      this.#stage = stage;
      stage.onContextLost = this.#onStageLost;
      stage.onContextRestored = this.#onStageRestored;
      stage.resize(canvas.width, canvas.height);
      this.#blindCheckDue = true;
    } catch (e) {
      console.error("face-filter: tone stage unavailable", e);
      this.#failTone();
    }
  }

  /** The ONLY places the context-loss ladder is climbed: the two events. */
  #onStageLost = () => {
    if (this.#disposed || !this.#stage) return;
    this.#missSince = -1;
    // Raw frames from here: when tone returns, the gain ramps up from 1.
    this.#resetMeter();
    // A loss on a hidden page (a backgrounded WebView dropping its GL
    // contexts) is not counted against the stage.
    const hidden = document.visibilityState === "hidden";
    if (this.#lossLadder.onLost(hidden) === "fail-open") {
      this.#failTone();
      return;
    }
    this.#stageLost = true;
    this.#lostAt = performance.now();
  };

  #onStageRestored = () => {
    const stage = this.#stage;
    if (this.#disposed || !stage || !this.#stageLost) return;
    if (stage.rebuild()) {
      this.#noteStageRebuilt();
      return;
    }
    // A rebuild that fails on a hidden page is not counted either: it is
    // tried again when the page is shown (`#onVisibility`), and the restore
    // deadline, which runs on visible time only, ends the wait.
    if (document.visibilityState === "hidden") return;
    this.#lossLadder.onRebuildFailed();
    this.#failTone();
  };

  /** A `rebuild()` succeeded: the stage draws again, and is checked again. */
  #noteStageRebuilt() {
    this.#stageLost = false;
    this.#stageBlind = false;
    this.#blindCheckDue = true;
    this.#missSince = -1;
  }

  /**
   * The one-time blind check: reads the raw frame and the frame the stage
   * just drew through a tiny 2D canvas and compares their mean lumas. No GL
   * readback, and never on the captured canvas. A check that cannot run says
   * "not blind": the GL error check in the stage still stands.
   */
  #stageDrewBlind(
    stage: CameraToneStage,
    video: HTMLVideoElement,
    brightness: number,
  ): boolean {
    try {
      if (!this.#probeCanvas) {
        const probe = document.createElement("canvas");
        probe.width = PROBE_SIZE;
        probe.height = PROBE_SIZE;
        this.#probeCanvas = probe;
        this.#probeCtx =
          probe.getContext("2d", { willReadFrequently: true }) ?? undefined;
      }
      const probeCtx = this.#probeCtx;
      if (!probeCtx) return false;
      probeCtx.drawImage(video, 0, 0, PROBE_SIZE, PROBE_SIZE);
      const sourceLuma = meanLuma(
        probeCtx.getImageData(0, 0, PROBE_SIZE, PROBE_SIZE).data,
      );
      probeCtx.drawImage(stage.canvas, 0, 0, PROBE_SIZE, PROBE_SIZE);
      const outputLuma = meanLuma(
        probeCtx.getImageData(0, 0, PROBE_SIZE, PROBE_SIZE).data,
      );
      return toneStageBlind({ sourceLuma, outputLuma, brightness });
    } catch (e) {
      console.error("face-filter: tone blind check could not run", e);
      return false;
    }
  }

  /**
   * Bookkeeping for one stage draw. A refused draw only means "raw video for
   * this frame". A run of them lasting TONE_STUCK_MS on a visible page, with
   * no context-loss event, gets one `rebuild()`; if that fails, or draws are
   * still refused that long after it, tone fails open. Both rebuild budgets
   * (this one and the context-loss one) are earned back by a steady run of
   * successful draws, which is counted here.
   */
  #noteStageDraw(drew: boolean, now: number, hidden: boolean) {
    this.#lossLadder.onDraw(drew, now);
    this.#stuckLadder.onDraw(drew, now);
    if (drew || hidden) {
      this.#missSince = -1;
      return;
    }
    if (this.#missSince < 0) {
      this.#missSince = now;
      return;
    }
    if (now - this.#missSince < TONE_STUCK_MS) return;
    this.#missSince = -1;
    if (this.#stuckLadder.onLost() === "fail-open" || !this.#stage?.rebuild()) {
      this.#failTone();
      return;
    }
    this.#noteStageRebuilt();
  }

  /** Release the stage (no longer needed, failed, or teardown). */
  #dropStage() {
    this.#stage?.destroy();
    this.#stage = undefined;
    this.#stageLost = false;
    this.#stageBlind = false;
    this.#blindCheckDue = false;
    this.#missSince = -1;
    this.#activeStages.length = 0;
    this.#resetMeter();
  }

  #resetMeter() {
    this.#meter.reset();
    this.#heldLuma = undefined;
    this.#framesToSample = 0;
    this.#tone.lowLightGain = 1;
  }

  /** Tone is off for this processor; the raw 2D path carries on. */
  #failTone() {
    if (this.#toneFailed) return;
    this.#toneFailed = true;
    this.#dropStage();
    if (this.#disposed) return;
    try {
      this.#cfg.onToneFailed?.();
    } catch (e) {
      console.error("face-filter: onToneFailed threw", e);
    }
  }

  // -------------------------------------------------------------------------
  // Frame-rate measurement + watchdog feed
  // -------------------------------------------------------------------------

  #resetFpsWindow() {
    this.#fpsWindowStart = -1;
    this.#sourceFps = 0;
    this.#processedFps = 0;
  }

  /**
   * Called once per drawn frame. About once a second of wall clock it turns
   * the frame count into `processedFps` and the rVFC `presentedFrames` delta
   * into `sourceFps` (0 without rVFC: unknown), then feeds the watchdog, but
   * only on a visible page, only while a tone stage is being drawn, and never
   * while the landmarker shares the frame.
   */
  #measureFrameRate(now: number, hidden: boolean) {
    if (this.#fpsWindowStart < 0) {
      // This frame is the origin of the window, not a frame inside it.
      this.#fpsWindowStart = now;
      this.#fpsFrames = 0;
      this.#fpsPresentedBase = this.#presentedFrames;
      return;
    }
    this.#fpsFrames++;
    const elapsed = now - this.#fpsWindowStart;
    if (elapsed < FPS_WINDOW_MS) return;

    const presented = this.#presentedFrames - this.#fpsPresentedBase;
    this.#processedFps = (this.#fpsFrames * 1000) / elapsed;
    this.#sourceFps =
      this.#vfcDriver && presented > 0 ? (presented * 1000) / elapsed : 0;
    this.#fpsWindowStart = now;
    this.#fpsFrames = 0;
    this.#fpsPresentedBase = this.#presentedFrames;

    const watchdog = this.#cfg.watchdog;
    if (!watchdog || hidden || this.#activeStages.length === 0) return;
    // With the landmarker in the frame (loading or detecting) a slow frame
    // is not evidence against tone: the degrade ladder owns that case.
    if (wantsLandmarks(this.#cfg) && !this.#landmarkerFailed) return;
    const shedNow = watchdog.sample(
      this.#sourceFps,
      this.#processedFps,
      now,
      this.#activeStages,
    );
    if (!shedNow) return;
    // The stage is in `watchdog.shed` already, so the very next frame draws
    // it neutral.
    if (shedNow === "lowLight") this.#resetMeter();
    try {
      this.#cfg.onToneShed?.(shedNow);
    } catch (e) {
      console.error("face-filter: onToneShed threw", e);
    }
  }

  /**
   * Masked skin smoothing (plan §4): blurred copy of the (look-graded) frame,
   * clipped to the face oval minus eye/mouth cutouts, composited at
   * strength-derived alpha. Smoothing runs at half resolution (quarter at
   * ladder step ≥ 2) — the blur hides the downscale.
   */
  #applyBeautify(
    frame: { iod: number },
    landmarks: NormalizedLandmark[],
    strength: number,
    step: number,
  ) {
    const canvas = this.#canvas!;
    const ctx = this.#ctx!;
    const scale = step >= 2 ? 0.25 : 0.5;
    const sw = Math.max(1, Math.round(canvas.width * scale));
    const sh = Math.max(1, Math.round(canvas.height * scale));

    if (!this.#smoothCanvas || this.#smoothCanvas.width !== sw) {
      this.#smoothCanvas = document.createElement("canvas");
      this.#smoothCanvas.width = sw;
      this.#smoothCanvas.height = sh;
      this.#smoothCtx = this.#smoothCanvas.getContext("2d") ?? undefined;
      this.#maskCanvas = document.createElement("canvas");
      this.#maskCanvas.width = sw;
      this.#maskCanvas.height = sh;
      this.#maskCtx = this.#maskCanvas.getContext("2d") ?? undefined;
    }
    const sctx = this.#smoothCtx;
    const mctx = this.#maskCtx;
    if (!sctx || !mctx) return;

    // Smoothed layer.
    sctx.globalCompositeOperation = "source-over";
    sctx.filter = `blur(${beautifyBlurPx(strength, frame.iod) * scale}px)`;
    sctx.drawImage(canvas, 0, 0, sw, sh);
    sctx.filter = "none";

    // Face mask: filled oval, feathered edge, eyes/mouth cut out.
    mctx.globalCompositeOperation = "source-over";
    mctx.clearRect(0, 0, sw, sh);
    mctx.filter = `blur(${Math.max(2, frame.iod * 0.06 * scale)}px)`;
    mctx.fillStyle = "#fff";
    mctx.fill(this.#landmarkPath(landmarks, FACE_OVAL, sw, sh));
    mctx.globalCompositeOperation = "destination-out";
    for (const ring of MASK_CUTOUTS) {
      mctx.fill(this.#landmarkPath(landmarks, ring, sw, sh));
    }
    mctx.filter = "none";
    mctx.globalCompositeOperation = "source-over";

    // Clip smoothed layer to the mask, then blend onto the main frame.
    sctx.globalCompositeOperation = "destination-in";
    sctx.drawImage(this.#maskCanvas!, 0, 0);
    sctx.globalCompositeOperation = "source-over";

    ctx.globalAlpha = beautifyAlpha(strength);
    ctx.drawImage(this.#smoothCanvas!, 0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 1;
  }

  #landmarkPath(
    landmarks: NormalizedLandmark[],
    ring: readonly number[],
    w: number,
    h: number,
  ): Path2D {
    const path = new Path2D();
    ring.forEach((idx, i) => {
      const lm = landmarks[idx];
      if (!lm) return;
      if (i === 0) path.moveTo(lm.x * w, lm.y * h);
      else path.lineTo(lm.x * w, lm.y * h);
    });
    path.closePath();
    return path;
  }

  // -------------------------------------------------------------------------
  // Landmarker lifecycle (lazy, guarded by #cfgGen/#disposed — plan §2)
  // -------------------------------------------------------------------------

  #ensureLandmarker() {
    if (
      !wantsLandmarks(this.#cfg) ||
      this.#landmarker ||
      this.#landmarkerFailed ||
      this.#landmarkerInitInFlight ||
      this.#disposed
    ) {
      return;
    }
    this.#landmarkerInitInFlight = true;
    void (async () => {
      let lm: FaceLandmarker | undefined;
      try {
        lm = await this.#createLandmarker();
      } catch (e) {
        console.error("face-filter: landmarker init failed", e);
      } finally {
        this.#landmarkerInitInFlight = false;
      }
      if (!lm) {
        this.#failLandmarker();
        return;
      }
      // Post-destroy resolve: free immediately — this is the leak class the
      // controller's #gen can't see (plan §2). The landmarker itself is
      // config-INDEPENDENT (fixed model, numFaces:1), so a mere setConfig
      // during the ~1s init is NOT staleness — discarding on #cfgGen would
      // chain throwaway 3.7MB model re-inits on every slider tick.
      if (this.#disposed) {
        lm.close();
        return;
      }
      if (!wantsLandmarks(this.#cfg)) {
        // Config dropped to look-only while we were initializing.
        lm.close();
        return;
      }
      this.#landmarker = lm;
      this.#reportStatus();
    })();
  }

  /** GPU first, one CPU retry — tasks-vision has NO internal fallback (plan §2). */
  async #createLandmarker(): Promise<FaceLandmarker> {
    const { FaceLandmarker: FL, FilesetResolver } =
      await import("@mediapipe/tasks-vision");
    const fileset = await FilesetResolver.forVisionTasks(
      `${MEDIAPIPE_BASE}/wasm`,
    );
    const options = (delegate: "GPU" | "CPU") => ({
      baseOptions: {
        modelAssetPath: `${MEDIAPIPE_BASE}/models/face_landmarker.task`,
        delegate,
      },
      runningMode: "VIDEO" as const,
      numFaces: 1,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    });
    try {
      return await FL.createFromOptions(fileset, options("GPU"));
    } catch (e) {
      console.warn("face-filter: GPU delegate failed, retrying CPU", e);
      const lm = await FL.createFromOptions(fileset, options("CPU"));
      // CPU sessions start pre-degraded (landmark cadence halved, plan §8).
      this.#ladder.reset(Math.max(1, this.#ladder.step));
      return lm;
    }
  }

  #failLandmarker() {
    this.#landmarkerFailed = true;
    this.#landmarker?.close();
    this.#landmarker = undefined;
    this.#lastLandmarks = undefined;
    this.#reportStatus();
  }

  // -------------------------------------------------------------------------
  // Sticker bitmaps (decode once per config — plan §3)
  // -------------------------------------------------------------------------

  /**
   * Decode the current filter's layers into the bitmap cache and drop bitmaps
   * no longer referenced. Guarded by #cfgGen so a stale decode run never
   * clobbers (or leaks into) a newer config's cache.
   */
  async #syncBitmaps() {
    const myGen = this.#cfgGen;
    // Without landmarks no sticker can be placed, so none is decoded.
    const wanted = new Set<string>(
      this.#cfg.landmarks && this.#cfg.filterId
        ? (FACE_FILTERS[this.#cfg.filterId]?.layers.map((l) => l.src) ?? [])
        : [],
    );

    for (const [src, bmp] of [...this.#bitmaps]) {
      if (!wanted.has(src)) {
        bmp.close();
        this.#bitmaps.delete(src);
      }
    }

    for (const src of wanted) {
      if (this.#bitmaps.has(src)) continue;
      let bmp: ImageBitmap;
      try {
        bmp = await decodeStickerBitmap(`${FILTER_ASSETS_BASE}/${src}`);
      } catch (e) {
        console.error(`face-filter: failed to decode sticker ${src}`, e);
        continue; // missing layer: draw the rest (fail-soft)
      }
      if (this.#disposed || myGen !== this.#cfgGen) {
        bmp.close();
        return;
      }
      this.#bitmaps.set(src, bmp);
    }
  }

  #reportStatus() {
    // A destroyed processor must never report — a late landmarker-init
    // rejection after teardown would otherwise flip the UI to "failed" while
    // filters/camera are already off (diff-review finding 1).
    if (this.#disposed) return;
    this.onStatus?.({
      landmarksFailed: wantsLandmarks(this.#cfg) && this.#landmarkerFailed,
      degraded: this.#ladder.step,
    });
  }
}

/**
 * Decode a sticker asset (SVG) into a raster ImageBitmap at a fixed working
 * width. SVG goes through an HTMLImageElement + canvas because Chromium's
 * `createImageBitmap(blob)` doesn't accept SVG blobs. Decoded ONCE per config;
 * the frame loop only ever `drawImage`s the cached bitmap.
 */
async function decodeStickerBitmap(url: string): Promise<ImageBitmap> {
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  await img.decode();
  const w = 512;
  const h = Math.max(
    1,
    Math.round((w * (img.naturalHeight || 1)) / (img.naturalWidth || 1)),
  );
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("face-filter: no 2d context for sticker decode");
  ctx.drawImage(img, 0, 0, w, h);
  return createImageBitmap(canvas);
}

export { DEGRADE };
