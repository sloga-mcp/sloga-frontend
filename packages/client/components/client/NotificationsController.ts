import { useLingui } from "@lingui-solid/solid/macro";

import { Capacitor, registerPlugin } from "@capacitor/core";
import { Client } from "stoat.js";

import { useModals } from "@revolt/modal";
import { useState } from "@revolt/state";
import { useSnackbar } from "@revolt/ui";

import { useClient } from ".";
import {
  notificationPermissionGranted,
  notificationsSupported,
  requestNotificationPermission,
  tauriNotification,
} from "./nativeNotifications";

export function useNotifications() {
  const { settings } = useState();
  const { t } = useLingui();
  const getClient = useClient();
  const snackbar = useSnackbar();
  const { showError } = useModals();

  const supportsNotification = notificationsSupported();

  const onDeny = async (showModal?: boolean) => {
    settings.resetNotificationsState("denied");
    if (showModal) {
      showError(
        t`Failed to enable notifications. Sloga does not have notification permission.`,
      );
    }
    await killServiceWorkerSubscription(getClient());
  };

  const notificationStateMismatch = (): boolean => {
    const areNotificationsAllowed =
      settings.desktopNotificationsState === "allowed" ||
      settings.pushNotificationsState === "allowed";

    const permissionGranted =
      !supportsNotification || notificationPermissionGranted();

    return areNotificationsAllowed && !permissionGranted;
  };

  const initNotifications = async () => {
    if (
      settings.desktopNotificationsState === "default" ||
      notificationStateMismatch()
    ) {
      // Sloga Desktop: OS permission is implicit for installed apps; no test
      // notification and no web push (updates arrive over the WebSocket)
      if (tauriNotification()) {
        settings.desktopNotificationsState = "allowed";
        return;
      }

      // We do this before permission checking because the constructor will still work fine if we don't have permission.
      if (supportsNotification) {
        try {
          const noti = new Notification(
            "This is what notifications will look like. You shouldn't see this for long.",
            { silent: true },
          );
          // Close the notification just after showing
          // On very slow desktop systems, 100 ms just isn't long enough. Skill issue I guess.
          noti.addEventListener("show", () =>
            setTimeout(() => noti.close(), 100),
          );
        } catch {
          // An error means not supported.
          settings.desktopNotificationsState = "unsupported";
        }
      } else {
        settings.desktopNotificationsState = "unsupported";
      }

      if (supportsNotification) {
        if (await requestNotificationPermission()) {
          settings.desktopNotificationsState = "allowed";
          await enablePushSubscription();
        } else {
          await onDeny();
        }
      } else {
        await enablePushSubscription();
      }
    }
  };

  const toggleNotificationPermission = async (modalOnDeny?: boolean) => {
    if (settings.desktopNotificationsState !== "allowed") {
      if (await requestNotificationPermission()) {
        settings.desktopNotificationsState = "allowed";
      } else {
        await onDeny(modalOnDeny);
      }
    } else {
      settings.desktopNotificationsState = "denied";
    }
  };

  const enablePushSubscription = async () => {
    settings.pushNotificationsState = "allowed";
    try {
      await setUpServiceWorkerSubscription(getClient());
    } catch (e) {
      console.error(e);
      snackbar.show({
        message: t`Failed to enable push notifications. Please try again later.`,
      });
      settings.pushNotificationsState = "default";
    }
  };

  const togglePushPermission = async (modalOnDeny?: boolean) => {
    if (settings.pushNotificationsState !== "allowed") {
      if (supportsNotification && !Capacitor.isNativePlatform()) {
        if ((await Notification.requestPermission()) === "granted") {
          await enablePushSubscription();
        } else {
          await onDeny(modalOnDeny);
        }
      } else {
        // On safari mobile, just enable push notifications.
        await enablePushSubscription();
      }
    } else {
      settings.pushNotificationsState = "denied";
      await killServiceWorkerSubscription(getClient());
    }
  };

  return {
    toggleNotificationPermission,
    togglePushPermission,
    initNotifications,
  };
}

/** Native bridge to fetch the FCM device token (Android app only) */
const PushTokenNative = Capacitor.isNativePlatform()
  ? registerPlugin<{ getToken(): Promise<{ token: string }> }>("PushToken")
  : undefined;

async function setUpServiceWorkerSubscription(client: Client) {
  // Sloga Desktop: no service worker in the bundled shell (slice 6.2b) —
  // push rides the WebSocket + native notifications instead. Throwing routes
  // the manual settings toggle into the existing failure snackbar/reset.
  if ("__TAURI__" in window) {
    throw "Web push is not supported in the desktop app";
  }

  // Native Android app: web push is unavailable in the WebView — register
  // the FCM device token as the push subscription instead.
  if (PushTokenNative) {
    const { token } = await PushTokenNative.getToken();
    await client.api.post("/push/subscribe", {
      endpoint: "fcm",
      p256dh: "",
      auth: token,
    });
    return;
  }

  if (!client.configured() || !client.configuration) {
    throw "Client not configured";
  }

  let registration = await navigator.serviceWorker.getRegistration(
    import.meta.env.BASE_URL ?? undefined,
  );
  if (!registration) {
    // Register explicitly — the automatic vite-plugin-pwa registration relies
    // on an HMR event that doesn't always fire (e.g. through a tunnel).
    const swUrl = import.meta.env.DEV ? "/dev-sw.js?dev-sw" : "/serviceWorker.js";
    registration = await navigator.serviceWorker.register(swUrl, {
      scope: import.meta.env.BASE_URL ?? "/",
      type: "module",
    });
    await navigator.serviceWorker.ready;
  }

  const subscription =
    (await registration.pushManager.getSubscription()) ||
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      // Chrome requires base64url without padding; server keys may include it
      applicationServerKey: client.configuration!.vapid
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, ""),
    }));

  await client.api.post("/push/subscribe", {
    endpoint: subscription.endpoint,
    p256dh: arrayBufferToBase64URL(
      subscription.getKey("p256dh") || new ArrayBuffer(),
    ),
    auth: arrayBufferToBase64URL(
      subscription.getKey("auth") || new ArrayBuffer(),
    ),
  });
}

function arrayBufferToBase64URL(buffer: ArrayBuffer): string {
  const intArray = new Uint8Array(buffer);
  // Todo: Upon upgrading the target of this repo, use Uint8Array.prototype.toBase64() instead of this.
  const binaryString = [...intArray.values()]
    .map((byte) => String.fromCodePoint(byte))
    .join("");
  const base64String = btoa(binaryString);
  return base64String
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Exported for the client controller. Don't use this unless you have to. */
export async function killServiceWorkerSubscription(
  client: Client,
  loggingOut?: boolean,
) {
  if (PushTokenNative) {
    if (!loggingOut) await client.api.post("/push/unsubscribe");
    return;
  }

  const registration = await navigator.serviceWorker.getRegistration(
    import.meta.env.BASE_URL ?? undefined,
  );
  if (!registration) return;
  const subscription = await registration.pushManager.getSubscription();
  if (await subscription?.unsubscribe()) {
    if (!loggingOut) await client.api.post("/push/unsubscribe");
  }
}
