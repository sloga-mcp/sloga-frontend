// Unit spec for the leaf-rejection classifier — run with Node's built-in
// runner:
//   node --test --conditions=browser components/rtc/mlsLeafRejectionPolicy.test.ts
// Focus: `removable` is reachable ONLY through an exact, well-formed
// `identity_changed` rejection naming another user's device; `repin` only
// through `unknown_identity` / `binding_unverified` under the same rules; and
// everything else, including every other native reason, a reason this build
// does not know, our own user's leaves and anything that is not the plain
// native object, is `other`. The default-closed property is asserted here, not
// just by code comment.
import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyLeafRejection } from "./mlsLeafRejectionPolicy.ts";

const SELF = {
  userId: "01HSELF0000000000000000000",
  deviceId: "0123456789abcdef0123456789abcdef",
};
const PEER_USER = "01HPEER0000000000000000000";
const PEER_DEVICE = "fedcba9876543210fedcba9876543210";

const rejected = (
  reason: unknown,
  user_id: unknown = PEER_USER,
  device_id: unknown = PEER_DEVICE,
) => ({ type: "mls_leaf_rejected", user_id, device_id, reason });

// e2ee-core `LeafRejection` (error.rs), serde snake_case, in declaration
// order. Every value must be classified, and exactly one is `removable`.
const ALL_REASONS = [
  "malformed_credential",
  "signature_key_mismatch",
  "unknown_identity",
  "binding_unverified",
  "identity_changed",
  "identity_key_mismatch",
  "bad_binding_signature",
  "unsupported_suite",
  "illegal_mutation",
] as const;

const EXPECTED_KIND: Record<(typeof ALL_REASONS)[number], string> = {
  malformed_credential: "other",
  signature_key_mismatch: "other",
  unknown_identity: "repin",
  binding_unverified: "repin",
  identity_changed: "removable",
  identity_key_mismatch: "other",
  bad_binding_signature: "other",
  unsupported_suite: "other",
  illegal_mutation: "other",
};

for (const reason of ALL_REASONS) {
  test(`LeafRejection ${reason} → ${EXPECTED_KIND[reason]}`, () => {
    const got = classifyLeafRejection(rejected(reason), SELF);
    if (EXPECTED_KIND[reason] === "other") {
      assert.deepEqual(got, { kind: "other" });
    } else {
      assert.deepEqual(got, {
        kind: EXPECTED_KIND[reason],
        userId: PEER_USER,
        deviceId: PEER_DEVICE,
      });
    }
  });
}

test("identity_changed is the ONLY reason that yields removable", () => {
  const removable = ALL_REASONS.filter(
    (reason) =>
      classifyLeafRejection(rejected(reason), SELF).kind === "removable",
  );
  assert.deepEqual(removable, ["identity_changed"]);
});

test("an unknown, future, missing or non-string reason → other", () => {
  for (const reason of [
    "revoked",
    "IDENTITY_CHANGED",
    "identityChanged",
    " identity_changed",
    "identity_changed ",
    "",
    undefined,
    null,
    1,
    ["identity_changed"],
    { reason: "identity_changed" },
  ]) {
    assert.deepEqual(
      classifyLeafRejection(rejected(reason), SELF),
      { kind: "other" },
      String(reason),
    );
  }
});

for (const reason of [
  "identity_changed",
  "unknown_identity",
  "binding_unverified",
]) {
  test(`${reason}: a leaf of OUR OWN USER → other (own device and sibling)`, () => {
    // Our own device's leaf.
    assert.deepEqual(
      classifyLeafRejection(rejected(reason, SELF.userId, SELF.deviceId), SELF),
      { kind: "other" },
    );
    // Another device of our own user: the user check, not the device check.
    assert.deepEqual(
      classifyLeafRejection(rejected(reason, SELF.userId, PEER_DEVICE), SELF),
      { kind: "other" },
    );
  });
}

