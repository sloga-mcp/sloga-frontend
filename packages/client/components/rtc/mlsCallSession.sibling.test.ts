// Session-level specs for the SIBLING-DEVICE wedge (plan
// `mls-call-sibling-device-wedge.md`, P1), on a fleet (`newFleet` in
// `mlsCallSession.harness.ts`).
//   node --test --conditions=browser components/rtc/mlsCallSession.sibling.test.ts
//
// One user carries an encrypted call from device D1 to device D2. D2's join
// evicts D1 from the SFU (`voice_join.rs` force-disconnect), D1 gets
// `PARTICIPANT_REMOVED` and never auto-rejoins (`voiceRejoinPolicy.ts`), and
// D1's MLS leaf stays in the group. The DS holds one leaf per user, so D2's
// intent meets the sibling branch of `join_intent.rs`:
//   - D1 is the group's ONLY member and the SFU listing answered without it:
//     delta closes the group and answers 404. D2's ladder takes its
//     `not_found` arm (`group closed during join`) and CREATEs at once, and a
//     newcomer already laddering on the closed group follows it there;
//   - otherwise (a live member, the kill switch off, an SFU that did not
//     answer): today's 400. With a live member that heals, because the
//     member's leave-grace removes D1 and D2's retried intent is admitted.
//     With none it is the wedge: four refused intents, then
//     `join timed out after retries`.
//
// Each seat is driven as the app drives it: D1 leaves the SFU and hangs up
// (`World.hangUp`, the disconnect a force-disconnect runs, which KEEPS its
// group) and is never started again; D2 is on the SFU before its first
// intent; every seat in the call watches each arrival and departure. The DS's
// SFU listing (`Ds.setSfuOracle`) reads that same room, so what the DS sees
// is what the seats see. No seat may publish outside `e2ee` at any sampled
// moment of any case.
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import {
  type Fleet,
  type Identity,
  type World,
  advance,
  flush,
  GROUP,
  identityOf,
  LEAVE_GRACE_MS,
  newFleet,
  PEER,
  PEER_ID,
  SELF,
  SELF_ID,
} from "./mlsCallSession.harness.ts";

// ---- The session's bounds, mirrored ---------------------------------------
//
// None of these is exported by `mlsCallSession.ts`, so each is copied here
// under its own name; a change there has to be made here too.

/** `JOINER_RETRY_MS` — each Welcome wait of the join ladder. */
const JOINER_RETRY_MS = 10_000;
/** `MAX_JOINER_RETRIES` — re-broadcasts after the first intent. */
const MAX_JOINER_RETRIES = 3;
/** Intents one un-admitted ladder broadcasts (`attempt <= MAX_JOINER_RETRIES`). */
const LADDER_INTENTS = MAX_JOINER_RETRIES + 1;
/** One whole ladder: every attempt's Welcome wait, back to back. */
const LADDER_MS = LADDER_INTENTS * JOINER_RETRY_MS;
/** `REUPGRADE_HYSTERESIS_MS` — `mixed` back to `e2ee` once the roster is clean. */
const REUPGRADE_HYSTERESIS_MS = 15_000;
/** `RECONCILE_INTERVAL_MS` — the session's periodic reconcile tick. */
const RECONCILE_INTERVAL_MS = 5_000;

/** D2: the same user as `SELF` (D1), on another device. */
const SIBLING: Identity = { user_id: SELF.user_id, device_id: "devA2" };
const SIBLING_ID = identityOf(SIBLING);

/** What `#toResecuring` logs for the ladder's `not_found` arm. */
const CLOSED_DURING_JOIN = "group closed during join";
/** What `#toResecuring` logs when the ladder runs out. */
const JOIN_TIMED_OUT = "join timed out after retries";
/** What the ladder logs for a refused (thrown) intent broadcast. */
const BROADCAST_FAILED = "[mls] join intent broadcast failed";

// ---- Console ---------------------------------------------------------------

/** Every `console` level silenced and recorded for the rest of the test. */
function captureConsole(t: TestContext) {
  return {
    error: t.mock.method(console, "error", () => {}),
    warn: t.mock.method(console, "warn", () => {}),
    info: t.mock.method(console, "info", () => {}),
  };
}

