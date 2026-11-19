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
 *
 * The face-tracked look (`glam` in the config) is drawn by the tone stage
 * and follows the face with the same tracker stickers use, whatever
 * `landmarks` says. Its frame order is: detect, smooth, paint the coverage
 * map, hand the look to the stage, then the stage draws. Three rules keep
 * the tracker from getting in the way of the call:
 *  - It is loaded for the look only on a visible page and only while
 *    `gateHeld()` answers false. That is asked again on every frame; nothing
 *    is queued. `setConfig` never loads it for the look. It is asked once
 *    more when the files are in, right before the tracker is created: a load
 *    that may not create it then ends without one, and a later frame starts
 *    the next (the files are kept, so that one goes straight to the create).
 *  - The look's detection cadence and its time budget belong to `glamPolicy`,
 *    and so does every yes or no above: this file only passes the facts in.
 *    A frame callback runs at most one detect, and stickers reuse its result.
 *    The degrade ladder neither slows the cadence nor counts the look's time.
 *  - Running over the budget sheds the look for the call: it is recorded in
 *    the watchdog, reported through `onToneShed("glam")`, and the tracker is
 *    closed unless stickers still need it.
 * A look that cannot run (the tracker cannot be loaded, it throws, or the
 * stage cannot draw the look) is dropped and reported once through
 * `onGlamFailed`. Stickers, tone and the published picture carry on. A
 * tracker that died while the page was hidden is loaded again once, under
 * the same rules, before the look is given up.
 *
 * Why the look or tone stopped is kept as a short text (`glamStats.reason`,
 * `toneStats().reason`) and handed to `onGlamFailed` / `onToneFailed`, and
 * `toneStats().frame` says how the frame loop is doing. That is for the
 * hidden readout in the effects panel, the only output there is on a phone:
 * recorded, never read back to decide anything. The same goes for where a
 * tracker load stands (`glamStats.loadPhase`).
 *
 * A frame that throws does not end the frame loop: both ticks ask for the
 * next frame whatever the frame did, and the throw is counted and kept for
 * that readout (`#noteFrameThrew`).
 */
import type { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

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
import { type GlamStageInput, CameraToneStage } from "./cameraToneStage";
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
import { GlamMaskPainter } from "./glamMaskPainter";
import {
  type FrameHealth,
  type GlamGeometry,
  type GlamLevels,
  type GlamLoadPhase,
  GlamBudget,
  GlamDetectLatch,
  glamFailureText,
  glamGeometry,
  glamLevels,
  glamLoadFailedAt,
  glamLoadHeldPhase,
  glamMayCreateTracker,
  glamPresence,
  GlamRecovery,
  glamToneStuckText,
  glamTrackerFailure,
  glamTrackerLoadMustWait,
  LandmarkSmoother,
} from "./glamPolicy";

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
  /**
   * The face-tracked look, 0–100; 0 = off. It is drawn by the tone stage, so
   * it needs `tone`, and it uses the face tracker whatever `landmarks` says:
   * `landmarks` only covers stickers and the masked touch up.
   */
  glam: number;
  /** Tone stage allowed on this device (`cameraToneSupported()`). */
  tone: boolean;
  /**
   * Owned by the controller and outlives this processor. The processor feeds
   * it and keeps every stage in `watchdog.shed` neutral.
   */
  watchdog?: ToneWatchdog;
  onToneShed?: (stage: ToneStageName) => void;
  /**
   * Tone failed open for this processor; the raw 2D path continues.
   * `reason` is a short text for the diagnostic readout.
   */
  onToneFailed?: (reason: string) => void;
  /**
   * True while the call is in the middle of work the face tracker must not
   * hold up. While it answers true the tracker is not loaded for the look
   * and the look runs no detect. Asked again on every frame; a throw counts
   * as true.
   */
  gateHeld?: () => boolean;
  /**
   * The look cannot run on this processor. Called at most once per
   * processor; from then on it behaves as if `glam` were 0. Stickers, tone
   * and the published picture are not affected. `reason` is a short text
   * for the diagnostic readout, and so is `gpuError`: what the GPU try of
   * the tracker load failed with, "" when it did not.
   */
  onGlamFailed?: (reason: string, gpuError: string) => void;
}

/**
 * - "off": not asked for (`glam` 0, or no tone stage on this device).
 * - "waiting": asked for, the face tracker is not loaded yet.
 * - "on": the tracker is loaded (a face may or may not be in view).
 * - "shed": given up for the call because it was too slow.
 * - "failed": it cannot run here (also while tone itself has failed open).
 */
export type GlamState = "off" | "waiting" | "on" | "shed" | "failed";

export interface GlamStats {
  /** Rolling mean and slowest time of one detect, in ms; 0 before the first. */
  detectMeanMs: number;
  detectMaxMs: number;
  /** A detect runs every this many frames. */
  every: number;
  /** What the loaded tracker runs on; "none" while there is no tracker. */
  delegate: "GPU" | "CPU" | "none";
  /** How long the last tracker took to create, in ms; 0 before the first. */
  initMs: number;
  /**
   * Why the look failed, as text for the diagnostic readout: which step it
   * was and what it said. "" while it has not failed.
   */
  reason: string;
  /**
   * What the GPU try of a tracker load failed with, kept also when the CPU
   * try then worked. "" when it did not fail or was not made.
   */
  gpuError: string;
  /**
   * How long ago the tracker last found a face, in ms; `undefined` when it
   * has found none since the look last came on.
   */
  faceAgoMs: number | undefined;
  /** Where the tracker load stands, and for how long it has, in ms. */
  loadPhase: GlamLoadPhase;
  loadPhaseMs: number;
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
  /** Why tone failed open, as text for the diagnostic readout; "" if not. */
  reason: string;
  /** How the frame loop is doing, for the same readout. */
  frame: FrameHealth;
}

export interface FaceFilterStatusReport {
  /** True when landmark-dependent features were requested but tracking is dead. */
  landmarksFailed: boolean;
  /** Current degrade-ladder step (0 = full quality … 3 = beautify off). */
  degraded: number;
}

/** A freshly created face tracker, with what it runs on and how long it took. */
interface CreatedTracker {
  tracker: FaceLandmarker;
  delegate: "GPU" | "CPU";
  ms: number;
}

/** What a tracker is created from. Kept, so a second load fetches nothing. */
interface TrackerKit {
  FL: typeof FaceLandmarker;
  fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;
  /** A load stopped between a failed GPU try and the CPU one: skip the GPU. */
  gpuFailed: boolean;
  /** What the GPU try failed with, for the diagnostic readout. */
  gpuError?: string;
}

