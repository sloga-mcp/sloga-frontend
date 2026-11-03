// Session-level specs for a call member whose native store stops accepting
// another member's leaf (`MlsCallSession`), on the fleet in
// `mlsCallSession.harness.ts`.
//   node --test --conditions=browser components/rtc/mlsCallSession.revokedleaf.test.ts
//
// When a device is removed from an account mid-call, a member that learns of
// it marks that device's pin revoked, and from then on native refuses every
// whole-roster read of the group (`mls_leaf_rejected`, `identity_changed`)
// for as long as the leaf is in it. Every `callState` reader hands that
// refusal to the leaf classifier before it fails as it otherwise would, and
// the cases pin what the member then does about the leaf:
//   1. the member removes the leaf once the device drops off the SFU, and the
//      same user's new device is then admitted;
//   2. it removes the leaf with the device still connected (SFU presence
//      holds nothing back), the next epoch's keys leave it out, and once its
//      admit-grace ends it reads non-enrolled and the member holds its media;
//   3. a leaf the member merely has no pin for yet (`unknown_identity`) is
//      re-pinned through the listing reconcile, never removed, never red;
//   4. the verdict alone removes a leaf whose device is live, connected,
//      green and listed: nothing outside the member's own verdict vetoes it;
//   5. another member's commit that reaches the member before its Remove
//      poisons the member's row, and the successor it opens leaves the
//      device out;
//   6. when members disagree about a device and one of them re-admits it,
//      the member that refuses it ends held in a group of its own: bounded,
//      never looping, never green while split, never plaintext;
//   7. this device's own removal ends its call with the exact notice, drops
//      its group and resume record, and never rejoins on that identity;
//   8. the removal is reached from the reconcile tick alone (8a) and from the
//      admit path alone (8b), each inside a bound that a reader skipping the
//      classifier at that one site would miss;
//   9. a leaf whose listing never pins it (each fetch fails, then each
//      arrives without the device) replaces the group once: the clock starts
//      at the first fetch that succeeded and runs on the periodic reconcile
//      tick alone, so a burst of event-driven reconciles does not move it;
//  10. a leaf whose Remove fails twice replaces the group once.
//
// Case 4 pins that the member's own verdict alone decides a Remove. A device
// listing is unsigned, so the session reads none before it removes a leaf,
// and a device that is live, connected and listed is removed all the same.
//
// No-plaintext is checked on every seat of every case, over the whole run,
// with the resume spec's watcher: every publish-gate edge, every mode label
// and every step. Its self-test shows it rejecting a plaintext window.
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import type { E2EEBridge } from "@revolt/client";

import { readResumeRecord } from "../client/mlsResumeKeep.ts";
import {
  type Fleet,
  type Identity,
  advance,
  bringUpCreator,
  flush,
  GROUP,
  groupNotFound,
  identityOf,
  latchLoud,
  LEAVE_GRACE_MS,
  newFleet,
  newWorld,
  PEER,
  PEER_ID,
  SELF,
  SELF_ID,
  THIRD,
  THIRD_ID,
  World,
} from "./mlsCallSession.harness.ts";

// ---- The session's bounds, mirrored ----------------------------------------
//
// None of these is exported by `mlsCallSession.ts`, so each is copied here
// under its own name; a change there has to be made here too.

/** `RECONCILE_INTERVAL_MS`: the periodic roster reconcile. */
const RECONCILE_INTERVAL_MS = 5_000;
/** `ADMIT_STAGGER_MS`: the per-leaf admit, serve and removal stagger. */
const ADMIT_STAGGER_MS = 2_000;
/** `ADMIT_GRACE_MAX_MS`: an admit-grace window's hard ceiling. */
const ADMIT_GRACE_MAX_MS = 60_000;
/** `MAX_REESTABLISH`: re-establishes, successors included, before loud. */
const MAX_REESTABLISH = 3;
/** `REUPGRADE_HYSTERESIS_MS`: a mix must stay clear this long to go green. */
const REUPGRADE_HYSTERESIS_MS = 15_000;
/** `REPIN_PERSIST_TICKS`: periodic ticks an unpinned leaf may outlast. */
const REPIN_PERSIST_TICKS = 2;
/** `MAX_LEAF_REMOVE_FAILURES`: failed Removes of one leaf before replacing. */
const MAX_LEAF_REMOVE_FAILURES = 2;
/** `OWN_DEVICE_REVOKED_REASON`: the notice this device's removal ends with. */
const OWN_REMOVAL_NOTICE =
  "This device was removed from encryption, so it left the call.";

/** Past the first install's rotation settle (2 s), as the resume spec waits. */
const SETTLE_MS = 3_000;
/** The watcher's sampling step: the harness's own `advance` step. */
const STEP_MS = 250;
/** How long one seat may take to go active once it starts. */
const JOIN_BOUND_MS = 40_000;
/** The line the removal path logs as it stages the Remove, verbatim. */
const removing = (identity: string) =>
  `[mls] removing ${identity}: revoked leaf`;
/** `#toResecuring`'s log line, and the reason `#poisonedSuccessor` gives. */
const RESECURING = "[mls] re-securing:";
const POISONED = "poisoned epoch — migrating to a successor group";

/** PEER's user on a second device: the install that re-enrolled. */
const PEER_NEW: Identity = { user_id: PEER.user_id, device_id: "devB2" };
const PEER_NEW_ID = identityOf(PEER_NEW);
/** A fourth device, for the cases that need a joiner beside the three. */
const DAVE: Identity = { user_id: "dave", device_id: "dev-dave" };
const DAVE_ID = identityOf(DAVE);

// ---- Watching a seat -------------------------------------------------------

/**
 * One seat's run as the spec reads it: every moment a live session published
 * while its mode was not `e2ee` (`violations`), and every frame-key set its
 * native store handed out (`keys`). `samples` counts the checks made, so a
 * watcher that never looked cannot pass.
 */
