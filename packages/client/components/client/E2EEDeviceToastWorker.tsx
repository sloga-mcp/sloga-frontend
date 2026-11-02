import { createEffect, untrack } from "solid-js";

import { useLingui } from "@lingui-solid/solid/macro";

import { useSnackbar } from "@revolt/ui/components/design/Snackbar";

import { useClient } from ".";
import type { E2EEBridge } from "./e2ee";
import { type DeviceToast, takeNewDeviceToasts } from "./e2eeDeviceToast";

/**
 * Device ids already toasted, per bridge. At module scope, so a remounted
 * worker does not show the same device again; per bridge, so a new session
 * starts clear.
 */
const shownDeviceToasts = new WeakMap<object, Set<string>>();

/**
 * Shows a one-time toast when encryption starts on another of the user's
 * devices (multi-device plan D7). The bridge's `ownDeviceAdded` map holds
 * one entry per new device id; each shows once, through the app's snackbar.
 * Display only: whether that device is trusted is the own-device chip's
 * call, not this toast's.
 *
 * Its own worker because the client context sits outside the snackbar
 * provider, and `NotificationsWorker` keeps a single snackbar call.
 */
export function E2EEDeviceToastWorker() {
  const { t } = useLingui();
  const client = useClient();
  const snackbar = useSnackbar();

  /**
   * The copy for one toast.
   * @param toast Toast
   * @returns Message
   */
  function deviceToastCopy(toast: DeviceToast): string {
    switch (toast.kind) {
      case "split":
        return t`Your other app became a separate device.`;
      case "added": {
        const sessionName = toast.sessionName;
        if (sessionName === null)
          return t`Encryption was set up on another of your devices. Not you? Remove it in Settings > Encryption, change your password, then log out other sessions.`;
        return t`Encryption was set up on another of your devices (${sessionName}). Not you? Remove it in Settings > Encryption, change your password, then log out other sessions.`;
      }
      default: {
        const _exhaustive: never = toast;
        return t`Encryption was set up on another of your devices. Not you? Remove it in Settings > Encryption, change your password, then log out other sessions.`;
      }
    }
  }

  createEffect(() => {
    const e2ee = client()?.e2ee as E2EEBridge | undefined;
    const added = e2ee?.ownDeviceAdded;
    if (!e2ee || !added) return;
    let shown = shownDeviceToasts.get(e2ee);
    if (!shown) {
      shown = new Set();
      shownDeviceToasts.set(e2ee, shown);
    }
    const fresh = takeNewDeviceToasts(shown, added.entries());
    untrack(() => {
      for (const toast of fresh) {
        // The warning asks the user to act: a close button, and it stays up
        // longer than the default.
        const warning = toast.kind === "added";
        snackbar.show({
          message: deviceToastCopy(toast),
          messageLine: 2,
          closeable: warning,
          autoCloseDelay: warning ? 15_000 : undefined,
        });
      }
    });
  });

  return null;
}
