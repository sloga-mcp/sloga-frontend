import { createSignal } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";

import { useClient, useE2EE } from "@revolt/client";
import { Column, Dialog, DialogProps, Text } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * Receive-side peer-downgrade prompt (design §5.2 [G2: 1]; gate-sitting
 * bug 5).
 *
 * The peer turned encryption off for this conversation. Sending is BLOCKED
 * (fail closed) until the user resolves it through `confirmPeerDowngrade`
 * — the ONLY unblock path. Accept opens the plaintext direction (the
 * native layer still gates the flip behind its own confirm dialog, so the
 * webview merely requests); decline keeps the conversation encrypted on
 * this side and adds the actor to the declined set so repeated notices
 * absorb silently (§2a). No other path may clear this state — an
 * auto-clear would hand the server a silent-downgrade trigger.
 */
export function E2EEPeerDowngradeModal(
  props: DialogProps & Modals & { type: "e2ee_peer_downgrade" },
) {
  const client = useClient();
  const e2ee = useE2EE();
  const { showError } = useModals();

  const [busy, setBusy] = createSignal(false);

  const channel = () => client().channels.get(props.channelId);

  // Returned (as a Promise) from the action onClick: Dialog closes on
  // resolve and STAYS OPEN on reject — do not call onClose here, and do
  // not swallow the error (Dialog's .catch keeps the modal up so the
  // user can retry or bail; the state itself stays fail-closed either
  // way).
  async function resolve(accept: boolean) {
    const target = channel();
    if (!e2ee || !target) return;
    setBusy(true);
    try {
      await e2ee.confirmPeerDowngrade(target, accept);
    } catch (error) {
      showError(error);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Encryption turned off</Trans>}
      isDisabled={busy()}
      actions={[
        {
          text: <Trans>Keep encrypted</Trans>,
          onClick: () => resolve(false),
        },
        {
          text: <Trans>Send unencrypted</Trans>,
          onClick: () => resolve(true),
        },
      ]}
    >
      <Column>
        <Text>
          <Trans>
            This contact turned off end-to-end encryption for this
            conversation.
          </Trans>
        </Text>
        <Text>
          <Trans>
            Continue unencrypted — new messages will be readable by the
            server — or keep the conversation encrypted on your side. Your
            encrypted history is unaffected either way.
          </Trans>
        </Text>
      </Column>
    </Dialog>
  );
}
