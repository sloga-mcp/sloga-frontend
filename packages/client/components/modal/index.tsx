import {
  For,
  JSXElement,
  Show,
  batch,
  createContext,
  createMemo,
  createSignal,
  onCleanup,
  useContext,
} from "solid-js";
import { SetStoreFunction, createStore } from "solid-js/store";

import type { MFA, MFATicket } from "stoat.js";

import { lastFocusedCtx, windowCtxById } from "@revolt/client/windowCtx";
import { Keybind, KeybindAction } from "@revolt/keybinds";
import { dismissFloatingElements } from "@revolt/ui";

import { MAIN_WINDOW_ID, modalRendersIn } from "./modalWindow";
import { RenderModal } from "./modals";
import { Modals } from "./types";

/**
 * A modal as passed to {@link ModalController.openModal}.
 */
export type ModalRequest = Modals & {
  /**
   * Window to open the modal in: `"main"` or a chat window's id. Defaults to
   * the window the user was last in, so a prompt raised by background work
   * (an E2EE identity change, say) appears where the user is looking.
   */
  windowId?: string;
};

export type ActiveModal = {
  /**
   * Unique modal Id
   */
  id: string;

  /**
   * Whether to show the modal
   */
  show: boolean;

  /**
   * Window the modal was opened for (see {@link ModalRequest.windowId})
   */
  windowId: string;

  /**
   * Props to pass to modal
   */
  props: Modals;
};

/**
 * Drop out of native fullscreen so that a modal about to open is actually on
 * screen.
 *
 * `requestFullscreen()` promotes ONE element into the top layer and paints a
 * `::backdrop` over the rest of the document. Modals are portalled into
 * `#floating`, a SIBLING of `#root` and therefore not inside whatever went
 * fullscreen, so while the call card is fullscreen (VoiceCallCard) every
 * dialog opens invisibly underneath it. No `z-index` reaches past the top
 * layer.
 *
 * Reported 2026-09-10: a user with the call fullscreen started a screen
 * share, answered the browser's own source picker (browser chrome, so
 * unaffected), and never saw the resolution/FPS dialog waiting behind the
 * call — the share sits paused while that dialog is open, so it looked like
 * the share had silently failed, and each retry left another dialog stacked
 * up out of sight.
 *
 * Leaving fullscreen rather than promoting `#floating` into the top layer
 * alongside it: measured in Chrome 2026-09-10, a `popover` host DOES paint
 * above the fullscreen element but is NOT hit-tested there — its
 * `position: fixed` children never receive the click. That trades an
 * invisible dialog for a visible dead one, which is worse. Moving `#floating`
 * into the fullscreen element does work, but it re-parents the live call PiP
 * and its `<video>` elements mid-call.
 *
 * VoiceCallCard's own `fullscreenchange` listener clears `voice.fullscreen()`
 * from here, so the call card's state follows without a second write.
 */
function leaveFullscreenForModal(windowId: string) {
  // The document the modal will paint in: a chat window's own, or main's when
  // that window is gone (the main renderer adopts its modals).
  const doc =
    windowCtxById(windowId)?.doc ??
    (typeof document === "undefined" ? undefined : document);
  if (!doc?.fullscreenElement) return;
  // Rejects when the document already left fullscreen by some other route.
  void doc.exitFullscreen?.().catch(() => undefined);
}

/**
 * Global modal controller for layering and displaying one or more modal to the user
 */
export class ModalController {
  modals: ActiveModal[];
  setModals: SetStoreFunction<ActiveModal[]>;

  /**
   * Id of a modal that must not be dismissed via ESC while an irreversible
   * in-flight action runs (e.g. the §6.4 re-enroll MFA'd first-publish, which
   * must not be detached mid-flight). Scoped to a specific modal id — never a
   * blanket lock — so a leaked lock can only ever affect that one (already
   * gone) modal: `pop()` skips ONLY when the current top-most modal IS the
   * locked one. The backdrop is gated separately by the owning modal's own
   * `onClose`.
   */
  dismissLockedId: string | undefined = undefined;

  /**
   * Construct controller
   */
  constructor() {
    const [modals, setModals] = createStore<ActiveModal[]>([]);
    // eslint-disable-next-line solid/reactivity
    this.modals = modals;
    this.setModals = setModals;

    this.openModal = this.openModal.bind(this);
    this.pop = this.pop.bind(this);
    this.popWhere = this.popWhere.bind(this);
    this.popIn = this.popIn.bind(this);
    this.remove = this.remove.bind(this);
    this.removeOfType = this.removeOfType.bind(this);
    this.isOpen = this.isOpen.bind(this);
    this.isOpenIn = this.isOpenIn.bind(this);
    this.closeAll = this.closeAll.bind(this);
    this.lockDismiss = this.lockDismiss.bind(this);
    this.unlockDismiss = this.unlockDismiss.bind(this);
  }

