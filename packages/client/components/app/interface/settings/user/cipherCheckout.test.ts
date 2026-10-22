/**
 * Run with:
 *
 *     node --conditions=browser --test components/app/interface/settings/user/cipherCheckout.test.ts
 *
 * The decisions behind the Cipher settings page (`./CipherSettings.tsx`),
 * which is a `.tsx` reaching `solid-js`, lingui and `@revolt/ui` and so is
 * loadable by no unit runner. Each `describe` names the decision and what
 * goes wrong without it:
 *
 * - offers: never the same tier or a downgrade, and an upgrade charges the
 *   difference (the server refuses the rest, but the page must not offer it);
 * - the checkout request names a tier and a return target only, only ever
 *   opens https://checkout.stripe.com, and a shell never navigates its own
 *   window to Stripe;
 * - the standing controller: the poll after checkout (every 5 s) stops when
 *   the tier it waits for arrives or after two minutes, a quiet poll never
 *   says it is confirming anything (and, while this tab's intent is stored,
 *   outlasts a paid order until its tier arrives), a restarted poll is still
 *   one poll, no
 *   burst of reads spends more than half the `payments_me` bucket (10 per
 *   10 s), and a buy is never starved by the poll: reads pause while the
 *   checkout request runs and for 1 s after, and a 429 is retried once;
 * - prices and times follow the app locale;
 * - the store gate (source level): the `cipher` settings row and page sit
 *   behind `allowsDonationLinks()`, so Play and App Store builds never list
 *   or render it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  type CipherApi,
  type CipherMe,
  type CipherOffer,
  type CipherTier,
  type StandingState,
  CHECKOUT_HOSTS,
  CHECKOUT_PAUSE_MS,
  CHECKOUT_RETRY_MAX_MS,
  CipherClientError,
  INTENT_TTL_MS,
  MIN_REQUEST_GAP_MS,
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  checkoutHref,
  checkoutReturnTo,
  checkoutSettled,
  cipherOffers,
  createCipherStanding,
  encodeIntent,
  fetchCipherMe,
  fetchCipherStats,
  formatCipherNumber,
  formatShortTime,
  formatUsd,
  isCheckoutUrl,
  livePending,
  mountPollMode,
  offerAction,
  openCheckout,
  pageOffers,
  parseCipherContext,
  parseCipherMe,
  parseCipherStats,
  parseUserCipher,
  pollBaselineOf,
  pollNote,
  postCheckout,
  readIntent,
  saleStatus,
  thankedMembership,
  tierRank,
} from "./cipherCheckout.ts";

const NOW = 1_800_000_000_000;

const member = (tier: "T99" | "T149" | "T299", disputed = false): CipherMe => ({
  membership: { number: 42, tier, disputed, prot_grant: 16_500 },
});

describe("offers: never the same tier or a downgrade; upgrades charge the difference", () => {
  it("a non-member is offered all three tiers at list price", () => {
    assert.deepEqual(
      cipherOffers(undefined).map((o) => [o.tier, o.kind, o.cents, o.prot]),
      [
        ["T99", "new", 9900, 16_500],
        ["T149", "new", 14900, 33_000],
        ["T299", "new", 29900, 75_000],
      ],
    );
  });

  it("a $99 member is offered $149 for $50 and $299 for $200", () => {
    assert.deepEqual(
      cipherOffers("T99").map((o) => [o.tier, o.kind, o.cents]),
      [
        ["T149", "upgrade", 5000],
        ["T299", "upgrade", 20000],
      ],
    );
  });

  it("a $149 member is offered $299 for $150", () => {
    assert.deepEqual(
      cipherOffers("T149").map((o) => [o.tier, o.kind, o.cents]),
      [["T299", "upgrade", 15000]],
    );
  });

  it("a $299 member is offered nothing", () => {
    assert.deepEqual(cipherOffers("T299"), []);
  });

  it("no offer is ever at or below the current tier", () => {
    for (const current of ["T99", "T149", "T299"] as const) {
      for (const offer of cipherOffers(current)) {
        assert.ok(
          tierRank(offer.tier) > tierRank(current),
          `${current} offered ${offer.tier}`,
        );
        assert.ok(offer.cents > 0, `${current} → ${offer.tier} is free`);
      }
    }
  });

  it("nothing is offered while a payment is disputed", () => {
    assert.deepEqual(pageOffers(member("T99", true)), []);
    assert.equal(pageOffers(member("T99")).length, 2);
    assert.equal(pageOffers({}).length, 3);
  });
});

describe("offer actions follow the open checkout and the sale", () => {
  const offers = cipherOffers(undefined);
  const t149 = offers[1] as CipherOffer;
  const pending = (tier: "T99" | "T149", expires_at = NOW + 60_000) =>
    ({
      pending: {
        order_id: "o1",
        sku: { type: "CipherNew", tier },
        expires_at,
      },
    }) satisfies CipherMe;

  it("closed sales refuse everything, an open checkout included", () => {
    assert.equal(offerAction(t149, pending("T149"), "closed", NOW), "closed");
    assert.equal(offerAction(t149, {}, "closed", NOW), "closed");
  });

  it("the tier already in checkout resumes; another tier waits for it", () => {
    assert.equal(offerAction(t149, pending("T149"), "open", NOW), "resume");
    assert.equal(
      offerAction(t149, pending("T99"), "open", NOW),
      "waitForPending",
    );
  });

  it("an expired checkout no longer blocks anything", () => {
    const expired = pending("T99", NOW - 1);
    assert.equal(livePending(expired, NOW), undefined);
    assert.equal(offerAction(t149, expired, "open", NOW), "buy");
  });

  it("an upgrade resumes by its target tier", () => {
    const me: CipherMe = {
      ...member("T99"),
      pending: {
        order_id: "o2",
        sku: { type: "CipherUpgrade", from: "T99", to: "T299" },
        expires_at: NOW + 60_000,
      },
    };
    const [up149, up299] = pageOffers(me) as [CipherOffer, CipherOffer];
    assert.equal(offerAction(up299, me, "open", NOW), "resume");
    assert.equal(offerAction(up149, me, "open", NOW), "waitForPending");
  });

  it("sold out stops new memberships but not upgrades", () => {
    assert.equal(offerAction(t149, {}, "soldOut", NOW), "soldOut");
    const [up149] = pageOffers(member("T99")) as [CipherOffer];
    assert.equal(offerAction(up149, member("T99"), "soldOut", NOW), "buy");
  });

  it("an unknown sale offers everything and leaves it to the server", () => {
    assert.equal(saleStatus(undefined), undefined);
    assert.equal(offerAction(t149, {}, undefined, NOW), "buy");
  });

  it("the counter maps to closed, sold out or open", () => {
    assert.equal(saleStatus({ claimed: 1, cap: 1000, open: false }), "closed");
    assert.equal(
      saleStatus({ claimed: 1000, cap: 1000, open: true }),
      "soldOut",
    );
    assert.equal(saleStatus({ claimed: 999, cap: 1000, open: true }), "open");
  });
});

describe("parsing keeps only what the page understands", () => {
  it("formats the badge number to four digits", () => {
    assert.equal(formatCipherNumber(42), "#0042");
    assert.equal(formatCipherNumber(1), "#0001");
    assert.equal(formatCipherNumber(1000), "#1000");
  });

  it("reads User.cipher, or nothing when it is malformed", () => {
    assert.deepEqual(parseUserCipher({ number: 7, tier: "T149" }), {
      number: 7,
      tier: "T149",
    });
    for (const bad of [
      undefined,
      null,
      "T99",
      { number: 0, tier: "T99" },
      { number: 1.5, tier: "T99" },
      { number: "7", tier: "T99" },
      { number: 7, tier: "T500" },
    ]) {
      assert.equal(parseUserCipher(bad), undefined, JSON.stringify(bad));
    }
  });

  it("reads @me, dropping a part it cannot read", () => {
    assert.deepEqual(
      parseCipherMe({
        membership: {
          number: 3,
          tier: "T299",
          disputed: true,
          prot_grant: 75000,
        },
        pending: {
          order_id: "o",
          sku: { type: "CipherNew", tier: "T99" },
          expires_at: NOW,
        },
      }),
      {
        membership: {
          number: 3,
          tier: "T299",
          disputed: true,
          prot_grant: 75000,
        },
        pending: {
          order_id: "o",
          sku: { type: "CipherNew", tier: "T99" },
          expires_at: NOW,
        },
      },
    );
    assert.deepEqual(
      parseCipherMe({ membership: { number: 3, tier: "X" } }),
      {},
    );
    assert.deepEqual(
      parseCipherMe({
        pending: { order_id: "o", sku: { type: "Prot" }, expires_at: NOW },
      }),
      {},
    );
    // `disputed` is only ever true when the server says exactly true
    assert.equal(
      parseCipherMe({ membership: { number: 3, tier: "T99", disputed: "yes" } })
        .membership?.disputed,
      false,
    );
    assert.deepEqual(parseCipherMe(null), {});
  });

  it("reads the counter, or nothing", () => {
    assert.deepEqual(parseCipherStats({ claimed: 5, cap: 1000, open: true }), {
      claimed: 5,
      cap: 1000,
      open: true,
      closes_at: undefined,
    });
    assert.equal(parseCipherStats({ claimed: 5, open: true }), undefined);
  });

  it("reads the settings context, ignoring anything else", () => {
    assert.deepEqual(
      parseCipherContext({ page: "cipher", tier: "T149", checkout: "success" }),
      { tier: "T149", checkout: "success" },
    );
    assert.deepEqual(
      parseCipherContext({ page: "cipher", tier: "T1", checkout: "paid" }),
      { tier: undefined, checkout: undefined },
    );
    assert.deepEqual(parseCipherContext(undefined), {});
  });
});

describe("checkout: names a tier and a return target, opens safely", () => {
  type Call = { url: string; init?: RequestInit };

  function api(reply: () => Response): CipherApi & { calls: Call[] } {
    const calls: Call[] = [];
    return {
      calls,
      apiBase: "https://app.sloga.gg/api",
      headers: () => ({
        "X-Session-Token": "tok",
        "Content-Type": "application/json",
      }),
      fetch: (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(reply());
      },
    };
  }

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  it("posts only the tier and where to return, with the session headers", async () => {
    const web = api(() =>
      json(200, { url: "https://checkout.stripe.com/c/pay/cs_1" }),
    );
    assert.equal(
      await postCheckout(web, "T149", false),
      "https://checkout.stripe.com/c/pay/cs_1",
    );
    const [call] = web.calls as [Call];
    assert.equal(call.url, "https://app.sloga.gg/api/payments/cipher/checkout");
    assert.equal(call.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(call.init?.body)), {
      tier: "T149",
      return_to: "web",
    });
    assert.equal(
      (call.init?.headers as Record<string, string>)["X-Session-Token"],
      "tok",
    );

    const shell = api(() =>
      json(200, { url: "https://checkout.stripe.com/x" }),
    );
    await postCheckout(shell, "T299", true);
    assert.deepEqual(JSON.parse(String(shell.calls[0]?.init?.body)), {
      tier: "T299",
      return_to: "shell",
    });
    assert.equal(checkoutReturnTo(true), "shell");
    assert.equal(checkoutReturnTo(false), "web");
  });

  it("passes an API error body through for translation", async () => {
    const sold = api(() => json(409, { type: "CipherSoldOut" }));
    await assert.rejects(postCheckout(sold, "T99", false), (error) => {
      assert.deepEqual(error, { type: "CipherSoldOut" });
      return true;
    });
  });

  it("a region refusal reaches the page as its own message", async () => {
    // The 400 body is passed through untouched, so `describe` hands it to
    // `useError` rather than reading it as a CipherClientError
    const region = api(() => json(400, { type: "CipherRegionUnavailable" }));
    await assert.rejects(postCheckout(region, "T99", false), (error) => {
      assert.ok(!(error instanceof CipherClientError));
      assert.deepEqual(error, { type: "CipherRegionUnavailable" });
      return true;
    });

    // ... and `useError` maps it on the string chain, ahead of the typed
    // switch (stoat-api's union does not carry it), to copy of its own
    const errors = readFileSync(
      new URL("../../../../i18n/errors.ts", import.meta.url),
      "utf8",
    );
    const copy = "Ciphers aren't on sale in your country yet.";
    const mapped = errors.match(
      /if \(errType === "CipherRegionUnavailable"\)\s*return t`([^`]*)`;/,
    );
    assert.equal(mapped?.[1], copy);
    assert.ok(
      errors.indexOf('"CipherRegionUnavailable"') <
        errors.indexOf("switch (err.type)"),
    );
    // A msgid missing from the catalog renders as its hash
    const en = readFileSync(
      new URL("../../../../i18n/catalogs/en/messages.po", import.meta.url),
      "utf8",
    );
    assert.ok(en.includes(`msgid "${copy}"\nmsgstr "${copy}"\n`));
  });

  it("turns a 429 into a rate-limit error carrying its wait", async () => {
    const limited = api(() => json(429, { retry_after: 4200 }));
    await assert.rejects(postCheckout(limited, "T99", false), (error) => {
      assert.ok(error instanceof CipherClientError);
      assert.equal(error.kind, "rateLimited");
      assert.equal(error.retryAfterMs, 4200);
      return true;
    });
    const bare = api(() => new Response("", { status: 429 }));
    await assert.rejects(fetchCipherMe(bare), (error) => {
      assert.ok(error instanceof CipherClientError);
      assert.equal(error.retryAfterMs, 10_000);
      return true;
    });
  });

  it("opens a Stripe checkout page", () => {
    assert.deepEqual([...CHECKOUT_HOSTS], ["checkout.stripe.com"]);
    assert.equal(isCheckoutUrl("https://checkout.stripe.com/c/pay/cs_1"), true);
    assert.equal(isCheckoutUrl("https://checkout.stripe.com:443/c/1"), true);
    assert.equal(isCheckoutUrl("https://CHECKOUT.stripe.com/c/1"), true);
  });

  it("hands the opener the parsed URL, not the server's string", async () => {
    const odd = api(() =>
      json(200, { url: "https://CHECKOUT.stripe.com:443/c/pay/cs_1#x" }),
    );
    assert.equal(
      await postCheckout(odd, "T99", false),
      "https://checkout.stripe.com/c/pay/cs_1#x",
    );
    assert.equal(
      checkoutHref("https://checkout.stripe.com/c/pay/cs 1"),
      "https://checkout.stripe.com/c/pay/cs%201",
    );
  });

  it("refuses anything but https://checkout.stripe.com", async () => {
    for (const url of [
      "javascript:alert(1)",
      "http://checkout.stripe.com/x",
      "https://evil.com/c/pay/cs_1",
      "https://stripe.com/c/1",
      "https://pay.checkout.stripe.com/c/1",
      "https://checkout.stripe.com.evil.com/c/1",
      "https://checkout.stripe.com.@evil.com/c/1",
      "https://checkout.stripe.com@evil.com/c/1",
      "https://user@checkout.stripe.com/c/1",
      "https://user:pass@checkout.stripe.com/c/1",
      "https://checkout.stripe.com:8443/c/1",
      "https://checkout.stripe.com./c/1",
      "https://evil.com/?https://checkout.stripe.com/",
      "//checkout.stripe.com/c/1",
      "data:text/html,hi",
      "/settings",
      42,
      undefined,
    ]) {
      assert.equal(isCheckoutUrl(url), false, String(url));
      assert.equal(checkoutHref(url), undefined, String(url));
      const bad = api(() => json(200, { url }));
      await assert.rejects(postCheckout(bad, "T99", false), (error) => {
        assert.ok(error instanceof CipherClientError);
        assert.equal(error.kind, "badResponse");
        return true;
      });
    }
  });

  it("a shell opens the system browser and never navigates itself", () => {
    const seen: string[] = [];
    const nav = {
      open: (url: string, target: string, features: string) =>
        seen.push(`open ${url} ${target} ${features}`),
      assign: (url: string) => void seen.push(`assign ${url}`),
    };
    openCheckout("https://c/1", true, nav);
    openCheckout("https://c/2", false, nav);
    assert.deepEqual(seen, [
      "open https://c/1 _blank noopener",
      "assign https://c/2",
    ]);
  });

  it("the stats read carries no session", async () => {
    const pub = api(() => json(200, { claimed: 1, cap: 1000, open: true }));
    await fetchCipherStats(pub);
    assert.equal(pub.calls[0]?.init, undefined);
  });
});

describe("the checkout intent survives the trip to Stripe, for this account only", () => {
  const intent = { user: "u1", tier: "T299" as const, at: NOW };

  it("round-trips", () => {
    assert.deepEqual(
      readIntent(encodeIntent(intent), "u1", NOW + 1000),
      intent,
    );
  });

  it("is ignored for another account, once stale, or when malformed", () => {
    const raw = encodeIntent(intent);
    assert.equal(readIntent(raw, "u2", NOW), undefined);
    assert.equal(readIntent(raw, undefined, NOW), undefined);
    assert.equal(readIntent(raw, "u1", NOW + INTENT_TTL_MS + 1), undefined);
    assert.equal(readIntent(raw, "u1", NOW - 1), undefined);
    assert.equal(readIntent("{", "u1", NOW), undefined);
    assert.equal(readIntent(null, "u1", NOW), undefined);
    assert.equal(
      readIntent(encodeIntent({ ...intent, tier: "T9" as never }), "u1", NOW),
      undefined,
    );
  });
});

describe("a checkout is settled when the tier it bought shows up", () => {
  it("with the tier known, waits for that tier, not just any membership", () => {
    assert.equal(checkoutSettled({}, "T99"), false);
    assert.equal(checkoutSettled(member("T99"), "T299"), false);
    assert.equal(checkoutSettled(member("T299"), "T299"), true);
    assert.equal(checkoutSettled(member("T299"), "T149"), true);
  });

  it("thanks only a membership that is new or higher than the baseline", () => {
    const confirmed = (me: CipherMe) => ({ me, poll: "confirmed" as const });
    assert.equal(pollBaselineOf(undefined), undefined);
    assert.equal(pollBaselineOf({}), null);
    assert.equal(pollBaselineOf(member("T149")), "T149");

    // Back from checkout, nothing loaded yet: any membership is new
    assert.equal(
      thankedMembership(confirmed(member("T99")), undefined)?.tier,
      "T99",
    );
    assert.equal(
      thankedMembership(confirmed(member("T99")), null)?.tier,
      "T99",
    );
    assert.equal(
      thankedMembership(confirmed(member("T299")), "T99")?.tier,
      "T299",
    );
    // A quiet poll that ended without a change thanks nobody
    assert.equal(thankedMembership(confirmed(member("T99")), "T99"), undefined);
    assert.equal(
      thankedMembership({ me: member("T299"), poll: "polling" }, null),
      undefined,
    );
    assert.equal(thankedMembership(confirmed({}), null), undefined);
  });

  it("without it, any membership with no open checkout", () => {
    assert.equal(checkoutSettled({}, undefined), false);
    assert.equal(checkoutSettled(member("T99"), undefined), true);
    assert.equal(
      checkoutSettled(
        {
          ...member("T99"),
          pending: {
            order_id: "o",
            sku: { type: "CipherUpgrade", from: "T99", to: "T149" },
            expires_at: NOW + 1,
          },
        },
        undefined,
      ),
      false,
    );
  });
});

/**
 * The controller on a fake clock. `respond` decides each read's answer from
 * its 1-based index; reads resolve on the next turn unless `hold` is set.
 * `intendedTier` stands in for this tab's stored intent (none by default).
 */
