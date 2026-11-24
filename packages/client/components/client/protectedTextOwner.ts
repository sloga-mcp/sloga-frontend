/**
 * Owner flows for Protected channels (text plane), W4 lane B2.
 *
 * `protect` publishes the genesis seat list and creates the generation-0
 * text group; `setSeats` signs, publishes and verifies the next seat list
 * and removes every leaf whose user left the list. Plan D7 / D7b / D7c /
 * D21 (genesis), design 4.9 and 6.3.
 *
 * Rules held here:
 * - Signed bytes persist (D7c `protected-publish:<userId>:<channelId>`)
 *   BEFORE the PUT and are re-sent byte for byte until the publish resolves
 *   (`publishStep`): no attempt cap, a 429 is never resolving, and nothing
 *   new is signed while a publish is unresolved (`signAllowed`). A seat
 *   PUT's other 4xx (incl. `SeatListNamesRemovedUsers`) resolves it as
 *   refused: never re-sent, never re-signed automatically.
 * - A protect is never taken at face value on a non-429 4xx: it is resolved
 *   by read-back (`resolveProtectReadBack`). The genesis self-pin happens
 *   only through `_seat_list_verify` on the read-back list.
 * - Every verify passes `as_of_epoch` / `as_of_group_id` from the same
 *   `GET .../seats` snapshot (D24); `mls_epoch_gap` catches up and
 *   re-verifies once, `identity_pin_required` pins and retries once (D18).
 * - Failures reject with a `TextFlowFailure` (D17 maps it). Logs carry ids
 *   only (D16).
 *
 * S2 (W4 L2o):
 * - `format` (rule j): `2` only for a genesis or the first list over a held
 *   v1, and only while `formats_v2` is on; otherwise null (native's choice,
 *   which keeps a held v2). Never inferred from a server field.
 * - A list's `authority` rides on verify input and on the PUT body
 *   (`signOwnerDevices` signs a new one, design 4.10).
 * - D40: `RemovalReasonRequired` (or the header's `AuditLogReasonTooLong`)
 *   does NOT use up the bytes (4.9): they stay stored and are re-sent as
 *   they are, with `X-Audit-Log-Reason`, once the caller has a reason.
 *   Nothing is re-signed because a reason was added.
 * - F3: `cancelPendingSeats` drops a stored seat publish only when its
 *   recorded answers prove the server never took it (`answer`, written
 *   ahead of every PUT); resume is unchanged (the same bytes).
 * - F5 (S2-D42, design 4.6): `moveOwnerKey` hands the owner key from this
 *   signing device to another device of this user. The handover statement
 *   is stored with the list bytes it rides on and re-sent with them.
 * - FX-R (design 6.3 "Owner signing device lost", 4.9): `recoverOwnership`
 *   stores the recovery list (`recovery`) before its first PUT, like every
 *   other publish, and resumes the SAME bytes on every later call until it
 *   resolves; a re-send budget bounds one call, never the entry. A reason
 *   header rides only on a plain seat publish.
 * - FXO (FXL audit M1): so a recovery list refused for its reason header
 *   can never land: F3 may discard it, and the next `recoverOwnership`
 *   drops it and signs afresh instead of re-sending it.
 *
 * S4 (W4 L2o; design 4.9 "S4", R-W4-9 / 10 / 11):
 * - `protect` with `opts.withHistory` protects a channel that has messages:
 *   an OWNER-ONLY v2 genesis naming the newest message as the boundary,
 *   then the picked members through `setSeats`. Every genesis signed while
 *   the server answers `ProtectHistoryMoved` stays in the stored entry
 *   (`ProtectJournalV2`, written BEFORE its PUT) and a read-back equal to
 *   any of them has landed. At most `PROTECT_HISTORY_MAX_ATTEMPTS`.
 * - A wipe is asked for only when the caller passed `wipe: true` AND the
 *   signed bytes say `pre_history:wiped`; its one confirmation is the
 *   native dialog inside the sign call. A stored protect signed with a
 *   wipe is never re-sent by a later call: it is read back, and dropped
 *   when it did not land.
 * - `setHistory` signs the next list with the `history` line changed and
 *   publishes it as any seat list. `wipeHistory` signs the one-change wipe
 *   list and POSTs it. A stored wipe list is never sent again by a later
 *   call (R-W4-34): on the server it is finished, otherwise it is dropped,
 *   and a later `wipeHistory` signs afresh behind native's dialog.
 * - Fix round W4 (R-W4-35, audit B7): once the boundary genesis has landed,
 *   a failed member step rejects `protected_members_pending`, and a wipe
 *   the caller asked for that the landed list does not carry rejects
 *   `wipe_not_done`. Both mean "protected, with something left out".
 * - All three are refused while `history_setting` is off. Without `opts`,
 *   `protect` is the S2 flow, request for request.
 *
 * Pure of Solid / livekit / lingui; driven through `GroupOps` and the port,
 * so `node --test --conditions=browser` loads it over fakes.
 */
import type { MlsMemberDevice } from "./e2ee";
import { reasonRefusal } from "./protectedRemovalReasonPolicy.ts";
import {
  type HistorySignOp,
  type ProtectJournalV2,
  type ProtectReadBack,
  type PublishAnswer,
  type PublishOp,
  type PublishStep,
  historySignArgs,
  protectBody,
  protectLanded,
  publishBackoffMs,
  publishStep,
  readProtectJournal,
  resolveProtectReadBack,
  signAllowed,
} from "./protectedTextPolicy.ts";
import type {
  CancelPendingSeatsResult,
  GroupOps,
  HistorySetting,
  NativeError,
  PendingSeats,
  ProtectedSeatsResponse,
  ProtectedTextPort,
  RecoveryPlan,
  SeatListInput,
  SeatListVerdict,
  ServerSeatList,
  SignedAuthority,
  SignedHandover,
  SignedSeatList,
  TextApiHeaders,
  TextApiMethod,
  TextApiResponse,
  TextFlowFailure,
} from "./protectedTextTypes";

// ---------------------------------------------------------------------------
// D7c storage
// ---------------------------------------------------------------------------

export const PUBLISH_STORE_PREFIX = "protected-publish:";

/** D7c key of the unresolved publish of one channel. */
export function publishStoreKey(userId: string, channelId: string): string {
  return `${PUBLISH_STORE_PREFIX}${userId}:${channelId}`;
}

/** What D7c stores: the op and the exact signed bytes being published. */
export interface StoredPublish {
  v: 1;
  op: PublishOp;
  signed: SignedSeatList;
  /**
   * S2: published by `signOwnerDevices`; a retry of that flow resumes these
   * bytes and never shows the authority dialog again (4.9).
   */
  ownerDevices?: true;
  /**
   * S2 D40: the server refused these bytes for their reason header only;
   * a `setSeats` with a reason re-sends them and signs nothing new.
   */
  reasonRequired?: true;
  /**
   * S2 F3: what the server has answered for these bytes (seat publishes
   * only); `cancelPendingSeats` decides on it alone.
   * - `"unsent"`: stored at sign time; no PUT of them has gone out.
   * - `"sent"`: written BEFORE every PUT (write-ahead) and left in place
   *   unless the answer proves nothing was written: a transport error, a
   *   5xx, no answer at all (aborted mid-PUT), a 2xx. The server MAY hold
   *   these bytes.
   * - `"refused"`: EVERY PUT of them so far was answered with a refusal
   *   that writes nothing: a 429 (the rate-limit fairing reroutes the
   *   request to `/ratelimit` before any route runs) or a reason refusal
   *   (`RemovalReasonRequired` / `AuditLogReasonTooLong`, decided before
   *   the write). Set only when the state before that PUT was `"unsent"`
   *   or `"refused"`: one maybe-accepted attempt keeps the entry `"sent"`
   *   for good, as a later refusal says nothing about an earlier attempt.
   * Absent (stored before F3) or unknown: read as `"sent"` (ambiguous).
   */
  answer?: PublishAnswerSeen;
  /**
   * S2 F5: the handover statement `moveOwnerKey` publishes on these bytes
   * (the PUT's `handover`). Stored with them and re-sent with them, never
   * signed again.
   */
  handover?: SignedHandover;
  /**
   * S2 FX-R: the recovery list `recoverOwnership` publishes (design 6.3).
   * Only that flow re-sends it (it creates the successor first); another
   * flow may resolve it by read-back, never PUT it. F3 discards it only
   * while `neverAccepted` (unsent, or refused for its reason header).
   */
  recovery?: true;
  /**
   * S4: published by `setHistory`, with the `history` line it asked for; a
   * retry of the same change resumes these bytes and shows no dialog again.
   */
  history?: HistorySetting;
}

/**
 * S4: the wipe list `wipeHistory` POSTs (design 4.9 "S4"), under the same
 * D7c key. `sent` is written BEFORE the first POST (as F3's `"sent"`), so
 * `false` proves no request of these bytes ever went out.
 */
interface StoredWipe {
  v: 1;
  op: "wipe";
  signed: SignedSeatList;
  sent: boolean;
}

type PublishAnswerSeen = "unsent" | "sent" | "refused";

const ANSWERS_SEEN: readonly string[] = ["unsent", "sent", "refused"];

/**
 * In-memory copy of every stored publish, so a failed `localStorage` write
 * still blocks signing for the rest of the session.
 */
const memo = new Map<string, string>();

/** Channels with an owner flow running (one at a time per channel). */
const running = new Set<string>();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

const clientFailure = (reason: string): TextFlowFailure => ({
  source: "client",
  reason,
});

const FAILURE_SOURCES = ["native", "server", "transport", "client"];

/** Normalise any rejection to a `TextFlowFailure`. */
function toFailure(e: unknown): TextFlowFailure {
  if (isRecord(e) && FAILURE_SOURCES.includes(e.source as string)) {
    return e as unknown as TextFlowFailure;
  }
  if (isRecord(e) && typeof e.type === "string") {
    return { source: "native", error: e as unknown as NativeError };
  }
  return clientFailure("unexpected_error");
}

/** The native error inside a rejection (bare or wrapped), or null. */
function nativeErrorOf(e: unknown): Record<string, unknown> | null {
  if (!isRecord(e)) return null;
  if (e.source === "native") return isRecord(e.error) ? e.error : null;
  if (e.source !== undefined) return null;
  return typeof e.type === "string" ? e : null;
}

function serverFailure(r: TextApiResponse): TextFlowFailure {
  const type = isRecord(r.body) && typeof r.body.type === "string";
  return {
    source: "server",
    status: r.status,
    type: type ? ((r.body as Record<string, unknown>).type as string) : null,
    body: r.body,
  };
}

/** A list's `authority`: absent or null = none, undefined = malformed. */
function parseAuthority(v: unknown): SignedAuthority | null | undefined {
  if (v === undefined || v === null) return null;
  if (
    isRecord(v) &&
    typeof v.body === "string" &&
    typeof v.signature === "string"
  ) {
    return { body: v.body, signature: v.signature };
  }
  return undefined;
}

