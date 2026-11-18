// Unit spec for the iOS press-and-hold gesture. Run with Node's built-in
// runner from packages/client:
//   node --test --conditions=browser components/ui/components/floating/longPress.test.ts
// Declared test count: 12 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
//
// Timers are driven by hand: `setTimer` records the callback and `elapse`
// runs it, so each case states exactly when the finger is held long enough.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LONG_PRESS_MS,
  LONG_PRESS_SLOP_PX,
  createLongPress,
  isIosTouch,
} from "./longPress.ts";

function harness(claim = true) {
  const fired: { target: string; x: number; y: number }[] = [];
  let pending: { run: () => void; ms: number } | undefined;
  let cleared = 0;

  const press = createLongPress<string>({
    fire(target, x, y) {
      fired.push({ target, x, y });
      return claim;
    },
    setTimer(run, ms) {
      pending = { run, ms };
      return pending;
    },
    clearTimer(handle) {
      if (handle === pending) pending = undefined;
      cleared++;
    },
  });

  return {
    press,
    fired,
    get cleared() {
      return cleared;
    },
    get delay() {
      return pending?.ms;
    },
    /** The finger has been held long enough */
    elapse() {
      const timer = pending;
      pending = undefined;
      timer?.run();
    },
  };
}

test("a still finger held for LONG_PRESS_MS fires once, at the start point", () => {
  const h = harness();
  h.press.start("message", 100, 200, 1);
  assert.equal(h.delay, LONG_PRESS_MS);
  h.elapse();
  assert.deepEqual(h.fired, [{ target: "message", x: 100, y: 200 }]);
  h.elapse();
  assert.equal(h.fired.length, 1);
});

test("lifting after a claimed press asks for the trailing tap to be cancelled", () => {
  const h = harness(true);
  h.press.start("message", 0, 0, 1);
  h.elapse();
  assert.equal(h.press.end(), true);
  // and only for that release
  assert.equal(h.press.end(), false);
});

test("an unclaimed press leaves the tap alone", () => {
  const h = harness(false);
  h.press.start("blank", 0, 0, 1);
  h.elapse();
  assert.equal(h.fired.length, 1);
  assert.equal(h.press.end(), false);
});

test("lifting early cancels: nothing fires and the tap goes through", () => {
  const h = harness();
  h.press.start("message", 0, 0, 1);
  assert.equal(h.press.end(), false);
  h.elapse();
  assert.equal(h.fired.length, 0);
});

test("drift within the slop keeps the press alive", () => {
  const h = harness();
  h.press.start("message", 50, 50, 1);
  h.press.move(50 + LONG_PRESS_SLOP_PX, 50 - LONG_PRESS_SLOP_PX, 1);
  h.elapse();
  assert.equal(h.fired.length, 1);
});

test("drift past the slop on either axis is a scroll and cancels", () => {
  for (const [dx, dy] of [
    [LONG_PRESS_SLOP_PX + 1, 0],
    [0, -(LONG_PRESS_SLOP_PX + 1)],
  ]) {
    const h = harness();
    h.press.start("message", 50, 50, 1);
    h.press.move(50 + dx, 50 + dy, 1);
    h.elapse();
    assert.equal(h.fired.length, 0, `moved ${dx},${dy}`);
  }
});

test("a non-number position cancels rather than counting as still", () => {
  const h = harness();
  h.press.start("message", 50, 50, 1);
  h.press.move(Number.NaN, 50, 1);
  h.elapse();
  assert.equal(h.fired.length, 0);
});

test("a second finger cancels, both on start and on move", () => {
  const a = harness();
  a.press.start("message", 0, 0, 1);
  a.press.start("message", 5, 5, 2);
  a.elapse();
  assert.equal(a.fired.length, 0);

  const b = harness();
  b.press.start("message", 0, 0, 1);
  b.press.move(0, 0, 2);
  b.elapse();
  assert.equal(b.fired.length, 0);
});

test("cancel() stops a pending press and clears its timer", () => {
  const h = harness();
  h.press.start("message", 0, 0, 1);
  h.press.cancel();
  assert.equal(h.cleared, 1);
  h.elapse();
  assert.equal(h.fired.length, 0);
});

test("a new press replaces the old one and fires at its own target", () => {
  const h = harness();
  h.press.start("first", 0, 0, 1);
  h.press.start("second", 9, 9, 1);
  h.elapse();
  assert.deepEqual(h.fired, [{ target: "second", x: 9, y: 9 }]);
});

test("isIosTouch: the iPhone app and Safari on iPhone/iPad, never Android", () => {
  const IPHONE =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15";
  const ANDROID =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130 Mobile";
  const MAC =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

  assert.equal(isIosTouch("ios", MAC, "MacIntel", 5), true);
  assert.equal(isIosTouch("web", IPHONE, "iPhone", 5), true);
  // iPadOS Safari presents as a Mac with touch points
  assert.equal(isIosTouch("web", MAC, "MacIntel", 5), true);

  assert.equal(isIosTouch("android", ANDROID, "Linux armv8l", 5), false);
  assert.equal(isIosTouch("web", ANDROID, "Linux armv8l", 5), false);
  assert.equal(isIosTouch("web", MAC, "MacIntel", 0), false);
  assert.equal(isIosTouch("electron", MAC, "MacIntel", 0), false);
});

// LONG_PRESS_SLOP_PX mirrors the constant of the same name in Draggable.tsx,
// which a node test cannot import; this pin makes a change here deliberate.
test("timing constants are pinned", () => {
  assert.equal(LONG_PRESS_MS, 500);
  assert.equal(LONG_PRESS_SLOP_PX, 10);
});
