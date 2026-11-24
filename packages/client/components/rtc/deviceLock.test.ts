// Unit spec for the device lock module. Run with Node's built-in runner from
// packages/client:
//   node --test --conditions=browser components/rtc/deviceLock.test.ts
// Declared test count: 27 (compare against the runner's pass count, since the
// runner also exits 0 when it finds no tests at all).
// Focus: on Android every doubt reads as locked. Only an answer whose
// `locked` is exactly `false` reads as not locked, and only one whose
// `unlocked` is exactly `true` reads as unlocked. A failed call, a missing
// answer and a field of another type never do. On web and iOS the device is
// never locked and the plugin is never called. Neither question rejects.
// The first half pins `lockedFrom` and `unlockedFrom` over every platform and
// every answer shape. The second half drives `deviceLocked` and
// `ensureDeviceUnlocked` through a stand-in plugin.
import assert from "node:assert/strict";
import { test } from "node:test";

type Platform = "web" | "android" | "ios";
const PLATFORMS: Platform[] = ["web", "android", "ios"];

// Capacitor picks up its bridge from the global object when it is first
// loaded, so a stand-in bridge has to be in place before the module under
// test is imported. That is why the imports below are dynamic and come after
// this block. Capacitor reads the platform from the global object each time
// it is asked, so a test picks its platform by swapping the marker objects.
// The stand-in records every call that would have crossed to the native side
// and answers it with whatever the test set up. Capacitor prints an "already
// registered" warning each time the module looks the plugin up again, and
// the module prints a warning for each failed call. Both are harmless here.
type NativeCall = { plugin: string; method: string; options: unknown };
const nativeCalls: NativeCall[] = [];

/** What the stand-in plugin does with a call. Each test sets its own. */
let respond: (method: string) => unknown = () => Promise.resolve(undefined);

const LOCK_METHODS = [
  { name: "isLocked", rtype: "promise" },
  { name: "ensureUnlocked", rtype: "promise" },
];
const pushTokenHeader = { name: "PushToken", methods: [...LOCK_METHODS] };

Object.assign(globalThis, {
  androidBridge: {},
  Capacitor: {
    PluginHeaders: [pushTokenHeader],
    nativePromise(plugin: string, method: string, options: unknown) {
      nativeCalls.push({ plugin, method, options });
      return respond(method);
    },
  },
});

const loaded = import("./deviceLock.ts");
const capacitor = import("@capacitor/core");

const host = globalThis as unknown as Record<string, unknown>;

/** Makes Capacitor report `platform` from now on, and forgets earlier calls. */
function usePlatform(platform: Platform) {
  delete host.androidBridge;
  delete host.webkit;
  if (platform === "android") host.androidBridge = {};
  if (platform === "ios") host.webkit = { messageHandlers: { bridge: {} } };
  nativeCalls.length = 0;
}

const answers = (value: unknown) => () => Promise.resolve(value);
const rejects = (reason: unknown) => () => Promise.reject(reason);

/** Lets pending promise chains run. `setImmediate` is never mocked here. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The methods the stand-in was asked for, in order. */
const calledMethods = () =>
  nativeCalls.map((call) => `${call.plugin}.${call.method}`);

// ---------------------------------------------------------------------------
// The pure functions.
// ---------------------------------------------------------------------------

const errorWithFields = Object.assign(new Error("failed"), {
  locked: false,
  unlocked: true,
});
const arrayWithFields = Object.assign([false, true], {
  locked: false,
  unlocked: true,
});
const functionWithFields = Object.assign(() => undefined, {
  locked: false,
  unlocked: true,
});
const inheritedFields: unknown = Object.create({
  locked: false,
  unlocked: true,
});
const throwingFields = {
  get locked(): boolean {
    throw new Error("unreadable");
  },
  get unlocked(): boolean {
    throw new Error("unreadable");
  },
};

