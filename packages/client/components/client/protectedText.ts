/**
 * Protected channels: the text-plane manager (W4 lane B1, plan 4.3).
 *
 * `ProtectedTextManager` drives every S1 flow of design 6.3 for the text
 * plane, separate from the call session: a channel registry, a FIFO lane per
 * channel (every native mutation of a channel's groups runs in it, in
 * order), start/dispose, envelope processing, admission, removal, update
 * cadence, commit-outcome recovery (D20), gap refetch, successor and genesis
 * create (D21), own-device pins (D18), the seat-list verify answers (D24),
 * the start-time first-sight verify of unopened channels (D26) and the
 * start-time resolution of orphaned protected sends (D10, RC NEW-6).
 *
 * It owns no UI: it publishes `onView` / `onMessageView` / `onTimelineMarker`
 * and the bridge (B5) maps them into ReactiveMaps. The owner flows (B2) and
 * message flows (B4) arrive injected as `deps` and drive the manager back
 * through the narrow `GroupOps` surface; this file never imports the flows
 * (S4: only B4's three pure row helpers, `newWalkBatch`, `plainRowInput` and
 * `redecide`).
 *
 * S4 history (W4 lane L2m; design 3.14.6 to 3.14.8, 8.3 "S4", 8.5): the
 * committer's, the successor creator's and the other members' link PUTs,
 * the owner's contest check, the walk behind `HistoryOps.requestWalk`, the
 * history policy callback and the backup refresh count.
 *
 * The server's `history_setting` advert (`port.historySetting()`) gates the
 * WRITES and new activity only (R-W4-31): no link PUT or GET, no walk, no
 * history owner call, no own Update for a setting change and no backup
 * refresh request while it is not true. It never gates the read side: the
 * history policy callback and the row decisions follow the owner-signed
 * state native verified, whatever the advert says, so a reveal is withdrawn
 * and a cached plain row is decided again also while the advert reads off
 * (it reads off after a failed fetch). The advert itself reports nothing:
 * only a native state read does.
 *
 * Rules held everywhere:
 * - Native is authoritative. Nothing here makes a state more trusted; server
 *   answers can only make the manager retry, refetch, refuse or rejoin.
 * - An outcome that is unknown (transport, 5xx, lost response) is never read
 *   as refused or absent (policy A3 decides; this file runs the effects).
 * - Never ack a `text-synth:` id; ack only after durable processing or for
 *   a verdict the policy marks ackable. `toWireEnvelope` before `_process`.
 * - `groupError` never records a message-level tag or `busy`.
 * - Logs carry ids and error tags only (D16), never text, ciphertext or keys.
 * - S7 C9: a native `protector` refusal never reaches a flow. Every text
 *   command, the owner and message flows' included, passes the protector
 *   gate (`#gatedInvoke`, policy `protectorGateStep`); a refused command is
 *   held and re-issued after the back-off, so it is never read as a
 *   failure, a leave or a wipe.
 *
 * Lane rule (no deadlock): a task running in a channel's lane never awaits
 * another task of the same lane. Long waits (submit retries, join windows,
 * staggers) run OUTSIDE the lane and enqueue each native step.
 *
 * Pure module: type-only imports from A1 / e2ee, runtime imports from the
 * pure A3 / A4 / A5 modules. No Solid, livekit, lingui or SDK.
 */
import type {
  MlsClaimedKeyPackage,
  MlsJoinRequest,
  MlsMemberDevice,
  MlsPublishKeyPackages,
  MlsRemovedReason,
} from "./e2ee";
import {
  buildAnswer,
  catchUpDuty,
  classifyLinkPut,
  linkPutPath,
  memberDuty,
} from "./protectedHistoryLinkPolicy.ts";
import {
  type ProbeSource,
  type WalkEnd,
  type WalkPorts,
  type WalkResult,
  isMissingCommandError,
  runWalk,
} from "./protectedHistoryWalk.ts";
import { TEXT_PROTOCOL } from "./protectedPlatform.ts";
import { validReason } from "./protectedRemovalReasonPolicy.ts";
import {
  isSynthTextEnvelopeId,
  removedReason,
  TEXT_SYNTH_ID_PREFIX,
  textEnvelopeFromCommitInfo,
  toWireEnvelope,
} from "./protectedRouter.ts";
import { nativeHistoryInput, ulidTimeMs } from "./protectedRowPolicy.ts";
import {
  type HistoryOwnerNoticeKind,
  computeShieldState,
  historyFloorNotice,
  historyOwnerNotice,
  SHIELD_LOUD_GROUP_ERRORS,
  SHIELD_LOUD_SEAT_LIST_ERRORS,
  shieldInputsFromView,
} from "./protectedShield.ts";
import { TextIdIndex } from "./protectedTextIds.ts";
import {
  type RowOps,
  type WalkAnswer,
  type WalkBatch,
  newWalkBatch,
  plainRowInput,
  redecide,
} from "./protectedTextMessages.ts";
import {
  type LeafMissingBinding,
  type PinOutcome,
  type ProtectorAnswer,
  type ProtectorGate,
  type RefusalPace,
  type RefusalPaceEntry,
  type SendAction,
  type SendContext,
  type SendTrigger,
  type StoredWelcome,
  type SubmitAction,
  type SubmitContext,
  type TextEnvelopeVerdict,
  type WelcomeRefusal,
  ADMIT_REFUSED_CAP,
  admitRefusalKey,
  admitRefusedByNative,
  classifySendAnswer,
  classifySubmit,
  classifyTextEnvelopeError,
  coalescedRefreshReason,
  errorTypeOf,
  holdsCurrentGroup,
  isCatchUpDesync,
  isProtectorError,
  JOIN_RETRIES,
  joinEventResetAllowed,
  joinIntentHeldByOwnerChange,
  joinRebroadcastDelayMs,
  joinRefusal,
  leafMissingApplies,
  leafMissingSigner,
  leafMissingSpent,
  leafStaggerMs,
  mergeRefusalPaceEntry,
  ownAddedEntry,
  parkedReplay,
  parseCommitInfo,
  parseRefusalPaces,
  pinFailureOutcome,
  pinRetryAllowed,
  pinRetryKey,
  PROTECTOR_GATE_OPEN,
  protectorGateAfter,
  protectorGateStep,
  publishBackoffMs,
  REFRESH_INTERVAL_MS,
  REFUSAL_PACE_ENTRIES_MAX,
  refusalPaceAfterGrant,
  refusalRetryable,
  retryAfterMs,
  STORED_ADMIT_REASONS,
  storedJoinRequests,
  WELCOME_FETCH_AFTER_MS,
  welcomeFetchStep,
  welcomeParkedFor,
  welcomePending,
  welcomeRefusalOf,
  welcomeRefusalRejoin,
} from "./protectedTextPolicy.ts";
import type {
  CancelPendingSeatsResult,
  GroupOps,
  HistoryLinkBuilt,
  HistoryLinkWire,
  HistoryStop,
  ManagerState,
  NativeError,
  NativeErrorTag,
  OwnerDeviceNotice,
  PendingSeats,
  ProtectedChannelView,
  ProtectedMarkerKind,
  ProtectedMessageRow,
  ProtectedMessageView,
  ProtectedSeatsResponse,
  ProtectedSendOutcome,
  ProtectedTextGroupResponse,
  ProtectedTextManagerApi,
  ProtectedTextManagerCallbacks,
  ProtectedTextManagerDeps,
  ProtectedTextPort,
  RemoveDevicesOptions,
  SignedAuthority,
  TextApiMethod,
  TextApiResponse,
  TextChannelState,
  TextCommand,
  TextCommandArgs,
  TextCommandResult,
  TextCommitInfo,
  TextCreateGroupBody,
  TextEnvelope,
  TextFlowFailure,
  TextGroupCreated,
  TextJoinIntentBody,
  TextLogIds,
  TextProcessOutcome,
  TextRefreshReason,
  TextSubmitCommitPayload,
  TextWireEnvelope,
  ViewErrorTag,
} from "./protectedTextTypes";
import { NATIVE_ERROR_TAGS } from "./protectedTextTypes.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** D26: first-sight verifies of unopened channels, spacing and rate. */
export const FIRST_SIGHT_STAGGER_MS = 500;
export const FIRST_SIGHT_PER_MINUTE = 20;

/**
 * Binding note (W4b addendum): a FIRST-submit 403 on a commit refetch is
 * never a desync (policy retries it), so it must not retry forever. After
 * this many consecutive 403s the commit is PARKED (its native stage is kept,
 * its outcome stays unknown) and resumed on the next D8 refresh.
 */
export const REFETCH_403_PARK_BUDGET = 3;

/** Retries of a held envelope (`hold` verdict) before it is left unacked. */
export const HOLD_RETRY_BUDGET = 5;

/** Gap-refetch pages per catch-up call. */
export const CATCH_UP_ROUND_BUDGET = 16;

/** Retries of `POST /mls/groups` after a 429/5xx/transport answer. */
export const CREATE_RETRY_BUDGET = 8;

/**
 * 429 answers to one join KeyPackage `PUT /mls/key_packages` waited out
 * before that join attempt counts as failed (then a fresh `_join`).
 */
export const KEY_PACKAGE_PUT_429_BUDGET = 5;

/**
 * Reads of the stored row after a plain 2xx `Won` before the commit is
 * parked (stage kept, `_commit_won` not called) until the next refresh.
 */
export const WON_ROW_READ_BUDGET = 8;

/** Orphan confirm retries (confirm_later) before it waits for next start. */
export const ORPHAN_CONFIRM_BUDGET = 5;

/** `limit` of the orphan confirm query; passed to the policy as pageLimit. */
export const CONFIRM_PAGE_LIMIT = 100;

/** D10 storage key prefix of a stored protected send. */
export const PROTECTED_SEND_KEY_PREFIX = "protected-send:";

/**
 * W4d N1: storage key prefix (`<prefix><userId>:<groupId>`) of the FULL
 * submit body (commit, welcome, added/removed declarations) of this
 * device's staged own commit, written before the POST and dropped once
 * the stage is resolved. Handshake bytes only, never message plaintext.
 */
export const PROTECTED_STAGE_KEY_PREFIX = "protected-stage:";

/**
 * FXT M1: storage key prefix (`<prefix><userId>:<channelId>`) of the users
 * a recovery PUT was refused for (`SeatListNamesRemovedUsers.users`), keyed
 * to the served list version the refused bytes were signed over. Ids only.
 */
export const PROTECTED_RECOVERY_REFUSED_KEY_PREFIX =
  "protected-recovery-refused:";

/**
 * S4 (B6): storage key prefix (`<prefix><userId>:<channelId>`) of the
 * `history` line an owner device saw the channel's current epoch begin
 * under: `{ g: group id, s: "visible" | "hidden" }`. It outlives a restart,
 * so a setting change that landed just before one is still followed by
 * this device's Update. Ids and the setting only; written when either
 * changes. Deleted by `forgetChannel` (one channel) and by
 * `forgetHistoryLines` (every channel of this user, for a sign-out).
 */
export const PROTECTED_HISTORY_EPOCH_KEY_PREFIX = "protected-history-epoch:";

/**
 * FXP F-L6 (M1a): storage key prefix (`<prefix><userId>:<channelId>`) of
 * the pace of refused-Welcome rejoins per (group, refused device), so a
 * reload or a manager rebuild never restarts it. Ids and times only.
 */
export const PROTECTED_REFUSAL_PACE_KEY_PREFIX =
  "protected-welcome-refusal-pace:";

/**
 * FXP F-L6 (MJ-1): the e2ee bridge caches the own-device listing this long
 * (`#protectedOwnListing`) and serves the cached one when a refresh fails;
 * an entry older than this was served after a failed fetch.
 */
const OWN_LISTING_FRESH_MS = 60_000;

/**
 * FXP F-L6 (m-b, MJ-1): the refreshes on which a refused Welcome's join
 * block may lift (every grant paced by the persisted window): an open, the
 * user's `retryNow`, a commit and a `ProtectedChannelChanged`.
 */
const REFUSAL_GRANT_REASONS: readonly TextRefreshReason[] = [
  "open",
  "manual",
  "commit",
  "event",
];

/**
 * F-L13: after this device's join intent went out (or its stored intent was
 * first seen), a member may be admitting it for this long. A join run sends
 * no intent of its own meanwhile (`joinIntentHeld`): an intent created
 * after the Add of this device lands reads as a rejoin, members evict the
 * fresh leaf citing it, and native poisons the group on this device.
 */
export const JOIN_ADMIT_WINDOW_MS = 60_000;

/** Decrypted views remembered for cache-restore re-requests. */
const VIEW_CACHE_MAX = 5_000;

/** Envelope ids remembered as processed (dedup). */
const SEEN_MAX = 4_096;

/**
 * Tags that describe ONE message (or a sign/encrypt-only refusal), never the
 * channel. Binding note: never recorded as `groupError` (design 9.1:
 * message-level errors never change the shield). Unexpected from `_process`;
 * the envelope is held and logged.
 */
export const MESSAGE_LEVEL_TAGS: readonly NativeErrorTag[] = [
  "unknown_epoch",
  "unknown_sender",
  "removed_sender",
  "replay",
  "malformed_text_payload",
  "update_required",
  "not_seated",
  "seat_list_behind",
  "handover_target_invalid",
];

/**
 * W4d X#1: loud poisoned-path `groupError` tags are STICKY per group. They
 * are the design 9.1 step-3 `groupError` list (the commit-AD pre-check and
 * the step-6 commit checks of 3.12.3), which carries `seat_list_rollback`
 * since S2 (the same AD pre-check). A benign tag (`mls_poisoned_epoch`
 * from the next envelope of the poisoned group, a dropped duplicate) never
 * overwrites one and a processed `duplicate` / `commit_applied` never
 * clears one; only joining a HIGHER generation of the channel does (a
 * `welcome_joined` into the successor, or this device's own successor
 * create accepted by the server, D21). `owner_changed` is not sticky: it
 * has its own defined reset (the D15 owner-change confirm), and native's
 * `owner_changed` verdict keeps step 3 loud until then.
 */
export const STICKY_GROUP_ERRORS: readonly NativeErrorTag[] =
  SHIELD_LOUD_GROUP_ERRORS.filter((t) => t !== "owner_changed");

/**
 * S2 (g): `ProtectedChannelChanged` events for one channel inside this
 * window cost ONE refresh (a seat PUT emits seats and text_group changes
 * back to back).
 */
export const CHANNEL_CHANGED_COALESCE_MS = 250;

/**
 * Re-sends (and re-reads) of the recovery seat list after a 429 / 5xx /
 * transport, per `recoverOwnership` call. Past it the call rejects and the
 * stored list stays for the next call (FX-R, 4.9).
 */
export const RECOVERY_PUT_RETRY_BUDGET = 8;

/**
 * W4d X#3: re-GETs of `.../seats` when the snapshot under verify is older
 * than the held group epoch and native answers `seat_list_rollback` (the
 * snapshot is stale, never a rollback). Past this the answer is dropped.
 */
export const STALE_SEATS_REFETCH_BUDGET = 2;

/** S4: `limit` of a history link page for the walk (the server's maximum). */
export const HISTORY_LINK_PAGE = 200;

/**
 * S4: `limit` when one holder's candidates are wanted. The server's minimum;
 * it never splits an epoch, so the newest holder below `before` is whole.
 */
export const HISTORY_LINK_PAGE_ONE = 5;

/** S4 owner contest check: the newest holders with stored links it opens. */
export const OWNER_CHECK_HOLDERS = 5;

/**
 * S4 (design 8.5 "Refresh"): new epoch rows (imported by a walk, or a
 * processed commit or Welcome) between two backup refresh requests.
 */
export const BACKUP_REFRESH_EPOCHS = 20;

/** S4: stored commit rows asked for at once while a walk goes down. */
const WALK_COMMIT_WINDOW = 8;

/** S4: walks of other requests one walk request sits out before it defers. */
const WALK_JOIN_ROUNDS = 8;

/** S4: epochs remembered as imported by this session's walks. */
const WALKED_MAX = 20_000;

/** S4 (A4): groups of one channel whose `oldest_held` is remembered. */
const OLDEST_HELD_MAX = 16;

/**
 * S4 (R-W4-41): own Updates one session starts for one
 * `group:epoch:setting` of a channel: the first and two retries, each on a
 * later state read.
 */
export const HISTORY_UPDATE_TRIES = 3;

/** S4 (R-W4-41): states of one channel whose own Updates are counted. */
const HISTORY_UPDATE_STATES_MAX = 64;

/**
 * S4 (design 9.2 "S4"): the owner flow's client reasons that L1s
 * `historyOwnerNotice` places (today: inline in the settings page).
 */
const OWNER_HISTORY_REASONS: readonly HistoryOwnerNoticeKind[] = [
  "protect_busy",
  "wipe_refused",
  "clock_behind",
];

// ---------------------------------------------------------------------------
// Optional bridge extensions (B5 supplies them; read by feature detection)
// ---------------------------------------------------------------------------

/**
 * Port extras the manager needs for the D10 orphan scan. A1's port has no
 * key enumeration and no view of the Draft outbox, so B5 adds these to the
 * port object it passes. Without `storeKeys` the orphan scan cannot run and
 * the manager logs an error at start.
 */
export interface ProtectedTextPortExtensions {
  /** Every stored key starting with `prefix` (localStorage scan). */
  storeKeys(prefix: string): string[];
  /** Outbox keys owned by a live Draft outbox entry (never orphans). */
  liveOutboxKeys(): ReadonlySet<string>;
}

/**
 * Callback extras (optional): D12 replenish after this device's Welcome;
 * S2 (h) every group id native or the server reported for a channel, so
 * the bridge's routing index holds it before any join or process for it
 * (called only after the manager's own index accepted it).
 */
export interface ProtectedTextManagerExtraCallbacks {
  onWelcomeJoined(channelId: string, groupId: string): void;
  onGroupReported(channelId: string, groupId: string, generation: number): void;
}

/**
 * S4 deps the bridge may pass beside `ProtectedTextManagerDeps` (read by
 * feature detection). `pinHistory`: the local pin's history record, null
 * when none. `preHistoryState`: the SDK's conflict and wipe latches of the
 * channel's pre-protect rows; without it they are unknown, so every row
 * without `encrypted` stays red (R-W4-26).
 */
export interface ProtectedTextHistoryDeps {
  pinHistory(channelId: string): { boundary: string; wiped: boolean } | null;
  preHistoryState(channelId: string): { conflicted: boolean; wiped: boolean };
}

// ---------------------------------------------------------------------------
// Small helpers
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

const FAILURE_SOURCES = ["native", "server", "transport", "client"];

function isFlowFailure(e: unknown): e is TextFlowFailure {
  return (
    isRecord(e) &&
    typeof e.source === "string" &&
    FAILURE_SOURCES.includes(e.source)
  );
}

/** The typed native error inside `err` (raw or wrapped), or null. */
function nativeErrorOf(err: unknown): NativeError | null {
  if (!isRecord(err)) return null;
  if (err.source === "native") return nativeErrorOf(err.error);
  return typeof err.type === "string" ? (err as unknown as NativeError) : null;
}

/** The view tag of an error: a known native tag, else "unknown". */
function viewTagOf(err: unknown): ViewErrorTag {
  const t = nativeErrorOf(err)?.type;
  return typeof t === "string" &&
    (NATIVE_ERROR_TAGS as readonly string[]).includes(t)
    ? (t as NativeErrorTag)
    : "unknown";
}

function clientFailure(reason: string): TextFlowFailure {
  return { source: "client", reason };
}

/**
 * S7 C9: `port` with only `invoke` replaced, for the owner and message
 * flows, so their commands (the per-message decrypt included) pass the
 * manager's protector gate. Every other member, the optional extensions
 * included, is read from `port` itself and called on it.
 */