function harness(
  respond: (call: number) => CipherMe | Error,
  options: {
    hold?: boolean;
    intendedTier?: () => CipherTier | undefined;
  } = {},
) {
  let now = NOW;
  let nextId = 1;
  let maxTimers = 0;
  const timers: { id: number; due: number; run: () => void }[] = [];
  const reads: number[] = [];
  const held: (() => void)[] = [];
  const states: StandingState[] = [];

  const standing = createCipherStanding({
    fetchMe: () => {
      reads.push(now);
      const answer = respond(reads.length);
      const settle = (
        resolve: (v: CipherMe) => void,
        reject: (e: unknown) => void,
      ) => (answer instanceof Error ? reject(answer) : resolve(answer));
      return new Promise<CipherMe>((resolve, reject) => {
        if (options.hold) held.push(() => settle(resolve, reject));
        else settle(resolve, reject);
      });
    },
    onChange: (state) => states.push(state),
    now: () => now,
    setTimer: (run, ms) => {
      const id = nextId++;
      timers.push({ id, due: now + ms, run });
      maxTimers = Math.max(maxTimers, timers.length);
      return id;
    },
    clearTimer: (id) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
    intendedTier: options.intendedTier,
  });

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  return {
    standing,
    reads,
    states,
    timers,
    now: () => now,
    /** Most timers ever pending at once */
    maxTimers: () => maxTimers,
    /** Reads as offsets from the start */
    offsets: () => reads.map((at) => at - NOW),
    last: () => states[states.length - 1],
    flush,
    release: async () => {
      held.shift()?.();
      await flush();
    },
    /** Run the clock forward, firing timers in order */
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        await flush();
        timers.sort((a, b) => a.due - b.due);
        const next = timers[0];
        if (!next || next.due > end) break;
        timers.shift();
        now = next.due;
        next.run();
      }
      now = end;
      await flush();
    },
  };
}