/** Face pipelines built since the app was loaded (`FrameHealth.processor`). */
let processorsBuilt = 0;

/**
 * A diagnostic switch with no UI: `sloga:glam-delegate` set to `cpu` in
 * localStorage makes every tracker load skip the GPU try, so a device whose
 * GPU delegate gives bad results can be checked on the CPU one without a new
 * build. Read at each load. Unreadable storage reads as "not forced".
 */
function trackerCpuForced(): boolean {
  try {
    return localStorage.getItem("sloga:glam-delegate") === "cpu";
  } catch {
    return false;
  }
}

/**
 * Whether stickers or the masked touch up need face landmarks.
 * `landmarks: false` wins over both: for them it is the one gate in front of
 * every MediaPipe path (import, wasm/model fetch, creation, detection). The
 * face-tracked look is not part of this test; it asks for the tracker on its
 * own terms (`#wantsGlam`).
 */
function wantsLandmarks(cfg: FaceFilterConfig): boolean {
  return cfg.landmarks && (!!cfg.filterId || cfg.beautify > 0);
}

/**
 * Whether this config has tone work that needs the stage built: low light,
 * touch up on a device without landmarks, or the face-tracked look (`glam`:
 * it is asked for and not given up). Brightness alone never builds it (it
 * stays on the 2D filter), but rides in the shader once it is live.
 */
function wantsToneStage(cfg: FaceFilterConfig, glam: boolean): boolean {
  return (
    cfg.tone && (cfg.lowLight || (!cfg.landmarks && cfg.beautify > 0) || glam)
  );
}

