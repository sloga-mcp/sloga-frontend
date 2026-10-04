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
  type LegBridge,
  type LegSendKey,
  type LegStopNotice,
  type NativeFrameKey,
  type NativeStopReason,
  AndroidLegLifecycle,
  FRAME_KEY_TIMEOUT_MS,
  gateStopNotice,
  keyActionAfterConnect,
  nativeStopNotice,
  staleExitNotice,
  startAttemptCancelled,
  startAttemptStale,
  STOP_TIMEOUT_MS,
} from "./androidLegStartPolicy.ts";
import {
  argumentsOf,
  bodiesAfter,
  codeOf,
  countWired,
  wiredAsserter,
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
  assertShareWired("connect()", "return this.#core.connect(options.e2ee,");
  // The plugin connects with the key the lifecycle hands its callback, which
  // has already lost its group. The caller's own key would carry `groupId`
  // across the bridge, and tsc accepts that (the extra field is no error).
  assertShareWired("the plugin's connect", "(e2ee) => plugin!.connect({");
  assertShareWired("the callback's key", "audio: false, e2ee, })");
  assert.equal(
    countWired(SHARE_CODE, "options.e2ee"),
    1,
    "androidScreenShare.ts must hand the caller's key to the lifecycle only",
  );
  assertShareWired("setFrameKey()", "return this.#core.setFrameKey(key);");
  assertShareWired("stop()", "return this.#core.stop();");
  assert.equal(
    countWired(SHARE_CODE, "#core."),
    7,
    "androidScreenShare.ts must reach the lifecycle through exactly the seven " +
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
