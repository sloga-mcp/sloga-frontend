/**
 * Run with:
 *
 *     node --conditions=browser --test components/client/protStoreFlow.test.ts
 *
 * The Prot store purchase flow (`./protStoreFlow.ts`), a pure state machine
 * the purchase sheet and `ProtStoreWorker.tsx` drive. Each test names the
 * decision and what goes wrong without it:
 *
 * - a transaction is finished only after credited, already_credited,
 *   rejected test or rejected refunded: finishing on anything else (an
 *   error, a 4xx, a pending answer) loses money the store would have
 *   re-delivered;
 * - 5xx, network errors and 429 retry with backoff and a bounded attempt
 *   count, any other 4xx stops at once, and neither ever finishes;
 * - a pending sheet result never verifies, and a pending verify answer is
 *   kept unfinished;
 * - wrong_account, unbound, unknown_product and no_buyer are kept unfinished;
 * - a cancelled or failed sheet cancels the intent (best effort) and keeps
 *   only the fail code, never the native text;
 * - a purchased sheet with a malformed purchase goes idle WITHOUT cancelling
 *   (money may have been taken; the drain recovers it);
 * - the verify body carries only what the server reads, and a verify answer
 *   is read through a status/reason whitelist;
 * - the recovery worker verifies each transaction at most once per launch,
 *   and replaying a credited transaction finishes it again, harmlessly.
 *
 * `drive` below is a test-side stand-in for the worker: it performs the side
 * effect each state asks for and counts the calls, so "finish was called"
 * and "the cancel route was called" are observable without a device.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  type ProtStoreFlowEvent,
  type ProtStoreFlowState,
  type ProtStoreVerifyAnswer,
  PROT_STORE_MAX_VERIFY_ATTEMPTS,
  protStoreStep,
  readPurchase,
  readVerifyAnswer,
  recoveryShouldVerify,
  shouldFinish,
  transactionKey,
  verifyBackoffMs,
  verifyRequestBody,
} from "./protStoreFlow.ts";
// Type-only (erased at run time), so the spec never loads Capacitor
import type {
  ProtStorePurchaseResult,
  ProtStorePurchased,
} from "./protStorePlugin.ts";

const APPLE: Extract<ProtStorePurchased, { store: "apple" }> = {
  store: "apple",
  transaction_id: "2000000912345678",
  product_id: "gg.sloga.prot.p5",
  signed_transaction: "eyJhbGciOiJFUzI1NiJ9.e30.c2ln",
};

const PLAY: Extract<ProtStorePurchased, { store: "play" }> = {
  store: "play",
  product_id: "gg.sloga.prot.p10",
  purchase_token: "opaque-play-purchase-token",
  order_id: "GPA.3300-0000-0000-00000",
};

/** Every shape `readPurchase` must refuse */
const MALFORMED_PURCHASES: unknown[] = [
  undefined,
  null,
  "2000000912345678",
  42,
  [],
  {},
  { ...APPLE, store: "amazon" },
  { ...APPLE, store: undefined },
  { ...APPLE, product_id: undefined },
  { ...APPLE, product_id: 5 },
  { ...APPLE, transaction_id: undefined },
  { ...APPLE, transaction_id: 2000000912345678 },
  { ...APPLE, signed_transaction: undefined },
  { ...APPLE, signed_transaction: null },
  { ...PLAY, purchase_token: undefined },
  { ...PLAY, purchase_token: ["t"] },
  { ...PLAY, product_id: null },
  // a play purchase labelled apple lacks the apple proof
  { ...PLAY, store: "apple" },
];

const STATUSES = [
  "credited",
  "already_credited",
  "pending",
  "rejected",
] as const;

const REASONS = [
  undefined,
  "test",
  "unbound",
  "refunded",
  "unknown_product",
  "wrong_account",
  "no_buyer",
] as const;

/** Every 4xx but 429 the verify route could answer */
const CLIENT_ERRORS = [400, 401, 403, 404, 405, 409, 410, 413, 422, 451, 499];

/** 5xx and network (null) */
const SERVER_ERRORS: (number | null)[] = [500, 502, 503, 504, 599, null];

function verifying(
  purchase: ProtStorePurchased,
  attempt = 1,
): ProtStoreFlowState {
  return { step: "verifying", purchase, attempt };
}

