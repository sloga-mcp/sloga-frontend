/**
 * Whose device an `E2EEDeviceDelete` event removed, as far as an encrypted
 * call is concerned. PURE and dependency-free so `node --test` can load it.
 *
 *  - `own` — THIS device was removed. The call must end on it: it can no
 *    longer hold a key the group trusts.
 *  - `peer` — a device of another user was removed. If its leaf is in our call
 *    roster, the session removes it.
 *  - `ignore` — nothing for the call to do: the event is unreadable, or it
 *    arrived while this device is itself mid-change (see `inFlight`), or it
 *    names another device of our own user.
 *
 * The caller reads `own` and `inFlight` fresh at the moment the event is
 * handled, never from a value captured earlier.
 */

export type DeviceDeleteClass = "own" | "peer" | "ignore";

function isId(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

export function classifyDeviceDelete(
  event: { userId: string; deviceId: string },
  own: { userId: string; deviceId: string | null },
  inFlight: { echoWindow: boolean; restoreOrSplitOrPublish: boolean },
): DeviceDeleteClass {
  // While this device is wiping, restoring, splitting or publishing its own
  // keys, a deletion event is most likely the echo of that very change, and
  // `own.deviceId` may be about to change. Acting on it could end a call that
  // is fine. Checked FIRST: nothing below overrides it.
  if (inFlight.echoWindow || inFlight.restoreOrSplitOrPublish) return "ignore";
  if (!isId(event.userId) || !isId(event.deviceId)) return "ignore";
  // Without our own user id, own and peer cannot be told apart.
  if (!isId(own.userId)) return "ignore";

  if (event.userId === own.userId) {
    if (own.deviceId !== null && event.deviceId === own.deviceId) return "own";
    // Our own other device: not a call peer; the DS sibling rules cover it.
    return "ignore";
  }
  return "peer";
}
