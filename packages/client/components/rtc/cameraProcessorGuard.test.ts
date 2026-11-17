// Unit spec for the camera background processor guard (camera-effects-trust).
//   node --test --conditions=browser components/rtc/cameraProcessorGuard.test.ts
// Focus: LiveKit puts the RAW camera track on the sender whenever a processor
// has no `processedTrack`, and a processor `init` that rejects inside
// `createLocalTracks` leaves the capture open. So the guard's `init` and
// `restart` must never reject and never hang, and after a failed start
// `processedTrack` must be the black track, never undefined and never a late
// real output adopted behind the controller's back. The real processor, the
// black source and the timers are injected, which is what makes these rules
// reachable by `node --test`; the wiring in `cameraEffects.ts` is live-only.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type BlackFrameSource,
  type GuardedProcessor,
  CAMERA_PROCESSOR_START_TIMEOUT_MS,
  CameraProcessorGuard,
} from "./cameraProcessorGuard.ts";

type StartOptions = Parameters<GuardedProcessor["init"]>[0];

interface FakeTrack {
  readyState: "live" | "ended";
  stop(): void;
}

function fakeTrack(): FakeTrack {
  return {
    readyState: "live",
    stop() {
      this.readyState = "ended";
    },
  };
}

const asTrack = (t: FakeTrack) => t as unknown as MediaStreamTrack;
const opts = (t: FakeTrack = fakeTrack()) =>
  ({ kind: "video", track: asTrack(t) }) as unknown as StartOptions;

/** One in-flight init/restart of the fake real processor. */
interface PendingStart {
  kind: "init" | "restart";
  /** Settle as a successful start that produced a live output track. */
  succeed(): FakeTrack;
  /** Settle successfully WITHOUT producing an output track. */
  succeedWithoutOutput(): void;
  fail(error: unknown): void;
}

class FakeInner implements GuardedProcessor {
  name = "fake-inner";
  processedTrack: MediaStreamTrack | undefined;
  calls: string[] = [];
  pending: PendingStart[] = [];
  published: unknown[] = [];

  #begin(kind: "init" | "restart"): Promise<void> {
    this.calls.push(kind);
    return new Promise<void>((resolve, reject) => {
      this.pending.push({
        kind,
        succeed: () => {
          const out = fakeTrack();
          this.processedTrack = asTrack(out);
          resolve();
          return out;
        },
        succeedWithoutOutput: () => resolve(),
        fail: (error) => reject(error),
      });
    });
  }

  init(): Promise<void> {
    return this.#begin("init");
  }

  restart(): Promise<void> {
    return this.#begin("restart");
  }

  async destroy(): Promise<void> {
    this.calls.push("destroy");
  }

  async onPublish(room: unknown): Promise<void> {
    this.published.push(room);
  }

  last(): PendingStart {
    const p = this.pending[this.pending.length - 1];
    assert.ok(p, "the real processor was never started");
    return p;
  }
}

interface FakeTimer {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

interface FakeBlack {
  track: FakeTrack;
  stops: number;
}

function harness(o: { buildThrows?: unknown; noBlack?: boolean } = {}) {
  const inner = new FakeInner();
  const timers: FakeTimer[] = [];
  const blacks: FakeBlack[] = [];
  let builds = 0;
  const guard = new CameraProcessorGuard<FakeInner>({
    build: () => {
      builds++;
      if (o.buildThrows !== undefined) throw o.buildThrows;
      return inner;
    },
    createBlackSource: (): BlackFrameSource | undefined => {
      if (o.noBlack) return undefined;
      const black: FakeBlack = { track: fakeTrack(), stops: 0 };
      blacks.push(black);
      return {
        track: asTrack(black.track),
        stop: () => {
          black.stops++;
          black.track.stop();
        },
      };
    },
    setTimeout: (fn, ms) => {
      const timer: FakeTimer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (handle) => {
      (handle as FakeTimer).cleared = true;
    },
  });
  return {
    guard,
    inner,
    timers,
    blacks,
    builds: () => builds,
    lastBlack: () => blacks[blacks.length - 1],
    fireLastTimer: () => timers[timers.length - 1].fn(),
  };
}

/** Let every already-settled promise continuation run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Start `p` and report whether it has settled after a flush. */
async function settled(p: Promise<void>): Promise<boolean> {
  let done = false;
  void p.then(() => {
    done = true;
  });
  await flush();
  return done;
}

/**
 * Await a guard promise, FAILING when it never settles. A guard that hangs is
 * exactly the defect several specs here exist to catch, and a bare `await`
 * on it would hang the whole run instead of reporting a failure.
 */
async function done(p: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("the guard promise never settled")),
      2_000,
    );
  });
  try {
    await Promise.race([p, hung]);
  } finally {
    clearTimeout(timer);
  }
}