/** The most reads any 10 s span holds */
function busiestWindow(reads: number[]): number {
  let most = 0;
  for (const start of reads) {
    most = Math.max(
      most,
      reads.filter((at) => at >= start && at < start + 10_000).length,
    );
  }
  return most;
}

/** A standing with a checkout open for `tier` until well after any test */
const pendingFor = (tier: "T99" | "T149" | "T299"): CipherMe => ({
  pending: {
    order_id: "o1",
    sku: { type: "CipherNew", tier },
    expires_at: NOW + 60 * 60_000,
  },
});

describe("standing controller: the poll after checkout", () => {
  it("polls every 5 s until the bought tier appears, then stops", async () => {
    assert.equal(POLL_INTERVAL_MS, 5000);
    const h = harness((call) => (call < 4 ? member("T99") : member("T299")));
    h.standing.startPoll("T299");
    await h.advance(60_000);

    assert.deepEqual(h.offsets(), [0, 5000, 10_000, 15_000]);
    assert.equal(h.last()?.poll, "confirmed");
    assert.equal(h.last()?.me?.membership?.tier, "T299");
    assert.equal(h.timers.length, 0, "no timer left behind");
  });

  it("gives up after two minutes and reads no more", async () => {
    const h = harness(() => ({}));
    h.standing.startPoll("T99");
    await h.advance(POLL_TIMEOUT_MS + 30_000);

    assert.equal(h.last()?.poll, "timedOut");
    const lastRead = h.reads[h.reads.length - 1] as number;
    assert.ok(lastRead - NOW <= POLL_TIMEOUT_MS + POLL_INTERVAL_MS);
    const count = h.reads.length;
    await h.advance(60_000);
    assert.equal(h.reads.length, count, "no read after giving up");
    assert.equal(h.timers.length, 0);
  });

  it("a read failing mid-poll keeps the last standing and keeps polling", async () => {
    const h = harness((call) =>
      call === 2 ? new Error("offline") : call < 4 ? {} : member("T99"),
    );
    h.standing.startPoll("T99");
    await h.advance(30_000);
    assert.equal(h.last()?.poll, "confirmed");
    assert.equal(h.last()?.error, undefined, "the next success clears it");
  });

  it("waits out a 429 before reading again", async () => {
    const h = harness((call) =>
      call === 1 ? new CipherClientError("rateLimited", 8000) : member("T149"),
    );
    h.standing.startPoll("T149");
    await h.advance(30_000);
    assert.deepEqual(h.offsets(), [0, 8000]);
    assert.equal(h.last()?.poll, "confirmed");
  });

  it("dispose stops the poll and ignores a late answer", async () => {
    const h = harness(() => member("T99"), { hold: true });
    h.standing.startPoll("T99");
    await h.flush();
    h.standing.dispose();
    const before = h.states.length;
    await h.release();
    await h.advance(60_000);
    assert.equal(h.states.length, before);
    assert.equal(h.reads.length, 1);
  });
});

