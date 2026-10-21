import { apiErrorType } from "./apiErrorType.ts";

/**
 * Transition table for the lifecycle's `LoggingIn` state, the stretch between
 * a fresh login (`LoginUncached`) and the first socket `Ready`.
 *
 * Kept free of solid-js and stoat.js (it imports only `apiErrorType`) so the
 * table can be pinned under `node --test`: the controller maps its
 * `TransitionType` onto a `LoggingInEvent` and enters whatever state this
 * returns, so a row changed here is a row the spec catches.
 */

/**
 * The transitions `LoggingIn` reacts to, reduced to what this module can see
 * without importing the controller. Everything else is "other".
 */
export type LoggingInEvent =
  | "socket-connected"
  | "no-user"
  | "permanent-failure"
  | "temporary-failure"
  | "other";

/** The lifecycle state `LoggingIn` moves to, named by its `State` member. */
export type LoggingInTarget =
  | "connected"
  | "onboarding"
  | "error"
  | "disconnected";

/**
 * Where `LoggingIn` goes on an event.
 *
 * - The socket's first `Ready` connects.
 * - `/onboard/hello` saying the account has no user yet goes to onboarding.
 * - A permanent failure (the server sent an `Error` frame, e.g.
 *   `InvalidSession`, or the hello request itself failed) goes to the error
 *   screen, which the login flows render with its message.
 * - A temporary failure (socket error, close, or connect timeout) goes to
 *   `Disconnected`, NOT the error screen. The server issued this session and
 *   `/onboard/hello` already passed behind the session guard, so a socket
 *   failure here is retried with backoff exactly like the cached-login path
 *   does from `Connecting`. It used to dead-end in `State.Error`, which the
 *   login page did not render, so a successful login bounced the user back to
 *   a bare form with no message, and every retry from it was ignored.
 *
 * @returns the target state, or undefined when `LoggingIn` has no arm for the
 * event (the controller must then stay put and log it as unhandled)
 */
export function loggingInTarget(
  event: LoggingInEvent,
): LoggingInTarget | undefined {
  switch (event) {
    case "socket-connected":
      return "connected";
    case "no-user":
      return "onboarding";
    case "permanent-failure":
      return "error";
    case "temporary-failure":
      return "disconnected";
    case "other":
      return undefined;
  }
}

/**
 * The permanent error to record when the `/onboard/hello` step fails.
 *
 * The API error type when the failure is an API error body (a 401 reads as
 * `InvalidSession`, which the error screen shows as "You were logged out!"
 * and which fires the sign-out hooks). Anything else (a network failure such
 * as `TypeError: Failed to fetch`, HTML from a proxy, a throw from
 * `client.connect()`) is "ConnectionFailed", so the error screen shows its
 * generic message instead of the login spinner hanging forever.
 */
export function helloFailureError(err: unknown): string {
  return apiErrorType(err) ?? "ConnectionFailed";
}
