// Unit spec for the iOS call-encryption kill switch (plan D14) — run with
// Node's built-in runner:
//   node --test --conditions=browser components/rtc/iosCallSwitch.test.ts
// Focus: only a strict boolean `false` from the server turns encrypted calls
// off, and only on iOS. An absent or unreachable config, or any look-alike
// value (the string "false", 0, null), keeps it ON, so a config the client
// cannot reach never turns encryption off. The switch reads nothing but the
// platform and the server value: there is no consent input through which an
// earlier per-channel "Turn off encryption" could make a switched-off call
// quiet. The value is fetched from `GET /` (never `client.configuration`,
// a stub), bounded and never rejecting: every failure resolves `undefined`,
// which reads ON. `callMediaE2EEOffered` is the one combined helper.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type IosCallSwitch,
  callMediaE2EEOffered,
  fetchIosCallSwitchValue,
  IOS_CALL_SWITCH_FETCH_TIMEOUT_MS,
  iosCallSwitch,
} from "./iosCallSwitch.ts";

type Input = Parameters<typeof iosCallSwitch>[0];

// Type-level pin (checked by the gate's project-wide tsc, not at run time):
// the input is exactly { platform, serverValue }. Adding any other key, such
// as a consent flag or a channel id, fails to compile here.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
const inputKeysPinned: Equal<keyof Input, "platform" | "serverValue"> = true;
const outputPinned: Equal<IosCallSwitch, "on" | "off"> = true;
void inputKeysPinned;
void outputPinned;

/**
 * What the production caller passes: the raw
 * `configuration.features.ios_call_e2ee` value read with optional chaining,
 * so a missing configuration or features object arrives as `undefined`.
 */
function fromConfig(platform: string, configuration: unknown): IosCallSwitch {
  const features = (
    configuration as { features?: { ios_call_e2ee?: unknown } } | undefined
  )?.features;
  return iosCallSwitch({ platform, serverValue: features?.ios_call_e2ee });
}

test("iOS with the server value strictly false is off", () => {
  assert.equal(iosCallSwitch({ platform: "ios", serverValue: false }), "off");
  assert.equal(
    fromConfig("ios", { features: { ios_call_e2ee: false } }),
    "off",
  );
});

test("iOS with the server value true is on", () => {
  assert.equal(iosCallSwitch({ platform: "ios", serverValue: true }), "on");
  assert.equal(fromConfig("ios", { features: { ios_call_e2ee: true } }), "on");
});

test("an absent or unreachable server value is on, never off", () => {
  // An older server omits the field; a config that failed to load, or has not
  // loaded yet, has no features at all. None of them may turn encryption off.
  assert.equal(
    iosCallSwitch({ platform: "ios", serverValue: undefined }),
    "on",
  );
  assert.equal(fromConfig("ios", undefined), "on");
  assert.equal(fromConfig("ios", null), "on");
  assert.equal(fromConfig("ios", {}), "on");
  assert.equal(fromConfig("ios", { features: {} }), "on");
  assert.equal(fromConfig("ios", { features: null }), "on");
});

test("look-alike values are not a strict false and stay on", () => {
  // A truthy string "false" is the classic mis-parse; 0, null and "" are the
  // falsy ones a `!value` check would wrongly read as off.
  const lookAlikes: unknown[] = [
    "false",
    "False",
    "off",
    "0",
    "",
    0,
    -0,
    Number.NaN,
    null,
    {},
    [],
    [false],
    { value: false },
    new Boolean(false),
  ];
  for (const serverValue of lookAlikes) {
    assert.equal(
      iosCallSwitch({ platform: "ios", serverValue }),
      "on",
      `serverValue ${String(serverValue)} (${typeof serverValue})`,
    );
  }
});

test("every non-iOS platform is on, even with the server value false", () => {
  // The switch exists only for iPhone. Android, the web build and the desktop
  // shells must never be paused by it.
  for (const platform of ["android", "web", "electron", "tauri", ""]) {
    assert.equal(
      iosCallSwitch({ platform, serverValue: false }),
      "on",
      `platform ${JSON.stringify(platform)}`,
    );
    assert.equal(
      fromConfig(platform, { features: { ios_call_e2ee: false } }),
      "on",
      `platform ${JSON.stringify(platform)} via config`,
    );
  }
});

