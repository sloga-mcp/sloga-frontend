/**
 * Pure decisions for including a member in an ENCRYPTED group chat
 * (`E2EEBridge.groupIncludePreflight` / `addGroupMemberEncrypted` in
 * `e2ee.ts`), dependency-free so `node --test` can load it.
 *
 * The native core (`e2ee-core/src/session.rs` `add_group_member`) is the
 * enforcement; these checks refuse BEFORE the server add, so a group the
 * native layer would reject never gains a member it cannot encrypt to. Both
 * caps sit one step tighter than native on purpose (see each constant).
 */

/** Native `MAX_E2EE_GROUP_MEMBERS` (`session.rs`). */
export const MAX_E2EE_GROUP_MEMBERS = 24;

/**
 * Refuse when the active roster (self included) already holds this many.
 * Native refuses `active + 1 > 24`. A Retry runs after native has made the
 * new member active, so it counts them too: at 23 the first attempt would
 * pass and every Retry would fail, which is why 23 refuses up front.
 */
export const INCLUDE_MEMBER_REFUSE_AT = MAX_E2EE_GROUP_MEMBERS - 1;

/** Native `MAX_ENVELOPES_PER_REQUEST` (`session.rs`, mirrors delta). */
export const MAX_ENVELOPES_PER_REQUEST = 128;

/** Refuse when the estimated fan-out exceeds this many envelopes. */
export const INCLUDE_ENVELOPE_LIMIT = MAX_ENVELOPES_PER_REQUEST - 1;

/**
 * Native error `type` tags (serde `tag = "type"`, snake_case, on the
 * `e2ee-core` `Error` enum) that a Retry cannot fix: the group is over a
 * cap, the member has no device we may encrypt to, or a pinned identity
 * changed and needs the user's review.
 */
export const TERMINAL_INCLUDE_ERROR_TYPES: readonly string[] = [
  "fan_out_too_large",
  "no_usable_devices",
  "peer_identity_changed",
];

/** A native `GroupState` roster row, as far as these checks read it. */
export interface IncludeMemberRow {
  user_id: string;
  status: string;
}

/** A native `DeviceState`, as far as these checks read it. */
export interface IncludeDeviceRow {
  status: string;
}

/** The native `GroupState` fields that decide whether a group is encrypted. */
export interface IncludeGroupState {
  encrypted_since: number | null;
  downgraded_at: number | null;
  peer_downgraded_by: string | null;
  pending_downgrade: boolean;
}

/**
 * True only for an established, sticky-encrypted group with no downgrade in
 * any state (own, peer-initiated, or awaiting delivery confirmation).
 */
export function groupStateIncludable(state: IncludeGroupState): boolean {
  return (
    state.encrypted_since != null &&
    state.downgraded_at == null &&
    state.peer_downgraded_by == null &&
    !state.pending_downgrade
  );
}

/**
 * The members both caps count: ACTIVE roster rows, self included (native
 * counts self's row), never `userId`. On a Retry they are already active,
 * and counting them would refuse the very Retry the cap is sized to allow;
 * the envelope estimate counts them from their fresh bundle instead.
 */
export function includeCountedMembers(
  members: readonly IncludeMemberRow[],
  userId: string,
): string[] {
  return members
    .filter((m) => m.status === "active" && m.user_id !== userId)
    .map((m) => m.user_id);
}

/** How many members the cap counts (see `includeCountedMembers`). */
export function includeActiveCount(
  members: readonly IncludeMemberRow[],
  userId: string,
): number {
  return includeCountedMembers(members, userId).length;
}

/** True when adding one more member must be refused (see the constant). */
export function includeOverMemberCap(
  members: readonly IncludeMemberRow[],
  userId: string,
): boolean {
  return includeActiveCount(members, userId) >= INCLUDE_MEMBER_REFUSE_AT;
}

/** Devices native would still encrypt to: pinned and `active`. */
export function activeDeviceCount(
  devices: readonly IncludeDeviceRow[],
): number {
  return devices.filter((d) => d.status === "active").length;
}

/** True when any pinned device presented a changed identity. */
export function hasIdentityChanged(
  devices: readonly IncludeDeviceRow[],
): boolean {
  return devices.some((d) => d.status === "identity_changed");
}

/**
 * Upper-bound envelope count for the include fan-out: every active device of
 * every counted member plus every device in the new member's bundle.
 */
