// Unit spec for the chat windows' title bar state. Run with Node's built-in
// runner from packages/client:
//   node --test --conditions=browser components/chatWindows/chatWindowFrame.test.ts
// Declared test count: 27 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
//
// Focus (plan C7, audit M4): the per-label maximized state the shell pushes
// is reactive, per window, and forgotten on close; our maximize button's
// toggle reply counts only if no push, newer toggle or forget for its label
// came in between, so a double click never leaves the wrong icon (Stage 6
// NIT); the tab drag flag is reactive, cleared by its end, by
// `clearStaleTabDrag`, and by itself after `TAB_DRAG_FLAG_TTL_MS`, and an old
// drag's timer never clears a newer drag.
// Timers are node:test's mock timers; the module reads `setTimeout` at call
// time, so it gets them. The bar's layout decisions (Wave 2 audit m2): which
// frame draws a bar, controls and the physical mac inset; the free space's
// region; which pointer events prove a drag stale; which drag events are
// files from outside over the window, and what each event a window reports
// does to the flag (Wave 2 audit m1).
//
// Main-titlebar plan M5, M8 (A9, A11): window fullscreen per label (`main`
// included) is reactive, forgotten with the window, and an `inset` bar drops
// the traffic lights' space only while its own window is fullscreen;
// `watchDragFlag` (moved here from ChatWindowsHost so main's bar can use it)
// listens in the capture phase for exactly DRAG_FLAG_EVENTS and drives the
// flag through dragFlagAction, and its listeners go with the owner or the
// returned stop, once.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { createComputed, createRoot } from "solid-js";

import * as shellToMain from "../client/shellToMain.ts";

import * as frame from "./chatWindowFrame.ts";

const LABELS = ["chat-1", "chat-2", "friends-window"];

afterEach(() => {
  frame.markTabDragEnd();
  for (const label of LABELS) frame.forgetWindow(label);
  frame.forgetWindow("main");
});

/** Every value `read` yields, starting with the current one, until disposed. */
function watch<T>(read: () => T): { seen: T[]; dispose: () => void } {
  const seen: T[] = [];
  const dispose = createRoot((dispose) => {
    createComputed(() => seen.push(read()));
    return dispose;
  });
  return { seen, dispose };
}

test("constants: bar height, mac inset fallback, drag TTL, shared label rule", () => {
  assert.equal(frame.TITLEBAR_HEIGHT, 32);
  assert.equal(frame.MAC_INSET_FALLBACK_PX, 78);
  assert.equal(frame.TAB_DRAG_FLAG_TTL_MS, 10_000);
  // Re-exported, not a second copy that could drift.
  assert.ok(frame.CHAT_WINDOW_LABEL_RE instanceof RegExp);
  assert.equal(frame.CHAT_WINDOW_LABEL_RE, shellToMain.CHAT_WINDOW_LABEL_RE);
  assert.equal(frame.MAC_INSET_PADDING, "env(titlebar-area-x, 78px)");
});

test("titleBarLayout: native draws nothing of ours", () => {
  for (const label of ["chat-1", undefined]) {
    assert.deepEqual(frame.titleBarLayout("native", label), {
      bar: false,
      controls: false,
      style: undefined,
    });
  }
});

test("titleBarLayout: buttons draws the controls only with a label", () => {
  assert.deepEqual(frame.titleBarLayout("buttons", "chat-1"), {
    bar: true,
    controls: true,
    style: undefined,
  });
  assert.deepEqual(frame.titleBarLayout("buttons", "friends-window"), {
    bar: true,
    controls: true,
    style: undefined,
  });
  // No label to address: still a bar (the window has no OS one), no buttons.
  assert.deepEqual(frame.titleBarLayout("buttons", undefined), {
    bar: true,
    controls: false,
    style: undefined,
  });
});

test("titleBarLayout: inset keeps the traffic lights clear, physically left", () => {
  for (const label of ["chat-1", undefined]) {
    const layout = frame.titleBarLayout("inset", label);
    // The OS draws the controls; never two sets.
    assert.equal(layout.bar, true);
    assert.equal(layout.controls, false);
    // Exactly `padding-left`: a logical `padding-inline-start` would move
    // the space to the right on an RTL page, away from the lights.
    assert.deepEqual(layout.style, { "padding-left": frame.MAC_INSET_PADDING });
  }
});

test("spacerRegion: a caption region unless a drag is live", () => {
  assert.equal(frame.spacerRegion(false), "drag");
  assert.equal(frame.spacerRegion(true), "no-drag");
});

