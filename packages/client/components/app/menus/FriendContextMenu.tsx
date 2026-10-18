import { Show } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import type { User } from "stoat.js";

import { useClient } from "@revolt/client";
import { type PopoutAction, useUserActions } from "@revolt/client/popoutBridge";
import { CONFIGURATION } from "@revolt/common";
import { useModals } from "@revolt/modal";
import { nativeScreenShareAvailable } from "@revolt/rtc";
import { useState } from "@revolt/state";

import MdAccountCircle from "@material-design-icons/svg/outlined/account_circle.svg?component-solid";
import MdBlock from "@material-design-icons/svg/outlined/block.svg?component-solid";
import MdCall from "@material-design-icons/svg/outlined/call.svg?component-solid";
import MdChat from "@material-design-icons/svg/outlined/chat.svg?component-solid";
import MdClose from "@material-design-icons/svg/outlined/close.svg?component-solid";
import MdContentCopy from "@material-design-icons/svg/outlined/content_copy.svg?component-solid";
import MdFolder from "@material-design-icons/svg/outlined/folder.svg?component-solid";
import MdPersonRemove from "@material-design-icons/svg/outlined/person_remove.svg?component-solid";
import MdReport from "@material-design-icons/svg/outlined/report.svg?component-solid";
import MdScreenShare from "@material-design-icons/svg/outlined/screen_share.svg?component-solid";
import MdStar from "@material-design-icons/svg/outlined/star.svg?component-solid";
import MdStarBorder from "@material-design-icons/svg/outlined/star_border.svg?component-solid";
import MdVideocam from "@material-design-icons/svg/outlined/videocam.svg?component-solid";

import {
  ContextMenu,
  ContextMenuButton,
  ContextMenuDivider,
} from "./ContextMenu";

/**
 * Steam-style menu for a friend, in the friends list and the chat windows:
 * message, call and profile on top, then the friend-management actions.
 * Everywhere else (member lists, messages) a friend still gets the full
 * `UserContextMenu`.
 */
export function FriendContextMenu(props: {
  user: User;
  onClose?: () => void;
  /** Opened from a chat-window tab: "Close tab" comes first */
  onCloseTab?: () => void;
  /** Opened inside this friend's own conversation: no "Send Message" */
  inConversation?: boolean;
}) {
  const client = useClient();
  const state = useState();
  const { openModal } = useModals();
  const userActions = useUserActions();

  /**
   * Message or call this friend. `run` raises main itself for a call started
   * from a chat window, and reports its own failures.
   */
  function run(action: PopoutAction) {
    void userActions.run(action, props.user.id);
    props.onClose?.();
  }

  // Same gate as the user context menu's Screen Share entry
  const screenShareSupported = () =>
    (typeof navigator !== "undefined" &&
      typeof navigator.mediaDevices?.getDisplayMedia === "function") ||
    nativeScreenShareAvailable();

  const favourite = () => state.friends.isFavourite(props.user.id);

  return (
    <ContextMenu class="FriendContextMenu">
      <Show when={props.onCloseTab}>
        {(closeTab) => (
          <>
            <ContextMenuButton icon={MdClose} onClick={() => closeTab()()}>
              <Trans>Close tab</Trans>
            </ContextMenuButton>
            <ContextMenuDivider />
          </>
        )}
      </Show>

      <Show when={!props.inConversation}>
        <ContextMenuButton icon={MdChat} onClick={() => run("dm")}>
          <Trans>Send Message</Trans>
        </ContextMenuButton>
      </Show>
      <ContextMenuButton icon={MdCall} onClick={() => run("call")}>
        <Trans>Call</Trans>
      </ContextMenuButton>
      <Show when={CONFIGURATION.ENABLE_VIDEO}>
        <ContextMenuButton icon={MdVideocam} onClick={() => run("video")}>
          <Trans>Video Call</Trans>
        </ContextMenuButton>
        <Show when={screenShareSupported()}>
          <ContextMenuButton
            icon={MdScreenShare}
            onClick={() => run("screenshare")}
          >
            <Trans>Screen Share</Trans>
          </ContextMenuButton>
        </Show>
      </Show>
      <ContextMenuButton
        icon={MdAccountCircle}
        onClick={() => openModal({ type: "user_profile", user: props.user })}
      >
        <Trans>Profile</Trans>
      </ContextMenuButton>

      {/* Steam keeps these under a "Manage" flyout. Here they are a section
          of their own: a hover flyout cannot fit beside its menu in the 300px
          friends window, and one laid over the menu puts Remove and Block
          where other items were a moment before. */}
      <ContextMenuDivider />

      <ContextMenuButton
        icon={favourite() ? MdStar : MdStarBorder}
        onClick={() => state.friends.toggleFavourite(props.user.id)}
      >
        <Show when={favourite()} fallback={<Trans>Add to favorites</Trans>}>
          <Trans>Remove from favorites</Trans>
        </Show>
      </ContextMenuButton>
      <ContextMenuButton
        icon={MdFolder}
        onClick={() =>
          openModal({ type: "friend_groups", userId: props.user.id })
        }
      >
        <Trans>Categorize…</Trans>
      </ContextMenuButton>
      <ContextMenuButton
        icon={MdPersonRemove}
        destructive
        onClick={() => props.user.removeFriend()}
      >
        <Trans>Remove friend</Trans>
      </ContextMenuButton>
      <ContextMenuButton
        icon={MdBlock}
        destructive
        onClick={() => props.user.blockUser()}
      >
        <Trans>Block user</Trans>
      </ContextMenuButton>

      <ContextMenuDivider />

      <ContextMenuButton
        icon={MdReport}
        destructive
        onClick={() =>
          openModal({
            type: "report_content",
            target: props.user,
            client: client(),
          })
        }
      >
        <Trans>Report user</Trans>
      </ContextMenuButton>
      <Show when={state.settings.getValue("advanced:copy_id")}>
        <ContextMenuButton
          icon={MdContentCopy}
          onClick={() => navigator.clipboard.writeText(props.user.id)}
        >
          <Trans>Copy user ID</Trans>
        </ContextMenuButton>
      </Show>
    </ContextMenu>
  );
}
