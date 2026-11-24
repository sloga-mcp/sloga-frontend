// Run from packages/client:
//   node --test --conditions=browser components/auth/src/flows/passkeySignup.test.ts
// Declared test count: 17 (the runner exits 0 when it finds no tests at all,
// so compare this against its pass count).
//
// Known-bad control: set PASSKEY_SIGNUP_UNDER_TEST to the path of a changed
// copy of passkeySignup.ts (for example one whose passkeySignupGate ignores
// `signup`) and the matching specs fail.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const underTest: typeof import("./passkeySignup.ts") = await import(
  process.env.PASSKEY_SIGNUP_UNDER_TEST
    ? pathToFileURL(process.env.PASSKEY_SIGNUP_UNDER_TEST).href
    : new URL("./passkeySignup.ts", import.meta.url).href
);

const {
  SIGNUP_RESEND_WAIT_MS,
  passkeyRecoverProblem,
  passkeyRecoveryOffered,
  passkeySignupGate,
  passkeySignupProblem,
  recoverStartsAgain,
  resendWaitSeconds,
  secondFactorFrom,
  signupCodeFrom,
  signupStartsAgain,
} = underTest;

const ALL_ON = { available: true, signup: true, signup_without_email: true };

describe("passkeySignupGate", () => {
  // Fails if: sign-up shows while either advert flag is off, while the
  // advert is missing, or on a device that cannot create a passkey
  it("is off unless both flags are on and the device can create a passkey", () => {
    assert.equal(passkeySignupGate(undefined, true), "off");
    assert.equal(passkeySignupGate({}, true), "off");
    assert.equal(
      passkeySignupGate({ ...ALL_ON, available: false }, true),
      "off",
    );
    assert.equal(passkeySignupGate({ ...ALL_ON, signup: false }, true), "off");
    assert.equal(passkeySignupGate(ALL_ON, false), "off");
  });

  // Fails if: a truthy value that is not `true` turns the feature on
  it("takes only a real true for a flag", () => {
    const loose = { available: 1, signup: "yes", signup_without_email: true };
    assert.equal(passkeySignupGate(loose as never, true), "off");
  });

  // Fails if: the "no email" choice shows while signup_without_email is off,
  // or is hidden while it is on
  it("offers the no-email choice only with signup_without_email", () => {
    assert.equal(
      passkeySignupGate({ available: true, signup: true }, true),
      "email_required",
    );
    assert.equal(
      passkeySignupGate({ ...ALL_ON, signup_without_email: false }, true),
      "email_required",
    );
    assert.equal(passkeySignupGate(ALL_ON, true), "email_optional");
  });
});

describe("passkeyRecoveryOffered", () => {
  // Fails if: "Lost your passkey?" shows with either flag off or no advert,
  // or starts to depend on signup_without_email
  it("needs both flags and nothing else", () => {
    assert.equal(passkeyRecoveryOffered(undefined), false);
    assert.equal(passkeyRecoveryOffered({}), false);
    assert.equal(passkeyRecoveryOffered({ available: true }), false);
    assert.equal(passkeyRecoveryOffered({ signup: true }), false);
    assert.equal(
      passkeyRecoveryOffered({ available: true, signup: "yes" } as never),
      false,
    );
    assert.equal(
      passkeyRecoveryOffered({ available: true, signup: true }),
      true,
    );
  });
});