describe("standing controller: one poll, however often it is (re)started", () => {
  it("two focus events at once start one poll, not two", async () => {
    const h = harness(() => pendingFor("T149"));
    // Focus and visibilitychange fire together when a shell window comes
    // back; even if both start the poll, it stays one poll on one timer
    h.standing.startPoll("T149", "quiet");
    h.standing.startPoll("T149", "quiet");
    h.standing.refresh();
    await h.advance(31_000);

    assert.deepEqual(
      h.offsets(),
      [0, 5000, 10_000, 15_000, 20_000, 25_000, 30_000],
    );
    assert.ok(h.maxTimers() <= 1, `${h.maxTimers()} timers at once`);
  });

  it("focus events during a running poll never add a second timer", async () => {
    const h = harness(() => pendingFor("T149"));
    h.standing.startPoll("T149", "quiet");
    for (const at of [1200, 2600, 4100, 7300, 7400]) {
      await h.advance(at - (h.now() - NOW));
      h.standing.startPoll("T149", "quiet");
      h.standing.refresh();
    }
    await h.advance(20_000 - (h.now() - NOW));
    for (let i = 1; i < h.reads.length; i++) {
      const gap = (h.reads[i] as number) - (h.reads[i - 1] as number);
      assert.ok(gap >= MIN_REQUEST_GAP_MS, `reads ${gap} ms apart`);
    }
    assert.ok(h.maxTimers() <= 1, `${h.maxTimers()} timers at once`);
  });

  it("restarting resets the two minutes", async () => {
    const h = harness(() => pendingFor("T149"));
    h.standing.startPoll("T149", "quiet");
    await h.advance(100_000);
    h.standing.startPoll("T149", "quiet");
    await h.advance(POLL_TIMEOUT_MS - 5000);
    assert.equal(h.last()?.poll, "polling");
    await h.advance(10_000);
    assert.equal(h.last()?.poll, "timedOut");
  });
});

