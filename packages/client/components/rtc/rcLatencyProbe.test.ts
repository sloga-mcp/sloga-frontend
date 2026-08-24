// Unit spec for the press-to-photon probe's state machine —
//   node --conditions=browser --test components/rtc/rcLatencyProbe.test.ts
//
// This is MEASUREMENT code, so the failure mode that matters is not a crash,
// it is a confident wrong number. Every test below pins a way this could
// report a plausible latency that is not the latency.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_PROBE_CONFIG,
  PressToChange,
  summarise,
} from "./rcLatencyProbe.ts";

const cfg = DEFAULT_PROBE_CONFIG;

/** Feed a run of unchanged frames, 16 ms apart, starting at `t`. */
function idle(m: PressToChange, luma: number, from: number, count: number) {
  for (let i = 0; i < count; i++) {
    const s = m.onFrame(luma, from + i * 16);
    assert.equal(s, undefined, "an unchanged frame must not produce a sample");
  }
  return from + count * 16;
}

test("measures keydown to the first changed frame", () => {
  const m = new PressToChange();
  idle(m, 20, 0, 5);
  assert.equal(m.onPress(100, "a"), "armed");
  // frames arriving while nothing has changed yet
  assert.equal(m.onFrame(20, 116), undefined);
  assert.equal(m.onFrame(21, 132), undefined);
  // the flip lands
  const s = m.onFrame(230, 148);
  assert.ok(s, "the changed frame must produce a sample");
  assert.equal(s.ms, 48, "48 ms from press (100) to display (148)");
  assert.equal(s.key, "a");
  assert.equal(s.frames, 3);
});

test("baseline is the frame BEFORE the press, not an average across it", () => {
  // If the baseline averaged over the press, the flip's own luminance would
  // drag it upward and the threshold would trip a frame or two late —
  // over-reporting latency by a frame interval, invisibly.
  const m = new PressToChange();
  idle(m, 20, 0, 3);
  m.onPress(100, "a");
  const s = m.onFrame(20 + cfg.threshold, 116);
  assert.ok(s, "a change of exactly the threshold above the pre-press frame trips");
});

test("a press before any frame is refused rather than measured from nothing", () => {
  const m = new PressToChange();
  assert.equal(m.onPress(10, "a"), "no-frames");
});

test("a second press while one is outstanding is refused, not silently merged", () => {
  // Merging would attribute the FIRST press's change to the SECOND press,
  // reporting a latency far shorter than reality.
  const m = new PressToChange();
  idle(m, 20, 0, 3);
  assert.equal(m.onPress(100, "a"), "armed");
  assert.equal(m.onPress(120, "b"), "busy");
});

test("presses are refused until the scene returns to baseline", () => {
  // The flip decays over ~120 ms. A press during the decay would find the
  // luminance already far from ITS baseline and trip on the previous flip.
  const m = new PressToChange();
  idle(m, 20, 0, 3);
  m.onPress(100, "a");
  assert.ok(m.onFrame(230, 116));
  assert.equal(m.onPress(140, "b"), "settling", "must refuse while still lit");
  // still lit
  m.onFrame(230, 132);
  assert.equal(m.onPress(150, "b"), "settling");
  // back to baseline
  m.onFrame(21, 148);
  assert.equal(m.onPress(160, "b"), "armed");
});

test("a change below the threshold is not a photon", () => {
  const m = new PressToChange();
  idle(m, 20, 0, 3);
  m.onPress(100, "a");
  assert.equal(m.onFrame(20 + cfg.threshold - 1, 116), undefined);
});

test("a press that never lands times out and is COUNTED", () => {
  // A run that silently drops presses otherwise looks like a clean run with
  // fewer samples.
  const m = new PressToChange();
  idle(m, 20, 0, 3);
  m.onPress(100, "a");
  assert.equal(m.timeouts, 0);
  m.onFrame(20, 100 + cfg.timeoutMs + 1);
  assert.equal(m.timeouts, 1, "the abandoned press must be recorded");
  assert.equal(m.busy, false, "and must not block the next press");
  assert.equal(m.onPress(3000, "b"), "armed");
});

test("a total video stall times out on wall clock, not on frames", () => {
  // With no frames at all, the frame-time timeout inside onFrame never runs.
  // Without the wall-clock check an armed press blocks every later press for
  // the rest of the session.
  const m = new PressToChange();
  idle(m, 20, 0, 3);
  m.onPress(100, "a");
  assert.equal(m.checkTimeout(100 + cfg.timeoutMs - 1), false);
  assert.equal(m.checkTimeout(100 + cfg.timeoutMs + 1), true);
  assert.equal(m.timeouts, 1);
  assert.equal(m.busy, false);
});

test("checkTimeout does nothing when no press is outstanding", () => {
  const m = new PressToChange();
  assert.equal(m.checkTimeout(1e9), false);
  assert.equal(m.timeouts, 0);
});

test("reset abandons a press WITHOUT counting it as a timeout", () => {
  // A torn-down surface is not a press that failed to land; conflating them
  // would make a mid-run remount read as packet loss.
  const m = new PressToChange();
  idle(m, 20, 0, 3);
  m.onPress(100, "a");
  m.reset();
  assert.equal(m.timeouts, 0);
  assert.equal(m.busy, false);
  assert.equal(m.onPress(200, "b"), "no-frames", "reset also clears the baseline");
});

test("summarise reports nearest-rank percentiles and no interpolation", () => {
  const s = summarise([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  assert.ok(s);
  assert.equal(s.n, 10);
  assert.equal(s.min, 10);
  assert.equal(s.max, 100);
  assert.equal(s.p50, 60);
  assert.equal(s.mean, 55);
  // every reported percentile must be an ACTUAL observation
  for (const v of [s.min, s.p25, s.p50, s.p75, s.p95, s.max]) {
    assert.ok([10, 20, 30, 40, 50, 60, 70, 80, 90, 100].includes(v));
  }
});

test("summarise of nothing is undefined, not zeroes", () => {
  // Zeroes would render as a 0 ms median — a spectacular wrong number.
  assert.equal(summarise([]), undefined);
});

test("a realistic run produces the expected median", () => {
  const m = new PressToChange();
  const out: number[] = [];
  let t = 0;
  t = idle(m, 20, t, 3);
  for (let i = 0; i < 10; i++) {
    const pressAt = t;
    // change appears ~270 ms later, jittered
    const delay = 260 + (i % 5) * 5;
    let f = t;
    while (f < pressAt + delay) {
      m.onFrame(20, f);
      f += 16;
    }
    assert.equal(m.onPress(pressAt, "a"), "armed", `press ${i} must arm`);
    // re-feed frames after arming so the machine sees them
    const s = m.onFrame(230, pressAt + delay);
    assert.ok(s, `press ${i} must produce a sample`);
    out.push(s.ms);
    // settle
    f = pressAt + delay;
    m.onFrame(20, f + 16);
    t = f + 32;
  }
  const stats = summarise(out);
  assert.ok(stats);
  assert.equal(stats.n, 10);
  assert.ok(stats.p50 >= 260 && stats.p50 <= 280, `median ${stats.p50}`);
});
