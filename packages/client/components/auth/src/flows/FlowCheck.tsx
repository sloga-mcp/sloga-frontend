import { Show, createSignal, onCleanup, onMount } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";

import { useClientLifecycle } from "@revolt/client";
import { isNativeShell } from "@revolt/common";
import { useModals } from "@revolt/modal";
import { useNavigate } from "@revolt/routing";
import { Button, Row, Text, iconSize } from "@revolt/ui";

import MdArrowBack from "@material-design-icons/svg/filled/arrow_back.svg?component-solid";

import { FlowTitle } from "./Flow";
import { MailProvider } from "./MailProvider";
import { createVerifyWait } from "./verifyWait";

/**
 * Keep track of email within the same session
 */
let email = "postmaster@revolt.wtf";

/**
 * Persist email information temporarily
 */
export function setFlowCheckEmail(e: string) {
  email = e;
}

/**
 * Credentials of the account that was just registered, held in memory only
 * (never stored) until the "Check your mail" step takes them
 */
let pendingSignIn: { email: string; password: string } | undefined;

/**
 * Hand the just-registered credentials to the "Check your mail" step, so a
 * native shell can sign in by itself once the email is confirmed
 */
export function setFlowCheckSignIn(email: string, password: string) {
  pendingSignIn = { email, password };
}

/**
 * Flow to tell the user to check their email
 */
export default function FlowCheck() {
  const navigate = useNavigate();
  const modals = useModals();
  const { login } = useClientLifecycle();

  // Taken once, so the password lives only as long as this step is showing.
  // Native shells only: the confirmation link opens in the system browser,
  // which has its own storage. On the web the link opens in the same browser
  // and signs in there, and a second sign-in from this tab would race it.
  const credentials = isNativeShell() ? pendingSignIn : undefined;
  pendingSignIn = undefined;

  // Whether the app is still going to sign in by itself
  const [waiting, setWaiting] = createSignal(credentials !== undefined);

  onMount(() => {
    if (!credentials) return;

    const wait = createVerifyWait({
      // No MFA dialog from a timer: an account that asks for MFA is not
      // the one just registered (the email already had an account)
      attempt: () => login(credentials, modals, { mfaPrompt: false }),
      onSignedIn: () => navigate("/login/auth", { replace: true }),
      onGaveUp: () => setWaiting(false),
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) =>
        clearTimeout(handle as ReturnType<typeof setTimeout>),
    });

    // Coming back from the browser or the mail app
    const onVisible = () => {
      if (document.visibilityState === "visible") wait.poke();
    };
    const onFocus = () => wait.poke();

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    wait.start();

    onCleanup(() => {
      wait.stop();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    });
  });

  return (
    <>
      <FlowTitle
        subtitle={
          <Trans>
            We've sent you a verification email. Please allow up to 10 minutes
            for it to arrive.
          </Trans>
        }
        emoji="mail"
      >
        <Trans>Check your mail!</Trans>
      </FlowTitle>
      <Show when={waiting()}>
        <Text class="body" size="medium">
          <Trans>
            Keep this app open. Once you open the link in the email, come back
            here and you'll be signed in.
          </Trans>
        </Text>
      </Show>
      <Row align justify>
        <a href="..">
          <Button variant="text">
            <MdArrowBack {...iconSize("1.2em")} /> <Trans>Back</Trans>
          </Button>
        </a>
        <Show when={email}>
          <MailProvider email={email} />
        </Show>
      </Row>
      {import.meta.env.DEV && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            background: "white",
            color: "black",
            cursor: "pointer",
          }}
          onClick={() => {
            navigate("/login/verify/abc", { replace: true });
          }}
        >
          Mock Verify
        </div>
      )}
    </>
  );
}
