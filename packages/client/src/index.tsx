/**
 * Configure contexts and render App
 */
import "./polyfills";
import "./sentry";

import { JSX, createEffect, createRoot, on, onMount, untrack } from "solid-js";
import { render } from "solid-js/web";

import { useLingui } from "@lingui-solid/solid/macro";

import { Navigate, Route, Router, useParams } from "@solidjs/router";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import "material-symbols";
import "mdui/mdui.css";
import { DiscoverableServer, PublicBot, PublicChannelInvite } from "stoat.js";

import { MainTitleBar } from "@revolt/app/interface/desktop/MainTitleBar";
import FlowCheck from "@revolt/auth/src/flows/FlowCheck";
import FlowConfirmReset from "@revolt/auth/src/flows/FlowConfirmReset";
import FlowCreate from "@revolt/auth/src/flows/FlowCreate";
import FlowDeleteAccount from "@revolt/auth/src/flows/FlowDelete";
import FlowHome from "@revolt/auth/src/flows/FlowHome";
import FlowLogin from "@revolt/auth/src/flows/FlowLogin";
import FlowOAuthCallback from "@revolt/auth/src/flows/FlowOAuthCallback";
import FlowResend from "@revolt/auth/src/flows/FlowResend";
import FlowReset from "@revolt/auth/src/flows/FlowReset";
import FlowVerify from "@revolt/auth/src/flows/FlowVerify";
import {
  ClientContext,
  SoundContext,
  allowsDonationLinks,
  distributionChannel,
  useClient,
  useClientLifecycle,
} from "@revolt/client";
import { AndroidBackWorker } from "@revolt/client/AndroidBackWorker";
import { State } from "@revolt/client/Controller";
import { IS_OVERLAY_WINDOW, IS_POPOUT_WINDOW } from "@revolt/client/popout";
import { completeStreamLink } from "@revolt/client/streamConnections";
import { DeviceContext } from "@revolt/common";
import { normalizeReferralCode } from "@revolt/common/lib/referralCode";
import { I18nProvider } from "@revolt/i18n";
import { KeybindContext } from "@revolt/keybinds";
import { ModalContext, ModalRenderer, useModals } from "@revolt/modal";
import { VoiceContext } from "@revolt/rtc";
import { StateContext, SyncWorker, useState } from "@revolt/state";
import {
  ContextMenuGuard,
  FileDropGuard,
  FloatingManager,
  LoadLayout,
  LoadTheme,
  SnackbarController,
  SnackbarProvider,
  useSnackbar,
} from "@revolt/ui";

/* @refresh reload */
import "@revolt/ui/styles";

import { AndroidNag } from "./AndroidNag";
import AuthPage from "./Auth";
import Interface from "./Interface";
import "./index.css";
import { DevelopmentPage } from "./interface/Development";
import { Discover } from "./interface/Discover";
import { FoundingStreamers } from "./interface/FoundingStreamers";
import { Friends } from "./interface/Friends";
import { FriendsPopout } from "./interface/FriendsPopout";
import { HomePage } from "./interface/Home";
import { ServerEvents } from "./interface/ServerEvents";
import { ServerHome } from "./interface/ServerHome";
import { VoiceOverlayWindow } from "./interface/VoiceOverlayWindow";
import { ChannelPage } from "./interface/channels/ChannelPage";
import { mountIosViewportFix } from "./iosViewport";
import {
  type CipherSettingsContext,
  CHANNEL_WAIT_MS,
  cipherLinkAction,
  cipherSettingsContext,
} from "./lib/deepLinks";
import "./serviceWorkerInterface";

// Best-effort: the devtools debugger throws at module eval when its setup
// script loses the load race (reliably in CDP-automated tabs), and a static
// import would take the whole app down with it.
import("@solid-devtools/overlay")
  .then(({ attachDevtoolsOverlay }) => attachDevtoolsOverlay())
  .catch(() => {});

// Stamp the overlay window BEFORE the first paint. The transparency rule in
// @revolt/ui/styles hangs off this attribute; setting it from an effect would
// paint one frame of the opaque #root rectangle over the user's game.
if (IS_OVERLAY_WINDOW) {
  document.documentElement.dataset.overlay = "1";
}

