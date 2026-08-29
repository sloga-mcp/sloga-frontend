// Unit spec for the watch-together drift corrector — Node's built-in runner:
//   node --test components/ui/components/features/voice/watch/syncController.test.ts
// Drives the pure `reconcile()` through a fake clock + fake provider across
// the scenarios the plan names (§3): in-band → nothing; small drift → rate
// nudge; large drift → hard seek; viewer stall; host pause with the
// pending-command latch; seek-while-paused re-asserts pause; non-nudging
// provider seeks with hysteresis; host rate applies.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  expectedPosition,
  INITIAL_SYNC_STATE,
  LATCH_TIMEOUT_MS,
  nudgeRateFor,
  reconcile,
  type ProviderSnapshot,
  type SyncSession,
  type SyncState,
} from "./syncController.ts";

const YT = { rateNudge: true, hardSeekMs: 700 };
const HLS = { rateNudge: true, hardSeekMs: 1500 };
const DUMB = { rateNudge: false, hardSeekMs: 1500 };

function session(over: Partial<SyncSession> = {}): SyncSession {
  return { playing: true, positionMs: 60_000, positionAt: 1_000_000, ratePermille: 1000, ...over };
}
function provider(over: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
  return { state: "playing", currentTimeMs: 60_000, ratePermille: 1000, capabilities: YT, ...over };
}
/** Server clock == local clock + 0 offset for readability. */
function snap(s: SyncSession, p: ProviderSnapshot, nowMs: number) {
  return { session: s, provider: p, nowLocalMs: nowMs, nowServerMs: nowMs };
}

test("expectedPosition: paused holds, playing advances at rate", () => {
  const s = session();
  assert.equal(expectedPosition({ ...s, playing: false }, 1_005_000), 60_000);
  assert.equal(expectedPosition(s, 1_005_000), 65_000);
  assert.equal(expectedPosition({ ...s, ratePermille: 1500 }, 1_002_000), 63_000);
  // Never runs backwards if the clock estimate is slightly behind the stamp.
  assert.equal(expectedPosition(s, 999_000), 60_000);
});

test("nudgeRateFor: proportional, clamped, sign-correct", () => {
  assert.equal(nudgeRateFor(500, 1000), 950); // ahead → slow down 5 %
  assert.equal(nudgeRateFor(-500, 1000), 1050); // behind → speed up 5 %
  assert.equal(nudgeRateFor(5000, 1000), 900); // clamp
  assert.equal(nudgeRateFor(-5000, 1000), 1100);
  assert.equal(nudgeRateFor(500, 1500), 1425); // composes with host rate
});

test("in band: no actions", () => {
  const r = reconcile(snap(session(), provider({ currentTimeMs: 65_100 }), 1_005_000), INITIAL_SYNC_STATE);
  assert.deepEqual(r.actions, []);
  assert.equal(r.driftMs, 100);
});

test("small drift: nudge, then release inside the done band", () => {
  // 500 ms ahead → slow to 950.
  let r = reconcile(snap(session(), provider({ currentTimeMs: 65_500 }), 1_005_000), INITIAL_SYNC_STATE);
  assert.deepEqual(r.actions, [{ type: "setRate", permille: 950 }]);
  assert.equal(r.state.nudging, true);
  // Still 400 ahead, rate already 960 → new proportional value.
  r = reconcile(snap(session(), provider({ currentTimeMs: 65_900, ratePermille: 950 }), 1_005_500), r.state);
  assert.deepEqual(r.actions, [{ type: "setRate", permille: 960 }]);
  // Down to 50 ms → back to 1000, nudging off.
  r = reconcile(snap(session(), provider({ currentTimeMs: 66_050, ratePermille: 960 }), 1_006_000), r.state);
  assert.deepEqual(r.actions, [{ type: "setRate", permille: 1000 }]);
  assert.equal(r.state.nudging, false);
  // Between the bands while nudging: keep nudging, no flap back to 1000.
  r = reconcile(snap(session(), provider({ currentTimeMs: 65_300 }), 1_005_000), { ...INITIAL_SYNC_STATE, nudging: true });
  assert.deepEqual(r.actions, [{ type: "setRate", permille: 970 }]);
});

test("large drift: hard seek at the provider's threshold, hold after", () => {
  // YouTube threshold 700: 800 ms behind → seek.
  let r = reconcile(snap(session(), provider({ currentTimeMs: 64_200 }), 1_005_000), INITIAL_SYNC_STATE);
  assert.deepEqual(r.actions, [{ type: "seek", ms: 65_000 }]);
  // 300 ms later the provider still reports the old position → no second seek.
  r = reconcile(snap(session(), provider({ currentTimeMs: 64_500 }), 1_005_300), r.state);
  assert.deepEqual(r.actions, []);
  // HLS threshold 1500: the same 800 ms is a nudge, not a seek.
  r = reconcile(snap(session(), provider({ currentTimeMs: 64_200, capabilities: HLS }), 1_005_000), INITIAL_SYNC_STATE);
  assert.deepEqual(r.actions, [{ type: "setRate", permille: 1080 }]);
});

test("hard seek while nudging resets the rate", () => {
  const r = reconcile(
    snap(session(), provider({ currentTimeMs: 70_000, ratePermille: 950 }), 1_005_000),
    { ...INITIAL_SYNC_STATE, nudging: true },
  );
  assert.deepEqual(r.actions, [{ type: "seek", ms: 65_000 }, { type: "setRate", permille: 1000 }]);
  assert.equal(r.state.nudging, false);
});

