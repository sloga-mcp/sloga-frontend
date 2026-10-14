import { For, Show } from "solid-js";

import { Plural, useLingui } from "@lingui-solid/solid/macro";
import type { Channel } from "stoat.js";
import { cva } from "styled-system/css";

import { ChannelContextMenu } from "@revolt/app";
import { useClient } from "@revolt/client";
import { TextWithEmoji } from "@revolt/markdown";
import { useModals } from "@revolt/modal";
import { useState } from "@revolt/state";
import { Avatar, OverflowingText, Unreads } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { conversationUnread, groupDms } from "./friendData";

/**
 * Key of the dock in the friends store's `collapsed` list; shares the list
 * with the friends sections, so it is prefixed to stay clear of their keys
 */
const COLLAPSE_KEY = "dock:groups";

/**
 * Collapsible list of group chats that docks under the friends list. The
 * caller decides where a conversation opens (main window or chat window).
 */
export function GroupChatsDock(props: { onOpen(channelId: string): void }) {
  const { t } = useLingui();
  const client = useClient();
  const state = useState();
  const { openModal } = useModals();

  const groups = groupDms(client);
  const collapsed = () => state.friends.isCollapsed(COLLAPSE_KEY);

  return (
    <section class={dock()} aria-label={t`Group chats`}>
      <div class={header()}>
        <button
          class={toggle()}
          aria-expanded={!collapsed()}
          onClick={() => state.friends.toggleCollapsed(COLLAPSE_KEY)}
        >
          <Symbol size={18}>
            {collapsed() ? "chevron_right" : "expand_more"}
          </Symbol>
          <span>
            {t`Group chats`} ({groups().length})
          </span>
        </button>
        <button
          class={iconButton()}
          aria-label={t`Create a new group`}
          onClick={() => openModal({ type: "create_group", client: client() })}
          use:floating={{
            tooltip: { placement: "top", content: t`Create a new group` },
          }}
        >
          <Symbol size={18}>add</Symbol>
        </button>
      </div>

      <Show when={!collapsed()}>
        <div class={list()} role="list">
          <Show
            when={groups().length}
            fallback={<div class={emptyRow()}>{t`No group chats yet`}</div>}
          >
            <For each={groups()}>
              {(channel) => (
                <GroupRow channel={channel} onOpen={props.onOpen} />
              )}
            </For>
          </Show>
        </div>
      </Show>
    </section>
  );
}

/**
 * Single group chat; drawn the way the home sidebar draws groups
 */
function GroupRow(props: {
  channel: Channel;
  onOpen(channelId: string): void;
}) {
  const { t } = useLingui();

  const open = () => props.onOpen(props.channel.id);

  return (
    <div
      class={row({ dim: props.channel.muted })}
      role="listitem"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        open();
      }}
      use:floating={{
        contextMenu: () => <ChannelContextMenu channel={props.channel} />,
      }}
    >
      <Avatar
        size={28}
        shape="rounded-square"
        fallback={props.channel.name}
        src={props.channel.iconURL}
        primaryContrast
      />

      <div class={nameStack()}>
        <OverflowingText class={`name ${name()}`}>
          <TextWithEmoji content={props.channel.name ?? ""} />
        </OverflowingText>
        <span class={memberCount()}>
          <Plural
            value={props.channel.recipientIds.size}
            one="# member"
            other="# members"
          />
        </span>
      </div>

      <Show when={conversationUnread(props.channel)}>
        {(unread) => (
          <span
            class={unreadPill()}
            role="img"
            aria-label={
              unread().mention ? t`Unread mentions` : t`Unread messages`
            }
          >
            <Unreads
              count={unread().count}
              unread
              tone={unread().mention ? "mention" : "unread"}
              size={unread().count > 0 ? "16px" : "10px"}
            />
          </span>
        )}
      </Show>
    </div>
  );
}

const dock = cva({
  base: {
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    minHeight: 0,
    borderTop: "1px solid var(--md-sys-color-outline-variant)",
  },
});

const header = cva({
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    paddingInline: "var(--gap-sm)",
    paddingBlock: "var(--gap-sm)",
  },
});

const toggle = cva({
  base: {
    all: "unset",
    flexGrow: 1,
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    cursor: "pointer",
    userSelect: "none",
    fontSize: "12px",
    fontWeight: 500,
    color: "var(--md-sys-color-on-surface-variant)",

    "&:hover": {
      color: "var(--md-sys-color-on-surface)",
    },

    "&:focus-visible": {
      outline: "2px solid var(--md-sys-color-primary)",
    },
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

/**
 * Capped so the dock stays docked under the friends list; past the cap the
 * groups scroll inside it
 */
const list = cva({
  base: {
    maxHeight: "240px",
    overflowY: "auto",
    paddingInline: "var(--gap-sm)",
    paddingBlockEnd: "var(--gap-sm)",
  },
});

const row = cva({
  base: {
    height: "46px",
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-md)",
    paddingInline: "var(--gap-sm)",
    borderRadius: "var(--borderRadius-md)",
    cursor: "pointer",
    userSelect: "none",

    "&:hover": {
      background: "var(--md-sys-color-surface-container-high)",
    },

    "&:focus-visible": {
      outline: "2px solid var(--md-sys-color-primary)",
    },
  },
  variants: {
    dim: {
      true: {
        "& .name": {
          color: "var(--md-sys-color-on-surface-variant)",
        },
      },
    },
  },
});

const nameStack = cva({
  base: {
    minWidth: 0,
    flexGrow: 1,
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
  },
});

const name = cva({
  base: {
    fontSize: "14px",
    color: "var(--md-sys-color-on-surface)",
  },
});

const memberCount = cva({
  base: {
    fontSize: "12px",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const unreadPill = cva({
  base: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
  },
});

const emptyRow = cva({
  base: {
    paddingInline: "var(--gap-sm)",
    paddingBlock: "var(--gap-sm)",
    fontSize: "13px",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});