function steps(
  state: ProtStoreFlowState,
  events: ProtStoreFlowEvent[],
): ProtStoreFlowState[] {
  const out: ProtStoreFlowState[] = [];
  for (const event of events) {
    state = protStoreStep(state, event);
    out.push(state);
  }
  return out;
}

function assertNeverFinishes(states: ProtStoreFlowState[]) {
  for (const s of states) {
    assert.notEqual(s.step, "finishing", JSON.stringify(s));
    assert.notEqual(s.step, "done", JSON.stringify(s));
  }
}

type Io = {
  intent?: () => ProtStoreFlowEvent;
  sheet?: () => ProtStorePurchaseResult;
  verify?: (
    purchase: ProtStorePurchased,
    attempt: number,
  ) => ProtStoreFlowEvent;
  cancelFails?: boolean;
};

type Calls = {
  intents: number;
  sheets: number;
  verifies: { key: string; attempt: number }[];
  waits: number[];
  finishes: string[];
  cancels: string[];
  final: ProtStoreFlowState;
};

/**
 * The worker's loop: perform the effect the state asks for, feed back the
 * outcome, stop at a state that asks for nothing.
 */
function drive(start: ProtStoreFlowState, io: Io): Calls {
  const calls: Calls = {
    intents: 0,
    sheets: 0,
    verifies: [],
    waits: [],
    finishes: [],
    cancels: [],
    final: start,
  };
  let state = start;
  for (let i = 0; i < 100; i++) {
    let event: ProtStoreFlowEvent | undefined;
    switch (state.step) {
      case "intent":
        calls.intents++;
        event = io.intent!();
        break;
      case "sheet":
        calls.sheets++;
        event = { type: "sheet", result: io.sheet!() };
        break;
      case "verifying":
        calls.verifies.push({
          key: transactionKey(state.purchase),
          attempt: state.attempt,
        });
        event = io.verify!(state.purchase, state.attempt);
        if (event.type === "verifyFailed") {
          calls.waits.push(verifyBackoffMs(state.attempt, event.status));
        }
        break;
      case "finishing":
        calls.finishes.push(transactionKey(state.purchase));
        event = { type: "finished" };
        break;
      case "cancelling":
        calls.cancels.push(state.intentId);
        try {
          if (io.cancelFails) throw new Error("cancel route 503");
        } catch {
          // best effort: the intent expires in 24 h anyway
        }
        event = { type: "finished" };
        break;
    }
    if (!event) break;
    const next = protStoreStep(state, event);
    if (next.step === "verifying" && state.step === "verifying") {
      // a retry must be the next attempt, never a reset
      assert.equal(next.attempt, state.attempt + 1);
    }
    state = next;
  }
  calls.final = state;
  return calls;
}

function answer(
  status: ProtStoreVerifyAnswer["status"],
  reason?: ProtStoreVerifyAnswer["reason"],
): ProtStoreVerifyAnswer {
  return reason === undefined ? { status } : { status, reason };
}

const ok = (a: ProtStoreVerifyAnswer) => () =>
  ({ type: "verified", answer: a }) as ProtStoreFlowEvent;

const fail = (status: number | null) => () =>
  ({ type: "verifyFailed", status }) as ProtStoreFlowEvent;

