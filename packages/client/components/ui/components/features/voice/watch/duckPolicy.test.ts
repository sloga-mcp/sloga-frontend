// Unit spec for the movie-ducking policy — Node's built-in runner:
//   node --test components/ui/components/features/voice/watch/duckPolicy.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  WATCH_DUCK_MULT,
  WATCH_DUCK_RELEASE_MS,
  duckDecision,
  duckTracker,
} from "./duckPolicy.ts";

test("duck: disabled never ducks, whatever the speakers say", () => {
  const r = duckDecision(duckTracker(), { enabled: false, remoteSpeaking: true, nowMs: 0 });
  assert.equal(r.mult, 1);
  assert.equal(r.tracker.holdUntilMs, null);
});

test("duck: a remote speaker ducks; silence holds through the release, then lifts", () => {
  let r = duckDecision(duckTracker(), { enabled: true, remoteSpeaking: true, nowMs: 1000 });
  assert.equal(r.mult, WATCH_DUCK_MULT);
  // They stop: still ducked inside the hold window…
  r = duckDecision(r.tracker, { enabled: true, remoteSpeaking: false, nowMs: 1000 + WATCH_DUCK_RELEASE_MS - 1 });
  assert.equal(r.mult, WATCH_DUCK_MULT);
  // …released once it lapses.
  r = duckDecision(r.tracker, { enabled: true, remoteSpeaking: false, nowMs: 1000 + WATCH_DUCK_RELEASE_MS });
  assert.equal(r.mult, 1);
  assert.equal(r.tracker.holdUntilMs, null);
});

test("duck: continued speech keeps refreshing the hold", () => {
  let r = duckDecision(duckTracker(), { enabled: true, remoteSpeaking: true, nowMs: 0 });
  r = duckDecision(r.tracker, { enabled: true, remoteSpeaking: true, nowMs: 5000 });
  assert.equal(r.tracker.holdUntilMs, 5000 + WATCH_DUCK_RELEASE_MS);
  // A gap shorter than the hold never lifts.
  r = duckDecision(r.tracker, { enabled: true, remoteSpeaking: false, nowMs: 5300 });
  assert.equal(r.mult, WATCH_DUCK_MULT);
});

test("duck: turning the feature off mid-hold releases immediately", () => {
  let r = duckDecision(duckTracker(), { enabled: true, remoteSpeaking: true, nowMs: 0 });
  r = duckDecision(r.tracker, { enabled: false, remoteSpeaking: false, nowMs: 100 });
  assert.equal(r.mult, 1);
  assert.equal(r.tracker.holdUntilMs, null);
});

test("duck: nobody ever spoke — nothing to do", () => {
  const r = duckDecision(duckTracker(), { enabled: true, remoteSpeaking: false, nowMs: 0 });
  assert.equal(r.mult, 1);
});
