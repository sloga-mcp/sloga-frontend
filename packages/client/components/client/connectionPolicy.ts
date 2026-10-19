/**
 * Connection and session policy for the client lifecycle: when a dismissed
 * error may drop the stored session, when the loading spinner offers a way
 * out, and what kind of thing a Client "error" event carries.
 *
 * Kept import-free (no solid-js, no stoat.js) so the
 * rules can be pinned under `node --test`: the controller and the loading
 * screen call these instead of inlining the checks, so a rule changed here is
 * a rule the spec catches.
 */

/** Socket failures before the first load after which "Sign out" is offered. */
export const SIGN_OUT_OFFER_AFTER_FAILURES = 3;

/** Time on the first-load spinner after which "Sign out" is offered. */
export const SIGN_OUT_OFFER_AFTER_MS = 20_000;

/**
 * Whether dismissing the error screen should check if the session is revoked.
 *
 * Only `InvalidSession` qualifies, matched exactly. It is not proof on its
 * own: the server also answers `InvalidSession` when its database lookup
 * fails, so the caller must confirm with a REST probe (see
 * `probeConfirmsRevoked`) before removing the stored session. Every other
 * permanent error keeps the session.
 */
export function dismissMayDropSession(
  permanentError: string | undefined,
): boolean {
  return permanentError === "InvalidSession";
}

/**
 * Whether the REST probe's HTTP status proves the session is gone.
 *
 * Only a 401 from the session guard does. The probe reads the status, not an
 * error type in the body: the server registers no error catchers, so a
 * failed guard answers with a generic body that carries no `type`. A network
 * failure (no status), a 5xx, or any other status says nothing about the
 * session, so the session is kept.
 */
export function probeConfirmsRevoked(status: number | undefined): boolean {
  return status === 401;
}

/**
 * Whether the spinner shown before the first load offers "Sign out".
 *
 * Covers both ways the first load can stall: a socket that fails fast (the
 * failure count reaches `SIGN_OUT_OFFER_AFTER_FAILURES`) and a connect that
 * hangs without ever failing, such as a `Ready` that never arrives or a
 * device that is offline at launch (`waitedLong`, set after
 * `SIGN_OUT_OFFER_AFTER_MS`). Once the client has loaded, the regular user
 * menu holds "Sign out", so the offer is never shown.
 */
export function offerSignOutWhileLoading(
  loadedOnce: boolean,
  failures: number,
  waitedLong: boolean,
): boolean {
  return (
    !loadedOnce && (failures >= SIGN_OUT_OFFER_AFTER_FAILURES || waitedLong)
  );
}

/**
 * What a Client "error" event is.
 *
 * - "server": an `Error` frame the server sent (an object whose `type` is
 *   "Error"), already recorded as the connection's last error.
 * - "socket": a DOM `Event` from the WebSocket's `onerror`, which is always
 *   followed by a close.
 * - "other": anything else, such as an exception thrown while handling an
 *   event, which must not be swallowed.
 */
export function classifyClientError(
  error: unknown,
): "socket" | "server" | "other" {
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { type?: unknown }).type === "Error"
  ) {
    return "server";
  }

  if (typeof Event !== "undefined" && error instanceof Event) {
    return "socket";
  }

  return "other";
}