describe("the finish rule", () => {
  test("finish_only_after_credited_already_credited_test_refunded", () => {
    const finishing: string[] = [];
    for (const status of STATUSES) {
      for (const reason of REASONS) {
        const a = answer(status, reason);
        if (shouldFinish(a)) finishing.push(`${status}/${reason}`);
      }
    }
    assert.deepEqual(finishing, [
      "credited/undefined",
      "credited/test",
      "credited/unbound",
      "credited/refunded",
      "credited/unknown_product",
      "credited/wrong_account",
      "credited/no_buyer",
      "already_credited/undefined",
      "already_credited/test",
      "already_credited/unbound",
      "already_credited/refunded",
      "already_credited/unknown_product",
      "already_credited/wrong_account",
      "already_credited/no_buyer",
      "rejected/test",
      "rejected/refunded",
    ]);

    // A status this client does not know never finishes
    assert.equal(
      shouldFinish({ status: "refunded" } as unknown as ProtStoreVerifyAnswer),
      false,
    );
    assert.equal(
      shouldFinish(undefined as unknown as ProtStoreVerifyAnswer),
      false,
    );
  });

  test("apple finishes once after a finishing answer, then is done", () => {
    for (const a of [
      answer("credited"),
      answer("already_credited"),
      answer("rejected", "test"),
      answer("rejected", "refunded"),
    ]) {
      const calls = drive(verifying(APPLE), { verify: ok(a) });
      assert.deepEqual(calls.finishes, [APPLE.transaction_id]);
      assert.deepEqual(calls.final, { step: "done", answer: a });
    }
  });

  test("play is never finished by the client (the server consumes)", () => {
    for (const a of [answer("credited"), answer("rejected", "refunded")]) {
      const s = protStoreStep(verifying(PLAY), { type: "verified", answer: a });
      assert.deepEqual(s, { step: "done", answer: a });
      assert.deepEqual(drive(verifying(PLAY), { verify: ok(a) }).finishes, []);
    }
  });

  test("a badly settled finish still ends done (replay finishes it)", () => {
    const s: ProtStoreFlowState = {
      step: "finishing",
      purchase: APPLE,
      answer: answer("credited"),
    };
    assert.deepEqual(protStoreStep(s, { type: "finished" }), {
      step: "done",
      answer: answer("credited"),
    });
    // nothing but `finished` moves it
    for (const e of [
      { type: "verifyFailed", status: 500 },
      { type: "verified", answer: answer("rejected", "unbound") },
      { type: "start", productId: "gg.sloga.prot.p5" },
    ] as ProtStoreFlowEvent[]) {
      assert.equal(protStoreStep(s, e), s);
    }
  });
});

describe("verify failures", () => {
  test("no_finish_on_server_error", () => {
    for (const status of SERVER_ERRORS) {
      for (const p of [APPLE, PLAY]) {
        // one failure: the next attempt, not a finish
        assert.deepEqual(
          protStoreStep(verifying(p), { type: "verifyFailed", status }),
          verifying(p, 2),
        );
        // every attempt fails: exactly the cap, then kept "retry"
        const calls = drive(verifying(p), { verify: fail(status) });
        assert.equal(calls.verifies.length, PROT_STORE_MAX_VERIFY_ATTEMPTS);
        assert.deepEqual(
          calls.verifies.map((v) => v.attempt),
          [1, 2, 3, 4, 5],
        );
        assert.deepEqual(calls.finishes, []);
        assert.deepEqual(calls.final, {
          step: "kept",
          purchase: p,
          why: "retry",
        });
        assertNeverFinishes(
          steps(
            verifying(p),
            Array.from({ length: 8 }, () => ({
              type: "verifyFailed" as const,
              status,
            })),
          ),
        );
      }
    }
    // the last allowed attempt failing is kept, not retried
    assert.deepEqual(
      protStoreStep(verifying(APPLE, PROT_STORE_MAX_VERIFY_ATTEMPTS), {
        type: "verifyFailed",
        status: 503,
      }),
      { step: "kept", purchase: APPLE, why: "retry" },
    );
  });

  test("a server error then a credit finishes once", () => {
    let n = 0;
    const calls = drive(verifying(APPLE), {
      verify: () =>
        ++n < 3
          ? { type: "verifyFailed", status: n === 1 ? null : 502 }
          : { type: "verified", answer: answer("credited") },
    });
    assert.equal(calls.verifies.length, 3);
    assert.deepEqual(calls.waits, [1_000, 2_000]);
    assert.deepEqual(calls.finishes, [APPLE.transaction_id]);
    assert.equal(calls.final.step, "done");
  });

  test("no_finish_on_client_error", () => {
    for (const status of CLIENT_ERRORS) {
      for (const p of [APPLE, PLAY]) {
        for (const attempt of [1, 3]) {
          assert.deepEqual(
            protStoreStep(verifying(p, attempt), {
              type: "verifyFailed",
              status,
            }),
            { step: "kept", purchase: p, why: "retry" },
            `status ${status}, attempt ${attempt}`,
          );
        }
        // no further attempt this launch
        const calls = drive(verifying(p), { verify: fail(status) });
        assert.equal(calls.verifies.length, 1, `status ${status}`);
        assert.deepEqual(calls.finishes, []);
      }
    }
    // a status that is neither a retry nor a 4xx is not retried either
    for (const status of [0, 200, 204, 302, 600, Number.NaN]) {
      assert.deepEqual(
        protStoreStep(verifying(APPLE), { type: "verifyFailed", status }),
        { step: "kept", purchase: APPLE, why: "retry" },
        `status ${status}`,
      );
    }
  });

  test("a 429 backs off and retries, then is kept", () => {
    assert.deepEqual(
      protStoreStep(verifying(PLAY), { type: "verifyFailed", status: 429 }),
      verifying(PLAY, 2),
    );
    const calls = drive(verifying(APPLE), { verify: fail(429) });
    assert.equal(calls.verifies.length, PROT_STORE_MAX_VERIFY_ATTEMPTS);
    for (const w of calls.waits) assert.ok(w >= 10_000, `waited ${w}`);
    assert.deepEqual(calls.waits, [10_000, 10_000, 10_000, 10_000, 16_000]);
    assert.deepEqual(calls.finishes, []);
    assert.deepEqual(calls.final, {
      step: "kept",
      purchase: APPLE,
      why: "retry",
    });
  });

  test("verify_backoff_table", () => {
    const table = [1, 2, 3, 4, 5, 6, 7, 8, 20, 1000].map((a) =>
      verifyBackoffMs(a, 503),
    );
    assert.deepEqual(
      table,
      [
        1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000,
        60_000,
      ],
    );
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 7, 8].map((a) => verifyBackoffMs(a, null)),
      [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000],
    );
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 7, 8].map((a) => verifyBackoffMs(a, 429)),
      [10_000, 10_000, 10_000, 10_000, 16_000, 32_000, 60_000, 60_000],
    );
    // a nonsense attempt counts as the first, never 0 ms or a huge wait
    for (const a of [0, -3, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(verifyBackoffMs(a, 500), 1_000, `attempt ${a}`);
      assert.equal(verifyBackoffMs(a, 429), 10_000, `attempt ${a}`);
    }
    assert.equal(PROT_STORE_MAX_VERIFY_ATTEMPTS, 5);
  });
});

