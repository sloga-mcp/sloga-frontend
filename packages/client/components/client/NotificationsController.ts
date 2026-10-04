import { useLingui } from "@lingui-solid/solid/macro";

import { Capacitor, registerPlugin } from "@capacitor/core";
import { Accessor, createSignal } from "solid-js";
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
import {
  PushProvider,
  UnifiedPushSubscription,
  choosePushProvider,
  planUnifiedPushRegistration,
  unifiedPushSubscribeBody,
} from "./pushPolicy.ts";
import {
  compareSubscriptionKey,
  decodeVapidKey,
  keyMarker,
  planWebPushSubscription,
  shouldResyncWebPush,
} from "./webPushKey.ts";

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
    // "allowed" only after the subscription actually registered — flipping it
    // first left a session that looked subscribed but never was whenever the
    // registration hung or the app was killed mid-flow.
    try {
      await setUpServiceWorkerSubscription(getClient());
      settings.pushNotificationsState = "allowed";
    } catch (e) {
      console.error(e);
      // No UnifiedPush app installed: nothing failed, and the notification
      // settings explain what to install, so no toast
      if (!(e instanceof NoDistributorError)) {
        snackbar.show({
          message: t`Failed to enable push notifications. Please try again later.`,
        });
      }
      settings.pushNotificationsState = "default";
    }
  };

  /**
   * Re-register the native FCM subscription with the backend. Runs on every
   * logged-in launch: a session's subscription can be lost with no signal to
   * this device (the one-shot first-run flow failed or was interrupted, the
   * backend dropped it, the token changed) and the first-run flow never
   * retries — the session then silently misses every push, including
   * incoming-call rings. /push/subscribe overwrites the session's
   * subscription, so re-syncing is idempotent. No-op on desktop and when
   * the user has disabled push.
   *
   * Web: re-checks the browser's subscription against the server's current
   * VAPID key and re-subscribes on a mismatch (a key rotation otherwise
   * strands the old subscription forever). Only when permission is granted
   * and push is already on; never changes the push setting.
   *
   * Google-free (foss) build: see resyncUnifiedPushSubscription.
   */
  const resyncPushSubscription = async (): Promise<boolean> => {
    if (isWebPushPlatform()) return resyncWebPushSubscription();
    if (!PushTokenNative) return true;
    if (settings.pushNotificationsState === "denied") return true;
    if (pushProvider() === "unifiedpush") {
      return resyncUnifiedPushSubscription();
    }
    try {
      await setUpServiceWorkerSubscription(getClient());
      settings.pushNotificationsState = "allowed";
      return true;
    } catch (e) {
      console.error("Push subscription re-sync failed", e);
      return false;
    }
  };

  const resyncWebPushSubscription = async (): Promise<boolean> => {
    const resyncAllowed = () =>
      shouldResyncWebPush({
        permission:
          "Notification" in window ? Notification.permission : "unsupported",
        pushState: settings.pushNotificationsState,
      }) && !webPushTurnedOff();
    if (!resyncAllowed()) return true;

    try {
      // Checked again once the lock is held: push may have been turned off
      // (and the subscription killed) while this waited for it
      await setUpServiceWorkerSubscription(getClient(), resyncAllowed);
      return true;
    } catch (e) {
      // Safari only lets subscribe() run inside a user gesture; hand the
      // retry to the next click (retryWebPushOnGesture).
      if (
        e instanceof DOMException &&
        e.name === "NotAllowedError" &&
        webPushGestureRetry === "idle"
      ) {
        webPushGestureRetry = "armed";
      }
      console.error("Web push subscription re-sync failed", e);
      return false;
    }
  };

  /**
   * Google-free (foss) build: heal the UnifiedPush registration once per
   * launch, after the client has fetched the server configuration (the
   * configured-client effect in NotificationsWorker). planUnifiedPushRegistration
   * decides; this acts on it. Joins a UnifiedPush operation already in flight
   * instead of racing it.
   */
  const resyncUnifiedPushSubscription = (): Promise<boolean> => {
    if (upInFlight) {
      return upInFlight.then(
        (ok) => ok,
        () => false,
      );
    }

    return runUnifiedPushOp(async () => {
      try {
        const { unifiedPush } = unifiedPushBridges();
        const client = getClient();
        const status = await unifiedPush.status();
        const vapid = unifiedPushVapid(client);
        const plan = planUnifiedPushRegistration({
          configured: client.configured(),
          vapid,
          acked: status.acked,
          storedVapid: status.vapid,
          endpoint: status.endpoint,
        });

        switch (plan.action) {
          case "not-ready":
            return false;
          case "no-distributor":
            unifiedPushGone();
            return true;
          case "reconcile-unsubscribe":
            // The distributor was uninstalled: the server would keep pushing
            // to an endpoint nothing listens on
            setUnifiedPushRegistered(false);
            unifiedPushGone();
            await client.api.post("/push/unsubscribe");
            await unifiedPush.unregister();
            return true;
          case "register":
            return registerUnifiedPushAgain(client, plan.vapid!, status.vapid);
          case "repost":
            // An endpoint stored without its keys can't be re-posted
            if (
              status.endpoint === null ||
              status.p256dh === null ||
              status.auth === null
            ) {
              return registerUnifiedPushAgain(client, vapid!, status.vapid);
            }
            return repostUnifiedPush(client, {
              endpoint: status.endpoint,
              p256dh: status.p256dh,
              auth: status.auth,
            });
        }
      } catch (e) {
        console.error("UnifiedPush re-sync failed", e);
        return false;
      }
    });
  };

  /**
   * Register with the acknowledged distributor again, with no unregister
   * first. If this fails the connector has dropped the old registration
   * anyway, so the next launch registers from scratch.
   */
  const registerUnifiedPushAgain = async (
    client: Client,
    vapid: string,
    storedVapid: string | null,
  ): Promise<boolean> => {
    if (storedVapid !== null && storedVapid !== vapid) {
      console.info("UnifiedPush vapid changed, registering again");
    }
    try {
      const { pushToken } = unifiedPushBridges();
      // First, as on enable: a new endpoint that arrives after the timeout
      // below is still posted natively
      await pushToken.saveSubscription(pushCredentials(client));
      const body: UnifiedPushSubscription = unifiedPushSubscribeBody(
        await registerUnifiedPush(vapid),
      );
      await client.api.post("/push/subscribe", body);
    } catch (e) {
      setUnifiedPushRegistered(false);
      // The distributor went away since status() looked: same as having none
      if (nativeRejectCode(e) === "NO_DISTRIBUTOR") {
        unifiedPushGone();
        return true;
      }
      console.error("UnifiedPush registration failed", e);
      return false;
    }
    return unifiedPushSubscribed();
  };

  /**
   * Post the stored registration again: /push/subscribe overwrites, so this
   * heals a subscription the server lost, as the FCM re-sync does.
   */
  const repostUnifiedPush = async (
    client: Client,
    endpoint: { endpoint: string; p256dh: string; auth: string },
  ): Promise<boolean> => {
    try {
      const { pushToken } = unifiedPushBridges();
      await pushToken.saveSubscription(pushCredentials(client));
      const body: UnifiedPushSubscription = unifiedPushSubscribeBody(endpoint);
      await client.api.post("/push/subscribe", body);
    } catch (e) {
      setUnifiedPushRegistered(false);
      console.error("UnifiedPush subscription re-post failed", e);
      return false;
    }
    return unifiedPushSubscribed();
  };

  /** A live registration on the server: push is on, as after an FCM re-sync */
  const unifiedPushSubscribed = (): boolean => {
    setUnifiedPushRegistered(true);
    settings.pushNotificationsState = "allowed";
    return true;
  };

  /**
   * No distributor, so no registration can exist: an "allowed" left behind
   * would show the toggle on after the app is reinstalled, with nothing to
   * repair it. A user's "denied" stays.
   */
  const unifiedPushGone = () => {
    if (settings.pushNotificationsState === "allowed") {
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
    resyncPushSubscription,
    retryWebPushOnGesture,
  };
}

