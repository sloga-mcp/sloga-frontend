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
