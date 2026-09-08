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
  bringUpJoiner,
  flush,
  JOIN_RACE_DEFER_MS,
  LEAVE_GRACE_MS,
  newWorld,
  PEER,
  PEER_ID,
  SELF,
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
  assert.equal(
    world.chip(),
    "resecuring",
    "the chip the user reads went green",
  );
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
  assert.equal(world.chip(), "e2ee", "the chip did not come back");

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
  assert.equal(
    world.chip(),
    "not_encrypted",
    "the chip the user reads is not red",
  );
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

test("🔴 a local key install and the SFU echo TOGETHER still do not answer a hold", async (t) => {
  // The two things that cancel `#resecureTimer`, applied at once. A local key
  // install runs `#onLocalKeyInstalled` and `#clearResecureTimer` with it, and
  // the echo is the signal that made the reverted attempt unsound. Neither is
  // evidence about the index THIRD is actually sending at, and their sum is
  // not either.
  const world = await threeParty(t, "ch-otherinstall");
  const before = world.states.length;
  const error = await bystanderRaceAfterRejoin(world, 2); // THIRD at index 2
  assert.deepEqual(world.holds, [true]);

  await advance(t, 1_000);
  await world.commit(1); // installs index 1 for everyone; index 2 untouched
  world.session.noteEncryptionRecovered();
  await flush();
  assert.deepEqual(world.loudSince(before), [], "it latched early");

  await advance(t, JOIN_RACE_DEFER_MS);
  assert.deepEqual(
    world.loudSince(before),
    [{ state: "loud", error }],
    "an install plus an echo answered the hold",
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

  // Now THIRD drops off the SFU while STILL holding its leaf: no frames of
  // its are at risk, so the deadline is SUSPENDED — the chip stays amber and
  // nothing goes loud, however long it stays away.
  world.sfu = world.sfu.filter((id) => id !== THIRD_ID);
  await world.session.reconcileNow();
  await flush();
  await advance(t, JOIN_RACE_DEFER_MS + 5_000);
  assert.deepEqual(world.loudSince(before), [], "a suspended hold still fired");
  assert.deepEqual(world.holds, [true], "a departure resolved the hold");

  // THIRD returns, still sending at an index we never filled: the deadline is
  // re-armed and reaches its honest verdict.
  world.sfu = [...world.sfu, THIRD_ID];
  await world.session.reconcileNow();
  await flush();
  assert.deepEqual(world.loudSince(before), [], "it latched on re-arm");
  await advance(t, JOIN_RACE_DEFER_MS + 1_000);
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error }]);
});

test("🔴 flapping presence cannot walk the bound: a re-arm gets the REMAINING budget", async (t) => {
  // Suspension parks the deadline, so a peer whose connection flaps faster
  // than the bound — or a hostile SFU minting departures — would keep the
  // loud verdict permanently deniable if each re-arm started a fresh window.
  // Five cycles of 6 s armed is 30 s of exposure against a 20 s bound.
  const world = await threeParty(t, "ch-flap");
  const before = world.states.length;
  const error = await bystanderRaceAfterRejoin(world, 1);
  assert.deepEqual(world.holds, [true]);

  for (let i = 0; i < 5 && world.loudSince(before).length === 0; i++) {
    await advance(t, 6_000); // armed
    world.sfu = world.sfu.filter((id) => id !== THIRD_ID);
    await world.session.reconcileNow(); // suspend, banking the remainder
    await flush();
    world.sfu = [...world.sfu, THIRD_ID];
    await world.session.reconcileNow(); // re-arm on what is LEFT
    await flush();
  }
  assert.deepEqual(
    world.loudSince(before),
    [{ state: "loud", error }],
    "each re-arm refreshed the bound instead of continuing it",
  );
});

