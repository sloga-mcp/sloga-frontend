import { onCleanup, onMount } from "solid-js";

import { Capacitor, registerPlugin } from "@capacitor/core";

import { useDismissTopmost } from "@revolt/keybinds/keybindHandler";
import { useState } from "@revolt/state";
import { SlideState } from "@revolt/ui/components/navigation/SlideDrawer";

import { useClientLifecycle } from ".";
import { slimIsRoot } from "./slimRoutePolicy";
import { useSlimMode } from "./useSlimMode";

/**
 * Window event the Android shell dispatches for every back press (hardware
 * key or predictive-back gesture), through `bridge.triggerWindowJSEvent` —
 * the same route `slogaNotificationAction` already takes, so no new
 * dependency and no `@capacitor/app`.
 *
 * The native side ALWAYS consumes the press and lets the web layer decide,
 * because the answer below is not knowable natively; that is why the last
 * rung has to ask native to exit rather than simply declining the event.
 */
const BACK_EVENT = "slogaBackPressed";

/**
 * Native exit, used only when the whole ladder declines the press.
 *
 * Registered exactly like `ApkUpdater` / `PushToken` / `AppFlavor`. If the
 * shell does not implement it the call rejects ("not implemented") and the
 * press ends up doing nothing at all — the app stays open, which is the safe
 * direction for the defect this fixes (back closing the whole app).
 */
const SlogaBackNative = Capacitor.isNativePlatform()
  ? registerPlugin<{ exitApp(): Promise<void> }>("SlogaBack")
  : undefined;

/**
 * Index of the current history entry.
 *
 * `history.length` cannot answer "is there anything to go back to": it never
 * shrinks when you navigate back, so after one back it would report a stack
 * that is no longer there and every later press would call `history.back()`
 * into nothing — a back key that silently does nothing forever.
 *
 * `@solidjs/router` already maintains the number this needs: it stamps
 * `_depth` onto every history entry (initialised to `history.length - 1` at
 * module load, so it is present from boot and stays on the SAME scale as the
 * fallback below). Going back lands on an entry with a lower `_depth`, which
 * is exactly the comparison the ladder wants.
 *
 * If a future router drops `_depth`, this degrades to `history.length - 1`,
 * which only ever grows — so the ladder would keep calling `history.back()`
 * and never reach the exit rung. Chosen deliberately: the failure mode is "the
 * app does not exit on back", never "the app exits while something is open".
 */
function historyDepth(): number {
  const state = history.state as { _depth?: number } | null;
  return typeof state?._depth === "number" ? state._depth : history.length - 1;
}

/**
 * Routes the Android back press through the app's own dismissal ladder
 * instead of letting the Activity finish.
 *
 * Reported 2026-09: viewing a profile and pressing Back closed the entire
 * app. There was no back handler anywhere in the client, so every overlay had
 * this — modals, the image viewer, the channel side column, the phone slide
 * drawer — not just profiles.
 *
 * Android only, by two independent gates: this `isNativePlatform() &&
 * getPlatform() === "android"` check (the idiom `client/e2ee.ts` and
 * `rtc/androidScreenShare.ts` use), and the fact that nothing outside the
 * Android shell ever dispatches {@link BACK_EVENT}. Under Tauri, Electron and
 * the web, `window.Capacitor` is absent and the listener is never registered.
 */
export function AndroidBackWorker() {
  const state = useState();

  // Resolved during setup and held, exactly as `useDismissTopmost` requires:
  // it reads the keybind context, and a context read resolves against Solid's
  // current owner — a back press arrives on a bare window event with none, so
  // resolving it there would report "nothing to dismiss" forever.
  const dismissTopmost = useDismissTopmost();

  // Resolved during setup for the same reason. Both are read inside the
  // handler, at the moment of the press.
  const slim = useSlimMode();
  const { lifecycle } = useClientLifecycle();

  onMount(() => {
    if (
      !Capacitor.isNativePlatform() ||
      Capacitor.getPlatform() !== "android"
    ) {
      return;
    }

    // The entry the app was sitting on when this mounted. Anything deeper was
    // pushed by this session and is ours to pop; at or below it, back leaves.
    const baseDepth = historyDepth();

    const onBack = () => {
      // 1. Native fullscreen (the fullscreen call card). It paints a
      //    `::backdrop` over the whole document and promotes one element into
      //    the top layer, so anything dismissed below it would be dismissed
      //    invisibly. Same two lines as `leaveFullscreenForModal` in
      //    `components/modal/index.tsx`, which is module-private there and
      //    could not be imported — see the report on this lane.
      if (typeof document !== "undefined" && document.fullscreenElement) {
        // Rejects if the document already left fullscreen another way.
        void document.exitFullscreen?.().catch(() => undefined);
        return;
      }

      // 2. The dismissal ladder: floating elements (context menus, tooltips,
      //    the user card), then modals, then the channel side column, then an
      //    in-progress edit or composition element — `DISMISSAL_PRIORITY`
      //    order, one layer per press. `true` means a handler was bound and
      //    invoked, not that the DOM was observed to change.
      //
      //    NOTE this deliberately does NOT synthesise an `Escape` keydown: the
      //    keybind handler is driven by a `ReactiveSet` fed from real
      //    keydown/keyup, and a synthetic press with no matching release
      //    latches "Escape" forever (its own comment documents that failure).
      //
      //    A modal holding `dismissLockedId` still counts as handled: its
      //    CLOSE_MODAL handler runs, `ModalController.pop()` declines to close
      //    that one modal, and the press stops here. That is the intended
      //    outcome — an irreversible in-flight flow is neither dismissed nor
      //    allowed to fall through to exiting the app.
      if (dismissTopmost()) return;

      // 3. The phone slide drawer, which is NOT in the Escape ladder — Escape
      //    does not close it today.
      //
      //    Read the state names carefully: the drawer is constructed over the
      //    *channel* pane, so `show` means "content shown" and the navigation
      //    column is what the user sees while the content is pushed off. So
      //    the drawer being open to the user is SHOWN-being-false, and closing
      //    it is `setShown(true)`.
      //
      //    HIDING and MOVING are included so a press landing mid-animation or
      //    mid-swipe is absorbed instead of falling through and exiting the
      //    app; `setShown` early-returns `false` in those cases and every
      //    call site in the repo ignores that return, as here.
      //
      //    Not at the Slim view root: there the navigation column is the
      //    chat list, which is the screen itself, and the content pane behind
      //    it is only a placeholder. Sliding to it would spend a press on an
      //    empty pane, so the press goes on to history and exit instead.
      //    `loadedOnce` because a staff account never gets Slim view, and
      //    that is only known once the signed-in user has loaded.
      const atSlimRoot =
        lifecycle.loadedOnce() &&
        slim() &&
        slimIsRoot(window.location.pathname);

      const drawer = state.appDrawer();
      if (
        !atSlimRoot &&
        drawer?.enabled &&
        drawer.state !== SlideState.SHOWN &&
        drawer.state !== SlideState.SHOWING
      ) {
        drawer.setShown(true);
        return;
      }

      // 4. Ordinary in-app navigation, while this session still has somewhere
      //    to go back to.
      if (historyDepth() > baseDepth) {
        history.back();
        return;
      }

      // 5. Nothing left to dismiss and nowhere to navigate: ask native to
      //    leave. No confirmation prompt — deliberately, that would need a new
      //    user-facing string.
      void SlogaBackNative?.exitApp().catch(() => undefined);
    };

    window.addEventListener(BACK_EVENT, onBack);
    onCleanup(() => window.removeEventListener(BACK_EVENT, onBack));
  });

  return null;
}
