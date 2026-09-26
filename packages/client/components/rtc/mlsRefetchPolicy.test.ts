// Unit spec for the late-drain refetch policy — run with Node's built-in
// runner:
//   node --test --conditions=browser components/rtc/mlsRefetchPolicy.test.ts
// Focus (late-drain guard, W2-M1 / W2-M2): which thrown gap-refetch errors
// mean "this device is no longer in the group" (an anchored 404 from the MLS
// transport, nothing else), whether a freshly adopted Welcome is current,
// needs a contiguous catch-up, or must be discarded for a rejoin (every
// ambiguous input fails closed to "rejoin"), and the currency check's
// backoff schedule.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  E2EERateLimitError,
  E2EERequestTimeoutError,
} from "../client/e2eeRatelimitPolicy.ts";

import {
  WELCOME_CURRENCY_BACKOFF_MS,
  classifyRefetchFailure,
  welcomeCurrencyVerdict,
} from "./mlsRefetchPolicy.ts";

// ---- helpers ------------------------------------------------------------------

/** A 64-char lowercase hex group id, the shape the DS hands out. */
const GROUP_ID = "ab".repeat(32);

/** The exact path `mlsFetchCommits` requests (e2ee.ts `mlsFetchCommits`). */
function commitsPath(fromEpoch: number, groupId = GROUP_ID): string {
  return `/mls/groups/${groupId}/commits?from_epoch=${fromEpoch}`;
}

/**
 * The error `#apiMls` throws for a status it maps to no outcome — built
 * byte-for-byte as its final throw does (e2ee.ts, `#apiMls`):
 * `` new Error(`E2EE MLS ${method} ${path} failed: ${response.status}`) ``.
 * The 400 and 409 arms append the body's `type` after the status.
 */
function apiMlsFailure(
  method: string,
  path: string,
  status: number | string,
): Error {
  return new Error(`E2EE MLS ${method} ${path} failed: ${status}`);
}

// ---- classifyRefetchFailure: the one not-member shape ------------------------

test("the transport's 404 on the gap refetch is not_member", () => {
  assert.equal(
    classifyRefetchFailure(apiMlsFailure("GET", commitsPath(7), 404)),
    "not_member",
  );
});

test("a 404 whose path also carries a 404 is still not_member", () => {
  assert.equal(
    classifyRefetchFailure(apiMlsFailure("GET", commitsPath(404), 404)),
    "not_member",
  );
});

test("a 404 on any MLS route shape is not_member (method and path are opaque)", () => {
  assert.equal(
    classifyRefetchFailure(
      apiMlsFailure("POST", `/mls/groups/${GROUP_ID}/commits`, 404),
    ),
    "not_member",
  );
});

test("an Error subclass carrying the 404 message is not_member", () => {
  class TransportError extends Error {}
  assert.equal(
    classifyRefetchFailure(
      new TransportError(`E2EE MLS GET ${commitsPath(3)} failed: 404`),
    ),
    "not_member",
  );
});

// ---- classifyRefetchFailure: every other status is transient -----------------

test("a 403 (no ViewChannel) is transient, never not_member", () => {
  assert.equal(
    classifyRefetchFailure(apiMlsFailure("GET", commitsPath(7), 403)),
    "transient",
  );
});

test("a 500 is transient", () => {
  assert.equal(
    classifyRefetchFailure(apiMlsFailure("GET", commitsPath(7), 500)),
    "transient",
  );
});

test("a 502 and a 503 are transient", () => {
  for (const status of [502, 503]) {
    assert.equal(
      classifyRefetchFailure(apiMlsFailure("GET", commitsPath(7), status)),
      "transient",
      `status ${status}`,
    );
  }
});

test("the 400 arm's typed failure (not FeatureDisabled) is transient", () => {
  assert.equal(
    classifyRefetchFailure(
      apiMlsFailure("GET", commitsPath(7), "400 FailedValidation"),
    ),
    "transient",
  );
  assert.equal(
    classifyRefetchFailure(
      apiMlsFailure("GET", commitsPath(7), "400 bad request"),
    ),
    "transient",
  );
});

