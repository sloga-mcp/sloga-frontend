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
  type Client,
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
  type IncomingCall,
  deviceLocked,
  dismissIncomingCall,
  incomingCall,
  outgoingRingOnVoiceJoin,
  outgoingRingOnVoiceLeave,
  presentIncomingCall,
  ringDurationMs,
  useVoice,
} from "@revolt/rtc";
import {
  type NativeRingPending,
  nativeRingPending,
  setNativeRingPending,
} from "@revolt/rtc/incomingCall";
import { serverCallRingSecs } from "@revolt/rtc/serverRingLength";
import { useState } from "@revolt/state";
import { streamerModeActive, streamerModeHides } from "@revolt/state/streamer";
import { useSnackbar } from "@revolt/ui/components/design/Snackbar";

import { useClient, useClientLifecycle, useNotifications, useSound } from ".";
import { routeConversation } from "../chatWindows/openConversation";
import { State } from "./Controller";
import {
  isWebPushPlatform,
  pushProvider,
  resyncPushPrefs,
  unifiedPushRegistered,
} from "./NotificationsController";
import type { E2EEBridge } from "./e2ee";
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
import { notificationCopy, toastCopy } from "./protectedCopy";
import type { ProtectedToastKind } from "./protectedTextTypes";
import { webRingtoneAllowed } from "./pushPolicy";
import { slimAllowsChannel, slimRedirectFor } from "./slimRoutePolicy";
import { connectionUrl } from "./streamConnections";
import { toastSurfaceFor } from "./toastPolicy";
import { toastSupported, useToastShell } from "./toastShell";
import { type UnreadBadge, sameBadge, unreadBadge } from "./unreadBadge";
import { publishUnreadBadge } from "./unreadBadgeShell";
import { useSlimMode } from "./useSlimMode";
import { isViewingConversation } from "./viewingConversation";
import { focusedConversations } from "./windowCtx";

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
 * Whether a message is a Protected channel row (plan D25): it carries
 * `encrypted`, or its channel is protected or pinned on the client that
 * received it. stoat.js strips the server text from such rows already; the
 * notification never reads it either way.
 *
 * Run by `protectedNotifications.scan.test.ts` with its types stripped: keep
 * it to erasable TypeScript (no enums, no parameter properties).
 * @param message Message
 * @param client The client that received it
 * @returns Whether it is a Protected channel row
 */
function isProtectedRow(message: Message, client: Client): boolean {
  return (
    message.encrypted !== undefined ||
    client.isProtectedChannel(message.channelId)
  );
}

/**
 * Toast times already shown, per bridge and map key. At module scope, so a
 * remounted worker does not show the same entry again; per bridge, so a new
 * session starts clear.
 */
const shownProtectedToasts = new WeakMap<object, Map<string, number>>();

/**
 * The entries of the bridge's `protectedToast` map not shown yet, recorded
 * as shown. An entry is new when its `at` differs from the one last shown
 * under its key.
 *
 * Run by `protectedNotifications.scan.test.ts` with its types stripped: keep
 * it to erasable TypeScript (no enums, no parameter properties).
 * @param shown Times already shown, by key (updated)
 * @param entries The map's entries
 * @returns The kinds to show, in map order
 */
function takeNewProtectedToasts(
  shown: Map<string, number>,
  entries: Iterable<[string, { kind: ProtectedToastKind; at: number }]>,
): ProtectedToastKind[] {
  const fresh: ProtectedToastKind[] = [];
  for (const [key, entry] of entries) {
    if (shown.get(key) === entry.at) continue;
    shown.set(key, entry.at);
    fresh.push(entry.kind);
  }
  return fresh;
}

/**
 * Whether a protected toast is an alert (plan D22: the blocked invitation is
 * a red toast). The house snackbar has no tone, so an alert gets a close
 * button and stays up longer instead.
 * @param kind Toast kind
 * @returns Whether it is an alert
 */
function protectedToastIsAlert(kind: ProtectedToastKind): boolean {
  switch (kind) {
    case "unsolicited_welcome":
      return true;
    default: {
      const _exhaustive: never = kind;
      return true;
    }
  }
}