// iOS Safari: keep #root sized to the visual viewport while the software
// keyboard is up (no-op everywhere else) — see src/iosViewport.ts.
mountIosViewportFix();

/**
 * Redirect PWA start to the last active path
 */
function PWARedirect() {
  const state = useState();
  return <Navigate href={state.layout.getLastActivePath()} />;
}

/**
 * Open settings and redirect to last active path.
 *
 * Also the landing point for the streaming-channel link flow: the OAuth
 * callback redirects here with `stream_complete` (one-time handoff code)
 * or `stream_error` query params (see backend routes/oauth/link.rs).
 */
function SettingsRedirect() {
  const client = useClient();
  const { openModal } = useModals();
  const { t } = useLingui();
  const snackbar = useSnackbar();

  onMount(() => {
    const params = new URLSearchParams(window.location.search);
    const complete = params.get("stream_complete");
    const platform = params.get("stream_platform");
    const error = params.get("stream_error");

    if (
      complete &&
      (platform === "twitch" || platform === "youtube" || platform === "kick")
    ) {
      completeStreamLink(client(), platform, complete)
        .then((connection) =>
          snackbar.show({
            message: t`Linked channel: ${connection.display_name}`,
          }),
        )
        .catch(() =>
          snackbar.show({
            message: t`Failed to link your channel, try again.`,
          }),
        );
    } else if (error) {
      snackbar.show({
        message:
          error === "no_channel"
            ? t`That account has no channel to link.`
            : t`Channel linking failed or was canceled.`,
      });
    }

    // Cipher deep links: `?cipher_tier=` (sloga.gg Cipher page, preselects a
    // tier) and `?cipher=success|cancel` (the Stripe return URL). Either
    // opens the Cipher page. Store builds ignore both and open settings as
    // usual, since the Cipher page is not listed there.
    const cipher = cipherSettingsContext(window.location.search);
    const openSettings = (context?: CipherSettingsContext) =>
      context
        ? openModal({ type: "settings", config: "user", context })
        : openModal({ type: "settings", config: "user" });

    const action = cipherLinkAction(cipher, {
      allowsLinks: allowsDonationLinks(),
      // An Android build reads as "play" until its native layer reports the
      // flavor, and a resolved "play" looks the same, so a Play build waits
      // out the bound before it opens plain settings ("appstore" is final)
      mayStillResolve: distributionChannel() === "play",
    });
    if (action !== "wait") {
      openSettings(action === "open" ? cipher : undefined);
      return;
    }

    // PWARedirect leaves this route at once, so the wait lives in its own
    // root and ends as soon as it decides. Fails closed: plain settings
    // unless the channel allows the links within the bound.
    createRoot((dispose) => {
      let decided = false;
      const timer = setTimeout(() => decide(), CHANNEL_WAIT_MS);
      function decide(context?: CipherSettingsContext) {
        if (decided) return;
        decided = true;
        clearTimeout(timer);
        dispose();
        openSettings(context);
      }
      // Tracks the channel only: opening settings must never become a
      // dependency of this effect
      createEffect(
        on(allowsDonationLinks, (allowed) => {
          if (allowed) decide(cipher);
        }),
      );
    });
  });
  return <PWARedirect />;
}

/**
 * Open invite and redirect to last active path
 */
function InviteRedirect() {
  const params = useParams();
  const client = useClient();
  const { openModal, showError } = useModals();

  onMount(() => {
    if (params.code) {
      client()
        // TODO: add a helper to stoat.js for this
        .api.get(`/invites/${params.code as ""}`)
        .then((invite) => PublicChannelInvite.from(client(), invite))
        .then((invite) => openModal({ type: "invite", invite }))
        .catch(showError);
    }
  });

  return <PWARedirect />;
}

/**
 * Open a discoverable server's join prompt and redirect to last active path
 * (landing route for sloga.gg/discover "Open Sloga" buttons)
 */
function DiscoverRedirect() {
  const params = useParams();
  const client = useClient();
  const { openModal, showError } = useModals();

  onMount(() => {
    if (params.id) {
      DiscoverableServer.fetch(client(), params.id)
        .then((server) => openModal({ type: "discover_join", server }))
        .catch(showError);
    }
  });

  return <PWARedirect />;
}

/**
 * Open bot invite and redirect to last active path
 */
