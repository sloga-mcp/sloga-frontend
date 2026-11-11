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
 * through the narrow `GroupOps` surface; this file never imports them.
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
} from "./e2ee";
import {
  isSynthTextEnvelopeId,
  textEnvelopeFromCommitInfo,
  toWireEnvelope,
} from "./protectedRouter.ts";
import { SHIELD_LOUD_GROUP_ERRORS } from "./protectedShield.ts";
import { textGroupId, TextIdIndex } from "./protectedTextIds.ts";
import {
  type ProtectorAnswer,
  type ProtectorGate,
  type SendAction,
  type SendContext,
  type SendTrigger,
  type SubmitAction,
  type SubmitContext,
  classifySendAnswer,
  classifySubmit,
  classifyTextEnvelopeError,
  errorTypeOf,
  isCatchUpDesync,
  isProtectorError,
  JOIN_RETRIES,
  JOIN_RETRY_MS,
  leafStaggerMs,
  PROTECTOR_GATE_OPEN,
  protectorGateAfter,
  protectorGateStep,
  publishBackoffMs,
  REFRESH_INTERVAL_MS,
  retryAfterMs,
} from "./protectedTextPolicy.ts";
import type {
  GroupOps,
  ManagerState,
  NativeError,
  NativeErrorTag,
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
  TextApiMethod,
  TextApiResponse,
  TextChannelState,
  TextCommand,
  TextCommandArgs,
  TextCommandResult,
  TextCommitInfo,
  TextEnvelope,
  TextFlowFailure,
  TextGroupCreated,
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
 * the step-6 commit checks of 3.12.3) plus `seat_list_rollback` (the same
 * AD pre-check; loud through step 3b). A benign tag (`mls_poisoned_epoch`
 * from the next envelope of the poisoned group, a dropped duplicate) never
 * overwrites one and a processed `duplicate` / `commit_applied` never
 * clears one; only joining a HIGHER generation of the channel does (a
 * `welcome_joined` into the successor, or this device's own successor
 * create accepted by the server, D21). `owner_changed` is not sticky: it
 * has its own defined reset (the D15 owner-change confirm), and native's
 * `owner_changed` verdict keeps step 3 loud until then.
 */
export const STICKY_GROUP_ERRORS: readonly NativeErrorTag[] = [
  ...SHIELD_LOUD_GROUP_ERRORS.filter((t) => t !== "owner_changed"),
  "seat_list_rollback",
];

/**
 * W4d X#3: re-GETs of `.../seats` when the snapshot under verify is older
 * than the held group epoch and native answers `seat_list_rollback` (the
 * snapshot is stale, never a rollback). Past this the answer is dropped.
 */
export const STALE_SEATS_REFETCH_BUDGET = 2;

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

/** Callback extras (optional): D12 replenish after this device's Welcome. */
export interface ProtectedTextManagerExtraCallbacks {
  onWelcomeJoined(channelId: string, groupId: string): void;
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
  return body as unknown as ProtectedSeatsResponse;
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
}

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
  welcomeRetriesExhausted: boolean;
  ownerChangePending: boolean;
  recreateAvailable: boolean;
  publishInFlight: boolean;
  maybeUnsent: boolean;
  /** The server stripped the flag of this pinned channel (D1). */
  stripped: boolean;
  /** Envelopes parked behind an owner change, in arrival order (D15). */
  parked: TextWireEnvelope[];
  openCtl: AbortController | null;
  join: JoinState | null;
  /** `text_group.current_epoch` when this device last sent a join intent. */
  joinFromEpoch: number | null;
  refreshing: Promise<void> | null;
  refreshAgain: boolean;
  removalInFlight: boolean;
  /** The in-flight Update; later callers await it (W4b audit M1). */
  updating: Promise<void> | null;
  successorInFlight: boolean;
  /** The in-flight re-run of an unaccepted create (D21 crash recovery). */
  recreating: Promise<void> | null;
  seeded: boolean;
}

