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
  type LegAnnouncer,
  type LegBridge,
  type LegSendKey,
  type NativeFrameKey,
  AndroidLegLifecycle,
  keyActionAfterConnect,
  startAttemptCancelled,
  startAttemptStale,
} from "./androidLegStartPolicy.ts";
import {
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

test("changed key MATERIAL at the same index still re-keys", () => {
  // A key index is unique only within an epoch, so two epochs can reuse one.
  // Comparing indices alone would skip a required rotation and leave the leg
  // publishing under the key a removed member holds.
  assert.deepEqual(
    keyActionAfterConnect(key("AAA", 1), key("BBB", 1, { epoch: 20 })),
    { kind: "push", key: key("BBB", 1, { epoch: 20 }) },
  );
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
 * recorded as it crossed (`frameKeys`), and the announcer records what it
 * hears as `"started"` / `"stopped:<reason>"`.
 */
function lifecycle(stopTimeoutMs?: number) {
  const events: string[] = [];
  const stops: Deferred<void>[] = [];
  const frameKeys: NativeFrameKey[] = [];
  const bridge: LegBridge = {
    setFrameKey: (k) => {
      frameKeys.push(k);
      return Promise.resolve();
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
  const leg = new AndroidLegLifecycle(bridge, announce, stopTimeoutMs);
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

const SHARE_SOURCE = readFileSync(
  new URL("./androidScreenShare.ts", import.meta.url),
  "utf8",
);
const SHARE_CODE = codeOf(SHARE_SOURCE);

/** `snippet` must appear exactly once in androidScreenShare.ts's code. */
const assertShareWired = wiredAsserter("androidScreenShare.ts", SHARE_CODE);

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
    6,
    "androidScreenShare.ts must reach the lifecycle through exactly the six " +
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
