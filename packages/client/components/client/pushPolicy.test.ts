// Unit spec for the push-provider policy — run with Node's built-in runner:
//   node --conditions=browser --test components/client/pushPolicy.test.ts
// Declared test count: 29 (the gate compares this against the runner's pass
// count, since the runner also exits 0 when it finds no tests at all).
// Focus: the provider is picked from two static facts, the web ringtone plays
// only where nothing native rings and never on a device set not to ring, the
// subscribe body carries exactly four fields, and the UnifiedPush resync
// planner follows its truth table top to bottom. Row order matters there: a
// stale subscription is dropped even when the key is broken, and a key is
// handed back only for `register`. The two per-device preferences are only
// ever sent as `true`: nothing by default, `chats_only` not before the
// signed-in user has loaded, and adding them to a body changes none of its
// other fields.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type PushPrefs,
  type PushProvider,
  type UnifiedPushAction,
  choosePushProvider,
  planUnifiedPushRegistration,
  playsWebRingtone,
  pushPrefs,
  unifiedPushSubscribeBody,
  webRingtoneAllowed,
  withPushPrefs,
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

type PrefsInput = Parameters<typeof pushPrefs>[0];

/** Every combination of the three preference inputs (2 × 2 × 2 = 8). */
function allPrefsInputs(): PrefsInput[] {
  const inputs: PrefsInput[] = [];
  for (const slim of [false, true]) {
    for (const userLoaded of [false, true]) {
      for (const ringCalls of [false, true]) {
        inputs.push({ slim, userLoaded, ringCalls });
      }
    }
  }
  return inputs;
}

/** A readable label for a preference input. */
function prefsLabel(i: PrefsInput): string {
  return `slim=${i.slim} userLoaded=${i.userLoaded} ringCalls=${i.ringCalls}`;
}

/** Every preference object the builder can produce. */
const ALL_PREFS: PushPrefs[] = [
  {},
  { chats_only: true },
  { no_ring: true },
  { chats_only: true, no_ring: true },
];

/** A UnifiedPush subscribe body, as `unifiedPushSubscribeBody` builds it. */
function unifiedPushBody() {
  return unifiedPushSubscribeBody({
    endpoint: ENDPOINT,
    p256dh: "fake-p256dh",
    auth: "fake-auth",
  });
}

/** The FCM subscribe body: the device token rides in `auth`. */
function fcmBody() {
  return { endpoint: "fcm", p256dh: "", auth: "fake-fcm-token" };
}

/** The APNs subscribe body, the same shape with another endpoint marker. */
function apnsBody() {
  return { endpoint: "apn", p256dh: "", auth: "fake-apns-token" };
}