type Captured = ReturnType<typeof captureConsole>;

/** Every `level` line whose first argument starts with `prefix`. */
function lines(
  logs: Captured,
  level: keyof Captured,
  prefix: string,
): unknown[][] {
  return logs[level].mock.calls
    .filter((c) => String(c.arguments[0]).startsWith(prefix))
    .map((c) => c.arguments);
}

/** The reason of every `[mls] re-securing:` line, in order. */
function resecures(logs: Captured): string[] {
  return lines(logs, "warn", "[mls] re-securing:").map((args) =>
    String(args[1]),
  );
}

// ---- The call ----------------------------------------------------------------

/**
 * A fleet, which seats are in the SFU call, and every answer the DS's SFU
 * listing gave. `violations` is every sampled moment at which a live seat
 * published while its mode was not `e2ee`; `samples` counts the checks, so a
 * watcher that never looked cannot pass.
 */
interface Call {
  readonly fleet: Fleet;
  readonly inCall: Set<World>;
  readonly listings: (readonly string[] | null)[];
  readonly violations: string[];
  samples: number;
}

/** Call `on` after every push to `list` (the harness's append-only logs). */
function tap<T>(list: T[], on: (item: T) => void): void {
  const push = list.push;
  Object.defineProperty(list, "push", {
    configurable: true,
    writable: true,
    value: (...items: T[]): number => {
      const length = push.apply(list, items);
      for (const item of items) on(item);
      return length;
    },
  });
}

/** A seat whose session is not closed and whose gate is open must be `e2ee`. */
function check(call: Call, where: string): void {
  call.samples++;
  for (const world of call.fleet.seats) {
    const session = world.session;
    if (session.state() === "closed") continue;
    const mode = session.callMode().kind;
    if (world.publishing() && mode !== "e2ee") {
      call.violations.push(
        `${identityOf(world.me)} published at "${where}" in mode ${mode}`,
      );
    }
  }
}

function newCall(t: TestContext, seats: Identity[], channel: string): Call {
  const fleet = newFleet(t, seats, channel);
  const call: Call = {
    fleet,
    inCall: new Set(),
    listings: [],
    violations: [],
    samples: 0,
  };
  for (const world of fleet.seats) {
    tap(world.gateLog, (edge) => {
      // `-mixed` is the warm re-upgrade (T2, `#scheduleReupgrade`) lifting
      // its pause once the roster is clean: E2EE never left the group, and it
      // resumes publishing BEFORE its chained `e2ee` label lands, so at this
      // one edge the label lags the gate by design. Not sampled here; the
      // next mode edge and every step are, so a `mixed` that stays open
      // still fails.
      if (edge !== "-mixed") check(call, `gate ${edge}`);
    });
    tap(world.modes, (mode) => check(call, `mode ${mode}`));
  }
  return call;
}

/** The DS's SFU listing answers the room as it stands, recorded. */
function listFromRoom(call: Call): void {
  const room = call.fleet.seats[0];
  call.fleet.ds.setSfuOracle(() => {
    const answer = [...room.sfu];
    call.listings.push(answer);
    return answer;
  });
}

/** The DS's SFU listing never answers, recorded. */
function listNothing(call: Call): void {
  call.fleet.ds.setSfuOracle(() => {
    call.listings.push(null);
    return null;
  });
}

/** `advance`, sampling every seat after each 250 ms step. */
async function run(t: TestContext, call: Call, ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 250) {
    await advance(t, Math.min(250, ms - elapsed));
    check(call, `t+${elapsed}`);
  }
}

/** Advance until `world` is active, or fail after `boundMs`. */
async function untilActive(
  t: TestContext,
  call: Call,
  world: World,
  boundMs: number,
): Promise<void> {
  for (let waited = 0; waited < boundMs; waited += 250) {
    if (world.session.state() === "active") return;
    await run(t, call, 250);
  }
  assert.equal(
    world.session.state(),
    "active",
    `${identityOf(world.me)} never went active`,
  );
}

/**
 * `world` connects to the SFU (every seat in the call watches it arrive) and
 * its session starts, up to its first await. As `bringUp` seats a joiner.
 */