test("isStaleDragPointer: a press, or a move with no button held", () => {
  const stale = (type: string, buttons: number) =>
    frame.isStaleDragPointer({ type, buttons });
  assert.equal(stale("pointerdown", 1), true);
  assert.equal(stale("pointerdown", 0), true);
  assert.equal(stale("pointermove", 0), true);
  // A move with a button held may be the drag itself (or a selection).
  assert.equal(stale("pointermove", 1), false);
  assert.equal(stale("pointermove", 2), false);
  // Anything else proves nothing.
  assert.equal(stale("pointerup", 0), false);
  assert.equal(stale("pointerleave", 0), false);
});

test("isFileDragOver: a dragenter or dragover that carries Files", () => {
  const enter = (types?: ArrayLike<string> | null) =>
    frame.isFileDragOver({
      type: "dragenter",
      dataTransfer: types === undefined ? undefined : types && { types },
    });
  assert.equal(enter(["Files", "application/x-moz-file"]), true);
  // An older engine's DOMStringList: array-like, not an array.
  assert.equal(enter({ length: 2, 0: "text/uri-list", 1: "Files" }), true);
  // A tab drag carries only text/plain.
  assert.equal(enter(["text/plain"]), false);
  assert.equal(enter([]), false);
  assert.equal(enter(null), false);
  assert.equal(enter(undefined), false);
  // Hovering keeps it raised (the TTL restarts on each dragover).
  const files = { types: ["Files"] };
  assert.equal(
    frame.isFileDragOver({ type: "dragover", dataTransfer: files }),
    true,
  );
  assert.equal(
    frame.isFileDragOver({ type: "dragover", dataTransfer: { types: [] } }),
    false,
  );
  // Leaving or ending is not files being over the window.
  for (const type of ["drop", "dragleave", "dragend", "pointermove"]) {
    assert.equal(
      frame.isFileDragOver({ type, dataTransfer: files }),
      false,
      type,
    );
  }
});

test("dragFlagAction: each event a chat window reports, mapped", () => {
  const files = { types: ["Files"] };
  const tab = { types: ["text/plain"] };
  const act = (
    type: string,
    extra: Partial<Parameters<typeof frame.dragFlagAction>[0]> = {},
  ) => frame.dragFlagAction({ type, ...extra });

  // Files from outside raise it, on entering and while hovering.
  assert.equal(act("dragenter", { dataTransfer: files, buttons: 1 }), "raise");
  assert.equal(act("dragover", { dataTransfer: files, buttons: 1 }), "raise");
  // A tab drag's own events leave it to TabStrip.
  assert.equal(act("dragenter", { dataTransfer: tab, buttons: 1 }), null);
  assert.equal(act("dragover", { dataTransfer: tab, buttons: 0 }), null);
  // A drop or dragend ends any drag, files or tab.
  assert.equal(act("drop", { dataTransfer: files, buttons: 0 }), "end");
  assert.equal(act("drop", { dataTransfer: tab }), "end");
  assert.equal(act("dragend", { dataTransfer: tab, buttons: 0 }), "end");
  // The pointer: as isStaleDragPointer.
  assert.equal(act("pointerdown", { buttons: 1 }), "stale");
  assert.equal(act("pointermove", { buttons: 0 }), "stale");
  assert.equal(act("pointermove", { buttons: 1 }), null);
  assert.equal(act("pointermove"), null);
  assert.equal(act("dragleave", { dataTransfer: files, buttons: 0 }), null);

  // The host listens for exactly the events that map to something.
  assert.deepEqual([...frame.DRAG_FLAG_EVENTS].sort(), [
    "dragend",
    "dragenter",
    "dragover",
    "drop",
    "pointerdown",
    "pointermove",
  ]);
});

test("maximized: per label, restored until the shell says otherwise", () => {
  for (const label of LABELS) assert.equal(frame.windowMaximized(label), false);
  frame.setWindowMaximized("chat-1", true);
  assert.equal(frame.windowMaximized("chat-1"), true);
  assert.equal(frame.windowMaximized("chat-2"), false);
  assert.equal(frame.windowMaximized("friends-window"), false);

  frame.setWindowMaximized("friends-window", true);
  frame.setWindowMaximized("chat-1", false);
  assert.equal(frame.windowMaximized("chat-1"), false);
  assert.equal(frame.windowMaximized("friends-window"), true);
});