/** `{ authority }` when there is one, else nothing (S1 shapes unchanged). */
function withAuthority(a: SignedAuthority | undefined) {
  return a === undefined ? {} : { authority: a };
}

function parseSigned(v: unknown): SignedSeatList | null {
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
  const authority = parseAuthority(v.authority);
  if (authority === undefined) return null;
  return {
    version: v.version,
    body: v.body,
    signature: v.signature,
    signer_user_id: v.signer_user_id,
    signer_device_id: v.signer_device_id,
    ...withAuthority(authority ?? undefined),
  };
}

/** Per-flow context, resolved once. */
interface Ctx {
  ops: GroupOps;
  port: ProtectedTextPort;
  channelId: string;
  key: string;
  serverOwnerId: string;
  channelName: string | null;
  /** Never aborted by this module; a port may still reject `sleep`. */
  signal: AbortSignal;
  /**
   * FX-R: set by `recoverOwnership` only, for its recovery entry: the
   * successor step before a PUT and the re-send budget of one call.
   */
  recovery?: RecoveryPlan;
}

/**
 * FX-R: a recovery call past its budget of transient answers. Unbounded
 * (as before) for every other flow.
 */
function overBudget(ctx: Ctx, failures: number): boolean {
  const budget = ctx.recovery?.retryBudget;
  return budget !== undefined && failures >= budget;
}

/** The rejection for a transient answer once the budget is spent. */
function transientFailure(a: PublishAnswer): TextFlowFailure {
  return a.kind === "response"
    ? serverFailure(a.response)
    : { source: "transport" };
}

async function pause(ctx: Ctx, ms: number): Promise<void> {
  try {
    await ctx.port.sleep(ms, ctx.signal);
  } catch {
    // The manager is going away. The stored entry stays; the next owner
    // flow resumes it (D7c).
    throw clientFailure("aborted");
  }
}

async function request(
  ctx: Ctx,
  method: TextApiMethod,
  path: string,
  body?: unknown,
  headers?: TextApiHeaders,
): Promise<PublishAnswer> {
  try {
    const response =
      headers !== undefined
        ? await ctx.port.api(method, path, body, headers)
        : body === undefined
          ? await ctx.port.api(method, path)
          : await ctx.port.api(method, path, body);
    return { kind: "response", response };
  } catch {
    return { kind: "transport_error" };
  }
}

/**
 * D40: the seat PUT's reason header. The caller validated `reason`
 * (`validReason(s, "header")`); `textApi` encodes it. Never logged.
 */
function reasonHeader(reason: string | null): TextApiHeaders | undefined {
  return reason === null ? undefined : { "X-Audit-Log-Reason": reason };
}

/** Where a stored publish lives: the flow context, or `{ port, key }`. */
type StoreAt = Pick<Ctx, "port" | "key">;

function readStored(ctx: StoreAt): StoredPublish | "corrupt" | null {
  const raw = ctx.port.store.get(ctx.key) ?? memo.get(ctx.key) ?? null;
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!isRecord(v) || v.v !== 1) return "corrupt";
    if (v.op !== "protect" && v.op !== "seats") return "corrupt";
    const signed = parseSigned(v.signed);
    if (signed === null) return "corrupt";
    const handover =
      v.handover === undefined ? null : parseHandover(v.handover);
    if (v.handover !== undefined && handover === null) return "corrupt";
    const answer =
      typeof v.answer === "string" && ANSWERS_SEEN.includes(v.answer)
        ? (v.answer as PublishAnswerSeen)
        : null;
    return {
      v: 1,
      op: v.op,
      signed,
      ...(v.ownerDevices === true ? { ownerDevices: true as const } : {}),
      ...(v.reasonRequired === true ? { reasonRequired: true as const } : {}),
      ...(answer !== null ? { answer } : {}),
      ...(handover !== null ? { handover } : {}),
      ...(v.recovery === true ? { recovery: true as const } : {}),
      ...(v.history === "visible" || v.history === "hidden"
        ? { history: v.history }
        : {}),
    };
  } catch {
    return "corrupt";
  }
}

function persist(
  ctx: Ctx,
  entry: StoredPublish | ProtectJournalV2 | StoredWipe,
): void {
  const raw = JSON.stringify(entry);
  memo.set(ctx.key, raw);
  if (!ctx.port.store.set(ctx.key, raw)) {
    ctx.port.log("warn", "[protected] publish not persisted", {
      channelId: ctx.channelId,
      op: entry.op,
    });
  }
}

function clearStored(ctx: StoreAt): void {
  memo.delete(ctx.key);
  ctx.port.store.delete(ctx.key);
}

function isOwn(
  ctx: Ctx,
  l: { signer_user_id: string; signer_device_id: string },
) {
  return (
    l.signer_user_id === ctx.port.selfUserId &&
    l.signer_device_id === ctx.port.selfDeviceId
  );
}

/**
 * The `DataSeatList` body of a PUT. S2: `authority` whenever the signed
 * list carries one (design 4.3 step 3b); F5: `handover`, the ONE statement
 * the server appends to its stored chain (4.3 step 8), only on a
 * `moveOwnerKey` publish.
 */
function dataSeatList(s: SignedSeatList, handover?: SignedHandover) {
  return {
    body: s.body,
    signature: s.signature,
    signer_device_id: s.signer_device_id,
    ...withAuthority(s.authority),
    ...(handover === undefined ? {} : { handover }),
  };
}

/** One signed handover statement, or null when it is not one. */
function parseHandover(v: unknown): SignedHandover | null {
  if (
    !isRecord(v) ||
    typeof v.body !== "string" ||
    typeof v.signature !== "string"
  ) {
    return null;
  }
  return { body: v.body, signature: v.signature };
}

const HANDOVER_CONTEXT = "sloga-owner-handover-v1";

/**
 * The `key:value` lines of a handover body (design 4.6), or null when the
 * first line is not the handover context. Read for local checks only;
 * native and the server parse it strictly.
 */
function handoverFields(body: string): Map<string, string> | null {
  const [context, ...lines] = body.split("\n");
  if (context !== HANDOVER_CONTEXT) return null;
  const fields = new Map<string, string>();
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon > 0) fields.set(line.slice(0, colon), line.slice(colon + 1));
  }
  return fields;
}

/** The device a handover statement names as `to`, or null. */
function handoverTarget(h: SignedHandover): string | null {
  return handoverFields(h.body)?.get("to_device_id") ?? null;
}

// ---------------------------------------------------------------------------
// GET .../seats
// ---------------------------------------------------------------------------

type ServerList = SeatListInput & {
  version: number;
  handovers: SignedHandover[];
};

interface SeatsSnapshot {
  list: ServerList | null;
  asOfEpoch: number | null;
  asOfGroupId: string | null;
  /** S2-D33: the open group's generation; null when absent. */
  asOfGeneration: number | null;
}

