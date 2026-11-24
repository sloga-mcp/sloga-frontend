// Unit spec for the S2-D36 re-securing policy (W4 lane L1n) - run with
// Node's built-in runner from packages/client:
//   node --test --conditions=browser components/client/protectedResecurePolicy.test.ts
// Focus: each cause maps to the doc's timer and action (design @74390c37
// :5057-5064, 9.2 :5117 and :5125), checked on both sides of its boundary;
// escalation is amber only (no shield state, never red, ids never
// returned); a clock that goes backwards never escalates; anything
// unrecognized is `other` with a static 2 min.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ResecureCause,
  type ResecureEscalation,
  type ResecureInputs,
  RESECURE_ACTIONS,
  RESECURE_CAUSES,
  RESECURE_ESCALATION_MS,
  resecureCause,
} from "./protectedResecurePolicy.ts";
import type {
  ProtectedChannelView,
  TextGroupState,
  TextVerdict,
} from "./protectedTextTypes.ts";

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const OWNER_U = "01OWNERUSER0000000000000000";
const OWNER_D = "owner-signing-device";
const OWNER_D2 = "owner-other-device";
const MEMBER_U = "01MEMBERUSER000000000000000";
const MEMBER_D = "member-device";
const IDS = [OWNER_U, OWNER_D, OWNER_D2, MEMBER_U, MEMBER_D, "g1", "g0"];

type Native = NonNullable<ResecureInputs["native"]>;
type Group = NonNullable<ResecureInputs["serverGroup"]>;

function native(over: Partial<Native> = {}): Native {
  return {
    group_id: "g1",
    epoch: 5,
    state: "active",
    verdict: "ok",
    seat_list: {
      version: 1,
      signer_user_id: OWNER_U,
      signer_device_id: OWNER_D,
      seats: [OWNER_U, MEMBER_U],
      device_cap: 2,
      issued_at: 1,
    },
    ...over,
  };
}

function group(over: Partial<Group> = {}): Group {
  return { group_id: "g1", current_epoch: 5, pending_removals: [], ...over };
}

/** A member device by default, in the resecuring window since T0. */
function inputs(over: Partial<ResecureInputs> = {}): ResecureInputs {
  return {
    groupError: null,
    native: native(),
    serverGroup: group(),
    welcomeRetriesExhausted: false,
    resecuringSinceMs: T0,
    selfUserId: MEMBER_U,
    selfDeviceId: MEMBER_D,
    ...over,
  };
}

const asOwnerSigner = { selfUserId: OWNER_U, selfDeviceId: OWNER_D };
const asOwnerOther = { selfUserId: OWNER_U, selfDeviceId: OWNER_D2 };
const asMember = { selfUserId: MEMBER_U, selfDeviceId: MEMBER_D };

const pending = group({
  pending_removals: [{ user_id: MEMBER_U, created_at: "2026-11-12T00:00Z" }],
});
const lostDevice = group({
  signer_lost: {
    user_id: OWNER_U,
    device_id: OWNER_D,
    cause: "device_revoked",
    at: "2026-11-12T00:00:00Z",
  },
});
const lostAccount = group({
  signer_lost: {
    user_id: OWNER_U,
    device_id: OWNER_D,
    cause: "account_unavailable",
    at: "2026-11-12T00:00:00Z",
  },
});
const poisoned = native({ state: "poisoned", verdict: "poisoned" });
const joining = native({
  state: "joining",
  verdict: "joining",
  group_id: null,
});

/** Asserts the result just before and at its own boundary. */
function boundary(
  i: ResecureInputs,
  cause: ResecureCause,
  delayMs: number,
  action: ResecureEscalation["action"],
): void {
  const at = T0 + delayMs;
  assert.deepEqual(resecureCause(i, at - 1), {
    cause,
    escalateAtMs: at,
    escalated: false,
    action: null,
  });
  assert.deepEqual(resecureCause(i, at), {
    cause,
    escalateAtMs: at,
    escalated: true,
    action,
  });
}

// --- one row per cause -------------------------------------------------------

test("pending_removal: 2 min, then retry_removal (doc :5058-5059)", () => {
  boundary(
    inputs({ serverGroup: pending }),
    "pending_removal",
    2 * MIN,
    "retry_removal",
  );
  // A device-level pending removal (S2-D17a) is the same cause.
  const devices = group({
    pending_device_removals: [
      { user_id: MEMBER_U, device_id: MEMBER_D, created_at: "x" },
    ],
  });
  boundary(
    inputs({ serverGroup: devices }),
    "pending_removal",
    2 * MIN,
    "retry_removal",
  );
});

