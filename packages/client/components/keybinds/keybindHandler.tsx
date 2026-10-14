import {
  type JSXElement,
  createContext,
  createEffect,
  createSignal,
  mapArray,
  onCleanup,
  untrack,
  useContext,
} from "solid-js";

import { ReactiveSet } from "@solid-primitives/set";

import {
  type WindowCtx,
  MAIN_CTX,
  useWindowCtx,
} from "@revolt/client/windowCtx";

import {
  ACTION_PRIORITY,
  DISMISSAL_PRIORITY,
  KeybindAction,
  keybindFilter,
} from "./keybindActions";
import { DEFAULT_MAC_SEQUENCES, DEFAULT_SEQUENCES } from "./keybindSequences";
import { registerActiveKeyReset } from "./suppress";

type KeybindContext = {
  createKeybind: (keybind: KeybindAction, callback: () => void) => void;
  dismissTopmost: () => boolean;
};

const keybindContext = createContext<KeybindContext>(null! as KeybindContext);

// #region keybind-dispatch-rule
/**
 * Whether a callback registered in window `callbackCtxId` fires for a key
 * event from window `eventCtxId`.
 *
 * Every callback is tagged with the window it was registered in, and fires
 * for that window's events only — there is deliberately no fallback in
 * either direction. Every in-app action is local to the window it was bound
 * in (Escape closes THIS window's overlay, a stray keystroke focuses THIS
 * window's composer, Shift+Escape acks THIS window's server), so letting a
 * chat window's press reach main's callbacks would act on a window the user
 * is not looking at. Global binds (mute, deafen, …) do not go through here:
 * `KeybindsWorker` listens in every bound window itself.
 *
 * Pure and import-free on purpose: `keybindDispatch.test.ts` lifts this
 * region out of the `.tsx` (which `node --test` cannot load) and runs it.
 *
 * @param callbackCtxId window the callback was registered in
 * @param eventCtxId window the key event came from
 */
export function keybindCallbackFires(
  callbackCtxId: string,
  eventCtxId: string,
): boolean {
  return callbackCtxId === eventCtxId;
}
// #endregion keybind-dispatch-rule

/**
 * Pressed keys of one chat window, fed by its own document.
 *
 * Main's equivalent is closure-local to `KeybindContext`, exactly as before
 * chat windows existed; only children live here, because `bindKeybinds` is
 * called from a chat window's chrome and has no handle on the provider.
 */
type ChildKeySource = {
  ctx: WindowCtx;
  activeKeys: ReactiveSet<string>;
  target: HTMLElement | null;
};

/**
 * Chat windows bound through {@link bindKeybinds}. Never contains main.
 *
 * A signal because callbacks are routinely registered BEFORE their window is
 * bound (a chat window's content sets up before its chrome's `onMount`); they
 * pick their window up when it appears here.
 */
const [childSources, setChildSources] = createSignal<readonly ChildKeySource[]>(
  [],
);

/**
 * Chat windows whose keys are currently bound, for `KeybindsWorker`'s
 * per-window listeners. Reactive; never includes main.
 */
export function boundKeybindWindows(): readonly WindowCtx[] {
  return childSources().map((source) => source.ctx);
}

/**
 * Feed a chat window's key events to the keybind handlers.
 *
 * Attaches the same `body` keydown/keyup listeners `KeybindContext` puts on
 * the main document, to `ctx.doc`, and makes the window visible to
 * `KeybindsWorker` (which puts its `window` listeners on `ctx.win`). Key
 * events from this window then fire the callbacks registered under its
 * `WindowCtxProvider`, and only those ({@link keybindCallbackFires}).
 *
 * Main is bound by `KeybindContext` itself and is refused here, as is a
 * second bind of the same window: two sources for one id would fire every
 * callback twice.
 *
 * @returns unbind; idempotent
 */
