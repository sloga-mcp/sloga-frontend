import {
  createEffect,
  createSignal,
  JSX,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { Server } from "stoat.js";
import { styled } from "styled-system/jsx";

import { ChannelContextMenu, ServerContextMenu } from "@revolt/app";
import { MessageCache } from "@revolt/app/interface/channels/text/MessageCache";
import { Titlebar } from "@revolt/app/interface/desktop/Titlebar";
import { useClient, useClientLifecycle } from "@revolt/client";
import { ActivityWorker } from "@revolt/client/ActivityWorker";
import { ApkUpdateWorker } from "@revolt/client/ApkUpdateWorker";
import { ChannelListQueriesWorker } from "@revolt/client/ChannelListQueriesWorker";
import { DiscordImportWorker } from "@revolt/client/DiscordImportWorker";
import { FossUpdateNotice } from "@revolt/client/FossUpdateNotice";
import { KeybindsWorker } from "@revolt/client/KeybindsWorker";
import { NotificationsWorker } from "@revolt/client/NotificationsWorker";
import { ShellBridgeWorker } from "@revolt/client/ShellBridgeWorker";
import { StreamerModeWorker } from "@revolt/client/StreamerModeWorker";
import { IS_OVERLAY_WINDOW, IS_POPOUT_WINDOW } from "@revolt/client/popout";
import { useModals } from "@revolt/modal";
import { Navigate, useBeforeLeave, useLocation } from "@revolt/routing";
import { OverlayBridgeWorker } from "@revolt/rtc/overlay/OverlayBridgeWorker";
import { useState } from "@revolt/state";
import { LAYOUT_SECTIONS } from "@revolt/state/stores/Layout";
import { streamerModeActive } from "@revolt/state/streamer";
import { CircularProgress, useLayoutSides } from "@revolt/ui";
import { IncomingCallOverlay } from "@revolt/ui/components/features/voice/IncomingCallOverlay";
import { CallRecordingNotices } from "@revolt/ui/components/features/voice/callCard/CallRecordingNotices";
import { RemoteControlOverlays } from "@revolt/ui/components/features/voice/callCard/RemoteControlOverlays";
import { VoiceMoveNotices } from "@revolt/ui/components/features/voice/callCard/VoiceMoveNotices";
import { VoiceTranscriptPanel } from "@revolt/ui/components/features/voice/callCard/VoiceTranscriptPanel";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { SlideDrawer } from "../components/ui/components/navigation/SlideDrawer";
import { PaneErrorBoundary } from "./interface/PaneErrorBoundary";
import { Sidebar } from "./interface/Sidebar";

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
  const { pathname } = useLocation();
  const sides = useLayoutSides();

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
      state.layout.setNextPath(pathname);
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

  return (
    <MessageCache client={client()}>
      <AppRoot ref={rootRef} class="app_root">
        <Titlebar />
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
        <Switch fallback={<CircularProgress />}>
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
                sidebar={state.layout.getSectionState(
                  LAYOUT_SECTIONS.PRIMARY_SIDEBAR,
                  true,
                )}
                navRight={sides().nav === "right"}
              >
                <PaneErrorBoundary pane="content">
                  {props.children}
                </PaneErrorBoundary>
              </Content>
            </Layout>
          </Match>
        </Switch>

        <NotificationsWorker />
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
      </AppRoot>
    </MessageCache>
  );
};

const AppRoot = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
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
    // belongs to <Titlebar/> above. Kept as the base so every connected state
    // looks exactly as it did.
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