function nonNegativeInt(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

function parseHandovers(v: unknown): SignedHandover[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(
      (h): h is SignedHandover =>
        isRecord(h) &&
        typeof h.body === "string" &&
        typeof h.signature === "string",
    )
    .map((h) => ({ body: h.body, signature: h.signature }));
}

/** null: malformed (treated as transient). */
function parseSeats(body: unknown): SeatsSnapshot | null {
  if (!isRecord(body)) return null;
  let list: ServerList | null = null;
  if (body.list !== null) {
    const l = body.list;
    const signed = parseSigned(l);
    if (signed === null || !isRecord(l)) return null;
    list = {
      version: signed.version,
      body: signed.body,
      signature: signed.signature,
      signer_user_id: signed.signer_user_id,
      signer_device_id: signed.signer_device_id,
      ...withAuthority(signed.authority),
      handovers: parseHandovers(l.handovers),
    };
  }
  return {
    list,
    asOfEpoch: nonNegativeInt(body.as_of_epoch),
    asOfGroupId:
      typeof body.as_of_group_id === "string" ? body.as_of_group_id : null,
    asOfGeneration: nonNegativeInt(body.as_of_generation),
  };
}

/**
 * Read the seats snapshot. Transport, 5xx, 429 and malformed answers are
 * retried with backoff (a read never guesses); a definitive 4xx rejects.
 */
async function readSeats(ctx: Ctx): Promise<SeatsSnapshot> {
  for (let failures = 0; ; failures++) {
    const a = await request(ctx, "GET", `/channels/${ctx.channelId}/seats`);
    if (a.kind === "response") {
      const { status } = a.response;
      if (is2xx(status)) {
        const snap = parseSeats(a.response.body);
        if (snap !== null) return snap;
      } else if (status >= 400 && status < 500 && status !== 429) {
        throw serverFailure(a.response);
      }
    }
    if (overBudget(ctx, failures)) throw transientFailure(a);
    await pause(ctx, publishBackoffMs(failures));
  }
}

// ---------------------------------------------------------------------------
// Verify (D24, D18)
// ---------------------------------------------------------------------------

async function pinIdentity(ctx: Ctx, userId: string, deviceId: string) {
  if (userId === ctx.port.selfUserId) {
    // F-R8: a cached listing without the device native named is refetched.
    const { listing } = await ctx.port.ownDeviceListing({ want: [deviceId] });
    await ctx.port.invoke("e2ee_text_pin_own_devices", {
      userId,
      devices: listing,
    });
  } else {
    await ctx.port.pinCallIdentities(userId, [deviceId]);
  }
}

/**
 * `_seat_list_verify` with the snapshot's `as_of_*` (never dropped). Catch
 * up first when the held group is behind the snapshot (design 4.4 step 0);
 * `mls_epoch_gap` catches up and re-verifies ONCE; `identity_pin_required`
 * pins and retries ONCE.
 */
async function verifyList(
  ctx: Ctx,
  list: ServerList,
  asOfEpoch: number | null,
  asOfGroupId: string | null,
  asOfGeneration: number | null,
): Promise<SeatListVerdict> {
  const args = {
    channelId: ctx.channelId,
    list: {
      body: list.body,
      signature: list.signature,
      signer_user_id: list.signer_user_id,
      signer_device_id: list.signer_device_id,
      ...withAuthority(list.authority),
    },
    handovers: list.handovers,
    serverOwnerId: ctx.serverOwnerId,
    asOfEpoch,
    asOfGroupId,
    asOfGeneration,
  };
  let caughtUp = false;
  let pinned = false;
  const held = ctx.ops.stateOf(ctx.channelId)?.native ?? null;
  if (
    asOfEpoch !== null &&
    asOfGroupId !== null &&
    held !== null &&
    held.group_id === asOfGroupId &&
    held.epoch !== null &&
    held.epoch < asOfEpoch
  ) {
    caughtUp = true;
    await ctx.ops.catchUp(ctx.channelId, asOfEpoch, asOfGroupId);
  }
  for (;;) {
    try {
      return await ctx.port.invoke("e2ee_text_seat_list_verify", args);
    } catch (e) {
      const err = nativeErrorOf(e);
      if (
        err?.type === "mls_epoch_gap" &&
        !caughtUp &&
        asOfEpoch !== null &&
        asOfGroupId !== null
      ) {
        caughtUp = true;
        await ctx.ops.catchUp(ctx.channelId, asOfEpoch, asOfGroupId);
        continue;
      }
      if (
        err?.type === "identity_pin_required" &&
        !pinned &&
        typeof err.user_id === "string" &&
        typeof err.device_id === "string"
      ) {
        pinned = true;
        await pinIdentity(ctx, err.user_id, err.device_id);
        continue;
      }
      throw toFailure(e);
    }
  }
}

// ---------------------------------------------------------------------------
// Protect (genesis)
// ---------------------------------------------------------------------------

/** D7b read-back, retried while transient. */
async function protectReadBack(
  ctx: Ctx,
  genesis: SignedSeatList,
): Promise<Exclude<ProtectReadBack, { kind: "retry" }>> {
  for (let failures = 0; ; failures++) {
    const ch = await request(ctx, "GET", `/channels/${ctx.channelId}`);
    const seats = await request(ctx, "GET", `/channels/${ctx.channelId}/seats`);
    const rb = resolveProtectReadBack({
      channel: ch.kind === "response" ? ch.response : null,
      seats: seats.kind === "response" ? seats.response : null,
      genesis,
    });
    if (rb.kind !== "retry") return rb;
    await pause(ctx, publishBackoffMs(failures));
  }
}

/** Verify the landed genesis (the self-pin) and create generation 0. */
async function finishGenesis(
  ctx: Ctx,
  list: ServerList,
  asOfEpoch: number | null,
  asOfGroupId: string | null,
  asOfGeneration: number | null,
): Promise<void> {
  await verifyList(ctx, list, asOfEpoch, asOfGroupId, asOfGeneration);
  // D21: no open Text group yet (as_of is null) → this device creates it.
  if (asOfGroupId === null) await ctx.ops.createGroup(ctx.channelId, null);
}

/**
 * PUT the SAME genesis bytes until the answer is not a resend, then resolve
 * by read-back (2xx included: the self-pin needs the read-back verify).
 */
async function publishProtect(ctx: Ctx, genesis: SignedSeatList) {
  for (let failures = 0; ; failures++) {
    const answer = await request(
      ctx,
      "PUT",
      `/channels/${ctx.channelId}/protect`,
      { seat_list: dataSeatList(genesis) },
    );
    const step = publishStep(answer, { op: "protect", failures });
    if (step.kind === "resend") {
      await pause(ctx, step.delayMs);
      continue;
    }
    break;
  }
  await resolveProtect(ctx, genesis, false);
}

/**
 * Resolve a protect through read-back. `resuming`: no attempt has been
 * answered in this session, so "not protected / no list" means "not
 * landed yet" and the SAME bytes are re-sent.
 */
async function resolveProtect(
  ctx: Ctx,
  genesis: SignedSeatList,
  resuming: boolean,
): Promise<void> {
  const rb = await protectReadBack(ctx, genesis);
  if (
    rb.kind === "refused" &&
    resuming &&
    (rb.reason === "not_protected" || rb.reason === "no_list")
  ) {
    await publishProtect(ctx, genesis);
    return;
  }
  clearStored(ctx);
  if (rb.kind === "refused") {
    ctx.port.log("warn", "[protected] protect refused", {
      channelId: ctx.channelId,
      reason: rb.reason,
    });
    throw clientFailure("protect_failed");
  }
  // The policy's read-back carries no generation (S1 shape): null.
  await finishGenesis(
    ctx,
    { ...rb.list, version: 1, handovers: rb.handovers },
    rb.asOfEpoch,
    rb.asOfGroupId,
    null,
  );
}

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

/** Read back, verify, then remove every leaf whose user left the list. */
async function finishSeats(ctx: Ctx): Promise<void> {
  const snap = await readSeats(ctx);
  if (snap.list === null) throw clientFailure("not_protected");
  const verdict = await verifyList(
    ctx,
    snap.list,
    snap.asOfEpoch,
    snap.asOfGroupId,
    snap.asOfGeneration,
  );
  const state = await ctx.port.invoke("e2ee_text_state", {
    channelId: ctx.channelId,
  });
  if (state.state !== "active" || state.group_id === null) return;
  const keep = new Set(verdict.seats);
  const targets: MlsMemberDevice[] = state.members
    .filter(
      (m) =>
        !keep.has(m.user_id) &&
        !(
          m.user_id === ctx.port.selfUserId &&
          m.device_id === ctx.port.selfDeviceId
        ),
    )
    .map((m) => ({ user_id: m.user_id, device_id: m.device_id }));
  // D19: an owner unseat commits right after its own verified PUT.
  if (targets.length > 0) {
    await ctx.ops.removeDevices(ctx.channelId, targets, {
      rejoinIntent: null,
    });
  }
}

/**
 * D40 / design 4.9: a refusal about the reason header only
 * (`RemovalReasonRequired`, or `AuditLogReasonTooLong` as `reasonRefusal`
 * names it). The reason is not part of the signed body, so the bytes are
 * not used up.
 */
function refusedForReason(step: PublishStep, answer: PublishAnswer): boolean {
  if (step.kind !== "resolved_refused" || answer.kind !== "response") {
    return false;
  }
  return (
    step.type === "RemovalReasonRequired" ||
    reasonRefusal(answer.response.body) === "too_long"
  );
}

/**
 * F3 write-ahead: record `"sent"` BEFORE a PUT goes out, so a crash or an
 * abort mid-PUT leaves the entry "maybe accepted". If the store write
 * failed and the store still says `"unsent"` / `"refused"` (what a later
 * session would read), nothing is sent: that stale record would let
 * `cancelPendingSeats` drop bytes the server may hold.
 */
function writeAhead(ctx: Ctx, entry: StoredPublish): StoredPublish {
  const sent: StoredPublish = { ...entry, answer: "sent" };
  persist(ctx, sent);
  const now = readStored(ctx);
  if (
    now !== null &&
    now !== "corrupt" &&
    (now.answer === "unsent" || now.answer === "refused")
  ) {
    throw clientFailure("publish_not_persisted");
  }
  return sent;
}

/**
 * PUT the SAME list bytes until resolved (design 4.9), then finish. With a
 * `reason`, every attempt carries it as `X-Audit-Log-Reason`.
 *
 * FX-R: a recovery entry is PUT only by `recoverOwnership` (`ctx.recovery`),
 * which first makes sure this device holds a leaf in the open group (the
 * server's 4.3 step 5b checks it, #213); any other flow refuses rather than
 * send it without the successor. Past `retryBudget` transient answers the
 * call rejects and the entry stays (the next call resumes it).
 */
async function publishSeats(
  ctx: Ctx,
  entry: StoredPublish,
  reason: string | null,
) {
  const { signed } = entry;
  if (entry.recovery === true) {
    if (ctx.recovery === undefined) throw clientFailure("publish_in_flight");
    await ctx.recovery.ensureLeaf();
  }
  let current = entry;
  for (let failures = 0; ; failures++) {
    // F3: no PUT of these bytes so far was possibly accepted.
    const clean = current.answer === "unsent" || current.answer === "refused";
    current = writeAhead(ctx, current);
    const answer = await request(
      ctx,
      "PUT",
      `/channels/${ctx.channelId}/seats`,
      dataSeatList(signed, entry.handover),
      reasonHeader(reason),
    );
    const step = publishStep(answer, { op: "seats", failures });
    if (step.kind === "resend") {
      if (clean && step.cause === "rate_limited") {
        // A 429 never reached the route: still never accepted.
        current = { ...current, answer: "refused" };
        persist(ctx, current);
      }
      if (overBudget(ctx, failures)) throw transientFailure(answer);
      await pause(ctx, step.delayMs);
      continue;
    }
    if (refusedForReason(step, answer) && answer.kind === "response") {
      // Still unresolved: keep the bytes (nothing new may be signed) and
      // let the caller come back with a reason. Ids only (D16).
      current = {
        ...current,
        reasonRequired: true,
        answer: clean ? "refused" : "sent",
      };
      persist(ctx, current);
      ctx.port.log("warn", "[protected] seat list needs a removal reason", {
        channelId: ctx.channelId,
      });
      throw serverFailure(answer.response);
    }
    clearStored(ctx);
    if (step.kind === "resolved_ok") break;
    // `resolved_refused` (a seat PUT 4xx is a genuine refusal); a
    // `read_back` never comes for op "seats", refuse it the same way.
    // W2 C1 `SeatListNamesRemovedUsers` resolves like any other: these
    // bytes are never re-sent and nothing is re-signed here. `_sign`
    // persisted nothing and the D7c entry is gone, so the owner's next
    // `setSeats` GETs and verifies the server's current list before it
    // signs (no SeatListBehind); re-adding a removed user is a new growth.
    if (
      step.kind === "resolved_refused" &&
      step.type === "SeatListNamesRemovedUsers" &&
      answer.kind === "response"
    ) {
      const body = answer.response.body;
      const users = isRecord(body) ? body.users : null;
      // ids and a count only (D16)
      ctx.port.log("warn", "[protected] seat list names removed users", {
        channelId: ctx.channelId,
        count: Array.isArray(users) ? users.length : 0,
      });
    }
    throw answer.kind === "response"
      ? serverFailure(answer.response)
      : clientFailure("publish_refused");
  }
  await finishSeats(ctx);
}

/** D7c crash rule for a stored seat publish: GET first. */
async function resolveStoredSeats(
  ctx: Ctx,
  entry: StoredPublish,
  reason: string | null,
) {
  const { signed } = entry;
  const snap = await readSeats(ctx);
  const l = snap.list;
  if (
    l !== null &&
    l.version === signed.version &&
    l.body === signed.body &&
    l.signature === signed.signature
  ) {
    clearStored(ctx);
    await finishSeats(ctx);
    return;
  }
  if (l !== null && l.version === signed.version - 1) {
    // not landed: re-send the SAME bytes (with the reason, if given now)
    await publishSeats(ctx, entry, reason);
    return;
  }
  clearStored(ctx);
  throw clientFailure("publish_refused");
}

// ---------------------------------------------------------------------------
// Shared entry
// ---------------------------------------------------------------------------

/**
 * FX-R: whether a stored publish takes the caller's reason header on its
 * re-PUT. Only a plain seat publish can unseat anyone; an owner-devices,
 * handover or recovery publish keeps the seats it was signed over and
 * never carries another flow's reason; nor does an S4 history publish.
 */
function carriesReason(e: StoredPublish): boolean {
  return (
    e.ownerDevices !== true &&
    e.handover === undefined &&
    e.recovery !== true &&
    e.history === undefined
  );
}

/**
 * Resolve a stored (unresolved) publish first; returns the entry it
 * resolved, or null. `reason` rides on a stored plain seat publish's
 * re-PUT only (`carriesReason`). S4: a stored boundary protect that landed
 * answers as a protect entry; a stored wipe list is finished or dropped
 * (`settleStoredWipe`), never sent, and never answers as an entry.
 */
async function resumeStored(
  ctx: Ctx,
  reason: string | null,
): Promise<StoredPublish | null> {
  // S4: the two history shapes first (`readStored` calls both corrupt).
  const history = readHistoryEntry(ctx);
  if (history !== null && history.op === "protect") {
    const landed = await resumeJournal(ctx, history);
    return landed === null ? null : { v: 1, op: "protect", signed: landed };
  }
  if (history !== null) {
    await settleStoredWipe(ctx, history);
    return null;
  }
  const stored = readStored(ctx);
  if (stored === null) return null;
  if (stored === "corrupt") {
    // The bytes are lost: the caller's GET-first path applies (D7c).
    clearStored(ctx);
    ctx.port.log("warn", "[protected] corrupt stored publish dropped", {
      channelId: ctx.channelId,
    });
    return null;
  }
  const resentReason = carriesReason(stored) ? reason : null;
  if (stored.op === "protect") await resolveProtect(ctx, stored.signed, true);
  else await resolveStoredSeats(ctx, stored, resentReason);
  return stored;
}

// ---------------------------------------------------------------------------
// S2 list format (rule j)
// ---------------------------------------------------------------------------

/**
 * `formats_v2` as the bridge reads it (root advert, never a per-channel
 * server field), read at sign time (ruling D6). An absent method or any
 * answer but `true` is off: every list stays on native's choice (S1).
 */
function formatsV2On(port: ProtectedTextPort): boolean {
  return port.formatsV2?.() === true;
}

/**
 * The format of the list this device holds, from the body it has just
 * verified (verify adopts it, so it IS the held list). null: neither
 * context line, so nothing is asked of native.
 */
function heldFormat(list: { body: string }): 1 | 2 | null {
  const context = list.body.split("\n", 1)[0];
  if (context === "sloga-seat-list-v1") return 1;
  if (context === "sloga-seat-list-v2") return 2;
  return null;
}

/**
 * Rule (j): `2` only for a genesis (`"genesis"`: no list) or the first
 * list over a held v1, and only while `formats_v2` is on; else null (a
 * held v2 stays v2 natively, and native refuses `1` under v2).
 */
function nextFormat(
  port: ProtectedTextPort,
  held: { body: string } | "genesis",
): 2 | null {
  if (!formatsV2On(port)) return null;
  return held === "genesis" || heldFormat(held) === 1 ? 2 : null;
}

/**
 * `signAllowed` from THIS module's records: `memo` holds every publish
 * persisted in this session and not yet resolved, and the store holds one
 * from an earlier session. `ManagerState.publishInFlight` is NOT read: the
 * manager raises it around its own call into these flows, so reading it
 * here would refuse every sign. Concurrent flows are refused by `run`.
 */
function assertSignAllowed(ctx: Ctx): void {
  const ok = signAllowed({
    publishInFlight: memo.has(ctx.key),
    storedPublish: ctx.port.store.get(ctx.key),
  });
  if (!ok) throw clientFailure("publish_in_flight");
}

function validSeatsArgs(seats: unknown, deviceCap: unknown): boolean {
  return (
    Array.isArray(seats) &&
    seats.every((s) => typeof s === "string" && s.length > 0) &&
    typeof deviceCap === "number" &&
    Number.isSafeInteger(deviceCap) &&
    deviceCap >= 0
  );
}

/**
 * `setSeats`' `reason`: the caller already ran `validReason(s, "header")`
 * and passes its `.reason`. Not re-validated here; only a blank one is
 * refused, which `textApi` would otherwise send as no header at all.
 */
function validReasonArg(reason: unknown): boolean {
  return (
    reason === undefined || (typeof reason === "string" && reason.trim() !== "")
  );
}

function validDeviceIds(ids: unknown): ids is string[] {
  return (
    Array.isArray(ids) &&
    ids.length > 0 &&
    ids.every((d) => typeof d === "string" && d.length > 0)
  );
}

async function run(
  ops: GroupOps,
  port: ProtectedTextPort,
  channelId: string,
  fn: (ctx: Ctx) => Promise<void>,
): Promise<void> {
  const key = publishStoreKey(port.selfUserId, channelId);
  if (running.has(key)) throw clientFailure("publish_in_flight");
  const info = port.channelInfo(channelId);
  if (info === null || info.serverOwnerId === null) {
    throw clientFailure("channel_unknown");
  }
  running.add(key);
  try {
    await fn({
      ops,
      port,
      channelId,
      key,
      serverOwnerId: info.serverOwnerId,
      channelName: info.name,
      signal: new AbortController().signal,
    });
  } catch (e) {
    throw toFailure(e);
  } finally {
    running.delete(key);
  }
}

// ---------------------------------------------------------------------------
// S4: history (design 4.9 "S4")
// ---------------------------------------------------------------------------

/**
 * `history_setting` as the bridge reads it (root advert, R-W4-9), read at
 * call time. An absent method or any answer but `true` is off. A boundary,
 * a `history` line and a wipe all need a v2 list, so `formats_v2` has to be
 * on as well.
 */
function historySettingOn(port: ProtectedTextPort): boolean {
  return port.historySetting?.() === true && formatsV2On(port);
}

/**
 * Refuse an S4 owner call while the setting is off. The UI offers none of
 * them then, so this is a caller defect: loud, and before any request.
 */
function assertHistorySetting(port: ProtectedTextPort, channelId: string) {
  if (historySettingOn(port)) return;
  port.log("error", "[protected] history call with history_setting off", {
    channelId,
  });
  throw clientFailure("history_setting_off");
}

/** `protect`'s `opts`: absent, or both members booleans; a wipe needs history. */
function validProtectOpts(opts: unknown): boolean {
  if (opts === undefined) return true;
  if (!isRecord(opts)) return false;
  if (typeof opts.withHistory !== "boolean") return false;
  if (typeof opts.wipe !== "boolean") return false;
  return opts.withHistory || !opts.wipe;
}

/**
 * The value of a signed body's `key:` line, or null unless there is exactly
 * one. Read for local checks only (is the answer the list that was asked
 * for); native and the server parse the body strictly.
 */
function bodyLine(body: string, key: string): string | null {
  const lines = body.split("\n").filter((l) => l.startsWith(`${key}:`));
  return lines.length === 1 ? lines[0].slice(key.length + 1) : null;
}

/** Whether a signed body seats `userId` and nobody else. */
function seatsOnly(list: { body: string }, userId: string): boolean {
  return bodyLine(list.body, "seats") === userId;
}

/** A message id (a ULID), as `publishStep` and native accept one. */
const MESSAGE_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/**
 * The id of the channel's newest message (the boundary B), or null for a
 * channel without messages. Read like the seats: a transient or unreadable
 * answer is retried with backoff, a definitive 4xx rejects.
 */
async function newestMessageId(ctx: Ctx): Promise<string | null> {
  const path = `/channels/${ctx.channelId}/messages?limit=1&sort=Latest`;
  for (let failures = 0; ; failures++) {
    const a = await request(ctx, "GET", path);
    if (a.kind === "response") {
      const { status, body } = a.response;
      if (is2xx(status)) {
        let rows: unknown[] | null = null;
        if (Array.isArray(body)) rows = body;
        else if (isRecord(body) && Array.isArray(body.messages)) {
          rows = body.messages;
        }
        if (rows !== null && rows.length === 0) return null;
        const first: unknown = rows === null ? null : rows[0];
        const id = isRecord(first) ? first._id : null;
        if (typeof id === "string" && MESSAGE_ID.test(id)) return id;
      } else if (status >= 400 && status < 500 && status !== 429) {
        throw serverFailure(a.response);
      }
    }
    await pause(ctx, publishBackoffMs(failures));
  }
}

const HISTORY_SIGN_FIELDS: readonly unknown[] = [
  "history",
  "history_boundary",
  "pre_history",
  "seats",
];

/**
 * `_seat_list_sign` for a list that says something about history; any
 * dialog (growth, wipe) is native's, inside this call. Two refusals are
 * named here: a boundary ahead of this device's clock is `clock_behind`,
 * and an S4 argument native calls invalid is a defect in this module,
 * logged loudly. `declined` and everything else pass through unchanged.
 */
async function signHistoryList(
  ctx: Ctx,
  list: {
    seats: string[];
    deviceCap: number;
    serverList: ServerSeatList | null;
    format: number | null;
  },
  op: HistorySignOp,
): Promise<unknown> {
  const history = historySignArgs(op);
  try {
    return await ctx.port.invoke("e2ee_text_seat_list_sign", {
      channelId: ctx.channelId,
      userId: ctx.port.selfUserId,
      seats: list.seats,
      deviceCap: list.deviceCap,
      serverList: list.serverList,
      format: list.format,
      authority: null,
      recovery: false,
      ...history,
      channelName: ctx.channelName,
      displayNames: ctx.port.displayNames(list.seats),
    });
  } catch (e) {
    const err = nativeErrorOf(e);
    if (err?.type === "seat_list_invalid" && err.reason === "future_boundary") {
      throw clientFailure("clock_behind");
    }
    if (
      err?.type === "invalid_argument" &&
      HISTORY_SIGN_FIELDS.includes(err.field)
    ) {
      ctx.port.log("error", "[protected] history sign arguments refused", {
        channelId: ctx.channelId,
        op: op.kind,
      });
    }
    throw toFailure(e);
  }
}

/**
 * Sign the owner-only v2 genesis over `boundary` (native refuses any other
 * seat on a boundary genesis). The answer must be the list asked for: this
 * device's version 1, v2, seating the signer alone, with that boundary and
 * the `pre_history` the caller chose; else nothing is stored or sent.
 */
async function signBoundaryGenesis(
  ctx: Ctx,
  boundary: string,
  deviceCap: number,
  wipe: boolean,
): Promise<SignedSeatList> {
  const self = ctx.port.selfUserId;
  const raw = await signHistoryList(
    ctx,
    {
      seats: [self],
      deviceCap,
      serverList: null,
      format: nextFormat(ctx.port, "genesis"),
    },
    wipe
      ? { kind: "genesis_wiped", boundary }
      : { kind: "genesis_kept", boundary },
  );
  const signed = parseSigned(raw);
  if (
    signed === null ||
    signed.version !== 1 ||
    !isOwn(ctx, signed) ||
    heldFormat(signed) !== 2 ||
    !seatsOnly(signed, self) ||
    bodyLine(signed.body, "history_boundary") !== boundary ||
    bodyLine(signed.body, "pre_history") !== (wipe ? "wiped" : "kept")
  ) {
    throw clientFailure("protect_failed");
  }
  return signed;
}

/** The two S4 shapes of a stored entry; null for anything else. */
function readHistoryEntry(ctx: StoreAt): ProtectJournalV2 | StoredWipe | null {
  const raw = ctx.port.store.get(ctx.key) ?? memo.get(ctx.key) ?? null;
  if (raw === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(v)) return null;
  if (v.op === "protect" && v.v === 2) return readProtectJournal(v);
  if (v.op === "wipe" && v.v === 1) {
    const signed = parseSigned(v.signed);
    // Anything but a stored `false` reads as "may have been sent".
    return signed === null
      ? null
      : { v: 1, op: "wipe", signed, sent: v.sent !== false };
  }
  return null;
}

type JournalReadBack =
  | { kind: "landed"; list: ServerList; snap: SeatsSnapshot }
  | { kind: "none" }
  | { kind: "other" };

/**
 * Read back a boundary protect (S4-RR-5), retried while transient. `none`:
 * the channel is not protected or holds no list. `landed`: the server's
 * list is one of `geneses`; the caller verifies THAT list (the read-back
 * one), since this does not say which genesis it was. `other`: anything
 * else a definitive answer can be.
 */
async function journalReadBack(
  ctx: Ctx,
  geneses: readonly SignedSeatList[],
): Promise<JournalReadBack> {
  for (let failures = 0; ; failures++) {
    const ch = await request(ctx, "GET", `/channels/${ctx.channelId}`);
    const seats = await request(ctx, "GET", `/channels/${ctx.channelId}/seats`);
    // The policy's read-back says whether both reads are definitive and
    // whether a list is there at all; which genesis is `protectLanded`'s.
    const rb = resolveProtectReadBack({
      channel: ch.kind === "response" ? ch.response : null,
      seats: seats.kind === "response" ? seats.response : null,
      genesis: geneses[0],
    });
    if (rb.kind !== "retry") {
      if (rb.kind === "refused") {
        if (rb.reason === "not_protected" || rb.reason === "no_list") {
          return { kind: "none" };
        }
        if (rb.reason !== "different_list") return { kind: "other" };
      }
      const snap =
        seats.kind === "response" ? parseSeats(seats.response.body) : null;
      const list = snap?.list ?? null;
      if (snap === null || list === null) return { kind: "other" };
      return protectLanded(list, geneses) === "landed"
        ? { kind: "landed", list, snap }
        : { kind: "other" };
    }
    await pause(ctx, publishBackoffMs(failures));
  }
}

/** The landed read-back list: verify it (the self-pin), then generation 0. */
async function finishLanded(
  ctx: Ctx,
  rb: Extract<JournalReadBack, { kind: "landed" }>,
): Promise<void> {
  await finishGenesis(
    ctx,
    rb.list,
    rb.snap.asOfEpoch,
    rb.snap.asOfGroupId,
    rb.snap.asOfGeneration,
  );
}

function protectRefused(ctx: Ctx, reason: string): TextFlowFailure {
  ctx.port.log("warn", "[protected] protect refused", {
    channelId: ctx.channelId,
    reason,
  });
  return clientFailure("protect_failed");
}

function isAborted(e: unknown): boolean {
  return isRecord(e) && e.source === "client" && e.reason === "aborted";
}

/**
 * A boundary protect stops signing: `protect_busy`, or the re-sign or the
 * boundary read failed (`cause`). That is not a resolution: an earlier
 * genesis may be what the server holds, so read back before the stored
 * entry goes. Landed: finish it (the protect succeeded). Else reject with
 * `cause`. An abort keeps the entry for the next flow.
 */
async function giveUp(
  ctx: Ctx,
  geneses: readonly SignedSeatList[],
  cause: unknown,
): Promise<void> {
  if (isAborted(cause)) throw cause;
  const rb = await journalReadBack(ctx, geneses);
  clearStored(ctx);
  if (rb.kind !== "landed") throw cause;
  await finishLanded(ctx, rb);
}

/**
 * Protect a channel that has messages (R-W4-11): sign the owner-only
 * genesis over `boundary`, store it, PUT it. `publishStep` decides each
 * answer:
 * - a 429 re-sends the SAME bytes; a 5xx or a lost answer reads back first
 *   (landed = done) and then re-sends the SAME bytes;
 * - `ProtectHistoryMoved`: read the newest message id again and sign a new
 *   genesis over it, appended to the stored entry BEFORE its PUT. This
 *   re-sign does not pass `assertSignAllowed`: the entry it would refuse is
 *   this protect's own. A wiped re-sign is covered by native's short wipe
 *   consent, or native asks again;
 * - anything else resolves by read-back against EVERY genesis signed here.
 * `wipe_history` rides only on bytes signed `pre_history:wiped` for a
 * caller that asked for the wipe (`protectBody` throws on a mismatch).
 */
async function protectFromBoundary(
  ctx: Ctx,
  first: string,
  deviceCap: number,
  wipe: boolean,
): Promise<void> {
  let boundary = first;
  let geneses = [await signBoundaryGenesis(ctx, boundary, deviceCap, wipe)];
  persist(ctx, { v: 2, op: "protect", geneses, wipe });
  for (let failures = 0; ; failures++) {
    const signed = geneses[geneses.length - 1];
    const answer = await request(
      ctx,
      "PUT",
      `/channels/${ctx.channelId}/protect`,
      { ...protectBody(signed, wipe), seat_list: dataSeatList(signed) },
    );
    const history = { attempt: geneses.length, boundary };
    const step = publishStep(answer, { op: "protect", failures, history });
    if (step.kind === "resend") {
      await pause(ctx, step.delayMs);
      if (step.cause === "rate_limited") continue;
      const rb = await journalReadBack(ctx, geneses);
      if (rb.kind === "none") continue;
      clearStored(ctx);
      if (rb.kind === "other") throw protectRefused(ctx, "different_list");
      await finishLanded(ctx, rb);
      return;
    }
    if (step.kind === "failed") {
      await giveUp(ctx, geneses, clientFailure("protect_busy"));
      return;
    }
    if (step.kind !== "resign") break;
    let fresh: SignedSeatList;
    let next: string | null;
    try {
      next = await newestMessageId(ctx);
      const again = publishStep(
        { kind: "reread", boundary: next },
        { op: "protect", failures, history },
      );
      if (again.kind !== "resign" || next === null) {
        throw clientFailure("protect_busy");
      }
      fresh = await signBoundaryGenesis(ctx, next, deviceCap, wipe);
    } catch (e) {
      await giveUp(ctx, geneses, e);
      return;
    }
    boundary = next;
    geneses = [...geneses, fresh];
    persist(ctx, { v: 2, op: "protect", geneses, wipe });
    failures = -1;
  }
  const rb = await journalReadBack(ctx, geneses);
  clearStored(ctx);
  if (rb.kind !== "landed") throw protectRefused(ctx, rb.kind);
  await finishLanded(ctx, rb);
}

/**
 * A stored boundary protect from an earlier call (a restart, an abort).
 * Nothing is signed here. Read back first: landed = verify and finish
 * (the list is returned); a foreign list = refused. Not landed: a `kept`
 * genesis is re-sent with the SAME bytes, as the S2 entry is (the newest
 * one; its answer resolves by read-back, and a moved boundary is then a
 * refusal). An entry signed with a wipe is NEVER re-sent from here: a wipe
 * goes out only in the call that asked for it. It is dropped (null), and
 * the caller's GET-first path runs.
 */
async function resumeJournal(
  ctx: Ctx,
  journal: ProtectJournalV2,
): Promise<SignedSeatList | null> {
  const { geneses } = journal;
  const last = geneses[geneses.length - 1];
  const wiped =
    journal.wipe ||
    geneses.some((g) => bodyLine(g.body, "pre_history") !== "kept");
  for (let failures = 0; ; failures++) {
    const rb = await journalReadBack(ctx, geneses);
    if (rb.kind === "landed") {
      clearStored(ctx);
      await finishLanded(ctx, rb);
      return rb.list;
    }
    if (rb.kind === "other") {
      clearStored(ctx);
      throw protectRefused(ctx, "different_list");
    }
    if (wiped) {
      clearStored(ctx);
      ctx.port.log("warn", "[protected] unfinished wipe protect dropped", {
        channelId: ctx.channelId,
      });
      return null;
    }
    const answer = await request(
      ctx,
      "PUT",
      `/channels/${ctx.channelId}/protect`,
      { seat_list: dataSeatList(last) },
    );
    const step = publishStep(answer, { op: "protect", failures });
    if (step.kind !== "resend") break;
    await pause(ctx, step.delayMs);
  }
  const rb = await journalReadBack(ctx, geneses);
  clearStored(ctx);
  if (rb.kind !== "landed") throw protectRefused(ctx, rb.kind);
  await finishLanded(ctx, rb);
  return rb.list;
}

/**
 * F3's write-ahead for the wipe list: `sent` is stored BEFORE the POST. If
 * that write failed and the store still says unsent, nothing is sent: a
 * later flow would drop bytes the server may hold.
 */
function wipeWriteAhead(ctx: Ctx, entry: StoredWipe): StoredWipe {
  const sent: StoredWipe = { ...entry, sent: true };
  persist(ctx, sent);
  const now = readHistoryEntry(ctx);
  if (now !== null && now.op === "wipe" && !now.sent) {
    throw clientFailure("publish_not_persisted");
  }
  return sent;
}

/**
 * POST the SAME wipe-list bytes until resolved, then read back and verify
 * as after any seat list. A 429, a 5xx or a lost answer re-sends them (the
 * server answers a byte-identical retry without writing again). A 4xx is a
 * refusal and uses the bytes up: a plain `InvalidOperation` (a legal hold,
 * no boundary) is `wipe_refused`, any other keeps its server type.
 */
async function postWipe(ctx: Ctx, entry: StoredWipe): Promise<void> {
  const sent = wipeWriteAhead(ctx, entry);
  for (let failures = 0; ; failures++) {
    const answer = await request(
      ctx,
      "POST",
      `/channels/${ctx.channelId}/history_wipe`,
      dataSeatList(sent.signed),
    );
    const step = publishStep(answer, { op: "seats", failures });
    if (step.kind === "resend") {
      await pause(ctx, step.delayMs);
      continue;
    }
    clearStored(ctx);
    if (step.kind === "resolved_ok") break;
    if (answer.kind !== "response") throw clientFailure("publish_refused");
    if (step.kind === "resolved_refused" && step.type === "InvalidOperation") {
      ctx.port.log("warn", "[protected] history wipe refused", {
        channelId: ctx.channelId,
      });
      throw clientFailure("wipe_refused");
    }
    throw serverFailure(answer.response);
  }
  await finishSeats(ctx);
}

/**
 * A stored wipe list from an earlier call, GET first (D7c). Nothing is
 * signed or sent here, whoever calls (R-W4-34): a wipe request goes out
 * only in the call that showed native's dialog for it.
 * - On the server already: finish it (verify, removals). Returns true.
 * - Anything else (not landed yet, or overtaken by another list): the bytes
 *   are dropped and the caller carries on over what the server holds.
 *   Returns false. No flow is held up by one (R-W4-28: an unseat must not
 *   wait behind a wipe whose answer was lost), and an overtaken one fails
 *   nothing: the caller reads the server's list itself.
 * Dropping is a clean continue because native keeps nothing from a sign (a
 * list is held only once verify accepts the read-back), so the next sign
 * builds on the server's list. Re-sending instead is not an option: the
 * seat route refuses a list that moves `kept` to `wiped`, and the wipe
 * route would start a wipe nobody confirmed in this call. The cost, unlike
 * a plain seat publish (F3): if the lost request still arrives, two lists
 * of this device exist at one version. Arriving after the new list it is
 * refused as stale; arriving before it, the wipe the owner confirmed lands,
 * the new list is refused once, and the next flow builds on the wiped list.
 */
async function settleStoredWipe(ctx: Ctx, entry: StoredWipe): Promise<boolean> {
  const { signed } = entry;
  const l = (await readSeats(ctx)).list;
  if (
    l !== null &&
    l.version === signed.version &&
    l.body === signed.body &&
    l.signature === signed.signature
  ) {
    clearStored(ctx);
    await finishSeats(ctx);
    return true;
  }
  clearStored(ctx);
  ctx.port.log(
    entry.sent ? "warn" : "info",
    "[protected] history wipe not on the server: dropped",
    { channelId: ctx.channelId, sent: entry.sent },
  );
  return false;
}

/** Whether a signed body says the earlier messages are wiped. */
function signedWiped(list: { body: string }): boolean {
  return bodyLine(list.body, "pre_history") === "wiped";
}

/** What a rejection was, for a log line: its source and tag (D16). */
function failureTag(e: unknown): { source: string; tag: string | null } {
  const f = toFailure(e);
  switch (f.source) {
    case "client":
      return { source: f.source, tag: f.reason };
    case "native":
      return { source: f.source, tag: f.error.type };
    case "server":
      return { source: f.source, tag: f.type };
    default:
      return { source: f.source, tag: null };
  }
}

// ---------------------------------------------------------------------------
// Public flows (A1 `OwnerFlows`)
// ---------------------------------------------------------------------------

/**
 * Protect a channel (design 6.3 "Protect"): genesis list signed with
 * `server_list: null` (the owner is always seated), persisted, PUT until
 * resolved, read back, verified (the self-pin), then the generation-0 group.
 *
 * `opts` (S4, R-W4-11). Absent, or `withHistory: false`: exactly the flow
 * above. `withHistory: true` protects a channel that already has messages
 * (refused while `history_setting` is off): an owner-only genesis over the
 * newest message (`protectFromBoundary`), then `seats` through `setSeats`
 * with its own growth dialog. If that second step fails for any reason (a
 * declined dialog included) the channel stays protected with the owner
 * alone and this rejects `protected_members_pending` (R-W4-35); nothing is
 * rolled back. A channel that turns out to have no message is protected by
 * the flow above (no boundary, and no wipe: there is nothing to delete).
 * `wipe: true` signs the genesis `pre_history: "wiped"` behind native's
 * dialog and is valid only with `withHistory`.
 *
 * `wipe_not_done` (audit B7): the caller asked for the wipe, but the list
 * that protects the channel was signed by an earlier call (a stored entry
 * that resumed, or this device's genesis found on the server) and does not
 * say `wiped`. Nothing is signed to change that here: the channel is
 * protected, the earlier messages are still there, and the caller is told.
 * It is reported after the member step and wins over a failed one.
 */
export async function protect(
  ops: GroupOps,
  port: ProtectedTextPort,
  channelId: string,
  seats: string[],
  deviceCap: number,
  opts?: { withHistory: boolean; wipe: boolean },
): Promise<void> {
  if (!validSeatsArgs(seats, deviceCap) || !validProtectOpts(opts)) {
    throw clientFailure("invalid_argument");
  }
  const withHistory = opts?.withHistory === true;
  const wipe = withHistory && opts?.wipe === true;
  if (withHistory) assertHistorySetting(port, channelId);
  const self = port.selfUserId;
  const genesisSeats = [self, ...seats.filter((s) => s !== self)];
  const unique = [...new Set(genesisSeats)];
  // S4: the genesis that landed seats the owner alone, so the picked
  // members still need a seat list of their own.
  let ownerOnly = false;
  // B7: the list that landed is one an earlier call signed, without the
  // wipe this call asked for.
  let wipeMissed = false;
  await run(ops, port, channelId, async (ctx) => {
    const boundaryEntry = readHistoryEntry(ctx)?.op === "protect";
    const resumed = await resumeStored(ctx, null);
    if (resumed?.op === "protect") {
      ownerOnly =
        (withHistory || boundaryEntry) && seatsOnly(resumed.signed, self);
      wipeMissed = wipe && !signedWiped(resumed.signed);
      return;
    }
    assertSignAllowed(ctx);
    const snap = await readSeats(ctx);
    if (snap.list !== null) {
      // Already protected. Crash recovery (D7c, D21): this device's own
      // genesis landed but was never verified / its group never created.
      if (snap.list.version === 1 && isOwn(ctx, snap.list)) {
        await finishGenesis(
          ctx,
          snap.list,
          snap.asOfEpoch,
          snap.asOfGroupId,
          snap.asOfGeneration,
        );
        ownerOnly = withHistory && seatsOnly(snap.list, self);
        wipeMissed = wipe && !signedWiped(snap.list);
        return;
      }
      throw clientFailure("protect_failed");
    }
    if (withHistory) {
      const boundary = await newestMessageId(ctx);
      if (boundary !== null) {
        await protectFromBoundary(ctx, boundary, deviceCap, wipe);
        ownerOnly = true;
        return;
      }
      ctx.port.log("info", "[protected] no message yet: plain protect", {
        channelId,
      });
    }
    const raw = await port.invoke("e2ee_text_seat_list_sign", {
      channelId,
      userId: self,
      seats: unique,
      deviceCap,
      serverList: null,
      format: nextFormat(port, "genesis"),
      authority: null,
      recovery: false,
      ...historySignArgs({ kind: "plain" }),
      channelName: ctx.channelName,
      displayNames: port.displayNames(unique),
    });
    const signed = parseSigned(raw);
    if (signed === null || signed.version !== 1 || !isOwn(ctx, signed)) {
      throw clientFailure("protect_failed");
    }
    persist(ctx, { v: 1, op: "protect", signed });
    await publishProtect(ctx, signed);
  });
  let membersPending = false;
  if (ownerOnly && unique.length > 1) {
    try {
      await setSeats(ops, port, channelId, unique, deviceCap);
    } catch (e) {
      // R-W4-35: the protect itself went through. Whatever stopped the
      // member list (a declined dialog included), the caller hears that the
      // members are still to be added, not that protecting failed.
      membersPending = true;
      port.log("warn", "[protected] protected, members not added", {
        channelId,
        ...failureTag(e),
      });
    }
  }
  if (wipeMissed) {
    port.log("warn", "[protected] protected, the wipe asked for was not done", {
      channelId,
      membersPending,
    });
    throw clientFailure("wipe_not_done");
  }
  if (membersPending) throw clientFailure("protected_members_pending");
}

/**
 * Change the seat list (design 6.3 "Seat a member" / "Owner unseat"):
 * verify the server's current list, sign the next version from it,
 * persist, PUT until resolved, read back + verify, then Remove every leaf
 * whose user is off the new list.
 *
 * `reason` (S2 D40): the caller's already validated
 * `validReason(s, "header").reason`, sent as `X-Audit-Log-Reason` on every
 * seat PUT of this flow. When the stored publish is one the server refused
 * for its reason, that publish IS this change: it is re-sent byte for byte
 * with the reason, and nothing is signed.
 */
export async function setSeats(
  ops: GroupOps,
  port: ProtectedTextPort,
  channelId: string,
  seats: string[],
  deviceCap: number,
  reason?: string,
): Promise<void> {
  if (!validSeatsArgs(seats, deviceCap) || !validReasonArg(reason)) {
    throw clientFailure("invalid_argument");
  }
  const sentReason = reason ?? null;
  await run(ops, port, channelId, async (ctx) => {
    const resumed = await resumeStored(ctx, sentReason);
    if (resumed?.reasonRequired === true) return;
    assertSignAllowed(ctx);
    const snap = await readSeats(ctx);
    if (snap.list === null) throw clientFailure("not_protected");
    // `_sign` refuses `seat_list_behind` unless the server's list is the
    // one this device verified: verify it first (design 9.2).
    await verifyList(
      ctx,
      snap.list,
      snap.asOfEpoch,
      snap.asOfGroupId,
      snap.asOfGeneration,
    );
    const unique = [...new Set(seats)];
    const raw = await port.invoke("e2ee_text_seat_list_sign", {
      channelId,
      userId: port.selfUserId,
      seats: unique,
      deviceCap,
      serverList: { version: snap.list.version, body: snap.list.body },
      format: nextFormat(port, snap.list),
      authority: null,
      recovery: false,
      ...historySignArgs({ kind: "plain" }),
      channelName: ctx.channelName,
      displayNames: port.displayNames(unique),
    });
    const signed = parseSigned(raw);
    if (
      signed === null ||
      signed.version !== snap.list.version + 1 ||
      !isOwn(ctx, signed)
    ) {
      throw clientFailure("publish_refused");
    }
    const entry: StoredPublish = {
      v: 1,
      op: "seats",
      signed,
      answer: "unsent",
    };
    persist(ctx, entry);
    await publishSeats(ctx, entry, sentReason);
  });
}

/**
 * S2 (design 4.10, 8.3): re-sign the channel authority naming
 * `ownerDevices`, then the next seat list carrying it. Verifies the
 * server's current list first (as `setSeats`), then `_authority_sign`
 * (ALWAYS a native dialog), then `_seat_list_sign` with that authority
 * over the same seats and device cap, persists, and PUTs until resolved.
 * A retry of this flow re-sends the stored bytes (4.9): it never shows the
 * dialog again and never re-signs.
 */
export async function signOwnerDevices(
  ops: GroupOps,
  port: ProtectedTextPort,
  channelId: string,
  ownerDevices: string[],
): Promise<void> {
  if (!validDeviceIds(ownerDevices)) {
    throw clientFailure("invalid_argument");
  }
  await run(ops, port, channelId, async (ctx) => {
    const resumed = await resumeStored(ctx, null);
    if (resumed?.ownerDevices === true) return;
    assertSignAllowed(ctx);
    const snap = await readSeats(ctx);
    if (snap.list === null) throw clientFailure("not_protected");
    const verdict = await verifyList(
      ctx,
      snap.list,
      snap.asOfEpoch,
      snap.asOfGroupId,
      snap.asOfGeneration,
    );
    // An authority rides on a v2 list only (native refuses it on v1): with
    // no v2 list held and no upgrade allowed, refuse before any dialog.
    const format = nextFormat(port, snap.list);
    if (heldFormat(snap.list) !== 2 && format !== 2) {
      throw clientFailure("authority_needs_v2");
    }
    const self = port.selfUserId;
    const authority = parseAuthority(
      await port.invoke("e2ee_text_authority_sign", {
        channelId,
        userId: self,
        ownerDevices: [...ownerDevices],
        channelName: ctx.channelName,
        displayNames: port.displayNames([self]),
      }),
    );
    if (authority === null || authority === undefined) {
      throw clientFailure("publish_refused");
    }
    const raw = await port.invoke("e2ee_text_seat_list_sign", {
      channelId,
      userId: self,
      seats: verdict.seats,
      deviceCap: verdict.device_cap,
      serverList: { version: snap.list.version, body: snap.list.body },
      format,
      authority,
      recovery: false,
      ...historySignArgs({ kind: "plain" }),
      channelName: ctx.channelName,
      displayNames: port.displayNames(verdict.seats),
    });
    const signed = parseSigned(raw);
    if (
      signed === null ||
      signed.version !== snap.list.version + 1 ||
      !isOwn(ctx, signed) ||
      signed.authority?.body !== authority.body ||
      signed.authority.signature !== authority.signature
    ) {
      throw clientFailure("publish_refused");
    }
    const entry: StoredPublish = {
      v: 1,
      op: "seats",
      signed,
      ownerDevices: true,
      answer: "unsent",
    };
    persist(ctx, entry);
    await publishSeats(ctx, entry, null);
  });
}

/** Device ids of this user's listing (`GET /e2ee/devices/{self}` rows). */
function ownDeviceIds(listing: unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const row of listing) {
    if (isRecord(row) && typeof row.device_id === "string") {
      if (row.device_id !== "") ids.add(row.device_id);
    }
  }
  return ids;
}

