import { createFormControl, createFormGroup } from "solid-forms";
import {
  Match,
  Show,
  Switch,
  createEffect,
  createSignal,
  onMount,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { useQueryClient } from "@tanstack/solid-query";
import type { MFA } from "stoat.js";

import { CONFIGURATION } from "@revolt/common";
import { getPasskeysAdvert } from "@revolt/common/lib/passkey";
import { Column, Dialog, DialogProps, Form2, Row, Text } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * Change account username
 */
export function EditUsernameModal(
  props: DialogProps & Modals & { type: "edit_username" },
) {
  const { t } = useLingui();
  const { showError, mfaFlow } = useModals();
  const queryClient = useQueryClient();

  const group = createFormGroup({
    // we don't expect it to change nor want it to
    // eslint-disable-next-line solid/reactivity
    username: createFormControl(props.client.user!.username, {
      required: true,
    }),
    currentPassword: createFormControl("", { required: true }),
  });

  // Whether the account has a password. Starts from what the settings page
  // already fetched, so the password field does not show and then vanish.
  // Until it is known, and if the lookup fails, the dialog asks for the
  // current password as it always did.
  const [mfa, setMfa] = createSignal<MFA | undefined>(
    // eslint-disable-next-line solid/reactivity
    queryClient.getQueryData<MFA>(["mfa", props.client.user!.id]),
  );

  // Whether the server offers passkeys; undefined until it has answered
  const [passkeysOffered, setPasskeysOffered] = createSignal<boolean>();

  // The no-password path is running: one confirmation, one request
  const [busy, setBusy] = createSignal(false);

  onMount(() => {
    props.client.account
      .mfa()
      .then(setMfa)
      .catch(() => {});

    // Never rejects; a failed lookup reads as not offered
    void getPasskeysAdvert(CONFIGURATION.DEFAULT_API_URL).then((advert) =>
      setPasskeysOffered(advert.available),
    );
  });

  /** No password on the account: a ticket takes its place */
  const passwordAbsent = () => mfa()?.passwordAbsent === true;

  /** No password and nothing else to confirm with */
  const cannotConfirm = () =>
    passwordAbsent() && mfa()!.availableMethods.length === 0;

  createEffect(() => {
    group.controls.currentPassword.markRequired(!passwordAbsent());
  });

  async function onSubmit() {
    // A second click must not open a second confirmation or send twice
    if (busy()) return;

    try {
      const previousDiscriminator = props.client.user!.discriminator;
      if (passwordAbsent()) {
        setBusy(true);

        const ticket = await mfaFlow(mfa()!);
        if (!ticket) return;

        await props.client.user!.changeUsername(
          group.controls.username.value,
          undefined,
          ticket.token,
        );
      } else {
        await props.client.user!.changeUsername(
          group.controls.username.value,
          group.controls.currentPassword.value,
        );
      }

      props.onClose();

      if (props.client.user!.discriminator !== previousDiscriminator) {
        // open modal alerting user that discirminator changed
        // or just open a modal anyways with new uname?
        alert(
          // temporary solution
          `Your discriminator changed to ${props.client.user!.discriminator}`,
        );
      }
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  const formSubmit = Form2.useSubmitHandler(group, onSubmit);

  /**
   * The form helper clears the fields after every attempt. Without a
   * password, backing out of the confirmation is an attempt too, so submit
   * directly and keep what was typed.
   */
  function submit(event: Event) {
    if (!passwordAbsent()) return formSubmit(event);

    event.preventDefault();
    if (Form2.canSubmit(group) && !cannotConfirm() && !busy()) {
      void onSubmit();
    }
  }

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Change username</Trans>}
      actions={[
        { text: <Trans>Close</Trans> },
        {
          text: <Trans>Change</Trans>,
          onClick: () => {
            onSubmit();
            return false;
          },
          isDisabled: !Form2.canSubmit(group) || cannotConfirm() || busy(),
        },
      ]}
      isDisabled={group.isPending}
    >
      <form onSubmit={submit}>
        <Column>
          <Row align>
            <Form2.TextField
              minlength={1}
              maxlength={32}
              counter
              name="username"
              control={group.controls.username}
              label={t`Username`}
            />
            <Text class="label">#{props.client.user!.discriminator}</Text>
          </Row>
          <Show when={!passwordAbsent()}>
            <Form2.TextField
              name="currentPassword"
              control={group.controls.currentPassword}
              label={t`Current Password`}
              type="password"
              placeholder={t`Enter your current password...`}
            />
          </Show>
          <Show when={cannotConfirm()}>
            <Text>
              {/* Nothing until the server has said whether it offers
                  passkeys: with them off, never point at one */}
              <Switch>
                <Match when={passkeysOffered()}>
                  <Trans>
                    This account has no password yet. Add a passkey in Settings
                    first, then come back here.
                  </Trans>
                </Match>
                <Match when={passkeysOffered() === false}>
                  <Trans>
                    This account has no password yet. Use Reset password on the
                    login screen to set one.
                  </Trans>
                </Match>
              </Switch>
            </Text>
          </Show>
        </Column>
      </form>
    </Dialog>
  );
}
