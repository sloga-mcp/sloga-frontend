// Split capability advert (multi-device plan D5, contract R9).
// Run: node --test --conditions=browser components/client/e2eeSplitCapability.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseSplitCapability } from "./e2eeSplitCapability.ts";

test("true only for features.e2ee.split_from === true", () => {
  assert.equal(
    parseSplitCapability({ features: { e2ee: { split_from: true } } }),
    true,
  );
});

test("missing, false, truthy-but-not-true and malformed bodies are false", () => {
  for (const body of [
    undefined,
    null,
    "features",
    [],
    {},
    { features: null },
    { features: { e2ee: null } },
    { features: { e2ee: {} } },
    { features: { e2ee: { split_from: false } } },
    { features: { e2ee: { split_from: "true" } } },
    { features: { e2ee: { split_from: 1 } } },
    { features: [{ split_from: true }] },
    { e2ee: { split_from: true } },
    { features: { split_from: true } },
  ]) {
    assert.equal(parseSplitCapability(body), false, JSON.stringify(body));
  }
});

test("an inherited split_from does not count", () => {
  const e2ee = Object.create({ split_from: true });
  assert.equal(parseSplitCapability({ features: { e2ee } }), false);
});
