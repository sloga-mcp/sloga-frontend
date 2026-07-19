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
 */
import {
  BackgroundProcessor,
  type BackgroundProcessorWrapper,
  supportsBackgroundProcessors,
} from "@livekit/track-processors";
import { Capacitor } from "@capacitor/core";
import { LocalVideoTrack } from "livekit-client";

import { CONFIGURATION } from "@revolt/common";
import type {
  CameraBackgroundMode,
  CameraColorLookId,
  CameraFaceFilterId,
} from "@revolt/state/stores/Voice";

import { resolveBackgroundUrl } from "./cameraBackgrounds";
import { pickSlotOccupant, type SlotOccupant } from "./faceFilterCatalog";
import {
  FaceFilterProcessor,
  type FaceFilterStatusReport,
} from "./faceFilterProcessor";

/**
 * Canvas brightness fallback for cameras without a hardware brightness control
 * (and no active background). Draws the source frame through a CSS
 * `brightness()` filter and re-captures at 30fps.
 */
export class BrightnessVideoProcessor {
  name = "brightness-processor";
  processedTrack: MediaStreamTrack | undefined;
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
    this.processedTrack = undefined;
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
}

/**
 * Stateful controller that owns the single processor slot + brightness for one
 * LocalVideoTrack at a time. Create one per consumer (the room camera; the
 * settings preview). Not reentrant — callers serialize their own `apply` calls.
 */
export class CameraEffectsController {
  #bg: BackgroundProcessorWrapper | undefined;
  #face: FaceFilterProcessor | undefined;
  #brightness: BrightnessVideoProcessor | undefined;
  #revokeImg: (() => void) | undefined;
  #hwSupported = false;
  /**
   * Generation token. Bumped by reset()/detach() so that an `apply` whose
   * `setProcessor` is still initializing (the ~1s MediaPipe init window) can
   * detect it was superseded/torn-down and destroy the just-built processor
   * instead of resurrecting a stale `#bg` (which would leak the WebGL context +
   * WASM segmenter).
   */
  #gen = 0;

  /** Notified whenever hardware-brightness support is (re)detected. */
  onHwSupportChange?: (hw: boolean) => void;
  /** Notified when the configured background image id no longer resolves. */
  onImageMissing?: () => void;
  /** Forwarded from the live FaceFilterProcessor (landmark failure + degrade). */
  onFaceFilterStatus?: (s: FaceFilterStatusReport) => void;

  get hwBrightnessSupported(): boolean {
    return this.#hwSupported;
  }

  get backgroundActive(): boolean {
    return !!this.#bg;
  }

  get faceFilterActive(): boolean {
    return !!this.#face;
  }

  #chain: Promise<unknown> = Promise.resolve();

  /**
   * Apply the given settings to a live camera track. Idempotent; safe on enable
   * and on any live change. Calls are SERIALIZED internally so a rapid slider
   * drag can't race `switchTo`/`setProcessor` on the segmenter. May throw from
   * the background path AFTER brightness has been applied (fail-safe: a
   * background failure never skips brightness and the raw track keeps
   * publishing); the caller can surface that as a "failed" status.
   */
  apply(track: LocalVideoTrack, settings: CameraEffectSettings): Promise<void> {
    const result = this.#chain
      .catch(() => {})
      .then(() => this.#applyInner(track, settings));
    this.#chain = result.catch(() => {});
    return result;
  }

  async #applyInner(track: LocalVideoTrack, settings: CameraEffectSettings) {
    const myGen = this.#gen;

    // Probe HW brightness on the RAW source BEFORE building any occupant
    // (plan §5, re-verify NEW-2): the verdict decides the brightness value
    // baked into a face-filter config, and stays single-sourced for the
    // whole apply pass.
    const hw = this.#hasHwBrightness(this.#rawSource(track));

    const occupant: SlotOccupant = pickSlotOccupant(
      {
        backgroundMode: settings.backgroundMode,
        faceFilterId: settings.faceFilterId,
        beautify: settings.beautify,
        colorLookId: settings.colorLookId,
        brightness: settings.brightness,
      },
      {
        backgroundSupported: cameraBackgroundSupported(),
        faceFiltersSupported: faceFiltersSupported(),
        hwBrightness: hw,
      },
    );

    let effectError: unknown;
    if (occupant === "background") {
      this.#brightness = undefined; // slot goes to the background
      try {
        await this.#teardownFace(track);
        await this.#ensureBackground(track, myGen, settings);
      } catch (e) {
        // Fail-safe: never leave a poisoned wrapper, never skip brightness.
        effectError = e;
        await this.#teardownBackground(track).catch(() => {});
      }
    } else if (occupant === "face") {
      this.#brightness = undefined; // slot goes to the filter processor
      try {
        await this.#teardownBackground(track);
        await this.#ensureFace(track, myGen, settings, hw);
      } catch (e) {
        effectError = e;
        await this.#teardownFace(track).catch(() => {});
      }
    } else {
      await this.#teardownBackground(track);
      await this.#teardownFace(track);
    }

    // Superseded by a reset()/detach() mid-apply → don't touch the (torn-down)
    // track's brightness.
    if (myGen !== this.#gen) return;

    await this.#applyBrightness(track, settings.brightness, hw);

    // Surface the effect failure only AFTER brightness has landed.
    if (effectError) throw effectError;
  }

  /** The raw camera track, whichever occupant (if any) holds the slot. */
  #rawSource(track: LocalVideoTrack): MediaStreamTrack | undefined {
    return this.#bg?.source ?? this.#face?.source ?? track.mediaStreamTrack;
  }

