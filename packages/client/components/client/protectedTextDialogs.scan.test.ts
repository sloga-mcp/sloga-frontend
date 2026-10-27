// Source-scan spec for the protected-text plane on Android (S7 plan D2/D3,
// matrix rows C6b) - run with Node's built-in runner:
//   node --conditions=browser --test components/client/protectedTextDialogs.scan.test.ts
// Neither Kotlin file loads under Node, so the rules are pinned by reading
// the sources. Point `PROTECTED_TEXT_PLUGIN_KT` / `PROTECTED_TEXT_DIALOG_KT`
// at other copies (a known-bad control) to scan those instead; they must
// fail.
//
// Comments are stripped before every check, and string contents only count
// where a literal is the subject of the rule, so a commented-out guard never
// satisfies a rule and a comment naming a forbidden call never trips one.
//
// E2eePlugin.kt:
//   R1. TEXT_COMMANDS (protectedTextTypes.ts) equals the text arms of
//       `@PluginMethod fun call(` (an arm whose label is in TEXT_COMMANDS or
//       starts `e2ee_text_`, or whose body names `resolveText`) together
//       with the 3 dedicated dialog methods. Each dialog method is one
//       `@PluginMethod` whose whole body is
//       `runTextDialog(call) { a, c -> engine().<same name>(a, c) }`, and
//       nothing else names `runTextDialog`. No dialog command literal appears
//       anywhere in `call()`, and `resolveText` / `.text...(` appear in
//       `call()` only inside the text arms.
//   R2. Every text arm's whole body is
//       `resolveText(call) { engine.<camelCase command>(it) }`. `resolveText`
//       and `runTextDialog` each OPEN with
//       `if (!MessageHandler.usingWebMessageListener)` (MessageHandler
//       imported from com.getcapacitor, not shadowed or aliased), whose
//       branch refuses with the `unavailable` literal (resolveText throws,
//       runTextDialog rejects and returns). The engine call (`command(`) and
//       the slot claim come after it; resolveText touches the engine only
//       through `command(call.data.toString())`.
//   R2b. textCapability reports `listenerBridge` from the same flag.
//   R3. Nothing reachable through the file's own functions from a text arm,
//       resolveText, runTextDialog, the dialog methods or textCapability is
//       `emitKeysChanged` / `emitFromOutcome` or calls `notifyListeners`;
//       TextConfirmDialog.kt names none of the three.
//   R4. runTextDialog: a top-level
//       `if (!consentInFlight.compareAndSet(false, true))` that rejects
//       `busy` and returns; after it ONE `executor.execute` whose lambda
//       holds the ONE `command(` call, inside a `try` whose `finally`
//       releases; a `catch` of the `try` around `executor.execute` releases;
//       every release sits in a `finally` or a `catch`. A release is
//       `consentInFlight.set(false)`, or a call to a local no-argument
//       function whose whole body is that or
//       `if (H.compareAndSet(true, false)) consentInFlight.set(false)`
//       (`val H = AtomicBoolean(true)`).
//   R5. Exactly one `"e2ee_store_owner"` arm, resolving
//       `O?.let { JSONObject.quote(it) } ?: "null"` for
//       `O = engine.storeOwner()` (the iOS shape, plan D3 / RR-2).
//   R7. One `override fun handleOnDestroy()` that sets `T.destroyed = true`
//       and calls `T.dismissAll()` as top-level statements, `T` the plugin's
//       one `TextDialogs()`, the instance runTextDialog hands to
//       `TextConfirmDialog(`. The show runnable adds the dialog to its
//       `TextDialogs` before `show()`, `dismissAll` dismisses, and nothing
//       resets `destroyed` to false.
// TextConfirmDialog.kt (the `class ... : TextConfirm`; its "asker" is the
// function holding the `runOnUiThread` lambda that calls `show()`):
//   R6a. confirm returns the asker's answer and inform calls it. Before that
//        runOnUiThread, top-level in the asker: a main-looper `if` that
//        throws TextConfirmException; `val H = <activity>() ?: throw
//        TextConfirmException...`; an `if` over `dialogs.destroyed ||
//        H.isFinishing || H.isDestroyed` that throws. `show()` sits in a
//        `try` whose `catch` settles null, so does the runOnUiThread call,
//        and the asker returns `A.get() ?: throw TextConfirmException...`.
//   R6b. In the show runnable, in show()'s own block and before it, an `if`
//        over `dialogs.destroyed` that returns; `destroyed` is `@Volatile`.
//   R6c. A `CountDownLatch(1)` awaited in the asker outside every
//        runOnUiThread lambda; no `synchronized` / `@Synchronized` in code.
//   R6d. Settle once: a local `settle(v)` whose whole body is
//        `if (S.compareAndSet(false, true)) { A.set(v); L.countDown() }`
//        (`S = AtomicBoolean(false)`, `A = AtomicReference<Boolean?>(null)`),
//        holding the file's only `A.set(` and `L.countDown(`; no `S.set(`.
//        Every settle call passes `false` or `null`, except ONE `true`
//        inside a `setPositiveButton` listener lambda; no `return true`.
//   R6e. The positive button is disabled (`isEnabled = false`) as a
//        top-level statement of its block, and every enable
//        (`isEnabled = <not false>`, `setEnabled(<not false>)`) sits inside
//        a `postDelayed(` whose delay is a literal or `const val` >= 700.
//   R6f. `filterTouchesWhenObscured = true` on the positive AND the negative
//        button, after `show()` in the show runnable (or in a show
//        listener); never `= false`.
//   R6g. inform passes single = true and confirm single = false; the
//        `if (single)` branch sets exactly ONE button, not the positive one,
//        labelled `confirmLabel` with a null listener; the other branch a
//        positive (`confirmLabel`) and a negative (`cancelLabel`) button; no
//        button is set anywhere else. A top-level `if` before runOnUiThread
//        throws when any of title / message / confirmLabel / cancelLabel
//        `.isBlank()`.
//   R6h. No synthetic tap (`performClick` and kin) and no reflection.
//
// Every rule is checked against literal mutations of the real files (the
// `control ...` tests at the end), so a green rule is never a scanner that
// cannot fail. Those tests always read the committed files, never the env
// copies.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { TEXT_COMMANDS } from "./protectedTextTypes.ts";

const E2EE_DIR = "../../android/app/src/main/java/com/acutest/app/e2ee/";
const DEFAULT_PLUGIN = new URL(`${E2EE_DIR}E2eePlugin.kt`, import.meta.url);
const DEFAULT_DIALOG = new URL(
  `${E2EE_DIR}TextConfirmDialog.kt`,
  import.meta.url,
);
const PLUGIN_FILE = process.env.PROTECTED_TEXT_PLUGIN_KT || DEFAULT_PLUGIN;
const DIALOG_FILE = process.env.PROTECTED_TEXT_DIALOG_KT || DEFAULT_DIALOG;

/** The three dialog commands and their dedicated plugin methods (D3). */
const DIALOGS = [
  { command: "e2ee_text_seat_list_sign", method: "textSeatListSign" },
  {
    command: "e2ee_text_owner_confirm_change",
    method: "textOwnerConfirmChange",
  },
  {
    command: "e2ee_text_owner_handover_sign",
    method: "textOwnerHandoverSign",
  },
] as const;

const EMITS = ["emitKeysChanged", "emitFromOutcome"];
const MIN_DELAY_MS = 700;
const TEXT_SET = new Set<string>(TEXT_COMMANDS);

// ---- Shared helpers ---------------------------------------------------------

interface Masked {
  /** Comments and string contents blanked. */
  code: string;
  /** Comments blanked; string contents kept. */
  text: string;
}

/** Inclusive [start, end] index range in the source. */
type Span = [number, number];

/** Strictly between the span's ends (a block's braces excluded). */
const inside = (s: Span, i: number) => i > s[0] && i < s[1];

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
const UNAVAILABLE = typeLiteral("unavailable");

