/**
 * Run with:
 *
 *     node --conditions=browser --test components/app/interface/settings/user/protWallet.store.test.ts
 *
 * Prot sold as App Store / Google Play in-app purchases (S6), on the wallet
 * side (protWallet.test.ts covers the rest of the module and stays as it is):
 *
 * - the `features.prot.store` advert is read only when it is well formed,
 *   and is otherwise absent, so an older server's advert parses exactly as
 *   before and a malformed one never opens the store to a preview account;
 * - `/@me` `store_preview` is on only when the server sent literally `true`;
 * - `storePacks` shows the server's Prot with the store's own price, hides
 *   every pack the store did not return, and never shows a product the
 *   server does not list;
 * - StoreShop in ProtSettings.tsx (source level): no web price, no Stripe
 *   checkout, no checkout notes, no web link (E8), the Stripe Shop still
 *   rendered once, the iPhone honesty line (E2) on iOS only, outcomes from
 *   the worker and never from ledger rows (R30), and a failed sheet noted
 *   from its code only, its native message logged and never shown (R31),
 *   and a purchase held over the wallet cap shown as under review (R63);
 * - nothing reads the web-link flag, and `store_preview` is read only as
 *   `=== true`.
 *
 * The ten StoreShop pins need lane L3f's `function StoreShop(`: until it
 * exists each of them FAILS with a message saying so, never passes on an
 * empty slice.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  type ProtFeature,
  parseProtFeature,
  parseProtMe,
  storePacks,
} from "./protWallet.ts";

const ADVERT = {
  enabled: true,
  self_serve_enabled: false,
  sales_open: true,
  cipher_grants_enabled: true,
  packs: [
    { id: "p5", cents: 500, prot: 500 },
    { id: "p10", cents: 1000, prot: 1000 },
  ],
  exact_min_cents: 50,
  exact_max_cents: 50000,
  wallet_cap: 100000,
};

/** The product table (contracts section 4), Prot per product id */
const PRODUCTS: [string, number][] = [
  ["gg.sloga.prot.p5", 500],
  ["gg.sloga.prot.p10", 1000],
  ["gg.sloga.prot.p25", 2600],
  ["gg.sloga.prot.p50", 5300],
  ["gg.sloga.prot.p100", 11000],
];

const STORE_PRODUCTS = (["apple", "play"] as const).flatMap((store) =>
  PRODUCTS.map(([product_id, prot]) => ({ store, product_id, prot })),
);

const STORE = {
  apple_open: true,
  play_open: false,
  products: STORE_PRODUCTS,
  us_web_link: false,
};

const withStore = (store: unknown): ProtFeature =>
  parseProtFeature({ ...ADVERT, store });

/** What the ProtStore plugin returns: the store's id and localized price */
const PRICES = [
  { id: "gg.sloga.prot.p5", displayPrice: "$5.99" },
  { id: "gg.sloga.prot.p10", displayPrice: "$11.99" },
  { id: "gg.sloga.prot.p25", displayPrice: "$29.99" },
  { id: "gg.sloga.prot.p50", displayPrice: "$58.99" },
  { id: "gg.sloga.prot.p100", displayPrice: "$117.99" },
];

const meBody = (patch: Record<string, unknown> = {}) => ({
  balance: 100,
  held: 0,
  version: 1,
  recent: [],
  ...patch,
});

