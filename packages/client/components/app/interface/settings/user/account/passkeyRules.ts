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

/** What the user was doing when the server refused */
export type PasskeyAction = "add" | "remove" | "rename" | "confirm";

/** A refusal the passkey screens explain in their own words */
export type PasskeyProblem =
  | "off"
  | "sign_in_again"
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
