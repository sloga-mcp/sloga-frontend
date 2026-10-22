/**
 * Copy for a send that failed because this device's encryption key could not
 * be opened.
 *
 * The native store is sealed by a platform protector (the OS keychain /
 * keystore). When the protector cannot hand the key back, e2ee-core fails the
 * call with `{ type: "protector" }`. On iOS a locked phone has its own variant,
 * `{ type: "protector_locked" }` (`errSecInteractionNotAllowed`; the iOS
 * keychain protector is the only thing that produces it), but a locked phone
 * can also surface as plain `protector`. In both cases the store is intact:
 * nothing is lost, the key is just unreadable right now (plan D3, "Locked
 * device").
 *
 * So the only advice this copy may give is "unlock and try again". It must
 * NEVER offer to wipe, reset, turn off encryption or restore from a backup
 * (D3; EM1 MINOR 9): a user with a locked phone who follows that advice
 * destroys a healthy store. `e2eeProtectorCopy.test.ts` pins this.
 *
 * Errors cross the IPC seam as `type`-tagged plain objects (see
 * `#rethrow` in e2ee.ts), so the tag is matched only on a plain object whose
 * `type` is exactly the tag. A thrown `Error` whose message happens to be the
 * tag does not match. Pure, with no runtime imports, so `node --test` can load
 * it.
 *
 * @param error What the failed native call rejected with.
 * @param platform `Capacitor.getPlatform()`: "ios" | "android" | "web".
 * @returns The message for the send error, or null to keep the caller's
 *   existing generic text.
 */
export function protectorSendErrorCopy(
  error: unknown,
  platform: string,
): string | null {
  if (typeof error !== "object" || error === null) return null;
  // Any Error, including a subclass or one from another realm.
  if (Object.prototype.toString.call(error) === "[object Error]") return null;

  const type = (error as Record<string, unknown>).type;
  if (type === "protector_locked") {
    return "Unlock your phone, then try again. Your encryption key can't be read while it's locked. Nothing was sent.";
  }
  if (type === "protector") {
    return platform === "ios" || platform === "android"
      ? "This device's encryption key could not be opened. If your phone is locked, unlock it and try again. Nothing was sent."
      : "This device's encryption key could not be opened. If your computer is locked, unlock it and try again. Nothing was sent.";
  }
  return null;
}
