/**
 * Whether the phone's lock screen is up, and asking the system to unlock it.
 *
 * Only the Android app has a lock screen this code can ask about. The answer
 * comes from the `PushToken` plugin of the Android shell. In a browser, in
 * the desktop apps and on iOS there is nothing to ask, so the device never
 * reads as locked there and the plugin is not called.
 *
 * On Android every doubt reads as locked. Answering a call from the lock
 * screen has to unlock the phone first, so a query that fails, or an answer
 * in a shape this code does not know, must never pass for an unlocked phone.
 *
 * `lockedFrom` and `unlockedFrom` hold all of that meaning and use nothing
 * from outside this file. `deviceLocked` and `ensureDeviceUnlocked` only find
 * the platform, make the plugin call and hand over what came back.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";

/** The two `PushToken` methods used here. Only the Android shell has them. */
type LockPlugin = {
  isLocked(): Promise<{ locked: boolean }>;
  ensureUnlocked(): Promise<{ unlocked: boolean }>;
};

/**
 * Whether `answer` is a plugin answer whose own `field` is exactly `value`.
 * A caught error is never an answer, whatever fields it carries, and neither
 * is an array or anything that is not an object. A field the object only
 * inherits does not count, and a field that throws when read counts as
 * missing.
 */
function answerSays(
  answer: unknown,
  field: "locked" | "unlocked",
  value: boolean,
): boolean {
  try {
    if (typeof answer !== "object" || answer === null) return false;
    if (answer instanceof Error || Array.isArray(answer)) return false;
    if (!Object.prototype.hasOwnProperty.call(answer, field)) return false;
    return (answer as Record<string, unknown>)[field] === value;
  } catch {
    return false;
  }
}

/**
 * Whether the lock screen is up, given the platform and what the plugin's
 * `isLocked()` answered or threw. Web and iOS are never locked, whatever
 * `result` is. On Android only an answer whose `locked` is exactly `false`
 * reads as not locked. An error, a missing answer, a missing field or a
 * field of another type all read as locked. Pure.
 */
export function lockedFrom(
  platform: "web" | "android" | "ios",
  result: unknown,
): boolean {
  if (platform === "web" || platform === "ios") return false;
  return !answerSays(result, "locked", false);
}

/**
 * Whether the device is unlocked after an unlock request, given the platform
 * and what the plugin's `ensureUnlocked()` answered or threw. Web and iOS are
 * always unlocked, whatever `result` is. On Android only an answer whose
 * `unlocked` is exactly `true` reads as unlocked. Pure.
 */
export function unlockedFrom(
  platform: "web" | "android" | "ios",
  result: unknown,
): boolean {
  if (platform === "web" || platform === "ios") return true;
  return answerSays(result, "unlocked", true);
}

/**
 * The platform the two questions below are asked on. A browser and the
 * desktop apps are "web". If the platform cannot be read at all it is
 * treated as Android, the one platform that is asked and where a failed
 * question reads as locked.
 */
function lockPlatform(): "web" | "android" | "ios" {
  try {
    if (!Capacitor.isNativePlatform()) return "web";
    if (Capacitor.getPlatform() === "ios") return "ios";
  } catch {
    // Falls through to the strict platform.
  }
  return "android";
}

/**
 * What a failed plugin call hands to the pure functions. A rejection is
 * always passed on as an `Error`, so a rejection that happens to carry
 * `{ locked: false }` or `{ unlocked: true }` cannot be read as an answer.
 */
function asFailure(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error("PushToken call failed");
}

/**
 * Whether the phone's lock screen is up right now. Not a native app -> false.
 * Android: asks the PushToken plugin's `isLocked()`; any failure reads as
 * locked. iOS -> false. Never rejects.
 */
export async function deviceLocked(): Promise<boolean> {
  const platform = lockPlatform();
  if (platform !== "android") return lockedFrom(platform, undefined);
  try {
    // The plugin object is used in place and never awaited or returned from
    // an async function. Capacitor answers every property read on it with a
    // function, `then` included, so awaiting it would call the native side.
    return lockedFrom(
      platform,
      await registerPlugin<LockPlugin>("PushToken").isLocked(),
    );
  } catch (error) {
    console.warn("[deviceLock] isLocked failed, reading as locked", error);
    return lockedFrom(platform, asFailure(error));
  }
}

/**
 * Ask the system to unlock. Resolves true only when the device is unlocked
 * afterwards. Not a native app or iOS -> true. Android: PushToken
 * `ensureUnlocked()`; failure -> false. Never rejects.
 *
 * There is no time limit here. The Android side waits for the user, up to a
 * minute on Android 7, and always answers, so a shorter limit in this layer
 * would report a cancelled unlock while the user is still typing a PIN.
 */
export async function ensureDeviceUnlocked(): Promise<boolean> {
  const platform = lockPlatform();
  if (platform !== "android") return unlockedFrom(platform, undefined);
  try {
    return unlockedFrom(
      platform,
      await registerPlugin<LockPlugin>("PushToken").ensureUnlocked(),
    );
  } catch (error) {
    console.warn(
      "[deviceLock] ensureUnlocked failed, reading as not unlocked",
      error,
    );
    return unlockedFrom(platform, asFailure(error));
  }
}