test("stale_group: 2 min, then rejoin (doc :5059)", () => {
  const stale: Partial<ResecureInputs>[] = [
    // Held epoch behind the server's.
    { serverGroup: group({ current_epoch: 6 }) },
    // Held group is not the server's open group.
    { serverGroup: group({ group_id: "g0" }) },
    // Superseded: active but the verdict says no group.
    { native: native({ verdict: "no_group" }) },
    // A gap / catch-up error on a held group.
    { groupError: "mls_epoch_gap" },
    { groupError: "unknown_epoch" },
    { groupError: "catch_up_leaf_unresolvable" },
  ];
  for (const over of stale) {
    boundary(inputs(over), "stale_group", 2 * MIN, "rejoin");
  }
});

test("poisoned_owner: 1 min, then recreate on the list signer's device (doc :5059-5060)", () => {
  boundary(
    inputs({ native: poisoned, ...asOwnerSigner }),
    "poisoned_owner",
    1 * MIN,
    "recreate",
  );
  // The state alone (verdict not yet poisoned) is enough.
  boundary(
    inputs({ native: native({ state: "poisoned" }), ...asOwnerSigner }),
    "poisoned_owner",
    1 * MIN,
    "recreate",
  );
});

test("poisoned_member: 5 min, waiting for the owner, no action (doc :5060-5061)", () => {
  boundary(inputs({ native: poisoned }), "poisoned_member", 5 * MIN, null);
  // The owner user on a device that did not sign the list cannot re-create.
  boundary(
    inputs({ native: poisoned, ...asOwnerOther }),
    "poisoned_member",
    5 * MIN,
    null,
  );
});

test("owner_device_lost: recover_ownership only on another device of the owner user (doc :5061-5062)", () => {
  // No timer in the doc: offered from the start.
  boundary(
    inputs({ serverGroup: lostDevice, ...asOwnerOther }),
    "owner_device_lost",
    0,
    "recover_ownership",
  );
  // A member gets the 9.2 copy and no action.
  boundary(inputs({ serverGroup: lostDevice }), "owner_device_lost", 0, null);
  // The lost device itself never offers it.
  boundary(
    inputs({ serverGroup: lostDevice, ...asOwnerSigner }),
    "owner_device_lost",
    0,
    null,
  );
  // A malformed lost device id cannot prove "another device".
  const noDevice = group({
    signer_lost: {
      user_id: OWNER_U,
      device_id: 7 as unknown as string,
      cause: "device_revoked",
      at: "x",
    },
  });
  boundary(
    inputs({ serverGroup: noDevice, ...asOwnerOther }),
    "owner_device_lost",
    0,
    null,
  );
  // Empty self ids never match an empty lost user id.
  const blank = group({
    signer_lost: {
      user_id: "",
      device_id: OWNER_D,
      cause: "device_revoked",
      at: "x",
    },
  });
  boundary(
    inputs({ serverGroup: blank, selfUserId: "", selfDeviceId: OWNER_D2 }),
    "owner_device_lost",
    0,
    null,
  );
});

test("owner_account_unavailable: static from the start, no action (9.2 :5125)", () => {
  for (const self of [asMember, asOwnerOther, asOwnerSigner]) {
    boundary(
      inputs({ serverGroup: lostAccount, ...self }),
      "owner_account_unavailable",
      0,
      null,
    );
  }
});

test("waiting_for_member: static after 2 min, no action (doc :5062-5063)", () => {
  boundary(
    inputs({ welcomeRetriesExhausted: true, native: joining }),
    "waiting_for_member",
    2 * MIN,
    null,
  );
});

test("other: nothing recognized is static after 2 min, no action", () => {
  // Loading, joining, and a healthy-looking state all fall to `other`.
  boundary(inputs({ native: null }), "other", 2 * MIN, null);
  boundary(inputs({ native: joining }), "other", 2 * MIN, null);
  boundary(inputs(), "other", 2 * MIN, null);
});

// --- properties --------------------------------------------------------------

