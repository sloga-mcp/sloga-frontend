import { createEffect, mapArray, onCleanup, onMount } from "solid-js";

import { tauriInvoke } from "@revolt/common";
import { setKeybindArmState } from "@revolt/keybinds/armState";
import {
  type GlobalKeybindAction,
  type KeybindArmPayload,
  KEYBIND_COMMANDS,
  KEYBIND_EVENTS,
} from "@revolt/keybinds/globalKeybinds";
import { boundKeybindWindows } from "@revolt/keybinds/keybindHandler";
import {
  type KeybindArmPlan,
  type KeybindHeldEvent,
  UNPROBED_KEYBIND_ARM_STATE,
  applyKeybindHeldEvent,
  armStateFromResult,
  matchDomKey,
  planKeybindArm,
} from "@revolt/keybinds/keybindWorkerPolicy";
import { keybindsSuppressed } from "@revolt/keybinds/suppress";
import { useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";

/**
 * The `keybind:down` / `keybind:up` half of the Tauri event API.
 *
 * Declared locally, as `ActivityWorker` and `NotificationsWorker` both do for
 * their own events: there is no shared typing for `__TAURI__.event` and
 * `tauriInvoke` (`@revolt/common`) covers only the command half.
 */
type TauriEventApi = {
  event?: {
    listen(
      name: string,
      handler: (event: { payload: unknown }) => void,
    ): Promise<() => void>;
  };
};

/**
 * Pull the action id out of a `keybind:down` / `keybind:up` payload.
 *
 * The payload is `{ id: string }` by declaration and untyped JSON in fact, so
 * the shape is checked rather than trusted. A malformed payload yields `""`,
 * which is not a `GlobalKeybindAction` and is therefore dropped as
 * `"unknown-id"` by {@link applyKeybindHeldEvent} — the same path a stale arm
 * naming a dropped action takes. Returning `""` instead of throwing keeps a
 * garbage event from taking down the listener, which would take every later
 * real edge with it.
 */
function payloadActionId(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const id = (payload as { id?: unknown }).id;
  return typeof id === "string" ? id : "";
}

/**
 * Turns a keypress into a keybind action, over both transports.
 *
 * Mounted once, in `src/Interface.tsx`, inside `<VoiceContext>` and in the
 * main window only (the popout is turned away by that component's
 * `IS_POPOUT_WINDOW` redirect), following `NotificationsWorker`: a component
 * that grabs `useVoice()` at mount and registers native listeners in
 * `onMount`. Renders nothing.
 *
 * # Two transports, deliberately
 *
 * 1. **The native hook** (`keybinds_arm` + `keybind:down`/`keybind:up`) —
 *    Windows desktop shell only. This is the transport that makes a keybind
 *    *global*: it fires while Sloga is not the focused application.
 * 2. **A focused `window` keydown/keyup** — every platform. This is the
 *    **only** transport that can carry an `"in-app"`-tier action (those need
 *    transient user activation, which a hook callback cannot give), and a
 *    **necessary second** transport for `"global"`-tier ones, because the
 *    native hook is measurably blind while this app owns the foreground:
 *    `ptt.rs`'s module header records 20 physical keydowns producing zero
 *    `keyboard_proc` callbacks, cause still unexplained.
 *
 * 🔴 With Sloga focused a `"global"` binding can therefore arrive by BOTH
 * paths for one press. That is accepted rather than prevented here, and
 * absorbed at two levels: this worker's held-set drops the second edge as
 * `"already-down"`, and `Voice.dispatchKeybind()`'s per-action in-flight and
 * `KEYBIND_MIN_INTERVAL_MS` guards drop it again if it gets past that (the
 * held-set cannot see a native down that arrives while the DOM copy is still
 * in the same task). Stated rather than left to chance: a future change that
 * removed either guard would turn every focused press into two toggles, and
 * the second toggle would undo the first.
 *
 * # 🔴 No precondition is re-checked here
 *
 * `Voice.dispatchKeybind()` applies all five guards through
 * `@revolt/rtc/keybindDispatchPolicy`. Duplicating any of them in this file
 * would drift, and the drift would be invisible because both copies would
 * look right in isolation. This component decides only which edges are real;
 * the policy decides which may run.
 *
 * # Every DECISION is in `@revolt/keybinds/keybindWorkerPolicy`
 *
 * This file is a `.tsx` that reaches `@revolt/rtc`, so no unit runner can
 * load it — `node --test` refuses JSX outright and `@revolt/rtc` pulls
 * `livekit-client/e2ee-worker?worker`. What is left here is the mutable state
 * (`heldSet`, `armGen`), the signal reads, and the side effects.
 */
export function KeybindsWorker() {
  const state = useState();
  const voice = useVoice();

  /**
   * Actions this worker believes are physically held down, from EITHER
   * transport.
   *
   * 🔴 **One set, not one per transport**, and that is load-bearing. The two
   * transports cover overlapping focus states and each one is blind in a
   * window the other sees: a key pressed while unfocused (native down) and
   * released after alt-tabbing INTO Sloga gets no native up (the hook is
   * blind while focused) but does get a DOM `keyup`, and a shared set is what
   * lets that release clear the native-originated hold. Two sets would latch
   * it, and a latched bit makes the action permanently dead — see
   * {@link applyKeybindHeldEvent}.
   *
   * A plain `let` holding a `ReadonlySet`, reassigned from each verdict,
   * rather than a mutable `Set` this file writes: the policy leaf returns the
   * next set and is the only thing that computes one, so there is no path
   * that mutates the held-set without going through a tested decision. Not
   * reactive — it is read at the instant of a keypress by code that is not a
   * computation, the same reason `Voice.pttActive()` is a plain method.
   */
  let heldSet: ReadonlySet<GlobalKeybindAction> = new Set();

  /**
   * Supersession token for an in-flight `keybinds_arm`.
   *
   * Two arms can overlap: the effect below re-runs on any binding change and
   * nothing awaits the previous pass, so without this an older result could
   * resolve last and publish a stale arm state describing a table that is no
   * longer installed. Bumped on cleanup too, which orphans a
   * pending result rather than letting it write after the worker is gone.
   */
  let armGen = 0;

  /**
   * THE funnel for every held-set change. Nothing else touches `heldSet`.
   *
   * The verdict's `dispatch` is fire-and-forget: `dispatchKeybind` never
   * rejects (its `catch` is a `console.error`) and awaiting it here would
   * serialize unrelated keypresses behind one renegotiation.
   */
  function applyEdge(event: KeybindHeldEvent) {
    const verdict = applyKeybindHeldEvent(heldSet, event);
    heldSet = verdict.held;
    if (verdict.dispatch) void voice.dispatchKeybind(verdict.dispatch);
  }

  /**
   * Run an arm plan against the shell.
   *
   * @param plan from {@link planKeybindArm}
   */
  async function runArmPlan(plan: KeybindArmPlan) {
    const gen = ++armGen;
    const invoke = tauriInvoke();

    if (plan.kind === "disarm") {
      // 🔴 `keybinds_disarm`, not "skip the arm". A user with no global
      // bindings must be left with NO system-wide keyboard hook — that is
      // the shipped default (`defaultKeybinds()` binds nothing), and a
      // previous arm left standing after the last binding is cleared keeps a
      // hook alive for someone who has opted all the way out.
      //
      // Published synchronously, before the await, so it cannot land after a
      // newer arm's result: nothing is armed the instant the plan says so.
      //
      // It also records whether an invoke bridge exists. With nothing bound
      // that is the only evidence the settings page has: a shell WITH a
      // bridge keeps capture open so a first key can be bound at all, and a
      // shell without one locks it. Reporting "unavailable" here regardless
      // would lock every global row on every platform, the desktop app
      // included, before a single key was ever submitted.
      setKeybindArmState(
        armStateFromResult([], undefined, invoke !== undefined),
      );
      if (!invoke) return;
      // Idempotent and argument-free; a shell without the command throws and
      // that is the same inert outcome as not having a hook to drop.
      await invoke(KEYBIND_COMMANDS.disarm).catch(() => {});
      return;
    }

    if (!invoke) {
      // Web, Android, Electron, or a Tauri window with no capability file.
      // Probed, nothing armed, nothing proven, and no bridge to ask — the
      // settings page needs to know the rows are inert. A throwing invoke
      // below publishes the same "nothing armed" shape but with
      // `bridge: true`; the page reads both as unavailable once bindings
      // were submitted.
      setKeybindArmState(armStateFromResult(plan.bindings, undefined, false));
      return;
    }

    let raw: unknown;
    try {
      // 🔴 The array is WRAPPED. Tauri binds command arguments by parameter
      // name and the native parameter is `bindings: Vec<KeybindSpec>`, so a
      // bare array deserializes to nothing at all — an arm that resolves
      // having installed nothing.
      //
      // A fresh copy, never the array the plan holds: native takes a
      // snapshot of the submitted INDICES (`action_id` is the position), so
      // the array must not be touched after the call, and handing over a
      // copy is how that is guaranteed rather than promised.
      const payload: KeybindArmPayload = { bindings: [...plan.bindings] };
      raw = await invoke(KEYBIND_COMMANDS.arm, payload);
    } catch {
      // Older shell without the command, or an ACL refusal. Same
      // focused-only-fallback posture as `Voice`'s `#ensureNativePtt`: inert,
      // never a dialog over whatever the user was actually doing. `raw`
      // stays `undefined`, which publishes as "probed, nothing armed".
      raw = undefined;
    }

    // A newer arm superseded this one while it was awaiting; its own result
    // is the current truth and this one must not overwrite it.
    if (gen !== armGen) return;

    // 🔴 The result is not optional to read, and every list is narrowed
    // inside `armStateFromResult`: an all-empty result means "no native
    // layer", NOT "armed" — off Windows `keybinds_arm` returns
    // `KeybindsArmResult::default()` with no error at all.
    //
    // `bridge: true` unconditionally: a bridge existed, or this line would
    // not be reached. A throwing or ACL-refused invoke lands here too, with
    // `raw === undefined` — the bridge was there and the arm produced no
    // evidence, which the page renders as unavailable because bindings were
    // submitted and none came back armed.
    setKeybindArmState(armStateFromResult(plan.bindings, raw, true));
  }

  /*
   * Native transport. `keybind:down` / `keybind:up` are emitted to the main
   * window by the Windows shell's hook thread.
   *
   * 🔴 Declared BEFORE the arm effect, and the order is the point. `onMount`
   * and `createEffect` share one effects queue and run in declaration order,
   * so an arm declared first would reach `keybinds_arm` while this listener
   * did not exist yet — the exact window `Keybinds.hydrate()`
   * (`../state/stores/Keybinds.ts`) refuses to arm from, because "a press in
   * that window is delivered nowhere, and its `keybind:up` with it".
   *
   * A residual remains and is accepted rather than papered over: `listen()`
   * resolves asynchronously, so the subscription is not live the instant this
   * returns. Closing it would mean gating the reactive arm on an async setup
   * signal, for a window of a few milliseconds during app boot, before the
   * settings page can even be open. A press lost there costs one edge; the
   * matching up is then dropped as `"not-down"` by the held-set rather than
   * dispatching anything, so the failure is a missed keypress and never a
   * stuck action.
   */
  onMount(() => {
    const tauri = (window as { __TAURI__?: TauriEventApi }).__TAURI__;
    if (!tauri?.event) return;

    const subscriptions = [
      tauri.event.listen(KEYBIND_EVENTS.down, (event) =>
        applyEdge({ kind: "down", id: payloadActionId(event.payload) }),
      ),
      tauri.event.listen(KEYBIND_EVENTS.up, (event) =>
        applyEdge({ kind: "up", id: payloadActionId(event.payload) }),
      ),
    ];

    onCleanup(() => {
      for (const subscription of subscriptions) {
        subscription.then((unlisten) => unlisten()).catch(() => {});
      }
    });
  });

  /*
   * Arm from the store, re-arming whenever the persisted set changes.
   * `state.keybinds.bindings()` is a `createStore` read, so this effect
   * tracks each binding individually and re-runs on any single rebind.
   */
  createEffect(() => {
    const plan = planKeybindArm(state.keybinds.bindings());

    // 🔴 UNCONDITIONALLY, and BEFORE the call. Both `keybinds_arm` and
    // `keybinds_disarm` clear the native down-word wholesale and emit no
    // synthetic `keybind:up`, so anything held across this loses its release
    // — including on a re-arm that changes nothing, because native clears
    // regardless of whether the table changed. Waiting for an up that is not
    // coming leaves the action recorded as down forever, and a stale held bit
    // makes every later press of it arrive as `"already-down"` and be
    // dropped: a keybind that is dead for the session because the settings
    // page saved an unrelated row while the key was held.
    applyEdge({ kind: "release-all" });

    void runArmPlan(plan);
  });

  /*
   * Focused-window transport handlers, shared by the main window and every
   * bound chat window. One `heldSet` behind all of them, for the reason
   * given on it: a key pressed in one window and released in another must
   * still clear.
   */
  const onKeyDown = (event: KeyboardEvent) => {
    const { actions } = matchDomKey({
      bindings: state.keybinds.bindings(),
      event,
      edge: "down",
      // 🔴 Read at the instant of the press, not captured: a
      // remote-control session can start between two keystrokes. The
      // native path is immune (injected input is filtered natively by
      // `RC_INJECT_EXTRA`); this one is not, which is the entire reason
      // `@revolt/keybinds/suppress` exists — without it a remote
      // controller typing on the sharer's machine can hang up the
      // sharer's call.
      suppressed: keybindsSuppressed(),
      repeat: event.repeat,
    });
    for (const action of actions) applyEdge({ kind: "down", id: action });
  };

  const onKeyUp = (event: KeyboardEvent) => {
    const { actions } = matchDomKey({
      bindings: state.keybinds.bindings(),
      event,
      edge: "up",
      suppressed: keybindsSuppressed(),
      // A `keyup` carries no meaningful `repeat`, and gating a release on
      // one would drop it — a dropped release latches the action down.
      repeat: false,
    });
    for (const action of actions) applyEdge({ kind: "up", id: action });
  };

  const onBlur = () => applyEdge({ kind: "release-all" });

  /*
   * Focused-window transport. On `window`, matching `Voice`'s push-to-talk
   * listeners, rather than on `document.body` as the older in-app registry
   * does: a key pressed while focus sits on an element outside `body`'s
   * propagation path (a portalled dialog, the capture surface after a
   * remount) still reaches `window`.
   */
  onMount(() => {
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    onCleanup(() => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    });
  });

  /*
   * Release everything on both edges of the suppression flag.
   *
   * 🔴 This is the active-key-reset equivalent, and it is an EFFECT rather
   * than a `registerActiveKeyReset` call on purpose. That function is a
   * single-slot registration (`clearActiveKeys = reset`, last write wins) and
   * `KeybindContext` in `../keybinds/keybindHandler.tsx` already holds the
   * slot; registering here would silently clobber the in-app handler's own
   * `activeKeys` reset and reintroduce exactly the latch `./suppress.ts`
   * documents — hold Escape, start capturing, and every later keystroke
   * re-fires `CLOSE_FLOATING` until a reload.
   *
   * An effect on the signal is strictly better anyway: it fires on BOTH
   * edges, which is what `setKeybindSuppression` achieves by calling
   * `clearActiveKeys?.()` after every write, and it cannot be taken away by
   * another registrant.
   */
  createEffect(() => {
    // The tracked read IS the point; the value is not otherwise used.
    keybindsSuppressed();
    applyEdge({ kind: "release-all" });
  });

  /*
   * Release everything when the window loses focus.
   *
   * A DOM `keyup` is delivered only to the focused window, so alt-tabbing
   * mid-hold means that release never arrives at all — and the native hook
   * cannot cover it either, because it was blind while we were focused and so
   * emitted no down whose up it owes. `Voice`'s `#pttHeld` clears on blur for
   * exactly this reason; without it the action stays recorded as down and its
   * next press is dropped as `"already-down"`.
   */
  onMount(() => {
    window.addEventListener("blur", onBlur);
    onCleanup(() => window.removeEventListener("blur", onBlur));
  });

  /*
   * The same focused-window transport for every chat window bound through
   * `bindKeybinds`, so a global binding (mute, deafen, …) pressed while a
   * chat window has focus still works: its key events reach that window
   * only, never main's `window`.
   *
   * Blur too, for the same reason as main's: switching between main and a
   * chat window mid-hold sends the release to the other window, which this
   * shared held-set then drops as `"not-down"` after the release-all.
   *
   * Torn down per window when it unbinds, and before the `release-all` in
   * the cleanup below when the worker unmounts (owned computations are
   * disposed before their owner's cleanups run).
   */
  createEffect(
    mapArray(boundKeybindWindows, (ctx) => {
      const win = ctx.win;
      win.addEventListener("keydown", onKeyDown);
      win.addEventListener("keyup", onKeyUp);
      win.addEventListener("blur", onBlur);

      onCleanup(() => {
        try {
          win.removeEventListener("keydown", onKeyDown);
          win.removeEventListener("keyup", onKeyUp);
          win.removeEventListener("blur", onBlur);
        } catch {
          // A closed window's listeners die with it.
        }
      });
    }),
  );

  onCleanup(() => {
    // 🔴 FIRST, and not left to the disarm below: this is where the
    // listeners go away, so after this point neither transport can deliver a
    // release, and `keybinds_disarm` emits no synthetic `keybind:up` for what
    // was held either. The drop must not depend on an edge that is not
    // coming.
    applyEdge({ kind: "release-all" });

    // Orphan any arm still awaiting, so its result cannot publish after the
    // worker is gone.
    armGen++;
    // No worker, no observation: anything else would leave the settings page
    // reading a claim about the native layer that nothing is maintaining.
    setKeybindArmState(UNPROBED_KEYBIND_ARM_STATE);

    const invoke = tauriInvoke();
    if (!invoke) return;
    void invoke(KEYBIND_COMMANDS.disarm).catch(() => {});
  });

  return null;
}
