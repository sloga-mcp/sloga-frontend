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
 * - a purchase the worker keeps under review (over the wallet cap, R63)
 *   reaches StoreShop unchanged and shows the under-review note there;
 * - and it opens the `prot_store_under_review` notice (R66) only from its
 *   kept branch, only while the run is live and only when
 *   `underReviewNotice` says so; the notice's body is the shop's own note;
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
const settings = readFileSync(
  new URL("../app/interface/settings/user/ProtSettings.tsx", import.meta.url),
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

  test("worker_under_review_outcome_shows_the_review_note", () => {
    // R63: the worker renders nothing. It records the kept state as the
    // flow made it (never a `why` of its own), and StoreShop shows the
    // outcome of a purchase the worker took through the same keptNote
    assert.doesNotMatch(worker, /\bwhy\s*:/);
    assert.doesNotMatch(worker, /"under_review"|"over_cap"/);
    const shop = settings.replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ");
    assert.match(
      shop,
      /const outcome = handedOutcome\(\); return outcome \? stateNote\(outcome\) : undefined;/,
    );
    assert.match(shop, /case "kept": return keptNote\(state\.why\);/);
    assert.match(
      shop,
      /case "under_review": return t`This purchase is under review because it would take your Prot wallet over its limit\. We'll add the Prot or help you get a refund\.`;/,
    );
  });

  test("worker_opens_the_review_notice_only_for_under_review", () => {
    // R66: the notice opens in one place, behind the live-run check and then
    // the pure `underReviewNotice` decision, and nowhere else
    const opens = [...worker.matchAll(/\bopenModal\(/g)];
    assert.equal(opens.length, 1, "one openModal( call");
    const notice = fnText("noticeUnderReview");
    assert.ok(notice.includes("openModal("), "it is in noticeUnderReview");
    const body = skipComments(notice.slice(notice.indexOf("{") + 1));
    assert.match(
      body,
      /^if \(run\.disposed \|\| claimOwners\.get\(key\) !== run\) return;/,
      "the first statement is the live-run check",
    );
    const decide = body.search(
      /if \(!underReviewNotice\(state, shown\)\) return;/,
    );
    const open = body.indexOf('openModal({ type: "prot_store_under_review" })');
    assert.ok(decide > 0, "underReviewNotice gates it");
    assert.ok(open > decide, "the open comes after the decision");
    // The shown keys come from storage and are written back before it opens
    assert.match(worker, /"sloga\.prot_store\.review_noticed"/);
    assert.ok(
      body.indexOf("writeNoticed(rememberNoticed(shown, key));") > decide,
    );
    // Held purchases in one drain share the notice already on screen
    assert.match(body, /isOpen\("prot_store_under_review"\)/);
    // It never finishes or consumes
    assert.doesNotMatch(notice, /\.finish\(|consume/);

    // Called once, from recover's kept branch only
    const calls = [...worker.matchAll(/\bnoticeUnderReview\(/g)];
    assert.equal(calls.length, 2, "its definition and one call");
    const recover = fnText("recover");
    const at = recover.indexOf('if (state.step === "kept") {');
    const end = recover.indexOf("\n    return;", at);
    assert.ok(at > 0 && end > at, "recover has its kept branch");
    assert.match(
      recover.slice(at, end),
      /noticeUnderReview\(run, key, state\);/,
    );
    // Never from the purchase sheet (it shows the inline note)
    assert.doesNotMatch(settings, /prot_store_under_review|noticeUnderReview/);
  });

  test("review_notice_reuses_the_shop_wording", () => {
    const modal = readFileSync(
      new URL("../modal/modals/ProtStoreUnderReview.tsx", import.meta.url),
      "utf8",
    );
    const shop = settings.replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ");
    const note = /case "under_review": return (t`[^`]*`);/.exec(shop);
    assert.ok(note, "keptNote's under_review returns a t`` note");
    // The body is the same msgid, byte for byte, once
    assert.equal(modal.split(note[1]).length - 1, 1, "the modal body");
    // Its only other copy: the new title and the existing "OK"
    const copy = [...modal.matchAll(/<Trans>([^<]*)<\/Trans>|\bt`([^`]*)`/g)];
    assert.deepEqual(
      copy.map((m) => m[1] ?? m[2]),
      ["Purchase under review", "OK", note[1].slice(2, -1)],
    );
    // No purchase detail reaches it
    assert.doesNotMatch(modal, /props\.(purchase|product|price|amount)|\$\{/);
    // Registered as a modal
    const types = readFileSync(
      new URL("../modal/types.ts", import.meta.url),
      "utf8",
    );
    const modals = readFileSync(
      new URL("../modal/modals.tsx", import.meta.url),
      "utf8",
    );
    assert.match(types, /type: "prot_store_under_review";\s*\}/);
    assert.match(
      modals,
      /case "prot_store_under_review":\s*return <ProtStoreUnderReviewModal \{\.\.\.modalProps\} \/>;/,
    );
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
