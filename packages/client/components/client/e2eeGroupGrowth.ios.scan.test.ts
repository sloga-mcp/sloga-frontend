// Source-scan spec for the group-growth routing of the iOS E2ee plugin (IE
// plan D1, D5; gate G10): the iOS twin of e2eeGroupGrowth.scan.test.ts. Run
// with Node's built-in runner:
//   node --conditions=browser --test components/client/e2eeGroupGrowth.ios.scan.test.ts
// The Swift module does not load under Node, so the routing is pinned by
// reading every .swift file of the SlogaE2ee target
// (`ios/App/SlogaE2ee/Sources`). Point `E2EE_GROWTH_SWIFT_DIR` at a copy of
// that directory to scan it instead (the known-bad controls: a copy whose
// runGeneric has `case "e2ee_enable_group":`, and one that commits outside
// the dedicated closure; both must fail). The e2ee.ts half (T8, T9) is pinned
// by the Android spec and is not repeated here.
//
// Comments (block comments nest) are stripped before every check, and string
// contents (single-line, multi-line `"""` and raw `#"…"#` strings, and
// `#/…/#` regex literals) only count where a literal is the subject of the
// rule; `\(…)` interpolations are code. So a commented-out call, or a call
// spelled inside a string, never satisfies (or trips) a rule.
//
// Why most Android rules do not carry over: Android exports the checked
// commit (`enableGroup(…, expectedAfter, prompted)`) and its preview, so
// Kotlin draws the dialog and may only commit after a tap. iOS exports no
// commit primitive (D1): `E2eeEngine.enableGroup` / `addGroupMember` run
// ShellEngine's preview, prompt (through NativeConfirm) and commit as one
// call, and the core holds the busy latch and the decline lockout. What Swift
// still has to get right is the routing: the call reaches the engine only
// through its own plugin method, on a thread of its own, with the webview's
// own arguments, and its result goes back as `{json}`.
//
// Rules (E2eePlugin.swift unless another file is named; `G` = enableGroup /
// addGroupMember, `C` = e2ee_enable_group / e2ee_add_group_member):
//   S1. E2eeCommands.swift: `static let table` holds the entry
//       `("C", .dedicated("G"))`, and C is spelled exactly once in that file
//       (the route map keeps a name's FIRST entry, so an earlier `.generic`
//       entry would win); `static let dedicatedMethods` lists "G" once.
//   S2. `func call(_ call: CAPPluginCall)` routes on one
//       `switch E2eeCommands.route(for: …)`, and its one clause naming
//       `.dedicated` does nothing but
//       `call.reject(E2eeReject.invalidArgument("name").json)`.
//   S3. No string literal in any other Swift file spells C; in particular
//       `runGeneric` has no `case "C":` label.
//   S4. Exactly one `func G` in the file: `@objc func G(_ call:
//       CAPPluginCall)`, an instance method whose first statement is
//       `guard Self.armedOrReject(call) else { return }`; `armedOrReject`
//       is defined once.
//   S5. Every mention of G in code, in every file, is that definition or the
//       one engine call `.G(` in E2eePlugin.swift: no method reference, no
//       call from another file or another method. The call sits inside
//       `@objc func G`, inside the trailing closure of its only
//       `Self.onDedicatedThread(call, "<thread name>") { … }`, directly in
//       that closure (not in a nested block or closure), on
//       `E2eeRuntime.shared.engine()` or an `engine` the closure binds to it
//       with `let engine = try E2eeRuntime.shared.engine()`; the closure's
//       first statement is `dispatchPrecondition(condition:
//       .notOnQueue(.main))`.
//   S6. That closure runs on a new thread: the whole body of
//       `onDedicatedThread` is `runOnDedicatedThread(name: …) { … }`, whose
//       closure opens with the same dispatchPrecondition, settles through
//       `settle(call)` and is the only place the body parameter is used; and
//       `runOnDedicatedThread` is defined once, in Support.swift, where it
//       starts a `Thread` that runs its body, with no queue, worker, task or
//       `async` involved.
//   S7. The engine call passes exactly the uniffi labels, in order
//       (conversationId, roster | userId, selfUserId, bundlesJson,
//       displayNames), each read from the call's own argument under the FE's
//       key ("conversationId", "roster" | "userId", "selfUserId", "bundles",
//       "displayNames") with an `E2eeCallArgs(call)` reader, either directly
//       or through `guard let input = Self.validated(call, { try (…) })`.
//       selfUserId is exactly `args.string("selfUserId")`: required, as on
//       Android. No literal, no `??` default, no extra argument.
//   S8. The engine result is what the closure resolves: `let V = try …G(…)`
//       then `return .json(V)`, or `return .json(try …G(…))`, as the
//       closure's only return; and `settle` resolves `.json(x)` as
//       `call.resolve(["json": x])` (the `{json}` CapacitorTransport
//       JSON.parses for these two) and rejects every error with
//       `call.reject(rejectJson(for: error))`.
// K1 maps to S2 + S3, K2 to S4, K3's "commit only in the method of the same
// name" to S5. Dropped, and why:
//   K3 (the rest): commit only in setPositiveButton or the !needsPrompt
//       branch with `prompted` true / false, no synthetic taps, no
//       reflection. There is no commit primitive to place: the prompt and
//       the commit are one engine call, and the tap belongs to NativeConfirm
//       (UIAlertAction). E2eeEngine is a uniffi Swift class with no
//       Objective-C runtime surface, so there is no method to look up by
//       name, and S5 refuses method references.
//   K4 (preview, expectedAfter from the preview): no preview is exported;
//       the core ties the commit to what its own dialog showed. S7's exact
//       label list refuses an `expectedAfter:` or `prompted:` argument.
//   K5, K6, K7 (the AtomicBoolean latch, the resolve-once dismiss listener,
//       busy): the core's consent latch answers busy, a dismissed alert is
//       a decline, and either error reaches the webview through `settle`
//       (S8). Swift holds no latch of its own to release.
//   K8 (decline lockout, teardown dismiss): the lockout is the core's;
//       teardown is NativeConfirm's (plan D1), shared by every prompt.
//   K9 (700 ms input delay, touch filter): NativeConfirm's, shared by every
//       prompt (plan D5), not part of the growth routing.
//
// The scanner is checked against inline fixtures first (a conforming module
// passes; each mutation fails its own rule and no other), so a green scan is
// never a scanner that cannot fail.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SWIFT_DIR =
  process.env.E2EE_GROWTH_SWIFT_DIR ||
  fileURLToPath(new URL("../../ios/App/SlogaE2ee/Sources", import.meta.url));

/** Each growth command, its plugin method, and the engine call's arguments as [label, FE key]. */
const GROWTH = [
  {
    method: "enableGroup",
    command: "e2ee_enable_group",
    args: [
      ["conversationId", "conversationId"],
      ["roster", "roster"],
      ["selfUserId", "selfUserId"],
      ["bundlesJson", "bundles"],
      ["displayNames", "displayNames"],
    ],
  },
  {
    method: "addGroupMember",
    command: "e2ee_add_group_member",
    args: [
      ["conversationId", "conversationId"],
      ["userId", "userId"],
      ["selfUserId", "selfUserId"],
      ["bundlesJson", "bundles"],
      ["displayNames", "displayNames"],
    ],
  },
] as const;

type Growth = (typeof GROWTH)[number];

const PRECONDITION = "dispatchPrecondition(condition:.notOnQueue(.main))";
const ARMED = "guardSelf.armedOrReject(call)else{return}";
const DEDICATED_REJECT = 'call.reject(E2eeReject.invalidArgument("name").json)';

// ---- Shared helpers ---------------------------------------------------------

/** Inclusive [start, end] index range in the source. */
type Span = [number, number];

const squash = (s: string) => s.replace(/\s+/g, "");
const sliceOf = (s: string, [from, to]: Span) => s.slice(from, to + 1);
const within = ([from, to]: Span, i: number) => i >= from && i <= to;

function lineOf(src: string, at: number): number {
  let line = 1;
  for (let i = 0; i < at && i < src.length; i++) if (src[i] === "\n") line++;
  return line;
}

function skipWs(code: string, i: number): number {
  while (i < code.length && /\s/.test(code[i])) i++;
  return i;
}

/** Index of the bracket closing the one at `open` (masked code), or throw. */
function matchClose(code: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const close = pairs[code[open]];
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === code[open]) depth++;
    else if (code[i] === close && --depth === 0) return i;
  }
  throw new Error(`unbalanced ${code[open]} at ${open}`);
}

/** The top-level elements between the bracket at `open` and its close, trimmed. */
function argSpans(code: string, open: number): Span[] {
  const close = matchClose(code, open);
  const out: Span[] = [];
  let start = open + 1;
  const push = (end: number) => {
    let from = start;
    let to = end - 1;
    while (from <= to && /\s/.test(code[from])) from++;
    while (to >= from && /\s/.test(code[to])) to--;
    if (from <= to) out.push([from, to]);
  };
  for (let i = open + 1; i < close; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") i = matchClose(code, i);
    else if (c === ",") {
      push(i);
      start = i + 1;
    }
  }
  push(close);
  return out;
}