test("the transport's exhausted 429 (E2EERateLimitError) is transient", () => {
  const err = new E2EERateLimitError("GET", commitsPath(7), 4_000, 4);
  assert.equal(err.status, 429);
  assert.equal(classifyRefetchFailure(err), "transient");
});

test("the transport's request deadline (E2EERequestTimeoutError) is transient", () => {
  assert.equal(
    classifyRefetchFailure(
      new E2EERequestTimeoutError("GET", commitsPath(7), 45_000),
    ),
    "transient",
  );
});

test("a hang-up abort and a network failure are transient", () => {
  assert.equal(
    classifyRefetchFailure(
      new DOMException("This operation was aborted", "AbortError"),
    ),
    "transient",
  );
  assert.equal(
    classifyRefetchFailure(new TypeError("Failed to fetch")),
    "transient",
  );
});

// ---- classifyRefetchFailure: the match is anchored ---------------------------

test("a 404 elsewhere in the message is NOT not_member (the match is anchored)", () => {
  // The epoch in the path is 404, the status is 500.
  assert.equal(
    classifyRefetchFailure(apiMlsFailure("GET", commitsPath(404), 500)),
    "transient",
  );
  // A group id containing 404, the status is 503.
  assert.equal(
    classifyRefetchFailure(
      apiMlsFailure("GET", commitsPath(7, `404${"0".repeat(61)}`), 503),
    ),
    "transient",
  );
});

test("a status that merely starts with 404 is transient (end anchor)", () => {
  assert.equal(
    classifyRefetchFailure(apiMlsFailure("GET", commitsPath(7), 4040)),
    "transient",
  );
  assert.equal(
    classifyRefetchFailure(
      apiMlsFailure("GET", commitsPath(7), "404 NotFound"),
    ),
    "transient",
  );
});

test("a 404 message wrapped in another prefix is transient (start anchor)", () => {
  assert.equal(
    classifyRefetchFailure(
      new Error(`drain step threw: E2EE MLS GET ${commitsPath(7)} failed: 404`),
    ),
    "transient",
  );
});

test("the non-MLS E2EE transport's 404 is transient", () => {
  // e2ee.ts's other API helper words its failure `E2EE API …`.
  assert.equal(
    classifyRefetchFailure(new Error("E2EE API GET /e2ee/keys failed: 404")),
    "transient",
  );
});

test("an Error with a status 404 field but no matching message is transient", () => {
  assert.equal(
    classifyRefetchFailure(
      Object.assign(new Error("not found"), { status: 404 }),
    ),
    "transient",
  );
});

// ---- classifyRefetchFailure: non-Errors are transient -------------------------

test("a non-Error carrying the exact 404 text is transient", () => {
  const text = `E2EE MLS GET ${commitsPath(7)} failed: 404`;
  assert.equal(classifyRefetchFailure(text), "transient");
  assert.equal(classifyRefetchFailure({ message: text }), "transient");
});

test("null, undefined and a bare status number are transient", () => {
  assert.equal(classifyRefetchFailure(null), "transient");
  assert.equal(classifyRefetchFailure(undefined), "transient");
  assert.equal(classifyRefetchFailure(404), "transient");
});

// ---- welcomeCurrencyVerdict --------------------------------------------------

/** The session's `LAG_DESYNC_THRESHOLD` (mlsCallSession.ts) — the realistic limit. */
const LAG_LIMIT = 12;

/** Contiguous commit stubs for epochs `from..to` inclusive, frozen. */
function commitsFor(from: number, to: number): readonly { epoch: number }[] {
  const out: { epoch: number }[] = [];
  for (let epoch = from; epoch <= to; epoch++) out.push({ epoch });
  return Object.freeze(out.map((c) => Object.freeze(c)));
}

test("DS at the Welcome's epoch with no commits: current", () => {
  assert.equal(
    welcomeCurrencyVerdict({
      welcomeEpoch: 5,
      currentEpoch: 5,
      commits: commitsFor(6, 5),
      lagLimit: LAG_LIMIT,
    }),
    "current",
  );
});

