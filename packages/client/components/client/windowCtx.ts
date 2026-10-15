/**
 * Per-window context for chat windows.
 *
 * A chat window is a same-realm child (`window.open("about:blank")`) that the
 * main app renders into through a `<Portal>`. Every component inside it still
 * runs in the MAIN realm, so the globals `document` / `window` point at the
 * wrong window. Components read `useWindowCtx()` instead; outside any provider
 * that is {@link MAIN_CTX}, so main-window behaviour is unchanged.
 *
 * This module is a dependency-free leaf apart from `solid-js`: the floating
 * layer, modals, keybinds and the notification worker all import it, and this
 * codebase has recorded blank-`#root` failures from module-init ordering in
 * import cycles. Nothing here touches `document` / `window` at module init
 * ({@link MAIN_CTX} resolves them lazily), so it also loads under `node --test`.
 */
import {
  type JSX,
  createComponent,
  createContext,
  createSignal,
  useContext,
} from "solid-js";

export type WindowCtx = {
  /** `"main"` for the main window. */
  id: string;
  doc: Document;
  win: Window;
  /** That window's `#floating`. */
  floatingMount: () => HTMLElement;
  /** `doc.hasFocus()` */
  isActive: () => boolean;
};

/**
 * The main window. Getters, not values, so importing this module never reads
 * a DOM global (module-init safety, and the spec runner has no DOM).
 */
export const MAIN_CTX: WindowCtx = Object.freeze({
  id: "main",
  get doc() {
    return document;
  },
  get win() {
    return window;
  },
  floatingMount: () => document.getElementById("floating")!,
  isActive: () => document.hasFocus(),
});

const windowCtx = createContext<WindowCtx>(MAIN_CTX);

export function WindowCtxProvider(props: {
  value: WindowCtx;
  children: JSX.Element;
}): JSX.Element {
  // `createComponent` rather than JSX so this stays a `.ts` leaf.
  return createComponent(windowCtx.Provider, {
    get value() {
      return props.value;
    },
    get children() {
      return props.children;
    },
  });
}

/** The window the calling component renders in; {@link MAIN_CTX} outside any provider. */
export function useWindowCtx(): WindowCtx {
  return useContext(windowCtx);
}

/* ------------------------------------------------------------------------ *
 * Registry + focus tracking
 * ------------------------------------------------------------------------ */

type Entry = { ctx: WindowCtx; detach: () => void };

/** Registered child windows, in registration order. Never contains "main". */
const registry = new Map<string, Entry>();

/**
 * Bumped on register / unregister so {@link windowCtxById} and
 * {@link allWindowCtxs} are reactive: the main `ModalRenderer` adopts modals
 * whose window went away, and it only re-filters if the lookup is tracked.
 */
const [registryVersion, setRegistryVersion] = createSignal(0);

/** ctx id → monotonic stamp of its last `focus` event (higher = more recent). */
const focusStamps = new Map<string, number>();
let focusSeq = 0;

/** ctx ids whose window holds focus right now, per `focus` / `blur` events. */
const focusedIds = new Set<string>();

/** ctx id → the channel that window shows. */
const conversations = new Map<string, string>();

let currentFocusedConversations: ReadonlySet<string> = new Set();
const [focusedConversationsSignal, setFocusedConversationsSignal] =
  createSignal<ReadonlySet<string>>(currentFocusedConversations);

let mainTracked = false;

function isClosed(ctx: WindowCtx): boolean {
  try {
    return ctx.win.closed;
  } catch {
    return true;
  }
}

function hasFocusNow(ctx: WindowCtx): boolean {
  try {
    return !isClosed(ctx) && ctx.doc.hasFocus();
  } catch {
    return false;
  }
}

/**
 * Recompute the published set. A fresh Set is only published when the
 * contents changed, so subscribers do not re-run on every focus event; the
 * comparison is done here rather than through an `equals` option so the
 * signal never holds a stale value.
 */
function publishFocusedConversations() {
  const next = new Set<string>();
  for (const [ctxId, channelId] of conversations) {
    // Main is never registered: its view is covered by the router check in
    // NotificationsWorker, and main focus only feeds lastFocusedCtx.
    if (registry.has(ctxId) && focusedIds.has(ctxId)) next.add(channelId);
  }

  const prev = currentFocusedConversations;
  if (prev.size === next.size && [...next].every((id) => prev.has(id))) return;

  currentFocusedConversations = next;
  setFocusedConversationsSignal(next);
}

