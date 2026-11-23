import { onCleanup } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import { Dialog, DialogProps } from "@revolt/ui";

import { Modals } from "../types";

/**
 * Ask before removing a passkey from the account
 */
export function PasskeyRemoveModal(
  props: DialogProps & Modals & { type: "passkey_remove" },
) {
  const { t } = useLingui();

  // Answer exactly once; a dismissal answers with nothing
  let settled = false;
  onCleanup(() => {
    if (!settled) {
      settled = true;
      props.callback();
    }
  });

  function onConfirm() {
    settled = true;
    props.callback(true);
    props.onClose();
  }

  /**
   * The passkey stays on the device; only the account forgets it
   */
  function explanation() {
    const name = props.name;
    return t`You will no longer be able to sign in with "${name}". It may still be listed on your device until you delete it there.`;
  }

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Remove this passkey?</Trans>}
      actions={[
        { text: <Trans>Cancel</Trans> },
        {
          text: <Trans>Remove</Trans>,
          destructive: true,
          onClick: () => {
            onConfirm();
            return false;
          },
        },
      ]}
    >
      {explanation()}
    </Dialog>
  );
}
