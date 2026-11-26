// Unit spec for the Protected channels owner flows (W4 lane B2) — run with
// Node's built-in runner:
//   node --test --conditions=browser components/client/protectedTextOwner.test.ts
// Focus (plan 7 "protect/genesis flows", D7 / D7b / D7c / D21 / D24): the
// genesis publish, read-back, self-pin verify and generation-0 create; the
// seat publish loop (same bytes, 429 retryable), signing blocked while a
// publish is unresolved, verify always with the snapshot's as_of_*, the
// unseat Remove, and crash recovery from the D7c entry. The plan 7 named
// mutation controls in this module each have a test marked "control:".
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { reasonRefusal } from "./protectedRemovalReasonPolicy.ts";
import { protectedNoticeForError } from "./protectedShield.ts";
import {
  _resetOwnerFlowsForTest,
  cancelPendingSeats,
  moveOwnerKey,
  ownerKeyMoveTargets,
  pendingSeats,
  proposedOwnerDevices,
  protect,
  publishStoreKey,
  recoverOwnership,
  setHistory,
  setSeats,
  signOwnerDevices,
  wipeHistory,
} from "./protectedTextOwner.ts";
import type {
  GroupOps,
  ManagerState,
  OwnerFlows,
  ProtectedSeatsResponse,
  ProtectedTextPort,
  RecoveryPlan,
  SignedAuthority,
  SignedSeatList,
  TextApiResponse,
  TextChannelState,
} from "./protectedTextTypes.ts";

// Compile-time: the exports are exactly what B5 wires as `deps.owner`.
const _ownerFlows: OwnerFlows = {
  protect,
  setSeats,
  signOwnerDevices,
  moveOwnerKey,
  pendingSeats,
  cancelPendingSeats,
  recoverOwnership,
  setHistory,
  wipeHistory,
};
void _ownerFlows;

const CH = "01CHANNEL0000000000000000A";
const ME = "01USERME000000000000000000";
const MY_DEV = "aa".repeat(16);
const BOB = "01USERBOB00000000000000000";
const SERVER_OWNER = ME;

type Reply = TextApiResponse | "transport";
type Call = { method: string; path: string; body: unknown; headers?: unknown };
type Invoke = { cmd: string; args: Record<string, unknown> };

const res = (
  status: number,
  body: unknown = null,
  resetAfterMs: number | null = null,
): TextApiResponse => ({ status, body, resetAfterMs });

const genesis = (over: Partial<SignedSeatList> = {}): SignedSeatList => ({
  version: 1,
  body: "sloga-seat-list-v1\nv:1\nversion:1",
  signature: "SIG1",
  signer_user_id: ME,
  signer_device_id: MY_DEV,
  ...over,
});

const listOf = (s: SignedSeatList, handovers: unknown[] = []) => ({
  ...s,
  handovers,
});

const seatsBody = (
  list: unknown,
  asOfEpoch: number | null = null,
  asOfGroupId: string | null = null,
) => ({
  list,
  as_of_epoch: asOfEpoch,
  as_of_group_id: asOfGroupId,
  entitlement_device_cap: 5,
  slot_cap: 10,
  device_cap: 5,
  seats_used: 1,
  seats: [],
  cooling: [],
});

const nativeState = (
  members: { user_id: string; device_id: string }[],
  over: Partial<TextChannelState> = {},
): TextChannelState => ({
  channel_id: CH,
  group_id: "g0",
  generation: 0,
  epoch: 3,
  state: "active",
  members: members.map((m) => ({
    ...m,
    user_verified: true,
    on_signed_list: true,
    removed_locally: false,
  })),
  seat_list: null,
  owner_pin: {
    channel_id: CH,
    status: "pinned",
    owner_user_id: ME,
    owner_device_id: MY_DEV,
    owner_verified: true,
    source: "protect",
    pending_signer: null,
  },
  self_seated: true,
  roster_matches_list: true,
  update_due: false,
  update_required: false,
  verdict: "ok",
  ...over,
});

interface Harness {
  port: ProtectedTextPort;
  ops: GroupOps;
  calls: Call[];
  invokes: Invoke[];
  sleeps: number[];
  store: Map<string, string>;
  opsLog: unknown[][];
  /** Store contents seen at each PUT. */
  storeAtPut: (string | null)[];
  /** Every request (`METHOD path`) and native command, in order. */
  trace: string[];
  /** Every `port.log` call. */
  logs: [string, string][];
  /** The data of each `port.log` call, in the same order. */
  logData: unknown[];
  /** How many times the store was written. */
  storeWrites: number;
}

function harness(opts: {
  routes: Record<string, Reply[] | ((c: Call) => Reply)>;
  invoke?: Partial<Record<string, (args: Record<string, unknown>) => unknown>>;
  state?: Partial<ManagerState> | null;
  storeSetFails?: boolean;
  sleepRejectsAfter?: number;
  /** The root advert's `formats_v2` as the port reports it (default off). */
  formatsV2?: boolean;
  /** S4: the root advert's `history_setting` (default off). */
  historySetting?: boolean;
}): Harness {
  const h = {
    calls: [] as Call[],
    invokes: [] as Invoke[],
    sleeps: [] as number[],
    store: new Map<string, string>(),
    opsLog: [] as unknown[][],
    storeAtPut: [] as (string | null)[],
    trace: [] as string[],
    logs: [] as [string, string][],
    logData: [] as unknown[],
    storeWrites: 0,
  };
  const key = publishStoreKey(ME, CH);
  const port: ProtectedTextPort & { historySetting(): boolean } = {
    formatsV2: () => opts.formatsV2 === true,
    historySetting: () => opts.historySetting === true,
    async invoke(cmd, args) {
      h.invokes.push({ cmd, args: args as Record<string, unknown> });
      h.trace.push(cmd);
      const fn = opts.invoke?.[cmd];
      if (fn) return fn(args as Record<string, unknown>) as never;
      throw { type: "invalid_argument", field: `unscripted ${cmd}` };
    },
    async pinCallIdentities(userId, targets) {
      h.opsLog.push(["pinCallIdentities", userId, targets]);
      return targets;
    },
    async ownDeviceListing() {
      return { hash: "h", listing: [{ device: MY_DEV }] };
    },
    async api(method, path, body, headers) {
      const c: Call =
        headers === undefined
          ? { method, path, body }
          : { method, path, body, headers };
      h.calls.push(c);
      h.trace.push(`${method} ${path}`);
      if (method === "PUT" || method === "POST") {
        h.storeAtPut.push(h.store.get(key) ?? null);
      }
      const route = opts.routes[`${method} ${path}`];
      let r: Reply | undefined;
      if (typeof route === "function") r = route(c);
      else if (route && route.length > 1) r = route.shift();
      else if (route) r = route[0];
      if (r === undefined) throw new Error(`unscripted ${method} ${path}`);
      if (r === "transport") throw new Error("network");
      return r;
    },
    async ack() {},
    now: () => 1_700_000_000_000,
    async sleep(ms) {
      h.sleeps.push(ms);
      if (
        opts.sleepRejectsAfter !== undefined &&
        h.sleeps.length > opts.sleepRejectsAfter
      ) {
        throw new Error("aborted");
      }
    },
    log(level, msg, data) {
      h.logs.push([level, msg]);
      h.logData.push(data);
    },
    selfUserId: ME,
    selfDeviceId: MY_DEV,
    channelInfo: (id) =>
      id === CH
        ? {
            channelId: CH,
            name: "secret",
            serverId: "01SERVER",
            serverOwnerId: SERVER_OWNER,
            serverProtected: false,
            locallyPinned: false,
          }
        : null,
    displayNames: (ids) => ids.map((user_id) => ({ user_id, name: user_id })),
    store: {
      get: (k) => h.store.get(k) ?? null,
      set: (k, v) => {
        if (opts.storeSetFails) return false;
        h.storeWrites++;
        h.store.set(k, v);
        return true;
      },
      delete: (k) => void h.store.delete(k),
    },
    notify() {},
  };
  const ops: GroupOps = {
    async ensureJoined(ch) {
      h.opsLog.push(["ensureJoined", ch]);
    },
    async createGroup(ch, supersedes) {
      h.opsLog.push(["createGroup", ch, supersedes]);
      return {
        group_id: "g0",
        generation: 0,
        payload: {} as never,
      };
    },
    async removeDevices(ch, targets, o) {
      h.opsLog.push(["removeDevices", ch, targets, o]);
    },
    async catchUp(ch, toEpoch, groupId) {
      h.opsLog.push(["catchUp", ch, toEpoch, groupId]);
    },
    async refresh(ch, reason) {
      h.opsLog.push(["refresh", ch, reason]);
    },
    stateOf: () =>
      opts.state === null || opts.state === undefined
        ? null
        : {
            channelId: CH,
            native: null,
            seats: null,
            serverGroup: null,
            publishInFlight: false,
            ownerChangePending: false,
            ...opts.state,
          },
  };
  return { ...h, port, ops };
}

const verdict = (seats: string[], version = 1) => ({
  status: "accepted",
  version,
  seats,
  device_cap: 5,
  signer_user_id: ME,
  signer_device_id: MY_DEV,
  pinned_now: version === 1,
});

const cmds = (h: Harness, name: string) =>
  h.invokes.filter((i) => i.cmd === name);
const puts = (h: Harness) => h.calls.filter((c) => c.method === "PUT");

beforeEach(() => _resetOwnerFlowsForTest());

// ---------------------------------------------------------------------------
// Protect
// ---------------------------------------------------------------------------

/** Routes for a protect whose read-back shows `g` landed. */
function protectRoutes(
  g: SignedSeatList,
  putReplies: Reply[],
  asOf: [number | null, string | null] = [null, null],
) {
  let landed = false;
  return {
    [`PUT /channels/${CH}/protect`]: (() => {
      const queue = [...putReplies];
      return (): Reply => {
        const r = queue.length > 1 ? queue.shift()! : queue[0];
        if (r !== "transport" && r.status < 300) landed = true;
        if (r !== "transport" && r.status >= 400 && r.status !== 429) {
          landed = true; // a retry after an earlier landed attempt
        }
        return r;
      };
    })(),
    [`GET /channels/${CH}`]: () => res(200, { _id: CH, protected: landed }),
    [`GET /channels/${CH}/seats`]: () =>
      res(200, seatsBody(landed ? listOf(g) : null, ...asOf)),
  };
}

test("protect: genesis signed from list null, persisted before the PUT, read back, verified, g0 created", async () => {
  const g = genesis();
  const h = harness({
    routes: protectRoutes(g, [res(200, { _id: CH, protected: true })]),
    invoke: {
      e2ee_text_seat_list_sign: () => g,
      e2ee_text_seat_list_verify: () => verdict([ME, BOB]),
    },
  });
  await protect(h.ops, h.port, CH, [BOB], 5);

  const [sign] = cmds(h, "e2ee_text_seat_list_sign");
  assert.equal(sign.args.serverList, null);
  assert.deepEqual(sign.args.seats, [ME, BOB], "the owner is always seated");
  assert.equal(sign.args.deviceCap, 5);
  assert.equal(sign.args.channelName, "secret");
  const p = puts(h);
  assert.equal(p.length, 1);
  assert.deepEqual(p[0].body, {
    seat_list: {
      body: g.body,
      signature: g.signature,
      signer_device_id: MY_DEV,
    },
  });
  assert.ok(h.storeAtPut[0], "D7c entry exists while the PUT is in flight");
  assert.deepEqual(JSON.parse(h.storeAtPut[0]!).signed, g);

  const [verify] = cmds(h, "e2ee_text_seat_list_verify");
  assert.deepEqual(verify.args.list, {
    body: g.body,
    signature: g.signature,
    signer_user_id: ME,
    signer_device_id: MY_DEV,
  });
  assert.equal(verify.args.serverOwnerId, SERVER_OWNER);
  assert.equal(verify.args.asOfEpoch, null);
  assert.equal(verify.args.asOfGroupId, null);
  assert.deepEqual(
    h.opsLog.filter((o) => o[0] === "createGroup"),
    [["createGroup", CH, null]],
  );
  assert.equal(h.store.size, 0, "resolved publish leaves no D7c entry");
});

test("control: 429 is retryable, never a resolving 4xx (same bytes after the stated delay)", async () => {
  const g = genesis();
  const h = harness({
    routes: protectRoutes(g, [res(429, { retry_after: 900 }, 1200), res(200)]),
    invoke: {
      e2ee_text_seat_list_sign: () => g,
      e2ee_text_seat_list_verify: () => verdict([ME]),
    },
  });
  await protect(h.ops, h.port, CH, [], 0);
  const p = puts(h);
  assert.equal(p.length, 2, "the 429 is re-sent");
  assert.deepEqual(p[0].body, p[1].body, "SAME bytes");
  assert.equal(h.sleeps[0], 1200, "header ms wins");
  assert.equal(
    cmds(h, "e2ee_text_seat_list_sign").length,
    1,
    "never re-signed",
  );
  assert.equal(cmds(h, "e2ee_text_seat_list_verify").length, 1);
});

test("protect: transport error and 5xx resend the same bytes with backoff, no re-sign", async () => {
  const g = genesis();
  const h = harness({
    routes: protectRoutes(g, ["transport", res(503), res(200)]),
    invoke: {
      e2ee_text_seat_list_sign: () => g,
      e2ee_text_seat_list_verify: () => verdict([ME]),
    },
  });
  await protect(h.ops, h.port, CH, [], 0);
  const p = puts(h);
  assert.equal(p.length, 3);
  assert.ok(
    p.every((c) => JSON.stringify(c.body) === JSON.stringify(p[0].body)),
  );
  assert.deepEqual(h.sleeps.slice(0, 2), [250, 500]);
  assert.equal(cmds(h, "e2ee_text_seat_list_sign").length, 1);
});

test("control: a protect's non-429 4xx is never taken at face value (read-back finds our genesis → landed)", async () => {
  const g = genesis();
  const h = harness({
    routes: protectRoutes(g, [
      res(500),
      res(400, { type: "InvalidOperation" }),
    ]),
    invoke: {
      e2ee_text_seat_list_sign: () => g,
      e2ee_text_seat_list_verify: () => verdict([ME]),
    },
  });
  await protect(h.ops, h.port, CH, [], 0);
  assert.equal(
    cmds(h, "e2ee_text_seat_list_verify").length,
    1,
    "self-pin verify ran",
  );
  assert.equal(h.opsLog.filter((o) => o[0] === "createGroup").length, 1);
  assert.equal(h.store.size, 0);
});

test("protect: a 4xx whose read-back shows a different list is refused: no verify, no group, no second genesis", async () => {
  const g = genesis();
  const other = genesis({ signature: "OTHER" });
  const h = harness({
    routes: {
      [`PUT /channels/${CH}/protect`]: [res(400, { type: "InvalidOperation" })],
      [`GET /channels/${CH}`]: [res(200, { protected: true })],
      [`GET /channels/${CH}/seats`]: (() => {
        let n = 0;
        return () => res(200, seatsBody(n++ === 0 ? null : listOf(other)));
      })(),
    },
    invoke: { e2ee_text_seat_list_sign: () => g },
  });
  await assert.rejects(protect(h.ops, h.port, CH, [], 0), {
    source: "client",
    reason: "protect_failed",
  });
  assert.equal(cmds(h, "e2ee_text_seat_list_verify").length, 0);
  assert.equal(cmds(h, "e2ee_text_seat_list_sign").length, 1);
  assert.equal(h.opsLog.filter((o) => o[0] === "createGroup").length, 0);
  assert.equal(h.store.size, 0, "a refused publish is resolved");
});

test("protect: a transient read-back is retried, never guessed", async () => {
  const g = genesis();
  let seatsCalls = 0;
  const h = harness({
    routes: {
      [`PUT /channels/${CH}/protect`]: [res(200)],
      [`GET /channels/${CH}`]: [res(200, { protected: true })],
      [`GET /channels/${CH}/seats`]: () => {
        seatsCalls++;
        if (seatsCalls === 1) return res(200, seatsBody(null));
        if (seatsCalls === 2) return res(503);
        return res(200, seatsBody(listOf(g)));
      },
    },
    invoke: {
      e2ee_text_seat_list_sign: () => g,
      e2ee_text_seat_list_verify: () => verdict([ME]),
    },
  });
  await protect(h.ops, h.port, CH, [], 0);
  assert.equal(seatsCalls, 3);
  assert.equal(cmds(h, "e2ee_text_seat_list_verify").length, 1);
});

test("protect: landed read-back with a group passes its as_of_* to verify and creates nothing", async () => {
  const g = genesis();
  const h = harness({
    routes: protectRoutes(g, [res(200)], [4, "gX"]),
    invoke: {
      e2ee_text_seat_list_sign: () => g,
      e2ee_text_seat_list_verify: () => verdict([ME]),
    },
  });
  await protect(h.ops, h.port, CH, [], 0);
  const [v] = cmds(h, "e2ee_text_seat_list_verify");
  assert.equal(v.args.asOfEpoch, 4);
  assert.equal(v.args.asOfGroupId, "gX");
  assert.equal(h.opsLog.filter((o) => o[0] === "createGroup").length, 0);
});

test("protect: a declined growth dialog signs nothing, stores nothing, PUTs nothing", async () => {
  const h = harness({
    routes: { [`GET /channels/${CH}/seats`]: [res(200, seatsBody(null))] },
    invoke: {
      e2ee_text_seat_list_sign: () => {
        throw { type: "declined" };
      },
    },
  });
  await assert.rejects(protect(h.ops, h.port, CH, [BOB], 0), {
    source: "native",
    error: { type: "declined" },
  });
  assert.equal(puts(h).length, 0);
  assert.equal(h.store.size, 0);
});

test("protect: crash recovery (D7c/D21) — our v1 already on the server: verify + create, never re-sign", async () => {
  const g = genesis();
  const h = harness({
    routes: { [`GET /channels/${CH}/seats`]: [res(200, seatsBody(listOf(g)))] },
    invoke: { e2ee_text_seat_list_verify: () => verdict([ME]) },
  });
  await protect(h.ops, h.port, CH, [], 0);
  assert.equal(cmds(h, "e2ee_text_seat_list_sign").length, 0);
  assert.equal(cmds(h, "e2ee_text_seat_list_verify").length, 1);
  assert.equal(h.opsLog.filter((o) => o[0] === "createGroup").length, 1);
});

test("protect: a list signed by another device refuses (no genesis over an existing list)", async () => {
  const h = harness({
    routes: {
      [`GET /channels/${CH}/seats`]: [
        res(
          200,
          seatsBody(listOf(genesis({ signer_device_id: "bb".repeat(16) }))),
        ),
      ],
    },
  });
  await assert.rejects(protect(h.ops, h.port, CH, [], 0), {
    reason: "protect_failed",
  });
  assert.equal(cmds(h, "e2ee_text_seat_list_sign").length, 0);
});

test("protect: a stored genesis that has not landed is re-sent with the SAME bytes, not re-signed", async () => {
  const g = genesis();
  const h = harness({
    routes: protectRoutes(g, [res(200)]),
    invoke: {
      e2ee_text_seat_list_verify: () => verdict([ME]),
    },
  });
  h.store.set(
    publishStoreKey(ME, CH),
    JSON.stringify({ v: 1, op: "protect", signed: g }),
  );
  await protect(h.ops, h.port, CH, [], 0);
  assert.equal(cmds(h, "e2ee_text_seat_list_sign").length, 0);
  assert.equal(puts(h).length, 1);
  assert.equal(
    (puts(h)[0].body as { seat_list: { signature: string } }).seat_list
      .signature,
    "SIG1",
  );
  assert.equal(h.opsLog.filter((o) => o[0] === "createGroup").length, 1);
});

test("protect: an aborted loop keeps the D7c entry (also in memory when storage fails)", async () => {
  const g = genesis();
  const h = harness({
    routes: protectRoutes(g, ["transport"]),
    invoke: { e2ee_text_seat_list_sign: () => g },
    storeSetFails: true,
    sleepRejectsAfter: 2,
  });
  await assert.rejects(protect(h.ops, h.port, CH, [], 0), {
    reason: "aborted",
  });
  // Next flow: the in-memory entry still blocks a fresh sign and is resumed.
  const h2 = harness({
    routes: protectRoutes(g, [res(200)]),
    invoke: { e2ee_text_seat_list_verify: () => verdict([ME]) },
  });
  await protect(h2.ops, h2.port, CH, [], 0);
  assert.equal(cmds(h2, "e2ee_text_seat_list_sign").length, 0);
  assert.equal(
    (puts(h2)[0].body as { seat_list: { signature: string } }).seat_list
      .signature,
    "SIG1",
  );
});