async function sfuJoin(call: Call, world: World): Promise<void> {
  const id = identityOf(world.me);
  const room = call.fleet.seats[0];
  if (!room.sfu.includes(id)) room.sfu = [...room.sfu, id];
  room.sids.set(id, [`TR_${world.me.device_id}`]);
  for (const seat of call.inCall) seat.session.onParticipantJoined(id);
  call.inCall.add(world);
  void world.session.start();
  await flush();
}

/**
 * `world` is evicted by its user's newer join: off the SFU (every seat still
 * in the call watches it leave) and hung up, its group kept, as the
 * disconnect on `PARTICIPANT_REMOVED` leaves it. It is never started again.
 */
function carriedAway(call: Call, world: World): void {
  const id = identityOf(world.me);
  const room = call.fleet.seats[0];
  room.sfu = room.sfu.filter((p) => p !== id);
  room.sids.delete(id);
  world.hangUp();
  call.inCall.delete(world);
  for (const seat of call.inCall) seat.session.onParticipantLeft(id);
}

/** `world` is in `groupId` at the DS's epoch, active, `e2ee` and publishing. */
function assertGreen(
  call: Call,
  world: World,
  groupId: string,
  members: string[],
): void {
  const id = identityOf(world.me);
  const ds = call.fleet.ds;
  assert.equal(world.session.state(), "active", `${id}'s session`);
  assert.equal(world.session.callMode().kind, "e2ee", `${id}'s mode`);
  assert.equal(world.publishing(), true, `${id}'s gate is still held`);
  assert.equal(world.terminalLoud(), false, `${id} latched loud`);
  assert.equal(world.session.groupId(), groupId, `${id}'s group`);
  assert.equal(world.localGroups.get(groupId)?.state, "active", `${id}'s row`);
  assert.equal(world.localEpoch, ds.epoch, `${id}'s native epoch`);
  assert.deepEqual(
    [...world.localRoster.map(identityOf)].sort(),
    [...members].sort(),
    `${id}'s native roster`,
  );
}

/** No seat ever published outside `e2ee`, and the seats were looked at. */
function assertNoPlaintext(call: Call): void {
  assert.ok(call.samples > 0, "the call was never sampled");
  assert.deepEqual(call.violations, [], "a plaintext publish window");
}

/** `id`'s creates, in order, as `[groupId, outcome]`. */
function creates(call: Call, id: string): [string, string][] {
  return call.fleet.ds.submits
    .filter((s) => s.seat === id && s.kind === "create")
    .map((s) => [s.groupId, s.outcome]);
}

/**
 * Alice alone on D1 in an encrypted call: D1 created GROUP and is green.
 * With `bob`, he joins too and D1 admits him.
 */
async function aliceUp(
  t: TestContext,
  call: Call,
  { bob = false }: { bob?: boolean } = {},
): Promise<void> {
  const { fleet } = call;
  const d1 = fleet.seat(SELF);
  await sfuJoin(call, d1);
  await run(t, call, 1); // the detached establish (group action) runs
  await untilActive(t, call, d1, 10_000);
  if (bob) {
    const peer = fleet.seat(PEER);
    await sfuJoin(call, peer);
    await run(t, call, 1);
    await untilActive(t, call, peer, 10_000);
  }
  await run(t, call, 3_000);
  const members = bob ? [SELF_ID, PEER_ID] : [SELF_ID];
  assert.equal(fleet.ds.groupId, GROUP);
  assert.deepEqual(fleet.ds.members.map(identityOf), members, "DS roster");
  assertGreen(call, d1, GROUP, members);
  if (bob) assertGreen(call, fleet.seat(PEER), GROUP, members);
}

/**
 * Today's wedge, after D2 joins: every intent refused, the ladder spent,
 * D2 never enrolled in anything, and the old group still open around D1's
 * stale leaf.
 */