interface Watch {
  readonly world: World;
  readonly violations: string[];
  readonly keys: { epoch: number; key: string; identities: string[] }[];
  samples: number;
  check(where: string): void;
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

/**
 * Watch `world` from now on: a check on every publish-gate edge and mode
 * label, and a record of every frame-key read (`native.lastKeys` is written
 * by each one). The no-plaintext check: a session that is not closed, whose
 * publish gate is EMPTY, must be in mode `e2ee`. A closed session publishes
 * to no one and is skipped.
 *
 * An edge is judged once the turn it fired in has run out (one real
 * `setImmediate`, which every `advance` step drains), and every step is
 * judged as it ends. The warm re-upgrade out of `mixed` releases the gate
 * and only then sets its `e2ee` label, one chained microtask later, with
 * Room E2EE on throughout (`#setModeChained`: the label is not what keeps
 * media encrypted). Judged at the edge itself, that lag reads as a window;
 * any gate left open past the turn is still one.
 */
function watch(world: World): Watch {
  const id = identityOf(world.me);
  const offending = (): string | null => {
    const session = world.session;
    if (session.state() === "closed") return null;
    const mode = session.callMode().kind;
    return world.publishing() && mode !== "e2ee" ? mode : null;
  };
  const w: Watch = {
    world,
    violations: [],
    keys: [],
    samples: 0,
    check(where: string): void {
      w.samples++;
      const mode = offending();
      if (mode)
        w.violations.push(`${id} published at "${where}" in mode ${mode}`);
    },
  };
  const atEdge = (where: string) => {
    w.samples++;
    if (!offending()) return;
    setImmediate(() => {
      const mode = offending();
      if (mode)
        w.violations.push(`${id} published at "${where}" in mode ${mode}`);
    });
  };
  tap(world.gateLog, (edge) => atEdge(`gate ${edge}`));
  tap(world.modes, (mode) => atEdge(`mode ${mode}`));
  let keys = world.native.lastKeys;
  Object.defineProperty(world.native, "lastKeys", {
    configurable: true,
    get: () => keys,
    set: (next: typeof keys) => {
      keys = next;
      if (next && next.length > 0) {
        w.keys.push({
          epoch: next[0].epoch,
          key: next[0].frame_key_b64,
          identities: next.map((k) => k.livekit_identity),
        });
      }
    },
  });
  return w;
}

/** No watched seat ever published outside `e2ee`, and each was looked at. */
function assertNoPlaintext(watches: readonly Watch[]): void {
  for (const w of watches) {
    assert.ok(w.samples > 0, `${identityOf(w.world.me)} was never sampled`);
    assert.deepEqual(w.violations, [], "a plaintext publish window");
  }
}

/** `advance`, checking every watcher (and `onStep`) after each step. */
async function run(
  t: TestContext,
  ms: number,
  watches: readonly Watch[],
  onStep?: () => void,
): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += STEP_MS) {
    await advance(t, Math.min(STEP_MS, ms - elapsed));
    for (const w of watches) w.check(`t+${elapsed}`);
    onStep?.();
  }
}

/** `run` until `done()` holds, failing past `boundMs`; returns the ms taken. */
async function until(
  t: TestContext,
  watches: readonly Watch[],
  done: () => boolean,
  boundMs: number,
  what: string,
  onStep?: () => void,
): Promise<number> {
  const start = Date.now();
  while (!done()) {
    assert.ok(
      Date.now() - start < boundMs,
      `${what} did not happen within ${boundMs} ms`,
    );
    await run(t, STEP_MS, watches, onStep);
  }
  return Date.now() - start;
}

/**
 * Every `console` level silenced; each line in order, as its first argument
 * followed by its second when that is a string (`#toResecuring` logs its
 * reason there).
 */
function captureConsole(t: TestContext): string[] {
  const lines: string[] = [];
  for (const level of ["error", "warn", "info", "log"] as const) {
    t.mock.method(console, level, (...args: unknown[]) => {
      const [first, second] = args;
      lines.push(
        typeof second === "string"
          ? `${String(first)} ${second}`
          : String(first),
      );
    });
  }
  return lines;
}

/** How many entries of `list` are exactly `item`. */
const count = (list: readonly string[], item: string) =>
  list.filter((entry) => entry === item).length;

/**
 * Bridge answers the harness's fakes never give: its listing reconcile pins
 * every unpinned device it is asked about, and its `callRemove` stages every
 * Remove of a leaf the group holds, and no lever of its own makes a listing
 * fail or arrive without the device, or a Remove fail to stage. So a case
 * scripts those per seat here. Every seat's session is handed a wrapper of
 * its bridge that answers a method from that seat's script when it has one,
 * and from the fakes otherwise; the script is read at call time, so a case
 * may set or change it at any point. Installed before the fleet boots (each
 * session takes its bridge at boot) and undone when the test ends.
 */
function scriptBridges(t: TestContext): {
  script(world: World, answers: Partial<E2EEBridge>): void;
  fakes(world: World): E2EEBridge;
} {
  const scripts = new Map<string, Partial<E2EEBridge>>();
  const fakes = new Map<string, E2EEBridge>();
  const read = Object.getOwnPropertyDescriptor(World.prototype, "bridge")?.get;
  assert.ok(read, "World.bridge is not a getter");
  t.mock.getter(World.prototype, "bridge", function (this: World) {
    const id = identityOf(this.me);
    const bridge = read.call(this) as E2EEBridge;
    fakes.set(id, bridge);
    return new Proxy(bridge, {
      get(target, prop) {
        const answer =
          typeof prop === "string"
            ? scripts.get(id)?.[prop as keyof E2EEBridge]
            : undefined;
        return answer ?? Reflect.get(target, prop);
      },
    });
  });
  return {
    script(world, answers) {
      scripts.set(identityOf(world.me), answers);
    },
    fakes(world) {
      const bridge = fakes.get(identityOf(world.me));
      assert.ok(bridge, `${identityOf(world.me)} has no bridge yet`);
      return bridge;
    },
  };
}

// ---- Fleet drivers ---------------------------------------------------------

/**
 * `Fleet.bringUp` for ONE seat, so a seat of the fleet can stay out of the
 * call until the case brings it in: `world` connects to the SFU (every seat
 * in `inCall` watches it join), starts, and joins through the real ladder.
 */
async function joinCall(
  t: TestContext,
  world: World,
  inCall: readonly World[],
  watches: readonly Watch[],
): Promise<void> {
  const id = identityOf(world.me);
  if (!world.sfu.includes(id)) world.sfu = [...world.sfu, id];
  world.sids.set(id, [`TR_${world.me.device_id}`]);
  for (const other of inCall) other.session.onParticipantJoined(id);
  void world.session.start();
  await flush();
  await until(
    t,
    watches,
    () => world.session.state() === "active",
    JOIN_BOUND_MS,
    `${id} going active`,
  );
}

/** `members` join in order, settle, and are converged and green. */
async function callOf(
  t: TestContext,
  fleet: Fleet,
  members: readonly World[],
  watches: readonly Watch[],
): Promise<void> {
  const inCall: World[] = [];
  for (const world of members) {
    await joinCall(t, world, inCall, watches);
    inCall.push(world);
  }
  await run(t, SETTLE_MS, watches);
  assertConverged(fleet, members);
  for (const world of members) assertGreen(world);
}

/** `world` drops off the SFU: every seat in `inCall` watches it leave. */
function leavesSfu(world: World, inCall: readonly World[]): void {
  const id = identityOf(world.me);
  world.sfu = world.sfu.filter((p) => p !== id);
  world.sids.delete(id);
  for (const other of inCall) other.session.onParticipantLeft(id);
}