export function bindKeybinds(ctx: WindowCtx): () => void {
  if (
    ctx.id === MAIN_CTX.id ||
    untrack(childSources).some((source) => source.ctx.id === ctx.id)
  ) {
    if (import.meta.env.DEV)
      console.warn("[keybinds] window already bound, ignoring", ctx.id);
    return () => {};
  }

  const source: ChildKeySource = {
    ctx,
    activeKeys: new ReactiveSet<string>(),
    target: null,
  };

  const onKeyDown = (event: KeyboardEvent) => {
    source.target = event.target as HTMLElement;
    source.activeKeys.add(event.key);
  };

  const onKeyUp = (event: KeyboardEvent) => {
    source.target = event.target as HTMLElement;
    source.activeKeys.delete(event.key);
  };

  // Not something main does, and deliberately so here: moving between chat
  // windows and main is routine, and a key released after focus left this
  // window never sends its keyup here, latching it for the life of the
  // window (a latched Escape re-fires on every later keystroke).
  const onBlur = () => source.activeKeys.clear();

  const body = ctx.doc.body;
  body.addEventListener("keydown", onKeyDown);
  body.addEventListener("keyup", onKeyUp);
  ctx.win.addEventListener("blur", onBlur);

  setChildSources((sources) => [...sources, source]);

  let bound = true;
  return () => {
    if (!bound) return;
    bound = false;

    setChildSources((sources) => sources.filter((s) => s !== source));

    try {
      body.removeEventListener("keydown", onKeyDown);
      body.removeEventListener("keyup", onKeyUp);
      ctx.win.removeEventListener("blur", onBlur);
    } catch {
      // A closed window's listeners die with it.
    }
  };
}

/**
 * One `createKeybind` registration, as `dismissTopmost` needs to see it.
 */
type BoundCallback = { callback: () => void; ctxId: string };

