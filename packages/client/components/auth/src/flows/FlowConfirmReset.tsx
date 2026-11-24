import { Show, createSignal, onMount } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";

import { useApi } from "@revolt/client";
import { CONFIGURATION } from "@revolt/common";
import { getPasskeysAdvert } from "@revolt/common/lib/passkey";
import { useNavigate, useParams } from "@revolt/routing";
import { Button, Text } from "@revolt/ui";

import { FlowTitle } from "./Flow";
import { Fields, Form } from "./Form";

/**
 * Flow for confirming a new password
 */
export default function FlowConfirmReset() {
  const api = useApi();
  const { token } = useParams();
  const navigate = useNavigate();

  // Whether the server has passkeys on; false until it has answered, so the
  // line below never shows and then goes away
  const [passkeysOn, setPasskeysOn] = createSignal(false);

  onMount(() => {
    // Never rejects; a failed lookup reads as off
    void getPasskeysAdvert(CONFIGURATION.DEFAULT_API_URL).then((advert) =>
      setPasskeysOn(advert.available === true),
    );
  });

  /**
   * Confirm new password
   * @param data Form Data
   */
  async function reset(data: FormData) {
    const password = data.get("new-password") as string;
    const remove_sessions = !!(data.get("log-out") as "on" | undefined);

    await api.patch("/auth/account/reset_password", {
      password,
      token,
      remove_sessions,
    });

    navigate("/login/auth", { replace: true });
  }

  return (
    <>
      <FlowTitle>
        <Trans>Reset password</Trans>
      </FlowTitle>
      {/* Only where the server has passkeys on: a reset there always removes
          the account's passkeys, and an account with none loses nothing */}
      <Show when={passkeysOn()}>
        <Text class="body" size="small">
          <Trans>
            Resetting your password removes the passkeys on your account.
          </Trans>
        </Text>
      </Show>
      <Form onSubmit={reset}>
        <Fields fields={["new-password", "log-out"]} />
        <Button type="submit">
          <Trans>Reset</Trans>
        </Button>
      </Form>
      <a href="/login/auth">
        <Button variant="text">
          <Trans>Go back to login</Trans>
        </Button>
      </a>
    </>
  );
}