/**
 * Advance until `world`'s periodic reconcile tick fires (it refreshes the
 * resume record before it reads the roster), so the next one is a whole
 * `RECONCILE_INTERVAL_MS` away.
 */
async function afterReconcileTick(
  t: TestContext,
  world: World,
  watches: readonly Watch[],
): Promise<void> {
  const mark = world.bridgeCalls.length;
  await until(
    t,
    watches,
    () => world.bridgeCalls.slice(mark).includes("touchResumeRecord"),
    RECONCILE_INTERVAL_MS + STEP_MS,
    `${identityOf(world.me)}'s reconcile tick`,
  );
}

/** Every seat in `members` holds them, in leaf order, at the DS's epoch. */
function assertConverged(
  fleet: Fleet,
  members: readonly World[],
  groupId: string = GROUP,
): void {
  const ids = members.map((w) => identityOf(w.me));
  assert.equal(fleet.ds.groupId, groupId, "the DS's group");
  assert.deepEqual(fleet.ds.members.map(identityOf), ids, "DS roster");
  for (const world of members) {
    const id = identityOf(world.me);
    assert.equal(world.session.state(), "active", `${id}'s session`);
    assert.equal(world.session.groupId(), groupId, `${id}'s group`);
    assert.equal(world.localEpoch, fleet.ds.epoch, `${id}'s native epoch`);
    assert.deepEqual(
      world.localRoster.map(identityOf),
      ids,
      `${id}'s native roster`,
    );
  }
}

/** Green: active, mode `e2ee`, the chip `e2ee`, the gate released. */
function assertGreen(world: World): void {
  const id = identityOf(world.me);
  assert.equal(world.session.state(), "active", `${id}'s session`);
  assert.equal(world.session.callMode().kind, "e2ee", `${id}'s mode`);
  assert.equal(world.chip(), "e2ee", `${id}'s chip`);
  assert.equal(world.publishing(), true, `${id}'s gate is still held`);
}

/** The DS's arbitrated submits for `groupId` from `from` on, as tuples. */
function groupSubmits(
  fleet: Fleet,
  from: number,
  groupId: string = GROUP,
): [string, string, number, string][] {
  return fleet.ds.submits
    .slice(from)
    .filter((s) => s.groupId === groupId)
    .map((s) => [s.seat, s.kind, s.epoch, s.outcome]);
}

/** Every won commit of `groupId` from submit `from` on that removed `id`. */
function removalsOf(
  fleet: Fleet,
  id: string,
  from: number,
  groupId: string = GROUP,
): number[] {
  return fleet.ds.submits
    .slice(from)
    .filter(
      (s) =>
        s.groupId === groupId &&
        s.outcome === "won" &&
        (fleet.ds.commitAt(groupId, s.epoch)?.removed ?? []).some(
          (m) => identityOf(m) === id,
        ),
    )
    .map((s) => s.epoch);
}

/** Every commit any group of the DS won from `from` on that added `id`. */
function addsOf(fleet: Fleet, id: string, from: number): string[] {
  return fleet.ds.submits
    .slice(from)
    .filter(
      (s) =>
        s.outcome === "won" &&
        (fleet.ds.commitAt(s.groupId, s.epoch)?.added ?? []).some(
          (m) => identityOf(m) === id,
        ),
    )
    .map((s) => `${s.groupId}@${s.epoch}`);
}

// ---- The watcher itself ----------------------------------------------------

test("watch: it records a seat publishing outside e2ee, and it sees every gate edge and key read", async (t) => {
  captureConsole(t);
  const world = newWorld(t, "creator", "ch-rl-watch");
  const w = watch(world);
  await bringUpCreator(t, world);
  await run(t, SETTLE_MS, [w]);
  assert.ok(w.samples > 0);
  assert.ok(w.keys.length > 0, "the key tap saw no install");
  assert.deepEqual(w.violations, []);

  // A media failure outside every rotation window: loud, and the session
  // re-holds the gate itself.
  await latchLoud(t, world);
  assert.equal(world.publishing(), false);
  assert.deepEqual(w.violations, []);

  // A known-bad input: the gate released while the session is negotiating is
  // exactly a plaintext publish window, and it is recorded against the edge
  // once that turn has run out.
  world.gate.clear();
  world.gateLog.push("-negotiating");
  await flush();
  assert.equal(w.violations.length, 1, "the watcher missed a plaintext window");
  assert.match(w.violations[0], /published at "gate -negotiating"/);
  // And by every step after it, for as long as it stays open.
  await run(t, STEP_MS, [w]);
  assert.ok(
    w.violations.some((v) => /published at "t\+0" in mode/.test(v)),
    "a step did not see the open gate",
  );
});

// ---- 1. The reported shape -------------------------------------------------

test("1 — the member that refuses a removed device's leaf removes it once the device drops off the SFU, and the same user's new device is then admitted; both green", async (t) => {
  const logs = captureConsole(t);
  const fleet = newFleet(t, [SELF, PEER, PEER_NEW], "ch-rl-1");
  const [member, removed, renewed] = fleet.seats;
  const watches = fleet.seats.map(watch);
  await callOf(t, fleet, [member, removed], watches);
  const from = fleet.ds.submits.length;
  const epoch = fleet.ds.epoch;
  const louds = member.states.length;

  // The device is removed from the account: the member learns of it and
  // its pin flips. The SFU then drops the device's connection, and its
  // client is gone with it.
  member.revokePin(PEER);
  removed.hangUp();
  leavesSfu(removed, [member]);
  await until(
    t,
    watches,
    () => removalsOf(fleet, PEER_ID, from).length > 0,
    RECONCILE_INTERVAL_MS + LEAVE_GRACE_MS + ADMIT_STAGGER_MS,
    "the Remove of the removed device's leaf",
  );
  await run(t, SETTLE_MS, watches);

  assert.deepEqual(
    groupSubmits(fleet, from),
    [[SELF_ID, "remove", epoch + 1, "won"]],
    "the member staged exactly one Remove, and it won",
  );
  assert.deepEqual(
    fleet.ds.commitAt(GROUP, epoch + 1)?.removed.map(identityOf),
    [PEER_ID],
  );
  assert.ok(
    count(logs, removing(PEER_ID)) > 0,
    "the removal was not logged as a revoked leaf",
  );
  assertConverged(fleet, [member]);
  assertGreen(member);

  // The same user's re-enrolled device joins and is admitted.
  await joinCall(t, renewed, [member], watches);
  await run(t, SETTLE_MS, watches);
  assert.deepEqual(groupSubmits(fleet, from), [
    [SELF_ID, "remove", epoch + 1, "won"],
    [SELF_ID, "admit", epoch + 2, "won"],
  ]);
  assert.deepEqual(addsOf(fleet, PEER_NEW_ID, from), [`${GROUP}@${epoch + 2}`]);
  assertConverged(fleet, [member, renewed]);
  assertGreen(member);
  assertGreen(renewed);
  assert.deepEqual(member.loudSince(louds), [], "the member went loud");
  assertNoPlaintext(watches);
});