  /**
   * Add a modal to the stack
   * @param props Modal parameters
   */
  openModal(request: ModalRequest) {
    // Resolved once, at open: a modal stays in the window it opened in even
    // if the user moves to another before answering it.
    const windowId = request.windowId ?? lastFocusedCtx().id;

    // Only rebuilt when the field is present, so every caller that does not
    // pass one hands the modal exactly the object it built, as before.
    let props: Modals = request;
    if ("windowId" in request) {
      const { windowId: _, ...rest } = request;
      props = rest as Modals;
    }

    leaveFullscreenForModal(windowId);

    //Unique ID from clock that can't run backwards
    const id = performance.now().toString();
    this.setModals((modals) => [
      ...modals,
      {
        id,
        show: true,
        windowId,
        props,
      },
    ]);
    dismissFloatingElements();
    // after modal commits to DOM,
    // we can begin animations!
    // setTimeout(
    //   () =>
    //     this.setModals((modals) =>
    //       modals.map((modal) =>
    //         modal.id === id ? { ...modal, show: true } : modal,
    //       ),
    //     ),
    //   0,
    // );
  }

  /**
   * Remove the top modal
   */
  pop() {
    this.popWhere(() => true);
  }

  /**
   * Remove the top modal among those matching `include` (a window's
   * renderer pops only the modals it draws)
   */
  popWhere(include: (modal: ActiveModal) => boolean) {
    const modal = [...this.modals]
      .reverse()
      .find((modal) => modal.show && include(modal));

    if (modal) {
      // Respect an active dismissal lock: never ESC-close the specific modal
      // that holds it (a flow like §6.4 re-enroll is publishing). Scoped by
      // id, so this can only block that one modal — any other top modal pops
      // normally.
      if (modal.id === this.dismissLockedId) return;
      this.remove(modal.id);
    }
  }

  /**
   * Remove the top modal drawn in window `windowId` (`"main"` or a chat
   * window's id), leaving every other window's modals alone
   */
  popIn(windowId: string) {
    this.popWhere((modal) => drawnIn(windowId, modal));
  }

  /**
   * Lock the current top-most modal against ESC dismissal for the duration of
   * an irreversible in-flight action. Returns the locked modal id as a token to
   * pass back to {@link unlockDismiss}, so a release only ever clears the lock
   * it actually took — never another concurrent flow's. Pair with an
   * `onCleanup` unlock so the lock cannot leak.
   */
  lockDismiss(): string | undefined {
    const top = [...this.modals].reverse().find((modal) => modal.show);
    this.dismissLockedId = top?.id;
    return this.dismissLockedId;
  }

  /**
   * Release the ESC dismissal lock set by {@link lockDismiss}. Pass the token
   * that `lockDismiss` returned; the lock is cleared only if it still matches,
   * so a stale/late release can never unlock a different flow's lock.
   */
  unlockDismiss(id?: string) {
    if (id !== undefined && this.dismissLockedId !== id) return;
    this.dismissLockedId = undefined;
  }

  /**
   * Remove all modals
   */
  closeAll() {
    batch(() => {
      for (const modal of this.modals) {
        this.remove(modal.id);
      }
    });
  }

  /**
   * Close every open modal of the given types.
   *
   * For modals that stand for something outside themselves: when that thing
   * is torn down by some OTHER path, the dialog asking about it is stale and
   * has to go with it. Nothing here knows the modal's id — the owner asked
   * for it by type and never got one back — and closing by type is the honest
   * scope anyway, since a stale one is exactly the one whose id is lost.
   *
   * Named types only, never a blanket close: this must not reach past the
   * feature that called it.
   */
  removeOfType(...types: Modals["type"][]) {
    const wanted = new Set<string>(types);
    batch(() => {
      for (const modal of this.modals) {
        if (modal.show && wanted.has(modal.props.type)) this.remove(modal.id);
      }
    });
  }

  /**
   * Close modal by id
   */
  remove(id: string) {
    this.setModals((entry) => entry.id === id, "show", false);

    setTimeout(() => {
      this.setModals(this.modals.filter((entry) => entry.id !== id));
    }, 500); /** FIXME / TODO: set to motion anim time + 100ms */
  }

  /**
   * Whether a modal is currently open
   * @returns Boolean
   */
  isOpen(type?: string) {
    return type
      ? !!this.modals.find((x) => x.show && x.props.type === type)
      : !!this.modals.find((x) => x.show);
  }

  /**
   * Whether a modal of `type` is open and drawn in window `windowId`.
   *
   * {@link isOpen} sees every window, so a caller acting on what the user
   * can see (a confirm dialog they were just shown, say) must ask here, or a
   * dialog sitting in another window would count as answered.
   */
  isOpenIn(type: Modals["type"], windowId: string) {
    return !!this.modals.find(
      (x) => x.show && x.props.type === type && drawnIn(windowId, x),
    );
  }
}

/**
 * Modal controller with additional helpers.
 */
