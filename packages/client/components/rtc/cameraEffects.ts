/**
 * Shared camera-effects engine.
 *
 * ONE implementation of "apply brightness + background to a LiveKit
 * LocalVideoTrack", used by BOTH the in-call path (rtc `Voice` state) and the
 * settings preview so they can never diverge. See camera-effects-plan.md.
 *
 * Effect composition (the crux — verified against livekit-client + track-processors):
 *  - The LiveKit processor slot holds AT MOST ONE processor. This controller
 *    keeps EITHER a background wrapper OR the canvas brightness fallback there,
 *    never both.
 *  - Hardware brightness (`applyConstraints({advanced:[{brightness}]})`) is
 *    applied to the camera SOURCE — `videoTrack.mediaStreamTrack` when no
 *    processor is attached, or the wrapper's `.source` when a background is
 *    active (the getter returns the PROCESSED track once a processor exists, so
 *    constraining it would be a no-op). Hardware brightness therefore composes
 *    with a background.
 *  - Documented gap: on a camera lacking hardware brightness, brightness is
 *    unavailable WHILE a background effect is active (both want the one slot).
 *
 * Face filters (camera-face-filters plan §5): the slot has THREE candidates —
 * background wins over face filters (v1 mutual exclusion, filters sit inert
 * with a "paused" badge), and the canvas brightness fallback only runs when
 * neither holds the slot. `pickSlotOccupant` (faceFilterCatalog.ts) is the
 * pure, unit-tested decision. Under a FaceFilterProcessor, brightness for
 * non-HW cameras rides IN the filter's ctx.filter chain (an improvement over
 * the background gap); HW brightness always targets the RAW source.
 *
 * Trust rules (camera-effects-trust, Step 0). A background is a privacy
 * control, so it fails CLOSED and the other occupants fail open:
 *  - `apply` never throws; it returns a `CameraApplyResult` the caller must
 *    read. A background failure leaves the slot as it is (no `stopProcessor`,
 *    which would put the RAW track on the sender and resume it): the caller
 *    mutes the camera first and only then calls `detach`.
 *  - Every background processor is handed to LiveKit inside a
 *    `BackgroundGuard` whose `init`/`restart` never reject and which
 *    emits black frames when the segmenter cannot start. LiveKit falls back to
 *    the raw track whenever a processor has no `processedTrack`, so "no output"
 *    must never be observable there.
 *  - Camera off is a MUTE in LiveKit: the track and its processor survive and
 *    unmute calls `processor.restart`. Nothing here drops a reference on mute
 *    (`onTrackMuted` only stops timers); `reset` is for a STOPPED track.
 *  - Every `setProcessor` / `stopProcessor` call for the camera lives in this
 *    file, and `plan` reports which of them an `apply` would issue.
 */
import { Capacitor } from "@capacitor/core";
import {
  type BackgroundProcessorWrapper,
  BackgroundProcessor,
  supportsBackgroundProcessors,
} from "@livekit/track-processors";
import {
  type Track,
  type TrackProcessor,
  LocalVideoTrack,
} from "livekit-client";

import { CONFIGURATION } from "@revolt/common";
import type {
  CameraBackgroundMode,
  CameraColorLookId,
  CameraFaceFilterId,
} from "@revolt/state/stores/Voice";
import { isIosTouch } from "@revolt/ui/components/floating/longPress";

import type {
  CameraApplyResult,
  CameraOccupant,
  CameraOpGuard,
  CameraPlan,
} from "./cameraAttachPolicy";
import { backgroundExists, resolveBackgroundUrl } from "./cameraBackgrounds";
import {
  type BlackFrameSource,
  CameraProcessorGuard,
} from "./cameraProcessorGuard";
import {
  type ToneStageName,
  ToneWatchdog,
  toneAllowedOnPlatform,
} from "./cameraTonePolicy";
import { toneStageSupported } from "./cameraToneStage";
import {
  type SlotCaps,
  type SlotSettings,
  needsLandmarks,
  pickSlotOccupant,
} from "./faceFilterCatalog";
import {
  type CameraToneStats,
  type FaceFilterConfig,
  type FaceFilterStatusReport,
  type GlamState,
  type GlamStats,
  FaceFilterProcessor,
} from "./faceFilterProcessor";
import {
  type GlamProbeAnswer,
  type GlamProbeVerdict,
  GLAM_PROBE_NO_ANSWER,
  glamProbeCapability,
  glamProbeNeedsRange,
  glamProbeVerdict,
} from "./glamPolicy";

/**
 * Canvas brightness fallback for cameras without a hardware brightness control
 * (and no active background). Draws the source frame through a CSS
 * `brightness()` filter and re-captures at 30fps.
 */
export class BrightnessVideoProcessor {
  name = "brightness-processor";
  processedTrack: MediaStreamTrack | undefined;
  /**
   * The RAW camera track this processor consumes — the controller's HW probe
   * must target this, never `track.mediaStreamTrack` (which returns the
   * processed canvas track while this processor is attached).
   */
  source: MediaStreamTrack | undefined;
  #brightness: number;
  #canvas: HTMLCanvasElement | undefined;
  #ctx2d: CanvasRenderingContext2D | undefined;
  #video: HTMLVideoElement | undefined;
  #rafId: number | undefined;
  #stopped = false;

  constructor(brightness: number) {
    this.#brightness = brightness;
  }

  setBrightness(brightness: number) {
    this.#brightness = brightness;
  }

  async init(opts: { track: MediaStreamTrack }) {
    this.source = opts.track;
    this.#canvas = document.createElement("canvas");
    this.#video = document.createElement("video");
    this.#video.srcObject = new MediaStream([opts.track]);
    this.#video.muted = true;
    await this.#video.play();
    this.#canvas.width = this.#video.videoWidth || 640;
    this.#canvas.height = this.#video.videoHeight || 480;
    this.#ctx2d = this.#canvas.getContext("2d")!;
    this.#stopped = false;
    const draw = () => {
      if (this.#stopped) return;
      if (this.#video && this.#ctx2d && this.#canvas) {
        this.#ctx2d.filter = `brightness(${this.#brightness}%)`;
        this.#ctx2d.drawImage(
          this.#video,
          0,
          0,
          this.#canvas.width,
          this.#canvas.height,
        );
      }
      this.#rafId = requestAnimationFrame(draw);
    };
    this.#rafId = requestAnimationFrame(draw);
    const stream = this.#canvas.captureStream(30);
    this.processedTrack = stream.getVideoTracks()[0];
  }

  /**
   * Live rebind after a device switch. REQUIRED by LiveKit's TrackProcessor
   * interface — LocalTrack.restart() calls it unconditionally BEFORE any
   * `activeDeviceChanged` handler runs, so its absence was a latent
   * device-switch crash (camera-face-filters plan §2).
   */
  async restart(opts: { track: MediaStreamTrack }) {
    if (!this.#video) {
      await this.init(opts);
      return;
    }
    this.source = opts.track;
    this.#video.srcObject = new MediaStream([opts.track]);
    await this.#video.play();
  }

