/**
 * Message flows for Protected channels (text plane), W4 lane B4.
 *
 * - `encryptAndSend` (plan D10): native `_encrypt` mints the cid; the
 *   `{nonce, encrypted}` bytes persist per outbox key
 *   (`protected-send:<userId>:<channelId>:<key>`) BEFORE the POST and are
 *   re-sent byte for byte while the outcome is unknown. After an unknown
 *   outcome every non-2xx answer is confirmed by refetch first
 *   (`classifySendAnswer`); `DuplicateNonce` is never re-encrypted; the one
 *   Resecuring retry re-encrypts only after the earlier attempt is KNOWN to
 *   have failed.
 * - `decryptRow` (plan D22): a row without `encrypted` is a loud marker and
 *   never reaches native; `UnknownEpoch` ahead of `current` catches up and
 *   retries once. Never rejects: every failure is a marker. S2 (OR-20): an
 *   `ok` view carries only the COUNT of its files (`filesUnsupported`).
 * - `markerForError`: D17's message mapping (A2), fail closed.
 * - S4 (design 9.5): a row without `encrypted` goes through the row policy
 *   (`decidePlainRow`). It is `plain` only from a natively verified state
 *   with every lookup present; anything else is `checking` or the red
 *   marker, and none of it reaches native. A missing epoch may be opened by
 *   the history walk (`HistoryOps.requestWalk`), asked once per row per call.
 *
 * Never plaintext: the typed text goes to `e2ee_text_encrypt` and nowhere
 * else (no request, no storage, no log). Logs carry ids only (D16).
 * Pure of Solid / livekit / lingui; tested over a fake port.
 */
import { type WalkGroupView, walkTrigger } from "./protectedHistoryWalk.ts";
import { nativeHistoryInput, rowPolicy } from "./protectedRowPolicy.ts";
import {
  type RowNote,
  protectedNoticeForError,
  rowNotes,
} from "./protectedShield.ts";
import {
  type SendAnswer,
  type SendContext,
  type SendTrigger,
  classifySendAnswer,
  confirmAfterId,
  ownSendRowBinds,
  publishBackoffMs,
} from "./protectedTextPolicy.ts";
import type {
  EncryptedPayload,
  GroupOps,
  NativeError,
  ProtectedMarkerKind,
  ProtectedMessageRow,
  ProtectedMessageView,
  ProtectedSendOutcome,
  ProtectedTextPort,
  TextApiResponse,
  TextChannelState,
  TextDecrypted,
  TextEncrypted,
  TextFlowFailure,
} from "./protectedTextTypes";

// ---------------------------------------------------------------------------
// Constants and storage (D10)
// ---------------------------------------------------------------------------

export const SEND_STORE_PREFIX = "protected-send:";

/** `limit` of every confirm page; also the `pageLimit` the policy gets. */
export const CONFIRM_PAGE_LIMIT = 100;

/** Confirm pages fetched per call before giving up for now. */
export const CONFIRM_PAGES_PER_CALL = 10;

/**
 * POST attempts per `encryptAndSend` call. Exhausting them rejects with the
 * stored entry KEPT, so the outbox retry with the same key re-sends the
 * same bytes (and confirms first, the outcome being unknown).
 */
export const SEND_ATTEMPTS_PER_CALL = 5;

/** D10 storage key of one outbox send. */
export function sendStoreKey(
  userId: string,
  channelId: string,
  key: string,
): string {
  return `${SEND_STORE_PREFIX}${userId}:${channelId}:${key}`;
}

/** Inverse of `sendStoreKey` for this user (B5 lists keys at start). */
export function parseSendStoreKey(
  storageKey: string,
  userId: string,
): { channelId: string; key: string } | null {
  const prefix = `${SEND_STORE_PREFIX}${userId}:`;
  if (!storageKey.startsWith(prefix)) return null;
  const rest = storageKey.slice(prefix.length);
  const i = rest.indexOf(":");
  if (i <= 0 || i === rest.length - 1) return null;
  return { channelId: rest.slice(0, i), key: rest.slice(i + 1) };
}

/** In-memory copy, so a failed storage write still reuses the bytes. */
const memo = new Map<string, string>();

/** In-flight decrypts by message id (own row: POST answer + live event). */
const inflight = new Map<string, Promise<ProtectedMessageView>>();

/** What a walk request came to; `failed` is a rejected or unreadable answer. */
type WalkOutcome = WalkAnswer | "failed";

