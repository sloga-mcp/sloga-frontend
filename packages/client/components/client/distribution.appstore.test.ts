// Unit spec for the store gates in an App Store build: run with Node's
// built-in runner:
//   node --conditions=browser --test components/client/distribution.appstore.test.ts
// Focus: an iOS build must not spend Prot (no in-app purchase until S6, D5).
// The channel is module state read at import, so this file stands up a
// Capacitor iOS bridge BEFORE importing distribution.ts, and runs in its
// own process (node --test isolates each file).
import assert from "node:assert/strict";
import { test } from "node:test";

// What @capacitor/core reads at import: a WebKit `bridge` message handler
// makes the platform "ios"
Object.assign(globalThis, {
  webkit: { messageHandlers: { bridge: {} } },
});

const { allowsDonationLinks, allowsProtSpending, distributionChannel } =
  await import("./distribution.ts");

test("an App Store build cannot spend Prot", () => {
  assert.equal(distributionChannel(), "appstore");
  assert.equal(allowsProtSpending(), false);
  assert.equal(allowsDonationLinks(), false);
});
