// Session-level specs for decode missing keys heard in the WELCOME WINDOW —
// before this device holds any key of the group — on the shared world in
// `mlsCallSession.harness.ts`.
//   node --test --conditions=browser components/rtc/mlsCallSession.welcomedrop.test.ts
//
// The gap these pin (plan section 3.3, Wave J, audit minor 4): such an error
// used to be logged at the first install and then forgotten. A sender that
// advanced past the epoch we were admitted into while we joined, with the
// commit that would give us its key withheld, is dropped by the worker
// silently from then on (one error per index, then nothing), so the call
// could sit green or amber over a peer nobody can hear.
//
// The fix gives those misses the join-race hold's bounded verdict once the
// window closes, and exempts exactly one shape: an index from one of the
// epochs BEFORE the one this device first held. That is the ordinary
// Welcome (members keep sending at E-1 through their Add-grace), which no
// install will ever fill; a bounded verdict there would be a guaranteed
// false red on every join.
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import {
  type World,
  advance,
  bringUpJoiner,
  flush,
  GROUP,
  JOIN_RACE_DEFER_MS,
  newWorld,
  PEER_ID,
  THIRD_ID,
} from "./mlsCallSession.harness.ts";

// Loaded only after the harness: its resolve hook is what lets Node load the
// policy's extensionless sibling imports. The discriminator lives there (one
// source of truth for the session's review and the ledger's heal witness).
const policyModule = await import("./mlsCallModePolicy.ts");

/** The pure discriminator, read through the namespace so a missing export fails one spec, not the file. */
function predates(keyIndex: number, heldEpoch: number): boolean {
  const fn = (
    policyModule as unknown as {
      joinWindowMissPredatesEpoch?: (i: number, e: number) => boolean;
    }
  ).joinWindowMissPredatesEpoch;
  assert.equal(typeof fn, "function", "joinWindowMissPredatesEpoch missing");
  return fn!(keyIndex, heldEpoch);
}

/** A joiner whose pre-Welcome window heard `errors`, then Welcomed at `epoch`. */
async function joinAfterMisses(
  t: TestContext,
  world: World,
  epoch: number,
  errors: Error[],
): Promise<void> {
  await bringUpJoiner(t, world, epoch, () => {
    for (const error of errors) world.session.noteEncryptionError(error);
  });
}

// ---- the repro: a sender AHEAD of the held epoch ----------------------------

test("🔴 a Welcome-window miss at an index past the held epoch is counted once the window closes", async (t) => {
  // Welcomed at 5; the peer is already at 6 and the commit for 6 never
  // reaches us. Before the fix this logged a warning and nothing else: no
  // hold, no deadline, no red, ever.
  const world = newWorld(t, "joiner", "ch-wd-ahead");
  const error = world.missingKey(PEER_ID, 6);
  await joinAfterMisses(t, world, 5, [error]);

  // The amber never drops between the joiner escalation and the hold: one
  // `true` edge, no `false` in between (the chip reads every edge).
  assert.deepEqual(world.holds, [true], "the window's amber was withdrawn");

  await advance(t, JOIN_RACE_DEFER_MS - 1_000);
  assert.deepEqual(world.loudSince(0), [], "it latched before its bound");
  await advance(t, 2_000);
  assert.deepEqual(
    world.loudSince(0),
    [{ state: "loud", error }],
    "a withheld commit at join stayed silent past the bound",
  );
  assert.equal(world.session.callMode().kind, "negotiating");
});

test("🔴 the counted miss is answered when our copy of that commit lands inside the bound", async (t) => {
  // The honest half: a sender that merely moved on while we joined is
  // answered by the commit's install, so the count is not a guaranteed red.
  const world = newWorld(t, "joiner", "ch-wd-answered");
  await joinAfterMisses(t, world, 5, [world.missingKey(PEER_ID, 6)]);
  assert.deepEqual(world.holds, [true]);

  await advance(t, 1_000);
  await world.commit(6); // fills index 6 for every sender
  assert.deepEqual(world.holds, [true, false], "the hold never resolved");
  await advance(t, JOIN_RACE_DEFER_MS * 2);
  assert.deepEqual(world.loudSince(0), []);
  assert.equal(world.session.callMode().kind, "e2ee");
});

test("🔴 past the 16-slot wrap: Welcomed at 20, a miss seven epochs ahead (index 11) still counts", async (t) => {
  const world = newWorld(t, "joiner", "ch-wd-wrap-ahead");
  const error = world.missingKey(PEER_ID, 27);
  await joinAfterMisses(t, world, 20, [error]);
  assert.deepEqual(world.holds, [true]);
  await advance(t, JOIN_RACE_DEFER_MS + 1_000);
  assert.deepEqual(world.loudSince(0), [{ state: "loud", error }]);
});