test("maximized: reactive, and a repeated value notifies nobody", () => {
  const chat1 = watch(() => frame.windowMaximized("chat-1"));
  const chat2 = watch(() => frame.windowMaximized("chat-2"));
  frame.setWindowMaximized("chat-1", true);
  assert.deepEqual(chat1.seen, [false, true]);
  frame.setWindowMaximized("chat-1", true);
  assert.deepEqual(chat1.seen, [false, true], "a repeated true notified");
  frame.setWindowMaximized("chat-1", false);
  frame.setWindowMaximized("chat-1", false);
  assert.deepEqual(chat1.seen, [false, true, false], "a repeated false");
  const chat1Runs = chat1.seen.length;
  frame.setWindowMaximized("chat-2", true);
  chat1.dispose();
  chat2.dispose();
  assert.equal(chat2.seen.at(-1), true);
  // chat-1's readers may re-run on another window's change; they never see
  // a wrong value.
  assert.ok(chat1.seen.slice(chat1Runs).every((value) => value === false));
  assert.ok(chat2.seen.slice(0, -1).every((value) => value === false));
});

test("forgetWindow: a closed window's state is dropped, reactively", () => {
  frame.setWindowMaximized("chat-2", true);
  const chat2 = watch(() => frame.windowMaximized("chat-2"));
  frame.forgetWindow("chat-2");
  // Forgetting an unknown or already-forgotten label is harmless.
  frame.forgetWindow("chat-2");
  frame.forgetWindow("chat-99");
  chat2.dispose();
  assert.deepEqual(chat2.seen, [true, false]);
  assert.equal(frame.windowMaximized("chat-2"), false);
});

test("toggleReplyCurrent: only while the label still holds the ticket", () => {
  assert.equal(frame.toggleReplyCurrent(3, 3), true);
  assert.equal(frame.toggleReplyCurrent(3, 4), false);
  assert.equal(frame.toggleReplyCurrent(3, undefined), false);
});

test("toggle reply: applied when nothing overtook it (no shell push)", () => {
  const chat1 = watch(() => frame.windowMaximized("chat-1"));
  const ticket = frame.beginMaximizeToggle("chat-1");
  assert.equal(frame.settleMaximizeToggle("chat-1", ticket, true), true);
  assert.equal(frame.windowMaximized("chat-1"), true);
  const back = frame.beginMaximizeToggle("chat-1");
  assert.equal(frame.settleMaximizeToggle("chat-1", back, false), true);
  chat1.dispose();
  assert.deepEqual(chat1.seen, [false, true, false]);
});

test("toggle reply: a double click whose replies land after the pushes keeps the push", () => {
  // Click 1 maximizes, click 2 restores. Both pushes reach main before
  // click 1's reply, the order that used to leave the restore icon on a
  // window that is not maximized.
  const first = frame.beginMaximizeToggle("chat-1");
  frame.setWindowMaximized("chat-1", true);
  const second = frame.beginMaximizeToggle("chat-1");
  frame.setWindowMaximized("chat-1", false);
  assert.equal(frame.settleMaximizeToggle("chat-1", first, true), false);
  assert.equal(frame.windowMaximized("chat-1"), false);
  assert.equal(frame.settleMaximizeToggle("chat-1", second, false), false);
  assert.equal(frame.windowMaximized("chat-1"), false);
});

test("toggle reply: a push that lands after the reply still wins", () => {
  const ticket = frame.beginMaximizeToggle("chat-1");
  assert.equal(frame.settleMaximizeToggle("chat-1", ticket, true), true);
  // The window was restored again (snap, Win+Down) before anything else.
  frame.setWindowMaximized("chat-1", false);
  assert.equal(frame.windowMaximized("chat-1"), false);
});

test("toggle reply: a newer click voids an older click's reply", () => {
  const first = frame.beginMaximizeToggle("chat-1");
  const second = frame.beginMaximizeToggle("chat-1");
  assert.equal(frame.settleMaximizeToggle("chat-1", second, false), true);
  // Replies out of order: the older one must not undo the newer.
  assert.equal(frame.settleMaximizeToggle("chat-1", first, true), false);
  assert.equal(frame.windowMaximized("chat-1"), false);
});

test("toggle reply: per label; a forgotten window's reply never reaches the next one", () => {
  const chat1 = frame.beginMaximizeToggle("chat-1");
  frame.setWindowMaximized("chat-2", true);
  assert.equal(frame.settleMaximizeToggle("chat-1", chat1, true), true);
  assert.equal(frame.windowMaximized("chat-1"), true);

  // The friends window closes with a toggle in flight; a new one reuses the
  // label and is toggled too. The old reply is dropped, the new one counts.
  const old = frame.beginMaximizeToggle("friends-window");
  frame.forgetWindow("friends-window");
  assert.equal(frame.settleMaximizeToggle("friends-window", old, true), false);
  assert.equal(frame.windowMaximized("friends-window"), false);
  const fresh = frame.beginMaximizeToggle("friends-window");
  assert.notEqual(fresh, old);
  assert.equal(frame.settleMaximizeToggle("friends-window", old, true), false);
  assert.equal(frame.windowMaximized("friends-window"), false);
  assert.equal(frame.settleMaximizeToggle("friends-window", fresh, true), true);
  assert.equal(frame.windowMaximized("friends-window"), true);
});