// ---- 2. Still connected ----------------------------------------------------

test("2 — a removed device that stays connected is still removed: the next epoch's keys leave it out, it reads non-enrolled once its admit-grace ends, and the member is never green with it", async (t) => {
  const logs = captureConsole(t);
  const fleet = newFleet(t, [SELF, PEER], "ch-rl-2");
  const [member, removed] = fleet.seats;
  const watches = fleet.seats.map(watch);
  await callOf(t, fleet, fleet.seats, watches);
  const from = fleet.ds.submits.length;
  const epoch = fleet.ds.epoch;

  // The pin flips, and the device's client stops answering, but its SFU
  // connection stays up: nothing ever reports it gone, so no leave-grace
  // runs, and it can never enrol again.
  member.revokePin(PEER);
  removed.pageDeath();
  await until(
    t,
    watches,
    () => removalsOf(fleet, PEER_ID, from).length > 0,
    RECONCILE_INTERVAL_MS + ADMIT_STAGGER_MS + STEP_MS,
    "the Remove of the connected device's leaf",
  );
  const removedAt = Date.now();
  assert.ok(member.sfu.includes(PEER_ID), "the device left the SFU");
  assert.deepEqual(groupSubmits(fleet, from), [
    [SELF_ID, "remove", epoch + 1, "won"],
  ]);
  assert.ok(count(logs, removing(PEER_ID)) > 0, "no revoked-leaf log line");

  // From here to the end: when the device first reads non-enrolled, whether
  // the member was green with it after that, and whether its leaf ever came
  // back on either side.
  const seen: { unenrolledAt: number | null } = { unenrolledAt: null };
  const greenWithIt: number[] = [];
  const readded: number[] = [];
  const sample = () => {
    const now = Date.now();
    if (
      seen.unenrolledAt === null &&
      member.session.nonEnrolled().includes(PEER_ID)
    ) {
      seen.unenrolledAt = now;
    }
    if (seen.unenrolledAt !== null && member.chip() === "e2ee") {
      greenWithIt.push(now);
    }
    if (member.localRoster.some((m) => identityOf(m) === PEER_ID)) {
      readded.push(now);
    }
  };
  await run(t, ADMIT_GRACE_MAX_MS + 2 * RECONCILE_INTERVAL_MS, watches, sample);

  // The next epoch's keys, and every later read, leave the device out.
  const [w] = watches;
  const later = w.keys.filter((k) => k.epoch > epoch);
  assert.ok(later.length > 0, "the member installed no key after the Remove");
  for (const k of later) {
    assert.ok(
      !k.identities.includes(PEER_ID),
      `the epoch ${k.epoch} keys still carry the removed device`,
    );
  }
  assert.equal(member.native.lastKeys?.[0]?.epoch, epoch + 1);

  // Non-enrolled once its admit-grace ran out, and never green with it.
  const { unenrolledAt } = seen;
  assert.ok(unenrolledAt !== null, "the device never read non-enrolled");
  assert.ok(
    unenrolledAt - removedAt <= ADMIT_GRACE_MAX_MS + RECONCILE_INTERVAL_MS,
    `the device read non-enrolled ${unenrolledAt - removedAt} ms after the ` +
      `Remove, past its admit-grace`,
  );
  assert.deepEqual(greenWithIt, [], "the member read green with it connected");
  assert.deepEqual(readded, [], "its leaf came back into the member's roster");
  assert.deepEqual(addsOf(fleet, PEER_ID, from), [], "the DS re-added it");
  assert.deepEqual(member.session.nonEnrolled(), [PEER_ID]);
  assert.equal(member.publishing(), false, "the member's media is not held");
  assert.deepEqual(fleet.ds.members.map(identityOf), [SELF_ID]);
  assertNoPlaintext(watches);
});

// ---- 3. Unpinned, not removed ----------------------------------------------

test("3 — a leaf the member has no pin for yet is re-pinned through its listing and never removed: the call stays green and never goes red", async (t) => {
  const logs = captureConsole(t);
  const fleet = newFleet(t, [SELF, PEER], "ch-rl-3");
  const [member, peer] = fleet.seats;
  const watches = fleet.seats.map(watch);
  await callOf(t, fleet, fleet.seats, watches);
  const from = fleet.ds.submits.length;
  const mark = member.bridgeCalls.length;
  const louds = member.states.length;

  const chips = new Set<string>();
  let banner = false;
  const sample = () => {
    chips.add(member.chip());
    if (member.terminalLoud()) banner = true;
  };
  member.unpinPeer(PEER);
  // Four ticks: past `REPIN_PERSIST_TICKS` (2) after the listing reconcile,
  // the bound at which a leaf still refused would replace the group.
  await run(t, 4 * RECONCILE_INTERVAL_MS, watches, sample);

  const calls = member.bridgeCalls.slice(mark);
  assert.ok(
    calls.includes("reconcileCallRoster"),
    "the member never fetched the listing to pin the leaf",
  );
  assert.equal(count(calls, "callRemove"), 0, "the member staged a Remove");
  assert.deepEqual(groupSubmits(fleet, from), [], "a commit was submitted");
  assert.equal(count(logs, removing(PEER_ID)), 0, "logged as a revoked leaf");
  assert.equal(count(calls, "callCreate"), 0, "the group was replaced");
  assert.deepEqual(member.loudSince(louds), [], "the member went loud");
  assert.equal(banner, false, "a red banner came up");
  assert.ok(
    !chips.has("not_encrypted") && !chips.has("cannot_verify"),
    `the chip went red (${[...chips]})`,
  );
  assertConverged(fleet, [member, peer]);
  assertGreen(member);
  assertGreen(peer);
  assert.deepEqual(member.session.nonEnrolled(), []);
  assertNoPlaintext(watches);
});

// ---- 4. No veto --------------------------------------------------------------

