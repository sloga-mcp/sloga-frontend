// Unit spec for the gamepad-leg mapping (couch co-op §2.6 part 2) —
//   node --conditions=browser --test components/rtc/rcPadLeg.test.ts
//
// This shapes REAL injected input, so the failure mode that matters is a
// frame the sharer refuses (loud teardown mid-leg) or a button that maps to
// a different button than the guest pressed (silent lie). Every test pins
// one of those.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NEUTRAL_PAD,
  PAD_BUTTON_DEFINED,
  type PadInput,
  XINPUT_BIT,
  XINPUT_NAME,
  pressedEdges,
  readPad,
} from "./rcPadLeg.ts";

/** A synthetic pad with the named W3C indices pressed. */
function pad(pressed: number[], axes: number[] = [0, 0, 0, 0]): PadInput {
  const buttons = Array.from({ length: 17 }, (_, i) => ({
    pressed: pressed.includes(i),
    value: pressed.includes(i) ? 1 : 0,
  }));
  return { buttons, axes };
}

test("index 11 maps to R3 (0x0080), never the reserved 0x0800", () => {
  // The whole reason the table exists: `1 << 11` is 0x0800, the one gap in
  // XInput's mask, and the sharer tears the session down on it.
  assert.equal(XINPUT_BIT[11], 0x0080);
  assert.equal(readPad(pad([11])).buttons, 0x0080);
});

test("no combination of W3C buttons can set 0x0800", () => {
  const all = readPad(pad(Array.from({ length: 17 }, (_, i) => i)));
  assert.equal(all.buttons & 0x0800, 0);
  assert.equal(all.buttons & ~PAD_BUTTON_DEFINED, 0);
});

test("every mapped bit is one the decoder accepts, and each is distinct", () => {
  const bits = Object.values(XINPUT_BIT);
  const union = bits.reduce((a, b) => a | b, 0);
  assert.equal(union & ~PAD_BUTTON_DEFINED, 0);
  // A duplicate bit would silently merge two physical buttons into one.
  assert.equal(new Set(bits).size, bits.length);
});

test("triggers ride values 6/7 as 0-255, not the button mask", () => {
  const p = pad([]);
  (p.buttons as { pressed: boolean; value: number }[])[6] = {
    pressed: true,
    value: 0.5,
  };
  const frame = readPad(p);
  assert.equal(frame.buttons, 0);
  assert.equal(frame.leftTrigger, 128);
  assert.equal(frame.rightTrigger, 0);
});

test("Y axes are inverted (W3C down-positive → XInput up-positive)", () => {
  const frame = readPad(pad([], [0.5, 0.5, -0.25, -1]));
  assert.equal(frame.lx, 16384);
  // One LSB off `-lx` because the inversion happens inside the rounding
  // (deliberately — see the overflow note in `readPad`), not after it.
  assert.equal(frame.ly, -16383);
  assert.equal(frame.rx, -8192);
  assert.equal(frame.ry, 32767);
});

test("axes clamp rather than wrap on out-of-range input", () => {
  // -1 * 32767 rounds fine, but a drifting axis reporting -1.0001 must not
  // overflow into a full-positive deflection.
  const frame = readPad(pad([], [1.5, -1.5, 0, 0]));
  assert.equal(frame.lx, 32767);
  assert.equal(frame.ly, 32767);
});

test("guide (index 16) is forwarded as 0x0400", () => {
  assert.equal(readPad(pad([16])).buttons, 0x0400);
});

test("a pad with no standard mapping extras reads neutral", () => {
  assert.deepEqual(readPad(pad([])), { ...NEUTRAL_PAD });
});

test("pressedEdges reports rising edges only", () => {
  // A (0x1000) held, B (0x2000) newly down, X (0x4000) released.
  assert.deepEqual(pressedEdges(0x1000 | 0x4000, 0x1000 | 0x2000), ["B"]);
  // No change → no actuations.
  assert.deepEqual(pressedEdges(0x1000, 0x1000), []);
  // Release only → no actuations.
  assert.deepEqual(pressedEdges(0x1000, 0), []);
});

test("every mapped bit has a name for the readout", () => {
  for (const bit of Object.values(XINPUT_BIT)) {
    assert.ok(XINPUT_NAME[bit], `bit 0x${bit.toString(16)} unnamed`);
  }
});