describe("pending", () => {
  test("pending_never_verifies", () => {
    const sheet: ProtStoreFlowState = {
      step: "sheet",
      productId: "gg.sloga.prot.p5",
      intentId: "01JBZ7Y2Q8M3K4N5P6R7S8T9VW",
    };
    // a pending SHEET result waits; it does not verify
    const pending = protStoreStep(sheet, {
      type: "sheet",
      result: { result: "pending" },
    });
    assert.deepEqual(pending, { step: "pending" });

    // the worker has nothing to do in it: no verify, finish or cancel
    const calls = drive(pending, {});
    assert.deepEqual(calls.verifies, []);
    assert.deepEqual(calls.finishes, []);
    assert.deepEqual(calls.cancels, []);
    assert.deepEqual(calls.final, { step: "pending" });

    // a stray verify outcome never moves a pending flow
    for (const e of [
      { type: "verified", answer: answer("credited") },
      { type: "verifyFailed", status: 503 },
      { type: "finished" },
      { type: "sheet", result: { result: "cancelled" } },
    ] as ProtStoreFlowEvent[]) {
      assert.equal(protStoreStep(pending, e), pending);
    }

    // a pending verify ANSWER is kept unfinished and not verified again
    for (const p of [APPLE, PLAY]) {
      for (const reason of REASONS) {
        const a = answer("pending", reason);
        assert.equal(shouldFinish(a), false);
        assert.deepEqual(
          protStoreStep(verifying(p), { type: "verified", answer: a }),
          { step: "kept", purchase: p, why: "pending" },
        );
      }
      const c = drive(verifying(p), { verify: ok(answer("pending")) });
      assert.equal(c.verifies.length, 1);
      assert.deepEqual(c.finishes, []);
    }
  });
});

describe("kept unfinished", () => {
  test("wrong_account keeps the purchase unfinished (sign-in note)", () => {
    for (const p of [APPLE, PLAY]) {
      const calls = drive(verifying(p), {
        verify: ok(answer("rejected", "wrong_account")),
      });
      assert.deepEqual(calls.final, {
        step: "kept",
        purchase: p,
        why: "wrong_account",
      });
      assert.deepEqual(calls.finishes, []);
      assert.equal(calls.verifies.length, 1);
    }
  });

  test("unbound keeps the purchase unfinished (contact support)", () => {
    for (const reason of ["unbound", "unknown_product", "no_buyer"] as const) {
      for (const p of [APPLE, PLAY]) {
        const calls = drive(verifying(p), {
          verify: ok(answer("rejected", reason)),
        });
        assert.deepEqual(calls.final, {
          step: "kept",
          purchase: p,
          why: reason,
        });
        assert.deepEqual(calls.finishes, []);
      }
    }
  });

  test("a rejection the client cannot read is kept, never finished", () => {
    for (const a of [
      answer("rejected"),
      {
        status: "rejected",
        reason: "fraud",
      } as unknown as ProtStoreVerifyAnswer,
      { status: "refunded" } as unknown as ProtStoreVerifyAnswer,
    ]) {
      assert.deepEqual(
        protStoreStep(verifying(APPLE), { type: "verified", answer: a }),
        { step: "kept", purchase: APPLE, why: "retry" },
      );
    }
  });
});