test("4 — a removable verdict on a peer whose device is live, connected, green and listed still removes it: nothing but the member's own verdict decides", async (t) => {
  const logs = captureConsole(t);
  const fleet = newFleet(t, [SELF, PEER], "ch-rl-4");
  const [member, peer] = fleet.seats;
  const watches = fleet.seats.map(watch);
  await callOf(t, fleet, fleet.seats, watches);
  const from = fleet.ds.submits.length;
  const epoch = fleet.ds.epoch;

  // Only the member's pin flips. The peer's client keeps running and stays
  // on the SFU, and its listing still answers: this harness's listing
  // reconcile resolves for every device it is asked about. None of that may
  // hold the Remove back.
  member.revokePin(PEER);
  const peerBefore: string[] = [];
  await until(
    t,
    watches,
    () => removalsOf(fleet, PEER_ID, from).length > 0,
    RECONCILE_INTERVAL_MS + ADMIT_STAGGER_MS + STEP_MS,
    "the Remove of the live peer's leaf",
    () => {
      if (removalsOf(fleet, PEER_ID, from).length === 0) {
        peerBefore.push(`${peer.session.state()}/${peer.chip()}`);
      }
    },
  );
  assert.deepEqual(
    [...new Set(peerBefore)],
    ["active/e2ee"],
    "the peer was not live and green up to the Remove",
  );
  assert.ok(member.sfu.includes(PEER_ID), "the peer left the SFU");
  assert.deepEqual(groupSubmits(fleet, from), [
    [SELF_ID, "remove", epoch + 1, "won"],
  ]);
  assert.ok(count(logs, removing(PEER_ID)) > 0, "no revoked-leaf log line");

  await run(t, SETTLE_MS, watches);
  const [w] = watches;
  const next = w.keys.filter((k) => k.epoch === epoch + 1);
  assert.ok(next.length > 0, "the member installed no key for the Remove");
  for (const k of next) {
    assert.deepEqual(k.identities, [SELF_ID], "the Remove's keys");
  }
  assertNoPlaintext(watches);
});

// ---- 5. Another commit first -----------------------------------------------

test("5 — another member's Add reaching the member before its Remove poisons the member's row; the successor it opens leaves the removed device out, with no plaintext window", async (t) => {
  const logs = captureConsole(t);
  const channel = "ch-rl-5";
  const fleet = newFleet(t, [THIRD, SELF, PEER, DAVE], channel);
  const [admitter, member, removed, joiner] = fleet.seats;
  const watches = fleet.seats.map(watch);
  await callOf(t, fleet, [admitter, member, removed], watches);
  // The removed device's client stops and it stays connected: with no
  // identity left it can enrol in nothing, so no seat hears from it again.
  removed.pageDeath();
  // A whole reconcile interval of headroom before the member's next tick.
  await afterReconcileTick(t, member, watches);
  const from = fleet.ds.submits.length;
  const epoch = fleet.ds.epoch;

  // Only the member's pin flips; the admitter's stays active. A fourth
  // device joins at once. The admitter is leaf 0 and admits on a 0 ms
  // stagger; the member's Remove waits out its own (leaf 1 with the target
  // left out), so the admitter's Add reaches it first.
  member.revokePin(PEER);
  joiner.sfu = [...joiner.sfu, DAVE_ID];
  joiner.sids.set(DAVE_ID, [`TR_${DAVE.device_id}`]);
  admitter.session.onParticipantJoined(DAVE_ID);
  member.session.onParticipantJoined(DAVE_ID);
  void joiner.session.start();
  await flush();

  // Every step that ended with the member still on the old group after its
  // row poisoned. The drain only SCHEDULES the successor (a group action, on
  // the next timer turn), so the step the poison landed in can end there;
  // no later one may.
  const onPoisoned: number[] = [];
  const sample = () => {
    if (
      member.localGroups.get(GROUP)?.state === "poisoned" &&
      member.session.groupId() === GROUP
    ) {
      onPoisoned.push(Date.now());
    }
  };
  await until(
    t,
    watches,
    () =>
      fleet.ds.groupId !== GROUP &&
      member.session.groupId() === fleet.ds.groupId &&
      member.session.state() === "active",
    JOIN_BOUND_MS,
    "the member's successor going active",
    sample,
  );
  await run(t, SETTLE_MS, watches, sample);

  // The admitter's Add came first, and no Remove of the device ever won in
  // the old group.
  const old = groupSubmits(fleet, from).filter(([, , , o]) => o === "won");
  assert.deepEqual(old[0], [THIRD_ID, "admit", epoch + 1, "won"]);
  assert.deepEqual(fleet.ds.commitAt(GROUP, epoch + 1)?.added.map(identityOf), [
    DAVE_ID,
  ]);
  assert.deepEqual(removalsOf(fleet, PEER_ID, from), []);
  assert.ok(
    count(logs, `${RESECURING} ${POISONED}`) > 0,
    "the member never took the poisoned-epoch successor path",
  );
  assert.ok(
    onPoisoned.length <= 1,
    `the member stayed on its poisoned group for ${onPoisoned.length} ` +
      `steps of ${STEP_MS} ms`,
  );

  // The successor: the DS closed the old group, and the device is not in
  // the new one, on the DS or in any key the member has read for it.
  const successor = fleet.ds.groupId;
  assert.ok(successor !== null && successor !== GROUP, "no successor");
  assert.equal(fleet.ds.openGroup(channel), successor, "the old group is open");
  assert.deepEqual(groupSubmits(fleet, from, successor)[0], [
    SELF_ID,
    "create",
    0,
    "won",
  ]);
  assert.ok(
    !fleet.ds.members.some((m) => identityOf(m) === PEER_ID),
    "the successor holds the removed device",
  );
  const [, w] = watches;
  const successorKeys = w.keys.filter((k) =>
    k.key.startsWith(`key-${successor}-`),
  );
  assert.ok(successorKeys.length > 0, "the member read no successor key");
  for (const k of successorKeys) {
    assert.ok(!k.identities.includes(PEER_ID), "a successor key carries it");
  }
  assertNoPlaintext(watches);
});

// ---- 6. Divergent pins -------------------------------------------------------

// The member that refuses the device removes it; the device asks back in and
// a member that still trusts it re-admits it; that Add poisons the refusing
// member's row and it opens a successor. Nothing tells the other two the old
// group closed, so they stay on it and the refusing member stays alone in
// its successor. (A re-admit like this needs a fresh signed intent from the
// device, which a device whose identity is gone cannot send.) The member
// that is split off must hold its media and never read green; nobody
// publishes plaintext; and the churn stops.

