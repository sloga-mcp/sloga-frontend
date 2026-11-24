import {
  Match,
  Show,
  Switch,
  createEffect,
  createSignal,
  onMount,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import { useClient, useClientLifecycle } from "@revolt/client";
import { apiErrorType } from "@revolt/client/apiErrorType";
import { CONFIGURATION } from "@revolt/common";
import {
  type PasskeysAdvert,
  PasskeyError,
  createPasskey,
  findPasskeysAdvert,
} from "@revolt/common/lib/passkey";
import { Navigate, useNavigate, useParams } from "@revolt/routing";
import { Button, CircularProgress, Row, Text, TextField } from "@revolt/ui";

import { FlowTitle } from "./Flow";
import { FormError } from "./Form";
import { usePasskeySession } from "./passkeySession";
import {
  type RecoverProblem,
  type RecoverStep,
  passkeyRecoverLookupFailure,
  passkeyRecoverProblem,
  passkeyRecoveryOffered,
  recoverStartsAgain,
  secondFactorFrom,
} from "./passkeySignup";

/**
 * - `loading`: nothing is known yet; the page says nothing
 * - `checking`: the server offers recovery and the link is being looked up
 * - `off`: the server does not offer recovery; the page shows nothing
 * - `ready`: the link is good
 * - `bad_link`: the link is expired, used or unknown
 * - `failed`: the link could not be checked
 */
type Phase = "loading" | "checking" | "off" | "ready" | "bad_link" | "failed";

/** Where the page stays once the token is out of the address bar */
const RECOVER_PATH = "/login/passkey/recover";

/**
 * Flow for replacing a lost passkey from an emailed link
 * (/login/passkey/recover/:token). Shows nothing unless the server offers
 * passkey recovery.
 *
 * The token is a secret for as long as the link lives. It is copied to
 * memory when the page opens and taken out of the address bar, so it is not
 * left in the history or passed along with a later navigation. The page
 * works from the copy; after a reload there is none, and the page asks for
 * the link to be opened again.
 */
export default function FlowPasskeyRecover() {
  const { t } = useLingui();
  const getClient = useClient();
  const navigate = useNavigate();
  const params = useParams();
  const { isLoggedIn, logout } = useClientLifecycle();
  const session = usePasskeySession();

  // Read once, on purpose: the address stops carrying it right after
  // eslint-disable-next-line solid/reactivity
  const token: string | undefined = params.token || undefined;

  onMount(() => {
    if (!token) return;

    // Not through the router: the page must stay as it is, only the address
    // changes. A reload then lands on this page with no token.
    window.history.replaceState(window.history.state, "", RECOVER_PATH);
  });

  const [phase, setPhase] = createSignal<Phase>("loading");
  const [needsCode, setNeedsCode] = createSignal(false);
  const [codeValue, setCodeValue] = createSignal("");

  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<unknown>();
  const [quiet, setQuiet] = createSignal(false);

  /**
   * A refusal in the person's words
   */
  function problemText(problem: RecoverProblem): string {
    switch (problem) {
      case "off":
        return t`Passkeys are turned off right now.`;
      case "bad_link":
        return t`This link has expired or was already used.`;
      case "wrong_code":
        return t`That code is wrong, so the new passkey was not saved. Enter a code and try again.`;
      case "not_accepted":
        return t`The passkey was not accepted. Try again.`;
      case "locked":
        return t`Too many wrong codes. Wait a few minutes, then try again.`;
      case "already_registered":
        return t`This passkey is already registered. Try again to create a new one.`;
      default: {
        const exhaustive: never = problem;
        return exhaustive;
      }
    }
  }

  // What the server says about passkeys, from the last lookup; undefined
  // before the first one and after one that failed
  let advert: PasskeysAdvert | undefined;

  /**
   * Ask the server about the link: whether it is good, and whether a
   * second factor goes with the new passkey. The link stays good. Never
   * throws.
   */
  async function check() {
    if (!token) return;

    try {
      const reply = await getClient().passkeyRecoverStart(token);
      setNeedsCode(reply.second_factor_required === true);
      setPhase("ready");
    } catch (failure) {
      const type = apiErrorType(failure);
      const outcome = passkeyRecoverLookupFailure(type, advert);

      if (outcome === "bad_link") {
        setPhase("bad_link");
        return;
      }

      // Recovery is off, by the server's own word or because it has no
      // such route and does not offer recovery: the page shows nothing
      if (outcome === "off") {
        setPhase("off");
        return;
      }

      // A refusal with a meaning of its own (a rate limit, say) is shown
      // under the notice. A request that never got an answer has none.
      setError(type ? failure : undefined);
      setPhase("failed");
    }
  }

  /**
   * Look the link up, from the start. Also the retry after a failed lookup.
   *
   * The advert decides what is painted while the link is checked, and what
   * a lookup that failed without a reason means: a server that says it does
   * not offer recovery has it off, and the page leaves. A lookup of the
   * advert that failed says nothing either way, so the redirect is never
   * taken on it.
   */
  async function lookUp() {
    setError(undefined);
    setPhase("loading");

    // Never rejects
    advert = await findPasskeysAdvert(CONFIGURATION.DEFAULT_API_URL);
    if (passkeyRecoveryOffered(advert)) setPhase("checking");

    await check();
  }

  // Nothing is asked about the link while a session is in use on this page;
  // the lookup starts once, when there is none (at once, or after "Sign out")
  let lookedUp = false;
  createEffect(() => {
    if (!token || lookedUp || isLoggedIn()) return;
    lookedUp = true;
    void lookUp();
  });

  /**
   * Create the new passkey and sign in. Runs from the tap on "Create new
   * passkey", with one request between the tap and the prompt: each try
   * gets its own challenge, since a refused finish spends the one it used.
   */
  async function replace() {
    if (busy() || !token) return;

    const factor = needsCode() ? secondFactorFrom(codeValue()) : undefined;
    if (needsCode() && !factor) {
      setError(new Error(t`Enter an authenticator code or a recovery code.`));
      return;
    }

    setBusy(true);
    setError(undefined);
    setQuiet(false);

    let at: RecoverStep = "start";
    try {
      // The last request makes a session, and the client keeps it at once:
      // it is never sent from a page that already has one in use
      session.ensureFree();

      const client = getClient();
      const challenge = await client.passkeyRecoverStart(token);

      // A second factor was turned on since the page loaded: ask for it
      // before any passkey is made
      if (challenge.second_factor_required === true && !factor) {
        setNeedsCode(true);
        setError(new Error(t`Enter an authenticator code or a recovery code.`));
        return;
      }

      const credential = await createPasskey(challenge.options);

      at = "finish";

      // Again: the prompt can stay open for a long time
      session.ensureFree();

      const reply = await session.finish(() =>
        client.passkeyRecoverFinish(
          token,
          challenge.challenge_id,
          credential as Record<string, unknown>,
          factor,
        ),
      );

      await session.adopt(reply);

      // The login page takes it from here
      navigate("/login/auth", { replace: true });
    } catch (failure) {
      // Not logged: the thrown value is shown, never the options, the
      // credential or the code
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

      const problem = passkeyRecoverProblem(
        apiErrorType(failure),
        at,
        factor !== undefined,
      );

      if (problem === "bad_link") {
        setPhase("bad_link");
        return;
      }

      setError(problem ? new Error(problemText(problem)) : failure);

      // The challenge is spent and the link is not: ask about the link
      // again, so the next try starts clean and a dead link shows now
      if (recoverStartsAgain(problem)) {
        setCodeValue("");
        await check();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Switch>
      {/* Opened without a token: a reload, after the token left the address */}
      <Match when={!token}>
        <FlowTitle>
          <Trans>Open the link from the email again</Trans>
        </FlowTitle>
        <a href="/login/auth">
          <Button variant="text">
            <Trans>Go back to login</Trans>
          </Button>
        </a>
      </Match>
      {/* A session is in use here: no ceremony, and nothing is asked about
          the link. Signing out stays on this page, with the link in memory. */}
      <Match when={isLoggedIn()}>
        <FlowTitle>
          <Trans>Create a new passkey</Trans>
        </FlowTitle>
        <Text class="body" size="small">
          <Trans>
            You are signed in on this device. Sign out first, then open the link
            again.
          </Trans>
        </Text>
        <Button onPress={() => logout()}>
          <Trans>Sign out</Trans>
        </Button>
      </Match>
      {/* Nothing is painted until the server is known to offer recovery */}
      <Match when={phase() === "loading"}>
        <CircularProgress />
      </Match>
      <Match when={phase() === "checking"}>
        <FlowTitle>
          <Trans>Checking your link…</Trans>
        </FlowTitle>
        <CircularProgress />
      </Match>
      {/* Not offered: this page shows nothing of its own */}
      <Match when={phase() === "off"}>
        <Navigate href="/login/auth" />
      </Match>
      <Match when={phase() === "bad_link"}>
        <FlowTitle>
          <Trans>This link does not work</Trans>
        </FlowTitle>
        <Text class="body" size="small">
          <Trans>
            This link has expired or was already used. You can ask for a new
            one.
          </Trans>
        </Text>
        <a href="/login/passkey/lost">
          <Button>
            <Trans>Ask for a new link</Trans>
          </Button>
        </a>
        <a href="/login/auth">
          <Button variant="text">
            <Trans>Go back to login</Trans>
          </Button>
        </a>
      </Match>
      <Match when={phase() === "failed"}>
        <FlowTitle>
          <Trans>Could not check your link</Trans>
        </FlowTitle>
        <Text class="body" size="small">
          <Trans>Could not check the link. Try again.</Trans>
        </Text>
        <Show when={error()}>
          <FormError error={error()} />
        </Show>
        <Button onPress={() => void lookUp()}>
          <Trans>Try again</Trans>
        </Button>
        <a href="/login/auth">
          <Button variant="text">
            <Trans>Go back to login</Trans>
          </Button>
        </a>
      </Match>
      <Match when={phase() === "ready"}>
        <FlowTitle>
          <Trans>Create a new passkey</Trans>
        </FlowTitle>
        <Text class="body" size="small">
          <Trans>
            This removes every other passkey from your account and signs you out
            on every device. You then sign in with the new passkey.
          </Trans>
        </Text>
        <Show when={needsCode()}>
          <Text class="body" size="small">
            <Trans>
              Your account asks for a second step. Enter a code from your
              authenticator app, or one of your recovery codes.
            </Trans>
          </Text>
          <label>
            <TextField
              name="second_factor"
              type="text"
              autocomplete="one-time-code"
              label={t`Authenticator or recovery code`}
              value={codeValue()}
              disabled={busy()}
              onInput={(event) => setCodeValue(event.currentTarget.value)}
            />
          </label>
        </Show>
        <Button isDisabled={busy()} onPress={() => void replace()}>
          <Trans>Create new passkey</Trans>
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
        <a href="/login/auth">
          <Button variant="text">
            <Trans>Go back to login</Trans>
          </Button>
        </a>
      </Match>
    </Switch>
  );
}
