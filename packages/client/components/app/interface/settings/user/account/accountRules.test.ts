// Run: node --test --conditions=browser components/app/interface/settings/user/account/accountRules.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DELETION_ASK_TIMEOUT_MS,
  EMAIL_CODE_LENGTH,
  EMAIL_RESEND_WAIT_MS,
  accountInfoKey,
  accountProblem,
  answerWithin,
  cleanEmailCode,
  confirmedUsername,
  emailCodeReady,
  emailShapeOk,
  mayAddEmail,
  resendWaitSeconds,
} from "./accountRules.ts";

describe("mayAddEmail", () => {
  // Fails if: "Add an email" is offered while either flag is off (it must
  // ship dark), or a flag that is not a plain true counts as on.
  it("needs both passkeys and passkey sign-up", () => {
    assert.equal(mayAddEmail({ available: true, signup: true }), true);
    assert.equal(mayAddEmail({ available: true, signup: false }), false);
    assert.equal(mayAddEmail({ available: false, signup: true }), false);
    assert.equal(mayAddEmail({ available: false, signup: false }), false);
    assert.equal(mayAddEmail({ available: "true", signup: 1 }), false);
    assert.equal(mayAddEmail({}), false);
    assert.equal(mayAddEmail(undefined), false);
    assert.equal(mayAddEmail(null), false);
  });
});

describe("accountInfoKey", () => {
  // Fails if: two accounts share one cached answer, so the next account on
  // this device would be shown the last one's email state.
  it("is keyed by user", () => {
    assert.deepEqual(accountInfoKey("A"), ["account-info", "A"]);
    assert.notDeepEqual(accountInfoKey("A"), accountInfoKey("B"));
  });
});

describe("emailShapeOk", () => {
  // Fails if: an address with no @, no domain dot or a space is sent (each
  // such request spends a confirmation), or an ordinary address is refused.
  it("stops only obvious slips", () => {
    for (const email of ["a@b.co", " someone@example.com ", "a+b@x.y.z"]) {
      assert.equal(emailShapeOk(email), true, email);
    }
    for (const email of ["", "   ", "someone", "a@b", "a b@c.de", "@b.co"]) {
      assert.equal(emailShapeOk(email), false, email);
    }
  });
});

describe("the emailed code", () => {
  // Fails if: spaces or dashes copied with the code reach the server (a
  // wasted try), or digits are dropped while cleaning.
  it("is cleaned of spaces and dashes only", () => {
    assert.equal(cleanEmailCode(" 1234 5678 "), "12345678");
    assert.equal(cleanEmailCode("1234-5678"), "12345678");
    assert.equal(cleanEmailCode("12a45678"), "12a45678");
  });

  // Fails if: a code of the wrong length, with a letter, or with digits
  // that are not ASCII can be sent. Each one would cost one of five tries.
  it("is ready at exactly eight ASCII digits", () => {
    assert.equal(EMAIL_CODE_LENGTH, 8);
    assert.equal(emailCodeReady("12345678"), true);
    assert.equal(emailCodeReady("1234 5678"), true);
    assert.equal(emailCodeReady("00000000"), true);
    assert.equal(emailCodeReady(""), false);
    assert.equal(emailCodeReady("1234567"), false);
    assert.equal(emailCodeReady("123456789"), false);
    assert.equal(emailCodeReady("1234567a"), false);
    assert.equal(emailCodeReady("１２３４５６７８"), false);
  });
});

describe("resendWaitSeconds", () => {
  const sent = 1_000_000;

  // Fails if: "Send again" opens before the server's minute is over (the
  // request would be answered 204 and mail nothing), or never opens.
  it("counts down one minute from the last request", () => {
    assert.equal(EMAIL_RESEND_WAIT_MS, 60_000);
    assert.equal(resendWaitSeconds(sent, sent), 60);
    assert.equal(resendWaitSeconds(sent, sent + 1), 60);
    assert.equal(resendWaitSeconds(sent, sent + 59_001), 1);
    assert.equal(resendWaitSeconds(sent, sent + 59_999), 1);
    assert.equal(resendWaitSeconds(sent, sent + 60_000), 0);
    assert.equal(resendWaitSeconds(sent, sent + 600_000), 0);
  });

  // Fails if: there is a wait before the first code was ever asked for.
  it("has no wait before the first request", () => {
    assert.equal(resendWaitSeconds(undefined, sent), 0);
  });

  // Fails if: a device clock that was set back holds the button for longer
  // than the minute the server keeps.
  it("never waits longer than a minute", () => {
    assert.equal(resendWaitSeconds(sent, sent - 3_600_000), 60);
  });
});

describe("confirmedUsername", () => {
  // Fails if: the delete button opens for anything but the account's own
  // username (another case, a prefix, name#tag), or the value sent differs
  // from the username the server compares with.
  it("matches the username exactly, apart from spaces around it", () => {
    assert.equal(confirmedUsername("Mara", "Mara"), "Mara");
    assert.equal(confirmedUsername("  Mara ", "Mara"), "Mara");
    assert.equal(confirmedUsername("mara", "Mara"), undefined);
    assert.equal(confirmedUsername("MARA", "Mara"), undefined);
    assert.equal(confirmedUsername("Mar", "Mara"), undefined);
    assert.equal(confirmedUsername("Mara#1234", "Mara"), undefined);
    assert.equal(confirmedUsername("", "Mara"), undefined);
  });

  // Fails if: an unknown username lets an empty box confirm the deletion.
  it("never matches while the username is unknown", () => {
    assert.equal(confirmedUsername("", undefined), undefined);
    assert.equal(confirmedUsername("", ""), undefined);
    assert.equal(confirmedUsername("undefined", undefined), undefined);
  });
});