test("6 — a divergent re-admit leaves the refusing member held, never plaintext, never looping", async (t) => {
  captureConsole(t);
  const fleet = newFleet(t, [THIRD, SELF, PEER], "ch-rl-6");
  const [admitter, member, device] = fleet.seats;
  const watches = fleet.seats.map(watch);
  await callOf(t, fleet, fleet.seats, watches);
  const from = fleet.ds.submits.length;
  const mark = member.bridgeCalls.length;

  /** Both groups as each seat holds them, for every failure message. */
  const groups = () =>
    `the member reads ${member.session.callMode().kind} / ${member.chip()} ` +
    `on ${member.session.groupId()}; ` +
    [admitter, device]
      .map(
        (w) =>
          `${identityOf(w.me)} reads ${w.session.callMode().kind} / ` +
          `${w.chip()} on ${w.session.groupId()}`,
      )
      .join(", ") +
    ` (open: ${fleet.ds.openGroup(member.channelId)})`;

  // Every step at which the member held a group the others did not, and
  // what it read and did there.
  const split: string[] = [];
  const openWhileSplit: string[] = [];
  const sample = () => {
    const own = member.session.groupId();
    if (own === null) return;
    if (own === admitter.session.groupId()) return;
    if (own === device.session.groupId()) return;
    split.push(own);
    if (member.chip() === "e2ee" || member.publishing()) {
      openWhileSplit.push(`t=${Date.now()}: ${groups()}`);
    }
  };

  // Only the member's pin flips. The device's client is live and asks back
  // in when it loses its leaf, and the admitter's pin for it is active.
  member.revokePin(PEER);
  await run(t, 5 * 60_000, watches, sample);
  const settled = fleet.ds.submits.length;
  // Long enough past the last commit to show it stays settled.
  await run(t, 2 * 60_000, watches, sample);

  // The divergence happened: the member removed the device, and the
  // admitter let it back in.
  assert.ok(
    removalsOf(fleet, PEER_ID, from).length > 0,
    `the member never removed the device: ${groups()}`,
  );
  assert.ok(
    addsOf(fleet, PEER_ID, from).length > 0,
    `no member re-admitted the device: ${groups()}`,
  );

  // (a) The churn stops, within the re-establish limit.
  assert.equal(
    fleet.ds.submits.length,
    settled,
    `the churn was still going after five minutes: ${groups()}`,
  );
  const successors = count(member.bridgeCalls.slice(mark), "callCreate");
  assert.ok(
    successors >= 1 && successors <= MAX_REESTABLISH,
    `the member opened ${successors} successor group(s): ${groups()}`,
  );

  // (b) Split off, the member is held and never green.
  assert.ok(split.length > 0, `the member was never split off: ${groups()}`);
  assert.deepEqual(
    openWhileSplit,
    [],
    "the member read green or published while split off",
  );
  assert.equal(
    member.publishing(),
    false,
    `the member's media is not held: ${groups()}`,
  );
  assert.ok(
    member.session.callMode().kind === "mixed" || member.terminalLoud(),
    `the member is neither mixed nor loud: ${groups()}`,
  );
  assert.notEqual(member.chip(), "e2ee", `the member reads green: ${groups()}`);

  // (c) and (d): no seat ever published outside `e2ee`, the member above
  // all, so the other two were never sent plaintext by it.
  assertNoPlaintext(watches);
});

// ---- 7. Our own device -------------------------------------------------------

test("7 — this device's own removal mid-call ends its call with the notice, drops its group and resume record, and never rejoins on that identity", async (t) => {
  captureConsole(t);
  const channel = "ch-rl-7";
  const fleet = newFleet(t, [SELF, PEER], channel);
  const [member, device] = fleet.seats;
  const watches = fleet.seats.map(watch);
  await callOf(t, fleet, fleet.seats, watches);
  await afterReconcileTick(t, device, watches);
  assert.equal(
    readResumeRecord(device.sessionStorage, channel)?.groupId,
    GROUP,
    "no resume record to drop",
  );
  const mark = device.bridgeCalls.length;
  const memberMark = member.bridgeCalls.length;

  device.emitDeviceRevoked(PEER.user_id, PEER.device_id, true);
  await flush();
  await run(t, 60_000, watches);

  assert.deepEqual(device.autoLeaves, [OWN_REMOVAL_NOTICE]);
  assert.equal(device.session.state(), "closed", "the call did not end");
  assert.equal(device.session.groupId(), null);
  assert.ok(device.leaveCleanups.includes(GROUP), "the group was not wiped");
  assert.equal(device.localGroups.has(GROUP), false, "native kept the row");
  assert.equal(
    readResumeRecord(device.sessionStorage, channel),
    null,
    "the resume record survived",
  );
  const calls = device.bridgeCalls.slice(mark);
  for (const ladder of [
    "callCreate",
    "mlsCreateGroup",
    "callJoinIntent",
    "mlsJoinIntent",
    "keepLocalGroup",
  ]) {
    assert.equal(count(calls, ladder), 0, `the device called ${ladder}`);
  }
  const memberCalls = member.bridgeCalls.slice(memberMark);
  assert.equal(count(memberCalls, "callAdmit"), 0, "the member re-admitted");
  assertNoPlaintext(watches);
});

// ---- 8. Every reader goes through the classifier -----------------------------
//
// Native refuses the roster read at every `callState` site alike, so a site
// that read the bridge directly would see the refusal and never hand it to
// the classifier. Two sites are reachable alone, each with a bound only that site can
// meet: the periodic reconcile (8a: nothing else reads the state, and the
// Remove follows the next tick) and the admit path's first read in
// `#onJoinRequest` (8b: the Remove is staged before the next tick). The
// leave-grace read (`#removeMember`) cannot be isolated: its 10 s grace
// always outlasts a 5 s tick, so case 1 covers it only together with the
// tick. The heartbeat (10 min), rejoin serves, resume and Welcome currency
// reads are not exercised here.

test("8a — the reconcile tick alone reaches the removal: nothing else reads the group's state, and the Remove follows the member's next tick", async (t) => {
  const logs = captureConsole(t);
  const fleet = newFleet(t, [SELF, PEER], "ch-rl-8a");
  const [member, removed] = fleet.seats;
  const watches = fleet.seats.map(watch);
  await callOf(t, fleet, fleet.seats, watches);
  // Connected, so no leave-grace; silent, so no join request or serve.
  removed.pageDeath();
  await afterReconcileTick(t, member, watches);
  const from = fleet.ds.submits.length;
  const mark = member.bridgeCalls.length;

  member.revokePin(PEER);
  const took = await until(
    t,
    watches,
    () => removalsOf(fleet, PEER_ID, from).length > 0,
    RECONCILE_INTERVAL_MS + ADMIT_STAGGER_MS,
    "the Remove from the reconcile tick",
  );

  assert.ok(
    took >= RECONCILE_INTERVAL_MS - STEP_MS,
    `the Remove landed ${took} ms after the flip, before the next tick`,
  );
  const calls = member.bridgeCalls.slice(mark);
  const tick = calls.indexOf("touchResumeRecord");
  const staged = calls.indexOf("callRemove");
  assert.ok(tick >= 0, "no reconcile tick ran");
  assert.ok(staged > tick, "the Remove was staged before the tick");
  for (const admit of [
    "callVerifyJoinIntent",
    "mlsClaimKeyPackage",
    "callAdmit",
  ]) {
    assert.equal(count(calls, admit), 0, `the member called ${admit}`);
  }
  assert.ok(member.sfu.includes(PEER_ID), "the device left the SFU");
  assert.ok(count(logs, removing(PEER_ID)) > 0, "no revoked-leaf log line");
  assertNoPlaintext(watches);
});

