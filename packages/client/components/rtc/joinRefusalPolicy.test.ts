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

test("🔴 the device-not-registered refusal is named, and is still TERMINAL", () => {
  // An account switch on an enrolled desktop hits this, and the generic
  // `FailedValidation` copy ("The call couldn't be started right now") never
  // mentions encryption — so the user loses voice with no way to learn why.
  // Naming it changes NOTHING about what the client does: the join stays
  // refused, because delta builds that message with a catch-all `map_err` and
  // a database error says it too.
  assert.equal(
    classifyJoinRefusal({
      type: "FailedValidation",
      error: "joining device is not registered",
    }),
    "DeviceNotRegistered",
  );
  // Any other FailedValidation keeps the generic name.
  assert.equal(
    classifyJoinRefusal({
      type: "FailedValidation",
      error: "invalid bundle encoding",
    }),
    "FailedValidation",
  );
  // And it must still block a press-storm exactly as before.
  assert.equal(
    joinBlockedReason({
      channelId: "c",
      now: 1_000,
      channelVersion: 3,
      inFlightChannelId: undefined,
      latch: {
        channelId: "c",
        reason: "DeviceNotRegistered",
        at: 0,
        channelVersion: 3,
      },
    }),
    "refused",
  );
});

test("🔴 a corroborated device verdict supersedes its own refusal latch", () => {
  // The claim that proves the device is refused lands a beat after the join
  // that was refused for it, and the next attempt withholds the device id the
  // server rejected — so the server's answer WILL differ. Holding the user for
  // the rest of the 30 s punishes them for a race that a cold start into a
  // call loses every time (media-e2ee-reviewer round 3, finding 4).
  const latch = {
    channelId: "c",
    reason: "DeviceNotRegistered" as const,
    at: 0,
    channelVersion: 3,
  };
  assert.equal(refusalHolds(latch, { now: 1_000, channelVersion: 3 }), true);
  assert.equal(
    refusalHolds(latch, { now: 1_000, channelVersion: 3, superseded: true }),
    false,
  );
  assert.equal(
    joinBlockedReason({
      channelId: "c",
      now: 1_000,
      channelVersion: 3,
      inFlightChannelId: undefined,
      latch,
      superseded: true,
    }),
    undefined,
  );
});

test("a media-E2EE-off deployment refuses terminally instead of throwing at the caller", () => {
  // `require_media_e2ee_enabled` runs BEFORE the device check in
  // `voice_join.rs`, so any enrolled client that sends a device id on such a
  // deployment used to get an unhandled rejection and no dialog at all.
  assert.equal(
    classifyJoinRefusal({ type: "FeatureDisabled", feature: "media_e2ee" }),
    "MediaE2EEDisabled",
  );
  // 🔴 The discriminant, never the bare type: delta uses `FeatureDisabled`
  // right across the product (Android screen share, the /mls routes), and
  // classifying all of them would put unrelated refusals behind copy that
  // names encryption — and would newly latch channels for 30 s on them.
  assert.equal(
    classifyJoinRefusal({ type: "FeatureDisabled", feature: "screen_share" }),
    undefined,
  );
  assert.equal(classifyJoinRefusal({ type: "FeatureDisabled" }), undefined);
});