/**
 * One-shot Safari retry: "armed" when a launch re-sync's subscribe() was
 * refused for lack of a user gesture, "spent" once handed out, so a retry
 * that fails the same way can't re-arm itself on every later click.
 */
let webPushGestureRetry: "idle" | "armed" | "spent" = "idle";

/**
 * Whether the web push re-sync should run again from the next user gesture.
 * Reading it consumes the retry: true at most once per page load.
 */
function retryWebPushOnGesture(): boolean {
  if (webPushGestureRetry !== "armed") return false;
  webPushGestureRetry = "spent";
  return true;
}

/**
 * Native bridge to fetch the FCM device token (Android app only). The foss
 * build's getToken rejects with PUSH_UNAVAILABLE and is never called there:
 * foss push rides UnifiedPush instead.
 */
const PushTokenNative = Capacitor.isNativePlatform()
  ? registerPlugin<{
      getToken(): Promise<{ token: string }>;
      saveSubscription(opts: {
        apiUrl: string;
        sessionToken: string;
      }): Promise<void>;
      clearSubscription(): Promise<void>;
      canUseFullScreenIntent(): Promise<{
        allowed: boolean;
        applicable: boolean;
      }>;
      openFullScreenIntentSettings(): Promise<void>;
      requestNotificationPermission(): Promise<{ granted: boolean }>;
    }>("PushToken")
  : undefined;

