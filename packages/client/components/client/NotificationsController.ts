import { useLingui } from "@lingui-solid/solid/macro";

import { Capacitor, registerPlugin } from "@capacitor/core";
import { Accessor, createSignal } from "solid-js";
import {
  type Channel,
  type HydratedChannel,
  type HydratedUser,
  type User,
  Client,
} from "stoat.js";

import { useModals } from "@revolt/modal";
import { useState } from "@revolt/state";
import { useSnackbar } from "@revolt/ui";

import { useClient, useClientLifecycle } from ".";
import {
  type CallContacts,
  buildCallContacts,
  callContactsKey,
} from "./callContacts.ts";
import {
  notificationPermissionGranted,
  notificationsSupported,
  requestNotificationPermission,
  tauriNotification,
} from "./nativeNotifications";
import {
  type PushPrefs,
  PushProvider,
  UnifiedPushSubscription,
  choosePushProvider,
  planUnifiedPushRegistration,
  pushPrefs,
  unifiedPushSubscribeBody,
  withPushPrefs,
} from "./pushPolicy.ts";
import {
  SLIM_DEV_STORAGE_KEY,
  resolveSlim,
  slimDevOverrideFrom,
} from "./slimMode.ts";
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
  const { lifecycle } = useClientLifecycle();
  const snackbar = useSnackbar();
  const { showError } = useModals();

  // The functions outside this hook cannot reach the providers, so every
  // caller hands them what they read. See `bindApp`.
  bindApp({ settings, client: getClient, lifecycle });

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
   * Re-register the native push subscription (FCM on Android, APNs on iOS)
   * with the backend. Runs on every
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
    if (!PushTokenNative && !IS_IOS_NATIVE) return true;
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
      await saveNativeSubscription(pushToken, client);
      const body: UnifiedPushSubscription = unifiedPushSubscribeBody(
        await registerUnifiedPush(vapid),
      );
      await postSubscription(client, body);
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
      await saveNativeSubscription(pushToken, client);
      const body: UnifiedPushSubscription = unifiedPushSubscribeBody(endpoint);
      await postSubscription(client, body);
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

/** True in the native iOS shell, where push is APNs rather than FCM or web push */
const IS_IOS_NATIVE =
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";

/** How long to wait for APNs to hand back a device token before giving up */
const APNS_TOKEN_TIMEOUT = 30_000;

/**
 * Native bridge to fetch the FCM device token (Android app only). The foss
 * build's getToken rejects with PUSH_UNAVAILABLE and is never called there:
 * foss push rides UnifiedPush instead.
 *
 * Gated on the platform, not on `isNativePlatform()`: this plugin does not
 * exist in the iOS shell, so every method there rejects with UNIMPLEMENTED.
 */
const PushTokenNative =
  Capacitor.getPlatform() === "android"
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
        /**
         * Store the two push preferences, so a subscription the phone posts
         * by itself carries them. `clearSubscription` wipes them again.
         */
        setPushPrefs(opts: {
          chatsOnly: boolean;
          noRing: boolean;
        }): Promise<void>;
        /**
         * Replace the names and photos the ring notification can show. What
         * is stored is exactly this list: anything not in it is forgotten.
         */
        setCallContacts(list: CallContacts): Promise<void>;
        /** Forget every stored name and photo. */
        clearCallContacts(): Promise<void>;
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
 * What the code outside `useNotifications` reads from the app: the settings
 * store, the current client and the client lifecycle.
 *
 * All three come from context providers, so nothing at module scope can
 * reach them. `useNotifications` hands them over each time a component calls
 * it. The notifications worker calls it when a signed-in session mounts,
 * which is before anything here posts a subscription.
 */
type AppHandles = {
  settings: ReturnType<typeof useState>["settings"];
  client: () => Client | undefined;
  lifecycle: ReturnType<typeof useClientLifecycle>["lifecycle"];
};

let app: AppHandles | undefined;

/**
 * Whether `app` has been handed over yet. A signal, so an effect that called
 * `resyncPushPrefs` before there was anything to read runs again once there
 * is.
 */
