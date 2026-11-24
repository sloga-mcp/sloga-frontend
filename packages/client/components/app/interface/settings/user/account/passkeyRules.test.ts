// Run: node --test --conditions=browser components/app/interface/settings/user/account/passkeyRules.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PASSKEY_NAME_MAX,
  addPasskeyStep,
  mayCreatePasskeyNow,
  passkeyFirst,
  passkeyNameProblem,
  passkeyProblem,
} from "./passkeyRules.ts";

describe("passkeyNameProblem", () => {
  it("accepts ordinary names", () => {
    for (const name of ["Windows PC", "  iPhone  ", "a", "Téléphone 📱"]) {
      assert.equal(passkeyNameProblem(name), undefined, name);
    }
  });

  it("refuses an empty or blank name", () => {
    assert.equal(passkeyNameProblem(""), "empty");
    assert.equal(passkeyNameProblem("   "), "empty");
    assert.equal(passkeyNameProblem("\n\t"), "empty");
  });

  it("counts the limit after trimming, in code points", () => {
    assert.equal(passkeyNameProblem("a".repeat(PASSKEY_NAME_MAX)), undefined);
    assert.equal(
      passkeyNameProblem(` ${"a".repeat(PASSKEY_NAME_MAX)} `),
      undefined,
    );
    assert.equal(passkeyNameProblem("a".repeat(PASSKEY_NAME_MAX + 1)), "long");
    // 64 emoji are 128 UTF-16 units but 64 characters
    assert.equal(passkeyNameProblem("📱".repeat(PASSKEY_NAME_MAX)), undefined);
    assert.equal(passkeyNameProblem("📱".repeat(PASSKEY_NAME_MAX + 1)), "long");
  });

  it("refuses control characters inside the name", () => {
    assert.equal(passkeyNameProblem("my\nphone"), "control");
    assert.equal(passkeyNameProblem("my\u0000phone"), "control");
    assert.equal(passkeyNameProblem("my\u007fphone"), "control");
    assert.equal(passkeyNameProblem("my\u0085phone"), "control");
  });
});

describe("passkeyProblem", () => {
  it("reads InvalidOperation by the action", () => {
    assert.equal(passkeyProblem("InvalidOperation", "add"), "limit");
    assert.equal(passkeyProblem("InvalidOperation", "remove"), "last_way_in");
    assert.equal(passkeyProblem("InvalidOperation", "confirm"), "no_passkey");
    assert.equal(passkeyProblem("InvalidOperation", "rename"), undefined);
  });

  it("maps the rest of the server's refusals", () => {
    assert.equal(passkeyProblem("FeatureDisabled", "add"), "off");
    assert.equal(passkeyProblem("FeatureDisabled", "remove"), "off");
    assert.equal(passkeyProblem("FeatureDisabled", "confirm"), "off");
    assert.equal(passkeyProblem("NotPrivileged", "add"), "sign_in_again");
    assert.equal(passkeyProblem("InvalidCredentials", "add"), "not_accepted");
    assert.equal(
      passkeyProblem("InvalidCredentials", "confirm"),
      "not_accepted",
    );
    assert.equal(passkeyProblem("NoEffect", "add"), "already_added");
    assert.equal(passkeyProblem("FailedValidation", "add"), "bad_name");
    assert.equal(passkeyProblem("FailedValidation", "rename"), "bad_name");
  });

  // Fails if: a session older than the last password reset, refused at the
  // start step, is told "the passkey was not accepted" (no passkey exists
  // yet) instead of to sign in again; or the store step, where the cause
  // cannot be known, claims a reset.
  it("reads a refused start as a session from before a password reset", () => {
    assert.equal(passkeyProblem("InvalidCredentials", "start"), "after_reset");
    assert.equal(passkeyProblem("InvalidCredentials", "add"), "not_accepted");
    assert.equal(passkeyProblem("FeatureDisabled", "start"), "off");
    assert.equal(passkeyProblem("InvalidOperation", "start"), undefined);
    assert.equal(passkeyProblem("NotPrivileged", "start"), undefined);
    assert.equal(passkeyProblem("FailedValidation", "start"), undefined);
  });

  it("leaves other errors to the general error dialog", () => {
    assert.equal(passkeyProblem(undefined, "add"), undefined);
    assert.equal(passkeyProblem("InternalError", "add"), undefined);
    assert.equal(passkeyProblem("InvalidToken", "remove"), undefined);
    assert.equal(passkeyProblem("NotPrivileged", "remove"), undefined);
    assert.equal(passkeyProblem("InvalidCredentials", "remove"), undefined);
    assert.equal(passkeyProblem("NoEffect", "rename"), undefined);
  });
});

describe("addPasskeyStep", () => {
  // Fails if: an account the server lets through without a ticket (a first
  // passkey on a fresh Google or Apple sign-in) is still asked for a
  // password or other confirmation.
  it("asks for nothing when the server wants no ticket", () => {
    assert.equal(addPasskeyStep(false, 0), "create");
    assert.equal(addPasskeyStep(false, 2), "create");
  });

  // Fails if: a wanted ticket is skipped, or an account with no way to
  // make one is sent on to create a passkey the server will refuse.
  it("asks for a ticket, or a fresh sign-in when none can be made", () => {
    assert.equal(addPasskeyStep(true, 1), "confirm");
    assert.equal(addPasskeyStep(true, 3), "confirm");
    assert.equal(addPasskeyStep(true, 0), "sign_in_again");
  });
});

describe("mayCreatePasskeyNow", () => {
  // Fails if: the device prompt opens with no ticket after the server
  // started wanting one (the device would keep a passkey the account does
  // not have), or a ticket in hand is not enough.
  it("opens the prompt only with a ticket or when none is wanted", () => {
    assert.equal(mayCreatePasskeyNow(false, false), true);
    assert.equal(mayCreatePasskeyNow(false, true), true);
    assert.equal(mayCreatePasskeyNow(true, true), true);
    assert.equal(mayCreatePasskeyNow(true, false), false);
  });
});

describe("passkeyFirst", () => {
  it("moves the passkey to the front and keeps the rest in order", () => {
    assert.deepEqual(passkeyFirst(["Totp", "Recovery", "Passkey"]), [
      "Passkey",
      "Totp",
      "Recovery",
    ]);
    assert.deepEqual(passkeyFirst(["Passkey", "Password"]), [
      "Passkey",
      "Password",
    ]);
  });

  it("leaves a list without a passkey as it is", () => {
    assert.deepEqual(passkeyFirst(["Totp", "Recovery"]), ["Totp", "Recovery"]);
    assert.deepEqual(passkeyFirst(["Password"]), ["Password"]);
    assert.deepEqual(passkeyFirst([]), []);
  });
});