const PUSH_PROVIDER = choosePushProvider({
  native: Capacitor.isNativePlatform(),
  unifiedPushAvailable: Capacitor.isPluginAvailable("UnifiedPush"),
});

/**
 * The push transport this build uses: "unifiedpush" only on the Google-free
 * (foss) APK, the one flavor that ships the UnifiedPush plugin. Fixed at
 * load, so every caller gets the same answer from the first render.
 */
export const pushProvider = (): PushProvider => PUSH_PROVIDER;

/** What the UnifiedPush plugin reports; the four stored fields are verbatim */
export type UnifiedPushStatus = {
  distributors: string[];
  acked: string | null;
  endpoint: string | null;
  p256dh: string | null;
  auth: string | null;
  vapid: string | null;
};

/** Native bridge to the UnifiedPush connector (foss build only) */
const UnifiedPushNative =
  pushProvider() === "unifiedpush"
    ? registerPlugin<{
        status(): Promise<UnifiedPushStatus>;
        pickDistributor(): Promise<{ distributor: string }>;
        register(opts: {
          vapid: string;
        }): Promise<{ endpoint: string; p256dh: string; auth: string }>;
        unregister(): Promise<void>;
      }>("UnifiedPush")
    : undefined;

const [registeredSignal, setUnifiedPushRegistered] = createSignal(false);

/**
 * Whether a UnifiedPush registration is live, so pushes ring natively. False
 * on every other build, and until the enable flow or the launch re-sync has
 * confirmed one with the server.
 */
export const unifiedPushRegistered: Accessor<boolean> = registeredSignal;

/** Enabling UnifiedPush found no distributor app installed */
export class NoDistributorError extends Error {
  constructor() {
    super("No UnifiedPush distributor is installed");
    this.name = "NoDistributorError";
  }
}

/** The UnifiedPush plugin's status, or null on other builds or on failure */
export async function unifiedPushStatus(): Promise<UnifiedPushStatus | null> {
  if (pushProvider() !== "unifiedpush" || !UnifiedPushNative) return null;
  try {
    return await UnifiedPushNative.status();
  } catch (e) {
    console.error("UnifiedPush status failed", e);
    return null;
  }
}

/**
 * Both bridges the UnifiedPush paths use. They exist whenever pushProvider()
 * is "unifiedpush" (only a native build has the plugin); the throw narrows.
 */
function unifiedPushBridges() {
  if (!PushTokenNative || !UnifiedPushNative) {
    throw "UnifiedPush is not available in this build";
  }
  return { pushToken: PushTokenNative, unifiedPush: UnifiedPushNative };
}

/**
 * The UnifiedPush operation in flight (enable, launch re-sync or teardown),
 * resolving to whether it succeeded. Each can end in register() or
 * unregister() on the one connector instance, so they run one at a time.
 */
