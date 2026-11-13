/**
 * Protected channels: pure rules for the owner seat UI (S2-D39 / D40 and
 * the F3 discard), shared by the seat picker modal
 * (`modal/modals/ProtectedSeatPicker.tsx`), the seat list and the channel
 * settings page.
 *
 * No copy here: the functions return kinds, ids and numbers, and each
 * component maps them to its own lingui strings. Ids are returned for
 * comparison and name lookup only, never for display.
 *
 * Pure: no Solid / SDK / lingui runtime imports, loadable by `node --test`
 * (`protectedSeatUiPolicy.test.ts`).
 */
import type { SeatReleaseCause as WireReleaseCause } from "./protectedTextTypes";

// ---------------------------------------------------------------------------
// Released seats (`GET .../seats` `cooling[]`)
// ---------------------------------------------------------------------------

/** S2: why a seat was released (`cooling[].cause`, owner reads only). */
export type SeatReleaseCause = WireReleaseCause;

/** Every release cause the wire defines, in design 2.3 order. */
export const SEAT_RELEASE_CAUSES = [
  "owner_unseat",
  "server_removal",
  "access_lost",
  "device_never_joined",
] as const satisfies readonly SeatReleaseCause[];

// Compile-time pin: the list names every wire cause.
const _allCauses: [
  Exclude<SeatReleaseCause, (typeof SEAT_RELEASE_CAUSES)[number]>,
] extends [never]
  ? true
  : never = true;

/** One released seat still counted against the slot cap (`cooling[]`). */
export interface ReleasedSeat {
  userId: string;
  /** null: absent (a non-owner read) or a cause this client doesn't know. */
  cause: SeatReleaseCause | null;
  /** `cooldown_until` as sent; null when it isn't a string. */
  until: string | null;
}

/**
 * S2 D39 "Released" rows from the seat read's `cooling[]`, in server
 * order: entries without a user id are skipped, a user counts once, and an
 * unknown cause is no cause (never shown as another one).
 */
export function seatReleasedRows(cooling: unknown): ReleasedSeat[] {
  if (!Array.isArray(cooling)) return [];
  const known: readonly string[] = SEAT_RELEASE_CAUSES;
  const out: ReleasedSeat[] = [];
  for (const entry of cooling) {
    if (typeof entry !== "object" || entry === null) continue;
    const c = entry as {
      user_id?: unknown;
      cause?: unknown;
      cooldown_until?: unknown;
    };
    const id = c.user_id;
    if (typeof id !== "string" || id.length === 0) continue;
    if (out.some((r) => r.userId === id)) continue;
    const cause =
      typeof c.cause === "string" && known.includes(c.cause)
        ? (c.cause as SeatReleaseCause)
        : null;
    const until =
      typeof c.cooldown_until === "string" ? c.cooldown_until : null;
    out.push({ userId: id, cause, until });
  }
  return out;
}

/** A user-facing time for `cooldown_until`, or null when unreadable. */
export function seatUntilText(iso: string | null): string | null {
  if (iso === null || iso.length === 0) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString();
}

// ---------------------------------------------------------------------------
// The slot cap (design 2.3: seats used = active + cooling)
// ---------------------------------------------------------------------------

/**
 * S2 D39 cap clamp: the seats a list uses are its own plus every released
 * seat still cooling that it doesn't re-seat (re-seating a cooling user
 * reuses that slot). A lower bound: a seat this change releases may cool
 * as well (only once a device of its user got the keys, which a client
 * can't see); the server still checks and answers `SeatCapReached`.
 */
export function seatUsedCount(
  list: readonly string[],
  cooling: Iterable<string>,
): number {
  const all = new Set(list);
  for (const id of cooling) all.add(id);
  return all.size;
}

/**
 * Whether a change seats anyone not seated now: some selected user who is
 * neither the owner nor in `current` (the owner is always seated). A
 * change that doesn't is removal only (no growth, no native dialog).
 */
