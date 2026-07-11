import { Accessor, For, JSX, Show, createSignal } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { Channel, Server, User } from "stoat.js";
import { cva } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { CONFIGURATION, useDevice } from "@revolt/common";
import { KeybindAction, createKeybind } from "@revolt/keybinds";
import { useModals } from "@revolt/modal";
import { useNavigate } from "@revolt/routing";
import { useState } from "@revolt/state";
import { LAYOUT_SECTIONS } from "@revolt/state/stores/Layout";
import {
  Avatar,
  Column,
  Text,
  Time,
  Unreads,
  UserStatus,
  iconSize,
} from "@revolt/ui";

import MdAdd from "@material-design-icons/svg/filled/add.svg?component-solid";
import MdChevronRight from "@material-design-icons/svg/filled/chevron_right.svg?component-solid";
import MdExplore from "@material-design-icons/svg/filled/explore.svg?component-solid";
import MdSettings from "@material-design-icons/svg/filled/settings.svg?component-solid";

import { Tooltip } from "../../../../components/ui/components/floating";
import { Draggable } from "../../../../components/ui/components/utils/Draggable";

import { UserMenu } from "./UserMenu";

interface Props {
  /**
   * Ordered server list
   */
  orderedServers: Server[];

  /**
   * Set server ordering
   * @param ids List of IDs
   */
  setServerOrder: (ids: string[]) => void;

  /**
   * Unread conversations list
   */
  unreadConversations: Channel[];

  /**
   * Current logged in user
   */
  user: User;

  /**
   * Selected server id
   */
  selectedServer: Accessor<string | undefined>;

  /**
   * Create or join server
   */
  onCreateOrJoinServer(): void;

  /**
   * Menu generator
   */
  menuGenerator: (target: Server | Channel) => JSX.Directives["floating"];
}

/**
 * Default expanded state of the rail (before the user toggles it).
 * Must be passed to every get/set/toggle call for the section key so the
 * store's "only store the contrary" behaviour stays consistent.
 */
const RAIL_EXPANDED_DEFAULT = true;

/**
 * Server list sidebar component
 */
