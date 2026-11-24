// Protected channels S4, the bridge's history seam (lane L2e; fix round
// FXE: R-W4-31, A7, B5).
//
//   A. `historyPolicyActions`: the decision matrix, and a sweep over every
//      input combination proving a reveal only comes from a verified, kept,
//      well-formed, pinned-compatible policy. The server's history flag is
//      no input (R-W4-31): the sweep and the rig still carry one, to prove
//      it is never read and changes nothing.
//   B. `applyHistoryPolicy` on the real stoat.js `ProtectedHistoryState`
//      (the pin set is a small fake with the same `setHistory` rules: the
//      real one imports a `.js` sibling and does not load here).
//   C. `restoreTextSummary` / `bundleTextTruncated` (R-W4-12).
//   D. `historyManagerOf`.
//   E. `e2ee.ts`, read as a syntax tree (comments cannot satisfy or defeat
//      it): the reveal, the pin write and the purge each have ONE call
//      site, inside `#protectedHistoryPorts`, which only `onHistoryPolicy`
//      reaches; a dispose clears every reveal without a latch (A7); the
//      flag is stored whole and travels to the manager, and no flag fetch
//      reaches a reveal; the backup and UI pass-throughs keep their shape.
//
// `E2EE_SEAM_TS` swaps in another e2ee.ts for the controls.
//
// Run: node --conditions=browser --test components/client/e2eeProtectedHistorySeam.test.ts
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { ProtectedHistoryState } from "../../../stoat.js/src/lib/protectedHistory.ts";

import {
  type HistoryPolicy,
  type HistoryReveal,
  type HistorySeamPorts,
  type HistorySeamState,
  type PinHistory,
  applyHistoryPolicy,
  bundleTextTruncated,
  historyManagerOf,
  historyPolicyActions,
  preHistoryStateOf,
  restoreTextSummary,
} from "./e2eeProtectedHistorySeam.ts";

const B1 = "01J" + "0".repeat(22) + "A";
const B2 = "01K" + "0".repeat(23);
// Later than the ULID time of both boundaries.
const LIMIT = 1_800_000_000_000;
const CH = "01CHANNEL";

const KEPT: HistoryPolicy = {
  verified: true,
  boundary: B1,
  preHistory: "kept",
  timeLimit: LIMIT,
};
const CLEAN: HistorySeamState = {
  pinned: null,
  revealed: null,
  conflicted: false,
  wiped: false,
};

// ---- A. the decision ---------------------------------------------------------

test("actions: a verified kept policy pins the boundary and reveals", () => {
  assert.deepEqual(historyPolicyActions(KEPT, CLEAN), {
    refusal: null,
    pin: { boundary: B1, wiped: false },
    reveal: { boundary: B1, timeLimit: LIMIT },
    purge: null,
    loud: false,
  });
  // The same boundary already pinned is fine.
  const again = historyPolicyActions(KEPT, {
    ...CLEAN,
    pinned: { boundary: B1, wiped: false },
  });
  assert.deepEqual(again.reveal, { boundary: B1, timeLimit: LIMIT });
});

test("actions: an unverified policy reveals nothing and writes nothing", () => {
  for (const verified of [false, undefined, null, 1, "true"]) {
    const a = historyPolicyActions(
      { ...KEPT, verified: verified as unknown as boolean },
      CLEAN,
    );
    assert.deepEqual(
      a,
      {
        refusal: "unverified",
        pin: null,
        reveal: null,
        purge: null,
        loud: false,
      },
      String(verified),
    );
  }
  for (const p of [null, undefined, "kept", 7]) {
    const a = historyPolicyActions(p as unknown as HistoryPolicy, CLEAN);
    assert.equal(a.refusal, "unverified");
    assert.equal(a.reveal, null);
  }
});

test("actions: a verified wiped policy pins wiped and purges, never reveals", () => {
  assert.deepEqual(
    historyPolicyActions({ ...KEPT, preHistory: "wiped" }, CLEAN),
    {
      refusal: "wiped",
      pin: { boundary: B1, wiped: true },
      reveal: null,
      purge: { boundary: B1 },
      loud: false,
    },
  );
  // No boundary known: every cached plaintext row goes, nothing is pinned.
  assert.deepEqual(
    historyPolicyActions(
      { ...KEPT, preHistory: "wiped", boundary: null },
      CLEAN,
    ),
    {
      refusal: "wiped",
      pin: null,
      reveal: null,
      purge: { boundary: null },
      loud: false,
    },
  );
  // A pin on another boundary: purge still, no pin write, loud.
  const other = historyPolicyActions(
    { ...KEPT, preHistory: "wiped" },
    { ...CLEAN, pinned: { boundary: B2, wiped: false } },
  );
  assert.deepEqual(other, {
    refusal: "wiped",
    pin: null,
    reveal: null,
    purge: { boundary: B1 },
    loud: true,
  });
  // Already wiped in the SDK and in the pin: nothing left to do.
  const done = historyPolicyActions(
    { ...KEPT, preHistory: "wiped" },
    { ...CLEAN, wiped: true, pinned: { boundary: B1, wiped: true } },
  );
  assert.deepEqual(
    { pin: done.pin, purge: done.purge, reveal: done.reveal },
    { pin: null, purge: null, reveal: null },
  );
});

test("actions: no boundary, a malformed boundary, no time limit, unknown pre_history", () => {
  const cases: [Partial<HistoryPolicy>, string, boolean][] = [
    [{ boundary: null }, "no_boundary", false],
    [{ boundary: "not-a-ulid" }, "malformed_boundary", true],
    [{ boundary: B1.toLowerCase() }, "malformed_boundary", true],
    [{ boundary: B1 + "0" }, "malformed_boundary", true],
    [{ boundary: "8" + B1.slice(1) }, "malformed_boundary", true],
    [{ timeLimit: null }, "no_time_limit", false],
    [{ timeLimit: -1 }, "no_time_limit", false],
    [{ timeLimit: 1.5 }, "no_time_limit", false],
    [{ timeLimit: Number.MAX_SAFE_INTEGER + 1 }, "no_time_limit", false],
    [
      { timeLimit: "1700000000000" as unknown as number },
      "no_time_limit",
      false,
    ],
    [{ preHistory: null }, "pre_history_unknown", false],
    [
      { preHistory: "visible" as unknown as "kept" },
      "pre_history_unknown",
      false,
    ],
  ];
  for (const [over, refusal, loud] of cases) {
    assert.deepEqual(
      historyPolicyActions({ ...KEPT, ...over }, CLEAN),
      { refusal, pin: null, reveal: null, purge: null, loud },
      JSON.stringify(over),
    );
  }
});

