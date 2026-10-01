import { For, Match, Show, Switch } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { Channel } from "stoat.js";

import { useDevice } from "@revolt/common";
import { channelNounOf } from "@revolt/common/lib/channelNoun";
import { useModals } from "@revolt/modal";
import { useState } from "@revolt/state";

import MdBadge from "@material-design-icons/svg/outlined/badge.svg?component-solid";
import MdCheck from "@material-design-icons/svg/outlined/check.svg?component-solid";
import MdDelete from "@material-design-icons/svg/outlined/delete.svg?component-solid";
import MdDriveFileMove from "@material-design-icons/svg/outlined/drive_file_move.svg?component-solid";
import MdGroupAdd from "@material-design-icons/svg/outlined/group_add.svg?component-solid";
import MdLibraryAdd from "@material-design-icons/svg/outlined/library_add.svg?component-solid";
import MdLock from "@material-design-icons/svg/outlined/lock.svg?component-solid";
import MdLogout from "@material-design-icons/svg/outlined/logout.svg?component-solid";
import MdMarkChatRead from "@material-design-icons/svg/outlined/mark_chat_read.svg?component-solid";
import MdSettings from "@material-design-icons/svg/outlined/settings.svg?component-solid";
import MdShare from "@material-design-icons/svg/outlined/share.svg?component-solid";
import MdSwapVert from "@material-design-icons/svg/outlined/swap_vert.svg?component-solid";

import { enterReorderMode } from "../../../src/interface/navigation/channels/reorderMode";

import {
  ContextMenu,
  ContextMenuButton,
  ContextMenuDivider,
  ContextMenuSubMenu,
} from "./ContextMenu";
import { NotificationContextMenu } from "./shared/NotificationContextMenu";

/**
 * Context menu for channels
 */
