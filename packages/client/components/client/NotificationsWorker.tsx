import {
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";

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
  outgoingRingOnVoiceJoin,
  outgoingRingOnVoiceLeave,
  presentIncomingCall,
  useVoice,
} from "@revolt/rtc";
import { useState } from "@revolt/state";
import { streamerModeActive, streamerModeHides } from "@revolt/state/streamer";

import { useClient, useClientLifecycle, useNotifications, useSound } from ".";
import { State } from "./Controller";
import {
  isWebPushPlatform,
  pushProvider,
  unifiedPushRegistered,
} from "./NotificationsController";
import {
  notificationPermissionGranted,
  showNotification,
} from "./nativeNotifications";
import {
  type ConversationE2EEMode,
  type NotificationSurface,
  type PreviewDecision,
  type PreviewPolicyInput,
  decidePreview,
  DM_PREVIEW_DEFAULT,
  e2eeNotificationGate,
} from "./notificationPreviewPolicy";
import { playsWebRingtone } from "./pushPolicy";
import { connectionUrl } from "./streamConnections";
import { toastSurfaceFor } from "./toastPolicy";
import { toastSupported, useToastShell } from "./toastShell";
import { type UnreadBadge, sameBadge, unreadBadge } from "./unreadBadge";
import { publishUnreadBadge } from "./unreadBadgeShell";

/**
 * Who draws a message notification when our own toast window is unavailable.
 * Both desktop shells hand it to the OS (the Tauri toast, Electron's
 * `Notification`), which keeps its text in the OS notification store;
 * anything else is the browser's own.
 */
