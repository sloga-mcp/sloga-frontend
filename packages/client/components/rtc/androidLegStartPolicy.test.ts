// Specs for the Android screen-leg start-path policy (screen-leg plan §7.2) —
// run with Node's built-in runner:
//   node --test --conditions=browser components/rtc/androidLegStartPolicy.test.ts
//
// These cover the window the original slice-3 code left unowned: everything
// between `prepare()` (OS consent granted, capture permitted) and `connect()`
// resolving. Throughout it the leg is NOT `active()`, so every §7.4 stop hook
// used to no-op against it — a hang-up, kick or publish gate during those
// seconds left the share to come up into a call that had already ended, and an
// MLS epoch rotation during them left it publishing under a key the rotation
// had just removed a member from.
//
// The second half drives [AndroidLegLifecycle], the leg's state machine, over
// a fake bridge: stop coalescing, the "not stopped" reading of a failed or
// hung native stop, the connect generation that keeps a stale resolution from
// speaking for the wrong share, and the group fence on rotation keys. The last
// spec pins `androidScreenShare.ts` to delegating to it, so these specs run
// the code the app runs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  type GateStopWorld,
  type LegAnnouncer,
  type LegAudioNotice,
  type LegAudioState,
  type LegBridge,
  type LegMutedNotice,
  type LegSendKey,
  type LegStopNotice,
  type NativeFrameKey,
  type NativeStopReason,
  type RekeyFailureNotice,
  AndroidLegLifecycle,
  FRAME_KEY_TIMEOUT_MS,
  gateStopNotice,
  isLegAudioState,
  keyActionAfterConnect,
  legAudioNotice,
  legAudioRequested,
  legMutedNotice,
  nativeShareAudioAvailable,
  nativeShareAvailable,
  nativeStopNotice,
  rekeyFailureNotice,
  staleExitNotice,
  startAttemptCancelled,
  startAttemptStale,
  STOP_TIMEOUT_MS,
} from "./androidLegStartPolicy.ts";
import {
  argumentsOf,
  assertLexesInSync,
  bodiesAfter,
  closerOf,
  codeOf,
  countWired,
  stringsOf,
  wiredAsserter,
  wiredAt,
} from "./sourcePins.harness.ts";

const world = (
  over: Partial<Parameters<typeof startAttemptStale>[0]> = {},
) => ({
  generation: 7,
  currentGeneration: 7,
  roomChanged: false,
  publishGateSize: 0,
  ...over,
});

test("an undisturbed attempt is not stale", () => {
  assert.equal(startAttemptStale(world()), false);
});

test("a stop hook during connect orphans the attempt", () => {
  // Every §7.4 hook bumps the generation BEFORE it looks at the leg, which is
  // the whole mechanism: the hook that fires while nothing is active yet is
  // exactly the one that has to cancel the start.
  assert.equal(startAttemptStale(world({ currentGeneration: 8 })), true);
});

test("a competing tap orphans the earlier attempt, not the later one", () => {
  // Second tap claimed 8; the first attempt still holds 7 and must abandon.
  assert.equal(startAttemptStale(world({ currentGeneration: 8 })), true);
  assert.equal(
    startAttemptStale(world({ generation: 8, currentGeneration: 8 })),
    false,
  );
});

test("leaving or switching the call orphans the attempt", () => {
  assert.equal(startAttemptStale(world({ roomChanged: true })), true);
});

test("any publish-gate reason orphans the attempt", () => {
  // §0.4: the leg STOPS whenever the primary pauses. A share must never come
  // up into a call that is re-securing or mixed.
  assert.equal(startAttemptStale(world({ publishGateSize: 1 })), true);
  assert.equal(startAttemptStale(world({ publishGateSize: 3 })), true);
});

test("a stop hook or a leave CANCELS the attempt", () => {
  // Cancellation = somebody claimed the leg, so the attempt's own failure is
  // expected and must not be reported to the user.
  assert.equal(startAttemptCancelled(world({ currentGeneration: 8 })), true);
  assert.equal(startAttemptCancelled(world({ roomChanged: true })), true);
});

test("🔴 a held publish gate is NOT a cancellation", () => {
  // The attempt still abandons (startAttemptStale is true), but nobody asked
  // for this share to end. Treating the gate as a cancellation swallowed the
  // error toast for a GENUINE failure — a route rejection landing while a
  // re-secure pulse briefly held the gate left the user's explicit tap with
  // no feedback at all.
  assert.equal(startAttemptCancelled(world({ publishGateSize: 1 })), false);
  assert.equal(startAttemptStale(world({ publishGateSize: 1 })), true);
});

test("an undisturbed attempt is not cancelled", () => {
  assert.equal(startAttemptCancelled(world()), false);
});

test("each condition is independently sufficient", () => {
  // Negative control for the three-way OR: none of these may be masked by the
  // others being clean.
  for (const over of [
    { currentGeneration: 8 },
    { roomChanged: true },
    { publishGateSize: 1 },
  ]) {
    assert.equal(startAttemptStale(world(over)), true, JSON.stringify(over));
  }
});

const key = (
  keyB64: string,
  keyIndex: number,
  over: Partial<Pick<LegSendKey, "epoch" | "groupId">> = {},
): LegSendKey => ({
  keyB64,
  keyIndex,
  epoch: 4,
  groupId: "group-1",
  ...over,
});

test("no re-key when the epoch did not move during connect", () => {
  assert.deepEqual(keyActionAfterConnect(key("AAA", 1), key("AAA", 1)), {
    kind: "none",
  });
});

test("a rotation during connect is pushed once the sender exists", () => {
  // The dropped-rotation case: `onLocalScreenKey` saw this while the leg was
  // still connecting and returned, so the attempt reconciles here instead.
  assert.deepEqual(
    keyActionAfterConnect(key("AAA", 1), key("BBB", 2, { epoch: 5 })),
    { kind: "push", key: key("BBB", 2, { epoch: 5 }) },
  );
});

test("a later epoch reusing the key index still re-keys", () => {
  // A key index is unique only within an epoch, so two epochs can reuse one.
  // Comparing indices alone would skip a required rotation and leave the leg
  // publishing under the key a removed member holds.
  assert.deepEqual(
    keyActionAfterConnect(key("AAA", 1), key("BBB", 1, { epoch: 20 })),
    { kind: "push", key: key("BBB", 1, { epoch: 20 }) },
  );
});

test("🔴 changed key MATERIAL alone (same index, epoch, group) re-keys", () => {
  // The material is the secret itself. The case above moves the epoch too,
  // so a reconcile that stopped comparing material would still push there.
  // Here nothing else differs: skipping the push would leave the leg
  // encrypting under the key a removed member holds.
  assert.deepEqual(keyActionAfterConnect(key("AAA", 1), key("BBB", 1)), {
    kind: "push",
    key: key("BBB", 1),
  });
});

test("an epoch move alone still re-keys", () => {
  // Defense in depth alongside the material comparison: the epoch is the
  // fence the native side orders pushes by, so it must travel even when the
  // material/index pair happens to collide.
  assert.deepEqual(
    keyActionAfterConnect(key("AAA", 1), key("AAA", 1, { epoch: 5 })),
    { kind: "push", key: key("AAA", 1, { epoch: 5 }) },
  );
});

test("🔴 changed key INDEX alone (same material, epoch, group) re-keys", () => {
  // The index rides to native with the material and is part of which key the
  // sender encrypts under. Every other push case moves the material or the
  // epoch, so a reconcile that stopped comparing indices would still push
  // there; here only the index differs, and skipping the push would leave the
  // leg on the index it connected with.
  assert.deepEqual(keyActionAfterConnect(key("AAA", 1), key("AAA", 2)), {
    kind: "push",
    key: key("AAA", 2),
  });
});

test("a key from a different group STOPS the leg instead of re-keying", () => {
  // A group re-establish raced the connect. Epochs are only comparable
  // within one group, so the native fence cannot order these two keys — the
  // only safe answer is to stop the leg and let the user share again.
  assert.deepEqual(
    keyActionAfterConnect(
      key("AAA", 1),
      key("BBB", 2, { epoch: 0, groupId: "group-2" }),
    ),
    { kind: "stop" },
  );
});

test("a plaintext leg is never handed a key here", () => {
  // An unannounced upgrade would be a downgrade of a different kind: the rest
  // of the call has not agreed to it.
  assert.deepEqual(keyActionAfterConnect(undefined, key("AAA", 1)), {
    kind: "none",
  });
});

test("🔴 an E2EE leg whose key was cleared during connect STOPS", () => {
  // Fail closed: `resetForGroup` dropped the record mid-connect, so the leg
  // would otherwise stay live under the old group's key it connected with.
  assert.deepEqual(keyActionAfterConnect(key("AAA", 1), undefined), {
    kind: "stop",
  });
});

