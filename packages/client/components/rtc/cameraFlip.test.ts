// Unit spec for the camera flip's choice of the next camera. Run with Node's
// built-in runner from packages/client:
//   node --test --conditions=browser components/rtc/cameraFlip.test.ts
// Declared test count: 24 (compare against the runner's pass count, since the
// runner also exits 0 when it finds no tests at all).
// Focus: with fewer than two cameras there is nothing to flip to; a known
// direction flips to the other side and prefers the plain lens; an unknown
// direction steps through the list; the answer is never the camera that is
// already on; a label or a facing-mode list gives a direction only when it
// names exactly one.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type CameraDevice,
  type CameraFacing,
  cameraFacingFromLabel,
  cameraFacingFromModes,
  nextCamera,
} from "./cameraFlip.ts";

// An Android phone, as Chromium lists it: the front camera first
const ANDROID_FRONT: CameraDevice = {
  deviceId: "a-front",
  label: "camera2 1, facing front",
};
const ANDROID_BACK: CameraDevice = {
  deviceId: "a-back",
  label: "camera2 0, facing back",
};
const ANDROID_BACK_2: CameraDevice = {
  deviceId: "a-back-2",
  label: "camera2 2, facing back",
};

// An iPhone set to English, extra lenses listed before the plain back camera
const IPHONE: CameraDevice[] = [
  { deviceId: "i-front", label: "Front Camera" },
  { deviceId: "i-triple", label: "Back Triple Camera" },
  { deviceId: "i-ultra", label: "Back Ultra Wide Camera" },
  { deviceId: "i-back", label: "Back Camera" },
  { deviceId: "i-tele", label: "Back Telephoto Camera" },
];

// Cameras whose labels say nothing about a direction
const PLAIN_A: CameraDevice = { deviceId: "p-a", label: "Kamera 1" };
const PLAIN_B: CameraDevice = { deviceId: "p-b", label: "Kamera 2" };
const PLAIN_C: CameraDevice = { deviceId: "p-c", label: "Kamera 3" };

/** The id of the camera a flip would go to, or null for none */
function nextId(
  devices: readonly CameraDevice[],
  current: { deviceId?: string; facing?: CameraFacing },
): string | null {
  return nextCamera({ devices, current })?.deviceId ?? null;
}

// ---------------------------------------------------------------------------
// cameraFacingFromLabel
// ---------------------------------------------------------------------------

test("Android camera labels give their direction", () => {
  assert.equal(cameraFacingFromLabel("camera2 1, facing front"), "user");
  assert.equal(cameraFacingFromLabel("camera2 0, facing back"), "environment");
  assert.equal(cameraFacingFromLabel("camera2 3, facing back"), "environment");
});

test("iPhone camera labels in English give their direction", () => {
  assert.equal(cameraFacingFromLabel("Front Camera"), "user");
  assert.equal(cameraFacingFromLabel("Back Camera"), "environment");
  assert.equal(cameraFacingFromLabel("Back Ultra Wide Camera"), "environment");
  assert.equal(cameraFacingFromLabel("FRONT CAMERA"), "user");
  assert.equal(cameraFacingFromLabel("Rear Camera"), "environment");
});

test("a label that does not name one direction gives none", () => {
  assert.equal(cameraFacingFromLabel(""), undefined);
  assert.equal(cameraFacingFromLabel("Kamera 1"), undefined);
  assert.equal(cameraFacingFromLabel("Frontkamera"), undefined);
  assert.equal(cameraFacingFromLabel("Integrated Webcam"), undefined);
  // Part of a longer word is not the word
  assert.equal(cameraFacingFromLabel("Background Camera"), undefined);
  assert.equal(cameraFacingFromLabel("Backup Camera"), undefined);
  // Both directions named: no answer rather than a guess
  assert.equal(cameraFacingFromLabel("front and back camera"), undefined);
});

test("a label that is not text gives no direction", () => {
  assert.equal(cameraFacingFromLabel(undefined), undefined);
  assert.equal(cameraFacingFromLabel(null), undefined);
  assert.equal(cameraFacingFromLabel(1), undefined);
  assert.equal(cameraFacingFromLabel({ label: "Front Camera" }), undefined);
});

// ---------------------------------------------------------------------------
// cameraFacingFromModes
// ---------------------------------------------------------------------------

test("a facing-mode list that names one direction gives it", () => {
  assert.equal(cameraFacingFromModes(["user"]), "user");
  assert.equal(cameraFacingFromModes(["environment"]), "environment");
  assert.equal(cameraFacingFromModes(["left", "environment"]), "environment");
});

test("a facing-mode list that does not settle the direction gives none", () => {
  assert.equal(cameraFacingFromModes([]), undefined);
  assert.equal(cameraFacingFromModes(["user", "environment"]), undefined);
  assert.equal(cameraFacingFromModes(["left"]), undefined);
  assert.equal(cameraFacingFromModes(undefined), undefined);
  assert.equal(cameraFacingFromModes("user"), undefined);
  assert.equal(cameraFacingFromModes({ 0: "user", length: 1 }), undefined);
});

