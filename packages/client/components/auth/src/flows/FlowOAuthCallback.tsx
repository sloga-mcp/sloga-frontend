import { Match, Switch, createSignal, onCleanup, onMount } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";

import { useClientLifecycle } from "@revolt/client";
import { State, TransitionType } from "@revolt/client/Controller";
import { CONFIGURATION } from "@revolt/common";
import { normalizeReferralCode } from "@revolt/common/lib/referralCode";
import { useModals } from "@revolt/modal";
import { Navigate, useNavigate } from "@revolt/routing";
import {
  Button,
  CircularProgress,
  Column,
  Row,
  Text,
  iconSize,
} from "@revolt/ui";
import { styled } from "styled-system/jsx";

import MdArrowBack from "@material-design-icons/svg/filled/arrow_back.svg?component-solid";

import { useState } from "@revolt/state";
import { FlowTitle } from "./Flow";
import { Fields, Form } from "./Form";

/**
 * Outcome of checking a referral code against the server
 */
type ReferralCheck = "found" | "missing" | "unknown";

/**
 * State of the referral field as shown to the user
 */
type ReferralStatus = "empty" | "malformed" | "checking" | ReferralCheck;

/**
 * Wait after the last keystroke before checking a code
 */
const REFERRAL_CHECK_DEBOUNCE_MS = 400;

/**
 * Give up on a check after this long; an unreachable server never blocks
 * signup
 */
const REFERRAL_CHECK_TIMEOUT_MS = 5000;

/**
 * Longest invite code the onboarding route accepts
 */
const INVITE_CODE_MAX_LENGTH = 128;

/**
 * Ask the server whether a normalized referral code exists. Only a definite
 * 404 counts as missing; anything else (rate limit, outage, timeout) is
 * unknown and left for onboarding to decide.
 */