export const ServerList = (props: Props) => {
  const state = useState();
  const navigate = useNavigate();
  const device = useDevice();
  const { openModal } = useModals();

  /**
   * Whether the rail is expanded to show text labels.
   *
   * Forced collapsed on phone layouts (the whole nav becomes a full-screen
   * overlay there, so a wide rail would squeeze the channel list).
   */
  const railExpanded = () =>
    device.layout() !== "phone" &&
    state.layout.getSectionState(
      LAYOUT_SECTIONS.SERVER_RAIL_EXPANDED,
      RAIL_EXPANDED_DEFAULT,
    );

  const navigateServer = (byOffset: number) => {
    const serverId = props.selectedServer();
    if (serverId == null && props.orderedServers.length) {
      if (byOffset === 1) {
        navigate(`/server/${props.orderedServers[0].id}`);
      } else {
        navigate(
          `/server/${props.orderedServers[props.orderedServers.length - 1].id}`,
        );
      }
      return;
    }

    const currentServerIndex = props.orderedServers.findIndex(
      (server) => server.id === serverId,
    );

    const nextIndex = currentServerIndex + byOffset;

    if (nextIndex === -1) {
      return navigate("/app");
    }

    // this will wrap the index around
    const nextServer = props.orderedServers.at(
      nextIndex % props.orderedServers.length,
    );

    if (nextServer) {
      navigate(`/server/${nextServer.id}`);
    }
  };

  createKeybind(KeybindAction.NAVIGATION_SERVER_UP, () => navigateServer(-1));
  createKeybind(KeybindAction.NAVIGATION_SERVER_DOWN, () => navigateServer(1));

  // Ref for floating menu
  const [menuButton, setMenuButton] = createSignal<HTMLDivElement>();

  return (
    <ServerListBase expanded={railExpanded()}>
      <div use:invisibleScrollable={{ direction: "y", class: listBase() }}>
        <Tooltip placement="right" content="Settings">
          <a
            class={entryContainer({ expanded: railExpanded() })}
            onClick={() => openModal({ type: "settings", config: "user" })}
          >
            <Avatar size={42} fallback={<MdSettings />} interactive />
            <Show when={railExpanded()}>
              <RailLabel>Settings</RailLabel>
            </Show>
          </a>
        </Tooltip>
        <Tooltip
          placement="right"
          content={() => (
            <Column>
              <span>{props.user.username}</span>
              <Text class="label" size="small">
                {props.user.presence}
              </Text>
            </Column>
          )}
          aria={props.user.username}
        >
          <a
            ref={setMenuButton}
            class={entryContainer({ expanded: railExpanded() })}
          >
            <Avatar
              size={42}
              src={props.user.avatarURL}
              holepunch={"bottom-right"}
              overlay={<UserStatus.Graphic status={props.user.presence} />}
              interactive
            />
            <Show when={railExpanded()}>
              <RailUserText>
                <RailLabel>{props.user.displayName}</RailLabel>
                <RailSubLabel>
                  {props.user.username}#{props.user.discriminator}
                </RailSubLabel>
              </RailUserText>
            </Show>
          </a>
          <UserMenu anchor={menuButton} />
        </Tooltip>
        <For each={props.unreadConversations.slice(0, 9)}>
          {(conversation) => (
            <Tooltip placement="right" content={conversation.displayName}>
              <a
                class={entryContainer({ expanded: railExpanded() })}
                use:floating={props.menuGenerator(conversation)}
                href={`/channel/${conversation.id}`}
              >
                <Avatar
                  size={42}
                  // TODO: fix this
                  src={conversation.iconURL}
                  holepunch={conversation.unread ? "top-right" : "none"}
                  overlay={
                    <>
                      <Show when={conversation.unread}>
                        <Unreads.Graphic
                          count={conversation.mentions?.size ?? 0}
                          unread
                        />
                      </Show>
                    </>
                  }
                  fallback={
                    conversation.name ?? conversation.recipient?.username
                  }
                  interactive
                />
                <Show when={railExpanded()}>
                  <RailLabel>{conversation.displayName}</RailLabel>
                </Show>
              </a>
            </Tooltip>
          )}
        </For>
        <Show when={props.unreadConversations.length > 9}>
          <a
            class={entryContainer({ expanded: railExpanded() })}
            href={`/`}
          >
            <Avatar
              size={42}
              fallback={<>+{props.unreadConversations.length - 9}</>}
            />
            <Show when={railExpanded()}>
              <RailLabel>
                {props.unreadConversations.length - 9} more
              </RailLabel>
            </Show>
          </a>
        </Show>
        <Show
          when={device.layout() !== "phone"}
          fallback={<LineDivider />}
        >
          <DividerRow>
            <DividerLine />
            <ToggleButton
              type="button"
              expanded={railExpanded()}
              aria-label="Toggle sidebar width"
              onClick={() =>
                state.layout.toggleSectionState(
                  LAYOUT_SECTIONS.SERVER_RAIL_EXPANDED,
                  RAIL_EXPANDED_DEFAULT,
                )
              }
            >
              <MdChevronRight {...iconSize(20)} />
            </ToggleButton>
          </DividerRow>
        </Show>
        <Draggable
          type="servers"
          items={props.orderedServers}
          onChange={props.setServerOrder}
          //TODO - No channel ordering on mobile due to usability issue
          //Consider adding a way to enable reordering in user settings
          disabled={device.isMobile}
        >
          {(entry) => (
            <Tooltip
              placement="right"
              content={() => (
                <Column>
                  <Text class="label" size="large">
                    {entry.item.name}
                  </Text>{" "}
                  <Show when={state.notifications.isMuted(entry.item)}>
                    <Text class="label" size="small">
                      <Show
                        when={
                          state.notifications.getServerMute(entry.item)!.until
                        }
                        fallback={<Trans>Muted</Trans>}
                      >
                        <Trans>
                          Muted until{" "}
                          <Time
                            format="datetime"
                            value={
                              state.notifications.getServerMute(entry.item)!
                                .until
                            }
                          />
                        </Trans>
                      </Show>
                    </Text>
                  </Show>
                </Column>
              )}
              aria={entry.item.name}
            >
              <div
                class={entryContainer({
                  indicator:
                    props.selectedServer() === entry.item.id
                      ? "selected"
                      : entry.item.unread &&
                          !state.notifications.isMuted(entry.item)
                        ? "alert"
                        : undefined,
                  expanded: railExpanded(),
                })}
                use:floating={props.menuGenerator(entry.item)}
              >
                <a
                  class={entryLink({ expanded: railExpanded() })}
                  href={state.layout.getLastActiveServerPath(entry.item.id)}
                >
                  <Avatar
                    size={42}
                    src={entry.item.iconURL}
                    holepunch={
                      entry.item.mentions.length ? "top-right" : "none"
                    }
                    overlay={
                      <>
                        <Show
                          when={
                            entry.item.mentions
                              .length /* as opposed to item.unread */
                          }
                        >
                          <Unreads.Graphic
                            count={entry.item.mentions.length}
                            unread
                          />
                        </Show>
                      </>
                    }
                    fallback={entry.item.name}
                    interactive
                  />
                  <Show when={railExpanded()}>
                    <RailLabel>{entry.item.name}</RailLabel>
                  </Show>
                </a>
              </div>
            </Tooltip>
          )}
        </Draggable>
        <Tooltip placement="right" content={"Create or join a server"}>
          <a
            class={entryContainer({ expanded: railExpanded() })}
            onClick={() => props.onCreateOrJoinServer()}
          >
            <Avatar size={42} fallback={<MdAdd />} />
            <Show when={railExpanded()}>
              <RailLabel>Create or join a server</RailLabel>
            </Show>
          </a>
        </Tooltip>
        <Show when={CONFIGURATION.IS_STOAT}>
          <Tooltip placement="right" content={"Find new servers to join"}>
            <a
              href={state.layout.getLastActiveDiscoverPath()}
              class={entryContainer({ expanded: railExpanded() })}
            >
              <Avatar size={42} fallback={<MdExplore />} />
              <Show when={railExpanded()}>
                <RailLabel>Discover</RailLabel>
              </Show>
            </a>
          </Tooltip>
        </Show>
      </div>
      <Shadow>
        <div />
      </Shadow>
    </ServerListBase>
  );
};