describe("parseProtFeature: the in-app store advert", () => {
  it("leaves the key absent when the advert has no store (an older server)", () => {
    const parsed = parseProtFeature(ADVERT);
    assert.equal("store" in parsed, false);
    assert.deepEqual(parsed, ADVERT);
    assert.equal(parsed.store ?? null, null);
    assert.equal("store" in parseProtFeature(undefined), false);
  });

  it("reads a well-formed store advert as is, the rest of the advert unchanged", () => {
    const parsed = withStore(STORE);
    assert.deepEqual(parsed.store, STORE);
    assert.deepEqual(parsed, { ...ADVERT, store: STORE });
  });

  it("is absent when the store advert is not well formed (fails closed)", () => {
    for (const store of [
      undefined,
      null,
      "open",
      true,
      1,
      [],
      [STORE],
      {},
      { ...STORE, apple_open: "true" },
      { ...STORE, apple_open: 1 },
      { ...STORE, apple_open: undefined },
      { ...STORE, play_open: "false" },
      { ...STORE, play_open: null },
      { ...STORE, products: undefined },
      { ...STORE, products: {} },
      { ...STORE, products: "gg.sloga.prot.p5" },
    ]) {
      const parsed = withStore(store);
      assert.equal("store" in parsed, false, JSON.stringify(store));
      assert.equal(parsed.store ?? null, null);
    }
  });

  it("keeps a closed store's products (preview accounts buy them)", () => {
    const closed = { ...STORE, apple_open: false, play_open: false };
    assert.deepEqual(withStore(closed).store, closed);
  });

  it("turns the web-link flag on only when it is literally true", () => {
    for (const us_web_link of [undefined, "true", 1, {}, null]) {
      assert.equal(
        withStore({ ...STORE, us_web_link }).store?.us_web_link,
        false,
      );
    }
    assert.equal(
      withStore({ ...STORE, us_web_link: true }).store?.us_web_link,
      true,
    );
  });

  it("drops malformed and repeated products and keeps the rest in order", () => {
    const good = { store: "apple", product_id: "gg.sloga.prot.p5", prot: 500 };
    const parsed = withStore({
      ...STORE,
      products: [
        null,
        "gg.sloga.prot.p5",
        { ...good, store: "google" },
        { ...good, store: "Apple" },
        { ...good, store: undefined },
        { ...good, product_id: "" },
        { ...good, product_id: 5 },
        { ...good, product_id: "x".repeat(65) },
        { ...good, prot: 0 },
        { ...good, prot: -500 },
        { ...good, prot: 1.5 },
        { ...good, prot: "500" },
        { ...good, prot: Number.MAX_SAFE_INTEGER + 1 },
        good,
        { ...good, prot: 9999 },
        { ...good, store: "play" },
        { store: "apple", product_id: "x".repeat(64), prot: 1 },
      ],
    });
    assert.deepEqual(parsed.store?.products, [
      good,
      { ...good, store: "play" },
      { store: "apple", product_id: "x".repeat(64), prot: 1 },
    ]);
  });
});

describe("parseProtMe: store_preview", () => {
  it("is on only when the server sent literally true", () => {
    assert.equal(
      parseProtMe(meBody({ store_preview: true })).store_preview,
      true,
    );
    for (const store_preview of [undefined, false, "true", 1, {}, null]) {
      const me = parseProtMe(meBody({ store_preview }));
      assert.equal("store_preview" in me, false, String(store_preview));
      assert.equal(me.store_preview === true, false);
    }
  });

  it("leaves a body without it exactly as before", () => {
    const body = meBody();
    assert.deepEqual(parseProtMe(body), body);
  });
});