test("our own user id unknown or malformed → other (cannot prove not-self)", () => {
  for (const userId of ["", "a:b", " ", undefined, null]) {
    const self = { userId, deviceId: SELF.deviceId } as unknown as {
      userId: string;
      deviceId: string;
    };
    for (const reason of ["identity_changed", "unknown_identity"]) {
      assert.deepEqual(
        classifyLeafRejection(rejected(reason), self),
        { kind: "other" },
        `${String(userId)} / ${reason}`,
      );
    }
  }
});

test("empty ids → other (try_apply_commit emits empty ids)", () => {
  for (const reason of ["identity_changed", "unknown_identity"]) {
    assert.deepEqual(classifyLeafRejection(rejected(reason, "", ""), SELF), {
      kind: "other",
    });
    assert.deepEqual(
      classifyLeafRejection(rejected(reason, "", PEER_DEVICE), SELF),
      { kind: "other" },
    );
    assert.deepEqual(
      classifyLeafRejection(rejected(reason, PEER_USER, ""), SELF),
      { kind: "other" },
    );
  }
});

test("missing or non-string ids → other", () => {
  // Literal objects, not `rejected(…)`: its default parameters would turn an
  // `undefined` id back into a valid one.
  for (const bad of [undefined, null, 0, 42, true, {}, [], ["x"]]) {
    assert.deepEqual(
      classifyLeafRejection(
        {
          type: "mls_leaf_rejected",
          user_id: bad,
          device_id: PEER_DEVICE,
          reason: "identity_changed",
        },
        SELF,
      ),
      { kind: "other" },
      `user_id ${JSON.stringify(bad)}`,
    );
    assert.deepEqual(
      classifyLeafRejection(
        {
          type: "mls_leaf_rejected",
          user_id: PEER_USER,
          device_id: bad,
          reason: "identity_changed",
        },
        SELF,
      ),
      { kind: "other" },
      `device_id ${JSON.stringify(bad)}`,
    );
  }
  // Fields absent altogether.
  assert.deepEqual(
    classifyLeafRejection(
      { type: "mls_leaf_rejected", reason: "identity_changed" },
      SELF,
    ),
    { kind: "other" },
  );
});

test("malformed ids that would change the identity's shape → other", () => {
  for (const bad of [
    "a:b", // an extra segment
    `${PEER_DEVICE}:screen`, // forges the screen-leg suffix
    ":", // empty segments
    " ", // whitespace only
    `${PEER_DEVICE} `, // trailing space
    "dev\tB", // tab
    "dev\nB", // newline
    "dev\u0000B", // control character
    `dev${String.fromCharCode(0x202e)}B`, // invisible format character
    "x".repeat(65), // over the cap
  ]) {
    assert.deepEqual(
      classifyLeafRejection(rejected("identity_changed", bad), SELF),
      { kind: "other" },
      `user_id ${JSON.stringify(bad)}`,
    );
    assert.deepEqual(
      classifyLeafRejection(rejected("identity_changed", PEER_USER, bad), SELF),
      { kind: "other" },
      `device_id ${JSON.stringify(bad)}`,
    );
  }
});

test("well-formed ids of any house shape are accepted (64-char cap inclusive)", () => {
  // The session's own fixtures use short ids; the classifier judges the
  // identity grammar, not one id generator.
  for (const [userId, deviceId] of [
    ["bob", "devB"],
    [PEER_USER, PEER_DEVICE],
    ["x".repeat(64), "y".repeat(64)],
  ]) {
    assert.deepEqual(
      classifyLeafRejection(
        rejected("identity_changed", userId, deviceId),
        SELF,
      ),
      { kind: "removable", userId, deviceId },
    );
  }
});

test("not the plain native object → other (non-objects, Error, other types)", () => {
  const withFields = <T extends object>(target: T) =>
    Object.assign(target, {
      type: "mls_leaf_rejected",
      user_id: PEER_USER,
      device_id: PEER_DEVICE,
      reason: "identity_changed",
    });
  for (const error of [
    undefined,
    null,
    0,
    "mls_leaf_rejected",
    "identity_changed",
    true,
    Symbol("mls_leaf_rejected"),
    [],
    new Error("mls_leaf_rejected"),
    // An Error carrying every native field is still not the native object.
    withFields(new Error("mls_leaf_rejected")),
    withFields(new (class NativeLike {})()),
    withFields(() => undefined),
    [rejected("identity_changed")],
  ]) {
    assert.deepEqual(
      classifyLeafRejection(error, SELF),
      { kind: "other" },
      String(typeof error),
    );
  }
});

