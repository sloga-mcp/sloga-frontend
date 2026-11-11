// Unit spec for the Draft store's protected-channel lookup (W4 lane A7) —
// run with Node's built-in runner from packages/client:
//   node --test --conditions=browser components/state/stores/protectedDraftGuard.test.ts
// Focus: with no resolver installed the answer is false (Draft behaves as
// today; `sendDraft`'s `client.isProtectedChannel` check is the real guard);
// an installed resolver is consulted per channel id, replaced by the next
// install and removed by `null`; a throwing resolver answers true.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  isProtectedForDraft,
  setProtectedChannelResolver,
} from "./protectedDraftGuard.ts";

const PROTECTED = "01PROTECTED000000000000000";
const PLAIN = "01PLAIN0000000000000000000";

afterEach(() => setProtectedChannelResolver(null));

test("unset resolver answers false", () => {
  assert.equal(isProtectedForDraft(PROTECTED), false);
  assert.equal(isProtectedForDraft(PLAIN), false);
  assert.equal(isProtectedForDraft(""), false);
});

test("installed resolver is consulted with the channel id", () => {
  const asked: string[] = [];
  setProtectedChannelResolver((id) => {
    asked.push(id);
    return id === PROTECTED;
  });
  assert.equal(isProtectedForDraft(PROTECTED), true);
  assert.equal(isProtectedForDraft(PLAIN), false);
  assert.deepEqual(asked, [PROTECTED, PLAIN]);
});

test("resolver is read at call time, not captured", () => {
  const protectedIds = new Set<string>();
  setProtectedChannelResolver((id) => protectedIds.has(id));
  assert.equal(isProtectedForDraft(PROTECTED), false);
  protectedIds.add(PROTECTED);
  assert.equal(isProtectedForDraft(PROTECTED), true);
});

test("a later install replaces the earlier one", () => {
  setProtectedChannelResolver(() => false);
  setProtectedChannelResolver((id) => id === PLAIN);
  assert.equal(isProtectedForDraft(PLAIN), true);
  assert.equal(isProtectedForDraft(PROTECTED), false);
});

test("null uninstalls: back to false", () => {
  setProtectedChannelResolver(() => true);
  assert.equal(isProtectedForDraft(PLAIN), true);
  setProtectedChannelResolver(null);
  assert.equal(isProtectedForDraft(PLAIN), false);
});

test("a throwing resolver answers true (refuse is the safe side)", () => {
  setProtectedChannelResolver(() => {
    throw new Error("client gone");
  });
  assert.equal(isProtectedForDraft(PROTECTED), true);
});

test("answer is always a boolean", () => {
  setProtectedChannelResolver(
    (id) => (id === PROTECTED ? 1 : undefined) as unknown as boolean,
  );
  assert.equal(isProtectedForDraft(PROTECTED), true);
  assert.equal(isProtectedForDraft(PLAIN), false);
});
