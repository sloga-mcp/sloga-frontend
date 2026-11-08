// Durable deviceShared state (multi-device plan D5/D6, contract R4).
// Run: node --test --conditions=browser components/client/e2eeDeviceShared.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type DeviceSharedStorage,
  clearDeviceShared,
  clearHeldStrike,
  clearWasShared,
  deviceSharedKey,
  heldStrikeKey,
  mergeDeviceShared,
  readDeviceShared,
  readHeldStrike,
  readWasShared,
  wasSharedKey,
  writeDeviceShared,
  writeHeldStrike,
  writeWasShared,
} from "./e2eeDeviceShared.ts";

function memoryStorage(): DeviceSharedStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

test("the key names the user and the device", () => {
  assert.equal(deviceSharedKey("U", "D"), "sloga.e2ee.deviceShared.v1:U:D");
});

test("write then read round-trips; another device or user reads nothing", () => {
  const s = memoryStorage();
  writeDeviceShared(s, "U", "D", { via: "held_elsewhere", at: 5 });
  assert.deepEqual(readDeviceShared(s, "U", "D"), {
    via: "held_elsewhere",
    at: 5,
  });
  assert.equal(readDeviceShared(s, "U", "D2"), null);
  assert.equal(readDeviceShared(s, "U2", "D"), null);
});

test("clear removes only that device's entry", () => {
  const s = memoryStorage();
  writeDeviceShared(s, "U", "D", { via: "diverged", at: 1 });
  writeDeviceShared(s, "U", "E", { via: "diverged", at: 2 });
  clearDeviceShared(s, "U", "D");
  assert.equal(readDeviceShared(s, "U", "D"), null);
  assert.deepEqual(readDeviceShared(s, "U", "E"), { via: "diverged", at: 2 });
});

test("malformed stored values read as nothing", () => {
  const s = memoryStorage();
  for (const raw of [
    "not json",
    "null",
    "[]",
    '{"via":"other","at":1}',
    '{"via":"diverged"}',
    '{"via":"diverged","at":"1"}',
    '{"via":"diverged","at":null}',
  ]) {
    s.map.set(deviceSharedKey("U", "D"), raw);
    assert.equal(readDeviceShared(s, "U", "D"), null, raw);
  }
});

test("a throwing or absent storage reads null and writes nothing, quietly", () => {
  const broken: DeviceSharedStorage = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("quota");
    },
    removeItem() {
      throw new Error("denied");
    },
  };
  assert.equal(readDeviceShared(broken, "U", "D"), null);
  writeDeviceShared(broken, "U", "D", { via: "diverged", at: 1 });
  clearDeviceShared(broken, "U", "D");
  assert.equal(readDeviceShared(null, "U", "D"), null);
  writeDeviceShared(null, "U", "D", { via: "diverged", at: 1 });
  clearDeviceShared(null, "U", "D");
});

test("held_elsewhere outranks diverged; a standing state keeps its instant", () => {
  const held = { via: "held_elsewhere" as const, at: 10 };
  const diverged = { via: "diverged" as const, at: 20 };
  assert.deepEqual(mergeDeviceShared(null, diverged), diverged);
  assert.deepEqual(mergeDeviceShared(diverged, held), held);
  assert.deepEqual(mergeDeviceShared(held, diverged), held);
  assert.deepEqual(mergeDeviceShared(held, { ...held, at: 99 }), held);
});

test("the first held_elsewhere strike round-trips per (user, device) and clears", () => {
  const s = memoryStorage();
  assert.equal(heldStrikeKey("U", "D"), "sloga.e2ee.heldStrike.v1:U:D");
  assert.equal(readHeldStrike(s, "U", "D"), null);
  writeHeldStrike(s, "U", "D", 42);
  assert.equal(readHeldStrike(s, "U", "D"), 42);
  assert.equal(readHeldStrike(s, "U", "E"), null);
  assert.equal(readHeldStrike(s, "V", "D"), null);
  clearHeldStrike(s, "U", "D");
  assert.equal(readHeldStrike(s, "U", "D"), null);
  for (const raw of ["x", "null", "{}", '{"at":"1"}', '{"at":null}']) {
    s.map.set(heldStrikeKey("U", "D"), raw);
    assert.equal(readHeldStrike(s, "U", "D"), null, raw);
  }
  assert.equal(readHeldStrike(null, "U", "D"), null);
  writeHeldStrike(null, "U", "D", 1);
  clearHeldStrike(null, "U", "D");
});

test("the sticky was-shared record round-trips per (user, device) and clears", () => {
  const s = memoryStorage();
  assert.equal(wasSharedKey("U", "D"), "sloga.e2ee.wasShared.v1:U:D");
  assert.equal(readWasShared(s, "U", "D"), false);
  writeWasShared(s, "U", "D", 7);
  assert.equal(readWasShared(s, "U", "D"), true);
  assert.equal(readWasShared(s, "U", "E"), false);
  assert.equal(readWasShared(s, "V", "D"), false);
  clearWasShared(s, "U", "D");
  assert.equal(readWasShared(s, "U", "D"), false);
  for (const raw of ["x", "null", "{}", '{"at":"1"}', '{"at":null}']) {
    s.map.set(wasSharedKey("U", "D"), raw);
    assert.equal(readWasShared(s, "U", "D"), false, raw);
  }
  assert.equal(readWasShared(null, "U", "D"), false);
  writeWasShared(null, "U", "D", 1);
  clearWasShared(null, "U", "D");
});