test("actions: a pin on another boundary, a wiped pin, a conflicted or wiped channel", () => {
  const cases: [Partial<HistorySeamState>, string, boolean][] = [
    [{ pinned: { boundary: B2, wiped: false } }, "pin_mismatch", true],
    [{ pinned: { boundary: B1, wiped: true } }, "pin_rollback", true],
    [{ conflicted: true }, "channel_conflicted", false],
    [{ wiped: true }, "channel_wiped", false],
  ];
  for (const [over, refusal, loud] of cases) {
    assert.deepEqual(
      historyPolicyActions(KEPT, { ...CLEAN, ...over }),
      { refusal, pin: null, reveal: null, purge: null, loud },
      refusal,
    );
  }
});

/** A state that still carries a server flag, as the seam's caller once did. */
function flagged(state: HistorySeamState, historySetting: unknown) {
  return { ...state, historySetting } as unknown as HistorySeamState;
}

test("actions (R-W4-31): the server flag is no input, off decides the same as on", () => {
  // The type has no room for it.
  const noFlag: "historySetting" extends keyof HistorySeamState ? never : true =
    true;
  assert.equal(noFlag, true);
  const held: HistorySeamState = {
    ...CLEAN,
    pinned: { boundary: B1, wiped: false },
    revealed: B1,
  };
  const policies: HistoryPolicy[] = [
    KEPT,
    { ...KEPT, preHistory: "wiped" },
    { ...KEPT, verified: false },
    { ...KEPT, boundary: B2 },
  ];
  for (const state of [CLEAN, held]) {
    for (const p of policies) {
      const want = historyPolicyActions(p, state);
      for (const flag of [false, true, undefined, null, "off"]) {
        assert.deepEqual(
          historyPolicyActions(p, flagged(state, flag)),
          want,
          JSON.stringify({ p, flag }),
        );
      }
    }
  }
  // Flag off: a verified kept policy reveals, a wiped one purges, and an
  // unverified one takes a held reveal back.
  assert.deepEqual(historyPolicyActions(KEPT, flagged(CLEAN, false)), {
    refusal: null,
    pin: { boundary: B1, wiped: false },
    reveal: { boundary: B1, timeLimit: LIMIT },
    purge: null,
    loud: false,
  });
  assert.deepEqual(
    historyPolicyActions(
      { ...KEPT, preHistory: "wiped" },
      flagged(CLEAN, false),
    ),
    {
      refusal: "wiped",
      pin: { boundary: B1, wiped: true },
      reveal: null,
      purge: { boundary: B1 },
      loud: false,
    },
  );
  assert.deepEqual(
    historyPolicyActions({ ...KEPT, verified: false }, flagged(held, false)),
    {
      refusal: "unverified",
      pin: null,
      reveal: null,
      purge: { boundary: B1 },
      loud: false,
    },
  );
});

test("actions: a held reveal is taken back by every policy that does not allow it", () => {
  const held: HistorySeamState = {
    ...CLEAN,
    pinned: { boundary: B1, wiped: false },
    revealed: B1,
  };
  const refusing: [HistoryPolicy, HistorySeamState, string][] = [
    [{ ...KEPT, verified: false }, held, "unverified"],
    [{ ...KEPT, boundary: null }, held, "no_boundary"],
    [{ ...KEPT, boundary: "junk" }, held, "malformed_boundary"],
    [{ ...KEPT, boundary: B2 }, held, "pin_mismatch"],
    [{ ...KEPT, boundary: B2 }, { ...held, pinned: null }, "pin_mismatch"],
    [{ ...KEPT, timeLimit: null }, held, "no_time_limit"],
    [{ ...KEPT, preHistory: null }, held, "pre_history_unknown"],
    [KEPT, { ...held, conflicted: true }, "channel_conflicted"],
    [KEPT, { ...held, wiped: true }, "channel_wiped"],
  ];
  for (const [p, state, refusal] of refusing) {
    const a = historyPolicyActions(p, state);
    assert.equal(a.refusal, refusal);
    assert.equal(a.reveal, null, refusal);
    assert.deepEqual(a.purge, { boundary: B1 }, refusal);
  }
  const wiped = historyPolicyActions({ ...KEPT, preHistory: "wiped" }, held);
  assert.equal(wiped.reveal, null);
  assert.deepEqual(wiped.purge, { boundary: B1 });
  assert.deepEqual(wiped.pin, { boundary: B1, wiped: true });
});

test("actions: over every input combination a reveal needs every condition", () => {
  const verifieds = [true, false, undefined, 1, "true"];
  const boundaries = [B1, B2, null, undefined, "junk", "", B1.toLowerCase()];
  const pres = ["kept", "wiped", null, undefined, "visible"];
  const limits = [LIMIT, 0, null, undefined, -1, 0.5, Number.NaN, "5"];
  const flags = [true, false];
  const pins: (PinHistory | null)[] = [
    null,
    { boundary: B1, wiped: false },
    { boundary: B1, wiped: true },
    { boundary: B2, wiped: false },
  ];
  const helds = [null, B1, B2];
  const latches = [false, true];
  let total = 0;
  let reveals = 0;
  for (const verified of verifieds)
    for (const boundary of boundaries)
      for (const preHistory of pres)
        for (const timeLimit of limits)
          for (const historySetting of flags)
            for (const pinned of pins)
              for (const revealed of helds)
                for (const conflicted of latches)
                  for (const wiped of latches) {
                    total++;
                    const a = historyPolicyActions(
                      {
                        verified,
                        boundary,
                        preHistory,
                        timeLimit,
                      } as unknown as HistoryPolicy,
                      flagged(
                        { pinned, revealed, conflicted, wiped },
                        historySetting,
                      ),
                    );
                    // R-W4-31: `historySetting` is not among the conditions.
                    const allowed =
                      verified === true &&
                      (boundary === B1 || boundary === B2) &&
                      preHistory === "kept" &&
                      (timeLimit === LIMIT || timeLimit === 0) &&
                      (pinned === null ||
                        (pinned.boundary === boundary && !pinned.wiped)) &&
                      (revealed === null || revealed === boundary) &&
                      !conflicted &&
                      !wiped;
                    assert.equal(
                      a.reveal !== null,
                      allowed,
                      JSON.stringify({
                        verified,
                        boundary,
                        preHistory,
                        timeLimit,
                        historySetting,
                        pinned,
                        revealed,
                        conflicted,
                        wiped,
                      }),
                    );
                    if (a.reveal !== null) {
                      reveals++;
                      assert.equal(a.refusal, null);
                      assert.deepEqual(a.pin, { boundary, wiped: false });
                      assert.deepEqual(a.reveal, { boundary, timeLimit });
                      assert.equal(a.purge, null);
                    } else {
                      assert.notEqual(a.refusal, null);
                      // No reveal while one is held: it is taken back.
                      if (
                        revealed !== null &&
                        !(wiped && a.refusal === "wiped")
                      )
                        assert.notEqual(a.purge, null, a.refusal ?? "");
                    }
                    // A pin is written only from a verified policy.
                    if (a.pin !== null) {
                      assert.equal(verified, true);
                      assert.equal(a.pin.boundary, boundary);
                    }
                  }
  assert.equal(total, 5 * 7 * 5 * 8 * 2 * 4 * 3 * 2 * 2);
  assert.ok(reveals > 0, "the sweep reaches the reveal arm");
});

