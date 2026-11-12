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
  pendingSeats,
  proposedOwnerDevices,
  protect,
  publishStoreKey,
  setSeats,
  signOwnerDevices,
} from "./protectedTextOwner.ts";
import type {
  GroupOps,
  ManagerState,
  OwnerFlows,
  ProtectedSeatsResponse,
  ProtectedTextPort,
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
  pendingSeats,
  cancelPendingSeats,
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
}

function harness(opts: {
  routes: Record<string, Reply[] | ((c: Call) => Reply)>;
  invoke?: Partial<Record<string, (args: Record<string, unknown>) => unknown>>;
  state?: Partial<ManagerState> | null;
  storeSetFails?: boolean;
  sleepRejectsAfter?: number;
  /** The root advert's `formats_v2` as the port reports it (default off). */
  formatsV2?: boolean;
}): Harness {
  const h = {
    calls: [] as Call[],
    invokes: [] as Invoke[],
    sleeps: [] as number[],
    store: new Map<string, string>(),
    opsLog: [] as unknown[][],
    storeAtPut: [] as (string | null)[],
    trace: [] as string[],
  };
  const key = publishStoreKey(ME, CH);
  const port: ProtectedTextPort = {
    formatsV2: () => opts.formatsV2 === true,
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
