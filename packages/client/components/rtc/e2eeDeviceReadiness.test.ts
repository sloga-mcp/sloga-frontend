// Unit spec for the call-encryption readiness reason + delta's
// device-not-registered join refusal.
//   node --test components/rtc/e2eeDeviceReadiness.test.ts
// Focus: `ready` stays exactly as permissive as the boolean it replaced
// (an UNRESOLVED status is still capable — R2-4 fail-closed), the two
// "set it up here" reasons are told apart, and the refusal matcher is strict
// enough that a reworded backend degrades to today's behaviour.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  callEncryptionCapable,
  callEncryptionReadiness,
  encryptionSetupAvailable,
  isDeviceNotRegisteredRefusal,
} from "./e2eeDeviceReadiness.ts";

const base = {
  shellSupported: true,
  status: { enabled: true },
  deviceOwnedElsewhere: false,
};

test("an enrolled device on a supported shell is ready", () => {
  assert.equal(callEncryptionReadiness(base), "ready");
  assert.equal(callEncryptionCapable("ready"), true);
});

test("an UNRESOLVED status stays ready — R2-4 fail-closed, unchanged", () => {
  // A status that never loaded cannot be told from an enrolled device, so the
  // shell stays capable and `sessionSetupDecision` holds the publish gate
  // loud. Reading it as "needs setup" would release the gate to plaintext on
  // a device that may well be enrolled.
  assert.equal(
    callEncryptionReadiness({ ...base, status: undefined }),
    "ready",
  );
  assert.equal(callEncryptionReadiness({ ...base, status: null }), "ready");
});

test("a proven-off device needs setup — the fresh-install default", () => {
  // A fresh desktop install has no store: `e2ee_is_provisioned` is false, the
  // bridge records `enabled: false`, and calls are plaintext until the user
  // enrols or restores. Nothing said so before this reason existed.
  const r = callEncryptionReadiness({ ...base, status: { enabled: false } });
  assert.equal(r, "needs_setup");
  assert.equal(callEncryptionCapable(r), false);
});

test("a store the server refuses outranks 'needs setup'", () => {
  // Both are "not set up for you here", but only this one has a store to
  // clear; sending the user into the enable flow would fail on
  // `AlreadyEnabled` and teach them nothing.
  const r = callEncryptionReadiness({ ...base, deviceOwnedElsewhere: true });
  assert.equal(r, "owned_elsewhere");
  // Even with the store simultaneously proven off.
  assert.equal(
    callEncryptionReadiness({
      ...base,
      deviceOwnedElsewhere: true,
      status: { enabled: false },
    }),
    "owned_elsewhere",
  );
});

test("🔴 a REFUSED device stays CAPABLE — it is a failure, not a non-capability", () => {
  // The hole the first cut of this fix opened (reviewer F1, CRITICAL).
  // Non-capable means no publish gate, no session and no latched error, and
  // `chipState`'s no-session branches only fire when the open-group probe says
  // the channel HAS a group — so a refused device alone in a fresh channel
  // published plaintext with no chip and no banner at all. Capable keeps the
  // R2-5 gate asserted, `sessionSetupDecision` holds it loud, and the chip is
  // red through `latchedError` with no probe in the path.
  assert.equal(callEncryptionCapable("owned_elsewhere"), true);
  // ...while a device that was never set up here has no identity to attempt
  // anything with, and holding every fresh install's first call behind a
  // consent press is not this rule's call to make.
  assert.equal(callEncryptionCapable("needs_setup"), false);
  assert.equal(callEncryptionCapable("unsupported"), false);
  assert.equal(callEncryptionCapable("ready"), true);
});

test("an unsupported shell outranks everything — there is nothing to set up", () => {
  for (const over of [
    {},
    { deviceOwnedElsewhere: true },
    { status: { enabled: false } },
  ]) {
    const r = callEncryptionReadiness({
      ...base,
      shellSupported: false,
      ...over,
    });
    assert.equal(r, "unsupported");
    assert.equal(callEncryptionCapable(r), false);
  }
});

test("the join refusal matches delta's exact type + message pair", () => {
  assert.equal(
    isDeviceNotRegisteredRefusal({
      type: "FailedValidation",
      error: "joining device is not registered",
      location: "crates/delta/src/routes/channels/voice_join.rs:44:13",
    }),
    true,
  );
});

test("nothing else is that refusal — a reworded backend degrades to today", () => {
  // Anything unmatched keeps the pre-existing behaviour: `FailedValidation`
  // is a TERMINAL join refusal, so the channel's join affordances latch for
  // 30 s. That is the bug this matcher exists to lift, and it is also the
  // only safe place to land when the string moves — never "join unencrypted".
  for (const error of [
    null,
    undefined,
    "joining device is not registered",
    new Error("joining device is not registered"),
    { type: "FailedValidation" },
    { type: "FailedValidation", error: "invalid bundle encoding" },
    { type: "MissingPermission", error: "joining device is not registered" },
    { error: "joining device is not registered" },
  ])
    assert.equal(isDeviceNotRegisteredRefusal(error), false);
});

test("🔴 setup-available is the chip's LOCAL term, and it is exactly the two fixable reasons", () => {
  // It decides `chipState`'s `deviceNeedsSetup`, i.e. whether a device that
  // cannot encrypt says so WITHOUT waiting on the open-group probe (which is
  // answered once at connect and never re-asked). `unsupported` must stay out:
  // there is nothing to set up, so speaking on every call would be noise.
  assert.equal(encryptionSetupAvailable("needs_setup"), true);
  assert.equal(encryptionSetupAvailable("owned_elsewhere"), true);
  assert.equal(encryptionSetupAvailable("unsupported"), false);
  assert.equal(encryptionSetupAvailable("ready"), false);
});
