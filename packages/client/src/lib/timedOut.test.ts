// Specs for the member-timeout expiry timer (moderation slice 1, composer
// notice). Run with Node's built-in runner:
//   node --conditions=browser --test src/lib/timedOut.test.ts
//
// Pure: no DOM, no client. The delay must never exceed setTimeout's signed
// 32-bit maximum, because a larger one fires immediately instead of waiting,
// and an expired (or invalid) timeout must arm no timer at all.
import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_TIMER_DELAY_MS, nextExpiryDelay } from "./timedOut.ts";

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

test("the clamp is setTimeout's signed 32-bit maximum", () => {
  assert.equal(MAX_TIMER_DELAY_MS, 2_147_483_647);
});

test("a future expiry waits exactly the remaining time", () => {
  assert.equal(nextExpiryDelay(NOW + 1, NOW), 1);
  assert.equal(nextExpiryDelay(NOW + 60_000, NOW), 60_000);
});

test("a past expiry arms nothing", () => {
  assert.equal(nextExpiryDelay(NOW - 1, NOW), undefined);
  assert.equal(nextExpiryDelay(NOW - DAY_MS, NOW), undefined);
});

test("an expiry exactly now counts as expired", () => {
  assert.equal(nextExpiryDelay(NOW, NOW), undefined);
});

test("a 28-day timeout is clamped to 2_147_483_647 ms", () => {
  const delay = nextExpiryDelay(NOW + 28 * DAY_MS, NOW);
  assert.ok(28 * DAY_MS > 2_147_483_647, "28 days really is past the clamp");
  assert.equal(delay, 2_147_483_647);
});

test("a delay just under the clamp is not rounded", () => {
  assert.equal(nextExpiryDelay(NOW + 2_147_483_646, NOW), 2_147_483_646);
  assert.equal(nextExpiryDelay(NOW + 2_147_483_648, NOW), 2_147_483_647);
});

test("an invalid date (NaN) arms nothing", () => {
  assert.equal(nextExpiryDelay(Number.NaN, NOW), undefined);
  assert.equal(nextExpiryDelay(new Date("garbage").getTime(), NOW), undefined);
});
