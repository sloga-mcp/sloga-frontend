import { For, Match, Show, Switch, createMemo, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import type { User } from "stoat.js";
import { cva } from "styled-system/css";

import { ContextMenu, ContextMenuButton } from "@revolt/app/menus/ContextMenu";
import { useClient } from "@revolt/client";
import { IS_POPOUT_WINDOW } from "@revolt/client/popout";
import { useModals } from "@revolt/modal";
import { useState } from "@revolt/state";
import { MAX_FRIEND_GROUP_NAME } from "@revolt/state/stores/FriendGroups";
import { IconButton } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import MdDelete from "@material-design-icons/svg/outlined/delete.svg?component-solid";
import MdEdit from "@material-design-icons/svg/outlined/edit.svg?component-solid";
import MdTune from "@material-design-icons/svg/outlined/tune.svg?component-solid";

import { FriendRow } from "./FriendRow";
import { FriendSection } from "./FriendSection";
import { conversationUnread, createDmMap, isInGame } from "./friendData";

/**
 * Collapse key of a custom group's section in the `friends` store
 */
const groupKey = (id: string) => `group:${id}`;

/**
 * The legacy friends popout never persists or syncs its stores, so a group
 * edited there would be silently lost; it shows groups but cannot change them
 */
const GROUPS_READ_ONLY = IS_POPOUT_WINDOW;

/**
 * Steam-style friends list: search, then In game, Favorites, each custom
 * group, Online and Offline.
 *
 * In game, Favorites and the custom groups are views a friend can appear in
 * several of; Online and Offline hold whoever is in none of In game or
 * Favorites (the page has always kept favourites out of them). Custom groups
 * are left out of that rule on purpose: a group is a tag, and hiding its
 * members from Online would make the count lie about who is around.
 */
export function FriendsList(props: {
  onOpenConversation(userId: string): void;
}) {
  const { t } = useLingui();
  const client = useClient();
  const state = useState();
  const { openModal } = useModals();

  const dmMap = createDmMap(client);

  // A signal rather than a plain ref so the virtual lists see it once set
  const [scroller, setScroller] = createSignal<HTMLDivElement>();

  const [query, setQuery] = createSignal("");

  /**
   * Group whose section is swapped for a rename field or a delete prompt
   */
  const [editing, setEditing] = createSignal<{
    id: string;
    mode: "rename" | "delete";
  }>();
  const [editName, setEditName] = createSignal("");
  const [renameFailed, setRenameFailed] = createSignal(false);

  /**
   * Match a user against the current search query
   */
  function matches(user: User) {
    const search = query().trim().toLowerCase();
    if (!search) return true;
    return (
      user.displayName.toLowerCase().includes(search) ||
      user.username.toLowerCase().includes(search)
    );
  }

  const byName = (a: User, b: User) =>
    a.displayName.localeCompare(b.displayName);

  // online users on top, the way the status sections read
  const onlineFirst = (a: User, b: User) =>
    Number(b.online) - Number(a.online) || byName(a, b);

  /**
   * Friends matching the search box, by name
   */
  const friends = createMemo(() =>
    (client()?.users.toList() ?? [])
      .filter((user) => user.relationship === "Friend")
      .filter(matches)
      .sort(byName),
  );

  const lists = createMemo(() => {
    const list = friends();
    const favourite = (user: User) => state.friends.isFavourite(user.id);
    const rest = list.filter((user) => !isInGame(user) && !favourite(user));

    return {
      inGame: list.filter(isInGame),
      favourites: list.filter(favourite).sort(onlineFirst),
      online: rest.filter((user) => user.online),
      offline: rest.filter((user) => !user.online),
    };
  });

  /**
   * Custom group ids in display order. Strings, so `For` keeps each section
   * mounted across store writes instead of rebuilding them all.
   */
  const groupIds = createMemo(() =>
    state.friendGroups.ordered().map((group) => group.id),
  );

  const groupName = (id: string) =>
    state.friendGroups.ordered().find((group) => group.id === id)?.name ?? "";

  /**
   * Friends in a custom group, matching the search box
   */
  function groupMembers(id: string) {
    const members = new Set(state.friendGroups.membersOf(id));
    return friends()
      .filter((user) => members.has(user.id))
      .sort(onlineFirst);
  }

  function manageGroups(userId?: string) {
    openModal({ type: "friend_groups", userId });
  }

  function startRename(id: string) {
    setRenameFailed(false);
    setEditName(groupName(id));
    setEditing({ id, mode: "rename" });
  }

  function stopEditing() {
    setEditing(undefined);
    setRenameFailed(false);
  }

  function saveRename(id: string) {
    // an unchanged name just closes the field, whatever the store answers
    if (editName().trim() === groupName(id)) return stopEditing();

    if (state.friendGroups.rename(id, editName())) {
      stopEditing();
    } else {
      setRenameFailed(true);
    }
  }

  function deleteGroup(id: string) {
    stopEditing();
    state.friendGroups.remove(id);

    // the collapse key is synced too, so it should not outlive the group
    if (state.friends.isCollapsed(groupKey(id))) {
      state.friends.toggleCollapsed(groupKey(id));
    }
  }

  /**
   * Row with the unread pill, hover actions and a "Groups…" button that
   * assigns this friend to custom groups
   */
  function renderRow(user: User, tabIndex: () => number | undefined) {
    return (
      <div class={rowWrap()}>
        <div class={rowMain()}>
          <FriendRow
            user={user}
            tabIndex={tabIndex()}
            unread={conversationUnread(dmMap().get(user.id))}
            quickActions
            selectOnClick
            onOpen={(u) => props.onOpenConversation(u.id)}
          />
        </div>
        <Show when={!GROUPS_READ_ONLY}>
          <button
            class={`groups ${iconButton()}`}
            aria-label={t`Friend groups…`}
            onClick={() => manageGroups(user.id)}
            use:floating={{
              tooltip: { placement: "left", content: t`Friend groups…` },
            }}
          >
            <Symbol size={18}>label</Symbol>
          </button>
        </Show>
      </div>
    );
  }

  /**
   * Built-in section, collapse state kept in the friends store
   */
  function Section(sectionProps: {
    id: string;
    title: string;
    users: User[];
    hideWhenEmpty?: boolean;
  }) {
    return (
      <Show
        when={!(sectionProps.hideWhenEmpty && sectionProps.users.length === 0)}
      >
        <FriendSection
          key={sectionProps.id}
          title={sectionProps.title}
          users={sectionProps.users}
          collapsed={state.friends.isCollapsed(sectionProps.id)}
          onToggle={() => state.friends.toggleCollapsed(sectionProps.id)}
          renderRow={renderRow}
          scrollTarget={scroller}
        />
      </Show>
    );
  }

  /**
   * Custom group section with its Rename / Delete / Manage groups menu
   */
  function GroupSection(groupProps: { id: string }) {
    const users = createMemo(() => groupMembers(groupProps.id));
    const key = () => groupKey(groupProps.id);

    const menu = () => (
      <ContextMenu>
        <ContextMenuButton
          icon={MdEdit}
          onClick={() => startRename(groupProps.id)}
        >
          <Trans>Rename</Trans>
        </ContextMenuButton>
        <ContextMenuButton
          icon={MdDelete}
          destructive
          onClick={() => {
            setRenameFailed(false);
            setEditing({ id: groupProps.id, mode: "delete" });
          }}
        >
          <Trans>Delete group</Trans>
        </ContextMenuButton>
        <ContextMenuButton icon={MdTune} onClick={() => manageGroups()}>
          <Trans>Manage groups</Trans>
        </ContextMenuButton>
      </ContextMenu>
    );

    return (
      <Switch
        fallback={
          // an empty group stays visible so it can be found and filled, but
          // not while it only means "no match for the search"
          <Show when={!(query().trim() && users().length === 0)}>
            <div
              class={groupWrap()}
              use:floating={{
                contextMenu: GROUPS_READ_ONLY ? undefined : menu,
              }}
            >
              <FriendSection
                key={key()}
                title={groupName(groupProps.id)}
                users={users()}
                collapsed={state.friends.isCollapsed(key())}
                onToggle={() => state.friends.toggleCollapsed(key())}
                renderRow={renderRow}
                scrollTarget={scroller}
              />
              <Show when={!GROUPS_READ_ONLY}>
                <button
                  class={`${iconButton()} ${groupMenuButton()}`}
                  aria-label={t`More options`}
                  use:floating={{
                    contextMenu: menu,
                    contextMenuHandler: "click",
                  }}
                >
                  <Symbol size={18}>more_horiz</Symbol>
                </button>
              </Show>
            </div>
          </Show>
        }
      >
        <Match
          when={editing()?.id === groupProps.id && editing()?.mode === "rename"}
        >
          <div class={editRow()}>
            <div class={editLine()}>
              <input
                class={editInput()}
                ref={(el) => queueMicrotask(() => el.focus())}
                value={editName()}
                maxlength={MAX_FRIEND_GROUP_NAME}
                aria-label={t`Group name`}
                onInput={(event) => setEditName(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    saveRename(groupProps.id);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    stopEditing();
                  }
                }}
              />
              <button
                class={iconButton()}
                aria-label={t`Save`}
                onClick={() => saveRename(groupProps.id)}
              >
                <Symbol size={18}>check</Symbol>
              </button>
              <button
                class={iconButton()}
                aria-label={t`Cancel`}
                onClick={stopEditing}
              >
                <Symbol size={18}>close</Symbol>
              </button>
            </div>
            <Show when={renameFailed()}>
              <span class={errorText()}>
                <Trans>Group names need 1 to 40 characters.</Trans>
              </span>
            </Show>
          </div>
        </Match>
        <Match
          when={editing()?.id === groupProps.id && editing()?.mode === "delete"}
        >
          <div class={editRow()}>
            <span>
              <Trans>
                Delete {groupName(groupProps.id)}? Your friends stay on your
                friends list.
              </Trans>
            </span>
            <div class={confirmActions()}>
              <button class={textButton()} onClick={stopEditing}>
                <Trans>Cancel</Trans>
              </button>
              <button
                class={textButton({ destructive: true })}
                onClick={() => deleteGroup(groupProps.id)}
              >
                <Trans>Delete</Trans>
              </button>
            </div>
          </div>
        </Match>
      </Switch>
    );
  }

  return (
    <div class={base()}>
      <div class={searchRow()}>
        <IconButton
          variant="filled"
          shape="square"
          onPress={() =>
            openModal({
              type: "add_friend",
              client: client(),
            })
          }
          use:floating={{
            tooltip: {
              placement: "bottom",
              content: t`Add a new friend`,
            },
          }}
        >
          <Symbol>person_add</Symbol>
        </IconButton>

        <div class={searchField()}>
          <Symbol size={18}>search</Symbol>
          <input
            value={query()}
            placeholder={t`Search friends...`}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <Show when={query()}>
            <button
              class={clearButton()}
              aria-label={t`Clear search`}
              onClick={() => setQuery("")}
            >
              <Symbol size={18}>close</Symbol>
            </button>
          </Show>
        </div>

        <Show when={!GROUPS_READ_ONLY}>
          <IconButton
            onPress={() => manageGroups()}
            use:floating={{
              tooltip: {
                placement: "bottom",
                content: t`Manage friend groups`,
              },
            }}
          >
            <Symbol>label</Symbol>
          </IconButton>
        </Show>
      </div>

      <div class={scroll()} ref={setScroller} use:scrollable>
        <Section
          id="in_game"
          title={t`In game`}
          users={lists().inGame}
          hideWhenEmpty
        />
        <Section
          id="favourites"
          title={t`Favorites`}
          users={lists().favourites}
          hideWhenEmpty
        />
        <For each={groupIds()}>{(id) => <GroupSection id={id} />}</For>
        {/* Spelled out: the label icon by the search box alone was not
            enough for people to find friend groups */}
        <Show when={!GROUPS_READ_ONLY && !query().trim()}>
          <button class={newGroupButton()} onClick={() => manageGroups()}>
            <Symbol size={18}>add</Symbol>
            <Trans>New friend group</Trans>
          </button>
        </Show>
        <Section
          id="online"
          title={t`Online`}
          users={lists().online}
          hideWhenEmpty={!!query()}
        />
        <Section
          id="offline"
          title={t`Offline`}
          users={lists().offline}
          hideWhenEmpty={!!query()}
        />
      </div>
    </div>
  );
}

