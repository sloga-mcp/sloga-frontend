// Unit spec for the group-growth decisions — run with Node's built-in runner:
//   node --conditions=browser --test components/client/e2eeGroupGrowth.test.ts
// Focus: only `declined` / `busy` resolve (everything else is rethrown);
// dialog labels never invent a name; an encrypted group asserts native's
// Active set while a fresh or downgraded one keeps the confirmed roster; a
// bundle (one of the peer's one-time keys) is fetched only where native
// would demand it.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type GroupRosterState,
  groupEnableRoster,
  groupGrowthDisplayNames,
  groupGrowthNeedsBundle,
  groupGrowthOutcomeOf,
} from "./e2eeGroupGrowth.ts";

const SELF = "01J9QCRE7M0000000000000001";
const A = "01J9QCRE7M0000000000000002";
const B = "01J9QCRE7M0000000000000003";
const C = "01J9QCRE7M0000000000000004";
const LOCAL_DEVICE = "aa".repeat(16);
const OTHER_DEVICE = "bb".repeat(16);

type Named = { username?: string; discriminator?: string };

const device = (
  device_id: string,
  has_active_session: boolean,
  status = "active",
) => ({ device_id, status, has_active_session });

// ---- groupGrowthOutcomeOf ----------------------------------------------------

test("outcome: declined and busy resolve as themselves", () => {
  assert.equal(groupGrowthOutcomeOf({ type: "declined" }), "declined");
  assert.equal(groupGrowthOutcomeOf({ type: "busy" }), "busy");
  // Extra fields do not change the tag
  assert.equal(
    groupGrowthOutcomeOf({ type: "busy", user_id: A, field: "x" }),
    "busy",
  );
});

test("outcome: every other native refusal is rethrown (null)", () => {
  for (const error of [
    { type: "needs_bundle", user_id: A, device_ids: [] },
    { type: "invalid_argument", field: "roster_changed" },
    { type: "invalid_argument", field: "roster_mismatch" },
    { type: "invalid_argument", field: "self_user_id" },
    // A `field` named like an outcome is not the outcome
    { type: "invalid_argument", field: "busy" },
    { type: "invalid_argument", field: "declined" },
    {
      type: "mls_store_owned_by_another_account",
      owner_user_id: A,
      requested_user_id: SELF,
    },
    { type: "not_enabled" },
  ]) {
    assert.equal(groupGrowthOutcomeOf(error), null, JSON.stringify(error));
  }
});

test("outcome: malformed values are failures, never an outcome", () => {
  for (const error of [
    null,
    undefined,
    "declined",
    "busy",
    0,
    true,
    {},
    { type: ["declined"] },
    { type: "DECLINED" },
    { type: " busy" },
    // An unparsed Capacitor reject: the transport's #rethrow parses these
    // first, so one reaching here is not a decline
    new Error('{"type":"declined"}'),
  ]) {
    assert.equal(groupGrowthOutcomeOf(error), null, String(error));
  }
});

// ---- groupGrowthDisplayNames -------------------------------------------------

test("display names: username#discriminator, else username, else omitted", () => {
  const users: Record<string, Named> = {
    [SELF]: { username: "me", discriminator: "0001" },
    [A]: { username: "alice", discriminator: "1234" },
    [B]: { username: "bob" },
    [C]: { username: "carol", discriminator: "" },
  };
  assert.deepEqual(
    groupGrowthDisplayNames([SELF, A, B, C], (id) => users[id]),
    {
      [SELF]: "me#0001",
      [A]: "alice#1234",
      [B]: "bob",
      [C]: "carol",
    },
  );
});

test("display names: no user or no username leaves the id unlabelled", () => {
  const users: Record<string, Named> = {
    [A]: {},
    [B]: { username: "", discriminator: "9999" },
  };
  // A discriminator alone is not a name; an unknown user is not invented
  assert.deepEqual(
    groupGrowthDisplayNames([A, B, C], (id) => users[id]),
    {},
  );
  assert.deepEqual(
    groupGrowthDisplayNames([], () => ({ username: "x" })),
    {},
  );
});

test("display names: keyed by the id asked for, once per id", () => {
  const asked: string[] = [];
  const names = groupGrowthDisplayNames(new Set([A, A, B]), (id) => {
    asked.push(id);
    return { username: `u-${id}` };
  });
  assert.deepEqual(asked, [A, B]);
  assert.deepEqual(names, { [A]: `u-${A}`, [B]: `u-${B}` });
});

// ---- groupEnableRoster -------------------------------------------------------

const requested = [SELF, A, B, C];

