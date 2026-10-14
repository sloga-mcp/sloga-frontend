// Source-scan spec for the group send gate's call sites in `e2ee.ts` — run
// with Node's built-in runner:
//   node --conditions=browser --test components/client/e2eeGroupSendGate.scan.test.ts
// `e2ee.ts` cannot load under Node (Solid, the native bridge, stoat.js), so
// the wiring is pinned by reading its source. Point `E2EE_SCAN_FILE` at
// another copy (the known-bad control: the 0d81d2e9 `e2ee.ts`) to scan that
// instead; it must fail.
//
// The rules, per method body (comments stripped; a missing method, or more
// than one definition, fails loudly):
//
// handleGroupMessageSend and prepareDraftAttachments, each:
//   1. calls `groupSendDecision(`;
//   2. holds at least TWO string literals "e2ee_send_mode_group" (the initial
//      verdict and the re-check before a proven plaintext `return null`), at
//      least one of them AFTER the first `groupSendDecision(` call;
//   3. has no `if (...)` whose condition compares `<expr>.mode` with
//      "plaintext" (either order, == or ===) and whose consequent contains
//      `return null` — no bare plaintext → null;
//   4. has no `switch (...)` on `<expr>.mode` whose `case "plaintext":` clause
//      contains `return null` (the same bypass written as a switch).
// sendModeNowFor:
//   5. holds at least TWO string literals "e2ee_send_mode_group" (the proof
//      branch re-invokes the native verdict). A call to a re-check helper
//      does NOT satisfy this rule; the literal must appear in the body.
//
// The scanner is checked against inline fixtures first (a conforming body
// passes; each violation is reported; comments, strings, template literals
// and regex literals do not confuse it), so a green scan is never a scanner
// that cannot fail.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SCAN_FILE =
  process.env.E2EE_SCAN_FILE || new URL("./e2ee.ts", import.meta.url);

// ---- A minimal lexer --------------------------------------------------------

