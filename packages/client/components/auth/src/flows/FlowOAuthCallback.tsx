import { Match, Switch, createSignal, onMount } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";

import { useClientLifecycle } from "@revolt/client";
import type { OAuthProvider } from "@revolt/client/Controller";
import { State, TransitionType } from "@revolt/client/Controller";
import { useModals } from "@revolt/modal";
import { Navigate } from "@revolt/routing";
import {
  Button,
  CircularProgress,
  Column,
  Row,
  Text,
  iconSize,
} from "@revolt/ui";

import MdArrowBack from "@material-design-icons/svg/filled/arrow_back.svg?component-solid";

import { useState } from "@revolt/state";
import { FlowTitle } from "./Flow";
import { Fields, Form } from "./Form";

/**
 * Landing page for OAuth redirects (/login/oauth?code=...&provider=...)
 *
 * Swaps the one-time handoff code from the backend for a session and
 * then follows the same lifecycle as a password login (including MFA
 * and username onboarding).
 */
export default function FlowOAuthCallback() {
  const state = useState();
  const modals = useModals();
  const { lifecycle, isLoggedIn, completeOauth, selectUsername } =
    useClientLifecycle();

  const [error, setError] = createSignal<string>();

  // Read once — the query string cannot change without a fresh page load,
  // and the failure copy below needs the provider as much as the exchange
  // does. Anything but a known slug is treated as Google rather than
  // pasted into a request path.
  const params = new URLSearchParams(window.location.search);
  const provider: OAuthProvider =
    params.get("provider") === "apple" ? "apple" : "google";
  const providerName = provider === "apple" ? "Apple" : "Google";

  onMount(async () => {
    const serverError = params.get("error");
    const code = params.get("code");

    if (serverError || !code) {
      setError(serverError ?? "invalid_request");
      return;
    }

    state.auth.setRemember(true);

    try {
      await completeOauth(code, modals, provider);
    } catch (err) {
      console.error("OAuth login failed:", err);
      setError("login_failed");
    }
  });

  /**
   * Select a new username
   * @param data Form Data
   */
  async function select(data: FormData) {
    const username = data.get("username") as string;
    await selectUsername(username);
  }

  return (
    <Switch
      fallback={
        <Column align>
          <CircularProgress />
          <Text>
            <Trans>Signing you in…</Trans>
          </Text>
        </Column>
      }
    >
      <Match when={isLoggedIn()}>
        <Navigate href={state.layout.popNextPath() ?? "/app"} />
      </Match>
      <Match when={error()}>
        <FlowTitle>
          <Trans>Sign in failed</Trans>
        </FlowTitle>
        <Text>
          <Switch
            fallback={
              <Trans>
                Something went wrong while signing you in with {providerName}.
                Please try again.
              </Trans>
            }
          >
            <Match when={error() === "cancelled"}>
              <Trans>The {providerName} sign-in was canceled.</Trans>
            </Match>
            <Match when={error() === "email_unverified"}>
              <Trans>
                Your {providerName} account's email address is not verified.
              </Trans>
            </Match>
            <Match when={error() === "disabled_account"}>
              <Trans>This account has been disabled.</Trans>
            </Match>
          </Switch>
        </Text>
        <Row align justify>
          <a href="/login/auth">
            <Button variant="text">
              <MdArrowBack {...iconSize("1.2em")} />{" "}
              <Trans>Back to login</Trans>
            </Button>
          </a>
        </Row>
      </Match>
      <Match when={lifecycle.state() === State.Onboarding}>
        <FlowTitle>
          <Trans>Choose a username</Trans>
        </FlowTitle>

        <Text>
          <Trans>
            Pick a username that you want people to be able to find you by. This
            can be changed later in your user settings.
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
  );
}