describe("the intent and the sheet", () => {
  const INTENT = "01JBZ7Y2Q8M3K4N5P6R7S8T9VW";

  test("start creates an intent, which opens the sheet", () => {
    const [intent, sheet] = steps({ step: "idle" }, [
      { type: "start", productId: "gg.sloga.prot.p25" },
      { type: "intentOk", intentId: INTENT, token: "uuid-token" },
    ]);
    assert.deepEqual(intent, {
      step: "intent",
      productId: "gg.sloga.prot.p25",
    });
    assert.deepEqual(sheet, {
      step: "sheet",
      productId: "gg.sloga.prot.p25",
      intentId: INTENT,
    });
    assert.deepEqual(
      protStoreStep(intent, {
        type: "intentFailed",
        message: "PaymentPending",
      }),
      { step: "failed", message: "PaymentPending" },
    );
  });

  test("the full apple purchase verifies once and finishes once", () => {
    const calls = drive(
      { step: "intent", productId: APPLE.product_id },
      {
        intent: () => ({ type: "intentOk", intentId: INTENT, token: "t" }),
        sheet: () => ({ result: "purchased", purchase: APPLE }),
        verify: ok(answer("credited")),
      },
    );
    assert.equal(calls.intents, 1);
    assert.equal(calls.sheets, 1);
    assert.deepEqual(calls.verifies, [
      { key: APPLE.transaction_id, attempt: 1 },
    ]);
    assert.deepEqual(calls.finishes, [APPLE.transaction_id]);
    assert.deepEqual(calls.cancels, []);
    assert.equal(calls.final.step, "done");
  });

  test("start is ignored while a purchase is in flight", () => {
    const start: ProtStoreFlowEvent = {
      type: "start",
      productId: "gg.sloga.prot.p100",
    };
    for (const s of [
      { step: "intent", productId: "gg.sloga.prot.p5" },
      { step: "sheet", productId: "gg.sloga.prot.p5", intentId: INTENT },
      verifying(APPLE),
      { step: "finishing", purchase: APPLE, answer: answer("credited") },
      { step: "cancelling", intentId: INTENT },
    ] as ProtStoreFlowState[]) {
      assert.equal(protStoreStep(s, start), s);
    }
  });

  test("cancelled_sheet_cancels_the_intent", () => {
    const sheet: ProtStoreFlowState = {
      step: "sheet",
      productId: "gg.sloga.prot.p5",
      intentId: INTENT,
    };
    assert.deepEqual(
      protStoreStep(sheet, { type: "sheet", result: { result: "cancelled" } }),
      { step: "cancelling", intentId: INTENT },
    );
    for (const cancelFails of [false, true]) {
      const calls = drive(
        { step: "intent", productId: "gg.sloga.prot.p5" },
        {
          intent: () => ({ type: "intentOk", intentId: INTENT, token: "t" }),
          sheet: () => ({ result: "cancelled" }),
          cancelFails,
        },
      );
      // the cancel route is called once with the intent, and a failed cancel
      // still lands in idle (best effort)
      assert.deepEqual(calls.cancels, [INTENT]);
      assert.deepEqual(calls.verifies, []);
      assert.deepEqual(calls.finishes, []);
      assert.deepEqual(calls.final, { step: "idle" });
    }
  });

  test("a failed sheet cancels the intent and carries the reason", () => {
    const sheet: ProtStoreFlowState = {
      step: "sheet",
      productId: "gg.sloga.prot.p5",
      intentId: INTENT,
    };
    for (const code of [
      "not_available",
      "product_not_found",
      "already_owned",
      "invalid_token",
      "store_error",
    ] as const) {
      assert.deepEqual(
        protStoreStep(sheet, {
          type: "sheet",
          result: { result: "failed", code },
        }),
        { step: "cancelling", intentId: INTENT, message: code },
      );
      // R31: the native text never reaches the state, only the code
      assert.deepEqual(
        protStoreStep(sheet, {
          type: "sheet",
          result: { result: "failed", code, message: "Store said <b>no</b>" },
        }),
        { step: "cancelling", intentId: INTENT, message: code },
      );
      const calls = drive(sheet, {
        sheet: () => ({ result: "failed", code, message: "Store said no" }),
      });
      // `drive` starts AT the sheet state, so the sheet runs once
      assert.equal(calls.sheets, 1);
      assert.deepEqual(calls.cancels, [INTENT]);
      assert.deepEqual(calls.verifies, []);
      assert.deepEqual(calls.final, { step: "idle" });
    }
    // a result this client cannot read (or none) frees the intent too, and
    // never verifies
    for (const result of [
      { result: "deferred" },
      undefined,
    ] as unknown as ProtStorePurchaseResult[]) {
      assert.deepEqual(protStoreStep(sheet, { type: "sheet", result }), {
        step: "cancelling",
        intentId: INTENT,
      });
    }
  });

  test("malformed_purchase_goes_idle_without_cancelling", () => {
    const sheet: ProtStoreFlowState = {
      step: "sheet",
      productId: "gg.sloga.prot.p5",
      intentId: INTENT,
    };
    for (const purchase of MALFORMED_PURCHASES) {
      const label = JSON.stringify(purchase) ?? String(purchase);
      assert.deepEqual(
        protStoreStep(sheet, {
          type: "sheet",
          result: {
            result: "purchased",
            purchase,
          } as unknown as ProtStorePurchaseResult,
        }),
        { step: "idle" },
        label,
      );
      // money may have been taken: no cancel, no verify, no finish (the
      // worker's drain recovers it from the store)
      const calls = drive(sheet, {
        sheet: () =>
          ({
            result: "purchased",
            purchase,
          }) as unknown as ProtStorePurchaseResult,
      });
      assert.deepEqual(calls.cancels, [], label);
      assert.deepEqual(calls.verifies, [], label);
      assert.deepEqual(calls.finishes, [], label);
      assert.deepEqual(calls.final, { step: "idle" }, label);
    }
    // a well-formed purchase still verifies, as the object it was
    for (const p of [APPLE, PLAY]) {
      const s = protStoreStep(sheet, {
        type: "sheet",
        result: { result: "purchased", purchase: p },
      });
      assert.deepEqual(s, verifying(p));
    }
  });
});

