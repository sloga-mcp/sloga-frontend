import { Show, createMemo } from "solid-js";

import { useLingui } from "@lingui-solid/solid/macro";
import type { User } from "stoat.js";
import { cva } from "styled-system/css";

import { UserContextMenu } from "@revolt/app";
import { useClient } from "@revolt/client";
import * as chatShell from "@revolt/client/chatShell";
import { type PopoutAction, useUserActions } from "@revolt/client/popoutBridge";
import { voiceChannelOf } from "@revolt/client/voicePresence";
import { useWindowCtx } from "@revolt/client/windowCtx";
import { CONFIGURATION } from "@revolt/common";
import { useModals } from "@revolt/modal";
import { nativeScreenShareAvailable } from "@revolt/rtc";
import { useState } from "@revolt/state";
import {
  Avatar,
  Unreads,
  UserStatus,
  isSlogaStaff,
  usePresenceText,
} from "@revolt/ui";
import { DisplayName } from "@revolt/ui/components/features/DisplayName";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/**
 * Height of a single friend row, in pixels
 *
 * Panda only extracts statically analysable values, so the row styling
 * below repeats this as a literal — keep the two in step or virtualisation
 * will drift out of line with what is drawn.
 */
export const ROW_HEIGHT = 46;

/**
 * Single user entry
 */