test("🔴 early in a group: Welcomed at 1, an index no earlier epoch could have used still counts", async (t) => {
  // Index 9 cannot be epoch -7: below epoch 0 there is nothing to predate.
  const world = newWorld(t, "joiner", "ch-wd-early");
  const error = new Error(
    `MissingKey: missing key at index 9 for participant ${PEER_ID}`,
  );
  await joinAfterMisses(t, world, 1, [error]);
  await advance(t, JOIN_RACE_DEFER_MS + 1_000);
  assert.deepEqual(world.loudSince(0), [{ state: "loud", error }]);
});

test("🔴 a binding that cannot render the amber takes the strict verdict as the window closes", async (t) => {
  // Same fail-closed rule as `#holdJoinRace` everywhere else: a deferral the
  // chip cannot show is an invisible green.
  const world = newWorld(t, "joiner", "ch-wd-nohold", (w) => {
    w.holdsSupported = false;
  });
  const error = world.missingKey(PEER_ID, 6);
  void world.session.start();
  await flush();
  await advance(t, 1);
  world.session.noteEncryptionError(error);
  await world.welcome(5);
  await world.session.onLocalKeysChanged(GROUP, 5);
  await flush();
  assert.deepEqual(world.loudSince(0), [{ state: "loud", error }]);
});

// ---- the false-red controls: frames from BEFORE the held epoch -------------

test("false-red control: the Add-grace frames at E-1 never count", async (t) => {
  // Members keep sending at the pre-Add epoch for their Add-grace; the
  // joiner hears that index before any key and can never fill it.
  const world = newWorld(t, "joiner", "ch-wd-stale", (w) => w.withThird());
  await joinAfterMisses(t, world, 5, [
    world.missingKey(PEER_ID, 4),
    world.missingKey(THIRD_ID, 4),
  ]);
  assert.deepEqual(world.holds, [true, false], "a stale index opened a hold");
  await advance(t, JOIN_RACE_DEFER_MS * 2);
  assert.deepEqual(world.loudSince(0), [], "a pre-epoch frame went red");
  assert.equal(world.session.callMode().kind, "e2ee");
});

test("false-red control: past the wrap, every index of the eight epochs before the held one is exempt", async (t) => {
  const world = newWorld(t, "joiner", "ch-wd-stale-wrap");
  // Welcomed at 20: epochs 12..19 are indexes 12..15 and 0..3.
  await joinAfterMisses(
    t,
    world,
    20,
    [12, 13, 14, 15, 16, 17, 18, 19].map((e) => world.missingKey(PEER_ID, e)),
  );
  assert.deepEqual(world.holds, [true, false]);
  await advance(t, JOIN_RACE_DEFER_MS * 2);
  assert.deepEqual(world.loudSince(0), []);
  assert.equal(world.session.callMode().kind, "e2ee");
});

test("false-red control: an index the first install filled is answered, not counted", async (t) => {
  // The ordinary in-window race at the held epoch itself.
  const world = newWorld(t, "joiner", "ch-wd-filled");
  await joinAfterMisses(t, world, 5, [world.missingKey(PEER_ID, 5)]);
  assert.deepEqual(world.holds, [true, false]);
  await advance(t, JOIN_RACE_DEFER_MS * 2);
  assert.deepEqual(world.loudSince(0), []);
});

test("a stale miss beside a counted one: only the counted one reaches the verdict", async (t) => {
  const world = newWorld(t, "joiner", "ch-wd-mixed", (w) => w.withThird());
  const ahead = world.missingKey(THIRD_ID, 6);
  await joinAfterMisses(t, world, 5, [world.missingKey(PEER_ID, 4), ahead]);
  assert.deepEqual(world.holds, [true]);
  await advance(t, JOIN_RACE_DEFER_MS + 1_000);
  assert.deepEqual(world.loudSince(0), [{ state: "loud", error: ahead }]);
});

// ---- the pure discriminator --------------------------------------------------

test("joinWindowMissPredatesEpoch: exactly the eight epochs before the held one, clamped at 0", () => {
  // Held at 20 (index 4): epochs 12..19 predate it.
  for (const e of [12, 13, 14, 15, 16, 17, 18, 19]) {
    assert.equal(predates(e % 16, 20), true, `epoch ${e}`);
  }
  // 21..27 (indexes 5..11) are AHEAD and count; index 4 is the held one.
  for (const e of [20, 21, 22, 23, 24, 25, 26, 27]) {
    assert.equal(predates(e % 16, 20), false, `epoch ${e}`);
  }
  // Held at 1: only epoch 0 predates it.
  assert.equal(predates(0, 1), true);
  for (let i = 1; i < 16; i++)
    assert.equal(predates(i, 1), false, `index ${i}`);
  // Held at 0: nothing predates it.
  for (let i = 0; i < 16; i++)
    assert.equal(predates(i, 0), false, `index ${i}`);
});

test("joinWindowMissPredatesEpoch: anything malformed counts (fails closed)", () => {
  for (const [i, e] of [
    [-1, 20],
    [16, 20],
    [1.5, 20],
    [Number.NaN, 20],
    [3, Number.NaN],
    [3, -1],
    [3, Number.POSITIVE_INFINITY],
    [3, 4.5],
  ]) {
    assert.equal(predates(i, e), false, `(${i}, ${e})`);
  }
});
