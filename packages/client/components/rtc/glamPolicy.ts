/**
 * Glam (the face-tracked look): the PURE decisions behind it. Extracted so
 * `node --test` can load it (the house no-vitest split; this module must stay
 * dependency-free: no DOM, no i18n, no imports).
 *
 * What lives here:
 *
 * 1. Levels. `glamLevels` maps the stored 0..100 setting to the amount of
 *    each part of the look. The caps are low on purpose: the reshape bends
 *    real pixels, and a strong one shows on glasses and on the background
 *    next to the chin.
 *
 * 2. Geometry. `glamGeometry` turns one set of face landmarks into what the
 *    mask painter and the shader need: the rings to fill, the two eye
 *    centres to magnify, the four lower-face pushes, and the padded box the
 *    coverage map covers. Every length is in units of the frame HEIGHT and
 *    is measured in a space where x is multiplied by the aspect ratio, so a
 *    circle stays a circle on a wide or a tall frame. Every output is finite,
 *    whatever the pose, so a NaN never reaches a uniform. The box is clamped
 *    to the frame and every radius is clamped to its limits. Ring points and
 *    centres are NOT clamped: they are passed through as the tracker gave
 *    them and are only bounded, at most one whole frame outside the picture
 *    on any side (-1..2). A face at the frame edge really has points outside
 *    it, and pulling them in would bend the shape.
 *
 * 3. Smoothing. `LandmarkSmoother` is a one-euro filter per coordinate: a
 *    still face is held still (no shimmer in the makeup), and a moving face
 *    is followed with little lag.
 *
 * 4. Cost. Face tracking runs on the main thread, next to work that must
 *    not be starved. `GlamBudget` watches the time each detect takes: it
 *    slows the cadence when the mean climbs and sheds the look for the rest
 *    of the call when tracking is too slow to be worth it. It never re-arms.
 *    The first detects of a new tracker are slow for reasons that say
 *    nothing about the device, so the caller can have them left out, up to
 *    a ceiling no detect may pass. `glamShouldDetect` is the one place that
 *    says whether this frame may run a detect, and `GlamDetectLatch` holds
 *    "this frame task already ran one" so the caller cannot get it wrong.
 *    `glamMayCreateTracker` and `glamTrackerLoadMustWait` say when the
 *    tracker may be created, which blocks the thread for longer than any
 *    detect.
 *
 * 5. Face lost and page hidden. `glamPresence` holds the look for a moment
 *    after the last hit and then fades it out. `GlamRecovery` allows one
 *    re-create of the tracker when it died while the page was hidden. No
 *    detect runs on a hidden page, so that death is usually first seen just
 *    after the page comes back; a failure in that short window counts too.
 *
 * 6. Tracker files. The phone apps are built in more than one way and not
 *    every build carries the tracker's files. `glamProbeVerdict` reads what
 *    the requests for one file came back with and says whether the file is
 *    there, is not there, or cannot be told; `glamProbeCapability` puts the
 *    files together. The caller only sends the requests.
 *
 * 7. Failure text. The look is tested on phones with no log to read, so
 *    why it failed is said on screen, in a readout that is hidden until it
 *    is asked for. `glamFailureText` turns anything that was thrown into
 *    one short line, `glamTrackerFailure` names the step of a tracker load
 *    that failed, and the rest of that section words the readout's other
 *    parts. Text only: nothing here decides anything.
 *
 * The look is cosmetic, so every failure here is fail open to plain video.
 */

/** A point in video UV: origin top-left, 0..1 on both axes. */
export interface GlamPoint {
  x: number;
  y: number;
}

/** What the switch stores when it is turned on. */
export const GLAM_SWITCH_STRENGTH = 60;
/** Landmarks are reused this long after the last hit. */
export const GLAM_HOLD_MS = 250;
/** Then the look fades to nothing over this long. */
export const GLAM_FADE_MS = 200;
/** Normal cadence, in frames. */
export const GLAM_DETECT_EVERY = 2;
export const GLAM_DETECT_EVERY_SLOW = 3;
/** Rolling mean above this: detect every third frame. */
export const GLAM_SLOW_MEAN_MS = 20;
/** Rolling mean above this for `GLAM_SHED_DWELL_MS`: shed. */
export const GLAM_SHED_MEAN_MS = 35;
export const GLAM_SHED_DWELL_MS = 5000;
/** One detect above this: shed at once. */
export const GLAM_SHED_SINGLE_MS = 150;
/** `GLAM_SHED_RUN` detects in a row above this: shed at once. */
export const GLAM_SHED_RUN_MS = 60;
export const GLAM_SHED_RUN = 3;
/**
 * This long without a detect and the next frame runs one, whatever the
 * cadence says. At a low frame rate "every third frame" alone would let the
 * hold run out between two detects.
 */
export const GLAM_FORCE_DETECT_MS = 100;
/** How many detects after `GlamBudget.noteWarmup()` are left out of the budget. */
export const GLAM_WARMUP_DETECTS = 2;
/**
 * One detect above this: shed at once, a warm-up detect included. The first
 * inference of a new tracker is a few hundred ms on a device that is fine
 * afterwards. A whole second is a device where every new tracker and every
 * return from the background would hold the thread that long again.
 */
export const GLAM_WARMUP_CEILING_MS = 1000;
/** A failure this soon after the page came back counts as one from the background. */
export const GLAM_RECOVERY_GRACE_MS = 2000;
/** The coverage map: two 256x256 tiles side by side. */
export const GLAM_MAP_WIDTH = 512;
export const GLAM_MAP_HEIGHT = 256;

/** How many points the face tracker returns (468 mesh points + 10 iris). */
export const GLAM_LANDMARK_COUNT = 478;

/**
 * Closed rings of landmark indices (the standard face mesh contours). Where
 * there are two, the first is the side of the face that holds landmark 33
 * and the second is the side that holds landmark 263.
 */
