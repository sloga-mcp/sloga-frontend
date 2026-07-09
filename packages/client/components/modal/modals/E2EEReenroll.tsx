import { createEffect, createSignal, onCleanup } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";

import { useClient, useE2EE } from "@revolt/client";
import { Column, Dialog, DialogProps, Text } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * §6.4 revoked-device re-enroll.
 *
 * A returning device restored its encrypted history from a backup, but its
 * server-side identity row had been revoked while the install was dead (remote
 * logout). The post-restore device claim was therefore rejected and the bridge
 * raised `reenrollNeeded`. The restored keys are still held in the bridge; this
 * modal confirms account ownership (a SECOND MFA ticket — the first gated
 * `GET /e2ee/backup` during restore) and re-publishes them as a FIRST
 * publication, which re-inserts the same device_id + identity keys and lets the
 * device come back. Peers see the loud same-keys `device_readded` marker — NOT
 * an identity-change warning. The recovery CODE never reaches this webview.
 */
export function E2EEReenrollModal(
  props: DialogProps & Modals & { type: "e2ee_reenroll" },
) {
  const client = useClient();
  const e2ee = useE2EE();
  const modals = useModals();
  const { mfaFlow, showError } = modals;

  const [busy, setBusy] = createSignal(false);

  // Do not let the re-enroll publish be detached mid-flight (design §8 HIGH-1,
  // folded MEDIUM). The backdrop is gated by `guardedClose` below; ESC goes
  // through the controller's global CLOSE_MODAL keybind, so lock it there while
  // busy. Track the token so we only ever release the lock WE took (never a
  // concurrent flow's), and always unlock on cleanup so it cannot leak.
  let lockToken: string | undefined;
  createEffect(() => {
    if (busy()) {
      lockToken = modals.lockDismiss();
    } else if (lockToken) {
      modals.unlockDismiss(lockToken);
      lockToken = undefined;
    }
  });
  onCleanup(() => {
    if (lockToken) modals.unlockDismiss(lockToken);
  });

  /**
   * Dismiss unless a publish is in flight — a stray backdrop click / ESC must
   * not detach `finishReenroll`. Losing the prompt is no longer fatal (the
   * Security & Privacy affordance and the bridge's reconnect re-detection
   * re-offer it), but a detached in-flight MFA'd publish is still worth
   * preventing.
   */
  function guardedClose() {
    if (busy()) return;
    props.onClose();
  }

  /** Prove account ownership; returns the MFA ticket token or undefined. */
  async function reauth(): Promise<string | undefined> {
    const mfa = await client().account.mfa();
    const ticket = await mfaFlow(mfa);
    return ticket?.token;
  }

  async function finish() {
    if (!e2ee) return;
    // Nothing left to re-enroll (already published elsewhere, or the flag was
    // cleared by an accepted claim) — close without burning an MFA prompt.
    if (!e2ee.reenrollNeeded.get("state")) {
      props.onClose();
      return;
    }
    setBusy(true);
    try {
      const token = await reauth();
      if (!token) return;
      // On success the bridge clears `reenrollNeeded`; a failure keeps it set
      // (and the stashed bundle) so the shell can re-offer this prompt.
      await e2ee.finishReenroll(token);
      props.onClose();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      show={props.show}
      onClose={guardedClose}
      title={<Trans>Finish restoring on this device</Trans>}
      isDisabled={busy()}
      actions={[
        {
          text: <Trans>Not now</Trans>,
          onClick: () => {
            guardedClose();
            return false;
          },
          isDisabled: busy(),
        },
        {
          text: <Trans>Confirm identity</Trans>,
          onClick: () => {
            void finish();
            return false;
          },
          isDisabled: busy(),
        },
      ]}
    >
      <Column>
        <Text>
          <Trans>
            This device was logged out remotely, so it needs to be re-registered
            before it can send and receive encrypted messages again. Confirm your
            identity to finish.
          </Trans>
        </Text>
        <Text>
          <Trans>
            Your contacts will see this device come back — with no security
            warning, because its keys are unchanged.
          </Trans>
        </Text>
      </Column>
    </Dialog>
  );
}