test("a sender removed from the GROUP resolves its hold: that index can never be filled", async (t) => {
  // The mirror of the bug being fixed. A device with no leaf holds no key of
  // this group and gets no future one, so a hold on it has no verdict left to
  // reach — and left suspended it would pin the chip amber for the rest of an
  // otherwise healthy call. Judged on the verified roster, not the SFU set.
  const world = await threeParty(t, "ch-removed");
  const before = world.states.length;
  await bystanderRaceAfterRejoin(world, 1);
  assert.deepEqual(world.holds, [true]);

  world.sfu = world.sfu.filter((id) => id !== THIRD_ID);
  world.roster = world.roster.filter((m) => m !== THIRD);
  await world.commit(1, [THIRD]); // the Remove epoch lands
  await world.session.reconcileNow();
  await flush();
  assert.deepEqual(world.holds, [true, false], "the hold outlived the Remove");
  await advance(t, JOIN_RACE_DEFER_MS * 2);
  assert.deepEqual(world.loudSince(before), []);
  assert.equal(world.session.callMode().kind, "e2ee");
});

test("🔴 the heal does not clear while the named peer has moved on to another unfilled index", async (t) => {
  // The defect the media-E2EE review of `ae15b2db` found. `errorSinceInstall`
  // cannot see that peer: the ledger's advance rule forgives the later pair
  // the moment an install advances us for that sender, and the worker emits
  // nothing more once it has silenced an index. Re-validating the index the
  // LATCH named is then no witness at all — the peer is two epochs ahead and
  // its every frame is being dropped.
  const world = await threeParty(t, "ch-heal-movedon");
  const before = world.states.length;
  const error = world.missingKey(THIRD_ID, 1); // THIRD at epoch 1
  world.session.noteEncryptionError(error); // no window: latches at once
  await flush();
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error }]);
  // THIRD moves on to epoch 2 while we are still behind.
  world.session.noteEncryptionError(world.missingKey(THIRD_ID, 2));
  await flush();

  // Our copy of commit 1 lands: it fills index 1 (the one the latch named) and
  // sweeps the index-2 record through the advance rule.
  await advance(t, 1_000);
  await world.commit(1);
  await advance(t, JOIN_RACE_DEFER_MS * 2);
  assert.deepEqual(
    world.clearsSince(before),
    [],
    "healed to green while that peer's frames were dropped at index 2",
  );
  assert.equal(world.session.callMode().kind, "negotiating");
});

test("🔴 a HARD error inside a rotation window is not the SFU's to clear either", async (t) => {
  // The other half of the shadowing problem. Missing keys now always take the
  // hold, but an `InvalidKey` raised inside a rotation window still goes to
  // `#armResecureEscalation` — and that timer was cancellable by
  // `noteEncryptionRecovered()`, i.e. by ANY participant's SFU-declared
  // encryption status. One echo turned a hard failure into a green chip over
  // an index the worker had marked invalid: the reverted attempt's posture,
  // reached without touching a missing key at all. A hard error reports a key
  // that STAYS wrong until the next epoch, so only a local install may end it.
  const world = await threeParty(t, "ch-hard-inwindow");
  await world.commit(1); // an Add rotation: grace + settle = a 4 s window
  // Past the 2 s Add-grace, so the DEFERRED local install has already run and
  // cannot clear the escalation later — that clear is legitimate and local,
  // and would mask what this spec is about — but still inside the window.
  await advance(t, 2_500);
  const before = world.states.length;
  const error = new Error("InvalidKey: Decryption failed: x");
  world.session.noteEncryptionError(error);
  await flush();
  assert.deepEqual(world.loudSince(before), []);
  assert.deepEqual(world.holds, [true], "the chip was not driven amber");

  for (let i = 0; i < 13; i++) {
    world.session.noteEncryptionRecovered();
    await advance(t, 1_000);
  }
  assert.deepEqual(
    world.loudSince(before),
    [{ state: "loud", error }],
    "the echo cleared a media-plane escalation",
  );
  assert.equal(world.session.callMode().kind, "negotiating");
});