const [appBound, setAppBound] = createSignal(false);

/**
 * Keep the handles `useNotifications` was given and start what depends on
 * them. Calling it again for the same app changes nothing: the lifecycle
 * keeps one entry for a hook it already has, and a client that is already
 * watched is left alone.
 */
function bindApp(handles: AppHandles) {
  app = handles;
  setAppBound(true);
  handles.lifecycle.onSignOut(endSession);
  watchCallContacts(handles.client());
}

/**
 * Runs when the session ends, while its client is still the current one.
 * The subscription that was posted belonged to that session, and so did the
 * names on the phone.
 */
function endSession() {
  forgetSubscription();
  dropCallContacts();
}

/** The development override for Slim view, once it has been worked out. */
let slimDevOverride: boolean | undefined;

/**
 * Whether the development override for Slim view is on. Always false outside
 * a development build. `useSlimMode.ts` owns the latch in `sessionStorage`
 * and writes it when the page loads. This reads what was stored, by the same
 * rule, the first time a preference is needed.
 */
function readSlimDevOverride(): boolean {
  if (!import.meta.env.DEV) return false;
  if (slimDevOverride === undefined) {
    let stored: string | null = null;
    try {
      stored = sessionStorage.getItem(SLIM_DEV_STORAGE_KEY);
    } catch {
      // Storage is blocked: the URL decides
    }
    slimDevOverride = slimDevOverrideFrom(true, location.search, stored);
  }
  return slimDevOverride;
}

/**
 * The two preferences for a subscription of `client`'s session, as they are
 * right now.
 *
 * Slim view here is the answer `resolveSlim` gives, the one the layout uses,
 * and not the stored setting: a staff account is never in Slim view. The
 * facts are gathered the way `useSlimMode.ts` gathers them. That file's
 * accessor is a memo owned by the component that asked for it, so code that
 * outlives components cannot hold on to it.
 *
 * Before `useNotifications` has run there is nothing to read. The answer is
 * then no preference at all, which the server reads as its defaults.
 */
function currentPushPrefs(client: Client | undefined): PushPrefs {
  if (!app) return {};
  const user = client?.user;
  return pushPrefs({
    slim: resolveSlim({
      setting: app.settings.getValue("appearance:slim_view") === true,
      nativeShell: Capacitor.isNativePlatform(),
      // No build locks Slim view on yet, as in `useSlimMode.ts`
      locked: false,
      staff: !!user?.privileged,
      devOverride: readSlimDevOverride(),
    }),
    userLoaded: !!user,
    ringCalls: app.settings.getValue("notifications:ring_calls") !== false,
  });
}

/** A short string that is the same for the same preferences. */
function pushPrefsKey(prefs: PushPrefs): string {
  return `${prefs.chats_only === true}:${prefs.no_ring === true}`;
}

/**
 * Android: store the two preferences natively, so a subscription the phone
 * posts by itself (a rotated FCM token, a new UnifiedPush endpoint) carries
 * them too. Sent again after every `saveSubscription` and every post,
 * because clearing the stored subscription wipes them. Never throws: an
 * older app without the method still has to subscribe.
 */
async function saveNativePushPrefs(prefs: PushPrefs): Promise<void> {
  if (!PushTokenNative) return;
  try {
    await PushTokenNative.setPushPrefs({
      chatsOnly: prefs.chats_only === true,
      noRing: prefs.no_ring === true,
    });
  } catch (e) {
    console.error("Storing the push preferences natively failed", e);
  }
}

/**
 * Hand the native side what it needs to post a subscription on its own: the
 * session's credentials, and right after them the two preferences.
 */
async function saveNativeSubscription(
  pushToken: NonNullable<typeof PushTokenNative>,
  client: Client,
): Promise<void> {
  await pushToken.saveSubscription(pushCredentials(client));
  await saveNativePushPrefs(currentPushPrefs(client));
}