test("host pause: one pause, then the latch holds until the provider agrees", () => {
  const paused = session({ playing: false, positionMs: 65_000 });
  let r = reconcile(snap(paused, provider({ currentTimeMs: 65_000 }), 1_005_000), INITIAL_SYNC_STATE);
  assert.deepEqual(r.actions, [{ type: "pause" }]);
  assert.equal(r.state.pending?.kind, "pause");
  // 400 ms later: provider reports buffering (YouTube passes through 3) —
  // no opinion, latch still pending, NO second pause and NO play.
  r = reconcile(snap(paused, provider({ state: "buffering", currentTimeMs: 65_050 }), 1_005_400), r.state);
  assert.deepEqual(r.actions, []);
  assert.equal(r.state.pending?.kind, "pause");
  // 1 s later it reports paused → latch clears.
  r = reconcile(snap(paused, provider({ state: "paused", currentTimeMs: 65_050 }), 1_006_000), r.state);
  assert.deepEqual(r.actions, []);
  assert.equal(r.state.pending, null);
  // Latch expiry: provider never answered → after LATCH_TIMEOUT_MS, re-issue.
  r = reconcile(snap(paused, provider({ currentTimeMs: 65_000 }), 1_005_000), INITIAL_SYNC_STATE);
  r = reconcile(snap(paused, provider({ currentTimeMs: 65_000 }), 1_005_000 + LATCH_TIMEOUT_MS + 1), r.state);
  assert.deepEqual(r.actions, [{ type: "pause" }]);
});

test("host play: viewer paused → play; viewer stalled → NOT told to play", () => {
  let r = reconcile(snap(session(), provider({ state: "paused", currentTimeMs: 65_000 }), 1_005_000), INITIAL_SYNC_STATE);
  assert.deepEqual(r.actions, [{ type: "play" }]);
  r = reconcile(snap(session(), provider({ state: "buffering", currentTimeMs: 65_000 }), 1_005_000), INITIAL_SYNC_STATE);
  assert.deepEqual(r.actions, []);
  // cued / unstarted are also no-opinion for playing-ness.
  r = reconcile(snap(session(), provider({ state: "cued", currentTimeMs: 0 }), 1_005_000), INITIAL_SYNC_STATE);
  assert.ok(!r.actions.some((a) => a.type === "play"));
  // ended stays ended — a viewer whose video finished is not replayed.
  r = reconcile(snap(session(), provider({ state: "ended", currentTimeMs: 65_000 }), 1_005_000), INITIAL_SYNC_STATE);
  assert.ok(!r.actions.some((a) => a.type === "play"));
});

test("viewer stall then resume: seeks forward, nobody waited", () => {
  // Stalled for 3 s: buffering, position frozen at 65_000 while expected ran to 68_000.
  const r = reconcile(snap(session(), provider({ state: "buffering", currentTimeMs: 65_000 }), 1_008_000), INITIAL_SYNC_STATE);
  // Drift is large → a seek is issued even during buffering (the seek target
  // is where the host IS; the player lands there when it can).
  assert.deepEqual(r.actions, [{ type: "seek", ms: 68_000 }]);
  // No play() was issued to a buffering provider.
  assert.ok(!r.actions.some((a) => a.type === "play"));
});

test("seek while session paused re-asserts pause (YouTube seekTo autoplays from cued)", () => {
  const paused = session({ playing: false, positionMs: 120_000 });
  const r = reconcile(snap(paused, provider({ state: "cued", currentTimeMs: 0 }), 1_005_000), INITIAL_SYNC_STATE);
  assert.deepEqual(r.actions, [{ type: "seek", ms: 120_000 }, { type: "pause" }]);
  assert.equal(r.state.pending?.kind, "pause");
});

test("non-nudging provider: seek past 1 s, then 3 s hysteresis", () => {
  let r = reconcile(snap(session(), provider({ currentTimeMs: 63_800, capabilities: DUMB }), 1_005_000), INITIAL_SYNC_STATE);
  assert.deepEqual(r.actions, [{ type: "seek", ms: 65_000 }]);
  // 1.5 s later, still 1.2 s off (slow player): held by hysteresis.
  r = reconcile(snap(session(), provider({ currentTimeMs: 65_300, capabilities: DUMB }), 1_006_500), r.state);
  assert.deepEqual(r.actions, []);
  // 3.5 s later: allowed again.
  r = reconcile(snap(session(), provider({ currentTimeMs: 67_300, capabilities: DUMB }), 1_008_600), r.state);
  assert.deepEqual(r.actions, [{ type: "seek", ms: 68_600 }]);
  // Small drift on a dumb provider: nothing (no nudge, under the seek floor).
  r = reconcile(snap(session(), provider({ currentTimeMs: 65_600, capabilities: DUMB }), 1_005_000), INITIAL_SYNC_STATE);
  assert.deepEqual(r.actions, []);
});

test("host rate change applies when not nudging", () => {
  const fast = session({ ratePermille: 1500 });
  const r = reconcile(snap(fast, provider({ currentTimeMs: 60_000 }), 1_000_000), INITIAL_SYNC_STATE);
  assert.deepEqual(r.actions, [{ type: "setRate", permille: 1500 }]);
});

test("unknown position / error: no actions", () => {
  let r = reconcile(snap(session(), provider({ currentTimeMs: null }), 1_005_000), INITIAL_SYNC_STATE);
  assert.deepEqual(r.actions, []);
  assert.equal(r.driftMs, null);
  r = reconcile(snap(session(), provider({ state: "error" }), 1_005_000), INITIAL_SYNC_STATE);
  assert.deepEqual(r.actions, []);
});

test("state is never mutated in place", () => {
  const s: SyncState = { ...INITIAL_SYNC_STATE };
  reconcile(snap(session(), provider({ currentTimeMs: 70_000 }), 1_005_000), s);
  assert.deepEqual(s, INITIAL_SYNC_STATE);
});
