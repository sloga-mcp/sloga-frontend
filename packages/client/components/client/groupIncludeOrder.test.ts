// Source-order spec for the encrypted-group include in e2ee.ts, run with
// Node's built-in runner:
//   node --conditions=browser --test components/client/groupIncludeOrder.test.ts
// addGroupMemberEncrypted sends this device's pinned roster with the add, and
// receivers replace theirs with it. Every await before the add (bundle
// fetches, the send-mode check, a needs_bundle retry) leaves room for a member
// to be removed, so each attempt must take the exact "encrypt" verdict,
// re-check the new member is still listed, reconcile against the member list
// read in that same attempt, and then add with nothing else awaited in
// between. Self is refused before any reconcile or native call.
//
// The add itself waits on the native confirm dialog (plan D7): it sits
// between the reconcile and native's commit, inside the one add invoke, and
// nothing else is awaited there. The bundle preflight runs once, before the
// attempt loop, so a confirmed dialog rarely meets a needs_bundle. The dialog
// labels are built in the attempt from the list it reconciles. A Cancel
// ("declined") or a held dialog ("busy") resolves at once, before any
// needs_bundle retry; only a delivered include resolves "ok".
//
// e2ee.ts cannot load under node (Capacitor, Solid primitives, extensionless
// sibling imports, and #invoke is private), so this scans the source.
// Comments and literal text are masked first: prose cannot satisfy a check,
// and a brace inside a string cannot end a block. GROUP_INCLUDE_E2EE_PATH
// points the scan at another copy; it exists only for known-bad controls.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const SOURCE = readFileSync(
  process.env.GROUP_INCLUDE_E2EE_PATH ?? new URL("./e2ee.ts", import.meta.url),
  "utf8",
);

type Views = {
  /** Comments blanked; string literals intact. */
  code: string;
  /** Comments and literal text blanked; template `${}` code kept. */
  skel: string;
};

/**
 * Blank comments and literal text to spaces, keeping every offset and
 * newline so the two views index alike. Regex literals are not understood,
 * so this masks from the method declaration (which has none), not from the
 * top of the file.
 */
function mask(src: string): Views {
  const code = src.split("");
  const skel = src.split("");
  const blank = (view: string[], at: number) => {
    if (at < view.length && view[at] !== "\n") view[at] = " ";
  };
  // One entry per open template literal: the brace depth inside its current
  // `${}` expression, or -1 while in the literal's text.
  const templates: number[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const top = templates.length ? templates[templates.length - 1] : null;
    if (top === -1) {
      if (c === "`") {
        templates.pop();
      } else if (c === "$" && src[i + 1] === "{") {
        templates[templates.length - 1] = 0;
        i++;
      } else {
        if (c === "\\") blank(skel, i++);
        blank(skel, i);
      }
      i++;
    } else if (c === "/" && src[i + 1] === "/") {
      for (; i < src.length && src[i] !== "\n"; i++) {
        blank(code, i);
        blank(skel, i);
      }
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      for (; i < stop; i++) {
        blank(code, i);
        blank(skel, i);
      }
    } else if (c === '"' || c === "'") {
      for (i++; i < src.length && src[i] !== c && src[i] !== "\n"; i++) {
        if (src[i] === "\\") blank(skel, i++);
        blank(skel, i);
      }
      i++;
    } else {
      if (c === "`") templates.push(-1);
      else if (top !== null && c === "{") {
        templates[templates.length - 1] = top + 1;
      } else if (top !== null && c === "}") {
        templates[templates.length - 1] = top === 0 ? -1 : top - 1;
      }
      i++;
    }
  }
  return { code: code.join(""), skel: skel.join("") };
}

/** Offset of the bracket closing the one at `open` (masked view only). */
function closeOf(skel: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const opener = skel[open];
  const closer = pairs[opener];
  assert.ok(closer, `no bracket at offset ${open}`);
  let depth = 0;
  for (let i = open; i < skel.length; i++) {
    if (skel[i] === opener) depth++;
    else if (skel[i] === closer && --depth === 0) return i;
  }
  assert.fail(`unbalanced "${opener}" at offset ${open}`);
}

type Hit = { at: number; end: number };