  /**
   * Create or live-update the face-filter processor. `hw` decides whether the
   * config carries the user brightness (non-HW source: applied in the filter's
   * ctx.filter chain) or neutral 100 (HW: exactly one mechanism, plan §5).
   */
  async #ensureFace(
    track: LocalVideoTrack,
    myGen: number,
    settings: CameraEffectSettings,
    hw: boolean,
  ) {
    const cfg = {
      filterId: settings.faceFilterId,
      beautify: settings.beautify,
      lookId: settings.colorLookId,
      brightness: hw ? 100 : settings.brightness,
    };

    if (this.#face) {
      this.#face.setConfig(cfg);
      return;
    }

    const proc = new FaceFilterProcessor(cfg);
    proc.onStatus = (s) => {
      // Only the CURRENT occupant reports (a superseded/destroyed processor
      // stops firing after destroy(), but guard anyway).
      if (this.#face === proc || !this.#face) this.onFaceFilterStatus?.(s);
    };
    try {
      await track.setProcessor(proc);
    } catch (e) {
      await proc.destroy().catch(() => {});
      throw e;
    }
    if (myGen !== this.#gen) {
      // Superseded during init (reset/detach ran) — destroy, don't resurrect.
      await proc.destroy().catch(() => {});
      return;
    }
    this.#face = proc;
  }

  /** Remove the face-filter processor (if any). */
  async #teardownFace(track: LocalVideoTrack) {
    if (this.#face) {
      try {
        await track.stopProcessor();
      } catch {
        /* ignore */
      }
      this.#face = undefined;
    }
  }

  /** Create or (within a live session) switch the single background processor. */
  async #ensureBackground(
    track: LocalVideoTrack,
    myGen: number,
    settings: CameraEffectSettings,
  ) {
    const mode = settings.backgroundMode as "blur" | "image";
    const blurRadius = settings.blurRadius;

    // Release any prior image URL whenever the new mode isn't an image
    // (e.g. image -> blur), not only when resolving a replacement image.
    if (mode !== "image") {
      this.#revokeImg?.();
      this.#revokeImg = undefined;
    }

    let imagePath: string | undefined;
    if (mode === "image") {
      this.#revokeImg?.();
      this.#revokeImg = undefined;
      const id = settings.backgroundImageId;
      const resolved = id ? await resolveBackgroundUrl(id) : null;
      if (!resolved) {
        // No image chosen yet (empty id) OR the chosen one was deleted. Show the
        // raw background for now, but only fall back to "none" when a *selected*
        // image fails to resolve (deleted) — with no selection yet, STAY in image
        // mode so the picker remains visible for the user to choose one.
        if (id) this.onImageMissing?.();
        await this.#teardownBackground(track);
        return;
      }
      imagePath = resolved.url;
      this.#revokeImg = resolved.revoke;
    }

    if (this.#bg) {
      await this.#bg.switchTo(
        mode === "blur"
          ? { mode: "background-blur", blurRadius }
          : { mode: "virtual-background", imagePath: imagePath! },
      );
    } else {
      // Assign #bg ONLY after setProcessor resolves — a failed init must not
      // leave a dead wrapper that poisons later switchTo / brightness reads.
      const proc = BackgroundProcessor({
        mode: mode === "blur" ? "background-blur" : "virtual-background",
        blurRadius,
        imagePath,
        assetPaths: SEGMENTATION_ASSET_PATHS,
      });
      try {
        await track.setProcessor(proc);
      } catch (e) {
        // Init failed — best-effort free (also no-op if still initializing).
        await proc.destroy().catch(() => {});
        throw e;
      }
      if (myGen !== this.#gen) {
        // Superseded during init (reset/detach ran). Init has now completed, so
        // destroy() actually frees the WebGL/WASM resources; do NOT resurrect
        // #bg. Also drop the image URL this run resolved.
        await proc.destroy().catch(() => {});
        this.#revokeImg?.();
        this.#revokeImg = undefined;
        return;
      }
      this.#bg = proc;
    }
  }

  /** Remove the background processor (if any) and release its image URL. */
  async #teardownBackground(track: LocalVideoTrack) {
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

  async #applyBrightness(track: LocalVideoTrack, brightness: number, hw: boolean) {
    // HW detection/constraints ALWAYS target the raw camera track — with ANY
    // processor attached, `track.mediaStreamTrack` returns the PROCESSED track
    // (plan §5): probing it would mis-report hw support and constraining it
    // would be a no-op.
    const source = this.#rawSource(track);
    if (hw !== this.#hwSupported) {
      this.#hwSupported = hw;
      this.onHwSupportChange?.(hw);
    }

    if (hw) {
      if (this.#brightness) {
        // The canvas fallback never coexists with #bg/#face, so if it exists
        // it holds the slot — safe to stop.
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

    if (brightness === 100) {
      // Zero overhead at default: fully tear the canvas processor down.
      if (this.#brightness) {
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
      this.#brightness = new BrightnessVideoProcessor(brightness);
      await track.setProcessor(this.#brightness);
    }
  }

  /**
   * Tear down effects on a still-live track (e.g. closing the preview while the
   * track is reused elsewhere). For a track that has already been stopped, use
   * {@link reset} instead — stopping the track already destroyed the processors.
   */
  async detach(track: LocalVideoTrack) {
    this.#gen++; // supersede any apply still initializing
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
   * the virtual-background image URL.
   */
  reset() {
    this.#gen++; // supersede any apply still initializing (destroy-on-resolve)
    this.#bg = undefined;
    this.#face = undefined;
    this.#brightness = undefined;
    this.#revokeImg?.();
    this.#revokeImg = undefined;
  }
}
