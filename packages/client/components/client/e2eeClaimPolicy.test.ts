// Claim-refusal policy (multi-device plan D4/D8, contract R3).
// Run: node --test --conditions=browser components/client/e2eeClaimPolicy.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CLAIM_LOCK_TTL_MS,
  CLAIM_RETRY_DELAY_MS,
  claimRefusal,
  heldElsewhereStep,
} from "./e2eeClaimPolicy.ts";

test("the retry waits past the claim lock TTL", () => {
  assert.equal(CLAIM_LOCK_TTL_MS, 150_000);
  assert.equal(CLAIM_RETRY_DELAY_MS, 160_000);
  assert.ok(CLAIM_RETRY_DELAY_MS > CLAIM_LOCK_TTL_MS);
});

test("strike 1 retries, strike 2 and later say shared", () => {
  assert.equal(heldElsewhereStep(1), "retry");
  assert.equal(heldElsewhereStep(2), "shared");
  assert.equal(heldElsewhereStep(3), "shared");
});

test("only the two known reasons act; anything else is absent", () => {
  assert.equal(claimRefusal("held_elsewhere"), "held_elsewhere");
  assert.equal(claimRefusal("removed"), "removed");
  for (const other of [
    undefined,
    null,
    "",
    "HELD_ELSEWHERE",
    "revoked",
    1,
    {},
  ]) {
    assert.equal(claimRefusal(other), null, `reason ${String(other)}`);
  }
});