/** The fields every `/push/subscribe` body has, whatever the transport. */
type SubscribeBody = { endpoint: string; p256dh: string; auth: string };

/**
 * The subscription this page load last posted: the session it was posted
 * for, its body, and the preferences that body carried. Held in memory only,
 * because the body is the device's push token or its endpoint keys.
 *
 * `resyncPushPrefs` goes by it. A device that has posted nothing has nothing
 * to post again, and a changed preference never makes a transport hand out a
 * new token.
 */
type PostedSubscription = {
  client: Client;
  body: SubscribeBody;
  prefs: string;
};

let posted: PostedSubscription | undefined;

/** Counts teardowns, so a post in flight during one is not remembered. */
let subscriptionEpoch = 0;

/** This device no longer has a subscription (push turned off, or sign-out). */
function forgetSubscription() {
  posted = undefined;
  subscriptionEpoch += 1;
}

/**
 * Counts the subscription posts started, so a teardown can tell whether a
 * new one was started after it (see `killServiceWorkerSubscription`).
 */
let postsStarted = 0;

/**
 * The one place that posts a subscription. The body always carries the two
 * preferences as they are when it is sent: `/push/subscribe` replaces the
 * stored subscription, and with it the preferences the last one came with.
 */
async function postSubscription<T extends SubscribeBody>(
  client: Client,
  body: T,
): Promise<void> {
  postsStarted += 1;
  const epoch = subscriptionEpoch;
  const prefs = currentPushPrefs(client);
  await client.api.post("/push/subscribe", withPushPrefs(body, prefs));
  // Torn down while the request was in flight: there is nothing to keep
  if (epoch !== subscriptionEpoch) return;

  const sent = pushPrefsKey(prefs);
  posted = { client, body, prefs: sent };
  await saveNativePushPrefs(prefs);
  // A preference that changed during the request was not in that body, and
  // a re-sync asked for in the meantime may have found nothing posted yet
  if (pushPrefsKey(currentPushPrefs(client)) !== sent) void resyncPushPrefs();
}

/** The `/push/subscribe` body for a browser push subscription. */
function webPushSubscribeBody(subscription: PushSubscription): SubscribeBody {
  return {
    endpoint: subscription.endpoint,
    p256dh: arrayBufferToBase64URL(
      subscription.getKey("p256dh") || new ArrayBuffer(),
    ),
    auth: arrayBufferToBase64URL(
      subscription.getKey("auth") || new ArrayBuffer(),
    ),
  };
}

/** Whether another pass was asked for while one is running. */
let prefsResyncWanted = false;

/** The pass that is running, if any. It never rejects. */
let prefsResyncRun: Promise<void> | undefined;

/**
 * The longest sign-out and push-off wait for a re-sync that is already
 * running before they unsubscribe.
 */
const RESYNC_TEARDOWN_WAIT_MS = 2_000;

/**
 * Wait for `run` for at most `ms`. True when it settled in time. `run` never
 * rejects.
 */
