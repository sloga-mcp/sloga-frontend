// Specs for the admit-grace budget (slice 6.4 / Android plan §17.7) — run with
// Node's built-in runner:
//   node --test components/rtc/mlsAdmitGracePolicy.test.ts
//
// The grace SUPPRESSES the mixed-call warning, so every assertion here is
// about a bound on that suppression. The two holes these pin:
//
//   churn      — the ceiling used to be per-ARM, and a leave cleared the
//                window, so a peer rejoining faster than the window minted a
//                fresh 60 s ceiling every time and the warning never fired.
//   reconnect  — a full LiveKit reconnect replays ParticipantConnected for
//                EVERY remote, so the join hook re-arms for participants that
//                were already present and already loud.
//
// Both are the same fix: bill time SPENT against a per-identity, per-call
// budget instead of stamping a new deadline on each arm.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  admitGraceWindow,
  billAdmitGrace,
  settleAdmitGrace,
} from "./mlsAdmitGracePolicy.ts";

const BASE = 10_000;
const STAGGER = 2_000;
const MAX = 60_000;

const win = (usedMs: number, primaries = 0) =>
  admitGraceWindow({
    usedMs,
    primaries,
    baseMs: BASE,
    staggerMs: STAGGER,
    maxMs: MAX,
  });

test("a fresh joiner gets the base window and the full budget", () => {
  assert.deepEqual(win(0), { graceMs: BASE, budgetMs: MAX });
});

test("the window widens with the staggered Add ladder", () => {
  assert.equal(win(0, 3)?.graceMs, BASE + 3 * STAGGER);
});

test("🔴 the stagger allowance cannot buy more than the remaining budget", () => {
  // A big call widens the window, but suppression is still capped: with 5 s
  // left, a 20-participant call gets 5 s, not 50.
  const w = win(MAX - 5_000, 20);
  assert.equal(w?.graceMs, 5_000);
  assert.equal(w?.budgetMs, 5_000);
});

test("🔴 an identity that has spent its budget gets NO window", () => {
  // It has had a full minute to enroll and has not, so it is loud on sight.
  assert.equal(win(MAX), null);
  assert.equal(win(MAX + 1_000), null);
});

test("🔴 churn cannot reset the ceiling", () => {
  // Six rejoins, 10 s of grace burned each time. Before the fix each one
  // minted a brand-new 60 s ceiling and the mix warning never fired; now the
  // budget runs out and the seventh join is loud.
  let used = 0;
  for (let i = 0; i < 6; i++) {
    const w = win(used);
    assert.notEqual(w, null, `rejoin ${i} still inside the budget`);
    used = billAdmitGrace(used, 10_000, MAX);
  }
  assert.equal(used, MAX);
  assert.equal(win(used), null, "the seventh rejoin gets no grace at all");
});

test("🔴 a reconnect replay cannot re-arm a participant that already went loud", () => {
  // The replayed ParticipantConnected arrives for someone who already burned
  // a full window and was reported non-enrolled.
  const used = billAdmitGrace(0, MAX, MAX);
  assert.equal(win(used), null);
});

test("a legitimate later rejoin keeps the budget it did not spend", () => {
  // Three seconds spent long ago must not cost this identity its genuine
  // admit window now — this is why the budget bills time SPENT rather than
  // stamping an absolute per-call deadline at the first join.
  const used = billAdmitGrace(0, 3_000, MAX);
  const w = win(used);
  assert.equal(w?.budgetMs, MAX - 3_000);
  assert.equal(w?.graceMs, BASE);
});

test("billing accumulates, clamps at the ceiling, and never refunds", () => {
  assert.equal(billAdmitGrace(1_000, 2_000, MAX), 3_000);
  assert.equal(billAdmitGrace(0, MAX * 10, MAX), MAX);
  // A backwards clock jump yields a negative elapsed; it must not hand budget
  // back and re-open a window that was already spent.
  assert.equal(billAdmitGrace(5_000, -9_000, MAX), 5_000);
});

// ---- settleAdmitGrace: bill only time actually REPORTED pending -----------

test("a stretch that ends is billed exactly once, at its end", () => {
  // Pending since t=1000, reconcile at t=4000 reports it no longer pending
  // (it enrolled): 3 s charged, stamp cleared.
  assert.deepEqual(settleAdmitGrace(1_000, false, 4_000), {
    billMs: 3_000,
    pendingSince: null,
  });
});

test("an ongoing pending stretch bills nothing until it ends", () => {
  // Still reported pending: the stamp is kept, and nothing is charged yet —
  // the charge lands when the stretch closes (settle or window close).
  assert.deepEqual(settleAdmitGrace(1_000, true, 4_000), {
    billMs: 0,
    pendingSince: 1_000,
  });
});

test("🔴 an INERT window costs nothing", () => {
  // The admitted-member shape: the window stays open by design (the
  // eager-clear-at-admit stale-leaf hazard), but from the admit on it
  // suppresses nothing — lapsing must not bill its open duration. Same for
  // the reconnect-replay shape: windows armed over already-enrolled remotes
  // settle inert and their lapse is free.
  assert.deepEqual(settleAdmitGrace(null, false, 60_000), {
    billMs: 0,
    pendingSince: null,
  });
});

test("suppression resuming restarts the stamp at the observation", () => {
  // Enrolled → gone from the roster again (stale-leaf removal): the window
  // begins paying again from now, not retroactively.
  assert.deepEqual(settleAdmitGrace(null, true, 9_000), {
    billMs: 0,
    pendingSince: 9_000,
  });
});

test("a backwards clock jump cannot refund via settle", () => {
  assert.deepEqual(settleAdmitGrace(5_000, false, 2_000), {
    billMs: 0,
    pendingSince: null,
  });
});

test("🔴 interleaved stretches sum to the same ceiling as one long one", () => {
  // The hostile-SFU bound survives the inert-time carve-out: an identity the
  // SFU keeps re-presenting as non-enrolled is continuously reported pending,
  // so its stretches accumulate to the ceiling and the next window is null.
  let used = 0;
  let at = 0;
  for (let i = 0; i < 4; i++) {
    // 15 s reported pending...
    const opened = settleAdmitGrace(null, true, at);
    at += 15_000;
    const closed = settleAdmitGrace(opened.pendingSince, false, at);
    used = billAdmitGrace(used, closed.billMs, MAX);
    // ...then an inert stretch, which must not extend the budget.
    at += 30_000;
  }
  assert.equal(used, MAX);
  assert.equal(win(used), null);
});
