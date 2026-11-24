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

import {
  accountInfoKey,
  accountProblem,
} from "@revolt/app/interface/settings/user/account/accountRules";
import { apiErrorType } from "@revolt/client/apiErrorType";
import { CONFIGURATION } from "@revolt/common";
import { getPasskeysAdvert } from "@revolt/common/lib/passkey";
import { Column, Dialog, DialogProps, Form2, Text } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * Change account password
 *
 * An account with no email cannot have a password: there would be nothing
 * to sign in with. The server refuses it, so such an account is told to
 * add an email first and no request is sent from here.
 */
export function EditPasswordModal(
  props: DialogProps & Modals & { type: "edit_password" },
) {
  const { t } = useLingui();
  const { showError, mfaFlow } = useModals();
  const queryClient = useQueryClient();

  const group = createFormGroup({
    password: createFormControl("", { required: true }),
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

  // Whether the account has no email: known from what the settings page
  // fetched, from the lookup below, or from the server refusing the request
  const cachedInfo = queryClient.getQueryData<{ email_absent?: boolean }>(
    // eslint-disable-next-line solid/reactivity
    accountInfoKey(props.client.user!.id),
  );
  const [emailAbsent, setEmailAbsent] = createSignal(
    cachedInfo?.email_absent === true,
  );

  onMount(() => {
    props.client.account
      .mfa()
      .then(setMfa)
      .catch(() => {});

    props.client.account
      .fetchInfo()
      .then((info) => setEmailAbsent(info.email_absent))
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
    if (busy() || emailAbsent()) return;

    try {
      if (passwordAbsent()) {
        setBusy(true);

        const ticket = await mfaFlow(mfa()!);
        if (!ticket) return;

        await props.client.account.changePassword(
          group.controls.password.value,
          undefined,
          ticket.token,
        );

        // The account has a password now: settings must stop saying it
        // has none
        void queryClient.invalidateQueries({
          queryKey: ["mfa", props.client.user!.id],
        });
      } else {
        await props.client.account.changePassword(
          group.controls.password.value,
          group.controls.currentPassword.value,
        );
      }

      props.onClose();
    } catch (err) {
      // The only refusal with a meaning of its own here: no email
      if (accountProblem(apiErrorType(err), "change_password")) {
        setEmailAbsent(true);
      } else {
        showError(err);
      }
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
    if (!passwordAbsent() && !emailAbsent()) return formSubmit(event);

    event.preventDefault();
    if (
      Form2.canSubmit(group) &&
      !cannotConfirm() &&
      !emailAbsent() &&
      !busy()
    ) {
      void onSubmit();
    }
  }

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={
        <Show
          when={passwordAbsent()}
          fallback={<Trans>Change login password</Trans>}
        >
          <Trans>Set a login password</Trans>
        </Show>
      }
      actions={[
        { text: <Trans>Close</Trans> },
        {
          text: (
            <Show when={passwordAbsent()} fallback={<Trans>Change</Trans>}>
              <Trans>Set password</Trans>
            </Show>
          ),
          onClick: () => {
            onSubmit();
            return false;
          },
          isDisabled:
            !Form2.canSubmit(group) ||
            cannotConfirm() ||
            emailAbsent() ||
            busy(),
        },
      ]}
      isDisabled={group.isPending}
    >
      <form onSubmit={submit}>
        <Column>
          <Show when={emailAbsent()}>
            <Text>
              <Trans>
                This account has no email. Add an email first, then set a
                password.
              </Trans>
            </Text>
          </Show>
          <Show when={passwordAbsent() && !cannotConfirm() && !emailAbsent()}>
            <Text>
              <Trans>
                This account has no password yet. Set one to sign in with your
                email and password.
              </Trans>
            </Text>
          </Show>
          <Show when={!emailAbsent()}>
            <Form2.TextField
              name="password"
              control={group.controls.password}
              label={t`New Password`}
              type="password"
              placeholder={t`Enter a new password.`}
            />
          </Show>
          <Show when={!passwordAbsent() && !emailAbsent()}>
            <Form2.TextField
              name="currentPassword"
              control={group.controls.currentPassword}
              label={t`Current Password`}
              type="password"
              placeholder={t`Enter your current password...`}
            />
          </Show>
          <Show when={cannotConfirm() && !emailAbsent()}>
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