// ---- B. applied to the SDK state --------------------------------------------

/** The `ProtectedPinSet.setHistory` rules (stoat.js `protectedPins.ts`). */
class FakePins {
  readonly ids = new Set<string>([CH]);
  readonly history = new Map<string, PinHistory>();
  historyOf(id: string): PinHistory | undefined {
    const h = this.history.get(id);
    return h ? { ...h } : undefined;
  }
  setHistory(id: string, history: PinHistory): boolean {
    if (!this.ids.has(id)) return false;
    const held = this.history.get(id);
    if (held) {
      if (held.boundary !== history.boundary) return false;
      if (held.wiped && !history.wiped) return false;
      if (held.wiped === history.wiped) return true;
    }
    this.history.set(id, { ...history });
    return true;
  }
}

/** The bridge's ports over a real `ProtectedHistoryState`, with a call log. */
function rig(opts: { flag?: boolean } = {}) {
  const sdk = new ProtectedHistoryState();
  const pins = new FakePins();
  const calls: string[] = [];
  const lines: string[] = [];
  const state = { flag: opts.flag ?? true };
  // `historySetting` is no port of the seam any more (R-W4-31). The rig
  // keeps one as a trap: a seam that read the flag again would log it here.
  const ports: HistorySeamPorts & { historySetting(): boolean } = {
    historySetting: () => {
      calls.push("historySetting");
      return state.flag;
    },
    pinned: (id) => {
      calls.push("pinned");
      return pins.historyOf(id);
    },
    revealed: (id) => {
      calls.push("revealed");
      return sdk.revealOf(id);
    },
    conflicted: (id) => {
      calls.push("conflicted");
      return sdk.isConflicted(id);
    },
    wiped: (id) => {
      calls.push("wiped");
      return sdk.isWiped(id);
    },
    setHistory: (id, history) => {
      calls.push(`setHistory:${history.boundary}:${history.wiped}`);
      return pins.setHistory(id, history);
    },
    // `Client.revealPreProtectRows` / `purgePreProtectRows`, minus the cache.
    reveal: (id, reveal: HistoryReveal) => {
      calls.push(`reveal:${reveal.boundary}:${reveal.timeLimit}`);
      sdk.setReveal(id, reveal);
    },
    purge: (id, boundary) => {
      calls.push(`purge:${boundary}`);
      sdk.markWiped(id);
    },
    log: (line) => lines.push(line),
  };
  const writes = () =>
    calls.filter((c) => /^(setHistory|reveal|purge):/.test(c));
  const covers = (id = B1) => sdk.covers(CH, { id, encrypted: false });
  return { sdk, pins, calls, lines, state, ports, writes, covers };
}

test("apply: verified kept -> the pin is written, then the reveal", () => {
  const r = rig();
  assert.equal(applyHistoryPolicy(r.ports, CH, KEPT), "revealed");
  assert.deepEqual(r.writes(), [
    `setHistory:${B1}:false`,
    `reveal:${B1}:${LIMIT}`,
  ]);
  assert.deepEqual(r.sdk.revealOf(CH), { boundary: B1, timeLimit: LIMIT });
  assert.deepEqual(r.pins.historyOf(CH), { boundary: B1, wiped: false });
  assert.equal(r.covers(), true);
  assert.deepEqual(r.lines, []);
});

test("apply: the same policy again writes nothing; a moved time limit re-reveals", () => {
  const r = rig();
  applyHistoryPolicy(r.ports, CH, KEPT);
  const before = r.writes().length;
  assert.equal(applyHistoryPolicy(r.ports, CH, KEPT), "revealed");
  assert.equal(r.writes().length, before);
  assert.equal(
    applyHistoryPolicy(r.ports, CH, { ...KEPT, timeLimit: LIMIT + 5 }),
    "revealed",
  );
  assert.deepEqual(r.sdk.revealOf(CH), { boundary: B1, timeLimit: LIMIT + 5 });
});

test("apply: unverified, no boundary, malformed, no time limit -> nothing is written", () => {
  const policies: HistoryPolicy[] = [
    { ...KEPT, verified: false },
    { ...KEPT, verified: "true" as unknown as boolean },
    { ...KEPT, boundary: null },
    { ...KEPT, boundary: "junk" },
    { ...KEPT, timeLimit: null },
    { ...KEPT, preHistory: null },
    { verified: false, boundary: null, preHistory: null, timeLimit: null },
  ];
  for (const p of policies) {
    const r = rig();
    assert.equal(applyHistoryPolicy(r.ports, CH, p), "none");
    assert.deepEqual(r.writes(), [], JSON.stringify(p));
    assert.equal(r.sdk.revealOf(CH), undefined);
    assert.equal(r.covers(), false);
    assert.equal(r.sdk.canReveal(CH), true, "nothing latched either");
  }
});

test("apply: a later unverified policy takes an earlier reveal back", () => {
  const r = rig();
  applyHistoryPolicy(r.ports, CH, KEPT);
  assert.equal(r.covers(), true);
  assert.equal(
    applyHistoryPolicy(r.ports, CH, { ...KEPT, verified: false }),
    "withdrawn",
  );
  assert.deepEqual(r.writes().slice(-1), [`purge:${B1}`]);
  assert.equal(r.covers(), false);
  // And a verified policy after that does not bring it back this session.
  assert.equal(applyHistoryPolicy(r.ports, CH, KEPT), "none");
  assert.equal(r.covers(), false);
  assert.equal(r.writes().filter((c) => c.startsWith("reveal:")).length, 1);
});

