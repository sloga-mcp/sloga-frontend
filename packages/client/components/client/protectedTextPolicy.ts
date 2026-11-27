/**
 * Pure policy for Protected channels (text plane), W4 lane A3.
 *
 * Every decision here is a function of its inputs: no timers, no storage, no
 * requests, no Solid / livekit / lingui. The manager (B1), the owner flows
 * (B2) and the message flows (B4) run the effects and ask this module what
 * an answer MEANS. Loadable by `node --test --conditions=browser`.
 *
 * Contents (plan 4.2 A3):
 * - Budgets: `JOIN_RETRIES`, `JOIN_RETRY_MS`, `SIGNER_LEAF_MISSING_BUDGET`,
 *   `ROSTER_MISMATCH_GRACE_MS`, `REFRESH_INTERVAL_MS`, `PUBLISH_BACKOFF`.
 * - Seat-list / protect publish (plan D7, design 4.9): `retryAfterMs`,
 *   `publishBackoffMs`, `publishStep`, `publishResolved`, `signAllowed`,
 *   `resolveProtectReadBack` (D7b).
 * - Commit outcome (plan D20, design 2.5): `classifySubmit`,
 *   `isCatchUpDesync` (M5); S2 OR-5 removal labels for `_commit_won`.
 * - Held group (S2, OR-8): `holdsCurrentGroup`.
 * - Join refusal (S2-D35 capacity, S4 protocol floor; OR-4, OR-11):
 *   `joinRefusal`.
 * - Protected send (plan D10, design 3.10 / 7.3 / 9.2): `classifySendAnswer`
 *   with the unknown-outcome rule, `confirmAfterId`.
 * - Envelope errors (design 8.4 / 9.2): `classifyTextEnvelopeError`.
 * - Protector back-off (S7 plan D9, EL-F7 / AND-F13): `isProtectorError`,
 *   `protectorBackoffMs`, `protectorGateStep`, `protectorGateAfter`.
 * - Admission stagger (plan D19): `leafStaggerMs`.
 * - Async Text join (S2-D28 / S2-D29): `joinRebroadcastDelayMs`,
 *   `welcomeFetchStep`, `ownAddedEntry`, `welcomeDue`, `welcomePending`,
 *   `joinEventResetAllowed`, `storedJoinRequests`, `admitRefusalKey`,
 *   `admitRefusedByNative`, `coalescedRefreshReason`.
 * - The 6c budget's binding (S2 final audit FXF): `leafMissingSigner`,
 *   `leafMissingApplies`, `leafMissingSpent`; a Welcome parked behind an
 *   owner change: `welcomeParkedFor`, `parkedReplay`.
 * - S2 live leg FXP: the Welcome pin retry (`pinRetryAllowed`,
 *   `pinFailureOutcome`), a refused Welcome's paced rejoin
 *   (`welcomeRefusalOf`, `refusalRetryable`, `welcomeRefusalRejoin`, the
 *   persisted `RefusalPace`) and the owner-change intent hold
 *   (`joinIntentHeldByOwnerChange`).
 * - S4 protect with history (design 4.9 "S4", R-W4-7 / 10 / 11): the
 *   `resign` / `failed` publish steps, `PROTECT_HISTORY_MAX_ATTEMPTS`,
 *   `protectLanded`, `readProtectJournal`, `protectBody`, `historySignArgs`;
 *   `parseCommitInfo` with the commit row's `created_at`.
 *
 * Fail-closed rules this module holds everywhere:
 * - An answer whose outcome is unknown (transport error, lost response, 5xx)
 *   is never read as "refused" or "absent": it is retried with the SAME
 *   bytes, or confirmed by a fetch first.
 * - A server field never makes anything more trusted; it can only make the
 *   client retry, refetch, refuse, or leave the group (wipe and rejoin).
 * - Nothing here returns plaintext or a plaintext fallback.
 *
 * Wire facts (verified against delta `origin/acutest`):
 * - An error body is `{ type: "<ErrorType>", ...fields }` (serde tag).
 * - The rate limiter's own 429 body is untagged `{ retry_after: <ms> }`
 *   (`ratelimits/src/rocket.rs`, `left_until_reset`); delta also sets the
 *   `X-RateLimit-Reset-After` header (ms) on EVERY response, which the
 *   courier hands over as `TextApiResponse.resetAfterMs`.
 * - `InSlowmode { retry_after }` is a 429 whose `retry_after` is in SECONDS.
 * - `POST /mls/groups/:id/commits`: 200 `{ result: "Won" }`, 409
 *   `{ result: "Lost", winning }`; a Text refusal 409 is
 *   `{ type: "ProtectedChannelResecuring", reason }` and is NOT a Lost.
 * - `GET /mls/groups/:id/commits?from_epoch=e`: `{ commits, current_epoch }`,
 *   ascending, starting AT `e`.
 */
import type { MlsJoinRequest, MlsMemberDevice, MlsRemovedReason } from "./e2ee";
import type {
  HistorySetting,
  PreHistorySetting,
  SeatListInput,
  SignedAuthority,
  SignedHandover,
  SignedSeatList,
  TextApiResponse,
  TextChannelState,
  TextCommitInfo,
  TextLeftReason,
  TextNativeErrorTag,
  TextRefreshReason,
  ViewErrorTag,
} from "./protectedTextTypes";

// ---------------------------------------------------------------------------
// Budgets (plan 4.2 A3, verbatim)
// ---------------------------------------------------------------------------

/**
 * Join-intent retries before `welcomeRetriesExhausted` (design 9.1 6d). S2:
 * only the "past the first retries" signal the shield reads; the joiner
 * keeps re-broadcasting (`JOIN_REBROADCAST`). Also the bound on consecutive
 * KeyPackage publish failures of one join.
 */
export const JOIN_RETRIES = 3;

/** Spacing of join-intent retries (joiners retry every 10 s). */
export const JOIN_RETRY_MS = 10_000;

/** Consecutive `signer_leaf_missing` joins before `unverified` (9.1 6c). */
export const SIGNER_LEAF_MISSING_BUDGET = 3;

/** How long a `roster_mismatch` verdict stays `resecuring` (9.1 step 6). */
export const ROSTER_MISMATCH_GRACE_MS = 60_000;

/** Refresh cadence while a protected channel is open (plan D8). */
export const REFRESH_INTERVAL_MS = 60_000;

/** Backoff for resends of unknown outcomes: 250 ms doubling to 30 s. */
export const PUBLISH_BACKOFF = { startMs: 250, capMs: 30_000 } as const;

/** Per-leaf-index admission stagger (plan D19: own leaf index x 2 s). */
export const LEAF_STAGGER_MS = 2_000;

/**
 * Ceiling on a server-stated 429 delay. A legitimate rate-limit window is
 * 10 s; slowmode can be longer, and retrying early only earns another 429.
 * The ceiling keeps a hostile or broken hint from parking a publish for
 * days and keeps every delay far below the `setTimeout` overflow (2^31 ms).
 */
export const RETRY_AFTER_MAX_MS = 15 * 60_000;

/** How far before the cid's time the confirm refetch starts (plan D10). */
export const CONFIRM_WINDOW_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Small readers (never trust a server shape)
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

function is4xx(status: number): boolean {
  return status >= 400 && status < 500;
}