  async destroy() {
    this.#stopped = true;
    if (this.#rafId !== undefined) cancelAnimationFrame(this.#rafId);
    this.#video?.pause();
    this.#video = undefined;
    this.#canvas = undefined;
    this.#ctx2d = undefined;
    // LiveKit's stopProcessor stops processedTrack before calling destroy, but
    // LocalTrack.stop() (leave, unpublish) calls destroy alone. Stop it here
    // too so the canvas capture never outlives the processor.
    this.processedTrack?.stop();
    this.processedTrack = undefined;
    this.source = undefined;
  }
}

/**
 * Base URL for the self-hosted MediaPipe segmentation assets. Uses `||` so a
 * leftover docker placeholder (truthy) still routes correctly; otherwise falls
 * back to the bundled `${BASE_URL}mediapipe`.
 */
const SEGMENTATION_BASE = (
  CONFIGURATION.SEGMENTATION_ASSETS_URL ||
  `${import.meta.env.BASE_URL}mediapipe`
).replace(/\/$/, "");

/** Passed to every BackgroundProcessor so it never hits a CDN at runtime. */
export const SEGMENTATION_ASSET_PATHS = {
  tasksVisionFileSet: `${SEGMENTATION_BASE}/wasm`,
  modelAssetPath: `${SEGMENTATION_BASE}/models/selfie_segmenter.tflite`,
};

let _cameraBgSupported: boolean | undefined;

/**
 * Whether camera background effects can run here. Desktop-first: requires
 * browser support AND a non-native (non-Capacitor) platform. Memoized.
 */
export function cameraBackgroundSupported(): boolean {
  if (_cameraBgSupported === undefined) {
    try {
      _cameraBgSupported =
        supportsBackgroundProcessors() && !Capacitor.isNativePlatform();
    } catch {
      _cameraBgSupported = false;
    }
  }
  return _cameraBgSupported;
}

/**
 * Whether face filters (stickers/beautify/looks) can run here. Same gate as
 * backgrounds — desktop-first, non-Capacitor (plan §6).
 */
export function faceFiltersSupported(): boolean {
  return cameraBackgroundSupported();
}

/**
 * Whether the tone stage (low light, whole-frame touch up) can run here:
 * WebGL2, canvas capture, and neither an iPhone or iPad (the app or any
 * browser there) nor the macOS desktop app, where it is not offered in this
 * landing. Unlike backgrounds and face filters this includes Android.
 *
 * Nothing is memoized here. The platform rule (`toneAllowedOnPlatform`, pure
 * and spec'd) is asked first, so a device it excludes never creates the
 * WebGL2 probe context; `toneStageSupported` keeps its own answer. Never
 * throws: anything unreadable reads as unsupported.
 */
export function cameraToneSupported(): boolean {
  try {
    if (typeof window === "undefined" || typeof navigator === "undefined") {
      return false;
    }
    // The same check the long-press emulation uses: the Capacitor iOS app,
    // Safari on an iPhone, and an iPad that reports itself as a Mac.
    const ios = isIosTouch(
      Capacitor.getPlatform(),
      navigator.userAgent,
      navigator.platform,
      navigator.maxTouchPoints ?? 0,
    );
    // The shallow shell test on purpose (not `tauriInvoke`, which also asks
    // whether the window may call commands): any Tauri window on a Mac counts.
    const macTauri =
      "__TAURI__" in window && navigator.platform.startsWith("Mac");
    const canvasCapture =
      typeof HTMLCanvasElement !== "undefined" &&
      typeof HTMLCanvasElement.prototype.captureStream === "function";
    return (
      toneAllowedOnPlatform({ ios, macTauri, canvasCapture }) &&
      toneStageSupported()
    );
  } catch {
    return false;
  }
}

/**
 * The two files the face tracker cannot start without, at the addresses the
 * face pipeline loads them from.
 */
const GLAM_FILE_URLS = [
  `${SEGMENTATION_BASE}/models/face_landmarker.task`,
  `${SEGMENTATION_BASE}/wasm/vision_wasm_internal.wasm`,
];

/** How long one check may take, both files together, before it gives up. */
const GLAM_PROBE_TIMEOUT_MS = 3000;
/** After a check that got no answer, how long until another may be sent. */
const GLAM_PROBE_RETRY_MS = 30_000;

/** Both files were found. Only ever goes from false to true. */
let _glamFilesReachable = false;
/**
 * The server answered and a file is not there. Final as well: a build that
 * was made without the files does not grow them while it runs.
 */
let _glamFilesMissing = false;
/** The check in flight. */
let _glamProbe: Promise<boolean> | undefined;
/** No new check before this time (`Date.now()`); set when one got no answer. */
let _glamRetryAt = 0;

/**
 * Whether the tracker files have to be looked for before the look is
 * offered. The phone apps are built in more than one way and not every
 * build carries the files; the desktop app and the web always ship them.
 * Unreadable reads as "look for them".
 */
function glamFilesNeedProbe(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return true;
  }
}

/** What a response says, for `glamProbeVerdict` to read. */
function glamProbeAnswer(res: Response, bodyBytes: number): GlamProbeAnswer {
  return {
    threw: false,
    status: res.status,
    contentType: res.headers.get("content-type"),
    contentLength: res.headers.get("content-length"),
    contentRange: res.headers.get("content-range"),
    bodyBytes,
  };
}

/**
 * How many bytes the first piece of a body holds, 0 for a body with nothing
 * in it. One byte was asked for; a server that ignores the range starts
 * sending the whole file, which is megabytes, so the rest is stopped.
 * Rejects when the body cannot be read.
 */
async function glamFirstBodyBytes(res: Response): Promise<number> {
  const reader = res.body?.getReader();
  if (!reader) return 0;
  try {
    for (;;) {
      const piece = await reader.read();
      if (piece.done) return 0;
      if (piece.value.byteLength > 0) return piece.value.byteLength;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

/**
 * Whether one tracker file is there, without downloading it. This only
 * sends the requests and hands what came back to `glamProbeVerdict`, which
 * decides. Never rejects: a request that failed or was stopped through
 * `signal` is one more thing the verdict reads.
 */
async function glamFileReachable(
  url: string,
  signal: AbortSignal,
): Promise<GlamProbeVerdict> {
  let head = GLAM_PROBE_NO_ANSWER;
  try {
    head = glamProbeAnswer(await fetch(url, { method: "HEAD", signal }), 0);
  } catch {
    // No answer to the HEAD; the read below is sent.
  }
  if (!glamProbeNeedsRange(head)) return glamProbeVerdict(head, undefined);
  let range = GLAM_PROBE_NO_ANSWER;
  try {
    const res = await fetch(url, { headers: { Range: "bytes=0-0" }, signal });
    range = glamProbeAnswer(res, await glamFirstBodyBytes(res));
  } catch {
    // No answer to this one either.
  }
  return glamProbeVerdict(head, range);
}

/**
 * One check of both tracker files, bounded in time. Resolves with whether
 * both are there once that is settled: true when both are, false as soon as
 * the answers show one is not. Rejects when it could not be told, which
 * includes `GLAM_PROBE_TIMEOUT_MS` passing with a request still out: the
 * requests are stopped then, and what the others answered still counts.
 */
async function glamFilesPresent(): Promise<boolean> {
  const abort = new AbortController();
  const verdicts = GLAM_FILE_URLS.map((): GlamProbeVerdict => "unknown");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      abort.abort();
      resolve();
    }, GLAM_PROBE_TIMEOUT_MS);
  });
  const all = Promise.all(
    GLAM_FILE_URLS.map(async (url, at) => {
      verdicts[at] = await glamFileReachable(url, abort.signal);
    }),
  );
  try {
    await Promise.race([all, timedOut]);
  } finally {
    clearTimeout(timer);
  }
  // Taken once, here: a request that answers after the time limit is not
  // read any more.
  const verdict = glamProbeCapability([...verdicts]);
  if (verdict === "unknown") throw new Error("tracker file check: no answer");
  return verdict === "present";
}

/**
 * Look for the face tracker's files and say whether the face-tracked look
 * can run here. Never rejects, and never takes longer than one bounded
 * check. Where no check is needed it answers at once.
 *
 * It is awaited on every camera sync, so it sends requests rarely. Calls
 * share the check in flight. An answer is kept for as long as the app runs,
 * whether the files are there or not, and later calls resolve at once with
 * no request. A check that got no answer (a failed request, a timeout)
 * resolves false and may be repeated, but not within `GLAM_PROBE_RETRY_MS`:
 * until then calls resolve false at once.
 */
export function probeCameraGlam(): Promise<boolean> {
  if (!cameraToneSupported()) return Promise.resolve(false);
  if (!glamFilesNeedProbe() || _glamFilesReachable) {
    return Promise.resolve(true);
  }
  if (_glamFilesMissing) return Promise.resolve(false);
  if (_glamProbe) return _glamProbe;
  if (Date.now() < _glamRetryAt) return Promise.resolve(false);
  const probe = glamFilesPresent().then(
    (present) => {
      _glamProbe = undefined;
      if (present) _glamFilesReachable = true;
      else _glamFilesMissing = true;
      return present;
    },
    () => {
      _glamProbe = undefined;
      _glamRetryAt = Date.now() + GLAM_PROBE_RETRY_MS;
      return false;
    },
  );
  _glamProbe = probe;
  return probe;
}

/**
 * Whether the face-tracked look can run here: everything the tone stage
 * needs (`cameraToneSupported()`), and the face tracker's files.
 *
 * Synchronous, so on the phone apps it answers false until a check has found
 * the files. It only reads the answer and never starts a check: the slot
 * rules ask it while planning, and planning must not send a request. Every
 * `CameraEffectsController` starts the check when it is created; a caller
 * that wants to wait for the answer uses `probeCameraGlam()`. Once true for
 * the files it stays true. Never throws.
 */
