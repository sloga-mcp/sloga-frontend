// Session-level specs for `LocalKeyAckError` (iOS raw-key mode: the worker
// did not acknowledge this epoch's local send key), on the shared world in
// `mlsCallSession.harness.ts`.
//   node --test --conditions=browser components/rtc/mlsCallSession.keyack.test.ts
//
// On WebKit an unacknowledged `setKey` leaves the encoder on the PREVIOUS
// key; on a Remove that is the key the removed member holds. The media
// debounce would keep publishing under it, and any remote's encrypted status
// clears its amber. So the error takes the `MissingLocalFrameKeyError`
// terminus: the mode drops to `negotiating` (the gate holds), the latch is
// CONTROL (never healed by remote evidence) and reads un-keyed by class.
// Driven through the harness's `failLocalKeyOnce` seam on BOTH catches that
// hand to `#onRotationError` (the Add-grace timer and the Remove-immediate
// install), as the falsered spec does for the missing frame key.
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import { ENCRYPTION_TYPE_GCM } from "./localPublicationEncryption.ts";
import { LocalKeyAckError } from "./mlsCallKeys.ts";
import {
  type EncryptionStateCall,
  type World,
  advance,
  bringUpCreator,
  flush,
  GROUP,
  newWorld,
  PEER,
  PEER_ID,
} from "./mlsCallSession.harness.ts";

function loudsSince(world: World, index: number): EncryptionStateCall[] {
  return world.states.slice(index).filter((s) => s.state === "loud");
}

/** A live, green creator whose own publication the SFU records as GCM. */
async function greenCall(t: TestContext, channelId: string): Promise<World> {
  const world = newWorld(t, "creator", channelId);
  await bringUpCreator(t, world);
  world.localPublications = [
    { trackSid: "TR_local", encryption: ENCRYPTION_TYPE_GCM },
  ];
  assert.equal(world.chip(), "e2ee");
  assert.equal(world.publishing(), true);
  return world;
}

/** The terminus, asserted the same way for both catches. */
function assertTerminus(world: World, before: number, error: Error): void {
  assert.deepEqual(
    loudsSince(world, before),
    [{ state: "loud", error, meta: { origin: "control", mediaKeyed: false } }],
    "not ONE un-keyed control latch",
  );
  assert.equal(world.session.callMode().kind, "negotiating");
  assert.equal(world.publishing(), false, "kept publishing on the old key");
  assert.deepEqual([...world.gate], ["negotiating"]);
  assert.equal(world.chip(), "not_encrypted");
  assert.equal(world.terminalLoud(), true, "no latched banner");
}

/** Nothing remote clears it: an SFU echo, a clean witness, a later epoch. */
async function assertNotHealed(
  t: TestContext,
  world: World,
  before: number,
  nextEpoch: number,
): Promise<void> {
  world.session.noteEncryptionRecovered();
  await flush();
  assert.equal(
    world.chip({
      decodeWitness: { available: true, dropping: [], live: [PEER_ID] },
    }),
    "not_encrypted",
    "a clean witness softened the key-ack latch",
  );
  await advance(t, 1_000);
  await world.commit(nextEpoch);
  await advance(t, 30_000);
  assert.deepEqual(
    world.states.slice(before).filter((s) => s.state === "clear"),
    [],
    "remote evidence healed a control latch",
  );
  assert.equal(world.publishing(), false);
  assert.equal(world.terminalLoud(), true);
}

test("🔴 an unacknowledged local key off the Add-grace install terminates encrypted mode", async (t) => {
  const world = await greenCall(t, "ch-keyack-grace");
  const error = new LocalKeyAckError(GROUP, 1, 1);
  world.failLocalKeyOnce(error);
  const before = world.states.length;
  await world.commit(1); // an inbound Add: the local install is deferred
  await advance(t, 2_000); // ADD_GRACE_MS: the fenced timer runs, and throws
  await flush();
  assert.equal(world.localKeyFailure, null, "the scripted throw never fired");
  assertTerminus(world, before, error);
  await assertNotHealed(t, world, before, 2);
});

test("🔴 an unacknowledged local key off the Remove-immediate install terminates encrypted mode", async (t) => {
  // The Remove case the ruling names: the previous key is the one the
  // removed member holds.
  const world = await greenCall(t, "ch-keyack-remove");
  const error = new LocalKeyAckError(GROUP, 1, 1);
  world.failLocalKeyOnce(error);
  const before = world.states.length;
  await world.commit(1, [PEER]); // an inbound Remove: every key installs now
  assert.equal(
    world.localKeyFailure,
    null,
    "the scripted throw never fired inside the commit: not the immediate path",
  );
  assertTerminus(world, before, error);
});

test("CONTROL: a bare Error from the same seam still takes the media debounce", async (t) => {
  // Proves the routing is by class: the same seam and the same path, and
  // nothing latches at once.
  const world = await greenCall(t, "ch-keyack-control");
  world.failLocalKeyOnce(new Error("x"));
  const before = world.states.length;
  await world.commit(1);
  await advance(t, 2_000);
  await flush();
  assert.equal(world.localKeyFailure, null);
  assert.deepEqual(loudsSince(world, before), []);
  assert.equal(world.session.callMode().kind, "e2ee");
});
