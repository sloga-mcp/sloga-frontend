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
  queuedReceiptId,
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

// noteDelivered: the conversation-list hook the send path supplies. It runs
// once, after a successful echo and before receipts, with the server's id
// for the send (the first Queued receipt's envelope id, or undefined), and
// it is best-effort like every other step after the echo.

/** The server's envelope id on the first Queued receipt in MIXED. */
const QUEUED_ID = "01JABCDEFGHJKMNPQRSTVWXYZ0";

/** A mixed fan-out: one dead device, one full queue, two queued copies. */
const MIXED = [
  { status: "UnknownDevice", device: SENTINEL },
  { status: "QueueFull", device: "dev-2" },
  { status: "Queued", id: QUEUED_ID, device: "dev-3" },
  { status: "Queued", id: "01JSECONDSECONDSECONDSECON", device: "dev-4" },
];

/** Receipts that carry no usable server id for the send. */
const NO_QUEUED_ID: unknown[] = [
  [],
  undefined,
  null,
  "Queued",
  { status: "Queued", id: QUEUED_ID },
  { 0: { status: "Queued", id: QUEUED_ID }, length: 1 },
  ALL_UNKNOWN,
  [{ status: "UnknownDevice" }, { status: "QueueFull" }],
  [{ status: "Queued" }],
  [{ status: "Queued", id: 42 }],
  [{ status: "Queued", id: "" }],
  [{ status: "Queued", id: null }],
  [{ status: "queued", id: QUEUED_ID }],
  [{ id: QUEUED_ID }],
  [null],
  // the FIRST Queued receipt decides; a later good id is not used
  [null, { status: "Queued", id: 7 }, { status: "Queued", id: QUEUED_ID }],
];

interface Note {
  /** Arguments of each noteDelivered call. */
  args: unknown[][];
  /** The steps already run at each noteDelivered call. */
  seen: Step[][];
}

/** Gives `h` a recording noteDelivered that can throw or reject. */
function withNote(h: Harness, mode?: "sync" | "async"): Note {
  const note: Note = { args: [], seen: [] };
  h.deps.noteDelivered = (...args) => {
    note.args.push(args);
    note.seen.push([...h.calls]);
    if (mode === "sync") throw failure("noteError");
    // a promise is outside the void contract, but its rejection is caught too
    return mode === "async" ? Promise.reject(failure("noteError")) : undefined;
  };
  return note;
}

/** Lets an uncaught rejection surface (Node reports it after microtasks). */
const tick = () => new Promise((r) => setTimeout(r, 0));

test("noteDelivered runs once, after inject and before receipts, with the echo and the first Queued id", async () => {
  const h = harness({ receipts: MIXED });
  const note = withNote(h);
  const out = await settleDelivered(h.deps);
  assert.equal(out, h.echo);
  assert.equal(note.args.length, 1);
  assert.equal(note.args[0].length, 2);
  assert.equal(note.args[0][0], h.echo);
  assert.equal(note.args[0][1], QUEUED_ID);
  assert.deepEqual(note.seen, [["inject"]]);
  assert.deepEqual(h.calls, ["inject", "receipts", "refresh", "sync"]);
  assert.deepEqual(h.logs, []);
});

test("noteDelivered with zero live devices gets undefined, and the marker still runs", async () => {
  const h = harness({ receipts: ALL_UNKNOWN });
  const note = withNote(h);
  const out = await settleDelivered(h.deps);
  assert.equal(out, h.echo);
  assert.deepEqual(note.args, [[h.echo, undefined]]);
  assert.deepEqual(note.seen, [["inject"]]);
  assert.deepEqual(h.calls, FULL_ORDER);
  assert.deepEqual(h.logs, []);
});

test("queuedReceiptId: the first Queued receipt's non-empty string id, else undefined", () => {
  assert.equal(queuedReceiptId(MIXED), QUEUED_ID);
  assert.equal(
    queuedReceiptId([{ status: "Queued", id: QUEUED_ID }]),
    QUEUED_ID,
  );
  assert.equal(
    queuedReceiptId([
      null,
      { status: "QueueFull" },
      { status: "Queued", id: QUEUED_ID },
    ]),
    QUEUED_ID,
  );
  for (const receipts of NO_QUEUED_ID) {
    assert.equal(
      queuedReceiptId(receipts),
      undefined,
      JSON.stringify(receipts),
    );
  }
});

test("noteDelivered gets undefined when the receipts carry no usable Queued id", async () => {
  for (const receipts of NO_QUEUED_ID) {
    const h = harness();
    h.deps.receipts = receipts;
    const note = withNote(h);
    const out = await settleDelivered(h.deps);
    const label = JSON.stringify(receipts);
    assert.equal(out, h.echo, label);
    assert.deepEqual(note.args, [[h.echo, undefined]], label);
    assert.deepEqual(h.logs, [], label);
  }
});