test("apply: a later wiped policy purges, pins wiped and ends the reveal", () => {
  const r = rig();
  applyHistoryPolicy(r.ports, CH, KEPT);
  assert.equal(
    applyHistoryPolicy(r.ports, CH, { ...KEPT, preHistory: "wiped" }),
    "wiped",
  );
  assert.deepEqual(r.writes().slice(-2), [
    `setHistory:${B1}:true`,
    `purge:${B1}`,
  ]);
  assert.deepEqual(r.pins.historyOf(CH), { boundary: B1, wiped: true });
  assert.equal(r.sdk.isWiped(CH), true);
  assert.equal(r.covers(), false);
  // `kept` after `wiped` is a rollback: refused, loud, still no reveal.
  const n = r.writes().length;
  assert.equal(applyHistoryPolicy(r.ports, CH, KEPT), "none");
  assert.equal(r.writes().length, n);
  assert.equal(r.covers(), false);
  assert.match(r.lines.join("\n"), /pin_rollback/);
});

test("apply: wiped from the start never reveals and purges once", () => {
  const r = rig();
  const p: HistoryPolicy = { ...KEPT, preHistory: "wiped" };
  assert.equal(applyHistoryPolicy(r.ports, CH, p), "wiped");
  assert.equal(applyHistoryPolicy(r.ports, CH, p), "wiped");
  assert.deepEqual(r.writes(), [`setHistory:${B1}:true`, `purge:${B1}`]);
  assert.equal(r.covers(), false);
});

test("apply: another boundary than the pinned one is a loud conflict, never a reveal", () => {
  // After a reload: the pin holds B1, nothing is revealed, native says B2.
  const fresh = rig();
  fresh.pins.history.set(CH, { boundary: B1, wiped: false });
  assert.equal(
    applyHistoryPolicy(fresh.ports, CH, { ...KEPT, boundary: B2 }),
    "none",
  );
  assert.deepEqual(fresh.writes(), []);
  assert.equal(fresh.covers(B2), false);
  assert.equal(fresh.lines.length, 1);
  assert.match(fresh.lines[0], /pin_mismatch/);
  assert.ok(fresh.lines[0].endsWith(CH), "the line ends with the channel id");

  // In one session: B1 revealed, then B2 arrives. The reveal goes.
  const live = rig();
  applyHistoryPolicy(live.ports, CH, KEPT);
  assert.equal(
    applyHistoryPolicy(live.ports, CH, { ...KEPT, boundary: B2 }),
    "withdrawn",
  );
  assert.equal(live.covers(), false);
  assert.equal(live.covers(B2), false);
  assert.equal(live.writes().filter((c) => c.startsWith("reveal:")).length, 1);
});

test("apply: an unpinned channel (setHistory refuses) is a conflict with no reveal", () => {
  const r = rig();
  r.pins.ids.clear();
  assert.equal(applyHistoryPolicy(r.ports, CH, KEPT), "conflict");
  assert.deepEqual(r.writes(), [`setHistory:${B1}:false`]);
  assert.equal(r.covers(), false);
  assert.match(r.lines.join("\n"), /history pin refused/);
});

test("apply: a conflicted or wiped channel is never handed a reveal", () => {
  const conflicted = rig();
  conflicted.sdk.setReveal(CH, { boundary: "junk", timeLimit: 0 });
  assert.equal(conflicted.sdk.isConflicted(CH), true);
  assert.equal(applyHistoryPolicy(conflicted.ports, CH, KEPT), "none");
  assert.deepEqual(conflicted.writes(), []);

  const wiped = rig();
  wiped.sdk.markWiped(CH);
  assert.equal(applyHistoryPolicy(wiped.ports, CH, KEPT), "none");
  assert.deepEqual(wiped.writes(), []);
  assert.equal(wiped.covers(), false);
});

test("apply (R-W4-31): with the server flag off every policy is applied as with it on, and the flag is never read", () => {
  const noFlag: "historySetting" extends keyof HistorySeamPorts ? never : true =
    true;
  assert.equal(noFlag, true);
  const policies: [HistoryPolicy, string][] = [
    [KEPT, "revealed"],
    [{ ...KEPT, preHistory: "wiped" }, "wiped"],
    [{ ...KEPT, verified: false }, "none"],
    [{ ...KEPT, boundary: null }, "none"],
  ];
  for (const [p, outcome] of policies) {
    const off = rig({ flag: false });
    const on = rig({ flag: true });
    assert.equal(applyHistoryPolicy(off.ports, CH, p), outcome);
    assert.equal(applyHistoryPolicy(on.ports, CH, p), outcome);
    assert.deepEqual(off.calls, on.calls, JSON.stringify(p));
    assert.equal(off.calls.includes("historySetting"), false);
    assert.deepEqual(off.sdk.revealOf(CH), on.sdk.revealOf(CH));
    assert.deepEqual(off.pins.historyOf(CH), on.pins.historyOf(CH));
  }
  // Flag off, verified kept: pinned and revealed.
  const kept = rig({ flag: false });
  assert.equal(applyHistoryPolicy(kept.ports, CH, KEPT), "revealed");
  assert.deepEqual(kept.writes(), [
    `setHistory:${B1}:false`,
    `reveal:${B1}:${LIMIT}`,
  ]);
  assert.equal(kept.covers(), true);
  // Flag off, verified wiped: pinned wiped and purged.
  const wiped = rig({ flag: false });
  assert.equal(
    applyHistoryPolicy(wiped.ports, CH, { ...KEPT, preHistory: "wiped" }),
    "wiped",
  );
  assert.deepEqual(wiped.writes(), [`setHistory:${B1}:true`, `purge:${B1}`]);
  assert.equal(wiped.sdk.isWiped(CH), true);
});

