/**
 * Protected channels: the ONE rejection type of a protected send (W4 lane
 * B5, W4b audit M2).
 *
 * `E2EEBridge.handleProtectedSend` wraps every failure in a
 * `ProtectedSendError`, so the Draft outbox and the composer see a single
 * shape. `failure` carries the cause: a `TextFlowFailure` from the manager,
 * the SDK's `ProtectedChannelUnavailable` or `ProtectedFieldRefusedClient`
 * (plan D9b), or a `{ source: "client", reason }` record for a malformed
 * send. UI maps `failure` through `protectedNoticeForError`; `.message` is
 * a fixed identifier, never display copy.
 *
 * Pure: no Solid / SDK / lingui imports, loadable by `node --test`.
 */
export class ProtectedSendError extends Error {
  /** The cause (TextFlowFailure, SDK error instance, or client record). */
  readonly failure: unknown;

  constructor(failure: unknown) {
    super("ProtectedSendError");
    this.name = "ProtectedSendError";
    this.failure = failure;
  }
}

/** Wrap `error` unless it already is a `ProtectedSendError`. */
export function toProtectedSendError(error: unknown): ProtectedSendError {
  return error instanceof ProtectedSendError
    ? error
    : new ProtectedSendError(error);
}

/** True for a protected send rejection (also across realms, by name). */
export function isProtectedSendError(
  error: unknown,
): error is ProtectedSendError {
  return (
    error instanceof ProtectedSendError ||
    (error instanceof Error &&
      error.name === "ProtectedSendError" &&
      "failure" in error)
  );
}
