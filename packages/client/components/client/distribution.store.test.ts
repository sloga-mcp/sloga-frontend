// Unit spec for the Prot purchase gate (S6): run with Node's built-in runner:
//   node --conditions=browser --test components/client/distribution.store.test.ts
// Focus: protPurchaseChannel and allowsProtSpendingFor against the pinned
// truth table, row by row and over every combination of channel, advert,
// preview and plugin. The pure functions take the facts as parameters, so no
// bridge is stood up here and this process is "web". Store builds with real
// facts: distribution.appstore.open.test.ts, distribution.play.open.test.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createComputed, createRoot } from "solid-js";

import {
  type DistributionChannel,
  type ProtPurchaseChannel,
  allowsDonationLinks,
  allowsProtSpending,
  allowsProtSpendingFor,
  distributionChannel,
  isStoreBuild,
  protPurchaseChannel,
  resolveChannel,
} from "./distribution.ts";
import {
  type ProtStoreAdvert,
  type ProtStoreFacts,
  NO_PROT_STORE_FACTS,
  protStoreFacts,
  setProtStoreFacts,
} from "./protStoreFacts.ts";

const CHANNELS: DistributionChannel[] = [
  "web",
  "sideload",
  "foss",
  "play",
  "appstore",
];

const ADVERTS: (ProtStoreAdvert | null)[] = [
  null,
  { apple_open: false, play_open: false },
  { apple_open: true, play_open: false },
  { apple_open: false, play_open: true },
  { apple_open: true, play_open: true },
];

const BOOLS = [false, true];

type Grid = {
  channel: DistributionChannel;
  store: ProtStoreAdvert | null;
  preview: boolean;
  plugin: boolean;
};

function grid(): Grid[] {
  const out: Grid[] = [];
  for (const channel of CHANNELS) {
    for (const store of ADVERTS) {
      for (const preview of BOOLS) {
        for (const plugin of BOOLS) {
          out.push({ channel, store, preview, plugin });
        }
      }
    }
  }
  return out;
}

function label(g: Grid) {
  return `${g.channel} store=${JSON.stringify(g.store)} preview=${g.preview} plugin=${g.plugin}`;
}

// The pinned truth table (contracts section 22, design section 14.3), one
// entry per row. `undefined` in a column means "any".
type Row = {
  name: string;
  channels: DistributionChannel[];
  store?: (s: ProtStoreAdvert | null) => boolean;
  preview?: boolean;
  plugin?: boolean;
  result: ProtPurchaseChannel;
  spending: boolean;
};

const isNull = (s: ProtStoreAdvert | null) => s === null;
const apple = (open: boolean) => (s: ProtStoreAdvert | null) =>
  s !== null && s.apple_open === open;
const play = (open: boolean) => (s: ProtStoreAdvert | null) =>
  s !== null && s.play_open === open;

const ROWS: Row[] = [
  {
    name: "web / sideload / foss | any | any | any -> stripe",
    channels: ["web", "sideload", "foss"],
    result: "stripe",
    spending: true,
  },
  {
    name: "appstore | null | any | any -> none (R26)",
    channels: ["appstore"],
    store: isNull,
    result: "none",
    spending: false,
  },
  {
    name: "appstore | apple_open false | false | any -> none",
    channels: ["appstore"],
    store: apple(false),
    preview: false,
    result: "none",
    spending: false,
  },
  {
    name: "appstore | apple_open true | any | false -> none",
    channels: ["appstore"],
    store: apple(true),
    plugin: false,
    result: "none",
    spending: false,
  },
  {
    name: "appstore | apple_open true | any | true -> appstore",
    channels: ["appstore"],
    store: apple(true),
    plugin: true,
    result: "appstore",
    spending: true,
  },
  {
    name: "appstore | apple_open false | true | true -> appstore",
    channels: ["appstore"],
    store: apple(false),
    preview: true,
    plugin: true,
    result: "appstore",
    spending: true,
  },
  {
    name: "appstore | apple_open false | true | false -> none",
    channels: ["appstore"],
    store: apple(false),
    preview: true,
    plugin: false,
    result: "none",
    spending: false,
  },
  {
    name: "play | null | any | any -> none (R26)",
    channels: ["play"],
    store: isNull,
    result: "none",
    spending: false,
  },
  {
    name: "play | play_open false | false | any -> none",
    channels: ["play"],
    store: play(false),
    preview: false,
    result: "none",
    spending: false,
  },
  {
    name: "play | play_open true | any | false -> none",
    channels: ["play"],
    store: play(true),
    plugin: false,
    result: "none",
    spending: false,
  },
  {
    name: "play | play_open true | any | true -> play",
    channels: ["play"],
    store: play(true),
    plugin: true,
    result: "play",
    spending: true,
  },
  {
    name: "play | play_open false | true | true -> play",
    channels: ["play"],
    store: play(false),
    preview: true,
    plugin: true,
    result: "play",
    spending: true,
  },
  {
    name: "play | play_open false | true | false -> none",
    channels: ["play"],
    store: play(false),
    preview: true,
    plugin: false,
    result: "none",
    spending: false,
  },
  {
    name: "appstore with only play_open true | false | true -> none",
    channels: ["appstore"],
    store: (s) => s !== null && !s.apple_open && s.play_open,
    preview: false,
    plugin: true,
    result: "none",
    spending: false,
  },
  {
    name: "play with only apple_open true | false | true -> none",
    channels: ["play"],
    store: (s) => s !== null && s.apple_open && !s.play_open,
    preview: false,
    plugin: true,
    result: "none",
    spending: false,
  },
];