test("apply (R-W4-31): the server flag going off mid-session keeps a held reveal, and a later unverified policy still takes it back", () => {
  const r = rig();
  assert.equal(applyHistoryPolicy(r.ports, CH, KEPT), "revealed");
  const before = r.writes().slice();
  // A failed flag fetch is stored as off. The same verified policy again:
  // the reveal stays as it was, nothing is purged and nothing latches.
  r.state.flag = false;
  assert.equal(applyHistoryPolicy(r.ports, CH, KEPT), "revealed");
  assert.deepEqual(r.writes(), before, "no write, no purge");
  assert.deepEqual(r.sdk.revealOf(CH), { boundary: B1, timeLimit: LIMIT });
  assert.equal(r.covers(), true);
  assert.equal(r.sdk.isWiped(CH), false);
  assert.equal(r.sdk.isConflicted(CH), false);
  assert.equal(r.sdk.canReveal(CH), true);
  // Flag still off: the manager reports the state unverified. That goes.
  assert.equal(
    applyHistoryPolicy(r.ports, CH, { ...KEPT, verified: false }),
    "withdrawn",
  );
  assert.deepEqual(r.writes().slice(-1), [`purge:${B1}`]);
  assert.equal(r.covers(), false);
  // Flag back on changes nothing either: the purge latched the channel.
  r.state.flag = true;
  assert.equal(applyHistoryPolicy(r.ports, CH, KEPT), "none");
  assert.equal(r.covers(), false);
  assert.equal(r.writes().filter((c) => c.startsWith("reveal:")).length, 1);
  assert.equal(r.calls.includes("historySetting"), false, "flag never read");
});

test("apply: a port that throws never reveals, and a held reveal is purged", () => {
  for (const broken of [
    "revealed",
    "pinned",
    "conflicted",
    "wiped",
    "setHistory",
  ] as const) {
    const r = rig();
    r.ports[broken] = () => {
      throw new Error("boom");
    };
    assert.equal(applyHistoryPolicy(r.ports, CH, KEPT), "failed", broken);
    assert.equal(r.covers(), false, broken);
    assert.equal(r.writes().filter((c) => c.startsWith("reveal:")).length, 0);
  }
  // The reveal call itself throws after setting: the reveal is purged.
  const r = rig();
  const reveal = r.ports.reveal;
  r.ports.reveal = (id, v) => {
    reveal(id, v);
    throw new Error("boom");
  };
  assert.equal(applyHistoryPolicy(r.ports, CH, KEPT), "failed");
  assert.equal(r.covers(), false);
  assert.deepEqual(r.writes().slice(-1), ["purge:null"]);
  // Everything throws: still no exception out of the seam.
  const dead = rig();
  for (const k of Object.keys(dead.ports) as (keyof HistorySeamPorts)[]) {
    dead.ports[k] = (() => {
      throw new Error("boom");
    }) as never;
  }
  assert.equal(applyHistoryPolicy(dead.ports, CH, KEPT), "failed");
});

// ---- C. backup ---------------------------------------------------------------

test("restoreTextSummary: every R-W4-12 combination", () => {
  const none = { epochs: null, truncated: null, skipped: "none" };
  for (const report of [
    null,
    undefined,
    "x",
    7,
    {},
    { new_device_id: "d", device_id: "s", messages: 3 },
    { device_id: "d", one_time_keys: [] },
  ]) {
    assert.deepEqual(restoreTextSummary(report), none, JSON.stringify(report));
  }
  const cases: [Record<string, unknown>, unknown][] = [
    [{ text_epochs: 4 }, { epochs: 4, truncated: null, skipped: "none" }],
    [
      { text_epochs: 4, text_truncated: "none" },
      { epochs: 4, truncated: "none", skipped: "none" },
    ],
    [
      { text_epochs: 4, text_truncated: "oldest" },
      { epochs: 4, truncated: "oldest", skipped: "none" },
    ],
    [
      { text_truncated: "all" },
      { epochs: null, truncated: "all", skipped: "none" },
    ],
    // skipped with text_truncated present: some history keys left out
    [
      { text_epochs: 2, text_truncated: "none", text_skipped: true },
      { epochs: 2, truncated: "none", skipped: "partial" },
    ],
    [
      { text_epochs: 2, text_truncated: "oldest", text_skipped: true },
      { epochs: 2, truncated: "oldest", skipped: "partial" },
    ],
    [
      { text_truncated: "all", text_skipped: true },
      { epochs: null, truncated: "all", skipped: "partial" },
    ],
    // skipped without it: nothing of the text section was restored
    [{ text_skipped: true }, { epochs: null, truncated: null, skipped: "all" }],
    [
      { text_skipped: true, text_truncated: "some" },
      { epochs: null, truncated: null, skipped: "all" },
    ],
    // only the literal true skips; junk fields read as absent
    [
      { text_skipped: false, text_truncated: "none" },
      { ...none, truncated: "none" },
    ],
    [{ text_skipped: "true" }, none],
    [{ text_skipped: 1 }, none],
    [{ text_epochs: -1 }, none],
    [{ text_epochs: 1.5 }, none],
    [{ text_epochs: "4" }, none],
    [{ text_epochs: 0 }, { ...none, epochs: 0 }],
  ];
  for (const [report, want] of cases) {
    assert.deepEqual(restoreTextSummary(report), want, JSON.stringify(report));
  }
});

test("bundleTextTruncated (B5): the three literals; null without the key; any other value is unknown, never null", () => {
  for (const v of ["none", "oldest", "all"]) {
    assert.equal(bundleTextTruncated({ text_truncated: v }), v);
  }
  // No text section reported at all.
  for (const bundle of [
    null,
    undefined,
    "all",
    7,
    {},
    { header: "h", ciphertext: "c", generation: 1, truncated: true },
    { text_truncated: undefined },
    { text_truncated: null },
  ]) {
    assert.equal(bundleTextTruncated(bundle), null, JSON.stringify(bundle));
  }
  // A value is there, but not one this build knows: the warning is kept.
  for (const v of [
    "ALL",
    "newest",
    "",
    "unknown",
    true,
    false,
    0,
    3,
    {},
    ["all"],
  ]) {
    assert.equal(
      bundleTextTruncated({ text_truncated: v }),
      "unknown",
      JSON.stringify(v),
    );
  }
});

// ---- D. the manager's S4 surface ---------------------------------------------

test("historyManagerOf: only a manager with all four calls", () => {
  const fn = () => undefined;
  const full = {
    protect: fn,
    setHistoryVisible: fn,
    wipeHistory: fn,
    walkHistory: fn,
  };
  assert.equal(historyManagerOf(full), full);
  for (const missing of Object.keys(full)) {
    const partial: Record<string, unknown> = { ...full };
    delete partial[missing];
    assert.equal(historyManagerOf(partial), null, missing);
    assert.equal(historyManagerOf({ ...full, [missing]: true }), null);
  }
  // The S2 manager: `protect` only.
  assert.equal(historyManagerOf({ protect: fn }), null);
  assert.equal(historyManagerOf(null), null);
  assert.equal(historyManagerOf(undefined), null);
});

