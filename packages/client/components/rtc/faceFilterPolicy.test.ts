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
  "wizard-hat",
  "dragon",
  "d20",
  "elf-ears",
] as const;
const CameraColorLookIds = ["warm", "cool", "vintage", "mono", "vivid"] as const;

import {
  COLOR_LOOKS,
  DEGRADE,
  DegradeLadder,
  FACE_FILTERS,
  computeFaceFrame,
  faceSettingsActive,
  needsLandmarks,
  pickSlotOccupant,
  placeLayer,
  toneSettingsActive,
  type NormalizedLandmark,
  type SlotCaps,
  type SlotOccupant,
  type SlotSettings,
} from "./faceFilterCatalog.ts";

const CAPS_ALL: SlotCaps = {
  backgroundSupported: true,
  faceFiltersSupported: true,
  hwBrightness: false,
  toneSupported: true,
};

const S = (over: Partial<SlotSettings> = {}): SlotSettings => ({
  backgroundMode: "none",
  faceFilterId: undefined,
  beautify: 0,
  colorLookId: undefined,
  brightness: 100,
  lowLight: false,
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
// Slot occupancy with tone work (low light, touch up) across capabilities
// ---------------------------------------------------------------------------

const BOOLS = [false, true] as const;

/** Every capability combination: 2^4 = 16. */
const ALL_CAPS: SlotCaps[] = BOOLS.flatMap((backgroundSupported) =>
  BOOLS.flatMap((faceFiltersSupported) =>
    BOOLS.flatMap((hwBrightness) =>
      BOOLS.map((toneSupported) => ({
        backgroundSupported,
        faceFiltersSupported,
        hwBrightness,
        toneSupported,
      })),
    ),
  ),
);

/** Every off/on combination of the six settings: 2^6 = 64. */
const ALL_SETTINGS: SlotSettings[] = BOOLS.flatMap((background) =>
  BOOLS.flatMap((filter) =>
    BOOLS.flatMap((touchUp) =>
      BOOLS.flatMap((look) =>
        BOOLS.flatMap((bright) =>
          BOOLS.map((lowLight) =>
            S({
              backgroundMode: background ? "blur" : "none",
              faceFilterId: filter ? "dog" : undefined,
              beautify: touchUp ? 40 : 0,
              colorLookId: look ? "warm" : undefined,
              brightness: bright ? 150 : 100,
              lowLight,
            }),
          ),
        ),
      ),
    ),
  ),
);

/** A phone: no segmentation, no MediaPipe face filters, tone stage only. */
const CAPS_PHONE: SlotCaps = {
  backgroundSupported: false,
  faceFiltersSupported: false,
  hwBrightness: false,
  toneSupported: true,
};

const describeCase = (s: SlotSettings, caps: SlotCaps) =>
  `${JSON.stringify(s)} on ${JSON.stringify(caps)}`;

test("the capability and settings enumerations are complete", () => {
  // A new SlotCaps or SlotSettings field must be enumerated here too, or the
  // "every combination" tests below silently stop being exhaustive.
  assert.equal(Object.keys(CAPS_ALL).length, 4);
  assert.equal(ALL_CAPS.length, 16);
  assert.equal(new Set(ALL_CAPS.map((c) => JSON.stringify(c))).size, 16);
  assert.equal(Object.keys(S()).length, 6);
  assert.equal(ALL_SETTINGS.length, 64);
  assert.equal(new Set(ALL_SETTINGS.map((s) => JSON.stringify(s))).size, 64);
});

test("all defaults leave the slot empty for every capability combination", () => {
  for (const caps of ALL_CAPS) {
    assert.equal(pickSlotOccupant(S(), caps), "none", describeCase(S(), caps));
    assert.equal(toneSettingsActive(S(), caps), false);
    assert.equal(needsLandmarks(S(), caps), false);
  }
});

test("slot table: literal rows across capability combinations", () => {
  const caps = (over: Partial<SlotCaps>): SlotCaps => ({
    ...CAPS_ALL,
    ...over,
  });
  const rows: [SlotSettings, SlotCaps, SlotOccupant][] = [
    // Everything supported.
    [S({ lowLight: true }), CAPS_ALL, "face"],
    [S({ beautify: 40 }), CAPS_ALL, "face"],
    [S({ faceFilterId: "dog", lowLight: true }), CAPS_ALL, "face"],
    [S({ backgroundMode: "blur", lowLight: true }), CAPS_ALL, "background"],
    // Face filters but no tone stage: low light alone holds nothing.
    [S({ lowLight: true }), caps({ toneSupported: false }), "none"],
    [S({ beautify: 40 }), caps({ toneSupported: false }), "face"],
    [S({ colorLookId: "warm" }), caps({ toneSupported: false }), "face"],
    [
      S({ lowLight: true, brightness: 150 }),
      caps({ toneSupported: false }),
      "brightness-fallback",
    ],
    // Tone stage but no face filters: only low light and touch up count.
    [S({ lowLight: true }), caps({ faceFiltersSupported: false }), "face"],
    [S({ beautify: 40 }), caps({ faceFiltersSupported: false }), "face"],
    [S({ faceFilterId: "dog" }), caps({ faceFiltersSupported: false }), "none"],
    [S({ colorLookId: "warm" }), caps({ faceFiltersSupported: false }), "none"],
    [
      S({ faceFilterId: "dog", lowLight: true }),
      caps({ faceFiltersSupported: false }),
      "face",
    ],
    // Neither: the face pipeline never holds the slot.
    [
      S({ lowLight: true, beautify: 40, faceFilterId: "dog" }),
      caps({ faceFiltersSupported: false, toneSupported: false }),
      "none",
    ],
    [
      S({ lowLight: true, beautify: 40, brightness: 150 }),
      caps({ faceFiltersSupported: false, toneSupported: false }),
      "brightness-fallback",
    ],
    [
      S({ lowLight: true, beautify: 40, brightness: 150 }),
      caps({
        faceFiltersSupported: false,
        toneSupported: false,
        hwBrightness: true,
      }),
      "none",
    ],
    // Unsupported background does not hold the slot; tone work takes it.
    [
      S({ backgroundMode: "blur", lowLight: true }),
      caps({ backgroundSupported: false }),
      "face",
    ],
    [
      S({ backgroundMode: "blur", lowLight: true }),
      caps({ backgroundSupported: false, toneSupported: false }),
      "none",
    ],
  ];
  for (const [s, c, expected] of rows) {
    assert.equal(pickSlotOccupant(s, c), expected, describeCase(s, c));
  }
});

test("slot table: every settings x capability combination follows the order", () => {
  // Stated independently of the catalogue helpers: each candidate claims the
  // slot on its own terms and the first claim in priority order wins.
  const expected = (s: SlotSettings, caps: SlotCaps): SlotOccupant => {
    const claims: SlotOccupant[] = [];
    if (caps.backgroundSupported && s.backgroundMode !== "none") {
      claims.push("background");
    }
    const filterWork =
      caps.faceFiltersSupported &&
      (s.faceFilterId !== undefined ||
        s.beautify > 0 ||
        s.colorLookId !== undefined);
    const toneWork = caps.toneSupported && (s.lowLight || s.beautify > 0);
    if (filterWork || toneWork) claims.push("face");
    if (!caps.hwBrightness && s.brightness !== 100) {
      claims.push("brightness-fallback");
    }
    return claims[0] ?? "none";
  };

  const counts: Record<SlotOccupant, number> = {
    background: 0,
    face: 0,
    "brightness-fallback": 0,
    none: 0,
  };
  for (const caps of ALL_CAPS) {
    for (const s of ALL_SETTINGS) {
      const got = pickSlotOccupant(s, caps);
      assert.equal(got, expected(s, caps), describeCase(s, caps));
      counts[got]++;
    }
  }
  // Hand-counted over the 16 x 64 grid, so the oracle above cannot drift
  // along with the implementation unnoticed.
  assert.deepEqual(counts, {
    background: 256,
    face: 492,
    "brightness-fallback": 69,
    none: 207,
  });
});

test("phone-like caps: low light or touch up takes the face slot without landmarks", () => {
  for (const hwBrightness of BOOLS) {
    const caps: SlotCaps = { ...CAPS_PHONE, hwBrightness };
    assert.equal(pickSlotOccupant(S({ lowLight: true }), caps), "face");
    assert.equal(pickSlotOccupant(S({ beautify: 1 }), caps), "face");
    assert.equal(pickSlotOccupant(S({ beautify: 40 }), caps), "face");
    assert.equal(
      pickSlotOccupant(S({ lowLight: true, beautify: 40 }), caps),
      "face",
    );
    // A background mode the phone cannot run does not block tone work.
    assert.equal(
      pickSlotOccupant(S({ backgroundMode: "blur", lowLight: true }), caps),
      "face",
    );
    assert.equal(toneSettingsActive(S({ lowLight: true }), caps), true);
    assert.equal(toneSettingsActive(S({ beautify: 1 }), caps), true);
    for (const s of ALL_SETTINGS) {
      assert.equal(needsLandmarks(s, caps), false, describeCase(s, caps));
      assert.equal(
        pickSlotOccupant(s, caps) === "face",
        s.lowLight || s.beautify > 0,
        describeCase(s, caps),
      );
    }
  }
});

test("no tone stage and no face filters: the face pipeline never holds the slot", () => {
  const neither = ALL_CAPS.filter(
    (c) => !c.toneSupported && !c.faceFiltersSupported,
  );
  assert.equal(neither.length, 4);
  for (const caps of neither) {
    for (const s of ALL_SETTINGS) {
      assert.notEqual(pickSlotOccupant(s, caps), "face", describeCase(s, caps));
      assert.equal(toneSettingsActive(s, caps), false, describeCase(s, caps));
      assert.equal(needsLandmarks(s, caps), false, describeCase(s, caps));
    }
  }
});

test("background still wins over low light and touch up wherever it is supported", () => {
  const withBackground = ALL_CAPS.filter((c) => c.backgroundSupported);
  assert.equal(withBackground.length, 8);
  for (const caps of withBackground) {
    for (const s of ALL_SETTINGS) {
      if (s.backgroundMode === "none") {
        assert.notEqual(pickSlotOccupant(s, caps), "background");
      } else {
        assert.equal(
          pickSlotOccupant(s, caps),
          "background",
          describeCase(s, caps),
        );
      }
    }
  }
  // Without support the mode never claims the slot.
  for (const caps of ALL_CAPS.filter((c) => !c.backgroundSupported)) {
    for (const s of ALL_SETTINGS) {
      assert.notEqual(pickSlotOccupant(s, caps), "background");
    }
  }
});

test("brightness fallback only when nothing else holds the slot", () => {
  const noTone: SlotCaps = { ...CAPS_ALL, toneSupported: false };
  const neither: SlotCaps = { ...CAPS_PHONE, toneSupported: false };
  // Tone work holds the slot: brightness rides the face pipeline.
  assert.equal(
    pickSlotOccupant(S({ brightness: 150, lowLight: true }), CAPS_ALL),
    "face",
  );
  assert.equal(
    pickSlotOccupant(S({ brightness: 150, lowLight: true }), CAPS_PHONE),
    "face",
  );
  assert.equal(
    pickSlotOccupant(S({ brightness: 150, beautify: 40 }), CAPS_PHONE),
    "face",
  );
  // Low light the device cannot run holds nothing, so the fallback runs.
  assert.equal(
    pickSlotOccupant(S({ brightness: 150, lowLight: true }), noTone),
    "brightness-fallback",
  );
  assert.equal(
    pickSlotOccupant(S({ brightness: 150, beautify: 40 }), neither),
    "brightness-fallback",
  );
  assert.equal(
    pickSlotOccupant(S({ brightness: 150, faceFilterId: "dog" }), CAPS_PHONE),
    "brightness-fallback",
  );
  assert.equal(
    pickSlotOccupant(S({ brightness: 150 }), CAPS_PHONE),
    "brightness-fallback",
  );

  let seen = 0;
  for (const caps of ALL_CAPS) {
    for (const s of ALL_SETTINGS) {
      if (pickSlotOccupant(s, caps) !== "brightness-fallback") continue;
      seen++;
      const msg = describeCase(s, caps);
      assert.equal(s.brightness, 150, msg);
      assert.equal(caps.hwBrightness, false, msg);
      assert.ok(
        !(caps.backgroundSupported && s.backgroundMode === "blur"),
        msg,
      );
      assert.ok(!(caps.toneSupported && (s.lowLight || s.beautify > 0)), msg);
      assert.ok(
        !(
          caps.faceFiltersSupported &&
          (s.faceFilterId !== undefined ||
            s.beautify > 0 ||
            s.colorLookId !== undefined)
        ),
        msg,
      );
    }
  }
  assert.equal(seen, 69);
});

test("a face filter id without face-filter support holds nothing and never needs landmarks", () => {
  const unsupported = ALL_CAPS.filter((c) => !c.faceFiltersSupported);
  assert.equal(unsupported.length, 8);
  for (const caps of unsupported) {
    assert.equal(
      pickSlotOccupant(S({ faceFilterId: "dog" }), caps),
      "none",
      describeCase(S({ faceFilterId: "dog" }), caps),
    );
    assert.equal(
      pickSlotOccupant(S({ faceFilterId: "dog", colorLookId: "warm" }), caps),
      "none",
    );
    for (const s of ALL_SETTINGS) {
      assert.equal(needsLandmarks(s, caps), false, describeCase(s, caps));
    }
  }
  // Tone work alongside the stored id takes the slot, still without landmarks.
  const withTone = S({ faceFilterId: "dog", lowLight: true });
  assert.equal(pickSlotOccupant(withTone, CAPS_PHONE), "face");
  assert.equal(needsLandmarks(withTone, CAPS_PHONE), false);
});

test("needsLandmarks: only a sticker or touch up, and only with face-filter support", () => {
  for (const caps of ALL_CAPS.filter((c) => c.faceFiltersSupported)) {
    assert.equal(needsLandmarks(S({ faceFilterId: "dog" }), caps), true);
    assert.equal(needsLandmarks(S({ beautify: 1 }), caps), true);
    // A color look and low light are whole-frame work.
    assert.equal(needsLandmarks(S({ colorLookId: "warm" }), caps), false);
    assert.equal(needsLandmarks(S({ lowLight: true }), caps), false);
    assert.equal(needsLandmarks(S({ brightness: 150 }), caps), false);
    assert.equal(needsLandmarks(S({ backgroundMode: "blur" }), caps), false);
    for (const s of ALL_SETTINGS) {
      assert.equal(
        needsLandmarks(s, caps),
        s.faceFilterId !== undefined || s.beautify > 0,
        describeCase(s, caps),
      );
    }
  }
});

test("toneSettingsActive: low light or touch up, and only with tone support", () => {
  for (const caps of ALL_CAPS) {
    for (const s of ALL_SETTINGS) {
      assert.equal(
        toneSettingsActive(s, caps),
        caps.toneSupported && (s.lowLight || s.beautify > 0),
        describeCase(s, caps),
      );
    }
  }
  assert.equal(toneSettingsActive(S({ lowLight: true }), CAPS_ALL), true);
  assert.equal(toneSettingsActive(S({ beautify: 1 }), CAPS_ALL), true);
  // A sticker, a color look and brightness are not tone work.
  assert.equal(toneSettingsActive(S({ faceFilterId: "dog" }), CAPS_ALL), false);
  assert.equal(toneSettingsActive(S({ colorLookId: "warm" }), CAPS_ALL), false);
  assert.equal(toneSettingsActive(S({ brightness: 150 }), CAPS_ALL), false);
});

test("faceSettingsActive ignores low light (its meaning is unchanged)", () => {
  assert.equal(faceSettingsActive(S({ lowLight: true })), false);
  for (const s of ALL_SETTINGS) {
    assert.equal(
      faceSettingsActive(s),
      s.faceFilterId !== undefined ||
        s.beautify > 0 ||
        s.colorLookId !== undefined,
    );
  }
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
