/**
 * The Prot store purchase flow (App Store / Google Play), as a pure state
 * machine.
 *
 * Kept free of Solid and Capacitor (the only import is type-only and erased)
 * so the rules can be pinned under `node --test` without a device. The
 * purchase sheet and the recovery worker (`ProtStoreWorker.tsx`) drive it:
 * they perform the side effect a state asks for (create the intent, open the
 * sheet, verify, finish, cancel the intent) and feed the outcome back in as an
 * event.
 *
 * The happy path is `idle -> intent -> sheet -> verifying -> finishing (iOS)
 * | done (Play) -> done`. The rules that matter:
 *
 * - The ONLY finish rule is `shouldFinish`: finish after `credited`,
 *   `already_credited`, `rejected: test` or `rejected: refunded` (no money is
 *   owed either way, and finishing stops the replay at every launch). Never
 *   on an error, any 4xx included. Play is never finished by the client (the
 *   server consumes), so Play goes straight to `done`.
 * - A `pending` SHEET result never verifies; the purchase arrives later
 *   through `transactionUpdated` or the next launch.
 * - A verify answer `status: "pending"` (Play PENDING, or the credit pause) is
 *   kept `"pending"`: unfinished, no finish.
 * - A verify answer `status: "pending", reason: "over_cap"` (the credit would
 *   take the wallet over its cap, so staff review it) is kept
 *   `"under_review"`: unfinished, no finish, exactly like `pending`. The
 *   store re-delivers it at each launch until staff release it and verify
 *   answers `already_credited`, or until it is refunded.
 * - `wrong_account`, `unbound`, `unknown_product` and `no_buyer` are kept
 *   unfinished, so the store re-delivers the purchase.
 * - 5xx, network errors and 429 are retried with backoff
 *   (`verifyBackoffMs`), at most `PROT_STORE_MAX_VERIFY_ATTEMPTS` attempts,
 *   then kept `"retry"`. Any other status (every non-429 4xx, for example
 *   `ProtStoreVerifyFailed`) is kept `"retry"` at once: no more attempts this
 *   launch, never a finish.
 * - A `cancelled` or `failed` sheet result moves to `cancelling`: the caller
 *   calls `POST /payments/prot/store/intent/<id>/cancel` (best effort; a
 *   failure is ignored, the intent expires in 24 h anyway), then sends
 *   `finished` and the flow is back to `idle`. A failed sheet keeps only its
 *   `code` (the UI maps it to localized copy; the native text never reaches
 *   the user).
 * - A `purchased` sheet result whose purchase is malformed (`readPurchase`)
 *   goes back to `idle` WITHOUT cancelling: money may have been taken, and
 *   the worker's drain recovers the purchase.
 *
 * The verify request and its answer are shaped here too (`verifyRequestBody`,
 * `readVerifyAnswer`), so the worker and the purchase sheet share one
 * whitelist.
 */
import type {
  ProtStorePurchaseResult,
  ProtStorePurchased,
} from "./protStorePlugin";

/** The body of a 200 from `POST /payments/prot/store/verify` */
export type ProtStoreVerifyAnswer = {
  status: "credited" | "already_credited" | "pending" | "rejected";
  reason?:
    | "test"
    | "unbound"
    | "refunded"
    | "unknown_product"
    | "wrong_account"
    | "no_buyer"
    | "over_cap";
  purchase_id?: string;
  balance?: number;
  ledger_id?: string;
};

export type ProtStoreFlowState =
  | { step: "idle" }
  | { step: "intent"; productId: string }
  | { step: "sheet"; productId: string; intentId: string }
  | { step: "pending" }
  | { step: "verifying"; purchase: ProtStorePurchased; attempt: number }
  | {
      step: "finishing";
      purchase: ProtStorePurchased;
      answer: ProtStoreVerifyAnswer;
    }
  | { step: "done"; answer: ProtStoreVerifyAnswer }
  | {
      step: "kept";
      purchase: ProtStorePurchased;
      why:
        | "wrong_account"
        | "unbound"
        | "unknown_product"
        | "no_buyer"
        | "pending"
        | "under_review"
        | "retry";
    }
  /** A cancelled or failed sheet: the flow cancels the intent (POST …/store/intent/<id>/cancel, 12.1), best effort */
  | { step: "cancelling"; intentId: string; message?: string }
  | { step: "failed"; message: string };

export type ProtStoreFlowEvent =
  | { type: "start"; productId: string }
  | { type: "intentOk"; intentId: string; token: string }
  | { type: "intentFailed"; message: string }
  | { type: "sheet"; result: ProtStorePurchaseResult }
  | { type: "verified"; answer: ProtStoreVerifyAnswer }
  | { type: "verifyFailed"; status: number | null } // null = network
  | { type: "finished" };

/** Verify attempts per transaction per flow, the first one included */
export const PROT_STORE_MAX_VERIFY_ATTEMPTS = 5;

