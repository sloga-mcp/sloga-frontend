// Unit spec for the YouTube postMessage wire helpers — Node's built-in runner:
//   node --test components/ui/components/features/voice/watch/providers/youtubeWire.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  commandMessage,
  listeningMessage,
  parseYouTubeInput,
  parseYouTubeWatchInput,
  parseYouTubeMessage,
  providerStateFromYt,
  stuckStateTracker,
  trackStuckState,
  youtubeEmbedUrl,
  youtubeErrorText,
} from "./youtubeWire.ts";

test("parseYouTubeInput: every paste shape a user produces", () => {
  const id = "YE7VzlLtp-4";
  for (const s of [
    id,
    `  ${id}  `,
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}&t=42s&list=PL123`,
    `https://m.youtube.com/watch?feature=share&v=${id}`,
    `https://youtu.be/${id}`,
    `https://youtu.be/${id}?si=abc`,
    `youtu.be/${id}`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/embed/${id}?autoplay=1`,
    `https://www.youtube-nocookie.com/embed/${id}`,
    `https://www.youtube.com/live/${id}?feature=share`,
    `https://music.youtube.com/watch?v=${id}`,
  ]) {
    assert.equal(parseYouTubeInput(s), id, s);
  }
  for (const s of ["", "not a url", "https://vimeo.com/12345", "https://youtube.com/watch?v=short", "https://evil.com/watch?v=" + id, "youtube.com/channel/UC123"]) {
    assert.equal(parseYouTubeInput(s), null, s);
  }
});

test("embed url: nocookie host, jsapi, origin, viewer defaults", () => {
  const u = new URL(youtubeEmbedUrl({ videoId: "YE7VzlLtp-4", origin: "https://app.sloga.gg" }));
  assert.equal(u.origin, "https://www.youtube-nocookie.com");
  assert.equal(u.pathname, "/embed/YE7VzlLtp-4");
  assert.equal(u.searchParams.get("enablejsapi"), "1");
  assert.equal(u.searchParams.get("origin"), "https://app.sloga.gg");
  assert.equal(u.searchParams.get("autoplay"), "1");
  assert.equal(u.searchParams.get("controls"), "0");
  assert.equal(u.searchParams.get("playsinline"), "1");
  assert.equal(u.searchParams.get("mute"), null);
  const muted = new URL(youtubeEmbedUrl({ videoId: "YE7VzlLtp-4", origin: "o", mute: true, controls: true }));
  assert.equal(muted.searchParams.get("mute"), "1");
  assert.equal(muted.searchParams.get("controls"), "1");
});

test("outbound messages carry id + channel for cross-talk filtering", () => {
  assert.deepEqual(JSON.parse(listeningMessage("w1")), { event: "listening", id: "w1", channel: "widget" });
  assert.deepEqual(JSON.parse(commandMessage("w1", "seekTo", [120, true])), {
    event: "command",
    func: "seekTo",
    args: [120, true],
    id: "w1",
    channel: "widget",
  });
});

test("parseYouTubeMessage: partial infoDelivery merges only present fields, seconds→ms", () => {
  const r = parseYouTubeMessage(
    JSON.stringify({ event: "infoDelivery", id: "w1", info: { currentTime: 5.25, playbackRate: 1 } }),
    "w1",
  );
  assert.deepEqual(r, { kind: "info", info: { currentTimeMs: 5250, playbackRate: 1 } });
  const full = parseYouTubeMessage(
    { event: "infoDelivery", id: "w1", info: { playerState: 1, duration: 596.5, muted: false, volume: 100, videoData: { title: "Big Buck Bunny" } } },
    "w1",
  );
  assert.deepEqual(full, {
    kind: "info",
    info: { playerState: 1, durationMs: 596500, muted: false, volume: 100, title: "Big Buck Bunny" },
  });
});