test("preHistoryStateOf: reads both latches of the SDK state", () => {
  const sdk = new ProtectedHistoryState();
  assert.deepEqual(preHistoryStateOf(sdk, CH), {
    conflicted: false,
    wiped: false,
  });
  sdk.markWiped(CH);
  assert.deepEqual(preHistoryStateOf(sdk, CH), {
    conflicted: false,
    wiped: true,
  });
  assert.deepEqual(preHistoryStateOf(sdk, "01OTHER"), {
    conflicted: false,
    wiped: false,
  });
  const other = new ProtectedHistoryState();
  other.setReveal(CH, { boundary: "junk", timeLimit: 0 });
  assert.deepEqual(preHistoryStateOf(other, CH), {
    conflicted: true,
    wiped: false,
  });
  other.markWiped(CH);
  assert.deepEqual(preHistoryStateOf(other, CH), {
    conflicted: true,
    wiped: true,
  });
  // Only the literal false is "not latched".
  const odd = {
    isConflicted: () => undefined as unknown as boolean,
    isWiped: () => 0 as unknown as boolean,
  };
  assert.deepEqual(preHistoryStateOf(odd, CH), {
    conflicted: true,
    wiped: true,
  });
});

test("preHistoryStateOf: a throw or a missing SDK state reads as conflicted", () => {
  const boom = () => {
    throw new Error("boom");
  };
  const fine = () => false;
  for (const history of [
    null,
    undefined,
    { isConflicted: boom, isWiped: fine },
    { isConflicted: fine, isWiped: boom },
    { isConflicted: boom, isWiped: boom },
    {} as { isConflicted(): boolean; isWiped(): boolean },
  ]) {
    assert.deepEqual(preHistoryStateOf(history, CH), {
      conflicted: true,
      wiped: false,
    });
  }
});

// ---- E. e2ee.ts ---------------------------------------------------------------

const HERE = fileURLToPath(new URL(".", import.meta.url));
const E2EE_TS = process.env.E2EE_SEAM_TS || join(HERE, "e2ee.ts");
const CLIENT_ROOT = join(HERE, "..", "..");