export function seatAdds(
  current: readonly string[],
  selected: ReadonlySet<string>,
  ownerId: string,
): boolean {
  const before = new Set([ownerId, ...current]);
  for (const id of selected) if (!before.has(id)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// The open Text group (`GET .../text_group`)
// ---------------------------------------------------------------------------

/**
 * S2 D39 device column: devices per user in the open Text group
 * (`text_group.members`), or null when the members aren't known (never
 * read as 0). Malformed entries are skipped; a device counts once.
 */
export function seatDeviceCounts(members: unknown): Map<string, number> | null {
  if (!Array.isArray(members)) return null;
  const seen = new Set<string>();
  const out = new Map<string, number>();
  for (const entry of members) {
    if (typeof entry !== "object" || entry === null) continue;
    const m = entry as { user_id?: unknown; device_id?: unknown };
    const user = m.user_id;
    const device = m.device_id;
    if (typeof user !== "string" || user.length === 0) continue;
    if (typeof device !== "string" || device.length === 0) continue;
    const key = `${user}\n${device}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.set(user, (out.get(user) ?? 0) + 1);
  }
  return out;
}

/** S2 D39 (design 6.3, 9.2): when a pending removal shows as waiting. */
export const REMOVAL_WAITING_MS = 10 * 60 * 1000;

/**
 * S2 D39: the users whose pending removal (`text_group.pending_removals`)
 * is at least `REMOVAL_WAITING_MS` old at `nowMs`, in server order, once
 * each. An unreadable `created_at` counts as waiting (the offered action
 * only retries the removal); a time in the future does not; a non-finite
 * `nowMs` shows nothing.
 */
export function seatRemovalsWaiting(pending: unknown, nowMs: number): string[] {
  if (!Array.isArray(pending) || !Number.isFinite(nowMs)) return [];
  const out: string[] = [];
  for (const entry of pending) {
    if (typeof entry !== "object" || entry === null) continue;
    const p = entry as { user_id?: unknown; created_at?: unknown };
    const id = p.user_id;
    if (typeof id !== "string" || id.length === 0 || out.includes(id)) {
      continue;
    }
    const since =
      typeof p.created_at === "string" ? Date.parse(p.created_at) : Number.NaN;
    if (Number.isNaN(since) || nowMs - since >= REMOVAL_WAITING_MS) {
      out.push(id);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Owner flow answers (F3 discard, D40 reason, client failures)
// ---------------------------------------------------------------------------

/** F3 `cancelPendingSeats` answers; `unknown` for anything else. */
export type SeatDiscardOutcome =
  | "discarded"
  | "none"
  | "busy"
  | "maybe_accepted"
  | "unknown";

/**
 * F3: the outcome of `cancelPendingSeats`. Anything but a well-formed
 * answer is `unknown`, which the UI must word as "maybe accepted" (never
 * as discarded).
 */
export function seatDiscardOutcome(r: unknown): SeatDiscardOutcome {
  if (typeof r !== "object" || r === null) return "unknown";
  const a = r as { discarded?: unknown; why?: unknown };
  if (a.discarded === true) return "discarded";
  if (a.discarded !== false) return "unknown";
  return a.why === "none" || a.why === "busy" || a.why === "maybe_accepted"
    ? a.why
    : "unknown";
}

/**
 * The `body` of a server `TextFlowFailure` (feed it to `reasonRefusal`);
 * undefined for anything else.
 */
export function seatFailureBody(err: unknown): unknown {
  if (typeof err !== "object" || err === null) return undefined;
  const f = err as { source?: unknown; body?: unknown };
  return f.source === "server" ? f.body : undefined;
}

/** The reason of a client `TextFlowFailure`, or null. */
export function seatClientReason(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const f = err as { source?: unknown; reason?: unknown };
  return f.source === "client" && typeof f.reason === "string"
    ? f.reason
    : null;
}

/** S2 D40: the D17 answer is the server's `RemovalReasonRequired`. */
export function seatReasonRequired(ui: unknown): boolean {
  if (typeof ui !== "object" || ui === null) return false;
  const u = ui as { kind?: unknown; notice?: unknown };
  return u.kind === "notice" && u.notice === "removal_reason_required";
}