test("roster: an encrypted group asserts native's Active members only", () => {
  const state: GroupRosterState = {
    encrypted_since: 1_700_000_000,
    members: [
      { user_id: A, status: "active" },
      { user_id: SELF, status: "active" },
      { user_id: B, status: "removed" },
      { user_id: C, status: "announced" },
    ],
  };
  // Native order, Removed and Announced dropped, the displayed list ignored
  assert.deepEqual(groupEnableRoster(state, requested), [A, SELF]);
});

test("roster: encrypted_since 0 is still encrypted", () => {
  const state: GroupRosterState = {
    encrypted_since: 0,
    members: [{ user_id: SELF, status: "active" }],
  };
  assert.deepEqual(groupEnableRoster(state, requested), [SELF]);
});

test("roster: an encrypted group with no Active members asserts none", () => {
  // Native refuses an empty roster; the requested list must not stand in
  const state: GroupRosterState = {
    encrypted_since: 5,
    members: [{ user_id: A, status: "removed" }],
  };
  assert.deepEqual(groupEnableRoster(state, requested), []);
});

test("roster: a downgraded group keeps the confirmed roster (re-enable)", () => {
  const state: GroupRosterState = {
    encrypted_since: null,
    members: [{ user_id: SELF, status: "active" }],
  };
  assert.equal(groupEnableRoster(state, requested), requested);
});

test("roster: a fresh group (no native state) keeps the confirmed roster", () => {
  assert.equal(groupEnableRoster(null, requested), requested);
});

test("roster: a malformed state keeps the confirmed roster", () => {
  // Native then decides: an encrypted row refuses it as roster_mismatch
  for (const state of [
    { encrypted_since: undefined, members: [] },
    { encrypted_since: "5", members: [] },
    { encrypted_since: 5, members: "x" },
    { encrypted_since: 5 },
  ]) {
    assert.equal(
      groupEnableRoster(state as unknown as GroupRosterState, requested),
      requested,
      JSON.stringify(state),
    );
  }
});

// ---- groupGrowthNeedsBundle --------------------------------------------------

test("bundle: a member with no pinned device needs one", () => {
  assert.equal(groupGrowthNeedsBundle([], false, LOCAL_DEVICE), true);
});

test("bundle: a member whose devices are all revoked needs one", () => {
  assert.equal(
    groupGrowthNeedsBundle(
      [device(OTHER_DEVICE, false, "revoked")],
      false,
      LOCAL_DEVICE,
    ),
    true,
  );
});

test("bundle: an Active device without a session needs one", () => {
  assert.equal(
    groupGrowthNeedsBundle(
      [device("d1", true), device("d2", false)],
      false,
      LOCAL_DEVICE,
    ),
    true,
  );
});

test("bundle: every Active device in session spares the one-time keys", () => {
  assert.equal(
    groupGrowthNeedsBundle(
      [device("d1", true), device("d2", true), device("d3", false, "revoked")],
      false,
      LOCAL_DEVICE,
    ),
    false,
  );
});

test("bundle: an identity-changed device skips the fetch", () => {
  assert.equal(
    groupGrowthNeedsBundle(
      [device("d1", false), device("d2", true, "identity_changed")],
      false,
      LOCAL_DEVICE,
    ),
    false,
  );
  assert.equal(
    groupGrowthNeedsBundle(
      [device(OTHER_DEVICE, false, "identity_changed")],
      true,
      LOCAL_DEVICE,
    ),
    false,
  );
});

test("bundle: self with only this device needs none", () => {
  assert.equal(groupGrowthNeedsBundle([], true, LOCAL_DEVICE), false);
  assert.equal(
    groupGrowthNeedsBundle([device(LOCAL_DEVICE, false)], true, LOCAL_DEVICE),
    false,
  );
});

test("bundle: self with a sessionless other device needs one", () => {
  assert.equal(
    groupGrowthNeedsBundle(
      [device(LOCAL_DEVICE, false), device(OTHER_DEVICE, false)],
      true,
      LOCAL_DEVICE,
    ),
    true,
  );
  assert.equal(
    groupGrowthNeedsBundle(
      [device(LOCAL_DEVICE, false), device(OTHER_DEVICE, true)],
      true,
      LOCAL_DEVICE,
    ),
    false,
  );
});

test("bundle: the local-device exclusion is for self only", () => {
  // A peer's device that happens to share the id is still a peer device:
  // kept, it is in session (no fetch); dropped, the peer would look
  // deviceless and spend a one-time key
  assert.equal(
    groupGrowthNeedsBundle([device(LOCAL_DEVICE, true)], false, LOCAL_DEVICE),
    false,
  );
});

test("bundle: an unknown local device id excludes nothing", () => {
  for (const local of [null, undefined]) {
    assert.equal(
      groupGrowthNeedsBundle([device(LOCAL_DEVICE, false)], true, local),
      true,
    );
  }
});
