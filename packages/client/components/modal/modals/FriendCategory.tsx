import { createFormControl, createFormGroup } from "solid-forms";
import {
  Match,
  Switch,
  batch,
  createEffect,
  createMemo,
  createSignal,
  on,
  untrack,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

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

type SaveError = "limit" | "name" | "members" | "unknown";

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

  // The category being edited. A create that could not add every friend
  // keeps the new category, so a second Confirm edits it instead of making
  // another one.
  const [groupId, setGroupId] = createSignal(untrack(() => props.groupId));

  const existing = () => {
    const id = groupId();
    return id
      ? state.friendGroups.ordered().find((group) => group.id === id)
      : undefined;
  };

  // Removed (in another dialog or on another device) while this one is open
  const gone = () => groupId() !== undefined && !existing();

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

  // The name as this dialog last saw it saved. Rename only when the field
  // differs from it: comparing with the live name would undo a rename made
  // on another device whenever only the members were edited here.
  let savedName = untrack(() => existing()?.name ?? "");

  const [error, setError] = createSignal<SaveError>();

  // An error describes the last attempt; editing starts a new one
  createEffect(
    on(
      () => [form.controls.name.value, form.controls.users.value],
      () => setError(undefined),
      { defer: true },
    ),
  );

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
    let id = groupId();

    if (id) {
      // The dialog already says so, and Confirm is disabled
      if (gone()) return false;

      if (name !== savedName) {
        if (!state.friendGroups.rename(id, name)) {
          setError("name");
          return false;
        }
        savedName = name;
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
      setGroupId(id);
      savedName = name;
    }

    const target = id;
    const wanted = new Set(form.controls.users.value);
    const current = new Set(state.friendGroups.membersOf(target));
    let complete = true;

    batch(() => {
      // Removals first, so a full category has room for the additions.
      // Members who are no longer friends were never shown, so stay as
      // they are.
      for (const userId of current) {
        if (!wanted.has(userId) && isFriend(userId)) {
          complete =
            state.friendGroups.assign(target, userId, false) && complete;
        }
      }
      for (const userId of wanted) {
        if (!current.has(userId)) {
          complete =
            state.friendGroups.assign(target, userId, true) && complete;
        }
      }
    });

    if (!complete) {
      setError("members");
      return false;
    }
    return true;
  }

  return (
    <Dialog
      minWidth={420}
      show={props.show}
      onClose={props.onClose}
      title={
        groupId() ? (
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
          isDisabled: gone() || !form.controls.name.value.trim(),
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
          <Match when={gone()}>
            <ErrorText>
              <Trans>
                This category no longer exists. It may have been removed on
                another device.
              </Trans>
            </ErrorText>
          </Match>
          <Match when={error() === "limit"}>
            <ErrorText>
              <Trans>
                You've reached the limit of 50 categories. Remove one to make
                room.
              </Trans>
            </ErrorText>
          </Match>
          <Match when={error() === "name"}>
            <ErrorText>
              <Trans>Category names need 1 to 40 characters.</Trans>
            </ErrorText>
          </Match>
          <Match when={error() === "members"}>
            <ErrorText>
              <Trans>
                A category holds up to 1000 friends, so some weren't added.
              </Trans>
            </ErrorText>
          </Match>
          <Match when={error() === "unknown"}>
            <ErrorText>
              <Trans>Couldn't save that category.</Trans>
            </ErrorText>
          </Match>
        </Switch>
      </Column>
    </Dialog>
  );
}

// Same as the categories dialog's (FriendGroups.tsx)
const ErrorText = styled("span", {
  base: {
    fontSize: "0.8125rem",
    color: "var(--md-sys-color-error)",
  },
});
