// Unit spec for the chat-window router. Run with Node's built-in runner from
// packages/client:
//   node --test --conditions=browser components/chatWindows/openConversation.test.ts
// Declared test count: 12 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
//
// Focus: chat-windows mode needs the setting, a shell, AND a shell that has
// not been probed as lacking the chat-window commands; an unprobed shell
// counts as able and starts exactly one probe. In that mode the conversation
// / friends window opens in the chat-window store and the fallback never
// runs; in every other case the fallback runs once and the store is
// untouched. The friends window needs only the capable shell (either mode)
// and shares the one probe; opening it again asks the host to raise it. The
// shell is a fake handed to the router, so the cached capability can be set
// to each of its three states.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import type { State } from "@revolt/state";

import {
  FRIENDS_WINDOW_ID,
  chatWindows,
  closeTab,
  onFocusRequest,
  setFriendsOpen,
  windowOf,
} from "./chatWindowsStore.ts";
import {
  _setChatShell,
  chatWindowsMode,
  friendsWindowAvailable,
  openFriendsWindow,
  routeConversation,
  routeFriends,
} from "./openConversation.ts";

afterEach(() => {
  _setChatShell();
});

/** A State whose only setting is `appearance:dm_windows`, recording reads. */
function fakeState(mode: string | undefined) {
  const keys: string[] = [];
  const state = {
    settings: {
      getValue(key: string) {
        keys.push(key);
        return key === "appearance:dm_windows" ? mode : undefined;
      },
    },
  } as unknown as State;
  return { state, keys };
}

/**
 * A shell bridge with the cached capability `available` (undefined = not yet
 * probed), counting probes. Installed as the router's shell.
 */
function withShell(available: boolean | undefined, supported = true) {
  const shell = {
    probes: 0,
    supported: () => supported,
    chatWindowsAvailable: () => available,
    probeChatWindows() {
      shell.probes++;
      return Promise.resolve(true);
    },
  };
  _setChatShell(shell);
  return shell;
}

/** A fallback that counts its calls. */
function counter() {
  const c = { n: 0, fn: () => void c.n++ };
  return c;
}

test("mode is on only with the setting, a shell, and a capable shell", () => {
  const shell = withShell(true);
  const on = fakeState("chat_windows");
  assert.equal(chatWindowsMode(on.state), true);
  assert.deepEqual(on.keys, ["appearance:dm_windows"]);
  assert.equal(chatWindowsMode(fakeState("main").state), false);
  assert.equal(chatWindowsMode(fakeState(undefined).state), false);
  // A probed answer is cached; nothing probes again.
  assert.equal(shell.probes, 0);

  withShell(true, false);
  assert.equal(chatWindowsMode(fakeState("chat_windows").state), false);
});

test("a shell probed as lacking chat windows keeps the main window", () => {
  const shell = withShell(false);
  assert.equal(chatWindowsMode(fakeState("chat_windows").state), false);
  assert.equal(shell.probes, 0);
});

test("an unprobed shell counts as able and probes once", () => {
  const shell = withShell(undefined);
  assert.equal(chatWindowsMode(fakeState("chat_windows").state), true);
  assert.equal(shell.probes, 1);
  assert.equal(chatWindowsMode(fakeState("chat_windows").state), true);
  assert.equal(shell.probes, 1);
});

test("no probe without the setting or without a shell", () => {
  const shell = withShell(undefined);
  assert.equal(chatWindowsMode(fakeState("main").state), false);
  assert.equal(shell.probes, 0);

  const none = withShell(undefined, false);
  assert.equal(chatWindowsMode(fakeState("chat_windows").state), false);
  assert.equal(none.probes, 0);
});

test("chat mode opens the conversation as a tab, no fallback", () => {
  for (const available of [true, undefined]) {
    withShell(available);
    const fallback = counter();
    routeConversation(
      fakeState("chat_windows").state,
      "ch-route-1",
      fallback.fn,
    );
    assert.equal(fallback.n, 0);
    assert.equal(typeof windowOf("ch-route-1"), "string");
    closeTab("ch-route-1");
  }
});

test("main mode runs the fallback and leaves the store alone", () => {
  withShell(true);
  const fallback = counter();
  routeConversation(fakeState("main").state, "ch-route-2", fallback.fn);
  assert.equal(fallback.n, 1);
  assert.equal(windowOf("ch-route-2"), undefined);
});

test("chat_windows setting with no capable shell runs the fallback", () => {
  for (const [available, supported] of [
    [true, false],
    [false, true],
  ] as const) {
    withShell(available, supported);
    const fallback = counter();
    routeConversation(
      fakeState("chat_windows").state,
      "ch-route-3",
      fallback.fn,
    );
    assert.equal(fallback.n, 1);
    assert.equal(windowOf("ch-route-3"), undefined);
  }
});

test("chat mode opens the friends window, no fallback", () => {
  withShell(true);
  const fallback = counter();
  routeFriends(fakeState("chat_windows").state, fallback.fn);
  assert.equal(fallback.n, 0);
  assert.equal(chatWindows.friendsOpen(), true);
});

test("friends outside chat mode runs the fallback only", () => {
  // The previous test left the friends window open; close it so a wrong
  // `setFriendsOpen(true)` here would show.
  setFriendsOpen(false);
  for (const [mode, available, supported] of [
    ["main", true, true],
    ["chat_windows", true, false],
    ["chat_windows", false, true],
  ] as const) {
    withShell(available, supported);
    const fallback = counter();
    routeFriends(fakeState(mode).state, fallback.fn);
    assert.equal(fallback.n, 1);
    assert.equal(chatWindows.friendsOpen(), false);
  }
});

test("the friends window needs only a capable shell", () => {
  const shell = withShell(true);
  assert.equal(friendsWindowAvailable(), true);
  assert.equal(shell.probes, 0);

  assert.equal(withShell(false).probes, 0);
  assert.equal(friendsWindowAvailable(), false);

  // No shell (the web, Android): never available, never probed.
  for (const available of [true, false, undefined]) {
    const none = withShell(available, false);
    assert.equal(friendsWindowAvailable(), false);
    assert.equal(none.probes, 0);
  }
});

test("the friends window shares the one probe with chat mode", () => {
  const shell = withShell(undefined);
  assert.equal(friendsWindowAvailable(), true);
  assert.equal(shell.probes, 1);
  assert.equal(friendsWindowAvailable(), true);
  assert.equal(chatWindowsMode(fakeState("chat_windows").state), true);
  assert.equal(shell.probes, 1);

  // And the other way round: chat mode probing first counts too.
  const other = withShell(undefined);
  assert.equal(chatWindowsMode(fakeState("chat_windows").state), true);
  assert.equal(friendsWindowAvailable(), true);
  assert.equal(other.probes, 1);
});

test("openFriendsWindow opens the friends window, then asks to raise it", () => {
  setFriendsOpen(false);
  const requests: [string, string][] = [];
  const off = onFocusRequest((windowId, channelId) =>
    requests.push([windowId, channelId]),
  );
  try {
    openFriendsWindow();
    assert.equal(chatWindows.friendsOpen(), true);
    // A newly opened window takes focus as it opens; no request.
    assert.deepEqual(requests, []);

    openFriendsWindow();
    assert.equal(chatWindows.friendsOpen(), true);
    assert.deepEqual(requests, [[FRIENDS_WINDOW_ID, ""]]);
  } finally {
    off();
    setFriendsOpen(false);
  }
});