/** Every answer shape the tables run over, each under a unique label. */
const RESULTS: [label: string, value: unknown][] = [
  ["{ locked: false }", { locked: false }],
  ["{ locked: true }", { locked: true }],
  ["{ unlocked: true }", { unlocked: true }],
  ["{ unlocked: false }", { unlocked: false }],
  ["{ locked: false, unlocked: true }", { locked: false, unlocked: true }],
  ["{ locked: true, unlocked: true }", { locked: true, unlocked: true }],
  ["{ locked: false, unlocked: false }", { locked: false, unlocked: false }],
  ["{ locked: true, unlocked: false }", { locked: true, unlocked: false }],
  ["{}", {}],
  ['{ locked: "false" }', { locked: "false" }],
  ['{ locked: "" }', { locked: "" }],
  ["{ locked: 0 }", { locked: 0 }],
  ["{ locked: null }", { locked: null }],
  ["{ locked: undefined }", { locked: undefined }],
  ["{ locked: new Boolean(false) }", { locked: new Boolean(false) }],
  ['{ unlocked: "true" }', { unlocked: "true" }],
  ["{ unlocked: 1 }", { unlocked: 1 }],
  ["{ unlocked: {} }", { unlocked: {} }],
  ["{ unlocked: [true] }", { unlocked: [true] }],
  ["{ unlocked: new Boolean(true) }", { unlocked: new Boolean(true) }],
  ["{ Locked: false, Unlocked: true }", { Locked: false, Unlocked: true }],
  ["null", null],
  ["undefined", undefined],
  ["an Error", new Error("failed")],
  ["an Error carrying both fields", errorWithFields],
  ["an array carrying both fields", arrayWithFields],
  ["a function carrying both fields", functionWithFields],
  ["an object that only inherits both fields", inheritedFields],
  ["an object whose fields throw when read", throwingFields],
  ['"locked"', "locked"],
  ['"false"', "false"],
  ['"true"', "true"],
  ['""', ""],
  [
    'the text of { "locked": false, "unlocked": true }',
    '{"locked":false,"unlocked":true}',
  ],
  ["false", false],
  ["true", true],
  ["0", 0],
  ["1", 1],
];

/** The only rows that read as not locked on Android. */
const NOT_LOCKED_ON_ANDROID = new Set([
  "{ locked: false }",
  "{ locked: false, unlocked: true }",
  "{ locked: false, unlocked: false }",
]);

/** The only rows that read as unlocked on Android. */
const UNLOCKED_ON_ANDROID = new Set([
  "{ unlocked: true }",
  "{ locked: false, unlocked: true }",
  "{ locked: true, unlocked: true }",
]);

test("the answer table has unique labels and names every exception row", () => {
  const labels = RESULTS.map(([label]) => label);
  assert.equal(new Set(labels).size, labels.length);
  assert.equal(labels.length, 38);
  for (const label of [...NOT_LOCKED_ON_ANDROID, ...UNLOCKED_ON_ANDROID]) {
    assert.ok(labels.includes(label), label);
  }
});

test("lockedFrom: the full table over every platform", async () => {
  const { lockedFrom } = await loaded;
  let checked = 0;
  for (const platform of PLATFORMS) {
    for (const [label, value] of RESULTS) {
      const expected =
        platform === "android" ? !NOT_LOCKED_ON_ANDROID.has(label) : false;
      assert.equal(
        lockedFrom(platform, value),
        expected,
        `${platform} ${label}`,
      );
      checked++;
    }
  }
  assert.equal(checked, 3 * 38);
});

test("unlockedFrom: the full table over every platform", async () => {
  const { unlockedFrom } = await loaded;
  let checked = 0;
  for (const platform of PLATFORMS) {
    for (const [label, value] of RESULTS) {
      const expected =
        platform === "android" ? UNLOCKED_ON_ANDROID.has(label) : true;
      assert.equal(
        unlockedFrom(platform, value),
        expected,
        `${platform} ${label}`,
      );
      checked++;
    }
  }
  assert.equal(checked, 3 * 38);
});

// The rows below repeat the ones that matter most as plain statements, so a
// mistake in the table's expectations cannot hide a mistake in the module.

test("on Android only locked exactly false reads as not locked", async () => {
  const { lockedFrom } = await loaded;
  assert.equal(lockedFrom("android", { locked: false }), false);
  assert.equal(lockedFrom("android", { locked: true }), true);
});