describe("storePacks", () => {
  const feature = withStore(STORE);

  it("shows the server's Prot with the store's price, in the advert's order", () => {
    assert.deepEqual(storePacks(feature, "apple", [...PRICES].reverse()), [
      { id: "gg.sloga.prot.p5", prot: 500, displayPrice: "$5.99" },
      { id: "gg.sloga.prot.p10", prot: 1000, displayPrice: "$11.99" },
      { id: "gg.sloga.prot.p25", prot: 2600, displayPrice: "$29.99" },
      { id: "gg.sloga.prot.p50", prot: 5300, displayPrice: "$58.99" },
      { id: "gg.sloga.prot.p100", prot: 11000, displayPrice: "$117.99" },
    ]);
  });

  it("hides every pack the store did not return", () => {
    const returned = PRICES.filter(
      (product) => product.id !== "gg.sloga.prot.p25",
    );
    assert.deepEqual(
      storePacks(feature, "play", returned).map((pack) => pack.id),
      [
        "gg.sloga.prot.p5",
        "gg.sloga.prot.p10",
        "gg.sloga.prot.p50",
        "gg.sloga.prot.p100",
      ],
    );
    assert.deepEqual(storePacks(feature, "apple", []), []);
  });

  it("never shows a product the server does not list", () => {
    const packs = storePacks(feature, "apple", [
      { id: "gg.sloga.prot.p1000", displayPrice: "$999.99" },
      { id: "p5", displayPrice: "$5.00" },
      PRICES[0],
    ]);
    assert.deepEqual(packs, [
      { id: "gg.sloga.prot.p5", prot: 500, displayPrice: "$5.99" },
    ]);
  });

  it("lists only the named store's products", () => {
    const appleOnly = withStore({
      ...STORE,
      products: STORE_PRODUCTS.filter((product) => product.store === "apple"),
    });
    assert.equal(storePacks(appleOnly, "apple", PRICES).length, 5);
    assert.deepEqual(storePacks(appleOnly, "play", PRICES), []);
  });

  it("takes the Prot from the server, never from the store", () => {
    const [pack] = storePacks(feature, "apple", [
      { ...PRICES[0], prot: 99999 } as never,
    ]);
    assert.equal(pack.prot, 500);
    assert.deepEqual(Object.keys(pack).sort(), ["displayPrice", "id", "prot"]);
  });

  it("hides a pack the store returned without a usable price", () => {
    const packs = storePacks(feature, "apple", [
      { id: "gg.sloga.prot.p5", displayPrice: "" },
      { id: "gg.sloga.prot.p10", displayPrice: "   " },
      { id: "gg.sloga.prot.p25", displayPrice: 29.99 } as never,
      { id: 5, displayPrice: "$58.99" } as never,
      null as never,
      { id: "gg.sloga.prot.p100", displayPrice: " $117.99 " },
      { id: "gg.sloga.prot.p100", displayPrice: "$1.00" },
    ]);
    assert.deepEqual(packs, [
      { id: "gg.sloga.prot.p100", prot: 11000, displayPrice: "$117.99" },
    ]);
  });

  it("is empty without a store advert or with an unreadable store answer", () => {
    assert.deepEqual(storePacks(parseProtFeature(ADVERT), "apple", PRICES), []);
    assert.deepEqual(
      storePacks(parseProtFeature(undefined), "play", PRICES),
      [],
    );
    for (const answer of [undefined, null, {}, "gg.sloga.prot.p5"]) {
      assert.deepEqual(storePacks(feature, "apple", answer as never), []);
    }
  });
});