test("a plaintext leg with no current key stays as it is", () => {
  // No key on either side: nothing to reconcile and nothing to fail closed on.
  assert.deepEqual(keyActionAfterConnect(undefined, undefined), {
    kind: "none",
  });
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every queued microtask run. */
const flush = () => new Promise<void>((r) => setImmediate(r));

/** Whether `promise` has settled yet, either way. */
function settled(promise: Promise<unknown>): () => boolean {
  let done = false;
  const mark = () => {
    done = true;
  };
  void promise.then(mark, mark);
  return () => done;
}

/** Whether `promise` settles, either way, within `ms`. */
async function settlesWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<false>((r) => {
    timer = setTimeout(() => r(false), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      bound,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A lifecycle over a fake bridge. Every native `stop()` hands back a deferred
 * the test settles by hand (`stops`, in call order), every pushed key is
 * recorded as it crossed (`frameKeys`) and then settles as
 * `nativeSetFrameKey` says (at once, by default), and the announcer records
 * what it hears as `"started"` / `"stopped:<reason>"`. `frameKeyTimeoutMs`
 * bounds each push as `FRAME_KEY_TIMEOUT_MS` does in the app (the default
 * when omitted); a spec that leaves a push unsettled passes a short one, so
 * no timer outlives it.
 */
function lifecycle(
  stopTimeoutMs?: number,
  nativeSetFrameKey: (k: NativeFrameKey) => Promise<void> = () =>
    Promise.resolve(),
  frameKeyTimeoutMs?: number,
) {
  const events: string[] = [];
  const stops: Deferred<void>[] = [];
  const frameKeys: NativeFrameKey[] = [];
  const bridge: LegBridge = {
    setFrameKey: (k) => {
      frameKeys.push(k);
      return nativeSetFrameKey(k);
    },
    stop: () => {
      const d = deferred();
      stops.push(d);
      return d.promise;
    },
  };
  const announce: LegAnnouncer = {
    started: () => {
      events.push("started");
    },
    stopped: (reason) => {
      events.push(`stopped:${reason}`);
    },
  };
  const leg = new AndroidLegLifecycle(
    bridge,
    announce,
    stopTimeoutMs,
    frameKeyTimeoutMs,
  );
  return { leg, events, stops, frameKeys };
}

type Rig = ReturnType<typeof lifecycle>;

/** Bring a share up the way native does: `started` lands a bridge hop BEFORE
 * `connect()` resolves. */
async function share(rig: Rig, e2ee?: LegSendKey): Promise<void> {
  const publish = deferred<unknown>();
  const connecting = rig.leg.connect(e2ee, () => publish.promise);
  rig.leg.nativeStarted();
  publish.resolve(undefined);
  await connecting;
}

test(
  "concurrent stops coalesce onto ONE bridge call",
  { timeout: 2000 },
  async () => {
    const rig = lifecycle();
    await share(rig);
    const first = rig.leg.stop();
    const second = rig.leg.stop();
    // The second hook (pause gate + disconnect, say) WAITS for the teardown
    // already running: it neither starts another nor resolves before native
    // has released the MediaProjection.
    assert.equal(rig.stops.length, 1);
    const firstDone = settled(first);
    const secondDone = settled(second);
    await flush();
    assert.equal(firstDone(), false);
    assert.equal(secondDone(), false);
    rig.stops[0].resolve();
    await flush();
    assert.equal(firstDone(), true);
    assert.equal(secondDone(), true);
    assert.deepEqual(rig.events, ["started", "stopped:user"]);
    assert.equal(rig.leg.active(), false);
  },
);

test("a settled stop is not memoized", { timeout: 2000 }, async () => {
  // A memo that outlived its teardown would turn every later hook, and the
  // user's next tap, into a no-op for the rest of the process.
  const rig = lifecycle();
  await share(rig);
  const first = rig.leg.stop();
  const second = rig.leg.stop();
  // Every native stop handed out, so a lost coalesce fails the count below
  // instead of hanging this test.
  for (const stop of rig.stops) stop.resolve();
  await Promise.all([first, second]);
  const third = rig.leg.stop();
  assert.equal(rig.stops.length, 2);
  rig.stops[1].resolve();
  await third;
});

test(
  "🔴 a REJECTED bridge stop leaves active() true and announces nothing",
  { timeout: 2000 },
  async () => {
    // Native may still hold the MediaProjection: the leg is NOT stopped, and
    // the UI must keep saying so, which is what lets the next hook retry.
    const rig = lifecycle();
    await share(rig);
    const failed = rig.leg.stop();
    rig.stops[0].reject(new Error("native stop failed"));
    await assert.doesNotReject(failed);
    assert.equal(rig.leg.active(), true);
    assert.deepEqual(rig.events, ["started"]);
    const retry = rig.leg.stop();
    assert.equal(rig.stops.length, 2);
    rig.stops[1].resolve();
    await retry;
    assert.equal(rig.leg.active(), false);
    assert.deepEqual(rig.events, ["started", "stopped:user"]);
  },
);

test(
  "🔴 a never-settling stop times out as NOT stopped",
  { timeout: 2000 },
  async () => {
    // A lost native settlement must not leave every later stop coalescing
    // onto a dead promise (an unstoppable share): the bound turns it into
    // "not stopped", and the next stop calls native again.
    const rig = lifecycle(5);
    await share(rig);
    const hung = rig.leg.stop();
    // Bounded here as well, so a missing bound fails this assertion rather
    // than the test's own timeout.
    assert.equal(
      await settlesWithin(hung, 500),
      true,
      "the stop never settled",
    );
    await assert.doesNotReject(hung);
    assert.equal(rig.leg.active(), true);
    assert.deepEqual(rig.events, ["started"]);
    const retry = rig.leg.stop();
    assert.equal(rig.stops.length, 2);
    rig.stops[1].resolve();
    await retry;
    assert.equal(rig.leg.active(), false);
    assert.deepEqual(rig.events, ["started", "stopped:user"]);
  },
);

test(
  "🔴 a connect resolving after its share's stopped event cannot resurrect active()",
  { timeout: 2000 },
  async () => {
    const rig = lifecycle();
    const publish = deferred<unknown>();
    const connecting = rig.leg.connect(undefined, () => publish.promise);
    rig.leg.nativeStarted();
    rig.leg.nativeStopped("system");
    publish.resolve(undefined);
    await connecting;
    assert.equal(rig.leg.active(), false);
    assert.deepEqual(rig.events, ["started", "stopped:system"]);
    // A later stop hook finds the share already over: no second
    // end-of-share announcement.
    const later = rig.leg.stop();
    rig.stops[0].resolve();
    await later;
    assert.equal(rig.leg.active(), false);
    assert.deepEqual(rig.events, ["started", "stopped:system"]);
  },
);

test(
  "🔴 a connect resolving after a completed stop() stays down",
  { timeout: 2000 },
  async () => {
    // A hang-up during connect: the stop completes before native ever
    // reported `started`, and the late resolution must not bring the leg up
    // `active()` with nothing running.
    const rig = lifecycle();
    const publish = deferred<unknown>();
    const connecting = rig.leg.connect(undefined, () => publish.promise);
    const stopping = rig.leg.stop();
    rig.stops[0].resolve();
    await stopping;
    publish.resolve(undefined);
    await connecting;
    assert.equal(rig.leg.active(), false);
    assert.deepEqual(rig.events, []);
  },
);

test(
  "🔴 a stale stop resolution cannot stop the NEXT share",
  { timeout: 2000 },
  async () => {
    // The ordinary path: native emits `stopped` before it resolves the call,
    // and the user starts share 2 in between.
    const rig = lifecycle();
    await share(rig);
    const stopping = rig.leg.stop();
    rig.leg.nativeStopped("user");
    await share(rig);
    rig.stops[0].resolve();
    await stopping;
    assert.deepEqual(rig.events, ["started", "stopped:user", "started"]);
    assert.equal(rig.leg.active(), true);
  },
);

test(
  "stop event vs stop resolution announce once in either order",
  { timeout: 2000 },
  async () => {
    // Event first, then the resolution.
    const eventFirst = lifecycle();
    await share(eventFirst);
    const stoppingA = eventFirst.leg.stop();
    eventFirst.leg.nativeStopped("user");
    eventFirst.stops[0].resolve();
    await stoppingA;
    assert.deepEqual(eventFirst.events, ["started", "stopped:user"]);
    assert.equal(eventFirst.leg.active(), false);

    // The resolution first, then a late event.
    const resolutionFirst = lifecycle();
    await share(resolutionFirst);
    const stoppingB = resolutionFirst.leg.stop();
    resolutionFirst.stops[0].resolve();
    await stoppingB;
    resolutionFirst.leg.nativeStopped("user");
    assert.deepEqual(resolutionFirst.events, ["started", "stopped:user"]);
    assert.equal(resolutionFirst.leg.active(), false);
  },
);

test(
  "a cross-group key throws and never reaches the bridge",
  { timeout: 2000 },
  async () => {
    // Epochs are only comparable within one group, so the native epoch fence
    // cannot order this key against the one the leg holds.
    const rig = lifecycle();
    await share(rig, key("AAA", 1));
    await assert.rejects(
      rig.leg.setFrameKey(key("BBB", 2, { epoch: 0, groupId: "group-2" })),
      /different group/,
    );
    assert.equal(rig.frameKeys.length, 0);
  },
);

test(
  "🔴 a REJECTED native re-key rejects the lifecycle push",
  { timeout: 2000 },
  async () => {
    // The caller stops the leg (fail closed) only from the rejection. A push
    // that swallowed it would let the provider report the rotation installed
    // while the phone still encrypts under the old key, which the removed
    // member holds.
    const rig = lifecycle(undefined, () =>
      Promise.reject(new Error("native re-key failed")),
    );
    await share(rig, key("AAA", 1));
    await assert.rejects(
      rig.leg.setFrameKey(key("BBB", 2, { epoch: 5 })),
      /native re-key failed/,
    );
    // It did reach native: this is the bridge's failure, not the fence's.
    assert.deepEqual(rig.frameKeys, [{ keyB64: "BBB", keyIndex: 2, epoch: 5 }]);
  },
);

test(
  "🔴 a SLOW native re-key holds the lifecycle push until it settles",
  { timeout: 2000 },
  async () => {
    // "Installed" must mean the sender encrypts under the new key. A push
    // that resolved first would report the rotation done while native still
    // holds the old key, and a failure landing later would reach nobody.
    const pending: Deferred<void>[] = [];
    let nativeSettled = false;
    const rig = lifecycle(undefined, () => {
      const d = deferred();
      pending.push(d);
      return d.promise.finally(() => {
        nativeSettled = true;
      });
    });
    await share(rig, key("AAA", 1));

    const pushing = rig.leg.setFrameKey(key("BBB", 2, { epoch: 5 }));
    const pushDone = settled(pushing);
    await flush();
    assert.equal(pending.length, 1);
    assert.equal(pushDone(), false, "the push settled before native did");
    pending[0].resolve();
    await pushing;
    assert.equal(nativeSettled, true);

    // A LATE rejection still reaches the caller.
    nativeSettled = false;
    const failing = rig.leg.setFrameKey(key("CCC", 3, { epoch: 6 }));
    const failDone = settled(failing);
    await flush();
    assert.equal(pending.length, 2);
    assert.equal(failDone(), false, "the push settled before native did");
    pending[1].reject(new Error("native re-key failed late"));
    await assert.rejects(failing, /native re-key failed late/);
    assert.equal(nativeSettled, true);
  },
);

test(
  "🔴 a native re-key that never settles rejects after the timeout",
  { timeout: 2000 },
  async () => {
    // A lost native settlement must not leave the leg encrypting under the
    // previous epoch's key, which a removed member holds, with the
    // provider's rotation hung behind it. The bound turns "never" into a
    // rejection, which is what the callers already fail closed on.
    const rig = lifecycle(
      undefined,
      () => new Promise<void>(() => undefined),
      50,
    );
    await share(rig, key("AAA", 1));
    const hung = rig.leg.setFrameKey(key("BBB", 2, { epoch: 5 }));
    // A turn of the event loop, not a wall-clock reading: Node arms timers
    // from its cached loop time, so elapsed time can read short of the bound.
    const done = settled(hung);
    await flush();
    assert.equal(done(), false, "rejected before the bound");
    // Bounded here as well, so a missing bound fails this assertion rather
    // than the test's own timeout.
    assert.equal(
      await settlesWithin(hung, 500),
      true,
      "the re-key never settled",
    );
    await assert.rejects(hung, /re-key timed out/);
    // It did reach native: the hang is the bridge's, not the fence's.
    assert.deepEqual(rig.frameKeys, [{ keyB64: "BBB", keyIndex: 2, epoch: 5 }]);
    // The stop and the notice are the caller's, exactly as for a native
    // rejection: the lifecycle neither stops itself nor announces anything.
    assert.equal(rig.leg.active(), true);
    assert.equal(rig.leg.stopping(), false);
    assert.equal(rig.stops.length, 0);
    assert.deepEqual(rig.events, ["started"]);
  },
);

test(
  "🔴 a native re-key settling after the timeout is absorbed",
  { timeout: 2000 },
  async () => {
    // The timeout already rejected the caller's push, so native's late
    // answer reaches nobody. Either way it goes, it must not surface as an
    // unhandled rejection long after the caller stopped the leg.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const pending: Deferred<void>[] = [];
      const rig = lifecycle(
        undefined,
        () => {
          const d = deferred();
          pending.push(d);
          return d.promise;
        },
        20,
      );
      await share(rig, key("AAA", 1));
      const lateResolve = rig.leg.setFrameKey(key("BBB", 2, { epoch: 5 }));
      const lateReject = rig.leg.setFrameKey(key("CCC", 3, { epoch: 6 }));
      for (const push of [lateResolve, lateReject])
        assert.equal(
          await settlesWithin(push, 500),
          true,
          "the re-key never settled",
        );
      await assert.rejects(lateResolve, /re-key timed out/);
      await assert.rejects(lateReject, /re-key timed out/);
      assert.equal(pending.length, 2);
      pending[0].resolve();
      pending[1].reject(new Error("native re-key failed late"));
      // Two turns of the event loop: the late settlements run, and Node
      // reports any rejection they leave unhandled.
      await flush();
      await flush();
      assert.deepEqual(unhandled, []);
      assert.equal(rig.leg.active(), true);
      assert.deepEqual(rig.events, ["started"]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  },
);

test(
  "a native re-key settling inside the bound keeps its own outcome",
  { timeout: 2000 },
  async () => {
    // The bound only ever replaces "never": a push native answers in time
    // resolves, and a native failure in time surfaces as itself, not as a
    // timeout. Native answers after a real delay rather than a microtask, so
    // a bound that fires at once (unassigned, or zero) fails here too.
    const rig = lifecycle(
      undefined,
      (k) =>
        new Promise<void>((resolve, reject) => {
          setTimeout(() => {
            if (k.epoch === 6) reject(new Error("native re-key failed"));
            else resolve();
          }, 20);
        }),
      1000,
    );
    await share(rig, key("AAA", 1));
    await assert.doesNotReject(
      rig.leg.setFrameKey(key("BBB", 2, { epoch: 5 })),
    );
    await assert.rejects(rig.leg.setFrameKey(key("CCC", 3, { epoch: 6 })), {
      message: "native re-key failed",
    });
    assert.deepEqual(rig.frameKeys, [
      { keyB64: "BBB", keyIndex: 2, epoch: 5 },
      { keyB64: "CCC", keyIndex: 3, epoch: 6 },
    ]);
    assert.equal(rig.leg.active(), true);
  },
);

test(
  "a plaintext share after an e2ee share refuses the old group's key",
  { timeout: 2000 },
  async () => {
    // The plaintext share must rebind the group to NONE: a leftover binding
    // would let the previous share's group key a share that never agreed to
    // be keyed.
    const rig = lifecycle();
    await share(rig, key("AAA", 1));
    rig.leg.nativeStopped("user");
    await share(rig);
    await assert.rejects(
      rig.leg.setFrameKey(key("BBB", 2, { epoch: 5 })),
      /different group/,
    );
    assert.equal(rig.frameKeys.length, 0);
  },
);

test(
  "🔴 the group is bound BEFORE connect resolves",
  { timeout: 2000 },
  async () => {
    // Native reports `started` a bridge hop before `connect()` resolves, so a
    // rotation can find the leg `active()` while connect is still in flight.
    // Binding after the await fail-closed that healthy share.
    const rig = lifecycle();
    const publish = deferred<unknown>();
    const connecting = rig.leg.connect(key("AAA", 1), () => publish.promise);
    rig.leg.nativeStarted();
    await rig.leg.setFrameKey(key("BBB", 2, { epoch: 5 }));
    assert.deepEqual(rig.frameKeys, [{ keyB64: "BBB", keyIndex: 2, epoch: 5 }]);
    publish.resolve(undefined);
    await connecting;
    assert.equal(rig.leg.active(), true);
  },
);

test("the group never crosses the bridge", { timeout: 2000 }, async () => {
  const rig = lifecycle();
  const published: unknown[] = [];
  const connecting = rig.leg.connect(key("AAA", 1), (k) => {
    published.push(k);
    return Promise.resolve();
  });
  rig.leg.nativeStarted();
  await connecting;
  assert.deepEqual(published, [{ keyB64: "AAA", keyIndex: 1, epoch: 4 }]);
  await rig.leg.setFrameKey(key("BBB", 2, { epoch: 5 }));
  assert.deepEqual(rig.frameKeys, [{ keyB64: "BBB", keyIndex: 2, epoch: 5 }]);
});

test(
  "a key pushed to an inactive leg is a silent no-op",
  { timeout: 2000 },
  async () => {
    // A rotation that lands while no share is live has no sender to key:
    // resolve, cross nothing, and do not throw (a throw would read as a
    // failed push and stop a leg that is not there).
    const rig = lifecycle();
    await assert.doesNotReject(rig.leg.setFrameKey(key("AAA", 1)));
    assert.equal(rig.frameKeys.length, 0);

    // Nor after a share ends, even under the group it connected with.
    await share(rig, key("AAA", 1));
    rig.leg.nativeStopped("user");
    await assert.doesNotReject(
      rig.leg.setFrameKey(key("BBB", 2, { epoch: 5 })),
    );
    assert.equal(rig.frameKeys.length, 0);
  },
);

test("a stopped event with no reason announces an error, once", () => {
  const rig = lifecycle();
  rig.leg.nativeStarted();
  rig.leg.nativeStopped(undefined);
  assert.deepEqual(rig.events, ["started", "stopped:error"]);
  assert.equal(rig.leg.active(), false);
});

// The notice an ended (or never-started) share deserves. A KIND, not copy:
// `state.tsx` maps it to a message, so a wrong toast, or a missing one, is
// pinned here, where it shows without a phone.

test("nativeStopNotice: this device's own stops are quiet; failures speak", () => {
  // `user` and `system` are stops taken on this device (our stop, the system
  // chip, the notification's Stop): a toast would report an error for a stop
  // the user asked for. `disconnected` and `error` were not asked for, and
  // the primary's state has no bearing on either.
  const rows: [NativeStopReason, LegStopNotice][] = [
    ["user", "none"],
    ["system", "none"],
    ["disconnected", "connection"],
    ["error", "encryption"],
  ];
  for (const [reason, notice] of rows)
    for (const canPublish of [true, false, undefined])
      for (const inAfkChannel of [true, false])
        assert.equal(
          nativeStopNotice(reason, { canPublish, inAfkChannel }),
          notice,
          `${reason} canPublish=${String(canPublish)} afk=${inAfkChannel}`,
        );
});

test("🔴 nativeStopNotice: a revoke speaks only if the primary kept publish", () => {
  // The server took the leg's publish away. When the loss is primary-wide (a
  // moderator mute: canPublish false; an AFK move: inAfkChannel) the
  // primary's own toast already explains it, and a second one for the leg
  // says the same thing worse. The AFK arm stands on its own: the leg's
  // revoke can land FIRST, while the primary still reports canPublish true.
  // An unknown canPublish is not a primary-wide loss, so the notice stands.
  const rows: [boolean | undefined, boolean, LegStopNotice][] = [
    [true, false, "revoked"],
    [undefined, false, "revoked"],
    [false, false, "none"],
    [true, true, "none"],
    [undefined, true, "none"],
    [false, true, "none"],
  ];
  for (const [canPublish, inAfkChannel, notice] of rows)
    assert.equal(
      nativeStopNotice("revoked", { canPublish, inAfkChannel }),
      notice,
      `canPublish=${String(canPublish)} afk=${inAfkChannel}`,
    );
});

test("nativeStopNotice: a reason newer than this build is quiet", () => {
  // A newer native build can send a reason this JS does not know. An unknown
  // stop is not worth a misleading message, even with the primary in the
  // state where a revoke would speak.
  const future = "preempted" as string as NativeStopReason;
  for (const canPublish of [true, false, undefined])
    for (const inAfkChannel of [true, false])
      assert.equal(
        nativeStopNotice(future, { canPublish, inAfkChannel }),
        "none",
        `canPublish=${String(canPublish)} afk=${inAfkChannel}`,
      );
});

const gate = (over: Partial<GateStopWorld> = {}): GateStopWorld => ({
  startingFor: undefined,
  currentGeneration: 3,
  active: false,
  stopInFlight: false,
  roomConnected: true,
  ...over,
});

test("gateStopNotice: a gate that takes down a live share says so", () => {
  // The gate stops the leg on every reason add (§0.4); without a notice the
  // share simply vanishes.
  assert.equal(gateStopNotice(gate({ active: true })), "gate-share");
  // A live leg whose attempt has not settled yet is still a live share: one
  // notice, the share one, not the start one as well.
  assert.equal(
    gateStopNotice(gate({ active: true, startingFor: 3 })),
    "gate-share",
  );
});

test("🔴 gateStopNotice: a gate joining a stop already in flight is quiet", () => {
  // Something else (a tap, a hook) asked for that teardown and the gate only
  // coalesces onto it; a toast would blame the gate for a stop the user
  // asked for.
  assert.equal(
    gateStopNotice(gate({ active: true, stopInFlight: true })),
    "none",
  );
  assert.equal(
    gateStopNotice(gate({ active: true, stopInFlight: true, startingFor: 3 })),
    "none",
  );
});

test("gateStopNotice: a gate cancelling the owning start attempt says so", () => {
  // The attempt still owns the generation. The gate's stop is about to bump
  // it, so the attempt's own stale check will exit quietly: this is the one
  // place the user hears that the share could not start.
  assert.equal(
    gateStopNotice(gate({ startingFor: 3, currentGeneration: 3 })),
    "gate-start",
  );
});

test("🔴 gateStopNotice: an attempt a tap already cancelled is quiet", () => {
  // The cancelling tap bumped the generation first. That tap ended the
  // share, so a gate toast would contradict what the user just did.
  assert.equal(
    gateStopNotice(gate({ startingFor: 3, currentGeneration: 4 })),
    "none",
  );
});

test("gateStopNotice: nothing starting and nothing live, nothing to say", () => {
  assert.equal(gateStopNotice(gate()), "none");
  // A teardown in flight for a leg that is not active is not a share.
  assert.equal(gateStopNotice(gate({ stopInFlight: true })), "none");
});

test("🔴 gateStopNotice: a disconnected room is quiet, live or starting", () => {
  // A room that is no longer connected is the call ending, which explains
  // itself; a gate toast on top would blame the wrong thing.
  for (const over of [
    { active: true },
    { active: true, startingFor: 3 },
    { startingFor: 3, currentGeneration: 3 },
  ])
    assert.equal(
      gateStopNotice(gate({ ...over, roomConnected: false })),
      "none",
      JSON.stringify(over),
    );
});

test("🔴 staleExitNotice: a gate held before the claim reports the start", () => {
  // Nothing cancelled this attempt (the gate's stop bumped a generation it
  // had not taken yet), and gateStopNotice saw no starting attempt then, so
  // this exit is the only place the user hears that the share never began.
  assert.equal(staleExitNotice(world({ publishGateSize: 1 })), "gate-start");
  assert.equal(staleExitNotice(world({ publishGateSize: 3 })), "gate-start");
});

test("🔴 staleExitNotice: a cancelled attempt is quiet, held gate or not", () => {
  // A tap, a stop hook, a hang-up or gateStopNotice already spoke for it: a
  // notice here would toast one stop twice, or toast a stop the user asked
  // for.
  for (const over of [
    { currentGeneration: 8 },
    { roomChanged: true },
    { currentGeneration: 8, publishGateSize: 1 },
    { roomChanged: true, publishGateSize: 1 },
  ])
    assert.equal(staleExitNotice(world(over)), "none", JSON.stringify(over));
});

test("staleExitNotice: a fresh attempt is not exiting", () => {
  assert.equal(staleExitNotice(world()), "none");
});

test("🔴 rekeyFailureNotice: a share still live after the stop is reported even if something already spoke", () => {
  // Read once the caller's fail-closed stop has settled. A share still live
  // under the same token (activeAfterStop) was NOT stopped, whoever spoke
  // first: a gate-share stop already in flight told the user "stopped" too,
  // and that is the stop that failed. Deferring to it left a live share
  // reported as stopped. Only a share that is really down may stay quiet
  // for whoever spoke (spoken) or be reported stopped.
  const rows: [boolean, boolean, RekeyFailureNotice][] = [
    [false, false, "stopped"],
    [true, false, "none"],
    [false, true, "unstoppable"],
    [true, true, "unstoppable"],
  ];
  for (const [spoken, activeAfterStop, notice] of rows)
    assert.equal(
      rekeyFailureNotice({ spoken, activeAfterStop }),
      notice,
      `spoken=${spoken} activeAfterStop=${activeAfterStop}`,
    );
});

test(
  "stopping() is true exactly while a stop is in flight",
  { timeout: 2000 },
  async () => {
    // gateStopNotice reads it as stopInFlight. Stuck false, every gate that
    // merely joins a tap's stop toasts; stuck true, every gate that takes a
    // live share down goes unannounced.
    const rig = lifecycle();
    await share(rig);
    assert.equal(rig.leg.stopping(), false);
    const stopping = rig.leg.stop();
    assert.equal(rig.leg.stopping(), true);
    await flush();
    assert.equal(rig.leg.stopping(), true);
    rig.stops[0].resolve();
    await stopping;
    assert.equal(rig.leg.stopping(), false);
  },
);

test(
  "🔴 stopping() clears when the bridge stop rejects or times out",
  { timeout: 2000 },
  async () => {
    // A failed stop leaves the leg active() so the next hook retries. A
    // stopping() that outlived it would read as a teardown still under way,
    // and every later gate that takes the share down would go unannounced.
    const rejected = lifecycle();
    await share(rejected);
    const failed = rejected.leg.stop();
    assert.equal(rejected.leg.stopping(), true);
    rejected.stops[0].reject(new Error("native stop failed"));
    await failed;
    assert.equal(rejected.leg.stopping(), false);
    assert.equal(rejected.leg.active(), true);

    const hung = lifecycle(5);
    await share(hung);
    const timedOut = hung.leg.stop();
    assert.equal(hung.leg.stopping(), true);
    assert.equal(
      await settlesWithin(timedOut, 500),
      true,
      "the stop never settled",
    );
    assert.equal(hung.leg.stopping(), false);
    assert.equal(hung.leg.active(), true);
  },
);

test(
  "two concurrent stops: one bridge call, stopping() until it settles",
  { timeout: 2000 },
  async () => {
    // The second caller (a gate pulse during a hang-up, say) joins the
    // teardown already running, and must see it in flight for its whole
    // length, not only until the first caller's call returns.
    const rig = lifecycle();
    await share(rig);
    const first = rig.leg.stop();
    assert.equal(rig.leg.stopping(), true);
    const second = rig.leg.stop();
    assert.equal(rig.stops.length, 1);
    assert.equal(rig.leg.stopping(), true);
    await flush();
    assert.equal(rig.leg.stopping(), true);
    rig.stops[0].resolve();
    await Promise.all([first, second]);
    assert.equal(rig.stops.length, 1);
    assert.equal(rig.leg.stopping(), false);
  },
);

test(
  "🔴 a failed stop keeps the same share token, so the caller still recognizes the share as its own",
  { timeout: 2000 },
  async () => {
    // `state.tsx` samples shareToken() before its fail-closed stop and
    // reports the share unstoppable only while the leg is still active()
    // under the SAME token. A failed stop that moved the token would read the
    // share still live as somebody else's: the user would be told it stopped
    // (or nothing at all) while it is still on the air.
    const rejected = lifecycle();
    await share(rejected);
    const token = rejected.leg.shareToken();
    const failed = rejected.leg.stop();
    assert.equal(rejected.leg.shareToken(), token, "a stop in flight moved it");
    rejected.stops[0].reject(new Error("native stop failed"));
    await failed;
    assert.equal(rejected.leg.active(), true);
    assert.equal(rejected.leg.shareToken(), token, "a rejected stop moved it");

    const hung = lifecycle(5);
    await share(hung);
    const hungToken = hung.leg.shareToken();
    const timedOut = hung.leg.stop();
    assert.equal(
      await settlesWithin(timedOut, 500),
      true,
      "the stop never settled",
    );
    assert.equal(hung.leg.active(), true);
    assert.equal(hung.leg.shareToken(), hungToken, "a timed-out stop moved it");
    // Not a token frozen for good: the retry native resolves does move it.
    const retry = hung.leg.stop();
    hung.stops[1].resolve();
    await retry;
    assert.equal(hung.leg.active(), false);
    assert.ok(hung.leg.shareToken() > hungToken, "a resolved stop kept it");
  },
);

test(
  "shareToken() moves with each share: connect, a resolved stop and nativeStopped",
  { timeout: 2000 },
  async () => {
    const rig = lifecycle();
    assert.equal(rig.leg.shareToken(), 0);
    await share(rig);
    const connected = rig.leg.shareToken();
    assert.ok(connected > 0, "connect did not move it");
    const stopping = rig.leg.stop();
    assert.equal(rig.leg.shareToken(), connected, "a stop in flight moved it");
    rig.stops[0].resolve();
    await stopping;
    assert.equal(rig.leg.active(), false);
    const stopped = rig.leg.shareToken();
    assert.ok(stopped > connected, "a resolved stop did not move it");
    await share(rig);
    const second = rig.leg.shareToken();
    assert.ok(second > stopped, "the next connect did not move it");
    rig.leg.nativeStopped("system");
    assert.ok(rig.leg.shareToken() > second, "nativeStopped did not move it");

    // What the token is for: native ends the share while our stop hangs, the
    // user shares again, and then the stop times out. The leg is active(),
    // but under a new token, so it is not the share that failed to stop.
    const hung = lifecycle(5);
    await share(hung);
    const first = hung.leg.shareToken();
    const timedOut = hung.leg.stop();
    hung.leg.nativeStopped("user");
    await share(hung);
    assert.equal(
      await settlesWithin(timedOut, 500),
      true,
      "the stop never settled",
    );
    assert.equal(hung.leg.active(), true);
    assert.notEqual(hung.leg.shareToken(), first);
  },
);

test(
  "🔴 a revoked stop ends an active leg and announces it once",
  { timeout: 2000 },
  async () => {
    // The server took the leg's publish away. The leg comes down like any
    // other native stop: active() false, so no hook keeps talking to a dead
    // sender, and ONE stopped("revoked") for state.tsx to map to a notice.
    const rig = lifecycle();
    await share(rig);
    rig.leg.nativeStopped("revoked");
    assert.equal(rig.leg.active(), false);
    assert.deepEqual(rig.events, ["started", "stopped:revoked"]);

    // A duplicate event, or a stop resolution racing the revoke, must not
    // announce again (a second end-of-share sound, a "user" stop on top).
    const raced = lifecycle();
    await share(raced);
    const stopping = raced.leg.stop();
    raced.leg.nativeStopped("revoked");
    raced.leg.nativeStopped("revoked");
    raced.stops[0].resolve();
    await stopping;
    assert.equal(raced.leg.active(), false);
    assert.deepEqual(raced.events, ["started", "stopped:revoked"]);
  },
);

test(
  "a revoked stop for a leg that is not active announces nothing",
  { timeout: 2000 },
  async () => {
    // No share was live, so there is nothing to end and nothing to say.
    const rig = lifecycle();
    rig.leg.nativeStopped("revoked");
    assert.equal(rig.leg.active(), false);
    assert.deepEqual(rig.events, []);

    // Revoked while connect is still in flight: the late resolution must not
    // bring the leg up active() under a publish the server already took.
    const publish = deferred<unknown>();
    const connecting = rig.leg.connect(undefined, () => publish.promise);
    rig.leg.nativeStopped("revoked");
    publish.resolve(undefined);
    await connecting;
    assert.equal(rig.leg.active(), false);
    assert.deepEqual(rig.events, []);
  },
);

const SHARE_SOURCE = readFileSync(
  new URL("./androidScreenShare.ts", import.meta.url),
  "utf8",
);
const SHARE_CODE = codeOf(SHARE_SOURCE);

/** `snippet` must appear exactly once in androidScreenShare.ts's code. */
const assertShareWired = wiredAsserter("androidScreenShare.ts", SHARE_CODE);

test("🔴 the plugin's re-key promise is handed to the lifecycle as is", () => {
  // The lifecycle awaits whatever the bridge returns, so a wrapper that drops
  // the plugin's promise (`async (k) => { void plugin!.setFrameKey(k); }`, a
  // trailing `.catch`) turns a failed native re-key into a success: the
  // caller never stops the leg, and the rotation counts as installed while
  // the phone keeps the key a removed member holds. tsc accepts every one of
  // those rewrites; the specs above run a fake bridge, not this lambda.
  const bridgeKey = "setFrameKey: (k) => plugin!.setFrameKey(k),";
  assertShareWired("the bridge's setFrameKey", bridgeKey);
  const constructions = bodiesAfter(
    SHARE_CODE,
    "#core = new AndroidLegLifecycle(",
  );
  assert.equal(constructions.length, 1);
  assert.equal(
    countWired(constructions[0], bridgeKey),
    1,
    "the plugin's setFrameKey must be the lifecycle bridge's, returned as is",
  );
});

test("🔴 androidScreenShare.ts holds no live copy of the lifecycle", () => {
  // The specs above prove the leaf. They prove the APP only while the plugin
  // wrapper is a thin delegate: a re-grown copy of any of this state would
  // run untested in production while every spec here stays green.
  assertShareWired("the delegate", "#core = new AndroidLegLifecycle(");
  assertShareWired(
    "the started event",
    `p.addListener("started", () => {
      this.#core.nativeStarted();
    })`,
  );
  assertShareWired(
    "the stopped event, reason and all",
    `p.addListener("stopped", (data) => {
      this.#core.nativeStopped(data.reason);
    })`,
  );
  assertShareWired("active()", "return this.#core.active();");
  // `state.tsx` reads `stopping()` to tell a gate that ends the share from
  // one that joins a stop already under way; a wrapper-side copy (a constant
  // false, say) would re-toast every coalesced stop while the specs above
  // stay green.
  assertShareWired("stopping()", "return this.#core.stopping();");
  // `state.tsx` compares `shareToken()` across its fail-closed stop to tell
  // the share it acted on from one started meanwhile; a wrapper-side copy (a
  // counter of its own, say) would report a live share as stopped, or a new
  // one as unstoppable, while the specs above stay green.
  assertShareWired("shareToken()", "return this.#core.shareToken();");
  assertShareWired("connect()", "return this.#core.connect(options.e2ee,");
  // The plugin connects with the key the lifecycle hands its callback, which
  // has already lost its group. The caller's own key would carry `groupId`
  // across the bridge, and tsc accepts that (the extra field is no error).
  assertShareWired("the plugin's connect", "(e2ee) => plugin!.connect({");
  // Since slice 4 the field before the key is the caller's audio request
  // (`audio: options.audio`), no longer a hard-coded `false`: the share sheet
  // decides it through `legAudioRequested`. The key itself is unchanged, the
  // callback's group-stripped `e2ee`, never `options.e2ee`.
  assertShareWired("the callback's key", "audio: options.audio, e2ee, })");
  assert.equal(
    countWired(SHARE_CODE, "options.e2ee"),
    1,
    "androidScreenShare.ts must hand the caller's key to the lifecycle only",
  );
  assertShareWired("setFrameKey()", "return this.#core.setFrameKey(key);");
  assertShareWired("stop()", "return this.#core.stop();");
  assert.equal(
    countWired(SHARE_CODE, "#core."),
    8,
    "androidScreenShare.ts must reach the lifecycle through exactly the eight " +
      "delegating calls pinned above",
  );
  for (const field of [
    "#active",
    "#stopPromise",
    "#connectGeneration",
    "#e2eeGroupId",
  ])
    assert.equal(
      countWired(SHARE_CODE, field),
      0,
      `androidScreenShare.ts must not hold its own ${field}`,
    );

  // The owner assigns `onStarted`/`onStopped` AFTER construction, so the
  // announcer must read them at call time; a callback captured here would be
  // undefined forever.
  const constructions = bodiesAfter(
    SHARE_CODE,
    "#core = new AndroidLegLifecycle(",
  );
  assert.equal(constructions.length, 1);
  const [construction] = constructions;
  assert.equal(countWired(construction, "() => this.onStarted?.()"), 1);
  assert.equal(countWired(construction, "=> this.onStopped?.("), 1);
  assert.equal(countWired(construction, "() => plugin!.stop()"), 1);
  assert.equal(countWired(construction, "plugin!.setFrameKey("), 1);
});

const POLICY_SOURCE = readFileSync(
  new URL("./androidLegStartPolicy.ts", import.meta.url),
  "utf8",
);
const POLICY_CODE = codeOf(POLICY_SOURCE);

/** `snippet` must appear exactly once in androidLegStartPolicy.ts's code. */
const assertPolicyWired = wiredAsserter(
  "androidLegStartPolicy.ts",
  POLICY_CODE,
);

test("🔴 every native re-key is bounded, by default at FRAME_KEY_TIMEOUT_MS", () => {
  // The specs above each pass their own short bound, so none of them sees
  // the default the app runs with, or notices a refactor that unhooks the
  // push from the bound while a spec-sized one still happens to fire.
  assert.ok(Number.isFinite(FRAME_KEY_TIMEOUT_MS), "the bound is not finite");
  assert.ok(
    FRAME_KEY_TIMEOUT_MS >= 1000,
    "under a second, a slow phone fails healthy shares closed",
  );
  assert.ok(
    FRAME_KEY_TIMEOUT_MS <= STOP_TIMEOUT_MS,
    "the re-key bound must not leave the old key live longer than a stop",
  );
  assert.ok(
    FRAME_KEY_TIMEOUT_MS <= 5_000,
    "the old key's window is capped at the audited 5 s",
  );
  assertPolicyWired(
    "the constructor default",
    "frameKeyTimeoutMs: number = FRAME_KEY_TIMEOUT_MS,",
  );
  assertPolicyWired(
    "the bound's assignment",
    "this.#frameKeyTimeoutMs = frameKeyTimeoutMs;",
  );
  // One native re-key in the file, and that one inside the bound.
  assert.equal(countWired(POLICY_CODE, "this.#bridge.setFrameKey("), 1);
  assertPolicyWired(
    "the bounded re-key",
    `withTimeout(
      this.#bridge.setFrameKey(`,
  );
  const bodies = bodiesAfter(
    POLICY_CODE,
    "async setFrameKey(key: LegSendKey): Promise<void> {",
  );
  assert.equal(bodies.length, 1);
  assert.equal(
    countWired(
      bodies[0],
      `await withTimeout(
        this.#bridge.setFrameKey({
          keyB64: key.keyB64,
          keyIndex: key.keyIndex,
          epoch: key.epoch,
        }),
        this.#frameKeyTimeoutMs,
        "screen share re-key timed out",
      );`,
    ),
    1,
    "setFrameKey must await the native push under its own bound",
  );
  // The app runs the default: androidScreenShare.ts passes no bound of its
  // own (a fourth argument there would bypass every check above).
  const constructions = bodiesAfter(
    SHARE_CODE,
    "#core = new AndroidLegLifecycle(",
  );
  assert.equal(constructions.length, 1);
  assert.ok(
    argumentsOf(constructions[0]).length <= 3,
    "androidScreenShare.ts must leave the re-key bound at its default",
  );
});

test("nativeShareAvailable: the shell, the flag and the plugin header, all three", () => {
  // Screen-leg plan wave 4h. Every row: any one input false hides the native
  // share path, whatever the other two say.
  const rows: [boolean, boolean, boolean, boolean][] = [
    // androidShell, flag, pluginHeader, available
    [false, false, false, false],
    [false, false, true, false],
    [false, true, false, false],
    [false, true, true, false],
    [true, false, false, false],
    [true, false, true, false],
    [true, true, false, false],
    [true, true, true, true],
  ];
  assert.equal(
    new Set(rows.map((row) => row.slice(0, 3).join())).size,
    8,
    "the table must hold every combination of the three inputs once",
  );
  for (const [androidShell, flag, pluginHeader, available] of rows)
    assert.equal(
      nativeShareAvailable({ androidShell, flag, pluginHeader }),
      available,
      JSON.stringify({ androidShell, flag, pluginHeader }),
    );
});

test("🔴 share availability pin: read once, synchronously, from the plugin header", () => {
  // Screen-leg plan wave 4h. The table above proves the leaf; this holds
  // androidScreenShare.ts to calling it once, at module load, with the real
  // inputs. The async `isAvailable()` probe it replaces was the first native
  // call after a WebView reload, a reply @capacitor/android 8.4.1 can lose,
  // which left the share button saying "not supported" for the session. A
  // probe or a signal grown back, or an input forced to `true`, leaves every
  // row above green.
  assertShareWired(
    "the availability, from the leaf",
    `const AVAILABLE = nativeShareAvailable({
      androidShell: isAndroidShell(),
      flag: CONFIGURATION.ENABLE_ANDROID_SCREEN_SHARE,
      pluginHeader: Capacitor.isPluginAvailable("ScreenShare"),
    });`,
  );
  assertShareWired(
    "the accessor",
    "export const nativeScreenShareAvailable: Accessor<boolean> = () => AVAILABLE;",
  );
  assert.equal(
    countWired(SHARE_CODE, "AVAILABLE"),
    2,
    "AVAILABLE must be assigned once and read only by the accessor",
  );
  assert.equal(
    countWired(SHARE_CODE, 'Capacitor.isPluginAvailable("ScreenShare")'),
    1,
    "the plugin header must be read once, as the leaf's input",
  );
  // The call above must reach the leaf the truth table runs, not a local
  // function of the same name.
  assert.equal(countWired(SHARE_CODE, "nativeShareAvailable"), 2);
  const leafImport = SHARE_CODE.match(
    /import\{([^{}]*)\}from"\.\/androidLegStartPolicy"/,
  );
  assert.ok(leafImport, "androidScreenShare.ts must import the leaf");
  assert.ok(
    argumentsOf(leafImport[1]).includes("nativeShareAvailable"),
    "nativeShareAvailable must come from the leaf's import block",
  );
  for (const banned of ["createSignal", "setAvailable", ".isAvailable("])
    assert.equal(
      countWired(SHARE_CODE, banned),
      0,
      `androidScreenShare.ts must not hold ${banned}`,
    );
  assertPolicyWired(
    "nativeShareAvailable's body",
    "return w.androidShell && w.flag && w.pluginHeader;",
  );
});

// Slice 4 (system audio). The live legs are waived, so these tables and the
// source pins after them are the only proof the audio is offered, requested,
// reported and announced the way the plan says: every row is a literal, never
// recomputed from the rule it checks.

test("nativeShareAudioAvailable: the share path, the flag and the marker header, all three", () => {
  // Any one input false hides the audio toggle, whatever the other two say.
  // The flag is dark by default, so a dark build must never offer audio.
  const rows: [boolean, boolean, boolean, boolean][] = [
    // shareAvailable, audioFlag, audioHeader, offered
    [false, false, false, false],
    [false, false, true, false],
    [false, true, false, false],
    [false, true, true, false],
    [true, false, false, false],
    [true, false, true, false],
    [true, true, false, false],
    [true, true, true, true],
  ];
  assert.equal(
    new Set(rows.map((row) => row.slice(0, 3).join())).size,
    8,
    "the table must hold every combination of the three inputs once",
  );
  for (const [shareAvailable, audioFlag, audioHeader, offered] of rows)
    assert.equal(
      nativeShareAudioAvailable({ shareAvailable, audioFlag, audioHeader }),
      offered,
      JSON.stringify({ shareAvailable, audioFlag, audioHeader }),
    );
});

test("legAudioRequested: audio is asked for only when it was offered AND wanted", () => {
  // The saved preference is ON by default and shared with desktop, so
  // `userWants` is usually true on a device that was never offered audio. A
  // request without the offer would send `audio: true` from a dark build and
  // toast "could not start" for a toggle the user never saw.
  const rows: [boolean, boolean, boolean][] = [
    // offered, userWants, requested
    [false, false, false],
    [false, true, false],
    [true, false, false],
    [true, true, true],
  ];
  for (const [offered, userWants, requested] of rows)
    assert.equal(
      legAudioRequested({ offered, userWants }),
      requested,
      JSON.stringify({ offered, userWants }),
    );
});

test("legMutedNotice: only the audio source is audio-off; anything else is the video", () => {
  // Before slice 4 the event carried no source and always meant the video,
  // so an older native build, or a source this JS does not know, must still
  // be told its share went dark. An unmute is never announced. The match is
  // exact: a case or spelling variant of the audio source is the video.
  const rows: [string | undefined, LegMutedNotice][] = [
    // source, notice when muted
    [undefined, "video-off"],
    ["screen_share", "video-off"],
    ["screen_share_audio", "audio-off"],
    ["", "video-off"],
    ["SCREEN_SHARE_AUDIO", "video-off"],
    ["screen_share_audio ", "video-off"],
    ["microphone", "video-off"],
    ["bogus", "video-off"],
  ];
  for (const [source, notice] of rows) {
    assert.equal(
      legMutedNotice({ muted: true, source }),
      notice,
      `muted ${String(source)}`,
    );
    assert.equal(
      legMutedNotice({ muted: false, source }),
      "none",
      `unmuted ${String(source)}`,
    );
  }
  assert.equal(legMutedNotice({ muted: true }), "video-off", "no source key");
  assert.equal(legMutedNotice({ muted: false }), "none", "no source key");
});

test("legAudioNotice: what the leg's audio outcome tells the user, at start and mid-share", () => {
  // Records keyed by the full union, so a state added to it without a row
  // here fails to type-check. Mid-share every failure is `stopped` (the
  // share is live, so the start-time fix-it advice would be wrong); at start
  // `lost` is `stopped` too, and the two fixable refusals get their own kinds.
  const atStart: Record<LegAudioState | "lost", LegAudioNotice> = {
    live: "none",
    off: "none",
    unsupported: "could-not-start",
    no_permission: "no-permission",
    no_mic_service: "no-mic-service",
    failed: "could-not-start",
    lost: "stopped",
  };
  const midShare: Record<LegAudioState | "lost", LegAudioNotice> = {
    live: "none",
    off: "none",
    unsupported: "stopped",
    no_permission: "stopped",
    no_mic_service: "stopped",
    failed: "stopped",
    lost: "stopped",
  };
  for (const [table, mid] of [
    [atStart, false],
    [midShare, true],
  ] as const)
    for (const [state, notice] of Object.entries(table) as [
      LegAudioState | "lost",
      LegAudioNotice,
    ][]) {
      assert.equal(
        legAudioNotice({ requested: true, state, midShare: mid }),
        notice,
        `requested ${state} midShare=${mid}`,
      );
      // Not requested: nothing to report about audio, whatever native said.
      assert.equal(
        legAudioNotice({ requested: false, state, midShare: mid }),
        "none",
        `unrequested ${state} midShare=${mid}`,
      );
    }
  // A state outside the union (a native build ahead of this JS) fails toward
  // telling the user, never toward a silent share that looks like it has
  // sound.
  const unknown = "zzz-unknown" as string as LegAudioState;
  assert.equal(
    legAudioNotice({ requested: true, state: unknown, midShare: false }),
    "could-not-start",
  );
  assert.equal(
    legAudioNotice({ requested: true, state: unknown, midShare: true }),
    "stopped",
  );
  assert.equal(
    legAudioNotice({ requested: false, state: unknown, midShare: false }),
    "none",
  );
});

test("isLegAudioState: exactly the six states, own keys only", () => {
  // The bridge is untrusted: an older APK resolves with no `audio`, and a
  // prototype name must not pass an `in`-style lookup. Anything rejected
  // here is read as "failed" by the caller (when audio was asked for).
  const states: Record<LegAudioState, true> = {
    live: true,
    off: true,
    unsupported: true,
    no_permission: true,
    no_mic_service: true,
    failed: true,
  };
  for (const state of Object.keys(states))
    assert.equal(isLegAudioState(state), true, state);
  for (const value of [
    "lost",
    "",
    "LIVE",
    "Live",
    " live",
    "live ",
    "toString",
    "__proto__",
    "constructor",
    "hasOwnProperty",
    "valueOf",
    undefined,
    null,
    0,
    1,
    true,
    {},
    [],
    ["live"],
    Object("live"),
    { live: true },
  ])
    assert.equal(
      isLegAudioState(value),
      false,
      `${typeof value} ${JSON.stringify(value)}`,
    );
});

test("audio offer pin: read once, synchronously, from the ScreenShareAudio header", () => {
  // The table above proves the leaf; this holds androidScreenShare.ts to
  // calling it once, at module load, with the real inputs. Any input forced
  // to `true` (the flag, the marker header, or the share path) offers audio
  // from a dark build or on a device below API 29, and every row above stays
  // green. The marker is a header lookup for the reason the share path is:
  // an `isAvailable()` round trip can lose its reply after a WebView reload.
  assertShareWired(
    "the audio offer, from the leaf",
    `const SHARE_AUDIO_OFFERED = nativeShareAudioAvailable({
      shareAvailable: nativeScreenShareAvailable(),
      audioFlag: CONFIGURATION.ENABLE_ANDROID_SCREEN_AUDIO,
      audioHeader: Capacitor.isPluginAvailable("ScreenShareAudio"),
    });`,
  );
  assertShareWired(
    "the audio offer accessor",
    "export const nativeScreenShareAudioOffered: Accessor<boolean> = () => SHARE_AUDIO_OFFERED;",
  );
  for (const [snippet, count, why] of [
    ["SHARE_AUDIO_OFFERED", 2, "assigned once and read only by the accessor"],
    [
      'Capacitor.isPluginAvailable("ScreenShareAudio")',
      1,
      "the marker header read once, as the leaf's input",
    ],
    [
      "CONFIGURATION.ENABLE_ANDROID_SCREEN_AUDIO",
      1,
      "the audio flag read once, as the leaf's input",
    ],
    ["nativeShareAudioAvailable", 2, "imported once and called once"],
    [".isAvailable(", 0, "no native availability probe"],
  ] as const)
    assert.equal(
      countWired(SHARE_CODE, snippet),
      count,
      `androidScreenShare.ts: ${why} (${snippet})`,
    );
  const leafImport = SHARE_CODE.match(
    /import\{([^{}]*)\}from"\.\/androidLegStartPolicy"/,
  );
  assert.ok(leafImport, "androidScreenShare.ts must import the leaf");
  const imported = argumentsOf(leafImport[1]);
  for (const name of ["nativeShareAudioAvailable", "isLegAudioState"])
    assert.ok(imported.includes(name), `${name} must come from the leaf`);
  assertPolicyWired(
    "nativeShareAudioAvailable's body",
    "return w.shareAvailable && w.audioFlag && w.audioHeader;",
  );
  assertPolicyWired(
    "legAudioRequested's body",
    "return w.offered && w.userWants;",
  );
});

test("connect resolves native's audio state, and an unknown report fails closed", () => {
  // Native's `audio` is untrusted (an older APK sends none). Read through the
  // guard, a report that is not a state becomes "failed" when audio was asked
  // for, so the user hears it did not start; "live" there would be a silent
  // share that looks like it has sound. Not asked for, it is "off".
  assertShareWired("the report's slot", "let reported: unknown;");
  assertShareWired(
    "the report, from the plugin's resolve",
    `.then((result) => {
      reported = result?.audio;
    })`,
  );
  assertShareWired(
    "the fallback",
    `.then(
      (): LegAudioState =>
        isLegAudioState(reported)
          ? reported
          : options.audio
            ? "failed"
            : "off",
    );`,
  );
  // Declared, written once, guarded, returned: no other path to the result.
  assert.equal(countWired(SHARE_CODE, "reported"), 4);
  assert.equal(countWired(SHARE_CODE, "isLegAudioState"), 2);
  // Sent to native once (pinned with the key above) and read once by the
  // fallback: the request and the fallback cannot disagree.
  assert.equal(countWired(SHARE_CODE, "options.audio"), 2);
});

test("native audio and mute events are filtered before they reach the owner", () => {
  // `onAudio` means the audio ended while the video goes on. Any other state
  // native sends (a "live", an unknown) must not toast "Screen audio
  // stopped" over a share that still has sound.
  assertShareWired(
    "the audio listener",
    `p.addListener("audio", (data) => {
      const state = data.state;
      if (state === "lost" || state === "failed") this.onAudio?.(state);
    })`,
  );
  assert.equal(countWired(SHARE_CODE, "this.onAudio?.("), 1);
  // A source outside the two the leg publishes reaches the owner as
  // undefined, which `legMutedNotice` reads as the video (the table above).
  // Passed through raw, a native build ahead of this JS could name a source
  // the owner's copy does not expect.
  assertShareWired(
    "the mute-source whitelist",
    `function muteSource(source: unknown): LegMuteSource | undefined {
      return source === "screen_share" || source === "screen_share_audio"
        ? source
        : undefined;
    }`,
  );
  assertShareWired(
    "the muted listener",
    `p.addListener("muted", (data) => {
      this.onMuted?.({
        muted: data.muted ?? true,
        source: muteSource(data.source),
      });
    })`,
  );
  assert.equal(countWired(SHARE_CODE, "this.onMuted?.("), 1);
  assert.equal(countWired(SHARE_CODE, "muteSource("), 2);
});

const PLUGIN_SOURCE = readFileSync(
  new URL(
    "../../android/app/src/main/java/com/acutest/app/screenshare/ScreenSharePlugin.kt",
    import.meta.url,
  ),
  "utf8",
);
const PLUGIN_CODE = codeOf(PLUGIN_SOURCE);

/** `snippet` must appear exactly once in ScreenSharePlugin.kt's code. */
const assertPluginWired = wiredAsserter("ScreenSharePlugin.kt", PLUGIN_CODE);

/**
 * The block body of each Kotlin function `head` declares in `code` (already
 * put through `codeOf`). `head` ends with the `(` that opens the parameters;
 * a function with no block body right after them fails.
 */
function blockBodiesOf(code: string, head: string): string[] {
  const want = codeOf(head);
  const out: string[] = [];
  for (
    let at = code.indexOf(want);
    at !== -1;
    at = code.indexOf(want, at + 1)
  ) {
    const params = closerOf(code, at + want.length - 1);
    assert.equal(code[params + 1], "{", `${head} must have a block body`);
    out.push(code.slice(params + 2, closerOf(code, params + 1)));
  }
  return out;
}

/** Where `snippet` occurs in `code`, which must hold it exactly once. */
function onceAt(code: string, what: string, snippet: string): number {
  const at = wiredAt(code, snippet);
  assert.equal(
    at.length,
    1,
    `${what}: expected exactly once, found ${at.length}:\n${codeOf(snippet)}`,
  );
  return at[0];
}

test("ScreenSharePlugin.kt reads in sync under the source-pin lexer", () => {
  // `codeOf` lexes TypeScript, and reads this Kotlin file right because the
  // two share what it relies on: `//` and `/* */` comments (KDoc is a block
  // comment), and quoted strings and char literals with backslash escapes,
  // copied whole, so a `//` inside one is never read as a comment. It does
  // not know raw strings, nested block comments, backtick identifiers or a
  // template holding a quote; any of those would make it lose its place and
  // the pins below match the wrong text.
  assert.equal(
    codeOf('val u = "https://x" /** a `KDoc`, it\'s */ // a "comment"\nf()'),
    'valu="https://x"f()',
  );
  assert.ok(
    !PLUGIN_SOURCE.includes('"""'),
    "the lexer cannot read a raw string",
  );
  assert.ok(!PLUGIN_CODE.includes("*/"), "a nested block comment left code");
  assert.ok(!PLUGIN_CODE.includes("`"), "the lexer cannot read a backtick");
  for (const { text } of stringsOf(PLUGIN_CODE))
    assert.ok(!/\$\{[^}]*$/.test(text), `a template cut at a quote: ${text}`);
  assertLexesInSync("ScreenSharePlugin.kt", PLUGIN_SOURCE, PLUGIN_CODE, 80);
});

test("the page-start listener is never registered in load()", () => {
  // Screen-leg plan wave 4i rev 2. Capacitor runs `load()` inside the Bridge
  // constructor, and `Bridge.Builder.create()` then replaces the WebView
  // listener list, so a listener added there never fires: the rev-1 no-op,
  // which left the reload orphan in place while every other pin passed.
  assert.equal(
    countWired(PLUGIN_CODE, "override fun load()"),
    0,
    "ScreenSharePlugin.kt must not override load(): a listener added there " +
      "is dropped by Bridge.Builder.create()",
  );
});

test("the page-start listener is added once, from handleOnStart", () => {
  // Screen-leg plan wave 4i rev 2. `handleOnStart` runs from the
  // Activity's onStart, after `create()` has set its listener list, so a
  // listener added here survives. It runs on every return to the
  // foreground: a missing or late once-flag stacks a listener per return,
  // and a second registration site stacks one more.
  assertPluginWired("handleOnStart", "override fun handleOnStart()");
  const [body] = blockBodiesOf(PLUGIN_CODE, "override fun handleOnStart(");
  const superAt = onceAt(
    body,
    "handleOnStart's super.handleOnStart()",
    "super.handleOnStart()",
  );
  const checkAt = onceAt(
    body,
    "handleOnStart's once-flag check",
    "if (pageListenerRegistered) return",
  );
  const setAt = onceAt(
    body,
    "handleOnStart's once-flag set",
    "pageListenerRegistered = true",
  );
  const addAt = onceAt(
    body,
    "handleOnStart's listener registration",
    "bridge.addWebViewListener(",
  );
  assert.ok(
    superAt < checkAt,
    "super.handleOnStart() must run before the once-flag check",
  );
  assert.ok(
    checkAt < setAt && setAt < addAt,
    "the once-flag must be checked, then set, before the listener is added",
  );
  assert.equal(
    countWired(PLUGIN_CODE, "addWebViewListener("),
    1,
    "ScreenSharePlugin.kt must add a WebView listener from handleOnStart only",
  );
});

test("a page start tears the leg down, unconditionally", () => {
  // Screen-leg plan wave 4i rev 2. The new page has no `#androidLeg`, so
  // nothing on it re-keys or stops the leg; this callback is the only thing
  // that ends it. The trace runs synchronously so the log shows the
  // callback fired; any guard, early return or condition added here would
  // let the leg outlive its page again, encrypting under the dying page's
  // epoch key.
  assertPluginWired("the page-start callback", "override fun onPageStarted(");
  const starts = blockBodiesOf(PLUGIN_CODE, "override fun handleOnStart(");
  const registrations = starts.flatMap((start) =>
    bodiesAfter(start, "bridge.addWebViewListener("),
  );
  const bodies = registrations.flatMap((registration) =>
    blockBodiesOf(registration, "override fun onPageStarted("),
  );
  assert.equal(
    bodies.length,
    1,
    "onPageStarted must be the listener handleOnStart registers",
  );
  const [body] = bodies;
  const traceAt = onceAt(body, "the page-start trace", 'trace("page started")');
  const tearDownAt = onceAt(
    body,
    "the page-start teardown",
    "scope.launch { tearDown(null) }",
  );
  assert.ok(
    traceAt < tearDownAt,
    "the page-start trace must run before the teardown is launched",
  );
  assert.equal(
    body,
    codeOf('trace("page started") scope.launch { tearDown(null) }'),
    "onPageStarted must hold the trace and the teardown and nothing else",
  );
});

test("connect re-checks the consent first thing on Main", () => {
  // Screen-leg plan wave 4i rev 2. `connect` captures `consentIntent` on
  // the plugin thread, then queues its launch on Main. A page-start
  // teardown (or a stop, or handleOnDestroy) landing in between nulls the
  // field; without this re-check the dying page's connect would run after
  // it and start a leg with no JS owner. Anything ahead of it in the launch
  // runs first.
  assertPluginWired("connect", "fun connect(");
  const [connect] = blockBodiesOf(PLUGIN_CODE, "fun connect(");
  const launches = bodiesAfter(connect, "scope.launch {");
  assert.ok(launches.length > 0, "connect must launch its work on scope");
  const [launch] = launches;
  const recheck = codeOf("if (consentIntent !== intent) {");
  assert.ok(
    launch.startsWith(recheck),
    "the consent re-check must be the first statement of connect's launch",
  );
  assert.equal(
    launch.slice(recheck.length, closerOf(launch, recheck.length - 1)),
    codeOf('call.reject("connect_failed: cancelled") return@launch'),
    "the consent re-check must reject as cancelled, then return",
  );
});

// Slice 4 (system audio), native half. Live legs are waived, so these pins
// are what holds the plugin to the plan's audio rules. They read the files
// through the same lexer as the pins above, under the same constraints.

const AUDIO_SOURCE_SOURCE = readFileSync(
  new URL(
    "../../android/app/src/main/java/com/acutest/app/screenshare/ScreenAudioSource.kt",
    import.meta.url,
  ),
  "utf8",
);
const AUDIO_SOURCE_CODE = codeOf(AUDIO_SOURCE_SOURCE);

/** `snippet` must appear exactly once in ScreenAudioSource.kt's code. */
const assertAudioSourceWired = wiredAsserter(
  "ScreenAudioSource.kt",
  AUDIO_SOURCE_CODE,
);

test("ScreenAudioSource.kt reads in sync under the source-pin lexer", () => {
  // Same constraints as ScreenSharePlugin.kt above: no raw strings, nested
  // block comments, backticks, or a template holding a quote, or the pins
  // below match the wrong text.
  assert.ok(
    !AUDIO_SOURCE_SOURCE.includes('"""'),
    "the lexer cannot read a raw string",
  );
  assert.ok(
    !AUDIO_SOURCE_CODE.includes("*/"),
    "a nested block comment left code",
  );
  assert.ok(
    !AUDIO_SOURCE_CODE.includes("`"),
    "the lexer cannot read a backtick",
  );
  for (const { text } of stringsOf(AUDIO_SOURCE_CODE))
    assert.ok(!/\$\{[^}]*$/.test(text), `a template cut at a quote: ${text}`);
  assertLexesInSync(
    "ScreenAudioSource.kt",
    AUDIO_SOURCE_SOURCE,
    AUDIO_SOURCE_CODE,
    15,
  );
});

test("the leg's microphone recording is disabled right after LiveKit.create, on every leg", () => {
  // The WebView call owns the microphone. With the ADM's recording disabled
  // the leg builds no mic AudioRecord and the audio track carries only what
  // ScreenAudioSource writes. The statement must follow the create call
  // directly, at the top level of doConnect: inside an `if (audioRequested)`
  // (or after the connect) a leg could reach a recording with it still on.
  assertPluginWired("doConnect", "private suspend fun doConnect(");
  const [connect] = blockBodiesOf(
    PLUGIN_CODE,
    "private suspend fun doConnect(",
  );
  const head = codeOf("val room = LiveKit.create(");
  const createAt = onceAt(
    connect,
    "the leg's Room",
    "val room = LiveKit.create(",
  );
  const createEnd = closerOf(connect, createAt + head.length - 1);
  assert.ok(
    connect.slice(createEnd + 1).startsWith(
      codeOf(`val micRecordingOff = try {
        val adm = room.lkObjects.audioDeviceModule as? JavaAudioDeviceModule
        adm?.setAudioRecordEnabled(false)
        adm != null
      } catch (_: Throwable) {
        false
      }`),
    ),
    "the ADM's recording must be disabled by the statement right after " +
      "LiveKit.create, unconditionally",
  );
  assert.equal(
    countWired(PLUGIN_CODE, "setAudioRecordEnabled("),
    1,
    "ScreenSharePlugin.kt must touch the ADM's recording only to disable it",
  );
  // A leg whose disable did not take (no ADM, or a throw) must refuse the
  // audio: publishing it would let the ADM open the microphone.
  assertPluginWired(
    "the refusal reads the disable",
    `var audioState = if (audioRequested) screenAudioRefusal(micRecordingOff) else "off"`,
  );
  assertPluginWired("the refusal arm", `!micRecordingOff -> "failed"`);
  // The whole refusal, every arm in order. Each arm is a case the audio
  // block below must never see: in a build without the system audio there
  // is nothing to offer, below API 29 there is no playback capture, the ADM
  // recording still on would let the leg open the microphone, with no
  // RECORD_AUDIO grant the capture is refused, and with no microphone
  // foreground service the OS silences it while the state reads "live". A
  // dropped arm turns its case into a null, and the block runs for it.
  // Re-pinned for the lighting prerequisites: the build-flag arm is new and
  // comes first, so a dark APK refuses whatever the page sent (the flag's
  // own pins are in the build-flag test below).
  const refusals = bodiesAfter(
    PLUGIN_CODE,
    "private fun screenAudioRefusal(micRecordingOff: Boolean): String? = when {",
  );
  assert.equal(refusals.length, 1, "the plugin must declare the refusal once");
  assert.equal(
    refusals[0],
    codeOf(`!BuildConfig.SCREEN_SHARE_AUDIO -> "unsupported"
      Build.VERSION.SDK_INT < 29 -> "unsupported"
      !micRecordingOff -> "failed"
      ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) !=
        PackageManager.PERMISSION_GRANTED -> "no_permission"
      !VoiceCallService.micForegroundActive -> "no_mic_service"
      else -> null`),
    "screenAudioRefusal must refuse on the build flag, the API level, the " +
      "ADM recording, the RECORD_AUDIO grant and the microphone service, in " +
      "that order",
  );
  // The audio block runs only on a null refusal, and its guard is the very
  // next statement, so it reads the state the refusal just wrote. Without
  // `audioState == null` the block would build and publish the playback
  // capture for a share that never asked for audio ("off", the user's
  // opt-out) or that the refusal turned down (no RECORD_AUDIO grant, no
  // microphone service, the ADM recording still on).
  assertPluginWired(
    "the audio block runs only on a null refusal",
    `var audioState = if (audioRequested) screenAudioRefusal(micRecordingOff) else "off"
    if (audioState == null && Build.VERSION.SDK_INT >= 29) {`,
  );
  // The request reaches doConnect from JS by one path and is read once, in
  // the refusal above: any other read of `audioRequested` is a new branch
  // on the bare request, around the refusal and its guard.
  assertPluginWired(
    "connect reads the JS request",
    `val audio = call.getBoolean("audio", false) == true`,
  );
  assertPluginWired(
    "connect hands the request to doConnect",
    "doConnect(generation, call, url, token, quality, e2ee, intent, audio)",
  );
  assertPluginWired(
    "doConnect's audio parameter",
    `intent: Intent,
    audioRequested: Boolean,
    ) {`,
  );
  assert.equal(
    countWired(PLUGIN_CODE, "audioRequested"),
    2,
    "audioRequested must be the parameter and the refusal's read, nothing else",
  );

  // No prewarming either: the prewarmer starts the ADM's recording ahead of
  // a publish. Set in the create call's own options, for every leg.
  const createArgs = connect.slice(createAt + head.length, createEnd);
  assert.equal(
    countWired(
      createArgs,
      `audioOptions = AudioOptions(
        audioHandler = NoAudioHandler(),
        disableAudioPrewarming = true,
      ),`,
    ),
    1,
    "LiveKit.create must get NoAudioHandler with prewarming disabled",
  );
  assert.equal(countWired(PLUGIN_CODE, "disableAudioPrewarming"), 1);
});

// The native build flag (lighting prerequisites). The web bundle's flag only
// decides whether the page asks; BuildConfig.SCREEN_SHARE_AUDIO decides
// whether the APK will ever answer. Read as text through the same lexer:
// MainActivity.java (Java) and build.gradle (Groovy) share the comment and
// quoted-string syntax it relies on, and the sync checks below hold them to
// that.

const MAIN_ACTIVITY_SOURCE = readFileSync(
  new URL(
    "../../android/app/src/main/java/com/acutest/app/MainActivity.java",
    import.meta.url,
  ),
  "utf8",
);
const MAIN_ACTIVITY_CODE = codeOf(MAIN_ACTIVITY_SOURCE);

const APP_GRADLE_SOURCE = readFileSync(
  new URL("../../android/app/build.gradle", import.meta.url),
  "utf8",
);
// Past the android block build.gradle holds Groovy slashy regexes
// (`/.../`), whose quotes the lexer misreads. So only the text before the
// first top-level block after `android { }` is lexed; the test checks the
// cut is unique and that the whole android block lies before it.
const APP_GRADLE_CUT = "\nrepositories {\n";
const APP_GRADLE_HEAD = APP_GRADLE_SOURCE.slice(
  0,
  Math.max(0, APP_GRADLE_SOURCE.indexOf(APP_GRADLE_CUT)),
);
const APP_GRADLE_CODE = codeOf(APP_GRADLE_HEAD);

/** `snippet` must appear exactly once in build.gradle's code. */
const assertGradleWired = wiredAsserter("build.gradle", APP_GRADLE_CODE);

test("the system audio needs the native build flag: off by default, refused first, never offered", () => {
  // Same constraints as the Kotlin files: no raw or triple-quoted strings,
  // nested block comments or backticks left in code, or the pins below
  // match the wrong text. build.gradle is read up to its cut (see
  // APP_GRADLE_HEAD), which must be unique and close the android block.
  assert.equal(
    APP_GRADLE_SOURCE.split(APP_GRADLE_CUT).length - 1,
    1,
    "build.gradle must hold one top-level repositories block",
  );
  assert.equal(
    bodiesAfter(APP_GRADLE_CODE, "android {").length,
    1,
    "the whole android block must lie before build.gradle's cut",
  );
  for (const [file, source, code, minStrings] of [
    ["MainActivity.java", MAIN_ACTIVITY_SOURCE, MAIN_ACTIVITY_CODE, 5],
    ["build.gradle", APP_GRADLE_HEAD, APP_GRADLE_CODE, 20],
  ] as const) {
    assert.ok(!source.includes('"""'), `${file}: a triple-quoted string`);
    assert.ok(!source.includes("'''"), `${file}: a triple-quoted string`);
    assert.ok(!code.includes("*/"), `${file}: a nested block comment`);
    assert.ok(!code.includes("`"), `${file}: a backtick left code`);
    for (const { text } of stringsOf(code))
      assert.ok(!/\$\{[^}]*$/.test(text), `${file}: a template cut: ${text}`);
    assertLexesInSync(file, source, code, minStrings);
  }

  // build.gradle: ONE field, in defaultConfig, so no flavor (play, sideload,
  // foss) can override it; a second `"SCREEN_SHARE_AUDIO"` literal would be
  // such an override.
  assertGradleWired(
    "the build flag",
    `buildConfigField "boolean", "SCREEN_SHARE_AUDIO", screenShareAudio`,
  );
  assert.equal(
    countWired(APP_GRADLE_CODE, `"SCREEN_SHARE_AUDIO"`),
    1,
    "build.gradle must declare SCREEN_SHARE_AUDIO once, with no override",
  );
  // The same over the WHOLE raw file, past the cut too and in either quote,
  // so a late `android.productFlavors...buildConfigField(...)` fails here.
  assert.equal(
    APP_GRADLE_SOURCE.split(`"SCREEN_SHARE_AUDIO"`).length +
      APP_GRADLE_SOURCE.split(`'SCREEN_SHARE_AUDIO'`).length -
      2,
    1,
    "build.gradle must name the SCREEN_SHARE_AUDIO field once in all",
  );
  const defaults = bodiesAfter(APP_GRADLE_CODE, "defaultConfig {");
  assert.equal(defaults.length, 1, "build.gradle must hold one defaultConfig");
  assert.equal(
    countWired(
      defaults[0],
      `buildConfigField "boolean", "SCREEN_SHARE_AUDIO", screenShareAudio`,
    ),
    1,
    "the build flag must be declared inside defaultConfig",
  );
  // Where its value comes from: unset is false; -PsharedScreenAudio wins
  // over env SLOGA_SCREEN_SHARE_AUDIO (checked first, the env only in the
  // else arm); the field takes the TRIMMED value, and only after the
  // validation, which fails the build on anything but "true" or "false"
  // (so a typo can never ship the flag on). A default of 'true', the env
  // read first, or a dropped throw each change this text.
  assertGradleWired(
    "the flag's sources, default and validation",
    `def screenShareAudioProperty = providers.gradleProperty('sharedScreenAudio').orNull
    def screenShareAudioEnv = providers.environmentVariable('SLOGA_SCREEN_SHARE_AUDIO').orNull
    def screenShareAudioSource = 'default'
    def screenShareAudioRaw = 'false'
    if (screenShareAudioProperty != null) {
      screenShareAudioSource = '-PsharedScreenAudio'
      screenShareAudioRaw = screenShareAudioProperty
    } else if (screenShareAudioEnv != null) {
      screenShareAudioSource = 'env SLOGA_SCREEN_SHARE_AUDIO'
      screenShareAudioRaw = screenShareAudioEnv
    }
    def screenShareAudio = screenShareAudioRaw.trim()
    if (screenShareAudio != 'true' && screenShareAudio != 'false') {
      throw new GradleException(`,
  );
  // Nothing else writes either variable: a later `screenShareAudioRaw =
  // 'true'` (or a second `screenShareAudio =`) would bypass the default or
  // the validation.
  assert.equal(countWired(APP_GRADLE_CODE, "screenShareAudioRaw ="), 3);
  assert.equal(countWired(APP_GRADLE_CODE, "screenShareAudio ="), 1);
  assert.ok(
    APP_GRADLE_CODE.indexOf(codeOf("throw new GradleException(")) <
      APP_GRADLE_CODE.indexOf(codeOf("android {")),
    "the validation must run before the android block reads the flag",
  );

  // MainActivity: the capability marker JS reads synchronously is
  // registered only when the build has the flag AND the OS has playback
  // capture, before super.onCreate (Capacitor reads its plugin list there).
  // Without the flag in the guard a dark APK advertises audio and the page
  // offers it; native would still refuse, but the user sees a toggle that
  // can never work.
  const creates = bodiesAfter(
    MAIN_ACTIVITY_CODE,
    "public void onCreate(Bundle savedInstanceState) {",
  );
  assert.equal(creates.length, 1, "MainActivity must declare onCreate once");
  const [create] = creates;
  const markerAt = onceAt(
    create,
    "the guarded marker registration",
    `if (com.acutest.app.BuildConfig.SCREEN_SHARE_AUDIO
        && android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
      registerPlugin(com.acutest.app.screenshare.ScreenShareAudioPlugin.class);
    }`,
  );
  const superAt = onceAt(
    create,
    "MainActivity's super.onCreate",
    "super.onCreate(savedInstanceState)",
  );
  assert.ok(
    markerAt < superAt,
    "the marker must be registered before super.onCreate",
  );
  assert.equal(
    countWired(MAIN_ACTIVITY_CODE, "ScreenShareAudioPlugin"),
    1,
    "MainActivity must register the marker only inside the flag guard",
  );

  // The plugin: the flag arm is the refusal's FIRST, so native refuses even
  // if the page sends `audio: true`, and isAvailable reports the same
  // answer. `BuildConfig` itself is the app's (the import), read only at
  // those two sites: another module's BuildConfig would compile against a
  // field of its own.
  const [refusal] = bodiesAfter(
    PLUGIN_CODE,
    "private fun screenAudioRefusal(micRecordingOff: Boolean): String? = when {",
  );
  assert.ok(
    refusal.startsWith(
      codeOf(`!BuildConfig.SCREEN_SHARE_AUDIO -> "unsupported"
        Build.VERSION.SDK_INT < 29 -> "unsupported"`),
    ),
    "the build-flag arm must be screenAudioRefusal's first",
  );
  assertPluginWired(
    "isAvailable's audio answer",
    `result.put("audioCapture", BuildConfig.SCREEN_SHARE_AUDIO && Build.VERSION.SDK_INT >= 29)`,
  );
  assert.equal(countWired(PLUGIN_CODE, `"audioCapture"`), 1);
  assertPluginWired(
    "the app's BuildConfig",
    "import com.acutest.app.BuildConfig",
  );
  assert.equal(
    countWired(PLUGIN_CODE, "BuildConfig"),
    3,
    "BuildConfig must be the import, the refusal arm and isAvailable",
  );
});

test("the system audio is released before the video capture stops, on every stop path", () => {
  // Stopping the video capturer stops the MediaProjection the playback
  // capture rides on; stopped under a live capture, the source would report
  // a failure for a share that is merely ending. stopCapture takes the
  // source so every caller decides about the audio first.
  const [stop] = blockBodiesOf(PLUGIN_CODE, "private fun stopCapture(");
  assert.equal(
    stop,
    codeOf(`releaseAudio(audio)
      if (room == null) return
      try {
        room.localParticipant
          .getTrackPublication(Track.Source.SCREEN_SHARE)
          ?.track
          ?.stop()
      } catch (_: Throwable) {}`),
    "stopCapture must release the audio first, then stop the video",
  );
  const [release] = blockBodiesOf(PLUGIN_CODE, "private fun releaseAudio(");
  assert.equal(
    release,
    codeOf(`if (audio != null && Build.VERSION.SDK_INT >= 29) {
        try {
          audio.release()
        } catch (_: Throwable) {}
      }`),
    "releaseAudio must release the source",
  );
  // The declaration plus the two callers, tearDown and discardRoom, each
  // handing over the source it holds.
  assert.equal(countWired(PLUGIN_CODE, "stopCapture("), 3);
  assert.equal(countWired(PLUGIN_CODE, "stopCapture(room, audio)"), 2);
  const [tearDown] = blockBodiesOf(PLUGIN_CODE, "private fun tearDown(");
  const takeAt = onceAt(
    tearDown,
    "tearDown takes the live source",
    "val audio = screenAudio screenAudio = null",
  );
  const stopAt = onceAt(
    tearDown,
    "tearDown's capture stop",
    "stopCapture(room, audio)",
  );
  assert.ok(takeAt < stopAt, "tearDown must take the source before the stop");
  const [discard] = blockBodiesOf(PLUGIN_CODE, "private fun discardRoom(");
  assert.ok(
    discard.startsWith(codeOf("stopCapture(room, audio)")),
    "discardRoom must release the audio before anything else",
  );
});

test("a full reconnect releases the audio before it tears the share down", () => {
  // `republishTracks` would put the audio back on a NEW sender whose cryptor
  // nobody witnessed, with the source's gate still open. The branch must
  // release the source synchronously (so it only paces zeros) and then end
  // the share, and nothing else.
  //
  // Re-pinned for the lighting prerequisites: the branch now opens with an
  // event-room guard. The release reads the [screenAudio] field
  // synchronously, ahead of the launched same-share check, so a
  // Reconnecting from any Room but the live share's (a collector that
  // outlived its attempt) would release the live share's source. The guard
  // must be the first statement, before anything is touched.
  const bodies = bodiesAfter(PLUGIN_CODE, "is RoomEvent.Reconnecting -> {");
  assert.equal(bodies.length, 1, "onRoomEvent must handle Reconnecting once");
  const [arm] = bodies;
  assert.ok(
    arm.startsWith(codeOf("if (event.room !== room) return val audio")),
    "the Reconnecting branch must check the event's Room first",
  );
  // The release stays synchronous and ahead of the launch: moved into the
  // launch it would run only after the same-share check, by which time the
  // SDK may already be republishing onto an unwitnessed audio sender.
  const releaseAt = onceAt(
    arm,
    "the Reconnecting branch's release",
    "releaseAudio(audio)",
  );
  const launchAt = onceAt(
    arm,
    "the Reconnecting branch's launch",
    "scope.launch {",
  );
  assert.ok(
    releaseAt < launchAt,
    "the Reconnecting branch must release the audio before its launch",
  );
  assert.equal(
    arm,
    codeOf(`if (event.room !== room) return
      val audio = screenAudio
      screenAudio = null
      releaseAudio(audio)
      trace("full reconnect began audioReleased=\${audio != null}")
      scope.launch {
        if (this@ScreenSharePlugin.room === room) {
          tearDown("disconnected")
        }
      }`),
    "the Reconnecting branch must check its Room, release the audio, then " +
      "tear down",
  );
});

test("an audio publication left carrying silence is marked muted, and that mute never reaches JS", () => {
  // A published audio track whose gate never opened (witness failed, the
  // source failed first, the publish threw after registering it) or whose
  // source was lost mid-share stays on air (an unpublish renegotiates,
  // crash class A) carrying only silence; unmuted, viewers' badge reads it
  // as playing. One guarded helper mutes it: the declaration and two call
  // sites, nothing else.
  assert.equal(
    countWired(PLUGIN_CODE, "muteSilentAudio("),
    3,
    "muteSilentAudio must be the declaration and its two call sites",
  );
  // Its own try, so a throw from the blocking setter costs the badge only,
  // never the video (and doConnect's try count stays 3). The sid goes into
  // the skip set BEFORE the mute: the SDK re-posts the mute as a TrackMuted,
  // and recorded after, that event could find the set without it.
  const mutes = blockBodiesOf(PLUGIN_CODE, "private fun muteSilentAudio(");
  assert.equal(mutes.length, 1, "the plugin must declare muteSilentAudio once");
  const [mute] = mutes;
  const recordAt = onceAt(
    mute,
    "muteSilentAudio's sid record",
    "selfMutedSids.add(pub.sid)",
  );
  const mutedAt = onceAt(mute, "muteSilentAudio's mute", "pub.muted = true");
  assert.ok(
    recordAt < mutedAt,
    "muteSilentAudio must record the sid before it sets the mute",
  );
  assert.equal(
    mute,
    codeOf(`try {
        val pub = room.localParticipant
          .getTrackPublication(Track.Source.SCREEN_SHARE_AUDIO) ?: return
        selfMutedSids.add(pub.sid)
        pub.muted = true
        trace("audio publication muted")
      } catch (t: Throwable) {
        trace("audio mute failed \${t.javaClass.simpleName}")
      }`),
    "muteSilentAudio must mute only the system-audio publication, inside " +
      "its own try, after recording its sid",
  );
  assert.equal(countWired(PLUGIN_CODE, ".muted = true"), 1);
  assert.equal(countWired(PLUGIN_CODE, "selfMutedSids.add("), 1);

  // Call site 1: doConnect's not-live arm, inside the audio block, after the
  // release. Every share whose audio did not go live passes through it.
  const [connect] = blockBodiesOf(
    PLUGIN_CODE,
    "private suspend fun doConnect(",
  );
  const [audioBlock] = bodiesAfter(
    connect,
    "if (audioState == null && Build.VERSION.SDK_INT >= 29) {",
  );
  onceAt(
    audioBlock,
    "doConnect's not-live arm mutes the publication",
    `if (audioState != "live") {
      releaseAudio(audio)
      audio = null
      muteSilentAudio(room)
    }`,
  );
  assert.equal(countWired(connect, "muteSilentAudio("), 1);
  // Call site 2: a mid-share loss, only after the launched same-share
  // checks, so it only ever touches this share's Room.
  const [lost] = blockBodiesOf(PLUGIN_CODE, "private fun onScreenAudioLost(");
  const lostLaunches = bodiesAfter(lost, "scope.launch {");
  assert.equal(lostLaunches.length, 1, "onScreenAudioLost launches once");
  const [lostLaunch] = lostLaunches;
  const bailAt = onceAt(
    lostLaunch,
    "the audio-loss same-share check",
    "return@launch",
  );
  const lostMuteAt = onceAt(
    lostLaunch,
    "the audio loss mutes the publication",
    `screenAudio = null
    releaseAudio(audio)
    trace("audio lost state=$state")
    muteSilentAudio(room)`,
  );
  assert.ok(
    bailAt < lostMuteAt,
    "the audio-loss mute must come after the same-share checks",
  );
  // Never on a stop path: a share that is ending needs no mute, and the
  // setter blocks Main on the RTC thread.
  for (const head of [
    "private fun tearDown(",
    "private fun stopCapture(",
    "private fun discardRoom(",
  ]) {
    const [body] = blockBodiesOf(PLUGIN_CODE, head);
    assert.equal(
      countWired(body, "muteSilentAudio("),
      0,
      `${head}) must never mute the audio publication`,
    );
  }

  // The SDK re-posts the self-mute as TrackMuted; JS reads every `muted`
  // event as a server mute, so forwarded it would add a second,
  // contradictory "Screen audio stopped" notice. Both arms skip the
  // recorded sids, and the set ends with the share.
  for (const arm of ["TrackMuted", "TrackUnmuted"]) {
    const arms = bodiesAfter(PLUGIN_CODE, `is RoomEvent.${arm} -> {`);
    assert.equal(arms.length, 1, `onRoomEvent must handle ${arm} once`);
    assert.ok(
      arms[0].startsWith(
        codeOf(`if (event.participant === room.localParticipant &&
          event.publication.sid !in selfMutedSids
        ) {`),
      ),
      `the ${arm} arm must skip the sids the plugin muted itself`,
    );
  }
  const [tearDown] = blockBodiesOf(PLUGIN_CODE, "private fun tearDown(");
  onceAt(tearDown, "tearDown clears the self-mutes", "selfMutedSids.clear()");
  // The declaration, the record, the two skips and the clear.
  assert.equal(countWired(PLUGIN_CODE, "selfMutedSids"), 5);
});

test("the system audio publishes as SCREEN_SHARE_AUDIO, RED off, buffer callback never unset", () => {
  // RED off: livekit-client never sends RED under E2EE, so the viewers'
  // decrypt path is only proven without it. The source tags the publication
  // as the share's audio (viewers and the server's grant both key on it).
  assertPluginWired(
    "the audio publish",
    `audioPublished = room.localParticipant.publishAudioTrack(
      track,
      AudioTrackPublishOptions(
        name = "screen_audio",
        audioBitrate = 96_000,
        dtx = false,
        red = false,
        source = Track.Source.SCREEN_SHARE_AUDIO,
      ),
    )`,
  );
  assert.equal(countWired(PLUGIN_CODE, "publishAudioTrack("), 1);
  // Unsetting the callback (`setAudioBufferCallback(null)`) re-arms the ADM
  // loop with no pacing, spinning a core; the released source paces zeros
  // until the Room goes instead.
  assertPluginWired(
    "the buffer callback",
    "track.setAudioBufferCallback(SourceCallback(source))",
  );
  assert.equal(countWired(PLUGIN_CODE, "setAudioBufferCallback("), 1);
  assert.equal(countWired(PLUGIN_CODE, "setAudioBufferCallback(null)"), 0);
});

test("the playback capture matches the three usages and excludes Sloga's own UID", () => {
  // The call plays as USAGE_VOICE_COMMUNICATION, which playback capture can
  // never match; excluding our own UID is the second wall, so Sloga's own
  // sounds never loop back into the share.
  assertAudioSourceWired(
    "the capture configuration",
    `val config = AudioPlaybackCaptureConfiguration.Builder(projection)
      .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
      .addMatchingUsage(AudioAttributes.USAGE_GAME)
      .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
      .excludeUid(Process.myUid())
      .build()`,
  );
  for (const [snippet, count] of [
    ["addMatchingUsage(", 3],
    ["excludeUid(", 1],
    ["addMatchingUid(", 0],
    ["USAGE_VOICE_COMMUNICATION", 0],
    [".setAudioPlaybackCaptureConfig(config)", 1],
  ] as const)
    assert.equal(
      countWired(AUDIO_SOURCE_CODE, snippet),
      count,
      `ScreenAudioSource.kt: ${snippet}`,
    );
});

test("the audio gate starts closed and opens only behind the plugin's witness", () => {
  // Closed, the source sends zeros. Under E2EE nothing real may leave the
  // phone before the audio sender's cryptor is witnessed on the current key.
  assertAudioSourceWired(
    "the gate's initial state",
    "@Volatile private var gateOpen = false",
  );
  assert.equal(
    countWired(AUDIO_SOURCE_CODE, "gateOpen = true"),
    1,
    "only openGate may open the gate",
  );
  const [open] = blockBodiesOf(AUDIO_SOURCE_CODE, "fun openGate(");
  assert.equal(open, codeOf("gateOpen = true if (released) gateOpen = false"));
  // The plugin opens it once, and only on the witness.
  assert.equal(countWired(PLUGIN_CODE, ".openGate()"), 1);
  // A call needs no leading `.`: an `init { openGate() }` or an
  // `if (...) openGate()` in produce inside the source, or a scope function
  // in the plugin (`source.apply { openGate() }`, `with(source) { ... }`),
  // opens the gate with no witness and slips past both pins above. So the
  // bare name, across both files: the declaration in ScreenAudioSource.kt,
  // which never opens its own gate, and the one witnessed call in the plugin.
  assert.equal(
    countWired(AUDIO_SOURCE_CODE, "openGate"),
    1,
    "ScreenAudioSource.kt may declare openGate but never call it",
  );
  assert.equal(
    countWired(AUDIO_SOURCE_CODE, "openGate") +
      countWired(PLUGIN_CODE, "openGate"),
    2,
    "openGate must be the declaration and the plugin's one witnessed call",
  );
  assertPluginWired(
    "the witnessed open",
    `val witnessed = provider == null ||
        audioCryptorWitnessed(room, currentKeyIndex)
      if (witnessed && !failedEarly.get()) {
        source.openGate()
        audioState = "live"
      }`,
  );

  // The gate is read where the bytes are written. `produce` reads the
  // capture into the source's own scratch buffer, never into the ADM's, and
  // copies it across only inside the open-gate branch; closed or released,
  // the same call zero-fills, so the read still drains the capture but
  // nothing captured is sent. A `true` or a bare `!released` there would
  // send playback before the plugin's witness, and a copy in the else arm
  // would send it with the gate closed.
  const produces = bodiesAfter(
    AUDIO_SOURCE_CODE,
    `private fun produce(
      buffer: ByteBuffer,
      capacity: Int,
      audioFormat: Int,
      channelCount: Int,
      sampleRate: Int,
    ): Boolean {`,
  );
  assert.equal(produces.length, 1, "ScreenAudioSource.kt must declare produce");
  const [produce] = produces;
  assertAudioSourceWired(
    "the capture read",
    "val got = rec.read(scratch, capacity, AudioRecord.READ_BLOCKING)",
  );
  assert.equal(
    countWired(AUDIO_SOURCE_CODE, ".read("),
    1,
    "the capture must be read only into the scratch buffer",
  );
  assert.equal(
    countWired(AUDIO_SOURCE_CODE, "if (gateOpen && !released) {"),
    1,
    "the open-gate branch must appear exactly once in ScreenAudioSource.kt",
  );
  const gateHead = codeOf("if (gateOpen && !released) {");
  const gateAt = onceAt(
    produce,
    "produce's open-gate branch",
    "if (gateOpen && !released) {",
  );
  const gateEnd = closerOf(produce, gateAt + gateHead.length - 1);
  assert.equal(
    produce.slice(gateAt + gateHead.length, gateEnd),
    codeOf(`buffer.clear()
      scratch.clear()
      scratch.limit(got)
      buffer.put(scratch)
      if (got < capacity) buffer.put(zerosOf(capacity), 0, capacity - got)
      buffer.position(0)
      scratch.clear()`),
    "the open-gate branch must copy the capture into the ADM buffer",
  );
  const elseHead = codeOf("else {");
  assert.ok(
    produce.startsWith(elseHead, gateEnd + 1),
    "the open-gate branch must have an else arm",
  );
  assert.equal(
    produce.slice(
      gateEnd + 1 + elseHead.length,
      closerOf(produce, gateEnd + elseHead.length),
    ),
    codeOf("zeroFill(buffer, capacity)"),
    "a closed or released gate must zero-fill the ADM buffer, and only that",
  );
  assert.equal(
    countWired(AUDIO_SOURCE_CODE, "buffer.put(scratch)"),
    1,
    "the capture may reach the ADM buffer only inside the open-gate branch",
  );
  // The two copies in the branch and the one in zeroFill, which writes zeros.
  assert.equal(countWired(AUDIO_SOURCE_CODE, ".put("), 3);
  const [zeroFill] = blockBodiesOf(AUDIO_SOURCE_CODE, "private fun zeroFill(");
  assert.equal(
    zeroFill,
    codeOf(`buffer.clear()
      buffer.put(zerosOf(capacity), 0, capacity)
      buffer.position(0)`),
    "zeroFill must fill the ADM buffer from the zeros array",
  );
  assert.equal(
    countWired(AUDIO_SOURCE_CODE, "zeros ="),
    2,
    "the zeros array is written only as a fresh array",
  );
  // Every mention of the gate, accounted for: the declaration (pinned
  // above), openGate (pinned above), closeGate and release (writes only,
  // release closing it for good), produce's one read, and the two reads in
  // deliverFailureIfDue, which only decide when a held-back failure is
  // reported, never what is sent. A ninth mention is a new read.
  assert.equal(countWired(produce, "gateOpen"), 1);
  const [close] = blockBodiesOf(AUDIO_SOURCE_CODE, "fun closeGate(");
  assert.equal(close, codeOf("gateOpen = false"));
  const releases = blockBodiesOf(AUDIO_SOURCE_CODE, "fun release(");
  assert.equal(releases.length, 1, "ScreenAudioSource.kt must declare release");
  assert.equal(
    releases[0],
    codeOf(`gateOpen = false
      val rec = synchronized(lock) {
        released = true
        val r = record
        record = null
        r
      }
      gateOpen = false
      stopAndRelease(rec)`),
    "release must close the gate, latch released, then close it again",
  );
  const [deliver] = blockBodiesOf(
    AUDIO_SOURCE_CODE,
    "private fun deliverFailureIfDue(",
  );
  assert.equal(
    deliver,
    codeOf(`if (!failed || failureDelivered || !gateOpen || released) return
      synchronized(lock) {
        if (released || failureDelivered || !gateOpen) return
        failureDelivered = true
        try {
          onFailure()
        } catch (e: Exception) {
          Log.w(TAG, "onFailure threw " + e.javaClass.simpleName)
        }
      }`),
    "deliverFailureIfDue may read the gate only to time the failure report",
  );
  assert.equal(
    countWired(AUDIO_SOURCE_CODE, "gateOpen"),
    9,
    "ScreenAudioSource.kt must not read the gate anywhere else",
  );

  // The witness itself: THIS publication's own sender cryptor, found by the
  // key E2EEManager stores it under (the publication sid and the leg's
  // identity), enabled AND at the current index. Anything missing or a
  // throw from the reflection is "not witnessed": a disabled cryptor passes
  // frames in the clear, and one at a stale index encrypts under a key the
  // wrong epoch's members hold.
  const witnesses = bodiesAfter(
    PLUGIN_CODE,
    "private fun audioCryptorWitnessed(room: Room, index: Int): Boolean {",
  );
  assert.equal(witnesses.length, 1, "the plugin must declare the witness once");
  assert.equal(
    witnesses[0],
    codeOf(`return try {
        val manager = room.e2eeManager ?: return false
        if (!manager.enabled) return false
        val pub = room.localParticipant
          .getTrackPublication(Track.Source.SCREEN_SHARE_AUDIO) ?: return false
        val identity = room.localParticipant.identity ?: return false
        val key = Pair(pub.sid, identity)
        val cryptor = frameCryptorMap(manager).entries
          .firstOrNull { it.key == key }
          ?.value ?: return false
        cryptor.isEnabled && cryptor.keyIndex == index
      } catch (_: Throwable) {
        false
      }`),
    "the witness must require this sender's cryptor, enabled and at the " +
      "current index, and read a throw as not witnessed",
  );
  assert.equal(countWired(PLUGIN_CODE, "audioCryptorWitnessed("), 2);

  // After the gate opens, the manager's observer is what watches the audio
  // sender, and plan A-M1 has it end the WHOLE leg: the arm takes no source
  // filter, so an audio cryptor error tears the video down too (one key
  // ring, one index), and nothing in onRoomEvent runs ahead of it.
  // Nothing ahead of onRoomEvent either: the Room's events reach it from one
  // collector, launched on its own, with nothing between `room.events` and
  // `.collect`. A `.filter { it !is TrackEvent }` or a `.takeWhile` there
  // would drop the audio sender's E2EE failure before the arm below could
  // end the leg, and with no collector no failure is seen at all.
  assertPluginWired(
    "the room-event collector",
    "room.events.collect { event -> onRoomEvent(event) }",
  );
  assertPluginWired(
    "the collector is its launch's whole body",
    `events = scope.launch {
      room.events.collect { event -> onRoomEvent(event) }
    }`,
  );
  assert.equal(
    countWired(PLUGIN_CODE, "onRoomEvent("),
    2,
    "onRoomEvent must be the declaration and the one collector's call",
  );
  const onRoomEvents = blockBodiesOf(PLUGIN_CODE, "private fun onRoomEvent(");
  assert.equal(onRoomEvents.length, 1, "the plugin must declare onRoomEvent");
  assert.ok(
    onRoomEvents[0].startsWith(
      codeOf(`val room = this.room ?: return
        when (event) {
          is RoomEvent.TrackE2EEStateEvent -> {`),
    ),
    "the E2EE state arm must be onRoomEvent's first, with no filter before it",
  );
  const e2eeArms = bodiesAfter(
    PLUGIN_CODE,
    "is RoomEvent.TrackE2EEStateEvent -> {",
  );
  assert.equal(e2eeArms.length, 1, "onRoomEvent must handle E2EE state once");
  assert.equal(
    e2eeArms[0],
    codeOf(`if (event.state != E2EEState.OK && event.state != E2EEState.NEW) {
        scope.launch { tearDown("error") }
      }`),
    "the E2EE state arm must end the whole leg on any sender, audio included",
  );
  assert.equal(countWired(PLUGIN_CODE, "TrackE2EEStateEvent"), 1);

  // The post-audio-publish key-index assertion sits OUTSIDE the audio-only
  // catch, ahead of the witness: its throw must fail the whole leg (a second
  // E2EE sender refusing the current index is a hole for the video too),
  // never be swallowed as "audio failed" with the video left on air. The
  // audio block holds one try, whose catch rethrows cancellation only.
  const [connect] = blockBodiesOf(
    PLUGIN_CODE,
    "private suspend fun doConnect(",
  );
  const audioBlocks = bodiesAfter(
    connect,
    "if (audioState == null && Build.VERSION.SDK_INT >= 29) {",
  );
  assert.equal(audioBlocks.length, 1, "doConnect must hold one audio block");
  const [audioBlock] = audioBlocks;
  const tryHead = codeOf("try {");
  const tryAt = onceAt(audioBlock, "the audio-only try", "try {");
  const tryEnd = closerOf(audioBlock, tryAt + tryHead.length - 1);
  const tryBody = audioBlock.slice(tryAt + tryHead.length, tryEnd);
  assert.equal(
    countWired(tryBody, "assertSenderKeyIndex("),
    0,
    "the audio key-index assertion must not sit inside the audio-only try",
  );
  // The block is the only place a source is built, so the guard pinned in
  // the mic-recording test above guards every playback capture.
  assert.equal(countWired(tryBody, "ScreenAudioSource(projection)"), 1);
  assert.equal(countWired(PLUGIN_CODE, "ScreenAudioSource("), 1);
  const catchHead = codeOf("catch (t: Throwable) {");
  assert.ok(
    audioBlock.startsWith(catchHead, tryEnd + 1),
    "the audio-only try must be caught as Throwable",
  );
  const catchEnd = closerOf(audioBlock, tryEnd + catchHead.length);
  assert.equal(
    audioBlock.slice(tryEnd + 1 + catchHead.length, catchEnd),
    codeOf(
      'if (t is ConnectCancelled || t is CancellationException) throw t trace("audio publish failed ${t.javaClass.simpleName}")',
    ),
    "the audio-only catch must swallow audio failures and rethrow cancellation",
  );
  const assertAt = onceAt(
    audioBlock,
    "the post-audio-publish key-index assertion",
    "assertSenderKeyIndex(room, currentKeyIndex)",
  );
  assert.ok(
    assertAt > catchEnd,
    "the audio key-index assertion must come after the audio-only catch",
  );
  assert.ok(
    audioBlock.slice(catchEnd + 1).startsWith(
      codeOf(`ensureConnectCurrent(generation)
        val source = audio
        if (audioPublished && source != null) {
          if (provider != null) {
            assertSenderKeyIndex(room, currentKeyIndex)
          }
          val witnessed = provider == null ||
            audioCryptorWitnessed(room, currentKeyIndex)`),
    ),
    "the audio key-index assertion must run right after a successful " +
      "publish, outside the catch and before the witness",
  );
  // The video's assertion and the audio's, nothing else in doConnect.
  assert.equal(countWired(connect, "assertSenderKeyIndex("), 2);
  // What the assertion does: move EVERY sender cryptor, audio and video, to
  // the current index, then throw if any one of them did not take it. With
  // no switch the audio sender stays at the index it was built with; with
  // no throw a refused switch passes silently, and the leg sends under a key
  // the current epoch's members may not hold instead of failing.
  const keyAsserts = blockBodiesOf(
    PLUGIN_CODE,
    "private fun assertSenderKeyIndex(",
  );
  assert.equal(keyAsserts.length, 1, "the plugin must declare it once");
  assert.equal(
    keyAsserts[0],
    codeOf(`for (cryptor in senderCryptors(room)) {
        cryptor.setKeyIndex(index)
      }
      for (cryptor in senderCryptors(room)) {
        if (cryptor.keyIndex != index) {
          throw IllegalStateException("sender cryptor refused key index switch")
        }
      }`),
    "assertSenderKeyIndex must set the index on every sender cryptor, then " +
      "throw if any one of them is not at it",
  );
  // The cryptors both loops walk: every one the manager holds. An empty or
  // narrowed list would pass both loops without checking anything.
  const senders = bodiesAfter(
    PLUGIN_CODE,
    "private fun senderCryptors(room: Room?): Collection<FrameCryptor> {",
  );
  assert.equal(senders.length, 1, "senderCryptors must be declared once");
  assert.equal(
    senders[0],
    codeOf(`val manager = room?.e2eeManager ?: return emptyList()
      return frameCryptorMap(manager).values`),
    "senderCryptors must hand back every cryptor the manager holds",
  );

  // Where that throw lands. An IllegalStateException from either assertion
  // is not cancellation, so it must fail the connect: if any catch on its
  // way out resolved instead (`if (t is IllegalStateException)
  // call.resolve(ok)`), a leg whose sender cryptor refused the key index
  // would go live and JS would be told it started. Nothing between the
  // assertions and doConnect's outer catch may catch it: doConnect holds
  // three tries, the mic-recording guard (closed before the outer try
  // opens), the outer try, and the audio-only try, whose catch rethrows
  // only cancellation (pinned above). The outer catch releases the audio,
  // discards a Room this attempt no longer owns, and always rethrows.
  // connect's catch then rejects. A current attempt is torn down first; a
  // superseded one was torn down by whatever cancelled it, and the outer
  // catch discarded its Room. The one resolve is the success tail, the
  // outer try's last statement.
  assert.equal(countWired(connect, "try {"), 3, "doConnect must hold 3 tries");
  assert.equal(countWired(connect, "catch ("), 3, "and 3 catches");
  assert.equal(countWired(connect, "runCatching"), 0);
  const micHead = codeOf("val micRecordingOff = try {");
  const micAt = onceAt(
    connect,
    "the mic-recording guard",
    "val micRecordingOff = try {",
  );
  const micEnd = closerOf(connect, micAt + micHead.length - 1);
  assert.ok(
    connect.startsWith(codeOf("catch (_: Throwable) { false }"), micEnd + 1),
    "the mic-recording guard must catch into false",
  );
  const outerHead = codeOf("var audio: ScreenAudioSource? = null try {");
  const outerAt = onceAt(
    connect,
    "doConnect's outer try",
    "var audio: ScreenAudioSource? = null try {",
  );
  assert.ok(micEnd < outerAt, "the mic-recording guard must close first");
  const outerOpen = outerAt + outerHead.length - 1;
  const outerEnd = closerOf(connect, outerOpen);
  const asserts = wiredAt(connect, "assertSenderKeyIndex(");
  assert.equal(asserts.length, 2);
  for (const at of asserts) {
    assert.ok(
      at > outerOpen && at < outerEnd,
      "each key-index assertion must sit inside doConnect's outer try",
    );
  }
  assertPluginWired(
    "the video key-index assertion, straight after the publish check",
    `if (published != true) {
      throw IllegalStateException("screen share publish refused")
    }
    if (provider != null) {
      assertSenderKeyIndex(room, currentKeyIndex)
    }`,
  );
  assert.ok(
    connect.slice(0, outerEnd).endsWith(
      codeOf(`ensureConnectCurrent(generation)
        screenAudio = audio
        audio = null
        notifyListeners("started", JSObject())
        val ok = JSObject()
        ok.put("ok", true)
        ok.put("audio", audioState ?: "failed")
        call.resolve(ok)`),
    ),
    "doConnect's resolve must be the outer try's last statement",
  );
  assert.equal(
    connect.slice(outerEnd + 1),
    codeOf(`catch (t: Throwable) {
        releaseAudio(audio)
        if (this.room !== room) {
          events?.cancel()
          if (events != null && eventsJob === events) eventsJob = null
          discardRoom(room, alreadyReleased = releasedRoom === room, audio = audio)
        }
        throw t
      }`),
    "doConnect's outer catch must release, discard, and always rethrow",
  );
  assert.equal(countWired(connect, ".resolve("), 1, "doConnect resolves once");
  assert.equal(countWired(connect, ".reject("), 0, "doConnect never rejects");
  assert.equal(countWired(PLUGIN_CODE, "doConnect("), 2);
  const [connectCall] = blockBodiesOf(PLUGIN_CODE, "fun connect(");
  assert.ok(
    connectCall.endsWith(
      codeOf(`val generation = ++connectGeneration
        try {
          doConnect(generation, call, url, token, quality, e2ee, intent, audio)
        } catch (t: Throwable) {
          if (generation != connectGeneration) {
            if (generation == revokedGeneration) {
              call.reject("connect_failed: revoked")
            } else {
              call.reject("connect_failed: cancelled")
            }
          } else {
            val consent = consentIntent
            tearDown(reason = null)
            consentIntent = consent
            call.reject("connect_failed: \${t.message ?: t.javaClass.simpleName}")
          }
        }
      }`),
    ),
    "connect's catch must reject every failure, tearing a current one down",
  );
  assert.equal(
    countWired(connectCall, ".resolve("),
    0,
    "connect never resolves",
  );
  assert.equal(countWired(connectCall, "tearDown("), 1);
});
