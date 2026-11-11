// Unit spec for the store gates in a Play build once the store facts arrive
// (S6): run with Node's built-in runner:
//   node --conditions=browser --test components/client/distribution.play.open.test.ts
// Focus: an Android build whose AppFlavor plugin reports "play" may spend
// Prot only while it can buy Prot in app (Play open, or preview access, with
// the ProtStore plugin present), and still never links out to payments. The
// channel is module state read at import, so this file stands up a Capacitor
// Android bridge BEFORE importing distribution.ts, and runs in its own
// process (node --test isolates each file). Without facts:
// distribution.play.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createComputed, createRoot } from "solid-js";

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

const {
  allowsDonationLinks,
  allowsProtSpending,
  distributionChannel,
  isStoreBuild,
  protPurchaseChannel,
} = await import("./distribution.ts");
const { NO_PROT_STORE_FACTS, protStoreFacts, setProtStoreFacts } =
  await import("./protStoreFacts.ts");

function purchaseChannel() {
  const f = protStoreFacts();
  return protPurchaseChannel(
    distributionChannel(),
    f.store,
    f.storePreview,
    f.pluginAvailable,
  );
}

test("a Play build starts closed", async () => {
  // Let the AppFlavor answer land
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(reports, ["AppFlavor.get"]);
  assert.equal(distributionChannel(), "play");
  assert.equal(isStoreBuild(distributionChannel()), true);
  assert.equal(protStoreFacts(), NO_PROT_STORE_FACTS);
  assert.equal(purchaseChannel(), "none");
  assert.equal(allowsProtSpending(), false);
  assert.equal(allowsDonationLinks(), false);
});

test("an open Play store with the plugin may spend Prot", () => {
  setProtStoreFacts({
    store: { apple_open: false, play_open: true },
    storePreview: false,
    pluginAvailable: true,
  });
  assert.equal(purchaseChannel(), "play");
  assert.equal(allowsProtSpending(), true);
  assert.equal(allowsDonationLinks(), false);
});

test("a preview account may spend before Play opens", () => {
  setProtStoreFacts({
    store: { apple_open: false, play_open: false },
    storePreview: true,
    pluginAvailable: true,
  });
  assert.equal(purchaseChannel(), "play");
  assert.equal(allowsProtSpending(), true);
  assert.equal(allowsDonationLinks(), false);
});

test("an older shell without the plugin never spends", () => {
  for (const storePreview of [false, true]) {
    setProtStoreFacts({
      store: { apple_open: true, play_open: true },
      storePreview,
      pluginAvailable: false,
    });
    assert.equal(purchaseChannel(), "none");
    assert.equal(allowsProtSpending(), false);
    assert.equal(allowsDonationLinks(), false);
  }
});

test("no advert fails closed, even for a preview account", () => {
  setProtStoreFacts({ store: null, storePreview: true, pluginAvailable: true });
  assert.equal(purchaseChannel(), "none");
  assert.equal(allowsProtSpending(), false);
  assert.equal(allowsDonationLinks(), false);
});

test("an open App Store does not open Play", () => {
  setProtStoreFacts({
    store: { apple_open: true, play_open: false },
    storePreview: false,
    pluginAvailable: true,
  });
  assert.equal(purchaseChannel(), "none");
  assert.equal(allowsProtSpending(), false);
  assert.equal(allowsDonationLinks(), false);
});

test("allowsProtSpending follows the facts reactively", () => {
  setProtStoreFacts(NO_PROT_STORE_FACTS);
  const seen: boolean[] = [];
  const donations: boolean[] = [];
  const dispose = createRoot((dispose) => {
    createComputed(() => seen.push(allowsProtSpending()));
    createComputed(() => donations.push(allowsDonationLinks()));
    return dispose;
  });
  try {
    setProtStoreFacts({
      store: { apple_open: false, play_open: true },
      storePreview: false,
      pluginAvailable: true,
    });
    setProtStoreFacts({
      store: { apple_open: false, play_open: false },
      storePreview: false,
      pluginAvailable: true,
    });
    setProtStoreFacts(NO_PROT_STORE_FACTS);
  } finally {
    dispose();
  }
  assert.deepEqual(seen, [false, true, false, false]);
  // Ko-fi, Cipher and Supporter stay hidden whatever the store facts say
  assert.deepEqual(donations, [false]);
});