// ---------------------------------------------------------------------------
// nextCamera: fewer than two cameras
// ---------------------------------------------------------------------------

test("no camera at all: nothing to flip to", () => {
  assert.equal(nextId([], {}), null);
  assert.equal(nextId([], { deviceId: "a-front", facing: "user" }), null);
});

test("one camera: nothing to flip to", () => {
  assert.equal(nextId([ANDROID_FRONT], { deviceId: "a-front" }), null);
  assert.equal(
    nextId([ANDROID_FRONT], { deviceId: "a-front", facing: "user" }),
    null,
  );
  assert.equal(nextId([ANDROID_BACK], { deviceId: "a-back" }), null);
  assert.equal(nextId([PLAIN_A], { deviceId: "p-a" }), null);
  // Not even when the live camera is some other, unlisted one
  assert.equal(nextId([ANDROID_BACK], { deviceId: "gone" }), null);
  assert.equal(
    nextId([ANDROID_BACK], { deviceId: "gone", facing: "user" }),
    null,
  );
});

test("the same camera listed twice is still one camera", () => {
  assert.equal(
    nextId([ANDROID_FRONT, { ...ANDROID_FRONT }], { deviceId: "a-front" }),
    null,
  );
  assert.equal(
    nextId([PLAIN_A, { ...PLAIN_A }, { ...PLAIN_A }], { deviceId: "p-a" }),
    null,
  );
});

test("an entry without a device id is not a camera", () => {
  const blank: CameraDevice = { deviceId: "", label: "camera2 0, facing back" };
  assert.equal(nextId([ANDROID_FRONT, blank], { deviceId: "a-front" }), null);
  assert.equal(
    nextId([blank, blank, ANDROID_FRONT], { deviceId: "a-front" }),
    null,
  );
});

// ---------------------------------------------------------------------------
// nextCamera: the direction is known
// ---------------------------------------------------------------------------

test("the front camera flips to the back camera", () => {
  assert.equal(
    nextId([ANDROID_FRONT, ANDROID_BACK], { deviceId: "a-front" }),
    "a-back",
  );
  assert.equal(
    nextId([ANDROID_BACK, ANDROID_FRONT], { deviceId: "a-front" }),
    "a-back",
  );
});

test("the back camera flips to the front camera", () => {
  assert.equal(
    nextId([ANDROID_FRONT, ANDROID_BACK], { deviceId: "a-back" }),
    "a-front",
  );
  assert.equal(
    nextId([ANDROID_BACK, ANDROID_FRONT], { deviceId: "a-back" }),
    "a-front",
  );
});

test("two flips in a row come back to the first camera", () => {
  const devices = [ANDROID_FRONT, ANDROID_BACK, ANDROID_BACK_2];
  const first = nextId(devices, { deviceId: "a-front" });
  assert.equal(first, "a-back");
  assert.equal(nextId(devices, { deviceId: first! }), "a-front");
});

test("the direction read from the live track wins over the list", () => {
  // The list says the live camera is the front one; the track says it points
  // away from the user, so the flip goes to a front camera.
  const front2: CameraDevice = { deviceId: "a-front-2", label: "Front Camera" };
  assert.equal(
    nextId([ANDROID_FRONT, front2, ANDROID_BACK], {
      deviceId: "a-front",
      facing: "environment",
    }),
    "a-front-2",
  );
});

test("the direction a device reports wins over its label", () => {
  const mislabelled: CameraDevice = {
    deviceId: "m",
    label: "Front Camera",
    facing: "environment",
  };
  assert.equal(
    nextId([ANDROID_FRONT, mislabelled], { deviceId: "a-front" }),
    "m",
  );
  assert.equal(
    nextCamera({
      devices: [ANDROID_FRONT, mislabelled],
      current: { deviceId: "a-front" },
    })?.facing,
    "environment",
  );
});

test("with several cameras on the other side the plain lens is chosen", () => {
  assert.equal(nextId(IPHONE, { deviceId: "i-front" }), "i-back");
  // From any back lens the flip goes to the one front camera
  for (const id of ["i-triple", "i-ultra", "i-back", "i-tele"]) {
    assert.equal(nextId(IPHONE, { deviceId: id }), "i-front", id);
  }
});

test("with only extra lenses on the other side the first one is chosen", () => {
  const devices = IPHONE.filter((camera) => camera.deviceId !== "i-back");
  assert.equal(nextId(devices, { deviceId: "i-front" }), "i-triple");
});

