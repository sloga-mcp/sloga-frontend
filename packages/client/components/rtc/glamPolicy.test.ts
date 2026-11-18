// Unit spec for the Glam policy (levels, face geometry, smoothing, cost).
//   node --test --conditions=browser components/rtc/glamPolicy.test.ts
// Focus: the amounts stay under their caps and rise evenly; the geometry is
// finite and bounded for any pose and any aspect ratio, and says "no" to
// landmarks it cannot use; a still face is held still and a moving one is
// followed; the budget slows the cadence before it sheds, sheds on each of
// its three rules, never re-arms, leaves a new tracker's first detects out
// (but not one that holds the thread for over a second) and does not count
// time it was not watching; no detect runs on a hidden page, under a held
// gate, after a shed or twice in one task, and a low frame rate cannot
// starve the tracker; the latch gives a frame task one detect whoever asks;
// the tracker is created for the look only on a visible page with the gate
// empty, and that is asked again when its files are in; the look fades out
// after the hold;
// a tracker that died in the background is re-created at most once per
// trip, also when its death is only seen just after the page is back;
// a tracker file is called present only on an answer that proves it, missing
// on one that settles it, and unknown otherwise.
// These rules live in a dependency-free module precisely so they are
// reachable by `node --test`; the WebGL stage, the mask painter and the
// tracker wiring are live-only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { FACE_OVAL, LANDMARK, MASK_CUTOUTS } from "./faceFilterCatalog.ts";
import {
  type GlamGeometry,
  type GlamLevels,
  type GlamPoint,
  type GlamProbeAnswer,
  GLAM_DETECT_EVERY,
  GLAM_DETECT_EVERY_SLOW,
  GLAM_FADE_MS,
  GLAM_FORCE_DETECT_MS,
  GLAM_HOLD_MS,
  GLAM_LANDMARK_COUNT,
  GLAM_MAP_HEIGHT,
  GLAM_MAP_WIDTH,
  GLAM_POINTS,
  GLAM_PROBE_NO_ANSWER,
  GLAM_RECOVERY_GRACE_MS,
  GLAM_RINGS,
  GLAM_SHED_DWELL_MS,
  GLAM_SHED_MEAN_MS,
  GLAM_SHED_RUN,
  GLAM_SHED_RUN_MS,
  GLAM_SHED_SINGLE_MS,
  GLAM_SLOW_MEAN_MS,
  GLAM_SWITCH_STRENGTH,
  GLAM_WARMUP_CEILING_MS,
  GLAM_WARMUP_DETECTS,
  GlamBudget,
  GlamDetectLatch,
  GlamRecovery,
  LandmarkSmoother,
  glamContentRangeTotal,
  glamGeometry,
  glamLevels,
  glamMayCreateTracker,
  glamPresence,
  glamProbeCapability,
  glamProbeNeedsRange,
  glamProbeVerdict,
  glamShouldDetect,
  glamTrackerLoadMustWait,
} from "./glamPolicy.ts";

const EPS = 1e-9;

const close = (actual: number, expected: number, message?: string) =>
  assert.ok(
    Math.abs(actual - expected) <= EPS,
    `${message ?? "value"}: expected ${expected}, got ${actual}`,
  );

// ---- Constants and index tables --------------------------------------------

test("the contract constants", () => {
  assert.equal(GLAM_SWITCH_STRENGTH, 60);
  assert.equal(GLAM_HOLD_MS, 250);
  assert.equal(GLAM_FADE_MS, 200);
  assert.equal(GLAM_DETECT_EVERY, 2);
  assert.equal(GLAM_DETECT_EVERY_SLOW, 3);
  assert.equal(GLAM_SLOW_MEAN_MS, 20);
  assert.equal(GLAM_SHED_MEAN_MS, 35);
  assert.equal(GLAM_SHED_DWELL_MS, 5000);
  assert.equal(GLAM_SHED_SINGLE_MS, 150);
  assert.equal(GLAM_SHED_RUN_MS, 60);
  assert.equal(GLAM_SHED_RUN, 3);
  assert.equal(GLAM_MAP_WIDTH, 512);
  assert.equal(GLAM_MAP_HEIGHT, 256);
  assert.equal(GLAM_LANDMARK_COUNT, 478);
  assert.equal(GLAM_FORCE_DETECT_MS, 100);
  assert.equal(GLAM_WARMUP_DETECTS, 2);
  assert.equal(GLAM_RECOVERY_GRACE_MS, 2000);
  // The orderings the budget relies on: slow down before shedding, and a
  // run of slow detects is caught before one very slow one.
  assert.ok(GLAM_DETECT_EVERY < GLAM_DETECT_EVERY_SLOW);
  assert.ok(GLAM_SLOW_MEAN_MS < GLAM_SHED_MEAN_MS);
  assert.ok(GLAM_SHED_MEAN_MS < GLAM_SHED_RUN_MS);
  assert.ok(GLAM_SHED_RUN_MS < GLAM_SHED_SINGLE_MS);
  // A forced detect has to come before the hold runs out.
  assert.ok(GLAM_FORCE_DETECT_MS < GLAM_HOLD_MS);
});

// ---- What the comments promise the shader lane -----------------------------

// The warp direction is a convention between this module and a shader that
// cannot be loaded here. The only place it is written down is the comments,
// and a wrong sign there builds a look that widens the face and shrinks the
// eyes, so the wording is pinned.
const POLICY_SOURCE = readFileSync(
  new URL("./glamPolicy.ts", import.meta.url),
  "utf8",
);

/** The doc comment in front of a declaration, as one line of plain text. */
function docBefore(declaration: string): string {
  const at = POLICY_SOURCE.indexOf(declaration);
  assert.ok(at > 0, `${declaration} is declared`);
  const from = POLICY_SOURCE.lastIndexOf("/**", at);
  const to = POLICY_SOURCE.indexOf("*/", from);
  assert.ok(from >= 0 && to > from && to < at, `${declaration} has a comment`);
  assert.equal(
    POLICY_SOURCE.slice(to + 2, at).trim(),
    "",
    `the comment sits directly on ${declaration}`,
  );
  return POLICY_SOURCE.slice(from, to)
    .replace(/^\s*\/?\*+ ?/gm, "")
    .replace(/\s+/g, " ");
}

test("comments: the push direction is where the picture content moves", () => {
  const doc = docBefore("export interface GlamPush");
  assert.match(doc, /direction the PICTURE CONTENT moves/);
  assert.match(doc, /must sample at `uv - move`/);
  assert.match(doc, /`move = \(dx \* d \/ aspect, dy \* d\)`/);
  // The wrong sign is named only as the thing that goes wrong.
  assert.match(doc, /Sampling at `uv \+ move` widens the face/);
});

test("comments: the eye magnify samples closer to the eye centre", () => {
  const doc = docBefore("export interface GlamEye");
  assert.match(doc, /content moves AWAY from the centre/);
  assert.match(doc, /samples CLOSER to the eye centre/);
});

test("comments: the header does not promise clamped ring points", () => {
  const header = POLICY_SOURCE.slice(0, POLICY_SOURCE.indexOf("*/")).replace(
    /\s*\n \*\s*/g,
    " ",
  );
  assert.doesNotMatch(header, /finite and clamped/);
  assert.match(header, /Ring points and centres are NOT clamped/);
  assert.match(header, /only bounded/);
  assert.match(header, /\(-1\.\.2\)/);
});

const ALL_RINGS: ReadonlyArray<readonly [string, readonly number[]]> = [
  ["oval", GLAM_RINGS.oval],
  ["eye 0", GLAM_RINGS.eyes[0]],
  ["eye 1", GLAM_RINGS.eyes[1]],
  ["brow 0", GLAM_RINGS.brows[0]],
  ["brow 1", GLAM_RINGS.brows[1]],
  ["lips outer", GLAM_RINGS.lipsOuter],
  ["lips inner", GLAM_RINGS.lipsInner],
  ["lid 0", GLAM_RINGS.lids[0]],
  ["lid 1", GLAM_RINGS.lids[1]],
];

const ALL_POINTS: readonly number[] = [
  GLAM_POINTS.forehead,
  GLAM_POINTS.chin,
  ...GLAM_POINTS.faceSides,
  ...GLAM_POINTS.eyeCorners.flat(),
  ...GLAM_POINTS.cheeks,
  ...GLAM_POINTS.jaw,
];

test("tables: every ring is a real ring of valid, distinct indices", () => {
  for (const [name, ring] of ALL_RINGS) {
    assert.ok(ring.length >= 3, `${name} has at least three points`);
    assert.equal(new Set(ring).size, ring.length, `${name} has no repeats`);
    for (const index of ring) {
      assert.ok(Number.isInteger(index), `${name}: ${index} is an integer`);
      assert.ok(
        index >= 0 && index < GLAM_LANDMARK_COUNT,
        `${name}: ${index} is in range`,
      );
    }
  }
  for (const index of ALL_POINTS) {
    assert.ok(Number.isInteger(index));
    assert.ok(index >= 0 && index < GLAM_LANDMARK_COUNT, `${index} in range`);
  }
  assert.equal(new Set(GLAM_POINTS.jaw).size, 4, "four different jaw points");
});

test("tables: the two sides of the face never share an index", () => {
  for (const pair of [GLAM_RINGS.eyes, GLAM_RINGS.brows, GLAM_RINGS.lids]) {
    assert.equal(pair[0].length, pair[1].length, "same shape on both sides");
    const first = new Set(pair[0]);
    assert.ok(pair[1].every((index) => !first.has(index)));
  }
  // The lid band starts on the lash line of its own eye and adds a row
  // that is not part of the eye ring.
  for (const side of [0, 1] as const) {
    const eye = new Set(GLAM_RINGS.eyes[side]);
    const lid = GLAM_RINGS.lids[side];
    const onLashLine = lid.filter((index) => eye.has(index));
    assert.equal(onLashLine.length, lid.length / 2, `lid ${side} lash half`);
    for (const corner of GLAM_POINTS.eyeCorners[side]) {
      assert.ok(eye.has(corner), `corner ${corner} is on eye ${side}`);
    }
  }
  const inner = new Set(GLAM_RINGS.lipsInner);
  assert.ok(GLAM_RINGS.lipsOuter.every((index) => !inner.has(index)));
});

test("tables: agree with the rings the sticker catalog already uses", () => {
  assert.deepEqual(GLAM_RINGS.oval, FACE_OVAL);
  assert.equal(GLAM_POINTS.forehead, LANDMARK.FOREHEAD);
  assert.equal(GLAM_POINTS.chin, LANDMARK.CHIN);
  // The catalog's coarse eye and mouth cutouts are subsets of the full rings.
  const [eyeA, eyeB, mouth] = MASK_CUTOUTS;
  assert.ok(eyeA.every((index) => GLAM_RINGS.eyes[0].includes(index)));
  assert.ok(eyeB.every((index) => GLAM_RINGS.eyes[1].includes(index)));
  assert.ok(mouth.every((index) => GLAM_RINGS.lipsOuter.includes(index)));
  // Everything measured on the outline is a point of the outline.
  for (const index of [...GLAM_POINTS.faceSides, ...GLAM_POINTS.jaw]) {
    assert.ok(FACE_OVAL.includes(index), `${index} is on the face oval`);
  }
  // Two jaw points on each side of the chin, mirror images of each other.
  const at = (index: number) => FACE_OVAL.indexOf(index);
  const chinAt = at(GLAM_POINTS.chin);
  const [a, b, c, d] = GLAM_POINTS.jaw;
  assert.ok(at(a) > chinAt && at(b) > chinAt, "first pair after the chin");
  assert.ok(at(c) < chinAt && at(d) < chinAt, "second pair before the chin");
  assert.equal(at(a) - chinAt, chinAt - at(c), "cheek points mirror");
  assert.equal(at(b) - chinAt, chinAt - at(d), "jaw points mirror");
  const [sideA, sideB] = GLAM_POINTS.faceSides;
  assert.equal(at(sideA) - chinAt, chinAt - at(sideB), "sides mirror");
});

// ---- glamLevels ------------------------------------------------------------

const LEVEL_CAPS: GlamLevels = {
  smooth: 0.75,
  lips: 0.45,
  blush: 0.3,
  lid: 0.35,
  eye: 0.12,
  slim: 0.06,
  warm: 0.08,
};
const LEVEL_KEYS = Object.keys(LEVEL_CAPS) as Array<keyof GlamLevels>;

test("glamLevels: all 0 at 0, under the caps at 100, something of each", () => {
  const off = glamLevels(0);
  const full = glamLevels(100);
  assert.deepEqual(Object.keys(full).sort(), [...LEVEL_KEYS].sort());
  for (const key of LEVEL_KEYS) {
    assert.equal(off[key], 0, `${key} at 0`);
    assert.ok(full[key] > 0, `${key} does something at 100`);
    assert.ok(full[key] <= LEVEL_CAPS[key], `${key} cap`);
  }
});

test("glamLevels: never falls as the setting rises", () => {
  let previous = glamLevels(0);
  for (let setting = 1; setting <= 100; setting++) {
    const levels = glamLevels(setting);
    for (const key of LEVEL_KEYS) {
      assert.ok(levels[key] > previous[key], `${key} rises at ${setting}`);
    }
    previous = levels;
  }
});