function withInvoke(
  port: ProtectedTextPort,
  invoke: ProtectedTextPort["invoke"],
): ProtectedTextPort {
  return new Proxy(port, {
    get(target, prop) {
      if (prop === "invoke") return invoke;
      const v: unknown = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

const DISPOSED: TextFlowFailure = { source: "client", reason: "disposed" };

function isDisposed(e: unknown): boolean {
  return isFlowFailure(e) && e.source === "client" && e.reason === "disposed";
}

function toFailure(err: unknown): TextFlowFailure {
  if (isFlowFailure(err)) return err;
  const n = nativeErrorOf(err);
  if (n) return { source: "native", error: n };
  return clientFailure("unexpected");
}

function serverFailure(r: TextApiResponse): TextFlowFailure {
  return {
    source: "server",
    status: r.status,
    type: errorTypeOf(r.body),
    body: r.body,
  };
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function str(v: unknown): v is string {
  return typeof v === "string";
}

function int(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/** `GET .../seats` body, shape-checked (never trusted for anything else). */
function parseSeats(body: unknown): ProtectedSeatsResponse | null {
  if (!isRecord(body) || !Array.isArray(body.seats)) return null;
  const l = body.list;
  if (l !== null) {
    if (
      !isRecord(l) ||
      !str(l.body) ||
      !str(l.signature) ||
      !str(l.signer_user_id) ||
      !str(l.signer_device_id) ||
      !int(l.version)
    ) {
      return null;
    }
  }
  if (body.as_of_epoch !== null && !int(body.as_of_epoch)) return null;
  if (body.as_of_group_id !== null && !str(body.as_of_group_id)) return null;
  const gen = body.as_of_generation;
  if (gen !== undefined && gen !== null && !int(gen)) return null;
  return body as unknown as ProtectedSeatsResponse;
}

/**
 * F-L4b: a served list's `authority` by the owner flow's rule
 * (`parseAuthority` in protectedTextOwner.ts, not exported, mirrored):
 * absent or null = none, `{ body, signature }` strings = those two fields
 * copied, anything else = malformed (undefined). Never the served object.
 */
function servedAuthority(v: unknown): SignedAuthority | null | undefined {
  if (v === undefined || v === null) return null;
  if (isRecord(v) && str(v.body) && str(v.signature)) {
    return { body: v.body, signature: v.signature };
  }
  return undefined;
}

/**
 * F-L4 + FXT M1 (W4d N3, `serverRemovedSeatIds`): the recovery list's
 * seats, in the held order. A held user is left off ONLY on positive
 * evidence that the server released them: released and cooling (in
 * `cooling[]`, not in `seats[]`), or named by a `SeatListNamesRemovedUsers`
 * refusal of a recovery PUT signed over this same served list version
 * (`refused`). Mere absence from `seats[]` never drops anyone: a server
 * could omit a member from this read alone and have the owner sign them
 * away behind a dialog that never names them. `self` is always kept, and a
 * user the held list does not name is never added. null when `seated` or
 * `cooling` is not well-formed (nothing is guessed from it).
 */
export function recoverySeats(
  held: readonly string[],
  snapshot: { seats?: unknown; cooling?: unknown },
  self: string,
  refused: readonly string[],
): string[] | null {
  const seated = snapshot.seats;
  if (!Array.isArray(seated)) return null;
  const active = new Set<string>();
  for (const s of seated) {
    if (!isRecord(s) || !str(s.user_id)) return null;
    active.add(s.user_id);
  }
  const cooling = new Set<string>();
  const rows = snapshot.cooling ?? [];
  if (!Array.isArray(rows)) return null;
  for (const c of rows) {
    if (!isRecord(c) || !str(c.user_id)) return null;
    cooling.add(c.user_id);
  }
  const released = (u: string) =>
    (cooling.has(u) && !active.has(u)) || refused.includes(u);
  return held.filter((u) => u === self || !released(u));
}

/**
 * FXT M1: the users of a recovery PUT refused with 400
 * `SeatListNamesRemovedUsers { users }`, or null for any other failure. A
 * malformed `users` is null (nothing is recorded from it).
 */
function removedUsersRefusal(err: unknown): string[] | null {
  if (
    !isRecord(err) ||
    err.source !== "server" ||
    err.status !== 400 ||
    err.type !== "SeatListNamesRemovedUsers" ||
    !isRecord(err.body)
  ) {
    return null;
  }
  const users = err.body.users;
  if (!Array.isArray(users) || users.length === 0) return null;
  if (!users.every((u) => str(u))) return null;
  return users as string[];
}

/**
 * F-L13: whether a join run may send an intent now. Held while this
 * device's own intent is stored on the server (`ownIntentStored`) and was
 * sent or first seen less than `JOIN_ADMIT_WINDOW_MS` ago (`sinceMs`): a
 * member may be admitting it right now. Released once the window passes
 * with no Add. A clock that is not finite or reads before `sinceMs` does
 * not hold (never a join that waits for good). An Add that already landed
 * is the run's Welcome path, not a hold (FXT2: `addPending` dropped, no
 * caller ever set it).
 */
export function joinIntentHeld(i: {
  ownIntentStored: boolean;
  sinceMs: number | null;
  nowMs: number;
}): boolean {
  if (!i.ownIntentStored || i.sinceMs === null) return false;
  const age = i.nowMs - i.sinceMs;
  return Number.isFinite(age) && age >= 0 && age < JOIN_ADMIT_WINDOW_MS;
}

/**
 * F-L13: the `key_package_ref` of this device's own stored intent in
 * `text_group.join_requests`, or null (none, or not readable).
 */
function ownStoredIntentRef(
  g: { join_requests?: unknown } | null,
  userId: string,
  deviceId: string,
): string | null {
  const raw = g?.join_requests;
  if (!Array.isArray(raw)) return null;
  for (const r of raw) {
    if (
      isRecord(r) &&
      r.user_id === userId &&
      r.device_id === deviceId &&
      str(r.key_package_ref)
    ) {
      return r.key_package_ref;
    }
  }
  return null;
}

/**
 * A stored row's `removed_reasons` by the router's rule (`removedReason`):
 * absent or null is the DS's empty vector; anything malformed is null
 * (never defaulted to `[]`, OR-5).
 */
function labelsOf(v: unknown): MlsRemovedReason[] | null {
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

const OWNER_NOTICE_KINDS: readonly string[] = [
  "dropped_this_device",
  "changed_by_other",
  "seated_by_other",
];

/** An `owner_notice` as native reports it, or null (absent / malformed). */
function ownerNoticeOf(v: unknown): OwnerDeviceNotice | null {
  if (
    !isRecord(v) ||
    !str(v.kind) ||
    !OWNER_NOTICE_KINDS.includes(v.kind) ||
    !str(v.device_id) ||
    !Array.isArray(v.seated) ||
    !v.seated.every(str)
  ) {
    return null;
  }
  return {
    kind: v.kind as OwnerDeviceNotice["kind"],
    device_id: v.device_id,
    seated: [...v.seated],
  };
}

/**
 * S2 rule 3a (b): the server's `pending_device_removals` of `g`, minus this
 * device and minus the held list's signer device (rule g; native re-checks
 * both and that each target holds a leaf). Malformed entries are skipped.
 */
function pendingDeviceTargetsOf(
  g: ProtectedTextGroupResponse | null,
  n: TextChannelState,
  selfUserId: string,
  selfDeviceId: string,
): MlsMemberDevice[] {
  const raw: unknown = g?.pending_device_removals;
  if (!Array.isArray(raw)) return [];
  const signer = n.seat_list;
  const out: MlsMemberDevice[] = [];
  for (const p of raw) {
    if (!isRecord(p) || !str(p.user_id) || !str(p.device_id)) continue;
    if (p.user_id === selfUserId && p.device_id === selfDeviceId) continue;
    if (
      signer !== null &&
      p.user_id === signer.signer_user_id &&
      p.device_id === signer.signer_device_id
    ) {
      continue;
    }
    out.push({ user_id: p.user_id, device_id: p.device_id });
  }
  return out;
}

/** `GET /mls/channels/:id/text_group` body, shape-checked. */
function parseTextGroup(body: unknown): ProtectedTextGroupResponse | null {
  if (
    !isRecord(body) ||
    !str(body.group_id) ||
    !int(body.generation) ||
    !int(body.current_epoch) ||
    !Array.isArray(body.members) ||
    !Array.isArray(body.pending_removals) ||
    !Array.isArray(body.member_added)
  ) {
    return null;
  }
  return body as unknown as ProtectedTextGroupResponse;
}

/** `ResponseFetchMlsCommits.commits`, or null when malformed. */
function parseCommitRows(body: unknown): TextCommitInfo[] | null {
  if (!isRecord(body) || !Array.isArray(body.commits)) return null;
  const rows: TextCommitInfo[] = [];
  for (const r of body.commits) {
    if (
      !isRecord(r) ||
      !str(r.group_id) ||
      !int(r.epoch) ||
      !str(r.commit) ||
      !isRecord(r.committer)
    ) {
      return null;
    }
    rows.push(r as unknown as TextCommitInfo);
  }
  return rows;
}

/**
 * W4d X#5: a send refused with `ProtectedChannelResecuring { reason:
 * "not_member" }` (the DS holds no leaf of this device in the group).
 */
function isNotMemberRefusal(err: unknown): boolean {
  return (
    isFlowFailure(err) &&
    err.source === "server" &&
    err.type === "ProtectedChannelResecuring" &&
    isRecord(err.body) &&
    err.body.reason === "not_member"
  );
}

/**
 * W4d X#4: the delivered own send as a row for ONE native decrypt, built
 * from the server row itself and only when it names this channel, this
 * user, the send's id and cid, and carries `encrypted` (B4 already checked
 * that payload equals the bytes sent). Null otherwise: no view is made.
 */
function ownRowOf(
  out: ProtectedSendOutcome,
  channelId: string,
  selfUserId: string,
): ProtectedMessageRow | null {
  const raw = out.raw;
  if (
    !isRecord(raw) ||
    raw._id !== out.messageId ||
    raw.channel !== channelId ||
    raw.author !== selfUserId ||
    raw.nonce !== out.cid ||
    !isRecord(raw.encrypted)
  ) {
    return null;
  }
  return {
    id: out.messageId,
    channelId,
    authorId: selfUserId,
    nonce: out.cid,
    encrypted: raw.encrypted as unknown as ProtectedMessageRow["encrypted"],
  };
}

/**
 * This device's position in the held roster, used as its leaf index for the
 * D19 stagger. GUESS (W3 cross-check): `TextChannelState.members` is
 * reported in leaf order; native exposes no leaf index.
 */
function ownLeafIndex(n: TextChannelState, user: string, dev: string): number {
  const i = n.members.findIndex(
    (m) => m.user_id === user && m.device_id === dev,
  );
  return i < 0 ? 0 : i;
}

// ---------------------------------------------------------------------------
// Per-channel record
// ---------------------------------------------------------------------------

interface JoinState {
  promise: Promise<void>;
  welcome: Deferred;
  cancelled: boolean;
  /**
   * S2-D28: the channel's ONE join timer (`#joinWait`), aborted on every
   * exit of the wait, on dispose and by a backoff reset.
   */
  wait: AbortController | null;
  /** Set by a backoff reset while `wait` is armed (it re-arms shorter). */
  reset: boolean;
  /** Re-broadcast waits since the join started or was reset. */
  backoff: number;
}

/**
 * What the S2-D29 stored-Welcome path did. "held": native was busy and the
 * synthetic Welcome is never retried by `#hold`. "parked" (FXF): it waits
 * behind an owner change (D15), never "processed".
 */
type StoredWelcomeResult =
  | "joined"
  | "rejoin"
  | "processed"
  | "held"
  | "parked"
  | "unavailable";

/** A sticky loud `groupError` (W4d X#1) and the group it poisoned. */
interface StickyGroupError {
  tag: ViewErrorTag;
  groupId: string;
  /** Generation of `groupId`; Infinity when unknown (never cleared). */
  generation: number;
}

interface ChannelRec {
  id: string;
  seatListError: ViewErrorTag | null;
  groupError: ViewErrorTag | null;
  /** Set while `groupError` is a sticky loud tag (W4d X#1). */
  stickyGroupError: StickyGroupError | null;
  native: TextChannelState | null;
  serverGroup: ProtectedTextGroupResponse | null;
  /** The last text_group GET answered a definitive 404. */
  serverGroupMissing: boolean;
  seats: ProtectedSeatsResponse | null;
  rosterMismatchSinceMs: number | null;
  signerLeafMissingRetries: number;
  /**
   * FXF: the group and held signer `signerLeafMissingRetries` counts for
   * (null: nothing counted). Another server group or signer resets it.
   */
  signerLeafMissingOn: LeafMissingBinding | null;
  welcomeRetriesExhausted: boolean;
  ownerChangePending: boolean;
  recreateAvailable: boolean;
  publishInFlight: boolean;
  maybeUnsent: boolean;
  /** The server stripped the flag of this pinned channel (D1). */
  stripped: boolean;
  /** Envelopes parked behind an owner change, in arrival order (D15). */
  parked: TextWireEnvelope[];
  /**
   * FXP F-L7: the parked envelopes each running confirm took out of
   * `parked` and is replaying (by confirm token; n4), so the join still
   * sees its Welcome as parked while a replay runs.
   */
  replaying: Map<number, TextWireEnvelope[]>;
  /**
   * FXP F-L6 (M2): the last Welcome native refused (`mls_leaf_rejected`),
   * for (group, refused device). The loud alarm: the view shows it red
   * (`#view`) until native accepts a Welcome or commit for that group,
   * whatever a rejoin grant unblocks. Never blocks a join by itself.
   */
  welcomeRefusal: WelcomeRefusal | null;
  /**
   * FXP F-L7 (m3): the Welcome (group, epoch) native last discarded with
   * `signer_leaf_missing` for the server's current group.
   */
  slmSeen: { groupId: string; epoch: number } | null;
  /**
   * FXP F-L7 (MJ-3, m3-1, residual 3): envelopes were parked while native
   * held a same-user pending signer (an `owner_changed` commit, a
   * `signer_leaf_missing` Welcome, and whatever queued behind them). When a
   * state read then shows that signer gone without a confirm (a list
   * adopted), the parked queue is replayed (`#replayIfSettled`).
   */
  parkedUnderPending: boolean;
  /** FXP F-L7: a confirm is re-verifying (its own replay follows). */
  confirmInFlight: boolean;
  /** FXP F-L7 (MJ-3): a replay after a settled owner change is running. */
  settledReplay: boolean;
  /**
   * FXP F-L6 (MJ-2): the newer Add (`ownAddedEntry().key`) a `newer_add`
   * lifted the refusal's join block for, and that block.
   */
  refusalLift: { addKey: string; sticky: StickyGroupError } | null;
  /** FXP F-L6 (MJ-2): the newer Add whose Welcome path was tried. */
  newerAddTried: string | null;
  openCtl: AbortController | null;
  join: JoinState | null;
  /** `text_group.current_epoch` when this device last sent a join intent. */
  joinFromEpoch: number | null;
  refreshing: Promise<void> | null;
  refreshAgain: boolean;
  /** FX-J2 NEW-5: the strongest reason of the calls coalesced meanwhile. */
  refreshAgainReason: TextRefreshReason | null;
  removalInFlight: boolean;
  /** The in-flight Update; later callers await it (W4b audit M1). */
  updating: Promise<void> | null;
  successorInFlight: boolean;
  /** The in-flight re-run of an unaccepted create (D21 crash recovery). */
  recreating: Promise<void> | null;
  seeded: boolean;
  /**
   * S2 (f): this device's own join intent was refused for capacity
   * (`joinRefusal`, OR-11). Cleared by an accepted intent, a Welcome or a
   * `ProtectedChannelChanged`; while set, refreshes do not re-join on
   * their own (only an open or the event does).
   */
  capacity: ProtectedChannelView["capacity"];
  /**
   * S4 floor (a): `ProtectedClientOutdated.min`. While set, no join intent
   * and no create is sent for the channel (until reload).
   */
  clientOutdated: number | null;
  /** S2 (i): the last one-shot owner notice. */
  ownerNotice: OwnerDeviceNotice | null;
  /** S2-D36: when the shield entered `resecuring` (see `#emit`). */
  resecuringSinceMs: number | null;
  /** OR-10: the same-user signer device this device just confirmed. */
  confirmedSigner: string | null;
  /** OR-10: Review withheld for `deviceId` while `key` is unchanged. */
  ownerChangeUnlisted: { deviceId: string; key: string } | null;
  /** S2 (g): a coalesced `ProtectedChannelChanged` refresh is pending. */
  changePending: boolean;
  /** S2: a `retryNow` refresh was asked for and has not settled. */
  manualPending: boolean;
  /**
   * S2-D29: the `member_added` observation (`ownAddedEntry().key`) whose
   * ONE stored-Welcome path ran (a 404, a Welcome native processed without
   * a join, a busy hold, or nothing usable). That Add is never fetched
   * again; the join re-broadcasts its intent on the backoff (FX-J2 NEW-1).
   */
  welcomeDone: string | null;
  /** FX-J2 NEW-2: when an event last restarted the join backoff. */
  joinEventResetAtMs: number | null;
  /** S2-D29: the stored-Welcome fetch in flight (one per channel). */
  welcomeFetch: Promise<StoredWelcomeResult> | null;
  /** S2-D28: the admission pass over stored `join_requests` in flight. */
  storedAdmit: Promise<void> | null;
  /** F-L13: `port.now()` when this device's last join intent was taken. */
  lastIntentAtMs: number | null;
  /** F-L13: the KeyPackage ref of that intent (FXT2: its exact window). */
  lastIntentRef: string | null;
  /**
   * F-L13: this device's own stored intent (`join_requests`) by its
   * KeyPackage ref, and when this manager first saw it; null when none.
   */
  ownIntentSeen: { ref: string; atMs: number } | null;
  /**
   * FXT M1: the served list version the current `recoverOwnership` call
   * signed its recovery list over; null outside a call or before the sign.
   */
  recoverySignedOver: number | null;
  /**
   * S4: ends this channel's history waits (duty staggers, link PUT
   * backoffs) and its walk. Aborted on dispose and when the channel leaves
   * the protected set (`flagStripped`), which also arms a fresh one.
   */
  historyCtl: AbortController;
  /** S4: the channel's ONE running history walk; requests join it. */
  walk: Promise<WalkEnd> | null;
  /** S4: `ProtectedChannelView.historyWalk`. */
  historyWalk: ProtectedChannelView["historyWalk"];
  /**
   * S4: where a walk of this session stopped. A missing epoch below it is
   * answered without another walk, until `walkHistory` asks again.
   */
  walkFloor: { groupId: string; epoch: number } | null;
  /**
   * S4: the channel's `history_floor` marker. `atMs` is where it was last
   * raised (R-W4-32); null while no loaded row places it, and then it was
   * not raised yet.
   */
  floorMarker: {
    groupId: string;
    epoch: number;
    stop: HistoryStop;
    atMs: number | null;
  } | null;
  /**
   * S4 (A4): per group, `oldest_held` of the last `unknown_epoch` a row
   * decrypt of this channel answered: the first epoch of this device's
   * current membership run there, where a walk for a lower epoch starts.
   */
  oldestHeld: Map<string, number>;
  /**
   * S4 (C4): where the walk that last ended `retry_later` started. A
   * `walkHistory` in that state starts there again.
   */
  walkRetry: { groupId: string; holderEpoch: number } | null;
  /**
   * S4 (B6): the `history` line the held list carried when this device
   * first read the current epoch (`setting` null: no line known). A later
   * read of the same epoch with another line means the epoch began under
   * the old setting.
   */
  historyEpoch: {
    groupId: string;
    epoch: number;
    setting: string | null;
  } | null;
  /**
   * S4 (B6): `group:setting` of the line this session knows to be in the
   * store for this channel; null while none is, or it is not known.
   */
  historyLineKept: string | null;
  /**
   * S4 (R-W4-41): own Updates started this session, by the state they were
   * for (`group:epoch:setting`); never more than `HISTORY_UPDATE_TRIES`.
   */
  historyUpdateTries: Map<string, number>;
  /** S4 (R-W4-41): an own Update of `#historyUpdateOwed` is running. */
  historyUpdateBusy: boolean;
  /**
   * S4 (R-W4-39): the ULID time of the oldest row of this channel native
   * decrypted this session; the floor marker is never raised above it.
   */
  oldestOkMs: number | null;
  /** S4: the history policy last reported through `onHistoryPolicy`. */
  policySent: string | null;
  /** S4: the row policy inputs the cached plain / checking views rest on. */
  rowInputs: string | null;
  /** S4: member duties waiting or running, by `group:epoch`. */
  duties: Set<string>;
  /** S4: the holders a running catch-up applied (one duty pass after it). */
  caughtUp: { groupId: string; from: number; to: number } | null;
  /** S4: an owner contest check is running. */
  ownerCheck: boolean;
}

type ProcessResult = "ok" | "held" | "parked" | "dropped";

/** S4: where an outcome came from (decides the history link duty). */
type OutcomeOrigin = "live" | "catch_up" | "won";

type SubmitResult =
  | "won"
  | "lost"
  | "restage"
  | "await_removal"
  | "left"
  | "parked";

// ---------------------------------------------------------------------------
// The manager
// ---------------------------------------------------------------------------

export class ProtectedTextManager implements GroupOps, ProtectedTextManagerApi {
  readonly #port: ProtectedTextPort;
  readonly #cb: ProtectedTextManagerCallbacks;
  readonly #deps: ProtectedTextManagerDeps;
  readonly #abort = new AbortController();
  readonly #index = new TextIdIndex();
  readonly #channels = new Map<string, ChannelRec>();
  readonly #lanes = new Map<string, Promise<void>>();
  /** Envelope ids processed or acked (dedup), insertion-ordered. */
  readonly #seen = new Set<string>();
  /** Envelope ids queued, held or parked (dedup of redeliveries). */
  readonly #queued = new Set<string>();
  readonly #holds = new Map<string, number>();
  readonly #admitting = new Set<string>();
  /**
   * FX-J2 NEW-3: join requests native `_admit` refused this session
   * (`admitRefusalKey`), insertion-ordered. The stored-intent sweep never
   * claims for them again (each claim burns a KeyPackage of the target).
   */
  readonly #admitRefused = new Set<string>();
  /**
   * FXT M1: the in-memory copy of each channel's recovery refusal record
   * (used when the store write failed; the store copy wins when readable).
   */
  readonly #recoveryRefusedMem = new Map<
    string,
    { version: number; users: string[] }
  >();
  /**
   * FXP F-L6 (M1a): the in-memory copy of each channel's refused-Welcome
   * pace (used when the store write failed; merged with the store copy).
   */
  readonly #refusalPaceMem = new Map<string, RefusalPaceEntry[]>();
  /** FXP F-L7 (n4): the last confirm replay token. */
  #replayTokens = 0;
  /** In-flight decrypts keyed by `id:live` (W4b audit L2). */
  readonly #decrypting = new Set<string>();
  /** Final message views (cache restore re-requests re-emit these). */
  readonly #views = new Map<string, ProtectedMessageView>();
  /**
   * Ids whose cached view came from a LIVE decrypt or from the one native
   * decrypt of an own delivered send (W4d X#4: never the typed plaintext).
   */
  readonly #viewLive = new Set<string>();
  /**
   * W4d X#2: commit flows (stage + submit loop, or a resumed stage) in
   * progress per group id. A persisted stage is resumed only while none is.
   */
  readonly #commitBusy = new Map<string, number>();
  /**
   * The full submit body of the last stage per group (welcome and
   * declarations included), kept while its outcome is unresolved. Used by a
   * resume ONLY when it equals native's persisted stage; native's
   * `_pending_commit` is the authority, so a restart still resumes.
   */
  readonly #stagedPayloads = new Map<string, TextSubmitCommitPayload>();
  /** W4d N4: the resume in flight per group; staging flows await it. */
  readonly #resuming = new Map<string, Promise<boolean>>();
  /** Deleted message ids (`forget`): a late decrypt never re-adds them. */
  readonly #forgotten = new Set<string>();
  /** Group ids whose create this manager POSTed or re-ran (D21 retry). */
  readonly #createPosted = new Set<string>();
  /**
   * Inherited L1s: a `key_packages/claim` answered `InSlowmode` (429) holds
   * admissions into that group until its `retry_after` (never a notice).
   */
  readonly #claimHold = new Map<string, number>();
  readonly #firstSightQueue: ChannelRec[] = [];
  #firstSightRunning = false;
  #firstSightWindowStart = 0;
  #firstSightWindowCount = 0;
  #ownPinsHash: string | null = null;
  #orphanScan: Promise<void> | null = null;
  #orphanScanAgain = false;
  #started = false;
  #disposed = false;
  /** S7 C9: the protector gate every text command passes. */
  #protector: ProtectorGate = PROTECTOR_GATE_OPEN;
  /** Settles when the one command let through a closed gate is answered. */
  #protectorProbe: Promise<void> | null = null;
  /** The port the owner and message flows get: its `invoke` is gated. */
  readonly #flowPort: ProtectedTextPort;
  /**
   * S4: what `decryptRow` gets: `GroupOps` plus B4's `HistoryOps`,
   * whatever the history flag says (R-W4-31: the row policy is read-side).
   * Only `requestWalk` looks at the flag: off, it starts no walk.
   */
  readonly #rowOps: RowOps;
  /** S4: a link PUT answered `disabled` / `outdated`: no more this session. */
  #linksOff = false;
  /** S4: `group:epoch` of every epoch this session's walks imported. */
  readonly #walked = new Set<string>();
  /** S4: per channel, the groups a walk of this session reached below it. */
  readonly #predecessors = new Map<string, Set<string>>();
  /** S4: rows seen (probes, re-runs, the floor marker), newest last. */
  readonly #rows = new Map<string, ProtectedMessageRow>();
  /**
   * S4 (R-W4-39): by message id, the group and epoch NATIVE named when it
   * refused that row's decrypt for a key it does not hold (`unknown_epoch`;
   * `mls_group_not_found` names no epoch). Only these rows place the floor
   * marker. Dropped when the row decrypts or is forgotten.
   */
  readonly #floorRefused = new Map<
    string,
    { groupId: string; epoch: number | null }
  >();
  /** RA5: `forgetHistoryLines` ran; no history line is stored after it. */
  #historyLinesOff = false;
  /** S4: rows a walk left `pending`; re-run when a walk result arrives. */
  readonly #walkPending = new Map<
    string,
    { row: ProtectedMessageRow; live: boolean }
  >();
  /** S4: owner toasts raised this session (`kind:channel:holder`). */
  readonly #ownerToasted = new Set<string>();
  /** S4: new epoch rows since the last backup refresh request. */
  #epochsSinceBackup = 0;
  /** S4: the missing `preHistoryState` dep was logged. */
  #preStateMissingLogged = false;
  /**
   * S4 (R-W4-33): this shell answered a history command as missing. No
   * walk and no link build for the rest of the session; a row that waits
   * for a walk is answered `floor`.
   */
  #noHistoryCommands = false;

  constructor(
    port: ProtectedTextPort,
    cb: ProtectedTextManagerCallbacks,
    deps: ProtectedTextManagerDeps,
  ) {
    this.#port = port;
    this.#cb = cb;
    this.#deps = deps;
    this.#flowPort = withInvoke(
      port,
      <C extends TextCommand>(cmd: C, args: TextCommandArgs[C]) => {
        const run = this.#gatedInvoke(cmd, args);
        if (cmd === "e2ee_text_decrypt") {
          // A4: registered before the flow's own handlers, so a refusal's
          // `oldest_held` is on record when the flow asks for the walk.
          // The flow gets `run` itself: nothing about its answer changes.
          // R-W4-39: the same goes for what the floor marker is placed by,
          // native's answer for this row and never the row's own claim.
          const { channelId, messageId } =
            args as TextCommandArgs["e2ee_text_decrypt"];
          void run.then(
            () => this.#noteDecrypted(channelId, messageId),
            (err: unknown) => {
              this.#noteOldestHeld(channelId, err);
              this.#noteRefused(messageId, err);
            },
          );
        }
        return run;
      },
    );
    this.#rowOps = {
      ensureJoined: (channelId) => this.ensureJoined(channelId),
      createGroup: (channelId, supersedes) =>
        this.createGroup(channelId, supersedes),
      removeDevices: (channelId, targets, opts) =>
        this.removeDevices(channelId, targets, opts),
      catchUp: (channelId, toEpoch, groupId) =>
        this.catchUp(channelId, toEpoch, groupId),
      refresh: (channelId, reason) => this.refresh(channelId, reason),
      stateOf: (channelId) => this.stateOf(channelId),
      pinHistory: (channelId) => this.#pinHistory(channelId),
      nativeState: (channelId) => this.#channels.get(channelId)?.native ?? null,
      seatListError: (channelId) =>
        this.#channels.get(channelId)?.seatListError ?? null,
      preHistoryState: (channelId) => this.#preHistoryState(channelId),
      epochFromWalk: (groupId, epoch) =>
        this.#walked.has(`${groupId}:${epoch}`),
      knownPredecessor: (channelId, groupId) =>
        this.#predecessors.get(channelId)?.has(groupId) === true,
      requestWalk: (channelId, groupId, epoch) =>
        this.#requestWalk(channelId, groupId, epoch),
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * D18 own pins, D26 state read (+ first-sight verify for channels without
   * a local group) for every registered channel, and the D10 orphan scan.
   * B5 registers channels (`channelProtected`) before or after start.
   */
  async start(): Promise<void> {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    await this.#ensureOwnPins(false);
    await Promise.allSettled(
      [...this.#channels.values()].map((rec) => this.#seed(rec)),
    );
    this.#background(this.rescanOrphans());
  }

  /**
   * Re-run the D10 orphan scan (B5 calls it once the Draft outbox keys are
   * known; a scan while the outbox accessor throws is skipped). Serialized:
   * a call during a scan runs ONE more pass after it, never a parallel one,
   * so an orphan is confirmed once. No-op after dispose.
   */
  rescanOrphans(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (this.#orphanScan) {
      this.#orphanScanAgain = true;
      return this.#orphanScan;
    }
    const run = (async () => {
      try {
        do {
          this.#orphanScanAgain = false;
          await this.#resolveOrphans();
        } while (this.#orphanScanAgain && !this.#disposed);
      } catch (err) {
        if (!isDisposed(err)) {
          this.#log("warn", "orphan scan failed", { type: viewTagOf(err) });
        }
      } finally {
        this.#orphanScan = null;
      }
    })();
    this.#orphanScan = run;
    return run;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#abort.abort();
    for (const rec of this.#channels.values()) {
      rec.openCtl?.abort();
      rec.openCtl = null;
      if (rec.join) {
        rec.join.cancelled = true;
        rec.join.wait?.abort();
      }
      // S4: duty staggers, link PUT backoffs and the walk end here.
      rec.historyCtl.abort();
      // B6: no own Update is owed or remembered past this manager.
      rec.historyEpoch = null;
      rec.historyUpdateTries.clear();
    }
    this.#firstSightQueue.length = 0;
    this.#walkPending.clear();
    this.#rows.clear();
    this.#floorRefused.clear();
  }

  /**
   * RA5: the channel is gone for this user (deleted, left): its stored
   * history line (`PROTECTED_HISTORY_EPOCH_KEY_PREFIX`) is deleted, whether
   * or not this manager holds the channel. A channel that is still there
   * gets its line back from the next state read that may store one.
   */
  forgetChannel(channelId: string): void {
    const rec = this.#channels.get(channelId);
    if (rec) {
      rec.historyEpoch = null;
      rec.historyLineKept = null;
    }
    this.#dropHistoryLines([this.#historyEpochKeyOf(channelId)]);
  }

  /**
   * RA5: sign-out. Every stored history line of THIS user is deleted (the
   * port's key scan; without one, the lines of the channels held), and
   * this manager stores none after it. Call it before `dispose`; safe at
   * any time, also after it. Another user's lines are not touched.
   */
  forgetHistoryLines(): void {
    this.#historyLinesOff = true;
    const keys = new Set<string>();
    for (const rec of this.#channels.values()) {
      rec.historyEpoch = null;
      rec.historyLineKept = null;
      keys.add(this.#historyEpochKeyOf(rec.id));
    }
    const mine = `${PROTECTED_HISTORY_EPOCH_KEY_PREFIX}${this.#port.selfUserId}:`;
    try {
      for (const key of this.#port.storeKeys?.(mine) ?? []) {
        if (str(key) && key.startsWith(mine)) keys.add(key);
      }
    } catch {
      this.#log("warn", "history lines not listed", {});
    }
    this.#dropHistoryLines([...keys]);
  }

  #dropHistoryLines(keys: readonly string[]): void {
    for (const key of keys) {
      try {
        this.#port.store.delete(key);
      } catch {
        this.#log("warn", "history line not deleted", {});
      }
    }
  }

  // -------------------------------------------------------------------------
  // Registry
  // -------------------------------------------------------------------------

  /**
   * A channel became known as protected or pinned (deduped). For a channel
   * whose strip this manager holds it is the un-strip (W4d F#3: the bridge
   * forwards it once the SDK latch is clear): the latch is cleared and the
   * channel re-seeded and refreshed, so sends and admissions run again.
   */
  channelProtected(channelId: string): void {
    this.#background(
      this.#register(channelId).then((rec) => {
        let restored = false;
        if (rec.stripped) {
          rec.stripped = false;
          rec.seeded = false;
          restored = true;
          this.#log("info", "flag restored", { channelId });
          this.#emit(rec);
        }
        if (!this.#started) return undefined;
        const seeded = this.#seed(rec);
        // W4e O1: a channel that is OPEN when it becomes protected takes the
        // open path now (seats + verify + text_group + `_state`, then the
        // join when wanted), not at the next re-open or 60 s tick. Idempotent
        // with an open in flight: concurrent refreshes coalesce, and
        // `ensureJoined` joins once.
        const isOpen = rec.openCtl !== null;
        if (!restored && !isOpen) return seeded;
        return seeded.then(() =>
          this.refresh(rec.id, isOpen ? "open" : "commit"),
        );
      }),
    );
  }

  /** The server stripped a pinned channel's flag (D1): sends refused. */
  flagStripped(channelId: string): void {
    this.#background(
      this.#register(channelId).then((rec) => {
        if (!rec.stripped) {
          rec.stripped = true;
          this.#log("warn", "flag stripped", { channelId });
        }
        // S4: the channel left the protected set: its pending link duties,
        // PUT retries and walk stop. A restored flag starts from new ones.
        rec.historyCtl.abort();
        rec.historyCtl = new AbortController();
        this.#emit(rec);
      }),
    );
  }

  /** Channel open (D8): refresh now and every 60 s until `close`. */
  async open(channelId: string): Promise<void> {
    const rec = await this.#register(channelId);
    if (rec.openCtl === null) {
      const ctl = new AbortController();
      rec.openCtl = ctl;
      this.#background(this.#intervalLoop(rec, ctl.signal));
    }
    // Opening is the manual retry of a stalled join (design 9.1 6d); the
    // re-broadcast backoff restarts with it (S2-D28). FXF: so is the 6c
    // red ("try opening the channel again"): its budget starts over.
    rec.welcomeRetriesExhausted = false;
    this.#resetLeafMissing(rec, "open");
    // F-L13: not while this device's intent may be being admitted: the
    // reset would only bring the next re-broadcast forward into that admit
    // ("Try again" on the capacity screen is an open). A run started by
    // this open holds its intents the same way (`#runJoin`).
    const g = rec.serverGroup;
    if (g !== null && this.#joinHoldMs(rec, g) > 0) {
      this.#log("info", "open: join backoff kept, an admit may be landing", {
        channelId,
      });
    } else {
      this.#resetJoinBackoff(rec, "open");
    }
    await this.refresh(channelId, "open");
  }

  /**
   * Channel closed, or hidden by a synthetic ChannelDelete (design 7.5):
   * only the in-memory timer goes; native state, pins and views stay.
   */
  close(channelId: string): void {
    const rec = this.#channels.get(channelId);
    if (!rec) return;
    rec.openCtl?.abort();
    rec.openCtl = null;
  }

  stateOf(channelId: string): ManagerState | null {
    const rec = this.#channels.get(channelId);
    if (!rec) return null;
    return {
      channelId,
      native: rec.native,
      seats: rec.seats,
      serverGroup: rec.serverGroup,
      publishInFlight: rec.publishInFlight,
      ownerChangePending: rec.ownerChangePending,
    };
  }

  // -------------------------------------------------------------------------
  // Owner and message flows (B2 / B4 injected)
  // -------------------------------------------------------------------------

  /**
   * `opts` (S4, R-W4-11): a protect over existing messages, with or without
   * the wipe. Refused before anything else while the history flag is off;
   * the opts are handed to the owner flow as given (only the caller asks
   * for a wipe). Without history opts this is the S2 protect, unchanged.
   */
  async protect(
    channelId: string,
    seats: string[],
    deviceCap: number,
    opts?: { withHistory: boolean; wipe: boolean },
  ): Promise<void> {
    const history = opts?.withHistory === true || opts?.wipe === true;
    if (history) this.#requireHistory(channelId);
    // PA#11f: the id index holds the channel before any `_group_create`.
    const rec = await this.#register(channelId);
    rec.publishInFlight = true;
    this.#emit(rec);
    try {
      if (history) {
        await this.#deps.owner.protect(
          this,
          this.#flowPort,
          channelId,
          seats,
          deviceCap,
          opts,
        );
      } else {
        await this.#deps.owner.protect(
          this,
          this.#flowPort,
          channelId,
          seats,
          deviceCap,
        );
      }
    } catch (err) {
      if (history) this.#ownerHistoryFailed(rec, err);
      throw err;
    } finally {
      rec.publishInFlight = false;
      this.#emit(rec);
      // S4: a boundary protect can reject after its genesis landed (the
      // members' list failed), so the state is re-read whatever happened.
      if (history) this.#background(this.refresh(channelId, "commit"));
    }
    if (!history) this.#background(this.refresh(channelId, "commit"));
  }

  /**
   * S4 (design 6.3 "History setting"): the owner flow signs and publishes
   * the list with the new `history` line (hidden -> visible behind native's
   * growth dialog). The state is re-read whatever the outcome, and that
   * read (`#historyUpdateOwed`, B6) commits this device's self-Update when
   * the held list's line no longer is the one the current epoch began
   * under, so the first epoch under the new setting starts with that
   * commit (3.14.3). The same read covers a flow that rejected after its
   * list landed, a stored publish that lands later and a restart.
   */
  async setHistoryVisible(channelId: string, visible: boolean): Promise<void> {
    this.#requireHistory(channelId);
    const flow = this.#deps.owner.setHistory;
    if (typeof flow !== "function") throw clientFailure("history_unavailable");
    const rec = await this.#register(channelId);
    // B6: the line the current epoch began under is on record before the
    // flow can change the list.
    if (rec.native === null) await this.#readState(rec);
    rec.publishInFlight = true;
    this.#emit(rec);
    try {
      await flow(this, this.#flowPort, channelId, visible);
    } catch (err) {
      this.#ownerHistoryFailed(rec, err);
      throw err;
    } finally {
      rec.publishInFlight = false;
      this.#emit(rec);
      this.#background(
        this.refresh(channelId, "commit").then(() => this.#readState(rec)),
      );
    }
  }

  /**
   * S4 (design 4.9 "S4"): the owner flow signs the one-change wipe list
   * behind native's dialog and POSTs it. The only caller of
   * `OwnerFlows.wipeHistory`: no other path of this manager starts a wipe.
   * The state is re-read whatever the outcome.
   */
  async wipeHistory(channelId: string): Promise<void> {
    this.#requireHistory(channelId);
    const flow = this.#deps.owner.wipeHistory;
    if (typeof flow !== "function") throw clientFailure("history_unavailable");
    const rec = await this.#register(channelId);
    rec.publishInFlight = true;
    this.#emit(rec);
    try {
      await flow(this, this.#flowPort, channelId);
    } catch (err) {
      this.#ownerHistoryFailed(rec, err);
      throw err;
    } finally {
      rec.publishInFlight = false;
      this.#emit(rec);
      this.#background(this.refresh(channelId, "commit"));
    }
  }

  /**
   * S4 (UI): start the channel's history walk, or do nothing while one
   * runs (it is joined by the rows that wait for it). A user's retry, so a
   * stop found earlier in this session is asked of native again. After a
   * walk that ended `retry_later` it starts where that walk started (C4:
   * the gap a row asked for, A4), which need not be the floor; otherwise
   * from the floor native reports. Nothing while the history flag is off
   * or the shell has no history commands.
   */
  walkHistory(channelId: string): void {
    if (this.#disposed || !this.#historyRuns()) return;
    const rec = this.#channels.get(channelId);
    if (!rec || rec.walk !== null) return;
    this.#background(
      (async () => {
        if (rec.native === null) await this.#readState(rec);
        const n = rec.native;
        if (n === null || rec.walk !== null) return;
        let start = rec.historyWalk === "retry_later" ? rec.walkRetry : null;
        if (start === null) {
          const floor = this.#floorOf(n);
          if (floor === null) return;
          start = { groupId: floor.groupId, holderEpoch: floor.epoch };
        }
        rec.walkFloor = null;
        await this.#startWalk(rec, start);
      })(),
    );
  }

  /**
   * `reason` (D40): the unseat reason. Checked again here with the header
   * rule (`validReason`); an invalid one is refused before anything is
   * signed, never sent. The owner flow sends the sanitized value as
   * `X-Audit-Log-Reason` on the PUT of the stored bytes.
   */
  async setSeats(
    channelId: string,
    seats: string[],
    deviceCap: number,
    reason?: string,
  ): Promise<void> {
    let header: string | undefined;
    if (reason !== undefined) {
      const checked = validReason(reason, "header");
      if (!checked.ok) throw clientFailure("invalid_reason");
      header = checked.reason;
    }
    const rec = await this.#register(channelId);
    rec.publishInFlight = true;
    this.#emit(rec);
    try {
      const owner = this.#deps.owner;
      await (header === undefined
        ? owner.setSeats(this, this.#flowPort, channelId, seats, deviceCap)
        : owner.setSeats(
            this,
            this.#flowPort,
            channelId,
            seats,
            deviceCap,
            header,
          ));
    } finally {
      rec.publishInFlight = false;
      this.#emit(rec);
    }
    this.#background(this.refresh(channelId, "commit"));
  }

  /** S2: the owner flow re-signs the authority, then the list carrying it. */
  async authoritySign(
    channelId: string,
    ownerDevices: string[],
  ): Promise<void> {
    const rec = await this.#register(channelId);
    rec.publishInFlight = true;
    this.#emit(rec);
    try {
      await this.#deps.owner.signOwnerDevices(
        this,
        this.#flowPort,
        channelId,
        ownerDevices,
      );
    } finally {
      rec.publishInFlight = false;
      this.#emit(rec);
    }
    this.#background(this.refresh(channelId, "commit"));
  }

  /**
   * S2-D42: the owner flow hands the owner key to another device of this
   * user, then publishes the list carrying the statement. Only from this
   * call (the UI's "Move ownership key"), never automatic.
   */
  async moveOwnerKey(channelId: string, toDeviceId: string): Promise<void> {
    const rec = await this.#register(channelId);
    rec.publishInFlight = true;
    this.#emit(rec);
    try {
      await this.#deps.owner.moveOwnerKey(
        this,
        this.#flowPort,
        channelId,
        toDeviceId,
      );
    } finally {
      rec.publishInFlight = false;
      this.#emit(rec);
    }
    this.#background(this.refresh(channelId, "commit"));
  }

  /** S2 F3: `OwnerFlows.pendingSeats` (the D7c store only). */
  pendingSeats(channelId: string): PendingSeats | null {
    return this.#deps.owner.pendingSeats(this.#flowPort, channelId);
  }

  /**
   * S2 F3: `OwnerFlows.cancelPendingSeats`. A discard re-emits the view, so
   * a UI reading `pendingSeats` through the view map reads it again.
   */
  cancelPendingSeats(channelId: string): CancelPendingSeatsResult {
    const result = this.#deps.owner.cancelPendingSeats(
      this.#flowPort,
      channelId,
    );
    const rec = this.#channels.get(channelId);
    if (result.discarded && rec) this.#emit(rec);
    return result;
  }

  /**
   * S2 (d), design 6.3 "Owner signing device lost" (S2-D17d, S2-D22, #213):
   * on ANOTHER device of the `signer_lost` user, and only from this call
   * (never automatic). Order per #213: the recovery list is signed FIRST
   * (its native dialog runs before anything is created or sent), then,
   * when this device holds no leaf in the open group, the recovery
   * successor `g + 1` is created, and only then the list is PUT (the
   * server's 4.3 step 5b checks the leaf against that successor).
   *
   * FX-R (4.9, D7c): the owner flow stores the signed list before the
   * first PUT and every later call resumes those bytes (read back first)
   * until they resolve, so a failure part-way never asks for a second
   * signature. The refresh after the call runs whatever the outcome.
   */
  async recoverOwnership(channelId: string): Promise<void> {
    const rec = await this.#register(channelId);
    if (rec.stripped) throw clientFailure("flag_stripped");
    if (rec.publishInFlight) throw clientFailure("publish_in_flight");
    rec.publishInFlight = true;
    this.#emit(rec);
    try {
      await this.refresh(channelId, "commit");
      await this.#recover(rec);
    } finally {
      rec.publishInFlight = false;
      this.#emit(rec);
      this.#background(this.refresh(channelId, "commit"));
    }
  }

  async #recover(rec: ChannelRec): Promise<void> {
    if (await this.#recoverOrReview(rec)) {
      // FXT M2: the native owner-change dialog (the consent) runs in the
      // background behind a fresh refresh, so after this call resolved; a
      // cancel leaves "Review owner change" as it was.
      this.#background(this.#confirmOwnRecovery(rec));
    }
  }

  /**
   * True when the recovery landed and native now asks the 4.7 review of
   * this device's own key (FXT M2): the owner flow's re-verify answered
   * `owner_changed { same_user, signer_device_id: this device }` after the
   * PUT, while the served list is this device's. Native holds the lost
   * device's pin and refuses a recovery device its held authority lists
   * (`seat_list.rs` `authority_acceptance`), so this is the designed answer,
   * not a failure: the call resolves, and `#confirmOwnRecovery` runs the
   * step the owner flow's `finishSeats` skipped after its verify threw.
   */
  async #recoverOrReview(rec: ChannelRec): Promise<boolean> {
    // Set by `#signRecovery` only: a refusal is recorded only for a
    // recovery list this call signed (never another flow's resumed bytes).
    rec.recoverySignedOver = null;
    try {
      await this.#deps.owner.recoverOwnership(this, this.#flowPort, rec.id, {
        retryBudget: RECOVERY_PUT_RETRY_BUDGET,
        sign: () => this.#signRecovery(rec),
        ensureLeaf: () => this.#ensureRecoveryLeaf(rec),
      });
    } catch (err) {
      const refused = removedUsersRefusal(err);
      if (refused !== null && rec.recoverySignedOver !== null) {
        this.#noteRecoveryRefused(rec, rec.recoverySignedOver, refused);
      }
      if (!(await this.#ownRecoveryLanded(rec, err))) throw err;
      this.#log("info", "ownership recovered: own owner change to confirm", {
        channelId: rec.id,
      });
      this.#clearRecoveryRefused(rec);
      return true;
    } finally {
      rec.recoverySignedOver = null;
    }
    this.#clearRecoveryRefused(rec);
    this.#log("info", "ownership recovered on this device", {
      channelId: rec.id,
    });
    return false;
  }

  /**
   * FXT M2: `err` is native's `owner_changed` naming this device as the
   * same-user signer, and a fresh `GET .../seats` serves a list this device
   * signed (only this device signs one), so the recovery PUT landed.
   */
  async #ownRecoveryLanded(rec: ChannelRec, err: unknown): Promise<boolean> {
    // A server or client failure is never native's verdict.
    const n = isFlowFailure(err)
      ? err.source === "native"
        ? err.error
        : null
      : nativeErrorOf(err);
    if (
      n?.type !== "owner_changed" ||
      n.same_user !== true ||
      n.signer_user_id !== this.#port.selfUserId ||
      n.signer_device_id !== this.#port.selfDeviceId
    ) {
      return false;
    }
    await this.refresh(rec.id, "commit");
    return this.#servesOwnList(rec);
  }

  /** The served list is signed by this device (FXT M2). */
  #servesOwnList(rec: ChannelRec): boolean {
    const l = rec.seats?.list ?? null;
    return (
      l !== null &&
      l.signer_user_id === this.#port.selfUserId &&
      l.signer_device_id === this.#port.selfDeviceId
    );
  }

  /**
   * FXT M2 (planner ruling), after a landed recovery:
   * 1. In place of `finishSeats`' skipped leaf step: the routine
   *    pending-removal commit `#maintain` also runs
   *    (`#commitPendingRemovals`). The users the recovery list left off are
   *    pending removals (the server released them); it adds no authority,
   *    and does nothing when this device holds no leaf in the open group
   *    (e.g. a fresh recovery successor).
   * 2. Native's owner-change confirm for this device's own key: the NATIVE
   *    dialog is the consent, nothing is confirmed from the webview. Only
   *    while the served list is still this device's and the verify still
   *    waits for the review; a cancel (or any refusal) leaves the review.
   */
  async #confirmOwnRecovery(rec: ChannelRec): Promise<void> {
    await this.refresh(rec.id, "commit");
    await this.#commitPendingRemovals(rec);
    if (!rec.ownerChangePending || !this.#servesOwnList(rec)) return;
    try {
      await this.confirmOwnerChange(rec.id);
    } catch (err) {
      if (isDisposed(err)) throw err;
      this.#log("info", "own owner change left for review", {
        channelId: rec.id,
        type: viewTagOf(err),
      });
    }
  }

  #recoveryRefusedKey(rec: ChannelRec): string {
    return `${PROTECTED_RECOVERY_REFUSED_KEY_PREFIX}${this.#port.selfUserId}:${rec.id}`;
  }

  /**
   * FXT M1: remember who a recovery PUT signed over served list `version`
   * was refused for (persisted, ids only). A later refusal over the same
   * version adds to it; another version replaces it.
   */
  #noteRecoveryRefused(
    rec: ChannelRec,
    version: number,
    users: readonly string[],
  ): void {
    const prior = this.#recoveryRefusedFor(rec, version);
    const all = [...prior];
    for (const u of users) if (!all.includes(u)) all.push(u);
    let ok = false;
    try {
      ok = this.#port.store.set(
        this.#recoveryRefusedKey(rec),
        JSON.stringify({ v: 1, version, users: all }),
      );
    } catch {
      ok = false;
    }
    this.#recoveryRefusedMem.set(rec.id, { version, users: all });
    this.#log(ok ? "info" : "warn", "recovery refused for released users", {
      channelId: rec.id,
      count: users.length,
      persisted: ok,
    });
  }

  /**
   * FXT M1: the users a recovery PUT over served list `version` was refused
   * for; empty for any other version or an unreadable record.
   */
  #recoveryRefusedFor(rec: ChannelRec, version: number): string[] {
    let stored: unknown = null;
    try {
      stored = JSON.parse(
        this.#port.store.get(this.#recoveryRefusedKey(rec)) ?? "null",
      );
    } catch {
      stored = null;
    }
    const mem = this.#recoveryRefusedMem.get(rec.id) ?? null;
    for (const r of [stored, mem]) {
      if (
        isRecord(r) &&
        r.version === version &&
        Array.isArray(r.users) &&
        r.users.every((u) => str(u))
      ) {
        return r.users as string[];
      }
    }
    return [];
  }

  /** FXT M1: a recovery resolved: its refusal record is spent. */
  #clearRecoveryRefused(rec: ChannelRec): void {
    this.#recoveryRefusedMem.delete(rec.id);
    try {
      this.#port.store.delete(this.#recoveryRefusedKey(rec));
    } catch {
      // nothing else to do: a stale record only ever names released users
    }
  }

  /**
   * The recovery list's `_seat_list_sign(recovery: true)`, only on another
   * device of the `signer_lost` user, over the held list's seats and cap.
   * The owner flow validates the answer (shape, this device, version + 1).
   */
  async #signRecovery(
    rec: ChannelRec,
  ): Promise<{ signed: unknown; serverVersion: number }> {
    const self = this.#port.selfUserId;
    const dev = this.#port.selfDeviceId;
    const g = rec.serverGroup;
    const n = rec.native;
    const list = rec.seats?.list ?? null;
    const lost = g?.signer_lost ?? null;
    if (
      g === null ||
      lost === null ||
      lost.user_id !== self ||
      lost.device_id === dev ||
      !n?.seat_list ||
      list === null
    ) {
      throw clientFailure("recovery_unavailable");
    }
    const held = n.seat_list;
    // F-L4 + FXT M1: the server refuses a list still naming a user it
    // released since the stored list (`SeatListNamesRemovedUsers`) and
    // nothing re-signs the held list after a release, so a held user is
    // left off on POSITIVE evidence only: cooling and not seated in the
    // snapshot of the refresh `recoverOwnership` ran first, or named by a
    // refusal of a recovery over this same served version. This user
    // always; never a user the held list does not name.
    rec.recoverySignedOver = list.version;
    const seats = recoverySeats(
      held.seats,
      rec.seats ?? {},
      self,
      this.#recoveryRefusedFor(rec, list.version),
    );
    if (seats === null) throw clientFailure("recovery_unavailable");
    if (seats.length !== held.seats.length) {
      this.#log("info", "recovery list leaves released users off", {
        channelId: rec.id,
        count: held.seats.length - seats.length,
      });
    }
    const info = this.#port.channelInfo(rec.id);
    let signed: unknown;
    try {
      // A dialog: never inside the lane (it waits on the user).
      signed = await this.#invoke("e2ee_text_seat_list_sign", {
        channelId: rec.id,
        userId: self,
        seats,
        deviceCap: held.device_cap,
        serverList: { version: list.version, body: list.body },
        format: null,
        authority: null,
        recovery: true,
        // S4 (R-W4-2): always sent; a recovery list never carries them.
        history: null,
        historyBoundary: null,
        preHistory: null,
        wipeCount: null,
        channelName: info?.name ?? null,
        displayNames: this.#port.displayNames(seats),
      });
    } catch (err) {
      throw toFailure(err);
    }
    return { signed, serverVersion: list.version };
  }

  /**
   * Before a recovery PUT: create the successor when this device holds no
   * leaf in the server's open group (#213). Read at the PUT, so a resumed
   * publish whose successor already exists creates nothing.
   */
  async #ensureRecoveryLeaf(rec: ChannelRec): Promise<void> {
    const g = rec.serverGroup;
    if (g === null) throw clientFailure("recovery_unavailable");
    const self = this.#port.selfUserId;
    const dev = this.#port.selfDeviceId;
    if (g.members.some((m) => m.user_id === self && m.device_id === dev)) {
      return;
    }
    await this.#createGroup(rec, g.group_id, true, g.generation);
  }

  /**
   * S2 (g), design 7.5: a `ProtectedChannelChanged` refetch hint for a
   * channel this manager holds. Unknown scope items are ignored; never a
   * security input. A burst costs ONE `refresh(id, "event")` after
   * `CHANNEL_CHANGED_COALESCE_MS`. It also ends a recorded capacity
   * refusal (f): the refresh then joins again.
   *
   * S4: scope `history` (a link was contested) runs the owner's contest
   * check while the history flag is on, and nothing else; with the flag
   * off it is ignored like any unknown item.
   */
  onChannelChanged(channelId: string, scope: readonly string[]): void {
    if (this.#disposed) return;
    const rec = this.#channels.get(channelId);
    if (!rec) return;
    if (!Array.isArray(scope)) return;
    if (scope.some((s) => s === "history") && this.#historyRuns()) {
      this.#ownerHistoryCheck(rec);
    }
    if (!scope.some((s) => s === "seats" || s === "text_group")) return;
    if (rec.capacity !== null) {
      rec.capacity = null;
      this.#emit(rec);
    }
    if (rec.changePending) return;
    rec.changePending = true;
    this.#background(
      (async () => {
        try {
          await this.#sleep(CHANNEL_CHANGED_COALESCE_MS);
        } finally {
          rec.changePending = false;
        }
        // S2-D28: a change restarts the re-broadcast backoff (once a burst,
        // and at most once per JOIN_EVENT_RESET_GAP_MS: FX-J2 NEW-2).
        this.#resetJoinBackoff(rec, "event");
        await this.refresh(channelId, "event");
      })(),
    );
  }

  /**
   * S2: the UI's one-off retry ("Retry removal", "Rejoin", "Finish now"):
   * ONE `refresh(id, "manual")` for a channel this manager holds. It never
   * starts the open interval (`open` does), and it is dropped while a
   * refresh of the channel, or an earlier `retryNow`, has not settled
   * (that refresh re-reads the same state). Never a security input: a
   * refresh only re-reads server state and lets the existing flows act. A
   * "manual" refresh is not an open: it neither retries a capacity-refused
   * join (f) nor resets the Welcome retry budget. FXF: it is a user's
   * retry, so the 6c budget starts over (the refresh then joins again); a
   * dropped call resets nothing.
   *
   * C6: a channel this manager does not hold yet (the settings of a
   * channel nothing handed over this session) is registered first, when
   * the client cache knows it as protected or pinned, and gets the same
   * ONE manual refresh. No new trust: the refresh is the normal seat
   * list verify and state read. Any other id is still dropped.
   */
  retryNow(channelId: string): void {
    if (this.#disposed) return;
    const rec = this.#channels.get(channelId);
    if (!rec) {
      this.#retryUnheld(channelId);
      return;
    }
    if (rec.refreshing || rec.manualPending) return;
    this.#resetLeafMissing(rec, "manual");
    rec.manualPending = true;
    this.#background(
      this.refresh(channelId, "manual").finally(() => {
        rec.manualPending = false;
      }),
    );
  }

  /** C6: `retryNow` for a channel not held; see there. */
  #retryUnheld(channelId: string): void {
    const info = this.#port.channelInfo(channelId);
    if (info === null) return;
    if (!info.serverProtected && !info.locallyPinned) return;
    this.#background(
      this.#register(channelId).then((rec) => {
        // A double click, or a refresh something else started meanwhile.
        if (rec.refreshing || rec.manualPending) return undefined;
        rec.manualPending = true;
        return this.refresh(channelId, "manual").finally(() => {
          rec.manualPending = false;
        });
      }),
    );
  }

  async send(
    channelId: string,
    text: string,
    replies: string[],
    silent: boolean,
    key: string,
  ): Promise<ProtectedSendOutcome> {
    const rec = await this.#register(channelId);
    if (rec.stripped) throw clientFailure("flag_stripped");
    let out: ProtectedSendOutcome;
    try {
      out = await this.#deps.messages.encryptAndSend(
        this,
        this.#flowPort,
        channelId,
        text,
        replies,
        silent,
        key,
      );
    } catch (err) {
      // W4d X#5: the DS holds no leaf of this device: wipe and rejoin.
      if (isNotMemberRefusal(err)) {
        this.#background(this.#leaveNotMember(rec));
      }
      throw err;
    }
    // W4d X#4 (replaces the D22 typed-plaintext shortcut): the own view
    // comes from ONE native decrypt of the delivered row (live: false),
    // which binds cid → message id in native's `mls_text_seen`. An id that
    // already has a view keeps it (the cached view is re-emitted, never
    // replaced); the live echo of the same id is served from the cache.
    const row = ownRowOf(out, channelId, this.#port.selfUserId);
    if (row === null) {
      this.#log("error", "own send row unbound", {
        channelId,
        messageId: out.messageId,
      });
    } else {
      try {
        await this.#decryptOne(row, false, true);
      } catch (err) {
        if (!isDisposed(err)) {
          this.#log("warn", "own send decrypt failed", {
            messageId: row.id,
            type: viewTagOf(err),
          });
        }
      }
    }
    // D19: after a send, commit an Update when native says one is due.
    this.#background(this.#afterSend(rec));
    return out;
  }

  /** Live or fetched row: decrypt through B4, publish the view (D22). */
  onMessage(row: ProtectedMessageRow, live: boolean): void {
    this.#background(this.#decryptOne(row, live));
  }

  decryptHistory(channelId: string, rows: ProtectedMessageRow[]): void {
    // S4: the rows of one call share one walk request per missing epoch.
    const batch = newWalkBatch();
    // The page is on record first: a walk one of its rows starts finds
    // the others as probes.
    if (!this.#disposed) {
      for (const row of rows) {
        if (row.channelId !== channelId || this.#forgotten.has(row.id)) {
          continue;
        }
        this.#noteRow(row);
      }
    }
    this.#background(
      (async () => {
        for (const row of rows) {
          if (row.channelId !== channelId) continue;
          await this.#decryptOne(row, false, false, batch, false);
        }
        // R-W4-32 / R-W4-39: the floor marker is placed (or moved) once
        // for the whole page, after native answered for each of its rows.
        const rec = this.#channels.get(channelId);
        if (rec && !this.#disposed) this.#placeFloor(rec);
      })(),
    );
  }

  /**
   * `own`: the delivered row of this device's own send (X#4). Its native
   * decrypt runs with `live: false`; a successful result also answers the
   * live echo of that id, so the echo costs no second decrypt.
   * `place: false` when the caller places the floor marker itself, once
   * for many rows.
   */
  async #decryptOne(
    row: ProtectedMessageRow,
    live: boolean,
    own = false,
    batch: WalkBatch | null = null,
    place = true,
  ): Promise<void> {
    if (this.#disposed) return;
    if (this.#forgotten.has(row.id)) return;
    // S4 (R-W4-31): the row policy decides every row, whatever the history
    // flag says; the flag only keeps `requestWalk` from starting a walk.
    let cached = this.#views.get(row.id);
    this.#noteRow(row);
    // A cached view the row policy no longer gives is computed again.
    if (cached) cached = this.#currentView(row, cached) ?? undefined;
    // A history (non-live) result never answers a live request: native
    // runs its live-only checks (replay, skew) on the live decrypt.
    if (cached && (!live || this.#viewLive.has(row.id))) {
      this.#cb.onMessageView(row.id, cached);
      return;
    }
    const key = `${row.id}:${live}`;
    if (this.#decrypting.has(key)) return;
    this.#decrypting.add(key);
    this.#cb.onMessageView(row.id, { status: "pending" });
    let view: ProtectedMessageView;
    try {
      view = await this.#deps.messages.decryptRow(
        this.#rowOps,
        this.#flowPort,
        row,
        live,
        batch === null ? undefined : { batch },
      );
    } catch (err) {
      let kind: ProtectedMarkerKind;
      try {
        kind = this.#deps.messages.markerForError(err);
      } catch {
        kind = "error";
      }
      view = { status: "marker", kind };
    } finally {
      this.#decrypting.delete(key);
    }
    if (this.#disposed) return;
    if (this.#forgotten.has(row.id)) return;
    // R-W4-39: native has answered for the row; it may place the marker.
    if (place) {
      const rec = this.#channels.get(row.channelId);
      if (rec && rec.floorMarker !== null) this.#placeFloor(rec, row);
    }
    // A late history result never overwrites a live one.
    if (!live && this.#viewLive.has(row.id)) return;
    if (live || (own && view.status === "ok")) this.#viewLive.add(row.id);
    // S4: a row the walk could not settle is never a final view; it is
    // decrypted again when a walk result arrives (`#rerunPending`).
    if (view.status === "pending") {
      this.#walkPending.delete(row.id);
      this.#walkPending.set(row.id, { row, live });
      if (this.#walkPending.size > VIEW_CACHE_MAX) {
        const oldest = this.#walkPending.keys().next().value;
        if (oldest !== undefined) this.#walkPending.delete(oldest);
      }
    } else {
      this.#walkPending.delete(row.id);
    }
    this.#setMessageView(row.id, view);
  }

  /**
   * Deleted messages (MessageDelete / BulkDelete, wired by B5): drop their
   * views and dedupe state. A decrypt still in flight for one of them is
   * discarded when it settles.
   */
  forget(ids: string[]): void {
    for (const id of ids) {
      this.#views.delete(id);
      this.#viewLive.delete(id);
      this.#rows.delete(id);
      this.#floorRefused.delete(id);
      this.#walkPending.delete(id);
      this.#forgotten.add(id);
    }
    while (this.#forgotten.size > SEEN_MAX) {
      const oldest = this.#forgotten.values().next().value;
      if (oldest === undefined) break;
      this.#forgotten.delete(oldest);
    }
  }

  #setMessageView(id: string, v: ProtectedMessageView): void {
    if (v.status !== "pending") {
      this.#views.delete(id);
      this.#views.set(id, v);
      if (this.#views.size > VIEW_CACHE_MAX) {
        const oldest = this.#views.keys().next().value;
        if (oldest !== undefined) {
          this.#views.delete(oldest);
          this.#viewLive.delete(oldest);
        }
      }
    }
    try {
      this.#cb.onMessageView(id, v);
    } catch {
      this.#log("error", "onMessageView threw", { messageId: id });
    }
  }

  /**
   * W4d X#5: a send answered `not_member`: `_mark_left(group,
   * "not_member")` in the lane (native still reports the group active, so
   * a refresh alone would never rejoin), then the rejoin path.
   */
  async #leaveNotMember(rec: ChannelRec): Promise<void> {
    await this.#enqueue(rec.id, async () => {
      const n = await this.#readStateDirect(rec);
      if (!n || n.state !== "active" || n.group_id === null) return;
      const groupId = n.group_id;
      try {
        await this.#invoke("e2ee_text_mark_left", {
          groupId,
          reason: "not_member",
        });
        this.#log("warn", "group left", { groupId, reason: "not_member" });
      } catch (err) {
        if (isDisposed(err)) throw err;
        this.#log("warn", "mark_left failed", {
          groupId,
          type: viewTagOf(err),
        });
      }
      await this.#readStateDirect(rec);
    });
    this.#emit(rec);
    this.#background(this.ensureJoined(rec.id));
  }

  async #afterSend(rec: ChannelRec): Promise<void> {
    await this.#readState(rec);
    const n = rec.native;
    if (n && holdsCurrentGroup(n) && (n.update_due || n.update_required)) {
      await this.#commitUpdate(rec, false);
    }
  }

  // -------------------------------------------------------------------------
  // GroupOps
  // -------------------------------------------------------------------------

  /**
   * Resolves once this device holds an active leaf in the channel's open
   * group (and has committed a required Update, so a B4 retry after
   * `update_required` can call it again). Rejects with `TextFlowFailure`.
   */
  async ensureJoined(channelId: string): Promise<void> {
    const rec = await this.#register(channelId);
    if (rec.stripped) throw clientFailure("flag_stripped");
    // S4 floor (a): no join intent until reload.
    if (rec.clientOutdated !== null) throw clientFailure("client_outdated");
    if (rec.join) return rec.join.promise;
    await this.#readState(rec);
    const n = rec.native;
    // S2 (c): a superseded group is still `active` natively (verdict
    // `no_group`): it is never "joined"; the join path takes the successor.
    if (
      n &&
      holdsCurrentGroup(n) &&
      (rec.serverGroup === null || rec.serverGroup.group_id === n.group_id)
    ) {
      if (n.update_required) {
        await this.#commitUpdate(rec, true);
        await this.#readState(rec);
        // Never report "joined" while native still refuses to encrypt.
        if (rec.native?.update_required) {
          throw clientFailure("update_pending");
        }
      }
      return;
    }
    if (rec.join) return (rec.join as JoinState).promise;
    const js: JoinState = {
      promise: Promise.resolve(),
      welcome: deferred(),
      cancelled: false,
      wait: null,
      reset: false,
      backoff: 0,
    };
    rec.join = js;
    js.promise = this.#runJoin(rec, js).finally(() => {
      js.cancelled = true;
      if (rec.join === js) rec.join = null;
    });
    return js.promise;
  }

  /**
   * D21: `_group_create` + `POST /mls/groups`. A 409 Conflict naming the
   * group native derived is "created" (a retry that already landed).
   */
  async createGroup(
    channelId: string,
    supersedes: string | null,
  ): Promise<TextGroupCreated> {
    const rec = await this.#register(channelId);
    return this.#createGroup(rec, supersedes, false, null);
  }

  /**
   * `createGroup`, plus the S2 recovery successor (`recovery: true` with
   * the superseded generation, design 6.3; only `#recover` passes it).
   */
  async #createGroup(
    rec: ChannelRec,
    supersedes: string | null,
    recovery: boolean,
    supersedesGeneration: number | null,
  ): Promise<TextGroupCreated> {
    const channelId = rec.id;
    // S4 floor (a): no create until reload.
    if (rec.clientOutdated !== null) throw clientFailure("client_outdated");
    let created: TextGroupCreated;
    try {
      created = await this.#enqueue(rec.id, () =>
        this.#invoke("e2ee_text_group_create", {
          channelId,
          userId: this.#port.selfUserId,
          supersedes,
          recovery,
          supersedesGeneration,
        }),
      );
    } catch (err) {
      throw toFailure(err);
    }
    // (h) Indexed before the server (or any envelope) can name it.
    this.#report(channelId, created.group_id, created.generation, "create");
    // (a, OR-3) native's payload as received, plus the shell protocol.
    const body: TextCreateGroupBody = {
      ...created.payload,
      protocol: TEXT_PROTOCOL,
    };
    for (let failures = 0; ; failures++) {
      const r = await this.#api("POST", "/mls/groups", body);
      if (r !== null && is2xx(r.status)) break;
      const refusal = r !== null ? joinRefusal(r) : null;
      if (r !== null && refusal?.kind === "outdated") {
        this.#markOutdated(rec, refusal.min);
        throw serverFailure(r);
      }
      if (r !== null && r.status === 409) {
        const b = r.body;
        if (
          isRecord(b) &&
          b.result === "Conflict" &&
          b.open_group_id === created.group_id
        ) {
          break;
        }
        this.#background(this.refresh(channelId, "commit"));
        throw serverFailure(r);
      }
      if (r !== null && is4xx(r.status) && r.status !== 429) {
        throw serverFailure(r);
      }
      if (failures >= CREATE_RETRY_BUDGET) {
        throw r === null
          ? ({ source: "transport" } as const)
          : serverFailure(r);
      }
      await this.#sleep(
        (r !== null ? retryAfterMs(r) : null) ?? publishBackoffMs(failures),
      );
    }
    this.#createPosted.add(created.group_id);
    // X#1: this device's successor (a higher generation) is accepted: the
    // poisoned group's sticky loud tag is reset (D21).
    this.#clearStickyBelow(rec, created.generation);
    this.#log("info", "text group created", {
      channelId,
      groupId: created.group_id,
      generation: created.generation,
    });
    // S4 (3.14.6 step 1): the creator of a successor writes the bridge
    // link, holder (G', 0) with no candidates. Never in the create's way.
    if (supersedes !== null && this.#linksOn()) {
      this.#background(
        this.#buildLink(rec, created.group_id, 0, [], rec.historyCtl.signal),
      );
    }
    await this.refresh(channelId, "commit");
    return created;
  }

  /** `_remove` + submit (owner unseat, rejoin rule 6, pending removals). */
  async removeDevices(
    channelId: string,
    targets: MlsMemberDevice[],
    opts: RemoveDevicesOptions,
  ): Promise<void> {
    const rec = await this.#register(channelId);
    await this.#removeInner(rec, targets, opts.rejoinIntent);
  }

  /** Gap-refetch and process commits until `toEpoch` (or rejects). */
  async catchUp(
    channelId: string,
    toEpoch: number,
    groupId: string,
  ): Promise<void> {
    const rec = await this.#register(channelId);
    const ok = await this.#enqueue(rec.id, () =>
      this.#catchUpInner(rec, toEpoch, groupId),
    );
    if (!ok) throw clientFailure("catch_up_incomplete");
  }

  /**
   * D8 refresh; concurrent calls coalesce. Never rejects (logs). FX-J2
   * NEW-5: the pass re-run for coalesced calls takes the strongest reason
   * seen (`coalescedRefreshReason`), so a stored-admit reason is never
   * absorbed by a running pass that does not admit.
   */
  refresh(channelId: string, reason: TextRefreshReason): Promise<void> {
    return this.#register(channelId).then((rec) => {
      if (rec.refreshing) {
        rec.refreshAgain = true;
        rec.refreshAgainReason =
          rec.refreshAgainReason === null
            ? reason
            : coalescedRefreshReason(rec.refreshAgainReason, reason);
        return rec.refreshing;
      }
      let pass = reason;
      const run = (async () => {
        try {
          for (;;) {
            rec.refreshAgain = false;
            rec.refreshAgainReason = null;
            await this.#refreshOnce(rec, pass);
            if (!rec.refreshAgain || this.#disposed) break;
            pass = coalescedRefreshReason(pass, rec.refreshAgainReason ?? pass);
          }
        } catch (err) {
          if (!isDisposed(err)) {
            this.#log("warn", "refresh failed", {
              channelId,
              reason: pass,
              type: viewTagOf(err),
            });
          }
        } finally {
          rec.refreshing = null;
        }
      })();
      rec.refreshing = run;
      return run;
    });
  }

  // -------------------------------------------------------------------------
  // Owner change (D15) and recreate (D21)
  // -------------------------------------------------------------------------

  async confirmOwnerChange(channelId: string): Promise<void> {
    const rec = await this.#register(channelId);
    const info = this.#port.channelInfo(channelId);
    const signer = rec.native?.owner_pin?.pending_signer ?? null;
    try {
      await this.#invoke("e2ee_text_owner_confirm_change", {
        channelId,
        channelName: info?.name ?? null,
        displayNames: this.#port.displayNames(signer ? [signer.user_id] : []),
      });
    } catch (err) {
      // Declined: nothing changed. OwnerChanged{same_user:false}: final in
      // S1. Either way the parked envelopes stay parked.
      this.#emit(rec);
      throw toFailure(err);
    }
    rec.ownerChangePending = false;
    // OR-10: the next verify tells whether this confirm settled it.
    rec.confirmedSigner = signer?.same_user === true ? signer.device_id : null;
    // D15: re-run GET .../seats + _seat_list_verify, then reprocess. FXF:
    // of the parked Welcomes only the latest for the server's current
    // group is; the rest are acked and dropped, never replayed.
    rec.confirmInFlight = true;
    try {
      await this.refresh(channelId, "owner_confirmed");
    } finally {
      rec.confirmInFlight = false;
    }
    await this.#replayParked(rec);
    // FXF: a join waiting on a parked Welcome looks again within a step.
    this.#resetJoinBackoff(rec, "confirm");
    this.#emit(rec);
  }

  /**
   * D15 replay of the parked envelopes: a confirm's, or (FXP MJ-3) an owner
   * change native settled without one (`#replayIfSettled`).
   */
  async #replayParked(rec: ChannelRec): Promise<boolean> {
    rec.parkedUnderPending = false;
    let reparked = false;
    const { replay: parked, dropped } = parkedReplay(
      rec.parked.splice(0),
      rec.serverGroup?.group_id ?? null,
    );
    // FXP F-L7: until the replay settles the join reads its Welcome as
    // still parked (no intent races the Welcome being replayed).
    const token = ++this.#replayTokens;
    rec.replaying.set(token, parked);
    await this.#enqueue(rec.id, async () => {
      if (dropped.length > 0) {
        this.#log("info", "stale parked welcomes dropped", {
          channelId: rec.id,
          count: dropped.length,
        });
        await this.#ack(dropped.map((p) => p.id));
        for (const p of dropped) this.#markSeen(p.id);
      }
      for (let i = 0; i < parked.length; i++) {
        const r = await this.#processWire(rec, parked[i], 0);
        if (r === "parked") {
          // Re-parked (a later owner change): keep the rest behind it.
          rec.parked.push(...parked.slice(i + 1));
          reparked = true;
          return;
        }
      }
    }).finally(() => {
      rec.replaying.delete(token);
    });
    return reparked;
  }

  async recreateGroup(channelId: string): Promise<void> {
    const rec = await this.#register(channelId);
    const supersedes =
      rec.serverGroup?.group_id ?? rec.native?.group_id ?? null;
    await this.createGroup(channelId, supersedes);
    rec.welcomeRetriesExhausted = false;
    rec.recreateAvailable = false;
    this.#resetLeafMissing(rec, "recreate");
    this.#emit(rec);
  }

  // -------------------------------------------------------------------------
  // Inbound: envelopes and join requests
  // -------------------------------------------------------------------------

  /** A routed text envelope (B5 after `routeMls` → `text`). */
  onEnvelope(env: TextEnvelope): void {
    if (this.#disposed) return;
    if (this.#seen.has(env.id) || this.#queued.has(env.id)) return;
    this.#queued.add(env.id);
    // Routing metadata never reaches native (A1 ruling 6).
    const wire = toWireEnvelope(env);
    const rec = this.#recForGroup(wire.group_id);
    if (rec && rec.parked.length > 0) {
      // An owner change is pending: keep order behind the parked envelope.
      rec.parked.push(wire);
      return;
    }
    this.#background(this.#enqueueEnvelope(rec, wire));
  }

  #enqueueEnvelope(rec: ChannelRec | null, wire: TextWireEnvelope) {
    return this.#enqueue(rec ? rec.id : `group:${wire.group_id}`, () =>
      this.#processWire(rec, wire, 0),
    );
  }

  /** A join request for an indexed group (D19 admission). */
  onJoinRequest(req: MlsJoinRequest, rejoin: boolean): void {
    this.#background(this.#admit(req, rejoin));
  }

  // -------------------------------------------------------------------------
  // Envelope processing (runs INSIDE the channel lane)
  // -------------------------------------------------------------------------

  /**
   * `catchUpTip` (b): the server's current epoch while `#catchUpInner`
   * pages commits; null for a live envelope (native's S1 path).
   * `caughtUp` (S4): the envelope is a row of a catch-up page (the tip may
   * be null there too), so its link duty is the batched pass, not a live
   * one.
   */
  async #processWire(
    laneRec: ChannelRec | null,
    wire: TextWireEnvelope,
    depth: number,
    catchUpTip: number | null = null,
    caughtUp = false,
  ): Promise<ProcessResult> {
    const synth = isSynthTextEnvelopeId(wire.id);
    const ids = { groupId: wire.group_id, envelopeId: wire.id };
    if (depth === 0 && laneRec && laneRec.parked.length > 0) {
      // D15: an owner change is pending; keep order behind it.
      laneRec.parked.push(wire);
      return "parked";
    }
    // D4: native stays authoritative. A commit for an indexed id that
    // native knows as a CALL group (M9 squat) is refused loudly, unacked.
    if (wire.content_type === "mls_commit") {
      let kind: TextCommandResult["e2ee_mls_group_kind"] = null;
      try {
        kind = await this.#invoke("e2ee_mls_group_kind", {
          groupId: wire.group_id,
        });
      } catch (err) {
        if (viewTagOf(err) === "busy") return this.#hold(laneRec, wire);
        this.#log("warn", "group kind query failed", {
          ...ids,
          type: viewTagOf(err),
        });
      }
      if (kind === "call") {
        this.#log("error", "wrong group kind", ids);
        const rec = laneRec ?? this.#recForGroup(wire.group_id);
        if (rec) this.#setGroupError(rec, "wrong_group_kind", wire.group_id);
        this.#queued.delete(wire.id);
        return "dropped";
      }
    }
    // FX-R: a second copy of a Welcome this device already processed (the
    // S2-D29 fetched copy, then the mailbox copy, or the reverse) would be
    // refused as unsolicited and raise the D22 toast: acked and dropped.
    if (wire.content_type === "mls_welcome") {
      const rec = laneRec ?? this.#recForGroup(wire.group_id);
      if (rec && (await this.#welcomeAlreadyHeld(rec, wire))) {
        this.#log("info", "duplicate welcome dropped", ids);
        if (!synth) await this.#ack([wire.id]);
        this.#markSeen(wire.id);
        return "dropped";
      }
    }
    await this.#ensureOwnPins(false);
    // Devices pinned in this pass (`pinRetryKey`), and whether a refused
    // Welcome was already processed once more after its pin (MJ-1).
    const pinned = new Set<string>();
    let rerun = false;
    for (;;) {
      let out: TextProcessOutcome;
      try {
        out = await this.#invoke("e2ee_text_process", {
          envelope: wire,
          userId: this.#port.selfUserId,
          catchUpTip,
        });
      } catch (err) {
        let verdict = classifyTextEnvelopeError(err);
        const native = nativeErrorOf(err);
        if (
          verdict.action === "pin_identities_retry" &&
          native?.type === "identity_pin_required" &&
          pinRetryAllowed(wire.content_type, pinned, native)
        ) {
          // D18: pin that user's listing and retry: a commit ONCE (D28), a
          // Welcome once per device native names (FXP F-L6: one unpinned
          // leaf per refusal; a device named twice ends the pass).
          pinned.add(pinRetryKey(native));
          await this.#pinFor(native.user_id, [native.device_id]);
          continue;
        }
        const rec = laneRec ?? this.#recForGroup(wire.group_id);
        // FXP F-L7: a Welcome for the server's current group whose list
        // signer holds no leaf, while native holds a pending signer, waits
        // for that confirm (native's step 8 reads the HELD list; the pending
        // signer's leaf is the one the roster holds). Parked, unacked and
        // not counted toward 6c: a discard would rejoin, and members would
        // evict and re-add this device for a Welcome the confirm admits.
        // Native's state is re-read here (in the lane), never assumed. MJ-3:
        // only a same-user pending signer parks it (the one a confirm can
        // settle); another user's keeps the S1 handling (6c, locked notice).
        if (
          rec &&
          verdict.action === "signer_leaf_missing_retry" &&
          wire.content_type === "mls_welcome" &&
          rec.serverGroup?.group_id === wire.group_id
        ) {
          rec.slmSeen = { groupId: wire.group_id, epoch: wire.epoch };
          await this.#readStateDirect(rec);
          if (this.#ownerChangePending(rec)) {
            this.#log("info", "welcome waits for the owner change", ids);
            verdict = { ack: false, action: "park_owner_change" };
            rec.parkedUnderPending = true;
          }
        }
        // FXP F-L6 (MJ-1): `unknown_identity` is native's spent pin budget
        // for this (group, epoch, device), never a verdict on the device.
        // The refused device is pinned once now; when its listing answered
        // (pinned, already pinned or not listed: the pin call does not say
        // which), `_process` runs once more in this pass and native decides.
        const refused = welcomeRefusalOf(err, wire);
        if (
          refused !== null &&
          refused.reason === "unknown_identity" &&
          !rerun &&
          (await this.#pinFor(refused.userId, [refused.deviceId])) ===
            "answered"
        ) {
          rerun = true;
          this.#log("info", "refused welcome processed once more", ids);
          continue;
        }
        // FXP F-L6: a refused Welcome is the loud alarm (M2) and the source
        // of its paced rejoin (M1), persisted with its pace (m-a).
        if (rec && refused) {
          this.#noteRefusal(rec, {
            ...refused,
            retryable: refusalRetryable(refused.reason),
          });
        }
        if (
          rec &&
          verdict.action === "park_owner_change" &&
          native?.type === "owner_changed" &&
          native.same_user
        ) {
          rec.parkedUnderPending = true;
        }
        const tag = viewTagOf(err);
        this.#log("warn", "process failed", { ...ids, type: tag });
        this.#recordGroupError(rec, verdict.groupError, tag, wire.group_id);
        if (verdict.ack) {
          await this.#ack([wire.id]);
          this.#markSeen(wire.id);
        }
        return this.#envelopeAction(rec, wire, verdict, depth);
      }
      if (!synth) await this.#ack([wire.id]);
      this.#markSeen(wire.id);
      await this.#onOutcome(out, caughtUp ? "catch_up" : "live");
      return "ok";
    }
  }

  /**
   * FX-R: native's `_state` holds `wire`'s group, active, at or past the
   * Welcome's epoch. Native state only (never server data), re-read before
   * a drop is decided. Any other Welcome (another group, a later epoch,
   * a group not held) goes to native as before, refusal and toast included.
   */
  async #welcomeAlreadyHeld(
    rec: ChannelRec,
    wire: TextWireEnvelope,
  ): Promise<boolean> {
    const holds = (n: TextChannelState | null) =>
      n !== null &&
      n.state === "active" &&
      n.group_id === wire.group_id &&
      n.epoch !== null &&
      n.epoch >= wire.epoch;
    if (!holds(rec.native)) return false;
    return holds(await this.#readStateDirect(rec));
  }

  /** Runs inside the channel lane (`#processWire`'s caller holds it). */
  async #envelopeAction(
    rec: ChannelRec | null,
    wire: TextWireEnvelope,
    verdict: TextEnvelopeVerdict,
    depth: number,
  ): Promise<ProcessResult> {
    const ids = { groupId: wire.group_id, envelopeId: wire.id };
    switch (verdict.action) {
      case "catch_up": {
        // Never skip ahead: gap-refetch to this envelope's epoch, then
        // reprocess it once (a duplicate is acked as processed).
        if (rec && depth === 0) {
          const ok = await this.#catchUpInner(rec, wire.epoch, wire.group_id);
          if (ok || rec.native?.group_id === wire.group_id) {
            return this.#processWire(rec, wire, depth + 1);
          }
        }
        return this.#hold(rec, wire);
      }
      case "park_owner_change":
        if (!rec) return this.#hold(rec, wire);
        // W4d X#9: a catch-up re-reads the same commit on every refresh;
        // park it once per (group, epoch) and per id.
        if (
          rec.parked.some(
            (p) =>
              p.id === wire.id ||
              (p.content_type === "mls_commit" &&
                wire.content_type === "mls_commit" &&
                p.group_id === wire.group_id &&
                p.epoch === wire.epoch),
          )
        ) {
          this.#queued.delete(wire.id);
        } else {
          rec.parked.push(wire);
        }
        rec.ownerChangePending = true;
        this.#emit(rec);
        return "parked";
      case "rejoin":
      case "join":
        if (!rec) return "dropped";
        // (e) S2-D31 `catch_up_leaf_unresolvable`: native rolled back and
        // did NOT move the group to `left`; `_mark_left` FIRST (in this
        // lane), or the rejoin would find the group still active.
        if (verdict.action === "rejoin" && verdict.markLeft !== undefined) {
          const reason = verdict.markLeft;
          try {
            await this.#invoke("e2ee_text_mark_left", {
              groupId: wire.group_id,
              reason,
            });
            this.#log("warn", "group left", { groupId: wire.group_id, reason });
          } catch (err) {
            if (isDisposed(err)) throw err;
            this.#log("warn", "mark_left failed", {
              ...ids,
              type: viewTagOf(err),
            });
          }
          await this.#readStateDirect(rec);
          this.#emit(rec);
        }
        this.#background(this.ensureJoined(rec.id));
        return "dropped";
      case "signer_leaf_missing_retry":
        // The joiner discards the Welcome; its join loop retries the intent.
        // FXF: counted only toward the budget of that Welcome's group, the
        // server's current one, under the list signer held now.
        if (rec && !this.#bindLeafMissing(rec, wire.group_id)) {
          return "dropped";
        }
        if (rec) {
          rec.signerLeafMissingRetries += 1;
          this.#emit(rec);
        }
        return "dropped";
      case "await_successor":
        if (rec && this.#isSigner(rec)) {
          this.#background(this.#createSuccessor(rec));
        }
        return "dropped";
      case "drop":
        return "dropped";
      case "drop_unexpected_content":
        this.#log("error", "unexpected content", ids);
        return "dropped";
      case "drop_unsolicited_welcome":
        this.#log("warn", "unsolicited welcome", ids);
        try {
          this.#port.notify("unsolicited_welcome");
        } catch {
          this.#log("error", "notify threw", ids);
        }
        return "dropped";
      case "refuse_wrong_kind":
        this.#log("error", "wrong group kind", ids);
        this.#queued.delete(wire.id);
        return "dropped";
      case "pin_identities_retry":
      case "hold":
        return this.#hold(rec, wire);
    }
  }

  /**
   * Not acked; retried after a backoff, at most `HOLD_RETRY_BUDGET` times.
   * Then it is left unacked (the server keeps it for the next drain).
   */
  #hold(rec: ChannelRec | null, wire: TextWireEnvelope): ProcessResult {
    if (isSynthTextEnvelopeId(wire.id)) return "held";
    const n = this.#holds.get(wire.id) ?? 0;
    if (n >= HOLD_RETRY_BUDGET) {
      this.#holds.delete(wire.id);
      this.#queued.delete(wire.id);
      this.#log("warn", "envelope left unacked", {
        groupId: wire.group_id,
        envelopeId: wire.id,
      });
      return "held";
    }
    this.#holds.set(wire.id, n + 1);
    this.#background(
      this.#sleep(publishBackoffMs(n)).then(() =>
        this.#enqueueEnvelope(rec ?? this.#recForGroup(wire.group_id), wire),
      ),
    );
    return "held";
  }

  /** Handle a successful `_process` / `_commit_won` (inside the lane). */
  async #onOutcome(
    out: TextProcessOutcome,
    origin: OutcomeOrigin = "live",
  ): Promise<void> {
    // LOW-2: native names the channel. One this manager has not registered
    // is dropped, never routed by the outcome's group id instead.
    const rec = this.#channels.get(out.channel_id);
    if (!rec) {
      this.#log("warn", "outcome for an unregistered channel dropped", {
        channelId: out.channel_id,
        groupId: out.group_id,
      });
      return;
    }
    const now = this.#port.now();
    for (const d of out.new_devices) {
      this.#marker(rec, {
        kind: "new_device",
        channelId: rec.id,
        groupId: out.group_id,
        epoch: out.epoch,
        userId: d.user_id,
        deviceId: d.device_id,
        atMs: now,
      });
    }
    // Forced-removal marker: a removed user the server listed as a pending
    // removal while still on the held seat list (owner unseats take the
    // user off the list first). GUESS: native reports no "forced" flag.
    const pending = new Set(
      (rec.serverGroup?.group_id === out.group_id
        ? rec.serverGroup.pending_removals
        : []
      ).map((p) => p.user_id),
    );
    const listed = new Set(rec.native?.seat_list?.seats ?? []);
    const forced = new Set<string>();
    for (const d of out.removed) {
      if (pending.has(d.user_id) && listed.has(d.user_id))
        forced.add(d.user_id);
    }
    for (const userId of forced) {
      this.#marker(rec, {
        kind: "forced_removal",
        channelId: rec.id,
        groupId: out.group_id,
        epoch: out.epoch,
        userId,
        atMs: now,
      });
    }
    // FXP F-L6 (M2): native joined a group by Welcome, or accepted a
    // Welcome or commit of the refused group: the refusal alarm is over.
    // For the refused group the join block its sticky tag held ends too (it
    // came from a Welcome, never from a group held; another group's sticky
    // tag keeps the X#1 rule).
    const refusal = rec.welcomeRefusal;
    if (
      refusal !== null &&
      (out.kind === "welcome_joined" || refusal.groupId === out.group_id)
    ) {
      rec.welcomeRefusal = null;
      const sticky = rec.stickyGroupError;
      if (
        sticky !== null &&
        sticky.tag === "mls_leaf_rejected" &&
        sticky.groupId === out.group_id
      ) {
        rec.stickyGroupError = null;
      }
    }
    if (out.kind === "welcome_joined") {
      this.#resetLeafMissing(rec, "joined");
      rec.welcomeRetriesExhausted = false;
      rec.recreateAvailable = false;
      rec.slmSeen = null;
      rec.refusalLift = null;
      rec.newerAddTried = null;
      // FXP F-L6 (m-c): the refused devices' pace of that group starts over.
      if (this.#refusalPaces(rec).some((p) => p.groupId === out.group_id)) {
        this.#writePaces(rec, null, out.group_id);
      }
      // (f) Joined: a recorded capacity refusal is over.
      rec.capacity = null;
      const js = rec.join;
      if (js) {
        // Eviction-loop guard: a processed Welcome cancels every retry.
        js.cancelled = true;
        js.welcome.resolve();
      }
      const extra = this.#cb as Partial<ProtectedTextManagerExtraCallbacks>;
      try {
        extra.onWelcomeJoined?.(rec.id, out.group_id);
      } catch {
        this.#log("error", "onWelcomeJoined threw", { channelId: rec.id });
      }
    }
    // D26: `_state` after each processed envelope.
    await this.#readStateDirect(rec);
    // X#1, after the state read so native's generation of a joined group
    // decides a sticky clear (LOW-2).
    this.#clearGroupError(rec, out);
    this.#emit(rec);
    // S4: the history link this device may owe for the new epoch.
    this.#historyAfterOutcome(rec, out, origin);
    // (i) An adoption from the commit's embedded list told this owner.
    this.#noteOwnerNotice(rec, out.owner_notice);
    if (out.removed_self) this.#background(this.ensureJoined(rec.id));
    // W4-3: a fresh leaf commits its Update promptly.
    if (out.kind === "welcome_joined") {
      this.#background(this.#commitUpdate(rec, true));
    }
    // D8: refresh after every processed commit.
    if (out.kind !== "duplicate") {
      this.#background(this.refresh(rec.id, "commit"));
    }
  }

  // -------------------------------------------------------------------------
  // Refresh (D8, D24, D26)
  // -------------------------------------------------------------------------

  async #refreshOnce(rec: ChannelRec, reason: TextRefreshReason) {
    await this.#ensureOwnPins(false);
    const [seatsRes, groupRes] = await Promise.all([
      this.#api("GET", `/channels/${rec.id}/seats`),
      this.#api("GET", `/mls/channels/${rec.id}/text_group`),
    ]);
    // W4d X#3: only a snapshot fetched in THIS pass is verified; after a
    // failed GET the older snapshot is kept for display, never re-verified
    // (native may have adopted a newer list since: a false rollback).
    let fresh: ProtectedSeatsResponse | null = null;
    if (seatsRes !== null && is2xx(seatsRes.status)) {
      fresh = parseSeats(seatsRes.body);
      if (fresh) {
        this.#reportSeats(rec, fresh);
        rec.seats = fresh;
      }
    }
    if (groupRes !== null && is2xx(groupRes.status)) {
      const g = parseTextGroup(groupRes.body);
      if (g) {
        // (h) A create's 409 names `open_group_id` without a generation
        // (v0/mls.rs `Conflict`); it is indexed here, by the refresh that
        // path runs before any join.
        this.#report(rec.id, g.group_id, g.generation, "text_group");
        rec.serverGroup = g;
        rec.serverGroupMissing = false;
        this.#noteOwnIntent(rec, g);
      }
    } else if (groupRes !== null && groupRes.status === 404) {
      rec.serverGroup = null;
      rec.serverGroupMissing = true;
    }
    if (fresh?.list) await this.#verifySeats(rec, fresh, true);
    await this.#readState(rec);
    this.#emit(rec);
    this.#afterRefresh(rec, reason);
  }

  /**
   * `_seat_list_verify` with the server's `as_of_*` (D24; `withAsOf` false
   * only for the D26 first-sight verify of a channel with no local group).
   * Records `seatListError`; null after a success.
   */
  async #verifySeats(
    rec: ChannelRec,
    seats: ProtectedSeatsResponse,
    withAsOf: boolean,
    retried = false,
    staleRefetches = 0,
  ): Promise<void> {
    const list = seats.list;
    if (!list) return;
    const owner = this.#port.channelInfo(rec.id)?.serverOwnerId ?? null;
    if (owner === null) {
      this.#log("warn", "verify skipped: server owner unknown", {
        channelId: rec.id,
      });
      return;
    }
    // F-L4b: the server's `list.authority` rides along whatever the signer
    // (the owner flow's `withAuthority` rule): a body naming an authority
    // verifies only with it, so a recovery list reaches the 4.7 owner-change
    // review. A malformed one is omitted, never passed: native then refuses
    // a body naming an authority (authority_invalid, loud).
    const authority = servedAuthority(list.authority);
    if (authority === undefined) {
      this.#log("warn", "seat list authority malformed: omitted", {
        channelId: rec.id,
      });
    }
    const args: TextCommandArgs["e2ee_text_seat_list_verify"] = {
      channelId: rec.id,
      list: {
        body: list.body,
        signature: list.signature,
        signer_user_id: list.signer_user_id,
        signer_device_id: list.signer_device_id,
        ...(authority ? { authority } : {}),
      },
      handovers: Array.isArray(list.handovers) ? list.handovers : [],
      serverOwnerId: owner,
      asOfEpoch: withAsOf ? seats.as_of_epoch : null,
      asOfGroupId: withAsOf ? seats.as_of_group_id : null,
      asOfGeneration: withAsOf ? (seats.as_of_generation ?? null) : null,
    };
    // OR-10: only the verify right after a confirm can show it unsettled.
    const confirmed = rec.confirmedSigner;
    rec.confirmedSigner = null;
    try {
      const verdict = await this.#enqueue(rec.id, () =>
        this.#invoke("e2ee_text_seat_list_verify", args),
      );
      rec.seatListError = null;
      rec.ownerChangeUnlisted = null;
      this.#noteOwnerNotice(rec, verdict.owner_notice);
      return;
    } catch (err) {
      if (isDisposed(err)) throw err;
      const tag = viewTagOf(err);
      const native = nativeErrorOf(err);
      this.#log("warn", "seat list verify failed", {
        channelId: rec.id,
        type: tag,
      });
      switch (tag) {
        case "busy":
          return;
        case "mls_epoch_gap":
          // D24: catch up to as_of_epoch, re-verify ONCE.
          if (
            !retried &&
            seats.as_of_epoch !== null &&
            seats.as_of_group_id !== null
          ) {
            const groupId = seats.as_of_group_id;
            const to = seats.as_of_epoch;
            await this.#enqueue(rec.id, () =>
              this.#catchUpInner(rec, to, groupId),
            );
            rec.confirmedSigner = confirmed;
            return this.#verifySeats(
              rec,
              seats,
              withAsOf,
              true,
              staleRefetches,
            );
          }
          break;
        case "identity_pin_required":
          if (!retried && native?.type === "identity_pin_required") {
            await this.#pinFor(native.user_id, [native.device_id]);
            rec.confirmedSigner = confirmed;
            return this.#verifySeats(
              rec,
              seats,
              withAsOf,
              true,
              staleRefetches,
            );
          }
          break;
        case "seat_list_rollback":
          // W4d X#3: a snapshot older than the held group epoch is stale,
          // not a rollback: re-GET (bounded), never record the loud tag.
          // Nothing is adopted from the older list (native refused it).
          if (withAsOf && (await this.#staleSnapshot(rec, seats))) {
            if (staleRefetches < STALE_SEATS_REFETCH_BUDGET) {
              const r = await this.#api("GET", `/channels/${rec.id}/seats`);
              const next =
                r !== null && is2xx(r.status) ? parseSeats(r.body) : null;
              if (next) {
                this.#reportSeats(rec, next);
                rec.seats = next;
              }
              if (next?.list) {
                rec.confirmedSigner = confirmed;
                return this.#verifySeats(
                  rec,
                  next,
                  withAsOf,
                  retried,
                  staleRefetches + 1,
                );
              }
            }
            this.#log("warn", "stale seat snapshot: rollback not recorded", {
              channelId: rec.id,
            });
            return;
          }
          break;
        case "owner_changed":
          rec.ownerChangePending = true;
          // OR-10 (4.7, FX2-D): the confirm resolved, yet the same-user
          // signer device is again unsettled: it is not on the carried
          // authority's owner devices. Review is withheld for it until the
          // list or the pin changes (`#ownerKey`).
          if (
            native?.type === "owner_changed" &&
            native.same_user &&
            confirmed !== null &&
            native.signer_device_id === confirmed
          ) {
            await this.#readState(rec);
            rec.ownerChangeUnlisted = {
              deviceId: confirmed,
              key: this.#ownerKey(rec),
            };
            this.#log("warn", "owner change unsettled after confirm", {
              channelId: rec.id,
            });
          }
          break;
        case "mls_group_not_found":
          // D24: a newer generation exists; take the join path.
          this.#background(this.ensureJoined(rec.id));
          break;
        default:
          // seat_list_behind keeps the held state (resecuring);
          // channel_mismatch and the loud tags turn the shield unverified.
          break;
      }
      rec.seatListError = tag;
    }
  }

  /**
   * X#3: the snapshot names the group native holds at an OLDER epoch than
   * native's (read fresh), so a newer list may have been adopted since.
   */
  async #staleSnapshot(
    rec: ChannelRec,
    seats: ProtectedSeatsResponse,
  ): Promise<boolean> {
    const n = await this.#readState(rec);
    return (
      n !== null &&
      seats.as_of_group_id !== null &&
      seats.as_of_epoch !== null &&
      n.group_id === seats.as_of_group_id &&
      n.epoch !== null &&
      seats.as_of_epoch < n.epoch
    );
  }

  /** Maintenance a refresh can reveal (fire-and-forget, errors logged). */
  #afterRefresh(rec: ChannelRec, reason: TextRefreshReason): void {
    if (this.#disposed || rec.stripped) return;
    const n = rec.native;
    const g = rec.serverGroup;
    if (!n) return;
    const self = this.#port.selfUserId;
    // W4d X#2: a stage native persisted (a crash, a restart, a parked
    // commit) is resumed first when no commit flow runs for its group; the
    // routine commits (`#maintain`) run only when there was none.
    if (
      n.state === "active" &&
      n.group_id !== null &&
      !this.#busy(n.group_id)
    ) {
      this.#background(
        this.#resumeStage(rec).then((resumed) => {
          if (!resumed) this.#maintain(rec);
        }),
      );
    } else if (n.group_id === null || !this.#busy(n.group_id)) {
      // W4d N4: never while a commit flow (e.g. a resume) holds the group:
      // a routine Update would re-stage over the pending stage.
      this.#maintain(rec);
    }
    // S4 floor (a): an outdated client creates and joins nothing here.
    const outdated = rec.clientOutdated !== null;
    // D21 successor: native poisoned, this device signed the current list,
    // and the server still names the poisoned group as open.
    if (
      !outdated &&
      n.state === "poisoned" &&
      g &&
      g.group_id === n.group_id &&
      this.#isSigner(rec)
    ) {
      this.#background(this.#createSuccessor(rec));
    }
    // D21 crash recovery: protected, no open text group, this device is
    // the current list signer → create generation 0.
    if (
      !outdated &&
      !g &&
      rec.serverGroupMissing &&
      n.group_id === null &&
      this.#isSigner(rec)
    ) {
      this.#background(this.#createSuccessor(rec));
    }
    // D21 crash recovery AFTER the local create: re-run the idempotent
    // create once per group per session (a refusal never loops).
    const unaccepted = this.#unacceptedCreate(rec);
    if (
      !outdated &&
      unaccepted &&
      !rec.successorInFlight &&
      !rec.recreating &&
      !this.#createPosted.has(unaccepted.groupId)
    ) {
      this.#createPosted.add(unaccepted.groupId);
      const run = this.#recreateUnaccepted(rec, unaccepted).finally(() => {
        if (rec.recreating === run) rec.recreating = null;
      });
      rec.recreating = run;
      this.#background(run);
    }
    // S2 (c): a superseded group (`active`, verdict `no_group`) is not held.
    const holds =
      g !== null &&
      n.group_id === g.group_id &&
      (holdsCurrentGroup(n) || n.state === "poisoned");
    // FXT2 MAJOR-1: holding the server's group, this device's latest Add
    // is handled (whichever Welcome joined it): a later wipe or rollback
    // never takes that Add's stored-Welcome path again.
    if (g !== null && holdsCurrentGroup(n) && n.group_id === g.group_id) {
      const own = ownAddedEntry(g, self, this.#port.selfDeviceId);
      if (own !== null) rec.welcomeDone = own.key;
    }
    // S2-D28: a member admits from the server's stored intents.
    if (
      g !== null &&
      holdsCurrentGroup(n) &&
      n.group_id === g.group_id &&
      STORED_ADMIT_REASONS.includes(reason)
    ) {
      this.#admitStored(rec, g);
    }
    const seated = n.self_seated && n.seat_list?.seats.includes(self) === true;
    // FXP F-L6: the alarm survives a reload (m-a); an open, a retryNow, a
    // commit or an event refresh may lift a refused Welcome's join block
    // (m-b, MJ-1), every grant under the persisted pace.
    this.#restoreRefusal(rec);
    if (REFUSAL_GRANT_REASONS.includes(reason)) {
      this.#refusalRejoin(rec, reason);
    }
    // Joining the server's older group would only answer ChannelMismatch.
    // S2 (f): after a capacity refusal only an open or a
    // `ProtectedChannelChanged` (which clears it) joins again. S2-D28:
    // `welcomeRetriesExhausted` no longer stops a join (silence never
    // does); a verified failure on the server's group does.
    const wantsJoin =
      g !== null &&
      !this.#joinFailedVerified(rec, g.group_id) &&
      seated &&
      !holds &&
      unaccepted === null &&
      !outdated &&
      (rec.capacity === null || reason === "open") &&
      (reason !== "start" || n.state === "left");
    if (wantsJoin && !rec.join) this.#background(this.ensureJoined(rec.id));
  }

  /**
   * S2-D28: admit from the server's stored `join_requests` (the refreshes
   * in `STORED_ADMIT_REASONS`). Every entry goes through `#admit`, the live
   * `MlsJoinRequested` handler: the same seat check, claim hold, leaf-index
   * stagger, dedupe against an admission in flight and against a device
   * already in the group; native verifies the signature and refuses an
   * off-list user. A malformed entry is dropped whole (OR-6). One pass per
   * channel at a time, entries in order.
   */
  #admitStored(rec: ChannelRec, g: ProtectedTextGroupResponse): void {
    if (rec.storedAdmit) return;
    const { requests, dropped } = storedJoinRequests(
      g.join_requests,
      g.group_id,
      rec.id,
    );
    if (dropped > 0) {
      this.#log("warn", "malformed stored join requests dropped", {
        channelId: rec.id,
        groupId: g.group_id,
        count: dropped,
      });
    }
    // FX-J2 NEW-3: a request native refused this session is never claimed
    // for again from the stored list (a live intent with a new
    // KeyPackage ref is a new request).
    const fresh = requests.filter(
      ({ request }) => !this.#admitRefused.has(admitRefusalKey(request)),
    );
    if (fresh.length < requests.length) {
      this.#log("debug", "refused stored join requests skipped", {
        channelId: rec.id,
        groupId: g.group_id,
        count: requests.length - fresh.length,
      });
    }
    if (fresh.length === 0) return;
    const run = (async () => {
      for (const { request, rejoin } of fresh) {
        if (this.#disposed) return;
        await this.#admit(request, rejoin);
      }
    })().finally(() => {
      if (rec.storedAdmit === run) rec.storedAdmit = null;
    });
    rec.storedAdmit = run;
    this.#background(run);
  }

  /** The routine commits a refresh can reveal, for the group both hold. */
  #maintain(rec: ChannelRec): void {
    if (this.#disposed || rec.stripped) return;
    const n = rec.native;
    const g = rec.serverGroup;
    if (!n || !g || !holdsCurrentGroup(n) || n.group_id !== g.group_id) return;
    const self = this.#port.selfUserId;
    const dev = this.#port.selfDeviceId;
    const leafPending = pendingDeviceTargetsOf(g, n, self, dev).some((d) =>
      n.members.some(
        (m) => m.user_id === d.user_id && m.device_id === d.device_id,
      ),
    );
    if (g.pending_removals.length > 0 || leafPending) {
      this.#background(this.#commitPendingRemovals(rec));
    } else if (n.epoch !== null && n.epoch < g.current_epoch) {
      // W4d X#9: not while an owner change is parked; the catch-up would
      // only re-read (and re-park) the same commit on every refresh.
      if (rec.parked.length === 0) {
        this.#background(this.catchUp(rec.id, g.current_epoch, g.group_id));
      }
    } else if (n.update_due || n.update_required) {
      this.#background(this.#commitUpdate(rec, false));
    }
  }

  async #intervalLoop(rec: ChannelRec, signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.#disposed) {
      try {
        await this.#port.sleep(REFRESH_INTERVAL_MS, signal);
      } catch {
        return;
      }
      if (signal.aborted || this.#disposed) return;
      await this.refresh(rec.id, "interval");
    }
  }

  // -------------------------------------------------------------------------
  // D26: state at start + first-sight verify for unopened channels
  // -------------------------------------------------------------------------

  async #seed(rec: ChannelRec): Promise<void> {
    if (rec.seeded || this.#disposed) return;
    rec.seeded = true;
    await this.#readState(rec);
    this.#emit(rec);
    // W4d X#2: a commit stage persisted before a restart (or a manager
    // rebuild) is resumed at once, not left to wedge sends.
    if (rec.native?.state === "active" && rec.native.group_id !== null) {
      this.#background(this.#resumeStage(rec));
    }
    if (rec.native === null || rec.native.group_id === null) {
      this.#firstSightQueue.push(rec);
      this.#background(this.#firstSightWorker());
    } else if (rec.native.state === "left") {
      // A device that lost its leaf rejoins without waiting for an open.
      this.#background(this.refresh(rec.id, "start"));
    }
  }

  async #firstSightWorker(): Promise<void> {
    if (this.#firstSightRunning) return;
    this.#firstSightRunning = true;
    try {
      while (this.#firstSightQueue.length > 0 && !this.#disposed) {
        if (this.#firstSightWindowCount >= FIRST_SIGHT_PER_MINUTE) {
          const wait = this.#firstSightWindowStart + 60_000 - this.#port.now();
          if (wait > 0) await this.#sleep(wait);
          this.#firstSightWindowCount = 0;
        }
        if (this.#firstSightWindowCount === 0) {
          this.#firstSightWindowStart = this.#port.now();
        }
        this.#firstSightWindowCount += 1;
        const rec = this.#firstSightQueue.shift()!;
        try {
          await this.#firstSightVerify(rec);
        } catch (err) {
          if (isDisposed(err)) return;
          this.#log("warn", "first-sight verify failed", {
            channelId: rec.id,
            type: viewTagOf(err),
          });
        }
        if (this.#firstSightQueue.length > 0) {
          await this.#sleep(FIRST_SIGHT_STAGGER_MS);
        }
      }
    } finally {
      this.#firstSightRunning = false;
    }
  }

  /** GET .../seats + `_seat_list_verify` without `as_of_*` (no group). */
  async #firstSightVerify(rec: ChannelRec): Promise<void> {
    if (rec.native !== null && rec.native.group_id !== null) return;
    const r = await this.#api("GET", `/channels/${rec.id}/seats`);
    if (r === null || !is2xx(r.status)) return;
    const seats = parseSeats(r.body);
    if (!seats) return;
    this.#reportSeats(rec, seats);
    rec.seats = seats;
    await this.#verifySeats(rec, seats, false);
    await this.#readState(rec);
    this.#emit(rec);
  }

  // -------------------------------------------------------------------------
  // Join (design 6.3, D19, 9.1 6c/6d)
  // -------------------------------------------------------------------------

  /**
   * S2-D28: the join runs until this device holds the server's current
   * group. The intent is re-broadcast with backoff (10 s doubling, held at
   * 15 min); past `JOIN_RETRIES` unanswered intents the shield reads
   * "waiting for a member" (6d) while it keeps going. It stops on a held
   * group, unseated, a capacity refusal, an outdated client, a verified
   * failure, a strip or dispose; silence never stops it.
   */
  async #runJoin(rec: ChannelRec, js: JoinState): Promise<void> {
    await this.refresh(rec.id, "commit");
    const n = rec.native;
    let g = rec.serverGroup;
    if (!n) throw clientFailure("state_unavailable");
    if (holdsCurrentGroup(n) && g && n.group_id === g.group_id) return;
    if (n.verdict === "not_seated" || !n.self_seated) {
      throw {
        source: "native",
        error: { type: "not_seated", channel_id: rec.id },
      } satisfies TextFlowFailure;
    }
    const unaccepted = this.#unacceptedCreate(rec);
    if (unaccepted) {
      // D21: re-run the create instead (joining would be ChannelMismatch).
      await (rec.recreating ?? this.#recreateUnaccepted(rec, unaccepted));
      return;
    }
    if (!g) {
      if (rec.serverGroupMissing && this.#isSigner(rec)) {
        await this.createGroup(rec.id, null);
        return;
      }
      throw clientFailure("no_group");
    }
    if (n.group_id === g.group_id && n.state === "poisoned") {
      throw clientFailure("poisoned");
    }
    if (this.#parkUnsettleable(rec, g.group_id)) {
      throw this.#endUnsettleableJoin(rec, g.group_id);
    }
    if (this.#joinFailedVerified(rec, g.group_id)) {
      throw clientFailure("join_failed");
    }
    // Intents this run sent (the 6d signal) and consecutive KeyPackage
    // publish failures (a server failure, bounded; never silence).
    let sent = 0;
    let unpublishedRuns = 0;
    // FX-J2 NEW-2: a Welcome path ran since the last intent. A newer Add
    // right behind it waits a backoff step first (no fetch per refresh).
    let pathRan = false;
    const self = this.#port.selfUserId;
    const dev = this.#port.selfDeviceId;
    for (;;) {
      if (js.cancelled) return;
      this.#checkAlive();
      // FXF: a Welcome for the server's group waits, parked, for the
      // owner-change confirm (D15). Its Add is pending: no re-broadcast and
      // no rejoin (members would evict and re-add this device each time)
      // until the confirm resolves it or the server's group moves on.
      // FXP m3-1: only while that owner change can still settle it (a
      // same-user pending signer) or a replay of it runs. FXP m4-1: with
      // neither, nothing this device can do settles the park, and an intent
      // would only have members evict and re-add it for a Welcome that
      // parks behind the same head: the join ends loudly instead.
      if (welcomeParkedFor(rec.parked, g.group_id)) {
        if (this.#ownerChangePending(rec) || rec.replaying.size > 0) {
          if (await this.#joinWait(js, joinRebroadcastDelayMs(js.backoff++))) {
            return;
          }
          if (js.cancelled) return;
          const next = await this.#joinRecheck(rec);
          if (next === null) return;
          g = next;
          continue;
        }
        if (this.#parkUnsettleable(rec, g.group_id)) {
          throw this.#endUnsettleableJoin(rec, g.group_id);
        }
      }
      // W4d X#6 / S2-D29, before EVERY `_join`: re-Added at/after our last
      // intent means a Welcome is due, and another intent would read as a
      // rejoin and evict that fresh leaf. Wait for it, then fetch the
      // stored one (`#welcomeDue`): ONE path per Add. FX-J2 NEW-1: short of
      // a join (a 404, a Welcome native processed without a join, e.g. a
      // `signer_leaf_missing` counted toward 6c, a busy hold, nothing
      // usable) the Add is done and the intent is re-broadcast on the
      // backoff below; that Add is never fetched again.
      const added = ownAddedEntry(g, self, dev);
      // F-L13: with no intent sent this session, an Add of this device not
      // handled yet is due too, but ONLY while native is `joining`: native
      // `_join` set it, so an intent of this device (an earlier session's,
      // or one stored before a reload) is still outstanding and only it
      // makes a stored Welcome processable. The server keeps `member_added`
      // for every member device, so a `left` or `none` device (a wiped or
      // rolled-back leaf) skips this and sends its rejoin intent at once
      // (FXT2 MAJOR-1: its old Welcome would only be refused as unsolicited).
      const joining = rec.native?.state === "joining";
      const fromEpoch =
        rec.joinFromEpoch ?? (joining ? (added?.epoch ?? null) : null);
      if (added !== null && welcomePending(added, fromEpoch, rec.welcomeDone)) {
        if (pathRan) {
          pathRan = false;
          if (await this.#joinWait(js, joinRebroadcastDelayMs(js.backoff++))) {
            return;
          }
        } else {
          const step = await this.#welcomeDue(rec, js, g.group_id);
          if (step === "joined" || js.cancelled) return;
          rec.welcomeDone = added.key;
          pathRan = true;
          // FXP F-L6 (MJ-2): a newer Add's path ended without a join.
          this.#endNewerAdd(rec, added.key);
          // FXP F-L6: native refused that stored Welcome (e.g. on a reload):
          // its one rejoin per open may start here (`#refusalRejoin`), else
          // the recheck below ends the join on the sticky refusal.
          this.#refusalRejoin(rec, "stored");
          // FXF: a parked Welcome is that Add's path too; the wait above
          // holds the rejoin until the confirm resolves it.
          this.#log(
            "info",
            step === "parked"
              ? "stored welcome parked: join waits for the owner change"
              : "stored welcome path done: rejoin intent",
            { channelId: rec.id, groupId: g.group_id, why: step },
          );
        }
        if (js.cancelled) return;
        // A held group or a verified failure (the 6c budget) ends it here.
        const next = await this.#joinRecheck(rec);
        if (next === null) return;
        g = next;
        continue;
      }
      // FXP F-L7: this device's Welcome waits on an owner change (parked or
      // being replayed by a confirm, or an Add of this device while the
      // change is pending and an intent of this device is outstanding): no
      // intent, which members would answer by evicting and re-adding this
      // device. It ends when the confirm resolves it, or the server's group
      // moves on; while the user declines, the join waits on the backoff.
      if (this.#ownerChangeHoldsIntent(rec, g)) {
        pathRan = false;
        this.#log("info", "join intent held: an owner change is pending", {
          channelId: rec.id,
          groupId: g.group_id,
        });
        if (await this.#joinWait(js, joinRebroadcastDelayMs(js.backoff++))) {
          return;
        }
        if (js.cancelled) return;
        const next = await this.#joinRecheck(rec);
        if (next === null) return;
        g = next;
        continue;
      }
      // F-L13: EVERY intent (a run's first one and its re-broadcasts, FXT2
      // MAJOR-2 b) waits while this device's previous intent may be being
      // admitted (`joinIntentHeld`): a fresh intent racing that admit lands
      // after the Add, reads as a rejoin and poisons this device. While the
      // server lists the own intent, the S2-D28 pace is therefore at least
      // one `JOIN_ADMIT_WINDOW_MS` per intent.
      const hold = this.#joinHoldMs(rec, g);
      if (hold > 0) {
        pathRan = false;
        this.#log("info", "join intent held: an admit may be landing", {
          channelId: rec.id,
          groupId: g.group_id,
          waitMs: hold,
        });
        if (await this.#joinWait(js, hold)) return;
        if (js.cancelled) return;
        const next = await this.#joinRecheck(rec);
        if (next === null) return;
        g = next;
        continue;
      }
      // FXP MJ-2b: no intent ever leaves under a newer-Add lift: its path
      // did not run here, so the block is back and that Add is judged under
      // the refused device's pace (a grant is counted, else join_failed).
      if (rec.refusalLift !== null) {
        this.#endNewerAdd(rec, rec.refusalLift.addKey);
        const next = await this.#joinRecheck(rec);
        if (next === null) return;
        g = next;
        continue;
      }
      pathRan = false;
      rec.joinFromEpoch = g.current_epoch;
      // Every attempt is a fresh `_join`: native mints a new one-time
      // KeyPackage per intent (W3 2026-10-25).
      let joined: TextCommandResult["e2ee_text_join"];
      const gid = g.group_id;
      const generation = g.generation;
      try {
        joined = await this.#enqueue(rec.id, () =>
          this.#invoke("e2ee_text_join", {
            groupId: gid,
            channelId: rec.id,
            generation,
            userId: this.#port.selfUserId,
          }),
        );
      } catch (err) {
        const tag = viewTagOf(err);
        if (tag === "already_member") {
          // The device already holds a leaf: nothing to join.
          await this.#readState(rec);
          return;
        }
        if (tag !== "busy") this.#recordGroupError(rec, tag, tag, gid);
        throw toFailure(err);
      }
      // Publish the intent's KeyPackage FIRST (an admitter claims that very
      // package), then post the intent alone. A refused PUT throws here and
      // the intent is never posted.
      const unpublished = await this.#putJoinKeyPackage(
        gid,
        joined.key_packages,
      );
      if (unpublished !== null) {
        // 5xx / transport / 429 past its budget: back off and retry with a
        // fresh `_join`; `JOIN_RETRIES` consecutive failures end the join.
        unpublishedRuns += 1;
        if (unpublishedRuns > JOIN_RETRIES) throw unpublished;
        await this.#sleep(publishBackoffMs(unpublishedRuns));
        continue;
      }
      unpublishedRuns = 0;
      if (js.cancelled) return;
      // F-L13 (FXT2 MAJOR-2 a): re-read right before the POST. The minted
      // KeyPackage stays unclaimed when the intent is not posted (harmless).
      const pre = await this.#beforeIntentPost(
        rec,
        gid,
        ownAddedEntry(g, self, dev)?.key ?? null,
      );
      if (pre === "joined") return;
      if (pre === "held") {
        // FXP F-L7: the Welcome parked (or the owner change became pending)
        // while this intent was minted: not posted; a backoff step, then
        // the loop's hold takes over (never a tight re-mint).
        this.#log(
          "info",
          "join intent not posted: an owner change is pending",
          { channelId: rec.id, groupId: gid },
        );
        if (await this.#joinWait(js, joinRebroadcastDelayMs(js.backoff++))) {
          return;
        }
        if (js.cancelled) return;
        const again = await this.#joinRecheck(rec);
        if (again === null) return;
        g = again;
        continue;
      }
      if (pre !== "post" && pre !== "unknown") {
        // An Add of this device appeared: its Welcome path, not an intent.
        this.#log("info", "join intent not posted: an Add landed", {
          channelId: rec.id,
          groupId: gid,
        });
        g = pre;
        continue;
      }
      if (pre === "unknown") {
        this.#log("info", "join intent not posted: text_group unread", {
          channelId: rec.id,
          groupId: gid,
        });
        if (await this.#joinWait(js, joinRebroadcastDelayMs(js.backoff++))) {
          return;
        }
        if (js.cancelled) return;
        const again = await this.#joinRecheck(rec);
        if (again === null) return;
        g = again;
        continue;
      }
      // S4 floor (a, OR-3): the verified shell protocol, unsigned, beside
      // native's signed intent (sent as received, never rebuilt).
      const body: TextJoinIntentBody = {
        ...joined.intent,
        protocol: TEXT_PROTOCOL,
      };
      const r = await this.#api("POST", `/mls/groups/${gid}/join_intent`, body);
      sent += 1;
      if (r !== null && is2xx(r.status)) {
        // F-L13: a member may admit it from now on.
        rec.lastIntentAtMs = this.#port.now();
        rec.lastIntentRef = joined.intent.key_package_ref;
        // (f) The server took the intent: no longer over a cap.
        if (rec.capacity !== null) {
          rec.capacity = null;
          this.#emit(rec);
        }
      } else if (r !== null && r.status === 404) {
        await this.refresh(rec.id, "commit");
        if (!rec.serverGroup) throw clientFailure("no_group");
      } else if (r !== null && r.status === 429) {
        // `InSlowmode` included: its `retry_after` is honoured, never a
        // notice (inherited L1s).
        await this.#sleep(retryAfterMs(r) ?? publishBackoffMs(sent));
      } else if (r !== null && is4xx(r.status)) {
        // (a)(f) `joinRefusal` BEFORE the generic refusal. Neither is a
        // Welcome retry: the join stops here (never counted toward 6d).
        const refusal = joinRefusal(r);
        if (refusal?.kind === "outdated") {
          this.#markOutdated(rec, refusal.min);
        } else if (refusal?.kind === "capacity") {
          rec.capacity = { reason: refusal.reason };
          this.#log("warn", "join refused for capacity", {
            channelId: rec.id,
            reason: refusal.reason,
          });
          this.#emit(rec);
        }
        throw serverFailure(r);
      }
      // S2-D28: re-broadcast after the backoff wait; never a give-up.
      if (await this.#joinWait(js, joinRebroadcastDelayMs(js.backoff++))) {
        return;
      }
      if (js.cancelled) return;
      const next = await this.#joinRecheck(rec);
      if (next === null) return;
      g = next;
      // design 7.2 member_added: a re-Add at/after our intent is handled at
      // the top of the loop (its ONE Welcome path, then the re-broadcast).
      if (
        sent > JOIN_RETRIES &&
        !welcomePending(
          ownAddedEntry(g, self, dev),
          rec.joinFromEpoch,
          rec.welcomeDone,
        )
      ) {
        this.#markJoinStalled(rec);
      }
    }
  }

  /**
   * F-L13 (FXT2 MAJOR-2 a): right before an intent POST. Native state is
   * read FIRST (any wait in the channel's queue happens here, before the
   * server read), then a fresh `text_group`; nothing awaits between that
   * GET's answer and the caller's POST. "joined": this device holds `gid`.
   * A group: an Add of this device appeared since `addedKey` (the Add the
   * run last read), so the intent would read as a rejoin. "unknown": the
   * GET failed (no POST this round: a skipped intent costs a backoff step,
   * a racing one can poison the device). "held" (FXP F-L7): this device's
   * Welcome now waits on an owner change (`#ownerChangeHoldsIntent`, read
   * on the fresh state and group). "post": send it.
   */
  async #beforeIntentPost(
    rec: ChannelRec,
    gid: string,
    addedKey: string | null,
  ): Promise<
    "joined" | "post" | "unknown" | "held" | ProtectedTextGroupResponse
  > {
    const n = await this.#readState(rec);
    if (n && holdsCurrentGroup(n) && n.group_id === gid) return "joined";
    const r = await this.#api("GET", `/mls/channels/${rec.id}/text_group`);
    const g = r !== null && is2xx(r.status) ? parseTextGroup(r.body) : null;
    if (g === null) return "unknown";
    this.#report(rec.id, g.group_id, g.generation, "text_group");
    rec.serverGroup = g;
    this.#noteOwnIntent(rec, g);
    if (
      this.#ownerChangeHoldsIntent(rec, g) ||
      this.#parkUnsettleable(rec, g.group_id)
    ) {
      return "held";
    }
    const added = ownAddedEntry(
      g,
      this.#port.selfUserId,
      this.#port.selfDeviceId,
    );
    return added !== null && added.key !== addedKey ? g : "post";
  }

  /**
   * S2-D28: THE join timer of a channel (one at a time). True once a
   * Welcome is processed; false when `ms` elapse. A backoff reset
   * (`#resetJoinBackoff`) re-arms it for at most the first backoff step
   * from now. The timer is cleared on every exit, so a Welcome or a
   * dispose leaves none behind.
   */
  async #joinWait(js: JoinState, ms: number): Promise<boolean> {
    let until = this.#port.now() + ms;
    const life = this.#abort.signal;
    for (;;) {
      this.#checkAlive();
      js.wait?.abort();
      const ctl = new AbortController();
      js.wait = ctl;
      js.reset = false;
      const stop = () => ctl.abort();
      life.addEventListener("abort", stop, { once: true });
      let welcomed: boolean;
      try {
        welcomed = await Promise.race([
          js.welcome.promise.then(() => true),
          this.#port
            .sleep(Math.max(0, until - this.#port.now()), ctl.signal)
            .then(
              () => false,
              () => false,
            ),
        ]);
      } finally {
        ctl.abort();
        life.removeEventListener("abort", stop);
        if (js.wait === ctl) js.wait = null;
      }
      this.#checkAlive();
      if (welcomed || !js.reset) return welcomed;
      until = Math.min(until, this.#port.now() + joinRebroadcastDelayMs(0));
    }
  }

  /**
   * S2-D28 (open, `ProtectedChannelChanged`): the backoff restarts at its
   * first step, and a pending join wait ends at most that step from now.
   * Never an extra intent at once (an open joins the running join). FX-J2
   * NEW-2: an event restarts it at most once per `JOIN_EVENT_RESET_GAP_MS`
   * (`joinEventResetAllowed`); an open always does, and so does an owner
   * change the user confirmed (FXF: a parked Welcome was replayed) or that
   * native settled without a confirm (FXP MJ-3, `settled`).
   */
  #resetJoinBackoff(
    rec: ChannelRec,
    why: "open" | "event" | "confirm" | "settled",
  ): void {
    const js = rec.join;
    if (!js) return;
    if (why === "event") {
      const now = this.#port.now();
      if (!joinEventResetAllowed(rec.joinEventResetAtMs, now)) return;
      rec.joinEventResetAtMs = now;
    }
    js.backoff = 0;
    if (js.wait) {
      js.reset = true;
      js.wait.abort();
    }
  }

  /**
   * F-L13: how long a join run's next intent still waits (0 = send now):
   * this device's own intent is stored on the server (`g.join_requests`)
   * and went out or was first seen less than `JOIN_ADMIT_WINDOW_MS` ago.
   * The later of the two starts the window. A liveness aid only (server
   * data never decides trust here). Each new own-intent ref (this device's
   * own re-broadcast, another window of this device, or a server rotating
   * refs) starts the window again, so a server can keep a join waiting; it
   * could withhold the Add anyway.
   */
  #joinHoldMs(rec: ChannelRec, g: ProtectedTextGroupResponse): number {
    const self = this.#port.selfUserId;
    const dev = this.#port.selfDeviceId;
    const ref = ownStoredIntentRef(g, self, dev);
    const seen = rec.ownIntentSeen?.ref === ref ? rec.ownIntentSeen : null;
    // FXT2: the stored row IS this manager's last intent: its window runs
    // from that POST (first sight is a refresh later). Any other ref (an
    // earlier session's, another window's) runs from first sight.
    const sinceMs =
      ref !== null && ref === rec.lastIntentRef
        ? rec.lastIntentAtMs
        : (seen?.atMs ?? null);
    const nowMs = this.#port.now();
    const held = joinIntentHeld({
      ownIntentStored: ref !== null,
      sinceMs,
      nowMs,
    });
    return held && sinceMs !== null
      ? sinceMs + JOIN_ADMIT_WINDOW_MS - nowMs
      : 0;
  }

  /**
   * F-L13: track this device's own stored intent by its KeyPackage ref (a
   * re-broadcast mints a new one): first seen now, kept while unchanged,
   * cleared once the server lists none.
   */
  #noteOwnIntent(rec: ChannelRec, g: ProtectedTextGroupResponse): void {
    const ref = ownStoredIntentRef(
      g,
      this.#port.selfUserId,
      this.#port.selfDeviceId,
    );
    if (ref === null) {
      rec.ownIntentSeen = null;
    } else if (rec.ownIntentSeen?.ref !== ref) {
      rec.ownIntentSeen = { ref, atMs: this.#port.now() };
    }
  }

  /** 6d: past the first retries; the shield reads "waiting for a member". */
  #markJoinStalled(rec: ChannelRec): void {
    if (rec.welcomeRetriesExhausted) return;
    rec.welcomeRetriesExhausted = true;
    rec.recreateAvailable = this.#isSigner(rec);
    this.#emit(rec);
  }

  /**
   * After a join wait: re-read the server group and native state. Null once
   * this device holds the server's current group; throws on every S2-D28
   * stop (no open group, unseated, outdated, stripped, poisoned, a verified
   * failure: a sticky loud error on that group or the 6c budget spent).
   */
  async #joinRecheck(
    rec: ChannelRec,
  ): Promise<ProtectedTextGroupResponse | null> {
    await this.refresh(rec.id, "commit");
    const n = rec.native;
    const g = rec.serverGroup;
    if (n && g && holdsCurrentGroup(n) && n.group_id === g.group_id) {
      return null;
    }
    if (!g) throw clientFailure("no_group");
    if (rec.stripped) throw clientFailure("flag_stripped");
    if (rec.clientOutdated !== null) throw clientFailure("client_outdated");
    if (n && (n.verdict === "not_seated" || !n.self_seated)) {
      throw {
        source: "native",
        error: { type: "not_seated", channel_id: rec.id },
      } satisfies TextFlowFailure;
    }
    if (n && n.group_id === g.group_id && n.state === "poisoned") {
      throw clientFailure("poisoned");
    }
    if (this.#parkUnsettleable(rec, g.group_id)) {
      throw this.#endUnsettleableJoin(rec, g.group_id);
    }
    if (this.#joinFailedVerified(rec, g.group_id)) {
      throw clientFailure("join_failed");
    }
    return g;
  }

  /**
   * S2-D28: a VERIFIED failure ends the join into `groupId` (and keeps a
   * refresh from restarting it): a sticky loud error recorded for that
   * group (X#1), or the 6c `signer_leaf_missing` budget spent on that group
   * under the list signer held now (`leafMissingSpent`). FXF: that budget
   * starts over on a successor group, a list from another signer, an open
   * or a `retryNow` (`#rebindLeafMissing`, `#resetLeafMissing`); never on
   * a background refresh. Silence is never a failure.
   */
  #joinFailedVerified(rec: ChannelRec, groupId: string): boolean {
    return (
      rec.stickyGroupError?.groupId === groupId ||
      this.#parkUnsettleable(rec, groupId) ||
      leafMissingSpent(
        rec.signerLeafMissingRetries,
        rec.signerLeafMissingOn,
        groupId,
        leafMissingSigner(rec.native),
      )
    );
  }

  /**
   * FXP F-L7: an owner change awaits this device's confirm (D15): native
   * holds a SAME-USER pending signer (`owner_pin.pending_signer`, read
   * after every verify; MJ-3: another user's is never confirmable, so it
   * neither parks nor holds). Native's record, never `rec.ownerChangePending`:
   * native clears it on the confirm AND on any list it adopts, while only a
   * confirm clears the manager's flag.
   */
  #ownerChangePending(rec: ChannelRec): boolean {
    return rec.native?.owner_pin?.pending_signer?.same_user === true;
  }

  /**
   * FXP m4-1: this device's Welcome for `groupId` is parked behind a park
   * nothing here can settle: no same-user pending signer (a confirm's or
   * an adopted list's replay would need one, MJ-3), no replay running and
   * no confirm under way. Only an owner-change park starts the parked
   * queue, so this is another user's owner change (never an honest
   * handover: that one records no pending signer). A verified failure
   * (`#joinFailedVerified`) while it lasts; a reload, or a same-user owner
   * change the user confirms, ends it.
   */
  #parkUnsettleable(rec: ChannelRec, groupId: string): boolean {
    return (
      welcomeParkedFor(rec.parked, groupId) &&
      !this.#ownerChangePending(rec) &&
      rec.replaying.size === 0 &&
      !rec.confirmInFlight
    );
  }

  /**
   * FXP m4-1: the join into `groupId` ends with no intent sent: the
   * owner-change notice (the existing D15 copy) is shown and the join
   * failure is verified.
   */
  #endUnsettleableJoin(rec: ChannelRec, groupId: string): TextFlowFailure {
    this.#setGroupError(rec, "owner_changed", groupId);
    this.#log("error", "join ended: welcome parked behind an owner change", {
      channelId: rec.id,
      groupId,
    });
    return clientFailure("join_failed");
  }

  /**
   * FXP F-L7 (`joinIntentHeldByOwnerChange`, m3, MJ-3): no intent into `g`
   * now. The `signer_leaf_missing` must be of the Welcome of this device's
   * LATEST Add in `g` (a Welcome's epoch is its Add's epoch).
   */
  #ownerChangeHoldsIntent(
    rec: ChannelRec,
    g: ProtectedTextGroupResponse,
  ): boolean {
    const added = ownAddedEntry(
      g,
      this.#port.selfUserId,
      this.#port.selfDeviceId,
    );
    const slm = rec.slmSeen;
    return joinIntentHeldByOwnerChange({
      welcomeReplaying: [...rec.replaying.values()].some((l) =>
        welcomeParkedFor(l, g.group_id),
      ),
      welcomeParked: welcomeParkedFor(rec.parked, g.group_id),
      slmForAdd:
        slm !== null &&
        added !== null &&
        slm.groupId === g.group_id &&
        slm.epoch === added.epoch,
      ownerChangePending: this.#ownerChangePending(rec),
    });
  }

  /**
   * FXP F-L7 (MJ-3, m3-1, residual 3): native shows no same-user pending
   * signer any more (a list was adopted without a confirm) while envelopes
   * parked under one still wait (`parkedUnderPending`: a Welcome parked for
   * `signer_leaf_missing`, a commit parked for a same-user `owner_changed`,
   * or anything parked while a state read showed that signer): the whole
   * parked queue is replayed as a confirm would (`#replayParked`, minus the
   * native confirm) and the manager's owner-change flag is cleared. A
   * confirm's own replay is left to the confirm (`confirmInFlight`). Runs
   * from every state read.
   */
  #replayIfSettled(rec: ChannelRec): void {
    if (rec.parked.length === 0) return;
    if (this.#ownerChangePending(rec)) {
      rec.parkedUnderPending = true;
      return;
    }
    if (rec.settledReplay || rec.confirmInFlight || !rec.parkedUnderPending) {
      return;
    }
    rec.settledReplay = true;
    rec.ownerChangePending = false;
    this.#log("info", "owner change settled without a confirm: replayed", {
      channelId: rec.id,
    });
    // m4-5: a replay that re-parked (the owner change pending again)
    // leaves the join backoff as it was, so a flapping signer cannot
    // restart it on every state read.
    let reparked = true;
    this.#background(
      this.#replayParked(rec)
        .then((r) => {
          reparked = r;
        })
        .finally(() => {
          rec.settledReplay = false;
          if (!reparked) this.#resetJoinBackoff(rec, "settled");
          this.#emit(rec);
        }),
    );
  }

  /**
   * FXP F-L6: a Welcome native refused (`mls_leaf_rejected`, sticky on its
   * group) blocked the join. On an open, a `retryNow`, a commit or event
   * refresh, or the Add's stored-Welcome path, `welcomeRefusalRejoin`
   * decides (m-b; every grant is paced, M1a).
   * - `newer_add` (MJ-2, MJ-2b): only when that newer Add's Welcome path
   *   will run, the block lifts for that path only (no intent);
   *   `#endNewerAdd` restores it if the path ends without a join (or the
   *   run reaches `_join` with the lift still set), and that Add is then
   *   judged under the same pace.
   * - `rejoin`: the block lifts, the refused Add is done (its Welcome never
   *   fetched again) and the run sends ONE rejoin intent; the grant is
   *   recorded in the persisted pace.
   * Neither clears the alarm (M2: `rec.welcomeRefusal` stays until native
   * accepts that group). True when the block lifted.
   */
  #refusalRejoin(rec: ChannelRec, why: string): boolean {
    const g = rec.serverGroup;
    const n = rec.native;
    const sticky = rec.stickyGroupError;
    const refusal = rec.welcomeRefusal;
    if (
      g === null ||
      n === null ||
      sticky === null ||
      sticky.tag !== "mls_leaf_rejected" ||
      sticky.groupId !== g.group_id ||
      refusal === null
    ) {
      return false;
    }
    // n1, defensive: never while native holds that group (an accepted
    // Welcome or commit of it already cleared the refusal, `#onOutcome`).
    if (
      n.group_id === g.group_id &&
      (n.state === "active" || n.state === "poisoned")
    ) {
      return false;
    }
    const own = ownAddedEntry(
      g,
      this.#port.selfUserId,
      this.#port.selfDeviceId,
    );
    const pace = this.#refusalPace(rec, refusal);
    // MJ-2b: that Add's Welcome path runs exactly as the join loop reads it.
    const fromEpoch =
      rec.joinFromEpoch ?? (n.state === "joining" && own ? own.epoch : null);
    const step = welcomeRefusalRejoin({
      refusal,
      group: g,
      ownAddEpoch: own?.epoch ?? null,
      newerAddTried: own !== null && rec.newerAddTried === own.key,
      newerAddPathRuns:
        own !== null && welcomePending(own, fromEpoch, rec.welcomeDone),
      pace,
      nowMs: this.#port.now(),
    });
    // A newer Add judged here (its path cannot run) is tried.
    if (own !== null && own.epoch > refusal.epoch && step !== "newer_add") {
      rec.newerAddTried = own.key;
    }
    if (step === "none") return false;
    // The join block lifts; the red stays from the alarm (`#shownGroupError`).
    rec.stickyGroupError = null;
    rec.groupError = null;
    if (step === "newer_add" && own) {
      rec.newerAddTried = own.key;
      rec.refusalLift = { addKey: own.key, sticky };
    }
    if (step === "rejoin") {
      this.#notePaceGrant(rec, refusal, pace);
      // The refused Add is done: its Welcome is never fetched again.
      if (own) rec.welcomeDone = own.key;
    }
    this.#log("warn", "refused welcome: join unblocked", {
      channelId: rec.id,
      groupId: g.group_id,
      why,
      step,
      retryable: refusal.retryable,
    });
    this.#emit(rec);
    return true;
  }

  /**
   * FXP F-L6 (MJ-2): the Welcome path of the newer Add `addKey` that a
   * `newer_add` lifted the block for ended without a join: the block is
   * back (unless that path's own refusal set a new one), and the same
   * Add is judged now under the refused device's pace.
   */
  #endNewerAdd(rec: ChannelRec, addKey: string): void {
    const lift = rec.refusalLift;
    if (lift === null || lift.addKey !== addKey) return;
    rec.refusalLift = null;
    if (rec.stickyGroupError === null) {
      rec.stickyGroupError = lift.sticky;
      rec.groupError = lift.sticky.tag;
    }
    this.#refusalRejoin(rec, "newer_add_ended");
  }

  /**
   * FXP F-L6 (m-a): after a reload the alarm is rebuilt from the persisted
   * refusal of the server's current group (native holds no group of it),
   * and the join block with it (m4-3: whatever Add of this device the
   * server shows, newer, missing or older); `#refusalRejoin` then judges
   * it under the group's pace, never letting it through unblocked.
   */
  #restoreRefusal(rec: ChannelRec): void {
    const g = rec.serverGroup;
    const n = rec.native;
    if (rec.welcomeRefusal !== null || g === null || n === null) return;
    if (holdsCurrentGroup(n) && n.group_id === g.group_id) return;
    const e = [...this.#refusalPaces(rec)]
      .reverse()
      .find((p) => p.groupId === g.group_id);
    if (!e) return;
    rec.welcomeRefusal = {
      groupId: e.groupId,
      epoch: e.epoch,
      userId: e.userId,
      deviceId: e.deviceId,
      reason: e.reason,
      retryable: refusalRetryable(e.reason),
    };
    if (rec.stickyGroupError === null) {
      this.#setGroupError(rec, "mls_leaf_rejected", g.group_id);
    }
    this.#log("info", "refused welcome alarm restored", {
      channelId: rec.id,
      groupId: g.group_id,
    });
    this.#emit(rec);
  }

  #refusalPaceKey(rec: ChannelRec): string {
    return `${PROTECTED_REFUSAL_PACE_KEY_PREFIX}${this.#port.selfUserId}:${rec.id}`;
  }

  /**
   * FXP F-L6 (M1a, m-d): the channel's pace entries, the stored copy merged
   * with the in-memory one (m4-2: the larger grant count and the later
   * grant, separately, `mergeRefusalPaceEntry`).
   */
  #refusalPaces(rec: ChannelRec): RefusalPaceEntry[] {
    let stored: RefusalPaceEntry[] = [];
    try {
      stored = parseRefusalPaces(
        this.#port.store.get(this.#refusalPaceKey(rec)),
      );
    } catch {
      stored = [];
    }
    const out = [...stored];
    for (const m of this.#refusalPaceMem.get(rec.id) ?? []) {
      const i = out.findIndex(
        (e) =>
          e.groupId === m.groupId &&
          e.userId === m.userId &&
          e.deviceId === m.deviceId,
      );
      if (i < 0) out.push(m);
      else out[i] = mergeRefusalPaceEntry(out[i], m);
    }
    return out.slice(-REFUSAL_PACE_ENTRIES_MAX);
  }

  /**
   * FXP F-L6 (m4-2): the pace of `refusal`'s GROUP, one per group: the most
   * grants and the latest grant of its entries, taken separately, so never
   * laxer than any refused device's own (a server alternating which
   * listing it withholds buys no grant per device). Null when none. A grant
   * stamped in the future (a clock that ran back) is clamped to now and
   * stored so (m-c): the window runs from now, never from that time.
   */
  #refusalPace(rec: ChannelRec, refusal: WelcomeRefusal): RefusalPace | null {
    const now = this.#port.now();
    let found = false;
    let grants = 0;
    let atMs = 0;
    for (const e of this.#refusalPaces(rec)) {
      if (e.groupId !== refusal.groupId) continue;
      let at = e.atMs;
      if (at > now && Number.isFinite(now)) {
        this.#writePaces(rec, { ...e, atMs: now });
        at = now;
      }
      found = true;
      grants = Math.max(grants, e.grants);
      atMs = Math.max(atMs, at);
    }
    return found ? { grants, atMs } : null;
  }

  /**
   * FXP F-L6: write `entry` in place of the same (group, device) one, or
   * drop every entry of `dropGroup` (m-c); store first, memory always.
   */
  #writePaces(
    rec: ChannelRec,
    entry: RefusalPaceEntry | null,
    dropGroup: string | null = null,
  ): void {
    const entries = this.#refusalPaces(rec).filter(
      (p) =>
        p.groupId !== dropGroup &&
        !(
          entry !== null &&
          p.groupId === entry.groupId &&
          p.userId === entry.userId &&
          p.deviceId === entry.deviceId
        ),
    );
    if (entry !== null) entries.push(entry);
    const kept = entries.slice(-REFUSAL_PACE_ENTRIES_MAX);
    let ok = false;
    try {
      ok = this.#port.store.set(
        this.#refusalPaceKey(rec),
        JSON.stringify({ v: 2, entries: kept }),
      );
    } catch {
      ok = false;
    }
    this.#refusalPaceMem.set(rec.id, kept);
    if (!ok) {
      this.#log("warn", "refused welcome pace not persisted", {
        channelId: rec.id,
      });
    }
  }

  /**
   * FXP F-L6: record a refusal (the alarm) and persist it (m-a). m3-2,
   * m4-2: the entry carries the group's pace (`#refusalPace`), so a newly
   * refused device never buys a free grant.
   */
  #noteRefusal(rec: ChannelRec, refusal: WelcomeRefusal): void {
    rec.welcomeRefusal = refusal;
    const prior = this.#refusalPace(rec, refusal);
    this.#writePaces(rec, {
      groupId: refusal.groupId,
      userId: refusal.userId,
      deviceId: refusal.deviceId,
      epoch: refusal.epoch,
      reason: refusal.reason,
      grants: prior?.grants ?? 0,
      atMs: prior?.atMs ?? 0,
    });
  }

  /** FXP F-L6: record a grant (M1a). */
  #notePaceGrant(
    rec: ChannelRec,
    refusal: WelcomeRefusal,
    prior: RefusalPace | null,
  ): void {
    this.#writePaces(rec, {
      groupId: refusal.groupId,
      userId: refusal.userId,
      deviceId: refusal.deviceId,
      epoch: refusal.epoch,
      reason: refusal.reason,
      ...refusalPaceAfterGrant(prior, this.#port.now()),
    });
  }

  /**
   * FXF: the 6c budget starts over: a user's open or `retryNow`, a joined
   * Welcome, a recreate, or (`#rebindLeafMissing`) a new group or signer.
   */
  #resetLeafMissing(rec: ChannelRec, why: string): void {
    if (
      rec.signerLeafMissingRetries === 0 &&
      rec.signerLeafMissingOn === null
    ) {
      return;
    }
    rec.signerLeafMissingRetries = 0;
    rec.signerLeafMissingOn = null;
    this.#log("info", "join stall budget reset", { channelId: rec.id, why });
  }

  /**
   * FXF: binds the 6c budget to a discarded Welcome for `groupId` before it
   * is counted: a budget spent on another group or signer starts over.
   * False (not counted) when the server's current group is known and is
   * another one: that Welcome says nothing about the join.
   */
  #bindLeafMissing(rec: ChannelRec, groupId: string): boolean {
    const current = rec.serverGroup?.group_id ?? null;
    if (current !== null && current !== groupId) {
      this.#log("info", "signer_leaf_missing for an old group not counted", {
        channelId: rec.id,
        groupId,
      });
      return false;
    }
    const signer = leafMissingSigner(rec.native);
    if (!leafMissingApplies(rec.signerLeafMissingOn, groupId, signer)) {
      this.#resetLeafMissing(rec, "rebound");
    }
    rec.signerLeafMissingOn = { groupId, signer };
    return true;
  }

  /**
   * FXF: the budget does not apply once the server names another current
   * group (a successor: owner recovery, D21) or native holds a list from
   * another signer (an owner change confirmed, a recovery list adopted).
   * An unknown or absent server group keeps it. Runs before every view.
   */
  #rebindLeafMissing(rec: ChannelRec): void {
    const on = rec.signerLeafMissingOn;
    if (on === null) return;
    const groupId = rec.serverGroup?.group_id ?? on.groupId;
    if (!leafMissingApplies(on, groupId, leafMissingSigner(rec.native))) {
      this.#resetLeafMissing(rec, "moved_on");
    }
  }

  /**
   * S2-D29: `member_added` shows this device and no Welcome came: wait
   * `WELCOME_FETCH_AFTER_MS`, then fetch the stored Welcome of the server's
   * CURRENT group (re-read here). "rejoin" only for the route's 404.
   */
  async #welcomeDue(
    rec: ChannelRec,
    js: JoinState,
    groupId: string,
  ): Promise<StoredWelcomeResult> {
    if (await this.#joinWait(js, WELCOME_FETCH_AFTER_MS)) return "joined";
    if (js.cancelled) return "unavailable";
    await this.refresh(rec.id, "commit");
    const n = rec.native;
    if (n && holdsCurrentGroup(n) && n.group_id === groupId) return "joined";
    if (rec.serverGroup?.group_id !== groupId) return "unavailable";
    // FXF: a Welcome for this group already waits behind an owner change.
    if (welcomeParkedFor(rec.parked, groupId)) return "parked";
    return this.#fetchStoredWelcome(rec, groupId);
  }

  /** S2-D29: one stored-Welcome fetch in flight per channel. */
  #fetchStoredWelcome(
    rec: ChannelRec,
    groupId: string,
  ): Promise<StoredWelcomeResult> {
    if (rec.welcomeFetch) return rec.welcomeFetch;
    const run = this.#fetchStoredWelcomeOnce(rec, groupId).finally(() => {
      if (rec.welcomeFetch === run) rec.welcomeFetch = null;
    });
    rec.welcomeFetch = run;
    return run;
  }

  /**
   * `GET /mls/groups/:id/welcome?device_id=<this device>` with the answer
   * read by `welcomeFetchStep`: 429 / 5xx / transport retried (bounded), a
   * 404 is "rejoin", a usable 2xx goes to native, anything else gives up.
   */
  async #fetchStoredWelcomeOnce(
    rec: ChannelRec,
    groupId: string,
  ): Promise<StoredWelcomeResult> {
    const device = encodeURIComponent(this.#port.selfDeviceId);
    const path = `/mls/groups/${groupId}/welcome?device_id=${device}`;
    const ids = { channelId: rec.id, groupId };
    for (let failures = 0; ; failures++) {
      const r = await this.#api("GET", path);
      const step = welcomeFetchStep(
        r === null
          ? { kind: "transport_error" }
          : { kind: "response", response: r },
        { groupId, failures },
      );
      switch (step.kind) {
        case "retry":
          await this.#sleep(step.delayMs);
          break;
        case "rejoin":
          this.#log("warn", "stored welcome not found", ids);
          return "rejoin";
        case "give_up":
          this.#log("warn", "stored welcome unavailable", {
            ...ids,
            why: step.why,
          });
          return "unavailable";
        case "process":
          return this.#processStoredWelcome(rec, step.welcome);
      }
    }
  }

  /**
   * S2-D29: a fetched Welcome takes the envelope path (`#processWire`):
   * `_process` decides exactly as for a mailbox Welcome, no other trust
   * path. Its synthetic id is never acked. Skipped when this device
   * already holds the group (a mailbox Welcome won the race; a second one
   * would only be refused as unsolicited). FXF: one parked behind an owner
   * change is "parked": its Add stays pending until the confirm.
   */
  async #processStoredWelcome(
    rec: ChannelRec,
    w: StoredWelcome,
  ): Promise<StoredWelcomeResult> {
    const ref = this.#index.get(w.group_id);
    if (!ref || ref.channelId !== rec.id) {
      this.#log("warn", "stored welcome for another channel", {
        channelId: rec.id,
      });
      return "unavailable";
    }
    const wire: TextWireEnvelope = {
      id: `${TEXT_SYNTH_ID_PREFIX}welcome:${w.group_id}:${w.epoch}`,
      content_type: "mls_welcome",
      group_id: w.group_id,
      epoch: w.epoch,
      ciphertext: w.welcome,
    };
    let held = false;
    await this.#enqueue(rec.id, async () => {
      const n = await this.#readStateDirect(rec);
      if (n && holdsCurrentGroup(n) && n.group_id === w.group_id) return;
      held = (await this.#processWire(rec, wire, 0)) === "held";
    });
    const n = rec.native;
    if (n && holdsCurrentGroup(n) && n.group_id === w.group_id) {
      return "joined";
    }
    if (welcomeParkedFor(rec.parked, w.group_id)) return "parked";
    return held ? "held" : "processed";
  }

  /**
   * `PUT /mls/key_packages` with the one-time KeyPackage `_join` minted for
   * its intent, through this manager's courier. Resolves null once
   * published. A 429 is waited out and the same body re-PUT (up to
   * `KEY_PACKAGE_PUT_429_BUDGET`); past that, and on a 5xx or a transport
   * failure, resolves the failure (the caller retries the attempt). Any
   * other 4xx THROWS `serverFailure`: the intent is never posted.
   */
  async #putJoinKeyPackage(
    groupId: string,
    body: MlsPublishKeyPackages,
  ): Promise<TextFlowFailure | null> {
    for (let limited = 0; ; limited++) {
      const r = await this.#api("PUT", "/mls/key_packages", body);
      if (r !== null && is2xx(r.status)) return null;
      const ids = { groupId, status: r === null ? null : r.status };
      if (r !== null && r.status === 429) {
        if (limited < KEY_PACKAGE_PUT_429_BUDGET) {
          await this.#sleep(retryAfterMs(r) ?? publishBackoffMs(limited));
          continue;
        }
      } else if (r !== null && is4xx(r.status)) {
        this.#log("warn", "join key package refused", ids);
        throw serverFailure(r);
      }
      this.#log("warn", "join key package not published", ids);
      return r === null ? { source: "transport" } : serverFailure(r);
    }
  }

  // -------------------------------------------------------------------------
  // Admission (D19)
  // -------------------------------------------------------------------------

  async #admit(req: MlsJoinRequest, rejoin: boolean): Promise<void> {
    const ref = this.#index.get(req.group_id);
    if (!ref || ref.channelId !== req.channel_id) {
      this.#log("warn", "join request for an unknown channel", {
        groupId: req.group_id,
      });
      return;
    }
    const rec = this.#channels.get(ref.channelId);
    if (!rec || rec.stripped) return;
    const self = this.#port.selfUserId;
    const dev = this.#port.selfDeviceId;
    if (req.user_id === self && req.device_id === dev) return;
    const key = `${req.group_id}:${req.user_id}:${req.device_id}:${rejoin}`;
    if (this.#admitting.has(key)) return;
    this.#admitting.add(key);
    try {
      await this.#readState(rec);
      let n = rec.native;
      // S2 (c): never admit into a superseded group.
      if (!n || !holdsCurrentGroup(n) || n.group_id !== req.group_id) return;
      const held = this.#claimHold.get(req.group_id);
      if (held !== undefined && this.#port.now() < held) {
        this.#log("debug", "admission held: claims rate limited", {
          groupId: req.group_id,
        });
        return;
      }
      if (!rejoin) {
        if (!rec.seats) await this.refresh(rec.id, "commit");
        const seated = rec.seats?.seats.some((s) => s.user_id === req.user_id);
        if (!seated) {
          this.#log("info", "join request from an unseated user", {
            groupId: req.group_id,
          });
          return;
        }
      }
      await this.#sleep(leafStaggerMs(ownLeafIndex(n, self, dev)));
      await this.#readState(rec);
      n = rec.native;
      if (!n || !holdsCurrentGroup(n) || n.group_id !== req.group_id) return;
      const present = n.members.some(
        (m) => m.user_id === req.user_id && m.device_id === req.device_id,
      );
      if (!rejoin && present) return; // another member admitted it
      if (rejoin && !present) return; // the stale leaf is already gone
      await this.#ensureOwnPins(false);
      await this.#pinFor(req.user_id, [req.device_id]);
      if (rejoin) {
        // Rule 6 (incl. the owner-device rule 2): remove the stale leaf.
        const target = { user_id: req.user_id, device_id: req.device_id };
        await this.#removeInner(rec, [target], req);
        return;
      }
      for (let stage = 0; stage < 2; stage++) {
        const claimed = await this.#claim(req);
        if (!claimed) return;
        const r = await this.#staged(rec, req.group_id, () =>
          this.#stageAdmit(rec, req, claimed),
        );
        if (r !== "restage") return;
      }
    } catch (err) {
      if (!isDisposed(err)) {
        // A server refusal (e.g. the W2c cap refusals) logs its error type.
        const type =
          isFlowFailure(err) && err.source === "server" && err.type !== null
            ? err.type
            : viewTagOf(err);
        this.#log("warn", "admission failed", { groupId: req.group_id, type });
      }
    } finally {
      this.#admitting.delete(key);
    }
  }

  async #stageAdmit(
    rec: ChannelRec,
    request: MlsJoinRequest,
    claimed: MlsClaimedKeyPackage,
  ): Promise<TextSubmitCommitPayload> {
    for (let pinned = false; ; pinned = true) {
      try {
        return await this.#enqueue(rec.id, () =>
          this.#invoke("e2ee_text_admit", { request, claimed }),
        );
      } catch (err) {
        const native = nativeErrorOf(err);
        if (!pinned && native?.type === "identity_pin_required") {
          await this.#pinFor(native.user_id, [native.device_id]);
          continue;
        }
        if (admitRefusedByNative(err)) this.#noteAdmitRefused(request);
        throw err;
      }
    }
  }

  /** FX-J2 NEW-3: remember a refused request (bounded, oldest first out). */
  #noteAdmitRefused(request: MlsJoinRequest): void {
    const key = admitRefusalKey(request);
    this.#admitRefused.delete(key);
    this.#admitRefused.add(key);
    while (this.#admitRefused.size > ADMIT_REFUSED_CAP) {
      const oldest = this.#admitRefused.values().next().value;
      if (oldest === undefined) break;
      this.#admitRefused.delete(oldest);
    }
  }

  async #claim(req: MlsJoinRequest): Promise<MlsClaimedKeyPackage | null> {
    const r = await this.#api("POST", "/mls/key_packages/claim", {
      device_id: this.#port.selfDeviceId,
      group_id: req.group_id,
      targets: [{ user_id: req.user_id, device_id: req.device_id }],
    });
    if (r !== null && r.status === 429) {
      // Inherited L1s: `InSlowmode` (or the limiter) on a claim: no claim
      // into this group before its `retry_after`; the joiner's intent is
      // admitted after it. Never a notice.
      const wait = retryAfterMs(r) ?? publishBackoffMs(0);
      this.#claimHold.set(req.group_id, this.#port.now() + wait);
      this.#log("info", "claim rate limited", { groupId: req.group_id });
      return null;
    }
    if (r === null || !is2xx(r.status) || !isRecord(r.body)) return null;
    const results = r.body.results;
    const c = Array.isArray(results) ? results[0] : null;
    if (
      !isRecord(c) ||
      c.status !== "Claimed" ||
      c.user_id !== req.user_id ||
      c.device_id !== req.device_id
    ) {
      return null;
    }
    return {
      user_id: c.user_id as string,
      device_id: c.device_id as string,
      key_package_ref: c.key_package_ref as string,
      key_package: c.key_package as string,
      mls_signature_key: c.mls_signature_key as string,
      binding_signature: c.binding_signature as string,
      reused: c.reused === true,
    };
  }

  // -------------------------------------------------------------------------
  // Removal and update
  // -------------------------------------------------------------------------

  async #removeInner(
    rec: ChannelRec,
    targets: MlsMemberDevice[],
    rejoinIntent: MlsJoinRequest | null,
  ): Promise<void> {
    for (let stage = 0; stage < 2; stage++) {
      await this.#readState(rec);
      const n = rec.native;
      if (!n || !holdsCurrentGroup(n) || n.group_id === null) {
        throw clientFailure("no_group");
      }
      const groupId = n.group_id;
      // D24 / W3 D13: pending_removal_users from GET .../text_group; S2
      // rule 3a: pending_device_removals minus self and the signer device.
      const g = rec.serverGroup?.group_id === groupId ? rec.serverGroup : null;
      const pendingRemovalUsers = g
        ? g.pending_removals.map((p) => p.user_id)
        : [];
      const pendingDeviceTargets = pendingDeviceTargetsOf(
        g,
        n,
        this.#port.selfUserId,
        this.#port.selfDeviceId,
      );
      const r = await this.#staged(rec, groupId, async () => {
        try {
          return await this.#enqueue(rec.id, () =>
            this.#invoke("e2ee_text_remove", {
              groupId,
              targets,
              rejoinIntent,
              pendingRemovalUsers,
              pendingDeviceTargets,
            }),
          );
        } catch (err) {
          throw toFailure(err);
        }
      });
      if (r === "won") return;
      if (r !== "restage") throw clientFailure(`commit_${r}`);
    }
    throw clientFailure("commit_restage_exhausted");
  }

  /**
   * Rule 4a: any member device removes every device of pending users; S2
   * rule 3a: and every pending device the server reports that holds a
   * leaf (never this device or the held list's signer device).
   */
  async #commitPendingRemovals(rec: ChannelRec): Promise<void> {
    if (rec.removalInFlight) return;
    rec.removalInFlight = true;
    try {
      const self = this.#port.selfUserId;
      const dev = this.#port.selfDeviceId;
      const n0 = rec.native;
      if (!n0) return;
      await this.#sleep(leafStaggerMs(ownLeafIndex(n0, self, dev)));
      // Re-read: another member may have committed it meanwhile.
      const r = await this.#api("GET", `/mls/channels/${rec.id}/text_group`);
      if (r !== null && is2xx(r.status)) {
        const g = parseTextGroup(r.body);
        if (g) {
          this.#report(rec.id, g.group_id, g.generation, "text_group");
          rec.serverGroup = g;
        }
      }
      await this.#readState(rec);
      const n = rec.native;
      const g = rec.serverGroup;
      if (!n || !g || !holdsCurrentGroup(n) || n.group_id !== g.group_id) {
        return;
      }
      const users = new Set(g.pending_removals.map((p) => p.user_id));
      const devices = pendingDeviceTargetsOf(g, n, self, dev);
      const targets = n.members
        .filter(
          (m) =>
            (users.has(m.user_id) ||
              devices.some(
                (d) => d.user_id === m.user_id && d.device_id === m.device_id,
              )) &&
            !(m.user_id === self && m.device_id === dev),
        )
        .map((m) => ({ user_id: m.user_id, device_id: m.device_id }));
      if (targets.length === 0) return;
      await this.#removeInner(rec, targets, null);
    } catch (err) {
      if (!isDisposed(err)) {
        this.#log("warn", "pending removal commit failed", {
          channelId: rec.id,
          type: viewTagOf(err),
        });
      }
    } finally {
      rec.removalInFlight = false;
    }
  }

  /**
   * D19 / W4-3: `_update` + submit (re-staged once on stale_seat_list).
   * A caller arriving while an Update is in flight AWAITS it, then commits
   * another only if native still reports one due (W4b audit M1: so
   * `ensureJoined` really waits for the Update before B4 retries).
   */
  async #commitUpdate(rec: ChannelRec, force: boolean): Promise<void> {
    while (rec.updating) {
      await rec.updating;
      await this.#readState(rec);
      const n = rec.native;
      if (!n || (!n.update_due && !n.update_required)) return;
      force = false;
    }
    const run = this.#runUpdate(rec, force);
    rec.updating = run;
    try {
      await run;
    } finally {
      if (rec.updating === run) rec.updating = null;
    }
  }

  /** One Update attempt (never rejects; failures are logged). */
  async #runUpdate(rec: ChannelRec, force: boolean): Promise<void> {
    try {
      for (let stage = 0; stage < 2; stage++) {
        await this.#readState(rec);
        const n = rec.native;
        if (!n || !holdsCurrentGroup(n) || n.group_id === null) return;
        if (!force && !n.update_due && !n.update_required) return;
        const groupId = n.group_id;
        const r = await this.#staged(rec, groupId, () =>
          this.#enqueue(rec.id, () =>
            this.#invoke("e2ee_text_update", { groupId }),
          ),
        );
        if (r !== "restage") return;
        force = true;
      }
    } catch (err) {
      if (!isDisposed(err)) {
        this.#log("warn", "update commit failed", {
          channelId: rec.id,
          type: viewTagOf(err),
        });
      }
    }
  }

  /**
   * D21 crash between `_group_create` and the server accepting it: the
   * newest group native holds looks exactly as the create left it (active,
   * epoch 0, this device's leaf alone; `#recreateUnaccepted` checks nothing
   * is staged and native re-checks the rest) while the server does not
   * have it (definitively no open group, or an older generation), and this
   * device signed the held list. Null when any of that does not hold; an
   * unknown server answer is never read as absent.
   */
  #unacceptedCreate(
    rec: ChannelRec,
  ): { groupId: string; generation: number } | null {
    const n = rec.native;
    const g = rec.serverGroup;
    if (!n || n.group_id === null || n.generation === null) return null;
    if (n.state !== "active" || n.epoch !== 0 || n.members.length !== 1) {
      return null;
    }
    const leaf = n.members[0];
    if (
      leaf.user_id !== this.#port.selfUserId ||
      leaf.device_id !== this.#port.selfDeviceId
    ) {
      return null;
    }
    const serverBehind =
      g === null ? rec.serverGroupMissing : g.generation < n.generation;
    if (!serverBehind || !this.#isSigner(rec)) return null;
    return { groupId: n.group_id, generation: n.generation };
  }

  /**
   * Re-run the create of an unaccepted group (W3: `_group_create` answers
   * the same payload for an untouched group, and refuses anything else),
   * then `POST /mls/groups`; a 409 Conflict naming that id is "created".
   */
  async #recreateUnaccepted(
    rec: ChannelRec,
    c: { groupId: string; generation: number },
  ): Promise<void> {
    const ids = { channelId: rec.id, groupId: c.groupId };
    let pending: TextCommandResult["e2ee_text_pending_commit"];
    try {
      pending = await this.#enqueue(rec.id, () =>
        this.#invoke("e2ee_text_pending_commit", { groupId: c.groupId }),
      );
    } catch (err) {
      throw toFailure(err);
    }
    if (pending !== null) {
      this.#log("warn", "unaccepted group has a staged commit", ids);
      throw clientFailure("create_staged");
    }
    // S2 (c, OR-7/8): the re-run names the SAME predecessor the first
    // create did, never a re-derived id (v1 derivation stops at g 63 and
    // a v2 id cannot be derived here). That predecessor is the open group
    // the server still holds at generation - 1; native accepts the re-run
    // only when that row's `superseded_by` is this group. Anything else
    // is unknown: nothing is re-run.
    const g = rec.serverGroup;
    let supersedes: string | null = null;
    if (c.generation > 0) {
      if (g === null || g.generation !== c.generation - 1) {
        this.#log("warn", "unaccepted group: predecessor unknown", ids);
        throw clientFailure("create_predecessor_unknown");
      }
      supersedes = g.group_id;
    }
    this.#log("info", "re-running an unaccepted group create", ids);
    const created = await this.createGroup(rec.id, supersedes);
    if (created.group_id !== c.groupId) {
      this.#log("warn", "re-run create named another group", ids);
    }
  }

  async #createSuccessor(rec: ChannelRec): Promise<void> {
    if (rec.successorInFlight) return;
    rec.successorInFlight = true;
    try {
      // The held (poisoned) group's own id, never a derivation.
      const n = rec.native;
      const supersedes = n && n.state === "poisoned" ? n.group_id : null;
      await this.createGroup(rec.id, supersedes);
    } catch (err) {
      if (!isDisposed(err)) {
        this.#log("warn", "group create failed", {
          channelId: rec.id,
          type: viewTagOf(err),
        });
      }
    } finally {
      rec.successorInFlight = false;
    }
  }

  // -------------------------------------------------------------------------
  // Commit submit and outcome recovery (D20)
  // -------------------------------------------------------------------------

  /**
   * One commit flow: stage (native, in the lane) + submit loop, counted in
   * `#commitBusy` from BEFORE the stage until the loop settles, so a
   * concurrent resume never submits the same stage twice (W4d X#2).
   */
  async #staged(
    rec: ChannelRec,
    groupId: string,
    stage: () => Promise<TextSubmitCommitPayload>,
  ): Promise<SubmitResult> {
    // W4d N4: never stage over a persisted stage a resume is resolving
    // (the resumed `_commit_won` would then hit own_commit_mismatch).
    const resuming = this.#resuming.get(groupId);
    if (resuming) await resuming.catch(() => false);
    this.#busyEnter(groupId);
    try {
      const payload = await stage();
      return await this.#submit(rec, groupId, payload);
    } finally {
      this.#busyLeave(groupId);
    }
  }

  #busy(groupId: string): boolean {
    return (this.#commitBusy.get(groupId) ?? 0) > 0;
  }

  #busyEnter(groupId: string): void {
    this.#commitBusy.set(groupId, (this.#commitBusy.get(groupId) ?? 0) + 1);
  }

  #busyLeave(groupId: string): void {
    const n = (this.#commitBusy.get(groupId) ?? 1) - 1;
    if (n > 0) this.#commitBusy.set(groupId, n);
    else this.#commitBusy.delete(groupId);
  }

  async #submit(
    rec: ChannelRec,
    groupId: string,
    payload: TextSubmitCommitPayload,
  ): Promise<SubmitResult> {
    const ctx: SubmitContext = this.#submitCtx(
      groupId,
      payload,
      false,
      payload.removed ?? [],
    );
    this.#persistStage(groupId, payload);
    const r = await this.#api(
      "POST",
      `/mls/groups/${groupId}/commits`,
      payload,
    );
    const first = classifySubmit(
      r !== null
        ? { kind: "submit", response: r }
        : { kind: "submit_transport_error" },
      ctx,
    );
    return this.#runSubmitLoop(rec, payload, ctx, first, true, r);
  }

  /**
   * `#submitLoop`, keeping the stage's full body as the resume hint while
   * its outcome is unresolved (parked, or a non-server failure thrown) and
   * dropping it once the loop resolved the stage (incl. a typed refusal).
   */
  async #runSubmitLoop(
    rec: ChannelRec,
    payload: TextSubmitCommitPayload,
    ctx: SubmitContext,
    first: SubmitAction,
    fromSubmit: boolean,
    firstResponse: TextApiResponse | null = null,
    resubmitAllowed = true,
  ): Promise<SubmitResult> {
    let settled = false;
    try {
      const r = await this.#submitLoop(
        rec,
        payload,
        ctx,
        first,
        fromSubmit,
        firstResponse,
        resubmitAllowed,
      );
      settled = r !== "parked";
      return r;
    } catch (err) {
      settled = isFlowFailure(err) && err.source === "server";
      throw err;
    } finally {
      if (settled) this.#dropStage(ctx.groupId, payload);
    }
  }

  /**
   * `ownRemoved` (OR-5): the submitted body's `removed` (`[]` when it has
   * none); null when the body is unknown (a resume without the stored full
   * body), so a plain 2xx then reads the stored row for its labels.
   */
  #submitCtx(
    groupId: string,
    payload: TextSubmitCommitPayload,
    resubmit: boolean,
    ownRemoved: readonly MlsMemberDevice[] | null,
  ): SubmitContext {
    return {
      groupId,
      epoch: payload.epoch,
      selfUserId: this.#port.selfUserId,
      selfDeviceId: this.#port.selfDeviceId,
      ownCommitB64: payload.commit,
      resubmit,
      failures: 0,
      ownRemoved,
    };
  }

  /**
   * After a plain 2xx `Won` (a bare answer, no commit info): read the
   * stored `{group}:{epoch}` row through this manager's courier and apply
   * the committer rule to it. Own committer: `won` with the DS's stored
   * string and its `rejoin_intents ?? []`. Another committer: `lost` and
   * process that winner. Transport / 429 / 5xx, a refusal, a malformed
   * answer and a missing row (a DS defect after a 2xx) are retried with
   * backoff, never read as lost and never resubmitted; null once
   * `WON_ROW_READ_BUDGET` reads failed (the caller parks the commit).
   */
  async #readWonRow(ctx: SubmitContext): Promise<SubmitAction | null> {
    const { groupId, epoch } = ctx;
    for (let failures = 0; failures < WON_ROW_READ_BUDGET; failures++) {
      const r = await this.#api(
        "GET",
        `/mls/groups/${groupId}/commits?from_epoch=${epoch}`,
      );
      let wait = publishBackoffMs(failures);
      if (r !== null && is2xx(r.status)) {
        const row = parseCommitRows(r.body)?.find(
          (c) =>
            c.epoch === epoch &&
            c.group_id === groupId &&
            str(c.committer.user_id) &&
            str(c.committer.device_id),
        );
        // OR-5: the stored row's labels, by the router's rule; a malformed
        // vector is read again (never defaulted to `[]`).
        const labels = row ? labelsOf(row.removed_reasons) : null;
        if (row && labels !== null) {
          const own =
            row.committer.user_id === this.#port.selfUserId &&
            row.committer.device_id === this.#port.selfDeviceId;
          return own
            ? {
                kind: "won",
                storedCommitB64: row.commit,
                rejoinIntents: Array.isArray(row.rejoin_intents)
                  ? row.rejoin_intents
                  : [],
                removedReasons: labels,
              }
            : { kind: "lost", winner: row, then: "process_winner" };
        }
        if (row) {
          this.#log("warn", "won row labels malformed", { groupId, epoch });
        } else {
          this.#log("warn", "won row missing", { groupId, epoch });
        }
      } else if (r !== null && r.status === 429) {
        wait = retryAfterMs(r) ?? wait;
      } else if (r !== null && r.status < 500) {
        this.#log("warn", "won row read refused", {
          groupId,
          epoch,
          status: r.status,
        });
      }
      await this.#sleep(wait);
    }
    return null;
  }

  /**
   * `fromSubmit`: `first` classifies a commit POST answer (not a refetch).
   * Tracked per action, so a `won` knows whether it is a plain 2xx.
   * `firstResponse`: that POST answer (null after a transport failure);
   * the latest POST answer is what a typed refusal (`refused`) rethrows.
   */
  async #submitLoop(
    rec: ChannelRec,
    payload: TextSubmitCommitPayload,
    ctx: SubmitContext,
    first: SubmitAction,
    fromSubmit: boolean,
    firstResponse: TextApiResponse | null = null,
    resubmitAllowed = true,
  ): Promise<SubmitResult> {
    const { groupId } = ctx;
    const ids = { groupId, epoch: ctx.epoch };
    let action = first;
    let plain = fromSubmit;
    let refetch403 = 0;
    let lastPost = firstResponse;
    for (;;) {
      this.#checkAlive();
      switch (action.kind) {
        case "won": {
          // RC NEW-5: on a refetch path `storedCommitB64` is the DS's
          // stored string; native merges equal bytes and answers
          // own_commit_mismatch (→ left → rejoin) for different ones.
          // W3 2026-10-25: `_commit_won` ALWAYS gets the stored row's
          // `rejoin_intents` (the DS fills them from its own intent rows).
          // A plain 2xx is a bare `Won`, so read the row first and take the
          // committer rule on it; `_commit_won` waits until it is read.
          if (plain) {
            const read = await this.#readWonRow(ctx);
            if (read === null) {
              // Parked: native keeps the stage; the next refresh resumes it
              // from `_pending_commit` (W4d X#2), reading the row first.
              this.#log("warn", "won row unread, commit parked", ids);
              return "parked";
            }
            action = read;
            plain = false;
            break;
          }
          const won = action;
          const rejoinIntents: MlsJoinRequest[] = won.rejoinIntents;
          try {
            await this.#enqueue(rec.id, async () => {
              const out = await this.#invoke("e2ee_text_commit_won", {
                groupId,
                wonEpoch: ctx.epoch,
                storedCommitB64: won.storedCommitB64,
                rejoinIntents,
                // OR-5: the stored row's labels (`#readWonRow` / policy).
                removedReasons: won.removedReasons,
              });
              await this.#onOutcome(out, "won");
              // S4: the committer's link, after the outcome is handled.
              // Not awaited: it can neither hold up nor fail the commit.
              this.#putWonLink(rec, out);
            });
          } catch (err) {
            if (viewTagOf(err) === "own_commit_mismatch") {
              this.#log("warn", "own commit mismatch", ids);
              this.#background(this.ensureJoined(rec.id));
              return "left";
            }
            throw toFailure(err);
          }
          return "won";
        }
        case "lost": {
          const lost = action;
          await this.#enqueue(rec.id, async () => {
            try {
              await this.#invoke("e2ee_text_commit_lost", { groupId });
            } catch (err) {
              this.#log("warn", "commit_lost failed", {
                ...ids,
                type: viewTagOf(err),
              });
            }
            if (lost.then === "process_winner" && lost.winner) {
              const wire = textEnvelopeFromCommitInfo(lost.winner);
              if (wire) await this.#processWire(rec, wire, 0);
            }
          });
          switch (lost.then) {
            case "reverify_restage":
              await this.refresh(rec.id, "commit");
              return "restage";
            case "await_removal":
              this.#background(this.refresh(rec.id, "commit"));
              return "await_removal";
            case "process_winner":
            case "refresh":
              this.#background(this.refresh(rec.id, "commit"));
              return "lost";
            case "refused":
              // W2c cap refusal (DeviceCapReached / MlsCallFull): the stage
              // is dropped and the SAME Add never retried; the typed refusal
              // goes to the caller (its cap notice), never a `groupError`.
              this.#log("warn", "commit refused", {
                ...ids,
                type: lastPost ? errorTypeOf(lastPost.body) : null,
              });
              this.#background(this.refresh(rec.id, "commit"));
              throw lastPost !== null
                ? serverFailure(lastPost)
                : clientFailure("commit_refused");
          }
          break;
        }
        case "refetch": {
          const purpose = action.purpose;
          if (purpose.kind === "labels") {
            // OR-5: a plain 2xx that may have removed devices. The commit
            // WON; `#readWonRow` owns the read budget, the park and the
            // log, and returns the stored row's labels.
            await this.#sleep(action.delayMs);
            const read = await this.#readWonRow(ctx);
            if (read === null) {
              this.#log("warn", "won row unread, commit parked", ids);
              return "parked";
            }
            action = read;
            plain = false;
            break;
          }
          await this.#sleep(action.delayMs);
          const r = await this.#api(
            "GET",
            `/mls/groups/${groupId}/commits?from_epoch=${ctx.epoch}`,
          );
          refetch403 =
            r !== null && r.status === 403 && !ctx.resubmit
              ? refetch403 + 1
              : 0;
          ctx.failures += 1;
          action = classifySubmit(
            r !== null
              ? { kind: "refetch", purpose, response: r }
              : { kind: "refetch_transport_error", purpose },
            ctx,
          );
          plain = false;
          if (
            refetch403 >= REFETCH_403_PARK_BUDGET &&
            action.kind === "refetch"
          ) {
            // Binding note: park; the stage stays, the outcome unknown. The
            // next refresh resumes it from `_pending_commit` (W4d X#2).
            this.#log("warn", "commit parked after 403s", ids);
            return "parked";
          }
          break;
        }
        case "resubmit": {
          if (!resubmitAllowed) {
            // W4d N1: no full body for this stage (restart / rebuild): the
            // row is absent, so drop the stage and let the normal flows
            // re-derive it. A bare body is NEVER POSTed.
            this.#log("warn", "stage without its full body dropped", ids);
            await this.#enqueue(rec.id, async () => {
              try {
                await this.#invoke("e2ee_text_commit_lost", { groupId });
              } catch (err) {
                this.#log("warn", "commit_lost failed", {
                  ...ids,
                  type: viewTagOf(err),
                });
              }
            });
            this.#background(this.refresh(rec.id, "commit"));
            return "lost";
          }
          await this.#sleep(action.delayMs);
          ctx.resubmit = action.asResubmit;
          ctx.failures += 1;
          let pending: TextCommandResult["e2ee_text_pending_commit"] = null;
          try {
            pending = await this.#enqueue(rec.id, () =>
              this.#invoke("e2ee_text_pending_commit", { groupId }),
            );
          } catch (err) {
            if (viewTagOf(err) === "busy") break;
            throw toFailure(err);
          }
          if (
            pending === null ||
            pending.epoch !== ctx.epoch ||
            pending.commit_b64 !== payload.commit
          ) {
            // The stage is gone (another commit merged) or differs: it can
            // no longer be resubmitted with identical bytes.
            this.#log("warn", "stage gone before resubmit", ids);
            this.#background(this.refresh(rec.id, "commit"));
            return "lost";
          }
          const r = await this.#api(
            "POST",
            `/mls/groups/${groupId}/commits`,
            payload,
          );
          lastPost = r;
          action = classifySubmit(
            r !== null
              ? { kind: "submit", response: r }
              : { kind: "submit_transport_error" },
            ctx,
          );
          plain = true;
          break;
        }
        case "mark_left": {
          const reason = action.reason;
          await this.#enqueue(rec.id, async () => {
            try {
              await this.#invoke("e2ee_text_mark_left", { groupId, reason });
            } catch (err) {
              this.#log("warn", "mark_left failed", {
                ...ids,
                type: viewTagOf(err),
              });
            }
          });
          this.#log("warn", "group left", { ...ids, reason });
          this.#background(this.ensureJoined(rec.id));
          return "left";
        }
      }
    }
  }

  /**
   * W4d X#2: resume the own commit stage native persisted for the held
   * group (`_pending_commit`), when no commit flow runs for that group: a
   * crash or restart between stage and outcome, a manager rebuild, or a
   * parked commit. Its outcome is unknown, so it re-enters the submit loop
   * at `{refetch, unknown_outcome}`: the `{group}:{epoch}` row is fetched
   * FIRST (own committer → won with the DS's stored string and the row's
   * `rejoin_intents`; another → lost; absent → the IDENTICAL persisted
   * bytes are resubmitted, never a re-stage). Resolves true when a stage
   * was found (the caller's routine commits then wait for the next
   * refresh), false otherwise. Never rejects except on dispose.
   *
   * W4d N1: a resubmit needs the FULL submit body (welcome and the
   * added/removed declarations): the DS cannot see inside the commit and
   * reads absent declarations as empty, so a bare `{epoch, commit}` of an
   * Add/Remove would be ACCEPTED and poison every other member
   * (`commit_declaration_mismatch`) while the joiner never gets a Welcome.
   * Native persists only `{epoch, commit}` and cannot say whether the
   * stage is an Update, so the full body this manager persisted at stage
   * time (`PROTECTED_STAGE_KEY_PREFIX`, matched on epoch AND bytes) is the
   * only body ever resubmitted. Without it the resume only REFETCHES: own
   * row → won; another → lost; absent → `_commit_lost` and a refresh (the
   * normal flows re-derive the Add/Remove/Update from server state).
   */
  #resumeStage(rec: ChannelRec): Promise<boolean> {
    const n = rec.native;
    if (
      this.#disposed ||
      rec.stripped ||
      !n ||
      n.state !== "active" ||
      n.group_id === null ||
      this.#busy(n.group_id) ||
      // D21: an unaccepted create's stage is the re-run's to refuse.
      this.#unacceptedCreate(rec) !== null
    ) {
      return Promise.resolve(false);
    }
    const groupId = n.group_id;
    // Counted synchronously, before any await: one resume per group.
    this.#busyEnter(groupId);
    const run = this.#resumeStageInner(rec, groupId).finally(() => {
      this.#busyLeave(groupId);
      if (this.#resuming.get(groupId) === run) this.#resuming.delete(groupId);
    });
    // N4: a staging flow arriving meanwhile waits for this resume.
    this.#resuming.set(groupId, run);
    return run;
  }

  /** N1: the persisted full body of this stage, or null (never guessed). */
  #fullStageBody(
    groupId: string,
    pending: { epoch: number; commit_b64: string },
  ): TextSubmitCommitPayload | null {
    const matches = (b: unknown): b is TextSubmitCommitPayload =>
      isRecord(b) &&
      b.device_id === this.#port.selfDeviceId &&
      b.epoch === pending.epoch &&
      b.commit === pending.commit_b64;
    let stored: unknown = null;
    try {
      const raw = this.#port.store.get(this.#stageKey(groupId));
      stored = JSON.parse(raw ?? "null");
    } catch {
      stored = null;
    }
    if (matches(stored)) return stored;
    const hint = this.#stagedPayloads.get(groupId);
    return matches(hint) ? hint : null;
  }

  #stageKey(groupId: string): string {
    return `${PROTECTED_STAGE_KEY_PREFIX}${this.#port.selfUserId}:${groupId}`;
  }

  /** N1: persist the full submit body BEFORE it is POSTed. */
  #persistStage(groupId: string, payload: TextSubmitCommitPayload): void {
    this.#stagedPayloads.set(groupId, payload);
    let ok = false;
    try {
      const raw = JSON.stringify(payload);
      ok = this.#port.store.set(this.#stageKey(groupId), raw);
    } catch {
      ok = false;
    }
    if (!ok) {
      this.#log("warn", "stage body not persisted", {
        groupId,
        epoch: payload.epoch,
      });
    }
  }

  /** The stage is resolved: drop its persisted body (only that one). */
  #dropStage(groupId: string, payload: TextSubmitCommitPayload): void {
    if (this.#stagedPayloads.get(groupId) === payload) {
      this.#stagedPayloads.delete(groupId);
    }
    const key = this.#stageKey(groupId);
    try {
      const stored: unknown = JSON.parse(this.#port.store.get(key) ?? "null");
      if (
        stored === null ||
        (isRecord(stored) &&
          stored.epoch === payload.epoch &&
          stored.commit === payload.commit)
      ) {
        this.#port.store.delete(key);
      }
    } catch {
      this.#port.store.delete(key);
    }
  }

  async #resumeStageInner(rec: ChannelRec, groupId: string): Promise<boolean> {
    let pending: TextCommandResult["e2ee_text_pending_commit"];
    try {
      pending = await this.#enqueue(rec.id, () =>
        this.#invoke("e2ee_text_pending_commit", { groupId }),
      );
    } catch (err) {
      if (isDisposed(err)) throw err;
      this.#log("warn", "pending commit read failed", {
        groupId,
        type: viewTagOf(err),
      });
      return false;
    }
    if (pending === null) return false;
    // A commit flow started meanwhile: it owns the group's stage now.
    if ((this.#commitBusy.get(groupId) ?? 0) > 1) return true;
    const ids = { groupId, epoch: pending.epoch };
    const full = this.#fullStageBody(groupId, pending);
    // Without the full body this payload is only the refetch context and
    // the `_commit_won` byte compare; it is NEVER POSTed (N1).
    const payload: TextSubmitCommitPayload = full ?? {
      device_id: this.#port.selfDeviceId,
      epoch: pending.epoch,
      commit: pending.commit_b64,
    };
    this.#log("info", "resuming a staged commit", {
      ...ids,
      fullBody: full !== null,
    });
    try {
      const ctx = this.#submitCtx(
        groupId,
        payload,
        false,
        full === null ? null : (full.removed ?? []),
      );
      const first: SubmitAction = {
        kind: "refetch",
        purpose: { kind: "unknown_outcome" },
        delayMs: 0,
      };
      await this.#runSubmitLoop(
        rec,
        payload,
        ctx,
        first,
        false,
        null,
        full !== null,
      );
    } catch (err) {
      if (isDisposed(err)) throw err;
      this.#log("warn", "staged commit resume failed", {
        ...ids,
        type: viewTagOf(err),
      });
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Gap refetch (runs INSIDE the channel lane)
  // -------------------------------------------------------------------------

  async #catchUpInner(
    rec: ChannelRec,
    toEpoch: number,
    groupId: string,
  ): Promise<boolean> {
    try {
      return await this.#catchUpRounds(rec, toEpoch, groupId);
    } finally {
      // S4 (R-W4-8): ONE link duty pass over what this catch-up applied.
      this.#dutyAfterCatchUp(rec);
    }
  }

  async #catchUpRounds(
    rec: ChannelRec,
    toEpoch: number,
    groupId: string,
  ): Promise<boolean> {
    let failures = 0;
    for (let round = 0; round < CATCH_UP_ROUND_BUDGET; round++) {
      const n = await this.#readStateDirect(rec);
      if (!n || n.group_id !== groupId || n.state !== "active") return false;
      const current = n.epoch ?? 0;
      if (current >= toEpoch) return true;
      const from = current + 1;
      const ids = { groupId, fromEpoch: from };
      const r = await this.#api(
        "GET",
        `/mls/groups/${groupId}/commits?from_epoch=${from}`,
      );
      if (r === null || r.status === 429 || r.status >= 500) {
        await this.#sleep(
          (r !== null ? retryAfterMs(r) : null) ?? publishBackoffMs(failures),
        );
        failures += 1;
        continue;
      }
      if (!is2xx(r.status)) {
        // 403/404 here never wipes (design 7.5); the refresh decides.
        this.#log("warn", "catch-up refused", { ...ids, status: r.status });
        return false;
      }
      const rows = parseCommitRows(r.body);
      if (rows === null) {
        this.#log("warn", "catch-up answer malformed", ids);
        return false;
      }
      // (b) The server tip of THIS page (`ResponseFetchMlsCommits`); only
      // ever passed to `_process` for rows fetched here. Absent: null.
      const tip =
        isRecord(r.body) && int(r.body.current_epoch)
          ? r.body.current_epoch
          : null;
      if (rows.length === 0) return false;
      if (
        isCatchUpDesync(from, rows) ||
        rows.some((row) => row.group_id !== groupId)
      ) {
        // M5: pruned past retention → wipe and rejoin.
        this.#log("warn", "catch-up desync", ids);
        try {
          await this.#invoke("e2ee_text_mark_left", {
            groupId,
            reason: "catch_up_failed",
          });
        } catch (err) {
          this.#log("warn", "mark_left failed", {
            ...ids,
            type: viewTagOf(err),
          });
        }
        this.#background(this.ensureJoined(rec.id));
        return false;
      }
      for (const row of rows) {
        const wire = textEnvelopeFromCommitInfo(row);
        if (!wire) {
          this.#log("warn", "catch-up row malformed", {
            groupId,
            epoch: row.epoch,
          });
          return false;
        }
        const res = await this.#processWire(rec, wire, 1, tip, true);
        if (res !== "ok") return false;
      }
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // D10 orphans (RC NEW-6)
  // -------------------------------------------------------------------------

  async #resolveOrphans(): Promise<void> {
    const ext = this.#port as Partial<ProtectedTextPortExtensions>;
    if (typeof ext.storeKeys !== "function") {
      this.#log("error", "orphan scan unavailable: port lacks storeKeys", {});
      return;
    }
    const prefix = `${PROTECTED_SEND_KEY_PREFIX}${this.#port.selfUserId}:`;
    let keys: string[];
    let live: ReadonlySet<string>;
    try {
      keys = ext.storeKeys(prefix);
      live = ext.liveOutboxKeys?.() ?? new Set<string>();
    } catch {
      // The outbox is not loaded yet (C5's accessor throws until it is):
      // skip; B5 calls rescanOrphans once it is set (W4b audit M4).
      this.#log("warn", "orphan scan deferred: outbox not loaded", {});
      return;
    }
    for (const key of keys) {
      if (this.#disposed) return;
      const rest = key.slice(prefix.length);
      const sep = rest.indexOf(":");
      if (sep <= 0) continue;
      const channelId = rest.slice(0, sep);
      const outboxKey = rest.slice(sep + 1);
      if (live.has(outboxKey)) continue; // the Draft outbox owns it
      let cid: string | null = null;
      let encrypted: unknown = null;
      try {
        const v: unknown = JSON.parse(this.#port.store.get(key) ?? "null");
        if (isRecord(v) && str(v.nonce)) {
          cid = v.nonce;
          encrypted = v.encrypted ?? null;
        }
      } catch {
        cid = null;
      }
      try {
        await this.#confirmOrphan(channelId, key, cid, encrypted);
      } catch (err) {
        if (isDisposed(err)) return;
        this.#log("warn", "orphan confirm failed", { channelId });
      }
    }
  }

  /**
   * Refetch-confirm one stored send (never re-sent: one retry only through
   * the outbox). Found → delete. Absent → delete + `maybeUnsent`. Unknown
   * after the budget → kept for the next start.
   */
  async #confirmOrphan(
    channelId: string,
    key: string,
    cid: string | null,
    encrypted: unknown,
  ) {
    const rec = await this.#register(channelId);
    const absent = () => {
      this.#port.store.delete(key);
      rec.maybeUnsent = true;
      this.#log("warn", "orphan send not found", { channelId });
      this.#emit(rec);
    };
    if (cid === null) return absent();
    // An orphan's outcome is unknown: confirm as "possibly delivered".
    const trigger: SendTrigger = {
      status: 409,
      type: "DuplicateNonce",
      reason: null,
      retryAfterMs: null,
    };
    // X#4: only a row bound to the stored bytes confirms the send.
    const ctx: SendContext = {
      selfUserId: this.#port.selfUserId,
      channelId,
      cid,
      encrypted,
      priorUnknown: true,
      resecureRetried: true,
      failures: 0,
    };
    const start = (): SendAction =>
      classifySendAnswer(
        {
          kind: "response",
          response: {
            status: 409,
            resetAfterMs: null,
            body: { type: "DuplicateNonce" },
          },
        },
        ctx,
      );
    let action = start();
    for (;;) {
      switch (action.kind) {
        case "confirm": {
          const before = action.before ? `&before=${action.before}` : "";
          const r = await this.#api(
            "GET",
            `/channels/${channelId}/messages?after=${action.after}` +
              `&sort=Latest&limit=${CONFIRM_PAGE_LIMIT}${before}`,
          );
          action = classifySendAnswer(
            r !== null
              ? {
                  kind: "confirm",
                  trigger,
                  response: r,
                  pageLimit: CONFIRM_PAGE_LIMIT,
                }
              : { kind: "confirm_transport_error", trigger },
            ctx,
          );
          break;
        }
        case "confirm_later":
          ctx.failures += 1;
          if (ctx.failures > ORPHAN_CONFIRM_BUDGET) {
            this.#log("warn", "orphan send unresolved", { channelId });
            return;
          }
          await this.#sleep(action.delayMs);
          action = start();
          break;
        case "delivered":
          this.#port.store.delete(key);
          return;
        default:
          return absent();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  async #register(channelId: string): Promise<ChannelRec> {
    this.#checkAlive();
    try {
      await this.#index.addChannel(channelId);
    } catch {
      throw clientFailure("invalid_channel");
    }
    let rec = this.#channels.get(channelId);
    if (!rec) {
      rec = {
        id: channelId,
        seatListError: null,
        groupError: null,
        stickyGroupError: null,
        native: null,
        serverGroup: null,
        serverGroupMissing: false,
        seats: null,
        rosterMismatchSinceMs: null,
        signerLeafMissingRetries: 0,
        signerLeafMissingOn: null,
        welcomeRetriesExhausted: false,
        ownerChangePending: false,
        recreateAvailable: false,
        publishInFlight: false,
        maybeUnsent: false,
        stripped: false,
        parked: [],
        replaying: new Map(),
        welcomeRefusal: null,
        slmSeen: null,
        parkedUnderPending: false,
        confirmInFlight: false,
        settledReplay: false,
        refusalLift: null,
        newerAddTried: null,
        openCtl: null,
        join: null,
        joinFromEpoch: null,
        refreshing: null,
        refreshAgain: false,
        refreshAgainReason: null,
        removalInFlight: false,
        updating: null,
        successorInFlight: false,
        recreating: null,
        seeded: false,
        capacity: null,
        clientOutdated: null,
        ownerNotice: null,
        resecuringSinceMs: null,
        confirmedSigner: null,
        ownerChangeUnlisted: null,
        changePending: false,
        manualPending: false,
        welcomeDone: null,
        joinEventResetAtMs: null,
        welcomeFetch: null,
        storedAdmit: null,
        lastIntentAtMs: null,
        lastIntentRef: null,
        ownIntentSeen: null,
        recoverySignedOver: null,
        historyCtl: new AbortController(),
        walk: null,
        historyWalk: "idle",
        walkFloor: null,
        floorMarker: null,
        oldestHeld: new Map(),
        walkRetry: null,
        historyEpoch: null,
        historyLineKept: null,
        historyUpdateTries: new Map(),
        historyUpdateBusy: false,
        oldestOkMs: null,
        policySent: null,
        rowInputs: null,
        duties: new Set(),
        caughtUp: null,
        ownerCheck: false,
      };
      this.#channels.set(channelId, rec);
    }
    return rec;
  }

  #recForGroup(groupId: string): ChannelRec | null {
    const ref = this.#index.get(groupId);
    return ref ? (this.#channels.get(ref.channelId) ?? null) : null;
  }

  #isSigner(rec: ChannelRec): boolean {
    const l = rec.native?.seat_list ?? null;
    return (
      l !== null &&
      l.signer_user_id === this.#port.selfUserId &&
      l.signer_device_id === this.#port.selfDeviceId
    );
  }

  /** Binding note: never a message-level tag or `busy`. */
  #recordGroupError(
    rec: ChannelRec | null,
    verdictTag: ViewErrorTag | undefined,
    tag: ViewErrorTag,
    groupId: string,
  ): void {
    if (!rec || verdictTag === undefined || tag === "busy") return;
    if ((MESSAGE_LEVEL_TAGS as readonly string[]).includes(tag)) return;
    this.#setGroupError(rec, verdictTag, groupId);
  }

  /**
   * W4d X#1: a sticky loud tag (`STICKY_GROUP_ERRORS`) is recorded with the
   * group it came from; while one is held, any other tag is ignored (a
   * newer loud tag replaces it).
   */
  #setGroupError(rec: ChannelRec, tag: ViewErrorTag, groupId: string): void {
    if ((STICKY_GROUP_ERRORS as readonly string[]).includes(tag)) {
      rec.stickyGroupError = {
        tag,
        groupId,
        generation:
          this.#index.get(groupId)?.generation ?? Number.POSITIVE_INFINITY,
      };
      rec.groupError = tag;
    } else if (rec.stickyGroupError === null) {
      rec.groupError = tag;
    } else {
      this.#log("info", "group error kept over a benign tag", {
        channelId: rec.id,
        kept: rec.stickyGroupError.tag,
        type: tag,
      });
    }
    this.#emit(rec);
  }

  /**
   * A processed outcome clears `groupError`, except a sticky one, which
   * only a `welcome_joined` into a HIGHER generation of the channel than
   * the poisoned group clears (X#1). LOW-2: the generation is native's
   * (`_state`, read after the outcome, naming the joined group); the
   * index, whose first reporter may be the server, only when native does
   * not name it.
   */
  #clearGroupError(rec: ChannelRec, out: TextProcessOutcome): void {
    const sticky = rec.stickyGroupError;
    if (sticky !== null) {
      if (out.kind !== "welcome_joined") return;
      const ref = this.#index.get(out.group_id);
      if (!ref || ref.channelId !== rec.id) return;
      const n = rec.native;
      const generation =
        n !== null &&
        n.group_id === out.group_id &&
        typeof n.generation === "number"
          ? n.generation
          : ref.generation;
      if (generation <= sticky.generation) return;
      rec.stickyGroupError = null;
      this.#log("info", "sticky group error cleared by a successor", {
        channelId: rec.id,
        groupId: out.group_id,
      });
    }
    rec.groupError = null;
  }

  /** D21: this device's own create of `generation` was accepted (X#1). */
  #clearStickyBelow(rec: ChannelRec, generation: number): void {
    const sticky = rec.stickyGroupError;
    if (sticky === null || generation <= sticky.generation) return;
    rec.stickyGroupError = null;
    rec.groupError = null;
    this.#log("info", "sticky group error cleared by own successor", {
      channelId: rec.id,
    });
    this.#emit(rec);
  }

  async #readState(rec: ChannelRec): Promise<TextChannelState | null> {
    return this.#enqueue(rec.id, () => this.#readStateDirect(rec));
  }

  /** `_state` without the lane (call only from inside the lane). */
  async #readStateDirect(rec: ChannelRec): Promise<TextChannelState | null> {
    try {
      const n = await this.#invoke("e2ee_text_state", { channelId: rec.id });
      this.#report(rec.id, n.group_id, n.generation, "state");
      rec.native = n;
      if (n.verdict === "roster_mismatch") {
        rec.rosterMismatchSinceMs ??= this.#port.now();
      } else {
        rec.rosterMismatchSinceMs = null;
      }
      this.#replayIfSettled(rec);
      // S4: only here, on a state native just answered; a failed read
      // (below) reports no history policy at all.
      this.#syncHistory(rec);
      this.#historyUpdateOwed(rec);
    } catch (err) {
      if (isDisposed(err)) throw err;
      this.#log("warn", "state read failed", {
        channelId: rec.id,
        type: viewTagOf(err),
      });
    }
    return rec.native;
  }

  /**
   * D18: own devices pinned with the COMPLETE listing when it changes.
   * FXP F-L6 (MJ-1): resolves how it went; callers that ignore it behave as
   * before (a failure is logged, never thrown). A listing the bridge served
   * from its cache past its freshness (its `at`, read only if present) came
   * after a failed fetch: `transport`, though it is still pinned as before.
   * F-R8: `force` (a pin native asked for) also asks the bridge for a fresh
   * listing, and `want` names the devices it must list: a cached listing
   * from before a new own device registered cannot pin it. The bridge
   * marks the listing it fell back to for such a request (`stale`, read
   * only if present) when the fresh fetch failed: `transport` too, however
   * young its `at`.
   */
  async #ensureOwnPins(
    force: boolean,
    want?: readonly string[],
  ): Promise<PinOutcome> {
    try {
      const own = await this.#port.ownDeviceListing({ force, want });
      const { hash, listing } = own;
      if (!force && hash === this.#ownPinsHash) return "answered";
      await this.#invoke("e2ee_text_pin_own_devices", {
        userId: this.#port.selfUserId,
        devices: listing,
      });
      this.#ownPinsHash = hash;
      const at: unknown = (own as { at?: unknown }).at;
      if ((own as { stale?: unknown }).stale === true) return "transport";
      return typeof at === "number" &&
        this.#port.now() - at >= OWN_LISTING_FRESH_MS
        ? "transport"
        : "answered";
    } catch (err) {
      if (isDisposed(err)) throw err;
      this.#log("warn", "own device pin failed", { type: viewTagOf(err) });
      return pinFailureOutcome(err);
    }
  }

  /**
   * D18: pin a user's devices (own user: the own-device listing). FXP F-L6
   * (MJ-1): resolves how it went: `answered` once the listing reached
   * native (the call returns only NEW pins, so "already pinned" and "not
   * listed" look alike; only a `_process` re-run tells), else
   * `pinFailureOutcome`. Callers that ignore it behave as before.
   */
  async #pinFor(userId: string, deviceIds: string[]): Promise<PinOutcome> {
    if (userId === this.#port.selfUserId) {
      return this.#ensureOwnPins(true, deviceIds);
    }
    try {
      await this.#port.pinCallIdentities(userId, deviceIds);
      return "answered";
    } catch (err) {
      this.#log("warn", "identity pin failed", { type: viewTagOf(err) });
      return pinFailureOutcome(err);
    }
  }

  #marker(
    rec: ChannelRec,
    m: Parameters<ProtectedTextManagerCallbacks["onTimelineMarker"]>[1],
  ): void {
    try {
      this.#cb.onTimelineMarker(rec.id, m);
    } catch {
      this.#log("error", "onTimelineMarker threw", { channelId: rec.id });
    }
  }

  /**
   * FXP F-L6 (M2): the view's `groupError`. A refused Welcome's alarm
   * (`rec.welcomeRefusal`) shows as the loud `mls_leaf_rejected` until
   * native accepts that group, even after a rejoin grant cleared the join
   * block; only another sticky loud tag (the X#1 record) is shown instead.
   */
  #shownGroupError(rec: ChannelRec): ViewErrorTag | null {
    if (rec.welcomeRefusal === null || rec.stickyGroupError !== null) {
      return rec.groupError;
    }
    return "mls_leaf_rejected";
  }

  #view(rec: ChannelRec): ProtectedChannelView {
    return {
      channelId: rec.id,
      seatListError: rec.seatListError,
      groupError: this.#shownGroupError(rec),
      native: rec.native,
      serverGroup: rec.serverGroup,
      seats: rec.seats,
      rosterMismatchSinceMs: rec.rosterMismatchSinceMs,
      signerLeafMissingRetries: rec.signerLeafMissingRetries,
      welcomeRetriesExhausted: rec.welcomeRetriesExhausted,
      ownerChangePending: rec.ownerChangePending,
      recreateAvailable: rec.recreateAvailable,
      publishInFlight: rec.publishInFlight,
      maybeUnsent: rec.maybeUnsent,
      capacity: rec.capacity,
      clientOutdated: rec.clientOutdated,
      ownerNotice: rec.ownerNotice,
      resecuringSinceMs: rec.resecuringSinceMs,
      ownerChangeUnlisted:
        rec.ownerChangeUnlisted !== null &&
        rec.native?.owner_pin?.pending_signer?.device_id ===
          rec.ownerChangeUnlisted.deviceId,
      historyWalk: rec.historyWalk,
    };
  }

  #emit(rec: ChannelRec): void {
    if (this.#disposed) return;
    // OR-10: a new list or pin state offers Review again.
    if (
      rec.ownerChangeUnlisted !== null &&
      rec.ownerChangeUnlisted.key !== this.#ownerKey(rec)
    ) {
      rec.ownerChangeUnlisted = null;
    }
    // FXF: the 6c count shown is only ever the current group's.
    this.#rebindLeafMissing(rec);
    this.#trackResecuring(rec);
    try {
      this.#cb.onView(rec.id, this.#view(rec));
    } catch {
      this.#log("error", "onView threw", { channelId: rec.id });
    }
  }

  /**
   * S2-D36 input: the shield this view yields (flags from the client cache;
   * this manager only runs where the text plane is capable). Entering
   * `resecuring` stamps `port.now()`, leaving it clears the stamp. Never a
   * security input: it only times the amber escalation.
   */
  #trackResecuring(rec: ChannelRec): void {
    let state: string | null = null;
    try {
      const info = this.#port.channelInfo(rec.id);
      state = computeShieldState(
        shieldInputsFromView(
          this.#view(rec),
          {
            serverProtected: info ? info.serverProtected : !rec.stripped,
            locallyPinned: info ? info.locallyPinned : true,
            capable: true,
          },
          this.#port.now(),
        ),
      );
    } catch {
      state = null;
    }
    if (state === "resecuring") {
      rec.resecuringSinceMs ??= this.#port.now();
    } else {
      rec.resecuringSinceMs = null;
    }
  }

  /** OR-10: the list and pin state a withheld Review is bound to. */
  #ownerKey(rec: ChannelRec): string {
    const l = rec.seats?.list ?? null;
    const pin = rec.native?.owner_pin ?? null;
    return JSON.stringify([
      l?.version ?? null,
      l?.signature ?? null,
      pin?.status ?? null,
      pin?.owner_device_id ?? null,
      pin?.pending_signer?.device_id ?? null,
    ]);
  }

  /**
   * S2 (h): index a group id native or the server reported for `channelId`
   * (both indexes: this manager's, then the bridge's through
   * `onGroupReported`), BEFORE any join or process for it. A malformed id
   * or generation (`RangeError`) is logged and skipped; one that maps
   * elsewhere is logged without ids and never re-routed.
   */
  #report(
    channelId: string,
    groupId: unknown,
    generation: unknown,
    source: string,
  ): void {
    if (groupId === null || groupId === undefined) return;
    if (generation === null || generation === undefined) return;
    try {
      this.#index.addReported(
        groupId as string,
        channelId,
        generation as number,
      );
    } catch (err) {
      if (err instanceof RangeError) {
        this.#log("warn", "reported group id malformed", { channelId, source });
      } else {
        this.#log("warn", "reported group id conflict", { source });
      }
      return;
    }
    const extra = this.#cb as Partial<ProtectedTextManagerExtraCallbacks>;
    try {
      extra.onGroupReported?.(
        channelId,
        groupId as string,
        generation as number,
      );
    } catch {
      this.#log("error", "onGroupReported threw", { channelId });
    }
  }

  /** (h) The `as_of_*` group of a seats snapshot (skipped without both). */
  #reportSeats(rec: ChannelRec, seats: ProtectedSeatsResponse): void {
    this.#report(rec.id, seats.as_of_group_id, seats.as_of_generation, "seats");
  }

  /**
   * S2 (i): an `owner_notice` of a verify verdict or a process outcome:
   * the view keeps the latest, and ONE `owner_notice` toast is raised.
   * Neither changes the shield.
   */
  #noteOwnerNotice(rec: ChannelRec, raw: unknown): void {
    if (raw === undefined || raw === null) return;
    const notice = ownerNoticeOf(raw);
    if (notice === null) {
      this.#log("warn", "owner notice malformed", { channelId: rec.id });
      return;
    }
    rec.ownerNotice = notice;
    this.#log("info", "owner notice", { channelId: rec.id, kind: notice.kind });
    this.#emit(rec);
    try {
      this.#port.notify("owner_notice");
    } catch {
      this.#log("error", "notify threw", { channelId: rec.id });
    }
  }

  /**
   * S4 floor (a): the server refused this client's text protocol. Join and
   * create stop for the channel until reload (no retry loop). Ids only.
   */
  #markOutdated(rec: ChannelRec, min: number): void {
    rec.clientOutdated = min;
    this.#log("warn", "client outdated for this channel", {
      channelId: rec.id,
    });
    this.#emit(rec);
  }

  // -------------------------------------------------------------------------
  // S4 history: the flag, links out, the duty, the owner check (L2m)
  // -------------------------------------------------------------------------

  /**
   * The server's `history_setting` advert as the bridge holds it, read at
   * call time (R-W4-9). Anything but a literal true is off, and so is a
   * port that has no such member or throws. It gates writes and new
   * activity only (R-W4-31), never the policy callback or a row decision.
   */
  #historyOn(): boolean {
    try {
      return this.#port.historySetting?.() === true;
    } catch {
      return false;
    }
  }

  /**
   * History activity that needs the S4 native commands (the walk, a link
   * build): the flag on, and no such command found missing (R-W4-33).
   */
  #historyRuns(): boolean {
    return !this.#noHistoryCommands && this.#historyOn();
  }

  /** Link writes: `#historyRuns`, and no PUT answered `disabled` / `outdated`. */
  #linksOn(): boolean {
    return !this.#linksOff && this.#historyRuns();
  }

  /**
   * R-W4-33: an S2-era shell answered a history command as missing
   * (`isMissingCommandError`). History is off for the session: no walk, no
   * link build. Rows a walk left pending are decided again and get the S2
   * markers (`#requestWalk` answers `floor`).
   */
  #latchNoHistoryCommands(command: TextCommand): void {
    if (this.#noHistoryCommands) return;
    this.#noHistoryCommands = true;
    this.#log("error", "history command missing: history off this session", {
      command,
    });
    for (const rec of this.#channels.values()) this.#rerunPending(rec);
  }

  /** Refuse a history owner call while the flag is off, before anything. */
  #requireHistory(channelId: string): void {
    if (this.#historyOn()) return;
    this.#log("error", "history call with history_setting off", { channelId });
    throw clientFailure("history_setting_off");
  }

  /**
   * A wait of the history plane (a duty stagger, a link PUT backoff) on the
   * channel's own signal. False when it was cut short or the manager is
   * gone: the caller stops there.
   */
  async #historyWait(signal: AbortSignal, ms: number): Promise<boolean> {
    if (this.#disposed || signal.aborted) return false;
    if (ms > 0) {
      try {
        await this.#port.sleep(ms, signal);
      } catch {
        return false;
      }
    }
    return !this.#disposed && !signal.aborted;
  }

  /** This device is one of the user native pinned as the channel's owner. */
  #ownerDevice(rec: ChannelRec): boolean {
    const owner = rec.native?.owner_pin?.owner_user_id ?? null;
    return owner !== null && owner === this.#port.selfUserId;
  }

  /** This device's leaf position in `groupId`, null when it is not known. */
  #ownLeaf(rec: ChannelRec, groupId: string): number | null {
    const n = rec.native;
    if (n === null || n.group_id !== groupId) return null;
    const i = n.members.findIndex(
      (m) =>
        m.user_id === this.#port.selfUserId &&
        m.device_id === this.#port.selfDeviceId,
    );
    return i < 0 ? null : i;
  }

  /** A link duty is still owed: `groupId` is the group held and current. */
  #dutyOwed(rec: ChannelRec, groupId: string): boolean {
    const n = rec.native;
    return n !== null && n.group_id === groupId && holdsCurrentGroup(n);
  }

  /**
   * S4 (design 8.5 "Refresh", OPEN 3): count new epoch rows and ask the
   * bridge for a backup refresh every `BACKUP_REFRESH_EPOCHS` of them.
   * Callers check the flag.
   */
  #countEpochs(n: number): void {
    this.#epochsSinceBackup += n;
    if (this.#epochsSinceBackup < BACKUP_REFRESH_EPOCHS) return;
    this.#epochsSinceBackup = 0;
    try {
      this.#deps.requestBackupRefresh();
    } catch {
      this.#log("warn", "backup refresh request threw", {});
    }
  }

  /**
   * After a processed outcome: the epoch count, and the link this device
   * may owe for the new epoch (R-W4-8). A committer writes its own link
   * from `_commit_won` (`#putWonLink`); a catch-up row is noted for the one
   * pass after the catch-up; a live commit is `memberDuty`'s to decide.
   */
  #historyAfterOutcome(
    rec: ChannelRec,
    out: TextProcessOutcome,
    origin: OutcomeOrigin,
  ): void {
    if (!this.#historyOn()) return;
    if (out.kind !== "duplicate") this.#countEpochs(1);
    // A device the commit removed holds no key of the new epoch: no link.
    if (out.removed_self === true) return;
    if (origin === "won") return;
    if (origin === "catch_up") {
      if (out.kind !== "commit_applied" || !int(out.epoch)) return;
      const span = rec.caughtUp;
      if (span === null || span.groupId !== out.group_id) {
        rec.caughtUp = {
          groupId: out.group_id,
          from: out.epoch,
          to: out.epoch,
        };
      } else {
        span.from = Math.min(span.from, out.epoch);
        span.to = Math.max(span.to, out.epoch);
      }
      return;
    }
    const duty = memberDuty({
      outcomeKind: out.kind,
      historySetting: this.#historyOn(),
      sessionDisabled: this.#linksOff || this.#noHistoryCommands,
      groupId: out.group_id,
      epoch: out.epoch,
      ownLeaf: this.#ownLeaf(rec, out.group_id),
    });
    if (!duty.run) return;
    this.#background(
      this.#runDuty(rec, duty.holder.groupId, duty.holder.epoch, duty.delayMs),
    );
  }

  /**
   * One member duty (design 3.14.6 step 2): after the leaf stagger, the
   * stored candidates of the holder, native's build over them, then the
   * PUT it asks for. Dropped when the wait was cut short or the group was
   * left or superseded meanwhile.
   */
  async #runDuty(
    rec: ChannelRec,
    groupId: string,
    epoch: number,
    delayMs: number,
  ): Promise<void> {
    const key = `${groupId}:${epoch}`;
    if (rec.duties.has(key)) return;
    rec.duties.add(key);
    const signal = rec.historyCtl.signal;
    try {
      if (!(await this.#historyWait(signal, delayMs))) return;
      // A8: the flag is read again after the wait, before the link GET.
      if (!this.#linksOn()) return;
      if (!this.#dutyOwed(rec, groupId)) {
        this.#log("info", "history duty dropped: group left or superseded", {
          channelId: rec.id,
          groupId,
          epoch,
        });
        return;
      }
      const candidates = await this.#candidatesOf(groupId, epoch);
      if (candidates === null) return;
      await this.#buildLink(rec, groupId, epoch, candidates, signal);
    } finally {
      rec.duties.delete(key);
    }
  }

  /** After `#catchUpInner`: the one batched duty pass (R-W4-8). */
  #dutyAfterCatchUp(rec: ChannelRec): void {
    const span = rec.caughtUp;
    rec.caughtUp = null;
    if (span === null || !this.#linksOn()) return;
    this.#background(this.#runCatchUpDuty(rec, span));
  }

  /**
   * The holders a catch-up applied, newest first, at most
   * `DUTY_BATCH_MAX` (`catchUpDuty`); the older ones are left to other
   * members. One leaf stagger before the pass, then holder by holder, the
   * link pages shared between them.
   */
  async #runCatchUpDuty(
    rec: ChannelRec,
    span: { groupId: string; from: number; to: number },
  ): Promise<void> {
    const { groupId } = span;
    const { holders, skipped } = catchUpDuty(
      { groupId, fromEpoch: span.from, toEpoch: span.to },
      this.#linksOn(),
    );
    if (holders.length === 0) return;
    const leaf = this.#ownLeaf(rec, groupId);
    if (leaf === null) return;
    if (skipped > 0) {
      this.#log("info", "history duty: older holders left to other members", {
        channelId: rec.id,
        groupId,
        count: skipped,
      });
    }
    const signal = rec.historyCtl.signal;
    if (!(await this.#historyWait(signal, leafStaggerMs(leaf)))) return;
    let before = holders[0] + 1;
    let ended = false;
    const byEpoch = new Map<number, HistoryLinkWire[]>();
    for (const epoch of holders) {
      if (!this.#linksOn() || signal.aborted) return;
      if (!this.#dutyOwed(rec, groupId)) {
        this.#log("info", "history duty dropped: group left or superseded", {
          channelId: rec.id,
          groupId,
          epoch,
        });
        return;
      }
      while (!ended && epoch < before) {
        const top = before;
        const page = await this.#linkPage(groupId, top, HISTORY_LINK_PAGE);
        if (page === "failed") return;
        if (page === "end") {
          ended = true;
          break;
        }
        for (const link of page) {
          const l: unknown = link;
          if (
            !isRecord(l) ||
            l.group_id !== groupId ||
            !int(l.epoch) ||
            l.epoch >= top
          ) {
            continue;
          }
          const bucket = byEpoch.get(l.epoch);
          if (bucket) bucket.push(link);
          else byEpoch.set(l.epoch, [link]);
          if (l.epoch < before) before = l.epoch;
        }
        // A page that brought nothing below `top` is the end of the list.
        if (before === top) ended = true;
      }
      await this.#buildLink(
        rec,
        groupId,
        epoch,
        byEpoch.get(epoch) ?? [],
        signal,
      );
      byEpoch.delete(epoch);
    }
  }

  /**
   * One page of `GET /mls/groups/:id/history_links`: the links whose holder
   * epoch is below `before`, newest holder first. `"end"` is an EMPTY page,
   * the only end there is; `"failed"` is every answer that is not a
   * readable 2xx. The rows are handed on as the server sent them.
   */
  async #linkPage(
    groupId: string,
    before: number | null,
    limit: number,
  ): Promise<HistoryLinkWire[] | "end" | "failed"> {
    const query =
      before === null ? `limit=${limit}` : `before=${before}&limit=${limit}`;
    const r = await this.#api(
      "GET",
      `/mls/groups/${encodeURIComponent(groupId)}/history_links?${query}`,
    );
    const links: unknown =
      r !== null && is2xx(r.status) && isRecord(r.body) ? r.body.links : null;
    if (!Array.isArray(links)) {
      this.#log("warn", "history links unread", {
        groupId,
        status: r === null ? null : r.status,
      });
      return "failed";
    }
    return links.length === 0 ? "end" : (links as HistoryLinkWire[]);
  }

  /** The stored candidates of ONE holder; null when they could not be read. */
  async #candidatesOf(
    groupId: string,
    epoch: number,
  ): Promise<HistoryLinkWire[] | null> {
    const page = await this.#linkPage(
      groupId,
      epoch + 1,
      HISTORY_LINK_PAGE_ONE,
    );
    if (page === "failed") return null;
    if (page === "end") return [];
    return page.filter((link) => {
      const l: unknown = link;
      return isRecord(l) && l.group_id === groupId && l.epoch === epoch;
    });
  }

  /**
   * `_history_link_build` for one holder, then what L1k's `buildAnswer`
   * makes of it: a PUT, a log line, an owner toast, or nothing. A link
   * native refused is never sent, and the writer ids native lists stay
   * inside `buildAnswer`. Never rejects except on dispose.
   */
  async #buildLink(
    rec: ChannelRec,
    groupId: string,
    epoch: number,
    candidates: HistoryLinkWire[],
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.#linksOn() || signal.aborted) return;
    const ids = { channelId: rec.id, groupId, epoch };
    let built: HistoryLinkBuilt;
    try {
      built = await this.#invoke("e2ee_text_history_link_build", {
        groupId,
        epoch,
        candidates,
      });
    } catch (err) {
      if (isDisposed(err)) throw err;
      if (isMissingCommandError(err)) {
        this.#latchNoHistoryCommands("e2ee_text_history_link_build");
        return;
      }
      this.#log("warn", "history link build failed", {
        ...ids,
        type: viewTagOf(err),
      });
      return;
    }
    const answer = buildAnswer(built);
    const holder = `${groupId}:${epoch}`;
    if (answer.log === "too_large") {
      this.#log("error", "history link not built: too large", ids);
      this.#ownerToast(rec, "history_too_large", [holder]);
    } else if (answer.log === "hidden") {
      this.#log("debug", "history link not built: hidden", ids);
    } else if (answer.log === "not_derived") {
      // A stored candidate that already carries this device's keys answers
      // no link and no reason (3.14.6 step 2): the duty is done, not failed.
      const discharged =
        isRecord(built) &&
        built.link === null &&
        built.refused === null &&
        candidates.length > 0;
      this.#log(
        discharged ? "debug" : "error",
        discharged
          ? "history link already stored"
          : "history link not built: not derived",
        ids,
      );
    }
    if (answer.ownerNotice) this.#ownerToast(rec, "history_mismatch", [holder]);
    if (answer.put === null) return;
    await this.#putLink(rec, answer.put.link, answer.put.contest, signal);
  }

  /**
   * PUT one history link (design 3.14.6; L1k `classifyLinkPut`). `link` is
   * the object native returned: it is the body of every attempt, never
   * rebuilt. 204 and `HistoryLinkExists` end it; `disabled` / `outdated`
   * end every link write of this session; 5xx, 429 and no answer wait and
   * send the same object again; anything else drops this link. Never
   * rejects except on dispose.
   */
  async #putLink(
    rec: ChannelRec,
    link: HistoryLinkWire,
    contest: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const path = linkPutPath(link, contest);
    const ids = {
      channelId: rec.id,
      groupId: link.group_id,
      epoch: link.epoch,
    };
    // Design 3.14.6 step 3: the contesting bridge says so loudly, ids only.
    if (contest) this.#log("error", "history link contested", ids);
    for (let attempt = 1; ; attempt++) {
      if (!this.#linksOn() || signal.aborted) return;
      const r = await this.#api("PUT", path, link);
      const answer = classifyLinkPut(
        r === null
          ? "transport"
          : {
              status: r.status,
              errorType: errorTypeOf(r.body),
              feature:
                isRecord(r.body) && str(r.body.feature) ? r.body.feature : null,
            },
        attempt,
      );
      switch (answer.kind) {
        case "done":
        case "exists":
          return;
        case "disabled":
        case "outdated":
          this.#linksOff = true;
          this.#log(
            answer.kind === "outdated" ? "error" : "warn",
            "history links stopped for this session",
            { ...ids, reason: answer.kind },
          );
          return;
        case "retry":
          if (!(await this.#historyWait(signal, answer.afterMs))) return;
          break;
        case "refused":
          this.#log("error", "history link PUT refused", {
            ...ids,
            status: r === null ? null : r.status,
            attempts: attempt,
          });
          return;
        default: {
          const _x: never = answer;
          return;
        }
      }
    }
  }

  /**
   * The committer's link (design 3.14.6 step 1): `history_link` of a
   * `_commit_won` answer, a `duplicate` one included, PUT as native
   * returned it. Called after the outcome was handled; the PUT is not
   * awaited and nothing here can fail the won commit.
   */
  #putWonLink(rec: ChannelRec, out: TextProcessOutcome): void {
    try {
      if (!this.#linksOn() || out.removed_self === true) return;
      const link: unknown = out.history_link;
      if (link === undefined || link === null) return;
      // The same shape check a built link gets before it can address a PUT.
      const answer = buildAnswer({
        link: link as HistoryLinkWire,
        contest: false,
        mismatched_writers: [],
        refused: null,
      });
      if (answer.put === null) {
        this.#log("error", "won commit: history link unreadable", {
          channelId: rec.id,
          groupId: out.group_id,
          epoch: out.epoch,
        });
        return;
      }
      this.#background(
        this.#putLink(rec, answer.put.link, false, rec.historyCtl.signal),
      );
    } catch {
      this.#log("error", "won commit: history link not sent", {
        channelId: rec.id,
      });
    }
  }

  /**
   * An owner history notice (L1s `historyOwnerNotice`): only on a device of
   * the user native pinned as the owner, and once per session for a holder.
   * It names no writer, channel or time.
   */
  #ownerToast(
    rec: ChannelRec,
    kind: "history_mismatch" | "history_too_large",
    holders: readonly string[],
  ): void {
    if (!this.#ownerDevice(rec)) return;
    const fresh = holders
      .map((holder) => `${kind}:${rec.id}:${holder}`)
      .filter((key) => !this.#ownerToasted.has(key));
    if (fresh.length === 0) return;
    for (const key of fresh) this.#ownerToasted.add(key);
    const where = historyOwnerNotice(kind);
    if (where === "inline") return;
    try {
      this.#port.notify(where);
    } catch {
      this.#log("error", "notify threw", { channelId: rec.id });
    }
  }

  /**
   * A failed history owner call. The three client reasons of design 9.2
   * "S4" are placed by L1s `historyOwnerNotice`: all three are inline
   * errors of the settings page, so the rejection the caller gets is the
   * notice and nothing is raised here; a kind L1s places as a toast would
   * be. The failure itself is passed on unchanged by the caller.
   */
  #ownerHistoryFailed(rec: ChannelRec, err: unknown): void {
    if (!isFlowFailure(err) || err.source !== "client") return;
    const kind = OWNER_HISTORY_REASONS.find((k) => k === err.reason);
    if (kind === undefined) return;
    this.#log("warn", "history owner call failed", {
      channelId: rec.id,
      reason: kind,
    });
    const where = historyOwnerNotice(kind);
    if (where === "inline") return;
    try {
      this.#port.notify(where);
    } catch {
      this.#log("error", "notify threw", { channelId: rec.id });
    }
  }

  /**
   * The owner's contest check (design 3.14.6 step 3), on a
   * `ProtectedChannelChanged` naming `history`: re-read the native state,
   * then, on an owner-user device only, open the stored candidates of the
   * newest holders (at most `OWNER_CHECK_HOLDERS`) with native's build. A
   * signed mismatch raises ONE `history_mismatch` toast, `too_large` one
   * `history_too_large`. Nothing is PUT from here and no writer is named.
   */
  #ownerHistoryCheck(rec: ChannelRec): void {
    if (rec.ownerCheck) return;
    rec.ownerCheck = true;
    this.#background(
      (async () => {
        try {
          const n = await this.#readState(rec);
          // A8: the flag is read again after the wait, before the link GET.
          if (!this.#historyRuns()) return;
          if (n === null || !this.#ownerDevice(rec)) return;
          if (n.group_id === null || !int(n.epoch)) return;
          const groupId = n.group_id;
          const page = await this.#linkPage(
            groupId,
            n.epoch + 1,
            OWNER_CHECK_HOLDERS * HISTORY_LINK_PAGE_ONE,
          );
          if (!Array.isArray(page)) return;
          const byEpoch = new Map<number, HistoryLinkWire[]>();
          for (const link of page) {
            const l: unknown = link;
            if (!isRecord(l) || l.group_id !== groupId || !int(l.epoch)) {
              continue;
            }
            const bucket = byEpoch.get(l.epoch);
            if (bucket) bucket.push(link);
            else byEpoch.set(l.epoch, [link]);
          }
          const holders = [...byEpoch.keys()]
            .sort((a, b) => b - a)
            .slice(0, OWNER_CHECK_HOLDERS);
          const mismatched: string[] = [];
          const tooLarge: string[] = [];
          for (const epoch of holders) {
            if (!this.#historyRuns()) return;
            let built: HistoryLinkBuilt;
            try {
              built = await this.#invoke("e2ee_text_history_link_build", {
                groupId,
                epoch,
                candidates: byEpoch.get(epoch) ?? [],
              });
            } catch (err) {
              if (isDisposed(err)) throw err;
              if (isMissingCommandError(err)) {
                this.#latchNoHistoryCommands("e2ee_text_history_link_build");
                return;
              }
              this.#log("warn", "history owner check: build failed", {
                channelId: rec.id,
                groupId,
                epoch,
                type: viewTagOf(err),
              });
              continue;
            }
            const answer = buildAnswer(built);
            if (answer.ownerNotice) mismatched.push(`${groupId}:${epoch}`);
            if (answer.log === "too_large") {
              tooLarge.push(`${groupId}:${epoch}`);
            }
          }
          if (mismatched.length > 0) {
            this.#log("error", "history links differ from this device's", {
              channelId: rec.id,
              groupId,
              count: mismatched.length,
            });
            this.#ownerToast(rec, "history_mismatch", mismatched);
          }
          if (tooLarge.length > 0) {
            this.#ownerToast(rec, "history_too_large", tooLarge);
          }
        } finally {
          rec.ownerCheck = false;
        }
      })(),
    );
  }

  // -------------------------------------------------------------------------
  // S4 history: the walk (design 3.14.8; L1w `runWalk`)
  // -------------------------------------------------------------------------

  /** `TextChannelState.history_floor`, shape-checked; null when none. */
  #floorOf(
    n: TextChannelState,
  ): { groupId: string; epoch: number; stopped: string | null } | null {
    const f: unknown = n.history_floor;
    if (!isRecord(f) || !str(f.group_id) || f.group_id === "") return null;
    if (!int(f.epoch)) return null;
    return {
      groupId: f.group_id,
      epoch: f.epoch,
      stopped: str(f.stopped) ? f.stopped : null,
    };
  }

  /**
   * A4: remember `oldest_held` of an `unknown_epoch` a row decrypt of
   * `channelId` answered (native `message.rs` `unknown_epoch`: the first
   * epoch of this device's current membership run in that group; null
   * when it holds none). `#walkStart` reads it. Never throws.
   */
  #noteOldestHeld(channelId: unknown, err: unknown): void {
    try {
      const e = nativeErrorOf(err) as Record<string, unknown> | null;
      if (e === null || e.type !== "unknown_epoch") return;
      if (!str(channelId) || !str(e.group_id) || e.group_id === "") return;
      const rec = this.#channels.get(channelId);
      if (!rec) return;
      rec.oldestHeld.delete(e.group_id);
      if (!int(e.oldest_held)) return;
      rec.oldestHeld.set(e.group_id, e.oldest_held);
      if (rec.oldestHeld.size > OLDEST_HELD_MAX) {
        const first = rec.oldestHeld.keys().next().value;
        if (first !== undefined) rec.oldestHeld.delete(first);
      }
    } catch {
      // a refusal this cannot read starts no walk differently
    }
  }

  /**
   * R-W4-39: native refused the decrypt of `messageId` for a key it does
   * not hold. The group and epoch on record are the ones NATIVE named
   * (`unknown_epoch`; `mls_group_not_found` names a group only), never the
   * row's own `encrypted`. Any other answer, and a row sent after this
   * device's removal (`removed_self`), leaves no record. Never throws.
   */
  #noteRefused(messageId: unknown, err: unknown): void {
    try {
      if (!str(messageId) || messageId === "") return;
      this.#floorRefused.delete(messageId);
      const e = nativeErrorOf(err) as Record<string, unknown> | null;
      if (e === null || !str(e.group_id) || e.group_id === "") return;
      let epoch: number | null = null;
      if (e.type === "unknown_epoch") {
        if (e.removed_self === true || !int(e.epoch)) return;
        epoch = e.epoch;
      } else if (e.type !== "mls_group_not_found") {
        return;
      }
      this.#floorRefused.set(messageId, { groupId: e.group_id, epoch });
      if (this.#floorRefused.size > VIEW_CACHE_MAX) {
        const first = this.#floorRefused.keys().next().value;
        if (first !== undefined) this.#floorRefused.delete(first);
      }
    } catch {
      // a refusal this cannot read places no marker
    }
  }

  /**
   * R-W4-39: native decrypted `messageId`. It is no floor row any more,
   * and the floor marker may not stand above the oldest such row: one
   * raised above it is placed again, lower, when a row is there to place
   * it by. Never throws.
   */
  #noteDecrypted(channelId: unknown, messageId: unknown): void {
    try {
      if (!str(channelId) || !str(messageId)) return;
      this.#floorRefused.delete(messageId);
      const rec = this.#channels.get(channelId);
      const at = ulidTimeMs(messageId);
      if (!rec || at === null) return;
      if (rec.oldestOkMs !== null && rec.oldestOkMs <= at) return;
      rec.oldestOkMs = at;
      const raised = rec.floorMarker?.atMs ?? null;
      if (raised !== null && raised > at && !this.#disposed) {
        this.#placeFloor(rec);
      }
    } catch {
      // nothing is placed by an answer this cannot read
    }
  }

  /**
   * Where the walk for a missing epoch starts: the lowest held epoch above
   * it. A miss below the floor native reports (the bottom of the run an
   * earlier walk ended in), or in a group that is neither the floor's nor
   * the held one (reached through the chain only), starts AT the floor.
   * Any other miss below `oldest_held` of its group starts AT `oldest_held`
   * (A4: the first epoch of this device's current membership run, which
   * native named in the row's `unknown_epoch`): there is no floor before
   * the first walk, and a floor may be an older run below the gap. Only a
   * hole inside the held run is left to a guess, one above it, which
   * `runWalk` steps up while native refuses it. `"unknown"`: no state yet.
   * `"none"`: nothing to start from.
   */
  #walkStart(
    rec: ChannelRec,
    groupId: string,
    epoch: number,
  ): { groupId: string; holderEpoch: number } | "none" | "unknown" {
    const n = rec.native;
    if (n === null) return "unknown";
    const floor = this.#floorOf(n);
    if (floor !== null) {
      const below =
        groupId === floor.groupId
          ? epoch < floor.epoch
          : groupId !== n.group_id;
      if (below) return { groupId: floor.groupId, holderEpoch: floor.epoch };
    } else if (groupId !== n.group_id) {
      return "none";
    }
    const oldest = rec.oldestHeld.get(groupId);
    if (oldest !== undefined && epoch < oldest) {
      return { groupId, holderEpoch: oldest };
    }
    return { groupId, holderEpoch: epoch + 1 };
  }

  /** `epoch` of `groupId` lies below the stop a walk of this session found. */
  #belowFloor(rec: ChannelRec, groupId: string, epoch: number): boolean {
    const floor = rec.walkFloor;
    if (floor === null) return false;
    return groupId === floor.groupId
      ? epoch < floor.epoch
      : groupId !== (rec.native?.group_id ?? null);
  }

  /**
   * B4's `HistoryOps.requestWalk`: run (or join) the channel's history walk
   * for a missing epoch and answer only once a walk ENDED or has to be
   * retried later. One walk per channel at a time: a request that finds one
   * running waits for it, and starts its own only when that walk neither
   * brought its epoch nor stopped above it. `imported`: the key is there
   * now. `floor`: a walk ended without it, or none may run (the history
   * flag is off, R-W4-31: the row then gets its S2 marker instead of
   * waiting; the shell has no history commands, R-W4-33). `retry_later`:
   * nothing final.
   */
  async #requestWalk(
    channelId: string,
    groupId: string,
    epoch: number,
  ): Promise<WalkAnswer> {
    const rec = this.#channels.get(channelId);
    if (this.#disposed) return "retry_later";
    if (!this.#historyRuns()) return "floor";
    if (!rec) return "retry_later";
    const key = `${groupId}:${epoch}`;
    for (let round = 0; round < WALK_JOIN_ROUNDS; round++) {
      if (this.#noHistoryCommands) return "floor";
      if (this.#walked.has(key)) return "imported";
      if (this.#belowFloor(rec, groupId, epoch)) return "floor";
      let walk = rec.walk;
      let own = false;
      if (walk === null) {
        if (rec.native === null) await this.#readState(rec);
        // Another request may have started one while the state was read.
        walk = rec.walk;
        if (walk === null) {
          const start = this.#walkStart(rec, groupId, epoch);
          if (start === "unknown") return "retry_later";
          if (start === "none") return "floor";
          walk = this.#startWalk(rec, start);
          own = true;
        }
      }
      const end = await walk;
      if (end.kind === "unsupported") return "floor";
      if (end.kind === "retry_later") return "retry_later";
      if (this.#walked.has(key)) return "imported";
      if (own) return "floor";
    }
    return "retry_later";
  }

  /**
   * Start the channel's walk (callers checked none is running). The
   * promise never rejects; it settles after the result was applied.
   */
  #startWalk(
    rec: ChannelRec,
    start: { groupId: string; holderEpoch: number },
  ): Promise<WalkEnd> {
    rec.historyWalk = "running";
    this.#emit(rec);
    const signal = rec.historyCtl.signal;
    const run = (async (): Promise<WalkEnd> => {
      let result: WalkResult;
      try {
        result = await runWalk(this.#walkPorts(rec, signal), start);
      } catch {
        // `runWalk` never rejects; nothing is read into it if it does.
        result = {
          end: { kind: "retry_later", reason: "transport" },
          imported: [],
          refused: [],
        };
      }
      // C4: `walkHistory` takes a walk that could not finish up from here.
      rec.walkRetry = result.end.kind === "retry_later" ? start : null;
      try {
        await this.#afterWalk(rec, result);
      } catch (err) {
        if (!isDisposed(err)) {
          this.#log("warn", "history walk result not applied", {
            channelId: rec.id,
            type: viewTagOf(err),
          });
        }
      }
      return result.end;
    })();
    const done = run.finally(() => {
      if (rec.walk === done) rec.walk = null;
    });
    rec.walk = done;
    // Rows an earlier walk left pending are decided by this result.
    void done.then((end) => {
      if (end.kind !== "retry_later") this.#rerunPending(rec);
    });
    return done;
  }

  /** L1w's ports over the real courier, native and listing pin. */
  #walkPorts(rec: ChannelRec, signal: AbortSignal): WalkPorts {
    // Stored commit rows of this walk by `group:epoch`; null = none stored.
    const commits = new Map<string, unknown>();
    const alive = () => {
      if (signal.aborted) throw clientFailure("history_stopped");
    };
    return {
      links: async (groupId, before) => {
        if (signal.aborted) return "failed";
        return this.#linkPage(groupId, before, HISTORY_LINK_PAGE);
      },
      commit: async (groupId, epoch) => {
        alive();
        return this.#walkCommit(commits, groupId, epoch);
      },
      probeRows: async (groupId, epoch) => this.#probeRows(rec, groupId, epoch),
      importSteps: (groupId, session, steps) => {
        alive();
        return this.#enqueue(rec.id, () =>
          this.#invoke("e2ee_text_history_import", {
            groupId,
            session,
            steps,
          }),
        );
      },
      pin: async (userId, deviceId) =>
        (await this.#pinFor(userId, [deviceId])) === "answered",
      log: (level, msg, ids) => this.#log(level, msg, ids),
    };
  }

  /**
   * The stored commit row of `epoch` for the walk, or null when the server
   * holds none (pruned). The walk goes down and asks for h, then h - 1, so
   * a miss reads a window ending at `epoch` and keeps every row of it.
   * Each row passes `parseCommitInfo` (R-W4-7: a `created_at` that is not
   * a safe integer is left out, logged here); `runWalk` checks it again.
   * Rejects when the request failed: the walk then retries later.
   */
  async #walkCommit(
    cache: Map<string, unknown>,
    groupId: string,
    epoch: number,
  ): Promise<unknown> {
    const key = (e: number) => `${groupId}:${e}`;
    if (cache.has(key(epoch))) return cache.get(key(epoch)) ?? null;
    const window = Math.max(0, epoch - (WALK_COMMIT_WINDOW - 1));
    for (const from of window === epoch ? [epoch] : [window, epoch]) {
      const r = await this.#api(
        "GET",
        `/mls/groups/${encodeURIComponent(groupId)}/commits?from_epoch=${from}`,
      );
      if (r === null) throw { source: "transport" } satisfies TextFlowFailure;
      if (!is2xx(r.status)) throw serverFailure(r);
      const rows: unknown = isRecord(r.body) ? r.body.commits : null;
      if (!Array.isArray(rows)) throw clientFailure("history_commits_unread");
      let top = -1;
      for (const raw of rows) {
        const parsed = parseCommitInfo(raw);
        if (parsed === null || parsed.row.group_id !== groupId) {
          this.#log("error", "history walk: stored commit unreadable", {
            groupId,
          });
          continue;
        }
        if (parsed.droppedCreatedAt) {
          this.#log("error", "history walk: commit created_at dropped", {
            groupId,
            epoch: parsed.row.epoch,
          });
        }
        cache.set(key(parsed.row.epoch), parsed.row);
        top = Math.max(top, parsed.row.epoch);
      }
      // The page ascends from `from`. Once it reached `epoch` (or is
      // empty), an epoch it passed without a row has none stored.
      if (rows.length === 0 || top >= epoch) {
        for (let e = from; e <= epoch; e++) {
          if (!cache.has(key(e))) cache.set(key(e), null);
        }
        break;
      }
    }
    return cache.get(key(epoch)) ?? null;
  }

  /**
   * Probe candidates of one walk step: the encrypted rows of that group and
   * epoch among the rows this channel has loaded (no extra message fetch in
   * S4a). L1w picks at most 3, from distinct authors, none a writer of the
   * step above; fewer or none is fine.
   */
  #probeRows(rec: ChannelRec, groupId: string, epoch: number): ProbeSource[] {
    const out: ProbeSource[] = [];
    for (const row of this.#rows.values()) {
      const e = row.encrypted;
      if (row.channelId !== rec.id || e === null) continue;
      if (e.group_id !== groupId || e.epoch !== epoch) continue;
      out.push({
        id: row.id,
        authorId: row.authorId,
        nonce: row.nonce,
        encrypted: e,
      });
    }
    return out;
  }

  /**
   * Apply a walk result: remember what was imported, re-read the native
   * state (its floor, and the policy if it moved), raise the floor marker
   * of a stop, publish `historyWalk`, and decrypt again the rows whose
   * epochs arrived.
   */
  async #afterWalk(rec: ChannelRec, result: WalkResult): Promise<void> {
    const held = rec.native?.group_id ?? null;
    for (const ref of result.imported) {
      this.#noteWalked(rec, ref.group_id, ref.epoch, held);
    }
    if (result.imported.length > 0 && this.#historyOn()) {
      this.#countEpochs(result.imported.length);
    }
    await this.#readState(rec);
    const end = result.end;
    if (end.kind === "unsupported") {
      // R-W4-33: nothing to retry in this shell; no floor marker either
      // (nothing was walked), the rows get their S2 markers.
      rec.historyWalk = "idle";
      this.#latchNoHistoryCommands("e2ee_text_history_import");
    } else if (end.kind === "retry_later") {
      // Retried only by the next `walkHistory` or the next paging that
      // needs it: no timer.
      rec.historyWalk = "retry_later";
      this.#log("info", "history walk to be retried", {
        channelId: rec.id,
        reason: end.reason,
      });
    } else {
      rec.historyWalk = "idle";
      if (end.kind === "stopped") {
        this.#noteFloor(
          rec,
          end.stop,
          end.floor === null
            ? null
            : { groupId: end.floor.group_id, epoch: end.floor.epoch },
        );
      }
    }
    this.#emit(rec);
    if (result.imported.length > 0) {
      this.#redecryptImported(rec, result.imported);
    }
  }

  #noteWalked(
    rec: ChannelRec,
    groupId: string,
    epoch: number,
    held: string | null,
  ): void {
    this.#walked.add(`${groupId}:${epoch}`);
    if (this.#walked.size > WALKED_MAX) {
      const oldest = this.#walked.values().next().value;
      if (oldest !== undefined) this.#walked.delete(oldest);
    }
    if (groupId !== held) this.#notePredecessor(rec, groupId);
  }

  /** A group native reached below the held one in a walk of this channel. */
  #notePredecessor(rec: ChannelRec, groupId: string): void {
    const known = this.#predecessors.get(rec.id);
    if (known) known.add(groupId);
    else this.#predecessors.set(rec.id, new Set([groupId]));
  }

  /**
   * A walk stopped: remember the floor and raise the `history_floor`
   * timeline marker. There is one per channel; a later stop replaces it
   * only when it is lower (another group, or a lower epoch of the same
   * one) or gives another reason for the same floor. A stop this build
   * does not know is passed on as it came and reads loud (L1s
   * `historyFloorNotice`). Where and when the marker is raised is
   * `#placeFloor`'s (R-W4-32).
   */
  #noteFloor(
    rec: ChannelRec,
    stop: HistoryStop,
    reported: { groupId: string; epoch: number } | null,
  ): void {
    const native = rec.native === null ? null : this.#floorOf(rec.native);
    const floor =
      reported ??
      (native === null
        ? null
        : { groupId: native.groupId, epoch: native.epoch });
    const loud = historyFloorNotice(stop).tone === "loud";
    if (floor === null) {
      this.#log("error", "history walk stopped without a floor", {
        channelId: rec.id,
      });
      return;
    }
    this.#log(loud ? "error" : "info", "history walk stopped", {
      channelId: rec.id,
      groupId: floor.groupId,
      epoch: floor.epoch,
      loud,
    });
    rec.walkFloor = floor;
    if (floor.groupId !== (rec.native?.group_id ?? null)) {
      this.#notePredecessor(rec, floor.groupId);
    }
    const last = rec.floorMarker;
    if (
      last !== null &&
      last.groupId === floor.groupId &&
      (floor.epoch > last.epoch ||
        (floor.epoch === last.epoch && last.stop === stop))
    ) {
      return;
    }
    rec.floorMarker = { ...floor, stop, atMs: null };
    this.#placeFloor(rec);
  }

  /**
   * The keys native refused a row for lie at or below the floor `m` of
   * `rec` (R-W4-32). `epoch` null: native named the group only.
   */
  #atOrBelowFloor(
    rec: ChannelRec,
    m: { groupId: string; epoch: number },
    groupId: string,
    epoch: number | null,
  ): boolean {
    if (groupId === m.groupId) return int(epoch) && epoch <= m.epoch;
    // Another group: the held one and the ones a walk passed on its way
    // down are above the floor; one no walk reached is below it.
    if (groupId === (rec.native?.group_id ?? null)) return false;
    return this.#predecessors.get(rec.id)?.has(groupId) !== true;
  }

  /**
   * R-W4-32: raise the channel's `history_floor` marker where the list can
   * place it: `atMs` is the ULID time of the newest loaded row at or below
   * the floor epoch, plus 1 ms, so the marker sorts directly after that
   * row. While no such row is loaded the marker is not raised; it is when
   * one arrives (`#decryptOne`, `decryptHistory`), and it is raised again,
   * later, when a newer such row is loaded (the list places the latest
   * floor marker only). Never the wall clock: that would sort it under the
   * newest message. `only`: look at this one row instead of every row.
   *
   * R-W4-39: a row counts only by what NATIVE answered for it: its decrypt
   * was refused for a key native does not hold, and the group and epoch
   * native named lie at or below the floor (`#floorRefused`). The row's
   * own `encrypted` is the server's claim and places nothing: one made-up
   * row with a late id would pin the marker under the newest messages. An
   * epoch a walk brought since is no floor row either. And the marker
   * never stands above the oldest row native decrypted (`oldestOkMs`): a
   * row at or after it is not counted, and a marker raised above it
   * earlier is placed again, lower.
   */
  #placeFloor(rec: ChannelRec, only?: ProtectedMessageRow): void {
    const m = rec.floorMarker;
    if (m === null) return;
    const cap = rec.oldestOkMs;
    let newest: number | null = null;
    for (const row of only ? [only] : this.#rows.values()) {
      if (row.channelId !== rec.id) continue;
      const refused = this.#floorRefused.get(row.id);
      if (refused === undefined) continue;
      if (this.#walked.has(`${refused.groupId}:${refused.epoch}`)) continue;
      if (!this.#atOrBelowFloor(rec, m, refused.groupId, refused.epoch)) {
        continue;
      }
      const at = ulidTimeMs(row.id);
      if (at === null || (cap !== null && at >= cap)) continue;
      if (newest === null || at > newest) newest = at;
    }
    if (newest === null) return;
    const atMs = newest + 1;
    // Moved up by a newer row; moved down only from above the cap.
    const tooHigh = m.atMs !== null && cap !== null && m.atMs > cap;
    if (m.atMs !== null && atMs <= m.atMs && !tooHigh) return;
    if (atMs === m.atMs) return;
    m.atMs = atMs;
    this.#marker(rec, {
      kind: "history_floor",
      channelId: rec.id,
      groupId: m.groupId,
      epoch: m.epoch,
      stop: m.stop,
      atMs,
    });
  }

  /**
   * Rows whose view is a marker for a key that was missing, and whose
   * epoch a walk just imported: decrypt them again (never a live view:
   * native's live-only checks ran on that one).
   */
  #redecryptImported(
    rec: ChannelRec,
    imported: readonly { group_id: string; epoch: number }[],
  ): void {
    const got = new Set(imported.map((r) => `${r.group_id}:${r.epoch}`));
    const batch = newWalkBatch();
    for (const [id, view] of [...this.#views]) {
      if (view.status !== "marker" || this.#viewLive.has(id)) continue;
      const row = this.#rows.get(id);
      const e = row?.encrypted ?? null;
      if (!row || row.channelId !== rec.id || e === null) continue;
      if (!got.has(`${e.group_id}:${e.epoch}`)) continue;
      this.#views.delete(id);
      this.#background(this.#decryptOne(row, false, false, batch));
    }
  }

  /** Decrypt again the rows of `rec` a walk left pending. */
  #rerunPending(rec: ChannelRec): void {
    if (this.#disposed) return;
    const batch = newWalkBatch();
    for (const [id, entry] of [...this.#walkPending]) {
      if (entry.row.channelId !== rec.id) continue;
      this.#walkPending.delete(id);
      this.#background(this.#decryptOne(entry.row, entry.live, false, batch));
    }
  }

  // -------------------------------------------------------------------------
  // S4 history: the policy callback and the row views (design 9.5)
  // -------------------------------------------------------------------------

  /** The local pin's history record, as the bridge's dep answers it. */
  #pinHistory(channelId: string): { boundary: string; wiped: boolean } | null {
    const deps = this.#deps as Partial<ProtectedTextHistoryDeps>;
    if (typeof deps.pinHistory !== "function") return null;
    // Handed on unchecked: B4's `plainRowInput` refuses a malformed answer.
    return deps.pinHistory(channelId) ?? null;
  }

  /**
   * The SDK's conflict and wipe latches for the channel. Without the dep
   * they are unknown, which is answered as conflicted: every row without
   * `encrypted` then stays red (R-W4-26).
   */
  #preHistoryState(channelId: string): { conflicted: boolean; wiped: boolean } {
    const deps = this.#deps as Partial<ProtectedTextHistoryDeps>;
    if (typeof deps.preHistoryState !== "function") {
      if (!this.#preStateMissingLogged) {
        this.#preStateMissingLogged = true;
        this.#log("error", "pre-history state unavailable: rows stay red", {});
      }
      return { conflicted: true, wiped: false };
    }
    return deps.preHistoryState(channelId);
  }

  /**
   * The state native just answered is NOT verified, for a reason native
   * itself gave: its verdict is `owner_changed`, or the last list verify
   * was one of the loud refusals. Every other way to be "not verified" (no
   * list held yet or any more, as while joining or rejoining; a verify that
   * could not run; a list that is only behind; a verdict this build does
   * not know) is not known to be one.
   */
  #knownUnverified(rec: ChannelRec, n: TextChannelState): boolean {
    if (n.verdict === "owner_changed") return true;
    const error = rec.seatListError;
    return (
      error !== null &&
      (SHIELD_LOUD_SEAT_LIST_ERRORS as readonly string[]).includes(error)
    );
  }

  /**
   * After a native state read that succeeded (the only caller is
   * `#readStateDirect`'s success path): report the history policy when it
   * changed, then have the row views that rest on it decided again.
   *
   * The policy is `nativeHistoryInput` of exactly what the row policy
   * reads, so the two cannot disagree. `verified: false` goes out ONLY
   * when native is known not to be verified (`#knownUnverified`): after a
   * reveal the bridge answers it by stripping the channel for the session,
   * so a state that is merely not usable right now reports nothing and the
   * last report stands.
   *
   * R-W4-31: the server's history flag is NOT read here. It is server
   * controlled and reads off after a failed fetch; gating this on it would
   * keep a reveal and the cached plain views alive after native withdrew
   * what they rest on (owner changed, a loud verify failure, a wipe). The
   * flag also never reports by itself: only a state read gets here.
   */
  #syncHistory(rec: ChannelRec): void {
    const n = rec.native;
    const input = nativeHistoryInput(n, { seatListError: rec.seatListError });
    if (n === null || input === null) return;
    if (input.verified || this.#knownUnverified(rec, n)) {
      const policy = {
        verified: input.verified,
        boundary: input.boundary,
        preHistory: input.preHistory,
        timeLimit: input.timeLimit,
      };
      const sent = JSON.stringify(policy);
      if (sent !== rec.policySent) {
        rec.policySent = sent;
        try {
          this.#cb.onHistoryPolicy(rec.id, policy);
        } catch {
          this.#log("error", "onHistoryPolicy threw", { channelId: rec.id });
        }
      }
    }
    // After the callback: the bridge may just have moved the pin or the
    // SDK's latches, and the rows are decided on what holds now.
    let pin: unknown = null;
    let pre: unknown = null;
    try {
      pin = this.#pinHistory(rec.id);
      pre = this.#preHistoryState(rec.id);
    } catch {
      pin = "unread";
    }
    const inputs = JSON.stringify([input, pin, pre]);
    if (inputs === rec.rowInputs) return;
    rec.rowInputs = inputs;
    this.#redecideRows(rec);
  }

  #historyEpochKey(rec: ChannelRec): string {
    return this.#historyEpochKeyOf(rec.id);
  }

  #historyEpochKeyOf(channelId: string): string {
    return `${PROTECTED_HISTORY_EPOCH_KEY_PREFIX}${this.#port.selfUserId}:${channelId}`;
  }

  /** The stored line of `groupId` (B6), null when none or unreadable. */
  #storedHistoryLine(rec: ChannelRec, groupId: string): string | null {
    try {
      const v: unknown = JSON.parse(
        this.#port.store.get(this.#historyEpochKey(rec)) ?? "null",
      );
      if (!isRecord(v) || v.g !== groupId) return null;
      return v.s === "visible" || v.s === "hidden" ? v.s : null;
    } catch {
      return null;
    }
  }

  /**
   * B6 (design 6.3, 3.14.3), after a native state read that succeeded: the
   * held list's `history` line differs from the one the current epoch
   * began under, so this device commits ONE self-Update and the next epoch
   * starts under the new setting. It covers every way the list can change
   * under this device: `setHistoryVisible`, a flow that rejected after its
   * list landed, a stored publish another owner action finished, and (the
   * line is stored) a change that landed just before a restart.
   *
   * Only on a device of the owner user, only for a list THIS device
   * signed (one committer, not one per owner device), and only while the
   * history flag is on (an Update is a write, R-W4-31).
   *
   * R-W4-41. The line an epoch began under goes on record (in memory)
   * BEFORE those gates: a read while the flag reads off, or before the
   * owner pin is there, would otherwise leave the epoch to be first seen
   * under the new line, and the Update would be skipped. The stored copy
   * is a write and stays behind the flag and the owner gate; it is written
   * whenever the store does not hold this group and line (a new group
   * too). An Update that failed is started again on a later state read, at
   * most `HISTORY_UPDATE_TRIES` times per `group:epoch:setting` in a
   * session, and never while another Update of the channel is in flight
   * (that one would swallow it). Never a loop: an Update's own state reads
   * start none, the Update it commits moves the epoch, and the new epoch
   * is on record under the new line. Called inside the channel's lane, so
   * the Update runs in the background.
   */
  #historyUpdateOwed(rec: ChannelRec): void {
    const n = rec.native;
    if (n === null || n.group_id === null || !int(n.epoch)) return;
    const groupId = n.group_id;
    const setting =
      n.history_setting === "visible" || n.history_setting === "hidden"
        ? n.history_setting
        : null;
    let seen = rec.historyEpoch;
    if (seen === null || seen.groupId !== groupId || seen.epoch !== n.epoch) {
      // A new epoch began under the list held now. The first read of a
      // session cannot tell, so it takes the line an earlier one stored.
      const first = seen === null;
      const stored = first ? this.#storedHistoryLine(rec, groupId) : null;
      if (stored !== null) rec.historyLineKept = `${groupId}:${stored}`;
      seen = { groupId, epoch: n.epoch, setting: stored ?? setting };
      rec.historyEpoch = seen;
    } else if (seen.setting === null && setting !== null) {
      seen.setting = setting;
    }
    if (!this.#historyOn() || !this.#ownerDevice(rec)) return;
    const began = seen.setting;
    if (began !== null) this.#keepHistoryLine(rec, groupId, began);
    if (n.seat_list === null) return;
    if (setting === null || seen.setting === null) return;
    if (seen.setting === setting) return;
    const list = n.seat_list;
    if (
      list.signer_user_id !== this.#port.selfUserId ||
      list.signer_device_id !== this.#port.selfDeviceId
    ) {
      return;
    }
    if (!holdsCurrentGroup(n)) return;
    // Not counted and not started behind another Update or its own.
    if (rec.historyUpdateBusy || rec.updating !== null) return;
    const key = `${groupId}:${n.epoch}:${setting}`;
    const tried = rec.historyUpdateTries.get(key) ?? 0;
    if (tried >= HISTORY_UPDATE_TRIES) return;
    rec.historyUpdateTries.delete(key);
    rec.historyUpdateTries.set(key, tried + 1);
    if (rec.historyUpdateTries.size > HISTORY_UPDATE_STATES_MAX) {
      const first = rec.historyUpdateTries.keys().next().value;
      if (first !== undefined) rec.historyUpdateTries.delete(first);
    }
    this.#log(
      tried + 1 < HISTORY_UPDATE_TRIES ? "info" : "warn",
      "history setting changed: own update",
      { channelId: rec.id, attempt: tried + 1 },
    );
    rec.historyUpdateBusy = true;
    this.#background(
      this.#commitUpdate(rec, true).finally(() => {
        rec.historyUpdateBusy = false;
      }),
    );
  }

  /** Store the line of `groupId` unless the store is known to hold it. */
  #keepHistoryLine(rec: ChannelRec, groupId: string, line: string): void {
    const kept = `${groupId}:${line}`;
    if (rec.historyLineKept === kept || this.#historyLinesOff) return;
    const ok = this.#port.store.set(
      this.#historyEpochKey(rec),
      JSON.stringify({ g: groupId, s: line }),
    );
    if (ok) {
      rec.historyLineKept = kept;
    } else {
      this.#log("warn", "history line not stored", { channelId: rec.id });
    }
  }

  /**
   * Remember a row (probes, pending re-runs, re-decided views, the floor
   * marker's place once native answered for it).
   */
  #noteRow(row: ProtectedMessageRow): void {
    this.#rows.delete(row.id);
    this.#rows.set(row.id, row);
    if (this.#rows.size > VIEW_CACHE_MAX) {
      const oldest = this.#rows.keys().next().value;
      if (oldest !== undefined) this.#rows.delete(oldest);
    }
  }

  /**
   * The cached view of a row as it holds now (B4 `redecide` over
   * `plainRowInput` read now): the view itself, the `ok` view with the
   * below-boundary note added (that note is only ever added, so the row is
   * not decrypted again for it), or null when the row has to go through
   * `decryptRow` again.
   */
  #currentView(
    row: ProtectedMessageRow,
    view: ProtectedMessageView,
  ): ProtectedMessageView | null {
    const input = plainRowInput(this.#rowOps, row.channelId, row.id);
    if (!redecide(view, input)) return view;
    if (view.status !== "ok") {
      this.#views.delete(row.id);
      return null;
    }
    const noted: ProtectedMessageView = { ...view, belowBoundary: true };
    this.#views.set(row.id, noted);
    return noted;
  }

  /**
   * The native state, the pin or the SDK's latches of `rec` changed: every
   * cached view of its rows that no longer holds is decided again. A row
   * without `encrypted` costs no native call.
   */
  #redecideRows(rec: ChannelRec): void {
    for (const [id, view] of [...this.#views]) {
      const row = this.#rows.get(id);
      if (!row || row.channelId !== rec.id) continue;
      const next = this.#currentView(row, view);
      if (next === view) continue;
      if (next !== null) {
        this.#setMessageView(id, next);
        continue;
      }
      this.#background(this.#decryptOne(row, this.#viewLive.has(id)));
    }
  }

  #enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#lanes.get(key) ?? Promise.resolve();
    const run = prev.then(() => {
      this.#checkAlive();
      return fn();
    });
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.#lanes.set(key, tail);
    void tail.then(() => {
      if (this.#lanes.get(key) === tail) this.#lanes.delete(key);
    });
    return run;
  }

  #invoke<C extends TextCommand>(
    cmd: C,
    args: TextCommandArgs[C],
  ): Promise<TextCommandResult[C]> {
    this.#checkAlive();
    return this.#gatedInvoke(cmd, args);
  }

  /**
   * S7 C9 (EL-F7 / AND-F13): one native text command through the protector
   * gate. While the gate is open this is `port.invoke`. After a `protector`
   * refusal nothing is issued until the back-off window ends; then ONE
   * waiting command probes and the others wait for its answer. A refused
   * command is never surfaced: native refuses at the store open, before the
   * command runs, so it waits and is re-issued (a decrypt stays pending,
   * an envelope stays queued unacked). Waits end on dispose.
   */
  async #gatedInvoke<C extends TextCommand>(
    cmd: C,
    args: TextCommandArgs[C],
  ): Promise<TextCommandResult[C]> {
    for (;;) {
      const step = protectorGateStep(
        this.#protector,
        this.#port.now(),
        this.#protectorProbe !== null,
      );
      if (step.kind === "wait_probe") {
        await this.#protectorProbe;
        this.#checkAlive();
        continue;
      }
      if (step.kind === "wait") {
        await this.#sleep(step.waitMs);
        continue;
      }
      const issued = this.#protector.failures;
      const probe = step.probe ? deferred() : null;
      if (probe) this.#protectorProbe = probe.promise;
      try {
        const out = await this.#port.invoke(cmd, args);
        this.#protectorAnswer("ok", issued, cmd);
        return out;
      } catch (err) {
        if (!isProtectorError(err)) {
          this.#protectorAnswer("other", issued, cmd);
          throw err;
        }
        this.#protectorAnswer("protector", issued, cmd);
      } finally {
        if (probe) {
          this.#protectorProbe = null;
          probe.resolve();
        }
      }
    }
  }

  /** Apply one answer to the gate; logs only when the gate changes. */
  #protectorAnswer(
    answer: ProtectorAnswer,
    issued: number,
    cmd: TextCommand,
  ): void {
    const before = this.#protector.failures;
    const now = this.#port.now();
    this.#protector = protectorGateAfter(this.#protector, answer, issued, now);
    const after = this.#protector.failures;
    if (after > before) {
      this.#log("warn", "protector refused, text commands held", {
        command: cmd,
        failures: after,
        waitMs: this.#protector.untilMs - now,
      });
    } else if (before > 0 && after === 0) {
      this.#log("info", "protector back-off cleared", { command: cmd });
    }
  }

  /** The courier answer, or null on a transport failure (never thrown). */
  async #api(
    method: TextApiMethod,
    path: string,
    body?: unknown,
  ): Promise<TextApiResponse | null> {
    this.#checkAlive();
    let r: TextApiResponse;
    try {
      r =
        body === undefined
          ? await this.#port.api(method, path)
          : await this.#port.api(method, path, body);
    } catch {
      this.#checkAlive();
      return null;
    }
    this.#checkAlive();
    return r;
  }

  async #ack(ids: string[]): Promise<void> {
    const real = ids.filter((id) => !isSynthTextEnvelopeId(id));
    if (real.length === 0) return;
    try {
      await this.#port.ack(real);
    } catch {
      this.#log("warn", "ack failed", { count: real.length });
    }
  }

  #markSeen(id: string): void {
    this.#queued.delete(id);
    this.#holds.delete(id);
    if (isSynthTextEnvelopeId(id)) return;
    this.#seen.add(id);
    if (this.#seen.size > SEEN_MAX) {
      const oldest = this.#seen.values().next().value;
      if (oldest !== undefined) this.#seen.delete(oldest);
    }
  }

  async #sleep(ms: number): Promise<void> {
    this.#checkAlive();
    if (ms > 0) {
      try {
        await this.#port.sleep(ms, this.#abort.signal);
      } catch {
        // aborted: reported by the alive check below
      }
    }
    this.#checkAlive();
  }

  #checkAlive(): void {
    if (this.#disposed) throw DISPOSED;
  }

  #log(
    level: "debug" | "info" | "warn" | "error",
    msg: string,
    ids: TextLogIds,
  ): void {
    try {
      this.#port.log(level, `[protected] ${msg}`, ids);
    } catch {
      // logging must never break a flow
    }
  }

  /** Fire-and-forget with logged failures (disposal is silent). */
  #background(p: Promise<unknown>): void {
    p.catch((err: unknown) => {
      if (isDisposed(err)) return;
      this.#log("warn", "background task failed", { type: viewTagOf(err) });
    });
  }
}
