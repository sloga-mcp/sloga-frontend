// Specs for the translation transport policy — run with Node's built-in runner:
//   node --test components/common/lib/translation.test.ts
//
// Each spec builds its own translator around a scripted fetch, so the policy
// (timeout, concurrency, circuit breaker, retry) is exercised without a
// network. Timers and the clock are Node's mocks; specs that advance time
// enable them BEFORE constructing anything.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createTranslator } from "./translation.ts";

/** A resolved gtx-shaped response. */
function gtxResponse(trans: string, src: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ sentences: [{ trans }], src }),
  } as unknown as Response;
}

function statusResponse(status: number): Response {
  return { ok: false, status } as unknown as Response;
}

interface ScriptedCall {
  body: string;
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
}

/**
 * A fetch the spec answers by hand. Honors the abort signal the way the real
 * one does: rejecting with an AbortError DOMException.
 */
function scriptedFetch() {
  const calls: ScriptedCall[] = [];
  const fn: typeof fetch = (_input, init) =>
    new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("The operation was aborted.", "AbortError")),
      );
      calls.push({ body: String(init?.body), resolve, reject });
    });
  return { fn, calls };
}

/** Let promise reactions queued by the code under test run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("translates: posts the text and returns the translation", async () => {
  const { fn, calls } = scriptedFetch();
  const translator = createTranslator(fn);

  const pending = translator.translateText("good morning", "es");
  await settle();
  assert.equal(calls.length, 1);
  assert.match(calls[0].body, /q=good\+morning/);

  calls[0].resolve(gtxResponse("buenos días", "en"));
  assert.deepEqual(await pending, {
    text: "buenos días",
    detectedSource: "en",
  });
});

test("resolves null when the text is already in the target language", async () => {
  const { fn, calls } = scriptedFetch();
  const translator = createTranslator(fn);

  const pending = translator.translateText("hello", "en");
  await settle();
  calls[0].resolve(gtxResponse("hello", "en"));
  assert.equal(await pending, null);
});

test("empty and oversized text never reach the network", async () => {
  const { fn, calls } = scriptedFetch();
  const translator = createTranslator(fn);

  assert.equal(await translator.translateText("   ", "es"), null);
  assert.equal(await translator.translateText("x".repeat(4001), "es"), null);
  assert.equal(calls.length, 0);
});

test("concurrent identical requests share one fetch", async () => {
  const { fn, calls } = scriptedFetch();
  const translator = createTranslator(fn);

  const first = translator.translateText("hello", "fr");
  const second = translator.translateText("hello", "fr");
  await settle();
  assert.equal(calls.length, 1);

  calls[0].resolve(gtxResponse("bonjour", "en"));
  assert.deepEqual(await first, await second);
});

test("at most two requests fly at once; the rest queue in order", async () => {
  const { fn, calls } = scriptedFetch();
  const translator = createTranslator(fn);

  const results = ["one", "two", "three", "four"].map((text) =>
    translator.translateText(text, "de"),
  );
  await settle();
  // Two in flight, two waiting.
  assert.equal(calls.length, 2);

  calls[0].resolve(gtxResponse("eins", "en"));
  await settle();
  // Finishing one admits exactly the next in line.
  assert.equal(calls.length, 3);
  assert.match(calls[2].body, /q=three/);

  calls[1].resolve(gtxResponse("zwei", "en"));
  calls[2].resolve(gtxResponse("drei", "en"));
  await settle();
  assert.equal(calls.length, 4);
  calls[3].resolve(gtxResponse("vier", "en"));

  assert.deepEqual(
    (await Promise.all(results)).map((r) => r?.text),
    ["eins", "zwei", "drei", "vier"],
  );
});

test("a 429 opens the circuit: instant nulls, no requests, then recovery", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { fn, calls } = scriptedFetch();
  const translator = createTranslator(fn);

  const refused = translator.translateText("first", "es");
  await settle();
  calls[0].resolve(statusResponse(429));
  assert.equal(await refused, null);

  // During the cooldown nothing goes out — the fallback shows immediately.
  // Asserted on the call count BEFORE awaiting: if a request incorrectly went
  // out, awaiting it against a scripted fetch would hang instead of failing.
  const duringCooldown = translator.translateText("second", "es");
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(await duringCooldown, null);

  // After the cooldown the next render tries again, and succeeds.
  t.mock.timers.tick(30_001);
  const recovered = translator.translateText("second", "es");
  await settle();
  assert.equal(calls.length, 2);
  calls[1].resolve(gtxResponse("segundo", "en"));
  assert.deepEqual(await recovered, { text: "segundo", detectedSource: "en" });
});

test("a rate limit is never retried", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { fn, calls } = scriptedFetch();
  const translator = createTranslator(fn);

  const pending = translator.translateText("hello", "es");
  await settle();
  calls[0].resolve(statusResponse(429));
  assert.equal(await pending, null);
  assert.equal(calls.length, 1);
});

test("a hung request is aborted at the deadline and resolves null", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { fn, calls } = scriptedFetch();
  const translator = createTranslator(fn);

  const pending = translator.translateText("hello", "es");
  await settle();
  assert.equal(calls.length, 1);

  t.mock.timers.tick(7_001);
  assert.equal(await pending, null);
  // The spent time budget is not doubled by a retry.
  assert.equal(calls.length, 1);
});

test("a 5xx is retried once, after a pause", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { fn, calls } = scriptedFetch();
  const translator = createTranslator(fn);

  const pending = translator.translateText("hello", "es");
  await settle();
  calls[0].resolve(statusResponse(500));
  await settle();
  // Still waiting out the retry delay.
  assert.equal(calls.length, 1);

  t.mock.timers.tick(400);
  await settle();
  assert.equal(calls.length, 2);
  calls[1].resolve(gtxResponse("hola", "en"));
  assert.deepEqual(await pending, { text: "hola", detectedSource: "en" });
});

test("a network drop is retried once; a second drop resolves null", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { fn, calls } = scriptedFetch();
  const translator = createTranslator(fn);

  const pending = translator.translateText("hello", "es");
  await settle();
  calls[0].reject(new TypeError("network dropped"));
  await settle();
  t.mock.timers.tick(400);
  await settle();
  assert.equal(calls.length, 2);

  calls[1].reject(new TypeError("network dropped again"));
  assert.equal(await pending, null);
  assert.equal(calls.length, 2);
});

test("a failure is not cached: after the cooldown the network is asked again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { fn, calls } = scriptedFetch();
  const translator = createTranslator(fn);

  const failed = translator.translateText("hello", "es");
  await settle();
  calls[0].resolve(statusResponse(404));
  await settle();
  t.mock.timers.tick(400);
  await settle();
  calls[1].resolve(statusResponse(404));
  assert.equal(await failed, null);

  // The exhausted retry opened the circuit; the not-cached property is that
  // once it closes, the SAME text fetches again instead of replaying null.
  t.mock.timers.tick(30_001);
  const again = translator.translateText("hello", "es");
  await settle();
  assert.equal(calls.length, 3, "the failure must not be served from cache");
  calls[2].resolve(gtxResponse("hola", "en"));
  assert.deepEqual(await again, { text: "hola", detectedSource: "en" });
});

// A CORS-blocked fetch (Google's IP wall answers with a redirect the browser
// refuses) rejects with a bare TypeError — no status for the 429/403 check.
// The circuit must open anyway, or every message render fires two doomed
// requests forever (the 2026-08-16 console-spam incident).
test("a network wall opens the circuit: the next render fires nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { fn, calls } = scriptedFetch();
  const translator = createTranslator(fn);

  const walled = translator.translateText("first", "es");
  await settle();
  calls[0].reject(new TypeError("Failed to fetch"));
  await settle();
  t.mock.timers.tick(400);
  await settle();
  calls[1].reject(new TypeError("Failed to fetch"));
  assert.equal(await walled, null);

  // Circuit open: instant fallback, zero network.
  const blocked = translator.translateText("second", "es");
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(await blocked, null);

  // And it recovers once the wall might have lifted.
  t.mock.timers.tick(30_001);
  const recovered = translator.translateText("second", "es");
  await settle();
  assert.equal(calls.length, 3);
  calls[2].resolve(gtxResponse("segundo", "en"));
  assert.deepEqual(await recovered, { text: "segundo", detectedSource: "en" });
});

test("consecutive openings double the cooldown; one success resets it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { fn, calls } = scriptedFetch();
  const translator = createTranslator(fn);

  /** Fail one request through its retry with network errors. */
  const wall = async (text: string) => {
    const pending = translator.translateText(text, "es");
    await settle();
    calls[calls.length - 1].reject(new TypeError("Failed to fetch"));
    await settle();
    t.mock.timers.tick(400);
    await settle();
    calls[calls.length - 1].reject(new TypeError("Failed to fetch"));
    assert.equal(await pending, null);
  };

  await wall("first"); // opens for 30 s
  t.mock.timers.tick(30_001);
  await wall("second"); // opens for 60 s

  // 30 s in: a 30 s cooldown would have expired, the doubled one has not.
  t.mock.timers.tick(30_001);
  const blocked = translator.translateText("third", "es");
  await settle();
  assert.equal(calls.length, 4, "the doubled cooldown must still be open");
  assert.equal(await blocked, null);

  // Past 60 s: requests flow again, and one success resets the scale.
  t.mock.timers.tick(30_000);
  const recovered = translator.translateText("fourth", "es");
  await settle();
  assert.equal(calls.length, 5);
  calls[4].resolve(gtxResponse("cuarto", "en"));
  await recovered;

  await wall("fifth"); // calls 6 and 7 — opens at the BASE 30 s again
  t.mock.timers.tick(30_001);
  const afterReset = translator.translateText("sixth", "es");
  await settle();
  assert.equal(calls.length, 8, "a success must reset the cooldown scale");
  calls[7].resolve(gtxResponse("sexto", "en"));
  assert.deepEqual(await afterReset, { text: "sexto", detectedSource: "en" });
});

