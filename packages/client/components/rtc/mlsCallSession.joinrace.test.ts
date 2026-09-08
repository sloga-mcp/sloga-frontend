// Session-level specs for the THREE-PARTY join race (`MlsCallSession`), on the
// shared world in `mlsCallSession.harness.ts`.
//   node --test --conditions=browser components/rtc/mlsCallSession.joinrace.test.ts
//
// The failure these pin (rejoin plan section 7.4, live leg 3a, 2026-09-07): a
// member quick-rejoins, which advances the epoch; a BYSTANDER switches to the
// new key index before this device installs it; the worker raises a decode
// MissingKey naming that bystander, outside every rotation window;
// `#latchLoud` fires. Because a MissingKey NAMES its participant the heal's
// only witness is then a device that never churns, so the chip stayed red for
// the rest of the call while that same peer's frames decrypted again 3.6 s
// later.
//
// The fix DEFERS the verdict instead of guessing it, so the specs that matter
// most are the ones proving the deferral cannot be talked out of going loud,
// and cannot be answered by anything short of this side installing the exact
// index the error named. A previous attempt (`1df6c703`, reverted by
// `69797f8d`) turned that permanent red into a SILENT GREEN by trusting a
// bound that does not exist. The specs marked 🔴 are that regression's guards.
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
async function threeParty(
  t: TestContext,
  channelId: string,
  seat?: (w: World) => void,
): Promise<World> {
  const world = newWorld(t, "creator", channelId, (w) => {
    w.withThird();
    seat?.(w);
  });
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

  // Our copy of the commit lands, and with it the key at the exact index the
  // bystander was already sending at.
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

test("🔴 an install that ADVANCES past the index without filling it does not answer the hold", async (t) => {
  // The exact defect the media-E2EE review of the first cut found. The
  // ledger's `#superseded` also accepts "an install advanced us past it"
  // (`at <= advancedAt`), which is right for `errorSince` — where the heal's
  // peer witness still has to clear — and wrong as the hold's only test. The
  // worker marks an index invalid after ONE failure and drops every later
  // frame at it silently; only a `setKey` for that exact index re-validates
  // it, and the ring does not come round again for sixteen epochs. A sender
  // two epochs ahead of us would otherwise take the chip back to green over
  // an index nothing ever filled.
  const world = await threeParty(t, "ch-advance-nofill");
  const before = world.states.length;
  // THIRD is sending at the epoch-2 index; we are still at epoch 0.
  const error = await bystanderRaceAfterRejoin(world, 2);
  assert.deepEqual(world.holds, [true]);

  // Epoch 1 lands: it fills index 1 for every sender, so it ADVANCES us for
  // THIRD — but it never touches index 2.
  await advance(t, 1_000);
  await world.commit(1);
  await flush();
  assert.deepEqual(
    world.holds,
    [true],
    "an install that never filled the index answered the hold",
  );
  assert.deepEqual(world.loudSince(before), []);

  // Nothing fills index 2, so the verdict resolves the only honest way.
  await advance(t, JOIN_RACE_DEFER_MS);
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error }]);
  assert.equal(world.session.callMode().kind, "negotiating");
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
  for (let i = 0; i < JOIN_RACE_DEFER_MS / 1_000 + 2; i++) {
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

test("🔴 a missing key raised INSIDE a rotation window takes the same bound, not the cancellable escalation", async (t) => {
  // `classifyEncryptionError`'s rotation-window arm used to win this race and
  // hand the error to `#armResecureEscalation`, whose timer the SFU's echo
  // cancels — and whose "resecuring" never reached the chip at all. In a
  // 3-party call the arm is not rare: every member's leave-grace expires
  // together, so a member that loses the race to serve the Remove sits inside
  // a 12 s `arbitration` window across exactly the join race.
  const world = await threeParty(t, "ch-inwindow");
  await world.commit(1); // opens a rotation window (the install settle)
  await flush();
  const before = world.states.length;
  const error = world.missingKey(THIRD_ID, 2); // an index we do not hold
  world.session.noteEncryptionError(error);
  await flush();
  assert.deepEqual(world.holds, [true], "the rotation arm shadowed the hold");

  for (let i = 0; i < JOIN_RACE_DEFER_MS / 1_000 + 2; i++) {
    world.session.noteEncryptionRecovered();
    await advance(t, 1_000);
  }
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error }]);
  assert.equal(world.session.callMode().kind, "negotiating");
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

test("🔴 a binding that cannot render the amber gets the strict verdict, not an invisible one", async (t) => {
  // The amber is the whole reason a deferral is not the reverted attempt.
  // `onMediaHold` is an optional interface member, so a binding without it
  // must fail CLOSED rather than defer into a green chip.
  const world = await threeParty(t, "ch-nohold", (w) => {
    w.holdsSupported = false;
  });
  const before = world.states.length;
  const error = await bystanderRaceAfterRejoin(world, 1);
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error }]);
  assert.equal(world.session.callMode().kind, "negotiating");
  assert.deepEqual(world.holds, []);
});

test("🔴 ...including inside a rotation window, where falling through would reach the cancellable arm", async (t) => {
  // The fall-through case: with a rotation window open, a missing key that
  // cannot be held would otherwise land in `#armResecureEscalation` — whose
  // bound the SFU's echo cancels, and whose state this binding cannot render
  // either. There is no honest way to stay open, so the strict verdict wins.
  const world = await threeParty(t, "ch-nohold-window", (w) => {
    w.holdsSupported = false;
  });
  await world.commit(1); // opens a rotation window (the install settle)
  await flush();
  const before = world.states.length;
  const error = world.missingKey(THIRD_ID, 2);
  world.session.noteEncryptionError(error);
  await flush();
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error }]);
  assert.equal(world.session.callMode().kind, "negotiating");
});