/** The trailing closure of the call whose `(` is at `paren`, if any. */
function trailingClosure(code: string, paren: number): Span | null {
  const k = skipWs(code, matchClose(code, paren) + 1);
  return code[k] === "{" ? [k, matchClose(code, k)] : null;
}

/** Net `{` depth of [from, to) (masked code). */
function braceDepth(code: string, from: number, to: number): number {
  let depth = 0;
  for (let i = from; i < to; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") depth--;
  }
  return depth;
}

/** Whether the statement broken by the newline at `nl` goes on. */
function continues(code: string, nl: number, close: number): boolean {
  let p = nl - 1;
  while (p > 0 && /\s/.test(code[p])) p--;
  const k = skipWs(code, nl);
  if (k >= close) return false;
  if (/[=,+&|]/.test(code[p])) return true;
  if (code[k] === "." && code[k + 1] !== ".") return true;
  if (/^(?:&&|\|\||\?\?)/.test(code.slice(k, k + 2))) return true;
  return /^(?:else|catch)\b/.test(code.slice(k, k + 6));
}

/** The top-level statements of the block whose braces are `block`. */
function blockStatements(code: string, block: Span): Span[] {
  const [open, close] = block;
  const out: Span[] = [];
  let i = open + 1;
  for (;;) {
    while (i < close && /[\s;]/.test(code[i])) i++;
    if (i >= close) return out;
    const start = i;
    let depth = 0;
    let end = close;
    for (let j = i; j < close; j++) {
      const c = code[j];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      else if (depth === 0 && (c === "\n" || c === ";")) {
        if (c === "\n" && continues(code, j, close)) continue;
        end = j;
        break;
      }
    }
    let last = end - 1;
    while (last > start && /\s/.test(code[last])) last--;
    out.push([start, last]);
    i = end;
  }
}

// ---- Swift lexer ------------------------------------------------------------

interface Literal {
  /** The opening delimiter (first `#` or `"`) and the literal's last character. */
  open: number;
  close: number;
  /** The contents as written (escapes and interpolations included). */
  body: string;
}

interface Masked {
  src: string;
  /** Comments and string contents blanked; interpolations stay code. */
  code: string;
  /** Comments blanked; string contents kept. */
  text: string;
  literals: Literal[];
}

/**
 * Blanks Swift comments (block comments nest) and string / regex literal
 * contents with spaces (newlines kept), so every index is the same index in
 * `src`. `\(…)` (`\#(…)` in a `#"…"#` string) is scanned as code.
 */
function maskSwift(src: string): Masked {
  const code = src.split("");
  const text = src.split("");
  const literals: Literal[] = [];
  const n = src.length;
  const blank = (arr: string[], i: number) => {
    if (i < n && arr[i] !== "\n") arr[i] = " ";
  };
  const blankBoth = (i: number) => {
    blank(code, i);
    blank(text, i);
  };
  const hashesAt = (i: number) => {
    let k = 0;
    while (src[i + k] === "#") k++;
    return k;
  };

  /** A string literal whose first `#` or `"` is at `i`; returns the index past it. */
  const scanString = (i: number): number => {
    const hashes = hashesAt(i);
    const quoteAt = i + hashes;
    const multi = src.startsWith('"""', quoteAt);
    const closer = (multi ? '"""' : '"') + "#".repeat(hashes);
    const escape = "\\" + "#".repeat(hashes);
    const bodyStart = quoteAt + (multi ? 3 : 1);
    const done = (bodyEnd: number, next: number) => {
      literals.push({
        open: i,
        close: next - 1,
        body: src.slice(bodyStart, bodyEnd),
      });
      return next;
    };
    let j = bodyStart;
    while (j < n) {
      if (src.startsWith(closer, j)) return done(j, j + closer.length);
      if (!multi && src[j] === "\n") return done(j, j);
      if (src.startsWith(escape, j)) {
        const after = j + escape.length;
        if (src[after] === "(") {
          for (let k = j; k < after; k++) blank(code, k);
          j = scanCode(after + 1, true) + 1;
          continue;
        }
        for (let k = j; k <= after; k++) blank(code, k);
        j = after + 1;
        continue;
      }
      blank(code, j++);
    }
    return done(n, n);
  };

  /** A `#/…/#` regex literal starting at `i`; returns the index past it. */
  const scanRegex = (i: number): number => {
    const hashes = hashesAt(i);
    const closer = "/" + "#".repeat(hashes);
    let j = i + hashes + 1;
    while (j < n && !src.startsWith(closer, j)) {
      if (src[j] === "\\") blank(code, j++);
      blank(code, j++);
    }
    return Math.min(n, j + closer.length);
  };

  /** Scans code from `start`; returns the index of an unmatched `)` or `n`. */
  const scanCode = (start: number, untilParen: boolean): number => {
    let i = start;
    let depth = 0;
    while (i < n) {
      const c = src[i];
      const next = src[i + 1];
      if (c === "/" && next === "/") {
        while (i < n && src[i] !== "\n") blankBoth(i++);
        continue;
      }
      if (c === "/" && next === "*") {
        let nest = 0;
        while (i < n) {
          if (src[i] === "/" && src[i + 1] === "*") nest++;
          else if (src[i] === "*" && src[i + 1] === "/") nest--;
          else {
            blankBoth(i++);
            continue;
          }
          blankBoth(i++);
          blankBoth(i++);
          if (nest === 0) break;
        }
        continue;
      }
      if (c === '"') {
        i = scanString(i);
        continue;
      }
      if (c === "#") {
        const after = src[i + hashesAt(i)];
        if (after === '"') {
          i = scanString(i);
          continue;
        }
        if (after === "/") {
          i = scanRegex(i);
          continue;
        }
      }
      if (c === "(") depth++;
      else if (c === ")") {
        if (untilParen && depth === 0) return i;
        depth--;
      }
      i++;
    }
    return n;
  };

  scanCode(0, false);
  return { src, code: code.join(""), text: text.join(""), literals };
}

// ---- Swift structure --------------------------------------------------------

interface SwiftFile {
  path: string;
  name: string;
  m: Masked;
}

interface SwiftFunc {
  name: string;
  at: number;
  /** Attributes and modifiers right before `func`, space-separated. */
  modifiers: string;
  /** The parameter list's `(` and `)`. */
  params: Span;
  /** The body's `{` and `}`; null for a requirement with no body. */
  body: Span | null;
}