export class ModalControllerExtended extends ModalController {
  /**
   * Construct controller
   */
  constructor() {
    super();

    this.mfaFlow = this.mfaFlow.bind(this);
    this.mfaEnableTOTP = this.mfaEnableTOTP.bind(this);
    this.showError = this.showError.bind(this);
    this.openLink = this.openLink.bind(this);
  }

  /**
   * Perform MFA flow
   * @param mfa MFA helper
   */
  mfaFlow(mfa: MFA) {
    return new Promise((callback: (ticket?: MFATicket) => void) =>
      this.openModal({
        type: "mfa_flow",
        state: "known",
        mfa,
        callback,
      }),
    );
  }

  /**
   * Open TOTP secret modal
   * @param client Client
   */
  mfaEnableTOTP(secret: string, identifier: string) {
    return new Promise((callback: (value?: string) => void) =>
      this.openModal({
        type: "mfa_enable_totp",
        identifier,
        secret,
        callback,
      }),
    );
  }

  /**
   * Show any error
   * @param error Error
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  showError(error: any) {
    this.openModal({
      type: "error2",
      error,
    });
  }

  /**
   * Write text to the clipboard
   * @param text Text to write
   * @deprecated use navigator clipboard directly
   */
  writeText(text: string) {
    navigator.clipboard.writeText(text);
  }

  /**
   * Safely open external or internal link
   * @param href Raw URL
   * @param trusted Whether we trust this link
   * @returns Whether to cancel default event
   */
  openLink(/*href?: string, trusted?: boolean*/) {
    /*const link = determineLink(href);
    const settings = getApplicationState().settings;

    switch (link.type) {
      case "navigate": {
        history.push(link.path);
        break;
      }
      case "external": {
        if (!trusted && !settings.security.isTrustedOrigin(link.url.hostname)) {
          modalController.push({
            type: "link_warning",
            link: link.href,
            callback: () => this.openLink(href, true) as true,
          });
        } else {
          window.open(link.href, "_blank", "noreferrer");
        }
      }
    }*/

    return true;
  }
}

const ModalControllerContext = createContext<ModalControllerExtended>(
  null as unknown as ModalControllerExtended,
);

/**
 * Mount the modal controller
 */
export function ModalContext(props: { children: JSXElement }) {
  const controller = new ModalControllerExtended();

  return (
    <ModalControllerContext.Provider value={controller}>
      {props.children}
    </ModalControllerContext.Provider>
  );
}

/**
 * Use the modal controller
 */
export function useModals() {
  return useContext(ModalControllerContext);
}

/**
 * Chat window id → how many `ModalRenderer`s are mounted for it (normally
 * one). A chat window that is registered but has no renderer, because its
 * chrome has not mounted yet or never will, cannot show a modal, so main
 * keeps drawing its modals until one exists.
 */
const [rendererMounts, setRendererMounts] = createSignal<
  ReadonlyMap<string, number>
>(new Map());

function countRenderer(windowId: string, delta: 1 | -1) {
  setRendererMounts((prev) => {
    const next = new Map(prev);
    const count = (next.get(windowId) ?? 0) + delta;
    if (count > 0) next.set(windowId, count);
    else next.delete(windowId);
    return next;
  });
}

/** A chat window is still open and has a renderer to draw its modals. */
function windowCanRender(windowId: string) {
  return (
    rendererMounts().has(windowId) && windowCtxById(windowId) !== undefined
  );
}

/**
 * Whether window `windowId`'s renderer draws `entry`: the same rule the
 * renderer itself uses, so "open in this window" means "on screen in it".
 */
function drawnIn(windowId: string, entry: ActiveModal) {
  return modalRendersIn(entry.windowId, windowId, windowCanRender);
}

/**
 * Render the modals opened for one window: main (the default) or the chat
 * window `windowId`. Main also draws the modals of any chat window that has
 * closed or cannot draw them, so a modal is never left with no renderer.
 */
export function ModalRenderer(props: { windowId?: string }) {
  const modalController = useModals();

  // A renderer serves one window for its whole life (ChildWindowChrome mounts
  // one per window), so the id is read once.
  // eslint-disable-next-line solid/reactivity
  const windowId = props.windowId ?? MAIN_WINDOW_ID;

  if (windowId !== MAIN_WINDOW_ID) {
    // Counted during render rather than onMount, so main hands the window's
    // modals over in the same pass instead of mounting them once first.
    countRenderer(windowId, 1);
    onCleanup(() => countRenderer(windowId, -1));
  }

  const draws = (entry: ActiveModal) => drawnIn(windowId, entry);

  const modals = createMemo(() => modalController.modals.filter(draws));

  return (
    <>
      <For each={modals()}>
        {(entry) => (
          <RenderModal
            {...entry}
            onClose={() => modalController.remove(entry.id)}
          />
        )}
      </For>
      {/* Escape pops this window's top modal only, never one the user
          cannot see in another window. */}
      <Show when={modals().some((entry) => entry.show)}>
        <Keybind
          keybind={KeybindAction.CLOSE_MODAL}
          onPressed={() => modalController.popWhere(draws)}
        />
      </Show>
    </>
  );
}
