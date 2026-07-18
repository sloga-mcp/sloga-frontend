import { Match, Switch, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import { useClient, useE2EE } from "@revolt/client";
import { Column, Dialog, DialogProps, Text } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * Turn OFF end-to-end encryption on THIS device.
 *
 * Destructive and MFA-gated, mirroring enable. The MFA ticket authorizes
 * the server-side device revoke; the actual local destruction is confirmed
 * again by a native OS dialog inside `e2ee.disable` (so a compromised
 * webview cannot wipe history without a physical click). Declining that OS
 * dialog aborts the whole thing with nothing changed.
 */
export function E2EEDisableModal(
  props: DialogProps & Modals & { type: "e2ee_disable" },
) {
  const { t } = useLingui();
  const client = useClient();
  const e2ee = useE2EE();
  const { mfaFlow, showError } = useModals();

  const [busy, setBusy] = createSignal(false);
  const [done, setDone] = createSignal(false);
  const [failedDeviceId, setFailedDeviceId] = createSignal<string>();

  async function disable() {
    if (!e2ee) return;
    setBusy(true);
    try {
      const mfa = await client().account.mfa();
      const ticket = await mfaFlow(mfa);
      if (!ticket) {
        setBusy(false);
        return;
      }

      const result = await e2ee.disable(ticket.token);
      if (result.revokeFailed && result.deviceId) {
        // Local wipe succeeded; the server-side revoke did not (rev-2
        // MAJOR-2). Keep the device id for a DELETE-only retry.
        setFailedDeviceId(result.deviceId);
      } else {
        setDone(true);
      }
    } catch (error) {
      // Declining the native OS confirmation aborts cleanly — not an error
      if ((error as { type?: string })?.type === "declined") {
        props.onClose();
        return;
      }
      showError(error);
    } finally {
      setBusy(false);
    }
  }

  /** DELETE-only retry with a fresh MFA ticket — never re-runs the wipe. */
  async function retryRevoke() {
    const deviceId = failedDeviceId();
    if (!e2ee || !deviceId) return;
    setBusy(true);
    try {
      const mfa = await client().account.mfa();
      const ticket = await mfaFlow(mfa);
      if (!ticket) {
        setBusy(false);
        return;
      }
      await e2ee.retryDeviceRevoke(deviceId, ticket.token);
      setFailedDeviceId(undefined);
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
      title={<Trans>Turn off encrypted direct messages</Trans>}
      isDisabled={busy()}
      actions={
        done()
          ? [{ text: <Trans>Done</Trans>, onClick: () => props.onClose() }]
          : failedDeviceId()
            ? [
                {
                  text: <Trans>Close</Trans>,
                  onClick: () => {
                    props.onClose();
                    return false;
                  },
                },
                {
                  text: <Trans>Retry</Trans>,
                  onClick: () => {
                    void retryRevoke();
                    return false;
                  },
                  isDisabled: busy(),
                },
              ]
            : [
              {
                text: <Trans>Cancel</Trans>,
                onClick: () => {
                  props.onClose();
                  return false;
                },
              },
              {
                text: <Trans>Turn off</Trans>,
                onClick: () => {
                  void disable();
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
                Encryption is off for this device. New direct messages are no
                longer end-to-end encrypted, and your contacts have been told
                this device no longer uses encryption.
              </Trans>
            </Text>
          </Match>
          <Match when={failedDeviceId()}>
            <Text>
              <Trans>
                Your encrypted data on this device was destroyed, but the old
                device entry could not be removed from the server. Other
                devices may keep sending messages to it until it is removed.
                You can retry now, and this entry can also be removed later.
              </Trans>
            </Text>
          </Match>
          <Match when={!done()}>
            <Text>
              <Trans>
                New direct messages from this device will no longer be
                end-to-end encrypted.
              </Trans>
            </Text>
            <Text>
              <Trans>
                The encrypted message history stored on THIS device will be
                permanently deleted and cannot be recovered. You will confirm
                your identity, then confirm the deletion.
              </Trans>
            </Text>
          </Match>
        </Switch>
      </Column>
    </Dialog>
  );
}
