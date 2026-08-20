// Unit spec for the watch-together visibility policy — Node's built-in runner:
//   node --test components/ui/components/features/voice/watch/watchPolicy.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AUTOPLAY_GRACE_MS,
  HOST_UNREACHABLE_AFTER_MS,
  IDLE_BOOT_GRACE_MS,
  PAUSED_SCRUB_JITTER_MS,
  hostUnreachable,
  hostWriteIsNoop,
  isHostTransition,
  needsTapToStart,
  pauseIsEnvironmental,
  pausedScrubTracker,
  pausedScrubWrite,
  shouldResumeSuspendedHost,
  watchButtonVisible,
  watchCanStart,
  watchOverlayVisible,
} from "./watchPolicy.ts";

const LIVE = { enabled: true, connected: true, hasSession: true, immersive: false };

test("overlay: every veto input vetoes on its own", () => {
  assert.equal(watchOverlayVisible(LIVE), true);
  assert.equal(watchOverlayVisible({ ...LIVE, enabled: false }), false);
  assert.equal(watchOverlayVisible({ ...LIVE, connected: false }), false);
  assert.equal(watchOverlayVisible({ ...LIVE, hasSession: false }), false);
  assert.equal(watchOverlayVisible({ ...LIVE, immersive: true }), false);
});

test("button: flag darkens everything; permission OR an existing session shows it", () => {
  const base = { enabled: true, connected: true, hasPermission: true, hasSession: false };
  assert.equal(watchButtonVisible(base), true);
  assert.equal(watchButtonVisible({ ...base, enabled: false }), false);
  assert.equal(watchButtonVisible({ ...base, connected: false }), false);
  // No permission but a session is running → still shown (opens the overlay).
  assert.equal(watchButtonVisible({ ...base, hasPermission: false, hasSession: true }), true);
  assert.equal(watchButtonVisible({ ...base, hasPermission: false }), false);
});

test("canStart: needs permission and no existing session", () => {
  const base = { enabled: true, connected: true, hasPermission: true, hasSession: false };
  assert.equal(watchCanStart(base), true);
  assert.equal(watchCanStart({ ...base, hasSession: true }), false);
  assert.equal(watchCanStart({ ...base, hasPermission: false }), false);
  assert.equal(watchCanStart({ ...base, enabled: false }), false);
});

test("hostUnreachable: only while playing, only past the window", () => {
  assert.equal(hostUnreachable({ playing: true, lastUpdateLocalMs: 0, nowLocalMs: HOST_UNREACHABLE_AFTER_MS }), false);
  assert.equal(hostUnreachable({ playing: true, lastUpdateLocalMs: 0, nowLocalMs: HOST_UNREACHABLE_AFTER_MS + 1 }), true);
  assert.equal(hostUnreachable({ playing: false, lastUpdateLocalMs: 0, nowLocalMs: 10 * HOST_UNREACHABLE_AFTER_MS }), false);
  assert.equal(hostUnreachable({ playing: true, lastUpdateLocalMs: null, nowLocalMs: 1e9 }), false);
});

test("needsTapToStart: fires past the grace from every parked state, incl. idle (bug 7.2a B)", () => {
  const base = { sessionPlaying: true, playAskedAtMs: 0, nowLocalMs: AUTOPLAY_GRACE_MS + 1 };
  for (const providerState of ["cued", "unstarted", "paused", "idle"]) {
    assert.equal(needsTapToStart({ ...base, providerState }), true, providerState);
  }
  // Still trying / already going / has its own surface / finished: no tap.
  for (const providerState of ["buffering", "playing", "error", "ended"]) {
    assert.equal(needsTapToStart({ ...base, providerState }), false, providerState);
  }
});

