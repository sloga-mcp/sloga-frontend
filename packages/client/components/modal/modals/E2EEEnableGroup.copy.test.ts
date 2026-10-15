// Unit spec for the "Encrypt this group" modal's outcome/error mapping, run
// with Node's built-in runner:
//   node --conditions=browser --test components/modal/modals/E2EEEnableGroup.copy.test.ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { GroupGrowthOutcome } from "../../client/e2eeGroupGrowth.ts";

import {
  enableGroupErrorStep,
  enableGroupOutcomeStep,
  memberLabel,
} from "./E2EEEnableGroup.copy.ts";

describe("enableGroupOutcomeStep", () => {
  test("ok closes the modal", () => {
    assert.deepEqual(enableGroupOutcomeStep("ok"), { kind: "close" });
  });

  test("declined stays open, silently", () => {
    assert.deepEqual(enableGroupOutcomeStep("declined"), {
      kind: "stay",
      notice: null,
    });
  });

  test("busy stays open with the busy notice", () => {
    assert.deepEqual(enableGroupOutcomeStep("busy"), {
      kind: "stay",
      notice: "busy",
    });
  });

  test("an outcome outside the union stays open, silently", () => {
    // A bridge that broke the contract proves nothing was enabled; closing
    // would read as success
    for (const outcome of [undefined, null, "", "OK", "cancelled", 0, {}]) {
      assert.deepEqual(
        enableGroupOutcomeStep(outcome as unknown as GroupGrowthOutcome),
        { kind: "stay", notice: null },
        String(outcome),
      );
    }
  });
});

describe("enableGroupErrorStep", () => {
  for (const field of ["roster_changed", "roster_mismatch", "self_user_id"]) {
    test(`invalid_argument/${field} is shown inline`, () => {
      assert.deepEqual(
        enableGroupErrorStep({ type: "invalid_argument", field }),
        { kind: "stay", notice: field },
      );
    });
  }

  test("store owned by another account is shown inline", () => {
    assert.deepEqual(
      enableGroupErrorStep({
        type: "mls_store_owned_by_another_account",
        owner_user_id: "01OWNER",
        requested_user_id: "01ME",
      }),
      { kind: "stay", notice: "mls_store_owned_by_another_account" },
    );
    // The tag alone is enough for this copy
    assert.deepEqual(
      enableGroupErrorStep({ type: "mls_store_owned_by_another_account" }),
      { kind: "stay", notice: "mls_store_owned_by_another_account" },
    );
  });

  test("a thrown declined is silent, a thrown busy is the busy notice", () => {
    assert.deepEqual(enableGroupErrorStep({ type: "declined" }), {
      kind: "stay",
      notice: null,
    });
    assert.deepEqual(enableGroupErrorStep({ type: "busy" }), {
      kind: "stay",
      notice: "busy",
    });
  });

  test("everything else keeps the showError path", () => {
    const others: unknown[] = [
      { type: "needs_bundle", user_id: "01BOB" },
      { type: "invalid_argument", field: "roster" },
      { type: "invalid_argument", field: "conversation_id" },
      { type: "invalid_argument" },
      { type: "invalid_argument", field: ["roster_changed"] },
      { field: "roster_changed" },
      { type: "not_enabled" },
      new Error("network"),
      "roster_changed",
      null,
      undefined,
      42,
    ];
    for (const error of others) {
      assert.deepEqual(
        enableGroupErrorStep(error),
        { kind: "error" },
        `expected showError for ${JSON.stringify(error) ?? String(error)}`,
      );
    }
  });

  test("no thrown error ever closes the modal as a success", () => {
    const thrown: unknown[] = [
      { type: "declined" },
      { type: "busy" },
      { type: "invalid_argument", field: "roster_changed" },
      { type: "invalid_argument", field: "roster_mismatch" },
      { type: "invalid_argument", field: "self_user_id" },
      { type: "mls_store_owned_by_another_account" },
      { type: "needs_bundle" },
      new Error("x"),
    ];
    for (const error of thrown) {
      assert.notEqual(enableGroupErrorStep(error).kind, "close");
    }
  });
});

describe("memberLabel", () => {
  test("username#discriminator when both are known", () => {
    assert.equal(
      memberLabel("01HZZZZZZZZZZZZZZZZZZZZZZZ", {
        username: "alice",
        discriminator: "0420",
      }),
      "alice#0420",
    );
  });

  test("bare username without a discriminator", () => {
    assert.equal(
      memberLabel("01HZZZZZZZZZZZZZZZZZZZZZZZ", { username: "alice" }),
      "alice",
    );
  });

  test("short id when the user or username is unknown", () => {
    assert.equal(memberLabel("01HABCDEFGHJKMNPQRSTVWXYZ0"), "01HABCDE");
    assert.equal(memberLabel("01HABCDEFGHJKMNPQRSTVWXYZ0", null), "01HABCDE");
    assert.equal(
      memberLabel("01HABCDEFGHJKMNPQRSTVWXYZ0", {
        username: "",
        discriminator: "0420",
      }),
      "01HABCDE",
    );
  });
});
