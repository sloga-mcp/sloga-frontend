import {
  type JSX,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  untrack,
} from "solid-js";
import { Portal } from "solid-js/web";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import localforage from "localforage";
import { styled } from "styled-system/jsx";

import { useState } from "@revolt/state";
import { Button } from "@revolt/ui/components/design";
import { LockedCallScreen } from "@revolt/ui/components/features/voice/lockedCall/LockedCallScreen";

import { useClient, useClientLifecycle } from ".";
import { killServiceWorkerSubscription } from "./NotificationsController";
import {
  appLockAvailable,
  appLockEpoch,
  appLockGateShown,
  appLockPluginOk,
  appLockReady,
  appLockState,
  appLocked,
  clearAppLockParked,
  resetAppLock,
  unlockApp,
} from "./appLock";
import {
  bootReconcile,
  gateView,
  sessionEndPlan,
  shouldAutoPrompt,
} from "./appLockPolicy";

/** Marks the `body` children that stay visible and usable while locked. */
const KEEP = "data-applock-keep";

/** How often the stored session is read while a sign out is finishing. */
const STORE_POLL_MS = 50;

/** How long a sign out waits for the stored session to go. */
const STORE_WAIT_MS = 5_000;

/**
 * How long a sign out from the lock screen waits for push to be turned off
 * for this session. The teardown itself may wait 2 s for a preference re-post
 * before it unsubscribes.
 */
const PUSH_OFF_WAIT_MS = 4_000;

/**
 * When the shell is told the gate is drawn even if no frame was reported.
 * Animation frames can be held back while the shell's own cover is up.
 */
const SHOWN_FALLBACK_MS = 500;

/** What this gate changed on one `body` child, so only that is undone. */
type Hidden = { inert: boolean; aria: boolean };

/**
 * The app lock gate (phones only, a pass-through everywhere else).
 *
 * It holds the app back until the shell has said whether it is locked, and
 * while locked it draws one opaque layer over everything and makes the rest
 * of the page unusable. The app underneath stays mounted, so the connection
 * and a call in progress carry on. The lock screen shows nothing from the
 * account: no names, pictures or counts.
 *
 * It also finishes a sign out. The shell's lock is only reset, and the page
 * only reloaded, once the session is really gone from storage, so "Sign out"
 * on the lock screen can never work as an unlock.
 */
