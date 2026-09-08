// Session-level specs for the THREE-PARTY join race (`MlsCallSession`), on the
// shared world in `mlsCallSession.harness.ts`.
//   node --test --conditions=browser components/rtc/mlsCallSession.joinrace.test.ts
//
// The failure these pin (rejoin plan §7.4, live leg 3a, 2026-09-07): a member
// quick-rejoins, which advances the epoch; a BYSTANDER switches to the new key
// index before this device installs it; the worker raises a decode MissingKey
// naming that bystander, outside every rotation window; `#latchLoud` fires.
// Because a MissingKey NAMES its participant the heal's only witness is then a
// device that never churns, so the chip stayed red for the rest of the call
// while that same peer's frames decrypted again 3.6 s later.
//
// The fix DEFERS the verdict instead of guessing it, so the two specs that
// matter most are the ones proving the deferral cannot be talked out of going
// loud. A previous attempt (`1df6c703`, reverted by `69797f8d`) classified the
// same error as RE-SECURING on the strength of a bound that does not exist —
// `#resecureTimer` is cancelled by `noteEncryptionRecovered()`, which fires on
// ANY participant's SFU-declared encryption status — and turned a permanent
// red into a SILENT GREEN. "the SFU's recovery echo cannot cancel the bound"
// and "a local key install for another sender cannot either" are that
// regression's guards; they must fail if the hold is ever made cancellable by
// anything but the install that answers it.
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import {
  type World,
  advance,
  bringUpCreator,
  flush,
  JOIN_RACE_DEFER_MS,
  LEAVE_GRACE_MS,
  newWorld,
  PEER,
  PEER_ID,
  SELF_ID,
  THIRD,
  THIRD_ID,
} from "./mlsCallSession.harness.ts";

/**
 * A three-party call, live and green, past the first rotation settle so no
 * rotation window is open — the seat every spec below starts from.
 */
async function threeParty(t: TestContext, channelId: string): Promise<World> {
  const world = newWorld(t, "creator", channelId, (w) => w.withThird());
  await bringUpCreator(t, world);
  await world.session.reconcileNow();
  await flush();
  await advance(t, 3_000); // past the immediate-install rotation settle (2 s)
  assert.equal(world.session.callMode().kind, "e2ee");
  return world;
}

/**
 * Leg 3a's shape: PEER quick-rejoins the SFU (out, then back), which is the
 * membership change THIS device observes; the epoch it triggers is served by
 * someone else, so THIRD — a bystander that did nothing — reaches the new key
 * index first and our worker raises a missing key naming it.
 */
async function bystanderRaceAfterRejoin(
  world: World,
  nextEpoch: number,
): Promise<Error> {
  world.sfu = world.sfu.filter((id) => id !== PEER_ID);
  world.session.onParticipantLeft(PEER_ID);
  await flush();
  world.sfu = [...world.sfu, PEER_ID];
  world.session.onParticipantJoined(PEER_ID);
  await flush();
  const error = world.missingKey(THIRD_ID, nextEpoch);
  world.session.noteEncryptionError(error);
  await flush();
  return error;
}

// ---- Specs -----------------------------------------------------------------

test("leg 3a: a bystander's missing key during an observed rejoin is HELD, not latched, and clears when the epoch installs", async (t) => {
  const world = await threeParty(t, "ch-3a");
  const before = world.states.length;
  const error = await bystanderRaceAfterRejoin(world, 1);

  // Not loud — and not clear either. The verdict is open.
  assert.deepEqual(world.loudSince(before), [], "the bystander race latched");
  assert.deepEqual(world.clearsSince(before), []);
  assert.equal(world.session.callMode().kind, "e2ee");
  // ...and the chip is driven AMBER for as long as it is open. Without this
  // the deferral is the reverted attempt's silent green.
  assert.deepEqual(world.holds, [true], "the chip was not driven amber");
  assert.deepEqual(world.states.slice(before), [
    { state: "resecuring", error },
  ]);

  // Our copy of the commit lands, and with it the key that fills the index
  // the bystander was already sending at.
  await advance(t, 1_000);
  await world.commit(1);
  await flush();
  assert.deepEqual(world.holds, [true, false], "the hold never resolved");
  assert.deepEqual(world.loudSince(before), []);
  assert.equal(world.session.callMode().kind, "e2ee");

  // And it stays resolved past the bound — the deadline was cancelled, not
  // merely outrun.
  await advance(t, JOIN_RACE_DEFER_MS * 2);
  assert.deepEqual(world.loudSince(before), []);
  assert.equal(world.session.callMode().kind, "e2ee");
});

