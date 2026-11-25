// Session-level specs for a key install that outlives its group, on the
// shared world in `mlsCallSession.harness.ts`.
//   node --test --conditions=browser components/rtc/mlsCallSession.resetrace.test.ts
//
// `onLocalKeysChanged` and the Add-grace timer await the installer, and the
// group can be REPLACED during that await: `#resetRotationState` (a
// re-establish, a poisoned successor, a removed-self rejoin) drops the key
// state, `#hasLocalKey` included, for the group that follows. The install
// then resolved into the new group's bookkeeping: `#onLocalKeyInstalled` set
// `#hasLocalKey` before the new group installed anything, so the next
// reconcile enabled E2EE and lifted the gate on whatever key the encoder
// still held (the replaced group's, which the members who removed us hold).
// A late throw latched the new group loud for the old one's failure. The
// provider refuses such an install on its own side
// (`mlsCallKeys.test.ts`, "A group replaced mid-install"); these pin the
// session's half.
//
// Each spec names the mutation it kills (`scripts/rtc-mutations.py`).
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import { LocalKeyAckError } from "./mlsCallKeys.ts";
import {
  type World,
  advance,
  bringUpJoiner,
  flush,
  GROUP,
  newWorld,
  PEER,
  SELF_ID,
} from "./mlsCallSession.harness.ts";

/** Every `loud` error the media-plane callback reported, in order. */
function louds(world: World): unknown[] {
  return world.journal.flatMap((entry) =>
    entry.kind === "state" && entry.state === "loud" ? [entry.error] : [],
  );
}

/** The installs entered since `from`, as `method@epoch`. */
function installsSince(world: World, from: number): string[] {
  return world.keyInstalls
    .slice(from)
    .map(({ method, epoch }) => `${method}@${epoch}`);
}

/**
 * Kicked while still in the SFU: `#onRemovedSelf` → `#rejoinFresh`, which
 * runs `#resetRotationState` and a fresh join ladder.
 */
async function kickedAndRejoining(
  t: TestContext,
  world: World,
  epoch: number,
): Promise<void> {
  assert.ok(world.sfu.includes(SELF_ID));
  const intents = world.joinIntents();
  await world.removedSelf(epoch);
  await advance(t, 1); // `#onRemovedSelf` runs as a 0 ms group action
  assert.equal(world.session.state(), "resecuring");
  assert.equal(world.joinIntents(), intents + 1, "no re-establish ran");
}

/**
 * The new incarnation's Welcome lands with its own key install held: until
 * that install lands nothing may enable, and once it does the call is green.
 */
async function newGroupWaitsForItsOwnKey(
  t: TestContext,
  world: World,
  epoch: number,
): Promise<void> {
  const release = world.holdKeyInstall();
  await world.welcome(epoch);
  assert.equal(world.session.state(), "active");
  await advance(t, 5_000);
  assert.notEqual(
    world.session.callMode().kind,
    "e2ee",
    "the new group enabled E2EE on the replaced group's install",
  );
  assert.equal(
    world.publishing(),
    false,
    "the new group published before its own send key installed",
  );
  release();
  await world.session.onLocalKeysChanged(GROUP, epoch);
  await flush();
  assert.equal(world.session.callMode().kind, "e2ee", "the keys never enabled");
  assert.equal(world.publishing(), true);
}

test("🔴 an immediate install the rejoin replaced under it claims no send key for the new group", async (t) => {
  // session-install-ignores-reset, session-reset-gen-not-bumped
  const world = newWorld(t, "joiner", "ch-resetrace-immediate");
  await bringUpJoiner(t, world, 0);
  assert.equal(world.chip(), "e2ee");

  const release = world.holdKeyInstall();
  const installs = world.keyInstalls.length;
  // A Remove-driven epoch: the immediate path (`applyKeys`).
  const stale = world.commit(1, [PEER]);
  await flush();
  assert.deepEqual(installsSince(world, installs), ["applyKeys@1"]);

  await kickedAndRejoining(t, world, 2);
  release();
  await stale;
  await flush();
  assert.equal(world.session.state(), "resecuring");

  await newGroupWaitsForItsOwnKey(t, world, 3);
  assert.deepEqual(louds(world), []);
});

