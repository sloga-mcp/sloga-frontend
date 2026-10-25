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
 * Pure of Solid / livekit / lingui; driven through `GroupOps` and the port,
 * so `node --test --conditions=browser` loads it over fakes.
 */
import type { MlsMemberDevice } from "./e2ee";
import {
  type ProtectReadBack,
  type PublishAnswer,
  type PublishOp,
  publishBackoffMs,
  publishStep,
  resolveProtectReadBack,
  signAllowed,
} from "./protectedTextPolicy.ts";
import type {
  GroupOps,
  NativeError,
  ProtectedTextPort,
  SeatListInput,
  SeatListVerdict,
  SignedHandover,
  SignedSeatList,
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
}

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
  return {
    version: v.version,
    body: v.body,
    signature: v.signature,
    signer_user_id: v.signer_user_id,
    signer_device_id: v.signer_device_id,
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
): Promise<PublishAnswer> {
  try {
    const response =
      body === undefined
        ? await ctx.port.api(method, path)
        : await ctx.port.api(method, path, body);
    return { kind: "response", response };
  } catch {
    return { kind: "transport_error" };
  }
}

function readStored(ctx: Ctx): StoredPublish | "corrupt" | null {
  const raw = ctx.port.store.get(ctx.key) ?? memo.get(ctx.key) ?? null;
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!isRecord(v) || v.v !== 1) return "corrupt";
    if (v.op !== "protect" && v.op !== "seats") return "corrupt";
    const signed = parseSigned(v.signed);
    return signed === null ? "corrupt" : { v: 1, op: v.op, signed };
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

function clearStored(ctx: Ctx): void {
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

/** The `DataSeatList` body of a PUT (no handover in S1). */
function dataSeatList(s: SignedSeatList) {
  return {
    body: s.body,
    signature: s.signature,
    signer_device_id: s.signer_device_id,
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
      handovers: parseHandovers(l.handovers),
    };
  }
  const epoch = body.as_of_epoch;
  return {
    list,
    asOfEpoch:
      typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch >= 0
        ? epoch
        : null,
    asOfGroupId:
      typeof body.as_of_group_id === "string" ? body.as_of_group_id : null,
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
): Promise<SeatListVerdict> {
  const args = {
    channelId: ctx.channelId,
    list: {
      body: list.body,
      signature: list.signature,
      signer_user_id: list.signer_user_id,
      signer_device_id: list.signer_device_id,
    },
    handovers: list.handovers,
    serverOwnerId: ctx.serverOwnerId,
    asOfEpoch,
    asOfGroupId,
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
): Promise<void> {
  await verifyList(ctx, list, asOfEpoch, asOfGroupId);
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
  await finishGenesis(
    ctx,
    { ...rb.list, version: 1, handovers: rb.handovers },
    rb.asOfEpoch,
    rb.asOfGroupId,
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

/** PUT the SAME list bytes until resolved (design 4.9), then finish. */
async function publishSeats(ctx: Ctx, signed: SignedSeatList) {
  for (let failures = 0; ; failures++) {
    const answer = await request(
      ctx,
      "PUT",
      `/channels/${ctx.channelId}/seats`,
      dataSeatList(signed),
    );
    const step = publishStep(answer, { op: "seats", failures });
    if (step.kind === "resend") {
      await pause(ctx, step.delayMs);
      continue;
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
async function resolveStoredSeats(ctx: Ctx, signed: SignedSeatList) {
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
    await publishSeats(ctx, signed); // not landed: re-send the SAME bytes
    return;
  }
  clearStored(ctx);
  throw clientFailure("publish_refused");
}

// ---------------------------------------------------------------------------
// Shared entry
// ---------------------------------------------------------------------------

/** Resolve a stored (unresolved) publish first; returns its op, or null. */
async function resumeStored(ctx: Ctx): Promise<PublishOp | null> {
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
  else await resolveStoredSeats(ctx, stored.signed);
  return stored.op;
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
    if ((await resumeStored(ctx)) === "protect") return;
    assertSignAllowed(ctx);
    const snap = await readSeats(ctx);
    if (snap.list !== null) {
      // Already protected. Crash recovery (D7c, D21): this device's own
      // genesis landed but was never verified / its group never created.
      if (snap.list.version === 1 && isOwn(ctx, snap.list)) {
        await finishGenesis(ctx, snap.list, snap.asOfEpoch, snap.asOfGroupId);
        return;
      }
      throw clientFailure("protect_failed");
    }
    const self = port.selfUserId;
    const genesisSeats = [self, ...seats.filter((s) => s !== self)];
    const unique = [...new Set(genesisSeats)];
    const signed = await port.invoke("e2ee_text_seat_list_sign", {
      channelId,
      userId: self,
      seats: unique,
      deviceCap,
      serverList: null,
      channelName: ctx.channelName,
      displayNames: port.displayNames(unique),
    });
    if (
      parseSigned(signed) === null ||
      signed.version !== 1 ||
      !isOwn(ctx, signed)
    ) {
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
 */
export async function setSeats(
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
    await resumeStored(ctx);
    assertSignAllowed(ctx);
    const snap = await readSeats(ctx);
    if (snap.list === null) throw clientFailure("not_protected");
    // `_sign` refuses `seat_list_behind` unless the server's list is the
    // one this device verified: verify it first (design 9.2).
    await verifyList(ctx, snap.list, snap.asOfEpoch, snap.asOfGroupId);
    const unique = [...new Set(seats)];
    const signed = await port.invoke("e2ee_text_seat_list_sign", {
      channelId,
      userId: port.selfUserId,
      seats: unique,
      deviceCap,
      serverList: { version: snap.list.version, body: snap.list.body },
      channelName: ctx.channelName,
      displayNames: port.displayNames(unique),
    });
    if (
      parseSigned(signed) === null ||
      signed.version !== snap.list.version + 1 ||
      !isOwn(ctx, signed)
    ) {
      throw clientFailure("publish_refused");
    }
    persist(ctx, { v: 1, op: "seats", signed });
    await publishSeats(ctx, signed);
  });
}

/** Test hook: forget in-memory state (never called by the app). */
export function _resetOwnerFlowsForTest(): void {
  memo.clear();
  running.clear();
}