test("lag 0 but the DS shipped commits anyway: rejoin, never current", () => {
  assert.equal(
    welcomeCurrencyVerdict({
      welcomeEpoch: 5,
      currentEpoch: 5,
      commits: commitsFor(6, 6),
      lagLimit: LAG_LIMIT,
    }),
    "rejoin",
  );
});

test("DS behind the Welcome's epoch (a stale or rolled-back answer): rejoin", () => {
  assert.equal(
    welcomeCurrencyVerdict({
      welcomeEpoch: 5,
      currentEpoch: 4,
      commits: commitsFor(6, 5),
      lagLimit: LAG_LIMIT,
    }),
    "rejoin",
  );
});

test("DS far behind the Welcome's epoch: rejoin", () => {
  assert.equal(
    welcomeCurrencyVerdict({
      welcomeEpoch: 40,
      currentEpoch: 0,
      commits: commitsFor(1, 0),
      lagLimit: LAG_LIMIT,
    }),
    "rejoin",
  );
});

test("lag 1 with its one contiguous commit: catch_up", () => {
  assert.equal(
    welcomeCurrencyVerdict({
      welcomeEpoch: 5,
      currentEpoch: 6,
      commits: commitsFor(6, 6),
      lagLimit: LAG_LIMIT,
    }),
    "catch_up",
  );
});

test("lag at lagLimit - 1 with contiguous commits: catch_up", () => {
  assert.equal(
    welcomeCurrencyVerdict({
      welcomeEpoch: 5,
      currentEpoch: 5 + LAG_LIMIT - 1,
      commits: commitsFor(6, 5 + LAG_LIMIT - 1),
      lagLimit: LAG_LIMIT,
    }),
    "catch_up",
  );
});

test("lag exactly at lagLimit, commits contiguous: rejoin", () => {
  assert.equal(
    welcomeCurrencyVerdict({
      welcomeEpoch: 5,
      currentEpoch: 5 + LAG_LIMIT,
      commits: commitsFor(6, 5 + LAG_LIMIT),
      lagLimit: LAG_LIMIT,
    }),
    "rejoin",
  );
});

test("lag past lagLimit, commits contiguous: rejoin", () => {
  assert.equal(
    welcomeCurrencyVerdict({
      welcomeEpoch: 5,
      currentEpoch: 5 + LAG_LIMIT + 3,
      commits: commitsFor(6, 5 + LAG_LIMIT + 3),
      lagLimit: LAG_LIMIT,
    }),
    "rejoin",
  );
});

test("the limit is the caller's: lag 2 is catch_up under 3, rejoin under 2", () => {
  const base = {
    welcomeEpoch: 9,
    currentEpoch: 11,
    commits: commitsFor(10, 11),
  };
  assert.equal(welcomeCurrencyVerdict({ ...base, lagLimit: 3 }), "catch_up");
  assert.equal(welcomeCurrencyVerdict({ ...base, lagLimit: 2 }), "rejoin");
});

test("fewer commits than the lag (an ok-but-short answer): rejoin", () => {
  assert.equal(
    welcomeCurrencyVerdict({
      welcomeEpoch: 5,
      currentEpoch: 8,
      commits: commitsFor(6, 7),
      lagLimit: LAG_LIMIT,
    }),
    "rejoin",
  );
});

test("more commits than the lag: rejoin", () => {
  assert.equal(
    welcomeCurrencyVerdict({
      welcomeEpoch: 5,
      currentEpoch: 7,
      commits: commitsFor(6, 8),
      lagLimit: LAG_LIMIT,
    }),
    "rejoin",
  );
});

test("right count but a gap in the epochs: rejoin (contiguity)", () => {
  assert.equal(
    welcomeCurrencyVerdict({
      welcomeEpoch: 5,
      currentEpoch: 7,
      commits: Object.freeze([{ epoch: 6 }, { epoch: 8 }]),
      lagLimit: LAG_LIMIT,
    }),
    "rejoin",
  );
});

