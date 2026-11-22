// Source-scan spec for the Encrypted-only gates on the screens (Sloga Slim
// M3, plan S4 and S5), run with Node's built-in runner from packages/client:
//   node --conditions=browser --test src/interface/encryptedOnlyGates.scan.test.ts
// Declared test count: 20 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
//
// Every screen below offers a way to write plain content into a DM or a
// group (send, forward, schedule, poll, timelock, a plaintext exit from an
// encrypted chat, creating or growing a group, or the whole chat view). Each
// must ask the Encrypted-only policy before it does. The decisions live in
// loadable modules with their own specs; what no spec sees is a screen that
// stops asking. These files cannot load under Node (Solid, the client
// context, the UI kit), and a refactor that drops the call still builds, so
// this spec reads them as text, comments removed.
//
// The rule for each screen: it imports a value from one of the policy
// modules (POLICY_MODULES below) and uses that value outside the import, in
// code (not in a comment, not inside a quoted string). A type-only import,
// an import that is never used, a name only in a comment and the latch
// module on its own do not count. One test per screen, so a failure names
// it; G0 tests the scanner itself.
//
// WHAT THIS SPEC CANNOT CATCH. It matches text; it never runs the app. A
// screen that calls the policy and then ignores the answer, calls it on the
// wrong branch, or calls it after the request has gone, passes here. The
// policy specs, the e2ee.ts scan and the browser leg on the stub backend
// (/home/mcp/slim-m3/m3_stub.js) cover the decisions and the wiring.
//
// Negative control: set `ENCRYPTED_ONLY_GATES_ROOT` to a directory laid out
// like packages/client holding a copy of every scanned file (SITES and
// POLICY_FILES below; a missing copy fails the tests that read it), remove
// the policy from one copy, and run the spec. It must fail in the test for
// that screen and nowhere else.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(
  process.env.ENCRYPTED_ONLY_GATES_ROOT || join(here, "..", ".."),
);

const MODALS = "components/modal/modals";

/** The screens that must ask the policy: [test id, path under ROOT]. */
const SITES: [string, string][] = [
  ["G1", "src/interface/channels/text/Composition.tsx"],
  ["G2", `${MODALS}/ForwardMessage.tsx`],
  ["G3", `${MODALS}/ScheduleMessage.tsx`],
  ["G4", `${MODALS}/CreatePoll.tsx`],
  ["G5", `${MODALS}/TimelockCompose.tsx`],
  ["G6", `${MODALS}/CreateGroup.tsx`],
  ["G7", `${MODALS}/AddMembersToGroup.tsx`],
  ["G8", `${MODALS}/AddFriendToGroup.tsx`],
  ["G9", `${MODALS}/E2EEPeerDowngrade.tsx`],
  ["G10", `${MODALS}/E2EEVerify.tsx`],
  ["G11", `${MODALS}/E2EEGroupPlaintextConfirm.tsx`],
  ["G12", "src/interface/channels/ChannelPage.tsx"],
  ["G13", "components/app/interface/channels/text/Messages.tsx"],
];

/**
 * Import specifiers that count as the policy: the decision table
 * (`decideForKind`, `guardReason`), the guard's input builder
 * (`buildPlainWriteInput`) and the screen helpers (`composerBlockFor`,
 * `writeRefusal`, the chat panel and row rules, the setup rules). The latch
 * module is state, not a decision, and is left out on purpose.
 */
const POLICY_MODULES =
  /(?:^|\/)encryptedOnly(?:Guard|Policy|Composer|Chat|Modals|Setup)(?:\.tsx?)?$/;

/** Where those modules live, so a rename cannot leave the pattern stale. */
const POLICY_FILES = [
  "components/client/encryptedOnlyGuard.ts",
  "components/client/encryptedOnlyPolicy.ts",
  "components/client/encryptedOnlyChat.ts",
  `${MODALS}/encryptedOnlyModals.ts`,
  `${MODALS}/encryptedOnlySetup.ts`,
  "src/interface/channels/text/encryptedOnlyComposer.ts",
];

/** Line number of index `at`, for failure messages. */
function lineOf(s: string, at: number): number {
  return s.slice(0, at).split("\n").length;
}