/** Drive an init to a failure and return once the guard has recorded it. */
async function failedInit(h: ReturnType<typeof harness>, error: unknown) {
  const p = h.guard.init(opts());
  h.inner.last().fail(error);
  await done(p);
}

test("init success passes the real output track through and arms no black source", async () => {
  const h = harness();
  const source = fakeTrack();
  const p = h.guard.init(opts(source));
  assert.equal(await settled(p), false, "init must wait for the real init");
  const out = h.inner.last().succeed();
  await done(p);

  assert.deepEqual(h.inner.calls, ["init"]);
  assert.equal(h.guard.failed, false);
  assert.equal(h.guard.error, undefined);
  assert.equal(h.guard.processedTrack, asTrack(out));
  assert.equal(h.guard.source, asTrack(source));
  assert.equal(h.guard.name, "fake-inner");
  assert.equal(h.blacks.length, 0);
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, CAMERA_PROCESSOR_START_TIMEOUT_MS);
  assert.equal(h.timers[0].ms, 12_000);
  assert.equal(h.timers[0].cleared, true, "the timeout must not stay armed");
});

test("init rejection never rejects: failed, error kept, live black track exposed", async () => {
  const h = harness();
  const boom = new Error("segmenter assets unreachable");
  const p = h.guard.init(opts());
  h.inner.last().fail(boom);
  await assert.doesNotReject(done(p));

  assert.equal(h.guard.failed, true);
  assert.equal(h.guard.error, boom);
  assert.equal(h.blacks.length, 1);
  assert.equal(h.guard.processedTrack, asTrack(h.lastBlack().track));
  assert.equal(h.guard.processedTrack?.readyState, "live");
  assert.equal(h.timers[0].cleared, true);
});

test("a build failure takes the same black-frame path and never rejects", async () => {
  const boom = new Error("background transformer is not supported");
  const h = harness({ buildThrows: boom });
  await assert.doesNotReject(done(h.guard.init(opts())));

  assert.equal(h.builds(), 1);
  assert.equal(h.guard.inner, undefined);
  assert.equal(h.guard.failed, true);
  assert.equal(h.guard.error, boom);
  assert.equal(h.guard.processedTrack, asTrack(h.lastBlack().track));
  assert.equal(h.guard.name, "background-processor");
});

test("an init that resolves without a live output track is a failure, not a raw fallback", async () => {
  const h = harness();
  const p = h.guard.init(opts());
  h.inner.last().succeedWithoutOutput();
  await done(p);

  assert.equal(h.guard.failed, true);
  assert.ok(h.guard.error instanceof Error);
  assert.equal(h.guard.processedTrack, asTrack(h.lastBlack().track));

  // An ENDED output is no better than a missing one.
  const h2 = harness();
  const p2 = h2.guard.init(opts());
  h2.inner.last().succeed().stop();
  await done(p2);
  assert.equal(h2.guard.failed, true);
  assert.equal(h2.guard.processedTrack, asTrack(h2.lastBlack().track));
});

test("timeout: init resolves failed with the black track while the real init still hangs", async () => {
  const h = harness();
  const p = h.guard.init(opts());
  assert.equal(await settled(p), false);
  assert.equal(h.guard.failed, false);

  h.fireLastTimer();
  await done(p);

  assert.equal(h.guard.failed, true);
  assert.ok(h.guard.error instanceof Error);
  assert.equal(h.guard.processedTrack, asTrack(h.lastBlack().track));
  assert.equal(h.guard.processedTrack?.readyState, "live");
  assert.deepEqual(h.inner.calls, ["init"], "nothing is destroyed mid-init");
});

test("timeout: a real processor that comes up late is destroyed, not adopted", async () => {
  const h = harness();
  const p = h.guard.init(opts());
  h.fireLastTimer();
  await done(p);
  const black = h.lastBlack();

  const late = h.inner.last().succeed();
  await flush();

  assert.deepEqual(h.inner.calls, ["init", "destroy"]);
  assert.equal(h.guard.failed, true, "the late output must not clear failed");
  assert.equal(h.guard.processedTrack, asTrack(black.track));
  assert.notEqual(h.guard.processedTrack, asTrack(late));
  assert.equal(black.stops, 0, "the black track must keep running");
});

