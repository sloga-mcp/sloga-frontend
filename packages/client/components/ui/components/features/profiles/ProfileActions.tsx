import { Show } from "solid-js";

import { useNavigate } from "@solidjs/router";
import { ServerMember, User } from "stoat.js";
import { styled } from "styled-system/jsx";

import { UserContextMenu } from "@revolt/app";
import { CONFIGURATION } from "@revolt/common";
import { useModals } from "@revolt/modal";
import { useVoice } from "@revolt/rtc";

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
  const navigate = useNavigate();
  const { openModal } = useModals();
  const voice = useVoice();

  /**
   * Open direct message channel
   */
  function openDm() {
    props.user.openDM().then((channel) => navigate(channel.path)).catch(console.error);
    props.onClose();
  }

  /**
   * Start a voice call in the DM channel
   */
  function startVoiceCall() {
    props.user.openDM().then((channel) => {
      navigate(channel.path);
      return voice.connect(channel);
    }).catch(console.error);
    props.onClose();
  }

  /**
   * Start a call in the DM channel with the camera enabled
   */
  function startVideoCall() {
    props.user.openDM().then(async (channel) => {
      navigate(channel.path);
      await voice.connect(channel);
      await voice.toggleCamera();
    }).catch(console.error);
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
        <IconButton onPress={startVoiceCall} use:floating={{ tooltip: { placement: "top", content: "Voice Call" } }}>
          <MdCall {...iconSize(16)} />
        </IconButton>
        <Show when={CONFIGURATION.ENABLE_VIDEO}>
          <IconButton onPress={startVideoCall} use:floating={{ tooltip: { placement: "top", content: "Video Call" } }}>
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
