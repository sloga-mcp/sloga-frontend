import { createFormControl, createFormGroup } from "solid-forms";
import { Match, Show, Switch, createMemo, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { EncryptedOnlyBlockedError } from "stoat.js";
import { styled } from "styled-system/jsx";

import { useClient, useE2EE } from "@revolt/client";
import { deviceStateOf } from "@revolt/client/encryptedOnlyGuard";
import { latchedForClient } from "@revolt/client/encryptedOnlyLatch";
import { useError } from "@revolt/i18n";
import {
  Avatar,
  Column,
  Dialog,
  DialogProps,
  Form2,
  Row,
  Text,
  TextField,
} from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

import {
  type Candidate,
  checkNewGroup,
  newGroupMarked,
} from "./encryptedOnlyModals";

/**
 * Create a new group and optionally add members
 */
export function CreateGroupModal(
  props: DialogProps & Modals & { type: "create_group" },
) {
  const { t } = useLingui();
  const client = useClient();
  const e2ee = useE2EE();
  const errorText = useError();
  const { showError, openModal } = useModals();

  // Callers may pre-select members (e.g. "New group chat" from a friend row).
  // Keep only ids the picker itself would offer (friends), deduplicated, so a
  // stale or non-friend id can never be submitted without being visible.
  const initialUsers = [...new Set(props.initialUsers ?? [])].filter(
    (id) => client().users.get(id)?.relationship === "Friend",
  );

  const group = createFormGroup({
    name: createFormControl("", { required: true }),
    users: createFormControl(initialUsers),
  });

  /** What the encrypted group rules need to know about one person */
  function candidate(id: string): Candidate {
    const user = client().users.get(id);
    return {
      id,
      encrypted: user?.e2eeEnabled === true,
      encryptedOnly: user?.e2eeOnly === true,
      bot: !!user?.bot,
    };
  }

  // Encrypted-only chats: a group with an Encrypted-only creator or member
  // is created encrypted (the server marks it), so it takes at most 24
  // people, all with encryption on, from a device that can encrypt
  const rules = createMemo(() => {
    const members = group.controls.users.value.map(candidate);
    const marked = newGroupMarked(
      latchedForClient(client().user?.id) || client().user?.e2eeOnly === true,
      members,
    );
    return {
      marked,
      ...checkNewGroup({ marked, device: deviceStateOf(client()), members }),
    };
  });

  const withoutEncryptionNames = () =>
    rules()
      .withoutEncryption.map((id) => {
        const user = client().users.get(id);
        return user?.displayName ?? user?.username ?? id;
      })
      .join(", ");

  async function onSubmit() {
    const check = rules();
    if (check.refusal) return;

    try {
      const created = await props.client.channels.createGroup(
        group.controls.name.value,
        group.controls.users.value,
      );

      props.onClose();

      // An encrypted group is encrypted from its first message: the
      // existing enable step runs right away, on this device
      if ((check.marked || created.e2eeOnly) && e2ee) {
        openModal({ type: "e2ee_enable_group", channelId: created.id });
      }
    } catch (err) {
      showError(err);
    }
  }

  const [filter, setFilter] = createSignal("");

  const filterLowercase = createMemo(() => filter().toLowerCase());

  const users = createMemo(() =>
    client()
      .users.filter((user) => user.relationship === "Friend")
      .filter((user) =>
        user.displayName.toLowerCase().includes(filterLowercase()),
      )
      .toSorted((a, b) => a.displayName.localeCompare(b.displayName))
      .map((user) => ({ item: user, value: user.id })),
  );

  const submit = Form2.useSubmitHandler(group, onSubmit);

  return (
    <Dialog
      minWidth={420}
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Create a new group</Trans>}
      actions={[
        { text: <Trans>Close</Trans> },
        {
          text: <Trans>Create</Trans>,
          onClick: () => {
            onSubmit();
            return false;
          },
          isDisabled: !Form2.canSubmit(group) || !!rules().refusal,
        },
      ]}
      isDisabled={group.isPending}
    >
      <form onSubmit={submit}>
        <Column>
          <Form2.TextField
            minlength={1}
            maxlength={32}
            counter
            name="name"
            control={group.controls.name}
            label={t`Group Name`}
          />

          <Text class="label">
            <Trans>Select members to add</Trans>
          </Text>

          <TextField
            value={filter()}
            variant="filled"
            placeholder={t`Search for users...`}
            onKeyUp={(e) => setFilter(e.currentTarget.value)}
          />

          <Form2.VirtualSelect
            items={users()}
            control={group.controls.users}
            multiple
          >
            {(item) => (
              <Row align>
                <Avatar
                  src={item.animatedAvatarURL}
                  fallback={item.displayName}
                  size={24}
                />{" "}
                <span>{item.displayName}</span>
              </Row>
            )}
          </Form2.VirtualSelect>

          <Show when={rules().marked}>
            <Rule>
              <Trans>
                This group is encrypted. Only people with encryption turned on
                can be added (up to 24).
              </Trans>
            </Rule>
          </Show>

          <Show when={rules().withoutEncryption.length}>
            <Refusal role="alert">
              {t`These people have not turned on encryption: ${withoutEncryptionNames()}`}
            </Refusal>
          </Show>

          <Switch>
            <Match when={rules().refusal === "too_many"}>
              <Refusal role="alert">
                <Trans>
                  Remove people until the group has 24 or fewer, you included.
                </Trans>
              </Refusal>
            </Match>
            <Match
              when={
                rules().refusal === "setup" || rules().refusal === "open-app"
              }
            >
              <Refusal role="alert">
                {errorText(
                  new EncryptedOnlyBlockedError(
                    rules().refusal === "open-app" ? "open-app" : "setup",
                  ),
                )}
              </Refusal>
            </Match>
          </Switch>
        </Column>
      </form>
    </Dialog>
  );
}

const Rule = styled("div", {
  base: {
    fontSize: "0.8125rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Refusal = styled("div", {
  base: {
    fontSize: "0.8125rem",
    color: "var(--md-sys-color-error)",
  },
});