test("glamLevels: the switch value gives about 60% of full", () => {
  const full = glamLevels(100);
  const switched = glamLevels(GLAM_SWITCH_STRENGTH);
  for (const key of LEVEL_KEYS) {
    const share = switched[key] / full[key];
    assert.ok(share > 0.5 && share < 0.7, `${key}: ${share}`);
  }
});

test("glamLevels: clamps out-of-range and treats non-finite as off", () => {
  assert.deepEqual(glamLevels(250), glamLevels(100));
  assert.deepEqual(glamLevels(-40), glamLevels(0));
  for (const bad of [NaN, Infinity, -Infinity]) {
    const levels = glamLevels(bad);
    for (const key of LEVEL_KEYS) assert.equal(levels[key], 0, `${key}`);
  }
});

// ---- glamGeometry ----------------------------------------------------------

/** Half the face width over half the face height, in the synthetic face. */
const FACE_WIDTH_RATIO = 0.76;
/** Eye ring half-width, in half face widths. */
const EYE_HALF_WIDTH = 0.2;

interface FaceSpec {
  aspect: number;
  /** Face centre in video UV. */
  cx?: number;
  cy?: number;
  /** Forehead to chin, in frame heights. */
  height?: number;
  /** Multiplies the face width: near 0 is a head turned to a profile. */
  widthScale?: number;
  /** Head roll in radians. */
  roll?: number;
}

/**
 * A plausible 478-point face: the oval is an ellipse with landmark 10 at the
 * top and the chin at the bottom, and every other ring is a small ellipse
 * where that feature sits. The landmark-33 side is the low-x side. Points no
 * table reads sit at the face centre.
 */
function syntheticFace(spec: FaceSpec): GlamPoint[] {
  const { aspect, cx = 0.5, cy = 0.5, height = 0.5 } = spec;
  const halfH = height / 2;
  const halfW = halfH * FACE_WIDTH_RATIO * (spec.widthScale ?? 1);
  const cos = Math.cos(spec.roll ?? 0);
  const sin = Math.sin(spec.roll ?? 0);
  const points: GlamPoint[] = Array.from(
    { length: GLAM_LANDMARK_COUNT },
    () => ({ x: cx, y: cy }),
  );
  /** Place a landmark at (u, v) in face units: -1..1 across and down. */
  const place = (index: number, u: number, v: number) => {
    const px = u * halfW;
    const py = v * halfH;
    points[index] = {
      x: cx + (px * cos - py * sin) / aspect,
      y: cy + px * sin + py * cos,
    };
  };
  /** A ring that starts on the outer side and runs along the bottom first. */
  const ellipse = (
    ring: readonly number[],
    side: -1 | 1,
    cu: number,
    cv: number,
    ru: number,
    rv: number,
  ) =>
    ring.forEach((index, k) => {
      const angle = (2 * Math.PI * k) / ring.length;
      place(index, cu + side * ru * Math.cos(angle), cv + rv * Math.sin(angle));
    });

  GLAM_RINGS.oval.forEach((index, k) => {
    const angle = (2 * Math.PI * k) / GLAM_RINGS.oval.length;
    place(index, Math.sin(angle), -Math.cos(angle));
  });
  for (const side of [0, 1] as const) {
    const sign = side === 0 ? -1 : 1;
    ellipse(GLAM_RINGS.brows[side], sign, sign * 0.42, -0.45, 0.24, 0.04);
    // The lid band first: half of it is the lash line, which the eye ring
    // then puts where it belongs.
    ellipse(GLAM_RINGS.lids[side], sign, sign * 0.42, -0.31, 0.2, 0.04);
    ellipse(
      GLAM_RINGS.eyes[side],
      sign,
      sign * 0.42,
      -0.25,
      EYE_HALF_WIDTH,
      0.07,
    );
    place(GLAM_POINTS.cheeks[side], sign * 0.5, 0.2);
  }
  ellipse(GLAM_RINGS.lipsOuter, -1, 0, 0.5, 0.3, 0.1);
  ellipse(GLAM_RINGS.lipsInner, -1, 0, 0.5, 0.22, 0.03);
  return points;
}

/** Every number anywhere in the geometry. */
function numbersOf(value: unknown, into: number[] = []): number[] {
  if (typeof value === "number") into.push(value);
  else if (Array.isArray(value)) value.forEach((item) => numbersOf(item, into));
  else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => numbersOf(item, into));
  }
  return into;
}

/** The bounds that hold for any usable input. */
function assertBounded(geometry: GlamGeometry, label: string) {
  for (const value of numbersOf(geometry)) {
    assert.ok(Number.isFinite(value), `${label}: finite, got ${value}`);
    assert.ok(Math.abs(value) <= 2, `${label}: bounded, got ${value}`);
  }
  const { box, warp } = geometry;
  assert.ok(box.x >= 0 && box.y >= 0, `${label}: box starts in the frame`);
  assert.ok(box.w > 0 && box.h > 0, `${label}: box is not empty`);
  assert.ok(box.x + box.w <= 1 + EPS, `${label}: box ends in the frame (x)`);
  assert.ok(box.y + box.h <= 1 + EPS, `${label}: box ends in the frame (y)`);
  for (const eye of warp.eyes) {
    assert.ok(eye.r > 0 && eye.r <= 0.3, `${label}: eye radius ${eye.r}`);
  }
  for (const push of warp.jaw) {
    assert.ok(push.r > 0 && push.r <= 0.5, `${label}: jaw radius ${push.r}`);
    const length = Math.hypot(push.dx, push.dy);
    assert.ok(
      Math.abs(length - 1) <= 1e-6 || length === 0,
      `${label}: direction is a unit vector or nothing, got ${length}`,
    );
  }
  for (const spot of geometry.blush) {
    assert.ok(spot.r > 0 && spot.r <= 0.3, `${label}: blush radius ${spot.r}`);
  }
}

const usable = (spec: FaceSpec): GlamGeometry => {
  const geometry = glamGeometry(syntheticFace(spec), spec.aspect);
  assert.ok(geometry, `usable: ${JSON.stringify(spec)}`);
  return geometry;
};

const ASPECTS: ReadonlyArray<readonly [string, number]> = [
  ["16:9", 16 / 9],
  ["4:3", 4 / 3],
  ["9:16", 9 / 16],
];

test("glamGeometry: the rings come back in the shape the painter expects", () => {
  const landmarks = syntheticFace({ aspect: 16 / 9 });
  const geometry = usable({ aspect: 16 / 9 });
  const ring = (indices: readonly number[]) =>
    indices.map((index) => landmarks[index]);
  assert.deepEqual(geometry.skin, ring(GLAM_RINGS.oval));
  assert.deepEqual(geometry.cutouts, [
    ring(GLAM_RINGS.eyes[0]),
    ring(GLAM_RINGS.eyes[1]),
    ring(GLAM_RINGS.brows[0]),
    ring(GLAM_RINGS.brows[1]),
    ring(GLAM_RINGS.lipsOuter),
  ]);
  assert.deepEqual(geometry.lips, ring(GLAM_RINGS.lipsOuter));
  assert.deepEqual(geometry.lipsInner, ring(GLAM_RINGS.lipsInner));
  assert.deepEqual(geometry.lids, [
    ring(GLAM_RINGS.lids[0]),
    ring(GLAM_RINGS.lids[1]),
  ]);
  assert.equal(geometry.blush.length, 2);
  // Fresh points: the caller may keep the geometry after the landmarks move.
  assert.notEqual(geometry.skin[0], landmarks[GLAM_RINGS.oval[0]]);
});

for (const [name, aspect] of ASPECTS) {
  test(`glamGeometry ${name}: radii are in frame heights`, () => {
    const height = 0.4;
    const geometry = usable({ aspect, height });
    assertBounded(geometry, name);
    const halfW = (height / 2) * FACE_WIDTH_RATIO;
    // The same face has the same radii on every frame shape.
    const eyeWidth = 2 * EYE_HALF_WIDTH * halfW;
    for (const eye of geometry.warp.eyes) {
      close(eye.r, 0.9 * eyeWidth, "eye radius");
    }
    // The widest oval points sit 10 degrees off the horizontal.
    const faceWidth = 2 * halfW * Math.sin((80 * Math.PI) / 180);
    for (const push of geometry.warp.jaw) {
      close(push.r, 0.35 * faceWidth, "jaw radius");
    }
    assert.equal(geometry.blush[0].r, geometry.blush[1].r);
    assert.ok(geometry.blush[0].r > 0.1 * faceWidth);
    assert.ok(geometry.blush[0].r < 0.25 * faceWidth);
  });

  test(`glamGeometry ${name}: eyes and cheeks sit where the face has them`, () => {
    const height = 0.4;
    const geometry = usable({ aspect, height });
    const halfW = (height / 2) * FACE_WIDTH_RATIO;
    const [eyeA, eyeB] = geometry.warp.eyes;
    close(eyeA.x, 0.5 - (0.42 * halfW) / aspect, "eye 0 x");
    close(eyeB.x, 0.5 + (0.42 * halfW) / aspect, "eye 1 x");
    close(eyeA.y, 0.5 - 0.25 * (height / 2), "eye 0 y");
    close(eyeB.y, eyeA.y, "eyes level");
    close(geometry.blush[0].x, 0.5 - (0.5 * halfW) / aspect, "cheek 0 x");
    close(geometry.blush[1].x, 0.5 + (0.5 * halfW) / aspect, "cheek 1 x");
    close(geometry.blush[0].y, 0.5 + 0.2 * (height / 2), "cheek y");
  });

  test(`glamGeometry ${name}: the jaw is pushed toward the mid line`, () => {
    const geometry = usable({ aspect, height: 0.4 });
    const [a, b, c, d] = geometry.warp.jaw;
    // An upright face: the mid line is vertical, so the push is level.
    for (const push of [a, b]) {
      close(push.dx, 1, "low-x side moves right");
      close(push.dy, 0, "level");
      assert.ok(push.x < 0.5);
    }
    for (const push of [c, d]) {
      close(push.dx, -1, "high-x side moves left");
      close(push.dy, 0, "level");
      assert.ok(push.x > 0.5);
    }
    // Below the eyes, above the chin; the jaw point lower than the cheek one.
    assert.ok(a.y > 0.5 && b.y > a.y && d.y > c.y);
    close(a.y, c.y, "cheek points level");
    close(b.y, d.y, "jaw points level");
  });

  test(`glamGeometry ${name}: a rolled head keeps unit pushes that point inward`, () => {
    for (const roll of [-1.2, -0.5, 0.4, 1.1, Math.PI / 2]) {
      const geometry = usable({ aspect, height: 0.4, roll });
      assertBounded(geometry, `${name} roll ${roll}`);
      for (const push of geometry.warp.jaw) {
        close(Math.hypot(push.dx, push.dy), 1, "unit direction");
        // Toward the face centre, measured in frame heights.
        const inward =
          (0.5 - push.x) * aspect * push.dx + (0.5 - push.y) * push.dy;
        assert.ok(inward > 0, `roll ${roll}: points inward`);
        // Square to the mid line, which is the rolled vertical.
        close(
          push.dx * -Math.sin(roll) + push.dy * Math.cos(roll),
          0,
          "square to the mid line",
        );
      }
      // Rolling the head does not change the size of anything.
      close(
        geometry.warp.eyes[0].r,
        usable({ aspect, height: 0.4 }).warp.eyes[0].r,
      );
    }
  });

  test(`glamGeometry ${name}: the box is the padded face oval, clamped`, () => {
    const height = 0.4;
    const { box } = usable({ aspect, height });
    const halfW = ((height / 2) * FACE_WIDTH_RATIO) / aspect;
    const left = Math.max(0, 0.5 - 1.5 * halfW);
    const right = Math.min(1, 0.5 + 1.5 * halfW);
    close(box.x, left, "box x");
    close(box.w, right - left, "box w");
    close(box.y, 0.5 - 1.5 * (height / 2), "box y");
    close(box.h, 3 * (height / 2), "box h");
  });

  test(`glamGeometry ${name}: bounded at the frame edge and for a huge face`, () => {
    const specs: FaceSpec[] = [
      { aspect, cx: 0.01, cy: 0.02 },
      { aspect, cx: 0.99, cy: 0.98 },
      { aspect, cx: -0.1, cy: 0.5 },
      { aspect, cx: 0.5, cy: 1.15 },
      { aspect, height: 1.9 },
      { aspect, height: 1.4, cx: 0.7, cy: 0.1, roll: 0.7 },
    ];
    for (const spec of specs) {
      const geometry = usable(spec);
      assertBounded(geometry, `${name} ${JSON.stringify(spec)}`);
    }
    // A face that fills the frame gets the whole frame as its box.
    assert.deepEqual(usable({ aspect, height: 1.9 }).box, {
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    });
  });

  test(`glamGeometry ${name}: a profile gives small, finite numbers`, () => {
    for (const widthScale of [0.2, 0.02, 1e-4, 0]) {
      const geometry = glamGeometry(
        syntheticFace({ aspect, widthScale }),
        aspect,
      );
      // Flat enough and there is no box to paint into, which is a "no".
      if (!geometry) {
        assert.ok(widthScale < 0.02, `scale ${widthScale} should be usable`);
        continue;
      }
      assertBounded(geometry, `${name} width ${widthScale}`);
    }
    assert.equal(
      glamGeometry(syntheticFace({ aspect, widthScale: 0 }), aspect),
      undefined,
    );
  });
}

