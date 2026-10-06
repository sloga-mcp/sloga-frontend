// Unit spec for the E2EE post-delivery settle — run with Node's built-in
// runner:
//   node --conditions=browser --test components/client/e2eeSendSettle.test.ts
// (pure functions, so the browser condition is not load-bearing here — it is
// kept so one invocation can cover the reactive suites beside it.)
// Focus: once the server has accepted the ciphertext, the send resolves with
// the echo no matter which bookkeeping step throws (a rejection there meant a
// duplicate encrypted copy on Retry), never with null (Channel.ts reads null
// as "send plaintext"); the "Not delivered" marker and the mode refresh still
// run, in today's order; and the log sees an error name only — never the
// error object, the receipts or the message content.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type SettleDeps,
  allUndelivered,
  errorName,
  settleDelivered,
} from "./e2eeSendSettle.ts";

/** Stands in for message text / user ids; must never reach the log. */
const SENTINEL = "SENTINEL-c0ntent-01HZXUSERID";

interface Echo {
  id: string;
  content: string;
}

type Step = "inject" | "receipts" | "marker" | "refresh" | "sync";

interface Harness {
  deps: SettleDeps<Echo>;
  echo: Echo;
  calls: Step[];
  logs: unknown[][];
}

/** An error carrying the sentinel in its message, with a safe name. */
function failure(name: string): Error {
  const e = new Error(`native store failed for ${SENTINEL}`);
  e.name = name;
  return e;
}

function harness(
  opts: {
    receipts?: unknown;
    throwOn?: Partial<Record<Step, "sync" | "async">>;
  } = {},
): Harness {
  const echo: Echo = { id: "01HZMESSAGE", content: SENTINEL };
  const calls: Step[] = [];
  const logs: unknown[][] = [];
  const throwOn = opts.throwOn ?? {};

  const syncStep = (step: Step) => {
    calls.push(step);
    if (throwOn[step]) throw failure(`${step}Error`);
  };
  // "sync" throws before a promise exists; "async" rejects a tick later
  const asyncStep = (step: Step): Promise<void> => {
    calls.push(step);
    if (throwOn[step] === "sync") throw failure(`${step}Error`);
    return Promise.resolve().then(() => {
      if (throwOn[step] === "async") throw failure(`${step}Error`);
    });
  };

  const deps: SettleDeps<Echo> = {
    inject() {
      syncStep("inject");
      return echo;
    },
    receipts: opts.receipts ?? [{ status: "Queued", device: SENTINEL }],
    handleReceipts: () => asyncStep("receipts"),
    refreshMode: () => asyncStep("refresh"),
    syncRecent: () => asyncStep("sync"),
    markUndelivered() {
      syncStep("marker");
    },
    log(...args: unknown[]) {
      logs.push(args);
    },
  };
  return { deps, echo, calls, logs };
}

const ALL_UNKNOWN = [
  { status: "UnknownDevice", device: SENTINEL },
  { status: "UnknownDevice", device: "dev-2" },
];

/** Today's visible order: echo, receipts, marker, mode refresh, sync. */
const FULL_ORDER: Step[] = ["inject", "receipts", "marker", "refresh", "sync"];

test("(h) happy path runs inject → receipts → marker → refresh → sync", async () => {
  const h = harness({ receipts: ALL_UNKNOWN });
  const out = await settleDelivered(h.deps);
  assert.equal(out, h.echo);
  assert.deepEqual(h.calls, FULL_ORDER);
  assert.deepEqual(h.logs, []);
});

test("a delivered send with live devices gets no marker", async () => {
  const h = harness();
  const out = await settleDelivered(h.deps);
  assert.equal(out, h.echo);
  assert.deepEqual(h.calls, ["inject", "receipts", "refresh", "sync"]);
  assert.deepEqual(h.logs, []);
});

for (const mode of ["sync", "async"] as const) {
  test(`(a) receipts throw (${mode}) → resolves once with the echo, refresh still runs, log has the name only`, async () => {
    const h = harness({ throwOn: { receipts: mode } });
    let settled = 0;
    const out = await settleDelivered(h.deps).then((m) => {
      settled++;
      return m;
    });
    assert.equal(out, h.echo);
    assert.equal(settled, 1);
    assert.deepEqual(h.calls, ["inject", "receipts", "refresh", "sync"]);
    assert.deepEqual(h.logs, [["receipts", "receiptsError"]]);
  });

  test(`(b) sync throws (${mode}) → resolves with the echo`, async () => {
    const h = harness({ throwOn: { sync: mode } });
    const out = await settleDelivered(h.deps);
    assert.equal(out, h.echo);
    assert.deepEqual(h.calls, ["inject", "receipts", "refresh", "sync"]);
    assert.deepEqual(h.logs, [["sync", "syncError"]]);
  });

  test(`refresh throws (${mode}) → sync still runs and the echo resolves`, async () => {
    const h = harness({ throwOn: { refresh: mode } });
    const out = await settleDelivered(h.deps);
    assert.equal(out, h.echo);
    assert.deepEqual(h.calls, ["inject", "receipts", "refresh", "sync"]);
    assert.deepEqual(h.logs, [["refresh", "refreshError"]]);
  });

  test(`(c) all UnknownDevice + receipts throw (${mode}) → marker still runs, after the receipts attempt`, async () => {
    const h = harness({ receipts: ALL_UNKNOWN, throwOn: { receipts: mode } });
    const out = await settleDelivered(h.deps);
    assert.equal(out, h.echo);
    assert.deepEqual(h.calls, FULL_ORDER);
    assert.deepEqual(h.logs, [["receipts", "receiptsError"]]);
  });
}