test("a live camera missing from the list still flips by its direction", () => {
  assert.equal(
    nextId([ANDROID_FRONT, ANDROID_BACK], { deviceId: "gone", facing: "user" }),
    "a-back",
  );
  assert.equal(
    nextId([ANDROID_FRONT, ANDROID_BACK], { facing: "environment" }),
    "a-front",
  );
});

// ---------------------------------------------------------------------------
// nextCamera: the direction is not known, or nothing points the other way
// ---------------------------------------------------------------------------

test("two cameras of unknown direction: the other one", () => {
  assert.equal(nextId([PLAIN_A, PLAIN_B], { deviceId: "p-a" }), "p-b");
  assert.equal(nextId([PLAIN_A, PLAIN_B], { deviceId: "p-b" }), "p-a");
});

test("three cameras of unknown direction: the next in the list, wrapping", () => {
  const devices = [PLAIN_A, PLAIN_B, PLAIN_C];
  assert.equal(nextId(devices, { deviceId: "p-a" }), "p-b");
  assert.equal(nextId(devices, { deviceId: "p-b" }), "p-c");
  assert.equal(nextId(devices, { deviceId: "p-c" }), "p-a");
});

test("no camera on the other side: the next in the list", () => {
  const front2: CameraDevice = { deviceId: "a-front-2", label: "Front Camera" };
  assert.equal(
    nextId([ANDROID_FRONT, front2], { deviceId: "a-front" }),
    "a-front-2",
  );
  assert.equal(
    nextId([ANDROID_FRONT, front2], { deviceId: "a-front-2" }),
    "a-front",
  );
  // The track says "user" and so does every camera
  assert.equal(
    nextId([ANDROID_FRONT, front2], { deviceId: "a-front", facing: "user" }),
    "a-front-2",
  );
});

test("an unknown live camera and no known direction: nothing to flip to", () => {
  assert.equal(nextId([PLAIN_A, PLAIN_B], {}), null);
  assert.equal(nextId([PLAIN_A, PLAIN_B], { deviceId: "" }), null);
  assert.equal(nextId([PLAIN_A, PLAIN_B], { deviceId: "gone" }), null);
  assert.equal(nextId([ANDROID_FRONT, ANDROID_BACK], {}), null);
  // A known direction with nothing on the other side and no place in the
  // list to step from
  assert.equal(
    nextId([PLAIN_A, PLAIN_B], { deviceId: "gone", facing: "user" }),
    null,
  );
});

// ---------------------------------------------------------------------------
// nextCamera: across every list
// ---------------------------------------------------------------------------

test("the answer is never the live camera, and always one from the list", () => {
  const lists: CameraDevice[][] = [
    [],
    [ANDROID_FRONT],
    [ANDROID_FRONT, ANDROID_BACK],
    [ANDROID_BACK, ANDROID_FRONT, ANDROID_BACK_2],
    IPHONE,
    [PLAIN_A, PLAIN_B],
    [PLAIN_A, PLAIN_B, PLAIN_C],
    [PLAIN_A, ANDROID_FRONT, PLAIN_B, ANDROID_BACK],
    [ANDROID_FRONT, { ...ANDROID_FRONT }, ANDROID_BACK],
  ];
  const facings: (CameraFacing | undefined)[] = [
    undefined,
    "user",
    "environment",
  ];

  let answers = 0;
  for (const devices of lists) {
    const ids = [undefined, "gone", ...devices.map((c) => c.deviceId)];
    for (const deviceId of ids) {
      for (const facing of facings) {
        const next = nextCamera({ devices, current: { deviceId, facing } });
        const row = JSON.stringify({ devices, deviceId, facing });
        if (!next) continue;

        answers++;
        assert.notEqual(next.deviceId, deviceId, row);
        assert.ok(
          devices.some((camera) => camera.deviceId === next.deviceId),
          row,
        );
      }
    }
  }

  // The loop saw real answers, so it did not only compare nothing
  assert.ok(answers > 50, String(answers));
});

test("entries that are not cameras are skipped, and the list is not changed", () => {
  const devices = [
    null,
    undefined,
    "a-back",
    { deviceId: 7, label: "camera2 0, facing back" },
    { label: "camera2 0, facing back" },
    Object.freeze({ ...ANDROID_FRONT }),
    Object.freeze({ deviceId: "x", label: 5, facing: "sideways" }),
    Object.freeze({ ...ANDROID_BACK }),
  ] as unknown as CameraDevice[];
  Object.freeze(devices);
  const before = JSON.stringify(devices);

  const next = nextCamera({ devices, current: { deviceId: "a-front" } });
  assert.deepEqual(next, {
    deviceId: "a-back",
    label: "camera2 0, facing back",
    facing: "environment",
  });
  assert.equal(JSON.stringify(devices), before);

  // A direction that is not one of the two is treated as not given
  assert.equal(
    nextId(devices, {
      deviceId: "a-front",
      facing: "sideways" as unknown as CameraFacing,
    }),
    "a-back",
  );
});