const base = cva({
  base: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    height: "100%",
  },
});

const scroll = cva({
  base: {
    flexGrow: 1,
    minHeight: 0,
    paddingInline: "var(--gap-sm)",
    paddingBlockEnd: "var(--gap-lg)",
  },
});

const searchRow = cva({
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    paddingBlock: "var(--gap-sm)",
    paddingInline: "var(--gap-sm)",
  },
});

const searchField = cva({
  base: {
    // fills the row between the two buttons, and shrinks in a narrow window
    flexGrow: 1,
    minWidth: 0,
    height: "40px",
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    paddingInline: "var(--gap-md)",
    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface-variant)",

    "& input": {
      all: "unset",
      flexGrow: 1,
      minWidth: 0,
      fontSize: "14px",
      color: "var(--md-sys-color-on-surface)",
    },
  },
});

const clearButton = cva({
  base: {
    all: "unset",
    display: "flex",
    cursor: "pointer",
    color: "var(--md-sys-color-on-surface-variant)",

    "&:hover": {
      color: "var(--md-sys-color-on-surface)",
    },
  },
});

/**
 * Row plus its Groups… button; the height must match ROW_HEIGHT in
 * FriendRow, which the virtual list positions rows by
 */
const rowWrap = cva({
  base: {
    height: "46px",
    display: "flex",
    alignItems: "center",

    // collapsed rather than display:none so the button stays tabbable
    "& .groups": {
      width: 0,
      overflow: "hidden",
    },

    "&:hover .groups, &:focus-within .groups, & .groups:focus-visible": {
      width: "28px",
      overflow: "visible",
    },
  },
});

