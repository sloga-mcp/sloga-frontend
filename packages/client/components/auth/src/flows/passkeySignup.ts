/**
 * Rules of the signed-out passkey screens: when they are offered, what a
 * refused request means to the person, and how typed codes are read.
 *
 * Leaf module: no app, Solid or SDK imports, so `node --test` loads it
 * (`passkeySignup.test.ts`).
 */

/** The part of the server's passkey advert these screens read */
export interface SignupAdvert {
  available?: boolean;
  signup?: boolean;
  signup_without_email?: boolean;
}

/**
 * Whether passkey sign-up is offered, and whether it needs an email.
 * `off` renders nothing at all.
 */
export type PasskeySignupGate = "off" | "email_required" | "email_optional";

/**
 * Decide whether passkey sign-up is offered. Needs both advert flags and a
 * device that can create a passkey (the desktop apps cannot).
 * @param advert Passkey advert; undefined while it is loading or after a failed lookup
 * @param supported Whether this device can run a passkey prompt
 */
export function passkeySignupGate(
  advert: SignupAdvert | undefined,
  supported: boolean,
): PasskeySignupGate {
  if (advert?.available !== true || advert.signup !== true || !supported) {
    return "off";
  }

  return advert.signup_without_email === true
    ? "email_optional"
    : "email_required";
}

/**
 * Whether lost-passkey recovery is offered. Needs both advert flags, and no
 * passkey support: the link is mailed and opens on the website.
 * @param advert Passkey advert; undefined while it is loading or after a failed lookup
 */
export function passkeyRecoveryOffered(
  advert: SignupAdvert | undefined,
): boolean {
  return advert?.available === true && advert.signup === true;
}

/** Which sign-up request the server refused */
export type SignupStep = "start" | "code" | "resend" | "options" | "finish";

/** A sign-up refusal these screens explain in their own words */
export type SignupProblem =
  | "off"
  | "email_required"
  | "bad_code"
  | "expired"
  | "invite_invalid"
  | "invite_missing"
  | "username_taken"
  | "already_registered"
  | "not_accepted";

/**
 * What a refused sign-up request means. `InvalidCredentials` covers three
 * cases on the server; which one it is follows from the step.
 * @param type Error type of the failed request
 * @param step Request that failed
 * @returns The problem, or undefined for an error shown as it is
 */
export function passkeySignupProblem(
  type: string | undefined,
  step: SignupStep,
): SignupProblem | undefined {
  switch (type) {
    case "FeatureDisabled":
      return "off";
    case "InvalidOperation":
      return step === "start" || step === "options" || step === "finish"
        ? "email_required"
        : undefined;
    case "InvalidCredentials":
      switch (step) {
        case "code":
          return "bad_code";
        case "options":
          return "expired";
        case "finish":
          return "not_accepted";
        default:
          return undefined;
      }
    case "InvalidInvite":
      return step === "start" || step === "finish"
        ? "invite_invalid"
        : undefined;
    case "MissingInvite":
      return step === "start" || step === "finish"
        ? "invite_missing"
        : undefined;
    case "UsernameTaken":
      return step === "start" || step === "finish"
        ? "username_taken"
        : undefined;
    case "NoEffect":
      return step === "finish" ? "already_registered" : undefined;
    default:
      return undefined;
  }
}

/**
 * Whether a refusal means the pending sign-up is gone and the person fills
 * in the form again. A refused passkey at finish (`not_accepted`) keeps the
 * sign-up; if it was spent after all, the next options request says so.
 * @param problem Problem from {@link passkeySignupProblem}
 * @param step Request that failed
 */
export function signupStartsAgain(
  problem: SignupProblem | undefined,
  step: SignupStep,
): boolean {
  switch (problem) {
    case "off":
    case "email_required":
    case "expired":
      return true;
    case "invite_invalid":
    case "invite_missing":
    case "username_taken":
    case "already_registered":
      return step === "finish";
    default:
      return false;
  }
}

// No count of wrong codes is kept here. The server counts them for each code
// it mails and gives fresh tries with every new code, so a count kept on the
// page would end a sign-up that is still good. A refused code stays on the
// code step; only the server's own answers send the person back to the form
// (see signupStartsAgain).

/**
 * Read the emailed sign-up code as typed: 8 digits, with any spaces or
 * dashes dropped.
 * @param input Field value
 * @returns The code, or undefined if it cannot be one
 */
export function signupCodeFrom(input: string): string | undefined {
  const code = input.replace(/[\s-]/g, "");
  return /^[0-9]{8}$/.test(code) ? code : undefined;
}

/** Wait between two "send again" requests, as the server enforces it */
export const SIGNUP_RESEND_WAIT_MS = 60_000;

/**
 * Seconds left before the code can be sent again
 * @param lastSentAt When a code was last asked for (ms)
 * @param now Current time (ms)
 * @returns Whole seconds, 0 when it can be sent now
 */
export function resendWaitSeconds(lastSentAt: number, now: number): number {
  const left = lastSentAt + SIGNUP_RESEND_WAIT_MS - now;
  if (!(left > 0)) return 0;

  // A clock set back must not lock the button for longer than one wait
  return Math.ceil(Math.min(left, SIGNUP_RESEND_WAIT_MS) / 1000);
}

/** Which recovery request the server refused */
export type RecoverStep = "send" | "start" | "finish";

/** A recovery refusal these screens explain in their own words */
export type RecoverProblem =
  | "off"
  | "bad_link"
  | "wrong_code"
  | "not_accepted"
  | "locked"
  | "already_registered";

/**
 * What a refused recovery request means
 * @param type Error type of the failed request
 * @param step Request that failed
 * @param secondFactor Whether a second-factor code went with the request
 * @returns The problem, or undefined for an error shown as it is
 */
export function passkeyRecoverProblem(
  type: string | undefined,
  step: RecoverStep,
  secondFactor: boolean,
): RecoverProblem | undefined {
  switch (type) {
    case "FeatureDisabled":
      return "off";
    // A server that does not have the route yet answers NotFound: same as off
    case "NotFound":
      return step === "start" ? "off" : undefined;
    case "InvalidToken":
      return step === "send" ? undefined : "bad_link";
    case "InvalidCredentials":
      if (step !== "finish") return undefined;
      return secondFactor ? "wrong_code" : "not_accepted";
    case "LockedOut":
      return step === "finish" ? "locked" : undefined;
    case "NoEffect":
      return step === "finish" ? "already_registered" : undefined;
    default:
      return undefined;
  }
}

/**
 * Whether a refused finish cost the challenge while the link stays good, so
 * the page asks for a new challenge and the person tries again.
 * @param problem Problem from {@link passkeyRecoverProblem}
 */
export function recoverStartsAgain(
  problem: RecoverProblem | undefined,
): boolean {
  return problem === "wrong_code" || problem === "not_accepted";
}

/** Second factor of a recovery, in the shape the SDK takes */
export type RecoverSecondFactor =
  | { totp_code: string; recovery_code?: undefined }
  | { recovery_code: string; totp_code?: undefined };

/**
 * Read the second-factor field: six digits are an authenticator code,
 * anything else is an MFA recovery code. Never both.
 * @param input Field value
 * @returns The factor, or undefined for an empty field
 */
export function secondFactorFrom(
  input: string,
): RecoverSecondFactor | undefined {
  const value = input.trim();
  if (!value) return undefined;

  const digits = value.replace(/\s/g, "");
  if (/^[0-9]{6}$/.test(digits)) return { totp_code: digits };

  return { recovery_code: value };
}
