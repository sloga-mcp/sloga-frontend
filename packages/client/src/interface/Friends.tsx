import {
  Accessor,
  JSX,
  Match,
  Show,
  Switch,
  createMemo,
  createSignal,
  onMount,
  splitProps,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { type RouteSectionProps, useNavigate } from "@solidjs/router";
import { VirtualContainer } from "@minht11/solid-virtual-container";
import type { User } from "stoat.js";
import { styled } from "styled-system/jsx";

import { UserContextMenu } from "@revolt/app";
import { useClient } from "@revolt/client";
import { IS_POPOUT_WINDOW } from "@revolt/client/popout";
import { useModals } from "@revolt/modal";
import {
  Avatar,
  Badge,
  Deferred,
  Header,
  IconButton,
  List,
  ListItem,
  ListSubheader,
  NavigationRail,
  NavigationRailItem,
  OverflowingText,
  UserStatus,
  main,
} from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

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
      paddingInline: "var(--gap-lg)",
    },
  },
});

/**
 * Tauri invoke, when running inside the Windows desktop shell.
 */
function tauriInvoke():
  | (<T>(cmd: string, args?: Record<string, unknown>) => Promise<T>)
  | undefined {
  return (
    window as {
      __TAURI__?: {
        core?: {
          invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
        };
      };
    }
  ).__TAURI__?.core?.invoke;
}

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
  const { openModal } = useModals();

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

  /**
   * Generate lists of all users
   */
  const lists = createMemo(() => {
    const list = client()!.users.toList();

    const friends = list
      .filter((user) => user.relationship === "Friend")
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    return {
      friends,
      online: friends.filter((user) => user.online),
      incoming: list
        .filter((user) => user.relationship === "Incoming")
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
      outgoing: list
        .filter((user) => user.relationship === "Outgoing")
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
      blocked: list
        .filter((user) => user.relationship === "Blocked")
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    };
  });

  const pending = () => {
    const incoming = lists().incoming;
    return incoming.length > 99 ? "99+" : incoming.length;
  };

  const [page, setPage] = createSignal("online");

  return (
    <Base>
      <Header placement="primary">
        <HeaderIcon>
          <Symbol>group</Symbol>
        </HeaderIcon>
        <Trans>Friends</Trans>
        <Show when={!props.popout && !window.opener}>
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
        <div
          style={{
            position: "relative",
            "min-height": 0,
          }}
        >
          <NavigationRail contained value={page} onValue={setPage}>
            <div style={{ "margin-top": "6px", "margin-bottom": "12px" }}>
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
                    placement: "right",
                    content: t`Add a new friend`,
                  },
                }}
              >
                <Symbol>add</Symbol>
              </IconButton>
            </div>

            <NavigationRailItem
              icon={<Symbol>waving_hand</Symbol>}
              value="online"
            >
              <Trans>Online</Trans>
            </NavigationRailItem>
            <NavigationRailItem icon={<Symbol>all_inbox</Symbol>} value="all">
              <Trans>All</Trans>
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
                  <People
                    title="Online"
                    users={lists().online}
                    scrollTargetElement={targetSignal}
                  />
                }
              >
                <Match when={page() === "all"}>
                  <People
                    title="All"
                    users={lists().friends}
                    scrollTargetElement={targetSignal}
                  />
                </Match>
                <Match when={page() === "pending"}>
                  <People
                    title="Incoming"
                    users={lists().incoming}
                    scrollTargetElement={targetSignal}
                  />
                  <People
                    title="Outgoing"
                    users={lists().outgoing}
                    scrollTargetElement={targetSignal}
                  />
                </Match>
                <Match when={page() === "blocked"}>
                  <People
                    title="Blocked"
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
 * List of users
 */
function People(props: {
  users: User[];
  title: string;
  scrollTargetElement: Accessor<HTMLDivElement>;
}) {
  return (
    <List>
      <ListSubheader>
        {props.title} {"–"} {props.users.length}
      </ListSubheader>

      <Show when={props.users.length === 0}>
        <ListItem disabled>
          <Trans>Nobody here right now!</Trans>
        </ListItem>
      </Show>

      <VirtualContainer
        items={props.users}
        scrollTarget={props.scrollTargetElement()}
        itemSize={{ height: 58 }}
        // grid rendering:
        // itemSize={{ height: 60, width: 240 }}
        // crossAxisCount={(measurements) =>
        //   Math.floor(measurements.container.cross / measurements.itemSize.cross)
        // }
        // width: 100% needs to be removed from listentry below for this to work ^^^
      >
        {(item) => (
          <ContainerListEntry
            style={{
              ...item.style,
            }}
          >
            <Entry
              role="listitem"
              tabIndex={item.tabIndex}
              style={item.style}
              user={item.item}
            />
          </ContainerListEntry>
        )}
      </VirtualContainer>
    </List>
  );
}

const ContainerListEntry = styled("div", {
  base: {
    width: "100%",
  },
});

/**
 * Single user entry
 */
function Entry(
  props: { user: User } & Omit<
    JSX.AnchorHTMLAttributes<HTMLAnchorElement>,
    "href"
  >,
) {
  const { openModal } = useModals();
  const navigate = useNavigate();
  const [local, remote] = splitProps(props, ["user"]);

  // Delay single-click so a double-click can cancel it and open the DM instead
  let clickTimer: number | undefined;

  function onClick() {
    if (clickTimer !== undefined) return;
    clickTimer = window.setTimeout(() => {
      clickTimer = undefined;
      openModal({ type: "user_profile", user: local.user });
    }, 250);
  }

  function onDblClick() {
    if (clickTimer !== undefined) {
      window.clearTimeout(clickTimer);
      clickTimer = undefined;
    }

    // In the popout window the app shell would bounce this navigation
    // straight back (single full-client model) — the profile modal via
    // single-click is the popout's affordance.
    if (IS_POPOUT_WINDOW) return;

    local.user.openDM().then((channel) => navigate(channel.path)).catch(console.error);
  }

  return (
    <a
      {...remote}
      use:floating={{
        contextMenu: () => <UserContextMenu user={local.user} />,
      }}
      onClick={onClick}
      onDblClick={onDblClick}
    >
      <ListItem>
        <Avatar
          slot="icon"
          size={36}
          src={local.user.animatedAvatarURL}
          holepunch={
            props.user.relationship === "Friend" ? "bottom-right" : "none"
          }
          overlay={
            <Show when={props.user.relationship === "Friend"}>
              <UserStatus.Graphic
                status={props.user.status?.presence ?? "Online"}
              />
            </Show>
          }
        />
        <OverflowingText>{local.user.displayName}</OverflowingText>
      </ListItem>
    </a>
  );
}
