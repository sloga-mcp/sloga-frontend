// Spec for the Prot contribute / pledge dialog (S5b, contracts 16.3 L6d,
// 16.4, 17, 20.3), run with Node's built-in runner from packages/client:
//   node --conditions=browser --test components/modal/modals/protContribute.scan.test.ts
//
// ProtContribute.tsx imports Solid, lingui and the UI kit, so Node cannot
// load it. Its decisions sit in one marked region
// (`// prot-contribute-pure:begin` .. `// prot-contribute-pure:end`) with no
// imports; this spec cuts it out, strips the types with Node's own stripper
// and runs the real source. The wiring is checked by scanning the files.
//
//  C1  the seat notice is the pinned text byte for byte (the same constant
//      L6b pins against the server), and it is RENDERED: one element, the
//      last child of the dialog, straight above the buttons, outside every
//      Show / Switch / Match and every `{ … }` expression, with a style
//      that can neither hide nor collapse it (20.3 control);
//  C2  spending is gated (D5, 17): the confirm button exists only behind
//      `allowsProtSpending()`, `submit` checks it again before the only
//      `postContribute` / `postPledge` calls, and the form is offered only
//      when `contributeBlock` (which answers "store" first) is null;
//  C3  every attempt carries the dialog's client nonce, kept across every
//      failure (a refused retry does not prove an earlier lost attempt
//      missed) and dropped only by a success answer;
//  C4  the amount follows the advert (`min_contribution`, no fixed 50) and
//      a pledge's `open` (a completing pledge may be below the minimum);
//      the block rules: stages, goal state and deadline, Prot off;
//  C5  the D17 hold refusal (`ProtHeldPurchase`) names the advert's
//      `contribute_hold_hours`, never a fixed 72;
//  C6  hide-name is per server through `putContributorPrefs`, starts from
//      the caller's own line, reverts on failure, and Confirm waits for it;
//  C7  copy: the pinned labels, no bare English, no price or purchase text,
//      no blank-page traps;
//  C8  registration (L6h, contracts 16.3): `types.ts` declares
//      `"prot_contribute"` with the pinned props and `modals.tsx` has its
//      switch arm;
//  C9  a `ProtIdempotencyConflict` (an earlier attempt landed, then the
//      amount changed) drops the nonce, says the earlier attempt was added
//      without naming the new amount, and reloads (W6 audit fix).
//
// Point `PROT_CONTRIBUTE_FILE`, `PROT_TANK_FILE`, `PROT_MODAL_TYPES_FILE` or
// `PROT_MODALS_FILE` at another copy (a known-bad control) to check that
// instead; it must fail.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (env: string, fallback: string) =>
  readFileSync(process.env[env] || join(here, fallback), "utf8");

const source = read("PROT_CONTRIBUTE_FILE", "ProtContribute.tsx");
const tankSource = read("PROT_TANK_FILE", "../../client/protTank.ts");
const typesSource = read("PROT_MODAL_TYPES_FILE", "../types.ts");
const modalsSource = read("PROT_MODALS_FILE", "../modals.tsx");

const BEGIN = "// prot-contribute-pure:begin";
const END = "// prot-contribute-pure:end";

/** Contracts 16.4, the server's `PROT_SEAT_NOTICE` (89 bytes) */
const PINNED_NOTICE =
  "Contributing supports this server. It does not reserve a seat; the owner chooses members.";

type TargetState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "tank"; stage: string; canContribute: boolean }
  | { kind: "goal"; state: string; deadlineAt: number; open: number };