export function cameraGlamSupported(): boolean {
  if (!cameraToneSupported()) return false;
  if (!glamFilesNeedProbe()) return true;
  return _glamFilesReachable;
}

export type { CameraBackgroundMode };

export type CameraBackgroundStatus =
  | "idle"
  | "initializing"
  | "active"
  | "failed";

export interface CameraEffectSettings {
  backgroundMode: CameraBackgroundMode;
  blurRadius: number;
  backgroundImageId?: string;
  /** 0-200, 100 = neutral. */
  brightness: number;
  /** AR sticker filter (undefined = none). Inert while a background is active. */
  faceFilterId?: CameraFaceFilterId;
  /** Skin smoothing 0–100 (0 = off). */
  beautify: number;
  /** Color look (undefined = none). */
  colorLookId?: CameraColorLookId;
  /**
   * The face-tracked look, 0-100 (0 = off). Rides the face pipeline where
   * `cameraGlamSupported()`; inert elsewhere and while a background holds
   * the slot. While it is drawn it stands in for touch up.
   */
  glam: number;
  /**
   * Low light switch. Rides the face pipeline where `cameraToneSupported()`;
   * inert elsewhere and while a background holds the slot.
   */
  lowLight: boolean;
}

/**
 * A background processor built before the camera track exists, to be passed
 * as the capture options' `processor` so the FIRST published frame is already
 * processed. Hand it back through `CameraEffectsController.adopt` once
 * LiveKit has published the track. Opaque apart from `processor`.
 */
export interface PrebuiltBackground {
  processor: TrackProcessor<Track.Kind.Video>;
}

/** Outcome of `CameraEffectsController.prebuildBackground`. */
export type PrebuildBackgroundResult =
  /** The settings do not ask for a background: publish without one. */
  | { kind: "not-wanted" }
  /** A SELECTED background image no longer resolves. */
  | { kind: "unresolved" }
  /** A background is wanted but could not be prepared. */
  | { kind: "failed"; error: unknown }
  | { kind: "ready"; prebuilt: PrebuiltBackground };

/**
 * Thrown (and caught again inside `apply`) when the caller's `CameraOpGuard`
 * refuses a sender operation. A single instance, compared by identity.
 */
const GATE_REFUSED = new Error("camera sender operation refused by the gate");

/** What a background processor is asked to show. */
type BackgroundTarget =
  | { mode: "background-blur"; blurRadius: number }
  | { mode: "virtual-background"; imagePath: string };

interface ResolvedBackgroundTarget {
  target: BackgroundTarget;
  /** Releases the image URL (uploads); absent for blur. */
  revoke?: () => void;
  /** Animated presets: every frame URL, cycled by the controller. */
  frames?: string[];
  frameIntervalMs: number;
}

function buildBackgroundProcessor(
  target: BackgroundTarget,
): BackgroundProcessorWrapper {
  // Built as a DISCRIMINATED union, matching the `switchTo` calls: a single
  // object with a computed `mode` leaves `imagePath` optional on the
  // virtual-background arm, which the option type refuses.
  return BackgroundProcessor(
    target.mode === "background-blur"
      ? {
          mode: "background-blur",
          blurRadius: target.blurRadius,
          assetPaths: SEGMENTATION_ASSET_PATHS,
        }
      : {
          mode: "virtual-background",
          imagePath: target.imagePath,
          assetPaths: SEGMENTATION_ASSET_PATHS,
        },
  );
}

// Large enough that no encoder rejects the frame size, small enough to cost
// nothing. The frame rate only has to keep the track producing frames.
const BLACK_FRAME_WIDTH = 320;
const BLACK_FRAME_HEIGHT = 180;
const BLACK_FRAME_FPS = 5;

/**
 * A live video track that only ever shows black. A canvas capture emits a
 * frame when the canvas was drawn to since the last one, so the timer repaints
 * to keep frames flowing. Returns undefined where canvas capture is missing.
 */
function createBlackFrameSource(): BlackFrameSource | undefined {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = BLACK_FRAME_WIDTH;
    canvas.height = BLACK_FRAME_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    const paint = () => {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    };
    paint();
    const track = canvas.captureStream(BLACK_FRAME_FPS).getVideoTracks()[0];
    if (!track) return undefined;
    const timer = setInterval(paint, 1000 / BLACK_FRAME_FPS);
    return {
      track,
      stop: () => {
        clearInterval(timer);
        track.stop();
      },
    };
  } catch {
    return undefined;
  }
}

/** The guarded background processor: what LiveKit holds in the slot. */
type BackgroundGuard = CameraProcessorGuard<BackgroundProcessorWrapper>;

/**
 * Wrap a background target in the never-rejecting guard (see
 * cameraProcessorGuard.ts for why LiveKit must never see the bare wrapper).
 * The wrapper itself is built lazily inside the guard, so a build failure
 * (unsupported browser) takes the same black-frame path as an init failure.
 */
function guardedBackground(target: BackgroundTarget): BackgroundGuard {
  return new CameraProcessorGuard<BackgroundProcessorWrapper>({
    build: () => buildBackgroundProcessor(target),
    createBlackSource: createBlackFrameSource,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
}

/** A prebuilt background not yet handed over by `adopt`. */
interface PendingPrebuilt {
  guard: BackgroundGuard;
  revoke: (() => void) | undefined;
  frames: string[] | undefined;
  frameIntervalMs: number;
}

let _prewarm: Promise<void> | undefined;

/**
 * Fetch the segmenter runtime and model once so the HTTP cache already holds
 * them when the processor initializes. Warms the SIMD runtime only, which is
 * what every browser that passes `cameraBackgroundSupported` loads in practice.
 */
function prewarmSegmentationAssets() {
  if (_prewarm) return;
  const urls = [
    `${SEGMENTATION_ASSET_PATHS.tasksVisionFileSet}/vision_wasm_internal.js`,
    `${SEGMENTATION_ASSET_PATHS.tasksVisionFileSet}/vision_wasm_internal.wasm`,
    SEGMENTATION_ASSET_PATHS.modelAssetPath,
  ];
  _prewarm = Promise.all(
    urls.map(async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`prewarm ${res.status}`);
      // Read the body to the end; a response is only cached once complete.
      await res.blob();
    }),
  ).then(
    () => undefined,
    () => {
      // Best effort. Forget the attempt so a later call can try again.
      _prewarm = undefined;
    },
  );
}

/**
 * Stateful controller that owns the single processor slot + brightness for one
 * LocalVideoTrack at a time. Create one per consumer (the room camera; the
 * settings preview). `apply` and `plan` are serialized internally.
 */
export class CameraEffectsController {
  #bg: BackgroundGuard | undefined;
  #face: FaceFilterProcessor | undefined;
  /** The face processor whose setProcessor is in flight (status-forward window). */
  #facePending: FaceFilterProcessor | undefined;
  #brightness: BrightnessVideoProcessor | undefined;
  /** Built by prebuildBackground and not yet adopted. */
  #prebuilt: PendingPrebuilt | undefined;
  #revokeImg: (() => void) | undefined;
  /** Animated virtual background: pre-rendered frame URLs being cycled. */
  #animFrames: string[] | undefined;
  #animIndex = 0;
  #animTimer: ReturnType<typeof setInterval> | undefined;
  #animPending = false;
  #hwSupported = false;
  /**
   * Generation token. Bumped by reset()/detach() so that an `apply` whose
   * `setProcessor` is still initializing (the ~1s MediaPipe init window) can
   * detect it was superseded/torn-down and destroy the just-built processor
   * instead of resurrecting a stale `#bg` (which would leak the WebGL context +
   * WASM segmenter).
   */
  #gen = 0;
  /**
   * The tone watchdog of this call. Created on first use and handed to every
   * face config, so what it has shed outlives a processor rebuild, a camera
   * mute and a republish (`reset()`); only `resetToneWatchdog()` clears it.
   */
  #watchdog: ToneWatchdog | undefined;
  /**
   * The face-tracked look could not run in this call. Like a shed stage it
   * outlives a processor rebuild, a camera mute and a republish, and is
   * cleared only where the watchdog is (`resetToneWatchdog()`).
   */
  #glamFailed = false;
  /**
   * Tone failed open on the face pipeline that holds the slot now. The
   * processor can try tone again by itself, so each tune checks this against
   * what the processor says (`#ensureFace`).
   */
  #toneFailed = false;
  /**
   * What the face config was last built from. Kept so a report from the
   * processor can build it again without anyone re-reading the settings.
   */
  #faceInputs: { settings: CameraEffectSettings; hw: boolean } | undefined;
  /**
   * The op guard of the pass that attached the face pipeline. That pass was
   * allowed a sender operation, so from then on its guard refuses for one
   * reason only: the caller's gate is held. The guard of a later tune is no
   * use for this, because a tune is refused whatever the gate does.
   */
  #faceGuard: CameraOpGuard | undefined;

