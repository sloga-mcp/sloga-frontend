import { createSignal, Match, Show, Switch } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";

import { useApi } from "@revolt/client";
import { useParams } from "@revolt/routing";
import { Button, iconSize, Text } from "@revolt/ui";
import { styled } from "styled-system/jsx";

import MdError from "@material-design-icons/svg/filled/error.svg?component-solid";

import { FlowTitle } from "./Flow";

/**
 * Where the confirm page is: waiting for the user, sending, or settled
 */
type State = "idle" | "pending" | "deleted" | "error";

/**
 * Why a confirm failed:
 * - `owns-servers`: refused because the account still owns servers; the
 *   link stays valid, so the button stays available
 * - `retry`: no answer, rate limited or a server failure; the link may be
 *   fine, so the button stays available
 * - `invalid`: the link is spent, expired or cancelled (terminal)
 */
type Failure = "owns-servers" | "retry" | "invalid";

/**
 * Classify what `api.put` threw. stoat-api throws the error response body
 * as text (it does not expose the HTTP status), and `fetch` throws a
 * TypeError when no response arrived at all.
 *
 * Keep this self-contained (no imports, no outer names):
 * flowDelete.scan.test.ts lifts it out of this file and runs it.
 */
function deleteFailure(error: unknown): Failure {
  let body: unknown = error;
  if (typeof error === "string") {
    try {
      body = JSON.parse(error);
    } catch {
      // The API answers errors in JSON, so an empty or HTML body came from
      // a proxy or gateway in front of it (502/503/504), not from the link
      return "retry";
    }
  }

  // Offline, DNS or CORS failure: the request never got an answer
  if (typeof body !== "object" || body === null || body instanceof Error) {
    return "retry";
  }

  const { type, retry_after } = body as {
    type?: unknown;
    retry_after?: unknown;
  };

  // 400 InvalidOperation: this page always sends confirm: true, so this is
  // the owned-servers refusal, which leaves the token untouched
  if (type === "InvalidOperation") return "owns-servers";

  // 429: the rate limiter's body is { retry_after } with no type
  if (typeof retry_after === "number") return "retry";

  // 5xx: the server failed, which says nothing about the link
  if (
    type === "InternalError" ||
    type === "DatabaseError" ||
    type === "OperationFailed" ||
    type === "LabelMe"
  ) {
    return "retry";
  }

  // InvalidToken and anything else
  return "invalid";
}

const Notice = styled("span", {
  base: {
    color: "var(--md-sys-color-error)",
    display: "flex",
    alignItems: "center",
    gap: "0.25em",
  },
});

/**
 * Flow for confirming account deletion from the emailed link
 *
 * Nothing is sent when the page loads, so an email link scanner that opens
 * the link cannot delete the account. Only pressing the button does.
 */
export default function FlowDeleteAccount() {
  const api = useApi();
  const params = useParams();
  const [state, setState] = createSignal<State>("idle");
  const [failure, setFailure] = createSignal<Failure>();

  /**
   * Confirm the deletion (once; repeat presses while pending are ignored)
   */
  async function confirmDeletion() {
    if (state() !== "idle") return;
    setState("pending");
    setFailure(undefined);

    try {
      // the server requires confirm: true so a cached page that sends only the token on load is refused
      await api.put("/auth/account/delete", {
        token: params.token,
        confirm: true,
      } as { token: string });

      setState("deleted");
    } catch (error) {
      const kind = deleteFailure(error);
      setFailure(kind);
      // only a dead link is terminal; otherwise the button can be pressed again
      setState(kind === "invalid" ? "error" : "idle");
    }
  }

  return (
    <Switch>
      <Match when={state() === "idle" || state() === "pending"}>
        <FlowTitle
          subtitle={
            <Trans>
              This permanently deletes your Sloga account, your messages and
              everything tied to it. There is no going back.
            </Trans>
          }
        >
          <Trans>Delete your account</Trans>
        </FlowTitle>
        <Show when={failure() === "owns-servers" || failure() === "retry"}>
          <Notice role="alert">
            <MdError
              {...iconSize("1rem")}
              fill="currentColor"
              style={{ "flex-shrink": 0 }}
            />
            <Text class="label" size="small">
              <Switch>
                <Match when={failure() === "owns-servers"}>
                  <Trans>
                    You still own one or more servers. Transfer or delete them
                    in Sloga, then come back to this link.
                  </Trans>
                </Match>
                <Match when={failure() === "retry"}>
                  <Trans>
                    Something went wrong. Check your connection and try again.
                  </Trans>
                </Match>
              </Switch>
            </Text>
          </Notice>
        </Show>
        <Button
          variant="_error"
          isDisabled={state() === "pending"}
          onPress={confirmDeletion}
        >
          <Trans>Delete permanently</Trans>
        </Button>
      </Match>
      <Match when={state() === "deleted"}>
        <FlowTitle subtitle={<Trans>Thanks for being part of Sloga.</Trans>}>
          <Trans>Your account has been deleted.</Trans>
        </FlowTitle>
      </Match>
      <Match when={state() === "error"}>
        <FlowTitle
          subtitle={
            <Trans>
              This link is invalid or has expired, or the request was cancelled
              because you signed in. To delete your account, sign in and start
              again from Settings → Account Info.
            </Trans>
          }
        >
          <Trans>Delete your account</Trans>
        </FlowTitle>
        <a href="/login/auth">
          <Button variant="text">
            <Trans>Go back to login</Trans>
          </Button>
        </a>
      </Match>
    </Switch>
  );
}