let upInFlight: Promise<boolean> | null = null;

/** Run op as the UnifiedPush operation in flight, once any earlier one settled */
async function runUnifiedPushOp(op: () => Promise<boolean>): Promise<boolean> {
  // Looped: another waiter may have taken the slot first
  while (upInFlight) await upInFlight.catch(() => false);
  const current = op();
  upInFlight = current;
  try {
    return await current;
  } finally {
    if (upInFlight === current) upInFlight = null;
  }
}

/** How long register() may wait for the distributor to answer */
const UNIFIED_PUSH_REGISTER_TIMEOUT = 30_000;

/**
 * register() raced against the timeout above, so the operation in flight
 * always settles. An endpoint that arrives later is still posted natively
 * (SlogaPushService), with the credentials saved before this.
 */
async function registerUnifiedPush(vapid: string) {
  const { unifiedPush } = unifiedPushBridges();
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(
      () => reject("UnifiedPush registration timed out"),
      UNIFIED_PUSH_REGISTER_TIMEOUT,
    );
  });
  try {
    return await Promise.race([unifiedPush.register({ vapid }), timeout]);
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * The code a native plugin rejected with: Capacitor copies the native error,
 * including the code passed to call.reject, onto the rejection.
 */
function nativeRejectCode(e: unknown): unknown {
  return typeof e === "object" && e !== null && "code" in e
    ? e.code
    : undefined;
}

/**
 * The server's VAPID key as the connector's register() takes it (87-char
 * unpadded base64url), or null when none that parses is advertised.
 */
function unifiedPushVapid(client: Client): string | null {
  const bytes = client.configuration
    ? decodeVapidKey(client.configuration.vapid)
    : null;
  return bytes ? keyMarker(bytes) : null;
}

/** What the native side needs to post a subscription on its own */
function pushCredentials(client: Client) {
  return {
    apiUrl: client.options.baseURL,
    sessionToken: client.authenticationHeader[1],
  };
}

/**
 * Enable UnifiedPush: ask for notification permission, let the user pick a
 * distributor if there is a choice, register with it and hand the endpoint
 * to the server. Throws NoDistributorError when none is installed.
 */
async function setUpUnifiedPushSubscription(client: Client) {
  if (!client.configured()) throw "Client not configured";
  const vapid = unifiedPushVapid(client);
  if (vapid === null) throw "Server did not advertise a valid VAPID key";
  const { pushToken, unifiedPush } = unifiedPushBridges();

  await runUnifiedPushOp(async () => {
    try {
      // First, so a new endpoint that reaches SlogaPushService after the
      // timeout below is still posted natively
      await pushToken.saveSubscription(pushCredentials(client));
      await pushToken.requestNotificationPermission();
      try {
        await unifiedPush.pickDistributor();
      } catch (e) {
        if (nativeRejectCode(e) === "NO_DISTRIBUTOR") {
          throw new NoDistributorError();
        }
        throw e;
      }
      const body: UnifiedPushSubscription = unifiedPushSubscribeBody(
        await registerUnifiedPush(vapid),
      );
      await client.api.post("/push/subscribe", body);
      // As the FCM branch does (repeats the first call)
      await pushToken.saveSubscription(pushCredentials(client));
    } catch (e) {
      setUnifiedPushRegistered(false);
      throw e;
    }
    setUnifiedPushRegistered(true);
    return true;
  });
}

/**
 * UnifiedPush teardown, run by every kill (logout, push turned off,
 * permission denied), even when the unsubscribe POST before it threw. Never
 * throws: it runs in a finally.
 */
async function killUnifiedPushSubscription() {
  // Credentials first, so a register() still in flight finds none to post
  // this session with natively
  await PushTokenNative?.clearSubscription().catch(console.error);
  await runUnifiedPushOp(async () => {
    const { pushToken, unifiedPush } = unifiedPushBridges();
    try {
      await unifiedPush.unregister();
    } finally {
      // Again: the operation waited out above may have saved them back
      await pushToken.clearSubscription();
    }
    return true;
  }).catch(console.error);
  setUnifiedPushRegistered(false);
}

/**
 * Whether push rides a browser service worker (VAPID web push): not any
 * native Android build (FCM or UnifiedPush), not the Tauri or Electron
 * desktop shells (no service worker there).
 */
export function isWebPushPlatform(): boolean {
  return (
    !PushTokenNative &&
    !("__TAURI__" in window) &&
    !("slogaShell" in window) &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  );
}

/**
 * Whether incoming calls are currently unable to light up a locked screen.
 *
 * Android 14 grants USE_FULL_SCREEN_INTENT only to apps it classifies as
 * calling apps; for everyone else a full-screen intent is silently demoted to
 * a heads-up notification, so a call rings but the screen stays dark. The
 * toggle that fixes it is buried (and on some OEM skins effectively
 * unfindable), so the app has to offer it.
 *
 * False on every other platform and on Android 13 and below, where the
 * permission does not exist.
 */
export async function fullScreenCallAlertsBlocked(): Promise<boolean> {
  if (!PushTokenNative) return false;
  try {
    const { allowed, applicable } =
      await PushTokenNative.canUseFullScreenIntent();
    return applicable && !allowed;
  } catch {
    // Older shell without the method
    return false;
  }
}

/** Deep-link to the system screen that grants the permission above */
export function openFullScreenCallAlertSettings() {
  PushTokenNative?.openFullScreenIntentSettings().catch(console.error);
}

/**
 * @param gate Web only, re-checked under the lock; when false nothing is
 * subscribed or posted. Only the re-sync passes one: the enable flow must
 * never be gated.
 */
async function setUpServiceWorkerSubscription(
  client: Client,
  gate?: () => boolean,
) {
  // Sloga Desktop: no service worker in the bundled shell (slice 6.2b) —
  // push rides the WebSocket + native notifications instead. Throwing routes
  // the manual settings toggle into the existing failure snackbar/reset.
  if ("__TAURI__" in window) {
    throw "Web push is not supported in the desktop app";
  }

  // Google-free Android app (foss): push rides the UnifiedPush distributor.
  // Never FCM (getToken prompts, then rejects there) and never web push.
  // Ignores gate, which is web only.
  if (pushProvider() === "unifiedpush") {
    await setUpUnifiedPushSubscription(client);
    return;
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
    // Persist the API base + session token so the gms SlogaMessagingService
    // can re-subscribe through PushResubscriber if FCM rotates the token
    // while the app is killed (onNewToken), instead of waiting for the next
    // app launch.
    await PushTokenNative.saveSubscription({
      apiUrl: client.options.baseURL,
      sessionToken: client.authenticationHeader[1],
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

  const { pushManager } = registration;
  // Decoded to raw bytes: either base64 alphabet, padded or not
  const advertised = decodeVapidKey(client.configuration!.vapid);

  // Deliberately no permission/setting gate of its own: the enable flow marks
  // push "allowed" only after this returns, and must still get the key check.
  const syncSubscription = async () => {
    if (gate && !gate()) return;

    // Read inside the lock, so a second tab sees this tab's new subscription
    const existing = await pushManager.getSubscription();
    const plan = planWebPushSubscription({
      advertised,
      existing: !existing
        ? "none"
        : advertised
          ? compareSubscriptionKey(
              existing.options?.applicationServerKey,
              advertised,
            )
          : "unknown",
      // Only consulted when the browser doesn't expose the subscription's key
      markerMatches: advertised ? webPushKeyMarkerMatches(advertised) : null,
    });

    let subscription: PushSubscription;
    switch (plan) {
      case "invalid":
        throw "Server did not advertise a valid VAPID key";
      case "reuse":
        subscription = existing!;
        break;
      case "resubscribe":
      case "subscribe":
        // A subscription made with a different (rotated) key is dead weight:
        // the browser won't take a second key until the old one is gone.
        if (plan === "resubscribe") await existing!.unsubscribe();
        subscription = await pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: advertised!,
        });
        // Records the browser's key, not the server's copy: written even if
        // the POST below fails, so the next launch reuses and re-posts
        // instead of churning the subscription again
        writeWebPushKeyMarker(advertised!);
        break;
    }

    // Always re-posted: /push/subscribe overwrites, so this is idempotent
    await client.api.post("/push/subscribe", {
      endpoint: subscription.endpoint,
      p256dh: arrayBufferToBase64URL(
        subscription.getKey("p256dh") || new ArrayBuffer(),
      ),
      auth: arrayBufferToBase64URL(
        subscription.getKey("auth") || new ArrayBuffer(),
      ),
    });

    // Only a successful enable lifts a turn-off (see WEB_PUSH_OFF)
    if (!gate) setWebPushTurnedOff(false);
  };

  // One tab at a time, so two tabs can't unsubscribe each other's new
  // subscription mid-rotation
  if ("locks" in navigator) {
    await navigator.locks.request("sloga-webpush", syncSubscription);
  } else {
    await syncSubscription();
  }
}

/** Key the current web push subscription was made with (see keyMarker) */
const WEB_PUSH_KEY_MARKER = "sloga.webpush.vapidKey";

/** null when storage is unavailable (private mode, blocked site data) */
function webPushKeyMarkerMatches(advertised: Uint8Array): boolean | null {
  try {
    return localStorage.getItem(WEB_PUSH_KEY_MARKER) === keyMarker(advertised);
  } catch {
    return null;
  }
}

function writeWebPushKeyMarker(bytes: Uint8Array) {
  try {
    localStorage.setItem(WEB_PUSH_KEY_MARKER, keyMarker(bytes));
  } catch {
    // Storage unavailable: the next launch reuses the subscription as-is
  }
}

function clearWebPushKeyMarker() {
  try {
    localStorage.removeItem(WEB_PUSH_KEY_MARKER);
  } catch {
    // Storage unavailable: nothing was stored
  }
}

/**
 * Set whenever push is turned off in this browser (toggle, denied permission,
 * logout). Tabs don't share the push setting live, so another tab's re-sync
 * would trust its own stale "allowed" and subscribe again; only the enable
 * flow clears it, so the next person to log in can still turn push on.
 */
const WEB_PUSH_OFF = "sloga.webpush.off";

/** false when storage is unavailable: never block the re-sync on it */
function webPushTurnedOff(): boolean {
  try {
    return localStorage.getItem(WEB_PUSH_OFF) !== null;
  } catch {
    return false;
  }
}

function setWebPushTurnedOff(off: boolean) {
  try {
    if (off) localStorage.setItem(WEB_PUSH_OFF, "1");
    else localStorage.removeItem(WEB_PUSH_OFF);
  } catch {
    // Storage unavailable: other tabs go by their own setting
  }
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
    try {
      if (!loggingOut) await client.api.post("/push/unsubscribe");
      // Drop stored credentials so a later token rotation can't re-register this
      // now logged-out / unsubscribed session.
      await PushTokenNative.clearSubscription();
    } finally {
      if (pushProvider() === "unifiedpush") await killUnifiedPushSubscription();
    }
    return;
  }

  const registration = await navigator.serviceWorker.getRegistration(
    import.meta.env.BASE_URL ?? undefined,
  );
  if (!registration) {
    // Nothing to unsubscribe, but other tabs must still see push is off
    setWebPushTurnedOff(true);
    return;
  }

  const unsubscribe = async () => {
    // Set first, even with no subscription left or a failing unsubscribe: it
    // records the intent, and queued re-syncs check it once they get the lock
    setWebPushTurnedOff(true);
    // Read inside the lock: a re-sync may have just replaced it
    const subscription = await registration.pushManager.getSubscription();
    if (await subscription?.unsubscribe()) {
      clearWebPushKeyMarker();
      if (!loggingOut) await client.api.post("/push/unsubscribe");
    }
  };

  // Setup's lock: waits out a re-sync mid-rotation, so this unsubscribes the
  // new subscription instead of the one already on its way out
  if ("locks" in navigator) {
    await navigator.locks.request("sloga-webpush", unsubscribe);
  } else {
    await unsubscribe();
  }
}