export function FriendRow(props: {
  user: User;
  tabIndex?: number;
  /** Double-click and the Message button; opens the DM when omitted */
  onOpen?: (u: User) => void;
  /** Unread state of the DM with this user; null or omitted shows nothing */
  unread?: { count: number; mention: boolean } | null;
  /** Show the Message / call / screen share / add-to-group hover buttons */
  quickActions?: boolean;
  /**
   * Steam-style mouse clicks: a single click only selects (focuses) the row,
   * a double click or Enter opens the conversation, and the avatar opens
   * the profile. Touch keeps tap for the profile and double tap for the DM.
   */
  selectOnClick?: boolean;
}) {
  const { t } = useLingui();
  const presence = usePresenceText();
  const { openModal } = useModals();
  const state = useState();
  const client = useClient();
  const userActions = useUserActions();
  const windowCtx = useWindowCtx();

  // Delay single-click so a double-click can cancel it and open the DM instead
  let clickTimer: number | undefined;

  // Pointer type of the press that led to the latest click. Read from
  // pointerdown because WebKit's click events carry no pointerType.
  let lastPointer = "mouse";

  function openProfile() {
    openModal({ type: "user_profile", user: props.user });
  }

  function onClick() {
    // A delayed profile here would beat a normal-speed double click (the
    // OS window is up to 500 ms) and its modal would take the second click
    if (props.selectOnClick && lastPointer !== "touch") return;

    if (clickTimer !== undefined) return;
    // capture now: virtualisation can recycle this row onto another user
    // before the timer fires
    const user = props.user;
    clickTimer = window.setTimeout(() => {
      clickTimer = undefined;
      openModal({ type: "user_profile", user });
    }, 250);
  }

  /**
   * Open the conversation with this user
   */
  function open() {
    if (props.onOpen) {
      props.onOpen(props.user);
      return;
    }

    // run() never rejects (failures surface as a snackbar); in the popout it
    // hands the DM to the main window, since the popout bounces navigation
    void userActions.run("dm", props.user.id);
  }

  function onDblClick() {
    if (clickTimer !== undefined) {
      window.clearTimeout(clickTimer);
      clickTimer = undefined;
    }

    open();
  }

  function onKeyDown(event: KeyboardEvent) {
    // Only the row itself: Enter on a quick-action button is that button's
    if (
      props.selectOnClick &&
      event.key === "Enter" &&
      event.target === event.currentTarget
    ) {
      event.preventDefault();
      open();
    }
  }

  /**
   * Call or screen share this user. The mic prompt and the screen picker
   * render in the main window, so a row in a chat window brings main forward
   * first. A shell that cannot (web) just carries on; the action reports its
   * own failures.
   */
  async function callAction(action: PopoutAction) {
    // capture before the await: the row can be recycled onto another user
    const userId = props.user.id;
    if (windowCtx.id !== "main") await chatShell.focusMain();
    void userActions.run(action, userId);
  }

  const isFriend = () => props.user.relationship === "Friend";
  const favourite = () => state.friends.isFavourite(props.user.id);

  // Same gate as the user context menu's Screen Share entry
  const screenShareSupported = () =>
    CONFIGURATION.ENABLE_VIDEO &&
    ((typeof navigator !== "undefined" &&
      typeof navigator.mediaDevices?.getDisplayMedia === "function") ||
      nativeScreenShareAvailable());

  /**
   * Whether this user is sitting in a call.
   *
   * The point of surfacing it here is the decision it saves: you can see not to
   * ring someone who is already talking to people. Only calls in channels we
   * can see are visible — see `voiceChannelOf` for exactly what that misses.
   *
   * Memoised because the lookup walks every channel we know about, and both
   * the label and the accent colour below read it.
   */
  const inVoice = createMemo(() => !!voiceChannelOf(client(), props.user.id));

  /**
   * Stream or game the user is broadcasting, if any — these read as
   * activity rather than presence, so they take the online accent colour
   */
  const activity = () => {
    const live = props.user.liveConnections[0];
    if (live)
      return live.live_title
        ? t`Streaming: ${live.live_title}`
        : t`Streaming on ${live.platform}`;

    const playing = props.user.activity;
    if (playing) return t`Playing ${playing.name}`;

    return undefined;
  };

  /**
   * Being in a call outranks a broadcast or a custom status: it is the one
   * line here that changes what you are about to do.
   */
  const status = () =>
    inVoice()
      ? t`Voice`
      : (activity() ??
        props.user.status?.text ??
        presence.label(props.user.presence));

  return (
    <div
      class={row({ dim: !props.user.online })}
      role="listitem"
      tabIndex={props.tabIndex}
      use:floating={{
        contextMenu: () => <UserContextMenu user={props.user} />,
      }}
      onPointerDown={(e) => (lastPointer = e.pointerType)}
      onClick={onClick}
      onDblClick={onDblClick}
      onKeyDown={onKeyDown}
    >
      {/* The avatar is the mouse way to the profile once a single click on
          the row only selects it */}
      <div
        class={avatarHit()}
        onClick={(e) => {
          if (!props.selectOnClick) return;
          e.stopPropagation();
          openProfile();
        }}
        onDblClick={(e) => {
          if (props.selectOnClick) e.stopPropagation();
        }}
      >
        <Avatar
          size={28}
          src={props.user.animatedAvatarURL}
          fallback={props.user.username}
          holepunch={isFriend() ? "bottom-right" : "none"}
          overlay={
            <Show when={isFriend()}>
              <UserStatus.Graphic status={props.user.presence} />
            </Show>
          }
        />
      </div>

      <div class={nameStack()}>
        <div class={`name ${name()} ${ellipsis()}`}>
          <DisplayName
            user={props.user}
            name={props.user.displayName}
            brand={isSlogaStaff(props.user)}
          />
        </div>
        {/* The note REPLACES the status line on incoming requests — the row
            is a fixed-height virtualized item, so a third line would clip */}
        <Show
          when={
            props.user.relationship === "Incoming" &&
            props.user.relationshipNote
          }
          fallback={
            <div
              class={`${statusText({ accent: inVoice() || !!activity() })} ${ellipsis()}`}
            >
              {status()}
            </div>
          }
        >
          <div class={`${noteText()} ${ellipsis()}`}>
            “{props.user.relationshipNote}”
          </div>
        </Show>
      </div>

      <Show when={props.quickActions && isFriend()}>
        {/* Buttons keep their clicks to themselves: the row's single click
            selects it (or opens the profile) and its double click opens the
            DM */}
        <div
          class={`quick-actions ${quickActions()}`}
          onClick={(e) => e.stopPropagation()}
          onDblClick={(e) => e.stopPropagation()}
        >
          <button
            class={iconButton()}
            aria-label={t`Message`}
            onClick={open}
            use:floating={{
              tooltip: { placement: "top", content: t`Message` },
            }}
          >
            <Symbol size={18}>chat</Symbol>
          </button>
          <button
            class={iconButton()}
            aria-label={t`Call`}
            onClick={() => void callAction("call")}
            use:floating={{ tooltip: { placement: "top", content: t`Call` } }}
          >
            <Symbol size={18}>call</Symbol>
          </button>
          <Show when={screenShareSupported()}>
            <button
              class={iconButton()}
              aria-label={t`Screen Share`}
              onClick={() => void callAction("screenshare")}
              use:floating={{
                tooltip: { placement: "top", content: t`Screen Share` },
              }}
            >
              <Symbol size={18}>screen_share</Symbol>
            </button>
          </Show>
          <button
            class={iconButton()}
            aria-label={t`Add to group chat`}
            onClick={() =>
              openModal({ type: "add_friend_to_group", userId: props.user.id })
            }
            use:floating={{
              tooltip: { placement: "top", content: t`Add to group chat` },
            }}
          >
            <Symbol size={18}>group_add</Symbol>
          </button>
        </div>
      </Show>

      <Show when={props.unread}>
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

      <Show when={isFriend()}>
        <button
          class={`favourite ${favouriteButton()}`}
          data-active={favourite()}
          aria-label={
            favourite() ? "Remove from favorites" : "Add to favorites"
          }
          onClick={(e) => {
            e.stopPropagation();
            state.friends.toggleFavourite(props.user.id);
          }}
          use:floating={{
            tooltip: {
              placement: "left",
              content: favourite()
                ? "Remove from favorites"
                : "Add to favorites",
            },
          }}
        >
          <Symbol size={18} fill={favourite()}>
            star
          </Symbol>
        </button>
      </Show>
    </div>
  );
}

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

    "& .favourite": {
      opacity: 0,
    },

    // Collapsed rather than display:none so the buttons stay tabbable;
    // focusing one opens the bar
    "& .quick-actions": {
      width: 0,
      overflow: "hidden",
    },

    "&:hover": {
      background: "var(--md-sys-color-surface-container-high)",
    },

    // The selected row (a single click focuses it)
    "&:focus": {
      outline: "none",
      background: "var(--md-sys-color-surface-container-highest)",
    },

    "&:focus-visible": {
      outline: "2px solid var(--md-sys-color-primary)",
      outlineOffset: "-2px",
    },

    "&:hover .favourite, &:focus .favourite, & .favourite[data-active='true']":
      {
        opacity: 1,
      },

    "&:hover .quick-actions, &:focus .quick-actions, & .quick-actions:focus-within":
      {
        width: "auto",
        overflow: "visible",
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

const avatarHit = cva({
  base: {
    display: "flex",
    flexShrink: 0,
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

const statusText = cva({
  base: {
    fontSize: "12px",
    color: "var(--md-sys-color-on-surface-variant)",
  },
  variants: {
    accent: {
      true: {
        color: "var(--brand-presence-online)",
      },
    },
  },
});

/** Note attached to an incoming friend request */
const noteText = cva({
  base: {
    fontSize: "12px",
    fontStyle: "italic",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const ellipsis = cva({
  base: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

const favouriteButton = cva({
  base: {
    all: "unset",
    display: "flex",
    flexShrink: 0,
    cursor: "pointer",
    color: "var(--md-sys-color-on-surface-variant)",
    transition: "opacity var(--transitions-fast)",

    "&:hover": {
      color: "var(--md-sys-color-on-surface)",
    },
  },
});

const quickActions = cva({
  base: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: "var(--gap-xs)",
  },
});

const iconButton = cva({
  base: {
    all: "unset",
    display: "flex",
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

const unreadPill = cva({
  base: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
  },
});