/**
 * Server list container
 */
const ServerListBase = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,

    width: "56px",
    transition: "width var(--transitions-medium)",

    fill: "var(--md-sys-color-on-surface)",
  },
  variants: {
    expanded: {
      true: {
        width: "240px",
      },
      false: {},
    },
  },
  defaultVariants: {
    expanded: false,
  },
});

/**
 * Container around list of servers
 */
const listBase = cva({
  base: {
    flexGrow: 1,
  },
});

/**
 * Row wrapping the divider line and the expand/collapse toggle
 */
const DividerRow = styled("div", {
  base: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    gap: "6px",
    margin: "6px 0",
    paddingLeft: "12px",
    paddingRight: "8px",
  },
});

/**
 * The divider line itself (grows to fill the row, up to the toggle)
 */
const DividerLine = styled("div", {
  base: {
    flexGrow: 1,
    height: "1px",
    background: "var(--md-sys-color-outline-variant)",
  },
});

/**
 * Expand / collapse toggle, sat at the right end of the divider
 */
const ToggleButton = styled("button", {
  base: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "24px",
    height: "24px",
    padding: 0,

    border: "none",
    background: "transparent",
    cursor: "pointer",

    color: "var(--md-sys-color-on-surface-variant)",
    fill: "var(--md-sys-color-on-surface-variant)",
    transition: "var(--transitions-fast) color",

    "& svg": {
      transition: "var(--transitions-medium) transform",
    },

    "&:hover": {
      color: "var(--md-sys-color-on-surface)",
      fill: "var(--md-sys-color-on-surface)",
    },
  },
  variants: {
    expanded: {
      true: {
        "& svg": {
          transform: "rotate(180deg)",
        },
      },
      false: {},
    },
  },
  defaultVariants: {
    expanded: false,
  },
});

/**
 * Server entries
 */
const entryContainer = cva({
  base: {
    width: "56px",
    height: "56px",
    position: "relative",
    display: "grid",
    flexShrink: 0,
    placeItems: "center",

    "&:before": {
      content: "' '",
      position: "absolute",
      width: "12px",
      height: "0px",
      transition: "var(--transitions-fast) all",
      left: "-8px",
      borderRadius: "4px",
      background: "var(--md-sys-color-on-surface)",
    },

    "&:hover:before": {
      height: "16px",
    },
  },
  variants: {
    indicator: {
      selected: {
        "&:before": {
          height: "32px !important",
        },
      },
      alert: {
        "&:before": {
          height: "8px",
        },
      },
    },
    expanded: {
      true: {
        width: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-start",
        gap: "12px",
        paddingInline: "12px",
      },
      false: {},
    },
  },
  defaultVariants: {
    expanded: false,
  },
});

/**
 * Inner link for server entries (the draggable wrapper owns the indicator)
 */
const entryLink = cva({
  base: {
    display: "contents",
  },
  variants: {
    expanded: {
      true: {
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-start",
        gap: "12px",
        flexGrow: 1,
        minWidth: 0,
      },
      false: {},
    },
  },
  defaultVariants: {
    expanded: false,
  },
});

/**
 * Text label shown beside an avatar when the rail is expanded
 */
const RailLabel = styled("span", {
  base: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    textAlign: "start",

    fontSize: "14px",
    fontWeight: 500,
    color: "var(--md-sys-color-on-surface)",
  },
});

/**
 * Two-line text block for the logged-in user (name + username#discriminator)
 */
const RailUserText = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
  },
});

/**
 * Muted secondary label (the user's username#discriminator)
 */
const RailSubLabel = styled("span", {
  base: {
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",

    fontSize: "12px",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

/**
 * Divider line between two lists
 */
const LineDivider = styled("div", {
  base: {
    height: "1px",
    flexShrink: 0,
    margin: "6px auto",
    width: "calc(100% - 24px)",
    background: "var(--md-sys-color-outline-variant)",
  },
});

/**
 * Shadow at the bottom of the list
 */
const Shadow = styled("div", {
  base: {
    height: 0,
    zIndex: 1,
    position: "relative",

    "& div": {
      height: "12px",
      marginTop: "-12px",
      position: "absolute",
      background:
        "linear-gradient(to bottom, transparent, var(--md-sys-color-surface-container-highest))",
    },
  },
});
