// Spec for the ban modal's removal reason (S2-D40, W4-3 lane U13), run
// with Node's built-in runner from packages/client:
//   node --conditions=browser --test components/modal/modals/banMember.scan.test.ts
//
// BanMember.tsx imports Solid, lingui and the UI kit, so Node cannot load
// it. Its rules sit in one marked region (`// protected-pure:begin` ..
// `// protected-pure:end`) with no imports; this spec cuts it out, strips
// the types with Node's own stripper and runs the real source against the
// real `validReason` / `reasonRefusal`. The wiring is checked by scanning
// the component.
//
//  B1  a blank reason is refused (`empty`) when required, sent as none
//      otherwise;
//  B2  the sent reason is the sanitized one `validReason` returns, never the
//      raw input, checked against the ban body cap (1024), not the header's;
//  B3  the server's `RemovalReasonRequired` (raw body text or parsed) is
//      recognised;
//  B4  the over-long refusal is `too_long`, asked before anything else;
//      other failures are `other`;
//  B5  required = the local check over `server.channels` (`isProtected`) OR
//      a server `RemovalReasonRequired` answer;
//  B6  the submit: a local refusal shows the reason copy and sends nothing;
//      the ban body's reason is the plan's only;
//  B7  a failed ban: too_long and reason_required show our copy (the latter
//      also makes the reason required); only the rest reaches the generic
//      `showError`;
//  B8  no server text is rendered; blank-page traps; the input cap;
//  B9  the hint shown while a reason is required (before any press) is the
//      server-wide `removalReasonHintCopy`; the 9.2 "this member is
//      protected" notice is only the server refusal's.
//
// Point `BAN_MEMBER_FILE` at another copy (a known-bad control) to check
// that instead; it must fail.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  reasonRefusal,
  validReason,
} from "../../client/protectedRemovalReasonPolicy.ts";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  process.env.BAN_MEMBER_FILE || join(here, "BanMember.tsx"),
  "utf8",
);

const BEGIN = "// protected-pure:begin";
const END = "// protected-pure:end";

type Plan =
  | { send: true; reason: string | undefined }
  | { send: false; problem: "empty" | "too_long" };
interface Rules {
  banPlan(raw: string, required: boolean, validate: typeof validReason): Plan;
  banFailure(
    error: unknown,
    refusal: typeof reasonRefusal,
  ): "too_long" | "reason_required" | "other";
}
const RULE_NAMES = ["banPlan", "banFailure"] as const;