type ProcessResult = "ok" | "held" | "parked" | "dropped";

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
      <C extends TextCommand>(cmd: C, args: TextCommandArgs[C]) =>
        this.#gatedInvoke(cmd, args),
    );
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
      if (rec.join) rec.join.cancelled = true;
    }
    this.#firstSightQueue.length = 0;
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
    // Opening is the manual retry of a stalled join (design 9.1 6d).
    rec.welcomeRetriesExhausted = false;
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

  async protect(
    channelId: string,
    seats: string[],
    deviceCap: number,
  ): Promise<void> {
    // PA#11f: the id index holds the channel before any `_group_create`.
    const rec = await this.#register(channelId);
    rec.publishInFlight = true;
    this.#emit(rec);
    try {
      await this.#deps.owner.protect(
        this,
        this.#flowPort,
        channelId,
        seats,
        deviceCap,
      );
    } finally {
      rec.publishInFlight = false;
      this.#emit(rec);
    }
    this.#background(this.refresh(channelId, "commit"));
  }

  async setSeats(
    channelId: string,
    seats: string[],
    deviceCap: number,
  ): Promise<void> {
    const rec = await this.#register(channelId);
    rec.publishInFlight = true;
    this.#emit(rec);
    try {
      await this.#deps.owner.setSeats(
        this,
        this.#flowPort,
        channelId,
        seats,
        deviceCap,
      );
    } finally {
      rec.publishInFlight = false;
      this.#emit(rec);
    }
    this.#background(this.refresh(channelId, "commit"));
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
    this.#background(
      (async () => {
        for (const row of rows) {
          if (row.channelId !== channelId) continue;
          await this.#decryptOne(row, false);
        }
      })(),
    );
  }

  /**
   * `own`: the delivered row of this device's own send (X#4). Its native
   * decrypt runs with `live: false`; a successful result also answers the
   * live echo of that id, so the echo costs no second decrypt.
   */
  async #decryptOne(
    row: ProtectedMessageRow,
    live: boolean,
    own = false,
  ): Promise<void> {
    if (this.#disposed) return;
    if (this.#forgotten.has(row.id)) return;
    const cached = this.#views.get(row.id);
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
        this,
        this.#flowPort,
        row,
        live,
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
    // A late history result never overwrites a live one.
    if (!live && this.#viewLive.has(row.id)) return;
    if (live || (own && view.status === "ok")) this.#viewLive.add(row.id);
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
    if (n && n.state === "active" && (n.update_due || n.update_required)) {
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
    if (rec.join) return rec.join.promise;
    await this.#readState(rec);
    const n = rec.native;
    if (
      n &&
      n.state === "active" &&
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
    let created: TextGroupCreated;
    try {
      created = await this.#enqueue(rec.id, () =>
        this.#invoke("e2ee_text_group_create", {
          channelId,
          userId: this.#port.selfUserId,
          supersedes,
        }),
      );
    } catch (err) {
      throw toFailure(err);
    }
    for (let failures = 0; ; failures++) {
      const r = await this.#api("POST", "/mls/groups", created.payload);
      if (r !== null && is2xx(r.status)) break;
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

  /** D8 refresh; concurrent calls coalesce. Never rejects (logs). */
  refresh(channelId: string, reason: TextRefreshReason): Promise<void> {
    return this.#register(channelId).then((rec) => {
      if (rec.refreshing) {
        rec.refreshAgain = true;
        return rec.refreshing;
      }
      const run = (async () => {
        try {
          do {
            rec.refreshAgain = false;
            await this.#refreshOnce(rec, reason);
          } while (rec.refreshAgain && !this.#disposed);
        } catch (err) {
          if (!isDisposed(err)) {
            this.#log("warn", "refresh failed", {
              channelId,
              reason,
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
    // D15: re-run GET .../seats + _seat_list_verify, then reprocess.
    await this.refresh(channelId, "owner_confirmed");
    const parked = rec.parked.splice(0);
    await this.#enqueue(rec.id, async () => {
      for (let i = 0; i < parked.length; i++) {
        const r = await this.#processWire(rec, parked[i], 0);
        if (r === "parked") {
          // Re-parked (a later owner change): keep the rest behind it.
          rec.parked.push(...parked.slice(i + 1));
          return;
        }
      }
    });
    this.#emit(rec);
  }

  async recreateGroup(channelId: string): Promise<void> {
    const rec = await this.#register(channelId);
    const supersedes =
      rec.serverGroup?.group_id ?? rec.native?.group_id ?? null;
    await this.createGroup(channelId, supersedes);
    rec.welcomeRetriesExhausted = false;
    rec.recreateAvailable = false;
    rec.signerLeafMissingRetries = 0;
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

  async #processWire(
    laneRec: ChannelRec | null,
    wire: TextWireEnvelope,
    depth: number,
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
    await this.#ensureOwnPins(false);
    let pinRetried = false;
    for (;;) {
      let out: TextProcessOutcome;
      try {
        out = await this.#invoke("e2ee_text_process", {
          envelope: wire,
          userId: this.#port.selfUserId,
        });
      } catch (err) {
        const verdict = classifyTextEnvelopeError(err);
        const native = nativeErrorOf(err);
        if (
          verdict.action === "pin_identities_retry" &&
          !pinRetried &&
          native?.type === "identity_pin_required"
        ) {
          // D18: pin that user's listing and retry ONCE.
          pinRetried = true;
          await this.#pinFor(native.user_id, [native.device_id]);
          continue;
        }
        const rec = laneRec ?? this.#recForGroup(wire.group_id);
        const tag = viewTagOf(err);
        this.#log("warn", "process failed", { ...ids, type: tag });
        this.#recordGroupError(rec, verdict.groupError, tag, wire.group_id);
        if (verdict.ack) {
          await this.#ack([wire.id]);
          this.#markSeen(wire.id);
        }
        return this.#envelopeAction(rec, wire, verdict.action, depth);
      }
      if (!synth) await this.#ack([wire.id]);
      this.#markSeen(wire.id);
      await this.#onOutcome(out);
      return "ok";
    }
  }

  async #envelopeAction(
    rec: ChannelRec | null,
    wire: TextWireEnvelope,
    action: ReturnType<typeof classifyTextEnvelopeError>["action"],
    depth: number,
  ): Promise<ProcessResult> {
    const ids = { groupId: wire.group_id, envelopeId: wire.id };
    switch (action) {
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
        if (rec) this.#background(this.ensureJoined(rec.id));
        return "dropped";
      case "signer_leaf_missing_retry":
        // The joiner discards the Welcome; its join loop retries the intent.
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
  async #onOutcome(out: TextProcessOutcome): Promise<void> {
    const rec =
      this.#channels.get(out.channel_id) ?? this.#recForGroup(out.group_id);
    if (!rec) return;
    this.#clearGroupError(rec, out);
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
    if (out.kind === "welcome_joined") {
      rec.signerLeafMissingRetries = 0;
      rec.welcomeRetriesExhausted = false;
      rec.recreateAvailable = false;
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
    this.#emit(rec);
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
      if (fresh) rec.seats = fresh;
    }
    if (groupRes !== null && is2xx(groupRes.status)) {
      const g = parseTextGroup(groupRes.body);
      if (g) {
        rec.serverGroup = g;
        rec.serverGroupMissing = false;
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
    const args: TextCommandArgs["e2ee_text_seat_list_verify"] = {
      channelId: rec.id,
      list: {
        body: list.body,
        signature: list.signature,
        signer_user_id: list.signer_user_id,
        signer_device_id: list.signer_device_id,
      },
      handovers: Array.isArray(list.handovers) ? list.handovers : [],
      serverOwnerId: owner,
      asOfEpoch: withAsOf ? seats.as_of_epoch : null,
      asOfGroupId: withAsOf ? seats.as_of_group_id : null,
    };
    try {
      await this.#enqueue(rec.id, () =>
        this.#invoke("e2ee_text_seat_list_verify", args),
      );
      rec.seatListError = null;
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
              if (next) rec.seats = next;
              if (next?.list) {
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
    // D21 successor: native poisoned, this device signed the current list,
    // and the server still names the poisoned group as open.
    if (
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
    const holds =
      g !== null &&
      n.group_id === g.group_id &&
      (n.state === "active" || n.state === "poisoned");
    const seated = n.self_seated && n.seat_list?.seats.includes(self) === true;
    // Joining the server's older group would only answer ChannelMismatch.
    const wantsJoin =
      g !== null &&
      seated &&
      !holds &&
      unaccepted === null &&
      !rec.welcomeRetriesExhausted &&
      (reason !== "start" || n.state === "left");
    if (wantsJoin && !rec.join) this.#background(this.ensureJoined(rec.id));
  }

  /** The routine commits a refresh can reveal, for the group both hold. */
  #maintain(rec: ChannelRec): void {
    if (this.#disposed || rec.stripped) return;
    const n = rec.native;
    const g = rec.serverGroup;
    if (!n || !g || n.state !== "active" || n.group_id !== g.group_id) return;
    if (g.pending_removals.length > 0) {
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
    rec.seats = seats;
    await this.#verifySeats(rec, seats, false);
    await this.#readState(rec);
    this.#emit(rec);
  }

  // -------------------------------------------------------------------------
  // Join (design 6.3, D19, 9.1 6c/6d)
  // -------------------------------------------------------------------------

  async #runJoin(rec: ChannelRec, js: JoinState): Promise<void> {
    await this.refresh(rec.id, "commit");
    let n = rec.native;
    let g = rec.serverGroup;
    if (!n) throw clientFailure("state_unavailable");
    if (n.state === "active" && g && n.group_id === g.group_id) return;
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
    let attempts = 0;
    for (;;) {
      if (js.cancelled) return;
      this.#checkAlive();
      // W4d X#6: before EVERY `_join` (the first of a new run too): re-Added
      // at/after our last intent means a Welcome is due. Another intent
      // would read as a rejoin and evict that fresh leaf, so wait for the
      // Welcome (the mailbox redelivers it) for a bounded window; past it
      // the join is stalled loud (9.1 6d), never restarted.
      if (this.#reAdded(rec, g)) {
        if (await this.#awaitWelcome(js, JOIN_RETRY_MS * JOIN_RETRIES)) {
          return;
        }
        if (js.cancelled) return;
        rec.welcomeRetriesExhausted = true;
        rec.recreateAvailable = this.#isSigner(rec);
        this.#emit(rec);
        throw clientFailure("welcome_pending");
      }
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
        // fresh `_join`, inside the same attempt budget.
        attempts += 1;
        if (attempts > JOIN_RETRIES) throw unpublished;
        await this.#sleep(publishBackoffMs(attempts));
        continue;
      }
      if (js.cancelled) return;
      const r = await this.#api("POST", `/mls/groups/${gid}/join_intent`, {
        ...joined.intent,
      });
      attempts += 1;
      if (r !== null && r.status === 404) {
        await this.refresh(rec.id, "commit");
        if (!rec.serverGroup) throw clientFailure("no_group");
      } else if (r !== null && r.status === 429) {
        await this.#sleep(retryAfterMs(r) ?? publishBackoffMs(attempts));
      } else if (r !== null && is4xx(r.status)) {
        throw serverFailure(r);
      }
      const welcomed = await this.#awaitWelcome(js, JOIN_RETRY_MS);
      if (welcomed || js.cancelled) return;
      await this.refresh(rec.id, "commit");
      n = rec.native;
      g = rec.serverGroup;
      if (n && g && n.state === "active" && n.group_id === g.group_id) return;
      if (!g) throw clientFailure("no_group");
      // design 7.2 member_added: a re-Add at/after our intent is handled at
      // the top of the loop (wait for the Welcome, never another intent).
      if (attempts > JOIN_RETRIES && !this.#reAdded(rec, g)) {
        rec.welcomeRetriesExhausted = true;
        rec.recreateAvailable = this.#isSigner(rec);
        this.#emit(rec);
        throw clientFailure("join_stalled");
      }
    }
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

  async #awaitWelcome(js: JoinState, ms: number): Promise<boolean> {
    return Promise.race([
      js.welcome.promise.then(() => true),
      this.#sleep(ms).then(() => false),
    ]);
  }

  #reAdded(rec: ChannelRec, g: ProtectedTextGroupResponse): boolean {
    const from = rec.joinFromEpoch;
    if (from === null) return false;
    return g.member_added.some(
      (a) =>
        a.user_id === this.#port.selfUserId &&
        a.device_id === this.#port.selfDeviceId &&
        a.epoch >= from,
    );
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
      if (!n || n.state !== "active" || n.group_id !== req.group_id) return;
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
      if (!n || n.state !== "active" || n.group_id !== req.group_id) return;
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
        throw err;
      }
    }
  }

  async #claim(req: MlsJoinRequest): Promise<MlsClaimedKeyPackage | null> {
    const r = await this.#api("POST", "/mls/key_packages/claim", {
      device_id: this.#port.selfDeviceId,
      group_id: req.group_id,
      targets: [{ user_id: req.user_id, device_id: req.device_id }],
    });
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
      if (!n || n.state !== "active" || n.group_id === null) {
        throw clientFailure("no_group");
      }
      const groupId = n.group_id;
      // D24 / W3 D13: pending_removal_users from GET .../text_group.
      const pendingRemovalUsers =
        rec.serverGroup?.group_id === groupId
          ? rec.serverGroup.pending_removals.map((p) => p.user_id)
          : [];
      const r = await this.#staged(rec, groupId, async () => {
        try {
          return await this.#enqueue(rec.id, () =>
            this.#invoke("e2ee_text_remove", {
              groupId,
              targets,
              rejoinIntent,
              pendingRemovalUsers,
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

  /** Rule 4a: any member device removes every device of pending users. */
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
        if (g) rec.serverGroup = g;
      }
      await this.#readState(rec);
      const n = rec.native;
      const g = rec.serverGroup;
      if (!n || !g || n.state !== "active" || n.group_id !== g.group_id) return;
      const users = new Set(g.pending_removals.map((p) => p.user_id));
      const targets = n.members
        .filter(
          (m) =>
            users.has(m.user_id) &&
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
        if (!n || n.state !== "active" || n.group_id === null) return;
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
    const supersedes =
      c.generation === 0 ? null : await textGroupId(rec.id, c.generation - 1);
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
    const ctx: SubmitContext = this.#submitCtx(groupId, payload, false);
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

  #submitCtx(
    groupId: string,
    payload: TextSubmitCommitPayload,
    resubmit: boolean,
  ): SubmitContext {
    return {
      groupId,
      epoch: payload.epoch,
      selfUserId: this.#port.selfUserId,
      selfDeviceId: this.#port.selfDeviceId,
      ownCommitB64: payload.commit,
      resubmit,
      failures: 0,
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
        if (row) {
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
              }
            : { kind: "lost", winner: row, then: "process_winner" };
        }
        this.#log("warn", "won row missing", { groupId, epoch });
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
              });
              await this.#onOutcome(out);
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
      const ctx = this.#submitCtx(groupId, payload, false);
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
        const res = await this.#processWire(rec, wire, 1);
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
        welcomeRetriesExhausted: false,
        ownerChangePending: false,
        recreateAvailable: false,
        publishInFlight: false,
        maybeUnsent: false,
        stripped: false,
        parked: [],
        openCtl: null,
        join: null,
        joinFromEpoch: null,
        refreshing: null,
        refreshAgain: false,
        removalInFlight: false,
        updating: null,
        successorInFlight: false,
        recreating: null,
        seeded: false,
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
   * the poisoned group clears (X#1).
   */
  #clearGroupError(rec: ChannelRec, out: TextProcessOutcome): void {
    const sticky = rec.stickyGroupError;
    if (sticky !== null) {
      if (out.kind !== "welcome_joined") return;
      const ref = this.#index.get(out.group_id);
      if (!ref || ref.channelId !== rec.id) return;
      if (ref.generation <= sticky.generation) return;
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
      rec.native = n;
      if (n.verdict === "roster_mismatch") {
        rec.rosterMismatchSinceMs ??= this.#port.now();
      } else {
        rec.rosterMismatchSinceMs = null;
      }
    } catch (err) {
      if (isDisposed(err)) throw err;
      this.#log("warn", "state read failed", {
        channelId: rec.id,
        type: viewTagOf(err),
      });
    }
    return rec.native;
  }

  /** D18: own devices pinned with the COMPLETE listing when it changes. */
  async #ensureOwnPins(force: boolean): Promise<void> {
    try {
      const { hash, listing } = await this.#port.ownDeviceListing();
      if (!force && hash === this.#ownPinsHash) return;
      await this.#invoke("e2ee_text_pin_own_devices", {
        userId: this.#port.selfUserId,
        devices: listing,
      });
      this.#ownPinsHash = hash;
    } catch (err) {
      if (isDisposed(err)) throw err;
      this.#log("warn", "own device pin failed", { type: viewTagOf(err) });
    }
  }

  /** D18: pin a user's devices (own user: the own-device listing). */
  async #pinFor(userId: string, deviceIds: string[]): Promise<void> {
    if (userId === this.#port.selfUserId) return this.#ensureOwnPins(true);
    try {
      await this.#port.pinCallIdentities(userId, deviceIds);
    } catch (err) {
      this.#log("warn", "identity pin failed", { type: viewTagOf(err) });
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

  #view(rec: ChannelRec): ProtectedChannelView {
    return {
      channelId: rec.id,
      seatListError: rec.seatListError,
      groupError: rec.groupError,
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
    };
  }

  #emit(rec: ChannelRec): void {
    if (this.#disposed) return;
    try {
      this.#cb.onView(rec.id, this.#view(rec));
    } catch {
      this.#log("error", "onView threw", { channelId: rec.id });
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
