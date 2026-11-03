// Unit spec for the mailbox-drain policy — run with Node's built-in runner:
//   node --test components/rtc/mlsDrainPolicy.test.ts   (Node >=23.6 strips types)
// Focus: the leaf-verify reactive-net decisions (needs_identity) are correct,
// bounded, and never fail open (never ack/drop an un-verified Welcome).
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyEnvelopeError } from "../client/mlsEnvelopeClassify.ts";
import {
  drainAction,
  keyUnreadableErrorType,
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
const drop = (successorNeeded = false, loud = true) => ({
  kind: "drop",
  reason: "x",
  loud,
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
  assert.deepEqual(A(drop(false, false), 0, 0, BOUNDS), { do: "ack" });
});

test("a LOUD terminal drop carries its reason to the latch (rejoin plan §4.7)", () => {
  // The one unrepeatable envelope being destroyed must become VISIBLE —
  // `EnvelopeDisposition.loud` had zero consumers and that silence is the
  // 08-16 incident's most plausible broken link.
  assert.deepEqual(A(drop(false, true), 0, 0, BOUNDS), {
    do: "ack",
    loudDropReason: "x",
  });
  // A quiet drop (e.g. post-wipe group_not_found) never latches.
  assert.deepEqual(A(drop(false, false), 0, 0, BOUNDS), { do: "ack" });
  // The poisoned/successor case recovers through its own action — a
  // functioning successor migration must not latch loud.
  assert.deepEqual(A(drop(true, true), 0, 0, BOUNDS), { do: "successor" });
});

test("needs_identity first time → fetch_identity(userId, deviceId)", () => {
  assert.deepEqual(A(needsIdentity("01ALICE", "d1"), 0, 0, BOUNDS, false), {
    do: "fetch_identity",
    userId: "01ALICE",
    deviceId: "d1",
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
    deviceId: "d1",
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

// D10 (locked device mid-call). The dispositions below are built by the REAL
// classifier from the native error shape `{ type: "<snake_case>" }`, so this
// pins the classify → drain chain the session runs, not a hand-made stand-in.
const nativeErr = (type: string) => classifyEnvelopeError({ type });

test("D10: a locked store (protector_locked / protector) is held loud at EVERY retry count, never acked or dropped", () => {
  for (const type of ["protector_locked", "protector"] as const) {
    const disp = nativeErr(type);
    assert.equal(disp.kind, "error"); // the classifier side of the contract
    assert.equal(disp.ack, false);
    // Well past the cap: a phone stays locked far longer than ~2.5 s.
    for (let retries = 0; retries <= BOUNDS.maxRetries * 4; retries++) {
      assert.deepEqual(A(disp, retries, 0, BOUNDS), {
        do: "hold_locked",
        errorType: type,
      });
    }
  }
});

test("D10: only the key-unreadable class is held; every other error keeps retry → ack_drop_poison", () => {
  const others: unknown[] = [
    { type: "storage" },
    { type: "ipc" },
    { type: "protector_locked_v2" }, // a near-miss spelling is NOT the class
    { type: "Protector" },
    { reason: "protector_locked" }, // the type field, nothing else
    "protector_locked", // a bare string is not the IPC shape
    null,
    undefined,
    new Error("protector_locked"),
  ];
  for (const error of others) {
    const disp = { kind: "error", error, ack: false };
    assert.deepEqual(A(disp, 0, 0, BOUNDS), { do: "retry" });
    assert.deepEqual(A(disp, BOUNDS.maxRetries, 0, BOUNDS), {
      do: "ack_drop_poison",
    });
  }
  assert.equal(keyUnreadableErrorType({ type: "protector" }), "protector");
  assert.equal(
    keyUnreadableErrorType({ type: "protector_locked" }),
    "protector_locked",
  );
  assert.equal(keyUnreadableErrorType({ type: "storage" }), undefined);
  assert.equal(keyUnreadableErrorType(null), undefined);
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
