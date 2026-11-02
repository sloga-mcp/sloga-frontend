import { Show, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import { useE2EE } from "@revolt/client";
import { Column, Dialog, DialogProps, Text } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

import { useE2EEDismissLock, useE2EEReauth } from "./E2EERemoveDevice";

/**
 * Run "Make this a separate device" (multi-device D5) through the bridge:
 * `splitDevice` asks for a native confirm, then an MFA ticket, publishes the
 * new device and commits it. Resolves true once this install IS a separate
 * device. A declined confirm or a dismissed prompt changes nothing and shows
 * nothing; a split the bridge cannot start says why in `notice`. Shared by
 * the modal below and the Settings > Encryption card. Callers offer it only
 * while `splitSupported` is exactly true (an old server would sweep the
 * shared device).
 */
export function useE2EESplit() {
  const { t } = useLingui();
  const e2ee = useE2EE();
  const { showError } = useModals();
  const reauth = useE2EEReauth();

  const [busy, setBusy] = createSignal(false);
  const [notice, setNotice] = createSignal<string>();

  async function run(): Promise<boolean> {
    if (!e2ee || busy()) return false;
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await e2ee.splitDevice(reauth);
      switch (result.kind) {
        case "split":
          return true;
        case "busy":
          setNotice(t`Close the recovery code window first, then try again.`);
          return false;
        case "unavailable":
          setNotice(t`This app cannot be made a separate device right now.`);
          return false;
        case "declined":
        case "cancelled":
          return false;
        default: {
          const unhandled: never = result;
          void unhandled;
          return false;
        }
      }
    } catch (error) {
      showError(error);
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { busy, notice, run };
}

/**
 * Multi-device D5: this install shares its encryption identity with another
 * of the user's installs (both were restored from, or are copies of, one
 * device). The shell opens this when this install's claim was refused twice
 * because the other one holds the device (`held_elsewhere`); an install that
 * only sees divergence gets the Settings card instead. "Not now" dismisses the
 * signal for this device (`dismissDeviceShared`); a new refusal raises it
 * again. Closing the dialog any other way leaves it, so the card stays.
 */
export function E2EEDeviceSharedModal(
  props: DialogProps & Modals & { type: "e2ee_device_shared" },
) {
  const e2ee = useE2EE();
  const split = useE2EESplit();

  const [done, setDone] = createSignal(false);

  useE2EEDismissLock(split.busy);

  const splitSupported = () => e2ee?.splitSupported.get("state") === true;

  function guardedClose() {
    if (split.busy()) return;
    props.onClose();
  }

  function notNow() {
    if (split.busy()) return;
    e2ee?.dismissDeviceShared();
    props.onClose();
  }

  async function makeSeparate() {
    if (!splitSupported()) return;
    if (await split.run()) setDone(true);
  }

  return (
    <Dialog
      show={props.show}
      onClose={guardedClose}
      title={<Trans>Make this a separate device</Trans>}
      isDisabled={split.busy()}
      actions={
        done()
          ? [{ text: <Trans>Done</Trans>, onClick: () => props.onClose() }]
          : [
              {
                text: <Trans>Not now</Trans>,
                onClick: () => {
                  notNow();
                  return false;
                },
                isDisabled: split.busy(),
              },
              ...(splitSupported()
                ? [
                    {
                      text: <Trans>Make this a separate device</Trans>,
                      onClick: () => {
                        void makeSeparate();
                        return false;
                      },
                      isDisabled: split.busy(),
                    },
                  ]
                : []),
            ]
      }
    >
      <Column>
        <Show
          when={!done()}
          fallback={
            <Text>
              <Trans>This app is now a separate device.</Trans>
            </Text>
          }
        >
          <Text>
            <Trans>
              This app shares its encryption identity with another of your apps
              (it was restored from your recovery code). Messages can go missing
              on one of them. Make this app a separate device: it keeps its
              message history, and your contacts will see you added a device.
            </Trans>
          </Text>
          <Show when={split.notice()}>
            <Text class="label">{split.notice()}</Text>
          </Show>
        </Show>
      </Column>
    </Dialog>
  );
}
