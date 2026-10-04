// Unit spec for the push-provider policy — run with Node's built-in runner:
//   node --conditions=browser --test components/client/pushPolicy.test.ts
// Declared test count: 15 (the gate compares this against the runner's pass
// count, since the runner also exits 0 when it finds no tests at all).
// Focus: the provider is picked from two static facts, the web ringtone plays
// only where nothing native rings, the subscribe body carries exactly four
// fields, and the UnifiedPush resync planner follows its truth table top to
// bottom. Row order matters there: a stale subscription is dropped even when
// the key is broken, and a key is handed back only for `register`.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type PushProvider,
  type UnifiedPushAction,
  choosePushProvider,
  planUnifiedPushRegistration,
  playsWebRingtone,
  unifiedPushSubscribeBody,
} from "./pushPolicy.ts";

/**
 * Obviously fake 87-character keys. The planner only compares them, so they
 * need not decode; never put a real VAPID key in a fixture.
 */
const KEY_A = "A".repeat(87);
const KEY_B = "B".repeat(87);

/** An acknowledged distributor's package name. */
const DISTRIBUTOR = "io.heckel.ntfy";

/** A stored distributor endpoint. */
const ENDPOINT = "https://ntfy.example.invalid/upFAKE";

type PlanInput = Parameters<typeof planUnifiedPushRegistration>[0];

/** Every value each planner input can take, for the sweeps below. */
const CONFIGURED = [true, false] as const;
const VAPIDS = [null, KEY_A, KEY_B] as const;
const ACKED = [null, DISTRIBUTOR] as const;
const STORED_VAPIDS = [null, KEY_A, KEY_B] as const;
const ENDPOINTS = [null, ENDPOINT] as const;

/** Every combination of planner inputs (2 × 3 × 2 × 3 × 2 = 72). */
function allInputs(): PlanInput[] {
  const inputs: PlanInput[] = [];
  for (const configured of CONFIGURED) {
    for (const vapid of VAPIDS) {
      for (const acked of ACKED) {
        for (const storedVapid of STORED_VAPIDS) {
          for (const endpoint of ENDPOINTS) {
            inputs.push({ configured, vapid, acked, storedVapid, endpoint });
          }
        }
      }
    }
  }
  return inputs;
}

/** A readable label for an input, with the fake keys shortened. */
function label(i: PlanInput): string {
  const short = (s: string | null) =>
    s === KEY_A ? "A" : s === KEY_B ? "B" : String(s);
  return (
    `configured=${i.configured} vapid=${short(i.vapid)} ` +
    `acked=${String(i.acked)} storedVapid=${short(i.storedVapid)} ` +
    `endpoint=${i.endpoint === null ? "null" : "set"}`
  );
}

/** Asserts the planner's full result for one input. */
function expectPlan(
  i: PlanInput,
  action: UnifiedPushAction,
  vapid: string | null = null,
) {
  assert.deepEqual(planUnifiedPushRegistration(i), { action, vapid }, label(i));
}

test("choosePushProvider: the browser gets none, with or without the plugin", () => {
  for (const unifiedPushAvailable of [true, false]) {
    assert.equal(
      choosePushProvider({ native: false, unifiedPushAvailable }),
      "none",
      `plugin=${unifiedPushAvailable}`,
    );
  }
});

test("choosePushProvider: a native build with the plugin gets unifiedpush", () => {
  assert.equal(
    choosePushProvider({ native: true, unifiedPushAvailable: true }),
    "unifiedpush",
  );
});

test("choosePushProvider: a native build without the plugin keeps fcm", () => {
  assert.equal(
    choosePushProvider({ native: true, unifiedPushAvailable: false }),
    "fcm",
  );
});

test("playsWebRingtone: every provider and registration state", () => {
  const cases: [PushProvider, boolean, boolean][] = [
    ["none", false, true],
    ["none", true, true],
    ["fcm", false, false],
    ["fcm", true, false],
    ["unifiedpush", false, true],
    ["unifiedpush", true, false],
  ];
  for (const [provider, registered, expected] of cases) {
    assert.equal(
      playsWebRingtone(provider, registered),
      expected,
      `${provider} × registered=${registered}`,
    );
  }
});

test("unifiedPushSubscribeBody adds kind unifiedpush", () => {
  assert.deepEqual(
    unifiedPushSubscribeBody({
      endpoint: ENDPOINT,
      p256dh: "fake-p256dh",
      auth: "fake-auth",
    }),
    {
      endpoint: ENDPOINT,
      p256dh: "fake-p256dh",
      auth: "fake-auth",
      kind: "unifiedpush",
    },
  );
});