describe("a quiet poll never says it is confirming a payment", () => {
  it("only a return marked as paid announces its poll", () => {
    assert.equal(mountPollMode("success", true), "announced");
    assert.equal(mountPollMode("success", false), "announced");
    assert.equal(mountPollMode(undefined, true), "quiet");
    assert.equal(mountPollMode(undefined, false), undefined);
    assert.equal(mountPollMode("cancel", true), undefined);
  });

  it("an announced poll shows confirming, then not seen yet", async () => {
    const h = harness(() => ({}));
    h.standing.startPoll("T99", "announced");
    await h.flush();
    assert.equal(pollNote(h.standing.state()), "confirming");
    await h.advance(POLL_TIMEOUT_MS + 10_000);
    assert.equal(h.last()?.poll, "timedOut");
    assert.equal(pollNote(h.standing.state()), "notSeen");
  });

  it("a quiet poll that gives up shows nothing", async () => {
    const h = harness(() => pendingFor("T99"));
    h.standing.startPoll("T99", "quiet");
    await h.flush();
    assert.equal(pollNote(h.standing.state()), undefined);
    await h.advance(POLL_TIMEOUT_MS + 10_000);
    assert.equal(h.last()?.poll, "timedOut");
    assert.equal(h.last()?.mode, "quiet");
    for (const state of h.states) {
      assert.equal(pollNote(state), undefined, JSON.stringify(state));
    }
  });

  it("without a stored intent, a quiet poll runs only while a checkout is open", async () => {
    const h = harness((call) => (call < 3 ? pendingFor("T99") : {}));
    h.standing.startPoll("T99", "quiet");
    await h.advance(60_000);
    assert.deepEqual(h.offsets(), [0, 5000, 10_000]);
    assert.equal(h.last()?.poll, "idle");
    assert.equal(h.timers.length, 0);
  });

  it("a quiet poll with no open checkout reads once and stops", async () => {
    const h = harness(() => ({}));
    h.standing.startPoll(undefined, "quiet");
    await h.advance(60_000);
    assert.equal(h.reads.length, 1);
    assert.equal(h.last()?.poll, "idle");
  });

  it("a quiet poll still ends in the thank-you when the tier arrives", async () => {
    const h = harness((call) =>
      call < 3 ? pendingFor("T149") : member("T149"),
    );
    h.standing.startPoll("T149", "quiet");
    await h.advance(60_000);
    assert.equal(h.last()?.poll, "confirmed");
    assert.equal(thankedMembership(h.standing.state(), null)?.tier, "T149");
  });

  it("a quiet restart leaves an announced poll announced", async () => {
    const h = harness(() => ({}));
    h.standing.startPoll("T99", "announced");
    await h.flush();
    h.standing.startPoll("T99", "quiet");
    assert.equal(h.standing.state().mode, "announced");
  });
});

