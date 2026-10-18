/**
 * The decisions behind `ChatWindowsHost`: which child windows to open or
 * close given the chat-window store and the windows that exist, what a child
 * the host did not close means for the store, and which tabs to drop or
 * prime.
 *
 * Kept free of the DOM, Solid and the app contexts so `node --test` can load
 * it (`./hostPlan.test.ts`).
 */

/**
 * The host's key for the friends window. Chat windows are keyed by their
 * store id, which is always `w-<n>`, so the two never collide. It equals the
 * store's `FRIENDS_WINDOW_ID`, so a focus request for the friends window
 * names this key (the spec pins the two together).
 */
export const FRIENDS_KEY = "friends";

/** How long a failed restore waits before its one retry. */
export const RESTORE_RETRY_DELAY_MS = 1000;

/**
 * The longest a window the store removed is kept open while a tab drag is
 * in progress. A drag whose end was never reported must not leave an empty
 * window behind for good.
 */
export const DRAG_CLOSE_MAX_DEFER_MS = 10_000;

export const CHAT_WINDOW_SIZE = { width: 760, height: 620 } as const;
export const FRIENDS_WINDOW_SIZE = { width: 300, height: 720 } as const;

type WinLike = {
  id: string;
  tabs: readonly string[];
  at?: { left: number; top: number };
};

export type WindowKind = "friends" | "chat";

/** Which kind of child a host key names. */
export function kindOf(key: string): WindowKind {
  return key === FRIENDS_KEY ? "friends" : "chat";
}

/**
 * Whether the child for `key` may be shown: the shell is active (main shown,
 * signed in, a shell with the chat-window commands, the layout confirmed as
 * this account's, the client ready) and chat-windows mode is on, which is
 * never on without an active shell. The friends window follows the mode like
 * every chat window: one setting moves the friends list and the
 * conversations together, so "main window" mode has no friends window whose
 * conversations would open behind it in main.
 */
export function keyActive(
  _key: string,
  shellActive: boolean,
  chatActive: boolean,
): boolean {
  return shellActive && chatActive;
}

/**
 * The child windows that should exist while chat windows are active: one per
 * store window, plus the friends window when it is open.
 */
export function desiredKeys(
  shellActive: boolean,
  chatActive: boolean,
  windows: readonly Pick<WinLike, "id">[],
  friendsOpen: boolean,
): string[] {
  if (!shellActive || !chatActive) return [];
  const keys = windows.map((w) => w.id);
  if (friendsOpen) keys.push(FRIENDS_KEY);
  return keys;
}

/**
 * What to change so exactly one child exists per desired key. A key whose
 * child is still opening is neither reopened nor closed here; the host
 * re-checks it when the open settles.
 */
export function planHost(
  desired: readonly string[],
  live: Iterable<string>,
  pending: ReadonlySet<string>,
): { open: string[]; close: string[] } {
  const want = new Set(desired);
  const have = new Set(live);
  const open: string[] = [];
  for (const key of want) {
    if (!have.has(key) && !pending.has(key)) open.push(key);
  }
  const close: string[] = [];
  for (const key of have) {
    if (!want.has(key)) close.push(key);
  }
  return { open, close };
}

/** `openChildWindow` arguments for a key; a chat window opens at its `at`. */
export function childWindowRequest(
  key: string,
  win?: Pick<WinLike, "id" | "at">,
): {
  kind: "friends" | "chat";
  opts: { width: number; height: number; left?: number; top?: number };
} {
  if (key === FRIENDS_KEY) {
    return { kind: "friends", opts: { ...FRIENDS_WINDOW_SIZE } };
  }
  const opts: { width: number; height: number; left?: number; top?: number } = {
    ...CHAT_WINDOW_SIZE,
  };
  if (win?.at) {
    opts.left = win.at.left;
    opts.top = win.at.top;
  }
  return { kind: "chat", opts };
}

export type ChildGoneAction =
  | { type: "none" }
  | { type: "closeWindow"; id: string }
  | { type: "closeFriends" };