describe("the verify request and its answer", () => {
  test("read_purchase_accepts_only_well_formed_purchases", () => {
    assert.equal(readPurchase(APPLE), APPLE);
    assert.equal(readPurchase(PLAY), PLAY);
    // `order_id` is optional
    const playNoOrder = {
      store: "play",
      product_id: PLAY.product_id,
      purchase_token: PLAY.purchase_token,
    };
    assert.equal(readPurchase(playNoOrder), playNoOrder);
    for (const x of MALFORMED_PURCHASES) {
      assert.equal(readPurchase(x), null, JSON.stringify(x) ?? String(x));
    }
  });

  test("verify_request_body_carries_only_what_the_server_reads", () => {
    assert.deepEqual(verifyRequestBody(APPLE), {
      store: "apple",
      signed_transaction: APPLE.signed_transaction,
    });
    assert.deepEqual(verifyRequestBody(PLAY), {
      store: "play",
      product_id: PLAY.product_id,
      purchase_token: "opaque-play-purchase-token",
    });
    // the wire shapes of v0 `DataProtStoreVerify` (§3), key order included
    assert.equal(
      JSON.stringify(
        verifyRequestBody({ ...APPLE, signed_transaction: "a.b.c" }),
      ),
      '{"store":"apple","signed_transaction":"a.b.c"}',
    );
    assert.equal(
      JSON.stringify(
        verifyRequestBody({
          store: "play",
          product_id: "gg.sloga.prot.p5",
          purchase_token: "t",
          order_id: "GPA.1",
        }),
      ),
      '{"store":"play","product_id":"gg.sloga.prot.p5","purchase_token":"t"}',
    );
  });

  test("read_verify_answer_whitelist", () => {
    for (const status of STATUSES) {
      assert.deepEqual(readVerifyAnswer({ status }), { status });
      for (const reason of REASONS) {
        if (reason === undefined) continue;
        assert.deepEqual(readVerifyAnswer({ status, reason }), {
          status,
          reason,
        });
      }
      // an unknown reason is dropped, never passed through
      assert.deepEqual(readVerifyAnswer({ status, reason: "fraud" }), {
        status,
      });
      assert.deepEqual(readVerifyAnswer({ status, reason: 3 }), { status });
    }
    // only status and reason are carried
    assert.deepEqual(
      readVerifyAnswer({
        status: "credited",
        purchase_id: "apple:prod:2000000912345678",
        balance: 500,
        ledger_id: "01JBZ7Y2Q8M3K4N5P6R7S8T9VW",
        finish: true,
      }),
      { status: "credited" },
    );
    // not an answer at all
    for (const body of [
      undefined,
      null,
      "credited",
      42,
      [],
      ["credited"],
      {},
      { status: "Credited" },
      { status: "refunded" },
      { status: "finished" },
      { status: "" },
      { status: null, reason: "test" },
      { reason: "refunded" },
    ]) {
      assert.equal(
        readVerifyAnswer(body),
        undefined,
        JSON.stringify(body) ?? String(body),
      );
    }
    // an unknown rejection read through the whitelist is kept, not finished
    const unknownRejection = readVerifyAnswer({
      status: "rejected",
      reason: "fraud",
    })!;
    assert.deepEqual(
      protStoreStep(verifying(APPLE), {
        type: "verified",
        answer: unknownRejection,
      }),
      { step: "kept", purchase: APPLE, why: "retry" },
    );
  });
});

