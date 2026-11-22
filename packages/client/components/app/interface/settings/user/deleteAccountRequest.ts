/**
 * Requesting account deletion from Settings → Account Info.
 *
 * The request (`POST /auth/account/delete`) only emails a confirm link;
 * nothing is deleted until the link is confirmed. It is tried WITHOUT an MFA
 * ticket first, because an account linked to Google or Apple sign-in with no
 * MFA has a random, unusable password and could never pass the password
 * prompt. The server allows those through and answers 403 `NotPrivileged` to
 * everyone else (an older server answers 401 for the missing ticket). Only
 * those two statuses fall back to the password / MFA prompt.
 *
 * Every other failure is the caller's to show, never a reason to prompt for a
 * password: 400 `InvalidOperation` (the account still owns servers), 429, a
 * 5xx or a network error would all fail the same way again with a ticket.
 *
 * Pure (no solid-js, lingui or client imports), so `deleteAccountRequest.test.ts`
 * drives it under `node --test`.
 */

/**
 * `"requested"`: the server accepted the request and emailed the link.
 * `"cancelled"`: the user closed the password / MFA prompt; nothing was sent.
 */
export type DeleteAccountRequestOutcome = "requested" | "cancelled";

export type DeleteAccountRequestDeps = {
  /** `POST /auth/account/delete` with no MFA ticket; rejects on failure */
  ticketless: () => Promise<void>;
  /**
   * The MFA flow, then the request with its ticket. Resolves `false` when the
   * user cancels the prompt, `true` once the request went through; rejects
   * when the request itself fails.
   */
  withTicket: () => Promise<boolean>;
  /** HTTP status of an error `ticketless` threw, `undefined` if it has none */
  statusOf: (error: unknown) => number | undefined;
};

/**
 * Whether a failed ticketless request should fall back to the MFA prompt:
 * only when the server said a ticket is needed (403 now, 401 from a server
 * that predates ticketless requests). A missing status (network error) never
 * falls back.
 */
export function needsTicketFallback(status: number | undefined): boolean {
  return status === 401 || status === 403;
}

/**
 * Request account deletion: ticketless first, then the MFA prompt only on
 * 401 / 403. Any other error, including one from the ticketed request, is
 * rethrown for the caller to show.
 */
export async function requestAccountDeletion(
  deps: DeleteAccountRequestDeps,
): Promise<DeleteAccountRequestOutcome> {
  try {
    await deps.ticketless();
    return "requested";
  } catch (error) {
    if (!needsTicketFallback(deps.statusOf(error))) throw error;
  }

  return (await deps.withTicket()) ? "requested" : "cancelled";
}

/**
 * A failed response to the ticketless request.
 *
 * Carries the HTTP status, which the API client cannot give us: it throws only
 * the response body, and a 401 from the session guard has no error type in
 * it. `type` is the API's own error type when the body named one, which
 * `useError` translates (it checks `type` before `message`).
 */
export class DeleteAccountRequestError extends Error {
  readonly status: number;
  readonly type?: string;

  constructor(status: number, statusText: string, type?: string) {
    super(statusText ? `${status} ${statusText}` : `HTTP ${status}`);
    this.name = "DeleteAccountRequestError";
    this.status = status;
    this.type = type;
  }
}

/** Status of a {@link DeleteAccountRequestError}, `undefined` for anything else */
export function deleteRequestStatus(error: unknown): number | undefined {
  return error instanceof DeleteAccountRequestError ? error.status : undefined;
}

/**
 * Whether the server refused because the account still owns servers: on this
 * route that is the only `InvalidOperation` (400). `useError` shows that type
 * untranslated, so the page swaps in its own owned-server text.
 *
 * Takes either failure shape: our {@link DeleteAccountRequestError} from the
 * ticketless try, or the raw JSON body string the API client throws from the
 * ticketed one.
 */
export function isOwnedServersRefusal(error: unknown): boolean {
  let body = error;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return false;
    }
  }
  return (body as { type?: unknown } | null)?.type === "InvalidOperation";
}

/**
 * `POST /auth/account/delete` with the session's own headers and no
 * `X-MFA-Ticket`. Plain fetch rather than the API client so the status
 * survives (see {@link DeleteAccountRequestError}). A rejected fetch (network
 * error) propagates as is, with no status.
 *
 * @param fetchFn `fetch`, injected for tests
 * @param baseURL API base the client uses, without a trailing slash
 * @param headers The client's session headers
 */
export async function postDeleteAccountTicketless(
  fetchFn: typeof fetch,
  baseURL: string,
  headers: Record<string, string>,
): Promise<void> {
  const response = await fetchFn(`${baseURL}/auth/account/delete`, {
    method: "POST",
    headers,
  });
  if (response.ok) return;

  const body = (await response.json().catch(() => undefined)) as
    | { type?: unknown }
    | null
    | undefined;
  throw new DeleteAccountRequestError(
    response.status,
    response.statusText,
    typeof body?.type === "string" ? body.type : undefined,
  );
}