test("🔴 an Add-grace local install the rejoin replaced under it claims no send key for the new group", async (t) => {
  // session-grace-ignores-reset
  const world = newWorld(t, "joiner", "ch-resetrace-grace");
  await bringUpJoiner(t, world, 0);
  await world.commit(1); // an inbound Add: remotes now, our key deferred

  const release = world.holdKeyInstall();
  const installs = world.keyInstalls.length;
  await advance(t, 2_000); // ADD_GRACE_MS: the fenced timer runs and parks
  assert.deepEqual(installsSince(world, installs), ["applyLocalKey@1"]);

  await kickedAndRejoining(t, world, 2);
  release();
  await flush();
  assert.equal(world.session.state(), "resecuring");

  await newGroupWaitsForItsOwnKey(t, world, 3);
  assert.deepEqual(louds(world), []);
});

test("🔴 an Add-grace remote install the rejoin replaced under it schedules no local install into the new group", async (t) => {
  // session-grace-remote-ignores-reset
  const world = newWorld(t, "joiner", "ch-resetrace-grace-remote");
  await bringUpJoiner(t, world, 0);

  const release = world.holdKeyInstall();
  const installs = world.keyInstalls.length;
  const stale = world.commit(1); // an inbound Add: remotes now, our key deferred
  await flush();
  assert.deepEqual(installsSince(world, installs), ["applyRemoteKeys@1"]);

  await kickedAndRejoining(t, world, 2);
  // The new incarnation reuses epoch 1, and its first key parks behind the
  // same hold, so the replaced group's install resumes after the new one
  // already cancelled any pending grace.
  await world.welcome(1);
  const fresh = world.session.onLocalKeysChanged(GROUP, 1);
  await flush();
  release();
  await stale;
  await fresh;
  await flush();

  const settled = world.keyInstalls.length;
  await advance(t, 5_000); // well past ADD_GRACE_MS
  assert.deepEqual(
    installsSince(world, settled),
    [],
    "the replaced group's deferred local install fired into the new group",
  );
  assert.deepEqual(louds(world), []);
});

test("🔴 a replaced group's install that throws late does not latch the new group loud", async (t) => {
  // session-install-error-ignores-reset
  const world = newWorld(t, "joiner", "ch-resetrace-throw");
  await bringUpJoiner(t, world, 0);
  const error = new LocalKeyAckError(GROUP, 1, 1);
  world.failHeldLocalKeyOnce(error);

  const release = world.holdKeyInstall();
  const stale = world.commit(1, [PEER]);
  await flush();
  await kickedAndRejoining(t, world, 2);
  release();
  await stale;
  await flush();
  assert.equal(
    world.heldLocalKeyFailure,
    null,
    "the scripted throw never fired",
  );

  // Routed to `#onRotationError` this was the control terminus: an
  // un-keyed latch the new group's own install could never heal.
  assert.deepEqual(
    louds(world),
    [],
    "the replaced group's failure latched loud",
  );
  assert.equal(world.terminalLoud(), false);
  assert.equal(world.session.state(), "resecuring");

  await newGroupWaitsForItsOwnKey(t, world, 3);
  assert.deepEqual(louds(world), []);
});