test("the timers are exactly the doc's, per cause", () => {
  assert.deepEqual(RESECURE_ESCALATION_MS, {
    pending_removal: 2 * MIN,
    stale_group: 2 * MIN,
    poisoned_owner: 1 * MIN,
    poisoned_member: 5 * MIN,
    owner_device_lost: 0,
    owner_account_unavailable: 0,
    waiting_for_member: 2 * MIN,
    other: 2 * MIN,
  });
  assert.deepEqual(
    Object.keys(RESECURE_ESCALATION_MS).sort(),
    [...RESECURE_CAUSES].sort(),
  );
});

test("an unknown cause is other with a static 2 min", () => {
  const cases: Group[] = [
    // A signer_lost cause this client does not know.
    group({
      signer_lost: {
        user_id: OWNER_U,
        device_id: OWNER_D,
        cause: "from_the_future" as unknown as "device_revoked",
        at: "x",
      },
    }),
    // A signer_lost that is not an object.
    group({ signer_lost: "lost" as unknown as Group["signer_lost"] }),
    // Malformed removal lists: no cause is inferred from them.
    group({ pending_removals: "many" as unknown as Group["pending_removals"] }),
    group({
      pending_device_removals:
        {} as unknown as Group["pending_device_removals"],
    }),
  ];
  for (const g of cases) {
    // The owner user on another device still gets no action.
    boundary(
      inputs({ serverGroup: g, ...asOwnerOther }),
      "other",
      2 * MIN,
      null,
    );
  }
});

test("the lost signer outranks waiting, poisoned and pending removal (9.2 :5117 R12)", () => {
  const all = {
    welcomeRetriesExhausted: true,
    native: poisoned,
    serverGroup: { ...lostDevice, pending_removals: pending.pending_removals },
  };
  const r = resecureCause(inputs({ ...all, ...asOwnerOther }), T0);
  assert.equal(r.cause, "owner_device_lost");
  assert.equal(r.action, "recover_ownership");
  const a = resecureCause(inputs({ ...all, serverGroup: lostAccount }), T0);
  assert.equal(a.cause, "owner_account_unavailable");
});

test("waiting_for_member outranks poisoned, pending and stale (shield 6d before 7)", () => {
  const r = resecureCause(
    inputs({
      welcomeRetriesExhausted: true,
      native: poisoned,
      serverGroup: { ...pending, current_epoch: 9 },
      ...asOwnerSigner,
    }),
    T0 + 10 * MIN,
  );
  assert.deepEqual(r, {
    cause: "waiting_for_member",
    escalateAtMs: T0 + 2 * MIN,
    escalated: true,
    action: null,
  });
});

test("poisoned outranks a pending removal, and a pending removal outranks stale", () => {
  const p = inputs({
    native: poisoned,
    serverGroup: pending,
    ...asOwnerSigner,
  });
  assert.equal(resecureCause(p, T0).cause, "poisoned_owner");
  const s = inputs({ serverGroup: { ...pending, current_epoch: 9 } });
  assert.equal(resecureCause(s, T0).cause, "pending_removal");
});

test("now going backwards never escalates", () => {
  const fixtures: ResecureInputs[] = [
    inputs({ serverGroup: pending }),
    inputs({ serverGroup: group({ current_epoch: 6 }) }),
    inputs({ native: poisoned, ...asOwnerSigner }),
    inputs({ native: poisoned }),
    inputs({ serverGroup: lostDevice, ...asOwnerOther }),
    inputs({ serverGroup: lostAccount }),
    inputs({ welcomeRetriesExhausted: true }),
    inputs({ native: null }),
  ];
  for (const i of fixtures) {
    const at = resecureCause(i, T0).escalateAtMs;
    assert.ok(at !== null);
    assert.equal(resecureCause(i, at).escalated, true);
    // Back below the boundary, behind the start, and non-finite clocks.
    const backs = [at - 1, T0 - 1, T0 - 10 * MIN, 0, -1, Number.NaN, -Infinity];
    for (const back of backs) {
      const r = resecureCause(i, back);
      assert.equal(r.escalated, false, `now=${back}`);
      assert.equal(r.action, null, `now=${back}`);
      assert.equal(r.escalateAtMs, at, "the boundary never moves with now");
    }
  }
});

test("an unknown start never escalates", () => {
  for (const since of [null, Number.NaN, Infinity, "1" as unknown as number]) {
    const i = inputs({ serverGroup: pending, resecuringSinceMs: since });
    assert.deepEqual(resecureCause(i, T0 + 60 * MIN), {
      cause: "pending_removal",
      escalateAtMs: null,
      escalated: false,
      action: null,
    });
  }
});