test("the verdict is always exactly 'on' or 'off'", () => {
  const cases: Input[] = [
    { platform: "ios", serverValue: false },
    { platform: "ios", serverValue: true },
    { platform: "ios", serverValue: undefined },
    { platform: "android", serverValue: false },
  ];
  for (const input of cases) {
    const verdict = iosCallSwitch(input);
    assert.ok(verdict === "on" || verdict === "off", String(verdict));
  }
});

test("it reads only platform and serverValue: no consent input exists", () => {
  // The switch must never reuse an earlier per-channel plaintext consent. Its
  // half of that rule is structural: it has no way to see one. Record every
  // property the function touches on a bag that also carries consent-shaped
  // keys, and require that it touched nothing but the two declared inputs.
  const consentBait = {
    plaintextConsent: true,
    confirmedPlaintext: true,
    callPlaintextConfirmed: true,
    consent: true,
    channelId: "01CHANNEL",
    userId: "01USER",
  };
  const cases: Array<[string, unknown, IosCallSwitch]> = [
    ["ios", false, "off"],
    ["ios", true, "on"],
    ["ios", undefined, "on"],
    ["android", false, "on"],
  ];
  for (const [platform, serverValue, expected] of cases) {
    const read = new Set<PropertyKey>();
    const bag = new Proxy(
      { platform, serverValue, ...consentBait },
      {
        get(target, key, receiver) {
          read.add(key);
          return Reflect.get(target, key, receiver);
        },
        has(target, key) {
          read.add(key);
          return Reflect.has(target, key);
        },
      },
    );
    const label = `${platform}/${String(serverValue)}`;
    assert.equal(iosCallSwitch(bag), expected, label);
    for (const key of read) {
      assert.ok(
        key === "platform" || key === "serverValue",
        `${label}: read ${String(key)}`,
      );
    }
    // And the consent-shaped keys change nothing.
    assert.equal(iosCallSwitch({ platform, serverValue }), expected, label);
  }
  assert.equal(iosCallSwitch.length, 1);
});

// ---------------------------------------------------------------------------
// fetchIosCallSwitchValue: `GET /`, bounded, never rejects (Stage 5 B1).
// `client.configuration` is a local stub the SDK never fills, so the value
// must come from the root route itself.
// ---------------------------------------------------------------------------

/** Manual timers: nothing fires until the spec fires it. */
function fakeTimers() {
  const armed: Array<{ fire: () => void; ms: number; handle: number }> = [];
  const cleared: number[] = [];
  let next = 1;
  return {
    armed,
    cleared,
    setTimeout: (fire: () => void, ms: number) => {
      const handle = next++;
      armed.push({ fire, ms, handle });
      return handle;
    },
    clearTimeout: (handle: number) => {
      cleared.push(handle);
    },
  };
}

/** The shape production hands in: the SDK client's `api.get("/")`. */
type RootClient = { api: { get(path: "/"): Promise<unknown> } };

function rootClient(body: unknown): RootClient {
  return { api: { get: async () => body } };
}

/** Let every pending microtask and one macrotask run. */
function drain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("the default bound is 3 s and the timer is armed with it", async () => {
  assert.equal(IOS_CALL_SWITCH_FETCH_TIMEOUT_MS, 3_000);
  const t = fakeTimers();
  const client = rootClient({ features: { ios_call_e2ee: true } });
  await fetchIosCallSwitchValue({
    fetchRoot: () => client.api.get("/"),
    setTimeout: t.setTimeout,
    clearTimeout: t.clearTimeout,
  });
  assert.equal(t.armed.length, 1);
  assert.equal(t.armed[0].ms, 3_000);
});

