import { Trans } from "@lingui-solid/solid/macro";
import { Show } from "solid-js";
import type { Channel } from "stoat.js";

import { E2EESendError, useClient } from "@revolt/client";
import { draftRowActions } from "@revolt/client/encryptedOnlyChat";
import { dmPeerId } from "@revolt/client/encryptedOnlyGuard";
import {
  confirmPeerChanged,
  latchVersion,
  latchedForClient,
} from "@revolt/client/encryptedOnlyLatch";
import { useModals } from "@revolt/modal";
import { useState } from "@revolt/state";
import type { UnsentMessage } from "@revolt/state/stores/Draft";

import MdClose from "@material-design-icons/svg/outlined/close.svg?component-solid";
import MdContentCopy from "@material-design-icons/svg/outlined/content_copy.svg?component-solid";
import MdDelete from "@material-design-icons/svg/outlined/delete.svg?component-solid";
import MdRefresh from "@material-design-icons/svg/outlined/refresh.svg?component-solid";
import MdSend from "@material-design-icons/svg/outlined/send.svg?component-solid";

import { failedRowSend } from "../../../src/interface/channels/text/encryptedOnlyComposer";

import {
  ContextMenu,
  ContextMenuButton,
  ContextMenuDivider,
} from "./ContextMenu";

interface Props {
  draft: UnsentMessage;
  channel: Channel;
}

/**
 * Context menu for draft messages
 */
export function DraftMessageContextMenu(props: Props) {
  const state = useState();
  const client = useClient();
  const { openModal } = useModals();

  // A send refused before it went out (not encrypted, or files waiting for
  // a text message) is cancelled rather than deleted: nobody received it.
  // Files waiting for text are refused again as they are, so they offer no
  // retry.
  const actions = () => draftRowActions(props.draft.error);

  // Refused for a peer who may have left Encrypted-only: "Send anyway"
  // confirms the peer and sends it again, in place of a retry that would
  // be refused the same way
  const resend = () => {
    latchVersion();
    return failedRowSend(
      props.draft.error,
      latchedForClient(client().user?.id),
    );
  };

  /**
   * Confirm the peer, then send the message again
   */
  function sendAnyway() {
    const peerId = dmPeerId(client(), props.channel);
    if (!peerId) return;
    confirmPeerChanged(peerId, client().user?.id);
    retrySend();
  }

  /**
   * Retry sending the draft message
   */
  function retrySend() {
    const channel = props.channel;
    state.draft.retrySend(
      client(),
      channel,
      props.draft.idempotencyKey,
      (error) => {
        // A group this device cannot confirm is unencrypted refuses the
        // retry before anything leaves the device. Ask for consent; the
        // entry stays failed and nothing is resent automatically. Any other
        // refusal already shows on the entry, including every protected
        // rejection: the retry went out under this entry's key, and Draft
        // marked it failed with its notice kind, which DraftMessage shows.
        if (
          error instanceof E2EESendError &&
          (error.kind === "group_unconfirmed" ||
            error.kind === "group_unestablished") &&
          channel.type === "Group"
        ) {
          openModal({
            type: "e2ee_group_plaintext_confirm",
            channelId: channel.id,
          });
        }
      },
    );
  }

  /**
   * Copy draft message text to clipboard
   */
  function copyText() {
    if (props.draft.content) {
      navigator.clipboard.writeText(props.draft.content);
    }
  }

  /**
   * Delete the draft message
   */
  function deleteMessage() {
    state.draft.cancelSend(props.channel, props.draft.idempotencyKey);
  }

  return (
    <Show when={props.draft.status !== "sending"}>
      <ContextMenu>
        <Show
          when={
            props.draft.status === "failed" || props.draft.status === "unsent"
          }
        >
          <Show when={resend() === "send-anyway"}>
            <ContextMenuButton icon={MdSend} onClick={sendAnyway}>
              <Trans>Send anyway</Trans>
            </ContextMenuButton>
          </Show>
          <Show when={resend() === "retry"}>
            <ContextMenuButton icon={MdRefresh} onClick={retrySend}>
              <Trans>Retry sending</Trans>
            </ContextMenuButton>
          </Show>
          <Show when={props.draft.content}>
            <ContextMenuButton icon={MdContentCopy} onClick={copyText}>
              <Trans>Copy text</Trans>
            </ContextMenuButton>
          </Show>
          <ContextMenuDivider />
          <Show
            when={actions().refused}
            fallback={
              <ContextMenuButton
                icon={MdDelete}
                onClick={deleteMessage}
                destructive
              >
                <Trans>Delete message</Trans>
              </ContextMenuButton>
            }
          >
            <ContextMenuButton
              icon={MdClose}
              onClick={deleteMessage}
              destructive
            >
              <Trans>Cancel message</Trans>
            </ContextMenuButton>
          </Show>
        </Show>
      </ContextMenu>
    </Show>
  );
}