function BotRedirect() {
  const params = useParams();
  const client = useClient();
  const { openModal, showError } = useModals();

  onMount(() => {
    if (params.code) {
      client()
        // TODO: add a helper to stoat.js for this
        .api.get(`/bots/${params.code as ""}/invite`)
        .then((invite) => new PublicBot(client(), invite))
        .then((invite) => openModal({ type: "add_bot", invite }))
        .catch(showError);
    }
  });

  return <PWARedirect />;
}

/**
 * Landing route for referral links (/r/:code): remember the code for the
 * signup form and send the visitor to account creation. Signed-in users go
 * straight to the app and nothing is stored.
 *
 * No need to wait for the lifecycle: the state store hydrates before the
 * router mounts, and a cached session moves the lifecycle to Connecting while
 * the client controller is being built, so a signed-in user never reads as
 * signed out here.
 */
function ReferralRedirect() {
  const params = useParams();
  const state = useState();
  const { isLoggedIn, lifecycle } = useClientLifecycle();

  // Decided once: this route only ever redirects
  const href = untrack(() => {
    if (isLoggedIn()) return "/app";

    // Only a well-formed code is stored; a link that can't be a code leaves
    // any code kept from an earlier link in place
    const code = normalizeReferralCode(params.code ?? "");
    if (code !== undefined) state.layout.setReferralCode(code);

    // Mid sign-in or at the username step, the login flow owns the page and
    // shows the pre-filled field; the signup form would start over
    const current = lifecycle.state();
    return current === State.LoggingIn || current === State.Onboarding
      ? "/login/auth"
      : "/login/create";
  });

  return <Navigate href={href} />;
}

function MountContext(props: { children?: JSX.Element }) {
  // The in-game voice overlay window gets NO provider stack at all. It is a
  // passive renderer of BroadcastChannel snapshots — no client is ever
  // constructed, so no WebSocket, no Voice/LiveKit room, no sync worker, no
  // sounds. Short-circuiting here (rather than gating each provider) is what
  // makes that a structural guarantee instead of a list of gates to maintain.
  //
  // The cost is that `VoiceOverlayWindow` and everything under it must live
  // without I18nProvider / ModalContext / KeybindContext / SnackbarProvider —
  // most importantly, NO lingui macros, which throw at runtime and are
  // invisible to both tsc and the extractor. See @revolt/client/popout.
  //
  // `StateContext` and `LoadTheme` sit OUTSIDE the router root and still
  // mount, which is what keeps the `--md-sys-color-*` variables available to
  // the overlay's styles.
  //
  // Early return is safe despite the rule: `IS_OVERLAY_WINDOW` is frozen at
  // module init, so there is no reactivity here for a re-render to observe.
  // eslint-disable-next-line solid/components-return-once
  if (IS_OVERLAY_WINDOW) return <>{props.children}</>;

  const state = useState();

  /**
   * Tanstack Query client
   */
  const client = new QueryClient();

  /**
   * Snackbar controller
   */
  const snackbarController = new SnackbarController();

  return (
    <KeybindContext>
      <ModalContext>
        <I18nProvider>
          <ClientContext state={state}>
            <SoundContext>
              <VoiceContext snackbar={snackbarController}>
                <QueryClientProvider client={client}>
                  <SnackbarProvider controller={snackbarController}>
                    {props.children}
                    <ModalRenderer />
                    <FloatingManager />
                    {/* Android back key. Mounted exactly once, HERE rather
                        than inside `Interface`: it is a single window
                        listener walking the app-wide dismissal ladder
                        (fullscreen → the Escape keybind group → the phone
                        slide drawer → history), and `Interface` is only the
                        component for `<Route path="/">`. Mounted there, the
                        listener did not exist on `/login` — first install and
                        every sign-out — while the Android shell still
                        consumed every press unconditionally, so the back key
                        did nothing at all on the auth screen until the
                        native wedge hatch fired.
                        Inside the router root it covers every top-level
                        route, and the rungs self-disable where they do not
                        apply: `state.appDrawer()` is `undefined` off
                        `Interface`, and with nothing left to dismiss the
                        ladder asks native to exit — which is what back on
                        the login screen did before any of this existed.
                        Inert everywhere but the Android shell. */}
                    <AndroidBackWorker />
                    <AndroidNag />
                    <FileDropGuard />
                    <ContextMenuGuard />
                  </SnackbarProvider>
                </QueryClientProvider>
              </VoiceContext>
            </SoundContext>
            <SyncWorker />
          </ClientContext>
        </I18nProvider>
      </ModalContext>
    </KeybindContext>
  );
}