test("parseYouTubeMessage: ready / error / other-embed / unknown / garbage", () => {
  assert.deepEqual(parseYouTubeMessage(JSON.stringify({ event: "onReady", id: "w1" }), "w1"), { kind: "ready" });
  assert.deepEqual(parseYouTubeMessage(JSON.stringify({ event: "onError", id: "w1", info: 150 }), "w1"), { kind: "error", code: 150 });
  // Another embed's id (the chat message embed) → ignored.
  assert.deepEqual(parseYouTubeMessage(JSON.stringify({ event: "infoDelivery", id: "other", info: { currentTime: 1 } }), "w1"), { kind: "ignore" });
  // apiInfoDelivery / initialDelivery / future events → ignored, never thrown.
  assert.deepEqual(parseYouTubeMessage(JSON.stringify({ event: "apiInfoDelivery", id: "w1", info: { captions: {} } }), "w1"), { kind: "ignore" });
  assert.deepEqual(parseYouTubeMessage(JSON.stringify({ event: "initialDelivery", id: "w1" }), "w1"), { kind: "ignore" });
  assert.deepEqual(parseYouTubeMessage("not json", "w1"), { kind: "ignore" });
  assert.deepEqual(parseYouTubeMessage(42, "w1"), { kind: "ignore" });
  assert.deepEqual(parseYouTubeMessage(null, "w1"), { kind: "ignore" });
});

test("state map + error text", () => {
  assert.equal(providerStateFromYt(1), "playing");
  assert.equal(providerStateFromYt(2), "paused");
  assert.equal(providerStateFromYt(3), "buffering");
  assert.equal(providerStateFromYt(5), "cued");
  assert.equal(providerStateFromYt(-1), "unstarted");
  assert.equal(providerStateFromYt(0), "ended");
  assert.equal(providerStateFromYt(undefined), null);
  assert.equal(providerStateFromYt(99), null);
  assert.match(youtubeErrorText(150), /disabled embedding/);
  assert.match(youtubeErrorText(101), /disabled embedding/);
  assert.match(youtubeErrorText(100), /not found/);
});

test("trackStuckState: a stale unstarted claim with an advancing clock becomes playing", () => {
  // Simulates the §7.2a bug A trace: playerState stuck at -1 (transition
  // missed) while currentTime streams on at the ~264 ms cadence.
  let t = stuckStateTracker();
  let r = trackStuckState(t, "unstarted", 1000);
  assert.equal(r.state, "unstarted"); // first sample only seeds
  r = trackStuckState(r.tracker, "unstarted", 1264);
  assert.equal(r.state, "unstarted"); // one advance is not proof
  r = trackStuckState(r.tracker, "unstarted", 1528);
  assert.equal(r.state, "playing"); // two consecutive advances = playing
  // ...and idle/cued repair the same way (late join never got a state).
  t = stuckStateTracker();
  r = trackStuckState(t, "idle", 500);
  r = trackStuckState(r.tracker, "idle", 800);
  r = trackStuckState(r.tracker, "idle", 1100);
  assert.equal(r.state, "playing");
});

test("trackStuckState: parked, jittering, or legitimately frozen players are never repaired", () => {
  // Genuinely parked at 0:00 — clock never moves.
  let r = trackStuckState(stuckStateTracker(), "unstarted", 0);
  for (let i = 0; i < 10; i++) r = trackStuckState(r.tracker, "unstarted", 0);
  assert.equal(r.state, "unstarted");
  // Sub-jitter wobble (< STUCK_ADVANCE_MIN_MS per report) never counts.
  r = trackStuckState(stuckStateTracker(), "cued", 1000);
  r = trackStuckState(r.tracker, "cued", 1050);
  r = trackStuckState(r.tracker, "cued", 1099);
  assert.equal(r.state, "cued");
  // A single advance then a stall resets the count.
  r = trackStuckState(stuckStateTracker(), "unstarted", 1000);
  r = trackStuckState(r.tracker, "unstarted", 1300);
  r = trackStuckState(r.tracker, "unstarted", 1300);
  r = trackStuckState(r.tracker, "unstarted", 1600);
  assert.equal(r.state, "unstarted");
  // paused/buffering are outside the repair set even when advancing.
  r = trackStuckState(stuckStateTracker(), "paused", 1000);
  r = trackStuckState(r.tracker, "paused", 1300);
  r = trackStuckState(r.tracker, "paused", 1600);
  assert.equal(r.state, "paused");
  r = trackStuckState(stuckStateTracker(), "buffering", 1000);
  r = trackStuckState(r.tracker, "buffering", 1300);
  r = trackStuckState(r.tracker, "buffering", 1600);
  assert.equal(r.state, "buffering");
  // Reports with no currentTime leave the tracker untouched.
  const seed = trackStuckState(stuckStateTracker(), "unstarted", 1000);
  const noTime = trackStuckState(seed.tracker, "unstarted", null);
  assert.deepEqual(noTime.tracker, seed.tracker);
  // Once a REAL state arrives the tracker resets (no repair carry-over).
  r = trackStuckState(stuckStateTracker(), "unstarted", 1000);
  r = trackStuckState(r.tracker, "unstarted", 1300);
  r = trackStuckState(r.tracker, "playing", 1600);
  r = trackStuckState(r.tracker, "unstarted", 1900);
  assert.equal(r.state, "unstarted");
});

