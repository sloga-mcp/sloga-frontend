// Unit spec for the locked-device send-error copy — run with Node's built-in
// runner:
//   node --test components/client/e2eeProtectorCopy.test.ts   (Node >=23.6 strips types)
// Focus (plan D3 "Locked device", audit MINOR 10): a `protector` or
// `protector_locked` failure means the store is intact and the key is only
// unreadable for now. The copy may say "unlock and try again" and nothing
// else; it must never point the user at a wipe, reset or restore.
import assert from "node:assert/strict";
import { test } from "node:test";

import { protectorSendErrorCopy } from "./e2eeProtectorCopy.ts";

const LOCKED =
  "Unlock your phone, then try again. Your encryption key can't be read while it's locked. Nothing was sent.";
const PROTECTOR_PHONE =
  "This device's encryption key could not be opened. If your phone is locked, unlock it and try again. Nothing was sent.";
const PROTECTOR_COMPUTER =
  "This device's encryption key could not be opened. If your computer is locked, unlock it and try again. Nothing was sent.";

const PLATFORMS = ["ios", "android", "web", "electron", ""];

test("protector_locked → the unlock copy on every platform", () => {
  for (const platform of PLATFORMS) {
    assert.equal(
      protectorSendErrorCopy({ type: "protector_locked" }, platform),
      LOCKED,
      platform,
    );
  }
});

test("protector → phone copy on ios/android, computer copy everywhere else", () => {
  assert.equal(
    protectorSendErrorCopy({ type: "protector" }, "ios"),
    PROTECTOR_PHONE,
  );
  assert.equal(
    protectorSendErrorCopy({ type: "protector" }, "android"),
    PROTECTOR_PHONE,
  );
  for (const platform of ["web", "electron", "IOS", ""]) {
    assert.equal(
      protectorSendErrorCopy({ type: "protector" }, platform),
      PROTECTOR_COMPUTER,
      platform,
    );
  }
});

test("extra fields on the tagged object do not change the match", () => {
  assert.equal(
    protectorSendErrorCopy({ type: "protector_locked", detail: "x" }, "ios"),
    LOCKED,
  );
});

test("other native error tags → null (caller keeps its generic text)", () => {
  for (const other of [
    { type: "declined" },
    { type: "busy" },
    { type: "store_corrupt" },
    { type: "crypto_failure" },
    { type: "mls_store_owned_by_another_account" },
    { type: "not_provisioned" },
  ]) {
    for (const platform of PLATFORMS) {
      assert.equal(
        protectorSendErrorCopy(other, platform),
        null,
        `${JSON.stringify(other)} on ${platform}`,
      );
    }
  }
});

test("near-miss tags → null (exact match only)", () => {
  for (const near of [
    { type: "Protector" },
    { type: "PROTECTOR_LOCKED" },
    { type: "protector_locked " },
    { type: " protector" },
    { type: "protectorLocked" },
    { type: "protector-locked" },
    { type: "protector_lock" },
    { type: ["protector"] },
    { type: null },
    { kind: "protector" },
    {},
  ]) {
    assert.equal(
      protectorSendErrorCopy(near, "ios"),
      null,
      JSON.stringify(near),
    );
  }
});

test("non-objects never match", () => {
  for (const b of [
    null,
    undefined,
    "",
    "protector",
    "protector_locked",
    '{"type":"protector_locked"}',
    0,
    true,
  ]) {
    assert.equal(protectorSendErrorCopy(b, "ios"), null, String(b));
  }
});

test("an Error instance does not match, whatever its message or fields", () => {
  // `#rethrow` only parses `{`-prefixed messages back into typed objects; a
  // plain thrown Error keeps its class and is not a protector failure.
  for (const tag of ["protector", "protector_locked"]) {
    assert.equal(protectorSendErrorCopy(new Error(tag), "ios"), null, tag);
    assert.equal(protectorSendErrorCopy(new TypeError(tag), "ios"), null, tag);
    const withField = Object.assign(new Error(tag), { type: tag });
    assert.equal(protectorSendErrorCopy(withField, "ios"), null, tag);
  }
});

test("NEVER offers a wipe: no non-null copy mentions a destructive or recovery action", () => {
  const forbidden =
    /wipe|reset|turn off|disable|restore|recover|backup|back up|delete|erase/i;
  const outputs: string[] = [];
  for (const type of ["protector", "protector_locked"]) {
    for (const platform of PLATFORMS) {
      const copy = protectorSendErrorCopy({ type }, platform);
      assert.notEqual(copy, null, `${type} on ${platform}`);
      outputs.push(copy as string);
    }
  }
  // 2 tags x every platform, so the loop below cannot pass vacuously.
  assert.equal(outputs.length, 2 * PLATFORMS.length);
  for (const copy of outputs) {
    assert.doesNotMatch(copy, forbidden, copy);
    // Every variant tells the user the send did not happen.
    assert.match(copy, /Nothing was sent\.$/, copy);
  }
});

test("the locked copy tells the user to unlock and retry", () => {
  const copy = protectorSendErrorCopy({ type: "protector_locked" }, "ios");
  assert.match(copy as string, /^Unlock your phone/);
  assert.match(copy as string, /try again/);
  for (const platform of PLATFORMS) {
    assert.match(
      protectorSendErrorCopy({ type: "protector" }, platform) as string,
      /unlock it and try again/,
      platform,
    );
  }
});
