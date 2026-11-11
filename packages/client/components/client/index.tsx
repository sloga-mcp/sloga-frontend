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

import { useLingui } from "@lingui-solid/solid/macro";

import { useModals } from "@revolt/modal";
import { fetchLatestChangelog } from "@revolt/modal/modals/Changelog";
import { State } from "@revolt/state";

import ClientController from "./Controller";

export type { default as ClientController } from "./Controller";

export {
  fullScreenCallAlertsBlocked,
  openFullScreenCallAlertSettings,
  useNotifications,
} from "./NotificationsController";
export { SoundContext, SoundController, useSound } from "./Sounds";
export {
  allowsDonationLinks,
  allowsSelfUpdate,
  distributionChannel,
  KOFI_PAGE_URL,
} from "./distribution";
export type { DistributionChannel } from "./distribution";
export {
  classifyEnvelopeError,
  E2EEApiError,
  E2EEBridge,
  E2EESendError,
  nativeE2EEAvailable,
} from "./e2ee";
export type { BackupStatusView, E2EEAttachmentMeta, SafetyNumber } from "./e2ee";
export type {
  DeviceRemovedState,
  DeviceSharedState,
  EnvelopeDisposition,
  MlsCallCreated,
  MlsCallState,
  MlsClaimedKeyPackage,
  MlsClaimResult,
  MlsCommitInfo,
  MlsEnvelope,
  MlsFrameKey,
  MlsFrameKeys,
  MlsHttpResult,
  MlsJoinIntentPayload,
  MlsJoinRequest,
  MlsMemberDevice,
  MlsProcessOutcome,
  MlsPublishKeyPackages,
  MlsRosterEntry,
  MlsSessionSink,
  MlsSinkEvent,
  MlsSubmitCommit,
  OwnDeviceAddedEntry,
  OwnDeviceView,
  PublishPendingState,
  RemoveDeviceResult,
  ResponseCreateMlsGroup,
  ResponseSubmitMlsCommit,
  SplitResult,
} from "./e2ee";

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
  const { t } = useLingui();

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
  // The E2EE launch effects below need the current client's native bridge —
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

  // Multi-device plan D3: this install holds an identity the server has not
  // registered yet (a restore, or an interrupted start-fresh), so the bridge
  // raised `publishPending`. Offer the MFA'd first publication. Like the
  // re-enroll modal above, a backstop opened once per episode: the Settings
  // card stays until the publish lands, and a new bridge re-raises the flag.
  let offeredFinishSetup = false;
  createEffect(() => {
    if (!controller.isLoggedIn()) {
      offeredFinishSetup = false;
      return;
    }
    const e2ee = currentE2EE();
    if (!e2ee) return;
    const pending = !!e2ee.publishPending.get("state");
    if (pending && !offeredFinishSetup) {
      offeredFinishSetup = true;
      openModal({ type: "e2ee_finish_setup" });
    } else if (!pending) {
      offeredFinishSetup = false;
    }
  });

  // Plan D5: this install's claim was refused twice because another of the
  // user's apps holds the same device (a clone from a recovery-code restore).
  // Only that refused twin gets the modal; a divergence seen by the lock
  // holder (`via: "diverged"`) is a Settings card only. Once per episode:
  // "Not now" clears the flag, and a new refusal raises it again.
  let offeredDeviceShared = false;
  createEffect(() => {
    if (!controller.isLoggedIn()) {
      offeredDeviceShared = false;
      return;
    }
    const e2ee = currentE2EE();
    if (!e2ee) return;
    const refused = e2ee.deviceShared.get("state")?.via === "held_elsewhere";
    if (refused && !offeredDeviceShared) {
      offeredDeviceShared = true;
      openModal({ type: "e2ee_device_shared" });
    } else if (!refused) {
      offeredDeviceShared = false;
    }
  });

  // Plan D8: the server refused this device as removed from the account's
  // encryption, so re-enrolling it would bring the removed identity back.
  // Offer to set it up again as a new device instead, once per episode.
  let offeredDeviceRemoved = false;
  createEffect(() => {
    if (!controller.isLoggedIn()) {
      offeredDeviceRemoved = false;
      return;
    }
    const e2ee = currentE2EE();
    if (!e2ee) return;
    const removed = !!e2ee.deviceRemoved.get("state");
    if (removed && !offeredDeviceRemoved) {
      offeredDeviceRemoved = true;
      openModal({ type: "e2ee_device_removed" });
    } else if (!removed) {
      offeredDeviceRemoved = false;
    }
  });

  // Scheduled-message delivery failures are permanent (permissions revoked,
  // channel gone, fire-time validation) and arrive on the author's private
  // topic — surface them loudly wherever the user happens to be.
  createEffect(() => {
    if (!controller.isLoggedIn()) return;
    const client = controller.getCurrentClient();
    if (!client) return;

    const onScheduledMessageFail = (
      _id: string,
      _channelId: string,
      reason: string,
    ) => {
      openModal({
        type: "error2",
        error: t`A scheduled message could not be sent: ${reason}`,
      });
    };

    client.addListener("scheduledMessageFail", onScheduledMessageFail);
    onCleanup(() =>
      client.removeListener("scheduledMessageFail", onScheduledMessageFail),
    );
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
