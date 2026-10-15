import { For, Show, createMemo, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useClient, useE2EE } from "@revolt/client";
import { nativeE2EEAvailable } from "@revolt/client/e2ee";
import { Column, Dialog, DialogProps, Text } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

import {
  EnableGroupNotice,
  EnableGroupStep,
  enableGroupErrorStep,
  enableGroupOutcomeStep,
  memberLabel,
} from "./E2EEEnableGroup.copy";

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
 *
 * This screen is not the gate. On the native shells "Continue" opens a
 * system dialog the webview cannot draw, dismiss or answer. That dialog is
 * the confirm: it lists the roster native will commit, with names this app
 * supplies.
 */
export function E2EEEnableGroupModal(
  props: DialogProps & Modals & { type: "e2ee_enable_group" },
) {
  const { t } = useLingui();
  const client = useClient();
  const e2ee = useE2EE();
  const { showError } = useModals();

  // `working`, not `busy`: "busy" is also a native outcome, shown below
  const [working, setWorking] = createSignal(false);
  const [notice, setNotice] = createSignal<EnableGroupNotice | null>(null);

  const channel = () => client().channels.get(props.channelId);

  const members = createMemo(() =>
    [...(channel()?.recipientIds ?? [])].map((id) => ({
      id,
      label: memberLabel(id, client().users.get(id)),
    })),
  );

  function noticeText(shown: EnableGroupNotice): string {
    switch (shown) {
      case "busy":
        return t`Try again in a moment.`;
      case "roster_changed":
        return t`The member list changed. Check it and try again.`;
      case "roster_mismatch":
        return t`This group is already encrypted with a different member list. Check the member list and try again.`;
      case "self_user_id":
        return t`This device isn't part of this group's encryption yet. Wait for another member to re-send the member list.`;
      case "mls_store_owned_by_another_account":
        return t`This device's encryption is set up for a different account.`;
      default: {
        const exhaustive: never = shown;
        return exhaustive;
      }
    }
  }

  async function enable() {
    const ch = channel();
    if (!e2ee || !ch) return;
    setWorking(true);
    setNotice(null);
    let step: EnableGroupStep;
    try {
      step = enableGroupOutcomeStep(
        await e2ee.enableGroupEncryption(
          ch,
          members().map((m) => m.id),
        ),
      );
    } catch (error) {
      // Fail closed: the group is never partially encrypted. Native checks
      // the roster before it writes anything, but it pins the roster BEFORE
      // the send, so a later failure (a key fetch, the POST) can leave it
      // pinned locally. Pressing Continue again with the same roster resumes
      // that confirmed enable.
      step = enableGroupErrorStep(error);
      if (step.kind === "error") showError(error);
    } finally {
      setWorking(false);
    }
    if (step.kind === "close") props.onClose();
    else if (step.kind === "stay") setNotice(step.notice);
  }

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Encrypt this group</Trans>}
      isDisabled={working()}
      actions={[
        {
          text: <Trans>Cancel</Trans>,
          onClick: () => {
            props.onClose();
            return false;
          },
        },
        {
          text: <Trans>Continue</Trans>,
          onClick: () => {
            void enable();
            return false;
          },
          isDisabled: working(),
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
              <span style={{ "font-weight": "500" }}>{member.label}</span>
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

        <Show when={working()}>
          <Text size="small">
            <Trans>Gathering keys for every member…</Trans>
          </Text>
        </Show>

        <Show when={notice()}>
          {(shown) => <NoticeText>{noticeText(shown())}</NoticeText>}
        </Show>

        <Show when={nativeE2EEAvailable()}>
          <Text size="small">
            <Trans>You'll confirm this in a system dialog.</Trans>
          </Text>
        </Show>
      </Column>
    </Dialog>
  );
}

const NoticeText = styled("span", {
  base: {
    color: "var(--md-sys-color-error)",
  },
});