function matches(row: Row, g: Grid) {
  return (
    row.channels.includes(g.channel) &&
    (row.store === undefined || row.store(g.store)) &&
    (row.preview === undefined || row.preview === g.preview) &&
    (row.plugin === undefined || row.plugin === g.plugin)
  );
}

for (const row of ROWS) {
  test(`truth table: ${row.name}`, () => {
    const hits = grid().filter((g) => matches(row, g));
    assert.ok(hits.length > 0, "the row matches no combination");
    for (const g of hits) {
      assert.equal(
        protPurchaseChannel(g.channel, g.store, g.preview, g.plugin),
        row.result,
        label(g),
      );
      assert.equal(
        allowsProtSpendingFor(g.channel, g.store, g.preview, g.plugin),
        row.spending,
        label(g),
      );
    }
  });
}

test("the truth table covers every combination, and its rows agree", () => {
  const all = grid();
  assert.equal(all.length, 5 * 5 * 2 * 2);
  for (const g of all) {
    const hits = ROWS.filter((row) => matches(row, g));
    assert.ok(hits.length > 0, `no pinned row for ${label(g)}`);
    const result = protPurchaseChannel(g.channel, g.store, g.preview, g.plugin);
    for (const row of hits) assert.equal(result, row.result, label(g));
    assert.equal(
      allowsProtSpendingFor(g.channel, g.store, g.preview, g.plugin),
      result !== "none",
      label(g),
    );
  }
});

test("an old store shell without the plugin never buys or spends", () => {
  for (const g of grid()) {
    if (!isStoreBuild(g.channel) || g.plugin) continue;
    assert.equal(
      protPurchaseChannel(g.channel, g.store, g.preview, false),
      "none",
      label(g),
    );
    assert.equal(
      allowsProtSpendingFor(g.channel, g.store, g.preview, false),
      false,
      label(g),
    );
  }
});

test("no advert fails closed in a store build, even for a preview account", () => {
  for (const channel of ["appstore", "play"] as const) {
    assert.equal(protPurchaseChannel(channel, null, true, true), "none");
    assert.equal(allowsProtSpendingFor(channel, null, true, true), false);
  }
});

test("a store build buys only through its own store", () => {
  const both = { apple_open: true, play_open: true };
  assert.equal(protPurchaseChannel("appstore", both, false, true), "appstore");
  assert.equal(protPurchaseChannel("play", both, false, true), "play");
  assert.equal(protPurchaseChannel("appstore", both, true, true), "appstore");
  assert.equal(protPurchaseChannel("play", both, true, true), "play");
});

test("isStoreBuild is play and appstore only", () => {
  assert.deepEqual(
    CHANNELS.filter((c) => isStoreBuild(c)),
    ["play", "appstore"],
  );
});

test("desktop shells resolve to web and buy through Stripe", () => {
  // Tauri and Electron are not Capacitor native platforms
  const desktop = resolveChannel({
    native: false,
    platform: "web",
    pluginAvailable: false,
  });
  assert.equal(desktop, "web");
  assert.equal(isStoreBuild(desktop), false);
  for (const g of grid()) {
    assert.equal(
      protPurchaseChannel(desktop, g.store, g.preview, g.plugin),
      "stripe",
    );
    assert.equal(
      allowsProtSpendingFor(desktop, g.store, g.preview, g.plugin),
      true,
    );
  }
});

test("the facts start closed", () => {
  assert.deepEqual(NO_PROT_STORE_FACTS, {
    store: null,
    storePreview: false,
    pluginAvailable: false,
  });
  assert.equal(Object.isFrozen(NO_PROT_STORE_FACTS), true);
  assert.equal(protStoreFacts(), NO_PROT_STORE_FACTS);
  for (const channel of ["appstore", "play"] as const) {
    const f: ProtStoreFacts = NO_PROT_STORE_FACTS;
    assert.equal(
      allowsProtSpendingFor(
        channel,
        f.store,
        f.storePreview,
        f.pluginAvailable,
      ),
      false,
    );
  }
});

test("on the web the store facts never change either gate", () => {
  assert.equal(distributionChannel(), "web");
  const seen: boolean[] = [];
  const dispose = createRoot((dispose) => {
    createComputed(() => seen.push(allowsProtSpending()));
    return dispose;
  });
  try {
    for (const g of grid()) {
      setProtStoreFacts({
        store: g.store,
        storePreview: g.preview,
        pluginAvailable: g.plugin,
      });
      assert.equal(allowsProtSpending(), true);
      assert.equal(allowsDonationLinks(), true);
    }
  } finally {
    dispose();
    setProtStoreFacts(NO_PROT_STORE_FACTS);
  }
  // One run at creation, then one per facts write; always true
  assert.equal(seen.length, 1 + grid().length);
  assert.ok(seen.every((v) => v === true));
});

test("allowsDonationLinks is untouched by S6 and never reads the store facts", () => {
  const source = readFileSync(
    new URL("./distribution.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("export const allowsDonationLinks = () =>");
  assert.ok(start >= 0, "allowsDonationLinks not found");
  const end = source.indexOf(";", start);
  assert.equal(
    source.slice(start, end + 1),
    'export const allowsDonationLinks = () =>\n  channel() !== "play" && channel() !== "appstore";',
  );
  // Ko-fi, Cipher and Supporter stay hidden in both store builds, whatever
  // the store facts say
  assert.doesNotMatch(source.slice(start, end + 1), /protStore|Prot/);
});

test("no web purchase link code in the gate (E8)", () => {
  const files = ["./distribution.ts", "./protStoreFacts.ts"].map((f) =>
    readFileSync(new URL(f, import.meta.url), "utf8"),
  );
  for (const source of files) {
    assert.doesNotMatch(source, /us_web_link|https?:\/\/[^"\s]*sloga\.gg/);
  }
});
