import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { useNavigate } from "@solidjs/router";
import { Track } from "livekit-client";
import { type JSX, For, Match, Show, Switch } from "solid-js";
import type { Channel, Message, ServerMember, User } from "stoat.js";

import { useClient } from "@revolt/client";
import { CONFIGURATION } from "@revolt/common";
import { useModals } from "@revolt/modal";
import { useSmartParams } from "@revolt/routing";
import {
  callModerationActions,
  canOfferMove,
  hasCallModerationActions,
  nativeScreenShareAvailable,
  useVoice,
} from "@revolt/rtc";
import {
  type MoveRefusalKind,
  moveRefusalKind,
  moveTargets,
} from "@revolt/rtc/voiceMovePolicy";
import { useState } from "@revolt/state";
import { LAYOUT_SECTIONS } from "@revolt/state/stores/Layout";
import { Slider, Text, useSnackbar } from "@revolt/ui";

import MdAccountCircle from "@material-design-icons/svg/outlined/account_circle.svg?component-solid";
import MdAddCircleOutline from "@material-design-icons/svg/outlined/add_circle_outline.svg?component-solid";
import MdAdminPanelSettings from "@material-design-icons/svg/outlined/admin_panel_settings.svg?component-solid";
import MdAlternateEmail from "@material-design-icons/svg/outlined/alternate_email.svg?component-solid";
import MdAssignmentInd from "@material-design-icons/svg/outlined/assignment_ind.svg?component-solid";
import MdBadge from "@material-design-icons/svg/outlined/badge.svg?component-solid";
import MdBlock from "@material-design-icons/svg/outlined/block.svg?component-solid";
import MdCall from "@material-design-icons/svg/outlined/call.svg?component-solid";
import MdCallEnd from "@material-design-icons/svg/outlined/call_end.svg?component-solid";
import MdCancel from "@material-design-icons/svg/outlined/cancel.svg?component-solid";
import MdChat from "@material-design-icons/svg/outlined/chat.svg?component-solid";
import MdClose from "@material-design-icons/svg/outlined/close.svg?component-solid";
import MdDoNotDisturbOn from "@material-design-icons/svg/outlined/do_not_disturb_on.svg?component-solid";
import MdDraw from "@material-design-icons/svg/outlined/draw.svg?component-solid";
import MdFace from "@material-design-icons/svg/outlined/face.svg?component-solid";
import MdHeadphones from "@material-design-icons/svg/outlined/headphones.svg?component-solid";
import MdHeadsetOff from "@material-design-icons/svg/outlined/headset_off.svg?component-solid";
import MdHearing from "@material-design-icons/svg/outlined/hearing.svg?component-solid";
import MdMicOff from "@material-design-icons/svg/outlined/mic_off.svg?component-solid";
import MdMoveDown from "@material-design-icons/svg/outlined/move_down.svg?component-solid";
import MdPersonAddAlt from "@material-design-icons/svg/outlined/person_add_alt.svg?component-solid";
import MdPersonRemove from "@material-design-icons/svg/outlined/person_remove.svg?component-solid";
import MdReport from "@material-design-icons/svg/outlined/report.svg?component-solid";
import MdScreenShare from "@material-design-icons/svg/outlined/screen_share.svg?component-solid";
import MdVideocam from "@material-design-icons/svg/outlined/videocam.svg?component-solid";
import MdVisibility from "@material-design-icons/svg/outlined/visibility.svg?component-solid";
import MdVisibilityOff from "@material-design-icons/svg/outlined/visibility_off.svg?component-solid";
import MdVoiceOverOff from "@material-design-icons/svg/outlined/voice_over_off.svg?component-solid";
import MdChecked from "@material-symbols/svg-400/outlined/check_box.svg?component-solid";
import MdUnchecked from "@material-symbols/svg-400/outlined/check_box_outline_blank.svg?component-solid";

import { isChannelGatedForMember } from "../../../src/interface/channels/memberGate";
import {
  ContextMenu,
  ContextMenuButton,
  ContextMenuDivider,
  ContextMenuSubMenu,
} from "./ContextMenu";
import { NotificationContextMenu } from "./shared/NotificationContextMenu";

/**
 * Context menu for users
 */