test("🔴 the SFU's recovery echo cannot cancel the bound: a withheld commit still goes RED within it", async (t) => {
  const world = await threeParty(t, "ch-withheld");
  const before = world.states.length;
  const error = await bystanderRaceAfterRejoin(world, 1);
  assert.deepEqual(world.loudSince(before), []);
  assert.deepEqual(world.holds, [true]);

  // The exact signal that made the reverted attempt unsound: LiveKit's
  // `participantEncryptionStatusChanged(encrypted=true)` for ANY participant,
  // which `state.tsx` routes to `noteEncryptionRecovered()`. In leg 3a's own
  // trace it landed 97 ms after the error. Fire it there, and keep firing it
  // for the whole window — it is a server-controlled echo, so an attacker
  // that can withhold a commit can certainly send it.
  await advance(t, 250);
  for (let i = 0; i < 12; i++) {
    world.session.noteEncryptionRecovered();
    await advance(t, 1_000);
  }

  // No install ever filled the index, so the verdict resolves the only
  // honest way it can.
  assert.deepEqual(
    world.loudSince(before),
    [{ state: "loud", error }],
    "the hold was talked out of going loud",
  );
  assert.equal(world.session.callMode().kind, "negotiating");
  assert.deepEqual(world.holds, [true, false]);
});

test("🔴 a local key install for another sender cannot cancel the bound either", async (t) => {
  const world = await threeParty(t, "ch-otherinstall");
  const before = world.states.length;
  const error = await bystanderRaceAfterRejoin(world, 1);
  assert.deepEqual(world.holds, [true]);

  // An epoch whose keys cover PEER but never THIRD: `#onLocalKeyInstalled`
  // runs, `#clearResecureTimer` runs with it, and the ledger advances for
  // PEER only. None of that is evidence about the index THIRD is sending at.
  await advance(t, 1_000);
  world.roster = world.roster.filter((m) => m !== THIRD);
  await world.commit(1);
  await flush();
  assert.deepEqual(world.loudSince(before), [], "it latched early");

  await advance(t, JOIN_RACE_DEFER_MS);
  assert.deepEqual(
    world.loudSince(before),
    [{ state: "loud", error }],
    "an unrelated sender's install answered the hold",
  );
  assert.equal(world.session.callMode().kind, "negotiating");
});

test("the deadline runs from the FIRST error: a stream of missing keys cannot walk the bound forward", async (t) => {
  const world = await threeParty(t, "ch-stream");
  const before = world.states.length;
  const error = await bystanderRaceAfterRejoin(world, 1);

  // Re-raise the same pair every second for most of the window. Refreshing
  // the deadline on each would push the verdict out indefinitely.
  for (let i = 0; i < 9; i++) {
    await advance(t, 1_000);
    world.session.noteEncryptionError(world.missingKey(THIRD_ID, 1));
  }
  assert.deepEqual(world.loudSince(before), []);
  await advance(t, 1_500);
  assert.deepEqual(
    world.loudSince(before),
    [{ state: "loud", error }],
    "the bound moved with the errors",
  );
});