/** The same test as `wantsToneStage`, one setting at a time. */
function toneWants(cfg: FaceFilterConfig, glam: boolean): ToneWants {
  return {
    lowLight: cfg.tone && cfg.lowLight,
    touchUp: cfg.tone && !cfg.landmarks && cfg.beautify > 0,
    glam: cfg.tone && glam,
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

  // --- Face-tracked look (drawn by the stage; see the file header) ---
  /** The look cannot run on this processor. Never cleared. */
  #glamFailed = false;
  /** A frame found the look wanted and nothing has wound it down since. */
  #glamLive = false;
  /** Not reset by a rebuild: a shed lasts for the call. */
  #glamBudget = new GlamBudget();
  #glamRecovery = new GlamRecovery();
  #glamSmoother = new LandmarkSmoother();
  /** Made at the first paint, released on destroy. */
  #glamPainter: GlamMaskPainter | undefined;
  /** What the coverage map was last painted from. */
  #glamGeometry: GlamGeometry | undefined;
  /** Width / height of the frame `#glamGeometry` was measured on. */
  #glamAspect = 0;
  /**
   * When the face behind `#glamGeometry` was seen; -Infinity = not since
   * the look last came on (only the diagnostic readout tells the two apart).
   */
  #glamSeenAt = -Infinity;
  /** When a detect last ran while the look was on; -Infinity = never. */
  #glamDetectAt = -Infinity;
  /** The stage holds a look: the last `setGlam` was not null. */
  #glamSet = false;
  /** Reused every frame: what the stage is handed. */
  #glamInput: GlamStageInput | undefined;
  #glamLevels: GlamLevels | undefined;
  /** The `glam` setting `#glamLevels` was worked out from. */
  #glamLevelsFor = 0;
  /** Reused every frame: what `#detectLatch.mayDetect` is asked. */
  #glamDetectArgs = {
    frame: 0,
    every: 0,
    hidden: false,
    shed: false,
    gateHeld: false,
    msSinceDetect: 0,
  };
  /** Reused: what the two tracker-creation rules are asked (`#trackerAsk`). */
  #trackerArgs = {
    stickers: false,
    forGlam: false,
    wanted: false,
    gateHeld: false,
    hidden: false,
    shed: false,
    failed: false,
  };
  /** The first frame this stage build draws with the look is unchecked. */
  #glamBlindCheckDue = false;
  /** The page is visible again and no frame has been drawn since. */
  #glamReturnDue = false;
  /** The tracker is to be loaded again as soon as that is allowed. */
  #glamRecreateDue = false;
  /** The tracker load in flight is that second load. */
  #glamRecreateInFlight = false;
  /**
   * Names the tracker load in flight. Bumped when a load starts and when
   * one is abandoned; a load that finishes under an old number is closed
   * and says nothing.
   */
  #trackerGen = 0;
  #trackerDelegate: "GPU" | "CPU" = "GPU";
  #trackerInitMs = 0;
  /** The library and its file set, once a load has fetched them. */
  #trackerKit: TrackerKit | undefined;

  // --- For the diagnostic readout only (never read to decide anything) ---
  /** Why the look failed (`#failGlam`); "" while it has not. */
  #glamReason = "";
  /** Why tone failed open (`#failTone`); cleared with `#toneFailed`. */
  #toneReason = "";
  /** What the tracker's last detect threw. */
  #detectError = "";
  /** This pipeline's number, and when it was built. */
  #serial = 0;
  #builtAt = 0;
  /** Frames drawn to the end, and when the last one was. */
  #framesDone = 0;
  #lastFrameAt = -1;
  /** Frames that threw, and what the last of them threw. */
  #framesThrew = 0;
  #frameError = "";
  /** What the stage draw block last threw, in the current run of refusals. */
  #stageDrawError = "";
  /** Where the tracker load stands, and when it got there (`#noteLoad`). */
  #loadPhase: GlamLoadPhase = "not started";
  #loadPhaseAt = 0;
  /** What `#scheduleFrame` last set up to call the frames. */
  #driver: FrameHealth["driver"] = "none";

  // --- This frame callback only (reset at the top of every frame) ---
  /** Owns "the one detect a frame callback may run has run". */
  #detectLatch = new GlamDetectLatch();
  /** Its result: the face, null for no face, undefined if it threw or never ran. */
  #frameFace: NormalizedLandmark[] | null | undefined;
  /** Time the look took that the degrade ladder must not count. */
  #frameGlamMs = 0;

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
      reason: this.#toneReason,
      frame: this.#frameHealth(),
    };
  }

  /** How the frame loop is doing right now; see `FrameHealth`. */
  #frameHealth(): FrameHealth {
    const now = performance.now();
    return {
      processor: this.#serial,
      upMs: now - this.#builtAt,
      driver: this.#driver,
      // A tick drops its id when it runs and stores the next one when it
      // has asked for it, so an id in hand is a callback that is pending.
      scheduled:
        this.#vfcId !== undefined ||
        this.#rafId !== undefined ||
        this.#timerId !== undefined,
      frames: this.#framesDone,
      threw: this.#framesThrew,
      threwText: this.#frameError,
      frameAgeMs: this.#lastFrameAt < 0 ? -1 : now - this.#lastFrameAt,
      idle: this.#frameIdleReason(),
    };
  }

  /**
   * Why `#drawFrame` would return without drawing if it were called now:
   * the same tests it makes, in its order, with a name on each. A paused
   * video is added because nothing calls the frames then. "" when a frame
   * would be drawn.
   */
  #frameIdleReason(): string {
    const video = this.#video;
    if (!video || !this.#canvas || !this.#ctx) return "not built";
    if (video.videoWidth === 0) return "video has no size";
    const source = this.source;
    if (!source) return "no source";
    if (source.readyState !== "live") return `source ${source.readyState}`;
    if (source.muted) return "source muted";
    if (video.paused) return "video paused";
    return "";
  }

  /** Where the face-tracked look stands; see `GlamState`. */
  get glamState(): GlamState {
    const cfg = this.#cfg;
    if (!cfg.tone || !(cfg.glam > 0)) return "off";
    if (this.#glamFailed) return "failed";
    if (this.#glamShed()) return "shed";
    if (this.#toneFailed || this.#stage?.glamAvailable === false) {
      return "failed";
    }
    return this.#landmarker ? "on" : "waiting";
  }

  /** Numbers for the diagnostic line. */
  get glamStats(): GlamStats {
    const stats = this.#glamBudget.stats();
    // The frame clock: `#glamSeenAt` is a frame's `performance.now()`.
    const seenAt = this.#glamSeenAt;
    return {
      detectMeanMs: stats.mean,
      detectMaxMs: stats.max,
      every: stats.every,
      delegate: this.#landmarker ? this.#trackerDelegate : "none",
      initMs: this.#trackerInitMs,
      // Tone failing open ends the look too, with no reason of the look's.
      reason: this.#glamReason || (this.#toneFailed ? "tone failed" : ""),
      gpuError: this.#trackerKit?.gpuError ?? "",
      faceAgoMs:
        this.#glamLive && Number.isFinite(seenAt)
          ? Math.max(0, performance.now() - seenAt)
          : undefined,
      loadPhase: this.#loadPhase,
      loadPhaseMs: performance.now() - this.#loadPhaseAt,
    };
  }

  /**
   * Live config update (slider drags, sticker swaps) — no processor rebuild.
   * May lazily start landmarker init when landmarks become needed, and frees
   * the landmarker (WASM + delegate memory) when they stop being needed. The
   * tone stage follows the same rule. A pure tune: the processed track and
   * its canvas are never replaced here.
   *
   * Switching a tone setting on (low light, whole-frame touch up, or the
   * face-tracked look) after tone failed open gives tone one fresh attempt
   * with a fresh recovery budget; `onToneFailed` fires again only if that
   * attempt fails too.
   *
   * The face tracker is never loaded for the look from here: the frame loop
   * does that, when the page is visible and `gateHeld()` allows it.
   */
  setConfig(config: FaceFilterConfig) {
    const lowLightWas = this.#cfg.lowLight;
    const wantsWas = toneWants(this.#cfg, this.#glamRequested());
    const stickersWere = wantsLandmarks(this.#cfg);
    this.#cfgGen++;
    this.#cfg = { ...config };
    if (this.#disposed) return;
    // Low light switched off: forget the room, so the gain is 1 at once and
    // the next switch-on ramps up from 1.
    if (lowLightWas && !this.#cfg.lowLight) this.#resetMeter();
    if (
      this.#toneFailed &&
      toneTurnedOn(wantsWas, toneWants(this.#cfg, this.#glamRequested()))
    ) {
      this.#toneFailed = false;
      this.#toneReason = "";
      this.#lossLadder.reset();
      this.#stuckLadder.reset();
    }
    void this.#syncBitmaps();
    if (wantsLandmarks(this.#cfg)) {
      this.#ensureLandmarker();
      // Stickers joining a tracker that was loaded for the look on the CPU
      // start pre-degraded, as they would had it been loaded for them.
      if (
        !stickersWere &&
        this.#landmarker &&
        this.#trackerDelegate === "CPU"
      ) {
        this.#ladder.reset(Math.max(1, this.#ladder.step));
      }
    } else if (this.#landmarker) {
      // Look-only config: release detection resources (lazily re-inits
      // later), unless the face-tracked look is still using them.
      if (!this.#wantsGlam()) this.#releaseLandmarker();
      this.#lastLandmarks = undefined;
    }
    // The look was switched off: wind it down now, not at the next frame.
    if (this.#glamLive && !this.#wantsGlam()) this.#endGlam();
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
    this.#toneReason = "";
    this.#stuckLadder.reset();
    this.#lossLadder.reset();
    this.#serial = ++processorsBuilt;
    this.#builtAt = performance.now();
    this.#framesDone = 0;
    this.#lastFrameAt = -1;
    this.#framesThrew = 0;
    this.#frameError = "";
    // A pipeline with no load behind it counts "not started" from here.
    if (this.#loadPhase === "not started") this.#loadPhaseAt = this.#builtAt;
    this.#bypass = false;
    this.#pageMode = "frame";
    this.#drawnMediaTime = -1;
    this.#resetFpsWindow();
    // The face-tracked look starts over too, apart from two things that
    // last longer than a build: a look that failed stays failed, and a look
    // that was shed stays shed. A budget that is shed while the watchdog no
    // longer says so belongs to a call that is over.
    this.#clearGlamLook();
    this.#cancelGlamRecovery();
    this.#glamLive = false;
    this.#glamDetectAt = -Infinity;
    if (!this.#glamShed()) this.#glamBudget.reset();

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
      this.#noteGlamVisibility();
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
    // The face-tracked look starts over on the new camera: nothing of it is
    // drawn until the first detect there, and a second tracker load that was
    // pending or in flight for the old one is called off.
    this.#clearGlamLook();
    this.#cancelGlamRecovery();
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
    this.#clearGlamLook();
    this.#cancelGlamRecovery();
    this.#glamLive = false;
    this.#glamPainter?.dispose();
    this.#glamPainter = undefined;
    // It holds the painter's canvas.
    this.#glamInput = undefined;
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
    this.#releaseLandmarker();
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
      this.#driver = "timer";
      this.#timerId = setInterval(this.#onTimer, HIDDEN_FRAME_INTERVAL_MS);
      return;
    }
    // Both ticks ask for the next frame in a `finally`. A frame that throws
    // is counted (`#noteFrameThrew`) and the loop goes on; without the guard
    // one throw ends the loop and the published picture stays on its last
    // frame for the rest of the call. The next frame is asked for once, as
    // it is after a frame that drew, so a frame that throws every time runs
    // at the frame rate and no faster. A tick drops its id when it runs: a
    // loop that did end reads as not scheduled (`#frameHealth`).
    if ("requestVideoFrameCallback" in video) {
      this.#vfcDriver = true;
      this.#driver = "rvfc";
      const tick = (_now: number, metadata: VideoFrameCallbackMetadata) => {
        this.#vfcId = undefined;
        if (this.#stopped) return;
        this.#presentedFrames = metadata.presentedFrames;
        try {
          this.#drawFrame();
        } catch (e) {
          this.#noteFrameThrew(e);
        } finally {
          this.#vfcId = video.requestVideoFrameCallback(tick);
        }
      };
      this.#vfcId = video.requestVideoFrameCallback(tick);
    } else {
      this.#driver = "raf";
      const tick = () => {
        this.#rafId = undefined;
        if (this.#stopped) return;
        try {
          this.#drawFrame();
        } catch (e) {
          this.#noteFrameThrew(e);
        } finally {
          this.#rafId = requestAnimationFrame(tick);
        }
      };
      this.#rafId = requestAnimationFrame(tick);
    }
  }

  /**
   * A frame threw. It is counted, and what it threw is kept for the
   * diagnostic readout; asking for the next frame is the tick's job. The 2D
   * context is put back to its defaults: the frame can have stopped between
   * setting a transform, an alpha or a filter and putting it back, and the
   * frames after it would draw the camera through what was left. Never
   * throws.
   */
  #noteFrameThrew(e: unknown) {
    this.#framesThrew++;
    const text = glamFailureText(e);
    // Logged when it is new: a frame that throws every time would fill the
    // log at the frame rate.
    if (text !== this.#frameError) {
      console.error("face-filter: a frame threw", e);
    }
    this.#frameError = text;
    try {
      const ctx = this.#ctx;
      if (ctx) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.filter = "none";
      }
    } catch {
      // Nothing more can be done for this frame.
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
    this.#driver = "none";
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
    // The interval fires again whatever this frame does; the guard is here
    // so a throw is counted like one on a visible page.
    try {
      this.#drawFrame();
    } catch (e) {
      this.#noteFrameThrew(e);
    }
  };

  /** Swap the frame driver when the page is hidden or shown. */
  #onVisibility = () => {
    if (this.#disposed || this.#stopped) return;
    this.#noteGlamVisibility();
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
    // One call of this function is one frame callback, and each callback is
    // a task of its own: this line is what "at most one detect per task"
    // rests on, and nothing else may open the latch again.
    this.#detectLatch.beginTask();
    this.#frameFace = undefined;
    this.#frameGlamMs = 0;

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
      this.#failTone("tone: lost (not restored in time)");
    }

    const look =
      cfg.lookId && COLOR_LOOKS[cfg.lookId]
        ? COLOR_LOOKS[cfg.lookId].cssFilter
        : undefined;

    // 0b. Face-tracked look: tracker upkeep, this frame's detect and the
    //     coverage map, all BEFORE the stage draws, so the look is drawn
    //     from landmarks of the frame it is drawn on.
    const stickers = this.#stickersLive();
    const glamOn = this.#glamBeforeDraw(video, start, hidden, step);

    // 1a. Tone base layer: the stage draws the video and its canvas is copied
    //     here in the SAME task (its drawing buffer does not outlive it).
    const stage = this.#stage;
    const shed = cfg.watchdog?.shed;
    const tone = this.#tone;
    let stageDrew = false;
    let glamBlind = false;
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
      // The stage holds a look to draw: it draws even with nothing else to
      // do. While no face is in view it holds none, and a neutral frame is
      // the raw video as before.
      const glamDraw = glamOn && stage.glamWanted;
      // A neutral config skips the stage, except for the frames low light
      // needs to see the room: those upload the source for the meter only
      // and the raw video is still what gets drawn.
      if (!neutral || sampleDue || glamDraw) {
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
          // The same check once more, on the first frame the look is really
          // drawn on (the stage draws plain frames while it holds the look
          // back, and those leave this check waiting). Black here is the
          // look's fault, not the stage's (its plain draws passed): the
          // frame is not copied and the look is dropped below, while the
          // stage carries on.
          if (drew && stage.lastDrawUsedGlam && this.#glamBlindCheckDue) {
            this.#glamBlindCheckDue = false;
            glamBlind = this.#stageDrewBlind(stage, video, tone.brightness);
          }
          if (drew && !glamBlind && (!neutral || glamDraw)) {
            ctx.filter = look ?? "none";
            ctx.drawImage(stage.canvas, 0, 0, canvas.width, canvas.height);
            stageDrew = true;
          }
          if (drew && sampleDue) {
            this.#framesToSample = LOW_LIGHT_SAMPLE_EVERY_FRAMES - 1;
            const luma = stage.sampleLuma();
            if (luma !== undefined) this.#heldLuma = luma;
          }
        } catch (e) {
          // Fail open for this frame; a run of these ends in #noteStageDraw.
          drew = false;
          // For the diagnostic readout: what a stuck run was stuck on.
          this.#stageDrawError = glamFailureText(e);
        }
        ctx.filter = "none";
        this.#noteStageDraw(drew, start, hidden);
        toneMs = performance.now() - toneStart;
      }
    }

    const active = this.#activeStages;
    active.length = 0;
    if (stageDrew) {
      if (stage?.lastDrawUsedGlam) active.push("glam");
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

    // Asked on every frame the look is on: its first frame came out black,
    // or the stage gave up on it during the draw (that frame was drawn
    // again without it) or a rebuild. Only the look is dropped.
    if (glamOn && (glamBlind || this.#stage?.glamAvailable === false)) {
      this.#failGlam(glamBlind ? "blind" : this.#stageGlamFailure());
    }

    // 2. Landmarks (only when needed; cadence-halved at ladder step ≥ 1).
    //    With the face-tracked look on, this frame's detect has usually run
    //    already (step 0b) and its result is reused: never a second detect.
    let landmarks: NormalizedLandmark[] | undefined;
    if (stickers && this.#landmarker) {
      const skipDetect = step >= 1 && this.#frameCounter % 2 === 1;
      if (!skipDetect) this.#runDetect(video, start);
      const face = this.#frameFace;
      if (face) {
        this.#lastLandmarks = face;
        this.#lastLandmarksAge = 0;
      } else if (face === null || !this.#detectLatch.ran()) {
        // No face found, or no detect on this frame. A detect that threw
        // leaves the age alone.
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
    // watchdog's to judge, so it is taken out of the frame cost here, and
    // so is the time the face-tracked look took (its own budget judges it).
    const prevStep = this.#ladder.step;
    const newStep = this.#ladder.record(
      performance.now() - start - toneMs - this.#frameGlamMs,
      start,
    );
    if (newStep !== prevStep) this.#reportStatus();

    this.#measureFrameRate(start, hidden);
  }

  // -------------------------------------------------------------------------
  // Face-tracked look (every failure drops the look and nothing else)
  // -------------------------------------------------------------------------

  /** Stickers or the masked touch up are using the tracker right now. */
  #stickersLive(): boolean {
    return wantsLandmarks(this.#cfg) && !this.#landmarkerFailed;
  }

  /** Shed for the call. The watchdog's list is the record when there is one. */
  #glamShed(): boolean {
    const watchdog = this.#cfg.watchdog;
    return watchdog ? watchdog.shed.has("glam") : this.#glamBudget.shed();
  }

  /** The look is asked for and has not been given up (shed or failed). */
  #glamRequested(): boolean {
    const cfg = this.#cfg;
    if (!cfg.tone || !(cfg.glam > 0) || this.#glamFailed) return false;
    return !this.#glamShed();
  }

  /** `#glamRequested`, and the stage that has to draw it still can. */
  #wantsGlam(): boolean {
    return (
      this.#glamRequested() &&
      !this.#toneFailed &&
      (this.#stage?.glamAvailable ?? true)
    );
  }

  #gateHeld(): boolean {
    const held = this.#cfg.gateHeld;
    if (!held) return false;
    try {
      return !!held();
    } catch (e) {
      console.error("face-filter: gateHeld threw", e);
      return true;
    }
  }

  /**
   * The facts the two tracker-creation rules are asked with, read now.
   * `forGlam`: the look is asking, or started the load that is asking.
   */
  #trackerAsk(forGlam: boolean) {
    const ask = this.#trackerArgs;
    ask.stickers = this.#stickersLive();
    ask.forGlam = forGlam;
    ask.wanted = this.#wantsGlam();
    ask.gateHeld = this.#gateHeld();
    ask.hidden = document.visibilityState === "hidden";
    ask.shed = this.#glamShed();
    ask.failed = this.#glamFailed;
    return ask;
  }

  /** The page was hidden or shown (also called once at the start). */
  #noteGlamVisibility() {
    if (document.visibilityState === "hidden") {
      this.#glamRecovery.noteHidden();
    } else {
      // Acted on at the next frame, not here: only a frame can tell whether
      // the tracker survived the time in the background.
      this.#glamReturnDue = true;
    }
  }

  /**
   * The look's part of a frame that comes before the stage draw. Returns
   * whether the look is on for this frame. With `glam` 0 this is two cheap
   * tests and nothing else.
   */
  #glamBeforeDraw(
    video: HTMLVideoElement,
    now: number,
    hidden: boolean,
    step: number,
  ): boolean {
    // The first frame since the page came back.
    let recover = false;
    if (this.#glamReturnDue && !hidden) {
      this.#glamReturnDue = false;
      // The first detects after a spell in the background are slow.
      this.#glamBudget.noteWarmup();
      recover = this.#glamRecovery.onVisible(now) === "recreate";
    }
    if (!this.#glamRequested() || this.#toneFailed) {
      if (recover) this.#glamRecovery.cancel();
      if (this.#glamLive) this.#endGlam();
      return false;
    }

    const began = performance.now();
    let on = false;
    try {
      on = this.#glamStep(video, now, hidden, step, recover);
    } catch (e) {
      // A throw here would end the frame loop and freeze the picture.
      console.error("face-filter: the face-tracked look threw", e);
      this.#failGlam(`step threw "${glamFailureText(e)}"`);
    }
    // `+=`: the step has already taken out a detect that stickers share.
    this.#frameGlamMs += performance.now() - began;
    return on;
  }

  #glamStep(
    video: HTMLVideoElement,
    now: number,
    hidden: boolean,
    step: number,
    recover: boolean,
  ): boolean {
    // The look came back without a config change (a new call cleared the
    // shed list): the stage it draws on may not be built.
    if (!this.#stage) this.#syncStage();
    if (this.#stage?.glamAvailable === false) {
      this.#failGlam(this.#stageGlamFailure());
      return false;
    }
    // A budget that is shed while the watchdog does not say so: record it.
    if (this.#glamBudget.shed()) {
      this.#shedGlam();
      return false;
    }
    // The look is coming on: for the readout, no face has been seen yet.
    // Nothing is drawn from this time until a face sets it again (the look
    // was cleared when it went off).
    if (!this.#glamLive) this.#glamSeenAt = -Infinity;
    this.#glamLive = true;
    if (recover) this.#recreateTracker();

    const stickers = this.#stickersLive();
    if (!this.#landmarker) {
      // Loading starts only on a visible page with the gate empty. Nothing
      // is queued: a frame that may not start it leaves it to a later one.
      if (glamMayCreateTracker(this.#trackerAsk(true))) {
        this.#ensureLandmarker(true);
      } else if (!this.#landmarkerInitInFlight) {
        // For the diagnostic readout: why no load starts. The facts are the
        // ones the rule was just asked with.
        this.#noteLoad(glamLoadHeldPhase(this.#trackerArgs));
      }
    } else {
      const args = this.#glamDetectArgs;
      args.frame = this.#frameCounter;
      args.every = this.#glamBudget.every();
      args.hidden = hidden;
      args.shed = this.#glamBudget.shed();
      args.gateHeld = this.#gateHeld();
      args.msSinceDetect = now - this.#glamDetectAt;
      // Stickers keep the cadence they have without the look (every frame,
      // or every second one once degraded); the look only adds detects.
      const forStickers =
        stickers && !(step >= 1 && this.#frameCounter % 2 === 1);
      if (this.#detectLatch.mayDetect(args) || forStickers) {
        const detectStart = performance.now();
        const ok = this.#runDetect(video, now);
        const detectMs = performance.now() - detectStart;
        this.#glamDetectAt = now;
        // A detect stickers use too stays in the degrade ladder's frame
        // cost, where it is without the look.
        if (stickers) this.#frameGlamMs = -detectMs;
        if (!ok) {
          const action = this.#glamRecovery.noteFailure(now);
          if (action === "recreate") {
            this.#recreateTracker();
          } else if (!hidden) {
            this.#failGlam(`detect threw "${this.#detectError}"`);
            return false;
          }
          // A throw on a hidden page waits for the page to come back.
        } else {
          this.#glamBudget.noteDetect(detectMs, now);
          if (this.#glamBudget.shed()) {
            this.#shedGlam();
            return false;
          }
        }
      }
    }

    const aspect = video.videoWidth / video.videoHeight;
    // Geometry measured on another frame shape (a rotated camera) is void.
    if (this.#glamGeometry && this.#glamAspect !== aspect) {
      this.#clearGlamLook();
    }
    let painted = false;
    const face = this.#frameFace;
    if (face) {
      const geometry = glamGeometry(
        this.#glamSmoother.smooth(face, now),
        aspect,
      );
      if (geometry) {
        const painter = (this.#glamPainter ??= new GlamMaskPainter());
        painter.paint(geometry, aspect);
        this.#glamGeometry = geometry;
        this.#glamAspect = aspect;
        this.#glamSeenAt = now;
        painted = true;
      }
    }
    this.#sendGlam(now, painted);
    // The stage compiles the look's shader when it is first handed a look,
    // so this is where it finds out that it cannot. Asked through a fresh
    // name: the same question was answered "yes" at the top of this step,
    // and the answer can have changed since.
    const stage = this.#stage;
    if (stage && !stage.glamAvailable) {
      this.#failGlam(this.#stageGlamFailure());
      return false;
    }
    return true;
  }

  /** Why the stage cannot draw the look, in the stage's words. */
  #stageGlamFailure(): string {
    return this.#stage?.glamFailure || "the stage cannot draw the look";
  }

  /**
   * Hands the stage the look for this frame: the geometry the coverage map
   * was last painted from, faded by how long ago that face was seen. The
   * map itself goes along only when it was just repainted or the stage has
   * lost its copy.
   */
  #sendGlam(now: number, painted: boolean) {
    const geometry = this.#glamGeometry;
    const painter = this.#glamPainter;
    // No face seen yet, or it faded out: the stage already holds no look.
    if (!geometry || !painter) return;
    const presence = glamPresence(now - this.#glamSeenAt);
    if (!(presence > 0)) {
      // Faded out: one `setGlam(null)`, and the next face starts unsmoothed.
      this.#clearGlamLook();
      return;
    }
    const stage = this.#stage;
    if (!stage) return;
    const setting = this.#cfg.glam;
    let levels = this.#glamLevels;
    if (!levels || this.#glamLevelsFor !== setting) {
      levels = this.#glamLevels = glamLevels(setting);
      this.#glamLevelsFor = setting;
    }
    const map = painted || stage.needsGlamMap ? painter.canvas : null;
    let input = this.#glamInput;
    if (!input) {
      input = this.#glamInput = {
        levels,
        presence,
        warp: geometry.warp,
        box: geometry.box,
        aspect: this.#glamAspect,
        map,
      };
    } else {
      input.levels = levels;
      input.presence = presence;
      input.warp = geometry.warp;
      input.box = geometry.box;
      input.aspect = this.#glamAspect;
      input.map = map;
    }
    stage.setGlam(input);
    this.#glamSet = true;
  }

  /** Nothing of the look is drawn until a face is detected again. */
  #clearGlamLook() {
    if (this.#glamSet) {
      this.#stage?.setGlam(null);
      this.#glamSet = false;
    }
    this.#glamGeometry = undefined;
    this.#glamSmoother.reset();
  }

  /**
   * The look is no longer wanted (switched off, shed or failed): clear it
   * from the stage, call off a pending second tracker load, close the
   * tracker unless stickers use it, and release a stage nothing else needs.
   */
  #endGlam() {
    this.#glamLive = false;
    // Never throws. Frames call this outside any guard of their own, where a
    // throw would end the frame loop and freeze the picture, and the shed and
    // failed reports come after it and must not be lost to one. The tracker
    // goes first, so nothing that throws further down can leave it loaded.
    try {
      if (!this.#stickersLive()) this.#releaseLandmarker();
      this.#clearGlamLook();
      this.#cancelGlamRecovery();
      this.#syncStage();
    } catch (e) {
      console.error("face-filter: winding the face-tracked look down threw", e);
    }
  }

  /**
   * Tracking ran over its time budget: the look is off for the rest of the
   * call. Nothing but the notice follows from it.
   */
  #shedGlam() {
    const watchdog = this.#cfg.watchdog;
    const newly = watchdog ? watchdog.shedNow("glam") : true;
    this.#endGlam();
    if (!newly || this.#disposed) return;
    try {
      this.#cfg.onToneShed?.("glam");
    } catch (e) {
      console.error("face-filter: onToneShed threw", e);
    }
  }

  /**
   * The look cannot run on this processor; everything else carries on.
   * `why` is kept for the diagnostic readout and handed on with the report.
   */
  #failGlam(why: string) {
    if (this.#glamFailed) return;
    this.#glamFailed = true;
    this.#glamReason = why;
    this.#endGlam();
    if (this.#disposed) return;
    try {
      this.#cfg.onGlamFailed?.(why, this.#trackerKit?.gpuError ?? "");
    } catch (e) {
      console.error("face-filter: onGlamFailed threw", e);
    }
  }

  /**
   * The one second chance: close the tracker and have it loaded again. The
   * load itself starts from the frame loop, under the same rules as the
   * first one.
   */
  #recreateTracker() {
    this.#releaseLandmarker();
    if (this.#landmarkerInitInFlight) this.#glamRecreateInFlight = true;
    else this.#glamRecreateDue = true;
  }

  /**
   * Calls off a second tracker load that is pending or in flight, without
   * spending the allowance. A load in flight is abandoned: its result is
   * closed when it arrives and is never reported.
   */
  #cancelGlamRecovery() {
    this.#glamRecovery.cancel();
    const pending = this.#glamRecreateDue || this.#glamRecreateInFlight;
    this.#glamRecreateDue = false;
    if (this.#glamRecreateInFlight) {
      this.#glamRecreateInFlight = false;
      this.#trackerGen++;
      this.#landmarkerInitInFlight = false;
      this.#noteLoad("not started");
    }
    // Stickers lost their tracker to that second load: give it back.
    if (pending) this.#ensureLandmarker();
  }

  /**
   * The one detect a frame callback may run; a second call in the same
   * frame does nothing. The result is left in `#frameFace`. False when the
   * tracker threw.
   */
  #runDetect(video: HTMLVideoElement, now: number): boolean {
    const tracker = this.#landmarker;
    if (!tracker || !this.#detectLatch.claim()) return true;
    // detectForVideo timestamps must be strictly monotonic.
    const ts = Math.max(now, this.#lastTimestampMs + 1);
    this.#lastTimestampMs = ts;
    try {
      const result = tracker.detectForVideo(video, ts);
      this.#detectFails = 0;
      const face = result.faceLandmarks?.[0];
      this.#frameFace =
        face && face.length ? (face as NormalizedLandmark[]) : null;
      return true;
    } catch (e) {
      this.#detectError = glamFailureText(e);
      // Stickers put up with a few throws in a row; the look's own rule is
      // the caller's.
      if (this.#stickersLive() && ++this.#detectFails >= DETECT_FAIL_LIMIT) {
        console.error("face-filter: landmark detection died", e);
        this.#failLandmarker();
      }
      return false;
    }
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
    if (!wantsToneStage(this.#cfg, this.#glamRequested())) {
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
      this.#glamBlindCheckDue = true;
    } catch (e) {
      console.error("face-filter: tone stage unavailable", e);
      this.#failTone(`tone: build "${glamFailureText(e)}"`);
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
      this.#failTone("tone: lost (again, after a rebuild)");
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
    this.#failTone(`tone: lost (${stage.lastError || "the rebuild failed"})`);
  };

  /** A `rebuild()` succeeded: the stage draws again, and is checked again. */
  #noteStageRebuilt() {
    this.#stageLost = false;
    this.#stageBlind = false;
    this.#blindCheckDue = true;
    this.#glamBlindCheckDue = true;
    this.#missSince = -1;
    this.#stageDrawError = "";
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
      // A draw that worked ends the run the kept throw belongs to.
      if (drew) this.#stageDrawError = "";
      return;
    }
    if (this.#missSince < 0) {
      this.#missSince = now;
      return;
    }
    if (now - this.#missSince < TONE_STUCK_MS) return;
    this.#missSince = -1;
    // Read before the rebuild: one that fails puts its own word in place of
    // the one the draws were refused with.
    const said = this.#stage?.lastError ?? "";
    if (this.#stuckLadder.onLost() === "fail-open" || !this.#stage?.rebuild()) {
      this.#failTone(this.#stuckReason(said));
      return;
    }
    this.#noteStageRebuilt();
  }

  /**
   * Why draws were refused for too long, for the diagnostic readout: what
   * the stage last stopped on (`before` a rebuild that was tried, and after
   * it when that changed it), what the draw block last threw, and whether
   * the stage drew black. Worded by `glamToneStuckText`.
   */
  #stuckReason(before: string): string {
    const after = this.#stage?.lastError ?? "";
    return glamToneStuckText({
      stageSaid:
        before && after && before !== after
          ? `${before}, then ${after}`
          : after || before,
      threw: this.#stageDrawError,
      blind: this.#stageBlind,
    });
  }

  /** Release the stage (no longer needed, failed, or teardown). */
  #dropStage() {
    this.#stage?.destroy();
    this.#stage = undefined;
    this.#stageLost = false;
    this.#stageBlind = false;
    this.#blindCheckDue = false;
    this.#glamBlindCheckDue = false;
    // A stage built later starts without a look.
    this.#glamSet = false;
    this.#missSince = -1;
    this.#stageDrawError = "";
    this.#activeStages.length = 0;
    this.#resetMeter();
  }

  #resetMeter() {
    this.#meter.reset();
    this.#heldLuma = undefined;
    this.#framesToSample = 0;
    this.#tone.lowLightGain = 1;
  }

  /**
   * Tone is off for this processor; the raw 2D path carries on. `why` is
   * kept for the diagnostic readout and handed on with the report.
   */
  #failTone(why: string) {
    if (this.#toneFailed) return;
    this.#toneFailed = true;
    this.#toneReason = why;
    this.#dropStage();
    if (this.#disposed) return;
    try {
      this.#cfg.onToneFailed?.(why);
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
   * while stickers or the masked touch up have the landmarker in the frame.
   * The face-tracked look does not stop the feed: it is a stage like the
   * others here ("glam"), and the first to be shed.
   */
  #measureFrameRate(now: number, hidden: boolean) {
    // The last thing a frame does, so this is where a frame is counted as
    // drawn to the end (the diagnostic readout compares it with the frames
    // that began).
    this.#framesDone++;
    this.#lastFrameAt = now;
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
    // With the landmarker in the frame for stickers or the masked touch up
    // (loading or detecting) a slow frame is not evidence against tone: the
    // degrade ladder owns that case. The face-tracked look alone does not
    // count as that.
    if (this.#stickersLive()) return;
    const shedStage = watchdog.sample(
      this.#sourceFps,
      this.#processedFps,
      now,
      this.#activeStages,
    );
    if (!shedStage) return;
    // The stage is in `watchdog.shed` already, so the very next frame draws
    // it neutral (for the look: winds it down and closes its tracker).
    if (shedStage === "lowLight") this.#resetMeter();
    try {
      this.#cfg.onToneShed?.(shedStage);
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

  /**
   * `forGlam` false: stickers or the masked touch up ask (any time).
   * `forGlam` true: the face-tracked look asks; only the frame loop does,
   * once the page is visible and the gate is empty. One tracker serves both,
   * so whoever asks first loads it. A load that may not create the tracker
   * when its files are in ends with nothing loaded and nothing failed.
   */
  #ensureLandmarker(forGlam = false) {
    if (
      this.#landmarker ||
      this.#landmarkerInitInFlight ||
      this.#disposed ||
      (forGlam
        ? !this.#wantsGlam()
        : !wantsLandmarks(this.#cfg) || this.#landmarkerFailed)
    ) {
      return;
    }
    this.#landmarkerInitInFlight = true;
    const gen = ++this.#trackerGen;
    // Any load that starts while a second load is owed is that load.
    this.#glamRecreateInFlight = this.#glamRecreateDue;
    this.#glamRecreateDue = false;
    void (async () => {
      let made: CreatedTracker | "wait" | undefined;
      // For the diagnostic readout: the step that failed and what it said.
      let why = "";
      try {
        made = await this.#createLandmarker(forGlam);
      } catch (e) {
        console.error("face-filter: landmarker init failed", e);
        why = glamTrackerFailure(e, this.#trackerKit?.gpuError ?? "");
      }
      // Abandoned while it loaded: close it and say nothing to anyone.
      if (gen !== this.#trackerGen) {
        if (made !== "wait") this.#closeTracker(made?.tracker);
        return;
      }
      this.#landmarkerInitInFlight = false;
      const recreate = this.#glamRecreateInFlight;
      this.#glamRecreateInFlight = false;
      if (made === "wait") {
        // Not created and not failed. Nothing is queued and no timer runs:
        // the next frame that may start a load starts one. A second load
        // that had to wait is still owed, and its allowance is not spent.
        this.#noteLoad("wait");
        if (recreate) this.#glamRecreateDue = true;
        return;
      }
      if (recreate) this.#glamRecovery.noteRecreated(!!made);
      if (!made) {
        this.#noteLoad("failed");
        // Each user of the tracker fails on its own account.
        if (!forGlam || wantsLandmarks(this.#cfg)) this.#failLandmarker();
        if (!this.#disposed && this.#glamRequested()) {
          // A second load is made after a detect threw: say that too.
          this.#failGlam(
            recreate && this.#detectError
              ? `${why} (loaded again after detect threw "${this.#detectError}")`
              : why,
          );
        }
        return;
      }
      // Post-destroy resolve: free immediately — this is the leak class the
      // controller's #gen can't see (plan §2). The landmarker itself is
      // config-INDEPENDENT (fixed model, numFaces:1), so a mere setConfig
      // during the ~1s init is NOT staleness — discarding on #cfgGen would
      // chain throwaway 3.7MB model re-inits on every slider tick.
      if (this.#disposed) {
        this.#noteLoad("not started");
        this.#closeTracker(made.tracker);
        return;
      }
      if (!wantsLandmarks(this.#cfg) && !this.#wantsGlam()) {
        // Config dropped to look-only while we were initializing.
        this.#noteLoad("not started");
        this.#closeTracker(made.tracker);
        return;
      }
      this.#noteLoad("loaded");
      this.#landmarker = made.tracker;
      this.#trackerDelegate = made.delegate;
      this.#trackerInitMs = made.ms;
      // The first detects of a new tracker are slow whatever the device.
      this.#glamBudget.noteWarmup();
      this.#reportStatus();
    })();
  }

  /**
   * GPU first, one CPU retry — tasks-vision has NO internal fallback (plan §2).
   * `ms` is the wait for the tracker to be created, a failed GPU try
   * included; loading the library before it is not counted.
   *
   * "wait": the tracker would be created for the face-tracked look alone
   * and the look may not have one created right now (see
   * `glamTrackerLoadMustWait`). That is asked right before each create, not
   * only when the load starts: the library can take seconds to arrive, and
   * the create is the part that blocks the thread. The library and the file
   * set are kept, so the load that follows asks again at once.
   */
  async #createLandmarker(forGlam: boolean): Promise<CreatedTracker | "wait"> {
    // The load this call belongs to (`#ensureLandmarker` has just numbered
    // it): the step it is in is recorded for the diagnostic readout, and a
    // load that was abandoned records nothing.
    const gen = this.#trackerGen;
    let kit = this.#trackerKit;
    if (!kit) {
      this.#noteLoad("import", gen);
      const { FaceLandmarker: FL, FilesetResolver: resolver } =
        await import("@mediapipe/tasks-vision").catch(
          glamLoadFailedAt("import"),
        );
      this.#noteLoad("fileset", gen);
      const fileset = await resolver
        .forVisionTasks(`${MEDIAPIPE_BASE}/wasm`)
        .catch(glamLoadFailedAt("fileset"));
      kit = this.#trackerKit = { FL, fileset, gpuFailed: false };
    }
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
    // The diagnostic switch: this load and the ones after it go straight to
    // the CPU try, which has its own check in front of it.
    if (trackerCpuForced()) kit.gpuFailed = true;
    const began = performance.now();
    if (!kit.gpuFailed) {
      // The step is recorded before the check, so that nothing at all sits
      // between the check and the create.
      this.#noteLoad("gpu create", gen);
      if (glamTrackerLoadMustWait(this.#trackerAsk(forGlam))) return "wait";
      try {
        const tracker = await kit.FL.createFromOptions(
          kit.fileset,
          options("GPU"),
        );
        // What an earlier load's GPU try failed with is not this tracker's.
        kit.gpuError = undefined;
        return { tracker, delegate: "GPU", ms: performance.now() - began };
      } catch (e) {
        console.warn("face-filter: GPU delegate failed, retrying CPU", e);
        kit.gpuError = glamFailureText(e);
      }
    }
    // The GPU try can have taken a while too: ask again before the CPU one.
    this.#noteLoad("cpu create", gen);
    if (glamTrackerLoadMustWait(this.#trackerAsk(forGlam))) {
      // The load that follows goes straight to the CPU.
      kit.gpuFailed = true;
      return "wait";
    }
    const tracker = await kit.FL.createFromOptions(
      kit.fileset,
      options("CPU"),
    ).catch(glamLoadFailedAt("cpu"));
    // CPU sessions start pre-degraded (landmark cadence halved, plan §8).
    // Not when only the face-tracked look uses the tracker: its cadence
    // has one owner, its own time budget. Stickers that join such a
    // tracker later are pre-degraded then (`setConfig`).
    if (wantsLandmarks(this.#cfg) || !this.#wantsGlam()) {
      this.#ladder.reset(Math.max(1, this.#ladder.step));
    }
    return { tracker, delegate: "CPU", ms: performance.now() - began };
  }

  /**
   * The one place a tracker is closed. A close that throws is logged and
   * nothing more: several of the callers are inside a frame callback, where
   * a throw would end the frame loop and freeze the published picture.
   */
  #closeTracker(tracker: FaceLandmarker | undefined) {
    if (!tracker) return;
    try {
      tracker.close();
    } catch (e) {
      console.error("face-filter: closing the face tracker threw", e);
    }
  }

  /** Lets go of the loaded tracker, then closes it. */
  #releaseLandmarker() {
    const tracker = this.#landmarker;
    this.#landmarker = undefined;
    // For the diagnostic readout: the next load has not started.
    if (tracker) this.#noteLoad("not started");
    this.#closeTracker(tracker);
  }

  /**
   * For the diagnostic readout: the tracker load entered `phase`. A load
   * that was abandoned (`gen` is not the current load's) records nothing,
   * and a phase that is entered again while it lasts keeps its first time.
   * Recorded only: nothing reads it to decide anything.
   */
  #noteLoad(phase: GlamLoadPhase, gen = this.#trackerGen) {
    if (gen !== this.#trackerGen || phase === this.#loadPhase) return;
    this.#loadPhase = phase;
    this.#loadPhaseAt = performance.now();
  }

  /**
   * Stickers and the masked touch up have lost tracking for good. The
   * tracker itself stays while the face-tracked look is using it.
   */
  #failLandmarker() {
    this.#landmarkerFailed = true;
    if (!this.#wantsGlam()) this.#releaseLandmarker();
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
