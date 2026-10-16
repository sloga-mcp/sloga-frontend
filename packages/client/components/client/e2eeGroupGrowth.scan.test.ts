// Source-scan spec for the group-growth native confirm on Android (plan
// group-growth-native-confirm, Design §9, §10, §12) — run with Node's
// built-in runner:
//   node --conditions=browser --test components/client/e2eeGroupGrowth.scan.test.ts
// Neither file loads under Node (`E2eePlugin.kt` is Kotlin; `e2ee.ts` needs
// Solid, the native bridge and stoat.js), so the wiring is pinned by reading
// the sources. Point `E2EE_GROWTH_KT` / `E2EE_GROWTH_TS` at other copies (the
// known-bad control: the 5060cd40 files) to scan those instead; they must
// fail.
//
// Comments are stripped before every check, and string contents only count
// where a literal is the subject of the rule, so a commented-out call or a
// call spelled inside a string never satisfies (or trips) a rule.
//
// E2eePlugin.kt (`P` = the val holding the preview result, `G` = the
// plugin-level guard, `O` = a method-local resolve-once guard):
//   K1. `@PluginMethod fun call(` has no `e2ee_enable_group` or
//       `e2ee_add_group_member` anywhere in its body (no generic arm).
//   K2. Exactly one `@PluginMethod fun enableGroup(call: PluginCall) { … }`
//       and one `fun addGroupMember(…)`, each with a block body.
//   K3. Every reference to `enableGroup` / `addGroupMember` in the file,
//       other than those two definitions, is an engine commit CALL inside the
//       plugin method of the same name, and inside either
//         - a `setPositiveButton` listener lambda (the trailing lambda, or a
//           lambda argument; NOT the label argument), passing `true` as its
//           `prompted` argument, or
//         - the no-dialog branch: the body of `if (!P.needsPrompt)` /
//           `if (P.needsPrompt == false)`, or the `else` of
//           `if (P.needsPrompt)`, passing `false`.
//       Each method has at least one commit of each kind. Only a user's tap
//       confirms: the file neither calls nor references
//       (`View::performClick`) any of `performClick`, `callOnClick`,
//       `performLongClick`, `performContextClick`,
//       `performAccessibilityAction`, `dispatchTouchEvent`,
//       `dispatchKeyEvent`, `dispatchGenericMotionEvent`, `onTouchEvent`,
//       `onKeyDown`, `onKeyUp`. And the file uses no reflection
//       (`getMethod(`, `getDeclaredMethod(`, `.javaClass.methods`,
//       `::class.java.methods`, `.methods.first`, `KFunction`, `callBy(`, and
//       kin; see REFLECTION): a method looked up by a string name escapes
//       every rule here, since string contents are masked.
//   K4. Each method calls its preview (`previewGroupEnable` /
//       `previewGroupAdd`) exactly once, as `val P = <receiver>.preview…(`;
//       every commit passes `P.expectedAfter` as an argument; the file holds
//       no "expectedAfter" string literal (call data never supplies it).
//   K5. A plugin-level `val G = AtomicBoolean(…)` (declared directly in the
//       `class E2eePlugin` body, not in a function or an inner class) on
//       which BOTH methods call `G.compareAndSet(false, true)` (unqualified)
//       before their preview, and that every path releases. A release is a
//       statement (not under an `if`, `else`, `when` arm or operator) that is
//       `G.set(false)`, or a call to a no-argument function local to the
//       method whose whole body is `G.set(false)` or
//       `if (H.compareAndSet(true, false)) G.set(false)` (`H` = a
//       method-local `val H = AtomicBoolean(true)`). Every settling site after
//       the busy branch (`call.reject(` / `call.resolve(` / `resolveJson(` /
//       `rejectScrubbed(`) is preceded in its own block by a release (or by a
//       `try` whose `finally` releases), or sits inside a `try`, in the same
//       lambda, whose `finally` releases. The plugin's `run(call) { … }`,
//       which rejects when its body throws, must open its body with a release
//       or with a `try` whose `finally` releases. Settling sites before the
//       busy branch ends (argument checks, the busy reject) are exempt: the
//       guard is not held there.
//   K6. Each method has a `setOnDismissListener` (or `OnDismissListener {`)
//       lambda that claims a method-local `val O = AtomicBoolean(false)`
//       with `O.compareAndSet(false, true)` and rejects with the `declined`
//       literal; every positive-button commit is preceded by the same claim
//       inside its lambda; a negative-button or cancel listener that settles
//       the call (reject / resolve) makes the same claim.
//   K7. Each method has `if (!G.compareAndSet(false, true)) { … }` whose body
//       rejects with the `busy` literal and returns.
//   K8. The decline lockout and teardown. In each method, with `C` = the val
//       holding the "conversationId" argument:
//         - an `if (growthLockedOut(C))` statement after the preview, outside
//           the no-prompt branch, in the same block as the `runOnUiThread`
//           that builds the dialog and before it, whose body rejects with the
//           `busy` literal and returns;
//         - a dismiss listener whose `if (O.compareAndSet(false, true))`
//           branch calls `noteGrowthDecline(C)` as a statement;
//         - `growthDialog = <dialog>` inside that `runOnUiThread`.
//       And one `handleOnDestroy()` whose body calls `growthDialog?.dismiss()`
//       as a top-level statement.
//   K9. The input delay. In each method, a `setOnShowListener` lambda takes
//       the positive button, as `val B = ….getButton(AlertDialog.BUTTON_POSITIVE)`
//       or `….getButton(AlertDialog.BUTTON_POSITIVE)?.let { B -> … }` (`also`
//       and `it` too; or `apply` / `run`, the button as receiver), and on it
//       sets `filterTouchesWhenObscured = true` and `isEnabled = false`
//       outside any `postDelayed(`, and calls a `postDelayed(` whose
//       arguments set `isEnabled = true` and whose delay is at least 700 ms
//       (a literal, or a `val` / `const val` holding one or naming another;
//       no arithmetic). In each method, every `isEnabled = …` /
//       `setEnabled(…)` whose value is not the literal `false` sits inside
//       a `postDelayed(` (its arguments or its trailing lambda) whose delay
//       is at least 700 ms, and no function defined elsewhere in the file
//       that enables a view outside one is called: nothing enables the
//       button early. File-wide, such an enable may sit only in a function
//       that neither method nor code outside every function body names,
//       directly or through other functions (`reachableEnables`): never in
//       a stored lambda or a property accessor.
// e2ee.ts:
//   T8. `CapacitorTransport.invoke` has exactly one
//       `if (command === "e2ee_enable_group")` route calling
//       `this.#plugin.enableGroup(` and one for "e2ee_add_group_member" →
//       `addGroupMember(`; each forwards `args` (or spells `displayNames`),
//       returns, is not nested in another `if`, and sits before the generic
//       `#plugin.call(`.
//   T9. Every other occurrence of either command literal is the first
//       argument of an `#invoke(` / `.invoke(` call whose arguments include
//       `displayNames`; `enableGroupEncryption` holds an enable invoke, and
//       `addGroupMemberEncrypted`, wherever it exists (FE-B), an add invoke.
//
// The scanners are checked against inline fixtures first (a conforming file
// passes; each violation is reported), so a green scan is never a scanner
// that cannot fail.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const KT_FILE =
  process.env.E2EE_GROWTH_KT ||
  new URL(
    "../../android/app/src/main/java/com/acutest/app/e2ee/E2eePlugin.kt",
    import.meta.url,
  );
const TS_FILE =
  process.env.E2EE_GROWTH_TS || new URL("./e2ee.ts", import.meta.url);

const GROWTH = [
  {
    method: "enableGroup",
    preview: "previewGroupEnable",
    command: "e2ee_enable_group",
  },
  {
    method: "addGroupMember",
    preview: "previewGroupAdd",
    command: "e2ee_add_group_member",
  },
] as const;

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

const POSITIVE_BUTTON = String.raw`getButton\s*\(\s*(?:(?:AlertDialog|DialogInterface)\s*\.\s*)?BUTTON_POSITIVE\s*\)`;

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