function notificationSurface(): NotificationSurface {
  return "__TAURI__" in window || "slogaShell" in window ? "os_toast" : "web";
}

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
  const toastShell = useToastShell();
  const { lifecycle } = useClientLifecycle();

  // Tell the native layer whether this web layer can currently present the
  // ringing popup, so SlogaNotifier.notifyIncomingCall (shared by the FCM and
  // UnifiedPush services) can suppress the DUPLICATE notification. Without
  // this an incoming call shows an Android notification AND an in-app popup,
  // each needing its own Decline (reported 2026-08-30).
  //
  // Reported on every connection-state change rather than once at mount: the
  // popup rides the websocket VoiceChannelJoin event, so a disconnected client
  // cannot show one and must NOT suppress the notification — that would turn a
  // duplicate into a silently MISSED call.
  createEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const active = lifecycle.state() === State.Connected;
    const plugin = registerPlugin<{
      setInAppCallUiActive(options: { active: boolean }): Promise<void>;
    }>("PushToken");
    plugin.setInAppCallUiActive({ active }).catch(() => {});
    onCleanup(() => {
      plugin.setInAppCallUiActive({ active: false }).catch(() => {});
    });
  });

  const { initNotifications, resyncPushSubscription, retryWebPushOnGesture } =
    useNotifications();

  /**
   * Whether Streamer Mode is suppressing notification popups right now.
   * Sounds are gated separately by the sound controller.
   */
  const notificationsSuppressed = () =>
    streamerModeHides(state.settings, "notifications");

  /**
   * The E2EE state of a message's conversation, for `e2eeNotificationGate`.
   * The send-mode cache only fills when a conversation is opened, sent to or
   * synced, so a miss asks the native layer, which also fills the cache. A
   * failed lookup is "unknown", never a guess.
   */
  async function conversationE2EEMode(
    channel: Channel,
  ): Promise<ConversationE2EEMode> {
    const e2ee = client().e2ee as import("./e2ee").E2EEBridge | undefined;
    if (!e2ee) return null;
    if (channel.type !== "DirectMessage" && channel.type !== "Group")
      return null;
    const key = channel.type === "Group" ? channel.id : channel.recipient?.id;
    const cached = key ? e2ee.sendModes.get(key) : undefined;
    try {
      return cached ?? (await e2ee.sendModeNowFor(channel));
    } catch {
      return "unknown";
    }
  }

  /**
   * Handle incoming messages
   * @param message Message
   */
  async function onMessage(message: Message) {
    const us = client().user!;

    // Ephemeral interaction responses are the bot answering something this
    // user just did — never worth a notification (and never persisted)
    if (message.isEphemeral) return;

    // Silent sends ("@silent ", flag mask 1) skip the popup and the sound.
    // The server already skips push for them, and an online user gets no
    // push at all, so this popup would be the only alert they see. The
    // unread and mention badges still update through stoat.js.
    if (message.isSuppressed) return;

    // Ignore if we are currently looking at the channel
    if (params().channelId === message.channelId && document.hasFocus()) return;

    // Ignore our own messages
    if (message.author?.self) return;

    // Ignore blocked users
    if (message.author?.relationship === "Blocked") return;

    // A message can arrive for a channel this client no longer has, such as
    // a thread of a server we just left, which stoat.js has swept from the
    // cache. There is nothing to notify about without the channel.
    if (!message.channel) return;

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

    // In an encrypted conversation the transcript hides every message this
    // device did not decrypt itself (Messages.tsx), so it must not notify
    // either: announced under the peer's name, it would let the server speak
    // for them. Asked after the cheap checks above, so the native lookup only
    // runs for a message that would otherwise notify.
    const e2eeGate = e2eeNotificationGate(
      await conversationE2EEMode(message.channel),
      !!client().e2ee?.isEncryptedMessage(message.id),
    );
    if (e2eeGate === "suppress") return;

    // The lookup can take a moment. Meanwhile the channel may have been swept
    // from the cache, or the user may have opened it and is reading already.
    if (!message.channel) return;
    if (params().channelId === message.channelId && document.hasFocus()) return;

    // Held from here on: the toast below is awaited, and stoat.js may sweep
    // the channel from the cache meanwhile.
    const channel = message.channel;
    if (channel.type === "SavedMessages") return;

    // How much this notification may reveal. Decided before the sound so
    // "Off" stays silent, and before the payload so a withheld body is never
    // built into it. Everything but the surface is fixed here, so a refused
    // Sloga toast is decided again for the OS toast from the same facts.
    const policy: Omit<PreviewPolicyInput, "surface"> = {
      mode:
        state.settings.getValue("notifications:dm_preview") ??
        DM_PREVIEW_DEFAULT,
      override: state.settings.getValue("notifications:dm_preview_overrides")?.[
        message.channelId
      ],
      // A conversation whose E2EE state could not be read is treated as
      // encrypted: its content stays off any toast the OS draws.
      isE2EE:
        e2eeGate === "sender_only" ||
        !!client().e2ee?.isEncryptedMessage(message.id),
      screensharing: voice.screenshare(),
      streamerMode: streamerModeActive(state.settings),
      // Any session in which we give control counts, an offer still pending
      // included: the controller may be watching before input is live.
      rcActive: !!voice.remoteControl.sharing(),
      channelType: channel.type,
    };
    const decide = (surface: NotificationSurface): PreviewDecision => {
      const decision = decidePreview({ ...policy, surface });
      // decidePreview lets our own toast show encrypted text, but under this
      // gate the content is whatever the server supplied, unverified. No
      // surface shows it, and no reply goes into a conversation whose state
      // we could not read.
      if (e2eeGate === "sender_only") {
        decision.showBody = false;
        decision.showImage = false;
        decision.allowReply = false;
      }
      return decision;
    };
    // Our toast is for direct messages and group chats (toastSurfaceFor
    // decides; the shell is asked only where it could say yes). A toast the
    // shell cannot keep out of screen capture is its own surface, so an
    // encrypted message on it stays sender-only, and the toast shell is held
    // to the surface decided here.
    const toastSurface = toastSurfaceFor(
      channel.type,
      channel.type === "DirectMessage" || channel.type === "Group"
        ? toastSupported()
        : null,
    );
    const slogaToast = toastSurface !== null;
    const preview = decide(toastSurface ?? notificationSurface());
    if (!preview.show) return;

    // Generate the title. A function of the decision, since the OS fallback
    // below may reveal less than the decision it replaces.
    const titleFor = (decision: PreviewDecision) => {
      switch (channel.type) {
        case "DirectMessage": {
          const name = message.username;
          return decision.showBody ? `@${name}` : t`New message from ${name}`;
        }
        case "Group":
          if (message.author?.id === "00000000000000000000000000") {
            return channel.name;
          }
          return `@${message.username} - ${channel.name}`;
        case "TextChannel":
          return `@${message.username} (#${channel.name}, ${channel.server?.name})`;
      }
    };

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

    if (preview.playSound) sound.playSound("message");

    if (notificationsSuppressed()) return;

    // Our own toast window first, where the shell has one. Its text never
    // reaches the OS notification store, so the protected one alone may show
    // an encrypted message's content and offer a reply. A rejected show() (an
    // older shell) counts as refused like any other.
    if (
      toastSurface !== null &&
      (await toastShell
        .show(
          {
            channelId: message.channelId,
            messageId: message.id,
            title: titleFor(preview) ?? "",
            sender: message.username ?? "",
            body: preview.showBody ? (body ?? null) : null,
            avatarUrl: icon ?? null,
            allowReply: preview.allowReply,
          },
          toastSurface,
        )
        .catch(() => false))
    ) {
      // Showing it awaited (avatar fetch, page registration); if the user
      // opened this conversation meanwhile, take it straight back down.
      if (params().channelId === message.channelId && document.hasFocus())
        toastShell.clearChannel(message.channelId);
      // Never the title or body: either can carry decrypted E2EE text, and
      // console lines end up in bug reports.
      console.info(
        `[notification] ${channel.type} ${toastSurface} body=${preview.showBody}`,
      );
      return;
    }

    // The toast attempt awaited (avatar fetch, page registration). If the
    // account changed meanwhile, this notification belongs to someone who is
    // no longer signed in: drop it rather than hand it to the OS.
    if (slogaToast && client()?.user?.id !== us.id) return;

    // Refused (Focus Assist, a fullscreen app, a presentation), so the OS
    // draws it after all. Decided again for that surface: an encrypted
    // message must fall back to sender-only, not carry the text the Sloga
    // toast was allowed into the OS store.
    const osPreview = slogaToast ? decide("os_toast") : preview;
    if (!osPreview.show) return;

    // Showing the toast may have taken a moment; the user may be reading.
    if (
      slogaToast &&
      params().channelId === message.channelId &&
      document.hasFocus()
    )
      return;

    console.info(`[notification] ${channel.type} body=${osPreview.showBody}`);

    showNotification({
      title: titleFor(osPreview)!,
      icon,
      image: osPreview.showImage ? image : undefined,
      body: osPreview.showBody ? body : undefined,
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

    // Outgoing leg: our own join OPENING the call means we are ringing peers
    // — give the caller the audible feedback the callee already gets. Any
    // other membership change we are part of stops the ring (answered, or we
    // joined an ongoing call). Unlike the incoming leg below there is no
    // native ringer for outgoing calls, so this is not gated on
    // Capacitor.isNativePlatform(). Nobody-answers/decline needs no timer:
    // the synthesized ringtone ends itself after 30 rings.
    const ringAction = outgoingRingOnVoiceJoin({
      channelType: channel.type,
      joinerIsSelf: userId === us.id,
      selfIsParticipant: channel.voiceParticipants.has(us.id),
      participantCount: channel.voiceParticipants.size,
    });
    if (ringAction === "play") {
      // false = the user disabled the outgoing ringtone; still enforce the
      // old invariant that our own join silences any ring already playing
      // (e.g. another channel's incoming ring we walked away from).
      if (!sound.playSound("ringtoneOutgoing")) sound.stopRingtone();
    } else if (ringAction === "stop") sound.stopRingtone();

    // We answered (or started) the call — dismiss any ringing popup
    if (userId === us.id) {
      dismissIncomingCall(channel.id);
      return;
    }

    // Never ring if we're already in this call (e.g. the other side answering)
    if (channel.voiceParticipants.has(us.id)) return;

    // Only ring when the call STARTS (the joiner is the sole participant);
    // later joiners of an ongoing group call shouldn't re-ring us
    if (channel.voiceParticipants.size !== 1) return;

    const callerUser = client().users.get(userId);
    const callerName =
      callerUser?.displayName ?? callerUser?.username ?? "Someone";
    const channelName = channel.type === "Group" ? channel.name : callerName;

    // Android rings through the native call notification, which is the only
    // source that also works while the app is asleep or killed. Playing the
    // web ringtone as well put two ringtones on top of each other, and the
    // web one is unstoppable from the notification's Decline button. The
    // Google-free build has that native ring only once UnifiedPush is
    // registered; until then nothing else rings, so it plays the web one.
    if (playsWebRingtone(pushProvider(), unifiedPushRegistered()))
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
  function onVoiceChannelLeave(channel: Channel, userId: string) {
    if (channel.type !== "DirectMessage" && channel.type !== "Group") return;

    // Outgoing leg: our own leave is the caller cancelling (or a server-side
    // removal) — the local disconnect() also stops the ring, but that path
    // never runs when the removal originates remotely.
    const ringAction = outgoingRingOnVoiceLeave({
      channelType: channel.type,
      leaverIsSelf: userId === client().user!.id,
    });
    if (ringAction === "stop") sound.stopRingtone();

    if (channel.voiceParticipants.size === 0) {
      sound.stopRingtone();
      dismissIncomingCall(channel.id);
    }
  }

  /**
   * A friend's linked channel flipped offline→live: notify. The backend
   * push covers closed/offline clients; the shared tag dedupes the two on
   * web. Never fires for non-friends (server members only get the badge).
   */
  function onFriendWentLive(user: User, previousUser: HydratedUser) {
    if (user.relationship !== "Friend") return;

    const nowLive = user.liveConnections[0];
    if (!nowLive) return;
    const wasLive = (previousUser.connections ?? []).some(
      (connection) => connection.live,
    );
    if (wasLive) return;

    sound.playSound("message");

    if (
      notificationPermissionGranted() &&
      state.settings.desktopNotificationsState === "allowed" &&
      !notificationsSuppressed()
    ) {
      const channelUrl = connectionUrl(nowLive);

      showNotification({
        title: t`${user.displayName ?? user.username} is live on ${nowLive.platform}`,
        body: nowLive.live_title ?? nowLive.display_name,
        icon: user.animatedAvatarURL ?? user.avatarURL,
        tag: `friend-live-${user.id}`,
        onClick: () => {
          window.open(channelUrl, "_blank");
        },
      });
    }
  }

  /**
   * Handle friend requests — fires when a user's relationship changes to Incoming
   */
  function onUserUpdate(user: User, previousUser: HydratedUser) {
    onFriendWentLive(user, previousUser);

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

  // Desktop toast clicks are handled by ShellBridgeWorker, over a channel only
  // the shell can write to.

  // Native app: notification taps (open message / answer call) navigate here
  onMount(() => {
    if (!Capacitor.isNativePlatform()) return;

    const handleAction = (
      path?: string | null,
      answer?: boolean,
      ring?: boolean,
      callerId?: string | null,
    ) => {
      if (!path) return;
      navigate(path);
      if (!answer && !ring) return;

      const channelId = path.split("/").pop();
      // Cold start: the client may still be connecting, so retry until the
      // channel is hydrated (~10s) before giving up.
      const withChannel = (fn: (channel: Channel) => void, attempt = 0) => {
        const channel = channelId
          ? client().channels.get(channelId)
          : undefined;
        if (channel) fn(channel);
        else if (attempt < 20)
          setTimeout(() => withChannel(fn, attempt + 1), 500);
      };

      if (answer) {
        // Explicit "Answer" action button — the ONLY path that joins directly.
        withChannel((channel) => voice.connect(channel).catch(console.error));
        return;
      }

      // Ring: the notification was opened (or Android auto-launched the
      // full-screen intent because the screen was off/locked). Show the
      // Accept/Decline popup — NEVER auto-join.
      withChannel((channel) => {
        presentIncomingCall({
          channel,
          caller: callerId ? client().users.get(callerId) : undefined,
          receivedAt: Date.now(),
        });
        // The native notification stays up (and keeps ringing) until the popup
        // is resolved, so don't stack a second ringtone on top of it here.
      });
    };

    /**
     * The Decline action on the native notification. Cancelling the
     * notification silences the system ringtone, but nothing else tells the
     * web layer the call is over — the popup would stay on screen (and, on
     * shells that ring in-app, keep ringing) until its 45s timer fired.
     */
    const handleDeclined = (channelId?: string | null) => {
      sound.stopRingtone();
      dismissIncomingCall(channelId ?? undefined);
    };

    // Cold start: consume the action stored before the web app was ready
    registerPlugin<{
      consumeLaunchAction(): Promise<{
        path?: string | null;
        answer: boolean;
        ring?: boolean;
        callerId?: string | null;
      }>;
    }>("PushToken")
      .consumeLaunchAction()
      .then(({ path, answer, ring, callerId }) =>
        handleAction(path, answer, ring, callerId),
      )
      .catch(() => {});

    // Warm app: actions arrive as window events. Capacitor's
    // triggerWindowJSEvent delivers the payload by copying each field of the
    // data object DIRECTLY onto the dispatched event (native-bridge.js
    // `createEvent`: `ev[i] = eventData[i]`), so the values live at
    // `event.path` / `event.answer` — NOT under `event.detail`. Reading
    // `.detail` (as this did) always parsed `"{}"`, so a warm/backgrounded
    // "Answer" tap silently did nothing. Read the fields off the event; keep
    // a `.detail` JSON fallback in case a shell ever delivers it that way.
    const onAction = (event: Event) => {
      const e = event as Event & {
        path?: unknown;
        answer?: unknown;
        ring?: unknown;
        callerId?: unknown;
        declined?: unknown;
        channelId?: unknown;
        detail?: string | null;
      };
      // Declines carry no path, so they must be handled before handleAction's
      // `if (!path) return`.
      if (e.declined === true) {
        handleDeclined(
          typeof e.channelId === "string" ? e.channelId : undefined,
        );
        return;
      }
      if (typeof e.path === "string") {
        handleAction(
          e.path,
          e.answer === true,
          e.ring === true,
          typeof e.callerId === "string" ? e.callerId : undefined,
        );
        return;
      }
      try {
        const data = JSON.parse(e.detail ?? "{}");
        if (data.declined) {
          handleDeclined(data.channelId);
          return;
        }
        handleAction(data.path, data.answer, data.ring, data.callerId);
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
   * Reading a conversation retires its notifications: our own toasts for it
   * and whatever the OS still holds for it in Action Center. "Reading" is the
   * test onMessage uses to skip a notification, the channel open in a focused
   * window. `document.hasFocus()` is not reactive, hence the signal; the
   * effect re-runs only when the focus or the open channel changes, never per
   * message.
   */
  const [windowFocused, setWindowFocused] = createSignal(document.hasFocus());
  const onWindowFocus = () => setWindowFocused(true);
  const onWindowBlur = () => setWindowFocused(false);
  window.addEventListener("focus", onWindowFocus);
  window.addEventListener("blur", onWindowBlur);
  onCleanup(() => {
    window.removeEventListener("focus", onWindowFocus);
    window.removeEventListener("blur", onWindowBlur);
  });

  createEffect(() => {
    const channelId = params().channelId;
    // Untracked: nothing the shell reads may re-run this effect.
    if (channelId && windowFocused())
      untrack(() => toastShell.clearChannel(channelId));
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

  /**
   * Publish the unread total to the OS — the taskbar button on Windows, the
   * dock on macOS, the launcher entry on Linux, the tab title everywhere.
   *
   * It lives in this component because this is the one that already means "the
   * signed-in app's background work", and because it must mount exactly once:
   * the friends popout and the voice overlay are separate windows with their
   * own documents, and a second publisher racing this one would leave whichever
   * wrote last on the taskbar.
   *
   * Nothing is throttled. The effect only re-runs when an unread total the rail
   * already tracks actually changes, and `sameBadge` drops the repaints where
   * the number did not move — a message arriving in an already-unread channel
   * with no count from the server is the common case, and it must not repaint.
   */
  let published: UnreadBadge = { count: 0, mention: false };
  createEffect(() => {
    const c = client();
    const badge = c
      ? unreadBadge({
          servers: state.ordering.orderedServers(c),
          conversations: state.ordering.orderedConversations(c),
          isServerMuted: (server) => state.notifications.isMuted(server),
        })
      : { count: 0, mention: false };

    if (sameBadge(badge, published)) return;
    published = badge;
    publishUnreadBadge(badge);
  });

  onCleanup(() => {
    // Signing out unmounts this; the count belongs to the session, so it must
    // not outlive it on the taskbar.
    if (published.count !== 0) {
      published = { count: 0, mention: false };
      publishUnreadBadge(published);
    }
  });

  let resyncRetryTimer: number | undefined;

  onMount(() => {
    document.addEventListener("click", tryRequest);
    document.addEventListener("visibilitychange", onVisibilityChange);
    // Web push and UnifiedPush re-sync from the configured-client effect
    // below instead.
    if (isWebPushPlatform() || pushProvider() === "unifiedpush") return;
    // Native app: heal the FCM subscription on every logged-in launch — a
    // session whose subscription was lost otherwise never rings again. One
    // delayed retry covers the client/session not being ready yet at mount.
    resyncPushSubscription().then((ok) => {
      if (!ok) {
        resyncRetryTimer = window.setTimeout(
          () => resyncPushSubscription(),
          15_000,
        );
      }
    });
  });

  onCleanup(() => {
    document.removeEventListener("click", tryRequest);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.clearTimeout(resyncRetryTimer);
  });

  /**
   * Web push: heal the browser subscription once per launch, as soon as the
   * client has fetched the server configuration. The subscription has to
   * match the VAPID key advertised there, so the mount-time resync above runs
   * too early whenever that fetch is still in flight, and its single 15 s
   * retry is no guarantee either. The Google-free (foss) build's UnifiedPush
   * re-sync runs here too, for the same reason: it registers with that key.
   * FCM builds are covered by the mount-time call and its retry.
   */
  let webResyncStarted = false;
  let disposed = false;

  /**
   * Safari refuses subscribe() outside a user gesture, so a launch resync that
   * needs a new subscription fails there. Retry it once on the next click, the
   * same way tryRequest defers the permission prompt.
   */
  function retryWebResyncOnClick() {
    document.removeEventListener("click", retryWebResyncOnClick);
    resyncPushSubscription();
  }

  createEffect(() => {
    if (
      webResyncStarted ||
      !(isWebPushPlatform() || pushProvider() === "unifiedpush")
    )
      return;
    const c = client();
    if (!c?.configured()) return;
    webResyncStarted = true;
    resyncPushSubscription().then(() => {
      if (!disposed && retryWebPushOnGesture()) {
        document.addEventListener("click", retryWebResyncOnClick);
      }
    });
  });

  onCleanup(() => {
    disposed = true;
    document.removeEventListener("click", retryWebResyncOnClick);
  });

  return null;
}