export const GLAM_RINGS: {
  readonly oval: readonly number[];
  readonly eyes: readonly [readonly number[], readonly number[]];
  readonly brows: readonly [readonly number[], readonly number[]];
  readonly lipsOuter: readonly number[];
  readonly lipsInner: readonly number[];
  readonly lids: readonly [readonly number[], readonly number[]];
} = {
  oval: [
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379,
    378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127,
    162, 21, 54, 103, 67, 109,
  ],
  eyes: [
    [
      33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161,
      246,
    ],
    [
      263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388,
      466,
    ],
  ],
  brows: [
    [70, 63, 105, 66, 107, 55, 65, 52, 53, 46],
    [300, 293, 334, 296, 336, 285, 295, 282, 283, 276],
  ],
  lipsOuter: [
    61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0,
    37, 39, 40, 185,
  ],
  lipsInner: [
    78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13,
    82, 81, 80, 191,
  ],
  // Out along the upper lash line, back along the next row of the mesh above
  // it: a thin band that stops short of the crease.
  lids: [
    [246, 161, 160, 159, 158, 157, 173, 190, 56, 28, 27, 29, 30, 247],
    [466, 388, 387, 386, 385, 384, 398, 414, 286, 258, 257, 259, 260, 467],
  ],
};

/** Single landmarks the geometry is measured from. Same side order as the rings. */
export const GLAM_POINTS: {
  readonly forehead: number;
  readonly chin: number;
  readonly faceSides: readonly [number, number];
  readonly eyeCorners: readonly [
    readonly [number, number],
    readonly [number, number],
  ];
  readonly cheeks: readonly [number, number];
  readonly jaw: readonly [number, number, number, number];
} = {
  // The face mid line runs from the top of the forehead to the chin.
  forehead: 10,
  chin: 152,
  // The widest points of the face oval, in front of the ears.
  faceSides: [234, 454],
  eyeCorners: [
    [33, 133],
    [263, 362],
  ],
  cheeks: [205, 425],
  // Two per side on the face oval between ear and chin: cheek line, then jaw.
  jaw: [132, 136, 361, 365],
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

// ---- Levels ----------------------------------------------------------------

/** 0..1 amounts for each part of the look, from the stored 0..100 setting. All 0 at setting 0. */
export interface GlamLevels {
  smooth: number;
  lips: number;
  blush: number;
  lid: number;
  eye: number;
  slim: number;
  warm: number;
}

/** The amount of each part at setting 100. `eye` 0.12 = 12% larger at the centre. */
const LEVELS_AT_FULL: GlamLevels = {
  smooth: 0.75,
  lips: 0.45,
  blush: 0.3,
  lid: 0.35,
  eye: 0.12,
  slim: 0.06,
  warm: 0.08,
};

/**
 * Linear in the setting, clamped to 0..100, so the slider feels even and the
 * amounts never pass the caps. A non-finite setting is treated as off.
 */
export function glamLevels(setting: number): GlamLevels {
  const amount = Number.isFinite(setting) ? clamp(setting, 0, 100) / 100 : 0;
  return {
    smooth: LEVELS_AT_FULL.smooth * amount,
    lips: LEVELS_AT_FULL.lips * amount,
    blush: LEVELS_AT_FULL.blush * amount,
    lid: LEVELS_AT_FULL.lid * amount,
    eye: LEVELS_AT_FULL.eye * amount,
    slim: LEVELS_AT_FULL.slim * amount,
    warm: LEVELS_AT_FULL.warm * amount,
  };
}

// ---- Geometry --------------------------------------------------------------

/**
 * An eye to magnify: centre in video UV; `r` in units of frame HEIGHT.
 *
 * Magnify means the picture content moves AWAY from the centre. A shader
 * that reads a source texture therefore samples CLOSER to the eye centre
 * than the pixel it is drawing. Sampling further out shrinks the eye.
 */
export interface GlamEye {
  x: number;
  y: number;
  r: number;
}

/**
 * A lower-face push: the point in video UV, the direction the picture
 * content there moves, and the radius `r` in units of frame HEIGHT.
 *
 * `dx`, `dy` are a UNIT vector in aspect-corrected space (x multiplied by
 * the aspect ratio, so both axes are in frame heights), pointing from the
 * point toward the face mid line. It is the direction the PICTURE CONTENT
 * moves: the jaw line ends up nearer the mid line. A move of `d` frame
 * heights is, in UV, `move = (dx * d / aspect, dy * d)`.
 *
 * A shader that reads a source texture must sample at `uv - move`: the
 * pixel drawn at `uv` shows what was at `uv - move`, which is how content
 * travels by `+move`. Sampling at `uv + move` widens the face instead.
 *
 * When the direction cannot be told (the point sits on the mid line, as in
 * a full profile) both are 0, which makes the push do nothing.
 */
export interface GlamPush {
  x: number;
  y: number;
  dx: number;
  dy: number;
  r: number;
}

/**
 * `eyes` are in the side order of `GLAM_RINGS.eyes`; `jaw` is in the order
 * of `GLAM_POINTS.jaw` (cheek line then jaw on one side, then the other).
 */
export interface GlamWarp {
  eyes: [GlamEye, GlamEye];
  jaw: [GlamPush, GlamPush, GlamPush, GlamPush];
}

/** The video UV rect the coverage map covers: the padded face box, clamped to 0..1. */
export interface GlamBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GlamGeometry {
  box: GlamBox;
  warp: GlamWarp;
  /** The face oval ring. */
  skin: GlamPoint[];
  /** Rings removed from the skin: two eyes, two brows, the mouth. */
  cutouts: GlamPoint[][];
  lips: GlamPoint[];
  lipsInner: GlamPoint[];
  /** Two spots; `r` in units of frame HEIGHT. */
  blush: { x: number; y: number; r: number }[];
  /** Two upper-lid bands (closed rings). */
  lids: GlamPoint[][];
}

/** A face oval shorter than this share of the frame height is not worth drawing on. */
const MIN_FACE_HEIGHT = 0.06;
/** The box is the face oval's bounding box grown by this share of its size on every side. */
const BOX_PAD = 0.25;
/** A box thinner than this (a face that is all but off the frame) cannot hold a map. */
const MIN_BOX_SIDE = 1e-3;
/**
 * The tracker reports points a little outside the frame for a face that is
 * partly out of view. Anything further out than a whole frame is garbage.
 */
const COORD_MIN = -1;
const COORD_MAX = 2;
/** Lengths below this are treated as zero when a direction is taken from them. */
const LENGTH_EPSILON = 1e-6;

const EYE_RADIUS_PER_EYE_WIDTH = 0.9;
const JAW_RADIUS_PER_FACE_WIDTH = 0.35;
const BLUSH_RADIUS_PER_FACE_WIDTH = 0.16;
// Radius limits, in frame heights. The floors keep a collapsed ring (a
// profile) from handing the shader a zero to divide by; the ceilings keep a
// face that fills the frame from warping the whole picture.
const EYE_RADIUS_MIN = 0.004;
const EYE_RADIUS_MAX = 0.3;
const JAW_RADIUS_MIN = 0.01;
const JAW_RADIUS_MAX = 0.5;
const BLUSH_RADIUS_MIN = 0.004;
const BLUSH_RADIUS_MAX = 0.3;

/** Every landmark index the geometry reads. */
const USED_INDICES: readonly number[] = [
  ...new Set([
    ...GLAM_RINGS.oval,
    ...GLAM_RINGS.eyes.flat(),
    ...GLAM_RINGS.brows.flat(),
    ...GLAM_RINGS.lipsOuter,
    ...GLAM_RINGS.lipsInner,
    ...GLAM_RINGS.lids.flat(),
    GLAM_POINTS.forehead,
    GLAM_POINTS.chin,
    ...GLAM_POINTS.faceSides,
    ...GLAM_POINTS.eyeCorners.flat(),
    ...GLAM_POINTS.cheeks,
    ...GLAM_POINTS.jaw,
  ]),
];

/**
 * undefined when the landmarks cannot be used: fewer than 478 points, a
 * non-finite or far out-of-frame coordinate among the points that are read,
 * a face oval shorter than 6% of the frame height, a face so far off the
 * frame that its box is empty, or an aspect that is not a positive number.
 * `aspect` = width / height of the video.
 */
export function glamGeometry(
  landmarks: readonly GlamPoint[],
  aspect: number,
): GlamGeometry | undefined {
  if (!Number.isFinite(aspect) || !(aspect > 0)) return undefined;
  if (landmarks.length < GLAM_LANDMARK_COUNT) return undefined;
  for (const index of USED_INDICES) {
    const point = landmarks[index];
    if (
      !point ||
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      point.x < COORD_MIN ||
      point.x > COORD_MAX ||
      point.y < COORD_MIN ||
      point.y > COORD_MAX
    ) {
      return undefined;
    }
  }

  const ring = (indices: readonly number[]): GlamPoint[] =>
    indices.map((index) => ({ x: landmarks[index].x, y: landmarks[index].y }));
  /** Distance between two landmarks in frame heights. */
  const distance = (a: number, b: number): number =>
    Math.hypot(
      (landmarks[a].x - landmarks[b].x) * aspect,
      landmarks[a].y - landmarks[b].y,
    );

  const skin = ring(GLAM_RINGS.oval);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of skin) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  if (maxY - minY < MIN_FACE_HEIGHT) return undefined;

  const x0 = clamp(minX - (maxX - minX) * BOX_PAD, 0, 1);
  const x1 = clamp(maxX + (maxX - minX) * BOX_PAD, 0, 1);
  const y0 = clamp(minY - (maxY - minY) * BOX_PAD, 0, 1);
  const y1 = clamp(maxY + (maxY - minY) * BOX_PAD, 0, 1);
  if (x1 - x0 < MIN_BOX_SIDE || y1 - y0 < MIN_BOX_SIDE) return undefined;
  const box: GlamBox = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };

  const faceWidth = distance(
    GLAM_POINTS.faceSides[0],
    GLAM_POINTS.faceSides[1],
  );

  const eye = (side: 0 | 1): GlamEye => {
    const points = ring(GLAM_RINGS.eyes[side]);
    let x = 0;
    let y = 0;
    for (const point of points) {
      x += point.x;
      y += point.y;
    }
    const [outer, inner] = GLAM_POINTS.eyeCorners[side];
    return {
      x: x / points.length,
      y: y / points.length,
      r: clamp(
        EYE_RADIUS_PER_EYE_WIDTH * distance(outer, inner),
        EYE_RADIUS_MIN,
        EYE_RADIUS_MAX,
      ),
    };
  };

  // The mid line in aspect-corrected space: a point on it and its direction.
  const top = landmarks[GLAM_POINTS.forehead];
  const chin = landmarks[GLAM_POINTS.chin];
  const axisX = (chin.x - top.x) * aspect;
  const axisY = chin.y - top.y;
  const axisLength = Math.hypot(axisX, axisY);
  const jawRadius = clamp(
    JAW_RADIUS_PER_FACE_WIDTH * faceWidth,
    JAW_RADIUS_MIN,
    JAW_RADIUS_MAX,
  );

  const push = (index: number): GlamPush => {
    const point = landmarks[index];
    let dx = 0;
    let dy = 0;
    if (axisLength > LENGTH_EPSILON) {
      const ux = axisX / axisLength;
      const uy = axisY / axisLength;
      const px = (point.x - top.x) * aspect;
      const py = point.y - top.y;
      // From the point to its foot on the mid line.
      const along = px * ux + py * uy;
      const toLineX = ux * along - px;
      const toLineY = uy * along - py;
      const length = Math.hypot(toLineX, toLineY);
      if (length > LENGTH_EPSILON) {
        dx = toLineX / length;
        dy = toLineY / length;
      }
    }
    return { x: point.x, y: point.y, dx, dy, r: jawRadius };
  };

  const blushRadius = clamp(
    BLUSH_RADIUS_PER_FACE_WIDTH * faceWidth,
    BLUSH_RADIUS_MIN,
    BLUSH_RADIUS_MAX,
  );

  return {
    box,
    warp: {
      eyes: [eye(0), eye(1)],
      jaw: [
        push(GLAM_POINTS.jaw[0]),
        push(GLAM_POINTS.jaw[1]),
        push(GLAM_POINTS.jaw[2]),
        push(GLAM_POINTS.jaw[3]),
      ],
    },
    skin,
    cutouts: [
      ring(GLAM_RINGS.eyes[0]),
      ring(GLAM_RINGS.eyes[1]),
      ring(GLAM_RINGS.brows[0]),
      ring(GLAM_RINGS.brows[1]),
      ring(GLAM_RINGS.lipsOuter),
    ],
    lips: ring(GLAM_RINGS.lipsOuter),
    lipsInner: ring(GLAM_RINGS.lipsInner),
    blush: GLAM_POINTS.cheeks.map((index) => ({
      x: landmarks[index].x,
      y: landmarks[index].y,
      r: blushRadius,
    })),
    lids: [ring(GLAM_RINGS.lids[0]), ring(GLAM_RINGS.lids[1])],
  };
}