async function assertWedged(
  t: TestContext,
  call: Call,
  logs: Captured,
  channel: string,
): Promise<void> {
  const { fleet } = call;
  const d2 = fleet.seat(SIBLING);
  const states = new Set<string>();
  for (let elapsed = 0; elapsed < LADDER_MS + 5_000; elapsed += 250) {
    await run(t, call, 250);
    states.add(d2.session.state());
  }

  assert.equal(states.has("active"), false, "D2 went active");
  assert.equal(d2.joinIntents(), LADDER_INTENTS, "D2's intents");
  assert.equal(
    lines(logs, "warn", BROADCAST_FAILED).length,
    LADDER_INTENTS,
    "every intent was refused",
  );
  assert.deepEqual(
    resecures(logs).filter((r) => r === JOIN_TIMED_OUT),
    [JOIN_TIMED_OUT],
  );
  assert.equal(resecures(logs).includes(CLOSED_DURING_JOIN), false);
  assert.notEqual(d2.session.state(), "active");
  assert.notEqual(d2.session.callMode().kind, "e2ee");
  assert.equal(d2.publishing(), false, "D2's gate opened");
  assert.equal(d2.localGroups.has(GROUP), false, "D2 holds the old group");

  // The DS never closed: the old group is open, around D1's stale leaf
  // alone, and D2 created nothing that won.
  assert.equal(fleet.ds.openGroup(channel), GROUP, "the old group closed");
  assert.equal(fleet.ds.groupId, GROUP);
  assert.deepEqual(fleet.ds.members.map(identityOf), [SELF_ID], "DS roster");
  assert.deepEqual(
    creates(call, SIBLING_ID).filter(([, outcome]) => outcome === "won"),
    [],
    "D2 created a group",
  );
  assertNoPlaintext(call);
}

// ---- The close ---------------------------------------------------------------

test("sibling: the sole stale sibling — D2's first intent gets not_found, the old group is closed, and D2 CREATEs a new group and goes green", async (t) => {
  const logs = captureConsole(t);
  const channel = "ch-sib-sole";
  const call = newCall(t, [SELF, SIBLING], channel);
  const { fleet } = call;
  const d1 = fleet.seat(SELF);
  const d2 = fleet.seat(SIBLING);
  await aliceUp(t, call);
  listFromRoom(call);

  carriedAway(call, d1);
  await sfuJoin(call, d2);
  await run(t, call, 1);
  // CREATE at once on the 404: no Welcome wait, no second intent.
  await untilActive(t, call, d2, JOINER_RETRY_MS / 2);

  // The DS weighed the close on a listing with D2 in it and D1 not.
  assert.ok(call.listings.length >= 1, "the DS never listed the SFU");
  assert.deepEqual(call.listings[0], [SIBLING_ID]);
  assert.equal(d2.joinIntents(), 1, "D2's intents");
  assert.deepEqual(lines(logs, "warn", BROADCAST_FAILED), [], "a 400");
  assert.deepEqual(resecures(logs), [CLOSED_DURING_JOIN]);

  // D2's first create lost to the open GROUP; its create after the close
  // won, so the channel had no open group left: GROUP was closed.
  const made = creates(call, SIBLING_ID);
  assert.equal(made.length, 2, `D2's creates: ${JSON.stringify(made)}`);
  assert.equal(made[0][1], "lost");
  const [successor, outcome] = made[1];
  assert.equal(outcome, "won");
  assert.notEqual(successor, GROUP);
  assert.equal(fleet.ds.openGroup(channel), successor, "the open group");
  assert.equal(fleet.ds.groupId, successor);
  assert.deepEqual(fleet.ds.members.map(identityOf), [SIBLING_ID]);
  assertGreen(call, d2, successor, [SIBLING_ID]);

  // Stable through what a ladder would have spent; D1 never came back.
  await run(t, call, LADDER_MS);
  assertGreen(call, d2, successor, [SIBLING_ID]);
  assert.equal(d2.joinIntents(), 1, "D2 re-intented");
  assert.equal(resecures(logs).includes(JOIN_TIMED_OUT), false);
  assert.equal(d1.session.state(), "closed");
  assert.equal(d1.sfu.includes(SELF_ID), false, "D1 is back on the SFU");
  assertNoPlaintext(call);
});