test("glamGeometry: a rolled head on a very tall or very wide frame still pushes inward", () => {
  // Far from square, a mid line measured in UV instead of frame heights
  // leans enough to put a jaw point on its wrong side.
  for (const aspect of [1 / 4, 4]) {
    for (const roll of [-0.7, 0.7]) {
      const geometry = usable({ aspect, height: 0.4, roll });
      assertBounded(geometry, `aspect ${aspect} roll ${roll}`);
      for (const push of geometry.warp.jaw) {
        const inward =
          (0.5 - push.x) * aspect * push.dx + (0.5 - push.y) * push.dy;
        assert.ok(inward > 0, `aspect ${aspect} roll ${roll}: points inward`);
      }
    }
  }
});

test("glamGeometry: a point on the mid line is not pushed anywhere", () => {
  const aspect = 16 / 9;
  const landmarks = syntheticFace({ aspect });
  const [cheekPoint] = GLAM_POINTS.jaw;
  // Put one jaw point exactly on the forehead-to-chin line.
  landmarks[cheekPoint] = { x: 0.5, y: 0.6 };
  const onLine = glamGeometry(landmarks, aspect);
  assert.ok(onLine);
  assert.equal(onLine.warp.jaw[0].dx, 0);
  assert.equal(onLine.warp.jaw[0].dy, 0);
  assert.ok(onLine.warp.jaw[0].r > 0, "the radius is still not zero");
  close(Math.hypot(onLine.warp.jaw[1].dx, onLine.warp.jaw[1].dy), 1);

  // Forehead and chin on one spot: there is no mid line at all.
  const noLine = syntheticFace({ aspect });
  noLine[GLAM_POINTS.chin] = { ...noLine[GLAM_POINTS.forehead] };
  const geometry = glamGeometry(noLine, aspect);
  assert.ok(geometry);
  assertBounded(geometry, "no mid line");
  for (const push of geometry.warp.jaw) {
    assert.equal(push.dx, 0);
    assert.equal(push.dy, 0);
  }
});

test("glamGeometry: too few points is a no", () => {
  const landmarks = syntheticFace({ aspect: 16 / 9 });
  assert.equal(glamGeometry([], 16 / 9), undefined);
  assert.equal(glamGeometry(landmarks.slice(0, 468), 16 / 9), undefined);
  assert.equal(glamGeometry(landmarks.slice(0, 477), 16 / 9), undefined);
  assert.ok(glamGeometry(landmarks.slice(0, 478), 16 / 9));
});

test("glamGeometry: a bad coordinate on any point it reads is a no", () => {
  const used = new Set([
    ...ALL_RINGS.flatMap(([, ring]) => ring),
    ...ALL_POINTS,
  ]);
  for (const index of used) {
    for (const bad of [NaN, Infinity, -Infinity, 40, -40]) {
      for (const axis of ["x", "y"] as const) {
        const landmarks = syntheticFace({ aspect: 4 / 3 });
        landmarks[index] = { ...landmarks[index], [axis]: bad };
        assert.equal(
          glamGeometry(landmarks, 4 / 3),
          undefined,
          `landmark ${index} ${axis} = ${bad}`,
        );
      }
    }
  }
  // A point nothing reads may be anything.
  const unused = Array.from(
    { length: GLAM_LANDMARK_COUNT },
    (_, index) => index,
  ).find((index) => !used.has(index));
  assert.ok(unused !== undefined);
  const landmarks = syntheticFace({ aspect: 4 / 3 });
  landmarks[unused] = { x: NaN, y: NaN };
  assert.ok(glamGeometry(landmarks, 4 / 3));
});

test("glamGeometry: a face under 6% of the frame height is a no", () => {
  for (const [, aspect] of ASPECTS) {
    assert.equal(
      glamGeometry(syntheticFace({ aspect, height: 0.05 }), aspect),
      undefined,
    );
    assert.equal(
      glamGeometry(syntheticFace({ aspect, height: 0.059 }), aspect),
      undefined,
    );
    const small = glamGeometry(syntheticFace({ aspect, height: 0.07 }), aspect);
    assert.ok(small, "7% is enough");
    assertBounded(small, "small face");
  }
});

test("glamGeometry: an unusable aspect is a no", () => {
  const landmarks = syntheticFace({ aspect: 16 / 9 });
  for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
    assert.equal(glamGeometry(landmarks, bad), undefined, `aspect ${bad}`);
  }
  // A silly but real aspect still gives clamped numbers.
  for (const odd of [1e-6, 1e6]) {
    const geometry = glamGeometry(landmarks, odd);
    assert.ok(geometry);
    assertBounded(geometry, `aspect ${odd}`);
  }
});

test("glamGeometry: ring points and centres are bounded, not clamped", () => {
  // What the header says, shown: a face half out of the frame keeps its
  // points where the tracker put them, and only the box is pulled in.
  const aspect = 16 / 9;
  const landmarks = syntheticFace({ aspect, cx: -0.05, cy: 1.1 });
  const geometry = glamGeometry(landmarks, aspect);
  assert.ok(geometry);
  assertBounded(geometry, "half out of the frame");
  assert.deepEqual(
    geometry.skin,
    GLAM_RINGS.oval.map((index) => landmarks[index]),
  );
  assert.ok(geometry.skin.some((point) => point.x < 0));
  assert.ok(geometry.skin.some((point) => point.y > 1));
  assert.ok(geometry.warp.eyes[0].x < 0, "an eye centre outside the frame");
  assert.ok(geometry.blush.some((spot) => spot.y > 1));
  assert.ok(geometry.box.x >= 0 && geometry.box.y + geometry.box.h <= 1 + EPS);
});

// ---- LandmarkSmoother ------------------------------------------------------

/** A landmark set where every point has the same coordinates. */
const flat = (x: number, y: number, count = 4): GlamPoint[] =>
  Array.from({ length: count }, () => ({ x, y }));

/** A normal detect interval: every second frame at 30 fps. */
const DETECT_MS = 66;

test("LandmarkSmoother: the first set is returned as it is, as fresh points", () => {
  const smoother = new LandmarkSmoother();
  const input = syntheticFace({ aspect: 16 / 9 });
  const output = smoother.smooth(input, 1000);
  assert.deepEqual(output, input);
  assert.notEqual(output, input);
  assert.notEqual(output[0], input[0]);
  assert.deepEqual(smoother.smooth([], 1010), []);
});

test("LandmarkSmoother: a constant input stays exactly where it is", () => {
  const smoother = new LandmarkSmoother();
  let now = 0;
  for (let i = 0; i < 60; i++) {
    now += DETECT_MS;
    for (const point of smoother.smooth(flat(0.3, 0.7), now)) {
      assert.equal(point.x, 0.3);
      assert.equal(point.y, 0.7);
    }
  }
});

test("LandmarkSmoother: jitter is reduced", () => {
  const smoother = new LandmarkSmoother();
  const jitter = 0.002;
  let now = 0;
  let low = Infinity;
  let high = -Infinity;
  for (let i = 0; i < 80; i++) {
    now += DETECT_MS;
    const offset = i % 2 === 0 ? jitter : -jitter;
    const [point] = smoother.smooth(flat(0.5 + offset, 0.5 - offset), now);
    assert.ok(
      Math.abs(point.x - 0.5) <= jitter + EPS,
      "never outside the input",
    );
    if (i >= 40) {
      low = Math.min(low, point.x);
      high = Math.max(high, point.x);
    }
  }
  assert.ok(high - low < jitter, `swing ${high - low} under half the input`);
  assert.ok(high - low > 0, "it is a filter, not a freeze");
});

test("LandmarkSmoother: a step is followed quickly and without overshoot", () => {
  const smoother = new LandmarkSmoother();
  let now = 0;
  for (let i = 0; i < 20; i++) {
    now += DETECT_MS;
    smoother.smooth(flat(0.3, 0.3), now);
  }
  let previous = 0.3;
  let last = 0.3;
  for (let i = 0; i < 6; i++) {
    now += DETECT_MS;
    const [point] = smoother.smooth(flat(0.6, 0.3), now);
    assert.ok(point.x >= previous, "moves toward the new place");
    assert.ok(point.x <= 0.6 + EPS, "no overshoot");
    assert.equal(point.y, 0.3, "the other axis does not move");
    if (i === 0) assert.ok(point.x > 0.45, `first step ${point.x}`);
    previous = point.x;
    last = point.x;
  }
  assert.ok(Math.abs(last - 0.6) < 0.005, `settled at ${last}`);
});

test("LandmarkSmoother: a gap longer than the hold starts over", () => {
  const smoother = new LandmarkSmoother();
  smoother.smooth(flat(0.2, 0.2), 1000);
  // At the hold exactly the old position still counts.
  const [held] = smoother.smooth(flat(0.8, 0.8), 1000 + GLAM_HOLD_MS);
  assert.ok(held.x > 0.2 && held.x < 0.8, `smoothed, got ${held.x}`);

  const fresh = new LandmarkSmoother();
  fresh.smooth(flat(0.2, 0.2), 1000);
  const [jumped] = fresh.smooth(flat(0.8, 0.8), 1000 + GLAM_HOLD_MS + 1);
  assert.deepEqual(jumped, { x: 0.8, y: 0.8 });
  // And the filter carries on from there, not from before the gap.
  const [after] = fresh.smooth(flat(0.8, 0.8), 1000 + GLAM_HOLD_MS + 60);
  assert.deepEqual(after, { x: 0.8, y: 0.8 });
});

test("LandmarkSmoother: reset() and a changed point count start over", () => {
  const smoother = new LandmarkSmoother();
  smoother.smooth(flat(0.2, 0.2), 1000);
  smoother.reset();
  assert.deepEqual(smoother.smooth(flat(0.8, 0.8), 1050), flat(0.8, 0.8));

  assert.deepEqual(smoother.smooth(flat(0.1, 0.1, 7), 1100), flat(0.1, 0.1, 7));
  const [next] = smoother.smooth(flat(0.4, 0.4, 7), 1150);
  assert.ok(next.x > 0.1 && next.x < 0.4, "smoothing again");
});

test("LandmarkSmoother: odd clocks do no harm", () => {
  const smoother = new LandmarkSmoother();
  smoother.smooth(flat(0.2, 0.2), 1000);
  const [moved] = smoother.smooth(flat(0.4, 0.4), 1050);
  // The same time again: the last result, whatever is passed.
  assert.deepEqual(smoother.smooth(flat(0.9, 0.9), 1050)[0], moved);
  // A non-finite time: the input back, and the filter untouched.
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.deepEqual(smoother.smooth(flat(0.9, 0.9), bad), flat(0.9, 0.9));
  }
  assert.deepEqual(smoother.smooth(flat(0.9, 0.9), 1050)[0], moved);
  // A clock that stepped backwards starts over.
  assert.deepEqual(smoother.smooth(flat(0.7, 0.7), 900), flat(0.7, 0.7));
});

test("LandmarkSmoother: one bad coordinate does not poison the filter", () => {
  const smoother = new LandmarkSmoother();
  smoother.smooth(flat(0.2, 0.2, 2), 1000);
  const bad = smoother.smooth(
    [
      { x: NaN, y: 0.2 },
      { x: 0.2, y: 0.2 },
    ],
    1050,
  );
  assert.ok(Number.isNaN(bad[0].x), "passed through");
  assert.equal(bad[0].y, 0.2);
  assert.deepEqual(bad[1], { x: 0.2, y: 0.2 });
  assert.deepEqual(smoother.smooth(flat(0.2, 0.2, 2), 1100), flat(0.2, 0.2, 2));

  // Seeded from a bad point: the first good value takes its place.
  const seeded = new LandmarkSmoother();
  seeded.smooth([{ x: NaN, y: 0.5 }], 1000);
  assert.deepEqual(seeded.smooth([{ x: 0.3, y: 0.5 }], 1050), [
    { x: 0.3, y: 0.5 },
  ]);
  const [next] = seeded.smooth([{ x: 0.4, y: 0.5 }], 1100);
  assert.ok(next.x > 0.3 && next.x <= 0.4);
});

// ---- GlamBudget ------------------------------------------------------------

/** The private "fast again" line, restated. */
const FAST_MEAN_MS = 15;
/** The private rolling window, restated: detects. */
const WINDOW = 30;
/** The private gap that ends a stretch of watching, restated. */
const WATCH_GAP_MS = 1000;

/** Note `count` detects of `ms`, `stepMs` apart, after `fromMs`; returns the end time. */
function detects(
  budget: GlamBudget,
  ms: number,
  count: number,
  fromMs: number,
  stepMs = 100,
): number {
  let now = fromMs;
  for (let i = 0; i < count; i++) {
    now += stepMs;
    budget.noteDetect(ms, now);
  }
  return now;
}

test("GlamBudget: starts at the normal cadence, not shed, with empty stats", () => {
  const budget = new GlamBudget();
  assert.equal(budget.every(), GLAM_DETECT_EVERY);
  assert.equal(budget.shed(), false);
  assert.deepEqual(budget.stats(), {
    mean: 0,
    max: 0,
    every: GLAM_DETECT_EVERY,
    count: 0,
  });
});

test("GlamBudget: stats report the rolling mean, the slowest detect and the count", () => {
  const budget = new GlamBudget();
  budget.noteDetect(4, 100);
  budget.noteDetect(8, 200);
  budget.noteDetect(6, 300);
  assert.deepEqual(budget.stats(), {
    mean: 6,
    max: 8,
    every: GLAM_DETECT_EVERY,
    count: 3,
  });
  // The mean covers the last 30 detects only; the max and count cover all.
  detects(budget, 2, WINDOW, 300);
  assert.deepEqual(budget.stats(), {
    mean: 2,
    max: 8,
    every: GLAM_DETECT_EVERY,
    count: 3 + WINDOW,
  });
});