// ---- Smoothing -------------------------------------------------------------

// One-euro filter settings. Coordinates are 0..1, so a speed is a share of
// the frame per second: the jitter of a still face is around 0.01, a turning
// head around 0.5.
/** Cutoff for a still point, in Hz. Lower holds a still face steadier. */
const SMOOTH_MIN_CUTOFF_HZ = 1.2;
/** How fast the cutoff opens with speed. Higher follows a moving face closer. */
const SMOOTH_BETA = 30;
/** Cutoff for the speed estimate itself, in Hz. */
const SMOOTH_SPEED_CUTOFF_HZ = 1;

/** The low-pass blend factor for a cutoff and a time step. */
const smoothingAlpha = (cutoffHz: number, dtS: number): number =>
  1 / (1 + 1 / (2 * Math.PI * cutoffHz * dtS));

/**
 * One-euro smoothing of the whole landmark set, one filter per coordinate.
 *
 * - The first set seeds the filters and is returned as it is. So is the
 *   first set after a gap longer than `GLAM_HOLD_MS` (the look had faded by
 *   then, and the old position says nothing about the new one), after a
 *   clock that stepped backwards, and after the number of points changed.
 * - A set with the same time as the last one changes nothing: the last
 *   result is returned.
 * - A non-finite time is not smoothed and does not touch the filters.
 * - A non-finite coordinate is passed through and does not touch its filter,
 *   so one bad point cannot poison the ones after it.
 *
 * The result is always a fresh array of fresh points.
 */
