// The ME-10 banner's central promise, as a session-level invariant.
//
// "This call could not be secured. Your audio and video stay paused — leave,
// or continue without encryption." That sentence is a claim about the publish
// gate, and until the 2026-09-08 join-race legs nothing asserted it: the
// harness binding did not implement `pausePublishing` at all, so every spec
// ran with the gate invisible and `#latchLoud`'s comment ("fail-closed: the
// banner says publishing is paused, and it is") was structurally unverified.
//
// The legs then produced the mirror of the failure this feature chases — not a
// false green but a FALSE RED with a false pause claim: a Linux seat showing
// ME-10 while the other seat recorded its publication as GCM and decrypted its
// frames for 24 minutes. So each spec here drives one way into a
// pause-promising state and asserts the session held the gate through it.
//
// Scope, stated so the next reader does not over-read these: this file pins the
// SESSION's half — the reason set and the order of its edges. Whether a held
// gate reaches the wire is `publishGate.test.ts`. Whether the RED itself is
// warranted is the second, unfixed defect from the same legs, and
// `assertMe10`'s comment says why it is pinned for one shape only.
import assert from "node:assert/strict";
import test from "node:test";

import {
  type World,
  advance,
  bringUpCreator,
  flush,
  latchLoud,
  newWorld,
  peerLeaves,
  peerRejoins,
} from "./mlsCallSession.harness.ts";

/**
 * The invariant these specs exist for: while the call is in a state that
 * promises a pause, the session is holding the gate. Deliberately says nothing
 * about WHICH banner renders.
 */
function assertGateHeld(world: World, where: string): void {
  assert.equal(
    world.publishing(),
    false,
    `the gate was empty at ${where}, over a banner promising a pause`,
  );
}

/**
 * That the ME-10 banner renders at all — asserted ONLY where a media-plane
 * verdict makes a red correct.
 *
 * Deliberately NOT asserted for the control-origin latches below. A control
 * verdict has no media-plane input and cannot heal, so it currently paints
 * "This call could not be secured" over a plane that may be provably keyed —
 * the second, unfixed half of the 2026-09-08 legs. Pinning that here would make
 * this file go red, and read as a regression, the day someone splits
 * control-origin red from media-origin red. The gate assertion holds either
 * way: a device that cannot prove who is in the call must not send, whatever
 * the banner ends up saying.
 */
function assertMe10(world: World, where: string): void {
  assert.equal(world.terminalLoud(), true, `no ME-10 banner at ${where}`);
}

test("a media latch after the mode reached e2ee re-asserts the gate", async (t) => {
  const world = newWorld(t, "creator", "chan-fr1");
  await bringUpCreator(t, world);
  // The enable flip released `negotiating`: a healthy encrypted call publishes.
  assert.equal(world.publishing(), true, "an e2ee call must publish");
  assert.equal(world.terminalLoud(), false);

  await latchLoud(t, world);
  assertMe10(world, "the media latch");
  assertGateHeld(world, "the media latch");
  assert.deepEqual([...world.gate], ["negotiating"]);
});

test("a control latch on the local-declaration seam re-asserts the gate", async (t) => {
  const world = newWorld(t, "creator", "chan-fr2");
  await bringUpCreator(t, world);
  assert.equal(world.publishing(), true);

  // One local publication the SFU has on record as NONE, whose republish does
  // not land: the `control` escalation arms, then latches. This is the shape
  // the legs saw — a CONTROL-plane verdict, with the media plane keyed and
  // healthy throughout (the world's `observedEncrypted` is all true).
  const release = world.holdRepublish();
  world.declarePlaintext();
  world.session.noteLocalPublicationsChanged();
  await flush();
  assert.equal(
    world.publishing(),
    false,
    "the assertion window must pause while the declaration is wrong",
  );

  await advance(t, 11_000); // past RESECURE_ESCALATE_MS
  assertGateHeld(world, "the control escalation");

  release();
  await flush();
  // The republish landed GCM, so `enable-window` is released — but the latch
  // is terminal, so `negotiating` stays held and the banner stays true.
  assertGateHeld(world, "the republish landing under a latched verdict");
});