test("GlamBudget: one detect over the single ceiling sheds at once", () => {
  const at = new GlamBudget();
  at.noteDetect(GLAM_SHED_SINGLE_MS, 100);
  assert.equal(at.shed(), false, "the ceiling itself is allowed");

  const over = new GlamBudget();
  detects(over, 5, 20, 0);
  over.noteDetect(GLAM_SHED_SINGLE_MS + 1, 5000);
  assert.equal(over.shed(), true);
});

test("GlamBudget: a run of slow detects sheds at once, a broken run does not", () => {
  const slow = GLAM_SHED_RUN_MS + 1;
  const run = new GlamBudget();
  detects(run, 5, 20, 0);
  run.noteDetect(slow, 2100);
  run.noteDetect(slow, 2200);
  assert.equal(run.shed(), false, "two is not a run");
  run.noteDetect(slow, 2300);
  assert.equal(run.shed(), true);

  const broken = new GlamBudget();
  detects(broken, 5, 20, 0);
  for (let i = 0; i < 6; i++) {
    broken.noteDetect(slow, 3000 + i * 300);
    broken.noteDetect(slow, 3100 + i * 300);
    broken.noteDetect(5, 3200 + i * 300);
  }
  assert.equal(broken.shed(), false, "a fast detect ends the run");

  const atLine = new GlamBudget();
  detects(atLine, 1, 27, 0);
  for (let i = 0; i < GLAM_SHED_RUN + 2; i++) {
    atLine.noteDetect(GLAM_SHED_RUN_MS, 3000 + i * 100);
  }
  assert.equal(atLine.shed(), false, "the line itself is allowed");
});

test("GlamBudget: a mean over the shed line for the whole dwell sheds", () => {
  const ms = GLAM_SHED_MEAN_MS + 5;
  assert.ok(ms < GLAM_SHED_RUN_MS, "this is the mean rule, not the run rule");
  const budget = new GlamBudget();
  // The wait starts at the first detect, at 100.
  let now = detects(budget, ms, 1, 0);
  while (now + 100 < 100 + GLAM_SHED_DWELL_MS) {
    now = detects(budget, ms, 1, now);
    assert.equal(budget.shed(), false, `not yet at ${now}`);
  }
  detects(budget, ms, 1, now);
  assert.equal(budget.shed(), true);

  // It is the clock that counts, not how many detects there were.
  const many = new GlamBudget();
  detects(many, ms, 500, 0, 1);
  assert.equal(many.shed(), false, "500 detects in half a second");
  // Detects a full second apart still make one stretch of watching.
  const few = new GlamBudget();
  detects(few, ms, GLAM_SHED_DWELL_MS / WATCH_GAP_MS, 0, WATCH_GAP_MS);
  assert.equal(few.shed(), false, "one second short of the dwell");
  detects(few, ms, 1, GLAM_SHED_DWELL_MS, WATCH_GAP_MS);
  assert.equal(few.shed(), true, "six detects, each a second apart");

  // At the line exactly is not over it.
  const atLine = new GlamBudget();
  detects(atLine, GLAM_SHED_MEAN_MS, 200, 0);
  assert.equal(atLine.shed(), false);
});

test("GlamBudget: the dwell counts time watched, not time passed", () => {
  const ms = GLAM_SHED_MEAN_MS + 5;
  // Two detects a dwell apart say nothing about the time between them.
  const apart = new GlamBudget();
  apart.noteDetect(ms, 1000);
  apart.noteDetect(ms, 1000 + GLAM_SHED_DWELL_MS);
  assert.equal(apart.shed(), false, "two detects a dwell apart");

  // Slow for four seconds, a minute in the background, then one detect.
  const hidden = new GlamBudget();
  let now = detects(hidden, ms, 40, 0);
  assert.equal(hidden.shed(), false);
  const back = now + 60_000;
  hidden.noteDetect(ms, back);
  assert.equal(hidden.shed(), false, "the minute away was not watched");
  // The wait starts over at the first detect after the gap: a full dwell.
  now = back;
  while (now + 100 < back + GLAM_SHED_DWELL_MS) {
    now = detects(hidden, ms, 1, now);
    assert.equal(hidden.shed(), false, `not yet at ${now}`);
  }
  detects(hidden, ms, 1, now);
  assert.equal(hidden.shed(), true, "still slow a whole dwell after it");

  // Just over a second between detects, for ever: never one stretch.
  const sparse = new GlamBudget();
  detects(sparse, ms, 200, 0, WATCH_GAP_MS + 1);
  assert.equal(sparse.shed(), false, "200 detects, each 1001 ms apart");
  assert.ok(sparse.stats().mean > GLAM_SHED_MEAN_MS, "and it was slow");
});

test("GlamBudget: a dip under the shed line restarts the dwell", () => {
  const ms = GLAM_SHED_MEAN_MS + 5;
  const budget = new GlamBudget();
  let now = detects(budget, ms, 40, 0);
  // Fast detects until the mean is back under the line.
  while (budget.stats().mean > GLAM_SHED_MEAN_MS) {
    now = detects(budget, 0, 1, now);
  }
  // Slow again: the wait starts when the mean next crosses the line.
  let crossedAt: number | undefined;
  while (crossedAt === undefined) {
    now = detects(budget, ms, 1, now);
    if (budget.stats().mean > GLAM_SHED_MEAN_MS) crossedAt = now;
  }
  assert.ok(crossedAt > 100 + GLAM_SHED_DWELL_MS, "past the first deadline");
  assert.equal(budget.shed(), false, "the first wait was cancelled");
  while (now + 100 < crossedAt + GLAM_SHED_DWELL_MS) {
    now = detects(budget, ms, 1, now);
    assert.equal(budget.shed(), false, `not yet at ${now}`);
  }
  detects(budget, ms, 1, now);
  assert.equal(budget.shed(), true);
});

test("GlamBudget: a clock that steps backwards restarts the dwell", () => {
  const ms = GLAM_SHED_MEAN_MS + 5;
  const budget = new GlamBudget();
  // Slow from 6000 to 10000, then the clock jumps back to 9500: still after
  // the wait began, but before the last detect.
  detects(budget, ms, 5, 5000, WATCH_GAP_MS);
  budget.noteDetect(ms, 9500);
  let now = detects(budget, ms, 4, 9500, WATCH_GAP_MS);
  assert.equal(now, 13_500);
  assert.equal(budget.shed(), false, "the wait from 6000 was dropped");
  // The new wait began at 9500.
  now = detects(budget, ms, 1, now, 9500 + GLAM_SHED_DWELL_MS - 1 - now);
  assert.equal(budget.shed(), false);
  budget.noteDetect(ms, 9500 + GLAM_SHED_DWELL_MS);
  assert.equal(budget.shed(), true);
});

test("GlamBudget: a slow mean drops to every third frame, with hysteresis", () => {
  const budget = new GlamBudget();
  let now = detects(budget, GLAM_SLOW_MEAN_MS, WINDOW, 0);
  assert.equal(budget.every(), GLAM_DETECT_EVERY, "at the line is not over");
  now = detects(budget, GLAM_SLOW_MEAN_MS + 5, 6, now);
  assert.ok(budget.stats().mean > GLAM_SLOW_MEAN_MS);
  assert.equal(budget.every(), GLAM_DETECT_EVERY_SLOW);
  assert.equal(budget.stats().every, GLAM_DETECT_EVERY_SLOW);

  // Back between the two lines: stays slow.
  now = detects(budget, (GLAM_SLOW_MEAN_MS + FAST_MEAN_MS) / 2, WINDOW, now);
  close(budget.stats().mean, (GLAM_SLOW_MEAN_MS + FAST_MEAN_MS) / 2);
  assert.equal(budget.every(), GLAM_DETECT_EVERY_SLOW);
  now = detects(budget, FAST_MEAN_MS, WINDOW, now);
  assert.equal(budget.every(), GLAM_DETECT_EVERY_SLOW, "at the line stays");

  // Under the lower line: normal again.
  now = detects(budget, FAST_MEAN_MS - 3, 6, now);
  assert.ok(budget.stats().mean < FAST_MEAN_MS);
  assert.equal(budget.every(), GLAM_DETECT_EVERY);
  // And between the lines from below stays normal.
  detects(budget, (GLAM_SLOW_MEAN_MS + FAST_MEAN_MS) / 2, WINDOW, now);
  assert.equal(budget.every(), GLAM_DETECT_EVERY);
  assert.equal(budget.shed(), false, "slowing down is not a shed");
});

test("GlamBudget: never re-arms once shed", () => {
  const budget = new GlamBudget();
  detects(budget, 5, 10, 0);
  budget.noteDetect(GLAM_SHED_SINGLE_MS + 50, 1100);
  assert.equal(budget.shed(), true);
  const frozen = budget.stats();
  // An hour of fast detects changes nothing, and nothing more is recorded.
  detects(budget, 1, 3600, 1100, 1000);
  assert.equal(budget.shed(), true);
  assert.deepEqual(budget.stats(), frozen);
  assert.equal(frozen.max, GLAM_SHED_SINGLE_MS + 50);
  assert.equal(frozen.count, 11);
});

test("GlamBudget: reset() clears everything, the shed included", () => {
  const budget = new GlamBudget();
  detects(budget, GLAM_SLOW_MEAN_MS + 10, 10, 0);
  budget.noteDetect(GLAM_SHED_SINGLE_MS + 1, 1100);
  assert.equal(budget.shed(), true);
  assert.equal(budget.every(), GLAM_DETECT_EVERY_SLOW);
  budget.reset();
  assert.equal(budget.shed(), false);
  assert.deepEqual(budget.stats(), {
    mean: 0,
    max: 0,
    every: GLAM_DETECT_EVERY,
    count: 0,
  });
  // No half run or half dwell is carried over.
  const slow = GLAM_SHED_RUN_MS + 1;
  const carried = new GlamBudget();
  carried.noteDetect(slow, 100);
  carried.noteDetect(slow, 200);
  carried.reset();
  carried.noteDetect(slow, 300);
  assert.equal(carried.shed(), false);
  const dwell = new GlamBudget();
  const end = detects(dwell, GLAM_SHED_MEAN_MS + 5, 49, 0);
  assert.equal(end, GLAM_SHED_DWELL_MS - 100);
  dwell.reset();
  // Without the reset these two would end a dwell that began at 100.
  detects(dwell, GLAM_SHED_MEAN_MS + 5, 2, end);
  assert.equal(dwell.shed(), false);
  // Nor is a warm-up that was asked for but not used up.
  const warm = new GlamBudget();
  warm.noteWarmup();
  warm.reset();
  warm.noteDetect(7, 100);
  assert.equal(warm.stats().count, 1);
});

test("GlamBudget: a non-finite or negative detect time is ignored", () => {
  const budget = new GlamBudget();
  detects(budget, 10, 5, 0);
  const before = budget.stats();
  for (const bad of [NaN, Infinity, -Infinity, -1, -1e9]) {
    budget.noteDetect(bad, 600);
    assert.deepEqual(budget.stats(), before, `ms ${bad}`);
    assert.equal(budget.shed(), false, `ms ${bad}`);
  }
  // An ignored sample does not break a run either.
  const slow = GLAM_SHED_RUN_MS + 1;
  budget.noteDetect(slow, 700);
  budget.noteDetect(slow, 800);
  budget.noteDetect(NaN, 850);
  budget.noteDetect(slow, 900);
  assert.equal(budget.shed(), true);
});

test("GlamBudget: a non-finite clock still counts the detect", () => {
  const ms = GLAM_SHED_MEAN_MS + 5;
  const budget = new GlamBudget();
  budget.noteDetect(ms, 1000);
  // No time information: the dwell neither advances nor restarts, and the
  // detect is not taken for the end of a gap or the start of one.
  for (const bad of [NaN, Infinity, -Infinity]) budget.noteDetect(ms, bad);
  assert.equal(budget.shed(), false);
  assert.equal(budget.stats().count, 4);
  let now = 1000;
  while (now + WATCH_GAP_MS < 1000 + GLAM_SHED_DWELL_MS) {
    now = detects(budget, ms, 1, now, WATCH_GAP_MS);
    budget.noteDetect(ms, NaN);
    assert.equal(budget.shed(), false, `not yet at ${now}`);
  }
  budget.noteDetect(ms, 1000 + GLAM_SHED_DWELL_MS);
  assert.equal(budget.shed(), true);

  const single = new GlamBudget();
  single.noteDetect(GLAM_SHED_SINGLE_MS + 1, NaN);
  assert.equal(single.shed(), true, "the ceilings need no clock");
});

const EMPTY_STATS = { mean: 0, max: 0, every: GLAM_DETECT_EVERY, count: 0 };

