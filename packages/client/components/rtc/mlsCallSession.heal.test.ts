// Session-level specs for the loud-latch heal (`MlsCallSession`), driven
// through the real join ladder with a fake bridge, installer and media
// binding under fake timers (the shared world in `mlsCallSession.harness.ts`).
//   node --test --conditions=browser components/rtc/mlsCallSession.heal.test.ts
// Two behaviors the media-E2EE review asked to see proven at the session
// level rather than in the pure ledger spec:
//   - e2163ead (MED): the heal probe's install reference is taken BEFORE the
//     installer runs, so an InvalidKey landing between the installer's
//     per-entry awaits holds the latch (and the same rejoin WITHOUT that
//     error heals — the positive control, or the hold proves nothing);
//   - de4879c2 (H1): a joiner that heard a peer's frames before its Welcome
//     (MissingKey at epoch E) installs E+1 first with `previous: []`; that
//     install supersedes the missing key PER SENDER, so a later latch can
//     still heal once the peer left, or re-added with all-new tracks.
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import {
  type EncryptionStateCall,
  type World,
  advance,
  bringUpCreator,
  bringUpJoiner,
  flush,
  HEAL_SETTLE_MS,
  latchLoud,
  newWorld,
  PEER_ID,
  peerLeaves,
  peerRejoins,
} from "./mlsCallSession.harness.ts";

/**
 * The reviewer's rejoin recipe: latch loud, watch the peer leave and re-add
 * under a new epoch with all-new track SIDs, optionally with an InvalidKey
 * raised BETWEEN the installer's awaits during the Add epoch's install, then
 * wait out the settle (+ the Add-grace and re-arm windows, generously).
 */
async function rejoinAfterLatch(
  t: TestContext,
  world: World,
  firstEpoch: number,
  midInstallError: boolean,
): Promise<{ latched: Error; clears: EncryptionStateCall[] }> {
  const latched = await latchLoud(t, world);
  const sinceLatch = world.states.length;
  await advance(t, 1_000);
  await peerLeaves(world, firstEpoch);
  await advance(t, 1_000);
  if (midInstallError) {
    world.midInstallError = new Error("InvalidKey: Decryption failed: y");
  }
  await peerRejoins(world, firstEpoch + 1, ["TR_new"]);
  assert.equal(world.midInstallError, null, "the mid-install error fired");
  await advance(t, HEAL_SETTLE_MS * 3);
  return { latched, clears: world.clearsSince(sinceLatch) };
}

// ---- Specs -----------------------------------------------------------------

test("creator: an InvalidKey between the installer's awaits holds the latch through the peer's rejoin", async (t) => {
  const world = newWorld(t, "creator", "ch-hold");
  await bringUpCreator(t, world);
  const { clears } = await rejoinAfterLatch(t, world, 1, true);
  assert.deepEqual(clears, []);
  assert.equal(world.session.callMode().kind, "negotiating");
});

test("creator (positive control): the same rejoin without the mid-install error heals", async (t) => {
  const world = newWorld(t, "creator", "ch-heal");
  await bringUpCreator(t, world);
  const { latched, clears } = await rejoinAfterLatch(t, world, 1, false);
  assert.deepEqual(clears, [{ state: "clear", error: latched }]);
  assert.equal(world.session.callMode().kind, "e2ee");
});

test("joiner (H1): a pre-Welcome missing key is superseded by the first install, so the latch heals once the peer left", async (t) => {
  const world = newWorld(t, "joiner", "ch-joiner-left");
  // The peer's frames at epoch 4 reach the worker before we hold any key;
  // the first install after the Welcome is epoch 5 with `previous: []`.
  await bringUpJoiner(t, world, 5, () => {
    const before = world.states.length;
    world.session.noteEncryptionError(
      new Error(
        `MissingKey: missing key at index 4 for participant ${PEER_ID}`,
      ),
    );
    assert.equal(world.states[before]?.state, "resecuring");
  });
  const latched = await latchLoud(t, world);
  const sinceLatch = world.states.length;
  await advance(t, 1_000);
  await peerLeaves(world, 6);
  await advance(t, HEAL_SETTLE_MS * 2);
  assert.deepEqual(world.clearsSince(sinceLatch), [
    { state: "clear", error: latched },
  ]);
  assert.equal(world.session.callMode().kind, "e2ee");
});

