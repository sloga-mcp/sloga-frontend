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
// frames for 24 minutes. So each spec here drives one way to reach the banner
// and asserts the same two things at once: the banner is up, AND the gate that
// the banner is describing is held. `publishGate.test.ts` covers the second
// half of the same promise — that a held gate actually reaches the wire.
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
 * The invariant: whenever the ME-10 banner renders, publishing is gated. A
 * banner that promises a pause over an empty reason set is the defect,
 * regardless of which path put it there.
 */
function assertBannerHonest(world: World, where: string): void {
  assert.equal(world.terminalLoud(), true, `no ME-10 banner at ${where}`);
  assert.equal(
    world.publishing(),
    false,
    `the banner promised a pause at ${where} with the gate empty`,
  );
}

test("a media latch after the mode reached e2ee re-asserts the gate", async (t) => {
  const world = newWorld(t, "creator", "chan-fr1");
  await bringUpCreator(t, world);
  // The enable flip released `negotiating`: a healthy encrypted call publishes.
  assert.equal(world.publishing(), true, "an e2ee call must publish");
  assert.equal(world.terminalLoud(), false);

  await latchLoud(t, world);
  assertBannerHonest(world, "the media latch");
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
  assertBannerHonest(world, "the control escalation");

  release();
  await flush();
  // The republish landed GCM, so `enable-window` is released — but the latch
  // is terminal, so `negotiating` stays held and the banner stays true.
  assertBannerHonest(
    world,
    "the republish landing under a latched control verdict",
  );
});

test("a mix cycle under a latch never empties the gate", async (t) => {
  const world = newWorld(t, "creator", "chan-fr3", (w) => w.withThird());
  await bringUpCreator(t, world);
  await latchLoud(t, world);
  assertBannerHonest(world, "the latch");

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
  await advance(t, 20_000); // REUPGRADE_HYSTERESIS_MS
  assertBannerHonest(world, "the T2 re-upgrade under a latch");
  assert.deepEqual(
    [...world.gate],
    ["negotiating"],
    "the T2 path left a stale reason behind",
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
    assertBannerHonest(world, "the un-healed latch after a rejoin");
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
  assertBannerHonest(world, "the self-enrolment assertion");
});