export function KeybindContext(props: { children: JSXElement }) {
  /**
   * Last event target, used for filtering
   */
  let target: HTMLElement | null;

  /**
   * Keep track of pressed keys to match sequences
   */
  const activeKeys = new ReactiveSet<string>();

  /**
   * Bound-callback counters per window id: callbacks tagged with that
   * window, per action. Main's record is `currentlyBound`.
   */
  const boundCounts = new Map<string, Record<KeybindAction, number>>();

  function countsFor(ctxId: string) {
    let counts = boundCounts.get(ctxId);
    if (!counts) {
      counts = ACTION_PRIORITY.reduce(
        (d, k) => ({ ...d, [k]: 0 }),
        {} as Record<KeybindAction, number>,
      );
      boundCounts.set(ctxId, counts);
    }
    return counts;
  }

  /**
   * Keep track of which keybinds are currently bound
   * to filter the firing keybindings list
   *
   * Main window only: a chat window's callbacks are counted under its own id,
   * so an overlay open in a chat window never outranks a main-window action.
   */
  const currentlyBound = countsFor(MAIN_CTX.id);

  /**
   * The callbacks behind the counters, in registration order.
   *
   * The counters can only say *that* something is bound but never *what* to
   * call. This map carries the callbacks themselves so an overlay can be
   * dismissed programmatically — see `dismissTopmost`. The last entry for an
   * action is the most recently mounted handler, i.e. the topmost one.
   */
  const boundCallbacks = new Map<KeybindAction, Array<BoundCallback>>();

  /**
   * Dismiss the topmost overlay, without going through the keyboard at all.
   *
   * Walks `DISMISSAL_PRIORITY` (the Escape group of `ACTION_PRIORITY` minus
   * the two actions that dismiss nothing) in priority order, takes the first
   * action with a registered handler, and invokes that action's
   * **last-registered** callback.
   *
   * @returns whether anything was dismissed
   *
   * # What "dismissed" means here
   *
   * `true` means an Escape-group handler was bound and was invoked. It does
   * **not** mean a DOM change was observed — the callbacks return `void` and
   * this function has no way to confirm that anything actually closed. A
   * caller that treats `true` as "the overlay is gone" is trusting the
   * handler, not this function.
   *
   * # Why it does not reuse `firing()` / `isFired()`
   *
   * Both filter on the action's key sequence all being present in
   * `activeKeys`. With no keys held that selects nothing, so reusing them
   * would be a permanent, silent no-op. Synthesizing an `Escape` keydown is
   * worse still: `activeKeys` is fed from real `keydown`/`keyup` on
   * `document.body`, so a synthetic press with no matching release latches
   * `"Escape"` for the life of the window (see the comment on the listeners
   * below, and `./suppress`).
   *
   * # Why `keybindFilter` is deliberately not applied
   *
   * `keybindFilter`'s only branch that could apply to the Escape group is its
   * unconditional `keybindsSuppressed()` return — every other branch is
   * scoped to `CHAT_FOCUS_COMPOSITION`, which is not in this group. That
   * suppression exists because, while a remote-control capture surface is
   * live, *the keyboard* belongs to the machine being controlled. The
   * hardware back button is not the keyboard: it is a gesture on this device,
   * it cannot be typed by the remote controller, and it is the only way the
   * local user can close an overlay. Routing it through the suppression check
   * would make every back press a no-op for the caller, which on Android
   * means the press falls through to the Activity default and closes the app
   * — exactly the bug this exists to fix, made worse. So suppression is not
   * consulted; a suppression owner that also wants to swallow back presses
   * must gate its own caller.
   *
   * # Main window only
   *
   * Only callbacks tagged with the main window are considered. The caller is
   * a main-window input path (the Android back button), and an overlay open
   * in a chat window is not the topmost thing on main's screen.
   */
  function dismissTopmost(): boolean {
    for (const keybind of DISMISSAL_PRIORITY) {
      const callbacks = boundCallbacks
        .get(keybind)
        ?.filter((entry) => entry.ctxId === MAIN_CTX.id);
      if (!callbacks?.length) continue;

      callbacks[callbacks.length - 1].callback();
      return true;
    }

    return false;
  }

  /**
   * Sequences for use
   */
  const sequences = navigator.platform.startsWith("Mac")
    ? DEFAULT_MAC_SEQUENCES
    : DEFAULT_SEQUENCES;

  /**
   * Get the currently firing keybind
   * @param keys Pressed keys of the window being evaluated
   * @param keyTarget Last event target in that window
   * @param bound What counts as bound for that window
   */
  function firing(
    keys: ReactiveSet<string>,
    keyTarget: HTMLElement | null,
    bound: Record<KeybindAction, number>,
  ) {
    return (
      ACTION_PRIORITY
        // filter to those keybinds that are bound
        .filter((keybind) => bound[keybind])
        // apply custom filtering logic
        .filter((keybind) => keybindFilter(keybind, keys, bound, keyTarget))
        // check whether the keybind is being pressed
        .filter((keybind) =>
          sequences[keybind].every((key) =>
            key instanceof RegExp
              ? [...keys].findIndex((item) => key.test(item)) !== -1
              : keys.has(key),
          ),
        )
        // return the highest priority keybind
        .shift()
    );
  }

  /**
   * Debug currently pressed sequences
   */
  if (import.meta.env.DEV) {
    createEffect(() =>
      console.debug(
        "[keybinds] Currently pressing",
        [...activeKeys],
        "which selects",
        ACTION_PRIORITY
          // filter to those keybinds that are bound
          .filter((keybind) => currentlyBound[keybind])
          // apply custom filtering logic
          .filter((keybind) =>
            keybindFilter(keybind, activeKeys, currentlyBound, target),
          )
          // check whether the keybind is being pressed
          .reduce(
            (d, keybind) => ({
              ...d,
              [keybind]: sequences[keybind].every((key) =>
                key instanceof RegExp
                  ? [...activeKeys].findIndex((item) => key.test(item)) !== -1
                  : activeKeys.has(key),
              ),
            }),
            {},
          ),
      ),
    );
  }

  /**
   * Check whether a given keybind fired
   * @param keybind Keybind
   */
  function isFired(keybind: KeybindAction) {
    return firing(activeKeys, target, currentlyBound) === keybind;
  }

  /**
   * Check whether a given keybind fired in a chat window
   * @param source That window's key state
   * @param keybind Keybind
   */
  function isFiredIn(source: ChildKeySource, keybind: KeybindAction) {
    return (
      firing(source.activeKeys, source.target, countsFor(source.ctx.id)) ===
      keybind
    );
  }

  /**
   * Handle key down event by adding it to active keys
   */
  function onKeyDown(event: KeyboardEvent) {
    target = event.target as HTMLElement;
    activeKeys.add(event.key);
  }

  /**
   * Handle key up event by removing it from active keys
   */
  function onKeyUp(event: KeyboardEvent) {
    target = event.target as HTMLElement;
    activeKeys.delete(event.key);
  }

  document.body.addEventListener("keydown", onKeyDown);
  document.body.addEventListener("keyup", onKeyUp);

  // `activeKeys` is closure-local and lives as long as this window, so any
  // `keyup` that does not reach `document.body` latches its key FOREVER —
  // and `firing()` then re-evaluates that stale combination on every
  // subsequent keystroke. A remote-control capture surface swallows keyups
  // by design, so it needs a way to clear the set on both edges of a
  // session; without one, holding Escape as capture starts leaves this
  // client closing floating elements on every keypress until a reload.
  //
  // The slot is single (see `./suppress`), so the chat windows' sets are
  // cleared from here too rather than registering their own resets.
  onCleanup(
    registerActiveKeyReset(() => {
      activeKeys.clear();
      for (const source of untrack(childSources)) source.activeKeys.clear();
    }),
  );

  onCleanup(() => {
    document.body.removeEventListener("keydown", onKeyDown);
    document.body.removeEventListener("keyup", onKeyUp);
  });

  return (
    <keybindContext.Provider
      value={{
        createKeybind(keybind, callback) {
          // Read here, in the caller's owner: a component rendered into a
          // chat window sits under that window's `WindowCtxProvider`, and
          // anything else (no provider) is the main window.
          const ctxId = useWindowCtx().id;

          // Captured, not re-read: the record is only dropped once every
          // counter in it is zero, which this registration prevents until
          // its own cleanup has run.
          const counts = countsFor(ctxId);
          counts[keybind]++;
          onCleanup(() => {
            counts[keybind]--;
            if (
              ctxId !== MAIN_CTX.id &&
              boundCounts.get(ctxId) === counts &&
              ACTION_PRIORITY.every((k) => !counts[k])
            )
              boundCounts.delete(ctxId);
          });

          let callbacks = boundCallbacks.get(keybind);
          if (!callbacks) {
            callbacks = [];
            boundCallbacks.set(keybind, callbacks);
          }
          const entry: BoundCallback = { callback, ctxId };
          callbacks.push(entry);

          onCleanup(() => {
            // Re-read rather than closing over `callbacks`: the array is
            // dropped from the map when it empties, so a stale reference
            // would resurrect a detached one.
            const current = boundCallbacks.get(keybind);
            if (!current) return;

            // Identity, not `pop()` — components unmount out of order, so the
            // entry being cleaned up is not necessarily the last one. Each
            // registration has its own entry object, so this removes exactly
            // this one even when one function was registered more than once.
            const index = current.lastIndexOf(entry);
            if (index !== -1) current.splice(index, 1);
            if (!current.length) boundCallbacks.delete(keybind);
          });

          // Main window: exactly the pre-chat-window effect, for main-tagged
          // callbacks only.
          if (keybindCallbackFires(ctxId, MAIN_CTX.id)) {
            createEffect(() => {
              const _ = [...activeKeys]; // track dependency
              if (isFired(keybind)) {
                callback();
              }
            });
          }

          // Chat windows: an effect for the window this callback belongs to,
          // once that window is bound (often after this registration). Each
          // tracks only its own window's keys, so a press in one window never
          // re-evaluates another. A main-tagged callback matches none.
          createEffect(
            mapArray(
              () =>
                childSources().filter((source) =>
                  keybindCallbackFires(ctxId, source.ctx.id),
                ),
              (source) => {
                createEffect(() => {
                  const _ = [...source.activeKeys]; // track dependency
                  if (isFiredIn(source, keybind)) {
                    callback();
                  }
                });
              },
            ),
          );
        },
        dismissTopmost,
      }}
    >
      {props.children}
    </keybindContext.Provider>
  );
}

