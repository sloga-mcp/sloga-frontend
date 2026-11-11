/**
 * What a call session may do about a roster that native refused to verify.
 *
 * Native `callState` checks the WHOLE roster and stops at the first leaf it
 * cannot accept, throwing `{ type: "mls_leaf_rejected", user_id, device_id,
 * reason }` (e2ee-core `Error::MlsLeafRejected`, `reason` a snake_case
 * `LeafRejection`). Every shell's bridge delivers that to `catch` as a plain
 * object. This module reads one such error and says which of three things it
 * is. It is PURE and dependency-free so `node --test` can load it (the same
 * rule as `mlsAdmitPolicy` / `mlsJoinRequestPolicy`).
 *
 *  - `removable` — the leaf's pin is no longer valid for that device
 *    (`identity_changed`, which native also reports for a device whose pin
 *    was revoked). Removing the leaf only shrinks the group, and once the
 *    Remove lands the roster verifies again.
 *  - `repin` — the device has no usable pin yet (`unknown_identity`,
 *    `binding_unverified`). A device-listing reconcile can repair it; it is
 *    never a reason to remove anyone.
 *  - `other` — anything else: every other reason (a credential that is
 *    malformed, grafted, mutated or names a different key), a reason this
 *    build does not know, missing or malformed ids, a leaf of OUR OWN user,
 *    and any error that is not the structured native object. The caller
 *    handles it exactly as it did before this module existed.
 *
 * `other` is the default. Only an exact match on every field reaches the other
 * two, and this function never throws.
 */

export type LeafRejectionClass =
  | { kind: "removable" | "repin"; userId: string; deviceId: string }
  | { kind: "other" };

/**
 * One segment of a device-qualified SFU identity `{user_id}:{device_id}`.
 *
 * The session names a leaf by exactly that grammar (`isDeviceQualified` in
 * `mlsRosterPolicy`), so each id must be a non-empty string that cannot change
 * the identity's shape: no `:` (which would add a segment, or forge the
 * `:screen` leg suffix), and no whitespace, control or invisible format
 * characters. Real ids are far shorter than the cap (a device id is 32 hex
 * characters, a user id a 26-character ULID); the cap only keeps an absurd
 * value out of logs and lookups.
 */
const ID_SEGMENT = /^[^\s:\p{C}]{1,64}$/u;

function isIdSegment(value: unknown): value is string {
  return typeof value === "string" && ID_SEGMENT.test(value);
}

/** Own data properties only: nothing inherited can satisfy a check. */
function own(record: object, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? (record as Record<string, unknown>)[key]
    : undefined;
}

const OTHER: LeafRejectionClass = { kind: "other" };

export function classifyLeafRejection(
  error: unknown,
  self: { userId: string; deviceId: string },
): LeafRejectionClass {
  try {
    if (typeof error !== "object" || error === null) return { ...OTHER };
    // A plain object only. The native rejection crosses every bridge as one;
    // an `Error` (or any other class instance) carrying look-alike fields is
    // not that object.
    const proto = Object.getPrototypeOf(error);
    if (proto !== Object.prototype && proto !== null) return { ...OTHER };
    if (own(error, "type") !== "mls_leaf_rejected") return { ...OTHER };

    const reason = own(error, "reason");
    const kind =
      reason === "identity_changed"
        ? "removable"
        : reason === "unknown_identity" || reason === "binding_unverified"
          ? "repin"
          : null;
    if (kind === null) return { ...OTHER };

    const userId = own(error, "user_id");
    const deviceId = own(error, "device_id");
    if (!isIdSegment(userId) || !isIdSegment(deviceId)) return { ...OTHER };

    // Never a leaf of our own USER, whichever device it names: our own
    // device's leaf is not ours to remove, and a sibling device of ours is
    // handled by the Delivery Service's sibling rules, not by this path. If
    // our own user id is not a valid id we cannot prove the leaf is not
    // ours, so nothing is classified.
    if (!isIdSegment(self.userId) || userId === self.userId) {
      return { ...OTHER };
    }

    return { kind, userId, deviceId };
  } catch {
    // A throwing getter or proxy trap: not the native object, and this
    // classifier must never turn a caught error into a new one.
    return { ...OTHER };
  }
}