test("on Android a failed or malformed lock answer reads as locked", async () => {
  const { lockedFrom } = await loaded;
  assert.equal(lockedFrom("android", new Error("failed")), true);
  assert.equal(lockedFrom("android", undefined), true);
  assert.equal(lockedFrom("android", null), true);
  assert.equal(lockedFrom("android", "false"), true);
  assert.equal(lockedFrom("android", {}), true);
  assert.equal(lockedFrom("android", { locked: "false" }), true);
  assert.equal(lockedFrom("android", { locked: 0 }), true);
  assert.equal(lockedFrom("android", { unlocked: true }), true);
});

test("on Android only unlocked exactly true reads as unlocked", async () => {
  const { unlockedFrom } = await loaded;
  assert.equal(unlockedFrom("android", { unlocked: true }), true);
  assert.equal(unlockedFrom("android", { unlocked: false }), false);
});

test("on Android a failed or malformed unlock answer reads as not unlocked", async () => {
  const { unlockedFrom } = await loaded;
  assert.equal(unlockedFrom("android", new Error("failed")), false);
  assert.equal(unlockedFrom("android", undefined), false);
  assert.equal(unlockedFrom("android", null), false);
  assert.equal(unlockedFrom("android", "true"), false);
  assert.equal(unlockedFrom("android", {}), false);
  assert.equal(unlockedFrom("android", { unlocked: "true" }), false);
  assert.equal(unlockedFrom("android", { unlocked: 1 }), false);
  assert.equal(unlockedFrom("android", { locked: false }), false);
});

test("web and iOS are never locked and always unlocked, whatever came back", async () => {
  const { lockedFrom, unlockedFrom } = await loaded;
  for (const platform of ["web", "ios"] as const) {
    assert.equal(lockedFrom(platform, { locked: true }), false, platform);
    assert.equal(lockedFrom(platform, new Error("failed")), false, platform);
    assert.equal(lockedFrom(platform, undefined), false, platform);
    assert.equal(unlockedFrom(platform, { unlocked: false }), true, platform);
    assert.equal(unlockedFrom(platform, new Error("failed")), true, platform);
    assert.equal(unlockedFrom(platform, undefined), true, platform);
  }
});

test("on Android a caught error is never an answer, whatever fields it carries", async () => {
  const { lockedFrom, unlockedFrom } = await loaded;
  assert.equal(errorWithFields.locked, false);
  assert.equal(errorWithFields.unlocked, true);
  assert.equal(lockedFrom("android", errorWithFields), true);
  assert.equal(unlockedFrom("android", errorWithFields), false);
});

test("on Android an inherited or unreadable field does not count", async () => {
  const { lockedFrom, unlockedFrom } = await loaded;
  const inherited = inheritedFields as { locked: boolean; unlocked: boolean };
  assert.equal(inherited.locked, false);
  assert.equal(inherited.unlocked, true);
  assert.equal(lockedFrom("android", inheritedFields), true);
  assert.equal(unlockedFrom("android", inheritedFields), false);
  assert.equal(lockedFrom("android", throwingFields), true);
  assert.equal(unlockedFrom("android", throwingFields), false);
});

test("a platform outside the three is read as strictly as Android", async () => {
  const { lockedFrom, unlockedFrom } = await loaded;
  for (const platform of ["electron", "", "Android", "WEB", undefined]) {
    const stray = platform as unknown as Platform;
    assert.equal(lockedFrom(stray, undefined), true, String(platform));
    assert.equal(lockedFrom(stray, { locked: false }), false, String(platform));
    assert.equal(unlockedFrom(stray, undefined), false, String(platform));
    assert.equal(
      unlockedFrom(stray, { unlocked: true }),
      true,
      String(platform),
    );
  }
});

// ---------------------------------------------------------------------------
// The two questions, through the stand-in plugin.
// ---------------------------------------------------------------------------

test("the stand-in makes Capacitor report each platform", async () => {
  const { Capacitor } = await capacitor;
  for (const platform of PLATFORMS) {
    usePlatform(platform);
    assert.equal(Capacitor.getPlatform(), platform);
    assert.equal(Capacitor.isNativePlatform(), platform !== "web");
  }
});

test("Android: deviceLocked asks isLocked once and reads the exact answer", async () => {
  const { deviceLocked } = await loaded;
  usePlatform("android");
  respond = answers({ locked: false });
  assert.equal(await deviceLocked(), false);
  assert.deepEqual(calledMethods(), ["PushToken.isLocked"]);

  usePlatform("android");
  respond = answers({ locked: true });
  assert.equal(await deviceLocked(), true);
  assert.deepEqual(calledMethods(), ["PushToken.isLocked"]);
});