/** Walk requests in flight per ops object, by channel, group and epoch. */
let walksInFlight = new WeakMap<object, Map<string, Promise<WalkOutcome>>>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const clientFailure = (reason: string): TextFlowFailure => ({
  source: "client",
  reason,
});

const TRANSPORT: TextFlowFailure = { source: "transport" };

const FAILURE_SOURCES = ["native", "server", "transport", "client"];

function toFailure(e: unknown): TextFlowFailure {
  if (isRecord(e) && FAILURE_SOURCES.includes(e.source as string)) {
    return e as unknown as TextFlowFailure;
  }
  if (isRecord(e) && typeof e.type === "string") {
    return { source: "native", error: e as unknown as NativeError };
  }
  return clientFailure("unexpected_error");
}

function nativeErrorOf(e: unknown): Record<string, unknown> | null {
  if (!isRecord(e)) return null;
  if (e.source === "native") return isRecord(e.error) ? e.error : null;
  if (e.source !== undefined) return null;
  return typeof e.type === "string" ? e : null;
}

function parseEntry(raw: string | null): TextEncrypted | null {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (
      !isRecord(v) ||
      typeof v.nonce !== "string" ||
      confirmAfterId(v.nonce) === null ||
      !isRecord(v.encrypted)
    ) {
      return null;
    }
    return {
      nonce: v.nonce,
      encrypted: v.encrypted as unknown as EncryptedPayload,
    };
  } catch {
    return null;
  }
}

function readEntry(port: ProtectedTextPort, k: string): TextEncrypted | null {
  const raw = port.store.get(k) ?? memo.get(k) ?? null;
  const entry = parseEntry(raw);
  if (raw !== null && entry === null) {
    deleteEntry(port, k);
    port.log("warn", "[protected] corrupt stored send dropped", {});
  }
  return entry;
}

function saveEntry(port: ProtectedTextPort, k: string, e: TextEncrypted) {
  const raw = JSON.stringify({ nonce: e.nonce, encrypted: e.encrypted });
  memo.set(k, raw);
  if (!port.store.set(k, raw)) {
    port.log("warn", "[protected] send not persisted", { cid: e.nonce });
  }
}

function deleteEntry(port: ProtectedTextPort, k: string) {
  memo.delete(k);
  port.store.delete(k);
}

/** The POST body: the protected allowlist only (design 7.3). */
function sendBody(e: TextEncrypted, silent: boolean) {
  return silent
    ? { nonce: e.nonce, encrypted: e.encrypted, flags: 1 }
    : { nonce: e.nonce, encrypted: e.encrypted };
}

/**
 * The delivered outcome, only for a row bound to this send (W4d X#4: this
 * channel, this author, nonce === cid, `encrypted` equal to what was sent).
 * The policy already refuses an unbound row; this re-check keeps a policy
 * change from ever handing the manager another message's id.
 */
function outcomeOf(
  raw: unknown,
  ctx: SendContext,
): ProtectedSendOutcome | null {
  if (!ownSendRowBinds(raw, ctx) || !isRecord(raw)) return null;
  return { messageId: raw._id as string, cid: ctx.cid, raw };
}

function serverFailure(
  status: number,
  type: string | null,
  body: unknown,
): TextFlowFailure {
  return { source: "server", status, type, body };
}

// ---------------------------------------------------------------------------
// Encrypt
// ---------------------------------------------------------------------------

function checkEncrypted(v: TextEncrypted): TextEncrypted {
  if (
    !isRecord(v) ||
    typeof v.nonce !== "string" ||
    confirmAfterId(v.nonce) === null ||
    !isRecord(v.encrypted)
  ) {
    throw clientFailure("malformed_encrypt");
  }
  return { nonce: v.nonce, encrypted: v.encrypted };
}

/** Native tags after which the manager should refresh (remove / join). */
const REFRESH_AFTER = new Set([
  "roster_mismatch",
  "mls_group_not_found",
  "not_seated",
]);

/**
 * `_encrypt`. `update_required` → `ops.ensureJoined`, which AWAITS the
 * manager's `_update` commit (D19; `refresh` only schedules it), then the
 * encrypt is retried ONCE.
 */
