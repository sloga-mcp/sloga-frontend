// Spec for `protectedSeatUiPolicy.ts` (S2-W4-3 lane U8b): the pure rules of
// the owner seat UI (D39 released seats, cap clamp, device column, removal
// waiting; D40 reason refusals; F3 discard answers). The components' wiring
// stays pinned in their scan tests (`protectedSeatPicker.scan.test.ts`).
//
// Run from packages/client:
//   node --conditions=browser --test components/client/protectedSeatUiPolicy.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { reasonRefusal } from "./protectedRemovalReasonPolicy.ts";
import {
  REMOVAL_WAITING_MS,
  SEAT_RELEASE_CAUSES,
  seatAdds,
  seatClientReason,
  seatDeviceCounts,
  seatDiscardOutcome,
  seatFailureBody,
  seatReasonRequired,
  seatReleasedRows,
  seatRemovalsWaiting,
  seatUntilText,
  seatUsedCount,
} from "./protectedSeatUiPolicy.ts";

const OWNER = "owner";
const set = (...ids: string[]) => new Set(ids);

test("SEAT_RELEASE_CAUSES: the wire's four causes, in design 2.3 order", () => {
  assert.deepEqual(
    [...SEAT_RELEASE_CAUSES],
    ["owner_unseat", "server_removal", "access_lost", "device_never_joined"],
  );
});

test("seatReleasedRows: cause validated (unknown = none), a user once, malformed skipped", () => {
  const rows = seatReleasedRows([
    {
      user_id: "a",
      released_at: "x",
      cooldown_until: "2026-10-15T12:00:00.000Z",
      cause: "server_removal",
    },
    { user_id: "b", cooldown_until: "y", cause: "owner_unseat" },
    { user_id: "c", cause: "access_lost" },
    { user_id: "d", cause: "device_never_joined" },
    // an unknown cause is no cause, never another one
    { user_id: "e", cause: "kicked_by_mallory" },
    { user_id: "f", cause: 7 },
    // no cause: a non-owner read
    { user_id: "g" },
    // malformed or repeated
    { user_id: "" },
    { user_id: 5 },
    null,
    "h",
    { user_id: "a", cause: "access_lost" },
  ]);
  assert.deepEqual(rows, [
    {
      userId: "a",
      cause: "server_removal",
      until: "2026-10-15T12:00:00.000Z",
    },
    { userId: "b", cause: "owner_unseat", until: "y" },
    { userId: "c", cause: "access_lost", until: null },
    { userId: "d", cause: "device_never_joined", until: null },
    { userId: "e", cause: null, until: null },
    { userId: "f", cause: null, until: null },
    { userId: "g", cause: null, until: null },
  ]);
  assert.deepEqual(seatReleasedRows(undefined), []);
  assert.deepEqual(seatReleasedRows({ user_id: "a" }), []);
});

test("seatUntilText: an unreadable time is no line", () => {
  assert.equal(seatUntilText(null), null);
  assert.equal(seatUntilText(""), null);
  assert.equal(seatUntilText("y"), null);
  assert.equal(typeof seatUntilText("2026-10-15T12:00:00.000Z"), "string");
});

test("seatUsedCount: cooling seats count, a re-seat of a cooling user counts once", () => {
  assert.equal(seatUsedCount([OWNER, "a"], ["b", "a"]), 3);
  assert.equal(seatUsedCount([OWNER, "a"], []), 2);
  assert.equal(seatUsedCount([OWNER], set("b", "c")), 3);
  assert.equal(seatUsedCount([OWNER, "a", "a"], ["a"]), 2, "a set");
});

test("seatAdds: only a selected user neither the owner nor seated now is an add", () => {
  assert.equal(seatAdds([OWNER, "a"], set(OWNER, "a"), OWNER), false);
  assert.equal(seatAdds([OWNER, "a"], set(OWNER), OWNER), false);
  assert.equal(seatAdds([OWNER, "a"], set(OWNER, "a", "b"), OWNER), true);
  assert.equal(seatAdds(["a"], set("a"), OWNER), false, "the owner always is");
  assert.equal(seatAdds(["a"], set(OWNER), OWNER), false);
  assert.equal(seatAdds([], set(OWNER, "x"), OWNER), true);
});

