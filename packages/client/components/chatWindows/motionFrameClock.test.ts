/**
 * Run with:
 *
 *     node --conditions=browser --test components/chatWindows/motionFrameClock.test.ts
 *
 * Pins the `@motionone/dom` patch (`patches/@motionone__dom@10.18.0.patch`).
 *
 * Motion One batches every enter / exit animation into one
 * `requestAnimationFrame`. Chat windows are same-realm children rendered from
 * the main realm, so that global is the MAIN window's, and it stops firing
 * while the main window is minimized or hidden. A Motion element in a chat
 * window (every `Dialog`, the image viewer) then sat at its `initial`
 * opacity 0: the scrim dimmed the window and nothing else appeared. The patch
 * keeps one batch per window and flushes each on its own window's frame.
 *
 * Windows are faked as a frame queue that only runs when the spec says so; a
 * main frame that never runs is a hidden main window.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, it } from "node:test";

// `@motionone/dom` is only a dependency of `solid-motionone`, so resolve it
// from there (pnpm does not hoist it next to the client).
const fromMotion = createRequire(
  createRequire(import.meta.url).resolve("solid-motionone"),
);

type FakeWindow = {
  closed: boolean;
  frames: (() => void)[];
  requestAnimationFrame(cb: () => void): number;
  /** Run the frame callbacks queued so far. */
  frame(): void;
};

function fakeWindow(): FakeWindow {
  const win: FakeWindow = {
    closed: false,
    frames: [],
    requestAnimationFrame(cb) {
      win.frames.push(cb);
      return win.frames.length;
    },
    frame() {
      const due = win.frames.splice(0);
      for (const cb of due) cb();
    },
  };
  return win;
}

type FakeState = {
  getElement(): unknown;
  getDepth(): number;
  animateUpdates(): Generator<undefined, void>;
};

/** A motion state whose element lives in `view`, logging its two phases. */
function stateIn(
  view: FakeWindow,
  name: string,
  log: string[],
  depth = 0,
): FakeState {
  const element = { ownerDocument: { defaultView: view } };
  return {
    getElement: () => element,
    getDepth: () => depth,
    *animateUpdates() {
      log.push(`${name}:read`);
      yield;
      log.push(`${name}:write`);
    },
  };
}

type Scheduler = {
  scheduleAnimation(state: FakeState): void;
  unscheduleAnimation(state: FakeState): void;
};

/**
 * A fresh copy of the scheduler module per test: its batches are module
 * state, and a test that leaves one pending would leak it into the next.
 */
function loadScheduler(): Scheduler {
  const path = fromMotion.resolve(
    "@motionone/dom/dist/state/utils/schedule.cjs.js",
  );
  delete fromMotion.cache[path];
  return fromMotion(path);
}

const globals = globalThis as { window?: unknown };
let main: FakeWindow;
let scheduler: Scheduler;

beforeEach(() => {
  main = fakeWindow();
  globals.window = main;
  scheduler = loadScheduler();
});

afterEach(() => {
  delete globals.window;
});

describe("motion scheduler frame clock", () => {
  it("flushes a chat window's animation on that window's frame while main's frame never runs", () => {
    const child = fakeWindow();
    const log: string[] = [];

    scheduler.scheduleAnimation(stateIn(child, "viewer", log));

    assert.equal(main.frames.length, 0, "nothing waits on the main clock");
    child.frame();
    assert.deepEqual(log, ["viewer:read", "viewer:write"]);
  });

  it("still flushes main-window animations on main's frame", () => {
    const child = fakeWindow();
    const log: string[] = [];

    scheduler.scheduleAnimation(stateIn(main, "menu", log));

    assert.equal(child.frames.length, 0);
    main.frame();
    assert.deepEqual(log, ["menu:read", "menu:write"]);
  });

  it("keeps one batch per window, so a hidden main does not hold a child's animation back", () => {
    const child = fakeWindow();
    const log: string[] = [];

    // Main schedules first: before the patch the child's state joined this
    // batch and waited on main's frame with it.
    scheduler.scheduleAnimation(stateIn(main, "main", log));
    scheduler.scheduleAnimation(stateIn(child, "child", log));

    child.frame();
    assert.deepEqual(log, ["child:read", "child:write"]);

    main.frame();
    assert.deepEqual(log, [
      "child:read",
      "child:write",
      "main:read",
      "main:write",
    ]);
  });

  it("asks a window for one frame per batch and runs every read before any write, by depth", () => {
    const child = fakeWindow();
    const log: string[] = [];

    scheduler.scheduleAnimation(stateIn(child, "deep", log, 2));
    scheduler.scheduleAnimation(stateIn(child, "shallow", log, 0));

    assert.equal(child.frames.length, 1);
    child.frame();
    assert.deepEqual(log, [
      "shallow:read",
      "deep:read",
      "shallow:write",
      "deep:write",
    ]);
  });

  it("schedules a new frame once a batch has flushed", () => {
    const child = fakeWindow();
    const log: string[] = [];
    const state = stateIn(child, "a", log);

    scheduler.scheduleAnimation(state);
    child.frame();
    scheduler.scheduleAnimation(state);

    assert.equal(child.frames.length, 1);
    child.frame();
    assert.deepEqual(log, ["a:read", "a:write", "a:read", "a:write"]);
  });

  it("unschedules a state from its window's batch", () => {
    const child = fakeWindow();
    const log: string[] = [];
    const gone = stateIn(child, "gone", log);

    scheduler.scheduleAnimation(stateIn(child, "kept", log));
    scheduler.scheduleAnimation(gone);
    scheduler.unscheduleAnimation(gone);

    child.frame();
    assert.deepEqual(log, ["kept:read", "kept:write"]);
  });

  it("falls back to main's frame for an element whose window has closed", () => {
    const child = fakeWindow();
    child.closed = true;
    const log: string[] = [];

    scheduler.scheduleAnimation(stateIn(child, "orphan", log));

    assert.equal(child.frames.length, 0);
    main.frame();
    assert.deepEqual(log, ["orphan:read", "orphan:write"]);
  });

  it("drops a pending batch whose window closed before its frame ran", () => {
    const child = fakeWindow();
    const log: string[] = [];

    scheduler.scheduleAnimation(stateIn(child, "stale", log));
    child.closed = true;

    // A new child batch must not be appended to the dead window's one.
    const next = fakeWindow();
    scheduler.scheduleAnimation(stateIn(next, "fresh", log));
    next.frame();
    child.frame();
    assert.deepEqual(log, ["fresh:read", "fresh:write"]);
  });
});

describe("motion state element accessor", () => {
  it("exposes the mounted element, which the scheduler reads its window from", () => {
    const { createMotionState } = fromMotion(
      "@motionone/dom/dist/state/index.cjs.js",
    ) as {
      createMotionState(): { getElement(): unknown; mount(el: unknown): void };
    };
    const state = createMotionState();
    const element = { ownerDocument: { defaultView: fakeWindow() } };

    assert.equal(state.getElement(), undefined);
    state.mount(element);
    assert.equal(state.getElement(), element);
  });

  it("is patched in the ES build too, which is what vite bundles", () => {
    // pnpm 10+ ignores a patch declared in the wrong place and installs the
    // package unpatched, so check the installed files, not the declaration.
    const read = (file: string) =>
      readFileSync(fromMotion.resolve(`@motionone/dom/dist/${file}`), "utf8");

    assert.match(
      read("state/utils/schedule.es.js"),
      /view\.requestAnimationFrame\(/,
    );
    assert.match(read("state/index.es.js"), /getElement: \(\) => element,/);
  });
});