async function encrypt(
  ops: GroupOps,
  port: ProtectedTextPort,
  channelId: string,
  text: string,
  replies: string[],
): Promise<TextEncrypted> {
  const args = { channelId, userId: port.selfUserId, text, replies };
  try {
    try {
      return checkEncrypted(await port.invoke("e2ee_text_encrypt", args));
    } catch (e) {
      const err = nativeErrorOf(e);
      if (err?.type !== "update_required") throw e;
      await ops.ensureJoined(channelId);
      return checkEncrypted(await port.invoke("e2ee_text_encrypt", args));
    }
  } catch (e) {
    const err = nativeErrorOf(e);
    if (typeof err?.type === "string" && REFRESH_AFTER.has(err.type)) {
      ops.refresh(channelId, "send_refused").catch(() => undefined);
    }
    throw toFailure(e);
  }
}

// ---------------------------------------------------------------------------
// Confirm refetch (D10)
// ---------------------------------------------------------------------------

function confirmPath(channelId: string, after: string, before: string | null) {
  const q = `after=${after}&sort=Latest&limit=${CONFIRM_PAGE_LIMIT}`;
  return `/channels/${channelId}/messages?${q}${
    before === null ? "" : `&before=${before}`
  }`;
}

async function confirmPage(
  port: ProtectedTextPort,
  channelId: string,
  trigger: SendTrigger,
  after: string,
  before: string | null,
): Promise<SendAnswer> {
  try {
    const response = await port.api(
      "GET",
      confirmPath(channelId, after, before),
    );
    return {
      kind: "confirm",
      trigger,
      response,
      pageLimit: CONFIRM_PAGE_LIMIT,
    };
  } catch {
    return { kind: "confirm_transport_error", trigger };
  }
}

// ---------------------------------------------------------------------------
// encryptAndSend (A1 `MessageFlows`)
// ---------------------------------------------------------------------------

/**
 * Encrypt (or reuse the stored bytes for `key`) and POST to a protected
 * channel. Resolves with the delivered server row (`raw`, for the SDK's
 * `getOrCreate(row, true)` + `noteOwnMessage`); rejects with a
 * `TextFlowFailure`. The stored entry is deleted on delivery or a
 * definitive refusal and KEPT whenever the outcome is still unknown.
 */
export async function encryptAndSend(
  ops: GroupOps,
  port: ProtectedTextPort,
  channelId: string,
  text: string,
  replies: string[],
  silent: boolean,
  key: string,
): Promise<ProtectedSendOutcome> {
  const k = sendStoreKey(port.selfUserId, channelId, key);
  const signal = new AbortController().signal;
  let entry = readEntry(port, k);
  // A stored entry means an earlier attempt never resolved: unknown.
  let priorUnknown = entry !== null;
  if (entry === null) {
    entry = await encrypt(ops, port, channelId, text, replies);
    saveEntry(port, k, entry);
  }
  let resecureRetried = false;
  let failures = 0;
  let posts = 0;
  let pages = 0;
  let lastBody: unknown = null;

  const current = (): TextEncrypted => entry as TextEncrypted;
  const post = async (): Promise<SendAnswer> => {
    posts++;
    try {
      const response: TextApiResponse = await port.api(
        "POST",
        `/channels/${channelId}/messages`,
        sendBody(current(), silent),
      );
      lastBody = response.body;
      return { kind: "response", response };
    } catch {
      return { kind: "transport_error" };
    }
  };
  const pause = async (ms: number) => {
    try {
      await port.sleep(ms, signal);
    } catch {
      throw TRANSPORT; // aborted; the entry stays for the next attempt
    }
  };
  /** Re-send the SAME bytes after `ms`, within this call's budget. */
  const resend = async (ms: number): Promise<SendAnswer> => {
    failures++;
    if (posts >= SEND_ATTEMPTS_PER_CALL) throw TRANSPORT;
    await pause(ms);
    return post();
  };

  let answer = await post();
  for (;;) {
    const ctx: SendContext = {
      selfUserId: port.selfUserId,
      channelId,
      cid: current().nonce,
      encrypted: current().encrypted,
      priorUnknown,
      resecureRetried,
      failures,
    };
    const action = classifySendAnswer(answer, ctx);
    switch (action.kind) {
      case "delivered": {
        const outcome = outcomeOf(action.raw, ctx);
        if (outcome !== null) {
          deleteEntry(port, k);
          return outcome;
        }
        // A 2xx we cannot read: the row exists but is unknown to us.
        priorUnknown = true;
        answer = await resend(publishBackoffMs(failures));
        continue;
      }
      case "unknown":
        priorUnknown = true;
        answer = await resend(action.delayMs);
        continue;
      case "retry_same":
        answer = await resend(action.delayMs);
        continue;
      case "confirm":
        if (pages++ >= CONFIRM_PAGES_PER_CALL) throw TRANSPORT;
        answer = await confirmPage(
          port,
          channelId,
          action.trigger,
          action.after,
          action.before,
        );
        continue;
      case "confirm_later": {
        failures++;
        if (pages++ >= CONFIRM_PAGES_PER_CALL) throw TRANSPORT;
        await pause(action.delayMs);
        const after = confirmAfterId(current().nonce) as string;
        answer = await confirmPage(
          port,
          channelId,
          action.trigger,
          after,
          null,
        );
        continue;
      }
      case "resecure_retry": {
        // The earlier attempt is KNOWN to have failed: refresh (catch up /
        // commit the pending Remove), then ONE re-encrypt under a new cid.
        resecureRetried = true;
        try {
          await ops.refresh(channelId, "resecuring");
          entry = await encrypt(ops, port, channelId, text, replies);
        } catch (e) {
          deleteEntry(port, k);
          throw toFailure(e);
        }
        saveEntry(port, k, entry);
        priorUnknown = false;
        failures = 0;
        answer = await post();
        continue;
      }
      case "refused":
        deleteEntry(port, k);
        if (action.clientDefect) {
          port.log("error", "[protected] protected send field refused", {
            channelId,
            type: action.type,
          });
        }
        throw serverFailure(action.status, action.type, lastBody);
      case "maybe_unsent":
        // Possibly delivered but not visible: never re-encrypt here.
        deleteEntry(port, k);
        throw clientFailure("maybe_unsent");
    }
  }
}

