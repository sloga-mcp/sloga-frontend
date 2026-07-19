/**
 * Face-filter catalogue + pure placement/policy math.
 *
 * PURE MODULE — no browser APIs, no `import.meta.env`, no side effects — so the
 * placement math, slot policy, and catalogue integrity are unit-testable with
 * `node --test` (see faceFilterPolicy.test.ts). Asset URL resolution and all
 * canvas/MediaPipe work live in faceFilterProcessor.ts.
 *
 * The VALID id lists are owned by the Voice store (`CameraFaceFilterIds`,
 * `CameraColorLookIds`) so its `clean()` can validate without importing rtc;
 * this catalogue maps each id to art + anchors and a test pins the 1:1
 * correspondence.
 */
import type {
  CameraBackgroundMode,
  CameraColorLookId,
  CameraFaceFilterId,
} from "@revolt/state/stores/Voice";

/** Anchor points a sticker layer can attach to. */
export type StickerAnchor =
  | "head-top"
  | "eyes"
  | "nose"
  | "upper-lip"
  | "left-eye"
  | "right-eye";

/**
 * One drawable layer of a face filter. Geometry is expressed in IOD units
 * (inter-ocular distance — the distance between the two iris centres) along the
 * face's local axes, so stickers scale and rotate with the face.
 */
export interface StickerLayer {
  /** Asset file name under the filters asset base (resolved by the processor). */
  src: string;
  anchor: StickerAnchor;
  /** Rendered sticker width as a multiple of IOD. */
  widthFactor: number;
  /** Centre offset from the anchor, in IOD units along (xAxis, yAxis). */
  offset: { x: number; y: number };
}

export interface FaceFilterDef {
  id: CameraFaceFilterId;
  /** Gallery label (localized-neutral, like camera background presets). */
  name: string;
  /** Representative layer asset used as the gallery thumbnail. */
  thumb: string;
  layers: StickerLayer[];
}

export interface ColorLookDef {
  id: CameraColorLookId;
  /** Chip label (localized-neutral). */
  name: string;
  /** CSS filter list applied to the source frame (brightness is appended separately). */
  cssFilter: string;
}

/** AR sticker filters. Art lives in `public/filters/` (in-house SVG, original work). */
export const FACE_FILTERS: Record<CameraFaceFilterId, FaceFilterDef> = {
  dog: {
    id: "dog",
    name: "Dog",
    thumb: "dog-ears.svg",
    layers: [
      {
        src: "dog-ears.svg",
        anchor: "head-top",
        widthFactor: 2.9,
        offset: { x: 0, y: -0.55 },
      },
      {
        src: "dog-nose.svg",
        anchor: "nose",
        widthFactor: 1.05,
        offset: { x: 0, y: 0.02 },
      },
      {
        src: "dog-tongue.svg",
        anchor: "upper-lip",
        widthFactor: 0.9,
        offset: { x: 0, y: 0.6 },
      },
    ],
  },
  cat: {
    id: "cat",
    name: "Cat",
    thumb: "cat-ears.svg",
    layers: [
      {
        src: "cat-ears.svg",
        anchor: "head-top",
        widthFactor: 2.6,
        offset: { x: 0, y: -0.75 },
      },
      {
        src: "cat-whiskers.svg",
        anchor: "nose",
        widthFactor: 3.2,
        offset: { x: 0, y: 0.1 },
      },
    ],
  },
  sunglasses: {
    id: "sunglasses",
    name: "Sunglasses",
    thumb: "sunglasses.svg",
    layers: [
      {
        src: "sunglasses.svg",
        anchor: "eyes",
        widthFactor: 2.7,
        offset: { x: 0, y: 0.05 },
      },
    ],
  },
  mustache: {
    id: "mustache",
    name: "Mustache",
    thumb: "mustache.svg",
    layers: [
      {
        src: "mustache.svg",
        anchor: "upper-lip",
        widthFactor: 1.7,
        offset: { x: 0, y: -0.08 },
      },
    ],
  },
  "party-hat": {
    id: "party-hat",
    name: "Party Hat",
    thumb: "party-hat.svg",
    layers: [
      {
        src: "party-hat.svg",
        anchor: "head-top",
        widthFactor: 1.9,
        offset: { x: 0.35, y: -1.05 },
      },
    ],
  },
  "heart-eyes": {
    id: "heart-eyes",
    name: "Heart Eyes",
    thumb: "heart.svg",
    layers: [
      {
        src: "heart.svg",
        anchor: "left-eye",
        widthFactor: 0.95,
        offset: { x: 0, y: 0 },
      },
      {
        src: "heart.svg",
        anchor: "right-eye",
        widthFactor: 0.95,
        offset: { x: 0, y: 0 },
      },
    ],
  },
};