test("8b — the admit path alone reaches the removal: a join request read before the next tick stages the Remove, and the joiner is then admitted", async (t) => {
  const logs = captureConsole(t);
  const fleet = newFleet(t, [SELF, PEER, THIRD], "ch-rl-8b");
  const [member, removed, joiner] = fleet.seats;
  const watches = fleet.seats.map(watch);
  await callOf(t, fleet, [member, removed], watches);
  removed.pageDeath();
  await afterReconcileTick(t, member, watches);
  const from = fleet.ds.submits.length;
  const epoch = fleet.ds.epoch;
  const mark = member.bridgeCalls.length;

  // The joiner connects and starts, and its intent reaches the member. The
  // member's own SFU join event for it is held back until after the Remove:
  // that hook runs a reconcile at once (`onParticipantJoined` →
  // `reconcileNow`), which would reach the removal through the reconcile
  // read instead and prove nothing about this one. LiveKit surfacing a
  // participant after its intent has landed is an ordering the session
  // already allows for (`#reconcileRoster`).
  member.revokePin(PEER);
  joiner.sfu = [...joiner.sfu, THIRD_ID];
  joiner.sids.set(THIRD_ID, [`TR_${THIRD.device_id}`]);
  void joiner.session.start();
  await flush();
  await until(
    t,
    watches,
    () => removalsOf(fleet, PEER_ID, from).length > 0,
    ADMIT_STAGGER_MS,
    "the Remove from the admit path",
  );

  const calls = member.bridgeCalls.slice(mark);
  const staged = calls.indexOf("callRemove");
  assert.ok(staged >= 0, "no Remove was staged");
  assert.equal(
    calls.slice(0, staged).includes("touchResumeRecord"),
    false,
    "a reconcile tick ran before the Remove was staged",
  );
  assert.ok(count(logs, removing(PEER_ID)) > 0, "no revoked-leaf log line");

  // The read that found the leaf did not cost the joiner its admission.
  member.session.onParticipantJoined(THIRD_ID);
  await until(
    t,
    watches,
    () => joiner.session.state() === "active",
    JOIN_BOUND_MS,
    "the joiner going active",
  );
  await run(t, SETTLE_MS, watches);
  assert.deepEqual(groupSubmits(fleet, from), [
    [SELF_ID, "remove", epoch + 1, "won"],
    [SELF_ID, "admit", epoch + 2, "won"],
  ]);
  assertConverged(fleet, [member, joiner]);
  // The removed device is still on the SFU and enrolled in nothing, so both
  // hold their media against it (case 2). Once its connection drops, the
  // two of them are green again after the re-upgrade hysteresis.
  leavesSfu(removed, [member, joiner]);
  await run(t, REUPGRADE_HYSTERESIS_MS + 2 * RECONCILE_INTERVAL_MS, watches);
  assertConverged(fleet, [member, joiner]);
  assertGreen(member);
  assertGreen(joiner);
  assertNoPlaintext(watches);
});

// ---- 9. A listing that never pins --------------------------------------------
//
// Case 3's leaf is pinned by its first listing fetch. Here every fetch the
// member makes for it first fails outright (the bridge throws, as it does for
// a listing still unanswered after its retry, a 429 among them), and then
// arrives without the device (it resolves and pins nothing, as the bridge
// does for a listing that omits the device or does not verify). A failed
// fetch starts no clock. The clock starts at the first fetch that succeeded
// and advances only on the member's periodic reconcile tick, so a burst of
// event-driven reconciles inside one interval does not move it. Once the leaf
// has outlasted `REPIN_PERSIST_TICKS` ticks, the member replaces the group,
// once, and the successor leaves the device out.

