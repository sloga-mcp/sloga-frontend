// Unit spec for the face-filter catalogue + slot policy + placement math —
// run with Node's built-in runner:
//   node --test components/rtc/faceFilterPolicy.test.ts   (Node >=23.6 strips types)
// Focus: the pickSlotOccupant table (plan §5) never mis-assigns the single
// LiveKit processor slot; placement math is sane; catalogue ids match the
// store's canonical lists 1:1; the degrade ladder steps and recovers.
import { test } from "node:test";
import assert from "node:assert/strict";

// NOTE: the store's id arrays (Voice.ts CameraFaceFilterIds/CameraColorLookIds)
// are deliberately NOT imported — the store module graph pulls browser deps
// that node's runner can't load. tsc already enforces catalogue↔store 1:1
// exhaustiveness via Record<CameraFaceFilterId, …>; the pinned copies below
// are a belt-and-braces regression check kept in sync by that same tsc error.
const CameraFaceFilterIds = [
  "dog",
  "cat",
  "sunglasses",
  "mustache",
  "party-hat",
  "heart-eyes",
  "viking",
  "gamer-headset",
  "pixel-shades",
  "health-bar",
] as const;
const CameraColorLookIds = ["warm", "cool", "vintage", "mono", "vivid"] as const;

import {
  COLOR_LOOKS,
  DEGRADE,
  DegradeLadder,
  FACE_FILTERS,
  computeFaceFrame,
  faceSettingsActive,
  pickSlotOccupant,
  placeLayer,
  type NormalizedLandmark,
  type SlotCaps,
  type SlotSettings,
} from "./faceFilterCatalog.ts";

const CAPS_ALL: SlotCaps = {
  backgroundSupported: true,
  faceFiltersSupported: true,
  hwBrightness: false,
};

const S = (over: Partial<SlotSettings> = {}): SlotSettings => ({
  backgroundMode: "none",
  faceFilterId: undefined,
  beautify: 0,
  colorLookId: undefined,
  brightness: 100,
  ...over,
});

// ---------------------------------------------------------------------------
// Catalogue integrity: rtc catalogue ↔ store id lists are 1:1
// ---------------------------------------------------------------------------

test("every store face-filter id has a catalogue entry and vice versa", () => {
  assert.deepEqual(
    Object.keys(FACE_FILTERS).sort(),
    [...CameraFaceFilterIds].sort(),
  );
  for (const id of CameraFaceFilterIds) {
    const def = FACE_FILTERS[id];
    assert.equal(def.id, id);
    assert.ok(def.layers.length > 0, `${id} has layers`);
    assert.ok(def.thumb, `${id} has a thumbnail`);
    for (const layer of def.layers) {
      assert.ok(layer.widthFactor > 0, `${id}/${layer.src} widthFactor > 0`);
      assert.ok(layer.src.endsWith(".svg"), `${id}/${layer.src} is svg`);
    }
  }
});

test("every store color-look id has a catalogue entry and vice versa", () => {
  assert.deepEqual(
    Object.keys(COLOR_LOOKS).sort(),
    [...CameraColorLookIds].sort(),
  );
  for (const id of CameraColorLookIds) {
    assert.equal(COLOR_LOOKS[id].id, id);
    assert.ok(COLOR_LOOKS[id].cssFilter.length > 0);
  }
});

// ---------------------------------------------------------------------------
// Slot occupancy table (plan §5)
// ---------------------------------------------------------------------------

test("background wins over face filters (v1 mutual exclusion)", () => {
  assert.equal(
    pickSlotOccupant(
      S({ backgroundMode: "blur", faceFilterId: "dog", beautify: 50 }),
      CAPS_ALL,
    ),
    "background",
  );
});

test("face filters take the slot when no background", () => {
  assert.equal(pickSlotOccupant(S({ faceFilterId: "dog" }), CAPS_ALL), "face");
  assert.equal(pickSlotOccupant(S({ beautify: 30 }), CAPS_ALL), "face");
  assert.equal(pickSlotOccupant(S({ colorLookId: "warm" }), CAPS_ALL), "face");
});

test("brightness fallback only when nothing else wants the slot AND no hw", () => {
  assert.equal(
    pickSlotOccupant(S({ brightness: 150 }), CAPS_ALL),
    "brightness-fallback",
  );
  assert.equal(
    pickSlotOccupant(S({ brightness: 150 }), { ...CAPS_ALL, hwBrightness: true }),
    "none",
  );
  // Filters active: brightness rides in the filter's ctx.filter chain.
  assert.equal(
    pickSlotOccupant(S({ brightness: 150, colorLookId: "mono" }), CAPS_ALL),
    "face",
  );
  // Background active: documented gap (no canvas brightness under bg).
  assert.equal(
    pickSlotOccupant(S({ brightness: 150, backgroundMode: "blur" }), CAPS_ALL),
    "background",
  );
});

test("everything at defaults → empty slot", () => {
  assert.equal(pickSlotOccupant(S(), CAPS_ALL), "none");
});

test("unsupported capabilities drop their occupant", () => {
  assert.equal(
    pickSlotOccupant(S({ backgroundMode: "blur" }), {
      ...CAPS_ALL,
      backgroundSupported: false,
    }),
    "none",
  );
  // Unsupported background does NOT let inert filters take the slot... they
  // aren't inert in that case: bg can't run, filters can.
  assert.equal(
    pickSlotOccupant(S({ backgroundMode: "blur", faceFilterId: "cat" }), {
      ...CAPS_ALL,
      backgroundSupported: false,
    }),
    "face",
  );
  assert.equal(
    pickSlotOccupant(S({ faceFilterId: "cat" }), {
      ...CAPS_ALL,
      faceFiltersSupported: false,
    }),
    "none",
  );
});

