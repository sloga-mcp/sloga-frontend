/**
 * Run with:
 *
 *     node --conditions=browser --test components/client/ProtStoreWorker.test.ts
 *
 * The in-app purchase recovery worker (S6, `./ProtStoreWorker.tsx`), at
 * source level: it reaches Solid, Capacitor and the client, so it is read as
 * text, not loaded. Each test names the rule and what goes wrong without it:
 *
 * - it runs in store builds only: the FIRST statement of its one effect is
 *   the `isStoreBuild(distributionChannel())` gate, so web, desktop,
 *   sideload and foss never set store facts or reach the plugin (contracts
 *   section 28, lane L3d: deleting the gate must fail
 *   `worker_is_store_builds_only`);
 * - it finishes a transaction only behind `shouldFinish`, and only an Apple
 *   one: finishing on an error loses a purchase the store would re-deliver,
 *   and Play is consumed by the server;
 * - it never opens a purchase sheet and never consumes;
 * - it verifies by raw fetch to the verify route (the typed client has no
 *   table for it), one claim per transaction, and the claim is exported for
 *   the purchase sheet in ProtSettings.tsx;
 * - it sets the store facts from the advert, the `/@me` preview flag (only a
 *   literal true) and the plugin; the advert is read strictly through
 *   `parseProtFeature(...).store ?? null` (R32): a lax reader would open the
 *   gate on `{}` or on a flag that is not a boolean;
 * - its cleanup stops the run, removes the listener and resets the facts;
 * - a session's claims are released when it ends, the answer of a verify
 *   still in flight then never re-takes one, and `releaseProtStoreVerify` is
 *   exported for the sheet (R29): otherwise signing in to the buying account
 *   in the same launch never verifies the purchase;
 * - every step of `recover` is written to the reactive `protStoreOutcome`
 *   (R30): otherwise the sheet shows a stale step for a claim the worker holds;
 * - the verify body, answer and purchase readers come from protStoreFlow.ts
 *   (R33), so there is one whitelist;
 * - it is mounted once, after ApkUpdateWorker (contracts section 23).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const worker = readFileSync(
  new URL("./ProtStoreWorker.tsx", import.meta.url),
  "utf8",
);
const shell = readFileSync(
  new URL("../../src/Interface.tsx", import.meta.url),
  "utf8",
);

/** The component, from `export function ProtStoreWorker(` to the end */
function component(): string {
  const at = worker.indexOf("\nexport function ProtStoreWorker(");
  assert.ok(at > 0, "ProtStoreWorker.tsx exports function ProtStoreWorker(");
  return worker.slice(at);
}

/** A top-level function of the worker, from `function name(` to its `}` */
function fnText(name: string): string {
  const at = worker.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  assert.ok(at >= 0, `ProtStoreWorker.tsx has function ${name}(`);
  const end = worker.indexOf("\n}\n", at);
  assert.ok(end > at, `function ${name}( ends`);
  return worker.slice(at, end + 2);
}

/** `text` without its leading whitespace and comments */
function skipComments(text: string): string {
  let rest = text;
  for (;;) {
    rest = rest.replace(/^\s+/, "");
    if (rest.startsWith("//")) {
      const newline = rest.indexOf("\n");
      rest = newline < 0 ? "" : rest.slice(newline + 1);
    } else if (rest.startsWith("/*")) {
      const close = rest.indexOf("*/");
      rest = close < 0 ? "" : rest.slice(close + 2);
    } else {
      return rest;
    }
  }
}

