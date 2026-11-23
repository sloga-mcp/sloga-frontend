import { createFormControl, createFormGroup } from "solid-forms";
import { Show, createMemo, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import type { User } from "stoat.js";
import { EncryptedOnlyBlockedError } from "stoat.js";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { buildPlainWriteInput } from "@revolt/client/encryptedOnlyGuard";
import {
  Avatar,
  Column,
  Dialog,
  DialogProps,
  Form2,
  Row,
  TextField,
} from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

import {
  type GroupRefusal,
  addRefusal,
  groupIsMarked,
  refusalSide,
  roomLeft,
} from "./encryptedOnlyModals";

/**
 * Add members to an existing group
 */
export function AddMembersToGroupModal(
  props: DialogProps & Modals & { type: "add_members_to_group" },
) {
  const { t } = useLingui();
  const client = useClient();
  const { showError } = useModals();

  const group = createFormGroup({
    users: createFormControl([] as string[], { required: true }),
  });

  // Encrypted-only chats: a marked group takes only people with
  // encryption on, up to 24 with everyone already in it; a group that is
  // not marked never takes an Encrypted-only person
  const marked = createMemo(() =>
    groupIsMarked(buildPlainWriteInput(client(), props.group)),
  );
  const room = () => roomLeft(marked(), props.group.recipientIds.size);
  const overCap = () => group.controls.users.value.length > room();

  function refusalFor(user: User): GroupRefusal | null {
    return addRefusal({
      marked: marked(),
      groupSize: props.group.recipientIds.size,
      member: {
        id: user.id,
        encrypted: user.e2eeEnabled === true,
        encryptedOnly: user.e2eeOnly === true,
        bot: !!user.bot,
      },
    });
  }

  /** Refused for who they are, not for the group being full */
  const leftOut = (user: User) => {
    const refusal = refusalFor(user);
    return refusal === "no_encryption" || refusal === "recipient";
  };

  async function onSubmit() {
    if (overCap()) return;

    // Checked again for everyone before the first add, so a refusal adds
    // nobody
    for (const id of group.controls.users.value) {
      const user = client().users.get(id);
      const refusal = user ? refusalFor(user) : null;
      if (refusal) {
        showError(new EncryptedOnlyBlockedError(refusalSide(refusal)));
        return;
      }
    }

    try {
      for (const id of group.controls.users.value) {
        await props.group.addMember(id);
      }

      props.onClose();
    } catch (err) {
      showError(err);
    }
  }

  const [filter, setFilter] = createSignal("");

  const filterLowercase = createMemo(() => filter().toLowerCase());

  const friends = createMemo(() =>
    client()
      .users.filter((user) => user.relationship === "Friend")
      .filter((user) => !props.group.recipientIds.has(user.id)),
  );

  const anyLeftOut = createMemo(() => friends().some(leftOut));

  const users = createMemo(() =>
    friends()
      .filter((user) => !leftOut(user))
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
      title={<Trans>Add friends to group</Trans>}
      actions={[
        { text: <Trans>Close</Trans> },
        {
          text: <Trans>Add</Trans>,
          onClick: () => {
            onSubmit();
            return false;
          },
          isDisabled: !Form2.canSubmit(group) || overCap(),
        },
      ]}
      isDisabled={group.isPending}
    >
      <form onSubmit={submit}>
        <Column>
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

          <Show when={marked()}>
            <Rule role={overCap() ? "alert" : undefined} data-over={overCap()}>
              <Trans>
                This group is encrypted. Only people with encryption turned on
                can be added (up to 24).
              </Trans>
            </Rule>
          </Show>

          <Show when={!marked() && anyLeftOut()}>
            <Rule>
              <Trans>
                People who only accept encrypted messages can't be added to this
                group.
              </Trans>
            </Rule>
          </Show>
        </Column>
      </form>
    </Dialog>
  );
}

const Rule = styled("div", {
  base: {
    fontSize: "0.8125rem",
    color: "var(--md-sys-color-on-surface-variant)",
    "&[data-over=true]": {
      color: "var(--md-sys-color-error)",
    },
  },
});