/** One-tap color grades (brightness handled separately by the processor). */
export const COLOR_LOOKS: Record<CameraColorLookId, ColorLookDef> = {
  warm: {
    id: "warm",
    name: "Warm",
    cssFilter: "sepia(0.18) saturate(1.15) brightness(1.03)",
  },
  cool: {
    id: "cool",
    name: "Cool",
    cssFilter: "saturate(1.05) hue-rotate(-8deg) brightness(1.02) contrast(1.02)",
  },
  vintage: {
    id: "vintage",
    name: "Vintage",
    cssFilter: "sepia(0.38) contrast(0.95) saturate(0.85) brightness(1.02)",
  },
  mono: {
    id: "mono",
    name: "Mono",
    cssFilter: "grayscale(1) contrast(1.05)",
  },
  vivid: {
    id: "vivid",
    name: "Vivid",
    cssFilter: "saturate(1.4) contrast(1.08)",
  },
};

// ---------------------------------------------------------------------------
// Landmark geometry (MediaPipe FaceLandmarker, 478-point mesh)
// ---------------------------------------------------------------------------

/** A normalized (0..1) landmark as produced by FaceLandmarker. */
export interface NormalizedLandmark {
  x: number;
  y: number;
}

/**
 * Landmark indices used for anchoring. Iris centres are labelled A/B and
 * sorted by IMAGE x at runtime — per-eye art is symmetric, so semantic
 * left/right labelling doesn't matter, only that both eyes are covered.
 */
export const LANDMARK = {
  IRIS_A: 468,
  IRIS_B: 473,
  NOSE_TIP: 1,
  UPPER_LIP: 0,
  FOREHEAD: 10,
  CHIN: 152,
} as const;

/** Face-oval ring for the beautify mask (standard FaceMesh contour). */
export const FACE_OVAL: readonly number[] = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379,
  378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127,
  162, 21, 54, 103, 67, 109,
];

/** Eye + mouth rings cut OUT of the beautify mask so they stay sharp. */
export const MASK_CUTOUTS: readonly (readonly number[])[] = [
  [33, 160, 158, 133, 153, 144],
  [263, 387, 385, 362, 380, 373],
  [61, 40, 37, 0, 267, 270, 291, 321, 314, 17, 84, 91],
];

/**
 * The face's local frame in pixel space: anchor points, the IOD scale, and
 * the (xAxis, yAxis) unit vectors (xAxis along the eye line, yAxis toward the
 * chin — so stickers roll with the head).
 */
export interface FaceFrame {
  iod: number;
  xAxis: { x: number; y: number };
  yAxis: { x: number; y: number };
  anchors: Record<StickerAnchor, { x: number; y: number }>;
}

/**
 * Compute the face frame from a landmark set. Pure; returns null when the
 * landmark array is too short or the eyes are degenerate (zero IOD).
 */
export function computeFaceFrame(
  landmarks: readonly NormalizedLandmark[],
  width: number,
  height: number,
): FaceFrame | null {
  const need = Math.max(
    LANDMARK.IRIS_B,
    LANDMARK.CHIN,
    LANDMARK.FOREHEAD,
  );
  if (landmarks.length <= need) return null;

  const px = (i: number) => ({
    x: landmarks[i].x * width,
    y: landmarks[i].y * height,
  });

  const a = px(LANDMARK.IRIS_A);
  const b = px(LANDMARK.IRIS_B);
  // Sort by image x so "left-eye" is always the viewer-left eye.
  const [eyeL, eyeR] = a.x <= b.x ? [a, b] : [b, a];

  const dx = eyeR.x - eyeL.x;
  const dy = eyeR.y - eyeL.y;
  const iod = Math.hypot(dx, dy);
  if (!(iod > 1e-6)) return null;

  const xAxis = { x: dx / iod, y: dy / iod };
  // Perpendicular, sign-disambiguated toward the chin.
  let yAxis = { x: -xAxis.y, y: xAxis.x };
  const eyesMid = { x: (eyeL.x + eyeR.x) / 2, y: (eyeL.y + eyeR.y) / 2 };
  const chin = px(LANDMARK.CHIN);
  if (
    yAxis.x * (chin.x - eyesMid.x) + yAxis.y * (chin.y - eyesMid.y) <
    0
  ) {
    yAxis = { x: -yAxis.x, y: -yAxis.y };
  }

  return {
    iod,
    xAxis,
    yAxis,
    anchors: {
      eyes: eyesMid,
      "left-eye": eyeL,
      "right-eye": eyeR,
      nose: px(LANDMARK.NOSE_TIP),
      "upper-lip": px(LANDMARK.UPPER_LIP),
      "head-top": px(LANDMARK.FOREHEAD),
    },
  };
}

/** A layer resolved to concrete draw parameters (centre, width, rotation). */
export interface LayerPlacement {
  cx: number;
  cy: number;
  /** Rendered width in px; height follows the bitmap's aspect ratio. */
  width: number;
  /** Rotation in radians (the face's roll). */
  rotation: number;
}

/**
 * Place a sticker layer on a face frame. Pure.
 */
