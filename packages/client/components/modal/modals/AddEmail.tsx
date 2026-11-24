import { createFormControl, createFormGroup } from "solid-forms";
import {
  Match,
  Show,
  Switch,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { useQueryClient } from "@tanstack/solid-query";

import {
  type AccountAction,
  type AccountProblem,
  EMAIL_CODE_LENGTH,
  accountInfoKey,
  accountProblem,
  cleanEmailCode,
  emailCodeReady,
  emailShapeOk,
  resendWaitSeconds,
} from "@revolt/app/interface/settings/user/account/accountRules";
import { apiErrorType } from "@revolt/client/apiErrorType";
import { Column, Dialog, DialogProps, Form2, Text } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * When each account last asked for a code (ms), kept while the app runs:
 * closing the dialog must not let a second request out inside the server's
 * minute, which would be answered as sent and mail nothing.
 */
const lastCodeRequest = new Map<string, number>();

/**
 * Give an account that has no email its first address: confirm it is you,
 * get a code by email, type the code in. Opened only where the server
 * offers it (Settings checks the advert).
 */
export function AddEmailModal(
  props: DialogProps & Modals & { type: "add_email" },
) {
  const { t } = useLingui();
  const { showError, mfaFlow } = useModals();
  const queryClient = useQueryClient();

  const group = createFormGroup({
    email: createFormControl(""),
    code: createFormControl(""),
  });

  // eslint-disable-next-line solid/reactivity
  const userId = props.client.user!.id;

  const [step, setStep] = createSignal<"email" | "code">("email");

  // One confirmation and one request at a time
  const [busy, setBusy] = createSignal(false);
  const [problem, setProblem] = createSignal<AccountProblem>();

  const [sentAt, setSentAt] = createSignal(lastCodeRequest.get(userId));
  const [now, setNow] = createSignal(Date.now());

  const clock = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(clock));

  /** Seconds until the server would mail another code */
  const wait = createMemo(() => resendWaitSeconds(sentAt(), now()));

  // Changes once when the wait ends, not every second
  const waiting = createMemo(() => wait() > 0);

  const email = () => group.controls.email.value.trim();

  // Memos: the button list below is made anew only when one of them flips,
  // not on every keystroke
  const canSend = createMemo(
    () => !busy() && !waiting() && emailShapeOk(email()),
  );

  const canConfirm = createMemo(
    () => !busy() && emailCodeReady(group.controls.code.value),
  );

  /**
   * Explain a refused request in the dialog, or hand anything unexpected
   * to the general error dialog
   */
  function explain(error: unknown, action: AccountAction) {
    const refusal = accountProblem(apiErrorType(error), action);
    if (!refusal) {
      showError(error);
      return;
    }

    setProblem(refusal);

    // The page behind this dialog is out of date
    if (refusal === "has_email") {
      void queryClient.invalidateQueries({ queryKey: accountInfoKey(userId) });
    }
  }

  /**
   * Ask for a code. Each request needs a confirmation of its own: the
   * server spends the ticket whatever it answers.
   */
  async function send() {
    if (!canSend()) return;

    setBusy(true);
    setProblem(undefined);

    try {
      const ticket = await mfaFlow(await props.client.account.mfa());
      if (!ticket) return;

      await props.client.account.addEmailStart(email(), ticket.token);

      const at = Date.now();
      lastCodeRequest.set(userId, at);
      setSentAt(at);
      setNow(at);

      group.controls.code.setValue("");
      setStep("code");
    } catch (error) {
      explain(error, "add_email_start");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Send the typed code. Success makes the address the account's email.
   */
  async function confirm() {
    if (!canConfirm()) return;

    setBusy(true);
    setProblem(undefined);

    try {
      await props.client.account.addEmailFinish(
        cleanEmailCode(group.controls.code.value),
      );

      lastCodeRequest.delete(userId);
      await queryClient.invalidateQueries({ queryKey: accountInfoKey(userId) });
      props.onClose();
    } catch (error) {
      explain(error, "add_email_finish");
    } finally {
      setBusy(false);
    }
  }

  // Not `Form2.useSubmitHandler`: it resets the fields after every attempt,
  // which would wipe an address or a code that only needs a correction
  function submit(event: Event) {
    event.preventDefault();
    void (step() === "email" ? send() : confirm());
  }

  /** Words of the button that asks for a code, with the wait if any */
  function sendLabel(again: boolean) {
    const seconds = wait();
    if (seconds > 0) return t`Send again in ${seconds} s`;
    return again ? t`Send again` : t`Send code`;
  }

  // A memo, and the countdown is read inside the label only: the dialog
  // makes its buttons anew whenever this list changes, which must not
  // happen every second under a finger
  const actions = createMemo(() => {
    if (step() === "email") {
      return [
        { text: <Trans>Close</Trans> },
        {
          text: <>{sendLabel(false)}</>,
          onClick: () => {
            void send();
            return false;
          },
          isDisabled: !canSend(),
        },
      ];
    }

    return [
      {
        // The scrim does not close this step (a stray click would throw a
        // typed code away), so it has a button that does
        text: <Trans>Close</Trans>,
        onClick: () => {
          props.onClose();
          return false;
        },
        isDisabled: busy(),
      },
      {
        text: <Trans>Back</Trans>,
        onClick: () => {
          setProblem(undefined);
          setStep("email");
          return false;
        },
        isDisabled: busy(),
      },
      {
        text: <>{sendLabel(true)}</>,
        onClick: () => {
          void send();
          return false;
        },
        isDisabled: !canSend(),
      },
      {
        text: <Trans>Confirm</Trans>,
        onClick: () => {
          void confirm();
          return false;
        },
        isDisabled: !canConfirm(),
      },
    ];
  });

  return (
    <Dialog
      show={props.show}
      onClose={() => {
        // A typed code is not thrown away by a stray click
        if (!busy() && step() === "email") props.onClose();
      }}
      title={<Trans>Add an email</Trans>}
      actions={actions()}
      isDisabled={busy()}
    >
      <form onSubmit={submit}>
        <Column>
          <Switch>
            <Match when={step() === "email"}>
              <Text>
                <Trans>
                  You confirm it is you, then we email a code to this address.
                </Trans>
              </Text>
              <Form2.TextField
                name="email"
                type="email"
                label={t`Email`}
                control={group.controls.email}
                placeholder={t`someone@example.com`}
              />
            </Match>
            <Match when={step() === "code"}>
              <Text>
                <Trans>
                  If that address can be used, we sent an 8-digit code to it.
                  Enter the code here. It works for 15 minutes.
                </Trans>
              </Text>
              <Form2.TextField
                name="code"
                type="text"
                inputmode="numeric"
                autocomplete="one-time-code"
                // Room for the spaces or dash some people type
                maxlength={EMAIL_CODE_LENGTH + 3}
                label={t`Code`}
                control={group.controls.code}
              />
            </Match>
          </Switch>
          <Show when={problem()}>
            <Text>
              <Switch>
                <Match when={problem() === "off"}>
                  <Trans>Adding an email is turned off right now.</Trans>
                </Match>
                <Match when={problem() === "has_email"}>
                  <Trans>This account already has an email.</Trans>
                </Match>
                <Match when={problem() === "bad_email"}>
                  <Trans>That email address cannot be used.</Trans>
                </Match>
                <Match when={problem() === "mail_failed"}>
                  <Trans>The email could not be sent. Try again later.</Trans>
                </Match>
                <Match when={problem() === "bad_code"}>
                  <Trans>
                    That code is wrong or has expired. Check it, or send a new
                    one.
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
    </Dialog>
  );
}
