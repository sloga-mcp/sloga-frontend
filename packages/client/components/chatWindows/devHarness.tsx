import {
  For,
  JSX,
  Show,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import { Portal } from "solid-js/web";

import type { Channel } from "stoat.js";
import { styled } from "styled-system/jsx";

import { DraftMessages, Messages } from "@revolt/app";
import { useClient } from "@revolt/client";
import { ChildWindowChrome } from "@revolt/client/ChildWindowChrome";
import {
  type ChildWindowHandle,
  openChildWindow,
} from "@revolt/client/childWindow";
import {
  type WindowCtx,
  setFocusedConversation,
} from "@revolt/client/windowCtx";
import { TypingIndicator } from "@revolt/ui";

import { MessageComposition } from "../../src/interface/channels/text/Composition";

declare global {
  interface Window {
    /** DEV builds only: open a channel in a chat window from the console. */
    __chatwin?: { open(channelId: string): Promise<boolean> };
  }
}

/**
 * DEV-only harness for chat windows, so the window plumbing can be exercised
 * in a plain browser before the real chat window UI exists:
 * `await __chatwin.open("<channel id>")` from the main window's console.
 *
 * It must be mounted inside the logged-in interface: the child's content is
 * portalled from here, so it inherits the client, state, modal and i18n
 * contexts above it. Production builds render nothing and never install the
 * global.
 */
export function ChatWinDevHarness(): JSX.Element {
  return (
    <Show when={import.meta.env.DEV}>
      <Harness />
    </Show>
  );
}

type OpenWindow = { handle: ChildWindowHandle; channel: Channel };

function Harness() {
  const client = useClient();
  const [windows, setWindows] = createSignal<readonly OpenWindow[]>([]);
  let disposed = false;

  async function open(channelId: string): Promise<boolean> {
    const channel =
      client().channels.get(channelId) ??
      (await client()
        .channels.fetch(channelId)
        .catch(() => undefined));
    if (!channel || disposed) return false;

    const handle = await openChildWindow("chat", { width: 520, height: 640 });
    if (!handle) return false;

    // Logged out (or hot-reloaded away) while the window was opening: nothing
    // is left to render into it.
    if (disposed) {
      handle.close();
      return false;
    }

    setWindows((list) => [...list, { handle, channel }]);
    handle.onClose(() =>
      setWindows((list) => list.filter((entry) => entry.handle !== handle)),
    );
    return true;
  }

  onMount(() => {
    const api = { open };
    window.__chatwin = api;

    onCleanup(() => {
      disposed = true;
      if (window.__chatwin === api) delete window.__chatwin;
      // Unmounting removes the portals, which would leave empty windows.
      for (const { handle } of windows()) handle.close();
    });
  });

  return (
    <For each={windows()}>
      {(entry) => (
        <Portal mount={entry.handle.ctx.doc.body}>
          <ChildWindowChrome ctx={entry.handle.ctx}>
            <HarnessChannel channel={entry.channel} ctx={entry.handle.ctx} />
          </ChildWindowChrome>
        </Portal>
      )}
    </For>
  );
}

/**
 * The bare channel view: `TextChannel` minus everything bound to the router
 * (highlight, jump links) or to the main layout (header, sidebars).
 */
function HarnessChannel(props: { channel: Channel; ctx: WindowCtx }) {
  const client = useClient();
  const [atEnd, setEnd] = createSignal(true);
  let jumpToBottomRef: ((nearby?: string) => void) | undefined;

  // Nothing else reports what a chat window shows yet, and without it the
  // notification suppression for chat windows cannot be checked here.
  createEffect(() => setFocusedConversation(props.ctx.id, props.channel.id));
  onCleanup(() => setFocusedConversation(props.ctx.id, null));

  // Ack like TextChannel does, but judged by this window's focus.
  const ack = () => props.channel.ack().catch(() => void 0);
  createEffect(
    on(
      () => props.channel.unread && atEnd(),
      (unread) => {
        if (unread && props.ctx.doc.hasFocus()) ack();
      },
    ),
  );

  const onFocus = () => {
    if (props.channel.unread && atEnd()) ack();
  };
  // A window's ctx never changes, so binding once is correct.
  // eslint-disable-next-line solid/reactivity
  const win = props.ctx.win;
  win.addEventListener("focus", onFocus);
  onCleanup(() => {
    try {
      win.removeEventListener("focus", onFocus);
    } catch {
      // A closed window's listeners die with it.
    }
  });

  return (
    <Column>
      <Messages
        channel={props.channel}
        lastReadId={() => undefined}
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
      <MessageComposition
        channel={props.channel}
        onMessageSend={() => jumpToBottomRef?.()}
      />
    </Column>
  );
}

const Column = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    minHeight: 0,
    background: "var(--md-sys-color-surface)",
  },
});