for (const mode of ["sync", "async"] as const) {
  test(`noteDelivered throws (${mode}) -> resolves once with the echo; receipts, marker, refresh, sync still run; log has the name only`, async () => {
    let unhandled = 0;
    const onUnhandled = () => {
      unhandled++;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const h = harness({ receipts: ALL_UNKNOWN });
      const note = withNote(h, mode);
      let settled = 0;
      const out = await settleDelivered(h.deps).then((m) => {
        settled++;
        return m;
      });
      await tick();
      assert.equal(out, h.echo);
      assert.equal(settled, 1);
      assert.equal(note.args.length, 1);
      assert.deepEqual(h.calls, FULL_ORDER);
      assert.deepEqual(h.logs, [["note", "noteError"]]);
      assert.ok(!JSON.stringify(h.logs).includes(SENTINEL));
      assert.equal(unhandled, 0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
}

test("noteDelivered throws and any mix of later steps throws: still the echo, full order, every step logged", async () => {
  const steps = ["receipts", "marker", "refresh", "sync"] as const;
  for (const noteMode of ["sync", "async"] as const) {
    for (let mask = 0; mask < 1 << steps.length; mask++) {
      for (const mode of ["sync", "async"] as const) {
        const throwOn: Partial<Record<Step, "sync" | "async">> = {};
        steps.forEach((s, i) => {
          if (mask & (1 << i)) throwOn[s] = mode;
        });
        const h = harness({ receipts: ALL_UNKNOWN, throwOn });
        withNote(h, noteMode);
        const out = await settleDelivered(h.deps);
        await tick();
        const label = `note ${noteMode} mask ${mask} ${mode}`;
        assert.equal(out, h.echo, label);
        assert.deepEqual(h.calls, FULL_ORDER, label);
        const expected = [
          ["note", "noteError"],
          ...steps.filter((s) => throwOn[s]).map((s) => [s, `${s}Error`]),
        ];
        // a rejected promise is logged a microtask later, so only the set
        // of entries is fixed; a synchronous throw is logged first
        if (noteMode === "sync") assert.deepEqual(h.logs, expected, label);
        else {
          const sorted = (l: unknown[][]) => l.map((e) => e.join(":")).sort();
          assert.deepEqual(sorted(h.logs), sorted(expected), label);
        }
      }
    }
  }
});

test("a throwing receipt getter is contained in the note step", async () => {
  const h = harness();
  h.deps.receipts = [
    {
      status: "Queued",
      get id(): string {
        throw failure("getterError");
      },
    },
  ];
  const note = withNote(h);
  const out = await settleDelivered(h.deps);
  assert.equal(out, h.echo);
  assert.equal(note.args.length, 0);
  assert.deepEqual(h.logs, [["note", "getterError"]]);
  assert.deepEqual(h.calls, ["inject", "receipts", "refresh", "sync"]);
});

test("an inject throw rejects and noteDelivered is never called", async () => {
  const h = harness({ receipts: MIXED, throwOn: { inject: "sync" } });
  const note = withNote(h);
  await assert.rejects(settleDelivered(h.deps), { name: "injectError" });
  assert.equal(note.args.length, 0);
  assert.deepEqual(h.calls, ["inject"]);
  assert.deepEqual(h.logs, []);
});

test("absent noteDelivered: the settle behaves exactly as before, across throw masks", async () => {
  const steps = ["inject", "receipts", "marker", "refresh", "sync"] as const;
  // [receipts, whether the marker runs]; written out, not derived
  const receiptSets: [unknown, boolean][] = [
    [undefined, false],
    [[], false],
    [MIXED, false],
    [ALL_UNKNOWN, true],
  ];
  let compared = 0;
  for (const [receipts, marker] of receiptSets) {
    for (let mask = 0; mask < 1 << steps.length; mask++) {
      for (const mode of ["sync", "async"] as const) {
        for (const absent of ["missing", "undefined"] as const) {
          const throwOn: Partial<Record<Step, "sync" | "async">> = {};
          steps.forEach((s, i) => {
            if (mask & (1 << i)) throwOn[s] = mode;
          });
          const h = harness({ throwOn });
          h.deps.receipts = receipts;
          if (absent === "undefined") h.deps.noteDelivered = undefined;
          else assert.ok(!("noteDelivered" in h.deps));

          // the pre-noteDelivered behavior, independent of the module
          const ran: Step[] = throwOn.inject
            ? ["inject"]
            : marker
              ? FULL_ORDER
              : ["inject", "receipts", "refresh", "sync"];
          const expected = {
            out: throwOn.inject ? "rejected:injectError" : "echo",
            calls: ran,
            logs: ran
              .filter((s) => s !== "inject" && throwOn[s])
              .map((s) => [s, `${s}Error`]),
          };

          let out: string;
          try {
            out = (await settleDelivered(h.deps)) === h.echo ? "echo" : "other";
          } catch (e) {
            out = `rejected:${(e as Error).name}`;
          }
          const label = `${JSON.stringify(receipts)} mask ${mask} ${mode} ${absent}`;
          assert.deepEqual(
            { out, calls: h.calls, logs: h.logs },
            expected,
            label,
          );
          compared++;
        }
      }
    }
  }
  assert.equal(compared, 4 * 32 * 2 * 2);
});
