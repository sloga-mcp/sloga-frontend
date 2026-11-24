// Run from packages/client:
//   node --test --conditions=browser components/auth/src/flows/passkeySignup.test.ts
// Declared test count: 34 (the runner exits 0 when it finds no tests at all,
// so compare this against its pass count).
//
// Known-bad control: set PASSKEY_SIGNUP_UNDER_TEST to the path of a changed
// copy of passkeySignup.ts (for example one whose passkeySignupGate ignores
// `signup`) and the matching specs fail.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const underTest: typeof import("./passkeySignup.ts") = await import(
  process.env.PASSKEY_SIGNUP_UNDER_TEST
    ? pathToFileURL(process.env.PASSKEY_SIGNUP_UNDER_TEST).href
    : new URL("./passkeySignup.ts", import.meta.url).href
);

const {
  KEPT_SESSION_DROPPED,
  SESSION_ALREADY_PRESENT,
  SESSION_IN_USE,
  SIGNUP_RESEND_WAIT_MS,
  isSessionAlreadyPresent,
  passkeyFinishRefusal,
  passkeyRecoverLookupFailure,
  passkeyRecoverProblem,
  passkeyRecoveryOffered,
  passkeySignupGate,
  passkeySignupProblem,
  recoverStartsAgain,
  resendWaitSeconds,
  secondFactorFrom,
  sessionFailureLine,
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

  // Fails if: an email the server will not take stops reading as one, and
  // the form shows the raw error instead of "that email cannot be used"
  it("reads IncorrectData and Blacklisted at start as an email that cannot be used", () => {
    assert.equal(passkeySignupProblem("IncorrectData", "start"), "bad_email");
    assert.equal(passkeySignupProblem("Blacklisted", "start"), "bad_email");
  });

  // Fails if: a code mail that could not be sent reads as anything other
  // than "try again later"
  it("reads EmailFailed at start as a mail that could not be sent", () => {
    assert.equal(passkeySignupProblem("EmailFailed", "start"), "mail_failed");
  });

  // Fails if: a sign-up stopped by the shield loses its own message
  it("reads BlockedByShield at start as a blocked sign-up", () => {
    assert.equal(passkeySignupProblem("BlockedByShield", "start"), "blocked");
  });

  // Fails if: the four start-only answers get their start meaning at a
  // later step, where the email is long accepted, or if one of them ends
  // the sign-up instead of leaving the form up for another try
  it("keeps the email and shield refusals to the start step, on the form", () => {
    const types = [
      "IncorrectData",
      "Blacklisted",
      "EmailFailed",
      "BlockedByShield",
    ];
    for (const type of types) {
      for (const step of ["code", "resend", "options", "finish"] as const) {
        assert.equal(passkeySignupProblem(type, step), undefined, type);
      }
    }
    for (const problem of ["bad_email", "mail_failed", "blocked"] as const) {
      assert.equal(signupStartsAgain(problem, "start"), false, problem);
    }
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

describe("passkeyRecoverLookupFailure", () => {
  const OFFERED = { available: true, signup: true };
  const NOT_OFFERED = [
    {},
    { available: false, signup: false },
    { available: true, signup: false },
    { available: false, signup: true },
  ];

  // Fails if: the recovery page paints "Could not check your link" on a
  // server that has no recovery route (a 404 with no error type) and says
  // in its advert that it does not offer recovery
  it("reads an untyped failure as off when the advert does not offer recovery", () => {
    for (const advert of NOT_OFFERED) {
      assert.equal(
        passkeyRecoverLookupFailure(undefined, advert),
        "off",
        JSON.stringify(advert),
      );
    }
  });

  // Fails if: the page leaves without a word while the link may still be
  // good: the server offers recovery, or nothing is known about it because
  // the advert lookup failed too (offline, say)
  it("keeps an untyped failure a failure when recovery is offered or the advert is unknown", () => {
    assert.equal(passkeyRecoverLookupFailure(undefined, OFFERED), "failed");
    assert.equal(passkeyRecoverLookupFailure(undefined, undefined), "failed");
  });

  // Fails if: a refusal with a meaning of its own (a rate limit, a server
  // error) is swallowed by the redirect because the advert says off
  it("keeps a typed failure with no recovery meaning a failure", () => {
    for (const advert of [undefined, OFFERED, ...NOT_OFFERED]) {
      assert.equal(
        passkeyRecoverLookupFailure("InternalError", advert),
        "failed",
        JSON.stringify(advert),
      );
    }
  });

  // Fails if: the server's own answers stop deciding ahead of the advert:
  // a dead link, FeatureDisabled or a typed NotFound, whatever the advert
  it("takes the server's typed answers as they are", () => {
    for (const advert of [undefined, OFFERED, ...NOT_OFFERED]) {
      const label = JSON.stringify(advert);
      assert.equal(
        passkeyRecoverLookupFailure("InvalidToken", advert),
        "bad_link",
        label,
      );
      assert.equal(
        passkeyRecoverLookupFailure("FeatureDisabled", advert),
        "off",
        label,
      );
      assert.equal(
        passkeyRecoverLookupFailure("NotFound", advert),
        "off",
        label,
      );
    }
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

describe("isSessionAlreadyPresent", () => {
  /** Built like stoat.js builds its error */
  class SessionAlreadyPresentError extends Error {
    constructor() {
      super("This client already has a session; the new one was not kept");
      this.name = "SessionAlreadyPresentError";
    }
  }

  // Fails if: the SDK's refusal to replace a session is not recognised, so
  // the sign-up, recovery and sign-in pages show a raw error instead of
  // "already signed in"
  it("knows the SDK error by its name", () => {
    assert.equal(SESSION_ALREADY_PRESENT, "SessionAlreadyPresentError");
    assert.equal(
      isSessionAlreadyPresent(new SessionAlreadyPresentError()),
      true,
    );
    // A copy from another bundle of the SDK is not the same class
    assert.equal(
      isSessionAlreadyPresent({ name: "SessionAlreadyPresentError" }),
      true,
    );
  });

  // Fails if: an ordinary failure (an API error body, a network error, the
  // app's own SessionInUseError, a cancelled prompt) reads as "already
  // signed in" and hides what really went wrong
  it("is false for everything else", () => {
    const inUse = new Error("This page already has a session in use");
    inUse.name = "SessionInUseError";

    for (const other of [
      undefined,
      null,
      "SessionAlreadyPresentError",
      "Cancelled",
      new Error("SessionAlreadyPresentError"),
      new TypeError("Failed to fetch"),
      inUse,
      { type: "InvalidCredentials" },
      { type: "SessionAlreadyPresentError" },
      { name: "sessionalreadypresenterror" },
    ]) {
      assert.equal(isSessionAlreadyPresent(other), false, String(other));
    }
  });
});

/** An error with a given `name`, as the SDK and the app build theirs */
function named(name: string): Error {
  const error = new Error("for the test");
  error.name = name;
  return error;
}

describe("passkeyFinishRefusal", () => {
  // Fails if: an ordinary failure of the last request (wrong passkey, no
  // network) is swallowed, or drops a client that holds nothing
  it("throws every other failure on, whatever the lifecycle state", () => {
    for (const ready of [true, false]) {
      for (const other of [
        undefined,
        new TypeError("Failed to fetch"),
        { type: "InvalidCredentials" },
        named(SESSION_IN_USE),
        named(KEPT_SESSION_DROPPED),
      ]) {
        assert.equal(passkeyFinishRefusal(other, ready), "rethrow");
      }
    }
  });

  // Fails if: a login that finished while the request was on its way has
  // its client dropped, or the attempt shows an error over a working login
  it("lets the session of a login that got there first stand", () => {
    assert.equal(
      passkeyFinishRefusal(named(SESSION_ALREADY_PRESENT), false),
      "stands",
    );
  });

  // Fails if: a session that was kept and never stored stays on the client
  // while nobody is signed in, so every later passkey attempt is refused
  // until a reload; or the attempt ends without a word
  it("drops a kept session when no login is under way", () => {
    assert.equal(
      passkeyFinishRefusal(named(SESSION_ALREADY_PRESENT), true),
      "drop",
    );
  });
});

describe("sessionFailureLine", () => {
  // Fails if: a person who is NOT signed in (the kept session was dropped)
  // is told "already signed in, sign out", or one who is signed in gets
  // the plain failure line
  it("tells a session in use from a dropped one", () => {
    assert.equal(SESSION_IN_USE, "SessionInUseError");
    assert.equal(KEPT_SESSION_DROPPED, "KeptSessionDroppedError");
    assert.equal(sessionFailureLine(named(SESSION_IN_USE)), "in_use");
    assert.equal(sessionFailureLine(named(KEPT_SESSION_DROPPED)), "try_again");
  });

  // Fails if: any other failure (the SDK's own refusal, an API error body,
  // a cancelled prompt) is replaced by one of the two session lines
  it("has no line for anything else", () => {
    for (const other of [
      undefined,
      null,
      "SessionInUseError",
      "KeptSessionDroppedError",
      new Error("SessionInUseError"),
      new TypeError("Failed to fetch"),
      named(SESSION_ALREADY_PRESENT),
      { type: "SessionInUseError" },
      { type: "InvalidCredentials" },
      { name: "keptsessiondroppederror" },
    ]) {
      assert.equal(sessionFailureLine(other), undefined, String(other));
    }
  });

  // Fails if: the sign-in page or the controller stops using the decisions
  // above (source level: neither file can be loaded here), the dropped
  // session is reported as "in use" again, or the plain line is missing
  // from the catalog (a missing msgid renders as its hash)
  it("is what the controller and the sign-in page go by", () => {
    const read = (path: string) =>
      readFileSync(new URL(path, import.meta.url), "utf8");
    const flat = (source: string) => source.replace(/\s+/g, " ");

    const controller = flat(read("../../../client/Controller.ts"));
    assert.ok(controller.includes("this.name = SESSION_IN_USE;"));
    assert.ok(controller.includes("this.name = KEPT_SESSION_DROPPED;"));
    assert.match(
      controller,
      /case "drop": this\.dropKeptSession\(\); throw new KeptSessionDroppedError\(\);/,
    );
    assert.equal(controller.match(/passkeyFinishRefusal\(/g)?.length, 1);

    const copy = "Something went wrong. Try again.";
    const page = flat(read("./FlowLogin.tsx"));
    assert.ok(
      page.includes(`case "try_again": return new Error(t\`${copy}\`);`),
    );
    assert.ok(page.includes('case "in_use": return passkeySession.inUse();'));

    const en = read("../../../i18n/catalogs/en/messages.po");
    assert.ok(en.includes(`msgid "${copy}"\nmsgstr "${copy}"\n`));
  });
});
