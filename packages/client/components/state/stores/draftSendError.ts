/**
 * Outbox entry `error` for a send the server refused with
 * `DirectMessagesPaused`: the sender is paused from messaging people who
 * aren't their friends while staff review the account. Stores can't
 * translate, so this machine marker is stored instead of English text and
 * `DraftMessage` renders the translated explanation in its place.
 *
 * Kept free of imports so `node --test` can load it; `./Draft.ts` reaches
 * the whole app through `State`.
 */
export const DM_PAUSED_SEND_ERROR = "DirectMessagesPaused";

/**
 * Turn whatever a send attempt threw into one line for the failed message
 * @param error Thrown value
 * @returns Human-readable reason, or `DM_PAUSED_SEND_ERROR`
 */
export function describeSendError(error: unknown): string {
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
