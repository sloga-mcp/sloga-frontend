// Unit spec for the Encrypted-only card, setup and leave decisions. Run with
// Node's built-in runner from packages/client:
//   node --test --conditions=browser components/modal/modals/encryptedOnlySetup.test.ts
// Declared test count: 18 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
import assert from "node:assert/strict";
import { test } from "node:test";

import type { PlainWriteInput } from "../../client/encryptedOnlyPolicy.ts";

import {
  type BackupSnapshot,
  classifyRouteFailure,
  groupsToLeave,
  isUnencryptedGroup,
  keepLatchAfterFailure,
  onlyCardState,
  parseOnlyAdvert,
  recoveryCodeMadeThisRun,
  turnOnPrecheck,
} from "./encryptedOnlySetup.ts";

const ADVERT_ON = { available: true, enforced: true };
const ADVERT_OFF = { available: false, enforced: true };

test("parseOnlyAdvert reads the advert and nothing else", () => {
  assert.deepEqual(
    parseOnlyAdvert({
      features: { e2ee: { only: { available: true, enforced: false } } },
    }),
    { available: true, enforced: false },
  );
  assert.deepEqual(parseOnlyAdvert({ features: { e2ee: { only: {} } } }), {
    available: false,
    enforced: false,
  });
  // A truthy value that is not `true` is not available
  assert.deepEqual(
    parseOnlyAdvert({
      features: { e2ee: { only: { available: "yes", enforced: 1 } } },
    }),
    { available: false, enforced: false },
  );
  for (const root of [
    undefined,
    null,
    "x",
    {},
    { features: null },
    { features: { e2ee: {} } },
    { features: { e2ee: { only: null } } },
    { features: { e2ee: { only: true } } },
  ]) {
    assert.equal(parseOnlyAdvert(root), null, JSON.stringify(root));
  }
});

test("onlyCardState: no advert or no user hides the card, whatever else", () => {
  for (const latched of [false, true]) {
    for (const serverOn of [false, true]) {
      for (const advert of [null, undefined]) {
        assert.equal(
          onlyCardState({ advert, userKnown: true, latched, serverOn }),
          "hidden",
        );
      }
      assert.equal(
        onlyCardState({
          advert: ADVERT_ON,
          userKnown: false,
          latched,
          serverOn,
        }),
        "hidden",
      );
    }
  }
});

test("onlyCardState: latched while the server says off is turned off elsewhere", () => {
  for (const advert of [ADVERT_ON, ADVERT_OFF]) {
    assert.equal(
      onlyCardState({
        advert,
        userKnown: true,
        latched: true,
        serverOn: false,
      }),
      "turned-off-elsewhere",
    );
  }
});

test("onlyCardState: on, off, and off while not available", () => {
  for (const latched of [false, true]) {
    assert.equal(
      onlyCardState({
        advert: ADVERT_OFF,
        userKnown: true,
        latched,
        serverOn: true,
      }),
      "on",
    );
  }
  assert.equal(
    onlyCardState({
      advert: ADVERT_ON,
      userKnown: true,
      latched: false,
      serverOn: false,
    }),
    "off",
  );
  assert.equal(
    onlyCardState({
      advert: ADVERT_OFF,
      userKnown: true,
      latched: false,
      serverOn: false,
    }),
    "unavailable",
  );
});

const START = 1_800_000_000;
const SAVED: BackupSnapshot = {
  exists: true,
  generation: 3,
  uploadedGeneration: 3,
  serverHasBackup: true,
  createdAt: START + 5,
};

test("recoveryCodeMadeThisRun: a code made and uploaded during the run counts", () => {
  assert.equal(recoveryCodeMadeThisRun(SAVED, START), true);
  // Made in the same second the setup opened
  assert.equal(
    recoveryCodeMadeThisRun({ ...SAVED, createdAt: START }, START),
    true,
  );
  // A later refresh uploaded a newer generation under the same code
  assert.equal(
    recoveryCodeMadeThisRun(
      { ...SAVED, uploadedGeneration: 4, generation: 4 },
      START,
    ),
    true,
  );
});

test("recoveryCodeMadeThisRun: a backup from before the run never counts", () => {
  assert.equal(
    recoveryCodeMadeThisRun({ ...SAVED, createdAt: START - 1 }, START),
    false,
  );
  // A restored backup carries the source device's time
  assert.equal(
    recoveryCodeMadeThisRun({ ...SAVED, createdAt: 0 }, START),
    false,
  );
});

test("recoveryCodeMadeThisRun: not uploaded, not on the server, or missing is not done", () => {
  // A cancelled dialog leaves the newest generation unuploaded
  assert.equal(
    recoveryCodeMadeThisRun({ ...SAVED, uploadedGeneration: 2 }, START),
    false,
  );
  assert.equal(
    recoveryCodeMadeThisRun({ ...SAVED, uploadedGeneration: 0 }, START),
    false,
  );
  assert.equal(
    recoveryCodeMadeThisRun({ ...SAVED, serverHasBackup: false }, START),
    false,
  );
  assert.equal(
    recoveryCodeMadeThisRun({ ...SAVED, exists: false }, START),
    false,
  );
  assert.equal(
    recoveryCodeMadeThisRun(
      { ...SAVED, generation: 0, uploadedGeneration: 0 },
      START,
    ),
    false,
  );
  assert.equal(recoveryCodeMadeThisRun(undefined, START), false);
  assert.equal(
    recoveryCodeMadeThisRun({ ...SAVED, createdAt: Number.NaN }, START),
    false,
  );
  assert.equal(recoveryCodeMadeThisRun(SAVED, Number.NaN), false);
});