function nonNegative(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

function isEpoch(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/** The serde `type` tag of an error body, or null. */
export function errorTypeOf(body: unknown): string | null {
  return isRecord(body) && typeof body.type === "string" ? body.type : null;
}

/** `ProtectedChannelResecuring.reason`, or null. */
function reasonOf(body: unknown): string | null {
  return isRecord(body) && typeof body.reason === "string" ? body.reason : null;
}

// ---------------------------------------------------------------------------
// Held group (S2 superseded verdict, OR-8)
// ---------------------------------------------------------------------------

/**
 * Whether this device holds the channel's CURRENT text group. Native keeps a
 * superseded group `active` and reports it with verdict `no_group` (S2), so
 * `state === "active"` alone is also true for a group whose successor this
 * device has not joined yet.
 */
export function holdsCurrentGroup(n: TextChannelState): boolean {
  return n.state === "active" && n.verdict !== "no_group";
}

// ---------------------------------------------------------------------------
// 429 hint and backoff
// ---------------------------------------------------------------------------

/**
 * The body's `retry_after` in milliseconds, in the unit of its error TYPE:
 * the rate limiter's untagged body is ms; `InSlowmode` is seconds. A tagged
 * body of any other type has no known unit, so it names no delay (backoff
 * applies) rather than being guessed into one.
 */
function bodyRetryAfterMs(body: unknown): number | null {
  if (!isRecord(body)) return null;
  const raw = nonNegative(body.retry_after);
  if (raw === null) return null;
  if (body.type === undefined) return raw;
  if (body.type === "InSlowmode") return raw * 1000;
  return null;
}

/**
 * The server-stated wait of a 429, in milliseconds, or null when it named
 * none (the caller then backs off). Null for any non-429.
 *
 * Sources: the `X-RateLimit-Reset-After` header (ms) and the body's
 * `retry_after` by error type. The two agree on a rate-limiter 429 (both are
 * `left_until_reset`). On an `InSlowmode` 429 the header still describes the
 * request BUCKET, not the slowmode, so the longer of the two is the honest
 * wait; taking the maximum is that rule and is equal to "header first" on
 * every rate-limiter 429. Clamped to `RETRY_AFTER_MAX_MS`.
 */
export function retryAfterMs(response: TextApiResponse): number | null {
  if (response.status !== 429) return null;
  const header = nonNegative(response.resetAfterMs);
  const body = bodyRetryAfterMs(response.body);
  if (header === null && body === null) return null;
  return Math.min(Math.max(header ?? 0, body ?? 0), RETRY_AFTER_MAX_MS);
}

/**
 * Backoff before the next try after `failures` consecutive unknown outcomes
 * (0 = the first retry): 250 ms doubling, capped at 30 s. No attempt cap.
 */
export function publishBackoffMs(failures: number): number {
  const n =
    Number.isFinite(failures) && failures > 0 ? Math.floor(failures) : 0;
  let ms: number = PUBLISH_BACKOFF.startMs;
  for (let i = 0; i < n && ms < PUBLISH_BACKOFF.capMs; i++) ms *= 2;
  return Math.min(ms, PUBLISH_BACKOFF.capMs);
}

/** The 429 wait, or the backoff when the server named none. */
function rateLimitDelayMs(response: TextApiResponse, failures: number) {
  return retryAfterMs(response) ?? publishBackoffMs(failures);
}

// ---------------------------------------------------------------------------
// Publish loop (plan D7, design 4.9)
// ---------------------------------------------------------------------------

/** Which publish: `PUT /channels/:id/protect` or `PUT .../seats`. */
export type PublishOp = "protect" | "seats";

/**
 * S4 (R-W4-11): how many owner-only geneses one protect may sign while the
 * server keeps answering `ProtectHistoryMoved` (design 4.9 "S4": at most 5
 * attempts in all, the first one included).
 */
export const PROTECT_HISTORY_MAX_ATTEMPTS = 5;

/**
 * One attempt's answer: the courier's response, or a transport failure.
 * S4: `reread` is the newest message id read again after a `resign` step
 * (`GET /channels/:id/messages?limit=1&sort=Latest`); null when the read
 * gave no id. It is only meaningful with `PublishContext.history`.
 */
export type PublishAnswer =
  | { kind: "response"; response: TextApiResponse }
  | { kind: "transport_error" }
  | { kind: "reread"; boundary: string | null };

/** S4: the genesis of a protect that carries a boundary. */
export interface ProtectHistoryContext {
  /** Which genesis of this protect the answer is for, counted from 1. */
  attempt: number;
  /** The boundary that genesis was signed with. */
  boundary: string;
}

export interface PublishContext {
  op: PublishOp;
  /** Consecutive unresolved attempts so far (backoff index). */
  failures: number;
  /**
   * S4: set only for a protect whose genesis carries a boundary. Absent,
   * every answer is classified exactly as before S4.
   */
  history?: ProtectHistoryContext;
}

/**
 * What a publish answer means.
 * - `resolved_ok`: 2xx. The publish is resolved; the owner still reads the
 *   list back and verifies it before its stored version advances (4.9).
 * - `resolved_refused`: a non-429 4xx on a seat PUT, taken at face value
 *   (the byte-identical re-PUT is the server's idempotent success, so a
 *   4xx is a genuine refusal).
 * - `read_back`: a non-429 4xx on a PROTECT. Never taken at face value
 *   (N3): resolve it with `resolveProtectReadBack`. Still unresolved.
 * - `resend`: re-send the SAME signed bytes after `delayMs`. Still
 *   unresolved; never re-sign.
 * - `resign` (S4, boundary protect only): the channel moved past the
 *   boundary and nothing landed. From a response: read the newest message
 *   id again and hand it back as a `reread` answer. From a `reread`: that
 *   id may be signed as genesis number `attempt`. Still unresolved, and
 *   every genesis signed so far stays in the journal.
 * - `failed` (S4): stop signing. `protect_busy` after the last allowed
 *   attempt, or when the boundary did not move up. Not a resolution: an
 *   earlier genesis may still be what the server holds, so read back
 *   (`protectLanded`) before the journal is cleared.
 */
export type PublishStep =
  | { kind: "resolved_ok" }
  | { kind: "resolved_refused"; status: number; type: string | null }
  | { kind: "read_back"; status: number; type: string | null }
  | {
      kind: "resend";
      delayMs: number;
      cause: "rate_limited" | "server_error" | "transport";
    }
  | { kind: "resign"; attempt: number }
  | { kind: "failed"; reason: "protect_busy" };

const PROTECT_BUSY: PublishStep = { kind: "failed", reason: "protect_busy" };

/**
 * The step after `ProtectHistoryMoved` or after the boundary was read
 * again. `next` undefined = the answer itself (no new boundary yet). A
 * count that is not a whole attempt number fails closed, so broken
 * bookkeeping can never sign without end.
 */
function resignStep(
  history: ProtectHistoryContext,
  next: string | null | undefined,
): PublishStep {
  const n = history.attempt;
  if (!Number.isSafeInteger(n) || n < 1) return PROTECT_BUSY;
  if (n >= PROTECT_HISTORY_MAX_ATTEMPTS) return PROTECT_BUSY;
  if (next !== undefined) {
    // Message ids are ULIDs, which sort as their text does. A boundary that
    // is not above the signed one means the channel did not move although
    // the server said it had: stop, never sign the same boundary again.
    const previous = history.boundary;
    if (typeof next !== "string" || !ULID_RE.test(next)) return PROTECT_BUSY;
    if (typeof previous !== "string" || !ULID_RE.test(previous)) {
      return PROTECT_BUSY;
    }
    if (next <= previous) return PROTECT_BUSY;
  }
  return { kind: "resign", attempt: n + 1 };
}

/**
 * Classify one publish answer. 2xx resolves; a 429 is retryable, NEVER a
 * resolving 4xx; 5xx, a transport error or any non-2xx/4xx status resend
 * the same bytes with backoff, with no attempt cap.
 *
 * A protect's non-429 4xx always goes to read-back: on a first attempt the
 * read-back can only answer "refused" from an honest server, so this is the
 * design's rule (a 4xx after an unresolved attempt) without having to trust
 * the caller's bookkeeping of which attempt came first.
 *
 * S4: with `ctx.history` on a protect, a 409 `ProtectHistoryMoved` is
 * `resign` or `failed` (see `PublishStep`); a 5xx, a 429 or a lost answer
 * still re-sends the SAME bytes, and any other 4xx still reads back. A
 * `reread` answer without that context is a caller defect and is `failed`.
 */
export function publishStep(
  answer: PublishAnswer,
  ctx: PublishContext,
): PublishStep {
  const history =
    ctx.op === "protect" && isRecord(ctx.history) ? ctx.history : null;
  if (answer.kind === "reread") {
    return history === null
      ? PROTECT_BUSY
      : resignStep(history, answer.boundary);
  }
  if (answer.kind === "transport_error") {
    return {
      kind: "resend",
      delayMs: publishBackoffMs(ctx.failures),
      cause: "transport",
    };
  }
  const { response } = answer;
  const { status } = response;
  if (is2xx(status)) return { kind: "resolved_ok" };
  if (status === 429) {
    return {
      kind: "resend",
      delayMs: rateLimitDelayMs(response, ctx.failures),
      cause: "rate_limited",
    };
  }
  if (is4xx(status)) {
    const type = errorTypeOf(response.body);
    if (history !== null && status === 409 && type === "ProtectHistoryMoved") {
      return resignStep(history, undefined);
    }
    return ctx.op === "protect"
      ? { kind: "read_back", status, type }
      : { kind: "resolved_refused", status, type };
  }
  return {
    kind: "resend",
    delayMs: publishBackoffMs(ctx.failures),
    cause: "server_error",
  };
}

/** Whether a publish step resolved the publish (only 2xx or a refusal). */
export function publishResolved(step: PublishStep): boolean {
  return step.kind === "resolved_ok" || step.kind === "resolved_refused";
}

/**
 * Whether `e2ee_text_seat_list_sign` may run for a channel. Refused while a
 * publish is unresolved (`publishInFlight`) AND while signed bytes of an
 * earlier publish are still stored (D7c `protected-publish:*`, e.g. after a
 * crash): those must be resolved by read-back first, or the owner could
 * sign a second body at a version the server may already hold.
 */
export function signAllowed(s: {
  publishInFlight: boolean;
  storedPublish: string | null;
}): boolean {
  return !s.publishInFlight && s.storedPublish === null;
}

// ---------------------------------------------------------------------------
// Protect read-back (plan D7b, design 4.9 / 7.2 N3)
// ---------------------------------------------------------------------------

export interface ProtectReadBackInput {
  /** Raw `GET /channels/:id`; null when it failed in transport. */
  channel: TextApiResponse | null;
  /** `GET /channels/:id/seats`; null when it failed in transport. */
  seats: TextApiResponse | null;
  /** The genesis list this device signed and is publishing. */
  genesis: SignedSeatList;
}

export type ProtectRefusalReason =
  | "unreadable"
  | "not_protected"
  | "no_list"
  | "past_genesis"
  | "different_list";

/**
 * - `landed`: the server holds THIS device's genesis at version 1 on a
 *   protected channel. Run `_seat_list_verify` on `list` (the only path to
 *   the genesis self-pin).
 * - `refused`: "This channel couldn't be protected." No self-pin, no new
 *   genesis.
 * - `retry`: a read failed transiently (transport, 5xx, 429, unparseable
 *   2xx); read back again later, never guess.
 */
export type ProtectReadBack =
  | {
      kind: "landed";
      list: SeatListInput;
      handovers: SignedHandover[];
      asOfEpoch: number | null;
      asOfGroupId: string | null;
    }
  | { kind: "refused"; reason: ProtectRefusalReason }
  | { kind: "retry" };

/** null = transient (retry); false = a definitive non-2xx; else the body. */
function readBackBody(
  r: TextApiResponse | null,
): Record<string, unknown> | false | null {
  if (r === null) return null;
  if (is2xx(r.status)) return isRecord(r.body) ? r.body : null;
  if (r.status === 429 || !is4xx(r.status)) return null;
  return false;
}

function parseHandovers(v: unknown): SignedHandover[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (h): h is SignedHandover =>
      isRecord(h) &&
      typeof h.body === "string" &&
      typeof h.signature === "string",
  );
}

/** Resolve a protect whose answer cannot be taken at face value. */
export function resolveProtectReadBack(
  input: ProtectReadBackInput,
): ProtectReadBack {
  const channel = readBackBody(input.channel);
  const seats = readBackBody(input.seats);
  if (channel === null || seats === null) return { kind: "retry" };
  if (channel === false || seats === false) {
    return { kind: "refused", reason: "unreadable" };
  }
  if (channel.protected !== true) {
    return { kind: "refused", reason: "not_protected" };
  }
  const list = seats.list;
  if (!isRecord(list)) return { kind: "refused", reason: "no_list" };
  if (typeof list.version === "number" && list.version > 1) {
    return { kind: "refused", reason: "past_genesis" };
  }
  const g = input.genesis;
  const identical =
    list.version === 1 &&
    g.version === 1 &&
    list.body === g.body &&
    list.signature === g.signature &&
    list.signer_user_id === g.signer_user_id &&
    list.signer_device_id === g.signer_device_id;
  if (!identical) return { kind: "refused", reason: "different_list" };
  return {
    kind: "landed",
    list: {
      body: g.body,
      signature: g.signature,
      signer_user_id: g.signer_user_id,
      signer_device_id: g.signer_device_id,
    },
    handovers: parseHandovers(list.handovers),
    asOfEpoch: isEpoch(seats.as_of_epoch) ? seats.as_of_epoch : null,
    asOfGroupId:
      typeof seats.as_of_group_id === "string" ? seats.as_of_group_id : null,
  };
}

// ---------------------------------------------------------------------------
// S4: protect with history (design 4.9 "S4", R-W4-10, R-W4-11)
// ---------------------------------------------------------------------------

/**
 * What the read-back of a boundary protect found (S4-RR-5). The owner keeps
 * EVERY genesis it signed in the retry loop, because a delayed earlier one
 * can land after a later one was signed.
 * - `landed`: the server's list is one of `geneses`, by the same comparison
 *   `resolveProtectReadBack` makes for one list (version 1, body, signature
 *   and both signer ids). Verify the read-back list next (the self-pin).
 * - `other`: a list is there and it is none of ours.
 * - `none`: the server holds no list.
 */
export function protectLanded(
  readBack: SignedSeatList | null,
  geneses: readonly SignedSeatList[],
): "landed" | "other" | "none" {
  if (readBack === null || readBack === undefined) return "none";
  if (!isRecord(readBack)) return "other";
  const list: Record<string, unknown> = readBack;
  const text = (v: unknown): v is string => typeof v === "string";
  for (const g of geneses) {
    if (
      list.version === 1 &&
      g.version === 1 &&
      text(g.body) &&
      list.body === g.body &&
      text(g.signature) &&
      list.signature === g.signature &&
      text(g.signer_user_id) &&
      list.signer_user_id === g.signer_user_id &&
      text(g.signer_device_id) &&
      list.signer_device_id === g.signer_device_id
    ) {
      return "landed";
    }
  }
  return "other";
}

/**
 * The write-ahead entry of a protect (D7c), S4 shape: every genesis signed
 * for this protect, oldest first, and whether the owner asked for a wipe.
 */
export type ProtectJournalV2 = {
  v: 2;
  op: "protect";
  geneses: SignedSeatList[];
  wipe: boolean;
};

function journalAuthority(v: unknown): SignedAuthority | null {
  return isRecord(v) &&
    typeof v.body === "string" &&
    typeof v.signature === "string"
    ? { body: v.body, signature: v.signature }
    : null;
}

/** One stored signed list, copied field by field; null when it is not one. */
function journalSigned(v: unknown): SignedSeatList | null {
  if (
    !isRecord(v) ||
    typeof v.version !== "number" ||
    !Number.isSafeInteger(v.version) ||
    v.version < 1 ||
    typeof v.body !== "string" ||
    typeof v.signature !== "string" ||
    typeof v.signer_user_id !== "string" ||
    typeof v.signer_device_id !== "string"
  ) {
    return null;
  }
  const signed: SignedSeatList = {
    version: v.version,
    body: v.body,
    signature: v.signature,
    signer_user_id: v.signer_user_id,
    signer_device_id: v.signer_device_id,
  };
  if (v.authority === undefined) return signed;
  const authority = journalAuthority(v.authority);
  if (authority === null) return null;
  return { ...signed, authority };
}

/**
 * Read a stored protect entry: the stored string or its parsed JSON. The
 * S2 entry `{ v: 1, op: "protect", signed }` reads as one genesis and no
 * wipe. Anything else is null and nothing throws: an entry of another op,
 * an unknown version, no genesis, one unreadable genesis (the whole entry
 * goes, never a shortened list), or a `wipe` that is not a boolean. A wipe
 * is never read out of a missing field.
 */
export function readProtectJournal(raw: unknown): ProtectJournalV2 | null {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isRecord(v) || v.op !== "protect") return null;
  if (v.v === 1) {
    const signed = journalSigned(v.signed);
    return signed === null
      ? null
      : { v: 2, op: "protect", geneses: [signed], wipe: false };
  }
  if (v.v !== 2 || typeof v.wipe !== "boolean") return null;
  if (!Array.isArray(v.geneses) || v.geneses.length === 0) return null;
  const geneses: SignedSeatList[] = [];
  for (const entry of v.geneses) {
    const signed = journalSigned(entry);
    if (signed === null) return null;
    geneses.push(signed);
  }
  return { v: 2, op: "protect", geneses, wipe: v.wipe };
}

