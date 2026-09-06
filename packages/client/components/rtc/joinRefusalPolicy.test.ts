// Unit spec for the join-refusal policy — run with Node's built-in runner:
//   node --test components/rtc/joinRefusalPolicy.test.ts   (Node >=23.6 strips types)
// Focus: exactly the server answers a retry cannot change are terminal, a
// terminal answer keeps THAT channel inert until the channel changes or the
// hold runs out, and an attempt already in flight for a channel is not
// restarted by another press — while joins for other channels stay free.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type JoinRefusalLatch,
  classifyJoinRefusal,
  JOIN_REFUSAL_HOLD_MS,
  joinBlockedReason,
  refusalHolds,
} from "./joinRefusalPolicy.ts";

test("the join_call answers a retry cannot change are terminal", () => {
  // Owner opt-in (the 2026-09-06 storm), permissions, capacity, and the
  // request-shape answers the same request would get again.
  for (const type of [
    "NotAVoiceChannel",
    "MissingPermission",
    "CannotJoinCall",
    "IsBot",
    "FailedValidation",
    "UnknownNode",
  ]) {
    assert.equal(
      classifyJoinRefusal({ type, location: "voice_join.rs:82" }),
      type,
    );
  }
});

test("outages, transport failures and non-API rejections are not refusals", () => {
  // A server outage is not a verdict about the channel — a later press must
  // be allowed to find LiveKit back.
  assert.equal(classifyJoinRefusal({ type: "LiveKitUnavailable" }), undefined);
  assert.equal(classifyJoinRefusal({ type: "InternalError" }), undefined);
  // fetch failing, a LiveKit ConnectionError, or nothing thrown at all.
  assert.equal(
    classifyJoinRefusal(new TypeError("Failed to fetch")),
    undefined,
  );
  assert.equal(
    classifyJoinRefusal({ name: "ConnectionError", message: "timeout" }),
    undefined,
  );
  assert.equal(classifyJoinRefusal(undefined), undefined);
  assert.equal(classifyJoinRefusal(null), undefined);
  assert.equal(classifyJoinRefusal("NotAVoiceChannel"), undefined);
  // A type-shaped field that is not a string is not an API error body.
  assert.equal(classifyJoinRefusal({ type: 400 }), undefined);
});

const latch = (over: Partial<JoinRefusalLatch> = {}): JoinRefusalLatch => ({
  channelId: "group",
  reason: "NotAVoiceChannel",
  at: 1_000,
  channelVersion: 3,
  ...over,
});

test("a refusal holds for the same channel version inside the hold window", () => {
  assert.equal(refusalHolds(latch(), { now: 1_000, channelVersion: 3 }), true);
  assert.equal(
    refusalHolds(latch(), {
      now: 1_000 + JOIN_REFUSAL_HOLD_MS - 1,
      channelVersion: 3,
    }),
    true,
  );
});

test("the hold ends at exactly JOIN_REFUSAL_HOLD_MS", () => {
  // The store's release timer fires at this instant; the pure rule must agree
  // with it or the UI and connect() would disagree for one tick.
  assert.equal(
    refusalHolds(latch(), {
      now: 1_000 + JOIN_REFUSAL_HOLD_MS,
      channelVersion: 3,
    }),
    false,
  );
});

test("any later update to the channel releases the refusal at once", () => {
  // The owner turning calls on, a permission change, a seat freeing up: the
  // server's answer may now differ, so the latch must not outlive the event
  // even when the hold is still fresh.
  assert.equal(refusalHolds(latch(), { now: 1_001, channelVersion: 4 }), false);
});

test("nothing blocks a channel with no attempt and no latch", () => {
  assert.equal(
    joinBlockedReason({
      channelId: "group",
      now: 5_000,
      channelVersion: 0,
      inFlightChannelId: undefined,
      latch: undefined,
    }),
    undefined,
  );
});

test("an attempt already in flight for the channel blocks a second press", () => {
  assert.equal(
    joinBlockedReason({
      channelId: "group",
      now: 5_000,
      channelVersion: 0,
      inFlightChannelId: "group",
      latch: undefined,
    }),
    "in-flight",
  );
});

test("a join in flight for another channel does not block — switching is supersession", () => {
  assert.equal(
    joinBlockedReason({
      channelId: "group",
      now: 5_000,
      channelVersion: 0,
      inFlightChannelId: "other",
      latch: undefined,
    }),
    undefined,
  );
});

test("a holding refusal blocks the channel it was given for, and only that one", () => {
  assert.equal(
    joinBlockedReason({
      channelId: "group",
      now: 1_500,
      channelVersion: 3,
      inFlightChannelId: undefined,
      latch: latch(),
    }),
    "refused",
  );
  // A latch keyed to a different channel never leaks onto this one.
  assert.equal(
    joinBlockedReason({
      channelId: "dm",
      now: 1_500,
      channelVersion: 3,
      inFlightChannelId: undefined,
      latch: latch({ channelId: "group" }),
    }),
    undefined,
  );
});

test("a released refusal no longer blocks", () => {
  // Expired by time …
  assert.equal(
    joinBlockedReason({
      channelId: "group",
      now: 1_000 + JOIN_REFUSAL_HOLD_MS,
      channelVersion: 3,
      inFlightChannelId: undefined,
      latch: latch(),
    }),
    undefined,
  );
  // … or by the channel changing.
  assert.equal(
    joinBlockedReason({
      channelId: "group",
      now: 1_500,
      channelVersion: 4,
      inFlightChannelId: undefined,
      latch: latch(),
    }),
    undefined,
  );
});

test("in flight wins over refused when both would apply", () => {
  // Only reachable if a caller bypassed the latch; the affordance should then
  // read as "joining", not flip to the refusal text mid-attempt.
  assert.equal(
    joinBlockedReason({
      channelId: "group",
      now: 1_500,
      channelVersion: 3,
      inFlightChannelId: "group",
      latch: latch(),
    }),
    "in-flight",
  );
});