/**
 * `_owner_handover_sign` (ALWAYS a native dialog) to `toDeviceId` of this
 * user. `identity_pin_required` for this user pins the own devices from
 * the complete listing and asks ONCE more (D18); native shows the dialog
 * only after its own checks pass. The answer must be the statement asked
 * for (this channel, from this device, to the target of this user), else
 * nothing is published.
 */
async function signHandover(
  ctx: Ctx,
  toDeviceId: string,
): Promise<SignedHandover> {
  const self = ctx.port.selfUserId;
  const args = {
    channelId: ctx.channelId,
    userId: self,
    toUserId: self,
    toDeviceId,
    channelName: ctx.channelName,
    displayNames: ctx.port.displayNames([self]),
  };
  let pinned = false;
  for (;;) {
    let raw: unknown;
    try {
      raw = await ctx.port.invoke("e2ee_text_owner_handover_sign", args);
    } catch (e) {
      const err = nativeErrorOf(e);
      if (
        err?.type === "identity_pin_required" &&
        !pinned &&
        err.user_id === self &&
        typeof err.device_id === "string"
      ) {
        pinned = true;
        await pinIdentity(ctx, self, err.device_id);
        continue;
      }
      throw toFailure(e);
    }
    const h = parseHandover(raw);
    const f = h === null ? null : handoverFields(h.body);
    if (
      h === null ||
      f === null ||
      f.get("channel_id") !== ctx.channelId ||
      f.get("from_user_id") !== self ||
      f.get("from_device_id") !== ctx.port.selfDeviceId ||
      f.get("to_user_id") !== self ||
      f.get("to_device_id") !== toDeviceId
    ) {
      throw clientFailure("publish_refused");
    }
    return h;
  }
}

