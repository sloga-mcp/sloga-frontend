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
//       Each method has at least one commit of each kind.
//   K4. Each method calls its preview (`previewGroupEnable` /
//       `previewGroupAdd`) exactly once, as `val P = <receiver>.preview…(`;
//       every commit passes `P.expectedAfter` as an argument; the file holds
//       no "expectedAfter" string literal (call data never supplies it).
//   K5. A plugin-level `val G = AtomicBoolean(…)` (declared directly in the
//       `class E2eePlugin` body, not in a function or an inner class) on
//       which BOTH methods call `G.compareAndSet(false, true)` (unqualified)
//       before their preview, and `G.set(false)` somewhere in the method.
//   K6. Each method has a `setOnDismissListener` (or `OnDismissListener {`)
//       lambda that claims a method-local `val O = AtomicBoolean(false)`
//       with `O.compareAndSet(false, true)` and rejects with the `declined`
//       literal; every positive-button commit is preceded by the same claim
//       inside its lambda; a negative-button or cancel listener that settles
//       the call (reject / resolve) makes the same claim.
//   K7. Each method has `if (!G.compareAndSet(false, true)) { … }` whose body
//       rejects with the `busy` literal and returns.
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
  params: string;
  annotated: boolean;
  /** The block body's `{` and `}`; -1 for an expression or abstract body. */
  open: number;
  close: number;
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
    let depth = 0;
    for (let i = parenClose + 1; i < code.length; i++) {
      const c = code[i];
      if (c === "(" || c === "<") depth++;
      else if (c === ")" || (c === ">" && code[i - 1] !== "-")) depth--;
      else if (depth === 0 && /[=;}]/.test(c)) break;
      else if (depth === 0 && /^fun\b/.test(code.slice(i, i + 4))) break;
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
      params: code.slice(paren + 1, parenClose),
      annotated: /@PluginMethod\b/.test(before.slice(boundary + 1)),
      open,
      close: open < 0 ? -1 : matchClose(code, open),
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
    for (const rule of ["K3", "K4", "K5", "K6", "K7"]) {
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

    // K5: the single-in-flight guard.
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
      const released = new RegExp(
        String.raw`\b${guard}\s*\.\s*set\s*\(\s*false\s*\)`,
      );
      if (!released.test(code.slice(f.open, f.close + 1))) {
        fail("K5", `${g.method}: never releases ${guard} (set(false))`);
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
    const busy =
      guard &&
      ktIfs(m, body).find((s) =>
        [
          `!${guard}.compareAndSet(false,true)`,
          `${guard}.compareAndSet(false,true)==false`,
        ].includes(s.cond),
      );
    if (!busy) {
      fail(
        "K7",
        `${g.method}: no \`if (!<guard>.compareAndSet(false, true))\` busy branch`,
      );
    } else {
      const [from, to] = busy.then;
      if (
        !REJECT.test(code.slice(from, to + 1)) ||
        !BUSY.test(text.slice(from, to + 1)) ||
        !/\breturn\b/.test(code.slice(from, to + 1))
      ) {
        fail(
          "K7",
          `${g.method}: the taken-guard branch must reject {"type":"busy"} and return`,
        );
      }
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

@CapacitorPlugin(name = "E2ee")
class E2eePlugin : Plugin() {
    private val executor: ExecutorService = Executors.newCachedThreadPool()

    /** One growth dialog at a time; enableGroup( and addGroupMember( share it. */
    private val growthInFlight = AtomicBoolean(false)

    private fun engine() = E2eeNative.engine(context)

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
                activity.runOnUiThread {
                    val settled = AtomicBoolean(false)
                    AlertDialog.Builder(activity)
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
                                growthInFlight.set(false)
                                call.reject("{\\"type\\":\\"declined\\"}") // enable-declined
                            }
                        }
                        .show()
                }
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
        executor.execute {
            try {
                val preview: GroupGrowthPrompt = engine().previewGroupAdd(conversationId, userId, selfUserId, labels)
                if (preview.needsPrompt) { // add-needs-prompt
                    activity.runOnUiThread {
                        val answered = AtomicBoolean(false)
                        AlertDialog.Builder(activity)
                            .setMessage(preview.message)
                            .setPositiveButton(preview.confirmLabel, DialogInterface.OnClickListener { _, _ -> // add-positive
                                if (answered.compareAndSet(false, true)) {
                                    run(call) {
                                        try {
                                            resolveJson(call, engine().addGroupMember(conversationId, userId, selfUserId, bundles, expectedAfter = preview.expectedAfter, prompted = true))
                                        } finally {
                                            growthInFlight.set(false)
                                        }
                                    }
                                }
                            })
                            .setOnCancelListener { // add-cancel
                                if (answered.compareAndSet(false, true)) call.reject("{\\"type\\":\\"declined\\"}")
                            }
                            .setOnDismissListener(DialogInterface.OnDismissListener { // add-dismiss
                                if (answered.compareAndSet(false, true)) {
                                    growthInFlight.set(false)
                                    call.reject("{\\"type\\":\\"declined\\"}")
                                }
                            })
                            .show()
                    }
                } else {
                    try {
                        resolveJson(call, engine().addGroupMember(conversationId, userId, selfUserId, bundles, preview.expectedAfter, false)) // add-commit-direct
                    } finally {
                        growthInFlight.set(false)
                    }
                }
            } catch (error: Throwable) {
                growthInFlight.set(false)
                rejectScrubbed(call, error)
            }
        }
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
        '.setNegativeButton(prompt.cancelLabel) { _, _ -> if (settled.compareAndSet(false, true)) call.reject("x") }',
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
          'if (answered.compareAndSet(false, true)) call.reject("{\\"type\\":\\"declined\\"}")',
          'call.reject("{\\"type\\":\\"declined\\"}")',
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
  ];
  for (const [label, swaps, expected] of cases) {
    assertFires(label, ktViolations(ktFixture(...swaps)), expected);
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
  ["K3", "engine commits only in setPositiveButton or the !needsPrompt branch"],
  ["K4", "expectedAfter comes from the preview result"],
  ["K5", "a plugin-level AtomicBoolean single-in-flight guard in both"],
  ["K6", "an OnDismissListener rejects declined behind a resolve-once guard"],
  ["K7", "a taken guard rejects busy"],
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
