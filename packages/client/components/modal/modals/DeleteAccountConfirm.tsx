import { createSignal } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";

import { Column, Dialog, DialogProps, Text } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * Asks before an account deletion request is sent (Settings → Account Info →
 * Delete Account). Confirming runs `onConfirm`, which sends the request and
 * shows its own outcome: the "check your email" notice, or an error. This
 * modal only waits for it and then closes.
 *
 * While it runs, both buttons are disabled and a backdrop click is ignored,
 * so a double press can't send two requests. Escape still closes the modal;
 * the request carries on and its outcome is still shown.
 */
export function DeleteAccountConfirmModal(
  props: DialogProps & Modals & { type: "delete_account_confirm" },
) {
  const { showError } = useModals();
  const [pending, setPending] = createSignal(false);

  async function confirm() {
    if (pending()) return;
    setPending(true);
    try {
      await props.onConfirm();
    } catch (error) {
      // `onConfirm` shows its own errors; this only catches what it missed,
      // so a failure is never silent.
      showError(error);
    } finally {
      setPending(false);
      props.onClose();
    }
  }

  return (
    <Dialog
      show={props.show}
      onClose={() => {
        if (!pending()) props.onClose();
      }}
      title={<Trans>Delete your account?</Trans>}
      actions={[
        { text: <Trans>Cancel</Trans> },
        {
          text: <Trans>Email me the link</Trans>,
          destructive: true,
          onClick: () => {
            void confirm();
            return false;
          },
        },
      ]}
      isDisabled={pending()}
    >
      <Column>
        <Text>
          <Trans>
            We'll email you a link to finish. Once you confirm from that email,
            your account and everything tied to it are deleted right away.
          </Trans>
        </Text>
      </Column>
    </Dialog>
  );
}