/**
 * S2-D42 "Move ownership key" (design 4.6, 6.3 K0 to K1; W3 plan D19):
 * hand the owner key from THIS device to `toDeviceId`, another device of
 * this user. Same user only (S2-D4 cross-user handover is [b]).
 *
 * What native and the server require, and how it is met:
 * - Only the signing device hands over: native `_owner_handover_sign`
 *   wants this device to be the pinned owner device (`not_owner`), and the
 *   server's 4.3 step 8 wants the statement `from` the list's signer
 *   device. So the server's list must verify as signed by this device,
 *   else `not_signing_device` before any dialog.
 * - The statement rides on the NEXT list, signed by THIS device: the same
 *   seats and device cap as the verified list (no growth, so no list
 *   dialog), `serverList` = that list, no authority passed, format by rule
 *   (j). The PUT carries it as `handover`; the server appends it to the
 *   stored chain. The pin stays here until the target publishes a list it
 *   signed (it qualifies through the held chain; members walk to it).
 * - Under a served authority the chain qualifies no one (native
 *   `require_owner_device`): the target could never sign, so it is refused
 *   (`authority_held`); the owner devices change through `authoritySign`.
 * - The target must be in this user's listing (`handover_target_not_own`)
 *   and is never this device (`handover_self_target`). Native also wants
 *   it pinned and holding a leaf in the active group.
 * - Persisted with the list bytes (D7c) and PUT until resolved. A retry
 *   of the same move resumes the stored bytes and the stored statement and
 *   signs nothing (4.9).
 */
