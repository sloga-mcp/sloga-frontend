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
 * The `DataSeatList` body of a PUT (no handover in S1). S2: `authority`
 * whenever the signed list carries one (design 4.3 step 3b).
 */
function dataSeatList(s: SignedSeatList) {
  return {
    body: s.body,
    signature: s.signature,
    signer_device_id: s.signer_device_id,
    ...withAuthority(s.authority),
  };
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
 */
async function publishSeats(
  ctx: Ctx,
  entry: StoredPublish,
  reason: string | null,
) {
  const { signed } = entry;
  let current = entry;
  for (let failures = 0; ; failures++) {
    // F3: no PUT of these bytes so far was possibly accepted.
    const clean = current.answer === "unsent" || current.answer === "refused";
    current = writeAhead(ctx, current);
    const answer = await request(
      ctx,
      "PUT",
      `/channels/${ctx.channelId}/seats`,
      dataSeatList(signed),
      reasonHeader(reason),
    );
    const step = publishStep(answer, { op: "seats", failures });
    if (step.kind === "resend") {
      if (clean && step.cause === "rate_limited") {
        // A 429 never reached the route: still never accepted.
        current = { ...current, answer: "refused" };
        persist(ctx, current);
      }
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
 * Resolve a stored (unresolved) publish first; returns the entry it
 * resolved, or null. `reason` rides on a stored seat publish's re-PUT.
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
  if (stored.op === "protect") await resolveProtect(ctx, stored.signed, true);
  else await resolveStoredSeats(ctx, stored, reason);
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

/**
 * S2 F3: whether the server NEVER took a stored seat publish, from the
 * entry alone: `answer` is `"refused"` (every PUT of these bytes was
 * refused without a write, see `StoredPublish.answer`) and the entry is one
 * the owner may abandon: refused for its reason header (`reasonRequired`)
 * or an owner-devices publish. Anything else, a pre-F3 entry without
 * `answer` included, may be on the server and is never dropped.
 */
function neverAccepted(e: StoredPublish): boolean {
  return (
    e.op === "seats" &&
    e.answer === "refused" &&
    (e.reasonRequired === true || e.ownerDevices === true)
  );
}

/** The stored seat publish of a channel, or null (none, protect, corrupt). */
function storedSeats(at: StoreAt): StoredPublish | null {
  const e = readStored(at);
  return e === null || e === "corrupt" || e.op !== "seats" ? null : e;
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

/** Test hook: forget in-memory state (never called by the app). */
export function _resetOwnerFlowsForTest(): void {
  memo.clear();
  running.clear();
}
