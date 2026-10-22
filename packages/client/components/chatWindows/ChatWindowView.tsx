import {
  Match,
  Show,
  Switch,
  createEffect,
  createSignal,
  on,
  onCleanup,
} from "solid-js";

import { Plural, useLingui } from "@lingui-solid/solid/macro";
import type { Channel } from "stoat.js";
import { cva } from "styled-system/css";
import { decodeTime, ulid } from "ulid";

import {
  DraftMessages,
  Messages,
  ScheduledMessagesBar,
  UserContextMenu,
} from "@revolt/app";
import { FriendContextMenu } from "@revolt/app/menus/FriendContextMenu";
import { useClient } from "@revolt/client";
import * as chatShell from "@revolt/client/chatShell";
import type { E2EEBadge } from "@revolt/client/e2eeBadge";
import { type PopoutAction, useUserActions } from "@revolt/client/popoutBridge";
import { useConversationE2EE } from "@revolt/client/useConversationE2EE";
import { setFocusedConversation, useWindowCtx } from "@revolt/client/windowCtx";
import { CONFIGURATION } from "@revolt/common";
import { TextWithEmoji } from "@revolt/markdown";
import { useModals } from "@revolt/modal";
import { useNavigate } from "@revolt/routing";
import { nativeScreenShareAvailable, useVoice } from "@revolt/rtc";
import {
  Avatar,
  IconButton,
  OverflowingText,
  TypingIndicator,
  UserStatus,
  isSlogaStaff,
  usePresenceText,
} from "@revolt/ui";
import { DisplayName } from "@revolt/ui/components/features/DisplayName";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { MessageComposition } from "../../src/interface/channels/text/Composition";

import { chatWindows, moveTab } from "./chatWindowsStore";

/**
 * One conversation in a chat window: a header with the encryption badge and
 * the call / add / pop-out actions, then the same message list and composer
 * `TextChannel` renders. `TextChannel` itself is router-bound (highlight and
 * jump links, the main layout's sidebars), so the body is assembled here the
 * way the dev harness does it. `MessageComposition` is used unchanged, so
 * every E2EE send gate it holds applies in chat windows too.
 *
 * The host may swap `channel` without remounting (switching tabs), so all
 * per-conversation state below is keyed on the channel id.
 */
export function ChatWindowView(props: { channel: Channel; windowId: string }) {
  const client = useClient();
  const ctx = useWindowCtx();
  const [atEnd, setEnd] = createSignal(true);
  const [lastId, setLastId] = createSignal<string>();
  let jumpToBottomRef: ((nearby?: string) => void) | undefined;

  // Lets the notification worker suppress what this window shows. The set it
  // publishes only counts windows whose document has focus, so a blurred
  // window's conversation still notifies.
  createEffect(() => setFocusedConversation(ctx.id, props.channel.id));
  onCleanup(() => setFocusedConversation(ctx.id, null));

  // As TextChannel: remember where the unread messages begin
  createEffect(
    on(
      () => props.channel.id,
      (id) =>
        setLastId(
          props.channel.unread
            ? (client().channelUnreads.get(id)?.lastMessageId as string)
            : undefined,
        ),
    ),
  );

  // Ack like TextChannel does, but judged by THIS window's focus: the main
  // document's focus says nothing about whether this conversation was seen.
  const ack = () => props.channel.ack().catch(() => void 0);
  createEffect(
    on(
      () => props.channel.unread && atEnd(),
      (unread) => {
        if (!unread) return;
        if (ctx.doc.hasFocus()) {
          ack();
        } else if (!lastId() && props.channel.lastMessageId) {
          // (taking away one second from the seed)
          setLastId(ulid(decodeTime(props.channel.lastMessageId) - 1));
        }
      },
    ),
  );

  const onFocus = () => {
    if (props.channel.unread && atEnd()) ack();
  };
  // A window's ctx never changes, so binding once is correct.
  const win = ctx.win;
  win.addEventListener("focus", onFocus);
  onCleanup(() => {
    try {
      win.removeEventListener("focus", onFocus);
    } catch {
      // A closed window's listeners die with it.
    }
  });

  return (
    <div class={column()}>
      <ChatWindowHeader channel={props.channel} windowId={props.windowId} />
      <Messages
        channel={props.channel}
        lastReadId={lastId}
        pendingMessages={(pendingProps) => (
          <DraftMessages
            channel={props.channel}
            tail={pendingProps.tail}
            sentIds={pendingProps.ids}
          />
        )}
        typingIndicator={
          <TypingIndicator
            users={props.channel.typing}
            ownId={client().user!.id}
          />
        }
        highlightedMessageId={() => undefined}
        clearHighlightedMessage={() => void 0}
        jumpToBottomRef={(ref) => (jumpToBottomRef = ref)}
        atEnd={[atEnd, setEnd]}
      />
      <ScheduledMessagesBar channel={props.channel} />
      <MessageComposition
        channel={props.channel}
        onMessageSend={() => jumpToBottomRef?.()}
      />
    </div>
  );
}

