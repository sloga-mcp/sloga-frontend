/**
 * Protected channels (S4): what a message row of a protected or pinned
 * channel renders as (design 9.5 "Row policy", S4-D16, S4-PA-1).
 *
 * A row written before the channel was protected has no `encrypted`, and
 * may show as an ordinary message above the permanent divider. Everything
 * that decides so comes from the natively VERIFIED seat list
 * (`TextChannelState`: `history_boundary`, `pre_history`,
 * `history_time_limit`) and the local pin, never from the server's
 * `protected_history`. Whatever is unknown, malformed or not yet verified
 * is "checking" or red, never an ordinary message.
 *
 * No copy here: the functions return kinds and ids, and the components map
 * them to their own lingui strings.
 *
 * Pure: type imports only (no Solid / SDK / bridge runtime), loadable by
 * `node --test` (`protectedRowPolicy.test.ts`).
 */
import type { TextChannelState, TextVerdict } from "./protectedTextTypes";

/** What the row policy reads about one row and its channel. */
export interface RowPolicyInput {
  /** Whether the row carries `encrypted`. */
  hasEncrypted: boolean;
  /** Message id (a ULID). */
  id: string;
  /** The local pin's history record; null when the pin holds none. */
  pin: { boundary: string; wiped: boolean } | null;
  /** From `nativeHistoryInput`; null while the native state is not loaded. */
  native: {
    /** The values below come from a list native verified. */
    verified: boolean;
    /** `history_boundary` */
    boundary: string | null;
    /** `pre_history` */
    preHistory: "kept" | "wiped" | null;
    /** `history_time_limit`, ms */
    timeLimit: number | null;
  } | null;
}

/** The four arms of design 9.5, in match order. */
export type RowPolicyResult =
  /**
   * Arm 1: render the decrypt result. `belowBoundary` adds the note that
   * the row sits among the earlier, unprotected messages.
   */
  | { kind: "decrypt"; belowBoundary: boolean }
  /** Arm 2: a placeholder until the native state is loaded and verified. */
  | { kind: "checking" }
  /** Arm 3: an ordinary unencrypted message above the divider. */
  | { kind: "plain" }
  /** Arm 4: the red "unencrypted message in a protected channel" marker. */
  | { kind: "red" };

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_LENGTH = 26;
const ULID_TIME_LENGTH = 10;

/**
 * Millisecond timestamp of a ULID: 26 upper-case Crockford characters, the
 * first ten being the time. Anything else (another length, a lower-case or
 * excluded letter, a time above 48 bits, a non-string) is `null`. The same
 * rule as stoat.js `ulidTimeMs` (`src/lib/protectedHistory.ts`), repeated
 * here because this module imports no SDK runtime; the spec compares both.
 */
export function ulidTimeMs(id: string): number | null {
  if (typeof id !== "string" || id.length !== ULID_LENGTH) return null;

  let time = 0;
  for (let i = 0; i < ULID_LENGTH; i++) {
    const digit = CROCKFORD.indexOf(id[i]);
    if (digit === -1) return null;
    if (i < ULID_TIME_LENGTH) time = time * 32 + digit;
  }

  // Ten characters hold 50 bits; a ULID time is 48
  if (id[0] > "7") return null;
  return time;
}

/** A well-formed ULID. Only such ids are ever compared with a boundary. */
function isUlid(id: unknown): id is string {
  return typeof id === "string" && ulidTimeMs(id) !== null;
}

/**
 * `id` is at or below `boundary` (a well-formed ULID). ULIDs are 26 ASCII
 * characters, so the string order is their byte order. A malformed id is
 * never at or below anything.
 */
function atOrBelow(id: string, boundary: string): boolean {
  return isUlid(id) && id <= boundary;
}

/** A usable `history_time_limit`: a safe non-negative integer of ms. */
function isTimeLimit(limit: number | null): limit is number {
  return Number.isSafeInteger(limit) && (limit as number) >= 0;
}

/**
 * The policy for one row of a protected or pinned channel; the first
 * matching arm wins (design 9.5).
 */
export function rowPolicy(i: RowPolicyInput): RowPolicyResult {
  const native = i.native;
  const verified = native !== null && native.verified === true;
  const boundary =
    native !== null && isUlid(native.boundary) ? native.boundary : null;

  // Arm 1. Only a row known to carry no `encrypted` can go further down.
  if (i.hasEncrypted !== false) {
    return {
      kind: "decrypt",
      belowBoundary: verified && boundary !== null && atOrBelow(i.id, boundary),
    };
  }

  // Arm 2. Nothing is known yet: neither a red flash nor a normal message.
  if (!verified) return { kind: "checking" };

  // Arm 3. Each clause is needed; a row that misses any one is red.
  const time = ulidTimeMs(i.id);
  if (
    time !== null &&
    boundary !== null &&
    atOrBelow(i.id, boundary) &&
    native.preHistory === "kept" &&
    // the pin's own record, when it holds one, has to agree
    (i.pin === null || i.pin.wiped === false) &&
    (i.pin === null || i.pin.boundary === boundary) &&
    // S4-PA-1: a time after the limit is red whatever the boundary says
    isTimeLimit(native.timeLimit) &&
    time <= native.timeLimit
  ) {
    return { kind: "plain" };
  }

  // Arm 4.
  return { kind: "red" };
}

/**
 * Whether a verdict leaves the held list usable for the history values.
 * Only `owner_changed` does not: the list on hand is then signed by a
 * signer the user has not accepted. A verdict this record does not know
 * (a newer shell) is not usable either.
 */
const VERDICT_KEEPS_LIST: Record<TextVerdict, boolean> = {
  ok: true,
  no_group: true,
  joining: true,
  not_seated: true,
  no_seat_list: true,
  roster_mismatch: true,
  owner_changed: false,
  poisoned: true,
};

/**
 * The `native` input of `rowPolicy` from the manager's view of a channel.
 * `verified` is true only when the state is loaded, holds a list, the
 * verdict is not `owner_changed` and the last list verify did not fail.
 * Null while the state is not loaded.
 */
export function nativeHistoryInput(
  n: TextChannelState | null,
  errors: { seatListError: string | null },
): RowPolicyInput["native"] {
  if (n === null || typeof n !== "object") return null;

  const verified =
    typeof n.seat_list === "object" &&
    n.seat_list !== null &&
    VERDICT_KEEPS_LIST[n.verdict] === true &&
    errors.seatListError === null;

  return {
    verified,
    boundary:
      typeof n.history_boundary === "string" ? n.history_boundary : null,
    preHistory:
      n.pre_history === "kept" || n.pre_history === "wiped"
        ? n.pre_history
        : null,
    timeLimit:
      typeof n.history_time_limit === "number" ? n.history_time_limit : null,
  };
}

/**
 * Where the permanent divider goes: the id of the newest row at or below
 * `boundary` among the given ids (the divider renders directly below that
 * row), or null when no row is. Malformed ids are skipped, and a malformed
 * boundary has no divider.
 */
export function dividerAfter(
  idsOldestFirst: readonly string[],
  boundary: string,
): string | null {
  if (!isUlid(boundary)) return null;

  let newest: string | null = null;
  for (const id of idsOldestFirst) {
    if (!atOrBelow(id, boundary)) continue;
    if (newest === null || id > newest) newest = id;
  }

  return newest;
}