test("🔴 the loud verdict is REPORTED before the amber is dropped", async (t) => {
  // `state.tsx` writes `callMediaHold` and `callEncryptionError` unbatched, so
  // dropping the amber first leaves an intermediate state with neither set,
  // in which `chipState` computes a green. No paint happens between them, but
  // an effect or a live-leg sampler can read it.
  const world = await threeParty(t, "ch-order");
  await bystanderRaceAfterRejoin(world, 1);
  const from = world.events.length;
  await advance(t, JOIN_RACE_DEFER_MS + 1_000);
  const tail = world.events.slice(from);
  assert.ok(tail.includes("state:loud"), `no loud in ${tail.join(",")}`);
  assert.ok(tail.includes("hold:false"), `no amber drop in ${tail.join(",")}`);
  assert.ok(
    tail.indexOf("state:loud") < tail.indexOf("hold:false"),
    `the amber was dropped before the loud landed: ${tail.join(",")}`,
  );
});

test("🔴 a device Welcomed into a call PAST epoch 16 still resolves its hold", async (t) => {
  // An earlier cut gated the pair witnesses on `#installEpoch >=
  // WORKER_KEYRING_SIZE` — the GROUP's epoch, not this worker's ring
  // occupancy. A device Welcomed at epoch 20 has filled ONE slot and nothing
  // of its is stale, yet the guard disabled the fix from its first install and
  // turned every join race into a guaranteed loud latch, on exactly the
  // receiver role the live legs use. The worker raises a decode missing key
  // only for an EMPTY slot and no path ever empties one, so a pair this side
  // has since filled cannot be a stale generation's: the epoch never enters.
  const world = newWorld(t, "joiner", "ch-late-join", (w) => w.withThird());
  await bringUpJoiner(t, world, 20);
  await world.session.reconcileNow();
  await flush();
  await advance(t, 5_000);
  const before = world.states.length;
  await bystanderRaceAfterRejoin(world, 21); // index 21 mod 16 = 5
  assert.deepEqual(world.holds, [true]);

  await advance(t, 1_000);
  await world.commit(21); // fills index 5 for every sender
  await flush();
  assert.deepEqual(world.holds, [true, false], "the hold never resolved");
  await advance(t, JOIN_RACE_DEFER_MS * 2);
  assert.deepEqual(world.loudSince(before), []);
  assert.equal(world.session.callMode().kind, "e2ee");
});

test("🔴 an ex-member that is STILL PUBLISHING does not resolve its hold", async (t) => {
  // A roster departure resolves a hold because a device with no leaf gets no
  // future key, so the index it failed at can never be filled. That is only
  // true once its frames are gone too: a device whose leaf was removed while
  // it stays connected is still sending into an index the worker marked
  // invalid, and resolving there was a green chip over exactly that — and
  // DS-schedulable, by relaying any Remove for the bystander (media-E2EE
  // review, 2026-09-08).
  const world = await threeParty(t, "ch-exmember-live");
  const before = world.states.length;
  const error = await bystanderRaceAfterRejoin(world, 1);
  assert.deepEqual(world.holds, [true]);

  // THIRD loses its leaf but keeps its SFU connection and its tracks.
  world.roster = world.roster.filter((m) => m !== THIRD);
  await world.session.reconcileNow();
  await flush();
  assert.deepEqual(world.holds, [true], "an SFU-present ex-member resolved it");

  await advance(t, JOIN_RACE_DEFER_MS);
  assert.deepEqual(
    world.loudSince(before),
    [{ state: "loud", error }],
    "the hold was resolved instead of reaching its verdict",
  );
});