test("GlamBudget: after noteWarmup() the next detects are not counted at all", () => {
  const budget = new GlamBudget();
  budget.noteWarmup();
  // A new tracker's first inferences: far over the single ceiling, and as
  // slow as a warm-up detect may be.
  assert.ok(GLAM_WARMUP_CEILING_MS > GLAM_SHED_SINGLE_MS * 2);
  for (let i = 0; i < GLAM_WARMUP_DETECTS; i++) {
    budget.noteDetect(GLAM_WARMUP_CEILING_MS, 100 + i * 100);
    assert.equal(budget.shed(), false, `warm-up detect ${i} does not shed`);
    assert.deepEqual(budget.stats(), EMPTY_STATS, `nor is it recorded`);
  }
  // The one after them is an ordinary detect.
  budget.noteDetect(6, 300);
  assert.deepEqual(budget.stats(), {
    ...EMPTY_STATS,
    mean: 6,
    max: 6,
    count: 1,
  });
  budget.noteDetect(GLAM_SHED_SINGLE_MS + 1, 400);
  assert.equal(budget.shed(), true, "the ceiling is back");
});

test("GlamBudget: warm-up detects are in neither the mean nor the run", () => {
  // Under the single ceiling, so only the mean and the run could see them.
  const slow = GLAM_SHED_RUN_MS + 1;
  assert.ok(slow > GLAM_SLOW_MEAN_MS && slow < GLAM_SHED_SINGLE_MS);
  const budget = new GlamBudget();
  budget.noteWarmup();
  for (let i = 0; i < GLAM_WARMUP_DETECTS; i++) budget.noteDetect(slow, i);
  assert.equal(budget.every(), GLAM_DETECT_EVERY, "the cadence did not slow");
  // The run starts at the first counted detect.
  for (let i = 1; i < GLAM_SHED_RUN; i++) {
    budget.noteDetect(slow, 100 * i);
    assert.equal(budget.shed(), false, `counted slow detect ${i}`);
  }
  budget.noteDetect(slow, 100 * GLAM_SHED_RUN);
  assert.equal(budget.shed(), true);
  assert.equal(budget.stats().count, GLAM_SHED_RUN);
});

test("GlamBudget: a new budget does not warm up by itself", () => {
  const budget = new GlamBudget();
  budget.noteDetect(9, 100);
  assert.deepEqual(budget.stats(), {
    ...EMPTY_STATS,
    mean: 9,
    max: 9,
    count: 1,
  });
  const first = new GlamBudget();
  first.noteDetect(GLAM_SHED_SINGLE_MS + 1, 100);
  assert.equal(first.shed(), true, "the very first detect can shed");
  // Nor does one that was reset.
  first.reset();
  first.noteDetect(GLAM_SHED_SINGLE_MS + 1, 200);
  assert.equal(first.shed(), true);
});

test("GlamBudget: each noteWarmup() covers one new tracker, no more", () => {
  const over = GLAM_SHED_SINGLE_MS + 1;
  // Asked for three times: still the same few detects.
  const stacked = new GlamBudget();
  stacked.noteWarmup();
  stacked.noteWarmup();
  stacked.noteWarmup();
  for (let i = 0; i < GLAM_WARMUP_DETECTS; i++) stacked.noteDetect(over, i);
  assert.equal(stacked.shed(), false);
  stacked.noteDetect(over, 500);
  assert.equal(stacked.shed(), true, "the warm-ups did not add up");

  // A tracker re-created in the middle of a call warms up again, and what
  // was measured before it stays.
  const again = new GlamBudget();
  again.noteWarmup();
  let now = detects(again, over, GLAM_WARMUP_DETECTS, 0);
  now = detects(again, 4, 10, now);
  again.noteWarmup();
  now = detects(again, over, GLAM_WARMUP_DETECTS, now);
  assert.equal(again.shed(), false);
  assert.deepEqual(again.stats(), {
    ...EMPTY_STATS,
    mean: 4,
    max: 4,
    count: 10,
  });
  // Asked for again part way through: a full warm-up from there.
  again.noteWarmup();
  again.noteDetect(over, now + 100);
  again.noteWarmup();
  now = detects(again, over, GLAM_WARMUP_DETECTS, now + 100);
  assert.equal(again.shed(), false);
  again.noteDetect(over, now + 100);
  assert.equal(again.shed(), true);

  // A detect time that is ignored does not use one up.
  const ignored = new GlamBudget();
  ignored.noteWarmup();
  for (const bad of [NaN, Infinity, -1]) ignored.noteDetect(bad, 50);
  for (let i = 0; i < GLAM_WARMUP_DETECTS; i++) ignored.noteDetect(over, i);
  assert.equal(ignored.shed(), false);
  assert.equal(ignored.stats().count, 0);
});

test("GlamBudget: a warm-up detect over the warm-up ceiling sheds", () => {
  // Each warm-up detect is judged, the first and the last alike.
  for (let slowOne = 0; slowOne < GLAM_WARMUP_DETECTS; slowOne++) {
    const budget = new GlamBudget();
    budget.noteWarmup();
    for (let i = 0; i < slowOne; i++) {
      budget.noteDetect(GLAM_WARMUP_CEILING_MS, 100 + i * 100);
    }
    assert.equal(budget.shed(), false, `at the ceiling, before ${slowOne}`);
    budget.noteDetect(GLAM_WARMUP_CEILING_MS + 1, 900);
    assert.equal(budget.shed(), true, `warm-up detect ${slowOne}`);
    // It is a shed like any other: for good, and nothing more is recorded.
    assert.deepEqual(budget.stats(), EMPTY_STATS);
    detects(budget, 1, 50, 1000);
    assert.equal(budget.shed(), true, "never re-arms");
    assert.deepEqual(budget.stats(), EMPTY_STATS);
  }

  // The warm-up after a return to the foreground has the same ceiling.
  const back = new GlamBudget();
  back.noteWarmup();
  let now = detects(back, 40, GLAM_WARMUP_DETECTS, 0);
  now = detects(back, 4, 10, now);
  back.noteWarmup();
  back.noteDetect(5000, now + 100);
  assert.equal(back.shed(), true);
  assert.equal(back.stats().count, 10, "the slow one itself is not counted");
});

test("GlamBudget: under its ceiling a warm-up detect is still left out", () => {
  // Between the single ceiling and the warm-up ceiling: excused in warm-up,
  // a shed right after it.
  for (const ms of [
    GLAM_SHED_SINGLE_MS + 1,
    (GLAM_SHED_SINGLE_MS + GLAM_WARMUP_CEILING_MS) / 2,
    GLAM_WARMUP_CEILING_MS,
  ]) {
    const budget = new GlamBudget();
    budget.noteWarmup();
    for (let i = 0; i < GLAM_WARMUP_DETECTS; i++) {
      budget.noteDetect(ms, 100 + i * 100);
      assert.equal(budget.shed(), false, `${ms} ms in warm-up`);
    }
    assert.deepEqual(budget.stats(), EMPTY_STATS);
    assert.equal(budget.every(), GLAM_DETECT_EVERY, "nor did it slow down");
    budget.noteDetect(ms, 900);
    assert.equal(budget.shed(), true, `${ms} ms after warm-up`);
  }

  // A detect time that is ignored neither sheds nor uses a warm-up up.
  const ignored = new GlamBudget();
  ignored.noteWarmup();
  for (const bad of [NaN, Infinity, -Infinity, -5000]) {
    ignored.noteDetect(bad, 50);
    assert.equal(ignored.shed(), false, `ms ${bad}`);
  }
  for (let i = 0; i < GLAM_WARMUP_DETECTS; i++) {
    ignored.noteDetect(GLAM_WARMUP_CEILING_MS, 100 + i);
  }
  assert.equal(ignored.shed(), false);

  // Outside a warm-up the single ceiling decides, long before this one.
  const cold = new GlamBudget();
  cold.noteDetect(GLAM_SHED_SINGLE_MS + 1, 100);
  assert.equal(cold.shed(), true);
});

// ---- glamShouldDetect ------------------------------------------------------

/** Nothing in the way of a detect, and one ran a moment ago. */
const OPEN = {
  hidden: false,
  shed: false,
  detectedThisTask: false,
  gateHeld: false,
  msSinceDetect: 0,
};

test("glamShouldDetect: the truth table", () => {
  const flags = [false, true];
  const times: ReadonlyArray<readonly [number, boolean]> = [
    [0, false],
    [1, false],
    [GLAM_FORCE_DETECT_MS - 1, false],
    [GLAM_FORCE_DETECT_MS, true],
    [GLAM_FORCE_DETECT_MS + 1, true],
    [60_000, true],
  ];
  for (const hidden of flags) {
    for (const shed of flags) {
      for (const gateHeld of flags) {
        for (const detectedThisTask of flags) {
          const blocked = hidden || shed || gateHeld || detectedThisTask;
          for (const every of [1, GLAM_DETECT_EVERY, GLAM_DETECT_EVERY_SLOW]) {
            for (const [msSinceDetect, overdue] of times) {
              for (let frame = 0; frame < 13; frame++) {
                const input = {
                  frame,
                  every,
                  hidden,
                  shed,
                  detectedThisTask,
                  gateHeld,
                  msSinceDetect,
                };
                assert.equal(
                  glamShouldDetect(input),
                  !blocked && (frame % every === 0 || overdue),
                  JSON.stringify(input),
                );
              }
            }
          }
        }
      }
    }
  }
});

test("glamShouldDetect: the cadence spaces detects out", () => {
  const framesOf = (every: number, msSinceDetect: number) =>
    Array.from({ length: 12 }, (_, frame) => frame).filter((frame) =>
      glamShouldDetect({ ...OPEN, frame, every, msSinceDetect }),
    );
  assert.deepEqual(framesOf(GLAM_DETECT_EVERY, 0), [0, 2, 4, 6, 8, 10]);
  assert.deepEqual(framesOf(GLAM_DETECT_EVERY_SLOW, 0), [0, 3, 6, 9]);
  // Just under the limit the cadence still decides alone.
  const under = GLAM_FORCE_DETECT_MS - 1;
  assert.deepEqual(framesOf(GLAM_DETECT_EVERY_SLOW, under), [0, 3, 6, 9]);
  // At it, every frame may detect.
  assert.equal(
    framesOf(GLAM_DETECT_EVERY_SLOW, GLAM_FORCE_DETECT_MS).length,
    12,
  );
});

/**
 * Run the camera at one frame every `frameMs` for a while, the way the
 * caller does: ask on each frame, and remember when a detect last ran.
 * Returns the longest wait between two detects and how many ran.
 */
function simulate(frameMs: number, every: number, frames = 120) {
  let lastDetect: number | undefined;
  let longest = 0;
  let count = 0;
  for (let frame = 0; frame < frames; frame++) {
    const now = frame * frameMs;
    const msSinceDetect =
      lastDetect === undefined ? Infinity : now - lastDetect;
    if (!glamShouldDetect({ ...OPEN, frame, every, msSinceDetect })) continue;
    if (lastDetect !== undefined) longest = Math.max(longest, now - lastDetect);
    lastDetect = now;
    count += 1;
  }
  return { longest, count };
}

test("glamShouldDetect: a slow frame rate cannot let the hold run out", () => {
  // 10 frames a second on the slow cadence: by frames alone a detect every
  // 300 ms, which is longer than the look is held for.
  assert.ok(GLAM_DETECT_EVERY_SLOW * 100 > GLAM_HOLD_MS);
  for (const every of [GLAM_DETECT_EVERY, GLAM_DETECT_EVERY_SLOW]) {
    for (const frameMs of [16, 33, 40, 50, 66, 83, 100]) {
      const { longest } = simulate(frameMs, every);
      assert.ok(
        longest <= GLAM_HOLD_MS,
        `${frameMs} ms frames, every ${every}: waited ${longest} ms`,
      );
    }
    // Slower than the limit itself: every frame detects.
    for (const frameMs of [GLAM_FORCE_DETECT_MS, 200, 500, 1000]) {
      assert.equal(simulate(frameMs, every).count, 120, `${frameMs} ms`);
    }
  }
});

test("glamShouldDetect: at a normal frame rate the time rule adds nothing", () => {
  // 30 and 60 frames a second: the cadence comes round before the limit.
  for (const frameMs of [16, 33]) {
    assert.equal(simulate(frameMs, GLAM_DETECT_EVERY).count, 60);
    assert.equal(simulate(frameMs, GLAM_DETECT_EVERY_SLOW).count, 40);
  }
});

test("glamShouldDetect: an unusable time since the last detect", () => {
  const offCadence = { ...OPEN, frame: 1, every: GLAM_DETECT_EVERY };
  assert.equal(glamShouldDetect(offCadence), false, "the control");
  // No detect yet, or no clock: long ago.
  for (const msSinceDetect of [NaN, Infinity, -Infinity]) {
    assert.equal(glamShouldDetect({ ...offCadence, msSinceDetect }), true);
  }
  // A clock that stepped backwards: just now, so the cadence decides.
  for (const msSinceDetect of [-1, -GLAM_FORCE_DETECT_MS, -1e12]) {
    assert.equal(glamShouldDetect({ ...offCadence, msSinceDetect }), false);
    assert.equal(
      glamShouldDetect({ ...offCadence, frame: 2, msSinceDetect }),
      true,
    );
  }
  // Long ago is still not a reason to detect when something forbids it.
  const blockers = ["hidden", "shed", "gateHeld", "detectedThisTask"] as const;
  for (const blocker of blockers) {
    assert.equal(
      glamShouldDetect({ ...offCadence, msSinceDetect: NaN, [blocker]: true }),
      false,
      blocker,
    );
  }
});

