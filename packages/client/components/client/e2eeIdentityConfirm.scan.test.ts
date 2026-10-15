// Source-scan spec for the identity native confirm on Android (plan
// d6-identity-native-confirm, Design §14, §15, §17) — run with Node's
// built-in runner:
//   node --conditions=browser --test components/client/e2eeIdentityConfirm.scan.test.ts
// Neither file loads under Node (`E2eePlugin.kt` is Kotlin; `e2ee.ts` needs
// Solid, the native bridge and stoat.js), so the wiring is pinned by reading
// the sources. Point `E2EE_IDENTITY_KT` / `E2EE_IDENTITY_TS` at other copies
// (the known-bad control: the bd9baa94 files) to scan those instead; they
// must fail.
//
// The lexers and structure helpers are copied from
// e2eeGroupGrowth.scan.test.ts (it exports nothing). Comments are stripped
// before every check, and string contents only count where a literal is the
// subject of the rule, so a commented-out call or a call spelled inside a
// string never satisfies (or trips) a rule.
//
// E2eePlugin.kt (`M` = markVerified / acceptIdentityChange, `P` = the val
// holding M's preview result, `G` = the shared plugin-level guard, `O` = a
// method-local resolve-once guard):
//   I1. `@PluginMethod fun call(` has no `e2ee_mark_verified` or
//       `e2ee_accept_identity_change` anywhere in its body (no generic arm).
//   I2. Exactly one `@PluginMethod fun markVerified(call: PluginCall) { … }`
//       and one `fun acceptIdentityChange(…)`, each with a block body.
//   I3. Every reference to `markVerified` / `acceptIdentityChange` in the
//       file, other than those two definitions, is an engine commit CALL
//       inside the plugin method of the same name and inside a
//       `setPositiveButton` listener lambda (the trailing lambda, or a lambda
//       argument; NOT the label argument). Each method has at least one, and
//       neither method reads `needsPrompt` (there is no no-prompt commit).
//   I4. Each method calls its preview (`previewMarkVerified` /
//       `previewAcceptIdentityChange`) exactly once, as
//       `val P = <receiver>.preview…(`, and declares `P` nowhere else (no
//       `val` / `var` / lambda parameter shadowing it); every commit passes
//       `P.expectedIdentity`; the file holds no "expectedIdentity" string
//       literal (call data never supplies it).
//   I5. A plugin-level `val G = AtomicBoolean(…)` (declared directly in the
//       `class E2eePlugin` body) that BOTH identity methods AND both growth
//       methods (`enableGroup`, `addGroupMember`) claim with
//       `G.compareAndSet(false, true)` (unqualified) — the shared consent
//       slot — each identity method before its preview, released on every
//       path (the growth spec's K5: every settling site after the busy branch
//       is preceded in its own block by a release, or sits in a `try`, in
//       the same lambda, whose `finally` releases; `run(call) { … }` opens
//       with a release or such a `try`).
//   I6. Each method has a `setOnDismissListener` (or `OnDismissListener {`)
//       lambda holding `if (O.compareAndSet(false, true)) { … }` (a
//       method-local `val O = AtomicBoolean(false)`) whose branch rejects
//       with the `declined` literal; every positive-button commit sits in the
//       branch of the same `if (O.compareAndSet(false, true))` inside its
//       lambda, or after an `if (!O.compareAndSet(false, true))` guard clause
//       there that returns; a negative-button or cancel listener that settles
//       the call makes the same claim.
//   I7. Each method has `if (!G.compareAndSet(false, true)) { … }` whose body
//       rejects with the `busy` literal and returns.
//   I8. The decline lockout and teardown. In each method:
//         - an `if` statement after the preview, in the same block as the
//           `runOnUiThread` that builds the dialog and before it, whose whole
//           condition is a call to a plugin-level function that reads
//           `identityDeclinedUntil`, or an un-negated expression naming
//           `identityDeclinedUntil`; its body rejects with the `busy` literal
//           and returns;
//         - in the dismiss listener's `if (O.compareAndSet(false, true))`
//           branch, a statement that calls a plugin-level function writing
//           `identityDeclinedUntil`, or writes it directly (optionally inside
//           `synchronized(…) { … }`); when both the check and the note are
//           helper calls, they pass the same key;
//         - `identityDialog = <dialog>` inside that `runOnUiThread`.
//       And one `handleOnDestroy()` whose body calls
//       `identityDialog?.dismiss()` as a top-level statement.
//   I9. The input delay. In each method, a `setOnShowListener` lambda takes
//       the positive button (as in the growth spec's K9), sets
//       `filterTouchesWhenObscured = true` and `isEnabled = false` on it
//       outside any `postDelayed(`, and re-enables it in a `postDelayed(`
//       whose delay is at least 700 ms (a literal, or a `val` / `const val`
//       holding one, e.g. GROWTH_CONFIRM_DELAY_MS); and takes the negative
//       button the same ways and sets `filterTouchesWhenObscured = true` on
//       it.
// e2ee.ts:
//   T1. `CapacitorTransport.invoke` has exactly one
//       `if (command === "e2ee_mark_verified")` route calling
//       `this.#plugin.markVerified(` and one for
//       "e2ee_accept_identity_change" → `acceptIdentityChange(`; each
//       forwards `args`, returns, is not nested in another `if`, and sits
//       before the generic `#plugin.call(`.
//
// The scanners are checked against inline fixtures first (a conforming file
// passes; each mutation fails exactly its own rule), so a green scan is never
// a scanner that cannot fail.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const KT_FILE =
  process.env.E2EE_IDENTITY_KT ||
  new URL(
    "../../android/app/src/main/java/com/acutest/app/e2ee/E2eePlugin.kt",
    import.meta.url,
  );
const TS_FILE =
  process.env.E2EE_IDENTITY_TS || new URL("./e2ee.ts", import.meta.url);

const IDENTITY = [
  {
    method: "markVerified",
    preview: "previewMarkVerified",
    command: "e2ee_mark_verified",
  },
  {
    method: "acceptIdentityChange",
    preview: "previewAcceptIdentityChange",
    command: "e2ee_accept_identity_change",
  },
] as const;

/** The growth methods that share the consent slot with the identity ones. */
const GROWTH_METHODS = ["enableGroup", "addGroupMember"] as const;

const LOCKOUT_MAP = "identityDeclinedUntil";

// ---- Shared helpers ---------------------------------------------------------

interface Masked {
  /** Comments and string contents blanked. */
  code: string;
  /** Comments blanked; string contents kept. */
  text: string;
}

/** Inclusive [start, end] index range in the source. */
type Span = [number, number];

const inSpan = (spans: Span[], i: number) =>
  spans.some(([from, to]) => i >= from && i <= to);

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

/** The top-level arguments of the call whose `(` is at `open`, squashed. */
function callArgs(code: string, open: number): string[] {
  const close = matchClose(code, open);
  const out: string[] = [];
  let start = open + 1;
  for (let i = open + 1; i < close; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") i = matchClose(code, i);
    else if (c === ",") {
      out.push(code.slice(start, i));
      start = i + 1;
    }
  }
  out.push(code.slice(start, close));
  return out.map(squash).filter((a) => a !== "");
}

const typeLiteral = (word: string) =>
  new RegExp(String.raw`\\?"type\\?"\s*:\s*\\?"${word}\\?"`);
const BUSY = typeLiteral("busy");
const DECLINED = typeLiteral("declined");
const REJECT = /\breject\s*\(/;

// ---- Kotlin lexer -----------------------------------------------------------

/**
 * Blanks Kotlin comments (block comments nest) and string / char contents
 * with spaces (newlines kept), so every index is the same index in `src`.
 * `${…}` templates inside strings are scanned as code.
 */
function maskKotlin(src: string): Masked {
  const code = src.split("");
  const text = src.split("");
  const n = src.length;
  const blank = (arr: string[], i: number) => {
    if (arr[i] !== "\n") arr[i] = " ";
  };
  const blankBoth = (i: number) => {
    blank(code, i);
    blank(text, i);
  };

  /** Scans a string opening at `i`; returns the index just past it. */
  const scanString = (i: number): number => {
    const raw = src.startsWith('"""', i);
    let j = raw ? i + 3 : i + 1;
    while (j < n) {
      if (raw && src.startsWith('"""', j)) {
        while (src[j + 3] === '"') blank(code, j++);
        return j + 3;
      }
      if (!raw && src[j] === '"') return j + 1;
      if (!raw && src[j] === "\n") return j;
      if (!raw && src[j] === "\\") {
        blank(code, j++);
        blank(code, j++);
        continue;
      }
      if (src[j] === "$" && src[j + 1] === "{") {
        j = scanCode(j + 2, true) + 1;
        continue;
      }
      blank(code, j++);
    }
    return n;
  };

  /** Scans code from `start`; returns the index of an unmatched `}` or `n`. */
  const scanCode = (start: number, untilBrace: boolean): number => {
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
      if (c === "'") {
        let j = i + 1;
        if (src[j] === "\\") j += 2;
        while (j < n && src[j] !== "'" && src[j] !== "\n") j++;
        for (let k = i + 1; k < j; k++) blank(code, k);
        i = j + 1;
        continue;
      }
      if (c === "{") depth++;
      if (c === "}") {
        if (untilBrace && depth === 0) return i;
        depth--;
      }
      i++;
    }
    return n;
  };

  scanCode(0, false);
  return { code: code.join(""), text: text.join("") };
}

// ---- Kotlin structure -------------------------------------------------------

interface KtFun {
  name: string;
  /** Index of the `fun` keyword. */
  at: number;
  params: string;
  annotated: boolean;
  /** The block body's `{` and `}`; -1 for an expression or abstract body. */
  open: number;
  close: number;
  /** The `=` of an expression body; -1 otherwise. */
  expr: number;
}

const KT_DEF = /\bfun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?`?(\w+)`?\s*\(/g;

/** Every named `fun` definition in the file, local functions included. */
function ktFunctions(m: Masked): KtFun[] {
  const { code } = m;
  const out: KtFun[] = [];
  let previous = 0;
  for (const match of code.matchAll(KT_DEF)) {
    const paren = match.index + match[0].length - 1;
    const parenClose = matchClose(code, paren);
    let open = -1;
    let expr = -1;
    let depth = 0;
    for (let i = parenClose + 1; i < code.length; i++) {
      const c = code[i];
      if (c === "(" || c === "<") depth++;
      else if (c === ")" || (c === ">" && code[i - 1] !== "-")) depth--;
      else if (depth === 0 && /[=;}]/.test(c)) {
        if (c === "=") expr = i;
        break;
      } else if (depth === 0 && /^fun\b/.test(code.slice(i, i + 4))) break;
      else if (depth === 0 && c === "{") {
        open = i;
        break;
      }
    }
    // Annotations sit between the previous declaration and this `fun`.
    const before = code.slice(previous, match.index);
    const boundary = Math.max(
      before.lastIndexOf("{"),
      before.lastIndexOf("}"),
      before.lastIndexOf(";"),
    );
    out.push({
      name: match[1],
      at: match.index,
      params: code.slice(paren + 1, parenClose),
      annotated: /@PluginMethod\b/.test(before.slice(boundary + 1)),
      open,
      close: open < 0 ? -1 : matchClose(code, open),
      expr,
    });
    previous = match.index + 3;
  }
  return out;
}

/** Last index of the single-line statement starting at `k` (masked code). */
function ktStatementEnd(code: string, k: number): number {
  for (let j = k; j < code.length; j++) {
    const c = code[j];
    if (c === "(" || c === "[" || c === "{") j = matchClose(code, j);
    else if (c === "\n" || c === ";" || c === "}") return j - 1;
    else if (
      code.startsWith("else", j) &&
      !/\w/.test(code[j - 1]) &&
      !/\w/.test(code[j + 4] ?? "")
    ) {
      return j - 1;
    }
  }
  return code.length - 1;
}

function ktBranch(code: string, k: number): Span {
  return code[k] === "{"
    ? [k, matchClose(code, k)]
    : [k, ktStatementEnd(code, k)];
}

interface KtIf {
  /** Index of the `if` keyword. */
  at: number;
  /** The condition (string contents kept), whitespace removed. */
  cond: string;
  then: Span;
  otherwise: Span | null;
}

