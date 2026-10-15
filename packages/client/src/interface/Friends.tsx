import {
  Accessor,
  Match,
  Show,
  Switch,
  createMemo,
  createSignal,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { type RouteSectionProps, useNavigate } from "@solidjs/router";
import type { User } from "stoat.js";
import { cva } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import * as chatShell from "@revolt/client/chatShell";
import { IS_POPOUT_WINDOW } from "@revolt/client/popout";
import { useUserActions } from "@revolt/client/popoutBridge";
import { useDevice } from "@revolt/common";
import { useModals } from "@revolt/modal";
import { useState } from "@revolt/state";
import {
  Badge,
  Deferred,
  Header,
  IconButton,
  NavigationRail,
  NavigationRailItem,
  main,
} from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

// Relative: tsconfig has no `@revolt/friends` path (Vite would resolve it)
import {
  friendsWindowAvailable,
  openFriendsWindow,
  routeConversation,
} from "../../components/chatWindows/openConversation";
import { FriendSection } from "../../components/friends/FriendSection";
import { FriendsList } from "../../components/friends/FriendsList";
import { GroupChatsDock } from "../../components/friends/GroupChatsDock";
import { SelfBar } from "../../components/friends/SelfBar";

import { HeaderIcon } from "./common/CommonHeader";

/**
 * Base layout of the friends page
 */
const Base = styled("div", {
  base: {
    width: "100%",
    display: "flex",
    flexDirection: "column",

    "& .FriendsList": {
      height: "100%",
      paddingInline: "var(--gap-sm)",
      paddingBlockEnd: "var(--gap-lg)",
    },
  },
});

/**
 * Open the web's detachable friends-list popup. Web only: a desktop shell
 * would hand this URL to the system browser (Tauri) or refuse it (Electron).
 */
function openPopout() {
  window.open(
    "/friends-popout",
    "friends-popout",
    "width=420,height=650,resizable=yes,popup=yes",
  );
}

/**
 * Friends menu (also mounted directly on the `/friends` route, so the
 * props must stay route-component compatible)
 */
export function Friends(
  props: Partial<RouteSectionProps> & { popout?: boolean },
) {
  const { t } = useLingui();
  const client = useClient();
  const state = useState();
  const { openModal } = useModals();
  const navigate = useNavigate();
  const userActions = useUserActions();
  // The popout opens a second window; there is nowhere to put one on mobile.
  const { isMobile } = useDevice();

  // The web popout renders this page too, and bounces any navigation back
  // to itself, so nothing here may navigate from inside it.
  const inPopout = () => !!props.popout || IS_POPOUT_WINDOW;

  /**
   * Open the DM with a friend. `run("dm")` is the shared path: it resolves
   * the DM with `user.openDM()` and routes it with `routeConversation`
   * (chat window, or today's navigation), reports a denied or paused DM,
   * and from the popout hands the DM to the main window instead.
   */
  function openConversation(userId: string) {
    void userActions.run("dm", userId);
  }

  /**
   * Open a group chat from the dock (never shown in the popout)
   */
  function openGroup(channelId: string) {
    const channel = client().channels.get(channelId);
    routeConversation(state, channelId, () => {
      navigate(channel?.path ?? `/channel/${channelId}`);
      // on phones the conversation opens in the content pane, which may be
      // slid off-screen behind the sidebar
      state.appDrawer()?.setShown(true);
    });
  }

  /**
   * Pop-out button: on a desktop shell, in either DM mode, the friends
   * window; on the web, today's popout
   */
  function popOut() {
    if (chatShell.supported()) openFriendsWindow();
    else openPopout();
  }

  /**
   * Reference to the parent scroll container
   */
  let scrollTargetElement!: HTMLDivElement;

  /**
   * Signal required for reacting to ref changes
   */
  const targetSignal = () => scrollTargetElement;

  const [query, setQuery] = createSignal("");

  /**
   * Match a user against the current search query
   */
  function matches(user: User) {
    const search = query().trim().toLowerCase();
    if (!search) return true;
    return (
      user.displayName.toLowerCase().includes(search) ||
      user.username.toLowerCase().includes(search)
    );
  }

  /**
   * Generate the pending and blocked lists (the friends view is FriendsList)
   */
  const lists = createMemo(() => {
    const list = client()!.users.toList();

    const byName = (a: User, b: User) =>
      a.displayName.localeCompare(b.displayName);

    const relationship = (type: string) =>
      list.filter((user) => user.relationship === type).filter(matches);

    return {
      incoming: relationship("Incoming").sort(byName),
      outgoing: relationship("Outgoing").sort(byName),
      blocked: relationship("Blocked").sort(byName),
    };
  });

  /**
   * Incoming request count for the rail badge, unaffected by the search box
   */
  const pending = () => {
    const incoming = client()!
      .users.toList()
      .filter((user) => user.relationship === "Incoming").length;

    return incoming > 99 ? "99+" : incoming;
  };

  const [page, setPage] = createSignal("friends");

  return (
    <Base>
      <Header placement="primary">
        <HeaderIcon>
          <Symbol>group</Symbol>
        </HeaderIcon>
        <Trans>Friends</Trans>
        {/* A shell without the friends window gets no button: it must never
            fall back to window.open */}
        <Show
          when={
            !props.popout &&
            !window.opener &&
            !isMobile &&
            (!chatShell.supported() || friendsWindowAvailable())
          }
        >
          <IconButton
            onPress={popOut}
            use:floating={{
              tooltip: {
                placement: "bottom",
                content: t`Pop out friends list`,
              },
            }}
          >
            <Symbol>open_in_new</Symbol>
          </IconButton>
        </Show>
      </Header>

      <main class={main()}>
        <SelfBar />

        {/* FriendsList brings its own search and add-friend row */}
        <Show when={page() !== "friends"}>
          <div class={searchRow()}>
            <IconButton
              variant="filled"
              shape="square"
              onPress={() =>
                openModal({
                  type: "add_friend",
                  client: client(),
                })
              }
              use:floating={{
                tooltip: {
                  placement: "bottom",
                  content: t`Add a new friend`,
                },
              }}
            >
              <Symbol>person_add</Symbol>
            </IconButton>

            <div class={searchField()}>
              <Symbol size={18}>search</Symbol>
              <input
                value={query()}
                placeholder="Search friends"
                onInput={(e) => setQuery(e.currentTarget.value)}
              />
              <Show when={query()}>
                <button
                  class={clearButton()}
                  aria-label="Clear search"
                  onClick={() => setQuery("")}
                >
                  <Symbol size={18}>close</Symbol>
                </button>
              </Show>
            </div>
          </div>
        </Show>

        <div
          style={{
            position: "relative",
            "flex-grow": 1,
            "min-height": 0,
          }}
        >
          <NavigationRail contained value={page} onValue={setPage}>
            <NavigationRailItem icon={<Symbol>group</Symbol>} value="friends">
              <Trans>Friends</Trans>
            </NavigationRailItem>
            <NavigationRailItem
              icon={<Symbol>notifications</Symbol>}
              value="pending"
            >
              <Trans>Pending</Trans>
              <Show when={pending()}>
                <Badge slot="badge" variant="large">
                  {pending()}
                </Badge>
              </Show>
            </NavigationRailItem>
            <NavigationRailItem icon={<Symbol>block</Symbol>} value="blocked">
              <Trans>Blocked</Trans>
            </NavigationRailItem>
          </NavigationRail>

          <Deferred>
            <Show
              when={page() !== "friends"}
              fallback={
                <div class={friendsPane()}>
                  <div class={friendsListArea()}>
                    <FriendsList onOpenConversation={openConversation} />
                  </div>
                  {/* The popout cannot navigate and has no channel hand-off
                      to main, so a group there would be a dead row */}
                  <Show when={!inPopout()}>
                    <GroupChatsDock onOpen={openGroup} />
                  </Show>
                </div>
              }
            >
              <div class="FriendsList" ref={scrollTargetElement} use:scrollable>
                <Switch>
                  <Match when={page() === "pending"}>
                    <ListSection
                      id="incoming"
                      label="Incoming"
                      users={lists().incoming}
                      scrollTargetElement={targetSignal}
                    />
                    <ListSection
                      id="outgoing"
                      label="Outgoing"
                      users={lists().outgoing}
                      scrollTargetElement={targetSignal}
                    />
                  </Match>
                  <Match when={page() === "blocked"}>
                    <ListSection
                      id="blocked"
                      label={t`Blocked`}
                      users={lists().blocked}
                      scrollTargetElement={targetSignal}
                    />
                  </Match>
                </Switch>
              </div>
            </Show>
          </Deferred>
        </div>
      </main>
    </Base>
  );
}

/**
 * Section of the list, its collapse state kept in the friends store
 */
function ListSection(props: {
  id: string;
  label: string;
  users: User[];
  scrollTargetElement: Accessor<HTMLDivElement>;
}) {
  const state = useState();

  return (
    <FriendSection
      key={props.id}
      title={props.label}
      users={props.users}
      collapsed={state.friends.isCollapsed(props.id)}
      onToggle={() => state.friends.toggleCollapsed(props.id)}
      scrollTarget={props.scrollTargetElement}
    />
  );
}

const searchRow = cva({
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    paddingBlock: "var(--gap-sm)",
  },
});

const searchField = cva({
  base: {
    // deliberately narrow — the row reads as "add friend, then filter",
    // not as a full-width search bar. Shrinks below this on narrow windows.
    width: "180px",
    minWidth: 0,
    height: "40px",
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    paddingInline: "var(--gap-md)",
    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface-variant)",

    "& input": {
      all: "unset",
      flexGrow: 1,
      minWidth: 0,
      fontSize: "14px",
      color: "var(--md-sys-color-on-surface)",
    },
  },
});

const clearButton = cva({
  base: {
    all: "unset",
    display: "flex",
    cursor: "pointer",
    color: "var(--md-sys-color-on-surface-variant)",

    "&:hover": {
      color: "var(--md-sys-color-on-surface)",
    },
  },
});

/**
 * Friends view: the list fills the space and the group chats dock sits
 * under it, as in the chat-windows friends window
 */
const friendsPane = cva({
  base: {
    height: "100%",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
  },
});

// FriendsList scrolls itself; this only bounds its height
const friendsListArea = cva({
  base: {
    position: "relative",
    flexGrow: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
});