test("tab drag: start and end, reactively", () => {
  const active = watch(() => frame.tabDragActive());
  assert.equal(frame.tabDragActive(), false);
  frame.markTabDragStart();
  assert.equal(frame.tabDragActive(), true);
  frame.markTabDragEnd();
  assert.equal(frame.tabDragActive(), false);
  // An end with nothing live changes nothing.
  frame.markTabDragEnd();
  active.dispose();
  assert.deepEqual(active.seen, [false, true, false]);
});

test("tab drag: the flag clears itself after the TTL", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const active = watch(() => frame.tabDragActive());
  frame.markTabDragStart();
  t.mock.timers.tick(frame.TAB_DRAG_FLAG_TTL_MS - 1);
  assert.equal(frame.tabDragActive(), true, "cleared before the TTL");
  t.mock.timers.tick(1);
  assert.equal(frame.tabDragActive(), false, "outlived the TTL");
  active.dispose();
  assert.deepEqual(active.seen, [false, true, false]);
});

test("tab drag: a new start restarts the TTL", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  frame.markTabDragStart();
  t.mock.timers.tick(9_000);
  frame.markTabDragStart();
  t.mock.timers.tick(9_000);
  assert.equal(frame.tabDragActive(), true, "the first drag's timer fired");
  t.mock.timers.tick(1_000);
  assert.equal(frame.tabDragActive(), false);
});

test("tab drag: an ended drag's timer never clears a newer drag", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  frame.markTabDragStart();
  t.mock.timers.tick(5_000);
  frame.markTabDragEnd();
  frame.markTabDragStart();
  // 15 s after the first start, 9.999 s into the second.
  t.mock.timers.tick(9_999);
  assert.equal(frame.tabDragActive(), true, "an old timer cleared it");
  t.mock.timers.tick(1);
  assert.equal(frame.tabDragActive(), false);
});

test("clearStaleTabDrag: clears a live flag and its timer; idle is a no-op", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const active = watch(() => frame.tabDragActive());
  frame.clearStaleTabDrag();
  assert.equal(frame.tabDragActive(), false);

  frame.markTabDragStart();
  frame.clearStaleTabDrag();
  assert.equal(frame.tabDragActive(), false, "a stale flag survived");

  // Its timer went with it: a drag started later keeps a full TTL.
  t.mock.timers.tick(4_000);
  frame.markTabDragStart();
  t.mock.timers.tick(frame.TAB_DRAG_FLAG_TTL_MS - 1);
  assert.equal(frame.tabDragActive(), true, "the cleared drag's timer fired");
  frame.clearStaleTabDrag();
  frame.clearStaleTabDrag();
  active.dispose();
  assert.deepEqual(active.seen, [false, true, false, true, false]);
});

test("fullscreen: per label, reactive, a repeated value notifies nobody", () => {
  for (const label of [...LABELS, "main"]) {
    assert.equal(frame.windowFullscreen(label), false, label);
  }
  const main = watch(() => frame.windowFullscreen("main"));
  frame.setWindowFullscreen("main", true);
  frame.setWindowFullscreen("main", true);
  assert.equal(frame.windowFullscreen("main"), true);
  assert.equal(frame.windowFullscreen("chat-1"), false);
  frame.setWindowFullscreen("chat-1", true);
  frame.setWindowFullscreen("main", false);
  frame.setWindowFullscreen("main", false);
  assert.equal(frame.windowFullscreen("chat-1"), true);
  main.dispose();
  // One run per real change of main's own value, plus the one chat-1's
  // change caused (same value).
  assert.deepEqual(main.seen, [false, true, true, false]);
  // Maximized and fullscreen are separate.
  assert.equal(frame.windowMaximized("chat-1"), false);
});

test("forgetWindow: drops the fullscreen state too", () => {
  frame.setWindowFullscreen("friends-window", true);
  frame.setWindowMaximized("friends-window", true);
  frame.forgetWindow("friends-window");
  assert.equal(frame.windowFullscreen("friends-window"), false);
  assert.equal(frame.windowMaximized("friends-window"), false);
});

