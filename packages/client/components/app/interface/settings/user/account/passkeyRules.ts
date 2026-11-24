/**
 * Rules the passkey screens share: what a passkey may be called, and what a
 * refused request means to the user.
 *
 * Leaf module: no app, Solid or SDK imports, so `node --test` loads it
 * (`passkeyRules.test.ts`).
 */

/** Longest passkey name the server takes, counted after trimming */
export const PASSKEY_NAME_MAX = 64;

/** Why a passkey name cannot be used */
export type PasskeyNameProblem = "empty" | "long" | "control";

/**
 * Check a passkey name the way the server does: 1 to 64 characters after
 * trimming, no control characters. Checked before any request, because a
 * refused request spends the ticket sent with it.
 * @param name Name as typed
 * @returns The problem, or undefined for a usable name
 */
export function passkeyNameProblem(
  name: string,
): PasskeyNameProblem | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "empty";
  if (/\p{Cc}/u.test(trimmed)) return "control";
  // Counted in code points, as the server counts characters
  if ([...trimmed].length > PASSKEY_NAME_MAX) return "long";
  return undefined;
}

/**
 * What the user was doing when the server refused. `start` is asking for
 * the options to create a passkey with; `add` is storing the one created.
 */
export type PasskeyAction = "start" | "add" | "remove" | "rename" | "confirm";

/** A refusal the passkey screens explain in their own words */
export type PasskeyProblem =
  | "off"
  | "sign_in_again"
  | "after_reset"
  | "not_accepted"
  | "already_added"
  | "limit"
  | "last_way_in"
  | "no_passkey"
  | "bad_name";

/**
 * What a refused passkey request means. `InvalidOperation` covers three
 * cases on the server; which one it is follows from the action.
 * @param type Error type of the failed request
 * @param action What the user was doing
 * @returns The problem, or undefined for an error with no passkey meaning
 */
export function passkeyProblem(
  type: string | undefined,
  action: PasskeyAction,
): PasskeyProblem | undefined {
  switch (type) {
    case "FeatureDisabled":
      return "off";
    case "NotPrivileged":
      return action === "add" ? "sign_in_again" : undefined;
    case "InvalidCredentials":
      // No passkey exists yet at the start step, so there the only cause is
      // a session older than the account's last password reset. The step
      // that stores the passkey gives the same answer for a passkey it did
      // not accept, and the two cannot be told apart there.
      if (action === "start") return "after_reset";
      return action === "add" || action === "confirm"
        ? "not_accepted"
        : undefined;
    case "NoEffect":
      return action === "add" ? "already_added" : undefined;
    case "InvalidOperation":
      switch (action) {
        case "add":
          return "limit";
        case "remove":
          return "last_way_in";
        case "confirm":
          return "no_passkey";
        default:
          return undefined;
      }
    case "FailedValidation":
      return action === "add" || action === "rename" ? "bad_name" : undefined;
    default:
      return undefined;
  }
}

/** What comes after the name when a passkey is being added */
export type AddPasskeyStep = "create" | "confirm" | "sign_in_again";

/**
 * What adding a passkey needs next, from what the start step answered.
 * @param ticketRequired `ticket_required` of the start step
 * @param methodCount How many ways the account has to confirm an action
 * @returns `create`: no confirmation, go on to the device prompt (a first
 * passkey on a fresh Google or Apple sign-in). `confirm`: ask for a ticket
 * first. `sign_in_again`: a ticket is wanted and the account has nothing to
 * make one with, so only a fresh sign-in helps; no passkey is created that
 * the server would refuse.
 */
export function addPasskeyStep(
  ticketRequired: boolean,
  methodCount: number,
): AddPasskeyStep {
  if (!ticketRequired) return "create";
  return methodCount > 0 ? "confirm" : "sign_in_again";
}

/**
 * Whether the device prompt may open now. The start step is asked again
 * right before it, and a session that needed no ticket a few minutes ago
 * may need one by then: the device must not make a passkey the server
 * will not store.
 * @param ticketRequired `ticket_required` of the start step, asked just now
 * @param hasTicket Whether a ticket is in hand
 */
export function mayCreatePasskeyNow(
  ticketRequired: boolean,
  hasTicket: boolean,
): boolean {
  return hasTicket || !ticketRequired;
}

/**
 * Put the passkey first among the ways to confirm an action, keeping the
 * order of the rest.
 * @param methods Methods as the account reports them
 * @returns The same methods, passkey first
 */
export function passkeyFirst<T extends string>(methods: readonly T[]): T[] {
  return [
    ...methods.filter((method) => method === "Passkey"),
    ...methods.filter((method) => method !== "Passkey"),
  ];
}