test("glamShouldDetect: a cadence or frame that makes no sense never matches", () => {
  for (const every of [0, -2, 1.5, NaN, Infinity]) {
    assert.equal(glamShouldDetect({ ...OPEN, frame: 0, every }), false);
    assert.equal(glamShouldDetect({ ...OPEN, frame: 6, every }), false);
  }
  for (const frame of [NaN, Infinity, 2.5]) {
    assert.equal(glamShouldDetect({ ...OPEN, frame, every: 2 }), false);
  }
  // Only the time rule can say yes for it, so tracking is slow, not dead.
  const overdue = { ...OPEN, msSinceDetect: GLAM_FORCE_DETECT_MS };
  assert.equal(glamShouldDetect({ ...overdue, frame: 0, every: 0 }), true);
  assert.equal(glamShouldDetect({ ...overdue, frame: NaN, every: 2 }), true);
});

// ---- GlamDetectLatch -------------------------------------------------------

/** What the caller passes `mayDetect`: no flag for "already ran". */
const ASK = {
  frame: 0,
  every: GLAM_DETECT_EVERY,
  hidden: false,
  shed: false,
  gateHeld: false,
  msSinceDetect: 0,
};

test("GlamDetectLatch: one claim per task, whoever asks", () => {
  const latch = new GlamDetectLatch();
  assert.equal(latch.ran(), false, "a new latch has run nothing");
  assert.equal(latch.claim(), true, "the first claim wins");
  assert.equal(latch.ran(), true);
  for (let i = 0; i < 5; i++) {
    assert.equal(latch.claim(), false, `claim ${i + 2} of the same task`);
  }
  assert.equal(latch.ran(), true);
  // Only a new task opens it again, and for one claim again.
  latch.beginTask();
  assert.equal(latch.ran(), false);
  assert.equal(latch.claim(), true);
  assert.equal(latch.claim(), false);
  // A task with no detect leaves nothing behind.
  latch.beginTask();
  latch.beginTask();
  assert.equal(latch.ran(), false);
  assert.equal(latch.claim(), true);
});

test("GlamDetectLatch: mayDetect says no once the task's detect is claimed", () => {
  const latch = new GlamDetectLatch();
  latch.beginTask();
  assert.equal(latch.mayDetect(ASK), true, "the control: nothing in the way");
  // Asking is not claiming.
  assert.equal(latch.mayDetect(ASK), true);
  assert.equal(latch.ran(), false);
  assert.equal(latch.claim(), true);
  assert.equal(latch.mayDetect(ASK), false, "this task ran its detect");
  // Not even a detect that is long overdue.
  assert.equal(latch.mayDetect({ ...ASK, msSinceDetect: Infinity }), false);
  latch.beginTask();
  assert.equal(latch.mayDetect(ASK), true, "the next task may");
});

test("GlamDetectLatch: a detect claimed for another reason counts too", () => {
  // Stickers detect on a frame the look's own rules said no to (the gate is
  // held): the look may not add a second detect to that task.
  const latch = new GlamDetectLatch();
  latch.beginTask();
  assert.equal(latch.mayDetect({ ...ASK, gateHeld: true }), false);
  assert.equal(latch.claim(), true, "the stickers' detect");
  assert.equal(latch.mayDetect(ASK), false);
  assert.equal(latch.claim(), false);
});

test("GlamDetectLatch: mayDetect is glamShouldDetect, every input passed on", () => {
  const flags = [false, true];
  const latch = new GlamDetectLatch();
  let asked = 0;
  for (const ran of flags) {
    latch.beginTask();
    if (ran) latch.claim();
    for (const hidden of flags) {
      for (const shed of flags) {
        for (const gateHeld of flags) {
          for (const every of [GLAM_DETECT_EVERY, GLAM_DETECT_EVERY_SLOW]) {
            for (const msSinceDetect of [0, GLAM_FORCE_DETECT_MS, NaN, -1]) {
              for (let frame = 0; frame < 7; frame++) {
                const ask = {
                  frame,
                  every,
                  hidden,
                  shed,
                  gateHeld,
                  msSinceDetect,
                };
                assert.equal(
                  latch.mayDetect(ask),
                  glamShouldDetect({ ...ask, detectedThisTask: ran }),
                  JSON.stringify({ ...ask, ran }),
                );
                asked += 1;
              }
            }
          }
        }
      }
    }
  }
  assert.equal(asked, 2 * 2 * 2 * 2 * 2 * 4 * 7);
  // Each blocker alone, against the control, so none is dropped on the way.
  latch.beginTask();
  assert.equal(latch.mayDetect(ASK), true, "the control");
  assert.equal(latch.mayDetect({ ...ASK, hidden: true }), false, "hidden");
  assert.equal(latch.mayDetect({ ...ASK, shed: true }), false, "shed");
  assert.equal(latch.mayDetect({ ...ASK, gateHeld: true }), false, "gate");
  assert.equal(latch.mayDetect({ ...ASK, frame: 1 }), false, "off cadence");
  // Nothing sticks from one question to the next.
  assert.equal(latch.mayDetect(ASK), true);
});

test("GlamDetectLatch: frames driven the way the caller drives them", () => {
  // Each frame: begin, the look asks and detects, then stickers try too.
  const latch = new GlamDetectLatch();
  let detects = 0;
  const detect = () => {
    if (latch.claim()) detects += 1;
  };
  for (let frame = 0; frame < 60; frame++) {
    latch.beginTask();
    const before = detects;
    if (latch.mayDetect({ ...ASK, frame })) detect();
    detect();
    detect();
    assert.equal(detects - before, 1, `frame ${frame}: exactly one detect`);
  }
  assert.equal(detects, 60);
});

// ---- glamMayCreateTracker, glamTrackerLoadMustWait --------------------------

/** The look wants its tracker and nothing is in the way. */
const CLEAR = {
  wanted: true,
  gateHeld: false,
  hidden: false,
  shed: false,
  failed: false,
};

test("glamMayCreateTracker: the truth table", () => {
  const flags = [false, true];
  let yes = 0;
  for (const wanted of flags) {
    for (const gateHeld of flags) {
      for (const hidden of flags) {
        for (const shed of flags) {
          for (const failed of flags) {
            const input = { wanted, gateHeld, hidden, shed, failed };
            const expected = wanted && !gateHeld && !hidden && !shed && !failed;
            assert.equal(
              glamMayCreateTracker(input),
              expected,
              JSON.stringify(input),
            );
            if (expected) yes += 1;
          }
        }
      }
    }
  }
  assert.equal(yes, 1, "one way to say yes");
});

test("glamMayCreateTracker: each reason alone says no", () => {
  assert.equal(glamMayCreateTracker(CLEAR), true, "the control");
  assert.equal(glamMayCreateTracker({ ...CLEAR, wanted: false }), false);
  assert.equal(
    glamMayCreateTracker({ ...CLEAR, gateHeld: true }),
    false,
    "never while the publish gate is held",
  );
  assert.equal(
    glamMayCreateTracker({ ...CLEAR, hidden: true }),
    false,
    "never on a hidden page",
  );
  assert.equal(glamMayCreateTracker({ ...CLEAR, shed: true }), false);
  assert.equal(glamMayCreateTracker({ ...CLEAR, failed: true }), false);
});

test("glamTrackerLoadMustWait: the truth table", () => {
  const flags = [false, true];
  let asked = 0;
  for (const stickers of flags) {
    for (const forGlam of flags) {
      for (const wanted of flags) {
        for (const gateHeld of flags) {
          for (const hidden of flags) {
            for (const shed of flags) {
              for (const failed of flags) {
                const input = {
                  stickers,
                  forGlam,
                  wanted,
                  gateHeld,
                  hidden,
                  shed,
                  failed,
                };
                let expected: boolean;
                if (stickers) expected = false;
                else if (!wanted) expected = forGlam;
                else expected = gateHeld || hidden || shed || failed;
                assert.equal(
                  glamTrackerLoadMustWait(input),
                  expected,
                  JSON.stringify(input),
                );
                asked += 1;
              }
            }
          }
        }
      }
    }
  }
  assert.equal(asked, 128);
});

test("glamTrackerLoadMustWait: a load for the look waits out the gate and a hidden page", () => {
  const look = { ...CLEAR, stickers: false, forGlam: true };
  assert.equal(glamTrackerLoadMustWait(look), false, "the control: create");
  // The gate was empty when the load began and is held now.
  assert.equal(glamTrackerLoadMustWait({ ...look, gateHeld: true }), true);
  // The page went to the background while the files loaded.
  assert.equal(glamTrackerLoadMustWait({ ...look, hidden: true }), true);
  assert.equal(glamTrackerLoadMustWait({ ...look, shed: true }), true);
  assert.equal(glamTrackerLoadMustWait({ ...look, failed: true }), true);
  // It agrees with the rule the load was started under, case by case.
  for (const gateHeld of [false, true]) {
    for (const hidden of [false, true]) {
      const now = { ...look, gateHeld, hidden };
      assert.equal(glamTrackerLoadMustWait(now), !glamMayCreateTracker(now));
    }
  }
  // Who started the load makes no difference while the look wants it:
  // stickers began it, were switched off, and the look is all that is left.
  const inherited = { ...look, forGlam: false };
  assert.equal(glamTrackerLoadMustWait(inherited), false);
  assert.equal(glamTrackerLoadMustWait({ ...inherited, gateHeld: true }), true);
  assert.equal(glamTrackerLoadMustWait({ ...inherited, hidden: true }), true);
});

test("glamTrackerLoadMustWait: stickers never wait", () => {
  // Stickers and the masked touch up ask at any time, as without the look.
  const all = { stickers: true, wanted: true, shed: true, failed: true };
  for (const forGlam of [false, true]) {
    for (const gateHeld of [false, true]) {
      for (const hidden of [false, true]) {
        const input = { ...all, forGlam, gateHeld, hidden };
        assert.equal(glamTrackerLoadMustWait(input), false);
        assert.equal(
          glamTrackerLoadMustWait({ ...input, wanted: false }),
          false,
        );
      }
    }
  }
});

test("glamTrackerLoadMustWait: a load nobody wants any more", () => {
  const nobody = { ...CLEAR, wanted: false, stickers: false };
  // The look started it and was switched off, shed or failed since: no
  // tracker is created for it, held gate or not.
  assert.equal(glamTrackerLoadMustWait({ ...nobody, forGlam: true }), true);
  assert.equal(
    glamTrackerLoadMustWait({ ...nobody, forGlam: true, gateHeld: true }),
    true,
  );
  // Stickers started it: not held back here, exactly as without the look.
  assert.equal(glamTrackerLoadMustWait({ ...nobody, forGlam: false }), false);
  assert.equal(
    glamTrackerLoadMustWait({ ...nobody, forGlam: false, gateHeld: true }),
    false,
  );
});

// ---- glamPresence ----------------------------------------------------------

test("glamPresence: 1 through the hold, then a straight line to 0", () => {
  assert.equal(glamPresence(0), 1);
  assert.equal(glamPresence(GLAM_HOLD_MS / 2), 1);
  assert.equal(glamPresence(GLAM_HOLD_MS), 1);
  close(glamPresence(GLAM_HOLD_MS + GLAM_FADE_MS / 4), 0.75, "quarter");
  close(glamPresence(GLAM_HOLD_MS + GLAM_FADE_MS / 2), 0.5, "half");
  close(glamPresence(GLAM_HOLD_MS + (3 * GLAM_FADE_MS) / 4), 0.25, "late");
  assert.equal(glamPresence(GLAM_HOLD_MS + GLAM_FADE_MS), 0);
  assert.equal(glamPresence(GLAM_HOLD_MS + GLAM_FADE_MS + 1), 0);
  assert.equal(glamPresence(60_000), 0);
});

test("glamPresence: never rises with time and never leaves 0..1", () => {
  let previous = 1;
  for (let ms = -100; ms <= GLAM_HOLD_MS + GLAM_FADE_MS + 100; ms += 5) {
    const presence = glamPresence(ms);
    assert.ok(presence >= 0 && presence <= 1, `${ms}: ${presence}`);
    assert.ok(presence <= previous, `${ms}: does not rise`);
    previous = presence;
  }
});

test("glamPresence: a negative time is fresh, a non-finite one is lost", () => {
  assert.equal(glamPresence(-1), 1);
  assert.equal(glamPresence(-1e12), 1);
  assert.equal(glamPresence(NaN), 0);
  assert.equal(glamPresence(Infinity), 0);
  assert.equal(glamPresence(-Infinity), 0);
});

// ---- GlamRecovery ----------------------------------------------------------

test("GlamRecovery: nothing to do without a failure", () => {
  const recovery = new GlamRecovery();
  assert.equal(recovery.onVisible(0), "none");
  recovery.noteHidden();
  assert.equal(recovery.onVisible(1000), "none");
  recovery.noteHidden();
  recovery.noteHidden();
  assert.equal(recovery.onVisible(2000), "none");
});

test("GlamRecovery: a failure while hidden earns one re-create on return", () => {
  const recovery = new GlamRecovery();
  recovery.noteHidden();
  // The page is still hidden: noted, but nothing is re-created yet.
  assert.equal(recovery.noteFailure(500), "none");
  assert.equal(recovery.noteFailure(600), "none");
  assert.equal(recovery.onVisible(1000), "recreate");
  // Asked again without a new trip to the background: nothing.
  assert.equal(recovery.onVisible(1001), "none");
  // And the same trip does not earn a second one through the grace.
  assert.equal(recovery.noteFailure(1002), "none");
  recovery.noteRecreated(true);
  assert.equal(recovery.noteFailure(1003), "none");
});