export async function moveOwnerKey(
  ops: GroupOps,
  port: ProtectedTextPort,
  channelId: string,
  toDeviceId: string,
): Promise<void> {
  if (typeof toDeviceId !== "string" || toDeviceId === "") {
    throw clientFailure("invalid_argument");
  }
  if (toDeviceId === port.selfDeviceId) {
    throw clientFailure("handover_self_target");
  }
  await run(ops, port, channelId, async (ctx) => {
    const settled = await resumeStored(ctx, null);
    if (
      settled?.handover !== undefined &&
      handoverTarget(settled.handover) === toDeviceId
    ) {
      return;
    }
    assertSignAllowed(ctx);
    const self = port.selfUserId;
    // F-R8: a target registered since the bridge cached its listing.
    const { listing } = await port.ownDeviceListing({ want: [toDeviceId] });
    if (!ownDeviceIds(listing).has(toDeviceId)) {
      throw clientFailure("handover_target_not_own");
    }
    const snap = await readSeats(ctx);
    if (snap.list === null) throw clientFailure("not_protected");
    const verdict = await verifyList(
      ctx,
      snap.list,
      snap.asOfEpoch,
      snap.asOfGroupId,
      snap.asOfGeneration,
    );
    if (
      verdict.signer_user_id !== self ||
      verdict.signer_device_id !== port.selfDeviceId
    ) {
      throw clientFailure("not_signing_device");
    }
    if (snap.list.authority !== undefined) {
      throw clientFailure("authority_held");
    }
    const handover = await signHandover(ctx, toDeviceId);
    const raw = await port.invoke("e2ee_text_seat_list_sign", {
      channelId,
      userId: self,
      seats: verdict.seats,
      deviceCap: verdict.device_cap,
      serverList: { version: snap.list.version, body: snap.list.body },
      format: nextFormat(port, snap.list),
      authority: null,
      recovery: false,
      ...historySignArgs({ kind: "plain" }),
      channelName: ctx.channelName,
      displayNames: port.displayNames(verdict.seats),
    });
    const signed = parseSigned(raw);
    if (
      signed === null ||
      signed.version !== snap.list.version + 1 ||
      !isOwn(ctx, signed) ||
      signed.authority !== undefined
    ) {
      throw clientFailure("publish_refused");
    }
    const entry: StoredPublish = {
      v: 1,
      op: "seats",
      signed,
      handover,
      answer: "unsent",
    };
    persist(ctx, entry);
    await publishSeats(ctx, entry, null);
  });
}