export function placeLayer(frame: FaceFrame, layer: StickerLayer): LayerPlacement {
  const anchor = frame.anchors[layer.anchor];
  const ox = layer.offset.x * frame.iod;
  const oy = layer.offset.y * frame.iod;
  return {
    cx: anchor.x + frame.xAxis.x * ox + frame.yAxis.x * oy,
    cy: anchor.y + frame.xAxis.y * ox + frame.yAxis.y * oy,
    width: layer.widthFactor * frame.iod,
    rotation: Math.atan2(frame.xAxis.y, frame.xAxis.x),
  };
}

// ---------------------------------------------------------------------------
// Beautify parameter mapping
// ---------------------------------------------------------------------------

/** Blend alpha for the smoothed layer: 0–100 strength → 0–0.65. */
export function beautifyAlpha(strength: number): number {
  const s = Math.max(0, Math.min(100, strength));
  return (0.65 * s) / 100;
}

/** Smoothing blur radius in px, scaled by face size: 2–6 px at IOD 90. */
export function beautifyBlurPx(strength: number, iod: number): number {
  const s = Math.max(0, Math.min(100, strength));
  const base = 2 + (4 * s) / 100;
  return Math.max(1, base * (iod / 90));
}

// ---------------------------------------------------------------------------
// Slot occupancy policy (plan §5)
// ---------------------------------------------------------------------------

export type SlotOccupant = "background" | "face" | "brightness-fallback" | "none";

export interface SlotSettings {
  backgroundMode: CameraBackgroundMode;
  faceFilterId?: CameraFaceFilterId;
  beautify: number;
  colorLookId?: CameraColorLookId;
  /** 0–200, 100 = neutral. */
  brightness: number;
}

export interface SlotCaps {
  backgroundSupported: boolean;
  faceFiltersSupported: boolean;
  /** Whether the RAW camera source exposes a hardware brightness constraint. */
  hwBrightness: boolean;
}

/** Whether any face-filter feature is requested (regardless of support). */
export function faceSettingsActive(s: SlotSettings): boolean {
  return !!s.faceFilterId || s.beautify > 0 || !!s.colorLookId;
}

/**
 * Decide which processor occupies the single LiveKit slot (plan §5 table).
 * Background wins over filters (v1 mutual exclusion — filters stay INERT and
 * the UI shows a "paused" badge). The canvas brightness fallback only ever
 * runs when NOTHING else holds the slot.
 */
export function pickSlotOccupant(s: SlotSettings, caps: SlotCaps): SlotOccupant {
  if (s.backgroundMode !== "none" && caps.backgroundSupported) {
    return "background";
  }
  if (faceSettingsActive(s) && caps.faceFiltersSupported) {
    return "face";
  }
  if (s.brightness !== 100 && !caps.hwBrightness) {
    return "brightness-fallback";
  }
  return "none";
}

// ---------------------------------------------------------------------------
// Degrade ladder (plan §8) — pure step logic, timestamps passed in
// ---------------------------------------------------------------------------

export const DEGRADE = {
  /** Rolling-mean frame budget that triggers one step down. */
  TRIGGER_MS: 22,
  /** Rolling mean below this for RECOVER_AFTER_MS steps one rung back up. */
  RECOVER_MS: 14,
  RECOVER_AFTER_MS: 10_000,
  /** Rolling window length in frames. */
  WINDOW: 60,
  /** 0 = full, 1 = landmarks every 2nd frame, 2 = quarter-res smoothing, 3 = beautify off. */
  MAX_STEP: 3,
} as const;

/**
 * Rolling-mean frame-cost tracker + ladder stepper. Pure: callers pass
 * timestamps (no Date.now inside — keeps it deterministic for tests).
 */
export class DegradeLadder {
  #samples: number[] = [];
  #sum = 0;
  #step = 0;
  #lowSince: number | null = null;

  get step(): number {
    return this.#step;
  }

  /** Record one frame's cost; returns the (possibly changed) ladder step. */
  record(frameCostMs: number, nowMs: number): number {
    this.#samples.push(frameCostMs);
    this.#sum += frameCostMs;
    if (this.#samples.length > DEGRADE.WINDOW) {
      this.#sum -= this.#samples.shift()!;
    }
    if (this.#samples.length < DEGRADE.WINDOW) return this.#step;

    const mean = this.#sum / this.#samples.length;
    if (mean > DEGRADE.TRIGGER_MS) {
      if (this.#step < DEGRADE.MAX_STEP) {
        this.#step++;
        // Reset the window so the new step is judged on fresh samples.
        this.#samples = [];
        this.#sum = 0;
      }
      this.#lowSince = null;
    } else if (mean < DEGRADE.RECOVER_MS && this.#step > 0) {
      if (this.#lowSince === null) {
        this.#lowSince = nowMs;
      } else if (nowMs - this.#lowSince >= DEGRADE.RECOVER_AFTER_MS) {
        this.#step--;
        this.#lowSince = null;
        this.#samples = [];
        this.#sum = 0;
      }
    } else {
      this.#lowSince = null;
    }
    return this.#step;
  }

  /** Start at a given step (CPU-delegate sessions start at 1, plan §2). */
  reset(step = 0) {
    this.#samples = [];
    this.#sum = 0;
    this.#step = step;
    this.#lowSince = null;
  }
}