describe("ProtStoreWorker (source level)", () => {
  test("worker_is_store_builds_only", () => {
    const body = component();
    const effect = /createEffect\(\s*\(\)\s*=>\s*\{/.exec(body);
    assert.ok(effect, "the worker runs inside createEffect(() => {");
    const first = skipComments(body.slice(effect.index + effect[0].length));
    assert.match(
      first,
      /^if\s*\(\s*!\s*isStoreBuild\(\s*distributionChannel\(\)\s*\)\s*\)\s*return\s*;/,
      "the effect's first statement is the isStoreBuild(distributionChannel()) gate",
    );
    // One effect only: a second, ungated one would run in every build
    assert.equal((worker.match(/\bcreateEffect\(/g) ?? []).length, 1);
    assert.match(
      worker,
      /import \{[^}]*\bisStoreBuild\b[^}]*\} from "\.\/distribution";/,
    );
  });

  test("finishes only an Apple transaction, and only when shouldFinish says so", () => {
    const calls = [...worker.matchAll(/\.finish\(/g)];
    assert.equal(calls.length, 1, "one finish( call");
    const at = calls[0].index ?? -1;
    const guard = worker.slice(worker.lastIndexOf("if (", at), at);
    assert.match(guard, /store === "apple"/);
    assert.match(guard, /shouldFinish\(/);
  });

  test("never opens a purchase sheet and never consumes", () => {
    assert.doesNotMatch(worker, /\.purchase\(/);
    assert.doesNotMatch(worker, /consumeAsync|acknowledgePurchase/);
  });

  test("verifies by raw fetch to the verify route, one claim per transaction", () => {
    assert.ok(worker.includes("/payments/prot/store/verify"));
    assert.match(worker, /\bfetch\(/);
    assert.match(
      worker,
      /export function claimProtStoreVerify\(purchase: ProtStorePurchased\): boolean/,
    );
    assert.match(worker, /recoveryShouldVerify\(/);
    assert.match(worker, /!claimProtStoreVerify\(purchase\)\) return;/);
  });

  test("sets the store facts from the advert, the preview flag and the plugin", () => {
    // R32: the strict reader of protWallet.ts, never a reach into the raw
    // advert (`{}` or a non-boolean flag would read as an advert)
    assert.match(
      worker,
      /import \{ parseProtFeature \} from "@revolt\/app\/interface\/settings\/user\/protWallet";/,
    );
    assert.match(worker, /parseProtFeature\([^)]*\)\.store \?\? null;/);
    assert.doesNotMatch(worker, /features\?\.prot\?\.store/);
    assert.doesNotMatch(worker, /_open\s*===\s*true/);
    // Every property read of the preview flag is a literal true
    const reads = [...worker.matchAll(/\.store_preview\b/g)];
    assert.ok(reads.length > 0, "the worker reads store_preview");
    for (const match of reads) {
      assert.match(
        worker.slice((match.index ?? 0) + 1),
        /^store_preview\s*===\s*true/,
      );
    }
    assert.match(worker, /protStoreAvailable\(\)/);
    assert.match(
      worker,
      /setProtStoreFacts\(\{ store, storePreview, pluginAvailable \}\)/,
    );
  });

  test("its cleanup stops the run, removes the listener and resets the facts", () => {
    const cleanups = [
      ...component().matchAll(/onCleanup\(\(\) => \{([^}]*)\}\)/g),
    ];
    assert.ok(
      cleanups.some(
        ([, body]) =>
          body.includes("run.disposed = true") &&
          body.includes("listener?.remove()") &&
          body.includes("setProtStoreFacts(NO_PROT_STORE_FACTS)"),
      ),
      "one onCleanup disposes the run, removes the listener and resets the facts",
    );
  });

  test("session_end_releases_the_claims", () => {
    // R29: the sheet releases a claim when its session changes
    assert.match(
      worker,
      /export function releaseProtStoreVerify\(purchase: ProtStorePurchased\): void \{\s*releaseKey\(transactionKey\(purchase\)\);/,
    );
    // Releasing a key frees it for the next session's claim
    assert.match(fnText("releaseKey"), /verifiedThisLaunch\.delete\(key\);/);
    // The worker records which run holds each claim it takes
    assert.match(
      worker,
      /!claimProtStoreVerify\(purchase\)\) return;\s*const key = transactionKey\(purchase\);\s*claimOwners\.set\(key, run\);\s*run\.claims\.add\(key\);/,
    );
    // Only the run's own claims are released (never a claim the next
    // session or the sheet took in the meantime)
    assert.match(
      fnText("releaseRunClaims"),
      /if \(claimOwners\.get\(key\) === run\) releaseKey\(key\);/,
    );
    // The cleanup that ends the session releases them
    const cleanups = [
      ...component().matchAll(/onCleanup\(\(\) => \{([^}]*)\}\)/g),
    ];
    assert.ok(
      cleanups.some(
        ([, body]) =>
          body.includes("run.disposed = true") &&
          body.includes("releaseRunClaims(run)"),
      ),
      "the disposing onCleanup calls releaseRunClaims(run)",
    );
    // An answer that lands after the session ended stops there (a finish
    // only), before it is recorded or re-takes anything
    assert.match(
      fnText("recover"),
      /await verifyOnce\([^)]*\);\s*const next = protStoreStep\(state, event\);\s*if \(run\.disposed && next\.step !== "finishing"\) \{[^}]*return;\s*\}/,
    );
  });

  test("worker_writes_the_outcome_at_each_step", () => {
    assert.match(
      worker,
      /export function protStoreOutcome\(key: string\): ProtStoreFlowState \| undefined \{\s*return outcomes\(\)\.get\(key\);/,
    );
    // Reactive: a signal, so StoreShop re-renders on every step
    assert.match(
      worker,
      /const \[outcomes, setOutcomes\] = createSignal<\s*ReadonlyMap<string, ProtStoreFlowState>\s*>/,
    );
    // Recorded only for the run that holds the claim, while it is live
    assert.match(
      fnText("noteOutcome"),
      /if \(run\.disposed \|\| claimOwners\.get\(key\) !== run\) return;/,
    );
    // The first state, and every state `recover` moves to, is recorded
    const body = fnText("recover");
    assert.match(
      body,
      /let state: ProtStoreFlowState = \{[^}]*\};\s*noteOutcome\(run, key, state\);/,
    );
    const moves = body.match(/\bstate = /g) ?? [];
    const recorded =
      body.match(/\bstate = [^;]+;\s*noteOutcome\(run, key, state\);/g) ?? [];
    assert.ok(moves.length >= 2, "recover moves the state");
    assert.equal(recorded.length, moves.length, "every move is recorded");
  });

  test("verify readers come from protStoreFlow.ts (R33)", () => {
    assert.match(
      worker,
      /import \{[^}]*\breadPurchase\b[^}]*\breadVerifyAnswer\b[^}]*\bverifyRequestBody\b[^}]*\} from "\.\/protStoreFlow";/,
    );
    assert.doesNotMatch(
      worker,
      /function (readPurchase|readVerifyAnswer|verifyRequestBody)\(/,
    );
    assert.doesNotMatch(worker, /VERIFY_STATUSES|VERIFY_REASONS/);
    assert.match(worker, /JSON\.stringify\(verifyRequestBody\(purchase\)\)/);
  });

  test("is mounted once, after ApkUpdateWorker", () => {
    assert.equal((shell.match(/<ProtStoreWorker\b/g) ?? []).length, 1);
    assert.match(shell, /<ApkUpdateWorker \/>\s*<ProtStoreWorker \/>/);
    assert.match(
      shell,
      /import \{ ProtStoreWorker \} from "@revolt\/client\/ProtStoreWorker";/,
    );
  });
});