export class LandmarkSmoother {
  /** Smoothed values, x then y for each point. */
  #value = new Float64Array(0);
  /** Smoothed speeds, same layout. */
  #speed = new Float64Array(0);
  #lastMs: number | undefined;

  smooth(landmarks: readonly GlamPoint[], nowMs: number): GlamPoint[] {
    const raw = landmarks.map((point) => ({ x: point.x, y: point.y }));
    if (!Number.isFinite(nowMs)) return raw;

    const last = this.#lastMs;
    if (
      last === undefined ||
      nowMs < last ||
      nowMs - last > GLAM_HOLD_MS ||
      this.#value.length !== raw.length * 2
    ) {
      this.#value = new Float64Array(raw.length * 2);
      this.#speed = new Float64Array(raw.length * 2);
      for (let i = 0; i < raw.length; i++) {
        this.#value[2 * i] = raw[i].x;
        this.#value[2 * i + 1] = raw[i].y;
      }
      this.#lastMs = nowMs;
      return raw;
    }

    const dtS = (nowMs - last) / 1000;
    if (dtS > 0) {
      const speedAlpha = smoothingAlpha(SMOOTH_SPEED_CUTOFF_HZ, dtS);
      for (let i = 0; i < raw.length; i++) {
        this.#step(2 * i, raw[i].x, dtS, speedAlpha);
        this.#step(2 * i + 1, raw[i].y, dtS, speedAlpha);
      }
      this.#lastMs = nowMs;
    }
    return raw.map((point, i) => ({
      x: Number.isFinite(point.x) ? this.#value[2 * i] : point.x,
      y: Number.isFinite(point.y) ? this.#value[2 * i + 1] : point.y,
    }));
  }

  reset(): void {
    this.#value = new Float64Array(0);
    this.#speed = new Float64Array(0);
    this.#lastMs = undefined;
  }

  #step(slot: number, sample: number, dtS: number, speedAlpha: number): void {
    if (!Number.isFinite(sample)) return;
    const previous = this.#value[slot];
    // The filter was seeded from a bad point: start it here.
    if (!Number.isFinite(previous)) {
      this.#value[slot] = sample;
      this.#speed[slot] = 0;
      return;
    }
    const speed =
      this.#speed[slot] +
      speedAlpha * ((sample - previous) / dtS - this.#speed[slot]);
    const alpha = smoothingAlpha(
      SMOOTH_MIN_CUTOFF_HZ + SMOOTH_BETA * Math.abs(speed),
      dtS,
    );
    this.#speed[slot] = speed;
    this.#value[slot] = previous + alpha * (sample - previous);
  }
}

// ---- Cost ------------------------------------------------------------------

/** How many detects the rolling mean covers. */
const BUDGET_WINDOW = 30;
/** The slow cadence is left only when the mean falls back below this. */
const GLAM_FAST_MEAN_MS = 15;
/** Two detects further apart than this are not one stretch of watching. */
const DWELL_GAP_MS = 1000;

/**
 * Detect-time budget. Feed it the time every detect took.
 *
 * - Cadence: `every()` is `GLAM_DETECT_EVERY` until the mean of the last 30
 *   detects passes `GLAM_SLOW_MEAN_MS`, then `GLAM_DETECT_EVERY_SLOW` until
 *   the mean falls below 15 ms. The gap between the two keeps a device that
 *   sits near the line from flapping.
 * - Shed, any of: one detect over `GLAM_SHED_SINGLE_MS`; `GLAM_SHED_RUN`
 *   detects in a row over `GLAM_SHED_RUN_MS`; the mean over
 *   `GLAM_SHED_MEAN_MS` at every detect for `GLAM_SHED_DWELL_MS`, by the
 *   `nowMs` passed in.
 * - That wait counts time that was watched, not time that passed. No detect
 *   runs while the page is hidden or the publish gate is held, so two
 *   detects more than a second apart restart it: a slow mean before a
 *   minute in the background plus one detect after it is not a minute of
 *   slow tracking. A clock that stepped backwards restarts it too; a
 *   non-finite `nowMs` leaves it as it was.
 * - Warm-up: the first inference of a new tracker compiles and uploads, and
 *   can take longer than the single ceiling on a device that is fast
 *   afterwards. After `noteWarmup()` the next `GLAM_WARMUP_DETECTS` detects
 *   are not counted: they are in neither the mean, the run nor the stats,
 *   and the single ceiling does not apply to them. One of them over
 *   `GLAM_WARMUP_CEILING_MS` still sheds: the warm-up excuses a slow start,
 *   not a thread held for a second. A new budget does not warm up by
 *   itself: call `noteWarmup()` each time the tracker is created or
 *   re-created.
 * - Never re-arms once shed: nothing more is recorded, and only `reset()`
 *   (a new call) clears it.
 * - A non-finite or negative `ms` is ignored: no state changes at all, and
 *   it does not use up a warm-up detect.
 */
