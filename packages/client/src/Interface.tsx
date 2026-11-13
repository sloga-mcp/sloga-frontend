import {
  createEffect,
  createSignal,
  ErrorBoundary,
  JSX,
  lazy,
  Match,
  onCleanup,
  Show,
  Switch,
  untrack,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { Server } from "stoat.js";
import { styled } from "styled-system/jsx";

import { ChannelContextMenu, ServerContextMenu } from "@revolt/app";
import { ConnectionIndicator } from "@revolt/app/interface/ConnectionIndicator";
import { MessageCache } from "@revolt/app/interface/channels/text/MessageCache";
import { useClient, useClientLifecycle } from "@revolt/client";
import { ActivityWorker } from "@revolt/client/ActivityWorker";
import { ApkUpdateWorker } from "@revolt/client/ApkUpdateWorker";
import { ChannelListQueriesWorker } from "@revolt/client/ChannelListQueriesWorker";
import { DiscordImportWorker } from "@revolt/client/DiscordImportWorker";
import { E2EEDeviceToastWorker } from "@revolt/client/E2EEDeviceToastWorker";
import { FossUpdateNotice } from "@revolt/client/FossUpdateNotice";
import { KeybindsWorker } from "@revolt/client/KeybindsWorker";
import { NotificationsWorker } from "@revolt/client/NotificationsWorker";
import { ShellBridgeWorker } from "@revolt/client/ShellBridgeWorker";
import { StreamerModeWorker } from "@revolt/client/StreamerModeWorker";
import {
  offerSignOutWhileLoading,
  SIGN_OUT_OFFER_AFTER_MS,
} from "@revolt/client/connectionPolicy";
import { IS_OVERLAY_WINDOW, IS_POPOUT_WINDOW } from "@revolt/client/popout";
import { slimIsRoot, slimRedirectFor } from "@revolt/client/slimRoutePolicy";
import { useSlimMode } from "@revolt/client/useSlimMode";
import { useModals } from "@revolt/modal";
import {
  Navigate,
  useBeforeLeave,
  useLocation,
  useNavigate,
} from "@revolt/routing";
import { OverlayBridgeWorker } from "@revolt/rtc/overlay/OverlayBridgeWorker";
import { useState } from "@revolt/state";
import { LAYOUT_SECTIONS } from "@revolt/state/stores/Layout";
import { streamerModeActive } from "@revolt/state/streamer";
import {
  Button,
  CircularProgress,
  Column,
  Text,
  useLayoutSides,
} from "@revolt/ui";
import { IncomingCallOverlay } from "@revolt/ui/components/features/voice/IncomingCallOverlay";
import { CallRecordingNotices } from "@revolt/ui/components/features/voice/callCard/CallRecordingNotices";
import { RemoteControlOverlays } from "@revolt/ui/components/features/voice/callCard/RemoteControlOverlays";
import { VoiceMoveNotices } from "@revolt/ui/components/features/voice/callCard/VoiceMoveNotices";
import { VoiceTranscriptPanel } from "@revolt/ui/components/features/voice/callCard/VoiceTranscriptPanel";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { ChatWindowsHost } from "../components/chatWindows/ChatWindowsHost";
import { SlideDrawer } from "../components/ui/components/navigation/SlideDrawer";
import { PaneErrorBoundary } from "./interface/PaneErrorBoundary";
import { Sidebar } from "./interface/Sidebar";
import { loginReturnPath } from "./lib/deepLinks";

// DEV only: a dynamic import behind the folded constant, so production
// bundles don't carry the harness at all.
const ChatWinDevHarness = import.meta.env.DEV
  ? lazy(() =>
      import("../components/chatWindows/devHarness").then((m) => ({
        default: m.ChatWinDevHarness,
      })),
    )
  : () => null;

/**
 * Application layout
 */
const Interface = (props: { children: JSX.Element }) => {
  // The friends popout window must never host the full app shell (single
  // full-client model — see @revolt/client/popout): any navigation that
  // escapes /friends-popout (e.g. the post-login redirect) bounces straight
  // back instead of booting a second set of workers over a web-mode client.
  // Friend double-click and the message/call actions don't navigate here:
  // useUserActions forwards them to the main window, where
  // ShellBridgeWorker (below) opens the DM or starts the call.
  // Both window flags are frozen at module init, so neither early return has
  // a re-render to miss.
  if (IS_POPOUT_WINDOW) {
    // eslint-disable-next-line solid/components-return-once
    return <Navigate href="/friends-popout" />;
  }

  // Same bounce for the in-game overlay window, and belt-and-suspenders:
  // MountContext has already short-circuited the entire provider stack for
  // it, so `Interface` cannot actually render here — every hook below would
  // be missing its provider if it did.
  if (IS_OVERLAY_WINDOW) {
    // eslint-disable-next-line solid/components-return-once
    return <Navigate href="/voice-overlay" />;
  }

  const state = useState();
  const client = useClient();
  const { t } = useLingui();
  const { openModal } = useModals();
  const { isLoggedIn, lifecycle } = useClientLifecycle();
  const routeLocation = useLocation();
  // These two are read once, as before: the router's location is an object
  // of getters, so destructuring it keeps the path this component mounted
  // on. The Slim view effects below read `routeLocation.pathname` instead,
  // which follows the route.
  const { pathname, search } = routeLocation;
  const navigate = useNavigate();
  const sides = useLayoutSides();
  // Whether Slim view is active on this device. With it off, nothing added
  // for it below acts, and the tree renders exactly as it did before.
  const slim = useSlimMode();

  useBeforeLeave((e) => {
    if (!e.defaultPrevented) {
      if (e.to === "/settings") {
        e.preventDefault();
        openModal({ type: "settings", config: "user" });
      } else if (typeof e.to === "string") {
        state.layout.setLastActivePath(e.to);
      }
    }
  });

  createEffect(() => {
    if (!isLoggedIn()) {
      // Keeps the query string for settings deep links
      // (`/settings?cipher_tier=T149`), and never stores a path that
      // resolves to another origin (see src/lib/deepLinks.ts).
      state.layout.setNextPath(loginReturnPath(pathname, search));
      console.debug("WAITING... currently", lifecycle.state());
    }
  });

  //Drawer slider for mobile
  let rootRef, sDrawer: SlideDrawer | undefined;
  const [contRef, setContRef] = createSignal<HTMLDivElement>();
  // Reset both nav sections to their defaults so the slide drawer owns
  // visibility at phone widths. setSectionState clears the stored override
  // when value === defaultValue, so both calls below drop their override
  // instead of writing one — passing `false` against MEMBER_SIDEBAR's `true`
  // default persisted "members hidden" into the settings store, which then
  // followed the account onto desktop and every later session.
  function rstLayout() {
    state.layout.setSectionState(LAYOUT_SECTIONS.PRIMARY_SIDEBAR, false, false);
    state.layout.setSectionState(LAYOUT_SECTIONS.MEMBER_SIDEBAR, true, true);
  }
  createEffect(() => {
    //Create drawer
    const cont = contRef();
    if (cont && !sDrawer) sDrawer = new SlideDrawer(cont, rootRef!);
    //Update on layout change
    if (sDrawer) {
      const en = sDrawer.enabled;
      setTimeout(() => {
        state.setAppDrawer(en ? sDrawer : undefined);
        if (en) rstLayout();
      }, 1);
    }
  });
  onCleanup(() => {
    sDrawer?.delete();
    state.setAppDrawer((sDrawer = undefined));
  });

  // Slim view route gate. Slim view does not show server routes, so one that
  // is reached any way at all (a link, a saved path, the back stack, or Slim
  // view being switched on while sitting on one) goes to the Slim view root.
  // `replace` keeps the blocked page out of the back stack. The policy never
  // redirects the root itself, so this cannot loop.
  //
  // It waits for `loadedOnce`: a staff account never gets Slim view, but that
  // is only known once the signed-in user has loaded, and until then `slim()`
  // can read true on a device whose stored setting is on. `isLoggedIn` covers
  // signing out, where the lifecycle leaves the signed-in states a moment
  // before `loadedOnce` is cleared and the `/login` redirect below owns the
  // route.
  createEffect(() => {
    if (!isLoggedIn() || !lifecycle.loadedOnce() || !slim()) return;

    const target = slimRedirectFor(routeLocation.pathname);
    if (target !== null) navigate(target, { replace: true });
  });

  // Slim view on the phone layout: at the root the content pane is only a
  // placeholder, so the drawer rests on the navigation column, which is the
  // chat list. `setShown(false)` is what shows it: the drawer is built over
  // the content pane, so `show` means "content shown".
  //
  // This runs when the drawer is published (a cold start, or the layout
  // narrowing to a phone), when the path becomes the root (the gate above
  // redirecting there included) and when Slim view is switched on at the
  // root. It does not hold the drawer there: opening a chat changes the path,
  // and the list entry's own `setShown(true)` slides to it as before.
  //
  // `state.appDrawer()` is `undefined` unless the drawer is enabled, so this
  // does nothing on wide layouts.
  createEffect(() => {
    const drawer = state.appDrawer();
    if (!drawer || !isLoggedIn() || !lifecycle.loadedOnce() || !slim()) return;
    // `/app` is where login lands and where the wordmark links; it renders
    // the same placeholder as the root, so it rests the same way.
    if (!slimIsRoot(routeLocation.pathname)) return;

    // `setShown` reads the drawer's own signals, which are not this effect's
    // business. It refuses mid-swipe and mid-animation; only then is the
    // drawer state followed, so this runs again once it settles. After a call
    // that went through nothing here reads the state, and a later swipe to
    // the content pane is left alone.
    if (!untrack(() => drawer.setShown(false))) void drawer.state;
  });

  return (
    <MessageCache client={client()}>
      <AppRoot ref={rootRef} class="app_root">
        <ConnectionIndicator />
        <Show
          when={
            streamerModeActive(state.settings) &&
            (state.settings.getValue("streamer:show_banner") ?? true)
          }
        >
          <StreamerBanner
            onClick={() => openModal({ type: "settings", config: "user" })}
          >
            <Symbol size={16}>videocam</Symbol>
            <Trans>
              Streamer Mode is on — personal info, invites and notifications are
              hidden
            </Trans>
            <BannerClose
              aria-label={t`Hide banner`}
              title={t`Hide banner`}
              onClick={(event) => {
                event.stopPropagation();
                state.settings.setValue("streamer:show_banner", false);
              }}
            >
              <Symbol size={16}>close</Symbol>
            </BannerClose>
          </StreamerBanner>
        </Show>
        <Switch fallback={<LoadingScreen />}>
          <Match when={!isLoggedIn()}>
            <Navigate href="/login" />
          </Match>
          <Match when={lifecycle.loadedOnce()}>
            {/* file drops are cancelled app-wide by FileDropGuard, mounted
                at the root — this subtree used to do it alone, which left
                modals, portals and the login page navigating away */}
            <Layout
              navRight={sides().nav === "right"}
              style={{ "flex-grow": 1, "min-height": 0 }}
            >
              <Sidebar
                menuGenerator={(target) => ({
                  contextMenu: () => {
                    return (
                      <>
                        {target instanceof Server ? (
                          <ServerContextMenu server={target} />
                        ) : (
                          <ChannelContextMenu channel={target} />
                        )}
                      </>
                    );
                  },
                })}
              />
              <Content
                ref={setContRef}
                class="app_body"
                // Slim view keeps the sidebar open whatever the stored
                // collapse state says (see `showSidebar` in Sidebar.tsx)
                sidebar={
                  slim() ||
                  state.layout.getSectionState(
                    LAYOUT_SECTIONS.PRIMARY_SIDEBAR,
                    true,
                  )
                }
                navRight={sides().nav === "right"}
              >
                <PaneErrorBoundary pane="content">
                  {/* Slim view only: a crash in the routed content offers the
                      way out of Slim view. With Slim view off there is no
                      extra boundary, so an error reaches the pane boundary
                      above exactly as before. Switching Slim view builds the
                      routed content again: a boundary catches for what was
                      created under it, so one cannot be put around, or taken
                      off, a page that is already mounted. */}
                  <Show when={slim()} fallback={props.children}>
                    <ErrorBoundary
                      fallback={(error, reset) => {
                        console.error("[slim-error]", error);

                        return (
                          <SlimCrashed
                            error={error}
                            onTurnOff={() => {
                              // Slim view going off swaps this boundary for
                              // the plain content, which is what brings the
                              // full app back. The reset covers a build
                              // where Slim view stays on regardless.
                              state.settings.setValue(
                                "appearance:slim_view",
                                false,
                              );
                              reset();
                            }}
                          />
                        );
                      }}
                    >
                      {props.children}
                    </ErrorBoundary>
                  </Show>
                </PaneErrorBoundary>
              </Content>
            </Layout>
          </Match>
        </Switch>

        <NotificationsWorker />
        <E2EEDeviceToastWorker />
        {/* Receives friends-popout actions and notification clicks from the
            shell (or, on web, the popout's postMessage) and runs them in this
            window. Main window only: the popout and overlay never reach this
            render, they returned at the top of this component. */}
        <ShellBridgeWorker />
        <ActivityWorker />
        <StreamerModeWorker />
        <ApkUpdateWorker />
        <ChannelListQueriesWorker />
        <FossUpdateNotice />
        {/* Global and in-app keybinds, over the native hook and the focused
            window. Main window only. It reads the `Voice` store, so it has to
            sit inside `<VoiceContext>` — which it does here, and would in
            `src/index.tsx` too, but there it would also run in the friends
            popout: `MountContext` short-circuits only for the overlay window,
            so the popout builds the full provider stack, and the workers
            above are spared only by the `IS_POPOUT_WINDOW` redirect at the
            top of this component. In the popout the native arm is ACL-denied
            (`keybinds_arm` is granted to `main` alone), but the DOM listener
            would still fire against that window's roomless `Voice`, and a
            bound key would act on the wrong instance. */}
        <KeybindsWorker />
        {/* Publishes the in-game overlay's roster/speaking state to the
            overlay window and owns that window's lifetime. Main window only
            — this is the window that owns the LiveKit Room, and
            `isSpeaking` has no other source. */}
        <OverlayBridgeWorker />
        {/* Owns the Discord-import job for the session: the modal may be
            dismissed (or the tab reloaded) while the import runs. */}
        <DiscordImportWorker />
        <IncomingCallOverlay />
        {/* Remote control's offer prompt, session panels and focused-window
            panic handler. APP LEVEL on purpose: every one of these is a way
            to STOP a live control session, and mounting them inside the call
            card meant they all disappeared the moment the user clicked
            another channel and the card flipped to PiP. */}
        <RemoteControlOverlays />
        {/* "Recording saved to …" / "couldn't save it". APP LEVEL for the same
            reason as the overlays above: a recording usually ends by leaving
            the call, which unmounts the call card — mounted there, this would
            be destroyed in the same tick as the message it has to deliver. */}
        <CallRecordingNotices />
        {/* "Moved to #channel". APP LEVEL because following a move reconnects to
            the destination, which tears down the source call card. */}
        <VoiceMoveNotices />
        {/* The live transcript and its Export/Copy/Discard controls. APP LEVEL
            for the same reason again, and it was caught the hard way: mounted
            inside the call card, the panel unmounted the instant a call ended
            and took the only route to Export with it, while the transcript sat
            intact and unreachable in memory. */}
        <VoiceTranscriptPanel />
        {/* DEV-only console hook for chat windows (`__chatwin.open(id)`). It
            portals each window's content from here, so the windows inherit
            this tree's client, state and modal contexts. Main window only, as
            above. The constant-folded guard drops it from production builds. */}
        {import.meta.env.DEV && <ChatWinDevHarness />}
        {/* Desktop chat windows (friends + tabbed conversations). Main window
            only, as above: it opens and owns every child window and portals
            their content from here. Inert unless the chat-windows mode is on
            in a supported shell. */}
        <ChatWindowsHost />
      </AppRoot>
    </MessageCache>
  );
};

/**
 * Spinner shown until the client loads for the first time. Before that first
 * load the user menu, which holds the only "Sign out", is not rendered, so a
 * device whose socket never connects had no way to sign out. The button
 * appears after a few failed attempts or a long wait, and goes through the
 * usual confirmation.
 */
function LoadingScreen() {
  const { openModal } = useModals();
  const { lifecycle } = useClientLifecycle();
  const [waitedLong, setWaitedLong] = createSignal(false);

  const timer = setTimeout(() => setWaitedLong(true), SIGN_OUT_OFFER_AFTER_MS);
  onCleanup(() => clearTimeout(timer));

  return (
    <Column align justify grow>
      <CircularProgress />
      <Show
        when={offerSignOutWhileLoading(
          lifecycle.loadedOnce(),
          lifecycle.connectionFailures(),
          waitedLong(),
        )}
      >
        <Button variant="text" onPress={() => openModal({ type: "sign_out" })}>
          <Trans>Sign out</Trans>
        </Button>
      </Show>
    </Column>
  );
}

/**
 * Shown in place of the routed content when it throws while Slim view is on.
 * Slim view hides most of the app, so a crash inside it always offers the
 * way back to the full app; the toggle in settings is the other one. The
 * error is shown for the same reason `PaneErrorBoundary` shows it: Slim view
 * runs on phones we cannot attach a debugger to.
 */
function SlimCrashed(props: { error: unknown; onTurnOff: () => void }) {
  return (
    <SlimCrash>
      <Text class="title" size="large">
        <Trans>Something went wrong in Slim view.</Trans>
      </Text>
      <SlimCrashDetail>
        {props.error instanceof Error
          ? `${props.error.name}: ${props.error.message}`
          : String(props.error)}
      </SlimCrashDetail>
      <Button onPress={props.onTurnOff}>
        <Trans>Turn off Slim view</Trans>
      </Button>
    </SlimCrash>
  );
}

const AppRoot = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
  },
});