test("a marker throw is logged and refresh + sync still run", async () => {
  const h = harness({ receipts: ALL_UNKNOWN, throwOn: { marker: "sync" } });
  const out = await settleDelivered(h.deps);
  assert.equal(out, h.echo);
  assert.deepEqual(h.calls, FULL_ORDER);
  assert.deepEqual(h.logs, [["marker", "markerError"]]);
});

test("(d) an inject throw rejects, and nothing after it runs", async () => {
  const h = harness({ receipts: ALL_UNKNOWN, throwOn: { inject: "sync" } });
  await assert.rejects(settleDelivered(h.deps), { name: "injectError" });
  assert.deepEqual(h.calls, ["inject"]);
  assert.deepEqual(h.logs, []);
});

test("(e) never resolves null/undefined, whichever bookkeeping steps throw", async () => {
  const steps = ["receipts", "marker", "refresh", "sync"] as const;
  for (let mask = 0; mask < 1 << steps.length; mask++) {
    for (const mode of ["sync", "async"] as const) {
      const throwOn: Partial<Record<Step, "sync" | "async">> = {};
      steps.forEach((s, i) => {
        if (mask & (1 << i)) throwOn[s] = mode;
      });
      const h = harness({ receipts: ALL_UNKNOWN, throwOn });
      const out = await settleDelivered(h.deps);
      assert.notEqual(out, null, `mask ${mask} ${mode}`);
      assert.notEqual(out, undefined, `mask ${mask} ${mode}`);
      assert.equal(out, h.echo, `mask ${mask} ${mode}`);
      assert.deepEqual(h.calls, FULL_ORDER, `mask ${mask} ${mode}`);
    }
  }
});

test("(f) the log never sees the error object, the receipts or the content", async () => {
  const h = harness({
    receipts: ALL_UNKNOWN,
    throwOn: {
      receipts: "async",
      marker: "sync",
      refresh: "sync",
      sync: "async",
    },
  });
  await settleDelivered(h.deps);
  assert.equal(h.logs.length, 4);
  for (const args of h.logs) {
    assert.equal(args.length, 2);
    for (const arg of args) {
      assert.equal(typeof arg, "string");
      assert.ok(!String(arg).includes(SENTINEL), `leaked: ${String(arg)}`);
    }
  }
  assert.ok(!JSON.stringify(h.logs).includes(SENTINEL));
});

test("(f) a thrown string (which may carry content) logs as unknown", async () => {
  const h = harness();
  h.deps.handleReceipts = async () => {
    throw `bad receipt ${SENTINEL}`;
  };
  const out = await settleDelivered(h.deps);
  assert.equal(out, h.echo);
  assert.deepEqual(h.logs, [["receipts", "unknown"]]);
});

test("a throwing log cannot reject a delivered send", async () => {
  const h = harness({ throwOn: { receipts: "sync", sync: "async" } });
  h.deps.log = () => {
    throw new Error("console gone");
  };
  const out = await settleDelivered(h.deps);
  assert.equal(out, h.echo);
  assert.deepEqual(h.calls, ["inject", "receipts", "refresh", "sync"]);
});

test("(g) allUndelivered: only a non-empty, all-UnknownDevice array", () => {
  assert.equal(allUndelivered([{ status: "UnknownDevice" }]), true);
  assert.equal(allUndelivered(ALL_UNKNOWN), true);
  assert.equal(allUndelivered([]), false);
  assert.equal(allUndelivered(undefined), false);
  assert.equal(allUndelivered(null), false);
  assert.equal(allUndelivered("UnknownDevice"), false);
  assert.equal(allUndelivered({ status: "UnknownDevice" }), false);
  assert.equal(
    allUndelivered({ 0: { status: "UnknownDevice" }, length: 1 }),
    false,
  );
  assert.equal(
    allUndelivered([{ status: "UnknownDevice" }, { status: "Queued" }]),
    false,
  );
  assert.equal(
    allUndelivered([{ status: "UnknownDevice" }, { status: "QueueFull" }]),
    false,
  );
  assert.equal(allUndelivered([{ status: "QueueFull" }]), false);
  assert.equal(allUndelivered([{ status: "unknowndevice" }]), false);
  assert.equal(allUndelivered([{ status: "UnknownDevice" }, null]), false);
  assert.equal(allUndelivered([{}]), false);
  assert.equal(allUndelivered([null]), false);
});

test("errorName: type, then name, string-only, capped at 64", () => {
  assert.equal(errorName({ type: "StoreError", name: "Error" }), "StoreError");
  assert.equal(errorName(new TypeError("x")), "TypeError");
  assert.equal(errorName({ type: 42, name: "Error" }), "unknown");
  assert.equal(errorName({ name: { nested: SENTINEL } }), "unknown");
  assert.equal(errorName(`thrown ${SENTINEL}`), "unknown");
  assert.equal(errorName(null), "unknown");
  assert.equal(errorName(undefined), "unknown");
  assert.equal(errorName(7), "unknown");
  assert.equal(errorName({}), "unknown");
  assert.equal(errorName({ type: "x".repeat(200) }), "x".repeat(64));
  const hostile = {
    get type(): string {
      throw new Error("getter");
    },
  };
  assert.equal(errorName(hostile), "unknown");
});
