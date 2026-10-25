// Source-scan spec for the verify / accept-new-key routing on iOS: the twin
// of e2eeIdentityConfirm.scan.test.ts (Android) for the Swift plugin (IE
// plan D1, D5, §5; gate G10) — run with Node's built-in runner:
//   node --conditions=browser --test components/client/e2eeIdentityConfirm.ios.scan.test.ts
// Swift does not load under Node, so the wiring is pinned by reading the
// sources: `ios/App/SlogaE2ee/Sources/SlogaE2ee/*.swift` (E2eePlugin.swift;
// E2eeCommands.swift and Support.swift for the table and the thread helper;
// every file for the call-site rules) and the generated uniffi bindings
// `ios/App/SlogaE2ee/Bindings/acutest_e2ee_ios.swift` (argument labels only).
// Point `E2EE_IDENTITY_SWIFT_DIR` (the Sources/SlogaE2ee directory) and
// `E2EE_IDENTITY_SWIFT_BINDINGS` (the bindings file) at other copies to scan
// those instead; the known-bad copies must fail.
//
// Comments are stripped before every check, and string contents only count
// where a literal is the subject of the rule, so a commented-out call or a
// call spelled inside a string never satisfies (or trips) a rule. The Swift
// lexer handles nested block comments, `\(…)` interpolation (scanned as
// code), multi-line `"""` strings, raw `#"…"#` strings and `#/…/#` regexes.
//
// Why iOS needs fewer rules than Android: the iOS core is `ShellEngine`
// (plan D1). No commit primitive crosses the FFI: `engine.markVerified(…)`
// itself shows the native dialog and commits only the keys that dialog
// showed, so a Swift routing bug can at worst show a dialog twice, never skip
// one. What Swift must still get right is WHERE the call runs: a confirm-gated
// call on the engine worker would stall decrypt and send behind an open
// dialog, one on the main thread deadlocks (D1 a, b), and one reachable
// through the generic `call` mux escapes the dedicated-method surface the FE
// and the audit rely on (§5).
//
// Gated methods (`G`): markVerified, acceptIdentityChange (the identity
// pair), downgrade, wipe, and confirmPeerDowngrade with `accept: true`
// (plugin method confirmPeerDowngradeAccept). The FE commands are
// e2ee_mark_verified, e2ee_accept_identity_change, e2ee_downgrade, e2ee_wipe.
//   S1. E2eeCommands.swift: each of the four commands is ONE table entry,
//       `("<command>", .dedicated("<G>"))`, and the only string literal in the
//       file with that value (so neither an earlier duplicate, which `routes`
//       would keep, nor a special case in `route(for:)` can re-route it);
//       `e2ee_confirm_peer_downgrade` is one `.generic` entry; and
//       `dedicatedMethods` lists markVerified, acceptIdentityChange,
//       downgrade, wipe and confirmPeerDowngradeAccept once each.
//   S2. E2eePlugin.swift: `runGeneric`'s switch has no case label for any of
//       the four commands, and no string literal anywhere in the file names
//       one. In `@objc func call`, the `switch E2eeCommands.route(for:)` arm
//       for `.dedicated` is exactly
//       `call.reject(E2eeReject.invalidArgument("name").json)`, and the one
//       call of `runGeneric(` sits in the arm labelled `.generic` alone.
//   S3. Each of `@objc func markVerified|acceptIdentityChange|downgrade|wipe|
//       confirmPeerDowngradeAccept(_ call: CAPPluginCall)` exists once, as a
//       member of `class E2eePlugin`, and starts with
//       `guard Self.armedOrReject(call) else { return }`; it hands off with
//       exactly one `Self.onDedicatedThread(call, "<label>") { … }` whose
//       first statement is `dispatchPrecondition(condition:
//       .notOnQueue(.main))`; its engine call sits directly in that closure
//       (not in a block nested inside it); nothing outside the closure
//       touches `engine(`.
//   S4. The hand-off really is a new thread: `onDedicatedThread` calls
//       `runOnDedicatedThread(` once, with a trailing closure that starts with
//       the same `dispatchPrecondition` and settles through `settle(call)`
//       once, around `body`; Support.swift's `runOnDedicatedThread` builds a
//       `Thread`, calls `body()` only inside it and `.start()`s it. Neither
//       names the engine worker, `DispatchQueue`, `OperationQueue` or
//       `.submit`.
//   S5. Across every Sources file, each gated engine method is named only as
//       a member CALL on the engine (`E2eeRuntime.shared.engine()`, or a local
//       `engine` bound to it earlier in the same function): markVerified,
//       acceptIdentityChange, downgrade and wipe exactly once each, inside the
//       plugin method of the same name; confirmPeerDowngrade inside
//       confirmPeerDowngradeAccept (once) and the generic
//       e2ee_confirm_peer_downgrade arm (S8). A bare name (a call from an
//       engine extension) or a stored reference is a violation; a `func`
//       declaration is not. The one exception is `.wipe()` on a scrub buffer
//       (`PreparedReply`, `SecretBox`), which zeroes bytes and is not the
//       engine: a receiver typed so by the enclosing function's parameters
//       and earlier locals, or (when those declare nothing) by every
//       `let` / `var` of that name in its file.
//   S6. Each engine call's labels match the generated signature in order
//       (`markVerified(peerUserId:deviceId:selfUserId:displayName:)`,
//       `acceptIdentityChange(` the same, `downgrade(conversationId:
//       selfUserId:bundlesJson:)`, `confirmPeerDowngrade(conversationId:
//       accept:)`, `wipe()`), and the values come from the call: peerUserId,
//       deviceId, selfUserId and conversationId each from
//       `args.string("<same key>")` (required; directly, or through the
//       `guard let x = Self.validated(call, { try … })` value or tuple, with
//       `args` = `E2eeCallArgs(call)`); displayName from the
//       "displayName" key; accept the literal `true`. The bindings type
//       selfUserId as `String?`, so `nil` or an optional read would compile:
//       this rule is what keeps it required (Android parity). And
//       `E2eeCallArgs.string(` is declared `throws -> String`.
//   S7. markVerified and acceptIdentityChange resolve `{}`: every `return` in
//       their closure is `return .empty`, the closure names neither `.json`
//       nor `call`, `enum Resolution` has `case empty`, and `settle`'s
//       `.empty` arm is `call.resolve([:])` or `call.resolve()` alone (the FE
//       awaits these two and returns undefined).
//   S8. runGeneric has ONE arm for e2ee_confirm_peer_downgrade, labelled with
//       it alone. Before anything in the arm names `engine`, it refuses an
//       accepting request: `if try args.optionalBool("accept") == true`
//       (or `?? false`), or `guard … != true else`, whose body is exactly
//       `throw E2eeReject.invalidArgument("accept")`. Its one
//       `engine.confirmPeerDowngrade(` comes after that, with
//       `conversationId: args.string("conversationId")` and the literal
//       `accept: false`.
//   S9. No back door around these names, in any Sources file: no
//       `NSSelectorFromString`, `NSClassFromString`, `Selector("…")`,
//       `dlsym`, `dlopen`, `@_silgen_name`, key-value coding
//       (`.value(forKey:)`, `.setValue(_:forKey:)`), no import of the raw FFI
//       module and no `uniffi_…` / `ffi_acutest_e2ee_ios…` symbol, no
//       `extension E2eeEngine` and no subclass of it. Each would reach a
//       gated method by a name the rules above never see (string contents
//       are masked).
// A rule whose subject is missing (say, the method itself) leaves the
// report to the rule that pins that subject (S3, S5), so one defect fails
// one rule.
//
// From the Android spec's rule list (I1-I9 on E2eePlugin.kt, T1 on e2ee.ts):
//   I1 → S1 + S2. I2 → S3. I3 (commits only in the same-named method) → S3 +
//   S5; I3's reflection ban → S9.
//   Dropped, because iOS exports no commit primitive (D1) and the consent
//   machinery they pin lives in the core or in NativeConfirm.swift:
//   - I3's synthetic-tap ban: the plugin builds no dialog; the buttons are
//     NativeConfirm's UIAlertActions (no public API fires a handler; KVC is
//     banned by S9), pinned by the G9 XCTest (settle-once, decline paths).
//   - I4 (expectedIdentity from the one preview): there is no preview / commit
//     split on iOS; ShellEngine binds the commit to the keys its own dialog
//     showed (shell.rs 3207-3281).
//   - I5 (shared consent AtomicBoolean) and I7 (busy): the core's
//     `consent_in_flight` / `claim_consent` answers busy for growth and
//     identity; NativeConfirm's one-alert latch is G9's.
//   - I6 (dismiss → declined behind a resolve-once guard): NativeConfirm's
//     settle-exactly-once (G9); on the plugin side `settle` resolves or
//     rejects once (S4, S7).
//   - I8 (decline lockout, teardown dismiss): core lockouts (shell.rs
//     1523/1528); teardown is NativeConfirm's (D1 "Teardown", G9).
//   - I9 (700 ms input delay, touch filtering): NativeConfirm's UIKit code
//     (D5), G9.
//   - T1 (e2ee.ts routes both commands to the plugin methods) is platform-
//     neutral and stays pinned by the Android spec; not duplicated here.
//
// The scanner is checked against inline fixtures first (a conforming tree
// passes; each mutation fails exactly its own rule), so a green scan is never
// a scanner that cannot fail.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SWIFT_DIR =
  process.env.E2EE_IDENTITY_SWIFT_DIR ||
  fileURLToPath(
    new URL("../../ios/App/SlogaE2ee/Sources/SlogaE2ee", import.meta.url),
  );
const BINDINGS_FILE =
  process.env.E2EE_IDENTITY_SWIFT_BINDINGS ||
  fileURLToPath(
    new URL(
      "../../ios/App/SlogaE2ee/Bindings/acutest_e2ee_ios.swift",
      import.meta.url,
    ),
  );

const PLUGIN = "E2eePlugin.swift";
const COMMANDS = "E2eeCommands.swift";
const SUPPORT = "Support.swift";

/** How one engine argument must be sourced (S6); null = not pinned. */
type ArgRule = { readers: string[]; key: string } | { literal: string } | null;

const required = (key: string): ArgRule => ({ readers: ["string"], key });

interface Gated {
  /** FE command routed to the dedicated method; null for the accept leg. */
  command: string | null;
  /** The `@objc` plugin method. */
  method: string;
  /** The engine method it calls. */
  engine: string;
  /** label → source, for every label the generated signature has. */
  args: Record<string, ArgRule>;
  /** Resolves `{}` instead of `{json}` (S7). */
  empty: boolean;
}

const IDENTITY_ARGS: Record<string, ArgRule> = {
  peerUserId: required("peerUserId"),
  deviceId: required("deviceId"),
  selfUserId: required("selfUserId"),
  displayName: { readers: ["string", "optionalString"], key: "displayName" },
};

const GATED: Gated[] = [
  {
    command: "e2ee_mark_verified",
    method: "markVerified",
    engine: "markVerified",
    args: IDENTITY_ARGS,
    empty: true,
  },
  {
    command: "e2ee_accept_identity_change",
    method: "acceptIdentityChange",
    engine: "acceptIdentityChange",
    args: IDENTITY_ARGS,
    empty: true,
  },
  {
    command: "e2ee_downgrade",
    method: "downgrade",
    engine: "downgrade",
    args: {
      conversationId: required("conversationId"),
      selfUserId: required("selfUserId"),
      bundlesJson: null,
    },
    empty: false,
  },
  {
    command: "e2ee_wipe",
    method: "wipe",
    engine: "wipe",
    args: {},
    empty: false,
  },
  {
    command: null,
    method: "confirmPeerDowngradeAccept",
    engine: "confirmPeerDowngrade",
    args: {
      conversationId: required("conversationId"),
      accept: { literal: "true" },
    },
    empty: false,
  },
];

const PEER_DOWNGRADE = "e2ee_confirm_peer_downgrade";
const ENGINE_NAMES = [...new Set(GATED.map((g) => g.engine))];
const DEDICATED_COMMANDS = GATED.filter((g) => g.command !== null);