const FUNC_DEF = /\bfunc\s+(\w+)\s*(?:<[^<>{}()]*>\s*)?\(/g;
const MODIFIERS =
  /(?<![\w@.])(?:(?:@\w+(?:\([^()]*\))?|public|private|fileprivate|internal|open|static|class|final|override|dynamic|mutating|nonisolated|required|convenience)\s+)*$/;
const SIGNATURE_TAIL =
  /^\s*(?:async\s+)?(?:throws\s+|rethrows\s+)?(?:->[^{}\n]+)?\s*$/;

/** Every `func` definition in the file (nested ones included). */
function swiftFuncs(code: string): SwiftFunc[] {
  const out: SwiftFunc[] = [];
  for (const match of code.matchAll(FUNC_DEF)) {
    const paren = match.index + match[0].length - 1;
    const parenClose = matchClose(code, paren);
    const brace = code.indexOf("{", parenClose);
    const hasBody =
      brace >= 0 && SIGNATURE_TAIL.test(code.slice(parenClose + 1, brace));
    const before = code.slice(Math.max(0, match.index - 160), match.index);
    out.push({
      name: match[1],
      at: match.index,
      modifiers: (MODIFIERS.exec(before)?.[0] ?? "").trim(),
      params: [paren, parenClose],
      body: hasBody ? [brace, matchClose(code, brace)] : null,
    });
  }
  return out;
}

/** The internal name of the last parameter (`_ body: …` → `body`). */
function lastParam(code: string, params: Span): string | null {
  const spans = argSpans(code, params[0]);
  if (spans.length === 0) return null;
  const m = /^(?:\w+\s+)?(\w+)\s*:/.exec(
    sliceOf(code, spans[spans.length - 1]),
  );
  return m ? m[1] : null;
}

/** Indices of the identifier `name` inside `span` (masked code). */
function refsOf(code: string, name: string, span: Span): number[] {
  return [...code.matchAll(new RegExp(String.raw`\b${name}\b`, "g"))]
    .map((h) => h.index)
    .filter((i) => within(span, i));
}

/** The `[` … `]` of `static let <name> … = [ … ]`. */
function arrayLiteral(code: string, name: string): Span | null {
  const hit = new RegExp(
    String.raw`\bstatic\s+let\s+${name}\b[^=]*=\s*\[`,
  ).exec(code);
  if (!hit) return null;
  const open = hit.index + hit[0].length - 1;
  return [open, matchClose(code, open)];
}

interface Clause {
  /** From `case` / `default` to its `:`. */
  pattern: Span;
  body: Span;
}

/** The clauses of the switch whose braces are `block`. */
function switchClauses(code: string, block: Span): Clause[] {
  const [open, close] = block;
  const heads: Span[] = [];
  let depth = 0;
  for (let i = open + 1; i < close; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    if (depth !== 0 || !/^(?:case|default)\b/.test(code.slice(i, i + 8))) {
      continue;
    }
    if (/\w/.test(code[i - 1])) continue;
    const lineStart = Math.max(code.lastIndexOf("\n", i) + 1, open + 1);
    if (code.slice(lineStart, i).trim() !== "") continue;
    let d = 0;
    let colon = i;
    for (; colon < close; colon++) {
      const ch = code[colon];
      if (ch === "(" || ch === "[" || ch === "{") d++;
      else if (ch === ")" || ch === "]" || ch === "}") d--;
      else if (ch === ":" && d === 0) break;
    }
    heads.push([i, colon]);
    i = colon;
  }
  return heads.map((head, k) => ({
    pattern: head,
    body: [head[1] + 1, (k + 1 < heads.length ? heads[k + 1][0] : close) - 1],
  }));
}

const spells = (body: string, command: string) =>
  new RegExp(String.raw`(?<![a-z0-9_])${command}(?![a-z0-9_])`).test(body);

const where = (f: SwiftFile, at: number) => `${f.path}:${lineOf(f.m.src, at)}`;

/** One mention of enableGroup / addGroupMember in code. */
interface Ref {
  file: SwiftFile;
  name: string;
  at: number;
  kind: "def" | "call" | "other";
  /** The `.` before the name and the `(` after it (calls). */
  dot: number;
  paren: number;
}

function growthRefs(files: SwiftFile[]): Ref[] {
  const out: Ref[] = [];
  for (const file of files) {
    const { code } = file.m;
    for (const hit of code.matchAll(/\b(enableGroup|addGroupMember)\b/g)) {
      const at = hit.index;
      let dot = at - 1;
      while (dot >= 0 && /\s/.test(code[dot])) dot--;
      const paren = skipWs(code, at + hit[0].length);
      const kind = /\bfunc\s+$/.test(code.slice(Math.max(0, at - 32), at))
        ? "def"
        : code[dot] === "." && code[paren] === "("
          ? "call"
          : "other";
      out.push({ file, name: hit[1], at, kind, dot, paren });
    }
  }
  return out;
}

/** The first `func G` with a body (S4 reports a missing or doubled one). */
const growthMethod = (funcs: SwiftFunc[], g: Growth) =>
  funcs.find((f) => f.name === g.method && f.body !== null);

/** The trailing closure of the method's one `Self.onDedicatedThread(call, "…") { … }`. */
function dedicatedClosure(
  m: Masked,
  body: Span,
): { closure: Span | null; problem: string | null } {
  const { code, text } = m;
  const hits = [
    ...code.matchAll(/\bSelf\s*\.\s*onDedicatedThread\s*\(/g),
  ].filter((h) => within(body, h.index));
  if (hits.length !== 1) {
    return {
      closure: null,
      problem: `has ${hits.length} Self.onDedicatedThread( hand-offs; exactly one`,
    };
  }
  const paren = hits[0].index + hits[0][0].length - 1;
  const args = argSpans(code, paren);
  const closure = trailingClosure(code, paren);
  if (!closure) {
    return { closure, problem: "hands off with no trailing closure" };
  }
  const named =
    args.length === 2 &&
    squash(sliceOf(code, args[0])) === "call" &&
    /^"[^"\\]+"$/.test(squash(sliceOf(text, args[1])));
  return {
    closure,
    problem: named
      ? null
      : 'hands off as something other than Self.onDedicatedThread(call, "<thread name>")',
  };
}

const ENGINE_RECEIVER =
  /(?<![\w.])(?:(E2eeRuntime\s*\.\s*shared\s*\.\s*engine\s*\(\s*\))|(engine))\s*$/;

/** Where an engine-call argument comes from: an `E2eeCallArgs(call)` reader. */
function argSource(
  value: string,
  tuples: Map<string, Map<string, string>>,
  argNames: string[],
): { reader: string; key: string; field: boolean } | null {
  let v = value.replace(/^try\s+/, "").trim();
  const member = /^(\w+)\s*\.\s*(\w+)$/.exec(v);
  if (member) {
    const field = tuples.get(member[1])?.get(member[2]);
    if (field === undefined) return null;
    v = field.replace(/^try\s+/, "").trim();
  }
  const read =
    /^(\w+|E2eeCallArgs\(call\))\.(\w+)\("([^"\\]*)"(,field:"[^"\\]*")?\)$/.exec(
      squash(v),
    );
  if (!read) return null;
  if (read[1] !== "E2eeCallArgs(call)" && !argNames.includes(read[1])) {
    return null;
  }
  return { reader: read[2], key: read[3], field: read[4] !== undefined };
}

// ---- Rules ------------------------------------------------------------------

function ruleTable(commands: SwiftFile, out: string[]) {
  const { code, text, literals } = commands.m;
  const table = arrayLiteral(code, "table");
  const methods = arrayLiteral(code, "dedicatedMethods");
  if (!table) out.push("S1 E2eeCommands.swift has no `static let table = [`");
  if (!methods) {
    out.push("S1 E2eeCommands.swift has no `static let dedicatedMethods = [`");
  }
  for (const g of GROWTH) {
    const spelled = literals.filter((l) => spells(l.body, g.command));
    if (spelled.length !== 1) {
      out.push(
        `S1 E2eeCommands.swift spells ${g.command} ${spelled.length} times; exactly once (the route map keeps a name's first entry)`,
      );
    }
    if (table) {
      const entry = new RegExp(
        String.raw`^\((?:name:)?"${g.command}",(?:route:)?(?:E2eeRoute)?\.dedicated\("${g.method}"\)\)$`,
      );
      const hits = argSpans(code, table[0]).filter((s) =>
        entry.test(squash(sliceOf(text, s))),
      );
      if (hits.length !== 1) {
        out.push(
          `S1 the table has no ("${g.command}", .dedicated("${g.method}")) entry`,
        );
      }
    }
    if (methods) {
      const listed = argSpans(code, methods[0]).filter(
        (s) => squash(sliceOf(text, s)) === `"${g.method}"`,
      );
      if (listed.length !== 1) {
        out.push(
          `S1 dedicatedMethods lists "${g.method}" ${listed.length} times; exactly once`,
        );
      }
    }
  }
}

