// Unit spec for the device-deletion classifier — run with Node's built-in
// runner:
//   node --test --conditions=browser components/client/deviceDeleteClassifier.test.ts
// Focus: `own` only for exactly THIS device of THIS user; `peer` only for
// another user's device; `ignore` for everything else, and an in-flight window
// (the post-wipe echo, a restore, split or publish) beats every other answer,
// `own` included.
import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyDeviceDelete } from "./deviceDeleteClassifier.ts";

const ME = "01HSELF0000000000000000000";
const MY_DEVICE = "0123456789abcdef0123456789abcdef";
const MY_OTHER_DEVICE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PEER = "01HPEER0000000000000000000";
const PEER_DEVICE = "fedcba9876543210fedcba9876543210";

const OWN = { userId: ME, deviceId: MY_DEVICE };
const IDLE = { echoWindow: false, restoreOrSplitOrPublish: false };
const IN_FLIGHT = [
  { echoWindow: true, restoreOrSplitOrPublish: false },
  { echoWindow: false, restoreOrSplitOrPublish: true },
  { echoWindow: true, restoreOrSplitOrPublish: true },
];

test("this device of this user → own", () => {
  assert.equal(
    classifyDeviceDelete({ userId: ME, deviceId: MY_DEVICE }, OWN, IDLE),
    "own",
  );
});

test("another user's device → peer", () => {
  assert.equal(
    classifyDeviceDelete({ userId: PEER, deviceId: PEER_DEVICE }, OWN, IDLE),
    "peer",
  );
});

test("another user's device carrying OUR device id → peer, never own", () => {
  assert.equal(
    classifyDeviceDelete({ userId: PEER, deviceId: MY_DEVICE }, OWN, IDLE),
    "peer",
  );
});

test("another device of our own user → ignore (not a call peer here)", () => {
  assert.equal(
    classifyDeviceDelete({ userId: ME, deviceId: MY_OTHER_DEVICE }, OWN, IDLE),
    "ignore",
  );
});

test("our own device id unknown (null) → an own-user deletion is ignore", () => {
  const own = { userId: ME, deviceId: null };
  for (const deviceId of [MY_DEVICE, MY_OTHER_DEVICE]) {
    assert.equal(
      classifyDeviceDelete({ userId: ME, deviceId }, own, IDLE),
      "ignore",
    );
  }
  // A peer is still a peer.
  assert.equal(
    classifyDeviceDelete({ userId: PEER, deviceId: PEER_DEVICE }, own, IDLE),
    "peer",
  );
});

test("the echo window or an in-flight restore/split/publish → ignore", () => {
  for (const inFlight of IN_FLIGHT) {
    for (const event of [
      { userId: ME, deviceId: MY_DEVICE },
      { userId: ME, deviceId: MY_OTHER_DEVICE },
      { userId: PEER, deviceId: PEER_DEVICE },
    ]) {
      assert.equal(
        classifyDeviceDelete(event, OWN, inFlight),
        "ignore",
        JSON.stringify({ event, inFlight }),
      );
    }
  }
});

test("precedence: in-flight beats own (the post-wipe echo of our own device)", () => {
  // Without the window this exact event is `own` (first test); with it, the
  // call must not be ended.
  for (const inFlight of IN_FLIGHT) {
    assert.equal(
      classifyDeviceDelete({ userId: ME, deviceId: MY_DEVICE }, OWN, inFlight),
      "ignore",
    );
  }
});

test("precedence: in-flight beats peer", () => {
  for (const inFlight of IN_FLIGHT) {
    assert.equal(
      classifyDeviceDelete(
        { userId: PEER, deviceId: PEER_DEVICE },
        OWN,
        inFlight,
      ),
      "ignore",
    );
  }
});

test("empty event ids → ignore, never own or peer", () => {
  for (const event of [
    { userId: "", deviceId: "" },
    { userId: "", deviceId: MY_DEVICE },
    { userId: PEER, deviceId: "" },
    { userId: ME, deviceId: "" },
  ]) {
    assert.equal(
      classifyDeviceDelete(event, OWN, IDLE),
      "ignore",
      JSON.stringify(event),
    );
  }
});

test("missing or non-string event ids at runtime → ignore", () => {
  for (const event of [
    {},
    { userId: undefined, deviceId: PEER_DEVICE },
    { userId: PEER, deviceId: null },
    { userId: 1, deviceId: 2 },
  ]) {
    assert.equal(
      classifyDeviceDelete(
        event as unknown as { userId: string; deviceId: string },
        OWN,
        IDLE,
      ),
      "ignore",
      JSON.stringify(event),
    );
  }
});

test("our own user id unknown → ignore (own and peer cannot be told apart)", () => {
  for (const userId of ["", undefined]) {
    const own = { userId, deviceId: MY_DEVICE } as unknown as {
      userId: string;
      deviceId: string | null;
    };
    for (const event of [
      { userId: ME, deviceId: MY_DEVICE },
      { userId: PEER, deviceId: PEER_DEVICE },
    ]) {
      assert.equal(
        classifyDeviceDelete(event, own, IDLE),
        "ignore",
        JSON.stringify({ userId, event }),
      );
    }
  }
});

test("exhaustive truth table: own only when idle, same user and same device", () => {
  const users = [ME, PEER];
  const devices = [MY_DEVICE, MY_OTHER_DEVICE];
  const ownDevices = [MY_DEVICE, MY_OTHER_DEVICE, null];
  const flags = [false, true];
  for (const userId of users) {
    for (const deviceId of devices) {
      for (const ownDevice of ownDevices) {
        for (const echoWindow of flags) {
          for (const restoreOrSplitOrPublish of flags) {
            const got = classifyDeviceDelete(
              { userId, deviceId },
              { userId: ME, deviceId: ownDevice },
              { echoWindow, restoreOrSplitOrPublish },
            );
            const want =
              echoWindow || restoreOrSplitOrPublish
                ? "ignore"
                : userId !== ME
                  ? "peer"
                  : ownDevice !== null && deviceId === ownDevice
                    ? "own"
                    : "ignore";
            assert.equal(
              got,
              want,
              JSON.stringify({
                userId,
                deviceId,
                ownDevice,
                echoWindow,
                restoreOrSplitOrPublish,
              }),
            );
          }
        }
      }
    }
  }
});

test("compares exactly: a case variant of our device id is not our device", () => {
  assert.equal(
    classifyDeviceDelete(
      { userId: ME, deviceId: MY_DEVICE.toUpperCase() },
      OWN,
      IDLE,
    ),
    "ignore",
  );
});
