/**
 * Which conversations sit in which desktop chat window, and whether the
 * friends window is open. The host renders one child window per entry; the
 * tab strip, the router and the friends list only ever change this store.
 *
 * Invariants, held after every change and re-established on load:
 * - a channel is a tab in at most one window;
 * - a window's `active` is one of its own tabs;
 * - a window with no tabs is removed;
 * - window ids are `w-<n>` from a counter that is persisted with the layout,
 *   so an id is never reused, not even across a reload. The host names child
 *   windows after these ids, and reusing a live window name would blank it.
 *   The one exception is a reload right after `resetChatWindows`, which
 *   deletes the saved counter along with the layout; by then every window
 *   has been closed.
 *
 * The layout is device-local (`localStorage`, never synced): it is read once
 * at module init and written on every change. A missing, corrupt or
 * unwritable store only costs the saved layout; the in-memory store keeps
 * working. It is per device, not per account: `SyncWorker`'s owner check
 * (`state/accountReset.ts`) calls `resetChatWindows` when a different account
 * signs in, and the host opens nothing until that check has passed.
 *
 * Kept free of the DOM, Solid components, lingui and the app contexts so
 * `node --test` can load it. `createChatWindowsModel` builds an instance with
 * injected storage for the spec; the exports below are the app's one instance.
 */
import { createStore, reconcile } from "solid-js/store";

export type ChatWin = {
  id: string;
  /** Channel ids, unique across ALL windows. */
  tabs: string[];
  active?: string;
  at?: { left: number; top: number };
};

export type ChatWindowsStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  /** Optional so a minimal fake still type-checks; `localStorage` has it. */
  removeItem?(key: string): void;
};

export const STORAGE_KEY = "sloga:chatWindows:v1";

/** Load-time caps, so a hand-edited store cannot balloon the window list. */
const MAX_WINDOWS = 50;
const MAX_TABS = 200;
const MAX_CHANNEL_ID_LENGTH = 128;
/**
 * The highest window number accepted from the store. Near 2^53 `n + 1`
 * rounds back to `n`, so an uncapped stored id or counter could make every
 * new window reuse one id. A billion windows is out of reach of real use.
 */
const MAX_WINDOW_NUMBER = 1_000_000_000;

const WINDOW_ID = /^w-([1-9]\d*)$/;

/**
 * The window id a focus request carries for the friends window, with `""` as
 * its channel id. It can never collide with a chat window id (`w-<n>`).
 */
export const FRIENDS_WINDOW_ID = "friends";

type FocusListener = (windowId: string, channelId: string) => void;

/** The plain (non-proxy) layout; also the persisted shape. */
type Layout = {
  windows: ChatWin[];
  friendsOpen: boolean;
  /** The number the next new window id takes. */
  nextId: number;
};

const EMPTY: Layout = { windows: [], friendsOpen: false, nextId: 1 };

function isChannelId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_CHANNEL_ID_LENGTH
  );
}

function windowNumber(id: unknown): number | undefined {
  if (typeof id !== "string") return undefined;
  const match = WINDOW_ID.exec(id);
  if (!match) return undefined;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) && n <= MAX_WINDOW_NUMBER ? n : undefined;
}

function cleanAt(value: unknown): ChatWin["at"] {
  if (!value || typeof value !== "object") return undefined;
  const { left, top } = value as Record<string, unknown>;
  return typeof left === "number" &&
    Number.isFinite(left) &&
    typeof top === "number" &&
    Number.isFinite(top)
    ? { left, top }
    : undefined;
}

/** A window built without `undefined` keys, so it serialises as it reads. */
function makeWin(
  id: string,
  tabs: string[],
  active: string | undefined,
  at: ChatWin["at"],
): ChatWin {
  const win: ChatWin = { id, tabs };
  if (active !== undefined) win.active = active;
  if (at) win.at = { left: at.left, top: at.top };
  return win;
}

/**
 * Rebuild a layout from whatever the store held. Bad entries are dropped,
 * not repaired into something the user never had: a window with a malformed
 * or duplicate id goes, a duplicate channel stays only in the first window
 * that lists it, a stale `active` falls back to the first tab, and a window
 * left with no tabs goes.
 */