test("faceSettingsActive reflects any of the three filter settings", () => {
  assert.equal(faceSettingsActive(S()), false);
  assert.equal(faceSettingsActive(S({ faceFilterId: "dog" })), true);
  assert.equal(faceSettingsActive(S({ beautify: 1 })), true);
  assert.equal(faceSettingsActive(S({ colorLookId: "vivid" })), true);
});

// ---------------------------------------------------------------------------
// Placement math
// ---------------------------------------------------------------------------

/** Synthetic upright face: eyes at (0.4,0.4)/(0.6,0.4), chin below, 640x480. */
function uprightLandmarks(): NormalizedLandmark[] {
  const lm: NormalizedLandmark[] = Array.from({ length: 478 }, () => ({
    x: 0.5,
    y: 0.5,
  }));
  lm[468] = { x: 0.4, y: 0.4 }; // iris A
  lm[473] = { x: 0.6, y: 0.4 }; // iris B
  lm[1] = { x: 0.5, y: 0.55 }; // nose tip
  lm[0] = { x: 0.5, y: 0.65 }; // upper lip
  lm[10] = { x: 0.5, y: 0.2 }; // forehead
  lm[152] = { x: 0.5, y: 0.85 }; // chin
  return lm;
}

test("computeFaceFrame: upright face has zero roll and correct IOD", () => {
  const frame = computeFaceFrame(uprightLandmarks(), 640, 480);
  assert.ok(frame);
  assert.ok(Math.abs(frame.iod - 0.2 * 640) < 1e-6);
  assert.ok(Math.abs(frame.xAxis.y) < 1e-6, "eye line horizontal");
  assert.ok(frame.yAxis.y > 0.99, "yAxis points down toward the chin");
});

test("computeFaceFrame: swapped iris labels still yield left-eye at image left", () => {
  const lm = uprightLandmarks();
  const t = lm[468];
  lm[468] = lm[473];
  lm[473] = t;
  const frame = computeFaceFrame(lm, 640, 480);
  assert.ok(frame);
  assert.ok(frame.anchors["left-eye"].x < frame.anchors["right-eye"].x);
});

test("computeFaceFrame: degenerate input returns null", () => {
  assert.equal(computeFaceFrame([], 640, 480), null);
  const lm = uprightLandmarks();
  lm[473] = { ...lm[468] }; // zero IOD
  assert.equal(computeFaceFrame(lm, 640, 480), null);
});

test("placeLayer: head-top sticker sits above the eyes, scaled by IOD", () => {
  const frame = computeFaceFrame(uprightLandmarks(), 640, 480)!;
  const ears = FACE_FILTERS.dog.layers[0];
  const p = placeLayer(frame, ears);
  assert.ok(p.cy < frame.anchors.eyes.y, "above the eye line");
  assert.ok(Math.abs(p.width - ears.widthFactor * frame.iod) < 1e-6);
  assert.ok(Math.abs(p.rotation) < 1e-6, "no roll on an upright face");
});

test("placeLayer: rolled face rotates the sticker with the eye line", () => {
  const lm = uprightLandmarks();
  // Tilt the eye line ~15° (and keep chin plausible).
  lm[468] = { x: 0.4, y: 0.37 };
  lm[473] = { x: 0.6, y: 0.43 };
  const frame = computeFaceFrame(lm, 640, 640)!;
  const p = placeLayer(frame, FACE_FILTERS.sunglasses.layers[0]);
  assert.ok(Math.abs(p.rotation) > 0.1, "non-zero roll");
});

// ---------------------------------------------------------------------------
// Degrade ladder
// ---------------------------------------------------------------------------

test("degrade ladder steps down after a slow window and recovers after a sustained fast one", () => {
  const ladder = new DegradeLadder();
  let now = 0;
  // A full window of slow frames → one step down.
  for (let i = 0; i < DEGRADE.WINDOW; i++) ladder.record(DEGRADE.TRIGGER_MS + 10, (now += 33));
  assert.equal(ladder.step, 1);
  // Fast frames, but before RECOVER_AFTER_MS elapses: still degraded.
  for (let i = 0; i < DEGRADE.WINDOW; i++) ladder.record(5, (now += 33));
  assert.equal(ladder.step, 1);
  // Keep fast past the recovery hold → back to full quality.
  now += DEGRADE.RECOVER_AFTER_MS;
  for (let i = 0; i < DEGRADE.WINDOW + 5; i++) ladder.record(5, (now += 33));
  assert.equal(ladder.step, 0);
});

test("degrade ladder never exceeds MAX_STEP", () => {
  const ladder = new DegradeLadder();
  let now = 0;
  for (let round = 0; round < DEGRADE.MAX_STEP + 3; round++) {
    for (let i = 0; i < DEGRADE.WINDOW; i++) ladder.record(99, (now += 33));
  }
  assert.equal(ladder.step, DEGRADE.MAX_STEP);
});

test("degrade ladder reset(step) pins CPU sessions at a pre-degraded start", () => {
  const ladder = new DegradeLadder();
  ladder.reset(1);
  assert.equal(ladder.step, 1);
});