// ---------------------------------------------------------------------------
// Decrypt (D22)
// ---------------------------------------------------------------------------

/**
 * D17 message mapping (A2), with the one catch-up already spent and no
 * history walk left to run: the row's final marker. Delegates to the shield:
 * `unsupported_envelope_version` is the grey `unsupported_version` (OR-19,
 * `v` never shown), never `error`/`malformed`.
 *
 * S4: the shield answers `sent_before_join` for every `unknown_epoch` below
 * `current`, as the line a row may show while the walk can still open it.
 * As a final state that line is kept only when the epoch is below the oldest
 * one this device holds. A key missing inside the held run, or with nothing
 * readable about the run, was not "sent before this device joined": that
 * row is the red `decrypt_failed`.
 */
export function markerForError(err: unknown): ProtectedMarkerKind {
  const ui = protectedNoticeForError(err, { op: "message", catchUpDone: true });
  if (ui.kind !== "marker") return "error";
  if (ui.marker === "sent_before_join" && !belowHeldRun(nativeErrorOf(err))) {
    return "decrypt_failed";
  }
  return ui.marker;
}

const marker = (kind: ProtectedMarkerKind): ProtectedMessageView => ({
  status: "marker",
  kind,
});

/**
 * The `ok` view this module builds. `filesUnsupported` (OR-20) counts the
 * message's files this client cannot show: every file in S2, whatever its
 * native `state` (S3 renders files). Names, mimes and sizes never reach
 * the view.
 */
export type ProtectedOkView = Extract<
  ProtectedMessageView,
  { status: "ok" }
> & {
  filesUnsupported: number;
};

const isCount = (v: unknown): boolean =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** `unknown_epoch` names an epoch below the oldest one this device holds. */
function belowHeldRun(err: Record<string, unknown> | null): boolean {
  return (
    err !== null &&
    isCount(err.epoch) &&
    isCount(err.oldest_held) &&
    (err.epoch as number) < (err.oldest_held as number)
  );
}

/**
 * `unknown_epoch` for a group this device holds no epoch of and was not
 * removed from: native sends `oldest_held: null` and `current: -1`.
 */
function neverHeld(err: Record<string, unknown> | null): boolean {
  return (
    err !== null &&
    err.type === "unknown_epoch" &&
    err.removed_self !== true &&
    isCount(err.epoch) &&
    err.oldest_held === null &&
    err.current === -1
  );
}

/**
 * The marker of a row whose key is still missing after the history walk
 * ended. A group this device never held anything of is a predecessor it
 * joined after, so its rows are "sent before this device joined"; the rest
 * is `markerForError`.
 */
function markerAfterWalk(e: unknown): ProtectedMarkerKind {
  return neverHeld(nativeErrorOf(e)) ? "sent_before_join" : markerForError(e);
}