export function parseLayout(raw: string | null): Layout {
  if (raw === null) return { ...EMPTY };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ...EMPTY };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ...EMPTY };
  }
  const record = data as Record<string, unknown>;

  const seenIds = new Set<string>();
  const seenTabs = new Set<string>();
  // Every well-formed id counts towards the counter, even one whose window is
  // dropped below, so nothing that may still name a child window is reissued.
  let highest = 0;
  const windows: ChatWin[] = [];
  for (const entry of Array.isArray(record.windows) ? record.windows : []) {
    if (!entry || typeof entry !== "object") continue;
    const w = entry as Record<string, unknown>;
    const n = windowNumber(w.id);
    if (n === undefined) continue;
    highest = Math.max(highest, n);
    const id = w.id as string;
    if (windows.length >= MAX_WINDOWS || seenIds.has(id)) continue;
    seenIds.add(id);

    const tabs: string[] = [];
    for (const tab of Array.isArray(w.tabs) ? w.tabs : []) {
      if (tabs.length >= MAX_TABS) break;
      if (!isChannelId(tab) || seenTabs.has(tab)) continue;
      seenTabs.add(tab);
      tabs.push(tab);
    }
    if (!tabs.length) continue;
    const active =
      typeof w.active === "string" && tabs.includes(w.active)
        ? w.active
        : tabs[0];
    windows.push(makeWin(id, tabs, active, cleanAt(w.at)));
  }

  // A counter past the cap is ignored like a malformed one; the ids that were
  // kept still push it past themselves below.
  const stored = record.nextId;
  const nextId =
    typeof stored === "number" &&
    Number.isSafeInteger(stored) &&
    stored >= 1 &&
    stored <= MAX_WINDOW_NUMBER
      ? stored
      : 1;

  return {
    windows,
    friendsOpen: record.friendsOpen === true,
    nextId: Math.max(nextId, highest + 1),
  };
}

/** A deep copy, so the store never shares objects with the plain layout. */
function copyWindows(windows: ChatWin[]): ChatWin[] {
  return windows.map((w) => makeWin(w.id, [...w.tabs], w.active, w.at));
}

/**
 * `windows` without `channelId`. When it was the active tab, the tab that
 * slides into its place takes over (the one to its left at the end of the
 * strip); a window left empty is removed.
 */
function withoutTab(windows: ChatWin[], channelId: string): ChatWin[] {
  const next: ChatWin[] = [];
  for (const w of windows) {
    const index = w.tabs.indexOf(channelId);
    if (index === -1) {
      next.push(w);
      continue;
    }
    const tabs = w.tabs.filter((tab) => tab !== channelId);
    if (!tabs.length) continue;
    const active =
      w.active === channelId || !w.active || !tabs.includes(w.active)
        ? tabs[Math.min(index, tabs.length - 1)]
        : w.active;
    next.push(makeWin(w.id, tabs, active, w.at));
  }
  return next;
}

function assertChannelId(channelId: unknown): asserts channelId is string {
  if (!isChannelId(channelId)) {
    throw new TypeError(`chatWindows: invalid channel id ${String(channelId)}`);
  }
}