test("a mix cycle under a latch never empties the gate", async (t) => {
  const world = newWorld(t, "creator", "chan-fr3", (w) => w.withThird());
  await bringUpCreator(t, world);
  await latchLoud(t, world);
  assertGateHeld(world, "the latch");

  // A bare (device-less) identity publishing in the SFU set is non-enrolled on
  // sight: T1 `mixed`. The label leaves `negotiating`, so the lockstep
  // releases that reason — `mixed` has to be holding by then.
  world.sfu = [...world.sfu, "dave"];
  world.sids.set("dave", ["TR_d"]);
  await world.session.reconcileNow();
  await flush();
  assert.equal(world.session.callMode().kind, "mixed");
  assert.equal(
    world.publishing(),
    false,
    "the mixed banner promises the same pause",
  );

  // The mix clears and the T2 warm resume runs: `#foldBeforeMixedRelease`
  // must assert `negotiating` BEFORE `mixed` is released, or the gate is empty
  // for the chained microtask between them.
  world.sfu = world.sfu.filter((id) => id !== "dave");
  world.sids.delete("dave");
  await world.session.reconcileNow();
  await flush();
  const before = world.gateLog.length;
  await advance(t, 20_000); // REUPGRADE_HYSTERESIS_MS
  assertMe10(world, "the T2 re-upgrade under a media latch");
  assertGateHeld(world, "the T2 re-upgrade under a latch");
  assert.deepEqual(
    [...world.gate],
    ["negotiating"],
    "the T2 path left a stale reason behind",
  );
  // The ORDER, not just the resting state: a settled `{negotiating}` looks
  // identical whether the fold ran before the release or a microtask after it,
  // and only the first keeps the promise for the whole interval. No spec can
  // observe a gap it does not look for.
  assert.deepEqual(
    world.gateLog.slice(before),
    ["+negotiating", "-mixed"],
    "the gate emptied between releasing `mixed` and folding to `negotiating`",
  );
});

test("a membership churn that does not heal the latch keeps the gate held", async (t) => {
  const world = newWorld(t, "creator", "chan-fr4");
  await bringUpCreator(t, world);
  await latchLoud(t, world);

  // The peer leaves and rejoins with all-new tracks. Whatever the heal
  // verdict decides, the banner and the gate must agree afterwards.
  await peerLeaves(world, 1);
  await peerRejoins(world, 2, ["TR_new"]);
  await advance(t, 11_000); // past the heal settle
  if (world.terminalLoud()) {
    assertGateHeld(world, "the un-healed latch after a rejoin");
  } else {
    // Healed: the chip is honest again, so publishing MUST come back — an
    // unreleased reason is silent outgoing death behind a green chip.
    assert.equal(
      world.publishing(),
      true,
      "the latch healed but publishing never resumed",
    );
  }
});

test("an unproven pause latches a loud the user can actually act on", async (t) => {
  const world = newWorld(t, "creator", "chan-fr6");
  await bringUpCreator(t, world);
  assert.equal(world.publishing(), true);
  assert.equal(world.terminalLoud(), false);

  // `state.tsx` swept the publish gate, could not prove the wire quiet, and
  // confirmed it with a bounded re-sweep. This is the far end of that.
  world.session.noteUnprovenPause(["microphone/TR_1"]);
  await flush();

  assertGateHeld(world, "an unproven pause");
  // The whole reason this goes through the session rather than straight into
  // `callEncryptionError`: only `#latchLoud` folds `e2ee` → `negotiating`, and
  // without that fold this is a red chip with NO banner and no way out.
  assert.equal(world.chip(), "not_encrypted");
  assertMe10(world, "an unproven pause");

  // And the banner's "Stay unencrypted" must not be inert. `confirmPlaintext`
  // returns silently unless its precondition holds, which `#loudLatched`
  // supplies — a latch written straight into the UI signal does not.
  await world.session.confirmPlaintext({});
  await flush();
  assert.ok(
    world.bridgeCalls.includes("callConfirmDowngrade"),
    "the escape never reached the blocking native confirm",
  );
  assert.equal(
    world.session.callMode().kind,
    "interlude",
    "the confirmed downgrade never took effect",
  );
  assert.equal(
    world.publishing(),
    true,
    "the user consented to plaintext and is still muted",
  );
});

test("a joiner whose enrolment never proves keeps the pre-connect gate", async (t) => {
  const world = newWorld(t, "joiner", "chan-fr5");
  void world.session.start();
  await flush();
  await advance(t, 1);
  // Still negotiating: `connect()` asserted `negotiating` before `room.connect`
  // and the session has not reached a verdict, so nothing has released it.
  assert.equal(world.publishing(), false);
  assert.equal(world.terminalLoud(), false, "no banner before a verdict");

  // The Welcome never lands; `SELF_ENROLMENT_DEADLINE_MS` (240 s) latches.
  await advance(t, 250_000);
  assertGateHeld(world, "the self-enrolment assertion");
});
