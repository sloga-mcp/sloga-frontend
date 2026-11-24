/**
 * Rules the account settings share for an account that has no email: the
 * emailed code, the wait before another code, the typed username that
 * confirms a deletion, and what a refused request means to the user.
 *
 * Leaf module: no app, Solid or SDK imports, so `node --test` loads it
 * (`accountRules.test.ts`).
 */

/** Digits in the code mailed to a new address */
export const EMAIL_CODE_LENGTH = 8;

/** The server mails at most one code a minute to an account */
export const EMAIL_RESEND_WAIT_MS = 60 * 1000;

/**
 * Query key of the account's info (`client.account.fetchInfo`). Keyed by
 * user, so the next account never sees this one's email.
 */
export function accountInfoKey(userId: string): string[] {
  return ["account-info", userId];
}

/**
 * Whether the app may offer "Add an email": the server has to offer both
 * passkeys and passkey sign-up, or the routes refuse.
 * @param advert Passkey part of the server's advert, if it was read
 */
export function mayAddEmail(
  advert: { available?: unknown; signup?: unknown } | null | undefined,
): boolean {
  return advert?.available === true && advert?.signup === true;
}

/**
 * Whether a typed address is worth sending. Loose on purpose: the server
 * decides what it takes. It only stops an obvious slip from spending the
 * confirmation that goes with the request.
 */
export function emailShapeOk(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/**
 * A code as typed, without the spaces and dashes people add when copying
 * one from an email
 */
export function cleanEmailCode(typed: string): string {
  return typed.replace(/[\s-]/g, "");
}

/**
 * Whether a typed code can be sent: exactly eight ASCII digits once cleaned.
 * Checked first, because every code sent counts against the five tries.
 */
export function emailCodeReady(typed: string): boolean {
  return new RegExp(`^[0-9]{${EMAIL_CODE_LENGTH}}$`).test(
    cleanEmailCode(typed),
  );
}

/**
 * Seconds until another code may be asked for
 * @param sentAt When the last code was asked for (ms), if one was
 * @param now Current time (ms)
 * @returns Whole seconds left, 0 when another code may be asked for
 */
export function resendWaitSeconds(
  sentAt: number | undefined,
  now: number,
): number {
  if (sentAt === undefined) return 0;

  // A clock that was set back must not stretch the wait past a minute
  const left = Math.min(
    sentAt + EMAIL_RESEND_WAIT_MS - now,
    EMAIL_RESEND_WAIT_MS,
  );
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

/**
 * The username to send with a deletion, once what was typed is the
 * account's username. The server compares exactly, case and all; only
 * spaces around it are dropped, which no username has.
 * @param typed What the person typed
 * @param username The account's username
 * @returns The username to send, or undefined while it does not match
 */
export function confirmedUsername(
  typed: string,
  username: string | undefined,
): string | undefined {
  if (!username) return undefined;
  return typed.trim() === username ? username : undefined;
}

/**
 * How long the delete button waits to hear which deletion applies before it
 * goes on with the emailed-link one
 */
export const DELETION_ASK_TIMEOUT_MS = 8000;

/**
 * An answer, or a stand-in when it fails or takes too long. Never rejects,
 * so a button waiting on it cannot hang.
 * @param asked The request
 * @param ms How long to wait for it
 * @param fallback What to go on with instead
 */
export function answerWithin<T>(
  asked: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);

    asked.then(
      (answer) => {
        clearTimeout(timer);
        resolve(answer);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** What the user was doing when the server refused */
export type AccountAction =
  | "add_email_start"
  | "add_email_finish"
  | "change_email"
  | "change_password"
  | "delete";

/** A refusal the account screens explain in their own words */
export type AccountProblem =
  | "off"
  | "has_email"
  | "bad_email"
  | "mail_failed"
  | "bad_code"
  | "confirm_again"
  | "need_password"
  | "need_email"
  | "owns_servers"
  | "not_deleted"
  | "wrong_username";

/**
 * What a refused account request means. `InvalidOperation` covers several
 * cases on the server; which one it is follows from the action, and for a
 * change of email from whether the account has an email at all.
 *
 * A refused deletion of an account with no email (`delete`), by what
 * delete_account.rs answers:
 * - `FailedValidation`: the typed username is not the account's.
 * - `NotPrivileged`: no confirmation the server takes came with the
 *   request (the ticket was missing, used, or had run out).
 * - `InvalidOperation`: the account owns servers; or it is disabled or
 *   already being deleted; or a sign-in somewhere else cancelled the
 *   deletion half way. Nothing was deleted in any of them. It reads as
 *   "owns servers" only when this device knows of one.
 * @param type Error type of the failed request
 * @param action What the user was doing
 * @param emailAbsent Whether the account is known to have no email
 * @param ownsServers Whether the user is known to own a server
 * @returns The problem, or undefined for an error with no meaning here
 */
export function accountProblem(
  type: string | undefined,
  action: AccountAction,
  emailAbsent?: boolean,
  ownsServers?: boolean,
): AccountProblem | undefined {
  switch (action) {
    case "add_email_start":
      switch (type) {
        case "FeatureDisabled":
          return "off";
        case "InvalidOperation":
          return "has_email";
        case "IncorrectData":
        case "Blacklisted":
        case "FailedValidation":
          return "bad_email";
        case "EmailFailed":
          return "mail_failed";
        case "InvalidToken":
          return "confirm_again";
        default:
          return undefined;
      }
    case "add_email_finish":
      switch (type) {
        case "FeatureDisabled":
          return "off";
        case "InvalidOperation":
          return "has_email";
        case "InvalidCredentials":
          return "bad_code";
        default:
          return undefined;
      }
    case "change_email":
      if (type !== "InvalidOperation") return undefined;
      return emailAbsent ? "need_email" : "need_password";
    case "change_password":
      return type === "InvalidOperation" ? "need_email" : undefined;
    case "delete":
      switch (type) {
        case "FailedValidation":
          return "wrong_username";
        case "InvalidOperation":
          return ownsServers ? "owns_servers" : "not_deleted";
        case "NotPrivileged":
        case "InvalidToken":
          return "confirm_again";
        default:
          return undefined;
      }
  }
}
