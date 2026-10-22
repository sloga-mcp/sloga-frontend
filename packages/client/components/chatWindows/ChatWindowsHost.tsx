import {
  For,
  JSX,
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";
import { Portal } from "solid-js/web";

import type { Client } from "stoat.js";
import { styled } from "styled-system/jsx";

import { type E2EEBridge, useClient, useClientLifecycle } from "@revolt/client";
import { ChildWindowChrome } from "@revolt/client/ChildWindowChrome";
import * as chatShell from "@revolt/client/chatShell";
import {
  type ChildWindowHandle,
  openInMain,
  setInternalLinkHandler,
  tryOpenChildWindow,
} from "@revolt/client/childWindow";
import { useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";

import { ChatWindowView } from "./ChatWindowView";
import { FriendsWindow } from "./FriendsWindow";
import { TabStrip } from "./TabStrip";
import {
  DRAG_FLAG_EVENTS,
  clearStaleTabDrag,
  dragFlagAction,
  forgetWindow,
  markTabDragEnd,
  markTabDragStart,
} from "./chatWindowFrame";
import {
  chatWindows,
  closeTab,
  closeWindow,
  onFocusRequest,
  openConversation,
  setFriendsOpen,
} from "./chatWindowsStore";
import { bareConversationIdFromHref } from "./dmLinks";
import {
  FRIENDS_KEY,
  childGoneAction,
  childWindowRequest,
  closeNow,
  deadTabs,
  desiredKeys,
  keyActive,
  mainShownLatch,
  openFailureAction,
  ownerConfirmed,
  planHost,
  restoreKeysOnActivate,
  unprimedTabs,
} from "./hostPlan";
import { chatWindowsMode } from "./openConversation";
import { tabDragSource } from "./tabDrop";

/** How often a close deferred by a tab drag re-checks whether it ended. */
const DRAG_POLL_MS = 100;

/**
 * Owns the desktop child windows: one chat window per chat-window store
 * entry, plus the friends window, each rendered from here through a
 * `<Portal>` so it shares this tree's client, state, modals and i18n.
 *
 * Mounted once, in the main window. Inert until main has been shown, and
 * unless the shell has answered the capability probe and the device-local
 * layout has been confirmed as this account's. Every child, the friends
 * window included, also needs chat-windows mode: one setting moves the
 * friends list and the conversations together. Switching the mode off closes
 * them all, keeping their layout for when it comes back on.
 */
export function ChatWindowsHost(): JSX.Element {
  const state = useState();
  const client = useClient();
  const voice = useVoice();
  const { isLoggedIn } = useClientLifecycle();

  /** Live children by key (store window id, or FRIENDS_KEY). */
  const [handles, setHandles] = createSignal<
    ReadonlyMap<string, ChildWindowHandle>
  >(new Map());
  const keyOf = new WeakMap<ChildWindowHandle, string>();
  /** Keys whose child is still opening. */
  const pending = new Set<string>();
  /** Children the host closed itself; their close never changes the store. */
  const hostClosed = new WeakSet<ChildWindowHandle>();
  /** Keys whose next open is a restore (retried once on failure). */
  let restoreKeys = new Set<string>();
  const retryTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Unwanted children kept open until a tab drag ends, by key. */
  const deferredCloses = new Map<
    string,
    { handle: ChildWindowHandle; since: number }
  >();
  let dragPoll: ReturnType<typeof setInterval> | undefined;
  let mainUnloading = false;
  let disposed = false;

  // Launched at login, main starts hidden or minimized; probing and
  // restoring then would put child windows on screen ahead of it. Both wait
  // for main to be shown once.
  const [mainShown, setMainShown] = createSignal(
    mainShownLatch(false, document.visibilityState),
  );
  const onMainVisibility = () => {
    if (!setMainShown((s) => mainShownLatch(s, document.visibilityState))) {
      return;
    }
    document.removeEventListener("visibilitychange", onMainVisibility);
  };
  onMount(() => {
    if (!mainShown()) {
      document.addEventListener("visibilitychange", onMainVisibility);
    }
  });

  // From main at startup, never lazily from a chat window.
  createEffect(() => {
    if (mainShown()) untrack(() => void chatShell.probeChatWindows());
  });

  // childWindow closes every child on main's pagehide, and the layout must
  // survive that to be restored. Capture at the target runs before its
  // (bubble) listener, so the close callbacks below already see the unload.
  const onMainPagehide = () => {
    mainUnloading = true;
  };
  window.addEventListener("pagehide", onMainPagehide, true);

  // Channels resolve only once the client has been Ready. Latched per client
  // so a reconnect (ready() drops and returns) keeps the windows open.
  const [readyClient, setReadyClient] = createSignal<Client>();
  createEffect(() => {
    const current = client();
    if (current.ready()) setReadyClient(() => current);
  });

  // The layout is per device. Until SyncWorker's owner check has passed for
  // this session it may be the previous account's (the check resets it on a
  // mismatch), so nothing is opened or restored before then.
  const ownerOk = () =>
    ownerConfirmed(
      state.sync.owner,
      state.auth.getSession()?.userId ?? client().user?.id,
    );

  // The shell can host child windows. Requires a probed shell, where
  // chatWindowsMode counts an unprobed one as able: a restore must not race
  // the probe on a shell without the commands.
  const shellActive = createMemo(
    () =>
      mainShown() &&
      isLoggedIn() &&
      chatShell.chatWindowsAvailable() === true &&
      ownerOk() &&
      readyClient() === client(),
  );
  // Chat windows and the friends window may be shown: the shell is active
  // and the mode is on.
  const chatActive = createMemo(() => shellActive() && chatWindowsMode(state));

  const wanted = createMemo(() =>
    desiredKeys(
      shellActive(),
      chatActive(),
      chatWindows.windows(),
      chatWindows.friendsOpen(),
    ),
  );

  // Restore keys, per kind: both the friends window and the chat windows
  // restore when chat-windows mode becomes active (at startup, or when the
  // mode is switched on). Only an open's settling reads them, and that is
  // always asynchronous, so the reconcile below running first in the same
  // flush cannot fail an open before its restore keys are recorded.
  let wasChatActive = false;
  createEffect(() => {
    const isChatActive = chatActive();
    const desired = untrack(wanted);
    let keys = restoreKeys;
    for (const kind of ["friends", "chat"] as const) {
      keys =
        restoreKeysOnActivate(
          keys,
          kind,
          wasChatActive,
          isChatActive,
          desired,
        ) ?? keys;
    }
    wasChatActive = isChatActive;
    restoreKeys = keys;
  });

  function forget(key: string, handle: ChildWindowHandle) {
    setHandles((prev) => {
      if (prev.get(key) !== handle) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }

  function closeByHost(key: string, handle: ChildWindowHandle) {
    hostClosed.add(handle);
    forget(key, handle);
    handle.close();
  }

  /** The store stops claiming a window that is not there. */
  function dropFromStore(key: string) {
    if (key === FRIENDS_KEY) setFriendsOpen(false);
    else closeWindow(key);
  }

  function childGone(key: string, handle: ChildWindowHandle) {
    const action = childGoneAction(key, hostClosed.has(handle), mainUnloading);
    // One batch: forgetting the handle first, on its own, would make the
    // reconcile below reopen a window the user just closed.
    batch(() => {
      if (action.type === "closeWindow") closeWindow(action.id);
      else if (action.type === "closeFriends") setFriendsOpen(false);
      forget(key, handle);
      if (handle.shellLabel !== undefined) forgetWindow(handle.shellLabel);
    });
  }

  function openOne(key: string, attempt = 0) {
    // Main is going away: forgetting the closed children must not reopen
    // them, and the layout stays saved for the next start.
    if (mainUnloading || disposed) return;
    pending.add(key);
    const win =
      key === FRIENDS_KEY
        ? undefined
        : chatWindows.windows().find((w) => w.id === key);
    const { kind, opts } = childWindowRequest(key, win);

    // tryOpenChildWindow queues opens, so they arm and open one at a time.
    void tryOpenChildWindow(kind, opts).then((result) => {
      pending.delete(key);
      const stillWanted =
        !disposed && !mainUnloading && untrack(wanted).includes(key);

      if (!result.ok) {
        if (!stillWanted) {
          restoreKeys.delete(key);
          return;
        }
        // Refused by the shell, blocked, or not prepared.
        const action = openFailureAction(
          restoreKeys.has(key),
          attempt,
          result.err,
        );
        if (action.type === "retry") {
          console.warn("[chat-windows] retrying the open of", key, result.err);
          // Still pending, so the reconcile does not reopen it meanwhile.
          pending.add(key);
          const timer = setTimeout(() => {
            retryTimers.delete(timer);
            pending.delete(key);
            if (!disposed && !mainUnloading && untrack(wanted).includes(key)) {
              openOne(key, attempt + 1);
            } else {
              restoreKeys.delete(key);
            }
          }, action.delayMs);
          retryTimers.add(timer);
          return;
        }
        restoreKeys.delete(key);
        console.warn("[chat-windows] could not open a window for", key);
        dropFromStore(key);
        return;
      }

      const handle = result.handle;
      restoreKeys.delete(key);
      // Closed, switched off or signed out while it was opening.
      if (!stillWanted) {
        hostClosed.add(handle);
        handle.close();
        return;
      }

      // A new native window always starts not maximized, and the friends
      // window's label is reused: a state left from an earlier window with
      // this label would show restore on a window that is not maximized.
      if (handle.shellLabel !== undefined) forgetWindow(handle.shellLabel);
      keyOf.set(handle, key);
      handle.onClose(() => childGone(key, handle));
      setHandles((prev) => new Map(prev).set(key, handle));
    });
  }

  function stopDragPoll() {
    if (dragPoll !== undefined) clearInterval(dragPoll);
    dragPoll = undefined;
  }

  /**
   * Close the unwanted child of `key` now, or keep it until the tab drag in
   * progress ends (its last tab may have just been dragged out of it). A
   * child whose kind went inactive (mode off, signed out) closes at once.
   */
  function closeUnwanted(key: string, handle: ChildWindowHandle) {
    const deferred = deferredCloses.get(key);
    const since = deferred?.handle === handle ? deferred.since : Date.now();
    const kindActive = untrack(() =>
      keyActive(key, shellActive(), chatActive()),
    );
    if (closeNow(kindActive, tabDragSource() !== null, Date.now() - since)) {
      deferredCloses.delete(key);
      closeByHost(key, handle);
    } else {
      deferredCloses.set(key, { handle, since });
      dragPoll ??= setInterval(recheckDeferredCloses, DRAG_POLL_MS);
    }
  }

  /** The drag source is plain module state, so its end is polled for. */
  function recheckDeferredCloses() {
    for (const [key, { handle }] of [...deferredCloses]) {
      // Gone already (the user closed it), or wanted again.
      if (
        untrack(handles).get(key) !== handle ||
        untrack(wanted).includes(key)
      ) {
        deferredCloses.delete(key);
        continue;
      }
      closeUnwanted(key, handle);
    }
    if (!deferredCloses.size) stopDragPoll();
  }

  // Exactly one child per wanted key.
  createEffect(() => {
    const plan = planHost(wanted(), handles().keys(), pending);
    untrack(() => {
      for (const key of plan.close) {
        const handle = handles().get(key);
        if (handle) closeUnwanted(key, handle);
      }
      for (const key of plan.open) openOne(key);
    });
  });

  // Tabs whose channel is gone (deleted, left, or restored from a layout
  // that outlived it) would leave a window with nothing to show. Only while
  // chat windows are shown: in "main window" mode the layout waits untouched.
  createEffect(() => {
    if (!chatActive()) return;
    const current = client();
    if (!current.ready()) return;
    const dead = deadTabs(
      chatWindows.windows(),
      (id) => !!current.channels.get(id),
    );
    if (dead.length) untrack(() => batch(() => dead.forEach(closeTab)));
  });

  // D5: prime the send mode when a tab is created, not only when it is
  // shown, so its badge is right before it is first selected. Once per
  // channel per session; the same calls Composition makes on open.
  const primed = new Set<string>();
  createEffect(() => {
    if (!chatActive()) return;
    const current = client();
    const e2ee = current.e2ee as E2EEBridge | undefined;
    if (!e2ee) return;

    for (const id of unprimedTabs(chatWindows.windows(), primed)) {
      const channel = current.channels.get(id);
      if (!channel) continue;

      if (channel.type === "DirectMessage") {
        // Retried when the recipient loads (this effect tracks it).
        const peer = channel.recipient?.id;
        if (!peer) continue;
        primed.add(id);
        void e2ee
          .primeSendMode(peer)
          .catch((err) => console.warn("[chat-windows] prime failed", err));
        e2ee.reconcilePeerOnOpen(peer);
      } else if (channel.type === "Group") {
        primed.add(id);
        void e2ee
          .primeGroupMode(id)
          .catch((err) => console.warn("[chat-windows] prime failed", err));
        void e2ee
          .groupReconcile(channel)
          .catch((err) => console.warn("[chat-windows] reconcile failed", err));
      } else {
        primed.add(id);
      }
    }
  });

  /**
   * The conversation a link should open as a chat-window tab: a link to a
   * DM or group itself (not to a message in it, which only main can jump
   * to) that this session knows. Not the one whose call is live: a call
   * shows in main, and its links must keep going there.
   */
  function tabForLink(href: string): string | undefined {
    const id = bareConversationIdFromHref(href, window.location.href);
    if (!id) return undefined;
    const type = client().channels.get(id)?.type;
    if (type !== "DirectMessage" && type !== "Group") return undefined;
    if (voice.channel()?.id === id) return undefined;
    return id;
  }

  // In chat-windows mode a link to a conversation opens it as a tab,
  // wherever it is clicked: a chat window (a DM link in a message) or main
  // itself (a modified click on a sidebar row). Links to a message keep
  // their old route: a chat window hands them to main, which jumps there.
  createEffect(() => {
    if (!chatActive()) return;

    setInternalLinkHandler((href) => {
      const id = tabForLink(href);
      if (id) openConversation(id);
      else
        void openInMain(href).catch((err) =>
          console.error("[chat-windows] internal link failed", err),
        );
    });

    // Capture runs before the router's document-level anchor handler,
    // which leaves a click alone once it has been handled.
    const onMainClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!anchor || anchor.hasAttribute("download")) return;
      const target = anchor.getAttribute("target");
      if (target && target !== "_self") return;

      const id = tabForLink(anchor.getAttribute("href") ?? "");
      if (!id) return;
      event.preventDefault();
      openConversation(id);
    };
    document.addEventListener("click", onMainClick, true);

    onCleanup(() => {
      setInternalLinkHandler(null);
      document.removeEventListener("click", onMainClick, true);
    });
  });

  // openConversation of a tab that is already open asks for its window, and
  // opening the friends window while it is open asks for that one: the
  // store's FRIENDS_WINDOW_ID is the host's FRIENDS_KEY.
  onCleanup(
    onFocusRequest((windowId) => {
      untrack(handles).get(windowId)?.focus();
    }),
  );

  onCleanup(() => {
    disposed = true;
    window.removeEventListener("pagehide", onMainPagehide, true);
    document.removeEventListener("visibilitychange", onMainVisibility);
    for (const timer of retryTimers) clearTimeout(timer);
    retryTimers.clear();
    stopDragPoll();
    deferredCloses.clear();
    // Unmounting removes the portals, which would leave empty windows. The
    // layout is kept.
    for (const handle of untrack(handles).values()) {
      hostClosed.add(handle);
      handle.close();
    }
  });

  return (
    <For each={[...handles().values()]}>
      {(handle) => {
        const key = keyOf.get(handle)!;
        watchDragFlag(handle.ctx.doc);
        return (
          <Portal mount={handle.ctx.doc.body}>
            <ChildWindowChrome ctx={handle.ctx}>
              <Fill>
                {key === FRIENDS_KEY ? (
                  <FriendsWindow
                    frame={handle.frame}
                    shellLabel={handle.shellLabel}
                  />
                ) : (
                  <ChatWindowContent
                    windowId={key}
                    frame={handle.frame}
                    shellLabel={handle.shellLabel}
                  />
                )}
              </Fill>
            </ChildWindowChrome>
          </Portal>
        );
      }}
    </For>
  );
}

/**
 * Keep the drag flag (`tabDragActive`) right in the child document `doc`,
 * for as long as the calling owner (one rendered window) lives: raised
 * while files dragged in from outside the app are over the window, so the
 * title bars' free space stops refusing them; ended at a `drop` or
 * `dragend`; cleared when a pointer event shows a drag ended without telling
 * us. Which event does what is `dragFlagAction`'s.
 *
 * Capture phase, so a listener that stops propagation cannot hide an event.
 * A child's events never reach main's document, so each window gets its own
 * listeners.
 */
function watchDragFlag(doc: Document) {
  const onEvent = (event: Event) => {
    const action = dragFlagAction(event as DragEvent & PointerEvent);
    if (action === "raise") markTabDragStart();
    else if (action === "end") markTabDragEnd();
    else if (action === "stale") clearStaleTabDrag();
  };
  const opts = { capture: true, passive: true } as const;
  for (const type of DRAG_FLAG_EVENTS)
    doc.addEventListener(type, onEvent, opts);
  onCleanup(() => {
    try {
      for (const type of DRAG_FLAG_EVENTS) {
        doc.removeEventListener(type, onEvent, opts);
      }
    } catch {
      // A closed window's listeners die with it.
    }
  });
}

/** The tab strip over the active tab's conversation. */
function ChatWindowContent(props: {
  windowId: string;
  frame: ChildWindowHandle["frame"];
  shellLabel?: string;
}) {
  const client = useClient();
  const activeId = createMemo(
    () => chatWindows.windows().find((w) => w.id === props.windowId)?.active,
  );

  // Keyed on the id, so switching tabs mounts a fresh view while a store
  // change that keeps the active tab leaves it alone.
  return (
    <>
      <TabStrip
        windowId={props.windowId}
        frame={props.frame}
        shellLabel={props.shellLabel}
        onCloseWindow={() => closeWindow(props.windowId)}
      />
      <Body>
        <Show when={activeId()} keyed>
          {(id) => (
            <Show when={client().channels.get(id)}>
              {(channel) => (
                <ChatWindowView channel={channel()} windowId={props.windowId} />
              )}
            </Show>
          )}
        </Show>
      </Body>
    </>
  );
}

const Fill = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    minHeight: 0,
    overflow: "hidden",
  },
});

const Body = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
  },
});