/** Types whose `.wipe()` zeroes a buffer (S5's one exception). */
const SCRUB_TYPES = ["PreparedReply", "SecretBox"];

const PRECONDITION = "dispatchPrecondition(condition:.notOnQueue(.main))";
const ARMED_GUARD = "guardSelf.armedOrReject(call)else{return}";
const DEDICATED_REJECT = 'call.reject(E2eeReject.invalidArgument("name").json)';
const ACCEPT_THROW = 'throwE2eeReject.invalidArgument("accept")';
const ACCEPT_IF = [
  'tryargs.optionalBool("accept")==true',
  '(tryargs.optionalBool("accept"))==true',
  'tryargs.optionalBool("accept")??false',
];
const ACCEPT_GUARD = [
  'tryargs.optionalBool("accept")!=true',
  '(tryargs.optionalBool("accept"))!=true',
];
const QUEUES =
  /\b(?:engineWorker|DispatchQueue|OperationQueue)\b|\.\s*submit\b/;

// ---- Shared helpers ---------------------------------------------------------

/** A string (or regex) literal: delimiters at `at` and just before `end`. */
interface Literal {
  at: number;
  end: number;
  /** The raw contents between the delimiters, interpolations included. */
  value: string;
}

interface Masked {
  /** Comments and literal contents blanked (delimiters kept). */
  code: string;
  /** Comments blanked; literal contents kept. */
  text: string;
  literals: Literal[];
}

/** Half-open [from, to) index range. */
type Span = [number, number];

/** A `{ … }` pair: indices of the braces themselves. */
interface Block {
  open: number;
  close: number;
}

const squash = (s: string) => s.replace(/\s+/g, "");

function lineOf(src: string, at: number): number {
  let line = 1;
  for (let i = 0; i < at && i < src.length; i++) if (src[i] === "\n") line++;
  return line;
}

function skipWs(code: string, i: number): number {
  while (i < code.length && /\s/.test(code[i])) i++;
  return i;
}

/** Every match of `re` starting in [from, to). */
function allMatches(
  re: RegExp,
  s: string,
  from = 0,
  to = s.length,
): RegExpExecArray[] {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const g = new RegExp(re.source, flags);
  g.lastIndex = from;
  const out: RegExpExecArray[] = [];
  for (let m = g.exec(s); m && m.index < to; m = g.exec(s)) {
    out.push(m);
    if (m[0] === "") g.lastIndex++;
  }
  return out;
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

/** Index of the bracket opening the one at `close` (masked code), or throw. */
function matchOpen(code: string, close: number): number {
  const pairs: Record<string, string> = { ")": "(", "}": "{", "]": "[" };
  const open = pairs[code[close]];
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (code[i] === code[close]) depth++;
    else if (code[i] === open && --depth === 0) return i;
  }
  throw new Error(`unbalanced ${code[close]} at ${close}`);
}

/** Spans of the top-level arguments of the call whose `(` is at `open`. */
function argSpans(code: string, open: number): Span[] {
  const close = matchClose(code, open);
  const out: Span[] = [];
  let start = open + 1;
  for (let i = open + 1; i < close; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") i = matchClose(code, i);
    else if (c === ",") {
      out.push([start, i]);
      start = i + 1;
    }
  }
  out.push([start, close]);
  return out.filter(([from, to]) => code.slice(from, to).trim() !== "");
}

/** One argument (or tuple element), squashed, with a leading `try` dropped. */
interface Arg {
  label: string;
  code: string;
  text: string;
  /** Index where the value starts. */
  at: number;
}

const LABEL = /^\s*(\w+)\s*:(?!:)\s*/;
const TRY = /^\s*try[?!]?\s+/;

function labeledArgs(m: Masked, open: number): Arg[] {
  return argSpans(m.code, open).map(([from, to]) => {
    let at = from;
    const label = LABEL.exec(m.code.slice(at, to));
    if (label) at += label[0].length;
    const tried = TRY.exec(m.code.slice(at, to));
    if (tried) at += tried[0].length;
    return {
      label: label ? label[1] : "",
      code: squash(m.code.slice(at, to)),
      text: squash(m.text.slice(at, to)),
      at,
    };
  });
}

/** The whitespace-separated word ending just before `i` (skipping spaces). */
function prevWord(code: string, i: number): string {
  let j = i - 1;
  while (j >= 0 && /\s/.test(code[j])) j--;
  let k = j;
  while (k >= 0 && /\w/.test(code[k])) k--;
  return code.slice(k + 1, j + 1);
}

function prevChar(code: string, i: number): string {
  let j = i - 1;
  while (j >= 0 && /\s/.test(code[j])) j--;
  return j >= 0 ? code[j] : "";
}

// ---- Swift lexer ------------------------------------------------------------

/**
 * Blanks Swift comments (block comments nest) and literal contents with
 * spaces (newlines kept), so every index is the same index in `src`.
 * `\(…)` interpolations (`\#(…)` in raw strings) are scanned as code.
 */