describe("answerWithin", () => {
  // Fails if: the delete button waits for longer than it says, or the wait
  // is no longer the 8 s the page promises.
  it("waits 8 s for the deletion question", () => {
    assert.equal(DELETION_ASK_TIMEOUT_MS, 8000);
  });

  // Fails if: an answer that came in time is replaced by the stand-in.
  it("passes on an answer that comes in time", async () => {
    assert.equal(await answerWithin(Promise.resolve(true), 1000, false), true);
    assert.equal(await answerWithin(Promise.resolve(false), 1000, true), false);
  });

  // Fails if: a failed request rejects (the button's busy state would never
  // clear) instead of going on with the stand-in.
  it("goes on with the stand-in when the request fails", async () => {
    assert.equal(
      await answerWithin(Promise.reject(new Error("offline")), 1000, false),
      false,
    );
  });

  // Fails if: a request that never answers holds the button forever, or a
  // late answer overrides the stand-in that was already acted on.
  it("goes on with the stand-in when the request takes too long", async () => {
    let answer!: (value: boolean) => void;
    const never = new Promise<boolean>((resolve) => (answer = resolve));

    const result = answerWithin(never, 20, false);
    assert.equal(await result, false);

    answer(true);
    assert.equal(await result, false);
  });
});

describe("accountProblem", () => {
  // Fails if: a refused "add an email" request falls through to the general
  // error dialog (which has no words for these types), or a wrong code is
  // told apart from an address that was taken meanwhile.
  it("explains a refused add-email request", () => {
    assert.equal(accountProblem("FeatureDisabled", "add_email_start"), "off");
    assert.equal(
      accountProblem("InvalidOperation", "add_email_start"),
      "has_email",
    );
    for (const type of ["IncorrectData", "Blacklisted", "FailedValidation"]) {
      assert.equal(accountProblem(type, "add_email_start"), "bad_email", type);
    }
    assert.equal(
      accountProblem("EmailFailed", "add_email_start"),
      "mail_failed",
    );
    assert.equal(
      accountProblem("InvalidToken", "add_email_start"),
      "confirm_again",
    );

    assert.equal(accountProblem("FeatureDisabled", "add_email_finish"), "off");
    assert.equal(
      accountProblem("InvalidOperation", "add_email_finish"),
      "has_email",
    );
    assert.equal(
      accountProblem("InvalidCredentials", "add_email_finish"),
      "bad_code",
    );
    // A wrong code is only ever the finish step's answer
    assert.equal(
      accountProblem("InvalidCredentials", "add_email_start"),
      undefined,
    );
  });

  // Fails if: an account with no password is not told to add one before
  // changing its email, or an account with no email is told to add a
  // password (which it cannot do without an email).
  it("reads a refused change of email by what the account lacks", () => {
    assert.equal(
      accountProblem("InvalidOperation", "change_email"),
      "need_password",
    );
    assert.equal(
      accountProblem("InvalidOperation", "change_email", false),
      "need_password",
    );
    assert.equal(
      accountProblem("InvalidOperation", "change_email", true),
      "need_email",
    );
    assert.equal(
      accountProblem("InvalidCredentials", "change_email"),
      undefined,
    );
  });

  // Fails if: a no-email account that tries to set a password is not told
  // that an email comes first.
  it("reads a refused change of password as a missing email", () => {
    assert.equal(
      accountProblem("InvalidOperation", "change_password"),
      "need_email",
    );
    assert.equal(
      accountProblem("InvalidCredentials", "change_password"),
      undefined,
    );
    assert.equal(
      accountProblem("DisallowedMFAMethod", "change_password"),
      undefined,
    );
  });

  // Fails if: a refused deletion of a no-email account shows the wrong
  // reason, a wrong username reads as owning servers, or a confirmation the
  // server did not take (NotPrivileged) goes to the general error dialog.
  it("explains a refused deletion", () => {
    assert.equal(
      accountProblem("FailedValidation", "delete"),
      "wrong_username",
    );
    assert.equal(accountProblem("InvalidToken", "delete"), "confirm_again");
    assert.equal(accountProblem("NotPrivileged", "delete"), "confirm_again");
    // Only a deletion is confirmed this way
    assert.equal(accountProblem("NotPrivileged", "change_email"), undefined);
  });

  // Fails if: a user who owns no server is told to transfer or delete their
  // servers (the server answers InvalidOperation for a cancelled or repeated
  // deletion too), or a user who does own one loses that advice.
  it("blames owned servers only for a user who owns one", () => {
    assert.equal(accountProblem("InvalidOperation", "delete"), "not_deleted");
    assert.equal(
      accountProblem("InvalidOperation", "delete", true, false),
      "not_deleted",
    );
    assert.equal(
      accountProblem("InvalidOperation", "delete", true, true),
      "owns_servers",
    );
    // Owning a server changes no other answer
    assert.equal(
      accountProblem("FailedValidation", "delete", true, true),
      "wrong_username",
    );
    assert.equal(
      accountProblem("NotPrivileged", "delete", true, true),
      "confirm_again",
    );
  });

  // Fails if: an error with no meaning here is swallowed instead of going
  // to the general error dialog.
  it("leaves other errors to the general error dialog", () => {
    for (const action of [
      "add_email_start",
      "add_email_finish",
      "change_email",
      "change_password",
      "delete",
    ] as const) {
      assert.equal(accountProblem(undefined, action), undefined, action);
      assert.equal(accountProblem("InternalError", action), undefined, action);
    }
  });
});