test("unifiedPushSubscribeBody drops every other field of the native result", () => {
  // Held in a wider variable so the extra fields get past the excess-property
  // check, as they would from a native plugin result.
  const native = {
    endpoint: ENDPOINT,
    p256dh: "fake-p256dh",
    auth: "fake-auth",
    kind: "fcm",
    vapid: KEY_A,
    distributor: DISTRIBUTOR,
  };
  const body = unifiedPushSubscribeBody(native);
  assert.deepEqual(body, {
    endpoint: ENDPOINT,
    p256dh: "fake-p256dh",
    auth: "fake-auth",
    kind: "unifiedpush",
  });
  assert.notEqual(body, native);
  assert.equal(native.kind, "fcm", "the input is not mutated");
});

test("plan: not configured is not-ready, whatever else holds", () => {
  for (const i of allInputs()) {
    if (!i.configured) expectPlan(i, "not-ready");
  }
});

test("plan: no distributor with a stored endpoint reconciles, even with no usable key", () => {
  for (const vapid of VAPIDS) {
    for (const storedVapid of STORED_VAPIDS) {
      expectPlan(
        {
          configured: true,
          vapid,
          acked: null,
          storedVapid,
          endpoint: ENDPOINT,
        },
        "reconcile-unsubscribe",
      );
    }
  }
});

test("plan: no distributor and nothing stored is no-distributor, even with no usable key", () => {
  for (const vapid of VAPIDS) {
    for (const storedVapid of STORED_VAPIDS) {
      expectPlan(
        { configured: true, vapid, acked: null, storedVapid, endpoint: null },
        "no-distributor",
      );
    }
  }
});

test("plan: an invalid key (passed as null) with a distributor is not-ready", () => {
  for (const storedVapid of STORED_VAPIDS) {
    for (const endpoint of ENDPOINTS) {
      expectPlan(
        {
          configured: true,
          vapid: null,
          acked: DISTRIBUTOR,
          storedVapid,
          endpoint,
        },
        "not-ready",
      );
    }
  }
});

test("plan: no endpoint registers with the advertised key, even if the stored key matches", () => {
  for (const storedVapid of STORED_VAPIDS) {
    expectPlan(
      {
        configured: true,
        vapid: KEY_A,
        acked: DISTRIBUTOR,
        storedVapid,
        endpoint: null,
      },
      "register",
      KEY_A,
    );
  }
});

test("plan: a changed key re-registers with the new key", () => {
  expectPlan(
    {
      configured: true,
      vapid: KEY_B,
      acked: DISTRIBUTOR,
      storedVapid: KEY_A,
      endpoint: ENDPOINT,
    },
    "register",
    KEY_B,
  );
  // An endpoint with no recorded key cannot be proven current either.
  expectPlan(
    {
      configured: true,
      vapid: KEY_B,
      acked: DISTRIBUTOR,
      storedVapid: null,
      endpoint: ENDPOINT,
    },
    "register",
    KEY_B,
  );
});

test("plan: an equal key and a stored endpoint repost", () => {
  for (const key of [KEY_A, KEY_B]) {
    expectPlan(
      {
        configured: true,
        vapid: key,
        acked: DISTRIBUTOR,
        storedVapid: key,
        endpoint: ENDPOINT,
      },
      "repost",
    );
  }
});

test("plan: the whole table, top to bottom, over every input", () => {
  // The contract's table, restated row by row as the reference.
  const expected = (i: PlanInput): UnifiedPushAction => {
    if (!i.configured) return "not-ready";
    if (i.acked === null && i.endpoint !== null) return "reconcile-unsubscribe";
    if (i.acked === null) return "no-distributor";
    if (i.vapid === null) return "not-ready";
    if (i.endpoint === null || i.storedVapid !== i.vapid) return "register";
    return "repost";
  };
  const seen = new Set<UnifiedPushAction>();
  for (const i of allInputs()) {
    const action = expected(i);
    seen.add(action);
    expectPlan(i, action, action === "register" ? i.vapid : null);
  }
  // Guards the sweep itself: every action has to be reachable from it.
  assert.equal(seen.size, 5);
});

test("plan: a key comes back only for register, and it is the advertised one", () => {
  for (const i of allInputs()) {
    const plan = planUnifiedPushRegistration(i);
    if (plan.action === "register") {
      assert.equal(plan.vapid, i.vapid, label(i));
    } else {
      assert.equal(plan.vapid, null, `${plan.action}: ${label(i)}`);
    }
  }
});