/** What a tapped native notification asks the web layer to do. */
type NativeAction = {
  /** In-app path of the chat the notification belongs to */
  path: string;
  /** The Answer button was pressed */
  answer: boolean;
  /** The ring was opened, so the Accept and Decline popup is wanted */
  ring: boolean;
  /** User who started the call, when the notification named one */
  callerId?: string;
  /** Id of the call, when the notification carried one */
  callId?: string;
  /** Whether the caller started it as a video call, when known */
  video?: boolean;
  /**
   * Whether the lock screen was up when the phone handled the tap. This is
   * what the phone saw then, not what is true now, so it never decides
   * whether a call is answered.
   */
  locked?: boolean;
};

/** Where a native notification action reached the web layer from. */
type NativeActionSource = "event" | "launch";

/**
 * Read a notification action the native layer handed over, from the launch
 * slot or from a window event. Each field counts only as the exact type the
 * bridge sends. `answer` and `ring` are on only when they are `true`, so a
 * malformed value can open a chat at most and can never answer a call.
 * Without a path there is no action.
 *
 * Kept to erasable TypeScript (no enums, no parameter properties), so a spec
 * can run it with its types stripped.
 * @param raw The launch slot's answer, or the event that carried the fields
 * @returns The action, or nothing when there is none
 */
function readNativeAction(raw: unknown): NativeAction | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const fields = raw as Record<string, unknown>;
  if (typeof fields.path !== "string" || !fields.path) return undefined;
  const action: NativeAction = {
    path: fields.path,
    answer: fields.answer === true,
    ring: fields.ring === true,
  };
  if (typeof fields.callerId === "string" && fields.callerId)
    action.callerId = fields.callerId;
  if (typeof fields.callId === "string" && fields.callId)
    action.callId = fields.callId;
  if (typeof fields.video === "boolean") action.video = fields.video;
  if (typeof fields.locked === "boolean") action.locked = fields.locked;
  return action;
}

/**
 * How long an action taken from one source blocks the same action arriving
 * from the other one.
 */
const NATIVE_ACTION_REPEAT_MS = 5_000;

/**
 * Native notification actions already taken, by source and identity, with
 * the time each was taken. At module scope, so a remounted worker shares it.
 */
const takenNativeActions = new Map<string, number>();

/**
 * Whether to act on a native notification action, recording it when so.
 *
 * The phone both parks an action in the launch slot and sends it as a window
 * event, so a worker that mounts just as one arrives can be handed the same
 * action twice, once from each source. The second copy is refused here: an
 * action is not taken when the same one (same chat, same call, same buttons)
 * was taken from the other source moments ago. A taken action refuses one
 * copy only, and the same action twice from one source is never a copy, so
 * pressing the same button again is always acted on.
 *
 * Kept to erasable TypeScript (no enums, no parameter properties), so a spec
 * can run it with its types stripped.
 * @param taken Actions already taken (updated)
 * @param source Where this one arrived from
 * @param action The action
 * @param now A monotonic time in milliseconds
 * @returns Whether to act on it
 */
