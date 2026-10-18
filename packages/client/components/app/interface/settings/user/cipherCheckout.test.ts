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
 * - the checkout request names a tier and a return target only, and a shell
 *   never navigates its own window to Stripe;
 * - the standing controller: the poll after checkout stops when the tier it
 *   waits for arrives or after two minutes, and no burst of reads ever
 *   spends more than the `payments` bucket's 3 requests per 10 s;
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
  type StandingState,
  CipherClientError,
  INTENT_TTL_MS,
  MIN_REQUEST_GAP_MS,
  POLL_TIMEOUT_MS,
  checkoutReturnTo,
  checkoutSettled,
  cipherOffers,
  createCipherStanding,
  encodeIntent,
  fetchCipherMe,
  fetchCipherStats,
  formatCipherNumber,
  isCheckoutUrl,
  livePending,
  offerAction,
  openCheckout,
  pageOffers,
  parseCipherContext,
  parseCipherMe,
  parseCipherStats,
  parseUserCipher,
  pollBaselineOf,
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

  it("refuses to open anything but an https page", async () => {
    for (const url of [
      "javascript:alert(1)",
      "http://checkout.stripe.com/x",
      "data:text/html,hi",
      "/settings",
      42,
      undefined,
    ]) {
      assert.equal(isCheckoutUrl(url), false, String(url));
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
 */
function harness(
  respond: (call: number) => CipherMe | Error,
  options: { hold?: boolean } = {},
) {
  let now = NOW;
  let nextId = 1;
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
      return id;
    },
    clearTimer: (id) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
  });

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  return {
    standing,
    reads,
    states,
    timers,
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

describe("standing controller: the poll after checkout", () => {
  it("polls until the bought tier appears, then stops", async () => {
    const h = harness((call) => (call < 4 ? member("T99") : member("T299")));
    h.standing.startPoll("T299");
    await h.advance(60_000);

    assert.equal(h.reads.length, 4);
    assert.equal(h.last()?.poll, "confirmed");
    assert.equal(h.last()?.me?.membership?.tier, "T299");
    assert.equal(h.timers.length, 0, "no timer left behind");
    for (let i = 1; i < h.reads.length; i++) {
      assert.equal((h.reads[i] as number) - (h.reads[i - 1] as number), 3500);
    }
  });

  it("gives up after two minutes and reads no more", async () => {
    const h = harness(() => ({}));
    h.standing.startPoll("T99");
    await h.advance(POLL_TIMEOUT_MS + 30_000);

    assert.equal(h.last()?.poll, "timedOut");
    const lastRead = h.reads[h.reads.length - 1] as number;
    assert.ok(lastRead - NOW <= POLL_TIMEOUT_MS + MIN_REQUEST_GAP_MS);
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
    assert.equal(h.reads.length, 2);
    assert.equal((h.reads[1] as number) - (h.reads[0] as number), 8000);
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

describe("standing controller: never more than the payments bucket allows", () => {
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

  it("a burst of focus refreshes and poll restarts stays within 3 per 10 s", async () => {
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
    assert.ok(
      busiestWindow(h.reads) <= 3,
      `busiest 10 s window held ${busiestWindow(h.reads)} reads`,
    );
  });

  it("a refresh too soon after a read is deferred, not dropped", async () => {
    const h = harness(() => ({}));
    h.standing.refresh();
    await h.advance(1000);
    h.standing.refresh();
    await h.advance(1000);
    assert.equal(h.reads.length, 1);
    await h.advance(2000);
    assert.equal(h.reads.length, 2);
    assert.equal(
      (h.reads[1] as number) - (h.reads[0] as number),
      MIN_REQUEST_GAP_MS,
    );
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
