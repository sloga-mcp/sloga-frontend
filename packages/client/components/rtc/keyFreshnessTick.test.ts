// Specs for the page half of the e2ee worker's dead-man switch (plan D9).
// Run with Node's built-in runner:
//   node --test --conditions=browser components/rtc/keyFreshnessTick.test.ts
//
// What these pin, and what goes wrong without each:
//
//   platform    — ticks only on iOS. An armed switch on a minimised
//                 WebView2/Electron window, whose timers are throttled, would
//                 mute desktop callers.
//   immediate   — the first tick goes out at start, not 2 s later, so the
//                 worker is armed from the first encoded frame.
//   cadence     — one interval, at KEY_TICK_INTERVAL_MS, with a fresh `at`
//                 each time, inside the worker's 8000 ms stale bound.
//   resilience  — a throwing `post` (or clock) neither escapes `start` nor
//                 stops the timer. A dead timer leaves an armed worker muted
//                 for the rest of the call with no way back.
//   teardown    — `stop` is idempotent and terminal: one clearInterval, and no
//                 post from an interval callback already queued when it ran.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type KeyTickMessage,
  KEY_TICK_INTERVAL_MS,
  KEY_TICK_KIND,
  keyTickEnabled,
  startKeyFreshnessTick,
} from "./keyFreshnessTick.ts";

/**
 * The patched worker's `SLOGA_KEY_TICK_STALE_MS` (C-W3-1 item 8). It lives on
 * the other side of the worker boundary and is pinned in the patch text by
 * `livekitPatchHunks.test.ts`. It is restated here only to check the margin.
 */
const WORKER_KEY_TICK_STALE_MS = 8_000;

interface Interval {
  callback: () => void;
  ms: number;
  handle: { id: number };
}

interface Rig {
  stop: () => void;
  posts: KeyTickMessage[];
  intervals: Interval[];
  cleared: unknown[];
  /** Fire every interval that was scheduled, like one timer period passing. */
  fire(): void;
  setClock(at: number): void;
}

function rig(
  options: {
    post?: (message: KeyTickMessage) => void;
    now?: () => number;
  } = {},
): Rig {
  let clock = 1_000;
  const posts: KeyTickMessage[] = [];
  const intervals: Interval[] = [];
  const cleared: unknown[] = [];
  let nextId = 1;
  const stop = startKeyFreshnessTick({
    post:
      options.post ??
      ((message) => {
        posts.push(message);
      }),
    now: options.now ?? (() => clock),
    setInterval: (callback, ms) => {
      const handle = { id: nextId++ };
      intervals.push({ callback, ms, handle });
      return handle;
    },
    clearInterval: (handle) => {
      cleared.push(handle);
    },
  });
  return {
    stop,
    posts,
    intervals,
    cleared,
    fire() {
      for (const interval of intervals) interval.callback();
    },
    setClock(at) {
      clock = at;
    },
  };
}

test("platform: ticks only on a script-transform engine (iOS)", () => {
  assert.equal(keyTickEnabled(true), true);
  // Every non-iOS shell: an armed switch there mutes a minimised caller.
  assert.equal(keyTickEnabled(false), false);
});

test("immediate: start posts one well-formed tick before any interval fires", () => {
  const r = rig();
  assert.equal(r.posts.length, 1);
  // Exact shape: livekit's {kind, data} envelope, `at` and nothing else.
  assert.deepEqual(r.posts[0], { kind: "slogaKeyTick", data: { at: 1_000 } });
  assert.equal(KEY_TICK_KIND, "slogaKeyTick");
  r.stop();
});

test("cadence: one interval at 2000 ms, each fire posts with a fresh `at`", () => {
  const r = rig();
  assert.equal(KEY_TICK_INTERVAL_MS, 2_000);
  assert.equal(r.intervals.length, 1);
  assert.equal(r.intervals[0].ms, KEY_TICK_INTERVAL_MS);

  r.setClock(3_000);
  r.fire();
  r.setClock(5_000);
  r.fire();
  assert.deepEqual(
    r.posts.map((m) => m.data.at),
    [1_000, 3_000, 5_000],
  );
  assert.ok(r.posts.every((m) => m.kind === "slogaKeyTick"));
  // Each post is its own object: a reused one could be mutated after posting.
  assert.notEqual(r.posts[1], r.posts[2]);
  assert.equal(r.cleared.length, 0);
  r.stop();
});

test("cadence: the interval leaves at least three lost ticks before the worker's stale bound", () => {
  assert.ok(KEY_TICK_INTERVAL_MS > 0);
  assert.ok(4 * KEY_TICK_INTERVAL_MS <= WORKER_KEY_TICK_STALE_MS);
});

test("resilience: a throwing first post neither escapes start nor stops the timer", () => {
  const delivered: number[] = [];
  let fail = true;
  let clock = 1_000;
  const intervals: Array<() => void> = [];
  const cleared: unknown[] = [];
  let stop: (() => void) | undefined;
  assert.doesNotThrow(() => {
    stop = startKeyFreshnessTick({
      post: (message) => {
        if (fail) throw new Error("worker gone");
        delivered.push(message.data.at);
      },
      now: () => clock,
      setInterval: (callback) => {
        intervals.push(callback);
        return intervals.length;
      },
      clearInterval: (handle) => {
        cleared.push(handle);
      },
    });
  });
  assert.equal(typeof stop, "function");
  assert.equal(intervals.length, 1, "the interval must still be scheduled");
  assert.equal(cleared.length, 0);

  // Still failing: the interval callback swallows it and stays scheduled.
  clock = 3_000;
  assert.doesNotThrow(() => intervals[0]());
  assert.equal(cleared.length, 0);

  // The worker is back: the very next tick reaches it.
  fail = false;
  clock = 5_000;
  intervals[0]();
  clock = 7_000;
  intervals[0]();
  assert.deepEqual(delivered, [5_000, 7_000]);
  assert.equal(cleared.length, 0);
  stop?.();
});

test("resilience: a post that throws on every tick never clears the interval", () => {
  let attempts = 0;
  const r = rig({
    post: () => {
      attempts += 1;
      throw new Error("worker gone");
    },
  });
  for (let i = 0; i < 5; i += 1) assert.doesNotThrow(() => r.fire());
  assert.equal(attempts, 6, "every tick must still try to post");
  assert.equal(r.cleared.length, 0);
  r.stop();
});

test("resilience: a throwing clock is contained the same way", () => {
  let broken = true;
  const posts: number[] = [];
  const r = rig({
    post: (message) => {
      posts.push(message.data.at);
    },
    now: () => {
      if (broken) throw new Error("clock");
      return 9_000;
    },
  });
  assert.doesNotThrow(() => r.fire());
  broken = false;
  r.fire();
  assert.deepEqual(posts, [9_000]);
  assert.equal(r.cleared.length, 0);
  r.stop();
});

test("teardown: stop clears the one interval exactly once, however often it is called", () => {
  const r = rig();
  r.stop();
  r.stop();
  r.stop();
  assert.equal(r.cleared.length, 1);
  assert.equal(r.cleared[0], r.intervals[0].handle);
});

test("teardown: no post after stop, even from an already-queued interval callback", () => {
  const r = rig();
  assert.equal(r.posts.length, 1);
  r.stop();
  r.fire();
  r.fire();
  assert.equal(r.posts.length, 1);
});

test("teardown: separate starts are independent", () => {
  const a = rig();
  const b = rig();
  a.stop();
  b.fire();
  a.fire();
  assert.equal(a.posts.length, 1);
  assert.equal(b.posts.length, 2);
  b.stop();
  assert.equal(b.cleared.length, 1);
});