test("a real false from GET / passes through and reads off on iOS", async () => {
  const t = fakeTimers();
  const client = rootClient({
    revolt: "0.8",
    features: { ios_call_e2ee: false, autumn: { enabled: true } },
  });
  const value = await fetchIosCallSwitchValue({
    fetchRoot: () => client.api.get("/"),
    setTimeout: t.setTimeout,
    clearTimeout: t.clearTimeout,
  });
  assert.strictEqual(value, false);
  assert.equal(iosCallSwitch({ platform: "ios", serverValue: value }), "off");
  // Settling clears the bound; nothing is left armed behind the call.
  assert.deepEqual(t.cleared, [t.armed[0].handle]);
});

test("true and non-boolean values pass through RAW, never coerced", async () => {
  for (const raw of [true, "false", 0, null]) {
    const t = fakeTimers();
    const client = rootClient({ features: { ios_call_e2ee: raw } });
    const value = await fetchIosCallSwitchValue({
      fetchRoot: () => client.api.get("/"),
      setTimeout: t.setTimeout,
      clearTimeout: t.clearTimeout,
    });
    assert.strictEqual(value, raw, `raw ${String(raw)}`);
    assert.equal(
      iosCallSwitch({ platform: "ios", serverValue: value }),
      "on",
      `raw ${String(raw)}`,
    );
  }
});

test("a timeout resolves undefined (reads on); a late answer changes nothing", async () => {
  const t = fakeTimers();
  let answerLate!: (body: unknown) => void;
  let settled = false;
  const pending = fetchIosCallSwitchValue({
    fetchRoot: () =>
      new Promise((resolve) => {
        answerLate = resolve;
      }),
    setTimeout: t.setTimeout,
    clearTimeout: t.clearTimeout,
  }).then((value) => {
    settled = true;
    return value;
  });
  await drain();
  assert.equal(settled, false, "waits for the root route until the bound");
  assert.equal(t.armed.length, 1);
  t.armed[0].fire();
  const value = await pending;
  assert.strictEqual(value, undefined);
  assert.equal(iosCallSwitch({ platform: "ios", serverValue: value }), "on");
  answerLate({ features: { ios_call_e2ee: false } });
  await drain();
  assert.strictEqual(await pending, undefined);
});

test("a rejecting or throwing fetch resolves undefined, never rejects", async () => {
  const fetchers: Array<[string, () => Promise<unknown>]> = [
    ["async reject", () => Promise.reject(new Error("503"))],
    [
      "sync throw",
      () => {
        throw new Error("no transport");
      },
    ],
    [
      // The production call with no client yet: `client.api` throws
      // synchronously inside fetchRoot.
      "no client",
      () => (undefined as unknown as RootClient).api.get("/"),
    ],
  ];
  for (const [name, fetchRoot] of fetchers) {
    const t = fakeTimers();
    const value = await fetchIosCallSwitchValue({
      fetchRoot,
      setTimeout: t.setTimeout,
      clearTimeout: t.clearTimeout,
    });
    assert.strictEqual(value, undefined, name);
    assert.equal(
      iosCallSwitch({ platform: "ios", serverValue: value }),
      "on",
      name,
    );
  }
});

test("a body that does not carry the key resolves undefined", async () => {
  const hostile = {
    get features(): unknown {
      throw new Error("getter");
    },
  };
  const bodies: unknown[] = [
    undefined,
    null,
    "ok",
    42,
    [],
    {},
    { features: null },
    { features: [] },
    { features: "x" },
    { features: {} },
    { features: { autumn: { enabled: true } } },
    hostile,
  ];
  for (const [index, body] of bodies.entries()) {
    const t = fakeTimers();
    const client = rootClient(body);
    const value = await fetchIosCallSwitchValue({
      fetchRoot: () => client.api.get("/"),
      setTimeout: t.setTimeout,
      clearTimeout: t.clearTimeout,
    });
    assert.strictEqual(value, undefined, `body #${index}`);
  }
});

