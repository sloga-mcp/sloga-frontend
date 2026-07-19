import {
  createEffect,
  createSignal,
  JSX,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { Server } from "stoat.js";
import { styled } from "styled-system/jsx";

import { ChannelContextMenu, ServerContextMenu } from "@revolt/app";
import { MessageCache } from "@revolt/app/interface/channels/text/MessageCache";
import { Titlebar } from "@revolt/app/interface/desktop/Titlebar";
import { useClient, useClientLifecycle } from "@revolt/client";
import { State } from "@revolt/client/Controller";
import { ActivityWorker } from "@revolt/client/ActivityWorker";
import { ApkUpdateWorker } from "@revolt/client/ApkUpdateWorker";
import { NotificationsWorker } from "@revolt/client/NotificationsWorker";
import { StreamerModeWorker } from "@revolt/client/StreamerModeWorker";
import { useModals } from "@revolt/modal";
import { Navigate, useBeforeLeave, useLocation } from "@revolt/routing";
import { useState } from "@revolt/state";
import { streamerModeActive } from "@revolt/state/streamer";
import { LAYOUT_SECTIONS } from "@revolt/state/stores/Layout";
import { CircularProgress } from "@revolt/ui";
import { IncomingCallOverlay } from "@revolt/ui/components/features/voice/IncomingCallOverlay";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { SlideDrawer } from "../components/ui/components/navigation/SlideDrawer";
import { Sidebar } from "./interface/Sidebar";

/**
 * Application layout
 */
const Interface = (props: { children: JSX.Element }) => {
  const state = useState();
  const client = useClient();
  const { openModal } = useModals();
  const { isLoggedIn, lifecycle } = useClientLifecycle();
  const { pathname } = useLocation();

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

  function isDisconnected() {
    return [
      State.Connecting,
      State.Disconnected,
      State.Reconnecting,
      State.Offline,
    ].includes(lifecycle.state());
  }

  //Drawer slider for mobile
  let rootRef, sDrawer: SlideDrawer | undefined;
  const [contRef, setContRef] = createSignal<HTMLDivElement>();
  function rstLayout() {
    state.layout.setSectionState(LAYOUT_SECTIONS.PRIMARY_SIDEBAR, false, false);
    state.layout.setSectionState(LAYOUT_SECTIONS.MEMBER_SIDEBAR, false, true);
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
        <Show when={streamerModeActive(state.settings)}>
          <StreamerBanner
            onClick={() => openModal({ type: "settings", config: "user" })}
          >
            <Symbol size={16}>videocam</Symbol>
            <Trans>
              Streamer Mode is on — personal info, invites and notifications
              are hidden
            </Trans>
          </StreamerBanner>
        </Show>
        <Switch fallback={<CircularProgress />}>
          <Match when={!isLoggedIn()}>
            <Navigate href="/login" />
          </Match>
          <Match when={lifecycle.loadedOnce()}>
            <Layout
              disconnected={isDisconnected()}
              style={{ "flex-grow": 1, "min-height": 0 }}
              onDragOver={(e) => {
                // Cancel the dragover so the browser never navigates to a
                // dropped file; FileDropAnywhereCollector listens on document
                // (after this handler) and flips the effect to "copy" to
                // accept files wherever a composer is mounted.
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
              }}
              onDrop={(e) => e.preventDefault()}
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
              >
                {props.children}
              </Content>
            </Layout>
          </Match>
        </Switch>

        <NotificationsWorker />
        <ActivityWorker />
        <StreamerModeWorker />
        <ApkUpdateWorker />
        <IncomingCallOverlay />
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
 * Parent container
 */
const Layout = styled("div", {
  base: {
    display: "flex",
    height: "100%",
    minWidth: 0,
  },
  variants: {
    disconnected: {
      true: {
        color: "var(--md-sys-color-on-primary-container)",
        background: "var(--md-sys-color-primary-container)",
      },
      false: {
        color: "var(--md-sys-color-outline)",
        background: "var(--md-sys-color-surface-container-high)",
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
        borderTopLeftRadius: "var(--borderRadius-lg)",
        borderBottomLeftRadius: "var(--borderRadius-lg)",
        overflow: "hidden",
      },
    },
  },
});

export default Interface;