export function ChannelContextMenu(props: { channel: Channel }) {
  const state = useState();
  const { openModal } = useModals();
  const { isMobile } = useDevice();

  /**
   * What this channel goes by in the menu copy: post, thread or channel
   */
  const noun = () => channelNounOf(props.channel);

  /**
   * Whether to offer the server-level channel actions (create, move to
   * category, rearrange). Threads and forum posts are not listed in the
   * server's channel list, so none of these apply to them: a move would be a
   * silent no-op on the server.
   */
  const showServerChannelActions = () =>
    props.channel.server?.havePermission("ManageChannel") &&
    props.channel.type !== "Thread";

  /**
   * Mark channel as read
   */
  function markAsRead() {
    props.channel.ack();
  }

  /**
   * Create a new invite
   */
  function createInvite() {
    openModal({
      type: "create_invite",
      channel: props.channel,
    });
  }

  /**
   * Create a new channel
   */
  function createChannel() {
    openModal({
      type: "create_channel",
      server: props.channel.server!,
    });
  }

  /**
   * Edit channel
   */
  function editChannel() {
    openModal({
      type: "settings",
      config: "channel",
      context: props.channel,
    });
  }

  /**
   * Open channel settings to the password section
   */
  function setPassword() {
    openModal({
      type: "settings",
      config: "channel",
      context: props.channel,
    });
  }

  /**
   * Delete channel
   */
  function deleteChannel() {
    openModal({
      type: "delete_channel",
      channel: props.channel,
    });
  }

  /**
   * The category this channel currently sits in, if any.
   *
   * `orderedChannels` synthesises a "default" category for channels that are
   * not listed anywhere, so an undefined result here means uncategorised.
   */
  function currentCategoryId() {
    return props.channel.server?.categories?.find((category) =>
      category.channels.includes(props.channel.id),
    )?.id;
  }

  /**
   * Move this channel into another category, or out of all of them.
   *
   * The server stores categories as a list, each holding an ordered list of
   * channel ids, so a move is: drop the id everywhere, then append it to the
   * target. Passing no target is how a channel leaves a category altogether --
   * anything listed in no category is what the sidebar shows as "Default".
   */
  function moveToCategory(categoryId?: string) {
    const server = props.channel.server;
    if (!server) return;

    const categories = (server.categories ?? []).map((category) => ({
      ...category,
      channels: category.channels.filter((id) => id !== props.channel.id),
    }));

    if (categoryId) {
      const target = categories.find((category) => category.id === categoryId);
      if (!target) return;
      target.channels = [...target.channels, props.channel.id];
    }

    server.edit({ categories });
  }

  /**
   * Put this channel's server sidebar into channel-reorder mode.
   *
   * The mode is keyed by server id, so it is only reachable from a channel
   * that actually sits in a server -- this menu is also used for DMs, groups
   * and Saved Notes, where `server` is undefined and there is nothing to
   * rearrange.
   *
   * Nothing here closes the menu: `FloatingManager` registers a bubble-phase
   * `document` click listener that hides whatever context menu is shown
   * (`components/ui/components/floating/FloatingManager.tsx:157-161`), so a
   * plain `onClick` dismisses it for free.
   */
  function rearrangeChannels() {
    const serverId = props.channel.server?.id;
    if (!serverId) return;

    enterReorderMode(serverId);
  }

  /**
   * Copy channel link to clipboard
   */
  function copyLink() {
    navigator.clipboard.writeText(
      `${location.origin}${
        props.channel.server ? `/server/${props.channel.server?.id}` : ""
      }/channel/${props.channel.id}`,
    );
  }

  /**
   * Copy channel id to clipboard
   */
  function copyId() {
    navigator.clipboard.writeText(props.channel.id);
  }

  return (
    <ContextMenu>
      <Show
        when={
          props.channel.unread || props.channel.havePermission("InviteOthers")
        }
      >
        <Show when={props.channel.unread}>
          <ContextMenuButton icon={MdMarkChatRead} onClick={markAsRead}>
            <Trans>Mark as read</Trans>
          </ContextMenuButton>
        </Show>
        <Show when={props.channel.havePermission("InviteOthers")}>
          <ContextMenuButton icon={MdGroupAdd} onClick={createInvite}>
            <Trans>Create invite</Trans>
          </ContextMenuButton>
        </Show>
        <ContextMenuDivider />
      </Show>

      <NotificationContextMenu channel={props.channel} />

      <ContextMenuDivider />

      <Show when={showServerChannelActions()}>
        <ContextMenuButton icon={MdLibraryAdd} onClick={createChannel}>
          <Trans>Create channel</Trans>
        </ContextMenuButton>
        <Show when={props.channel.server?.categories?.length}>
          <ContextMenuSubMenu
            icon={MdDriveFileMove}
            buttonContent={<Trans>Move to category</Trans>}
          >
            <For each={props.channel.server!.categories!}>
              {(category) => (
                <ContextMenuButton
                  onClick={() => moveToCategory(category.id)}
                  actionIcon={
                    currentCategoryId() === category.id ? MdCheck : undefined
                  }
                >
                  {category.title}
                </ContextMenuButton>
              )}
            </For>
            <ContextMenuDivider />
            <ContextMenuButton
              onClick={() => moveToCategory()}
              actionIcon={currentCategoryId() ? undefined : MdCheck}
            >
              <Trans>No category</Trans>
            </ContextMenuButton>
          </ContextMenuSubMenu>
        </Show>
        {/* Desktop already reorders by dragging in the sidebar itself, so the
            explicit mode is mobile-only. `isMobile` is a readonly field frozen
            at Device construction, not a signal, so this never re-evaluates --
            which is how the rest of the codebase gates on it too. */}
        <Show when={isMobile}>
          <ContextMenuButton icon={MdSwapVert} onClick={rearrangeChannels}>
            <Trans>Rearrange channels</Trans>
          </ContextMenuButton>
        </Show>
      </Show>
      <Show when={props.channel.havePermission("ManageChannel")}>
        <ContextMenuButton icon={MdSettings} onClick={editChannel}>
          <Switch fallback={<Trans>Open channel settings</Trans>}>
            <Match when={noun() === "post"}>
              <Trans>Open post settings</Trans>
            </Match>
            <Match when={noun() === "thread"}>
              <Trans>Open thread settings</Trans>
            </Match>
          </Switch>
        </ContextMenuButton>
        <Show when={props.channel.type === "TextChannel"}>
          <ContextMenuButton icon={MdLock} onClick={setPassword}>
            <Trans>Set channel password</Trans>
          </ContextMenuButton>
        </Show>
        <ContextMenuButton
          icon={props.channel.type === "Group" ? MdLogout : MdDelete}
          onClick={deleteChannel}
          destructive
        >
          <Switch fallback={<Trans>Delete channel</Trans>}>
            <Match when={props.channel.type === "Group"}>
              <Trans>Leave group</Trans>
            </Match>
            <Match when={noun() === "post"}>
              <Trans>Delete post</Trans>
            </Match>
            <Match when={noun() === "thread"}>
              <Trans>Delete thread</Trans>
            </Match>
          </Switch>
        </ContextMenuButton>
      </Show>

      {/* Closes the action section above, so it must only render when that
          section rendered something; otherwise it would sit directly under
          the divider after the notification menu. */}
      <Show
        when={
          showServerChannelActions() ||
          props.channel.havePermission("ManageChannel")
        }
      >
        <ContextMenuDivider />
      </Show>

      <ContextMenuButton icon={MdShare} onClick={copyLink}>
        <Trans>Copy link</Trans>
      </ContextMenuButton>
      <Show when={state.settings.getValue("advanced:copy_id")}>
        <ContextMenuButton icon={MdBadge} onClick={copyId}>
          <Switch fallback={<Trans>Copy channel ID</Trans>}>
            <Match when={noun() === "post"}>
              <Trans>Copy post ID</Trans>
            </Match>
            <Match when={noun() === "thread"}>
              <Trans>Copy thread ID</Trans>
            </Match>
          </Switch>
        </ContextMenuButton>
      </Show>
    </ContextMenu>
  );
}