test("sibling: a newcomer laddering on the old group when it closes — its next intent gets not_found and it converges onto D2's new group", async (t) => {
  const logs = captureConsole(t);
  const channel = "ch-sib-newcomer";
  const call = newCall(t, [SELF, SIBLING, PEER], channel);
  const { fleet } = call;
  const d1 = fleet.seat(SELF);
  const d2 = fleet.seat(SIBLING);
  const bob = fleet.seat(PEER);
  await aliceUp(t, call);
  listFromRoom(call);

  carriedAway(call, d1);
  // Bob joins while the old group is still open: his create loses to it,
  // and his intent is accepted and fanned to alice's devices, of which none
  // can admit him (D1 is gone, D2 holds no group yet).
  await sfuJoin(call, bob);
  await run(t, call, 1);
  assert.equal(bob.joinIntents(), 1, "bob's first intent");
  assert.deepEqual(lines(logs, "warn", BROADCAST_FAILED), [], "a 400");
  assert.equal(bob.session.state(), "starting");
  assert.equal(fleet.ds.openGroup(channel), GROUP);
  await run(t, call, 2_000); // still inside bob's first Welcome wait

  await sfuJoin(call, d2);
  await run(t, call, 1);
  await untilActive(t, call, d2, JOINER_RETRY_MS / 2);
  const successor = d2.session.groupId();
  assert.ok(successor !== null && successor !== GROUP, "D2's group");
  assert.equal(fleet.ds.openGroup(channel), successor, "GROUP is still open");
  assert.deepEqual(call.listings[0], [PEER_ID, SIBLING_ID]);
  assert.deepEqual(resecures(logs), [CLOSED_DURING_JOIN], "D2's not_found arm");
  assert.equal(bob.joinIntents(), 1, "bob re-intented before the close");
  assert.notEqual(bob.session.state(), "active");

  // Bob's Welcome wait runs out, his next intent meets the closed group,
  // and he re-establishes onto D2's group, where D2 admits him.
  await untilActive(t, call, bob, JOINER_RETRY_MS + 10_000);
  assert.deepEqual(resecures(logs), [CLOSED_DURING_JOIN, CLOSED_DURING_JOIN]);
  assert.equal(resecures(logs).includes(JOIN_TIMED_OUT), false);
  // Bob's two creates both lost: to the old group, then to D2's.
  assert.deepEqual(
    creates(call, PEER_ID).map(([, outcome]) => outcome),
    ["lost", "lost"],
  );
  assert.ok(
    fleet.ds.submits.some(
      (s) =>
        s.seat === SIBLING_ID &&
        s.kind === "admit" &&
        s.groupId === successor &&
        s.outcome === "won",
    ),
    "D2 never admitted bob",
  );
  // D2 created its group with bob already on the SFU and not in it, and saw
  // no arrival of his to open an admit-grace window for (he was there before
  // D2 connected), so D2 held its publishing under `mixed` until his Add. The
  // re-upgrade then waits out its hysteresis before D2 is green.
  await run(t, call, REUPGRADE_HYSTERESIS_MS + RECONCILE_INTERVAL_MS);
  assert.equal(fleet.ds.groupId, successor);
  assert.deepEqual(
    fleet.ds.members.map(identityOf),
    [SIBLING_ID, PEER_ID],
    "DS roster",
  );
  assertGreen(call, d2, successor, [SIBLING_ID, PEER_ID]);
  assertGreen(call, bob, successor, [SIBLING_ID, PEER_ID]);

  await run(t, call, LADDER_MS);
  assertGreen(call, d2, successor, [SIBLING_ID, PEER_ID]);
  assertGreen(call, bob, successor, [SIBLING_ID, PEER_ID]);
  assert.equal(resecures(logs).includes(JOIN_TIMED_OUT), false);
  assertNoPlaintext(call);
});

// ---- No close ----------------------------------------------------------------