function maskSwift(src: string): Masked {
  const code = src.split("");
  const text = src.split("");
  const literals: Literal[] = [];
  const n = src.length;
  const blank = (arr: string[], i: number) => {
    if (arr[i] !== "\n") arr[i] = " ";
  };
  const blankBoth = (i: number) => {
    blank(code, i);
    blank(text, i);
  };
  const hashesAt = (i: number) => {
    let h = 0;
    while (src[i + h] === "#") h++;
    return h;
  };

  /** A string opening at `i` (its first `#` or `"`); returns its end. */
  const scanString = (i: number, hashes: number): number => {
    const pounds = "#".repeat(hashes);
    const multi = src.startsWith('"""', i + hashes);
    const close = (multi ? '"""' : '"') + pounds;
    const start = i + hashes + (multi ? 3 : 1);
    let j = start;
    while (j < n) {
      if (src.startsWith(close, j)) {
        literals.push({
          at: i,
          end: j + close.length,
          value: src.slice(start, j),
        });
        return j + close.length;
      }
      if (!multi && src[j] === "\n") break;
      if (src[j] === "\\" && src.startsWith(pounds, j + 1)) {
        const k = j + 1 + hashes;
        if (src[k] === "(") {
          for (let x = j; x < k; x++) blank(code, x);
          j = scanCode(k + 1, true) + 1;
          continue;
        }
        for (let x = j; x <= k && x < n; x++) blank(code, x);
        j = k + 1;
        continue;
      }
      blank(code, j++);
    }
    literals.push({ at: i, end: j, value: src.slice(start, j) });
    return j;
  };

  /** A `#/…/#` regex literal opening at `i`; returns its end. */
  const scanRegex = (i: number, hashes: number): number => {
    const close = `/${"#".repeat(hashes)}`;
    const start = i + hashes + 1;
    let j = start;
    while (j < n && !src.startsWith(close, j)) blank(code, j++);
    literals.push({ at: i, end: j + close.length, value: src.slice(start, j) });
    return j + close.length;
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
        i = scanString(i, 0);
        continue;
      }
      if (c === "#") {
        const h = hashesAt(i);
        if (src[i + h] === '"') {
          i = scanString(i, h);
          continue;
        }
        if (src[i + h] === "/") {
          i = scanRegex(i, h);
          continue;
        }
        i += h;
        continue;
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
  return { code: code.join(""), text: text.join(""), literals };
}

// ---- Swift structure --------------------------------------------------------

interface Fn {
  name: string;
  /** Index of the `func` keyword. */
  at: number;
  paramsOpen: number;
  paramsClose: number;
  /** Raw code between the previous `{`, `}` or `;` and `func`. */
  attrs: string;
  /** The body's braces; -1 when there is no body. */
  open: number;
  close: number;
}

interface SwiftFile {
  name: string;
  src: string;
  m: Masked;
  fns: Fn[];
  blocks: Block[];
}

const FUNC_DEF = /\bfunc\s+(\w+)\s*(?:<[^>{}]*>)?\s*\(/g;
const DECL_START =
  /^\s*(?:@|func\b|var\b|let\b|init\b|case\b|static\b|private\b|fileprivate\b|public\b|internal\b|open\b|subscript\b|deinit\b|typealias\b)/;

function swiftFunctions(code: string): Fn[] {
  const out: Fn[] = [];
  for (const def of allMatches(FUNC_DEF, code)) {
    const at = def.index;
    const paramsOpen = at + def[0].length - 1;
    const paramsClose = matchClose(code, paramsOpen);
    let open = -1;
    for (let j = paramsClose + 1; j < code.length; j++) {
      const c = code[j];
      if (c === "(" || c === "[") j = matchClose(code, j);
      else if (c === "{") {
        open = j;
        break;
      } else if (c === "}" || c === ";") break;
      else if (c === "\n" && DECL_START.test(code.slice(j + 1, j + 40))) break;
    }
    let b = at - 1;
    while (b >= 0 && !"{};".includes(code[b])) b--;
    out.push({
      name: def[1],
      at,
      paramsOpen,
      paramsClose,
      attrs: code.slice(b + 1, at),
      open,
      close: open >= 0 ? matchClose(code, open) : -1,
    });
  }
  return out;
}

function swiftBlocks(code: string): Block[] {
  const out: Block[] = [];
  const stack: number[] = [];
  for (let i = 0; i < code.length; i++) {
    if (code[i] === "{") stack.push(i);
    else if (code[i] === "}") {
      const open = stack.pop();
      if (open !== undefined) out.push({ open, close: i });
    }
  }
  return out;
}

/** The innermost block strictly containing index `i`. */
function innermost(blocks: Block[], i: number): Block | null {
  let best: Block | null = null;
  for (const b of blocks) {
    if (b.open < i && i < b.close && (!best || b.open > best.open)) best = b;
  }
  return best;
}

/** The innermost function whose body contains `i`. */
function enclosingFn(f: SwiftFile, i: number): Fn | null {
  let best: Fn | null = null;
  for (const fn of f.fns) {
    if (fn.open < i && i < fn.close && (!best || fn.open > best.open)) {
      best = fn;
    }
  }
  return best;
}

function load(name: string, src: string): SwiftFile {
  const m = maskSwift(src);
  return {
    name,
    src,
    m,
    fns: swiftFunctions(m.code),
    blocks: swiftBlocks(m.code),
  };
}

const where = (f: SwiftFile, i: number) => `${f.name}:${lineOf(f.src, i)}`;

/** The body block of `class|struct|enum <name>`. */
function typeBody(f: SwiftFile, kind: string, name: string): Block | null {
  const re = new RegExp(String.raw`\b${kind}\s+${name}\b[^{]*\{`);
  const decl = re.exec(f.m.code);
  if (!decl) return null;
  const open = decl.index + decl[0].length - 1;
  return { open, close: matchClose(f.m.code, open) };
}

/** Every function named `name`, with or without a body. */
const fnsNamed = (f: SwiftFile, name: string) =>
  f.fns.filter((fn) => fn.name === name);

const isObjc = (fn: Fn) =>
  /@objc(?:\(\w*\))?(?:\s+(?:public|internal|open|final|override|dynamic))*\s*$/.test(
    fn.attrs,
  );

/** The trailing closure after the call whose `(` is at `paren`, if any. */
function trailingClosure(code: string, paren: number): Block | null {
  const j = skipWs(code, matchClose(code, paren) + 1);
  return code[j] === "{" ? { open: j, close: matchClose(code, j) } : null;
}

const startsWithStmt = (code: string, block: Block, stmt: string) =>
  squash(code.slice(block.open + 1, block.close)).startsWith(stmt);

interface Arm {
  /** The label's patterns, squashed code, split on top-level commas. */
  labels: string[];
  /** Literal values in the label. */
  values: string[];
  at: number;
  body: Span;
}

/** The `case …:` / `default:` arms of the switch whose `{` is at `open`. */
function switchArms(m: Masked, open: number): Arm[] {
  const { code } = m;
  const close = matchClose(code, open);
  const heads: { at: number; kwEnd: number; colon: number }[] = [];
  for (let i = open + 1; i < close; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") {
      i = matchClose(code, i);
      continue;
    }
    const kw = /^(?:case|default)\b/.exec(code.slice(i, i + 8));
    if (
      !kw ||
      (i > 0 && /[\w.]/.test(code[i - 1])) ||
      ["if", "guard", "while", "for", "let", "var"].includes(
        prevWord(code, i),
      ) ||
      prevChar(code, i) === ","
    ) {
      continue;
    }
    let j = i + kw[0].length;
    while (j < close && code[j] !== ":") {
      if ("([{".includes(code[j])) j = matchClose(code, j);
      j++;
    }
    heads.push({ at: i, kwEnd: i + kw[0].length, colon: j });
    i = j;
  }
  return heads.map((h, k) => {
    const label = code.slice(h.kwEnd, h.colon);
    const labels =
      code.slice(h.at, h.kwEnd) === "default"
        ? ["default"]
        : label.split(",").map(squash);
    return {
      labels,
      values: m.literals
        .filter((l) => l.at >= h.kwEnd && l.at < h.colon)
        .map((l) => l.value),
      at: h.at,
      body: [h.colon + 1, k + 1 < heads.length ? heads[k + 1].at : close],
    };
  });
}

/** The first `switch … {` in [from, to): the arms, or null. */
function firstSwitch(m: Masked, from: number, to: number): Arm[] | null {
  const sw = allMatches(/\bswitch\b[^{]*\{/, m.code, from, to)[0];
  if (!sw) return null;
  return switchArms(m, sw.index + sw[0].length - 1);
}

/** Member accesses `.name` (masked code). */
interface Site {
  /** Index of the name. */
  at: number;
  dot: number;
  receiver: string;
  /** The `(` of the call, or -1 for a reference. */
  paren: number;
}

function receiverBefore(code: string, dot: number): string {
  let j = dot - 1;
  let start = dot;
  while (j >= 0) {
    let k = j;
    while (k >= 0 && /\s/.test(code[k])) k--;
    while (k >= 0 && /[?!]/.test(code[k])) k--;
    while (k >= 0 && (code[k] === ")" || code[k] === "]")) {
      k = matchOpen(code, k) - 1;
    }
    if (k < 0 || !/\w/.test(code[k])) {
      start = k + 1;
      break;
    }
    while (k >= 0 && /\w/.test(code[k])) k--;
    start = k + 1;
    let p = k;
    while (p >= 0 && /\s/.test(code[p])) p--;
    if (p < 0 || code[p] !== ".") break;
    j = p - 1;
  }
  return squash(code.slice(start, dot));
}

function memberSites(code: string, name: string, from = 0, to = code.length) {
  const out: Site[] = [];
  for (const m of allMatches(
    new RegExp(String.raw`\.\s*${name}\b`),
    code,
    from,
    to,
  )) {
    const at = m.index + m[0].length - name.length;
    const next = skipWs(code, m.index + m[0].length);
    out.push({
      at,
      dot: m.index,
      receiver: receiverBefore(code, m.index),
      paren: code[next] === "(" ? next : -1,
    });
  }
  return out;
}

const within = (i: number, b: Block) => b.open < i && i < b.close;

/** `engine` here is the engine: the singleton, or a local bound to it. */
function engineReceiver(f: SwiftFile, fn: Fn, site: Site): boolean {
  if (site.receiver === "E2eeRuntime.shared.engine()") return true;
  if (site.receiver !== "engine") return false;
  return (
    allMatches(
      /\blet\s+engine\s*=\s*try\s+E2eeRuntime\s*\.\s*shared\s*\.\s*engine\s*\(\s*\)/,
      f.m.code,
      fn.open,
      site.at,
    ).length > 0
  );
}

/**
 * Whether `site`'s receiver is declared only as a scrub buffer: by the
 * enclosing function's parameters and the locals before the site, or, when
 * those declare nothing, by every `let` / `var` of that name in the file. A
 * local built by any other call (`let x = make(…)`) is not a scrub buffer.
 */
function scrubBuffer(f: SwiftFile, site: Site): boolean {
  const name = site.receiver.replace(/[?!]+$/, "");
  if (!/^\w+$/.test(name)) return false;
  const { code } = f.m;
  const param = new RegExp(String.raw`\b${name}\s*:\s*(\w+)`);
  const decl = new RegExp(
    String.raw`\b(?:let|var)\s+${name}\s*(?::\s*(\w+)|=\s*(\w+)\s*\()`,
  );
  const typesOf = (ms: RegExpExecArray[]) => ms.map((m) => m[1] ?? m[2] ?? "");
  const fn = enclosingFn(f, site.at);
  let types = fn
    ? [
        ...typesOf(allMatches(param, code, fn.paramsOpen, fn.paramsClose)),
        ...typesOf(allMatches(decl, code, fn.open, site.at)),
      ]
    : [];
  if (types.length === 0) types = typesOf(allMatches(decl, code));
  return types.length > 0 && types.every((t) => SCRUB_TYPES.includes(t));
}

/** One `Self.onDedicatedThread(…)` hand-off inside a method. */
interface Handoff {
  at: number;
  args: { code: string; text: string }[];
  closure: Block | null;
}

function handoffs(f: SwiftFile, body: Block): Handoff[] {
  const { code, text } = f.m;
  return allMatches(
    /\b(?:Self|E2eePlugin)\s*\.\s*onDedicatedThread\s*\(/,
    code,
    body.open,
    body.close,
  ).map((h) => {
    const paren = h.index + h[0].length - 1;
    return {
      at: h.index,
      args: argSpans(code, paren).map(([a, b]) => ({
        code: squash(code.slice(a, b)),
        text: squash(text.slice(a, b)),
      })),
      closure: trailingClosure(code, paren),
    };
  });
}

/** The one `@objc func <method>` with a body, or null. */
function pluginMethod(f: SwiftFile, method: string): Fn | null {
  const fns = fnsNamed(f, method);
  return fns.length === 1 && fns[0].open >= 0 ? fns[0] : null;
}

/** The engine call sites for `g` inside its plugin method. */
function methodSites(f: SwiftFile, g: Gated): Site[] {
  const fn = pluginMethod(f, g.method);
  return fn ? memberSites(f.m.code, g.engine, fn.open, fn.close) : [];
}

/** runGeneric's arms, or null. */
function genericArms(f: SwiftFile): Arm[] | null {
  const fns = fnsNamed(f, "runGeneric");
  if (fns.length !== 1 || fns[0].open < 0) return null;
  return firstSwitch(f.m, fns[0].open, fns[0].close);
}

/** The arms of `@objc func call`'s `switch E2eeCommands.route(for:)`. */
function muxArms(f: SwiftFile): Arm[] | null {
  const fn = pluginMethod(f, "call");
  if (!fn) return null;
  const sw = allMatches(
    /\bswitch\s+E2eeCommands\s*\.\s*route\s*\(/,
    f.m.code,
    fn.open,
    fn.close,
  )[0];
  if (!sw) return null;
  const brace = skipWs(
    f.m.code,
    matchClose(f.m.code, sw.index + sw[0].length - 1) + 1,
  );
  return f.m.code[brace] === "{" ? switchArms(f.m, brace) : null;
}

// ---- Argument sources (S6, S8) ----------------------------------------------

const READER = /^(?:args|E2eeCallArgs\(call\))\.(\w+)\("([^"]*)"\)$/;

/** `<reader>("<key>")` for a direct read, a literal as itself, else null. */
function readOf(f: SwiftFile, fn: Fn, v: { code: string; text: string }) {
  if (/^(?:true|false)$/.test(v.code)) return v.code;
  const r = READER.exec(v.text);
  if (!r) return null;
  if (v.text.startsWith("args.")) {
    const bound =
      allMatches(
        /\blet\s+args\s*=\s*E2eeCallArgs\s*\(\s*call\s*\)/,
        f.m.code,
        fn.open,
        fn.close,
      ).length === 1 ||
      /\bargs\s*:\s*E2eeCallArgs\b/.test(
        f.m.code.slice(fn.paramsOpen, fn.paramsClose),
      );
    if (!bound) return null;
  }
  return `${r[1]}("${r[2]}")`;
}

/** Where a value (`x`, or `x.field`) bound by `Self.validated` comes from. */
function resolveArg(
  f: SwiftFile,
  fn: Fn,
  v: { code: string; text: string },
): string | null {
  const direct = readOf(f, fn, v);
  if (direct) return direct;
  const ref = /^(\w+)(?:\.(\w+))?$/.exec(v.code);
  if (!ref) return null;
  const { code } = f.m;
  const binds = allMatches(
    new RegExp(
      String.raw`\bguard\s+let\s+${ref[1]}\s*=\s*Self\s*\.\s*validated\s*\(`,
    ),
    code,
    fn.open,
    fn.close,
  );
  if (binds.length !== 1) return null;
  const paren = binds[0].index + binds[0][0].length - 1;
  const spans = argSpans(code, paren);
  let closure: Block | null = null;
  if (spans.length === 2) {
    const brace = skipWs(code, spans[1][0]);
    if (code[brace] === "{")
      closure = { open: brace, close: matchClose(code, brace) };
  } else if (spans.length === 1) {
    closure = trailingClosure(code, paren);
  }
  if (!closure) return null;
  let at = closure.open + 1;
  const tried = TRY.exec(code.slice(at, closure.close));
  if (tried) at += tried[0].length;
  at = skipWs(code, at);
  if (ref[2] === undefined) {
    return readOf(f, fn, {
      code: squash(code.slice(at, closure.close)),
      text: squash(f.m.text.slice(at, closure.close)),
    });
  }
  if (
    code[at] !== "(" ||
    skipWs(code, matchClose(code, at) + 1) !== closure.close
  ) {
    return null;
  }
  const element = labeledArgs(f.m, at).filter((e) => e.label === ref[2]);
  return element.length === 1 ? readOf(f, fn, element[0]) : null;
}

function ruleMet(rule: ArgRule, got: string | null): boolean {
  if (rule === null) return true;
  if (got === null) return false;
  if ("literal" in rule) return got === rule.literal;
  const r = /^(\w+)\("([^"]*)"\)$/.exec(got);
  return !!r && rule.readers.includes(r[1]) && r[2] === rule.key;
}

const expected = (rule: ArgRule) =>
  rule === null
    ? "anything"
    : "literal" in rule
      ? rule.literal
      : rule.readers.map((r) => `args.${r}("${rule.key}")`).join(" or ");

/** Labels of `open func <name>(` in the generated bindings, or null. */
function bindingLabels(bindings: SwiftFile, name: string): string[] | null {
  const defs = allMatches(
    new RegExp(String.raw`\bopen\s+func\s+${name}\s*\(`),
    bindings.m.code,
  );
  if (defs.length !== 1) return null;
  const paren = defs[0].index + defs[0][0].length - 1;
  return argSpans(bindings.m.code, paren).map(
    ([a, b]) => /^\s*(\w+)/.exec(bindings.m.code.slice(a, b))?.[1] ?? "",
  );
}

// ---- The rules --------------------------------------------------------------

interface Tree {
  /** Every Sources file, E2eePlugin / E2eeCommands / Support included. */
  sources: SwiftFile[];
  bindings: SwiftFile;
}

const fileOf = (tree: Tree, name: string) =>
  tree.sources.find((f) => f.name === name) ?? null;

const tokenIn = (value: string, token: string) =>
  new RegExp(String.raw`(?<![A-Za-z0-9_])${token}(?![A-Za-z0-9_])`).test(value);

function s1(tree: Tree): string[] {
  const out: string[] = [];
  const f = fileOf(tree, COMMANDS);
  if (!f) return [`S1 ${COMMANDS} is missing`];
  const { code, text } = f.m;
  const decl = /\bstatic\s+let\s+table\b[^=]*=\s*\[/.exec(code);
  if (!decl) return [`S1 ${COMMANDS} has no \`static let table = [\``];
  const open = decl.index + decl[0].length - 1;
  const close = matchClose(code, open);
  const entries: { name: string; route: string; at: number }[] = [];
  for (let i = open + 1; i < close; i++) {
    if (code[i] === "[" || code[i] === "{") i = matchClose(code, i);
    else if (code[i] === "(") {
      const parts = argSpans(code, i).map(([a, b]) => squash(text.slice(a, b)));
      const name = /^"([^"]*)"$/.exec(parts[0] ?? "");
      if (parts.length === 2 && name) {
        entries.push({ name: name[1], route: parts[1], at: i });
      }
      i = matchClose(code, i);
    }
  }
  const expect: [string, string][] = [
    ...DEDICATED_COMMANDS.map((g): [string, string] => [
      g.command ?? "",
      `.dedicated("${g.method}")`,
    ]),
    [PEER_DOWNGRADE, ".generic"],
  ];
  for (const [command, route] of expect) {
    const found = entries.filter((e) => e.name === command);
    if (found.length !== 1) {
      out.push(
        `S1 table has ${found.length} entries for ${command}; expected one`,
      );
    }
    for (const e of found) {
      if (e.route !== route) {
        out.push(
          `S1 ${where(f, e.at)} routes ${command} to ${e.route}; expected ${route}`,
        );
      }
    }
    const literals = f.m.literals.filter((l) => l.value === command);
    if (literals.length !== 1) {
      out.push(
        `S1 ${COMMANDS} spells ${command} in ${literals.length} string literals; expected only its table entry`,
      );
    }
  }
  const methodsDecl = /\bstatic\s+let\s+dedicatedMethods\b[^=]*=\s*\[/.exec(
    code,
  );
  if (!methodsDecl) {
    out.push(`S1 ${COMMANDS} has no \`static let dedicatedMethods = [\``);
  } else {
    const mOpen = methodsDecl.index + methodsDecl[0].length - 1;
    const mClose = matchClose(code, mOpen);
    const names = f.m.literals
      .filter((l) => l.at > mOpen && l.at < mClose)
      .map((l) => l.value);
    for (const g of GATED) {
      const n = names.filter((x) => x === g.method).length;
      if (n !== 1) {
        out.push(
          `S1 dedicatedMethods lists ${g.method} ${n} times; expected once`,
        );
      }
    }
  }
  return out;
}

function s2(tree: Tree): string[] {
  const out: string[] = [];
  const f = fileOf(tree, PLUGIN);
  if (!f) return [`S2 ${PLUGIN} is missing`];
  const arms = genericArms(f);
  if (!arms) out.push("S2 runGeneric or its switch is missing");
  for (const arm of arms ?? []) {
    for (const g of DEDICATED_COMMANDS) {
      if (arm.values.includes(g.command ?? "")) {
        out.push(
          `S2 ${where(f, arm.at)} runGeneric has a case for ${g.command}`,
        );
      }
    }
  }
  for (const l of f.m.literals) {
    for (const g of DEDICATED_COMMANDS) {
      if (tokenIn(l.value, g.command ?? "")) {
        out.push(`S2 ${where(f, l.at)} a string literal names ${g.command}`);
      }
    }
  }
  const mux = muxArms(f);
  if (!mux)
    return [...out, "S2 call() has no `switch E2eeCommands.route(for:)`"];
  const dedicated = mux.filter((a) =>
    a.labels.some((l) => l.startsWith(".dedicated")),
  );
  if (dedicated.length !== 1) {
    out.push(
      `S2 call() has ${dedicated.length} arms for .dedicated; expected one`,
    );
  }
  for (const arm of dedicated) {
    const body = squash(f.m.text.slice(arm.body[0], arm.body[1]));
    if (body !== DEDICATED_REJECT) {
      out.push(
        `S2 ${where(f, arm.at)} the .dedicated arm must be exactly ${DEDICATED_REJECT}`,
      );
    }
  }
  const generic = mux.filter(
    (a) => a.labels.length === 1 && a.labels[0] === ".generic",
  );
  const runs = allMatches(/\brunGeneric\s*\(/, f.m.code).filter(
    (r) => prevWord(f.m.code, r.index) !== "func",
  );
  if (runs.length !== 1) {
    out.push(
      `S2 ${PLUGIN} calls runGeneric( ${runs.length} times; expected once`,
    );
  }
  for (const r of runs) {
    if (!generic.some((a) => r.index >= a.body[0] && r.index < a.body[1])) {
      out.push(
        `S2 ${where(f, r.index)} runGeneric( outside the arm labelled .generic alone`,
      );
    }
  }
  return out;
}

function s3(tree: Tree): string[] {
  const out: string[] = [];
  const f = fileOf(tree, PLUGIN);
  if (!f) return [`S3 ${PLUGIN} is missing`];
  const cls = typeBody(f, "class", "E2eePlugin");
  for (const g of GATED) {
    const fns = fnsNamed(f, g.method);
    const fn = pluginMethod(f, g.method);
    if (!fn) {
      out.push(
        `S3 ${g.method}: ${fns.length} definitions with a body; expected one`,
      );
      continue;
    }
    const body: Block = { open: fn.open, close: fn.close };
    const head = `S3 ${g.method} (${where(f, fn.at)})`;
    if (!isObjc(fn)) out.push(`${head} is not @objc`);
    if (!cls || innermost(f.blocks, fn.at)?.open !== cls.open) {
      out.push(`${head} is not a member of class E2eePlugin`);
    }
    if (
      squash(f.m.code.slice(fn.paramsOpen + 1, fn.paramsClose)) !==
      "_call:CAPPluginCall"
    ) {
      out.push(`${head} does not take (_ call: CAPPluginCall)`);
    }
    if (!startsWithStmt(f.m.code, body, ARMED_GUARD)) {
      out.push(
        `${head} does not start with guard Self.armedOrReject(call) else { return }`,
      );
    }
    const hs = handoffs(f, body);
    if (hs.length !== 1) {
      out.push(
        `${head} hands off to Self.onDedicatedThread ${hs.length} times; expected once`,
      );
      continue;
    }
    const h = hs[0];
    if (
      h.args.length !== 2 ||
      h.args[0].code !== "call" ||
      !/^"[^"\\]+"$/.test(h.args[1].text)
    ) {
      out.push(`${head} must call Self.onDedicatedThread(call, "<label>")`);
    }
    if (!h.closure) {
      out.push(`${head} Self.onDedicatedThread has no trailing closure`);
      continue;
    }
    const closure = h.closure;
    if (!startsWithStmt(f.m.code, closure, PRECONDITION)) {
      out.push(
        `${head} the dedicated-thread closure does not start with ${PRECONDITION}`,
      );
    }
    for (const site of memberSites(f.m.code, g.engine, fn.open, fn.close)) {
      if (innermost(f.blocks, site.at)?.open !== closure.open) {
        out.push(
          `S3 ${g.method} (${where(f, site.at)}) the ${g.engine} call is not directly in the dedicated-thread closure`,
        );
      }
    }
    for (const e of allMatches(/\bengine\s*\(/, f.m.code, fn.open, fn.close)) {
      if (!within(e.index, closure)) {
        out.push(
          `S3 ${g.method} (${where(f, e.index)}) touches engine( outside the closure`,
        );
      }
    }
  }
  return out;
}

function s4(tree: Tree): string[] {
  const out: string[] = [];
  const f = fileOf(tree, PLUGIN);
  const support = fileOf(tree, SUPPORT);
  if (!f || !support) return [`S4 ${PLUGIN} or ${SUPPORT} is missing`];
  const helpers = fnsNamed(f, "onDedicatedThread");
  if (helpers.length !== 1 || helpers[0].open < 0) {
    out.push(
      `S4 ${helpers.length} onDedicatedThread definitions; expected one`,
    );
  } else {
    const fn = helpers[0];
    const head = `S4 onDedicatedThread (${where(f, fn.at)})`;
    if (!/\bstatic\b/.test(fn.attrs)) out.push(`${head} is not static`);
    if (QUEUES.test(f.m.code.slice(fn.open, fn.close))) {
      out.push(`${head} names a queue or the engine worker`);
    }
    const runs = allMatches(
      /\brunOnDedicatedThread\s*\(/,
      f.m.code,
      fn.open,
      fn.close,
    );
    const run = runs.length === 1 ? runs[0] : null;
    const closure = run
      ? trailingClosure(f.m.code, run.index + run[0].length - 1)
      : null;
    if (!closure) {
      out.push(
        `${head} must call runOnDedicatedThread( once, with a trailing closure`,
      );
    } else {
      if (!startsWithStmt(f.m.code, closure, PRECONDITION)) {
        out.push(
          `${head} the thread closure does not start with ${PRECONDITION}`,
        );
      }
      const settles = allMatches(
        /\bsettle\s*\(\s*call\s*\)/,
        f.m.code,
        closure.open,
        closure.close,
      );
      const settled =
        settles.length === 1
          ? trailingClosure(f.m.code, f.m.code.indexOf("(", settles[0].index))
          : null;
      if (
        !settled ||
        !/\bbody\b/.test(f.m.code.slice(settled.open, settled.close))
      ) {
        out.push(
          `${head} the thread closure must settle(call) { … body … } once`,
        );
      }
    }
  }
  const runners = fnsNamed(support, "runOnDedicatedThread");
  if (runners.length !== 1 || runners[0].open < 0) {
    out.push(
      `S4 ${runners.length} runOnDedicatedThread definitions in ${SUPPORT}; expected one`,
    );
    return out;
  }
  const fn = runners[0];
  const head = `S4 runOnDedicatedThread (${where(support, fn.at)})`;
  const { code } = support.m;
  if (QUEUES.test(code.slice(fn.open, fn.close))) {
    out.push(`${head} names a queue or the engine worker`);
  }
  const threads = allMatches(
    /\bThread\s*(?:\(\s*block\s*:\s*)?\{/,
    code,
    fn.open,
    fn.close,
  );
  if (threads.length !== 1) {
    out.push(`${head} builds ${threads.length} Thread { … }; expected one`);
    return out;
  }
  const brace = threads[0].index + threads[0][0].length - 1;
  const thread: Block = { open: brace, close: matchClose(code, brace) };
  const calls = allMatches(/\bbody\s*\(\s*\)/, code, fn.open, fn.close);
  if (calls.length === 0 || calls.some((c) => !within(c.index, thread))) {
    out.push(`${head} must call body() only inside the Thread`);
  }
  if (
    allMatches(/\.\s*start\s*\(\s*\)/, code, thread.close, fn.close).length !==
    1
  ) {
    out.push(`${head} must .start() the thread once`);
  }
  return out;
}

function s5(tree: Tree): string[] {
  const out: string[] = [];
  const plugin = fileOf(tree, PLUGIN);
  if (!plugin) return [`S5 ${PLUGIN} is missing`];
  const peerArm = (genericArms(plugin) ?? []).filter((a) =>
    a.values.includes(PEER_DOWNGRADE),
  );
  const counts = new Map<string, number>();
  for (const f of tree.sources) {
    const { code } = f.m;
    for (const name of ENGINE_NAMES) {
      for (const occ of allMatches(new RegExp(String.raw`\b${name}\b`), code)) {
        const i = occ.index;
        if (prevChar(code, i) !== ".") {
          if (prevWord(code, i) !== "func") {
            out.push(`S5 ${where(f, i)} names ${name} outside a member call`);
          }
          continue;
        }
        let dot = i - 1;
        while (code[dot] !== ".") dot--;
        const site: Site = {
          at: i,
          dot,
          receiver: receiverBefore(code, dot),
          paren:
            code[skipWs(code, i + name.length)] === "("
              ? skipWs(code, i + name.length)
              : -1,
        };
        const label = `${site.receiver}.${name}`;
        if (f !== plugin) {
          if (name === "wipe" && site.paren >= 0 && scrubBuffer(f, site))
            continue;
          out.push(`S5 ${where(f, i)} ${label} outside ${PLUGIN}`);
          continue;
        }
        const fn = enclosingFn(f, i);
        const owner = GATED.find(
          (g) => g.engine === name && fn?.name === g.method,
        );
        const inPeer =
          name === "confirmPeerDowngrade" &&
          fn?.name === "runGeneric" &&
          peerArm.some((a) => i >= a.body[0] && i < a.body[1]);
        if (!fn || (!owner && !inPeer)) {
          out.push(
            `S5 ${where(f, i)} ${label} sits in ${fn?.name ?? "no function"}, not its dedicated method`,
          );
        } else if (site.paren < 0) {
          out.push(`S5 ${where(f, i)} ${label} is a reference, not a call`);
        } else if (!engineReceiver(f, fn, site)) {
          out.push(
            `S5 ${where(f, i)} ${label}: the receiver is not the engine`,
          );
        } else if (owner) {
          counts.set(owner.method, (counts.get(owner.method) ?? 0) + 1);
        }
      }
    }
  }
  for (const g of GATED) {
    const n = counts.get(g.method) ?? 0;
    if (n !== 1)
      out.push(
        `S5 ${g.method} makes ${n} engine ${g.engine} calls; expected one`,
      );
  }
  return out;
}

function s6(tree: Tree): string[] {
  const out: string[] = [];
  const f = fileOf(tree, PLUGIN);
  if (!f) return [`S6 ${PLUGIN} is missing`];
  for (const g of GATED) {
    const fn = pluginMethod(f, g.method);
    const sites = methodSites(f, g).filter((s) => s.paren >= 0);
    if (!fn || sites.length !== 1) continue;
    const site = sites[0];
    const labels = bindingLabels(tree.bindings, g.engine);
    if (!labels) {
      out.push(
        `S6 ${g.engine}: no single \`open func ${g.engine}(\` in the bindings`,
      );
      continue;
    }
    const args = labeledArgs(f.m, site.paren);
    const want = labels.join(",");
    const got = args.map((a) => a.label).join(",");
    const pinned = Object.keys(g.args).join(",");
    if (got !== want || want !== pinned) {
      out.push(
        `S6 ${g.method} (${where(f, site.at)}) passes labels (${got}); the bindings have (${want}), this spec pins (${pinned})`,
      );
      continue;
    }
    for (const [label, rule] of Object.entries(g.args)) {
      const arg = args.find((a) => a.label === label);
      const source = arg ? resolveArg(f, fn, arg) : null;
      if (!ruleMet(rule, source)) {
        out.push(
          `S6 ${g.method} ${label} (${where(f, arg?.at ?? site.at)}) comes from ${source ?? arg?.text ?? "nothing"}; expected ${expected(rule)}`,
        );
      }
    }
  }
  const argsType = typeBody(f, "struct", "E2eeCallArgs");
  const readers = argsType
    ? f.fns.filter((fn) => fn.name === "string" && within(fn.at, argsType))
    : [];
  if (readers.length !== 1 || readers[0].open < 0) {
    out.push(
      `S6 E2eeCallArgs has ${readers.length} string( readers; expected one`,
    );
  } else {
    const r = readers[0];
    if (
      squash(f.m.code.slice(r.paramsClose + 1, r.open)) !== "throws->String"
    ) {
      out.push(
        `S6 E2eeCallArgs.string( (${where(f, r.at)}) is not declared throws -> String`,
      );
    }
  }
  return out;
}

function s7(tree: Tree): string[] {
  const out: string[] = [];
  const f = fileOf(tree, PLUGIN);
  if (!f) return [`S7 ${PLUGIN} is missing`];
  const { code, text } = f.m;
  const resolution = typeBody(f, "enum", "Resolution");
  if (
    !resolution ||
    !/\bcase\s+empty\b/.test(code.slice(resolution.open, resolution.close))
  ) {
    out.push("S7 enum Resolution has no `case empty`");
  }
  const settles = fnsNamed(f, "settle");
  const arms =
    settles.length === 1 && settles[0].open >= 0
      ? firstSwitch(f.m, settles[0].open, settles[0].close)
      : null;
  const empty = (arms ?? []).filter(
    (a) => a.labels.length === 1 && a.labels[0] === ".empty",
  );
  if (empty.length !== 1) {
    out.push(`S7 settle has ${empty.length} arms for .empty; expected one`);
  } else {
    const body = squash(text.slice(empty[0].body[0], empty[0].body[1]));
    if (body !== "call.resolve([:])" && body !== "call.resolve()") {
      out.push(
        `S7 ${where(f, empty[0].at)} settle's .empty arm must only call.resolve([:])`,
      );
    }
  }
  for (const g of GATED.filter((x) => x.empty)) {
    const fn = pluginMethod(f, g.method);
    const hs = fn ? handoffs(f, { open: fn.open, close: fn.close }) : [];
    const closure = hs.length === 1 ? hs[0].closure : null;
    if (!closure) continue;
    const head = `S7 ${g.method} (${where(f, closure.open)})`;
    const returns = allMatches(/\breturn\b/, code, closure.open, closure.close);
    if (returns.length === 0) out.push(`${head} never returns .empty`);
    for (const r of returns) {
      if (!/^\s*\.\s*empty\b/.test(code.slice(r.index + 6, r.index + 40))) {
        out.push(
          `S7 ${g.method} (${where(f, r.index)}) returns something other than .empty`,
        );
      }
    }
    if (/\.\s*json\b/.test(code.slice(closure.open, closure.close))) {
      out.push(`${head} resolves a json payload`);
    }
    if (/\bcall\b/.test(code.slice(closure.open, closure.close))) {
      out.push(`${head} settles the call itself`);
    }
  }
  return out;
}

function s8(tree: Tree): string[] {
  const out: string[] = [];
  const f = fileOf(tree, PLUGIN);
  if (!f) return [`S8 ${PLUGIN} is missing`];
  const { code, text } = f.m;
  const arms = (genericArms(f) ?? []).filter((a) =>
    a.values.includes(PEER_DOWNGRADE),
  );
  if (arms.length !== 1) {
    return [
      `S8 runGeneric has ${arms.length} arms for ${PEER_DOWNGRADE}; expected one`,
    ];
  }
  const arm = arms[0];
  const head = `S8 ${where(f, arm.at)}`;
  if (arm.labels.length !== 1)
    out.push(`${head} the ${PEER_DOWNGRADE} arm shares its label`);
  const [from, to] = arm.body;
  let guardEnd = -1;
  for (const kw of allMatches(/\b(?:if|guard)\b/, code, from, to)) {
    if (innermost(f.blocks, kw.index) !== innermost(f.blocks, from)) continue;
    const isGuard = kw[0] === "guard";
    let j = kw.index + kw[0].length;
    while (j < to && code[j] !== "{") {
      if ("([".includes(code[j])) j = matchClose(code, j);
      j++;
    }
    if (j >= to) continue;
    let cond = text.slice(kw.index + kw[0].length, j);
    if (isGuard) {
      const e = /\belse\s*$/.exec(code.slice(kw.index + kw[0].length, j));
      if (!e) continue;
      cond = text.slice(
        kw.index + kw[0].length,
        kw.index + kw[0].length + e.index,
      );
    }
    const close = matchClose(code, j);
    const body = squash(text.slice(j + 1, close));
    if (
      (isGuard ? ACCEPT_GUARD : ACCEPT_IF).includes(squash(cond)) &&
      body === ACCEPT_THROW
    ) {
      if (guardEnd < 0) guardEnd = close;
    }
  }
  if (guardEnd < 0) {
    out.push(
      `${head} has no \`if try args.optionalBool("accept") == true { throw E2eeReject.invalidArgument("accept") }\``,
    );
  } else {
    for (const e of allMatches(/\bengine\b/, code, from, guardEnd)) {
      out.push(`S8 ${where(f, e.index)} names engine before the accept guard`);
    }
  }
  const sites = memberSites(code, "confirmPeerDowngrade", from, to);
  if (sites.length !== 1) {
    out.push(
      `${head} the arm makes ${sites.length} confirmPeerDowngrade calls; expected one`,
    );
    return out;
  }
  const site = sites[0];
  if (site.paren < 0)
    return [...out, `${head} confirmPeerDowngrade is not called`];
  if (guardEnd >= 0 && site.at < guardEnd) {
    out.push(
      `S8 ${where(f, site.at)} confirmPeerDowngrade runs before the accept guard`,
    );
  }
  const fn = enclosingFn(f, site.at);
  const args = labeledArgs(f.m, site.paren);
  const labels = args.map((a) => a.label).join(",");
  const want = bindingLabels(tree.bindings, "confirmPeerDowngrade")?.join(",");
  if (labels !== "conversationId,accept" || want !== labels) {
    out.push(
      `S8 ${where(f, site.at)} passes labels (${labels}); expected (conversationId,accept) as in the bindings (${want})`,
    );
    return out;
  }
  if (args[1].code !== "false") {
    out.push(
      `S8 ${where(f, args[1].at)} passes accept: ${args[1].text}; expected the literal false`,
    );
  }
  const conversation = fn ? resolveArg(f, fn, args[0]) : null;
  if (conversation !== 'string("conversationId")') {
    out.push(
      `S8 ${where(f, args[0].at)} conversationId comes from ${conversation ?? args[0].text}; expected args.string("conversationId")`,
    );
  }
  return out;
}

const BACK_DOORS: [RegExp, string][] = [
  [/\bNSSelectorFromString\s*\(/, "NSSelectorFromString("],
  [/\bNSClassFromString\s*\(/, "NSClassFromString("],
  [/\bSelector\s*\(\s*#*"/, 'Selector("…")'],
  [/\bdlsym\s*\(/, "dlsym("],
  [/\bdlopen\s*\(/, "dlopen("],
  [/@_silgen_name\b/, "@_silgen_name"],
  [/\.\s*value\s*\(\s*forKey(?:Path)?\s*:/, ".value(forKey:)"],
  [/\.\s*setValue\s*\([^()]*\bforKey(?:Path)?\s*:/, ".setValue(_:forKey:)"],
  [/\bimport\s+\w*FFI\b/, "an import of the raw FFI module"],
  [/\buniffi_\w+/, "a raw uniffi symbol"],
  [/\bffi_acutest_e2ee_ios\w*/, "a raw FFI symbol"],
  [/\bextension\s+E2eeEngine\b/, "extension E2eeEngine"],
  [/\bclass\s+\w+\s*:[^{]*\bE2eeEngine\b/, "a subclass of E2eeEngine"],
];

function s9(tree: Tree): string[] {
  const out: string[] = [];
  for (const f of tree.sources) {
    for (const [re, what] of BACK_DOORS) {
      for (const m of allMatches(re, f.m.code)) {
        out.push(`S9 ${where(f, m.index)} ${what}`);
      }
    }
  }
  return out;
}

const RULES: [string, (tree: Tree) => string[]][] = [
  ["S1", s1],
  ["S2", s2],
  ["S3", s3],
  ["S4", s4],
  ["S5", s5],
  ["S6", s6],
  ["S7", s7],
  ["S8", s8],
  ["S9", s9],
];

/** Every violation, each starting with its rule id. */
function swiftViolations(tree: Tree): string[] {
  const out: string[] = [];
  for (const [rule, check] of RULES) {
    try {
      out.push(...check(tree));
    } catch (error) {
      out.push(`${rule} could not parse: ${String(error)}`);
    }
  }
  return out;
}

function treeOf(sources: Record<string, string>, bindings: string): Tree {
  return {
    sources: Object.entries(sources).map(([name, src]) => load(name, src)),
    bindings: load("bindings", bindings),
  };
}

// ---- Fixtures: the scanner itself must be able to fail ----------------------

/** Applies each swap (an exact, unique snippet) to `src`. */
function swapped(src: string, swaps: [string, string][]): string {
  for (const [from, to] of swaps) {
    assert.equal(src.split(from).length, 2, `fixture swap: ${from}`);
    src = src.replace(from, to);
  }
  return src;
}

const ruleOf = (violation: string) => violation.split(" ")[0];

/**
 * Asserts that `found` holds a violation matching `expected`, and nothing
 * from any rule outside `rules`.
 */
function assertOnly(
  label: string,
  found: string[],
  rules: string[],
  expected: RegExp,
) {
  const dump = JSON.stringify(found, null, 2);
  assert.ok(
    found.some((v) => expected.test(v)),
    `${label}: expected ${expected}, got ${dump}`,
  );
  assert.deepEqual(
    found.filter((v) => !rules.includes(ruleOf(v))),
    [],
    `${label}: fired outside ${rules.join(", ")}: ${dump}`,
  );
}

/** The plugin; trailing comments only make swap targets unique. */
const PLUGIN_FIXTURE = `
import AcutestE2eeBindings
import Capacitor
import Foundation

@objc(E2eePlugin)
public final class E2eePlugin: CAPPlugin, CAPBridgedPlugin {
    public let jsName = "E2ee"
    private static var armed = false

    private static func armedOrReject(_ call: CAPPluginCall) -> Bool {
        if !armed {
            call.reject(E2eeReject.cryptoFailure.json)
        }
        return armed
    }

    @objc func call(_ call: CAPPluginCall) {
        guard Self.armedOrReject(call) else { return } // mux-guard
        guard let name = Self.validated(call, { try E2eeCallArgs(call).string("__cmd") }) else {
            return
        }
        switch E2eeCommands.route(for: name) {
        case .generic: // mux-generic
            E2eeRuntime.shared.engineWorker.submit {
                dispatchPrecondition(condition: .notOnQueue(.main))
                Self.settle(call) {
                    .json(try Self.runGeneric(name, E2eeCallArgs(call)))
                }
            }
        case .native:
            call.reject(E2eeReject.invalidArgument("name").json) // mux-native
        case .dedicated, .out: // mux-dedicated
            call.reject(E2eeReject.invalidArgument("name").json) // mux-reject
        }
    }

    @objc func wipe(_ call: CAPPluginCall) {
        guard Self.armedOrReject(call) else { return } // wipe-guard
        Self.onDedicatedThread(call, "gg.sloga.e2ee.wipe") { // wipe-thread
            dispatchPrecondition(condition: .notOnQueue(.main)) // wipe-precondition
            try E2eeRuntime.shared.engine().wipe() // wipe-commit
            return .json("null")
        }
    }

    @objc func downgrade(_ call: CAPPluginCall) { // downgrade-def
        guard Self.armedOrReject(call) else { return } // downgrade-guard
        let args = E2eeCallArgs(call)
        guard let input = Self.validated(call, {
            try (
                conversationId: args.string("conversationId"),
                selfUserId: args.string("selfUserId"), // downgrade-self
                bundles: args.optionalArrayJSON("bundles")
            )
        }) else {
            return
        }
        Self.onDedicatedThread(call, "gg.sloga.e2ee.downgrade") {
            dispatchPrecondition(condition: .notOnQueue(.main))
            let json = try E2eeRuntime.shared.engine().downgrade( // downgrade-commit
                conversationId: input.conversationId,
                selfUserId: input.selfUserId,
                bundlesJson: input.bundles
            )
            return .json(json)
        }
    }

    @objc func confirmPeerDowngradeAccept(_ call: CAPPluginCall) {
        guard Self.armedOrReject(call) else { return } // peer-accept-guard
        guard let conversationId = Self.validated(call, {
            try E2eeCallArgs(call).string("conversationId")
        }) else {
            return
        }
        Self.onDedicatedThread(call, "gg.sloga.e2ee.peer-downgrade-accept") {
            dispatchPrecondition(condition: .notOnQueue(.main))
            try E2eeRuntime.shared.engine().confirmPeerDowngrade(conversationId: conversationId, accept: true) // peer-accept-commit
            return .json("null")
        }
    }

    @objc func markVerified(_ call: CAPPluginCall) {
        guard Self.armedOrReject(call) else { return } // verify-guard
        let args = E2eeCallArgs(call)
        guard let input = Self.validated(call, {
            try (
                peerUserId: args.string("peerUserId"), // verify-peer
                deviceId: args.string("deviceId"),
                selfUserId: args.string("selfUserId"), // verify-self
                displayName: args.optionalString("displayName")
            )
        }) else {
            return
        }
        Self.onDedicatedThread(call, "gg.sloga.e2ee.mark-verified") {
            dispatchPrecondition(condition: .notOnQueue(.main)) // verify-precondition
            try E2eeRuntime.shared.engine().markVerified( // verify-commit
                peerUserId: input.peerUserId,
                deviceId: input.deviceId,
                selfUserId: input.selfUserId, // verify-self-pass
                displayName: input.displayName
            )
            return .empty // verify-return
        }
    }

    @objc func acceptIdentityChange(_ call: CAPPluginCall) {
        guard Self.armedOrReject(call) else { return } // accept-guard
        let args = E2eeCallArgs(call)
        guard let input = Self.validated(call, {
            try (
                peerUserId: args.string("peerUserId"),
                deviceId: args.string("deviceId"), // accept-device
                selfUserId: args.string("selfUserId"), // accept-self
                displayName: args.optionalString("displayName")
            )
        }) else {
            return
        }
        Self.onDedicatedThread(call, "gg.sloga.e2ee.accept-identity-change") { // accept-thread
            dispatchPrecondition(condition: .notOnQueue(.main))
            try E2eeRuntime.shared.engine().acceptIdentityChange( // accept-commit
                peerUserId: input.peerUserId,
                deviceId: input.deviceId,
                selfUserId: input.selfUserId, // accept-self-pass
                displayName: input.displayName
            )
            return .empty // accept-return
        }
    }
}

private extension E2eePlugin {
    enum Resolution {
        case json(String)
        case empty // resolution-empty
    }

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
                call.resolve(["json": json])
            case .empty:
                call.resolve([:]) // settle-empty
            }
        } catch {
            call.reject(rejectJson(for: error))
        }
    }

    static func onDedicatedThread(_ call: CAPPluginCall, _ name: String, _ body: @escaping () throws -> Resolution) {
        runOnDedicatedThread(name: name) { // helper-run
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
        case "e2ee_safety_number":
            return try engine.safetyNumber(
                selfUserId: args.string("selfUserId"),
                peerUserId: args.string("peerUserId"),
                deviceId: args.string("deviceId")
            )
        case "e2ee_confirm_peer_downgrade": // peer-arm
            if try args.optionalBool("accept") == true { // peer-guard
                throw E2eeReject.invalidArgument("accept") // peer-throw
            } // peer-guard-end
            try engine.confirmPeerDowngrade(conversationId: args.string("conversationId"), accept: false) // peer-decline
            return "null" // peer-return
        case "e2ee_downgraded_conversations":
            return try engine.downgradedConversations() // generic-downgraded
        default:
            throw E2eeReject.invalidArgument("name")
        }
    }
}

private struct E2eeCallArgs {
    let call: CAPPluginCall

    init(_ call: CAPPluginCall) {
        self.call = call
    }

    func string(_ key: String, field: String? = nil) throws -> String { // args-string
        guard let text = try optionalString(key, field: field) else {
            throw E2eeReject.invalidArgument(field ?? key)
        }
        return text
    }

    func optionalString(_ key: String, field: String? = nil) throws -> String? {
        call.options?[key] as? String
    }
}
`;

const COMMANDS_FIXTURE = `
import Foundation

enum E2eeRoute: Equatable {
    case generic
    case native
    case dedicated(String)
    case out
}

enum E2eeCommands {
    static let table: [(name: String, route: E2eeRoute)] = [
        ("e2ee_status", .generic), // table-status
        ("e2ee_safety_number", .generic),
        ("e2ee_confirm_peer_downgrade", .generic), // table-peer
        ("e2ee_downgraded_conversations", .generic),
        ("e2ee_wipe", .dedicated("wipe")), // table-wipe
        ("e2ee_downgrade", .dedicated("downgrade")), // table-downgrade
        ("e2ee_mark_verified", .dedicated("markVerified")), // table-verify
        ("e2ee_accept_identity_change", .dedicated("acceptIdentityChange")), // table-accept
        ("e2ee_call_create", .out),
    ]

    static let dedicatedMethods: [String] = [
        "wipe",
        "downgrade",
        "confirmPeerDowngradeAccept", // methods-peer
        "markVerified",
        "acceptIdentityChange",
    ]

    private static let routes: [String: E2eeRoute] = {
        var map: [String: E2eeRoute] = [:]
        for entry in table where map[entry.name] == nil {
            map[entry.name] = entry.route
        }
        return map
    }()

    static func route(for name: String) -> E2eeRoute {
        routes[name] ?? .out // route-lookup
    }
}
`;

/** The Thread block of the Support fixture, as one swap target. */
const SUPPORT_THREAD = `let thread = Thread {
        autoreleasepool {
            body()
        }
    }`;

const SUPPORT_FIXTURE = `
import Foundation

func runOnDedicatedThread(name: String, _ body: @escaping () -> Void) {
    ${SUPPORT_THREAD}
    thread.name = name
    thread.stackSize = engineThreadStackSize
    thread.start() // support-start
}

final class E2eeRuntime: @unchecked Sendable {
    static let shared = E2eeRuntime()

    func engine() throws -> E2eeEngine {
        dispatchPrecondition(condition: .notOnQueue(.main))
        return try E2eeEngine(storeDir: "/tmp/e2ee", confirm: NativeConfirmPresenter.shared)
    }
}
`;

/** Another Sources file: a scrub buffer with its own wipe(). */
const RECOVERY_FIXTURE = `
import UIKit

final class SecretBox {
    private var bytes: Data

    init(_ code: String) {
        bytes = Data(code.utf8)
    }

    func wipe() {
        bytes = Data()
    }
}

enum RecoverySheet {
    static func show(_ secret: SecretBox, _ engine: E2eeEngine) throws {
        dispatchPrecondition(condition: .notOnQueue(.main))
        secret.wipe() // recovery-wipe
        _ = try engine.backupStatus() // recovery-status
    }
}
`;

const BINDINGS_FIXTURE = `
open class E2eeEngine: E2eeEngineProtocol, @unchecked Sendable {
open func acceptIdentityChange(peerUserId: String, deviceId: String, selfUserId: String?, displayName: String?)throws   {try rustCallWithError(FfiConverterTypeE2eeError_lift) { _ in }
}
open func confirmPeerDowngrade(conversationId: String, accept: Bool)throws   {}
open func downgrade(conversationId: String, selfUserId: String, bundlesJson: String?)throws  -> String  { "" }
open func markVerified(peerUserId: String, deviceId: String, selfUserId: String?, displayName: String?)throws   {} // bind-verify
open func wipe()throws   {}
}
`;

type FixtureFile = "plugin" | "commands" | "support" | "recovery" | "bindings";
type Edits = Partial<Record<FixtureFile, [string, string][]>>;

function fixtureTree(edits: Edits = {}): Tree {
  const s = (file: FixtureFile, src: string) => swapped(src, edits[file] ?? []);
  return treeOf(
    {
      [PLUGIN]: s("plugin", PLUGIN_FIXTURE),
      [COMMANDS]: s("commands", COMMANDS_FIXTURE),
      [SUPPORT]: s("support", SUPPORT_FIXTURE),
      "RecoverySheet.swift": s("recovery", RECOVERY_FIXTURE),
    },
    s("bindings", BINDINGS_FIXTURE),
  );
}

/** The peer-downgrade accept guard, as one swap target. */
const PEER_GUARD = `if try args.optionalBool("accept") == true { // peer-guard
                throw E2eeReject.invalidArgument("accept") // peer-throw
            } // peer-guard-end`;

const PEER_DECLINE = `try engine.confirmPeerDowngrade(conversationId: args.string("conversationId"), accept: false) // peer-decline`;

test("swift lexer: comments, interpolation, raw and multi-line strings", () => {
  const src = [
    'let a = "x \\(f("engine.wipe()")) y" // engine.wipe()',
    "/* outer /* engine.markVerified( */ still comment */ let b = 1",
    'let c = #"raw "engine.downgrade(" \\(not) "#',
    'let d = """',
    "  engine.acceptIdentityChange(",
    "  \\(g(1))",
    '  """',
    'let e = #/re"gex/#; let h = 2',
  ].join("\n");
  const m = maskSwift(src);
  assert.equal(m.code.length, src.length);
  assert.equal(m.text.length, src.length);
  for (const gone of [
    "engine.wipe",
    "engine.markVerified",
    "still comment",
    "engine.downgrade",
    "not",
    "engine.acceptIdentityChange",
    "gex",
  ]) {
    assert.ok(!m.code.includes(gone), `code still has ${gone}`);
  }
  for (const kept of ["f(", "g(1)", "let b = 1", "let h = 2"]) {
    assert.ok(m.code.includes(kept), `code lost ${kept}`);
  }
  assert.ok(m.text.includes('raw "engine.downgrade(" \\(not) '));
  assert.ok(!m.text.includes("still comment"));
  assert.deepEqual(
    m.literals.map((l) => l.value.trim()),
    [
      "engine.wipe()",
      'x \\(f("engine.wipe()")) y',
      'raw "engine.downgrade(" \\(not)',
      "engine.acceptIdentityChange(\n  \\(g(1))",
      're"gex',
    ],
  );
});

test("swift scanner: a conforming fixture has no violations", () => {
  assert.deepEqual(swiftViolations(fixtureTree()), []);
});

test("swift scanner: equivalent shapes still conform", () => {
  const variants: [string, Edits][] = [
    [
      "S7: call.resolve() for .empty",
      { plugin: [["call.resolve([:]) // settle-empty", "call.resolve()"]] },
    ],
    [
      "S2: a dedicated command in a comment is no case",
      {
        plugin: [
          [
            'case "e2ee_status": // generic-status',
            '// case "e2ee_mark_verified": lives in markVerified\n        /* case "e2ee_wipe": */\n        case "e2ee_status":',
          ],
        ],
      },
    ],
    [
      "S5/S6: a local engine and an inline required read",
      {
        plugin: [
          [
            "try E2eeRuntime.shared.engine().markVerified( // verify-commit",
            "let engine = try E2eeRuntime.shared.engine()\n            try engine.markVerified(",
          ],
          [
            "selfUserId: input.selfUserId, // verify-self-pass",
            'selfUserId: try args.string("selfUserId"),',
          ],
        ],
      },
    ],
    [
      "S3: a multi-line arm guard",
      {
        plugin: [
          [
            "guard Self.armedOrReject(call) else { return } // verify-guard",
            "guard Self.armedOrReject(call) else {\n            return\n        }",
          ],
        ],
      },
    ],
    [
      "S8: the ?? false spelling",
      {
        plugin: [
          [
            'if try args.optionalBool("accept") == true { // peer-guard',
            'if try args.optionalBool("accept") ?? false {',
          ],
        ],
      },
    ],
    [
      "S8: a guard statement",
      {
        plugin: [
          [
            PEER_GUARD,
            'guard try args.optionalBool("accept") != true else {\n                throw E2eeReject.invalidArgument("accept")\n            }',
          ],
        ],
      },
    ],
    [
      "S5/S9: gated names in strings and comments of another file",
      {
        recovery: [
          [
            "_ = try engine.backupStatus() // recovery-status",
            '_ = try engine.backupStatus()\n        let note = "engine.markVerified( NSSelectorFromString( dlsym("\n        // engine.wipe(); uniffi_acutest_e2ee_ios_fn_method_e2eeengine_wipe()\n        _ = note',
          ],
        ],
      },
    ],
    [
      "S4: Thread(block:)",
      {
        support: [
          [
            SUPPORT_THREAD,
            "let thread = Thread(block: {\n        body()\n    })",
          ],
        ],
      },
    ],
    [
      "S5: the same name built by another call in another function",
      {
        recovery: [
          [
            "enum RecoverySheet {",
            "enum RecoverySheet {\n    static func other() {\n        let secret = lookup()\n        _ = secret\n    }\n",
          ],
        ],
      },
    ],
    [
      "S5: a scrub buffer held as an optional",
      {
        recovery: [
          [
            "secret.wipe() // recovery-wipe",
            "let spare: SecretBox? = secret\n        spare?.wipe()",
          ],
        ],
      },
    ],
  ];
  for (const [label, edits] of variants) {
    assert.deepEqual(swiftViolations(fixtureTree(edits)), [], label);
  }
});

test("swift scanner: each rule fires on its own violation, and only it", () => {
  // [label (its rule first), edits, expected violation, other rules allowed]
  const cases: [string, Edits, RegExp, string[]?][] = [
    [
      "S1: the verify command routed generic",
      {
        commands: [
          [
            '("e2ee_mark_verified", .dedicated("markVerified")), // table-verify',
            '("e2ee_mark_verified", .generic),',
          ],
        ],
      },
      /^S1 .* routes e2ee_mark_verified to \.generic/,
    ],
    [
      "S1: an earlier generic duplicate of accept, which routes keeps",
      {
        commands: [
          [
            '("e2ee_status", .generic), // table-status',
            '("e2ee_accept_identity_change", .generic),\n        ("e2ee_status", .generic),',
          ],
        ],
      },
      /^S1 table has 2 entries for e2ee_accept_identity_change/,
    ],
    [
      "S1: route(for:) special-cases wipe",
      {
        commands: [
          [
            "routes[name] ?? .out // route-lookup",
            'name == "e2ee_wipe" ? .generic : routes[name] ?? .out',
          ],
        ],
      },
      /^S1 .* e2ee_wipe in 2 string literals/,
    ],
    [
      "S1: downgrade routed to the wipe method",
      {
        commands: [
          [
            '("e2ee_downgrade", .dedicated("downgrade")), // table-downgrade',
            '("e2ee_downgrade", .dedicated("wipe")),',
          ],
        ],
      },
      /^S1 .* routes e2ee_downgrade to \.dedicated\("wipe"\)/,
    ],
    [
      "S1: the peer-downgrade command is not generic",
      {
        commands: [
          [
            '("e2ee_confirm_peer_downgrade", .generic), // table-peer',
            '("e2ee_confirm_peer_downgrade", .dedicated("confirmPeerDowngradeAccept")),',
          ],
        ],
      },
      /^S1 .* routes e2ee_confirm_peer_downgrade/,
    ],
    [
      "S1: confirmPeerDowngradeAccept is no plugin method",
      { commands: [['"confirmPeerDowngradeAccept", // methods-peer', ""]] },
      /^S1 dedicatedMethods lists confirmPeerDowngradeAccept 0 times/,
    ],
    [
      "S2: a generic verify arm",
      {
        plugin: [
          [
            'case "e2ee_status": // generic-status',
            'case "e2ee_mark_verified":\n            return "null"\n        case "e2ee_status":',
          ],
        ],
      },
      /^S2 .* runGeneric has a case for e2ee_mark_verified/,
    ],
    [
      "S2: accept shares a generic arm",
      {
        plugin: [
          [
            'case "e2ee_status": // generic-status',
            'case "e2ee_status", "e2ee_accept_identity_change":',
          ],
        ],
      },
      /^S2 .* runGeneric has a case for e2ee_accept_identity_change/,
    ],
    [
      "S2: a wipe literal elsewhere in the plugin",
      {
        plugin: [
          [
            "guard Self.armedOrReject(call) else { return } // mux-guard",
            'guard Self.armedOrReject(call) else { return }\n        let shortcut = "e2ee_wipe"',
          ],
        ],
      },
      /^S2 .* a string literal names e2ee_wipe/,
    ],
    [
      "S2: the mux runs the dedicated route generically",
      {
        plugin: [
          ["case .generic: // mux-generic", "case .generic, .dedicated:"],
          ["case .dedicated, .out: // mux-dedicated", "case .out:"],
        ],
      },
      /^S2 .* runGeneric\( outside the arm labelled \.generic alone/,
    ],
    [
      "S2: the dedicated route resolves",
      {
        plugin: [
          [
            'call.reject(E2eeReject.invalidArgument("name").json) // mux-reject',
            "call.resolve()",
          ],
        ],
      },
      /^S2 .* the \.dedicated arm must be exactly/,
    ],
    [
      "S2: runGeneric from the native arm",
      {
        plugin: [
          [
            'call.reject(E2eeReject.invalidArgument("name").json) // mux-native',
            "_ = try? Self.runGeneric(name, E2eeCallArgs(call))",
          ],
        ],
      },
      /^S2 .* runGeneric\( 2 times|^S2 .* runGeneric\( outside/,
    ],
    [
      "S3: markVerified without the arm check",
      {
        plugin: [
          [
            "guard Self.armedOrReject(call) else { return } // verify-guard",
            "",
          ],
        ],
      },
      /^S3 markVerified .* does not start with guard Self\.armedOrReject/,
    ],
    [
      "S3: a statement before the precondition",
      {
        plugin: [
          [
            "dispatchPrecondition(condition: .notOnQueue(.main)) // verify-precondition",
            "let started = Date()\n            dispatchPrecondition(condition: .notOnQueue(.main))",
          ],
        ],
      },
      /^S3 markVerified .* closure does not start with dispatchPrecondition/,
    ],
    [
      "S3: wipe commits on the bridge queue",
      {
        plugin: [
          [
            'Self.onDedicatedThread(call, "gg.sloga.e2ee.wipe") { // wipe-thread',
            'try? E2eeRuntime.shared.engine().wipe()\n        Self.onDedicatedThread(call, "gg.sloga.e2ee.wipe") {',
          ],
          ["try E2eeRuntime.shared.engine().wipe() // wipe-commit", ""],
        ],
      },
      /^S3 wipe .* not directly in the dedicated-thread closure/,
    ],
    [
      "S3: accept runs on the engine worker",
      {
        plugin: [
          [
            'Self.onDedicatedThread(call, "gg.sloga.e2ee.accept-identity-change") { // accept-thread',
            "E2eeRuntime.shared.engineWorker.submit {",
          ],
        ],
      },
      /^S3 acceptIdentityChange .* hands off to Self\.onDedicatedThread 0 times/,
    ],
    [
      "S3: downgrade is not @objc",
      {
        plugin: [
          [
            "@objc func downgrade(_ call: CAPPluginCall) { // downgrade-def",
            "func downgrade(_ call: CAPPluginCall) {",
          ],
        ],
      },
      /^S3 downgrade .* is not @objc/,
    ],
    [
      "S3: the accept commit hops to main",
      {
        plugin: [
          [
            "try E2eeRuntime.shared.engine().confirmPeerDowngrade(conversationId: conversationId, accept: true) // peer-accept-commit",
            "DispatchQueue.main.async {\n                try? E2eeRuntime.shared.engine().confirmPeerDowngrade(conversationId: conversationId, accept: true)\n            }",
          ],
        ],
      },
      /^S3 confirmPeerDowngradeAccept .* not directly in the dedicated-thread closure/,
    ],
    [
      "S4: the dedicated thread is the engine worker",
      {
        support: [
          [SUPPORT_THREAD, "E2eeRuntime.shared.engineWorker.submit(body)"],
          ["thread.name = name", ""],
          ["thread.stackSize = engineThreadStackSize", ""],
          ["thread.start() // support-start", ""],
        ],
      },
      /^S4 runOnDedicatedThread .* names a queue/,
    ],
    [
      "S4: onDedicatedThread uses a GCD queue",
      {
        plugin: [
          [
            "runOnDedicatedThread(name: name) { // helper-run",
            "DispatchQueue.global().async {",
          ],
        ],
      },
      /^S4 onDedicatedThread .* names a queue/,
    ],
    [
      "S4: the helper drops the precondition",
      {
        plugin: [
          [
            "dispatchPrecondition(condition: .notOnQueue(.main)) // helper-precondition",
            "",
          ],
        ],
      },
      /^S4 onDedicatedThread .* thread closure does not start with/,
    ],
    [
      "S4: body also runs on the caller's thread",
      {
        support: [
          ["thread.start() // support-start", "thread.start()\n    body()"],
        ],
      },
      /^S4 runOnDedicatedThread .* body\(\) only inside the Thread/,
    ],
    [
      "S5: a second verify commit in a generic arm",
      {
        plugin: [
          [
            "return try engine.downgradedConversations() // generic-downgraded",
            'try engine.markVerified(peerUserId: "", deviceId: "", selfUserId: nil, displayName: nil)\n            return try engine.downgradedConversations()',
          ],
        ],
      },
      /^S5 .* engine\.markVerified sits in runGeneric/,
    ],
    [
      "S5: accept from another file",
      {
        recovery: [
          [
            "secret.wipe() // recovery-wipe",
            'secret.wipe()\n        try E2eeRuntime.shared.engine().acceptIdentityChange(peerUserId: "", deviceId: "", selfUserId: nil, displayName: nil)',
          ],
        ],
      },
      /^S5 RecoverySheet\.swift:\d+ E2eeRuntime\.shared\.engine\(\)\.acceptIdentityChange outside/,
    ],
    [
      "S5: an engine wipe from another file",
      { recovery: [["secret.wipe() // recovery-wipe", "try engine.wipe()"]] },
      /^S5 RecoverySheet\.swift:\d+ engine\.wipe outside/,
    ],
    [
      "S5: a wipe on a value some other call built",
      {
        recovery: [
          [
            "secret.wipe() // recovery-wipe",
            "let handle = Self.open()\n        handle.wipe()",
          ],
        ],
      },
      /^S5 RecoverySheet\.swift:\d+ handle\.wipe outside/,
    ],
    [
      "S5: accept: true from the downgrade method",
      {
        plugin: [
          [
            "let json = try E2eeRuntime.shared.engine().downgrade( // downgrade-commit",
            "try E2eeRuntime.shared.engine().confirmPeerDowngrade(conversationId: input.conversationId, accept: true)\n            let json = try E2eeRuntime.shared.engine().downgrade(",
          ],
        ],
      },
      /^S5 .*\.confirmPeerDowngrade sits in downgrade,/,
    ],
    [
      "S5: a stored reference",
      {
        recovery: [
          [
            "_ = try engine.backupStatus() // recovery-status",
            "let commit = engine.markVerified\n        _ = commit",
          ],
        ],
      },
      /^S5 RecoverySheet\.swift:\d+ engine\.markVerified outside/,
    ],
    [
      "S5: a bare call from an engine extension",
      {
        recovery: [
          [
            "enum RecoverySheet {",
            "extension E2eeEngine {\n    func sneak() throws {\n        try wipe()\n    }\n}\n\nenum RecoverySheet {",
          ],
        ],
      },
      /^S5 RecoverySheet\.swift:\d+ names wipe outside a member call/,
      ["S9"],
    ],
    [
      "S5: the receiver is not the engine",
      {
        plugin: [
          [
            "try E2eeRuntime.shared.engine().markVerified( // verify-commit",
            "try Self.shadowEngine.markVerified(",
          ],
        ],
      },
      /^S5 .*\.markVerified: the receiver is not the engine/,
    ],
    [
      "S6: verify's self id may be absent",
      {
        plugin: [
          [
            'selfUserId: args.string("selfUserId"), // verify-self',
            'selfUserId: args.optionalString("selfUserId"),',
          ],
        ],
      },
      /^S6 markVerified selfUserId .* optionalString\("selfUserId"\)/,
    ],
    [
      "S6: accept passes nil",
      {
        plugin: [
          [
            "selfUserId: input.selfUserId, // accept-self-pass",
            "selfUserId: nil,",
          ],
        ],
      },
      /^S6 acceptIdentityChange selfUserId .* from nil/,
    ],
    [
      "S6: the peer id read from another key",
      {
        plugin: [
          [
            'peerUserId: args.string("peerUserId"), // verify-peer',
            'peerUserId: args.string("userId"),',
          ],
        ],
      },
      /^S6 markVerified peerUserId .* string\("userId"\)/,
    ],
    [
      "S6: downgrade's self id may be absent",
      {
        plugin: [
          [
            'selfUserId: args.string("selfUserId"), // downgrade-self',
            'selfUserId: args.optionalString("selfUserId"),',
          ],
        ],
      },
      /^S6 downgrade selfUserId/,
    ],
    [
      "S6: the accept leg passes the request's accept",
      {
        plugin: [
          [
            "try E2eeRuntime.shared.engine().confirmPeerDowngrade(conversationId: conversationId, accept: true) // peer-accept-commit",
            'try E2eeRuntime.shared.engine().confirmPeerDowngrade(conversationId: conversationId, accept: E2eeCallArgs(call).bool("accept"))',
          ],
        ],
      },
      /^S6 confirmPeerDowngradeAccept accept/,
    ],
    [
      "S6: the bindings lost a label",
      {
        bindings: [
          [
            "open func markVerified(peerUserId: String, deviceId: String, selfUserId: String?, displayName: String?)throws   {} // bind-verify",
            "open func markVerified(peerUserId: String, deviceId: String, displayName: String?)throws   {}",
          ],
        ],
      },
      /^S6 markVerified .* the bindings have \(peerUserId,deviceId,displayName\)/,
    ],
    [
      "S6: string( may return nil",
      {
        plugin: [
          [
            "func string(_ key: String, field: String? = nil) throws -> String { // args-string",
            "func string(_ key: String, field: String? = nil) throws -> String? {",
          ],
        ],
      },
      /^S6 E2eeCallArgs\.string\( .* not declared throws -> String/,
    ],
    [
      "S7: verify resolves {json}",
      { plugin: [["return .empty // verify-return", 'return .json("null")']] },
      /^S7 markVerified .* returns something other than \.empty/,
    ],
    [
      "S7: settle resolves a json payload for .empty",
      {
        plugin: [
          [
            "call.resolve([:]) // settle-empty",
            'call.resolve(["json": "null"])',
          ],
        ],
      },
      /^S7 .* settle's \.empty arm/,
    ],
    [
      "S7: accept settles the call itself",
      {
        plugin: [
          [
            "return .empty // accept-return",
            "call.resolve()\n            return .empty",
          ],
        ],
      },
      /^S7 acceptIdentityChange .* settles the call itself/,
    ],
    [
      "S7: Resolution has no empty case",
      { plugin: [["case empty // resolution-empty", "case none"]] },
      /^S7 enum Resolution has no `case empty`/,
    ],
    [
      "S8: the generic arm passes the request's accept",
      {
        plugin: [
          [
            PEER_DECLINE,
            'try engine.confirmPeerDowngrade(conversationId: args.string("conversationId"), accept: args.bool("accept"))',
          ],
        ],
      },
      /^S8 .* passes accept: args\.bool\("accept"\)/,
    ],
    [
      "S8: no accept guard",
      { plugin: [[PEER_GUARD, ""]] },
      /^S8 .* has no `if try args\.optionalBool/,
    ],
    [
      "S8: the guard rejects the wrong field",
      {
        plugin: [
          [
            'throw E2eeReject.invalidArgument("accept") // peer-throw',
            'throw E2eeReject.invalidArgument("name")',
          ],
        ],
      },
      /^S8 .* has no `if try args\.optionalBool/,
    ],
    [
      "S8: the guard comes after the engine call",
      {
        plugin: [
          [PEER_GUARD, ""],
          [PEER_DECLINE, `${PEER_DECLINE}\n            ${PEER_GUARD}`],
        ],
      },
      /^S8 .* confirmPeerDowngrade runs before the accept guard|^S8 .* names engine before the accept guard/,
    ],
    [
      "S8: a guard that lets an absent accept through as true",
      {
        plugin: [
          [
            'if try args.optionalBool("accept") == true { // peer-guard',
            'if try args.optionalBool("accept") != false {',
          ],
        ],
      },
      /^S8 .* has no `if try args\.optionalBool/,
    ],
    [
      "S8: the decline arm is gone",
      {
        plugin: [
          ['case "e2ee_confirm_peer_downgrade": // peer-arm', ""],
          [PEER_GUARD, ""],
          [PEER_DECLINE, ""],
          ['return "null" // peer-return', ""],
        ],
      },
      /^S8 runGeneric has 0 arms for e2ee_confirm_peer_downgrade/,
    ],
    [
      "S8: the decline arm also decides another command",
      {
        plugin: [
          [
            'case "e2ee_confirm_peer_downgrade": // peer-arm',
            'case "e2ee_confirm_peer_downgrade", "e2ee_safety_number_v2":',
          ],
        ],
      },
      /^S8 .* shares its label/,
    ],
    [
      "S9: a selector built from a string",
      {
        recovery: [
          [
            "secret.wipe() // recovery-wipe",
            'secret.wipe()\n        _ = NSSelectorFromString("markVerified:")',
          ],
        ],
      },
      /^S9 RecoverySheet\.swift:\d+ NSSelectorFromString/,
    ],
    [
      "S9: the raw FFI module",
      {
        recovery: [
          ["import UIKit", "import UIKit\nimport acutest_e2ee_iosFFI"],
        ],
      },
      /^S9 .* raw FFI module/,
    ],
    [
      "S9: a raw uniffi symbol",
      {
        recovery: [
          [
            "_ = try engine.backupStatus() // recovery-status",
            "_ = uniffi_acutest_e2ee_ios_fn_method_e2eeengine_wipe",
          ],
        ],
      },
      /^S9 .* raw uniffi symbol/,
    ],
    [
      "S9: dlsym",
      {
        plugin: [
          [
            "guard Self.armedOrReject(call) else { return } // mux-guard",
            'guard Self.armedOrReject(call) else { return }\n        _ = dlsym(nil, "x")',
          ],
        ],
      },
      /^S9 E2eePlugin\.swift:\d+ dlsym/,
    ],
    [
      "S9: key-value coding",
      {
        recovery: [
          [
            "secret.wipe() // recovery-wipe",
            'secret.wipe()\n        _ = UIAlertAction().value(forKey: "handler")',
          ],
        ],
      },
      /^S9 .* \.value\(forKey:\)/,
    ],
    [
      "S9: an engine subclass",
      {
        recovery: [
          [
            "final class SecretBox {",
            "final class Sneaky: E2eeEngine {}\n\nfinal class SecretBox {",
          ],
        ],
      },
      /^S9 .* a subclass of E2eeEngine/,
    ],
  ];
  const seen = new Set<string>();
  for (const [label, edits, expected, also] of cases) {
    const rule = ruleOf(label).replace(/:$/, "");
    seen.add(rule);
    assertOnly(
      label,
      swiftViolations(fixtureTree(edits)),
      [rule, ...(also ?? [])],
      expected,
    );
  }
  assert.deepEqual(
    [...seen].sort(),
    RULES.map(([rule]) => rule),
    "every rule has a failing mutation",
  );
});

// ---- The real files ---------------------------------------------------------

let realCache: string[] | null = null;

function realFound(rule: string): string[] {
  if (!realCache) {
    const names = readdirSync(SWIFT_DIR, { recursive: true, encoding: "utf8" })
      .filter((p) => p.endsWith(".swift"))
      .sort();
    const sources: Record<string, string> = {};
    for (const p of names) {
      const src = readFileSync(join(SWIFT_DIR, p), "utf8");
      assert.ok(src.length > 0, `scanned file is empty: ${p}`);
      sources[basename(p)] = src;
    }
    for (const needed of [PLUGIN, COMMANDS, SUPPORT]) {
      assert.ok(needed in sources, `${needed} missing from ${SWIFT_DIR}`);
    }
    const bindings = readFileSync(BINDINGS_FILE, "utf8");
    assert.ok(bindings.length > 0, `scanned file is empty: ${BINDINGS_FILE}`);
    realCache = swiftViolations(treeOf(sources, bindings));
  }
  return realCache.filter((v) => v.startsWith(`${rule} `));
}

const SWIFT_RULES: [string, string][] = [
  ["S1", "the table routes the four commands to their dedicated methods"],
  ["S2", "the generic mux never handles a dedicated command"],
  ["S3", "each gated method is @objc, armed, and calls on its own thread"],
  ["S4", "the dedicated-thread helpers start a new Thread"],
  ["S5", "gated engine calls only in their own method, on the engine"],
  ["S6", "arguments come from the call; selfUserId is required"],
  ["S7", "markVerified and acceptIdentityChange resolve {}"],
  ["S8", "the generic peer-downgrade arm only declines"],
  ["S9", "no string-name, raw-FFI or engine-extension back door"],
];

for (const [rule, title] of SWIFT_RULES) {
  test(`SlogaE2ee ${rule}: ${title} (${SWIFT_DIR})`, () => {
    assert.deepEqual(realFound(rule), []);
  });
}
