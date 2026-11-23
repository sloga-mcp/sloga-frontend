// Policy for the app lock on phones: how a native payload is read, which
// gate view is drawn, when the unlock prompt opens by itself, and what a
// sign out or a boot without a session does. Pure, with no imports, so the
// plugin wrapper and the gate get the same answer and `node --test` can load
// it (appLockPolicy.test.ts).
//
// Fail closed. A payload that cannot be read is treated as locked, and
// nothing here reads `locked` as false unless the payload says exactly that.

/** Why a native app lock call was rejected. */
export type AppLockCode = "NO_DEVICE_LOCK" | "CANCELLED" | "LOCKED" | "FAILED";

/** Seconds in the background before the app locks. */
export type AppLockTimeout = 0 | 60 | 900;

/** The native app lock state, as `getState()` reports it. */
export type AppLockSnapshot = {
  enabled: boolean;
  locked: boolean;
  timeoutSec: AppLockTimeout;
  hideNotificationText: boolean;
  deviceSecure: boolean;
  autoDisabled: boolean;
};

/** What is assumed when the native state cannot be read: locked. */
export const FAIL_CLOSED: AppLockSnapshot = Object.freeze({
  enabled: true,
  locked: true,
  timeoutSec: 0,
  hideNotificationText: false,
  deviceSecure: true,
  autoDisabled: false,
});

/** The state where there is no app lock at all (not a phone). */
export const ABSENT: AppLockSnapshot = Object.freeze({
  enabled: false,
  locked: false,
  timeoutSec: 0,
  hideNotificationText: false,
  deviceSecure: false,
  autoDisabled: false,
});

/**
 * Read a native state payload.
 *
 * Anything that is not an object, or whose `locked` or `enabled` is not a
 * boolean, reads as `FAIL_CLOSED`. So `locked` comes out false only when the
 * payload holds exactly `false`. A `timeoutSec` that is not 0, 60 or 900
 * becomes 0, the strictest. The other three flags are true only when exactly
 * `true`.
 *
 * @param raw Whatever the plugin resolved with
 * @returns The snapshot, or `FAIL_CLOSED`
 */
export function readSnapshot(raw: unknown): AppLockSnapshot {
  if (typeof raw !== "object" || raw === null) return FAIL_CLOSED;

  const flags = raw as Record<string, unknown>;
  const { enabled, locked, timeoutSec } = flags;

  if (typeof locked !== "boolean" || typeof enabled !== "boolean") {
    return FAIL_CLOSED;
  }

  return {
    enabled,
    locked,
    timeoutSec: timeoutSec === 60 || timeoutSec === 900 ? timeoutSec : 0,
    hideNotificationText: flags.hideNotificationText === true,
    deviceSecure: flags.deviceSecure === true,
    autoDisabled: flags.autoDisabled === true,
  };
}

const CODES: readonly AppLockCode[] = [
  "NO_DEVICE_LOCK",
  "CANCELLED",
  "LOCKED",
  "FAILED",
];

function asCode(value: unknown): AppLockCode | undefined {
  return CODES.find((code) => code === value);
}

/**
 * Read the reason out of a rejected native call: `.code` first, then
 * `.message`. A bare string that is itself a code is taken as that code,
 * since the wrapper rejects with one. Anything unknown, Capacitor's
 * `UNIMPLEMENTED` included, is `FAILED`.
 *
 * @param error Whatever the call rejected with
 * @returns The code, `FAILED` when there is none to read
 */
export function readCode(error: unknown): AppLockCode {
  if (typeof error === "string") return asCode(error) ?? "FAILED";
  if (typeof error !== "object" || error === null) return "FAILED";

  const { code, message } = error as Record<string, unknown>;
  return asCode(code) ?? asCode(message) ?? "FAILED";
}

/** What the gate draws over the app. */
export type GateView = "none" | "boot" | "lock" | "ending";

/**
 * Which gate view to draw. The order of the rules matters: a sign out in
 * progress wins over everything on a phone, and a locked app with no session
 * shows no gate, so the sign-in page can be used.
 *
 * @param i Whether this is a phone, and the lock and session state
 * @returns The view
 */
export function gateView(i: {
  phone: boolean;
  ready: boolean;
  locked: boolean;
  hasSession: boolean;
  ending: boolean;
}): GateView {
  if (!i.phone) return "none";
  if (i.ending) return "ending";
  if (!i.ready) return "boot";
  if (i.locked && i.hasSession) return "lock";
  return "none";
}

/**
 * Whether the unlock prompt should open by itself: only on the lock view,
 * while the page is visible, and once per epoch.
 *
 * @param i The view, page visibility, and the last prompted and current epoch
 * @returns Whether to prompt now
 */
export function shouldAutoPrompt(i: {
  view: GateView;
  visible: boolean;
  promptedEpoch: number;
  epoch: number;
}): boolean {
  return i.view === "lock" && i.visible && i.promptedEpoch !== i.epoch;
}

/**
 * What to do once a session has ended. Off phones, nothing. On a phone the
 * native lock is always reset, and the page reloads only if the sign out
 * came from the lock screen.
 *
 * @param i Whether this is a phone, and whether the app was locked
 * @returns Whether to reset the native lock, and whether to reload
 */
export function sessionEndPlan(i: { phone: boolean; wasLocked: boolean }): {
  reset: boolean;
  reload: boolean;
} {
  if (!i.phone) return { reset: false, reload: false };
  return { reset: true, reload: i.wasLocked };
}

/**
 * What to do at boot when the native lock is on but nobody is signed in.
 * Only a state the plugin really reported counts, so a failed read never
 * resets anything.
 *
 * @param i Whether the first read settled and worked, and what it found
 * @returns `reset-reload` to clear the native lock, otherwise `none`
 */
export function bootReconcile(i: {
  ready: boolean;
  pluginOk: boolean;
  enabled: boolean;
  hasSession: boolean;
}): "none" | "reset-reload" {
  return i.ready && i.pluginOk && i.enabled && !i.hasSession
    ? "reset-reload"
    : "none";
}
