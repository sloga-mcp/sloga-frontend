// Unit spec for the native shells' wait on a new account's email
// confirmation. Run it with Node's built-in runner from packages/client:
//   node --test --conditions=browser components/auth/src/flows/verifyWait.test.ts
// Declared test count: 13 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
// Focus: only `UnverifiedAccount` and "learned nothing" keep the wait going,
// any other refusal ends it after ONE request (a retry would count against
// the account's lockout), checks never overlap or come closer than the
// minimum gap, and nothing fires after stop().
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  VERIFY_WAIT_FAST_MS,
  VERIFY_WAIT_FAST_PHASE_MS,
  VERIFY_WAIT_MIN_GAP_MS,
  VERIFY_WAIT_SLOW_MS,
  VERIFY_WAIT_TIMEOUT_MS,
  classifyCheckFailure,
  createVerifyWait,
  nextCheckDelay,
} from "./verifyWait.ts";

const UNVERIFIED = '{"type":"UnverifiedAccount"}';

/** Fake clock, timers and sign-in call for one wait */
function rig(results: Array<"ok" | unknown>) {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let attempts = 0;
  let signedIn = 0;
  let gaveUp = 0;
  let release: (() => void) | undefined;
  let hold = false;

  const wait = createVerifyWait({
    attempt: async () => {
      const result = results[Math.min(attempts, results.length - 1)];
      attempts++;
      if (hold) await new Promise<void>((resolve) => (release = resolve));
      if (result !== "ok") throw result;
    },
    onSignedIn: () => signedIn++,
    onGaveUp: () => gaveUp++,
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (handle) => void timers.delete(handle as number),
  });

  /** Let settled promises run */
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  return {
    wait,
    attempts: () => attempts,
    signedIn: () => signedIn,
    gaveUp: () => gaveUp,
    pending: () => timers.size,
    holdAttempts: () => (hold = true),
    release: async () => {
      release?.();
      await flush();
    },
    /** Move the clock, firing due timers in order */
    advance: async (ms: number) => {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = end;
    },
  };
}

test("delay: fast while young, slow after, none past the timeout", () => {
  assert.equal(nextCheckDelay(0), VERIFY_WAIT_FAST_MS);
  assert.equal(
    nextCheckDelay(VERIFY_WAIT_FAST_PHASE_MS - 1),
    VERIFY_WAIT_FAST_MS,
  );
  assert.equal(nextCheckDelay(VERIFY_WAIT_FAST_PHASE_MS), VERIFY_WAIT_SLOW_MS);
  assert.equal(nextCheckDelay(VERIFY_WAIT_TIMEOUT_MS - 1), VERIFY_WAIT_SLOW_MS);
  assert.equal(nextCheckDelay(VERIFY_WAIT_TIMEOUT_MS), undefined);
});

test("classify: an unconfirmed email keeps waiting", () => {
  assert.equal(classifyCheckFailure(UNVERIFIED), "pending");
  assert.equal(classifyCheckFailure({ type: "UnverifiedAccount" }), "pending");
});

test("classify: nothing learned keeps waiting", () => {
  assert.equal(classifyCheckFailure(new TypeError("Failed to fetch")), "retry");
  assert.equal(classifyCheckFailure("<html>502</html>"), "retry");
  assert.equal(classifyCheckFailure('{"retry_after":4000}'), "retry");
});

test("classify: any other refusal ends the wait", () => {
  for (const type of [
    "InvalidCredentials",
    "LockedOut",
    "CompromisedPassword",
    "MfaRequired",
    "SomethingNew",
  ]) {
    assert.equal(classifyCheckFailure(JSON.stringify({ type })), "stop", type);
  }
});

test("nothing is sent before the first delay", async () => {
  const r = rig([UNVERIFIED]);
  r.wait.start();
  await r.advance(VERIFY_WAIT_FAST_MS - 1);
  assert.equal(r.attempts(), 0);
  await r.advance(1);
  assert.equal(r.attempts(), 1);
});

test("signs in once the email is confirmed, then goes quiet", async () => {
  const r = rig([UNVERIFIED, UNVERIFIED, "ok"]);
  r.wait.start();
  await r.advance(VERIFY_WAIT_FAST_MS * 3);
  assert.equal(r.attempts(), 3);
  assert.equal(r.signedIn(), 1);
  assert.equal(r.pending(), 0);

  await r.advance(VERIFY_WAIT_TIMEOUT_MS);
  r.wait.poke();
  await r.advance(0);
  assert.equal(r.attempts(), 3);
  assert.equal(r.signedIn(), 1);
});