test("a late rejection after the timeout is handled, not unhandled", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const t = fakeTimers();
    let rejectLate!: (error: unknown) => void;
    const pending = fetchIosCallSwitchValue({
      fetchRoot: () =>
        new Promise((_resolve, reject) => {
          rejectLate = reject;
        }),
      setTimeout: t.setTimeout,
      clearTimeout: t.clearTimeout,
    });
    t.armed[0].fire();
    assert.strictEqual(await pending, undefined);
    rejectLate(new Error("late 503"));
    await drain();
    await drain();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a custom bound is honoured; an unusable one reads on at once", async () => {
  const t = fakeTimers();
  const client = rootClient({ features: { ios_call_e2ee: false } });
  const value = await fetchIosCallSwitchValue({
    fetchRoot: () => client.api.get("/"),
    setTimeout: t.setTimeout,
    clearTimeout: t.clearTimeout,
    timeoutMs: 50,
  });
  assert.strictEqual(value, false);
  assert.equal(t.armed[0].ms, 50);

  for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const bad = fakeTimers();
    let fetched = 0;
    const result = await fetchIosCallSwitchValue({
      fetchRoot: () => {
        fetched++;
        return client.api.get("/");
      },
      setTimeout: bad.setTimeout,
      clearTimeout: bad.clearTimeout,
      timeoutMs,
    });
    assert.strictEqual(result, undefined, `timeoutMs ${timeoutMs}`);
    assert.equal(fetched, 0, `timeoutMs ${timeoutMs}: no unbounded fetch`);
    assert.equal(bad.armed.length, 0, `timeoutMs ${timeoutMs}`);
  }
});

test("a timer that cannot be armed reads on rather than hanging", async () => {
  const value = await fetchIosCallSwitchValue({
    fetchRoot: () => new Promise(() => {}),
    setTimeout: () => {
      throw new Error("no timers");
    },
    clearTimeout: () => {},
  });
  assert.strictEqual(value, undefined);
});

test("the timer functions are called unbound (window globals pass straight in)", async () => {
  // A browser's window.setTimeout throws "Illegal invocation" when called
  // with `this` set to the deps bag. Model that: reject any bound call.
  const t = fakeTimers();
  const client = rootClient({ features: { ios_call_e2ee: false } });
  const value = await fetchIosCallSwitchValue({
    fetchRoot: () => client.api.get("/"),
    setTimeout: function (this: unknown, fire: () => void, ms: number) {
      if (this !== undefined) throw new TypeError("Illegal invocation");
      return t.setTimeout(fire, ms);
    },
    clearTimeout: function (this: unknown, handle: number) {
      if (this !== undefined) throw new TypeError("Illegal invocation");
      t.clearTimeout(handle);
    },
  });
  assert.strictEqual(value, false);
  assert.deepEqual(t.cleared, [t.armed[0].handle]);
});

// ---------------------------------------------------------------------------
// callMediaE2EEOffered: the ONE combined helper (call, prejoin, Settings).
// ---------------------------------------------------------------------------

test("media encryption is offered only when the shell supports it AND the switch is on", () => {
  assert.equal(callMediaE2EEOffered(true, "on"), true);
  assert.equal(callMediaE2EEOffered(true, "off"), false);
  assert.equal(callMediaE2EEOffered(false, "on"), false);
  assert.equal(callMediaE2EEOffered(false, "off"), false);
});

test("the helper composes with the switch end to end", () => {
  // A paused iPhone is not offered encryption; every other platform with the
  // same server value still is, and an unreachable value stays offered.
  const sw = (platform: string) =>
    iosCallSwitch({ platform, serverValue: false });
  assert.equal(callMediaE2EEOffered(true, sw("ios")), false);
  assert.equal(callMediaE2EEOffered(true, sw("android")), true);
  assert.equal(
    callMediaE2EEOffered(
      true,
      iosCallSwitch({ platform: "ios", serverValue: undefined }),
    ),
    true,
  );
});

test("the helper is strict about junk inputs (no truthy coercion)", () => {
  // Typed callers cannot pass these; a cast or an `any` upstream still must
  // not turn into an offer.
  assert.equal(callMediaE2EEOffered(1 as never, "on"), false);
  assert.equal(callMediaE2EEOffered("true" as never, "on"), false);
  assert.equal(callMediaE2EEOffered(true, undefined as never), false);
  assert.equal(callMediaE2EEOffered(true, "ON" as never), false);
  assert.equal(callMediaE2EEOffered(true, "" as never), false);
});
