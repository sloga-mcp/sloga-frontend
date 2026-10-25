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
} from "./e2ee";
import {
  isSynthTextEnvelopeId,
  textEnvelopeFromCommitInfo,
  toWireEnvelope,
} from "./protectedRouter.ts";
import { TextIdIndex } from "./protectedTextIds.ts";
import {
  type RefetchPurpose,
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
  JOIN_RETRIES,
  JOIN_RETRY_MS,
  leafStaggerMs,
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

/** Orphan confirm retries (confirm_later) before it waits for next start. */
export const ORPHAN_CONFIRM_BUDGET = 5;

/** `limit` of the orphan confirm query; passed to the policy as pageLimit. */
export const CONFIRM_PAGE_LIMIT = 100;

/** D10 storage key prefix of a stored protected send. */
export const PROTECTED_SEND_KEY_PREFIX = "protected-send:";

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

interface ParkedCommit {
  groupId: string;
  payload: TextSubmitCommitPayload;
  purpose: RefetchPurpose;
  resubmit: boolean;
}

interface ChannelRec {
  id: string;
  seatListError: ViewErrorTag | null;
  groupError: ViewErrorTag | null;
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
  parkedCommit: ParkedCommit | null;
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
  /** Ids whose view came from this device's typed plaintext (own sends). */
  readonly #ownSent = new Set<string>();
  /** Ids whose cached view came from a LIVE decrypt or an own send. */
  readonly #viewLive = new Set<string>();
  /** Deleted message ids (`forget`): a late decrypt never re-adds them. */
  readonly #forgotten = new Set<string>();
  readonly #firstSightQueue: ChannelRec[] = [];
  #firstSightRunning = false;
  #firstSightWindowStart = 0;
  #firstSightWindowCount = 0;
  #ownPinsHash: string | null = null;
  #orphanScan: Promise<void> | null = null;
  #orphanScanAgain = false;
  #started = false;
  #disposed = false;

  constructor(
    port: ProtectedTextPort,
    cb: ProtectedTextManagerCallbacks,
    deps: ProtectedTextManagerDeps,
  ) {
    this.#port = port;
    this.#cb = cb;
    this.#deps = deps;
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

  /** A channel became known as protected or pinned (deduped). */
  channelProtected(channelId: string): void {
    this.#background(
      this.#register(channelId).then((rec) =>
        this.#started ? this.#seed(rec) : undefined,
      ),
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
        this.#port,
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
        this.#port,
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
    const out = await this.#deps.messages.encryptAndSend(
      this,
      this.#port,
      channelId,
      text,
      replies,
      silent,
      key,
    );
    // D22: the own view comes from the typed plaintext; the live echo of
    // the same id is deduped (onMessage skips it).
    this.#ownSent.add(out.messageId);
    this.#viewLive.add(out.messageId);
    this.#setMessageView(out.messageId, {
      status: "ok",
      text,
      replies,
      senderVerified: true,
      tsSkew: false,
      cid: out.cid,
    });
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

  async #decryptOne(row: ProtectedMessageRow, live: boolean): Promise<void> {
    if (this.#disposed) return;
    if (this.#ownSent.has(row.id) && this.#views.has(row.id)) {
      this.#cb.onMessageView(row.id, this.#views.get(row.id)!);
      return;
    }
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
      view = await this.#deps.messages.decryptRow(this, this.#port, row, live);
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
    if (this.#disposed || this.#ownSent.has(row.id)) return;
    if (this.#forgotten.has(row.id)) return;
    // A late history result never overwrites a live one.
    if (!live && this.#viewLive.has(row.id)) return;
    if (live) this.#viewLive.add(row.id);
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
      this.#ownSent.delete(id);
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
          this.#ownSent.delete(oldest);
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
        if (rec) {
          rec.groupError = "wrong_group_kind";
          this.#emit(rec);
        }
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
        this.#recordGroupError(rec, verdict.groupError, tag);
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
        rec.parked.push(wire);
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
    rec.groupError = null;
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
    if (seatsRes !== null && is2xx(seatsRes.status)) {
      const seats = parseSeats(seatsRes.body);
      if (seats) rec.seats = seats;
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
    if (rec.seats?.list) await this.#verifySeats(rec, rec.seats, true);
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
            return this.#verifySeats(rec, seats, withAsOf, true);
          }
          break;
        case "identity_pin_required":
          if (!retried && native?.type === "identity_pin_required") {
            await this.#pinFor(native.user_id, [native.device_id]);
            return this.#verifySeats(rec, seats, withAsOf, true);
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

  /** Maintenance a refresh can reveal (fire-and-forget, errors logged). */
  #afterRefresh(rec: ChannelRec, reason: TextRefreshReason): void {
    if (this.#disposed || rec.stripped) return;
    if (rec.parkedCommit) {
      const p = rec.parkedCommit;
      rec.parkedCommit = null;
      this.#background(this.#resumeParked(rec, p));
    }
    const n = rec.native;
    const g = rec.serverGroup;
    if (!n) return;
    const self = this.#port.selfUserId;
    if (n.state === "active" && g && n.group_id === g.group_id) {
      if (g.pending_removals.length > 0) {
        this.#background(this.#commitPendingRemovals(rec));
      } else if (n.epoch !== null && n.epoch < g.current_epoch) {
        this.#background(this.catchUp(rec.id, g.current_epoch, g.group_id));
      } else if (n.update_due || n.update_required) {
        this.#background(this.#commitUpdate(rec, false));
      }
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
    const holds =
      g !== null &&
      n.group_id === g.group_id &&
      (n.state === "active" || n.state === "poisoned");
    const seated = n.self_seated && n.seat_list?.seats.includes(self) === true;
    const wantsJoin =
      g !== null &&
      seated &&
      !holds &&
      !rec.welcomeRetriesExhausted &&
      (reason !== "start" || n.state === "left");
    if (wantsJoin && !rec.join) this.#background(this.ensureJoined(rec.id));
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
      rec.joinFromEpoch = g.current_epoch;
      let payload: TextCommandResult["e2ee_text_join"];
      const gid = g.group_id;
      const generation = g.generation;
      try {
        payload = await this.#enqueue(rec.id, () =>
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
        if (tag !== "busy") this.#recordGroupError(rec, tag, tag);
        throw toFailure(err);
      }
      const r = await this.#api("POST", `/mls/groups/${gid}/join_intent`, {
        ...payload,
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
      if (this.#reAdded(rec, g)) {
        // design 7.2 member_added: re-Added at/after our intent. Stop the
        // retries and wait for the Welcome (the mailbox redelivers it).
        if (await this.#awaitWelcome(js, JOIN_RETRY_MS * JOIN_RETRIES)) return;
        throw clientFailure("welcome_pending");
      }
      if (attempts > JOIN_RETRIES) {
        rec.welcomeRetriesExhausted = true;
        rec.recreateAvailable = this.#isSigner(rec);
        this.#emit(rec);
        throw clientFailure("join_stalled");
      }
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
        const payload = await this.#stageAdmit(rec, req, claimed);
        const r = await this.#submit(rec, req.group_id, payload);
        if (r !== "restage") return;
      }
    } catch (err) {
      if (!isDisposed(err)) {
        this.#log("warn", "admission failed", {
          groupId: req.group_id,
          type: viewTagOf(err),
        });
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
      let payload: TextSubmitCommitPayload;
      try {
        payload = await this.#enqueue(rec.id, () =>
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
      const r = await this.#submit(rec, groupId, payload);
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
        const payload = await this.#enqueue(rec.id, () =>
          this.#invoke("e2ee_text_update", { groupId }),
        );
        const r = await this.#submit(rec, groupId, payload);
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

  async #submit(
    rec: ChannelRec,
    groupId: string,
    payload: TextSubmitCommitPayload,
  ): Promise<SubmitResult> {
    const ctx: SubmitContext = this.#submitCtx(groupId, payload, false);
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
    return this.#submitLoop(rec, payload, ctx, first);
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

  async #submitLoop(
    rec: ChannelRec,
    payload: TextSubmitCommitPayload,
    ctx: SubmitContext,
    first: SubmitAction,
  ): Promise<SubmitResult> {
    const { groupId } = ctx;
    const ids = { groupId, epoch: ctx.epoch };
    let action = first;
    let refetch403 = 0;
    for (;;) {
      this.#checkAlive();
      switch (action.kind) {
        case "won": {
          // RC NEW-5: on a refetch path `storedCommitB64` is the DS's
          // stored string; native merges equal bytes and answers
          // own_commit_mismatch (→ left → rejoin) for different ones.
          const won = action;
          try {
            await this.#enqueue(rec.id, async () => {
              const out = await this.#invoke("e2ee_text_commit_won", {
                groupId,
                wonEpoch: ctx.epoch,
                storedCommitB64: won.storedCommitB64,
                rejoinIntents: won.rejoinIntents,
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
          if (
            refetch403 >= REFETCH_403_PARK_BUDGET &&
            action.kind === "refetch"
          ) {
            // Binding note: park; the stage stays, the outcome unknown.
            rec.parkedCommit = {
              groupId,
              payload,
              purpose,
              resubmit: ctx.resubmit,
            };
            this.#log("warn", "commit parked after 403s", ids);
            return "parked";
          }
          break;
        }
        case "resubmit": {
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
          action = classifySubmit(
            r !== null
              ? { kind: "submit", response: r }
              : { kind: "submit_transport_error" },
            ctx,
          );
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

  /** Resume a parked commit on the next refresh (binding note). */
  async #resumeParked(rec: ChannelRec, p: ParkedCommit): Promise<void> {
    try {
      const pending = await this.#enqueue(rec.id, () =>
        this.#invoke("e2ee_text_pending_commit", { groupId: p.groupId }),
      );
      if (
        pending === null ||
        pending.epoch !== p.payload.epoch ||
        pending.commit_b64 !== p.payload.commit
      ) {
        return;
      }
      const ctx = this.#submitCtx(p.groupId, p.payload, p.resubmit);
      await this.#submitLoop(rec, p.payload, ctx, {
        kind: "refetch",
        purpose: p.purpose,
        delayMs: 0,
      });
    } catch (err) {
      if (!isDisposed(err)) {
        this.#log("warn", "parked commit resume failed", {
          groupId: p.groupId,
          type: viewTagOf(err),
        });
      }
    }
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
      try {
        const v: unknown = JSON.parse(this.#port.store.get(key) ?? "null");
        if (isRecord(v) && str(v.nonce)) cid = v.nonce;
      } catch {
        cid = null;
      }
      try {
        await this.#confirmOrphan(channelId, key, cid);
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
  async #confirmOrphan(channelId: string, key: string, cid: string | null) {
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
    const ctx: SendContext = {
      selfUserId: this.#port.selfUserId,
      cid,
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
        parkedCommit: null,
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
  ): void {
    if (!rec || verdictTag === undefined || tag === "busy") return;
    if ((MESSAGE_LEVEL_TAGS as readonly string[]).includes(tag)) return;
    rec.groupError = verdictTag;
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
    return this.#port.invoke(cmd, args);
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
