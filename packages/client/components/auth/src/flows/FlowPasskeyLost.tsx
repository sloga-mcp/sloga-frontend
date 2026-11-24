import { Match, Switch, createResource, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import { useClient, useClientLifecycle } from "@revolt/client";
import { apiErrorType } from "@revolt/client/apiErrorType";
import { CONFIGURATION } from "@revolt/common";
import { getPasskeysAdvert } from "@revolt/common/lib/passkey";
import { Navigate } from "@revolt/routing";
import { useState } from "@revolt/state";
import { Button, CircularProgress, Text } from "@revolt/ui";

import { FlowTitle } from "./Flow";
import { Fields, Form } from "./Form";
import { passkeyRecoverProblem, passkeyRecoveryOffered } from "./passkeySignup";

/**
 * Flow for asking for a link that replaces a lost passkey. Shows nothing
 * unless the server offers passkey recovery.
 */
export default function FlowPasskeyLost() {
  const { t } = useLingui();
  const state = useState();
  const getClient = useClient();
  const { isLoggedIn } = useClientLifecycle();

  // Never rejects: a failed lookup reads as everything off
  const [advert] = createResource(() =>
    getPasskeysAdvert(CONFIGURATION.DEFAULT_API_URL),
  );

  const [sent, setSent] = createSignal(false);

  /**
   * Ask for the link. The server answers the same whether or not the
   * address has an account, and so does this page.
   * @param data Form Data
   */
  async function send(data: FormData) {
    const email = ((data.get("email") as string | null) ?? "").trim();
    if (!email) return;

    try {
      await getClient().passkeyRecoverSend(email);
    } catch (failure) {
      const problem = passkeyRecoverProblem(
        apiErrorType(failure),
        "send",
        false,
      );

      throw problem === "off"
        ? new Error(t`Passkeys are turned off right now.`)
        : failure;
    }

    setSent(true);
  }

  return (
    <Switch>
      {/* Already signed in: sent on as the login page sends a signed-in
          visitor on */}
      <Match when={isLoggedIn()}>
        <Navigate href={state.layout.popNextPath() ?? "/app"} />
      </Match>
      <Match when={advert() === undefined}>
        <CircularProgress />
      </Match>
      {/* Not offered: this page shows nothing of its own */}
      <Match when={!passkeyRecoveryOffered(advert())}>
        <Navigate href="/login/auth" />
      </Match>
      <Match when={sent()}>
        <FlowTitle emoji="mail">
          <Trans>Check your email</Trans>
        </FlowTitle>
        <Text class="body" size="small">
          <Trans>
            If an account with a passkey uses this email, we sent it a link. The
            link works for 30 minutes.
          </Trans>
        </Text>
        <a href="/login/auth">
          <Button variant="text">
            <Trans>Go back to login</Trans>
          </Button>
        </a>
      </Match>
      <Match when={true}>
        <FlowTitle>
          <Trans>Lost your passkey?</Trans>
        </FlowTitle>
        <Text class="body" size="small">
          <Trans>
            Enter the email of your account. We send a link that lets you create
            a new passkey. This works only for accounts that have an email.
          </Trans>
        </Text>
        <Form onSubmit={send}>
          <Fields fields={["email"]} />
          <Button type="submit">
            <Trans>Send link</Trans>
          </Button>
        </Form>
        <a href="/login/auth">
          <Button variant="text">
            <Trans>Go back to login</Trans>
          </Button>
        </a>
      </Match>
    </Switch>
  );
}