describe("StoreShop (source level)", () => {
  const settings = readFileSync(
    new URL("./ProtSettings.tsx", import.meta.url),
    "utf8",
  );

  /**
   * The body of `function StoreShop(`, up to the closing brace at its own
   * indentation. Fails (never an empty slice) while StoreShop is absent.
   */
  function storeShop(): string {
    const found = /^([ \t]*)function StoreShop\(/m.exec(settings);
    assert.ok(
      found,
      "ProtSettings.tsx has no `function StoreShop(` yet (lane L3f): these pins need it",
    );
    const end = settings.indexOf(`\n${found[1]}}\n`, found.index);
    assert.ok(end > found.index, "StoreShop has no closing brace");
    return settings.slice(found.index, end);
  }

  /** Whitespace folded, so a line prettier wrapped still matches */
  const fold = (text: string) => text.replace(/\s+/g, " ");

  /**
   * Index just past the bracket closing the one at `open` (`(` or `{`),
   * skipping strings, template literals and comments
   */
  function closing(text: string, open: number): number {
    const pairs: Record<string, string> = { "(": ")", "{": "}" };
    const close = pairs[text[open]];
    assert.ok(close, `no bracket at ${open}`);
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      const c = text[i];
      if (c === '"' || c === "'" || c === "`") {
        i++;
        while (i < text.length && text[i] !== c) i += text[i] === "\\" ? 2 : 1;
      } else if (c === "/" && text[i + 1] === "/") {
        i = text.indexOf("\n", i);
        if (i < 0) break;
      } else if (c === "/" && text[i + 1] === "*") {
        i = text.indexOf("*/", i) + 1;
        if (i <= 0) break;
      } else if (c === text[open]) {
        depth++;
      } else if (c === close && --depth === 0) {
        return i + 1;
      }
    }
    assert.fail(`unbalanced bracket at ${open}`);
  }

  /** Whether `at` lies inside the parentheses of a `console.` call */
  function inConsoleCall(text: string, at: number): boolean {
    for (const call of text.matchAll(/console\.\w+\(/g)) {
      const open = call.index + call[0].length - 1;
      if (open < at && at < closing(text, open)) return true;
    }
    return false;
  }

  /**
   * Whether `at` lies in the condition of an `if` whose block is one
   * `console.` call and nothing else (a guard for logging only)
   */
  function inLogOnlyGuard(text: string, at: number): boolean {
    const start = text.lastIndexOf("if (", at);
    if (start < 0) return false;
    const condEnd = closing(text, start + 3);
    if (at >= condEnd) return false;
    const brace = text.slice(condEnd).search(/\S/) + condEnd;
    if (text[brace] !== "{") return false;
    const body = text
      .slice(brace + 1, closing(text, brace) - 1)
      .replace(/^\s*\/\/.*$/gm, "")
      .trim();
    const call = /^console\.\w+\(/.exec(body);
    if (!call) return false;
    const end = closing(body, call[0].length - 1);
    return /^;?$/.test(body.slice(end).trim());
  }

  it("finds StoreShop, which lists storePacks with the store's price", () => {
    const shop = storeShop();
    assert.ok(shop.includes("storePacks("), "StoreShop calls storePacks(");
    assert.ok(shop.includes("displayPrice"), "StoreShop shows displayPrice");
  });

  it("names no web price and starts no Stripe checkout", () => {
    const shop = storeShop();
    for (const token of [
      "formatUsd(",
      "void buy(",
      "US cent",
      "Stripe",
      "sloga.gg",
      "Buy for",
      "bonus Prot",
      "Pay an exact amount",
      "Checkout open",
      "cents",
    ]) {
      assert.ok(!shop.includes(token), `StoreShop has ${token}`);
      assert.ok(!fold(shop).includes(token), `StoreShop has ${token}`);
    }
  });

  it("uses no <Status> (the checkout-notes pin takes the first in the file)", () => {
    assert.doesNotMatch(storeShop(), /<Status\b/);
  });

  it("leaves the Stripe Shop rendered once and renders StoreShop once", () => {
    storeShop();
    assert.equal((settings.match(/<Shop\b/g) ?? []).length, 1);
    assert.equal((settings.match(/<StoreShop\b/g) ?? []).length, 1);
    assert.ok(settings.includes("protPurchaseChannel("));
  });

  it("has no web-link code (E8)", () => {
    const shop = storeShop();
    for (const token of [
      "us_web_link",
      "href",
      "http:",
      "https:",
      "window.open",
      "openUrl",
      "openExternal",
      "checkoutHref",
      "postProtCheckout",
      "<a ",
      "<a\n",
    ]) {
      assert.ok(!shop.includes(token), `StoreShop has ${token}`);
    }
  });

  it("renders the iPhone honesty line (E2) on iOS only", () => {
    const shop = fold(storeShop());
    const line =
      "Protected channels open in Sloga for desktop and Android. On iPhone you can buy Prot and fund channels.";
    const at = shop.indexOf(line);
    assert.ok(at >= 0, "StoreShop renders the E2 line");
    const gate = shop.lastIndexOf("<Show when=", at);
    assert.ok(gate >= 0, "the E2 line is inside a <Show>");
    assert.ok(
      shop.slice(gate, at).includes('"appstore"'),
      'the E2 line is behind a <Show> naming "appstore"',
    );
  });

  it("takes outcomes from the worker, never from ledger rows (R30)", () => {
    const shop = storeShop();
    assert.ok(
      !shop.includes("purchasedSince("),
      "StoreShop has purchasedSince(",
    );
    assert.ok(
      !shop.includes("STORE_HANDOFF_SLACK_MS"),
      "StoreShop has STORE_HANDOFF_SLACK_MS",
    );
    assert.ok(shop.includes("protStoreOutcome("), "StoreShop reads the worker");
  });

  it("shows its own note for a purchase under review (R63)", () => {
    const shop = storeShop();
    const note =
      "This purchase is under review because it would take your Prot wallet over its limit. We'll add the Prot or help you get a refund.";
    assert.equal(fold(shop).split(note).length - 1, 1, "the note, once");
    const at = shop.indexOf('case "under_review":');
    assert.ok(at >= 0, 'StoreShop has case "under_review":');
    // No other case falls into it, and it falls into no other case
    assert.ok(shop.slice(0, at).trimEnd().endsWith(";"), "a case falls in");
    const ret = shop.indexOf("return ", at);
    assert.equal(
      shop
        .slice(at, ret)
        .replace(/\/\/[^\n]*/g, "")
        .trim(),
      'case "under_review":',
    );
    // Its return is the note itself, never the pending wait
    assert.ok(
      fold(shop.slice(ret)).startsWith(`return t\`${note}\`;`),
      "under_review returns the under-review note",
    );
  });

  it("notes a failed sheet only from its code (R31)", () => {
    const shop = storeShop();
    const calls = [...shop.matchAll(/setSheetNote\(/g)];
    assert.ok(calls.length > 0, "StoreShop has no setSheetNote(");
    for (const call of calls) {
      const open = call.index + call[0].length - 1;
      const arg = shop.slice(open + 1, closing(shop, open) - 1).trim();
      const viaCode =
        arg.startsWith("sheetFailureNote(") &&
        closing(arg, "sheetFailureNote".length) === arg.length;
      assert.ok(arg === "undefined" || viaCode, `setSheetNote(${arg})`);
    }
  });

  it("sends the native sheet message to the console only (R31)", () => {
    const shop = storeShop();
    assert.ok(
      shop.includes("result = await plugin.purchase("),
      "the sheet result is `result`",
    );
    for (const read of shop.matchAll(/\bresult\??\.message\b/g)) {
      assert.ok(
        inConsoleCall(shop, read.index) || inLogOnlyGuard(shop, read.index),
        `result.message read outside a console call at ${read.index}`,
      );
    }
  });
});

describe("store facts the page reads (source level)", () => {
  const settings = readFileSync(
    new URL("./ProtSettings.tsx", import.meta.url),
    "utf8",
  );
  const wallet = readFileSync(
    new URL("./protWallet.ts", import.meta.url),
    "utf8",
  );

  it("never reads the web-link flag in ProtSettings (E8)", () => {
    assert.ok(!settings.includes("us_web_link"));
  });

  it("reads store_preview only as a literal true", () => {
    for (const match of settings.matchAll(/store_preview/g)) {
      assert.match(
        settings.slice(match.index),
        /^store_preview\s*===\s*true/,
        "store_preview read without === true",
      );
    }
  });

  it("reads the web-link flag nowhere in protWallet.ts but its parser", () => {
    const start = wallet.indexOf("\nfunction parseProtStoreFeature(");
    const end = wallet.indexOf("\n}\n", start);
    assert.ok(start > 0 && end > start, "finds parseProtStoreFeature");
    const rest = wallet.slice(0, start) + wallet.slice(end);
    assert.equal(wallet.slice(start, end).split("us_web_link").length - 1, 2);
    assert.ok(!rest.includes("us_web_link"));
  });
});