describe("a quiet poll with this tab's intent stored outlasts the paid order", () => {
  // `@me` stops listing an order once it is paid, before the membership is
  // written. A quiet poll that stopped on "no open checkout" there would
  // miss the thank-you for the very purchase it was started for.

  it("keeps reading through the gap until the intended tier arrives", async () => {
    const h = harness(
      (call) =>
        call < 3 ? pendingFor("T149") : call < 6 ? {} : member("T149"),
      { intendedTier: () => "T149" },
    );
    h.standing.startPoll("T149", "quiet");
    await h.advance(60_000);

    assert.deepEqual(h.offsets(), [0, 5000, 10_000, 15_000, 20_000, 25_000]);
    assert.equal(h.last()?.poll, "confirmed");
    assert.equal(thankedMembership(h.standing.state(), null)?.tier, "T149");
    assert.equal(h.timers.length, 0, "no timer left behind");
  });

  it("an upgrade waits past the old tier for the new one", async () => {
    const upgrading: CipherMe = {
      ...member("T99"),
      pending: {
        order_id: "o1",
        sku: { type: "CipherUpgrade", from: "T99", to: "T149" },
        expires_at: NOW + 60 * 60_000,
      },
    };
    const h = harness(
      (call) =>
        call < 2 ? upgrading : call < 4 ? member("T99") : member("T149"),
      { intendedTier: () => "T149" },
    );
    h.standing.startPoll("T149", "quiet");
    await h.advance(60_000);

    assert.equal(h.reads.length, 4);
    assert.equal(h.last()?.poll, "confirmed");
    assert.equal(thankedMembership(h.standing.state(), "T99")?.tier, "T149");
  });

  it("with nothing arriving, it reads until its deadline and says nothing", async () => {
    const h = harness(() => ({}), { intendedTier: () => "T99" });
    h.standing.startPoll("T99", "quiet");
    await h.advance(POLL_TIMEOUT_MS + 30_000);

    assert.equal(h.last()?.poll, "timedOut");
    assert.equal(h.reads.length, POLL_TIMEOUT_MS / POLL_INTERVAL_MS + 1);
    for (const state of h.states) {
      assert.equal(pollNote(state), undefined, JSON.stringify(state));
    }
    const count = h.reads.length;
    await h.advance(60_000);
    assert.equal(h.reads.length, count, "no read after giving up");
    assert.equal(h.timers.length, 0);
  });

  it("stops at the first read after the intent is gone", async () => {
    // Dropped, or past its TTL (the page reads it through readIntent)
    let intent: CipherTier | undefined = "T149";
    const h = harness(() => ({}), { intendedTier: () => intent });
    h.standing.startPoll("T149", "quiet");
    await h.advance(12_000);
    assert.equal(h.last()?.poll, "polling");

    intent = undefined;
    await h.advance(60_000);
    assert.deepEqual(h.offsets(), [0, 5000, 10_000, 15_000]);
    assert.equal(h.last()?.poll, "idle");
    assert.equal(h.timers.length, 0);
  });

  it("an intent for another tier does not hold it open", async () => {
    const h = harness(() => ({}), { intendedTier: () => "T299" });
    h.standing.startPoll("T149", "quiet");
    await h.advance(60_000);
    assert.equal(h.reads.length, 1);
    assert.equal(h.last()?.poll, "idle");
  });
});