/**
 * Who the conversation is with, whether it is encrypted, and what can be
 * started from here
 */
function ChatWindowHeader(props: { channel: Channel; windowId: string }) {
  const { t } = useLingui();
  const presence = usePresenceText();
  const { openModal } = useModals();
  const navigate = useNavigate();
  const voice = useVoice();
  const userActions = useUserActions();
  const ctx = useWindowCtx();
  const badge = useConversationE2EE(() => props.channel);

  const isDm = () => props.channel.type === "DirectMessage";
  const isGroup = () => props.channel.type === "Group";
  const recipient = () => (isDm() ? props.channel.recipient : undefined);

  /**
   * Calls are offered for a DM with someone we may call (the bar the user
   * actions hold too) and for groups. Not while already in this call: the
   * controls for it live in the main window.
   */
  const canCall = () => {
    if (voice.channel()?.id === props.channel.id) return false;
    if (isGroup()) return true;
    const user = recipient();
    return (
      !!user &&
      !user.self &&
      user.relationship !== "Blocked" &&
      user.relationship !== "BlockedOther"
    );
  };

  // Same gates as the user actions (video and screen share are build-gated)
  // and the user context menu's Screen Share entry
  const videoSupported = () => CONFIGURATION.ENABLE_VIDEO;
  const screenShareSupported = () =>
    CONFIGURATION.ENABLE_VIDEO &&
    ((typeof navigator !== "undefined" &&
      typeof navigator.mediaDevices?.getDisplayMedia === "function") ||
      nativeScreenShareAvailable());

  // Inert while a join is in flight or a terminal refusal holds, as in the
  // channel header (joinRefusalPolicy)
  const joinBlocked = () => !!voice.joinBlocked(props.channel);
  const callTooltip = (label: string) =>
    voice.joinRefusalMessage(props.channel) ?? label;

  /**
   * Start a call from this window. The mic prompt and the screen picker
   * render in the main window, which is also where the call's controls are,
   * so main comes forward first. A shell that cannot (web) just carries on;
   * the action reports its own failures.
   */
  async function startCall(action: Exclude<PopoutAction, "dm">) {
    // capture before the await: the host can switch this view's tab
    const channel = props.channel;
    const userId = recipient()?.id;
    if (ctx.id !== "main") await chatShell.focusMain();

    if (channel.type === "DirectMessage") {
      if (userId) void userActions.run(action, userId);
      return;
    }

    // A group has no user to hand the user actions; this is the channel
    // header's path, entering the group in main as the user actions do
    navigate(channel.path);
    switch (action) {
      case "call":
        await voice.connect(channel);
        return;
      case "video":
        if (await voice.connect(channel)) await voice.toggleCamera();
        return;
      case "screenshare":
        if (await voice.connect(channel)) await voice.toggleScreenshare();
        return;
    }
  }

  // The add-to-group flow is offered from friend rows; same bar here. DMs
  // only: the group members modal has no device check, and a plaintext or
  // unknown verdict does not prove the group is unencrypted, so an add there
  // could silently half-work. Groups get no add action here until encrypted
  // group adds exist.
  const canAddToGroup = () => recipient()?.relationship === "Friend";

  function addToGroup() {
    const user = recipient();
    if (user) openModal({ type: "add_friend_to_group", userId: user.id });
  }

  // Popping out the only tab would just replace this window with a new one
  const canPopOut = () =>
    (chatWindows.windows().find((w) => w.id === props.windowId)?.tabs.length ??
      0) > 1;

  /**
   * Stream or game the DM peer is broadcasting, then their custom status,
   * then their presence; as the friend rows show it
   */
  const dmStatus = () => {
    const user = recipient();
    if (!user) return undefined;

    const live = user.liveConnections[0];
    if (live)
      return live.live_title
        ? t`Streaming: ${live.live_title}`
        : t`Streaming on ${live.platform}`;

    const playing = user.activity;
    if (playing) return t`Playing ${playing.name}`;

    return user.status?.text ?? presence.label(user.presence);
  };

  const onlineCount = () =>
    props.channel.recipients.filter((user) => user?.online).length;

  const badgeLabel = (b: E2EEBadge) => {
    switch (b) {
      case "encrypted":
        return t`Encrypted`;
      case "not_encrypted":
        return t`Not encrypted`;
      case "pending":
        return t`Encryption pending`;
      case "warning":
        return t`Encryption needs attention`;
    }
  };

  const badgeTooltip = (b: E2EEBadge) => {
    switch (b) {
      case "encrypted":
        return t`Messages to this conversation are end-to-end encrypted.`;
      case "not_encrypted":
        return t`Messages in this conversation are not end-to-end encrypted.`;
      case "pending":
        return t`Encryption will start once a message is sent.`;
      case "warning":
        return t`Encryption needs your attention. See the notice above the message box.`;
    }
  };

  /**
   * Right-click menu for the person in a DM: the Steam-style friend menu, or
   * the full user menu for someone who is not a friend; none for a group
   */
  const whoMenu = () => {
    const user = recipient();
    if (!user) return undefined;
    return user.relationship === "Friend"
      ? () => <FriendContextMenu user={user} inConversation />
      : () => <UserContextMenu user={user} channel={props.channel} />;
  };

  // The composer's icons for the same states
  const badgeIcon = (b: E2EEBadge) => {
    switch (b) {
      case "encrypted":
        return "lock";
      case "not_encrypted":
        return "lock_open";
      case "pending":
        return "lock_clock";
      case "warning":
        return "gpp_maybe";
    }
  };

  return (
    <header class={header()}>
      {/* Right-clicking the person opens the friend menu, as in Steam */}
      <div class={who()} use:floating={{ contextMenu: whoMenu() }}>
        <Switch
          fallback={
            <Avatar
              size={32}
              shape="rounded-square"
              fallback={props.channel.name ?? ""}
              src={props.channel.iconURL}
              primaryContrast
            />
          }
        >
          <Match when={recipient()}>
            {(user) => (
              <Avatar
                size={32}
                src={user().animatedAvatarURL}
                fallback={user().username}
                holepunch="bottom-right"
                overlay={<UserStatus.Graphic status={user().presence} />}
              />
            )}
          </Match>
        </Switch>

        <div class={nameStack()}>
          <OverflowingText class={title()}>
            <Show
              when={recipient()}
              fallback={<TextWithEmoji content={props.channel.name ?? ""} />}
            >
              {(user) => (
                <DisplayName
                  user={user()}
                  name={user().displayName}
                  brand={isSlogaStaff(user())}
                />
              )}
            </Show>
          </OverflowingText>
          <Switch>
            <Match when={isDm()}>
              <span class={subtitle()}>{dmStatus()}</span>
            </Match>
            <Match when={isGroup()}>
              <span class={subtitle()}>
                <Plural
                  value={props.channel.recipientIds.size}
                  one="# member"
                  other="# members"
                />
                {" · "}
                {t`${onlineCount()} online`}
              </span>
            </Match>
          </Switch>
        </div>
      </div>

      <Show when={badge()}>
        {(b) => (
          <span
            class={badgeChip({ tone: b() })}
            role="status"
            use:floating={{
              tooltip: { placement: "bottom", content: badgeTooltip(b()) },
            }}
          >
            <Symbol size={16}>{badgeIcon(b())}</Symbol>
            <span>{badgeLabel(b())}</span>
          </span>
        )}
      </Show>

      <div class={actions()}>
        <Show when={canCall()}>
          <IconButton
            aria-label={t`Voice call`}
            isDisabled={joinBlocked()}
            onPress={() => void startCall("call")}
            use:floating={{
              tooltip: {
                placement: "bottom",
                content: callTooltip(t`Voice call`),
              },
            }}
          >
            <Symbol>call</Symbol>
          </IconButton>
          <Show when={videoSupported()}>
            <IconButton
              aria-label={t`Video call`}
              isDisabled={joinBlocked()}
              onPress={() => void startCall("video")}
              use:floating={{
                tooltip: {
                  placement: "bottom",
                  content: callTooltip(t`Video call`),
                },
              }}
            >
              <Symbol>videocam</Symbol>
            </IconButton>
          </Show>
          <Show when={screenShareSupported()}>
            <IconButton
              aria-label={t`Screen Share`}
              isDisabled={joinBlocked()}
              onPress={() => void startCall("screenshare")}
              use:floating={{
                tooltip: {
                  placement: "bottom",
                  content: callTooltip(t`Screen Share`),
                },
              }}
            >
              <Symbol>screen_share</Symbol>
            </IconButton>
          </Show>
        </Show>

        <Show when={canAddToGroup()}>
          <IconButton
            aria-label={t`Add to group`}
            onPress={addToGroup}
            use:floating={{
              tooltip: { placement: "bottom", content: t`Add to group` },
            }}
          >
            <Symbol>group_add</Symbol>
          </IconButton>
        </Show>

        <Show when={canPopOut()}>
          <IconButton
            aria-label={t`Pop out into a new window`}
            onPress={() => moveTab(props.channel.id, "new")}
            use:floating={{
              tooltip: {
                placement: "bottom",
                content: t`Pop out into a new window`,
              },
            }}
          >
            <Symbol>open_in_new</Symbol>
          </IconButton>
        </Show>
      </div>
    </header>
  );
}

