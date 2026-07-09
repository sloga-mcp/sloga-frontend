import {
  type JSXElement,
  Accessor,
  createContext,
  createEffect,
  on,
  onCleanup,
  useContext,
} from "solid-js";

import type { Client, User } from "stoat.js";

import { useModals } from "@revolt/modal";
import { fetchLatestChangelog } from "@revolt/modal/modals/Changelog";
import { State } from "@revolt/state";

import ClientController from "./Controller";

export type { default as ClientController } from "./Controller";

export { useNotifications } from "./NotificationsController";
export { SoundContext, SoundController, useSound } from "./Sounds";
export { E2EEBridge, E2EESendError, nativeE2EEAvailable } from "./e2ee";
export type { BackupStatusView, E2EEAttachmentMeta, SafetyNumber } from "./e2ee";

/**
 * The native E2EE bridge for the current client, if this platform has one
 * (Tauri desktop). Undefined on web.
 */
export function useE2EE(): import("./e2ee").E2EEBridge | undefined {
  return useClient()().e2ee as import("./e2ee").E2EEBridge | undefined;
}

const clientContext = createContext(null! as ClientController);

/**
 * Mount the modal controller
 */
export function ClientContext(props: { state: State; children: JSXElement }) {
  const { openModal } = useModals();

  // eslint-disable-next-line solid/reactivity
  const controller = new ClientController(props.state);
  onCleanup(() => controller.dispose());

  // Show patch notes on launch until the user checks "don't show again"
  // (which suppresses them until the next changelog entry).
  let shownChangelog = false;
  createEffect(
    on(
      () => controller.isLoggedIn(),
      (loggedIn) => {
        if (!loggedIn || shownChangelog) return;
        shownChangelog = true;
        fetchLatestChangelog().then((changelog) => {
          if (
            changelog &&
            props.state["release-notes"].lastSeenId !== changelog.id
          ) {
            // Delay past the initial post-login navigation, which dismisses
            // modals opened during the transition (seen on mobile).
            setTimeout(() => openModal({ type: "changelog", changelog }), 2000);
          }
        });
      },
    ),
  );

  createEffect(
    on(
      () => controller.lifecycle.policyAttentionRequired(),
      (attentionRequired) => {
        if (typeof attentionRequired !== "undefined") {
          const [changes, acknowledge] = attentionRequired;

          openModal({
            type: "policy_change",
            changes,
            acknowledge,
          });
        }
      },
    ),
  );

  // Slice 5.5: a returning user on a NEW device — unprovisioned, but the
  // account opted into E2EE on another device — is offered restore-vs-start-
  // fresh BEFORE anything provisions the local store (design §6.1). The native
  // bridge's `#onReady` sets the reactive `restoreAvailable` flag (it never
  // opens the engine on a fresh install); open the opt-in modal in
  // restore-first mode, once per session. A plain effect (no `on`) so it fires
  // whether the flag is already set on first run or set later after ready.
  // Both E2EE launch effects below need the current client's native bridge —
  // extract the cast once.
  const currentE2EE = () =>
    controller.getCurrentClient()?.e2ee as
      | import("./e2ee").E2EEBridge
      | undefined;

  let offeredRestore = false;
  createEffect(() => {
    if (!controller.isLoggedIn()) {
      offeredRestore = false;
      return;
    }
    const e2ee = currentE2EE();
    if (!e2ee) return;
    if (e2ee.restoreAvailable.get("state") && !offeredRestore) {
      offeredRestore = true;
      openModal({ type: "e2ee_enable", offerRestore: true });
    }
  });

  // Slice 5.5 §6.4: a device restored its history but its server-side identity
  // row had been revoked while it was dead, so the post-restore claim was
  // rejected and the bridge raised `reenrollNeeded`. Prompt the second re-auth
  // that re-publishes the restored keys as a first publication. This auto-modal
  // is a BACKSTOP (opened once per episode); the durable recovery path is the
  // persistent Security & Privacy affordance plus the bridge's `#onClaimResult`
  // re-detection, which re-raise `reenrollNeeded` on every reconnect after a
  // dismissal or a restart (design §8 HIGH-1). So a dismissed auto-modal is no
  // longer fatal.
  let offeredReenroll = false;
  createEffect(() => {
    if (!controller.isLoggedIn()) {
      offeredReenroll = false;
      return;
    }
    const e2ee = currentE2EE();
    if (!e2ee) return;
    const needed = !!e2ee.reenrollNeeded.get("state");
    if (needed && !offeredReenroll) {
      offeredReenroll = true;
      openModal({ type: "e2ee_reenroll" });
    } else if (!needed) {
      offeredReenroll = false;
    }
  });

  return (
    <clientContext.Provider value={controller}>
      {props.children}
    </clientContext.Provider>
  );
}

/**
 * Get various lifecycle objects
 * @returns Lifecycle information
 */
export function useClientLifecycle() {
  const {
    login,
    completeOauth,
    logout,
    selectUsername,
    lifecycle,
    isLoggedIn,
    isError,
  } = useContext(clientContext);

  return {
    login,
    completeOauth,
    logout,
    selectUsername,
    lifecycle,
    isLoggedIn,
    isError,
  };
}

/**
 * Get the currently active client if one is available
 * @returns Client
 */
export function useClient(): Accessor<Client> {
  const controller = useContext(clientContext);
  return () => controller.getCurrentClient()!;
}

/**
 * Get the currently logged in user
 * @returns User
 */
export function useUser(): Accessor<User | undefined> {
  const controller = useContext(clientContext);
  return () => controller.getCurrentClient()!.user;
}

/**
 * Plain API client with no authentication
 * @returns API Client
 */
export function useApi() {
  return useContext(clientContext).api;
}

export const IS_DEV = import.meta.env.DEV;