test("🔴 a media escalation is not cancelled by a later LOCAL key install", async (t) => {
  // `#clearResecureTimer` used to cancel whatever timer was pending, whoever
  // asked. Our own key install is no evidence at all about a peer's wrong key,
  // and neither is a correction to our own publication declaration — the two
  // other callers. The escalation now carries a cancel token fixed at the arm,
  // and only a clearer presenting the same token may cancel it.
  const world = await threeParty(t, "ch-token");
  await world.commit(1); // an Add rotation: grace + settle = a 4 s window
  await advance(t, 2_500); // past the grace, so its own install is done
  const before = world.states.length;
  const error = new Error("InvalidKey: Decryption failed: x");
  world.session.noteEncryptionError(error);
  await flush();
  assert.deepEqual(world.holds, [true]);

  // A whole new epoch installs — `#onLocalKeyInstalled` runs with it.
  await advance(t, 1_000);
  await world.commit(2);
  await flush();
  assert.deepEqual(world.loudSince(before), [], "it latched early");
  await advance(t, 12_000);
  assert.deepEqual(
    world.loudSince(before),
    [{ state: "loud", error }],
    "a local key install cancelled a peer's media escalation",
  );
});

test("🔴 a Welcome joiner's pre-Welcome missing keys do not disable its heal", async (t) => {
  // A device joined by Welcome hears the members' frames before it holds any
  // key, and native snapshots `previous` only across a commit it applied, so
  // those pairs can NEVER be filled. Counting them as "this sender still has
  // an unfilled index" pinned the bystander heal off for the life of the
  // group — on exactly the receiver role leg 3a used, turning the fix into a
  // permanent red there (media-E2EE review, 2026-09-08). `#missing` carries
  // the same H1 exemption.
  const world = newWorld(t, "joiner", "ch-joiner-heal", (w) => w.withThird());
  await bringUpJoiner(t, world, 5, () => {
    // Heard at epoch 4, before our first key: unfillable forever.
    world.session.noteEncryptionError(world.missingKey(THIRD_ID, 4));
  });
  await world.session.reconcileNow();
  await flush();
  await advance(t, 5_000);

  const before = world.states.length;
  const error = world.missingKey(THIRD_ID, 6);
  world.session.noteEncryptionError(error); // no window: latches at once
  await flush();
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error }]);

  await advance(t, 1_000);
  await world.commit(6); // fills index 6 — the index the latch named
  await advance(t, JOIN_RACE_DEFER_MS * 2);
  assert.deepEqual(
    world.clearsSince(before),
    [{ state: "clear", error }],
    "an unfillable pre-Welcome pair held the heal off",
  );
  assert.equal(world.session.callMode().kind, "e2ee");
});

test("🔴 a media latch does not subsume the CONTROL escalation, which still reaches its own deadline", async (t) => {
  // `#latchLoud` force-cleared every pending escalation, so a media verdict
  // destroyed the bound on correcting our OWN publication declaration: the SFU
  // kept that publication on record as NONE — every receiver disarms its
  // cryptor for us — with nothing left to escalate, and the documented
  // "a control failure never heals" upgrade became unreachable from the timer
  // that was supposed to trigger it (media-E2EE review, 2026-09-08).
  const world = await threeParty(t, "ch-control-survives");
  await world.commit(1);
  await advance(t, 2_500);
  const before = world.states.length;

  // A peer's hard failure arms the media escalation...
  const error = new Error("InvalidKey: Decryption failed: x");
  world.session.noteEncryptionError(error);
  await flush();
  // ...then an unmute arms `control`, with the republish held open so it
  // cannot correct itself.
  await advance(t, 1_000);
  const release = world.holdRepublish();
  world.declarePlaintext();
  world.session.noteLocalPublicationsChanged();
  await flush();

  // The media escalation reaches its deadline first: a MEDIA latch.
  await advance(t, 9_500);
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error }]);

  // The control escalation must still be pending, and reach its own deadline.
  await advance(t, 2_000);
  const control = world
    .loudSince(before)
    .map((s) => s.error)
    .find((e) => e !== error && e !== undefined);
  assert.ok(control, "the media latch swallowed the control escalation");

  // ...and the upgraded latch never heals, however the peers churn. (The
  // upgrade itself reports a clear for the SUPERSEDED media error, so the
  // question is whether the CONTROL error is ever cleared.)
  const sinceUpgrade = world.states.length;
  world.sfu = [SELF_ID];
  world.roster = [SELF];
  await world.commit(2, [PEER, THIRD]);
  await advance(t, JOIN_RACE_DEFER_MS * 2);
  assert.ok(
    !world.clearsSince(sinceUpgrade).some((c) => c.error === control),
    "a control-upgraded latch healed",
  );
  assert.equal(world.session.callMode().kind, "negotiating");
  // 🔴 The upgrade must not cost the user the banner. `state.tsx` latches
  // `prev ?? error` and clears on identity, so latching the control error
  // BEFORE clearing the superseded media one made the latch a no-op and the
  // clear then wiped the signal: red chip with a Leave / Stay-unencrypted
  // banner became amber with neither, while the session stayed latched.
  assert.equal(world.chip(), "not_encrypted", "the upgrade wiped the UI latch");
  release();
});