// The main window's own title bar, in its own root (and its own i18n
// provider, on the same global catalog), so nothing that goes wrong in the
// app tree can take the window's only title bar down with it. Mounted before
// the app, so it claims the frame as early as it can. It draws only where
// the shell built main without an OS title bar (MainTitleBar), never in the
// voice overlay or the friends popout, which are not the main window.
if (!IS_OVERLAY_WINDOW && !IS_POPOUT_WINDOW) {
  const titlebar = document.getElementById("titlebar");
  if (titlebar) {
    render(
      () => (
        <I18nProvider>
          <MainTitleBar />
        </I18nProvider>
      ),
      titlebar,
    );
  }
}

render(
  () => (
    <DeviceContext>
      <StateContext>
        <Router root={MountContext}>
          <Route path="/login" component={AuthPage as never}>
            <Route path="/delete/:token" component={FlowDeleteAccount} />
            <Route path="/check" component={FlowCheck} />
            <Route path="/create" component={FlowCreate} />
            <Route path="/create/:code" component={FlowCreate} />
            <Route path="/auth" component={FlowLogin} />
            <Route path="/oauth" component={FlowOAuthCallback} />
            <Route path="/resend" component={FlowResend} />
            <Route path="/reset" component={FlowReset} />
            <Route path="/verify/:token" component={FlowVerify} />
            <Route path="/reset/:token" component={FlowConfirmReset} />
            <Route path="/*" component={FlowHome} />
          </Route>
          <Route path="/friends-popout" component={FriendsPopout} />
          {/* Sibling of /friends-popout, OUTSIDE the Interface route: the
              overlay is not a page of the app, it is a second window that
              renders one thing. `VoiceOverlayWindow` renders null unless the
              window booted on this path, so a web user who types the URL
              gets a blank page and in-app SPA navigation here can never
              mount a listener nobody is publishing to. */}
          <Route path="/voice-overlay" component={VoiceOverlayWindow} />
          {/* Outside Interface too, so a signed-out visit never has its path
              kept as the post-login destination */}
          <Route path="/r/:code" component={ReferralRedirect} />
          <Route path="/" component={Interface as never}>
            <Route path="/pwa" component={PWARedirect} />
            <Route path="/dev" component={DevelopmentPage} />
            <Route
              path={["/discover", "/discover/servers"]}
              component={Discover}
            />
            <Route path="/discover/server/:id" component={DiscoverRedirect} />
            {/* Child of `Interface`: the page needs an authenticated client
                for avatar URLs (`avatarUrl` returns undefined without one,
                so cards fall back to initials) and for the app chrome,
                and `Interface` redirects logged-out visitors to `/login`
                (src/Interface.tsx:149-152). The underlying
                `GET /discover/streamers` route is anonymous by design; the
                page is not.

                Sitting above the `/*` catch-all is NOT what protects this
                route -- @solidjs/router sorts branches by specificity,
                not source order (dist/routing.js:282). */}
            <Route path="/streamers" component={FoundingStreamers} />
            <Route path="/settings" component={SettingsRedirect} />
            <Route path="/invite/:code" component={InviteRedirect} />
            <Route path="/bot/:code" component={BotRedirect} />
            <Route path="/friends" component={Friends} />
            <Route path="/server/:server/*">
              <Route path="/channel/:channel/*" component={ChannelPage} />
              <Route path="/events" component={ServerEvents} />
              <Route path="/*" component={ServerHome} />
            </Route>
            <Route path="/channel/:channel/*" component={ChannelPage} />
            <Route path="/*" component={HomePage} />
          </Route>
        </Router>

        <LoadTheme />
        {/* Sits beside LoadTheme, and outside the router root for the same
            reason: both write custom properties onto <html>, and the overlay
            window needs them without mounting the rest of the app. */}
        <LoadLayout />
        {/* <ReportBug /> */}
      </StateContext>
    </DeviceContext>
  ),
  document.getElementById("root") as HTMLElement,
);
