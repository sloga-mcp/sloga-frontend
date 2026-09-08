// Unit spec for the connect-time session-setup decision — run with Node's
// built-in runner:
//   node --conditions=browser --test components/rtc/mlsSessionSetupPolicy.test.ts
// Focus: since 2026-09-06 an E2EE-capable shell that cannot build its MLS
// call session HOLDS the negotiating publish gate and goes loud; it never
// releases to plaintext on its own (R2-4, withdrawn under the same rule as
// the T0d availability escape). A non-capable shell is not an E2EE call and
// gets no gate. The exhaustive checks at the bottom prove that no input can
// bring a silent release back, and that no non-capable input ever holds.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type E2EEStatusSnapshot,
  type NoSessionConfirmInput,
  type SessionSetupInput,
  canConfirmNoSessionPlaintext,
  e2eeProvenOff,
  sessionSetupDecision,
} from "./mlsSessionSetupPolicy.ts";

const BOOLS = [false, true] as const;

/** The healthy capable shell: every precondition met. */
const READY: SessionSetupInput = {
  e2eeCapable: true,
  bridge: true,
  keyProvider: true,
  userId: true,
  deviceId: true,
  identityOk: true,
  keysListenerBound: true,
  deviceOwnedElsewhere: false,
};

/** Every input the function can be given (2^8 = 256 shapes). */
function* everyInput(): Generator<SessionSetupInput> {
  for (const e2eeCapable of BOOLS)
    for (const bridge of BOOLS)
      for (const keyProvider of BOOLS)
        for (const userId of BOOLS)
          for (const deviceId of BOOLS)
            for (const identityOk of BOOLS)
              for (const keysListenerBound of BOOLS)
                for (const deviceOwnedElsewhere of BOOLS)
                  yield {
                    e2eeCapable,
                    bridge,
                    keyProvider,
                    userId,
                    deviceId,
                    identityOk,
                    keysListenerBound,
                    deviceOwnedElsewhere,
                  };
}

test("a capable shell with every precondition met builds the session", () => {
  assert.deepEqual(sessionSetupDecision(READY), { action: "session" });
});

test("capable + setup failed (no key provider) → hold the gate, go loud", () => {
  const decision = sessionSetupDecision({ ...READY, keyProvider: false });
  assert.equal(decision.action, "hold_loud");
});

test("capable + the SFU minted the wrong identity → hold the gate, go loud (the gate used to be released under the red chip)", () => {
  const decision = sessionSetupDecision({ ...READY, identityOk: false });
  assert.equal(decision.action, "hold_loud");
  assert.match(
    decision.action === "hold_loud" ? decision.reason : "",
    /identity that does not name this device/,
  );
});

test("capable + the native key-change listener never registered (bounded by the 45 s deadline) → hold the gate, go loud", () => {
  const decision = sessionSetupDecision({ ...READY, keysListenerBound: false });
  assert.equal(decision.action, "hold_loud");
  assert.match(
    decision.action === "hold_loud" ? decision.reason : "",
    /key-change listener/,
  );
});

test("capable + no E2EE device identity on the bridge yet → hold the gate, go loud (a transient the client cannot tell from a real fault)", () => {
  const decision = sessionSetupDecision({
    ...READY,
    deviceId: false,
    identityOk: false,
  });
  assert.equal(decision.action, "hold_loud");
});

test("non-capable shell → plain call, no gate — whatever else is missing", () => {
  assert.deepEqual(sessionSetupDecision({ ...READY, e2eeCapable: false }), {
    action: "plain",
  });
  assert.deepEqual(
    sessionSetupDecision({
      e2eeCapable: false,
      bridge: false,
      keyProvider: false,
      userId: false,
      deviceId: false,
      identityOk: false,
      keysListenerBound: false,
      deviceOwnedElsewhere: false,
    }),
    { action: "plain" },
  );
});

// The fail-closed proof: a capable shell can only ever get "session" (every
// precondition met) or "hold_loud" — there is no capable input that reads
// "plain", so nothing here can release the gate without a session to own it.
test("PROOF: no capable input yields plain; only the fully-met input yields session", () => {
  for (const input of everyInput()) {
    const decision = sessionSetupDecision(input);
    if (!input.e2eeCapable) {
      assert.equal(decision.action, "plain", JSON.stringify(input));
      continue;
    }
    assert.notEqual(decision.action, "plain", JSON.stringify(input));
    const allMet =
      !input.deviceOwnedElsewhere &&
      input.bridge &&
      input.keyProvider &&
      input.userId &&
      input.deviceId &&
      input.identityOk &&
      input.keysListenerBound;
    assert.equal(
      decision.action,
      allMet ? "session" : "hold_loud",
      JSON.stringify(input),
    );
  }
});

test("PROOF: every hold reason is a call-level statement that never suggests resetting or wiping this device's encryption", () => {
  for (const input of everyInput()) {
    const decision = sessionSetupDecision(input);
    if (decision.action !== "hold_loud") continue;
    assert.doesNotMatch(decision.reason, /wipe|reset|clear|remove/i);
    assert.match(decision.reason, /^This call could not be encrypted: /);
  }
});

// ---- "E2EE proven off on this device" ---------------------------------------
//
// The bridge's status snapshot is written only when the native status query
// RESOLVES (`refreshStatus` sets it after the invoke returns) or when the
// side-effect-free provisioning check proves the device unprovisioned
// (`#setDisabledStatus`: at boot in `#onReady`, and after a wipe). A query
// that throws sets nothing, so "threw" and "not resolved yet" both reach this
// rule as `undefined`. The bridge class cannot be imported under `node --test`
// (it pulls in Capacitor and stoat.js), so that state shape is pinned here by
// the two literals below rather than by driving the class.

