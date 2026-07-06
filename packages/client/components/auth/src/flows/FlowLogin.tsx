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
  Column,
  Row,
  Text,
  iconSize,
} from "@revolt/ui";

import MdArrowBack from "@material-design-icons/svg/filled/arrow_back.svg?component-solid";

import { CONFIGURATION } from "@revolt/common";
import { useState } from "@revolt/state";
import { FlowTitle } from "./Flow";
import { Fields, Form } from "./Form";

/**
 * Whether the server offers Google OAuth login.
 *
 * Hidden inside the Tauri/Capacitor webviews: Google rejects OAuth from
 * embedded webviews (disallowed_useragent), so the button is web-only
 * until a deep-link flow exists.
 */
async function fetchOauthGoogleEnabled() {
  const win = window as {
    __TAURI__?: unknown;
    Capacitor?: { isNativePlatform?: () => boolean };
  };
  if (win.__TAURI__ || win.Capacitor?.isNativePlatform?.()) return false;

  try {
    const response = await fetch(`${CONFIGURATION.DEFAULT_API_URL}/`);
    const config = await response.json();
    return Boolean(config?.features?.oauth_google);
  } catch {
    return false;
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
  const [oauthGoogle] = createResource(fetchOauthGoogleEnabled);

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
            <FlowTitle subtitle={<Trans>Sign into Sloga</Trans>} emoji="wave">
              <Trans>Welcome!</Trans>
            </FlowTitle>
            <div style={{"--md-sys-color-primary": "#FF8A00", "--mdui-color-primary": "255, 138, 0", "display": "contents"}}>
            <Form onSubmit={performLogin}>
              <Fields fields={["email", "password"]} />
              <Checkbox
                checked={keepLoggedIn()}
                onChange={(event) =>
                  setKeepLoggedIn(event.currentTarget.checked)
                }
              >
                <Trans>Keep me logged in</Trans>
              </Checkbox>
              <div style={{"display": "flex", "flex-direction": "column", "gap": "inherit", "width": "100%"}}>
                <Column gap="xl" align>
                  <a href="/login/reset">
                    <Button variant="text">
                      <Trans>Reset password</Trans>
                    </Button>
                  </a>
                  <a href="/login/resend">
                    <Button variant="text">
                      <Trans>Resend verification</Trans>
                    </Button>
                  </a>
                </Column>
                <Row align justify>
                  <a href="..">
                    <Button variant="text">
                      <MdArrowBack {...iconSize("1.2em")} /> <Trans>Back</Trans>
                    </Button>
                  </a>
                  <Button type="submit" bg="#FF8A00">
                    <Trans>Login</Trans>
                  </Button>
                </Row>
                <Show when={oauthGoogle()}>
                  <Row align justify>
                    <Button
                      variant="outlined"
                      onPress={() => {
                        state.auth.setRemember(keepLoggedIn());
                        // Full-page navigation — the SPA router would
                        // otherwise swallow this same-origin URL
                        window.location.assign(
                          `${CONFIGURATION.DEFAULT_API_URL}/auth/oauth/google`,
                        );
                      }}
                    >
                      <Trans>Continue with Google</Trans>
                    </Button>
                  </Row>
                </Show>
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
