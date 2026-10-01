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
  type AdmitGraceRearmInput,
  admitGraceLedgerResets,
  admitGraceWindow,
  billAdmitGrace,
  legOwnerPresent,
  rearmAdmitGraceExpiry,
  settleAdmitGrace,
  shouldRearmAdmitGrace,
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

// ---- rearmAdmitGraceExpiry: a refresh extends, never shortens ---------------

test("🔴 a refresh never shortens an open window", () => {
  // A 14 s window armed at t=0 (base + 2 primaries × stagger); the joiner's
  // own intent at t=1 s is enrolment evidence. Re-arming to now + base cut it
  // to 11 s and made it lapse inside a served rejoin's Remove→Add gap
  // (2026-09-07). The later of the two wins.
  assert.equal(
    rearmAdmitGraceExpiry({
      nowMs: 1_000,
      currentExpiryMs: 14_000,
      baseMs: BASE,
      deadlineMs: 60_000,
    }),
    14_000,
  );
});

test("a refresh extends a window that would otherwise fire sooner than now + base", () => {
  assert.equal(
    rearmAdmitGraceExpiry({
      nowMs: 9_000,
      currentExpiryMs: 10_000,
      baseMs: BASE,
      deadlineMs: 60_000,
    }),
    19_000,
  );
});

test("the budget deadline caps every extension", () => {
  assert.equal(
    rearmAdmitGraceExpiry({
      nowMs: 55_000,
      currentExpiryMs: 56_000,
      baseMs: BASE,
      deadlineMs: 60_000,
    }),
    60_000,
  );
});