test("timeout: a real init that rejects late is ignored", async () => {
  const h = harness();
  const p = h.guard.init(opts());
  h.fireLastTimer();
  await done(p);
  const error = h.guard.error;

  h.inner.last().fail(new Error("late rejection"));
  await flush();

  assert.deepEqual(h.inner.calls, ["init"]);
  assert.equal(h.guard.failed, true);
  assert.equal(h.guard.error, error, "the timeout stays the recorded cause");
});

test("timeout: a retry started before the late resolution owns the real processor", async () => {
  const h = harness();
  const p = h.guard.init(opts());
  const first = h.inner.last();
  h.fireLastTimer();
  await done(p);

  const retry = h.guard.restart(opts());
  assert.deepEqual(h.inner.calls, ["init", "restart"]);
  // The timed-out init settles while the retry is in flight. Destroying the
  // real processor now would kill the pipeline the retry is building.
  first.succeedWithoutOutput();
  await flush();
  assert.deepEqual(h.inner.calls, ["init", "restart"]);

  const out = h.inner.last().succeed();
  await done(retry);
  assert.equal(h.guard.failed, false);
  assert.equal(h.guard.processedTrack, asTrack(out));
});

test("a second init routes to the real processor's restart", async () => {
  const h = harness();
  const p1 = h.guard.init(opts());
  h.inner.last().succeed();
  await done(p1);

  const p2 = h.guard.init(opts());
  const out = h.inner.last().succeed();
  await done(p2);

  assert.deepEqual(h.inner.calls, ["init", "restart"]);
  assert.equal(h.builds(), 1, "the real processor is built once");
  assert.equal(h.guard.failed, false);
  assert.equal(h.guard.processedTrack, asTrack(out));
});

test("restart after a failure retries the real start once and recovers", async () => {
  const h = harness();
  await failedInit(h, new Error("first try"));
  const black = h.lastBlack();

  const source = fakeTrack();
  const p = h.guard.restart(opts(source));
  assert.deepEqual(h.inner.calls, ["init", "restart"]);
  const out = h.inner.last().succeed();
  await done(p);

  assert.equal(h.guard.failed, false);
  assert.equal(h.guard.error, undefined);
  assert.equal(h.guard.processedTrack, asTrack(out));
  assert.equal(h.guard.source, asTrack(source));
  assert.equal(black.stops, 1, "the black source is released on recovery");
  assert.equal(black.track.readyState, "ended");
});

test("the retry is spent after one attempt: later restarts keep the black track and never reject", async () => {
  const h = harness();
  await failedInit(h, new Error("first try"));

  const retry = h.guard.restart(opts());
  h.inner.last().fail(new Error("second try"));
  await assert.doesNotReject(done(retry));
  assert.equal(h.guard.failed, true);
  assert.deepEqual(h.inner.calls, ["init", "restart"]);

  const source = fakeTrack();
  await assert.doesNotReject(done(h.guard.restart(opts(source))));
  await assert.doesNotReject(done(h.guard.restart(opts(source))));
  assert.deepEqual(
    h.inner.calls,
    ["init", "restart"],
    "no third start of the real processor",
  );
  assert.equal(h.guard.failed, true);
  assert.equal(h.guard.source, asTrack(source));
  assert.equal(h.blacks.length, 1, "the live black source is reused");
  assert.equal(h.guard.processedTrack?.readyState, "live");
});

test("a successful recovery restores the retry: the next failure gets one of its own", async () => {
  const h = harness();
  await failedInit(h, new Error("first try"));

  const recover = h.guard.restart(opts());
  h.inner.last().succeed();
  await done(recover);
  assert.equal(h.guard.failed, false);

  // A restart of a RUNNING processor that fails is a new failure.
  const breaks = h.guard.restart(opts());
  h.inner.last().fail(new Error("device switch failed"));
  await done(breaks);
  assert.equal(h.guard.failed, true);
  assert.deepEqual(h.inner.calls, ["init", "restart", "restart"]);

  const retry = h.guard.restart(opts());
  assert.deepEqual(
    h.inner.calls,
    ["init", "restart", "restart", "restart"],
    "the new failure is retried",
  );
  h.inner.last().fail(new Error("still failing"));
  await done(retry);

  await done(h.guard.restart(opts()));
  assert.equal(h.inner.calls.length, 4, "and only once");
  assert.equal(h.guard.failed, true);
});