type Block = "store" | "disabled" | "loading" | "closed" | "notEligible" | null;
type NonceSlot = { amount: number; nonce: string };
interface Rules {
  contributeBlock(input: {
    spendingAllowed: boolean;
    enabled: boolean;
    minContribution: number;
    target: TargetState;
    nowMs: number;
  }): Block;
  goalOpen(goal: { target_prot: number; pledged_total: number }): number;
  nextNonce(
    unsettled: NonceSlot | undefined,
    amount: number,
    make: () => string,
  ): NonceSlot;
  outcomeUnknown(error: unknown): boolean;
  landedEarlier(error: unknown): boolean;
  ownHiddenPref(
    groups: readonly (readonly { you: boolean; hidden: boolean }[])[],
  ): boolean | null;
  walletHint(
    amount: number,
    me: { balance: number; held: number },
  ): "short" | "held" | null;
}
const RULE_NAMES = [
  "contributeBlock",
  "goalOpen",
  "nextNonce",
  "outcomeUnknown",
  "landedEarlier",
  "ownHiddenPref",
  "walletHint",
] as const;

let rulesPromise: Promise<Rules> | null = null;
function loadRules(): Promise<Rules> {
  rulesPromise ??= (async () => {
    const from = source.indexOf(BEGIN);
    const to = source.indexOf(END);
    assert.ok(from !== -1 && to > from, "prot-contribute-pure region missing");
    const region = source.slice(from, to);
    assert.ok(!/^\s*import\s/m.test(region), "the region must not import");
    const js =
      stripTypeScriptTypes(region, { mode: "strip" }) +
      `\nexport { ${RULE_NAMES.join(", ")} };\n`;
    const dir = mkdtempSync(join(tmpdir(), "s5bw6-L6d-"));
    const out = join(dir, "protContributePure.mjs");
    writeFileSync(out, js);
    const mod = (await import(pathToFileURL(out).href)) as Record<
      string,
      unknown
    >;
    for (const name of RULE_NAMES) {
      assert.equal(typeof mod[name], "function", `${name} missing`);
    }
    return mod as unknown as Rules;
  })();
  return rulesPromise;
}