/**
 * S2 (d) FX-R, design 6.3 "Owner signing device lost" (S2-D17d, S2-D22,
 * #213) with 4.9 and D7c: the recovery list is a stored publish like any
 * other list this device signs.
 * - A stored recovery publish is resumed FIRST: read back
 *   (`resolveStoredSeats`: landed = finish, server one behind = the SAME
 *   bytes re-sent, anything else = dropped as refused). No dialog, nothing
 *   signed, whatever the manager's checks would say now.
 * - Otherwise another flow's stored publish resolves first (D7c), then
 *   `plan.sign` (the dialog, after the manager's checks). Its result must
 *   be a signed list of this device at the server version + 1; it is
 *   persisted BEFORE anything is created or sent, then `plan.ensureLeaf`
 *   (the successor, #213) and the PUT loop.
 * - One call gives up after `plan.retryBudget` transient answers; the
 *   entry stays, so the next call re-sends the same bytes (never a fresh
 *   signature). The manager refreshes after every call.
 * - FXO (FXL audit M1): except a stored recovery publish refused for its
 *   reason header (`dropRefusedRecovery`): no reason rides on a recovery,
 *   so it is dropped and this call signs afresh behind the dialog.
 */
export async function recoverOwnership(
  ops: GroupOps,
  port: ProtectedTextPort,
  channelId: string,
  plan: RecoveryPlan,
): Promise<void> {
  await run(ops, port, channelId, async (base) => {
    const ctx: Ctx = { ...base, recovery: plan };
    dropRefusedRecovery(base);
    const stored = readStored(base);
    if (stored !== null && stored !== "corrupt" && stored.recovery === true) {
      await resolveStoredSeats(ctx, stored, null);
      return;
    }
    await resumeStored(base, null);
    assertSignAllowed(base);
    const { signed: raw, serverVersion } = await plan.sign();
    const signed = parseSigned(raw);
    if (
      signed === null ||
      !Number.isSafeInteger(serverVersion) ||
      signed.version !== serverVersion + 1 ||
      !isOwn(base, signed)
    ) {
      throw clientFailure("publish_refused");
    }
    const entry: StoredPublish = {
      v: 1,
      op: "seats",
      signed,
      recovery: true,
      answer: "unsent",
    };
    persist(base, entry);
    await publishSeats(ctx, entry, null);
  });
}

/**
 * S4 (design 6.3 "History setting"): sign the next list with its `history`
 * line set to `visible` / `hidden` over the same seats and device cap,
 * then publish it as any seat list (`publishSeats`: same bytes until
 * resolved, read back, verify). hidden -> visible is growth, so native
 * shows its dialog inside the sign call; `declined` changes nothing.
 * Refused while `history_setting` is off. Never signed as a recovery list,
 * and an unresolved recovery publish refuses this flow like every other
 * (FX-R). A retry of the same change resumes the stored bytes: no dialog,
 * nothing signed.
 */
export async function setHistory(
  ops: GroupOps,
  port: ProtectedTextPort,
  channelId: string,
  visible: boolean,
): Promise<void> {
  if (typeof visible !== "boolean") throw clientFailure("invalid_argument");
  assertHistorySetting(port, channelId);
  const history: HistorySetting = visible ? "visible" : "hidden";
  await run(ops, port, channelId, async (ctx) => {
    const resumed = await resumeStored(ctx, null);
    if (resumed?.history === history) return;
    assertSignAllowed(ctx);
    const snap = await readSeats(ctx);
    if (snap.list === null) throw clientFailure("not_protected");
    const verdict = await verifyList(
      ctx,
      snap.list,
      snap.asOfEpoch,
      snap.asOfGroupId,
      snap.asOfGeneration,
    );
    const raw = await signHistoryList(
      ctx,
      {
        seats: verdict.seats,
        deviceCap: verdict.device_cap,
        serverList: { version: snap.list.version, body: snap.list.body },
        format: nextFormat(port, snap.list),
      },
      { kind: "set_history", history, recovery: false },
    );
    const signed = parseSigned(raw);
    if (
      signed === null ||
      signed.version !== snap.list.version + 1 ||
      !isOwn(ctx, signed) ||
      bodyLine(signed.body, "history") !== history
    ) {
      throw clientFailure("publish_refused");
    }
    const entry: StoredPublish = {
      v: 1,
      op: "seats",
      signed,
      history,
      answer: "unsent",
    };
    persist(ctx, entry);
    await publishSeats(ctx, entry, null);
  });
}

