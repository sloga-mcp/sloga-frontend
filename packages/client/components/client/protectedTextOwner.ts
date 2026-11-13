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
 *
 * Pure of Solid / livekit / lingui; driven through `GroupOps` and the port,
 * so `node --test --conditions=browser` loads it over fakes.
 */
import type { MlsMemberDevice } from "./e2ee";
import { reasonRefusal } from "./protectedRemovalReasonPolicy.ts";
import {
  type ProtectReadBack,
  type PublishAnswer,
  type PublishOp,
  type PublishStep,
  publishBackoffMs,
  publishStep,
  resolveProtectReadBack,
  signAllowed,
} from "./protectedTextPolicy.ts";
import type {
  CancelPendingSeatsResult,
  GroupOps,
  NativeError,
  PendingSeats,
  ProtectedSeatsResponse,
  ProtectedTextPort,
  RecoveryPlan,
  SeatListInput,
  SeatListVerdict,
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
   * flow may resolve it by read-back, never PUT it. Never discarded by F3.
   */
  recovery?: true;
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
    };
  } catch {
    return "corrupt";
  }
}

function persist(ctx: Ctx, entry: StoredPublish): void {
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
    const { listing } = await ctx.port.ownDeviceListing();
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
 * never carries another flow's reason.
 */
function carriesReason(e: StoredPublish): boolean {
  return (
    e.ownerDevices !== true && e.handover === undefined && e.recovery !== true
  );
}

/**
 * Resolve a stored (unresolved) publish first; returns the entry it
 * resolved, or null. `reason` rides on a stored plain seat publish's
 * re-PUT only (`carriesReason`).
 */
async function resumeStored(
  ctx: Ctx,
  reason: string | null,
): Promise<StoredPublish | null> {
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
// Public flows (A1 `OwnerFlows`)
// ---------------------------------------------------------------------------

/**
 * Protect a channel (design 6.3 "Protect"): genesis list signed with
 * `server_list: null` (the owner is always seated), persisted, PUT until
 * resolved, read back, verified (the self-pin), then the generation-0 group.
 */
export async function protect(
  ops: GroupOps,
  port: ProtectedTextPort,
  channelId: string,
  seats: string[],
  deviceCap: number,
): Promise<void> {
  if (!validSeatsArgs(seats, deviceCap)) {
    throw clientFailure("invalid_argument");
  }
  await run(ops, port, channelId, async (ctx) => {
    if ((await resumeStored(ctx, null))?.op === "protect") return;
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
        return;
      }
      throw clientFailure("protect_failed");
    }
    const self = port.selfUserId;
    const genesisSeats = [self, ...seats.filter((s) => s !== self)];
    const unique = [...new Set(genesisSeats)];
    const raw = await port.invoke("e2ee_text_seat_list_sign", {
      channelId,
      userId: self,
      seats: unique,
      deviceCap,
      serverList: null,
      format: nextFormat(port, "genesis"),
      authority: null,
      recovery: false,
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
    const { listing } = await port.ownDeviceListing();
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
 */
export async function recoverOwnership(
  ops: GroupOps,
  port: ProtectedTextPort,
  channelId: string,
  plan: RecoveryPlan,
): Promise<void> {
  await run(ops, port, channelId, async (base) => {
    const ctx: Ctx = { ...base, recovery: plan };
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
 * S2 F3: whether the server NEVER took a stored seat publish, from the
 * entry alone: `answer` is `"refused"` (every PUT of these bytes was
 * refused without a write, see `StoredPublish.answer`) and the entry is one
 * the owner may abandon: refused for its reason header (`reasonRequired`)
 * or an owner-devices publish. FX-J2 NEW-4 (planner ruling): a recovery
 * publish only while `"unsent"` (no PUT of it went out: the write-ahead
 * records `"sent"` before every PUT); one whose PUTs were all answered 429
 * stays maybe-accepted, so a later recovery never signs fresh bytes for
 * that version. Anything else, a pre-F3 entry without `answer` included,
 * may be on the server and is never dropped.
 */
function neverAccepted(e: StoredPublish): boolean {
  if (e.op !== "seats") return false;
  if (e.recovery === true) return e.answer === "unsent";
  return (
    e.answer === "refused" &&
    (e.reasonRequired === true || e.ownerDevices === true)
  );
}

/**
 * The stored seat publish of a channel, or null (none, protect, corrupt).
 * FX-R: a recovery publish is not a pending seat change: only
 * `recoverOwnership` resumes it. FX-J2 NEW-4: except while no PUT of it
 * went out (`neverAccepted`: still `"unsent"`): then F3 may discard it, so
 * a recovery entry no other owner flow may send never blocks this device
 * for good. Discarding signs nothing; a later recovery is a new decision.
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