describe("passkeySignupProblem", () => {
  // Fails if: InvalidOperation stops reading as "email required" at any of
  // the three steps that can answer it
  it("reads InvalidOperation as email required at start, options and finish", () => {
    for (const step of ["start", "options", "finish"] as const) {
      assert.equal(
        passkeySignupProblem("InvalidOperation", step),
        "email_required",
        step,
      );
    }
    assert.equal(passkeySignupProblem("InvalidOperation", "code"), undefined);
  });

  // Fails if: the three meanings of InvalidCredentials are mixed up, e.g. a
  // wrong code reads as an expired sign-up
  it("reads InvalidCredentials by step", () => {
    assert.equal(
      passkeySignupProblem("InvalidCredentials", "code"),
      "bad_code",
    );
    assert.equal(
      passkeySignupProblem("InvalidCredentials", "options"),
      "expired",
    );
    assert.equal(
      passkeySignupProblem("InvalidCredentials", "finish"),
      "not_accepted",
    );
    assert.equal(
      passkeySignupProblem("InvalidCredentials", "start"),
      undefined,
    );
    assert.equal(
      passkeySignupProblem("InvalidCredentials", "resend"),
      undefined,
    );
  });

  // Fails if: one of the named refusals loses its own message
  it("names the other refusals", () => {
    assert.equal(passkeySignupProblem("FeatureDisabled", "start"), "off");
    assert.equal(passkeySignupProblem("FeatureDisabled", "resend"), "off");
    assert.equal(
      passkeySignupProblem("InvalidInvite", "start"),
      "invite_invalid",
    );
    assert.equal(
      passkeySignupProblem("InvalidInvite", "finish"),
      "invite_invalid",
    );
    assert.equal(
      passkeySignupProblem("MissingInvite", "start"),
      "invite_missing",
    );
    assert.equal(
      passkeySignupProblem("UsernameTaken", "start"),
      "username_taken",
    );
    assert.equal(
      passkeySignupProblem("UsernameTaken", "finish"),
      "username_taken",
    );
    assert.equal(
      passkeySignupProblem("NoEffect", "finish"),
      "already_registered",
    );
  });

  // Fails if: an error with no passkey meaning gets one, hiding the real
  // message (captcha, validation, rate limit, network)
  it("leaves everything else to the general error text", () => {
    assert.equal(passkeySignupProblem(undefined, "start"), undefined);
    assert.equal(passkeySignupProblem("CaptchaFailed", "start"), undefined);
    assert.equal(passkeySignupProblem("FailedValidation", "start"), undefined);
    assert.equal(
      passkeySignupProblem("InvalidReferralCode", "start"),
      undefined,
    );
    assert.equal(passkeySignupProblem("NoEffect", "start"), undefined);
    assert.equal(passkeySignupProblem("UsernameTaken", "code"), undefined);
  });
});

describe("signupStartsAgain", () => {
  // Fails if: a spent sign-up leaves the person on a step that can only
  // fail again
  it("goes back to the form when the pending sign-up is gone", () => {
    assert.equal(signupStartsAgain("expired", "options"), true);
    assert.equal(signupStartsAgain("email_required", "options"), true);
    assert.equal(signupStartsAgain("email_required", "finish"), true);
    assert.equal(signupStartsAgain("off", "code"), true);
    assert.equal(signupStartsAgain("username_taken", "finish"), true);
    assert.equal(signupStartsAgain("invite_invalid", "finish"), true);
    assert.equal(signupStartsAgain("already_registered", "finish"), true);
  });

  // Fails if: a wrong code or a refused passkey throws away a sign-up that
  // is still good
  it("stays on the step while the sign-up is still good", () => {
    assert.equal(signupStartsAgain("bad_code", "code"), false);
    assert.equal(signupStartsAgain("not_accepted", "finish"), false);
    assert.equal(signupStartsAgain("username_taken", "start"), false);
    assert.equal(signupStartsAgain(undefined, "finish"), false);
  });
});

describe("the emailed code", () => {
  // Fails if: a code that is not exactly 8 digits is sent (each one sent
  // costs one of the five tries), or spaces and dashes stop being dropped
  it("reads 8 digits and nothing else", () => {
    assert.equal(signupCodeFrom("12345678"), "12345678");
    assert.equal(signupCodeFrom(" 1234 5678 "), "12345678");
    assert.equal(signupCodeFrom("1234-5678"), "12345678");
    assert.equal(signupCodeFrom("00000000"), "00000000");
    assert.equal(signupCodeFrom(""), undefined);
    assert.equal(signupCodeFrom("1234567"), undefined);
    assert.equal(signupCodeFrom("123456789"), undefined);
    assert.equal(signupCodeFrom("1234567a"), undefined);
    assert.equal(signupCodeFrom("１２３４５６７８"), undefined);
  });

  // Fails if: the page counts wrong codes again and ends a sign-up by its own
  // count (the server gives fresh tries with every code it mails), or a
  // refused code at any step sends the person back to the form
  it("is never counted out by the page", () => {
    assert.equal("SIGNUP_CODE_MAX_TRIES" in underTest, false);
    assert.equal("signupCodeTriesSpent" in underTest, false);
    for (const step of [
      "start",
      "code",
      "resend",
      "options",
      "finish",
    ] as const) {
      assert.equal(signupStartsAgain("bad_code", step), false, step);
    }
  });

  // Fails if: "send again" opens before the server's 60 s are over, never
  // opens, or a clock set back locks it for longer than one wait
  it("waits 60 s between two sends", () => {
    assert.equal(SIGNUP_RESEND_WAIT_MS, 60_000);
    assert.equal(resendWaitSeconds(1_000_000, 1_000_000), 60);
    assert.equal(resendWaitSeconds(1_000_000, 1_000_001), 60);
    assert.equal(resendWaitSeconds(1_000_000, 1_059_000), 1);
    assert.equal(resendWaitSeconds(1_000_000, 1_059_999), 1);
    assert.equal(resendWaitSeconds(1_000_000, 1_060_000), 0);
    assert.equal(resendWaitSeconds(1_000_000, 9_000_000), 0);
    assert.equal(resendWaitSeconds(0, 1_000_000), 0);
    assert.equal(resendWaitSeconds(9_000_000, 1_000_000), 60);
    assert.equal(resendWaitSeconds(Number.NaN, 1_000_000), 0);
  });
});