test("joiner (H1): the superseded missing key does not hold a later rejoin heal while the peer is present", async (t) => {
  const world = newWorld(t, "joiner", "ch-joiner-rejoin");
  await bringUpJoiner(t, world, 5, () => {
    world.session.noteEncryptionError(
      new Error(
        `MissingKey: missing key at index 4 for participant ${PEER_ID}`,
      ),
    );
  });
  const { latched, clears } = await rejoinAfterLatch(t, world, 6, false);
  assert.deepEqual(clears, [{ state: "clear", error: latched }]);
  assert.equal(world.session.callMode().kind, "e2ee");
});

test("creator: a reconnect spanning both probe firings holds, and the Room coming back re-arms the heal", async (t) => {
  const world = newWorld(t, "creator", "ch-reconnect");
  await bringUpCreator(t, world);
  const latched = await latchLoud(t, world);
  const sinceLatch = world.states.length;
  await advance(t, 1_000);
  await peerLeaves(world, 1); // the absent-peer heal is armed (10 s settle)
  // The Room drops into a reconnect before the settle fires and stays there
  // through the probe AND its one bounded retry: nothing may be judged while
  // every remote reads as absent.
  world.connected = false;
  await advance(t, HEAL_SETTLE_MS * 3);
  assert.deepEqual(world.clearsSince(sinceLatch), []);
  assert.equal(world.session.callMode().kind, "negotiating");
  // Back to Connected: without the re-arm the latch would stay red until
  // the next epoch (second re-review of the ledger).
  world.connected = true;
  world.session.noteSfuReconnected();
  await advance(t, HEAL_SETTLE_MS + 1_000);
  assert.deepEqual(world.clearsSince(sinceLatch), [
    { state: "clear", error: latched },
  ]);
  assert.equal(world.session.callMode().kind, "e2ee");
});

test("creator: a PRESENT witness holds across a reconnect (its SIDs persist; the re-arm proves nothing about it)", async (t) => {
  const world = newWorld(t, "creator", "ch-reconnect-present");
  await bringUpCreator(t, world);
  await latchLoud(t, world);
  const sinceLatch = world.states.length;
  // A new epoch without the peer ever leaving (a third member's churn).
  await advance(t, 1_000);
  await world.commit(1);
  await world.session.reconcileNow();
  await flush();
  world.connected = false;
  await advance(t, HEAL_SETTLE_MS * 3);
  world.connected = true;
  world.session.noteSfuReconnected();
  await advance(t, HEAL_SETTLE_MS * 2);
  assert.deepEqual(world.clearsSince(sinceLatch), []);
  assert.equal(world.session.callMode().kind, "negotiating");
});

test("creator: a witness re-added just before a reconnect heals only after a full settle once the Room is back", async (t) => {
  const world = newWorld(t, "creator", "ch-reconnect-readd");
  await bringUpCreator(t, world);
  const latched = await latchLoud(t, world);
  const sinceLatch = world.states.length;
  await advance(t, 1_000);
  await peerLeaves(world, 1);
  await advance(t, 1_000);
  await peerRejoins(world, 2, ["TR_new"]); // the settle is armed from here
  await advance(t, 2_000);
  world.connected = false; // the reconnect starts inside the settle
  await advance(t, HEAL_SETTLE_MS * 3);
  assert.deepEqual(world.clearsSince(sinceLatch), []);
  world.connected = true;
  world.session.noteSfuReconnected();
  await advance(t, HEAL_SETTLE_MS - 1_000);
  assert.deepEqual(world.clearsSince(sinceLatch), []); // not before the settle
  await advance(t, 2_000);
  assert.deepEqual(world.clearsSince(sinceLatch), [
    { state: "clear", error: latched },
  ]);
  assert.equal(world.session.callMode().kind, "e2ee");
});