describe("a buy is never starved by the poll", () => {
  /** A checkout request whose answers the test hands out one at a time */
  function checkoutRequests(h: ReturnType<typeof harness>) {
    const attempts: number[] = [];
    const pending: {
      resolve: (url: string) => void;
      reject: (e: unknown) => void;
    }[] = [];
    const attempt = () =>
      new Promise<string>((resolve, reject) => {
        attempts.push(h.now());
        pending.push({ resolve, reject });
      });
    return {
      attempts: () => attempts.map((at) => at - NOW),
      /**
       * Buy through the controller. A rejection is asserted by the test
       * later, so it is marked handled here rather than reported as
       * unhandled the moment it happens.
       */
      start() {
        const result = h.standing.checkout(attempt);
        result.catch(() => undefined);
        return result;
      },
      async answer(value: string | Error) {
        const next = pending.shift();
        if (value instanceof Error) next?.reject(value);
        else next?.resolve(value);
        await h.flush();
      },
    };
  }

  it("a buy during a poll goes out at once, and the poll waits for it", async () => {
    const h = harness((call) => (call < 3 ? {} : member("T149")));
    const req = checkoutRequests(h);
    h.standing.startPoll("T149");
    await h.advance(4900);
    assert.deepEqual(h.offsets(), [0]);

    // Just before the poll's next read is due
    const result = req.start();
    assert.deepEqual(req.attempts(), [4900], "the buy is sent at once");

    // In flight across the poll's due time: no read
    await h.advance(2000);
    assert.deepEqual(h.offsets(), [0]);
    await req.answer("https://checkout.stripe.com/c/1");
    assert.equal(await result, "https://checkout.stripe.com/c/1");

    // Settled at 6900: still no read for CHECKOUT_PAUSE_MS
    assert.equal(CHECKOUT_PAUSE_MS, 1000);
    await h.advance(999);
    assert.deepEqual(h.offsets(), [0]);
    await h.advance(1);
    assert.deepEqual(h.offsets(), [0, 7900], "the poll resumes after it");

    await h.advance(10_000);
    assert.deepEqual(h.offsets(), [0, 7900, 12_900]);
    assert.equal(h.last()?.poll, "confirmed");
  });

  it("a read already in flight does not hold the buy back", async () => {
    const h = harness(() => ({}), { hold: true });
    const req = checkoutRequests(h);
    h.standing.startPoll("T149");
    await h.flush();
    void req.start();
    assert.deepEqual(req.attempts(), [0]);
    await h.release();
    await h.advance(POLL_INTERVAL_MS * 2);
    assert.equal(h.reads.length, 1, "no read while the buy is out");
    await req.answer("https://checkout.stripe.com/c/1");
    await h.advance(CHECKOUT_PAUSE_MS);
    assert.equal(h.reads.length, 2);
  });

  it("a rate-limited buy waits out retry_after and retries once", async () => {
    const h = harness(() => ({}));
    const req = checkoutRequests(h);
    h.standing.startPoll("T149");
    await h.flush();
    const result = req.start();
    await req.answer(new CipherClientError("rateLimited", 3000));
    await h.advance(2999);
    assert.deepEqual(req.attempts(), [0]);
    await h.advance(1);
    assert.deepEqual(req.attempts(), [0, 3000], "retried after retry_after");
    await req.answer("https://checkout.stripe.com/c/2");
    assert.equal(await result, "https://checkout.stripe.com/c/2");
    assert.deepEqual(h.offsets(), [0], "no read during the wait");
    await h.advance(CHECKOUT_PAUSE_MS);
    assert.deepEqual(h.offsets(), [0, 4000]);
  });

  it("a second 429 is reported, not retried again", async () => {
    const h = harness(() => ({}));
    const req = checkoutRequests(h);
    const result = req.start();
    await req.answer(new CipherClientError("rateLimited", 2000));
    await h.advance(2000);
    await req.answer(new CipherClientError("rateLimited", 2000));
    await assert.rejects(result, (error) => {
      assert.ok(error instanceof CipherClientError);
      assert.equal(error.kind, "rateLimited");
      return true;
    });
    await h.advance(30_000);
    assert.equal(req.attempts().length, 2);
  });

  it("a wait longer than one window is reported at once", async () => {
    const h = harness(() => ({}));
    const req = checkoutRequests(h);
    const result = req.start();
    await req.answer(
      new CipherClientError("rateLimited", CHECKOUT_RETRY_MAX_MS + 1),
    );
    await assert.rejects(result, CipherClientError);
    await h.advance(60_000);
    assert.equal(req.attempts().length, 1);
  });

  it("any other failure is reported at once, and the poll resumes", async () => {
    const h = harness(() => ({}));
    const req = checkoutRequests(h);
    h.standing.startPoll("T149");
    await h.flush();
    const result = req.start();
    await h.advance(6000);
    await req.answer(
      Object.assign(new Error("409"), { type: "PaymentPending" }),
    );
    await assert.rejects(result, { type: "PaymentPending" });
    assert.equal(req.attempts().length, 1);
    await h.advance(CHECKOUT_PAUSE_MS);
    assert.deepEqual(h.offsets(), [0, 7000]);
  });

  it("one checkout request at a time", async () => {
    const h = harness(() => ({}));
    const req = checkoutRequests(h);
    void req.start();
    await assert.rejects(req.start());
    assert.equal(req.attempts().length, 1);
  });

  it("dispose during the retry wait ends it without a second attempt", async () => {
    const h = harness(() => ({}));
    const req = checkoutRequests(h);
    const result = req.start();
    await req.answer(new CipherClientError("rateLimited", 5000));
    h.standing.dispose();
    await assert.rejects(result, CipherClientError);
    await h.advance(30_000);
    assert.equal(req.attempts().length, 1);
    assert.equal(h.timers.length, 0);
  });
});