const newGroupButton = cva({
  base: {
    all: "unset",
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    marginBlockStart: "var(--gap-sm)",
    paddingInline: "var(--gap-sm)",
    paddingBlock: "var(--gap-xs)",
    borderRadius: "var(--borderRadius-md)",
    cursor: "pointer",
    fontSize: "12px",
    fontWeight: 500,
    color: "var(--md-sys-color-primary)",

    "&:hover": {
      background: "var(--md-sys-color-surface-container-high)",
    },

    "&:focus-visible": {
      outline: "2px solid var(--md-sys-color-primary)",
    },
  },
});

const rowMain = cva({
  base: {
    flexGrow: 1,
    minWidth: 0,
  },
});

const groupWrap = cva({
  base: {
    position: "relative",
  },
});

/**
 * Menu button laid over the right end of the group's section header, which
 * FriendSection draws with a var(--gap-sm) top margin and padding
 */
const groupMenuButton = cva({
  base: {
    position: "absolute",
    top: "calc(var(--gap-sm) * 2 - 5px)",
    right: "var(--gap-sm)",
  },
});

const iconButton = cva({
  base: {
    all: "unset",
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    width: "28px",
    height: "28px",
    borderRadius: "var(--borderRadius-full)",
    cursor: "pointer",
    color: "var(--md-sys-color-on-surface-variant)",

    "&:hover": {
      color: "var(--md-sys-color-on-surface)",
      background: "var(--md-sys-color-surface-container-highest)",
    },

    "&:focus-visible": {
      outline: "2px solid var(--md-sys-color-primary)",
    },
  },
});