/**
 * Whether a signed body carries the line `pre_history:wiped`. A v1 body
 * has no such line. A body with more than one `pre_history:` line is not
 * one native writes and is not read as wiped.
 */
function signedAsWiped(body: unknown): boolean {
  if (typeof body !== "string") return false;
  const lines = body.split("\n").filter((l) => l.startsWith("pre_history:"));
  return lines.length === 1 && lines[0] === "pre_history:wiped";
}

/**
 * The body of `PUT /channels/:id/protect` (`DataProtectChannel`).
 * `wipe_history` is sent only for a wipe the owner asked for AND signed.
 * The request and the signed bytes must say the same thing (4.9): asking
 * for a wipe with a list that is not signed `wiped`, or the reverse, is a
 * programmer error and throws before anything is sent.
 */
export function protectBody(
  signed: SignedSeatList,
  wipe: boolean,
): { seat_list: SignedSeatList; wipe_history?: true } {
  const wiped = signedAsWiped(signed.body);
  if (wipe !== true && wipe !== false) {
    throw new Error("protectBody: wipe must be a boolean");
  }
  if (wipe !== wiped) {
    throw new Error(
      wipe
        ? "protectBody: a wipe was asked for but the signed list is not wiped"
        : "protectBody: the signed list is wiped but no wipe was asked for",
    );
  }
  return wipe
    ? { seat_list: signed, wipe_history: true }
    : { seat_list: signed };
}

/** The five ways a seat list is signed with respect to history (S4). */
export type HistorySignOp =
  /** Any list that says nothing about history (every S2 sign). */
  | { kind: "plain" }
  /** A v2 genesis with a boundary; earlier messages stay. */
  | { kind: "genesis_kept"; boundary: string }
  /** A v2 genesis with a boundary; native asks before it signs the wipe. */
  | { kind: "genesis_wiped"; boundary: string }
  /** The next list with the `history` line changed. */
  | { kind: "set_history"; history: HistorySetting; recovery: boolean }
  /** The one-change wipe list over a held boundary. */
  | { kind: "wipe" };

/** The four S4 arguments of `e2ee_text_seat_list_sign` (always sent). */
export interface HistorySignArgs {
  history: HistorySetting | null;
  historyBoundary: string | null;
  preHistory: PreHistorySetting | null;
  /** R-W4-10: no route counts the rows, so the dialog shows no number. */
  wipeCount: null;
}

/**
 * The S4 sign arguments for one of the five sign shapes. Throws (a
 * programmer error, as native would refuse the call) for a boundary that
 * is not a message id, a `history` value that is not one of the two, and
 * `history` on a recovery list.
 */