test("GlamRecovery: a tracker that died in the background fails after the page is back", () => {
  // No detect runs while hidden, so this is how it really goes: the page
  // comes back, the first detect throws.
  const recovery = new GlamRecovery();
  recovery.noteHidden();
  assert.equal(recovery.onVisible(10_000), "none", "nothing known yet");
  assert.equal(recovery.noteFailure(10_040), "recreate");
  // One per trip, whoever asks.
  assert.equal(recovery.noteFailure(10_080), "none");
  assert.equal(recovery.onVisible(10_090), "none");
  recovery.noteRecreated(true);
  assert.equal(recovery.noteFailure(10_200), "none", "the trip is used up");
});

test("GlamRecovery: the grace ends GLAM_RECOVERY_GRACE_MS after the page is back", () => {
  const failAt = (ms: number) => {
    const recovery = new GlamRecovery();
    recovery.noteHidden();
    assert.equal(recovery.onVisible(50_000), "none");
    return recovery.noteFailure(50_000 + ms);
  };
  assert.equal(failAt(0), "recreate");
  assert.equal(failAt(1), "recreate");
  assert.equal(failAt(GLAM_RECOVERY_GRACE_MS - 1), "recreate");
  assert.equal(failAt(GLAM_RECOVERY_GRACE_MS), "recreate", "the last moment");
  assert.equal(failAt(GLAM_RECOVERY_GRACE_MS + 1), "none");
  assert.equal(failAt(60_000), "none");

  // A failure after the grace does not use the trip up, but nothing later
  // in that trip is inside it either.
  const late = new GlamRecovery();
  late.noteHidden();
  late.onVisible(1000);
  assert.equal(late.noteFailure(1000 + GLAM_RECOVERY_GRACE_MS + 1), "none");
  assert.equal(late.noteFailure(1000 + GLAM_RECOVERY_GRACE_MS + 2), "none");

  // The grace runs from the first onVisible of the trip, not from a
  // repeated one.
  const repeated = new GlamRecovery();
  repeated.noteHidden();
  repeated.onVisible(1000);
  assert.equal(repeated.onVisible(1000 + GLAM_RECOVERY_GRACE_MS), "none");
  assert.equal(
    repeated.noteFailure(1000 + GLAM_RECOVERY_GRACE_MS + 1),
    "none",
    "a second onVisible did not open a new grace",
  );
});

test("GlamRecovery: a failure on a visible page earns nothing", () => {
  const recovery = new GlamRecovery();
  assert.equal(recovery.noteFailure(0), "none");
  // onVisible without a trip to the background opens no grace.
  assert.equal(recovery.onVisible(10), "none");
  assert.equal(recovery.noteFailure(20), "none");
  recovery.noteHidden();
  assert.equal(recovery.onVisible(30), "none", "it failed before the page hid");
  // Long after the page came back: still the ordinary failed path.
  assert.equal(recovery.noteFailure(30 + GLAM_RECOVERY_GRACE_MS + 1), "none");
  recovery.noteHidden();
  assert.equal(recovery.onVisible(90_000), "none");
});

test("GlamRecovery: hiding again ends the grace and starts a new trip", () => {
  const recovery = new GlamRecovery();
  recovery.noteHidden();
  assert.equal(recovery.onVisible(1000), "none");
  recovery.noteHidden();
  // Hidden: the failure waits for the page, whatever the grace was.
  assert.equal(recovery.noteFailure(1100), "none");
  assert.equal(recovery.onVisible(60_000), "recreate");
  recovery.noteRecreated(true);

  // Each return opens its own grace, measured from that return.
  recovery.noteHidden();
  assert.equal(recovery.onVisible(100_000), "none");
  recovery.noteHidden();
  assert.equal(recovery.onVisible(200_000), "none");
  assert.equal(
    recovery.noteFailure(200_000 + GLAM_RECOVERY_GRACE_MS),
    "recreate",
  );
});

test("GlamRecovery: the grace needs a usable clock", () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    // No time for the return: no grace is opened.
    const blind = new GlamRecovery();
    blind.noteHidden();
    assert.equal(blind.onVisible(bad), "none");
    assert.equal(blind.noteFailure(bad), "none", `visible at ${bad}`);
    assert.equal(blind.noteFailure(1000), "none", `visible at ${bad}`);

    // No time for the failure: it is not inside the grace.
    const late = new GlamRecovery();
    late.noteHidden();
    late.onVisible(1000);
    assert.equal(late.noteFailure(bad), "none", `failed at ${bad}`);
    // And it did not use the grace up.
    assert.equal(late.noteFailure(1500), "recreate");

    // A failure noted while hidden needs no clock at all.
    const hidden = new GlamRecovery();
    hidden.noteHidden();
    assert.equal(hidden.noteFailure(bad), "none");
    assert.equal(hidden.onVisible(bad), "recreate", `hidden, ${bad}`);
  }
  // A time from before the page came back is not inside the grace.
  const backwards = new GlamRecovery();
  backwards.noteHidden();
  backwards.onVisible(5000);
  assert.equal(backwards.noteFailure(4999), "none");
  assert.equal(backwards.noteFailure(5001), "recreate");
});

test("GlamRecovery: a failed re-create is the end until reset()", () => {
  const recovery = new GlamRecovery();
  recovery.noteHidden();
  recovery.noteFailure(0);
  assert.equal(recovery.onVisible(100), "recreate");
  recovery.noteRecreated(false);
  for (let trip = 1; trip <= 3; trip++) {
    const at = trip * 10_000;
    recovery.noteHidden();
    recovery.noteFailure(at);
    assert.equal(recovery.onVisible(at + 100), "none", `trip ${trip}`);
    // Not through the grace either.
    recovery.noteHidden();
    assert.equal(recovery.onVisible(at + 200), "none", `trip ${trip}`);
    assert.equal(recovery.noteFailure(at + 300), "none", `trip ${trip}`);
  }
  recovery.reset();
  recovery.noteHidden();
  recovery.noteFailure(50_000);
  assert.equal(recovery.onVisible(50_100), "recreate");

  // The same when the re-create was earned through the grace.
  const grace = new GlamRecovery();
  grace.noteHidden();
  grace.onVisible(1000);
  assert.equal(grace.noteFailure(1100), "recreate");
  grace.noteRecreated(false);
  grace.noteHidden();
  assert.equal(grace.onVisible(9000), "none");
  assert.equal(grace.noteFailure(9100), "none");
});

test("GlamRecovery: a re-create that worked lets a later trip earn another", () => {
  const recovery = new GlamRecovery();
  for (let trip = 0; trip < 3; trip++) {
    const at = trip * 100_000;
    // Once noted while hidden, once seen in the grace.
    recovery.noteHidden();
    recovery.noteFailure(at);
    assert.equal(recovery.onVisible(at + 1000), "recreate", `trip ${trip}`);
    recovery.noteRecreated(true);
    // A healthy trip in between asks for nothing.
    recovery.noteHidden();
    assert.equal(recovery.onVisible(at + 20_000), "none");
    recovery.noteHidden();
    assert.equal(recovery.onVisible(at + 50_000), "none");
    assert.equal(recovery.noteFailure(at + 50_500), "recreate", `trip ${trip}`);
    recovery.noteRecreated(true);
  }
});

test("GlamRecovery: no second re-create while one is still running", () => {
  const recovery = new GlamRecovery();
  recovery.noteHidden();
  recovery.noteFailure(0);
  assert.equal(recovery.onVisible(1000), "recreate");
  // The page hides and fails again before the first outcome is known.
  recovery.noteHidden();
  recovery.noteFailure(2000);
  assert.equal(recovery.onVisible(3000), "none");
  // Nor through the grace of yet another trip.
  recovery.noteHidden();
  assert.equal(recovery.onVisible(4000), "none");
  assert.equal(recovery.noteFailure(4100), "none");
  recovery.noteRecreated(true);
  // The failures in between were dropped, not saved up.
  assert.equal(recovery.onVisible(4200), "none");
  assert.equal(recovery.noteFailure(4300), "none");
  recovery.noteHidden();
  recovery.noteFailure(5000);
  assert.equal(recovery.onVisible(6000), "recreate");

  // The same when the first one was earned through the grace.
  const grace = new GlamRecovery();
  grace.noteHidden();
  grace.onVisible(1000);
  assert.equal(grace.noteFailure(1100), "recreate");
  grace.noteHidden();
  grace.noteFailure(2000);
  assert.equal(grace.onVisible(3000), "none");
});

test("GlamRecovery: cancel() drops a pending re-create without spending the allowance", () => {
  const recovery = new GlamRecovery();
  recovery.noteHidden();
  recovery.noteFailure(0);
  assert.equal(recovery.onVisible(1000), "recreate");
  recovery.cancel();
  // Nothing is outstanding any more: the next trip can earn one at once.
  recovery.noteHidden();
  recovery.noteFailure(2000);
  assert.equal(recovery.onVisible(3000), "recreate", "not blocked");
  recovery.cancel();
  // A late report for a cancelled re-create costs nothing.
  recovery.noteRecreated(false);
  recovery.noteHidden();
  assert.equal(recovery.onVisible(4000), "none");
  assert.equal(recovery.noteFailure(4100), "recreate", "not spent");
  recovery.noteRecreated(true);

  // cancel() is not reset(): an allowance already spent stays spent.
  recovery.noteHidden();
  recovery.noteFailure(5000);
  assert.equal(recovery.onVisible(6000), "recreate");
  recovery.noteRecreated(false);
  recovery.cancel();
  recovery.noteHidden();
  recovery.noteFailure(7000);
  assert.equal(recovery.onVisible(8000), "none", "still spent");
});

test("GlamRecovery: cancel() forgets what was learned about the old tracker", () => {
  // A failure noted while hidden belongs to the tracker that is gone.
  const noted = new GlamRecovery();
  noted.noteHidden();
  noted.noteFailure(0);
  noted.cancel();
  assert.equal(noted.onVisible(1000), "none");

  // So does an open grace.
  const grace = new GlamRecovery();
  grace.noteHidden();
  grace.onVisible(1000);
  grace.cancel();
  assert.equal(grace.noteFailure(1100), "none");

  // The page is still hidden after it: the new tracker's trip counts.
  const hidden = new GlamRecovery();
  hidden.noteHidden();
  hidden.cancel();
  assert.equal(hidden.noteFailure(500), "none");
  assert.equal(hidden.onVisible(1000), "recreate");
  hidden.noteRecreated(true);
  hidden.noteHidden();
  hidden.cancel();
  assert.equal(hidden.onVisible(9000), "none");
  assert.equal(hidden.noteFailure(9100), "recreate", "a grace after cancel()");
});

test("GlamRecovery: a report with no re-create outstanding changes nothing", () => {
  const recovery = new GlamRecovery();
  recovery.noteRecreated(false);
  recovery.noteRecreated(true);
  recovery.noteHidden();
  recovery.noteFailure(0);
  assert.equal(recovery.onVisible(1000), "recreate");
});

test("GlamRecovery: reset() forgets everything", () => {
  const recovery = new GlamRecovery();
  recovery.noteHidden();
  recovery.noteFailure(0);
  recovery.reset();
  assert.equal(recovery.onVisible(100), "none");
  // And reset() forgets the page was hidden.
  recovery.noteHidden();
  recovery.reset();
  assert.equal(recovery.noteFailure(200), "none");
  assert.equal(recovery.onVisible(300), "none");
  assert.equal(recovery.noteFailure(400), "none", "so no grace either");
  // An open grace.
  recovery.noteHidden();
  recovery.onVisible(1000);
  recovery.reset();
  assert.equal(recovery.noteFailure(1100), "none");
  // A re-create that was still running.
  recovery.noteHidden();
  recovery.noteFailure(2000);
  assert.equal(recovery.onVisible(3000), "recreate");
  recovery.reset();
  recovery.noteHidden();
  recovery.noteFailure(4000);
  assert.equal(recovery.onVisible(5000), "recreate");
});

// ---- Tracker files: reading the answers of the file check ------------------
//
// cameraEffects.ts sends a HEAD and, only when that left the question open,
// a GET for the first byte. Everything that is decided from the answers is
// decided here. The shapes below are the ones the servers in use really
// send: the phone app's local file server answers a HEAD for a missing file
// with 404, but starts EVERY request that carries a `Range` header at 206
// and sends a missing file as 206 with nothing in it (Capacitor 8.4.3,
// WebViewLocalServer.handleLocalRequest).

const probeAnswer = (over: Partial<GlamProbeAnswer> = {}): GlamProbeAnswer => ({
  threw: false,
  status: 200,
  contentType: null,
  contentLength: null,
  contentRange: null,
  bodyBytes: 0,
  ...over,
});

/** A ranged answer that proves the file is there, to try to overrule with. */
const RANGE_PRESENT = probeAnswer({
  status: 206,
  contentType: "application/octet-stream",
  contentRange: "bytes 0-0/3758596",
  bodyBytes: 1,
});
/** What the phone app's file server sends for a missing file with a Range. */
const RANGE_CAPACITOR_MISSING = probeAnswer({ status: 206 });

