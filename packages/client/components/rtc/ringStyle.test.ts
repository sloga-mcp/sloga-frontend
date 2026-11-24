// Unit spec for the incoming-call style rule. Run with Node's built-in
// runner from packages/client:
//   node --test --conditions=browser components/rtc/ringStyle.test.ts
// Declared test count: 9 (compare against the runner's pass count, since the
// runner also exits 0 when it finds no tests at all).
// Focus: a locked phone is full screen whatever the setting says; "auto"
// keeps what the app did before the setting existed; an explicit choice wins
// over Slim view; a stored value that is not one of the three is not kept
// and reads as "auto".
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RING_STYLES,
  isRingStyle,
  ringFullScreen,
  ringStyleAfterToggle,
} from "./ringStyle.ts";

const BOOLS = [false, true] as const;

test("a locked phone is always full screen", () => {
  for (const slim of BOOLS) {
    for (const style of [...RING_STYLES, undefined, "nonsense", 7]) {
      assert.equal(ringFullScreen({ locked: true, slim, style }), true);
    }
  }
});

test("auto keeps the old behaviour: full screen only in Slim view", () => {
  assert.equal(
    ringFullScreen({ locked: false, slim: true, style: "auto" }),
    true,
  );
  assert.equal(
    ringFullScreen({ locked: false, slim: false, style: "auto" }),
    false,
  );
});

test("banner is a banner on an unlocked phone, Slim view or not", () => {
  for (const slim of BOOLS) {
    assert.equal(
      ringFullScreen({ locked: false, slim, style: "banner" }),
      false,
    );
  }
});

test("full is full screen, Slim view or not", () => {
  for (const slim of BOOLS) {
    assert.equal(ringFullScreen({ locked: false, slim, style: "full" }), true);
  }
});

test("an unknown or missing style reads as auto", () => {
  for (const style of [undefined, null, "", "Banner", "FULL", 1, {}]) {
    for (const slim of BOOLS) {
      assert.equal(ringFullScreen({ locked: false, slim, style }), slim);
    }
  }
});

test("the default is auto and the list holds exactly the three values", () => {
  assert.deepEqual([...RING_STYLES], ["auto", "full", "banner"]);
});

test("isRingStyle accepts the three values and nothing else", () => {
  for (const style of RING_STYLES) assert.equal(isRingStyle(style), true);
  for (const value of [undefined, null, "", "Banner", "popup", 0, true, {}]) {
    assert.equal(isRingStyle(value), false);
  }
});

test("flipping the switch stores the opposite, never auto", () => {
  assert.equal(ringStyleAfterToggle(true), "banner");
  assert.equal(ringStyleAfterToggle(false), "full");
});

test("a flip changes what an unlocked phone shows, in every starting state", () => {
  for (const slim of BOOLS) {
    for (const style of RING_STYLES) {
      const before = ringFullScreen({ locked: false, slim, style });
      const after = ringFullScreen({
        locked: false,
        slim,
        style: ringStyleAfterToggle(before),
      });
      assert.equal(after, !before);
    }
  }
});