/** Never throws: a missing or locked-down `localStorage` reads as none. */
function browserStorage(): ChatWindowsStorage | undefined {
  try {
    const storage = (globalThis as { localStorage?: ChatWindowsStorage })
      .localStorage;
    return storage &&
      typeof storage.getItem === "function" &&
      typeof storage.setItem === "function"
      ? storage
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One chat-window store. The app uses the module-level instance below; the
 * spec builds its own with fake storage.
 */
export function createChatWindowsModel(storage?: ChatWindowsStorage) {
  let raw: string | null = null;
  try {
    raw = storage ? storage.getItem(STORAGE_KEY) : null;
  } catch {
    raw = null;
  }
  let layout = parseLayout(raw);

  // The store mirrors `layout` through `reconcile` keyed by window id, so a
  // window keeps its proxy identity while its tabs change and a keyed
  // `<For>` in the host does not tear down that window's child.
  const [state, setState] = createStore<{
    windows: ChatWin[];
    friendsOpen: boolean;
  }>({ windows: copyWindows(layout.windows), friendsOpen: layout.friendsOpen });

  const listeners = new Set<FocusListener>();

  function persist() {
    if (!storage) return;
    try {
      storage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          nextId: layout.nextId,
          friendsOpen: layout.friendsOpen,
          windows: layout.windows,
        }),
      );
    } catch {
      // Quota or a locked-down profile: the layout just is not remembered.
    }
  }

  function commit(next: Layout) {
    layout = next;
    setState("windows", reconcile(copyWindows(next.windows), { key: "id" }));
    setState("friendsOpen", next.friendsOpen);
    persist();
  }

  function emitFocus(windowId: string, channelId: string) {
    for (const listener of [...listeners]) {
      try {
        listener(windowId, channelId);
      } catch (error) {
        console.error("[chatWindows] focus listener failed", error);
      }
    }
  }

  function findWindow(windowId: string): ChatWin | undefined {
    return layout.windows.find((w) => w.id === windowId);
  }

  function windowOf(channelId: string): string | undefined {
    return layout.windows.find((w) => w.tabs.includes(channelId))?.id;
  }

  /** A new window holding just `channelId`; the counter only moves forward. */
  function newWindow(channelId: string, at: ChatWin["at"]): ChatWin {
    const win = makeWin(`w-${layout.nextId}`, [channelId], channelId, at);
    layout = { ...layout, nextId: layout.nextId + 1 };
    return win;
  }

  /**
   * Show `channelId`. Already a tab: it becomes that window's active tab.
   * Otherwise it is appended to the first window as its active tab, or gets
   * a new window when there is none. When the conversation lands in a window
   * that was already open, a focus request asks the host to raise it (a new
   * window takes focus as it opens).
   */
  function openConversation(channelId: string): string {
    assertChannelId(channelId);
    const existing = windowOf(channelId);
    if (existing) {
      setActive(existing, channelId);
      emitFocus(existing, channelId);
      return existing;
    }
    const first = layout.windows[0];
    if (first) {
      commit({
        ...layout,
        windows: layout.windows.map((w) =>
          w === first
            ? makeWin(w.id, [...w.tabs, channelId], channelId, w.at)
            : w,
        ),
      });
      emitFocus(first.id, channelId);
      return first.id;
    }
    const win = newWindow(channelId, undefined);
    commit({ ...layout, windows: [win] });
    return win.id;
  }

  /**
   * Move `channelId` to window `to` or, with `"new"`, into a new window
   * placed at `opts.at`. The moved tab becomes the target's active tab, and a
   * source window left empty is removed. A tab not open anywhere is added.
   *
   * `opts.index` is the drop slot in the target strip AS RENDERED, i.e. the
   * tab is placed before the tab now at `index` (`tabs.length` or omitted =
   * the end). Within one window the dragged tab still occupies its old slot,
   * so a move to the right lands one slot earlier once it is taken out.
   *
   * A target window that has gone (closed mid-drag) changes nothing for an
   * open tab; a tab not open anywhere then gets a new window.
   *
   * Returns the window that holds the tab afterwards.
   */
  function moveTab(
    channelId: string,
    to: string | "new",
    opts?: { index?: number; at?: { left: number; top: number } },
  ): string {
    assertChannelId(channelId);
    const source = windowOf(channelId);
    const target = to === "new" ? undefined : findWindow(to);

    if (!target) {
      if (to !== "new" && source) return source;
      const remaining = withoutTab(layout.windows, channelId);
      const win = newWindow(channelId, cleanAt(opts?.at));
      commit({ ...layout, windows: [...remaining, win] });
      return win.id;
    }

    let slot =
      typeof opts?.index === "number" && Number.isFinite(opts.index)
        ? Math.trunc(opts.index)
        : target.tabs.length;
    if (source === target.id && slot > target.tabs.indexOf(channelId)) slot--;

    const insert = (tabs: string[]) => {
      const next = tabs.filter((tab) => tab !== channelId);
      next.splice(Math.max(0, Math.min(slot, next.length)), 0, channelId);
      return makeWin(target.id, next, channelId, target.at);
    };
    // A reorder stays in place: going through `withoutTab` would remove a
    // one-tab window and re-append it, changing which window is first.
    const windows =
      source === target.id
        ? layout.windows.map((w) => (w === target ? insert(w.tabs) : w))
        : withoutTab(layout.windows, channelId).map((w) =>
            w.id === target.id ? insert(w.tabs) : w,
          );
    commit({ ...layout, windows });
    return target.id;
  }

  /** Close `channelId`'s tab; a window left with no tabs is removed. */
  function closeTab(channelId: string): void {
    if (!windowOf(channelId)) return;
    commit({ ...layout, windows: withoutTab(layout.windows, channelId) });
  }

  /** Make `channelId` active in `windowId`; ignored unless it is a tab there. */
  function setActive(windowId: string, channelId: string): void {
    const win = findWindow(windowId);
    if (!win || !win.tabs.includes(channelId) || win.active === channelId) {
      return;
    }
    commit({
      ...layout,
      windows: layout.windows.map((w) =>
        w === win ? makeWin(w.id, w.tabs, channelId, w.at) : w,
      ),
    });
  }

  /** Remove `windowId` together with all its tabs. */
  function closeWindow(windowId: string): void {
    if (!findWindow(windowId)) return;
    commit({
      ...layout,
      windows: layout.windows.filter((w) => w.id !== windowId),
    });
  }

  /**
   * Open or close the friends window. Opening it while it is already open
   * changes nothing in the layout, so it asks the host to raise it instead
   * (`FRIENDS_WINDOW_ID`, no channel); a newly opened one takes focus as it
   * opens.
   */
  function setFriendsOpen(open: boolean): void {
    if (layout.friendsOpen === !!open) {
      if (open) emitFocus(FRIENDS_WINDOW_ID, "");
      return;
    }
    commit({ ...layout, friendsOpen: !!open });
  }

  /**
   * Close every window and the friends window, and delete the saved layout.
   * The in-memory counter carries on, so a child window of the previous
   * account that is still closing never shares a name with a new one.
   * Focus listeners stay: they belong to the host, not to the account.
   */
  function reset(): void {
    layout = { ...EMPTY, nextId: layout.nextId };
    setState("windows", reconcile([], { key: "id" }));
    setState("friendsOpen", false);
    if (!storage) return;
    try {
      if (typeof storage.removeItem === "function") {
        storage.removeItem(STORAGE_KEY);
      } else {
        persist();
      }
    } catch {
      // The old layout may come back on reload, but this session is clear.
    }
  }

  /**
   * Called with (windowId, channelId) when an open asks the host to raise a
   * window that is already showing; for the friends window that is
   * (`FRIENDS_WINDOW_ID`, ""). Returns the unsubscribe.
   */
  function onFocusRequest(cb: FocusListener): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }

  return {
    chatWindows: {
      /** REACTIVE: the open chat windows, in creation order. */
      windows: (): ChatWin[] => state.windows,
      /** REACTIVE: whether the friends window should be open. */
      friendsOpen: (): boolean => state.friendsOpen,
    },
    openConversation,
    moveTab,
    closeTab,
    setActive,
    closeWindow,
    setFriendsOpen,
    reset,
    windowOf,
    onFocusRequest,
  };
}

