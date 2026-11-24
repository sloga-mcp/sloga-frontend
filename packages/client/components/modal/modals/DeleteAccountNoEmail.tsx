import { createFormControl, createFormGroup } from "solid-forms";
import { Match, Show, Switch, createEffect, createSignal, on } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { useQueryClient } from "@tanstack/solid-query";

import {
  type AccountProblem,
  accountInfoKey,
  accountProblem,
  confirmedUsername,
} from "@revolt/app/interface/settings/user/account/accountRules";
import { useClientLifecycle } from "@revolt/client";
import { apiErrorType } from "@revolt/client/apiErrorType";
import { Column, Dialog, DialogProps, Form2, Text } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * Delete an account that has no email (Settings → Account Info → Delete
 * Account). There is no mailbox to send a confirm link to, so the person
 * types their username and confirms with a ticket, and the server's 204 is
 * final: the account is gone and signed out everywhere at once. Accounts
 * with an email never see this; they keep the emailed link.
 *
 * The server decides which of the two it is from the account as it is when
 * the request arrives, and answers 204 to both. So the dialog asks again,
 * right before the request, whether the account still has no email (one can
 * be added on another device while this is open). If it has one now, nothing
 * is sent and the dialog says to start again: it never calls an emailed link
 * a deletion.
 *
 * Once deleted, the dialog says so, and this device signs out when it
 * closes. As in DeleteAccountRequested.tsx the sign-out hangs off `show`
 * turning false, because Escape removes the modal without calling
 * `onClose`; and it is `closeAll()` first, then `logout()`, so Settings
 * does not stay open over the sign-in screen.
 */
export function DeleteAccountNoEmailModal(
  props: DialogProps & Modals & { type: "delete_account_no_email" },
) {
  const { t } = useLingui();
  const { showError, mfaFlow, closeAll } = useModals();
  const { logout } = useClientLifecycle();
  const queryClient = useQueryClient();

  const group = createFormGroup({
    username: createFormControl(""),
  });

  // One confirmation and one request at a time
  const [busy, setBusy] = createSignal(false);
  const [deleted, setDeleted] = createSignal(false);
  const [problem, setProblem] = createSignal<AccountProblem>();

  // The account got an email while this was open: the other deletion applies
  const [hasEmailNow, setHasEmailNow] = createSignal(false);

  // One sign-out per dialog: closeAll() below removes this modal again
  let signedOut = false;

  createEffect(
    on(
      () => props.show,
      (show) => {
        if (show || signedOut || !deleted()) return;
        signedOut = true;
        closeAll();
        logout();
      },
      { defer: true },
    ),
  );

  /** The username to send, once what was typed matches it */
  const username = () =>
    confirmedUsername(
      group.controls.username.value,
      props.client.user?.username,
    );

  /**
   * Confirm it is the owner, then delete. Each try gets a ticket of its
   * own: the server spends it whatever it answers.
   */
  async function confirm() {
    const typed = username();
    if (busy() || deleted() || hasEmailNow() || !typed) return;

    setBusy(true);
    setProblem(undefined);

    try {
      const ticket = await mfaFlow(await props.client.account.mfa());
      if (!ticket) return;

      // Asked again here, after the confirmation, which can take a while.
      // A failed lookup throws and nothing is sent: without the answer a
      // 204 could not be read.
      const info = await props.client.account.fetchInfo();
      if (info.email_absent !== true) {
        setHasEmailNow(true);

        // The page behind this dialog is out of date
        void queryClient.invalidateQueries({
          queryKey: accountInfoKey(props.client.user!.id),
        });
        return;
      }

      await ticket.deleteAccount(typed);

      // Final. Nothing is left to confirm or undo.
      setDeleted(true);
    } catch (error) {
      const refusal = accountProblem(
        apiErrorType(error),
        "delete",
        true,
        // As the delete button in Settings counts them
        props.client.servers.filter((server) => server.owner?.self || false)
          .length > 0,
      );
      if (refusal) {
        setProblem(refusal);
      } else {
        showError(error);
      }
    } finally {
      setBusy(false);
    }
  }

  function submit(event: Event) {
    event.preventDefault();
    void confirm();
  }

  return (
    <Dialog
      show={props.show}
      onClose={() => {
        if (!busy()) props.onClose();
      }}
      title={
        <Switch fallback={<Trans>Delete your account?</Trans>}>
          <Match when={deleted()}>
            <Trans>Your account is deleted</Trans>
          </Match>
          <Match when={hasEmailNow()}>
            <Trans>Nothing was deleted</Trans>
          </Match>
        </Switch>
      }
      actions={
        deleted() || hasEmailNow()
          ? [{ text: <Trans>OK</Trans> }]
          : [
              { text: <Trans>Cancel</Trans> },
              {
                text: <Trans>Delete Account</Trans>,
                destructive: true,
                onClick: () => {
                  void confirm();
                  return false;
                },
                isDisabled: !username(),
              },
            ]
      }
      isDisabled={busy()}
    >
      <Switch>
        <Match when={deleted()}>
          <Column>
            <Text>
              <Trans>
                Your account and everything tied to it are being removed. You
                are signed out when you close this.
              </Trans>
            </Text>
          </Column>
        </Match>
        <Match when={hasEmailNow()}>
          <Column>
            <Text>
              <Trans>
                Your account has an email now, so deleting it is confirmed from
                a link we email you. Close this and select Delete Account again.
              </Trans>
            </Text>
          </Column>
        </Match>
        <Match when={true}>
          <form onSubmit={submit}>
            <Column>
              <Text>
                <Trans>
                  Your account has no email, so there is no link to confirm.
                  Your account and everything tied to it are deleted as soon as
                  you confirm. This can't be undone.
                </Trans>
              </Text>
              <Form2.TextField
                name="username"
                type="text"
                autocomplete="off"
                autocapitalize="none"
                spellcheck={false}
                label={t`Type your username to confirm`}
                control={group.controls.username}
              />
              <Show when={problem()}>
                <Text>
                  <Switch>
                    <Match when={problem() === "wrong_username"}>
                      <Trans>
                        That is not your username. Type it exactly, capitals
                        included.
                      </Trans>
                    </Match>
                    <Match when={problem() === "owns_servers"}>
                      <Trans>
                        Transfer or delete the servers you own first, then come
                        back here.
                      </Trans>
                    </Match>
                    <Match when={problem() === "not_deleted"}>
                      <Trans>
                        Nothing was deleted. Try again. If you own a server,
                        transfer or delete it first.
                      </Trans>
                    </Match>
                    <Match when={problem() === "confirm_again"}>
                      <Trans>That was not confirmed in time. Try again.</Trans>
                    </Match>
                  </Switch>
                </Text>
              </Show>
            </Column>
          </form>
        </Match>
      </Switch>
    </Dialog>
  );
}