test("right count but out of order: rejoin (contiguity)", () => {
  assert.equal(
    welcomeCurrencyVerdict({
      welcomeEpoch: 5,
      currentEpoch: 7,
      commits: Object.freeze([{ epoch: 7 }, { epoch: 6 }]),
      lagLimit: LAG_LIMIT,
    }),
    "rejoin",
  );
});

test("right count but a duplicate epoch: rejoin (contiguity)", () => {
  assert.equal(
    welcomeCurrencyVerdict({
      welcomeEpoch: 5,
      currentEpoch: 7,
      commits: Object.freeze([{ epoch: 6 }, { epoch: 6 }]),
      lagLimit: LAG_LIMIT,
    }),
    "rejoin",
  );
});

test("right count but starting AT the Welcome's epoch, not after it: rejoin", () => {
  assert.equal(
    welcomeCurrencyVerdict({
      welcomeEpoch: 5,
      currentEpoch: 7,
      commits: commitsFor(5, 6),
      lagLimit: LAG_LIMIT,
    }),
    "rejoin",
  );
});

test("a non-finite welcomeEpoch or currentEpoch fails closed to rejoin", () => {
  for (const bad of [Number.NaN, Infinity, -Infinity]) {
    assert.equal(
      welcomeCurrencyVerdict({
        welcomeEpoch: bad,
        currentEpoch: 6,
        commits: commitsFor(6, 6),
        lagLimit: LAG_LIMIT,
      }),
      "rejoin",
      `welcomeEpoch ${bad}`,
    );
    assert.equal(
      welcomeCurrencyVerdict({
        welcomeEpoch: 5,
        currentEpoch: bad,
        commits: commitsFor(6, 6),
        lagLimit: LAG_LIMIT,
      }),
      "rejoin",
      `currentEpoch ${bad}`,
    );
  }
});

test("both epochs Infinity (lag NaN) fails closed to rejoin", () => {
  assert.equal(
    welcomeCurrencyVerdict({
      welcomeEpoch: Infinity,
      currentEpoch: Infinity,
      commits: commitsFor(1, 0),
      lagLimit: LAG_LIMIT,
    }),
    "rejoin",
  );
});

test("a non-finite lagLimit fails closed to rejoin, even on a clean catch-up", () => {
  // Without the finite guard, NaN and Infinity both let `lag >= lagLimit`
  // pass every lag through.
  for (const bad of [Number.NaN, Infinity]) {
    assert.equal(
      welcomeCurrencyVerdict({
        welcomeEpoch: 5,
        currentEpoch: 6,
        commits: commitsFor(6, 6),
        lagLimit: bad,
      }),
      "rejoin",
      `lagLimit ${bad}`,
    );
  }
});

test("a non-finite commit epoch fails closed to rejoin", () => {
  for (const bad of [Number.NaN, Infinity]) {
    assert.equal(
      welcomeCurrencyVerdict({
        welcomeEpoch: 5,
        currentEpoch: 7,
        commits: Object.freeze([{ epoch: 6 }, { epoch: bad }]),
        lagLimit: LAG_LIMIT,
      }),
      "rejoin",
      `commit epoch ${bad}`,
    );
  }
});

// ---- WELCOME_CURRENCY_BACKOFF_MS ----------------------------------------------

/** The session's `SUBMIT_TIMEOUT_MS` = the currency check's own deadline. */
const CURRENCY_DEADLINE_MS = 10_000;

test("the currency check backs off 1 s, 2 s, 4 s — three attempts", () => {
  assert.deepEqual([...WELCOME_CURRENCY_BACKOFF_MS], [1_000, 2_000, 4_000]);
});

test("the whole backoff fits inside the currency check's deadline", () => {
  const total = WELCOME_CURRENCY_BACKOFF_MS.reduce((a, b) => a + b, 0);
  assert.ok(
    total < CURRENCY_DEADLINE_MS,
    `backoff ${total} ms must leave room inside ${CURRENCY_DEADLINE_MS} ms`,
  );
});