export class GlamBudget {
  readonly #window: number[] = [];
  #count = 0;
  #max = 0;
  #run = 0;
  #slow = false;
  #shed = false;
  /** Detects still to leave out after `noteWarmup()`. */
  #warmup = 0;
  /** When the mean last went over the shed line and has stayed there since. */
  #overSince: number | undefined;
  /** The time of the last counted detect that came with a usable clock. */
  #lastMs: number | undefined;

  /** The tracker was just created or re-created: its first detects do not count. */
  noteWarmup(): void {
    this.#warmup = GLAM_WARMUP_DETECTS;
  }

  noteDetect(ms: number, nowMs: number): void {
    if (this.#shed) return;
    if (!Number.isFinite(ms) || ms < 0) return;
    if (this.#warmup > 0) {
      this.#warmup -= 1;
      if (ms > GLAM_WARMUP_CEILING_MS) this.#shed = true;
      return;
    }

    const sinceLast = this.#lastMs === undefined ? 0 : nowMs - this.#lastMs;
    if (Number.isFinite(nowMs)) this.#lastMs = nowMs;

    this.#window.push(ms);
    if (this.#window.length > BUDGET_WINDOW) this.#window.shift();
    this.#count += 1;
    this.#max = Math.max(this.#max, ms);
    const mean = this.#mean();

    if (this.#slow) {
      if (mean < GLAM_FAST_MEAN_MS) this.#slow = false;
    } else if (mean > GLAM_SLOW_MEAN_MS) {
      this.#slow = true;
    }

    this.#run = ms > GLAM_SHED_RUN_MS ? this.#run + 1 : 0;
    if (ms > GLAM_SHED_SINGLE_MS || this.#run >= GLAM_SHED_RUN) {
      this.#shed = true;
      return;
    }

    if (!(mean > GLAM_SHED_MEAN_MS)) {
      this.#overSince = undefined;
      return;
    }
    if (!Number.isFinite(nowMs)) return;
    if (
      this.#overSince === undefined ||
      sinceLast < 0 ||
      sinceLast > DWELL_GAP_MS
    ) {
      this.#overSince = nowMs;
      return;
    }
    if (nowMs - this.#overSince >= GLAM_SHED_DWELL_MS) this.#shed = true;
  }

  /** `GLAM_DETECT_EVERY` or `GLAM_DETECT_EVERY_SLOW`. */
  every(): number {
    return this.#slow ? GLAM_DETECT_EVERY_SLOW : GLAM_DETECT_EVERY;
  }

  shed(): boolean {
    return this.#shed;
  }

  /** For the diagnostic line: rolling mean, the slowest detect, cadence, detects counted. */
  stats(): { mean: number; max: number; every: number; count: number } {
    return {
      mean: this.#mean(),
      max: this.#max,
      every: this.every(),
      count: this.#count,
    };
  }

  reset(): void {
    this.#window.length = 0;
    this.#count = 0;
    this.#max = 0;
    this.#run = 0;
    this.#slow = false;
    this.#shed = false;
    this.#warmup = 0;
    this.#overSince = undefined;
    this.#lastMs = undefined;
  }

  #mean(): number {
    if (this.#window.length === 0) return 0;
    let sum = 0;
    for (const ms of this.#window) sum += ms;
    return sum / this.#window.length;
  }
}

/**
 * Whether this frame may run a detect. Never while the page is hidden,
 * after a shed, while the publish gate is held, or when this task already
 * ran one. Otherwise yes on every `every`-th frame, and yes on any frame
 * once `msSinceDetect` (the time since the last detect ran) has reached
 * `GLAM_FORCE_DETECT_MS`: the cadence is counted in frames, and at a low
 * frame rate it alone would let the hold run out between two detects.
 *
 * A frame or cadence that is not a whole number (or a cadence below 1)
 * never matches the cadence, so only the time rule can answer yes for it.
 * A non-finite `msSinceDetect` (no detect has run yet, or the clock is
 * unusable) counts as long ago; a negative one (a clock that stepped
 * backwards) as just now.
 */
export function glamShouldDetect(a: {
  frame: number;
  every: number;
  hidden: boolean;
  shed: boolean;
  detectedThisTask: boolean;
  gateHeld: boolean;
  msSinceDetect: number;
}): boolean {
  if (a.hidden || a.shed || a.gateHeld || a.detectedThisTask) return false;
  const sinceDetect = Number.isFinite(a.msSinceDetect)
    ? Math.max(0, a.msSinceDetect)
    : Infinity;
  if (sinceDetect >= GLAM_FORCE_DETECT_MS) return true;
  if (!Number.isInteger(a.frame) || !Number.isInteger(a.every)) return false;
  if (a.every < 1) return false;
  return a.frame % a.every === 0;
}

/**
 * "At most one detect per frame task", kept in one place.
 *
 * - The frame callback calls `beginTask()` before anything else. One call
 *   of the callback is one task, so this is the only thing that makes a
 *   detect possible again.
 * - Whoever is about to run a detect calls `claim()` and runs it only on
 *   true. The first claim of a task wins; every later one in that task is
 *   refused, whoever asks and for whatever reason.
 * - `mayDetect` is `glamShouldDetect` with "this task already ran one"
 *   filled in from here. It does not claim: a yes is only a detect once
 *   `claim()` has said so too.
 *
 * The caller therefore has no flag of its own to forget to set or to pass
 * wrongly.
 */
export class GlamDetectLatch {
  #ran = false;
  /** Reused on every call of `mayDetect`. */
  readonly #question = {
    frame: 0,
    every: 0,
    hidden: false,
    shed: false,
    detectedThisTask: false,
    gateHeld: false,
    msSinceDetect: 0,
  };

  /** A new frame task: no detect has run in it. */
  beginTask(): void {
    this.#ran = false;
  }

  /** True once per task: the caller runs its detect only on true. */
  claim(): boolean {
    if (this.#ran) return false;
    this.#ran = true;
    return true;
  }

  /** Whether this task's detect has been claimed. */
  ran(): boolean {
    return this.#ran;
  }

  /** `glamShouldDetect` for this task; see it for the rules. */
  mayDetect(a: {
    frame: number;
    every: number;
    hidden: boolean;
    shed: boolean;
    gateHeld: boolean;
    msSinceDetect: number;
  }): boolean {
    const question = this.#question;
    question.frame = a.frame;
    question.every = a.every;
    question.hidden = a.hidden;
    question.shed = a.shed;
    question.detectedThisTask = this.#ran;
    question.gateHeld = a.gateHeld;
    question.msSinceDetect = a.msSinceDetect;
    return glamShouldDetect(question);
  }
}

/**
 * Whether the tracker may be created for the look right now. Creating it
 * blocks the thread for far longer than a detect, so the rules are the same
 * and stricter: only when the look is wanted, the page is visible, the
 * publish gate is not held, and the look was neither shed nor has failed.
 *
 * Asked twice for every load: before the load starts, and again right
 * before the tracker is created, because the files can take seconds to
 * arrive and the answer can have changed by then.
 */
export function glamMayCreateTracker(a: {
  wanted: boolean;
  gateHeld: boolean;
  hidden: boolean;
  shed: boolean;
  failed: boolean;
}): boolean {
  return a.wanted && !a.gateHeld && !a.hidden && !a.shed && !a.failed;
}

/**
 * Asked by a tracker load right before it creates the tracker: true means
 * do not create it now. The load ends without a tracker and without a
 * failure, and a later frame that may start a load starts the next one.
 *
 * - `stickers`: stickers or the masked touch up want the tracker now. They
 *   ask at any time, so such a load never waits.
 * - Otherwise the tracker would be created for the look alone, and that
 *   needs `glamMayCreateTracker`.
 * - `forGlam`: the look started this load. A load nobody wants any more
 *   waits when the look started it, so a look that was switched off, shed
 *   or failed while its files loaded never has a tracker created for it. A
 *   load that stickers started and nobody wants any more is not held back
 *   here: its tracker is the caller's to discard, as it is without the look.
 */
export function glamTrackerLoadMustWait(a: {
  stickers: boolean;
  forGlam: boolean;
  wanted: boolean;
  gateHeld: boolean;
  hidden: boolean;
  shed: boolean;
  failed: boolean;
}): boolean {
  if (a.stickers) return false;
  if (!a.wanted) return a.forGlam;
  return !glamMayCreateTracker(a);
}

// ---- Face lost and page hidden ---------------------------------------------

/**
 * 1 while landmarks are fresh (up to `GLAM_HOLD_MS` since the last hit),
 * then down in a straight line to 0 over `GLAM_FADE_MS`. A negative time (a
 * clock that stepped backwards) counts as fresh; a non-finite one as lost.
 */
export function glamPresence(msSinceSeen: number): number {
  if (!Number.isFinite(msSinceSeen)) return 0;
  if (msSinceSeen <= GLAM_HOLD_MS) return 1;
  return clamp(1 - (msSinceSeen - GLAM_HOLD_MS) / GLAM_FADE_MS, 0, 1);
}

/**
 * One re-create of the tracker when it died while the page was hidden (the
 * browser may drop a background page's graphics context).
 *
 * - No detect runs on a hidden page, so a tracker that died in the
 *   background usually throws on the first detect AFTER the page is back.
 *   A trip to the background therefore covers two stretches: from
 *   `noteHidden()` to `onVisible(nowMs)`, and the `GLAM_RECOVERY_GRACE_MS`
 *   that follow it. A failure in either earns the re-create. Any other
 *   failure on a visible page is the ordinary failed path and earns nothing.
 * - Whichever call learns of it first answers "recreate": `onVisible` for a
 *   failure noted while hidden, `noteFailure` for one inside the grace. A
 *   trip earns at most one.
 * - Until the outcome is reported with `noteRecreated`, both answer "none",
 *   so two re-creates never overlap. A failure in that time is dropped.
 * - `noteRecreated(true)` allows a later trip to the background to earn its
 *   own re-create. `noteRecreated(false)` ends it: no further re-create
 *   until `reset()` (a new call). With no re-create outstanding it does
 *   nothing, so a late report for a cancelled one costs nothing.
 * - `cancel()` is for when the tracker this was watching is gone for another
 *   reason (the look was turned off, the processor was rebuilt). It drops an
 *   outstanding re-create, and a failure or grace not yet acted on, without
 *   using up the allowance. Whether the page is hidden is kept.
 * - The grace needs a clock: a non-finite `nowMs` in `onVisible` opens none,
 *   and one in `noteFailure`, or one from before the page came back, is
 *   outside it.
 */
export class GlamRecovery {
  #hidden = false;
  #failedWhileHidden = false;
  /** When the page came back from a trip that has not earned a re-create yet. */
  #visibleAt: number | undefined;
  #pending = false;
  #spent = false;

  noteHidden(): void {
    this.#hidden = true;
  }

  noteFailure(nowMs: number): "recreate" | "none" {
    // While hidden the grace is not looked at: the failure waits for the
    // page, and `onVisible` then ends or replaces whatever grace was open.
    if (this.#hidden) {
      this.#failedWhileHidden = true;
      return "none";
    }
    if (this.#visibleAt === undefined) return "none";
    const sinceVisible = nowMs - this.#visibleAt;
    // Written so that a NaN (either time was unusable) is outside the grace.
    if (!(sinceVisible >= 0 && sinceVisible <= GLAM_RECOVERY_GRACE_MS)) {
      return "none";
    }
    return this.#claim();
  }

  onVisible(nowMs: number): "recreate" | "none" {
    const wasHidden = this.#hidden;
    const failed = this.#failedWhileHidden;
    this.#hidden = false;
    this.#failedWhileHidden = false;
    if (failed) return this.#claim();
    if (wasHidden) this.#visibleAt = nowMs;
    return "none";
  }

  noteRecreated(ok: boolean): void {
    if (!this.#pending) return;
    this.#pending = false;
    if (!ok) this.#spent = true;
  }

  cancel(): void {
    this.#failedWhileHidden = false;
    this.#visibleAt = undefined;
    this.#pending = false;
  }

  reset(): void {
    this.#hidden = false;
    this.#failedWhileHidden = false;
    this.#visibleAt = undefined;
    this.#pending = false;
    this.#spent = false;
  }

  /** This trip's one chance, used whether or not it is granted. */
  #claim(): "recreate" | "none" {
    this.#visibleAt = undefined;
    if (this.#pending || this.#spent) return "none";
    this.#pending = true;
    return "recreate";
  }
}

// ---- Tracker files: reading the answers of the file check ------------------

/** What one request of the tracker-file check came back with. */
export interface GlamProbeAnswer {
  /**
   * There was no response to read: the request failed or was stopped, or
   * its body could not be read. The other fields mean nothing then.
   */
  threw: boolean;
  status: number;
  /** The `content-type` header as sent, null when there was none. */
  contentType: string | null;
  /** The `content-length` header as sent, null when there was none. */
  contentLength: string | null;
  /** The `content-range` header as sent, null when there was none. */
  contentRange: string | null;
  /** How many bytes of the body were actually received (0 for a HEAD). */
  bodyBytes: number;
}

/**
 * Whether one tracker file is in this build. "unknown" is "nothing settled
 * it": it may be asked again later and must never be kept as an answer.
 */
export type GlamProbeVerdict = "present" | "missing" | "unknown";

/** The answer of a request that got no response. */
export const GLAM_PROBE_NO_ANSWER: GlamProbeAnswer = Object.freeze({
  threw: true,
  status: 0,
  contentType: null,
  contentLength: null,
  contentRange: null,
  bodyBytes: 0,
});

/**
 * An app shell that answers every unknown path with its start page would
 * otherwise pass for the file.
 */
function glamProbeIsHtml(a: GlamProbeAnswer): boolean {
  return (a.contentType ?? "").toLowerCase().includes("text/html");
}

/**
 * The whole size a `content-range` header states (`bytes 0-0/1234` is
 * 1234). 0 when there is no header, no size (`bytes 0-0/*`), or a size that
 * is not a positive whole number (`bytes 0-0/-1`, `bytes 0-0/0`).
 */
export function glamContentRangeTotal(header: string | null): number {
  const stated = /\/\s*(\d+)\s*$/.exec(header ?? "");
  if (!stated) return 0;
  const total = Number(stated[1]);
  return Number.isFinite(total) && total > 0 ? total : 0;
}

/**
 * Whether the HEAD request left the question open, so that a ranged GET has
 * to be sent: it got no response, or the server does not do HEAD (405, 501).
 * `undefined` is "no HEAD was sent". Every other answer to a HEAD is final
 * and no GET may overrule it.
 */
export function glamProbeNeedsRange(
  head: GlamProbeAnswer | undefined,
): boolean {
  return !head || head.threw || head.status === 405 || head.status === 501;
}

/** What a HEAD the server answered says about the file. */
function glamHeadVerdict(head: GlamProbeAnswer): GlamProbeVerdict {
  // A server in trouble says nothing about the file, whatever page it sent.
  if (head.status >= 500) return "unknown";
  if (head.status >= 400) return "missing";
  // Anything else that is not a success (also a status that is no number).
  if (!(head.status >= 200 && head.status < 300)) return "unknown";
  if (glamProbeIsHtml(head)) return "missing";
  // A stated length of zero is an empty file, which the tracker cannot use.
  // No stated length is the normal case for a local file server.
  if (head.contentLength !== null && /^\s*0+\s*$/.test(head.contentLength)) {
    return "missing";
  }
  return "present";
}

/**
 * What a GET for the first byte says about the file. The status alone is
 * never enough: the phone app's local file server starts every ranged
 * answer at 206 and sends a missing file as 206 with nothing in it.
 */
function glamRangeVerdict(range: GlamProbeAnswer): GlamProbeVerdict {
  if (range.threw) return "unknown";
  if (range.status >= 500) return "unknown";
  if (range.status >= 400) return "missing";
  if (range.status !== 200 && range.status !== 206) return "unknown";
  if (glamProbeIsHtml(range)) return "missing";
  const total = glamContentRangeTotal(range.contentRange);
  if (total > 0 || range.bodyBytes > 0) return "present";
  return "missing";
}

/**
 * Whether one tracker file is there, from what its requests came back with.
 * `head` is the HEAD request and `range` the GET for the first byte
 * (`Range: bytes=0-0`); `undefined` is "not sent".
 *
 * A HEAD the server answered is final and `range` is not looked at: a
 * success that is not an HTML page is "present" (unless it states a length
 * of zero), any 4xx or an HTML page is "missing", a 5xx is "unknown". Only
 * when `glamProbeNeedsRange(head)` does `range` decide: "present" needs a
 * 200 or 206 that is not an HTML page AND proof there is something in the
 * file (a `content-range` size above zero, or a body byte received). A 200
 * or 206 with neither is "missing", so is any 4xx; no response, a 5xx and
 * anything else are "unknown".
 */
export function glamProbeVerdict(
  head: GlamProbeAnswer | undefined,
  range: GlamProbeAnswer | undefined,
): GlamProbeVerdict {
  if (head && !glamProbeNeedsRange(head)) return glamHeadVerdict(head);
  if (!range) return "unknown";
  return glamRangeVerdict(range);
}

/**
 * The files together, one verdict each. One missing file settles it
 * ("missing"), whatever the others say. Otherwise every file has to be
 * there for "present". No files at all is "unknown".
 */
export function glamProbeCapability(
  files: readonly GlamProbeVerdict[],
): GlamProbeVerdict {
  if (files.includes("missing")) return "missing";
  if (files.length > 0 && files.every((file) => file === "present")) {
    return "present";
  }
  return "unknown";
}

// ---- Failure text: what the hidden readout says went wrong -----------------

/** The longest failure text kept, in characters. */
export const GLAM_FAILURE_TEXT_MAX = 140;

/** The tracker library ends its errors with where in its source they arose. */
const TRACKER_SOURCE_TRACE = "=== Source Location Trace";

/** What a thrown value says, before it is shortened. */
function glamRawFailureText(error: unknown): string {
  if (typeof error === "string") return error;
  // Compiled C++ throws bare numbers.
  if (typeof error === "number") return `number ${error}`;
  if (typeof error !== "object" || error === null) return String(error);
  const said = error as {
    name?: unknown;
    message?: unknown;
    type?: unknown;
    target?: unknown;
  };
  if (typeof said.message === "string" && said.message) {
    return typeof said.name === "string" && said.name && said.name !== "Error"
      ? `${said.name}: ${said.message}`
      : said.message;
  }
  // A script or an image that could not be loaded rejects with the DOM
  // event, which has no message: say what kind it was and what it was for.
  if (typeof said.type === "string" && said.type) {
    const target = (said.target ?? {}) as {
      tagName?: unknown;
      src?: unknown;
      href?: unknown;
    };
    const tag =
      typeof target.tagName === "string" && target.tagName
        ? `${target.tagName.toLowerCase()} `
        : "";
    const from =
      typeof target.src === "string" && target.src
        ? target.src
        : typeof target.href === "string" && target.href
          ? target.href
          : "";
    return `${tag}${said.type} event${from ? ` ${from}` : ""}`;
  }
  if (typeof said.name === "string" && said.name) return said.name;
  return String(error);
}

/**
 * Anything that was thrown, as one short line for the readout: the message
 * (with the error's name when it has one of its own), on one line, without
 * the tracker library's source trace, and without double quotes, since the
 * readout puts the text in a pair of them. Never longer than `max`: a longer
 * text keeps its start and its end, because the tracker's errors open with
 * a long node name and say what happened last. Never throws and never
 * returns an empty text.
 */
export function glamFailureText(
  error: unknown,
  max = GLAM_FAILURE_TEXT_MAX,
): string {
  let text: string;
  try {
    text = glamRawFailureText(error);
  } catch {
    text = "an error that could not be read";
  }
  const trace = text.indexOf(TRACKER_SOURCE_TRACE);
  if (trace !== -1) text = text.slice(0, trace);
  text = text.replace(/\s+/g, " ").replaceAll('"', "'").trim();
  if (!text) text = "no message";
  const limit = Number.isFinite(max) && max >= 8 ? Math.floor(max) : 8;
  if (text.length <= limit) return text;
  const head = Math.floor((limit - 1) * 0.4);
  const tail = limit - 1 - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/**
 * The steps of a tracker load that are told apart when one fails: fetching
 * the library, working out which of its files to use, and creating the
 * tracker on the CPU. (A GPU try that fails is not an error of the load: the
 * CPU try follows it.)
 */
export type GlamLoadSite = "import" | "fileset" | "cpu";

/** What a step of a tracker load failed with, and which step it was. */
export class GlamLoadError extends Error {
  site: GlamLoadSite;
  /** What the step threw or rejected with, as it came. */
  reason: unknown;

  constructor(site: GlamLoadSite, reason: unknown) {
    super(`face tracker ${site}: ${glamFailureText(reason)}`);
    this.name = "GlamLoadError";
    this.site = site;
    this.reason = reason;
  }
}

/**
 * For the `.catch()` of one step of a tracker load: throws what the step
 * rejected with again, with the step's name on it. The load fails exactly
 * as it would without this.
 */
export function glamLoadFailedAt(
  site: GlamLoadSite,
): (reason: unknown) => never {
  return (reason) => {
    throw new GlamLoadError(site, reason);
  };
}

/**
 * Why a tracker load ended with no tracker, for the readout. `gpuError` is
 * what the GPU try failed with ("" when it did not fail or was not made):
 *
 *   tracker: import "<text>"
 *   tracker: fileset "<text>"
 *   tracker: gpu "<text>" | cpu "<text>"
 *   tracker: gpu not tried | cpu "<text>"
 *   tracker: load "<text>"          (a failure with no step named on it)
 */
export function glamTrackerFailure(error: unknown, gpuError: string): string {
  const gpu = gpuError ? `gpu "${gpuError}"` : "";
  if (error instanceof GlamLoadError) {
    const text = glamFailureText(error.reason);
    if (error.site !== "cpu") return `tracker: ${error.site} "${text}"`;
    return `tracker: ${gpu || "gpu not tried"} | cpu "${text}"`;
  }
  return `tracker: ${gpu ? `${gpu} | ` : ""}load "${glamFailureText(error)}"`;
}

/**
 * What the tracker runs on, for the readout. A GPU try that failed is said
 * even when the CPU one then worked: `CPU (gpu: "<text>")`.
 */
export function glamDelegateText(
  delegate: "GPU" | "CPU" | "none",
  gpuError: string,
): string {
  return gpuError ? `${delegate} (gpu: "${gpuError}")` : delegate;
}

/**
 * The browser engine and its version out of a user agent, for the readout:
 * `Chrome/142.0.7444.102`, with ` wv` after it for an Android System
 * WebView (which marks itself `; wv)`). Safari only states `Version/`.
 */
export function glamBrowserToken(userAgent: unknown): string {
  const ua = typeof userAgent === "string" ? userAgent : "";
  const engine =
    /(?:Chrome|CriOS|Firefox|FxiOS)\/[\d.]+/.exec(ua) ??
    /Version\/[\d.]+/.exec(ua);
  if (!engine) return "browser unknown";
  return /;\s*wv\)/.test(ua) ? `${engine[0]} wv` : engine[0];
}

/** Where the tracker-file check stands, as the controller holds it. */
export interface GlamProbeFacts {
  /** This kind of app has to look for the files at all. */
  needed: boolean;
  reachable: boolean;
  missing: boolean;
  /** A check is in flight. */
  checking: boolean;
  /** A check got no answer and the next one has to wait. */
  noAnswer: boolean;
}

/** The tracker-file check in one or two words, for the readout. */
export function glamProbeText(facts: GlamProbeFacts): string {
  if (!facts.needed) return "not needed";
  if (facts.reachable) return "present";
  if (facts.missing) return "missing";
  if (facts.checking) return "checking";
  return facts.noAnswer ? "no answer" : "not asked";
}

/**
 * How the frame loop of one face pipeline is doing, for the readout. The
 * frame rates beside it only say "0" when no frame is drawn; this says
 * which of the reasons for that it is.
 */
export interface FrameHealth {
  /** Counts the pipelines built since the app was loaded; this one's number. */
  processor: number;
  /** How long ago this pipeline was built, in ms. */
  upMs: number;
  /** What calls the frames: none means nothing is scheduled. */
  driver: "rvfc" | "raf" | "timer" | "none";
  /** Frames drawn to the end since the build. */
  frames: number;
  /** Frames that began and never reached their end: each one threw. */
  unfinished: number;
  /** How long ago the last frame was drawn, in ms; -1 before the first. */
  frameAgeMs: number;
  /** Why a frame asked for now would draw nothing; "" when it would draw. */
  idle: string;
}

function seconds(ms: number): string {
  return `${(Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000).toFixed(1)}s`;
}

/** `FrameHealth` as one part of the readout. */
export function frameHealthText(health: FrameHealth): string {
  const parts = [
    `proc #${health.processor} up ${seconds(health.upMs)}`,
    `driver ${health.driver}`,
    health.frameAgeMs < 0
      ? `frames ${health.frames} (none yet)`
      : `frames ${health.frames} (last ${seconds(health.frameAgeMs)} ago)`,
  ];
  if (health.unfinished > 0) parts.push(`${health.unfinished} FRAME(S) THREW`);
  if (health.idle) parts.push(`idle: ${health.idle}`);
  return parts.join(" · ");
}
