/**
 * Run with:
 *
 *     node --conditions=browser --test components/app/interface/settings/user/protWallet.confirm.test.ts
 *
 * What confirms a Prot checkout, and what a `ProtBalanceUpdate` triggers
 * (the W3 audit fixes; protWallet.test.ts covers the rest of the module):
 *
 * - a post-checkout poll confirms on a Purchase row created at or after the
 *   checkout started (the stored intent's `at`), so an unrelated credit (a
 *   Cipher grant, an admin adjustment) never confirms it and a debit in the
 *   same window never hides it; the balance rise stands in only when the
 *   history cannot reach back to the start;
 * - a return whose intent was lost never takes a purchase from before
 *   {@link PROT_RETURN_WINDOW_MS} for this checkout;
 * - an update refreshes the wallet when no read is held yet or the read is
 *   older, and never for a stale or repeated event.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import {
  type CipherApi,
  INTENT_TTL_MS,
  POLL_INTERVAL_MS,
} from "./cipherCheckout.ts";
import {
  type ProtLedgerView,
  type ProtMe,
  PROT_RECENT_ROWS,
  PROT_RETURN_WINDOW_MS,
  balanceUpdateAction,
  checkoutConfirmed,
  createProtStanding,
  historyReaches,
  purchasedSince,
} from "./protWallet.ts";

const NOW = 1_800_000_000_000;

const row = (
  kind: ProtLedgerView["kind"],
  amount: number,
  created_at: number,
  id = `${kind}-${created_at}`,
): ProtLedgerView => ({ id, kind, amount, created_at });

const wallet = (balance: number, recent: ProtLedgerView[], version = 1) => ({
  balance,
  held: 0,
  version,
  recent,
});

describe("checkoutConfirmed", () => {
  it("confirms on a Purchase row at or after the checkout's start", () => {
    const me = wallet(2700, [row("Purchase", 2600, NOW)]);
    assert.equal(checkoutConfirmed(me, 100, NOW), true);
    assert.equal(checkoutConfirmed(me, 100, NOW + 1), false);
  });

  it("never confirms on an unrelated credit, whatever the balance did", () => {
    for (const kind of [
      "CipherFounding",
      "CipherUpgrade",
      "AdminAdjust",
    ] as const) {
      const me = wallet(2700, [row(kind, 2600, NOW + 1000)]);
      assert.equal(checkoutConfirmed(me, 100, NOW), false, kind);
    }
  });

  it("confirms a real Purchase even when a debit in the window lowered the balance", () => {
    const me = wallet(50, [
      row("Contribution", -550, NOW + 3000),
      row("Purchase", 500, NOW + 2000),
    ]);
    assert.equal(checkoutConfirmed(me, 100, NOW), true);
  });

  it("never takes a purchase from before the checkout for this one", () => {
    const me = wallet(2700, [row("Purchase", 2600, NOW - 1)]);
    assert.equal(checkoutConfirmed(me, 100, NOW), false);
  });

  it("falls back to the balance rise only when the history cannot reach the start", () => {
    // A full page of rows, all after the start: an older purchase row may
    // have been pushed out of it
    const full = Array.from({ length: PROT_RECENT_ROWS }, (_, i) =>
      row("Contribution", -1, NOW + 10_000 - i),
    );
    assert.equal(historyReaches(wallet(0, full), NOW), false);
    assert.equal(checkoutConfirmed(wallet(2700, full), 100, NOW), true);
    assert.equal(checkoutConfirmed(wallet(100, full), 100, NOW), false);
    // A full page that reaches back past the start is the whole window
    const reaching = [...full.slice(1), row("Contribution", -1, NOW - 1)];
    assert.equal(historyReaches(wallet(0, reaching), NOW), true);
    assert.equal(checkoutConfirmed(wallet(2700, reaching), 100, NOW), false);
  });

  it("without a start time, the balance rise alone decides", () => {
    assert.equal(checkoutConfirmed(wallet(101, []), 100), true);
    assert.equal(checkoutConfirmed(wallet(100, []), 100), false);
    assert.equal(checkoutConfirmed(undefined, 100, NOW), false);
  });
});

describe("a return whose intent was lost", () => {
  it("looks back a few minutes, never as far as an intent lives", () => {
    assert.ok(PROT_RETURN_WINDOW_MS > 0);
    assert.ok(PROT_RETURN_WINDOW_MS < INTENT_TTL_MS);
  });

  it("does not take an older purchase for this checkout", () => {
    const since = NOW - PROT_RETURN_WINDOW_MS;
    const older = wallet(2600, [row("Purchase", 2600, since - 60_000)]);
    const recent = wallet(2600, [row("Purchase", 2600, since + 60_000)]);
    assert.equal(purchasedSince(older, since), false);
    assert.equal(purchasedSince(recent, since), true);
  });

  it("is wired that way in ProtSettings.tsx (source level)", () => {
    const source = readFileSync(
      new URL("./ProtSettings.tsx", import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /const lostIntentSince = Date\.now\(\) - PROT_RETURN_WINDOW_MS;/,
    );
    assert.match(source, /purchasedSince\(me, lostIntentSince\)/);
    assert.match(
      source,
      /standing\.pollAfterCheckout\(me\.balance, lostIntentSince\)/,
    );
    assert.doesNotMatch(source, /PROT_INTENT_TTL_MS/);
    // Every poll from a stored intent waits for a purchase since its start
    assert.equal(
      (source.match(/pollAfterCheckout\(intent\.balance, intent\.at\)/g) ?? [])
        .length,
      2,
    );
    assert.doesNotMatch(source, /pollAfterCheckout\([^,()]*\);/);
  });
});

describe("balanceUpdateAction", () => {
  const me: ProtMe = wallet(900, [], 7);

  it("refreshes for an event that arrives before the first read", () => {
    assert.deepEqual(balanceUpdateAction(undefined, undefined, 3), {
      keep: true,
      refresh: true,
    });
  });

  it("does not refresh for an event no newer than the read held", () => {
    for (const version of [6, 7]) {
      assert.deepEqual(balanceUpdateAction(undefined, me, version), {
        keep: true,
        refresh: false,
      });
    }
  });

  it("refreshes for an event newer than the read held", () => {
    assert.deepEqual(balanceUpdateAction(undefined, me, 8), {
      keep: true,
      refresh: true,
    });
  });

  it("drops an event no newer than the newest one kept", () => {
    for (const version of [8, 9]) {
      assert.deepEqual(
        balanceUpdateAction({ balance: 1, version: 9 }, me, version),
        { keep: false, refresh: false },
      );
    }
  });

  it("is what the page's listener runs (source level)", () => {
    const source = readFileSync(
      new URL("./ProtSettings.tsx", import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /const action = balanceUpdateAction\(update\(\), standing\.me\(\), version\);\s*if \(!action\.keep\) return;\s*setUpdate\(\{ balance, version \}\);\s*if \(action\.refresh\) void standing\.refresh\(\);/,
    );
  });
});

describe("the post-checkout poll", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  async function flush() {
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  function api(bodies: unknown[]): CipherApi {
    let index = 0;
    return {
      apiBase: "https://api.test",
      headers: () => ({}),
      fetch: async () => {
        const body = bodies[Math.min(index++, bodies.length - 1)];
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => body,
        } as unknown as Response;
      },
    };
  }

  it("keeps polling through a Cipher grant, then confirms on the Purchase", async () => {
    const grant = row("CipherFounding", 2600, NOW + 1000);
    const purchase = row("Purchase", 500, NOW + 6000);
    const standing = createProtStanding({
      api: api([
        wallet(100, [], 1),
        wallet(2700, [grant], 2),
        wallet(3200, [purchase, grant], 3),
      ]),
      nowMs: () => Date.now(),
    });
    standing.pollAfterCheckout(100, NOW);
    await flush();
    assert.equal(standing.phase(), "polling");
    mock.timers.tick(POLL_INTERVAL_MS);
    await flush();
    assert.equal(standing.me()?.balance, 2700);
    assert.equal(standing.phase(), "polling");
    mock.timers.tick(POLL_INTERVAL_MS);
    await flush();
    assert.equal(standing.phase(), "confirmed");
    standing.dispose();
  });

  it("confirms a Purchase although a debit left the balance below the baseline", async () => {
    const standing = createProtStanding({
      api: api([
        wallet(50, [
          row("Contribution", -550, NOW + 3000),
          row("Purchase", 500, NOW + 2000),
        ]),
      ]),
      nowMs: () => Date.now(),
    });
    standing.pollAfterCheckout(100, NOW);
    await flush();
    assert.equal(standing.phase(), "confirmed");
    standing.dispose();
  });
});
