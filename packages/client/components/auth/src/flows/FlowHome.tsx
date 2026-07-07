import { Match, Show, Switch } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { css } from "styled-system/css";

import { useClientLifecycle } from "@revolt/client";
import { TransitionType } from "@revolt/client/Controller";
import { Navigate } from "@revolt/routing";
import { Button, Column } from "@revolt/ui";

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
            <span
              class={css({
                fontSize: "48px",
                fontWeight: "700",
                letterSpacing: "-1px",
                textAlign: "center",
                color: "var(--md-sys-color-on-surface)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "2px",
              })}
            >
              Sl
              <img
                src="/assets/web/sloga-icon.png"
                alt="o"
                class={css({
                  height: "40px",
                  width: "40px",
                })}
              />
              ga
            </span>

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
                  <Trans>4k streaming</Trans>
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
              <a href="/login/auth">
                <Column>
                  <Button bg="#FF8A00">
                    <Trans>Log In</Trans>
                  </Button>
                </Column>
              </a>
              <a href="/login/create">
                <Column>
                  <div style={{"--md-sys-color-on-secondary-container":"#ffffff", "width": "100%", "display": "flex", "flex-direction": "column"}}>
                    <Button variant="tonal" bg="#8B00FF">
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