test("other native error types → other, even with leaf-shaped fields", () => {
  for (const type of [
    "mls_poisoned_epoch",
    "mls_epoch_gap",
    "mls_group_not_found",
    "peer_identity_changed",
    "bundle_rejected",
    "MLS_LEAF_REJECTED",
    "",
    undefined,
  ]) {
    assert.deepEqual(
      classifyLeafRejection(
        {
          type,
          group_id: "g",
          epoch: 3,
          user_id: PEER_USER,
          device_id: PEER_DEVICE,
          reason: "identity_changed",
        },
        SELF,
      ),
      { kind: "other" },
      String(type),
    );
  }
});

test("a null-prototype object with the native fields is still classified", () => {
  const error = Object.assign(Object.create(null) as object, {
    type: "mls_leaf_rejected",
    user_id: PEER_USER,
    device_id: PEER_DEVICE,
    reason: "identity_changed",
  });
  assert.deepEqual(classifyLeafRejection(error, SELF), {
    kind: "removable",
    userId: PEER_USER,
    deviceId: PEER_DEVICE,
  });
});

test("extra fields are ignored and never leak into the result", () => {
  const got = classifyLeafRejection(
    {
      ...rejected("identity_changed"),
      group_id: "group-1",
      epoch: 7,
      kind: "other",
      userId: "someone-else",
      deviceId: "another-device",
    },
    SELF,
  );
  assert.deepEqual(got, {
    kind: "removable",
    userId: PEER_USER,
    deviceId: PEER_DEVICE,
  });
  assert.deepEqual(
    classifyLeafRejection(
      { ...rejected("unknown_identity"), extra: { nested: true } },
      SELF,
    ),
    { kind: "repin", userId: PEER_USER, deviceId: PEER_DEVICE },
  );
});

test("inherited fields cannot satisfy the check (own properties only)", () => {
  const inherited = Object.create(
    Object.create(Object.prototype, {
      type: { value: "mls_leaf_rejected", enumerable: true },
    }),
  );
  Object.assign(inherited, {
    user_id: PEER_USER,
    device_id: PEER_DEVICE,
    reason: "identity_changed",
  });
  // `inherited` is not a plain object either (its prototype is not
  // Object.prototype), so also check a plain object whose PROTOTYPE chain is
  // polluted: the inherited value must not count.
  const polluted = Object.prototype as unknown as Record<string, unknown>;
  polluted.reason = "identity_changed";
  try {
    assert.deepEqual(
      classifyLeafRejection(
        {
          type: "mls_leaf_rejected",
          user_id: PEER_USER,
          device_id: PEER_DEVICE,
        },
        SELF,
      ),
      { kind: "other" },
    );
  } finally {
    delete polluted.reason;
  }
});

test("never throws: throwing getters and proxy traps → other", () => {
  const throwingGetter = {
    type: "mls_leaf_rejected",
    user_id: PEER_USER,
    reason: "identity_changed",
    get device_id(): string {
      throw new Error("boom");
    },
  };
  const throwingProxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error("boom");
      },
    },
  );
  const throwingOwnCheck = new Proxy(rejected("identity_changed"), {
    getOwnPropertyDescriptor() {
      throw new Error("boom");
    },
  });
  for (const error of [throwingGetter, throwingProxy, throwingOwnCheck]) {
    assert.doesNotThrow(() => classifyLeafRejection(error, SELF));
    assert.deepEqual(classifyLeafRejection(error, SELF), { kind: "other" });
  }
});

test("the result is a fresh object every call (no shared mutable state)", () => {
  const a = classifyLeafRejection(undefined, SELF);
  const b = classifyLeafRejection(undefined, SELF);
  assert.notEqual(a, b);
  (a as { kind: string }).kind = "removable";
  assert.deepEqual(classifyLeafRejection(undefined, SELF), { kind: "other" });
});