function takeNativeAction(
  taken: Map<string, number>,
  source: NativeActionSource,
  action: NativeAction,
  now: number,
): boolean {
  for (const [key, at] of taken) {
    if (!(now - at < NATIVE_ACTION_REPEAT_MS)) taken.delete(key);
  }
  const identity = JSON.stringify([
    action.path,
    action.answer,
    action.ring,
    action.callId ?? null,
  ]);
  const other: NativeActionSource = source === "event" ? "launch" : "event";
  if (taken.delete(`${other}:${identity}`)) return false;
  taken.set(`${source}:${identity}`, now);
  return true;
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
  const snackbar = useSnackbar();
  const { lifecycle } = useClientLifecycle();
  // Whether Slim view is active on this device. Reactive, and read at each
  // decision below: the user can switch it while this worker is mounted.
  const slim = useSlimMode();

  /** The native bridge of the current client, where this shell has one. */
  const bridge = () => client()?.e2ee as E2EEBridge | undefined;

  // Signing out ends the Protected channel manager (W4b audit M3). The
  // lifecycle builds a new client and bridge for the next session, so
  // nothing else stops the old manager's timers and courier loops. The hook
  // fires while the old client is still current; `disposeProtected` is
  // idempotent and final for that bridge.
  onCleanup(lifecycle.onSignOut(() => bridge()?.disposeProtected?.()));

  // The draft store's protected wiring (resolver, outbox keys) follows the
  // current client. This worker mounts once per signed-in session, and
  // `bindClient` is idempotent per client, rebinding when it changes.
  createEffect(() => {
    const c = client();
    if (c) untrack(() => state.draft.bindClient(c));
  });

  // Protected channel toasts (plan D22): the bridge's `protectedToast` map
  // holds the manager's latest toast, a kind and a time, never content.
  // Each new entry shows once, through the app's snackbar.
  createEffect(() => {
    const e2ee = bridge();
    const toasts = e2ee?.protectedToast;
    if (!e2ee || !toasts) return;
    let shown = shownProtectedToasts.get(e2ee);
    if (!shown) {
      shown = new Map();
      shownProtectedToasts.set(e2ee, shown);
    }
    const fresh = takeNewProtectedToasts(shown, toasts.entries());
    untrack(() => {
      for (const kind of fresh) {
        const alert = protectedToastIsAlert(kind);
        snackbar.show({
          message: toastCopy(kind),
          closeable: alert,
          autoCloseDelay: alert ? 10_000 : undefined,
        });
      }
    });
  });

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

  // Post the push preferences again when Slim view, the ring setting or the
  // signed-in user's loaded state changes. `resyncPushPrefs` reads all three
  // before its first await, so this effect re-runs on each of them. It never
  // rejects, and posts nothing until this device has a subscription.
  createEffect(() => void resyncPushPrefs());

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
   * failed lookup is "unknown", never a guess. The lookup never runs the
   * group plaintext proof: its device listings would tell the server when
   * this device saw a message, and an unconfirmed group notifies normally.
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
      return cached ?? (await e2ee.sendModeNowFor(channel, { proof: false }));
    } catch {
      return "unknown";
    }
  }

  /**
   * Whether the user is reading this conversation now: open in the focused
   * main window, or in a chat window that holds focus. A point-in-time read
   * (`document.hasFocus()` is not reactive), so call it at each decision.
   */
  const isViewing = (channelId: string) =>
    isViewingConversation(channelId, {
      routeChannelId: params().channelId,
      mainFocused: document.hasFocus(),
      chatWindowConversations: focusedConversations(),
    });

  /**
   * Where a tapped notification goes. Slim view shows no server surface, so
   * a path it blocks lands on the chat list instead. A `/channel/:id` path is
   * left alone: the channel page redirects a server channel itself. Asked at
   * the tap, since Slim view may have been switched after the notification
   * was raised.
   */
  const tapTarget = (path: string) => {
    if (!slim()) return path;
    return slimRedirectFor(path) ?? path;
  };

  /**
   * When a ring last ended here without being answered, by chat: a Decline
   * (the notification's, ours from any session, the popup's) or the ring
   * coming down while we are not in that call. The voice store reports an
   * Answer cancelled by our own Decline as "failed", so a notification
   * Answer that failed brings the popup back only if nothing is recorded
   * for its chat since the tap.
   */
  const ringOverAt = new Map<string, number>();
  const noteRingOver = (channelId?: string) => {
    if (channelId) ringOverAt.set(channelId, Date.now());
  };

  /**
   * A chat a call notification asked to open that is not open yet, because
   * the phone was, or may have been, locked. One at a time: a newer tap
   * replaces it (`pendingSeq` counts the taps). It never outlives the ring
   * that parked it: it is dropped when that ring is declined or ends without
   * being answered here, and silently at `until`, the ring length after the
   * tap. Only the native app parks one.
   */
  let pendingOpen:
    | { channelId?: string; until: number; open: () => void }
    | undefined;
  let pendingSeq = 0;

  /**
   * Drop the pending chat if it is the one for `channelId`, or whichever it
   * is when no chat is named. Its ring is over, so the cover of a native
   * ring still waiting to be presented for that chat goes too.
   */
  const dropPendingOpen = (channelId?: string) => {
    if (pendingOpen && (!channelId || pendingOpen.channelId === channelId))
      pendingOpen = undefined;
    const ringCover = nativeRingPending();
    if (ringCover && (!channelId || ringCover.channelId === channelId))
      setNativeRingPending(undefined);
  };

  /**
   * Handle incoming messages
   * @param message Message
   */
  async function onMessage(message: Message) {
    const us = client().user!;
    // The client this message arrived on, held across the awaits below.
    const receiver = client();

    // Ephemeral interaction responses are the bot answering something this
    // user just did — never worth a notification (and never persisted)
    if (message.isEphemeral) return;

    // Silent sends ("@silent ", flag mask 1) skip the popup and the sound.
    // The server already skips push for them, and an online user gets no
    // push at all, so this popup would be the only alert they see. The
    // unread and mention badges still update through stoat.js.
    if (message.isSuppressed) return;

    // Ignore if we are currently looking at the channel
    if (isViewing(message.channelId)) return;

    // Ignore our own messages
    if (message.author?.self) return;

    // Ignore blocked users
    if (message.author?.relationship === "Blocked") return;

    // A message can arrive for a channel this client no longer has, such as
    // a thread of a server we just left, which stoat.js has swept from the
    // cache. There is nothing to notify about without the channel.
    if (!message.channel) return;

    // Slim view shows no servers, so a server message is not announced here:
    // no sound, no toast and no notification. Only this presentation is
    // skipped. The message and its unread state are untouched, and DMs and
    // groups (which is where system and official messages arrive) go on.
    if (slim() && !slimAllowsChannel(message.channel)) return;

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
    if (isViewing(message.channelId)) return;

    // Held from here on: the toast below is awaited, and stoat.js may sweep
    // the channel from the cache meanwhile.
    const channel = message.channel;
    if (channel.type === "SavedMessages") return;

    // A Protected channel row is announced like an encrypted one (plan D25):
    // never its server text, attachments or embeds, and never its decrypted
    // text either, since the OS keeps what it draws. The body is fixed copy.
    // Decided after the awaits: a channel only ever becomes protected.
    const protectedRow = isProtectedRow(message, receiver);

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
      // A protected row keeps its fixed body, but no image and no reply.
      // Quick replies are only offered in DMs and groups, which are never
      // protected; this fails closed if that ever changes.
      if (protectedRow) {
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
    const image = protectedRow
      ? undefined
      : message.attachments?.find((x) => x.metadata.type === "Image")
          ?.previewUrl;

    // Find body/icon
    let body, icon;
    if (protectedRow) {
      body = notificationCopy.body();
      icon = message.avatarURL;
    } else if (message.content) {
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
      if (isViewing(message.channelId))
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
    if (slogaToast && isViewing(message.channelId)) return;

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
        const openInMain = () => {
          window.focus();
          navigate(tapTarget(message.path));
        };
        // Chat-windows mode opens a DM or group as a chat-window tab; server
        // channels always open in the main window.
        if (channel.type === "DirectMessage" || channel.type === "Group")
          routeConversation(state, channel.id, openInMain);
        else openInMain();
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

    // Whether this session is the one joining or in this call. A join by our
    // own user reaches every device of the account, so the user id alone
    // cannot tell. The voice store names the channel from before its join
    // request is sent until the call is left, so the event for our own join
    // always finds it set on the device that made it.
    const joinedHere = userId === us.id && voice.channel()?.id === channel.id;

    // Outgoing leg: our own join opening the call means we are ringing
    // peers, so the caller gets the audible feedback the callee already
    // gets. Only the session that made the join rings. The account's other
    // devices are not calling anybody, and a join made by pressing Answer
    // never rings. Any other membership change we are part of stops the ring
    // (answered, or we joined an ongoing call). Unlike the incoming leg below
    // there is no native ringer for outgoing calls, so this is not gated on
    // Capacitor.isNativePlatform().
    //
    // The ring is not ended from here when nobody picks up. In a direct
    // message the voice store hangs the call up once the ring length has
    // passed, or at once when the other person declines (the server reports
    // that, see onVoiceCallDeclined), and hanging up stops the ring. A group
    // call is never hung up that way, so there the synthesized ringtone
    // stops by itself at the end of the ring length.
    const ringAction = outgoingRingOnVoiceJoin({
      channelType: channel.type,
      joinerIsSelf: joinedHere,
      selfIsParticipant: channel.voiceParticipants.has(us.id),
      participantCount: channel.voiceParticipants.size,
      joinedAsAnswer: voice.joinedAsAnswer(),
    });
    if (ringAction === "play") {
      // false = the user disabled the outgoing ringtone; still enforce the
      // old invariant that our own join silences any ring already playing
      // (e.g. another channel's incoming ring we walked away from).
      if (!sound.playSound("ringtoneOutgoing")) sound.stopRingtone();
    } else if (ringAction === "stop") sound.stopRingtone();

    // Our own user is in this call now, so a ring for it is over on every
    // device of the account: answered on the one that joined, and answered
    // elsewhere on the others.
    if (userId === us.id) {
      dismissIncomingCall(channel.id, joinedHere ? "answered" : "elsewhere");
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
    // A device set not to ring for calls plays no ringtone at all.
    if (
      webRingtoneAllowed({
        provider: pushProvider(),
        unifiedPushRegistered: unifiedPushRegistered(),
        ringCalls:
          state.settings.getValue("notifications:ring_calls") !== false,
      })
    )
      sound.playSound("ringtoneIncoming");

    // In-app ringing popup (IncomingCallOverlay) with Accept/Decline — shown
    // regardless of desktop-notification permission so calls are answerable,
    // and on a device set not to ring too, where it appears without a sound
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

    // The call is over, so its ring is too. Only the ringtone of this chat's
    // incoming ring is stopped: the one ringtone slot may be our own
    // outgoing ring for another chat.
    if (channel.voiceParticipants.size === 0) {
      if (
        incomingCall()?.channel.id === channel.id &&
        sound.ringtoneKind() === "incoming"
      )
        sound.stopRingtone();
      dismissIncomingCall(channel.id, "ended");
    }
  }

  /**
   * Someone declined a ringing call. The server sends this to every session
   * of the person who declined, and in a direct message to the other person
   * too. It can arrive twice for one decline, and nothing here minds that.
   */
  function onVoiceCallDeclined(channel: Channel, userId: string) {
    const selfId = client().user?.id;
    // Without our own id a decline cannot be told from the other person's.
    if (!selfId) return;

    // We declined, here or on another device: the ring is over on this one.
    // The ringtone stops only if it is this chat's incoming ring.
    if (userId === selfId) {
      if (
        incomingCall()?.channel.id === channel.id &&
        sound.ringtoneKind() === "incoming"
      )
        sound.stopRingtone();
      dropPendingOpen(channel.id);
      noteRingOver(channel.id);
      dismissIncomingCall(channel.id, "declined");
      return;
    }

    // The other person in a direct message declined our call. The voice
    // store decides whether that ends a call of ours. A group never reports
    // a decline to the caller, and one member declining ends nothing there.
    if (channel.type === "DirectMessage" && channel.recipientIds.has(userId))
      voice.noteCallDeclined(channel.id);
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

    // Unmounting ends whatever is still waiting below. This worker lives for
    // one signed-in session, and an action must not carry over into the next.
    // A native ring still waiting to be presented goes with it: nothing left
    // would present it or take its cover down.
    let mounted = true;
    onCleanup(() => {
      mounted = false;
      setNativeRingPending(undefined);
    });

    const pushToken = registerPlugin<{
      consumeLaunchAction(): Promise<{
        path?: string | null;
        answer: boolean;
        ring?: boolean;
        callerId?: string | null;
        callId?: string | null;
        video?: boolean;
        locked?: boolean;
      }>;
      dismissCallNotification(options: {
        channelId: string;
        reason: "ended";
      }): Promise<void>;
    }>("PushToken");

    /**
     * Open the pending chat if this app is on screen and the phone is
     * unlocked right now. The lock is asked live each time, never taken from
     * what the phone saw at the tap, and anything but a clear "unlocked"
     * keeps the chat closed, so nothing of it is drawn over the lock screen.
     * Asked again when the app becomes visible and when an Answer joined.
     * Past its time limit the pending chat is dropped without opening.
     */
    const openPendingIfUnlocked = () => {
      const pending = pendingOpen;
      if (!pending) return;
      if (!(Date.now() < pending.until)) {
        pendingOpen = undefined;
        return;
      }
      if (document.visibilityState !== "visible") return;
      deviceLocked()
        .then((locked) => {
          if (locked !== false || !mounted || pendingOpen !== pending) return;
          if (document.visibilityState !== "visible") return;
          pendingOpen = undefined;
          if (!(Date.now() < pending.until)) return;
          if (params().channelId !== pending.channelId) pending.open();
        })
        .catch(console.error);
    };

    /**
     * Park a chat to open once the phone is unlocked, for at most the ring
     * length from `from`, and try at once.
     * @returns The tap's number, to tell whether a newer tap came since
     */
    const parkOpen = (
      channelId: string | undefined,
      open: () => void,
      from: number,
    ) => {
      pendingSeq += 1;
      pendingOpen = {
        channelId,
        open,
        until: from + ringDurationMs(serverCallRingSecs()),
      };
      openPendingIfUnlocked();
      return pendingSeq;
    };

    // The pending chat goes with its ring. When the ring for it comes down
    // and we are not in that call (declined here or elsewhere, timed out,
    // the call ended, answered on another device), the chat is not opened.
    // Only a connected call counts: the voice store names the channel from
    // the start of a join, so a Decline pressed while our own Answer is
    // still connecting must still count as the ring being over.
    let ringShown: string | undefined;
    createEffect(() => {
      const shown = incomingCall()?.channel.id;
      const gone = ringShown;
      ringShown = shown;
      const inThatCall = untrack(
        () => voice.channel()?.id === gone && voice.state() === "CONNECTED",
      );
      if (gone && gone !== shown && !inThatCall) {
        dropPendingOpen(gone);
        noteRingOver(gone);
      }
    });

    document.addEventListener("visibilitychange", openPendingIfUnlocked);
    onCleanup(() =>
      document.removeEventListener("visibilitychange", openPendingIfUnlocked),
    );

    // Once the chat is open anyway (the ring popup's Accept opens it after
    // joining), there is nothing left to open: a later check must not take
    // the user back to it from wherever they went next.
    createEffect(() => {
      const routeChannelId = params().channelId;
      if (routeChannelId && pendingOpen?.channelId === routeChannelId)
        pendingOpen = undefined;
    });

    /**
     * The ring popup for a call a notification was about, with what the
     * notification said about it.
     */
    const ringFor = (
      action: NativeAction,
      channel: Channel,
      receivedAt: number,
    ): IncomingCall => {
      const call: IncomingCall = {
        channel,
        caller: action.callerId
          ? client().users.get(action.callerId)
          : undefined,
        receivedAt,
      };
      if (action.callId) call.callId = action.callId;
      if (action.video !== undefined) call.video = action.video;
      return call;
    };

    /**
     * An Answer from the notification that did not get into the call: bring
     * the ring popup back for it while its ring is still running, so the
     * user can try again or decline. The ring is counted from the tap, the
     * earliest this layer knows of it. A popup already up (for this call or
     * another one) is left alone, and a ring that was declined or ended
     * since the tap is not brought back.
     */
    const ringAgain = (
      action: NativeAction,
      channel: Channel,
      tappedAt: number,
    ) => {
      if (!mounted || incomingCall()) return;
      if ((ringOverAt.get(channel.id) ?? -Infinity) >= tappedAt) return;
      const elapsed = Date.now() - tappedAt;
      if (!(elapsed >= 0 && elapsed < ringDurationMs(serverCallRingSecs())))
        return;
      presentIncomingCall(ringFor(action, channel, tappedAt));
    };

    const handleAction = (action: NativeAction) => {
      const path = action.path;
      // Only where the tap lands changes in Slim view. The call handling
      // below still reads the path the notification carried.
      const open = () => navigate(tapTarget(path));
      const tappedAt = Date.now();

      const channelId = path.split("/").pop();
      // Cold start: the client may still be connecting, so retry until the
      // channel is hydrated (~10s) before giving up. `settled` holds the
      // call back further, while it says no, but never past that time.
      // `gaveUp` runs once if the channel never loads.
      const withChannel = (
        fn: (channel: Channel) => void,
        settled: () => boolean = () => true,
        gaveUp: () => void = () => {},
        attempt = 0,
      ) => {
        if (!mounted) return;
        const channel = channelId
          ? client()?.channels.get(channelId)
          : undefined;
        if (channel && (settled() || attempt >= 20)) fn(channel);
        else if (attempt < 20)
          setTimeout(() => withChannel(fn, settled, gaveUp, attempt + 1), 500);
        else gaveUp();
      };

      if (action.answer) {
        // The Answer button. Answering belongs to the voice store alone: it
        // asks the phone whether it is locked at that moment, has it
        // unlocked if so, joins, and says how that went. Nothing here joins
        // a call any other way. The chat opens now only if the phone is
        // unlocked now, asked live (`locked` is only what the phone saw when
        // it handled the tap); otherwise once the call is joined, or later
        // when the app is on screen with the phone unlocked. A channel that
        // never loads is never answered. Joined after the pending chat's time
        // ran out (unlocking can take a minute), it is parked once more from
        // the join, unless a newer tap came meanwhile. An ended call drops it.
        const parked = parkOpen(channelId, open, tappedAt);
        withChannel((channel) => {
          voice
            .answerCall(channel)
            .then((result) => {
              if (!mounted) return;
              if (result === "joined") {
                if (pendingSeq === parked)
                  parkOpen(channelId, open, Date.now());
              } else if (result === "ended") dropPendingOpen(channelId);
              else if (result === "failed" || result === "blocked")
                ringAgain(action, channel, tappedAt);
            })
            .catch(console.error);
        });
        return;
      }

      // A plain tap opens its chat now, and a chat an earlier call tap left
      // pending must not be opened over it later.
      if (!action.ring) {
        pendingSeq += 1;
        pendingOpen = undefined;
        open();
        return;
      }

      // Ring: the notification was opened (or Android auto-launched the
      // full-screen intent because the screen was off/locked). Show the
      // Accept/Decline popup — NEVER auto-join. The chat behind it opens
      // only once the phone is unlocked, asked live: the popup can be over
      // the lock screen.
      //
      // The phone shows the app over its lock screen from the moment the
      // ring arrived, but the popup can only be presented once the chat has
      // loaded, which on a sleeping phone waits for the websocket. Until
      // then the overlay covers the screen (who is calling, no buttons), so
      // the chat that was last open is never drawn over the lock screen. It
      // is set here, before anything waits, because nothing has said yet
      // that the phone is unlocked. It goes when the popup is presented or
      // the ring ends without one, and early only if both the phone's tap
      // snapshot and a live answer say unlocked. It never opens anything.
      const ringCover: NativeRingPending | undefined = channelId
        ? { channelId }
        : undefined;
      if (ringCover && action.callerId) ringCover.callerId = action.callerId;
      if (ringCover) setNativeRingPending(ringCover);
      const dropRingCover = () => {
        if (nativeRingPending() === ringCover) setNativeRingPending(undefined);
      };
      if (ringCover && action.locked === false) {
        deviceLocked()
          .then((locked) => {
            if (locked === false) dropRingCover();
          })
          .catch(() => {});
      }

      parkOpen(channelId, open, tappedAt);

      // Whether a Ready reaches the client after this tap. Only a Ready says
      // for sure who is in a call (a client that was connected all along may
      // have missed a join), so only then does an empty call count as over.
      // The lifecycle enters Connected on the client's Ready alone.
      const awaitsReady = lifecycle.state() !== State.Connected;
      const rosterFresh = () =>
        awaitsReady && lifecycle.state() === State.Connected;
      const settled = () => !awaitsReady || rosterFresh();

      const presentOrEnd = (channel: Channel) => {
        // Nobody is in the call any more (cold start, so it was asked after
        // the tap): the ring is over. No popup; the phone's ring notification
        // is resolved as ended, which also lets the app fall back behind the
        // lock screen. A popup the websocket raised for it goes the same way.
        if (rosterFresh() && channel.voiceParticipants.size === 0) {
          if (incomingCall()?.channel.id === channel.id) {
            if (sound.ringtoneKind() === "incoming") sound.stopRingtone();
            dismissIncomingCall(channel.id, "ended");
          } else {
            pushToken
              .dismissCallNotification({
                channelId: channel.id,
                reason: "ended",
              })
              .catch(() => {});
          }
          dropPendingOpen(channel.id);
          return;
        }
        presentIncomingCall(ringFor(action, channel, Date.now()));
        // The native notification stays up (and keeps ringing) until the popup
        // is resolved, so don't stack a second ringtone on top of it here.
      };
      withChannel(presentOrEnd, settled, dropRingCover);
    };

    /**
     * Act on an action from one of the two native sources, unless the other
     * source has just delivered the same one.
     */
    const deliver = (source: NativeActionSource, action: NativeAction) => {
      if (
        takeNativeAction(takenNativeActions, source, action, performance.now())
      )
        handleAction(action);
    };

    /**
     * The Decline action on the native notification. The phone has already
     * told the server and cancelled its notification, which silences the
     * system ringtone, but nothing else tells the web layer the call is
     * over: the popup would stay on screen (and, on shells that ring in-app,
     * keep ringing) until the ring length ran out. The voice store declines
     * again, which the server ignores, and takes the ring down as declined.
     * A chat this client does not have cannot be declined through the store,
     * so only its ring is taken down. The ringtone stops only when it is
     * the incoming ring being taken down, never our own outgoing ring.
     */
    const handleDeclined = (channelId?: string | null) => {
      const ringing = incomingCall();
      if (
        ringing &&
        (!channelId || ringing.channel.id === channelId) &&
        sound.ringtoneKind() === "incoming"
      )
        sound.stopRingtone();
      dropPendingOpen(channelId ?? undefined);
      noteRingOver(channelId ?? ringing?.channel.id);
      const channel = channelId ? client()?.channels.get(channelId) : undefined;
      if (channel) voice.declineCall(channel).catch(console.error);
      else dismissIncomingCall(channelId ?? undefined, "declined");
    };

    // Cold start: consume the action stored before the web app was ready.
    // An action older than a minute arrives without its answer or ring, and
    // then only opens the chat.
    pushToken
      .consumeLaunchAction()
      .then((parked) => {
        const action = readNativeAction(parked);
        if (action) deliver("launch", action);
      })
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
        declined?: unknown;
        channelId?: unknown;
        detail?: string | null;
      };
      // Declines carry no path, so they are handled before anything reads
      // one.
      if (e.declined === true) {
        handleDeclined(
          typeof e.channelId === "string" ? e.channelId : undefined,
        );
        return;
      }
      let action = readNativeAction(e);
      if (!action) {
        try {
          const data = JSON.parse(e.detail ?? "{}");
          if (data.declined) {
            handleDeclined(
              typeof data.channelId === "string" ? data.channelId : undefined,
            );
            return;
          }
          action = readNativeAction(data);
        } catch {
          /* ignore malformed payloads */
        }
      }
      if (!action) return;
      try {
        deliver("event", action);
      } finally {
        // The phone parked this same action in the launch slot as well as
        // sending it here. Empty the slot, so a later remount or page reload
        // does not read the action again and answer a call a second time.
        // The answer is thrown away: an action that was parked meanwhile
        // has its own event on the way.
        pushToken.consumeLaunchAction().catch(() => {});
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
    client().addListener("voiceCallDeclined", onVoiceCallDeclined);
    client().addListener("userUpdate", onUserUpdate);
    client().addListener("reportCreate", onReport);
    onCleanup(() => {
      client().removeListener("messageCreate", onMessage);
      client().removeListener("voiceChannelJoin", onVoiceChannelJoin);
      client().removeListener("voiceChannelLeave", onVoiceChannelLeave);
      client().removeListener("voiceCallDeclined", onVoiceCallDeclined);
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

  // The same for a conversation in a focused chat window. That set is a
  // signal already, and only republished when its contents change.
  createEffect(() => {
    const channelIds = focusedConversations();
    untrack(() => {
      for (const channelId of channelIds) toastShell.clearChannel(channelId);
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
