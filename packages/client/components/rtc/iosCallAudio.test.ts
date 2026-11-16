// Specs for the iOS call audio-session bracket (R5, W3 MUST 2).
// Run with Node's built-in runner:
//   node --test --conditions=browser components/rtc/iosCallAudio.test.ts
//
// What these pin, and what goes wrong without each:
//
//   serialised  — each op starts only after the previous one settled. The
//                 native plugin is serial too, but only for calls that reach
//                 it; the bracket's own `held` state is read between ops, so
//                 two interleaved ops would both see a stale value (a stop
//                 skipped while a start is in flight keeps the app alive in
//                 the background, Guideline 2.5.4).
//   one start   — callLive twice is one `start`.
//   no orphan   — callEnded / interruptionEnded on a bracket that never held
//                 the session sends no `stop` (a failed start leaves the
//                 plugin inactive, so there is nothing to release).
//   interruption — while live, `stop` then `start`, in that order: the plugin
//                 does not observe interruptions, so a bare `start` is a no-op
//                 and the call keeps a session the system deactivated.
//   contained   — a reject (or a synchronous throw) reaches `onFailure` as a
//                 mapped CallAudioFailure and never escapes into the caller,
//                 which is call teardown; the queue keeps working after it.
//   codes       — every reject code CallAudioSession.swift declares has a
//                 mapping here (read from the Swift source, so a code added
//                 there without a mapping fails this spec).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  type CallAudioFailure,
  CALL_AUDIO_REJECT_CODES,
  callAudioFailure,
  createCallAudioBracket,
} from "./iosCallAudio.ts";

type Op = "start" | "stop";
type Outcome = "ok" | { reject: unknown } | { throwSync: unknown };

/**
 * A fake SlogaCallAudio plugin. Each `start`/`stop` consumes the next scripted
 * outcome (default "ok") and settles on a later macrotask, or only when the
 * spec calls `release()` in manual mode, so an op that does not wait for the
 * previous one shows up in the log as an interleaving.
 */
function fakePlugin(opts: { manual?: boolean } = {}) {
  const log: string[] = [];
  const failures: CallAudioFailure[] = [];
  const outcomes: Record<Op, Outcome[]> = { start: [], stop: [] };
  const gates: Array<() => void> = [];
  const make = (name: Op) => (): Promise<void> => {
    const outcome = outcomes[name].shift() ?? "ok";
    if (typeof outcome === "object" && "throwSync" in outcome) {
      log.push(`${name}:throw`);
      throw outcome.throwSync;
    }
    log.push(`${name}:begin`);
    return new Promise<void>((resolve, reject) => {
      const finish = () => {
        if (outcome === "ok") {
          log.push(`${name}:ok`);
          resolve();
        } else {
          log.push(`${name}:reject`);
          reject(outcome.reject);
        }
      };
      if (opts.manual) gates.push(finish);
      else setImmediate(finish);
    });
  };
  const bracket = createCallAudioBracket({
    start: make("start"),
    stop: make("stop"),
    onFailure: (f) => failures.push(f),
  });
  return {
    bracket,
    log,
    failures,
    outcomes,
    pendingCount: () => gates.length,
    release() {
      const next = gates.shift();
      assert.ok(next, "release() with no pending native call");
      next();
    },
  };
}

