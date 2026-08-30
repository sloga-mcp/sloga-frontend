// Specs for the Android screen-leg start-path policy (screen-leg plan §7.2) —
// run with Node's built-in runner:
//   node --test components/rtc/androidLegStartPolicy.test.ts
//
// These cover the window the original slice-3 code left unowned: everything
// between `prepare()` (OS consent granted, capture permitted) and `connect()`
// resolving. Throughout it the leg is NOT `active()`, so every §7.4 stop hook
// used to no-op against it — a hang-up, kick or publish gate during those
// seconds left the share to come up into a call that had already ended, and an
// MLS epoch rotation during them left it publishing under a key the rotation
// had just removed a member from.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type LegSendKey,
  keyActionAfterConnect,
  startAttemptCancelled,
  startAttemptStale,
} from "./androidLegStartPolicy.ts";

const world = (
  over: Partial<Parameters<typeof startAttemptStale>[0]> = {},
) => ({
  generation: 7,
  currentGeneration: 7,
  roomChanged: false,
  publishGateSize: 0,
  ...over,
});

test("an undisturbed attempt is not stale", () => {
  assert.equal(startAttemptStale(world()), false);
});

test("a stop hook during connect orphans the attempt", () => {
  // Every §7.4 hook bumps the generation BEFORE it looks at the leg, which is
  // the whole mechanism: the hook that fires while nothing is active yet is
  // exactly the one that has to cancel the start.
  assert.equal(startAttemptStale(world({ currentGeneration: 8 })), true);
});

test("a competing tap orphans the earlier attempt, not the later one", () => {
  // Second tap claimed 8; the first attempt still holds 7 and must abandon.
  assert.equal(startAttemptStale(world({ currentGeneration: 8 })), true);
  assert.equal(
    startAttemptStale(world({ generation: 8, currentGeneration: 8 })),
    false,
  );
});

test("leaving or switching the call orphans the attempt", () => {
  assert.equal(startAttemptStale(world({ roomChanged: true })), true);
});

test("any publish-gate reason orphans the attempt", () => {
  // §0.4: the leg STOPS whenever the primary pauses. A share must never come
  // up into a call that is re-securing or mixed.
  assert.equal(startAttemptStale(world({ publishGateSize: 1 })), true);
  assert.equal(startAttemptStale(world({ publishGateSize: 3 })), true);
});

test("a stop hook or a leave CANCELS the attempt", () => {
  // Cancellation = somebody claimed the leg, so the attempt's own failure is
  // expected and must not be reported to the user.
  assert.equal(startAttemptCancelled(world({ currentGeneration: 8 })), true);
  assert.equal(startAttemptCancelled(world({ roomChanged: true })), true);
});

test("🔴 a held publish gate is NOT a cancellation", () => {
  // The attempt still abandons (startAttemptStale is true), but nobody asked
  // for this share to end. Treating the gate as a cancellation swallowed the
  // error toast for a GENUINE failure — a route rejection landing while a
  // re-secure pulse briefly held the gate left the user's explicit tap with
  // no feedback at all.
  assert.equal(startAttemptCancelled(world({ publishGateSize: 1 })), false);
  assert.equal(startAttemptStale(world({ publishGateSize: 1 })), true);
});

test("an undisturbed attempt is not cancelled", () => {
  assert.equal(startAttemptCancelled(world()), false);
});

test("each condition is independently sufficient", () => {
  // Negative control for the three-way OR: none of these may be masked by the
  // others being clean.
  for (const over of [
    { currentGeneration: 8 },
    { roomChanged: true },
    { publishGateSize: 1 },
  ]) {
    assert.equal(startAttemptStale(world(over)), true, JSON.stringify(over));
  }
});

const key = (
  keyB64: string,
  keyIndex: number,
  over: Partial<Pick<LegSendKey, "epoch" | "groupId">> = {},
): LegSendKey => ({
  keyB64,
  keyIndex,
  epoch: 4,
  groupId: "group-1",
  ...over,
});

test("no re-key when the epoch did not move during connect", () => {
  assert.deepEqual(keyActionAfterConnect(key("AAA", 1), key("AAA", 1)), {
    kind: "none",
  });
});

test("a rotation during connect is pushed once the sender exists", () => {
  // The dropped-rotation case: `onLocalScreenKey` saw this while the leg was
  // still connecting and returned, so the attempt reconciles here instead.
  assert.deepEqual(
    keyActionAfterConnect(key("AAA", 1), key("BBB", 2, { epoch: 5 })),
    { kind: "push", key: key("BBB", 2, { epoch: 5 }) },
  );
});

test("changed key MATERIAL at the same index still re-keys", () => {
  // A key index is unique only within an epoch, so two epochs can reuse one.
  // Comparing indices alone would skip a required rotation and leave the leg
  // publishing under the key a removed member holds.
  assert.deepEqual(
    keyActionAfterConnect(key("AAA", 1), key("BBB", 1, { epoch: 20 })),
    { kind: "push", key: key("BBB", 1, { epoch: 20 }) },
  );
});

test("an epoch move alone still re-keys", () => {
  // Defense in depth alongside the material comparison: the epoch is the
  // fence the native side orders pushes by, so it must travel even when the
  // material/index pair happens to collide.
  assert.deepEqual(
    keyActionAfterConnect(key("AAA", 1), key("AAA", 1, { epoch: 5 })),
    { kind: "push", key: key("AAA", 1, { epoch: 5 }) },
  );
});

test("a key from a different group STOPS the leg instead of re-keying", () => {
  // A group re-establish raced the connect. Epochs are only comparable
  // within one group, so the native fence cannot order these two keys — the
  // only safe answer is to stop the leg and let the user share again.
  assert.deepEqual(
    keyActionAfterConnect(
      key("AAA", 1),
      key("BBB", 2, { epoch: 0, groupId: "group-2" }),
    ),
    { kind: "stop" },
  );
});

test("a plaintext leg is never handed a key here", () => {
  // An unannounced upgrade would be a downgrade of a different kind: the rest
  // of the call has not agreed to it.
  assert.deepEqual(keyActionAfterConnect(undefined, key("AAA", 1)), {
    kind: "none",
  });
});

test("no current key means nothing to push", () => {
  assert.deepEqual(keyActionAfterConnect(key("AAA", 1), undefined), {
    kind: "none",
  });
});
