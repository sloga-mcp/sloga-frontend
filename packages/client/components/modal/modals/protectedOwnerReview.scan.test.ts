// Spec for the Protected channel owner-change review modal (S2-D41, OR-10,
// W4-3 lane U7), run with Node's built-in runner from packages/client:
//   node --conditions=browser --test components/modal/modals/protectedOwnerReview.scan.test.ts
//
// ProtectedOwnerReview.tsx imports Solid, lingui and the UI kit, so Node
// cannot load it. Its rules sit in one marked region
// (`// protected-pure:begin` .. `// protected-pure:end`) with no imports;
// this spec cuts it out, strips the types with Node's own stripper and runs
// the real source. The wiring is checked by scanning the component.
//
//  R1  unlisted (OR-10: the view flag or the shield notice) shows its own
//      panel and never the review button, whatever the shield offers;
//  R2  the review is offered only on `reviewOffered === true`;
//  R3  a Declined review keeps the channel locked: "Still locked.",
//      "Review again", "Leave channel" (D41);
//  R4  Declined is recognised in both native shapes and nothing else;
//  R5  the native dialog opens only from the review button's click, and
//      that button exists only while the panel offers it;
//  R6  the review decision comes from F1 `reviewOffered` only, never from
//      `protectedNoticeForError` or the notice;
//  R7  no id, key or fingerprint is ever rendered;
//  R8  copy comes from protectedCopy (no new msgids, no bare literals);
//  R9  "Leave channel" only navigates away;
//  R10 blank-page traps;
//  R11 failures map through `protectedNoticeForError(err, {op: "owner"})` and
//      `errorUiCopy`, never an error's `message`;
//  R12 the props type is exported for the modal union (L9).
//
// Point `PROTECTED_OWNER_REVIEW_FILE` at another copy (a known-bad control)
// to check that instead; it must fail.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  process.env.PROTECTED_OWNER_REVIEW_FILE ||
    join(here, "ProtectedOwnerReview.tsx"),
  "utf8",
);

const BEGIN = "// protected-pure:begin";
const END = "// protected-pure:end";

type PanelKind = "review" | "declined" | "unlisted" | "settled";
interface Panel {
  kind: PanelKind;
  confirm: boolean;
  leave: boolean;
}
interface Rules {
  ownerReviewUnlisted(view: unknown, notice: unknown): boolean;
  ownerReviewPanel(i: {
    unlisted: boolean;
    reviewOffered: unknown;
    declined: boolean;
  }): Panel;
  ownerReviewDeclined(err: unknown): boolean;
}
const RULE_NAMES = [
  "ownerReviewUnlisted",
  "ownerReviewPanel",
  "ownerReviewDeclined",
] as const;

