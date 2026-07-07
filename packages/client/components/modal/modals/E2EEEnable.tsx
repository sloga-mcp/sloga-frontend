import { Match, Switch, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import { useClient, useE2EE } from "@revolt/client";
import { Column, Dialog, DialogProps, Text } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * Opt in to end-to-end encryption on THIS device (implementation plan
 * slice 3, item 1).
 *
 * The consent gate is the MFA-gated key publish inside the native layer —
 * NOT the `e2ee_enabled` profile flag (a pure UI hint, invariant 2). The
 * flow: generate the device identity natively → MFA ticket → publish keys
 * under that ticket → mark published → claim the device on the live
 * connection.
 */
export function E2EEEnableModal(
  props: DialogProps & Modals & { type: "e2ee_enable" },
) {
  const { t } = useLingui();
  const client = useClient();
  const e2ee = useE2EE();
  const { mfaFlow, showError } = useModals();

  const [busy, setBusy] = createSignal(false);
  const [done, setDone] = createSignal(false);

  async function enable() {
    if (!e2ee) return;
    setBusy(true);
    try {
      // MFA ticket gates the server-side key publication (the real consent
      // gate). The user proves account ownership before any device binds.
      const mfa = await client().account.mfa();
      const ticket = await mfaFlow(mfa);
      if (!ticket) {
        setBusy(false);
        return;
      }

      await e2ee.enable(ticket.token);
      setDone(true);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Turn on encrypted direct messages</Trans>}
      isDisabled={busy()}
      actions={
        done()
          ? [{ text: <Trans>Done</Trans>, onClick: () => props.onClose() }]
          : [
              {
                text: <Trans>Cancel</Trans>,
                onClick: () => {
                  props.onClose();
                  return false;
                },
              },
              {
                text: <Trans>Turn on</Trans>,
                onClick: () => {
                  void enable();
                  return false;
                },
                isDisabled: busy(),
              },
            ]
      }
    >
      <Column>
        <Switch>
          <Match when={done()}>
            <Text>
              <Trans>
                Encrypted direct messages are on for this device. Messages you
                send in an encrypted conversation are stored only on the
                devices that receive them — not on the server, and not in your
                web session.
              </Trans>
            </Text>
          </Match>
          <Match when={!done()}>
            <Text>
              <Trans>
                New direct messages with contacts who also have encryption on
                will be end-to-end encrypted. Only your devices can read them —
                the server relays ciphertext it cannot decrypt.
              </Trans>
            </Text>
            <Text>
              <Trans>
                Encrypted history lives on THIS device only. If you log out and
                choose to erase it, or lose the device, those messages cannot
                be recovered. You will confirm your identity to continue.
              </Trans>
            </Text>
          </Match>
        </Switch>
      </Column>
    </Dialog>
  );
}