test("9 — a listing that never pins escalates once to a successor, bounded and held, never plaintext", async (t) => {
  const logs = captureConsole(t);
  const bridges = scriptBridges(t);
  const fleet = newFleet(t, [SELF, PEER], "ch-rl-9");
  const [member, peer] = fleet.seats;
  const watches = fleet.seats.map(watch);
  await callOf(t, fleet, fleet.seats, watches);
  // Connected and silent, as in 8a: no leave-grace, no join request.
  peer.pageDeath();
  await afterReconcileTick(t, member, watches);
  const from = fleet.ds.submits.length;
  const mark = member.bridgeCalls.length;
  const louds = member.states.length;
  const replaced = `[mls] replacing the call group: ${PEER_ID} could not be pinned`;
  /** The member's periodic ticks since `mark` (each refreshes the record). */
  const ticks = () =>
    count(member.bridgeCalls.slice(mark), "touchResumeRecord");

  // Every listing fetch the member makes from here on, and how it answered.
  type Answer = "fails" | "omits";
  let listing: Answer = "fails";
  const fetches: { at: number; answer: Answer; asked: string[] }[] = [];
  bridges.script(member, {
    reconcileCallRoster: async (roster) => {
      fetches.push({
        at: Date.now(),
        answer: listing,
        asked: roster.flatMap((r) =>
          r.deviceIds.map((d) => `${r.userId}:${d}`),
        ),
      });
      if (listing === "fails") {
        throw new Error("call roster reconcile: 1 of 1 listings not fetched");
      }
      return [];
    },
  });

  // An event-driven reconcile, as the Room's hooks run one: the SFU join
  // hook, and a publication's (`trackPublished` calls `reconcileNow`).
  let events = 0;
  const event = () => {
    events++;
    if (events % 2) member.session.onParticipantJoined(PEER_ID);
    else void member.session.reconcileNow();
  };

  // (a) The fetches fail: three intervals of them, with an event-driven
  // reconcile on every step. Nothing is replaced, and the listing is fetched
  // again on each tick, never more than once a tick.
  member.unpinPeer(PEER);
  event();
  await run(t, 3 * RECONCILE_INTERVAL_MS, watches, event);
  assert.ok(
    fetches.length >= 3,
    `the listing was fetched ${fetches.length} time(s) in three intervals`,
  );
  assert.ok(
    fetches.length <= 1 + ticks(),
    `${fetches.length} fetches over ${ticks()} periodic ticks`,
  );
  assert.equal(count(logs, replaced), 0, "a failed fetch started the clock");
  assert.equal(count(member.bridgeCalls.slice(mark), "callCreate"), 0);
  assert.equal(member.session.groupId(), GROUP);

  // (b) The fetches succeed and pin nothing. The first one, on the next
  // tick, starts the clock.
  listing = "omits";
  const first = fetches.length;
  await until(
    t,
    watches,
    () => fetches.length > first,
    RECONCILE_INTERVAL_MS + STEP_MS,
    "a listing fetch on the next tick",
  );
  const clockStart = fetches[first].at;

  // A burst inside the first interval: an event-driven reconcile on every
  // step, each one a roster read refused on the same leaf.
  const reads = count(member.bridgeCalls.slice(mark), "callState");
  await run(t, RECONCILE_INTERVAL_MS - 2 * STEP_MS, watches, event);
  const burst = count(member.bridgeCalls.slice(mark), "callState") - reads;
  assert.ok(
    burst > 2 * REPIN_PERSIST_TICKS,
    `the burst made only ${burst} roster read(s)`,
  );
  assert.equal(
    count(logs, replaced),
    0,
    `${burst} event-driven reconciles replaced the group inside one interval`,
  );
  assert.equal(member.session.groupId(), GROUP);
  assert.deepEqual(member.loudSince(louds), [], "the member went loud");

  // The replacement follows the `REPIN_PERSIST_TICKS`-th tick after the
  // clock started, not before.
  await until(
    t,
    watches,
    () => count(logs, replaced) > 0,
    REPIN_PERSIST_TICKS * RECONCILE_INTERVAL_MS,
    "the group's replacement",
  );
  const after = Date.now() - clockStart;
  assert.ok(
    after >= REPIN_PERSIST_TICKS * RECONCILE_INTERVAL_MS - STEP_MS,
    `the group was replaced ${after} ms after the clock started`,
  );
  await until(
    t,
    watches,
    () =>
      fleet.ds.groupId !== GROUP &&
      member.session.groupId() === fleet.ds.groupId &&
      member.session.state() === "active",
    JOIN_BOUND_MS,
    "the member's successor going active",
  );
  // Past the device's admit-grace in the successor, where it sits on the
  // SFU and enrolled in nothing.
  await run(t, ADMIT_GRACE_MAX_MS + 2 * RECONCILE_INTERVAL_MS, watches);

  const calls = member.bridgeCalls.slice(mark);
  assert.equal(count(logs, replaced), 1, "the group was replaced again");
  assert.equal(count(calls, "callCreate"), 1, "more than one successor");
  assert.deepEqual(fleet.ds.members.map(identityOf), [SELF_ID]);
  assert.deepEqual(removalsOf(fleet, PEER_ID, from), [], "a Remove of it won");
  assert.equal(count(logs, removing(PEER_ID)), 0, "logged as a revoked leaf");
  for (const fetch of fetches) {
    assert.ok(fetch.asked.includes(PEER_ID), "a fetch left the device out");
  }
  assert.equal(member.publishing(), false, "the member's media is not held");
  assert.notEqual(member.chip(), "e2ee", "the member reads green");
  assert.ok(
    member.session.callMode().kind === "mixed" || member.terminalLoud(),
    `the member is ${member.session.callMode().kind} and not loud`,
  );
  assertNoPlaintext(watches);
});

// ---- 10. A Remove that does not take -------------------------------------------
//
// Native cannot stage the member's Remove of the leaf: each attempt answers as
// for a leaf it cannot locate (`mls_group_not_found`, which the session takes
// as a no-op), so nothing is submitted and the leaf stays. The first failure
// is counted, the next refusal tries again, and the second failure replaces
// the group, once.

test("10 — a Remove that fails twice escalates once: the successor leaves the device out and the member holds its media, never plaintext", async (t) => {
  const logs = captureConsole(t);
  const bridges = scriptBridges(t);
  const fleet = newFleet(t, [SELF, PEER], "ch-rl-10");
  const [member, removed] = fleet.seats;
  const watches = fleet.seats.map(watch);
  await callOf(t, fleet, fleet.seats, watches);
  removed.pageDeath();
  await afterReconcileTick(t, member, watches);
  const from = fleet.ds.submits.length;
  const mark = member.bridgeCalls.length;
  const replaced = `[mls] replacing the call group: ${PEER_ID} could not be removed`;

  const fakes = bridges.fakes(member);
  const attempts: number[] = [];
  bridges.script(member, {
    callRemove: async (groupId, userId, deviceId) => {
      if (`${userId}:${deviceId}` !== PEER_ID) {
        return fakes.callRemove(groupId, userId, deviceId);
      }
      attempts.push(Date.now());
      throw groupNotFound(groupId);
    },
  });

  member.revokePin(PEER);
  // Every step's Remove attempts and group, up to the replacement.
  const before: string[] = [];
  await until(
    t,
    watches,
    () => count(logs, replaced) > 0,
    MAX_LEAF_REMOVE_FAILURES * RECONCILE_INTERVAL_MS + ADMIT_STAGGER_MS,
    "the group's replacement",
    () => {
      if (count(logs, replaced) === 0) {
        before.push(`${attempts.length}@${member.session.groupId()}`);
      }
    },
  );
  assert.equal(
    attempts.length,
    MAX_LEAF_REMOVE_FAILURES,
    "the group was replaced after the wrong number of failed Removes",
  );
  assert.ok(
    before.includes(`1@${GROUP}`),
    "the member never stayed on its group after the first failed Remove",
  );
  assert.ok(count(logs, removing(PEER_ID)) >= MAX_LEAF_REMOVE_FAILURES);

  await until(
    t,
    watches,
    () =>
      fleet.ds.groupId !== GROUP &&
      member.session.groupId() === fleet.ds.groupId &&
      member.session.state() === "active",
    JOIN_BOUND_MS,
    "the member's successor going active",
  );
  await run(t, ADMIT_GRACE_MAX_MS + 2 * RECONCILE_INTERVAL_MS, watches);

  const calls = member.bridgeCalls.slice(mark);
  assert.equal(count(logs, replaced), 1, "the group was replaced again");
  assert.equal(count(calls, "callCreate"), 1, "more than one successor");
  assert.equal(attempts.length, MAX_LEAF_REMOVE_FAILURES, "Removes went on");
  assert.deepEqual(
    groupSubmits(fleet, from),
    [],
    "the old group took a commit",
  );
  assert.deepEqual(fleet.ds.members.map(identityOf), [SELF_ID]);
  assert.equal(member.publishing(), false, "the member's media is not held");
  assert.notEqual(member.chip(), "e2ee", "the member reads green");
  assert.ok(
    member.session.callMode().kind === "mixed" || member.terminalLoud(),
    `the member is ${member.session.callMode().kind} and not loud`,
  );
  assertNoPlaintext(watches);
});