/** What `#setDisabledStatus` writes (fresh device at boot, and after a wipe). */
const DISABLED_SNAPSHOT = {
  enabled: false,
  published: false,
  device_id: null,
  protocol_version: 1,
  claimed: false,
};

/**
 * What `refreshStatus` writes after a wipe: native `Shell::status`'s
 * not-provisioned fast path plus the `claimed` carried over (false after the
 * synchronous zeroing that precedes it).
 */
const NATIVE_UNPROVISIONED_SNAPSHOT = {
  enabled: false,
  published: false,
  device_id: null,
  protocol_version: 1,
  claimed: false,
};

/** The capability predicate's use of the rule, reduced to its E2EE term. */
function capableGiven(snapshot: E2EEStatusSnapshot | undefined | null) {
  return !e2eeProvenOff(snapshot);
}

test("proven off: a LOADED snapshot with enabled === false → not capable → plain call, no gate", () => {
  assert.equal(e2eeProvenOff({ enabled: false }), true);
  assert.equal(capableGiven({ enabled: false }), false);
  assert.deepEqual(
    sessionSetupDecision({
      ...READY,
      e2eeCapable: capableGiven({ enabled: false }),
      deviceId: false,
      identityOk: false,
    }),
    { action: "plain" },
  );
});

test("unresolved: an UNSET snapshot (boot query pending, or it threw) is NOT proven off → capable → hold loud", () => {
  assert.equal(e2eeProvenOff(undefined), false);
  assert.equal(e2eeProvenOff(null), false);
  assert.equal(capableGiven(undefined), true);
  const decision = sessionSetupDecision({
    ...READY,
    e2eeCapable: capableGiven(undefined),
    deviceId: false,
    identityOk: false,
  });
  assert.equal(decision.action, "hold_loud");
  assert.match(
    decision.action === "hold_loud" ? decision.reason : "",
    /identity is not available yet/,
  );
});

test("enrolled: a snapshot with enabled === true is not proven off → capable", () => {
  assert.equal(e2eeProvenOff({ enabled: true }), false);
  assert.equal(capableGiven({ enabled: true }), true);
});

test("a fresh device and a wiped device read identically, and both are proven off", () => {
  assert.deepEqual(DISABLED_SNAPSHOT, NATIVE_UNPROVISIONED_SNAPSHOT);
  assert.equal(e2eeProvenOff(DISABLED_SNAPSHOT), true);
  assert.equal(e2eeProvenOff(NATIVE_UNPROVISIONED_SNAPSHOT), true);
});

test("PROOF: only a boolean false proves off — a missing snapshot, a missing field, or any other value never does", () => {
  const notProvenOff: (E2EEStatusSnapshot | undefined | null)[] = [
    undefined,
    null,
    {} as E2EEStatusSnapshot,
    { enabled: undefined as unknown as boolean },
    { enabled: true },
    { enabled: 0 as unknown as boolean },
    { enabled: "false" as unknown as boolean },
  ];
  for (const snapshot of notProvenOff) {
    assert.equal(e2eeProvenOff(snapshot), false, JSON.stringify(snapshot));
    assert.equal(capableGiven(snapshot), true, JSON.stringify(snapshot));
  }
  assert.equal(e2eeProvenOff({ enabled: false }), true);
});

// ---- the escape: "Stay unencrypted" with no session ------------------------

const CONFIRMABLE: NoSessionConfirmInput = {
  hasSession: false,
  e2eeCapable: true,
  latchedError: true,
  gateHeld: true,
};

test("Stay unencrypted may release the no-session hold: capable, error latched, gate held, no session", () => {
  assert.equal(canConfirmNoSessionPlaintext(CONFIRMABLE), true);
});

test("a session present routes Stay through the session's native-confirmed path, never this one", () => {
  assert.equal(
    canConfirmNoSessionPlaintext({ ...CONFIRMABLE, hasSession: true }),
    false,
  );
});

test("a non-capable call never had a gate: nothing to release", () => {
  assert.equal(
    canConfirmNoSessionPlaintext({ ...CONFIRMABLE, e2eeCapable: false }),
    false,
  );
});

test("PROOF: the escape needs all four terms — any single missing term refuses", () => {
  for (const hasSession of BOOLS)
    for (const e2eeCapable of BOOLS)
      for (const latchedError of BOOLS)
        for (const gateHeld of BOOLS) {
          const input = { hasSession, e2eeCapable, latchedError, gateHeld };
          assert.equal(
            canConfirmNoSessionPlaintext(input),
            !hasSession && e2eeCapable && latchedError && gateHeld,
            JSON.stringify(input),
          );
        }
});

test("🔴 a device the server refuses HOLDS LOUD — it never falls through to plain", () => {
  // `owned_elsewhere` stays E2EE-capable on purpose (see
  // `callEncryptionCapable`), so it must land on a hold with a reason of its
  // own: the caller withholds the refused device id, which without this arm
  // would read as "this device's E2EE identity is not available yet" — wrong,
  // and nothing the user can act on.
  const d = sessionSetupDecision({
    e2eeCapable: true,
    bridge: true,
    keyProvider: true,
    userId: true,
    deviceId: false,
    identityOk: false,
    keysListenerBound: true,
    deviceOwnedElsewhere: true,
  });
  assert.equal(d.action, "hold_loud");
  assert.match(
    (d as { reason: string }).reason,
    /not registered to the account you are signed in as/,
  );
});

test("the refused-device arm is inert unless it is set", () => {
  const d = sessionSetupDecision({
    e2eeCapable: true,
    bridge: true,
    keyProvider: true,
    userId: true,
    deviceId: true,
    identityOk: true,
    keysListenerBound: true,
    deviceOwnedElsewhere: false,
  });
  assert.deepEqual(d, { action: "session" });
});