test("titleBarLayout: an inset window in fullscreen keeps no traffic-light space", () => {
  const style = { "padding-left": frame.MAC_INSET_PADDING };
  const layout = watch(() => frame.titleBarLayout("inset", "chat-1"));
  frame.setWindowFullscreen("chat-1", true);
  // Still a bar of ours, never controls; just no inset.
  assert.deepEqual(frame.titleBarLayout("inset", "chat-1"), {
    bar: true,
    controls: false,
    style: undefined,
  });
  // Another window's fullscreen, or no label, keeps the space.
  assert.deepEqual(frame.titleBarLayout("inset", "chat-2").style, style);
  assert.deepEqual(frame.titleBarLayout("inset", undefined).style, style);
  // Only inset changes: buttons and native are as before.
  assert.deepEqual(frame.titleBarLayout("buttons", "chat-1"), {
    bar: true,
    controls: true,
    style: undefined,
  });
  assert.deepEqual(frame.titleBarLayout("native", "chat-1"), {
    bar: false,
    controls: false,
    style: undefined,
  });
  frame.setWindowFullscreen("chat-1", false);
  layout.dispose();
  assert.deepEqual(
    layout.seen.map((value) => value.style),
    [style, undefined, style],
  );
  // `main` (the main window's own bar) reads the same map.
  frame.setWindowFullscreen("main", true);
  assert.equal(frame.titleBarLayout("inset", "main").style, undefined);
});

/** A document stand-in that records its listeners. */
function fakeDoc(opts: { throwOnRemove?: boolean } = {}) {
  type Entry = { type: string; fn: (e: Event) => void; opts: unknown };
  const added: Entry[] = [];
  const removed: Entry[] = [];
  const doc = {
    addEventListener: (
      type: string,
      fn: (e: Event) => void,
      options: unknown,
    ) => added.push({ type, fn, opts: options }),
    removeEventListener: (
      type: string,
      fn: (e: Event) => void,
      options: unknown,
    ) => {
      if (opts.throwOnRemove) throw new Error("window closed");
      removed.push({ type, fn, opts: options });
    },
  };
  const fire = (event: Record<string, unknown>) => {
    for (const entry of added) {
      if (entry.type === event.type) entry.fn(event as unknown as Event);
    }
  };
  return { doc: doc as unknown as Document, added, removed, fire };
}

test("watchDragFlag: capture listeners for exactly DRAG_FLAG_EVENTS, driving the flag", () => {
  const { doc, added, removed, fire } = fakeDoc();
  const stop = frame.watchDragFlag(doc);
  assert.deepEqual(
    added.map((entry) => entry.type).sort(),
    [...frame.DRAG_FLAG_EVENTS].sort(),
  );
  for (const entry of added) {
    assert.deepEqual(entry.opts, { capture: true, passive: true });
  }

  const files = { types: ["Files"] };
  fire({ type: "dragenter", dataTransfer: files, buttons: 1 });
  assert.equal(frame.tabDragActive(), true, "files over the window");
  fire({ type: "drop", dataTransfer: files, buttons: 0 });
  assert.equal(frame.tabDragActive(), false, "dropped");
  frame.markTabDragStart();
  fire({ type: "pointermove", buttons: 0 });
  assert.equal(frame.tabDragActive(), false, "a stale flag survived");
  frame.markTabDragStart();
  fire({ type: "dragover", dataTransfer: { types: ["text/plain"] } });
  assert.equal(frame.tabDragActive(), true, "a tab drag's dragover ended it");

  // The stop removes the same listeners with the same options, once.
  stop();
  stop();
  assert.equal(removed.length, added.length);
  for (const entry of added) {
    assert.ok(
      removed.some(
        (gone) =>
          gone.type === entry.type &&
          gone.fn === entry.fn &&
          JSON.stringify(gone.opts) === JSON.stringify(entry.opts),
      ),
      entry.type,
    );
  }
});

test("watchDragFlag: listeners go with the owner; a closed window's throw is swallowed", () => {
  const owned = fakeDoc();
  const dispose = createRoot((dispose) => {
    frame.watchDragFlag(owned.doc);
    return dispose;
  });
  assert.equal(owned.removed.length, 0);
  dispose();
  assert.equal(owned.removed.length, frame.DRAG_FLAG_EVENTS.length);

  // An owner and the stop both: removed once.
  const both = fakeDoc();
  let stop!: () => void;
  const disposeBoth = createRoot((dispose) => {
    stop = frame.watchDragFlag(both.doc);
    return dispose;
  });
  stop();
  disposeBoth();
  assert.equal(both.removed.length, frame.DRAG_FLAG_EVENTS.length);

  const closed = fakeDoc({ throwOnRemove: true });
  const closedStop = frame.watchDragFlag(closed.doc);
  assert.doesNotThrow(closedStop);
});