export function historySignArgs(op: HistorySignOp): HistorySignArgs {
  const none: HistorySignArgs = {
    history: null,
    historyBoundary: null,
    preHistory: null,
    wipeCount: null,
  };
  switch (op.kind) {
    case "plain":
      return none;
    case "genesis_kept":
    case "genesis_wiped": {
      if (typeof op.boundary !== "string" || !ULID_RE.test(op.boundary)) {
        throw new Error("historySignArgs: the boundary is not a message id");
      }
      return {
        ...none,
        historyBoundary: op.boundary,
        preHistory: op.kind === "genesis_wiped" ? "wiped" : "kept",
      };
    }
    case "set_history": {
      if (op.recovery !== false) {
        throw new Error("historySignArgs: history on a recovery list");
      }
      if (op.history !== "visible" && op.history !== "hidden") {
        throw new Error("historySignArgs: unknown history value");
      }
      return { ...none, history: op.history };
    }
    case "wipe":
      return { ...none, preHistory: "wiped" };
    default: {
      const unknown: never = op;
      throw new Error(
        `historySignArgs: unknown sign shape ${String((unknown as { kind?: unknown }).kind)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Commit outcome (plan D20, design 2.5 "Commit outcome recovery")
// ---------------------------------------------------------------------------

/**
 * M5: a gap refetch from `fromEpoch` is desynced when its rows do not run
 * contiguously from exactly `fromEpoch` (the first row is later, i.e. the
 * needed commits were pruned, or a row is missing or out of order). An
 * empty answer is not a desync by itself; the caller knows whether it
 * expected rows.
 */
export function isCatchUpDesync(
  fromEpoch: number,
  rows: readonly { epoch: number }[],
): boolean {
  return rows.some((r, i) => r.epoch !== fromEpoch + i);
}

/** Why the `{group}:{epoch}` row is being fetched; passed back verbatim. */
export type RefetchPurpose =
  /** Transport error or 5xx on a submit: the outcome is unknown. */
  | { kind: "unknown_outcome" }
  /** 409 Lost naming THIS device: confirm with the stored row. */
  | { kind: "lost_self" }
  /**
   * OR-5: a plain 2xx that may have removed devices. The commit WON; the
   * stored row is read for its `removed_reasons` (a bare `Won` carries
   * none), which `_commit_won` needs and which only the DS's row decides.
   */
  | { kind: "labels" }
  /** A definitive refusal: re-fetch ONCE, it may have raced our insert. */
  | {
      kind: "after_refusal";
      status: number;
      type: string | null;
      reason: string | null;
    };

export interface SubmitContext {
  groupId: string;
  /** The epoch the staged commit creates (`{group}:{epoch}`). */
  epoch: number;
  selfUserId: string;
  selfDeviceId: string;
  /** Base64 of our staged bytes (what was POSTed). */
  ownCommitB64: string;
  /**
   * True when the answer is to a RESUBMIT (identical bytes after an unknown
   * outcome). Set it from the `asResubmit` of the `resubmit` action.
   */
  resubmit: boolean;
  /** Consecutive retries so far (backoff index). */
  failures: number;
  /**
   * OR-5: the `removed` of the submitted body. Empty: a plain 2xx is `won`
   * with no labels. Non-empty or null (unknown, e.g. a resume without the
   * stored body): a plain 2xx reads the stored row for its labels.
   */
  ownRemoved: readonly MlsMemberDevice[] | null;
}

export type SubmitAnswer =
  | { kind: "submit"; response: TextApiResponse }
  | { kind: "submit_transport_error" }
  | { kind: "refetch"; purpose: RefetchPurpose; response: TextApiResponse }
  | { kind: "refetch_transport_error"; purpose: RefetchPurpose };

/**
 * - `won`: `_commit_won(group, epoch, storedCommitB64, rejoinIntents,
 *   removedReasons)`. `storedCommitB64` is our bytes ONLY on a plain 2xx;
 *   on every refetch path it is the DS's stored string (RC NEW-5: native
 *   merges equal bytes and answers `own_commit_mismatch` for different
 *   ones). `removedReasons` (OR-5) is the stored row's validated labels on
 *   every refetch path and `[]` on a plain 2xx that removed nothing; a
 *   plain 2xx that removed devices is a `labels` refetch, never `won`.
 * - `lost`: `_commit_lost(group)`, then `then`: `process_winner` (gap
 *   refetch and process the winner), `reverify_restage` (stale_seat_list:
 *   verify `GET .../seats` with `as_of_*`, re-stage ONCE),
 *   `await_removal` (pending_removal: wait for the Remove), `refresh`,
 *   `refused` (a typed cap refusal, `COMMIT_CAP_REFUSALS`: the caller gets
 *   the refusal itself so it can show the cap notice; never retried).
 * - `refetch`: `GET /mls/groups/:id/commits?from_epoch=<epoch>` after
 *   `delayMs`, then classify with `{kind: "refetch", purpose}`.
 * - `resubmit`: after `delayMs`, `_pending_commit` and POST the IDENTICAL
 *   bytes; classify the answer with `resubmit: asResubmit`.
 * - `mark_left`: `_mark_left(group, reason)`, then the rejoin path.
 */
export type SubmitAction =
  | {
      kind: "won";
      storedCommitB64: string;
      rejoinIntents: MlsJoinRequest[];
      /** OR-5: the labels `_commit_won` gets (never defaulted). */
      removedReasons: MlsRemovedReason[];
    }
  | {
      kind: "lost";
      winner: TextCommitInfo | null;
      then:
        | "process_winner"
        | "reverify_restage"
        | "await_removal"
        | "refresh"
        | "refused";
    }
  | { kind: "refetch"; purpose: RefetchPurpose; delayMs: number }
  | { kind: "resubmit"; delayMs: number; asResubmit: boolean }
  | { kind: "mark_left"; reason: TextLeftReason };

/**
 * W2c: typed refusals of the Text commit transaction (`{ max }`) for an Add
 * past the enforced device cap or the 100-leaf cap. Server error types,
 * never native tags, so never a `groupError` and never loud.
 */
export const COMMIT_CAP_REFUSALS: readonly string[] = [
  "DeviceCapReached",
  "MlsCallFull",
];

/**
 * One stored removal label, by the router's rule (`removedReason`, mirrored
 * here, not imported): the three wire keys as verbatim strings, an unknown
 * `reason` passing (native maps it to `Unknown`); anything else is
 * malformed (null). Only the wire keys are copied (native may deny others).
 */
function removedReason(v: unknown): MlsRemovedReason | null {
  if (!isRecord(v)) return null;
  const { user_id, device_id, reason } = v;
  if (
    typeof user_id !== "string" ||
    typeof device_id !== "string" ||
    typeof reason !== "string"
  ) {
    return null;
  }
  return { user_id, device_id, reason };
}

/**
 * A row's `removed_reasons`: absent or null is `[]` (the DS omits an empty
 * vector); not an array, or any malformed element, is null.
 */
function removedReasons(v: unknown): MlsRemovedReason[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return null;
  const out: MlsRemovedReason[] = [];
  for (const e of v) {
    const label = removedReason(e);
    if (label === null) return null;
    out.push(label);
  }
  return out;
}

/** `parseCommitInfo`'s answer for a row that is one. */
export interface ParsedCommitInfo {
  row: TextCommitInfo;
  /**
   * S4 (R-W4-7): the row carried a `created_at` that is not a safe integer
   * >= 0 and `row` has none. The caller logs it loudly.
   */
  droppedCreatedAt: boolean;
}

/**
 * A stored commit row, or null when the shape is not one. Only the fields
 * read here are checked, and `removed_reasons` (OR-5): a malformed label
 * vector makes the whole row malformed. A present vector comes back as the
 * validated copy; an absent one stays absent.
 *
 * S4 (R-W4-7): `created_at` is kept only as a safe integer >= 0. Native
 * refuses the whole call on any other value, so a string, a fraction, a
 * negative or a number above 2^53 - 1 is left out of the row (the row
 * itself is still good) and reported in `droppedCreatedAt`.
 */
export function parseCommitInfo(v: unknown): ParsedCommitInfo | null {
  const row = commitRow(v);
  if (row === null) return null;
  const at: unknown = row.created_at;
  if (at === undefined || isEpoch(at)) return { row, droppedCreatedAt: false };
  const rest: TextCommitInfo = { ...row };
  delete rest.created_at;
  return { row: rest, droppedCreatedAt: true };
}

/** The row checks of `parseCommitInfo`, before the `created_at` rule. */
function commitRow(v: unknown): TextCommitInfo | null {
  if (!isRecord(v)) return null;
  const c = v.committer;
  if (
    typeof v.group_id !== "string" ||
    !isEpoch(v.epoch) ||
    typeof v.commit !== "string" ||
    !isRecord(c) ||
    typeof c.user_id !== "string" ||
    typeof c.device_id !== "string"
  ) {
    return null;
  }
  const row = v as unknown as TextCommitInfo;
  if (v.removed_reasons === undefined) return row;
  const labels = removedReasons(v.removed_reasons);
  if (labels === null) return null;
  return { ...row, removed_reasons: labels };
}

/** `ResponseFetchMlsCommits.commits`, or null when malformed. */
function parseCommitRows(body: unknown): TextCommitInfo[] | null {
  if (!isRecord(body) || !Array.isArray(body.commits)) return null;
  const rows: TextCommitInfo[] = [];
  for (const raw of body.commits) {
    const parsed = parseCommitInfo(raw);
    if (parsed === null) return null;
    rows.push(parsed.row);
  }
  return rows;
}

function isOwnCommit(row: TextCommitInfo, ctx: SubmitContext): boolean {
  return (
    row.committer.user_id === ctx.selfUserId &&
    row.committer.device_id === ctx.selfDeviceId
  );
}

function rejoinIntentsOf(row: TextCommitInfo): MlsJoinRequest[] {
  return Array.isArray(row.rejoin_intents) ? row.rejoin_intents : [];
}

const UNKNOWN_OUTCOME: RefetchPurpose = { kind: "unknown_outcome" };

/**
 * The committer rule (RC NEW-5): classify a stored row by committer only.
 * An own row is `won` with the row's labels (OR-5; `parseCommitInfo` has
 * validated them, and an absent vector is the DS's empty one).
 */
function committerRule(row: TextCommitInfo, ctx: SubmitContext): SubmitAction {
  return isOwnCommit(row, ctx)
    ? {
        kind: "won",
        storedCommitB64: row.commit,
        rejoinIntents: rejoinIntentsOf(row),
        removedReasons: row.removed_reasons ?? [],
      }
    : { kind: "lost", winner: row, then: "process_winner" };
}

function classifySubmitResponse(
  response: TextApiResponse,
  ctx: SubmitContext,
): SubmitAction {
  const { status, body } = response;
  if (is2xx(status)) {
    // OR-5: a bare `Won` carries no labels. Only a body known to remove
    // nothing has none; otherwise the stored row decides (never inferred
    // locally: the committer could diverge from the members).
    if (Array.isArray(ctx.ownRemoved) && ctx.ownRemoved.length === 0) {
      return {
        kind: "won",
        storedCommitB64: ctx.ownCommitB64,
        rejoinIntents: [],
        removedReasons: [],
      };
    }
    return { kind: "refetch", purpose: { kind: "labels" }, delayMs: 0 };
  }
  const type = errorTypeOf(body);
  if (status === 409 && isRecord(body) && body.result === "Lost") {
    const winner = parseCommitInfo(body.winning)?.row ?? null;
    if (
      winner === null ||
      winner.group_id !== ctx.groupId ||
      winner.epoch !== ctx.epoch
    ) {
      return { kind: "refetch", purpose: UNKNOWN_OUTCOME, delayMs: 0 };
    }
    if (isOwnCommit(winner, ctx)) {
      return { kind: "refetch", purpose: { kind: "lost_self" }, delayMs: 0 };
    }
    return { kind: "lost", winner, then: "process_winner" };
  }
  if (status === 429) {
    // Refused before the handler ran: nothing was decided. Same bytes.
    return {
      kind: "resubmit",
      delayMs: rateLimitDelayMs(response, ctx.failures),
      asResubmit: ctx.resubmit,
    };
  }
  if (is4xx(status)) {
    if (ctx.resubmit) {
      // Desync: the group or our access is gone since the first attempt.
      if (status === 404) return { kind: "mark_left", reason: "not_found" };
      if (type === "NotSeated" || type === "MissingPermission") {
        return { kind: "mark_left", reason: "not_member" };
      }
    }
    // Every other 4xx, including 409 ProtectedChannelResecuring (never a
    // Lost), is a definitive refusal: re-fetch ONCE first.
    return {
      kind: "refetch",
      purpose: { kind: "after_refusal", status, type, reason: reasonOf(body) },
      delayMs: 0,
    };
  }
  // 5xx or an unexpected status: unknown outcome, fetch the row FIRST.
  return { kind: "refetch", purpose: UNKNOWN_OUTCOME, delayMs: 0 };
}

function classifyRefetch(
  purpose: RefetchPurpose,
  response: TextApiResponse,
  ctx: SubmitContext,
): SubmitAction {
  const { status } = response;
  const retry: SubmitAction = {
    kind: "refetch",
    purpose,
    delayMs:
      status === 429
        ? rateLimitDelayMs(response, ctx.failures)
        : publishBackoffMs(ctx.failures),
  };
  // OR-5: a labels read follows a 2xx `Won`, so the outcome is decided: a
  // refused read is never a loss (no `_commit_lost` of a won stage) and
  // never a desync wipe (design 7.5). It is read again, like a 5xx.
  if (purpose.kind === "labels" && (status === 403 || status === 404)) {
    return retry;
  }
  // A 403/404 is a desync (wipe and rejoin) ONLY on a resubmit (D20). On a
  // first submit it never wipes local state (design 7.5: a visibility loss
  // must not wipe native state): a 404 drops the stage and refreshes, a
  // 403 is retried with backoff.
  if (status === 404) {
    return ctx.resubmit
      ? { kind: "mark_left", reason: "not_found" }
      : { kind: "lost", winner: null, then: "refresh" };
  }
  if (status === 403) {
    return ctx.resubmit ? { kind: "mark_left", reason: "not_member" } : retry;
  }
  if (!is2xx(status)) return retry; // never guess from a failed fetch
  const rows = parseCommitRows(response.body);
  if (rows === null) return retry;
  if (rows.length > 0) {
    if (
      isCatchUpDesync(ctx.epoch, rows) ||
      rows.some((r) => r.group_id !== ctx.groupId)
    ) {
      return { kind: "mark_left", reason: "catch_up_failed" };
    }
    return committerRule(rows[0], ctx);
  }
  // Absent.
  switch (purpose.kind) {
    case "unknown_outcome":
      // Absent does NOT mean lost: resubmit the identical bytes.
      return { kind: "resubmit", delayMs: 0, asResubmit: true };
    case "lost_self":
      // The DS named our row, the fetch shows none: resubmit; the
      // existing-row check answers again. Backed off: this repeats.
      return {
        kind: "resubmit",
        delayMs: publishBackoffMs(ctx.failures),
        asResubmit: true,
      };
    case "labels":
      // The commit WON (a 2xx); a missing row is a DS defect. Read again,
      // backed off: never a resubmit (the bytes already won) or a loss.
      return retry;
    case "after_refusal":
      // W4d X#5: the DS says this device holds no leaf in the group, and
      // no own row raced the refusal: native is out of step. Wipe and
      // rejoin (a refresh alone would see an active group and never join).
      if (
        purpose.type === "ProtectedChannelResecuring" &&
        purpose.reason === "not_member"
      ) {
        return { kind: "mark_left", reason: "not_member" };
      }
      // W4d (W2c): a typed cap refusal of the commit transaction. Not loud
      // and not retryable with the same Add: drop the stage, surface the
      // typed refusal (the caller's cap notice), refresh.
      if (purpose.type !== null && COMMIT_CAP_REFUSALS.includes(purpose.type)) {
        return { kind: "lost", winner: null, then: "refused" };
      }
      return {
        kind: "lost",
        winner: null,
        then:
          purpose.reason === "stale_seat_list"
            ? "reverify_restage"
            : purpose.reason === "pending_removal"
              ? "await_removal"
              : "refresh",
      };
  }
}

/** Classify one commit submit or `{group}:{epoch}` refetch answer (D20). */
export function classifySubmit(
  answer: SubmitAnswer,
  ctx: SubmitContext,
): SubmitAction {
  switch (answer.kind) {
    case "submit":
      return classifySubmitResponse(answer.response, ctx);
    case "submit_transport_error":
      return { kind: "refetch", purpose: UNKNOWN_OUTCOME, delayMs: 0 };
    case "refetch":
      return classifyRefetch(answer.purpose, answer.response, ctx);
    case "refetch_transport_error":
      return {
        kind: "refetch",
        purpose: answer.purpose,
        delayMs: publishBackoffMs(ctx.failures),
      };
  }
}

// ---------------------------------------------------------------------------
// Join refusal (S2-D35 capacity, S4 protocol floor; OR-4, OR-11)
// ---------------------------------------------------------------------------

/** Native `MAX_TEXT_LEAVES` (`mls/text/formats.rs`): the leaf ceiling. */
export const MAX_TEXT_LEAVES = 100;

/** `ProtectedChannelView.capacity.reason`. */
export type CapacityReason = "device_cap" | "group_full";

/**
 * - `capacity`: this device's join (or its Add) was refused for capacity;
 *   the manager records it in `view.capacity` (design 9.1 S2: read-only,
 *   not alarming).
 * - `outdated`: the server's protocol floor `min` is above this build's;
 *   the manager stops join/create retries until reload.
 */
export type JoinRefusal =
  | { kind: "capacity"; reason: CapacityReason }
  | { kind: "outdated"; min: number };

/** A server answer: a `TextApiResponse` or a `source: "server"` failure. */
function serverAnswerOf(a: unknown): { status: number; body: unknown } | null {
  if (!isRecord(a) || typeof a.status !== "number") return null;
  if (a.source === "server") return { status: a.status, body: a.body };
  if ("source" in a || !("body" in a)) return null;
  return { status: a.status, body: a.body };
}

/** A native error: bare, or unwrapped from a `source: "native"` failure. */
function nativeErrorBody(a: unknown): Record<string, unknown> | null {
  if (!isRecord(a)) return null;
  if (a.source === "native") return isRecord(a.error) ? a.error : null;
  if ("source" in a || "status" in a || typeof a.type !== "string") {
    return null;
  }
  return a;
}

/**
 * What this device's OWN join-intent or Add answer says about capacity or
 * the protocol floor; null for anything else (the caller's normal handling
 * applies). The ONLY producer of `capacity` (OR-11): it reads an error
 * answer, never a seats, text_group or any other server field.
 *
 * Takes a `TextApiResponse`, a `TextFlowFailure` (server or native) or a
 * bare native error. Server types are read only from a server answer at
 * the route's status; the native tag only from a native error.
 * - `DeviceCapReached { max }`, 400 (join intent, Text Add commit):
 *   `device_cap`.
 * - `MlsCallFull { max }`, 409 (the Text Add commit's 100-leaf cap):
 *   `group_full`.
 * - native `text_group_full { max }` (`_admit`): native raises it for the
 *   signed per-user device cap (`max` = that cap) AND for the leaf ceiling
 *   (`max` = 100; `lifecycle.rs` `text_admit`). A `max` below the ceiling
 *   can only be the device cap; at or above it (or unreadable) the group
 *   is over the ceiling either way: `group_full`.
 * - `ProtectedClientOutdated { min }`, 400 (S4 appendix; on no BE branch
 *   yet, OR-4): `outdated` when `min` is a safe integer >= 1, else null.
 */
export function joinRefusal(answer: unknown): JoinRefusal | null {
  const server = serverAnswerOf(answer);
  if (server !== null) {
    const { status, body } = server;
    const type = errorTypeOf(body);
    if (type === "DeviceCapReached" && status === 400) {
      return { kind: "capacity", reason: "device_cap" };
    }
    if (type === "MlsCallFull" && status === 409) {
      return { kind: "capacity", reason: "group_full" };
    }
    if (type === "ProtectedClientOutdated" && status === 400) {
      const min = isRecord(body) ? body.min : undefined;
      return typeof min === "number" && Number.isSafeInteger(min) && min >= 1
        ? { kind: "outdated", min }
        : null;
    }
    return null;
  }
  const native = nativeErrorBody(answer);
  if (native === null || native.type !== "text_group_full") return null;
  const max = native.max;
  const deviceCap =
    typeof max === "number" &&
    Number.isSafeInteger(max) &&
    max >= 1 &&
    max < MAX_TEXT_LEAVES;
  return { kind: "capacity", reason: deviceCap ? "device_cap" : "group_full" };
}

// ---------------------------------------------------------------------------
// Protected send (plan D10, design 3.10 / 7.3 / 9.2)
// ---------------------------------------------------------------------------

/** The non-2xx answer that sent a send into confirmation. */
export interface SendTrigger {
  status: number;
  type: string | null;
  reason: string | null;
  /** The 429 wait (null when none was named or not a 429). */
  retryAfterMs: number | null;
}

export interface SendContext {
  selfUserId: string;
  /** The channel the send was posted to. */
  channelId: string;
  /** The stored entry's cid (`TextEncrypted.nonce`). */
  cid: string;
  /**
   * The stored entry's `encrypted` payload, exactly as POSTed (W4d X#4). A
   * row is this send only when its channel, author, nonce AND `encrypted`
   * all match (`ownSendRowBinds`); null binds nothing.
   */
  encrypted: unknown;
  /**
   * An earlier attempt with THIS stored entry had an unknown outcome
   * (transport error, lost response, 5xx). Every orphan resolved at start
   * counts as one.
   */
  priorUnknown: boolean;
  /** The one Resecuring retry (re-encrypt under a new cid) is spent. */
  resecureRetried: boolean;
  /** Consecutive retries so far (backoff index). */
  failures: number;
}

export type SendAnswer =
  | { kind: "response"; response: TextApiResponse }
  | { kind: "transport_error" }
  /** One page of the confirm refetch (`sort=Latest`, `limit=pageLimit`). */
  | {
      kind: "confirm";
      trigger: SendTrigger;
      response: TextApiResponse;
      pageLimit: number;
    }
  | { kind: "confirm_transport_error"; trigger: SendTrigger };

/**
 * - `delivered`: delete the stored entry; adopt `raw` (`getOrCreate(row,
 *   true)` + `noteOwnMessage`). `confirmed` when it came from the refetch.
 * - `unknown`: keep the stored entry, set `priorUnknown`; a retry re-sends
 *   the SAME stored bytes after `delayMs`. Never re-encrypt.
 * - `retry_same`: a 429 (nothing was processed): re-send the SAME stored
 *   bytes after `delayMs`.
 * - `confirm`: `GET /channels/:id/messages?after=<after>&sort=Latest`
 *   (`&before=<before>` for the next page), then classify the page with
 *   `{kind: "confirm", trigger}`.
 * - `confirm_later`: the confirm fetch failed (403/404/5xx/transport/
 *   malformed): outcome still unknown, confirm again later, never "absent".
 * - `resecure_retry`: refresh, catch up / commit the pending Remove, then
 *   ONE retry: re-encrypt (new cid), replace the stored entry, send.
 * - `refused`: delete the stored entry, restore the draft, notice.
 *   `clientDefect` (ProtectedFieldRefused): Sentry, never retried.
 * - `maybe_unsent`: a DuplicateNonce whose row is not visible: never
 *   re-encrypt; notice "A message may not have been sent."
 */
export type SendAction =
  | { kind: "delivered"; raw: unknown; confirmed: boolean }
  | { kind: "unknown"; delayMs: number }
  | { kind: "retry_same"; delayMs: number }
  | {
      kind: "confirm";
      trigger: SendTrigger;
      after: string;
      before: string | null;
    }
  | { kind: "confirm_later"; trigger: SendTrigger; delayMs: number }
  | { kind: "resecure_retry"; reason: string | null }
  | {
      kind: "refused";
      status: number;
      type: string | null;
      clientDefect: boolean;
    }
  | { kind: "maybe_unsent" };

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/**
 * The `after` cursor for the confirm refetch: a ULID at the cid's time
 * minus `CONFIRM_WINDOW_MS`, random part zero. Null when `cid` is not a
 * ULID (then nothing can be confirmed).
 */
export function confirmAfterId(cid: string): string | null {
  const upper = cid.toUpperCase();
  if (!ULID_RE.test(upper)) return null;
  let ms = 0;
  for (let i = 0; i < 10; i++) ms = ms * 32 + CROCKFORD.indexOf(upper[i]);
  let t = Math.max(0, ms - CONFIRM_WINDOW_MS);
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return time + "0".repeat(16);
}

interface MessageRow {
  _id: string;
  raw: Record<string, unknown>;
}

/** A messages page: an array, or `{ messages }` (with users). */
function parseMessageRows(body: unknown): MessageRow[] | null {
  const list = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.messages)
      ? body.messages
      : null;
  if (list === null) return null;
  const rows: MessageRow[] = [];
  for (const m of list) {
    if (!isRecord(m) || typeof m._id !== "string") return null;
    rows.push({ _id: m._id, raw: m });
  }
  return rows;
}

/**
 * Structural equality of two JSON values; an object key whose value is
 * `null` or absent counts as absent (serde skips `franking: None`).
 */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => sameJson(v, b[i]))
    );
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const x = a[k] ?? null;
    const y = b[k] ?? null;
    if (!sameJson(x, y)) return false;
  }
  return true;
}

/**
 * W4d X#4: whether a server row is THIS send: an `_id`, this channel, this
 * user as author, the cid as nonce, and `encrypted` equal to the payload
 * that was POSTed. Anything less is never adopted as the own send (the
 * server could otherwise bind the stored send to any message id).
 */
export function ownSendRowBinds(raw: unknown, ctx: SendContext): boolean {
  return (
    isRecord(raw) &&
    typeof raw._id === "string" &&
    raw._id.length > 0 &&
    raw.channel === ctx.channelId &&
    raw.author === ctx.selfUserId &&
    raw.nonce === ctx.cid &&
    isRecord(ctx.encrypted) &&
    isRecord(raw.encrypted) &&
    sameJson(raw.encrypted, ctx.encrypted)
  );
}

function triggerOf(response: TextApiResponse): SendTrigger {
  return {
    status: response.status,
    type: errorTypeOf(response.body),
    reason: reasonOf(response.body),
    retryAfterMs: retryAfterMs(response),
  };
}

/**
 * A non-2xx 4xx whose attempt is KNOWN not to have landed (no earlier
 * unknown outcome, or the confirm refetch found no row).
 */
function afterKnownFailure(
  trigger: SendTrigger,
  ctx: SendContext,
  confirmed: boolean,
): SendAction {
  if (trigger.status === 429) {
    return {
      kind: "retry_same",
      delayMs: trigger.retryAfterMs ?? publishBackoffMs(ctx.failures),
    };
  }
  if (trigger.type === "DuplicateNonce") {
    // "Possibly delivered": confirm, never re-encrypt under a new cid.
    return confirmed ? { kind: "maybe_unsent" } : startConfirm(trigger, ctx);
  }
  // W4d X#5: `not_member` is never retried here: re-encrypting for a group
  // the DS says this device is not in cannot land. Refused; the manager
  // marks the group left and takes the rejoin path.
  if (
    trigger.type === "ProtectedChannelResecuring" &&
    !ctx.resecureRetried &&
    trigger.reason !== "not_member"
  ) {
    return { kind: "resecure_retry", reason: trigger.reason };
  }
  return {
    kind: "refused",
    status: trigger.status,
    type: trigger.type,
    clientDefect: trigger.type === "ProtectedFieldRefused",
  };
}

function startConfirm(trigger: SendTrigger, ctx: SendContext): SendAction {
  const after = confirmAfterId(ctx.cid);
  if (after === null) return { kind: "maybe_unsent" };
  return { kind: "confirm", trigger, after, before: null };
}

/**
 * Classify one protected-send answer or confirm page (D10).
 *
 * Unknown-outcome rule [PA#3]: after an attempt whose outcome is unknown,
 * ANY later non-2xx answer (DuplicateNonce, ProtectedChannelResecuring,
 * 429, other 4xx) first confirms by refetch. Found: delivered. Absent: the
 * attempt failed, and only then is the answer acted on.
 */
export function classifySendAnswer(
  answer: SendAnswer,
  ctx: SendContext,
): SendAction {
  switch (answer.kind) {
    case "transport_error":
      return { kind: "unknown", delayMs: publishBackoffMs(ctx.failures) };
    case "response": {
      const { response } = answer;
      if (is2xx(response.status)) {
        // A 2xx that does not bind to this send (X#4) is never "delivered":
        // the outcome is unknown, so the SAME bytes go again and the
        // DuplicateNonce answer confirms by refetch.
        return ownSendRowBinds(response.body, ctx)
          ? { kind: "delivered", raw: response.body, confirmed: false }
          : { kind: "unknown", delayMs: publishBackoffMs(ctx.failures) };
      }
      if (!is4xx(response.status)) {
        return { kind: "unknown", delayMs: publishBackoffMs(ctx.failures) };
      }
      const trigger = triggerOf(response);
      if (ctx.priorUnknown) return startConfirm(trigger, ctx);
      return afterKnownFailure(trigger, ctx, false);
    }
    case "confirm_transport_error":
      return {
        kind: "confirm_later",
        trigger: answer.trigger,
        delayMs: publishBackoffMs(ctx.failures),
      };
    case "confirm": {
      const { response, trigger } = answer;
      const later: SendAction = {
        kind: "confirm_later",
        trigger,
        delayMs: publishBackoffMs(ctx.failures),
      };
      if (!is2xx(response.status)) return later;
      const rows = parseMessageRows(response.body);
      const after = confirmAfterId(ctx.cid);
      if (rows === null || after === null) return later;
      // X#4: the same binding as a 2xx; a row with our nonce but another
      // channel, author or payload is not this send.
      const own = rows.find((m) => ownSendRowBinds(m.raw, ctx));
      if (own !== undefined) {
        return { kind: "delivered", raw: own.raw, confirmed: true };
      }
      if (answer.pageLimit > 0 && rows.length >= answer.pageLimit) {
        const oldest = rows.reduce(
          (min, m) => (m._id < min ? m._id : min),
          rows[0]._id,
        );
        if (oldest > after) {
          return { kind: "confirm", trigger, after, before: oldest };
        }
      }
      // Absent: the attempt failed. Act on the answer that triggered this.
      return afterKnownFailure(trigger, ctx, true);
    }
  }
}

// ---------------------------------------------------------------------------
// Envelope processing errors (design 8.4 / 9.2, plan D4 / D15 / D16 / D18)
// ---------------------------------------------------------------------------

/**
 * What B1 does with an envelope whose `_process` failed.
 * - `catch_up`: gap-refetch commits, reprocess; never skip ahead.
 * - `pin_identities_retry`: pin that user's listing, retry ONCE (D18).
 * - `park_owner_change`: keep the envelope parked for "Review owner
 *   change" (D15); `same_user: false` parks too (the same button shows
 *   native's inform dialog), final in S1.
 * - `rejoin`: this device is out of step (`left`); take the rejoin path.
 *   With `markLeft`, FIRST `_mark_left(group, markLeft)`: native has not
 *   moved the group to `left` itself (S2-D31 `catch_up_leaf_unresolvable`).
 * - `join`: no local group for it; enter the join flow.
 * - `signer_leaf_missing_retry`: discard the Welcome, retry the join intent
 *   (counts toward `SIGNER_LEAF_MISSING_BUDGET`).
 * - `await_successor`: poisoned path; wait for the successor group.
 * - `drop`: ack and drop.
 * - `drop_unexpected_content`: ack, drop, `console.error` ids only (D16).
 * - `drop_unsolicited_welcome`: ack, drop, red toast (D22).
 * - `refuse_wrong_kind`: loud, NOT acked (D4).
 * - `hold`: not acked; retried later with backoff (transient, local, or
 *   unexpected). `busy` holds WITHOUT a `groupError`.
 */
export type TextEnvelopeAction =
  | "catch_up"
  | "pin_identities_retry"
  | "park_owner_change"
  | "rejoin"
  | "join"
  | "signer_leaf_missing_retry"
  | "await_successor"
  | "drop"
  | "drop_unexpected_content"
  | "drop_unsolicited_welcome"
  | "refuse_wrong_kind"
  | "hold";

/**
 * `ack`: whether the envelope id may be acked. `groupError`: the tag to
 * record as the view's `groupError`; absent leaves it unchanged.
 * `markLeft`: only with `rejoin`; the `_mark_left` reason to apply to the
 * envelope's group before the rejoin path.
 */
export interface TextEnvelopeVerdict {
  ack: boolean;
  action: TextEnvelopeAction;
  groupError?: ViewErrorTag;
  markLeft?: TextLeftReason;
}

/** The `type` of a native error, unwrapping a `TextFlowFailure`. */
function nativeTypeOf(err: unknown): string | null {
  if (!isRecord(err)) return null;
  if (err.source === "native") return nativeTypeOf(err.error);
  return typeof err.type === "string" ? err.type : null;
}

const HOLD_UNKNOWN: TextEnvelopeVerdict = {
  ack: false,
  action: "hold",
  groupError: "unknown",
};

function textEnvelopeVerdict(tag: TextNativeErrorTag): TextEnvelopeVerdict {
  const set = (ack: boolean, action: TextEnvelopeAction) => ({
    ack,
    action,
    groupError: tag,
  });
  switch (tag) {
    case "mls_epoch_gap":
      return { ack: false, action: "catch_up" };
    case "identity_pin_required":
      return { ack: false, action: "pin_identities_retry" };
    case "owner_changed":
      return set(false, "park_owner_change");
    case "own_commit_mismatch":
      return set(true, "rejoin");
    // S2-D31 (design 6.3, 9.2): a commit behind the server tip whose leaf
    // has no usable identity (unpinned past its budget, or revoked). Native
    // rolled back and did NOT poison (it refuses `_mark_left` on a poisoned
    // group); the bridge marks the group left and rejoins, and the Welcome
    // re-verifies every leaf. The tag is `resecuring`, never sticky or loud.
    case "catch_up_leaf_unresolvable":
      return { ...set(true, "rejoin"), markLeft: "catch_up_failed" };
    case "mls_group_not_found":
      return set(true, "join");
    case "signer_leaf_missing":
      return set(true, "signer_leaf_missing_retry");
    case "already_member":
    case "channel_mismatch":
      return set(true, "drop");
    case "unexpected_mls_content":
      return set(true, "drop_unexpected_content");
    case "mls_unsolicited_welcome":
      return { ack: true, action: "drop_unsolicited_welcome" };
    case "wrong_group_kind":
      return set(false, "refuse_wrong_kind");
    case "declined":
      return { ack: false, action: "hold" };
    // Poisoned path (design 3.12.3, 9.2): never merged, wait for successor.
    case "roster_mismatch":
    case "mls_leaf_rejected":
    case "text_group_full":
    case "not_owner":
    case "commit_declaration_mismatch":
    case "duplicate_leaf":
    case "replayed_rejoin_intent":
    case "bad_sig":
    case "seat_list_invalid":
    case "seat_list_equivocation":
    case "seat_list_rollback":
    case "mls_poisoned_epoch":
      return set(true, "await_successor");
    // Message-, sign- or encrypt-only tags: unexpected from `_process`.
    // `unsupported_envelope_version` is raised only by `_decrypt` (outer
    // payload `v` 2..=255 in `formats.rs` `parse_encrypted_payload`, inner
    // envelope `v` 3..=255 in `decode_envelope`, both via `message.rs`
    // `text_decrypt`); `_process` reads neither, so here it is unexpected
    // like its siblings: held, never acked or dropped. The grey "update to
    // read" marker is the message path's, never a channel op's.
    case "unsupported_envelope_version":
    case "unknown_epoch":
    case "unknown_sender":
    case "removed_sender":
    case "replay":
    case "malformed_text_payload":
    case "update_required":
    case "not_seated":
    case "seat_list_behind":
    case "handover_target_invalid":
      return set(false, "hold");
    default: {
      // Reached at runtime by any tag outside the text set (`storage`, a
      // future variant; `busy` is handled by the caller): fail closed,
      // never a silent drop.
      const exhaustive: never = tag;
      void exhaustive;
      return HOLD_UNKNOWN;
    }
  }
}

/** Classify a `_process` failure for one envelope (design 9.2 per tag). */
export function classifyTextEnvelopeError(err: unknown): TextEnvelopeVerdict {
  const type = nativeTypeOf(err);
  if (type === null) return HOLD_UNKNOWN;
  // Transient native lock contention: hold and retry with backoff, and
  // leave `groupError` unchanged (it must not turn the shield red).
  if (type === "busy") return { ack: false, action: "hold" };
  // The platform protector would not open the store (a locked or declined
  // keyring, a locked phone). Nothing ran and the store is intact: held
  // like `busy`, never acked, never a leave, rejoin or wipe.
  if (isProtectorError(err)) return { ack: false, action: "hold" };
  return textEnvelopeVerdict(type as TextNativeErrorTag);
}

// ---------------------------------------------------------------------------
// Protector back-off (S7 plan D9, Stage-1 EL-F7 / AND-F13)
// ---------------------------------------------------------------------------

/**
 * Pause after a native `protector` refusal: 2 s doubling, capped at 60 s.
 * Native consults the protector only when it opens the store, and a store
 * that failed to open is opened again by the next command. On Linux every
 * such open asks the Secret Service to unlock (a prompt); on Android a
 * locked Keystore refuses until the device is unlocked. Without a pause,
 * each passive command (a decrypt per message, `_state`,
 * `_pin_own_devices`, `_process`) would raise the prompt again.
 */
export const PROTECTOR_BACKOFF = { startMs: 2_000, capMs: 60_000 } as const;

/**
 * Whether `err` (a raw native error or a `source: "native"` failure) is the
 * platform protector refusing to open the store. `protector_locked` is
 * iOS's locked-device variant of the same refusal; it is matched too. A
 * server, transport or client failure never is, whatever its `type`.
 */
export function isProtectorError(err: unknown): boolean {
  if (isRecord(err) && "source" in err && err.source !== "native") {
    return false;
  }
  const type = nativeTypeOf(err);
  return type === "protector" || type === "protector_locked";
}

/** The pause after the `failures`-th consecutive refusal (1 = first). */
export function protectorBackoffMs(failures: number): number {
  const n = failures > 1 ? Math.floor(failures) - 1 : 0;
  let ms: number = PROTECTOR_BACKOFF.startMs;
  for (let i = 0; i < n && ms < PROTECTOR_BACKOFF.capMs; i++) ms *= 2;
  return Math.min(ms, PROTECTOR_BACKOFF.capMs);
}

/**
 * The manager's protector gate. `failures` 0 is open: commands run as
 * before. Otherwise no text command reaches native before `untilMs`; then
 * ONE command probes while every other one waits for its answer.
 */
export interface ProtectorGate {
  readonly failures: number;
  readonly untilMs: number;
}

export const PROTECTOR_GATE_OPEN: ProtectorGate = Object.freeze({
  failures: 0,
  untilMs: 0,
});

/**
 * - `run`: issue the command now; `probe` when it is the one command let
 *   through a closed gate.
 * - `wait`: issue nothing for `waitMs`, then ask again.
 * - `wait_probe`: a probe is in flight; ask again once it is answered.
 */
export type ProtectorGateStep =
  | { kind: "run"; probe: boolean }
  | { kind: "wait"; waitMs: number }
  | { kind: "wait_probe" };

/**
 * What a command may do now. Any `failures` but a clean 0 counts as closed.
 * A window longer than the cap can only mean the clock moved back: one
 * probe then restarts the window from the current clock. An unreadable
 * clock never lets a command through.
 */
export function protectorGateStep(
  gate: ProtectorGate,
  nowMs: number,
  probeInFlight: boolean,
): ProtectorGateStep {
  if (gate.failures === 0) return { kind: "run", probe: false };
  if (probeInFlight) return { kind: "wait_probe" };
  const remaining = gate.untilMs - nowMs;
  if (!Number.isFinite(remaining)) {
    return { kind: "wait", waitMs: PROTECTOR_BACKOFF.capMs };
  }
  if (remaining > 0 && remaining <= PROTECTOR_BACKOFF.capMs) {
    return { kind: "wait", waitMs: remaining };
  }
  return { kind: "run", probe: true };
}

/**
 * How a command was answered: `ok` (it resolved), `protector` (refused by
 * the protector), `other` (any other rejection).
 */
export type ProtectorAnswer = "ok" | "protector" | "other";

/**
 * The gate after one answer. `issuedFailures` is `gate.failures` when that
 * command was issued.
 * - `ok` reopens the gate: native opened the store (it stays open).
 * - `protector` closes it one level above the level the command was issued
 *   at, so commands already in flight when the gate closed, refused
 *   together, count once. The window restarts at this answer.
 * - `other` changes nothing. It does not show the store opened (`busy` is
 *   answered before the open), so it does not reopen the gate.
 */
export function protectorGateAfter(
  gate: ProtectorGate,
  answer: ProtectorAnswer,
  issuedFailures: number,
  nowMs: number,
): ProtectorGate {
  switch (answer) {
    case "ok":
      return PROTECTOR_GATE_OPEN;
    case "other":
      return gate;
    case "protector": {
      const failures = Math.max(gate.failures, issuedFailures + 1);
      return { failures, untilMs: nowMs + protectorBackoffMs(failures) };
    }
  }
}

// ---------------------------------------------------------------------------
// Admission stagger (plan D19)
// ---------------------------------------------------------------------------

/** Delay before admitting/removing: own leaf index x 2 s (0 if unknown). */
export function leafStaggerMs(ownLeafIndex: number): number {
  return Number.isSafeInteger(ownLeafIndex) && ownLeafIndex > 0
    ? ownLeafIndex * LEAF_STAGGER_MS
    : 0;
}

// ---------------------------------------------------------------------------
// Async Text join (S2-D28 re-broadcast + stored intents, S2-D29 Welcomes)
// ---------------------------------------------------------------------------

/**
 * S2-D28: the joiner's re-broadcast pace. It starts at the S1 join spacing
 * (`JOIN_RETRY_MS`), doubles, and holds at 15 min. Silence never ends it.
 */
export const JOIN_REBROADCAST = {
  startMs: JOIN_RETRY_MS,
  capMs: 15 * 60_000,
} as const;

/**
 * S2-D28: the wait before the next re-broadcast after `waits` earlier waits
 * of this join (0 = the first, counted from its start or its last reset):
 * 10 s, 20 s, 40 s ... held at 15 min. A count that is not a non-negative
 * safe integer fails to the cap (the slowest pace, never a tight loop).
 */
export function joinRebroadcastDelayMs(waits: number): number {
  if (!Number.isSafeInteger(waits) || waits < 0) return JOIN_REBROADCAST.capMs;
  let ms: number = JOIN_REBROADCAST.startMs;
  for (let i = 0; i < waits && ms < JOIN_REBROADCAST.capMs; i++) ms *= 2;
  return Math.min(ms, JOIN_REBROADCAST.capMs);
}

/**
 * S2-D29: `member_added` shows this device and no Welcome was processed for
 * this long: fetch the stored one.
 */
export const WELCOME_FETCH_AFTER_MS = 20_000;

/** S2-D29: re-sends of the stored-Welcome GET after a 429 / 5xx / transport. */
export const WELCOME_FETCH_RETRY_BUDGET = 3;

/** `GET /mls/groups/:id/welcome?device_id=` (`ResponseTextWelcome`). */
export interface StoredWelcome {
  group_id: string;
  epoch: number;
  welcome: string;
}

/** What one answer to the stored-Welcome GET means. */
export type WelcomeFetchStep =
  /** The bytes go to native's Welcome path; native decides. */
  | { kind: "process"; welcome: StoredWelcome }
  /** 404, the unknown-group answer: no stored Welcome; rejoin. */
  | { kind: "rejoin" }
  /** Unknown outcome within the budget: ask again after `delayMs`. */
  | { kind: "retry"; delayMs: number }
  /** Nothing usable: no rejoin; the join waits. */
  | {
      kind: "give_up";
      why: "refused" | "malformed" | "wrong_group" | "budget";
    };

export type WelcomeFetchAnswer =
  | { kind: "response"; response: TextApiResponse }
  | { kind: "transport_error" };

/**
 * S2-D29: one answer to the stored-Welcome GET for `groupId` (the server's
 * CURRENT group) after `failures` earlier unknown outcomes. Only a 404 is
 * "no Welcome" (the route answers every missing case like an unknown
 * group). A 2xx is used only when it names the group asked for, an epoch
 * and non-empty bytes, and is trusted no further: native's Welcome path
 * verifies it. Transport, 429 and 5xx are retried within
 * `WELCOME_FETCH_RETRY_BUDGET`; anything else, or the budget spent, gives
 * up without a rejoin.
 */
export function welcomeFetchStep(
  answer: WelcomeFetchAnswer,
  ctx: { groupId: string; failures: number },
): WelcomeFetchStep {
  const retry = (delayMs: number): WelcomeFetchStep =>
    ctx.failures < WELCOME_FETCH_RETRY_BUDGET
      ? { kind: "retry", delayMs }
      : { kind: "give_up", why: "budget" };
  if (answer.kind === "transport_error") {
    return retry(publishBackoffMs(ctx.failures));
  }
  const r = answer.response;
  if (r.status === 429) return retry(rateLimitDelayMs(r, ctx.failures));
  if (r.status >= 500) return retry(publishBackoffMs(ctx.failures));
  if (r.status === 404) return { kind: "rejoin" };
  if (!is2xx(r.status)) return { kind: "give_up", why: "refused" };
  const b = r.body;
  if (
    !isRecord(b) ||
    typeof b.group_id !== "string" ||
    !isEpoch(b.epoch) ||
    typeof b.welcome !== "string" ||
    b.welcome.length === 0
  ) {
    return { kind: "give_up", why: "malformed" };
  }
  if (b.group_id !== ctx.groupId) {
    return { kind: "give_up", why: "wrong_group" };
  }
  return {
    kind: "process",
    welcome: { group_id: b.group_id, epoch: b.epoch, welcome: b.welcome },
  };
}

/**
 * S2-D29: this device's latest Add in the server's `member_added` (a
 * liveness aid, never a security input), or null. `key` names this
 * observation: the stored-Welcome fetch and its one rejoin are bound to
 * it, and a new Add is a new key. Malformed entries are skipped.
 */
export function ownAddedEntry(
  g: { group_id: string; member_added: readonly unknown[] },
  userId: string,
  deviceId: string,
): { key: string; epoch: number } | null {
  let epoch: number | null = null;
  for (const a of g.member_added) {
    if (
      !isRecord(a) ||
      a.user_id !== userId ||
      a.device_id !== deviceId ||
      !isEpoch(a.epoch)
    ) {
      continue;
    }
    if (epoch === null || a.epoch > epoch) epoch = a.epoch;
  }
  return epoch === null ? null : { key: `${g.group_id}:${epoch}`, epoch };
}

/**
 * W4d X#6 / S2-D29: a Welcome is due for that Add when it is at or after
 * the server epoch this device's last intent was sent at (`fromEpoch`;
 * null = no intent sent by this manager).
 */
export function welcomeDue(
  added: { epoch: number } | null,
  fromEpoch: number | null,
): boolean {
  return added !== null && fromEpoch !== null && added.epoch >= fromEpoch;
}

/**
 * S2-D29 (FX-J2 NEW-1): that Add still owes its ONE stored-Welcome path: a
 * Welcome is due for it and `done` (the last Add whose path ran) is not it.
 * Once the path ran, whatever it gave, the Add is done: the joiner
 * re-broadcasts its intent on the backoff and never fetches it again.
 */
export function welcomePending(
  added: { key: string; epoch: number } | null,
  fromEpoch: number | null,
  done: string | null,
): boolean {
  return added !== null && welcomeDue(added, fromEpoch) && done !== added.key;
}

/**
 * FX-J2 NEW-2: a `ProtectedChannelChanged` restarts the join backoff at
 * most once per this window (the backoff cap), so a busy or hostile server
 * cannot hold the joiner at the first step. An open (a user action) always
 * restarts it.
 */
export const JOIN_EVENT_RESET_GAP_MS = JOIN_REBROADCAST.capMs;

/**
 * FX-J2 NEW-2: whether an event may restart the join backoff now, given
 * when the last one did (null: never). A clock that is not finite or ran
 * backwards refuses (the slower pace, never a storm).
 */
export function joinEventResetAllowed(
  lastAtMs: number | null,
  nowMs: number,
): boolean {
  if (lastAtMs === null) return true;
  if (!Number.isFinite(lastAtMs) || !Number.isFinite(nowMs)) return false;
  return nowMs - lastAtMs >= JOIN_EVENT_RESET_GAP_MS;
}

/** S2-D28: refreshes on which members admit from stored `join_requests`. */
export const STORED_ADMIT_REASONS: readonly TextRefreshReason[] = [
  "open",
  "interval",
  "start",
  "event",
  "manual",
];

/**
 * FX-J2 NEW-5: what a refresh does for each reason, strongest first. An
 * open admits from stored intents and retries a capacity-refused join; the
 * other stored-admit reasons admit; "start" admits but joins only a group
 * native has left; the rest do not admit.
 */
const REFRESH_REASON_RANK: Record<TextRefreshReason, number> = {
  open: 4,
  interval: 3,
  event: 3,
  manual: 3,
  start: 2,
  commit: 1,
  resecuring: 1,
  owner_confirmed: 1,
  send_refused: 1,
};

/**
 * FX-J2 NEW-5: the reason of a refresh pass that also serves a coalesced
 * call: the stronger of the two (`REFRESH_REASON_RANK`), `held` on a tie.
 * A stored-admit reason always wins over one that does not admit, so a
 * reconnect refresh is never absorbed by a running commit refresh.
 */
export function coalescedRefreshReason(
  held: TextRefreshReason,
  incoming: TextRefreshReason,
): TextRefreshReason {
  const h = REFRESH_REASON_RANK[held] ?? 0;
  const i = REFRESH_REASON_RANK[incoming] ?? 0;
  return i > h ? incoming : held;
}

/**
 * FX-J2 NEW-3: refused stored admissions remembered per session, oldest
 * forgotten first past this many (a later sweep may then claim one again).
 */
export const ADMIT_REFUSED_CAP = 1024;

/**
 * FX-J2 NEW-3: the identity of one join request for the negative cache:
 * its group, device and KeyPackage ref. A re-broadcast mints a new
 * KeyPackage, so a new ref is a new request.
 */
export function admitRefusalKey(req: MlsJoinRequest): string {
  return JSON.stringify([req.group_id, req.device_id, req.key_package_ref]);
}

/** Native answers to `_admit` that say nothing about the request itself. */
const ADMIT_TRANSIENT_TAGS: readonly string[] = [
  "busy",
  "storage",
  "protector",
  "protector_locked",
  "identity_pin_required",
];

/**
 * FX-J2 NEW-3: native `_admit` refused the request (a native error that is
 * not transient: lock contention, storage, the protector, a missing pin).
 * A server, transport or client failure is never a native refusal.
 */
export function admitRefusedByNative(err: unknown): boolean {
  if (isRecord(err) && "source" in err && err.source !== "native") {
    return false;
  }
  const type = nativeTypeOf(err);
  return type !== null && !ADMIT_TRANSIENT_TAGS.includes(type);
}

/** One stored intent, as the live `MlsJoinRequested` handler takes it. */
export interface StoredJoinRequest {
  request: MlsJoinRequest;
  rejoin: boolean;
}

/**
 * S2-D28: `text_group.join_requests` (absent = none) as join requests into
 * `groupId` of `channelId`, in order, in the shape the live
 * `MlsJoinRequested` gives the manager: the S1 strings, `generation` /
 * `issued_at` ONLY when present and then a safe non-negative integer
 * (OR-6, the rule of `joinIntentSignedFields`), `rejoin` a boolean. A
 * malformed entry is dropped WHOLE (never a partial request, never the S1
 * shape) and counted; `created_at` never reaches native; a repeat of one
 * (user, device, rejoin) keeps the first. Nothing here is trusted:
 * admission re-checks the seat and native verifies the signature against
 * its pins and refuses an off-list user.
 */
export function storedJoinRequests(
  raw: unknown,
  groupId: string,
  channelId: string,
): { requests: StoredJoinRequest[]; dropped: number } {
  if (raw === undefined || raw === null) return { requests: [], dropped: 0 };
  if (!Array.isArray(raw)) return { requests: [], dropped: 1 };
  const requests: StoredJoinRequest[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const v of raw) {
    const one = storedJoinRequest(v, groupId, channelId);
    if (one === null) {
      dropped += 1;
      continue;
    }
    const key = JSON.stringify([
      one.request.user_id,
      one.request.device_id,
      one.rejoin,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    requests.push(one);
  }
  return { requests, dropped };
}

function storedJoinRequest(
  v: unknown,
  groupId: string,
  channelId: string,
): StoredJoinRequest | null {
  if (!isRecord(v)) return null;
  const { user_id, device_id, key_package_ref, signature, rejoin } = v;
  if (
    typeof user_id !== "string" ||
    typeof device_id !== "string" ||
    typeof key_package_ref !== "string" ||
    typeof signature !== "string" ||
    typeof rejoin !== "boolean"
  ) {
    return null;
  }
  const request: MlsJoinRequest = {
    group_id: groupId,
    channel_id: channelId,
    user_id,
    device_id,
    key_package_ref,
    signature,
  };
  for (const key of ["generation", "issued_at"] as const) {
    const x = v[key];
    if (x === undefined) continue;
    if (!isEpoch(x)) return null;
    request[key] = x;
  }
  return { request, rejoin };
}

// ---------------------------------------------------------------------------
// S2 final audit FXF: the 6c budget's binding; a parked Welcome
// ---------------------------------------------------------------------------

/**
 * FXF: what the 6c `signer_leaf_missing` budget was spent on: the server
 * group the discarded Welcomes named and the list signer this device held
 * then (`leafMissingSigner`).
 */
export interface LeafMissingBinding {
  groupId: string;
  signer: string | null;
}

/** FXF: the signer of the list native holds (null: none held). */
export function leafMissingSigner(n: TextChannelState | null): string | null {
  const l = n?.seat_list ?? null;
  return l === null
    ? null
    : JSON.stringify([l.signer_user_id, l.signer_device_id]);
}

/**
 * FXF: a budget spent on `on` still applies to a join into `groupId` while
 * this device holds a list from the same signer. A successor group (owner
 * recovery, D21) or a list from another signer (an owner change confirmed,
 * a recovery list adopted) is a new start: the old failures say nothing
 * about it. Never a reset by time or by a refresh alone.
 */
export function leafMissingApplies(
  on: LeafMissingBinding | null,
  groupId: string,
  signer: string | null,
): boolean {
  return on !== null && on.groupId === groupId && on.signer === signer;
}

/**
 * FXF (9.1 6c): the verified failure that ends a join into `groupId`: the
 * budget spent on that group under the signer held now. `!(x < budget)` so
 * a non-finite count fails closed; a spent count with no binding (never
 * written by the manager) fails closed too.
 */
export function leafMissingSpent(
  count: number,
  on: LeafMissingBinding | null,
  groupId: string,
  signer: string | null,
): boolean {
  if (count < SIGNER_LEAF_MISSING_BUDGET) return false;
  return on === null || leafMissingApplies(on, groupId, signer);
}

/** The fields of a parked envelope the FXF rules read. */
interface ParkedEnvelope {
  content_type: string;
  group_id: string;
  epoch: number;
}

/**
 * FXF: a Welcome for `groupId` waits in the owner-change queue (D15). The
 * Add it answers is pending: the joiner neither re-broadcasts nor rejoins
 * (each would evict and re-add this device) until the confirm resolves it
 * or the server's group moves on.
 */
export function welcomeParkedFor(
  parked: readonly ParkedEnvelope[],
  groupId: string,
): boolean {
  return parked.some(
    (p) => p.content_type === "mls_welcome" && p.group_id === groupId,
  );
}

/**
 * FXF: what a confirmed owner change replays, in arrival order. Of the
 * parked Welcomes only the latest for the server's current group
 * (`currentGroupId`, null: none) is replayed (the highest epoch, the last
 * of equal ones); every other is dropped, never replayed into a newer
 * group. Every other envelope is replayed (native decides).
 */
export function parkedReplay<T extends ParkedEnvelope>(
  parked: readonly T[],
  currentGroupId: string | null,
): { replay: T[]; dropped: T[] } {
  let keep: T | null = null;
  for (const p of parked) {
    if (p.content_type !== "mls_welcome" || p.group_id !== currentGroupId) {
      continue;
    }
    if (keep === null || p.epoch >= keep.epoch) keep = p;
  }
  const replay: T[] = [];
  const dropped: T[] = [];
  for (const p of parked) {
    if (p.content_type === "mls_welcome" && p !== keep) dropped.push(p);
    else replay.push(p);
  }
  return { replay, dropped };
}

// ---------------------------------------------------------------------------
// S2 live leg FXP: Welcome pin retries and refusals (F-L6), the owner-change
// intent hold (F-L7)
// ---------------------------------------------------------------------------

/**
 * F-L6: the most devices one pass over a Welcome pins (native
 * `MAX_TEXT_LEAVES`, the most leaves a text group holds). A Welcome's bytes
 * are fixed and its leaves were authenticated by the adder, so native can
 * only ever name its own leaves; the cap holds even if it did not.
 */
export const WELCOME_PIN_DEVICES_MAX = MAX_TEXT_LEAVES;

/** F-L6: the key `pinRetryAllowed` reads (ids only, never shown). */
export function pinRetryKey(device: {
  user_id: string;
  device_id: string;
}): string {
  return JSON.stringify([device.user_id, device.device_id]);
}

/**
 * F-L6 (plan D18 / D28, process.rs `PinBudget`): whether `_process` runs
 * again after pinning the device an `identity_pin_required` named, given
 * the devices already pinned in this pass (`pinRetryKey`). A commit: once
 * per pass, whatever device the refusal names (D28: native counts ONE
 * budget per group and epoch, so a server rotating the device cannot buy
 * more). A Welcome: once per DISTINCT device (native counts each leaf on
 * its own budget, and reports one unpinned leaf per refusal); a device
 * named twice ends the pass (its pin did not take), and so does the cap.
 */
export function pinRetryAllowed(
  contentType: string,
  pinned: ReadonlySet<string>,
  device: { user_id: string; device_id: string },
): boolean {
  if (contentType !== "mls_welcome") return pinned.size === 0;
  return (
    !pinned.has(pinRetryKey(device)) && pinned.size < WELCOME_PIN_DEVICES_MAX
  );
}

/**
 * F-L6: what one pin of a device named by native gave. `answered`: the
 * signed listing was fetched and handed to native (it pinned the device,
 * the device was already pinned, or the listing does not carry it: the
 * pin call does not say which; only a `_process` re-run tells, MJ-1).
 * `transport`: the listing could not be fetched (network, timeout, 429,
 * 5xx; for own devices also a stale cached listing served instead).
 * `refused`: any other failure (a 4xx, a native refusal).
 */
export type PinOutcome = "answered" | "transport" | "refused";

/**
 * F-L6: the outcome of a pin that rejected with `err`. Only a failure that
 * says nothing about the listing itself is `transport`: a fetch error
 * (`TypeError`), the courier's rate-limit or timeout errors, or an HTTP
 * status of 429 or 5xx. Everything else (a 4xx, a native error, an unknown
 * shape) is `refused`: never read as "it would have pinned".
 */
export function pinFailureOutcome(err: unknown): "transport" | "refused" {
  if (!isRecord(err)) return "refused";
  const status = err.status;
  if (typeof status === "number") {
    return status === 429 || status >= 500 ? "transport" : "refused";
  }
  const name = err instanceof Error ? err.name : null;
  return name === "TypeError" ||
    name === "E2EERateLimitError" ||
    name === "E2EERequestTimeoutError"
    ? "transport"
    : "refused";
}

/** F-L6: a Welcome native refused with `mls_leaf_rejected`. */
export interface WelcomeRefusal {
  groupId: string;
  /** The refused Welcome's epoch (its Add's epoch). */
  epoch: number;
  /** The refused leaf (ids only, never shown). */
  userId: string;
  deviceId: string;
  /** Native's `LeafRejection` (unchecked string). */
  reason: string;
  /** `refusalRetryable(reason)`. */
  retryable: boolean;
}

/**
 * F-L6: the refused leaf of a Welcome `_process` failure, or null when the
 * failure is not a leaf rejection of a Welcome naming a device.
 */
export function welcomeRefusalOf(
  err: unknown,
  wire: { content_type: string; group_id: string; epoch: number },
): Omit<WelcomeRefusal, "retryable"> | null {
  if (wire.content_type !== "mls_welcome") return null;
  let e: unknown = err;
  if (isRecord(e) && e.source === "native") e = e.error;
  if (!isRecord(e) || e.type !== "mls_leaf_rejected") return null;
  if (typeof e.user_id !== "string" || typeof e.device_id !== "string") {
    return null;
  }
  return {
    groupId: wire.group_id,
    epoch: wire.epoch,
    userId: e.user_id,
    deviceId: e.device_id,
    reason: typeof e.reason === "string" ? e.reason : "",
  };
}

/**
 * F-L6 (round 3, MJ-1): `unknown_identity` is native's spent pin budget for
 * one (group, epoch, device) (process.rs `WELCOME_PIN_RETRIES`), never a
 * verdict on the device, so it is retryable (the next Welcome is another
 * epoch with a fresh budget). Every other reason is a leaf the roster
 * really holds (identity changed or revoked, a bad key or signature): hard.
 */
export function refusalRetryable(reason: string): boolean {
  return reason === "unknown_identity";
}

/**
 * F-L6 (M1a): the first pace window between two refused-Welcome rejoins
 * for one refused device: the S2-D28 re-broadcast cap. Each further grant
 * for the same device doubles it, up to `REFUSAL_PACE_CAP_MS` (m-c).
 */
export const REFUSAL_PACE_BASE_MS = JOIN_REBROADCAST.capMs;

/** F-L6 (m-c): the longest pace window: one grant a day at most. */
export const REFUSAL_PACE_CAP_MS = 24 * 3_600_000;

/** F-L6: grants so far for one (group, refused device), and the last one. */
export interface RefusalPace {
  grants: number;
  atMs: number;
}

/**
 * F-L6: the window that must pass after `grants` grants (0: none); a
 * broken count reads as the cap.
 */
export function refusalPaceWindowMs(grants: number): number {
  if (!Number.isSafeInteger(grants) || grants < 0) return REFUSAL_PACE_CAP_MS;
  if (grants === 0) return 0;
  let ms: number = REFUSAL_PACE_BASE_MS;
  for (let i = 1; i < grants && ms < REFUSAL_PACE_CAP_MS; i++) ms *= 2;
  return Math.min(ms, REFUSAL_PACE_CAP_MS);
}

/**
 * F-L6: a rejoin for this refused device may be granted at `nowMs`. A
 * clock that is not finite refuses; a last grant stamped in the future is
 * read as now (m-c: the window runs from now, never from a future time).
 */
export function refusalPaceAllows(
  p: RefusalPace | null,
  nowMs: number,
): boolean {
  if (p === null) return true;
  if (!Number.isFinite(nowMs) || !Number.isFinite(p.atMs)) return false;
  const at = Math.min(p.atMs, nowMs);
  return nowMs - at >= refusalPaceWindowMs(p.grants);
}

/** F-L6: the pace record after a grant at `nowMs`. */
export function refusalPaceAfterGrant(
  p: RefusalPace | null,
  nowMs: number,
): RefusalPace {
  return { grants: (p?.grants ?? 0) + 1, atMs: nowMs };
}

/**
 * F-L6: one stored pace entry (ids only): the refused device's pace and
 * its last refusal (epoch, reason; m-a: the alarm is rebuilt from it).
 */
export interface RefusalPaceEntry extends RefusalPace {
  groupId: string;
  userId: string;
  deviceId: string;
  epoch: number;
  reason: string;
}

/** F-L6: pace entries kept per channel (oldest dropped first). */
export const REFUSAL_PACE_ENTRIES_MAX = 16;

/**
 * F-L6 (m4-2): two copies of one (group, device) entry, the stored and the
 * in-memory one, merged to the strictest: the larger grant count and the
 * later grant, taken separately (`{2, T0}` and `{1, T0 + 29 min}` give
 * `{2, T0 + 29 min}`); the later refusal's epoch and reason.
 */
export function mergeRefusalPaceEntry(
  a: RefusalPaceEntry,
  b: RefusalPaceEntry,
): RefusalPaceEntry {
  return {
    ...(b.epoch > a.epoch ? b : a),
    grants: Math.max(a.grants, b.grants),
    atMs: Math.max(a.atMs, b.atMs),
  };
}

/**
 * F-L6: the stored pace entries of a channel (`{ v: 2, entries }`). A
 * malformed entry is dropped; an unreadable record reads as none.
 */
export function parseRefusalPaces(raw: string | null): RefusalPaceEntry[] {
  let v: unknown = null;
  try {
    v = JSON.parse(raw ?? "null");
  } catch {
    return [];
  }
  if (!isRecord(v) || v.v !== 2 || !Array.isArray(v.entries)) return [];
  const out: RefusalPaceEntry[] = [];
  for (const e of v.entries) {
    if (
      isRecord(e) &&
      typeof e.groupId === "string" &&
      typeof e.userId === "string" &&
      typeof e.deviceId === "string" &&
      typeof e.reason === "string" &&
      isEpoch(e.epoch) &&
      Number.isSafeInteger(e.grants) &&
      (e.grants as number) >= 0 &&
      typeof e.atMs === "number" &&
      Number.isFinite(e.atMs)
    ) {
      out.push({
        groupId: e.groupId,
        userId: e.userId,
        deviceId: e.deviceId,
        epoch: e.epoch,
        reason: e.reason,
        grants: e.grants as number,
        atMs: e.atMs,
      });
    }
  }
  return out.slice(-REFUSAL_PACE_ENTRIES_MAX);
}

/**
 * F-L6: what a refused Welcome allows now.
 * - `newer_add` (MJ-2): the server shows a newer Add of this device than
 *   the refused one, not tried yet (`newerAddTried`), whose Welcome path
 *   will run (`newerAddPathRuns`, MJ-2b: `welcomePending` as the join loop
 *   reads it): only that path runs (a fetch, no intent). Tried, or a path
 *   that would not run, that Add is judged like the refused one, under the
 *   same pace.
 * - `rejoin`: ONE fresh rejoin intent, when the class allows it and the
 *   persisted pace for that device does (M1a, m-c). A retryable refusal
 *   (MJ-1) is allowed at once; a hard one once the server's group moved
 *   past the refused epoch, or at once when the server's member list no
 *   longer holds the refused device (a commit removed that leaf). Server
 *   data only paces this: a lie costs one more refusal per window, and
 *   native judges every Welcome. m4-3: with no Add of this device shown,
 *   or one older than the refused Welcome, it is judged the same way
 *   (paced), never left blocked for good nor let through.
 * - `none` otherwise.
 */
export function welcomeRefusalRejoin(i: {
  refusal: WelcomeRefusal | null;
  group: {
    group_id: string;
    current_epoch: number;
    members: readonly { user_id: string; device_id: string }[];
  } | null;
  ownAddEpoch: number | null;
  newerAddTried: boolean;
  newerAddPathRuns: boolean;
  pace: RefusalPace | null;
  nowMs: number;
}): "rejoin" | "newer_add" | "none" {
  const r = i.refusal;
  const g = i.group;
  if (r === null || g === null || r.groupId !== g.group_id) return "none";
  if (
    i.ownAddEpoch !== null &&
    i.ownAddEpoch > r.epoch &&
    !i.newerAddTried &&
    i.newerAddPathRuns
  ) {
    return "newer_add";
  }
  if (!r.retryable) {
    const listed = g.members.some(
      (m) =>
        isRecord(m) && m.user_id === r.userId && m.device_id === r.deviceId,
    );
    const moved = isEpoch(g.current_epoch) && g.current_epoch > r.epoch;
    if (listed && !moved) return "none";
  }
  return refusalPaceAllows(i.pace, i.nowMs) ? "rejoin" : "none";
}

/**
 * F-L7 (D15, FXF; m3, MJ-3): no join intent, a run's first or a
 * re-broadcast, while this device's Welcome for the server's current
 * group waits for an owner change: a confirm is replaying it
 * (`welcomeReplaying`), or native holds a same-user pending signer
 * (`ownerChangePending`) and the Welcome is parked or native answered
 * `signer_leaf_missing` to the Welcome of this device's latest Add
 * (`slmForAdd`). With no pending signer (adopted, confirmed, or another
 * user's) nothing holds: the confirm admits that Welcome.
 */
export function joinIntentHeldByOwnerChange(i: {
  welcomeReplaying: boolean;
  welcomeParked: boolean;
  slmForAdd: boolean;
  ownerChangePending: boolean;
}): boolean {
  return (
    i.welcomeReplaying ||
    (i.ownerChangePending && (i.welcomeParked || i.slmForAdd))
  );
}