describe("passkeyRecoverProblem", () => {
  // Fails if: a dead link stops reading as one, or a refused finish with a
  // code stops reading as a wrong code
  it("reads the recovery refusals", () => {
    assert.equal(
      passkeyRecoverProblem("InvalidToken", "start", false),
      "bad_link",
    );
    assert.equal(
      passkeyRecoverProblem("InvalidToken", "finish", true),
      "bad_link",
    );
    assert.equal(
      passkeyRecoverProblem("InvalidCredentials", "finish", true),
      "wrong_code",
    );
    assert.equal(
      passkeyRecoverProblem("InvalidCredentials", "finish", false),
      "not_accepted",
    );
    assert.equal(passkeyRecoverProblem("LockedOut", "finish", true), "locked");
    assert.equal(
      passkeyRecoverProblem("NoEffect", "finish", false),
      "already_registered",
    );
    for (const step of ["send", "start", "finish"] as const) {
      assert.equal(
        passkeyRecoverProblem("FeatureDisabled", step, false),
        "off",
      );
    }
  });

  // Fails if: an error with no recovery meaning gets one
  it("leaves everything else to the general error text", () => {
    assert.equal(passkeyRecoverProblem(undefined, "finish", true), undefined);
    assert.equal(
      passkeyRecoverProblem("InvalidToken", "send", false),
      undefined,
    );
    assert.equal(
      passkeyRecoverProblem("InvalidCredentials", "start", false),
      undefined,
    );
    assert.equal(passkeyRecoverProblem("LockedOut", "start", false), undefined);
    assert.equal(
      passkeyRecoverProblem("InternalError", "finish", true),
      undefined,
    );
  });

  // Fails if: a wrong code stops asking for a new challenge (the next try
  // would reuse a spent one), or a dead link or a lockout asks for one
  it("asks for a new challenge only when the link is still good", () => {
    assert.equal(recoverStartsAgain("wrong_code"), true);
    assert.equal(recoverStartsAgain("not_accepted"), true);
    assert.equal(recoverStartsAgain("bad_link"), false);
    assert.equal(recoverStartsAgain("locked"), false);
    assert.equal(recoverStartsAgain("off"), false);
    assert.equal(recoverStartsAgain(undefined), false);
  });
});

describe("secondFactorFrom", () => {
  // Fails if: both codes are sent at once, an empty field is sent as a code
  // (the server answers that like a wrong code), or six digits stop going
  // out as the authenticator code
  it("sends six digits as an authenticator code and the rest as a recovery code", () => {
    assert.deepEqual(secondFactorFrom("123456"), { totp_code: "123456" });
    assert.deepEqual(secondFactorFrom(" 123 456 "), { totp_code: "123456" });
    assert.deepEqual(secondFactorFrom("abcde-fghij"), {
      recovery_code: "abcde-fghij",
    });
    assert.deepEqual(secondFactorFrom("  abcde-fghij "), {
      recovery_code: "abcde-fghij",
    });
    assert.deepEqual(secondFactorFrom("1234567"), { recovery_code: "1234567" });
    assert.equal(secondFactorFrom(""), undefined);
    assert.equal(secondFactorFrom("   "), undefined);
  });
});

it("a server without the recovery route reads as switched off", () => {
  // Fails if: the recovery page shows a notice on a server that has no
  // recovery route, instead of leaving like it does when the switch is off
  assert.equal(passkeyRecoverProblem("NotFound", "start", false), "off");
  assert.equal(passkeyRecoverProblem("NotFound", "finish", false), undefined);
});