test("glamProbeNeedsRange: only a HEAD with no response, or a server that does not do HEAD, sends the GET", () => {
  assert.equal(glamProbeNeedsRange(undefined), true, "no HEAD was sent");
  assert.equal(glamProbeNeedsRange(GLAM_PROBE_NO_ANSWER), true);
  assert.equal(glamProbeNeedsRange(probeAnswer({ threw: true })), true);
  assert.equal(glamProbeNeedsRange(probeAnswer({ status: 405 })), true);
  assert.equal(glamProbeNeedsRange(probeAnswer({ status: 501 })), true);
  for (const status of [
    200, 204, 206, 301, 304, 400, 401, 403, 404, 410, 416, 500, 502, 503,
  ]) {
    assert.equal(
      glamProbeNeedsRange(probeAnswer({ status })),
      false,
      `HEAD ${status} is an answer`,
    );
  }
});

test("glamProbeVerdict: a HEAD success that is not an HTML page is present (the shipped-file shape: 200 and no content type)", () => {
  // The model file has no content type the local file server knows.
  assert.equal(glamProbeVerdict(probeAnswer(), undefined), "present");
  for (const contentType of [
    null,
    "",
    "application/wasm",
    "application/octet-stream",
  ]) {
    assert.equal(
      glamProbeVerdict(probeAnswer({ contentType }), undefined),
      "present",
      `content type ${contentType}`,
    );
  }
  assert.equal(
    glamProbeVerdict(probeAnswer({ contentLength: "3758596" }), undefined),
    "present",
    "a stated length above zero",
  );
  assert.equal(
    glamProbeVerdict(probeAnswer({ status: 204 }), undefined),
    "present",
  );
  // Final: a GET that looks like a missing file does not overrule it.
  assert.equal(
    glamProbeVerdict(probeAnswer(), RANGE_CAPACITOR_MISSING),
    "present",
  );
  assert.equal(
    glamProbeVerdict(probeAnswer(), GLAM_PROBE_NO_ANSWER),
    "present",
  );
});

test("glamProbeVerdict: a HEAD 404 is missing, with no GET and whatever a GET would say (the phone app's missing-file shape)", () => {
  const head = probeAnswer({ status: 404 });
  assert.equal(glamProbeNeedsRange(head), false, "no GET is sent");
  assert.equal(glamProbeVerdict(head, undefined), "missing");
  // The 206 that server would send for the same missing file changes nothing,
  // and neither would one that looked like a real file.
  assert.equal(glamProbeVerdict(head, RANGE_CAPACITOR_MISSING), "missing");
  assert.equal(glamProbeVerdict(head, RANGE_PRESENT), "missing");
  for (const status of [400, 401, 403, 410, 416, 451, 499]) {
    const other = probeAnswer({ status });
    assert.equal(glamProbeVerdict(other, undefined), "missing", `${status}`);
    assert.equal(
      glamProbeVerdict(other, RANGE_PRESENT),
      "missing",
      `${status}`,
    );
  }
});

test("glamProbeVerdict: an HTML page in answer to the HEAD is missing (an app shell serving its start page)", () => {
  for (const contentType of [
    "text/html",
    "text/html; charset=utf-8",
    "TEXT/HTML",
    " Text/Html;charset=UTF-8",
  ]) {
    const head = probeAnswer({ contentType });
    assert.equal(glamProbeVerdict(head, undefined), "missing", contentType);
    assert.equal(glamProbeVerdict(head, RANGE_PRESENT), "missing", contentType);
  }
  assert.equal(
    glamProbeVerdict(
      probeAnswer({ status: 404, contentType: "text/html" }),
      undefined,
    ),
    "missing",
  );
});

test("glamProbeVerdict: a HEAD that states a length of zero is missing, and no stated length is not", () => {
  for (const contentLength of ["0", " 0 ", "00"]) {
    assert.equal(
      glamProbeVerdict(probeAnswer({ contentLength }), undefined),
      "missing",
      `content-length "${contentLength}"`,
    );
  }
  assert.equal(
    glamProbeVerdict(probeAnswer({ contentLength: "0" }), RANGE_PRESENT),
    "missing",
    "final like every answered HEAD",
  );
  for (const contentLength of [null, "", "1", "10", "100", "abc"]) {
    assert.equal(
      glamProbeVerdict(probeAnswer({ contentLength }), undefined),
      "present",
      `content-length ${contentLength}`,
    );
  }
});

test("glamProbeVerdict: a HEAD 5xx is unknown, never missing, and is not overruled by a GET", () => {
  for (const status of [500, 502, 503, 504, 599]) {
    for (const contentType of [null, "text/html", "application/json"]) {
      const head = probeAnswer({ status, contentType });
      assert.equal(glamProbeVerdict(head, undefined), "unknown", `${status}`);
      assert.equal(glamProbeVerdict(head, RANGE_PRESENT), "unknown");
      assert.equal(glamProbeVerdict(head, RANGE_CAPACITOR_MISSING), "unknown");
    }
  }
});

test("glamProbeVerdict: a HEAD status that is neither success nor error is unknown", () => {
  for (const status of [0, 100, 199, 300, 301, 302, 304, 399, NaN]) {
    const head = probeAnswer({ status });
    assert.equal(glamProbeVerdict(head, undefined), "unknown", `${status}`);
    assert.equal(glamProbeVerdict(head, RANGE_PRESENT), "unknown", `${status}`);
  }
});

/** Every HEAD that hands the question to the GET. */
const OPEN_HEADS: ReadonlyArray<
  readonly [string, GlamProbeAnswer | undefined]
> = [
  ["no HEAD sent", undefined],
  ["HEAD threw", GLAM_PROBE_NO_ANSWER],
  ["HEAD 405", probeAnswer({ status: 405 })],
  [
    "HEAD 405 with an HTML error page",
    probeAnswer({ status: 405, contentType: "text/html" }),
  ],
  ["HEAD 501", probeAnswer({ status: 501 })],
];

test("glamProbeVerdict: with the HEAD open, a GET is present only with proof there is something in the file", () => {
  for (const [name, head] of OPEN_HEADS) {
    for (const status of [200, 206]) {
      // A stated whole size above zero.
      assert.equal(
        glamProbeVerdict(
          head,
          probeAnswer({ status, contentRange: "bytes 0-0/3758596" }),
        ),
        "present",
        `${name}, ${status} with a size`,
      );
      // Or a byte that arrived (a server that ignores the range and sends
      // the file with no content-range).
      assert.equal(
        glamProbeVerdict(head, probeAnswer({ status, bodyBytes: 1 })),
        "present",
        `${name}, ${status} with a body byte`,
      );
      assert.equal(
        glamProbeVerdict(head, probeAnswer({ status, bodyBytes: 65536 })),
        "present",
      );
      assert.equal(glamProbeVerdict(head, RANGE_PRESENT), "present", name);
    }
  }
});

test("glamProbeVerdict: with the HEAD open, a 206 or 200 with nothing in it is missing (the phone app's ranged answer for a missing file)", () => {
  for (const [name, head] of OPEN_HEADS) {
    // Exactly what Capacitor sends: 206, an empty body, and either no
    // content-range or one whose size is -1.
    assert.equal(
      glamProbeVerdict(head, RANGE_CAPACITOR_MISSING),
      "missing",
      name,
    );
    for (const contentRange of [
      null,
      "",
      "bytes 0-0/-1",
      "bytes 0-0/0",
      "bytes 0-0/*",
      "bytes */0",
      "garbage",
    ]) {
      for (const status of [200, 206]) {
        assert.equal(
          glamProbeVerdict(head, probeAnswer({ status, contentRange })),
          "missing",
          `${name}, ${status}, content-range ${contentRange}`,
        );
      }
    }
    // The content type it guesses from the file name does not make it one.
    assert.equal(
      glamProbeVerdict(
        head,
        probeAnswer({ status: 206, contentType: "application/wasm" }),
      ),
      "missing",
      name,
    );
    // A body count that is no number is not a byte received.
    assert.equal(
      glamProbeVerdict(head, probeAnswer({ status: 206, bodyBytes: NaN })),
      "missing",
    );
  }
});

test("glamProbeVerdict: with the HEAD open, an HTML page in answer to the GET is missing whatever it carries", () => {
  for (const [name, head] of OPEN_HEADS) {
    for (const status of [200, 206]) {
      assert.equal(
        glamProbeVerdict(
          head,
          probeAnswer({
            status,
            contentType: "text/html; charset=utf-8",
            contentRange: "bytes 0-0/4096",
            bodyBytes: 1,
          }),
        ),
        "missing",
        `${name}, ${status}`,
      );
    }
  }
});

test("glamProbeVerdict: with the HEAD open, a 4xx GET is missing; no response, a 5xx and anything else are unknown", () => {
  for (const [name, head] of OPEN_HEADS) {
    for (const status of [400, 403, 404, 410, 416]) {
      assert.equal(
        glamProbeVerdict(head, probeAnswer({ status })),
        "missing",
        `${name}, GET ${status}`,
      );
    }
    assert.equal(
      glamProbeVerdict(head, undefined),
      "unknown",
      `${name}, no GET`,
    );
    assert.equal(glamProbeVerdict(head, GLAM_PROBE_NO_ANSWER), "unknown", name);
    // A request that threw is unknown even if fields were filled in.
    assert.equal(
      glamProbeVerdict(head, { ...RANGE_PRESENT, threw: true }),
      "unknown",
      name,
    );
    for (const status of [500, 501, 502, 503, 599]) {
      assert.equal(
        glamProbeVerdict(head, { ...RANGE_PRESENT, status }),
        "unknown",
        `${name}, GET ${status}`,
      );
    }
    for (const status of [0, 100, 204, 301, 304, NaN]) {
      assert.equal(
        glamProbeVerdict(head, { ...RANGE_PRESENT, status }),
        "unknown",
        `${name}, GET ${status}`,
      );
    }
  }
});

test("glamProbeVerdict: no pair of answers is present without a success status, and none from the GET without proof", () => {
  const statuses = [0, 200, 204, 206, 304, 404, 405, 410, 500, 501, 503];
  const types = [null, "text/html", "application/wasm"];
  const answers: GlamProbeAnswer[] = [GLAM_PROBE_NO_ANSWER];
  for (const status of statuses) {
    for (const contentType of types) {
      for (const contentRange of [null, "bytes 0-0/-1", "bytes 0-0/9"]) {
        for (const bodyBytes of [0, 1]) {
          for (const contentLength of [null, "0"]) {
            answers.push(
              probeAnswer({
                status,
                contentType,
                contentRange,
                bodyBytes,
                contentLength,
              }),
            );
          }
        }
      }
    }
  }
  let present = 0;
  for (const head of [undefined, ...answers]) {
    for (const range of [undefined, ...answers]) {
      if (glamProbeVerdict(head, range) !== "present") continue;
      present++;
      const fromGet = glamProbeNeedsRange(head);
      const by = fromGet ? range : head;
      assert.ok(by && !by.threw, "decided by a response");
      assert.ok(by.status >= 200 && by.status < 300, `status ${by.status}`);
      assert.notEqual(by.contentType, "text/html");
      if (fromGet) {
        assert.ok(
          by.bodyBytes > 0 || by.contentRange === "bytes 0-0/9",
          "proof there is something in the file",
        );
      } else {
        assert.equal(by.contentLength, null);
      }
    }
  }
  assert.ok(present > 0, "the sweep reached a present verdict");
});

test("glamContentRangeTotal: the stated whole size, 0 when there is none above zero", () => {
  assert.equal(glamContentRangeTotal("bytes 0-0/3758596"), 3758596);
  assert.equal(glamContentRangeTotal("bytes 0-0/1"), 1);
  assert.equal(glamContentRangeTotal("bytes 0-0 / 12 "), 12);
  assert.equal(glamContentRangeTotal("bytes 0-99/0100"), 100);
  for (const header of [
    null,
    "",
    "bytes 0-0/-1",
    "bytes 0-0/0",
    "bytes 0-0/*",
    "bytes */*",
    "bytes 0-0",
    "0-0",
    "bytes 0-0/12x",
    "bytes 0-0/1.5e3x",
  ]) {
    assert.equal(glamContentRangeTotal(header), 0, `${header}`);
  }
});

test("glamProbeCapability: every file has to be there, and one missing file settles it", () => {
  assert.equal(glamProbeCapability(["present", "present"]), "present");
  assert.equal(glamProbeCapability(["present"]), "present");
  // One file is not enough.
  assert.equal(glamProbeCapability(["present", "unknown"]), "unknown");
  assert.equal(glamProbeCapability(["unknown", "present"]), "unknown");
  assert.equal(glamProbeCapability(["unknown", "unknown"]), "unknown");
  // A missing file is final, also next to one that could not be told.
  assert.equal(glamProbeCapability(["present", "missing"]), "missing");
  assert.equal(glamProbeCapability(["missing", "present"]), "missing");
  assert.equal(glamProbeCapability(["missing", "unknown"]), "missing");
  assert.equal(glamProbeCapability(["unknown", "missing"]), "missing");
  assert.equal(glamProbeCapability(["missing", "missing"]), "missing");
  // Nothing asked is nothing known.
  assert.equal(glamProbeCapability([]), "unknown");
});

test("GLAM_PROBE_NO_ANSWER: a request with no response, and it cannot be written to", () => {
  assert.equal(GLAM_PROBE_NO_ANSWER.threw, true);
  assert.equal(GLAM_PROBE_NO_ANSWER.bodyBytes, 0);
  assert.ok(Object.isFrozen(GLAM_PROBE_NO_ANSWER));
  assert.equal(
    glamProbeVerdict(GLAM_PROBE_NO_ANSWER, GLAM_PROBE_NO_ANSWER),
    "unknown",
  );
});