test("a wrong password ends the wait after one request", async () => {
  const r = rig(['{"type":"InvalidCredentials"}']);
  r.wait.start();
  await r.advance(VERIFY_WAIT_TIMEOUT_MS);
  r.wait.poke();
  await r.advance(VERIFY_WAIT_TIMEOUT_MS);
  assert.equal(r.attempts(), 1);
  assert.equal(r.signedIn(), 0);
  assert.equal(r.gaveUp(), 1);
  assert.equal(r.pending(), 0);
});

test("a network failure keeps the timed checks going", async () => {
  const r = rig([new TypeError("Failed to fetch"), "ok"]);
  r.wait.start();
  await r.advance(VERIFY_WAIT_FAST_MS * 2);
  assert.equal(r.attempts(), 2);
  assert.equal(r.signedIn(), 1);
});

test("timed checks slow down, then end at the timeout", async () => {
  const r = rig([UNVERIFIED]);
  r.wait.start();
  await r.advance(VERIFY_WAIT_FAST_PHASE_MS);
  const fast = r.attempts();
  assert.equal(fast, VERIFY_WAIT_FAST_PHASE_MS / VERIFY_WAIT_FAST_MS);

  await r.advance(VERIFY_WAIT_TIMEOUT_MS - VERIFY_WAIT_FAST_PHASE_MS);
  const total = r.attempts();
  assert.equal(
    total - fast,
    (VERIFY_WAIT_TIMEOUT_MS - VERIFY_WAIT_FAST_PHASE_MS) / VERIFY_WAIT_SLOW_MS,
  );

  await r.advance(VERIFY_WAIT_TIMEOUT_MS);
  assert.equal(r.attempts(), total);
  assert.equal(r.pending(), 0);
});

test("coming back to the app checks at once, also after the timeout", async () => {
  const r = rig([UNVERIFIED]);
  r.wait.start();
  await r.advance(1000);
  r.wait.poke();
  await r.advance(0);
  assert.equal(r.attempts(), 1);

  await r.advance(VERIFY_WAIT_TIMEOUT_MS * 2);
  assert.equal(r.pending(), 0);
  const before = r.attempts();
  r.wait.poke();
  await r.advance(0);
  assert.equal(r.attempts(), before + 1);
});

test("pokes inside the minimum gap are dropped", async () => {
  const r = rig([UNVERIFIED]);
  r.wait.start();
  await r.advance(1000);
  r.wait.poke();
  await r.advance(0);
  assert.equal(r.attempts(), 1);

  await r.advance(VERIFY_WAIT_MIN_GAP_MS - 1);
  r.wait.poke();
  await r.advance(0);
  assert.equal(r.attempts(), 1);

  await r.advance(1);
  r.wait.poke();
  await r.advance(0);
  assert.equal(r.attempts(), 2);
});

test("checks never overlap", async () => {
  const r = rig([UNVERIFIED]);
  r.holdAttempts();
  r.wait.start();
  await r.advance(VERIFY_WAIT_FAST_MS);
  assert.equal(r.attempts(), 1);

  r.wait.poke();
  r.wait.poke();
  await r.advance(VERIFY_WAIT_FAST_MS * 4);
  assert.equal(r.attempts(), 1);

  await r.release();
  assert.equal(r.pending(), 1);
});

test("after stop, nothing is sent and a late success is ignored", async () => {
  const r = rig(["ok"]);
  r.holdAttempts();
  r.wait.start();
  await r.advance(VERIFY_WAIT_FAST_MS);
  assert.equal(r.attempts(), 1);

  r.wait.stop();
  await r.release();
  assert.equal(r.signedIn(), 0);
  assert.equal(r.gaveUp(), 0);

  r.wait.poke();
  await r.advance(VERIFY_WAIT_TIMEOUT_MS);
  assert.equal(r.attempts(), 1);
  assert.equal(r.pending(), 0);

  const fresh = rig([UNVERIFIED]);
  fresh.wait.start();
  fresh.wait.stop();
  await fresh.advance(VERIFY_WAIT_TIMEOUT_MS);
  assert.equal(fresh.attempts(), 0);
});