export function AppLockGate(props: { children?: JSX.Element }) {
  const state = useState();
  const { logout } = useClientLifecycle();
  const client = useClient();
  const { t } = useLingui();

  // Fixed for the page load
  const phone = appLockAvailable();

  // The session as the store has it. Not `isLoggedIn()`, which also waits
  // for the connection.
  const hasSession = () => !!state.auth.getSession();

  // A sign out from the lock screen that is not finished yet
  const [ending, setEnding] = createSignal(false);
  // That sign out gave up waiting for storage
  const [timedOut, setTimedOut] = createSignal(false);
  // The second step of Sign out on the lock screen
  const [confirming, setConfirming] = createSignal(false);

  const view = createMemo(() =>
    gateView({
      phone,
      ready: appLockReady(),
      locked: appLocked(),
      hasSession: hasSession(),
      ending: ending(),
    }),
  );

  const active = createMemo(() => view() !== "none");

  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });

  // Hide the rest of the page while the gate is up. The static rule in
  // styles.css hides every `body` child without the marker; `inert` and
  // `aria-hidden` take it away from the keyboard and from screen readers.
  // Only what is set here is undone.
  createEffect(() => {
    const root = document.documentElement;
    if (!active()) {
      delete root.dataset.applock;
      return;
    }

    root.dataset.applock = "1";

    const hidden = new Map<Element, Hidden>();

    const restore = (el: Element, was: Hidden) => {
      if (was.inert) el.removeAttribute("inert");
      if (was.aria && el.getAttribute("aria-hidden") === "true") {
        el.removeAttribute("aria-hidden");
      }
    };

    const hideAll = () => {
      // A node that left `body` gets its own state back, so it is not left
      // unusable wherever it is put next
      for (const [el, was] of hidden) {
        if (el.parentElement !== document.body) {
          restore(el, was);
          hidden.delete(el);
        }
      }

      for (const el of Array.from(document.body.children)) {
        if (hidden.has(el) || el.hasAttribute(KEEP)) continue;

        const was: Hidden = {
          inert: !el.hasAttribute("inert"),
          aria: !el.hasAttribute("aria-hidden"),
        };
        if (was.inert) el.setAttribute("inert", "");
        if (was.aria) el.setAttribute("aria-hidden", "true");
        hidden.set(el, was);
      }
    };

    hideAll();

    // Nodes added later, such as a new portal. A portal marks its wrapper
    // right after it is appended, which is before this callback runs.
    const observer = new MutationObserver(hideAll);
    observer.observe(document.body, { childList: true });

    onCleanup(() => {
      observer.disconnect();
      for (const [el, was] of hidden) restore(el, was);
      hidden.clear();
      delete root.dataset.applock;
    });
  });

  // Locking leaves fullscreen: a fullscreen element is drawn over this layer
  createEffect(
    on(
      () => view() === "lock",
      (locked) => {
        if (locked && document.fullscreenElement) {
          void document.exitFullscreen?.().catch(() => undefined);
        }
      },
    ),
  );

  // The second step never carries over to the next lock
  createEffect(() => {
    if (view() !== "lock") setConfirming(false);
  });

  /** Focus Unlock once its row is in the page. */
  function focusUnlock(row: HTMLElement) {
    queueMicrotask(() => {
      if (row.isConnected) row.querySelector("button")?.focus();
    });
  }

  // Tell the shell when the gate is drawn, so it can lift its own cover:
  // two animation frames, which is one painted frame, or the fallback timer,
  // whichever comes first. A newer report replaces one still waiting.
  let cancelShown: (() => void) | undefined;

  function reportShown() {
    cancelShown?.();

    let done = false;
    let outer = 0;
    let inner = 0;

    const fire = () => {
      if (done) return;
      cancel();
      appLockGateShown();
    };

    const timer = setTimeout(fire, SHOWN_FALLBACK_MS);
    outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(fire);
    });

    function cancel() {
      done = true;
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
      clearTimeout(timer);
    }

    cancelShown = cancel;
  }

  onCleanup(() => cancelShown?.());

  if (phone) {
    // The epoch last reported for the gate now up
    let shownEpoch: number | undefined;
    // Whether the sign-in page was reported
    let signInShown = false;

    createEffect(() => {
      const epoch = appLockEpoch();

      if (!active()) {
        shownEpoch = undefined;
        if (hasSession()) {
          // Unlocked: the shell lifts its cover by itself
          cancelShown?.();
        } else if (!signInShown) {
          signInShown = true;
          reportShown();
        }
        return;
      }

      // Each time the gate goes up, and each time the shell asks for it to
      // be drawn again
      if (shownEpoch !== epoch) {
        shownEpoch = epoch;
        reportShown();
      }
    });
  }

  // The unlock prompt opens by itself, once for each epoch, and only while
  // the page is on screen
  const [visible, setVisible] = createSignal(
    document.visibilityState === "visible",
  );
  const onVisibility = () => setVisible(document.visibilityState === "visible");
  document.addEventListener("visibilitychange", onVisibility);
  onCleanup(() =>
    document.removeEventListener("visibilitychange", onVisibility),
  );

  let promptedEpoch = -1;
  createEffect(() => {
    const epoch = appLockEpoch();
    if (
      shouldAutoPrompt({
        view: view(),
        visible: visible(),
        promptedEpoch,
        epoch,
      })
    ) {
      promptedEpoch = epoch;
      void unlockApp(true).catch(() => undefined);
    }
  });

  /**
   * Wait until the session is gone from storage. The store writes it out a
   * moment after the sign out, and that write is not awaited there, so it is
   * read back here. A read that fails counts as still stored.
   * @param alive Whether this wait is still wanted
   * @returns True once storage holds no session, false if the wait ran out
   */
  async function storedSessionGone(alive: () => boolean): Promise<boolean> {
    const deadline = Date.now() + STORE_WAIT_MS;

    for (;;) {
      try {
        const stored = await localforage.getItem<{ session?: unknown }>("auth");
        if (!stored?.session) return true;
      } catch {
        // Read again below
      }

      if (!alive() || Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, STORE_POLL_MS));
    }
  }

  // The newest sign out being finished. A retry or a second sign out takes
  // over from an older run.
  let endRun = 0;
  // Whether that sign out reloads the page when it is done
  let endReload = false;

  /**
   * Finish a sign out: wait for storage, then reset the shell's lock, then
   * reload if the sign out came from the lock screen. Never in another
   * order. If storage does not let go in time nothing is reset or reloaded.
   */
  async function finishEnd() {
    const run = ++endRun;
    const alive = () => !disposed && run === endRun;
    setTimedOut(false);

    const gone = await storedSessionGone(alive);
    if (!alive()) return;

    if (!gone) {
      setTimedOut(true);
      return;
    }

    // Signed in again meanwhile: that session keeps its lock
    if (untrack(hasSession)) {
      setEnding(false);
      return;
    }

    await resetAppLock();
    if (endReload && alive()) location.reload();
  }

  /** The session ended, for any reason. */
  function end() {
    const wasLocked = untrack(appLocked);
    setEnding(wasLocked);
    clearAppLockParked();

    const plan = sessionEndPlan({ phone, wasLocked });
    if (!plan.reset) return;

    endReload = plan.reload;
    void finishEnd().catch(console.error);
  }

  createEffect(
    on(hasSession, (has, had) => {
      if (had && !has) end();
    }),
  );

  // Boot: the shell's lock is on but nobody is signed in, because the
  // session ended while this gate was not there to see it. Looked at once,
  // when the shell first answers, so it can never loop.
  let bootChecked = false;

  const bootPlan = () =>
    bootReconcile({
      ready: appLockReady(),
      pluginOk: appLockPluginOk(),
      enabled: appLockState().enabled,
      hasSession: hasSession(),
    });

  async function reconcile() {
    // Same rule as a sign out: nothing is reset while storage still holds a
    // session
    const gone = await storedSessionGone(() => !disposed);
    if (!gone || disposed || endRun > 0) return;
    if (untrack(bootPlan) !== "reset-reload") return;

    if (await resetAppLock()) location.reload();
  }

  createEffect(() => {
    if (!phone || bootChecked || !appLockReady()) return;
    bootChecked = true;

    if (untrack(bootPlan) === "reset-reload") {
      void reconcile().catch(console.error);
    }
  });

  function unlock() {
    void unlockApp(false).catch(() => undefined);
  }

  /**
   * Turn push off for this session and wait for it, for at most
   * PUSH_OFF_WAIT_MS. `logout()` starts the same teardown but does not wait
   * for it, and here the page is reloaded right after the sign out, which
   * would cut it off and leave the phone getting this account's
   * notifications. It needs the signed-in client, so it runs before
   * `logout()`. Never rejects: a teardown that fails or is too slow does not
   * hold up the sign out.
   */
  async function pushOff(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, PUSH_OFF_WAIT_MS);
    });

    try {
      await Promise.race([
        Promise.resolve()
          .then(() => killServiceWorkerSubscription(client(), false))
          .catch(console.error),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  // A sign out from the lock screen is running, so a second tap is dropped
  let signingOut = false;

  /** Sign out from the lock screen: push off first, then the sign out. */
  async function endFromLock() {
    if (signingOut) return;
    signingOut = true;

    // "Signing out…" covers the wait. The app stays locked under it.
    setEnding(true);

    try {
      await pushOff();

      // The session ended by itself meanwhile: `end()` is finishing that
      if (disposed || !untrack(hasSession)) return;

      logout();
    } catch (error) {
      console.error(error);
    } finally {
      signingOut = false;
      // Still signed in, so the sign out did not happen: back to the lock
      // screen
      if (!disposed && untrack(hasSession)) setEnding(false);
    }
  }

  function signOut() {
    void endFromLock();
  }

  function retry() {
    void finishEnd().catch(console.error);
  }

  return (
    <>
      <Show when={appLockReady()}>{props.children}</Show>
      <Show when={phone}>
        <Portal ref={(el) => el.setAttribute(KEEP, "")}>
          <Show when={active()}>
            <Layer role="dialog" aria-modal="true" aria-label={t`Sloga`}>
              <Switch>
                <Match when={view() === "lock"}>
                  <LockedCallScreen />
                  <Brand>
                    <Trans>Sloga</Trans>
                  </Brand>
                  <Show
                    when={confirming()}
                    fallback={
                      <Actions ref={focusUnlock}>
                        <Button variant="filled" size="md" onPress={unlock}>
                          <Trans>Unlock</Trans>
                        </Button>
                        <Button
                          variant="text"
                          onPress={() => setConfirming(true)}
                        >
                          <Trans>Sign out</Trans>
                        </Button>
                      </Actions>
                    }
                  >
                    <Line>
                      <Trans>Sign out of Sloga on this device?</Trans>
                    </Line>
                    <Actions>
                      <Button variant="_error" size="md" onPress={signOut}>
                        <Trans>Sign out</Trans>
                      </Button>
                      <Button
                        variant="text"
                        onPress={() => setConfirming(false)}
                      >
                        <Trans>Cancel</Trans>
                      </Button>
                    </Actions>
                  </Show>
                </Match>
                <Match when={view() === "ending"}>
                  <Line role="status">
                    <Trans>Signing out…</Trans>
                  </Line>
                  <Show when={timedOut()}>
                    <Actions>
                      <Button variant="filled" size="md" onPress={retry}>
                        <Trans>Retry</Trans>
                      </Button>
                    </Actions>
                  </Show>
                </Match>
              </Switch>
            </Layer>
          </Show>
        </Portal>
      </Show>
    </>
  );
}

/**
 * The lock layer: over the whole app, edge to edge, and never see-through.
 * Same two background layers as the full-screen ring in
 * `IncomingCallOverlay.tsx`, so a theme cannot make it show what is under
 * it. It sits just below the ring (9999), which stays answerable.
 */
const Layer = styled("div", {
  base: {
    position: "fixed",
    inset: 0,
    zIndex: 9990,

    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--gap-md)",
    paddingTop: "calc(env(safe-area-inset-top, 0px) + var(--gap-xl))",
    paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + var(--gap-xl))",
    paddingInline: "var(--gap-lg)",
    textAlign: "center",
    userSelect: "none",
    overflowY: "auto",

    color: "var(--md-sys-color-on-surface)",
    backgroundColor: "#05090F",
    backgroundImage:
      "linear-gradient(var(--md-sys-color-surface), var(--md-sys-color-surface))",
  },
});

const Brand = styled("div", {
  base: {
    fontSize: "2em",
    fontWeight: 700,
  },
});

const Line = styled("div", {
  base: {
    maxWidth: "100%",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Actions = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: "var(--gap-md)",
    width: "min(320px, 100%)",
    marginTop: "var(--gap-lg)",
    flexShrink: 0,
  },
});