function attachFocus(ctx: WindowCtx): () => void {
  const onFocus = () => {
    focusStamps.set(ctx.id, ++focusSeq);
    focusedIds.add(ctx.id);
    publishFocusedConversations();
  };
  const onBlur = () => {
    focusedIds.delete(ctx.id);
    publishFocusedConversations();
  };

  ctx.win.addEventListener("focus", onFocus);
  ctx.win.addEventListener("blur", onBlur);

  // The child may have taken focus before we were listening (window.open
  // focuses it at once).
  if (hasFocusNow(ctx)) onFocus();

  return () => {
    try {
      ctx.win.removeEventListener("focus", onFocus);
      ctx.win.removeEventListener("blur", onBlur);
    } catch {
      // A closed window's listeners die with it.
    }
  };
}

/**
 * Main focus matters only once a child exists (otherwise lastFocusedCtx is
 * main anyway), so its listeners go on lazily rather than at module init.
 */
function trackMain() {
  if (mainTracked || typeof window === "undefined") return;
  mainTracked = true;
  attachFocus(MAIN_CTX);
}

/**
 * Register a child window so lookups, focus tracking and
 * {@link focusedConversations} see it. Returns its unregister, which is
 * idempotent and also clears that window's focused conversation.
 *
 * Ids are expected to be unique; a duplicate replaces the earlier entry.
 * `"main"` cannot be registered (it is always {@link MAIN_CTX}).
 */
export function registerWindowCtx(ctx: WindowCtx): () => void {
  if (ctx.id === MAIN_CTX.id) return () => {};

  trackMain();
  registry.get(ctx.id)?.detach();

  const entry: Entry = { ctx, detach: () => {} };
  registry.set(ctx.id, entry);
  entry.detach = attachFocus(ctx);
  setRegistryVersion((v) => v + 1);
  publishFocusedConversations();

  return () => {
    entry.detach();
    // A replaced entry must not tear down its successor's state.
    if (registry.get(ctx.id) !== entry) return;

    registry.delete(ctx.id);
    focusedIds.delete(ctx.id);
    focusStamps.delete(ctx.id);
    conversations.delete(ctx.id);
    setRegistryVersion((v) => v + 1);
    publishFocusedConversations();
  };
}

/**
 * `"main"` → {@link MAIN_CTX}; a registered, still-open child → its ctx;
 * otherwise undefined (including a child that closed but whose unregister
 * has not run yet). Reactive on register / unregister.
 */
export function windowCtxById(id: string): WindowCtx | undefined {
  if (id === MAIN_CTX.id) return MAIN_CTX;
  registryVersion();
  const entry = registry.get(id);
  return entry && !isClosed(entry.ctx) ? entry.ctx : undefined;
}

/** {@link MAIN_CTX} first, then open children in registration order. Reactive on register / unregister. */
export function allWindowCtxs(): readonly WindowCtx[] {
  registryVersion();
  const out: WindowCtx[] = [MAIN_CTX];
  for (const { ctx } of registry.values()) {
    if (!isClosed(ctx)) out.push(ctx);
  }
  return out;
}

/**
 * The window that holds focus now, else the most recently focused open one,
 * else {@link MAIN_CTX}. A point-in-time read meant for one-shot handlers
 * (e.g. choosing where a modal opens); it does not track focus changes.
 */
export function lastFocusedCtx(): WindowCtx {
  const open: WindowCtx[] = [];
  for (const { ctx } of registry.values()) {
    if (!isClosed(ctx)) open.push(ctx);
  }

  // Live focus first, in case an event was missed.
  for (const ctx of open) {
    if (hasFocusNow(ctx)) return ctx;
  }
  if (typeof document !== "undefined" && document.hasFocus()) return MAIN_CTX;

  let best = MAIN_CTX;
  let bestStamp = focusStamps.get(MAIN_CTX.id) ?? 0;
  for (const ctx of open) {
    const stamp = focusStamps.get(ctx.id) ?? -1;
    if (stamp > bestStamp) {
      best = ctx;
      bestStamp = stamp;
    }
  }
  return best;
}

/** Record which channel a window shows (`null` when it shows none). */
export function setFocusedConversation(
  ctxId: string,
  channelId: string | null,
): void {
  if (channelId === null) conversations.delete(ctxId);
  else conversations.set(ctxId, channelId);
  publishFocusedConversations();
}

/**
 * REACTIVE: ids of the channels shown in a registered chat window whose
 * window currently holds focus. Used to suppress notifications for a
 * conversation the user is looking at outside the main window.
 */
export function focusedConversations(): ReadonlySet<string> {
  return focusedConversationsSignal();
}
