// Specs for the app-start E2EE worker probe (plan D8) — run with Node's
// built-in runner, from packages/client:
//   node --test --conditions=browser components/rtc/workerProbe.test.ts
//
// One posture: the probe says "pass" only when the worker answered livekit's
// `init` with `initAck` AND posted a heartbeat whose `rte` is "function", both
// before the timeout. Everything else is "fail", and before it settles it is
// "pending" (not ready). The holes these pin:
//
//   rte       — a probe that passes on initAck plus ANY heartbeat would pass a
//               pre-`rte` patch and a worker with no script-transform event.
//   timeout   — a probe with no timeout leaves the predicate "pending"
//               forever on a worker that never answers; one that ignores its
//               timer can still pass long after the bound.
//   pending   — the cache's "not settled" value must never read as "pass".
//   terminate — the patched worker heartbeats from module scope every second;
//               a probe worker left alive runs for the life of the app.
//   no key    — the probe posts exactly one message, `init`, and nothing else.
//   real init — the init shape is checked against the REAL pinned worker: a
//               bad `loglevel` makes the worker throw before it acks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { MlsKeyProvider } from "./mlsCallKeys.ts";
import {
  type ProbeWorker,
  WORKER_PROBE_TIMEOUT_MS,
  resetWorkerProbeForTest,
  runWorkerProbe,
  workerProbeResult,
} from "./workerProbe.ts";

/** The heartbeat the patched worker posts once the `rte` field has landed. */
const heartbeat = (rte: unknown = "function") => ({
  kind: "slogaDecodeWitness",
  data: { participants: [], rte },
});
const initAck = { kind: "initAck", data: { enabled: false } };

interface FakeWorker extends ProbeWorker {
  posted: unknown[];
  terminated: number;
  emit(data: unknown): void;
  error(): void;
}

function fakeWorker(
  options: { throwOnPost?: boolean; onPost?: (w: FakeWorker) => void } = {},
): FakeWorker {
  const listeners: Record<string, ((ev: { data?: unknown }) => void)[]> = {
    message: [],
    error: [],
  };
  const w: FakeWorker = {
    posted: [],
    terminated: 0,
    postMessage(m) {
      if (options.throwOnPost) throw new Error("DataCloneError");
      w.posted.push(m);
      options.onPost?.(w);
    },
    addEventListener(t, f) {
      listeners[t].push(f);
    },
    terminate() {
      w.terminated += 1;
    },
    emit(data) {
      for (const f of listeners.message) f({ data });
    },
    error() {
      for (const f of listeners.error) f({});
    },
  };
  return w;
}

interface Timers {
  setTimeout: (callback: () => void, ms: number) => number;
  clearTimeout: (handle: number) => void;
  /** Every timer still scheduled, by handle. */
  pending: Map<number, { callback: () => void; ms: number }>;
  /** Fire every scheduled timer, as if the clock passed all of them. */
  fireAll(): void;
}

function timers(): Timers {
  let next = 1;
  const pending = new Map<number, { callback: () => void; ms: number }>();
  return {
    pending,
    setTimeout(callback, ms) {
      const handle = next++;
      pending.set(handle, { callback, ms });
      return handle;
    },
    clearTimeout(handle) {
      pending.delete(handle);
    },
    fireAll() {
      for (const [handle, t] of [...pending]) {
        pending.delete(handle);
        t.callback();
      }
    },
  };
}