test("no input ever yields a red state", () => {
  const groupErrors: ResecureInputs["groupError"][] = [
    null,
    "bad_sig",
    "owner_changed",
    "roster_mismatch",
    "seat_list_rollback",
    "unknown",
    "mls_epoch_gap",
    "mls_poisoned_epoch",
  ];
  const states: TextGroupState[] = [
    "none",
    "joining",
    "active",
    "poisoned",
    "left",
  ];
  const verdicts: TextVerdict[] = [
    "ok",
    "no_group",
    "joining",
    "not_seated",
    "no_seat_list",
    "roster_mismatch",
    "owner_changed",
    "poisoned",
  ];
  const natives: ResecureInputs["native"][] = [null];
  for (const state of states) {
    for (const verdict of verdicts) natives.push(native({ state, verdict }));
  }
  natives.push(native({ epoch: null }));
  natives.push(native({ seat_list: null, state: "poisoned" }));
  // A field missing at runtime despite its type: never throws.
  natives.push(native({ seat_list: undefined, state: "poisoned" }));
  const groups: ResecureInputs["serverGroup"][] = [
    null,
    group(),
    pending,
    group({ current_epoch: 6 }),
    group({ group_id: "g0" }),
    lostDevice,
    lostAccount,
    group({ signer_lost: "lost" as unknown as Group["signer_lost"] }),
    group({ pending_removals: null as unknown as Group["pending_removals"] }),
  ];
  const selves = [asOwnerSigner, asOwnerOther, asMember];
  const actions: readonly (string | null)[] = [...RESECURE_ACTIONS, null];
  const reds = [
    "unverified",
    "red",
    "bad_sig",
    "owner_changed",
    "roster_mismatch",
  ];
  const keys = ["action", "cause", "escalateAtMs", "escalated"];
  let n = 0;
  for (const groupError of groupErrors) {
    for (const nat of natives) {
      for (const g of groups) {
        for (const welcomeRetriesExhausted of [false, true]) {
          for (const self of selves) {
            for (const since of [T0, null]) {
              for (const now of [T0 - 1, T0, T0 + 60 * MIN]) {
                const i = inputs({
                  groupError,
                  native: nat,
                  serverGroup: g,
                  welcomeRetriesExhausted,
                  resecuringSinceMs: since,
                  ...self,
                });
                const r = resecureCause(i, now);
                n++;
                // Exactly four fields: no shield state, tone or tag rides along.
                assert.deepEqual(Object.keys(r).sort(), keys);
                assert.ok(RESECURE_CAUSES.includes(r.cause), r.cause);
                assert.ok(actions.includes(r.action), String(r.action));
                const json = JSON.stringify(r);
                for (const red of reds) {
                  assert.ok(!json.includes(red), `${red} leaked: ${json}`);
                }
                // Ids are compared, never returned.
                for (const id of IDS) {
                  assert.ok(!json.includes(id), `${id} leaked`);
                }
                // An action only once escalated.
                if (r.action !== null) assert.equal(r.escalated, true);
                // recover_ownership only for the owner user on another device.
                if (r.action === "recover_ownership") {
                  assert.equal(i.selfUserId, OWNER_U);
                  assert.notEqual(i.selfDeviceId, OWNER_D);
                }
                // recreate only on the list signer's device.
                if (r.action === "recreate") {
                  assert.equal(i.selfDeviceId, OWNER_D);
                }
              }
            }
          }
        }
      }
    }
  }
  assert.ok(n > 10_000, `grid ran ${n} cases`);
});

test("a ProtectedChannelView plus the three caller fields is a ResecureInputs", () => {
  const view: ProtectedChannelView = {
    channelId: "01CHANNEL0000000000000000000",
    seatListError: null,
    groupError: null,
    native: null,
    serverGroup: null,
    seats: null,
    rosterMismatchSinceMs: null,
    signerLeafMissingRetries: 0,
    welcomeRetriesExhausted: true,
    ownerChangePending: false,
    recreateAvailable: false,
    publishInFlight: false,
    maybeUnsent: false,
    capacity: null,
    clientOutdated: null,
    ownerNotice: null,
  };
  // Compile-time: the spread is assignable (the tsc gate checks this line).
  const i: ResecureInputs = {
    ...view,
    resecuringSinceMs: T0,
    selfUserId: MEMBER_U,
    selfDeviceId: MEMBER_D,
  };
  assert.equal(resecureCause(i, T0).cause, "waiting_for_member");
});