test("Android: deviceLocked reads any other answer as locked", async () => {
  const { deviceLocked } = await loaded;
  const others: unknown[] = [
    {},
    { locked: "false" },
    { locked: 0 },
    { locked: null },
    { unlocked: true },
    null,
    undefined,
    "false",
    false,
    [false],
  ];
  for (const [index, other] of others.entries()) {
    usePlatform("android");
    respond = answers(other);
    assert.equal(await deviceLocked(), true, `row ${index}`);
    assert.deepEqual(calledMethods(), ["PushToken.isLocked"], `row ${index}`);
  }
});

test("Android: deviceLocked reads a rejected call as locked and does not reject", async () => {
  const { deviceLocked } = await loaded;
  // The plain objects are here because a rejection must not be read as an
  // answer, even when it carries the very field an answer would.
  const reasons: unknown[] = [
    new Error("failed"),
    Object.assign(new Error("failed"), { locked: false }),
    { locked: false },
    { code: "UNIMPLEMENTED" },
    "failed",
    undefined,
    null,
    false,
  ];
  for (const [index, reason] of reasons.entries()) {
    usePlatform("android");
    respond = rejects(reason);
    assert.equal(await deviceLocked(), true, `row ${index}`);
    assert.deepEqual(calledMethods(), ["PushToken.isLocked"], `row ${index}`);
  }
});

test("Android: deviceLocked reads a bridge that throws as locked", async () => {
  const { deviceLocked } = await loaded;
  usePlatform("android");
  respond = () => {
    throw new Error("bridge down");
  };
  assert.equal(await deviceLocked(), true);
  assert.deepEqual(calledMethods(), ["PushToken.isLocked"]);
});

test("Android: a shell without the two methods reads as locked and not unlocked", async () => {
  const { deviceLocked, ensureDeviceUnlocked } = await loaded;
  usePlatform("android");
  respond = answers({ locked: false, unlocked: true });
  pushTokenHeader.methods.length = 0;
  try {
    assert.equal(await deviceLocked(), true);
    assert.equal(await ensureDeviceUnlocked(), false);
    assert.deepEqual(calledMethods(), []);
  } finally {
    pushTokenHeader.methods.push(...LOCK_METHODS);
  }
  // With the methods back the same answer is read, so it was their absence
  // that read as locked above.
  assert.equal(await deviceLocked(), false);
  assert.equal(await ensureDeviceUnlocked(), true);
});

test("Android: ensureDeviceUnlocked asks ensureUnlocked once and reads the exact answer", async () => {
  const { ensureDeviceUnlocked } = await loaded;
  usePlatform("android");
  respond = answers({ unlocked: true });
  assert.equal(await ensureDeviceUnlocked(), true);
  assert.deepEqual(calledMethods(), ["PushToken.ensureUnlocked"]);

  usePlatform("android");
  respond = answers({ unlocked: false });
  assert.equal(await ensureDeviceUnlocked(), false);
  assert.deepEqual(calledMethods(), ["PushToken.ensureUnlocked"]);
});

test("Android: ensureDeviceUnlocked reads any other answer as not unlocked", async () => {
  const { ensureDeviceUnlocked } = await loaded;
  const others: unknown[] = [
    {},
    { unlocked: "true" },
    { unlocked: 1 },
    { unlocked: {} },
    { locked: false },
    null,
    undefined,
    "true",
    true,
    [true],
  ];
  for (const [index, other] of others.entries()) {
    usePlatform("android");
    respond = answers(other);
    assert.equal(await ensureDeviceUnlocked(), false, `row ${index}`);
    assert.deepEqual(
      calledMethods(),
      ["PushToken.ensureUnlocked"],
      `row ${index}`,
    );
  }
});