/**
 * S4 (design 4.9 "S4", S4-D20): delete the messages from before the channel
 * was protected. Signs the one-change wipe list (the held list with
 * `pre_history: "wiped"`; native's dialog is the only confirmation and
 * `declined` signs nothing), stores it, then
 * `POST /channels/:id/history_wipe`.
 * - A stored wipe list is settled FIRST (R-W4-34): on the server = done,
 *   nothing signed or sent. Otherwise it is dropped, however old, and this
 *   call signs a new list behind native's dialog: stored wipe bytes are
 *   never POSTed by a later call.
 * - Already wiped (the verified list says so, or native answers
 *   `seat_list_rollback`): done, nothing signed or sent.
 * - Refused while `history_setting` is off.
 */
export async function wipeHistory(
  ops: GroupOps,
  port: ProtectedTextPort,
  channelId: string,
): Promise<void> {
  assertHistorySetting(port, channelId);
  await run(ops, port, channelId, async (ctx) => {
    const stored = readHistoryEntry(ctx);
    if (stored !== null && stored.op === "wipe") {
      if (await settleStoredWipe(ctx, stored)) return;
    } else {
      await resumeStored(ctx, null);
    }
    assertSignAllowed(ctx);
    const snap = await readSeats(ctx);
    if (snap.list === null) throw clientFailure("not_protected");
    const verdict = await verifyList(
      ctx,
      snap.list,
      snap.asOfEpoch,
      snap.asOfGroupId,
      snap.asOfGeneration,
    );
    if (signedWiped(snap.list)) return;
    let raw: unknown;
    try {
      raw = await signHistoryList(
        ctx,
        {
          seats: verdict.seats,
          deviceCap: verdict.device_cap,
          serverList: { version: snap.list.version, body: snap.list.body },
          format: nextFormat(port, snap.list),
        },
        { kind: "wipe" },
      );
    } catch (e) {
      // Native says the wipe is already held: nothing left to do.
      if (nativeErrorOf(e)?.type === "seat_list_rollback") return;
      throw e;
    }
    const signed = parseSigned(raw);
    if (
      signed === null ||
      signed.version !== snap.list.version + 1 ||
      !isOwn(ctx, signed) ||
      !signedWiped(signed)
    ) {
      throw clientFailure("publish_refused");
    }
    const entry: StoredWipe = { v: 1, op: "wipe", signed, sent: false };
    persist(ctx, entry);
    await postWipe(ctx, entry);
  });
}

/**
 * S2 F3: whether the server NEVER took a stored seat publish, from the
 * entry alone: `answer` is `"refused"` (every PUT of these bytes was
 * refused without a write, see `StoredPublish.answer`) and the entry is one
 * the owner may abandon: refused for its reason header (`reasonRequired`)
 * or an owner-devices publish. FX-J2 NEW-4 (planner ruling): a recovery
 * publish only while `"unsent"` (no PUT of it went out: the write-ahead
 * records `"sent"` before every PUT); one whose PUTs were all answered 429
 * stays maybe-accepted, so a later recovery never signs fresh bytes for
 * that version. FXO (FXL audit M1): and a recovery publish refused for its
 * reason header (`refusedForItsReason`): no reason ever rides on one
 * (FX-R), so it can never land, and nothing else releases it. Anything
 * else, a pre-F3 entry without `answer` included, may be on the server and
 * is never dropped.
 */
function neverAccepted(e: StoredPublish): boolean {
  if (e.op !== "seats") return false;
  if (e.recovery === true && refusedForItsReason(e)) return true;
  if (e.recovery === true) return e.answer === "unsent";
  return (
    e.answer === "refused" &&
    (e.reasonRequired === true || e.ownerDevices === true)
  );
}

/**
 * FXO (FXL audit M1): every PUT of these bytes so far was refused without
 * a write (`"refused"`), at least one for its reason header. The server
 * decides 4.3 step 4d (`RemovalReasonRequired`) inside the write
 * transaction, before anything is written and after the step-4 return of
 * a byte-identical list it already holds, so it does not hold these bytes.
 */
function refusedForItsReason(e: StoredPublish): boolean {
  return e.answer === "refused" && e.reasonRequired === true;
}

/**
 * FXO (FXL audit M1): drop a stored recovery publish the server never
 * accepted and has already answered (`neverAccepted`, not `"unsent"`).
 * Re-sending it could only be refused again (no reason rides on a
 * recovery), and a re-send without an answer would leave it maybe-accepted
 * for good. `recoverOwnership` then signs afresh behind the dialog, as
 * after any other refused recovery PUT. Signs and sends nothing.
 */
function dropRefusedRecovery(ctx: Ctx): void {
  const e = readStored(ctx);
  if (e === null || e === "corrupt" || e.recovery !== true) return;
  if (e.answer === "unsent" || !neverAccepted(e)) return;
  clearStored(ctx);
  ctx.port.log("info", "[protected] refused recovery list dropped", {
    channelId: ctx.channelId,
  });
}

/**
 * The stored seat publish of a channel, or null (none, protect, corrupt).
 * FX-R: a recovery publish is not a pending seat change: only
 * `recoverOwnership` resumes it. FX-J2 NEW-4: except while no PUT of it
 * went out (`neverAccepted`: still `"unsent"`), or (FXO) every PUT of it
 * was refused without a write, one for its reason header: then F3 may
 * discard it, so a recovery entry no other owner flow may send never
 * blocks this device for good. Discarding signs nothing; a later recovery
 * is a new decision.
 */
function storedSeats(at: StoreAt): StoredPublish | null {
  const e = readStored(at);
  if (e === null || e === "corrupt" || e.op !== "seats") return null;
  return e.recovery === true && !neverAccepted(e) ? null : e;
}

/**
 * S2 F3: the stored (unresolved) seat-list publish of `channelId`, for U8's
 * "Discard this change"; null when there is none. A stored protect or an
 * unreadable entry is not a pending seat change (the next flow resolves or
 * drops it). `discardable`: `cancelPendingSeats` would discard it now.
 * Reads the D7c store only; no request, no native call.
 */
export function pendingSeats(
  port: ProtectedTextPort,
  channelId: string,
): PendingSeats | null {
  const key = publishStoreKey(port.selfUserId, channelId);
  const e = storedSeats({ port, key });
  if (e === null) return null;
  // FXO (FXL audit M1): no reason rides on a recovery publish (FX-R), so
  // none is asked for: one would release a user the recovery dialog never
  // named. Offered for discard only.
  if (e.recovery === true) {
    return {
      kind: "seats",
      reasonRequired: false,
      discardable: neverAccepted(e) && !running.has(key),
    };
  }
  return {
    kind: e.ownerDevices === true ? "owner_devices" : "seats",
    reasonRequired: e.reasonRequired === true,
    discardable: neverAccepted(e) && !running.has(key),
  };
}

/**
 * S2 F3: discard the stored seat publish of `channelId` ONLY if the server
 * never accepted it (`neverAccepted`: the stored entry plus its recorded
 * answers, see `StoredPublish.answer`). `busy`: an owner flow on the
 * channel is running (a PUT may be in flight); `maybe_accepted`: the bytes
 * stay and the next owner flow resumes them as before (same bytes, D7c).
 * Signs nothing, sends nothing; ids only in the log (D16).
 */
export function cancelPendingSeats(
  port: ProtectedTextPort,
  channelId: string,
): CancelPendingSeatsResult {
  const key = publishStoreKey(port.selfUserId, channelId);
  const at = { port, key };
  const e = storedSeats(at);
  if (e === null) return { discarded: false, why: "none" };
  if (running.has(key)) return { discarded: false, why: "busy" };
  if (!neverAccepted(e)) {
    port.log("info", "[protected] pending seat list kept (maybe accepted)", {
      channelId,
    });
    return { discarded: false, why: "maybe_accepted" };
  }
  clearStored(at);
  port.log("info", "[protected] pending seat list discarded", { channelId });
  return { discarded: true };
}

/**
 * S2 (R27): the owner devices to offer when the server reports
 * `revoked_owner_devices` (owner callers only): the served authority's
 * `owner_devices` without the revoked ones, plus this device (native
 * requires the signer in the set), sorted. null when there is nothing to
 * offer: no revoked device of that authority, no authority, an unreadable
 * `owner_devices` line, this device among the revoked, or more than 5
 * devices. A proposal only: the `_authority_sign` dialog names every device
 * kept and dropped, and native checks every entry. The UI shows the banner
 * and calls `authoritySign`.
 */
export function proposedOwnerDevices(
  seats: ProtectedSeatsResponse | null,
  selfDeviceId: string,
): string[] | null {
  const revoked = seats?.revoked_owner_devices;
  const authority = seats?.list?.authority;
  if (!Array.isArray(revoked) || revoked.length === 0 || !authority) {
    return null;
  }
  if (typeof authority.body !== "string") return null;
  const line = authority.body
    .split("\n")
    .find((l) => l.startsWith("owner_devices:"));
  if (line === undefined) return null;
  const entries = line.slice("owner_devices:".length).split(",");
  const listed: string[] = [];
  for (const e of entries) {
    const dot = e.indexOf(".");
    if (dot <= 0) return null;
    listed.push(e.slice(0, dot));
  }
  const gone = new Set(revoked.filter((d) => typeof d === "string"));
  // This device reported revoked cannot sign the fix: offer nothing.
  if (gone.has(selfDeviceId)) return null;
  const kept = listed.filter((d) => !gone.has(d));
  if (kept.length === listed.length) return null;
  const next = [...new Set([...kept, selfDeviceId])].sort();
  return next.length <= 5 ? next : null;
}

/**
 * S2-D42: the devices "Move ownership key" may offer as targets: this
 * user's OTHER devices from `ownDevices` (the own listing's device ids),
 * in their order, without repeats. Empty unless the served list was signed
 * by this device and carries no authority (`moveOwnerKey` refuses
 * otherwise). Native still checks each target (pinned, holding a leaf in
 * the active group). Ids are for comparisons only: the UI shows the
 * matching session names, never an id.
 */
export function ownerKeyMoveTargets(
  seats: ProtectedSeatsResponse | null,
  selfDeviceId: string | null,
  ownDevices: readonly string[],
): string[] {
  const list = seats?.list ?? null;
  if (selfDeviceId === null || selfDeviceId === "" || list === null) {
    return [];
  }
  if (list.signer_device_id !== selfDeviceId || list.authority) return [];
  const targets: string[] = [];
  for (const d of ownDevices) {
    if (typeof d !== "string" || d === "" || d === selfDeviceId) continue;
    if (!targets.includes(d)) targets.push(d);
  }
  return targets;
}

/** Test hook: forget in-memory state (never called by the app). */
export function _resetOwnerFlowsForTest(): void {
  memo.clear();
  running.clear();
}
