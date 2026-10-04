// Unit spec for the "Support Sloga" dialog flow — run with Node's built-in
// runner:
//   node --conditions=browser --test components/modal/modals/supportSlogaFlow.test.ts
//
// `--conditions=browser` is required: without it Node resolves solid-js to its
// server build, where resources never load.
//
// This exists because of a steward finding: in Solid 1.9 reading an errored
// resource THROWS, and the dialog read the code outside its error branch. When
// the POST failed (offline, 401, 429, Ko-fi not configured) the spinner never
// ended, the main button threw on click and "Open Ko-fi" did nothing.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createRoot } from "solid-js";

import { createSupportSlogaFlow } from "./supportSlogaFlow.ts";

type Code = { code: string; expires_at: number };

/** Let the resource settle and Solid flush before asserting. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
});

afterEach(async () => {
  await flush();
  process.off("unhandledRejection", onUnhandled);
  assert.deepEqual(unhandled, [], "no unhandled rejection");
});

/**
 * Run the flow with recording fakes. `clipboard` decides what the clipboard
 * write does: resolve, reject, or throw synchronously.
 */
function setup(
  fetchCode: () => Promise<Code>,
  clipboard: "ok" | "reject" | "throw" = "ok",
) {
  const calls: string[] = [];
  let dispose = () => {};
  const flow = createRoot((d) => {
    dispose = d;
    return createSupportSlogaFlow<Code>({
      fetchCode,
      writeClipboard(value) {
        calls.push(`copy:${value}`);
        if (clipboard === "throw") {
          throw new TypeError("navigator.clipboard is undefined");
        }
        return clipboard === "ok"
          ? Promise.resolve()
          : Promise.reject(new Error("NotAllowedError"));
      },
      openKofi: () => calls.push("open"),
      close: () => calls.push("close"),
    });
  });
  return { flow, calls, dispose };
}

const rejected = () => Promise.reject(new Error("offline"));
const resolved = () =>
  Promise.resolve({ code: "SLOGA-1234", expires_at: Date.UTC(2026, 9, 10) });

test("a failed fetch leaves the error set and the value empty, without throwing", async () => {
  const { flow, dispose } = setup(rejected);
  await flush();

  assert.equal(flow.code.loading, false, "the spinner ends");
  assert.ok(flow.code.error instanceof Error, "the error branch shows");
  assert.equal(flow.value(), undefined, "the guarded read does not throw");
  // Positive control: the unguarded read the old dialog made throws here
  assert.throws(() => flow.code());
  dispose();
});

test("a failed fetch still opens Ko-fi from the main button, without a code", async () => {
  const { flow, calls, dispose } = setup(rejected);
  await flush();

  await flow.copyAndOpen();

  assert.deepEqual(calls, ["open", "close"]);
  dispose();
});

test("donating without a code opens Ko-fi and closes", async () => {
  const { flow, calls, dispose } = setup(resolved);
  await flush();

  flow.donateWithoutCode();

  assert.deepEqual(calls, ["open", "close"]);
  dispose();
});

test("while loading the value is empty", async () => {
  let release: (code: Code) => void = () => {};
  const { flow, dispose } = setup(
    () => new Promise<Code>((resolve) => (release = resolve)),
  );

  assert.equal(flow.code.loading, true);
  assert.equal(flow.value(), undefined);

  release({ code: "SLOGA-1234", expires_at: 0 });
  await flush();
  assert.equal(flow.value()?.code, "SLOGA-1234");
  dispose();
});

test("the happy path copies the code before Ko-fi opens, then closes", async () => {
  const { flow, calls, dispose } = setup(resolved);
  await flush();

  assert.equal(flow.value()?.code, "SLOGA-1234");
  await flow.copyAndOpen();

  assert.deepEqual(calls, ["copy:SLOGA-1234", "open", "close"]);
  assert.equal(flow.copyFailed(), false);
  dispose();
});

test("the clipboard write starts synchronously, in the click's tick", async () => {
  const { flow, calls, dispose } = setup(resolved);
  await flush();

  const pending = flow.copyAndOpen();
  // Nothing awaited yet: the copy and the window.open already ran
  assert.deepEqual(calls, ["copy:SLOGA-1234", "open"]);
  await pending;
  dispose();
});

test("a refused clipboard write still opens Ko-fi and keeps the dialog open", async () => {
  const { flow, calls, dispose } = setup(resolved, "reject");
  await flush();

  await flow.copyAndOpen();

  assert.deepEqual(calls, ["copy:SLOGA-1234", "open"]);
  assert.equal(flow.copyFailed(), true);
  dispose();
});

test("a missing clipboard (insecure context) still opens Ko-fi and keeps the dialog open", async () => {
  const { flow, calls, dispose } = setup(resolved, "throw");
  await flush();

  await flow.copyAndOpen();

  assert.deepEqual(calls, ["copy:SLOGA-1234", "open"]);
  assert.equal(flow.copyFailed(), true);
  dispose();
});

test("copying again after a failure clears the failure", async () => {
  let ok = false;
  const calls: string[] = [];
  const flow = createRoot(() =>
    createSupportSlogaFlow<Code>({
      fetchCode: resolved,
      writeClipboard: () =>
        ok ? Promise.resolve() : Promise.reject(new Error("NotAllowedError")),
      openKofi: () => calls.push("open"),
      close: () => calls.push("close"),
    }),
  );
  await flush();

  assert.equal(await flow.copy("SLOGA-1234"), false);
  assert.equal(flow.copyFailed(), true);
  ok = true;
  assert.equal(await flow.copy("SLOGA-1234"), true);
  assert.equal(flow.copyFailed(), false);
});