async function fetchReferralCheck(code: string): Promise<ReferralCheck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REFERRAL_CHECK_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${CONFIGURATION.DEFAULT_API_URL}/referrals/codes/${encodeURIComponent(code)}`,
      { signal: controller.signal },
    );

    if (response.status === 204) return "found";
    if (response.status === 404) return "missing";
    return "unknown";
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Server invite code from a pending `/invite/:code` redirect, if signup
 * started from an invite link
 */
function inviteCodeFromPath(path: string | undefined): string | undefined {
  const code = path?.match(/^\/invite\/([^/?#]+)\/?$/)?.[1];
  return code && code.length <= INVITE_CODE_MAX_LENGTH ? code : undefined;
}

/**
 * Error type of a failed API call; the API client throws the raw response
 * body as text, so a string is parsed first
 * @param error Thrown value
 */
function apiErrorType(error: unknown): unknown {
  let body = error;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return undefined;
    }
  }

  return (body as { type?: unknown } | null | undefined)?.type;
}

const ReferralHint = styled("span", {
  base: {
    fontSize: "0.875rem",
  },
  variants: {
    tone: {
      error: { color: "var(--md-sys-color-error)" },
      muted: { color: "var(--md-sys-color-on-surface-variant)" },
    },
  },
});

/**
 * Onboarding step after an OAuth sign-in: pick a username, optionally with
 * a referral code
 */
function ChooseUsername() {
  const state = useState();
  const { lifecycle, selectUsername } = useClientLifecycle();

  const initialReferral = state.layout.referralCode ?? "";

  // Settled field value: follows typing after the debounce, and at once on
  // submit, so the hint doesn't flash while a code is half typed
  const [referralInput, setReferralInput] = createSignal(initialReferral);
  const [checks, setChecks] = createSignal<Record<string, ReferralCheck>>({});
  const inFlight = new Map<string, Promise<ReferralCheck>>();

  let debounce: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(debounce));

  /**
   * Check a normalized code once; found and missing are final, an unknown
   * result is retried on the next check
   */
  function checkReferralCode(code: string): Promise<ReferralCheck> {
    const known = checks()[code];
    if (known === "found" || known === "missing") {
      return Promise.resolve(known);
    }

    let request = inFlight.get(code);
    if (!request) {
      if (known === "unknown") {
        setChecks((prev) => {
          const next = { ...prev };
          delete next[code];
          return next;
        });
      }

      request = fetchReferralCheck(code).then((result) => {
        inFlight.delete(code);
        setChecks((prev) => ({ ...prev, [code]: result }));
        return result;
      });
      inFlight.set(code, request);
    }

    return request;
  }

  /**
   * Settle the field value and check it if it could be a code
   * @param value Raw field value
   */
  function settleReferral(value: string) {
    clearTimeout(debounce);
    setReferralInput(value);

    const code = normalizeReferralCode(value);
    if (code) void checkReferralCode(code);
  }

  const referralStatus = (): ReferralStatus => {
    const value = referralInput();
    if (!value.trim()) return "empty";

    const code = normalizeReferralCode(value);
    if (!code) return "malformed";

    return checks()[code] ?? "checking";
  };

  onMount(() => {
    if (initialReferral.trim()) settleReferral(initialReferral);
  });

  /**
   * Track typing in the referral field
   * @param event Input event, retargeted to the text field host
   */
  function onFieldInput(event: Event) {
    const field = event.target as { name?: unknown; value?: unknown } | null;
    if (field?.name !== "referral_code") return;

    const value = typeof field.value === "string" ? field.value : "";
    clearTimeout(debounce);
    debounce = setTimeout(
      () => settleReferral(value),
      REFERRAL_CHECK_DEBOUNCE_MS,
    );
  }

  /**
   * Select a new username
   * @param data Form Data
   */
  async function select(data: FormData) {
    const username = data.get("username") as string;
    const referralValue = (data.get("referral_code") as string | null) ?? "";

    settleReferral(referralValue);

    // Onboarding fails outright on an unknown code, so never send one that
    // is malformed or known to be missing; the hint says why
    let referral_code: string | undefined;
    if (referralValue.trim()) {
      const code = normalizeReferralCode(referralValue);
      if (!code) return;
      if ((await checkReferralCode(code)) === "missing") return;
      referral_code = code;
    }

    try {
      await selectUsername(username, {
        referral_code,
        invite_code: inviteCodeFromPath(state.get("layout").nextPath),
      });
    } catch (error) {
      // The code can stop resolving between the check and the submit
      // (owner deleted); show the inline hint alongside the form error
      if (referral_code && apiErrorType(error) === "InvalidReferralCode") {
        const code = referral_code;
        setChecks((prev) => ({ ...prev, [code]: "missing" }));
      }

      throw error;
    }
  }

  return (
    <>
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
        {/* Input events bubble up from the fields; `contents` leaves the
            layout to the form's column */}
        <div onInput={onFieldInput} style={{ display: "contents" }}>
          <Fields
            fields={[
              "username",
              { field: "referral_code", value: initialReferral },
            ]}
          />
          <Switch>
            <Match when={referralStatus() === "malformed"}>
              <ReferralHint tone="error" role="status">
                <Trans>That doesn't look like a referral code</Trans>
              </ReferralHint>
            </Match>
            <Match when={referralStatus() === "missing"}>
              <ReferralHint tone="error" role="status">
                <Trans>Code not found — clear it to continue</Trans>
              </ReferralHint>
            </Match>
            <Match when={referralStatus() === "unknown"}>
              <ReferralHint tone="muted" role="status">
                <Trans>Couldn't check the code</Trans>
              </ReferralHint>
            </Match>
          </Switch>
        </div>
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
    </>
  );
}

/**
 * Landing page for OAuth redirects (/login/oauth?code=...)
 *
 * Swaps the one-time handoff code from the backend for a session and
 * then follows the same lifecycle as a password login (including MFA
 * and username onboarding).
 */
export default function FlowOAuthCallback() {
  const state = useState();
  const modals = useModals();
  const navigate = useNavigate();
  const { lifecycle, isLoggedIn, isError, completeOauth } =
    useClientLifecycle();

  const [error, setError] = createSignal<string>();

  onMount(async () => {
    const params = new URLSearchParams(window.location.search);
    const serverError = params.get("error");
    const code = params.get("code");

    if (serverError || !code) {
      setError(serverError ?? "invalid_request");
      return;
    }

    state.auth.setRemember(true);

    try {
      await completeOauth(code, modals);
    } catch (err) {
      console.error("OAuth login failed:", err);
      setError("login_failed");
    }
  });

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
                Something went wrong while signing you in with Google. Please
                try again.
              </Trans>
            }
          >
            <Match when={error() === "cancelled"}>
              <Trans>The Google sign-in was canceled.</Trans>
            </Match>
            <Match when={error() === "email_unverified"}>
              <Trans>
                Your Google account's email address is not verified.
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
              <MdArrowBack {...iconSize("1.2em")} /> <Trans>Back to login</Trans>
            </Button>
          </a>
        </Row>
      </Match>
      {/* The login lifecycle can end in State.Error (a server error on the
          socket, or a failed onboarding check), which would otherwise leave
          the spinner up forever. Dismissing goes back to Ready, which this
          page doesn't render, so the button also leads back to the login.
          It navigates in onPress rather than through an anchor: a keyboard
          press never clicks a wrapping link. */}
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
          onPress={() => {
            lifecycle.transition({
              type: TransitionType.Dismiss,
            });
            navigate("/login/auth");
          }}
        >
          <Trans>OK</Trans>
        </Button>
      </Match>
      <Match when={lifecycle.state() === State.Onboarding}>
        <ChooseUsername />
      </Match>
    </Switch>
  );
}