/**
 * Index just past the string or template literal that opens at `at`. A
 * quote with no partner on its line is an apostrophe in JSX text, and ends
 * at the line break.
 */
function skipString(s: string, at: number): number {
  const quote = s[at];
  let i = at + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") i += 2;
    else if (c === quote) return i + 1;
    else if (quote !== "`" && c === "\n") return i;
    else if (quote === "`" && c === "$" && s[i + 1] === "{")
      i = matchClose(s, i + 1) + 1;
    else i++;
  }
  if (quote === "`")
    assert.fail(`scanner: open template literal, line ${lineOf(s, at)}`);
  return s.length;
}

/** Index of the bracket that closes the `(`, `[` or `{` at `at`. */
function matchClose(s: string, at: number): number {
  let depth = 0;
  let i = at;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(s, i);
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  assert.fail(`scanner: unclosed bracket, line ${lineOf(s, at)}`);
}

/**
 * Source with its comments removed (block, JSX block and line), so prose
 * and a commented-out call never count. Strings and template literals are
 * copied as they are. A JSX comment goes together with its braces.
 */
function code(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(s, i);
      out += s.slice(i, end);
      i = end;
    } else if (c === "/" && s[i + 1] === "*") {
      const close = s.indexOf("*/", i + 2);
      i = close === -1 ? s.length : close + 2;
      const after = /^\s*\}/.exec(s.slice(i));
      if (after && /\{\s*$/.test(out)) {
        out = out.replace(/\{\s*$/, "");
        i += after[0].length;
      }
    } else if (
      c === "/" &&
      s[i + 1] === "/" &&
      s[i - 1] !== ":" &&
      s[i - 1] !== "\\"
    ) {
      // Not after a colon: "https://" in JSX text is not a comment
      const close = s.indexOf("\n", i);
      i = close === -1 ? s.length : close;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * `s` (comments already removed) with the inside of every single and double
 * quoted string blanked, so a name inside a string is not a use. Template
 * literals stay: their `${}` parts are code.
 */
function blankStrings(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const end = skipString(s, i);
      out += c + " ".repeat(Math.max(0, end - i - 2)) + s[end - 1];
      i = end;
    } else if (c === "`") {
      const end = skipString(s, i);
      out += s.slice(i, end);
      i = end;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** One static import declaration: its value bindings and its specifier. */
type Import = { from: string; values: string[]; span: [number, number] };

/**
 * The static imports of `s` (comments already removed). Type-only imports
 * and `type` members bind no value and are left out of `values`.
 */
function importsOf(s: string): Import[] {
  const found: Import[] = [];
  const re =
    /\bimport\s+(type\s+)?([\w$\s{},*]*?)\s*\bfrom\s*(["'])([^"']+)\3\s*;?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const values: string[] = [];
    if (!m[1]) {
      const clause = m[2];
      const braces = /\{([^}]*)\}/.exec(clause);
      for (const part of braces ? braces[1].split(",") : []) {
        const member = part.trim();
        if (!member || /^type\s/.test(member)) continue;
        const alias = /\bas\s+([\w$]+)$/.exec(member);
        values.push(alias ? alias[1] : member);
      }
      const outside = clause.replace(/\{[^}]*\}/, "");
      const namespace = /\*\s*as\s+([\w$]+)/.exec(outside);
      if (namespace) values.push(namespace[1]);
      const fallback = /^\s*([\w$]+)\s*(?:,|$)/.exec(outside);
      if (fallback && fallback[1] !== "type") values.push(fallback[1]);
    }
    found.push({ from: m[4], values, span: [m.index, m.index + m[0].length] });
  }
  return found;
}

/**
 * The policy values `source` imports and then uses in code: an empty list
 * means the screen does not ask the policy. A comment, a quoted string, an
 * import line and a property of another object (`x.name`) are not uses.
 */
function policyUses(source: string): string[] {
  const text = code(source);
  assert.doesNotMatch(
    text,
    /^\s*\/\/|\{\s*\/\*/m,
    "scanner: a comment survived, so it has lost its place",
  );
  const imports = importsOf(text);
  let rest = text;
  for (const { span } of [...imports].reverse()) {
    rest = rest.slice(0, span[0]) + " " + rest.slice(span[1]);
  }
  rest = blankStrings(rest);
  const names = imports
    .filter((i) => POLICY_MODULES.test(i.from))
    .flatMap((i) => i.values);
  return names.filter((name) =>
    new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(
      rest,
    ),
  );
}

const loaded = new Map<string, string>();

/** A scanned file, read on first use (a missing copy fails only its test). */
function load(rel: string): string {
  let text = loaded.get(rel);
  if (text === undefined) {
    text = readFileSync(join(ROOT, rel), "utf8");
    loaded.set(rel, text);
  }
  return text;
}

// ---- G0: the scanner ---------------------------------------------------------

test("G0 a policy name only in a comment does not count", () => {
  const source = [
    'import { writeRefusal } from "./encryptedOnlyModals";',
    "// const refusal = writeRefusal(state);",
    "/* buildPlainWriteInput(client, channel) */",
    "export const view = () => <div>{/* writeRefusal(x) */}</div>;",
    "",
  ].join("\n");
  assert.deepEqual(policyUses(source), []);
});

test("G0 an import with no use outside quoted strings does not count", () => {
  const source = [
    'import { decideForKind } from "@revolt/client/encryptedOnlyPolicy";',
    'const label = "decideForKind";',
    "",
  ].join("\n");
  assert.deepEqual(policyUses(source), []);
});

test("G0 a type-only import or a type member does not count", () => {
  const source = [
    'import type { PlainWriteInput } from "@revolt/client/encryptedOnlyPolicy";',
    'import { type ComposerView } from "./encryptedOnlyComposer";',
    "let input: PlainWriteInput; let view: ComposerView;",
    "",
  ].join("\n");
  assert.deepEqual(policyUses(source), []);
});

test("G0 the latch module alone, or a property of another object, does not count", () => {
  const source = [
    'import { latchedForClient } from "@revolt/client/encryptedOnlyLatch";',
    'import { other } from "./somethingElse";',
    "if (latchedForClient(client)) other.writeRefusal(state);",
    "",
  ].join("\n");
  assert.deepEqual(policyUses(source), []);
});

test("G0 a used value import from a policy module counts, aliased or in JSX", () => {
  const source = [
    'import { type ComposerView, composerBlockFor } from "./encryptedOnlyComposer";',
    'import { decideForKind as decide } from "@revolt/client/encryptedOnlyPolicy";',
    'import * as chat from "@revolt/client/encryptedOnlyChat.ts";',
    "const verdict = decide(input, 'send');",
    "export const view = () => <Show when={composerBlockFor(v)}>{chat.x}</Show>;",
    "",
  ].join("\n");
  assert.deepEqual(policyUses(source).sort(), [
    "chat",
    "composerBlockFor",
    "decide",
  ]);
});

test("G0 every policy module the pattern names exists", () => {
  for (const rel of POLICY_FILES) {
    assert.ok(existsSync(join(ROOT, rel)), `missing policy module ${rel}`);
    assert.match(rel, /encryptedOnly\w+\.ts$/);
    assert.ok(
      POLICY_MODULES.test(rel.replace(/\.ts$/, "")),
      `${rel} is not matched by POLICY_MODULES`,
    );
  }
});

test("G0 the screen files are read from the real tree or the control root", () => {
  assert.ok(
    existsSync(join(ROOT, SITES[0][1])),
    `ROOT ${ROOT} does not hold ${SITES[0][1]}`,
  );
});

// ---- G1..G13: one test per screen --------------------------------------------

for (const [gid, rel] of SITES) {
  const name = rel.split("/").pop();
  test(`${gid} ${name} asks the Encrypted-only policy in code`, () => {
    const uses = policyUses(load(rel));
    assert.ok(
      uses.length > 0,
      `${rel} imports no policy value it uses in code (modules: ` +
        "encryptedOnlyGuard, encryptedOnlyPolicy, encryptedOnlyComposer, " +
        "encryptedOnlyChat, encryptedOnlyModals, encryptedOnlySetup)",
    );
  });
}