describe("standing controller: well within the payments_me bucket", () => {
  it("asks made while a read is in flight share one follow-up read", async () => {
    const h = harness(() => ({}), { hold: true });
    h.standing.refresh();
    await h.flush();
    h.standing.refresh();
    h.standing.refresh();
    h.standing.refresh();
    await h.release();
    await h.advance(MIN_REQUEST_GAP_MS);
    assert.equal(h.reads.length, 2);
  });

  it("a burst of focus refreshes and poll restarts stays within 5 per 10 s", async () => {
    const h = harness(() => ({}));
    h.standing.refresh();
    for (let i = 0; i < 40; i++) {
      // Focus events, store updates and poll restarts at odd intervals
      if (i % 3 === 0) h.standing.startPoll("T99");
      else h.standing.refresh();
      await h.advance(700 + ((i * 337) % 1900));
    }
    await h.advance(POLL_TIMEOUT_MS);
    assert.ok(h.reads.length > 5, "it did read");
    // Half of payments_me (10 per 10 s), so a second tab still fits
    assert.ok(
      busiestWindow(h.reads) <= 5,
      `busiest 10 s window held ${busiestWindow(h.reads)} reads`,
    );
  });

  it("a refresh too soon after a read is deferred, not dropped", async () => {
    const h = harness(() => ({}));
    h.standing.refresh();
    await h.advance(1000);
    h.standing.refresh();
    await h.advance(500);
    assert.equal(h.reads.length, 1);
    await h.advance(500);
    assert.equal(h.reads.length, 2);
    assert.equal(
      (h.reads[1] as number) - (h.reads[0] as number),
      MIN_REQUEST_GAP_MS,
    );
  });
});

describe("prices and times follow the app locale", () => {
  it("formats prices in the app locale, whole dollars without cents", () => {
    assert.equal(formatUsd(9900, "en"), "$99");
    assert.equal(formatUsd(5050, "en"), "$50.50");
    // lingui's `pt_BR`-style tags are read as formatCount reads them
    assert.match(formatUsd(14900, "pt_BR"), /^US\$\s149$/);
    assert.match(formatUsd(5050, "de"), /^50,50\s\$$/);
    assert.equal(formatUsd(9900, "not a locale!"), "$99");
    assert.equal(formatUsd(9900, undefined), "$99");
  });

  it("formats times in the app locale", () => {
    const at = Date.UTC(2026, 9, 18, 15, 0);
    assert.match(formatShortTime(at, "en"), /AM|PM/);
    assert.doesNotMatch(formatShortTime(at, "de"), /AM|PM/);
    assert.match(formatShortTime(at, "not a locale!"), /AM|PM/);
  });
});

describe("store gate: the cipher row and page only exist where donation links are allowed", () => {
  const userSettings = readFileSync(
    new URL("../UserSettings.tsx", import.meta.url),
    "utf8",
  );
  const page = readFileSync(
    new URL("./CipherSettings.tsx", import.meta.url),
    "utf8",
  );

  it("the settings row hides behind allowsDonationLinks() through a getter", () => {
    const start = userSettings.indexOf('id: "cipher"');
    assert.ok(start >= 0, "a cipher settings row exists");
    const next = userSettings.indexOf("id: ", start + 1);
    const entry = userSettings.slice(start, next < 0 ? undefined : next);
    // A getter, not a value: on Android the distribution channel resolves
    // after the list is built, and a Play build starts out as "play"
    assert.match(
      entry,
      /get hidden\(\)\s*\{\s*return !allowsDonationLinks\(\);\s*\}/,
    );
  });

  it("the page renders nothing unless allowsDonationLinks()", () => {
    // Line comments may sit between the case and its return
    assert.match(
      userSettings,
      /case "cipher":(?:\s*\/\/[^\n]*)*\s*return allowsDonationLinks\(\) \? \(?\s*<CipherSettings[\s\S]*?\)? : null;/,
    );
    assert.match(
      page,
      /export function CipherSettings\([^)]*\) \{\s*return \(\s*<Show when=\{allowsDonationLinks\(\)\}>/,
    );
  });

  it("every checkout and standing request comes from the gated page", () => {
    // The only callers of the request helpers are inside CipherPage, which
    // CipherSettings renders under the gate above
    assert.equal(page.match(/\bpostCheckout\(/g)?.length, 1);
    assert.doesNotMatch(
      page,
      /\bfetch\(\s*`/,
      "no raw fetch outside the helpers",
    );
  });
});
