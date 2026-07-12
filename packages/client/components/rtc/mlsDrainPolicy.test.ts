// Unit spec for the mailbox-drain policy — run with Node's built-in runner:
//   node --test components/rtc/mlsDrainPolicy.test.ts   (Node >=23.6 strips types)
// Focus: the leaf-verify reactive-net decisions (needs_identity) are correct,
// bounded, and never fail open (never ack/drop an un-verified Welcome).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  drainAction,
  shouldParkForPendingFetch,
  spliceParkedAfterWelcome,
  type DrainBounds,
} from "./mlsDrainPolicy.ts";

const BOUNDS = { maxRetries: 5, maxParkAttempts: 8 };

// Minimal dispositions — drainAction only reads .kind + a couple of fields.
// deno-lint/tsc types are erased at runtime; these mirror EnvelopeDisposition.
const processed = (removed_self = false) => ({
  kind: "processed",
  outcome: { group_id: "g", kind: "welcome_joined", epoch: 1, removed_self, removed: [] },
  ack: true,
});
const park = (expected = 3, got = 5) => ({ kind: "park", expected, got, ack: false });
const drop = (successorNeeded = false) => ({
  kind: "drop",
  reason: "x",
  loud: true,
  successorNeeded,
  ack: true,
});
const needsIdentity = (userId = "01USER", deviceId = "dev") => ({
  kind: "needs_identity",
  userId,
  deviceId,
  ack: false,
});
const errDisp = () => ({ kind: "error", error: new Error("t"), ack: false });

// node type-strip: pass the plain objects through as the disposition union.
const A = (
  disp: unknown,
  retries: number,
  park: number,
  bounds: DrainBounds,
  fetched = false,
) => drainAction(disp as never, retries, park, bounds, fetched);

test("processed → ack / ack_removed_self", () => {
  assert.deepEqual(A(processed(false), 0, 0, BOUNDS), { do: "ack" });
  assert.deepEqual(A(processed(true), 0, 0, BOUNDS), { do: "ack_removed_self" });
});

test("park bounded → gap_refetch, then escalate_desync at the cap", () => {
  assert.deepEqual(A(park(3), 0, 0, BOUNDS), { do: "gap_refetch", fromEpoch: 3 });
  assert.deepEqual(A(park(3), 0, BOUNDS.maxParkAttempts, BOUNDS), { do: "escalate_desync" });
});

test("drop → successor when needed, else ack", () => {
  assert.deepEqual(A(drop(true), 0, 0, BOUNDS), { do: "successor" });
  assert.deepEqual(A(drop(false), 0, 0, BOUNDS), { do: "ack" });
});

test("needs_identity first time → fetch_identity(userId)", () => {
  assert.deepEqual(A(needsIdentity("01ALICE", "d1"), 0, 0, BOUNDS, false), {
    do: "fetch_identity",
    userId: "01ALICE",
  });
});

test("needs_identity with no progress after reconcile → rejoin_fresh (MED-1, never spin)", () => {
  const action = A(needsIdentity("01ALICE", "d1"), 0, 0, BOUNDS, true);
  assert.equal(action.do, "rejoin_fresh");
  assert.match(action.reason, /01ALICE/);
});

test("needs_identity with FAILED reconciles → fetch_identity until the retry cap, then rejoin_fresh (MED-4)", () => {
  // A transiently-failed reconcile does NOT set identityFetched — it burns an
  // envelope retry, so the fetch is re-attempted (bounded), never mistaken for
  // "reconciled, still unverifiable".
  assert.deepEqual(A(needsIdentity("01ALICE", "d1"), BOUNDS.maxRetries - 1, 0, BOUNDS, false), {
    do: "fetch_identity",
    userId: "01ALICE",
  });
  const action = A(needsIdentity("01ALICE", "d1"), BOUNDS.maxRetries, 0, BOUNDS, false);
  assert.equal(action.do, "rejoin_fresh");
  assert.match(action.reason, /unreachable/);
});

test("needs_identity NEVER acks/drops the Welcome (fail-closed, every progress/retry state)", () => {
  for (const fetched of [false, true]) {
    for (const retries of [0, BOUNDS.maxRetries]) {
      const action = A(needsIdentity(), retries, 0, BOUNDS, fetched);
      for (const forbidden of ["ack", "ack_removed_self", "ack_drop_poison", "successor"]) {
        assert.notEqual(action.do, forbidden);
      }
    }
  }
});

test("error bounded → retry, then ack_drop_poison at the retry cap", () => {
  assert.deepEqual(A(errDisp(), 0, 0, BOUNDS), { do: "retry" });
  assert.deepEqual(A(errDisp(), BOUNDS.maxRetries, 0, BOUNDS), { do: "ack_drop_poison" });
});

// D10 (6.4 gate MED-2): park same-group envelopes while an identity-fetch is
// pending; consume when none pending or the group doesn't match; escalate on
// buffer overflow. Never a fatal single-group assert.
const MAX_PARKED = 8;
test("shouldParkForPendingFetch: no pending fetch ⇒ consume", () => {
  assert.equal(shouldParkForPendingFetch("g1", null, 0, MAX_PARKED), "consume");
});

test("shouldParkForPendingFetch: matching group + pending ⇒ park (below cap)", () => {
  assert.equal(shouldParkForPendingFetch("g1", "g1", 0, MAX_PARKED), "park");
  assert.equal(
    shouldParkForPendingFetch("g1", "g1", MAX_PARKED - 1, MAX_PARKED),
    "park",
  );
});

test("shouldParkForPendingFetch: NON-matching group ⇒ consume defensively (no fatal assert, ME-MED-4)", () => {
  // A stale old-group envelope during a rejoin/successor migration must be
  // consumed, never parked (it is not the pending group) and never a crash.
  assert.equal(shouldParkForPendingFetch("g2", "g1", 0, MAX_PARKED), "consume");
});

test("shouldParkForPendingFetch: buffer overflow ⇒ escalate (rejoin fresh, never plaintext)", () => {
  assert.equal(
    shouldParkForPendingFetch("g1", "g1", MAX_PARKED, MAX_PARKED),
    "escalate",
  );
});

test("spliceParkedAfterWelcome: Welcome FIRST, then parked FIFO (D10 ordering guard, CR-MED-5)", () => {
  // The load-bearing D10 re-feed order: a commit ahead of the Welcome would
  // reintroduce the group_not_found drop D10 exists to fix.
  assert.deepEqual(spliceParkedAfterWelcome("W", ["c2", "c3"]), ["W", "c2", "c3"]);
  assert.deepEqual(spliceParkedAfterWelcome("W", []), ["W"]);
});