test("turnOnPrecheck: the advert first, then the device", () => {
  assert.equal(
    turnOnPrecheck({ advert: null, deviceReady: true }),
    "unavailable",
  );
  assert.equal(
    turnOnPrecheck({ advert: undefined, deviceReady: false }),
    "unavailable",
  );
  assert.equal(
    turnOnPrecheck({ advert: ADVERT_OFF, deviceReady: true }),
    "unavailable",
  );
  assert.equal(
    turnOnPrecheck({ advert: ADVERT_ON, deviceReady: false }),
    "device",
  );
  assert.equal(turnOnPrecheck({ advert: ADVERT_ON, deviceReady: true }), null);
  // Enforcement switched off on the server still lets the setting be stored
  assert.equal(
    turnOnPrecheck({
      advert: { available: true, enforced: false },
      deviceReady: true,
    }),
    null,
  );
});

test("keepLatchAfterFailure: cleared only when the server is known to have it off", () => {
  assert.equal(keepLatchAfterFailure(false, false, false), false);
  assert.equal(keepLatchAfterFailure(false, true, false), true);
  for (const serverOn of [false, true, undefined]) {
    for (const userFlagOn of [false, true]) {
      assert.equal(keepLatchAfterFailure(true, serverOn, userFlagOn), true);
    }
  }
});

test("keepLatchAfterFailure: an unknown result keeps the latch", () => {
  // The route's reply was lost and the re-read failed too
  assert.equal(keepLatchAfterFailure(false, undefined, false), true);
});

test("keepLatchAfterFailure: the user object saying on keeps the latch", () => {
  assert.equal(keepLatchAfterFailure(false, false, true), true);
  assert.equal(keepLatchAfterFailure(false, undefined, true), true);
});

test("onlyCardState: the open setup is not a turn-off elsewhere", () => {
  assert.equal(
    onlyCardState({
      advert: ADVERT_ON,
      userKnown: true,
      latched: true,
      serverOn: false,
      settingUp: true,
    }),
    "off",
  );
  assert.equal(
    onlyCardState({
      advert: ADVERT_ON,
      userKnown: true,
      latched: true,
      serverOn: false,
      settingUp: false,
    }),
    "turned-off-elsewhere",
  );
});

test("groupsToLeave: only ticked groups still listed as unencrypted", () => {
  assert.deepEqual(groupsToLeave(["a", "b", "c"], ["c", "a", "x"]), ["a", "c"]);
  // Turned out to be encrypted (or gone): never left
  assert.deepEqual(groupsToLeave(["a"], []), []);
  assert.deepEqual(groupsToLeave([], ["a"]), []);
  assert.deepEqual(groupsToLeave(new Set(["a", "a"]), ["a"]), ["a"]);
  assert.deepEqual(groupsToLeave(["a", "a"], ["a"]), ["a"]);
});

function groupInput(over: Partial<PlainWriteInput> = {}): PlainWriteInput {
  return {
    latched: false,
    channel: "group",
    peerFlag: "absent",
    peerRemembered: false,
    groupMarked: false,
    groupRemembered: false,
    device: "ready",
    encrypted: false,
    advert: "enforced",
    ...over,
  };
}

test("isUnencryptedGroup: a plain group is listed", () => {
  assert.equal(isUnencryptedGroup(groupInput()), true);
  // Not known to send encrypted from a device that is not set up
  assert.equal(
    isUnencryptedGroup(groupInput({ encrypted: true, device: "not-set-up" })),
    true,
  );
});

test("isUnencryptedGroup: encrypted, marked or remembered groups are not", () => {
  assert.equal(isUnencryptedGroup(groupInput({ encrypted: true })), false);
  assert.equal(isUnencryptedGroup(groupInput({ groupMarked: true })), false);
  assert.equal(
    isUnencryptedGroup(groupInput({ groupRemembered: true })),
    false,
  );
});

test("isUnencryptedGroup: only groups", () => {
  for (const channel of ["dm", "saved", "server"] as const) {
    assert.equal(isUnencryptedGroup(groupInput({ channel })), false, channel);
  }
});

test("classifyRouteFailure sorts the server's errors", () => {
  assert.equal(
    classifyRouteFailure({ type: "FeatureDisabled", feature: "e2ee_only" }),
    "unavailable",
  );
  assert.equal(classifyRouteFailure({ type: "NotAuthenticated" }), "device");
  assert.equal(classifyRouteFailure({ type: "InvalidToken" }), "ticket");
});

test("classifyRouteFailure: anything else is other", () => {
  for (const error of [
    undefined,
    null,
    "FeatureDisabled",
    new Error("FeatureDisabled"),
    { type: "IsBot" },
    { type: 1 },
  ]) {
    assert.equal(classifyRouteFailure(error), "other", String(error));
  }
});