let rulesPromise: Promise<Rules> | null = null;
function loadRules(): Promise<Rules> {
  rulesPromise ??= (async () => {
    const from = source.indexOf(BEGIN);
    const to = source.indexOf(END);
    assert.ok(from !== -1 && to > from, "protected-pure region missing");
    const region = source.slice(from, to);
    assert.ok(!/^\s*import\s/m.test(region), "the region must not import");
    const js =
      stripTypeScriptTypes(region, { mode: "strip" }) +
      `\nexport { ${RULE_NAMES.join(", ")} };\n`;
    const dir = mkdtempSync(join(tmpdir(), "s2w43-U13-"));
    const out = join(dir, "banMemberPure.mjs");
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

/** Whitespace-insensitive: every run of whitespace is one space. */
function flat(s: string): string {
  return s.replace(/\s+/g, " ");
}

const CODE = code(source);

/** The component body: from its declaration to the pure region. */
function componentBody(): string {
  const from = source.indexOf("export function BanMemberModal(");
  assert.ok(from !== -1, "BanMemberModal missing");
  const to = source.indexOf(BEGIN, from);
  assert.ok(to > from, "the component must precede the pure region");
  return code(source.slice(from, to));
}

const BODY = componentBody();
const FLAT = flat(BODY);

/** One inner function of the component, from `head` to its closing brace. */
function fn(head: string): string {
  const from = BODY.indexOf(head);
  assert.ok(from !== -1, `${head} missing`);
  const to = BODY.indexOf("\n  }\n", from);
  assert.ok(to > from, `${head} has no end`);
  return flat(BODY.slice(from, to));
}

function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

const TOO_LONG_BODY =
  '{"type":"FailedValidation","error":"AuditLogReasonTooLong"}';
const REQUIRED_BODY = '{"type":"RemovalReasonRequired"}';

// Code points spelled as numbers: no escapes or invisible characters in
// this source (an editor or tool can turn an escape into the character).
const BEL = String.fromCodePoint(0x07);
const ZWSP = String.fromCodePoint(0x200b);
const RLO = String.fromCodePoint(0x202e);
const LRI = String.fromCodePoint(0x2066);
const GRIN = String.fromCodePoint(0x1f600);

test("B1 a blank reason is refused when required and sent as none otherwise", async () => {
  const { banPlan } = await loadRules();
  for (const raw of ["", "   ", `${BEL}${ZWSP}\t`, `${RLO} ${LRI}`]) {
    assert.deepEqual(
      banPlan(raw, true, validReason),
      { send: false, problem: "empty" },
      `required, ${JSON.stringify(raw)}`,
    );
    assert.deepEqual(
      banPlan(raw, false, validReason),
      { send: true, reason: undefined },
      `not required, ${JSON.stringify(raw)}`,
    );
  }
});

test("B2 the sent reason is the sanitized one, never the raw input, under the ban body cap", async () => {
  const { banPlan } = await loadRules();
  for (const required of [true, false]) {
    assert.deepEqual(
      banPlan(`  spam${ZWSP} link${BEL} \n`, required, validReason),
      { send: true, reason: "spam link" },
    );
    // 1024 code points (two UTF-16 units each) is the ban body cap exactly.
    const emoji = GRIN.repeat(1024);
    assert.deepEqual(banPlan(` ${emoji} `, required, validReason), {
      send: true,
      reason: emoji,
    });
    // 513 is over the audit header's 512 but a ban body takes it.
    const x513 = "x".repeat(513);
    assert.deepEqual(banPlan(x513, required, validReason), {
      send: true,
      reason: x513,
    });
    assert.deepEqual(banPlan("x".repeat(1025), required, validReason), {
      send: false,
      problem: "too_long",
    });
  }
  // the validator is asked for the ban body carrier, with the raw input
  const calls: unknown[][] = [];
  banPlan(" raw ", true, ((...a: Parameters<typeof validReason>) => {
    calls.push(a);
    return validReason(...a);
  }) as typeof validReason);
  assert.deepEqual(calls, [[" raw ", "ban_body"]]);
});

test("B3 the server's RemovalReasonRequired is recognised, raw or parsed", async () => {
  const { banFailure } = await loadRules();
  assert.equal(banFailure(REQUIRED_BODY, reasonRefusal), "reason_required");
  assert.equal(
    banFailure({ type: "RemovalReasonRequired" }, reasonRefusal),
    "reason_required",
  );
  for (const other of [
    '{"type":"MissingPermission","permission":"BanMembers"}',
    '{"type":"NotElevated"}',
    { type: "removal_reason_required" },
    '"RemovalReasonRequired"',
    "RemovalReasonRequired",
    "not json",
    [{ type: "RemovalReasonRequired" }],
    null,
    undefined,
    new Error("RemovalReasonRequired"),
  ]) {
    assert.equal(banFailure(other, reasonRefusal), "other", String(other));
  }
});

test("B4 the over-long refusal is too_long and is asked first; other failures are other", async () => {
  const { banFailure } = await loadRules();
  assert.equal(banFailure(TOO_LONG_BODY, reasonRefusal), "too_long");
  assert.equal(
    banFailure(JSON.parse(TOO_LONG_BODY), reasonRefusal),
    "too_long",
  );
  assert.equal(
    banFailure(
      '{"type":"FailedValidation","error":"SomethingElse"}',
      reasonRefusal,
    ),
    "other",
  );
  // the refusal is consulted before any other reading of the error
  const asked: unknown[] = [];
  const failure = banFailure(REQUIRED_BODY, ((e: unknown) => {
    asked.push(e);
    return "too_long";
  }) as typeof reasonRefusal);
  assert.equal(failure, "too_long");
  assert.deepEqual(asked, [REQUIRED_BODY]);
});

test("B5 required is the local check over the server's channels or the server's answer", () => {
  assert.match(
    FLAT,
    /const required = createMemo\( \(\) => serverRequired\(\) \|\| removalReasonRequired\( \(props\.member\.server\?\.channels \?\? \[\]\)\.map\(\(c\) => \(\{ protected: c\.isProtected, \}\)\), \), \);/,
  );
  // the server's answer is the only writer of serverRequired, and it only sets it
  assert.deepEqual(
    [...BODY.matchAll(/setServerRequired\(([^)]*)\)/g)].map((m) => m[1]),
    ["true"],
  );
  assert.equal(count(BODY, "required()"), 2, "submit + hint read it");
});

test("B6 the submit refuses locally with the reason copy and sends only the plan's reason", () => {
  const s = fn("async function onSubmit(");
  assert.match(
    s,
    /^async function onSubmit\(\) \{ if \(banning\(\)\) return; setProblem\(null\); const plan = banPlan\(group\.controls\.reason\.value, required\(\), validReason\); if \(!plan\.send\) \{ setProblem\(reasonProblemCopy\(plan\.problem, BAN_REASON_MAX_CHARS\)\); return; \} setBanning\(true\);/,
  );
  assert.match(
    s,
    /await props\.member\.ban\(\{ reason: plan\.reason, delete_message_seconds: Number\( group\.controls\.deleteMessageSeconds\.value, \), \}\);/,
  );
  // the typed text is read once, by the plan; the ban body takes its reason
  assert.equal(count(BODY, "reason.value"), 1);
  assert.equal(count(CODE, ".ban("), 1);
  assert.ok(
    s.indexOf("if (!plan.send)") < s.indexOf("setBanning(true)"),
    "a local refusal never marks the ban as in flight",
  );
});

test("B7 a failed ban shows reason copy before the generic mapping", () => {
  const s = fn("async function onSubmit(");
  assert.match(s, /\} catch \(error\) \{ showBanError\(error\); \} finally \{/);
  const f = fn("function showBanError(");
  assert.match(
    f,
    /^function showBanError\(error: unknown\) \{ const failure = banFailure\(error, reasonRefusal\); switch \(failure\) \{/,
  );
  assert.match(
    f,
    /case "too_long": setProblem\(reasonProblemCopy\("too_long", BAN_REASON_MAX_CHARS\)\); return; case "reason_required": setServerRequired\(true\); setProblem\(noticeCopy\("removal_reason_required"\)\); return; case "other": showError\(error\); return; default: \{ const _exhaustive: never = failure; showError\(error\); \}/,
  );
  // showError is reached only from the `other` arm and the never default
  assert.equal(count(BODY, "showError("), 2);
});

test("B8 no server text is rendered; string-tag styled only; the ban body cap", () => {
  // the problem line only ever holds our copy
  const writes = [...BODY.matchAll(/setProblem\(\s*([\s\S]*?)\);/g)].map((m) =>
    flat(m[1]).trim().replace(/,$/, ""),
  );
  assert.deepEqual(writes.sort(), [
    'noticeCopy("removal_reason_required")',
    "null",
    'reasonProblemCopy("too_long", BAN_REASON_MAX_CHARS)',
    "reasonProblemCopy(plan.problem, BAN_REASON_MAX_CHARS)",
  ]);
  assert.doesNotMatch(
    BODY,
    /\.message\b|\.body\b|String\(error|JSON\.stringify/,
  );
  assert.match(
    FLAT,
    /\{\(text\) => <Problem role="alert">\{text\(\)\}<\/Problem>\}/,
  );
  assert.doesNotMatch(CODE, /styled\((?!"div")/);
  assert.doesNotMatch(CODE, /use:floating/);
  assert.match(CODE, /maxlength=\{BAN_REASON_MAX_CHARS\}/);
  assert.doesNotMatch(CODE, /AUDIT_LOG_REASON_MAX_CHARS|maxlength=\{\d/);
});

test("B9 the pre-press hint is the server-wide copy; the member notice is the refusal's only", () => {
  assert.match(
    FLAT,
    /<Show when=\{problem\(\)\} fallback=\{ <Show when=\{required\(\)\}> <Hint>\{removalReasonHintCopy\(\)\}<\/Hint> <\/Show> \} >/,
  );
  assert.equal(count(BODY, "removalReasonHintCopy()"), 1);
  assert.equal(
    count(BODY, 'noticeCopy("removal_reason_required")'),
    1,
    "the 9.2 notice is shown for the server refusal only",
  );
});
