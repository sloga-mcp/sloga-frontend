/**
 * Bridge between the app's notification code and whatever the platform
 * actually supports:
 * - Sloga Desktop (Tauri): the web Notification API silently does nothing in
 *   WebView2, so we route through the tauri-plugin-notification global.
 * - Web: standard Notification API.
 */

type TauriNotificationApi = {
  sendNotification(options: {
    title: string;
    body?: string;
    silent?: boolean;
  }): void;
  isPermissionGranted(): Promise<boolean>;
  requestPermission(): Promise<"granted" | "denied" | "default">;
};

/** Tauri notification plugin, present only inside the desktop app */
export function tauriNotification(): TauriNotificationApi | undefined {
  return (
    window as {
      __TAURI__?: { notification?: TauriNotificationApi };
    }
  ).__TAURI__?.notification;
}

/** Whether this platform can show desktop notifications at all */
export function notificationsSupported(): boolean {
  return !!tauriNotification() || "Notification" in window;
}

/** Whether OS-level permission has been granted (user settings not included) */
export function notificationPermissionGranted(): boolean {
  // Tauri: permission is granted at the OS level for installed apps; the
  // capability file grants the webview access. Treat as granted.
  if (tauriNotification()) return true;
  return "Notification" in window && Notification.permission === "granted";
}

/**
 * Ask the OS for notification permission.
 * @returns true if granted
 */
export async function requestNotificationPermission(): Promise<boolean> {
  const tauri = tauriNotification();
  if (tauri) {
    if (await tauri.isPermissionGranted()) return true;
    return (await tauri.requestPermission()) === "granted";
  }

  if (!("Notification" in window)) return false;
  return (await Notification.requestPermission()) === "granted";
}

/** Tauri core invoke, present only inside the desktop app */
function tauriInvoke():
  | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>)
  | undefined {
  return (
    window as {
      __TAURI__?: {
        core?: {
          invoke?: (
            cmd: string,
            args?: Record<string, unknown>,
          ) => Promise<unknown>;
        };
      };
    }
  ).__TAURI__?.core?.invoke;
}

/**
 * Show a desktop notification.
 * - Web: standard Notification with `onClick`.
 * - Tauri: if `path` is given, route through the shell's clickable toast
 *   (`show_clickable_notification` — clicking focuses the window and emits
 *   `notification_clicked` with the path, handled in NotificationsWorker);
 *   shells without that command fall back to a fire-and-forget toast.
 */
export function showNotification(options: {
  title: string;
  body?: string;
  icon?: string;
  image?: string;
  tag?: string;
  timestamp?: Date;
  onClick?: () => void;
  /** In-app path to open when the notification is clicked (serializable) */
  path?: string;
}): void {
  const tauri = tauriNotification();
  if (tauri) {
    const invoke = tauriInvoke();
    if (invoke && options.path) {
      invoke("show_clickable_notification", {
        title: options.title,
        body: options.body ?? null,
        path: options.path,
      }).catch(() =>
        // Older shell without the command — plain toast
        tauri.sendNotification({
          title: options.title,
          body: options.body,
        }),
      );
      return;
    }

    tauri.sendNotification({
      title: options.title,
      body: options.body,
    });
    return;
  }

  if (!("Notification" in window)) return;

  const notification = new Notification(options.title, {
    icon: options.icon,
    // @ts-expect-error this does exist on some platforms
    image: options.image,
    body: options.body,
    timestamp: options.timestamp?.getTime(),
    tag: options.tag,
    badge: "/assets/web/android-chrome-512x512.png",
    silent: true,
  });

  if (options.onClick) {
    notification.addEventListener("click", options.onClick);
  }
}
