// Unit spec for the Prot spending gate outside the stores: run with Node's
// built-in runner:
//   node --conditions=browser --test components/client/distribution.prot.test.ts
// Focus: the browser (no Capacitor bridge) is "web" and may spend Prot, so
// the gate is a channel decision and not always off. Store builds:
// distribution.play.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  allowsDonationLinks,
  allowsProtSpending,
  distributionChannel,
} from "./distribution.ts";

test("the browser may spend Prot", () => {
  assert.equal(distributionChannel(), "web");
  assert.equal(allowsProtSpending(), true);
  // Same channels as the payment links until S6
  assert.equal(allowsProtSpending(), allowsDonationLinks());
});
