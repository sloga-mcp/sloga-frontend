// Source-scan spec for the decrypt self id (plan own-message-routing-fix
// section 3.2). Run with Node's built-in runner:
//   node --conditions=browser --test components/client/e2eeDecryptSelf.scan.test.ts
// Native decides whether a message is our own from the store's owner of
// record, and learns that owner from the `selfUserId` the webview passes
// beside the envelope. The envelope is built from the server's
// `E2EEMessage` event, so a self id inside it would be server-controlled.
// Neither file loads under Node (`E2eePlugin.kt` is Kotlin; `e2ee.ts` needs
// Solid, the native bridge and stoat.js), so the wiring is pinned by reading
// the sources. Point `E2EE_DECRYPT_SELF_TS` / `E2EE_DECRYPT_SELF_KT` at other
// copies (the known-bad control: the 03ab5d03 files) to scan those instead;
// they must fail.
//
// The lexers are copied from e2eeIdentityConfirm.scan.test.ts (it exports
// nothing). Comments are stripped before every check, and string contents
// only count where a literal is the subject of the rule, so a commented-out
// argument never satisfies a rule.
//
// e2ee.ts:
//   S1. `e2ee_decrypt` appears exactly once outside comments, as the string
//       literal that is the first argument of `this.#invoke(` (type
//       arguments allowed): one call site, no command held in a variable.
//   S2. That call has exactly two arguments, the second an object literal
//       with exactly two properties: `envelope` (shorthand or
//       `envelope: envelope`) and `selfUserId: this.#client.user?.id` (or
//       `!.id` / `.id`). No spread, so nothing else rides along.
//   S3. Nothing gives an `envelope` a self id: no `envelope.selfUserId` /
//       `envelope.self_user_id` (dotted, optional or bracketed), no
//       `Object.assign(envelope, ...)`, and no object literal assigned to an
//       `envelope` names `selfUserId`, `self_user_id` or `#client.user`.
// E2eePlugin.kt:
//   K1. `"e2ee_decrypt"` appears exactly once outside comments, as a `when`
//       arm head (`"e2ee_decrypt" ->`).
//   K2. That arm, up to the next arm head, calls `engine.decrypt(` exactly
//       once, with two arguments: the first does not mention `selfUserId`,
//       the second is `call.getString("selfUserId")` (optionally named).
//
// The scanners are checked against inline fixtures first (a conforming file
// passes; each mutation fails exactly its own rule), so a green scan is never
// a scanner that cannot fail.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const TS_FILE =
  process.env.E2EE_DECRYPT_SELF_TS || new URL("./e2ee.ts", import.meta.url);
const KT_FILE =
  process.env.E2EE_DECRYPT_SELF_KT ||
  new URL(
    "../../android/app/src/main/java/com/acutest/app/e2ee/E2eePlugin.kt",
    import.meta.url,
  );

// ---- Shared helpers ---------------------------------------------------------

interface Masked {
  /** Comments and string contents blanked. */
  code: string;
  /** Comments blanked; string contents kept. */
  text: string;
}

const squash = (s: string) => s.replace(/\s+/g, "");

