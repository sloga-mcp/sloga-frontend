import { Match, Switch, createSignal } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";

import { useE2EE } from "@revolt/client";
import { Column, Dialog, DialogProps, Text } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

import {
  E2EEOwnDeviceList,
  useE2EEDismissLock,
  useE2EEReauth,
} from "./E2EERemoveDevice";

/**
 * Multi-device D3: finish setting up encryption on this device.
 *
 * The bridge raises `publishPending` when this device holds keys the server
 * never registered: a recovery-code restore (which adds a NEW device and
 * already spent one MFA ticket fetching the backup) or an interrupted start
 * fresh. The first publication needs its own ticket, so this modal confirms
 * account ownership once more and hands it to `finishSetup`, which publishes
 * the payload `enable()` re-offers. Until then the native layer refuses to
 * encrypt (`NotPublished`), so nothing falls back to plaintext. A dismissed
 * prompt changes nothing: the signal survives, and the Settings card offers
 * the same step. On success it shows the user's other devices (D7) and
 * offers a recovery code for THIS device (backups are per device).
 */
export function E2EEFinishSetupModal(
  props: DialogProps & Modals & { type: "e2ee_finish_setup" },
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

  async function finish() {
    if (!e2ee) return;
    // Nothing left to finish (done elsewhere, or the store was reset), or the
    // device was removed (that prompt replaces this one): close without
    // burning an MFA prompt.
    if (!e2ee.publishPending.get("state") || e2ee.deviceRemoved.get("state")) {
      props.onClose();
      return;
    }
    setBusy(true);
    try {
      const token = await reauth();
      if (!token) return;
      await e2ee.finishSetup(token);
      setDone(true);
    } catch (error) {
      // A removed device's publish is refused and the bridge raises
      // `deviceRemoved`, whose own prompt the shell opens.
      if ((error as { type?: string })?.type === "E2EEDeviceRemoved") {
        props.onClose();
        return;
      }
      showError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      show={props.show}
      onClose={guardedClose}
      title={<Trans>Finish setting up encryption on this device</Trans>}
      isDisabled={busy()}
      actions={
        done()
          ? [
              {
                text: <Trans>Create a recovery code for this device</Trans>,
                onClick: () => {
                  // Same courier as the opt-in success screen: the native
                  // recovery window (desktop) or dialog (Capacitor) mints
                  // and uploads it. Skipping leaves the Settings card's offer.
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
                text: <Trans>Confirm identity</Trans>,
                onClick: () => {
                  void finish();
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
                send in an encrypted conversation are stored only on the devices
                that receive them — not on the server, and not in your web
                session.
              </Trans>
            </Text>
            <Text>
              <Trans>
                Your other devices still work. If one of them is lost or
                replaced, remove it.
              </Trans>
            </Text>
            <E2EEOwnDeviceList />
          </Match>
          <Match when={!done()}>
            <Text>
              <Trans>
                This device is not registered for encryption yet, so it cannot
                send or receive encrypted messages. Confirm your identity to
                finish.
              </Trans>
            </Text>
            <Text>
              <Trans>
                It is added as a new device, and your contacts will see that you
                added one.
              </Trans>
            </Text>
          </Match>
        </Switch>
      </Column>
    </Dialog>
  );
}
