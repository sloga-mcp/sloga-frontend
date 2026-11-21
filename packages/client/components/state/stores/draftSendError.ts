import {
  ENCRYPTION_REQUIRED_FALLBACK_SIDE,
  type EncryptionRequiredSide,
  encryptionRequiredSide,
  isEncryptionRequiredSide,
} from "../../client/apiErrorType.ts";

/**
 * Outbox entry `error` for a send the server refused with
 * `DirectMessagesPaused`: the sender is paused from messaging people who
 * aren't their friends while staff review the account. Stores can't
 * translate, so this machine marker is stored instead of English text and
 * `DraftMessage` renders the translated explanation in its place.
 *
 * Imports only `apiErrorType.ts`, which imports nothing, so `node --test`
 * can load it; `./Draft.ts` reaches the whole app through `State`.
 */
export const DM_PAUSED_SEND_ERROR = "DirectMessagesPaused";

/**
 * Start of the outbox entry `error` for a send refused because it was not
 * encrypted. The side follows, as in `EncryptionRequired:recipient`. Read
 * it back with `encryptionRequiredSendError`.
 */
export const ENCRYPTION_REQUIRED_SEND_ERROR_PREFIX = "EncryptionRequired:";

/**
 * A send refused because it was not encrypted, by the server or by the
 * app's own guard before any request
 */
export interface EncryptionRequiredSendError {
  kind: "encryption-required";
  side: EncryptionRequiredSide;
}

/**
 * Turn whatever a send attempt threw into one line for the failed message
 * @param error Thrown value
 * @returns Human-readable reason, `DM_PAUSED_SEND_ERROR`, or an
 * encryption-required marker
 */
export function describeSendError(error: unknown): string {
  // Before the message check: the guard's error carries only its reason as
  // the message, which is not text for a person
  const side = encryptionRequiredSide(error);
  if (side) return ENCRYPTION_REQUIRED_SEND_ERROR_PREFIX + side;

  if (error instanceof Error && error.message) return error.message;

  // stoat-api throws the raw response body of a failed request as a string:
  // usually `{"type":"MissingPermission",...}`, but a proxy can return HTML
  let body: unknown = error;
  if (typeof error === "string") {
    try {
      body = JSON.parse(error);
    } catch {
      body = undefined;
    }
  }

  if (typeof body === "object" && body !== null && "type" in body) {
    const type = (body as { type: unknown }).type;
    if (type === "DirectMessagesPaused") return DM_PAUSED_SEND_ERROR;
    return `The server rejected the message (${String(type)})`;
  }

  if (typeof error === "string" && error.trim()) {
    return "The server returned an error";
  }

  return "Unknown error";
}

/**
 * Read an outbox entry's `error` back as an encryption-required refusal
 * @param stored The entry's `error`
 * @returns The refusal, or undefined for any other reason
 */
export function encryptionRequiredSendError(
  stored: string | undefined,
): EncryptionRequiredSendError | undefined {
  if (!stored?.startsWith(ENCRYPTION_REQUIRED_SEND_ERROR_PREFIX)) {
    return undefined;
  }

  // A side stored by a newer build still counts as a refusal
  const side = stored.slice(ENCRYPTION_REQUIRED_SEND_ERROR_PREFIX.length);
  return {
    kind: "encryption-required",
    side: isEncryptionRequiredSide(side)
      ? side
      : ENCRYPTION_REQUIRED_FALLBACK_SIDE,
  };
}

/**
 * Whether a failed entry may be sent again unchanged. False for a send
 * refused for not being encrypted: the same send is refused again, so the
 * row must not offer a plain retry.
 * @param stored The entry's `error`
 */
export function canRetrySendAsIs(stored: string | undefined): boolean {
  return encryptionRequiredSendError(stored) === undefined;
}
