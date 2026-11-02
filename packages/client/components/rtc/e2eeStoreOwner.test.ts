// Unit spec for the E2EE store-owner refusal — run with Node's built-in runner:
//   node --test components/rtc/e2eeStoreOwner.test.ts   (Node >=23.6 strips types)
// Focus: the destructive reset is offered ONLY on a well-formed refusal. Every
// near-miss must fall through to the generic loud path rather than render a
// banner that invites the user to wipe their keys.
import assert from "node:assert/strict";
import { test } from "node:test";

import { isStoreOwnerMismatch, storeOwnerMismatch } from "./e2eeStoreOwner.ts";

const OWNER = "01KWFKG47HBFTEEN6XPPS8H3HN";
const REQUESTED = "01KWHY6P2RPHWNJADM59F97JGE";

const wellFormed = {
  type: "mls_store_owned_by_another_account",
  owner_user_id: OWNER,
  requested_user_id: REQUESTED,
};

test("recognises the refusal and carries both ids", () => {
  assert.deepEqual(storeOwnerMismatch(wellFormed), {
    ownerUserId: OWNER,
    requestedUserId: REQUESTED,
  });
  assert.equal(isStoreOwnerMismatch(wellFormed), true);
});

test("the OLD shape is not mistaken for it", () => {
  // What this used to arrive as. It must NOT light the reset affordance —
  // `invalid_argument` is also what a caller passing junk gets.
  assert.equal(
    storeOwnerMismatch({ type: "invalid_argument", field: "user_id" }),
    null,
  );
});

test("other native errors fall through to the generic loud path", () => {
  for (const other of [
    { type: "mls_call_full" },
    { type: "declined" },
    { type: "needs_bundle", user_id: OWNER, device_ids: [] },
    { type: "store_corrupt" },
    // A locked phone: the store is intact, so never light the reset.
    { type: "protector" },
    { type: "protector_locked" },
  ]) {
    assert.equal(storeOwnerMismatch(other), null, JSON.stringify(other));
  }
});

test("a half-parsed refusal is refused — never offer a wipe on blank ids", () => {
  const bad: unknown[] = [
    { type: "mls_store_owned_by_another_account" },
    { type: "mls_store_owned_by_another_account", owner_user_id: OWNER },
    {
      type: "mls_store_owned_by_another_account",
      owner_user_id: "",
      requested_user_id: REQUESTED,
    },
    {
      type: "mls_store_owned_by_another_account",
      owner_user_id: OWNER,
      requested_user_id: "",
    },
    {
      type: "mls_store_owned_by_another_account",
      owner_user_id: 42,
      requested_user_id: REQUESTED,
    },
  ];
  for (const b of bad) {
    assert.equal(storeOwnerMismatch(b), null, JSON.stringify(b));
  }
});

test("non-objects never match", () => {
  for (const b of [
    null,
    undefined,
    "",
    "mls_store_owned_by_another_account",
    0,
  ]) {
    assert.equal(storeOwnerMismatch(b), null, String(b));
  }
});

test("a real Error instance does not match by accident", () => {
  // `#rethrow` only parses `{`-prefixed messages back into typed objects; a
  // plain thrown Error keeps its class and must not light the reset.
  const err = new Error("mls_store_owned_by_another_account");
  assert.equal(storeOwnerMismatch(err), null);
});
