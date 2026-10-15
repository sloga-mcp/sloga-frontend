// Unit spec for the verify / identity-change modals' outcome and error
// mapping, run with Node's built-in runner:
//   node --conditions=browser --test components/modal/modals/e2eeIdentityConfirm.copy.test.ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { IdentityConfirmOutcome } from "../../client/e2ee.ts";

import {
  type IdentityConfirmStep,
  identityConfirmErrorStep,
  identityConfirmOutcomeStep,
  identityConfirmRefetches,
  offersMarkVerified,
} from "./e2eeIdentityConfirm.copy.ts";

const SILENT: IdentityConfirmStep = {
  kind: "stay",
  refetch: false,
  notice: null,
};
const BUSY: IdentityConfirmStep = {
  kind: "stay",
  refetch: false,
  notice: "busy",
};
const KEYS_CHANGED: IdentityConfirmStep = {
  kind: "stay",
  refetch: true,
  notice: "keys_changed",
};

describe("identityConfirmOutcomeStep", () => {
  test("ok is confirmed", () => {
    assert.deepEqual(identityConfirmOutcomeStep("ok"), { kind: "confirmed" });
  });

  test("declined stays open, silently, without a refetch", () => {
    assert.deepEqual(identityConfirmOutcomeStep("declined"), SILENT);
  });

  test("busy stays open with the busy notice, without a refetch", () => {
    assert.deepEqual(identityConfirmOutcomeStep("busy"), BUSY);
  });

  test("keys_changed refetches and shows the keys-changed notice", () => {
    assert.deepEqual(identityConfirmOutcomeStep("keys_changed"), KEYS_CHANGED);
  });

  test("every outcome in the union has a step, and only ok confirms", () => {
    // Typed as the full union: a fifth outcome added to the type without a
    // row here fails to compile (`satisfies`), and a missing case in the
    // module fails its own `never` check
    const expected = {
      ok: { kind: "confirmed" },
      declined: SILENT,
      busy: BUSY,
      keys_changed: KEYS_CHANGED,
    } satisfies Record<IdentityConfirmOutcome, IdentityConfirmStep>;
    for (const [outcome, step] of Object.entries(expected)) {
      assert.deepEqual(
        identityConfirmOutcomeStep(outcome as IdentityConfirmOutcome),
        step,
        outcome,
      );
      assert.equal(
        identityConfirmOutcomeStep(outcome as IdentityConfirmOutcome).kind ===
          "confirmed",
        outcome === "ok",
        outcome,
      );
    }
  });

  test("an outcome outside the union stays open, silently", () => {
    // A bridge that broke the contract proves nothing was committed;
    // confirming would read as success
    for (const outcome of [
      undefined,
      null,
      "",
      "OK",
      "cancelled",
      "keys-changed",
      0,
      {},
    ]) {
      assert.deepEqual(
        identityConfirmOutcomeStep(
          outcome as unknown as IdentityConfirmOutcome,
        ),
        SILENT,
        String(outcome),
      );
    }
  });
});

describe("identityConfirmErrorStep", () => {
  test("a thrown declined is silent", () => {
    assert.deepEqual(identityConfirmErrorStep({ type: "declined" }), SILENT);
  });

  test("a thrown busy is the busy notice", () => {
    assert.deepEqual(identityConfirmErrorStep({ type: "busy" }), BUSY);
  });

  test("a thrown invalid_argument/keys_changed refetches with the notice", () => {
    assert.deepEqual(
      identityConfirmErrorStep({
        type: "invalid_argument",
        field: "keys_changed",
      }),
      KEYS_CHANGED,
    );
  });

  test("everything else keeps the showError path", () => {
    const others: unknown[] = [
      { type: "invalid_argument", field: "self_user_id" },
      { type: "invalid_argument", field: "device_id" },
      { type: "invalid_argument", field: "ed25519" },
      { type: "invalid_argument" },
      { type: "invalid_argument", field: ["keys_changed"] },
      { field: "keys_changed" },
      { type: "keys_changed" },
      { type: "not_enabled" },
      { type: "unknown_device" },
      new Error("network"),
      "declined",
      "busy",
      null,
      undefined,
      42,
    ];
    for (const error of others) {
      assert.deepEqual(
        identityConfirmErrorStep(error),
        { kind: "error" },
        `expected showError for ${JSON.stringify(error) ?? String(error)}`,
      );
    }
  });

  test("no thrown error is ever confirmed", () => {
    const thrown: unknown[] = [
      { type: "declined" },
      { type: "busy" },
      { type: "invalid_argument", field: "keys_changed" },
      { type: "not_enabled" },
      new Error("x"),
    ];
    for (const error of thrown) {
      assert.notEqual(identityConfirmErrorStep(error).kind, "confirmed");
    }
  });
});

describe("identityConfirmRefetches", () => {
  test("refetches after ok and after keys_changed only", () => {
    const expected = {
      ok: true,
      declined: false,
      busy: false,
      keys_changed: true,
    } satisfies Record<IdentityConfirmOutcome, boolean>;
    for (const [outcome, refetches] of Object.entries(expected)) {
      assert.equal(
        identityConfirmRefetches(
          identityConfirmOutcomeStep(outcome as IdentityConfirmOutcome),
        ),
        refetches,
        outcome,
      );
    }
  });

  test("a showError step does not refetch", () => {
    assert.equal(identityConfirmRefetches({ kind: "error" }), false);
    assert.equal(
      identityConfirmRefetches(identityConfirmErrorStep(new Error("x"))),
      false,
    );
  });

  test("a thrown keys_changed refetches, a thrown decline does not", () => {
    assert.equal(
      identityConfirmRefetches(
        identityConfirmErrorStep({
          type: "invalid_argument",
          field: "keys_changed",
        }),
      ),
      true,
    );
    assert.equal(
      identityConfirmRefetches(identityConfirmErrorStep({ type: "declined" })),
      false,
    );
  });
});

describe("offersMarkVerified", () => {
  test("an Active, signature-proven device is offered", () => {
    assert.equal(
      offersMarkVerified({ status: "active", binding_verified: true }),
      true,
    );
  });

  test("an Active device without a proven binding is not", () => {
    assert.equal(
      offersMarkVerified({ status: "active", binding_verified: false }),
      false,
    );
  });

  test("identity-changed and revoked devices are not, even when proven", () => {
    for (const status of ["identity_changed", "revoked", "", "Active"]) {
      assert.equal(
        offersMarkVerified({ status, binding_verified: true }),
        false,
        status,
      );
    }
  });
});
