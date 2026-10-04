// Specs for the Duplicate role helpers — run with Node's built-in runner:
//   node --conditions=browser --test components/app/interface/settings/server/roles/roleDuplicate.test.ts
//
// Pure: no DOM, no client. Names are measured by code point, the way the
// server validates them, and permission bits are checked above 2^31, where
// JS number bitwise operators go wrong.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type RoleCopySource,
  missingAllowBits,
  planRoleCopy,
  ROLE_NAME_MAX,
} from "./roleDuplicate.ts";

const SUFFIX = "(copy)";
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const GRIN = "\u{1F600}";

/** A role with no permissions, no colour and no hoist */
function role(overrides: Partial<RoleCopySource> = {}): RoleCopySource {
  return { name: "Moderator", permissions: { a: 0n, d: 0n }, ...overrides };
}

function codePoints(value: string): number {
  return [...value].length;
}

test("the name limit matches the server's 32 code points", () => {
  assert.equal(ROLE_NAME_MAX, 32);
});

test("a short name gets the suffix after a space", () => {
  assert.equal(planRoleCopy(role(), SUFFIX).name, "Moderator (copy)");
});

test("a name that fits exactly is not cut", () => {
  const name = "a".repeat(25);
  const copy = planRoleCopy(role({ name }), SUFFIX).name;
  assert.equal(copy, name + " (copy)");
  assert.equal(codePoints(copy), 32);
});

test("a long ASCII name is cut so the copy is exactly 32", () => {
  const copy = planRoleCopy(
    role({ name: "abcdefghij".repeat(4) }),
    SUFFIX,
  ).name;
  assert.equal(copy, "abcdefghijabcdefghijabcde (copy)");
  assert.equal([...copy].length, 32);
});

test("an emoji name is cut by code point, never mid-surrogate", () => {
  const copy = planRoleCopy(role({ name: GRIN.repeat(32) }), SUFFIX).name;
  assert.equal(copy, GRIN.repeat(25) + " (copy)");
  assert.equal([...copy].length, 32);
  assert.doesNotMatch(copy, LONE_SURROGATE);
});

test("the room left for the name follows the suffix length", () => {
  const copy = planRoleCopy(role({ name: "x".repeat(40) }), "(kopija)").name;
  assert.equal(copy, "x".repeat(23) + " (kopija)");
  assert.equal(codePoints(copy), 32);
});

test("trailing whitespace at the cut is trimmed", () => {
  const name = "a".repeat(22) + "   tail";
  const copy = planRoleCopy(role({ name }), SUFFIX).name;
  assert.equal(copy, "a".repeat(22) + " (copy)");
});

test("trailing whitespace on an uncut name is trimmed", () => {
  assert.equal(
    planRoleCopy(role({ name: "Mod \t " }), SUFFIX).name,
    "Mod (copy)",
  );
});

test("an empty or whitespace-only base leaves the suffix alone", () => {
  assert.equal(planRoleCopy(role({ name: "" }), SUFFIX).name, "(copy)");
  assert.equal(planRoleCopy(role({ name: "   " }), SUFFIX).name, "(copy)");
  assert.equal(
    planRoleCopy(role({ name: " ".repeat(30) + "late" }), SUFFIX).name,
    "(copy)",
  );
});

test("no permissions are sent when the source allows and denies nothing", () => {
  const plan = planRoleCopy(role(), SUFFIX);
  assert.equal("permissions" in plan, false);
});

test("deny-only permissions are kept", () => {
  const plan = planRoleCopy(
    role({ permissions: { a: 0n, d: 1n << 4n } }),
    SUFFIX,
  );
  assert.deepEqual(plan.permissions, { allow: 0, deny: 16 });
});

test("a 2^43 allow bit round-trips exactly as a Number", () => {
  const a = (1n << 43n) | (1n << 31n) | 1n;
  const plan = planRoleCopy(role({ permissions: { a, d: 0n } }), SUFFIX);
  assert.ok(plan.permissions);
  assert.equal(plan.permissions.allow, 2 ** 43 + 2 ** 31 + 1);
  assert.equal(BigInt(plan.permissions.allow), a);
  assert.equal(plan.permissions.deny, 0);
});

test("no edit when there is no colour and no hoist", () => {
  for (const extra of [
    { colour: null, hoist: false },
    { colour: undefined, hoist: undefined },
    {},
  ]) {
    const plan = planRoleCopy(role(extra), SUFFIX);
    assert.equal("edit" in plan, false, JSON.stringify(extra));
  }
});

test("edit carries the colour alone", () => {
  const plan = planRoleCopy(role({ colour: "#ff0000", hoist: false }), SUFFIX);
  assert.deepEqual(plan.edit, { colour: "#ff0000" });
});

test("edit carries hoist alone", () => {
  const plan = planRoleCopy(role({ colour: null, hoist: true }), SUFFIX);
  assert.deepEqual(plan.edit, { hoist: true });
});

test("edit carries colour and hoist together", () => {
  const colour = "linear-gradient(to right, #ff0000, #0000ff)";
  const plan = planRoleCopy(role({ colour, hoist: true }), SUFFIX);
  assert.deepEqual(plan.edit, { colour, hoist: true });
});

test("missingAllowBits keeps bit 2^31 positive", () => {
  const missing = missingAllowBits(1n << 31n, 0n);
  assert.equal(missing, 2147483648n);
  assert.ok(missing > 0n);
});

test("missingAllowBits keeps bits from 2^32 up", () => {
  assert.equal(missingAllowBits(1n << 32n, 0n), 4294967296n);
  assert.equal(missingAllowBits(1n << 43n, 0n), 8796093022208n);
});

test("missingAllowBits is zero when allow is a subset of have", () => {
  const have = (1n << 43n) | (1n << 31n) | 0b1111n;
  assert.equal(missingAllowBits(0n, have), 0n);
  assert.equal(missingAllowBits((1n << 43n) | 0b101n, have), 0n);
  assert.equal(missingAllowBits(have, have), 0n);
});

test("missingAllowBits returns only the bits that are lacking", () => {
  const allow = (1n << 43n) | (1n << 32n) | (1n << 31n) | 0b101n;
  const have = (1n << 32n) | (1n << 31n) | 0b001n;
  assert.equal(missingAllowBits(allow, have), (1n << 43n) | 0b100n);
});