const SF = ts.createSourceFile(
  "e2ee.ts",
  readFileSync(E2EE_TS, "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const PRINTER = ts.createPrinter({ removeComments: true });

/** A node's code with comments and all whitespace removed. */
function code(node: ts.Node, sf: ts.SourceFile = SF): string {
  return PRINTER.printNode(ts.EmitHint.Unspecified, node, sf).replace(
    /\s+/g,
    "",
  );
}

/** Name of the class member a node sits in ("" outside a class). */
function memberOf(node: ts.Node): string {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (ts.isClassElement(n) && n.name) return n.name.getText();
  }
  return "";
}

/** Every call `x.name(...)` or `name(...)` in a file, with its member. */
function callsOf(name: string, sf: ts.SourceFile = SF): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const called = ts.isPropertyAccessExpression(callee)
        ? callee.name.getText()
        : ts.isIdentifier(callee)
          ? callee.text
          : "";
      if (called === name) found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** The one class member with this name in `E2EEBridge`. */
function bridgeMember(name: string): ts.ClassElement {
  const found: ts.ClassElement[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isClassDeclaration(node) && node.name?.text === "E2EEBridge") {
      for (const m of node.members) {
        if (m.name?.getText() === name) found.push(m);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(SF);
  // Overload signatures aside, the implementation is the one with a body.
  const bodies = found.filter(
    (m) => !ts.isMethodDeclaration(m) || m.body !== undefined,
  );
  assert.equal(bodies.length, 1, `${name} defined ${bodies.length} times`);
  return bodies[0];
}

/** Property assignments named `name`, anywhere in the file. */
function propsNamed(name: string): ts.PropertyAssignment[] {
  const found: ts.PropertyAssignment[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText() === name) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(SF);
  return found;
}

test("e2ee.ts: the reveal, the pin write and the purge have one call site each, inside the history ports", () => {
  for (const name of [
    "revealPreProtectRows",
    "setHistory",
    "purgePreProtectRows",
  ]) {
    const calls = callsOf(name);
    assert.equal(calls.length, 1, `${name} called ${calls.length} times`);
    assert.equal(memberOf(calls[0]), "#protectedHistoryPorts", name);
  }
  // Nothing reaches under `Client.revealPreProtectRows` to the SDK state.
  for (const name of [
    "setReveal",
    "markWiped",
    "stashField",
    "takeStash",
    "dropStash",
    "dropChannelStash",
  ]) {
    assert.equal(callsOf(name).length, 0, name);
  }
  assert.equal(
    code(bridgeMember("#protectedHistoryPorts")),
    "#protectedHistoryPorts():HistorySeamPorts{constclient=this.#client;return{" +
      "pinned:(channelId)=>client.protectedPins.historyOf(channelId)," +
      "revealed:(channelId)=>client.protectedHistory.revealOf(channelId)," +
      "conflicted:(channelId)=>client.protectedHistory.isConflicted(channelId)," +
      "wiped:(channelId)=>client.protectedHistory.isWiped(channelId)," +
      "setHistory:(channelId,history)=>client.protectedPins.setHistory(channelId,history)," +
      "reveal:(channelId,reveal)=>client.revealPreProtectRows(channelId,reveal)," +
      "purge:(channelId,boundary)=>{client.purgePreProtectRows(channelId,boundary);}," +
      "log:(line)=>console.error(line),};}",
  );
});

test("e2ee.ts: only onHistoryPolicy reaches the ports, behind the current-manager check", () => {
  const ports = callsOf("#protectedHistoryPorts");
  assert.equal(ports.length, 1);
  const applies = callsOf("applyHistoryPolicy");
  assert.equal(applies.length, 1);
  const callbacks = propsNamed("onHistoryPolicy");
  assert.equal(callbacks.length, 1);
  assert.equal(memberOf(callbacks[0]), "#protectedEnsureManager");
  assert.equal(
    code(callbacks[0]),
    "onHistoryPolicy:(channelId,p)=>{if(!current())return;" +
      "applyHistoryPolicy(this.#protectedHistoryPorts(),channelId,p);}",
  );
});

test("e2ee.ts (A7): a dispose clears every reveal, unconditionally and without the latching purge", () => {
  const clears = callsOf("clearAllPreProtectReveals");
  assert.equal(clears.length, 1);
  assert.equal(memberOf(clears[0]), "#protectedDispose");
  assert.equal(code(clears[0]), "this.#client.clearAllPreProtectReveals()");
  // Not the per-channel call, and not the SDK state under it.
  assert.equal(callsOf("clearPreProtectReveal").length, 0);
  assert.equal(callsOf("clearReveal").length, 0);
  // A statement of the method body itself: on every dispose, with or
  // without a manager, and a throw from it does not stop the teardown.
  const dispose = bridgeMember("#protectedDispose");
  assert.ok(ts.isMethodDeclaration(dispose) && dispose.body);
  const statements = dispose.body.statements.map((s) => code(s));
  const at = statements.findIndex((s) =>
    s.includes("clearAllPreProtectReveals"),
  );
  assert.ok(at >= 0, "the clear is a top-level statement of the dispose");
  assert.equal(
    statements[at],
    "try{this.#client.clearAllPreProtectReveals();}" +
      'catch(error){console.error("[protected]revealclearfailed",errorName(error));}',
  );
  // After the manager is disposed, before the views are dropped.
  assert.match(
    statements[at - 1],
    /^if\(manager\)\{try\{manager\.dispose\(\);\}/,
  );
  assert.equal(statements[at + 1], "this.protectedChannels.clear();");
  // The dispose itself purges nothing: no latch, the next manager reveals.
  const body = code(dispose);
  assert.doesNotMatch(body, /purgePreProtectRows|#protectedHistoryPorts/);
});

test("e2ee.ts (R-W4-31): the history ports read no flag, and no flag fetch reaches a reveal, a purge or a dispose", () => {
  const ports = code(bridgeMember("#protectedHistoryPorts"));
  assert.doesNotMatch(ports, /protectedFlag|historySetting|#ptFlagState/);
  // The members that fetch and store the flag (a failed `GET /` is stored
  // as off) touch nothing of the reveal.
  for (const name of [
    "#protectedRefreshFlag",
    "#protectedProbeFlag",
    "#protectedFlagFetch",
  ]) {
    assert.doesNotMatch(
      code(bridgeMember(name)),
      /applyHistoryPolicy|#protectedHistoryPorts|#protectedDispose|revealPreProtectRows|purgePreProtectRows|clearAllPreProtectReveals|clearPreProtectReveal/,
      name,
    );
  }
  // The stored flag has one reader, and the callback does not ask it.
  const callbacks = propsNamed("onHistoryPolicy");
  assert.equal(callbacks.length, 1);
  assert.doesNotMatch(code(callbacks[0]), /protectedFlag|historySetting/);
});

test("the app: no other file calls the reveal, the pin write or the purge", () => {
  const names = [
    "revealPreProtectRows",
    "purgePreProtectRows",
    "clearAllPreProtectReveals",
    "clearPreProtectReveal",
    "clearReveal",
    "setReveal",
    "markWiped",
  ];
  const hits: string[] = [];
  let files = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === "node_modules" ||
          entry.name === "styled-system" ||
          entry.name === "dist" ||
          entry.name === "android" ||
          entry.name === "ios" ||
          entry.name.startsWith(".")
        )
          continue;
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (/\.test\.(ts|tsx)$/.test(entry.name)) continue;
      files++;
      const text = readFileSync(path, "utf8");
      const mentions = names.filter((n) => text.includes(n));
      const pins = text.includes("setHistory");
      if (mentions.length === 0 && !pins) continue;
      const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
      for (const n of [...names, ...(pins ? ["setHistory"] : [])]) {
        for (const call of callsOf(n, sf)) {
          // `setHistory` is also an owner flow's name: only the pin set's
          // counts here (in e2ee.ts every call of the name is counted above).
          if (
            n === "setHistory" &&
            !code(call.expression, sf).includes("protectedPins")
          )
            continue;
          hits.push(
            `${path.slice(CLIENT_ROOT.length + 1)}:${n}:${code(call, sf)}`,
          );
        }
      }
    }
  };
  walk(join(CLIENT_ROOT, "components"));
  walk(join(CLIENT_ROOT, "src"));
  assert.ok(files > 500, `walked ${files} files`);
  assert.deepEqual(hits.sort(), [
    "components/client/e2ee.ts:clearAllPreProtectReveals:this.#client.clearAllPreProtectReveals()",
    "components/client/e2ee.ts:purgePreProtectRows:client.purgePreProtectRows(channelId,boundary)",
    "components/client/e2ee.ts:revealPreProtectRows:client.revealPreProtectRows(channelId,reveal)",
    "components/client/e2ee.ts:setHistory:client.protectedPins.setHistory(channelId,history)",
  ]);
});

test("e2ee.ts: the fetched flag is stored whole, and history_setting travels to the manager", () => {
  // Both writers store the object `fetchProtectedChannelsFlag` parsed.
  const sets = callsOf("set").filter(
    (c) => code(c.expression) === "this.#ptFlagState.set",
  );
  assert.deepEqual(sets.map((c) => `${memberOf(c)}:${code(c)}`).sort(), [
    '#protectedProbeFlag:this.#ptFlagState.set("state",flag)',
    '#protectedRefreshFlag:this.#ptFlagState.set("state",flag)',
  ]);
  assert.match(
    code(bridgeMember("#protectedProbeFlag")),
    /constflag=awaitfetchProtectedChannelsFlag\(/,
  );
  assert.match(
    code(bridgeMember("#protectedFlagFetch")),
    /constflag=awaitfetchProtectedChannelsFlag\(.*return\{event:.*,flag,?\};\}$/,
  );
  assert.match(
    code(bridgeMember("#protectedRefreshFlag")),
    /const\{event,flag\}=awaitthis\.#protectedFlagFetch\(\);this\.#ptFlagState\.set\("state",flag\);/,
  );
  // The one reader hands the stored object back untouched.
  assert.match(
    code(bridgeMember("protectedFlag")),
    /^protectedFlag\(\):ProtectedChannelsFlag\{return\(?this\.#ptFlagState\.get\("state"\)\?\?\{enabled:false,defaultDeviceCap:null,formatsV2:false,historySetting:false,?\}\)?;\}$/,
  );
  // The manager's port carries it beside formats_v2, read strictly.
  const port = propsNamed("historySetting").filter(
    (p) => memberOf(p) === "#protectedPort",
  );
  assert.equal(port.length, 1);
  assert.equal(
    code(port[0]),
    "historySetting:()=>this.protectedFlag().historySetting===true",
  );
  assert.match(
    code(bridgeMember("#protectedPort")),
    /\):ProtectedTextPort&ProtectedHistoryPort\{/,
  );
});

test("e2ee.ts: the manager's deps: the pin history and a flag-gated backup refresh through the courier", () => {
  const pin = propsNamed("pinHistory");
  assert.equal(pin.length, 1);
  assert.equal(memberOf(pin[0]), "#protectedEnsureManager");
  assert.equal(
    code(pin[0]),
    "pinHistory:(channelId)=>this.#client.protectedPins.historyOf(channelId)??null",
  );
  const refresh = propsNamed("requestBackupRefresh");
  assert.equal(refresh.length, 1);
  assert.equal(memberOf(refresh[0]), "#protectedEnsureManager");
  assert.equal(
    code(refresh[0]),
    "requestBackupRefresh:()=>{if(this.protectedFlag().historySetting!==true)return;" +
      "voidthis.#courierBackupRefresh();}",
  );
  // No force path and no new native command (OPEN 3).
  assert.equal(callsOf("refreshBackupIfDue").length, 1);
  assert.equal(
    memberOf(callsOf("refreshBackupIfDue")[0]),
    "#courierBackupRefresh",
  );
  assert.match(
    code(bridgeMember("#protectedEnsureManager")),
    /manager=newProtectedTextManager\(this\.#protectedPort\(userId,deviceId,life\.signal\),callbacks,deps\);/,
  );
});

test("e2ee.ts: the manager's deps carry the history toggle, the wipe and the SDK latches", () => {
  const owner = propsNamed("owner").filter(
    (p) => memberOf(p) === "#protectedEnsureManager",
  );
  assert.equal(owner.length, 1);
  assert.equal(
    code(owner[0]),
    "owner:{protect,setSeats,signOwnerDevices,moveOwnerKey,pendingSeats," +
      "cancelPendingSeats,recoverOwnership,setHistory,wipeHistory,}",
  );
  // Both names are the owner flows, not something local to the bridge.
  const imports: string[] = [];
  for (const statement of SF.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      code(statement.moduleSpecifier) === '"./protectedTextOwner"'
    ) {
      imports.push(code(statement));
    }
  }
  assert.equal(imports.length, 1);
  assert.match(imports[0], /[{,]setHistory,/);
  assert.match(imports[0], /[{,]wipeHistory,?\}/);
  const pre = propsNamed("preHistoryState");
  assert.equal(pre.length, 1);
  assert.equal(memberOf(pre[0]), "#protectedEnsureManager");
  assert.equal(
    code(pre[0]),
    "preHistoryState:(channelId)=>" +
      "preHistoryStateOf(this.#client?.protectedHistory,channelId)",
  );
  assert.match(
    code(bridgeMember("#protectedEnsureManager")),
    /constdeps:ProtectedTextManagerDeps&ProtectedTextHistoryDeps=\{/,
  );
});

test("e2ee.ts: the scope of ProtectedChannelChanged reaches the manager unfiltered", () => {
  const calls = callsOf("onChannelChanged");
  assert.equal(calls.length, 1);
  assert.equal(
    code(calls[0]),
    "this.#ptManager?.onChannelChanged?.(event.id,event.scope)",
  );
});

test("e2ee.ts: every kept upload records the bundle's text_truncated; a restore reports its text section", () => {
  const sets = callsOf("set").filter(
    (c) => code(c.expression) === "this.backupText.set",
  );
  assert.equal(sets.length, 1);
  assert.equal(memberOf(sets[0]), "#putBackup");
  assert.match(
    code(bridgeMember("#putBackup")),
    /if\(stored\?\.generation!==bundle\.generation\)\{thrownewBackupNotStoredError\(\);\}this\.backupText\.set\("state",\{truncated:bundleTextTruncated\(bundle\)\}\);awaitthis\.#invoke\("e2ee_backup_mark_uploaded"/,
  );
  assert.equal(
    code(bridgeMember("restoreFromBackup")),
    "asyncrestoreFromBackup(mfaTicketToken:string):Promise<number>{" +
      "return(awaitthis.restoreFromBackupReport(mfaTicketToken)).blobs;}",
  );
  const report = code(bridgeMember("restoreFromBackupReport"));
  // The native report is read in one place: the dialog's answer.
  const summaries = callsOf("restoreTextSummary").map((c) => code(c));
  assert.deepEqual(summaries.sort(), [
    "restoreTextSummary(null)",
    "restoreTextSummary(republish)",
  ]);
  assert.match(
    report,
    /return\{blobs:res\.backups\.length,text:restoreTextSummary\(republish\),?\};/,
  );
});

test("e2ee.ts: the four UI calls pass through to the S4 manager or refuse", () => {
  assert.equal(
    code(bridgeMember("#protectedHistoryManager")),
    "#protectedHistoryManager(manager:ProtectedTextManager):ProtectedHistoryManagerApi{" +
      "consthistory=historyManagerOf(manager);" +
      'if(!history)throw{source:"client",reason:"not_implemented"};' +
      "returnhistory;}",
  );
  assert.equal(
    code(bridgeMember("protect")),
    "asyncprotect(channelId:string,seats:string[],deviceCap:number," +
      "opts?:{withHistory:boolean;wipe:boolean;}):Promise<void>{" +
      "constmanager=awaitthis.#protectedManagerFor(channelId);" +
      "if(opts?.withHistory||opts?.wipe){" +
      "returnthis.#protectedHistoryManager(manager).protect(channelId,seats,deviceCap,opts);}" +
      "returnmanager.protect(channelId,seats,deviceCap);}",
  );
  assert.equal(
    code(bridgeMember("setHistoryVisible")),
    "asyncsetHistoryVisible(channelId:string,visible:boolean):Promise<void>{" +
      "constmanager=awaitthis.#protectedManagerFor(channelId);" +
      "returnthis.#protectedHistoryManager(manager).setHistoryVisible(channelId,visible);}",
  );
  assert.equal(
    code(bridgeMember("wipeHistory")),
    "asyncwipeHistory(channelId:string):Promise<void>{" +
      "constmanager=awaitthis.#protectedManagerFor(channelId);" +
      "returnthis.#protectedHistoryManager(manager).wipeHistory(channelId);}",
  );
  assert.equal(
    code(bridgeMember("walkHistory")),
    "walkHistory(channelId:string):void{" +
      "historyManagerOf(this.#ptManager)?.walkHistory(channelId);}",
  );
});