function ktIfs(m: Masked, body: Span): KtIf[] {
  const { code, text } = m;
  const out: KtIf[] = [];
  for (const match of code.matchAll(/\bif\s*\(/g)) {
    if (match.index <= body[0] || match.index >= body[1]) continue;
    const paren = match.index + match[0].length - 1;
    const condClose = matchClose(code, paren);
    const then = ktBranch(code, skipWs(code, condClose + 1));
    const after = skipWs(code, then[1] + 1);
    const hasElse =
      code.startsWith("else", after) && !/\w/.test(code[after + 4] ?? "");
    out.push({
      at: match.index,
      cond: squash(text.slice(paren + 1, condClose)),
      then,
      otherwise: hasElse ? ktBranch(code, skipWs(code, after + 4)) : null,
    });
  }
  return out;
}

/**
 * The listener lambdas passed to each `name` call inside `body`: the
 * trailing lambda and any lambda argument (`OnClickListener { … }` too),
 * but never a non-lambda argument such as the button label.
 */
function listenerLambdas(code: string, name: string, body: Span): Span[] {
  const out: Span[] = [];
  for (const match of code.matchAll(new RegExp(`\\b${name}\\b`, "g"))) {
    if (match.index <= body[0] || match.index >= body[1]) continue;
    let k = skipWs(code, match.index + name.length);
    if (code[k] === "(") {
      const close = matchClose(code, k);
      for (let i = k + 1; i < close; i++) {
        if (code[i] === "{") {
          out.push([i, matchClose(code, i)]);
          i = matchClose(code, i);
        } else if (code[i] === "(" || code[i] === "[") {
          i = matchClose(code, i);
        }
      }
      k = skipWs(code, close + 1);
    }
    if (code[k] === "{") out.push([k, matchClose(code, k)]);
  }
  return out;
}

const casOn = (name: string) =>
  new RegExp(
    String.raw`\b${name}\s*\.\s*compareAndSet\s*\(\s*false\s*,\s*true\s*\)`,
    "g",
  );
const ANY_CAS = casOn(String.raw`(\w+)`);
const ATOMIC_VAL =
  /\b(val|var)\s+(\w+)\s*(?::\s*(?:[\w.]+\.)?AtomicBoolean\s*)?=\s*(?:[\w.]+\.)?AtomicBoolean\s*\(/g;

/** Absolute index of the first `name.compareAndSet(false, true)` in `span`. */
function claimAt(code: string, name: string, span: Span): number {
  const found = casOn(name).exec(code.slice(span[0], span[1] + 1));
  return found ? span[0] + found.index : -1;
}

/** Index of the bracket opening the one at `close` (masked code), or -1. */
function matchOpen(code: string, close: number): number {
  const pairs: Record<string, string> = { ")": "(", "}": "{", "]": "[" };
  const open = pairs[code[close]];
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (code[i] === code[close]) depth++;
    else if (code[i] === open && --depth === 0) return i;
  }
  return -1;
}

/** Index of the last non-space character before `i`, or -1. */
function prevSignificant(code: string, i: number): number {
  let j = i - 1;
  while (j >= 0 && /\s/.test(code[j])) j--;
  return j;
}

/** The identifier ending at `j` (inclusive), or "". */
function wordEndingAt(code: string, j: number): string {
  let k = j;
  while (k >= 0 && /\w/.test(code[k])) k--;
  return code.slice(k + 1, j + 1);
}

interface KtBlock {
  open: number;
  close: number;
  /**
   * `scope`: a lambda or function body, which may run at another time than
   * the code around it. The rest run in line with it.
   */
  kind: "scope" | "try" | "catch" | "finally" | "control";
  parent: KtBlock | null;
}

const CONTROL_HEADS = new Set(["if", "while", "for", "when"]);

/** What the `{` at `open` (masked code) opens. */
function ktBlockKind(code: string, open: number): KtBlock["kind"] {
  const j = prevSignificant(code, open);
  if (j < 0) return "scope";
  if (/\w/.test(code[j])) {
    const word = wordEndingAt(code, j);
    if (word === "try") return "try";
    if (word === "finally") return "finally";
    return word === "else" || word === "do" ? "control" : "scope";
  }
  if (code[j] === ")") {
    const paren = matchOpen(code, j);
    const head = wordEndingAt(code, prevSignificant(code, paren));
    if (head === "catch") return "catch";
    return CONTROL_HEADS.has(head) ? "control" : "scope";
  }
  // `x -> {`: a `when` arm.
  if (code[j] === ">" && code[j - 1] === "-") return "control";
  return "scope";
}

/** Every `{…}` block in `body` (its own braces included), in source order. */
function ktBlocks(code: string, body: Span): KtBlock[] {
  const out: KtBlock[] = [];
  const stack: KtBlock[] = [];
  for (let i = body[0]; i <= body[1]; i++) {
    if (code[i] === "{") {
      const block: KtBlock = {
        open: i,
        close: matchClose(code, i),
        kind: i === body[0] ? "scope" : ktBlockKind(code, i),
        parent: stack.length ? stack[stack.length - 1] : null,
      };
      out.push(block);
      stack.push(block);
    } else if (code[i] === "}") {
      stack.pop();
    }
  }
  return out;
}

/** The innermost block strictly containing `i`, or null. */
function innermost(blocks: KtBlock[], i: number): KtBlock | null {
  let found: KtBlock | null = null;
  for (const b of blocks) if (b.open < i && i < b.close) found = b;
  return found;
}

/** The `finally { … }` of the `try {` at `tryOpen`, past any `catch`es. */
function ktFinallyOf(code: string, tryOpen: number): Span | null {
  let k = skipWs(code, matchClose(code, tryOpen) + 1);
  while (/^catch\b/.test(code.slice(k, k + 6))) {
    k = skipWs(code, k + 5);
    if (code[k] === "(") k = skipWs(code, matchClose(code, k) + 1);
    if (code[k] !== "{") return null;
    k = skipWs(code, matchClose(code, k) + 1);
  }
  if (!/^finally\b/.test(code.slice(k, k + 8))) return null;
  k = skipWs(code, k + 7);
  return code[k] === "{" ? [k, matchClose(code, k)] : null;
}

const NOT_A_STATEMENT_AFTER = new Set([
  "else",
  "do",
  "return",
  "throw",
  "in",
  "is",
  "as",
  "fun",
  "try",
  "finally",
]);

/**
 * Whether the expression at `i` starts a statement of its own: not the body
 * of a brace-less `if` / `else` / `when` arm, and not an operand.
 */
function ktStatementStart(code: string, blocks: KtBlock[], i: number): boolean {
  const j = prevSignificant(code, i);
  if (j < 0) return true;
  const c = code[j];
  if (c === "{" || c === "}" || c === ";") return true;
  if (c === ">" && code[j - 1] === "-") {
    // `{ a, b -> x()`: the first statement of a lambda, not a `when` arm.
    const b = innermost(blocks, i);
    return (
      b !== null &&
      b.kind === "scope" &&
      /^[\w\s,:<>?.]*$/.test(code.slice(b.open + 1, j - 1))
    );
  }
  if (!code.slice(j + 1, i).includes("\n")) return false;
  if (c === ")") {
    const head = wordEndingAt(code, prevSignificant(code, matchOpen(code, j)));
    return !CONTROL_HEADS.has(head) && head !== "catch";
  }
  if (/[\w"'\]]/.test(c)) {
    return !NOT_A_STATEMENT_AFTER.has(wordEndingAt(code, j));
  }
  return false;
}

const dialogButton = (which: "POSITIVE" | "NEGATIVE") =>
  String.raw`getButton\s*\(\s*(?:(?:AlertDialog|DialogInterface)\s*\.\s*)?BUTTON_${which}\s*\)`;

/** The plan's positive-button input delay, a floor. */
const CONFIRM_DELAY_FLOOR_MS = 700;

interface KtButton {
  /** Where the button is taken. */
  at: number;
  /** The name it goes by; null when it is the implicit receiver. */
  name: string | null;
  /** Where that name refers to it. */
  scope: Span;
}

/** Each `which` button taken inside `span`, and where it is in scope. */
function buttonsTaken(
  code: string,
  span: Span,
  which: "POSITIVE" | "NEGATIVE",
): KtButton[] {
  const out: KtButton[] = [];
  const inner = code.slice(span[0], span[1] + 1);
  const button = dialogButton(which);
  const bound = new RegExp(
    String.raw`\bval\s+(\w+)\s*(?::\s*[\w.?]+\s*)?=\s*(?:\w+\s*(?:\?|!!)?\s*\.\s*)?${button}`,
    "g",
  );
  for (const b of inner.matchAll(bound)) {
    out.push({ at: span[0] + b.index, name: b[1], scope: span });
  }
  const scoped = new RegExp(
    String.raw`${button}\s*(?:\?|!!)?\s*\.\s*(let|also|apply|run)\s*\{`,
    "g",
  );
  for (const s of inner.matchAll(scoped)) {
    const open = span[0] + s.index + s[0].length - 1;
    const scope: Span = [open, matchClose(code, open)];
    const param = /^\{\s*(\w+)\s*->/.exec(code.slice(open, scope[1]));
    const receiver = s[1] === "apply" || s[1] === "run";
    out.push({
      at: span[0] + s.index,
      name: receiver ? null : (param?.[1] ?? "it"),
      scope,
    });
  }
  return out;
}

/** A `postDelayed(` delay in ms: a literal, or a `val` holding one; else -1. */
function delayMs(code: string, arg: string): number {
  const literal = /^(\d[\d_]*)L?$/.exec(arg);
  if (literal) return Number(literal[1].replace(/_/g, ""));
  if (!/^\w+$/.test(arg)) return -1;
  const held = new RegExp(
    String.raw`\bval\s+${arg}\s*(?::\s*\w+\s*)?=\s*(\d[\d_]*)L?\b`,
  ).exec(code);
  return held ? Number(held[1].replace(/_/g, "")) : -1;
}

/** `button.<prop> = <value>` or `button.<setter>(<value>)`, as a RegExp. */
function buttonSets(
  button: KtButton,
  prop: string,
  setter: string,
  value: string,
): RegExp {
  const receiver =
    button.name === null
      ? String.raw`(?<![\w.?])(?:this\s*\.\s*)?`
      : String.raw`\b${button.name}\s*(?:\?|!!)?\s*\.\s*`;
  return new RegExp(
    String.raw`${receiver}(?:${prop}\s*=(?!=)\s*${value}\b|${setter}\s*\(\s*${value}\s*\))`,
    "g",
  );
}

/** Whether `button` gets `filterTouchesWhenObscured = true` in its scope. */
function touchFiltered(code: string, button: KtButton): boolean {
  return buttonSets(
    button,
    "filterTouchesWhenObscured",
    "setFilterTouchesWhenObscured",
    "true",
  ).test(code.slice(button.scope[0], button.scope[1] + 1));
}

/** What the input delay on `button` lacks; empty when it has it all. */
function delayMissing(code: string, button: KtButton): string[] {
  const sets = (prop: string, setter: string, value: string) =>
    buttonSets(button, prop, setter, value);
  const [from, to] = button.scope;
  const inner = code.slice(from, to + 1);
  const delayed: Span[] = [];
  let reEnabled = false;
  let longEnough = false;
  for (const p of inner.matchAll(/\bpostDelayed\s*\(/g)) {
    const paren = from + p.index + p[0].length - 1;
    const close = matchClose(code, paren);
    delayed.push([paren, close]);
    if (
      !sets("isEnabled", "setEnabled", "true").test(code.slice(paren, close))
    ) {
      continue;
    }
    reEnabled = true;
    const args = callArgs(code, paren);
    if (delayMs(code, args[args.length - 1] ?? "") >= CONFIRM_DELAY_FLOOR_MS) {
      longEnough = true;
    }
  }
  const outsideDelay = (re: RegExp) =>
    [...inner.matchAll(re)].some((x) => !inSpan(delayed, from + x.index));
  const missing: string[] = [];
  if (
    !outsideDelay(
      sets("filterTouchesWhenObscured", "setFilterTouchesWhenObscured", "true"),
    )
  ) {
    missing.push("filterTouchesWhenObscured = true");
  }
  if (!outsideDelay(sets("isEnabled", "setEnabled", "false"))) {
    missing.push("isEnabled = false outside postDelayed(");
  }
  if (!reEnabled) missing.push("isEnabled = true inside a postDelayed(");
  else if (!longEnough) {
    missing.push(
      `a postDelayed( delay of at least ${CONFIRM_DELAY_FLOOR_MS} ms`,
    );
  }
  return missing;
}

// ---- Kotlin rules -----------------------------------------------------------

const CAS_ON = (name: string) => `${name}.compareAndSet(false,true)`;

/** Every rule violation in `src`, each prefixed with its rule id. */
function ktViolations(src: string): string[] {
  const m = maskKotlin(src);
  const { code, text } = m;
  const out: string[] = [];
  const fail = (rule: string, message: string) =>
    out.push(`${rule} ${message}`);
  const at = (i: number) => `line ${lineOf(src, i)}`;
  const funs = ktFunctions(m);
  /** Net brace depth of the masked code in `[from, to)`. */
  const depthAt = (from: number, to: number) => {
    let depth = 0;
    for (let i = from; i < to; i++) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}") depth--;
    }
    return depth;
  };
  const names = (re: RegExp, span: Span) =>
    [...code.slice(span[0], span[1] + 1).matchAll(re)].map((x) => ({
      at: span[0] + x.index,
      match: x,
    }));

  // I1: no generic dispatcher arm.
  const dispatchers = funs.filter((f) => f.name === "call" && f.annotated);
  if (dispatchers.length !== 1 || dispatchers[0].open < 0) {
    fail(
      "I1",
      `expected one @PluginMethod fun call( with a body, found ${dispatchers.length}`,
    );
  } else {
    const [from, to] = [dispatchers[0].open, dispatchers[0].close];
    for (const g of IDENTITY) {
      const hit = text.slice(from, to + 1).indexOf(g.command);
      if (hit >= 0) {
        fail(
          "I1",
          `call() still names ${g.command} at ${at(from + hit)} (a generic dispatcher arm)`,
        );
      }
    }
  }

  // I2: the two dedicated plugin methods. One definition with a block body
  // is still scanned by the other rules when only its annotation or its
  // parameters are wrong, so those mutations fail I2 alone.
  const methods = new Map<string, KtFun>();
  for (const g of IDENTITY) {
    const defs = funs.filter((f) => f.name === g.method);
    if (defs.length !== 1 || defs[0].open < 0) {
      fail(
        "I2",
        defs.length !== 1
          ? `${g.method}: expected exactly one definition, found ${defs.length}`
          : `${g.method}: has no block body`,
      );
      for (const rule of ["I3", "I4", "I5", "I6", "I7", "I8", "I9"]) {
        fail(rule, `${g.method}: no @PluginMethod to check`);
      }
      continue;
    }
    if (!defs[0].annotated) {
      fail("I2", `${g.method}: not annotated @PluginMethod`);
    }
    if (!/^\w+:PluginCall$/.test(squash(defs[0].params))) {
      fail("I2", `${g.method}: parameters must be (call: PluginCall)`);
    }
    methods.set(g.method, defs[0]);
  }
  const ownerOf = (i: number) =>
    IDENTITY.find((g) => {
      const f = methods.get(g.method);
      return f !== undefined && i > f.open && i < f.close;
    });

  // Every markVerified / acceptIdentityChange reference that is not a
  // definition.
  const refs: { name: string; at: number }[] = [];
  for (const r of code.matchAll(/\b(markVerified|acceptIdentityChange)\b/g)) {
    let j = r.index - 1;
    if (code[j] === "`") j--;
    while (j >= 0 && /\s/.test(code[j])) j--;
    const isDef =
      code.slice(j - 2, j + 1) === "fun" && !/\w/.test(code[j - 3] ?? "");
    if (!isDef) refs.push({ name: r[1], at: r.index });
  }
  for (const r of refs) {
    const owner = ownerOf(r.at);
    if (!owner) {
      fail(
        "I3",
        `${r.name} referenced at ${at(r.at)}, outside the markVerified / acceptIdentityChange plugin methods`,
      );
    } else if (owner.method !== r.name) {
      fail("I3", `${owner.method}: references ${r.name} at ${at(r.at)}`);
    }
  }

  // I4 (file): nothing reads expectedIdentity from call data.
  const keyed = text.search(/"expectedIdentity"/);
  if (keyed >= 0) {
    fail(
      "I4",
      `the string "expectedIdentity" appears at ${at(keyed)}; it must come from the preview, never from call data`,
    );
  }

  // The plugin class: its own vals and functions (not an inner class's).
  const plugin = /\bclass\s+E2eePlugin\b[^{]*\{/.exec(code);
  const classOpen = plugin ? plugin.index + plugin[0].length - 1 : -1;
  const classClose = plugin ? matchClose(code, classOpen) : -1;
  const pluginLevel = (i: number) =>
    plugin !== null &&
    i > classOpen &&
    i < classClose &&
    depthAt(classOpen + 1, i) === 0;

  // I5 (shared): the plugin-level guard every consent method claims.
  const pluginGuards = new Set<string>();
  for (const a of code.matchAll(ATOMIC_VAL)) {
    if (a[1] === "val" && pluginLevel(a.index)) pluginGuards.add(a[2]);
  }
  const unqualified = (i: number) => {
    let j = i - 1;
    while (j >= 0 && /\s/.test(code[j])) j--;
    return code[j] !== "." || /\bthis\s*\.$/.test(code.slice(0, j + 1));
  };
  const growth: KtFun[] = [];
  for (const name of GROWTH_METHODS) {
    const defs = funs.filter(
      (f) => f.name === name && f.annotated && f.open >= 0,
    );
    if (defs.length === 1) growth.push(defs[0]);
    else {
      fail(
        "I5",
        `expected one @PluginMethod ${name}( with a body, found ${defs.length}; the consent slot cannot be shown shared with it`,
      );
    }
  }
  const claimedBy = [...methods.values(), ...growth].map(
    (f) =>
      new Set(
        [...code.slice(f.open, f.close + 1).matchAll(ANY_CAS)]
          .filter((c) => unqualified(f.open + c.index))
          .map((c) => c[1])
          .filter((name) => pluginGuards.has(name)),
      ),
  );
  const shared = claimedBy.length
    ? [...claimedBy[0]].filter((name) => claimedBy.every((s) => s.has(name)))
    : [];
  const guard = shared[0] ?? null;

  // I8 (shared): plugin-level helpers that read / write the lockout map.
  const lockoutRef = new RegExp(String.raw`\b${LOCKOUT_MAP}\b`);
  /** Indices in `span` where the lockout map is written. */
  const lockoutWrites = (span: Span): number[] => {
    const found: number[] = [];
    for (const w of names(
      new RegExp(String.raw`\b${LOCKOUT_MAP}\b`, "g"),
      span,
    )) {
      const k = skipWs(code, w.at + LOCKOUT_MAP.length);
      if (code[k] === "[") {
        const after = skipWs(code, matchClose(code, k) + 1);
        if (code[after] === "=" && code[after + 1] !== "=") found.push(w.at);
      } else if (
        /^\.\s*(?:put|set|putIfAbsent|compute|merge|getOrPut)\s*\(/.test(
          code.slice(k, k + 24),
        )
      ) {
        found.push(w.at);
      }
    }
    return found;
  };
  const funSpan = (f: KtFun): Span | null => {
    if (f.open >= 0) return [f.open, f.close];
    if (f.expr < 0) return null;
    const k = skipWs(code, f.expr + 1);
    return [k, ktStatementEnd(code, k)];
  };
  const readers = new Set<string>();
  const writers = new Set<string>();
  for (const f of funs) {
    const span = funSpan(f);
    if (!span || !pluginLevel(f.at)) continue;
    if (lockoutRef.test(code.slice(span[0], span[1] + 1))) readers.add(f.name);
    if (lockoutWrites(span).length) writers.add(f.name);
  }

  for (const g of IDENTITY) {
    const f = methods.get(g.method);
    if (!f) continue;
    const body: Span = [f.open, f.close];
    const within = (i: number) => i > f.open && i < f.close;
    const blocks = ktBlocks(code, body);
    const callName = squash(f.params).split(":")[0];

    // I4: the preview result.
    const previews = [
      ...code.matchAll(new RegExp(`\\b${g.preview}\\b`, "g")),
    ].filter((p) => within(p.index));
    let previewVal: string | null = null;
    let previewAt = -1;
    if (previews.length !== 1) {
      fail(
        "I4",
        `${g.method}: expected exactly one ${g.preview}( call, found ${previews.length}`,
      );
      // The first one still orders the claim (I5) and the lockout (I8).
      if (previews.length) previewAt = previews[0].index;
    } else {
      previewAt = previews[0].index;
      const assigned =
        /\bval\s+(\w+)\s*(?::\s*[\w.<>?]+\s*)?=\s*(?:\w+(?:\(\))?\s*\.\s*)*$/.exec(
          code.slice(f.open, previewAt),
        );
      if (assigned) previewVal = assigned[1];
      else {
        fail(
          "I4",
          `${g.method}: the ${g.preview}( result is not held in a val`,
        );
      }
    }
    if (previewVal) {
      // The commit's `P.expectedIdentity` must be the preview's: no second
      // declaration and no lambda parameter of the same name.
      const decls = names(
        new RegExp(String.raw`\b(?:val|var)\s+${previewVal}\b`, "g"),
        body,
      );
      const shadows = names(/->/g, body).filter((arrow) => {
        const b = innermost(blocks, arrow.at);
        if (!b || b.kind !== "scope") return false;
        const params = code.slice(b.open + 1, arrow.at);
        return (
          /^[\w\s,:<>?.]*$/.test(params) &&
          new RegExp(String.raw`\b${previewVal}\b`).test(params)
        );
      });
      if (decls.length !== 1 || shadows.length) {
        fail(
          "I4",
          `${g.method}: ${previewVal} is declared again at ${at((decls.length > 1 ? decls[1].at : shadows[0]?.at) ?? f.open)}; the commit may not read the preview's expectedIdentity`,
        );
      }
    }

    // I3: where the commits sit; no no-prompt branch.
    const positive = listenerLambdas(code, "setPositiveButton", body);
    const commits: number[] = [];
    for (const r of refs) {
      if (r.name !== g.method || !within(r.at)) continue;
      let k = r.at + r.name.length;
      if (code[k] === "`") k++;
      k = skipWs(code, k);
      if (code[k] !== "(") {
        fail("I3", `${g.method}: ${r.name} at ${at(r.at)} is not a call`);
        continue;
      }
      if (!inSpan(positive, r.at)) {
        fail(
          "I3",
          `${g.method}: engine ${r.name}( at ${at(r.at)} is outside a setPositiveButton listener`,
        );
        continue;
      }
      const expected = `${previewVal}.expectedIdentity`;
      const args = callArgs(code, k);
      if (
        !previewVal ||
        !args.some(
          (a) => a === expected || a === `expectedIdentity=${expected}`,
        )
      ) {
        fail(
          "I4",
          `${g.method}: the commit at ${at(r.at)} does not pass ${previewVal ?? "<preview>"}.expectedIdentity`,
        );
      }
      commits.push(r.at);
    }
    if (!commits.length) {
      fail("I3", `${g.method}: no engine commit inside setPositiveButton`);
    }
    const flag = names(/\bneedsPrompt\b/g, body);
    if (flag.length) {
      fail(
        "I3",
        `${g.method}: reads needsPrompt at ${at(flag[0].at)}; an identity confirm has no no-prompt branch`,
      );
    }

    // I7's busy branch, found first: where it ends bounds I5's exemption.
    // Found on any guard, so a missing shared guard fails I5 alone.
    const busyConds = (name: string) => [
      `!${CAS_ON(name)}`,
      `${CAS_ON(name)}==false`,
    ];
    const ifs = ktIfs(m, body);
    const busy =
      (guard && ifs.find((s) => busyConds(guard).includes(s.cond))) ||
      ifs.find((s) =>
        /^(?:![\w.()]+\.compareAndSet\(false,true\)|[\w.()]+\.compareAndSet\(false,true\)==false)$/.test(
          s.cond,
        ),
      );

    // I5: the shared consent guard, released on every path.
    if (!guard) {
      fail(
        "I5",
        `${g.method}: no plugin-level \`val … = AtomicBoolean(…)\` that both identity methods and both growth methods compareAndSet(false, true)`,
      );
    } else {
      const first = claimAt(code, guard, body);
      if (previewAt >= 0 && first > previewAt) {
        fail(
          "I5",
          `${g.method}: ${guard}.compareAndSet runs after the preview`,
        );
      }
      // A local release helper, possibly behind a per-request latch.
      const plain = `${guard}.set(false)`;
      const latches = [...code.matchAll(ATOMIC_VAL)]
        .filter(
          (a) =>
            a[1] === "val" &&
            within(a.index) &&
            /^\s*true\s*\)/.test(code.slice(a.index + a[0].length)),
        )
        .map((a) => a[2]);
      const helpers = funs
        .filter(
          (h) =>
            h.open > f.open && h.close < f.close && squash(h.params) === "",
        )
        .filter((h) => {
          const inner = squash(code.slice(h.open + 1, h.close));
          return (
            inner === plain ||
            latches.some((l) => {
              const cas = `if(${l}.compareAndSet(true,false))`;
              return inner === cas + plain || inner === `${cas}{${plain}}`;
            })
          );
        })
        .map((h) => h.name);
      const setFalse = String.raw`\b${guard}\s*\.\s*set\s*\(\s*false\s*\)`;
      const releaseRe = new RegExp(
        helpers.length
          ? String.raw`${setFalse}|\b(?:${helpers.join("|")})\s*\(\s*\)`
          : setFalse,
        "g",
      );
      const releases = [...code.slice(f.open, f.close + 1).matchAll(releaseRe)]
        .map((r) => f.open + r.index)
        .filter((i) => ktStatementStart(code, blocks, i));
      /** A release in `b` before `i`, directly or in a sibling's finally. */
      const releasedBefore = (b: KtBlock, i: number) =>
        releases.some((r) => {
          if (r <= b.open || r >= i) return false;
          const home = innermost(blocks, r);
          return (
            home === b ||
            (home !== null && home.kind === "finally" && home.parent === b)
          );
        });
      const releasesIn = (fin: Span | null) =>
        fin !== null &&
        releases.some((r) => innermost(blocks, r)?.open === fin[0]);
      /** Inside a try (or catch), in the same lambda, whose finally releases. */
      const underFinally = (i: number) => {
        for (let b = innermost(blocks, i); b && b.kind !== "scope"; ) {
          if (
            (b.kind === "try" || b.kind === "catch") &&
            releasesIn(ktFinallyOf(code, b.open))
          ) {
            return true;
          }
          b = b.parent;
        }
        return false;
      };
      // Before the busy branch ends, the guard is not this request's.
      const exemptUntil =
        busy && busyConds(guard).includes(busy.cond) ? busy.then[1] : first;
      const settles = new RegExp(
        String.raw`\b(?:${callName}\s*\.\s*(?:reject|resolve)|resolveJson|rejectScrubbed|run(?=\s*\(\s*${callName}\s*[,)]))\s*\(`,
        "g",
      );
      if (!releases.length) {
        fail(
          "I5",
          `${g.method}: never releases ${guard} (${plain}, or a local release helper)`,
        );
      } else {
        for (const s of code.slice(f.open, f.close + 1).matchAll(settles)) {
          const i = f.open + s.index;
          if (i <= exemptUntil) continue;
          const what = squash(s[0]);
          if (what === "run(") {
            // `run(call) { … }` rejects when its body throws, so the body
            // must release before anything in it can throw.
            const paren = i + s[0].length - 1;
            const close = matchClose(code, paren);
            let lambda = skipWs(code, close + 1);
            if (code[lambda] !== "{") {
              lambda = -1;
              for (let k = paren + 1; k < close; k++) {
                if (code[k] === "{") {
                  lambda = k;
                  k = matchClose(code, k);
                } else if (code[k] === "(" || code[k] === "[") {
                  k = matchClose(code, k);
                }
              }
            }
            let opens = false;
            if (lambda >= 0) {
              const start = skipWs(code, lambda + 1);
              const tried =
                /^(?:(?:val|var)\s+\w+\s*(?::\s*[\w.<>?]+\s*)?=\s*)?try\s*\{/.exec(
                  code.slice(start, matchClose(code, lambda)),
                );
              opens =
                releases.includes(start) ||
                (tried !== null &&
                  releasesIn(ktFinallyOf(code, start + tried[0].length - 1)));
            }
            if (!opens) {
              fail(
                "I5",
                `${g.method}: run(${callName}) at ${at(i)} rejects if its body throws, and the body does not open with a release of ${guard} or a try whose finally releases it`,
              );
            }
            continue;
          }
          const home = innermost(blocks, i);
          if (!(home && releasedBefore(home, i)) && !underFinally(i)) {
            fail(
              "I5",
              `${g.method}: ${what} at ${at(i)} settles the call without releasing ${guard} first (a release earlier in its own block, or an enclosing try in the same lambda whose finally releases)`,
            );
          }
        }
      }
    }

    // I6: decline on dismiss, resolved once.
    const locals: string[] = [];
    for (const a of code.matchAll(ATOMIC_VAL)) {
      if (a[1] === "val" && within(a.index) && !pluginGuards.has(a[2])) {
        locals.push(a[2]);
      }
    }
    const dismiss = [
      ...listenerLambdas(code, "setOnDismissListener", body),
      ...listenerLambdas(code, "OnDismissListener", body),
    ];
    /** The `if (o.compareAndSet(false, true))` statements in `span`. */
    const claims = (o: string, span: Span) =>
      ktIfs(m, span).filter((s) => s.cond === CAS_ON(o));
    const rejectsDeclined = (s: Span) =>
      REJECT.test(code.slice(s[0], s[1] + 1)) &&
      DECLINED.test(text.slice(s[0], s[1] + 1));
    const once = locals.find((o) =>
      dismiss.some((s) => claims(o, s).some((c) => rejectsDeclined(c.then))),
    );
    if (!dismiss.length) {
      fail("I6", `${g.method}: no setOnDismissListener in its body`);
    } else if (!once) {
      fail(
        "I6",
        `${g.method}: no OnDismissListener whose \`if (<local AtomicBoolean>.compareAndSet(false, true))\` branch rejects declined`,
      );
    } else {
      for (const commit of commits) {
        const lambda = positive.find((s) => inSpan([s], commit));
        if (!lambda) continue;
        const inBranch = claims(once, lambda).some((c) =>
          inSpan([c.then], commit),
        );
        const guarded = ktIfs(m, lambda).some(
          (c) =>
            busyConds(once).includes(c.cond) &&
            c.then[1] < commit &&
            innermost(blocks, c.at)?.open === lambda[0] &&
            ktStatementStart(code, blocks, c.at) &&
            /\breturn\b/.test(code.slice(c.then[0], c.then[1] + 1)),
        );
        if (!inBranch && !guarded) {
          fail(
            "I6",
            `${g.method}: the positive-button commit at ${at(commit)} is not behind ${once}.compareAndSet(false, true)`,
          );
        }
      }
      for (const name of ["setNegativeButton", "setOnCancelListener"]) {
        for (const s of listenerLambdas(code, name, body)) {
          const settles = /\b(?:reject|resolve\w*)\s*\(/.test(
            code.slice(s[0], s[1] + 1),
          );
          if (settles && claimAt(code, once, s) < 0) {
            fail(
              "I6",
              `${g.method}: ${name} at ${at(s[0])} settles the call without ${once}.compareAndSet(false, true)`,
            );
          }
        }
      }
    }

    // I7: busy when the guard is taken.
    const rejectsBusy = ([from, to]: Span) =>
      REJECT.test(code.slice(from, to + 1)) &&
      BUSY.test(text.slice(from, to + 1)) &&
      /\breturn\b/.test(code.slice(from, to + 1));
    if (!busy) {
      fail(
        "I7",
        `${g.method}: no \`if (!<guard>.compareAndSet(false, true))\` busy branch`,
      );
    } else if (!rejectsBusy(busy.then)) {
      fail(
        "I7",
        `${g.method}: the taken-guard branch must reject {"type":"busy"} and return`,
      );
    }

    // I8: the decline lockout, and a dialog teardown can reach.
    const host = listenerLambdas(code, "runOnUiThread", body).find((s) =>
      positive.some((p) => inSpan([s], p[0])),
    );
    if (!host) {
      fail(
        "I8",
        `${g.method}: the setPositiveButton dialog is not built inside a runOnUiThread lambda`,
      );
    } else {
      const tracked = names(/\bidentityDialog\s*=(?!=)\s*(\w+)/g, host).some(
        (t) => t.match[1] !== "null",
      );
      if (!tracked) {
        fail(
          "I8",
          `${g.method}: never records its dialog in identityDialog inside runOnUiThread (handleOnDestroy could not dismiss it)`,
        );
      }
    }
    /** The lockout key a check reads, "" when not a helper call; or null. */
    const lockoutKey = (s: KtIf): string | null => {
      const paren = code.indexOf("(", s.at);
      const condClose = matchClose(code, paren);
      const start = skipWs(code, paren + 1);
      const helper = /^(\w+)\s*\(/.exec(code.slice(start, condClose));
      if (helper && readers.has(helper[1])) {
        const open = start + helper[0].length - 1;
        const close = matchClose(code, open);
        if (skipWs(code, close + 1) === condClose) {
          return squash(text.slice(open + 1, close));
        }
      }
      const cond = squash(code.slice(paren + 1, condClose));
      const direct = new RegExp(
        String.raw`\b${LOCKOUT_MAP}(?:\[|\.(?:containsKey|get|getOrDefault)\()`,
      );
      return !cond.startsWith("!") && direct.test(cond) ? "" : null;
    };
    const lockouts = ifs
      .map((s) => ({ s, key: lockoutKey(s) }))
      .filter((l) => l.key !== null);
    const lockout = lockouts.find(
      ({ s }) =>
        host !== undefined &&
        previewAt >= 0 &&
        s.at > previewAt &&
        s.at < host[0] &&
        innermost(blocks, s.at) === innermost(blocks, host[0]) &&
        ktStatementStart(code, blocks, s.at),
    );
    if (!lockouts.length) {
      fail(
        "I8",
        `${g.method}: no lockout check (\`if\` on a plugin-level function reading ${LOCKOUT_MAP}, or on ${LOCKOUT_MAP} itself)`,
      );
    } else if (!lockout) {
      fail(
        "I8",
        `${g.method}: the lockout check at ${at(lockouts[0].s.at)} is not a statement after the preview, in the block of the dialog's runOnUiThread and before it`,
      );
    } else if (!rejectsBusy(lockout.s.then)) {
      fail(
        "I8",
        `${g.method}: the lockout branch must reject {"type":"busy"} and return`,
      );
    }
    /** If `b` is the lambda of `synchronized(…) {`, where that call starts. */
    const syncHead = (b: KtBlock): number => {
      const j = prevSignificant(code, b.open);
      if (code[j] !== ")") return -1;
      const h = prevSignificant(code, matchOpen(code, j));
      return wordEndingAt(code, h) === "synchronized"
        ? h - "synchronized".length + 1
        : -1;
    };
    /** `k` is a statement of `branch`, maybe inside `synchronized { }`. */
    const directlyIn = (k: number, branch: Span): boolean => {
      let i = k;
      for (let hops = 0; hops < 4; hops++) {
        if (code[branch[0]] !== "{" && i === branch[0]) return true;
        if (!ktStatementStart(code, blocks, i)) return false;
        const b = innermost(blocks, i);
        if (!b) return false;
        if (code[branch[0]] === "{" && b.open === branch[0]) return true;
        const head = syncHead(b);
        if (head < 0) return false;
        i = head;
      }
      return false;
    };
    const notes: { at: number; key: string }[] = [];
    for (const s of dismiss) {
      for (const o of locals) {
        for (const c of claims(o, s)) {
          for (const w of writers) {
            for (const n of names(
              new RegExp(String.raw`\b${w}\s*\(`, "g"),
              c.then,
            )) {
              const open = n.at + n.match[0].length - 1;
              if (directlyIn(n.at, c.then)) {
                notes.push({
                  at: n.at,
                  key: squash(text.slice(open + 1, matchClose(code, open))),
                });
              }
            }
          }
          for (const k of lockoutWrites(c.then)) {
            if (directlyIn(k, c.then)) notes.push({ at: k, key: "" });
          }
        }
      }
    }
    if (!notes.length) {
      fail(
        "I8",
        `${g.method}: the dismiss listener's resolve-once branch does not note the decline in ${LOCKOUT_MAP} (a statement calling a plugin-level function that writes it, or writing it)`,
      );
    } else if (
      lockout?.key &&
      notes.every((n) => n.key !== "" && n.key !== lockout.key)
    ) {
      fail(
        "I8",
        `${g.method}: the lockout check reads key ${lockout.key} but the decline is noted under ${notes[0].key}`,
      );
    }

    // I9: the positive button is input-delayed; both buttons touch-filtered.
    const shows = [
      ...listenerLambdas(code, "setOnShowListener", body),
      ...listenerLambdas(code, "OnShowListener", body),
    ];
    const confirms = shows
      .flatMap((s) => buttonsTaken(code, s, "POSITIVE"))
      .map((b) => ({ b, missing: delayMissing(code, b) }));
    const cancels = shows.flatMap((s) => buttonsTaken(code, s, "NEGATIVE"));
    if (!shows.length) {
      fail("I9", `${g.method}: no setOnShowListener`);
    } else {
      if (!confirms.length) {
        fail(
          "I9",
          `${g.method}: no setOnShowListener that takes getButton(AlertDialog.BUTTON_POSITIVE)`,
        );
      } else if (confirms.every((r) => r.missing.length)) {
        fail(
          "I9",
          `${g.method}: the positive button taken at ${at(confirms[0].b.at)} lacks ${confirms[0].missing.join("; ")}`,
        );
      }
      if (!cancels.length) {
        fail(
          "I9",
          `${g.method}: no setOnShowListener that takes getButton(AlertDialog.BUTTON_NEGATIVE)`,
        );
      } else if (!cancels.some((b) => touchFiltered(code, b))) {
        fail(
          "I9",
          `${g.method}: the negative button taken at ${at(cancels[0].at)} lacks filterTouchesWhenObscured = true`,
        );
      }
    }
  }

  // I8 (file): activity teardown dismisses the open identity dialog.
  const destroy = funs.filter(
    (f) => f.name === "handleOnDestroy" && f.open >= 0,
  );
  if (destroy.length !== 1) {
    fail(
      "I8",
      `expected one handleOnDestroy() with a body, found ${destroy.length}`,
    );
  } else {
    const d = destroy[0];
    const own = ktBlocks(code, [d.open, d.close]);
    const dismissed = names(
      /\bidentityDialog\s*(?:\?|!!)?\s*\.\s*dismiss\s*\(\s*\)/g,
      [d.open, d.close],
    ).some(
      (x) =>
        innermost(own, x.at)?.open === d.open &&
        ktStatementStart(code, own, x.at),
    );
    if (!dismissed) {
      fail("I8", "handleOnDestroy() does not dismiss identityDialog");
    }
  }
  return out;
}

// ---- TypeScript lexer (as in e2eeGroupSendGate.scan.test.ts) ---------------

const REGEX_KEYWORDS = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "void",
  "delete",
  "throw",
  "new",
  "yield",
  "await",
  "instanceof",
]);

/**
 * Blanks comments and literal contents with spaces (newlines kept), so every
 * index in the result is the same index in `src`.
 */
function maskTs(src: string): Masked {
  const code = src.split("");
  const text = src.split("");
  const n = src.length;
  const blank = (arr: string[], i: number) => {
    if (arr[i] !== "\n") arr[i] = " ";
  };

  const prevSignificant = (i: number): number => {
    let j = i - 1;
    while (j >= 0 && /\s/.test(code[j])) j--;
    return j;
  };

  const regexAllowed = (i: number): boolean => {
    const j = prevSignificant(i);
    if (j < 0) return true;
    const c = code[j];
    if (/[\w$]/.test(c)) {
      let k = j;
      while (k >= 0 && /[\w$]/.test(code[k])) k--;
      return REGEX_KEYWORDS.has(code.slice(k + 1, j + 1).join(""));
    }
    return !/[)\]"'`]/.test(c);
  };

  /** Scans code from `i`; returns the index of an unmatched `}` or `n`. */
  const scanCode = (start: number, untilBrace: boolean): number => {
    let i = start;
    let depth = 0;
    while (i < n) {
      const c = src[i];
      const next = src[i + 1];
      if (c === "/" && next === "/") {
        while (i < n && src[i] !== "\n") {
          blank(code, i);
          blank(text, i);
          i++;
        }
        continue;
      }
      if (c === "/" && next === "*") {
        const end = src.indexOf("*/", i + 2);
        const stop = end < 0 ? n : end + 2;
        for (; i < stop; i++) {
          blank(code, i);
          blank(text, i);
        }
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n && src[j] !== c && src[j] !== "\n") {
          if (src[j] === "\\") blank(code, j++);
          blank(code, j++);
        }
        i = j + 1;
        continue;
      }
      if (c === "`") {
        let j = i + 1;
        while (j < n && src[j] !== "`") {
          if (src[j] === "\\") {
            blank(code, j++);
            blank(code, j++);
          } else if (src[j] === "$" && src[j + 1] === "{") {
            j = scanCode(j + 2, true) + 1;
          } else {
            blank(code, j++);
          }
        }
        i = j + 1;
        continue;
      }
      if (c === "/" && regexAllowed(i)) {
        let j = i + 1;
        let inClass = false;
        while (j < n && src[j] !== "\n") {
          if (src[j] === "\\") {
            j += 2;
            continue;
          }
          if (src[j] === "[") inClass = true;
          else if (src[j] === "]") inClass = false;
          else if (src[j] === "/" && !inClass) break;
          j++;
        }
        if (j < n && src[j] === "/") {
          for (let k = i + 1; k < j; k++) blank(code, k);
          i = j + 1;
          while (i < n && /[a-z]/.test(src[i])) i++;
          continue;
        }
      }
      if (c === "{") depth++;
      if (c === "}") {
        if (untilBrace && depth === 0) return i;
        depth--;
      }
      i++;
    }
    return n;
  };

  scanCode(0, false);
  return { code: code.join(""), text: text.join("") };
}

// ---- TypeScript structure ---------------------------------------------------

/**
 * The `{…}` body of every method DEFINITION named `name` starting inside
 * `[from, to)`: a line of optional modifiers, `async`, `name`, optional type
 * parameters, `(`, then a `{` body (a call site or a signature is not one).
 */
function tsMethods(
  m: Masked,
  name: string,
  from = 0,
  to = m.code.length,
): Span[] {
  const { code } = m;
  const head = new RegExp(
    String.raw`^[ \t]*(?:(?:public|private|protected|static|override)\s+)*` +
      String.raw`(?:async\s+)?${name}\s*(?:<[^>(){};]*>)?\s*\(`,
    "gm",
  );
  const out: Span[] = [];
  for (const match of code.matchAll(head)) {
    if (match.index < from || match.index >= to) continue;
    let i = matchClose(code, match.index + match[0].length - 1) + 1;
    let depth = 0;
    let open = -1;
    // Walk the return type to the body: `<`/`(`/`[` nest; `=>` is not a `>`.
    for (; i < code.length; i++) {
      const c = code[i];
      if (c === "(" || c === "[" || c === "<") depth++;
      else if (c === ")" || c === "]") depth--;
      else if (c === ">" && code[i - 1] !== "=") depth--;
      else if (c === ";" && depth === 0) break;
      else if (c === "{") {
        if (depth === 0) {
          open = i;
          break;
        }
        i = matchClose(code, i);
      }
    }
    if (open >= 0) out.push([open, matchClose(code, open)]);
  }
  return out;
}

/** End of the statement starting at `i` (masked code): its `;` or `}`. */
function tsStatementEnd(code: string, i: number): number {
  for (let j = i; j < code.length; j++) {
    const c = code[j];
    if (c === "(" || c === "[" || c === "{") j = matchClose(code, j);
    else if (c === ";" || c === "}") return j;
  }
  return code.length;
}

interface TsIf {
  /** The condition (string contents kept), whitespace removed. */
  cond: string;
  /** Where the condition sits. */
  at: Span;
  then: Span;
}

/** Each `if` in a body: its condition and consequent. */
function tsIfs(m: Masked, body: Span): TsIf[] {
  const { code, text } = m;
  const out: TsIf[] = [];
  for (const match of code.matchAll(/\bif\s*\(/g)) {
    if (match.index <= body[0] || match.index >= body[1]) continue;
    const paren = match.index + match[0].length - 1;
    const condClose = matchClose(code, paren);
    const k = skipWs(code, condClose + 1);
    const end = code[k] === "{" ? matchClose(code, k) : tsStatementEnd(code, k);
    out.push({
      cond: squash(text.slice(paren + 1, condClose)),
      at: [paren + 1, condClose - 1],
      then: [k, end],
    });
  }
  return out;
}

// ---- TypeScript rules -------------------------------------------------------

/** Every rule violation in `src`, each prefixed with its rule id. */
function tsViolations(src: string): string[] {
  const m = maskTs(src);
  const { code } = m;
  const out: string[] = [];
  const fail = (rule: string, message: string) =>
    out.push(`${rule} ${message}`);

  // T1: the Capacitor routes.
  const classes = [...code.matchAll(/\bclass\s+CapacitorTransport\b/g)];
  let invoke: Span[] = [];
  if (classes.length === 1) {
    const open = code.indexOf("{", classes[0].index);
    invoke = tsMethods(m, "invoke", open, matchClose(code, open));
  }
  if (classes.length !== 1) {
    fail(
      "T1",
      `expected one class CapacitorTransport, found ${classes.length}`,
    );
    return out;
  }
  if (invoke.length !== 1) {
    fail(
      "T1",
      `CapacitorTransport: expected one invoke( definition, found ${invoke.length}`,
    );
    return out;
  }
  const body = invoke[0];
  const generic = code
    .slice(body[0], body[1] + 1)
    .search(/#plugin\s*\.\s*call\s*\(/);
  const ifs = tsIfs(m, body);
  for (const g of IDENTITY) {
    const isRoute = new RegExp(
      `^(?:command===?(["'\`])${g.command}\\1|(["'\`])${g.command}\\2===?command)$`,
    );
    const routes = ifs.filter((s) => isRoute.test(s.cond));
    if (routes.length !== 1) {
      fail(
        "T1",
        `${g.command}: expected one \`if (command === "${g.command}")\` route in CapacitorTransport.invoke, found ${routes.length}`,
      );
      continue;
    }
    const route = routes[0];
    if (ifs.some((o) => o !== route && inSpan([o.then], route.at[0]))) {
      fail("T1", `${g.command}: the route is nested inside another if`);
    }
    const then = code.slice(route.then[0], route.then[1] + 1);
    const call = new RegExp(`#plugin\\s*\\.\\s*${g.method}\\s*\\(`).exec(then);
    if (!call) {
      fail(
        "T1",
        `${g.command}: the route does not call this.#plugin.${g.method}(`,
      );
    } else {
      const paren = route.then[0] + call.index + call[0].length - 1;
      const arg = code.slice(paren + 1, matchClose(code, paren));
      const forwards =
        /\.\.\.\s*\(?\s*args\b/.test(arg) ||
        (/\bargs\b/.test(arg) && !arg.replace(/\{\s*\}/g, "").includes("{"));
      if (!forwards) {
        fail(
          "T1",
          `${g.command}: #plugin.${g.method}( does not forward args (peerUserId, deviceId, selfUserId, displayName)`,
        );
      }
    }
    if (!/\breturn\b/.test(then)) {
      fail("T1", `${g.command}: the route does not return`);
    }
    if (generic < 0) {
      fail("T1", "CapacitorTransport.invoke has no generic #plugin.call(");
    } else if (route.at[0] > body[0] + generic) {
      fail(
        "T1",
        `${g.command}: the route sits after the generic #plugin.call(`,
      );
    }
  }
  return out;
}

// ---- Fixtures: the scanners themselves must be able to fail -----------------

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

/** A conforming plugin; trailing comments only make swap targets unique. */
const KT_FIXTURE = `
package com.acutest.app.e2ee

import java.util.concurrent.atomic.AtomicBoolean

private const val GROWTH_CONFIRM_DELAY_MS: Long = 700L

private const val IDENTITY_DECLINE_LOCKOUT_MS: Long = 30_000L

@CapacitorPlugin(name = "E2ee")
class E2eePlugin : Plugin() {
    private val executor: ExecutorService = Executors.newCachedThreadPool()

    /** One consent dialog at a time: growth and identity share it. */
    private val consentInFlight = AtomicBoolean(false)

    private val growthDeclinedUntil = HashMap<String, Long>()

    private val identityDeclinedUntil = HashMap<String, Long>()

    private var growthDialog: AlertDialog? = null

    private var identityDialog: AlertDialog? = null

    private fun engine() = E2eeNative.engine(context)

    private fun growthLockedOut(conversationId: String): Boolean =
        synchronized(growthDeclinedUntil) { growthDeclinedUntil.containsKey(conversationId) }

    private fun noteGrowthDecline(conversationId: String) {
        synchronized(growthDeclinedUntil) { growthDeclinedUntil[conversationId] = 1L }
    }

    /** Whether [key] is inside its decline lockout. Prunes lapsed entries. */
    private fun identityLockedOut(key: String): Boolean =
        synchronized(identityDeclinedUntil) {
            val now = SystemClock.elapsedRealtime()
            identityDeclinedUntil.values.removeAll { until -> now >= until }
            identityDeclinedUntil.containsKey(key)
        }

    private fun noteIdentityDecline(key: String) {
        synchronized(identityDeclinedUntil) {
            identityDeclinedUntil[key] = SystemClock.elapsedRealtime() + IDENTITY_DECLINE_LOCKOUT_MS
        }
    }

    private fun run(call: PluginCall, body: () -> Unit) {
        executor.execute {
            try {
                body()
            } catch (error: Throwable) {
                rejectScrubbed(call, error)
            }
        }
    }

    @PluginMethod
    fun call(call: PluginCall) {
        val name = call.getString("__cmd") ?: return
        run(call) {
            val engine = engine()
            when (name) {
                "e2ee_status" -> resolveJson(call, engine.status())
                // "e2ee_mark_verified" -> engine.markVerified(a, b, c)
                /* "e2ee_accept_identity_change" ->
                   engine.acceptIdentityChange(a, b, c) /* nested */ */
                "e2ee_note" -> Log.d("E2ee", "markVerified(x) \${'}'}")
                else -> call.reject("{\\"type\\":\\"invalid_argument\\"}")
            }
        }
    }

    @PluginMethod
    fun enableGroup(call: PluginCall) {
        if (!consentInFlight.compareAndSet(false, true)) { // enable-busy
            call.reject("{\\"type\\":\\"busy\\"}")
            return
        }
        consentInFlight.set(false)
        call.resolve()
    }

    @PluginMethod
    fun addGroupMember(call: PluginCall) {
        if (!consentInFlight.compareAndSet(false, true)) { // add-busy
            call.reject("{\\"type\\":\\"busy\\"}")
            return
        }
        consentInFlight.set(false)
        call.resolve()
    }

    @PluginMethod
    fun markVerified(call: PluginCall) {
        val peerUserId = call.getString("peerUserId") ?: run {
            call.reject("{\\"type\\":\\"invalid_argument\\",\\"field\\":\\"peerUserId\\"}")
            return
        }
        val deviceId = requireString(call, "deviceId")
        val selfUserId = requireString(call, "selfUserId")
        val displayName = call.getString("displayName") // verify-name
        if (!consentInFlight.compareAndSet(false, true)) { // verify-busy
            call.reject("{\\"type\\":\\"busy\\"}") // verify-busy-reject
            return // verify-busy-return
        }
        val held = AtomicBoolean(true)
        fun release() {
            if (held.compareAndSet(true, false)) consentInFlight.set(false) // verify-release-helper
        }
        try {
            executor.execute {
                try {
                    val prompt = engine().previewMarkVerified(peerUserId, deviceId, selfUserId, displayName) // verify-preview
                    if (prompt.alreadyVerified) { // verify-already
                        release()
                        call.resolve()
                        return@execute
                    }
                    if (identityLockedOut("verify:$peerUserId")) { // verify-lockout
                        release() // verify-lockout-release
                        call.reject("{\\"type\\":\\"busy\\"}") // verify-lockout-busy
                        return@execute
                    }
                    activity.runOnUiThread { // verify-ui
                        val settled = AtomicBoolean(false)
                        try {
                            val dialog = AlertDialog.Builder(activity)
                                .setTitle(prompt.title)
                                .setMessage("\${prompt.message} {")
                                .setPositiveButton(prompt.confirmLabel) { _, _ -> // verify-positive
                                    if (settled.compareAndSet(false, true)) { // verify-positive-claim
                                        try {
                                            run(call) { // verify-run
                                                try {
                                                    engine().markVerified(peerUserId, deviceId, prompt.expectedIdentity) // verify-commit
                                                } finally {
                                                    release()
                                                }
                                                call.resolve()
                                            }
                                        } catch (error: Throwable) {
                                            release()
                                            rejectScrubbed(call, error)
                                        }
                                    }
                                }
                                .setNegativeButton(prompt.cancelLabel, null) // verify-negative
                                .create()
                            dialog.setOnDismissListener { // verify-dismiss
                                if (identityDialog === dialog) identityDialog = null
                                if (settled.compareAndSet(false, true)) { // verify-dismiss-claim
                                    noteIdentityDecline("verify:$peerUserId") // verify-note
                                    release() // verify-dismiss-release
                                    call.reject("{\\"type\\":\\"declined\\"}") // verify-declined
                                }
                            }
                            dialog.setOnShowListener { // verify-show
                                dialog.getButton(AlertDialog.BUTTON_POSITIVE)?.let { confirm -> // verify-button
                                    confirm.isEnabled = false // verify-disable
                                    confirm.filterTouchesWhenObscured = true // verify-filter
                                    confirm.postDelayed({ confirm.isEnabled = true }, GROWTH_CONFIRM_DELAY_MS) // verify-delay
                                }
                                dialog.getButton(AlertDialog.BUTTON_NEGATIVE)?.let { cancel -> // verify-cancel-button
                                    cancel.filterTouchesWhenObscured = true // verify-cancel-filter
                                    cancel.requestFocus()
                                }
                            }
                            dialog.show()
                            identityDialog = dialog // verify-track
                        } catch (error: Throwable) {
                            if (settled.compareAndSet(false, true)) {
                                release()
                                rejectScrubbed(call, error)
                            }
                        }
                    } // verify-ui-end
                } catch (error: Throwable) {
                    release()
                    rejectScrubbed(call, error)
                }
            }
        } catch (error: Throwable) {
            release()
            rejectScrubbed(call, error)
        }
    }

    @PluginMethod
    fun acceptIdentityChange(call: PluginCall) {
        val peerUserId = requireString(call, "peerUserId")
        val deviceId = requireString(call, "deviceId")
        val selfUserId = requireString(call, "selfUserId")
        val displayName = call.getString("displayName") // accept-name
        if (!consentInFlight.compareAndSet(false, true)) { // accept-busy
            call.reject("{\\"type\\":\\"busy\\"}")
            return
        }
        executor.execute {
            try {
                val preview: IdentityPrompt = engine().previewAcceptIdentityChange(peerUserId, deviceId, selfUserId, displayName)
                if (synchronized(identityDeclinedUntil) { identityDeclinedUntil.containsKey("accept:$peerUserId") }) { // accept-lockout
                    consentInFlight.set(false)
                    call.reject("{\\"type\\":\\"busy\\"}") // accept-lockout-busy
                    return@execute
                }
                activity.runOnUiThread {
                    val answered = AtomicBoolean(false)
                    val dialog = AlertDialog.Builder(activity)
                        .setMessage(preview.message)
                        .setPositiveButton(preview.confirmLabel, DialogInterface.OnClickListener { _, _ -> // accept-positive
                            if (!answered.compareAndSet(false, true)) return@OnClickListener // accept-positive-claim
                            run(call) { // accept-run
                                val done = try {
                                    engine().acceptIdentityChange(peerUserId, deviceId, expectedIdentity = preview.expectedIdentity) // accept-commit
                                } finally {
                                    consentInFlight.set(false)
                                }
                                call.resolve(JSObject())
                            }
                        })
                        .setNegativeButton(preview.cancelLabel, null)
                        .setOnCancelListener { // accept-cancel
                            if (answered.compareAndSet(false, true)) { // accept-cancel-claim
                                noteIdentityDecline("accept:$peerUserId")
                                consentInFlight.set(false) // accept-cancel-release
                                call.reject("{\\"type\\":\\"declined\\"}")
                            }
                        }
                        .setOnDismissListener(DialogInterface.OnDismissListener { // accept-dismiss
                            identityDialog = null
                            if (answered.compareAndSet(false, true)) { // accept-dismiss-claim
                                synchronized(identityDeclinedUntil) { // accept-note
                                    identityDeclinedUntil["accept:$peerUserId"] = SystemClock.elapsedRealtime() + IDENTITY_DECLINE_LOCKOUT_MS // accept-note-write
                                }
                                consentInFlight.set(false)
                                call.reject("{\\"type\\":\\"declined\\"}") // accept-declined
                            }
                        })
                        .create()
                    dialog.setOnShowListener {
                        dialog.getButton(AlertDialog.BUTTON_POSITIVE)?.apply { // accept-button
                            filterTouchesWhenObscured = true // accept-filter
                            isEnabled = false // accept-disable
                            postDelayed({ isEnabled = true }, GROWTH_CONFIRM_DELAY_MS) // accept-delay
                        }
                        val keep = dialog.getButton(DialogInterface.BUTTON_NEGATIVE) // accept-cancel-button
                        keep.setFilterTouchesWhenObscured(true) // accept-cancel-filter
                    }
                    dialog.show()
                    identityDialog = dialog // accept-track
                }
            } catch (error: Throwable) {
                consentInFlight.set(false)
                rejectScrubbed(call, error)
            }
        }
    }

    override fun handleOnDestroy() {
        growthDialog?.dismiss()
        growthDialog = null
        identityDialog?.dismiss() // destroy-dismiss
        identityDialog = null
        super.handleOnDestroy()
    }
}
`;

const ktFixture = (...swaps: [string, string][]) => swapped(KT_FIXTURE, swaps);

/** The verify lockout block, as one swap target. */
const VERIFY_LOCKOUT = `if (identityLockedOut("verify:$peerUserId")) { // verify-lockout
                        release() // verify-lockout-release
                        call.reject("{\\"type\\":\\"busy\\"}") // verify-lockout-busy
                        return@execute
                    }`;

/** The verify busy branch, as one swap target. */
const VERIFY_BUSY = `if (!consentInFlight.compareAndSet(false, true)) { // verify-busy
            call.reject("{\\"type\\":\\"busy\\"}") // verify-busy-reject
            return // verify-busy-return
        }`;

test("kotlin scanner: a conforming fixture has no violations", () => {
  assert.deepEqual(ktViolations(ktFixture()), []);
});

test("kotlin scanner: equivalent shapes still conform", () => {
  const variants: [string, string][][] = [
    // I7: the `== false` spelling of the busy claim.
    [
      [
        "if (!consentInFlight.compareAndSet(false, true)) { // accept-busy",
        "if (consentInFlight.compareAndSet(false, true) == false) {",
      ],
    ],
    // I8: a lockout key held in a val, used by the check and the note.
    [
      [
        "val prompt = engine().previewMarkVerified(peerUserId, deviceId, selfUserId, displayName) // verify-preview",
        'val prompt = engine().previewMarkVerified(peerUserId, deviceId, selfUserId, displayName)\n                    val key = "verify:$peerUserId"',
      ],
      [
        'if (identityLockedOut("verify:$peerUserId")) { // verify-lockout',
        "if (identityLockedOut(key)) {",
      ],
      [
        'noteIdentityDecline("verify:$peerUserId") // verify-note',
        "noteIdentityDecline(key)",
      ],
    ],
    // I6: a guard clause instead of a claim branch in the verify confirm.
    [
      [
        "if (settled.compareAndSet(false, true)) { // verify-positive-claim",
        "if (!settled.compareAndSet(false, true)) return@setPositiveButton\n                                    run {",
      ],
    ],
    // I9: a named val for the cancel button; the setter spelling.
    [
      [
        "dialog.getButton(AlertDialog.BUTTON_NEGATIVE)?.let { cancel -> // verify-cancel-button",
        "val cancel = dialog.getButton(AlertDialog.BUTTON_NEGATIVE)\n                                run {",
      ],
      [
        "cancel.filterTouchesWhenObscured = true // verify-cancel-filter",
        "cancel.setFilterTouchesWhenObscured(true)",
      ],
    ],
    // I5: a direct release in place of the helper on the dismiss path.
    [["release() // verify-dismiss-release", "consentInFlight.set(false)"]],
  ];
  for (const swaps of variants) {
    assert.deepEqual(ktViolations(ktFixture(...swaps)), [], swaps[0][1]);
  }
});

test("kotlin scanner: each rule fires on its own violation, and only it", () => {
  // [label (its rule first), swaps, expected violation, other rules allowed]
  const cases: [string, [string, string][], RegExp, string[]?][] = [
    [
      "I1: a generic verify arm is back",
      [
        [
          '"e2ee_status" ->',
          '"e2ee_mark_verified" -> resolveJson(call, "null")\n"e2ee_status" ->',
        ],
      ],
      /^I1 call\(\) still names e2ee_mark_verified/,
    ],
    [
      "I1: a generic accept arm is back",
      [
        [
          '"e2ee_status" ->',
          '"e2ee_accept_identity_change" -> call.reject("x")\n"e2ee_status" ->',
        ],
      ],
      /^I1 call\(\) still names e2ee_accept_identity_change/,
    ],
    [
      "I1: a generic arm that commits (also outside the methods)",
      [
        [
          '"e2ee_status" ->',
          '"e2ee_mark_verified" -> engine.markVerified(a, b, c)\n"e2ee_status" ->',
        ],
      ],
      /^I1 call\(\) still names e2ee_mark_verified/,
      ["I3"],
    ],
    [
      "I2: markVerified is not a @PluginMethod",
      [["@PluginMethod\n    fun markVerified(", "fun markVerified("]],
      /^I2 markVerified: not annotated @PluginMethod/,
    ],
    [
      "I2: acceptIdentityChange takes other parameters",
      [
        [
          "fun acceptIdentityChange(call: PluginCall)",
          "fun acceptIdentityChange(call: PluginCall, peer: String)",
        ],
      ],
      /^I2 acceptIdentityChange: parameters must be \(call: PluginCall\)/,
    ],
    [
      "I2: acceptIdentityChange renamed (nothing left to scan)",
      [
        [
          "fun acceptIdentityChange(call: PluginCall)",
          "fun acceptIdentity(call: PluginCall)",
        ],
      ],
      /^I2 acceptIdentityChange: expected exactly one definition, found 0/,
      ["I3", "I4", "I5", "I6", "I7", "I8", "I9"],
    ],
    [
      "I3: a commit in the button LABEL argument runs at build time",
      [
        [
          ".setPositiveButton(prompt.confirmLabel) { _, _ -> // verify-positive",
          ".setPositiveButton(engine().markVerified(peerUserId, deviceId, prompt.expectedIdentity).toString()) { _, _ ->",
        ],
      ],
      /^I3 markVerified: engine markVerified\( at line \d+ is outside a setPositiveButton listener/,
    ],
    [
      "I3: a commit with no dialog on alreadyVerified",
      [
        [
          "if (prompt.alreadyVerified) { // verify-already",
          "if (prompt.alreadyVerified) {\nengine().markVerified(peerUserId, deviceId, prompt.expectedIdentity)",
        ],
      ],
      /^I3 markVerified: engine markVerified\( at line \d+ is outside/,
    ],
    [
      "I3: a no-prompt flag is read",
      [
        [
          "if (prompt.alreadyVerified) { // verify-already",
          "if (prompt.alreadyVerified || !prompt.needsPrompt) {",
        ],
      ],
      /^I3 markVerified: reads needsPrompt/,
    ],
    [
      "I3: a commit helper outside the plugin methods",
      [
        [
          "private fun engine() =",
          "private fun commit(p: IdentityPrompt) = engine().acceptIdentityChange(a, b, p.expectedIdentity)\n    private fun engine() =",
        ],
      ],
      /^I3 acceptIdentityChange referenced at line \d+, outside/,
    ],
    [
      "I3: the verify confirm commits the other transition",
      [
        [
          "engine().markVerified(peerUserId, deviceId, prompt.expectedIdentity) // verify-commit",
          "engine().acceptIdentityChange(peerUserId, deviceId, prompt.expectedIdentity)",
        ],
      ],
      /^I3 markVerified: references acceptIdentityChange/,
    ],
    [
      "I3: a commented-out commit does not count",
      [
        [
          "engine().markVerified(peerUserId, deviceId, prompt.expectedIdentity) // verify-commit",
          "// engine().markVerified(peerUserId, deviceId, prompt.expectedIdentity)\ncall.hashCode()",
        ],
      ],
      /^I3 markVerified: no engine commit inside setPositiveButton/,
    ],
    [
      "I4: expectedIdentity taken from call data",
      [
        [
          "prompt.expectedIdentity) // verify-commit",
          'call.getString("expectedIdentity")!!)',
        ],
      ],
      /^I4 markVerified: the commit at line \d+ does not pass prompt\.expectedIdentity/,
    ],
    [
      "I4: the expectedIdentity key read anywhere",
      [
        [
          'val displayName = call.getString("displayName") // accept-name',
          'val displayName = call.getString("displayName")\n        val forged = call.getString("expectedIdentity")',
        ],
      ],
      /^I4 the string "expectedIdentity" appears/,
    ],
    [
      "I4: a second preview",
      [
        [
          "if (prompt.alreadyVerified) { // verify-already",
          "engine().previewMarkVerified(peerUserId, deviceId, selfUserId, null)\nif (prompt.alreadyVerified) {",
        ],
      ],
      /^I4 markVerified: expected exactly one previewMarkVerified\( call, found 2/,
    ],
    [
      "I4: the preview not held in a val",
      [
        [
          "val preview: IdentityPrompt = engine().previewAcceptIdentityChange(",
          "val preview: IdentityPrompt = checkNotNull(engine().previewAcceptIdentityChange(",
        ],
        [
          "selfUserId, displayName)\n                if (synchronized",
          "selfUserId, displayName))\n                if (synchronized",
        ],
      ],
      /^I4 acceptIdentityChange: the previewAcceptIdentityChange\( result is not held in a val/,
    ],
    [
      "I4: the commit passes another value's expectedIdentity",
      [
        [
          "prompt.expectedIdentity) // verify-commit",
          "other.expectedIdentity)",
        ],
      ],
      /^I4 markVerified: the commit at line \d+ does not pass prompt\.expectedIdentity/,
    ],
    [
      "I4: the preview val shadowed before the commit",
      [
        [
          "if (settled.compareAndSet(false, true)) { // verify-positive-claim",
          "if (settled.compareAndSet(false, true)) {\nval prompt = forgedPrompt(call)",
        ],
      ],
      /^I4 markVerified: prompt is declared again/,
    ],
    [
      "I4: the preview val shadowed by a lambda parameter",
      [
        [
          ".setPositiveButton(prompt.confirmLabel) { _, _ -> // verify-positive",
          ".setPositiveButton(prompt.confirmLabel) { _, prompt ->",
        ],
      ],
      /^I4 markVerified: prompt is declared again/,
    ],
    [
      "I5: growth claims a different guard (the slot is not shared)",
      [
        [
          "private val consentInFlight = AtomicBoolean(false)",
          "private val consentInFlight = AtomicBoolean(false)\n    private val growthInFlight = AtomicBoolean(false)",
        ],
        [
          "if (!consentInFlight.compareAndSet(false, true)) { // add-busy",
          "if (!growthInFlight.compareAndSet(false, true)) {",
        ],
      ],
      /^I5 markVerified: no plugin-level/,
    ],
    [
      "I5: accept claims its own guard",
      [
        [
          "private val consentInFlight = AtomicBoolean(false)",
          "private val consentInFlight = AtomicBoolean(false)\n    private val identityInFlight = AtomicBoolean(false)",
        ],
        [
          "if (!consentInFlight.compareAndSet(false, true)) { // accept-busy",
          "if (!identityInFlight.compareAndSet(false, true)) {",
        ],
      ],
      /^I5 acceptIdentityChange: no plugin-level/,
    ],
    [
      "I5: a reassignable guard is not a plugin-level val",
      [
        [
          "private val consentInFlight = AtomicBoolean(false)",
          "private var consentInFlight = AtomicBoolean(false)",
        ],
      ],
      /^I5 markVerified: no plugin-level/,
    ],
    [
      "I5: a qualified receiver may be a fresh guard per call",
      [
        [
          "if (!consentInFlight.compareAndSet(false, true)) { // verify-busy",
          "if (!Holder().consentInFlight.compareAndSet(false, true)) {",
        ],
      ],
      /^I5 markVerified: no plugin-level/,
    ],
    [
      "I5: a growth method is gone, so sharing cannot be shown",
      [
        [
          "fun addGroupMember(call: PluginCall)",
          "fun addMember(call: PluginCall)",
        ],
      ],
      /^I5 expected one @PluginMethod addGroupMember\(/,
    ],
    [
      "I5: the guard claimed after the preview",
      [
        [VERIFY_BUSY, ""],
        [
          "// verify-preview",
          '\nif (!consentInFlight.compareAndSet(false, true)) {\ncall.reject("{\\"type\\":\\"busy\\"}")\nreturn@execute\n}',
        ],
      ],
      /^I5 markVerified: consentInFlight\.compareAndSet runs after the preview/,
    ],
    [
      "I5: the lockout path settles without releasing",
      [["release() // verify-lockout-release", ""]],
      /^I5 markVerified: call\.reject\( at line \d+ settles the call without releasing consentInFlight/,
    ],
    [
      "I5: the dismiss path settles without releasing",
      [["release() // verify-dismiss-release", ""]],
      /^I5 markVerified: call\.reject\( at line \d+ settles the call without releasing/,
    ],
    [
      "I5: the cancel path settles without releasing",
      [["consentInFlight.set(false) // accept-cancel-release", ""]],
      /^I5 acceptIdentityChange: call\.reject\( at line \d+ settles the call without releasing/,
    ],
    [
      "I5: a release after the settle does not count",
      [
        ["release() // verify-dismiss-release", ""],
        [
          'call.reject("{\\"type\\":\\"declined\\"}") // verify-declined',
          'call.reject("{\\"type\\":\\"declined\\"}")\nrelease()',
        ],
      ],
      /^I5 markVerified: call\.reject\( at line \d+ settles the call without releasing/,
    ],
    [
      "I5: a release under a condition does not count",
      [
        [
          "release() // verify-dismiss-release",
          "if (displayName != null) release()",
        ],
      ],
      /^I5 markVerified: call\.reject\( at line \d+ settles the call without releasing/,
    ],
    [
      "I5: a release helper that does not release",
      [
        [
          "if (held.compareAndSet(true, false)) consentInFlight.set(false) // verify-release-helper",
          'if (held.compareAndSet(true, false)) Log.d("E2ee", "released")',
        ],
      ],
      /^I5 markVerified: never releases consentInFlight/,
    ],
    [
      "I5: a run(call) body that can throw before it releases",
      [
        [
          "run(call) { // accept-run",
          "run(call) {\nval warm = engine().status()",
        ],
      ],
      /^I5 acceptIdentityChange: run\(call\) at line \d+ rejects if its body throws/,
    ],
    [
      "I6: the dismiss branch rejects the wrong type",
      [
        [
          'call.reject("{\\"type\\":\\"declined\\"}") // verify-declined',
          'call.reject("{\\"type\\":\\"busy\\"}")',
        ],
      ],
      /^I6 markVerified: no OnDismissListener whose/,
    ],
    [
      "I6: the confirmed commit is not behind the once guard",
      [
        [
          "if (settled.compareAndSet(false, true)) { // verify-positive-claim",
          "if (true) {",
        ],
      ],
      /^I6 markVerified: the positive-button commit at line \d+ is not behind settled/,
    ],
    [
      "I6: a claim that does not guard the commit",
      [
        [
          "if (settled.compareAndSet(false, true)) { // verify-positive-claim",
          "settled.compareAndSet(false, true)\n                                    run {",
        ],
      ],
      /^I6 markVerified: the positive-button commit at line \d+ is not behind settled/,
    ],
    [
      "I6: a guard clause that does not return",
      [
        [
          "if (!answered.compareAndSet(false, true)) return@OnClickListener // accept-positive-claim",
          'if (!answered.compareAndSet(false, true)) Log.d("E2ee", "again")',
        ],
      ],
      /^I6 acceptIdentityChange: the positive-button commit at line \d+ is not behind answered/,
    ],
    [
      "I6: a cancel listener that settles without the once guard",
      [
        [
          "if (answered.compareAndSet(false, true)) { // accept-cancel-claim",
          "if (true) {",
        ],
      ],
      /^I6 acceptIdentityChange: setOnCancelListener at line \d+ settles the call/,
    ],
    [
      "I6: no dismiss listener (nothing to note the decline in either)",
      [
        [
          "dialog.setOnDismissListener { // verify-dismiss",
          "dialog.setOnKeyListener {",
        ],
      ],
      /^I6 markVerified: no setOnDismissListener/,
      ["I8"],
    ],
    [
      "I7: a taken guard rejects the wrong type",
      [
        [
          'call.reject("{\\"type\\":\\"busy\\"}") // verify-busy-reject',
          'call.reject("{\\"type\\":\\"declined\\"}")',
        ],
      ],
      /^I7 markVerified: the taken-guard branch must reject/,
    ],
    [
      "I7: a taken guard falls through to the preview",
      [["return // verify-busy-return", ""]],
      /^I7 markVerified: the taken-guard branch must reject/,
    ],
    [
      "I8: the lockout check is gone",
      [
        [
          'if (identityLockedOut("verify:$peerUserId")) { // verify-lockout',
          'if (displayName == "") {',
        ],
      ],
      /^I8 markVerified: no lockout check/,
    ],
    [
      "I8: the lockout check negated",
      [
        [
          'if (identityLockedOut("verify:$peerUserId")) { // verify-lockout',
          'if (!identityLockedOut("verify:$peerUserId")) {',
        ],
      ],
      /^I8 markVerified: no lockout check/,
    ],
    [
      "I8: the lockout reads the growth map",
      [
        [
          'if (identityLockedOut("verify:$peerUserId")) { // verify-lockout',
          'if (growthLockedOut("verify:$peerUserId")) {',
        ],
      ],
      /^I8 markVerified: no lockout check/,
    ],
    [
      "I8: the lockout check after runOnUiThread",
      [
        [
          'if (identityLockedOut("verify:$peerUserId")) { // verify-lockout',
          'if (displayName == "") {',
        ],
        [
          "} // verify-ui-end",
          '}\nif (identityLockedOut("verify:$peerUserId")) {\nrelease()\ncall.reject("{\\"type\\":\\"busy\\"}")\nreturn@execute\n}',
        ],
      ],
      /^I8 markVerified: the lockout check at line \d+ is not a statement after the preview/,
    ],
    [
      "I8: the lockout check before the preview",
      [
        [VERIFY_LOCKOUT, ""],
        [
          "val prompt = engine()",
          'if (identityLockedOut("verify:$peerUserId")) {\nrelease()\ncall.reject("{\\"type\\":\\"busy\\"}")\nreturn@execute\n}\nval prompt = engine()',
        ],
      ],
      /^I8 markVerified: the lockout check at line \d+ is not a statement after the preview/,
    ],
    [
      "I8: the lockout check behind another condition",
      [
        [
          "if (synchronized(identityDeclinedUntil) {",
          "if (displayName == null) if (synchronized(identityDeclinedUntil) {",
        ],
      ],
      /^I8 acceptIdentityChange: the lockout check at line \d+ is not a statement/,
    ],
    [
      "I8: a lockout that rejects the wrong type",
      [
        [
          'call.reject("{\\"type\\":\\"busy\\"}") // accept-lockout-busy',
          'call.reject("{\\"type\\":\\"declined\\"}")',
        ],
      ],
      /^I8 acceptIdentityChange: the lockout branch must reject/,
    ],
    [
      "I8: a dismiss that does not start the lockout",
      [['noteIdentityDecline("verify:$peerUserId") // verify-note', ""]],
      /^I8 markVerified: the dismiss listener's resolve-once branch does not note the decline/,
    ],
    [
      "I8: the decline noted under another key",
      [
        [
          'noteIdentityDecline("verify:$peerUserId") // verify-note',
          'noteIdentityDecline("accept:$peerUserId")',
        ],
      ],
      /^I8 markVerified: the lockout check reads key "verify:\$peerUserId" but the decline is noted under "accept:\$peerUserId"/,
    ],
    [
      "I8: the decline noted in the growth map",
      [
        [
          'noteIdentityDecline("verify:$peerUserId") // verify-note',
          'noteGrowthDecline("verify:$peerUserId")',
        ],
      ],
      /^I8 markVerified: the dismiss listener's resolve-once branch does not note/,
    ],
    [
      "I8: a decline noted outside the resolve-once branch",
      [
        ['noteIdentityDecline("verify:$peerUserId") // verify-note', ""],
        [
          "dialog.setOnDismissListener { // verify-dismiss",
          'dialog.setOnDismissListener {\nnoteIdentityDecline("verify:$peerUserId")',
        ],
      ],
      /^I8 markVerified: the dismiss listener's resolve-once branch does not note/,
    ],
    [
      "I8: a direct decline note removed",
      [
        [
          'identityDeclinedUntil["accept:$peerUserId"] = SystemClock.elapsedRealtime() + IDENTITY_DECLINE_LOCKOUT_MS // accept-note-write',
          'Log.d("E2ee", "declined")',
        ],
      ],
      /^I8 acceptIdentityChange: the dismiss listener's resolve-once branch does not note/,
    ],
    [
      "I8: the dialog is never recorded for teardown",
      [["identityDialog = dialog // verify-track", ""]],
      /^I8 markVerified: never records its dialog in identityDialog/,
    ],
    [
      "I8: the dialog recorded in the growth slot",
      [["identityDialog = dialog // accept-track", "growthDialog = dialog"]],
      /^I8 acceptIdentityChange: never records its dialog in identityDialog/,
    ],
    [
      "I8: teardown does not dismiss the dialog",
      [["identityDialog?.dismiss() // destroy-dismiss", ""]],
      /^I8 handleOnDestroy\(\) does not dismiss identityDialog/,
    ],
    [
      "I8: no teardown hook",
      [["override fun handleOnDestroy()", "override fun handleOnPause()"]],
      /^I8 expected one handleOnDestroy\(\) with a body, found 0/,
    ],
    [
      "I9: no touch filter on Confirm",
      [["confirm.filterTouchesWhenObscured = true // verify-filter", ""]],
      /^I9 markVerified: the positive button taken at line \d+ lacks filterTouchesWhenObscured = true/,
    ],
    [
      "I9: no touch filter on Cancel",
      [["cancel.filterTouchesWhenObscured = true // verify-cancel-filter", ""]],
      /^I9 markVerified: the negative button taken at line \d+ lacks filterTouchesWhenObscured = true/,
    ],
    [
      "I9: the Cancel touch filter switched off",
      [
        [
          "keep.setFilterTouchesWhenObscured(true) // accept-cancel-filter",
          "keep.setFilterTouchesWhenObscured(false)",
        ],
      ],
      /^I9 acceptIdentityChange: the negative button taken at line \d+ lacks filterTouchesWhenObscured = true/,
    ],
    [
      "I9: the Cancel button never taken",
      [
        [
          "val keep = dialog.getButton(DialogInterface.BUTTON_NEGATIVE) // accept-cancel-button",
          "val keep = dialog.currentFocus",
        ],
      ],
      /^I9 acceptIdentityChange: no setOnShowListener that takes getButton\(AlertDialog\.BUTTON_NEGATIVE\)/,
    ],
    [
      "I9: the Confirm touch filter switched off",
      [
        [
          "filterTouchesWhenObscured = true // accept-filter",
          "filterTouchesWhenObscured = false",
        ],
      ],
      /^I9 acceptIdentityChange: .* lacks filterTouchesWhenObscured = true/,
    ],
    [
      "I9: the button is never disabled",
      [["confirm.isEnabled = false // verify-disable", ""]],
      /^I9 markVerified: .* lacks isEnabled = false outside postDelayed\(/,
    ],
    [
      "I9: re-enabled at once, no delay",
      [
        [
          "confirm.postDelayed({ confirm.isEnabled = true }, GROWTH_CONFIRM_DELAY_MS) // verify-delay",
          "confirm.isEnabled = true",
        ],
      ],
      /^I9 markVerified: .* lacks isEnabled = true inside a postDelayed\(/,
    ],
    [
      "I9: a literal delay under the floor",
      [["GROWTH_CONFIRM_DELAY_MS) // accept-delay", "100L)"]],
      /^I9 acceptIdentityChange: .* lacks a postDelayed\( delay of at least 700 ms/,
    ],
    [
      "I9: the shared delay constant under the floor",
      [
        [
          "private const val GROWTH_CONFIRM_DELAY_MS: Long = 700L",
          "private const val GROWTH_CONFIRM_DELAY_MS: Long = 0L",
        ],
      ],
      /^I9 markVerified: .* lacks a postDelayed\( delay of at least 700 ms/,
    ],
    [
      "I9: no show listener",
      [
        [
          "dialog.setOnShowListener { // verify-show",
          "dialog.setOnKeyListener {",
        ],
      ],
      /^I9 markVerified: no setOnShowListener$/,
    ],
  ];
  const covered = new Set<string>();
  for (const [label, swaps, expected, also] of cases) {
    const rule = label.split(":")[0];
    if (!also) covered.add(rule);
    assertOnly(
      label,
      ktViolations(ktFixture(...swaps)),
      [rule, ...(also ?? [])],
      expected,
    );
  }
  // Every rule has at least one mutation that fails it and nothing else.
  assert.deepEqual([...covered].sort(), [
    "I1",
    "I2",
    "I3",
    "I4",
    "I5",
    "I6",
    "I7",
    "I8",
    "I9",
  ]);
});

const TS_FIXTURE = `
class CapacitorTransport implements NativeTransport {
  #plugin = registerPlugin<E2eeCapacitorPlugin>("E2ee");

  async invoke<T>(
    command: string,
    args?: Record<string, unknown> | Uint8Array,
  ): Promise<T> {
    try {
      if (command === "e2ee_wipe") {
        await this.#plugin.wipe();
        return undefined as T;
      }
      // if (command === "e2ee_mark_verified") in a comment is not a route
      if (command === "e2ee_mark_verified") {
        await this.#plugin.markVerified(
          (args as Record<string, unknown>) ?? {},
        );
        return undefined as T;
      }
      if ("e2ee_accept_identity_change" === command) {
        await this.#plugin.acceptIdentityChange({
          ...(args as Record<string, unknown>),
        });
        return undefined as T; // accept-return
      }
      const pattern = /[{]+"}/;
      const { json } = await this.#plugin.call({ __cmd: command, ...args });
      return JSON.parse(json) as T;
    } catch (error) {
      this.#rethrow(error);
    }
  }
}

class E2EEClient {
  async markVerified(userId: string, deviceId: string) {
    return this.#invoke("e2ee_mark_verified", { peerUserId: userId, deviceId });
  }
}
`;

const tsFixture = (...swaps: [string, string][]) => swapped(TS_FIXTURE, swaps);

test("ts scanner: a conforming fixture has no violations", () => {
  assert.deepEqual(tsViolations(tsFixture()), []);
});

test("ts scanner: each violation fires", () => {
  const cases: [string, [string, string][], RegExp][] = [
    [
      "no verify route",
      [
        [
          'if (command === "e2ee_mark_verified") {',
          'if (command === "e2ee_mark_verifieds") {',
        ],
      ],
      /^T1 e2ee_mark_verified: expected one .* found 0/,
    ],
    [
      "two accept routes",
      [
        [
          "const pattern =",
          'if ("e2ee_accept_identity_change" === command) {\n        return await this.#plugin.acceptIdentityChange(args);\n      }\n      const pattern =',
        ],
      ],
      /^T1 e2ee_accept_identity_change: expected one .* found 2/,
    ],
    [
      "the route calls the generic method",
      [["this.#plugin.markVerified(", "this.#plugin.call("]],
      /^T1 e2ee_mark_verified: the route does not call this\.#plugin\.markVerified\(/,
    ],
    [
      "the route rebuilds args",
      [
        [
          "acceptIdentityChange({\n          ...(args as Record<string, unknown>),\n        });",
          'acceptIdentityChange({ peerUserId: "x" });',
        ],
      ],
      /^T1 e2ee_accept_identity_change: #plugin\.acceptIdentityChange\( does not forward args/,
    ],
    [
      "a widened route condition",
      [
        [
          'if ("e2ee_accept_identity_change" === command) {',
          'if ("e2ee_accept_identity_change" === command && fast) {',
        ],
      ],
      /^T1 e2ee_accept_identity_change: expected one .* found 0/,
    ],
    [
      "a route nested inside another if",
      [
        [
          'if (command === "e2ee_mark_verified") {',
          'if (legacy) {\n      if (command === "e2ee_mark_verified") {',
        ],
        [
          '      }\n      if ("e2ee_accept_identity_change" === command) {',
          '      }\n      }\n      if ("e2ee_accept_identity_change" === command) {',
        ],
      ],
      /^T1 e2ee_mark_verified: the route is nested inside another if/,
    ],
    [
      "a route that falls through to the generic call",
      [["return undefined as T; // accept-return", ""]],
      /^T1 e2ee_accept_identity_change: the route does not return/,
    ],
    [
      "a route after the generic call",
      [
        [
          'if (command === "e2ee_mark_verified") {',
          'if (command === "e2ee_wipe_all") {',
        ],
        [
          "return JSON.parse(json) as T;\n    } catch",
          'if (command === "e2ee_mark_verified") {\n        await this.#plugin.markVerified(args);\n        return undefined as T;\n      }\n      return JSON.parse(json) as T;\n    } catch',
        ],
      ],
      /^T1 e2ee_mark_verified: the route sits after the generic #plugin\.call\(/,
    ],
  ];
  for (const [label, swaps, expected] of cases) {
    assertOnly(label, tsViolations(tsFixture(...swaps)), ["T1"], expected);
  }
});

// ---- The real files ---------------------------------------------------------

let ktCache: string[] | null = null;
let tsCache: string[] | null = null;

function ktFound(rule: string): string[] {
  if (!ktCache) {
    const src = readFileSync(KT_FILE, "utf8");
    assert.ok(src.length > 0, `scanned file is empty: ${String(KT_FILE)}`);
    ktCache = ktViolations(src);
  }
  return ktCache.filter((v) => v.startsWith(`${rule} `));
}

function tsFound(rule: string): string[] {
  if (!tsCache) {
    const src = readFileSync(TS_FILE, "utf8");
    assert.ok(src.length > 0, `scanned file is empty: ${String(TS_FILE)}`);
    tsCache = tsViolations(src);
  }
  return tsCache.filter((v) => v.startsWith(`${rule} `));
}

const KT_RULES: [string, string][] = [
  ["I1", "call() has no e2ee_mark_verified / e2ee_accept_identity_change arm"],
  ["I2", "@PluginMethod markVerified and acceptIdentityChange exist"],
  ["I3", "engine commits only in the same-named method's setPositiveButton"],
  ["I4", "expectedIdentity comes from the one preview result"],
  [
    "I5",
    "the shared consent AtomicBoolean is claimed first and released on every path",
  ],
  ["I6", "an OnDismissListener rejects declined behind a resolve-once guard"],
  ["I7", "a taken guard rejects busy"],
  ["I8", "the decline lockout is checked and noted; teardown dismisses"],
  ["I9", "Confirm is input-delayed; both buttons are touch-filtered"],
];

for (const [rule, title] of KT_RULES) {
  test(`E2eePlugin.kt ${rule}: ${title} (${String(KT_FILE)})`, () => {
    assert.deepEqual(ktFound(rule), []);
  });
}

test(`e2ee.ts T1: CapacitorTransport routes both commands to their plugin methods (${String(TS_FILE)})`, () => {
  assert.deepEqual(tsFound("T1"), []);
});