test("🔴 a remote peer's SFU-declared status does not cancel the bound on OUR declaration", async (t) => {
  // The last un-evidenced cancel in the file. `noteEncryptionRecovered` fires
  // on ANY participant's `participantEncryptionStatusChanged(encrypted=true)`
  // and used to clear the `control` escalation — so one peer reporting itself
  // encrypted destroyed the bound on correcting a publication the SFU still
  // had on record as NONE, which every receiver disarms its cryptor for.
  const world = await threeParty(t, "ch-control-echo");
  const before = world.states.length;
  const release = world.holdRepublish();
  world.declarePlaintext();
  world.session.noteLocalPublicationsChanged();
  await flush();
  assert.deepEqual(world.holds, [true], "no control escalation was armed");

  for (let i = 0; i < 13; i++) {
    world.session.noteEncryptionRecovered();
    await advance(t, 1_000);
  }
  assert.equal(
    world.loudSince(before).length,
    1,
    "a peer's declared status cancelled the control bound",
  );
  assert.equal(world.chip(), "not_encrypted");
  release();
});

test("🔴 the heal holds while ANOTHER present peer still has an index we never filled", async (t) => {
  // `originatingPairRefilled` answers a question about the latch's own sender.
  // A different present peer silenced earlier is invisible to
  // `errorSinceInstall`, because the ledger's advance rule forgives its pair
  // the moment any install advances us for that sender — so the heal could go
  // green while that peer's frames were still being dropped.
  const world = await threeParty(t, "ch-unfilled-elsewhere");
  const before = world.states.length;
  const error = world.missingKey(THIRD_ID, 1);
  world.session.noteEncryptionError(error); // no window: latches at once
  await flush();
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error }]);
  // PEER is silenced at an index nothing in this call will ever fill.
  world.session.noteEncryptionError(world.missingKey(PEER_ID, 9));
  await flush();

  // Epoch 1 fills index 1 for everyone, so the LATCH's own pair is answered.
  await advance(t, 1_000);
  await world.commit(1);
  await advance(t, JOIN_RACE_DEFER_MS * 2);
  assert.deepEqual(
    world.clearsSince(before),
    [],
    "healed while another present peer was still being dropped",
  );
  assert.equal(world.chip(), "not_encrypted");
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

test("🔴 a control escalation cannot swallow a peer's decrypt failure", async (t) => {
  // The fourth silent-green route, and it needed no attacker. One shared
  // escalation timer meant the reuse guard decided which cancel token a
  // pending escalation carried: a routine unmute arms `control` and awaits its
  // republish, a peer's failure lands in that window and gets no escalation of
  // its own, and the republish's correction — evidence about OUR publications
  // only — then cancelled it. Separate escalations per reason cannot be traded
  // for each other.
  const world = await threeParty(t, "ch-control-swallow");
  await world.commit(1); // an Add rotation: a 4 s window
  await advance(t, 2_500); // past the grace, so its own install is done

  // The unmute: a publication lands NONE-declared, and the republish is held
  // open so the `control` escalation is genuinely pending.
  const release = world.holdRepublish();
  world.declarePlaintext();
  world.session.noteLocalPublicationsChanged();
  await flush();
  const before = world.states.length;

  // A peer's hard decrypt failure, inside the rotation window.
  const error = new Error("InvalidKey: Decryption failed: x");
  world.session.noteEncryptionError(error);
  await flush();

  release(); // the republish lands GCM and corrects the declaration
  await flush();
  assert.deepEqual(world.loudSince(before), [], "it latched early");

  await advance(t, 13_000);
  assert.deepEqual(
    world.loudSince(before),
    [{ state: "loud", error }],
    "the declaration correction cancelled a peer's escalation",
  );
  assert.equal(world.session.callMode().kind, "negotiating");
});