function lineOf(src: string, at: number): number {
  let line = 1;
  for (let i = 0; i < at && i < src.length; i++) if (src[i] === "\n") line++;
  return line;
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

/**
 * The top-level comma-separated items between the bracket at `open` and its
 * match: brackets are matched on `m.code`, items are sliced from `m.text`
 * (string contents kept) and squashed.
 */
function items(m: Masked, open: number): string[] {
  const close = matchClose(m.code, open);
  const out: string[] = [];
  let start = open + 1;
  for (let i = open + 1; i < close; i++) {
    const c = m.code[i];
    if (c === "(" || c === "[" || c === "{") i = matchClose(m.code, i);
    else if (c === ",") {
      out.push(m.text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(m.text.slice(start, close));
  return out.map(squash).filter((a) => a !== "");
}

function skipWs(code: string, i: number): number {
  while (i < code.length && /\s/.test(code[i])) i++;
  return i;
}

// ---- TypeScript lexer (as in e2eeIdentityConfirm.scan.test.ts) -------------

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

// ---- Kotlin lexer (as in e2eeIdentityConfirm.scan.test.ts) -----------------

/**
 * Blanks Kotlin comments (block comments nest) and string / char contents
 * with spaces (newlines kept), so every index is the same index in `src`.
 * `${...}` templates inside strings are scanned as code.
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

// ---- e2ee.ts rules ----------------------------------------------------------

const DECRYPT_COMMAND = "e2ee_decrypt";
const INVOKE_BEFORE = /this\s*\.\s*#invoke\s*(?:<[^()]*>)?\s*$/;
const SELF_ARG = /^selfUserId:this\.#client\.user[?!]?\.id$/;
const SELF_NAMES = /selfUserId|self_user_id|#client\s*\.\s*user\b/;
const ENVELOPE_FIELD =
  /\benvelope\s*!?\s*(?:\?\.|\.)\s*(?:selfUserId|self_user_id)\b|\benvelope\s*!?\s*(?:\?\.)?\s*\[\s*["'`](?:selfUserId|self_user_id)["'`]\s*\]/g;
const ENVELOPE_ASSIGN = /\bObject\s*\.\s*assign\s*\(\s*envelope\b/g;
/** `envelope =` / `envelope: T =` (not `==`, `=>`), the value after it. */
const ENVELOPE_INIT = /\benvelope\s*(?::[^=;(){}]*)?=(?![=>])/g;

/** Index of the last non-space character at or before `i`. */
function skipBack(code: string, i: number): number {
  while (i >= 0 && /\s/.test(code[i])) i--;
  return i;
}

/** The `{` opening the call's second argument, or -1 if it is not a literal. */
function secondArgOpen(code: string, open: number): number {
  const close = matchClose(code, open);
  for (let i = open + 1; i < close; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") i = matchClose(code, i);
    else if (c === ",") {
      const j = skipWs(code, i + 1);
      return code[j] === "{" ? j : -1;
    }
  }
  return -1;
}

function tsViolations(src: string): string[] {
  const m = maskTs(src);
  const out: string[] = [];

  // S1: the one command literal, as a direct `this.#invoke(` argument.
  const hits = [...m.text.matchAll(new RegExp(DECRYPT_COMMAND, "g"))];
  if (hits.length !== 1) {
    out.push(
      `S1 ${DECRYPT_COMMAND} appears ${hits.length} times outside comments` +
        ` (lines ${hits.map((h) => lineOf(src, h.index!)).join(", ")})`,
    );
  }
  let open = -1;
  if (hits.length >= 1) {
    const at = hits[0].index!;
    const quote = m.text[at - 1];
    const quoted =
      /["'`]/.test(quote) && m.text[at + DECRYPT_COMMAND.length] === quote;
    const paren = quoted ? skipBack(m.code, at - 2) : -1;
    if (
      !quoted ||
      m.code[paren] !== "(" ||
      !INVOKE_BEFORE.test(m.code.slice(Math.max(0, paren - 200), paren))
    ) {
      out.push(
        `S1 line ${lineOf(src, at)}: ${DECRYPT_COMMAND} is not the literal` +
          " first argument of this.#invoke(",
      );
    } else {
      open = paren;
    }
  }

  // S2: exactly `{ envelope, selfUserId: this.#client.user?.id }`.
  if (open >= 0) {
    const args = items(m, open);
    const line = lineOf(src, open);
    const objOpen = secondArgOpen(m.code, open);
    if (args.length !== 2 || objOpen < 0) {
      out.push(
        `S2 line ${line}: expected (command, { ... }), got ${JSON.stringify(args)}`,
      );
    } else {
      const props = items(m, objOpen);
      if (props.some((p) => p.startsWith("..."))) {
        out.push(`S2 line ${line}: a spread in the decrypt arguments`);
      }
      if (!props.some((p) => p === "envelope" || p === "envelope:envelope")) {
        out.push(`S2 line ${line}: no plain \`envelope\` property`);
      }
      const self = props.filter((p) => /^["'`]?selfUserId["'`]?:/.test(p));
      if (self.length !== 1) {
        out.push(
          `S2 line ${line}: ${self.length} selfUserId properties, want 1`,
        );
      } else if (!SELF_ARG.test(self[0])) {
        out.push(
          `S2 line ${line}: selfUserId is \`${self[0]}\`, not this.#client.user's id`,
        );
      }
      if (props.length !== 2) {
        out.push(
          `S2 line ${line}: ${props.length} properties, want exactly envelope` +
            ` and selfUserId: ${JSON.stringify(props)}`,
        );
      }
    }
  }

  // S3: nothing writes a self id into an envelope.
  for (const hit of m.text.matchAll(ENVELOPE_FIELD)) {
    out.push(
      `S3 line ${lineOf(src, hit.index!)}: \`${squash(hit[0])}\` on an envelope`,
    );
  }
  for (const hit of m.code.matchAll(ENVELOPE_ASSIGN)) {
    out.push(
      `S3 line ${lineOf(src, hit.index!)}: Object.assign(envelope, ...)`,
    );
  }
  for (const hit of m.code.matchAll(ENVELOPE_INIT)) {
    const value = skipWs(m.code, hit.index! + hit[0].length);
    if (m.code[value] !== "{") continue;
    const literal = m.text.slice(value, matchClose(m.code, value) + 1);
    if (SELF_NAMES.test(literal)) {
      out.push(
        `S3 line ${lineOf(src, value)}: an envelope literal names a self id`,
      );
    }
  }
  return out;
}

// ---- E2eePlugin.kt rules ----------------------------------------------------

const KT_ARM = /"e2ee_decrypt"/g;
/** A `when` arm head on its own line: one or more string literals, or else. */
const KT_NEXT_ARM = /\n[ \t]*(?:"[^"\n]*"(?:\s*,\s*"[^"\n]*")*|else)\s*->/g;
const KT_DECRYPT = /\bengine\s*(?:\(\s*\))?\s*\.\s*decrypt\s*\(/g;
const KT_SELF_ARG = /^(?:\w+=)?call\.getString\("selfUserId"\)$/;

function ktViolations(src: string): string[] {
  const m = maskKotlin(src);
  const out: string[] = [];

  // K1: the one arm head.
  const hits = [...m.text.matchAll(KT_ARM)];
  if (hits.length !== 1) {
    out.push(
      `K1 "e2ee_decrypt" appears ${hits.length} times outside comments` +
        ` (lines ${hits.map((h) => lineOf(src, h.index!)).join(", ")})`,
    );
  }
  if (hits.length === 0) return out;
  const at = hits[0].index!;
  const arrow = skipWs(m.code, at + '"e2ee_decrypt"'.length);
  if (!m.code.startsWith("->", arrow)) {
    out.push(`K1 line ${lineOf(src, at)}: "e2ee_decrypt" is not a when arm`);
    return out;
  }

  // K2: the arm's one engine.decrypt(envelope, call.getString("selfUserId")).
  KT_NEXT_ARM.lastIndex = arrow + 2;
  const next = KT_NEXT_ARM.exec(m.code);
  const end = next ? next.index : m.code.length;
  const arm = m.code.slice(0, end);
  const calls = [...arm.matchAll(KT_DECRYPT)].filter((c) => c.index! > arrow);
  const line = lineOf(src, at);
  if (calls.length !== 1) {
    out.push(
      `K2 line ${line}: the arm calls engine.decrypt( ${calls.length} times`,
    );
    return out;
  }
  const paren = calls[0].index! + calls[0][0].length - 1;
  const args = items(m, paren);
  if (args.length !== 2) {
    out.push(
      `K2 line ${line}: engine.decrypt has ${args.length} arguments, want 2:` +
        ` ${JSON.stringify(args)}`,
    );
    return out;
  }
  if (/selfUserId/.test(args[0])) {
    out.push(`K2 line ${line}: the envelope argument mentions selfUserId`);
  }
  if (!KT_SELF_ARG.test(args[1])) {
    out.push(
      `K2 line ${line}: second argument is \`${args[1]}\`, not` +
        ' call.getString("selfUserId")',
    );
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

/** A conforming e2ee.ts; trailing comments only make swap targets unique. */
const TS_FIXTURE = `
// A comment naming e2ee_decrypt does not count.
class E2EEBridge {
  #onEvent(event: Record<string, unknown>) {
    const envelope = { ...event, type: undefined };
    delete envelope.type;
    void this.#handleEnvelope(envelope);
  }

  async #handleEnvelope(envelope: Record<string, unknown>): Promise<void> {
    if (envelope.recipient_device_id !== "d") return;
    const outcome = await this.#invoke<DecryptOutcome>("e2ee_decrypt", {
      envelope,
      selfUserId: this.#client.user?.id,
    });
    this.#client.events.send({ type: "E2EEAck", ids: [outcome.id] });
  }
}
`;

/** A conforming plugin `call` dispatcher. */
const KT_FIXTURE = `
@CapacitorPlugin(name = "E2ee")
class E2eePlugin : Plugin() {
    @PluginMethod
    fun call(call: PluginCall) {
        // "e2ee_decrypt" in a comment does not count
        run(call) { engine ->
            when (call.getString("__cmd")) {
                "e2ee_encrypt" ->
                    resolveJson(
                        call,
                        engine.encrypt(
                            requireString(call, "peerUserId"),
                            requireString(call, "selfUserId"),
                        ),
                    )
                "e2ee_decrypt" ->
                    resolveJson(
                        call,
                        engine.decrypt(
                            objectJson(call, "envelope"),
                            call.getString("selfUserId"),
                        ),
                    )
                "e2ee_history" ->
                    resolveJson(call, engine.history(requireString(call, "peerUserId")))
                else -> call.reject("unknown")
            }
        }
    }
}
`;

test("fixture: the conforming e2ee.ts passes", () => {
  assert.deepEqual(tsViolations(TS_FIXTURE), []);
});

test("fixture: the conforming plugin passes", () => {
  assert.deepEqual(ktViolations(KT_FIXTURE), []);
});

const TS_MUTATIONS: {
  label: string;
  swaps: [string, string][];
  rules: string[];
  expected: RegExp;
}[] = [
  {
    label: "no self id (the 03ab5d03 call)",
    swaps: [["      selfUserId: this.#client.user?.id,\n", ""]],
    rules: ["S2"],
    expected: /0 selfUserId properties/,
  },
  {
    label: "self id only in a comment",
    swaps: [
      [
        "      selfUserId: this.#client.user?.id,",
        "      // selfUserId: this.#client.user?.id,",
      ],
    ],
    rules: ["S2"],
    expected: /0 selfUserId properties/,
  },
  {
    label: "self id read from the envelope",
    swaps: [
      [
        "selfUserId: this.#client.user?.id,",
        "selfUserId: envelope.recipient_user_id,",
      ],
    ],
    rules: ["S2"],
    expected: /not this\.#client\.user's id/,
  },
  {
    label: "self id taken from a different user",
    swaps: [
      ["selfUserId: this.#client.user?.id,", "selfUserId: this.#peer?.id,"],
    ],
    rules: ["S2"],
    expected: /not this\.#client\.user's id/,
  },
  {
    label: "a spread rides along",
    swaps: [["      envelope,\n", "      envelope,\n      ...extra,\n"]],
    rules: ["S2"],
    expected: /a spread/,
  },
  {
    label: "the envelope argument is not the plain envelope",
    swaps: [["      envelope,\n", "      envelope: { ...envelope },\n"]],
    rules: ["S2"],
    expected: /no plain `envelope`/,
  },
  {
    label: "a second self id property",
    swaps: [
      [
        "      selfUserId: this.#client.user?.id,\n",
        "      selfUserId: this.#client.user?.id,\n      selfUserId: x,\n",
      ],
    ],
    rules: ["S2"],
    expected: /2 selfUserId properties/,
  },
  {
    label: "a second decrypt call site",
    swaps: [
      [
        "    this.#client.events.send(",
        '    await this.#invoke("e2ee_decrypt", { envelope });\n' +
          "    this.#client.events.send(",
      ],
    ],
    rules: ["S1"],
    expected: /appears 2 times/,
  },
  {
    label: "the command held in a variable",
    swaps: [
      [
        'this.#invoke<DecryptOutcome>("e2ee_decrypt", {',
        "this.#invoke<DecryptOutcome>(DECRYPT, {",
      ],
      [
        "    const outcome",
        '    const DECRYPT = "e2ee_decrypt";\n    const outcome',
      ],
    ],
    rules: ["S1"],
    expected: /not the literal/,
  },
  {
    label: "a self id written onto the envelope",
    swaps: [
      [
        "    delete envelope.type;",
        "    delete envelope.type;\n" +
          "    envelope.selfUserId = this.#client.user?.id;",
      ],
    ],
    rules: ["S3"],
    expected: /envelope\.selfUserId/,
  },
  {
    label: "a self id written by index",
    swaps: [
      [
        "    delete envelope.type;",
        '    delete envelope.type;\n    envelope["self_user_id"] = "x";',
      ],
    ],
    rules: ["S3"],
    expected: /on an envelope/,
  },
  {
    label: "a self id assigned into the envelope",
    swaps: [
      [
        "    delete envelope.type;",
        "    delete envelope.type;\n    Object.assign(envelope, { s: 1 });",
      ],
    ],
    rules: ["S3"],
    expected: /Object\.assign/,
  },
  {
    label: "a self id spread into the envelope literal",
    swaps: [
      [
        "const envelope = { ...event, type: undefined };",
        "const envelope = { ...event, type: undefined, selfUserId: id };",
      ],
    ],
    rules: ["S3"],
    expected: /envelope literal names a self id/,
  },
  {
    label: "the client's user spread into the envelope literal",
    swaps: [
      [
        "const envelope = { ...event, type: undefined };",
        "const envelope = { ...event, ...{ s: this.#client.user?.id } };",
      ],
    ],
    rules: ["S3"],
    expected: /envelope literal names a self id/,
  },
];

for (const { label, swaps, rules, expected } of TS_MUTATIONS) {
  test(`fixture mutation (e2ee.ts): ${label}`, () => {
    assertOnly(
      label,
      tsViolations(swapped(TS_FIXTURE, swaps)),
      rules,
      expected,
    );
  });
}

const KT_MUTATIONS: typeof TS_MUTATIONS = [
  {
    label: "the one-argument decrypt (the 03ab5d03 arm)",
    swaps: [
      ['                            call.getString("selfUserId"),\n', ""],
    ],
    rules: ["K2"],
    expected: /1 arguments, want 2/,
  },
  {
    label: "the self id only in a comment",
    swaps: [
      [
        '                            call.getString("selfUserId"),',
        '                            // call.getString("selfUserId"),',
      ],
    ],
    rules: ["K2"],
    expected: /1 arguments, want 2/,
  },
  {
    label: "the wrong key",
    swaps: [
      ['call.getString("selfUserId"),\n', 'call.getString("self_user_id"),\n'],
    ],
    rules: ["K2"],
    expected: /not call\.getString/,
  },
  {
    label: "the self id read out of the envelope",
    swaps: [
      [
        'call.getString("selfUserId"),\n',
        'call.getObject("envelope")?.getString("recipient_user_id"),\n',
      ],
    ],
    rules: ["K2"],
    expected: /not call\.getString/,
  },
  {
    label: "the arguments swapped",
    swaps: [
      [
        '                            objectJson(call, "envelope"),\n' +
          '                            call.getString("selfUserId"),\n',
        '                            call.getString("selfUserId"),\n' +
          '                            objectJson(call, "envelope"),\n',
      ],
    ],
    rules: ["K2"],
    expected: /envelope argument mentions selfUserId/,
  },
  {
    label: "the arm no longer calls engine.decrypt",
    swaps: [["engine.decrypt(", "engine.decryptLegacy("]],
    rules: ["K2"],
    expected: /0 times/,
  },
  {
    label: "a second decrypt arm",
    swaps: [
      [
        '                "e2ee_history" ->',
        '                "e2ee_decrypt" -> call.reject("dup")\n' +
          '                "e2ee_history" ->',
      ],
    ],
    rules: ["K1"],
    expected: /appears 2 times/,
  },
];

for (const { label, swaps, rules, expected } of KT_MUTATIONS) {
  test(`fixture mutation (E2eePlugin.kt): ${label}`, () => {
    assertOnly(
      label,
      ktViolations(swapped(KT_FIXTURE, swaps)),
      rules,
      expected,
    );
  });
}

// ---- The real sources -------------------------------------------------------

test("e2ee.ts: decrypt passes our own id beside the envelope, never in it", () => {
  assert.deepEqual(tsViolations(readFileSync(TS_FILE, "utf8")), []);
});

test("E2eePlugin.kt: the decrypt arm forwards selfUserId to engine.decrypt", () => {
  assert.deepEqual(ktViolations(readFileSync(KT_FILE, "utf8")), []);
});
