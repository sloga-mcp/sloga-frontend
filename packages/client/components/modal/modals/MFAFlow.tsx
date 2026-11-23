import { createFormControl, createFormGroup } from "solid-forms";
import {
  BiRegularArchive,
  BiRegularFingerprint,
  BiSolidKey,
  BiSolidKeyboard,
} from "solid-icons/bi";
import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import type { API, MFATicketMethod } from "stoat.js";

import {
  type PasskeyProblem,
  passkeyFirst,
  passkeyProblem,
} from "@revolt/app/interface/settings/user/account/passkeyRules";
import { useClient } from "@revolt/client";
import { apiErrorType } from "@revolt/client/apiErrorType";
import { CONFIGURATION } from "@revolt/common";
import {
  PasskeyError,
  cancelPasskeyCeremony,
  getPasskey,
  getPasskeysAdvert,
  passkeysSupported,
} from "@revolt/common/lib/passkey";
import {
  CategoryButton,
  CircularProgress,
  Column,
  Dialog,
  DialogProps,
  Form2,
  Text,
} from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * Modal to create an MFA ticket
 */
export function MFAFlowModal(
  props: DialogProps & Modals & { type: "mfa_flow" },
) {
  const { t } = useLingui();
  const { showError } = useModals();
  const client = useClient();

  // Keep track of available methods
  const [methods, setMethods] = createSignal<MFATicketMethod[] | undefined>(
    // eslint-disable-next-line solid/reactivity
    props.state === "unknown" ? props.available_methods : undefined,
  );

  // Current state of the modal
  const [selectedMethod, setSelected] = createSignal<MFATicketMethod>();

  // The account has a passkey, but this device or server cannot use it
  const [passkeyHidden, setPasskeyHidden] = createSignal(false);

  // Whether the server offers passkeys; undefined until it has answered
  const [passkeysOffered, setPasskeysOffered] = createSignal<boolean>();

  // A passkey attempt is running; only one may run at a time
  const [busy, setBusy] = createSignal(false);

  // Counts passkey attempts, so one that was given up on stops quietly
  let attempt = 0;

  // Why the last passkey attempt did not give a ticket. `cancelled` may also
  // mean the prompt never appeared.
  const [passkeyProblemShown, setPasskeyProblemShown] = createSignal<
    PasskeyProblem | "unavailable" | "failed" | "cancelled"
  >();

  const group = createFormGroup({
    password: createFormControl(""),
    totp_code: createFormControl(""),
    recovery_code: createFormControl(""),
  });

  // Resolve the awaiting `mfaFlow()` promise EXACTLY once. ESC / backdrop
  // dismissal goes through `ModalController.pop()`/`remove()`, which unmounts
  // this modal WITHOUT calling onSubmit/onCancel — so without settling on
  // cleanup the caller's `await mfaFlow(...)` would hang forever (this is what
  // left the §6.4 re-enroll modal stuck in a permanent busy/locked state). Any
  // un-chosen dismissal is therefore treated as a cancel.
  let settled = false;
  onCleanup(() => {
    abandonPasskey();

    if (!settled) {
      settled = true;
      props.callback();
    }
  });

  /**
   * Give up on the passkey attempt in flight, if there is one: its prompt is
   * closed where that is possible, and whatever it still returns is ignored
   */
  function abandonPasskey() {
    if (!busy()) return;

    attempt++;
    cancelPasskeyCeremony();
    setBusy(false);
  }

  // The modal is closing (scrim, ESC, or one of the buttons) and unmounts
  // a moment later. An un-chosen dismissal is settled now, not at unmount,
  // so a ticket that arrives in between is never handed to the caller.
  createEffect(() => {
    if (props.show) return;

    abandonPasskey();
    if (!settled) {
      settled = true;
      props.callback();
    }
  });

  // Fetch available methods if they have not been provided.
  onMount(() => {
    // Never rejects; a failed lookup reads as not offered
    void getPasskeysAdvert(CONFIGURATION.DEFAULT_API_URL).then((advert) =>
      setPasskeysOffered(advert.available),
    );

    if (!methods() && props.state === "known") {
      const list = props.mfa.availableMethods;
      if (!list.includes("Passkey")) {
        setMethods(list);
        return;
      }

      // Offer the passkey only where a prompt can run and the server takes it
      Promise.all([
        passkeysSupported(),
        getPasskeysAdvert(CONFIGURATION.DEFAULT_API_URL),
      ])
        .then(([supported, advert]) => supported && advert.available)
        .catch(() => false)
        .then((usable) => {
          if (usable) {
            setMethods(passkeyFirst(list));
          } else {
            setPasskeyHidden(true);
            setMethods(list.filter((entry) => entry !== "Passkey"));
          }
        });
    }
  });

  // Always select first available method if only one available.
  createEffect(() => {
    const list = methods();
    if (list) {
      setSelected(list.find((entry) => entry !== "Recovery"));
    }
  });

  /**
   * Confirm with a passkey: ask the server for a challenge, run the prompt,
   * and trade the result for a ticket
   */
  async function usePasskey() {
    if (busy() || props.state !== "known") return;

    setBusy(true);
    setPasskeyProblemShown(undefined);

    const mine = ++attempt;

    // Given up on (Back, Cancel) or dismissed: the caller was already told,
    // so no prompt is opened and no ticket is made
    const stale = () => settled || mine !== attempt;

    try {
      const challenge = await client().passkeys.assertStart();
      if (stale()) return;

      const credential = await getPasskey(challenge.options);
      if (stale()) return;

      const ticket = await props.mfa.createTicket({
        passkey_response: {
          challenge_id: challenge.challenge_id,
          credential: credential as Record<string, unknown>,
        },
      });
      if (stale()) return;

      settled = true;
      props.callback(ticket);
      props.onClose();
    } catch (error) {
      if (stale()) return;

      if (error instanceof PasskeyError) {
        // `cancelled` gets one quiet line: the prompt may never have appeared
        setPasskeyProblemShown(
          error.code === "cancelled" || error.code === "unavailable"
            ? error.code
            : "failed",
        );
        return;
      }

      const problem = passkeyProblem(apiErrorType(error), "confirm");
      if (problem) {
        setPasskeyProblemShown(problem);
      } else {
        showError(error);
      }
    } finally {
      // A newer attempt, or the one who gave up on this one, owns the flag
      if (mine === attempt) setBusy(false);
    }
  }

  /**
   * Callback to generate a new ticket or send response back up the chain
   */
  async function onSubmit() {
    try {
      const method = selectedMethod();
      if (!method) return;

      if (method === "Passkey") {
        await usePasskey();
        return;
      }

      let mfa_response: API.MFAResponse;

      switch (method) {
        case "Password":
          mfa_response = { password: group.controls.password.value };
          break;
        case "Totp":
          mfa_response = { totp_code: group.controls.totp_code.value };
          break;
        case "Recovery":
          mfa_response = { recovery_code: group.controls.recovery_code.value };
          break;
        default:
          return;
      }

      if (props.state === "known") {
        const ticket = await props.mfa.createTicket(mfa_response);
        settled = true;
        props.callback(ticket);
      } else {
        settled = true;
        props.callback(mfa_response);
      }

      props.onClose();
    } catch (error) {
      showError(error);
    }
  }

  function onCancel() {
    settled = true;
    props.callback();
    props.onClose();
  }

  function onBack() {
    if (methods()!.length === 1) {
      onCancel();
    } else {
      setSelected(undefined);
      setPasskeyProblemShown(undefined);

      // Clear form values
      group.controls.password.setValue("");
      group.controls.totp_code.setValue("");
      group.controls.recovery_code.setValue("");
    }
  }

  function canSubmit() {
    if (selectedMethod() === "Passkey") return !busy();

    return (
      Form2.canSubmit(group) &&
      (group.controls.password.value ||
        group.controls.totp_code.value ||
        group.controls.recovery_code.value)
    );
  }

  /**
   * Nothing here can confirm the action: the account has no password and no
   * passkey, or its passkey cannot be used on this device
   */
  const noMethods = () => methods()?.length === 0;

  const getActions = () => {
    if (selectedMethod()) {
      return [
        {
          text: (
            <Switch fallback={<Trans>Back</Trans>}>
              <Match when={methods()!.length === 1}>
                <Trans>Cancel</Trans>
              </Match>
            </Switch>
          ),
          // Never disabled: this is the way out of a passkey prompt that
          // does not answer
          onClick: () => {
            abandonPasskey();
            onBack();
            return false;
          },
        },
        {
          text:
            selectedMethod() === "Passkey" ? (
              <Trans>Use passkey</Trans>
            ) : (
              <Trans>Confirm</Trans>
            ),
          onClick: () => {
            onSubmit();
            return false;
          },
          isDisabled: !canSubmit(),
        },
      ];
    }

    return [
      {
        text: noMethods() ? <Trans>Close</Trans> : <Trans>Cancel</Trans>,
        onClick: () => {
          onCancel();
          return false;
        },
      },
    ];
  };

  const submit = Form2.useSubmitHandler(group, onSubmit);

  return (
    <Dialog
      show={props.show}
      onClose={() => {
        // A typed code is not thrown away by a stray click
        if (
          props.state === "unknown" ||
          (selectedMethod() && selectedMethod() !== "Passkey")
        ) {
          return;
        }

        // The passkey step has nothing typed and must close even while its
        // prompt is open: give up on the prompt and answer the caller
        // first, then close
        abandonPasskey();
        onCancel();
      }}
      title={<Trans>Confirm action</Trans>}
      actions={getActions()}
      isDisabled={group.isPending}
    >
      <form onSubmit={submit}>
        <Column>
          <Show when={!noMethods()}>
            <Text>
              <Switch
                fallback={
                  <Trans>
                    Please select a method to authenticate your request.
                  </Trans>
                }
              >
                <Match when={selectedMethod()}>
                  <Trans>
                    Please confirm this action using the selected method.
                  </Trans>
                </Match>
              </Switch>
            </Text>
          </Show>

          <Switch fallback={<CircularProgress />}>
            <Match when={selectedMethod()}>
              <Switch>
                <Match when={selectedMethod() === "Passkey"}>
                  <Text>
                    <Trans>Confirm with your passkey.</Trans>
                  </Text>
                  <Show when={passkeyProblemShown()}>
                    <Text>
                      <Switch
                        fallback={
                          <Trans>
                            The passkey could not be used. Try again.
                          </Trans>
                        }
                      >
                        <Match when={passkeyProblemShown() === "cancelled"}>
                          <Trans>Nothing happened? Try again.</Trans>
                        </Match>
                        <Match when={passkeyProblemShown() === "unavailable"}>
                          <Trans>
                            Passkeys are not available on this device.
                          </Trans>
                        </Match>
                        <Match when={passkeyProblemShown() === "not_accepted"}>
                          <Trans>
                            The passkey was not accepted. Try again.
                          </Trans>
                        </Match>
                        <Match when={passkeyProblemShown() === "no_passkey"}>
                          <Trans>This account has no passkey.</Trans>
                        </Match>
                        <Match when={passkeyProblemShown() === "off"}>
                          <Trans>Passkeys are turned off right now.</Trans>
                        </Match>
                      </Switch>
                    </Text>
                  </Show>
                </Match>
                <Match when={selectedMethod() === "Password"}>
                  <Form2.TextField
                    name="password"
                    control={group.controls.password}
                    type="password"
                    label={t`Password`}
                  />
                </Match>
                <Match when={selectedMethod() === "Totp"}>
                  <Form2.TextField
                    name="totp_code"
                    control={group.controls.totp_code}
                    type="text"
                    label={t`Authenticator App`}
                  />
                </Match>
                <Match when={selectedMethod() === "Recovery"}>
                  <Form2.TextField
                    name="recovery_code"
                    control={group.controls.recovery_code}
                    type="text"
                    label={t`Recovery Code`}
                  />
                </Match>
              </Switch>
            </Match>
            <Match when={noMethods()}>
              <Text>
                {/* Nothing until the server has said whether it offers
                    passkeys: with them off, never point at one */}
                <Switch>
                  <Match when={passkeysOffered() === false}>
                    <Trans>
                      This account has no password yet. Use Reset password on
                      the login screen to set one.
                    </Trans>
                  </Match>
                  <Match when={passkeysOffered() && passkeyHidden()}>
                    <Trans>
                      This action needs a device that has your passkey. Open
                      Sloga on that device to continue.
                    </Trans>
                  </Match>
                  <Match when={passkeysOffered()}>
                    <Trans>
                      This account has no password or passkey to confirm with.
                      Add a passkey in Settings first.
                    </Trans>
                  </Match>
                </Switch>
              </Text>
            </Match>
            <Match when={methods()}>
              <For each={methods()}>
                {(method) => (
                  <CategoryButton
                    action="chevron"
                    icon={
                      <Switch>
                        <Match when={method === "Passkey"}>
                          <BiRegularFingerprint size={24} />
                        </Match>
                        <Match when={method === "Password"}>
                          <BiSolidKeyboard size={24} />
                        </Match>
                        <Match when={method === "Totp"}>
                          <BiSolidKey size={24} />
                        </Match>
                        <Match when={method === "Recovery"}>
                          <BiRegularArchive size={24} />
                        </Match>
                      </Switch>
                    }
                    onClick={() => {
                      setSelected(method);
                      // Clear form values when switching methods
                      group.controls.password.setValue("");
                      group.controls.totp_code.setValue("");
                      group.controls.recovery_code.setValue("");

                      // Picking it is the tap the passkey prompt needs
                      if (method === "Passkey") void usePasskey();
                    }}
                  >
                    <Switch>
                      <Match when={method === "Passkey"}>
                        <Trans>Passkey</Trans>
                      </Match>
                      <Match when={method === "Password"}>
                        <Trans>Password</Trans>
                      </Match>
                      <Match when={method === "Totp"}>
                        <Trans>Authenticator App</Trans>
                      </Match>
                      <Match when={method === "Recovery"}>
                        <Trans>Recovery Code</Trans>
                      </Match>
                    </Switch>
                  </CategoryButton>
                )}
              </For>
            </Match>
          </Switch>
        </Column>
      </form>
    </Dialog>
  );
}