test("protect/setSeats: invalid arguments and an unknown channel are refused before any request", async () => {
  const h = harness({ routes: {} });
  await assert.rejects(protect(h.ops, h.port, CH, [""], 0), {
    reason: "invalid_argument",
  });
  await assert.rejects(setSeats(h.ops, h.port, CH, [ME], -1), {
    reason: "invalid_argument",
  });
  await assert.rejects(protect(h.ops, h.port, "01OTHER", [], 0), {
    reason: "channel_unknown",
  });
  assert.equal(h.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

const v2 = genesis({ version: 2, body: "body-v2", signature: "SIG2" });
const v3 = genesis({ version: 3, body: "body-v3", signature: "SIG3" });

function seatsRoutes(putReplies: Reply[], asOf: [number, string] = [7, "g0"]) {
  let current = v2;
  const queue = [...putReplies];
  return {
    [`GET /channels/${CH}/seats`]: () =>
      res(200, seatsBody(listOf(current), ...asOf)),
    [`PUT /channels/${CH}/seats`]: (): Reply => {
      const r = queue.length > 1 ? queue.shift()! : queue[0];
      if (r !== "transport" && r.status < 300) current = v3;
      return r;
    },
  };
}

test("setSeats: verify current list (as_of), sign v+1 from it, persist, PUT, read back + verify", async () => {
  const h = harness({
    routes: seatsRoutes([res(200)]),
    invoke: {
      e2ee_text_seat_list_verify: (a) =>
        verdict(
          [ME, BOB],
          (a.list as { body: string }).body === "body-v3" ? 3 : 2,
        ),
      e2ee_text_seat_list_sign: () => v3,
      e2ee_text_state: () => nativeState([{ user_id: ME, device_id: MY_DEV }]),
    },
  });
  await setSeats(h.ops, h.port, CH, [ME, BOB], 5);
  const [sign] = cmds(h, "e2ee_text_seat_list_sign");
  assert.deepEqual(sign.args.serverList, { version: 2, body: "body-v2" });
  assert.deepEqual(puts(h)[0].body, {
    body: "body-v3",
    signature: "SIG3",
    signer_device_id: MY_DEV,
  });
  assert.ok(h.storeAtPut[0]);
  const verifies = cmds(h, "e2ee_text_seat_list_verify");
  assert.equal(verifies.length, 2);
  assert.equal((verifies[1].args.list as { body: string }).body, "body-v3");
  assert.equal(h.store.size, 0);
  assert.equal(h.opsLog.filter((o) => o[0] === "removeDevices").length, 0);
});

test("control: verify always carries the snapshot's as_of_* (D24)", async () => {
  const h = harness({
    routes: seatsRoutes([res(200)], [7, "g0"]),
    invoke: {
      e2ee_text_seat_list_verify: () => verdict([ME]),
      e2ee_text_seat_list_sign: () => v3,
      e2ee_text_state: () => nativeState([]),
    },
  });
  await setSeats(h.ops, h.port, CH, [ME], 5);
  const verifies = cmds(h, "e2ee_text_seat_list_verify");
  assert.equal(verifies.length, 2);
  for (const v of verifies) {
    assert.equal(v.args.asOfEpoch, 7);
    assert.equal(v.args.asOfGroupId, "g0");
  }
});

test("setSeats: mls_epoch_gap catches up to as_of and re-verifies ONCE; a second gap rejects", async () => {
  let n = 0;
  const h = harness({
    routes: seatsRoutes([res(200)]),
    invoke: {
      e2ee_text_seat_list_verify: () => {
        n++;
        if (n === 1)
          throw { type: "mls_epoch_gap", group_id: "g0", expected: 4, got: 7 };
        return verdict([ME]);
      },
      e2ee_text_seat_list_sign: () => v3,
      e2ee_text_state: () => nativeState([]),
    },
  });
  await setSeats(h.ops, h.port, CH, [ME], 5);
  assert.deepEqual(
    h.opsLog.filter((o) => o[0] === "catchUp"),
    [["catchUp", CH, 7, "g0"]],
  );

  const h2 = harness({
    routes: seatsRoutes([res(200)]),
    invoke: {
      e2ee_text_seat_list_verify: () => {
        throw { type: "mls_epoch_gap", group_id: "g0", expected: 4, got: 7 };
      },
    },
  });
  await assert.rejects(
    setSeats(h2.ops, h2.port, CH, [ME], 5),
    (e: { source: string; error: { type: string } }) =>
      e.source === "native" && e.error.type === "mls_epoch_gap",
  );
  assert.equal(cmds(h2, "e2ee_text_seat_list_verify").length, 2);
  assert.equal(cmds(h2, "e2ee_text_seat_list_sign").length, 0);
});

test("setSeats: a held group behind as_of catches up BEFORE verifying (design 4.4 step 0)", async () => {
  const h = harness({
    routes: seatsRoutes([res(200)]),
    state: { native: nativeState([], { epoch: 5 }) },
    invoke: {
      e2ee_text_seat_list_verify: () => verdict([ME]),
      e2ee_text_seat_list_sign: () => v3,
      e2ee_text_state: () => nativeState([]),
    },
  });
  await setSeats(h.ops, h.port, CH, [ME], 5);
  assert.equal(h.opsLog[0][0], "catchUp");
});

test("setSeats: identity_pin_required pins that user and retries ONCE", async () => {
  let n = 0;
  const h = harness({
    routes: seatsRoutes([res(200)]),
    invoke: {
      e2ee_text_seat_list_verify: () => {
        if (n++ === 0)
          throw {
            type: "identity_pin_required",
            user_id: BOB,
            device_id: "cc",
          };
        return verdict([ME]);
      },
      e2ee_text_seat_list_sign: () => v3,
      e2ee_text_state: () => nativeState([]),
    },
  });
  await setSeats(h.ops, h.port, CH, [ME], 5);
  assert.deepEqual(
    h.opsLog.filter((o) => o[0] === "pinCallIdentities"),
    [["pinCallIdentities", BOB, ["cc"]]],
  );
});

test("setSeats: own-device identity pin goes through e2ee_text_pin_own_devices", async () => {
  let n = 0;
  const h = harness({
    routes: seatsRoutes([res(200)]),
    invoke: {
      e2ee_text_seat_list_verify: () => {
        if (n++ === 0)
          throw {
            type: "identity_pin_required",
            user_id: ME,
            device_id: MY_DEV,
          };
        return verdict([ME]);
      },
      e2ee_text_pin_own_devices: () => null,
      e2ee_text_seat_list_sign: () => v3,
      e2ee_text_state: () => nativeState([]),
    },
  });
  await setSeats(h.ops, h.port, CH, [ME], 5);
  const [pin] = cmds(h, "e2ee_text_pin_own_devices");
  assert.deepEqual(pin.args, { userId: ME, devices: [{ device: MY_DEV }] });
});

test("setSeats: unseat removes every leaf of users off the verified list, never this device", async () => {
  const h = harness({
    routes: seatsRoutes([res(200)]),
    invoke: {
      e2ee_text_seat_list_verify: () => verdict([ME]),
      e2ee_text_seat_list_sign: () => v3,
      e2ee_text_state: () =>
        nativeState([
          { user_id: ME, device_id: MY_DEV },
          { user_id: ME, device_id: "dd" },
          { user_id: BOB, device_id: "b1" },
          { user_id: BOB, device_id: "b2" },
        ]),
    },
  });
  await setSeats(h.ops, h.port, CH, [ME], 5);
  assert.deepEqual(
    h.opsLog.filter((o) => o[0] === "removeDevices"),
    [
      [
        "removeDevices",
        CH,
        [
          { user_id: BOB, device_id: "b1" },
          { user_id: BOB, device_id: "b2" },
        ],
        { rejoinIntent: null },
      ],
    ],
  );
});

test("setSeats: a seat PUT non-429 4xx is a genuine refusal (resolved, no read-back)", async () => {
  const h = harness({
    routes: seatsRoutes([res(400, { type: "SeatCapReached", max: 10 })]),
    invoke: {
      e2ee_text_seat_list_verify: () => verdict([ME]),
      e2ee_text_seat_list_sign: () => v3,
    },
  });
  await assert.rejects(setSeats(h.ops, h.port, CH, [ME, BOB], 5), {
    source: "server",
    status: 400,
    type: "SeatCapReached",
  });
  assert.equal(h.store.size, 0);
  assert.equal(cmds(h, "e2ee_text_seat_list_verify").length, 1);
});

// W2 C1 (cross-session note 10-25): the seat PUT answers 400
// `SeatListNamesRemovedUsers {users}` when the list still names users the
// server force-released. Control C-ERR2: the publish loop re-sending (or
// re-signing) after this refusal turns these red.
const CAROL = "01USERCAROL000000000000000";
const removedBody = { type: "SeatListNamesRemovedUsers", users: [CAROL] };
const refusedV3 = genesis({
  version: 3,
  body: "body-v3-carol",
  signature: "SIGC",
});

/**
 * Native model for D24: `_sign` persists nothing and refuses
 * `seat_list_behind` unless its `serverList` is the list this device last
 * verified. `signs` are returned in order.
 */
function d24Native(signs: SignedSeatList[]) {
  let verified: string | null = null;
  const queue = [...signs];
  return {
    e2ee_text_seat_list_verify: (a: Record<string, unknown>) => {
      const body = (a.list as { body: string }).body;
      verified = body;
      return verdict([ME, BOB], body === "body-v3" ? 3 : 2);
    },
    e2ee_text_seat_list_sign: (a: Record<string, unknown>) => {
      const server = a.serverList as { body: string } | null;
      if (server === null || server.body !== verified) {
        throw { type: "seat_list_behind", channel_id: CH, have: 0, need: 0 };
      }
      const next = queue.shift();
      if (next === undefined) throw new Error("unscripted sign");
      return next;
    },
    e2ee_text_state: () => nativeState([{ user_id: ME, device_id: MY_DEV }]),
  };
}

test("W2 C1: SeatListNamesRemovedUsers resolves as a typed refusal: never re-sent, never re-signed", async () => {
  const h = harness({
    routes: seatsRoutes([res(400, removedBody), res(200)]),
    invoke: d24Native([refusedV3, v3]),
  });
  let failure: unknown = null;
  await assert.rejects(
    setSeats(h.ops, h.port, CH, [ME, BOB, CAROL], 5),
    (e) => {
      failure = e;
      return true;
    },
  );
  assert.deepEqual(failure, {
    source: "server",
    status: 400,
    type: "SeatListNamesRemovedUsers",
    body: removedBody,
  });
  assert.equal(puts(h).length, 1, "the refused bytes are never re-sent");
  assert.equal(cmds(h, "e2ee_text_seat_list_sign").length, 1, "no re-sign");
  assert.equal(
    cmds(h, "e2ee_text_seat_list_verify").length,
    1,
    "a refused list is never read back and verified",
  );
  assert.deepEqual(h.sleeps, [], "no backoff: nothing is retried");
  assert.equal(h.store.size, 0, "the D7c entry is resolved");
  assert.equal(h.opsLog.filter((o) => o[0] === "removeDevices").length, 0);
  // The owner UI gets the typed notice with the ids (names are its job).
  const ui = protectedNoticeForError(failure, { op: "owner" });
  assert.equal(
    ui.kind === "notice" && ui.notice,
    "seat_list_names_removed_users",
  );
  assert.deepEqual(ui.kind === "notice" && ui.users, [CAROL]);
});

test("W2 C1 + D24: the next setSeats GETs and verifies the server's current list before signing (no SeatListBehind)", async () => {
  const h = harness({
    routes: seatsRoutes([res(400, removedBody), res(200)]),
    invoke: d24Native([refusedV3, v3]),
  });
  await assert.rejects(setSeats(h.ops, h.port, CH, [ME, BOB, CAROL], 5), {
    type: "SeatListNamesRemovedUsers",
  });
  const order: string[] = [];
  const api = h.port.api;
  h.port.api = (async (method: never, path: never, body?: never) => {
    order.push(`${method} ${path}`);
    return body === undefined ? api(method, path) : api(method, path, body);
  }) as ProtectedTextPort["api"];
  const invoke = h.port.invoke;
  h.port.invoke = (async (cmd: never, args: never) => {
    order.push(cmd);
    return invoke(cmd, args);
  }) as ProtectedTextPort["invoke"];
  // The owner opens the picker again and saves without the removed user.
  await setSeats(h.ops, h.port, CH, [ME, BOB], 5);
  const seatsPath = `GET /channels/${CH}/seats`;
  assert.deepEqual(order.slice(0, 3), [
    seatsPath,
    "e2ee_text_seat_list_verify",
    "e2ee_text_seat_list_sign",
  ]);
  const signs = cmds(h, "e2ee_text_seat_list_sign");
  assert.equal(signs.length, 2);
  // signed from the server's CURRENT list (still v2: the refusal wrote nothing)
  assert.deepEqual(signs[1].args.serverList, { version: 2, body: "body-v2" });
  assert.deepEqual(signs[1].args.seats, [ME, BOB]);
  const p = puts(h);
  assert.equal(p.length, 2);
  assert.deepEqual(p[1].body, {
    body: "body-v3",
    signature: "SIG3",
    signer_device_id: MY_DEV,
  });
  assert.equal(h.store.size, 0);
});

test("W2 C1: a stored refused publish (crash window) is re-PUT once by the D7c rule, then resolves; nothing signed", async () => {
  const h = harness({
    routes: seatsRoutes([res(400, removedBody), res(200)]),
    invoke: d24Native([v3]),
  });
  const key = publishStoreKey(ME, CH);
  h.store.set(key, JSON.stringify({ v: 1, op: "seats", signed: refusedV3 }));
  await assert.rejects(setSeats(h.ops, h.port, CH, [ME, BOB], 5), {
    type: "SeatListNamesRemovedUsers",
  });
  assert.equal(puts(h).length, 1);
  assert.equal((puts(h)[0].body as { body: string }).body, "body-v3-carol");
  assert.equal(cmds(h, "e2ee_text_seat_list_sign").length, 0);
  assert.equal(h.store.size, 0, "resolved: the next flow is not blocked");
  await setSeats(h.ops, h.port, CH, [ME, BOB], 5);
  assert.equal(puts(h).length, 2);
  assert.equal((puts(h)[1].body as { body: string }).body, "body-v3");
});

test("setSeats: 5xx then 429 re-PUT the same bytes until 2xx", async () => {
  const h = harness({
    routes: seatsRoutes([
      res(502),
      res(429, { retry_after: 3, type: "InSlowmode" }),
      res(200),
    ]),
    invoke: {
      e2ee_text_seat_list_verify: () => verdict([ME]),
      e2ee_text_seat_list_sign: () => v3,
      e2ee_text_state: () => nativeState([]),
    },
  });
  await setSeats(h.ops, h.port, CH, [ME], 5);
  assert.equal(puts(h).length, 3);
  assert.deepEqual(h.sleeps, [250, 3000]);
  assert.equal(cmds(h, "e2ee_text_seat_list_sign").length, 1);
});

test("an unreadable stored publish blocks the sign and stays stored", async () => {
  // A stored v3 publish whose outcome cannot be read yet (the seats GET
  // keeps failing, then the manager goes away): nothing new is signed.
  const h = harness({
    routes: { [`GET /channels/${CH}/seats`]: [res(503)] },
    invoke: { e2ee_text_seat_list_sign: () => v3 },
    sleepRejectsAfter: 2,
  });
  const key = publishStoreKey(ME, CH);
  h.store.set(key, JSON.stringify({ v: 1, op: "seats", signed: v3 }));
  await assert.rejects(setSeats(h.ops, h.port, CH, [ME], 5), {
    source: "client",
    reason: "aborted",
  });
  assert.equal(cmds(h, "e2ee_text_seat_list_sign").length, 0);
  assert.equal(puts(h).length, 0);
  assert.ok(h.store.get(key), "still unresolved: the entry stays");
});

test("the manager's own publishInFlight (raised around this call) does not block the sign", async () => {
  const h = harness({
    routes: seatsRoutes([res(200)]),
    state: { publishInFlight: true },
    invoke: {
      e2ee_text_seat_list_verify: () => verdict([ME]),
      e2ee_text_seat_list_sign: () => v3,
      e2ee_text_state: () => nativeState([]),
    },
  });
  await setSeats(h.ops, h.port, CH, [ME], 5);
  assert.equal(cmds(h, "e2ee_text_seat_list_sign").length, 1);
});

test("control: signing is refused while a publish is unresolved (a stored D7c publish resolves first by GET, then the new sign)", async () => {
  let current = v3; // the stored v3 already landed
  const v4 = genesis({ version: 4, body: "body-v4", signature: "SIG4" });
  const h = harness({
    routes: {
      [`GET /channels/${CH}/seats`]: () =>
        res(200, seatsBody(listOf(current), 7, "g0")),
      [`PUT /channels/${CH}/seats`]: () => {
        current = v4;
        return res(200);
      },
    },
    invoke: {
      e2ee_text_seat_list_verify: () => verdict([ME]),
      e2ee_text_seat_list_sign: () => v4,
      e2ee_text_state: () => nativeState([]),
    },
  });
  const key = publishStoreKey(ME, CH);
  h.store.set(key, JSON.stringify({ v: 1, op: "seats", signed: v3 }));
  let storedAtSign: string | null = "unset";
  const sign = h.port.invoke;
  h.port.invoke = (async (cmd: never, args: never) => {
    if (cmd === "e2ee_text_seat_list_sign")
      storedAtSign = h.store.get(key) ?? null;
    return sign(cmd, args);
  }) as ProtectedTextPort["invoke"];
  await setSeats(h.ops, h.port, CH, [ME], 5);
  assert.equal(
    storedAtSign,
    null,
    "sign only after the stored publish resolved",
  );
  assert.deepEqual(cmds(h, "e2ee_text_seat_list_sign")[0].args.serverList, {
    version: 3,
    body: "body-v3",
  });
  assert.equal(puts(h).length, 1, "the landed v3 is not re-PUT");
});

test("a stored seat publish that has not landed is re-PUT with the SAME bytes", async () => {
  const h = harness({
    routes: seatsRoutes([res(200)]),
    invoke: {
      e2ee_text_seat_list_verify: () => verdict([ME]),
      e2ee_text_seat_list_sign: () =>
        genesis({ version: 4, body: "b4", signature: "S4" }),
      e2ee_text_state: () => nativeState([]),
    },
  });
  h.store.set(
    publishStoreKey(ME, CH),
    JSON.stringify({ v: 1, op: "seats", signed: v3 }),
  );
  await setSeats(h.ops, h.port, CH, [ME], 5);
  assert.deepEqual(puts(h)[0].body, {
    body: "body-v3",
    signature: "SIG3",
    signer_device_id: MY_DEV,
  });
});

test("a corrupt D7c entry is dropped and the GET-first path runs", async () => {
  const h = harness({
    routes: seatsRoutes([res(200)]),
    invoke: {
      e2ee_text_seat_list_verify: () => verdict([ME]),
      e2ee_text_seat_list_sign: () => v3,
      e2ee_text_state: () => nativeState([]),
    },
  });
  h.store.set(publishStoreKey(ME, CH), "{not json");
  await setSeats(h.ops, h.port, CH, [ME], 5);
  assert.equal(cmds(h, "e2ee_text_seat_list_sign").length, 1);
});

test("concurrent owner flows on one channel: the second is refused", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h = harness({
    routes: seatsRoutes([res(200)]),
    invoke: {
      e2ee_text_seat_list_verify: async () => {
        await gate;
        return verdict([ME]);
      },
      e2ee_text_seat_list_sign: () => v3,
      e2ee_text_state: () => nativeState([]),
    },
  });
  const first = setSeats(h.ops, h.port, CH, [ME], 5);
  await assert.rejects(setSeats(h.ops, h.port, CH, [ME], 5), {
    reason: "publish_in_flight",
  });
  release();
  await first;
});

test("setSeats: a signed version that is not current+1 or not this device is refused before any PUT", async () => {
  const h = harness({
    routes: seatsRoutes([res(200)]),
    invoke: {
      e2ee_text_seat_list_verify: () => verdict([ME]),
      e2ee_text_seat_list_sign: () =>
        genesis({ version: 5, body: "x", signature: "y" }),
    },
  });
  await assert.rejects(setSeats(h.ops, h.port, CH, [ME], 5), {
    reason: "publish_refused",
  });
  assert.equal(puts(h).length, 0);
  assert.equal(h.store.size, 0);
});

// ---------------------------------------------------------------------------
// S2 (W4 L2o): format rule (j), authority, signOwnerDevices, D40 reason
// ---------------------------------------------------------------------------

const OTHER_DEV = "bb".repeat(16);
const THIRD_DEV = "cc".repeat(16);
const AUTH: SignedAuthority = {
  body: `sloga-channel-authority-v1\nv:1\nowner_devices:${MY_DEV}.K1,${OTHER_DEV}.K2`,
  signature: "ASIG1",
};
const NEW_AUTH: SignedAuthority = {
  body: `sloga-channel-authority-v1\nv:1\nowner_devices:${MY_DEV}.K1`,
  signature: "ASIG2",
};
const heldV1 = genesis({
  version: 2,
  body: "sloga-seat-list-v1\nv:1\nversion:2",
  signature: "S2V1",
});
const heldV2 = genesis({
  version: 2,
  body: "sloga-seat-list-v2\nv:2\nversion:2",
  signature: "S2V2",
  authority: AUTH,
});
const nextV2 = genesis({
  version: 3,
  body: "sloga-seat-list-v2\nv:2\nversion:3",
  signature: "S3V2",
  authority: AUTH,
});
const nextV2NewAuth = genesis({
  version: 3,
  body: "sloga-seat-list-v2\nv:2\nversion:3\nnew-authority",
  signature: "S3NA",
  authority: NEW_AUTH,
});

/** GET .../seats serves `start` until a 2xx seat PUT, then `after`. */
function listRoutes(
  start: SignedSeatList,
  after: SignedSeatList,
  putReplies: Reply[],
  extra: Record<string, unknown> = {},
) {
  let current = start;
  const queue = [...putReplies];
  return {
    [`GET /channels/${CH}/seats`]: () =>
      res(200, { ...seatsBody(listOf(current), 7, "g0"), ...extra }),
    [`PUT /channels/${CH}/seats`]: (): Reply => {
      const r = queue.length > 1 ? queue.shift()! : queue[0];
      if (r !== "transport" && r.status < 300) current = after;
      return r;
    },
  };
}

/** Native fakes for a seat flow; verify answers v3 for `next`, else v2. */
const seatNative = (
  next: SignedSeatList,
  members = [{ user_id: ME, device_id: MY_DEV }],
) => ({
  e2ee_text_seat_list_verify: (a: Record<string, unknown>) =>
    verdict([ME, BOB], (a.list as { body: string }).body === next.body ? 3 : 2),
  e2ee_text_seat_list_sign: () => next,
  e2ee_text_authority_sign: () => NEW_AUTH,
  e2ee_text_state: () => nativeState(members),
});

const signArgs = (h: Harness) =>
  cmds(h, "e2ee_text_seat_list_sign").map((c) => c.args);

test("S2 format (rule j): a genesis asks for 2 only while formats_v2 is on; authority null, recovery false", async () => {
  for (const [flag, want] of [
    [true, 2],
    [false, null],
  ] as const) {
    _resetOwnerFlowsForTest();
    const g = genesis();
    const h = harness({
      routes: protectRoutes(g, [res(200)]),
      invoke: {
        e2ee_text_seat_list_sign: () => g,
        e2ee_text_seat_list_verify: () => verdict([ME]),
      },
      formatsV2: flag,
    });
    await protect(h.ops, h.port, CH, [], 0);
    const [a] = signArgs(h);
    assert.equal(a.format, want, `formats_v2 ${flag}`);
    assert.equal(a.authority, null);
    assert.equal(a.recovery, false);
  }
});

test("S2 format (rule j): a port without formatsV2 never asks for 2", async () => {
  const g = genesis();
  const h = harness({
    routes: protectRoutes(g, [res(200)]),
    invoke: {
      e2ee_text_seat_list_sign: () => g,
      e2ee_text_seat_list_verify: () => verdict([ME]),
    },
    formatsV2: true,
  });
  delete h.port.formatsV2;
  await protect(h.ops, h.port, CH, [], 0);
  assert.equal(signArgs(h)[0].format, null);
});

test("S2 format (rule j): the first list over a held v1 asks for 2 with formats_v2 on, null with it off", async () => {
  for (const [flag, want] of [
    [true, 2],
    [false, null],
  ] as const) {
    _resetOwnerFlowsForTest();
    const h = harness({
      routes: listRoutes(heldV1, nextV2, [res(200)]),
      invoke: seatNative(nextV2),
      formatsV2: flag,
    });
    await setSeats(h.ops, h.port, CH, [ME, BOB], 5);
    const [a] = signArgs(h);
    assert.equal(a.format, want, `formats_v2 ${flag}`);
    assert.equal(a.authority, null);
    assert.equal(a.recovery, false);
  }
});

test("S2 format (rule j): never 2 under a held v2 list, whatever formats_v2 says", async () => {
  for (const flag of [true, false]) {
    _resetOwnerFlowsForTest();
    const h = harness({
      routes: listRoutes(heldV2, nextV2, [res(200)]),
      invoke: seatNative(nextV2),
      formatsV2: flag,
    });
    await setSeats(h.ops, h.port, CH, [ME, BOB], 5);
    assert.equal(signArgs(h)[0].format, null, `formats_v2 ${flag}`);
  }
});

test("S2 authority: the served list's authority reaches verify; the signed list's authority rides on the PUT and the D7c entry", async () => {
  const h = harness({
    routes: listRoutes(heldV2, nextV2, [res(200)]),
    invoke: seatNative(nextV2),
    formatsV2: true,
  });
  await setSeats(h.ops, h.port, CH, [ME, BOB], 5);
  const [v] = cmds(h, "e2ee_text_seat_list_verify");
  assert.deepEqual(v.args.list, {
    body: heldV2.body,
    signature: heldV2.signature,
    signer_user_id: ME,
    signer_device_id: MY_DEV,
    authority: AUTH,
  });
  assert.deepEqual(puts(h)[0].body, {
    body: nextV2.body,
    signature: nextV2.signature,
    signer_device_id: MY_DEV,
    authority: AUTH,
  });
  assert.deepEqual(JSON.parse(h.storeAtPut[0]!).signed.authority, AUTH);
});

test("S2-D33: verify carries the snapshot's as_of_generation, null when absent or malformed", async () => {
  for (const [gen, want] of [
    [4, 4],
    [undefined, null],
    [-1, null],
    ["4", null],
  ] as const) {
    _resetOwnerFlowsForTest();
    const h = harness({
      routes: listRoutes(heldV2, nextV2, [res(200)], {
        as_of_generation: gen,
      }),
      invoke: seatNative(nextV2),
    });
    await setSeats(h.ops, h.port, CH, [ME, BOB], 5);
    const verifies = cmds(h, "e2ee_text_seat_list_verify");
    assert.equal(verifies.length, 2);
    for (const c of verifies) {
      assert.equal(c.args.asOfGeneration, want, String(gen));
    }
  }
});

test("S2 signOwnerDevices: verify, ONE authority dialog, the list signed with it over the same seats, persisted, PUT with authority", async () => {
  const h = harness({
    routes: listRoutes(heldV2, nextV2NewAuth, [res(503), res(200)]),
    invoke: seatNative(nextV2NewAuth),
    formatsV2: true,
  });
  await signOwnerDevices(h.ops, h.port, CH, [MY_DEV]);

  assert.deepEqual(h.trace.slice(0, 4), [
    `GET /channels/${CH}/seats`,
    "e2ee_text_seat_list_verify",
    "e2ee_text_authority_sign",
    "e2ee_text_seat_list_sign",
  ]);
  const auths = cmds(h, "e2ee_text_authority_sign");
  assert.equal(auths.length, 1, "the dialog runs exactly once");
  assert.deepEqual(auths[0].args.ownerDevices, [MY_DEV]);
  assert.equal(auths[0].args.userId, ME);
  assert.equal(auths[0].args.channelName, "secret");
  const [a] = signArgs(h);
  assert.deepEqual(a.authority, NEW_AUTH);
  assert.deepEqual(a.seats, [ME, BOB], "the verified list's seats");
  assert.equal(a.deviceCap, 5);
  assert.deepEqual(a.serverList, { version: 2, body: heldV2.body });
  assert.equal(a.format, null, "held v2: native's choice");
  assert.equal(a.recovery, false);

  const p = puts(h);
  assert.equal(p.length, 2, "the 503 is re-sent");
  assert.deepEqual(p[1].body, p[0].body, "SAME bytes");
  assert.deepEqual(p[0].body, {
    body: nextV2NewAuth.body,
    signature: nextV2NewAuth.signature,
    signer_device_id: MY_DEV,
    authority: NEW_AUTH,
  });
  assert.ok(h.storeAtPut[0], "persisted before the PUT");
  assert.equal(signArgs(h).length, 1);
  assert.equal(h.store.size, 0, "resolved");
});

test("S2 signOwnerDevices: a retry after an aborted publish re-sends the stored bytes; no dialog, no sign", async () => {
  const h = harness({
    routes: listRoutes(heldV2, nextV2NewAuth, ["transport"]),
    invoke: seatNative(nextV2NewAuth),
    sleepRejectsAfter: 0,
  });
  await assert.rejects(signOwnerDevices(h.ops, h.port, CH, [MY_DEV]), {
    reason: "aborted",
  });
  const key = publishStoreKey(ME, CH);
  const stored = h.store.get(key);
  assert.ok(stored, "the signed bytes stay stored");

  // A reload: memory is gone, the D7c entry is not.
  _resetOwnerFlowsForTest();
  const h2 = harness({
    routes: listRoutes(heldV2, nextV2NewAuth, [res(200)]),
    invoke: seatNative(nextV2NewAuth),
  });
  h2.store.set(key, stored);
  await signOwnerDevices(h2.ops, h2.port, CH, [MY_DEV]);
  assert.equal(cmds(h2, "e2ee_text_authority_sign").length, 0, "no dialog");
  assert.equal(signArgs(h2).length, 0, "no re-sign");
  assert.equal(puts(h2).length, 1);
  assert.deepEqual(puts(h2)[0].body, puts(h)[0].body, "SAME bytes");
  assert.equal(h2.store.size, 0);
});

test("S2 signOwnerDevices: no v2 list held and formats_v2 off is refused before any dialog; on, it upgrades", async () => {
  const h = harness({
    routes: listRoutes(heldV1, nextV2NewAuth, [res(200)]),
    invoke: seatNative(nextV2NewAuth),
  });
  await assert.rejects(signOwnerDevices(h.ops, h.port, CH, [MY_DEV]), {
    source: "client",
    reason: "authority_needs_v2",
  });
  assert.equal(cmds(h, "e2ee_text_authority_sign").length, 0);
  assert.equal(puts(h).length, 0);

  _resetOwnerFlowsForTest();
  const h2 = harness({
    routes: listRoutes(heldV1, nextV2NewAuth, [res(200)]),
    invoke: seatNative(nextV2NewAuth),
    formatsV2: true,
  });
  await signOwnerDevices(h2.ops, h2.port, CH, [MY_DEV]);
  assert.equal(signArgs(h2)[0].format, 2, "the upgrade list carries it");
  assert.equal(cmds(h2, "e2ee_text_authority_sign").length, 1);
});

test("S2 signOwnerDevices: a signed list that does not carry the new authority is never published", async () => {
  const h = harness({
    routes: listRoutes(heldV2, nextV2, [res(200)]),
    invoke: seatNative(nextV2),
  });
  await assert.rejects(signOwnerDevices(h.ops, h.port, CH, [MY_DEV]), {
    reason: "publish_refused",
  });
  assert.equal(puts(h).length, 0);
  assert.equal(h.store.size, 0);
});

test("S2 signOwnerDevices: empty or non-string device lists are refused before any request", async () => {
  const h = harness({ routes: {}, sleepRejectsAfter: 0 });
  for (const bad of [[], [""], [1], null]) {
    await assert.rejects(
      signOwnerDevices(h.ops, h.port, CH, bad as never),
      { reason: "invalid_argument" },
      JSON.stringify(bad),
    );
  }
  assert.equal(h.calls.length + h.invokes.length, 0);
});

const REASON_REQUIRED = { type: "RemovalReasonRequired" };
const TOO_LONG = { type: "FailedValidation", error: "AuditLogReasonTooLong" };
const REASON = "spam in general";
const WITH_BOB = [
  { user_id: ME, device_id: MY_DEV },
  { user_id: BOB, device_id: "b1" },
];

test("S2 D40: RemovalReasonRequired keeps the bytes; the retry with a reason re-sends them with the header, one sign in all", async () => {
  const h = harness({
    routes: listRoutes(heldV2, nextV2, [res(400, REASON_REQUIRED), res(200)]),
    invoke: {
      ...seatNative(nextV2, WITH_BOB),
      // the new list leaves Bob off
      e2ee_text_seat_list_verify: (a: Record<string, unknown>) =>
        (a.list as { body: string }).body === nextV2.body
          ? verdict([ME], 3)
          : verdict([ME, BOB], 2),
    },
  });
  let failure: unknown = null;
  await assert.rejects(setSeats(h.ops, h.port, CH, [ME], 5), (e) => {
    failure = e;
    return true;
  });
  assert.deepEqual(failure, {
    source: "server",
    status: 400,
    type: "RemovalReasonRequired",
    body: REASON_REQUIRED,
  });
  const ui = protectedNoticeForError(failure, { op: "owner" });
  assert.equal(ui.kind === "notice" && ui.notice, "removal_reason_required");
  const kept = JSON.parse(h.store.get(publishStoreKey(ME, CH))!);
  assert.deepEqual(kept.signed, nextV2, "the signed bytes are kept");
  assert.equal(kept.reasonRequired, true);
  assert.equal(puts(h)[0].headers, undefined, "no reason yet");
  assert.equal(h.opsLog.filter((o) => o[0] === "removeDevices").length, 0);

  // The owner adds a reason in the UI; the caller retries with it.
  await setSeats(h.ops, h.port, CH, [ME], 5, REASON);
  const p = puts(h);
  assert.equal(p.length, 2);
  assert.deepEqual(p[1].body, p[0].body, "the SAME bytes");
  assert.deepEqual(p[1].headers, { "X-Audit-Log-Reason": REASON });
  assert.equal(signArgs(h).length, 1, "exactly one sign");
  assert.equal(h.store.size, 0, "resolved");
  assert.deepEqual(
    h.opsLog.filter((o) => o[0] === "removeDevices"),
    [
      [
        "removeDevices",
        CH,
        [{ user_id: BOB, device_id: "b1" }],
        { rejoinIntent: null },
      ],
    ],
  );
});

test("S2 D40: a reason given up front rides on every seat PUT attempt and never on a GET", async () => {
  const h = harness({
    routes: listRoutes(heldV2, nextV2, [res(503), res(200)]),
    invoke: seatNative(nextV2),
  });
  await setSeats(h.ops, h.port, CH, [ME], 5, REASON);
  const p = puts(h);
  assert.equal(p.length, 2);
  for (const c of p) {
    assert.deepEqual(c.headers, { "X-Audit-Log-Reason": REASON });
  }
  for (const c of h.calls.filter((c) => c.method === "GET")) {
    assert.equal(c.headers, undefined);
  }
});

test("S2 D40: without a reason the kept publish is re-sent bare, refused again, still kept; nothing signed", async () => {
  const h = harness({
    routes: listRoutes(heldV2, nextV2, [res(400, REASON_REQUIRED)]),
    invoke: seatNative(nextV2),
  });
  await assert.rejects(setSeats(h.ops, h.port, CH, [ME], 5), {
    type: "RemovalReasonRequired",
  });
  await assert.rejects(setSeats(h.ops, h.port, CH, [ME, BOB], 5), {
    type: "RemovalReasonRequired",
  });
  const p = puts(h);
  assert.equal(p.length, 2);
  assert.deepEqual(p[1].body, p[0].body);
  assert.equal(p[1].headers, undefined);
  assert.equal(signArgs(h).length, 1);
  assert.ok(h.store.get(publishStoreKey(ME, CH)), "still kept");
});

test("S2 D40: AuditLogReasonTooLong keeps the bytes and surfaces through reasonRefusal; a shorter reason re-sends them", async () => {
  const h = harness({
    routes: listRoutes(heldV2, nextV2, [res(400, TOO_LONG), res(200)]),
    invoke: seatNative(nextV2),
  });
  let failure: unknown = null;
  await assert.rejects(setSeats(h.ops, h.port, CH, [ME], 5, "x"), (e) => {
    failure = e;
    return true;
  });
  assert.deepEqual(failure, {
    source: "server",
    status: 400,
    type: "FailedValidation",
    body: TOO_LONG,
  });
  assert.equal(reasonRefusal((failure as { body: unknown }).body), "too_long");
  assert.ok(h.store.get(publishStoreKey(ME, CH)), "the bytes are kept");
  await setSeats(h.ops, h.port, CH, [ME], 5, "y");
  const p = puts(h);
  assert.equal(p.length, 2);
  assert.deepEqual(p[1].body, p[0].body);
  assert.deepEqual(p[1].headers, { "X-Audit-Log-Reason": "y" });
  assert.equal(signArgs(h).length, 1);
  assert.equal(h.store.size, 0);
});

test("S2 D40: any other FailedValidation still resolves the publish (the bytes are used up)", async () => {
  const other = { type: "FailedValidation", error: "SomethingElse" };
  const h = harness({
    routes: listRoutes(heldV2, nextV2, [res(400, other)]),
    invoke: seatNative(nextV2),
  });
  await assert.rejects(setSeats(h.ops, h.port, CH, [ME], 5, REASON), {
    type: "FailedValidation",
  });
  assert.equal(h.store.size, 0);
});

test("S2 D40: a blank reason is refused before any request or sign", async () => {
  // sleepRejectsAfter 0: a reason let through ends at the first backoff
  const h = harness({ routes: {}, sleepRejectsAfter: 0 });
  for (const bad of ["", "   ", " \n ", null, 7]) {
    await assert.rejects(
      setSeats(h.ops, h.port, CH, [ME], 5, bad as never),
      { source: "client", reason: "invalid_argument" },
      JSON.stringify(bad),
    );
  }
  assert.equal(h.calls.length + h.invokes.length, 0);
});

// ---------------------------------------------------------------------------
// S2 F3: pendingSeats / cancelPendingSeats
// ---------------------------------------------------------------------------

/** Requests and native calls so far (cancel must add neither). */
const traffic = (h: Harness) => h.calls.length + h.invokes.length;

const storedEntry = (h: Harness) => {
  const raw = h.store.get(publishStoreKey(ME, CH));
  return raw === undefined ? null : JSON.parse(raw);
};

test("S2 F3: a publish refused for its reason is discarded: pendingSeats then null, nothing signed or sent by the discard; the next setSeats signs afresh", async () => {
  const h = harness({
    routes: listRoutes(heldV2, nextV2, [res(400, REASON_REQUIRED), res(200)]),
    invoke: seatNative(nextV2),
  });
  await assert.rejects(setSeats(h.ops, h.port, CH, [ME], 5), {
    type: "RemovalReasonRequired",
  });
  assert.deepEqual(pendingSeats(h.port, CH), {
    kind: "seats",
    reasonRequired: true,
    discardable: true,
  });
  assert.equal(storedEntry(h)?.answer, "refused");
  const before = traffic(h);
  assert.deepEqual(cancelPendingSeats(h.port, CH), { discarded: true });
  assert.equal(traffic(h), before, "the discard signs and sends nothing");
  assert.equal(pendingSeats(h.port, CH), null);
  assert.equal(h.store.size, 0);
  assert.deepEqual(cancelPendingSeats(h.port, CH), {
    discarded: false,
    why: "none",
  });

  // No longer blocked: the next change verifies, signs and publishes anew.
  await setSeats(h.ops, h.port, CH, [ME, BOB], 5);
  assert.equal(signArgs(h).length, 2);
  assert.equal(h.store.size, 0, "resolved");
});

test("S2 F3: a reason re-send that may have reached the server is never discarded; the next flow re-sends the SAME bytes", async () => {
  const h = harness({
    routes: listRoutes(heldV2, nextV2, [
      res(400, REASON_REQUIRED),
      "transport",
    ]),
    invoke: seatNative(nextV2),
    sleepRejectsAfter: 0,
  });
  await assert.rejects(setSeats(h.ops, h.port, CH, [ME], 5), {
    type: "RemovalReasonRequired",
  });
  assert.equal(pendingSeats(h.port, CH)?.discardable, true);
  // The owner adds a reason; that PUT gets no answer, then the flow ends.
  await assert.rejects(setSeats(h.ops, h.port, CH, [ME], 5, REASON), {
    reason: "aborted",
  });
  assert.deepEqual(pendingSeats(h.port, CH), {
    kind: "seats",
    reasonRequired: true,
    discardable: false,
  });
  const before = traffic(h);
  assert.deepEqual(cancelPendingSeats(h.port, CH), {
    discarded: false,
    why: "maybe_accepted",
  });
  assert.equal(traffic(h), before);
  const kept = storedEntry(h);
  assert.deepEqual(kept?.signed, nextV2, "the bytes stay");
  assert.equal(kept?.answer, "sent");

  // Resume after a reload: same bytes, no sign.
  _resetOwnerFlowsForTest();
  const h2 = harness({
    routes: listRoutes(heldV2, nextV2, [res(200)]),
    invoke: seatNative(nextV2),
  });
  h2.store.set(publishStoreKey(ME, CH), JSON.stringify(kept));
  await setSeats(h2.ops, h2.port, CH, [ME], 5, REASON);
  assert.equal(signArgs(h2).length, 0);
  assert.deepEqual(puts(h2)[0].body, puts(h)[0].body, "SAME bytes");
  assert.equal(h2.store.size, 0);
});

test("S2 F3: one maybe-accepted attempt is sticky: a transport error before the reason refusal keeps the publish", async () => {
  const h = harness({
    routes: listRoutes(heldV2, nextV2, [
      "transport",
      res(400, REASON_REQUIRED),
    ]),
    invoke: seatNative(nextV2),
  });
  await assert.rejects(setSeats(h.ops, h.port, CH, [ME], 5), {
    type: "RemovalReasonRequired",
  });
  assert.equal(puts(h).length, 2);
  assert.deepEqual(pendingSeats(h.port, CH), {
    kind: "seats",
    reasonRequired: true,
    discardable: false,
  });
  assert.deepEqual(cancelPendingSeats(h.port, CH), {
    discarded: false,
    why: "maybe_accepted",
  });
  assert.ok(storedEntry(h), "kept");
});

test("S2 F3: an entry persisted before F3 (no answer recorded) is never discarded, not even after a fresh reason refusal", async () => {
  for (const old of [
    { v: 1, op: "seats", signed: nextV2, reasonRequired: true },
    { v: 1, op: "seats", signed: nextV2NewAuth, ownerDevices: true },
    { v: 1, op: "seats", signed: nextV2, reasonRequired: true, answer: "x" },
  ]) {
    _resetOwnerFlowsForTest();
    const h = harness({
      routes: listRoutes(heldV2, nextV2, [res(400, REASON_REQUIRED)]),
      invoke: seatNative(nextV2),
    });
    h.store.set(publishStoreKey(ME, CH), JSON.stringify(old));
    const label = JSON.stringify(Object.keys(old));
    assert.equal(pendingSeats(h.port, CH)?.discardable, false, label);
    assert.deepEqual(
      cancelPendingSeats(h.port, CH),
      { discarded: false, why: "maybe_accepted" },
      label,
    );
    // Resumed (same bytes) and refused for its reason again: still kept.
    await assert.rejects(setSeats(h.ops, h.port, CH, [ME], 5), {
      type: "RemovalReasonRequired",
    });
    assert.equal(signArgs(h).length, 0, label);
    assert.equal(pendingSeats(h.port, CH)?.reasonRequired, true, label);
    assert.deepEqual(
      cancelPendingSeats(h.port, CH),
      { discarded: false, why: "maybe_accepted" },
      label,
    );
    assert.deepEqual(storedEntry(h)?.signed, old.signed, label);
  }
});

test("S2 F3: an owner-devices publish only ever refused by the rate limiter (429) is discarded; after a 5xx it is kept; a plain seat publish is never abandoned this way", async () => {
  const h = harness({
    routes: listRoutes(heldV2, nextV2NewAuth, [res(429)]),
    invoke: seatNative(nextV2NewAuth),
    sleepRejectsAfter: 0,
  });
  await assert.rejects(signOwnerDevices(h.ops, h.port, CH, [MY_DEV]), {
    reason: "aborted",
  });
  assert.deepEqual(pendingSeats(h.port, CH), {
    kind: "owner_devices",
    reasonRequired: false,
    discardable: true,
  });
  const before = traffic(h);
  assert.deepEqual(cancelPendingSeats(h.port, CH), { discarded: true });
  assert.equal(traffic(h), before, "no dialog, no sign, no request");
  assert.equal(h.store.size, 0);

  _resetOwnerFlowsForTest();
  const h2 = harness({
    routes: listRoutes(heldV2, nextV2NewAuth, [res(429), res(503)]),
    invoke: seatNative(nextV2NewAuth),
    sleepRejectsAfter: 1,
  });
  await assert.rejects(signOwnerDevices(h2.ops, h2.port, CH, [MY_DEV]), {
    reason: "aborted",
  });
  assert.equal(puts(h2).length, 2);
  assert.deepEqual(pendingSeats(h2.port, CH), {
    kind: "owner_devices",
    reasonRequired: false,
    discardable: false,
  });
  assert.deepEqual(cancelPendingSeats(h2.port, CH), {
    discarded: false,
    why: "maybe_accepted",
  });

  _resetOwnerFlowsForTest();
  const h3 = harness({
    routes: listRoutes(heldV2, nextV2, [res(429)]),
    invoke: seatNative(nextV2),
    sleepRejectsAfter: 0,
  });
  await assert.rejects(setSeats(h3.ops, h3.port, CH, [ME], 5), {
    reason: "aborted",
  });
  assert.deepEqual(pendingSeats(h3.port, CH), {
    kind: "seats",
    reasonRequired: false,
    discardable: false,
  });
  assert.deepEqual(cancelPendingSeats(h3.port, CH), {
    discarded: false,
    why: "maybe_accepted",
  });
});

test("S2 F3: while an owner flow runs on the channel, cancel answers busy and keeps the entry", async () => {
  const h = harness({
    routes: listRoutes(heldV2, nextV2NewAuth, [res(429)]),
    invoke: seatNative(nextV2NewAuth),
  });
  let release: (e: Error) => void = () => undefined;
  h.port.sleep = () =>
    new Promise<void>((_ok, fail) => {
      release = fail;
    });
  const flow = signOwnerDevices(h.ops, h.port, CH, [MY_DEV]);
  for (let i = 0; i < 100 && storedEntry(h)?.answer !== "refused"; i++) {
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(storedEntry(h)?.answer, "refused", "parked after the 429");
  assert.equal(pendingSeats(h.port, CH)?.discardable, false);
  assert.deepEqual(cancelPendingSeats(h.port, CH), {
    discarded: false,
    why: "busy",
  });
  assert.ok(storedEntry(h));
  release(new Error("aborted"));
  await assert.rejects(flow, { reason: "aborted" });
  assert.deepEqual(cancelPendingSeats(h.port, CH), { discarded: true });
});

test("S2 F3: a re-send whose write-ahead cannot reach the store is not sent while the store still says refused", async () => {
  const h = harness({
    routes: listRoutes(heldV2, nextV2, [res(200)]),
    invoke: seatNative(nextV2),
    storeSetFails: true,
  });
  // A reason-refused entry from an earlier session (stored directly).
  h.store.set(
    publishStoreKey(ME, CH),
    JSON.stringify({
      v: 1,
      op: "seats",
      signed: nextV2,
      reasonRequired: true,
      answer: "refused",
    }),
  );
  await assert.rejects(setSeats(h.ops, h.port, CH, [ME], 5, REASON), {
    source: "client",
    reason: "publish_not_persisted",
  });
  assert.equal(puts(h).length, 0, "nothing went out");
  assert.equal(signArgs(h).length, 0);
  // Still never accepted: the owner may discard it.
  assert.equal(pendingSeats(h.port, CH)?.discardable, true);
});

const seatsWith = (
  authority: SignedAuthority | undefined,
  revoked: unknown,
): ProtectedSeatsResponse =>
  ({
    ...seatsBody(listOf({ ...heldV2, authority }), 7, "g0"),
    revoked_owner_devices: revoked,
  }) as ProtectedSeatsResponse;

const authOf = (devices: string): SignedAuthority => ({
  body: `sloga-channel-authority-v1\nv:1\nowner_devices:${devices}\nprev:`,
  signature: "A",
});

test("S2 R27: proposedOwnerDevices drops the revoked devices of the served authority and keeps this device", () => {
  const three = authOf(`${THIRD_DEV}.K3,${MY_DEV}.K1,${OTHER_DEV}.K2`);
  assert.deepEqual(
    proposedOwnerDevices(seatsWith(three, [OTHER_DEV]), MY_DEV),
    [MY_DEV, THIRD_DEV],
  );
  // This device not listed yet: added (native needs the signer in the set).
  const others = authOf(`${OTHER_DEV}.K2,${THIRD_DEV}.K3`);
  assert.deepEqual(
    proposedOwnerDevices(seatsWith(others, [OTHER_DEV]), MY_DEV),
    [MY_DEV, THIRD_DEV],
  );
});

test("S2 R27: proposedOwnerDevices offers nothing when there is nothing safe to offer", () => {
  const cases: [string, ProtectedSeatsResponse | null][] = [
    ["no snapshot", null],
    ["absent", seatsWith(AUTH, undefined)],
    ["empty", seatsWith(AUTH, [])],
    ["not an array", seatsWith(AUTH, OTHER_DEV)],
    ["no authority", seatsWith(undefined, [OTHER_DEV])],
    ["not of this authority", seatsWith(AUTH, [THIRD_DEV])],
    ["this device revoked", seatsWith(AUTH, [MY_DEV])],
    ["unreadable entry", seatsWith(authOf("x"), [OTHER_DEV])],
    [
      "no owner_devices line",
      seatsWith({ body: "sloga-channel-authority-v1", signature: "A" }, [
        OTHER_DEV,
      ]),
    ],
  ];
  for (const [label, seats] of cases) {
    assert.equal(proposedOwnerDevices(seats, MY_DEV), null, label);
  }
});

// ---------------------------------------------------------------------------
// S2 F5 (S2-D42): moveOwnerKey, the same-user K0 -> K1 handover (design 4.6)
// ---------------------------------------------------------------------------

/** A handover statement as native signs it (design 4.6 line order). */
const handoverOf = (to = OTHER_DEV, over: Record<string, string> = {}) => {
  const fields: Record<string, string> = {
    channel_id: CH,
    from_user_id: ME,
    from_device_id: MY_DEV,
    from_identity_key: "K0KEY",
    to_user_id: ME,
    to_device_id: to,
    to_identity_key: "K1KEY",
    issued_at: "1700000000000",
    ...over,
  };
  const lines = Object.entries(fields).map(([k, v]) => `${k}:${v}`);
  return {
    body: ["sloga-owner-handover-v1", "v:1", ...lines].join("\n"),
    signature: `HSIG-${to}`,
  };
};

const HANDOVER = handoverOf();
const nextV1 = genesis({
  version: 3,
  body: "sloga-seat-list-v1\nv:1\nversion:3",
  signature: "S3V1",
});
const OWN_LISTING = [
  { device_id: MY_DEV, session_name: "this one" },
  { device_id: OTHER_DEV, session_name: "laptop" },
  { device: THIRD_DEV },
];

/** A seat-flow harness whose own listing holds this device and K1. */
function moveHarness(
  over: {
    start?: SignedSeatList;
    putReplies?: Reply[];
    invoke?: Partial<
      Record<string, (args: Record<string, unknown>) => unknown>
    >;
    sleepRejectsAfter?: number;
    formatsV2?: boolean;
  } = {},
): Harness {
  const h = harness({
    routes: listRoutes(
      over.start ?? heldV1,
      nextV1,
      over.putReplies ?? [res(200)],
    ),
    invoke: {
      ...seatNative(nextV1),
      e2ee_text_owner_handover_sign: () => HANDOVER,
      e2ee_text_pin_own_devices: () => null,
      ...over.invoke,
    },
    sleepRejectsAfter: over.sleepRejectsAfter,
    formatsV2: over.formatsV2,
  });
  h.port.ownDeviceListing = async () => ({ hash: "h", listing: OWN_LISTING });
  return h;
}

test("S2 F5 moveOwnerKey: verify, ONE handover dialog for this user's target, the next list signed HERE over the same seats, PUT with the statement as handover", async () => {
  const h = moveHarness({ putReplies: [res(503), res(200)] });
  await moveOwnerKey(h.ops, h.port, CH, OTHER_DEV);

  assert.deepEqual(h.trace.slice(0, 5), [
    `GET /channels/${CH}/seats`,
    "e2ee_text_seat_list_verify",
    "e2ee_text_owner_handover_sign",
    "e2ee_text_seat_list_sign",
    `PUT /channels/${CH}/seats`,
  ]);
  const hs = cmds(h, "e2ee_text_owner_handover_sign");
  assert.equal(hs.length, 1, "the dialog runs exactly once");
  assert.deepEqual(hs[0].args, {
    channelId: CH,
    userId: ME,
    toUserId: ME,
    toDeviceId: OTHER_DEV,
    channelName: "secret",
    displayNames: [{ user_id: ME, name: ME }],
  });
  const [a] = signArgs(h);
  assert.deepEqual(a.seats, [ME, BOB], "the verified list's seats");
  assert.equal(a.deviceCap, 5);
  assert.deepEqual(a.serverList, { version: 2, body: heldV1.body });
  assert.equal(a.authority, null);
  assert.equal(a.recovery, false);
  assert.equal(a.format, null, "formats_v2 off: native's choice");

  const p = puts(h);
  assert.equal(p.length, 2, "the 503 is re-sent");
  assert.deepEqual(p[0].body, {
    body: nextV1.body,
    signature: nextV1.signature,
    signer_device_id: MY_DEV,
    handover: HANDOVER,
  });
  assert.deepEqual(p[1].body, p[0].body, "SAME bytes, SAME statement");
  const stored = JSON.parse(h.storeAtPut[0]!);
  assert.deepEqual(stored.handover, HANDOVER, "stored with the bytes");
  assert.deepEqual(stored.signed, nextV1);
  assert.equal(signArgs(h).length, 1);
  assert.equal(h.store.size, 0, "resolved");
  // Read back and verified (the chain is now served with the list).
  assert.equal(cmds(h, "e2ee_text_seat_list_verify").length, 2);
});

test("S2 F5 moveOwnerKey: the first list over a held v1 follows rule (j) like every other list", async () => {
  const h = moveHarness({ formatsV2: true });
  await moveOwnerKey(h.ops, h.port, CH, OTHER_DEV);
  assert.equal(signArgs(h)[0].format, 2);
  assert.deepEqual(
    (puts(h)[0].body as { handover?: unknown }).handover,
    HANDOVER,
  );
});

test("S2 F5 moveOwnerKey: a retry after an aborted publish re-sends the stored bytes WITH the stored statement; no dialog, no sign", async () => {
  const h = moveHarness({ putReplies: ["transport"], sleepRejectsAfter: 0 });
  await assert.rejects(moveOwnerKey(h.ops, h.port, CH, OTHER_DEV), {
    reason: "aborted",
  });
  const key = publishStoreKey(ME, CH);
  const stored = h.store.get(key);
  assert.ok(stored, "the signed bytes stay stored");
  assert.deepEqual(JSON.parse(stored).handover, HANDOVER);

  // A reload: memory is gone, the D7c entry is not.
  _resetOwnerFlowsForTest();
  const h2 = moveHarness();
  h2.store.set(key, stored);
  await moveOwnerKey(h2.ops, h2.port, CH, OTHER_DEV);
  assert.equal(
    cmds(h2, "e2ee_text_owner_handover_sign").length,
    0,
    "no dialog",
  );
  assert.equal(signArgs(h2).length, 0, "no re-sign");
  assert.equal(puts(h2).length, 1);
  assert.deepEqual(
    (puts(h2)[0].body as { handover?: unknown }).handover,
    HANDOVER,
    "the statement rides on the re-send",
  );
  assert.deepEqual(puts(h2)[0].body, puts(h)[0].body, "SAME bytes");
  assert.equal(h2.store.size, 0);
});

test("S2 F5 moveOwnerKey: another flow resuming a stored handover publish re-sends the statement too, and never puts it on its own list", async () => {
  const next4 = genesis({
    version: 4,
    body: "sloga-seat-list-v1\nv:1\nversion:4",
    signature: "S4V1",
  });
  const h = moveHarness({
    invoke: { e2ee_text_seat_list_sign: () => next4 },
  });
  h.store.set(
    publishStoreKey(ME, CH),
    JSON.stringify({
      v: 1,
      op: "seats",
      signed: nextV1,
      handover: HANDOVER,
      answer: "sent",
    }),
  );
  await setSeats(h.ops, h.port, CH, [ME, BOB], 5);
  const p = puts(h);
  assert.equal(p.length, 2);
  assert.deepEqual(p[0].body, {
    body: nextV1.body,
    signature: nextV1.signature,
    signer_device_id: MY_DEV,
    handover: HANDOVER,
  });
  assert.deepEqual(p[1].body, {
    body: next4.body,
    signature: next4.signature,
    signer_device_id: MY_DEV,
  });
});

test("S2 F5 moveOwnerKey: on a device that did not sign the served list it is refused before any dialog", async () => {
  const heldByK1 = genesis({
    version: 2,
    body: "sloga-seat-list-v1\nv:1\nversion:2\nby-k1",
    signature: "S2K1",
    signer_device_id: OTHER_DEV,
  });
  const h = moveHarness({
    start: heldByK1,
    invoke: {
      e2ee_text_seat_list_verify: (a) => ({
        ...verdict([ME, BOB], 2),
        signer_device_id: (a.list as { signer_device_id: string })
          .signer_device_id,
      }),
    },
  });
  h.port.ownDeviceListing = async () => ({
    hash: "h2",
    listing: [...OWN_LISTING, { device_id: THIRD_DEV }],
  });
  await assert.rejects(moveOwnerKey(h.ops, h.port, CH, THIRD_DEV), {
    source: "client",
    reason: "not_signing_device",
  });
  assert.equal(cmds(h, "e2ee_text_seat_list_verify").length, 1);
  assert.equal(cmds(h, "e2ee_text_owner_handover_sign").length, 0);
  assert.equal(signArgs(h).length, 0);
  assert.equal(puts(h).length, 0);
  assert.equal(h.store.size, 0);
});

test("S2 F5 moveOwnerKey: a device outside this user's listing (another user's, or unknown) is refused before any request or dialog", async () => {
  const h = moveHarness();
  for (const to of [THIRD_DEV, "dd".repeat(16)]) {
    await assert.rejects(
      moveOwnerKey(h.ops, h.port, CH, to),
      { source: "client", reason: "handover_target_not_own" },
      to,
    );
  }
  assert.equal(h.calls.length + h.invokes.length, 0);
});

test("S2 F5 moveOwnerKey: this device as the target is refused before anything", async () => {
  const h = moveHarness();
  await assert.rejects(moveOwnerKey(h.ops, h.port, CH, MY_DEV), {
    source: "client",
    reason: "handover_self_target",
  });
  for (const bad of ["", null, 7]) {
    await assert.rejects(
      moveOwnerKey(h.ops, h.port, CH, bad as never),
      { reason: "invalid_argument" },
      String(bad),
    );
  }
  assert.equal(h.calls.length + h.invokes.length, 0);
});

test("S2 F5 moveOwnerKey: under a served authority the chain would qualify no one: refused before any dialog", async () => {
  const h = moveHarness({ start: heldV2 });
  await assert.rejects(moveOwnerKey(h.ops, h.port, CH, OTHER_DEV), {
    source: "client",
    reason: "authority_held",
  });
  assert.equal(cmds(h, "e2ee_text_owner_handover_sign").length, 0);
  assert.equal(puts(h).length, 0);
});

test("S2 F5 moveOwnerKey: a statement that is not the one asked for is never published", async () => {
  const wrong = [
    handoverOf(THIRD_DEV),
    handoverOf(OTHER_DEV, { from_device_id: THIRD_DEV }),
    // FX-R LOW-6: each signed field is checked on its own.
    handoverOf(OTHER_DEV, { from_user_id: BOB }),
    handoverOf(OTHER_DEV, { to_user_id: BOB }),
    handoverOf(OTHER_DEV, { channel_id: "01OTHERCHANNEL00000000000A" }),
    { body: HANDOVER.body.replace("handover", "succession"), signature: "X" },
    { body: HANDOVER.body },
  ];
  for (const answer of wrong) {
    _resetOwnerFlowsForTest();
    const h = moveHarness({
      invoke: { e2ee_text_owner_handover_sign: () => answer },
    });
    await assert.rejects(moveOwnerKey(h.ops, h.port, CH, OTHER_DEV), {
      source: "client",
      reason: "publish_refused",
    });
    assert.equal(signArgs(h).length, 0);
    assert.equal(puts(h).length, 0);
    assert.equal(h.store.size, 0);
  }
});

test("F-R8: the own listing is asked for the device in question: the own pin native names (setSeats verify, handover sign) and the handover target", async () => {
  // setSeats: the verify's own-device pin (`pinIdentity`).
  let n = 0;
  const h = harness({
    routes: seatsRoutes([res(200)]),
    invoke: {
      e2ee_text_seat_list_verify: () => {
        if (n++ === 0) {
          throw {
            type: "identity_pin_required",
            user_id: ME,
            device_id: MY_DEV,
          };
        }
        return verdict([ME]);
      },
      e2ee_text_pin_own_devices: () => null,
      e2ee_text_seat_list_sign: () => v3,
      e2ee_text_state: () => nativeState([]),
    },
  });
  const asked: unknown[] = [];
  h.port.ownDeviceListing = async (request) => {
    asked.push(request);
    return { hash: "h", listing: [{ device: MY_DEV }] };
  };
  await setSeats(h.ops, h.port, CH, [ME], 5);
  assert.deepEqual(asked, [{ want: [MY_DEV] }], "setSeats pin");

  // moveOwnerKey: the target check, then the handover sign's own pin.
  _resetOwnerFlowsForTest();
  let signs = 0;
  const m = moveHarness({
    invoke: {
      e2ee_text_owner_handover_sign: () => {
        if (++signs === 1) {
          throw {
            type: "identity_pin_required",
            user_id: ME,
            device_id: OTHER_DEV,
          };
        }
        return HANDOVER;
      },
    },
  });
  const movedAsked: unknown[] = [];
  m.port.ownDeviceListing = async (request) => {
    movedAsked.push(request);
    return { hash: "h", listing: OWN_LISTING };
  };
  await moveOwnerKey(m.ops, m.port, CH, OTHER_DEV);
  assert.deepEqual(
    movedAsked,
    [{ want: [OTHER_DEV] }, { want: [OTHER_DEV] }],
    "handover target check, then its pin",
  );
});

test("S2 F5 moveOwnerKey: identity_pin_required pins the own devices from the listing and asks ONCE more; a decline publishes nothing", async () => {
  let asked = 0;
  const h = moveHarness({
    invoke: {
      e2ee_text_owner_handover_sign: () => {
        if (++asked === 1) {
          throw {
            type: "identity_pin_required",
            user_id: ME,
            device_id: OTHER_DEV,
          };
        }
        return HANDOVER;
      },
    },
  });
  await moveOwnerKey(h.ops, h.port, CH, OTHER_DEV);
  const pins = cmds(h, "e2ee_text_pin_own_devices");
  assert.equal(pins.length, 1);
  assert.deepEqual(pins[0].args, { userId: ME, devices: OWN_LISTING });
  assert.equal(asked, 2);
  assert.equal(puts(h).length, 1);

  _resetOwnerFlowsForTest();
  const h2 = moveHarness({
    invoke: {
      e2ee_text_owner_handover_sign: () => {
        throw { type: "declined" };
      },
    },
  });
  await assert.rejects(moveOwnerKey(h2.ops, h2.port, CH, OTHER_DEV), {
    source: "native",
    error: { type: "declined" },
  });
  assert.equal(signArgs(h2).length, 0);
  assert.equal(puts(h2).length, 0);
  assert.equal(h2.store.size, 0);
});

test("S2 F5 ownerKeyMoveTargets: this user's other devices, in order, once each, only while this device signed the served list and no authority is served", () => {
  const own = [MY_DEV, OTHER_DEV, "", OTHER_DEV, THIRD_DEV];
  const mine = seatsBody(listOf(heldV1)) as ProtectedSeatsResponse;
  assert.deepEqual(ownerKeyMoveTargets(mine, MY_DEV, own), [
    OTHER_DEV,
    THIRD_DEV,
  ]);
  const byK1 = seatsBody(
    listOf({ ...heldV1, signer_device_id: OTHER_DEV }),
  ) as ProtectedSeatsResponse;
  const cases: [string, ProtectedSeatsResponse | null, string | null][] = [
    ["no snapshot", null, MY_DEV],
    ["not protected", seatsBody(null) as ProtectedSeatsResponse, MY_DEV],
    ["this device unknown", mine, null],
    ["signed by another device", byK1, MY_DEV],
    ["authority served", seatsWith(AUTH, undefined), MY_DEV],
  ];
  for (const [label, seats, self] of cases) {
    assert.deepEqual(ownerKeyMoveTargets(seats, self, own), [], label);
  }
  assert.deepEqual(ownerKeyMoveTargets(mine, MY_DEV, [MY_DEV]), []);
});

// ---------------------------------------------------------------------------
// FX-R (audit MEDIUM-1): the recovery list is a stored publish (4.9, D7c);
// the reason header rides on plain seat publishes only (NIT)
// ---------------------------------------------------------------------------

const LOST_DEV = "dd".repeat(16);
/** The served list, signed by the lost signing device of this user. */
const lostV2 = genesis({
  version: 2,
  body: "sloga-seat-list-v1\nv:1\nversion:2\nby-lost",
  signature: "S2LOST",
  signer_device_id: LOST_DEV,
});
/** The recovery list this device signs over it. */
const recV3 = genesis({
  version: 3,
  body: "sloga-seat-list-v1\nv:1\nversion:3\nrecovery",
  signature: "S3REC",
});

/**
 * The manager's side of a recovery as a stub: `sign` answers `answer()`
 * over server version `serverVersion`; `ensureLeaf` records the D7c entry
 * it finds (the bytes must be stored before anything is created).
 */
function recoveryPlan(
  h: Harness,
  over: {
    answer?: () => unknown;
    serverVersion?: number;
    retryBudget?: number;
  } = {},
) {
  const seen = { signs: 0, leafs: 0, storedAtLeaf: [] as (string | null)[] };
  const plan: RecoveryPlan = {
    retryBudget: over.retryBudget ?? 8,
    async sign() {
      seen.signs++;
      h.trace.push("sign");
      return {
        signed: (over.answer ?? (() => recV3))(),
        serverVersion: over.serverVersion ?? 2,
      };
    },
    async ensureLeaf() {
      seen.leafs++;
      h.trace.push("ensureLeaf");
      seen.storedAtLeaf.push(h.store.get(publishStoreKey(ME, CH)) ?? null);
    },
  };
  return { plan, seen };
}

function recoveryHarness(putReplies: Reply[], sleepRejectsAfter?: number) {
  return harness({
    routes: listRoutes(lostV2, recV3, putReplies),
    invoke: seatNative(recV3),
    sleepRejectsAfter,
  });
}

test("FXR recovery: the signed list is stored BEFORE the successor step and the first PUT; a 2xx resolves through read-back and verify", async () => {
  const h = recoveryHarness([res(200)]);
  const { plan, seen } = recoveryPlan(h);
  await recoverOwnership(h.ops, h.port, CH, plan);
  assert.deepEqual(h.trace.slice(0, 3), [
    "sign",
    "ensureLeaf",
    `PUT /channels/${CH}/seats`,
  ]);
  assert.equal(seen.signs, 1);
  const atLeaf = JSON.parse(seen.storedAtLeaf[0] ?? "null");
  assert.ok(atLeaf, "persisted before the successor step");
  assert.equal(atLeaf.recovery, true);
  assert.equal(atLeaf.answer, "unsent");
  assert.deepEqual(atLeaf.signed, recV3);
  const atPut = JSON.parse(h.storeAtPut[0] ?? "null");
  assert.equal(atPut.recovery, true);
  assert.equal(atPut.answer, "sent", "write-ahead before the PUT (F3)");
  assert.deepEqual(puts(h)[0].body, {
    body: recV3.body,
    signature: recV3.signature,
    signer_device_id: MY_DEV,
  });
  assert.equal(puts(h)[0].headers, undefined, "a recovery never has a reason");
  assert.equal(h.store.size, 0, "resolved");
  assert.equal(cmds(h, "e2ee_text_seat_list_verify").length, 1, "read back");
});

test("FXR recovery: past the re-send budget the call rejects and the entry stays; the next call re-sends the SAME bytes with no second signature", async () => {
  // `sleepRejectsAfter`: a loop that ignored the budget ends as "aborted"
  // (this test fails) instead of spinning.
  const h = recoveryHarness([res(503)], 20);
  const first = recoveryPlan(h, { retryBudget: 2 });
  await assert.rejects(recoverOwnership(h.ops, h.port, CH, first.plan), {
    source: "server",
    status: 503,
  });
  assert.equal(puts(h).length, 3, "the budget bounds one call");
  const key = publishStoreKey(ME, CH);
  const kept = h.store.get(key);
  assert.ok(kept, "the signed bytes stay stored");
  assert.equal(JSON.parse(kept).recovery, true);
  assert.equal(pendingSeats(h.port, CH), null, "not a pending seat change");
  assert.deepEqual(cancelPendingSeats(h.port, CH), {
    discarded: false,
    why: "none",
  });
  assert.equal(h.store.get(key), kept, "F3 never discards it");

  // The next click: in the same session, then after a reload.
  for (const reload of [false, true]) {
    if (reload) _resetOwnerFlowsForTest();
    const h2 = recoveryHarness([res(200)]);
    h2.store.set(key, kept);
    const again = recoveryPlan(h2);
    await recoverOwnership(h2.ops, h2.port, CH, again.plan);
    assert.equal(again.seen.signs, 0, "no fresh signature");
    assert.equal(again.seen.leafs, 1, "the successor step before the PUT");
    assert.equal(puts(h2).length, 1);
    assert.deepEqual(puts(h2)[0].body, puts(h)[0].body, "SAME bytes");
    assert.equal(h2.store.size, 0, "resolved");
  }
});

test("FXR recovery: a stored list resolves by read-back first: already on the server = nothing re-sent; overtaken = dropped as refused", async () => {
  const key = publishStoreKey(ME, CH);
  const stored = JSON.stringify({
    v: 1,
    op: "seats",
    signed: recV3,
    recovery: true,
    answer: "sent",
  });
  const h = harness({
    routes: listRoutes(recV3, recV3, [res(200)]),
    invoke: seatNative(recV3),
  });
  h.store.set(key, stored);
  const landed = recoveryPlan(h);
  await recoverOwnership(h.ops, h.port, CH, landed.plan);
  assert.equal(puts(h).length, 0, "landed: never re-sent");
  assert.equal(landed.seen.signs + landed.seen.leafs, 0);
  assert.equal(cmds(h, "e2ee_text_seat_list_verify").length, 1);
  assert.equal(h.store.size, 0);

  _resetOwnerFlowsForTest();
  const other = genesis({ version: 3, body: "someone-else", signature: "X" });
  const h2 = harness({
    routes: listRoutes(other, other, [res(200)]),
    invoke: seatNative(recV3),
  });
  h2.store.set(key, stored);
  const gone = recoveryPlan(h2);
  await assert.rejects(recoverOwnership(h2.ops, h2.port, CH, gone.plan), {
    reason: "publish_refused",
  });
  assert.equal(puts(h2).length, 0);
  assert.equal(gone.seen.signs + gone.seen.leafs, 0);
  assert.equal(h2.store.size, 0);
});

test("FXR recovery: native's answer must be this device's list at the server version + 1, else nothing is stored, created or sent", async () => {
  const answers: [string, unknown, number][] = [
    ["version + 2", genesis({ version: 4, body: "b4", signature: "s4" }), 2],
    ["same version", genesis({ version: 2, body: "b2", signature: "s2" }), 2],
    ["another device", { ...recV3, signer_device_id: OTHER_DEV }, 2],
    ["another user", { ...recV3, signer_user_id: BOB }, 2],
    ["malformed", { ...recV3, signature: 7 }, 2],
    ["no answer", null, 2],
    ["unknown server version", recV3, Number.NaN],
  ];
  for (const [label, answer, serverVersion] of answers) {
    _resetOwnerFlowsForTest();
    const h = recoveryHarness([res(200)]);
    const { plan, seen } = recoveryPlan(h, {
      answer: () => answer,
      serverVersion,
    });
    await assert.rejects(
      recoverOwnership(h.ops, h.port, CH, plan),
      { reason: "publish_refused" },
      label,
    );
    assert.equal(seen.leafs, 0, label);
    assert.equal(puts(h).length, 0, label);
    assert.equal(h.store.size, 0, label);
  }
});

test("FXR recovery: another owner flow never PUTs a stored recovery list (no successor step there); it only resolves one already on the server", async () => {
  const key = publishStoreKey(ME, CH);
  const stored = JSON.stringify({
    v: 1,
    op: "seats",
    signed: recV3,
    recovery: true,
    answer: "unsent",
  });
  const h = recoveryHarness([res(200)]);
  h.store.set(key, stored);
  await assert.rejects(setSeats(h.ops, h.port, CH, [ME, BOB], 5), {
    reason: "publish_in_flight",
  });
  assert.equal(puts(h).length, 0);
  assert.equal(h.store.get(key), stored, "kept for recoverOwnership");
  assert.equal(signArgs(h).length, 0);

  _resetOwnerFlowsForTest();
  const v4 = genesis({ version: 4, body: "body-v4", signature: "S4" });
  const h2 = harness({
    routes: listRoutes(recV3, v4, [res(200)]),
    invoke: { ...seatNative(recV3), e2ee_text_seat_list_sign: () => v4 },
  });
  h2.store.set(key, stored);
  await setSeats(h2.ops, h2.port, CH, [ME, BOB], 5);
  assert.equal(puts(h2).length, 1, "only its own list");
  assert.equal((puts(h2)[0].body as { body: string }).body, "body-v4");
  assert.equal(h2.store.size, 0);
});

test("FXR NIT: a resumed publish carries the caller's reason only when it is a plain seat publish, never an owner-devices or handover one", async () => {
  const key = publishStoreKey(ME, CH);
  const v4 = genesis({
    version: 4,
    body: "sloga-seat-list-v1\nv:1\nversion:4",
    signature: "S4V1",
  });
  const REASON = { "X-Audit-Log-Reason": "spam" };
  const cases: [string, SignedSeatList, SignedSeatList, object, boolean][] = [
    ["owner devices", heldV2, nextV2NewAuth, { ownerDevices: true }, false],
    ["handover", heldV1, nextV1, { handover: HANDOVER }, false],
    ["plain", heldV1, nextV1, {}, true],
  ];
  for (const [label, start, next, extra, carries] of cases) {
    _resetOwnerFlowsForTest();
    const h = harness({
      routes: listRoutes(start, next, [res(200)]),
      invoke: { ...seatNative(next), e2ee_text_seat_list_sign: () => v4 },
    });
    const entry = { v: 1, op: "seats", signed: next, answer: "sent" };
    h.store.set(key, JSON.stringify({ ...entry, ...extra }));
    await setSeats(h.ops, h.port, CH, [ME, BOB], 5, "spam");
    const p = puts(h);
    assert.equal(p.length, 2, label);
    assert.equal((p[0].body as { body: string }).body, next.body, label);
    assert.deepEqual(p[0].headers, carries ? REASON : undefined, label);
    assert.deepEqual(p[1].headers, REASON, `${label}: its own list`);
  }
});

// ---------------------------------------------------------------------------
// S2-W4 fix lane FX-J2 (re-review NEW-4): a stored recovery entry no PUT
// of which went out can be discarded (F3), so it never blocks this device's
// owner flows for good. Tests named "FXJ2 ..." are the targets of
// /home/mcp/pc-logs/s2/w4/ctl/FXJ2.
// ---------------------------------------------------------------------------

test("FXJ2 NEW-4: a recovery entry still unsent is offered for discard and discarded, signing and sending nothing, and the owner flows run again; one whose PUTs were all 429 or that may be on the server stays hidden and kept, and resumes the same bytes", async () => {
  const key = publishStoreKey(ME, CH);
  const entry = (answer: string) =>
    JSON.stringify({
      v: 1,
      op: "seats",
      signed: recV3,
      recovery: true,
      answer,
    });
  const v3 = genesis({ version: 3, body: "body-v3", signature: "S3" });

  // (a) Signed and stored, no PUT went out (the successor step failed).
  _resetOwnerFlowsForTest();
  const h = harness({
    routes: listRoutes(lostV2, v3, [res(200)]),
    invoke: seatNative(v3),
  });
  h.store.set(key, entry("unsent"));
  await assert.rejects(setSeats(h.ops, h.port, CH, [ME, BOB], 5), {
    reason: "publish_in_flight",
  });
  assert.deepEqual(pendingSeats(h.port, CH), {
    kind: "seats",
    reasonRequired: false,
    discardable: true,
  });
  assert.deepEqual(cancelPendingSeats(h.port, CH), { discarded: true });
  assert.equal(h.store.size, 0);
  assert.equal(signArgs(h).length, 0, "the discard signs nothing");
  assert.equal(puts(h).length, 0, "and sends nothing");
  assert.equal(pendingSeats(h.port, CH), null);
  await setSeats(h.ops, h.port, CH, [ME, BOB], 5);
  assert.equal(puts(h).length, 1, "the owner flows run again");
  assert.equal((puts(h)[0].body as { body: string }).body, "body-v3");

  // (b) Every PUT of it a 429 (planner ruling): maybe-accepted like a
  // 429-only plain publish. Hidden, kept, never discarded; the next
  // recovery re-sends the SAME bytes (no fresh signature for the version).
  // `sleepRejectsAfter` (here and in c): a loop that ignored the budget
  // ends as "aborted" (this test fails) instead of spinning.
  _resetOwnerFlowsForTest();
  const h2 = recoveryHarness([res(429)], 20);
  const first = recoveryPlan(h2, { retryBudget: 1 });
  await assert.rejects(recoverOwnership(h2.ops, h2.port, CH, first.plan));
  assert.equal(puts(h2).length, 2);
  const limited = h2.store.get(key);
  assert.equal(JSON.parse(limited ?? "null")?.answer, "refused");
  assert.equal(pendingSeats(h2.port, CH), null);
  assert.deepEqual(cancelPendingSeats(h2.port, CH), {
    discarded: false,
    why: "none",
  });
  assert.equal(h2.store.get(key), limited, "kept");
  _resetOwnerFlowsForTest();
  const h2b = recoveryHarness([res(200)]);
  h2b.store.set(key, limited ?? "");
  const again = recoveryPlan(h2b);
  await recoverOwnership(h2b.ops, h2b.port, CH, again.plan);
  assert.equal(again.seen.signs, 0, "no fresh signature");
  assert.deepEqual(puts(h2b)[0].body, puts(h2)[0].body, "SAME bytes");
  assert.equal(h2b.store.size, 0);

  // (c) A PUT that may have landed (503): hidden, kept for
  // `recoverOwnership`, never discarded.
  _resetOwnerFlowsForTest();
  const h3 = recoveryHarness([res(503)], 20);
  const third = recoveryPlan(h3, { retryBudget: 1 });
  await assert.rejects(recoverOwnership(h3.ops, h3.port, CH, third.plan));
  const kept = h3.store.get(key);
  assert.equal(JSON.parse(kept ?? "null")?.answer, "sent");
  assert.equal(pendingSeats(h3.port, CH), null);
  assert.deepEqual(cancelPendingSeats(h3.port, CH), {
    discarded: false,
    why: "none",
  });
  assert.equal(h3.store.get(key), kept);
  for (const answer of ["sent", "unknown"]) {
    h3.store.set(key, entry(answer));
    assert.equal(pendingSeats(h3.port, CH), null, answer);
    assert.equal(cancelPendingSeats(h3.port, CH).discarded, false, answer);
  }
});

// ---------------------------------------------------------------------------
// S2 live-leg fix lane FXO (FXL audit M1, second half): a recovery list the
// server refused for its reason header (`RemovalReasonRequired`, decided
// before any write) can never land, as no reason rides on a recovery; it no
// longer blocks the owner for good. Tests named "FXO ..." are the targets
// of /home/mcp/pc-logs/s2/w4/ctl/FXO.
// ---------------------------------------------------------------------------

/** A second recovery list over the same served version (a new decision). */
const recV3b = genesis({
  version: 3,
  body: "sloga-seat-list-v1\nv:1\nversion:3\nrecovery-again",
  signature: "S3REC2",
});

const putBodies = (h: Harness) =>
  puts(h).map((c) => (c.body as { body: string }).body);

test("FXO M1: a recovery refused for its reason header is offered for discard with no reason prompt; the discard signs and sends nothing, and the next Recover signs afresh and lands", async () => {
  const h = harness({
    routes: listRoutes(lostV2, recV3b, [res(400, REASON_REQUIRED), res(200)]),
    invoke: seatNative(recV3b),
  });
  const first = recoveryPlan(h, { answer: () => recV3 });
  await assert.rejects(recoverOwnership(h.ops, h.port, CH, first.plan), {
    source: "server",
    status: 400,
    type: "RemovalReasonRequired",
  });
  const refused = storedEntry(h);
  assert.equal(refused?.recovery, true);
  assert.equal(refused?.reasonRequired, true);
  assert.equal(refused?.answer, "refused", "its one PUT wrote nothing");
  assert.deepEqual(pendingSeats(h.port, CH), {
    kind: "seats",
    reasonRequired: false,
    discardable: true,
  });
  const before = traffic(h);
  assert.deepEqual(cancelPendingSeats(h.port, CH), { discarded: true });
  assert.equal(traffic(h), before, "the discard signs and sends nothing");
  assert.equal(h.store.size, 0);
  assert.equal(pendingSeats(h.port, CH), null);

  const again = recoveryPlan(h, { answer: () => recV3b });
  await recoverOwnership(h.ops, h.port, CH, again.plan);
  assert.equal(again.seen.signs, 1, "a new decision: the dialog again");
  assert.deepEqual(putBodies(h), [recV3.body, recV3b.body]);
  assert.equal(puts(h)[1].headers, undefined, "a recovery never has a reason");
  assert.equal(h.store.size, 0, "resolved");
});

test("FXO M1: the next Recover never re-sends a recovery list refused for its reason: it drops it, signs afresh behind the dialog and lands, in the same session and after a reload", async () => {
  const key = publishStoreKey(ME, CH);
  for (const [label, replies] of [
    ["reason", [res(400, REASON_REQUIRED)]],
    ["429 then reason", [res(429), res(400, REASON_REQUIRED)]],
  ] as [string, Reply[]][]) {
    _resetOwnerFlowsForTest();
    const h = recoveryHarness(replies, 20);
    await assert.rejects(
      recoverOwnership(h.ops, h.port, CH, recoveryPlan(h).plan),
      { type: "RemovalReasonRequired" },
      label,
    );
    const refused = h.store.get(key);
    assert.equal(JSON.parse(refused ?? "null")?.answer, "refused", label);
    for (const reload of [false, true]) {
      if (reload) _resetOwnerFlowsForTest();
      const h2 = harness({
        routes: listRoutes(lostV2, recV3b, [res(200)]),
        invoke: seatNative(recV3b),
      });
      h2.store.set(key, refused ?? "");
      const again = recoveryPlan(h2, { answer: () => recV3b });
      await recoverOwnership(h2.ops, h2.port, CH, again.plan);
      const at = `${label}, reload ${reload}`;
      assert.equal(again.seen.signs, 1, `${at}: signed afresh`);
      assert.deepEqual(putBodies(h2), [recV3b.body], `${at}: never re-sent`);
      assert.equal(h2.store.size, 0, `${at}: resolved`);
    }
  }
});

test("FXO M1 safety: a recovery list that may be on the server (a PUT without an answer before the reason refusal) or whose PUTs were all 429 is never discarded or dropped, and an unsent one is never dropped: the next Recover re-sends the SAME bytes", async () => {
  const key = publishStoreKey(ME, CH);
  const h = recoveryHarness(["transport", res(400, REASON_REQUIRED)]);
  await assert.rejects(
    recoverOwnership(h.ops, h.port, CH, recoveryPlan(h).plan),
    { type: "RemovalReasonRequired" },
  );
  assert.equal(puts(h).length, 2);
  const maybe = storedEntry(h);
  assert.equal(maybe?.answer, "sent", "one maybe-accepted attempt (F3)");
  assert.equal(maybe?.reasonRequired, true);
  const entry = { v: 1, op: "seats", signed: recV3, recovery: true };
  const cases: [string, string][] = [
    ["sent, then the reason refusal", JSON.stringify(maybe)],
    ["every PUT 429", JSON.stringify({ ...entry, answer: "refused" })],
    [
      "reason, no answer recorded",
      JSON.stringify({ ...entry, reasonRequired: true }),
    ],
    [
      "reason, unknown answer",
      JSON.stringify({ ...entry, reasonRequired: true, answer: "x" }),
    ],
  ];
  for (const [label, raw] of cases) {
    _resetOwnerFlowsForTest();
    const h2 = recoveryHarness([res(200)]);
    h2.store.set(key, raw);
    assert.equal(pendingSeats(h2.port, CH), null, label);
    assert.deepEqual(
      cancelPendingSeats(h2.port, CH),
      { discarded: false, why: "none" },
      label,
    );
    assert.equal(h2.store.get(key), raw, `${label}: kept`);
    const again = recoveryPlan(h2, { answer: () => recV3b });
    await recoverOwnership(h2.ops, h2.port, CH, again.plan);
    assert.equal(again.seen.signs, 0, `${label}: no fresh signature`);
    assert.deepEqual(putBodies(h2), [recV3.body], `${label}: SAME bytes`);
    assert.equal(h2.store.size, 0, `${label}: resolved`);
  }

  // Unsent (no PUT went out): F3 may discard it, but Recover sends the
  // bytes already signed (4.9) and never drops them.
  _resetOwnerFlowsForTest();
  const h3 = recoveryHarness([res(200)]);
  h3.store.set(key, JSON.stringify({ ...entry, answer: "unsent" }));
  const resumed = recoveryPlan(h3, { answer: () => recV3b });
  await recoverOwnership(h3.ops, h3.port, CH, resumed.plan);
  assert.equal(resumed.seen.signs, 0, "unsent: no fresh signature");
  assert.deepEqual(putBodies(h3), [recV3.body], "unsent: SAME bytes");
  assert.equal(h3.store.size, 0, "unsent: resolved");
});

// ---------------------------------------------------------------------------
// S4 (W4 L2o): protect with history, the history setting, the wipe
// (design 4.9 "S4"; R-W4-9 / 10 / 11). Fake ports only; the server answers
// are the shapes of backend 2efca34c.
// ---------------------------------------------------------------------------

const MSG1 = "01JA0000000000000000000001";
const MSG2 = "01JA0000000000000000000002";
const MSG3 = "01JA0000000000000000000003";
const MSG4 = "01JA0000000000000000000004";
const MSG5 = "01JA0000000000000000000005";
const MSG6 = "01JA0000000000000000000006";
const MSG_PATH = `GET /channels/${CH}/messages?limit=1&sort=Latest`;
const PROTECT_PUT = `PUT /channels/${CH}/protect`;
const SEATS_GET = `GET /channels/${CH}/seats`;
const SEATS_PUT = `PUT /channels/${CH}/seats`;
const CHANNEL_GET = `GET /channels/${CH}`;
const WIPE_POST = `POST /channels/${CH}/history_wipe`;
const SIGN = "e2ee_text_seat_list_sign";
const VERIFY = "e2ee_text_seat_list_verify";
const MOVED = res(409, { type: "ProtectHistoryMoved" });

/** A v2 list body with native's line order (formats.rs at b688f121). */
const v2Body = (
  o: {
    version?: number;
    seats?: string[];
    history?: string;
    boundary?: string;
    pre?: string;
  } = {},
) =>
  [
    "sloga-seat-list-v2",
    "v:2",
    `channel_id:${CH}`,
    `version:${o.version ?? 1}`,
    "device_cap:5",
    "issued_at:1700000000000",
    `signer_user_id:${ME}`,
    `signer_device_id:${MY_DEV}`,
    `seats:${(o.seats ?? [ME]).join(",")}`,
    "authority:",
    `history:${o.history ?? "hidden"}`,
    `history_boundary:${o.boundary ?? ""}`,
    `pre_history:${o.pre ?? "kept"}`,
    "group_salt:00",
  ].join("\n");

const lineOf = (body: string, key: string) =>
  body
    .split("\n")
    .find((l) => l.startsWith(`${key}:`))
    ?.slice(key.length + 1);

/** What native would sign for these arguments (a later list keeps the held lines). */
function signedFor(a: Record<string, unknown>): SignedSeatList {
  const held = a.serverList as { version: number; body: string } | null;
  const version = held === null ? 1 : held.version + 1;
  const keep = (key: string) =>
    held === null ? undefined : lineOf(held.body, key);
  const history = (a.history as string | null) ?? keep("history");
  const boundary =
    (a.historyBoundary as string | null) ?? keep("history_boundary");
  const pre = (a.preHistory as string | null) ?? keep("pre_history");
  return genesis({
    version,
    body: v2Body({
      version,
      seats: a.seats as string[],
      history,
      boundary,
      pre,
    }),
    signature: `SIG-${version}-${boundary ?? ""}-${history ?? ""}-${pre ?? ""}`,
  });
}

/** Native fakes: `sign` may answer first (undefined = the default list). */
const historyNative = (
  sign?: (a: Record<string, unknown>, n: number) => unknown,
) => {
  let n = 0;
  return {
    [SIGN]: (a: Record<string, unknown>) => {
      const own = sign?.(a, n++);
      return own === undefined ? signedFor(a) : own;
    },
    [VERIFY]: (a: Record<string, unknown>) => {
      const body = (a.list as { body: string }).body;
      return verdict(
        (lineOf(body, "seats") ?? ME).split(","),
        Number(lineOf(body, "version") ?? 1),
      );
    },
    e2ee_text_state: () => nativeState([{ user_id: ME, device_id: MY_DEV }]),
  };
};

/** `{ land: r }`: the request's list becomes the server's, then `r` is answered. */
type Landing = Reply | { land: Reply };
const LAND: Landing = { land: res(200) };

/**
 * A server that holds one list. The last entry of each queue repeats.
 * `newest`: the answers of the newest-message read (null = no message).
 */
function historyServer(
  o: {
    list?: SignedSeatList | null;
    newest?: (string | null)[];
    protectPuts?: Landing[];
    seatPuts?: Landing[];
    wipePosts?: Landing[];
  } = {},
) {
  const s = { list: o.list ?? null };
  const take = <T>(q: T[]): T => (q.length > 1 ? q.shift()! : q[0]);
  const newest = [...(o.newest ?? [MSG1])];
  const protectPuts = [...(o.protectPuts ?? [LAND])];
  const seatPuts = [...(o.seatPuts ?? [LAND])];
  const wipePosts = [...(o.wipePosts ?? [LAND])];
  const hold = (sent: unknown, version: number) => {
    const l = sent as { body: string; signature: string };
    s.list = genesis({ version, body: l.body, signature: l.signature });
  };
  const answer = (r: Landing, land: () => void): Reply => {
    if (typeof r === "object" && "land" in r) {
      land();
      return r.land;
    }
    return r;
  };
  const routes: Record<string, (c: Call) => Reply> = {
    [MSG_PATH]: () => {
      const id = take(newest);
      return res(200, id === null ? [] : [{ _id: id, channel: CH }]);
    },
    [CHANNEL_GET]: () => res(200, { _id: CH, protected: s.list !== null }),
    [SEATS_GET]: () =>
      res(200, seatsBody(s.list === null ? null : listOf(s.list))),
    [PROTECT_PUT]: (c) =>
      answer(take(protectPuts), () =>
        hold((c.body as { seat_list: unknown }).seat_list, 1),
      ),
    [SEATS_PUT]: (c) =>
      answer(take(seatPuts), () => hold(c.body, (s.list?.version ?? 0) + 1)),
    [WIPE_POST]: (c) =>
      answer(take(wipePosts), () => hold(c.body, (s.list?.version ?? 0) + 1)),
  };
  return { routes, state: s };
}

const historyHarness = (
  server: ReturnType<typeof historyServer>,
  over: {
    sign?: (a: Record<string, unknown>, n: number) => unknown;
    sleepRejectsAfter?: number;
    historySetting?: boolean;
    formatsV2?: boolean;
  } = {},
) =>
  harness({
    routes: server.routes,
    invoke: historyNative(over.sign),
    sleepRejectsAfter: over.sleepRejectsAfter,
    formatsV2: over.formatsV2 ?? true,
    historySetting: over.historySetting ?? true,
  });

/** The server's list now, read where an earlier assert narrowed it. */
const historyServerList = (
  server: ReturnType<typeof historyServer>,
): SignedSeatList | null => server.state.list;

const KEPT = { withHistory: true, wipe: false };
const WIPED = { withHistory: true, wipe: true };
const posts = (h: Harness) => h.calls.filter((c) => c.method === "POST");
const count = (h: Harness, entry: string) =>
  h.trace.filter((t) => t === entry).length;
const wireOf = (s: SignedSeatList) => ({
  body: s.body,
  signature: s.signature,
  signer_device_id: s.signer_device_id,
});
/** The genesis `signedFor` answers for a boundary. */
const boundaryGenesis = (boundary: string, pre = "kept") =>
  signedFor({
    serverList: null,
    seats: [ME],
    history: null,
    historyBoundary: boundary,
    preHistory: pre,
  });
const storedNow = (h: Harness) => {
  const raw = h.store.get(publishStoreKey(ME, CH));
  return raw === undefined ? null : JSON.parse(raw);
};
const createdGroups = (h: Harness) =>
  h.opsLog.filter((o) => o[0] === "createGroup").length;
const verifiedBody = (h: Harness, i = 0) =>
  (cmds(h, VERIFY)[i].args.list as { body: string }).body;

test("S4 protect: without opts or with withHistory false the S2 requests, sign arguments and stored entry are unchanged", async () => {
  for (const opts of [undefined, { withHistory: false, wipe: false }]) {
    _resetOwnerFlowsForTest();
    const g = genesis();
    const h = harness({
      routes: protectRoutes(g, [res(200)]),
      invoke: { [SIGN]: () => g, [VERIFY]: () => verdict([ME, BOB]) },
      formatsV2: true,
      historySetting: true,
    });
    if (opts === undefined) await protect(h.ops, h.port, CH, [BOB], 5);
    else await protect(h.ops, h.port, CH, [BOB], 5, opts);
    assert.deepEqual(h.trace, [
      SEATS_GET,
      SIGN,
      PROTECT_PUT,
      CHANNEL_GET,
      SEATS_GET,
      VERIFY,
    ]);
    const [a] = signArgs(h);
    assert.deepEqual(a, {
      channelId: CH,
      userId: ME,
      seats: [ME, BOB],
      deviceCap: 5,
      serverList: null,
      format: 2,
      authority: null,
      recovery: false,
      history: null,
      historyBoundary: null,
      preHistory: null,
      wipeCount: null,
      channelName: "secret",
      displayNames: [
        { user_id: ME, name: ME },
        { user_id: BOB, name: BOB },
      ],
    });
    assert.deepEqual(Object.keys(a), [
      "channelId",
      "userId",
      "seats",
      "deviceCap",
      "serverList",
      "format",
      "authority",
      "recovery",
      "history",
      "historyBoundary",
      "preHistory",
      "wipeCount",
      "channelName",
      "displayNames",
    ]);
    assert.deepEqual(puts(h)[0].body, { seat_list: wireOf(g) });
    assert.deepEqual(JSON.parse(h.storeAtPut[0]!), {
      v: 1,
      op: "protect",
      signed: g,
    });
  }
});

test("S4 sign sites: setSeats, signOwnerDevices and moveOwnerKey always send the four history arguments as null", async () => {
  const none = {
    history: null,
    historyBoundary: null,
    preHistory: null,
    wipeCount: null,
  };
  const pick = (a: Record<string, unknown>) => ({
    history: a.history,
    historyBoundary: a.historyBoundary,
    preHistory: a.preHistory,
    wipeCount: a.wipeCount,
  });
  const seats = harness({
    routes: listRoutes(heldV1, nextV2, [res(200)]),
    invoke: seatNative(nextV2),
    historySetting: true,
  });
  await setSeats(seats.ops, seats.port, CH, [ME, BOB], 5);
  assert.deepEqual(pick(signArgs(seats)[0]), none, "setSeats");

  _resetOwnerFlowsForTest();
  const devices = harness({
    routes: listRoutes(heldV2, nextV2NewAuth, [res(200)]),
    invoke: seatNative(nextV2NewAuth),
    historySetting: true,
  });
  await signOwnerDevices(devices.ops, devices.port, CH, [MY_DEV]);
  assert.deepEqual(pick(signArgs(devices)[0]), none, "signOwnerDevices");

  _resetOwnerFlowsForTest();
  const move = moveHarness();
  await moveOwnerKey(move.ops, move.port, CH, OTHER_DEV);
  assert.deepEqual(pick(signArgs(move)[0]), none, "moveOwnerKey");
});

test("S4 protect with history: an owner-only v2 genesis over the newest message, stored before the PUT, lands first try, then the members through setSeats", async () => {
  const server = historyServer();
  const h = historyHarness(server);
  await protect(h.ops, h.port, CH, [BOB], 5, KEPT);

  const g = boundaryGenesis(MSG1);
  assert.deepEqual(h.trace.slice(0, 7), [
    SEATS_GET,
    MSG_PATH,
    SIGN,
    PROTECT_PUT,
    CHANNEL_GET,
    SEATS_GET,
    VERIFY,
  ]);
  const [first, second] = signArgs(h);
  assert.deepEqual(first, {
    channelId: CH,
    userId: ME,
    seats: [ME],
    deviceCap: 5,
    serverList: null,
    format: 2,
    authority: null,
    recovery: false,
    history: null,
    historyBoundary: MSG1,
    preHistory: "kept",
    wipeCount: null,
    channelName: "secret",
    displayNames: [{ user_id: ME, name: ME }],
  });
  assert.deepEqual(JSON.parse(h.storeAtPut[0]!), {
    v: 2,
    op: "protect",
    geneses: [g],
    wipe: false,
  });
  assert.deepEqual(puts(h)[0].body, { seat_list: wireOf(g) });
  const [verify] = cmds(h, VERIFY);
  assert.deepEqual(verify.args.list, {
    body: g.body,
    signature: g.signature,
    signer_user_id: ME,
    signer_device_id: MY_DEV,
  });
  assert.deepEqual(
    h.opsLog.filter((o) => o[0] === "createGroup"),
    [["createGroup", CH, null]],
  );

  // The picked member: the ordinary seat flow over the landed genesis.
  assert.deepEqual(h.trace.slice(7), [
    SEATS_GET,
    VERIFY,
    SIGN,
    SEATS_PUT,
    SEATS_GET,
    VERIFY,
    "e2ee_text_state",
  ]);
  assert.deepEqual(second.seats, [ME, BOB]);
  assert.deepEqual(second.serverList, { version: 1, body: g.body });
  assert.deepEqual(
    [second.history, second.historyBoundary, second.preHistory],
    [null, null, null],
    "the member list says nothing about history",
  );
  assert.equal(server.state.list?.version, 2);
  assert.equal(h.store.size, 0);
});

test("S4 protect with history: no picked member means no second list", async () => {
  const h = historyHarness(historyServer());
  await protect(h.ops, h.port, CH, [ME], 5, KEPT);
  assert.equal(count(h, SIGN), 1);
  assert.equal(count(h, SEATS_PUT), 0);
});

test("S4 protect with history: ProtectHistoryMoved twice, then it lands: three stored geneses with rising boundaries, the landed one verified", async () => {
  const server = historyServer({
    newest: [MSG1, MSG2, MSG3],
    protectPuts: [MOVED, MOVED, LAND],
  });
  const h = historyHarness(server);
  await protect(h.ops, h.port, CH, [], 5, KEPT);

  assert.deepEqual(h.trace, [
    SEATS_GET,
    MSG_PATH,
    SIGN,
    PROTECT_PUT,
    MSG_PATH,
    SIGN,
    PROTECT_PUT,
    MSG_PATH,
    SIGN,
    PROTECT_PUT,
    CHANNEL_GET,
    SEATS_GET,
    VERIFY,
  ]);
  const all = [MSG1, MSG2, MSG3].map((b) => boundaryGenesis(b));
  assert.deepEqual(
    signArgs(h).map((a) => a.historyBoundary),
    [MSG1, MSG2, MSG3],
  );
  h.storeAtPut.forEach((raw, i) => {
    assert.deepEqual(
      JSON.parse(raw!),
      { v: 2, op: "protect", geneses: all.slice(0, i + 1), wipe: false },
      `the entry at PUT ${i + 1} holds every genesis signed so far`,
    );
  });
  assert.deepEqual(
    puts(h).map((p) => p.body),
    all.map((g) => ({ seat_list: wireOf(g) })),
  );
  assert.equal(verifiedBody(h), all[2].body);
  assert.equal(h.sleeps.length, 0, "a moved boundary is not a backoff");
  assert.equal(h.store.size, 0);
});

test("S4 protect with history: five ProtectHistoryMoved in a row is protect_busy after a read-back, with five geneses and no sixth", async () => {
  const server = historyServer({
    newest: [MSG1, MSG2, MSG3, MSG4, MSG5, MSG6],
    protectPuts: [MOVED],
  });
  const h = historyHarness(server);
  await assert.rejects(protect(h.ops, h.port, CH, [BOB], 5, KEPT), {
    source: "client",
    reason: "protect_busy",
  });
  assert.equal(count(h, SIGN), 5);
  assert.equal(count(h, PROTECT_PUT), 5);
  assert.equal(count(h, MSG_PATH), 5, "no sixth boundary is read");
  assert.deepEqual(
    h.trace.slice(-3),
    [PROTECT_PUT, CHANNEL_GET, SEATS_GET],
    "read back before the entry is dropped",
  );
  assert.equal(JSON.parse(h.storeAtPut[4]!).geneses.length, 5);
  assert.equal(count(h, VERIFY), 0);
  assert.equal(count(h, SEATS_PUT), 0, "no member list without a genesis");
  assert.equal(h.store.size, 0);
});

test("S4 protect with history: a boundary that did not move up stops at once, and an earlier genesis found on the server is finished instead", async () => {
  const stuck = historyHarness(
    historyServer({ newest: [MSG1, MSG1], protectPuts: [MOVED] }),
  );
  await assert.rejects(protect(stuck.ops, stuck.port, CH, [], 5, KEPT), {
    source: "client",
    reason: "protect_busy",
  });
  assert.equal(count(stuck, SIGN), 1, "the same boundary is never re-signed");
  assert.equal(stuck.store.size, 0);

  // The first genesis landed although the server answered "moved".
  _resetOwnerFlowsForTest();
  const server = historyServer({
    newest: [MSG1, MSG1],
    protectPuts: [{ land: MOVED }],
  });
  const h = historyHarness(server);
  await protect(h.ops, h.port, CH, [], 5, KEPT);
  assert.equal(verifiedBody(h), boundaryGenesis(MSG1).body);
  assert.equal(createdGroups(h), 1);
  assert.equal(h.store.size, 0);
});

test("S4 protect with history: a lost answer reads back; the second genesis is there, so it has landed and nothing is signed or sent again", async () => {
  const server = historyServer({
    newest: [MSG1, MSG2],
    protectPuts: [MOVED, { land: "transport" }],
  });
  const h = historyHarness(server);
  await protect(h.ops, h.port, CH, [], 5, KEPT);
  assert.deepEqual(h.trace, [
    SEATS_GET,
    MSG_PATH,
    SIGN,
    PROTECT_PUT,
    MSG_PATH,
    SIGN,
    PROTECT_PUT,
    CHANNEL_GET,
    SEATS_GET,
    VERIFY,
  ]);
  assert.equal(verifiedBody(h), boundaryGenesis(MSG2).body);
  assert.deepEqual(h.sleeps, [250]);
  assert.equal(h.store.size, 0);
});

test("S4 protect with history: a lost answer or a 5xx that did not land re-sends the SAME bytes, a 429 without a read-back", async () => {
  const server = historyServer({
    protectPuts: ["transport", res(503), res(429, null, 700), LAND],
  });
  const h = historyHarness(server);
  await protect(h.ops, h.port, CH, [], 5, KEPT);
  const p = puts(h);
  assert.equal(p.length, 4);
  assert.ok(
    p.every((c) => JSON.stringify(c.body) === JSON.stringify(p[0].body)),
  );
  assert.equal(count(h, SIGN), 1, "never re-signed");
  assert.equal(count(h, MSG_PATH), 1, "the boundary is not read again");
  assert.deepEqual(h.trace.slice(3, 12), [
    PROTECT_PUT,
    CHANNEL_GET,
    SEATS_GET,
    PROTECT_PUT,
    CHANNEL_GET,
    SEATS_GET,
    PROTECT_PUT,
    PROTECT_PUT,
    CHANNEL_GET,
  ]);
  assert.deepEqual(h.sleeps, [250, 500, 700]);
});

test("S4 protect with history: a declined dialog writes no entry and sends no request that changes anything", async () => {
  const h = historyHarness(historyServer(), {
    sign: () => {
      throw { type: "declined" };
    },
  });
  await assert.rejects(protect(h.ops, h.port, CH, [BOB], 5, WIPED), {
    source: "native",
    error: { type: "declined" },
  });
  assert.deepEqual(h.trace, [SEATS_GET, MSG_PATH, SIGN]);
  assert.equal(h.storeWrites, 0, "nothing was ever stored");
  assert.equal(h.store.size, 0);
});

test("S4 protect with history: a restart mid-protect resumes from the stored entry without signing", async () => {
  const g1 = boundaryGenesis(MSG1);
  const g2 = boundaryGenesis(MSG2);
  const entry = JSON.stringify({
    v: 2,
    op: "protect",
    geneses: [g1, g2],
    wipe: false,
  });

  // The EARLIER genesis is what the server holds: landed, verified.
  const landed = historyHarness(historyServer({ list: g1 }));
  landed.store.set(publishStoreKey(ME, CH), entry);
  await protect(landed.ops, landed.port, CH, [], 5);
  assert.deepEqual(landed.trace, [CHANNEL_GET, SEATS_GET, VERIFY]);
  assert.equal(verifiedBody(landed), g1.body);
  assert.equal(createdGroups(landed), 1);
  assert.equal(landed.store.size, 0);

  // Nothing landed: the newest genesis is re-sent with the SAME bytes.
  _resetOwnerFlowsForTest();
  const resent = historyHarness(historyServer());
  resent.store.set(publishStoreKey(ME, CH), entry);
  await protect(resent.ops, resent.port, CH, [], 5);
  assert.deepEqual(resent.trace, [
    CHANNEL_GET,
    SEATS_GET,
    PROTECT_PUT,
    CHANNEL_GET,
    SEATS_GET,
    VERIFY,
  ]);
  assert.deepEqual(puts(resent)[0].body, { seat_list: wireOf(g2) });
  assert.equal(count(resent, SIGN), 0);
  assert.equal(resent.store.size, 0);

  // A list that is none of the stored geneses: refused, the entry dropped.
  _resetOwnerFlowsForTest();
  const foreign = historyHarness(
    historyServer({ list: boundaryGenesis(MSG3) }),
  );
  foreign.store.set(publishStoreKey(ME, CH), entry);
  await assert.rejects(protect(foreign.ops, foreign.port, CH, [], 5), {
    source: "client",
    reason: "protect_failed",
  });
  assert.equal(count(foreign, VERIFY), 0);
  assert.equal(foreign.store.size, 0);
});

test("S4 protect with history: a resumed owner-only genesis still gets the picked members", async () => {
  const g1 = boundaryGenesis(MSG1);
  const h = historyHarness(historyServer({ list: g1 }));
  h.store.set(
    publishStoreKey(ME, CH),
    JSON.stringify({ v: 2, op: "protect", geneses: [g1], wipe: false }),
  );
  await protect(h.ops, h.port, CH, [BOB], 5);
  assert.equal(count(h, SIGN), 1, "only the member list is signed");
  assert.deepEqual(signArgs(h)[0].seats, [ME, BOB]);
  assert.equal(count(h, SEATS_PUT), 1);
});

test("S4 wipe: wipe_history rides only on a genesis signed wiped for a caller that asked for the wipe", async () => {
  const kept = historyHarness(historyServer());
  await protect(kept.ops, kept.port, CH, [], 5, KEPT);
  assert.equal(signArgs(kept)[0].preHistory, "kept");
  assert.deepEqual(Object.keys(puts(kept)[0].body as object), ["seat_list"]);

  _resetOwnerFlowsForTest();
  const wiped = historyHarness(
    historyServer({ newest: [MSG1, MSG2], protectPuts: [MOVED, LAND] }),
  );
  await protect(wiped.ops, wiped.port, CH, [], 5, WIPED);
  assert.deepEqual(
    signArgs(wiped).map((a) => [a.preHistory, a.wipeCount]),
    [
      ["wiped", null],
      ["wiped", null],
    ],
  );
  assert.deepEqual(
    puts(wiped).map((p) => p.body),
    [MSG1, MSG2].map((b) => ({
      seat_list: wireOf(boundaryGenesis(b, "wiped")),
      wipe_history: true,
    })),
  );
  assert.equal(JSON.parse(wiped.storeAtPut[0]!).wipe, true);

  // Native answers a list that is not the one asked for: never published.
  for (const [opts, answered] of [
    [WIPED, "kept"],
    [KEPT, "wiped"],
  ] as const) {
    _resetOwnerFlowsForTest();
    const h = historyHarness(historyServer(), {
      sign: () => boundaryGenesis(MSG1, answered),
    });
    await assert.rejects(protect(h.ops, h.port, CH, [], 5, opts), {
      source: "client",
      reason: "protect_failed",
    });
    assert.equal(count(h, PROTECT_PUT), 0, `${answered} answered`);
    assert.equal(h.storeWrites, 0);
  }
});

test("S4 wipe: a stored protect signed with a wipe is never re-sent by a later call, and an S2 entry is replayed without wipe_history", async () => {
  const w1 = boundaryGenesis(MSG1, "wiped");
  const entry = JSON.stringify({
    v: 2,
    op: "protect",
    geneses: [w1],
    wipe: true,
  });
  // Another flow: the entry is read back, dropped, and nothing is sent.
  const other = historyHarness(historyServer());
  other.store.set(publishStoreKey(ME, CH), entry);
  await assert.rejects(setSeats(other.ops, other.port, CH, [ME], 5), {
    source: "client",
    reason: "not_protected",
  });
  assert.equal(count(other, PROTECT_PUT), 0);
  assert.equal(other.store.size, 0);

  // The same protect again: a fresh genesis behind a fresh dialog.
  _resetOwnerFlowsForTest();
  const again = historyHarness(historyServer({ newest: [MSG2] }));
  again.store.set(publishStoreKey(ME, CH), entry);
  await protect(again.ops, again.port, CH, [], 5, WIPED);
  assert.equal(count(again, SIGN), 1);
  assert.deepEqual(
    puts(again).map((p) => p.body),
    [
      {
        seat_list: wireOf(boundaryGenesis(MSG2, "wiped")),
        wipe_history: true,
      },
    ],
    "the stored bytes never went out",
  );

  // It landed before the restart: finished like any landed genesis.
  _resetOwnerFlowsForTest();
  const landed = historyHarness(historyServer({ list: w1 }));
  landed.store.set(publishStoreKey(ME, CH), entry);
  await protect(landed.ops, landed.port, CH, [], 5);
  assert.deepEqual(landed.trace, [CHANNEL_GET, SEATS_GET, VERIFY]);

  // A journal that says "no wipe" over bytes signed wiped is not trusted.
  _resetOwnerFlowsForTest();
  const lying = historyHarness(historyServer());
  lying.store.set(
    publishStoreKey(ME, CH),
    JSON.stringify({ v: 2, op: "protect", geneses: [w1], wipe: false }),
  );
  await assert.rejects(setSeats(lying.ops, lying.port, CH, [ME], 5), {
    reason: "not_protected",
  });
  assert.equal(count(lying, PROTECT_PUT), 0);

  // The S2 entry: the same bytes, the S2 body, whatever this call asks.
  // The wipe this call asked for was not done, and the caller is told
  // (audit B7).
  _resetOwnerFlowsForTest();
  const g = genesis();
  const v1 = harness({
    routes: protectRoutes(g, [res(200)]),
    invoke: { [VERIFY]: () => verdict([ME]) },
    formatsV2: true,
    historySetting: true,
  });
  v1.store.set(
    publishStoreKey(ME, CH),
    JSON.stringify({ v: 1, op: "protect", signed: g }),
  );
  await assert.rejects(protect(v1.ops, v1.port, CH, [], 5, WIPED), {
    source: "client",
    reason: "wipe_not_done",
  });
  assert.deepEqual(puts(v1)[0].body, { seat_list: wireOf(g) });
  assert.equal(count(v1, SIGN), 0);
});

test("S4 protect with history: a channel without messages is protected the S2 way, with no boundary and no wipe", async () => {
  const server = historyServer({ newest: [null] });
  const h = historyHarness(server);
  await protect(h.ops, h.port, CH, [BOB], 5, WIPED);
  assert.deepEqual(h.trace, [
    SEATS_GET,
    MSG_PATH,
    SIGN,
    PROTECT_PUT,
    CHANNEL_GET,
    SEATS_GET,
    VERIFY,
  ]);
  const [a] = signArgs(h);
  assert.deepEqual(a.seats, [ME, BOB], "every picked member, as in S2");
  assert.deepEqual(
    [a.history, a.historyBoundary, a.preHistory, a.wipeCount],
    [null, null, null, null],
  );
  assert.deepEqual(Object.keys(puts(h)[0].body as object), ["seat_list"]);
  assert.equal(JSON.parse(h.storeAtPut[0]!).v, 1);
  assert.ok(
    h.logs.some(([level, msg]) => level === "info" && /no message/.test(msg)),
    "the fallback is logged",
  );
});

test("S4 protect with history R-W4-35: when seating the members fails, a declined dialog included, the channel stays protected with the owner alone and the flow rejects protected_members_pending", async () => {
  const pending = { source: "client", reason: "protected_members_pending" };
  // The growth dialog of the member list is declined.
  const server = historyServer();
  const h = historyHarness(server, {
    sign: (_a, n) => {
      if (n === 1) throw { type: "declined" };
      return undefined;
    },
  });
  await assert.rejects(protect(h.ops, h.port, CH, [BOB], 5, KEPT), pending);
  assert.equal(server.state.list?.body, boundaryGenesis(MSG1).body);
  assert.equal(createdGroups(h), 1);
  assert.equal(count(h, SEATS_PUT), 0);
  assert.equal(h.store.size, 0, "nothing left to resume, nothing rolled back");
  // RB2: "the owner alone" is read from the server after the failed step,
  // with one request.
  assert.deepEqual(h.trace.slice(h.trace.lastIndexOf(SIGN)), [SIGN, SEATS_GET]);
  // The cause is logged by its tag only.
  const at = h.logs.findIndex(([, msg]) => /members not added/.test(msg));
  assert.deepEqual(h.logs[at], [
    "warn",
    "[protected] protected, members not added",
  ]);
  assert.deepEqual(h.logData[at], {
    channelId: CH,
    source: "native",
    tag: "declined",
  });

  // The server refuses the member list.
  _resetOwnerFlowsForTest();
  const refusing = historyServer({
    seatPuts: [res(403, { type: "MissingPermission" })],
  });
  const r = historyHarness(refusing);
  await assert.rejects(protect(r.ops, r.port, CH, [BOB], 5, KEPT), pending);
  assert.equal(refusing.state.list?.body, boundaryGenesis(MSG1).body);
  assert.equal(count(r, SEATS_PUT), 1);

  // A resumed owner-only genesis whose member step fails: the same.
  _resetOwnerFlowsForTest();
  const g1 = boundaryGenesis(MSG1);
  const resumed = historyHarness(historyServer({ list: g1 }), {
    sign: () => {
      throw { type: "declined" };
    },
  });
  resumed.store.set(
    publishStoreKey(ME, CH),
    JSON.stringify({ v: 2, op: "protect", geneses: [g1], wipe: false }),
  );
  await assert.rejects(
    protect(resumed.ops, resumed.port, CH, [BOB], 5),
    pending,
  );

  // A protect that did NOT land keeps its own failure: the genesis dialog
  // declined is still native's `declined`, never "members pending".
  _resetOwnerFlowsForTest();
  const never = historyHarness(historyServer(), {
    sign: () => {
      throw { type: "declined" };
    },
  });
  await assert.rejects(protect(never.ops, never.port, CH, [BOB], 5, KEPT), {
    source: "native",
    error: { type: "declined" },
  });
  // And with no member picked there is no member step to fail.
  _resetOwnerFlowsForTest();
  const alone = historyHarness(historyServer());
  await protect(alone.ops, alone.port, CH, [], 5, KEPT);
});

test("S4 protect RB2: a member step that rejects after its list landed, or whose seats cannot be read afterwards, rejects protected_members_unconfirmed and never says the owner is alone", async () => {
  const unconfirmed = {
    source: "client",
    reason: "protected_members_unconfirmed",
  };
  // The member list lands, then its read-back does not verify: the step
  // rejects with the members on the server's list.
  const landedServer = historyServer();
  const landed = harness({
    routes: landedServer.routes,
    invoke: {
      ...historyNative(),
      [VERIFY]: (a: Record<string, unknown>) => {
        const body = (a.list as { body: string }).body;
        const seats = (lineOf(body, "seats") ?? ME).split(",");
        if (seats.length > 1) {
          throw { type: "seat_list_invalid", channel_id: CH, reason: "test" };
        }
        return verdict(seats, Number(lineOf(body, "version") ?? 1));
      },
    },
    formatsV2: true,
    historySetting: true,
  });
  await assert.rejects(
    protect(landed.ops, landed.port, CH, [BOB], 5, KEPT),
    unconfirmed,
  );
  assert.equal(count(landed, SEATS_PUT), 1);
  assert.equal(
    lineOf(landedServer.state.list!.body, "seats"),
    `${ME},${BOB}`,
    "the member list is on the server",
  );
  assert.equal(landed.trace[landed.trace.length - 1], SEATS_GET);
  assert.ok(
    landed.logs.some(([, msg]) => /members not added/.test(msg)),
    "the failed step is still logged",
  );

  // The member list is refused and the seats cannot be read afterwards:
  // one request, no retry, and nothing is claimed about who is seated.
  _resetOwnerFlowsForTest();
  const refusing = historyServer({
    seatPuts: [res(403, { type: "MissingPermission" })],
  });
  let down = false;
  const blind = harness({
    routes: {
      ...refusing.routes,
      [SEATS_PUT]: (c: Call) => {
        down = true;
        return refusing.routes[SEATS_PUT](c);
      },
      [SEATS_GET]: (c: Call) =>
        down ? "transport" : refusing.routes[SEATS_GET](c),
    },
    invoke: historyNative(),
    formatsV2: true,
    historySetting: true,
  });
  await assert.rejects(
    protect(blind.ops, blind.port, CH, [BOB], 5, KEPT),
    unconfirmed,
  );
  assert.deepEqual(
    blind.trace.slice(blind.trace.lastIndexOf(SEATS_PUT)),
    [SEATS_PUT, SEATS_GET],
    "one read, not retried",
  );
  assert.equal(blind.sleeps.length, 0);
  assert.equal(refusing.state.list?.body, boundaryGenesis(MSG1).body);

  // An answer that is not a seats snapshot reads the same way.
  _resetOwnerFlowsForTest();
  const odd = historyServer({
    seatPuts: [res(403, { type: "MissingPermission" })],
  });
  let refused = false;
  const unreadable = harness({
    routes: {
      ...odd.routes,
      [SEATS_PUT]: (c: Call) => {
        refused = true;
        return odd.routes[SEATS_PUT](c);
      },
      [SEATS_GET]: (c: Call) =>
        refused ? res(200, { list: "?" }) : odd.routes[SEATS_GET](c),
    },
    invoke: historyNative(),
    formatsV2: true,
    historySetting: true,
  });
  await assert.rejects(
    protect(unreadable.ops, unreadable.port, CH, [BOB], 5, KEPT),
    unconfirmed,
  );
});

test("S4 protect B7: a ticked wipe that was not performed rejects wipe_not_done after the member step; when that step failed too the rejection names both (RB3)", async () => {
  const missed = { source: "client", reason: "wipe_not_done" };
  const g1 = boundaryGenesis(MSG1);
  const keptEntry = JSON.stringify({
    v: 2,
    op: "protect",
    geneses: [g1],
    wipe: false,
  });

  // A stored KEPT genesis that had landed: finished, and the wipe this call
  // ticked is reported as not done. Nothing is signed, no body asks a wipe.
  const landed = historyHarness(historyServer({ list: g1 }));
  landed.store.set(publishStoreKey(ME, CH), keptEntry);
  await assert.rejects(
    protect(landed.ops, landed.port, CH, [], 5, WIPED),
    missed,
  );
  assert.equal(count(landed, SIGN), 0);
  assert.equal(puts(landed).length + posts(landed).length, 0);
  assert.equal(landed.store.size, 0);

  // A stored KEPT genesis not landed yet: the SAME bytes go out again, with
  // no wipe_history, and the call still says the wipe was not done.
  _resetOwnerFlowsForTest();
  const server = historyServer();
  const resent = historyHarness(server);
  resent.store.set(publishStoreKey(ME, CH), keptEntry);
  await assert.rejects(
    protect(resent.ops, resent.port, CH, [], 5, WIPED),
    missed,
  );
  assert.deepEqual(
    puts(resent).map((p) => p.body),
    [{ seat_list: wireOf(g1) }],
  );
  assert.equal(lineOf(server.state.list!.body, "pre_history"), "kept");

  // No stored entry, this device's kept genesis already on the server.
  _resetOwnerFlowsForTest();
  const found = historyHarness(historyServer({ list: g1 }));
  await assert.rejects(
    protect(found.ops, found.port, CH, [], 5, WIPED),
    missed,
  );
  assert.equal(count(found, SIGN), 0);
  assert.equal(puts(found).length + posts(found).length, 0);

  // With a member picked: the member step runs first, then the report.
  _resetOwnerFlowsForTest();
  const seated = historyServer({ list: g1 });
  const withMember = historyHarness(seated);
  withMember.store.set(publishStoreKey(ME, CH), keptEntry);
  await assert.rejects(
    protect(withMember.ops, withMember.port, CH, [BOB], 5, WIPED),
    missed,
  );
  assert.equal(count(withMember, SEATS_PUT), 1);
  assert.equal(lineOf(seated.state.list!.body, "seats"), `${ME},${BOB}`);
  assert.equal(lineOf(seated.state.list!.body, "pre_history"), "kept");

  // The member step fails too (RB3): the caller hears both, with the owner
  // alone on the list, and the log says the members are pending as well.
  _resetOwnerFlowsForTest();
  const both = historyHarness(historyServer({ list: g1 }), {
    sign: () => {
      throw { type: "declined" };
    },
  });
  both.store.set(publishStoreKey(ME, CH), keptEntry);
  await assert.rejects(protect(both.ops, both.port, CH, [BOB], 5, WIPED), {
    source: "client",
    reason: "wipe_not_done_members_pending",
  });
  const at = both.logs.findIndex(([, msg]) => /wipe asked for/.test(msg));
  assert.deepEqual(both.logData[at], { channelId: CH, membersPending: true });

  // Both, with the member list on the server (RB2 + RB3): the member list
  // landed and its read-back did not verify.
  _resetOwnerFlowsForTest();
  const bothServer = historyServer({ list: g1 });
  const bothLanded = harness({
    routes: bothServer.routes,
    invoke: {
      ...historyNative(),
      [VERIFY]: (a: Record<string, unknown>) => {
        const body = (a.list as { body: string }).body;
        const seats = (lineOf(body, "seats") ?? ME).split(",");
        if (seats.length > 1) {
          throw { type: "seat_list_invalid", channel_id: CH, reason: "test" };
        }
        return verdict(seats, Number(lineOf(body, "version") ?? 1));
      },
    },
    formatsV2: true,
    historySetting: true,
  });
  bothLanded.store.set(publishStoreKey(ME, CH), keptEntry);
  await assert.rejects(
    protect(bothLanded.ops, bothLanded.port, CH, [BOB], 5, WIPED),
    { source: "client", reason: "wipe_not_done_members_unconfirmed" },
  );
  assert.equal(lineOf(bothServer.state.list!.body, "seats"), `${ME},${BOB}`);
  assert.equal(lineOf(bothServer.state.list!.body, "pre_history"), "kept");

  // A genesis signed wiped that landed IS the wipe: no report.
  _resetOwnerFlowsForTest();
  const w1 = boundaryGenesis(MSG1, "wiped");
  const done = historyHarness(historyServer({ list: w1 }));
  done.store.set(
    publishStoreKey(ME, CH),
    JSON.stringify({ v: 2, op: "protect", geneses: [w1], wipe: true }),
  );
  await protect(done.ops, done.port, CH, [], 5, WIPED);
  // So is a fresh wiped protect, and a kept one that asked for no wipe.
  _resetOwnerFlowsForTest();
  const fresh = historyHarness(historyServer());
  await protect(fresh.ops, fresh.port, CH, [], 5, WIPED);
  _resetOwnerFlowsForTest();
  const kept = historyHarness(historyServer({ list: g1 }));
  kept.store.set(publishStoreKey(ME, CH), keptEntry);
  await protect(kept.ops, kept.port, CH, [], 5, KEPT);
});

/** R-W4-42: a history harness whose verify always rejects. */
const verifyFails = (server: ReturnType<typeof historyServer>) =>
  harness({
    routes: server.routes,
    invoke: {
      ...historyNative(),
      [VERIFY]: () => {
        throw { type: "seat_list_invalid", channel_id: CH, reason: "test" };
      },
    },
    formatsV2: true,
    historySetting: true,
  });

test("S4 protect R-W4-42 unticked: once the read-back shows the genesis landed, a failed verify or group create rejects protected_members_unconfirmed and no member step runs", async () => {
  const unconfirmed = {
    source: "client",
    reason: "protected_members_unconfirmed",
  };
  // A fresh protect: the genesis lands, then its verify rejects.
  const server = historyServer();
  const h = verifyFails(server);
  await assert.rejects(protect(h.ops, h.port, CH, [BOB], 5, KEPT), unconfirmed);
  assert.equal(server.state.list?.body, boundaryGenesis(MSG1).body);
  assert.equal(h.trace[h.trace.length - 1], VERIFY);
  assert.equal(count(h, SIGN), 1, "only the genesis was signed");
  assert.equal(count(h, SEATS_PUT), 0);
  assert.equal(createdGroups(h), 0);
  assert.equal(h.store.size, 0);
  // The cause is logged as an error, by its tag only.
  const at = h.logs.findIndex(([, msg]) => /not finished/.test(msg));
  assert.deepEqual(h.logs[at], [
    "error",
    "[protected] protected, the landed list not finished",
  ]);
  assert.deepEqual(h.logData[at], {
    channelId: CH,
    source: "native",
    tag: "seat_list_invalid",
  });

  // The verify passes and the group create rejects.
  _resetOwnerFlowsForTest();
  const g = historyHarness(historyServer());
  const noGroup: GroupOps = {
    ...g.ops,
    async createGroup() {
      throw { type: "mls_error" };
    },
  };
  await assert.rejects(
    protect(noGroup, g.port, CH, [BOB], 5, KEPT),
    unconfirmed,
  );
  assert.equal(count(g, VERIFY), 1);
  assert.equal(count(g, SEATS_PUT), 0);

  // A lost answer: the read-back after the re-send wait finds it landed.
  _resetOwnerFlowsForTest();
  const lost = verifyFails(
    historyServer({ protectPuts: [{ land: res(500) }] }),
  );
  await assert.rejects(
    protect(lost.ops, lost.port, CH, [BOB], 5, KEPT),
    unconfirmed,
  );
  assert.equal(count(lost, PROTECT_PUT), 1);

  // A stored genesis from an earlier call that had landed, with no opts.
  _resetOwnerFlowsForTest();
  const g1 = boundaryGenesis(MSG1);
  const resumed = verifyFails(historyServer({ list: g1 }));
  resumed.store.set(
    publishStoreKey(ME, CH),
    JSON.stringify({ v: 2, op: "protect", geneses: [g1], wipe: false }),
  );
  await assert.rejects(
    protect(resumed.ops, resumed.port, CH, [BOB], 5),
    unconfirmed,
  );
  assert.equal(count(resumed, SIGN), 0);
  assert.equal(resumed.store.size, 0);

  // Not landed: the rejection stays what it was. The server refuses the
  // PUT and holds no list: a failed protect.
  _resetOwnerFlowsForTest();
  const foreign = historyServer({
    protectPuts: [res(409, { type: "AlreadyProtected" })],
  });
  const f = verifyFails(foreign);
  await assert.rejects(protect(f.ops, f.port, CH, [BOB], 5, KEPT), {
    source: "client",
    reason: "protect_failed",
  });
  assert.equal(count(f, VERIFY), 0);
  // And the S2 flow (no opts, no boundary) keeps its own rejection.
  _resetOwnerFlowsForTest();
  const s2 = genesis();
  const plain = harness({
    routes: protectRoutes(s2, [res(200)]),
    invoke: {
      [SIGN]: () => s2,
      [VERIFY]: () => {
        throw { type: "seat_list_invalid", channel_id: CH, reason: "test" };
      },
    },
    formatsV2: true,
    historySetting: true,
  });
  await assert.rejects(protect(plain.ops, plain.port, CH, [BOB], 5), {
    source: "native",
    error: { type: "seat_list_invalid", channel_id: CH, reason: "test" },
  });
  // Another flow that finds the stored genesis landed keeps its rejection.
  _resetOwnerFlowsForTest();
  const other = verifyFails(historyServer({ list: g1 }));
  other.store.set(
    publishStoreKey(ME, CH),
    JSON.stringify({ v: 2, op: "protect", geneses: [g1], wipe: false }),
  );
  await assert.rejects(setSeats(other.ops, other.port, CH, [ME, BOB], 5), {
    source: "native",
    error: { type: "seat_list_invalid", channel_id: CH, reason: "test" },
  });
});

test("S4 protect R-W4-42 ticked: a landed genesis whose finish fails rejects protected_members_unconfirmed when it says wiped, and wipe_not_done_members_unconfirmed when it does not", async () => {
  // This call's wiped genesis landed: the wipe is on the list.
  const server = historyServer();
  const h = verifyFails(server);
  await assert.rejects(protect(h.ops, h.port, CH, [BOB], 5, WIPED), {
    source: "client",
    reason: "protected_members_unconfirmed",
  });
  assert.equal(lineOf(server.state.list!.body, "pre_history"), "wiped");
  assert.deepEqual(
    puts(h).map((p) => (p.body as { wipe_history?: unknown }).wipe_history),
    [true],
  );
  assert.equal(count(h, SEATS_PUT), 0);
  assert.equal(h.store.size, 0);

  // A stored KEPT genesis that had landed, and this call ticked the wipe:
  // the wipe is not on the list, and the caller hears both.
  _resetOwnerFlowsForTest();
  const g1 = boundaryGenesis(MSG1);
  const keptServer = historyServer({ list: g1 });
  const resumed = verifyFails(keptServer);
  resumed.store.set(
    publishStoreKey(ME, CH),
    JSON.stringify({ v: 2, op: "protect", geneses: [g1], wipe: false }),
  );
  await assert.rejects(
    protect(resumed.ops, resumed.port, CH, [BOB], 5, WIPED),
    { source: "client", reason: "wipe_not_done_members_unconfirmed" },
  );
  assert.equal(lineOf(keptServer.state.list!.body, "pre_history"), "kept");
  assert.equal(count(resumed, SIGN), 0);
  assert.equal(puts(resumed).length + posts(resumed).length, 0);
  const at = resumed.logs.findIndex(([, msg]) => /not finished/.test(msg));
  assert.deepEqual(resumed.logData[at], {
    channelId: CH,
    source: "native",
    tag: "seat_list_invalid",
  });

  // The same with nobody picked: still not an ordinary failure.
  _resetOwnerFlowsForTest();
  const alone = verifyFails(historyServer());
  await assert.rejects(protect(alone.ops, alone.port, CH, [], 5, WIPED), {
    source: "client",
    reason: "protected_members_unconfirmed",
  });
});

test("S4 sign errors: a boundary ahead of the clock is clock_behind; an S4 argument native calls invalid is logged as an error and passed on", async () => {
  const future = historyHarness(historyServer(), {
    sign: () => {
      throw {
        type: "seat_list_invalid",
        channel_id: CH,
        reason: "future_boundary",
      };
    },
  });
  await assert.rejects(protect(future.ops, future.port, CH, [], 5, KEPT), {
    source: "client",
    reason: "clock_behind",
  });
  assert.equal(count(future, PROTECT_PUT), 0);

  for (const field of ["history", "history_boundary", "pre_history", "seats"]) {
    _resetOwnerFlowsForTest();
    const h = historyHarness(historyServer(), {
      sign: () => {
        throw { type: "invalid_argument", field };
      },
    });
    await assert.rejects(protect(h.ops, h.port, CH, [], 5, KEPT), {
      source: "native",
      error: { type: "invalid_argument", field },
    });
    assert.ok(
      h.logs.some(([level]) => level === "error"),
      `${field} is logged loudly`,
    );
    assert.equal(h.store.size, 0);
  }
});

test("S4 protect: opts that are not two booleans, or a wipe without history, are refused before any request", async () => {
  const h = historyHarness(historyServer());
  for (const opts of [
    { withHistory: false, wipe: true },
    { withHistory: true },
    { wipe: true },
    { withHistory: "yes", wipe: false },
    null,
  ]) {
    await assert.rejects(
      protect(h.ops, h.port, CH, [], 5, opts as never),
      { source: "client", reason: "invalid_argument" },
      JSON.stringify(opts),
    );
  }
  assert.equal(h.trace.length, 0);
});

const heldHistory = (o: { history?: string; pre?: string } = {}) =>
  genesis({
    version: 2,
    body: v2Body({ version: 2, seats: [ME, BOB], boundary: MSG1, ...o }),
    signature: "HELD2",
  });

/** The wipe list `signedFor` answers over `held`. */
const wipeListOver = (held: SignedSeatList) =>
  signedFor({
    serverList: { version: held.version, body: held.body },
    seats: [ME, BOB],
    history: null,
    historyBoundary: null,
    preHistory: "wiped",
  });

test("S4 setHistory: both directions sign the next list with the history line changed and publish it as a seat list", async () => {
  for (const [visible, from, to] of [
    [true, "hidden", "visible"],
    [false, "visible", "hidden"],
  ] as const) {
    _resetOwnerFlowsForTest();
    const held = heldHistory({ history: from });
    const server = historyServer({ list: held });
    const h = historyHarness(server);
    await setHistory(h.ops, h.port, CH, visible);

    assert.deepEqual(h.trace, [
      SEATS_GET,
      VERIFY,
      SIGN,
      SEATS_PUT,
      SEATS_GET,
      VERIFY,
      "e2ee_text_state",
    ]);
    const [a] = signArgs(h);
    assert.deepEqual(a, {
      channelId: CH,
      userId: ME,
      seats: [ME, BOB],
      deviceCap: 5,
      serverList: { version: 2, body: held.body },
      format: null,
      authority: null,
      recovery: false,
      history: to,
      historyBoundary: null,
      preHistory: null,
      wipeCount: null,
      channelName: "secret",
      displayNames: [
        { user_id: ME, name: ME },
        { user_id: BOB, name: BOB },
      ],
    });
    const next = signedFor(a);
    assert.deepEqual(puts(h)[0].body, wireOf(next));
    assert.deepEqual(JSON.parse(h.storeAtPut[0]!), {
      v: 1,
      op: "seats",
      signed: next,
      history: to,
      answer: "sent",
    });
    assert.equal(lineOf(server.state.list!.body, "history"), to);
    assert.equal(h.store.size, 0);
  }
});

test("S4 setHistory: a declined dialog changes nothing; an answer without the asked history line is never published; a retry resumes the stored bytes", async () => {
  const declined = historyHarness(historyServer({ list: heldHistory() }), {
    sign: () => {
      throw { type: "declined" };
    },
  });
  await assert.rejects(setHistory(declined.ops, declined.port, CH, true), {
    source: "native",
    error: { type: "declined" },
  });
  assert.equal(count(declined, SEATS_PUT), 0);
  assert.equal(declined.storeWrites, 0);

  _resetOwnerFlowsForTest();
  const wrong = historyHarness(historyServer({ list: heldHistory() }), {
    sign: (a) => signedFor({ ...a, history: "hidden" }),
  });
  await assert.rejects(setHistory(wrong.ops, wrong.port, CH, true), {
    source: "client",
    reason: "publish_refused",
  });
  assert.equal(count(wrong, SEATS_PUT), 0);
  assert.equal(wrong.storeWrites, 0);

  // Aborted after a 503: the entry stays, the retry signs nothing.
  _resetOwnerFlowsForTest();
  const server = historyServer({
    list: heldHistory(),
    seatPuts: [res(503), LAND],
  });
  const h = historyHarness(server, { sleepRejectsAfter: 0 });
  await assert.rejects(setHistory(h.ops, h.port, CH, true), {
    reason: "aborted",
  });
  assert.equal(storedNow(h).history, "visible");
  await setHistory(h.ops, h.port, CH, true);
  assert.equal(count(h, SIGN), 1, "one dialog in all");
  assert.deepEqual(puts(h)[1].body, puts(h)[0].body, "SAME bytes");
  assert.equal(lineOf(server.state.list!.body, "history"), "visible");
  assert.equal(h.store.size, 0);
});

test("S4 setHistory: a stored history publish never carries another flow's removal reason", async () => {
  const server = historyServer({
    list: heldHistory(),
    seatPuts: [res(503), LAND],
  });
  const h = historyHarness(server, { sleepRejectsAfter: 0 });
  await assert.rejects(setHistory(h.ops, h.port, CH, true), {
    reason: "aborted",
  });
  await setSeats(h.ops, h.port, CH, [ME], 5, "left the team").catch(() => {});
  const [first, resent] = puts(h);
  assert.deepEqual(resent.body, first.body, "the stored history list");
  assert.equal(resent.headers, undefined, "and it goes out bare");
});

test("S4 wipeHistory R-W4-34: the wipe list is stored before the POST and re-sent byte for byte inside the call; a later call never POSTs the stored list, it drops it and signs afresh behind the dialog", async () => {
  const held = heldHistory();
  const server = historyServer({
    list: held,
    wipePosts: [res(503), "transport", LAND],
  });
  // The second dialog signs bytes that differ from the stored ones.
  const h = historyHarness(server, {
    sleepRejectsAfter: 1,
    sign: (a, n) =>
      n === 0 ? undefined : { ...signedFor(a), signature: `FRESH-${n}` },
  });
  await assert.rejects(wipeHistory(h.ops, h.port, CH), { reason: "aborted" });

  const [a] = signArgs(h);
  assert.deepEqual(a, {
    channelId: CH,
    userId: ME,
    seats: [ME, BOB],
    deviceCap: 5,
    serverList: { version: 2, body: held.body },
    format: null,
    authority: null,
    recovery: false,
    history: null,
    historyBoundary: null,
    preHistory: "wiped",
    wipeCount: null,
    channelName: "secret",
    displayNames: [
      { user_id: ME, name: ME },
      { user_id: BOB, name: BOB },
    ],
  });
  const wipeList = signedFor(a);
  assert.deepEqual(JSON.parse(h.storeAtPut[0]!), {
    v: 1,
    op: "wipe",
    signed: wipeList,
    sent: true,
  });
  // Inside the call that showed the dialog: the SAME bytes, twice.
  assert.equal(posts(h).length, 2);
  assert.ok(
    posts(h).every(
      (c) => JSON.stringify(c.body) === JSON.stringify(wireOf(wipeList)),
    ),
    "the SAME bytes, in the DataSeatList shape",
  );
  assert.deepEqual(storedNow(h).signed, wipeList, "still stored");

  // A later call: the stored list is read back, is not on the server, and
  // is dropped. The POST that follows comes after a new sign (the dialog)
  // and carries the new bytes, never the stored ones.
  const before = h.trace.length;
  await wipeHistory(h.ops, h.port, CH);
  assert.deepEqual(h.trace.slice(before), [
    SEATS_GET,
    SEATS_GET,
    VERIFY,
    SIGN,
    WIPE_POST,
    SEATS_GET,
    VERIFY,
    "e2ee_text_state",
  ]);
  const p = posts(h);
  assert.equal(p.length, 3);
  assert.ok(p.every((c) => c.path === `/channels/${CH}/history_wipe`));
  assert.deepEqual(p[2].body, wireOf({ ...wipeList, signature: "FRESH-1" }));
  assert.notDeepEqual(p[2].body, wireOf(wipeList));
  assert.equal(count(h, SIGN), 2, "one dialog per call that sends a wipe");
  assert.deepEqual(
    h.logs.filter(([, msg]) => /history wipe not on the server/.test(msg)),
    [["warn", "[protected] history wipe not on the server: dropped"]],
  );
  assert.equal(lineOf(server.state.list!.body, "pre_history"), "wiped");
  assert.equal(h.store.size, 0);
});

// What the next test proves and what it does not: `wipeHistory` never sends
// a stored wipe list, and sends nothing when its own sign is declined. It
// does not prove "a dialog in every call": the dialog is inside native's
// sign, and native's 60 s consent can answer a later `protect` sign without
// one (R-W4-40, spec'd after it).
test("S4 wipeHistory R-W4-34: a stored wipe list plus a declined sign in a later wipeHistory call sends nothing, whatever the entry says about being sent", async () => {
  const held = heldHistory();
  const wipeList = wipeListOver(held);
  for (const sent of [true, false, undefined]) {
    _resetOwnerFlowsForTest();
    const server = historyServer({ list: held });
    const h = historyHarness(server, {
      sign: () => {
        throw { type: "declined" };
      },
    });
    h.store.set(
      publishStoreKey(ME, CH),
      JSON.stringify({ v: 1, op: "wipe", signed: wipeList, sent }),
    );
    await assert.rejects(
      wipeHistory(h.ops, h.port, CH),
      { source: "native", error: { type: "declined" } },
      `sent ${sent}`,
    );
    assert.deepEqual(
      h.trace,
      [SEATS_GET, SEATS_GET, VERIFY, SIGN],
      `sent ${sent}`,
    );
    assert.equal(posts(h).length, 0, "the stored wipe never goes out");
    assert.equal(puts(h).length, 0);
    assert.equal(h.store.size, 0, "and it is gone");
    assert.equal(lineOf(server.state.list!.body, "pre_history"), "kept");
  }
});

test("S4 protect R-W4-40, the one exception to R-W4-34: a second protect with the wipe ticked signs through native again with the same arguments and sends only what that sign returned, never the stored bytes; whether that sign shows a dialog is native's 60 s consent and is not decided here", async () => {
  // The first call's PUTs never land; the channel stays unprotected.
  const server = historyServer({
    protectPuts: [res(503), "transport", LAND],
  });
  const h = historyHarness(server, {
    sleepRejectsAfter: 1,
    // The second sign returns bytes that differ from the stored ones.
    sign: (a, n) =>
      n === 0 ? undefined : { ...signedFor(a), signature: `FRESH-${n}` },
  });
  await assert.rejects(protect(h.ops, h.port, CH, [], 5, WIPED), {
    reason: "aborted",
  });
  const first = boundaryGenesis(MSG1, "wiped");
  assert.equal(count(h, SIGN), 1);
  assert.equal(server.state.list, null, "still unprotected");
  const storedBytes = JSON.stringify(h.store.get(publishStoreKey(ME, CH)));
  assert.match(storedBytes, /wiped/, "the first wipe genesis is stored");

  // The owner ticks and submits again. This code cannot know whether the
  // owner sees a dialog: it calls native's sign, with nothing in the
  // arguments that says "already confirmed", and native decides.
  const before = h.trace.length;
  await protect(h.ops, h.port, CH, [], 5, WIPED);
  const second = h.trace.slice(before);
  assert.equal(
    second.filter((t) => t === SIGN).length,
    1,
    "the second call signs through native",
  );
  assert.ok(
    second.indexOf(SIGN) < second.indexOf(PROTECT_PUT),
    "and only then sends",
  );
  assert.equal(second.filter((t) => t === PROTECT_PUT).length, 1);
  assert.deepEqual(signArgs(h)[1], signArgs(h)[0]);
  assert.equal(signArgs(h)[1].preHistory, "wiped");

  const bodies = puts(h).map((p) => p.body);
  assert.equal(bodies.length, 3);
  const firstBody = { seat_list: wireOf(first), wipe_history: true };
  assert.deepEqual(bodies.slice(0, 2), [firstBody, firstBody]);
  // The request that asks for the wipe carries the second sign's bytes.
  assert.deepEqual(bodies[2], {
    seat_list: wireOf({ ...first, signature: "FRESH-1" }),
    wipe_history: true,
  });
  assert.notDeepEqual(bodies[2], firstBody, "the stored bytes never went out");
  const landedNow: SignedSeatList | null = historyServerList(server);
  assert.equal(landedNow?.signature, "FRESH-1");
  assert.equal(h.store.size, 0);

  // And with that sign declined, the second call sends nothing at all.
  _resetOwnerFlowsForTest();
  const quiet = historyServer({ protectPuts: [res(503), "transport", LAND] });
  const d = historyHarness(quiet, {
    sleepRejectsAfter: 1,
    sign: (_a, n) => {
      if (n > 0) throw { type: "declined" };
      return undefined;
    },
  });
  await assert.rejects(protect(d.ops, d.port, CH, [], 5, WIPED), {
    reason: "aborted",
  });
  const sent = puts(d).length;
  await assert.rejects(protect(d.ops, d.port, CH, [], 5, WIPED), {
    source: "native",
    error: { type: "declined" },
  });
  assert.equal(puts(d).length, sent, "nothing after the declined sign");
  assert.equal(quiet.state.list, null);
});

test("S4 wipeHistory: a stored wipe list already on the server is finished without a request; an overtaken one is dropped and the call carries on over the server's list", async () => {
  const wipeList = wipeListOver(heldHistory());
  const entry = JSON.stringify({
    v: 1,
    op: "wipe",
    signed: wipeList,
    sent: true,
  });
  const landed = historyHarness(historyServer({ list: wipeList }));
  landed.store.set(publishStoreKey(ME, CH), entry);
  await wipeHistory(landed.ops, landed.port, CH);
  assert.equal(posts(landed).length, 0);
  assert.equal(count(landed, SIGN), 0);
  assert.equal(landed.store.size, 0);

  // Overtaken by a list that already says wiped: nothing left to do.
  _resetOwnerFlowsForTest();
  const overtaken = historyHarness(
    historyServer({ list: genesis({ ...wipeList, version: 5 }) }),
  );
  overtaken.store.set(publishStoreKey(ME, CH), entry);
  await wipeHistory(overtaken.ops, overtaken.port, CH);
  assert.deepEqual(overtaken.trace, [SEATS_GET, SEATS_GET, VERIFY]);
  assert.equal(posts(overtaken).length, 0);
  assert.equal(overtaken.store.size, 0);

  // Overtaken by a list that still says kept: the stored bytes are dropped
  // and this call signs its own wipe list over THAT list, behind the dialog.
  _resetOwnerFlowsForTest();
  const newer = genesis({
    version: 5,
    body: v2Body({ version: 5, seats: [ME, BOB], boundary: MSG1 }),
    signature: "HELD5",
  });
  const server = historyServer({ list: newer });
  const again = historyHarness(server);
  again.store.set(publishStoreKey(ME, CH), entry);
  await wipeHistory(again.ops, again.port, CH);
  assert.equal(count(again, SIGN), 1);
  assert.deepEqual(signArgs(again)[0].serverList, {
    version: 5,
    body: newer.body,
  });
  assert.equal(posts(again).length, 1);
  assert.notDeepEqual(posts(again)[0].body, wireOf(wipeList));
  assert.equal(server.state.list?.version, 6);
  assert.equal(lineOf(server.state.list!.body, "pre_history"), "wiped");
  assert.equal(again.store.size, 0);
});

test("S4 wipeHistory R-W4-28 (B9): an overtaken stored wipe list is cleared and the unrelated flow continues over the server's list", async () => {
  const wipeList = wipeListOver(heldHistory());
  const newer = genesis({
    version: 5,
    body: v2Body({ version: 5, seats: [ME, BOB], boundary: MSG1 }),
    signature: "HELD5",
  });
  for (const sent of [true, false]) {
    _resetOwnerFlowsForTest();
    const server = historyServer({ list: newer });
    const h = historyHarness(server);
    h.store.set(
      publishStoreKey(ME, CH),
      JSON.stringify({ v: 1, op: "wipe", signed: wipeList, sent }),
    );
    // An unseat that has nothing to do with the wipe: it goes through.
    await setSeats(h.ops, h.port, CH, [ME], 5, "left the team");
    assert.deepEqual(
      h.trace,
      [
        SEATS_GET,
        SEATS_GET,
        VERIFY,
        SIGN,
        SEATS_PUT,
        SEATS_GET,
        VERIFY,
        "e2ee_text_state",
      ],
      `sent ${sent}`,
    );
    assert.equal(posts(h).length, 0, "the wipe never goes out");
    assert.deepEqual(signArgs(h)[0].serverList, {
      version: 5,
      body: newer.body,
    });
    assert.equal(server.state.list?.version, 6);
    assert.equal(lineOf(server.state.list!.body, "seats"), ME);
    assert.equal(lineOf(server.state.list!.body, "pre_history"), "kept");
    assert.equal(h.store.size, 0);
  }
  // The channel is gone from under it (no list): cleared, and the flow
  // answers what it answers without a stored entry.
  _resetOwnerFlowsForTest();
  const none = historyHarness(historyServer());
  none.store.set(
    publishStoreKey(ME, CH),
    JSON.stringify({ v: 1, op: "wipe", signed: wipeList, sent: true }),
  );
  await assert.rejects(setSeats(none.ops, none.port, CH, [ME], 5), {
    source: "client",
    reason: "not_protected",
  });
  assert.equal(none.store.size, 0);
});

test("S4 wipeHistory R-W4-28: a stored wipe list never blocks or rides on another owner flow: not on the server it is dropped and the flow signs over the server's list", async () => {
  const held = heldHistory();
  const wipeList = wipeListOver(held);
  for (const sent of [true, undefined, false]) {
    _resetOwnerFlowsForTest();
    const server = historyServer({ list: held });
    const h = historyHarness(server);
    h.store.set(
      publishStoreKey(ME, CH),
      JSON.stringify({ v: 1, op: "wipe", signed: wipeList, sent }),
    );
    // An unseat, with its reason.
    await setSeats(h.ops, h.port, CH, [ME], 5, "left the team");
    assert.deepEqual(
      h.trace,
      [
        SEATS_GET,
        SEATS_GET,
        VERIFY,
        SIGN,
        SEATS_PUT,
        SEATS_GET,
        VERIFY,
        "e2ee_text_state",
      ],
      `sent ${sent}`,
    );
    assert.equal(posts(h).length, 0, "the wipe never goes out");
    const [a] = signArgs(h);
    assert.deepEqual(a.seats, [ME]);
    assert.deepEqual(
      a.serverList,
      { version: 2, body: held.body },
      "signed over the list the server holds",
    );
    assert.equal(a.preHistory, null);
    assert.deepEqual(puts(h)[0].headers, {
      "X-Audit-Log-Reason": "left the team",
    });
    assert.notDeepEqual(puts(h)[0].body, wireOf(wipeList));
    assert.equal(server.state.list?.version, 3);
    assert.equal(lineOf(server.state.list!.body, "pre_history"), "kept");
    assert.equal(lineOf(server.state.list!.body, "seats"), ME);
    assert.equal(h.store.size, 0);
    // One that may have been sent is dropped loudly.
    assert.deepEqual(
      h.logs.filter(([, msg]) => /history wipe not on the server/.test(msg)),
      [
        [
          sent === false ? "info" : "warn",
          "[protected] history wipe not on the server: dropped",
        ],
      ],
      `sent ${sent}`,
    );
  }
});

test("S4 wipeHistory R-W4-28: another owner flow that finds its stored wipe list on the server finishes it and carries on over the wiped list", async () => {
  const held = heldHistory();
  const wipeList = wipeListOver(held);
  const server = historyServer({ list: wipeList });
  const h = historyHarness(server);
  h.store.set(
    publishStoreKey(ME, CH),
    JSON.stringify({ v: 1, op: "wipe", signed: wipeList, sent: true }),
  );
  await setSeats(h.ops, h.port, CH, [ME], 5, "left the team");
  assert.deepEqual(h.trace, [
    // the stored wipe list: read back, landed, verified
    SEATS_GET,
    SEATS_GET,
    VERIFY,
    "e2ee_text_state",
    // the unseat, on top of it
    SEATS_GET,
    VERIFY,
    SIGN,
    SEATS_PUT,
    SEATS_GET,
    VERIFY,
    "e2ee_text_state",
  ]);
  assert.equal(posts(h).length, 0);
  assert.equal(verifiedBody(h), wipeList.body);
  assert.deepEqual(signArgs(h)[0].serverList, {
    version: 3,
    body: wipeList.body,
  });
  assert.equal(server.state.list?.version, 4);
  assert.equal(lineOf(server.state.list!.body, "pre_history"), "wiped");
  assert.equal(h.store.size, 0);
});

test("S4 wipeHistory: a plain InvalidOperation is wipe_refused, any other refusal keeps its type, and the bytes are used up", async () => {
  const refused = historyHarness(
    historyServer({
      list: heldHistory(),
      wipePosts: [res(400, { type: "InvalidOperation" })],
    }),
  );
  await assert.rejects(wipeHistory(refused.ops, refused.port, CH), {
    source: "client",
    reason: "wipe_refused",
  });
  assert.equal(posts(refused).length, 1);
  assert.equal(refused.store.size, 0);

  _resetOwnerFlowsForTest();
  const other = historyHarness(
    historyServer({
      list: heldHistory(),
      wipePosts: [res(403, { type: "NotOwner" })],
    }),
  );
  await assert.rejects(wipeHistory(other.ops, other.port, CH), {
    source: "server",
    status: 403,
    type: "NotOwner",
  });
  assert.equal(other.store.size, 0);
});

test("S4 wipeHistory: already wiped is done with nothing signed or sent; a declined dialog or a list not signed wiped stores nothing", async () => {
  const done = historyHarness(
    historyServer({ list: heldHistory({ pre: "wiped" }) }),
  );
  await wipeHistory(done.ops, done.port, CH);
  assert.deepEqual(done.trace, [SEATS_GET, VERIFY]);

  _resetOwnerFlowsForTest();
  const rollback = historyHarness(historyServer({ list: heldHistory() }), {
    sign: () => {
      throw { type: "seat_list_rollback", channel_id: CH };
    },
  });
  await wipeHistory(rollback.ops, rollback.port, CH);
  assert.equal(posts(rollback).length, 0);
  assert.equal(rollback.storeWrites, 0);

  _resetOwnerFlowsForTest();
  const declined = historyHarness(historyServer({ list: heldHistory() }), {
    sign: () => {
      throw { type: "declined" };
    },
  });
  await assert.rejects(wipeHistory(declined.ops, declined.port, CH), {
    source: "native",
    error: { type: "declined" },
  });
  assert.equal(posts(declined).length, 0);
  assert.equal(declined.storeWrites, 0);

  _resetOwnerFlowsForTest();
  const kept = historyHarness(historyServer({ list: heldHistory() }), {
    sign: (a) => signedFor({ ...a, preHistory: "kept" }),
  });
  await assert.rejects(wipeHistory(kept.ops, kept.port, CH), {
    source: "client",
    reason: "publish_refused",
  });
  assert.equal(posts(kept).length, 0, "a list not signed wiped is never sent");
  assert.equal(kept.storeWrites, 0);
});

test("S4 flag: with history_setting off, absent, or without formats_v2, protect with history, setHistory and wipeHistory are refused before any request", async () => {
  for (const over of [
    { historySetting: false, formatsV2: true },
    { historySetting: true, formatsV2: false },
    "absent",
  ] as const) {
    _resetOwnerFlowsForTest();
    const h = historyHarness(
      historyServer({ list: heldHistory() }),
      over === "absent" ? {} : over,
    );
    if (over === "absent") {
      delete (h.port as { historySetting?: unknown }).historySetting;
    }
    const refused = { source: "client", reason: "history_setting_off" };
    const label = JSON.stringify(over);
    await assert.rejects(
      protect(h.ops, h.port, CH, [BOB], 5, KEPT),
      refused,
      label,
    );
    await assert.rejects(
      protect(h.ops, h.port, CH, [BOB], 5, WIPED),
      refused,
      label,
    );
    await assert.rejects(setHistory(h.ops, h.port, CH, true), refused, label);
    await assert.rejects(setHistory(h.ops, h.port, CH, false), refused, label);
    await assert.rejects(wipeHistory(h.ops, h.port, CH), refused, label);
    assert.equal(h.trace.length, 0, `${label}: no request, no native call`);
    assert.equal(h.storeWrites, 0);
    assert.ok(h.logs.some(([level]) => level === "error"));
  }
});
