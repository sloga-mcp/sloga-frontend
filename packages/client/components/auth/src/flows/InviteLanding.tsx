import { Show, createResource } from "solid-js";

import { Plural, Trans } from "@lingui-solid/solid/macro";
import { PublicChannelInvite, ServerPublicInvite } from "stoat.js";

import { useClient } from "@revolt/client";
import { useSlimMode } from "@revolt/client/useSlimMode";
import { CONFIGURATION } from "@revolt/common";
import { useState } from "@revolt/state";
import { Avatar, Button, Column, Text } from "@revolt/ui";

import { css } from "styled-system/css";

import { googleSignInOffered, pendingInviteCode } from "./pendingInvite";

/**
 * Whether this page can offer "Continue with Google". Never rejects.
 */
async function fetchGoogleSignInOffered(): Promise<boolean> {
  try {
    const response = await fetch(`${CONFIGURATION.DEFAULT_API_URL}/`);
    return googleSignInOffered(window, await response.json());
  } catch {
    return false;
  }
}

/**
 * The server a signed-out visitor was invited to, shown before they sign up
 * so they know what they are joining. Renders nothing without a pending
 * invite, in Slim view (where invites are hidden), or if the lookup fails.
 */
export function PendingInviteCard() {
  const state = useState();
  const client = useClient();
  const slim = useSlimMode();

  const [invite] = createResource(
    () =>
      slim() ? undefined : pendingInviteCode(state.get("layout").nextPath),
    async (code) => {
      try {
        // The invite lookup needs no session
        const response = await client().api.get(`/invites/${code as ""}`);
        const invite = PublicChannelInvite.from(client(), response);
        return invite instanceof ServerPublicInvite ? invite : undefined;
      } catch {
        return undefined;
      }
    },
  );

  return (
    <Show when={invite()}>
      {(server) => {
        const inviter = () => server().userName;

        return (
          <div
            class={css({
              display: "flex",
              alignItems: "center",
              gap: "var(--gap-lg)",
              padding: "var(--gap-lg)",
              borderRadius: "16px",
              background: "var(--md-sys-color-surface-container-high)",
              color: "var(--md-sys-color-on-surface)",
            })}
          >
            <Avatar
              size={56}
              shape="rounded-square"
              src={server().serverIcon?.previewUrl}
              fallback={server().serverName}
            />
            <Column gap="xs">
              <Text class="label" size="small">
                <Trans>You've been invited to join</Trans>
              </Text>
              <Text class="title" size="large">
                <b>{server().serverName}</b>
              </Text>
              <Text class="label" size="small">
                <Plural
                  value={server().memberCount}
                  one="# member"
                  other="# members"
                />
                {" · "}
                <Trans>Invited by {inviter()}</Trans>
              </Text>
            </Column>
          </div>
        );
      }}
    </Show>
  );
}

/**
 * "Continue with Google" for people who do not have an account yet. Signing
 * up this way skips the password and the email confirmation. Web only, and
 * only when the server has Google sign-in turned on.
 * @param props.terms Show the terms notice under the button, for pages that
 * do not already show it
 * @param props.orEmail Show "or sign up with email" under the button, for the
 * page that has the email form below
 */
export function ContinueWithGoogle(props: {
  terms?: boolean;
  orEmail?: boolean;
}) {
  const state = useState();
  const [offered] = createResource(fetchGoogleSignInOffered);

  return (
    <Show when={offered()}>
      {/* Same pinned dark ink as the login page's Google button: the fixed
          blue does not follow light/dark, and white on it is 2.27:1. */}
      <div
        style={{
          "--md-sys-color-on-primary": "#05090F",
          "--mdui-color-on-primary": "5, 9, 15",
          width: "100%",
          display: "flex",
          "flex-direction": "column",
          "align-items": "center",
          gap: "var(--gap-sm)",
        }}
      >
        <div
          style={{ width: "100%", display: "flex", "flex-direction": "column" }}
        >
          <Button
            size="md"
            bg="#3BB8ED"
            onPress={() => {
              state.auth.setRemember(true);
              // Full-page navigation: the SPA router would otherwise swallow
              // this same-origin URL
              window.location.assign(
                `${CONFIGURATION.DEFAULT_API_URL}/auth/oauth/google`,
              );
            }}
          >
            <Trans>Continue with Google</Trans>
          </Button>
        </div>
        <Show when={props.terms}>
          {/* Sibling <Trans> fragments on purpose, as on the sign-up page:
              links nested inside one <Trans> render their text three times. */}
          <div style={{ "text-align": "center" }}>
            <Text class="label" size="small">
              <Trans>By registering you agree to our</Trans>{" "}
              <a
                href="https://sloga.gg/legal/terms.html"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Trans>Terms of Service</Trans>
              </a>{" "}
              <Trans>and</Trans>{" "}
              <a
                href="https://sloga.gg/legal/privacy.html"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Trans>Privacy Policy</Trans>
              </a>
              .
            </Text>
          </div>
        </Show>
        <Show when={props.orEmail}>
          <Text class="label" size="small">
            <Trans>or sign up with email</Trans>
          </Text>
        </Show>
      </div>
    </Show>
  );
}