/** Native `FileMeta` (mls/text/types.rs); `fail_reason` absent or a string. */
function isFileMeta(f: unknown): boolean {
  return (
    isRecord(f) &&
    isCount(f.idx) &&
    typeof f.name === "string" &&
    typeof f.mime === "string" &&
    isCount(f.size) &&
    typeof f.state === "string" &&
    (f.fail_reason === undefined || typeof f.fail_reason === "string")
  );
}

// ---------------------------------------------------------------------------
// S4: history ports and the row policy (design 9.5)
// ---------------------------------------------------------------------------

/**
 * What `requestWalk` answers: `imported` (the walk ended and brought keys,
 * retry the decrypt), `floor` (the walk ended without this epoch),
 * `retry_later` (it could not run or finish now; the row stays pending).
 */
export type WalkAnswer = "imported" | "floor" | "retry_later";

/**
 * The S4 members the manager adds beside `GroupOps`. The four lookups are
 * read-only and cost no native call per row. Every one of them is needed
 * for a row without `encrypted` to be anything but the red marker.
 */
export interface HistoryOps {
  /** The local pin's history record (`ProtectedPinSet.historyOf`). */
  pinHistory(channelId: string): { boundary: string; wiped: boolean } | null;
  /** The manager's copy of native `e2ee_text_state`; null until loaded. */
  nativeState(channelId: string): TextChannelState | null;
  /** The last seat list verify failure of the channel; null when none. */
  seatListError(channelId: string): string | null;
  /**
   * The SDK's session view of the pre-protect rows:
   * `client.protectedHistory.isConflicted` / `isWiped`. Either one turns
   * every row without `encrypted` red, whatever native says.
   */
  preHistoryState(channelId: string): { conflicted: boolean; wiped: boolean };
  /** The epoch's keys came from this session's history walk. */
  epochFromWalk(groupId: string, epoch: number): boolean;
  /**
   * True only when the manager KNOWS the group is a predecessor of the
   * channel's group (it followed the chain itself). Optional even with the
   * rest present: without it only the group of `history_floor` counts.
   */
  knownPredecessor?(channelId: string, groupId: string): boolean;
  /** Run (or join) the history walk for a missing epoch. */
  requestWalk(
    channelId: string,
    groupId: string,
    epoch: number,
  ): Promise<WalkAnswer>;
}

/** `GroupOps` plus whatever of `HistoryOps` the caller has. */
export type RowOps = GroupOps & Partial<HistoryOps>;

/**
 * One `decryptHistory` batch. Rows of the batch that miss the same epoch
 * share one walk request and its answer.
 */
export interface WalkBatch {
  readonly answers: Map<string, Promise<WalkOutcome>>;
}

export function newWalkBatch(): WalkBatch {
  return { answers: new Map() };
}

/** What the policy reads for a row without `encrypted`. */
export interface PlainRowInput {
  /** Message id (a ULID). */
  id: string;
  pin: { boundary: string; wiped: boolean } | null;
  native: TextChannelState | null;
  seatListError: string | null;
  conflicted: boolean;
  wiped: boolean;
}

export type PlainRowDecision = "plain" | "checking" | "red";

/**
 * Read the policy inputs of a row without `encrypted`. Null when a lookup
 * is missing, throws or answers something unreadable: the row is then red.
 */
export function plainRowInput(
  ops: RowOps,
  channelId: string,
  id: string,
): PlainRowInput | null {
  if (
    typeof ops.pinHistory !== "function" ||
    typeof ops.nativeState !== "function" ||
    typeof ops.seatListError !== "function" ||
    typeof ops.preHistoryState !== "function"
  ) {
    return null;
  }
  try {
    const pin: unknown = ops.pinHistory(channelId);
    const native: unknown = ops.nativeState(channelId);
    const seatListError: unknown = ops.seatListError(channelId);
    const pre: unknown = ops.preHistoryState(channelId);
    if (
      pin !== null &&
      !(
        isRecord(pin) &&
        typeof pin.boundary === "string" &&
        typeof pin.wiped === "boolean"
      )
    ) {
      return null;
    }
    if (native !== null && !isRecord(native)) return null;
    if (seatListError !== null && typeof seatListError !== "string") {
      return null;
    }
    if (
      !isRecord(pre) ||
      typeof pre.conflicted !== "boolean" ||
      typeof pre.wiped !== "boolean"
    ) {
      return null;
    }
    return {
      id,
      pin: pin === null ? null : { boundary: pin.boundary, wiped: pin.wiped },
      native: native as TextChannelState | null,
      seatListError,
      conflicted: pre.conflicted,
      wiped: pre.wiped,
    } as PlainRowInput;
  } catch {
    return null;
  }
}