test("a spent guard replaces a black track that has ended", async () => {
  const h = harness();
  await failedInit(h, new Error("first try"));
  const retry = h.guard.restart(opts());
  h.inner.last().fail(new Error("second try"));
  await done(retry);

  // LiveKit's stopProcessor stops processedTrack; a later restart must not
  // hand back the dead one.
  h.lastBlack().track.stop();
  await done(h.guard.restart(opts()));

  assert.equal(h.blacks.length, 2);
  assert.equal(h.guard.processedTrack, asTrack(h.blacks[1].track));
  assert.equal(h.guard.processedTrack?.readyState, "live");
});

test("destroy stops the black source and destroys the real processor", async () => {
  const h = harness();
  await failedInit(h, new Error("first try"));
  const black = h.lastBlack();
  assert.equal(black.stops, 0);

  await h.guard.destroy();

  assert.equal(black.stops, 1);
  assert.equal(black.track.readyState, "ended");
  assert.deepEqual(h.inner.calls, ["init", "destroy"]);

  // Running guard: the real processor is destroyed, nothing else to stop.
  const h2 = harness();
  const p = h2.guard.init(opts());
  h2.inner.last().succeed();
  await done(p);
  await h2.guard.destroy();
  assert.deepEqual(h2.inner.calls, ["init", "destroy"]);
  assert.equal(h2.blacks.length, 0);
});

test("destroy mid-init: the start in flight frees what it built and adopts nothing", async () => {
  const h = harness();
  const p = h.guard.init(opts());
  await flush();

  await h.guard.destroy();
  assert.deepEqual(h.inner.calls, ["init", "destroy"]);

  h.inner.last().succeed();
  await done(p);

  // The first destroy ran while the real init was still in flight (a no-op
  // for the real wrapper), so the pipeline it then built must be freed.
  assert.deepEqual(h.inner.calls, ["init", "destroy", "destroy"]);
  assert.equal(h.guard.failed, false);
  assert.equal(h.blacks.length, 0);
  assert.equal(h.timers[0].cleared, true);

  // A rejection overtaken by destroy is dropped: no black source is started
  // for a guard that is already gone.
  const h2 = harness();
  const p2 = h2.guard.init(opts());
  await h2.guard.destroy();
  h2.inner.last().fail(new Error("too late"));
  await assert.doesNotReject(done(p2));
  assert.equal(h2.blacks.length, 0);
  assert.deepEqual(h2.inner.calls, ["init", "destroy"]);
});

test("processedTrack is never undefined once the first init has completed", async () => {
  const h = harness();
  await failedInit(h, new Error("first try"));
  assert.notEqual(h.guard.processedTrack, undefined);

  const timedOut = h.guard.restart(opts());
  h.fireLastTimer();
  await done(timedOut);
  assert.notEqual(h.guard.processedTrack, undefined);

  await done(h.guard.restart(opts()));
  assert.notEqual(h.guard.processedTrack, undefined);

  // Destroyed while LiveKit may still hold the guard: the stopped black track
  // stays readable instead of dropping to undefined (which reads as raw).
  await h.guard.destroy();
  assert.notEqual(h.guard.processedTrack, undefined);
  assert.equal(h.guard.processedTrack?.readyState, "ended");

  const ok = harness();
  const p = ok.guard.init(opts());
  ok.inner.last().succeed();
  await done(p);
  assert.notEqual(ok.guard.processedTrack, undefined);
  const again = ok.guard.restart(opts());
  ok.inner.last().succeed();
  await done(again);
  assert.notEqual(ok.guard.processedTrack, undefined);
});

test("with no black source available a failure is still recorded and never rejects", async () => {
  const h = harness({ noBlack: true });
  const p = h.guard.init(opts());
  h.inner.last().fail(new Error("first try"));
  await assert.doesNotReject(done(p));

  assert.equal(h.guard.failed, true);
  assert.equal(h.guard.processedTrack, undefined);
});

test("onPublish is forwarded to the real processor", async () => {
  const h = harness();
  const room = { name: "room" };
  // Before the real processor exists there is nothing to forward to.
  await assert.doesNotReject(done(h.guard.onPublish(room as never)));
  await assert.doesNotReject(done(h.guard.onUnpublish()));

  const p = h.guard.init(opts());
  h.inner.last().succeed();
  await done(p);
  await h.guard.onPublish(room as never);
  await assert.doesNotReject(done(h.guard.onUnpublish()));
  assert.deepEqual(h.inner.published, [room]);
});
