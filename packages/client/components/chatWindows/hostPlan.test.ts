// Unit spec for the chat-window host's decisions. Run with Node's built-in
// runner from packages/client:
//   node --test --conditions=browser components/chatWindows/hostPlan.test.ts
// Declared test count: 25 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
//
// Focus: nothing opens unless the shell is active; chat windows need
// chat-windows mode while the friends window works in either mode, and a
// mode flip closes the chat windows but keeps it; restore keys are tracked
// per kind; exactly one child per store window plus the friends window; a
// child still opening is neither reopened nor closed; only a close the user
// made changes the store (never one the host made, nor the main window
// unloading); the owner check fails closed; dead and unprimed tabs are found
// in every window; nothing opens before main has been shown; a restore
// retries once while a live open drops; a window the store removed waits out
// a tab drag (bounded).
import assert from "node:assert/strict";
import { test } from "node:test";

import { FRIENDS_WINDOW_ID } from "./chatWindowsStore.ts";
import {
  CHAT_WINDOW_SIZE,
  DRAG_CLOSE_MAX_DEFER_MS,
  FRIENDS_KEY,
  FRIENDS_WINDOW_SIZE,
  RESTORE_RETRY_DELAY_MS,
  childGoneAction,
  childWindowRequest,
  closeNow,
  deadTabs,
  desiredKeys,
  keyActive,
  kindOf,
  mainShownLatch,
  openFailureAction,
  ownerConfirmed,
  planHost,
  restoreKeysOnActivate,
  unprimedTabs,
} from "./hostPlan.ts";

const W1 = { id: "w-1", tabs: ["a", "b"] };
const W2 = { id: "w-2", tabs: ["c"], at: { left: 10, top: 20 } };

test("inactive shell wants no windows, even with a layout and friends open", () => {
  assert.deepEqual(desiredKeys(false, false, [W1, W2], true), []);
  // Chat activity never stands in for an inactive shell.
  assert.deepEqual(desiredKeys(false, true, [W1, W2], true), []);
});

test("chat-windows mode wants every store window, plus friends when open", () => {
  assert.deepEqual(desiredKeys(true, true, [W1, W2], false), ["w-1", "w-2"]);
  assert.deepEqual(desiredKeys(true, true, [W1, W2], true), [
    "w-1",
    "w-2",
    FRIENDS_KEY,
  ]);
  assert.deepEqual(desiredKeys(true, true, [], true), [FRIENDS_KEY]);
});

test("main-window mode wants the friends window when open, never a chat window", () => {
  assert.deepEqual(desiredKeys(true, false, [W1, W2], true), [FRIENDS_KEY]);
  assert.deepEqual(desiredKeys(true, false, [W1, W2], false), []);
});

test("switching the mode off closes the chat windows and keeps friends", () => {
  const desired = desiredKeys(true, false, [W1, W2], true);
  assert.deepEqual(planHost(desired, ["w-1", "w-2", FRIENDS_KEY], new Set()), {
    open: [],
    close: ["w-1", "w-2"],
  });
  // And back on: the chat windows reopen beside the friends window.
  assert.deepEqual(
    planHost(desiredKeys(true, true, [W1, W2], true), [FRIENDS_KEY], new Set()),
    { open: ["w-1", "w-2"], close: [] },
  );
});

test("each kind is active on its own condition", () => {
  assert.equal(kindOf(FRIENDS_KEY), "friends");
  assert.equal(kindOf("w-1"), "chat");
  assert.equal(keyActive(FRIENDS_KEY, true, false), true);
  assert.equal(keyActive("w-1", true, false), false);
  assert.equal(keyActive("w-1", true, true), true);
  assert.equal(keyActive(FRIENDS_KEY, false, true), false);
  assert.equal(keyActive("w-1", false, true), false);
});

test("plan opens missing windows and closes unwanted ones", () => {
  assert.deepEqual(planHost(["w-1", "w-2"], ["w-2", "w-9"], new Set()), {
    open: ["w-1"],
    close: ["w-9"],
  });
});

test("plan is empty when every wanted window exists", () => {
  assert.deepEqual(
    planHost(["w-1", FRIENDS_KEY], [FRIENDS_KEY, "w-1"], new Set()),
    { open: [], close: [] },
  );
});

test("a window still opening is not opened a second time", () => {
  assert.deepEqual(planHost(["w-1"], [], new Set(["w-1"])), {
    open: [],
    close: [],
  });
});

test("signed out closes every live window (the plan leaves pending ones to settle)", () => {
  const desired = desiredKeys(false, false, [W1], true);
  assert.deepEqual(planHost(desired, ["w-1", FRIENDS_KEY], new Set(["w-2"])), {
    open: [],
    close: ["w-1", FRIENDS_KEY],
  });
});

test("chat request uses the chat size and the stored position", () => {
  assert.deepEqual(childWindowRequest("w-1", W1), {
    kind: "chat",
    opts: { ...CHAT_WINDOW_SIZE },
  });
  assert.deepEqual(childWindowRequest("w-2", W2), {
    kind: "chat",
    opts: { width: 760, height: 620, left: 10, top: 20 },
  });
  assert.deepEqual(childWindowRequest("w-3"), {
    kind: "chat",
    opts: { width: 760, height: 620 },
  });
});

test("friends request is the friends size with no position", () => {
  assert.deepEqual(childWindowRequest(FRIENDS_KEY), {
    kind: "friends",
    opts: { ...FRIENDS_WINDOW_SIZE },
  });
  assert.deepEqual(FRIENDS_WINDOW_SIZE, { width: 300, height: 720 });
});