  constructor() {
    // Look for the face tracker's files now, long before a camera is turned
    // on: `cameraGlamSupported()` answers false on the phone apps until this
    // has found them, and a stored look would sit out the first camera-on.
    // Two small requests to the app's own files there, nothing elsewhere.
    // It neither throws nor rejects, so creating the controller cannot fail.
    void probeCameraGlam();
  }

  /** Notified whenever hardware-brightness support is (re)detected. */
  onHwSupportChange?: (hw: boolean) => void;
  /** Notified when the configured background image id no longer resolves. */
  onImageMissing?: () => void;
  /** Forwarded from the live FaceFilterProcessor (landmark failure + degrade). */
  onFaceFilterStatus?: (s: FaceFilterStatusReport) => void;
  /** The watchdog turned a tone stage off because it was slowing the video. */
  onToneShed: ((stage: ToneStageName) => void) | undefined;
  /** Tone failed open in the face pipeline; the picture continues without it. */
  onToneFailed: (() => void) | undefined;
  /**
   * The face-tracked look cannot run; the picture continues without it.
   * Called once per call, however many processors report it.
   */
  onGlamFailed: (() => void) | undefined;

  // Handed to every face config. They read the property at call time, so a
  // handler assigned (or replaced) later is honored without a new config.
  //
  // The look stands in for touch up while it is drawn, so each report that
  // ends it also has the config sent again: touch up is back in it. That is
  // all a report does here. No setting is written and the wanted occupant
  // is not asked again.
  readonly #forwardToneShed = (stage: ToneStageName) => {
    if (stage === "glam") this.#retuneFaceSoon();
    this.onToneShed?.(stage);
  };
  readonly #forwardToneFailed = () => {
    this.#toneFailed = true;
    this.#retuneFaceSoon();
    this.onToneFailed?.();
  };
  readonly #forwardGlamFailed = () => {
    const first = !this.#glamFailed;
    this.#glamFailed = true;
    this.#retuneFaceSoon();
    if (first) this.onGlamFailed?.();
  };
  /**
   * Handed to every face config: whether the face tracker has to stay out of
   * the way right now. No guard (the settings preview) means never.
   */
  readonly #faceGateHeld = (): boolean => {
    const guard = this.#faceGuard;
    return !!guard && !guard.maySenderOp();
  };

  get hwBrightnessSupported(): boolean {
    return this.#hwSupported;
  }

  /** A background holds the slot AND its segmenter is running. */
  get backgroundActive(): boolean {
    return !!this.#bg && !this.#bg.failed;
  }

  get faceFilterActive(): boolean {
    return !!this.#face;
  }

  /**
   * What holds the LiveKit processor slot. A background whose segmenter failed
   * still counts: it is attached (showing black) until `detach` removes it.
   */
  get occupant(): CameraOccupant {
    if (this.#bg) return "background";
    if (this.#face) return "face";
    if (this.#brightness) return "brightness-fallback";
    return "none";
  }

  #chain: Promise<unknown> = Promise.resolve();

  /**
   * Whether the slot's occupant is attached to `track` and producing frames:
   * `track.getProcessor()` is the occupant's processor and its `processedTrack`
   * is live. A background whose segmenter failed is never active, even though
   * its black track is live.
   *
   * On a MUTED track liveness is not required. Camera off stops the capture,
   * which ends a stream-based processor's output track, and nothing is sent
   * while muted anyway. What matters there is that the processor is still
   * attached, because unmute restarts the track THROUGH it.
   */
  isActive(track: LocalVideoTrack): boolean {
    const proc = this.#slotProcessor(track);
    if (!proc) return false;
    if ((track.getProcessor() as unknown) !== proc) return false;
    if (proc instanceof CameraProcessorGuard && proc.failed) return false;
    if (track.isMuted) return true;
    return proc.processedTrack?.readyState === "live";
  }

  /**
   * Describe what an `apply` of these settings would do, without doing it:
   * no processor is attached, removed or tuned, and no image URL is created.
   * Queued behind any `apply` in flight so `current` is not read mid-change.
   * Never rejects; when the image lookup itself fails the image is reported
   * unresolved (the fail-closed reading).
   */
  plan(
    track: LocalVideoTrack,
    settings: CameraEffectSettings,
  ): Promise<CameraPlan> {
    const result = this.#chain
      .catch(() => {})
      .then(() => this.#planInner(track, settings));
    this.#chain = result.catch(() => {});
    return result;
  }

  async #planInner(
    track: LocalVideoTrack,
    settings: CameraEffectSettings,
  ): Promise<CameraPlan> {
    let wanted: CameraOccupant = "none";
    let backgroundUnresolved = false;
    try {
      wanted = this.#wantedOccupant(
        settings,
        this.#hasHwBrightness(this.#rawSource(track)),
      );
      if (wanted === "background" && settings.backgroundMode === "image") {
        const id = settings.backgroundImageId;
        backgroundUnresolved = !id || !(await backgroundExists(id));
      }
    } catch {
      // Fail closed: an unreadable image store must not plan as "show raw".
      if (this.wantsBackground(settings)) {
        wanted = "background";
        backgroundUnresolved = true;
      }
    }
    // Read the slot AFTER the await so the snapshot is as fresh as it can be.
    const proc = this.#slotProcessor(track);
    const prebuiltAttached = !!proc && proc === this.#prebuilt?.guard;
    return {
      current: prebuiltAttached ? "background" : this.occupant,
      wanted,
      backgroundUnresolved,
      active: this.isActive(track),
    };
  }

  /**
   * The occupant the settings ask for, with the capabilities `apply` uses.
   * Image mode with NO image chosen yet is not a background request: the
   * picker stays visible and the camera behaves as if the mode were "none".
   * (A chosen image that no longer resolves IS one, and fails closed.)
   */
  #wantedOccupant(settings: CameraEffectSettings, hw: boolean): CameraOccupant {
    const { slot, caps } = this.#slotInputs(settings, hw);
    return pickSlotOccupant(slot, caps);
  }

  /**
   * The settings and capabilities the slot rules are asked with. One reading
   * for the wanted occupant (`plan` and `apply`) and for the face config's
   * landmark decision, so the two cannot disagree.
   */
  #slotInputs(
    settings: CameraEffectSettings,
    hw: boolean,
  ): { slot: SlotSettings; caps: SlotCaps } {
    return {
      slot: {
        backgroundMode: this.wantsBackground(settings)
          ? settings.backgroundMode
          : "none",
        faceFilterId: settings.faceFilterId,
        beautify: settings.beautify,
        colorLookId: settings.colorLookId,
        brightness: settings.brightness,
        // The stored switch and nothing else. A look that was shed or
        // failed still asks for the slot: leaving it out here would turn
        // "the look stopped" into removing or swapping the processor.
        glam: settings.glam > 0,
        lowLight: settings.lowLight,
      },
      caps: {
        backgroundSupported: cameraBackgroundSupported(),
        faceFiltersSupported: faceFiltersSupported(),
        hwBrightness: hw,
        toneSupported: cameraToneSupported(),
        glamSupported: cameraGlamSupported(),
      },
    };
  }

  /**
   * Whether the settings ask for a background this platform can run:
   * supported here, mode not "none", and not image mode with no image chosen.
   * The ONE definition: `plan`, `apply` and `prebuildBackground` all decide
   * "background wanted" through it. Synchronous, no side effects.
   */
  wantsBackground(settings: CameraEffectSettings): boolean {
    const noImageChosen =
      settings.backgroundMode === "image" && !settings.backgroundImageId;
    return (
      settings.backgroundMode !== "none" &&
      !noImageChosen &&
      cameraBackgroundSupported()
    );
  }

  /**
   * Throws GATE_REFUSED unless the caller's guard allows a sender operation
   * right now. Called synchronously before every setProcessor/stopProcessor
   * an `apply` issues, and before any reference is changed for that
   * operation, so a refusal leaves the controller describing the slot as it
   * still is. No guard (settings preview, detach) means no restriction.
   */
  #assertMayOp(opGuard: CameraOpGuard | undefined) {
    if (opGuard && !opGuard.maySenderOp()) throw GATE_REFUSED;
  }

  /**
   * The processor this controller has in the slot. Includes a prebuilt
   * background LiveKit has already attached to `track` but `adopt` has not
   * been called for yet, so a plan made in that window reads "background"
   * instead of planning a second attach over it.
   */
  #slotProcessor(
    track: LocalVideoTrack,
  ):
    | BackgroundGuard
    | FaceFilterProcessor
    | BrightnessVideoProcessor
    | undefined {
    const held = this.#bg ?? this.#face ?? this.#brightness;
    if (held) return held;
    const pre = this.#prebuilt?.guard;
    return pre && (track.getProcessor() as unknown) === pre ? pre : undefined;
  }

  /**
   * Apply the given settings to a live camera track. Idempotent; safe on enable
   * and on any live change. Calls are SERIALIZED internally so a rapid slider
   * drag can't race `switchTo`/`setProcessor` on the segmenter.
   *
   * NEVER throws: the outcome is the returned `CameraApplyResult`, and a caller
   * that ignores it will show a failed effect as working. Brightness is still
   * applied after an occupant failure.
   *
   * `failed: "background"` (segmenter init failed, a selected image does not
   * resolve, or the background is not active after the attach) means the
   * camera picture is NOT protected. Nothing was detached: mute the camera
   * first, then remove it. `failed: "face" | "brightness"` means that effect
   * dropped and the raw camera continues.
   *
   * `opGuard` (the in-call driver passes one; the settings preview does not)
   * is asked synchronously before EVERY setProcessor/stopProcessor. When it
   * refuses, that operation is not issued, nothing else on the sender is
   * touched, and the result is `failed: "gate"`: the caller re-syncs when the
   * gate opens. Hardware brightness, which is not a sender operation, is
   * still applied.
   */
  apply(
    track: LocalVideoTrack,
    settings: CameraEffectSettings,
    opGuard?: CameraOpGuard,
  ): Promise<CameraApplyResult> {
    const result = this.#chain
      .catch(() => {})
      .then(() => this.#applyInner(track, settings, opGuard));
    this.#chain = result.catch(() => {});
    return result;
  }

  async #applyInner(
    track: LocalVideoTrack,
    settings: CameraEffectSettings,
    opGuard: CameraOpGuard | undefined,
  ): Promise<CameraApplyResult> {
    const myGen = this.#gen;
    // Until the wanted occupant is known, attribute an unexpected throw to the
    // background whenever one is configured (the fail-closed reading).
    let stage: "background" | "face" | "brightness" = this.wantsBackground(
      settings,
    )
      ? "background"
      : "brightness";
    let failure:
      | { failed: "background" | "face" | "brightness"; error: unknown }
      | undefined;
    // A sender operation was refused by opGuard and therefore not issued.
    let gated = false;

    try {
      this.#adoptAttachedPrebuilt(track);

      // Probe HW brightness on the RAW source BEFORE building any occupant
      // (plan §5, re-verify NEW-2): the verdict decides the brightness value
      // baked into a face-filter config, and stays single-sourced for the
      // whole apply pass.
      const hw = this.#hasHwBrightness(this.#rawSource(track));

      const occupant = this.#wantedOccupant(settings, hw);
      stage =
        occupant === "background"
          ? "background"
          : occupant === "face"
            ? "face"
            : "brightness";

      if (occupant === "background") {
        try {
          await this.#ensureBackground(track, myGen, settings, opGuard);
        } catch (error) {
          // Fail closed: report it and leave the slot alone. Removing the
          // processor here would put the RAW track on the sender and resume
          // it; the caller mutes the camera first and then removes it.
          if (error === GATE_REFUSED) gated = true;
          else failure = { failed: "background", error };
        }
      } else if (occupant === "face") {
        try {
          await this.#teardownBackground(track, opGuard);
          // A reset()/detach() during the teardown await must not build onto a
          // torn-down track (diff-review finding 5).
          if (myGen !== this.#gen) return this.#snapshot(track);
          await this.#ensureFace(track, myGen, settings, hw, opGuard);
        } catch (error) {
          if (error === GATE_REFUSED) {
            gated = true;
          } else {
            // Fail open: never leave a poisoned filter, never skip brightness.
            failure = { failed: "face", error };
            try {
              await this.#teardownFace(track, opGuard);
            } catch (e) {
              // Refused: the filter stays attached and referenced.
              if (e === GATE_REFUSED) gated = true;
            }
          }
        }
      } else {
        try {
          await this.#teardownBackground(track, opGuard);
          await this.#teardownFace(track, opGuard);
        } catch (error) {
          if (error !== GATE_REFUSED) throw error;
          gated = true;
        }
      }

      // Superseded by a reset()/detach() mid-apply → don't touch the (torn-down)
      // track's brightness.
      if (myGen !== this.#gen) return this.#snapshot(track);

      try {
        // After a background failure or a refused operation only the hardware
        // control is touched: the canvas fallback is a processor, and
        // attaching or removing one would be a sender operation.
        await this.#applyBrightness(
          track,
          settings.brightness,
          hw,
          myGen,
          !gated && failure?.failed !== "background",
          opGuard,
        );
      } catch (error) {
        // The occupant failure, if any, is the one worth reporting.
        if (error === GATE_REFUSED) gated = true;
        else failure ??= { failed: "brightness", error };
      }

      if (myGen !== this.#gen) return this.#snapshot(track);

      if (
        !failure &&
        !gated &&
        occupant === "background" &&
        !this.isActive(track)
      ) {
        failure = {
          failed: "background",
          error: new Error("background is not active after attach"),
        };
      }
    } catch (error) {
      if (error === GATE_REFUSED) gated = true;
      else failure ??= { failed: stage, error };
    }

    // A background failure outranks a refusal (the picture is not protected);
    // a refusal outranks a face/brightness failure (the re-sync retries it).
    if (failure?.failed === "background") return { ok: false, ...failure };
    if (gated) return { ok: false, failed: "gate", error: undefined };
    return failure ? { ok: false, ...failure } : this.#snapshot(track);
  }

  #snapshot(track: LocalVideoTrack): CameraApplyResult {
    return { ok: true, occupant: this.occupant, active: this.isActive(track) };
  }

  /** The raw camera track, whichever occupant (if any) holds the slot —
   *  including the brightness fallback (diff-review finding 2: probing
   *  `track.mediaStreamTrack` with the fallback attached reads its processed
   *  canvas track and locks in a wrong hw verdict across device switches). */
  #rawSource(track: LocalVideoTrack): MediaStreamTrack | undefined {
    return (
      this.#bg?.source ??
      this.#face?.source ??
      this.#brightness?.source ??
      track.mediaStreamTrack
    );
  }

  /**
   * Create or live-update the face-filter processor. `hw` decides whether the
   * config carries the user brightness (non-HW source: applied in the filter's
   * ctx.filter chain) or neutral 100 (HW: exactly one mechanism, plan §5).
   *
   * Low light and touch up ride this occupant too. On an attached processor
   * every settings change, those two included, is a `setConfig` and nothing
   * else: no sender operation. Where face filters are not supported the
   * sticker and the color look are withheld (the pipeline is there for tone
   * only) and `landmarks` is false, so MediaPipe is never requested and touch
   * up is the processor's whole-frame smooth.
   *
   * The face-tracked look rides it as well, and is a `setConfig` like the
   * rest once the processor is attached. The processor loads the face
   * tracker for it by itself, and only while `gateHeld` answers false.
   */
  async #ensureFace(
    track: LocalVideoTrack,
    myGen: number,
    settings: CameraEffectSettings,
    hw: boolean,
    opGuard?: CameraOpGuard,
  ) {
    if (!this.#face) {
      // Nothing to tune, so this pass attaches a new processor. It is asked
      // about the gate through this pass's guard, and it starts with a tone
      // stage that has not failed.
      this.#faceGuard = opGuard;
      this.#toneFailed = false;
    }
    this.#faceInputs = { settings, hw };
    const cfg = this.#faceConfig(settings, hw);

    if (this.#face) {
      this.#face.setConfig(cfg);
      // The processor gives a failed tone stage a fresh attempt when a tone
      // setting is switched on, and whenever it is built again. If the look
      // is running again, the failure noted here is out of date: forget it
      // and send the config once more, without the touch up that was put
      // back while the look was gone.
      const look = this.#face.glamState;
      if (this.#toneFailed && (look === "on" || look === "waiting")) {
        this.#toneFailed = false;
        this.#face.setConfig(this.#faceConfig(settings, hw));
      }
      return;
    }

    this.#assertMayOp(opGuard);
    const proc = new FaceFilterProcessor(cfg);
    this.#facePending = proc;
    proc.onStatus = (s) => {
      // Forward only from the CURRENT occupant, or from this proc while its
      // setProcessor is still in flight. A destroyed processor additionally
      // self-mutes (its #reportStatus no-ops on #disposed) — the pair closes
      // diff-review finding 1 (late init failure flipping the UI to "failed"
      // after teardown).
      if (this.#face === proc || this.#facePending === proc) {
        this.onFaceFilterStatus?.(s);
      }
    };
    try {
      await track.setProcessor(proc);
    } catch (e) {
      this.#facePending = undefined;
      proc.onStatus = undefined;
      await proc.destroy().catch(() => {});
      throw e;
    }
    this.#facePending = undefined;
    if (myGen !== this.#gen) {
      // Superseded during init (reset/detach ran) — destroy, don't resurrect.
      proc.onStatus = undefined;
      await proc.destroy().catch(() => {});
      return;
    }
    // setProcessor replaced (and destroyed) a brightness fallback that held
    // the slot. Its reference is dropped only now: had the filter failed to
    // start, the fallback would still be attached and must stay reachable.
    this.#brightness = undefined;
    this.#face = proc;
    // A report that came while the processor was starting found no occupant
    // to tune. If it changed what the config should say, send it now.
    if (this.#faceConfig(settings, hw).beautify !== cfg.beautify) {
      this.#retuneFaceSoon();
    }
  }

  /**
   * The config of the face pipeline for these settings: the one place it is
   * built, for the attach, for every tune and for the config sent again after
   * the processor reports that the face-tracked look has ended.
   *
   * `landmarks` is asked without the look: it only says whether stickers and
   * the masked touch up use the face tracker. The look asks the processor
   * for the tracker on its own terms.
   *
   * Once the look has been given up in this call (shed for being too slow,
   * or failed), touch up no longer asks for the tracker either. It comes
   * back as the whole-frame smooth: the masked one would load the tracker
   * again and run it on every frame, which is at least the work the look was
   * just stopped for. A sticker still asks for it, because the user chose
   * the sticker itself, and touch up is then masked as before since the
   * tracker is running anyway. Only the config changes here; what the
   * settings ask the slot for (`#slotInputs`) does not.
   */
  #faceConfig(settings: CameraEffectSettings, hw: boolean): FaceFilterConfig {
    const { slot: stored, caps } = this.#slotInputs(settings, hw);
    const watchdog = (this.#watchdog ??= new ToneWatchdog());
    const glamOver = this.#glamFailed || watchdog.shed.has("glam");
    const slot = glamOver ? { ...stored, beautify: 0 } : stored;
    const cfg: FaceFilterConfig = {
      filterId: caps.faceFiltersSupported ? settings.faceFilterId : undefined,
      beautify: settings.beautify,
      lookId: caps.faceFiltersSupported ? settings.colorLookId : undefined,
      brightness: hw ? 100 : settings.brightness,
      // Once the look has failed in this call a processor built later is not
      // asked for it again: it would run on top of the touch up that came
      // back when it failed
      glam: caps.glamSupported && !this.#glamFailed ? settings.glam : 0,
      lowLight: settings.lowLight,
      landmarks: needsLandmarks({ ...slot, glam: false }, caps),
      tone: caps.toneSupported,
      watchdog,
      onToneShed: this.#forwardToneShed,
      onToneFailed: this.#forwardToneFailed,
      gateHeld: this.#faceGateHeld,
      onGlamFailed: this.#forwardGlamFailed,
    };
    // The look includes its own skin smoothing, so touch up is not drawn
    // under it.
    if (this.#glamDrawn(cfg)) cfg.beautify = 0;
    return cfg;
  }

  /**
   * Whether the processor will draw the face-tracked look for this config:
   * it is asked for (`glam` is 0 where the look cannot run), it was not shed
   * and it has not failed in this call.
   *
   * A tone stage that failed open ends the look as well, but that only
   * counts where touch up can be drawn without the stage (the masked touch
   * up, `landmarks`). The whole-frame touch up is the stage's own work:
   * putting it back in the config would not bring it back, it would ask the
   * failed stage to start again.
   */
  #glamDrawn(cfg: FaceFilterConfig): boolean {
    if (!(cfg.glam > 0) || this.#glamFailed) return false;
    if (cfg.watchdog?.shed.has("glam")) return false;
    return !(this.#toneFailed && cfg.landmarks);
  }

  /**
   * Send the face config again, built from the settings it was last built
   * from. A tune and nothing more: `setConfig` on the attached processor,
   * which cannot reach the sender.
   *
   * Not done from inside the processor's report (it may be in the middle of
   * a `setConfig` of its own) but right after it, in the same task. Skipped
   * while the gate is held, because touch up coming back can load the face
   * tracker; the caller's sync when the gate opens sends the config anyway.
   */
  #retuneFaceSoon() {
    queueMicrotask(() => {
      const face = this.#face;
      const last = this.#faceInputs;
      if (!face || !last || this.#faceGateHeld()) return;
      face.setConfig(this.#faceConfig(last.settings, last.hw));
    });
  }

  /**
   * Where the face-tracked look stands on the attached face pipeline, and
   * its tracking numbers, for the diagnostic line. Undefined when no
   * face-pipeline occupant is attached.
   */
  get glamInfo(): { state: GlamState; stats: GlamStats } | undefined {
    const face = this.#face;
    if (!face) return undefined;
    // After a failure the pipeline is no longer asked for the look, so it
    // would answer "off"; the failure is remembered here for the call
    return {
      state: this.#glamFailed ? "failed" : face.glamState,
      stats: face.glamStats,
    };
  }

  /** Remove the face-filter processor (if any). */
  async #teardownFace(track: LocalVideoTrack, opGuard?: CameraOpGuard) {
    if (this.#face) {
      this.#assertMayOp(opGuard);
      this.#face.onStatus = undefined; // belt-and-braces: no reports past here
      try {
        await track.stopProcessor();
      } catch {
        /* ignore */
      }
      this.#face = undefined;
    }
  }

  /**
   * What the tone stage of the attached face pipeline is doing, for the stats
   * overlay. Undefined when no face-pipeline occupant is attached (nothing,
   * a background, or the brightness fallback holds the slot).
   */
  toneStats(): CameraToneStats | undefined {
    return this.#face?.toneStats();
  }

  /** Stop cycling animated-background frames (if running). */
  #stopBgAnimation() {
    if (this.#animTimer !== undefined) clearInterval(this.#animTimer);
    this.#animTimer = undefined;
    this.#animFrames = undefined;
    this.#animPending = false;
  }

  /**
   * Cycle pre-rendered frames through the background wrapper (animated presets,
   * e.g. twinkling stars). Each tick is queued on #chain, so a frame swap can
   * NEVER interleave with an apply()'s switchTo — any new apply stops the timer
   * first (#ensureBackground / #teardownBackground / reset), and a tick that
   * was already queued re-checks the wrapper + generation + frame set before
   * touching anything.
   */
  #startBgAnimation(frames: string[], intervalMs: number) {
    this.#stopBgAnimation();
    this.#animFrames = frames;
    this.#animIndex = 0;
    const myGen = this.#gen;
    this.#animTimer = setInterval(() => {
      if (this.#animPending) return; // previous tick still queued/in flight
      this.#animPending = true;
      this.#chain = this.#chain
        .catch(() => {})
        .then(async () => {
          this.#animPending = false;
          const bg = this.#bg;
          if (!bg || myGen !== this.#gen || this.#animFrames !== frames) return;
          const inner = bg.inner;
          if (!inner || bg.failed) {
            this.#stopBgAnimation(); // nothing to tune under the black track
            return;
          }
          this.#animIndex = (this.#animIndex + 1) % frames.length;
          try {
            await inner.switchTo({
              mode: "virtual-background",
              imagePath: frames[this.#animIndex],
            });
          } catch {
            this.#stopBgAnimation(); // wrapper died mid-swap — stop quietly
          }
        });
    }, intervalMs);
  }

  /**
   * Resolve the settings to what the background processor should show. Returns
   * null when a selected image no longer resolves. On success the caller owns
   * `revoke`.
   */
  async #resolveBackgroundTarget(
    settings: CameraEffectSettings,
  ): Promise<ResolvedBackgroundTarget | null> {
    if (settings.backgroundMode !== "image") {
      return {
        target: { mode: "background-blur", blurRadius: settings.blurRadius },
        frameIntervalMs: 200,
      };
    }
    const id = settings.backgroundImageId;
    const resolved = id ? await resolveBackgroundUrl(id) : null;
    if (!resolved) return null;
    return {
      target: { mode: "virtual-background", imagePath: resolved.url },
      revoke: resolved.revoke,
      frames:
        resolved.frames && resolved.frames.length > 1
          ? resolved.frames
          : undefined,
      frameIntervalMs: resolved.frameIntervalMs ?? 200,
    };
  }

  /**
   * Create or (within a live session) switch the single background processor.
   * Throws on every background failure and NEVER removes a processor: what was
   * in the slot before a failure is still there afterwards (see apply()).
   */
  async #ensureBackground(
    track: LocalVideoTrack,
    myGen: number,
    settings: CameraEffectSettings,
    opGuard?: CameraOpGuard,
  ) {
    // Any settings change re-establishes (or drops) the animation below.
    this.#stopBgAnimation();

    // A background whose segmenter failed has nothing to tune. Keep reporting
    // the failure until it is removed, so a dead wrapper cannot poison a later
    // switchTo.
    if (this.#bg?.failed) throw this.#failureOf(this.#bg);

    // Resolve BEFORE touching the slot: an image that no longer resolves must
    // not cost the current occupant (the plan promises zero sender operations
    // for it), and the URL in use stays valid until its replacement is live.
    const resolved = await this.#resolveBackgroundTarget(settings);
    if (myGen !== this.#gen) {
      // A reset()/detach() during the lookup must not build onto a torn-down
      // track (diff-review finding 5).
      resolved?.revoke?.();
      return;
    }
    if (!resolved) {
      this.onImageMissing?.();
      throw new Error("selected background image does not resolve");
    }

    let bg = this.#bg;
    if (bg) {
      const inner = bg.inner;
      try {
        if (!inner) throw new Error("background processor was never built");
        await inner.switchTo(resolved.target);
      } catch (e) {
        resolved.revoke?.();
        throw e;
      }
      if (myGen !== this.#gen) {
        resolved.revoke?.();
        return;
      }
    } else {
      // Assign #bg ONLY after setProcessor resolves — a failed init must not
      // leave a dead wrapper that poisons later switchTo / brightness reads.
      //
      // A face filter or brightness fallback already in the slot is NOT
      // stopped first. LiveKit's setProcessor initializes the new processor
      // and only then removes the old one, so the raw track is on the sender
      // for one replaceTrack round trip instead of the whole segmenter init.
      const guard = guardedBackground(resolved.target);
      try {
        this.#assertMayOp(opGuard);
        await track.setProcessor(guard);
      } catch (e) {
        // The guard's init never rejects, so this is the gate refusing the
        // attach or LiveKit refusing the track; nothing was attached.
        await guard.destroy().catch(() => {});
        resolved.revoke?.();
        throw e;
      }
      if (myGen !== this.#gen) {
        // Superseded during init (reset/detach ran). Init has now completed, so
        // destroy() actually frees the WebGL/WASM resources; do NOT resurrect
        // #bg. Also drop the image URL this run resolved.
        await guard.destroy().catch(() => {});
        resolved.revoke?.();
        return;
      }
      // setProcessor replaced (and destroyed) whatever held the slot.
      if (this.#face) this.#face.onStatus = undefined;
      this.#face = undefined;
      this.#brightness = undefined;
      this.#bg = bg = guard;
    }

    // The new target is in place: release the previous image URL (also when
    // the new mode is blur) and take ownership of this one.
    this.#revokeImg?.();
    this.#revokeImg = resolved.revoke;

    // Attached, but the segmenter is not running and the sender has the black
    // track. It stays attached (and referenced, so detach() can remove it).
    if (bg.failed) throw this.#failureOf(bg);

    if (resolved.frames) {
      this.#startBgAnimation(resolved.frames, resolved.frameIntervalMs);
    }
  }

  #failureOf(guard: BackgroundGuard): unknown {
    return guard.error ?? new Error("background processor failed to start");
  }

  /** Remove the background processor (if any) and release its image URL. */
  async #teardownBackground(track: LocalVideoTrack, opGuard?: CameraOpGuard) {
    if (this.#bg) this.#assertMayOp(opGuard);
    this.#stopBgAnimation();
    if (this.#bg) {
      try {
        await track.stopProcessor();
      } catch {
        /* ignore */
      }
      this.#bg = undefined;
    }
    this.#revokeImg?.();
    this.#revokeImg = undefined;
  }

  /**
   * Build the background processor for these settings BEFORE the camera track
   * exists, so it can go into the capture options and the first published
   * frame is already processed. Never rejects:
   *  - `not-wanted`: the settings do not ask for a background.
   *  - `unresolved`: a SELECTED image no longer resolves.
   *  - `failed`: a background is wanted but could not be prepared.
   *  - `ready`: pass `prebuilt.processor` to the capture, then `adopt`.
   * On `unresolved` and `failed` the camera must not be published as-is: the
   * picture would be unprotected.
   *
   * The returned processor never rejects from `init`; if the segmenter cannot
   * start it publishes black frames and `adopt` reports the failure. One
   * prebuilt background is kept at a time: a new call, `reset()`,
   * `discardPrebuilt()` and `adopt` all release it, so an abandoned publish
   * does not leak the image URL.
   */
  async prebuildBackground(
    settings: CameraEffectSettings,
  ): Promise<PrebuildBackgroundResult> {
    const myGen = this.#gen;
    this.discardPrebuilt();
    try {
      if (!this.wantsBackground(settings)) return { kind: "not-wanted" };
      const resolved = await this.#resolveBackgroundTarget(settings);
      if (!resolved) return { kind: "unresolved" };
      if (myGen !== this.#gen) {
        resolved.revoke?.();
        return {
          kind: "failed",
          error: new Error("camera effects were reset during the prebuild"),
        };
      }
      this.discardPrebuilt(); // a concurrent call got here first
      const guard = guardedBackground(resolved.target);
      this.#prebuilt = {
        guard,
        revoke: resolved.revoke,
        frames: resolved.frames,
        frameIntervalMs: resolved.frameIntervalMs,
      };
      return { kind: "ready", prebuilt: { processor: guard } };
    } catch (error) {
      return { kind: "failed", error };
    }
  }

  /**
   * Take ownership of a prebuilt background after LiveKit published `track`
   * with it. Issues no sender operation. Returns a background failure when the
   * segmenter did not start (the track is publishing black), when LiveKit did
   * not attach the processor, or when it is not active; as with `apply`, the
   * caller then mutes the camera and calls `detach`.
   */
  adopt(
    track: LocalVideoTrack,
    prebuilt: PrebuiltBackground,
  ): CameraApplyResult {
    const fail = (error: unknown): CameraApplyResult => ({
      ok: false,
      failed: "background",
      error,
    });
    const guard = prebuilt.processor;
    // An apply() that ran between publish and this call has already taken it.
    if (this.#bg !== guard) {
      if (this.#prebuilt?.guard !== guard) {
        return fail(new Error("prebuilt background was superseded"));
      }
      if (!this.#adoptAttachedPrebuilt(track)) {
        // LiveKit never attached it, so nobody else will free it.
        this.discardPrebuilt();
        return fail(new Error("prebuilt background is not on the track"));
      }
    }
    const bg = this.#bg;
    if (!bg) return fail(new Error("prebuilt background was torn down"));
    if (bg.failed) return fail(this.#failureOf(bg));
    if (!this.isActive(track)) {
      return fail(new Error("background is not active after publish"));
    }
    return { ok: true, occupant: "background", active: true };
  }

  /**
   * If LiveKit has attached the pending prebuilt background to `track`, make
   * it the slot's occupant. Bookkeeping only: nothing on the track changes.
   */
  #adoptAttachedPrebuilt(track: LocalVideoTrack): boolean {
    const pre = this.#prebuilt;
    if (!pre || (track.getProcessor() as unknown) !== pre.guard) return false;
    this.#prebuilt = undefined;
    this.#stopBgAnimation();
    this.#revokeImg?.();
    // The track is new, so references to processors of an older track are stale.
    if (this.#face) this.#face.onStatus = undefined;
    this.#face = undefined;
    this.#brightness = undefined;
    this.#bg = pre.guard;
    this.#revokeImg = pre.revoke;
    if (pre.frames && !pre.guard.failed) {
      this.#startBgAnimation(pre.frames, pre.frameIntervalMs);
    }
    return true;
  }

  /**
   * Free a prebuilt background that was never adopted (the publish it was
   * built for failed or was abandoned). No-op when there is none; a prebuilt
   * that `adopt` has taken is not affected.
   */
  discardPrebuilt(): void {
    const pre = this.#prebuilt;
    if (!pre) return;
    this.#prebuilt = undefined;
    pre.revoke?.();
    void pre.guard.destroy().catch(() => {});
  }

  /**
   * Start downloading the segmenter runtime and model into the HTTP cache so
   * a background's init does not spend its first second on the network. Best
   * effort; never throws. Call it before anything that holds up the publish.
   */
  prewarmBackgroundAssets(): void {
    try {
      if (!cameraBackgroundSupported()) return;
      prewarmSegmentationAssets();
    } catch {
      /* best effort */
    }
  }

  /**
   * The camera was turned off, which in LiveKit is a MUTE: the track and its
   * processor survive and unmute restarts the track through the processor.
   * So every reference is kept; only timers stop. The next `apply` restarts
   * them. For a track that was actually stopped, use {@link reset}.
   */
  onTrackMuted(): void {
    this.#stopBgAnimation();
  }

  #hasHwBrightness(track: MediaStreamTrack | undefined): boolean {
    const caps = track?.getCapabilities?.() as unknown as
      | { brightness?: unknown }
      | undefined;
    return !!caps && "brightness" in caps;
  }

  async #applyHardwareBrightness(
    track: MediaStreamTrack | undefined,
    brightness: number,
  ) {
    if (!track) return;
    const caps = track.getCapabilities?.() as unknown as
      | { brightness?: { min: number; max: number } }
      | undefined;
    const range = caps?.brightness;
    if (!range) return;
    const { min, max } = range;
    const mid = (min + max) / 2;
    const value = Math.round(
      brightness <= 100
        ? min + ((mid - min) * brightness) / 100
        : mid + ((max - mid) * (brightness - 100)) / 100,
    );
    await track.applyConstraints({
      advanced: [{ brightness: value }],
    } as unknown as MediaTrackConstraints);
  }

  #noteHwSupport(hw: boolean) {
    if (hw === this.#hwSupported) return;
    this.#hwSupported = hw;
    this.onHwSupportChange?.(hw);
  }

  /**
   * Apply ONLY the hardware brightness control: constraints on the RAW camera
   * source plus the `onHwSupportChange` report. Zero sender operations, so it
   * is safe under a held gate and is what the in-call driver uses when it
   * decides not to (or may not) run `apply`; without it the brightness slider
   * would do nothing on a hardware-brightness camera with no effect attached.
   * A camera without the control is left alone (its brightness needs the
   * canvas fallback, which only `apply` attaches). Serialized with `apply`.
   * Never throws.
   */
  applySourceBrightness(
    track: LocalVideoTrack,
    settings: CameraEffectSettings,
  ): Promise<void> {
    const result = this.#chain
      .catch(() => {})
      .then(async () => {
        try {
          const source = this.#rawSource(track);
          const hw = this.#hasHwBrightness(source);
          this.#noteHwSupport(hw);
          if (hw) {
            await this.#applyHardwareBrightness(source, settings.brightness);
          }
        } catch {
          /* best effort */
        }
      });
    this.#chain = result;
    return result;
  }

  /**
   * `slotOps` false restricts this to the hardware control: no processor is
   * attached or removed (used after a background failure, see #applyInner).
   */
  async #applyBrightness(
    track: LocalVideoTrack,
    brightness: number,
    hw: boolean,
    myGen: number,
    slotOps: boolean,
    opGuard?: CameraOpGuard,
  ) {
    // HW detection/constraints ALWAYS target the raw camera track — with ANY
    // processor attached, `track.mediaStreamTrack` returns the PROCESSED track
    // (plan §5): probing it would mis-report hw support and constraining it
    // would be a no-op.
    const source = this.#rawSource(track);
    this.#noteHwSupport(hw);

    if (hw) {
      if (this.#brightness && slotOps) {
        // The canvas fallback never coexists with #bg/#face, so if it exists
        // it holds the slot — safe to stop.
        this.#assertMayOp(opGuard);
        try {
          await track.stopProcessor();
        } catch {
          /* ignore */
        }
        this.#brightness = undefined;
      }
      // stopProcessor / occupant teardown resets the track's original
      // constraints (dropping prior brightness), so always re-apply here.
      await this.#applyHardwareBrightness(source, brightness);
      return;
    }

    if (this.#bg) return; // documented gap: no canvas brightness + background

    // Non-HW brightness under a face filter rides in ITS ctx.filter chain
    // (set at #ensureFace config time) — never attach the fallback processor
    // while the filter holds the slot (it would evict it).
    if (this.#face) return;

    if (!slotOps) return;

    if (brightness === 100) {
      // Zero overhead at default: fully tear the canvas processor down.
      if (this.#brightness) {
        this.#assertMayOp(opGuard);
        try {
          await track.stopProcessor();
        } catch {
          /* ignore */
        }
        this.#brightness = undefined;
      }
      return;
    }

    if (this.#brightness) {
      this.#brightness.setBrightness(brightness);
    } else {
      // Assign ONLY after setProcessor resolves (carried-over invariant,
      // diff-review finding 6) — a failed init must not leave a dead reference
      // that later applies silently setBrightness() into.
      const proc = new BrightnessVideoProcessor(brightness);
      try {
        this.#assertMayOp(opGuard);
        await track.setProcessor(proc);
      } catch (e) {
        await proc.destroy().catch(() => {});
        throw e;
      }
      if (myGen !== this.#gen) {
        await proc.destroy().catch(() => {});
        return;
      }
      this.#brightness = proc;
    }
  }

  /**
   * Tear down effects on a still-live track (e.g. closing the preview while the
   * track is reused elsewhere, or removing a failed background from a camera
   * that has just been muted). For a track that has already been stopped, use
   * {@link reset} instead — stopping the track already destroyed the processors.
   */
  async detach(track: LocalVideoTrack) {
    this.#gen++; // supersede any apply still initializing
    // Unguarded on purpose: whether a detach may touch the sender right now
    // is the caller's decision (it mutes the camera first).
    // A prebuilt background LiveKit attached but adopt() never saw is still
    // this controller's to remove.
    this.#adoptAttachedPrebuilt(track);
    await this.#teardownBackground(track);
    await this.#teardownFace(track);
    if (this.#brightness) {
      try {
        await track.stopProcessor();
      } catch {
        /* ignore */
      }
      this.#brightness = undefined;
    }
  }

  /**
   * Drop all references WITHOUT touching a track (the track was stopped
   * externally, which already destroyed any attached processor). Also releases
   * the virtual-background image URL and any prebuilt background that was
   * never adopted. NOT for camera off, which is a mute: see
   * {@link onTrackMuted}.
   */
  reset() {
    this.#gen++; // supersede any apply still initializing (destroy-on-resolve)
    this.#stopBgAnimation();
    this.discardPrebuilt();
    this.#bg = undefined;
    this.#face = undefined;
    this.#facePending = undefined; // close the status-forward window too
    this.#brightness = undefined;
    this.#revokeImg?.();
    this.#revokeImg = undefined;
  }

  /**
   * Re-arm every tone stage the watchdog shed. For the END of a call only:
   * `reset()` also runs when the camera is unpublished or first published
   * mid-call and deliberately leaves the watchdog alone, so a stage shed for
   * being too slow stays off until the call is over. The same goes for a
   * face-tracked look that failed, and it is forgotten here too.
   */
  resetToneWatchdog(): void {
    this.#watchdog?.reset();
    this.#glamFailed = false;
  }
}
