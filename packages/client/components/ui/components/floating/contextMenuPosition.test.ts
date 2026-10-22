// Unit spec for the context-menu positioning chain. Run with Node's built-in
// runner from packages/client:
//   node --test --conditions=browser components/ui/components/floating/contextMenuPosition.test.ts
// Declared test count: 7 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
//
// Runs the REAL floating-ui middleware over a stand-in platform: a window of
// a given size and a menu (200x396 like the friend menu, or 220x700 like a
// moderator's member menu) whose height follows the max-height the chain
// sets, the way the menu's CSS does. Browser evidence for the same cases
// (real layout, iframes) was gathered with a harness on 10-18.
//
// Known-bad controls: the last two tests run the same checks over the two
// chains this one replaced, and require them to FAIL: the
// `shift({ crossAxis: true })` chain reverted on 10-18 (puts an item under
// the pointer), and the first version of this chain (never shifts
// vertically, so a menu that fits the main window scrolls anyway).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type Middleware,
  type Platform,
  computePosition,
  flip,
  offset,
  shift,
  size,
} from "@floating-ui/dom";

import {
  CONTEXT_MENU_MAX_HEIGHT,
  contextMenuMiddleware,
} from "./contextMenuPosition.ts";

type Menu = { width: number; height: number };

const FRIEND_MENU: Menu = { width: 200, height: 396 };
const MEMBER_MENU: Menu = { width: 220, height: 700 };

/** Padding above the first item and below the last (ContextMenu's gap-md) */
const MENU_PADDING = 8;

type View = { width: number; height: number };

type FakeMenu = { style: { setProperty(name: string, value: string): void } };

/**
 * Place a menu at the pointer in a window of the given size
 */
async function place(
  middleware: Middleware[],
  view: View,
  x: number,
  y: number,
  natural: Menu = FRIEND_MENU,
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
    width: natural.width,
    height: Math.min(natural.height, maxHeight),
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

const NARROW: View[] = [
  { width: 300, height: 720 },
  { width: 300, height: 600 },
  { width: 300, height: 450 },
];

const WIDE: View[] = [
  { width: 1366, height: 768 },
  { width: 1366, height: 950 },
];

const CASES: { view: View; menu: Menu }[] = [...NARROW, ...WIDE].flatMap(
  (view) => [
    { view, menu: FRIEND_MENU },
    { view, menu: MEMBER_MENU },
  ],
);

function pointsIn(view: View) {
  const points: [number, number][] = [];
  const stepX = view.width > 600 ? 95 : 35;
  for (let x = 10; x < view.width; x += stepX) {
    for (let y = 10; y < view.height; y += 30) points.push([x, y]);
  }
  return points;
}

/**
 * Every bad placement over all cases: off the window, or an item under the
 * pointer
 */
async function problems(middleware: () => Middleware[]) {
  const found: string[] = [];
  for (const { view, menu } of CASES) {
    for (const [x, y] of pointsIn(view)) {
      const r = await place(middleware(), view, x, y, menu);
      const at = `${menu.height}px menu in ${view.width}x${view.height} @ (${x},${y})`;
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

/**
 * The first version of this chain: never a vertical shift
 */
function edgeOnlyChain(): Middleware[] {
  return [
    offset(5),
    flip({ padding: 8 }),
    size({
      padding: 8,
      apply({ availableHeight, elements }) {
        elements.floating.style.setProperty(
          CONTEXT_MENU_MAX_HEIGHT,
          `${Math.max(0, Math.floor(availableHeight))}px`,
        );
      },
    }),
    shift({ mainAxis: false, crossAxis: true, padding: 8 }),
  ];
}

test("the menu stays inside the window and never puts an item under the pointer", async () => {
  assert.deepEqual(await problems(contextMenuMiddleware), []);
});

test("a menu moved over the pointer keeps an edge exactly at it", async () => {
  let covering = 0;
  for (const { view, menu } of CASES) {
    for (const [x, y] of pointsIn(view)) {
      const r = await place(contextMenuMiddleware(), view, x, y, menu);
      if (x < r.left || x > r.right) continue;
      covering++;
      assert.ok(
        r.top === y || r.bottom === y,
        `${menu.height}px menu in ${view.width}x${view.height} @ (${x},${y}): top ${r.top}, bottom ${r.bottom}`,
      );
    }
  }
  // Not vacuous: the narrow windows force the menu over the pointer
  assert.ok(covering > 100, `only ${covering} placements covered the pointer`);
});

test("in a wide window the menu sits beside the pointer at full height when the window fits it", async () => {
  for (const view of WIDE) {
    for (const [x, y] of pointsIn(view)) {
      const r = await place(contextMenuMiddleware(), view, x, y, MEMBER_MENU);
      const at = `${view.width}x${view.height} @ (${x},${y})`;
      assert.ok(x < r.left || x > r.right, `${at}: covers the pointer`);
      assert.equal(r.bottom - r.top, MEMBER_MENU.height, `${at}: cut short`);
    }
  }
});

test("known placements", async () => {
  // Room below: opens there, right of the pointer
  assert.deepEqual(
    await place(
      contextMenuMiddleware(),
      { width: 1366, height: 768 },
      100,
      100,
    ),
    { left: 105, top: 100, right: 305, bottom: 496 },
  );

  // Moderator menu at mid-height in a 950px window: neither side has 700px,
  // so it slides up into view at full height, beside the pointer
  assert.deepEqual(
    await place(
      contextMenuMiddleware(),
      { width: 1366, height: 950 },
      200,
      475,
      MEMBER_MENU,
    ),
    { left: 205, top: 242, right: 425, bottom: 942 },
  );

  // 300x600 friends window, pointer at (150,340): it has to cover the
  // pointer, so it opens above (more room), bottom edge at the pointer,
  // capped 8px from the top, moved left into view
  assert.deepEqual(
    await place(contextMenuMiddleware(), { width: 300, height: 600 }, 150, 340),
    { left: 92, top: 8, right: 292, bottom: 340 },
  );
});

test("beside the pointer, a menu taller than the window scrolls within it", async () => {
  const r = await place(
    contextMenuMiddleware(),
    { width: 1366, height: 500 },
    200,
    250,
    MEMBER_MENU,
  );
  assert.deepEqual(r, { left: 205, top: 8, right: 425, bottom: 492 });
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

test("control: the edge-only chain cuts a menu short that fits the window", async () => {
  const r = await place(
    edgeOnlyChain(),
    { width: 1366, height: 950 },
    200,
    475,
    MEMBER_MENU,
  );
  assert.ok(
    r.bottom - r.top < MEMBER_MENU.height,
    `the control must scroll the 700px menu, got ${r.bottom - r.top}px`,
  );
});
