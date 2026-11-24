import { Match, Show, Switch } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";

import { useClientLifecycle } from "@revolt/client";
import { TransitionType } from "@revolt/client/Controller";
import { Navigate } from "@revolt/routing";
import { Button, Column } from "@revolt/ui";

import { ContinueWithGoogle, PendingInviteCard } from "./InviteLanding";
import { LogoStory } from "./LogoStory";

import { useState } from "@revolt/state";

/**
 * Flow for logging into an account
 */
export default function FlowHome() {
  const state = useState();
  const { lifecycle, isLoggedIn, isError } = useClientLifecycle();

  return (
    <Switch
      fallback={
        <>
          <Show when={isLoggedIn()}>
            <Navigate href={state.layout.popNextPath() ?? "/app"} />
          </Show>

          <Column gap="xl">
            <LogoStory />

            <PendingInviteCard />

            <Column>
              <b
                style={{
                  "font-weight": 800,
                  "font-size": "1.4em",
                  display: "flex",
                  "flex-direction": "column",
                  "align-items": "center",
                  "text-align": "center",
                }}
              >
                <span>
                  <Trans>Low latency</Trans>
                  <br />
                  <Trans>High quality voice chat</Trans>
                  <br />
                  <Trans>4k screen share</Trans>
                  <br />
                  <Trans>Free</Trans>
                </span>
              </b>
              <span style={{ "text-align": "center", opacity: "0.5" }}>
                <Trans>
                  Sloga has the highest standard of voice quality, streaming
                  and latency. Create a community that never stops.
                </Trans>
              </span>
            </Column>

            <Column>
              <ContinueWithGoogle terms />
              <a href="/login/auth">
                <Column>
                  <Button bg="#FF8A00">
                    <Trans>Log In</Trans>
                  </Button>
                </Column>
              </a>
              <a href="/login/create">
                <Column>
                  {/* `bg` overrides the tonal background but not its ink, which
                      still comes from on-secondary-container. #3BB8ED is fixed
                      in both modes, so the ink has to be too: white was 2.27:1.
                      #04222E is the pairing Unreads.tsx already uses for this
                      exact blue, at 7.28:1. */}
                  <div style={{"--md-sys-color-on-secondary-container":"#04222E", "width": "100%", "display": "flex", "flex-direction": "column"}}>
                    <Button variant="tonal" bg="#3BB8ED">
                      <b><Trans>Sign Up</Trans></b>
                    </Button>
                  </div>
                </Column>
              </a>
            </Column>
          </Column>
        </>
      }
    >
      <Match when={isError()}>
        <Switch fallback={"an unknown error occurred"}>
          <Match when={lifecycle.permanentError === "InvalidSession"}>
            <h1>
              <Trans>You were logged out!</Trans>
            </h1>
          </Match>
        </Switch>

        <Button
          variant="filled"
          bg="#FF8A00"
          onPress={() =>
            lifecycle.transition({
              type: TransitionType.Dismiss,
            })
          }
        >
          <Trans>OK</Trans>
        </Button>
      </Match>
    </Switch>
  );
}
