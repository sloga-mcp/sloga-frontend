import { JSX, Show, createEffect } from "solid-js";

import { useLingui } from "@lingui-solid/solid/macro";
import { useNavigate } from "@solidjs/router";
import { cva } from "styled-system/css";

import { useClient } from "@revolt/client";
import * as chatShell from "@revolt/client/chatShell";
import { useWindowCtx } from "@revolt/client/windowCtx";
import { useModals } from "@revolt/modal";
import { useState } from "@revolt/state";

import { FriendsList } from "../friends/FriendsList";
import { GroupChatsDock } from "../friends/GroupChatsDock";
import { SelfBar } from "../friends/SelfBar";

import { WindowControls } from "./WindowControls";
import {
  TITLEBAR_HEIGHT,
  spacerRegion,
  tabDragActive,
  titleBarLayout,
} from "./chatWindowFrame";
import { setFriendsOpen } from "./chatWindowsStore";
import { routeConversation } from "./openConversation";

/**
 * The desktop friends window, shown in chat-windows mode: your own presence
 * on top, the friends list in the middle and the group chats dock at the
 * bottom.
 *
 * Rendered from the main tree into the child document (inside
 * `ChildWindowChrome`), so the router here is MAIN's router.
 *
 * In a window without an OS title bar (frame `buttons` or `inset`) a bar of
 * its own sits on top: a caption region (`data-app-region`, see
 * `ui/styles.css`) titled "Friends" in its center, with the window controls
 * on `buttons` and the traffic lights' corner kept clear on `inset`
 * (`titleBarLayout`).
 * Like the chat windows' bars it turns no-drag while a drag is live, so
 * files dragged in from outside are not refused over it.
 */
export function FriendsWindow(props: {
  /** What the shell built around the window (`ChildWindowHandle.frame`) */
  frame: chatShell.ChatWindowFrame;
  /** The shell's label for the window, for the window controls */
  shellLabel?: string;
}): JSX.Element {
  const client = useClient();
  const state = useState();
  const navigate = useNavigate();
  const ctx = useWindowCtx();
  const { openModal } = useModals();
  const { t } = useLingui();

  createEffect(() => {
    ctx.doc.title = t`Friends`;
  });

  /**
   * "Main window" mode: the conversation opens in main, not in a chat window.
   * Main is raised first, as the conversation shows there and not here.
   */
  function openInMain(path: string) {
    void chatShell.focusMain();
    navigate(path);
  }

  async function openConversation(userId: string) {
    try {
      const user = client().users.get(userId);
      if (!user) throw new Error("friends window: unknown user");

      const dm = await user.openDM();
      routeConversation(state, dm.id, () => openInMain(dm.path));
    } catch (err) {
      // A denied or paused DM must not read as a dead row; shown in this
      // window, where the user double-clicked.
      console.error(err);
      openModal({ type: "error2", error: err, windowId: ctx.id });
    }
  }

  function openGroup(channelId: string) {
    const channel = client().channels.get(channelId);
    routeConversation(state, channelId, () =>
      openInMain(channel?.path ?? `/channel/${channelId}`),
    );
  }

  const layout = () => titleBarLayout(props.frame, props.shellLabel);

  return (
    <div class={column()}>
      <Show when={layout().bar}>
        <div
          class={titleBar()}
          data-app-region={spacerRegion(tabDragActive())}
          style={{ height: `${TITLEBAR_HEIGHT}px` }}
        >
          <div class={barSide()} style={layout().style} />
          <span class={titleText()}>{t`Friends`}</span>
          <div class={barSide({ end: true })}>
            <Show when={layout().controls && props.shellLabel}>
              {(label) => (
                <WindowControls
                  label={label()}
                  onClose={() => setFriendsOpen(false)}
                />
              )}
            </Show>
          </div>
        </div>
      </Show>
      <div class={top()}>
        <SelfBar />
      </div>
      <div class={middle()}>
        <FriendsList onOpenConversation={(id) => void openConversation(id)} />
      </div>
      <div class={bottom()}>
        <GroupChatsDock onOpen={openGroup} />
      </div>
    </div>
  );
}

const column = cva({
  base: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
    overflow: "hidden",
    background: "var(--md-sys-color-surface)",
    color: "var(--md-sys-color-on-surface)",
  },
});

/**
 * The window's own title bar; its height is `TITLEBAR_HEIGHT`. The same grid
 * as main's (MainTitleBar): the side columns share the free space equally,
 * so the title sits on the window's center while there is room and moves
 * aside (then ellipsizes) when there is not. Left to right whatever the
 * page's direction, as the traffic lights and the controls are physical
 * places.
 */
const titleBar = cva({
  base: {
    display: "grid",
    gridTemplateColumns:
      "minmax(max-content, 1fr) minmax(0, max-content) minmax(max-content, 1fr)",
    alignItems: "stretch",
    direction: "ltr",
    flexShrink: 0,
    userSelect: "none",
  },
});

/** A side column: the traffic lights' space, or the window controls. */
const barSide = cva({
  base: {
    display: "flex",
    alignItems: "stretch",
    minWidth: 0,
  },
  variants: {
    end: {
      true: {
        justifyContent: "flex-end",
      },
    },
  },
});

const titleText = cva({
  base: {
    minWidth: 0,
    alignSelf: "center",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "12px",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const top = cva({
  base: {
    flexShrink: 0,
    paddingInline: "var(--gap-sm)",
  },
});

const middle = cva({
  base: {
    position: "relative",
    flexGrow: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    overflowY: "auto",
  },
});

const bottom = cva({
  base: {
    flexShrink: 0,
  },
});