// A build can switch translation off (the foss Android build). Captions
// translate with a default target whether or not the settings show, so the
// gate has to hold at the network, not only in the UI.
test("switched off: resolves null and never reaches the network", async () => {
  const { fn, calls } = scriptedFetch();
  const translator = createTranslator(fn, () => false);

  // Asserted on the call count BEFORE awaiting: a request that went out
  // anyway would hang against a scripted fetch instead of failing.
  const refused = translator.translateText("hello", "es");
  await settle();
  assert.equal(calls.length, 0);
  assert.equal(await refused, null);
});

test("availability is asked on every call, not captured at construction", async () => {
  const { fn, calls } = scriptedFetch();
  let available = false;
  const translator = createTranslator(fn, () => available);

  const refused = translator.translateText("hello", "es");
  await settle();
  assert.equal(calls.length, 0);
  assert.equal(await refused, null);

  // The refused call was not cached either: the same text now fetches.
  available = true;
  const allowed = translator.translateText("hello", "es");
  await settle();
  assert.equal(calls.length, 1);
  calls[0].resolve(gtxResponse("hola", "en"));
  assert.deepEqual(await allowed, { text: "hola", detectedSource: "en" });
});

test("switched off after a success: the cached answer is not served", async () => {
  const { fn, calls } = scriptedFetch();
  let available = true;
  const translator = createTranslator(fn, () => available);

  const first = translator.translateText("hello", "es");
  await settle();
  calls[0].resolve(gtxResponse("hola", "en"));
  assert.deepEqual(await first, { text: "hola", detectedSource: "en" });

  available = false;
  assert.equal(await translator.translateText("hello", "es"), null);
  assert.equal(calls.length, 1);
});