/** Lets every queued microtask and macrotask run. */
async function flush(rounds = 5) {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

/** A plugin reject as Capacitor's native bridge delivers it. */
function nativeReject(code: string) {
  return Object.assign(new Error(code), { code, data: {} });
}

const count = (log: string[], entry: string) =>
  log.filter((e) => e === entry).length;

test("callLive starts the session once and resolves after start settles", async () => {
  const p = fakePlugin();
  await p.bracket.callLive();
  assert.deepEqual(p.log, ["start:begin", "start:ok"]);
  assert.deepEqual(p.failures, []);
});

test("callLive twice is one start, awaited or not", async () => {
  const awaited = fakePlugin();
  await awaited.bracket.callLive();
  await awaited.bracket.callLive();
  assert.equal(count(awaited.log, "start:begin"), 1);

  const burst = fakePlugin();
  await Promise.all([burst.bracket.callLive(), burst.bracket.callLive()]);
  assert.equal(count(burst.log, "start:begin"), 1);
});

test("callEnded without callLive is a no-op", async () => {
  const p = fakePlugin();
  await p.bracket.callEnded();
  await p.bracket.callEnded();
  assert.deepEqual(p.log, []);
  assert.deepEqual(p.failures, []);
});

test("callLive then callEnded: start, then stop; a second callEnded is a no-op", async () => {
  const p = fakePlugin();
  await p.bracket.callLive();
  await p.bracket.callEnded();
  await p.bracket.callEnded();
  assert.deepEqual(p.log, ["start:begin", "start:ok", "stop:begin", "stop:ok"]);
});

test("serialised: callEnded issued while start is in flight waits for it, then stops", async () => {
  const p = fakePlugin({ manual: true });
  const live = p.bracket.callLive();
  const ended = p.bracket.callEnded();
  await flush();
  assert.deepEqual(p.log, ["start:begin"], "stop began before start settled");
  p.release();
  await flush();
  assert.deepEqual(p.log, ["start:begin", "start:ok", "stop:begin"]);
  p.release();
  await Promise.all([live, ended]);
  assert.deepEqual(p.log, ["start:begin", "start:ok", "stop:begin", "stop:ok"]);
});

test("serialised: each returned promise settles only after its own op", async () => {
  const p = fakePlugin({ manual: true });
  let liveDone = false;
  let endedDone = false;
  void p.bracket.callLive().then(() => (liveDone = true));
  void p.bracket.callEnded().then(() => (endedDone = true));
  await flush();
  assert.equal(liveDone, false);
  p.release();
  await flush();
  assert.equal(liveDone, true);
  assert.equal(endedDone, false, "callEnded resolved before its stop settled");
  p.release();
  await flush();
  assert.equal(endedDone, true);
});

test("interruptionEnded while live: stop then start, never overlapping", async () => {
  const p = fakePlugin({ manual: true });
  const live = p.bracket.callLive();
  const interrupted = p.bracket.interruptionEnded();
  await flush();
  assert.deepEqual(p.log, ["start:begin"]);
  p.release(); // first start
  await flush();
  assert.deepEqual(p.log, ["start:begin", "start:ok", "stop:begin"]);
  p.release(); // the interruption's stop
  await flush();
  assert.deepEqual(p.log, [
    "start:begin",
    "start:ok",
    "stop:begin",
    "stop:ok",
    "start:begin",
  ]);
  p.release(); // the interruption's start
  await Promise.all([live, interrupted]);
  assert.equal(p.pendingCount(), 0);
  assert.deepEqual(p.failures, []);
});

test("after an interruption the bracket is still live: callEnded stops once", async () => {
  const p = fakePlugin();
  await p.bracket.callLive();
  await p.bracket.interruptionEnded();
  await p.bracket.callEnded();
  await p.bracket.callEnded();
  assert.deepEqual(p.log, [
    "start:begin",
    "start:ok",
    "stop:begin",
    "stop:ok",
    "start:begin",
    "start:ok",
    "stop:begin",
    "stop:ok",
  ]);
});

test("interruptionEnded when not live (never, or after callEnded) is a no-op", async () => {
  const never = fakePlugin();
  await never.bracket.interruptionEnded();
  assert.deepEqual(never.log, []);

  const ended = fakePlugin();
  await ended.bracket.callLive();
  await ended.bracket.callEnded();
  ended.log.length = 0;
  await ended.bracket.interruptionEnded();
  assert.deepEqual(ended.log, []);
});

test("a failed start holds nothing: callEnded sends no stop", async () => {
  const p = fakePlugin();
  p.outcomes.start.push({
    reject: nativeReject("call_audio_insufficient_priority"),
  });
  await p.bracket.callLive();
  await p.bracket.callEnded();
  assert.deepEqual(p.log, ["start:begin", "start:reject"]);
  assert.deepEqual(p.failures, ["audio_session_failed"]);
});

test("a failed start: interruptionEnded while live retries start without a stop", async () => {
  const p = fakePlugin();
  p.outcomes.start.push({
    reject: nativeReject("call_audio_insufficient_priority"),
  });
  await p.bracket.callLive();
  await p.bracket.interruptionEnded();
  assert.deepEqual(p.log, [
    "start:begin",
    "start:reject",
    "start:begin",
    "start:ok",
  ]);
  await p.bracket.callEnded();
  assert.equal(count(p.log, "stop:begin"), 1);
});

test("a failed start: the next callLive tries again (the plugin stays inactive)", async () => {
  const p = fakePlugin();
  p.outcomes.start.push({ reject: nativeReject("call_audio_activate_failed") });
  await p.bracket.callLive();
  await p.bracket.callLive();
  await p.bracket.callLive();
  assert.equal(count(p.log, "start:begin"), 2);
});

test("a failed stop keeps the session held: the next callEnded retries", async () => {
  const p = fakePlugin();
  p.outcomes.stop.push({
    reject: nativeReject("call_audio_deactivate_failed"),
  });
  await p.bracket.callLive();
  await p.bracket.callEnded();
  await p.bracket.callEnded();
  await p.bracket.callEnded();
  assert.equal(count(p.log, "stop:begin"), 2);
  assert.deepEqual(p.failures, ["audio_session_failed"]);
});

test("a failed stop during an interruption does not start on top of it", async () => {
  const p = fakePlugin();
  p.outcomes.stop.push({
    reject: nativeReject("call_audio_deactivate_failed"),
  });
  await p.bracket.callLive();
  await p.bracket.interruptionEnded();
  assert.deepEqual(p.log, [
    "start:begin",
    "start:ok",
    "stop:begin",
    "stop:reject",
  ]);
  assert.deepEqual(p.failures, ["audio_session_failed"]);
});

test("a reject never escapes: every op resolves, onFailure gets the mapped code", async () => {
  for (const [code, want] of [
    ["call_audio_unavailable", "unavailable"],
    ["call_audio_category_failed", "audio_session_failed"],
    ["call_audio_insufficient_priority", "audio_session_failed"],
    ["call_audio_activate_failed", "audio_session_failed"],
    ["UNIMPLEMENTED", "unavailable"],
  ] as const) {
    const p = fakePlugin();
    p.outcomes.start.push({ reject: nativeReject(code) });
    await assert.doesNotReject(p.bracket.callLive(), code);
    assert.deepEqual(p.failures, [want], code);
  }
  for (const [code, want] of [
    ["call_audio_deactivate_failed", "audio_session_failed"],
    ["call_audio_unavailable", "unavailable"],
  ] as const) {
    const ended = fakePlugin();
    ended.outcomes.stop.push({ reject: nativeReject(code) });
    await ended.bracket.callLive();
    await assert.doesNotReject(ended.bracket.callEnded(), code);
    assert.deepEqual(ended.failures, [want], code);

    const interrupted = fakePlugin();
    interrupted.outcomes.stop.push({ reject: nativeReject(code) });
    await interrupted.bracket.callLive();
    await assert.doesNotReject(interrupted.bracket.interruptionEnded(), code);
    assert.deepEqual(interrupted.failures, [want], code);
  }
});

test("a synchronous throw from start/stop is contained like a reject", async () => {
  const p = fakePlugin();
  p.outcomes.start.push({ throwSync: new Error("boom") });
  await assert.doesNotReject(p.bracket.callLive());
  assert.deepEqual(p.failures, ["audio_session_failed"]);
  await p.bracket.callLive();
  p.outcomes.stop.push({ throwSync: nativeReject("UNIMPLEMENTED") });
  await assert.doesNotReject(p.bracket.callEnded());
  assert.deepEqual(p.failures, ["audio_session_failed", "unavailable"]);
});

test("a throwing onFailure neither escapes nor stalls the queue", async () => {
  const log: string[] = [];
  let startCalls = 0;
  const bracket = createCallAudioBracket({
    start: () => {
      startCalls++;
      return startCalls === 1
        ? Promise.reject(nativeReject("call_audio_activate_failed"))
        : Promise.resolve();
    },
    stop: () => {
      log.push("stop");
      return Promise.resolve();
    },
    onFailure: () => {
      throw new Error("handler bug");
    },
  });
  await assert.doesNotReject(bracket.callLive());
  await assert.doesNotReject(bracket.callLive());
  await assert.doesNotReject(bracket.callEnded());
  assert.equal(startCalls, 2);
  assert.deepEqual(log, ["stop"]);
});

test("a reject does not break the chain for ops queued behind it", async () => {
  const p = fakePlugin({ manual: true });
  p.outcomes.start.push({ reject: nativeReject("call_audio_category_failed") });
  const a = p.bracket.callLive();
  const b = p.bracket.callLive();
  const c = p.bracket.callEnded();
  await flush();
  p.release(); // first start rejects
  await flush();
  p.release(); // retry start succeeds
  await flush();
  p.release(); // stop
  await Promise.all([a, b, c]);
  assert.deepEqual(p.log, [
    "start:begin",
    "start:reject",
    "start:begin",
    "start:ok",
    "stop:begin",
    "stop:ok",
  ]);
  assert.deepEqual(p.failures, ["audio_session_failed"]);
});

test("callAudioFailure: unknown or malformed rejects are audio_session_failed", () => {
  for (const reason of [
    undefined,
    null,
    "call_audio_unavailable", // a bare string is not a plugin reject
    42,
    new Error("something else"),
    { code: 7 },
    { code: "constructor" },
    { code: "toString" },
    { code: "__proto__" },
    {
      get code() {
        throw new Error("getter");
      },
    },
  ]) {
    assert.equal(callAudioFailure(reason), "audio_session_failed");
  }
  // Capacitor sets message and code to the same fixed string; either is read.
  assert.equal(
    callAudioFailure(new Error("call_audio_unavailable")),
    "unavailable",
  );
  assert.equal(callAudioFailure({ code: "UNAVAILABLE" }), "unavailable");
});

test("every reject code CallAudioSession.swift declares is mapped", () => {
  const swift = readFileSync(
    new URL(
      "../../ios/App/SlogaE2ee/Sources/SlogaE2ee/CallAudioSession.swift",
      import.meta.url,
    ),
    "utf8",
  );
  const enumBody = /private enum Failure: String \{([\s\S]*?)\n\s*\}/.exec(
    swift,
  );
  assert.ok(enumBody, "Failure enum not found in CallAudioSession.swift");
  const declared = [...enumBody[1].matchAll(/case \w+ = "([a-z_]+)"/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(declared.sort(), [
    "call_audio_activate_failed",
    "call_audio_category_failed",
    "call_audio_deactivate_failed",
    "call_audio_insufficient_priority",
    "call_audio_unavailable",
  ]);
  for (const code of declared) {
    assert.ok(CALL_AUDIO_REJECT_CODES.has(code), `unmapped: ${code}`);
  }
  assert.equal(
    CALL_AUDIO_REJECT_CODES.get("call_audio_unavailable"),
    "unavailable",
  );
  for (const code of declared.filter((c) => c !== "call_audio_unavailable")) {
    assert.equal(CALL_AUDIO_REJECT_CODES.get(code), "audio_session_failed");
  }
});