test("watch input: video+list parses both, bare list is flagged, junk is null (4f)", () => {
  const both = parseYouTubeWatchInput(
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabcdefghijklmnopqrstuvwxyz012345",
  );
  assert.deepEqual(both, {
    videoId: "dQw4w9WgXcQ",
    listId: "PLabcdefghijklmnopqrstuvwxyz012345",
  });
  // Bare playlist: recognizably YouTube, but no knowable first video.
  const bare = parseYouTubeWatchInput(
    "https://www.youtube.com/playlist?list=PLabcdefghijklmnopqrstuvwxyz012345",
  );
  assert.equal(bare?.videoId, null);
  assert.equal(bare?.listId, "PLabcdefghijklmnopqrstuvwxyz012345");
  // Plain video link / bare id: no list.
  assert.deepEqual(parseYouTubeWatchInput("https://youtu.be/dQw4w9WgXcQ"), {
    videoId: "dQw4w9WgXcQ",
    listId: null,
  });
  assert.deepEqual(parseYouTubeWatchInput("dQw4w9WgXcQ"), {
    videoId: "dQw4w9WgXcQ",
    listId: null,
  });
  // Junk.
  assert.equal(parseYouTubeWatchInput("not a link"), null);
  // A malformed list param is dropped, the video survives.
  assert.deepEqual(parseYouTubeWatchInput("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=x"), {
    videoId: "dQw4w9WgXcQ",
    listId: null,
  });
});

test("embed url: listId adds playlist params, absent adds none (4f)", () => {
  const url = youtubeEmbedUrl({
    videoId: "dQw4w9WgXcQ",
    origin: "https://app.example",
    listId: "PLabcdefghijklmnopqrstuvwxyz012345",
  });
  assert.ok(url.includes("listType=playlist"));
  assert.ok(url.includes("list=PLabcdefghijklmnopqrstuvwxyz012345"));
  const plain = youtubeEmbedUrl({ videoId: "dQw4w9WgXcQ", origin: "https://app.example" });
  assert.ok(!plain.includes("listType"));
  assert.ok(!plain.includes("list="));
});

test("infoDelivery: videoData.video_id surfaces as info.videoId (4f)", () => {
  const msg = JSON.stringify({
    event: "infoDelivery",
    id: "x",
    info: { currentTime: 1, videoData: { video_id: "AAAAAAAAAAA", title: "Next up" } },
  });
  const parsed = parseYouTubeMessage(msg, "x");
  assert.equal(parsed.kind, "info");
  if (parsed.kind === "info") {
    assert.equal(parsed.info.videoId, "AAAAAAAAAAA");
    assert.equal(parsed.info.title, "Next up");
  }
  // A malformed id never surfaces.
  const bad = parseYouTubeMessage(
    JSON.stringify({ event: "infoDelivery", id: "x", info: { videoData: { video_id: "nope" } } }),
    "x",
  );
  if (bad.kind === "info") assert.equal(bad.info.videoId, undefined);
});