/** Index of the `{` of the innermost block holding `at`, or -1. */
function enclosingBrace(code: string, at: number): number {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    if (code[i] === "}") depth++;
    else if (code[i] === "{") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/** Start index of every match of the global `re` strictly inside `span`. */
function findAll(code: string, re: RegExp, span: Span): number[] {
  const out: number[] = [];
  for (const m of code.matchAll(re))
    if (inside(span, m.index)) out.push(m.index);
  return out;
}

/** The identifier at `at` is the name in a `fun` definition. */
const isDefinition = (code: string, at: number) =>
  /\bfun\s+$/.test(code.slice(Math.max(0, at - 12), at));

// ---- Kotlin lexer -----------------------------------------------------------

/**
 * Blanks Kotlin comments (block comments nest) and string / char contents
 * with spaces (newlines kept), so every index is the same index in `src`.
 * `${...}` templates inside strings are scanned as code. (The lexer of
 * `e2eeGroupGrowth.scan.test.ts`.)
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
  override: boolean;
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
    // Modifiers and annotations sit between the previous declaration and
    // this `fun`.
    const before = code.slice(previous, match.index);
    const boundary = Math.max(
      before.lastIndexOf("{"),
      before.lastIndexOf("}"),
      before.lastIndexOf(";"),
    );
    const head = before.slice(boundary + 1);
    out.push({
      name: match[1],
      at: match.index,
      params: code.slice(paren + 1, parenClose),
      annotated: /@PluginMethod\b/.test(head),
      override: /\boverride\b/.test(head),
      open,
      close: open < 0 ? -1 : matchClose(code, open),
      expr,
    });
    previous = match.index + 3;
  }
  return out;
}

interface Kt extends Masked {
  src: string;
  funs: KtFun[];
}

function ktLoad(src: string): Kt {
  const masked = maskKotlin(src);
  return { src, ...masked, funs: ktFunctions(masked) };
}

const blockOf = (f: KtFun): Span => [f.open, f.close];

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

/** The body of a function, block or expression; null when abstract. */
function funSpan(code: string, f: KtFun): Span | null {
  if (f.open >= 0) return blockOf(f);
  if (f.expr >= 0)
    return [f.expr, ktStatementEnd(code, skipWs(code, f.expr + 1))];
  return null;
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
    if (!inside(body, match.index)) continue;
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
 * `i` is a statement of `block` itself: not in a nested block, and not in
 * (or the condition of) a brace-less `if` / `else` branch.
 */
function topLevel(m: Masked, block: Span, i: number): boolean {
  if (enclosingBrace(m.code, i) !== block[0]) return false;
  return !ktIfs(m, block).some(
    (x) =>
      (i > x.at && i < x.then[0]) ||
      [x.then, x.otherwise].some((s) => s !== null && i >= s[0] && i <= s[1]),
  );
}

/** The `||` terms of a squashed condition; null when it has an `&&`. */
const orTerms = (cond: string): string[] | null =>
  cond.includes("&&") ? null : cond.split("||");

interface Invocation {
  /** Index of the callee name. */
  at: number;
  /** The argument list's `(` and `)`, if any. */
  args: Span | null;
  /** Lambda arguments and the trailing lambda. */
  lambdas: Span[];
}

/** Every call of `name` (not its definition) inside `span`. */
function invocations(code: string, name: string, span: Span): Invocation[] {
  const out: Invocation[] = [];
  for (const m of code.matchAll(
    new RegExp(String.raw`(?<![\w$])${name}\b`, "g"),
  )) {
    if (!inside(span, m.index) || isDefinition(code, m.index)) continue;
    let k = skipWs(code, m.index + name.length);
    let args: Span | null = null;
    const lambdas: Span[] = [];
    if (code[k] === "(") {
      const close = matchClose(code, k);
      args = [k, close];
      for (let j = k + 1; j < close; j++) {
        if (code[j] === "{") {
          const end = matchClose(code, j);
          lambdas.push([j, end]);
          j = end;
        } else if (code[j] === "(" || code[j] === "[") j = matchClose(code, j);
      }
      k = skipWs(code, close + 1);
    }
    if (code[k] === "{") lambdas.push([k, matchClose(code, k)]);
    if (args || lambdas.length > 0) out.push({ at: m.index, args, lambdas });
  }
  return out;
}

interface KtTry {
  block: Span;
  catches: Span[];
  fin: Span | null;
}

/** Every `try { ... }` inside `span`, with its catch and finally blocks. */
function ktTries(code: string, span: Span): KtTry[] {
  const out: KtTry[] = [];
  for (const m of code.matchAll(/\btry\s*\{/g)) {
    if (!inside(span, m.index)) continue;
    const open = m.index + m[0].length - 1;
    const block: Span = [open, matchClose(code, open)];
    const catches: Span[] = [];
    let j = skipWs(code, block[1] + 1);
    while (code.startsWith("catch", j) && !/\w/.test(code[j + 5] ?? "")) {
      const paren = skipWs(code, j + 5);
      const bodyOpen = skipWs(code, matchClose(code, paren) + 1);
      const bodyClose = matchClose(code, bodyOpen);
      catches.push([bodyOpen, bodyClose]);
      j = skipWs(code, bodyClose + 1);
    }
    let fin: Span | null = null;
    if (code.startsWith("finally", j) && !/\w/.test(code[j + 7] ?? "")) {
      const finOpen = skipWs(code, j + 7);
      fin = [finOpen, matchClose(code, finOpen)];
    }
    out.push({ block, catches, fin });
  }
  return out;
}

/** The one block-bodied `fun name`, or null with a violation. */
function oneFun(
  kt: Kt,
  name: string,
  v: string[],
  want: { annotated?: boolean; override?: boolean } = {},
): KtFun | null {
  const all = kt.funs.filter((f) => f.name === name);
  if (all.length !== 1) {
    v.push(`expected one \`fun ${name}\`, found ${all.length}`);
    return null;
  }
  const f = all[0];
  if (f.open < 0) {
    v.push(`\`fun ${name}\` has no block body`);
    return null;
  }
  if (want.annotated && !f.annotated) {
    v.push(`\`fun ${name}\` is not a @PluginMethod`);
  }
  if (want.override && !f.override)
    v.push(`\`fun ${name}\` is not an override`);
  return f;
}

// ---- E2eePlugin.kt: the call() arms ------------------------------------------

interface Arm {
  labels: string[];
  /** Index of the arm's first label. */
  at: number;
  /** From the `->` to just before the next arm. */
  body: Span;
}

const ARM_START = /(?:"[^"\n]*"\s*,\s*)*"[^"\n]*"\s*->|else\s*->/y;

/**
 * The arms of every outermost `when (...) { ... }` inside `within`: an arm
 * starts a line at the `when` block's own depth with string labels (or
 * `else`) and `->`, and runs to the next arm.
 */
function whenArms(kt: Kt, within: Span): Arm[] {
  const { code, text } = kt;
  const arms: Arm[] = [];
  let past = -1;
  for (const match of code.matchAll(/\bwhen\s*\(/g)) {
    if (!inside(within, match.index) || match.index < past) continue;
    const paren = match.index + match[0].length - 1;
    const open = skipWs(code, matchClose(code, paren) + 1);
    if (code[open] !== "{") continue;
    const close = matchClose(code, open);
    past = close;
    const starts: { at: number; arrow: number; labels: string[] }[] = [];
    let lineStart = true;
    for (let i = open + 1; i < close; i++) {
      const c = code[i];
      if (c === "\n") {
        lineStart = true;
        continue;
      }
      if (/\s/.test(c)) continue;
      const last = starts[starts.length - 1];
      if (lineStart && (!last || i > last.arrow)) {
        ARM_START.lastIndex = i;
        const arm = ARM_START.exec(text);
        if (arm) {
          starts.push({
            at: i,
            arrow: i + arm[0].length,
            labels: [...arm[0].matchAll(/"([^"\n]*)"/g)].map((l) => l[1]),
          });
        }
      }
      lineStart = false;
      if (c === "(" || c === "[" || c === "{") i = matchClose(code, i);
    }
    starts.forEach((s, k) => {
      const end = k + 1 < starts.length ? starts[k + 1].at : close;
      arms.push({ labels: s.labels, at: s.at, body: [s.arrow, end - 1] });
    });
  }
  return arms;
}

/** `e2ee_text_join` -> `textJoin` (the uniffi method name). */
const camel = (command: string) =>
  command
    .replace(/^e2ee_/, "")
    .replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

interface CallShape {
  fun: KtFun;
  arms: Arm[];
  /** Arms with a text label, or whose body names `resolveText`. */
  text: Arm[];
}

function callShape(p: Kt, v: string[]): CallShape | null {
  const fun = oneFun(p, "call", v, { annotated: true });
  if (!fun) return null;
  const arms = whenArms(p, blockOf(fun));
  if (arms.length === 0) {
    v.push("call(): no `when` arms found");
    return null;
  }
  const text = arms.filter(
    (a) =>
      a.labels.some((l) => TEXT_SET.has(l) || l.startsWith("e2ee_text_")) ||
      findAll(p.code, /(?<![\w$])resolveText\b/g, [
        a.body[0] - 1,
        a.body[1] + 1,
      ]).length > 0,
  );
  return { fun, arms, text };
}

const armLine = (p: Kt, a: Arm) => `line ${lineOf(p.src, a.at)}`;

// ---- E2eePlugin.kt rules -----------------------------------------------------

function checkR1(p: Kt): string[] {
  const v: string[] = [];
  const shape = callShape(p, v);
  const dialogFuns: KtFun[] = [];
  const dialogCommands: string[] = [];
  for (const d of DIALOGS) {
    const f = oneFun(p, d.method, v, { annotated: true });
    if (!f) continue;
    dialogFuns.push(f);
    const whole = new RegExp(
      String.raw`^\{runTextDialog\(call\)\{(\w+),(\w+)->engine\(\)\.${d.method}\(\1,\2\)\}\}$`,
    );
    if (whole.test(squash(p.code.slice(f.open, f.close + 1)))) {
      dialogCommands.push(d.command);
    } else {
      v.push(
        `${d.method}: body is not \`runTextDialog(call) { a, c -> engine().${d.method}(a, c) }\``,
      );
    }
  }
  for (const m of p.code.matchAll(/(?<![\w$])runTextDialog\b/g)) {
    if (isDefinition(p.code, m.index)) continue;
    if (!dialogFuns.some((f) => inside(blockOf(f), m.index))) {
      v.push(
        `line ${lineOf(p.src, m.index)}: runTextDialog named outside the three dialog methods`,
      );
    }
  }
  if (!shape) return v;

  const callBody = blockOf(shape.fun);
  const counts = new Map<string, number>();
  for (const a of shape.arms) {
    for (const l of a.labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  for (const [label, n] of counts) {
    if (n > 1) v.push(`call(): "${label}" has ${n} arms`);
  }

  for (const a of shape.text) {
    if (a.labels.length === 0) {
      v.push(`${armLine(p, a)}: the \`else\` arm reaches the text plane`);
    }
  }
  const armLabels = shape.text.flatMap((a) => a.labels);
  const union = new Set([...armLabels, ...dialogCommands]);
  for (const c of TEXT_COMMANDS) {
    if (!union.has(c)) {
      v.push(
        `"${c}" (TEXT_COMMANDS) has no call() text arm and no dialog method`,
      );
    }
  }
  for (const c of union) {
    if (!TEXT_SET.has(c)) {
      v.push(
        `"${c}" is a Kotlin text arm or dialog method, not in TEXT_COMMANDS`,
      );
    }
  }
  for (const d of DIALOGS) {
    for (const i of findAll(
      p.text,
      new RegExp(`"${d.command}"`, "g"),
      callBody,
    )) {
      v.push(
        `line ${lineOf(p.src, i)}: call() names dialog command "${d.command}"`,
      );
    }
  }
  const textBodies = shape.text.map((a) => a.body);
  const onlyInTextArms = [
    /(?<![\w$])resolveText\b/g,
    /\.\s*text[A-Z]\w*\s*\(/g,
  ];
  for (const re of onlyInTextArms) {
    for (const i of findAll(p.code, re, callBody)) {
      if (!textBodies.some((s) => i >= s[0] && i <= s[1])) {
        v.push(
          `line ${lineOf(p.src, i)}: call() reaches the text plane outside a text arm`,
        );
      }
    }
  }
  return v;
}

const GUARD_CONDS = new Set([
  "!MessageHandler.usingWebMessageListener",
  "!com.getcapacitor.MessageHandler.usingWebMessageListener",
]);

/** The bridge guard that opens `f`'s body, or null with a violation. */
function openingGuard(p: Kt, f: KtFun, v: string[]): KtIf | null {
  const first = skipWs(p.code, f.open + 1);
  const guard = ktIfs(p, blockOf(f)).find((x) => x.at === first);
  if (!guard || !GUARD_CONDS.has(guard.cond)) {
    v.push(
      `${f.name}: does not open with \`if (!MessageHandler.usingWebMessageListener)\``,
    );
    return null;
  }
  if (guard.otherwise) v.push(`${f.name}: the bridge guard has an else`);
  if (!UNAVAILABLE.test(p.text.slice(guard.then[0], guard.then[1] + 1))) {
    v.push(`${f.name}: the bridge guard does not refuse with "unavailable"`);
  }
  return guard;
}

function checkR2(p: Kt): string[] {
  const v: string[] = [];
  if (!/^\s*import\s+com\.getcapacitor\.MessageHandler\s*$/m.test(p.code)) {
    v.push("MessageHandler is not imported from com.getcapacitor");
  }
  if (
    /\b(?:class|object|interface|typealias)\s+MessageHandler\b/.test(p.code)
  ) {
    v.push("the file declares its own MessageHandler");
  }
  if (/\bimport\s+[\w.]+\s+as\s+MessageHandler\b/.test(p.code)) {
    v.push("MessageHandler is an import alias");
  }
  if (/\b(?:val|var|fun)\s+usingWebMessageListener\b/.test(p.code)) {
    v.push("the file declares its own usingWebMessageListener");
  }

  const shape = callShape(p, v);
  if (shape) {
    if (shape.text.length === 0) v.push("call(): no text arms found");
    for (const a of shape.text) {
      if (a.labels.length !== 1) {
        v.push(`${armLine(p, a)}: a text arm with ${a.labels.length} labels`);
        continue;
      }
      const label = a.labels[0];
      const want = `resolveText(call){engine.${camel(label)}(it)}`;
      if (squash(p.code.slice(a.body[0], a.body[1] + 1)) !== want) {
        v.push(
          `${armLine(p, a)}: arm "${label}" is not \`resolveText(call) { engine.${camel(label)}(it) }\``,
        );
      }
    }
  }

  const resolve = oneFun(p, "resolveText", v);
  if (resolve) {
    const body = blockOf(resolve);
    const guard = openingGuard(p, resolve, v);
    if (
      guard &&
      !/\bthrow\b/.test(p.code.slice(guard.then[0], guard.then[1] + 1))
    ) {
      v.push("resolveText: the bridge guard does not throw");
    }
    const commands = invocations(p.code, "command", body);
    if (commands.length !== 1) {
      v.push(`resolveText: ${commands.length} \`command(\` calls, want 1`);
    }
    for (const c of commands) {
      if (guard && c.at < guard.then[1]) {
        v.push("resolveText: the engine call comes before the bridge guard");
      }
      if (
        !c.args ||
        callArgs(p.code, c.args[0]).join(",") !== "call.data.toString()"
      ) {
        v.push("resolveText: `command(` is not passed `call.data.toString()`");
      }
    }
    if (findAll(p.code, /(?<![\w$.])engine\b/g, body).length > 0) {
      v.push("resolveText: reaches the engine other than through `command(`");
    }
  }

  const dialog = oneFun(p, "runTextDialog", v);
  if (dialog) {
    const body = blockOf(dialog);
    const guard = openingGuard(p, dialog, v);
    if (guard) {
      const then = p.code.slice(guard.then[0], guard.then[1] + 1);
      if (!/\breject\s*\(/.test(then) || !/\breturn\b/.test(then)) {
        v.push("runTextDialog: the bridge guard does not reject and return");
      }
      const after = [
        ...findAll(p.code, /\bconsentInFlight\b/g, body),
        ...findAll(p.code, /(?<![\w$.])executor\b/g, body),
        ...invocations(p.code, "command", body).map((c) => c.at),
      ];
      if (after.length === 0 || after.some((i) => i < guard.then[1])) {
        v.push(
          "runTextDialog: the slot or the engine comes before the bridge guard",
        );
      }
    }
  }
  return v;
}

function checkR2b(p: Kt): string[] {
  const v: string[] = [];
  const f = oneFun(p, "textCapability", v, { annotated: true });
  if (!f) return v;
  const body = squash(p.text.slice(f.open, f.close + 1));
  if (
    !/\.put\("listenerBridge",(?:com\.getcapacitor\.)?MessageHandler\.usingWebMessageListener\)/.test(
      body,
    )
  ) {
    v.push(
      "textCapability: `listenerBridge` is not `MessageHandler.usingWebMessageListener`",
    );
  }
  return v;
}

/** The file's own functions reachable from `root`, and the spans visited. */
function reachable(kt: Kt, root: Span): { names: Set<string>; spans: Span[] } {
  const all = new Set(kt.funs.map((f) => f.name));
  const names = new Set<string>();
  const spans: Span[] = [root];
  for (let k = 0; k < spans.length; k++) {
    for (const name of localRefs(kt.code, spans[k], all)) {
      if (names.has(name)) continue;
      names.add(name);
      for (const f of kt.funs) {
        const s = f.name === name ? funSpan(kt.code, f) : null;
        if (s) spans.push(s);
      }
    }
  }
  return { names, spans };
}

/**
 * The file-local function names `span` calls or references: `name(`,
 * `name {`, `this.name...`, `::name`; never a member of another receiver
 * (`engine.textJoin(`) or a definition.
 */
function localRefs(code: string, span: Span, names: Set<string>): Set<string> {
  const out = new Set<string>();
  const re = /\b[A-Za-z_]\w*/g;
  re.lastIndex = span[0];
  for (let m = re.exec(code); m && m.index <= span[1]; m = re.exec(code)) {
    const name = m[0];
    const at = m.index;
    if (!names.has(name) || isDefinition(code, at)) continue;
    let b = at - 1;
    while (b >= 0 && /\s/.test(code[b])) b--;
    if (code[b] === ".") {
      let c = b - 1;
      if (code[c] === "?") c--;
      while (c >= 0 && /\s/.test(code[c])) c--;
      if (!/(?<![\w$])this$/.test(code.slice(Math.max(0, c - 4), c + 1))) {
        continue;
      }
    }
    const reference = code[b] === ":" && code[b - 1] === ":";
    const next = code[skipWs(code, at + name.length)];
    if (reference || next === "(" || next === "{") out.add(name);
  }
  return out;
}

function checkR3(p: Kt, d: Kt): string[] {
  const v: string[] = [];
  for (const e of EMITS) {
    if (!p.funs.some((f) => f.name === e)) {
      v.push(
        `E2eePlugin.kt has no \`fun ${e}\` (the rule would prove nothing)`,
      );
    }
  }
  const roots: { name: string; span: Span }[] = [];
  const shape = callShape(p, v);
  if (shape) {
    if (shape.text.length === 0) v.push("call(): no text arms found");
    for (const a of shape.text) {
      roots.push({ name: `arm "${a.labels.join(",")}"`, span: a.body });
    }
  }
  for (const name of [
    "resolveText",
    "runTextDialog",
    "textCapability",
    ...DIALOGS.map((x) => x.method),
  ]) {
    const f = oneFun(p, name, v);
    if (f) roots.push({ name, span: blockOf(f) });
  }
  for (const root of roots) {
    const { names, spans } = reachable(p, root.span);
    for (const e of EMITS) {
      if (names.has(e)) v.push(`${root.name} reaches ${e}`);
    }
    if (
      spans.some(
        (s) => findAll(p.code, /(?<![\w$])notifyListeners\b/g, s).length,
      )
    ) {
      v.push(`${root.name} reaches notifyListeners`);
    }
  }
  const whole: Span = [-1, d.code.length];
  for (const i of findAll(
    d.code,
    /(?<![\w$])(?:emitKeysChanged|emitFromOutcome|notifyListeners)\b/g,
    whole,
  )) {
    v.push(`TextConfirmDialog.kt line ${lineOf(d.src, i)} emits`);
  }
  return v;
}

function checkR4(p: Kt): string[] {
  const v: string[] = [];
  const { code, text } = p;
  if (
    !/\bval\s+consentInFlight\s*=\s*AtomicBoolean\s*\(\s*false\s*\)/.test(code)
  ) {
    v.push("no `val consentInFlight = AtomicBoolean(false)`");
  }
  if (
    !/\bval\s+executor\s*:\s*ExecutorService\s*=\s*Executors\s*\./.test(code)
  ) {
    v.push("no `val executor: ExecutorService = Executors....`");
  }
  const f = oneFun(p, "runTextDialog", v);
  if (!f) return v;
  const body = blockOf(f);

  const claims = ktIfs(p, body).filter(
    (x) => x.cond === "!consentInFlight.compareAndSet(false,true)",
  );
  if (claims.length !== 1) {
    v.push(
      `runTextDialog: ${claims.length} \`if (!consentInFlight.compareAndSet(false, true))\`, want 1`,
    );
    return v;
  }
  const claim = claims[0];
  if (!topLevel(p, body, claim.at)) {
    v.push("runTextDialog: the slot claim is not a top-level statement");
  }
  const claimThen = code.slice(claim.then[0], claim.then[1] + 1);
  if (
    !BUSY.test(text.slice(claim.then[0], claim.then[1] + 1)) ||
    !/\breject\s*\(/.test(claimThen) ||
    !/\breturn\b/.test(claimThen)
  ) {
    v.push("runTextDialog: a held slot does not reject `busy` and return");
  }

  const locals = p.funs.filter(
    (g) => g !== f && g.open >= 0 && inside(body, g.at),
  );
  const held = [
    ...code
      .slice(body[0], body[1])
      .matchAll(/\bval\s+(\w+)\s*=\s*AtomicBoolean\s*\(\s*true\s*\)/g),
  ].map((m) => m[1]);
  const releaseFuns = locals.filter((g) => {
    const whole = squash(code.slice(g.open, g.close + 1));
    return (
      g.params.trim() === "" &&
      (whole === "{consentInFlight.set(false)}" ||
        held.some(
          (h) =>
            whole ===
            `{if(${h}.compareAndSet(true,false))consentInFlight.set(false)}`,
        ))
    );
  });
  const releaseRe = new RegExp(
    [
      String.raw`\bconsentInFlight\s*\.\s*set\s*\(\s*false\s*\)`,
      ...releaseFuns.map((g) => String.raw`(?<![\w$.])${g.name}\s*\(\s*\)`),
    ].join("|"),
    "g",
  );
  const releasesIn = (s: Span) =>
    findAll(code, releaseRe, s).filter(
      (i) =>
        !isDefinition(code, i) &&
        !releaseFuns.some((g) => inside(blockOf(g), i)),
    );

  const execs = findAll(code, /(?<![\w$.])executor\s*\.\s*execute\b/g, body);
  if (execs.length !== 1) {
    v.push(`runTextDialog: ${execs.length} \`executor.execute\`, want 1`);
    return v;
  }
  if (execs[0] < claim.then[1]) {
    v.push("runTextDialog: executor.execute comes before the slot claim");
  }
  const hop = invocations(code, "execute", [execs[0], body[1]])[0];
  const lambda = hop?.lambdas[0];
  if (!lambda) {
    v.push("runTextDialog: executor.execute is not given a lambda");
    return v;
  }
  const commands = invocations(code, "command", body);
  if (commands.length !== 1) {
    v.push(`runTextDialog: ${commands.length} \`command(\` calls, want 1`);
    return v;
  }
  const at = commands[0].at;
  if (!inside(lambda, at)) {
    v.push("runTextDialog: the engine call is not inside the executor lambda");
  }
  const tries = ktTries(code, body);
  if (
    !tries.some(
      (t) =>
        inside(t.block, at) &&
        inside(lambda, t.block[0]) &&
        t.fin !== null &&
        releasesIn(t.fin).length > 0,
    )
  ) {
    v.push(
      "runTextDialog: the engine call is not in a `try` whose `finally` releases the slot",
    );
  }
  if (
    !tries.some(
      (t) =>
        inside(t.block, execs[0]) &&
        t.catches.some((c) => releasesIn(c).length > 0),
    )
  ) {
    v.push(
      "runTextDialog: no `catch` around executor.execute releases the slot",
    );
  }
  for (const i of releasesIn(body)) {
    const settled = tries.some((t) =>
      [...t.catches, ...(t.fin ? [t.fin] : [])].some((s) => inside(s, i)),
    );
    if (!settled) {
      v.push(
        `line ${lineOf(p.src, i)}: runTextDialog releases the slot outside a finally / catch`,
      );
    }
  }
  return v;
}

function checkR5(p: Kt): string[] {
  const v: string[] = [];
  const shape = callShape(p, v);
  if (!shape) return v;
  const arms = shape.arms.filter((a) => a.labels.includes("e2ee_store_owner"));
  if (arms.length !== 1) {
    v.push(`call(): ${arms.length} "e2ee_store_owner" arms, want 1`);
    return v;
  }
  const arm = arms[0];
  const body = squash(p.text.slice(arm.body[0], arm.body[1] + 1));
  const quoted = String.raw`\?\.let\{(org\.json\.)?JSONObject\.quote\(it\)\}\?:"null"\)`;
  const twoStep = new RegExp(
    String.raw`^\{val(\w+)=engine\.storeOwner\(\)resolveJson\(call,\1${quoted}\}$`,
  );
  const oneStep = new RegExp(
    String.raw`^\{?resolveJson\(call,engine\.storeOwner\(\)${quoted}\}?$`,
  );
  const m = twoStep.exec(body) ?? oneStep.exec(body);
  if (!m || arm.labels.length !== 1) {
    v.push(
      `${armLine(p, arm)}: the e2ee_store_owner arm does not resolve \`owner?.let { JSONObject.quote(it) } ?: "null"\` for \`engine.storeOwner()\``,
    );
    return v;
  }
  const qualified = m.length === 3 ? m[2] : m[1];
  if (!qualified && !/^\s*import\s+org\.json\.JSONObject\s*$/m.test(p.code)) {
    v.push("JSONObject is not org.json.JSONObject");
  }
  return v;
}

// ---- TextConfirmDialog.kt ----------------------------------------------------

interface DialogShape {
  cls: Span;
  /** Constructor parameter names: `() -> Activity?` and `TextDialogs`. */
  activity: string;
  dialogs: string;
  confirm: KtFun;
  inform: KtFun;
  asker: KtFun;
  /** The asker's parameters: `TextConfirmPayload` and `Boolean`. */
  payload: string;
  single: string;
  /** The `runOnUiThread` call that shows the dialog, and its lambda. */
  runAt: number;
  showRun: Span;
  showAt: number;
  /** The settle-once function (see R6d), if found. */
  settle: KtFun | null;
}

function dialogShape(d: Kt, v: string[]): DialogShape | null {
  const { code } = d;
  const classes: { cls: Span; params: string }[] = [];
  for (const m of code.matchAll(/\bclass\s+(\w+)\s*\(/g)) {
    const paren = m.index + m[0].length - 1;
    const close = matchClose(code, paren);
    const brace = code.indexOf("{", close);
    if (brace < 0) continue;
    if (/^\s*:[^{]*\bTextConfirm\b/.test(code.slice(close + 1, brace))) {
      classes.push({
        cls: [brace, matchClose(code, brace)],
        params: code.slice(paren + 1, close),
      });
    }
  }
  if (classes.length !== 1) {
    v.push(`${classes.length} classes implement TextConfirm, want 1`);
    return null;
  }
  const { cls, params } = classes[0];
  const activity = /(\w+)\s*:\s*\(\s*\)\s*->\s*Activity\s*\?/.exec(params)?.[1];
  const dialogs = /(\w+)\s*:\s*TextDialogs\b/.exec(params)?.[1];
  if (!activity || !dialogs) {
    v.push(
      "the TextConfirm class does not take `() -> Activity?` and `TextDialogs`",
    );
    return null;
  }
  const member = (name: string) => {
    const all = d.funs.filter((f) => f.name === name && inside(cls, f.at));
    const f =
      all.length === 1 && all[0].override && all[0].open >= 0 ? all[0] : null;
    if (!f) v.push(`no single block-bodied \`override fun ${name}\``);
    return f;
  };
  const confirm = member("confirm");
  const inform = member("inform");

  const shows = invocations(code, "runOnUiThread", cls).flatMap((r) =>
    r.lambdas.flatMap((l) =>
      findAll(code, /\.\s*show\s*\(\s*\)/g, l).map((showAt) => ({
        runAt: r.at,
        showRun: l,
        showAt,
      })),
    ),
  );
  if (shows.length !== 1) {
    v.push(`${shows.length} \`show()\` calls inside runOnUiThread, want 1`);
    return null;
  }
  const { runAt, showRun, showAt } = shows[0];
  const asker = d.funs
    .filter((f) => f.open >= 0 && inside(blockOf(f), runAt))
    .sort((a, b) => b.open - a.open)[0];
  const payload = /(\w+)\s*:\s*TextConfirmPayload\b/.exec(
    asker?.params ?? "",
  )?.[1];
  const single = /(\w+)\s*:\s*Boolean\b/.exec(asker?.params ?? "")?.[1];
  if (!asker || !payload || !single) {
    v.push(
      "the show runnable is not in a function of (TextConfirmPayload, Boolean)",
    );
    return null;
  }
  if (!confirm || !inform) return null;
  const settle =
    d.funs.find(
      (f) =>
        f !== asker &&
        f.open >= 0 &&
        inside(blockOf(asker), f.at) &&
        /\.compareAndSet\(false,true\)/.test(
          squash(code.slice(f.open, f.close + 1)),
        ),
    ) ?? null;
  return {
    cls,
    activity,
    dialogs,
    confirm,
    inform,
    asker,
    payload,
    single,
    runAt,
    showRun,
    showAt,
    settle,
  };
}

const throwsTce = (d: Kt, x: KtIf) =>
  /^\{?throwTextConfirmException\./.test(
    squash(d.code.slice(x.then[0], x.then[1] + 1)),
  );

/** `if`s that are top-level statements of the asker, before runOnUiThread. */
const preShowIfs = (d: Kt, s: DialogShape) =>
  ktIfs(d, [s.asker.open, s.runAt]).filter((x) =>
    topLevel(d, blockOf(s.asker), x.at),
  );

const settlesNull = (d: Kt, s: DialogShape, span: Span) =>
  s.settle !== null &&
  invocations(d.code, s.settle.name, span).some(
    (c) => c.args !== null && callArgs(d.code, c.args[0]).join(",") === "null",
  );

/** The `val A = AtomicReference<Boolean?>(null)` of the asker. */
const answerRef = (d: Kt, s: DialogShape) =>
  /\bval\s+(\w+)\s*=\s*AtomicReference\s*<\s*Boolean\s*\?\s*>\s*\(\s*null\s*\)/.exec(
    d.code.slice(s.asker.open, s.asker.close),
  )?.[1];

function checkR6a(_p: Kt, d: Kt): string[] {
  const v: string[] = [];
  const s = dialogShape(d, v);
  if (!s) return v;
  const { code } = d;
  const ask = s.asker.name;
  if (
    !new RegExp(String.raw`\breturn\s+${ask}\s*\(`).test(
      code.slice(s.confirm.open, s.confirm.close),
    )
  ) {
    v.push(`confirm does not return \`${ask}(...)\``);
  }
  if (invocations(code, ask, blockOf(s.inform)).length === 0) {
    v.push(`inform does not call \`${ask}(...)\``);
  }
  const ifs = preShowIfs(d, s);
  const looper = new Set([
    "Looper.myLooper()==Looper.getMainLooper()",
    "Looper.getMainLooper()==Looper.myLooper()",
  ]);
  if (!ifs.some((x) => looper.has(x.cond) && !x.otherwise && throwsTce(d, x))) {
    v.push("no top-level main-looper `if` that throws before runOnUiThread");
  }
  const hostRe = new RegExp(
    String.raw`\bval\s+(\w+)\s*=\s*${s.activity}\s*\(\s*\)\s*\?:\s*throw\s+TextConfirmException\b`,
    "g",
  );
  const hosts = findAll(code, hostRe, [s.asker.open, s.runAt]).filter((i) =>
    topLevel(d, blockOf(s.asker), i),
  );
  if (hosts.length !== 1) {
    v.push(
      `no top-level \`val host = ${s.activity}() ?: throw TextConfirmException...\``,
    );
    return v;
  }
  hostRe.lastIndex = hosts[0];
  const host = hostRe.exec(code)?.[1] ?? "";
  const lifecycle = [
    `${s.dialogs}.destroyed`,
    `${host}.isFinishing`,
    `${host}.isDestroyed`,
  ];
  if (
    !ifs.some((x) => {
      const terms = orTerms(x.cond);
      return (
        x.at > hosts[0] &&
        terms !== null &&
        lifecycle.every((t) => terms.includes(t)) &&
        !x.otherwise &&
        throwsTce(d, x)
      );
    })
  ) {
    v.push(
      `no top-level \`if (${lifecycle.join(" || ")})\` that throws before runOnUiThread`,
    );
  }
  const showTries = ktTries(code, s.showRun).filter((t) =>
    inside(t.block, s.showAt),
  );
  if (!showTries.some((t) => t.catches.some((c) => settlesNull(d, s, c)))) {
    v.push("show() is not in a `try` whose `catch` settles null");
  }
  const runTries = ktTries(code, blockOf(s.asker)).filter((t) =>
    inside(t.block, s.runAt),
  );
  if (!runTries.some((t) => t.catches.some((c) => settlesNull(d, s, c)))) {
    v.push("runOnUiThread is not in a `try` whose `catch` settles null");
  }
  const answer = answerRef(d, s);
  if (
    !answer ||
    !squash(code.slice(s.asker.open, s.asker.close)).includes(
      `return${answer}.get()?:throwTextConfirmException.`,
    )
  ) {
    v.push(
      "the asker does not return `answer.get() ?: throw TextConfirmException...`",
    );
  }
  return v;
}

function checkR6b(_p: Kt, d: Kt): string[] {
  const v: string[] = [];
  const s = dialogShape(d, v);
  if (!s) return v;
  const { code } = d;
  if (!/@Volatile\s+(?:(?:internal|public)\s+)?var\s+destroyed\b/.test(code)) {
    v.push("TextDialogs.destroyed is not `@Volatile var`");
  }
  const showBlock = enclosingBrace(code, s.showAt);
  const recheck = ktIfs(d, s.showRun).some((x) => {
    const terms = orTerms(x.cond);
    const then = code.slice(x.then[0], x.then[1] + 1);
    return (
      terms !== null &&
      terms.includes(`${s.dialogs}.destroyed`) &&
      x.at < s.showAt &&
      x.then[1] < s.showAt &&
      topLevel(d, [showBlock, matchClose(code, showBlock)], x.at) &&
      /\breturn\b/.test(then) &&
      !/\btrue\b/.test(then)
    );
  });
  if (!recheck) {
    v.push(
      `the show runnable does not re-check \`${s.dialogs}.destroyed\` and return before show()`,
    );
  }
  return v;
}

/** Every `runOnUiThread` lambda in `span`. */
const uiLambdas = (d: Kt, span: Span) =>
  invocations(d.code, "runOnUiThread", span).flatMap((r) => r.lambdas);

function checkR6c(_p: Kt, d: Kt): string[] {
  const v: string[] = [];
  const s = dialogShape(d, v);
  for (const i of findAll(d.code, /\b[sS]ynchronized\b/g, [
    -1,
    d.code.length,
  ])) {
    v.push(`line ${lineOf(d.src, i)}: synchronized in code`);
  }
  if (!s) return v;
  const latch = /\bval\s+(\w+)\s*=\s*CountDownLatch\s*\(\s*1\s*\)/.exec(
    d.code.slice(s.asker.open, s.asker.close),
  )?.[1];
  if (!latch) {
    v.push("the asker has no `val latch = CountDownLatch(1)`");
    return v;
  }
  const ui = uiLambdas(d, s.cls);
  const awaits = findAll(
    d.code,
    new RegExp(String.raw`(?<![\w$.])${latch}\s*\.\s*await\s*\(`, "g"),
    blockOf(s.asker),
  ).filter((i) => !ui.some((l) => inside(l, i)));
  if (awaits.length === 0) {
    v.push(
      `the asker never awaits \`${latch}\` outside a runOnUiThread lambda`,
    );
  }
  return v;
}

function checkR6d(_p: Kt, d: Kt): string[] {
  const v: string[] = [];
  const s = dialogShape(d, v);
  if (!s) return v;
  const { code } = d;
  const askerCode = code.slice(s.asker.open, s.asker.close);
  const answer = answerRef(d, s);
  const latch = /\bval\s+(\w+)\s*=\s*CountDownLatch\s*\(/.exec(askerCode)?.[1];
  const flags = [
    ...askerCode.matchAll(
      /\bval\s+(\w+)\s*=\s*AtomicBoolean\s*\(\s*false\s*\)/g,
    ),
  ].map((m) => m[1]);
  if (!answer || !latch || !s.settle) {
    v.push(
      "no answer AtomicReference<Boolean?>(null), latch or settle function",
    );
    return v;
  }
  const settle = s.settle;
  const param = /^\s*(\w+)\s*:/.exec(settle.params)?.[1] ?? "";
  const whole = /^\{if\((\w+)\.compareAndSet\(false,true\)\)\{(.*)\}\}$/.exec(
    squash(code.slice(settle.open, settle.close + 1)),
  );
  const pair = [`${answer}.set(${param})`, `${latch}.countDown()`];
  if (
    !whole ||
    !flags.includes(whole[1]) ||
    (whole[2] !== pair[0] + pair[1] && whole[2] !== pair[1] + pair[0])
  ) {
    v.push(
      `\`${settle.name}\` is not \`if (settled.compareAndSet(false, true)) { ${pair.join("; ")} }\``,
    );
    return v;
  }
  const flag = whole[1];
  const all: Span = [-1, code.length];
  const count = (re: string) => findAll(code, new RegExp(re, "g"), all).length;
  if (count(String.raw`(?<![\w$.])${answer}\s*\.\s*set\s*\(`) !== 1) {
    v.push(`\`${answer}.set(\` outside the settle-once branch`);
  }
  if (count(String.raw`(?<![\w$.])${latch}\s*\.\s*countDown\s*\(`) !== 1) {
    v.push(`\`${latch}.countDown(\` outside the settle-once branch`);
  }
  if (
    count(
      String.raw`(?<![\w$.])${flag}\s*\.\s*(?:set|lazySet|getAndSet)\s*\(|(?<![\w$.])${flag}\s*\.\s*compareAndSet\s*\(\s*true`,
    ) > 0
  ) {
    v.push(`\`${flag}\` is reset`);
  }
  const positive = invocations(code, "setPositiveButton", s.cls).flatMap(
    (c) => c.lambdas,
  );
  let yes = 0;
  for (const c of invocations(code, settle.name, s.cls)) {
    const arg = c.args ? callArgs(code, c.args[0]).join(",") : "";
    if (arg === "true") {
      yes++;
      if (!positive.some((l) => inside(l, c.at))) {
        v.push(
          `line ${lineOf(d.src, c.at)}: settles true outside the positive listener`,
        );
      }
    } else if (arg !== "false" && arg !== "null") {
      v.push(
        `line ${lineOf(d.src, c.at)}: settles \`${arg}\` (only true / false / null)`,
      );
    }
  }
  if (yes !== 1) v.push(`${yes} \`${settle.name}(true)\` calls, want 1`);
  if (count(String.raw`\breturn\s+true\b`) > 0) v.push("`return true` in code");
  return v;
}

interface ButtonBlock {
  at: number;
  block: Span;
  /** The receiver name; "" when the block's receiver is the button. */
  recv: string;
}

/** Blocks acting on `getButton(AlertDialog.BUTTON_<which>)` in `region`. */
function buttonBlocks(d: Kt, which: string, region: Span): ButtonBlock[] {
  const { code } = d;
  const out: ButtonBlock[] = [];
  const re = new RegExp(
    String.raw`\bgetButton\s*\(\s*(?:(?:AlertDialog|DialogInterface)\s*\.\s*)?BUTTON_${which}\s*\)`,
    "g",
  );
  for (const m of code.matchAll(re)) {
    if (!inside(region, m.index)) continue;
    const end = m.index + m[0].length;
    const scope = /^\s*(?:\?\s*)?\.\s*(let|also|apply|run)\s*\{/.exec(
      code.slice(end),
    );
    if (scope) {
      const open = end + scope[0].length - 1;
      const close = matchClose(code, open);
      let recv = "";
      if (scope[1] === "let" || scope[1] === "also") {
        recv = /^\{\s*(\w+)\s*->/.exec(code.slice(open, close))?.[1] ?? "it";
      }
      out.push({ at: m.index, block: [open, close], recv });
      continue;
    }
    const lineStart = code.lastIndexOf("\n", m.index) + 1;
    const decl = /\bval\s+(\w+)\s*(?::[^=]*)?=\s*[\w.?\s]*$/.exec(
      code.slice(lineStart, m.index),
    );
    if (decl) {
      const enc = enclosingBrace(code, m.index);
      out.push({
        at: m.index,
        block: [enc, matchClose(code, enc)],
        recv: decl[1],
      });
    }
  }
  return out;
}

/** Top-level statements of `b` setting `prop` to `value` on the button. */
function setsProp(
  d: Kt,
  b: ButtonBlock,
  prop: string,
  value: string,
): number[] {
  const setter = `set${prop[0].toUpperCase()}${prop.slice(1)}`;
  const recv = b.recv
    ? String.raw`(?<![\w$.])${b.recv}\s*(?:\?\s*)?\.\s*`
    : String.raw`(?<![\w$.?])`;
  const re = new RegExp(
    `${recv}(?:${prop}\\s*=(?!=)\\s*${value}\\b|${setter}\\s*\\(\\s*${value}\\s*\\))`,
    "g",
  );
  return findAll(d.code, re, b.block).filter(
    (i) => i > b.at && topLevel(d, b.block, i),
  );
}

/** Button blocks after show() in the show runnable, or in a show listener. */
function shownButtons(d: Kt, s: DialogShape, which: string): ButtonBlock[] {
  const listeners = invocations(d.code, "setOnShowListener", s.cls).flatMap(
    (c) => c.lambdas,
  );
  return buttonBlocks(d, which, s.cls).filter(
    (b) =>
      (inside(s.showRun, b.at) && b.at > s.showAt) ||
      listeners.some((l) => inside(l, b.at)),
  );
}

function checkR6e(_p: Kt, d: Kt): string[] {
  const v: string[] = [];
  const s = dialogShape(d, v);
  const { code } = d;
  const consts = new Map<string, number>();
  for (const m of code.matchAll(
    /\bconst\s+val\s+(\w+)\s*(?::\s*\w+)?\s*=\s*([\d_]+)L?\b/g,
  )) {
    consts.set(m[1], Number(m[2].replace(/_/g, "")));
  }
  const delayOf = (arg: string) =>
    /^[\d_]+L?$/.test(arg)
      ? Number(arg.replace(/[_L]/g, ""))
      : (consts.get(arg) ?? NaN);
  const all: Span = [-1, code.length];
  const delayed = invocations(code, "postDelayed", all).filter((c) => {
    if (!c.args) return false;
    const args = callArgs(code, c.args[0]);
    return delayOf(args[args.length - 1]) >= MIN_DELAY_MS;
  });
  const enables: number[] = [];
  for (const m of code.matchAll(
    /\bisEnabled\s*=(?!=)\s*([\w.]+)|\bsetEnabled\s*\(\s*([\w.]+)/g,
  )) {
    if ((m[1] ?? m[2]) !== "false") enables.push(m.index);
  }
  if (enables.length === 0) v.push("nothing enables the confirm button");
  for (const i of enables) {
    const late = delayed.some(
      (c) =>
        (c.args && inside(c.args, i)) || c.lambdas.some((l) => inside(l, i)),
    );
    if (!late) {
      v.push(
        `line ${lineOf(d.src, i)}: an enable outside a postDelayed of >= ${MIN_DELAY_MS} ms`,
      );
    }
  }
  if (!s) return v;
  if (
    !shownButtons(d, s, "POSITIVE").some(
      (b) => setsProp(d, b, "isEnabled", "false").length > 0,
    )
  ) {
    v.push(
      "the positive button is not disabled (`isEnabled = false`) after show()",
    );
  }
  return v;
}

function checkR6f(_p: Kt, d: Kt): string[] {
  const v: string[] = [];
  const s = dialogShape(d, v);
  for (const i of findAll(
    d.code,
    /\bfilterTouchesWhenObscured\s*=(?!=)\s*false\b|\bsetFilterTouchesWhenObscured\s*\(\s*false/g,
    [-1, d.code.length],
  )) {
    v.push(`line ${lineOf(d.src, i)}: filterTouchesWhenObscured set false`);
  }
  if (!s) return v;
  for (const which of ["POSITIVE", "NEGATIVE"]) {
    const ok = shownButtons(d, s, which).some(
      (b) => setsProp(d, b, "filterTouchesWhenObscured", "true").length > 0,
    );
    if (!ok)
      v.push(
        `BUTTON_${which} does not get filterTouchesWhenObscured = true after show()`,
      );
  }
  return v;
}

function checkR6g(_p: Kt, d: Kt): string[] {
  const v: string[] = [];
  const s = dialogShape(d, v);
  if (!s) return v;
  const { code } = d;
  const flagCall = (value: string) =>
    new RegExp(
      String.raw`(?<![\w$.])${s.asker.name}\s*\(\s*\w+\s*,\s*(?:${s.single}\s*=\s*)?${value}\s*\)`,
    );
  if (!flagCall("true").test(code.slice(s.inform.open, s.inform.close))) {
    v.push(
      `inform does not call \`${s.asker.name}(payload, ${s.single} = true)\``,
    );
  }
  if (!flagCall("false").test(code.slice(s.confirm.open, s.confirm.close))) {
    v.push(
      `confirm does not call \`${s.asker.name}(payload, ${s.single} = false)\``,
    );
  }

  const P = s.payload;
  const blank = ["title", "message", "confirmLabel", "cancelLabel"].map(
    (f) => `${P}.${f}.isBlank()`,
  );
  if (
    !preShowIfs(d, s).some((x) => {
      const terms = orTerms(x.cond);
      return (
        terms !== null &&
        blank.every((t) => terms.includes(t)) &&
        !x.otherwise &&
        throwsTce(d, x)
      );
    })
  ) {
    v.push(
      `no top-level \`if (${blank.join(" || ")})\` that throws before runOnUiThread`,
    );
  }

  const branches = ktIfs(d, s.showRun).filter((x) => x.cond === s.single);
  if (branches.length !== 1 || !branches[0].otherwise) {
    v.push(`the show runnable has no single \`if (${s.single}) ... else ...\``);
    return v;
  }
  const then = branches[0].then;
  const otherwise = branches[0].otherwise;
  const buttons = [
    ...code.matchAll(/(?<![\w$])set(Positive|Negative|Neutral)?Button\s*\(/g),
  ]
    .filter((m) => inside(s.cls, m.index))
    .map((m) => {
      const open = m.index + m[0].length - 1;
      const close = matchClose(code, open);
      const after = skipWs(code, close + 1);
      return {
        at: m.index,
        kind: m[1] ?? "",
        args: callArgs(code, open),
        trailing: code[after] === "{",
      };
    });
  const inThen = buttons.filter((b) => then[0] <= b.at && b.at <= then[1]);
  const inElse = buttons.filter(
    (b) => otherwise[0] <= b.at && b.at <= otherwise[1],
  );
  for (const b of buttons) {
    if (!inThen.includes(b) && !inElse.includes(b)) {
      v.push(
        `line ${lineOf(d.src, b.at)}: a button set outside the if (${s.single}) / else`,
      );
    }
  }
  const one = inThen[0];
  if (
    inThen.length !== 1 ||
    one.kind === "Positive" ||
    one.kind === "" ||
    one.trailing ||
    one.args.join(",") !== `${P}.confirmLabel,null`
  ) {
    v.push(
      `the ${s.single} branch does not set exactly one non-positive button (${P}.confirmLabel, null)`,
    );
  }
  const pos = inElse.filter((b) => b.kind === "Positive");
  const neg = inElse.filter((b) => b.kind === "Negative");
  if (
    inElse.length !== 2 ||
    pos.length !== 1 ||
    neg.length !== 1 ||
    pos[0].args[0] !== `${P}.confirmLabel` ||
    neg[0].args[0] !== `${P}.cancelLabel`
  ) {
    v.push(
      `the confirm branch does not set positive (${P}.confirmLabel) and negative (${P}.cancelLabel)`,
    );
  }
  return v;
}

const SYNTHETIC_TAP =
  /(?<![\w$])(?:performClick|callOnClick|performLongClick|performContextClick|performAccessibilityAction|dispatchTouchEvent|dispatchKeyEvent|dispatchGenericMotionEvent|onTouchEvent|onKeyDown|onKeyUp)\b/g;
const REFLECTION = new RegExp(
  [
    String.raw`(?<![\w$])(?:getDeclared\w*|getMethods?|getFields?|getConstructors?)\s*\(`,
    String.raw`(?<![\w$])(?:isAccessible|setAccessible|trySetAccessible)\b`,
    String.raw`(?<![\w$])(?:javaClass|declaredMethods|declaredFields|memberFunctions|declaredFunctions|declaredMemberFunctions|staticFunctions)\b`,
    String.raw`::\s*class\s*\.\s*java\b`,
    String.raw`\bKFunction\w*|\bKCallable\b|\bKProperty\w*`,
    String.raw`\bcallBy\s*\(`,
    String.raw`\bClass\s*\.\s*forName\s*\(`,
    String.raw`\b(?:java\s*\.\s*lang|kotlin)\s*\.\s*reflect\b`,
    String.raw`\bMethodHandles?\b`,
  ].join("|"),
  "g",
);

function checkR6h(_p: Kt, d: Kt): string[] {
  const v: string[] = [];
  const all: Span = [-1, d.code.length];
  for (const i of findAll(d.code, SYNTHETIC_TAP, all)) {
    v.push(`line ${lineOf(d.src, i)}: a synthetic tap`);
  }
  for (const i of findAll(d.code, REFLECTION, all)) {
    v.push(`line ${lineOf(d.src, i)}: reflection`);
  }
  return v;
}

function checkR7(p: Kt, d: Kt): string[] {
  const v: string[] = [];
  const pc = p.code;
  const plugin = /\bclass\s+E2eePlugin\b[^{]*\{/.exec(pc);
  const owners = [...pc.matchAll(/\bval\s+(\w+)\s*=\s*TextDialogs\s*\(\s*\)/g)];
  const pluginOpen = plugin ? plugin.index + plugin[0].length - 1 : -2;
  if (
    owners.length !== 1 ||
    enclosingBrace(pc, owners[0].index) !== pluginOpen
  ) {
    v.push(
      "E2eePlugin does not hold exactly one class-level `val ... = TextDialogs()`",
    );
    return v;
  }
  const T = owners[0][1];
  const hod = oneFun(p, "handleOnDestroy", v, { override: true });
  if (hod) {
    const top = (re: string) =>
      findAll(pc, new RegExp(re, "g"), blockOf(hod)).filter((i) =>
        topLevel(p, blockOf(hod), i),
      ).length > 0;
    if (!top(String.raw`(?<![\w$.])${T}\s*\.\s*destroyed\s*=(?!=)\s*true\b`)) {
      v.push(
        `handleOnDestroy does not set \`${T}.destroyed = true\` as a top-level statement`,
      );
    }
    if (!top(String.raw`(?<![\w$.])${T}\s*\.\s*dismissAll\s*\(\s*\)`)) {
      v.push(
        `handleOnDestroy does not call \`${T}.dismissAll()\` as a top-level statement`,
      );
    }
  }
  const rtd = oneFun(p, "runTextDialog", v);
  if (rtd) {
    const made = invocations(pc, "TextConfirmDialog", blockOf(rtd));
    if (
      made.length !== 1 ||
      !made[0].args ||
      !callArgs(pc, made[0].args[0]).includes(T)
    ) {
      v.push(
        `runTextDialog does not build one TextConfirmDialog over \`${T}\``,
      );
    }
  }
  for (const [kt, file] of [
    [p, "E2eePlugin.kt"],
    [d, "TextConfirmDialog.kt"],
  ] as const) {
    for (const m of kt.code.matchAll(
      /(?<![\w$])destroyed\s*=(?!=)\s*false\b/g,
    )) {
      if (!/\bvar\s+$/.test(kt.code.slice(Math.max(0, m.index - 8), m.index))) {
        v.push(
          `${file} line ${lineOf(kt.src, m.index)}: resets destroyed to false`,
        );
      }
    }
  }
  const holder = /\bclass\s+TextDialogs\b[^{(]*\{/.exec(d.code);
  const holderBody: Span | null = holder
    ? [
        holder.index + holder[0].length - 1,
        matchClose(d.code, holder.index + holder[0].length - 1),
      ]
    : null;
  const dismissAll = holderBody
    ? d.funs.find(
        (f) =>
          f.name === "dismissAll" && f.open >= 0 && inside(holderBody, f.at),
      )
    : undefined;
  if (
    !dismissAll ||
    !/\.\s*dismiss\s*\(\s*\)/.test(
      d.code.slice(dismissAll.open, dismissAll.close),
    )
  ) {
    v.push("TextDialogs.dismissAll does not dismiss");
  }
  const s = dialogShape(d, v);
  if (s) {
    const adds = findAll(
      d.code,
      new RegExp(String.raw`(?<![\w$.])${s.dialogs}\s*\.\s*add\s*\(`, "g"),
      s.showRun,
    ).filter((i) => {
      const block = enclosingBrace(d.code, s.showAt);
      return i < s.showAt && topLevel(d, [block, matchClose(d.code, block)], i);
    });
    if (adds.length === 0) {
      v.push(
        `the show runnable does not add the dialog to \`${s.dialogs}\` before show()`,
      );
    }
  }
  return v;
}

// ---- The rules ---------------------------------------------------------------

type Check = (p: Kt, d: Kt) => string[];

const RULES: Record<string, { title: string; check: Check }> = {
  R1: {
    title:
      "TEXT_COMMANDS = the call() text arms + the 3 dedicated dialog methods; no dialog command in call()",
    check: (p) => checkR1(p),
  },
  R2: {
    title:
      "every text arm goes through resolveText; resolveText and runTextDialog check usingWebMessageListener first",
    check: (p) => checkR2(p),
  },
  R2b: {
    title: "textCapability reports listenerBridge from usingWebMessageListener",
    check: (p) => checkR2b(p),
  },
  R3: {
    title:
      "no text arm or text method reaches emitKeysChanged / emitFromOutcome",
    check: checkR3,
  },
  R4: {
    title:
      "runTextDialog claims consentInFlight, hops to the executor, releases in finally",
    check: (p) => checkR4(p),
  },
  R5: {
    title:
      'the e2ee_store_owner arm resolves JSONObject.quote(owner) or "null"',
    check: (p) => checkR5(p),
  },
  R6a: {
    title:
      "TextConfirmDialog: main looper / null / finishing / destroyed activity and a show() failure answer Err",
    check: checkR6a,
  },
  R6b: {
    title:
      "TextConfirmDialog: the destroyed flag is re-checked on the UI thread before show()",
    check: checkR6b,
  },
  R6c: {
    title:
      "TextConfirmDialog: waits on a CountDownLatch; no synchronized in code",
    check: checkR6c,
  },
  R6d: {
    title:
      "TextConfirmDialog: settles once (compare-and-set); true only in the positive listener",
    check: checkR6d,
  },
  R6e: {
    title: `TextConfirmDialog: the confirm button stays disabled for >= ${MIN_DELAY_MS} ms`,
    check: checkR6e,
  },
  R6f: {
    title: "TextConfirmDialog: filterTouchesWhenObscured on both buttons",
    check: checkR6f,
  },
  R6g: {
    title: "TextConfirmDialog: inform has one button; blank copy fails closed",
    check: checkR6g,
  },
  R6h: {
    title: "TextConfirmDialog: no performClick and kin, no reflection",
    check: checkR6h,
  },
  R7: {
    title:
      "handleOnDestroy sets the text-dialog destroyed flag and dismisses them",
    check: checkR7,
  },
};

const PLUGIN = ktLoad(readFileSync(PLUGIN_FILE, "utf8"));
const DIALOG = ktLoad(readFileSync(DIALOG_FILE, "utf8"));

test(`sources: ${String(PLUGIN_FILE)} + ${String(DIALOG_FILE)}`, () => {
  assert.match(PLUGIN.code, /\bclass\s+E2eePlugin\b/);
  assert.match(DIALOG.code, /\bclass\s+TextConfirmDialog\b/);
  assert.equal(TEXT_COMMANDS.length, 20);
});

for (const [id, rule] of Object.entries(RULES)) {
  test(`${id} ${rule.title}`, () => {
    assert.deepEqual(rule.check(PLUGIN, DIALOG), []);
  });
}

// ---- Controls: each rule fails on a literal mutation of the real file --------

interface Control {
  id: string;
  rule: keyof typeof RULES;
  file: "plugin" | "dialog";
  edits: readonly (readonly [string, string])[];
  /** "pass": a comment / harmless form that must NOT trip the rule. */
  expect: "fail" | "pass";
}

const lines = (...xs: string[]) => xs.join("\n");
const RESOLVE_GUARD = lines(
  "        if (!MessageHandler.usingWebMessageListener) {",
  String.raw`            throw E2eeException.Failure("{\"type\":\"unavailable\"}")`,
  "        }",
);
const DIALOG_GUARD = lines(
  "        if (!MessageHandler.usingWebMessageListener) {",
  String.raw`            call.reject("{\"type\":\"unavailable\"}")`,
  "            return",
  "        }",
  "        val argsJson",
);
const RELEASE_FUN = lines(
  "        fun release() {",
  "            if (held.compareAndSet(true, false)) consentInFlight.set(false)",
  "        }",
  "",
  "        try {",
  "            executor.execute {",
  "                try {",
  "                    val json =",
);
const COMMAND_FINALLY = lines(
  "                            command(argsJson, dialog)",
  "                        } finally {",
  "                            release()",
  "                        }",
);
const HOP = lines(
  "            executor.execute {",
  "                try {",
  "                    val json =",
);
const ARM = (c: string) =>
  `"${c}" -> resolveText(call) { engine.${camel(c)}(it) }`;
const STORE_OWNER = String.raw`owner?.let { org.json.JSONObject.quote(it) } ?: "null"`;

const CONTROLS: Control[] = [
  // R1
  {
    id: "dialog-command-arm",
    rule: "R1",
    file: "plugin",
    edits: [
      [
        ARM("e2ee_text_join"),
        lines(
          ARM("e2ee_text_join"),
          `                "e2ee_text_owner_handover_sign" -> resolveText(call) { engine.textJoin(it) }`,
        ),
      ],
    ],
    expect: "fail",
  },
  {
    id: "arm-dropped",
    rule: "R1",
    file: "plugin",
    edits: [[`                ${ARM("e2ee_text_pin_own_devices")}\n`, ""]],
    expect: "fail",
  },
  {
    id: "arm-commented-out",
    rule: "R1",
    file: "plugin",
    edits: [[ARM("e2ee_text_state"), `// ${ARM("e2ee_text_state")}`]],
    expect: "fail",
  },
  {
    id: "dialog-method-renamed",
    rule: "R1",
    file: "plugin",
    edits: [
      [
        "fun textOwnerHandoverSign(call: PluginCall) {",
        "fun textOwnerHandoverSignNow(call: PluginCall) {",
      ],
    ],
    expect: "fail",
  },
  {
    id: "else-routes-text",
    rule: "R1",
    file: "plugin",
    edits: [
      [
        String.raw`call.reject("{\"type\":\"invalid_argument\",\"field\":\"name\"}")`,
        String.raw`if (name.startsWith("e2ee_text_")) resolveText(call) { engine.textState(it) } else call.reject("{\"type\":\"invalid_argument\",\"field\":\"name\"}")`,
      ],
    ],
    expect: "fail",
  },
  // R2
  {
    id: "resolve-guard-only-in-a-comment",
    rule: "R2",
    file: "plugin",
    edits: [
      [
        RESOLVE_GUARD,
        RESOLVE_GUARD.split("\n")
          .map((l) => `        // ${l.trim()}`)
          .join("\n"),
      ],
    ],
    expect: "fail",
  },
  {
    id: "resolve-guard-after-engine",
    rule: "R2",
    file: "plugin",
    edits: [
      [
        lines(
          RESOLVE_GUARD,
          "        resolveJson(call, command(call.data.toString()))",
        ),
        lines(
          "        val json = command(call.data.toString())",
          RESOLVE_GUARD,
          "        resolveJson(call, json)",
        ),
      ],
    ],
    expect: "fail",
  },
  {
    id: "dialog-guard-only-in-a-block-comment",
    rule: "R2",
    file: "plugin",
    edits: [
      [
        DIALOG_GUARD,
        `/*\n${DIALOG_GUARD.replace(/\n {8}val argsJson$/, "")}\n*/\n        val argsJson`,
      ],
    ],
    expect: "fail",
  },
  {
    id: "arm-bypasses-resolveText",
    rule: "R2",
    file: "plugin",
    edits: [
      [
        ARM("e2ee_text_decrypt"),
        `"e2ee_text_decrypt" -> resolveJson(call, engine.textDecrypt(call.data.toString()))`,
      ],
    ],
    expect: "fail",
  },
  {
    id: "listener-bridge-hard-coded",
    rule: "R2b",
    file: "plugin",
    edits: [
      [
        `result.put("listenerBridge", MessageHandler.usingWebMessageListener)`,
        `result.put("listenerBridge", true) // MessageHandler.usingWebMessageListener`,
      ],
    ],
    expect: "fail",
  },
  // R3
  {
    id: "arm-emits",
    rule: "R3",
    file: "plugin",
    edits: [
      [
        ARM("e2ee_text_commit_won"),
        `"e2ee_text_commit_won" -> resolveText(call) { engine.textCommitWon(it).also { emitFromOutcome(it, onlyEpochAdvancing = false) } }`,
      ],
    ],
    expect: "fail",
  },
  {
    id: "resolveText-emits-through-a-helper",
    rule: "R3",
    file: "plugin",
    edits: [
      [
        "        resolveJson(call, command(call.data.toString()))",
        "        textResolved(call, command(call.data.toString()))",
      ],
      [
        "    private fun requireString(",
        lines(
          "    private fun textResolved(call: PluginCall, json: String) {",
          "        resolveJson(call, json)",
          "        emitFromOutcome(json, onlyEpochAdvancing = true)",
          "    }",
          "",
          "    private fun requireString(",
        ),
      ],
    ],
    expect: "fail",
  },
  {
    id: "textCapability-emits",
    rule: "R3",
    file: "plugin",
    edits: [
      [
        `            result.put("listenerBridge", MessageHandler.usingWebMessageListener)`,
        lines(
          `            result.put("listenerBridge", MessageHandler.usingWebMessageListener)`,
          `            emitKeysChanged("", 0L)`,
        ),
      ],
    ],
    expect: "fail",
  },
  {
    id: "dialog-file-notifies",
    rule: "R3",
    file: "dialog",
    edits: [
      [
        "        val latch = CountDownLatch(1)",
        lines(
          "        val latch = CountDownLatch(1)",
          "        notifyListeners()",
        ),
      ],
    ],
    expect: "fail",
  },
  {
    id: "emit-in-a-comment-does-not-trip",
    rule: "R3",
    file: "plugin",
    edits: [
      [
        ARM("e2ee_text_commit_won"),
        `${ARM("e2ee_text_commit_won")} // .also { emitFromOutcome(it, false) }`,
      ],
    ],
    expect: "pass",
  },
  // R4
  {
    id: "no-slot-claim",
    rule: "R4",
    file: "plugin",
    edits: [
      [
        lines(
          "        val dialog = TextConfirmDialog({ activity }, textDialogs)",
          "",
          "        if (!consentInFlight.compareAndSet(false, true)) {",
        ),
        lines(
          "        val dialog = TextConfirmDialog({ activity }, textDialogs)",
          "",
          "        if (consentInFlight.get()) {",
        ),
      ],
    ],
    expect: "fail",
  },
  {
    id: "no-executor-hop",
    rule: "R4",
    file: "plugin",
    edits: [[HOP, HOP.replace("executor.execute {", "run {")]],
    expect: "fail",
  },
  {
    id: "finally-became-catch",
    rule: "R4",
    file: "plugin",
    edits: [
      [
        COMMAND_FINALLY,
        lines(
          "                            command(argsJson, dialog)",
          "                        } catch (error: Throwable) {",
          "                            release()",
          "                            throw error",
          "                        }",
        ),
      ],
    ],
    expect: "fail",
  },
  {
    id: "release-before-the-hop",
    rule: "R4",
    file: "plugin",
    edits: [[HOP, lines("            release()", HOP)]],
    expect: "fail",
  },
  {
    id: "release-does-not-release",
    rule: "R4",
    file: "plugin",
    edits: [
      [
        RELEASE_FUN,
        RELEASE_FUN.replace(
          "if (held.compareAndSet(true, false)) consentInFlight.set(false)",
          "held.set(false)",
        ),
      ],
    ],
    expect: "fail",
  },
  // R5
  {
    id: "store-owner-bare",
    rule: "R5",
    file: "plugin",
    edits: [[STORE_OWNER, `owner ?: "null"`]],
    expect: "fail",
  },
  {
    id: "store-owner-quote-only-in-a-comment",
    rule: "R5",
    file: "plugin",
    edits: [
      [
        `resolveJson(call, ${STORE_OWNER})`,
        `resolveJson(call, owner ?: "null") // ${STORE_OWNER}`,
      ],
    ],
    expect: "fail",
  },
  // R6a
  {
    id: "main-looper-check-commented",
    rule: "R6a",
    file: "dialog",
    edits: [
      [
        "        if (Looper.myLooper() == Looper.getMainLooper()) throw TextConfirmException.Failed()",
        "        // if (Looper.myLooper() == Looper.getMainLooper()) throw TextConfirmException.Failed()",
      ],
    ],
    expect: "fail",
  },
  {
    id: "null-activity-asserted",
    rule: "R6a",
    file: "dialog",
    edits: [
      [
        "val host = activity() ?: throw TextConfirmException.Failed()",
        "val host = activity()!!",
      ],
    ],
    expect: "fail",
  },
  {
    id: "destroyed-activity-unchecked",
    rule: "R6a",
    file: "dialog",
    edits: [
      [
        "(dialogs.destroyed || host.isFinishing || host.isDestroyed)",
        "(dialogs.destroyed || host.isFinishing)",
      ],
    ],
    expect: "fail",
  },
  {
    id: "show-failure-not-settled",
    rule: "R6a",
    file: "dialog",
    edits: [
      [
        lines(
          "                    settle(null)",
          "                    built?.let",
        ),
        "                    built?.let",
      ],
    ],
    expect: "fail",
  },
  // R6b
  {
    id: "ui-thread-recheck-dropped",
    rule: "R6b",
    file: "dialog",
    edits: [
      [
        "if (settled.get() || dialogs.destroyed || host.isFinishing || host.isDestroyed) {",
        "if (settled.get() || host.isFinishing || host.isDestroyed) {",
      ],
    ],
    expect: "fail",
  },
  {
    id: "ui-thread-recheck-only-in-a-comment",
    rule: "R6b",
    file: "dialog",
    edits: [
      [
        "if (settled.get() || dialogs.destroyed || host.isFinishing || host.isDestroyed) {",
        "if (settled.get() || host.isFinishing || host.isDestroyed /* || dialogs.destroyed */) {",
      ],
    ],
    expect: "fail",
  },
  // R6c
  {
    id: "await-in-synchronized",
    rule: "R6c",
    file: "dialog",
    edits: [
      [
        "            latch.await()",
        "            synchronized(this) { latch.await() }",
      ],
    ],
    expect: "fail",
  },
  {
    id: "synchronized-in-a-comment-does-not-trip",
    rule: "R6c",
    file: "dialog",
    edits: [
      [
        "            latch.await()",
        "            latch.await() // not synchronized(this)",
      ],
    ],
    expect: "pass",
  },
  // R6d
  {
    id: "settle-without-compare-and-set",
    rule: "R6d",
    file: "dialog",
    edits: [
      [
        "            if (settled.compareAndSet(false, true)) {",
        "            if (!settled.get()) {",
      ],
    ],
    expect: "fail",
  },
  {
    id: "dismiss-settles-true",
    rule: "R6d",
    file: "dialog",
    edits: [
      [
        "                        settle(false)",
        "                        settle(true)",
      ],
    ],
    expect: "fail",
  },
  {
    id: "positive-sets-the-answer-directly",
    rule: "R6d",
    file: "dialog",
    edits: [
      [
        "{ _, _ -> settle(true) }",
        "{ _, _ -> answer.set(true); latch.countDown() }",
      ],
    ],
    expect: "fail",
  },
  // R6e
  {
    id: "delay-below-700",
    rule: "R6e",
    file: "dialog",
    edits: [
      [
        "private const val TEXT_CONFIRM_DELAY_MS: Long = 700L",
        "private const val TEXT_CONFIRM_DELAY_MS: Long = 300L",
      ],
    ],
    expect: "fail",
  },
  {
    id: "confirm-never-disabled",
    rule: "R6e",
    file: "dialog",
    edits: [["                        confirm.isEnabled = false\n", ""]],
    expect: "fail",
  },
  {
    id: "confirm-enabled-early",
    rule: "R6e",
    file: "dialog",
    edits: [
      [
        "                        confirm.filterTouchesWhenObscured = true",
        lines(
          "                        confirm.filterTouchesWhenObscured = true",
          "                        confirm.isEnabled = true",
        ),
      ],
    ],
    expect: "fail",
  },
  // R6f
  {
    id: "cancel-filter-conditional",
    rule: "R6f",
    file: "dialog",
    edits: [
      [
        "                        cancel.filterTouchesWhenObscured = true",
        "                        if (single) cancel.filterTouchesWhenObscured = true",
      ],
    ],
    expect: "fail",
  },
  {
    id: "cancel-filter-commented",
    rule: "R6f",
    file: "dialog",
    edits: [
      [
        "                        cancel.filterTouchesWhenObscured = true",
        "                        // cancel.filterTouchesWhenObscured = true",
      ],
    ],
    expect: "fail",
  },
  {
    id: "confirm-filter-false",
    rule: "R6f",
    file: "dialog",
    edits: [
      [
        "confirm.filterTouchesWhenObscured = true",
        "confirm.filterTouchesWhenObscured = false",
      ],
    ],
    expect: "fail",
  },
  // R6g
  {
    id: "inform-two-buttons",
    rule: "R6g",
    file: "dialog",
    edits: [
      [
        "builder.setNegativeButton(payload.confirmLabel, null)",
        "builder.setPositiveButton(payload.confirmLabel, null).setNegativeButton(payload.cancelLabel, null)",
      ],
    ],
    expect: "fail",
  },
  {
    id: "inform-asks-a-question",
    rule: "R6g",
    file: "dialog",
    edits: [
      [
        "        ask(payload, single = true)",
        "        ask(payload, single = false)",
      ],
    ],
    expect: "fail",
  },
  {
    id: "blank-cancel-label-allowed",
    rule: "R6g",
    file: "dialog",
    edits: [
      [
        lines(
          "                payload.confirmLabel.isBlank() ||",
          "                payload.cancelLabel.isBlank()",
        ),
        "                payload.confirmLabel.isBlank()",
      ],
    ],
    expect: "fail",
  },
  // R6h
  {
    id: "perform-click",
    rule: "R6h",
    file: "dialog",
    edits: [
      [
        "                        cancel.requestFocus()",
        lines(
          "                        cancel.requestFocus()",
          "                        cancel.performClick()",
        ),
      ],
    ],
    expect: "fail",
  },
  {
    id: "reflection",
    rule: "R6h",
    file: "dialog",
    edits: [
      [
        "                        cancel.requestFocus()",
        lines(
          "                        cancel.requestFocus()",
          `                        cancel.javaClass.getDeclaredField("mListenerInfo").isAccessible = true`,
        ),
      ],
    ],
    expect: "fail",
  },
  {
    id: "perform-click-in-a-comment-does-not-trip",
    rule: "R6h",
    file: "dialog",
    edits: [
      [
        "                        cancel.requestFocus()",
        "                        cancel.requestFocus() // never performClick()",
      ],
    ],
    expect: "pass",
  },
  // R7
  {
    id: "destroyed-flag-commented",
    rule: "R7",
    file: "plugin",
    edits: [
      [
        "        textDialogs.destroyed = true",
        "        // textDialogs.destroyed = true",
      ],
    ],
    expect: "fail",
  },
  {
    id: "dismiss-all-conditional",
    rule: "R7",
    file: "plugin",
    edits: [
      [
        "        textDialogs.dismissAll()",
        "        if (growthDialog != null) textDialogs.dismissAll()",
      ],
    ],
    expect: "fail",
  },
  {
    id: "dialog-built-over-another-holder",
    rule: "R7",
    file: "plugin",
    edits: [
      [
        "TextConfirmDialog({ activity }, textDialogs)",
        "TextConfirmDialog({ activity }, TextDialogs())",
      ],
    ],
    expect: "fail",
  },
  {
    id: "dialog-never-registered",
    rule: "R7",
    file: "dialog",
    edits: [["                    dialogs.add(dialog)\n", ""]],
    expect: "fail",
  },
];

/** Applies each edit to its one occurrence; an anchor not found once throws. */
function mutate(src: string, edits: Control["edits"]): string {
  let out = src;
  for (const [from, to] of edits) {
    const n = out.split(from).length - 1;
    if (n !== 1) {
      throw new Error(
        `control anchor found ${n} times (want 1): ${JSON.stringify(from.slice(0, 90))}`,
      );
    }
    out = out.replace(from, () => to);
  }
  return out;
}

const BASE_PLUGIN = readFileSync(DEFAULT_PLUGIN, "utf8");
const BASE_DIALOG = readFileSync(DEFAULT_DIALOG, "utf8");

test("controls: every rule has a failing control", () => {
  for (const id of Object.keys(RULES)) {
    assert.ok(
      CONTROLS.some((c) => c.rule === id && c.expect === "fail"),
      `${id} has no failing control`,
    );
  }
});

for (const c of CONTROLS) {
  const verb = c.expect === "fail" ? "fires" : "stays green";
  test(`control ${c.id}: ${c.rule} ${verb}`, () => {
    const base = { p: ktLoad(BASE_PLUGIN), d: ktLoad(BASE_DIALOG) };
    const { check } = RULES[c.rule];
    assert.deepEqual(
      check(base.p, base.d),
      [],
      `${c.rule} is red on the base files`,
    );
    const p =
      c.file === "plugin" ? ktLoad(mutate(BASE_PLUGIN, c.edits)) : base.p;
    const d =
      c.file === "dialog" ? ktLoad(mutate(BASE_DIALOG, c.edits)) : base.d;
    const found = check(p, d);
    if (c.expect === "fail") {
      assert.ok(found.length > 0, `${c.rule} stayed green on control ${c.id}`);
    } else {
      assert.deepEqual(found, []);
    }
  });
}
