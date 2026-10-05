import { Show } from "solid-js";

import { ServerMember, User } from "stoat.js";
import { styled } from "styled-system/jsx";

import { UserContextMenu } from "@revolt/app";
import { useUserActions } from "@revolt/client/popoutBridge";
import { CONFIGURATION } from "@revolt/common";
import { useModals } from "@revolt/modal";

import MdCall from "@material-design-icons/svg/filled/call.svg?component-solid";
import MdCancel from "@material-design-icons/svg/filled/cancel.svg?component-solid";
import MdEdit from "@material-design-icons/svg/filled/edit.svg?component-solid";
import MdMoreVert from "@material-design-icons/svg/filled/more_vert.svg?component-solid";
import MdVideocam from "@material-design-icons/svg/filled/videocam.svg?component-solid";

import { Button, IconButton } from "../../design";
import { iconSize } from "../../utils";

/**
 * Actions shown on profile cards
 */
export function ProfileActions(props: {
  width: 2 | 3;

  user: User;
  member?: ServerMember;
  onClose: () => void;
}) {
  const { openModal } = useModals();
  // In the friends popout these forward to the main window instead of
  // navigating (the popout bounces every other route) or starting a call here
  const actions = useUserActions();

  /**
   * Open direct message channel
   */
  function openDm() {
    void actions.run("dm", props.user.id);
    props.onClose();
  }

  /**
   * Start a voice call in the DM channel
   */
  function startVoiceCall() {
    void actions.run("call", props.user.id);
    props.onClose();
  }

  /**
   * Start a call in the DM channel with the camera enabled
   */
  function startVideoCall() {
    void actions.run("video", props.user.id);
    props.onClose();
  }

  /**
   * Whether we can open a DM with this user
   */
  function canDm() {
    return (
      !props.user.self &&
      props.user.relationship !== "Blocked" &&
      props.user.relationship !== "BlockedOther"
    );
  }

  /**
   * Open edit menu
   */
  function openEdit() {
    openModal(
      props.member
        ? { type: "server_identity", member: props.member }
        : { type: "settings", config: "user" },
    );
    if (!props.member) props.onClose();
  }

  return (
    <Actions width={props.width}>
      <Show when={props.user.relationship === "None" && !props.user.bot}>
        <Button onPress={() => props.user.addFriend()}>Add Friend</Button>
      </Show>
      <Show when={props.user.relationship === "Incoming"}>
        <Show when={props.user.relationshipNote}>
          <RequestNote>“{props.user.relationshipNote}”</RequestNote>
        </Show>
        <Button onPress={() => props.user.addFriend()}>
          Accept friend request
        </Button>
        <IconButton onPress={() => props.user.removeFriend()}>
          <MdCancel />
        </IconButton>
      </Show>
      <Show when={props.user.relationship === "Outgoing"}>
        <Button onPress={() => props.user.removeFriend()}>
          Cancel friend request
        </Button>
      </Show>
      <Show when={canDm()}>
        <Button onPress={openDm}>Message</Button>
        <IconButton
          onPress={startVoiceCall}
          use:floating={{
            tooltip: { placement: "top", content: "Voice Call" },
          }}
        >
          <MdCall {...iconSize(16)} />
        </IconButton>
        <Show when={CONFIGURATION.ENABLE_VIDEO}>
          <IconButton
            onPress={startVideoCall}
            use:floating={{
              tooltip: { placement: "top", content: "Video Call" },
            }}
          >
            <MdVideocam {...iconSize(16)} />
          </IconButton>
        </Show>
      </Show>

      <Show
        when={
          props.member
            ? props.user.self
              ? props.member.server!.havePermission("ChangeNickname") ||
                props.member.server!.havePermission("ChangeAvatar")
              : (props.member.server!.havePermission("ManageNicknames") ||
                  props.member.server!.havePermission("RemoveAvatars")) &&
                props.member.inferiorTo(props.member!.server!.member!)
            : props.user.self
        }
      >
        <IconButton onPress={openEdit}>
          <MdEdit {...iconSize(16)} />
        </IconButton>
      </Show>

      <IconButton
        use:floating={{
          contextMenu: () => (
            <UserContextMenu
              user={props.user}
              member={props.member}
              onClose={props.onClose}
            />
          ),
          contextMenuHandler: "click",
        }}
      >
        <MdMoreVert />
      </IconButton>
    </Actions>
  );
}

const Actions = styled("div", {
  base: {
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--gap-md)",
    justifyContent: "flex-end",
  },
  variants: {
    width: {
      3: {
        gridColumn: "1 / 4",
      },
      2: {
        gridColumn: "1 / 3",
      },
    },
  },
});

/** Note attached to the incoming friend request (own row above the buttons) */
const RequestNote = styled("div", {
  base: {
    flexBasis: "100%",
    fontSize: "12px",
    fontStyle: "italic",
    color: "var(--md-sys-color-on-surface-variant)",
    overflowWrap: "anywhere",
  },
});
