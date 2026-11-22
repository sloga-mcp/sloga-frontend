/**
 * Read the `type` of a failed API request. Kept import-free so node can
 * spec it.
 *
 * stoat-api throws the raw response body of a failed request as a string,
 * usually `{"type":"MissingPermission",...}`, but a proxy can return HTML.
 * An already-parsed body (an object with a string `type`) is read as is.
 *
 * @returns the error type, or undefined for anything that isn't an API error
 */
export function apiErrorType(error: unknown): string | undefined {
  const body = apiErrorBody(error);
  if (body === undefined) return undefined;

  const type = (body as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

/**
 * The parsed body of a thrown value, or undefined when there is none
 */
function apiErrorBody(error: unknown): object | undefined {
  let body: unknown = error;
  if (typeof error === "string") {
    try {
      body = JSON.parse(error);
    } catch {
      return undefined;
    }
  }

  if (typeof body !== "object" || body === null) return undefined;
  return body;
}

/** Error type the server answers a refused plain write with (HTTP 403) */
export const ENCRYPTION_REQUIRED_ERROR_TYPE = "EncryptionRequired";

/** `name` of the error stoat.js throws when the app's own guard refuses */
export const ENCRYPTED_ONLY_BLOCKED_ERROR_NAME = "EncryptedOnlyBlockedError";

/**
 * Why a write was refused for not being encrypted. The server sends
 * `sender`, `recipient`, `group` or `member` as `side`; the app's guard
 * gives `sender`, `recipient`, `group`, `setup` or `open-app` as `reason`.
 */
export type EncryptionRequiredSide =
  | "sender"
  | "recipient"
  | "group"
  | "member"
  | "setup"
  | "open-app";

export const ENCRYPTION_REQUIRED_SIDES: readonly EncryptionRequiredSide[] = [
  "sender",
  "recipient",
  "group",
  "member",
  "setup",
  "open-app",
];

/**
 * Side used when the refusal names one this build does not know. The
 * refusal still counts, so nothing offers to send the message unencrypted.
 */
export const ENCRYPTION_REQUIRED_FALLBACK_SIDE: EncryptionRequiredSide =
  "sender";

/**
 * Narrow a value to a known side
 */
export function isEncryptionRequiredSide(
  value: unknown,
): value is EncryptionRequiredSide {
  return (
    typeof value === "string" &&
    (ENCRYPTION_REQUIRED_SIDES as readonly string[]).includes(value)
  );
}

/**
 * Whether a thrown value says the write must be encrypted, and why. Reads
 * both the server's `EncryptionRequired` body (string or parsed) and the
 * `EncryptedOnlyBlockedError` thrown before any request is made. The error
 * is matched by name, so one from another window still reads.
 *
 * @returns the side, or undefined for any other error
 */
export function encryptionRequiredSide(
  error: unknown,
): EncryptionRequiredSide | undefined {
  let side: unknown;

  if (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === ENCRYPTED_ONLY_BLOCKED_ERROR_NAME
  ) {
    side = (error as { reason?: unknown }).reason;
  } else if (apiErrorType(error) === ENCRYPTION_REQUIRED_ERROR_TYPE) {
    side = (apiErrorBody(error) as { side?: unknown }).side;
  } else {
    return undefined;
  }

  return isEncryptionRequiredSide(side)
    ? side
    : ENCRYPTION_REQUIRED_FALLBACK_SIDE;
}
