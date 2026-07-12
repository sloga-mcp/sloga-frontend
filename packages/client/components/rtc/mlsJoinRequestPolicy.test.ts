// Unit spec for the join-request routing policy — run with Node's built-in
// runner:
//   node --test components/rtc/mlsJoinRequestPolicy.test.ts   (Node >=23.6 strips types)
// Focus (rejoin-affordance plan §6): rejoin routes to serve_rejoin (stale-leaf
// Remove), normal joins keep the admit path, and SELF never triggers either
// (a self-Remove would trip native CannotRemoveSelf loudly).
import { test } from "node:test";
import assert from "node:assert/strict";

import { joinRequestAction } from "./mlsJoinRequestPolicy.ts";

test("normal join request → schedule_admit", () => {
  assert.equal(
    joinRequestAction({ rejoin: false, isSelf: false }),
    "schedule_admit",
  );
});

test("rejoin request → serve_rejoin (stale-leaf Remove, never an admit)", () => {
  assert.equal(
    joinRequestAction({ rejoin: true, isSelf: false }),
    "serve_rejoin",
  );
});

test("SELF is ignored in BOTH modes (own fan-out echo / post-readd replay)", () => {
  assert.equal(joinRequestAction({ rejoin: false, isSelf: true }), "ignore");
  assert.equal(joinRequestAction({ rejoin: true, isSelf: true }), "ignore");
});

test("self NEVER yields a remove or admit (invariant over the whole domain)", () => {
  for (const rejoin of [false, true]) {
    assert.equal(joinRequestAction({ rejoin, isSelf: true }), "ignore");
  }
});