/** Drop comments (block and whole-line) so prose never counts. */
function code(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const CODE = code(source);
const TYPES = code(typesSource);
const MODALS = code(modalsSource);

/** The component body: from its declaration to the pure region. */
function componentBody(): string {
  const from = source.indexOf("export function ProtContributeModal(");
  assert.ok(from !== -1, "ProtContributeModal missing");
  const to = source.indexOf(BEGIN, from);
  assert.ok(to > from, "the component must precede the pure region");
  return code(source.slice(from, to));
}

const BODY = componentBody();

/** The JSX the component returns: `<Dialog` .. its `</Dialog>`. */
function dialogJsx(): string {
  const from = BODY.indexOf("return (\n    <Dialog");
  assert.ok(from !== -1, "the component must return a <Dialog>");
  const to = BODY.lastIndexOf("</Dialog>");
  assert.ok(to > from, "</Dialog> missing");
  return BODY.slice(from, to + "</Dialog>".length);
}

const JSX = dialogJsx();

/** The body of `function name(` (or `async function name(`) in BODY. */
function fnBody(name: string): string {
  const at = BODY.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(at !== -1, `${name} missing`);
  const open = BODY.indexOf("{\n", at);
  let depth = 0;
  for (let i = open; i < BODY.length; i++) {
    if (BODY[i] === "{") depth++;
    if (BODY[i] === "}" && --depth === 0) return BODY.slice(open, i + 1);
  }
  assert.fail(`${name} never closes`);
}

const CONTROL_TAG =
  "Show|Switch|Match|For|Index|Suspense|ErrorBoundary|Portal|Dynamic";

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

const tank = (stage: string, canContribute = true): TargetState => ({
  kind: "tank",
  stage,
  canContribute,
});
const NOW = 1_800_000_000_000;
const goal = (over: Partial<Extract<TargetState, { kind: "goal" }>> = {}) =>
  ({
    kind: "goal",
    state: "Funding",
    deadlineAt: NOW + 1,
    open: 300,
    ...over,
  }) as TargetState;
const open = (target: TargetState) => ({
  spendingAllowed: true,
  enabled: true,
  minContribution: 50,
  target,
  nowMs: NOW,
});

describe("Prot contribute dialog (lane L6d)", () => {
  it("C1 renders the verbatim seat notice above the buttons, never hidden", () => {
    // The pinned text, and the same constant L6b pins against the server
    const pinned = tankSource.match(
      /export const PROT_SEAT_NOTICE_EN =\s*"([^"]*)";/,
    );
    assert.ok(pinned, "protTank.ts lacks PROT_SEAT_NOTICE_EN");
    assert.equal(pinned[1], PINNED_NOTICE, "PROT_SEAT_NOTICE_EN changed");
    assert.equal(Buffer.byteLength(PINNED_NOTICE, "utf8"), 89);
    assert.match(
      CODE,
      /import \{[^}]*\bPROT_SEAT_NOTICE_EN\b[^}]*\} from "@revolt\/client\/protTank";/,
    );

    // The msgid is the verbatim text, in one literal (a wrapped <Trans>
    // could drift from the catalog's msgid)
    const notice = fnBody("seatNotice");
    assert.ok(
      notice.includes("t`" + PINNED_NOTICE + "`"),
      "seatNotice() must return t`<the verbatim notice>`",
    );
    assert.equal(
      count(CODE, new RegExp(PINNED_NOTICE.replace(/[.;]/g, "\\$&"), "g")),
      1,
      "the notice literal appears once",
    );
    // Only the server's own `notice` may replace it
    assert.match(
      notice,
      /if \(server !== PROT_SEAT_NOTICE_EN\) return server;/,
    );
    assert.match(notice, /state\.view\.notice/);
    assert.match(notice, /state\.goal\.notice/);

    // Rendered exactly once, bare
    assert.equal(count(JSX, /<SeatNotice\b/g), 1, "one <SeatNotice>");
    assert.match(
      JSX,
      /<SeatNotice role="note">\{seatNotice\(\)\}<\/SeatNotice>/,
      'rendered as <SeatNotice role="note">{seatNotice()}</SeatNotice>',
    );

    // Outside every control-flow tag and every `{ … }` expression
    const before = JSX.slice(0, JSX.indexOf("<SeatNotice"));
    const opened = count(before, new RegExp(`<(?:${CONTROL_TAG})\\b`, "g"));
    const closed = count(before, new RegExp(`</(?:${CONTROL_TAG})>`, "g"));
    assert.equal(opened - closed, 0, "the notice sits inside a control tag");
    assert.equal(
      count(before, /\{/g) - count(before, /\}/g),
      0,
      "the notice sits inside a { … } expression",
    );
    assert.doesNotMatch(before, /<details\b|<summary\b/, "never collapsible");

    // The last child: only closing tags between it and </Dialog>, so the
    // Dialog's action row (rendered after its children) follows it
    const after = JSX.slice(
      JSX.indexOf("</SeatNotice>") + "</SeatNotice>".length,
      JSX.lastIndexOf("</Dialog>"),
    );
    assert.match(after, /^\s*(?:<\/Column>\s*)*$/, "not the last child");

    // A style that cannot hide or collapse it
    const style = source.match(
      /const SeatNotice = styled\("p", \{\n {2}base: \{\n([\s\S]*?)\n {2}\},\n\}\);/,
    );
    assert.ok(style, 'SeatNotice must be styled("p", { base: { … } })');
    assert.doesNotMatch(
      style[1],
      /display|visibility|opacity|overflow|height|maxHeight|lineClamp|LineClamp|textOverflow|whiteSpace|position|clip|transform|fontSize: 0/,
      "SeatNotice style can hide or clamp the notice",
    );
  });

  it("C2 gates every spend on allowsProtSpending() (D5)", async () => {
    assert.match(
      CODE,
      /import \{ allowsProtSpending \} from "@revolt\/client\/distribution";/,
    );

    // The only spend calls live in submit, after the gate
    assert.equal(count(CODE, /\bpostContribute\(/g), 1, "one postContribute");
    assert.equal(count(CODE, /\bpostPledge\(/g), 1, "one postPledge");
    const submit = fnBody("submit");
    const gate = submit.indexOf("if (!allowsProtSpending()) return;");
    assert.ok(gate !== -1, "submit lacks its allowsProtSpending() gate");
    assert.ok(
      gate < submit.indexOf("postContribute(") &&
        gate < submit.indexOf("postPledge("),
      "a spend call runs before the gate",
    );
    assert.ok(
      submit.indexOf("if (!canSubmit()) return;") > gate,
      "submit checks canSubmit() after the gate",
    );

    // The confirm button exists only behind the gate
    const actions = JSX.slice(
      JSX.indexOf("actions={["),
      JSX.indexOf("isDisabled={submitting()}"),
    );
    assert.ok(actions.length > 0, "actions={[ … ]} missing");
    const gated = actions.indexOf("...(allowsProtSpending()");
    assert.ok(gated !== -1, "the confirm action is not behind the gate");
    assert.ok(actions.indexOf("void submit()") > gated, "ungated confirm");
    assert.equal(count(actions, /void submit\(\)/g), 1);

    // The form (Enter submits) is offered only when nothing blocks it, and
    // "store" is the first block
    assert.match(BODY, /spendingAllowed: allowsProtSpending\(\),/);
    const form = JSX.indexOf("<form");
    const offered = JSX.lastIndexOf("<Match when={block() === null}>", form);
    assert.ok(offered !== -1, "the form must sit under block() === null");
    assert.match(BODY, /const canSubmit = \(\) =>\s*block\(\) === null &&/);

    // The wallet is read only where it is shown
    assert.match(
      fnBody("loadWallet"),
      /if \(!allowsProtSpending\(\)\) return;/,
    );

    const r = await loadRules();
    assert.equal(
      r.contributeBlock({ ...open(tank("Active")), spendingAllowed: false }),
      "store",
    );
    // "store" wins over every other block
    for (const target of [
      { kind: "loading" } as TargetState,
      { kind: "missing" } as TargetState,
      tank("Deleted"),
    ]) {
      assert.equal(
        r.contributeBlock({
          ...open(target),
          spendingAllowed: false,
          enabled: false,
        }),
        "store",
      );
    }
  });

  it("C3 sends one client nonce per dialog until an attempt succeeds", async () => {
    const submit = fnBody("submit");
    assert.match(
      submit,
      /const slot = nextNonce\(unsettled, value, \(\) => ulid\(\)\);/,
    );
    assert.equal(count(submit, /nonce: slot\.nonce,/g), 2, "both requests");
    assert.equal(
      count(submit, /^\s*unsettled = undefined;$/gm),
      2,
      "the two success paths settle the nonce",
    );
    // A refusal of a retry never drops the nonce: an earlier attempt with
    // it may have landed, and a fresh nonce would post twice. The one
    // exception is the idempotency conflict (C9).
    const failure = submit.slice(
      submit.indexOf("} catch (error) {"),
      submit.indexOf("} finally {"),
    );
    assert.ok(failure.length > 0, "submit lacks its catch block");
    assert.doesNotMatch(
      failure.replace("if (landed) unsettled = undefined;", ""),
      /unsettled\s*=/,
      "a failure other than the conflict drops the nonce",
    );
    assert.match(failure, /setError\(describeSubmit\(error\)\);/);
    for (const call of ["postContribute(", "postPledge("]) {
      const at = submit.indexOf(call);
      assert.match(
        submit.slice(at, submit.indexOf("unsettled = undefined;", at)),
        /^[^]*?\);\s*$/,
        `${call} must settle the nonce right after its answer`,
      );
    }
    assert.match(CODE, /import \{ ulid \} from "ulid";/);

    const r = await loadRules();
    let made = 0;
    const make = () => `n${++made}`;
    assert.deepEqual(r.nextNonce(undefined, 100, make), {
      amount: 100,
      nonce: "n1",
    });
    // Unknown outcome: the same nonce, even for a changed amount
    assert.deepEqual(r.nextNonce({ amount: 100, nonce: "n1" }, 250, make), {
      amount: 250,
      nonce: "n1",
    });
    assert.equal(made, 1, "no new nonce for an unsettled attempt");
    assert.equal(r.nextNonce({ amount: 1, nonce: "" }, 1, make).nonce, "n2");

    // An answer from the server: nothing was written
    assert.equal(r.outcomeUnknown({ type: "ProtHeldPurchase" }), false);
    assert.equal(r.outcomeUnknown({ type: "InternalError" }), false);
    assert.equal(r.outcomeUnknown({ kind: "rateLimited" }), false);
    // No readable answer: it may have landed
    assert.equal(r.outcomeUnknown({ kind: "badResponse" }), true);
    assert.equal(r.outcomeUnknown(new TypeError("Failed to fetch")), true);
    assert.equal(r.outcomeUnknown(new Error("502 Bad Gateway")), true);
    assert.equal(r.outcomeUnknown(null), true);
    assert.equal(r.outcomeUnknown(undefined), true);
  });

  it("C9 treats an idempotency conflict as the earlier attempt landing", async () => {
    // Lost answer, then a changed amount: the same nonce comes back as
    // ProtIdempotencyConflict. Keeping the nonce would repeat that on every
    // retry, so the conflict ends it.
    const submit = fnBody("submit");
    const failure = submit.slice(
      submit.indexOf("} catch (error) {"),
      submit.indexOf("} finally {"),
    );
    assert.match(
      failure,
      /const landed = landedEarlier\(error\);\s*if \(landed\) unsettled = undefined;\s*if \(unmounted\) return;/,
      "the conflict must drop the nonce before anything else",
    );
    // The earlier amount went in, not this one: the already-added copy (never
    // the "was added" lines naming the new amount), no error, no close
    const branch = failure.slice(
      failure.indexOf("if (landed) {"),
      failure.indexOf("} else {"),
    );
    assert.ok(branch.length > 0, "the conflict branch is missing");
    assert.ok(
      branch.includes(
        "t`This was already added earlier, so nothing more was taken from your wallet.`",
      ),
      "the conflict shows the already-added copy",
    );
    assert.match(branch, /setNote\(/);
    assert.match(branch, /props\.onDone\?\.\(\);/);
    assert.doesNotMatch(branch, /was added\.`|finish\(|setError\(/);
    assert.match(
      failure.slice(failure.indexOf("} else {")),
      /setError\(describeSubmit\(error\)\);[\s\S]*void loadWallet\(\);\s*void loadTarget\(\);/,
      "every failure reloads the wallet and the target",
    );

    const r = await loadRules();
    assert.equal(r.landedEarlier({ type: "ProtIdempotencyConflict" }), true);
    for (const other of [
      { type: "ProtHeldPurchase" },
      { type: "InsufficientProt" },
      { kind: "badResponse" },
      { kind: "rateLimited" },
      new TypeError("Failed to fetch"),
      null,
      undefined,
      "ProtIdempotencyConflict",
    ]) {
      assert.equal(r.landedEarlier(other), false, String(other));
    }
    // The conflict is an answer, not an unknown outcome
    assert.equal(r.outcomeUnknown({ type: "ProtIdempotencyConflict" }), false);
    // After the drop, the next attempt gets a fresh nonce
    let made = 0;
    assert.equal(r.nextNonce(undefined, 75, () => `x${++made}`).nonce, "x1");
  });

  it("C4 takes the minimum from the advert and lets a pledge complete a goal", async () => {
    assert.match(
      BODY,
      /contributionAmountProblem\(\s*amount\(\),\s*tankFeature\(\)\.min_contribution,\s*open\(\),\s*\)/,
    );
    assert.match(BODY, /minContribution: tankFeature\(\)\.min_contribution,/);
    assert.match(BODY, /parseProtTankFeature\(/);
    assert.doesNotMatch(CODE, /\b50\b/, "no fixed minimum");
    // A goal needing less than the minimum hides the minimum line
    assert.match(
      BODY,
      /return need === undefined \|\| need >= tankFeature\(\)\.min_contribution;/,
    );

    const r = await loadRules();
    // Prot off, or no usable minimum (an invalid config advertises 0)
    assert.equal(
      r.contributeBlock({ ...open(tank("Active")), enabled: false }),
      "disabled",
    );
    for (const min of [0, -1, Number.NaN, 1.5]) {
      assert.equal(
        r.contributeBlock({ ...open(tank("Active")), minContribution: min }),
        "disabled",
        String(min),
      );
    }
    assert.equal(r.contributeBlock(open({ kind: "loading" })), "loading");
    assert.equal(r.contributeBlock(open({ kind: "missing" })), "closed");
    // Only Active, Grace and Frozen take top-ups (8.8)
    for (const stage of ["Active", "Grace", "Frozen"]) {
      assert.equal(r.contributeBlock(open(tank(stage))), null, stage);
      assert.equal(
        r.contributeBlock(open(tank(stage, false))),
        "notEligible",
        stage,
      );
    }
    for (const stage of [
      "Launching",
      "Settling",
      "Deleted",
      "Terminated",
      "Unknown",
    ]) {
      assert.equal(r.contributeBlock(open(tank(stage))), "closed", stage);
    }
    // A goal: Funding, before its deadline, needing something (8.3)
    assert.equal(r.contributeBlock(open(goal())), null);
    assert.equal(r.contributeBlock(open(goal({ deadlineAt: NOW }))), "closed");
    assert.equal(r.contributeBlock(open(goal({ open: 0 }))), "closed");
    for (const state of ["Funded", "Launching", "Expired", "Cancelled"]) {
      assert.equal(r.contributeBlock(open(goal({ state }))), "closed", state);
    }

    assert.equal(r.goalOpen({ target_prot: 1200, pledged_total: 1170 }), 30);
    assert.equal(r.goalOpen({ target_prot: 1200, pledged_total: 1200 }), 0);
    assert.equal(r.goalOpen({ target_prot: 1200, pledged_total: 1300 }), 0);

    assert.equal(r.walletHint(100, { balance: 50, held: 0 }), "short");
    assert.equal(r.walletHint(100, { balance: 150, held: 60 }), "held");
    assert.equal(r.walletHint(90, { balance: 150, held: 60 }), null);
    assert.equal(r.walletHint(Number.NaN, { balance: 0, held: 0 }), null);
  });

  it("C5 explains the purchase hold with the advert's hours (D17)", () => {
    const submitText = fnBody("describeSubmit");
    assert.match(
      submitText,
      /if \(\(error as \{ type\?: unknown \}\)\.type === "ProtHeldPurchase"\) \{\s*return holdLine\(\) \?\? err\(error\);/,
    );
    const hold = fnBody("holdLine");
    assert.match(hold, /tankFeature\(\)\.contribute_hold_hours/);
    assert.ok(
      hold.includes(
        "t`Prot bought in the last ${hours} hours can't be contributed yet.`",
      ),
      "the pinned hold copy (16.4)",
    );
    // 0 hours (an unreadable advert) falls back to the error cast
    assert.match(hold, /if \(value <= 0\) return undefined;/);
    assert.doesNotMatch(CODE, /\b72\b/, "no fixed hold length");
  });

  it("C6 saves hide-name per server and waits for it", async () => {
    assert.match(
      BODY,
      /\(target\.kind === "tank" \? target\.channel\.serverId : target\.serverId\) \|\|\s*undefined;/,
    );
    const toggle = fnBody("toggleHidden");
    assert.match(
      toggle,
      /await putContributorPrefs\(api, serverId, \{ hidden: next \}\);/,
    );
    assert.match(toggle, /setHidden\(before\);/, "a failed save reverts");
    assert.equal(count(CODE, /\bputContributorPrefs\(/g), 1);
    assert.match(BODY, /!prefSaving\(\);/, "Confirm waits for the save");
    assert.match(JSX, /<Trans>Hide my name<\/Trans>/);
    assert.match(BODY, /setHidden\(ownHiddenPref\(groups\)\);/);

    const r = await loadRules();
    const line = (you: boolean, hidden: boolean) => ({ you, hidden });
    assert.equal(r.ownHiddenPref([]), null);
    assert.equal(r.ownHiddenPref([[line(false, true)]]), null);
    assert.equal(
      r.ownHiddenPref([[line(false, false), line(true, true)]]),
      true,
    );
    assert.equal(r.ownHiddenPref([[], [line(true, false)]]), false);
  });

  it("C7 uses the pinned copy and avoids the blank-page traps", () => {
    for (const label of [
      "<Trans>Top up</Trans>",
      "<Trans>Pledge</Trans>",
      "<Trans>Contribute</Trans>",
      "<Trans>Goal</Trans>",
      "<Trans>Hide my name</Trans>",
      "<Trans>Cancel</Trans>",
    ]) {
      assert.ok(JSX.includes(label), `${label} missing`);
    }
    assert.ok(BODY.includes("t`This goal is closed.`"));

    // JSX text is only ever inside <Trans>
    for (const m of JSX.matchAll(/>\s*([A-Za-z][^<>{}();=]*?)\s*</g)) {
      assert.equal(
        JSX.slice(Math.max(0, (m.index ?? 0) - 6), (m.index ?? 0) + 1),
        "<Trans>",
        `bare JSX text: ${m[1]}`,
      );
    }

    // No price or purchase text (17), and "Protected" never alone
    const messages = [
      ...[...BODY.matchAll(/\bt`([^`]*)`/g)].map((m) => m[1]),
      ...[...JSX.matchAll(/<Trans>([\s\S]*?)<\/Trans>/g)].map((m) => m[1]),
    ];
    assert.ok(messages.length > 20, "messages found");
    for (const message of messages) {
      assert.doesNotMatch(
        message,
        /\bbuy\b|\bprice|purchase|checkout|sloga\.gg|Stripe|USD|\$\d|cents?\b/i,
        message,
      );
      assert.doesNotMatch(message, /\bProtected\b(?! channel)/, message);
    }

    assert.doesNotMatch(CODE, /\bstyled\(\s*[A-Z]/, "styled(Component)");
    assert.doesNotMatch(CODE, /from "@revolt\/ui";/, "@revolt/ui barrel");
    assert.doesNotMatch(CODE, /features\/legacy/, "legacy barrel");
    assert.doesNotMatch(CODE, /\.message\b/, "never read an error's message");
    assert.doesNotMatch(CODE, /\bshowError\b/, "never the generic error modal");
    assert.doesNotMatch(CODE, /String\(err/, "never stringify the error");
    assert.doesNotMatch(CODE, /use:floating/, "use:floating on styled()");
  });

  it("C8 is registered as the pinned modal type (L6h)", () => {
    assert.match(
      BODY,
      /props: DialogProps & Modals & \{ type: "prot_contribute" \},/,
    );
    const at = TYPES.indexOf('type: "prot_contribute";');
    assert.ok(at !== -1, 'types.ts lacks type: "prot_contribute"');
    const entry = TYPES.slice(at, at + 400);
    assert.match(
      entry,
      /target:\s*\|?\s*\{\s*kind: "tank";\s*channel: Channel;?\s*\}\s*\|\s*\{\s*kind: "goal";\s*goalId: string;\s*serverId: string;?\s*\};/,
      "pinned target prop changed",
    );
    assert.match(entry, /onDone\?: \(\) => void;/, "pinned onDone prop");

    assert.match(
      MODALS,
      /import \{ ProtContributeModal \} from "\.\/modals\/ProtContribute";/,
    );
    const arm = MODALS.indexOf('case "prot_contribute":');
    assert.ok(arm !== -1, 'modals.tsx has no case "prot_contribute"');
    assert.match(
      MODALS.slice(arm, arm + 120),
      /return <ProtContributeModal \{\.\.\.modalProps\} \/>;/,
    );
  });
});