describe("recovery", () => {
  test("transaction keys", () => {
    assert.equal(transactionKey(APPLE), "2000000912345678");
    assert.equal(transactionKey(PLAY), "opaque-play-purchase-token");
  });

  test("recovery_replay_is_idempotent", () => {
    // One launch: pendingTransactions() returns both, and transactionUpdated
    // delivers the apple one again while it is being verified
    function launch(
      answerFor: (p: ProtStorePurchased) => ProtStoreVerifyAnswer,
    ) {
      const verifiedThisLaunch = new Set<string>();
      const deliveries = [APPLE, PLAY, APPLE, PLAY, APPLE];
      const finishes: string[] = [];
      const verifies: string[] = [];
      for (const p of deliveries) {
        const key = transactionKey(p);
        if (!recoveryShouldVerify(key, verifiedThisLaunch)) continue;
        verifiedThisLaunch.add(key);
        const calls = drive(verifying(p), { verify: ok(answerFor(p)) });
        verifies.push(...calls.verifies.map((v) => v.key));
        finishes.push(...calls.finishes);
      }
      return { verifies, finishes };
    }

    const first = launch(() => answer("credited"));
    assert.deepEqual(first.verifies, [
      APPLE.transaction_id,
      PLAY.purchase_token,
    ]);
    assert.deepEqual(first.finishes, [APPLE.transaction_id]);

    // The finish did not stick (app killed): the next launch replays it, the
    // server answers already_credited, and it is finished again
    const second = launch(() => answer("already_credited"));
    assert.deepEqual(second.verifies, [
      APPLE.transaction_id,
      PLAY.purchase_token,
    ]);
    assert.deepEqual(second.finishes, [APPLE.transaction_id]);

    // A kept transaction is not re-verified in the same launch either
    const kept = launch(() => answer("rejected", "wrong_account"));
    assert.deepEqual(kept.verifies, [
      APPLE.transaction_id,
      PLAY.purchase_token,
    ]);
    assert.deepEqual(kept.finishes, []);

    assert.equal(recoveryShouldVerify("a", new Set()), true);
    assert.equal(recoveryShouldVerify("a", new Set(["a"])), false);
    assert.equal(recoveryShouldVerify("b", new Set(["a"])), true);
    assert.equal(recoveryShouldVerify("", new Set()), false);

    // R29: the session lives with the caller, not in the flow; a claim the
    // caller releases (sign-out, account switch) verifies again this launch
    const claims = new Set([transactionKey(APPLE)]);
    assert.equal(recoveryShouldVerify(transactionKey(APPLE), claims), false);
    claims.delete(transactionKey(APPLE));
    assert.equal(recoveryShouldVerify(transactionKey(APPLE), claims), true);
  });
});