/**
 * Slim view crash screen, sized like the content pane's own error fallback
 */
const SlimCrash = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "var(--gap-md)",
    flexGrow: 1,
    padding: "var(--gap-lg)",
    minWidth: 0,
    color: "var(--md-sys-color-on-surface)",
  },
});

const SlimCrashDetail = styled("code", {
  base: {
    maxWidth: "100%",
    overflowWrap: "anywhere",
    userSelect: "text",
    fontSize: "0.8em",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

/**
 * Slim banner shown while Streamer Mode is active
 */
const StreamerBanner = styled("div", {
  base: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--gap-sm)",

    padding: "2px var(--gap-md)",
    fontSize: "0.8em",
    fontWeight: 600,
    cursor: "pointer",
    userSelect: "none",

    fill: "var(--md-sys-color-on-error-container)",
    color: "var(--md-sys-color-on-error-container)",
    background: "var(--md-sys-color-error-container)",
  },
});

/**
 * Dismiss button pinned to the right edge of the streamer banner. Hides the
 * banner (streamer:show_banner) without touching Streamer Mode itself; the
 * settings page has the toggle to bring it back.
 */
const BannerClose = styled("button", {
  base: {
    position: "absolute",
    right: "var(--gap-sm)",
    top: "50%",
    transform: "translateY(-50%)",

    display: "flex",
    alignItems: "center",
    padding: "2px",
    border: "none",
    borderRadius: "var(--borderRadius-full)",
    background: "transparent",
    fill: "inherit",
    color: "inherit",
    cursor: "pointer",

    _hover: {
      background: "color-mix(in srgb, currentColor 15%, transparent)",
    },
  },
});

/**
 * Parent container
 */
const Layout = styled("div", {
  base: {
    display: "flex",
    height: "100%",
    minWidth: 0,

    // Containing block for the nav block. At phone widths `MainBar` is
    // `position: absolute; height: 100%` with no `top`, so it takes its STATIC
    // position — below whatever chrome precedes it — while sizing itself
    // against its containing block. With no positioned ancestor here that was
    // `#root`, i.e. the whole viewport, so the moment the connection banner
    // (or the streamer banner) appeared, MainBar hung its own top offset past
    // the bottom of the screen and took the floating user bar with it: the bar
    // sat ~19px below the fold and its second line was cut off. Reported from
    // a real device on 2026-08-22, and reproducible exactly.
    //
    // Layout's used height already excludes that chrome, so anchoring here
    // clamps MainBar to the visible area in every combination.
    position: "relative",

    // These two used to be the "connected" half of a `disconnected` variant
    // copied down from the title bar. The other half painted this whole
    // container brand-accent blue whenever the socket was down, which is not
    // something an app-wide container should ever do; the connection notice
    // belongs to <ConnectionIndicator/> above. Kept as the base so every
    // connected state looks exactly as it did.
    color: "var(--md-sys-color-outline)",
    background: "var(--md-sys-color-surface-container-high)",
  },
  variants: {
    /**
     * Navigation block on the right. Reversing the row (rather than
     * re-mounting the two children in the other order) keeps `Sidebar` and
     * its `SlideDrawer` / server-reorder state alive across the flip. Never
     * true at phone widths — `useLayoutSides` pins the phone to the default.
     */
    navRight: {
      true: {
        flexDirection: "row-reverse",
      },
    },
  },
});

/**
 * Main content container
 */
const Content = styled("div", {
  base: {
    background: "var(--md-sys-color-surface-container-low)",
    display: "flex",
    width: "100%",
    minWidth: 0,
  },
  variants: {
    sidebar: {
      false: {
        overflow: "hidden",
      },
    },
    /**
     * Pack a capped page from the end when the nav is on the right, so the
     * message column hugs the nav from the other side. Direct children that
     * fill the width (`width: 100%` pages) are unaffected.
     */
    navRight: {
      true: {
        justifyContent: "flex-end",
      },
      // Explicit so the compound variants below can match on it.
      false: {},
    },
  },
  defaultVariants: {
    navRight: false,
  },
  // With the channel sidebar collapsed only the server rail is beside this
  // block, and the corner that meets it is rounded — whichever side that is.
  compoundVariants: [
    {
      sidebar: false,
      navRight: true,
      css: {
        borderTopRightRadius: "var(--borderRadius-lg)",
        borderBottomRightRadius: "var(--borderRadius-lg)",
      },
    },
    {
      sidebar: false,
      navRight: false,
      css: {
        borderTopLeftRadius: "var(--borderRadius-lg)",
        borderBottomLeftRadius: "var(--borderRadius-lg)",
      },
    },
  ],
});

export default Interface;