test("🔴 ...and a control escalation cannot make a media latch unhealable either", async (t) => {
  // The mirror ordering. The old shared `#resecureOrigin` upgraded to
  // `control` the moment a control arm fired, so a media error that latched
  // afterwards was recorded as a control latch — and `loudHealVerdict` refuses
  // to heal those. One routine unmute overlapping a rotation turned a
  // recoverable red into a permanent one.
  const world = await threeParty(t, "ch-origin-poison");
  await world.commit(1);
  await advance(t, 2_500);
  const before = world.states.length;

  // The media escalation first...
  const error = new Error("InvalidKey: Decryption failed: x");
  world.session.noteEncryptionError(error);
  await flush();
  // ...then the unmute arms `control` on top of it.
  const release = world.holdRepublish();
  world.declarePlaintext();
  world.session.noteLocalPublicationsChanged();
  await flush();
  release();
  await flush();

  await advance(t, 13_000);
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error }]);

  // The latch must still be a MEDIA latch: the peers leaving are a witness
  // the heal can act on. An InvalidKey names nobody, so the witness set is
  // EVERY remote that was present — both of them have to go.
  await advance(t, 1_000);
  world.sfu = [SELF_ID];
  world.roster = [SELF];
  await world.commit(2, [PEER, THIRD]);
  await advance(t, JOIN_RACE_DEFER_MS * 2);
  // The declaration correction also reports a bare clear; what matters is
  // that the LATCH's own error was cleared, which only a media latch can do.
  assert.ok(
    world.clearsSince(before).some((c) => c.error === error),
    "the latch was recorded as control and could never heal",
  );
  assert.equal(world.session.callMode().kind, "e2ee");
});

test("a pair RE-PUSHED after the latch is a witness, even though it was filled before", async (t) => {
  // Every install carries the previous epoch's keys as well, and a `setKey`
  // for an index calls `resetKeyStatus` on it — so re-pushing a slot genuinely
  // re-validates it. The ledger therefore stamps a pair with its LATEST fill,
  // not its first: a stamp frozen at the first fill would make this witness
  // false forever from epoch 16 on, once the ring starts reusing indexes, and
  // the bystander heal would expire silently on any long call (media-E2EE
  // review, 2026-09-08).
  const world = await threeParty(t, "ch-heal-repush");
  const before = world.states.length;
  const error = world.missingKey(THIRD_ID, 0); // index 0 was filled at epoch 0
  world.session.noteEncryptionError(error);
  await flush();
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error }]);

  // Epoch 1's install carries epoch 0 as `previous`, re-pushing index 0.
  await advance(t, 1_000);
  await world.commit(1);
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
  // Epoch 1's install carries epoch 0 as `previous`, so it re-pushes index 0
  // — a genuine re-validation. Latch AFTER it, so the pair's newest fill is
  // strictly BEFORE the latch.
  await world.commit(1);
  await advance(t, 5_000); // past the grace AND the settle: no window open
  const before = world.states.length;
  const error = world.missingKey(THIRD_ID, 0);
  world.session.noteEncryptionError(error);
  await flush();
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error }]);

  // Epoch 2 carries epoch 1 as `previous`, so it touches indexes 2 and 1 and
  // never index 0. THIRD never churns, so the latch has no witness at all.
  await advance(t, 1_000);
  await world.commit(2);
  await advance(t, JOIN_RACE_DEFER_MS * 2);
  assert.deepEqual(world.clearsSince(before), []);
  assert.equal(world.session.callMode().kind, "negotiating");
});