test("past the deadline the window must lapse", () => {
  assert.equal(
    rearmAdmitGraceExpiry({
      nowMs: 60_000,
      currentExpiryMs: 60_000,
      baseMs: BASE,
      deadlineMs: 60_000,
    }),
    null,
  );
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

// ---- legOwnerPresent: the roster's owner rule for a screen leg -------------

test("🔴 a device leg's owner is its device primary in the SFU set", () => {
  assert.equal(legOwnerPresent("u:d:screen", ["x:y", "u:d"], "me:dev"), true);
  // The leg's own presence is not its owner's...
  assert.equal(legOwnerPresent("u:d:screen", ["u:d:screen"], "me:dev"), false);
  // ...and neither is another device of the same user.
  assert.equal(legOwnerPresent("u:d:screen", ["u:e"], "me:dev"), false);
});

test("🔴 the sharer's OWN leg has its owner present", () => {
  // The roster deletes our own identity from the SFU set before it looks, so
  // the set never holds the sharer's primary. Without the local-identity rule
  // the sharer's phone would be the first to lose its own leg's grace.
  assert.equal(legOwnerPresent("me:dev:screen", [], "me:dev"), true);
});

test("🔴 an orphan leg's owner is absent", () => {
  assert.equal(legOwnerPresent("u:d:screen", [], "me:dev"), false);
  assert.equal(
    legOwnerPresent("u:d:screen", ["v:e", "me:dev"], "me:dev"),
    false,
  );
});

test("the bare grammar `u::screen` is owned by the user id", () => {
  assert.equal(legOwnerPresent("u::screen", ["u"], "me:dev"), true);
  assert.equal(legOwnerPresent("u::screen", ["u:d"], "me:dev"), false);
  assert.equal(legOwnerPresent("me::screen", [], "me"), true);
});

test("🔴 an empty owner is never present (FX2)", () => {
  // A malformed `::screen` strips to "", which an empty SFU entry or an empty
  // local identity would otherwise match.
  assert.equal(legOwnerPresent("::screen", [""], ""), false);
  assert.equal(legOwnerPresent("::screen", [], ""), false);
  assert.equal(legOwnerPresent("::screen", [""], "me:dev"), false);
});

// ---- admitGraceLedgerResets: a publication forgives a leg's spent grace ----

test("🔴 a published leg's ledger resets", () => {
  assert.equal(
    admitGraceLedgerResets({ isLeg: true, legPublished: true }),
    true,
  );
});

test("🔴 an unpublished leg keeps its spent grace", () => {
  // The anti-churn bound: a leg that never publishes is never forgiven.
  assert.equal(
    admitGraceLedgerResets({ isLeg: true, legPublished: false }),
    false,
  );
});

test("🔴 a primary's ledger never resets", () => {
  assert.equal(
    admitGraceLedgerResets({ isLeg: false, legPublished: true }),
    false,
  );
  assert.equal(
    admitGraceLedgerResets({ isLeg: false, legPublished: false }),
    false,
  );
});

// ---- shouldRearmAdmitGrace: a leg re-arms in its inert window --------------

const rearmFor = (over: Partial<AdmitGraceRearmInput>) =>
  shouldRearmAdmitGrace({
    isLeg: true,
    admitInProgress: false,
    legPublished: false,
    legOwnerPresent: true,
    ...over,
  });

test("🔴 an unpublished leg with its owner present re-arms (E2-3)", () => {
  // A leg never sends a join request, so `admitInProgress` is always false
  // for it; the old rule lapsed every slow leg straight into non-enrolled.
  assert.equal(rearmFor({}), true);
});

test("🔴 a published leg does not re-arm", () => {
  assert.equal(rearmFor({ legPublished: true }), false);
  // An admit in progress is not a leg's signal and cannot keep it graced.
  assert.equal(rearmFor({ legPublished: true, admitInProgress: true }), false);
});

test("🔴 an orphan unpublished leg does not re-arm", () => {
  assert.equal(rearmFor({ legOwnerPresent: false }), false);
  assert.equal(
    rearmFor({ legOwnerPresent: false, admitInProgress: true }),
    false,
  );
});

test("a primary re-arms exactly while its admit is in progress", () => {
  // Unchanged from before C3: the leg fields are ignored for a primary.
  for (const published of [false, true]) {
    for (const ownerPresent of [false, true]) {
      for (const inProgress of [false, true]) {
        assert.equal(
          shouldRearmAdmitGrace({
            isLeg: false,
            admitInProgress: inProgress,
            legPublished: published,
            legOwnerPresent: ownerPresent,
          }),
          inProgress,
          `admit ${inProgress}, published ${published}, owner ${ownerPresent}`,
        );
      }
    }
  }
});

// ---- C3 scenarios: what the policy does to a leg across a call -------------
//
// These replay the ORDER in which `mlsCallSession` calls the leaf for a leg,
// with the session's state reduced to the ledger entry and the open window's
// `pendingSince`. They cannot import the session (it is not loadable by
// `node --test`) and model nothing beyond that call sequence:
//
//   arm     `#armAdmitGrace`: `admitGraceWindow` over the ledger; pending
//           from the arm.
//   settle  one reconcile's settle loop: `settleAdmitGrace`, bill, THEN reset
//           the ledger if `admitGraceLedgerResets` (contract C-a).
//   expiry  `#onAdmitGraceExpiry`: `shouldRearmAdmitGrace`, then
//           `rearmAdmitGraceExpiry`; otherwise the window closes.
//   close   an expiry lapse or a leave: settle as not-pending and bill.
//
// The session derives the booleans it passes from its media snapshot
// (contract C-b): the reset's `legPublished` is "seen published" (and, in an
// e2ee call, encrypted); the re-arm's is "not in `unpublishedLegs`". Here they
// are given.

// A 1:1 call: the viewer and the sharer's own phone are the primaries.
const legWindow = (usedMs: number) => win(usedMs, 2);

const settleLeg = (
  usedMs: number,
  pendingSince: number | null,
  o: { reportedPending: boolean; legPublished: boolean; nowMs: number },
) => {
  const settled = settleAdmitGrace(pendingSince, o.reportedPending, o.nowMs);
  let used = billAdmitGrace(usedMs, settled.billMs, MAX);
  if (admitGraceLedgerResets({ isLeg: true, legPublished: o.legPublished })) {
    used = 0;
  }
  return { used, pendingSince: settled.pendingSince };
};

const closeLeg = (usedMs: number, pendingSince: number | null, nowMs: number) =>
  billAdmitGrace(
    usedMs,
    settleAdmitGrace(pendingSince, false, nowMs).billMs,
    MAX,
  );

/** The next expiry, or null when the window lapses. */
const legExpiry = (
  nowMs: number,
  currentExpiryMs: number,
  deadlineMs: number,
  leg: Pick<AdmitGraceRearmInput, "legPublished" | "legOwnerPresent">,
) =>
  shouldRearmAdmitGrace({ isLeg: true, admitInProgress: false, ...leg })
    ? rearmAdmitGraceExpiry({
        nowMs,
        currentExpiryMs,
        baseMs: BASE,
        deadlineMs,
      })
    : null;

test("🔴 a phone that shares over and over never runs out of grace (E2-2)", () => {
  // Forty start/stop cycles of ONE leg identity (the device id is stable, so
  // every share reuses it), each billing a 2-3 s connect→publish gap: 100 s in
  // total, well past the 60 s ceiling. Before C3 the ledger outlived every
  // share and the 25th start was non-enrolled on sight: the share
  // self-stopped and every viewer went red.
  let used = 0;
  for (let share = 0; share < 40; share++) {
    const armedAt = share * 60_000;
    const gap = 2_000 + (share % 3) * 500;
    const w = legWindow(used);
    assert.ok(w, `share ${share} gets a window`);
    assert.equal(w.budgetMs, MAX, `share ${share} starts on the full budget`);
    let pendingSince: number | null = armedAt;
    // A reconcile inside the gap: unpublished, so reported pending.
    ({ used, pendingSince } = settleLeg(used, pendingSince, {
      reportedPending: true,
      legPublished: false,
      nowMs: armedAt + 1_000,
    }));
    // The reconcile that sees the publication: the leg folds onto its owner,
    // so the gap is billed and then forgiven.
    ({ used, pendingSince } = settleLeg(used, pendingSince, {
      reportedPending: false,
      legPublished: true,
      nowMs: armedAt + gap,
    }));
    // The window's expiry finds it published: it lapses, inert and free.
    const expiresAt = armedAt + w.graceMs;
    assert.equal(
      legExpiry(expiresAt, expiresAt, armedAt + w.budgetMs, {
        legPublished: true,
        legOwnerPresent: true,
      }),
      null,
    );
    used = closeLeg(used, pendingSince, expiresAt);
  }
  assert.equal(used, 0);
});

test("🔴 a churned leg that never publishes still exhausts at the ceiling", () => {
  // A flapping phone, or a hostile SFU authoring the connect/disconnect
  // events, cycles one leg identity faster than its window and never
  // publishes. Nothing forgives it, so its 5 s stretches sum to exactly the
  // 60 s ceiling and the 13th connect is non-enrolled on sight.
  let used = 0;
  let cycles = 0;
  for (;;) {
    const armedAt = cycles * 6_000;
    if (legWindow(used) === null) break;
    assert.ok(cycles < 100, "the ceiling must end the churn");
    let pendingSince: number | null = armedAt;
    ({ used, pendingSince } = settleLeg(used, pendingSince, {
      reportedPending: true,
      legPublished: false,
      nowMs: armedAt + 2_500,
    }));
    // The leave closes the window and bills the stretch.
    used = closeLeg(used, pendingSince, armedAt + 5_000);
    cycles++;
  }
  assert.equal(cycles, 12);
  assert.equal(used, MAX);
});

test("🔴 a never-publishing leg's re-arms stop at its budget deadline", () => {
  // The sharer's own leg, owner present, never publishes: it re-arms on each
  // expiry, but only up to the deadline its window was armed with, and then
  // its whole budget is spent.
  const w = legWindow(0);
  assert.ok(w);
  const deadline = w.budgetMs;
  const ownerPresent = legOwnerPresent("me:dev:screen", [], "me:dev");
  let used = 0;
  let pendingSince: number | null = 0;
  let expiresAt = w.graceMs;
  for (let rearms = 0; ; rearms++) {
    assert.ok(rearms < 100, "the deadline must end the re-arms");
    ({ used, pendingSince } = settleLeg(used, pendingSince, {
      reportedPending: true,
      legPublished: false,
      nowMs: expiresAt,
    }));
    const next = legExpiry(expiresAt, expiresAt, deadline, {
      legPublished: false,
      legOwnerPresent: ownerPresent,
    });
    if (next === null) break;
    expiresAt = next;
  }
  assert.equal(expiresAt, deadline, "lapses AT the deadline, never past it");
  used = closeLeg(used, pendingSince, expiresAt);
  assert.equal(used, MAX);
  assert.equal(legWindow(used), null);
});

test("🔴 a slow leg re-arms while unpublished and lapses once published (E2-3)", () => {
  // The sharer's phone takes 18 s from connect to publish, past its 14 s
  // window. Before C3 the expiry found no admit in progress and the leg went
  // non-enrolled: the share self-stopped, on the sharer's own device first.
  const w = legWindow(0);
  assert.ok(w);
  const deadline = w.budgetMs;
  const ownerPresent = legOwnerPresent("me:dev:screen", [], "me:dev");
  let used = 0;
  let pendingSince: number | null = 0;
  // 14 s: unpublished, owner present, so it re-arms.
  ({ used, pendingSince } = settleLeg(used, pendingSince, {
    reportedPending: true,
    legPublished: false,
    nowMs: w.graceMs,
  }));
  assert.equal(
    legExpiry(w.graceMs, w.graceMs, deadline, {
      legPublished: false,
      legOwnerPresent: ownerPresent,
    }),
    24_000,
  );
  // 18 s: published. The stretch is billed, then forgiven.
  ({ used, pendingSince } = settleLeg(used, pendingSince, {
    reportedPending: false,
    legPublished: true,
    nowMs: 18_000,
  }));
  assert.equal(used, 0);
  // 24 s: the re-armed expiry finds it published, so it lapses for free.
  assert.equal(
    legExpiry(24_000, 24_000, deadline, {
      legPublished: true,
      legOwnerPresent: ownerPresent,
    }),
    null,
  );
  used = closeLeg(used, pendingSince, 24_000);
  assert.equal(used, 0);
  assert.equal(legWindow(used)?.budgetMs, MAX, "the next share is unpenalized");
});

test("🔴 an orphan slow leg lapses at its first expiry", () => {
  // Its owner primary is not in the call, so there is nothing to fold onto:
  // it stays loud, exactly as the roster reports it.
  const w = legWindow(0);
  assert.ok(w);
  assert.equal(
    legExpiry(w.graceMs, w.graceMs, w.budgetMs, {
      legPublished: false,
      legOwnerPresent: legOwnerPresent("u:d:screen", ["v:e"], "me:dev"),
    }),
    null,
  );
});

test("🔴 a published plaintext leg is neither forgiven nor re-armed", () => {
  // In an e2ee call a leg publishing without encryption fails the roster's
  // rule 2(b) and is reported non-enrolled. It is not "seen published" for
  // the reset (not encrypted) and it is not unpublished for the re-arm.
  const w = legWindow(0);
  assert.ok(w);
  let used = 0;
  let pendingSince: number | null = 0;
  ({ used, pendingSince } = settleLeg(used, pendingSince, {
    reportedPending: false,
    legPublished: false,
    nowMs: 4_000,
  }));
  assert.equal(used, 4_000, "its pending stretch stays on the ledger");
  assert.equal(pendingSince, null);
  assert.equal(
    legExpiry(w.graceMs, w.graceMs, w.budgetMs, {
      legPublished: true,
      legOwnerPresent: true,
    }),
    null,
    "its window lapses: loud",
  );
});