export type ChatWindowsModel = ReturnType<typeof createChatWindowsModel>;

const model = createChatWindowsModel(browserStorage());

export const chatWindows: {
  windows(): ChatWin[];
  friendsOpen(): boolean;
} = model.chatWindows;

/** Existing tab → focus it; else add to the first window (create one if none). */
export function openConversation(channelId: string): string {
  return model.openConversation(channelId);
}

export function moveTab(
  channelId: string,
  to: string | "new",
  opts?: { index?: number; at?: { left: number; top: number } },
): string {
  return model.moveTab(channelId, to, opts);
}

/** A window left empty is removed. */
export function closeTab(channelId: string): void {
  model.closeTab(channelId);
}

export function setActive(windowId: string, channelId: string): void {
  model.setActive(windowId, channelId);
}

/** Drops its tabs. */
export function closeWindow(windowId: string): void {
  model.closeWindow(windowId);
}

export function setFriendsOpen(open: boolean): void {
  model.setFriendsOpen(open);
}

/**
 * Account switch: closes every window and the friends window and deletes the
 * saved layout, so the next account on this device starts with none of them.
 * Called by the owner check at sign-in (`state/accountReset.ts`), not at
 * sign-out, so it holds however the last session ended.
 */
export function resetChatWindows(): void {
  model.reset();
}

export function windowOf(channelId: string): string | undefined {
  return model.windowOf(channelId);
}

/**
 * The host listens: openConversation of an open tab asks to focus, and so
 * does setFriendsOpen(true) on an open friends window (`FRIENDS_WINDOW_ID`).
 */
export function onFocusRequest(
  cb: (windowId: string, channelId: string) => void,
): () => void {
  return model.onFocusRequest(cb);
}