const editRow = cva({
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-xs)",
    marginBlockStart: "var(--gap-sm)",
    padding: "var(--gap-sm)",
    borderRadius: "var(--borderRadius-md)",
    background: "var(--md-sys-color-surface-container-high)",
    fontSize: "13px",
    color: "var(--md-sys-color-on-surface)",
  },
});

const editLine = cva({
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-xs)",
  },
});

const editInput = cva({
  base: {
    flexGrow: 1,
    minWidth: 0,
    paddingBlock: "4px",
    paddingInline: "8px",
    borderRadius: "var(--borderRadius-sm)",
    background: "var(--md-sys-color-surface-container-highest)",
    border: "1px solid var(--md-sys-color-outline-variant)",
    color: "var(--md-sys-color-on-surface)",
    fontSize: "13px",

    "&:focus": {
      outline: "none",
      borderColor: "var(--md-sys-color-primary)",
    },
  },
});

const confirmActions = cva({
  base: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "var(--gap-xs)",
  },
});

const textButton = cva({
  base: {
    all: "unset",
    cursor: "pointer",
    paddingBlock: "4px",
    paddingInline: "10px",
    borderRadius: "var(--borderRadius-full)",
    fontSize: "13px",
    fontWeight: 500,
    color: "var(--md-sys-color-primary)",

    "&:hover": {
      background: "var(--md-sys-color-surface-container-highest)",
    },

    "&:focus-visible": {
      outline: "2px solid var(--md-sys-color-primary)",
    },
  },
  variants: {
    destructive: {
      true: {
        color: "var(--md-sys-color-error)",
      },
    },
  },
});

const errorText = cva({
  base: {
    fontSize: "12px",
    color: "var(--md-sys-color-error)",
  },
});
