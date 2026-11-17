// Unit spec for the incoming-ring module. Run with Node's built-in runner:
//   node --test --conditions=browser components/rtc/ringDuration.test.ts
// Focus: the ring length taken from the server's advertised seconds never
// leaves the 5 to 120 second window, and dismissing a ring tells the Android
// notification plugin the reason only when a reason was given.
import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  IncomingCall,
  IncomingCallDismissReason,
} from "./incomingCall.ts";

// Capacitor picks up its bridge from the global object when it is first
// loaded, so a stand-in Android bridge has to be in place before the module
// under test is imported. That is why the import below is dynamic and comes
// after this block. The stand-in records every call that would have crossed
// to the native side. Capacitor prints an "already registered" warning each
// time the module looks the plugin up again, which is harmless here.
type NativeCall = { plugin: string; method: string; options: unknown };
const nativeCalls: NativeCall[] = [];
Object.assign(globalThis, {
  androidBridge: {},
  Capacitor: {
    PluginHeaders: [
      {
        name: "PushToken",
        methods: [{ name: "dismissCallNotification", rtype: "promise" }],
      },
    ],
    nativePromise(plugin: string, method: string, options: unknown) {
      nativeCalls.push({ plugin, method, options });
      return Promise.resolve();
    },
  },
});

const loaded = import("./incomingCall.ts");

const FALLBACK = 45_000;

test("the fallback is 45 s and the old constant still equals it", async () => {
  const { INCOMING_CALL_TIMEOUT_MS, RING_FALLBACK_MS } = await loaded;
  assert.equal(RING_FALLBACK_MS, FALLBACK);
  assert.equal(INCOMING_CALL_TIMEOUT_MS, RING_FALLBACK_MS);
});

test("a number from 5 to 120 seconds is used as the ring length", async () => {
  const { ringDurationMs } = await loaded;
  const rows: [input: number, expected: number][] = [
    [5, 5_000],
    [45, 45_000],
    [60, 60_000],
    [120, 120_000],
  ];
  for (const [input, expected] of rows) {
    assert.equal(ringDurationMs(input), expected, String(input));
  }
});

test("a number outside 5 to 120 seconds falls back to 45 s", async () => {
  const { ringDurationMs } = await loaded;
  // 4.999 and 120.001 sit just outside each end, so an off-by-one on either
  // bound shows up here and not only at the whole numbers.
  for (const input of [0, 4, 4.999, 120.001, 121, 3600, -1, -45]) {
    assert.equal(ringDurationMs(input), FALLBACK, String(input));
  }
});

test("a number that is not finite falls back to 45 s", async () => {
  const { ringDurationMs } = await loaded;
  for (const input of [NaN, Infinity, -Infinity]) {
    assert.equal(ringDurationMs(input), FALLBACK, String(input));
  }
});

test("a value that is not a number falls back to 45 s", async () => {
  const { ringDurationMs } = await loaded;
  // "60" is here beside "45" because a string that was wrongly accepted as
  // 45 would give the same answer as the fallback and hide the mistake.
  const inputs: unknown[] = [
    undefined,
    null,
    "45",
    "60",
    "",
    true,
    60n,
    [60],
    { secs: 60 },
    new Number(60),
  ];
  for (const input of inputs) {
    assert.equal(
      ringDurationMs(input),
      FALLBACK,
      `${typeof input} ${String(input)}`,
    );
  }
});

test("a fractional value in range is accepted and rounded to whole ms", async () => {
  const { ringDurationMs } = await loaded;
  assert.equal(ringDurationMs(45.5), 45_500);
  // 5.0004 s is 5000.4 ms and 59.9996 s is 59999.6 ms.
  assert.equal(ringDurationMs(5.0004), 5_000);
  assert.equal(ringDurationMs(59.9996), 60_000);
  for (const input of [5.0004, 45.5, 59.9996, 119.99949]) {
    const ms = ringDurationMs(input);
    assert.ok(Number.isInteger(ms), `${input} gave ${ms}`);
    assert.ok(ms >= 5_000 && ms <= 120_000, `${input} gave ${ms}`);
  }
});

const channel = (id: string) => ({ id }) as unknown as IncomingCall["channel"];

/** Waits for the plugin call, which Capacitor makes on a later tick. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const REASONS: IncomingCallDismissReason[] = [
  "answered",
  "declined",
  "timeout",
  "ended",
  "elsewhere",
];

test("a dismiss with a reason sends that reason to the plugin", async () => {
  const { dismissIncomingCall, incomingCall, presentIncomingCall } =
    await loaded;
  for (const reason of REASONS) {
    nativeCalls.length = 0;
    presentIncomingCall({ channel: channel("chan-a"), receivedAt: 1 });
    dismissIncomingCall("chan-a", reason);
    await settle();
    assert.equal(incomingCall(), undefined, reason);
    assert.deepEqual(
      nativeCalls,
      [
        {
          plugin: "PushToken",
          method: "dismissCallNotification",
          options: { channelId: "chan-a", reason },
        },
      ],
      reason,
    );
  }
});

test("a dismiss with a reason and no channel id uses the ringing channel", async () => {
  const { dismissIncomingCall, incomingCall, presentIncomingCall } =
    await loaded;
  nativeCalls.length = 0;
  presentIncomingCall({ channel: channel("chan-a"), receivedAt: 1 });
  dismissIncomingCall(undefined, "timeout");
  await settle();
  assert.equal(incomingCall(), undefined);
  assert.deepEqual(
    nativeCalls.map((call) => call.options),
    [{ channelId: "chan-a", reason: "timeout" }],
  );
});

test("a dismiss without a reason sends the channel id and no reason key", async () => {
  const { dismissIncomingCall, incomingCall, presentIncomingCall } =
    await loaded;
  // The three ways today's callers spell "no reason".
  const dismissals = [
    () => dismissIncomingCall(),
    () => dismissIncomingCall("chan-a"),
    () => dismissIncomingCall(undefined, undefined),
  ];
  for (const [index, dismiss] of dismissals.entries()) {
    nativeCalls.length = 0;
    presentIncomingCall({ channel: channel("chan-a"), receivedAt: 1 });
    dismiss();
    await settle();
    assert.equal(incomingCall(), undefined, `form ${index}`);
    assert.equal(nativeCalls.length, 1, `form ${index}`);
    const options = nativeCalls[0].options as Record<string, unknown>;
    // Strict deep equality tells a missing key from one set to undefined.
    assert.deepEqual(options, { channelId: "chan-a" }, `form ${index}`);
    assert.equal("reason" in options, false, `form ${index}`);
  }
});

test("a dismiss for another channel leaves the ring and the notification alone", async () => {
  const { dismissIncomingCall, incomingCall, presentIncomingCall } =
    await loaded;
  nativeCalls.length = 0;
  presentIncomingCall({ channel: channel("chan-a"), receivedAt: 1 });
  dismissIncomingCall("chan-b", "ended");
  dismissIncomingCall("chan-b");
  await settle();
  assert.equal(incomingCall()?.channel.id, "chan-a");
  assert.deepEqual(nativeCalls, []);
  dismissIncomingCall();
  await settle();
  assert.equal(incomingCall(), undefined);
});

test("a dismiss with nothing ringing does not reach the plugin", async () => {
  const { dismissIncomingCall, incomingCall } = await loaded;
  nativeCalls.length = 0;
  assert.equal(incomingCall(), undefined);
  dismissIncomingCall(undefined, "ended");
  dismissIncomingCall("chan-a", "ended");
  dismissIncomingCall();
  await settle();
  assert.deepEqual(nativeCalls, []);
});