/** First match of `pattern` in `view` at or after `from`, before `before`. */
function find(
  view: string,
  pattern: RegExp,
  what: string,
  from = 0,
  before = view.length,
): Hit {
  const re = new RegExp(pattern.source, "g");
  re.lastIndex = from;
  const m = re.exec(view);
  assert.ok(m && m.index < before, `${what} not found where expected`);
  return { at: m.index, end: m.index + m[0].length };
}

function countIn(view: string, pattern: RegExp): number {
  return [...view.matchAll(new RegExp(pattern.source, "g"))].length;
}

const SELF_ID = /\bconst\s+selfId\s*=\s*this\.#client\.user!?\.id\b/;
const SELF_REFUSAL =
  /\bif\s*\(\s*(?:userId\s*===\s*selfId|selfId\s*===\s*userId)\s*\)\s*\{?\s*throw\b/;
const NATIVE_OR_API = /\bthis\.#(?:invoke|api)\b/;
const RECONCILE = /"e2ee_group_reconcile"/;
const AWAITED_RECONCILE =
  /\bawait\s+this\.#invoke\s*(?:<[^>()]*>)?\s*\(\s*"e2ee_group_reconcile"/;
const AWAITED_ADD =
  /\bawait\s+this\.#invoke\s*(?:<[^>()]*>)?\s*\(\s*"e2ee_add_group_member"/;
const ADD = /"e2ee_add_group_member"/;
const EXACT_ENCRYPT_GATE =
  /\bif\s*\(\s*\(\s*await\s+this\.sendModeNowFor\(\s*channel\s*\)\s*\)\s*!==\s*"encrypt"\s*\)\s*\{?\s*throw\b/;
const STILL_LISTED =
  /\bif\s*\(\s*!\s*channel\.recipientIds\.has\(\s*userId\s*\)\s*\)\s*\{?\s*throw\b/;
const LIVE_LIST = /\[\s*\.\.\.\s*channel\.recipientIds\.values\(\s*\)\s*\]/;
const DISPLAYED_DECL = new RegExp(
  String.raw`\bconst\s+displayed\s*=\s*` + LIVE_LIST.source + String.raw`\s*;`,
);
const INLINE_DISPLAYED = new RegExp(
  String.raw`\bdisplayed\s*:\s*` + LIVE_LIST.source,
);
const SHORTHAND_DISPLAYED = /\bdisplayed\s*[,}]/;
const SUSPENDS = /\bawait\b|\byield\b|\.then\s*\(/;
const RETURNS_OUTCOME = /\)\s*:\s*Promise\s*<\s*GroupGrowthOutcome\s*>\s*$/;
const AWAITED_PREFLIGHT = /\bawait\s+this\.groupGrowthBundlePreflight\s*\(/;
const PREFLIGHT = /\bgroupGrowthBundlePreflight\b/;
const DISPLAY_NAMES_DECL =
  /\bconst\s+displayNames\s*=\s*this\.#growthDisplayNames\(\s*displayed\s*\)\s*;/;
const DISPLAY_NAMES_ARG = /\bdisplayNames\s*[,}]/;
const DECLINED_RETURN =
  /\bif\s*\(\s*native\.type\s*===\s*"declined"\s*\)\s*\{?\s*return\s+"declined"/;
const BUSY_RETURN =
  /\bif\s*\(\s*native\.type\s*===\s*"busy"\s*\)\s*\{?\s*return\s+"busy"/;
const OUTCOME_RETURN = /\breturn\s+"(?:ok|declined|busy)"/;
const OK_RETURN = /\breturn\s+"ok"/;
const DELIVERY_POST = /\bthis\.#api\b[^;]*"POST"\s*,\s*"\/e2ee\/messages"/;

/**
 * The method body, both views, offsets relative to its opening brace, and
 * `head`: the masked declaration up to (not including) that brace.
 */
function method(): Views & { head: string } {
  const decl = /^[ \t]*async\s+addGroupMemberEncrypted\s*\(/gm;
  const hits = [...SOURCE.matchAll(decl)];
  assert.equal(hits.length, 1, "one addGroupMemberEncrypted declaration");
  const start = hits[0].index;
  assert.ok(start !== undefined);
  const { code, skel } = mask(SOURCE.slice(start));
  const params = skel.indexOf("(");
  const open = skel.indexOf("{", closeOf(skel, params));
  assert.ok(open > 0, "addGroupMemberEncrypted has a body");
  const close = closeOf(skel, open);
  return {
    code: code.slice(open, close + 1),
    skel: skel.slice(open, close + 1),
    head: skel.slice(0, open),
  };
}

/** The body of the `for (let attempt ...)` retry loop, as offsets. */
function attemptLoop(m: Views): Hit {
  const head = find(m.skel, /\bfor\s*\(\s*let\s+attempt\b/, "attempt loop");
  const headClose = closeOf(m.skel, m.skel.indexOf("(", head.at));
  const open = find(m.skel, /\{/, "attempt loop body", headClose + 1);
  assert.match(
    m.skel.slice(headClose + 1, open.at),
    /^\s*$/,
    "the attempt loop has a block body",
  );
  return { at: open.at, end: closeOf(m.skel, open.at) };
}

/** Each step of one attempt, located in order inside the loop. */
function attemptSteps(m: Views) {
  const loop = attemptLoop(m);
  const gate = find(m.code, EXACT_ENCRYPT_GATE, "exact encrypt gate", loop.at);
  assert.ok(gate.end < loop.end, "the encrypt gate is inside the loop");
  const listed = find(m.code, STILL_LISTED, "membership re-check", gate.end);
  assert.ok(listed.end < loop.end, "the membership re-check is in the loop");
  const reconcile = find(
    m.code,
    AWAITED_RECONCILE,
    "awaited reconcile after the membership re-check",
    listed.end,
    loop.end,
  );
  const argsOpen = m.skel.indexOf("(", reconcile.at);
  const argsClose = closeOf(m.skel, argsOpen);
  const add = find(
    m.code,
    AWAITED_ADD,
    "awaited add after the reconcile",
    argsClose,
    loop.end,
  );
  return { loop, gate, listed, reconcile, argsOpen, argsClose, add };
}

/** The add's argument list and the `catch` block of its `try`, as offsets. */
function addCall(m: Views) {
  const steps = attemptSteps(m);
  const addArgsOpen = m.skel.indexOf("(", steps.add.at);
  const addArgsClose = closeOf(m.skel, addArgsOpen);
  const catchHead = find(
    m.skel,
    /\}\s*catch\s*\(\s*\w+\s*\)\s*\{/,
    "the catch of the add's try",
    addArgsClose,
    steps.loop.end,
  );
  const catchOpen = catchHead.end - 1;
  return {
    ...steps,
    addArgsOpen,
    addArgsClose,
    catchOpen,
    catchClose: closeOf(m.skel, catchOpen),
  };
}

describe("addGroupMemberEncrypted include order", () => {
  test("refuses self before either reconcile or any native call", () => {
    const m = method();
    const selfId = find(m.code, SELF_ID, "selfId from the signed-in user");
    const refusal = find(m.code, SELF_REFUSAL, "self refusal", selfId.end);
    const firstCall = find(m.code, NATIVE_OR_API, "a native or API call");
    const firstReconcile = find(m.code, RECONCILE, "a reconcile");
    assert.ok(refusal.at < firstCall.at, "self refused before any call");
    assert.ok(refusal.at < firstReconcile.at, "self refused before reconcile");
    assert.ok(
      refusal.at < attemptLoop(m).at,
      "self refused before the attempt loop",
    );
  });

  test("each attempt takes the exact encrypt verdict before anything else", () => {
    const m = method();
    const { loop, gate } = attemptSteps(m);
    // The gate's own await is the attempt's first suspension point.
    const firstAwait = find(
      m.skel,
      /\bawait\b/,
      "an await in the loop",
      loop.at,
    );
    assert.ok(firstAwait.at >= gate.at, "nothing awaited before the gate");
  });

  test("each attempt re-checks membership, then reconciles the live list", () => {
    const m = method();
    const { loop, listed, reconcile, argsOpen, argsClose } = attemptSteps(m);
    assert.equal(
      countIn(m.code.slice(loop.at, loop.end), RECONCILE),
      1,
      "one reconcile per attempt",
    );
    const args = m.code.slice(argsOpen, argsClose + 1);
    if (!INLINE_DISPLAYED.test(args)) {
      // Shorthand `displayed` must be a const built from the live list in
      // this attempt, after the re-check: hoisted above the loop, it would
      // send a roster read before the awaits.
      assert.match(args, SHORTHAND_DISPLAYED, "reconcile passes displayed");
      find(
        m.code,
        DISPLAYED_DECL,
        "displayed built from channel.recipientIds in the attempt",
        listed.end,
        reconcile.at,
      );
      assert.equal(
        countIn(m.code, /\bdisplayed\s*=[^=]/),
        1,
        "displayed is assigned once, in the attempt",
      );
    }
    assert.doesNotMatch(
      m.skel.slice(listed.end, reconcile.at),
      SUSPENDS,
      "nothing awaited between the membership re-check and the reconcile",
    );
  });

  test("the add follows the reconcile with nothing awaited in between", () => {
    const m = method();
    const { argsClose, add } = attemptSteps(m);
    assert.equal(countIn(m.code, ADD), 1, "one add in the method");
    assert.doesNotMatch(
      m.skel.slice(argsClose, add.at),
      SUSPENDS,
      "nothing awaited between the reconcile and the add",
    );
  });

  test("resolves a GroupGrowthOutcome", () => {
    assert.match(method().head, RETURNS_OUTCOME);
  });

  test("the bundle preflight runs once, after the early reconcile, before the attempt loop", () => {
    const m = method();
    const loop = attemptLoop(m);
    assert.equal(countIn(m.code, PREFLIGHT), 1, "one bundle preflight");
    const firstReconcile = find(m.code, RECONCILE, "a reconcile");
    const preflight = find(
      m.code,
      AWAITED_PREFLIGHT,
      "awaited groupGrowthBundlePreflight before the attempt loop",
      firstReconcile.end,
      loop.at,
    );
    assert.ok(preflight.at < loop.at, "preflight is outside the loop");
  });

  test("the dialog labels come from this attempt's list, and the add carries them", () => {
    const m = method();
    const { listed, add, addArgsOpen, addArgsClose } = addCall(m);
    // Built in the attempt, after the re-check, from the same `displayed`
    // the reconcile sends; the ranges either side of the reconcile are
    // proven await-free above.
    const decl = find(
      m.code,
      DISPLAY_NAMES_DECL,
      "displayNames built from displayed in the attempt",
      listed.end,
      add.at,
    );
    assert.ok(decl.end <= add.at, "displayNames is built before the add");
    assert.equal(
      countIn(m.code, /\bdisplayNames\s*=[^=]/),
      1,
      "displayNames is assigned once, in the attempt",
    );
    assert.match(
      m.code.slice(addArgsOpen, addArgsClose + 1),
      DISPLAY_NAMES_ARG,
      "the add passes displayNames",
    );
  });

  test("a Cancel or a held dialog resolves at once, before any needs_bundle retry", () => {
    const m = method();
    const { catchOpen, catchClose } = addCall(m);
    const code = m.code.slice(catchOpen, catchClose + 1);
    const skel = m.skel.slice(catchOpen, catchClose + 1);
    const declined = find(code, DECLINED_RETURN, 'return "declined"');
    const busy = find(code, BUSY_RETURN, 'return "busy"');
    const firstAwait = skel.search(/\bawait\b/);
    const firstContinue = skel.search(/\bcontinue\b/);
    const firstThrow = skel.search(/\bthrow\b/);
    for (const [what, hit] of [
      ["declined", declined],
      ["busy", busy],
    ] as const) {
      for (const [step, at] of [
        ["await", firstAwait],
        ["continue", firstContinue],
        ["throw", firstThrow],
      ] as const) {
        assert.ok(at < 0 || hit.at < at, `${what} resolves before any ${step}`);
      }
    }
    assert.equal(
      countIn(m.code, /\breturn\s+"declined"/),
      1,
      'only the add resolves "declined"',
    );
    assert.equal(
      countIn(m.code, /\breturn\s+"busy"/),
      1,
      'only the add resolves "busy"',
    );
  });

  test('only a delivered include resolves "ok"', () => {
    const m = method();
    const { loop } = addCall(m);
    assert.equal(countIn(m.code, OK_RETURN), 1, 'one return "ok"');
    const post = find(m.code, DELIVERY_POST, "the delivery POST", loop.end);
    find(m.code, OK_RETURN, 'return "ok" after the delivery POST', post.end);
    assert.equal(
      countIn(m.code, OUTCOME_RETURN),
      3,
      "the outcomes are ok, declined and busy, once each",
    );
  });
});