/**
 * Design 9.5 for a row without `encrypted`. `plain` is the row policy's
 * arm 3 over `nativeHistoryInput` and nothing else. A channel whose reveal
 * conflicted or whose pre-protect rows the server says were wiped is red
 * before the policy is asked, also while the state is still loading.
 */
export function decidePlainRow(i: PlainRowInput | null): PlainRowDecision {
  if (i === null) return "red";
  if (i.conflicted !== false || i.wiped !== false) return "red";
  try {
    const result = rowPolicy({
      hasEncrypted: false,
      id: i.id,
      pin: i.pin,
      native: nativeHistoryInput(i.native, { seatListError: i.seatListError }),
    });
    switch (result.kind) {
      case "plain":
        return "plain";
      case "checking":
        return "checking";
      case "red":
        return "red";
      // an encrypted row's arm for a row known to carry none: refuse
      case "decrypt":
        return "red";
      default: {
        const _x: never = result;
        return "red";
      }
    }
  } catch {
    return "red";
  }
}

/** An encrypted row's id is at or below the verified boundary. */
function belowBoundaryFrom(
  native: TextChannelState | null,
  seatListError: string | null,
  id: string,
): boolean {
  try {
    const result = rowPolicy({
      hasEncrypted: true,
      id,
      pin: null,
      native: nativeHistoryInput(native, { seatListError }),
    });
    return result.kind === "decrypt" && result.belowBoundary === true;
  } catch {
    return false;
  }
}

function belowBoundaryOf(ops: RowOps, row: ProtectedMessageRow): boolean {
  if (
    typeof ops.nativeState !== "function" ||
    typeof ops.seatListError !== "function"
  ) {
    return false;
  }
  try {
    const native: unknown = ops.nativeState(row.channelId);
    const seatListError: unknown = ops.seatListError(row.channelId);
    if (native !== null && !isRecord(native)) return false;
    if (seatListError !== null && typeof seatListError !== "string") {
      return false;
    }
    return belowBoundaryFrom(
      native as TextChannelState | null,
      seatListError,
      row.id,
    );
  } catch {
    return false;
  }
}

/**
 * Whether a cached view has to be computed again (through `decryptRow`)
 * now that the native state, the pin or the SDK's pre-protect state
 * changed. `input` is `plainRowInput` of the SAME row, read now.
 *
 * - `checking`: as soon as the decision is `plain` or red;
 * - `plain`: as soon as it is anything else (a wipe, a conflict, a state
 *   that is no longer verified);
 * - the red `unencrypted_row`: only when the decision is `plain`, which the
 *   policy gives from a verified state alone; it never goes back to
 *   `checking`;
 * - `ok`: when the row turns out to sit at or below the boundary and the
 *   view does not say so yet (the note is only ever added);
 * - anything else: never.
 */
export function redecide(
  view: ProtectedMessageView,
  input: PlainRowInput | null,
): boolean {
  switch (view.status) {
    case "checking":
      return decidePlainRow(input) !== "checking";
    case "plain":
      return decidePlainRow(input) !== "plain";
    case "marker":
      return (
        view.kind === "unencrypted_row" && decidePlainRow(input) === "plain"
      );
    case "ok":
      return (
        view.belowBoundary !== true &&
        input !== null &&
        belowBoundaryFrom(input.native, input.seatListError, input.id)
      );
    default:
      return false;
  }
}

/** The notes under an `ok` view, in display order (shield `rowNotes`). */
export function okViewNotes(
  view: Extract<ProtectedMessageView, { status: "ok" }>,
): RowNote[] {
  return rowNotes(
    {
      sender_verified: view.senderVerified === true,
      timing_unverified: view.timingUnverified === true,
    },
    {
      belowBoundary: view.belowBoundary === true,
      fromHistory: view.historySender === true,
    },
  );
}

/** The decrypted epoch's keys came from this session's history walk. */
function fromWalkOf(ops: RowOps, d: TextDecrypted): boolean {
  if (typeof ops.epochFromWalk !== "function") return false;
  if (typeof d.group_id !== "string" || !isCount(d.epoch)) return false;
  try {
    return ops.epochFromWalk(d.group_id, d.epoch) === true;
  } catch {
    return false;
  }
}

/**
 * Native's result, checked against the row. `files` is always serialized
 * (876c034): absent, not an array or any element not FileMeta-shaped is a
 * mismatch, never dropped to a count of 0.
 *
 * S4: `timing_unverified` is absent from an older shell, so only a literal
 * true counts. `historySender` follows the shield's rule for the
 * "(history)" sender note: the epoch came from this session's walk, or
 * native says the timing is unverified.
 */