/** Lets queued microtasks run, then reports whether `p` settled and to what. */
async function peek<T>(
  p: Promise<T>,
): Promise<{ value?: T; settled: boolean }> {
  const out: { value?: T; settled: boolean } = { settled: false };
  void p.then((value) => {
    out.value = value;
    out.settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  return out;
}

/**
 * What `p` settled to. These specs drive fake timers, so a probe that has not
 * settled by now never will: assert that instead of awaiting it, or a broken
 * probe HANGS the spec run rather than failing it.
 */
async function settled<T>(p: Promise<T>): Promise<T> {
  const seen = await peek(p);
  assert.ok(seen.settled, "the probe settled without waiting on a timer");
  return seen.value as T;
}

interface Rig {
  worker: FakeWorker;
  clock: Timers;
  made: number;
  probe: () => Promise<"pass" | "fail">;
}

function rig(options: Parameters<typeof fakeWorker>[0] = {}): Rig {
  resetWorkerProbeForTest();
  const clock = timers();
  const r: Rig = {
    worker: fakeWorker(options),
    clock,
    made: 0,
    probe: () =>
      runWorkerProbe({
        makeWorker: () => {
          r.made += 1;
          return r.worker;
        },
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
      }),
  };
  return r;
}

test("pending before any probe, and while one is in flight", async () => {
  resetWorkerProbeForTest();
  assert.equal(workerProbeResult(), "pending");
  const r = rig();
  const p = r.probe();
  assert.equal(workerProbeResult(), "pending");
  r.worker.emit(initAck);
  assert.equal(workerProbeResult(), "pending", "initAck alone is not a pass");
  assert.equal((await peek(p)).settled, false);
  r.worker.emit(heartbeat());
  assert.equal(await settled(p), "pass");
  assert.equal(workerProbeResult(), "pass");
});

test("pass needs initAck AND an rte=function heartbeat, in either order", async () => {
  for (const order of ["ack-first", "heartbeat-first"] as const) {
    const r = rig();
    const p = r.probe();
    if (order === "ack-first") {
      r.worker.emit(initAck);
      r.worker.emit(heartbeat());
    } else {
      r.worker.emit(heartbeat());
      assert.equal((await peek(p)).settled, false, `${order}: heartbeat alone`);
      r.worker.emit(initAck);
    }
    assert.equal(await settled(p), "pass", order);
    assert.equal(r.worker.terminated, 1, `${order}: terminated once`);
    assert.equal(r.clock.pending.size, 0, `${order}: timer cleared`);
  }
});

test("a heartbeat whose rte is not 'function' fails, even after initAck", async () => {
  const bad: [string, unknown][] = [
    [
      "pre-rte patch (no field)",
      { kind: "slogaDecodeWitness", data: { participants: [] } },
    ],
    ["no RTCTransformEvent", heartbeat("undefined")],
    ["object", heartbeat("object")],
    ["boolean true", heartbeat(true)],
    ["no data", { kind: "slogaDecodeWitness" }],
    ["data not a record", { kind: "slogaDecodeWitness", data: "function" }],
  ];
  for (const [label, message] of bad) {
    const r = rig();
    const p = r.probe();
    r.worker.emit(initAck);
    r.worker.emit(message);
    const seen = await peek(p);
    assert.equal(
      seen.settled,
      true,
      `${label}: settles at once, not by timeout`,
    );
    assert.equal(seen.value, "fail", label);
    // A later good heartbeat cannot rescue it.
    r.worker.emit(heartbeat());
    assert.equal(workerProbeResult(), "fail", label);
    assert.equal(r.worker.terminated, 1, `${label}: terminated`);
  }
});

test("the timeout fails a probe that is missing either reply", async () => {
  for (const sent of [[], [initAck], [heartbeat()]] as unknown[][]) {
    const r = rig();
    const p = r.probe();
    for (const m of sent) r.worker.emit(m);
    assert.equal(r.clock.pending.size, 1, "one timer scheduled");
    const [{ ms }] = [...r.clock.pending.values()];
    assert.equal(ms, WORKER_PROBE_TIMEOUT_MS);
    assert.equal(WORKER_PROBE_TIMEOUT_MS, 5_000);
    r.clock.fireAll();
    const seen = await peek(p);
    assert.equal(seen.settled, true, `timeout settles (${sent.length} sent)`);
    assert.equal(seen.value, "fail");
    assert.equal(r.worker.terminated, 1);
    // Replies that arrive after the timeout change nothing.
    r.worker.emit(initAck);
    r.worker.emit(heartbeat());
    assert.equal(workerProbeResult(), "fail");
  }
});

test("timeoutMs is honored, and a bad value fails without a worker", async () => {
  const r = rig();
  void runWorkerProbe({
    makeWorker: () => r.worker,
    setTimeout: r.clock.setTimeout,
    clearTimeout: r.clock.clearTimeout,
    timeoutMs: 1_234,
  });
  assert.deepEqual(
    [...r.clock.pending.values()].map((t) => t.ms),
    [1_234],
  );

  for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const b = rig();
    const result = await settled(
      runWorkerProbe({
        makeWorker: () => {
          b.made += 1;
          return b.worker;
        },
        setTimeout: b.clock.setTimeout,
        clearTimeout: b.clock.clearTimeout,
        timeoutMs,
      }),
    );
    assert.equal(result, "fail", `timeoutMs ${timeoutMs}`);
    assert.equal(b.made, 0, `timeoutMs ${timeoutMs}: no worker built`);
    assert.equal(workerProbeResult(), "fail");
  }
});

test("an error event, or livekit's error reply, fails the probe", async () => {
  const viaEvent = rig();
  const p1 = viaEvent.probe();
  viaEvent.worker.emit(initAck);
  viaEvent.worker.error();
  assert.equal((await peek(p1)).value, "fail");
  assert.equal(viaEvent.worker.terminated, 1);
  assert.equal(viaEvent.clock.pending.size, 0);

  const viaReply = rig();
  const p2 = viaReply.probe();
  viaReply.worker.emit(heartbeat());
  viaReply.worker.emit({ kind: "error", data: { error: new Error("x") } });
  assert.equal((await peek(p2)).value, "fail");
  assert.equal(viaReply.worker.terminated, 1);
});

test("a makeWorker throw fails, is cached, and leaves no timer", async () => {
  resetWorkerProbeForTest();
  const clock = timers();
  let made = 0;
  const deps = {
    makeWorker: (): ProbeWorker => {
      made += 1;
      throw new Error("SecurityError");
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  };
  assert.equal(await settled(runWorkerProbe(deps)), "fail");
  assert.equal(workerProbeResult(), "fail");
  assert.equal(clock.pending.size, 0);
  assert.equal(await settled(runWorkerProbe(deps)), "fail");
  assert.equal(made, 1, "a failed probe is not retried");
});

test("a postMessage throw fails and still terminates the worker", async () => {
  const r = rig({ throwOnPost: true });
  assert.equal(await settled(r.probe()), "fail");
  assert.equal(r.worker.terminated, 1);
  assert.equal(r.clock.pending.size, 0);
});

test("a worker that answers synchronously inside postMessage still passes once", async () => {
  const r = rig({
    onPost: (w) => {
      w.emit(initAck);
      w.emit(heartbeat());
    },
  });
  assert.equal(await settled(r.probe()), "pass");
  assert.equal(r.worker.terminated, 1);
  assert.equal(r.clock.pending.size, 0);
  assert.equal(await settled(r.probe()), "pass");
  assert.equal(r.made, 1);
});

test("posts exactly livekit's init with Sloga's key-provider options, never a key", async () => {
  const r = rig();
  const p = r.probe();
  r.worker.emit(initAck);
  r.worker.emit(heartbeat());
  assert.equal(await settled(p), "pass");
  // The literal, not the module's constant: the spec pins the wire shape.
  assert.deepEqual(r.worker.posted, [
    {
      kind: "init",
      data: {
        keyProviderOptions: {
          sharedKey: false,
          ratchetSalt: "LKFrameEncryptionKey",
          ratchetWindowSize: 0,
          failureTolerance: 0,
          keyringSize: 16,
        },
        loglevel: 3,
      },
    },
  ]);
});

test("the init carries what MlsKeyProvider hands livekit's E2EEManager", async () => {
  // `E2EEManager.setup` posts `keyProvider.getOptions()`; the probe must post
  // the same object a real Sloga call's worker receives.
  const r = rig();
  const p = r.probe();
  r.worker.emit(initAck);
  r.worker.emit(heartbeat());
  assert.equal(await settled(p), "pass");
  const [init] = r.worker.posted as {
    data: { keyProviderOptions: unknown };
  }[];
  assert.deepEqual(
    init.data.keyProviderOptions,
    new MlsKeyProvider().getOptions(),
  );
});

test("one in-flight probe; the settled result is cached for the app's life", async () => {
  const r = rig();
  const a = r.probe();
  const b = r.probe();
  assert.equal(a, b, "concurrent callers share one promise");
  assert.equal(r.made, 1);
  r.worker.emit(initAck);
  r.worker.emit(heartbeat());
  assert.equal(await settled(a), "pass");
  assert.equal(await settled(r.probe()), "pass");
  assert.equal(r.made, 1, "no second worker after a pass");
  assert.equal(r.worker.posted.length, 1);

  const f = rig();
  const fp = f.probe();
  f.clock.fireAll();
  assert.equal(await settled(fp), "fail");
  assert.equal(await settled(f.probe()), "fail");
  assert.equal(f.made, 1, "no second worker after a fail");
});

test("a probe from before a reset cannot write the new cache", async () => {
  const old = rig();
  const stale = old.probe();
  resetWorkerProbeForTest();
  assert.equal(workerProbeResult(), "pending");
  old.worker.emit(initAck);
  old.worker.emit(heartbeat());
  assert.equal(await settled(stale), "pass");
  assert.equal(workerProbeResult(), "pending", "stale pass not cached");
  assert.equal(old.worker.terminated, 1, "but its worker is still terminated");
});

// ---- the real pinned livekit worker -------------------------------------

/**
 * The pinned worker bundle, found the way Vite finds it for
 * `livekit-client/e2ee-worker?worker` (the "import" condition).
 */
const workerUrl = import.meta.resolve("livekit-client/e2ee-worker");
const workerSource = readFileSync(fileURLToPath(workerUrl), "utf8");

test("the kinds and init fields this probe uses are the pinned worker's", () => {
  assert.match(workerUrl, /livekit-client\.e2ee\.worker\.mjs$/);
  assert.ok(workerSource.includes("case 'init':"), "init case");
  assert.ok(workerSource.includes("kind: 'initAck'"), "initAck reply");
  assert.ok(workerSource.includes("data.keyProviderOptions"), "reads options");
  assert.ok(workerSource.includes("setLevel(data.loglevel)"), "reads loglevel");
  assert.ok(
    workerSource.includes("kind: 'slogaDecodeWitness'"),
    "the Sloga heartbeat patch is in the pinned worker",
  );
});

/** A real worker thread, wrapped as a ProbeWorker. */
interface RealWorker {
  worker: ProbeWorker;
  /** How many times the PROBE called terminate. */
  terminated: () => number;
  /** Test cleanup, not counted: the thread must not outlive its test. */
  kill: () => Promise<number>;
}

/**
 * Runs the real worker bundle in a worker thread behind the globals a browser
 * worker has (`self`, `postMessage`, `onmessage`).
 *
 * The thread is unref'd and killed after its test, so a probe that forgets to
 * terminate fails the `terminated()` assertion instead of hanging the run (the
 * bundle's heartbeat interval would keep the process alive forever).
 */
function realWorker(
  t: { after: (fn: () => Promise<unknown>) => void },
  withTransformEvent: boolean,
): RealWorker {
  const shim = `
const { parentPort } = await import("node:worker_threads");
globalThis.self = globalThis;
globalThis.postMessage = (m) => parentPort.postMessage(m);
${withTransformEvent ? "globalThis.RTCTransformEvent = function RTCTransformEvent() {};" : ""}
let handler;
Object.defineProperty(globalThis, "onmessage", {
  configurable: true,
  get: () => handler,
  set: (f) => { handler = f; },
});
parentPort.on("message", (data) => handler && handler({ data }));
await import(${JSON.stringify(workerUrl)});
`;
  const thread = new Worker(shim, { eval: true });
  thread.unref();
  const kill = () => thread.terminate();
  t.after(kill);
  let terminated = 0;
  return {
    kill,
    terminated: () => terminated,
    worker: {
      postMessage: (m) => thread.postMessage(m),
      addEventListener: (type, f) => {
        if (type === "message") thread.on("message", (data) => f({ data }));
        else thread.on("error", () => f({}));
      },
      terminate: () => {
        terminated += 1;
        void thread.terminate();
      },
    },
  };
}

test(
  "the real pinned worker acks this init (seen through the probe)",
  { timeout: 15_000 },
  async (t) => {
    resetWorkerProbeForTest();
    const real = realWorker(t, false);
    const seen: unknown[] = [];
    const started = Date.now();
    const result = await runWorkerProbe({
      makeWorker: () => ({
        ...real.worker,
        addEventListener: (type, f) =>
          real.worker.addEventListener(type, (ev) => {
            if (type === "message") seen.push(ev.data);
            f(ev);
          }),
      }),
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle),
      timeoutMs: 4_000,
    });
    const kinds = seen.map((m) => (m as { kind?: unknown }).kind);
    assert.ok(
      kinds.includes("initAck"),
      `initAck among ${JSON.stringify(kinds)}`,
    );
    // No RTCTransformEvent in this thread: with or without the `rte` patch the
    // heartbeat cannot say "function", so the probe fails on the heartbeat,
    // well before its timeout.
    assert.equal(result, "fail");
    assert.ok(
      Date.now() - started < 3_500,
      "failed on the heartbeat, not the timeout",
    );
    assert.equal(real.terminated(), 1);
  },
);

test(
  "the real pinned worker passes once it reports rte",
  { timeout: 15_000 },
  async (t) => {
    if (!/rte:\s*typeof self\.RTCTransformEvent/.test(workerSource)) {
      t.skip("installed worker predates the rte heartbeat field (C-W3-1 #5)");
      return;
    }
    resetWorkerProbeForTest();
    const real = realWorker(t, true);
    const result = await runWorkerProbe({
      makeWorker: () => real.worker,
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle),
      timeoutMs: 4_000,
    });
    assert.equal(result, "pass");
    assert.equal(real.terminated(), 1);
  },
);
