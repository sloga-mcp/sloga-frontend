// Unit spec for the activity status sync. Run with Node's built-in runner
// from packages/client:
//   node --test --conditions=browser components/client/activitySync.test.ts
// Declared test count: 11 tests (the runner also exits 0 when it finds no
// tests at all, so compare this against its pass count).
//
// Focus: a failed request is retried on a timer even though the detector
// keeps re-sending the SAME value (the v0.71 report: the game stayed on the
// profile after it closed because the clear failed once and nothing changed
// afterwards). Also: backoff grows and caps, a new value cuts a pending
// backoff short, one request at a time, and dispose stops everything.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ACTIVITY_RETRY_BACKOFF_MS,
  createActivitySync,
} from "./activitySync.ts";

type Pending = {
  target: string | null;
  resolve: () => void;
  reject: () => void;
};

/** A sync wired to a manual clock and requests the test settles by hand */
function harness(backoffMs?: readonly number[]) {
  const requests: Pending[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextTimer = 1;

  const sync = createActivitySync({
    push(target) {
      return new Promise<void>((resolve, reject) => {
        requests.push({
          target,
          resolve,
          reject: () => reject(new Error("x")),
        });
      });
    },
    schedule(fn, ms) {
      const id = nextTimer++;
      timers.set(id, { fn, ms });
      return id;
    },
    cancel(handle) {
      timers.delete(handle as number);
    },
    backoffMs,
  });

  return {
    sync,
    requests,
    /** Delays of the timers waiting to fire */
    delays: () => [...timers.values()].map((t) => t.ms),
    /** Fire every waiting timer */
    fire() {
      const due = [...timers.entries()];
      timers.clear();
      for (const [, t] of due) t.fn();
    },
    sent: () => requests.map((r) => r.target),
  };
}

/** Let promise callbacks run */
const settle = () => new Promise((r) => setTimeout(r, 0));

const hasActivity = () => true;
const noActivity = () => false;

test("first run with nothing to clear sends nothing", async () => {
  const h = harness();
  h.sync.update(null, noActivity);
  h.sync.update(null, noActivity);
  await settle();
  assert.deepEqual(h.sent(), []);
});

test("first run clears an activity left on the server", async () => {
  const h = harness();
  h.sync.update(null, hasActivity);
  await settle();
  assert.deepEqual(h.sent(), [null]);
});

test("a value is sent once, and repeats of it are ignored", async () => {
  const h = harness();
  h.sync.update("Call of Duty", noActivity);
  h.requests[0].resolve();
  await settle();
  h.sync.update("Call of Duty", hasActivity);
  h.sync.update("Call of Duty", hasActivity);
  await settle();
  assert.deepEqual(h.sent(), ["Call of Duty"]);
  assert.deepEqual(h.delays(), []);
});

test("a failed clear is retried while the detector keeps sending the same null", async () => {
  const h = harness();
  h.sync.update("Call of Duty", noActivity);
  h.requests[0].resolve();
  await settle();

  // The game closes and the clear fails.
  h.sync.update(null, hasActivity);
  h.requests[1].reject();
  await settle();

  // The detector re-sends null every 30 s: not a change.
  h.sync.update(null, hasActivity);
  h.sync.update(null, hasActivity);
  await settle();
  assert.deepEqual(h.sent(), ["Call of Duty", null]);
  assert.deepEqual(h.delays(), [ACTIVITY_RETRY_BACKOFF_MS[0]]);

  // The retry fires and goes through; nothing more is scheduled.
  h.fire();
  await settle();
  assert.deepEqual(h.sent(), ["Call of Duty", null, null]);
  h.requests[2].resolve();
  await settle();
  assert.deepEqual(h.delays(), []);

  h.sync.update(null, hasActivity);
  await settle();
  assert.equal(h.requests.length, 3);
});

test("backoff grows with each failure and repeats its last step", async () => {
  const h = harness([10, 20, 40]);
  h.sync.update("Game", noActivity);
  const seen: number[] = [];
  for (let i = 0; i < 5; i++) {
    h.requests[i].reject();
    await settle();
    seen.push(...h.delays());
    h.fire();
    await settle();
  }
  assert.deepEqual(seen, [10, 20, 40, 40, 40]);
  assert.equal(h.requests.length, 6);
});

test("backoff resets after a success", async () => {
  const h = harness([10, 20, 40]);
  h.sync.update("A", noActivity);
  h.requests[0].reject();
  await settle();
  h.fire();
  h.requests[1].reject();
  await settle();
  assert.deepEqual(h.delays(), [20]);
  h.fire();
  h.requests[2].resolve();
  await settle();

  h.sync.update("B", hasActivity);
  h.requests[3].reject();
  await settle();
  assert.deepEqual(h.delays(), [10]);
});

test("a new value during a backoff is sent at once and cancels the wait", async () => {
  const h = harness();
  h.sync.update("A", noActivity);
  h.requests[0].reject();
  await settle();
  assert.equal(h.delays().length, 1);

  h.sync.update(null, hasActivity);
  await settle();
  assert.deepEqual(h.sent(), ["A", null]);
  assert.deepEqual(h.delays(), []);
});

test("after a failure the old value is sent again, not assumed to be on the server", async () => {
  // A request that timed out may still have applied, so going back to the
  // last confirmed value must send it rather than skip it.
  const h = harness();
  h.sync.update("A", noActivity);
  h.requests[0].resolve();
  await settle();
  h.sync.update(null, hasActivity);
  h.requests[1].reject();
  await settle();

  h.sync.update("A", hasActivity);
  await settle();
  assert.deepEqual(h.sent(), ["A", null, "A"]);
});

test("only one request is in flight; the latest value follows it", async () => {
  const h = harness();
  h.sync.update("A", noActivity);
  h.sync.update("B", hasActivity);
  h.sync.update(null, hasActivity);
  await settle();
  assert.deepEqual(h.sent(), ["A"]);

  h.requests[0].resolve();
  await settle();
  assert.deepEqual(h.sent(), ["A", null]);
});

test("a push that throws is retried like a rejection", async () => {
  const delays: number[] = [];
  let calls = 0;
  const sync = createActivitySync({
    push() {
      calls++;
      throw new Error("no user");
    },
    schedule(_fn, ms) {
      delays.push(ms);
      return 1;
    },
    cancel() {},
  });
  sync.update("A", noActivity);
  await settle();
  assert.equal(calls, 1);
  assert.deepEqual(delays, [ACTIVITY_RETRY_BACKOFF_MS[0]]);
});

test("dispose cancels a waiting retry and schedules no new one", async () => {
  const h = harness();
  h.sync.update("A", noActivity);
  h.requests[0].reject();
  await settle();
  h.sync.dispose();
  assert.deepEqual(h.delays(), []);

  const h2 = harness();
  h2.sync.update("A", noActivity);
  h2.sync.dispose();
  h2.requests[0].reject();
  await settle();
  assert.deepEqual(h2.delays(), []);
  h2.sync.update("B", hasActivity);
  await settle();
  assert.equal(h2.requests.length, 1);
});
