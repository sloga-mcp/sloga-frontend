import {
  type JSX,
  For,
  Show,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import { useClient, useE2EE } from "@revolt/client";
import type { OwnDeviceView } from "@revolt/client/e2ee";
import { useTime } from "@revolt/i18n";
import {
  CategoryButton,
  Checkbox,
  Column,
  Dialog,
  DialogProps,
  Text,
  iconSize,
} from "@revolt/ui";

import MdDevices from "@material-design-icons/svg/outlined/devices.svg?component-solid";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * The MFA prompt the bridge's multi-device flows take as `reauth`
 * (`splitDevice`, `removeDevice`, `startOverAsNewDevice`): the same flow
 * every E2EE modal uses, resolving the ticket token or undefined when the
 * user dismisses it. A failure to start the flow is shown and also resolves
 * undefined, so the bridge always takes its "no ticket" path (a staged split
 * is discarded) rather than meeting an unexpected rejection mid-flow.
 */
export function useE2EEReauth(): () => Promise<string | undefined> {
  const client = useClient();
  const { mfaFlow, showError } = useModals();
  return async () => {
    try {
      const mfa = await client().account.mfa();
      const ticket = await mfaFlow(mfa);
      return ticket?.token;
    } catch (error) {
      showError(error);
      return undefined;
    }
  };
}

/**
 * Hold the ESC dismissal lock while `busy` is true (the E2EEReenroll
 * pattern): an in-flight MFA'd request must not be detached by a stray ESC.
 * Only the lock this component took is ever released.
 */
export function useE2EEDismissLock(busy: () => boolean) {
  const modals = useModals();
  let lockToken: string | undefined;
  createEffect(() => {
    if (busy()) {
      lockToken = modals.lockDismiss();
    } else if (lockToken) {
      modals.unlockDismiss(lockToken);
      lockToken = undefined;
    }
  });
  onCleanup(() => {
    if (lockToken) modals.unlockDismiss(lockToken);
  });
}

/**
 * Multi-device D7: the user's own encrypted devices, from
 * `GET /e2ee/devices/{self}` via the bridge. This device first ("This
 * device"), then the others with their session name, when they were created
 * and last seen ("never seen" for a row no install ever claimed), each with
 * Remove. Shown in Settings > Encryption and on the finish-setup success
 * screen. The list is display only; nothing here decides trust. `title` is
 * shown above it, only once there is a listing.
 */
export function E2EEOwnDeviceList(props: { title?: JSX.Element }) {
  const { t } = useLingui();
  const e2ee = useE2EE();
  const { openModal } = useModals();
  const dayjs = useTime();

  const [devices, setDevices] = createSignal<OwnDeviceView[]>([]);

  async function reload() {
    if (!e2ee) return;
    try {
      setDevices(await e2ee.listOwnDevices());
    } catch (error) {
      console.error("[e2ee] own device list failed", error);
    }
  }

  onMount(reload);
  // A device added elsewhere or this device's id changing (a split) changes
  // the listing.
  createEffect(
    on(
      [
        () => e2ee?.ownDeviceAdded.size,
        () => e2ee?.status.get("state")?.device_id,
      ],
      () => void reload(),
      { defer: true },
    ),
  );

  const seen = (device: OwnDeviceView) => {
    const createdAgo = device.createdAt
      ? dayjs(device.createdAt).fromNow()
      : null;
    const created = createdAgo ? t`Created ${createdAgo}` : null;
    const seenAgo =
      device.neverSeen || !device.lastSeenAt
        ? null
        : dayjs(device.lastSeenAt).fromNow();
    const last = seenAgo ? t`Last seen ${seenAgo}` : <Trans>never seen</Trans>;
    return created ? (
      <>
        {created} · {last}
      </>
    ) : (
      last
    );
  };

  return (
    <Show when={devices().length}>
      <Show when={props.title}>
        <Text class="label">{props.title}</Text>
      </Show>
      <CategoryButton.Group>
        <For each={devices()}>
          {(device) => (
            <Show
              when={!device.isThisDevice}
              fallback={
                <CategoryButton
                  icon={<MdDevices {...iconSize(24)} />}
                  description={device.sessionName ?? undefined}
                >
                  <Trans>This device</Trans>
                </CategoryButton>
              }
            >
              <CategoryButton.Collapse
                icon={<MdDevices {...iconSize(24)} />}
                title={device.sessionName ?? device.deviceId}
                description={seen(device)}
              >
                <CategoryButton
                  icon="blank"
                  action="chevron"
                  onClick={() =>
                    openModal({
                      type: "e2ee_remove_device",
                      deviceId: device.deviceId,
                      sessionName: device.sessionName,
                      onRemoved: () => void reload(),
                    })
                  }
                >
                  <Trans>Remove</Trans>
                </CategoryButton>
              </CategoryButton.Collapse>
            </Show>
          )}
        </For>
      </CategoryButton.Group>
    </Show>
  );
}

/**
 * Multi-device D7: remove ANOTHER of the user's own devices
 * (`DELETE /e2ee/keys/{id}` behind MFA). The server tombstones the id (D8),
 * so a removed install that is still running is told it was removed and is
 * offered to set up again as a new device. "Also delete this device's
 * backup" is off by default: that blob can still restore the device's
 * history. MFA tickets are single-use, so deleting the backup too is a
 * second prompt; dismissing only that one keeps the backup.
 */
export function E2EERemoveDeviceModal(
  props: DialogProps & Modals & { type: "e2ee_remove_device" },
) {
  const e2ee = useE2EE();
  const { showError } = useModals();
  const reauth = useE2EEReauth();

  const [busy, setBusy] = createSignal(false);
  const [deleteBackup, setDeleteBackup] = createSignal(false);
  // Removed, but the second (backup) prompt was dismissed or refused.
  const [backupKept, setBackupKept] = createSignal(false);

  useE2EEDismissLock(busy);

  function guardedClose() {
    if (busy()) return;
    props.onClose();
  }

  async function remove() {
    if (!e2ee) return;
    setBusy(true);
    // Whether the FIRST prompt (the device delete) produced a ticket. A
    // dismissed first prompt means nothing was removed, whichever way the
    // bridge reports it, so the dialog stays as it was.
    let prompts = 0;
    let removeConfirmed = false;
    const tracked = async () => {
      const token = await reauth();
      if (prompts++ === 0) removeConfirmed = !!token;
      return token;
    };
    try {
      const result = await e2ee.removeDevice(
        props.deviceId,
        { deleteBackup: deleteBackup() },
        tracked,
      );
      if (!removeConfirmed) return;
      props.onRemoved?.();
      if (deleteBackup() && result.backupDeleted !== true) {
        setBackupKept(true);
        return;
      }
      props.onClose();
    } catch (error) {
      if (prompts > 0 && !removeConfirmed) return;
      showError(error);
      props.onRemoved?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      show={props.show}
      onClose={guardedClose}
      title={<Trans>Remove device</Trans>}
      isDisabled={busy()}
      actions={
        backupKept()
          ? [{ text: <Trans>Done</Trans>, onClick: () => props.onClose() }]
          : [
              {
                text: <Trans>Cancel</Trans>,
                onClick: () => {
                  guardedClose();
                  return false;
                },
                isDisabled: busy(),
              },
              {
                text: <Trans>Remove</Trans>,
                onClick: () => {
                  void remove();
                  return false;
                },
                isDisabled: busy(),
                destructive: true,
              },
            ]
      }
    >
      <Column>
        <Text class="title">{props.sessionName ?? props.deviceId}</Text>
        <Show
          when={!backupKept()}
          fallback={
            <Text>
              <Trans>
                The device was removed, but its backup was not deleted.
              </Trans>
            </Text>
          }
        >
          <Text>
            <Trans>
              It stops receiving your encrypted messages. If it is still
              running, it has to be set up again as a new device.
            </Trans>
          </Text>
          <Text>
            <Trans>
              Its backup can still restore its message history unless you delete
              it too. You confirm your identity once to remove the device, and
              once more to delete its backup.
            </Trans>
          </Text>
          <Checkbox
            checked={deleteBackup()}
            disabled={busy()}
            onChange={(event) => setDeleteBackup(event.currentTarget.checked)}
          >
            <Trans>Also delete this device's backup</Trans>
          </Checkbox>
        </Show>
      </Column>
    </Dialog>
  );
}
