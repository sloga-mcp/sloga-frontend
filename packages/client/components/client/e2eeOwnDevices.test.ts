// "Your devices" mapping and removal counts (multi-device plan D7, R8, R11).
// Run: node --test --conditions=browser components/client/e2eeOwnDevices.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isNeverSeen,
  parseRemainingDevices,
  sessionNameOf,
  toOwnDeviceViews,
} from "./e2eeOwnDevices.ts";

test("parseRemainingDevices takes non-negative integers only", () => {
  assert.equal(parseRemainingDevices({ remaining_devices: 0 }), 0);
  assert.equal(parseRemainingDevices({ remaining_devices: 3 }), 3);
  for (const body of [
    undefined,
    null,
    "",
    {},
    { remaining_devices: -1 },
    { remaining_devices: 1.5 },
    { remaining_devices: "0" },
    { remaining_devices: null },
    { remaining_devices: Number.NaN },
    { remaining_devices: Number.POSITIVE_INFINITY },
    { remaining_devices: 2 ** 60 },
    [0],
  ]) {
    assert.equal(parseRemainingDevices(body), null, JSON.stringify(body));
  }
});

test("neverSeen per Q13", () => {
  const t0 = "2026-11-01T10:00:00Z";
  assert.equal(isNeverSeen(t0, null), true, "no last seen");
  assert.equal(isNeverSeen(t0, t0), true, "seen at creation");
  assert.equal(isNeverSeen(t0, "2026-11-01T10:01:00Z"), true, "exactly 60 s");
  assert.equal(isNeverSeen(t0, "2026-11-01T10:01:01Z"), false, "61 s");
  assert.equal(isNeverSeen(null, t0), false, "unknown creation: NaN");
});

test("toOwnDeviceViews: this device first, the rest newest first", () => {
  const listing = [
    {
      device_id: "OLD",
      created_at: "2026-01-01T00:00:00Z",
      last_seen_at: "2026-10-01T00:00:00Z",
      session_name: "Laptop",
      ed25519_key: "k",
    },
    {
      device_id: "ME",
      created_at: "2026-02-01T00:00:00Z",
      last_seen_at: "2026-10-02T00:00:00Z",
    },
    {
      device_id: "NEW",
      created_at: "2026-03-01T00:00:00Z",
      last_seen_at: "2026-03-01T00:00:10Z",
      session_name: "Phone",
    },
    { device_id: "NODATE" },
    { device_id: 7 },
    { device_id: "NEW", created_at: "2026-12-01T00:00:00Z" },
    null,
  ];
  const views = toOwnDeviceViews(listing, "ME");
  assert.deepEqual(
    views.map((v) => v.deviceId),
    ["ME", "NEW", "OLD", "NODATE"],
  );
  assert.deepEqual(views[0], {
    deviceId: "ME",
    isThisDevice: true,
    sessionId: null,
    sessionName: null,
    createdAt: "2026-02-01T00:00:00Z",
    lastSeenAt: "2026-10-02T00:00:00Z",
    neverSeen: false,
  });
  assert.equal(views[1].sessionName, "Phone");
  assert.equal(views[1].neverSeen, true, "orphan row");
  assert.equal(views[2].isThisDevice, false);
  assert.equal(views[3].neverSeen, true, "no last seen");
  assert.deepEqual(toOwnDeviceViews({}, "ME"), []);
  assert.deepEqual(toOwnDeviceViews(null, null), []);
});

test("toOwnDeviceViews: sessionId is the row's string session_id, else null (S2-D38)", () => {
  const listing = [
    { device_id: "A", session_id: "SESS-A", session_name: "Desktop" },
    { device_id: "B" },
    { device_id: "C", session_id: "" },
    { device_id: "D", session_id: 5 },
    { device_id: "E", session_id: { id: "SESS-E" } },
    { device_id: "F", session_id: null },
    { device_id: "G", session_id: ["SESS-G"] },
  ];
  const views = toOwnDeviceViews(listing, "A");
  assert.deepEqual(
    views.map((v) => [v.deviceId, v.sessionId, v.sessionName]),
    [
      ["A", "SESS-A", "Desktop"],
      ["B", null, null],
      ["C", null, null],
      ["D", null, null],
      ["E", null, null],
      ["F", null, null],
      ["G", null, null],
    ],
  );
});

test("sessionNameOf reads one row's session name", () => {
  const listing = [
    { device_id: "A", session_name: "Desktop" },
    { device_id: "B", session_name: 5 },
  ];
  assert.equal(sessionNameOf(listing, "A"), "Desktop");
  assert.equal(sessionNameOf(listing, "B"), null);
  assert.equal(sessionNameOf(listing, "C"), null);
  assert.equal(sessionNameOf(undefined, "A"), null);
});