test("seatRemovalsWaiting: 10 minutes; unreadable times wait, future times don't", () => {
  assert.equal(REMOVAL_WAITING_MS, 600_000);
  const now = Date.parse("2026-11-12T12:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  assert.deepEqual(
    seatRemovalsWaiting(
      [
        { user_id: "young", created_at: ago(599_000) },
        { user_id: "old", created_at: ago(600_000) },
        { user_id: "older", created_at: ago(3_600_000) },
        { user_id: "garbled", created_at: "not a date" },
        { user_id: "absent" },
        { user_id: "future", created_at: ago(-60_000) },
        { user_id: "old", created_at: ago(900_000) },
        { user_id: "", created_at: ago(900_000) },
        null,
      ],
      now,
    ),
    ["old", "older", "garbled", "absent"],
  );
  assert.deepEqual(seatRemovalsWaiting(undefined, now), []);
  assert.deepEqual(
    seatRemovalsWaiting(
      [{ user_id: "old", created_at: ago(900_000) }],
      Number.NaN,
    ),
    [],
  );
});

test("seatDeviceCounts: unknown members are null, never 0; a device counts once", () => {
  assert.equal(seatDeviceCounts(undefined), null);
  assert.equal(seatDeviceCounts({}), null);
  assert.deepEqual([...(seatDeviceCounts([]) ?? new Map())], []);
  const counts = seatDeviceCounts([
    { user_id: "a", device_id: "d1" },
    { user_id: "a", device_id: "d2" },
    { user_id: "a", device_id: "d1" },
    { user_id: "b", device_id: "d3" },
    { user_id: "c" },
    { user_id: "", device_id: "d4" },
    { device_id: "d5" },
    null,
  ]);
  assert.deepEqual(
    [...(counts ?? new Map())],
    [
      ["a", 2],
      ["b", 1],
    ],
  );
});

test("seatFailureBody: only a server failure's body reaches reasonRefusal", () => {
  const tooLong = {
    source: "server",
    status: 400,
    type: "FailedValidation",
    body: { type: "FailedValidation", error: "AuditLogReasonTooLong" },
  };
  assert.equal(reasonRefusal(seatFailureBody(tooLong)), "too_long");
  assert.equal(
    reasonRefusal(
      seatFailureBody({ ...tooLong, body: { type: "FailedValidation" } }),
    ),
    null,
  );
  assert.equal(
    reasonRefusal(seatFailureBody({ ...tooLong, source: "client" })),
    null,
  );
  // the failure itself is not the body: reasonRefusal never matches it
  assert.equal(reasonRefusal(tooLong), null);
  assert.equal(seatFailureBody(null), undefined);
  assert.equal(seatFailureBody("x"), undefined);
});

test("seatReasonRequired: only the RemovalReasonRequired notice", () => {
  assert.equal(
    seatReasonRequired({ kind: "notice", notice: "removal_reason_required" }),
    true,
  );
  assert.equal(
    seatReasonRequired({ kind: "notice", notice: "not_owner" }),
    false,
  );
  assert.equal(seatReasonRequired({ kind: "none", tag: "Declined" }), false);
  assert.equal(seatReasonRequired(undefined), false);
});

test("seatDiscardOutcome: each answer as sent; anything unreadable is unknown, never discarded", () => {
  assert.equal(seatDiscardOutcome({ discarded: true }), "discarded");
  for (const why of ["none", "busy", "maybe_accepted"]) {
    assert.equal(seatDiscardOutcome({ discarded: false, why }), why);
  }
  for (const bad of [
    { discarded: false, why: "gone" },
    { discarded: false },
    { discarded: "true" },
    {},
    null,
    undefined,
    true,
  ]) {
    assert.equal(seatDiscardOutcome(bad), "unknown", JSON.stringify(bad));
  }
});

test("seatClientReason: client failures only", () => {
  assert.equal(
    seatClientReason({ source: "client", reason: "publish_not_persisted" }),
    "publish_not_persisted",
  );
  assert.equal(
    seatClientReason({ source: "server", reason: "publish_not_persisted" }),
    null,
  );
  assert.equal(seatClientReason({ source: "client", reason: 3 }), null);
  assert.equal(seatClientReason(null), null);
});