test("needsTapToStart: idle grace anchors on the provider's ready moment (7.2b item 7)", () => {
  const base = { sessionPlaying: true, playAskedAtMs: 0, providerState: "idle" };
  // Booting (ready not reported yet): the short grace must NOT flash…
  assert.equal(needsTapToStart({ ...base, nowLocalMs: AUTOPLAY_GRACE_MS + 1, readyAtMs: null }), false);
  // …but the long boot grace still prompts eventually (bug-B backstop).
  assert.equal(needsTapToStart({ ...base, nowLocalMs: IDLE_BOOT_GRACE_MS + 1, readyAtMs: null }), true);
  // Ready landed late: the grace restarts from readyAtMs, not playAskedAtMs.
  const readyAtMs = 5000;
  assert.equal(needsTapToStart({ ...base, nowLocalMs: readyAtMs + AUTOPLAY_GRACE_MS, readyAtMs }), false);
  assert.equal(needsTapToStart({ ...base, nowLocalMs: readyAtMs + AUTOPLAY_GRACE_MS + 1, readyAtMs }), true);
  // A play() asked AFTER ready anchors on the ask.
  assert.equal(
    needsTapToStart({ ...base, playAskedAtMs: 8000, nowLocalMs: 8000 + AUTOPLAY_GRACE_MS, readyAtMs }),
    false,
  );
  // Providers that don't report readiness keep the legacy rule.
  assert.equal(needsTapToStart({ ...base, nowLocalMs: AUTOPLAY_GRACE_MS + 1 }), true);
  // Non-idle states never consult readiness.
  assert.equal(
    needsTapToStart({ ...base, providerState: "paused", nowLocalMs: AUTOPLAY_GRACE_MS + 1, readyAtMs: null }),
    true,
  );
});

test("pauseIsEnvironmental: only a host pause in a hidden tab during a playing session (7.2c)", () => {
  const env = { isHost: true, providerState: "paused", documentHidden: true, sessionPlaying: true };
  assert.equal(pauseIsEnvironmental(env), true);
  // A visible tab CAN be clicked — that pause is host intent.
  assert.equal(pauseIsEnvironmental({ ...env, documentHidden: false }), false);
  // Viewers have their own corrector; the rule is host-only.
  assert.equal(pauseIsEnvironmental({ ...env, isHost: false }), false);
  // A pause agreeing with a paused session changes nothing.
  assert.equal(pauseIsEnvironmental({ ...env, sessionPlaying: false }), false);
  // Only pause is ever environmental — ended/playing are real.
  assert.equal(pauseIsEnvironmental({ ...env, providerState: "ended" }), false);
  assert.equal(pauseIsEnvironmental({ ...env, providerState: "playing" }), false);
});

test("shouldResumeSuspendedHost: rejoin only when shown and still playing", () => {
  const base = { suspended: true, documentHidden: false, sessionPlaying: true };
  assert.equal(shouldResumeSuspendedHost(base), true);
  // Still hidden: play() would just fight the browser.
  assert.equal(shouldResumeSuspendedHost({ ...base, documentHidden: true }), false);
  // Session paused for real in the meantime: nothing to rejoin.
  assert.equal(shouldResumeSuspendedHost({ ...base, sessionPlaying: false }), false);
  assert.equal(shouldResumeSuspendedHost({ ...base, suspended: false }), false);
});

test("hostWriteIsNoop: a keyed write that restates the session is dropped (7.2c governor)", () => {
  // Session paused at 60 s: expected position IS 60 s.
  const paused = {
    isHeartbeat: false,
    hasMedia: false,
    playing: false,
    positionMs: 60_000,
    ratePermille: 1000,
    sessionPlaying: false,
    sessionRatePermille: 1000,
    sessionExpectedMs: 60_000,
  };
  assert.equal(hostWriteIsNoop(paused), true);
  // Anything the session doesn't already say goes through…
  assert.equal(hostWriteIsNoop({ ...paused, playing: true }), false);
  assert.equal(hostWriteIsNoop({ ...paused, ratePermille: 1250 }), false);
  assert.equal(hostWriteIsNoop({ ...paused, positionMs: 62_000 }), false);
  // …a real scrub barely past the tolerance included.
  assert.equal(hostWriteIsNoop({ ...paused, positionMs: 61_001 }), false);
  assert.equal(hostWriteIsNoop({ ...paused, positionMs: 61_000 }), true);
  // Heartbeats and media writes are NEVER dropped (TTL / not derivable).
  assert.equal(hostWriteIsNoop({ ...paused, isHeartbeat: true }), false);
  assert.equal(hostWriteIsNoop({ ...paused, hasMedia: true }), false);
  // Playing on the line: a transition re-assert with an on-line position is
  // a no-op; a genuinely drifted player position is not.
  const playing = {
    ...paused,
    playing: true,
    sessionPlaying: true,
    positionMs: 120_400,
    sessionExpectedMs: 120_000,
  };
  assert.equal(hostWriteIsNoop(playing), true);
  assert.equal(hostWriteIsNoop({ ...playing, positionMs: 125_000 }), false);
});