/** The first retry waits this long; each later one doubles it */
const BACKOFF_BASE_MS = 1_000;

/** No retry waits longer than this */
const BACKOFF_CAP_MS = 60_000;

/** A 429 waits at least this long */
const BACKOFF_RATE_LIMITED_MIN_MS = 10_000;

/**
 * The ONLY finish rule: credited, already_credited, rejected test, rejected
 * refunded. Never on an error.
 *
 * Anything else (pending, the other reject reasons, a rejection without a
 * reason, or a status this client does not know) keeps the transaction
 * unfinished, so the store re-delivers it.
 */
export function shouldFinish(answer: ProtStoreVerifyAnswer): boolean {
  if (answer?.status === "credited" || answer?.status === "already_credited") {
    return true;
  }
  return (
    answer?.status === "rejected" &&
    (answer.reason === "test" || answer.reason === "refunded")
  );
}

/**
 * How long to wait after verify attempt `attempt` (1-based) failed with
 * `status`, before the next attempt.
 *
 * 1 s, 2 s, 4 s … capped at 60 s; a 429 waits at least 10 s. An attempt
 * below 1 (or not a number) counts as the first.
 */
export function verifyBackoffMs(
  attempt: number,
  status: number | null,
): number {
  const n = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  // 2^6 s already passes the cap, so the exponent never needs to grow further
  const wait = Math.min(
    BACKOFF_CAP_MS,
    BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 6),
  );
  return status === 429 ? Math.max(wait, BACKOFF_RATE_LIMITED_MIN_MS) : wait;
}

/**
 * Recovery worker: each unfinished transaction is verified at most once per
 * app launch.
 *
 * `verifiedThisLaunch` holds the `transactionKey` of every transaction the
 * worker (or the purchase sheet) already verified since launch; the caller
 * adds the key when it starts a verify. An empty key is never verified (the
 * server could only refuse it).
 */
export function recoveryShouldVerify(
  transactionId: string,
  verifiedThisLaunch: ReadonlySet<string>,
): boolean {
  return (
    typeof transactionId === "string" &&
    transactionId !== "" &&
    !verifiedThisLaunch.has(transactionId)
  );
}

/**
 * The key a transaction is known by: apple: `transaction_id`; play:
 * `purchase_token`
 */
export function transactionKey(p: ProtStorePurchased): string {
  return p.store === "apple" ? p.transaction_id : p.purchase_token;
}

/**
 * A purchase as the native layer reported it, or null if malformed: an
 * object with a string `product_id`, and for apple string `transaction_id`
 * and `signed_transaction`, for play a string `purchase_token`. Any other
 * `store` is malformed. The object itself is returned (not a copy).
 */
export function readPurchase(x: unknown): ProtStorePurchased | null {
  const p = x as Record<string, unknown> | null | undefined;
  if (typeof p !== "object" || p === null) return null;
  if (typeof p.product_id !== "string") return null;
  if (p.store === "apple") {
    return typeof p.transaction_id === "string" &&
      typeof p.signed_transaction === "string"
      ? (p as ProtStorePurchased)
      : null;
  }
  if (p.store === "play") {
    return typeof p.purchase_token === "string"
      ? (p as ProtStorePurchased)
      : null;
  }
  return null;
}

/**
 * The JSON body of `POST /payments/prot/store/verify` (v0
 * `DataProtStoreVerify`)
 */
export type ProtStoreVerifyBody =
  | { store: "apple"; signed_transaction: string }
  | { store: "play"; product_id: string; purchase_token: string };

/**
 * The verify request for a purchase: apple sends only the signed
 * transaction (the server reads everything else from it); play sends the
 * product id and the purchase token. Nothing else the native layer reported
 * (`order_id`, the apple `transaction_id`/`product_id`) is sent.
 */
export function verifyRequestBody(
  purchase: ProtStorePurchased,
): ProtStoreVerifyBody {
  return purchase.store === "apple"
    ? { store: "apple", signed_transaction: purchase.signed_transaction }
    : {
        store: "play",
        product_id: purchase.product_id,
        purchase_token: purchase.purchase_token,
      };
}

const VERIFY_STATUSES: readonly ProtStoreVerifyAnswer["status"][] = [
  "credited",
  "already_credited",
  "pending",
  "rejected",
];

const VERIFY_REASONS: readonly NonNullable<ProtStoreVerifyAnswer["reason"]>[] =
  [
    "test",
    "unbound",
    "refunded",
    "unknown_product",
    "wrong_account",
    "no_buyer",
    "over_cap",
  ];

/**
 * A 200 verify body as an answer; undefined when it is not one.
 *
 * Only a whitelisted `status` makes an answer; a `reason` outside the
 * whitelist is dropped (so an unknown rejection is kept, never finished).
 * Only `status` and `reason` are carried; every other field is dropped.
 */
