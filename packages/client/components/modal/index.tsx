import {
  For,
  JSXElement,
  Show,
  batch,
  createContext,
  useContext,
} from "solid-js";
import { SetStoreFunction, createStore } from "solid-js/store";

import type { MFA, MFATicket } from "stoat.js";

import { Keybind, KeybindAction } from "@revolt/keybinds";
import { dismissFloatingElements } from "@revolt/ui";

import { RenderModal } from "./modals";
import { Modals } from "./types";

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
   * Props to pass to modal
   */
  props: Modals;
};

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
    this.remove = this.remove.bind(this);
    this.isOpen = this.isOpen.bind(this);
    this.closeAll = this.closeAll.bind(this);
    this.lockDismiss = this.lockDismiss.bind(this);
    this.unlockDismiss = this.unlockDismiss.bind(this);
  }

  /**
   * Add a modal to the stack
   * @param props Modal parameters
   */
  openModal(props: Modals) {
    //Unique ID from clock that can't run backwards
    const id = performance.now().toString();
    this.setModals((modals) => [
      ...modals,
      {
        id,
        show: true,
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
    const modal = [...this.modals].reverse().find((modal) => modal.show);

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
 * Render modals
 */
export function ModalRenderer() {
  const modalController = useModals();

  return (
    <>
      <For each={modalController.modals}>
        {(entry) => (
          <RenderModal
            {...entry}
            onClose={() => modalController.remove(entry.id)}
          />
        )}
      </For>
      <Show when={modalController.isOpen()}>
        <Keybind
          keybind={KeybindAction.CLOSE_MODAL}
          onPressed={() => modalController.pop()}
        />
      </Show>
    </>
  );
}
