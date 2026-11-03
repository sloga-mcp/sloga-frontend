// Session-level specs for `noteFatalMediaError` (Stage 5 fix F3), on the
// shared world in `mlsCallSession.harness.ts`.
//   node --test --conditions=browser components/rtc/mlsCallSession.fatal.test.ts
//
// `state.tsx` routes the failures no remote evidence can answer here: a dead
// E2EE worker, a lost key push, an overdue WebKit sender hold, a handleSender
// failure from before the session existed. Through `noteEncryptionError`
// they took the media-plane path, which inside a rotation window is a
// re-securing debounce (amber, still publishing, for the escalation bound)
// and then a MEDIA latch the heal may clear on peer evidence. The fatal
// path is the `LocalKeyAckError` terminus instead: the gate holds at once
// and a CONTROL latch, read un-keyed, that nothing remote clears.
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import { LocalKeyAckError } from "./mlsCallKeys.ts";
import {
  type EncryptionStateCall,
  type World,
  advance,
  bringUpCreator,
  flush,
  GROUP,
  HEAL_SETTLE_MS,
  latchLoud,
  newWorld,
  PEER_ID,
  peerLeaves,
} from "./mlsCallSession.harness.ts";

function louds(world: World, index: number): EncryptionStateCall[] {
  return world.states.slice(index).filter((s) => s.state === "loud");
}

function clears(world: World, index: number): EncryptionStateCall[] {
  return world.states.slice(index).filter((s) => s.state === "clear");
}

function fatal(world: World, error: Error): void {
  const fn = (
    world.session as unknown as { noteFatalMediaError?: (e: Error) => void }
  ).noteFatalMediaError;
  assert.equal(typeof fn, "function", "noteFatalMediaError missing");
  fn!.call(world.session, error);
}

/** A green call inside an Add rotation's window, past its own grace install. */
async function insideRotationWindow(
  t: TestContext,
  channelId: string,
): Promise<World> {
  const world = newWorld(t, "creator", channelId);
  await bringUpCreator(t, world);
  await advance(t, 3_000);
  await world.commit(1); // an Add: grace + settle = a 4 s window
  await advance(t, 2_500); // past the grace, still inside the window
  assert.equal(world.publishing(), true);
  return world;
}

/** Everything a remote can offer: an SFU echo, a clean witness, a departure. */
async function remoteEvidence(t: TestContext, world: World): Promise<void> {
  world.session.noteEncryptionRecovered();
  await flush();
  await advance(t, 1_000);
  await peerLeaves(world, 2);
  await advance(t, HEAL_SETTLE_MS * 3);
}

test("🔴 inside a rotation window a fatal error latches at once, holds the gate, and no remote evidence clears it", async (t) => {
  const world = await insideRotationWindow(t, "ch-fatal");
  const before = world.states.length;
  const error = new Error("the E2EE worker stopped answering");
  fatal(world, error);
  await flush();
  assert.deepEqual(louds(world, before), [
    { state: "loud", error, meta: { origin: "control", mediaKeyed: false } },
  ]);
  assert.equal(world.publishing(), false, "kept publishing over a dead path");
  assert.equal(world.session.callMode().kind, "negotiating");
  assert.equal(world.chip(), "not_encrypted");
  assert.equal(
    world.chip({
      decodeWitness: { available: true, dropping: [], live: [PEER_ID] },
    }),
    "not_encrypted",
    "a clean witness softened the fatal latch",
  );

  await remoteEvidence(t, world);
  assert.deepEqual(clears(world, before), [], "remote evidence healed it");
  assert.equal(world.publishing(), false);
  assert.equal(world.terminalLoud(), true);
});

test("COMPARISON: the same error through noteEncryptionError is debounced while publishing, then a media latch the heal clears", async (t) => {
  // Why state.tsx must not route these through `noteEncryptionError`.
  const world = await insideRotationWindow(t, "ch-fatal-compare");
  const before = world.states.length;
  const error = new Error("InvalidKey: Decryption failed: x");
  world.session.noteEncryptionError(error);
  await flush();
  assert.deepEqual(louds(world, before), [], "no debounce inside the window");
  assert.equal(world.publishing(), true, "the debounce paused publishing");

  await advance(t, 11_000); // RESECURE_ESCALATE_MS
  const latched = louds(world, before);
  assert.equal(latched.length, 1);
  assert.equal(latched[0].meta?.origin, "media");

  await remoteEvidence(t, world);
  assert.deepEqual(
    clears(world, before).map((c) => c.error),
    [error],
    "the media latch did not heal on the peer's departure",
  );
});

test("over a MEDIA latch it upgrades to control in one emission and is never downgraded", async (t) => {
  const world = newWorld(t, "creator", "ch-fatal-upgrade");
  await bringUpCreator(t, world);
  const media = await latchLoud(t, world);
  const before = world.states.length;
  const error = new Error("a key push was lost");
  fatal(world, error);
  await flush();
  assert.deepEqual(world.states.slice(before), [
    {
      state: "loud",
      error,
      meta: { origin: "control", mediaKeyed: false, replaces: media },
    },
  ]);
  await remoteEvidence(t, world);
  assert.deepEqual(clears(world, before), [], "the upgraded latch healed");
  assert.equal(world.publishing(), false);
});

