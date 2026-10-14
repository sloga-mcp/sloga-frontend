import { For, Match, Show, Switch, createMemo, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { useState } from "@revolt/state";
import {
  MAX_FRIEND_GROUPS,
  MAX_FRIEND_GROUP_NAME,
} from "@revolt/state/stores/FriendGroups";
import {
  Button,
  Checkbox,
  Column,
  Dialog,
  DialogProps,
  IconButton,
  Text,
} from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { Modals } from "../types";

type CreateError = "limit" | "name" | "unknown";

/**
 * Create, rename, reorder and delete custom friend groups. Given a userId,
 * also assigns that friend to groups.
 */
export function FriendGroupsModal(
  props: DialogProps & Modals & { type: "friend_groups" },
) {
  const { t } = useLingui();
  const state = useState();
  const client = useClient();

  const groups = createMemo(() => state.friendGroups.ordered());
  const friendName = () =>
    props.userId ? client().users.get(props.userId)?.displayName : undefined;

  const [draft, setDraft] = createSignal("");
  const [createError, setCreateError] = createSignal<CreateError>();

  const [editing, setEditing] = createSignal<string>();
  const [editName, setEditName] = createSignal("");
  const [renameFailed, setRenameFailed] = createSignal(false);

  const [confirmDelete, setConfirmDelete] = createSignal<string>();

  function createGroup() {
    const name = draft().trim();
    if (!name) return;

    if (state.friendGroups.create(name) === null) {
      setCreateError(
        groups().length >= MAX_FRIEND_GROUPS
          ? "limit"
          : Array.from(name).length > MAX_FRIEND_GROUP_NAME
            ? "name"
            : "unknown",
      );
      return;
    }

    setDraft("");
    setCreateError(undefined);
  }

  function startRename(id: string, name: string) {
    setConfirmDelete(undefined);
    setRenameFailed(false);
    setEditName(name);
    setEditing(id);
  }

  function cancelRename() {
    setEditing(undefined);
    setRenameFailed(false);
  }

  function saveRename(id: string, current: string) {
    // Saving an unchanged name is just closing the editor, whatever the
    // store would answer for a no-op rename.
    if (editName().trim() === current) return cancelRename();

    if (state.friendGroups.rename(id, editName())) {
      cancelRename();
    } else {
      setRenameFailed(true);
    }
  }

  function deleteGroup(id: string) {
    if (editing() === id) cancelRename();
    setConfirmDelete(undefined);
    state.friendGroups.remove(id);
  }

  return (
    <Dialog
      minWidth={420}
      show={props.show}
      onClose={props.onClose}
      title={
        <Show
          when={friendName()}
          fallback={<Trans>Manage friend groups</Trans>}
        >
          {(name) => <Trans>Choose groups for {name()}</Trans>}
        </Show>
      }
      actions={[{ text: <Trans>Done</Trans> }]}
    >
      <Column>
        <Show
          when={groups().length > 0}
          fallback={
            <Text class="label">
              <Trans>
                You don't have any groups yet. Create one below to organize your
                friends.
              </Trans>
            </Text>
          }
        >
          <GroupList>
            <For each={groups()}>
              {(group, index) => (
                <Switch
                  fallback={
                    <GroupRow>
                      <Show
                        when={props.userId}
                        fallback={<GroupName>{group.name}</GroupName>}
                      >
                        {(userId) => (
                          <GroupCheck>
                            <Checkbox
                              checked={state.friendGroups.isMember(
                                group.id,
                                userId(),
                              )}
                              onChange={(event) =>
                                state.friendGroups.assign(
                                  group.id,
                                  userId(),
                                  event.currentTarget.checked,
                                )
                              }
                            >
                              {group.name}
                            </Checkbox>
                          </GroupCheck>
                        )}
                      </Show>
                      <IconButton
                        size="xs"
                        aria-label={t`Rename group`}
                        onPress={() => startRename(group.id, group.name)}
                      >
                        <Symbol size={18}>edit</Symbol>
                      </IconButton>
                      <IconButton
                        size="xs"
                        aria-label={t`Move up`}
                        isDisabled={index() === 0}
                        onPress={() =>
                          state.friendGroups.move(group.id, index() - 1)
                        }
                      >
                        <Symbol size={18}>arrow_upward</Symbol>
                      </IconButton>
                      <IconButton
                        size="xs"
                        aria-label={t`Move down`}
                        isDisabled={index() === groups().length - 1}
                        onPress={() =>
                          state.friendGroups.move(group.id, index() + 1)
                        }
                      >
                        <Symbol size={18}>arrow_downward</Symbol>
                      </IconButton>
                      <IconButton
                        size="xs"
                        aria-label={t`Delete group`}
                        onPress={() => {
                          cancelRename();
                          setConfirmDelete(group.id);
                        }}
                      >
                        <Symbol size={18}>delete</Symbol>
                      </IconButton>
                    </GroupRow>
                  }
                >
                  <Match when={editing() === group.id}>
                    <Column gap="sm">
                      <GroupRow>
                        <GroupInput
                          ref={(el) => queueMicrotask(() => el.focus())}
                          value={editName()}
                          maxlength={MAX_FRIEND_GROUP_NAME}
                          aria-label={t`Group name`}
                          onInput={(event) =>
                            setEditName(event.currentTarget.value)
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              saveRename(group.id, group.name);
                            } else if (event.key === "Escape") {
                              event.preventDefault();
                              event.stopPropagation();
                              cancelRename();
                            }
                          }}
                        />
                        <IconButton
                          size="xs"
                          aria-label={t`Save`}
                          onPress={() => saveRename(group.id, group.name)}
                        >
                          <Symbol size={18}>check</Symbol>
                        </IconButton>
                        <IconButton
                          size="xs"
                          aria-label={t`Cancel`}
                          onPress={cancelRename}
                        >
                          <Symbol size={18}>close</Symbol>
                        </IconButton>
                      </GroupRow>
                      <Show when={renameFailed()}>
                        <ErrorText>
                          <Trans>Group names need 1 to 40 characters.</Trans>
                        </ErrorText>
                      </Show>
                    </Column>
                  </Match>
                  <Match when={confirmDelete() === group.id}>
                    <ConfirmRow>
                      <Text>
                        <Trans>
                          Delete {group.name}? Your friends stay on your friends
                          list.
                        </Trans>
                      </Text>
                      <GroupRow>
                        <Button
                          variant="text"
                          size="xs"
                          onPress={() => setConfirmDelete(undefined)}
                        >
                          <Trans>Cancel</Trans>
                        </Button>
                        <Button
                          variant="_error"
                          size="xs"
                          onPress={() => deleteGroup(group.id)}
                        >
                          <Trans>Delete</Trans>
                        </Button>
                      </GroupRow>
                    </ConfirmRow>
                  </Match>
                </Switch>
              )}
            </For>
          </GroupList>
        </Show>

        <Column gap="sm">
          <GroupRow>
            <GroupInput
              value={draft()}
              maxlength={MAX_FRIEND_GROUP_NAME}
              placeholder={t`New group name`}
              aria-label={t`New group name`}
              onInput={(event) => {
                setDraft(event.currentTarget.value);
                setCreateError(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  createGroup();
                }
              }}
            />
            <Button
              variant="tonal"
              size="sm"
              isDisabled={!draft().trim()}
              onPress={createGroup}
            >
              <Trans>Add</Trans>
            </Button>
          </GroupRow>
          <Switch>
            <Match when={createError() === "limit"}>
              <ErrorText>
                <Trans>
                  You've reached the limit of 50 groups. Delete one to make
                  room.
                </Trans>
              </ErrorText>
            </Match>
            <Match when={createError() === "name"}>
              <ErrorText>
                <Trans>Group names need 1 to 40 characters.</Trans>
              </ErrorText>
            </Match>
            <Match when={createError() === "unknown"}>
              <ErrorText>
                <Trans>Couldn't create that group.</Trans>
              </ErrorText>
            </Match>
          </Switch>
        </Column>
      </Column>
    </Dialog>
  );
}

const GroupList = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-xs)",
    maxHeight: "50vh",
    overflowY: "auto",
  },
});

const GroupRow = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    minHeight: "40px",
  },
});

const ConfirmRow = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: "var(--gap-xs)",
    padding: "8px 12px",
    borderRadius: "8px",
    background: "var(--md-sys-color-surface-container-high)",
    "& > span": {
      alignSelf: "flex-start",
    },
  },
});

const GroupName = styled("span", {
  base: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

const GroupCheck = styled("div", {
  base: {
    flexGrow: 1,
    minWidth: 0,
  },
});

const GroupInput = styled("input", {
  base: {
    flexGrow: 1,
    minWidth: 0,
    padding: "8px 12px",
    borderRadius: "8px",
    background: "var(--md-sys-color-surface-container-high)",
    border: "1px solid var(--md-sys-color-outline-variant)",
    color: "var(--md-sys-color-on-surface)",
    fontSize: "0.9rem",
    "&:focus": {
      outline: "none",
      borderColor: "var(--md-sys-color-primary)",
    },
  },
});

const ErrorText = styled("span", {
  base: {
    fontSize: "0.8125rem",
    color: "var(--md-sys-color-error)",
  },
});
