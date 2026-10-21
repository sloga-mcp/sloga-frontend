import { Component, JSX, Match, Show, Switch, createMemo } from "solid-js";
import { styled } from "styled-system/jsx";

import { Channel, Server as ServerI } from "stoat.js";

import {
  CategoryContextMenu,
  ChannelContextMenu,
  ServerSidebarContextMenu,
} from "@revolt/app";
import { useClient, useUser } from "@revolt/client";
import { useModals } from "@revolt/modal";
import { useLocation, useParams, useSmartParams } from "@revolt/routing";
import { useState } from "@revolt/state";
import { LAYOUT_SECTIONS } from "@revolt/state/stores/Layout";

import { useLayoutSides } from "@revolt/ui";

import { PaneErrorBoundary } from "./PaneErrorBoundary";
import { HomeSidebar, ServerList, ServerSidebar } from "./navigation";
import { UserFooter } from "./navigation/UserFooter";
import { RAIL_EXPANDED_DEFAULT } from "./navigation/servers/ServerList";

const MainBar = styled("div", {
  base: {
    display: "flex",
    flexShrink: 0,
    // Containing block for the floating user bar.
    position: "relative",

    _phone: {
      "--layout-width-channel-sidebar": "auto",
      position: "absolute",
      width: "100vw",
      height: "100%",
    },
  },
  variants: {
    /**
     * Navigation block on the right: the rail belongs at the window edge and
     * the channel list inside it, i.e. a true mirror of the default. The
     * floating user bar is absolutely positioned over the whole block, so it
     * needs nothing.
     */
    navRight: {
      true: {
        flexDirection: "row-reverse",
      },
    },
    /**
     * Reserve room at the bottom of the visible columns (server rail +
     * channel list) so their content can always scroll clear of the
     * floating user bar, which overlays the bottom of the nav block.
     *
     * "bar" is the horizontal pill; "stack" is the vertical variant used
     * when only the icons-only server rail remains. The column's height
     * depends on what it holds (the hang-up while in a call, the update
     * arrow), so it reserves the height the footer measures and publishes
     * as `--user-footer-height` (UserFooter.tsx), plus the footer's own
     * 10px bottom offset and a little air. The fallback, before the first
     * measurement, is the out-of-call height.
     */
    footer: {
      none: {},
      bar: {
        "& > *:not([data-user-footer])": {
          paddingBottom: "var(--layout-height-user-footer)",
        },
      },
      stack: {
        "& > *:not([data-user-footer])": {
          paddingBottom: "calc(var(--user-footer-height, 152px) + 16px)",
        },
      },
    },
  },
  defaultVariants: {
    footer: "none",
  },
});

/**
 * Left-most channel navigation sidebar
 */
export const Sidebar = (props: {
  /**
   * Menu generator TODO FIXME: remove
   */
  menuGenerator: (t: ServerI | Channel) => JSX.Directives["floating"];
}) => {
  const user = useUser();
  const state = useState();
  const client = useClient();
  const { openModal } = useModals();

  const params = useParams<{ server: string }>();
  const location = useLocation();
  const sides = useLayoutSides();

  /** Whether the channel sidebar is shown. */
  const showSidebar = () =>
    state.layout.getSectionState(LAYOUT_SECTIONS.PRIMARY_SIDEBAR, true) &&
    !location.pathname.startsWith("/discover");

  /**
   * The user bar stays mounted when the channel sidebar collapses — it
   * shrinks onto the server rail instead, mirroring how it already
   * follows the rail's own expand/collapse. /discover keeps no bar.
   */
  const showFooter = () => !location.pathname.startsWith("/discover");

  /**
   * With the channel sidebar collapsed and the rail icons-only, 56px is
   * all that is left — the pill goes vertical. (On phone the rail is
   * forced collapsed but the channel sidebar is always "shown", so this
   * never triggers there.)
   */
  const footerStacked = () =>
    !showSidebar() &&
    !state.layout.getSectionState(
      LAYOUT_SECTIONS.SERVER_RAIL_EXPANDED,
      RAIL_EXPANDED_DEFAULT,
    );

  return (
    <MainBar
      class="main_bar"
      navRight={sides().nav === "right"}
      footer={showFooter() ? (footerStacked() ? "stack" : "bar") : "none"}
    >
      <ServerList
        orderedServers={state.ordering.orderedServers(client())}
        setServerOrder={state.ordering.setServerOrder}
        unreadConversations={state.ordering
          .orderedConversations(client())
          .filter(
            // TODO: muting channels
            (channel) => channel.unread,
          )}
        pendingFriendRequests={
          client()
            ?.users.toList()
            .filter((user) => user.relationship === "Incoming").length ?? 0
        }
        user={user()!}
        selectedServer={() => params.server}
        onCreateOrJoinServer={() =>
          openModal({
            type: "create_or_join_server",
            client: client(),
          })
        }
        menuGenerator={props.menuGenerator}
      />
      <Show when={showSidebar()}>
        {/* The server rail stays outside the boundary, so after an error
            it is still there to navigate away with, which resets it. */}
        <PaneErrorBoundary pane="sidebar">
          <Switch fallback={<Home />}>
            <Match when={params.server}>
              <Server />
            </Match>
          </Switch>
        </PaneErrorBoundary>
      </Show>
      <Show when={showFooter()}>
        <UserFooter stacked={footerStacked()} />
      </Show>
    </MainBar>
  );
};

/**
 * Render sidebar for home
 */
const Home: Component = () => {
  const params = useSmartParams();
  const client = useClient();
  const state = useState();
  const conversations = createMemo(() =>
    state.ordering.orderedConversations(client()),
  );

  return (
    <HomeSidebar
      conversations={conversations}
      channelId={params().channelId}
      openSavedNotes={(navigate) => {
        // Check whether the saved messages channel exists already
        const channelId = [...client()!.channels.values()].find(
          (channel) => channel.type === "SavedMessages",
        )?.id;

        if (navigate) {
          if (channelId) {
            // Navigate if exists
            navigate(`/channel/${channelId}`);
          } else {
            // If not, try to create one but only if navigating
            client()!
              .user!.openDM()
              .then((channel) => navigate(`/channel/${channel.id}`));
          }
        }

        // Otherwise return channel ID if available
        return channelId;
      }}
    />
  );
};

/**
 * Render sidebar for a server
 */
const Server: Component = () => {
  const { openModal } = useModals();
  const params = useSmartParams();
  const client = useClient();

  /**
   * Resolve the server
   * @returns Server
   */
  const server = () => client()!.servers.get(params().serverId!)!;

  /**
   * Open the server information modal
   */
  function openServerInfo() {
    openModal({
      type: "server_info",
      server: server(),
    });
  }

  /**
   * Open the server settings modal
   */
  function openServerSettings() {
    openModal({
      type: "settings",
      config: "server",
      context: server(),
    });
  }

  return (
    <Show when={server()}>
      <ServerSidebar
        server={server()}
        channelId={params().channelId}
        openServerInfo={openServerInfo}
        openServerSettings={openServerSettings}
        menuGenerator={(target) => ({
          contextMenu: () =>
            target instanceof Channel ? (
              <ChannelContextMenu channel={target} />
            ) : target instanceof ServerI ? (
              <ServerSidebarContextMenu server={target} />
            ) : (
              <CategoryContextMenu server={server()} category={target} />
            ),
        })}
      />
    </Show>
  );
};