test("sibling: with a live member there is no close — bob's leave-grace removes D1, D2's retried intent is admitted within the ladder, and the group id is unchanged", async (t) => {
  const logs = captureConsole(t);
  const channel = "ch-sib-live-member";
  const call = newCall(t, [SELF, SIBLING, PEER], channel);
  const { fleet } = call;
  const d1 = fleet.seat(SELF);
  const d2 = fleet.seat(SIBLING);
  const bob = fleet.seat(PEER);
  await aliceUp(t, call, { bob: true });
  listFromRoom(call);
  const epoch = fleet.ds.epoch;
  const from = fleet.ds.submits.length;
  const left = Date.now();

  carriedAway(call, d1);
  await sfuJoin(call, d2);
  await run(t, call, 1);
  // Two members: the 400, the group untouched.
  assert.equal(d2.joinIntents(), 1, "D2's first intent");
  assert.equal(lines(logs, "warn", BROADCAST_FAILED).length, 1, "no 400");
  assert.equal(fleet.ds.openGroup(channel), GROUP);
  assert.deepEqual(fleet.ds.members.map(identityOf), [SELF_ID, PEER_ID]);

  // Bob's leave-grace is honoured: D1's leaf stays until it runs out.
  await run(t, call, LEAVE_GRACE_MS - 1_000 - (Date.now() - left));
  assert.ok(
    fleet.ds.members.some((m) => identityOf(m) === SELF_ID),
    "D1 was removed inside the leave-grace",
  );
  assert.notEqual(d2.session.state(), "active");

  await untilActive(t, call, d2, LADDER_MS);
  await run(t, call, 3_000);
  const intents = d2.joinIntents();
  assert.ok(
    intents >= 2 && intents <= LADDER_INTENTS,
    `D2 was admitted outside the ladder (${intents} intents)`,
  );
  assert.deepEqual(resecures(logs), [], "a re-securing");

  // No close: the same group, D1 removed by bob, D2 added by bob.
  assert.equal(fleet.ds.openGroup(channel), GROUP);
  assert.equal(fleet.ds.groupId, GROUP);
  assert.deepEqual(
    creates(call, SIBLING_ID).map(([, outcome]) => outcome),
    ["lost"],
    "D2 created a group",
  );
  assert.deepEqual(
    fleet.ds.submits
      .slice(from)
      .filter((s) => s.groupId === GROUP)
      .map((s) => [s.seat, s.kind, s.epoch, s.outcome]),
    [
      [PEER_ID, "remove", epoch + 1, "won"],
      [PEER_ID, "admit", epoch + 2, "won"],
    ],
  );
  const [removal, readd] = fleet.ds.log.filter((c) => c.epoch > epoch);
  assert.deepEqual(removal.removed.map(identityOf), [SELF_ID]);
  assert.deepEqual(readd.added.map(identityOf), [SIBLING_ID]);
  // Any listing the DS read lacked D1: the refusal is the two-member rule.
  for (const listing of call.listings) {
    assert.equal(listing?.includes(SELF_ID), false, "D1 was listed");
  }
  assertGreen(call, d2, GROUP, [PEER_ID, SIBLING_ID]);
  assertGreen(call, bob, GROUP, [PEER_ID, SIBLING_ID]);
  assertNoPlaintext(call);
});

test("sibling: kill switch off (base control) — D2 is refused on every intent, the ladder runs out, and the wedge reproduces", async (t) => {
  const logs = captureConsole(t);
  const channel = "ch-sib-switch-off";
  const call = newCall(t, [SELF, SIBLING], channel);
  const { fleet } = call;
  await aliceUp(t, call);
  listFromRoom(call);
  fleet.ds.setSiblingClose(false);

  carriedAway(call, fleet.seat(SELF));
  await sfuJoin(call, fleet.seat(SIBLING));
  await assertWedged(t, call, logs, channel);
});

test("sibling: the SFU listing does not answer — no close on missing evidence, and the wedge reproduces", async (t) => {
  const logs = captureConsole(t);
  const channel = "ch-sib-sfu-silent";
  const call = newCall(t, [SELF, SIBLING], channel);
  const { fleet } = call;
  await aliceUp(t, call);
  listNothing(call);
  fleet.ds.setSiblingClose(true);

  carriedAway(call, fleet.seat(SELF));
  await sfuJoin(call, fleet.seat(SIBLING));
  await assertWedged(t, call, logs, channel);
  // The DS asked, on every refused intent, and the SFU never answered.
  assert.equal(call.listings.length, LADDER_INTENTS, "the DS never listed");
  assert.ok(call.listings.every((l) => l === null));
});
