import {
  Accessor,
  Match,
  Show,
  Switch,
  createMemo,
  createSignal,
  onMount,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { type RouteSectionProps } from "@solidjs/router";
import { VirtualContainer } from "@minht11/solid-virtual-container";
import type { User } from "stoat.js";
import { cva } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { UserContextMenu } from "@revolt/app";
import { useClient, useUser } from "@revolt/client";
import { useUserActions } from "@revolt/client/popoutBridge";
import { voiceChannelOf } from "@revolt/client/voicePresence";
import { tauriInvoke, useDevice } from "@revolt/common";
import { useModals } from "@revolt/modal";
import { useState } from "@revolt/state";
import {
  Avatar,
  Badge,
  Deferred,
  Header,
  IconButton,
  NavigationRail,
  NavigationRailItem,
  UserStatus,
  isSlogaStaff,
  main,
  usePresenceText,
} from "@revolt/ui";
import { DisplayName } from "@revolt/ui/components/features/DisplayName";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { HeaderIcon } from "./common/CommonHeader";
import { UserMenu } from "./navigation/servers/UserMenu";

/**
 * Height of a single friend row, in pixels
 *
 * Panda only extracts statically analysable values, so the row styling
 * below repeats this as a literal — keep the two in step or virtualisation
 * will drift out of line with what is drawn.
 */
const ROW_HEIGHT = 46;

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
 * Electron (Linux) shell popout surface — the preload exposes it only
 * inside the popout window itself.
 */
function electronPopout():
  | {
      getState(): { alwaysOnTop: boolean } | null;
      setAlwaysOnTop(value: boolean): Promise<unknown>;
    }
  | undefined {
  return (
    window as {
      slogaShell?: { popout?: ReturnType<typeof electronPopout> };
    }
  ).slogaShell?.popout;
}

/**
 * Open the detachable friends-list window. The Windows shell builds a
 * native window via IPC; on web this is a browser popup, which the Linux
 * shell's main process intercepts and replaces with a native window.
 */
function openPopout() {
  const invoke = tauriInvoke();
  if (invoke) {
    invoke("open_friends_popout").catch(console.error);
    return;
  }
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
export function Friends(props: Partial<RouteSectionProps> & { popout?: boolean }) {
  const { t } = useLingui();
  const client = useClient();
  const state = useState();
  const { openModal } = useModals();
  // The popout opens a second window; there is nowhere to put one on mobile.
  const { isMobile } = useDevice();

  // Always-on-top pin (popout window on a desktop shell only).
  const [pinned, setPinned] = createSignal(false);
  const pinSupported = () => !!tauriInvoke() || !!electronPopout();
  onMount(() => {
    if (!props.popout) return;
    const invoke = tauriInvoke();
    if (invoke) {
      invoke<boolean>("friends_popout_state")
        .then(setPinned)
        .catch(() => void 0);
    } else {
      const state = electronPopout()?.getState();
      if (state) setPinned(state.alwaysOnTop);
    }
  });
  function togglePin() {
    const next = !pinned();
    setPinned(next);
    const revert = () => setPinned(!next);
    const invoke = tauriInvoke();
    if (invoke) {
      invoke("friends_popout_set_always_on_top", { value: next }).catch(revert);
    } else {
      electronPopout()?.setAlwaysOnTop(next).catch(revert);
    }
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
   * Generate lists of all users
   */
  const lists = createMemo(() => {
    const list = client()!.users.toList();

    const byName = (a: User, b: User) =>
      a.displayName.localeCompare(b.displayName);

    const relationship = (type: string) =>
      list.filter((user) => user.relationship === type).filter(matches);

    const friends = relationship("Friend").sort(byName);
    const favourite = (user: User) => state.friends.isFavourite(user.id);

    return {
      // favourites keep online users on top, the way the sections do
      favourites: friends
        .filter(favourite)
        .sort((a, b) => Number(b.online) - Number(a.online) || byName(a, b)),
      online: friends.filter((user) => user.online && !favourite(user)),
      offline: friends.filter((user) => !user.online && !favourite(user)),
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
        <Show when={!props.popout && !window.opener && !isMobile}>
          <IconButton
            onPress={openPopout}
            use:floating={{ tooltip: { placement: "bottom", content: t`Pop out friends list` } }}
          >
            <Symbol>open_in_new</Symbol>
          </IconButton>
        </Show>
        <Show when={props.popout && pinSupported()}>
          <IconButton
            onPress={togglePin}
            use:floating={{
              tooltip: {
                placement: "bottom",
                // plain strings on purpose — same precedent as the rail's
                // hardcoded tooltips; avoids a catalog resync
                content: pinned() ? "Unpin from top" : "Keep on top",
              },
            }}
          >
            <Symbol fill={pinned()}>keep</Symbol>
          </IconButton>
        </Show>
      </Header>

      <main class={main()}>
        <SelfBar />

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
            <div class="FriendsList" ref={scrollTargetElement} use:scrollable>
              <Switch
                fallback={
                  <>
                    <Section
                      id="favourites"
                      label="Favorites"
                      users={lists().favourites}
                      scrollTargetElement={targetSignal}
                      hideWhenEmpty
                    />
                    <Section
                      id="online"
                      label={t`Online`}
                      users={lists().online}
                      scrollTargetElement={targetSignal}
                      hideWhenEmpty={!!query()}
                    />
                    <Section
                      id="offline"
                      label={t`Offline`}
                      users={lists().offline}
                      scrollTargetElement={targetSignal}
                      hideWhenEmpty={!!query()}
                    />
                  </>
                }
              >
                <Match when={page() === "pending"}>
                  <Section
                    id="incoming"
                    label="Incoming"
                    users={lists().incoming}
                    scrollTargetElement={targetSignal}
                  />
                  <Section
                    id="outgoing"
                    label="Outgoing"
                    users={lists().outgoing}
                    scrollTargetElement={targetSignal}
                  />
                </Match>
                <Match when={page() === "blocked"}>
                  <Section
                    id="blocked"
                    label={t`Blocked`}
                    users={lists().blocked}
                    scrollTargetElement={targetSignal}
                  />
                </Match>
              </Switch>
            </div>
          </Deferred>
        </div>
      </main>
    </Base>
  );
}

/**
 * Your own avatar, name and presence; clicking it opens the same menu as
 * the avatar in the server rail. This is the only way to change presence
 * from the popout window, which has no app chrome of its own.
 */
function SelfBar() {
  const user = useUser();
  const presence = usePresenceText();
  const [anchor, setAnchor] = createSignal<HTMLDivElement>();

  return (
    <>
      <div class={selfBar()} ref={setAnchor}>
        <Avatar
          size={36}
          src={user()?.animatedAvatarURL}
          fallback={user()?.username}
          holepunch="bottom-right"
          overlay={<UserStatus.Graphic status={user()?.presence} />}
        />
        <div class={nameStack()}>
          <div class={selfName()}>
            <span class={ellipsis()}>
              <DisplayName
                user={user()}
                name={user()?.displayName ?? ""}
                brand={isSlogaStaff(user())}
              />
            </span>
            <Symbol size={18}>expand_more</Symbol>
          </div>
          <div class={`${statusText()} ${ellipsis()}`}>
            {user()?.status?.text ?? presence.pickerLabel(user()?.presence)}
          </div>
        </div>
      </div>
      <UserMenu anchor={anchor} />
    </>
  );
}

/**
 * Collapsible section of the list
 */
function Section(props: {
  id: string;
  label: string;
  users: User[];
  scrollTargetElement: Accessor<HTMLDivElement>;
  hideWhenEmpty?: boolean;
}) {
  const state = useState();

  const collapsed = () => state.friends.isCollapsed(props.id);

  return (
    <Show when={!(props.hideWhenEmpty && props.users.length === 0)}>
      <div
        class={sectionHeader()}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed()}
        onClick={() => state.friends.toggleCollapsed(props.id)}
      >
        <Symbol size={18}>
          {collapsed() ? "chevron_right" : "expand_more"}
        </Symbol>
        <span>
          {props.label} ({props.users.length})
        </span>
      </div>

      <Show when={!collapsed()}>
        <Show when={props.users.length === 0}>
          <div class={emptyRow()}>
            <Trans>Nobody here right now!</Trans>
          </div>
        </Show>

        <VirtualContainer
          items={props.users}
          scrollTarget={props.scrollTargetElement()}
          itemSize={{ height: ROW_HEIGHT }}
        >
          {(item) => (
            <div style={{ ...item.style, width: "100%" }}>
              <Entry user={item.item} tabIndex={item.tabIndex} />
            </div>
          )}
        </VirtualContainer>
      </Show>
    </Show>
  );
}

/**
 * Single user entry
 */
function Entry(props: { user: User; tabIndex?: number }) {
  const { t } = useLingui();
  const presence = usePresenceText();
  const { openModal } = useModals();
  const state = useState();
  const client = useClient();
  const userActions = useUserActions();

  // Delay single-click so a double-click can cancel it and open the DM instead
  let clickTimer: number | undefined;

  function onClick() {
    if (clickTimer !== undefined) return;
    // capture now: virtualisation can recycle this row onto another user
    // before the timer fires
    const user = props.user;
    clickTimer = window.setTimeout(() => {
      clickTimer = undefined;
      openModal({ type: "user_profile", user });
    }, 250);
  }

  function onDblClick() {
    if (clickTimer !== undefined) {
      window.clearTimeout(clickTimer);
      clickTimer = undefined;
    }

    // run() never rejects (failures surface as a snackbar); in the popout it
    // hands the DM to the main window, since the popout bounces navigation
    void userActions.run("dm", props.user.id);
  }

  const isFriend = () => props.user.relationship === "Friend";
  const favourite = () => state.friends.isFavourite(props.user.id);

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
      onClick={onClick}
      onDblClick={onDblClick}
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

const selfBar = cva({
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-md)",
    padding: "var(--gap-sm)",
    marginBlockStart: "var(--gap-sm)",
    borderRadius: "var(--borderRadius-md)",
    cursor: "pointer",
    userSelect: "none",
    color: "var(--md-sys-color-on-surface)",

    "&:hover": {
      background: "var(--md-sys-color-surface-container-high)",
    },
  },
});

const selfName = cva({
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    minWidth: 0,
    fontSize: "15px",
    fontWeight: 500,
  },
});

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

const sectionHeader = cva({
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    paddingInline: "var(--gap-sm)",
    paddingBlock: "var(--gap-sm)",
    marginBlockStart: "var(--gap-sm)",
    cursor: "pointer",
    userSelect: "none",
    fontSize: "12px",
    fontWeight: 500,
    color: "var(--md-sys-color-on-surface-variant)",

    "&:hover": {
      color: "var(--md-sys-color-on-surface)",
    },
  },
});

const emptyRow = cva({
  base: {
    paddingInline: "var(--gap-sm)",
    paddingBlock: "var(--gap-sm)",
    fontSize: "13px",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

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

    "&:hover": {
      background: "var(--md-sys-color-surface-container-high)",
    },

    "&:hover .favourite, & .favourite[data-active='true']": {
      opacity: 1,
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