function ruleMux(plugin: SwiftFile, funcs: SwiftFunc[], out: string[]) {
  const { code, text } = plugin.m;
  const muxes = funcs.filter(
    (f) =>
      f.name === "call" &&
      squash(sliceOf(code, f.params)) === "(_call:CAPPluginCall)",
  );
  const body = muxes.length === 1 ? muxes[0].body : null;
  if (!body) {
    out.push(
      `S2 E2eePlugin.swift has ${muxes.length} func call(_ call: CAPPluginCall); exactly one, with a body`,
    );
    return;
  }
  const switches = [
    ...code.matchAll(/\bswitch\s+E2eeCommands\s*\.\s*route\s*\(\s*for\s*:/g),
  ].filter((h) => within(body, h.index));
  if (switches.length !== 1) {
    out.push(
      `S2 call(_:) has ${switches.length} switch E2eeCommands.route(for:) statements; exactly one`,
    );
    return;
  }
  const paren = code.indexOf("(", switches[0].index);
  const open = skipWs(code, matchClose(code, paren) + 1);
  if (code[open] !== "{") {
    out.push("S2 call(_:) has no switch body after E2eeCommands.route(for:)");
    return;
  }
  const dedicated = switchClauses(code, [open, matchClose(code, open)]).filter(
    (c) => /\.\s*dedicated\b/.test(sliceOf(code, c.pattern)),
  );
  if (dedicated.length !== 1) {
    out.push(
      `S2 call(_:) has ${dedicated.length} clauses for .dedicated; exactly one, which refuses`,
    );
    return;
  }
  if (squash(sliceOf(text, dedicated[0].body)) !== DEDICATED_REJECT) {
    out.push(
      `S2 call(_:) does more than reject a .dedicated route with invalid_argument{field:"name"} (${where(plugin, dedicated[0].pattern[0])})`,
    );
  }
}

function ruleLiterals(
  files: SwiftFile[],
  commands: SwiftFile,
  plugin: SwiftFile,
  funcs: SwiftFunc[],
  out: string[],
) {
  const generic = funcs.find((f) => f.name === "runGeneric")?.body ?? null;
  for (const f of files) {
    if (f === commands) continue;
    for (const lit of f.m.literals) {
      for (const g of GROWTH) {
        if (!spells(lit.body, g.command)) continue;
        const lineStart = f.m.code.lastIndexOf("\n", lit.open) + 1;
        const label =
          f === plugin &&
          generic !== null &&
          within(generic, lit.open) &&
          /^\s*case\b/.test(f.m.code.slice(lineStart, lit.open));
        out.push(
          label
            ? `S3 runGeneric has a case label "${g.command}" (${where(f, lit.open)}): a confirm-gated command in the generic switch`
            : `S3 "${g.command}" is spelled outside the command table (${where(f, lit.open)})`,
        );
      }
    }
  }
}

function ruleMethods(plugin: SwiftFile, funcs: SwiftFunc[], out: string[]) {
  const { code } = plugin.m;
  if (funcs.filter((f) => f.name === "armedOrReject" && f.body).length !== 1) {
    out.push("S4 E2eePlugin.swift does not define armedOrReject exactly once");
  }
  for (const g of GROWTH) {
    const defs = funcs.filter((f) => f.name === g.method);
    if (defs.length !== 1) {
      out.push(
        `S4 E2eePlugin.swift defines func ${g.method} ${defs.length} times; exactly once`,
      );
    }
    if (defs.length === 0) continue;
    const def = defs[0];
    const at = where(plugin, def.at);
    const words = def.modifiers.split(/\s+/);
    if (
      !words.includes("@objc") ||
      words.includes("static") ||
      words.includes("class")
    ) {
      out.push(`S4 func ${g.method} is not an @objc instance method (${at})`);
    }
    if (squash(sliceOf(code, def.params)) !== "(_call:CAPPluginCall)") {
      out.push(
        `S4 func ${g.method} does not take (_ call: CAPPluginCall) (${at})`,
      );
    }
    const first = def.body ? blockStatements(code, def.body)[0] : undefined;
    if (!first || squash(sliceOf(code, first)) !== ARMED) {
      out.push(
        `S4 func ${g.method} does not open with guard Self.armedOrReject(call) else { return } (${at})`,
      );
    }
  }
}

function ruleCommit(
  plugin: SwiftFile,
  funcs: SwiftFunc[],
  refs: Ref[],
  out: string[],
) {
  const { code } = plugin.m;
  for (const ref of refs) {
    if (ref.file !== plugin) {
      out.push(
        `S5 ${ref.name} is named in ${where(ref.file, ref.at)}: only E2eePlugin.swift may commit a group growth`,
      );
    } else if (ref.kind === "other") {
      out.push(
        `S5 ${ref.name} is referenced without being called (${where(plugin, ref.at)}): a method reference escapes every placement rule`,
      );
    }
  }
  for (const g of GROWTH) {
    const calls = refs.filter(
      (r) => r.file === plugin && r.kind === "call" && r.name === g.method,
    );
    if (calls.length !== 1) {
      out.push(
        `S5 E2eePlugin.swift calls .${g.method}( ${calls.length} times; exactly once`,
      );
    }
    const method = growthMethod(funcs, g);
    if (!method?.body) continue;
    const { closure, problem } = dedicatedClosure(plugin.m, method.body);
    if (problem) out.push(`S5 func ${g.method} ${problem}`);
    if (closure) {
      const first = blockStatements(code, closure)[0];
      if (!first || squash(sliceOf(code, first)) !== PRECONDITION) {
        out.push(
          `S5 the ${g.method} dedicated closure does not open with dispatchPrecondition(condition: .notOnQueue(.main))`,
        );
      }
    }
    for (const c of calls) {
      const at = where(plugin, c.at);
      if (!within(method.body, c.at)) {
        out.push(`S5 .${g.method}( is called outside func ${g.method} (${at})`);
        continue;
      }
      if (!closure || !within(closure, c.at)) {
        out.push(
          `S5 .${g.method}( is called outside its Self.onDedicatedThread closure (${at})`,
        );
        continue;
      }
      if (braceDepth(code, closure[0] + 1, c.at) !== 0) {
        out.push(
          `S5 .${g.method}( is nested in a block or closure inside the dedicated closure (${at})`,
        );
        continue;
      }
      const receiver = ENGINE_RECEIVER.exec(
        code.slice(Math.max(0, c.dot - 80), c.dot),
      );
      if (!receiver) {
        out.push(
          `S5 .${g.method}( is not called on E2eeRuntime.shared.engine() (${at})`,
        );
      } else if (receiver[2]) {
        const bound = blockStatements(code, closure).some(
          (s) =>
            s[1] < c.at &&
            squash(sliceOf(code, s)) ===
              "letengine=tryE2eeRuntime.shared.engine()",
        );
        if (!bound) {
          out.push(
            `S5 .${g.method}( is called on an \`engine\` the dedicated closure did not bind to E2eeRuntime.shared.engine() (${at})`,
          );
        }
      }
    }
  }
}

function ruleThread(
  files: SwiftFile[],
  plugin: SwiftFile,
  support: SwiftFile,
  funcs: SwiftFunc[],
  out: string[],
) {
  const { code } = plugin.m;
  const helpers = funcs.filter((f) => f.name === "onDedicatedThread");
  const helper = helpers.length === 1 ? helpers[0] : null;
  if (!helper?.body) {
    out.push(
      `S6 E2eePlugin.swift defines onDedicatedThread ${helpers.length} times; exactly once, with a body`,
    );
  } else {
    const body = helper.body;
    const statements = blockStatements(code, body);
    const only = statements.length === 1 ? statements[0] : null;
    const inner =
      only && /^runOnDedicatedThread\s*\(\s*name\s*:/.test(sliceOf(code, only))
        ? trailingClosure(code, code.indexOf("(", only[0]))
        : null;
    if (!only || !inner || inner[1] !== only[1]) {
      out.push(
        `S6 onDedicatedThread does more than hand its body to runOnDedicatedThread(name:) { … } (${where(plugin, body[0])})`,
      );
    } else {
      const first = blockStatements(code, inner)[0];
      if (!first || squash(sliceOf(code, first)) !== PRECONDITION) {
        out.push(
          "S6 the runOnDedicatedThread closure in onDedicatedThread does not open with dispatchPrecondition(condition: .notOnQueue(.main))",
        );
      }
      if (
        !/(?:\bSelf\s*\.\s*|(?<![\w.]))settle\s*\(\s*call\s*\)/.test(
          sliceOf(code, inner),
        )
      ) {
        out.push(
          "S6 onDedicatedThread does not settle the call through settle(call)",
        );
      }
      const param = lastParam(code, helper.params);
      const uses = param ? refsOf(code, param, body) : [];
      if (uses.length === 0 || uses.some((i) => !within(inner, i))) {
        out.push(
          "S6 onDedicatedThread uses its body parameter outside the new thread's closure",
        );
      }
    }
  }

  const runners = files.flatMap((f) =>
    swiftFuncs(f.m.code)
      .filter((fn) => fn.name === "runOnDedicatedThread")
      .map((fn) => ({ f, fn })),
  );
  const runner =
    runners.length === 1 && runners[0].f === support ? runners[0].fn : null;
  if (!runner?.body) {
    out.push(
      `S6 runOnDedicatedThread is defined ${runners.length} times; exactly once, in Support.swift, with a body`,
    );
    return;
  }
  const sc = support.m.code;
  const body = runner.body;
  const bodyCode = sliceOf(sc, body);
  const hit = /\bThread\s*(?:\(\s*block\s*:\s*)?\{/.exec(bodyCode);
  const threadOpen = hit ? body[0] + hit.index + hit[0].length - 1 : -1;
  const thread: Span | null = hit
    ? [threadOpen, matchClose(sc, threadOpen)]
    : null;
  if (!thread || !/\.\s*start\s*\(\s*\)/.test(bodyCode)) {
    out.push("S6 runOnDedicatedThread does not start a new Thread");
  }
  if (
    /\bengineWorker\b|\.\s*submit\s*\(|\bDispatchQueue\b|\bOperationQueue\b|\basync\b|\bTask\s*\{/.test(
      bodyCode,
    )
  ) {
    out.push(
      "S6 runOnDedicatedThread involves a queue, worker, task or async, not only a thread of its own",
    );
  }
  const param = lastParam(sc, runner.params);
  const uses = param ? refsOf(sc, param, body) : [];
  if (!thread || uses.length === 0 || uses.some((i) => !within(thread, i))) {
    out.push("S6 runOnDedicatedThread runs its body outside the new Thread");
  }
}

function ruleArgs(
  plugin: SwiftFile,
  funcs: SwiftFunc[],
  refs: Ref[],
  out: string[],
) {
  const { code, text } = plugin.m;
  for (const g of GROWTH) {
    const body = growthMethod(funcs, g)?.body;
    if (!body) continue;
    const argNames = [
      ...code.matchAll(/\blet\s+(\w+)\s*=\s*E2eeCallArgs\s*\(\s*call\s*\)/g),
    ]
      .filter((h) => within(body, h.index))
      .map((h) => h[1]);
    const tuples = new Map<string, Map<string, string>>();
    for (const h of code.matchAll(
      /\bguard\s+let\s+(\w+)\s*=\s*Self\s*\.\s*validated\s*\(/g,
    )) {
      if (!within(body, h.index)) continue;
      const spans = argSpans(code, h.index + h[0].length - 1);
      if (spans.length !== 2 || code[spans[1][0]] !== "{") continue;
      const open = spans[1][0];
      const close = matchClose(code, open);
      const paren = code.indexOf("(", open);
      if (paren < 0 || paren > close) continue;
      if (!/^(?:return)?try$/.test(squash(code.slice(open + 1, paren)))) {
        continue;
      }
      if (code.slice(matchClose(code, paren) + 1, close).trim() !== "")
        continue;
      const fields = new Map<string, string>();
      for (const s of argSpans(code, paren)) {
        const entry = /^(\w+)\s*:\s*([\s\S]+)$/.exec(sliceOf(text, s));
        if (entry) fields.set(entry[1], entry[2].trim());
      }
      tuples.set(h[1], fields);
    }
    const calls = refs.filter(
      (r) =>
        r.file === plugin &&
        r.kind === "call" &&
        r.name === g.method &&
        within(body, r.at),
    );
    for (const c of calls) {
      const at = where(plugin, c.at);
      const parsed = argSpans(code, c.paren).map((s) =>
        /^(\w+)\s*:\s*([\s\S]*)$/.exec(sliceOf(text, s)),
      );
      const labels = parsed.map((p) => p?.[1] ?? "_");
      const expected = g.args.map(([label]) => label);
      if (labels.join() !== expected.join()) {
        out.push(
          `S7 .${g.method}( passes (${labels.join(", ")}); expected (${expected.join(", ")}) (${at})`,
        );
        continue;
      }
      g.args.forEach(([label, key], k) => {
        const value = (parsed[k]?.[2] ?? "").trim();
        const source = argSource(value, tuples, argNames);
        const ok =
          source !== null &&
          source.key === key &&
          (label !== "selfUserId" ||
            (source.reader === "string" && !source.field));
        if (ok) return;
        out.push(
          label === "selfUserId"
            ? `S7 .${g.method}( selfUserId: ${squash(value)} is not the FE's selfUserId read with args.string("selfUserId") (${at})`
            : `S7 .${g.method}( ${label}: ${squash(value)} does not come from the call's "${key}" argument (${at})`,
        );
      });
    }
  }
}

function ruleResolve(
  plugin: SwiftFile,
  funcs: SwiftFunc[],
  refs: Ref[],
  out: string[],
) {
  const { code, text } = plugin.m;
  for (const g of GROWTH) {
    const body = growthMethod(funcs, g)?.body;
    if (!body) continue;
    const { closure } = dedicatedClosure(plugin.m, body);
    if (!closure) continue;
    // The commit S5 accepts: directly in the closure, not a nested one.
    const call = refs.find(
      (r) =>
        r.file === plugin &&
        r.kind === "call" &&
        r.name === g.method &&
        within(closure, r.at) &&
        braceDepth(code, closure[0] + 1, r.at) === 0,
    );
    if (!call) continue;
    const statements = blockStatements(code, closure);
    const k = statements.findIndex((s) => within(s, call.at));
    const statement = k >= 0 ? sliceOf(text, statements[k]) : "";
    const bound = /^let\s+(\w+)\s*=\s*try\s/.exec(statement);
    let resolved = false;
    if (bound) {
      resolved = statements
        .slice(k + 1)
        .some((s) => squash(sliceOf(text, s)) === `return.json(${bound[1]})`);
    } else if (/^return\s+\.json\s*\(\s*try\s/.test(statement)) {
      resolved =
        matchClose(code, code.indexOf("(", statements[k][0])) ===
        statements[k][1];
    }
    if (!resolved) {
      out.push(
        `S8 the .${g.method}( result is not what the closure resolves as return .json(…) (${where(plugin, call.at)})`,
      );
    }
    const returns = [...sliceOf(code, closure).matchAll(/\breturn\b/g)].length;
    if (returns !== 1) {
      out.push(
        `S8 the ${g.method} dedicated closure has ${returns} returns; exactly the .json one`,
      );
    }
    if (/\.\s*empty\b/.test(sliceOf(code, closure))) {
      out.push(
        `S8 the ${g.method} dedicated closure resolves {} (.empty), not {json}`,
      );
    }
  }
  const resolution = /\benum\s+Resolution\b[^{]*\{/.exec(code);
  const cases = resolution
    ? squash(
        sliceOf(code, [
          resolution.index + resolution[0].length - 1,
          matchClose(code, resolution.index + resolution[0].length - 1),
        ]),
      )
    : "";
  if (!cases.includes("casejson(String)")) {
    out.push("S8 there is no `enum Resolution { case json(String) … }`");
  }
  const settles = funcs.filter((f) => f.name === "settle");
  const settle = settles.length === 1 ? settles[0].body : null;
  if (!settle) {
    out.push(
      `S8 settle is defined ${settles.length} times; exactly once, with a body`,
    );
    return;
  }
  const s = squash(sliceOf(text, settle));
  if (!/case\.json\(let(\w+)\):call\.resolve\(\["json":\1\]\)/.test(s)) {
    out.push(
      'S8 settle does not resolve .json(x) as call.resolve(["json": x])',
    );
  }
  if (!s.includes("catch{call.reject(rejectJson(for:error))}")) {
    out.push(
      "S8 settle does not reject with call.reject(rejectJson(for: error))",
    );
  }
}

/** Every violation in the module, as "S<n> <message>". */
function swiftViolations(sources: Record<string, string>): string[] {
  const files: SwiftFile[] = Object.entries(sources).map(([path, src]) => ({
    path,
    name: basename(path),
    m: maskSwift(src),
  }));
  const only = (name: string) => {
    const hits = files.filter((f) => f.name === name);
    assert.equal(
      hits.length,
      1,
      `expected exactly one ${name} among ${files.length} Swift files`,
    );
    return hits[0];
  };
  const plugin = only("E2eePlugin.swift");
  const commands = only("E2eeCommands.swift");
  const support = only("Support.swift");
  const funcs = swiftFuncs(plugin.m.code);
  const refs = growthRefs(files);
  const out: string[] = [];
  ruleTable(commands, out);
  ruleMux(plugin, funcs, out);
  ruleLiterals(files, commands, plugin, funcs, out);
  ruleMethods(plugin, funcs, out);
  ruleCommit(plugin, funcs, refs, out);
  ruleThread(files, plugin, support, funcs, out);
  ruleArgs(plugin, funcs, refs, out);
  ruleResolve(plugin, funcs, refs, out);
  return out;
}

// ---- Fixtures: the scanner itself must be able to fail ----------------------

test("swift lexer: comments, strings, raw strings, regexes, interpolations", () => {
  const src = String.raw`let a = "x // y" // tail
/* outer /* inner */ still */ let b = #"raw "q" \(no)"# + #"\#(live(1))"#
let c = """
    multi "quoted" \(inner("s"))
    """
let d = #/re\(x/# // done`;
  const m = maskSwift(src);
  assert.equal(m.code.length, src.length);
  assert.equal(m.text.length, src.length);
  for (let i = 0; i < src.length; i++) {
    assert.equal(m.code[i] === "\n", src[i] === "\n", `newline at ${i}`);
  }
  for (const gone of [
    "tail",
    "outer",
    "still",
    "raw",
    "(no)",
    "quoted",
    String.raw`re\(x`,
    "done",
    "//",
  ]) {
    assert.ok(!m.code.includes(gone), `code still holds ${gone}`);
  }
  for (const kept of ["let a =", "let b =", "live(1)", "inner(", "let d ="]) {
    assert.ok(m.code.includes(kept), `code lost ${kept}`);
  }
  assert.ok(m.text.includes('"x // y"'));
  assert.ok(m.text.includes(String.raw`#"raw "q" \(no)"#`));
  assert.ok(!m.text.includes("tail") && !m.text.includes("outer"));
  const bodies = m.literals.map((l) => l.body);
  for (const body of [
    "x // y",
    String.raw`raw "q" \(no)`,
    String.raw`\#(live(1))`,
    "s",
  ]) {
    assert.ok(
      bodies.includes(body),
      `no literal ${body}: ${bodies.join(" | ")}`,
    );
  }
});

/** A conforming plugin; trailing comments only make swap targets unique. */
const FX_PLUGIN = String.raw`
import AcutestE2eeBindings
import Capacitor
import Foundation

@objc(E2eePlugin)
public final class E2eePlugin: CAPPlugin, CAPBridgedPlugin {
    private static var armed = false

    private static func armedOrReject(_ call: CAPPluginCall) -> Bool {
        if !armed {
            call.reject(E2eeReject.cryptoFailure.json)
        }
        return armed
    }

    @objc func call(_ call: CAPPluginCall) {
        guard Self.armedOrReject(call) else { return }
        guard let name = Self.validated(call, { try E2eeCallArgs(call).string("__cmd") }) else {
            return
        }
        switch E2eeCommands.route(for: name) {
        case .generic: // generic-arm
            E2eeRuntime.shared.engineWorker.submit {
                dispatchPrecondition(condition: .notOnQueue(.main))
                Self.settle(call) {
                    .json(try Self.runGeneric(name, E2eeCallArgs(call)))
                }
            }
        case .native:
            call.reject(E2eeReject.invalidArgument("name").json)
        case .dedicated, .out: // dedicated-arm
            // A dedicated name sent through call is refused like an unknown one.
            call.reject(E2eeReject.invalidArgument("name").json) // dedicated-reject
        }
    }

    @objc func wipe(_ call: CAPPluginCall) {
        guard Self.armedOrReject(call) else { return }
        Self.onDedicatedThread(call, "gg.sloga.e2ee.wipe") {
            dispatchPrecondition(condition: .notOnQueue(.main))
            try E2eeRuntime.shared.engine().wipe()
            return .json("null")
        }
    }

    @objc func enableGroup(_ call: CAPPluginCall) { // enable-def
        guard Self.armedOrReject(call) else { return } // enable-armed
        let args = E2eeCallArgs(call)
        guard let input = Self.validated(call, {
            try (
                conversationId: args.string("conversationId"),
                roster: args.strings("roster"),
                selfUserId: args.string("selfUserId"), // enable-self-read
                bundles: args.optionalArrayJSON("bundles"),
                displayNames: args.optionalStringMap("displayNames") // enable-names-read
            )
        }) else {
            return
        }
        Self.onDedicatedThread(call, "gg.sloga.e2ee.enable-group") { // enable-thread
            dispatchPrecondition(condition: .notOnQueue(.main)) // enable-precondition
            // Not a commit: engine.enableGroup(conversationId: "e2ee_enable_group")
            /* nor this: /* nested */ engine.addGroupMember(x) */
            let json = try E2eeRuntime.shared.engine().enableGroup( // enable-commit
                conversationId: input.conversationId,
                roster: input.roster, // enable-roster
                selfUserId: input.selfUserId, // enable-self
                bundlesJson: input.bundles,
                displayNames: input.displayNames // enable-names
            )
            return .json(json) // enable-return
        }
    }

    @objc func addGroupMember(_ call: CAPPluginCall) { // add-def
        guard Self.armedOrReject(call) else { return } // add-armed
        let args = E2eeCallArgs(call)
        guard let input = Self.validated(call, {
            try (
                conversationId: args.string("conversationId"),
                userId: args.string("userId"),
                selfUserId: args.string("selfUserId"), // add-self-read
                bundles: args.optionalArrayJSON("bundles"), // add-bundles-read
                displayNames: args.optionalStringMap("displayNames")
            )
        }) else {
            return
        }
        Self.onDedicatedThread(call, "gg.sloga.e2ee.add-group-member") { // add-thread
            dispatchPrecondition(condition: .notOnQueue(.main)) // add-precondition
            let json = try E2eeRuntime.shared.engine().addGroupMember( // add-commit
                conversationId: input.conversationId,
                userId: input.userId,
                selfUserId: input.selfUserId, // add-self
                bundlesJson: input.bundles,
                displayNames: input.displayNames // add-names
            )
            return .json(json) // add-return
        }
    }
}

private extension E2eePlugin {
    enum Resolution {
        case json(String)
        case empty
    }

    static let note = """
        engine.enableGroup(x) inside a "multi-line" string // not a comment
        \(jsonQuote("addGroupMember"))
        """

    static let pattern = #/addGroupMember\(/#

    static func validated<T>(_ call: CAPPluginCall, _ read: () throws -> T) -> T? {
        do {
            return try read()
        } catch {
            call.reject(rejectJson(for: error))
            return nil
        }
    }

    static func settle(_ call: CAPPluginCall, _ body: () throws -> Resolution) {
        do {
            switch try body() {
            case .json(let json):
                call.resolve(["json": json]) // settle-resolve
            case .empty:
                call.resolve([:])
            }
        } catch {
            call.reject(rejectJson(for: error)) // settle-reject
        }
    }

    static func onDedicatedThread(_ call: CAPPluginCall, _ name: String, _ body: @escaping () throws -> Resolution) {
        runOnDedicatedThread(name: name) { // helper-thread
            dispatchPrecondition(condition: .notOnQueue(.main)) // helper-precondition
            settle(call) {
                try E2eeRuntime.shared.withBackgroundTask(name, body)
            }
        }
    }

    static func runGeneric(_ name: String, _ args: E2eeCallArgs) throws -> String {
        dispatchPrecondition(condition: .notOnQueue(.main))
        let engine = try E2eeRuntime.shared.engine()
        switch name {
        case "e2ee_status": // generic-status
            return try engine.status()
        /* case "e2ee_enable_group":
            return try engine.enableGroup(conversationId: "", roster: [], selfUserId: "", bundlesJson: nil, displayNames: nil) */
        case "e2ee_note": // generic-note
            return #"engine.addGroupMember(userId: "x") \(engine.enableGroup())"#
        case "e2ee_quote":
            return "say \"e2ee_enable\" \(jsonQuote("enable_group"))"
        default:
            throw E2eeReject.invalidArgument("name")
        }
    }
}
`;

const FX_COMMANDS = String.raw`
import Foundation

enum E2eeRoute: Equatable {
    case generic
    case native
    case dedicated(String)
    case out
}

enum E2eeCommands {
    // ("e2ee_enable_group", .generic) would hand the commit to the worker.
    static let table: [(name: String, route: E2eeRoute)] = [
        ("e2ee_status", .generic), // table-status
        ("e2ee_wipe", .dedicated("wipe")),
        ("e2ee_enable_group", .dedicated("enableGroup")), // table-enable
        ("e2ee_add_group_member", .dedicated("addGroupMember")), // table-add
        ("e2ee_call_create", .out),
    ]

    static let dedicatedMethods: [String] = [
        "wipe",
        "enableGroup", // methods-enable
        "addGroupMember", // methods-add
    ]

    static func route(for name: String) -> E2eeRoute {
        table.first { $0.name == name }?.route ?? .out
    }
}
`;

const FX_SUPPORT = String.raw`
import Foundation

let engineThreadStackSize = 8 << 20

/// Runs body on a NEW thread of its own; never the engine worker.
func runOnDedicatedThread(name: String, _ body: @escaping () -> Void) {
    let thread = Thread { // support-thread
        autoreleasepool {
            body()
        }
    }
    thread.name = name
    thread.stackSize = engineThreadStackSize
    thread.start() // support-start
}

final class E2eeRuntime {
    static let shared = E2eeRuntime()
    let engineWorker = WorkerPool(name: "gg.sloga.e2ee.engine", threads: 1)

    func engine() throws -> E2eeEngine {
        dispatchPrecondition(condition: .notOnQueue(.main))
        return try E2eeEngine(storeDir: "", confirm: NativeConfirmPresenter.shared)
    }
}
`;

const FX_OTHER = String.raw`
import UIKit

/// Draws the core's growth prompt (enableGroup, addGroupMember); never commits.
final class NativeConfirmPresenter {
    static let shared = NativeConfirmPresenter()
    let label = "addGroupMember is the plugin's job" // other-label

    func confirm() -> Bool {
        dispatchPrecondition(condition: .notOnQueue(.main))
        return false
    }
}
`;

type FixtureFile = "plugin" | "commands" | "support" | "other";

const FIXTURE: Record<FixtureFile, [string, string]> = {
  plugin: ["SlogaE2ee/E2eePlugin.swift", FX_PLUGIN],
  commands: ["SlogaE2ee/E2eeCommands.swift", FX_COMMANDS],
  support: ["SlogaE2ee/Support.swift", FX_SUPPORT],
  other: ["SlogaE2ee/NativeConfirm.swift", FX_OTHER],
};

/** A fixture swap: in `file`, replace the exact, unique `from` with `to`. */
type Swap = [FixtureFile, string, string];

function fixture(...swaps: Swap[]): Record<string, string> {
  const files = new Map(
    Object.values(FIXTURE).map(([path, src]) => [path, src] as const),
  );
  for (const [file, from, to] of swaps) {
    const path = FIXTURE[file][0];
    const src = files.get(path) ?? "";
    assert.equal(src.split(from).length, 2, `fixture swap (${file}): ${from}`);
    files.set(
      path,
      src.replace(from, () => to),
    );
  }
  return Object.fromEntries(files);
}

/** Asserts that every violation is `rule`'s, and one matches `expected`. */
function assertOnly(
  label: string,
  found: string[],
  rule: string,
  expected: RegExp,
) {
  const dump = JSON.stringify(found, null, 2);
  const rules = [...new Set(found.map((v) => v.split(" ")[0]))];
  assert.deepEqual(
    rules,
    [rule],
    `${label}: expected only ${rule}, got ${dump}`,
  );
  assert.ok(
    found.some((v) => expected.test(v)),
    `${label}: expected ${expected}, got ${dump}`,
  );
}

type Case = [label: string, swaps: Swap[], expected: RegExp];

function runCases(rule: string, cases: Case[]) {
  for (const [label, swaps, expected] of cases) {
    assertOnly(label, swiftViolations(fixture(...swaps)), rule, expected);
  }
}

const ENABLE_CALL_ARGS =
  "conversationId: input.conversationId, roster: input.roster, selfUserId: input.selfUserId, bundlesJson: input.bundles, displayNames: input.displayNames";
const ADD_CALL_ARGS =
  "conversationId: input.conversationId, userId: input.userId, selfUserId: input.selfUserId, bundlesJson: input.bundles, displayNames: input.displayNames";

test("swift scanner: a conforming fixture has no violations", () => {
  assert.deepEqual(swiftViolations(fixture()), []);
});

test("swift scanner: equivalent shapes still conform", () => {
  const variants: Swap[][] = [
    // S5: a local engine bound in the closure.
    [
      [
        "plugin",
        "let json = try E2eeRuntime.shared.engine().enableGroup( // enable-commit",
        "let engine = try E2eeRuntime.shared.engine()\n            let json = try engine.enableGroup(",
      ],
    ],
    // S8: the result resolved inline.
    [
      [
        "plugin",
        "let json = try E2eeRuntime.shared.engine().addGroupMember( // add-commit",
        "return .json(try E2eeRuntime.shared.engine().addGroupMember(",
      ],
      [
        "plugin",
        "displayNames: input.displayNames // add-names\n            )\n            return .json(json) // add-return",
        "displayNames: input.displayNames\n            ))",
      ],
    ],
    // S7: arguments read directly, through either spelling of the reader.
    [
      [
        "plugin",
        "selfUserId: input.selfUserId, // enable-self",
        'selfUserId: args.string("selfUserId"),',
      ],
      [
        "plugin",
        "selfUserId: input.selfUserId, // add-self",
        'selfUserId: try E2eeCallArgs(call).string("selfUserId"),',
      ],
    ],
    // S4: more modifiers; S1: labelled table entries; S2: clause order.
    [
      [
        "plugin",
        "@objc func enableGroup(_ call: CAPPluginCall) { // enable-def",
        "@objc public func enableGroup(_ call: CAPPluginCall) {",
      ],
      [
        "commands",
        '("e2ee_enable_group", .dedicated("enableGroup")), // table-enable',
        '(name: "e2ee_enable_group", route: .dedicated("enableGroup")),',
      ],
      [
        "plugin",
        "case .dedicated, .out: // dedicated-arm",
        "case .out, .dedicated:",
      ],
    ],
  ];
  for (const swaps of variants) {
    assert.deepEqual(swiftViolations(fixture(...swaps)), [], swaps[0][2]);
  }
});

test("swift scanner: S1 fires on its own violations", () => {
  runCases("S1", [
    [
      "a generic table entry",
      [
        [
          "commands",
          '("e2ee_enable_group", .dedicated("enableGroup")), // table-enable',
          '("e2ee_enable_group", .generic),',
        ],
      ],
      /^S1 the table has no \("e2ee_enable_group", \.dedicated\("enableGroup"\)\)/,
    ],
    [
      "an earlier generic entry shadows the dedicated one",
      [
        [
          "commands",
          '("e2ee_status", .generic), // table-status',
          '("e2ee_add_group_member", .generic),\n        ("e2ee_status", .generic),',
        ],
      ],
      /^S1 E2eeCommands\.swift spells e2ee_add_group_member 2 times/,
    ],
    [
      "the entry is commented out",
      [
        [
          "commands",
          '("e2ee_enable_group", .dedicated("enableGroup")), // table-enable',
          '// ("e2ee_enable_group", .dedicated("enableGroup")),',
        ],
      ],
      /^S1 E2eeCommands\.swift spells e2ee_enable_group 0 times/,
    ],
    [
      "routed to the other method",
      [
        [
          "commands",
          '("e2ee_enable_group", .dedicated("enableGroup")), // table-enable',
          '("e2ee_enable_group", .dedicated("addGroupMember")),',
        ],
      ],
      /^S1 the table has no \("e2ee_enable_group"/,
    ],
    [
      "the method is not registered",
      [["commands", '"addGroupMember", // methods-add', ""]],
      /^S1 dedicatedMethods lists "addGroupMember" 0 times/,
    ],
  ]);
});

test("swift scanner: S2 fires on its own violations", () => {
  runCases("S2", [
    [
      "a dedicated route runs the generic arm",
      [
        [
          "plugin",
          "case .generic: // generic-arm",
          "case .generic, .dedicated:",
        ],
        ["plugin", "case .dedicated, .out: // dedicated-arm", "case .out:"],
      ],
      /^S2 call\(_:\) does more than reject a \.dedicated route/,
    ],
    [
      "a dedicated route resolves",
      [
        [
          "plugin",
          'call.reject(E2eeReject.invalidArgument("name").json) // dedicated-reject',
          "call.resolve([:])",
        ],
      ],
      /^S2 call\(_:\) does more than reject/,
    ],
    [
      "no clause for .dedicated",
      [["plugin", "case .dedicated, .out: // dedicated-arm", "default:"]],
      /^S2 call\(_:\) has 0 clauses for \.dedicated/,
    ],
  ]);
});

test("swift scanner: S3 fires on its own violations", () => {
  runCases("S3", [
    [
      "a generic case label",
      [
        [
          "plugin",
          'case "e2ee_status": // generic-status',
          'case "e2ee_enable_group", "e2ee_status":',
        ],
      ],
      /^S3 runGeneric has a case label "e2ee_enable_group"/,
    ],
    [
      "a raw string in the plugin",
      [
        [
          "plugin",
          'case "e2ee_note": // generic-note\n            return #"engine.addGroupMember(userId: "x") \\(engine.enableGroup())"#',
          'case "e2ee_note":\n            return #"e2ee_add_group_member"#',
        ],
      ],
      /^S3 "e2ee_add_group_member" is spelled outside the command table \(SlogaE2ee\/E2eePlugin\.swift:/,
    ],
    [
      "another file",
      [
        [
          "other",
          'let label = "addGroupMember is the plugin\'s job" // other-label',
          'let label = "e2ee_enable_group"',
        ],
      ],
      /^S3 "e2ee_enable_group" is spelled outside the command table \(SlogaE2ee\/NativeConfirm\.swift:/,
    ],
  ]);
});

test("swift scanner: S4 fires on its own violations", () => {
  runCases("S4", [
    [
      "not @objc",
      [
        [
          "plugin",
          "@objc func enableGroup(_ call: CAPPluginCall) { // enable-def",
          "func enableGroup(_ call: CAPPluginCall) {",
        ],
      ],
      /^S4 func enableGroup is not an @objc instance method/,
    ],
    [
      "static",
      [
        [
          "plugin",
          "@objc func addGroupMember(_ call: CAPPluginCall) { // add-def",
          "@objc static func addGroupMember(_ call: CAPPluginCall) {",
        ],
      ],
      /^S4 func addGroupMember is not an @objc instance method/,
    ],
    [
      "no arm check",
      [
        [
          "plugin",
          "guard Self.armedOrReject(call) else { return } // enable-armed",
          "",
        ],
      ],
      /^S4 func enableGroup does not open with guard Self\.armedOrReject/,
    ],
    [
      "the arm check after the first statement",
      [
        [
          "plugin",
          "guard Self.armedOrReject(call) else { return } // add-armed\n        let args = E2eeCallArgs(call)",
          "let args = E2eeCallArgs(call)\n        guard Self.armedOrReject(call) else { return }",
        ],
      ],
      /^S4 func addGroupMember does not open with guard/,
    ],
    [
      "a second definition",
      [
        [
          "plugin",
          "    static func runGeneric(",
          "    func enableGroup(_ id: Int) {}\n\n    static func runGeneric(",
        ],
      ],
      /^S4 E2eePlugin\.swift defines func enableGroup 2 times/,
    ],
  ]);
});

test("swift scanner: S5 fires on its own violations", () => {
  runCases("S5", [
    [
      "a commit before the hand-off",
      [
        [
          "plugin",
          'Self.onDedicatedThread(call, "gg.sloga.e2ee.enable-group") { // enable-thread',
          `_ = try? E2eeRuntime.shared.engine().enableGroup(${ENABLE_CALL_ARGS})\n        Self.onDedicatedThread(call, "gg.sloga.e2ee.enable-group") {`,
        ],
      ],
      /^S5 \.enableGroup\( is called outside its Self\.onDedicatedThread closure/,
    ],
    [
      "a commit in the generic switch",
      [
        [
          "plugin",
          'case "e2ee_status": // generic-status',
          'case "e2ee_status":\n            _ = try engine.enableGroup(conversationId: "", roster: [], selfUserId: "", bundlesJson: nil, displayNames: nil)',
        ],
      ],
      /^S5 \.enableGroup\( is called outside func enableGroup/,
    ],
    [
      "a commit nested in a closure",
      [
        [
          "plugin",
          "let json = try E2eeRuntime.shared.engine().enableGroup( // enable-commit",
          "let json = try { try E2eeRuntime.shared.engine().enableGroup(",
        ],
        [
          "plugin",
          "displayNames: input.displayNames // enable-names\n            )",
          "displayNames: input.displayNames\n            ) }()",
        ],
      ],
      /^S5 \.enableGroup\( is nested in a block or closure/,
    ],
    [
      "a second commit hopped to main",
      [
        [
          "plugin",
          "dispatchPrecondition(condition: .notOnQueue(.main)) // add-precondition",
          `dispatchPrecondition(condition: .notOnQueue(.main))\n            DispatchQueue.main.async { _ = try? E2eeRuntime.shared.engine().addGroupMember(${ADD_CALL_ARGS}) }`,
        ],
      ],
      /^S5 \.addGroupMember\( is nested in a block or closure/,
    ],
    [
      "no main-thread precondition",
      [
        [
          "plugin",
          "dispatchPrecondition(condition: .notOnQueue(.main)) // enable-precondition",
          "",
        ],
      ],
      /^S5 the enableGroup dedicated closure does not open with dispatchPrecondition/,
    ],
    [
      "a commit from another file, inside an interpolation",
      [
        [
          "other",
          'let label = "addGroupMember is the plugin\'s job" // other-label',
          String.raw`let label = "\(try? E2eeRuntime.shared.engine().addGroupMember(conversationId: "", userId: "", selfUserId: "", bundlesJson: nil, displayNames: nil))"`,
        ],
      ],
      /^S5 addGroupMember is named in SlogaE2ee\/NativeConfirm\.swift/,
    ],
    [
      "the other method's commit",
      [
        [
          "plugin",
          "let json = try E2eeRuntime.shared.engine().addGroupMember( // add-commit",
          "let json = try E2eeRuntime.shared.engine().enableGroup(",
        ],
      ],
      /^S5 \.enableGroup\( is called outside func enableGroup/,
    ],
    [
      "a stored method reference",
      [
        [
          "plugin",
          'case "e2ee_status": // generic-status',
          'case "e2ee_status":\n            let commit = engine.enableGroup',
        ],
      ],
      /^S5 enableGroup is referenced without being called/,
    ],
    [
      "not the engine",
      [
        [
          "plugin",
          "let json = try E2eeRuntime.shared.engine().enableGroup( // enable-commit",
          "let json = try Self.proxy.enableGroup(",
        ],
      ],
      /^S5 \.enableGroup\( is not called on E2eeRuntime\.shared\.engine\(\)/,
    ],
    [
      "an engine the closure did not bind",
      [
        [
          "plugin",
          "let json = try E2eeRuntime.shared.engine().addGroupMember( // add-commit",
          "let json = try engine.addGroupMember(",
        ],
      ],
      /^S5 \.addGroupMember\( is called on an `engine` the dedicated closure did not bind/,
    ],
    [
      "the engine worker instead of a dedicated thread",
      [
        [
          "plugin",
          'Self.onDedicatedThread(call, "gg.sloga.e2ee.enable-group") { // enable-thread',
          "E2eeRuntime.shared.engineWorker.submit {",
        ],
      ],
      /^S5 func enableGroup has 0 Self\.onDedicatedThread\( hand-offs/,
    ],
    [
      "a hand-off that is not (call, <name>)",
      [
        [
          "plugin",
          'Self.onDedicatedThread(call, "gg.sloga.e2ee.add-group-member") { // add-thread',
          "Self.onDedicatedThread(call, name) {",
        ],
      ],
      /^S5 func addGroupMember hands off as something other than/,
    ],
  ]);
});

test("swift scanner: S6 fires on its own violations", () => {
  runCases("S6", [
    [
      "the helper submits to the engine worker",
      [
        [
          "plugin",
          "runOnDedicatedThread(name: name) { // helper-thread",
          "E2eeRuntime.shared.engineWorker.submit {",
        ],
      ],
      /^S6 onDedicatedThread does more than hand its body to runOnDedicatedThread/,
    ],
    [
      "the helper runs the body before the thread",
      [
        [
          "plugin",
          "runOnDedicatedThread(name: name) { // helper-thread",
          "_ = try? body()\n        runOnDedicatedThread(name: name) {",
        ],
      ],
      /^S6 onDedicatedThread does more than hand its body/,
    ],
    [
      "the helper's closure has no precondition",
      [
        [
          "plugin",
          "dispatchPrecondition(condition: .notOnQueue(.main)) // helper-precondition",
          "",
        ],
      ],
      /^S6 the runOnDedicatedThread closure in onDedicatedThread does not open with dispatchPrecondition/,
    ],
    [
      "runOnDedicatedThread uses a GCD queue",
      [
        [
          "support",
          "let thread = Thread { // support-thread",
          "DispatchQueue.global().async {",
        ],
      ],
      /^S6 runOnDedicatedThread involves a queue, worker, task or async/,
    ],
    [
      "runOnDedicatedThread runs the body itself",
      [
        [
          "support",
          "thread.start() // support-start",
          "thread.start()\n    body()",
        ],
      ],
      /^S6 runOnDedicatedThread runs its body outside the new Thread/,
    ],
    [
      "a second runOnDedicatedThread elsewhere",
      [
        [
          "other",
          "final class NativeConfirmPresenter {",
          "func runOnDedicatedThread(name: String, _ body: @escaping () -> Void) {\n    body()\n}\n\nfinal class NativeConfirmPresenter {",
        ],
      ],
      /^S6 runOnDedicatedThread is defined 2 times/,
    ],
  ]);
});

test("swift scanner: S7 fires on its own violations", () => {
  runCases("S7", [
    [
      "selfUserId optional",
      [
        [
          "plugin",
          'selfUserId: args.string("selfUserId"), // enable-self-read',
          'selfUserId: args.optionalString("selfUserId"),',
        ],
      ],
      /^S7 \.enableGroup\( selfUserId: input\.selfUserId is not the FE's selfUserId/,
    ],
    [
      "selfUserId hard-coded",
      [
        [
          "plugin",
          "selfUserId: input.selfUserId, // add-self",
          'selfUserId: "me",',
        ],
      ],
      /^S7 \.addGroupMember\( selfUserId: "me" is not the FE's selfUserId/,
    ],
    [
      "selfUserId read from another key",
      [
        [
          "plugin",
          'selfUserId: args.string("selfUserId"), // add-self-read',
          'selfUserId: args.string("userId"),',
        ],
      ],
      /^S7 \.addGroupMember\( selfUserId: input\.selfUserId is not/,
    ],
    [
      "an empty roster",
      [["plugin", "roster: input.roster, // enable-roster", "roster: [],"]],
      /^S7 \.enableGroup\( roster: \[\] does not come from the call's "roster" argument/,
    ],
    [
      "display names under another key",
      [
        [
          "plugin",
          'displayNames: args.optionalStringMap("displayNames") // enable-names-read',
          'displayNames: args.optionalStringMap("names")',
        ],
      ],
      /^S7 \.enableGroup\( displayNames: input\.displayNames does not come from the call's "displayNames"/,
    ],
    [
      "a default for the bundles",
      [
        [
          "plugin",
          'bundles: args.optionalArrayJSON("bundles"), // add-bundles-read',
          'bundles: args.optionalArrayJSON("bundles") ?? "[]",',
        ],
      ],
      /^S7 \.addGroupMember\( bundlesJson: input\.bundles does not come from the call's "bundles"/,
    ],
    [
      "an Android-style prompted argument",
      [
        [
          "plugin",
          "displayNames: input.displayNames // enable-names",
          "displayNames: input.displayNames,\n                prompted: true",
        ],
      ],
      /^S7 \.enableGroup\( passes \(conversationId, roster, selfUserId, bundlesJson, displayNames, prompted\)/,
    ],
  ]);
});

test("swift scanner: S8 fires on its own violations", () => {
  runCases("S8", [
    [
      "resolves {}",
      [["plugin", "return .json(json) // enable-return", "return .empty"]],
      /^S8 the enableGroup dedicated closure resolves \{\}/,
    ],
    [
      "resolves something else",
      [["plugin", "return .json(json) // add-return", 'return .json("null")']],
      /^S8 the \.addGroupMember\( result is not what the closure resolves/,
    ],
    [
      "an early return",
      [
        [
          "plugin",
          "let json = try E2eeRuntime.shared.engine().enableGroup( // enable-commit",
          'if input.roster.isEmpty { return .json("[]") }\n            let json = try E2eeRuntime.shared.engine().enableGroup(',
        ],
      ],
      /^S8 the enableGroup dedicated closure has 2 returns/,
    ],
    [
      "settle resolves another key",
      [
        [
          "plugin",
          'call.resolve(["json": json]) // settle-resolve',
          'call.resolve(["value": json])',
        ],
      ],
      /^S8 settle does not resolve \.json\(x\) as call\.resolve\(\["json": x\]\)/,
    ],
    [
      "settle rejects with a raw description",
      [
        [
          "plugin",
          "call.reject(rejectJson(for: error)) // settle-reject",
          "call.reject(error.localizedDescription)",
        ],
      ],
      /^S8 settle does not reject with call\.reject\(rejectJson\(for: error\)\)/,
    ],
  ]);
});

// ---- The real files ---------------------------------------------------------

function readSources(dir: string): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (entry.endsWith(".swift")) {
      sources[entry] = readFileSync(join(dir, entry), "utf8");
    }
  }
  return sources;
}

let realCache: string[] | null = null;

function realFound(rule: string): string[] {
  if (!realCache) {
    const sources = readSources(SWIFT_DIR);
    assert.ok(
      Object.values(sources).every((src) => src.length > 0),
      `an empty Swift file in ${SWIFT_DIR}`,
    );
    realCache = swiftViolations(sources);
  }
  return realCache.filter((v) => v.startsWith(`${rule} `));
}

const RULES: [string, string][] = [
  ["S1", "the table routes both commands to their dedicated methods"],
  ["S2", "call(_:) refuses every .dedicated route"],
  [
    "S3",
    "no other file spells either command; runGeneric has no case for them",
  ],
  [
    "S4",
    "@objc enableGroup / addGroupMember exist and check the arm flag first",
  ],
  [
    "S5",
    "the one commit of each sits in its own method's dedicated closure, after the main-thread precondition",
  ],
  ["S6", "the dedicated closure runs on a new Thread"],
  ["S7", "the engine gets the webview's own arguments; selfUserId is required"],
  ["S8", "the commit's result resolves as {json}"],
];

for (const [rule, title] of RULES) {
  test(`SlogaE2ee ${rule}: ${title} (${SWIFT_DIR})`, () => {
    assert.deepEqual(realFound(rule), []);
  });
}
