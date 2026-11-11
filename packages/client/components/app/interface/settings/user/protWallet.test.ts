/**
 * Run with:
 *
 *     node --conditions=browser --test components/app/interface/settings/user/protWallet.test.ts
 *
 * The decisions behind the Prot settings page (`./ProtSettings.tsx`), which
 * is a `.tsx` reaching lingui and `@revolt/ui` and so is loadable by no unit
 * runner. Each `describe` names the decision and what goes wrong without it:
 *
 * - parsing fails closed: a missing or malformed `features.prot` advert is
 *   everything off with no packs, and a `/@me` body whose balance cannot be
 *   read is a bad response, never a wallet of 0;
 * - pay-exact bounds are inclusive and never let 0 through, and the wallet
 *   cap allows reaching it exactly;
 * - amounts are grouped digits in the app locale, with no currency sign;
 * - the requests: `@me` and checkout hit the right routes, the checkout body
 *   names a pack or an exact amount (never both) and the return target, and
 *   only an https://checkout.stripe.com page is ever returned;
 * - the wallet controller never reads faster than every 2 s (or than a 429
 *   asked), polls every 5 s after a checkout until the balance rises or two
 *   minutes pass, and a restarted poll is still one poll;
 * - a late `ProtBalanceUpdate` never overrides a newer `/@me` read;
 * - the store gate (source level): packs, pay-exact and every price render
 *   only behind `allowsDonationLinks()` and `sales_open`, while balance, held
 *   and history render in every build.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import {
  type CipherApi,
  CipherClientError,
  MIN_REQUEST_GAP_MS,
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
} from "./cipherCheckout.ts";
import {
  type ProtFeature,
  type ProtMe,
  PROT_ENTRY_KINDS,
  PROT_INTENT_TTL_MS,
  createProtStanding,
  encodeProtIntent,
  exactAvailable,
  exactCentsProblem,
  fetchProtMe,
  formatLedgerTime,
  formatProt,
  formatProtDelta,
  isProtEntryKind,
  ledgerKindGroup,
  livePendingOrder,
  packBonus,
  parseExactInput,
  parseProtContext,
  parseProtFeature,
  parseProtMe,
  pendingChoice,
  postProtCheckout,
  protOfferAction,
  purchasedSince,
  readProtIntent,
  salesOffered,
  withBalanceUpdate,
  wouldExceedCap,
} from "./protWallet.ts";

const NOW = 1_800_000_000_000;

const PACKS = [
  { id: "p5", cents: 500, prot: 500 },
  { id: "p10", cents: 1000, prot: 1000 },
  { id: "p25", cents: 2500, prot: 2600 },
  { id: "p50", cents: 5000, prot: 5300 },
  { id: "p100", cents: 10000, prot: 11000 },
];

const ADVERT = {
  enabled: true,
  self_serve_enabled: false,
  sales_open: true,
  cipher_grants_enabled: true,
  packs: PACKS,
  exact_min_cents: 50,
  exact_max_cents: 50000,
  wallet_cap: 100000,
};

const feature = (patch: Partial<ProtFeature> = {}): ProtFeature => ({
  ...parseProtFeature(ADVERT),
  ...patch,
});

const wallet = (patch: Partial<ProtMe> = {}): ProtMe => ({
  balance: 0,
  held: 0,
  version: 0,
  recent: [],
  ...patch,
});

// ---------------------------------------------------------------------------
// A fake API: records every request and answers from a script
// ---------------------------------------------------------------------------

type FakeResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
};

function reply(status: number, body: unknown): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
  };
}

function badJson(): FakeResponse {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => {
      throw new SyntaxError("Unexpected token");
    },
  };
}

type Call = { url: string; init?: RequestInit };

function fakeApi(
  answer: (call: Call, index: number) => FakeResponse | Promise<FakeResponse>,
) {
  const calls: Call[] = [];
  const api: CipherApi = {
    apiBase: "https://api.test",
    headers: () => ({
      "X-Session-Token": "token",
      "Content-Type": "application/json",
    }),
    fetch: async (url, init) => {
      const call = { url, init };
      calls.push(call);
      return (await answer(call, calls.length - 1)) as unknown as Response;
    },
  };
  return { api, calls };
}

/** An answer the test releases by hand */
function deferred() {
  let resolve!: (value: FakeResponse) => void;
  const promise = new Promise<FakeResponse>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let pending promise chains run (setImmediate is not mocked) */
async function flush() {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const meBody = (balance: number, version: number, held = 0) => ({
  balance,
  held,
  version,
  recent: [],
});

// ---------------------------------------------------------------------------

describe("parseProtContext", () => {
  it("reads the checkout return and ignores everything else", () => {
    assert.deepEqual(parseProtContext({ page: "prot", checkout: "success" }), {
      page: "prot",
      checkout: "success",
    });
    assert.deepEqual(parseProtContext({ checkout: "cancel" }), {
      page: "prot",
      checkout: "cancel",
    });
    assert.deepEqual(parseProtContext({ checkout: "paid", extra: 1 }), {
      page: "prot",
    });
  });

  it("is an empty Prot context for anything that is not an object", () => {
    for (const value of [undefined, null, "prot", 5, true, ["success"]]) {
      assert.deepEqual(parseProtContext(value), { page: "prot" });
    }
  });
});

describe("parseProtFeature (fails closed)", () => {
  const closed: ProtFeature = {
    enabled: false,
    self_serve_enabled: false,
    sales_open: false,
    cipher_grants_enabled: false,
    packs: [],
    exact_min_cents: 0,
    exact_max_cents: 0,
    wallet_cap: 0,
  };

  it("is everything off with no packs when the advert is missing", () => {
    for (const value of [undefined, null, "on", 1, true, [], [ADVERT]]) {
      assert.deepEqual(parseProtFeature(value), closed);
    }
    assert.deepEqual(parseProtFeature({}), closed);
  });

  it("reads a well-formed advert as is", () => {
    assert.deepEqual(parseProtFeature(ADVERT), ADVERT);
  });

  it("turns a flag on only when it is literally true", () => {
    const parsed = parseProtFeature({
      ...ADVERT,
      enabled: "true",
      self_serve_enabled: 1,
      sales_open: "yes",
      cipher_grants_enabled: {},
    });
    assert.equal(parsed.enabled, false);
    assert.equal(parsed.self_serve_enabled, false);
    assert.equal(parsed.sales_open, false);
    assert.equal(parsed.cipher_grants_enabled, false);
  });

  it("drops malformed and repeated packs and keeps the rest in order", () => {
    const parsed = parseProtFeature({
      ...ADVERT,
      packs: [
        { id: "p5", cents: 500, prot: 500 },
        { id: "", cents: 500, prot: 500 },
        { id: "x".repeat(17), cents: 500, prot: 500 },
        { id: "zero", cents: 0, prot: 500 },
        { id: "neg", cents: 500, prot: -1 },
        { id: "frac", cents: 12.5, prot: 13 },
        { id: "str", cents: "500", prot: 500 },
        { id: 7, cents: 500, prot: 500 },
        null,
        "p10",
        { id: "p5", cents: 1, prot: 99999 },
        { id: "p25", cents: 2500, prot: 2600 },
      ],
    });
    assert.deepEqual(parsed.packs, [
      { id: "p5", cents: 500, prot: 500 },
      { id: "p25", cents: 2500, prot: 2600 },
    ]);
  });

  it("has no packs when `packs` is not a list", () => {
    assert.deepEqual(parseProtFeature({ ...ADVERT, packs: {} }).packs, []);
  });

  it("zeroes unreadable pay-exact bounds, so pay-exact is off", () => {
    for (const [min, max] of [
      [0, 50000],
      [50, 0],
      [-50, 50000],
      [50.5, 50000],
      [60000, 50000],
      ["50", 50000],
      [undefined, 50000],
    ]) {
      const parsed = parseProtFeature({
        ...ADVERT,
        exact_min_cents: min,
        exact_max_cents: max,
      });
      assert.equal(parsed.exact_min_cents, 0, `min ${min}, max ${max}`);
      assert.equal(parsed.exact_max_cents, 0, `min ${min}, max ${max}`);
      assert.equal(exactAvailable(parsed), false);
    }
    assert.equal(exactAvailable(parseProtFeature(ADVERT)), true);
  });

  it("reads an unreadable wallet cap as 0", () => {
    for (const cap of [-1, 1.5, "100000", undefined, null]) {
      assert.equal(
        parseProtFeature({ ...ADVERT, wallet_cap: cap }).wallet_cap,
        0,
      );
    }
  });
});

describe("parseProtMe", () => {
  it("throws badResponse for anything that is not an object", () => {
    for (const value of [undefined, null, "{}", 5, true, []]) {
      assert.throws(
        () => parseProtMe(value),
        (error: unknown) =>
          error instanceof CipherClientError && error.kind === "badResponse",
      );
    }
  });

  it("throws badResponse when the balance, held part or version is unreadable", () => {
    for (const body of [
      {},
      { held: 0, version: 1, recent: [] },
      { balance: -1, held: 0, version: 1, recent: [] },
      { balance: 1.5, held: 0, version: 1, recent: [] },
      { balance: "100", held: 0, version: 1, recent: [] },
      { balance: 100, version: 1, recent: [] },
      { balance: 100, held: -1, version: 1, recent: [] },
      { balance: 100, held: 0, recent: [] },
      { balance: 100, held: 0, version: -1, recent: [] },
      { balance: Number.MAX_SAFE_INTEGER + 1, held: 0, version: 1 },
    ]) {
      assert.throws(
        () => parseProtMe(body),
        (error: unknown) =>
          error instanceof CipherClientError && error.kind === "badResponse",
        JSON.stringify(body),
      );
    }
  });

  it("reads a full body", () => {
    const body = {
      balance: 3100,
      held: 2600,
      version: 4,
      pending_order: {
        order_id: "01ORDER",
        sku: { type: "ProtPack", pack: "p25", prot: 2600, cents: 2500 },
        expires_at: NOW + 60_000,
      },
      recent: [
        {
          id: "01B",
          kind: "Purchase",
          amount: 2600,
          created_at: NOW - 1000,
          order_id: "01ORDER0",
        },
        { id: "01A", kind: "AdminAdjust", amount: 500, created_at: NOW - 5000 },
      ],
    };
    assert.deepEqual(parseProtMe(body), body);
  });

  it("caps the held part at the balance", () => {
    assert.equal(parseProtMe(meBody(100, 1, 2600)).held, 100);
  });

  it("drops a pending order or history row it cannot read", () => {
    const me = parseProtMe({
      balance: 0,
      held: 0,
      version: 2,
      pending_order: {
        order_id: "x",
        sku: { type: "CipherNew" },
        expires_at: 1,
      },
      recent: [
        { id: "ok", kind: "Clawback", amount: 0, created_at: NOW },
        { id: "kind", kind: "Mystery", amount: 5, created_at: NOW },
        { id: "amount", kind: "Purchase", amount: 1.5, created_at: NOW },
        { id: "time", kind: "Purchase", amount: 5, created_at: "now" },
        { kind: "Purchase", amount: 5, created_at: NOW },
        null,
      ],
    });
    assert.equal(me.pending_order, undefined);
    assert.deepEqual(me.recent, [
      { id: "ok", kind: "Clawback", amount: 0, created_at: NOW },
    ]);
    assert.deepEqual(
      parseProtMe({ balance: 0, held: 0, version: 0, recent: "none" }).recent,
      [],
    );
  });

  it("reads a pay-exact pending order", () => {
    const me = parseProtMe({
      ...meBody(0, 0),
      pending_order: {
        order_id: "01X",
        sku: { type: "ProtExact", prot: 1234 },
        expires_at: NOW,
      },
    });
    assert.deepEqual(me.pending_order?.sku, { type: "ProtExact", prot: 1234 });
  });

  it("knows every ledger kind the server can send, and no other", () => {
    assert.equal(PROT_ENTRY_KINDS.length, 19);
    for (const kind of PROT_ENTRY_KINDS) assert.ok(isProtEntryKind(kind));
    assert.equal(isProtEntryKind("purchase"), false);
    assert.equal(isProtEntryKind(undefined), false);
  });
});

describe("pay-exact bounds and the wallet cap", () => {
  const f = feature();

  it("accepts both bounds and refuses one past either", () => {
    assert.equal(exactCentsProblem(50, f), undefined);
    assert.equal(exactCentsProblem(50000, f), undefined);
    assert.equal(exactCentsProblem(1234, f), undefined);
    assert.equal(exactCentsProblem(49, f), "belowMin");
    assert.equal(exactCentsProblem(50001, f), "aboveMax");
  });

  it("refuses anything that is not a whole number", () => {
    for (const cents of [12.5, Number.NaN, Infinity, -Infinity, 2 ** 60]) {
      assert.equal(exactCentsProblem(cents, f), "notInteger", String(cents));
    }
  });

  it("refuses every amount when the advert has no bounds, 0 included", () => {
    const closed = parseProtFeature(undefined);
    assert.equal(exactCentsProblem(0, closed), "belowMin");
    assert.equal(exactCentsProblem(-5, closed), "belowMin");
    assert.equal(exactCentsProblem(1, closed), "aboveMax");
    assert.equal(exactCentsProblem(50, closed), "aboveMax");
  });

  it("allows reaching the cap exactly, never passing it", () => {
    assert.equal(wouldExceedCap(97400, 2600, 100000), false);
    assert.equal(wouldExceedCap(97401, 2600, 100000), true);
    assert.equal(wouldExceedCap(0, 100000, 100000), false);
    assert.equal(wouldExceedCap(0, 100001, 100000), true);
  });

  it("counts an unknown cap or amount as over it", () => {
    assert.equal(wouldExceedCap(0, 1, 0), true);
    assert.equal(wouldExceedCap(Number.NaN, 1, 100000), true);
    assert.equal(wouldExceedCap(0, Number.NaN, 100000), true);
    assert.equal(wouldExceedCap(0, 1, Number.NaN), true);
  });

  it("reads the pay-exact entry as digits only", () => {
    assert.equal(parseExactInput(" 1234 "), 1234);
    assert.equal(parseExactInput("50"), 50);
    for (const text of ["", "12.5", "1,234", "-5", "1e3", "abc", "1 000"]) {
      assert.ok(Number.isNaN(parseExactInput(text)), text);
    }
  });

  it("computes the pack bonus", () => {
    assert.deepEqual(
      PACKS.map((pack) => packBonus(pack)),
      [0, 0, 100, 300, 1000],
    );
  });
});

describe("what the page offers", () => {
  it("offers sales only with donation links, Prot enabled and sales open", () => {
    assert.equal(salesOffered(feature(), true), true);
    assert.equal(salesOffered(feature(), false), false);
    assert.equal(salesOffered(feature({ sales_open: false }), true), false);
    assert.equal(salesOffered(feature({ enabled: false }), true), false);
    assert.equal(salesOffered(parseProtFeature(undefined), true), false);
  });

  const pendingPack = wallet({
    pending_order: {
      order_id: "01P",
      sku: { type: "ProtPack", pack: "p25", prot: 2600, cents: 2500 },
      expires_at: NOW + 60_000,
    },
  });

  it("resumes the open checkout's own choice and waits for the others", () => {
    const f = feature();
    assert.equal(
      protOfferAction({ pack: "p25" }, 2600, pendingPack, f, NOW),
      "resume",
    );
    assert.equal(
      protOfferAction({ pack: "p10" }, 1000, pendingPack, f, NOW),
      "waitForPending",
    );
    assert.equal(
      protOfferAction({ exactCents: 2500 }, 2500, pendingPack, f, NOW),
      "waitForPending",
    );
    assert.deepEqual(pendingChoice(pendingPack.pending_order!), {
      pack: "p25",
    });
  });

  it("frees every choice once the open checkout expires", () => {
    const later = NOW + 60_000;
    assert.equal(livePendingOrder(pendingPack, later), undefined);
    assert.equal(
      protOfferAction({ pack: "p10" }, 1000, pendingPack, feature(), later),
      "buy",
    );
  });

  it("matches a pay-exact checkout by amount", () => {
    const me = wallet({
      pending_order: {
        order_id: "01E",
        sku: { type: "ProtExact", prot: 1234 },
        expires_at: NOW + 1,
      },
    });
    assert.deepEqual(pendingChoice(me.pending_order!), { exactCents: 1234 });
    assert.equal(
      protOfferAction({ exactCents: 1234 }, 1234, me, feature(), NOW),
      "resume",
    );
    assert.equal(
      protOfferAction({ exactCents: 1235 }, 1235, me, feature(), NOW),
      "waitForPending",
    );
  });

  it("marks a purchase that would pass the cap", () => {
    const me = wallet({ balance: 98000 });
    assert.equal(
      protOfferAction({ pack: "p25" }, 2600, me, feature(), NOW),
      "overCap",
    );
    assert.equal(
      protOfferAction({ pack: "p10" }, 1000, me, feature(), NOW),
      "buy",
    );
    assert.equal(
      protOfferAction(
        { pack: "p5" },
        500,
        wallet(),
        feature({ wallet_cap: 0 }),
        NOW,
      ),
      "overCap",
    );
  });

  it("labels every ledger kind", () => {
    const groups = PROT_ENTRY_KINDS.map((kind) => ledgerKindGroup(kind));
    assert.equal(groups.length, 19);
    assert.equal(ledgerKindGroup("Purchase"), "purchase");
    assert.equal(ledgerKindGroup("CipherFounding"), "cipher");
    assert.equal(ledgerKindGroup("CipherUpgrade"), "cipher");
    assert.equal(ledgerKindGroup("Clawback"), "clawback");
    assert.equal(ledgerKindGroup("AdminAdjust"), "adjustment");
    assert.equal(ledgerKindGroup("Forfeit"), "forfeit");
    assert.equal(ledgerKindGroup("Settlement"), "returned");
  });

  it("finds a purchase credited since a point in time", () => {
    const me = wallet({
      recent: [
        { id: "a", kind: "Purchase", amount: 2600, created_at: NOW - 10 },
        { id: "b", kind: "CipherFounding", amount: 9, created_at: NOW },
      ],
    });
    assert.equal(purchasedSince(me, NOW - 10), true);
    assert.equal(purchasedSince(me, NOW - 9), false);
  });
});

describe("formatting", () => {
  it("groups digits in the app locale, with no currency sign", () => {
    assert.equal(formatProt(2600, "en"), "2,600");
    assert.equal(formatProt(100000, "en"), "100,000");
    assert.equal(formatProt(0, "en"), "0");
    assert.equal(formatProt(2600, "de"), "2.600");
    assert.equal(formatProt(2600, "pt_BR"), "2.600");
    assert.equal(formatProt(2600, undefined), "2,600");
    assert.doesNotMatch(formatProt(2600, "en"), /[$¢]/);
  });

  it("falls back to English for a locale Intl rejects", () => {
    assert.equal(formatProt(2600, "not a locale!"), "2,600");
  });

  it("shows whole Prot only", () => {
    assert.equal(formatProt(12.6, "en"), "13");
  });

  it("signs history amounts", () => {
    assert.equal(formatProtDelta(2600, "en"), "+2,600");
    assert.equal(formatProtDelta(-500, "en"), "-500");
    assert.equal(formatProtDelta(0, "en"), "0");
  });

  it("formats history times in the app locale", () => {
    const en = formatLedgerTime(NOW, "en");
    assert.match(en, /2027/);
    assert.equal(formatLedgerTime(NOW, "not a locale!"), en);
  });
});

describe("checkout intent", () => {
  const intent = { user: "U1", balance: 500, at: NOW - 1000 };

  it("round-trips for the same account while fresh", () => {
    assert.deepEqual(
      readProtIntent(encodeProtIntent(intent), "U1", NOW),
      intent,
    );
  });

  it("is dropped for another account, when stale, or when malformed", () => {
    const raw = encodeProtIntent(intent);
    assert.equal(readProtIntent(raw, "U2", NOW), undefined);
    assert.equal(readProtIntent(raw, undefined, NOW), undefined);
    assert.equal(
      readProtIntent(raw, "U1", intent.at + PROT_INTENT_TTL_MS + 1),
      undefined,
    );
    assert.equal(readProtIntent(raw, "U1", intent.at - 1), undefined);
    assert.equal(readProtIntent("{", "U1", NOW), undefined);
    assert.equal(readProtIntent(null, "U1", NOW), undefined);
    assert.equal(
      readProtIntent(JSON.stringify({ ...intent, balance: -1 }), "U1", NOW),
      undefined,
    );
  });
});

describe("requests", () => {
  it("reads the wallet from GET /payments/prot/@me with the session", async () => {
    const { api, calls } = fakeApi(() => reply(200, meBody(700, 3)));
    const me = await fetchProtMe(api);
    assert.deepEqual(me, wallet({ balance: 700, version: 3 }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.test/payments/prot/@me");
    assert.equal(calls[0].init?.method, undefined);
    assert.deepEqual(calls[0].init?.headers, api.headers());
  });

  it("throws the API's error body, a 429 as rateLimited, and bad JSON as badResponse", async () => {
    const disabled = fakeApi(() => reply(404, { type: "ProtDisabled" }));
    await assert.rejects(fetchProtMe(disabled.api), { type: "ProtDisabled" });

    const limited = fakeApi(() => reply(429, { retry_after: 4000 }));
    await assert.rejects(
      fetchProtMe(limited.api),
      (error: unknown) =>
        error instanceof CipherClientError &&
        error.kind === "rateLimited" &&
        error.retryAfterMs === 4000,
    );

    const garbled = fakeApi(() => badJson());
    await assert.rejects(
      fetchProtMe(garbled.api),
      (error: unknown) =>
        error instanceof CipherClientError && error.kind === "badResponse",
    );
  });

  it("posts a pack checkout with the web return", async () => {
    const { api, calls } = fakeApi(() =>
      reply(200, { url: "https://checkout.stripe.com/c/pay/cs_test_1" }),
    );
    const url = await postProtCheckout(api, { pack: "p25" }, false);
    assert.equal(url, "https://checkout.stripe.com/c/pay/cs_test_1");
    assert.equal(calls[0].url, "https://api.test/payments/prot/checkout");
    assert.equal(calls[0].init?.method, "POST");
    assert.deepEqual(calls[0].init?.headers, api.headers());
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      pack: "p25",
      return_to: "web",
    });
  });

  it("posts a pay-exact checkout with the shell return, never both choices", async () => {
    const { api, calls } = fakeApi(() =>
      reply(200, { url: "https://checkout.stripe.com/c/pay/cs_test_2" }),
    );
    await postProtCheckout(api, { exactCents: 1234 }, true);
    const body = JSON.parse(String(calls[0].init?.body));
    assert.deepEqual(body, { exact_cents: 1234, return_to: "shell" });
    assert.equal("pack" in body, false);
  });

  it("returns the checked page only", async () => {
    const { api } = fakeApi(() =>
      reply(200, { url: "https://checkout.stripe.com/c/pay/cs#frag" }),
    );
    assert.equal(
      await postProtCheckout(api, { pack: "p5" }, false),
      "https://checkout.stripe.com/c/pay/cs#frag",
    );
  });

  it("refuses any page that is not https://checkout.stripe.com", async () => {
    for (const url of [
      "http://checkout.stripe.com/c/pay/cs",
      "https://checkout.stripe.com.evil.com/c",
      "https://checkout.stripe.com@evil.com/c",
      "https://x@checkout.stripe.com/c",
      "https://checkout.stripe.com:444/c",
      "https://evil.com/?checkout.stripe.com",
      "javascript:alert(1)",
      "",
      undefined,
      42,
    ]) {
      const { api } = fakeApi(() => reply(200, { url }));
      await assert.rejects(
        postProtCheckout(api, { pack: "p5" }, false),
        (error: unknown) =>
          error instanceof CipherClientError && error.kind === "badResponse",
        String(url),
      );
    }
    const garbled = fakeApi(() => badJson());
    await assert.rejects(
      postProtCheckout(garbled.api, { pack: "p5" }, false),
      (error: unknown) =>
        error instanceof CipherClientError && error.kind === "badResponse",
    );
  });

  it("throws the API's error body for a refused checkout", async () => {
    const { api } = fakeApi(() =>
      reply(400, { type: "ProtWalletCap", max: 100000 }),
    );
    await assert.rejects(postProtCheckout(api, { pack: "p100" }, false), {
      type: "ProtWalletCap",
      max: 100000,
    });
  });
});

describe("createProtStanding", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  const nowMs = () => Date.now();

  it("reuses the Cipher request budget", () => {
    assert.equal(MIN_REQUEST_GAP_MS, 2000);
    assert.equal(POLL_INTERVAL_MS, 5000);
    assert.equal(POLL_TIMEOUT_MS, 120_000);
  });

  it("starts empty and idle, and loads the wallet on refresh", async () => {
    const { api, calls } = fakeApi(() => reply(200, meBody(500, 2)));
    const standing = createProtStanding({ api, nowMs });
    assert.equal(standing.me(), undefined);
    assert.equal(standing.error(), undefined);
    assert.equal(standing.phase(), "idle");
    assert.equal(calls.length, 0);

    await standing.refresh();
    assert.equal(calls.length, 1);
    assert.deepEqual(standing.me(), wallet({ balance: 500, version: 2 }));
    assert.equal(standing.phase(), "idle");
    standing.dispose();
  });

  it("keeps the last wallet when a read fails, and clears the error on the next good one", async () => {
    const { api } = fakeApi((_call, index) =>
      index === 1
        ? reply(500, { type: "InternalError" })
        : reply(200, meBody(100 + index, index)),
    );
    const standing = createProtStanding({ api, nowMs });

    await standing.refresh();
    assert.equal(standing.me()?.balance, 100);

    const failing = standing.refresh();
    mock.timers.tick(MIN_REQUEST_GAP_MS);
    await flush();
    await failing;
    assert.equal(standing.me()?.balance, 100);
    assert.deepEqual(standing.error(), { type: "InternalError" });

    const recovering = standing.refresh();
    mock.timers.tick(MIN_REQUEST_GAP_MS);
    await flush();
    await recovering;
    assert.equal(standing.me()?.balance, 102);
    assert.equal(standing.error(), undefined);
    standing.dispose();
  });

  it("sets an error and no wallet when the first read is malformed", async () => {
    const { api } = fakeApi(() => reply(200, { balance: "lots" }));
    const standing = createProtStanding({ api, nowMs });
    await standing.refresh();
    assert.equal(standing.me(), undefined);
    const error = standing.error();
    assert.ok(error instanceof CipherClientError);
    assert.equal(error.kind, "badResponse");
    standing.dispose();
  });

  it("never reads faster than every 2 s, and refreshes asked together share one read", async () => {
    const { api, calls } = fakeApi(() => reply(200, meBody(1, 1)));
    const standing = createProtStanding({ api, nowMs });
    await standing.refresh();
    assert.equal(calls.length, 1);

    const waits = [standing.refresh(), standing.refresh(), standing.refresh()];
    await flush();
    assert.equal(calls.length, 1);

    mock.timers.tick(MIN_REQUEST_GAP_MS - 1);
    await flush();
    assert.equal(calls.length, 1);

    mock.timers.tick(1);
    await flush();
    await Promise.all(waits);
    assert.equal(calls.length, 2);
    standing.dispose();
  });

  it("asks again after a read that was in flight when refresh was called", async () => {
    const first = deferred();
    const { api, calls } = fakeApi((_call, index) =>
      index === 0 ? first.promise : reply(200, meBody(9, 9)),
    );
    const standing = createProtStanding({ api, nowMs });

    const initial = standing.refresh();
    await flush();
    const later = standing.refresh();
    assert.equal(calls.length, 1);

    first.resolve(reply(200, meBody(1, 1)));
    await initial;
    assert.equal(standing.me()?.balance, 1);

    mock.timers.tick(MIN_REQUEST_GAP_MS);
    await flush();
    await later;
    assert.equal(calls.length, 2);
    assert.equal(standing.me()?.balance, 9);
    standing.dispose();
  });

  it("holds reads off for a 429's retry_after", async () => {
    const { api, calls } = fakeApi((_call, index) =>
      index === 0
        ? reply(429, { retry_after: 7000 })
        : reply(200, meBody(1, 1)),
    );
    const standing = createProtStanding({ api, nowMs });
    await standing.refresh();
    const error = standing.error();
    assert.ok(error instanceof CipherClientError);
    assert.equal(error.kind, "rateLimited");

    const again = standing.refresh();
    mock.timers.tick(6999);
    await flush();
    assert.equal(calls.length, 1);
    mock.timers.tick(1);
    await flush();
    await again;
    assert.equal(calls.length, 2);
    assert.equal(standing.error(), undefined);
    standing.dispose();
  });

  it("polls every 5 s after a checkout and confirms once the balance rises", async () => {
    const balances = [100, 100, 2700];
    const { api, calls } = fakeApi((_call, index) =>
      reply(200, meBody(balances[Math.min(index, 2)], index)),
    );
    const standing = createProtStanding({ api, nowMs });

    standing.pollAfterCheckout(100);
    assert.equal(standing.phase(), "polling");
    await flush();
    assert.equal(calls.length, 1);

    mock.timers.tick(POLL_INTERVAL_MS - 1);
    await flush();
    assert.equal(calls.length, 1);
    mock.timers.tick(1);
    await flush();
    assert.equal(calls.length, 2);
    assert.equal(standing.phase(), "polling");

    mock.timers.tick(POLL_INTERVAL_MS);
    await flush();
    assert.equal(calls.length, 3);
    assert.equal(standing.phase(), "confirmed");
    assert.equal(standing.me()?.balance, 2700);

    mock.timers.tick(POLL_TIMEOUT_MS);
    await flush();
    assert.equal(calls.length, 3);
    standing.dispose();
  });

  it("does not confirm on a balance equal to the baseline", async () => {
    const { api } = fakeApi(() => reply(200, meBody(100, 1)));
    const standing = createProtStanding({ api, nowMs });
    standing.pollAfterCheckout(100);
    await flush();
    assert.equal(standing.phase(), "polling");
    standing.dispose();
  });

  it("gives up after two minutes, never spending more than half the bucket", async () => {
    const reads: number[] = [];
    const { api, calls } = fakeApi(() => {
      reads.push(Date.now());
      return reply(200, meBody(100, 1));
    });
    const standing = createProtStanding({ api, nowMs });

    standing.pollAfterCheckout(100);
    await flush();
    for (let elapsed = 0; elapsed < POLL_TIMEOUT_MS + 30_000; elapsed += 1000) {
      mock.timers.tick(1000);
      await flush();
    }
    assert.equal(standing.phase(), "timedOut");
    assert.equal(calls.length, POLL_TIMEOUT_MS / POLL_INTERVAL_MS + 1);
    for (const at of reads) {
      const inWindow = reads.filter((t) => t >= at && t < at + 10_000);
      assert.ok(inWindow.length <= 5, `${inWindow.length} reads in 10 s`);
    }

    mock.timers.tick(POLL_TIMEOUT_MS);
    await flush();
    assert.equal(calls.length, POLL_TIMEOUT_MS / POLL_INTERVAL_MS + 1);
    standing.dispose();
  });

  it("keeps polling through failed reads", async () => {
    const { api } = fakeApi((_call, index) =>
      index < 2
        ? reply(503, { type: "InternalError" })
        : reply(200, meBody(900, 5)),
    );
    const standing = createProtStanding({ api, nowMs });
    standing.pollAfterCheckout(0);
    await flush();
    assert.equal(standing.phase(), "polling");
    mock.timers.tick(POLL_INTERVAL_MS);
    await flush();
    assert.equal(standing.phase(), "polling");
    mock.timers.tick(POLL_INTERVAL_MS);
    await flush();
    assert.equal(standing.phase(), "confirmed");
    assert.equal(standing.error(), undefined);
    standing.dispose();
  });

  it("is still one poll when restarted, and a restart resets the two minutes", async () => {
    const { api, calls } = fakeApi(() => reply(200, meBody(100, 1)));
    const standing = createProtStanding({ api, nowMs });

    standing.pollAfterCheckout(100);
    standing.pollAfterCheckout(100);
    await flush();
    assert.equal(calls.length, 1);

    mock.timers.tick(POLL_INTERVAL_MS);
    await flush();
    standing.pollAfterCheckout(100);
    await flush();
    // The restart's read waits out the 2 s gap and replaces the 5 s timer
    assert.equal(calls.length, 2);
    mock.timers.tick(MIN_REQUEST_GAP_MS);
    await flush();
    assert.equal(calls.length, 3);
    mock.timers.tick(POLL_INTERVAL_MS - 1);
    await flush();
    assert.equal(calls.length, 3);
    mock.timers.tick(1);
    await flush();
    assert.equal(calls.length, 4);

    // Past the first poll's deadline (120 s) and before the restarted one's
    // (125 s), it is still running
    for (let i = 0; i < 22; i++) {
      mock.timers.tick(POLL_INTERVAL_MS);
      await flush();
    }
    assert.equal(standing.phase(), "polling");
    standing.dispose();
  });

  it("judges a read already in flight against the new poll's baseline", async () => {
    const first = deferred();
    const { api, calls } = fakeApi((_call, index) =>
      index === 0 ? first.promise : reply(200, meBody(100, 2)),
    );
    const standing = createProtStanding({ api, nowMs });
    void standing.refresh();
    await flush();
    standing.pollAfterCheckout(50);
    assert.equal(calls.length, 1);

    first.resolve(reply(200, meBody(100, 1)));
    await flush();
    assert.equal(standing.phase(), "confirmed");
    assert.equal(calls.length, 1);
    standing.dispose();
  });

  it("stops polling and settles waiting refreshes when disposed", async () => {
    const { api, calls } = fakeApi(() => reply(200, meBody(1, 1)));
    const standing = createProtStanding({ api, nowMs });
    standing.pollAfterCheckout(100);
    await flush();
    const waiting = standing.refresh();
    standing.dispose();
    await waiting;

    mock.timers.tick(POLL_TIMEOUT_MS);
    await flush();
    assert.equal(calls.length, 1);
    await standing.refresh();
    standing.pollAfterCheckout(0);
    await flush();
    assert.equal(calls.length, 1);
  });

  it("ignores a read that lands after dispose", async () => {
    const first = deferred();
    const { api } = fakeApi(() => first.promise);
    const standing = createProtStanding({ api, nowMs });
    const read = standing.refresh();
    await flush();
    standing.dispose();
    first.resolve(reply(200, meBody(5, 5)));
    await read;
    await flush();
    assert.equal(standing.me(), undefined);
  });
});

describe("ProtBalanceUpdate against /@me", () => {
  const read = wallet({ balance: 900, held: 600, version: 7 });

  it("lays a newer update over the read", () => {
    assert.deepEqual(withBalanceUpdate(read, { balance: 1200, version: 8 }), {
      ...read,
      balance: 1200,
      version: 8,
    });
  });

  it("drops an update that is not newer than the read", () => {
    assert.equal(withBalanceUpdate(read, { balance: 500, version: 6 }), read);
    assert.equal(withBalanceUpdate(read, { balance: 500, version: 7 }), read);
  });

  it("keeps the held part within a lower balance", () => {
    assert.equal(
      withBalanceUpdate(read, { balance: 400, version: 8 })?.held,
      400,
    );
  });

  it("drops a malformed update, and shows nothing without a read", () => {
    assert.equal(withBalanceUpdate(read, { balance: -1, version: 99 }), read);
    assert.equal(withBalanceUpdate(read, { balance: 1, version: 1.5 }), read);
    assert.equal(
      withBalanceUpdate(undefined, { balance: 1, version: 99 }),
      undefined,
    );
    assert.equal(withBalanceUpdate(read, undefined), read);
  });

  it("a /@me read newer than a late event wins", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
    try {
      const versions = [7, 9];
      const balances = [900, 1000];
      const { api } = fakeApi((_call, index) =>
        reply(200, meBody(balances[index], versions[index])),
      );
      const standing = createProtStanding({ api, nowMs: () => Date.now() });
      await standing.refresh();

      // The event for version 8 arrives, then the read for version 9
      const event = { balance: 1200, version: 8 };
      assert.equal(withBalanceUpdate(standing.me(), event)?.balance, 1200);

      const next = standing.refresh();
      mock.timers.tick(MIN_REQUEST_GAP_MS);
      await flush();
      await next;
      const shown = withBalanceUpdate(standing.me(), event);
      assert.equal(shown?.balance, 1000);
      assert.equal(shown?.version, 9);
      standing.dispose();
    } finally {
      mock.timers.reset();
    }
  });
});

