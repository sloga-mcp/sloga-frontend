import {
  Match,
  Show,
  Switch,
  createResource,
  createSignal,
  onCleanup,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import { useClient, useClientLifecycle } from "@revolt/client";
import { apiErrorType } from "@revolt/client/apiErrorType";
import { CONFIGURATION } from "@revolt/common";
import {
  PasskeyError,
  createPasskey,
  getPasskeysAdvert,
  passkeysSupported,
} from "@revolt/common/lib/passkey";
import { normalizeReferralCode } from "@revolt/common/lib/referralCode";
import { Navigate, useNavigate, useParams } from "@revolt/routing";
import { useState } from "@revolt/state";
import {
  Button,
  Checkbox,
  CircularProgress,
  Row,
  Text,
  TextField,
} from "@revolt/ui";

import { FlowTitle } from "./Flow";
import { inviteCodeFromPath } from "./FlowLogin";
import { Fields, Form, FormError } from "./Form";
import { usePasskeySession } from "./passkeySession";
import {
  type PasskeySignupGate,
  type SignupProblem,
  type SignupStep,
  passkeySignupGate,
  passkeySignupProblem,
  resendWaitSeconds,
  signupCodeFrom,
  signupStartsAgain,
} from "./passkeySignup";

/**
 * Whether this page is offered at all, and whether it needs an email.
 * Never rejects: both lookups read as "off" when they fail.
 */
async function fetchSignupGate(): Promise<PasskeySignupGate> {
  const [advert, supported] = await Promise.all([
    getPasskeysAdvert(CONFIGURATION.DEFAULT_API_URL),
    passkeysSupported(),
  ]);

  return passkeySignupGate(advert, supported);
}

/**
 * Flow for creating a new account with a passkey: the details, then the
 * emailed code when an email was given, then the passkey itself. Shows
 * nothing unless the server offers passkey sign-up.
 */
export default function FlowCreatePasskey() {
  const { t } = useLingui();
  const state = useState();
  const getClient = useClient();
  const navigate = useNavigate();
  const { code } = useParams();
  const { isLoggedIn } = useClientLifecycle();
  const session = usePasskeySession();

  const [gate] = createResource(fetchSignupGate);

  const [step, setStep] = createSignal<"form" | "code" | "create">("form");

  // Id of the pending sign-up. A secret while the sign-up lasts: never logged.
  const [signupId, setSignupId] = createSignal<string>();

  // What was typed, so the form comes back filled in after "start again"
  const [draft, setDraft] = createSignal({
    username: "",
    email: "",
    referral: state.layout.referralCode ?? "",
  });

  // What is in the email field. Kept apart from `draft`, so the field can be
  // taken away (the "no email" box) and come back with what was typed.
  let typedEmail = "";
  const [keptEmail, setKeptEmail] = createSignal("");

  const [noEmail, setNoEmail] = createSignal(false);
  const [acknowledged, setAcknowledged] = createSignal(false);

  // Shown above the form after a sign-up had to start again
  const [notice, setNotice] = createSignal<unknown>();

  // Code step
  const [sentAt, setSentAt] = createSignal(0);
  const [resending, setResending] = createSignal(false);
  const [resent, setResent] = createSignal(false);
  const [resendError, setResendError] = createSignal<unknown>();

  // Passkey step
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<unknown>();
  const [quiet, setQuiet] = createSignal(false);

  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(clock));

  const resendWait = () => resendWaitSeconds(sentAt(), now());

  const passwordPath = () => `/login/create${code ? "/" + code : ""}`;

  const isInviteOnly = () => {
    const client = getClient();
    if (client.configured()) {
      return client.configuration?.features.invite_only;
    }
    return false;
  };

  /**
   * A refusal in the person's words
   */
  function problemText(problem: SignupProblem): string {
    switch (problem) {
      case "off":
        return t`Passkeys are turned off right now.`;
      case "email_required":
        return t`Signing up without an email is not available right now. Add an email to continue.`;
      case "bad_code":
        return t`That code is wrong or has expired. Check it, or start again.`;
      case "expired":
        return t`This sign-up has expired. Start again.`;
      case "invite_invalid":
        return t`This invite code is not valid.`;
      case "invite_missing":
        return t`You need an invite code to sign up.`;
      case "username_taken":
        return t`This username is already taken.`;
      case "already_registered":
        return t`This passkey is already registered. Start again and create a new one.`;
      case "not_accepted":
        return t`The passkey was not accepted. Try again.`;
      default: {
        const exhaustive: never = problem;
        return exhaustive;
      }
    }
  }

  /**
   * What to show for a failed request: its own words where there are some,
   * else the error as it is
   */
  function explain(failure: unknown, at: SignupStep): unknown {
    const problem = passkeySignupProblem(apiErrorType(failure), at);
    return problem ? new Error(problemText(problem)) : failure;
  }

  /**
   * Drop the pending sign-up and go back to the form
   * @param message Why, shown above the form
   * @param problem Refusal that ended the sign-up, if one did
   */
  function startAgain(message?: string, problem?: SignupProblem) {
    setSignupId(undefined);
    setError(undefined);
    setQuiet(false);
    setNotice(message ? new Error(message) : undefined);

    // The email field has to be there for the next try
    if (problem === "email_required") {
      setNoEmail(false);
      setAcknowledged(false);
    }

    setStep("form");
  }

  /**
   * Send the details. Nothing about the account can change after this.
   * @param data Form Data
   */
  async function start(data: FormData) {
    const username = ((data.get("username") as string | null) ?? "").trim();
    const email = noEmail()
      ? undefined
      : ((data.get("email") as string | null) ?? "").trim() || undefined;
    const referralValue = (data.get("referral_code") as string | null) ?? "";
    const invite = ((data.get("invite") as string | null) ?? "").trim();
    const captcha = (data.get("captcha") as string | null) ?? "";

    setNotice(undefined);
    setDraft({ username, email: email ?? "", referral: referralValue });

    if (!noEmail()) {
      typedEmail = email ?? "";
      setKeptEmail(typedEmail);
    }

    if (!email && !acknowledged()) {
      throw new Error(
        noEmail()
          ? t`Tick the box to confirm before you continue.`
          : t`Please enter your email.`,
      );
    }

    // The server refuses the whole sign-up for a code it does not know, and
    // says so; only a code that cannot be one is stopped here
    let referral_code: string | undefined;
    if (referralValue.trim()) {
      referral_code = normalizeReferralCode(referralValue);
      if (!referral_code) {
        throw new Error(t`That doesn't look like a referral code`);
      }
    }

    let reply;
    try {
      reply = await getClient().passkeySignupStart({
        username,
        email,
        no_email_ack: email ? undefined : true,
        invite: invite || undefined,
        referral_code,
        invite_code: inviteCodeFromPath(state.get("layout").nextPath),
        captcha: captcha || undefined,
      });
    } catch (failure) {
      const problem = passkeySignupProblem(apiErrorType(failure), "start");
      if (problem === "email_required") {
        setNoEmail(false);
        setAcknowledged(false);
      }

      throw problem ? new Error(problemText(problem)) : failure;
    }

    setSignupId(reply.signup_id);
    setError(undefined);
    setQuiet(false);

    if (reply.email_code_required) {
      setResent(false);
      setResendError(undefined);
      setSentAt(Date.now());
      setStep("code");
    } else {
      setStep("create");
    }
  }

  /**
   * Confirm the email with the code that was mailed
   * @param data Form Data
   */
  async function confirmCode(data: FormData) {
    const id = signupId();
    if (!id) return;

    const typed = signupCodeFrom((data.get("code") as string | null) ?? "");
    if (!typed) {
      throw new Error(t`Enter the 8 digits from the email.`);
    }

    try {
      await getClient().passkeySignupCode(id, typed);
    } catch (failure) {
      // Wrong codes are not counted here: the server does that, and its
      // answers alone decide whether the sign-up goes on
      const problem = passkeySignupProblem(apiErrorType(failure), "code");

      if (problem && signupStartsAgain(problem, "code")) {
        startAgain(problemText(problem), problem);
        return;
      }

      throw problem ? new Error(problemText(problem)) : failure;
    }

    setStep("create");
  }

  /**
   * Ask for a new code. The server answers the same whether or not a mail
   * went out, so this only ever says "sent".
   */
  async function resend() {
    const id = signupId();
    if (!id || resending() || resendWait() > 0) return;

    setResending(true);
    setResent(false);
    setResendError(undefined);

    try {
      await getClient().passkeySignupResend(id);
      setSentAt(Date.now());
      setResent(true);
    } catch (failure) {
      const problem = passkeySignupProblem(apiErrorType(failure), "resend");
      if (problem && signupStartsAgain(problem, "resend")) {
        startAgain(problemText(problem), problem);
        return;
      }

      setResendError(explain(failure, "resend"));
    } finally {
      setResending(false);
    }
  }

  /**
   * Create the passkey and the account. Runs from the tap on "Create
   * passkey", with one request between the tap and the prompt.
   */
  async function createAccount() {
    const id = signupId();
    if (busy() || !id) return;

    setBusy(true);
    setError(undefined);
    setQuiet(false);

    let at: SignupStep = "options";
    try {
      // The last request makes a session, and the client keeps it at once:
      // it is never sent from a page that already has one in use
      session.ensureFree();

      const client = getClient();
      const challenge = await client.passkeySignupOptions(id);
      const credential = await createPasskey(challenge.options);

      at = "finish";

      // Again: the prompt can stay open for a long time
      session.ensureFree();

      const friendlyName = session.friendlyName();
      const reply = await client.passkeySignupFinish(
        challenge.challenge_id,
        credential as Record<string, unknown>,
        friendlyName,
      );

      await session.adopt(reply, friendlyName);
      state.layout.setReferralCode(undefined);

      // The login page takes it from here, as after a password sign-up
      navigate("/login/auth", { replace: true });
    } catch (failure) {
      // Not logged: the thrown value is shown, never the options or the
      // credential
      if (failure instanceof PasskeyError) {
        switch (failure.code) {
          // The person closed the prompt, or it never appeared
          case "cancelled":
            setQuiet(true);
            break;
          case "unavailable":
            setError(new Error(t`Passkeys are not available on this device.`));
            break;
          case "no_credential":
          case "failed":
            setError(
              new Error(t`The passkey could not be created. Try again.`),
            );
            break;
          default: {
            const exhaustive: never = failure.code;
            setError(exhaustive);
          }
        }
        return;
      }

      const problem = passkeySignupProblem(apiErrorType(failure), at);
      if (problem && signupStartsAgain(problem, at)) {
        startAgain(problemText(problem), problem);
        return;
      }

      setError(problem ? new Error(problemText(problem)) : failure);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Line above the code field
   */
  const codeIntro = () => {
    const email = draft().email;
    return t`Enter the 8-digit code sent to ${email}. If no code arrives, try again later.`;
  };

  /**
   * Label of the "send again" button
   */
  const resendLabel = () => {
    const seconds = resendWait();
    return seconds > 0 ? t`Send again in ${seconds} s` : t`Send again`;
  };

  return (
    <Switch>
      {/* Already signed in: no second account is made over a live session.
          Sent on as the login page sends a signed-in visitor on. */}
      <Match when={isLoggedIn()}>
        <Navigate href={state.layout.popNextPath() ?? "/app"} />
      </Match>
      <Match when={gate() === undefined}>
        <CircularProgress />
      </Match>
      {/* Not offered: this page shows nothing of its own */}
      <Match when={gate() === "off"}>
        <Navigate href={passwordPath()} />
      </Match>
      <Match when={step() === "form"}>
        <FlowTitle
          subtitle={<Trans>Create an account with a passkey</Trans>}
          emoji="wave"
        >
          <Trans>Hello!</Trans>
        </FlowTitle>
        <Text class="body" size="small">
          <Trans>
            No password. You sign in with your fingerprint, face or screen lock.
          </Trans>
        </Text>
        <Show when={notice()}>
          <FormError error={notice()} />
        </Show>
        {/* `code` is already a percent-encoded segment, appended as it is
            (see FlowCreate) */}
        <Form
          onSubmit={start}
          captcha={CONFIGURATION.HCAPTCHA_SITEKEY}
          handoffPath={`/login/passkey/create${code ? "/" + code : ""}`}
          handoffNote={
            <Trans>Then come back here and sign in with your passkey.</Trans>
          }
        >
          <Fields fields={[{ field: "username", value: draft().username }]} />
          <Show when={!noEmail()}>
            <div
              style={{ display: "contents" }}
              onInput={(event) => {
                // Retargeted to the text field host, as in FlowLogin
                const field = event.target as {
                  name?: unknown;
                  value?: unknown;
                } | null;
                if (field?.name !== "email") return;
                typedEmail = typeof field.value === "string" ? field.value : "";
              }}
            >
              <Fields fields={[{ field: "email", value: keptEmail() }]} />
            </div>
            <Text class="label" size="small">
              <Trans>
                With an email you can get back in if you lose your passkey. We
                send a code to confirm it.
              </Trans>
            </Text>
          </Show>
          <Show when={gate() === "email_optional"}>
            <Checkbox
              checked={noEmail()}
              onChange={(event) => {
                const ticked = event.currentTarget.checked;

                // The email field goes away while the box is ticked. Keep
                // what was typed, so unticking brings it back.
                if (ticked) setKeptEmail(typedEmail);

                setNoEmail(ticked);
                setAcknowledged(false);
              }}
            >
              <Trans>Sign up without an email</Trans>
            </Checkbox>
            <Show when={noEmail()}>
              <Text class="label" size="small">
                <Trans>
                  Without an email, a lost passkey cannot be replaced. Nobody,
                  including Sloga, can get you back into the account. Supporter
                  perks and referral rewards also need an email.
                </Trans>
              </Text>
              <Checkbox
                checked={acknowledged()}
                onChange={(event) =>
                  setAcknowledged(event.currentTarget.checked)
                }
              >
                <Trans>
                  I understand that this account cannot be recovered if I lose
                  my passkey
                </Trans>
              </Checkbox>
            </Show>
          </Show>
          <Fields
            fields={[{ field: "referral_code", value: draft().referral }]}
          />
          <Show when={isInviteOnly()}>
            <Fields fields={[{ field: "invite", value: code }]} />
          </Show>
          {/* Same terms line as the password sign-up, in the same sibling
              fragments: links nested inside one translated block render
              three times (see FlowCreate) */}
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
          <Row justify>
            <a href={passwordPath()}>
              <Button variant="text">
                <Trans>Use a password instead</Trans>
              </Button>
            </a>
            <Button type="submit">
              <Trans>Continue</Trans>
            </Button>
          </Row>
        </Form>
      </Match>
      <Match when={step() === "code"}>
        <FlowTitle emoji="mail">
          <Trans>Confirm your email</Trans>
        </FlowTitle>
        <Text class="body" size="small">
          {codeIntro()}
        </Text>
        <Form onSubmit={confirmCode}>
          <label>
            <TextField
              required
              name="code"
              type="text"
              inputmode="numeric"
              autocomplete="one-time-code"
              label={t`Code`}
            />
          </label>
          <Row justify>
            <Button variant="text" onPress={() => startAgain()}>
              <Trans>Start again</Trans>
            </Button>
            <Button type="submit">
              <Trans>Confirm</Trans>
            </Button>
          </Row>
        </Form>
        <Row align justify>
          <Button
            variant="text"
            isDisabled={resending() || resendWait() > 0}
            onPress={() => void resend()}
          >
            {resendLabel()}
          </Button>
        </Row>
        <Show when={resent()}>
          <Row align justify>
            <Text class="label" size="small">
              <Trans>If a code could be sent, only the newest one works.</Trans>
            </Text>
          </Row>
        </Show>
        <Show when={resendError()}>
          <FormError error={resendError()} />
        </Show>
      </Match>
      <Match when={step() === "create"}>
        <FlowTitle>
          <Trans>Create your passkey</Trans>
        </FlowTitle>
        <Text class="body" size="small">
          <Trans>
            Select this to save the passkey. Your device will then ask for your
            fingerprint, face or screen lock.
          </Trans>
        </Text>
        <Button isDisabled={busy()} onPress={() => void createAccount()}>
          <Trans>Create passkey</Trans>
        </Button>
        <Show when={quiet()}>
          <Row align justify>
            <Text class="label" size="small">
              <Trans>Nothing happened? Try again.</Trans>
            </Text>
          </Row>
        </Show>
        <Show when={error()}>
          <FormError error={error()} />
        </Show>
        <Row align justify>
          <Button
            variant="text"
            isDisabled={busy()}
            onPress={() => startAgain()}
          >
            <Trans>Start again</Trans>
          </Button>
        </Row>
      </Match>
    </Switch>
  );
}