export function includeEnvelopeEstimate(
  memberDeviceCounts: readonly number[],
  newMemberDevices: number,
): number {
  return memberDeviceCounts.reduce((sum, n) => sum + n, newMemberDevices);
}

/** True when the estimate must be refused (see the constant). */
export function includeOverEnvelopeCap(estimate: number): boolean {
  return estimate > INCLUDE_ENVELOPE_LIMIT;
}

/**
 * Verdict on a fetched `GET /e2ee/keys/{userId}` bundle: no devices means
 * they never turned encryption on; a bundle for anyone else, or a malformed
 * one, is the server misbehaving.
 */
export function classifyIncludeBundle(
  bundle: unknown,
  userId: string,
): "ok" | "no_keys" | "unavailable" {
  const shape = bundle as { user_id?: unknown; devices?: unknown } | null;
  if (!shape || typeof shape !== "object") return "unavailable";
  if (shape.user_id !== userId) return "unavailable";
  if (!Array.isArray(shape.devices)) return "unavailable";
  return shape.devices.length ? "ok" : "no_keys";
}

/**
 * A failed bundle fetch: a 404 means no keys were ever published; anything
 * else (offline, 5xx, rate limit) is retryable. Reads `#api`'s error text
 * (`E2EE API GET <path> failed: <status>`), the house test for a 404.
 */
export function classifyBundleFetchError(
  error: unknown,
): "no_keys" | "unavailable" {
  try {
    const message = (error as { message?: unknown } | null)?.message;
    return typeof message === "string" && /failed: 404$/.test(message)
      ? "no_keys"
      : "unavailable";
  } catch {
    return "unavailable";
  }
}

/**
 * True when an include failure is one a Retry cannot fix. Reads the native
 * `type` tag, which `addGroupMemberEncrypted` keeps on the errors it wraps.
 */
export function isTerminalIncludeError(error: unknown): boolean {
  try {
    const type = (error as { type?: unknown } | null)?.type;
    return (
      typeof type === "string" && TERMINAL_INCLUDE_ERROR_TYPES.includes(type)
    );
  } catch {
    // a throwing getter is not evidence of a terminal failure
    return false;
  }
}

/** The `type` tag of `IncludeInFlightError`; never a native tag. */
export const INCLUDE_IN_FLIGHT = "include_in_flight";

/**
 * Thrown when an include for the same group and member is already running.
 * Nothing was attempted, so it is NOT terminal: the running include decides
 * the outcome, and a Retry after it settles is safe.
 */
export class IncludeInFlightError extends Error {
  readonly type = INCLUDE_IN_FLIGHT;

  constructor() {
    super("This person is already being included in this group chat.");
    this.name = "IncludeInFlightError";
  }
}

/** True for the refusal `claimIncludeFlight` throws. */
export function isIncludeInFlightError(error: unknown): boolean {
  try {
    return (
      error instanceof IncludeInFlightError ||
      (error as { type?: unknown } | null)?.type === INCLUDE_IN_FLIGHT
    );
  } catch {
    return false;
  }
}

/**
 * Single-flight claim for one include, keyed by group and member. Throws
 * `IncludeInFlightError` synchronously when that pair is already claimed,
 * so the caller must claim before its first await. Returns the release,
 * which the caller runs in a `finally`; a repeat release is a no-op, so it
 * can never free a later claim on the same pair.
 */
export function claimIncludeFlight(
  inFlight: Set<string>,
  conversationId: string,
  userId: string,
): () => void {
  const key = `${conversationId}:${userId}`;
  if (inFlight.has(key)) throw new IncludeInFlightError();
  inFlight.add(key);
  let held = true;
  return () => {
    if (held) {
      held = false;
      inFlight.delete(key);
    }
  };
}

/**
 * True when the POST queued nothing for the new member: no receipt addressed
 * to `userId` has status `Queued` (delta `E2EEDeliveryReceipt`, its status
 * tag flattened in). `UnknownDevice` and `QueueFull` both mean the envelope
 * was dropped, so an all-QueueFull answer is as undelivered as an
 * all-UnknownDevice one, as are no receipt for them and receipts that are
 * not an array. The member is then active in our roster but never received
 * the group, so the caller must offer a Retry.
 */
export function newMemberUndelivered(
  receipts: unknown,
  userId: string,
): boolean {
  if (!Array.isArray(receipts)) return true;
  return !receipts.some((r) => {
    const receipt = r as { recipient_user_id?: unknown; status?: unknown };
    return (
      receipt?.recipient_user_id === userId && receipt?.status === "Queued"
    );
  });
}
