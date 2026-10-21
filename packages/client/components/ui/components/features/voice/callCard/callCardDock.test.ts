// Unit spec for where the docked call card may sit — run with Node's built-in
// runner, from packages/client:
//   node --test --conditions=browser components/ui/components/features/voice/callCard/callCardDock.test.ts
// Focus: a zero rect (a node that is not laid out) and an off-screen rect (the
// channel pane parked behind the phone drawer) are never dock targets, and the
// rect comparator never reports a real geometry change as "same".
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MIN_DOCK_WIDTH,
  sameDock,
  sameRect,
  usableDockRect,
} from "./callCardDock.ts";

const PHONE = { width: 375, height: 812 };
const docked = { x: 8, y: 64, width: 359, height: 0 };

test("a laid-out mount on a phone is a dock target", () => {
  assert.equal(usableDockRect(docked, PHONE), true);
});

test("no rect is not a dock target", () => {
  assert.equal(usableDockRect(undefined, PHONE), false);
});

test("the all-zero rect of a node that is not laid out is rejected", () => {
  assert.equal(
    usableDockRect({ x: 0, y: 0, width: 0, height: 0 }, PHONE),
    false,
  );
});

test("a sliver narrower than the minimum is rejected, the minimum is not", () => {
  assert.equal(
    usableDockRect({ ...docked, width: MIN_DOCK_WIDTH - 1 }, PHONE),
    false,
  );
  assert.equal(
    usableDockRect({ ...docked, width: MIN_DOCK_WIDTH }, PHONE),
    true,
  );
});

test("NaN geometry is rejected", () => {
  assert.equal(usableDockRect({ ...docked, width: NaN }, PHONE), false);
});

test("the pane parked behind the open drawer (one viewport right) is rejected", () => {
  assert.equal(usableDockRect({ ...docked, x: 375 + 8 }, PHONE), false);
});

test("a rect hanging off either side or the top is rejected", () => {
  assert.equal(usableDockRect({ ...docked, x: -40 }, PHONE), false);
  assert.equal(usableDockRect({ ...docked, x: 100 }, PHONE), false);
  assert.equal(usableDockRect({ ...docked, y: -40 }, PHONE), false);
  assert.equal(usableDockRect({ ...docked, y: 812 }, PHONE), false);
});

test("sub-pixel overhang at the right edge is tolerated", () => {
  assert.equal(
    usableDockRect({ x: 8.4, y: 64, width: 367.4, height: 0 }, PHONE),
    true,
  );
});

test("sameRect: absent vs absent is the same, absent vs present is not", () => {
  assert.equal(sameRect(undefined, undefined), true);
  assert.equal(sameRect(undefined, docked), false);
  assert.equal(sameRect(docked, undefined), false);
});

test("sameRect: equal geometry in a new object is the same", () => {
  assert.equal(sameRect(docked, { ...docked }), true);
  assert.equal(sameRect(docked, { ...docked, x: 8.3 }), true);
});

test("sameRect: a change to ANY field is a change", () => {
  for (const key of ["x", "y", "width", "height"] as const) {
    assert.equal(
      sameRect(docked, { ...docked, [key]: docked[key] + 5 }),
      false,
      key,
    );
  }
});

test("sameDock: absent vs absent is the same, absent vs present is not", () => {
  const channel = {};
  assert.equal(sameDock(undefined, undefined), true);
  assert.equal(sameDock(undefined, { channel, rect: docked }), false);
  assert.equal(sameDock({ channel, rect: docked }, undefined), false);
});

test("sameDock: same channel over the same geometry is the same", () => {
  const channel = {};
  assert.equal(
    sameDock({ channel, rect: docked }, { channel, rect: { ...docked } }),
    true,
  );
});

test("sameDock: another channel, or a moved rect, is a change", () => {
  const channel = {};
  assert.equal(
    sameDock({ channel, rect: docked }, { channel: {}, rect: docked }),
    false,
  );
  assert.equal(
    sameDock(
      { channel, rect: docked },
      { channel, rect: { ...docked, width: 200 } },
    ),
    false,
  );
});
