import { For, Show, createMemo, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import { useClient, useE2EE } from "@revolt/client";
import { Column, Dialog, DialogProps, Text } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * Turn on end-to-end encryption for a GROUP (implementation plan slice 5,
 * design §2.5).
 *
 * The roster the user confirms here IS the security decision (§2.5, gate
 * finding G2:2/8): it is what gets pinned locally AND asserted inside the
 * authenticated `group_enable` message every member's device receives — so
 * the screen shows the exact member set and count, and asks the user to
 * check it against the member list they expect. Encryption succeeds only if
 * EVERY listed member has verifiable keys (the native layer fails closed
 * otherwise); the group cannot be partially encrypted.
 */
export function E2EEEnableGroupModal(
  props: DialogProps & Modals & { type: "e2ee_enable_group" },
) {
  const { t } = useLingui();
  const client = useClient();
  const e2ee = useE2EE();
  const { showError } = useModals();

  const [busy, setBusy] = createSignal(false);

  const channel = () => client().channels.get(props.channelId);

  const members = createMemo(() =>
    [...(channel()?.recipientIds ?? [])].map((id) => ({
      id,
      username: client().users.get(id)?.username ?? id.slice(0, 8),
    })),
  );

  async function enable() {
    const ch = channel();
    if (!e2ee || !ch) return;
    setBusy(true);
    try {
      await e2ee.enableGroupEncryption(
        ch,
        members().map((m) => m.id),
      );
      props.onClose();
    } catch (error) {
      // Fail closed: a member without verifiable keys aborts the whole
      // enable (nothing was pinned) — surface it, do not partially encrypt.
      showError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Encrypt this group</Trans>}
      isDisabled={busy()}
      actions={[
        {
          text: <Trans>Cancel</Trans>,
          onClick: () => {
            props.onClose();
            return false;
          },
        },
        {
          text: <Trans>Turn on encryption</Trans>,
          onClick: () => {
            void enable();
            return false;
          },
          isDisabled: busy(),
        },
      ]}
    >
      <Column>
        <Text>
          <Trans>
            You are turning on end-to-end encryption for exactly these{" "}
            {members().length} people. Check this list against who you expect to
            be in the group — anyone here will be able to read new messages.
          </Trans>
        </Text>

        <Column
          gap="sm"
          style={{
            padding: "10px 14px",
            "border-radius": "10px",
            border: "1px solid var(--md-sys-color-outline-variant)",
            background: "var(--md-sys-color-surface-container-high)",
          }}
        >
          <For each={members()}>
            {(member) => (
              <span style={{ "font-weight": "500" }}>{member.username}</span>
            )}
          </For>
        </Column>

        <Text size="small">
          <Trans>
            Everyone must have encryption set up, or this will not turn on.
            Encrypted history will live only on each person's own devices, and
            the server will no longer be able to read new messages.
          </Trans>
        </Text>

        <Show when={busy()}>
          <Text size="small">
            <Trans>Gathering keys for every member…</Trans>
          </Text>
        </Show>
      </Column>
    </Dialog>
  );
}