/**
 * A child window went away. Only a close the user made changes the store:
 * one the host made itself (mode off, window removed from the store, the
 * host unmounting) and the main window unloading (which closes every child,
 * and must leave the layout to be restored) change nothing.
 */
export function childGoneAction(
  key: string,
  hostClosed: boolean,
  mainUnloading: boolean,
): ChildGoneAction {
  if (hostClosed || mainUnloading) return { type: "none" };
  if (key === FRIENDS_KEY) return { type: "closeFriends" };
  return { type: "closeWindow", id: key };
}

/** Tabs whose channel no longer resolves, in store order. */
export function deadTabs(
  windows: readonly Pick<WinLike, "tabs">[],
  resolves: (channelId: string) => boolean,
): string[] {
  const dead: string[] = [];
  for (const w of windows) {
    for (const tab of w.tabs) {
      if (!resolves(tab)) dead.push(tab);
    }
  }
  return dead;
}

/** Tabs not yet primed this session, in store order. */
export function unprimedTabs(
  windows: readonly Pick<WinLike, "tabs">[],
  primed: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const w of windows) {
    for (const tab of w.tabs) {
      if (!primed.has(tab)) out.push(tab);
    }
  }
  return out;
}

/**
 * Whether the main window has been shown this session, latched. Until it
 * has, the host neither probes the shell nor opens or restores a window, so
 * an app started hidden or minimized (launch at login) stays out of sight.
 * Once shown it stays true: main going to the tray later must not close the
 * chat windows or the friends window.
 */
export function mainShownLatch(
  shown: boolean,
  visibilityState: string | undefined,
): boolean {
  return shown || visibilityState === "visible";
}

/**
 * The keys whose next open is a restore, kept per kind: when `kind` becomes
 * active, every wanted key of that kind (the friends window when the shell
 * becomes active at startup; the chat windows then, or when the mode is
 * switched back on). An inactive kind has none; the other kind's keys are
 * left alone. Null when `kind` was already active and still is: a key wanted
 * since is a live open, not a restore.
 */
export function restoreKeysOnActivate(
  current: ReadonlySet<string>,
  kind: WindowKind,
  wasActive: boolean,
  isActive: boolean,
  desired: readonly string[],
): Set<string> | null {
  if (wasActive && isActive) return null;
  const next = new Set([...current].filter((key) => kindOf(key) !== kind));
  if (isActive) {
    for (const key of desired) if (kindOf(key) === kind) next.add(key);
  }
  return next;
}

export type OpenFailureAction =
  | { type: "retry"; delayMs: number }
  | { type: "drop" };

/**
 * A child window failed to open. A restore keeps its store entry and retries
 * once, since the shell may still be settling at startup. A second failure,
 * or a failed open the user just asked for, drops the entry: retrying on
 * every store change would loop, and opening it again retries.
 */
export function openFailureAction(
  restore: boolean,
  attempt: number,
): OpenFailureAction {
  return restore && attempt === 0
    ? { type: "retry", delayMs: RESTORE_RETRY_DELAY_MS }
    : { type: "drop" };
}

/**
 * Whether a window the store no longer wants closes now. While a tab drag
 * is in progress it waits: the window may be where the drag started (its
 * last tab dragged onto another window), and closing it would cut the drag
 * off before its `dragend`. It closes at once when its kind is inactive
 * (`keyActive`: mode off, or signed out), and after
 * `DRAG_CLOSE_MAX_DEFER_MS` regardless.
 */
export function closeNow(
  active: boolean,
  dragInProgress: boolean,
  deferredMs: number,
): boolean {
  return !active || !dragInProgress || !(deferredMs < DRAG_CLOSE_MAX_DEFER_MS);
}

/**
 * Whether the device-local layout may be shown: the session has a user id
 * and the synced stores' recorded owner is that user. Until `SyncWorker` has
 * run its owner check for this session, the layout may still be the
 * previous account's; the check resets it on a mismatch.
 */
export function ownerConfirmed(
  owner: string | undefined,
  sessionUserId: string | undefined,
): boolean {
  return (
    typeof sessionUserId === "string" &&
    sessionUserId.length > 0 &&
    owner === sessionUserId
  );
}
