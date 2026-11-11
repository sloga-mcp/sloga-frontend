// Unit spec for the store gates in a Play build: run with Node's built-in
// runner:
//   node --conditions=browser --test components/client/distribution.play.test.ts
// Focus: an Android build whose AppFlavor plugin reports "play" must not
// spend Prot (no in-app purchase until S6, D5) and must not link out to
// payments. The channel is module state read at import, so this file
// stands up a Capacitor Android bridge BEFORE importing distribution.ts,
// and runs in its own process (node --test isolates each file).
import assert from "node:assert/strict";
import { test } from "node:test";

const reports: string[] = [];

// What @capacitor/core reads at import: `androidBridge` makes the platform
// "android", the plugin header makes AppFlavor available, and its `get` is
// answered through `nativePromise` the way the native bridge would
Object.assign(globalThis, {
  androidBridge: {},
  Capacitor: {
    PluginHeaders: [
      { name: "AppFlavor", methods: [{ name: "get", rtype: "promise" }] },
    ],
    nativePromise: (plugin: string, method: string) => {
      reports.push(`${plugin}.${method}`);
      return Promise.resolve({ channel: "play" });
    },
  },
});

const { allowsDonationLinks, allowsProtSpending, distributionChannel } =
  await import("./distribution.ts");

test("before the plugin answers, a native Android build reads as Play", () => {
  assert.equal(distributionChannel(), "play");
  assert.equal(allowsProtSpending(), false);
  assert.equal(allowsDonationLinks(), false);
});

test("a build reporting play cannot spend Prot", async () => {
  // Let the AppFlavor answer land
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(reports, ["AppFlavor.get"]);
  assert.equal(distributionChannel(), "play");
  assert.equal(allowsProtSpending(), false);
  assert.equal(allowsDonationLinks(), false);
});