test("the deadline runs from the FIRST error: a stream of missing keys cannot walk the bound forward", async (t) => {
  const world = await threeParty(t, "ch-stream");
  const before = world.states.length;
  const error = await bystanderRaceAfterRejoin(world, 1);

  // Re-raise the same pair every second for most of the window. Refreshing
  // the deadline on each would push the verdict out indefinitely.
  for (let i = 0; i < JOIN_RACE_DEFER_MS / 1_000 - 1; i++) {
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

test("section 8's plain-departure race: the window outlives the leave-grace entry the Remove deletes", async (t) => {
  const world = await threeParty(t, "ch-departure");
  // PEER leaves for good. The grace timer DELETES its own entry before
  // calling `#removeMember`, so a predicate reading `#leaveGrace` is blind
  // for the whole Remove — stage, submit, propagate, apply. That is the seat
  // section 8 found uncovered, and it is where the bystander race lands next.
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

test("no observed membership change and no rotation window: a missing key latches loud at once, as on main", async (t) => {
  const world = await threeParty(t, "ch-nochange");
  const before = world.states.length;
  // Nothing joined, nothing left, no rotation in flight: an index this device
  // does not hold, with nothing that could explain it.
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

test("🔴 a sender leaving SUSPENDS its hold; coming back with the index still unfilled re-arms it", async (t) => {
  // Absence must not RESOLVE a hold. The worker never prunes a participant's
  // key handler, so the index it marked invalid is still invalid when that
  // identity returns — and the SFU controls the roster, so a spurious
  // departure would otherwise be a free pass back to green.
  const world = await threeParty(t, "ch-senderleft");
  const before = world.states.length;
  const error = await bystanderRaceAfterRejoin(world, 1);
  assert.deepEqual(world.holds, [true]);

  // A full LiveKit reconnect empties `remoteParticipants`, so every sender
  // reads as absent. That must change nothing at all (the M2 shape).
  const sfuBefore = [...world.sfu];
  world.connected = false;
  world.sfu = [SELF_ID];
  await world.session.reconcileNow();
  await flush();
  assert.deepEqual(world.holds, [true], "an emptied SFU set moved the hold");
  world.connected = true;
  world.sfu = sfuBefore;
  await world.session.reconcileNow();
  await flush();
  assert.deepEqual(world.holds, [true]);

  // Now THIRD genuinely leaves the call: no frames of its are at risk, so the
  // deadline is SUSPENDED — the chip stays amber, nothing goes loud, and the
  // record of the index it never filled is kept.
  world.sfu = world.sfu.filter((id) => id !== THIRD_ID);
  world.roster = world.roster.filter((m) => m !== THIRD);
  await world.session.reconcileNow();
  await flush();
  await advance(t, JOIN_RACE_DEFER_MS * 2);
  assert.deepEqual(world.loudSince(before), [], "a suspended hold still fired");
  assert.deepEqual(world.holds, [true], "a departure resolved the hold");

  // THIRD returns, still sending at an index we never filled: the deadline is
  // re-armed from here and reaches its honest verdict.
  world.sfu = [...world.sfu, THIRD_ID];
  world.roster = [...world.roster, THIRD];
  await world.session.reconcileNow();
  await flush();
  assert.deepEqual(world.loudSince(before), [], "it latched on re-arm");
  await advance(t, JOIN_RACE_DEFER_MS + 1_000);
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error }]);
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

test("the heal clears a bystander latch once this side installs the exact index the error named", async (t) => {
  // The other half of the fix (rejoin plan section 7.4(b)), in the corrected
  // form. A missing key NAMES its participant, so `#loudPeers` is the
  // bystander that raised it — and `loudHealVerdict` needs that device to
  // leave or re-publish with all-new SIDs, which a bystander never does. Once
  // this side pushes the exact pair, `setKey` re-validates that index and any
  // surviving failure re-emits inside the settle, so the latch has a witness
  // it can actually produce.
  const world = await threeParty(t, "ch-heal-refill");
  const before = world.states.length;
  const error = world.missingKey(THIRD_ID, 1);
  world.session.noteEncryptionError(error); // no window: latches at once
  await flush();
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error }]);

  await advance(t, 1_000);
  await world.commit(1); // fills index 1 for every sender, THIRD included
  await advance(t, JOIN_RACE_DEFER_MS * 2);
  assert.deepEqual(world.clearsSince(before), [{ state: "clear", error }]);
  assert.equal(world.session.callMode().kind, "e2ee");
});

test("...but a pair filled BEFORE the latch is no witness at all", async (t) => {
  // The negative control, and the reverted attempt's exact mistake: it asked
  // whether the pair had EVER been pushed, which is true from the moment the
  // install posts — and the worker raises the error precisely BECAUSE that
  // `setKey` had not been processed yet, so the clause was already true at
  // latch time and healed the latch it was meant to judge.
  const world = await threeParty(t, "ch-heal-prefill");
  const before = world.states.length;
  // Index 0 is the epoch this call has been running on all along.
  const error = world.missingKey(THIRD_ID, 0);
  world.session.noteEncryptionError(error);
  await flush();
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error }]);

  // A later epoch re-keys everyone, but nothing re-fills index 0 and THIRD
  // never churns, so the latch has no witness and must hold.
  await advance(t, 1_000);
  await world.commit(1);
  await advance(t, JOIN_RACE_DEFER_MS * 2);
  assert.deepEqual(world.clearsSince(before), []);
  assert.equal(world.session.callMode().kind, "negotiating");
});