export function readVerifyAnswer(
  value: unknown,
): ProtStoreVerifyAnswer | undefined {
  const body = value as { status?: unknown; reason?: unknown } | undefined;
  const status = VERIFY_STATUSES.find((s) => s === body?.status);
  if (!status) return undefined;
  const reason = VERIFY_REASONS.find((r) => r === body?.reason);
  return reason ? { status, reason } : { status };
}

/** 5xx, network (null) and 429 are retried; every other failure is not */
function verifyFailureRetries(status: number | null): boolean {
  return status === null || status === 429 || (status >= 500 && status <= 599);
}

/** A verify answer that does not finish: what the kept transaction waits on */
function keptWhy(
  answer: ProtStoreVerifyAnswer,
): Extract<ProtStoreFlowState, { step: "kept" }>["why"] {
  if (answer?.status === "pending") {
    // Held for staff review (R63), not waiting on the store
    return answer.reason === "over_cap" ? "under_review" : "pending";
  }
  if (answer?.status === "rejected") {
    switch (answer.reason) {
      case "wrong_account":
      case "unbound":
      case "unknown_product":
      case "no_buyer":
        return answer.reason;
    }
  }
  // A rejection without a known reason or a status this client does not know:
  // unfinished, and no more attempts this launch
  return "retry";
}

/**
 * One step of the flow. An event that does not apply to the current state
 * returns the state unchanged (a late or duplicate callback never moves the
 * flow).
 *
 * `start` is accepted only when nothing is in flight (idle, or a settled
 * `pending` / `done` / `kept` / `failed`). The recovery worker enters the
 * flow at `{ step: "verifying", purchase, attempt: 1 }`. After a retried
 * failure the next state is `verifying` with `attempt + 1`; the caller waits
 * `verifyBackoffMs(<the failed attempt>, status)` before verifying again.
 */
export function protStoreStep(
  state: ProtStoreFlowState,
  event: ProtStoreFlowEvent,
): ProtStoreFlowState {
  switch (state.step) {
    case "idle":
    case "pending":
    case "done":
    case "kept":
    case "failed":
      if (event.type === "start") {
        return { step: "intent", productId: event.productId };
      }
      return state;

    case "intent":
      if (event.type === "intentOk") {
        return {
          step: "sheet",
          productId: state.productId,
          intentId: event.intentId,
        };
      }
      if (event.type === "intentFailed") {
        return { step: "failed", message: event.message };
      }
      return state;

    case "sheet": {
      if (event.type !== "sheet") return state;
      const result = event.result;
      // A result this client does not know (below) or none at all: nothing
      // was bought that it can see, so free the intent. An expired intent
      // still binds a purchase that arrives anyway (12.1).
      if (!result) return { step: "cancelling", intentId: state.intentId };
      switch (result.result) {
        case "purchased": {
          const purchase = readPurchase(result.purchase);
          // Malformed: money may have been taken, so the intent is NOT
          // cancelled; the worker's drain recovers the purchase
          if (!purchase) return { step: "idle" };
          return { step: "verifying", purchase, attempt: 1 };
        }
        case "pending":
          // never verifies: the purchase arrives later, completed
          return { step: "pending" };
        case "cancelled":
          return { step: "cancelling", intentId: state.intentId };
        case "failed":
          return {
            step: "cancelling",
            intentId: state.intentId,
            // The code only: the native text goes to the console, never
            // to the user (R31)
            message: result.code,
          };
      }
      return { step: "cancelling", intentId: state.intentId };
    }

    case "verifying":
      if (event.type === "verified") {
        if (shouldFinish(event.answer)) {
          // Play is never finished by the client: the server consumes
          return state.purchase.store === "apple"
            ? {
                step: "finishing",
                purchase: state.purchase,
                answer: event.answer,
              }
            : { step: "done", answer: event.answer };
        }
        return {
          step: "kept",
          purchase: state.purchase,
          why: keptWhy(event.answer),
        };
      }
      if (event.type === "verifyFailed") {
        if (
          verifyFailureRetries(event.status) &&
          state.attempt < PROT_STORE_MAX_VERIFY_ATTEMPTS
        ) {
          return {
            step: "verifying",
            purchase: state.purchase,
            attempt: state.attempt + 1,
          };
        }
        return { step: "kept", purchase: state.purchase, why: "retry" };
      }
      return state;

    case "finishing":
      // `finished` once `finish()` settled; a failed finish leaves the
      // transaction unfinished in the store, and its replay at the next
      // launch answers already_credited and finishes it then
      if (event.type === "finished") {
        return { step: "done", answer: state.answer };
      }
      return state;

    case "cancelling":
      // `finished` once the cancel call settled, success or failure alike
      if (event.type === "finished") return { step: "idle" };
      return state;
  }
  return state;
}