/** Each positive button taken inside `span`, and where it is in scope. */
function positiveButtons(code: string, span: Span): KtButton[] {
  const out: KtButton[] = [];
  const inner = code.slice(span[0], span[1] + 1);
  const bound = new RegExp(
    String.raw`\bval\s+(\w+)\s*(?::\s*[\w.?]+\s*)?=\s*(?:\w+\s*(?:\?|!!)?\s*\.\s*)?${POSITIVE_BUTTON}`,
    "g",
  );
  for (const b of inner.matchAll(bound)) {
    out.push({ at: span[0] + b.index, name: b[1], scope: span });
  }
  const scoped = new RegExp(
    String.raw`${POSITIVE_BUTTON}\s*(?:\?|!!)?\s*\.\s*(let|also|apply|run)\s*\{`,
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

/**
 * A `postDelayed(` delay in ms: a literal, or a `val` whose whole value is
 * one or names another such `val` (`DOWNGRADE_CONFIRM_DELAY_MS =
 * GROWTH_CONFIRM_DELAY_MS`); else -1. Arithmetic (`700L / 7`) is not read.
 */
function delayMs(code: string, arg: string, depth = 0): number {
  const literal = /^(\d[\d_]*)L?$/.exec(arg);
  if (literal) return Number(literal[1].replace(/_/g, ""));
  if (!/^\w+$/.test(arg) || depth > 4) return -1;
  const held = new RegExp(
    String.raw`\bval\s+${arg}\s*(?::\s*\w+\s*)?=\s*(\w+)[ \t]*(?:;|$)`,
    "m",
  ).exec(code);
  return held ? delayMs(code, held[1], depth + 1) : -1;
}

/** What the input delay on `button` lacks; empty when it has it all. */
function delayMissing(code: string, button: KtButton): string[] {
  const receiver =
    button.name === null
      ? String.raw`(?<![\w.?])(?:this\s*\.\s*)?`
      : String.raw`\b${button.name}\s*(?:\?|!!)?\s*\.\s*`;
  const sets = (prop: string, setter: string, value: string) =>
    new RegExp(
      String.raw`${receiver}(?:${prop}\s*=(?!=)\s*${value}\b|${setter}\s*\(\s*${value}\s*\))`,
      "g",
    );
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

/** The View methods that click, touch or key a view from code. */
const TAP_NAMES = [
  "performClick",
  "callOnClick",
  "performLongClick",
  "performContextClick",
  "performAccessibilityAction",
  "dispatchTouchEvent",
  "dispatchKeyEvent",
  "dispatchGenericMotionEvent",
  "onTouchEvent",
  "onKeyDown",
  "onKeyUp",
];

/**
 * A synthetic tap on Confirm would commit with no user ever tapping it
 * (masked code): a call `name(` (group 2), or a function reference
 * `::name` (group 1), as in `confirm.let(View::performClick)`.
 */
const SYNTHETIC_TAP = new RegExp(
  String.raw`::\s*(${TAP_NAMES.join("|")})\b|\b(${TAP_NAMES.join("|")})\s*\(`,
  "g",
);

/** How a SYNTHETIC_TAP match reads in a violation. */
const tapLabel = (t: RegExpMatchArray) => (t[1] ? `::${t[1]}` : `${t[2]}(`);

/**
 * Reflection (masked code). It reaches a method by a string name, and
 * string contents are masked, so a reflective commit escapes every
 * placement rule.
 */
const REFLECTION = new RegExp(
  [
    String.raw`\b(?:getMethod|getDeclaredMethod|getMethods|getDeclaredMethods|getConstructor|getDeclaredConstructor)\s*\(`,
    String.raw`\.\s*javaClass\s*\.\s*(?:declaredMethods|methods)\b`,
    String.raw`::\s*class\s*\.\s*java\s*\.\s*(?:declaredMethods|methods)\b`,
    String.raw`\.\s*(?:declaredMethods|methods)\b`,
    String.raw`\.\s*(?:memberFunctions|declaredFunctions|declaredMemberFunctions|staticFunctions)\b`,
    String.raw`\bKFunction\w*`,
    String.raw`\bKCallable\b`,
    String.raw`\bcallBy\s*\(`,
    String.raw`\bClass\s*\.\s*forName\s*\(`,
    String.raw`\b(?:java\s*\.\s*lang|kotlin)\s*\.\s*reflect\b`,
    String.raw`\bMethodHandles?\b`,
  ].join("|"),
  "g",
);

/**
 * Every `isEnabled = …` / `setEnabled(…)` in `span` (masked code) that can
 * enable a view before the input delay: any value but the literal `false`,
 * outside a `postDelayed(` (its arguments, or its trailing lambda) whose
 * delay is at least the floor. A `::isEnabled` / `::setEnabled` reference
 * counts as an enable of unknown value.
 */
function earlyEnables(
  code: string,
  span: Span,
): { at: number; value: string }[] {
  const inner = code.slice(span[0], span[1] + 1);
  const delayed: Span[] = [];
  for (const p of inner.matchAll(/\bpostDelayed\s*\(/g)) {
    const paren = span[0] + p.index + p[0].length - 1;
    const args = callArgs(code, paren);
    if (delayMs(code, args[args.length - 1] ?? "") < CONFIRM_DELAY_FLOOR_MS) {
      continue;
    }
    const close = matchClose(code, paren);
    const k = skipWs(code, close + 1);
    delayed.push([paren, code[k] === "{" ? matchClose(code, k) : close]);
  }
  const writes =
    /\bisEnabled\s*=(?!=)\s*|\bsetEnabled\s*\(|::\s*(?:isEnabled|setEnabled)\b/g;
  const out: { at: number; value: string }[] = [];
  for (const w of inner.matchAll(writes)) {
    const at = span[0] + w.index;
    const end = at + w[0].length;
    const value = w[0].startsWith("::")
      ? squash(w[0])
      : w[0].startsWith("setEnabled")
        ? callArgs(code, end - 1).join(",")
        : squash(code.slice(end, ktStatementEnd(code, end) + 1));
    if (value !== "false" && !inSpan(delayed, at)) out.push({ at, value });
  }
  return out;
}

/**
 * The functions outside `consentFuns` that enable a view early
 * (`earlyEnables`), directly or by calling one that does, each with a
 * RegExp matching a call or reference to it: unqualified, or qualified too
 * for an extension function.
 */
function enablingHelpers(
  code: string,
  funs: KtFun[],
  consentFuns: KtFun[],
): { name: string; call: RegExp }[] {
  const inConsent = (i: number) =>
    consentFuns.some((c) => i >= c.at && i <= c.close);
  const bodyOf = (f: KtFun): Span | null => {
    if (f.open >= 0) return [f.open, f.close];
    if (f.expr < 0) return null;
    const k = skipWs(code, f.expr + 1);
    return [k, ktStatementEnd(code, k)];
  };
  const callOf = (f: KtFun) => {
    // `fun View.unlock()` is called qualified: `confirm.unlock()`.
    const extension = code.slice(f.at, code.indexOf("(", f.at)).includes(".");
    const unqualified = extension ? "" : String.raw`(?<!\.\s*)`;
    return new RegExp(
      String.raw`(?<!\bfun\s+)${unqualified}\b${f.name}\s*[({]|::\s*${f.name}\b`,
      "g",
    );
  };
  const candidates = funs.filter((f) => !inConsent(f.at));
  const found = new Map<string, RegExp>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of candidates) {
      if (found.has(f.name)) continue;
      const span = bodyOf(f);
      if (!span) continue;
      const inner = code.slice(span[0], span[1] + 1);
      const calls = [...found.values()].some((re) =>
        new RegExp(re.source).test(inner),
      );
      if (earlyEnables(code, span).length || calls) {
        found.set(f.name, callOf(f));
        grew = true;
      }
    }
  }
  return [...found].map(([name, call]) => ({ name, call }));
}

/**
 * Early enables (`earlyEnables`) anywhere in the file that consent code can
 * reach, other than those inside a consent method (the caller reports
 * those). Reachable: in code outside every function body (a stored lambda,
 * a property accessor, an init block), whose callers cannot be traced; or
 * in a function named, directly or through other such functions, by a
 * consent method or by that code. A function nothing reachable names (say,
 * another dialog's handler) is exempt. Names match as bare tokens, so a
 * qualified call (`this.unlock(…)`) or a reference counts.
 */
function reachableEnables(
  code: string,
  funs: KtFun[],
  consentFuns: KtFun[],
): { at: number; value: string; where: string | null }[] {
  const bodies = funs
    .map((f) => {
      if (f.open >= 0) return { f, span: [f.open, f.close] as Span };
      if (f.expr < 0) return null;
      const k = skipWs(code, f.expr + 1);
      return { f, span: [k, ktStatementEnd(code, k)] as Span };
    })
    .filter((b): b is { f: KtFun; span: Span } => b !== null);
  // Code outside every function body, definition heads blanked.
  const outside = code.split("");
  for (const { f, span } of bodies) {
    for (let i = f.at; i <= span[1]; i++) {
      if (outside[i] !== "\n") outside[i] = " ";
    }
  }
  const named = (text: string, name: string) =>
    new RegExp(String.raw`\b${name}\b`).test(text);
  const live = new Set<string>();
  const seeds = [
    outside.join(""),
    ...consentFuns.map((f) => code.slice(f.open, f.close + 1)),
  ];
  for (let grew = true; grew; ) {
    grew = false;
    const reached = [
      ...seeds,
      ...bodies
        .filter((b) => live.has(b.f.name))
        .map((b) => code.slice(b.span[0], b.span[1] + 1)),
    ];
    for (const { f } of bodies) {
      if (live.has(f.name)) continue;
      if (reached.some((text) => named(text, f.name))) {
        live.add(f.name);
        grew = true;
      }
    }
  }
  const out: { at: number; value: string; where: string | null }[] = [];
  for (const e of earlyEnables(code, [0, code.length - 1])) {
    const chain = bodies.filter((b) => b.span[0] <= e.at && e.at <= b.span[1]);
    if (chain.some((b) => consentFuns.includes(b.f))) continue;
    if (!chain.length) {
      out.push({ ...e, where: null });
      continue;
    }
    const inner = chain.reduce((a, b) => (b.span[0] > a.span[0] ? b : a));
    if (live.has(inner.f.name)) out.push({ ...e, where: inner.f.name });
  }
  return out;
}

// ---- Kotlin rules -----------------------------------------------------------

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

  // K1: no generic dispatcher arm.
  const dispatchers = funs.filter((f) => f.name === "call" && f.annotated);
  if (dispatchers.length !== 1 || dispatchers[0].open < 0) {
    fail(
      "K1",
      `expected one @PluginMethod fun call( with a body, found ${dispatchers.length}`,
    );
  } else {
    const [from, to] = [dispatchers[0].open, dispatchers[0].close];
    for (const g of GROWTH) {
      const hit = text.slice(from, to + 1).indexOf(g.command);
      if (hit >= 0) {
        fail(
          "K1",
          `call() still names ${g.command} at ${at(from + hit)} (a generic dispatcher arm)`,
        );
      }
    }
  }

  // K2: the two dedicated plugin methods.
  const methods = new Map<string, KtFun>();
  for (const g of GROWTH) {
    const defs = funs.filter((f) => f.name === g.method);
    if (defs.length !== 1) {
      fail(
        "K2",
        `${g.method}: expected exactly one definition, found ${defs.length}`,
      );
    } else if (!defs[0].annotated) {
      fail("K2", `${g.method}: not annotated @PluginMethod`);
    } else if (defs[0].open < 0) {
      fail("K2", `${g.method}: has no block body`);
    } else if (!/^\w+:PluginCall$/.test(squash(defs[0].params))) {
      fail("K2", `${g.method}: parameters must be (call: PluginCall)`);
    } else {
      methods.set(g.method, defs[0]);
      continue;
    }
    for (const rule of ["K3", "K4", "K5", "K6", "K7", "K8", "K9"]) {
      fail(rule, `${g.method}: no @PluginMethod to check`);
    }
  }
  const ownerOf = (i: number) =>
    GROWTH.find((g) => {
      const f = methods.get(g.method);
      return f !== undefined && i > f.open && i < f.close;
    });

  // Every enableGroup / addGroupMember reference that is not a definition.
  const refs: { name: string; at: number }[] = [];
  for (const r of code.matchAll(/\b(enableGroup|addGroupMember)\b/g)) {
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
        "K3",
        `${r.name} referenced at ${at(r.at)}, outside the enableGroup / addGroupMember plugin methods`,
      );
    } else if (owner.method !== r.name) {
      fail("K3", `${owner.method}: references ${r.name} at ${at(r.at)}`);
    }
  }

  // K4 (file): nothing reads expectedAfter from call data.
  const keyed = text.search(/"expectedAfter"/);
  if (keyed >= 0) {
    fail(
      "K4",
      `the string "expectedAfter" appears at ${at(keyed)}; it must come from the preview, never from call data`,
    );
  }

  // K5 (shared): the plugin-level guard both methods claim. Declared
  // directly in the `class E2eePlugin` body (not in an inner class, whose
  // instances could each hold a fresh guard) and claimed unqualified.
  const pluginGuards = new Set<string>();
  const plugin = /\bclass\s+E2eePlugin\b[^{]*\{/.exec(code);
  if (plugin) {
    const open = plugin.index + plugin[0].length - 1;
    for (const a of code.matchAll(ATOMIC_VAL)) {
      if (
        a[1] === "val" &&
        a.index > open &&
        depthAt(open + 1, a.index) === 0
      ) {
        pluginGuards.add(a[2]);
      }
    }
  }
  const unqualified = (i: number) => {
    let j = i - 1;
    while (j >= 0 && /\s/.test(code[j])) j--;
    return code[j] !== "." || /\bthis\s*\.$/.test(code.slice(0, j + 1));
  };
  const claimedBy = [...methods.values()].map(
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

  for (const g of GROWTH) {
    const f = methods.get(g.method);
    if (!f) continue;
    const body: Span = [f.open, f.close];
    const within = (i: number) => i > f.open && i < f.close;

    // K4: the preview result.
    const previews = [
      ...code.matchAll(new RegExp(`\\b${g.preview}\\b`, "g")),
    ].filter((p) => within(p.index));
    let previewVal: string | null = null;
    let previewAt = -1;
    if (previews.length !== 1) {
      fail(
        "K4",
        `${g.method}: expected exactly one ${g.preview}( call, found ${previews.length}`,
      );
    } else {
      previewAt = previews[0].index;
      const assigned =
        /\bval\s+(\w+)\s*(?::\s*[\w.<>?]+\s*)?=\s*(?:\w+(?:\(\))?\s*\.\s*)*$/.exec(
          code.slice(f.open, previewAt),
        );
      if (assigned) previewVal = assigned[1];
      else {
        fail(
          "K4",
          `${g.method}: the ${g.preview}( result is not held in a val`,
        );
      }
    }

    // K3: where the commits sit.
    const positive = listenerLambdas(code, "setPositiveButton", body);
    const noPrompt: Span[] = [];
    if (previewVal) {
      for (const s of ktIfs(m, body)) {
        const p = `${previewVal}.needsPrompt`;
        if ([`!${p}`, `${p}==false`, `false==${p}`].includes(s.cond)) {
          noPrompt.push(s.then);
        } else if (s.cond === p && s.otherwise) {
          noPrompt.push(s.otherwise);
        }
      }
    }
    const positiveCommits: number[] = [];
    let noPromptCommits = 0;
    for (const r of refs) {
      if (r.name !== g.method || !within(r.at)) continue;
      let k = r.at + r.name.length;
      if (code[k] === "`") k++;
      k = skipWs(code, k);
      if (code[k] !== "(") {
        fail("K3", `${g.method}: ${r.name} at ${at(r.at)} is not a call`);
        continue;
      }
      const isPositive = inSpan(positive, r.at);
      if (!isPositive && !inSpan(noPrompt, r.at)) {
        fail(
          "K3",
          `${g.method}: engine ${r.name}( at ${at(r.at)} is outside setPositiveButton and the !needsPrompt branch`,
        );
        continue;
      }
      const args = callArgs(code, k);
      const want = isPositive ? "true" : "false";
      const flags = args.filter((a) =>
        /^(?:prompted=)?(?:true|false)$/.test(a),
      );
      if (flags.length !== 1 || !flags[0].endsWith(want)) {
        fail(
          "K3",
          `${g.method}: the ${isPositive ? "positive-button" : "no-prompt"} commit at ${at(r.at)} must pass prompted = ${want}`,
        );
      }
      const expected = `${previewVal}.expectedAfter`;
      if (
        !previewVal ||
        !args.some((a) => a === expected || a === `expectedAfter=${expected}`)
      ) {
        fail(
          "K4",
          `${g.method}: the commit at ${at(r.at)} does not pass ${previewVal ?? "<preview>"}.expectedAfter`,
        );
      }
      if (isPositive) positiveCommits.push(r.at);
      else noPromptCommits++;
    }
    if (!positiveCommits.length) {
      fail("K3", `${g.method}: no engine commit inside setPositiveButton`);
    }
    if (!noPromptCommits) {
      fail("K3", `${g.method}: no engine commit in the !needsPrompt branch`);
    }

    // K7's busy branch, found first: where it ends bounds K5's exemption.
    const busy =
      guard &&
      ktIfs(m, body).find((s) =>
        [
          `!${guard}.compareAndSet(false,true)`,
          `${guard}.compareAndSet(false,true)==false`,
        ].includes(s.cond),
      );
    const blocks = ktBlocks(code, body);
    const callName = squash(f.params).split(":")[0];

    // K5: the single-in-flight guard, released on every path.
    if (!guard) {
      fail(
        "K5",
        `${g.method}: no plugin-level \`val … = AtomicBoolean(…)\` that both methods compareAndSet(false, true)`,
      );
    } else {
      const first = claimAt(code, guard, body);
      if (previewAt >= 0 && first > previewAt) {
        fail(
          "K5",
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
      const exemptUntil = busy ? busy.then[1] : first;
      const settles = new RegExp(
        String.raw`\b(?:${callName}\s*\.\s*(?:reject|resolve)|resolveJson|rejectScrubbed|run(?=\s*\(\s*${callName}\s*[,)]))\s*\(`,
        "g",
      );
      if (!releases.length) {
        fail(
          "K5",
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
                "K5",
                `${g.method}: run(${callName}) at ${at(i)} rejects if its body throws, and the body does not open with a release of ${guard} or a try whose finally releases it`,
              );
            }
            continue;
          }
          const home = innermost(blocks, i);
          if (!(home && releasedBefore(home, i)) && !underFinally(i)) {
            fail(
              "K5",
              `${g.method}: ${what} at ${at(i)} settles the call without releasing ${guard} first (a release earlier in its own block, or an enclosing try in the same lambda whose finally releases)`,
            );
          }
        }
      }
    }

    // K6: decline on dismiss, resolved once.
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
    const rejectsDeclined = (s: Span) =>
      REJECT.test(code.slice(s[0], s[1] + 1)) &&
      DECLINED.test(text.slice(s[0], s[1] + 1));
    const once = locals.find((o) =>
      dismiss.some((s) => claimAt(code, o, s) >= 0 && rejectsDeclined(s)),
    );
    if (!dismiss.length) {
      fail("K6", `${g.method}: no setOnDismissListener in its body`);
    } else if (!once) {
      fail(
        "K6",
        `${g.method}: no OnDismissListener that claims a method-local AtomicBoolean and rejects declined`,
      );
    } else {
      for (const commit of positiveCommits) {
        const lambda = positive.find((s) => inSpan([s], commit)) ?? [
          commit,
          commit,
        ];
        const claim = claimAt(code, once, lambda);
        if (claim < 0 || claim > commit) {
          fail(
            "K6",
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
              "K6",
              `${g.method}: ${name} at ${at(s[0])} settles the call without ${once}.compareAndSet(false, true)`,
            );
          }
        }
      }
    }

    // K7: busy when the guard is taken.
    const rejectsBusy = ([from, to]: Span) =>
      REJECT.test(code.slice(from, to + 1)) &&
      BUSY.test(text.slice(from, to + 1)) &&
      /\breturn\b/.test(code.slice(from, to + 1));
    if (!busy) {
      fail(
        "K7",
        `${g.method}: no \`if (!<guard>.compareAndSet(false, true))\` busy branch`,
      );
    } else if (!rejectsBusy(busy.then)) {
      fail(
        "K7",
        `${g.method}: the taken-guard branch must reject {"type":"busy"} and return`,
      );
    }

    // K8: the decline lockout, and a dialog teardown can reach.
    const idVal = /\bval\s+(\w+)\s*(?::[^=\n]*)?=[^\n]*"conversationId"/.exec(
      text.slice(f.open, f.close + 1),
    );
    const host = listenerLambdas(code, "runOnUiThread", body).find((s) =>
      positive.some((p) => inSpan([s], p[0])),
    );
    if (!host) {
      fail(
        "K8",
        `${g.method}: the setPositiveButton dialog is not built inside a runOnUiThread lambda`,
      );
    } else {
      const tracked = [
        ...code
          .slice(host[0], host[1] + 1)
          .matchAll(/\bgrowthDialog\s*=(?!=)\s*(\w+)/g),
      ].some((t) => t[1] !== "null");
      if (!tracked) {
        fail(
          "K8",
          `${g.method}: never records its dialog in growthDialog inside runOnUiThread (handleOnDestroy could not dismiss it)`,
        );
      }
    }
    if (!idVal) {
      fail("K8", `${g.method}: no val holding the "conversationId" argument`);
    } else {
      const id = idVal[1];
      const lockouts = ktIfs(m, body).filter(
        (s) => s.cond === `growthLockedOut(${id})`,
      );
      const lockout = lockouts.find(
        (s) =>
          host !== undefined &&
          s.at > previewAt &&
          s.at < host[0] &&
          !inSpan(noPrompt, s.at) &&
          innermost(blocks, s.at) === innermost(blocks, host[0]) &&
          ktStatementStart(code, blocks, s.at),
      );
      if (!lockouts.length) {
        fail(
          "K8",
          `${g.method}: no \`if (growthLockedOut(${id}))\` lockout check`,
        );
      } else if (!lockout) {
        fail(
          "K8",
          `${g.method}: the growthLockedOut(${id}) check at ${at(lockouts[0].at)} is not a statement after the preview, in the block of the dialog's runOnUiThread and before it`,
        );
      } else if (!rejectsBusy(lockout.then)) {
        fail(
          "K8",
          `${g.method}: the lockout branch must reject {"type":"busy"} and return`,
        );
      }
      const note = new RegExp(
        String.raw`\bnoteGrowthDecline\s*\(\s*${id}\s*\)`,
        "g",
      );
      const noted =
        once !== undefined &&
        dismiss.some((s) =>
          ktIfs(m, s).some((branch) => {
            if (branch.cond !== `${once}.compareAndSet(false,true)`) {
              return false;
            }
            const [from, to] = branch.then;
            return [...code.slice(from, to + 1).matchAll(note)].some((n) => {
              const k = from + n.index;
              return code[from] === "{"
                ? innermost(blocks, k)?.open === from &&
                    ktStatementStart(code, blocks, k)
                : k === from;
            });
          }),
        );
      if (!noted) {
        fail(
          "K8",
          `${g.method}: the dismiss listener does not call noteGrowthDecline(${id}) in its ${once ?? "<once>"}.compareAndSet(false, true) branch`,
        );
      }
    }

    // K9: the positive button is input-delayed.
    const shows = [
      ...listenerLambdas(code, "setOnShowListener", body),
      ...listenerLambdas(code, "OnShowListener", body),
    ];
    const buttons = shows
      .flatMap((s) => positiveButtons(code, s))
      .map((b) => ({ b, missing: delayMissing(code, b) }));
    if (!shows.length) {
      fail("K9", `${g.method}: no setOnShowListener`);
    } else if (!buttons.length) {
      fail(
        "K9",
        `${g.method}: no setOnShowListener that takes getButton(AlertDialog.BUTTON_POSITIVE)`,
      );
    } else if (buttons.every((r) => r.missing.length)) {
      fail(
        "K9",
        `${g.method}: the positive button taken at ${at(buttons[0].b.at)} lacks ${buttons[0].missing.join("; ")}`,
      );
    }
  }

  // K8 (file): activity teardown dismisses the open growth dialog.
  const destroy = funs.filter(
    (f) => f.name === "handleOnDestroy" && f.open >= 0,
  );
  if (destroy.length !== 1) {
    fail(
      "K8",
      `expected one handleOnDestroy() with a body, found ${destroy.length}`,
    );
  } else {
    const d = destroy[0];
    const own = ktBlocks(code, [d.open, d.close]);
    const dismissed = [
      ...code
        .slice(d.open, d.close + 1)
        .matchAll(/\bgrowthDialog\s*(?:\?|!!)?\s*\.\s*dismiss\s*\(\s*\)/g),
    ].some((x) => {
      const k = d.open + x.index;
      return (
        innermost(own, k)?.open === d.open && ktStatementStart(code, own, k)
      );
    });
    if (!dismissed) {
      fail("K8", "handleOnDestroy() does not dismiss growthDialog");
    }
  }

  // K3 (file): no reflection.
  for (const r of code.matchAll(REFLECTION)) {
    fail(
      "K3",
      `reflection (${squash(r[0])}) at ${at(r.index)}; a commit looked up by name escapes every placement rule`,
    );
  }

  // K3 (file): only a user's tap confirms. File-wide, so a helper outside
  // the growth methods cannot tap Confirm for them.
  for (const t of code.matchAll(SYNTHETIC_TAP)) {
    fail(
      "K3",
      `${tapLabel(t)} at ${at(t.index)} acts on a view from code; only a user's tap may confirm`,
    );
  }

  // K9 (both methods): nothing enables a button before the input delay,
  // directly or through a helper defined elsewhere in the file.
  const consentFuns = funs.filter(
    (f) => GROWTH.some((g) => g.method === f.name) && f.open >= 0,
  );
  for (const f of consentFuns) {
    for (const e of earlyEnables(code, [f.open, f.close])) {
      fail(
        "K9",
        `${f.name}: isEnabled = ${e.value} at ${at(e.at)} is outside a postDelayed( of at least ${CONFIRM_DELAY_FLOOR_MS} ms`,
      );
    }
  }
  for (const h of enablingHelpers(code, funs, consentFuns)) {
    for (const f of consentFuns) {
      const inner = code.slice(f.open, f.close + 1);
      for (const c of inner.matchAll(h.call)) {
        fail(
          "K9",
          `${f.name}: calls ${h.name} at ${at(f.open + c.index)}, which enables a view outside a postDelayed( of at least ${CONFIRM_DELAY_FLOOR_MS} ms`,
        );
      }
    }
  }
  // K9 (file): stored enablers, and enabling functions consent code names.
  for (const e of reachableEnables(code, funs, consentFuns)) {
    fail(
      "K9",
      e.where === null
        ? `isEnabled = ${e.value} at ${at(e.at)} is outside any function body (a stored enabler) and outside a postDelayed( of at least ${CONFIRM_DELAY_FLOOR_MS} ms`
        : `isEnabled = ${e.value} at ${at(e.at)} in ${e.where}, which consent code can reach, is outside a postDelayed( of at least ${CONFIRM_DELAY_FLOOR_MS} ms`,
    );
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

/** The `(` of the `#invoke(` / `.invoke(` call whose first argument is at `at`. */
function invokeParenBefore(code: string, at: number): number {
  let j = at - 1;
  while (j >= 0 && /\s/.test(code[j])) j--;
  if (code[j] !== "(") return -1;
  const paren = j--;
  while (j >= 0 && /\s/.test(code[j])) j--;
  if (code[j] === ">") {
    for (let depth = 0; j >= 0; j--) {
      if (code[j] === ">") depth++;
      else if (code[j] === "<" && --depth === 0) break;
    }
    j--;
    while (j >= 0 && /\s/.test(code[j])) j--;
  }
  const end = j;
  while (j >= 0 && /[\w$]/.test(code[j])) j--;
  const callee = code.slice(j + 1, end + 1);
  return callee === "invoke" && (code[j] === "#" || code[j] === ".")
    ? paren
    : -1;
}

// ---- TypeScript rules -------------------------------------------------------

/** Every rule violation in `src`, each prefixed with its rule id. */
function tsViolations(src: string): string[] {
  const m = maskTs(src);
  const { code, text } = m;
  const out: string[] = [];
  const fail = (rule: string, message: string) =>
    out.push(`${rule} ${message}`);
  const at = (i: number) => `line ${lineOf(src, i)}`;

  // T8: the Capacitor routes.
  const routeConds: Span[] = [];
  const classes = [...code.matchAll(/\bclass\s+CapacitorTransport\b/g)];
  let invoke: Span[] = [];
  if (classes.length === 1) {
    const open = code.indexOf("{", classes[0].index);
    invoke = tsMethods(m, "invoke", open, matchClose(code, open));
  }
  if (classes.length !== 1) {
    fail(
      "T8",
      `expected one class CapacitorTransport, found ${classes.length}`,
    );
  } else if (invoke.length !== 1) {
    fail(
      "T8",
      `CapacitorTransport: expected one invoke( definition, found ${invoke.length}`,
    );
  } else {
    const body = invoke[0];
    const generic = code
      .slice(body[0], body[1] + 1)
      .search(/#plugin\s*\.\s*call\s*\(/);
    const ifs = tsIfs(m, body);
    for (const g of GROWTH) {
      const isRoute = new RegExp(
        `^(?:command===?(["'\`])${g.command}\\1|(["'\`])${g.command}\\2===?command)$`,
      );
      const routes = ifs.filter((s) => isRoute.test(s.cond));
      if (routes.length !== 1) {
        fail(
          "T8",
          `${g.command}: expected one \`if (command === "${g.command}")\` route in CapacitorTransport.invoke, found ${routes.length}`,
        );
        continue;
      }
      const route = routes[0];
      routeConds.push(route.at);
      if (ifs.some((o) => o !== route && inSpan([o.then], route.at[0]))) {
        fail("T8", `${g.command}: the route is nested inside another if`);
      }
      const then = code.slice(route.then[0], route.then[1] + 1);
      const call = new RegExp(`#plugin\\s*\\.\\s*${g.method}\\s*\\(`).exec(
        then,
      );
      if (!call) {
        fail(
          "T8",
          `${g.command}: the route does not call this.#plugin.${g.method}(`,
        );
      } else {
        const paren = route.then[0] + call.index + call[0].length - 1;
        const arg = code.slice(paren + 1, matchClose(code, paren));
        const forwards =
          /\bdisplayNames\b/.test(arg) ||
          /\.\.\.\s*\(?\s*args\b/.test(arg) ||
          (/\bargs\b/.test(arg) && !arg.replace(/\{\s*\}/g, "").includes("{"));
        if (!forwards) {
          fail(
            "T8",
            `${g.command}: #plugin.${g.method}( does not forward args (displayNames would be dropped)`,
          );
        }
      }
      if (!/\breturn\b/.test(then)) {
        fail("T8", `${g.command}: the route does not return`);
      }
      if (generic >= 0 && route.at[0] > body[0] + generic) {
        fail(
          "T8",
          `${g.command}: the route sits after the generic #plugin.call(`,
        );
      }
    }
  }

  // T9: every other mention is a native invoke that carries displayNames.
  const sites: { command: string; at: number }[] = [];
  const mention = /(["'`])(e2ee_enable_group|e2ee_add_group_member)\1/g;
  for (const l of text.matchAll(mention)) {
    if (inSpan(routeConds, l.index)) continue;
    const paren = invokeParenBefore(code, l.index);
    if (paren < 0) {
      fail(
        "T9",
        `"${l[2]}" at ${at(l.index)} is neither an invoke( command argument nor the transport route`,
      );
      continue;
    }
    const rest = code.slice(l.index + l[0].length, matchClose(code, paren));
    if (!/\bdisplayNames\b/.test(rest)) {
      fail(
        "T9",
        `invoke("${l[2]}") at ${at(l.index)} does not pass displayNames`,
      );
    }
    sites.push({ command: l[2], at: l.index });
  }
  const callers = [
    ["enableGroupEncryption", "e2ee_enable_group", true],
    ["addGroupMemberEncrypted", "e2ee_add_group_member", false],
  ] as const;
  for (const [name, command, required] of callers) {
    const defs = tsMethods(m, name);
    if (defs.length > 1 || (required && defs.length !== 1)) {
      fail(
        "T9",
        `expected ${required ? "exactly" : "at most"} one ${name}( definition, found ${defs.length}`,
      );
    } else if (
      defs.length === 1 &&
      !sites.some((s) => s.command === command && inSpan(defs, s.at))
    ) {
      fail("T9", `${name}: no invoke("${command}", …) in its body`);
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

/** Asserts that `found` holds a violation matching `expected`. */
function assertFires(label: string, found: string[], expected: RegExp) {
  assert.ok(
    found.some((v) => expected.test(v)),
    `${label}: expected ${expected}, got ${JSON.stringify(found, null, 2)}`,
  );
}

/** A conforming plugin; trailing comments only make swap targets unique. */
const KT_FIXTURE = `
package com.acutest.app.e2ee

import java.util.concurrent.atomic.AtomicBoolean

private const val GROWTH_CONFIRM_DELAY_MS: Long = 700L

@CapacitorPlugin(name = "E2ee")
class E2eePlugin : Plugin() {
    private val executor: ExecutorService = Executors.newCachedThreadPool()

    /** One growth dialog at a time; enableGroup( and addGroupMember( share it. */
    private val growthInFlight = AtomicBoolean(false)

    private val growthDeclinedUntil = HashMap<String, Long>()

    private var growthDialog: AlertDialog? = null

    private fun engine() = E2eeNative.engine(context)

    private fun growthLockedOut(conversationId: String): Boolean =
        synchronized(growthDeclinedUntil) { growthDeclinedUntil.containsKey(conversationId) }

    private fun noteGrowthDecline(conversationId: String) {
        synchronized(growthDeclinedUntil) { growthDeclinedUntil[conversationId] = 1L }
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
                // "e2ee_enable_group" -> engine.enableGroup(a, b, c, d)
                /* "e2ee_add_group_member" ->
                   engine.addGroupMember(a, b, c, d) /* nested */ */
                "e2ee_note" -> Log.d("E2ee", "enableGroup(x, true) \${'}'}")
                else -> call.reject("{\\"type\\":\\"invalid_argument\\"}")
            }
        }
    }

    @PluginMethod
    fun enableGroup(call: PluginCall) {
        val conversationId = call.getString("conversationId") ?: run {
            call.reject("{\\"type\\":\\"invalid_argument\\",\\"field\\":\\"conversationId\\"}")
            return
        }
        val roster = call.getArray("roster")?.toList<String>() ?: emptyList()
        val selfUserId = call.getString("selfUserId") ?: return
        val bundles = call.getArray("bundles")?.toString()
        val names = displayNamesOf(call)
        if (!growthInFlight.compareAndSet(false, true)) { // enable-busy
            call.reject("{\\"type\\":\\"busy\\"}") // enable-busy
            return // enable-busy-return
        }
        executor.execute {
            try {
                val prompt = engine().previewGroupEnable(conversationId, roster, selfUserId, names)
                if (!prompt.needsPrompt) { // enable-no-prompt
                    try {
                        resolveJson(call, engine().enableGroup(conversationId, roster, selfUserId, bundles, prompt.expectedAfter, false)) // enable-commit-direct
                    } finally {
                        growthInFlight.set(false)
                    }
                    return@execute
                }
                if (growthLockedOut(conversationId)) { // enable-lockout
                    growthInFlight.set(false)
                    call.reject("{\\"type\\":\\"busy\\"}") // enable-lockout-busy
                    return@execute
                }
                activity.runOnUiThread { // enable-ui
                    val settled = AtomicBoolean(false)
                    val dialog = AlertDialog.Builder(activity)
                        .setTitle(prompt.title)
                        .setMessage("\${prompt.message} {")
                        .setPositiveButton(prompt.confirmLabel) { _, _ -> // enable-positive
                            if (settled.compareAndSet(false, true)) { // enable-positive-claim
                                run(call) {
                                    try {
                                        resolveJson(call, engine().enableGroup(conversationId, roster, selfUserId, bundles, prompt.expectedAfter, true)) // enable-commit-confirmed
                                    } finally {
                                        growthInFlight.set(false)
                                    }
                                }
                            }
                        }
                        .setNegativeButton(prompt.cancelLabel, null) // enable-negative
                        .setOnDismissListener { // enable-dismiss
                            if (settled.compareAndSet(false, true)) { // enable-dismiss-claim
                                noteGrowthDecline(conversationId) // enable-note-decline
                                growthInFlight.set(false) // enable-dismiss-release
                                call.reject("{\\"type\\":\\"declined\\"}") // enable-declined
                            }
                        }
                        .create()
                    dialog.setOnShowListener { // enable-show
                        val confirm = dialog.getButton(AlertDialog.BUTTON_POSITIVE)
                        confirm.filterTouchesWhenObscured = true // enable-filter
                        confirm.isEnabled = false // enable-disable
                        confirm.postDelayed({ confirm.isEnabled = true }, 700L) // enable-delay
                    }
                    dialog.show()
                    growthDialog = dialog
                } // enable-ui-end
            } catch (error: Throwable) {
                growthInFlight.set(false)
                rejectScrubbed(call, error)
            }
        }
    }

    @PluginMethod
    fun addGroupMember(call: PluginCall) {
        val conversationId = requireString(call, "conversationId")
        val userId = requireString(call, "userId")
        val selfUserId = requireString(call, "selfUserId")
        val bundles = call.getArray("bundles")?.toString()
        val labels = displayNamesOf(call)
        if (!growthInFlight.compareAndSet(false, true)) { // add-busy
            call.reject("{\\"type\\":\\"busy\\"}")
            return
        }
        val held = AtomicBoolean(true)
        fun release() {
            if (held.compareAndSet(true, false)) growthInFlight.set(false) // add-release-helper
        }
        executor.execute {
            try {
                val preview: GroupGrowthPrompt = engine().previewGroupAdd(conversationId, userId, selfUserId, labels)
                if (preview.needsPrompt) { // add-needs-prompt
                    if (growthLockedOut(conversationId)) { // add-lockout
                        release()
                        call.reject("{\\"type\\":\\"busy\\"}") // add-lockout-busy
                        return@execute
                    }
                    activity.runOnUiThread {
                        val answered = AtomicBoolean(false)
                        val dialog = AlertDialog.Builder(activity)
                            .setMessage(preview.message)
                            .setPositiveButton(preview.confirmLabel, DialogInterface.OnClickListener { _, _ -> // add-positive
                                if (answered.compareAndSet(false, true)) {
                                    run(call) { // add-run
                                        val json = try {
                                            engine().addGroupMember(conversationId, userId, selfUserId, bundles, expectedAfter = preview.expectedAfter, prompted = true)
                                        } finally {
                                            release()
                                        }
                                        resolveJson(call, json)
                                    }
                                }
                            })
                            .setOnCancelListener { // add-cancel
                                if (answered.compareAndSet(false, true)) { // add-cancel-claim
                                    noteGrowthDecline(conversationId)
                                    release() // add-cancel-release
                                    call.reject("{\\"type\\":\\"declined\\"}")
                                }
                            }
                            .setOnDismissListener(DialogInterface.OnDismissListener { // add-dismiss
                                growthDialog = null
                                if (answered.compareAndSet(false, true)) {
                                    noteGrowthDecline(conversationId) // add-note-decline
                                    release()
                                    call.reject("{\\"type\\":\\"declined\\"}")
                                }
                            })
                            .create()
                        dialog.setOnShowListener {
                            dialog.getButton(AlertDialog.BUTTON_POSITIVE)?.apply { // add-button
                                filterTouchesWhenObscured = true // add-filter
                                isEnabled = false // add-disable
                                postDelayed({ isEnabled = true }, GROWTH_CONFIRM_DELAY_MS) // add-delay
                            }
                        }
                        dialog.show()
                        growthDialog = dialog // add-track
                    }
                } else {
                    try {
                        resolveJson(call, engine().addGroupMember(conversationId, userId, selfUserId, bundles, preview.expectedAfter, false)) // add-commit-direct
                    } finally {
                        release()
                    }
                }
            } catch (error: Throwable) {
                release()
                rejectScrubbed(call, error)
            }
        }
    }

    override fun handleOnDestroy() {
        growthDialog?.dismiss() // destroy-dismiss
        growthDialog = null
        super.handleOnDestroy()
    }
}
`;

const ktFixture = (...swaps: [string, string][]) => swapped(KT_FIXTURE, swaps);

test("kotlin scanner: a conforming fixture has no violations", () => {
  assert.deepEqual(ktViolations(ktFixture()), []);
});

test("kotlin scanner: equivalent shapes still conform", () => {
  const variants: [string, string][][] = [
    [
      [
        "if (!prompt.needsPrompt) { // enable-no-prompt",
        "if (prompt.needsPrompt == false) {",
      ],
    ],
    [
      [
        ".setNegativeButton(prompt.cancelLabel, null) // enable-negative",
        '.setNegativeButton(prompt.cancelLabel) { _, _ -> if (settled.compareAndSet(false, true)) { growthInFlight.set(false); call.reject("x") } }',
      ],
    ],
    // K5: a direct release in place of the helper; a commit held in a val.
    [
      ["release() // add-cancel-release", "growthInFlight.set(false)"],
      [
        "resolveJson(call, engine().enableGroup(conversationId, roster, selfUserId, bundles, prompt.expectedAfter, true)) // enable-commit-confirmed",
        "val json = engine().enableGroup(conversationId, roster, selfUserId, bundles, prompt.expectedAfter, true)\ngrowthInFlight.set(false)\nresolveJson(call, json)",
      ],
    ],
    // K9: a named let binding; the setter spelling.
    [
      ["?.apply { // add-button", "?.let { button ->"],
      [
        "filterTouchesWhenObscured = true // add-filter",
        "button.setFilterTouchesWhenObscured(true)",
      ],
      ["isEnabled = false // add-disable", "button.isEnabled = false"],
      [
        "postDelayed({ isEnabled = true }, GROWTH_CONFIRM_DELAY_MS) // add-delay",
        "button.postDelayed({ button.isEnabled = true }, GROWTH_CONFIRM_DELAY_MS)",
      ],
    ],
  ];
  for (const swaps of variants) {
    assert.deepEqual(ktViolations(ktFixture(...swaps)), [], swaps[0][1]);
  }
});

test("kotlin scanner: each rule fires on its own violation", () => {
  const cases: [string, [string, string][], RegExp][] = [
    [
      "K1: a generic arm is back",
      [
        [
          '"e2ee_status" ->',
          '"e2ee_enable_group" -> resolveJson(call, "null")\n"e2ee_status" ->',
        ],
      ],
      /^K1 call\(\) still names e2ee_enable_group/,
    ],
    [
      "K1+K3: a generic arm that commits",
      [
        [
          '"e2ee_status" ->',
          '"e2ee_add_group_member" -> resolveJson(call, engine.addGroupMember(a, b, c, d))\n"e2ee_status" ->',
        ],
      ],
      /^K3 addGroupMember referenced at line \d+, outside/,
    ],
    [
      "K2: the add method renamed",
      [
        [
          "fun addGroupMember(call: PluginCall)",
          "fun addMember(call: PluginCall)",
        ],
      ],
      /^K2 addGroupMember: expected exactly one definition, found 0/,
    ],
    [
      "K2: not a @PluginMethod",
      [["@PluginMethod\n    fun enableGroup(", "fun enableGroup("]],
      /^K2 enableGroup: not annotated @PluginMethod/,
    ],
    [
      "K3: the confirmed commit moved off the positive button",
      [
        [
          ".setPositiveButton(prompt.confirmLabel) { _, _ -> // enable-positive",
          ".also { _ ->",
        ],
      ],
      /^K3 enableGroup: engine enableGroup\( at line \d+ is outside/,
    ],
    [
      "K3: a commit in the button LABEL argument runs at build time",
      [
        [
          ".setPositiveButton(preview.confirmLabel, DialogInterface",
          ".setPositiveButton(engine().addGroupMember(c, u, s, b, preview.expectedAfter, true), DialogInterface",
        ],
      ],
      /^K3 addGroupMember: engine addGroupMember\( at line \d+ is outside/,
    ],
    [
      "K3: a commit helper outside the plugin methods",
      [
        [
          "private fun engine() =",
          "private fun commit() = engine().enableGroup(a, b, c, d, e, true)\n    private fun engine() =",
        ],
      ],
      /^K3 enableGroup referenced at line \d+, outside/,
    ],
    [
      "K3: a commented-out no-prompt commit does not count",
      [
        [
          "resolveJson(call, engine().enableGroup(conversationId, roster, selfUserId, bundles, prompt.expectedAfter, false)) // enable-commit-direct",
          '// engine().enableGroup(conversationId, roster, selfUserId, bundles, prompt.expectedAfter, false)\nresolveJson(call, "null")',
        ],
      ],
      /^K3 enableGroup: no engine commit in the !needsPrompt branch/,
    ],
    [
      "K3: a widened no-prompt condition",
      [
        [
          "if (!prompt.needsPrompt) { // enable-no-prompt",
          "if (!prompt.needsPrompt || force) {",
        ],
      ],
      /^K3 enableGroup: engine enableGroup\( at line \d+ is outside/,
    ],
    [
      "K3: a confirmed commit claiming prompted = false",
      [
        [
          "prompt.expectedAfter, true)) // enable-commit-confirmed",
          "prompt.expectedAfter, false))",
        ],
      ],
      /^K3 enableGroup: the positive-button commit at line \d+ must pass prompted = true/,
    ],
    [
      "K3: a direct commit claiming prompted = true",
      [
        [
          "preview.expectedAfter, false)) // add-commit-direct",
          "preview.expectedAfter, true))",
        ],
      ],
      /^K3 addGroupMember: the no-prompt commit at line \d+ must pass prompted = false/,
    ],
    [
      "K4: expectedAfter taken from call data",
      [
        [
          "prompt.expectedAfter, true)) // enable-commit-confirmed",
          'call.getArray("expectedAfter")!!.toList<String>(), true))',
        ],
      ],
      /^K4 enableGroup: the commit at line \d+ does not pass prompt\.expectedAfter/,
    ],
    [
      "K4: the expectedAfter key read anywhere",
      [
        [
          "val names = displayNamesOf(call)",
          'val names = displayNamesOf(call)\n        val after = call.getArray("expectedAfter")',
        ],
      ],
      /^K4 the string "expectedAfter" appears/,
    ],
    [
      "K4: a second preview",
      [
        [
          "if (!prompt.needsPrompt) { // enable-no-prompt",
          "engine().previewGroupEnable(conversationId, roster, selfUserId, names)\nif (!prompt.needsPrompt) {",
        ],
      ],
      /^K4 enableGroup: expected exactly one previewGroupEnable\( call, found 2/,
    ],
    [
      "K5: a reassignable guard is not a plugin-level val",
      [
        [
          "private val growthInFlight = AtomicBoolean(false)",
          "private var growthInFlight = AtomicBoolean(false)",
        ],
      ],
      /^K5 enableGroup: no plugin-level/,
    ],
    [
      "K5: the add method claims a different guard",
      [
        [
          "private val growthInFlight = AtomicBoolean(false)",
          "private val growthInFlight = AtomicBoolean(false)\n    private val addInFlight = AtomicBoolean(false)",
        ],
        [
          "if (!growthInFlight.compareAndSet(false, true)) { // add-busy",
          "if (!addInFlight.compareAndSet(false, true)) {",
        ],
      ],
      /^K5 addGroupMember: no plugin-level/,
    ],
    [
      "K5: a guard inside an inner class is not plugin-level",
      [
        [
          "private val growthInFlight = AtomicBoolean(false)",
          "private inner class Holder {\n        val growthInFlight = AtomicBoolean(false)\n    }",
        ],
      ],
      /^K5 enableGroup: no plugin-level/,
    ],
    [
      "K5: a qualified receiver may be a fresh guard per call",
      [
        [
          "if (!growthInFlight.compareAndSet(false, true)) { // add-busy",
          "if (!Holder().growthInFlight.compareAndSet(false, true)) {",
        ],
      ],
      /^K5 addGroupMember: no plugin-level/,
    ],
    [
      "K5: the guard claimed after the preview",
      [
        [
          "if (!growthInFlight.compareAndSet(false, true)) { // add-busy",
          "if (labels.isEmpty()) {",
        ],
        [
          "if (preview.needsPrompt) { // add-needs-prompt",
          "if (!growthInFlight.compareAndSet(false, true)) return@execute\nif (preview.needsPrompt) {",
        ],
      ],
      /^K5 addGroupMember: growthInFlight\.compareAndSet runs after the preview/,
    ],
    [
      "K5: a cancel listener that settles without releasing (the old fixture's shape)",
      [
        [
          'if (answered.compareAndSet(false, true)) { // add-cancel-claim\n                                    noteGrowthDecline(conversationId)\n                                    release() // add-cancel-release\n                                    call.reject("{\\"type\\":\\"declined\\"}")\n                                }',
          'if (answered.compareAndSet(false, true)) call.reject("{\\"type\\":\\"declined\\"}")',
        ],
      ],
      /^K5 addGroupMember: call\.reject\( at line \d+ settles the call without releasing growthInFlight/,
    ],
    [
      "K5: a dismiss listener that settles without releasing",
      [["growthInFlight.set(false) // enable-dismiss-release", ""]],
      /^K5 enableGroup: call\.reject\( at line \d+ settles the call without releasing/,
    ],
    [
      "K5: a release after the settle does not count",
      [
        ["growthInFlight.set(false) // enable-dismiss-release", ""],
        [
          'call.reject("{\\"type\\":\\"declined\\"}") // enable-declined',
          'call.reject("{\\"type\\":\\"declined\\"}")\ngrowthInFlight.set(false)',
        ],
      ],
      /^K5 enableGroup: call\.reject\( at line \d+ settles the call without releasing/,
    ],
    [
      "K5: a release under a condition does not count",
      [["release() // add-cancel-release", "if (labels.isEmpty()) release()"]],
      /^K5 addGroupMember: call\.reject\( at line \d+ settles the call without releasing/,
    ],
    [
      "K5: a finally across a lambda boundary does not count",
      [
        ["growthInFlight.set(false) // enable-dismiss-release", ""],
        [
          "activity.runOnUiThread { // enable-ui",
          "try {\nactivity.runOnUiThread {",
        ],
        ["} // enable-ui-end", "}\n} finally {\ngrowthInFlight.set(false)\n}"],
      ],
      /^K5 enableGroup: call\.reject\( at line \d+ settles the call without releasing/,
    ],
    [
      "K5: a release helper that does not release",
      [
        [
          "if (held.compareAndSet(true, false)) growthInFlight.set(false) // add-release-helper",
          'if (held.compareAndSet(true, false)) Log.d("E2ee", "released")',
        ],
      ],
      /^K5 addGroupMember: never releases growthInFlight/,
    ],
    [
      "K5: a run(call) body that can throw before it releases",
      [["run(call) { // add-run", "run(call) {\nval warm = engine().status()"]],
      /^K5 addGroupMember: run\(call\) at line \d+ rejects if its body throws/,
    ],
    [
      "K6: no dismiss listener",
      [[".setOnDismissListener { // enable-dismiss", ".setOnCancelListener {"]],
      /^K6 enableGroup: no setOnDismissListener/,
    ],
    [
      "K6: the dismiss listener is not resolve-once",
      [
        [
          "if (settled.compareAndSet(false, true)) { // enable-dismiss-claim",
          "if (true) {",
        ],
      ],
      /^K6 enableGroup: no OnDismissListener that claims/,
    ],
    [
      "K6: the dismiss listener does not reject declined",
      [
        [
          'call.reject("{\\"type\\":\\"declined\\"}") // enable-declined',
          'resolveJson(call, "null")',
        ],
      ],
      /^K6 enableGroup: no OnDismissListener that claims/,
    ],
    [
      "K6: the confirmed commit is not behind the once guard",
      [
        [
          "if (settled.compareAndSet(false, true)) { // enable-positive-claim",
          "if (true) {",
        ],
      ],
      /^K6 enableGroup: the positive-button commit at line \d+ is not behind settled/,
    ],
    [
      "K6: a cancel listener that settles without the once guard",
      [
        [
          "if (answered.compareAndSet(false, true)) { // add-cancel-claim",
          "if (true) {",
        ],
      ],
      /^K6 addGroupMember: setOnCancelListener at line \d+ settles the call/,
    ],
    [
      "K7: a taken guard rejects the wrong type",
      [
        [
          'call.reject("{\\"type\\":\\"busy\\"}") // enable-busy',
          'call.reject("{\\"type\\":\\"declined\\"}")',
        ],
      ],
      /^K7 enableGroup: the taken-guard branch must reject/,
    ],
    [
      "K7: a taken guard falls through to the preview",
      [["return // enable-busy-return", ""]],
      /^K7 enableGroup: the taken-guard branch must reject/,
    ],
    [
      "K8: the lockout check is gone",
      [
        [
          "if (growthLockedOut(conversationId)) { // enable-lockout",
          "if (false) {",
        ],
      ],
      /^K8 enableGroup: no `if \(growthLockedOut\(conversationId\)\)` lockout check/,
    ],
    [
      "K8: the lockout keyed on the wrong id",
      [
        [
          "if (growthLockedOut(conversationId)) { // add-lockout",
          "if (growthLockedOut(userId)) {",
        ],
      ],
      /^K8 addGroupMember: no `if \(growthLockedOut\(conversationId\)\)`/,
    ],
    [
      "K8: the lockout check behind another condition",
      [
        [
          "if (growthLockedOut(conversationId)) { // enable-lockout",
          "if (names.isEmpty()) if (growthLockedOut(conversationId)) {",
        ],
      ],
      /^K8 enableGroup: the growthLockedOut\(conversationId\) check at line \d+ is not a statement/,
    ],
    [
      "K8: the lockout check inside the dialog's runOnUiThread",
      [
        [
          "if (growthLockedOut(conversationId)) { // add-lockout",
          "if (labels.isEmpty()) { // add-lockout",
        ],
        [
          "val answered = AtomicBoolean(false)",
          'val answered = AtomicBoolean(false)\nif (growthLockedOut(conversationId)) {\nrelease()\ncall.reject("{\\"type\\":\\"busy\\"}")\nreturn@runOnUiThread\n}',
        ],
      ],
      /^K8 addGroupMember: the growthLockedOut\(conversationId\) check at line \d+ is not a statement/,
    ],
    [
      "K8: a lockout that rejects the wrong type",
      [
        [
          'call.reject("{\\"type\\":\\"busy\\"}") // add-lockout-busy',
          'call.reject("{\\"type\\":\\"declined\\"}")',
        ],
      ],
      /^K8 addGroupMember: the lockout branch must reject/,
    ],
    [
      "K8: a dismiss that does not start the lockout",
      [["noteGrowthDecline(conversationId) // enable-note-decline", ""]],
      /^K8 enableGroup: the dismiss listener does not call noteGrowthDecline\(conversationId\)/,
    ],
    [
      "K8: a decline noted outside the resolve-once branch",
      [
        ["noteGrowthDecline(conversationId) // add-note-decline", ""],
        [
          ".setOnDismissListener(DialogInterface.OnDismissListener { // add-dismiss",
          ".setOnDismissListener(DialogInterface.OnDismissListener {\nnoteGrowthDecline(conversationId)",
        ],
      ],
      /^K8 addGroupMember: the dismiss listener does not call noteGrowthDecline/,
    ],
    [
      "K8: the dialog is never recorded for teardown",
      [["growthDialog = dialog // add-track", ""]],
      /^K8 addGroupMember: never records its dialog in growthDialog/,
    ],
    [
      "K8: teardown does not dismiss the dialog",
      [["growthDialog?.dismiss() // destroy-dismiss", ""]],
      /^K8 handleOnDestroy\(\) does not dismiss growthDialog/,
    ],
    [
      "K8: no teardown hook",
      [["override fun handleOnDestroy()", "override fun handleOnPause()"]],
      /^K8 expected one handleOnDestroy\(\) with a body, found 0/,
    ],
    [
      "K9: no touch filter",
      [["confirm.filterTouchesWhenObscured = true // enable-filter", ""]],
      /^K9 enableGroup: the positive button taken at line \d+ lacks filterTouchesWhenObscured = true/,
    ],
    [
      "K9: the touch filter switched off",
      [
        [
          "filterTouchesWhenObscured = true // add-filter",
          "filterTouchesWhenObscured = false",
        ],
      ],
      /^K9 addGroupMember: .* lacks filterTouchesWhenObscured = true/,
    ],
    [
      "K9: the button is never disabled",
      [["confirm.isEnabled = false // enable-disable", ""]],
      /^K9 enableGroup: .* lacks isEnabled = false outside postDelayed\(/,
    ],
    [
      "K9: the button disabled only after the delay",
      [
        ["isEnabled = false // add-disable", ""],
        [
          "postDelayed({ isEnabled = true }, GROWTH_CONFIRM_DELAY_MS) // add-delay",
          "postDelayed({ isEnabled = false; isEnabled = true }, GROWTH_CONFIRM_DELAY_MS)",
        ],
      ],
      /^K9 addGroupMember: .* lacks isEnabled = false outside postDelayed\(/,
    ],
    [
      "K9: re-enabled at once, no delay",
      [
        [
          "confirm.postDelayed({ confirm.isEnabled = true }, 700L) // enable-delay",
          "confirm.isEnabled = true",
        ],
      ],
      /^K9 enableGroup: .* lacks isEnabled = true inside a postDelayed\(/,
    ],
    [
      "K9: the delayed re-enable is of another button",
      [
        [
          "confirm.postDelayed({ confirm.isEnabled = true }, 700L) // enable-delay",
          "confirm.postDelayed({ other.isEnabled = true }, 700L)",
        ],
      ],
      /^K9 enableGroup: .* lacks isEnabled = true inside a postDelayed\(/,
    ],
    [
      "K9: a literal delay under the floor",
      [["}, 700L) // enable-delay", "}, 100L)"]],
      /^K9 enableGroup: .* lacks a postDelayed\( delay of at least 700 ms/,
    ],
    [
      "K9: a constant delay under the floor",
      [
        [
          "private const val GROWTH_CONFIRM_DELAY_MS: Long = 700L",
          "private const val GROWTH_CONFIRM_DELAY_MS: Long = 0L",
        ],
      ],
      /^K9 addGroupMember: .* lacks a postDelayed\( delay of at least 700 ms/,
    ],
    [
      "K9: a delay that is not a literal or a val",
      [["GROWTH_CONFIRM_DELAY_MS) // add-delay", "delayMs())"]],
      /^K9 addGroupMember: .* lacks a postDelayed\( delay of at least 700 ms/,
    ],
    [
      "K9: the negative button is delayed instead",
      [
        [
          "dialog.getButton(AlertDialog.BUTTON_POSITIVE)?.apply { // add-button",
          "dialog.getButton(AlertDialog.BUTTON_NEGATIVE)?.apply {",
        ],
      ],
      /^K9 addGroupMember: no setOnShowListener that takes getButton/,
    ],
    [
      "K9: no show listener",
      [
        [
          "dialog.setOnShowListener { // enable-show",
          "dialog.setOnKeyListener {",
        ],
      ],
      /^K9 enableGroup: no setOnShowListener$/,
    ],
  ];
  for (const [label, swaps, expected] of cases) {
    assertFires(label, ktViolations(ktFixture(...swaps)), expected);
  }
});

test("kotlin scanner: taps, reflection and early enables still conform when they are not code", () => {
  const variants: [string, string][][] = [
    // K3: in a comment or a string.
    [
      [
        "confirm.filterTouchesWhenObscured = true // enable-filter",
        'confirm.filterTouchesWhenObscured = true // never confirm.performClick()\n                        Log.d("E2ee", "getMethod( .javaClass.methods callBy(")',
      ],
    ],
    // K9: a disable anywhere; a long trailing-lambda postDelayed; an enable
    // in a helper neither method calls.
    [
      [
        "confirm.isEnabled = false // enable-disable",
        "confirm.isEnabled = false\n                        confirm.setEnabled(false)\n                        handler.postDelayed(700L) { confirm.isEnabled = true }",
      ],
      [
        "private fun engine() =",
        "private fun restoreReady(button: Button) {\n        button.isEnabled = true\n    }\n    private fun engine() =",
      ],
    ],
    // K9: another dialog's enable, in a function only an unreferenced
    // plugin method calls (the restore dialog's shape); a delay constant
    // naming another.
    [
      [
        "private fun engine() =",
        "@PluginMethod\n    fun backupRestore(call: PluginCall) {\n        showRestore(call)\n    }\n\n    private fun showRestore(call: PluginCall) {\n        restoreButton.isEnabled = true\n    }\n\n    private fun engine() =",
      ],
      [
        "private const val GROWTH_CONFIRM_DELAY_MS: Long = 700L",
        "private const val BASE_DELAY_MS: Long = 700L\n\nprivate const val GROWTH_CONFIRM_DELAY_MS: Long = BASE_DELAY_MS",
      ],
    ],
  ];
  for (const swaps of variants) {
    assert.deepEqual(ktViolations(ktFixture(...swaps)), [], swaps[0][1]);
  }
});

test("kotlin scanner: taps, reflection and early enables fire, and only their rule", () => {
  // [label (its rule first), swaps, expected violation]
  const cases: [string, [string, string][], RegExp][] = [
    [
      "K3: Confirm clicked from the show listener",
      [
        [
          "confirm.filterTouchesWhenObscured = true // enable-filter",
          "confirm.filterTouchesWhenObscured = true\n                        confirm.performClick()",
        ],
      ],
      /^K3 performClick\( at line \d+ acts on a view from code/,
    ],
    [
      "K3: callOnClick",
      [
        [
          "isEnabled = false // add-disable",
          "isEnabled = false\n                                callOnClick()",
        ],
      ],
      /^K3 callOnClick\( at line \d+ acts on a view from code/,
    ],
    [
      "K3: an accessibility click",
      [
        [
          "growthDialog = dialog // add-track",
          "growthDialog = dialog\n                        dialog.getButton(AlertDialog.BUTTON_POSITIVE).performAccessibilityAction(AccessibilityNodeInfo.ACTION_CLICK, null)",
        ],
      ],
      /^K3 performAccessibilityAction\( at line \d+ acts on a view from code/,
    ],
    [
      "K3: a synthetic touch from a helper outside the methods",
      [
        [
          "private fun engine() =",
          "private fun tap(button: View) = button.dispatchTouchEvent(down)\n    private fun engine() =",
        ],
      ],
      /^K3 dispatchTouchEvent\( at line \d+ acts on a view from code/,
    ],
    [
      "K3: a reflective commit in call()",
      [
        [
          '"e2ee_status" ->',
          '"e2ee_x" -> engine.javaClass.methods.first { it.name == "enableGroup" }.invoke(engine, a, b, c)\n"e2ee_status" ->',
        ],
      ],
      /^K3 reflection \(\.javaClass\.methods\) at line \d+/,
    ],
    [
      "K3: reflection by getMethod",
      [
        [
          '"e2ee_status" ->',
          '"e2ee_x" -> engine.javaClass.getMethod("enableGroup", A::class.java).invoke(engine, a)\n"e2ee_status" ->',
        ],
      ],
      /^K3 reflection \(getMethod\(\) at line \d+/,
    ],
    [
      "K3: reflection by getDeclaredMethod",
      [
        [
          '"e2ee_status" ->',
          '"e2ee_x" -> E2eeEngine::class.java.getDeclaredMethod(name).invoke(engine)\n"e2ee_status" ->',
        ],
      ],
      /^K3 reflection \(getDeclaredMethod\(\) at line \d+/,
    ],
    [
      "K3: reflection by ::class.java.methods",
      [
        [
          '"e2ee_status" ->',
          '"e2ee_x" -> E2eeEngine::class.java.methods.single { it.name == name }\n"e2ee_status" ->',
        ],
      ],
      /^K3 reflection \(::class\.java\.methods\) at line \d+/,
    ],
    [
      "K3: reflection by .methods.first",
      [
        [
          '"e2ee_status" ->',
          '"e2ee_x" -> engineType.methods.first { it.name == name }.invoke(engine)\n"e2ee_status" ->',
        ],
      ],
      /^K3 reflection \(\.methods\) at line \d+/,
    ],
    [
      "K3: reflection by KFunction",
      [
        [
          "private fun engine() =",
          "private val commit: KFunction<*>? = null\n    private fun engine() =",
        ],
      ],
      /^K3 reflection \(KFunction\) at line \d+/,
    ],
    [
      "K3: reflection by callBy",
      [
        [
          '"e2ee_status" ->',
          '"e2ee_x" -> commit.callBy(args)\n"e2ee_status" ->',
        ],
      ],
      /^K3 reflection \(callBy\(\) at line \d+/,
    ],
    [
      "K9: Confirm enabled at once after the disable",
      [
        [
          "confirm.isEnabled = false // enable-disable",
          "confirm.isEnabled = false\n                        confirm.isEnabled = true",
        ],
      ],
      /^K9 enableGroup: isEnabled = true at line \d+ is outside a postDelayed\( of at least 700 ms/,
    ],
    [
      "K9: Confirm enabled by the setter",
      [
        [
          "isEnabled = false // add-disable",
          "isEnabled = false\n                                setEnabled(true)",
        ],
      ],
      /^K9 addGroupMember: isEnabled = true at line \d+ is outside a postDelayed\(/,
    ],
    [
      "K9: a second, short postDelayed enables early",
      [
        [
          "isEnabled = false // add-disable",
          "isEnabled = false\n                                postDelayed({ isEnabled = true }, 50L)",
        ],
      ],
      /^K9 addGroupMember: isEnabled = true at line \d+ is outside a postDelayed\( of at least 700 ms/,
    ],
    [
      "K9: a helper outside the methods enables Confirm",
      [
        [
          "private fun engine() =",
          "private fun unlock(button: Button) {\n        button.isEnabled = true\n    }\n    private fun engine() =",
        ],
        [
          "confirm.isEnabled = false // enable-disable",
          "confirm.isEnabled = false\n                        unlock(confirm)",
        ],
      ],
      /^K9 enableGroup: calls unlock at line \d+, which enables a view/,
    ],
    // Every tap name, called and referenced (`confirm.let(View::name)`).
    ...TAP_NAMES.flatMap((name): [string, [string, string][], RegExp][] => [
      [
        `K3: a ::${name} function reference`,
        [
          [
            "confirm.filterTouchesWhenObscured = true // enable-filter",
            `confirm.filterTouchesWhenObscured = true\n                        confirm.let(View::${name})`,
          ],
        ],
        new RegExp(String.raw`^K3 ::${name} at line \d+ acts on a view`),
      ],
      [
        `K3: a ${name}( call`,
        [
          [
            "confirm.filterTouchesWhenObscured = true // enable-filter",
            `confirm.filterTouchesWhenObscured = true\n                        confirm.${name}(event)`,
          ],
        ],
        new RegExp(String.raw`^K3 ${name}\( at line \d+ acts on a view`),
      ],
    ]),
    [
      "K3: Confirm clicked through run and a reference",
      [
        [
          "isEnabled = false // add-disable",
          "isEnabled = false\n                                run(View::callOnClick)",
        ],
      ],
      /^K3 ::callOnClick at line \d+ acts on a view/,
    ],
    [
      "K9: a stored lambda enables Confirm",
      [
        [
          "private fun engine() =",
          "private val unlockNow: (View) -> Unit = { it.isEnabled = true }\n    private fun engine() =",
        ],
        [
          "confirm.isEnabled = false // enable-disable",
          "confirm.isEnabled = false\n                        unlockNow(confirm)",
        ],
      ],
      /^K9 isEnabled = true at line \d+ is outside any function body \(a stored enabler\)/,
    ],
    [
      "K9: a stored lambda enables Confirm through invoke",
      [
        [
          "private fun engine() =",
          "private val unlockNow = { button: View -> button.setEnabled(true) }\n    private fun engine() =",
        ],
        [
          "isEnabled = false // add-disable",
          "isEnabled = false\n                                unlockNow.invoke(this)",
        ],
      ],
      /^K9 isEnabled = true at line \d+ is outside any function body \(a stored enabler\)/,
    ],
    [
      "K9: an extension property setter enables Confirm",
      [
        [
          "private fun engine() =",
          "private var View.ready: Boolean\n        get() = isEnabled\n        set(v) { isEnabled = v }\n    private fun engine() =",
        ],
        [
          "confirm.isEnabled = false // enable-disable",
          "confirm.isEnabled = false\n                        confirm.ready = true",
        ],
      ],
      /^K9 isEnabled = v at line \d+ is outside any function body \(a stored enabler\)/,
    ],
    [
      "K9: an enabling function named by a stored lambda",
      [
        [
          "private fun engine() =",
          "private fun unlock(button: View) {\n        button.isEnabled = true\n    }\n    private val opener = { button: View -> unlock(button) }\n    private fun engine() =",
        ],
      ],
      /^K9 isEnabled = true at line \d+ in unlock, which consent code can reach/,
    ],
    [
      "K9: an enabling function called qualified from a growth method",
      [
        [
          "private fun engine() =",
          "private fun unlock(button: View) {\n        button.isEnabled = true\n    }\n    private fun engine() =",
        ],
        [
          "confirm.isEnabled = false // enable-disable",
          "confirm.isEnabled = false\n                        this.unlock(confirm)",
        ],
      ],
      /^K9 isEnabled = true at line \d+ in unlock, which consent code can reach/,
    ],
    [
      "K9: a delay constant computed, not read",
      [
        [
          "private const val GROWTH_CONFIRM_DELAY_MS: Long = 700L",
          "private const val GROWTH_CONFIRM_DELAY_MS: Long = 700L / 7",
        ],
      ],
      /^K9 addGroupMember: .* lacks a postDelayed\( delay of at least 700 ms/,
    ],
  ];
  for (const [label, swaps, expected] of cases) {
    const found = ktViolations(ktFixture(...swaps));
    assertFires(label, found, expected);
    const rule = label.split(":")[0];
    assert.deepEqual(
      found.filter((v) => !v.startsWith(`${rule} `)),
      [],
      `${label}: fired outside ${rule}: ${JSON.stringify(found, null, 2)}`,
    );
  }
});

const TS_FIXTURE = `
class CapacitorTransport implements NativeTransport {
  #plugin = registerPlugin<E2eeCapacitorPlugin>("E2ee");

  async invoke<T>(
    command: string,
    args?: Record<string, unknown> | Uint8Array,
  ): Promise<T> {
    try {
      if (command === "e2ee_downgrade") {
        const { json } = await this.#plugin.downgrade(
          (args as Record<string, unknown>) ?? {},
        );
        return JSON.parse(json) as T;
      }
      // if (command === "e2ee_enable_group") in a comment is not a route
      if (command === "e2ee_enable_group") {
        const { json } = await this.#plugin.enableGroup(
          (args as Record<string, unknown>) ?? {},
        );
        return JSON.parse(json) as T;
      }
      if ("e2ee_add_group_member" === command) {
        const { json } = await this.#plugin.addGroupMember({
          ...(args as Record<string, unknown>),
        });
        return JSON.parse(json) as T;
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
  async enableGroupEncryption(
    channel: Channel,
    roster: string[],
  ): Promise<GroupGrowthOutcome> {
    const displayNames = labelsFor(roster);
    const result = await this.#invoke<EncryptResult>("e2ee_enable_group", {
      conversationId: channel.id,
      roster,
      displayNames,
    });
    return "ok";
  }
}
`;

const ADD_METHOD = `
  async addGroupMemberEncrypted(channel: Channel, userId: string) {
    await this.#invoke("e2ee_add_group_member", {
      conversationId: channel.id,
      userId,
      displayNames: labelsFor([userId]),
    });
  }
}
`;

const tsFixture = (...swaps: [string, string][]) => swapped(TS_FIXTURE, swaps);

test("ts scanner: a conforming fixture has no violations", () => {
  assert.deepEqual(tsViolations(tsFixture()), []);
  const withAdd = tsFixture([
    'return "ok";\n  }\n}',
    `return "ok";\n  }${ADD_METHOD}`,
  ]);
  assert.deepEqual(tsViolations(withAdd), []);
});

test("ts scanner: each rule fires on its own violation", () => {
  const cases: [string, [string, string][], RegExp][] = [
    [
      "T8: no enable route",
      [
        [
          'if (command === "e2ee_enable_group") {',
          'if (command === "e2ee_enable_groups") {',
        ],
      ],
      /^T8 e2ee_enable_group: expected one .* found 0/,
    ],
    [
      "T8: the route calls the generic method",
      [["this.#plugin.enableGroup(", "this.#plugin.call("]],
      /^T8 e2ee_enable_group: the route does not call this\.#plugin\.enableGroup\(/,
    ],
    [
      "T8: the route rebuilds args without displayNames",
      [
        [
          "addGroupMember({\n          ...(args as Record<string, unknown>),\n        });",
          "addGroupMember({ conversationId: 1 });",
        ],
      ],
      /^T8 e2ee_add_group_member: #plugin\.addGroupMember\( does not forward args/,
    ],
    [
      "T8: a widened route condition",
      [
        [
          'if ("e2ee_add_group_member" === command) {',
          'if ("e2ee_add_group_member" === command && fast) {',
        ],
      ],
      /^T8 e2ee_add_group_member: expected one .* found 0/,
    ],
    [
      "T8: a route nested inside another if",
      [
        [
          'if (command === "e2ee_enable_group") {',
          'if (legacy) {\n      if (command === "e2ee_enable_group") {',
        ],
        [
          '      }\n      if ("e2ee_add_group_member" === command) {',
          '      }\n      }\n      if ("e2ee_add_group_member" === command) {',
        ],
      ],
      /^T8 e2ee_enable_group: the route is nested inside another if/,
    ],
    [
      "T9: the enable invoke drops displayNames",
      [["roster,\n      displayNames,", "roster,"]],
      /^T9 invoke\("e2ee_enable_group"\) at line \d+ does not pass displayNames/,
    ],
    [
      "T9: the command name through a variable",
      [
        [
          'this.#invoke<EncryptResult>("e2ee_enable_group", {',
          "this.#invoke<EncryptResult>(cmd, {",
        ],
        [
          "const displayNames = labelsFor(roster);",
          'const displayNames = labelsFor(roster);\n    const cmd = "e2ee_enable_group";',
        ],
      ],
      /^T9 "e2ee_enable_group" at line \d+ is neither/,
    ],
    [
      "T9: a different native call helper",
      [["this.#invoke<EncryptResult>(", "this.#call<EncryptResult>("]],
      /^T9 "e2ee_enable_group" at line \d+ is neither/,
    ],
    [
      "T9: an add method with no add invoke",
      [
        [
          'return "ok";\n  }\n}',
          `return "ok";\n  }${ADD_METHOD.replace('"e2ee_add_group_member"', '"e2ee_status"')}`,
        ],
      ],
      /^T9 addGroupMemberEncrypted: no invoke\("e2ee_add_group_member"/,
    ],
  ];
  for (const [label, swaps, expected] of cases) {
    assertFires(label, tsViolations(tsFixture(...swaps)), expected);
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
  ["K1", "call() has no e2ee_enable_group / e2ee_add_group_member arm"],
  ["K2", "@PluginMethod enableGroup and addGroupMember exist"],
  [
    "K3",
    "engine commits only in setPositiveButton or the !needsPrompt branch; no synthetic tap, no reflection",
  ],
  ["K4", "expectedAfter comes from the preview result"],
  [
    "K5",
    "a plugin-level AtomicBoolean guard in both, released before every settle",
  ],
  ["K6", "an OnDismissListener rejects declined behind a resolve-once guard"],
  ["K7", "a taken guard rejects busy"],
  ["K8", "the decline lockout is checked and started; teardown dismisses"],
  [
    "K9",
    "the positive button is input-delayed, never enabled early, and touch-filtered",
  ],
];

const TS_RULES: [string, string][] = [
  ["T8", "CapacitorTransport routes both commands to their plugin methods"],
  ["T9", "the native invokes pass displayNames"],
];

for (const [rule, title] of KT_RULES) {
  test(`E2eePlugin.kt ${rule}: ${title} (${String(KT_FILE)})`, () => {
    assert.deepEqual(ktFound(rule), []);
  });
}

for (const [rule, title] of TS_RULES) {
  test(`e2ee.ts ${rule}: ${title} (${String(TS_FILE)})`, () => {
    assert.deepEqual(tsFound(rule), []);
  });
}
