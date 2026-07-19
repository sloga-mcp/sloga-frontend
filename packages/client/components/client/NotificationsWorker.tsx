import { createEffect, onCleanup, onMount } from "solid-js";

import { Capacitor, registerPlugin } from "@capacitor/core";

import { useLingui } from "@lingui-solid/solid/macro";
import {
  Channel,
  ChannelEditSystemMessage,
  ChannelOwnershipChangeSystemMessage,
  ChannelRenamedSystemMessage,
  HydratedUser,
  Message,
  MessagePinnedSystemMessage,
  TextSystemMessage,
  User,
  UserModeratedSystemMessage,
  UserSystemMessage,
} from "stoat.js";

import { useNavigate, useSmartParams } from "@revolt/routing";
import {
  dismissIncomingCall,
  presentIncomingCall,
  useVoice,
} from "@revolt/rtc";
import { useState } from "@revolt/state";
import { streamerModeHides } from "@revolt/state/streamer";

import { useClient, useNotifications, useSound } from ".";
import {
  notificationPermissionGranted,
  showNotification,
} from "./nativeNotifications";

/**
 * Process and display desktop notifications
 */
export function NotificationsWorker() {
  const state = useState();
  const { t } = useLingui();
  const client = useClient();
  const navigate = useNavigate();
  const voice = useVoice();
  const params = useSmartParams();
  const sound = useSound();

  const { initNotifications } = useNotifications();

  /**
   * Whether Streamer Mode is suppressing notification popups right now.
   * Sounds are gated separately by the sound controller.
   */
  const notificationsSuppressed = () =>
    streamerModeHides(state.settings, "notifications");

  /**
   * Handle incoming messages
   * @param message Message
   */
  function onMessage(message: Message) {
    const us = client().user!;

    // Ephemeral interaction responses are the bot answering something this
    // user just did — never worth a notification (and never persisted)
    if (message.isEphemeral) return;

    // Ignore if we are currently looking at the channel
    if (params().channelId === message.channelId && document.hasFocus()) return;

    // Ignore our own messages
    if (message.author?.self) return;

    // Ignore blocked users
    if (message.author?.relationship === "Blocked") return;

    // Ignore muted channels
    if (state.notifications.isMuted(message.channel)) return;

    // Check channel notification settings
    switch (state.notifications.computeForChannel(message.channel!)) {
      case "none":
        return; // ignore if muted/none
      case "mention":
        if (!message.mentioned) return; // ignore if not mentioned
    }

    // Ignore if we're busy or focused
    if (
      us.status?.presence === "Busy" ||
      (us.status?.presence === "Focus" && !message.mentioned)
    )
      return;

    // Generate the title
    let title;
    switch (message.channel!.type) {
      case "SavedMessages":
        return;
      case "DirectMessage":
        title = `@${message.username}`;
        break;
      case "Group":
        if (message.author?.id === "00000000000000000000000000") {
          title = message.channel?.name;
        } else {
          title = `@${message.username} - ${message.channel?.name}`;
        }
        break;
      case "TextChannel":
        title = `@${message.username} (#${message.channel?.name}, ${message.channel?.server?.name})`;
        break;
    }

    // Find image if applicable
    const image = message.attachments?.find(
      (x) => x.metadata.type === "Image",
    )?.previewUrl;

    // Find body/icon
    let body, icon;
    if (message.content) {
      body = message.contentPlain;
      icon = message.avatarURL;
    } else if (message.forwarded) {
      // Forwarded messages carry no content of their own — preview the
      // snapshot instead of showing an empty notification
      body = message.forwarded.content ?? t`Forwarded a message`;
      icon = message.avatarURL;
    } else if (message.systemMessage) {
      switch (message.systemMessage.type) {
        case "text":
          body = (message.systemMessage as TextSystemMessage).content;
          break;
        case "user_added":
          body = t`${
            (message.systemMessage as UserModeratedSystemMessage).user?.username
          } was added by ${
            (message.systemMessage as UserModeratedSystemMessage).by?.username
          }`;
          icon = (message.systemMessage as UserModeratedSystemMessage).user
            ?.avatarURL;
          break;
        case "user_remove":
          body = t`${
            (message.systemMessage as UserModeratedSystemMessage).user?.username
          } was removed by ${
            (message.systemMessage as UserModeratedSystemMessage).by?.username
          }`;
          icon = (message.systemMessage as UserModeratedSystemMessage).user
            ?.avatarURL;
          break;
        case "user_joined":
          body = t`${
            (message.systemMessage as UserSystemMessage).user?.username
          } joined`;
          icon = (message.systemMessage as UserSystemMessage).user?.avatarURL;
          break;
        case "user_left":
          body = t`${
            (message.systemMessage as UserSystemMessage).user?.username
          } left`;
          icon = (message.systemMessage as UserSystemMessage).user?.avatarURL;
          break;
        case "user_kicked":
          body = t`${
            (message.systemMessage as UserSystemMessage).user?.username
          } was kicked`;
          icon = (message.systemMessage as UserSystemMessage).user?.avatarURL;
          break;
        case "user_banned":
          body = t`${
            (message.systemMessage as UserSystemMessage).user?.username
          } was banned`;
          icon = (message.systemMessage as UserSystemMessage).user?.avatarURL;
          break;
        case "channel_renamed":
          body = t`${
            (message.systemMessage as ChannelRenamedSystemMessage).by?.username
          } renamed the channel`;
          icon = (message.systemMessage as ChannelRenamedSystemMessage).by
            ?.avatarURL;
          break;
        case "channel_description_changed":
          body = t`${
            (message.systemMessage as ChannelEditSystemMessage).by?.username
          } changed the channel description`;
          icon = (message.systemMessage as ChannelEditSystemMessage).by
            ?.avatarURL;
          break;
        case "channel_icon_changed":
          body = t`${
            (message.systemMessage as ChannelEditSystemMessage).by?.username
          } changed the channel icon`;
          icon = (message.systemMessage as ChannelEditSystemMessage).by
            ?.avatarURL;
          break;
        case "channel_ownership_changed":
          body = t`${
            (message.systemMessage as ChannelOwnershipChangeSystemMessage).from
              ?.username
          } made ${
            (message.systemMessage as ChannelOwnershipChangeSystemMessage).to
              ?.username
          } the new group owner`;
          icon = (message.systemMessage as ChannelOwnershipChangeSystemMessage)
            .from?.avatarURL;
          break;
        case "message_pinned":
          body = t`${
            (message.systemMessage as MessagePinnedSystemMessage).by?.username
          } pinned a message`;
          icon = (message.systemMessage as MessagePinnedSystemMessage).by
            ?.avatarURL;
          break;
        case "message_unpinned":
          body = t`${
            (message.systemMessage as MessagePinnedSystemMessage).by?.username
          } unpinned a message`;
          icon = (message.systemMessage as MessagePinnedSystemMessage).by
            ?.avatarURL;
          break;
      }
    } else if (message.attachments?.length) {
      body = t`Sent ${message.attachments!.length} attachments`;
    }

    // Don't continue if we don't have notification permissions
    if (
      !notificationPermissionGranted() ||
      state.settings.desktopNotificationsState !== "allowed"
    )
      return;

    sound.playSound("message");

    if (notificationsSuppressed()) return;

    console.info(`[notification] ${title} ${icon} ${body}`);

    showNotification({
      title: title!,
      icon,
      image,
      body,
      timestamp: message.createdAt,
      tag: message.channelId,
      path: message.path,
      onClick: () => {
        window.focus();
        navigate(message.path);
      },
    });
  }

  /**
   * Handle incoming voice call (someone joins a DM/Group voice call)
   */
  function onVoiceChannelJoin(channel: Channel, userId: string) {
    const us = client().user!;

    // Only care about DM and Group channels (not server voice channels)
    if (channel.type !== "DirectMessage" && channel.type !== "Group") return;

    // We answered (or started) the call — stop any ringing
    if (userId === us.id) {
      sound.stopRingtone();
      dismissIncomingCall(channel.id);
      return;
    }

    // Never ring if we're already in this call (e.g. the other side answering)
    if (channel.voiceParticipants.has(us.id)) return;

    // Only ring when the call STARTS (the joiner is the sole participant);
    // later joiners of an ongoing group call shouldn't re-ring us
    if (channel.voiceParticipants.size !== 1) return;

    const callerUser = client().users.get(userId);
    const callerName = callerUser?.displayName ?? callerUser?.username ?? "Someone";
    const channelName = channel.type === "Group" ? channel.name : callerName;

    // Play incoming ringtone (respects user sound preference)
    sound.playSound("ringtoneIncoming");

    // In-app ringing popup (IncomingCallOverlay) with Accept/Decline — shown
    // regardless of desktop-notification permission so calls are answerable
    presentIncomingCall({
      channel,
      caller: callerUser,
      receivedAt: Date.now(),
    });

    // Show desktop notification if permitted
    if (
      notificationPermissionGranted() &&
      state.settings.desktopNotificationsState === "allowed" &&
      !notificationsSuppressed()
    ) {
      showNotification({
        title: t`Incoming Call`,
        body: t`${callerName} is calling in ${channelName}`,
        icon: callerUser?.avatarURL,
        tag: `call-${channel.id}`,
        path: channel.path,
        onClick: () => {
          window.focus();
          navigate(channel.path);
        },
      });
    }
  }

  /**
   * Stop ringing when the caller gives up (leaves the call before we answer)
   */
  function onVoiceChannelLeave(channel: Channel, _userId: string) {
    if (channel.type !== "DirectMessage" && channel.type !== "Group") return;
    if (channel.voiceParticipants.size === 0) {
      sound.stopRingtone();
      dismissIncomingCall(channel.id);
    }
  }

  /**
   * Handle friend requests — fires when a user's relationship changes to Incoming
   */
  function onUserUpdate(user: User, previousUser: HydratedUser) {
    if (user.relationship !== "Incoming") return;
    if (previousUser.relationship === "Incoming") return;

    // Play message sound as alert
    sound.playSound("message");

    if (
      notificationPermissionGranted() &&
      state.settings.desktopNotificationsState === "allowed" &&
      !notificationsSuppressed()
    ) {
      showNotification({
        title: t`Friend Request`,
        body: t`${user.displayName ?? user.username} sent you a friend request`,
        icon: user.animatedAvatarURL ?? user.avatarURL,
        tag: `friend-request-${user.id}`,
        path: "/friends",
        onClick: () => {
          window.focus();
          navigate("/friends");
        },
      });
    }
  }

  // Desktop shell: clicking a WinRT toast focuses the window and emits
  // `notification_clicked` with the in-app path to open (see
  // show_clickable_notification in the desktop shell)
  onMount(() => {
    const tauriEvent = (
      window as {
        __TAURI__?: {
          event?: {
            listen(
              event: string,
              handler: (event: { payload: unknown }) => void,
            ): Promise<() => void>;
          };
        };
      }
    ).__TAURI__?.event;
    if (!tauriEvent) return;

    const unlisten = tauriEvent.listen("notification_clicked", (event) => {
      if (typeof event.payload === "string" && event.payload.startsWith("/")) {
        navigate(event.payload);
      }
    });
    onCleanup(() => unlisten.then((fn) => fn()).catch(() => {}));
  });

  // Native app: notification taps (open message / answer call) navigate here
  onMount(() => {
    if (!Capacitor.isNativePlatform()) return;

    const handleAction = (path?: string | null, answer?: boolean) => {
      if (!path) return;
      navigate(path);

      // "Answer" on an incoming call notification: join the call directly
      if (answer) {
        const channelId = path.split("/").pop();
        const joinCall = (attempt: number) => {
          const channel = channelId
            ? client().channels.get(channelId)
            : undefined;
          if (channel) {
            voice.connect(channel).catch(console.error);
          } else if (attempt < 20) {
            // Cold start: wait for the client to connect and hydrate
            setTimeout(() => joinCall(attempt + 1), 500);
          }
        };
        joinCall(0);
      }
    };

    // Cold start: consume the action stored before the web app was ready
    registerPlugin<{
      consumeLaunchAction(): Promise<{ path?: string | null; answer: boolean }>;
    }>("PushToken")
      .consumeLaunchAction()
      .then(({ path, answer }) => handleAction(path, answer))
      .catch(() => {});

    // Warm app: actions arrive as window events
    const onAction = (event: Event) => {
      try {
        const data = JSON.parse((event as CustomEvent).detail ?? "{}");
        handleAction(data.path, data.answer);
      } catch {
        /* ignore malformed payloads */
      }
    };
    window.addEventListener("slogaNotificationAction", onAction);
    onCleanup(() =>
      window.removeEventListener("slogaNotificationAction", onAction),
    );
  });

  /**
   * Handle a new moderation report landing. Only privileged (moderator)
   * sessions receive this event from the server, so no extra gating is
   * needed here — its arrival means a report needs attention.
   * @param report Minimal report metadata (no message content)
   */
  function onReport(report: {
    id: string;
    contentType: "Message" | "Server" | "User";
    reason: string;
  }) {
    if (!notificationPermissionGranted() || notificationsSuppressed()) return;

    showNotification({
      title: t`New report`,
      body: t`${report.contentType} reported (${report.reason})`,
      tag: `report-${report.id}`,
    });

    sound.playSound("message");
  }

  createEffect(() => {
    client().addListener("messageCreate", onMessage);
    client().addListener("voiceChannelJoin", onVoiceChannelJoin);
    client().addListener("voiceChannelLeave", onVoiceChannelLeave);
    client().addListener("userUpdate", onUserUpdate);
    client().addListener("reportCreate", onReport);
    onCleanup(() => {
      client().removeListener("messageCreate", onMessage);
      client().removeListener("voiceChannelJoin", onVoiceChannelJoin);
      client().removeListener("voiceChannelLeave", onVoiceChannelLeave);
      client().removeListener("userUpdate", onUserUpdate);
      client().removeListener("reportCreate", onReport);
    });
  });

  /**
   * Reconnect WebSocket when the window regains focus in case the connection
   * went stale while the app was minimized or backgrounded.
   */
  function onVisibilityChange() {
    if (document.visibilityState !== "visible") return;
    const c = client();
    if (!c) return;
    const wsState = c.events.state();
    // ConnectionState: 0=Idle, 1=Connecting, 2=Connected, 3=Disconnected
    if (wsState === 3 || wsState === 0) {
      console.info("[notifications] Window focused — reconnecting WebSocket");
      c.connect();
    }
  }

  /**
   * Handle page click to request notifications
   */
  function tryRequest() {
    document.removeEventListener("click", tryRequest);
    initNotifications();
  }

  onMount(() => {
    document.addEventListener("click", tryRequest);
    document.addEventListener("visibilitychange", onVisibilityChange);
  });

  onCleanup(() => {
    document.removeEventListener("click", tryRequest);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  });

  return null;
}