test("pausedScrubWrite: a scrub is a jump that holds still; a moving clock is chased never (7.2c)", () => {
  // Real scrub: jump 0 → 90 s, then the paused player's clock freezes.
  let t = pausedScrubTracker();
  let r = pausedScrubWrite(t, 90_000, 0);
  assert.equal(r.write, false); // first sighting: not yet stable
  r = pausedScrubWrite(r.tracker, 90_000, 0);
  assert.equal(r.write, true); // held still one tick: write it
  // Report jitter within the band still counts as stable.
  r = pausedScrubWrite(r.tracker, 90_000 + PAUSED_SCRUB_JITTER_MS, 0);
  assert.equal(r.write, true);
  // An ADVANCING clock under a paused claim never stabilizes → no writes.
  t = pausedScrubTracker();
  let ms = 10_000;
  for (let i = 0; i < 20; i++) {
    r = pausedScrubWrite(t, ms, 0);
    assert.equal(r.write, false, `advancing tick ${i}`);
    t = r.tracker;
    ms += 500;
  }
  // An OSCILLATING clock (0 ↔ X) never stabilizes either.
  t = pausedScrubTracker();
  for (let i = 0; i < 20; i++) {
    r = pausedScrubWrite(t, i % 2 ? 30_000 : 0, 0);
    assert.equal(r.write, false, `oscillating tick ${i}`);
    t = r.tracker;
  }
  // Within a second of the session: parked, nothing to say.
  t = pausedScrubTracker();
  r = pausedScrubWrite(t, 500, 0);
  r = pausedScrubWrite(r.tracker, 500, 0);
  assert.equal(r.write, false);
  // A null clock resets the tracker — no stale stability across a gap.
  t = { lastReadMs: 90_000 };
  r = pausedScrubWrite(t, null, 0);
  assert.equal(r.write, false);
  assert.equal(r.tracker.lastReadMs, null);
});

test("needsTapToStart: session paused, never-asked, and in-grace all stay quiet", () => {
  const idle = { providerState: "idle", playAskedAtMs: 0, nowLocalMs: AUTOPLAY_GRACE_MS + 1 };
  assert.equal(needsTapToStart({ ...idle, sessionPlaying: false }), false);
  assert.equal(
    needsTapToStart({ providerState: "idle", sessionPlaying: true, playAskedAtMs: null, nowLocalMs: 10_000 }),
    false,
  );
  assert.equal(
    needsTapToStart({ providerState: "idle", sessionPlaying: true, playAskedAtMs: 0, nowLocalMs: AUTOPLAY_GRACE_MS }),
    false,
  );
});

test("isHostTransition: same session under a new host, and only that", () => {
  // The handoff shape.
  assert.equal(
    isHostTransition({ prevId: "s1", prevHostId: "alice", nextId: "s1", nextHostId: "bob" }),
    true,
  );
  // A NEW session is never a transition (the provider rebuild resets all).
  assert.equal(
    isHostTransition({ prevId: "s1", prevHostId: "alice", nextId: "s2", nextHostId: "bob" }),
    false,
  );
  // The very first update has nothing to transition from.
  assert.equal(
    isHostTransition({ prevId: undefined, prevHostId: undefined, nextId: "s1", nextHostId: "bob" }),
    false,
  );
  // Same host: an ordinary update.
  assert.equal(
    isHostTransition({ prevId: "s1", prevHostId: "alice", nextId: "s1", nextHostId: "alice" }),
    false,
  );
});