test("§8's plain-departure race: the window outlives the leave-grace entry the Remove deletes", async (t) => {
  const world = await threeParty(t, "ch-departure");
  // PEER leaves for good. The grace timer DELETES its own entry before
  // calling `#removeMember`, so a predicate reading `#leaveGrace` is blind
  // for the whole Remove — stage, submit, propagate, apply. That is the seat
  // §8 found uncovered, and it is where the bystander race lands next.
  world.sfu = world.sfu.filter((id) => id !== PEER_ID);
  world.roster = world.roster.filter((m) => m !== PEER);
  world.session.onParticipantLeft(PEER_ID);
  await advance(t, LEAVE_GRACE_MS + 1_000); // the grace fired; the entry is gone

  const before = world.states.length;
  world.session.noteEncryptionError(world.missingKey(THIRD_ID, 1));
  await flush();
  assert.deepEqual(
    world.loudSince(before),
    [],
    "a missing key during the Remove still latched at once",
  );
  assert.deepEqual(world.holds, [true]);
  assert.equal(world.session.callMode().kind, "e2ee");
});

test("no observed membership change: a missing key latches loud at once, exactly as on main", async (t) => {
  const world = await threeParty(t, "ch-nochange");
  const before = world.states.length;
  // Nothing joined, nothing left, no commit queued: an index this device does
  // not hold, with nothing in flight that could explain it.
  const error = world.missingKey(THIRD_ID, 1);
  world.session.noteEncryptionError(error);
  await flush();
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error }]);
  assert.equal(world.session.callMode().kind, "negotiating");
  assert.deepEqual(world.holds, [], "a hold was armed with nothing in flight");
});

test("an InvalidKey during an observed rejoin is untouched: the withheld-key legs keep latching at once", async (t) => {
  const world = await threeParty(t, "ch-invalidkey");
  world.sfu = world.sfu.filter((id) => id !== PEER_ID);
  world.session.onParticipantLeft(PEER_ID);
  await flush();
  world.sfu = [...world.sfu, PEER_ID];
  world.session.onParticipantJoined(PEER_ID);
  await flush();

  const before = world.states.length;
  // The decoy/withheld-key failure the live rig injects. It names no
  // participant and the key it holds is WRONG, not missing — `hard`, so no
  // hold may cover it (legs 9 and 11 assert the chip goes red on it).
  const error = new Error("InvalidKey: Decryption failed: x");
  world.session.noteEncryptionError(error);
  await flush();
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error }]);
  assert.equal(world.session.callMode().kind, "negotiating");
  assert.deepEqual(world.holds, []);
});

test("a hold resolves when its sender leaves the SFU — but not while the Room is reconnecting", async (t) => {
  const world = await threeParty(t, "ch-senderleft");
  const before = world.states.length;
  await bystanderRaceAfterRejoin(world, 1);
  assert.deepEqual(world.holds, [true]);

  // A full LiveKit reconnect empties `remoteParticipants`, so every sender
  // reads as absent. That must NOT resolve the hold (the M2 shape).
  world.connected = false;
  world.sfu = [SELF_ID];
  await world.session.reconcileNow();
  await flush();
  assert.deepEqual(world.holds, [true], "an emptied SFU set resolved the hold");

  // Back to Connected with the sender genuinely gone: it is publishing
  // nothing this device could be silently dropping.
  world.connected = true;
  await world.session.reconcileNow();
  await flush();
  assert.deepEqual(world.holds, [true, false]);
  assert.deepEqual(world.loudSince(before), []);
  await advance(t, JOIN_RACE_DEFER_MS * 2);
  assert.deepEqual(world.loudSince(before), [], "the cancelled deadline fired");
});

test("a loud latch from another cause supersedes every open hold", async (t) => {
  const world = await threeParty(t, "ch-supersede");
  await bystanderRaceAfterRejoin(world, 1);
  assert.deepEqual(world.holds, [true]);

  const before = world.states.length;
  const hard = new Error("InvalidKey: Decryption failed: x");
  world.session.noteEncryptionError(hard);
  await flush();
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error: hard }]);
  assert.deepEqual(world.holds, [true, false]);

  // The superseded hold's own deadline must not fire a second latch under
  // the first (`#latchLoud` early-returns, but the timer must be gone).
  await advance(t, JOIN_RACE_DEFER_MS * 2);
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error: hard }]);
});
