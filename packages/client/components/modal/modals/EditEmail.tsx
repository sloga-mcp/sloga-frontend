import { createFormControl, createFormGroup } from "solid-forms";
import { Match, Show, Switch, createSignal, onMount } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { useQueryClient } from "@tanstack/solid-query";
import type { MFA } from "stoat.js";

import {
  type AccountProblem,
  accountInfoKey,
  accountProblem,
} from "@revolt/app/interface/settings/user/account/accountRules";
import { apiErrorType } from "@revolt/client/apiErrorType";
import { Column, Dialog, DialogProps, Form2, Text } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * Change account email address
 *
 * The server only moves an email for an account that has a password and
 * gives it: a ticket does not stand in for one. An account with no
 * password is told to add one first, and an account with no email at all
 * has none to change (Settings offers "Add an email" instead); neither
 * sends a request from here.
 */
export function EditEmailModal(
  props: DialogProps & Modals & { type: "edit_email" },
) {
  const { t } = useLingui();
  const { showError } = useModals();
  const queryClient = useQueryClient();

  const group = createFormGroup({
    email: createFormControl("", { required: true }),
    currentPassword: createFormControl("", { required: true }),
  });

  // eslint-disable-next-line solid/reactivity
  const userId = props.client.user!.id;

  // Whether the account has a password. Starts from what the settings page
  // already fetched, so the password field does not show and then vanish.
  // Until it is known, and if the lookup fails, the dialog asks for the
  // current password as it always did.
  const [mfa, setMfa] = createSignal<MFA | undefined>(
    queryClient.getQueryData<MFA>(["mfa", userId]),
  );

  // Whether the account has no email at all, likewise from what the
  // settings page fetched
  const cachedInfo = queryClient.getQueryData<{ email_absent?: boolean }>(
    accountInfoKey(userId),
  );
  const [emailAbsent, setEmailAbsent] = createSignal(
    cachedInfo?.email_absent === true,
  );

  // What the server said when it refused the request
  const [refused, setRefused] = createSignal<AccountProblem>();

  onMount(() => {
    props.client.account
      .mfa()
      .then(setMfa)
      .catch(() => {});

    props.client.account
      .fetchInfo()
      .then((info) => setEmailAbsent(info.email_absent))
      .catch(() => {});
  });

  /** Why this account cannot change its email here, if it cannot */
  const blocked = (): AccountProblem | undefined => {
    if (refused()) return refused();
    if (emailAbsent()) return "need_email";
    if (mfa()?.passwordAbsent === true) return "need_password";
    return undefined;
  };

  async function onSubmit() {
    if (blocked()) return;

    try {
      await props.client.account.changeEmail(
        group.controls.email.value,
        group.controls.currentPassword.value,
      );

      props.onClose();
    } catch (err) {
      const problem = accountProblem(
        apiErrorType(err),
        "change_email",
        emailAbsent(),
      );

      if (problem) {
        setRefused(problem);
      } else {
        showError(err);
      }
    }
  }

  const formSubmit = Form2.useSubmitHandler(group, onSubmit);

  function submit(event: Event) {
    if (!blocked()) return formSubmit(event);
    event.preventDefault();
  }

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Change login email</Trans>}
      actions={[
        { text: <Trans>Close</Trans> },
        {
          text: <Trans>Send email</Trans>,
          onClick: () => {
            onSubmit();
            return false;
          },
          isDisabled: !Form2.canSubmit(group) || !!blocked(),
        },
      ]}
      isDisabled={group.isPending}
    >
      <form onSubmit={submit}>
        <Column>
          <Show when={!blocked()}>
            <Form2.TextField
              name="email"
              type="email"
              label={t`Email`}
              control={group.controls.email}
              placeholder={t`someone@example.com`}
            />
            <Form2.TextField
              name="currentPassword"
              control={group.controls.currentPassword}
              label={t`Current Password`}
              type="password"
              placeholder={t`Enter your current password...`}
            />
          </Show>
          <Show when={blocked()}>
            <Text>
              <Switch>
                <Match when={blocked() === "need_password"}>
                  <Trans>Add a password first to change your email.</Trans>
                </Match>
                <Match when={blocked() === "need_email"}>
                  <Trans>This account has no email to change.</Trans>
                </Match>
              </Switch>
            </Text>
          </Show>
        </Column>
      </form>
    </Dialog>
  );
}
