// Unit spec for the chat windows' title bar state. Run with Node's built-in
// runner from packages/client:
//   node --test --conditions=browser components/chatWindows/chatWindowFrame.test.ts
// Declared test count: 16 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
//
// Focus (plan C7, audit M4): the per-label maximized state the shell pushes
// is reactive, per window, and forgotten on close; the tab drag flag is
// reactive, cleared by its end, by `clearStaleTabDrag`, and by itself after
// `TAB_DRAG_FLAG_TTL_MS`, and an old drag's timer never clears a newer drag.
// Timers are node:test's mock timers; the module reads `setTimeout` at call
// time, so it gets them. The bar's layout decisions (Wave 2 audit m2): which
// frame draws a bar, controls and the physical mac inset; the free space's
// region; which pointer events prove a drag stale; which drag events are
// files from outside over the window, and what each event a window reports
// does to the flag (Wave 2 audit m1).
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { createComputed, createRoot } from "solid-js";

import * as shellToMain from "../client/shellToMain.ts";

import * as frame from "./chatWindowFrame.ts";

const LABELS = ["chat-1", "chat-2", "friends-window"];

afterEach(() => {
  frame.markTabDragEnd();
  for (const label of LABELS) frame.forgetWindow(label);
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
