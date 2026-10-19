// Unit spec for the context-menu positioning chain. Run with Node's built-in
// runner from packages/client:
//   node --test --conditions=browser components/ui/components/floating/contextMenuPosition.test.ts
// Declared test count: 4 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
//
// Runs the REAL floating-ui middleware over a stand-in platform: a window of
// a given size and a 200x396 menu whose height follows the max-height the
// chain sets, the way the menu's CSS does. Browser evidence for the same
// cases (real layout, 300px iframes) was gathered with a harness on 10-18.
//
// Known-bad control: the last test runs the same checks over the chain that
// was reverted on 10-18 (`shift({ crossAxis: true })` with the default
// vertical shift) and requires them to FAIL.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type Middleware,
  type Platform,
  computePosition,
  flip,
  offset,
  shift,
} from "@floating-ui/dom";

import {
  CONTEXT_MENU_MAX_HEIGHT,
  contextMenuMiddleware,
} from "./contextMenuPosition.ts";

const MENU = { width: 200, height: 396 };

/** Padding above the first item and below the last (ContextMenu's gap-md) */
const MENU_PADDING = 8;

type FakeMenu = { style: { setProperty(name: string, value: string): void } };

/**
 * Place a menu at the pointer in a window of the given size
 */
async function place(
  middleware: Middleware[],
  view: { width: number; height: number },
  x: number,
  y: number,
) {
  let maxHeight = Infinity;
  const menu: FakeMenu = {
    style: {
      setProperty(name, value) {
        assert.equal(name, CONTEXT_MENU_MAX_HEIGHT);
        maxHeight = parseFloat(value);
      },
    },
  };
  const dimensions = () => ({
    width: MENU.width,
    height: Math.min(MENU.height, maxHeight),
  });

  // Only the calls these middleware make; floating-ui checks the optional
  // ones (offset parent, scale, RTL) before calling them
  const platform = {
    getElementRects: () => ({
      reference: { x, y, width: 0, height: 0 },
      floating: { x: 0, y: 0, ...dimensions() },
    }),
    getClippingRect: () => ({ x: 0, y: 0, ...view }),
    getDimensions: dimensions,
  } as unknown as Platform;

  // Same virtual element as FloatingManager's context menus
  const reference = {
    getBoundingClientRect: () => ({
      x,
      y,
      left: x,
      right: x,
      top: y,
      bottom: y,
      width: 0,
      height: 0,
    }),
  };

  const position = await computePosition(
    reference,
    menu as unknown as HTMLElement,
    { placement: "right-start", middleware, platform },
  );
  const { width, height } = dimensions();
  return {
    left: position.x,
    top: position.y,
    right: position.x + width,
    bottom: position.y + height,
  };
}

const WINDOWS = [
  { width: 300, height: 720 },
  { width: 300, height: 600 },
  { width: 300, height: 450 },
  { width: 1366, height: 768 },
];

function pointsIn(view: { width: number; height: number }) {
  const points: [number, number][] = [];
  for (let x = 10; x < view.width; x += 35) {
    for (let y = 10; y < view.height; y += 30) points.push([x, y]);
  }
  return points;
}

/**
 * Everything wrong with one placement, empty when it is fine
 */
async function problems(middleware: () => Middleware[]) {
  const found: string[] = [];
  for (const view of WINDOWS) {
    for (const [x, y] of pointsIn(view)) {
      const r = await place(middleware(), view, x, y);
      const at = `${view.width}x${view.height} @ (${x},${y})`;
      if (r.left < 0 || r.top < 0 || r.right > view.width) {
        found.push(`${at}: outside the window`);
      }
      if (r.bottom > view.height) found.push(`${at}: below the window`);
      const overItem =
        x >= r.left &&
        x < r.right &&
        y >= r.top + MENU_PADDING &&
        y < r.bottom - MENU_PADDING;
      if (overItem) found.push(`${at}: pointer over an item`);
    }
  }
  return found;
}

test("the menu stays inside the window and never puts an item under the pointer", async () => {
  assert.deepEqual(await problems(contextMenuMiddleware), []);
});

test("one menu edge sits exactly at the pointer", async () => {
  for (const view of WINDOWS) {
    for (const [x, y] of pointsIn(view)) {
      const r = await place(contextMenuMiddleware(), view, x, y);
      assert.ok(
        r.top === y || r.bottom === y,
        `${view.width}x${view.height} @ (${x},${y}): top ${r.top}, bottom ${r.bottom}`,
      );
    }
  }
});

test("a menu with room keeps its full height; a short window makes it scroll", async () => {
  const roomy = await place(
    contextMenuMiddleware(),
    { width: 1366, height: 768 },
    100,
    100,
  );
  assert.equal(roomy.bottom - roomy.top, MENU.height);
  assert.equal(roomy.top, 100);
  assert.equal(roomy.left, 105);

  // 300x600, pointer at (150,340): neither side fits 396px, so it opens
  // above (more room), capped 8px from the top, and moves left into view
  const short = await place(
    contextMenuMiddleware(),
    { width: 300, height: 600 },
    150,
    340,
  );
  assert.deepEqual(short, { left: 92, top: 8, right: 292, bottom: 340 });
});

test("control: the reverted shift({ crossAxis: true }) chain fails these checks", async () => {
  const found = await problems(() => [
    offset(5),
    flip(),
    shift({ crossAxis: true }),
  ]);
  assert.ok(
    found.some((problem) => problem.endsWith("pointer over an item")),
    "the control must put an item under the pointer somewhere",
  );
});