async function settlesWithin(run: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([run.then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Post this device's existing subscription again with the two preferences as
 * they are now, and on Android store them natively as well.
 *
 * Nothing new is asked of any transport: no permission prompt, no token and
 * no endpoint registration. It does nothing when this page load has posted
 * no subscription for the current session, and nothing when the subscription
 * already carries these preferences, so calling it more often than needed
 * costs nothing. It never throws and never rejects.
 *
 * Everything the preferences depend on is read before the first await: Slim
 * view, the ring setting and the signed-in user. The user is not a signal,
 * so the lifecycle state and the client's `ready` are read for it, as in
 * `useSlimMode.ts`. An effect that calls this therefore runs again when any
 * of them changes.
 *
 * Calls made while a pass is running are folded into one more pass after it,
 * so two posts with different preferences never race to the server.
 */
export function resyncPushPrefs(): Promise<void> {
  try {
    if (appBound() && app) {
      app.lifecycle.state();
      const client = app.client();
      client?.ready();
      currentPushPrefs(client);
    }
  } catch (e) {
    console.error("Reading the push preferences failed", e);
  }

  prefsResyncWanted = true;
  prefsResyncRun ??= runPrefsResync();
  return prefsResyncRun;
}

/** Run passes until no call has asked for another one. */
async function runPrefsResync(): Promise<void> {
  try {
    while (prefsResyncWanted) {
      prefsResyncWanted = false;
      try {
        await repostWithCurrentPrefs();
      } catch (e) {
        console.error("Push preference re-sync failed", e);
      }
    }
  } finally {
    prefsResyncRun = undefined;
  }
}

/** One pass of `resyncPushPrefs`. */
async function repostWithCurrentPrefs(): Promise<void> {
  const target = posted;
  if (!target || app?.client() !== target.client) return;
  const prefs = currentPushPrefs(target.client);
  if (pushPrefsKey(prefs) === target.prefs) return;

  // Native first, so what the phone posts by itself carries the new choice
  // even if the request below fails
  await saveNativePushPrefs(prefs);
  if (posted !== target) return;

  if (isWebPushPlatform()) {
    await repostWebPush(target);
  } else if (pushProvider() === "unifiedpush") {
    // The registration native has stored is the current one: a new endpoint
    // can arrive, and be posted natively, without this page hearing of it
    const status = await unifiedPushStatus();
    if (
      posted !== target ||
      status === null ||
      status.acked === null ||
      status.endpoint === null ||
      status.p256dh === null ||
      status.auth === null
    ) {
      return;
    }
    await postSubscription(
      target.client,
      unifiedPushSubscribeBody({
        endpoint: status.endpoint,
        p256dh: status.p256dh,
        auth: status.auth,
      }),
    );
  } else {
    // Everything else, which is FCM and APNs: the token cannot be read again
    // without a permission prompt or a new registration, so the body posted
    // earlier is the subscription
    await postSubscription(target.client, target.body);
  }
}

/**
 * Web: post the browser's current subscription again. It is read under the
 * lock setup and teardown use, so this never posts a subscription another
 * tab is replacing, and never posts after push was turned off in this
 * browser. Nothing is subscribed here: with no subscription in the browser
 * it stops.
 */
async function repostWebPush(target: PostedSubscription) {
  const registration = await navigator.serviceWorker.getRegistration(
    import.meta.env.BASE_URL ?? undefined,
  );
  if (!registration) return;

  const repost = async () => {
    if (posted !== target) return;
    const existing = webPushTurnedOff()
      ? null
      : await registration.pushManager.getSubscription();
    if (posted !== target) return;
    if (!existing) {
      // Another tab turned push off, or the browser dropped the
      // subscription. Either way this device has none to post again.
      posted = undefined;
      return;
    }
    await postSubscription(target.client, webPushSubscribeBody(existing));
  };

  if ("locks" in navigator) {
    await navigator.locks.request("sloga-webpush", repost);
  } else {
    await repost();
  }
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
      await saveNativeSubscription(pushToken, client);
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
      await postSubscription(client, body);
      // As the FCM branch does (repeats the first call)
      await saveNativeSubscription(pushToken, client);
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
 * native Android build (FCM or UnifiedPush), not the native iOS shell (APNs),
 * not the Tauri or Electron desktop shells (no service worker there).
 */
export function isWebPushPlatform(): boolean {
  return (
    !PushTokenNative &&
    !IS_IOS_NATIVE &&
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
 * Register with APNs and resolve the device token.
 *
 * `register()` does not return the token — it arrives asynchronously on the
 * `registration` listener. Racing that against a timeout matters because the
 * two ways this is normally broken (an AppDelegate that never forwards
 * `didRegisterForRemoteNotificationsWithDeviceToken`, or a build signed
 * without the aps-environment entitlement) both present as neither event ever
 * firing. Without the timeout that is an unresolved promise, so the settings
 * toggle spins forever instead of reporting a failure.
 */
async function registerForApns(): Promise<string> {
  const { PushNotifications } = await import("@capacitor/push-notifications");

  let status = await PushNotifications.checkPermissions();
  if (
    status.receive === "prompt" ||
    status.receive === "prompt-with-rationale"
  ) {
    status = await PushNotifications.requestPermissions();
  }
  if (status.receive !== "granted") {
    throw "Notification permission was not granted";
  }

  let onToken!: (value: string) => void;
  let onError!: (reason: unknown) => void;
  const token = new Promise<string>((resolve, reject) => {
    onToken = resolve;
    onError = reject;
  });

  // Listener handles are kept so only these two are removed on the way out —
  // removeAllListeners() would also drop any tap handler registered elsewhere.
  const handles = await Promise.all([
    PushNotifications.addListener("registration", (t) => onToken(t.value)),
    PushNotifications.addListener("registrationError", (e) => onError(e.error)),
  ]);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject("Timed out waiting for an APNs device token"),
      APNS_TOKEN_TIMEOUT,
    );
  });

  try {
    await PushNotifications.register();
    return await Promise.race([token, timeout]);
  } finally {
    clearTimeout(timer);
    await Promise.all(handles.map((h) => h.remove()));
  }
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

  // Native iOS app: WKWebView has no service worker and no FCM — register
  // with APNs and hand that device token to the same endpoint. `endpoint`
  // is what pushd routes on, so "apn" is load-bearing, not a label.
  // Ignores gate, which is web only.
  if (IS_IOS_NATIVE) {
    const token = await registerForApns();
    await postSubscription(client, {
      endpoint: "apn",
      p256dh: "",
      auth: token,
    });
    return;
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
    await postSubscription(client, {
      endpoint: "fcm",
      p256dh: "",
      auth: token,
    });
    // Persist the API base + session token so the gms SlogaMessagingService
    // can re-subscribe through PushResubscriber if FCM rotates the token
    // while the app is killed (onNewToken), instead of waiting for the next
    // app launch.
    await saveNativeSubscription(PushTokenNative, client);
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
    const swUrl = import.meta.env.DEV
      ? "/dev-sw.js?dev-sw"
      : "/serviceWorker.js";
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
    await postSubscription(client, webPushSubscribeBody(subscription));

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
  // The subscription is going, so there is nothing left to post again. A
  // preference re-post already on its way has to land before the unsubscribe
  // below, or it would subscribe this session again right after it. It gets
  // RESYNC_TEARDOWN_WAIT_MS: a request that hangs must not hold up sign-out
  // or push-off. One still out by then is undone once it settles.
  forgetSubscription();
  const started = postsStarted;
  const resync = prefsResyncRun;
  if (resync && !(await settlesWithin(resync, RESYNC_TEARDOWN_WAIT_MS))) {
    void resync.then(() =>
      unsubscribeAfterLateRepost(client, started, loggingOut),
    );
  }

  if (IS_IOS_NATIVE) {
    const { PushNotifications } = await import("@capacitor/push-notifications");
    // Best-effort: a failed unregister must not strand the caller in a state
    // where the server still believes this session is subscribed.
    await PushNotifications.unregister().catch(console.error);
    if (!loggingOut) await client.api.post("/push/unsubscribe");
    return;
  }

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

/**
 * Sign-out or push-off stopped waiting for a re-sync whose request was still
 * out. That request may have reached the server after the unsubscribe and
 * subscribed this session again, so once the re-sync has settled the
 * unsubscribe is sent again.
 *
 * Not when a post was started after the teardown (`started` is the count it
 * saw): push was turned back on, and that subscription is wanted. Not in a
 * browser with the lock manager either: there the re-post holds the lock the
 * unsubscribe waits for, so it always lands first.
 */
async function unsubscribeAfterLateRepost(
  client: Client,
  started: number,
  loggingOut?: boolean,
) {
  if (loggingOut || postsStarted !== started) return;
  if (isWebPushPlatform() && "locks" in navigator) return;
  try {
    await client.api.post("/push/unsubscribe");
  } catch (e) {
    console.error("Unsubscribing after a late push re-sync failed", e);
  }
}

/**
 * The shortest time between two looks at the contact list, and how long a
 * change waits before the list is built again.
 */
const CALL_CONTACTS_INTERVAL_MS = 5_000;

/**
 * Keeps the phone's list of callers current for one client. `sentKey` is the
 * key of the list native last took. It holds names, so it stays in memory.
 */
type CallContactsWatch = {
  client: Client;
  timer: number | undefined;
  /** When the list was last built, on the `performance.now()` clock. */
  ranAt: number;
  sentKey: string | undefined;
  stop(): void;
};

let contactsWatch: CallContactsWatch | undefined;

/** Whether a channel of this type is one a call can ring in. */
function isConversation(type: string): type is "DirectMessage" | "Group" {
  return type === "DirectMessage" || type === "Group";
}

/**
 * Android: keep the names and photos the ring notification shows in step
 * with `client`. The call push carries ids only, so the phone looks the
 * caller up in a list this hands to it (see `callContacts.ts`).
 *
 * The first list goes out once the client reports ready, which is when the
 * signed-in user and the channels and users from the server have all
 * arrived, and never before: native replaces its stored list with whatever
 * it is given, so a half-loaded one would erase good names.
 *
 * After that the client's own events decide. A conversation that is new or
 * deleted, a group whose members or name changed, a friend added or removed
 * and a changed name or photo each ask for a fresh list. A message, a
 * presence change and everything else ask for nothing, so on a busy account
 * each event costs a few comparisons and the list is rebuilt only when it
 * may really differ.
 */
function watchCallContacts(client: Client | undefined) {
  if (!PushTokenNative || !client) return;
  if (contactsWatch?.client === client) return;
  contactsWatch?.stop();

  const onReady = () => requestCallContacts(watch, true);
  const onChange = () => requestCallContacts(watch, false);
  const onUserUpdate = (user: User, previous: HydratedUser) => {
    if (
      user.displayName !== (previous.displayName ?? previous.username) ||
      user.avatar?.id !== previous.avatar?.id ||
      (user.relationship === "Friend") !== (previous.relationship === "Friend")
    ) {
      onChange();
    }
  };
  const onChannelCreate = (channel: Channel) => {
    if (isConversation(channel.type)) onChange();
  };
  const onChannelUpdate = (channel: Channel, previous: HydratedChannel) => {
    if (channel.type === "Group" && channel.name !== previous.name) onChange();
  };
  const onChannelDelete = (channel: HydratedChannel) => {
    if (isConversation(channel.channelType)) onChange();
  };

  const watch: CallContactsWatch = {
    client,
    timer: undefined,
    ranAt: -Infinity,
    sentKey: undefined,
    stop() {
      window.clearTimeout(watch.timer);
      watch.timer = undefined;
      client.off("ready", onReady);
      client.off("userUpdate", onUserUpdate);
      client.off("channelCreate", onChannelCreate);
      client.off("channelUpdate", onChannelUpdate);
      client.off("channelDelete", onChannelDelete);
      client.off("channelGroupJoin", onChange);
      client.off("channelGroupLeave", onChange);
    },
  };

  client.on("ready", onReady);
  client.on("userUpdate", onUserUpdate);
  client.on("channelCreate", onChannelCreate);
  client.on("channelUpdate", onChannelUpdate);
  client.on("channelDelete", onChannelDelete);
  client.on("channelGroupJoin", onChange);
  client.on("channelGroupLeave", onChange);
  contactsWatch = watch;

  // Already loaded when the watch starts: there is no "ready" left to wait for
  if (client.ready()) onReady();
}

/**
 * Ask for the list to be built and sent. `loaded` is for the moment the
 * client becomes ready, which builds as soon as the interval allows. A
 * change waits the whole interval first: that folds a burst into one pass,
 * and gives a person who has only just appeared time to load. Either way no
 * two passes are closer together than the interval.
 */
function requestCallContacts(watch: CallContactsWatch, loaded: boolean) {
  if (watch.timer !== undefined) {
    // The pass already waiting will see this change as well
    if (!loaded) return;
    window.clearTimeout(watch.timer);
  }

  const sinceLast = performance.now() - watch.ranAt;
  const wait = Math.max(
    loaded ? 0 : CALL_CONTACTS_INTERVAL_MS,
    CALL_CONTACTS_INTERVAL_MS - sinceLast,
  );
  watch.timer = window.setTimeout(() => {
    watch.timer = undefined;
    sendCallContacts(watch);
  }, wait);
}

/**
 * Build the list and hand it to native, unless it is the one native already
 * has. Neither the list nor its key is ever logged or written to web
 * storage, and a failure is reported without its error for the same reason.
 */
function sendCallContacts(watch: CallContactsWatch) {
  if (contactsWatch !== watch || !PushTokenNative) return;
  const client = watch.client;

  if (app?.client() !== client) {
    // The app moved to another client without a sign-out. That client gets
    // its own watch, and the names on the phone are still the user's.
    watch.stop();
    contactsWatch = undefined;
    return;
  }

  // Not loaded yet, or loading again after a reconnect: "ready" asks again
  const self = client.user;
  if (!self || !client.ready()) return;

  watch.ranAt = performance.now();
  let list: CallContacts;
  try {
    list = collectCallContacts(client, self.id);
  } catch {
    console.error("Building the call contact list failed");
    return;
  }

  const key = callContactsKey(list);
  if (key === watch.sentKey) return;
  watch.sentKey = key;
  PushTokenNative.setCallContacts(list).catch(() => {
    // Native did not take it, so the next pass has to send it again
    if (watch.sentKey === key) watch.sentKey = undefined;
    console.error("Storing the call contact list natively failed");
  });
}

/**
 * Read what `buildCallContacts` needs out of the client: every direct
 * message and group chat, open or closed, with its members and the time it
 * was last active, the user's friends, and a name and photo for each of
 * those people. Only people in a conversation or on the friends list are
 * looked up, not everyone the client has cached.
 */
function collectCallContacts(client: Client, selfId: string): CallContacts {
  const users: Record<string, { name: string; avatar?: string } | undefined> =
    Object.create(null);
  const note = (id: string) => {
    if (id === selfId || users[id] !== undefined) return;
    const user = client.users.get(id);
    if (!user) return;
    // Only a photo the person uploaded. Without one native shows the ring
    // with no photo, which needs no request for a default picture.
    users[id] = {
      name: user.displayName,
      avatar: user.avatar?.createFileURL(),
    };
  };

  const conversations: Parameters<
    typeof buildCallContacts
  >[0]["conversations"] = [];
  for (const channel of client.channels.values()) {
    const type = channel.type;
    if (!isConversation(type)) continue;
    const memberIds = [...channel.recipientIds];
    for (const id of memberIds) note(id);
    conversations.push({
      id: channel.id,
      type,
      name: type === "Group" ? channel.name : undefined,
      memberIds,
      lastActiveAt: lastActiveAt(channel),
    });
  }

  const friendIds: string[] = [];
  for (const user of client.users.values()) {
    if (user.relationship !== "Friend") continue;
    friendIds.push(user.id);
    note(user.id);
  }
  // The collection lists users in the order they arrived. Sorted, the same
  // friends always give the same list.
  friendIds.sort();

  return buildCallContacts({ selfId, conversations, friendIds, users });
}

/**
 * When a conversation was last active: its last message, or its creation.
 * Both are read out of an id, and one that cannot be read sorts as oldest.
 */
function lastActiveAt(channel: Channel): number {
  try {
    return channel.updatedAt.getTime();
  } catch {
    return Number.NaN;
  }
}

/**
 * Sign-out: stop following the client, forget the key of the last list, and
 * have native forget every stored name and photo.
 */
function dropCallContacts() {
  contactsWatch?.stop();
  contactsWatch = undefined;
  PushTokenNative?.clearCallContacts().catch(() => {
    console.error("Clearing the call contact list natively failed");
  });
}