interface Masked {
  /** Comments, string / template / regex contents blanked. */
  code: string;
  /** Comments blanked; string contents kept. */
  text: string;
}

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
function mask(src: string): Masked {
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

// ---- Method extraction ------------------------------------------------------

interface Body {
  /** Index of the body's `{` and its matching `}` in the source. */
  open: number;
  close: number;
  code: string;
  text: string;
}

/**
 * The body of the one method DEFINITION named `name` (a line starting with
 * optional modifiers, `async`, then `name(`, followed by a `{` body — a
 * call site or a body-less signature is not a definition).
 */
function methodBody(m: Masked, name: string): Body {
  const head = new RegExp(
    String.raw`^[ \t]*(?:(?:public|private|protected|static|override)\s+)*` +
      String.raw`(?:async\s+)?${name}\s*\(`,
    "gm",
  );
  const found: Body[] = [];
  for (const match of m.code.matchAll(head)) {
    const paren = match.index + match[0].length - 1;
    let i = matchClose(m.code, paren) + 1;
    let depth = 0;
    let open = -1;
    // Walk the return type to the body: `<`/`(`/`[` nest; `=>` is not a `>`.
    for (; i < m.code.length; i++) {
      const c = m.code[i];
      if (c === "(" || c === "[" || c === "<") depth++;
      else if (c === ")" || c === "]") depth--;
      else if (c === ">" && m.code[i - 1] !== "=") depth--;
      else if (c === ";" && depth === 0) break;
      else if (c === "{") {
        if (depth === 0) {
          open = i;
          break;
        }
        i = matchClose(m.code, i);
      }
    }
    if (open < 0) continue;
    const close = matchClose(m.code, open);
    found.push({
      open,
      close,
      code: m.code.slice(open, close + 1),
      text: m.text.slice(open, close + 1),
    });
  }
  if (found.length !== 1) {
    throw new Error(
      `method ${name}: expected exactly one definition, found ${found.length}`,
    );
  }
  return found[0];
}

// ---- The rules --------------------------------------------------------------

const SEND_MODE_GROUP = /(["'`])e2ee_send_mode_group\1/g;
const DECISION_CALL = /\bgroupSendDecision\s*\(/;
const RETURN_NULL = /\breturn\s+null\b/;
const MODE_IS_PLAINTEXT =
  /\.mode\s*===?\s*(["'`])plaintext\1|(["'`])plaintext\2\s*===?\s*[\w$.?[\]]*\.mode\b/;

/** End of the statement starting at `i` (masked code): its `;` or `}`. */
function statementEnd(code: string, i: number): number {
  for (let j = i; j < code.length; j++) {
    const c = code[j];
    if (c === "(" || c === "[" || c === "{") j = matchClose(code, j);
    else if (c === ";" || c === "}") return j;
  }
  return code.length;
}

/** Each `if` in a body: its condition (text) and consequent (code). */
function ifStatements(body: Body): { cond: string; then: string }[] {
  const out: { cond: string; then: string }[] = [];
  for (const match of body.code.matchAll(/\bif\s*\(/g)) {
    const paren = match.index + match[0].length - 1;
    const condClose = matchClose(body.code, paren);
    let k = condClose + 1;
    while (/\s/.test(body.code[k])) k++;
    const end =
      body.code[k] === "{"
        ? matchClose(body.code, k)
        : statementEnd(body.code, k);
    out.push({
      cond: body.text.slice(paren + 1, condClose),
      then: body.code.slice(k, end + 1),
    });
  }
  return out;
}

/** Each `case "plaintext":` clause of a `switch` on `<expr>.mode`. */
function plaintextModeCases(body: Body): string[] {
  const out: string[] = [];
  for (const match of body.code.matchAll(/\bswitch\s*\(/g)) {
    const paren = match.index + match[0].length - 1;
    const condClose = matchClose(body.code, paren);
    if (!/\.mode\b/.test(body.code.slice(paren + 1, condClose))) continue;
    const open = body.code.indexOf("{", condClose);
    const close = matchClose(body.code, open);
    const clauses = /\b(?:case\b|default\s*:)/g;
    const starts: number[] = [];
    for (const c of body.code.slice(open, close).matchAll(clauses)) {
      starts.push(open + c.index);
    }
    starts.forEach((start, idx) => {
      const end = starts[idx + 1] ?? close;
      if (/^case\s*(["'`])plaintext\1\s*:/.test(body.text.slice(start, end))) {
        out.push(body.code.slice(start, end));
      }
    });
  }
  return out;
}

/** Every rule violation in `src`; empty means the wiring conforms. */
function violations(src: string): string[] {
  const m = mask(src);
  const out: string[] = [];

  for (const name of ["handleGroupMessageSend", "prepareDraftAttachments"]) {
    const body = methodBody(m, name);
    const decision = body.code.search(DECISION_CALL);
    if (decision < 0) out.push(`${name}: no groupSendDecision( call`);

    const literals = [...body.text.matchAll(SEND_MODE_GROUP)].map(
      (l) => l.index,
    );
    if (literals.length < 2) {
      out.push(
        `${name}: "e2ee_send_mode_group" appears ${literals.length} time(s), need 2`,
      );
    }
    if (decision >= 0 && !literals.some((at) => at > decision)) {
      out.push(
        `${name}: no "e2ee_send_mode_group" re-check after the decision`,
      );
    }

    for (const { cond, then } of ifStatements(body)) {
      if (MODE_IS_PLAINTEXT.test(cond) && RETURN_NULL.test(then)) {
        out.push(`${name}: bare plaintext -> return null (${cond.trim()})`);
      }
    }
    if (plaintextModeCases(body).some((clause) => RETURN_NULL.test(clause))) {
      out.push(`${name}: switch on .mode returns null for "plaintext"`);
    }
  }

  const nowFor = methodBody(m, "sendModeNowFor");
  const count = [...nowFor.text.matchAll(SEND_MODE_GROUP)].length;
  if (count < 2) {
    out.push(
      `sendModeNowFor: "e2ee_send_mode_group" appears ${count} time(s), need 2`,
    );
  }
  return out;
}

// ---- Fixtures: the scanner itself must be able to fail ----------------------

/** A conforming class; each swap replaces one exact snippet to break it. */
function fixture(...swaps: [string, string][]): string {
  let src = `
class Fixture {
  // handleGroupMessageSend( in a comment is not a definition
  async handleGroupMessageSend(
    channel: Channel,
    data: { content?: string },
  ): Promise<{ id: string } | null> {
    if (channel.type !== "Group") return null;
    const pattern = /[{]+\\/"}/g; // a regex literal holding braces
    const note = \`id \${channel.id} {\`; /* "{" in a comment */
    const verdict = await this.#invoke("e2ee_send_mode_group", { id: 1 });
    const decision = groupSendDecision(verdict, await this.#proof());
    if (decision === "plaintext") {
      if (verdict.mode === "group_unconfirmed") {
        const fresh = await this.#invoke("e2ee_send_mode_group", { id: 1 });
        if (fresh?.mode !== "group_unconfirmed") throw new Error("}");
      }
      return null;
    }
    return { id: note + pattern.source };
  }

  async prepareDraftAttachments(
    channel: Channel,
    items: string[],
  ): Promise<string[] | null> {
    const verdict = await this.#invoke("e2ee_send_mode_group", {});
    const decision = groupSendDecision(verdict, null);
    switch (verdict.mode) {
      case "encrypt":
        break;
      case "plaintext":
        this.#note();
        break;
      default:
        break;
    }
    if (decision === "plaintext") {
      await this.#invoke("e2ee_send_mode_group", {});
      return null;
    }
    if (!items.length) return null;
    return items;
  }

  async sendModeNowFor(
    channel: Channel,
    opts?: { proof?: boolean },
  ): Promise<string | null> {
    const verdict = await this.#invoke("e2ee_send_mode_group", {});
    if (opts?.proof) {
      return this.#invoke("e2ee_send_mode_group", {});
    }
    return verdict;
  }
}
`;
  for (const [from, to] of swaps) {
    assert.equal(src.split(from).length, 2, `fixture swap: ${from}`);
    src = src.replace(from, to);
  }
  return src;
}

test("scanner: a conforming fixture has no violations", () => {
  assert.deepEqual(violations(fixture()), []);
});

test("scanner: each rule fires on its own violation", () => {
  const cases: [string, [string, string][], RegExp][] = [
    [
      "no decision call",
      [
        [
          "groupSendDecision(verdict, await this.#proof())",
          "pick(verdict, await this.#proof())",
        ],
      ],
      /handleGroupMessageSend: no groupSendDecision\(/,
    ],
    [
      "re-check moved into a helper",
      [
        [
          'const fresh = await this.#invoke("e2ee_send_mode_group", { id: 1 });',
          "const fresh = await this.#recheck();",
        ],
      ],
      /handleGroupMessageSend: "e2ee_send_mode_group" appears 1 time/,
    ],
    [
      "both literals before the decision",
      [
        ["const decision = groupSendDecision(verdict, null);", ""],
        [
          "if (!items.length) return null;",
          "const decision = groupSendDecision(verdict, null);",
        ],
      ],
      /prepareDraftAttachments: no "e2ee_send_mode_group" re-check after/,
    ],
    [
      "bare plaintext if",
      [
        [
          'if (channel.type !== "Group") return null;',
          'if (verdict.mode === "plaintext") return null;',
        ],
      ],
      /handleGroupMessageSend: bare plaintext -> return null/,
    ],
    [
      "bare plaintext if, reversed operands, in a block",
      [
        [
          "if (!items.length) return null;",
          'if ("plaintext" == verdict?.mode) {\n      return null;\n    }',
        ],
      ],
      /prepareDraftAttachments: bare plaintext -> return null/,
    ],
    [
      "switch case returns null",
      [["this.#note();\n        break;", "return null;"]],
      /prepareDraftAttachments: switch on \.mode returns null/,
    ],
    [
      "sendModeNowFor without the proof re-invoke",
      [
        [
          'return this.#invoke("e2ee_send_mode_group", {});',
          "return this.#recheckGroupMode();",
        ],
      ],
      /sendModeNowFor: "e2ee_send_mode_group" appears 1 time/,
    ],
    [
      "a literal only in a comment does not count",
      [
        [
          'return this.#invoke("e2ee_send_mode_group", {});',
          '// "e2ee_send_mode_group"\n      return verdict;',
        ],
      ],
      /sendModeNowFor: "e2ee_send_mode_group" appears 1 time/,
    ],
  ];
  for (const [label, swaps, expected] of cases) {
    const found = violations(fixture(...swaps));
    assert.ok(
      found.some((v) => expected.test(v)),
      `${label}: got ${JSON.stringify(found)}`,
    );
  }
});

test("scanner: a missing or duplicated method fails loudly", () => {
  assert.throws(
    () => violations(fixture(["async sendModeNowFor(", "async sendModeFor("])),
    /method sendModeNowFor: expected exactly one definition, found 0/,
  );
  assert.throws(
    () =>
      violations(
        fixture([
          "async prepareDraftAttachments(",
          "async handleGroupMessageSend(",
        ]),
      ),
    /method handleGroupMessageSend: expected exactly one definition, found 2/,
  );
});

// ---- The real file ----------------------------------------------------------

test(`e2ee.ts wiring of the group send gate (${String(SCAN_FILE)})`, () => {
  const src = readFileSync(SCAN_FILE, "utf8");
  assert.ok(src.length > 0, "scanned file is empty");
  assert.deepEqual(violations(src), []);
});
