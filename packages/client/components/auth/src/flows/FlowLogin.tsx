import {
  Match,
  Show,
  Switch,
  createResource,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import { Capacitor } from "@capacitor/core";
import { Trans, useLingui } from "@lingui-solid/solid/macro";

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

import { CONFIGURATION, isNativeShell } from "@revolt/common";
import {
  PasskeyError,
  cancelPasskeyCeremony,
  getPasskey,
  getPasskeysAdvert,
  passkeysSupported,
} from "@revolt/common/lib/passkey";
import { normalizeReferralCode } from "@revolt/common/lib/referralCode";
import { useState } from "@revolt/state";
import { styled } from "styled-system/jsx";
import { FlowTitle } from "./Flow";
import { Fields, Form, FormError } from "./Form";
import hopOnSloga from "./hop-on-sloga.mp4";
import { passkeyRecoveryOffered } from "./passkeySignup";

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
export function inviteCodeFromPath(
  path: string | undefined,
): string | undefined {
  const code = path?.match(/^\/invite\/([^/?#]+)\/?$/)?.[1];
  return code && code.length <= INVITE_CODE_MAX_LENGTH ? code : undefined;
}

/**
 * Error type of a failed API call. The API client throws the raw response
 * body as text, so a string is parsed before reading its type.
 */
function apiErrorType(error: unknown): unknown {
  let body = error;
  if (typeof error === "string") {
    try {
      body = JSON.parse(error);
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
 * Onboarding step: pick a username, optionally with a referral code
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
        <div
          onInput={onFieldInput}
          style={{
            display: "flex",
            "flex-direction": "column",
            gap: "inherit",
            width: "100%",
          }}
        >
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
 * What the login form shows about passkeys: the sign-in button, the note for
 * the desktop apps (which cannot use passkeys yet), or nothing
 */
type PasskeySignIn = "offer" | "desktop" | "off";

/**
 * Decide what the login form shows about passkeys. Nothing unless the server
 * has passkeys turned on.
 */
async function fetchPasskeySignIn(): Promise<PasskeySignIn> {
  const advert = await getPasskeysAdvert(CONFIGURATION.DEFAULT_API_URL);
  if (!advert.available) return "off";

  if (await passkeysSupported()) return "offer";

  return isDesktopShell() ? "desktop" : "off";
}

/**
 * Whether this is one of the desktop apps (Tauri or Electron), which cannot
 * use passkeys yet
 */
function isDesktopShell(): boolean {
  return isNativeShell() && !Capacitor.isNativePlatform();
}

/**
 * Whether the login form links to lost-passkey recovery. Only when the
 * server offers it; the link is mailed, so this device needs no passkey
 * support. Never in the desktop apps: recovery ends by signing in with the
 * new passkey, which they cannot do.
 */
async function fetchPasskeyRecovery(): Promise<boolean> {
  if (isDesktopShell()) return false;

  return passkeyRecoveryOffered(
    await getPasskeysAdvert(CONFIGURATION.DEFAULT_API_URL),
  );
}

/**
 * Flow for logging into an account
 */
export default function FlowLogin() {
  const state = useState();
  const modals = useModals();
  const { t } = useLingui();
  const { lifecycle, isLoggedIn, isError, login, passkeyLogin } =
    useClientLifecycle();

  const [keepLoggedIn, setKeepLoggedIn] = createSignal(true);
  const [oauthGoogle] = createResource(fetchOauthGoogleEnabled);
  const [passkeySignIn] = createResource(fetchPasskeySignIn);
  const [passkeyRecovery] = createResource(fetchPasskeyRecovery);

  const [passkeyBusy, setPasskeyBusy] = createSignal(false);
  const [passkeyError, setPasskeyError] = createSignal<unknown>();

  // The last passkey attempt ended as cancelled, which is also how a prompt
  // that never appeared ends
  const [passkeyQuiet, setPasskeyQuiet] = createSignal(false);

  // The password form is signing in. One login at a time: each kind keeps
  // the other's button disabled while it runs.
  const [passwordBusy, setPasswordBusy] = createSignal(false);

  // Set when a password login takes over from a passkey attempt, so that
  // attempt opens no prompt and shows nothing when it ends
  let passkeyAbandoned = false;

  /**
   * What to show for a failed passkey sign-in; `undefined` shows nothing
   * @param error Thrown value
   */
  function passkeyLoginError(error: unknown): unknown {
    if (error instanceof PasskeyError) {
      switch (error.code) {
        // The user closed the prompt, or it never appeared: the quiet line
        // under the button covers both
        case "cancelled":
          return undefined;
        case "unavailable":
          return new Error(t`Passkeys are not available on this device.`);
        // Only Android 14+ can say "no passkey here"; elsewhere it reads as
        // a plain failure, so both get the same message
        case "no_credential":
        case "failed":
          return new Error(
            t`Could not sign in. There may be no passkey for Sloga on this device.`,
          );
        default: {
          const exhaustive: never = error.code;
          return exhaustive;
        }
      }
    }

    switch (apiErrorType(error)) {
      case "InvalidCredentials":
        return new Error(
          t`The passkey was not accepted. Try again, or sign in another way.`,
        );
      case "FeatureDisabled":
        return new Error(t`Passkeys are turned off right now.`);
      default:
        // Everything else (unverified, locked out, suspended, network) reads
        // as it does for a password login
        return error;
    }
  }

  /**
   * Sign in with a passkey. The exchange with the server is `passkeyLogin`
   * in client/Controller.ts; this runs the prompt for it and shows what
   * went wrong.
   */
  async function performPasskeyLogin() {
    if (passkeyBusy() || passwordBusy()) return;

    setPasskeyBusy(true);
    setPasskeyError(undefined);
    setPasskeyQuiet(false);
    passkeyAbandoned = false;

    try {
      state.auth.setRemember(keepLoggedIn());

      await passkeyLogin(
        (options) =>
          passkeyAbandoned
            ? Promise.reject(new PasskeyError("cancelled"))
            : getPasskey(options),
        modals,
      );
    } catch (error) {
      // The password login that took over reports its own outcome
      if (passkeyAbandoned) return;

      // Not logged: the thrown value is shown, never the options or the
      // credential
      setPasskeyError(passkeyLoginError(error));
      setPasskeyQuiet(
        error instanceof PasskeyError && error.code === "cancelled",
      );
    } finally {
      setPasskeyBusy(false);
    }
  }

  /**
   * Log into account
   * @param data Form Data
   */
  async function performLogin(data: FormData) {
    const email = data.get("email") as string;
    const password = data.get("password") as string;

    if (!email || !password) return;

    // One password login at a time
    if (passwordBusy()) return;

    // A passkey prompt that never answers must not block a password login:
    // give up on it and go on
    if (passkeyBusy()) {
      passkeyAbandoned = true;
      cancelPasskeyCeremony();
    }

    setPasswordBusy(true);
    try {
      state.auth.setRemember(keepLoggedIn());

      await login(
        {
          email,
          password,
        },
        modals,
      );
    } finally {
      setPasswordBusy(false);
    }
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
                "width": "100%",
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
            <div style={{"--md-sys-color-primary": "#FF8A00", "--mdui-color-primary": "255, 138, 0", "--md-sys-color-on-primary": "#05090F", "--mdui-color-on-primary": "5, 9, 15", "display": "contents"}}>
            <Form onSubmit={performLogin}>
              <Fields fields={["email", "password"]} />
              <div
                style={{
                  "display": "flex",
                  "align-items": "center",
                  "justify-content": "space-between",
                  "gap": "var(--gap-md)",
                  "width": "100%",
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
              <div style={{"display": "flex", "flex-direction": "column", "gap": "inherit", "width": "100%"}}>
                <Show when={passkeySignIn() === "offer"}>
                  <Row align justify>
                    <Button
                      size="md"
                      variant="tonal"
                      isDisabled={passkeyBusy() || passwordBusy()}
                      onPress={() => void performPasskeyLogin()}
                    >
                      <Trans>Sign in with a passkey</Trans>
                    </Button>
                  </Row>
                  <Show when={passkeyQuiet()}>
                    <Row align justify>
                      <Text class="label" size="small">
                        <Trans>Nothing happened? Try again.</Trans>
                      </Text>
                    </Row>
                  </Show>
                </Show>
                <Show when={passkeyError()}>
                  <FormError error={passkeyError()} />
                </Show>
                <Show when={passkeySignIn() === "desktop"}>
                  <Text class="label" size="small">
                    <Trans>
                      Passkeys do not work in the desktop app yet. If your
                      account signs in with a passkey, add a password in
                      Settings on your phone to use the desktop app.
                    </Trans>
                  </Text>
                </Show>
                <Show when={passkeyRecovery()}>
                  <Row align justify>
                    <a href="/login/passkey/lost">
                      <Button variant="text">
                        <Trans>Lost your passkey?</Trans>
                      </Button>
                    </a>
                  </Row>
                </Show>
                <Show when={oauthGoogle()}>
                  <Row align justify>
                    <Button
                      size="md"
                      bg="#3BB8ED"
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
              </div>
            </Form>
            </div>
          </>
        }
      >
        <Match when={isLoggedIn()}>
          <Navigate href={state.layout.popNextPath() ?? "/app"} />
        </Match>
        {/* A failure right after login used to fall through to the form with
            no message; show the same notice FlowHome renders on /login. */}
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
        <Match when={lifecycle.state() === State.LoggingIn}>
          <CircularProgress />
        </Match>
        <Match when={lifecycle.state() === State.Onboarding}>
          <ChooseUsername />
        </Match>
      </Switch>
    </>
  );
}