const column = cva({
  base: {
    display: "flex",
    flexDirection: "column",
    flex: "1 1 0",
    minHeight: 0,
    background: "var(--md-sys-color-surface)",
  },
});

/** Avatar and name as one right-click target, without changing the layout */
const who = cva({
  base: {
    display: "contents",
  },
});

const header = cva({
  base: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: "var(--gap-md)",
    paddingInline: "var(--gap-md)",
    paddingBlock: "var(--gap-sm)",
    borderBottom: "1px solid var(--md-sys-color-outline-variant)",
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

const title = cva({
  base: {
    fontSize: "15px",
    fontWeight: 500,
    color: "var(--md-sys-color-on-surface)",
  },
});

const subtitle = cva({
  base: {
    fontSize: "12px",
    color: "var(--md-sys-color-on-surface-variant)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

// Colours match the composer's encryption indicator
const badgeChip = cva({
  base: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: "var(--gap-xs)",
    paddingInline: "var(--gap-sm)",
    paddingBlock: "2px",
    borderRadius: "var(--borderRadius-full)",
    fontSize: "12px",
    fontWeight: 600,
    userSelect: "none",
    background: "var(--md-sys-color-surface-container-high)",
  },
  variants: {
    tone: {
      encrypted: { color: "#3BA55D" },
      not_encrypted: { color: "var(--md-sys-color-on-surface-variant)" },
      pending: { color: "var(--md-sys-color-primary)" },
      warning: { color: "#FF8A00" },
    },
  },
});

const actions = cva({
  base: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: "var(--gap-xs)",
  },
});
