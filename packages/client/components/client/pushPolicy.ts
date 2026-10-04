/**
 * Which push transport this build uses, and what the launch resync should do
 * with a UnifiedPush registration.
 *
 * Pure on purpose, and deliberately free of imports, so `node --test` can load
 * it (`pushPolicy.test.ts`). The glue that acts on these answers lives in
 * `NotificationsController.ts` (setup, resync, teardown) and
 * `NotificationsWorker.tsx` (the in-app ringtone).
 *
 * Three transports share one web bundle:
 * - `fcm`: the Play and sideload APKs, through the native PushToken plugin.
 * - `unifiedpush`: the Google-free foss APK, through whichever UnifiedPush
 *   distributor the user installed (ntfy, say). Only that flavor ships the
 *   UnifiedPush plugin, so its presence is what identifies the build.
 * - `none`: the browser and the desktop shells, which use web push or nothing
 *   and are handled by `webPushKey.ts`.
 *
 * The VAPID key is never parsed here: `webPushKey.ts` is the app's one key
 * parser, and callers pass in the 87-char marker it derives (or `null`).
 */

/** The push transport a build uses. */
export type PushProvider = "fcm" | "unifiedpush" | "none";

/**
 * Pick the push transport from what the runtime can tell us at load.
 *
 * Synchronous and static on purpose: it must not wait on the async
 * distribution channel or on any native status call, so every caller agrees
 * on the answer from the first render. The browser gets `none`; a native build
 * with the UnifiedPush plugin (only the foss flavor has it) gets
 * `unifiedpush`; every other native build keeps FCM.
 */
export function choosePushProvider(opts: {
  native: boolean;
  unifiedPushAvailable: boolean;
}): PushProvider {
  if (!opts.native) return "none";
  if (opts.unifiedPushAvailable) return "unifiedpush";
  return "fcm";
}

/**
 * Whether an incoming call should play the in-app web ringtone.
 *
 * FCM builds never do: the native layer already rings, and playing both
 * doubles the sound. The browser always does, since nothing else rings there.
 * A foss build rings natively only once a UnifiedPush registration is live;
 * without one (no distributor installed, or registration failed) the web
 * ringtone is the only thing that rings, so it plays.
 */
export function playsWebRingtone(
  provider: PushProvider,
  unifiedPushRegistered: boolean,
): boolean {
  switch (provider) {
    case "none":
      return true;
    case "fcm":
      return false;
    case "unifiedpush":
      return !unifiedPushRegistered;
  }
}

/**
 * The `/push/subscribe` body for a UnifiedPush endpoint. `kind` tells the
 * server to deliver through the distributor's endpoint rather than FCM or a
 * browser push service.
 */
export type UnifiedPushSubscription = {
  endpoint: string;
  p256dh: string;
  auth: string;
  kind: "unifiedpush";
};

/**
 * Build the `/push/subscribe` body from a distributor endpoint and its web
 * push keys.
 *
 * Copies the three fields by name, so anything else on the native result
 * never reaches the server.
 */
export function unifiedPushSubscribeBody(ep: {
  endpoint: string;
  p256dh: string;
  auth: string;
}): UnifiedPushSubscription {
  return {
    endpoint: ep.endpoint,
    p256dh: ep.p256dh,
    auth: ep.auth,
    kind: "unifiedpush",
  };
}

/**
 * What the launch resync should do with the UnifiedPush registration.
 *
 * - `not-ready`: the client is not configured yet, or the server advertised
 *   no usable VAPID key. Nothing is touched.
 * - `no-distributor`: no distributor is acknowledged and nothing is stored.
 *   Background push is simply unavailable; the settings page says why.
 * - `reconcile-unsubscribe`: the distributor is gone but an endpoint is still
 *   stored, so the server subscription is stale and must be dropped.
 * - `register`: there is no endpoint yet, or it was made with a different key
 *   than the one the server now advertises.
 * - `repost`: the stored registration is current. It is POSTed again anyway,
 *   so a subscription the server lost heals on the next launch.
 */
export type UnifiedPushAction =
  | "not-ready"
  | "no-distributor"
  | "reconcile-unsubscribe"
  | "register"
  | "repost";

/**
 * Decide the launch resync's action. The rows are checked top to bottom, and
 * the order matters:
 *
 * 1. Not configured → `not-ready`.
 * 2. No acknowledged distributor, endpoint stored → `reconcile-unsubscribe`.
 *    Checked before the key, because dropping a stale subscription needs no
 *    key and must happen even when the key is broken.
 * 3. No acknowledged distributor → `no-distributor`.
 * 4. No usable key (`vapid` is `null`) → `not-ready`.
 * 5. No endpoint, or it was made with another key → `register`.
 * 6. Otherwise → `repost`.
 *
 * `vapid` in the result is the key to register with, and is non-null ONLY for
 * `register`. Every other action returns `null`, so a caller cannot register
 * by accident with a key it was never told to use.
 */
export function planUnifiedPushRegistration(i: {
  configured: boolean;
  vapid: string | null;
  acked: string | null;
  storedVapid: string | null;
  endpoint: string | null;
}): { action: UnifiedPushAction; vapid: string | null } {
  if (!i.configured) return { action: "not-ready", vapid: null };
  if (i.acked === null && i.endpoint !== null) {
    return { action: "reconcile-unsubscribe", vapid: null };
  }
  if (i.acked === null) return { action: "no-distributor", vapid: null };
  if (i.vapid === null) return { action: "not-ready", vapid: null };
  if (i.endpoint === null || i.storedVapid !== i.vapid) {
    return { action: "register", vapid: i.vapid };
  }
  return { action: "repost", vapid: null };
}