describe("store gate (source level)", () => {
  const source = readFileSync(
    new URL("./ProtSettings.tsx", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("\n  function Shop(");
  const end = source.indexOf("\n  }\n", start);
  const shop = source.slice(start, end);
  const rest = source.slice(0, start) + source.slice(end);

  it("finds the Shop component", () => {
    assert.ok(start > 0 && end > start);
  });

  it("offers sales only through salesOffered(feature(), allowsDonationLinks())", () => {
    assert.match(
      source,
      /const offered = \(\) => salesOffered\(feature\(\), allowsDonationLinks\(\)\);/,
    );
    assert.equal((source.match(/<Shop\b/g) ?? []).length, 1);
    assert.match(source, /<Show when=\{offered\(\)\}>\s*<Shop /);
  });

  it("names prices and starts purchases only inside Shop", () => {
    for (const token of [
      "formatUsd(",
      "void buy(",
      "US cent",
      "Stripe's secure checkout",
      "Buy for",
      "bonus Prot",
      "Pay an exact amount",
      "Checkout open",
    ]) {
      assert.ok(shop.includes(token), `Shop has ${token}`);
      assert.ok(!rest.includes(token), `${token} outside Shop`);
    }
  });

  it("shows the checkout notes only where checkout is linked to", () => {
    const notes = source.indexOf("<Status ");
    const gate = source.lastIndexOf(
      "<Show when={allowsDonationLinks()}>",
      notes,
    );
    assert.ok(gate > 0 && notes - gate < 80);
  });

  it("renders balance, held and history in every build", () => {
    for (const token of [
      "protAmount(me().balance)",
      "heldLine(me().held)",
      "<For each={me().recent}>",
    ]) {
      assert.ok(rest.includes(token), token);
    }
  });

  it("keys the wallet off the client config, never a build flag", () => {
    assert.match(source, /configuration\?\.features as \{ prot\?: unknown \}/);
    assert.doesNotMatch(source, /VITE_CFG/);
  });

  it("styles only string tags", () => {
    assert.doesNotMatch(source, /styled\([A-Z]/);
  });
});