export function UserContextMenu(props: {
  user: User;
  onClose?: () => void;
  channel?: Channel;
  member?: ServerMember;
  contextMessage?: Message;
  inVoice?: boolean;
  isScreenshare?: boolean;
  /**
   * The voice channel this participant row belongs to, when the menu is
   * opened from a call surface that knows it (the sidebar's voice channel
   * preview). Lets a moderator who is NOT in that call act on someone who
   * is. Falls back to the call we are in.
   */
  voiceChannel?: Channel;
}) {
  // TODO: if we take serverId instead, we could dynamically fetch server member here
  // same for the floating menu I guess?
  const state = useState();
  const client = useClient();
  const navigate = useNavigate();
  const { openModal, modals } = useModals();
  const voice = useVoice();
  const snackbar = useSnackbar();
  const { t } = useLingui();

  // server context
  const params = useSmartParams();

  /**
   * Surface an openDM failure — otherwise a denied DM reads as a dead button
   */
  function dmFailed(err: unknown) {
    console.error(err);
    snackbar.show({ message: "Couldn't open a conversation with this user." });
  }

  /**
   * Enter the DM channel; on phones the navigation happens in the content
   * pane, which may be slid off-screen behind the sidebar
   */
  function enterDm(channel: { path: string }) {
    navigate(channel.path);
    state.appDrawer()?.setShown(true);
  }

  /**
   * Open direct message channel
   */
  function openDm() {
    props.user.openDM().then(enterDm).catch(dmFailed);
    props.onClose?.();
  }

  /**
   * Start a voice call in the DM channel
   */
  function startVoiceCall() {
    props.user
      .openDM()
      .then((channel) => {
        enterDm(channel);
        return voice.connect(channel);
      })
      .catch(dmFailed);
    props.onClose?.();
  }

  /**
   * Start a call in the DM channel with the camera enabled
   */
  function startVideoCall() {
    props.user
      .openDM()
      .then(async (channel) => {
        enterDm(channel);
        if (await voice.connect(channel)) await voice.toggleCamera();
      })
      .catch(dmFailed);
    props.onClose?.();
  }

  /**
   * Start a call in the DM channel and immediately share the screen
   */
  function startScreenShareCall() {
    props.user
      .openDM()
      .then(async (channel) => {
        enterDm(channel);
        if (await voice.connect(channel)) await voice.toggleScreenshare();
      })
      .catch(dmFailed);
    props.onClose?.();
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

  // Screen sharing goes through getDisplayMedia on web/desktop, or the
  // native MediaProjection screen leg on the Android shell (screen-leg plan
  // §7.1). nativeScreenShareAvailable() is synchronous and constant for the
  // session. This stays a function anyway: it is cheap, and it stays correct
  // if either input ever becomes reactive.
  const screenShareSupported = () =>
    (typeof navigator !== "undefined" &&
      typeof navigator.mediaDevices?.getDisplayMedia === "function") ||
    nativeScreenShareAvailable();

  /**
   * Delete channel
   */
  function closeDm() {
    openModal({
      type: "delete_channel",
      channel: props.channel!,
    });
  }

  /**
   * Whether the user's profile modal is already open
   */
  function isProfileOpen() {
    return !!modals.find(
      (m) =>
        m.props.type === "user_profile" &&
        m.props.user.id === props.user.id &&
        m.show,
    );
  }

  /**
   * Open user profile
   */
  function openProfile() {
    openModal({
      type: "user_profile",
      user: props.user,
    });
  }

  /**
   * Mention the user
   */
  function mention() {
    if (!state.draft._setNodeReplacement) return;
    state.draft._setNodeReplacement([props.user.toString()]);
  }

  /**
   * Edit server identity for user
   */
  function editIdentity() {
    openModal({
      type: "server_identity",
      member: props.member!,
    });
  }

  /**
   * Report the user
   */
  function reportUser() {
    openModal({
      type: "report_content",
      target: props.user!,
      client: client(),
      contextMessage: props.contextMessage,
    });
  }

  /**
   * Edit this user's roles
   */
  function editRoles() {
    openModal({
      type: "user_profile_roles",
      member: props.member!,
    });
  }

  /**
   * Kick the member
   */
  function kickMember() {
    openModal({
      type: "kick_member",
      member: props.member!,
    });
  }

  /**
   * Ban the member
   */
  function banMember() {
    openModal({
      type: "ban_member",
      member: props.member!,
    });
  }

  /**
   * Ban the user
   */
  function banUser() {
    openModal({
      type: "ban_non_member",
      user: props.user!,
      server: client().servers.get(params().serverId!)!,
    });
  }

  /**
   * Suspend the user from the platform (privileged only)
   */
  function suspendUser() {
    openModal({
      type: "suspend_user",
      user: props.user,
      client: client(),
    });
  }

  /**
   * Lift the user's platform suspension (privileged only)
   */
  function unsuspendUser() {
    client()
      .api.delete(`/safety/users/${props.user.id}/suspend` as never)
      .catch(console.error);
  }

  /**
   * Whether the current account can platform-suspend this user
   */
  function canSuspend() {
    return (
      client().user?.privileged &&
      !props.user.self &&
      !props.user.privileged &&
      !props.user.bot
    );
  }

  /**
   * Whether this user is currently suspended (UserFlags::SuspendedUntil)
   */
  function isSuspended() {
    return (props.user.flags & 1) === 1;
  }

  /**
   * Add friend (used for ACCEPTING an incoming request — instant, no dialog)
   */
  function addFriend() {
    props.user.addFriend();
  }

  /**
   * Send a new friend request through the dialog, so a note can be attached
   */
  function sendFriendRequest() {
    openModal({
      type: "add_friend",
      client: client(),
      user: props.user,
    });
  }

  /**
   * Remove friend
   */
  function removeFriend() {
    props.user.removeFriend();
  }

  /**
   * Block user
   */
  function blockUser() {
    props.user.blockUser();
  }

  /**
   * Unblock user
   */
  function unblockUser() {
    props.user.unblockUser();
  }

  /**
   * Copy user id to clipboard
   */
  function copyId() {
    navigator.clipboard.writeText(props.user.id);
  }

  /**
   * Remove user from group
   */
  function removeMember() {
    openModal({
      type: "remove_member",
      user: props.user,
      group: props.channel!,
    });
  }

  /**
   * Whether the user can edit identity on this server
   */
  function canEditIdentity() {
    return (
      props.member &&
      (props.user.self
        ? props.member!.server!.havePermission("ChangeNickname") ||
          props.member!.server!.havePermission("ChangeAvatar")
        : (props.member!.server!.havePermission("ManageNicknames") ||
            props.member!.server!.havePermission("RemoveAvatars")) &&
          props.member!.inferiorTo(props.member!.server!.member!))
    );
  }

  /**
   * Whether the user can edit roles for this member
   */
  function canEditRoles() {
    return (
      props.member &&
      (props.member?.server?.owner?.self ||
        (props.member?.server?.havePermission("AssignRoles") &&
          props.member.inferiorTo(props.member.server.member!)))
    );
  }

  /**
   * Whether the user can kick this member
   */
  function canKick() {
    return (
      !props.user.self &&
      props.member?.server?.havePermission("KickMembers") &&
      props.member.inferiorTo(props.member.server.member!)
    );
  }

  /**
   * Whether the user can ban this member
   */
  function canBan() {
    return (
      !props.user.self &&
      props.member?.server?.havePermission("BanMembers") &&
      props.member.inferiorTo(props.member.server.member!)
    );
  }

  /**
   * Whether the user can ban a non-member in the current server
   */
  function canBanNonMember() {
    return (
      !props.user.self &&
      props.member?.server?.havePermission("BanMembers") &&
      params().serverId &&
      !props.member
    );
  }

  /**
   * The ONE call channel every call entry in this menu is about: the row's
   * own voice channel when the caller supplied it (a sidebar participant row,
   * possibly of a call we are not in), otherwise the call we are in.
   */
  const callChannel = () => props.voiceChannel ?? voice.channel();

  /**
   * Whether this device is connected to that call channel right now.
   */
  function inThisCall() {
    const current = voice.channel();
    return !!current && callChannel()?.id === current.id;
  }

  /**
   * Whether the menu was opened from a call surface: a participant tile, or
   * a participant row in the sidebar. Everywhere else (message authors, the
   * member list, friends) keeps its old behavior of offering no call
   * entries: the call we happen to be in may belong to a different server
   * than the one the menu was opened in.
   */
  const fromCallSurface = () => !!props.inVoice || !!props.voiceChannel;

  /**
   * The target as a member of the CALL's server.
   *
   * Deliberately NOT `props.member`, which `useUser` resolves through the
   * current ROUTE: a moderator who navigates to another server, or to home,
   * while staying in the call would watch these entries disappear. The call's
   * own channel is the server the API will be asked about, so it is the one
   * the menu must ask about too. Undefined for a DM or group call.
   */
  function callMember() {
    const serverId = callChannel()?.serverId;
    if (!serverId) return undefined;

    const id = { server: serverId, user: props.user.id };
    const member = client().serverMembers.getByKey(id);

    // `getByKey` is a cache read that never fetches, and nothing in the voice
    // path fills that cache — only the member sidebar and the server-event
    // worker do. Joining a call without ever opening a text channel therefore
    // leaves every participant uncached. Ask for the one member we need; the
    // fetch short-circuits on a real hit, and the menu re-renders when it
    // lands because the collection is reactive.
    if (!member || client().serverMembers.isPartialByKey(id)) {
      void client()
        .serverMembers.fetch(serverId, props.user.id)
        .catch(() => {
          /* a member we cannot read is one we cannot moderate; stay quiet */
        });
    }

    return member;
  }

  /**
   * The subject and the acting user's permissions for the call policy, both
   * resolved against the call channel's server. `server` is undefined for a
   * DM or group call, and then so are the permissions: nothing is offered.
   */
  function callModerationInput() {
    const channel = callChannel();
    const serverId = channel?.serverId;
    // Resolve the server DIRECTLY, not through the target member: deriving it
    // from an uncached target collapsed the whole menu to the same "no server
    // here" branch a DM takes, so the entries silently vanished instead of
    // waiting for the member to load.
    const server = serverId ? client().servers.get(serverId) : undefined;
    const member = callMember();
    const actor = server?.member;

    // A member the collection only knows as a partial has no real roles yet,
    // so `ranking` reads as the lowest possible and EVERYONE looks inferior.
    // Treat that as unresolved rather than as "safe to moderate".
    const resolved =
      !!member &&
      !!serverId &&
      !client().serverMembers.isPartialByKey({
        server: serverId,
        user: props.user.id,
      });

    return {
      server,
      subject: {
        isSelf: props.user.self,
        // The server refuses to move a bot (`IsBot`), itself included.
        isBot: !!props.user.bot,
        isConnected: !!channel?.voiceParticipants.has(props.user.id),
        // No actor means we could not resolve our own membership; treat that
        // as "not established", never as elevated.
        isInferiorToActor: resolved && !!actor && member!.inferiorTo(actor),
      },
      permissions:
        server && channel
          ? {
              // Mute and deafen are resolved at SERVER level by the API.
              muteMembers: server.havePermission("MuteMembers"),
              deafenMembers: server.havePermission("DeafenMembers"),
              // Disconnect and move are resolved at CHANNEL level, on the
              // voice channel the target is in (the call channel).
              moveMembersInSource: channel.havePermission("MoveMembers"),
            }
          : undefined,
    };
  }

  /**
   * Which server-moderation entries this call menu may offer.
   */
  function moderation() {
    const { subject, permissions } = callModerationInput();
    return callModerationActions(subject, permissions);
  }

  /**
   * The voice channels "Move to…" offers, in sidebar order. Empty unless the
   * policy lets us move this person at all (MoveMembers in the SOURCE and
   * outranking them, or it is us); `moveTargets` then checks only the
   * destination.
   *
   * Moving OURSELVES is offered only from the device that is in that call:
   * a device-bound call can only be moved from that device's own session, so
   * from any other session the API refuses it.
   *
   * Moving OURSELVES also leaves out every channel whose age, password or
   * spoiler check we have not passed on this device. The voice client
   * refuses to follow a move into such a channel and leaves the call, so
   * offering one would only drop us. Moving someone else is not filtered:
   * their unlocks live on their own device, not in our layout.
   */
  function moveTargetChannels() {
    const channel = callChannel();
    const { server, subject, permissions } = callModerationInput();
    if (!channel || !server) return [];
    if (!canOfferMove(subject, permissions)) return [];
    if (props.user.self && !inThisCall()) return [];
    if (!callMember()) return [];

    const channels = server.orderedChannels.flatMap(
      (category) => category.channels,
    );

    return moveTargets(
      props.user.self
        ? channels.filter(
            (c) =>
              !isChannelGatedForMember(
                c,
                (k) => state.layout.getSectionState(k, false),
                LAYOUT_SECTIONS.MATURE,
              ),
          )
        : channels,
      {
        currentChannelId: channel.id,
        isSelf: props.user.self,
        isVoice: (c) => c.isVoice && c.serverId === server.id,
        canConnect: (c) => c.havePermission("Connect"),
        canMoveMembers: (c) => c.havePermission("MoveMembers"),
      },
    );
  }

  /**
   * Whether the call-moderation section has anything to show: it is only
   * ever offered from a call surface, for a call channel on a server.
   */
  function callModerationShown() {
    if (!fromCallSurface() || !callChannel()?.serverId) return false;
    return (
      hasCallModerationActions(moderation()) || moveTargetChannels().length > 0
    );
  }

  /**
   * Surface a refused moderation action instead of letting it fail silently
   */
  function moderationFailed(err: unknown) {
    console.error(err);
    snackbar.show({
      message: t`That didn't go through. They may have left, or you may not have permission.`,
    });
  }

  /**
   * What to say when moving SOMEONE ELSE was refused, by the kind of
   * refusal. Every kind is listed, so a new one fails to compile here until
   * it is given its words.
   */
  function otherMoveRefusal(kind: MoveRefusalKind): string {
    switch (kind) {
      case "target-cannot-view":
        return t`They can't see that channel, so they can't be moved there.`;
      case "is-bot":
        return t`Bots can't be moved between voice channels.`;
      case "cannot-join":
        return t`They can't join that call right now. It may be full, or they may not be able to connect to it.`;
      case "not-connected":
        return t`They're not in a voice call you can move them from.`;
      case "server-error":
        return t`Something went wrong on our end. Try again in a moment.`;
      case "not-authenticated":
      case "other":
        return t`Couldn't move them. They may have left the call, or you may not have permission.`;
    }
  }

  /**
   * What to say when moving OURSELVES was refused, by the kind of refusal.
   * Every kind is listed, as above.
   */
  function selfMoveRefusal(kind: MoveRefusalKind): string {
    switch (kind) {
      case "cannot-join":
        return t`You can't join that call right now. It may be full, or you may not be able to connect to it.`;
      case "not-connected":
        return t`You're not in a voice call you can move from.`;
      case "not-authenticated":
        return t`You can only move yourself from the device that's in the call.`;
      case "server-error":
        return t`Something went wrong on our end. Try again in a moment.`;
      case "target-cannot-view":
      case "is-bot":
      case "other":
        return t`Couldn't move you to that channel.`;
    }
  }

  /**
   * Surface a refused move in the words its kind calls for. A
   * `NotAuthenticated` refusal (HTTP 401) only means a self-move was asked
   * for from a session other than the one in the call: like every refusal
   * here it shows a message and nothing else, and never signs anyone out.
   *
   * Logs the kind alone, never the error itself, so nothing the error
   * carries reaches the console.
   */
  function moveFailed(err: unknown, self: boolean) {
    const kind = moveRefusalKind(err);
    console.error("Voice move refused:", kind);
    snackbar.show({
      message: self ? selfMoveRefusal(kind) : otherMoveRefusal(kind),
    });
  }

  /**
   * Move this member (or ourselves) to another voice channel of the call's
   * server. The server re-checks every permission and the rank.
   */
  function moveToChannel(channelId: string) {
    const self = props.user.self;
    const member = callMember();
    if (!member) return;

    member
      .moveToVoiceChannel(channelId)
      .catch((err: unknown) => moveFailed(err, self));
    props.onClose?.();
  }

  /**
   * The REMOTE share identities of this user the menu offers Watch / Listen
   * for: only while we are in that same call, and never on the screen-share
   * tile's menu, whose tile already carries the Watch / Stop watching control
   * for its own share. For our own user this is only our OTHER devices.
   */
  function watchIdentities(): string[] {
    if (!props.inVoice || props.isScreenshare || !inThisCall()) return [];
    return voice.shareIdentitiesOf(props.user.id);
  }

  /**
   * Whether this share publishes screen AUDIO without screen VIDEO (plan
   * decision A, "Audio-only shares"). It has no tile, so the menu is the
   * only place to Listen. Read-only against the Room; its participant and
   * publication maps are not signals, so the read is tied to
   * `callParticipantsVersion()` the same way `shareIdentitiesOf` is.
   */
  function isAudioOnlyShare(identity: string) {
    void voice.callParticipantsVersion();
    const participant = voice.room()?.remoteParticipants.get(identity);
    if (!participant) return false;

    let video = false;
    let audio = false;
    for (const publication of participant.trackPublications.values()) {
      if (publication.source === Track.Source.ScreenShare) video = true;
      else if (publication.source === Track.Source.ScreenShareAudio)
        audio = true;
    }
    return audio && !video;
  }

  /**
   * Toggle watching (or listening to) one share identity.
   */
  function toggleWatch(identity: string) {
    if (voice.isWatchingShare(identity)) voice.stopWatchingShare(identity);
    else voice.watchShare(identity);
    props.onClose?.();
  }

  /**
   * The personal in-call controls (volume, mute, whisper, draw consent).
   */
  const personalVoiceShown = () =>
    !!props.inVoice && !props.user.self && !props.isScreenshare;

  /**
   * The first group of the call section: personal controls and watch items.
   */
  const callPersonalShown = () =>
    personalVoiceShown() || watchIdentities().length > 0;

  /**
   * Whether the quick-actions group (profile, message, mention) renders
   * anything. It is the only group below the call section without a leading
   * divider of its own, so the call section's trailing divider depends on it.
   */
  const quickActionsShown = () =>
    !isProfileOpen() || canDm() || props.channel?.type === "TextChannel";

  /**
   * Toggle the server mute on this member
   */
  function toggleServerMute() {
    const member = callMember();
    if (!member) return;

    member.setServerMuted(!member.serverMuted).catch(moderationFailed);
    props.onClose?.();
  }

  /**
   * Toggle the server deafen on this member
   */
  function toggleServerDeafen() {
    const member = callMember();
    if (!member) return;

    member.setServerDeafened(!member.serverDeafened).catch(moderationFailed);
    props.onClose?.();
  }

  /**
   * Disconnect this member from the call
   */
  function disconnectFromCall() {
    const member = callMember();
    if (!member) return;

    member.disconnectFromVoice().catch(moderationFailed);
    props.onClose?.();
  }

  /**
   * Whether the user can remove a member from the current group
   */
  function canRemoveMemberFromGroup() {
    return (
      props.channel?.type === "Group" &&
      !props.user.self &&
      props.channel.owner?.id !== props.user.id &&
      (props.channel.havePermission("ManageChannel") ||
        props.channel.owner?.self)
    );
  }

  return (
    <ContextMenu class="UserContextMenu">
      {/* Voice controls */}
      <Show when={personalVoiceShown()}>
        <ContextMenuButton
          onMouseDown={(e) => e.stopImmediatePropagation()}
          onClick={(e) => e.stopImmediatePropagation()}
        >
          <Text class="label">
            <Trans>Volume</Trans>
          </Text>
          <Slider
            min={0}
            max={3}
            step={0.1}
            value={state.voice.getUserVolume(props.user.id)}
            onInput={(event) =>
              state.voice.setUserVolume(
                props.user.id,
                event.currentTarget.value,
              )
            }
            labelFormatter={(label) => (label * 100).toFixed(0) + "%"}
          />
        </ContextMenuButton>
        <ContextMenuButton
          icon={MdMicOff}
          onClick={() =>
            state.voice.setUserMuted(
              props.user.id,
              !state.voice.getUserMuted(props.user.id),
            )
          }
          actionSymbol={
            state.voice.getUserMuted(props.user.id) ? MdChecked : MdUnchecked
          }
        >
          <Trans>Mute</Trans>
        </ContextMenuButton>
        <ContextMenuButton
          icon={MdHearing}
          onClick={() =>
            voice.whisper.target() === props.user.id
              ? void voice.stopWhisper()
              : void voice.startWhisper(props.user.id)
          }
        >
          <Show
            when={voice.whisper.target() === props.user.id}
            fallback={<Trans>Whisper</Trans>}
          >
            <Trans>Stop whispering</Trans>
          </Show>
        </ContextMenuButton>
        {/* Draw consent (tech-support mode §2.4): only while I am sharing my
            screen. OFF by default, granted per NAMED person; the server
            enforces the allowlist on every stroke. The revoke here is the
            one-action clear-ALL, and its label says so — per-person removal
            deliberately does not exist. */}
        <Show when={voice.screenshare()}>
          <Show
            when={voice.annotations.mayDraw(
              voice.annotations.localUserId,
              props.user.id,
            )}
            fallback={
              <ContextMenuButton
                icon={MdDraw}
                onClick={() =>
                  void voice.channel()?.allowAnnotator(props.user.id)
                }
              >
                <Trans>Let them draw on my shared screen</Trans>
              </ContextMenuButton>
            }
          >
            <ContextMenuButton
              icon={MdDraw}
              onClick={() => void voice.channel()?.revokeAnnotators()}
            >
              <Trans>Stop all drawing on my screen</Trans>
            </ContextMenuButton>
          </Show>
        </Show>
      </Show>
      {/* Watch / Listen, one entry per share identity (two devices sharing
          give two entries). Outside the personal block on purpose: that one
          is hidden on our own row, and a share from another of OUR devices
          needs a Watch too. */}
      <For each={watchIdentities()}>
        {(identity) => (
          <Show
            when={isAudioOnlyShare(identity)}
            fallback={
              <ContextMenuButton
                icon={
                  voice.isWatchingShare(identity)
                    ? MdVisibilityOff
                    : MdVisibility
                }
                onClick={() => toggleWatch(identity)}
              >
                <Show
                  when={voice.isWatchingShare(identity)}
                  fallback={<Trans>Watch stream</Trans>}
                >
                  <Trans>Stop watching</Trans>
                </Show>
              </ContextMenuButton>
            }
          >
            <ContextMenuButton
              icon={
                voice.isWatchingShare(identity) ? MdHeadsetOff : MdHeadphones
              }
              onClick={() => toggleWatch(identity)}
            >
              <Show
                when={voice.isWatchingShare(identity)}
                fallback={<Trans>Listen to stream audio</Trans>}
              >
                <Trans>Stop listening</Trans>
              </Show>
            </ContextMenuButton>
          </Show>
        )}
      </For>
      {/* Server moderation of the call. Distinct from the personal "Mute"
          above, which only silences this person for ME — these change what
          the SFU accepts from them, for everyone. Its own section so a
          moderator can act from a sidebar row of a call they are not in.
          Each entry is gated by the same permission (server level for mute
          and deafen, channel level for disconnect and move) and rank check
          the API applies, so an entry that renders is one the API will
          honour. */}
      <Show when={callModerationShown()}>
        <Show when={callPersonalShown()}>
          <ContextMenuDivider />
        </Show>
        <Show when={moderation().mute}>
          <ContextMenuButton
            icon={MdVoiceOverOff}
            onClick={toggleServerMute}
            actionSymbol={callMember()?.serverMuted ? MdChecked : MdUnchecked}
          >
            <Trans>Server mute</Trans>
          </ContextMenuButton>
        </Show>
        <Show when={moderation().deafen}>
          <ContextMenuButton
            icon={MdHeadsetOff}
            onClick={toggleServerDeafen}
            actionSymbol={
              callMember()?.serverDeafened ? MdChecked : MdUnchecked
            }
          >
            <Trans>Server deafen</Trans>
          </ContextMenuButton>
        </Show>
        <Show when={moderation().disconnect}>
          <ContextMenuButton
            icon={MdCallEnd}
            onClick={disconnectFromCall}
            destructive
          >
            <Trans>Disconnect from call</Trans>
          </ContextMenuButton>
        </Show>
        <Show when={moveTargetChannels().length > 0}>
          <ContextMenuSubMenu
            icon={MdMoveDown}
            buttonContent={<Trans>Move to…</Trans>}
          >
            <For each={moveTargetChannels()}>
              {(channel) => (
                <ContextMenuButton onClick={() => moveToChannel(channel.id)}>
                  {channel.name}
                </ContextMenuButton>
              )}
            </For>
          </ContextMenuSubMenu>
        </Show>
      </Show>
      <Show
        when={
          (callPersonalShown() || callModerationShown()) && quickActionsShown()
        }
      >
        <ContextMenuDivider />
      </Show>
      <Show when={props.isScreenshare && !props.user.self}>
        <ContextMenuButton
          onMouseDown={(e) => e.stopImmediatePropagation()}
          onClick={(e) => e.stopImmediatePropagation()}
        >
          <Text class="label">
            <Trans>Screen Share Volume</Trans>
          </Text>
          <Slider
            min={0}
            max={3}
            step={0.1}
            value={state.voice.getScreenShareVolume(props.user.id)}
            onInput={(event) =>
              state.voice.setScreenShareVolume(
                props.user.id,
                event.currentTarget.value,
              )
            }
            labelFormatter={(label) => (label * 100).toFixed(0) + "%"}
          />
        </ContextMenuButton>
        <ContextMenuButton
          icon={MdMicOff}
          onClick={() =>
            state.voice.setScreenShareMuted(
              props.user.id,
              !state.voice.getScreenShareMuted(props.user.id),
            )
          }
          actionSymbol={
            state.voice.getScreenShareMuted(props.user.id)
              ? MdChecked
              : MdUnchecked
          }
        >
          <Trans>Mute Screen Share</Trans>
        </ContextMenuButton>

        <ContextMenuDivider />
      </Show>

      {/* Quick actions: Profile, Message, Mention */}
      <Show when={!isProfileOpen()}>
        <ContextMenuButton icon={MdAccountCircle} onClick={openProfile}>
          <Trans>Profile</Trans>
        </ContextMenuButton>
      </Show>
      <Show when={canDm()}>
        <ContextMenuButton icon={MdChat} onClick={openDm}>
          <Trans>Send Message</Trans>
        </ContextMenuButton>
        <ContextMenuButton icon={MdCall} onClick={startVoiceCall}>
          <Trans>Call</Trans>
        </ContextMenuButton>
        <Show when={CONFIGURATION.ENABLE_VIDEO}>
          <ContextMenuButton icon={MdVideocam} onClick={startVideoCall}>
            <Trans>Video Call</Trans>
          </ContextMenuButton>
          <Show when={screenShareSupported()}>
            <ContextMenuButton
              icon={MdScreenShare}
              onClick={startScreenShareCall}
            >
              <Trans>Screen Share</Trans>
            </ContextMenuButton>
          </Show>
        </Show>
      </Show>
      <Show when={props.channel?.type === "TextChannel"}>
        <ContextMenuButton icon={MdAlternateEmail} onClick={mention}>
          <Trans>Mention</Trans>
        </ContextMenuButton>
      </Show>

      {/* DM-specific section */}
      <Show when={props.channel?.type === "DirectMessage"}>
        <ContextMenuDivider />
        <ContextMenuButton icon={MdClose} onClick={closeDm} destructive>
          <Trans>Close chat</Trans>
        </ContextMenuButton>
        <NotificationContextMenu channel={props.channel!} />
      </Show>

      {/* Server identity and roles */}
      <Show when={canEditIdentity() || canEditRoles()}>
        <ContextMenuDivider />
        <Show when={canEditIdentity()}>
          <ContextMenuButton icon={MdFace} onClick={editIdentity}>
            <Switch fallback={<Trans>Edit identity</Trans>}>
              <Match when={props.user.self}>
                <Trans>Edit your identity</Trans>
              </Match>
            </Switch>
          </ContextMenuButton>
        </Show>
        <Show when={canEditRoles()}>
          <ContextMenuButton icon={MdAssignmentInd} onClick={editRoles}>
            <Trans>Edit roles</Trans>
          </ContextMenuButton>
        </Show>
      </Show>

      {/* Social: friend requests */}
      <Show
        when={
          !props.user.self &&
          !props.user.bot &&
          (props.user.relationship === "None" ||
            props.user.relationship === "Incoming" ||
            props.user.relationship === "Outgoing")
        }
      >
        <ContextMenuDivider />
        <Show when={props.user.relationship === "None"}>
          <ContextMenuButton icon={MdPersonAddAlt} onClick={sendFriendRequest}>
            <Trans>Add friend</Trans>
          </ContextMenuButton>
        </Show>
        <Show when={props.user.relationship === "Incoming"}>
          <ContextMenuButton icon={MdPersonAddAlt} onClick={addFriend}>
            <Trans>Accept friend request</Trans>
          </ContextMenuButton>
          <ContextMenuButton icon={MdCancel} onClick={removeFriend} destructive>
            <Trans>Reject friend request</Trans>
          </ContextMenuButton>
        </Show>
        <Show when={props.user.relationship === "Outgoing"}>
          <ContextMenuButton icon={MdCancel} onClick={removeFriend} destructive>
            <Trans>Cancel friend request</Trans>
          </ContextMenuButton>
        </Show>
      </Show>

      {/* Moderation: kick, ban */}
      {/** TODO: #287 timeout users */}
      <Show
        when={
          canRemoveMemberFromGroup() ||
          (props.member && (canKick() || canBan()))
        }
      >
        <ContextMenuDivider />
        <Show when={canRemoveMemberFromGroup()}>
          <ContextMenuButton
            icon={MdPersonRemove}
            onClick={removeMember}
            destructive
          >
            <Trans>Remove Member</Trans>
          </ContextMenuButton>
        </Show>
        <Show when={canKick()}>
          <ContextMenuButton
            icon={MdPersonRemove}
            onClick={kickMember}
            destructive
          >
            <Trans>Kick member</Trans>
          </ContextMenuButton>
        </Show>
        <Show when={canBan()}>
          <ContextMenuButton
            icon={MdDoNotDisturbOn}
            onClick={banMember}
            destructive
          >
            <Trans>Ban member</Trans>
          </ContextMenuButton>
        </Show>
      </Show>
      <Show when={canBanNonMember()}>
        <ContextMenuDivider />
        <ContextMenuButton
          icon={MdDoNotDisturbOn}
          onClick={banUser}
          destructive
        >
          <Trans>Ban user</Trans>
        </ContextMenuButton>
      </Show>

      {/* Platform moderation (privileged accounts only) */}
      <Show when={canSuspend()}>
        <ContextMenuDivider />
        <Show when={!isSuspended()}>
          <ContextMenuButton
            icon={MdAdminPanelSettings}
            onClick={suspendUser}
            destructive
          >
            <Trans>Suspend from platform</Trans>
          </ContextMenuButton>
        </Show>
        <Show when={isSuspended()}>
          <ContextMenuButton
            icon={MdAdminPanelSettings}
            onClick={unsuspendUser}
          >
            <Trans>Lift platform suspension</Trans>
          </ContextMenuButton>
        </Show>
      </Show>

      {/* Safety: remove friend, block, report */}
      <Show when={!props.user.self}>
        <ContextMenuDivider />
        <Show when={props.user.relationship === "Friend"}>
          <ContextMenuButton
            icon={MdPersonRemove}
            onClick={removeFriend}
            destructive
          >
            <Trans>Remove friend</Trans>
          </ContextMenuButton>
        </Show>
        <Show when={props.user.relationship !== "Blocked"}>
          <ContextMenuButton icon={MdBlock} onClick={blockUser} destructive>
            <Trans>Block user</Trans>
          </ContextMenuButton>
        </Show>
        <Show when={props.user.relationship === "Blocked"}>
          <ContextMenuButton icon={MdAddCircleOutline} onClick={unblockUser}>
            <Trans>Unblock user</Trans>
          </ContextMenuButton>
        </Show>
        <ContextMenuButton icon={MdReport} onClick={reportUser} destructive>
          <Trans>Report user</Trans>
        </ContextMenuButton>
      </Show>

      {/* Developer tools */}
      <Show when={state.settings.getValue("advanced:copy_id")}>
        <ContextMenuDivider />
        <ContextMenuButton icon={MdBadge} onClick={copyId}>
          <Trans>Copy user ID</Trans>
        </ContextMenuButton>
      </Show>
    </ContextMenu>
  );
}

/**
 * Provide floating user menus on this element
 * @param user User
 * @param member Server Member
 * @param contextMessage Message
 * @param contextGroup Group
 */
export function floatingUserMenus(
  user: User,
  member?: ServerMember,
  contextMessage?: Message,
  contextGroup?: Channel,
): JSX.Directives["floating"] & object {
  return {
    userCard: {
      user,
      member,
      // we could use message to display masquerade info in user card
    },
    /**
     * Build user context menu
     */
    contextMenu() {
      return (
        <UserContextMenu
          user={user}
          member={member}
          contextMessage={contextMessage}
          channel={contextMessage?.channel ?? contextGroup}
        />
      );
    },
  };
}

export function floatingUserMenusFromMessage(message: Message) {
  return message.author
    ? floatingUserMenus(message.author!, message.member, message)
    : {}; // TODO: webhook menu
}
