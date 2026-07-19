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
 */
import type { FaceLandmarker } from "@mediapipe/tasks-vision";

import { CONFIGURATION } from "@revolt/common";
import type {
  CameraColorLookId,
  CameraFaceFilterId,
} from "@revolt/state/stores/Voice";

import {
  COLOR_LOOKS,
  DEGRADE,
  DegradeLadder,
  FACE_FILTERS,
  FACE_OVAL,
  MASK_CUTOUTS,
  type NormalizedLandmark,
  beautifyAlpha,
  beautifyBlurPx,
  computeFaceFrame,
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

/** Sticker art base — BASE_URL-aware so non-root deployments resolve (plan §3). */
const FILTER_ASSETS_BASE = `${import.meta.env.BASE_URL}filters`.replace(
  /\/$/,
  "",
);

/** Consecutive per-frame detect throws before the landmarker is declared dead. */
const DETECT_FAIL_LIMIT = 5;

/** How many frames a stale landmark result may bridge a detection dropout. */
const LANDMARK_HOLD_FRAMES = 3;

export interface FaceFilterConfig {
  filterId?: CameraFaceFilterId;
  /** 0–100; 0 = off. */
  beautify: number;
  lookId?: CameraColorLookId;
  /** 0–200, 100 = neutral. Non-HW-brightness sources only (plan §5). */
  brightness: number;
}

export interface FaceFilterStatusReport {
  /** True when landmark-dependent features were requested but tracking is dead. */
  landmarksFailed: boolean;
  /** Current degrade-ladder step (0 = full quality … 3 = beautify off). */
  degraded: number;
}

/** Whether this config needs face landmarks at all. */
function needsLandmarks(cfg: FaceFilterConfig): boolean {
  return !!cfg.filterId || cfg.beautify > 0;
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

  constructor(config: FaceFilterConfig) {
    this.#cfg = { ...config };
  }

  get degradeStep(): number {
    return this.#ladder.step;
  }

  /**
   * Live config update (slider drags, sticker swaps) — no processor rebuild.
   * May lazily start landmarker init when landmarks become needed.
   */
  setConfig(config: FaceFilterConfig) {
    this.#cfgGen++;
    this.#cfg = { ...config };
    if (this.#disposed) return;
    void this.#syncBitmaps();
    this.#ensureLandmarker();
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
    this.source = opts.track;
    this.#video.srcObject = new MediaStream([opts.track]);
    await this.#video.play();
    this.#lastLandmarks = undefined;
    this.#detectFails = 0;
    this.#scheduleFrame();
  }

  async destroy() {
    this.#disposed = true;
    this.#stopped = true;
    this.#cfgGen++;
    this.#cancelFrame();
    this.#video?.pause();
    this.#video = undefined;
    this.#canvas = undefined;
    this.#ctx = undefined;
    this.#smoothCanvas = undefined;
    this.#smoothCtx = undefined;
    this.#maskCanvas = undefined;
    this.#maskCtx = undefined;
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

  #scheduleFrame() {
    this.#cancelFrame();
    const video = this.#video;
    if (!video || this.#stopped) return;
    if ("requestVideoFrameCallback" in video) {
      const tick = () => {
        if (this.#stopped) return;
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
  }

  #drawFrame() {
    const video = this.#video;
    const canvas = this.#canvas;
    const ctx = this.#ctx;
    if (!video || !canvas || !ctx || video.videoWidth === 0) return;

    const start = performance.now();
    this.#frameCounter++;

    // Track source resolution changes (LiveKit restarts/simulcast).
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

    // 1. Color look + non-HW brightness on the source draw.
    const filters: string[] = [];
    if (cfg.lookId && COLOR_LOOKS[cfg.lookId]) {
      filters.push(COLOR_LOOKS[cfg.lookId].cssFilter);
    }
    if (cfg.brightness !== 100) {
      filters.push(`brightness(${cfg.brightness}%)`);
    }
    ctx.filter = filters.length ? filters.join(" ") : "none";
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    ctx.filter = "none";

    // 2. Landmarks (only when needed; cadence-halved at ladder step ≥ 1).
    let landmarks: NormalizedLandmark[] | undefined;
    if (needsLandmarks(cfg) && this.#landmarker) {
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

    const prevStep = this.#ladder.step;
    const newStep = this.#ladder.record(performance.now() - start, start);
    if (newStep !== prevStep) this.#reportStatus();
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
      !needsLandmarks(this.#cfg) ||
      this.#landmarker ||
      this.#landmarkerFailed ||
      this.#landmarkerInitInFlight ||
      this.#disposed
    ) {
      return;
    }
    this.#landmarkerInitInFlight = true;
    const myGen = this.#cfgGen;
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
      // Stale resolve (config moved on / destroyed): free immediately —
      // this is the leak class the controller's #gen can't see (plan §2).
      if (this.#disposed || myGen !== this.#cfgGen) {
        lm.close();
        // Not a failure — a later config may re-init.
        if (!this.#disposed) this.#ensureLandmarker();
        return;
      }
      this.#landmarker = lm;
      this.#reportStatus();
    })();
  }

  /** GPU first, one CPU retry — tasks-vision has NO internal fallback (plan §2). */
  async #createLandmarker(): Promise<FaceLandmarker> {
    const { FaceLandmarker: FL, FilesetResolver } = await import(
      "@mediapipe/tasks-vision"
    );
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
    const wanted = new Set<string>(
      this.#cfg.filterId
        ? FACE_FILTERS[this.#cfg.filterId]?.layers.map((l) => l.src) ?? []
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
    this.onStatus?.({
      landmarksFailed: needsLandmarks(this.#cfg) && this.#landmarkerFailed,
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