test("Android: ensureDeviceUnlocked reads a rejected call as not unlocked and does not reject", async () => {
  const { ensureDeviceUnlocked } = await loaded;
  const reasons: unknown[] = [
    new Error("failed"),
    Object.assign(new Error("failed"), { unlocked: true }),
    { unlocked: true },
    { code: "UNIMPLEMENTED" },
    "failed",
    undefined,
    null,
    true,
  ];
  for (const [index, reason] of reasons.entries()) {
    usePlatform("android");
    respond = rejects(reason);
    assert.equal(await ensureDeviceUnlocked(), false, `row ${index}`);
    assert.deepEqual(
      calledMethods(),
      ["PushToken.ensureUnlocked"],
      `row ${index}`,
    );
  }
});

test("Android: ensureDeviceUnlocked reads a bridge that throws as not unlocked", async () => {
  const { ensureDeviceUnlocked } = await loaded;
  usePlatform("android");
  respond = () => {
    throw new Error("bridge down");
  };
  assert.equal(await ensureDeviceUnlocked(), false);
  assert.deepEqual(calledMethods(), ["PushToken.ensureUnlocked"]);
});

test("Android: ensureDeviceUnlocked waits for a slow unlock with no time limit of its own", async (t) => {
  const { ensureDeviceUnlocked } = await loaded;
  usePlatform("android");
  // Held in an object so the checker does not assume it is still unset.
  const unlock: { finish?: (value: unknown) => void } = {};
  respond = () =>
    new Promise((resolve) => {
      unlock.finish = resolve;
    });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const seen: { value?: boolean } = {};
    const pending = ensureDeviceUnlocked().then((value) => {
      seen.value = value;
      return value;
    });
    await flush();
    assert.deepEqual(calledMethods(), ["PushToken.ensureUnlocked"]);
    // Ten minutes of timers, far past the minute the Android side may take.
    t.mock.timers.tick(10 * 60_000);
    await flush();
    assert.equal("value" in seen, false);
    assert.ok(unlock.finish);
    unlock.finish({ unlocked: true });
    assert.equal(await pending, true);
  } finally {
    t.mock.timers.reset();
  }
});

test("web: deviceLocked is false and the plugin is never called", async () => {
  const { deviceLocked } = await loaded;
  for (const respondWith of [
    answers({ locked: true }),
    answers({ locked: false }),
    rejects(new Error("failed")),
  ]) {
    usePlatform("web");
    respond = respondWith;
    assert.equal(await deviceLocked(), false);
    await flush();
    assert.deepEqual(nativeCalls, []);
  }
});

test("web: ensureDeviceUnlocked is true and the plugin is never called", async () => {
  const { ensureDeviceUnlocked } = await loaded;
  for (const respondWith of [
    answers({ unlocked: false }),
    answers({ unlocked: true }),
    rejects(new Error("failed")),
  ]) {
    usePlatform("web");
    respond = respondWith;
    assert.equal(await ensureDeviceUnlocked(), true);
    await flush();
    assert.deepEqual(nativeCalls, []);
  }
});

test("iOS: deviceLocked is false and the plugin is never called", async () => {
  const { deviceLocked } = await loaded;
  for (const respondWith of [
    answers({ locked: true }),
    answers({ locked: false }),
    rejects(new Error("failed")),
  ]) {
    usePlatform("ios");
    respond = respondWith;
    assert.equal(await deviceLocked(), false);
    await flush();
    assert.deepEqual(nativeCalls, []);
  }
});

test("iOS: ensureDeviceUnlocked is true and the plugin is never called", async () => {
  const { ensureDeviceUnlocked } = await loaded;
  for (const respondWith of [
    answers({ unlocked: false }),
    answers({ unlocked: true }),
    rejects(new Error("failed")),
  ]) {
    usePlatform("ios");
    respond = respondWith;
    assert.equal(await ensureDeviceUnlocked(), true);
    await flush();
    assert.deepEqual(nativeCalls, []);
  }
});

test("a platform that cannot be read is treated as Android and nothing rejects", async () => {
  const { deviceLocked, ensureDeviceUnlocked } = await loaded;
  usePlatform("web");
  Object.defineProperty(host, "androidBridge", {
    configurable: true,
    get() {
      throw new Error("unreadable");
    },
  });
  try {
    respond = rejects(new Error("failed"));
    assert.equal(await deviceLocked(), true);
    assert.equal(await ensureDeviceUnlocked(), false);
  } finally {
    delete host.androidBridge;
  }
});
