// Session-level specs for D10, a locked phone mid-call: the drain action
// `hold_locked` (`mlsDrainPolicy.ts`), on the shared world in
// `mlsCallSession.harness.ts`.
//   node --test --conditions=browser components/rtc/mlsCallSession.locked.test.ts
//
// Native could not open the store (`protector_locked`, or plain `protector`):
// the envelope was NOT applied and this device is behind the group, while the
// store itself is intact. So the envelope is never acked, never dropped and
// never answered with a rejoin (each loses state); it stays off `#seen` and is
// re-fed on a backed-off delay; the call goes LOUD (a control latch, so the
// publish gate holds) and stays loud for the call; the first delivery after
// the unlock processes normally.
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import type { MlsEnvelope } from "@revolt/client";

import { CallProtectorLockedError } from "../client/e2eeCallPlaneIos.ts";
import {
  type EncryptionStateCall,
  type World,
  advance,
  bringUpCreator,
  flush,
  GROUP,
  newWorld,
  SELF,
} from "./mlsCallSession.harness.ts";

const ENCRYPTION_UNCONFIRMED = "This call's encryption could not be confirmed";
/** What iOS rejects `e2ee_call_process` with on a locked phone (`nativeRejectError`). */
const LOCKED_COPY =
  "Unlock your phone, then try again. Your encryption key can't be read while it's locked. Nothing was sent.";

function loudsSince(world: World, index: number): EncryptionStateCall[] {
  return world.states.slice(index).filter((s) => s.state === "loud");
}

function processCalls(world: World): number {
  return world.bridgeCalls.filter((n) => n === "processEnvelope").length;
}

/**
 * Acks sent so far. Nothing else in these specs acks, so a held envelope
 * leaves this unchanged and its eventual application moves it.
 */
function acks(world: World): number {
  return world.bridgeCalls.filter((n) => n === "ackEnvelopes").length;
}

/** A commit at `epoch` into the live sink, native rejecting it with `rejection`. */
function lockedCommit(world: World, epoch: number, rejection: unknown): string {
  const envelope: MlsEnvelope = {
    id: `env-locked-${epoch}`,
    content_type: "mls_commit",
    group_id: GROUP,
    epoch,
    ciphertext: "",
  };
  world.outcomes.set(envelope.id, {
    group_id: GROUP,
    kind: "commit_applied",
    epoch,
    removed_self: false,
    removed: [],
  });
  world.rejections.set(envelope.id, rejection);
  assert.ok(world.sink, "the session registered no sink");
  world.sink({ kind: "envelope", envelope, recipientDeviceId: SELF.device_id });
  return envelope.id;
}

async function greenCall(t: TestContext, channelId: string): Promise<World> {
  const world = newWorld(t, "creator", channelId);
  await bringUpCreator(t, world);
  await advance(t, 3_000);
  assert.equal(world.publishing(), true);
  return world;
}

test("🔴 a locked store holds the envelope (no ack, no drop, no rejoin) and the call goes loud with the readable error", async (t) => {
  const world = await greenCall(t, "ch-locked");
  const before = world.states.length;
  const error = new CallProtectorLockedError(LOCKED_COPY);
  const ackMark = acks(world);
  const start = processCalls(world);
  lockedCommit(world, 1, error);
  await flush();

  assert.equal(
    processCalls(world) - start,
    1,
    "the envelope never reached native",
  );
  assert.equal(acks(world), ackMark, "the held envelope was acked");
  assert.deepEqual(loudsSince(world, before), [
    { state: "loud", error, meta: { origin: "control", mediaKeyed: true } },
  ]);
  assert.equal(world.session.callMode().kind, "negotiating");
  assert.equal(world.publishing(), false, "the gate did not hold while locked");

  // A long lock: still held, never poison-dropped past the retry cap, never
  // answered with a rejoin, and only the ONE loud.
  await advance(t, 60_000);
  assert.ok(
    processCalls(world) - start > 6,
    "the held envelope was not re-fed",
  );
  assert.equal(
    acks(world),
    ackMark,
    "a long lock acked (dropped) the envelope",
  );
  assert.equal(world.session.state(), "active");
  assert.equal(
    world.session.groupId(),
    GROUP,
    "a lock was answered by a rejoin",
  );
  assert.equal(loudsSince(world, before).length, 1);
  assert.equal(world.publishing(), false);
});

test("🔴 the unlock: the next delivery processes normally, and the call stays latched loud", async (t) => {
  const world = await greenCall(t, "ch-unlock");
  const before = world.states.length;
  const ackMark = acks(world);
  const id = lockedCommit(world, 1, new CallProtectorLockedError(LOCKED_COPY));
  await flush();
  await advance(t, 3_000);
  assert.equal(acks(world), ackMark);

  world.rejections.delete(id); // the phone is unlocked
  await advance(t, 5_000); // at most one capped backoff
  assert.equal(acks(world), ackMark + 1, "the unlocked envelope never applied");
  world.epoch = 1; // native applied it; its keys-changed follows
  await world.session.onLocalKeysChanged(GROUP, 1);
  await flush();
  await advance(t, 30_000);
  assert.deepEqual(
    world.states.slice(before).filter((s) => s.state === "clear"),
    [],
    "the unlock healed the latch within the call",
  );
  assert.equal(world.publishing(), false);
  assert.equal(world.terminalLoud(), true);
});

test("🔴 the re-feed backs off while locked: 500 ms doubling to a 5 s cap", async (t) => {
  const world = await greenCall(t, "ch-backoff");
  const start = processCalls(world);
  lockedCommit(world, 1, new CallProtectorLockedError(LOCKED_COPY));
  await flush();
  assert.equal(processCalls(world) - start, 1);
  // Re-feeds at +0.5, +1.5, +3.5, +7.5 s, then every 5 s.
  await advance(t, 7_750);
  assert.equal(processCalls(world) - start, 5, "not doubling from 500 ms");
  await advance(t, 5_000);
  assert.equal(processCalls(world) - start, 6, "not capped at 5 s");
  await advance(t, 30_000);
  assert.equal(
    processCalls(world) - start,
    12,
    "a locked phone was polled hot",
  );
});

test("plain `protector` (not iOS-specific) holds the same way, latched with the curated error", async (t) => {
  const world = await greenCall(t, "ch-protector");
  const before = world.states.length;
  const ackMark = acks(world);
  lockedCommit(world, 1, { type: "protector" });
  await flush();
  await advance(t, 2_000);
  assert.equal(acks(world), ackMark, "plain protector was acked");
  const louds = loudsSince(world, before);
  assert.equal(louds.length, 1);
  assert.equal((louds[0].error as Error).message, ENCRYPTION_UNCONFIRMED);
  assert.equal(louds[0].meta?.origin, "control");
  assert.equal(world.publishing(), false);
});

test("the backoff resets once the store opens: a later lock is re-fed at 500 ms again", async (t) => {
  const world = await greenCall(t, "ch-backoff-reset");
  const ackMark = acks(world);
  const first = lockedCommit(world, 1, new CallProtectorLockedError("x"));
  await flush();
  await advance(t, 8_000); // backed off to the cap
  world.rejections.delete(first);
  await advance(t, 5_000);
  assert.equal(acks(world), ackMark + 1, "the unlocked envelope never applied");

  const start = processCalls(world);
  lockedCommit(world, 2, new CallProtectorLockedError("x"));
  await flush();
  await advance(t, 600);
  assert.equal(processCalls(world) - start, 2, "the backoff did not reset");
});
