// Unit spec for the server captcha lookup. Run it with Node's built-in runner
// from packages/client:
//   node --test --conditions=browser components/auth/src/flows/captchaConfig.test.ts
// Declared test count: 17 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
// Focus: the root document is read for `features.captcha`, an enabled server
// with an empty key reports no key, every kind of failure reads as disabled
// and is retried on the next call, only a success is remembered, concurrent
// callers share one request, and the sitekey resolver follows its truth table.
import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";

import {
  __resetServerCaptchaCache,
  getServerCaptcha,
  resolveSitekey,
} from "./captchaConfig.ts";

const API = "https://api.example.invalid";

/** An obviously fake sitekey; never put a real one in a fixture. */
const SITEKEY = "10000000-ffff-ffff-ffff-000000000001";

/** A root document with only the captcha feature filled in. */
function rootDocument(captcha: unknown) {
  return { revolt: "0.0.0", features: { captcha }, ws: "", app: "" };
}

/** A fetch stub that answers every call with the same JSON body. */
function jsonFetch(body: unknown, status = 200) {
  return mock.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

/** Cast a stub to `typeof fetch` for the call site. */
function asFetch(fn: unknown) {
  return fn as typeof fetch;
}

afterEach(() => {
  __resetServerCaptchaCache();
});

test("an enabled server reports its key", async () => {
  const fetchImpl = jsonFetch(rootDocument({ enabled: true, key: SITEKEY }));
  const result = await getServerCaptcha(API, asFetch(fetchImpl));
  assert.deepEqual(result, { enabled: true, key: SITEKEY });
  assert.equal(fetchImpl.mock.callCount(), 1);
  assert.equal(fetchImpl.mock.calls[0].arguments[0], `${API}/`);
});

test("a disabled server reports disabled with no key", async () => {
  const fetchImpl = jsonFetch(rootDocument({ enabled: false, key: "" }));
  const result = await getServerCaptcha(API, asFetch(fetchImpl));
  assert.deepEqual(result, { enabled: false, key: undefined });
});

test("an enabled server with an empty key reports no key", async () => {
  const fetchImpl = jsonFetch(rootDocument({ enabled: true, key: "" }));
  const result = await getServerCaptcha(API, asFetch(fetchImpl));
  assert.equal(result.enabled, true);
  assert.equal(result.key, undefined);
});

test("a non-string key is dropped", async () => {
  const fetchImpl = jsonFetch(rootDocument({ enabled: true, key: 42 }));
  const result = await getServerCaptcha(API, asFetch(fetchImpl));
  assert.deepEqual(result, { enabled: true, key: undefined });
});

test("a root document without features reads as disabled", async () => {
  const fetchImpl = jsonFetch({ revolt: "0.0.0" });
  const result = await getServerCaptcha(API, asFetch(fetchImpl));
  assert.deepEqual(result, { enabled: false, key: undefined });
});

test("a thrown fetch reads as disabled and the next call retries", async () => {
  const fetchImpl = mock.fn(async () => {
    throw new TypeError("network down");
  });
  assert.deepEqual(await getServerCaptcha(API, asFetch(fetchImpl)), {
    enabled: false,
  });
  assert.deepEqual(await getServerCaptcha(API, asFetch(fetchImpl)), {
    enabled: false,
  });
  assert.equal(fetchImpl.mock.callCount(), 2);
});

test("a fetch that throws synchronously never rejects", async () => {
  const fetchImpl = mock.fn(() => {
    throw new TypeError("bad url");
  });
  assert.deepEqual(await getServerCaptcha(API, asFetch(fetchImpl)), {
    enabled: false,
  });
});

test("a non-2xx answer reads as disabled and is not remembered", async () => {
  const failing = jsonFetch(rootDocument({ enabled: true, key: SITEKEY }), 503);
  assert.deepEqual(await getServerCaptcha(API, asFetch(failing)), {
    enabled: false,
  });

  const healthy = jsonFetch(rootDocument({ enabled: true, key: SITEKEY }));
  assert.deepEqual(await getServerCaptcha(API, asFetch(healthy)), {
    enabled: true,
    key: SITEKEY,
  });
  assert.equal(failing.mock.callCount(), 1);
  assert.equal(healthy.mock.callCount(), 1);
});

test("a body that is not JSON reads as disabled and is not remembered", async () => {
  const fetchImpl = mock.fn(
    async () =>
      new Response("<!doctype html><title>app</title>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
  );
  assert.deepEqual(await getServerCaptcha(API, asFetch(fetchImpl)), {
    enabled: false,
  });
  await getServerCaptcha(API, asFetch(fetchImpl));
  assert.equal(fetchImpl.mock.callCount(), 2);
});

test("a JSON body that is not an object is not remembered", async () => {
  const fetchImpl = jsonFetch(null);
  assert.deepEqual(await getServerCaptcha(API, asFetch(fetchImpl)), {
    enabled: false,
  });
  await getServerCaptcha(API, asFetch(fetchImpl));
  assert.equal(fetchImpl.mock.callCount(), 2);
});

test("a success is remembered across calls", async () => {
  const fetchImpl = jsonFetch(rootDocument({ enabled: true, key: SITEKEY }));
  const first = await getServerCaptcha(API, asFetch(fetchImpl));
  const second = await getServerCaptcha(API, asFetch(fetchImpl));
  assert.deepEqual(second, first);
  assert.equal(fetchImpl.mock.callCount(), 1);
});

test("a disabled answer is a success and is remembered too", async () => {
  const fetchImpl = jsonFetch(rootDocument({ enabled: false, key: "" }));
  await getServerCaptcha(API, asFetch(fetchImpl));
  await getServerCaptcha(API, asFetch(fetchImpl));
  assert.equal(fetchImpl.mock.callCount(), 1);
});

test("concurrent callers share one request", async () => {
  const fetchImpl = jsonFetch(rootDocument({ enabled: true, key: SITEKEY }));
  const [a, b] = await Promise.all([
    getServerCaptcha(API, asFetch(fetchImpl)),
    getServerCaptcha(API, asFetch(fetchImpl)),
  ]);
  assert.deepEqual(a, { enabled: true, key: SITEKEY });
  assert.deepEqual(b, a);
  assert.equal(fetchImpl.mock.callCount(), 1);
});

test("trailing slashes on the API URL are trimmed and share the cache", async () => {
  const fetchImpl = jsonFetch(rootDocument({ enabled: true, key: SITEKEY }));
  await getServerCaptcha(`${API}//`, asFetch(fetchImpl));
  await getServerCaptcha(API, asFetch(fetchImpl));
  assert.equal(fetchImpl.mock.callCount(), 1);
  assert.equal(fetchImpl.mock.calls[0].arguments[0], `${API}/`);
});

test("different API URLs are looked up separately", async () => {
  const fetchImpl = jsonFetch(rootDocument({ enabled: true, key: SITEKEY }));
  await getServerCaptcha(API, asFetch(fetchImpl));
  await getServerCaptcha(
    "https://other.example.invalid/api",
    asFetch(fetchImpl),
  );
  assert.equal(fetchImpl.mock.callCount(), 2);
  assert.equal(
    fetchImpl.mock.calls[1].arguments[0],
    "https://other.example.invalid/api/",
  );
});

test("resolveSitekey: an enabled server's key wins over the build key", () => {
  assert.equal(
    resolveSitekey({ enabled: true, key: SITEKEY }, "build-key"),
    SITEKEY,
  );
  // Enabled without a key: captcha is required but unavailable, so the build
  // key must not stand in for the server's.
  assert.equal(resolveSitekey({ enabled: true }, "build-key"), undefined);
  assert.equal(resolveSitekey({ enabled: true }, undefined), undefined);
});

test("resolveSitekey: a disabled server falls back to the build key", () => {
  assert.equal(resolveSitekey({ enabled: false }, "build-key"), "build-key");
  assert.equal(
    resolveSitekey({ enabled: false, key: SITEKEY }, "build-key"),
    "build-key",
  );
  assert.equal(resolveSitekey({ enabled: false }, undefined), undefined);
  assert.equal(resolveSitekey({ enabled: false }, ""), undefined);
});
