/**
 * Which push transport this build uses, what the launch resync should do
 * with a UnifiedPush registration, and which per-device preferences ride
 * along with a push subscription.
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
 * Whether the in-app ringtone may sound for an incoming call. False when this
 * device is set not to ring; otherwise the `playsWebRingtone` answer.
 *
 * Only a stored `false` silences the device. Any other value rings as before,
 * so a setting that failed to load cannot cost a call.
 */
export function webRingtoneAllowed(input: {
  provider: PushProvider;
  unifiedPushRegistered: boolean;
  ringCalls: boolean;
}): boolean {
  if (input.ringCalls === false) return false;
  return playsWebRingtone(input.provider, input.unifiedPushRegistered);
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
 * The per-device preferences a `/push/subscribe` body can carry.
 *
 * - `chats_only`: the server stops pushing server messages to this device.
 * - `no_ring`: this device never rings for a call.
 *
 * The only value a key can have is `true`. The server reads a missing key as
 * off, which is how a subscription from an older app already behaves, so
 * `false` is never sent.
 */
export type PushPrefs = { chats_only?: true; no_ring?: true };

/**
 * The two per-device preferences sent with every `/push/subscribe` body. A key
 * is present only when it is on. `chats_only` is sent only once the signed-in
 * user has loaded.
 *
 * `chats_only` follows Slim view, and a staff account is never in Slim view.
 * Whether the account is a staff account is known only once the user has
 * loaded, so until then the key is left out instead of guessed. `no_ring` is
 * sent only when ringing was switched off on this device.
 *
 * Each input counts only as the exact boolean that turns its key on. Anything
 * else leaves the key out, which the server reads as the default.
 */
export function pushPrefs(input: {
  slim: boolean;
  userLoaded: boolean;
  ringCalls: boolean;
}): PushPrefs {
  const prefs: PushPrefs = {};
  if (input.slim === true && input.userLoaded === true) prefs.chats_only = true;
  if (input.ringCalls === false) prefs.no_ring = true;
  return prefs;
}

/**
 * Adds the preferences to a subscribe body without touching its other fields.
 *
 * Returns a copy and leaves `body` as it was. The two preference keys in the
 * result come from `prefs` alone: a key is written only when `prefs` has it as
 * `true`, and one already on `body` is not carried over. `/push/subscribe`
 * overwrites the stored subscription, so each post has to state the
 * preferences as they are now.
 */
export function withPushPrefs<T extends object>(
  body: T,
  prefs: PushPrefs,
): T & PushPrefs {
  const out = { ...body } as T & PushPrefs;
  delete out.chats_only;
  delete out.no_ring;
  if (prefs.chats_only === true) out.chats_only = true;
  if (prefs.no_ring === true) out.no_ring = true;
  return out;
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
