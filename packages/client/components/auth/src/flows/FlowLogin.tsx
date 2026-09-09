import { Match, Show, Switch, createResource, createSignal } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";

import { useClientLifecycle } from "@revolt/client";
import { State, TransitionType } from "@revolt/client/Controller";
import { useModals } from "@revolt/modal";
import { Navigate } from "@revolt/routing";
import {
  Button,
  Checkbox,
  CircularProgress,
  Row,
  Text,
  iconSize,
} from "@revolt/ui";

import MdArrowBack from "@material-design-icons/svg/filled/arrow_back.svg?component-solid";

import { CONFIGURATION } from "@revolt/common";
import { useState } from "@revolt/state";
import { FlowTitle } from "./Flow";
import { Fields, Form } from "./Form";
import {
  AppleSignInButton,
  GoogleSignInButton,
  OAuthDivider,
} from "./OAuthButtons";
import hopOnSloga from "./hop-on-sloga.mp4";

/**
 * Which third-party sign-ins the server offers.
 *
 * Both are hidden inside the Tauri/Capacitor webviews, for two different
 * reasons: Google rejects OAuth from embedded webviews outright
 * (disallowed_useragent), while Apple's page would load but its redirect
 * lands on app.sloga.gg rather than back inside the shell. Showing either
 * there needs a deep-link handler (or, on iOS, native ASAuthorization).
 */
async function fetchOauthProviders() {
  const win = window as {
    __TAURI__?: unknown;
    Capacitor?: { isNativePlatform?: () => boolean };
  };
  if (win.__TAURI__ || win.Capacitor?.isNativePlatform?.())
    return { google: false, apple: false };

  try {
    const response = await fetch(`${CONFIGURATION.DEFAULT_API_URL}/`);
    const config = await response.json();
    return {
      google: Boolean(config?.features?.oauth_google),
      apple: Boolean(config?.features?.oauth_apple),
    };
  } catch {
    return { google: false, apple: false };
  }
}

/**
 * Flow for logging into an account
 */
export default function FlowLogin() {
  const state = useState();
  const modals = useModals();
  const { lifecycle, isLoggedIn, login, selectUsername } = useClientLifecycle();

  const [keepLoggedIn, setKeepLoggedIn] = createSignal(true);
  const [oauth] = createResource(fetchOauthProviders);

  /**
   * Hand off to a provider's authorize endpoint
   * @param provider Provider slug, matching the backend route
   */
  function beginOauth(provider: "google" | "apple") {
    state.auth.setRemember(keepLoggedIn());
    // Full-page navigation — the SPA router would otherwise swallow this
    // same-origin URL
    window.location.assign(
      `${CONFIGURATION.DEFAULT_API_URL}/auth/oauth/${provider}`,
    );
  }

  /**
   * Log into account
   * @param data Form Data
   */
  async function performLogin(data: FormData) {
    const email = data.get("email") as string;
    const password = data.get("password") as string;

    if (!email || !password) return;

    state.auth.setRemember(keepLoggedIn());

    await login(
      {
        email,
        password,
      },
      modals,
    );
  }

  /**
   * Select a new username
   * @param data Form Data
   */
  async function select(data: FormData) {
    const username = data.get("username") as string;
    await selectUsername(username);
  }

  return (
    <>
      <Switch
        fallback={
          <>
            {/* "Hop on Sloga" brand animation. The clip's background is
                rgb(6,10,14) — darker than the card (and the phone page bg) in
                every channel, so lighten-blend erases it; keep it that way if
                the clip is ever regenerated. */}
            <video
              src={hopOnSloga}
              autoplay
              muted
              playsinline
              preload="auto"
              aria-label="Hop on Sloga"
              style={{
                width: "100%",
                "mix-blend-mode": "lighten",
                "pointer-events": "none",
                "margin-block": "-12px",
              }}
              ref={(el) => {
                // Solid runs refs before insertion, so this beats the
                // browser's autoplay-on-insert; play() here would not.
                if (
                  window.matchMedia("(prefers-reduced-motion: reduce)").matches
                ) {
                  el.autoplay = false;
                  el.addEventListener(
                    "loadedmetadata",
                    () => (el.currentTime = el.duration),
                    { once: true },
                  );
                }
              }}
            />
            {/* The pinned orange does not follow light/dark, so its label must
                not either: inheriting the theme's on-primary gave white on
                #FF8A00 in light mode, 2.36:1. Pinned dark is 8.44:1 in both. */}
            <div
              style={{
                "--md-sys-color-primary": "#FF8A00",
                "--mdui-color-primary": "255, 138, 0",
                "--md-sys-color-on-primary": "#05090F",
                "--mdui-color-on-primary": "5, 9, 15",
                display: "contents",
              }}
            >
              <Form onSubmit={performLogin}>
                <Fields fields={["email", "password"]} />
                <div
                  style={{
                    display: "flex",
                    "align-items": "center",
                    "justify-content": "space-between",
                    gap: "var(--gap-md)",
                    width: "100%",
                  }}
                >
                  <Checkbox
                    checked={keepLoggedIn()}
                    onChange={(event) =>
                      setKeepLoggedIn(event.currentTarget.checked)
                    }
                  >
                    <Trans>Keep me logged in</Trans>
                  </Checkbox>
                  <a href="/login/reset">
                    <Button variant="text">
                      <Trans>Reset password</Trans>
                    </Button>
                  </a>
                </div>
                <div
                  style={{
                    display: "flex",
                    "flex-direction": "column",
                    gap: "inherit",
                    width: "100%",
                  }}
                >
                  {/* Apple first: its guidelines ask that Sign in with Apple
                    be no less prominent than the alternatives, and leading
                    with it costs nothing when both are the same size. */}
                  <Show when={oauth()?.apple || oauth()?.google}>
                    <OAuthDivider />
                  </Show>
                  <Show when={oauth()?.apple}>
                    <AppleSignInButton onPress={() => beginOauth("apple")} />
                  </Show>
                  <Show when={oauth()?.google}>
                    <GoogleSignInButton onPress={() => beginOauth("google")} />
                  </Show>
                  <Row align justify>
                    <a href="..">
                      <Button variant="text">
                        <MdArrowBack {...iconSize("1.2em")} />{" "}
                        <Trans>Back</Trans>
                      </Button>
                    </a>
                    <Button type="submit" bg="#FF8A00">
                      <Trans>Login</Trans>
                    </Button>
                  </Row>
                </div>
              </Form>
            </div>
          </>
        }
      >
        <Match when={isLoggedIn()}>
          <Navigate href={state.layout.popNextPath() ?? "/app"} />
        </Match>
        <Match when={lifecycle.state() === State.LoggingIn}>
          <CircularProgress />
        </Match>
        <Match when={lifecycle.state() === State.Onboarding}>
          <FlowTitle>
            <Trans>Choose a username</Trans>
          </FlowTitle>

          <Text>
            <Trans>
              Pick a username that you want people to be able to find you by.
              This can be changed later in your user settings.
            </Trans>
          </Text>

          <Form onSubmit={select}>
            <Fields fields={["username"]} />
            <Row align justify>
              <Button
                variant="text"
                onPress={() =>
                  lifecycle.transition({
                    type: TransitionType.Cancel,
                  })
                }
              >
                <MdArrowBack {...iconSize("1.2em")} /> <Trans>Cancel</Trans>
              </Button>
              <Button type="submit">
                <Trans>Confirm</Trans>
              </Button>
            </Row>
          </Form>
        </Match>
      </Switch>
    </>
  );
}
