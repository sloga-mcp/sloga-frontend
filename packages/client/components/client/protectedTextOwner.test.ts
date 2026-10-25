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

import {
  _resetOwnerFlowsForTest,
  protect,
  publishStoreKey,
  setSeats,
} from "./protectedTextOwner.ts";
import type {
  GroupOps,
  ManagerState,
  OwnerFlows,
  ProtectedTextPort,
  SignedSeatList,
  TextApiResponse,
  TextChannelState,
} from "./protectedTextTypes.ts";

// Compile-time: the exports are exactly what B5 wires as `deps.owner`.
const _ownerFlows: OwnerFlows = { protect, setSeats };
void _ownerFlows;

const CH = "01CHANNEL0000000000000000A";
const ME = "01USERME000000000000000000";
const MY_DEV = "aa".repeat(16);
const BOB = "01USERBOB00000000000000000";
const SERVER_OWNER = ME;

type Reply = TextApiResponse | "transport";
type Call = { method: string; path: string; body: unknown };
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
}

function harness(opts: {
  routes: Record<string, Reply[] | ((c: Call) => Reply)>;
  invoke?: Partial<Record<string, (args: Record<string, unknown>) => unknown>>;
  state?: Partial<ManagerState> | null;
  storeSetFails?: boolean;
  sleepRejectsAfter?: number;
}): Harness {
  const h = {
    calls: [] as Call[],
    invokes: [] as Invoke[],
    sleeps: [] as number[],
    store: new Map<string, string>(),
    opsLog: [] as unknown[][],
    storeAtPut: [] as (string | null)[],
  };
  const key = publishStoreKey(ME, CH);
  const port: ProtectedTextPort = {
    async invoke(cmd, args) {
      h.invokes.push({ cmd, args: args as Record<string, unknown> });
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
    async api(method, path, body) {
      const c = { method, path, body };
      h.calls.push(c);
      if (method === "PUT") h.storeAtPut.push(h.store.get(key) ?? null);
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
    log() {},
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
