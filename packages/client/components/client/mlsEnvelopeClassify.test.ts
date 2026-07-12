// Unit spec for the native-rejection → disposition policy — run with Node's
// built-in runner:
//   node --test components/client/mlsEnvelopeClassify.test.ts   (Node >=23.6 strips types)
// Focus (gate MED-5): `mls_leaf_rejected` is an ALLOW-LIST — ONLY
// `binding_unverified` (with both ids) recovers via `needs_identity`;
// `unknown_identity`, every hostile reason, and any FUTURE/missing reason are
// terminal loud drops. The default-closed property is asserted here, not just
// by code comment.
import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyEnvelopeError } from "./mlsEnvelopeClassify.ts";

const leafRejected = (
  reason?: string,
  user_id?: string,
  device_id?: string,
) => ({
  type: "mls_leaf_rejected",
  reason,
  user_id,
  device_id,
});

const terminalLoudDrop = {
  kind: "drop",
  reason: "mls_leaf_rejected",
  loud: true,
  successorNeeded: false,
  ack: true,
};

test("binding_unverified with both ids → needs_identity (recoverable, NOT acked)", () => {
  assert.deepEqual(
    classifyEnvelopeError(leafRejected("binding_unverified", "01USER", "dev1")),
    {
      kind: "needs_identity",
      userId: "01USER",
      deviceId: "dev1",
      ack: false,
    },
  );
});

test("binding_unverified MISSING user_id or device_id → terminal loud drop (nothing to reconcile)", () => {
  assert.deepEqual(
    classifyEnvelopeError(
      leafRejected("binding_unverified", undefined, "dev1"),
    ),
    terminalLoudDrop,
  );
  assert.deepEqual(
    classifyEnvelopeError(
      leafRejected("binding_unverified", "01USER", undefined),
    ),
    terminalLoudDrop,
  );
});

test("unknown_identity → terminal loud drop (a reconcile cannot pin a brand-new device)", () => {
  assert.deepEqual(
    classifyEnvelopeError(leafRejected("unknown_identity", "01USER", "dev1")),
    terminalLoudDrop,
  );
});

test("every hostile leaf reason → terminal loud drop", () => {
  for (const reason of [
    "identity_key_mismatch",
    "identity_changed",
    "signature_key_mismatch",
    "bad_binding_signature",
    "illegal_mutation",
    "unsupported_suite",
    "malformed_credential",
  ]) {
    assert.deepEqual(
      classifyEnvelopeError(leafRejected(reason, "01USER", "dev1")),
      terminalLoudDrop,
      reason,
    );
  }
});

test("FUTURE / unrecognised / missing leaf reason → terminal loud drop (default-closed)", () => {
  assert.deepEqual(
    classifyEnvelopeError(leafRejected("some_future_reason", "01USER", "dev1")),
    terminalLoudDrop,
  );
  assert.deepEqual(
    classifyEnvelopeError(leafRejected(undefined, "01USER", "dev1")),
    terminalLoudDrop,
  );
});

test("leaf rejection is NEVER a quiet drop and NEVER unacked-transient (no wedge, no silent pass)", () => {
  for (const reason of [
    "binding_unverified",
    "unknown_identity",
    "anything_else",
    undefined,
  ]) {
    for (const ids of [
      ["01USER", "dev1"],
      [undefined, undefined],
    ] as const) {
      const disp = classifyEnvelopeError(leafRejected(reason, ids[0], ids[1]));
      // Exhaustive outcome set: recoverable needs_identity or terminal LOUD drop.
      if (disp.kind === "needs_identity") {
        assert.equal(disp.ack, false);
      } else if (disp.kind === "drop") {
        assert.equal(disp.loud, true);
        assert.equal(disp.ack, true);
      } else {
        assert.fail(`unexpected disposition kind: ${disp.kind}`);
      }
    }
  }
});

test("mls_welcome_context_mismatch → its own terminal loud drop arm (T-15, never recoverable)", () => {
  assert.deepEqual(
    classifyEnvelopeError({ type: "mls_welcome_context_mismatch" }),
    {
      kind: "drop",
      reason: "mls_welcome_context_mismatch",
      loud: true,
      successorNeeded: false,
      ack: true,
    },
  );
});

test("mls_epoch_gap → park (never ack/skip, invariant 10)", () => {
  assert.deepEqual(
    classifyEnvelopeError({ type: "mls_epoch_gap", expected: 3, got: 5 }),
    {
      kind: "park",
      expected: 3,
      got: 5,
      ack: false,
    },
  );
});

test("mls_group_not_found → quiet ack+drop; mls_poisoned_epoch → loud successor", () => {
  assert.deepEqual(classifyEnvelopeError({ type: "mls_group_not_found" }), {
    kind: "drop",
    reason: "wiped",
    loud: false,
    successorNeeded: false,
    ack: true,
  });
  assert.deepEqual(classifyEnvelopeError({ type: "mls_poisoned_epoch" }), {
    kind: "drop",
    reason: "poisoned",
    loud: true,
    successorNeeded: true,
    ack: true,
  });
});

test("mls_stale_ctl → QUIET ack+drop (6.5: a ctl-announce is coordination-only, converges via mix detection)", () => {
  assert.deepEqual(
    classifyEnvelopeError({ type: "mls_stale_ctl", group_id: "g" }),
    {
      kind: "drop",
      reason: "mls_stale_ctl",
      loud: false,
      successorNeeded: false,
      ack: true,
    },
  );
});

test("unrecognised error TYPE → transient error, NOT acked (drain bounds the retries)", () => {
  const weird = { type: "some_future_error" };
  assert.deepEqual(classifyEnvelopeError(weird), {
    kind: "error",
    error: weird,
    ack: false,
  });
  const untyped = new Error("ipc broke");
  assert.deepEqual(classifyEnvelopeError(untyped), {
    kind: "error",
    error: untyped,
    ack: false,
  });
});
