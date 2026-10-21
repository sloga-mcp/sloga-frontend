// Unit spec for the chat windows' title bar state. Run with Node's built-in
// runner from packages/client:
//   node --test --conditions=browser components/chatWindows/chatWindowFrame.test.ts
// Declared test count: 9 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
//
// Focus (plan C7, audit M4): the per-label maximized state the shell pushes
// is reactive, per window, and forgotten on close; the tab drag flag is
// reactive, cleared by its end, by `clearStaleTabDrag`, and by itself after
// `TAB_DRAG_FLAG_TTL_MS`, and an old drag's timer never clears a newer drag.
// Timers are node:test's mock timers; the module reads `setTimeout` at call
// time, so it gets them.
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