/**
 * Wrapper for contextual createKeybind function
 * @param keybind Keybind
 * @param callback Callback
 */
export function createKeybind(keybind: KeybindAction, callback: () => void) {
  const { createKeybind } = useContext(keybindContext);
  createKeybind(keybind, callback);
}

/**
 * Access the keybind context.
 *
 * Returns `null` outside of a `<KeybindContext>` — the context has no default
 * value, so callers must handle that rather than destructuring blindly.
 */
export function useKeybinds(): KeybindContext | null {
  return useContext(keybindContext) ?? null;
}

/**
 * Resolve a `dismissTopmost()` bound to the surrounding keybind context.
 *
 * Call this **during component setup**, like `createKeybind`, and keep the
 * returned function; the returned function is then safe to call at any later
 * time, from any event handler.
 *
 * That split is not stylistic. `useContext` reads Solid's current owner, and
 * an Android back press arrives on a bare window event with no owner on the
 * stack — resolving the context there would silently fall back to the
 * context's empty default and report "nothing to dismiss" forever.
 *
 * Intended for input paths that are not keys at all, principally the Android
 * hardware back button. See `KeybindContext`'s `dismissTopmost` for the
 * rationale, the exclusions, and what the return value does and does not
 * promise.
 *
 * Outside a `<KeybindContext>` the returned function always reports `false`
 * rather than throwing, so a stray back press can never crash the shell.
 *
 * @returns a function reporting whether an Escape-group handler was bound and
 * invoked
 */
export function useDismissTopmost(): () => boolean {
  const context = useKeybinds();
  return () => context?.dismissTopmost() ?? false;
}

/**
 * Declarative keybind component
 */
export function Keybind(props: {
  keybind: KeybindAction;
  onPressed: () => void;
}) {
  createEffect(() => createKeybind(props.keybind, props.onPressed));
  return null;
}