test("in a `mixed` call it takes the same terminus: the mode drops to negotiating, under the latched banner", async (t) => {
  // `#latchLoud` alone folds only `e2ee`; the explicit drop is what makes a
  // mixed call's fatal error the terminal banner with its escape, exactly as
  // `#onRotationError` does for the two local-key classes.
  const world = newWorld(t, "creator", "ch-fatal-mixed");
  await bringUpCreator(t, world);
  world.sfu = [...world.sfu, "dave"];
  world.sids.set("dave", ["TR_d"]);
  await world.session.reconcileNow();
  await flush();
  assert.equal(world.session.callMode().kind, "mixed");
  fatal(world, new Error("the E2EE worker stopped answering"));
  await flush();
  assert.equal(world.session.callMode().kind, "negotiating");
  assert.equal(world.terminalLoud(), true);
  assert.equal(world.publishing(), false);
});

test("idempotent under a control latch: a second fatal error adds nothing", async (t) => {
  const world = newWorld(t, "creator", "ch-fatal-twice");
  await bringUpCreator(t, world);
  const first = new Error("first");
  fatal(world, first);
  await flush();
  const before = world.states.length;
  fatal(world, new Error("second"));
  await flush();
  assert.deepEqual(world.states.slice(before), []);
  assert.equal(world.publishing(), false);
});

test("🔴 a fatal error replayed at start() survives the join route's reset: never cleared, the gate held", async (t) => {
  // `state.tsx` replays a buffered pre-session fatal error right after
  // `void session.start()`; the join route then resets the rotation state
  // (`#resetRotationState`), which clears ordinary latches.
  const world = newWorld(t, "joiner", "ch-fatal-join");
  void world.session.start();
  const error = new Error("handleSender failed before the session existed");
  fatal(world, error);
  await flush();
  await advance(t, 1); // the establish runs up to the Welcome wait
  assert.ok(world.bridgeCalls.includes("mlsJoinIntent"), "not the join route");
  await world.welcome(5);
  await world.session.onLocalKeysChanged(GROUP, 5);
  await flush();
  await advance(t, 5_000);

  assert.deepEqual(clears(world, 0), [], "the join's reset cleared the latch");
  assert.deepEqual(
    louds(world, 0).map((s) => s.error),
    [error],
    "not exactly the one fatal latch",
  );
  assert.equal(world.publishing(), false, "published under a cleared latch");
  assert.equal(world.session.callMode().kind, "negotiating");
  assert.equal(world.chip(), "not_encrypted");
});

test("🔴 a fatal latch survives a later re-establish (a fresh rejoin) too", async (t) => {
  const world = newWorld(t, "creator", "ch-fatal-rejoin");
  await bringUpCreator(t, world);
  const before = world.states.length;
  const error = new Error("the E2EE worker stopped answering");
  fatal(world, error);
  await flush();
  const calls = world.bridgeCalls.length;
  // Removed while still in the SFU: the session tears the group down and
  // re-establishes, through `#resetRotationState`.
  await world.removedSelf(1);
  await advance(t, 1);
  await advance(t, 15_000);
  assert.ok(
    world.bridgeCalls.slice(calls).includes("callLeaveCleanup"),
    "no re-establish ran",
  );
  assert.deepEqual(clears(world, before), [], "the re-establish cleared it");
  assert.equal(world.publishing(), false);
  assert.equal(world.terminalLoud(), true);
});

test("a fatal error noted UNDER an existing control latch still pins that latch across a re-establish", async (t) => {
  // A NON-fatal control latch first (an unacknowledged local key, through the
  // Add-grace seam), so the fatal note is the no-op re-latch case.
  const world = newWorld(t, "creator", "ch-fatal-under-control");
  await bringUpCreator(t, world);
  world.failLocalKeyOnce(new LocalKeyAckError(GROUP, 1, 1));
  await world.commit(1);
  await advance(t, 2_000);
  await flush();
  assert.equal(world.localKeyFailure, null, "the scripted throw never fired");
  assert.equal(world.terminalLoud(), true);
  const before = world.states.length;
  fatal(world, new Error("the worker died as well"));
  await flush();
  assert.deepEqual(world.states.slice(before), []);
  await world.removedSelf(1);
  await advance(t, 1);
  await advance(t, 15_000);
  assert.deepEqual(clears(world, before), []);
  assert.equal(world.publishing(), false);
});

test("a closed session reports nothing", async (t) => {
  const world = newWorld(t, "creator", "ch-fatal-closed");
  await bringUpCreator(t, world);
  world.session.dispose();
  await flush();
  const before = world.states.length;
  fatal(world, new Error("late"));
  await flush();
  assert.deepEqual(world.states.slice(before), []);
});
