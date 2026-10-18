import { createFormControl, createFormGroup } from "solid-forms";
import { Match, Switch, createMemo, createSignal, untrack } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import { useClient } from "@revolt/client";
import { useState } from "@revolt/state";
import {
  MAX_FRIEND_GROUPS,
  MAX_FRIEND_GROUP_NAME,
} from "@revolt/state/stores/FriendGroups";
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

import { Modals } from "../types";

type SaveError = "limit" | "name" | "unknown";

/**
 * Create a friend category, or manage one (`groupId`): its name and the
 * friends in it, picked from a searchable list, the way Steam does it.
 *
 * Categories are stored as friend groups (the synced `friend-groups` key);
 * "category" is only what the UI calls them, so "group" stays free for group
 * chats.
 */
export function FriendCategoryModal(
  props: DialogProps & Modals & { type: "friend_category" },
) {
  const { t } = useLingui();
  const client = useClient();
  const state = useState();

  const existing = () =>
    props.groupId
      ? state.friendGroups.ordered().find((group) => group.id === props.groupId)
      : undefined;

  const isFriend = (id: string) =>
    client().users.get(id)?.relationship === "Friend";

  // Starting values, read once: the dialog edits the category it opened
  // with. Only friends are offered, so only friends start checked.
  const form = untrack(() =>
    createFormGroup({
      name: createFormControl(existing()?.name ?? "", { required: true }),
      users: createFormControl(
        props.groupId
          ? state.friendGroups.membersOf(props.groupId).filter(isFriend)
          : [],
      ),
    }),
  );

  const [error, setError] = createSignal<SaveError>();

  const [filter, setFilter] = createSignal("");

  const friends = createMemo(() => {
    const search = filter().trim().toLowerCase();
    return client()
      .users.filter((user) => user.relationship === "Friend")
      .filter(
        (user) =>
          !search ||
          user.displayName.toLowerCase().includes(search) ||
          user.username.toLowerCase().includes(search),
      )
      .toSorted((a, b) => a.displayName.localeCompare(b.displayName))
      .map((user) => ({ item: user, value: user.id }));
  });

  /**
   * Write the category. False keeps the dialog open to show the error.
   */
  function save(): boolean {
    const name = form.controls.name.value.trim();
    let id = props.groupId;

    if (id) {
      const current = existing();
      if (!current) {
        // Removed (here or on another device) while the dialog was open
        setError("unknown");
        return false;
      }
      if (name !== current.name && !state.friendGroups.rename(id, name)) {
        setError("name");
        return false;
      }
    } else {
      id = state.friendGroups.create(name) ?? undefined;
      if (!id) {
        setError(
          state.friendGroups.ordered().length >= MAX_FRIEND_GROUPS
            ? "limit"
            : Array.from(name).length > MAX_FRIEND_GROUP_NAME
              ? "name"
              : "unknown",
        );
        return false;
      }
    }

    const wanted = new Set(form.controls.users.value);
    const current = new Set(state.friendGroups.membersOf(id));
    for (const userId of wanted) {
      if (!current.has(userId)) state.friendGroups.assign(id, userId, true);
    }
    // Members who are no longer friends were never shown, so stay as they are
    for (const userId of current) {
      if (!wanted.has(userId) && isFriend(userId)) {
        state.friendGroups.assign(id, userId, false);
      }
    }
    return true;
  }

  return (
    <Dialog
      minWidth={420}
      show={props.show}
      onClose={props.onClose}
      title={
        props.groupId ? (
          <Trans>Manage category</Trans>
        ) : (
          <Trans>Create category</Trans>
        )
      }
      actions={[
        { text: <Trans>Cancel</Trans> },
        {
          text: <Trans>Confirm</Trans>,
          onClick: save,
          isDisabled: !form.controls.name.value.trim(),
        },
      ]}
    >
      <Column>
        <Form2.TextField
          minlength={1}
          maxlength={MAX_FRIEND_GROUP_NAME}
          counter
          name="name"
          control={form.controls.name}
          label={t`Category name`}
        />

        <Text class="label">
          <Trans>Friends in category</Trans>
        </Text>

        <TextField
          value={filter()}
          variant="filled"
          placeholder={t`Start typing a name…`}
          onInput={(event) => setFilter(event.currentTarget.value)}
        />

        <Form2.VirtualSelect
          items={friends()}
          control={form.controls.users}
          multiple
        >
          {(user) => (
            <Row align>
              <Avatar
                src={user.animatedAvatarURL}
                fallback={user.displayName}
                size={24}
              />{" "}
              <span>{user.displayName}</span>
            </Row>
          )}
        </Form2.VirtualSelect>

        <Switch>
          <Match when={error() === "limit"}>
            <Text class="label">
              <Trans>
                You've reached the limit of 50 categories. Remove one to make
                room.
              </Trans>
            </Text>
          </Match>
          <Match when={error() === "name"}>
            <Text class="label">
              <Trans>Category names need 1 to 40 characters.</Trans>
            </Text>
          </Match>
          <Match when={error() === "unknown"}>
            <Text class="label">
              <Trans>Couldn't save that category.</Trans>
            </Text>
          </Match>
        </Switch>
      </Column>
    </Dialog>
  );
}