let rulesPromise: Promise<Rules> | null = null;
function loadRules(): Promise<Rules> {
  rulesPromise ??= (async () => {
    const from = source.indexOf(BEGIN);
    const to = source.indexOf(END);
    assert.ok(from !== -1 && to > from, "protected-pure region missing");
    const region = source.slice(from, to);
    assert.ok(!/^\s*import\s/m.test(region), "the region must not import");
    // The component exports them; export them once, below.
    const local = region.replace(/^export /gm, "");
    const js =
      stripTypeScriptTypes(local, { mode: "strip" }) +
      `\nexport { ${RULE_NAMES.join(", ")} };\n`;
    const dir = mkdtempSync(join(tmpdir(), "s2w43-U7-"));
    const out = join(dir, "protectedOwnerReviewPure.mjs");
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

/** Drop comments (block, JSX block and whole-line) so prose never counts. */
function code(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const CODE = code(source);

/** The component body: from its declaration to the pure region. */
function componentBody(): string {
  const from = source.indexOf("export function ProtectedOwnerReviewModal(");
  assert.ok(from !== -1, "ProtectedOwnerReviewModal missing");
  const to = source.indexOf(BEGIN, from);
  assert.ok(to > from, "the component must precede the pure region");
  return code(source.slice(from, to));
}

const BODY = componentBody();

/** A slice of the component body from `head` to the first `end` after it. */
function block(head: string, end: string): string {
  const from = BODY.indexOf(head);
  assert.ok(from !== -1, `${head} missing`);
  const to = BODY.indexOf(end, from + head.length);
  assert.ok(to > from, `${head} has no end`);
  return BODY.slice(from, to + end.length);
}

const reviewFn = () => block("async function review() {", "\n  }\n");
const actionsFn = () =>
  block("const actions = (): DialogAction[] => {", "\n  };\n");
const linesFn = () => block("const lines = (): string[] => {", "\n  };\n");
const panelFn = () => block("const panel = () =>", "});\n");
const unlistedFn = () => block("const unlisted = () => {", "\n  };\n");
const leaveFn = () => block("function leave() {", "\n  }\n");
const renderBlock = () => block("  return (\n    <Dialog", "\n  );\n");

const count = (s: string, needle: string) => s.split(needle).length - 1;

const OFFERED = { unlisted: false, reviewOffered: true, declined: false };

test("R1 unlisted shows the OR-10 panel and never the review, whatever the shield offers", async () => {
  const r = await loadRules();
  for (const reviewOffered of [true, false, undefined]) {
    for (const declined of [false, true]) {
      assert.deepEqual(
        r.ownerReviewPanel({ unlisted: true, reviewOffered, declined }),
        { kind: "unlisted", confirm: false, leave: true },
        `unlisted, reviewOffered=${String(reviewOffered)}, declined=${declined}`,
      );
    }
  }
  // Either source of "unlisted" counts; neither alone is required.
  assert.equal(
    r.ownerReviewUnlisted({ ownerChangeUnlisted: true }, null),
    true,
  );
  assert.equal(
    r.ownerReviewUnlisted(null, "owner_changed_unlisted"),
    true,
    "the shield's OR-10 notice alone is unlisted",
  );
  assert.equal(
    r.ownerReviewUnlisted(
      { ownerChangeUnlisted: false },
      "owner_changed_review",
    ),
    false,
  );
  assert.equal(
    r.ownerReviewUnlisted({ ownerChangeUnlisted: "true" }, null),
    false,
  );
  assert.equal(r.ownerReviewUnlisted(undefined, undefined), false);
  // The component feeds the panel from both sources, and shows OR-10 copy.
  const unlisted = unlistedFn();
  assert.match(unlisted, /ownerReviewUnlisted\(s\?\.view, s\?\.notice\)/);
  assert.match(panelFn(), /unlisted: unlisted\(\),/);
  assert.match(
    linesFn(),
    /case "unlisted":\s*return \[noticeCopy\("owner_changed_unlisted"\)\];/,
  );
});

test("R2 the review is offered only on reviewOffered === true", async () => {
  const r = await loadRules();
  assert.deepEqual(r.ownerReviewPanel(OFFERED), {
    kind: "review",
    confirm: true,
    leave: false,
  });
  for (const reviewOffered of [false, undefined, null, "true", 1, {}]) {
    assert.deepEqual(
      r.ownerReviewPanel({ unlisted: false, reviewOffered, declined: false }),
      { kind: "settled", confirm: false, leave: false },
      `reviewOffered=${JSON.stringify(reviewOffered)} offers nothing`,
    );
    // A Declined never revives a review the shield no longer offers.
    assert.deepEqual(
      r.ownerReviewPanel({ unlisted: false, reviewOffered, declined: true }),
      { kind: "settled", confirm: false, leave: false },
    );
  }
});

test("R3 a Declined review keeps the channel locked: Still locked, Review again, Leave channel", async () => {
  const r = await loadRules();
  assert.deepEqual(r.ownerReviewPanel({ ...OFFERED, declined: true }), {
    kind: "declined",
    confirm: true,
    leave: true,
  });
  // Wiring: a Declined rejection sets the latch, a success clears it.
  const review = reviewFn();
  assert.match(
    review,
    /if \(ownerReviewDeclined\(err\)\) \{\s*setDeclined\(true\);\s*\} else \{/,
  );
  assert.match(
    review,
    /await api\.confirmOwnerChange\(channelId\);\s*setDeclined\(false\);/,
  );
  assert.match(panelFn(), /declined: declined\(\),/);
  // Copy: "Still locked." leads the declined panel; the buttons are D41's.
  assert.match(
    linesFn(),
    /case "declined":\s*return \[\s*panelCopy\.ownerReviewStillLocked\(\),/,
  );
  const actions = actionsFn();
  assert.match(
    actions,
    /p\.kind === "declined"\s*\?\s*panelCopy\.reviewAgain\(\)\s*:\s*panelCopy\.reviewOwnerChange\(\)/,
  );
  assert.match(
    actions,
    /if \(p\.leave\) \{\s*list\.push\(\{ text: panelCopy\.leaveChannel\(\), onClick: leave \}\);/,
  );
});

test("R4 Declined is recognised in both native shapes and nothing else", async () => {
  const r = await loadRules();
  assert.equal(
    r.ownerReviewDeclined({ source: "native", error: { type: "declined" } }),
    true,
  );
  assert.equal(r.ownerReviewDeclined({ type: "declined" }), true);
  for (const err of [
    null,
    undefined,
    "declined",
    new Error("declined"),
    { source: "native", error: { type: "owner_changed", same_user: false } },
    { source: "native", error: "declined" },
    { source: "native", error: null },
    { source: "server", type: "declined", status: 400 },
    { source: "client", reason: "declined" },
    { source: "transport", type: "declined" },
    { type: "busy" },
  ]) {
    assert.equal(r.ownerReviewDeclined(err), false, JSON.stringify(err));
  }
});

test("R5 the native dialog opens only from the review button and only while offered", () => {
  // One call site: inside review(), after the offer guard.
  assert.equal(count(CODE, "confirmOwnerChange("), 1);
  const review = reviewFn();
  assert.ok(review.includes("confirmOwnerChange("));
  assert.match(
    review,
    /^async function review\(\) \{\s*if \(pending\(\) \|\| !panel\(\)\.confirm\) return;/,
  );
  // review() is invoked only from the confirm action's click.
  assert.equal(count(BODY, "review()"), 2, "the definition and one call");
  const actions = actionsFn();
  assert.match(
    actions,
    /if \(p\.confirm\) \{\s*list\.push\(\{[\s\S]*?onClick: \(\) => \{\s*void review\(\);\s*return false;/,
  );
  // Nothing opens it on mount or from an effect.
  for (const auto of [
    "onMount",
    "createEffect",
    "createRenderEffect",
    "queueMicrotask",
    "setTimeout",
  ]) {
    assert.ok(!CODE.includes(auto), `${auto} must not appear`);
  }
  // The dialog cannot be dismissed while native's dialog is open.
  assert.match(
    BODY,
    /function close\(\) \{\s*if \(!pending\(\)\) props\.onClose\(\);/,
  );
  assert.match(renderBlock(), /onClose=\{close\}/);
});

test("R6 the review decision comes from reviewOffered only", () => {
  assert.match(panelFn(), /reviewOffered: shield\(\)\?\.reviewOffered,/);
  // The pure rule reads it strictly.
  const pure = source.slice(source.indexOf(BEGIN), source.indexOf(END));
  assert.match(pure, /if \(i\.reviewOffered !== true\) \{/);
  // protectedNoticeForError appears once: the failure copy in review()'s
  // non-Declined branch, after the decision was made.
  assert.equal(count(CODE, "protectedNoticeForError("), 1);
  const review = reviewFn();
  const decided = review.indexOf("ownerReviewDeclined(err)");
  const mapped = review.indexOf("protectedNoticeForError(");
  assert.ok(decided !== -1 && mapped > decided);
  // No other input decides it: not the notice, nor the pin, nor the pill.
  for (const other of [
    "pillOwnerChangeReviewable",
    "ownerChangePending",
    "owner_pin",
    '=== "owner_changed_review"',
  ]) {
    assert.ok(!CODE.includes(other), `${other} must not decide the review`);
  }
});

test("R7 no id, key or fingerprint is ever rendered", () => {
  for (const banned of [
    /\bdevice_id\b/,
    /\buser_id\b/,
    /pending_signer/,
    /owner_pin/,
    /fingerprint/i,
    /safety/i,
    /group_id/,
    /\bsigner/,
    /selfDeviceId/,
    /seatsSnapshot/,
  ]) {
    assert.ok(!banned.test(CODE), `${banned} must not appear in code`);
  }
  // The render holds no id at all, and its only text children are the
  // copy lines and the failure copy.
  const render = renderBlock();
  assert.ok(!/\.id\b|Id\b/.test(render), "no id in the render");
  const children = [...render.matchAll(/>\s*\{([^{}]*)\}\s*</g)].map((m) =>
    m[1].trim(),
  );
  assert.deepEqual(children.sort(), ["line", "text()"]);
  // Every body line is a copy function call.
  const arrays = [...linesFn().matchAll(/return \[([\s\S]*?)\];/g)].map(
    (m) => m[1],
  );
  assert.ok(arrays.length >= 4, "every panel returns its lines");
  for (const a of arrays) {
    const rest = a
      .replace(/noticeCopy\((?:"[a-z_]+"|notice)\)/g, "")
      .replace(/panelCopy\.\w+\((?:"[a-z_]+")?\)/g, "")
      .replace(/[\s,]/g, "");
    assert.equal(rest, "", `a body line is not a copy call: ${a.trim()}`);
  }
  assert.match(
    linesFn(),
    /return notice === null \? \[\] : \[noticeCopy\(notice\)\];/,
  );
  // The failure line is copy too.
  for (const m of BODY.matchAll(/setFailure\(([\s\S]*?)\);\n/g)) {
    assert.match(m[1], /^(null|errorUiCopy\(|\s*noticeCopy\()/, m[1]);
  }
});

test("R8 copy comes from protectedCopy; no new msgids, no bare literals", () => {
  assert.match(renderBlock(), /title=\{panelCopy\.reviewOwnerChange\(\)\}/);
  for (const used of [
    "panelCopy.ownerReviewStillLocked()",
    "panelCopy.reviewAgain()",
    "panelCopy.leaveChannel()",
    'noticeCopy("owner_changed_unlisted")',
    'noticeCopy("owner_changed_review")',
    'panelCopy.ownerPin("changed")',
  ]) {
    assert.ok(CODE.includes(used), `${used} missing`);
  }
  // No local msgids: only the existing "Cancel" and "Close".
  assert.ok(!/\bt`|\bt\(\{/.test(CODE), "no t`` msgids here");
  const trans = [...CODE.matchAll(/<Trans>([\s\S]*?)<\/Trans>/g)].map((m) =>
    m[1].trim(),
  );
  assert.deepEqual([...new Set(trans)].sort(), ["Cancel", "Close"]);
  // No bare English between JSX tags (the render and the action labels).
  const jsx = renderBlock() + actionsFn();
  const bare = [...jsx.matchAll(/>\s*([A-Za-z][^<>{}]*?)\s*</g)]
    .map((m) => m[1])
    .filter((s) => s !== "Cancel" && s !== "Close");
  assert.deepEqual(bare, []);
  // Exhaustive over the panel kinds.
  assert.match(linesFn(), /const _exhaustive: never = p\.kind;/);
});

test("R9 Leave channel only navigates away", () => {
  const leave = leaveFn();
  assert.match(
    leave,
    /navigate\(serverId \? `\/server\/\$\{serverId\}` : "\/app"\);/,
  );
  for (const act of [
    "api.",
    "ui()",
    "delete",
    "leave(",
    "protectedClose",
    "fetch",
  ]) {
    assert.ok(
      !leave.slice("function leave() {".length).includes(act),
      `leave() must not call ${act}`,
    );
  }
});

test("R10 blank-page traps: string-tag styled only, no use:floating, no barrels", () => {
  const styledCalls = [...CODE.matchAll(/\bstyled\(\s*([^,)]*)/g)].map((m) =>
    m[1].trim(),
  );
  assert.ok(styledCalls.length > 0);
  for (const arg of styledCalls) {
    assert.match(arg, /^"[a-z]+"$/, `styled(${arg}) must take a string tag`);
  }
  assert.ok(!CODE.includes("use:floating"));
  assert.ok(!/features\/legacy["/]/.test(CODE));
  assert.ok(!/from "@revolt\/ui"/.test(CODE), "import files, not the barrel");
});

test("R11 failures map through protectedNoticeForError op owner and errorUiCopy", () => {
  const review = reviewFn();
  assert.match(
    review,
    /const answer = protectedNoticeForError\(err, \{ op: "owner" \}\);/,
  );
  assert.match(
    review,
    /setFailure\(errorUiCopy\(answer, \{ failure: err \}\)\);/,
  );
  assert.ok(!/\.message\b/.test(CODE), "never an error's message");
  // Logs carry the tag only.
  assert.match(
    review,
    /console\.error\("\[protected\] owner review failed", \{ type: answer\.tag \}\);/,
  );
});

test("R12 the props type is exported for the modal union", () => {
  assert.match(
    CODE,
    /export interface ProtectedOwnerReviewProps \{\s*type: "protected_owner_review";\s*channel: Channel;\s*\}/,
  );
  assert.match(
    CODE,
    /export function ProtectedOwnerReviewModal\(\s*props: DialogProps & ProtectedOwnerReviewProps,\s*\)/,
  );
});