/** A browser web push subscribe body. */
function webPushBody() {
  return {
    endpoint: "https://push.example.invalid/fake",
    p256dh: "fake-p256dh",
    auth: "fake-auth",
  };
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

test("webRingtoneAllowed: every provider, registration state and ring setting", () => {
  const cases: [PushProvider, boolean, boolean, boolean][] = [
    ["none", false, true, true],
    ["none", true, true, true],
    ["fcm", false, true, false],
    ["fcm", true, true, false],
    ["unifiedpush", false, true, true],
    ["unifiedpush", true, true, false],
    ["none", false, false, false],
    ["none", true, false, false],
    ["fcm", false, false, false],
    ["fcm", true, false, false],
    ["unifiedpush", false, false, false],
    ["unifiedpush", true, false, false],
  ];
  const seen = new Set<string>();
  for (const [provider, registered, ringCalls, expected] of cases) {
    const name = `${provider} × registered=${registered} × ringCalls=${ringCalls}`;
    seen.add(name);
    assert.equal(
      webRingtoneAllowed({
        provider,
        unifiedPushRegistered: registered,
        ringCalls,
      }),
      expected,
      name,
    );
  }
  // Guards the table itself: 3 providers × 2 × 2, with no row repeated.
  assert.equal(seen.size, 12);
});

test("webRingtoneAllowed: with ringing on it is the playsWebRingtone answer", () => {
  const providers: PushProvider[] = ["none", "fcm", "unifiedpush"];
  for (const provider of providers) {
    for (const registered of [false, true]) {
      assert.equal(
        webRingtoneAllowed({
          provider,
          unifiedPushRegistered: registered,
          ringCalls: true,
        }),
        playsWebRingtone(provider, registered),
        `${provider} × registered=${registered}`,
      );
    }
  }
});

test("webRingtoneAllowed: only a stored false silences the device", () => {
  // A setting that failed to load must ring as before, so everything that is
  // not the boolean false counts as ringing on.
  for (const junk of [undefined, null, 0, "", "false"]) {
    assert.equal(
      webRingtoneAllowed({
        provider: "none",
        unifiedPushRegistered: false,
        ringCalls: junk as unknown as boolean,
      }),
      true,
      `ringCalls=${JSON.stringify(junk)}`,
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

test("pushPrefs: the full truth table", () => {
  const rows: [
    slim: boolean,
    userLoaded: boolean,
    ringCalls: boolean,
    expected: PushPrefs,
  ][] = [
    [false, false, true, {}],
    [false, true, true, {}],
    [true, false, true, {}],
    [true, true, true, { chats_only: true }],
    [false, false, false, { no_ring: true }],
    [false, true, false, { no_ring: true }],
    [true, false, false, { no_ring: true }],
    [true, true, false, { chats_only: true, no_ring: true }],
  ];
  const seen = new Set<string>();
  for (const [slim, userLoaded, ringCalls, expected] of rows) {
    const input = { slim, userLoaded, ringCalls };
    seen.add(prefsLabel(input));
    // Strict deep equality: a key set to false or undefined is not the same
    // as a key left out.
    assert.deepEqual(pushPrefs(input), expected, prefsLabel(input));
  }
  // Guards the table itself: all eight inputs, with no row repeated.
  assert.equal(seen.size, 8);
});

test("pushPrefs: nothing is sent by default", () => {
  for (const userLoaded of [false, true]) {
    const prefs = pushPrefs({ slim: false, userLoaded, ringCalls: true });
    assert.deepEqual(Object.keys(prefs), [], `userLoaded=${userLoaded}`);
    assert.equal(JSON.stringify(prefs), "{}", `userLoaded=${userLoaded}`);
  }
});

test("pushPrefs: chats_only waits for the signed-in user", () => {
  for (const ringCalls of [false, true]) {
    const early = pushPrefs({ slim: true, userLoaded: false, ringCalls });
    assert.equal("chats_only" in early, false, `ringCalls=${ringCalls}`);
    const loaded = pushPrefs({ slim: true, userLoaded: true, ringCalls });
    assert.equal(loaded.chats_only, true, `ringCalls=${ringCalls}`);
  }
});

test("pushPrefs: a key is present only when it is on, and only as true", () => {
  for (const input of allPrefsInputs()) {
    const prefs: Record<string, unknown> = pushPrefs(input);
    assert.equal(
      "chats_only" in prefs,
      input.slim && input.userLoaded,
      prefsLabel(input),
    );
    assert.equal("no_ring" in prefs, !input.ringCalls, prefsLabel(input));
    for (const [key, value] of Object.entries(prefs)) {
      assert.ok(
        key === "chats_only" || key === "no_ring",
        `${key}: ${prefsLabel(input)}`,
      );
      assert.equal(value, true, `${key}: ${prefsLabel(input)}`);
    }
  }
});

test("pushPrefs: a value that is not a boolean leaves its key out", () => {
  // Held as unknown so values a broken store could hand over get past the
  // type check. None of them may switch a preference on.
  const junk: unknown[] = [
    { slim: 1, userLoaded: true, ringCalls: true },
    { slim: "true", userLoaded: true, ringCalls: true },
    { slim: true, userLoaded: 1, ringCalls: true },
    { slim: true, userLoaded: undefined, ringCalls: true },
    { slim: false, userLoaded: true, ringCalls: undefined },
    { slim: false, userLoaded: true, ringCalls: null },
    { slim: false, userLoaded: true, ringCalls: 0 },
    { slim: false, userLoaded: true, ringCalls: "false" },
    {},
  ];
  for (const input of junk) {
    assert.deepEqual(pushPrefs(input as PrefsInput), {}, JSON.stringify(input));
  }
});

test("withPushPrefs: keeps every field of a UnifiedPush body", () => {
  for (const prefs of ALL_PREFS) {
    assert.deepEqual(
      withPushPrefs(unifiedPushBody(), prefs),
      {
        endpoint: ENDPOINT,
        p256dh: "fake-p256dh",
        auth: "fake-auth",
        kind: "unifiedpush",
        ...prefs,
      },
      JSON.stringify(prefs),
    );
  }
});

test("withPushPrefs: keeps every field of an FCM-style body", () => {
  for (const prefs of ALL_PREFS) {
    assert.deepEqual(
      withPushPrefs(
        { endpoint: "fcm", p256dh: "", auth: "fake-fcm-token" },
        prefs,
      ),
      { endpoint: "fcm", p256dh: "", auth: "fake-fcm-token", ...prefs },
      JSON.stringify(prefs),
    );
  }
});

test("withPushPrefs: empty prefs add nothing, for every body the app posts", () => {
  for (const make of [unifiedPushBody, fcmBody, apnsBody, webPushBody]) {
    const out = withPushPrefs(make(), {});
    assert.deepEqual(out, make(), make.name);
    // The bytes on the wire too: same keys, same order, nothing added.
    assert.equal(JSON.stringify(out), JSON.stringify(make()), make.name);
  }
});

test("withPushPrefs: the input object is not mutated", () => {
  for (const make of [unifiedPushBody, fcmBody, apnsBody, webPushBody]) {
    for (const prefs of ALL_PREFS) {
      const name = `${make.name} ${JSON.stringify(prefs)}`;
      // Frozen, so a write to the input throws instead of passing unseen.
      const input = Object.freeze(make());
      const frozenPrefs = Object.freeze({ ...prefs });
      const out = withPushPrefs(input, frozenPrefs);
      assert.deepEqual(input, make(), name);
      assert.deepEqual(frozenPrefs, prefs, name);
      assert.notEqual(out, input, name);
    }
  }
});

test("withPushPrefs: only true is ever written", () => {
  // Held as unknown so a false gets past the type check, as it would from a
  // caller that built the preferences by hand.
  const off = { chats_only: false, no_ring: false } as unknown as PushPrefs;
  assert.deepEqual(withPushPrefs(fcmBody(), off), fcmBody());

  // A preference already on the body is not carried over: the result states
  // the preferences passed in and nothing else.
  const stale = { ...fcmBody(), chats_only: true, no_ring: false };
  assert.deepEqual(withPushPrefs(stale, {}), fcmBody());
  assert.deepEqual(withPushPrefs(stale, { no_ring: true }), {
    ...fcmBody(),
    no_ring: true,
  });
});

test("withPushPrefs after pushPrefs: default settings post the body unchanged", () => {
  for (const make of [unifiedPushBody, fcmBody, apnsBody, webPushBody]) {
    for (const userLoaded of [false, true]) {
      const prefs = pushPrefs({ slim: false, userLoaded, ringCalls: true });
      assert.equal(
        JSON.stringify(withPushPrefs(make(), prefs)),
        JSON.stringify(make()),
        `${make.name} userLoaded=${userLoaded}`,
      );
    }
  }
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
