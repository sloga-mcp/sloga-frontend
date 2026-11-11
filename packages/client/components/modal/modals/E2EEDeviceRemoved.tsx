import { Match, Switch, createSignal } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";

import { useE2EE } from "@revolt/client";
import { Column, Dialog, DialogProps, Text } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

import { useE2EEDismissLock, useE2EEReauth } from "./E2EERemoveDevice";

/**
 * Multi-device D8: this device was removed from the account's encryption.
 *
 * The server tombstoned this device id (the user removed it from another
 * device), so its claims are refused with `removed` and a re-publish of the
 * same identity is refused with `E2EEDeviceRemoved`. Coming back means a NEW
 * device: `startOverAsNewDevice` wipes the local store behind the native
 * confirm (declining it changes nothing), then asks for an MFA ticket and
 * enables fresh keys. A dismissed prompt after the wipe leaves an empty
 * install, which the shell then offers to restore or start fresh. This never
 * offers the §6.4 "finish restoring" re-enroll, which would bring the removed
 * identity back.
 */
export function E2EEDeviceRemovedModal(
  props: DialogProps & Modals & { type: "e2ee_device_removed" },
) {
  const e2ee = useE2EE();
  const { showError } = useModals();
  const reauth = useE2EEReauth();

  const [busy, setBusy] = createSignal(false);
  const [done, setDone] = createSignal(false);

  useE2EEDismissLock(busy);

  function guardedClose() {
    if (busy()) return;
    props.onClose();
  }

  async function startOver() {
    if (!e2ee) return;
    setBusy(true);
    try {
      const result = await e2ee.startOverAsNewDevice(reauth);
      if (result === "enabled") {
        setDone(true);
      } else if (result === "wiped") {
        props.onClose();
      }
      // "declined": the native confirm was refused, nothing changed.
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      show={props.show}
      onClose={guardedClose}
      title={<Trans>Set up as a new device</Trans>}
      isDisabled={busy()}
      actions={
        done()
          ? [
              {
                text: <Trans>Create a recovery code for this device</Trans>,
                onClick: () => {
                  void e2ee
                    ?.createRecoveryCode()
                    .catch((error) => showError(error));
                  props.onClose();
                },
              },
              {
                text: <Trans>Skip for now</Trans>,
                onClick: () => props.onClose(),
              },
            ]
          : [
              {
                text: <Trans>Not now</Trans>,
                onClick: () => {
                  guardedClose();
                  return false;
                },
                isDisabled: busy(),
              },
              {
                text: <Trans>Set up as a new device</Trans>,
                onClick: () => {
                  void startOver();
                  return false;
                },
                isDisabled: busy(),
                destructive: true,
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
                send in an encrypted conversation are stored only on the devices
                that receive them — not on the server, and not in your web
                session.
              </Trans>
            </Text>
          </Match>
          <Match when={!done()}>
            <Text>
              <Trans>
                This device was removed from your account's encryption. Set it
                up again as a new device?
              </Trans>
            </Text>
            <Text>
              <Trans>
                This deletes the encrypted message history stored on this
                device. You will confirm the deletion, then your identity.
              </Trans>
            </Text>
          </Match>
        </Switch>
      </Column>
    </Dialog>
  );
}