test("a user close removes the window or closes friends", () => {
  assert.deepEqual(childGoneAction("w-4", false, false), {
    type: "closeWindow",
    id: "w-4",
  });
  assert.deepEqual(childGoneAction(FRIENDS_KEY, false, false), {
    type: "closeFriends",
  });
});

test("a host close or a main unload never touches the store", () => {
  for (const key of ["w-4", FRIENDS_KEY]) {
    assert.deepEqual(childGoneAction(key, true, false), { type: "none" });
    assert.deepEqual(childGoneAction(key, false, true), { type: "none" });
    assert.deepEqual(childGoneAction(key, true, true), { type: "none" });
  }
});

test("dead tabs are found across every window, in order", () => {
  const live = new Set(["a", "c"]);
  assert.deepEqual(
    deadTabs([W1, W2, { tabs: ["d"] }], (id) => live.has(id)),
    ["b", "d"],
  );
  assert.deepEqual(
    deadTabs([W1], () => true),
    [],
  );
});

test("unprimed tabs exclude the ones already primed", () => {
  assert.deepEqual(unprimedTabs([W1, W2], new Set(["b"])), ["a", "c"]);
  assert.deepEqual(unprimedTabs([W1, W2], new Set(["a", "b", "c"])), []);
});

test("owner confirmed only when the recorded owner is the session user", () => {
  assert.equal(ownerConfirmed("u1", "u1"), true);
  assert.equal(ownerConfirmed("u1", "u2"), false);
});

test("owner check fails closed without an owner or a session user", () => {
  assert.equal(ownerConfirmed(undefined, "u1"), false);
  assert.equal(ownerConfirmed("u1", undefined), false);
  assert.equal(ownerConfirmed(undefined, undefined), false);
  assert.equal(ownerConfirmed("", ""), false);
});

test("the friends focus request names the host's friends key", () => {
  assert.equal(FRIENDS_KEY, FRIENDS_WINDOW_ID);
});

test("main hidden or minimized at startup keeps the host waiting", () => {
  assert.equal(mainShownLatch(false, "hidden"), false);
  assert.equal(mainShownLatch(false, undefined), false);
  assert.equal(mainShownLatch(false, "visible"), true);
});

test("once main has been shown, hiding it again changes nothing", () => {
  assert.equal(mainShownLatch(true, "hidden"), true);
  assert.equal(mainShownLatch(true, "visible"), true);
});

test("becoming active records every wanted key of that kind as a restore", () => {
  const none = new Set<string>();
  const wanted = ["w-1", FRIENDS_KEY];
  assert.deepEqual(
    restoreKeysOnActivate(none, "friends", false, true, wanted),
    new Set([FRIENDS_KEY]),
  );
  assert.deepEqual(
    restoreKeysOnActivate(none, "chat", false, true, wanted),
    new Set(["w-1"]),
  );
  // Already active: a window added since is a live open, not a restore.
  assert.equal(
    restoreKeysOnActivate(none, "chat", true, true, ["w-1", "w-2"]),
    null,
  );
  // Inactive: nothing of that kind is a restore.
  assert.deepEqual(
    restoreKeysOnActivate(new Set(["w-1"]), "chat", true, false, []),
    new Set(),
  );
  assert.deepEqual(
    restoreKeysOnActivate(none, "friends", false, false, []),
    new Set(),
  );
});

test("restore keys of one kind leave the other kind's alone", () => {
  // Startup: the shell came up first, its friends restore still pending
  // when chat-windows mode comes on.
  const afterShell = new Set([FRIENDS_KEY]);
  assert.deepEqual(
    restoreKeysOnActivate(afterShell, "chat", false, true, [
      "w-1",
      FRIENDS_KEY,
    ]),
    new Set([FRIENDS_KEY, "w-1"]),
  );
  // Mode off: the chat restores go, the friends restore stays.
  assert.deepEqual(
    restoreKeysOnActivate(new Set([FRIENDS_KEY, "w-1"]), "chat", true, false, [
      FRIENDS_KEY,
    ]),
    new Set([FRIENDS_KEY]),
  );
  // Mode on with the shell already active: friends was a live open, so
  // only the chat windows become restores.
  assert.deepEqual(
    restoreKeysOnActivate(new Set(), "chat", false, true, ["w-1", FRIENDS_KEY]),
    new Set(["w-1"]),
  );
});

test("a failed restore retries once, after a delay, then drops", () => {
  assert.deepEqual(openFailureAction(true, 0), {
    type: "retry",
    delayMs: RESTORE_RETRY_DELAY_MS,
  });
  assert.ok(RESTORE_RETRY_DELAY_MS >= 500 && RESTORE_RETRY_DELAY_MS <= 2000);
  assert.deepEqual(openFailureAction(true, 1), { type: "drop" });
  assert.deepEqual(openFailureAction(true, 2), { type: "drop" });
});

test("a failed live open drops at once", () => {
  assert.deepEqual(openFailureAction(false, 0), { type: "drop" });
  assert.deepEqual(openFailureAction(false, 1), { type: "drop" });
});

test("an unwanted window waits out a tab drag, but never forever", () => {
  // No drag: closes now.
  assert.equal(closeNow(true, false, 0), true);
  // Drag in progress: waits, right up to the cap.
  assert.equal(closeNow(true, true, 0), false);
  assert.equal(closeNow(true, true, DRAG_CLOSE_MAX_DEFER_MS - 1), false);
  assert.equal(closeNow(true, true, DRAG_CLOSE_MAX_DEFER_MS), true);
  assert.equal(closeNow(true, true, Number.NaN), true);
  // Mode off or signed out mid-drag: closes now.
  assert.equal(closeNow(false, true, 0), true);
  // Mode off with the shell still active: a chat window's kind is inactive.
  assert.equal(closeNow(keyActive("w-1", true, false), true, 0), true);
});