function okView(
  row: ProtectedMessageRow,
  d: TextDecrypted,
  ctx: { belowBoundary: boolean; fromWalk: boolean },
): ProtectedOkView | null {
  if (
    !isRecord(d) ||
    d.message_id !== row.id ||
    d.channel_id !== row.channelId ||
    d.author_user_id !== row.authorId ||
    d.cid !== row.nonce ||
    typeof d.text !== "string" ||
    !Array.isArray(d.replies) ||
    !d.replies.every((r) => typeof r === "string") ||
    !Array.isArray(d.files) ||
    !d.files.every((f) => isFileMeta(f))
  ) {
    return null;
  }
  const timingUnverified = d.timing_unverified === true;
  const view: ProtectedOkView = {
    status: "ok",
    text: d.text,
    replies: [...d.replies],
    senderVerified: d.sender_verified === true,
    tsSkew: d.ts_skew === true,
    cid: d.cid,
    filesUnsupported: d.files.length,
    timingUnverified,
    belowBoundary: ctx.belowBoundary === true,
    historySender: ctx.fromWalk === true || timingUnverified,
  };
  return view;
}

function aheadOfCurrent(err: Record<string, unknown>): boolean {
  return (
    typeof err.epoch === "number" &&
    typeof err.current === "number" &&
    typeof err.group_id === "string" &&
    err.epoch > err.current
  );
}

/**
 * The channel as `walkTrigger` wants it. Without a loaded state nothing is
 * known about the group, which leaves only the routes that need no group.
 * A predecessor is the group of the native `history_floor` when that is not
 * the channel's own group, or one the manager vouches for; never a group
 * taken from the row alone.
 */
function groupViewOf(
  ops: RowOps,
  row: ProtectedMessageRow,
  err: Record<string, unknown>,
): WalkGroupView {
  const rowEpoch =
    row.encrypted !== null && isCount(row.encrypted.epoch)
      ? row.encrypted.epoch
      : null;
  const unknown: WalkGroupView = {
    state: "",
    verdict: "",
    groupId: null,
    epoch: null,
    predecessor: false,
    rowEpoch,
  };
  if (typeof ops.nativeState !== "function") return unknown;
  try {
    const n: unknown = ops.nativeState(row.channelId);
    if (!isRecord(n)) return unknown;
    const groupId = typeof n.group_id === "string" ? n.group_id : null;
    const errGroup = err.group_id;
    let predecessor = false;
    if (typeof errGroup === "string" && errGroup !== groupId) {
      const floor = n.history_floor;
      predecessor =
        (isRecord(floor) && floor.group_id === errGroup) ||
        (typeof ops.knownPredecessor === "function" &&
          ops.knownPredecessor(row.channelId, errGroup) === true);
    }
    return {
      state: typeof n.state === "string" ? n.state : "",
      verdict: typeof n.verdict === "string" ? n.verdict : "",
      groupId,
      epoch: isCount(n.epoch) ? (n.epoch as number) : null,
      predecessor,
      rowEpoch,
    };
  } catch {
    return unknown;
  }
}

/**
 * Ask for the history walk of one missing epoch. A request already in
 * flight for the same channel, group and epoch is joined, and inside a
 * batch the first answer serves every later row. Never rejects.
 */
function requestWalkOnce(
  ops: RowOps,
  port: ProtectedTextPort,
  channelId: string,
  groupId: string,
  epoch: number,
  batch: WalkBatch | null,
): Promise<WalkOutcome> {
  const key = `${channelId}:${groupId}:${epoch}`;
  let flying = walksInFlight.get(ops);
  if (flying === undefined) {
    flying = new Map();
    walksInFlight.set(ops, flying);
  }
  const prior = batch?.answers.get(key) ?? flying.get(key);
  if (prior !== undefined) return prior;
  const mine = flying;
  const p = (async (): Promise<WalkOutcome> => {
    try {
      const answer: unknown = await (ops as HistoryOps).requestWalk(
        channelId,
        groupId,
        epoch,
      );
      if (
        answer === "imported" ||
        answer === "floor" ||
        answer === "retry_later"
      ) {
        return answer;
      }
    } catch {
      // logged below with the unreadable answers
    }
    port.log("error", "[protected] history walk request failed", {
      channelId,
    });
    return "failed";
  })().finally(() => mine.delete(key));
  flying.set(key, p);
  batch?.answers.set(key, p);
  return p;
}

