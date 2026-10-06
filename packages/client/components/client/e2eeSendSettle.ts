/**
 * Post-delivery settle for the E2EE send path (`handleDirectMessageSend` and
 * `handleGroupMessageSend` in `e2ee.ts`) — pure and dependency-free so
 * `node --test` can load it (the house no-vitest split).
 *
 * Why this exists: once `POST /e2ee/messages` has accepted the ciphertext,
 * the peer already has the message. Everything after that point is
 * bookkeeping — native receipt handling (`e2ee_handle_receipts`), the local
 * echo, the send-mode refresh, the history sync, the "Not delivered" marker.
 * Any of those used to be able to throw, and a throw REJECTED a send that
 * had in fact been delivered: the draft was marked failed, and Retry
 * re-encrypted it, so the peer received a SECOND encrypted copy (E2EE does
 * not honor idempotency keys). This module makes every bookkeeping step
 * after the echo best-effort: it is caught and logged by error NAME only
 * (never the error object, ids or message text), and the send resolves with
 * the delivered message.
 *
 * A receipt-handling failure does not lose the device-revocation signal:
 * the server re-reports UnknownDevice on the next send to that device, and
 * the device reconcile also revokes devices missing from the listing. So
 * there is deliberately no client-side retry queue.
 *
 * Never return null or undefined from here: `Channel.ts` treats a null
 * adapter result as "fall through to the PLAINTEXT send". The only way out
 * besides the delivered message is a throw from `inject()` itself (the echo
 * is synchronous and today's behavior), which rejects — never a downgrade.
 */

export interface SettleDeps<M> {
  /** Local echo of the delivered message; a throw rejects the send. */
  inject(): M;
  /** Raw receipts from the POST response. */
  receipts: unknown;
  handleReceipts(receipts: unknown): Promise<void>;
  /** DM: `#refreshMode(peer)`; group: `#refreshGroupMode(conversation)`. */
  refreshMode(): Promise<void> | void;
  syncRecent(): Promise<void>;
  /** DM: the "Not delivered" marker + bundle prefetch; group: no-op. */
  markUndelivered(): void;
  /** Receives the error name/type only — never the error or content. */
  log(step: string, errorName: string): void;
}

/** Longest error name passed to `log`. */
const ERROR_NAME_MAX = 64;

/**
 * True when the fan-out reached ZERO live devices: a non-empty array whose
 * every entry has `status === "UnknownDevice"`. Anything else — an empty
 * array, a non-array, a mix, a QueueFull — is false.
 */
export function allUndelivered(receipts: unknown): boolean {
  if (!Array.isArray(receipts) || receipts.length === 0) return false;
  return receipts.every(
    (r) =>
      (r as { status?: unknown } | null | undefined)?.status ===
      "UnknownDevice",
  );
}

/**
 * A loggable name for a caught error: its `type`, else its `name`, capped
 * at 64 characters. Anything that is not a string — including a thrown
 * string, which may carry content — is "unknown".
 */
export function errorName(e: unknown): string {
  try {
    const shape = e as { type?: unknown; name?: unknown } | null | undefined;
    const name = shape?.type ?? shape?.name ?? "unknown";
    return typeof name === "string" ? name.slice(0, ERROR_NAME_MAX) : "unknown";
  } catch {
    // a throwing getter must not turn a delivered send into a rejection
    return "unknown";
  }
}

/** `d.log` that can never throw out of a catch block. */
function safeLog<M>(d: SettleDeps<M>, step: string, e: unknown): void {
  try {
    d.log(step, errorName(e));
  } catch {
    // logging is best-effort; the send is already delivered
  }
}

/**
 * Settles an E2EE send whose ciphertext the server has ALREADY accepted.
 * Order (today's visible order): echo, receipts, marker, mode refresh,
 * history sync. Resolves with the echo whatever the later steps do.
 */
export async function settleDelivered<M>(d: SettleDeps<M>): Promise<M> {
  const m = d.inject();

  try {
    await d.handleReceipts(d.receipts);
  } catch (e) {
    safeLog(d, "receipts", e);
  }

  // Guaranteed whether or not receipt handling worked, and after it.
  if (allUndelivered(d.receipts)) {
    try {
      d.markUndelivered();
    } catch (e) {
      safeLog(d, "marker", e);
    }
  }

  // Always: after a receipt failure this still fixes a stale indicator.
  try {
    await d.refreshMode();
  } catch (e) {
    safeLog(d, "refresh", e);
  }

  try {
    await d.syncRecent();
  } catch (e) {
    safeLog(d, "sync", e);
  }

  return m;
}