test("🔴 a replaced group's Add-grace install that throws late does not latch the new group loud", async (t) => {
  // session-grace-error-ignores-reset
  const world = newWorld(t, "joiner", "ch-resetrace-grace-throw");
  await bringUpJoiner(t, world, 0);
  await world.commit(1); // an inbound Add: remotes now, our key deferred
  const error = new LocalKeyAckError(GROUP, 1, 1);
  world.failHeldLocalKeyOnce(error);

  const release = world.holdKeyInstall();
  const installs = world.keyInstalls.length;
  await advance(t, 2_000); // ADD_GRACE_MS: the fenced timer runs and parks
  assert.deepEqual(installsSince(world, installs), ["applyLocalKey@1"]);
  await kickedAndRejoining(t, world, 2);
  release();
  await flush();
  assert.equal(
    world.heldLocalKeyFailure,
    null,
    "the scripted throw never fired",
  );

  assert.deepEqual(
    louds(world),
    [],
    "the replaced group's failure latched loud",
  );
  assert.equal(world.terminalLoud(), false);
  assert.equal(world.session.state(), "resecuring");
});

test("🔴 a fetch the rejoin replaced under it installs nothing, even at an epoch the new group reached", async (t) => {
  // session-gen-captured-after-fetch, session-fetch-ignores-reset
  const world = newWorld(t, "joiner", "ch-resetrace-fetch");
  await bringUpJoiner(t, world, 0);

  const releaseFetch = world.holdFrameKeys();
  const installs = world.keyInstalls.length;
  const stale = world.commit(1, [PEER]); // parks on its frame-key fetch
  await flush();
  assert.deepEqual(installsSince(world, installs), []);

  await kickedAndRejoining(t, world, 2);
  // The new incarnation (same id) reaches epoch 1 too, so the stale reply
  // passes the group and epoch re-checks after its fetch.
  await world.welcome(1);
  const releaseInstall = world.holdKeyInstall();
  const fresh = world.session.onLocalKeysChanged(GROUP, 1);
  await flush();
  releaseFetch();
  await flush();
  assert.deepEqual(
    installsSince(world, installs),
    ["applyKeys@1"],
    "the replaced group's fetched keys went to the installer",
  );
  releaseInstall();
  await stale;
  await fresh;
  await flush();
  assert.equal(world.session.callMode().kind, "e2ee");
  assert.deepEqual(louds(world), []);
});

test("🔴 a fetch the rejoin replaced under it that fails late raises nothing for the new group", async (t) => {
  // session-fetch-error-ignores-reset
  const world = newWorld(t, "joiner", "ch-resetrace-fetch-throw");
  await bringUpJoiner(t, world, 0);

  const releaseFetch = world.holdFrameKeys();
  const error = new Error("mls_group_not_found");
  world.failHeldFrameKeysOnce(error);
  const stale = world.commit(1, [PEER]);
  await flush();
  await kickedAndRejoining(t, world, 2);
  releaseFetch();
  await stale;
  await flush();
  assert.equal(world.frameKeysFailure, null, "the scripted throw never fired");
  // Routed to `#onMediaError` it was ledgered and surfaced as the new
  // group's re-securing cause.
  assert.notEqual(world.session.lastError(), error);
  assert.equal(
    world.journal.some(
      (entry) => entry.kind === "state" && entry.error === error,
    ),
    false,
    "the replaced group's fetch failure surfaced on the new group",
  );

  await newGroupWaitsForItsOwnKey(t, world, 3);
  await advance(t, 30_000); // past every re-securing debounce
  assert.deepEqual(louds(world), []);
  assert.equal(world.session.callMode().kind, "e2ee");
});

test("CONTROL: a held install with no reset under it still claims the send key", async (t) => {
  // Proves the specs above park a REAL install: the same hold and release,
  // minus the rejoin, ends with the key claimed, and the same late throw
  // takes the terminus it always took.
  const world = newWorld(t, "joiner", "ch-resetrace-control");
  await bringUpJoiner(t, world, 0);
  const error = new LocalKeyAckError(GROUP, 1, 1);
  world.failHeldLocalKeyOnce(error);
  const release = world.holdKeyInstall();
  const stale = world.commit(1, [PEER]);
  await flush();
  release();
  await stale;
  await flush();
  assert.equal(
    world.heldLocalKeyFailure,
    null,
    "the scripted throw never fired",
  );
  assert.deepEqual(louds(world), [error]);
  assert.equal(world.terminalLoud(), true);
});