async function decryptOnce(
  ops: RowOps,
  port: ProtectedTextPort,
  row: ProtectedMessageRow,
  live: boolean,
  batch: WalkBatch | null,
): Promise<ProtectedMessageView> {
  const ids = { messageId: row.id, channelId: row.channelId };
  // Design 3.9 step 1 and 9.5: never a native call, never the server's
  // content. Only the row policy lets such a row be anything but red.
  if (row.encrypted === null) {
    const decision = decidePlainRow(plainRowInput(ops, row.channelId, row.id));
    if (decision === "plain") return { status: "plain" };
    if (decision === "checking") return { status: "checking" };
    return marker("unencrypted_row");
  }
  if (row.nonce === null) return marker("malformed");
  const args = {
    channelId: row.channelId,
    messageId: row.id,
    authorUserId: row.authorId,
    nonce: row.nonce,
    encrypted: row.encrypted,
    live,
  };
  const attempt = async (): Promise<ProtectedMessageView> => {
    const d = await port.invoke("e2ee_text_decrypt", args);
    const view = okView(row, d, {
      belowBoundary: belowBoundaryOf(ops, row),
      fromWalk: fromWalkOf(ops, d),
    });
    if (view !== null) return view;
    port.log("error", "[protected] decrypt result mismatch", ids);
    return marker("error");
  };
  const failed = (e: unknown, kind: ProtectedMarkerKind) => {
    port.log("warn", "[protected] decrypt failed", { ...ids, tag: tagOf(e) });
    return marker(kind);
  };
  try {
    return await attempt();
  } catch (e) {
    const err = nativeErrorOf(e);
    const trigger =
      err === null
        ? null
        : walkTrigger(
            err as unknown as NativeError,
            groupViewOf(ops, row, err),
          );
    // Sent after this device was removed: no key will ever come. No walk,
    // no catch-up, no retry.
    if (trigger?.kind === "removed_self") return failed(e, "removed_self");
    if (trigger?.kind === "walk" && typeof ops.requestWalk === "function") {
      // One request per row per call, and at most one retry after it.
      const answer = await requestWalkOnce(
        ops,
        port,
        row.channelId,
        trigger.groupId,
        trigger.missingEpoch,
        batch,
      );
      switch (answer) {
        case "retry_later":
          // Decided by a later walk result, so not a marker yet.
          return { status: "pending" };
        case "imported":
          try {
            return await attempt();
          } catch (e2) {
            return failed(e2, markerAfterWalk(e2));
          }
        case "floor":
          return failed(e, markerAfterWalk(e));
        default:
          return failed(e, "error");
      }
    }
    if (err?.type === "unknown_epoch" && aheadOfCurrent(err)) {
      try {
        await ops.catchUp(
          row.channelId,
          err.epoch as number,
          err.group_id as string,
        );
      } catch {
        port.log("warn", "[protected] catch-up for decrypt failed", ids);
        return marker("decrypt_failed");
      }
      try {
        return await attempt();
      } catch (e2) {
        return failed(e2, markerForError(e2));
      }
    }
    return failed(e, markerForError(e));
  }
}

function tagOf(e: unknown): string {
  const t = nativeErrorOf(e)?.type;
  return typeof t === "string" ? t : "unknown";
}

/**
 * Decrypt one protected row into its view. Concurrent calls for the same
 * message id (and the same `live`) share one native decrypt: an own send
 * arrives as the POST answer AND as the live event. `live` is part of the
 * key so a history decrypt never swallows the live-only removed-sender
 * check (design 3.9 step 9). Never rejects.
 *
 * `opts.batch` (S4): the `WalkBatch` of the `decryptHistory` call the row
 * belongs to, so its rows share one walk request per missing epoch.
 */
export function decryptRow(
  ops: RowOps,
  port: ProtectedTextPort,
  row: ProtectedMessageRow,
  live: boolean,
  opts?: { batch?: WalkBatch },
): Promise<ProtectedMessageView> {
  const key = `${row.id}:${live ? "live" : "history"}`;
  const prior = inflight.get(key);
  if (prior !== undefined) return prior;
  const p = decryptOnce(ops, port, row, live, opts?.batch ?? null)
    .catch(() => marker("error"))
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Test hook: forget in-memory state (never called by the app). */
export function _resetMessageFlowsForTest(): void {
  memo.clear();
  inflight.clear();
  walksInFlight = new WeakMap();
}
