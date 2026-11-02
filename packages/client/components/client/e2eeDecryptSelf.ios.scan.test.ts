// Source-scan spec for the decrypt self id on iOS: the Swift twin of the
// K1/K2 rules in e2eeDecryptSelf.scan.test.ts (plan own-message-routing-fix
// section 3.2; iOS port plan G10). Run with Node's built-in runner:
//   node --conditions=browser --test components/client/e2eeDecryptSelf.ios.scan.test.ts
// Native decides whether a message is our own from the store's owner of
// record, and learns that owner from the `selfUserId` the webview passes
// beside the envelope. The envelope is built from the server's
// `E2EEMessage` event, so a self id inside it would be server-controlled.
// The e2ee.ts side (S1-S5) is pinned by the original spec and is not
// repeated here; this file reads the iOS plugin where that one reads
// E2eePlugin.kt. Swift does not load under Node, so the wiring is pinned by
// reading the sources. Point `E2EE_DECRYPT_SELF_SWIFT` (E2eePlugin.swift)
// and `E2EE_DECRYPT_SELF_SWIFT_COMMANDS` (E2eeCommands.swift) at other
// copies to scan those instead (the known-bad control: a copy whose decrypt
// arm reads the self id out of the envelope, or drops it); they must fail.
//
// The Swift lexer blanks `//` and nested `/* */` comments, and the contents
// of string literals (`"..."`, multi-line `"""`, raw `#"..."#` at any `#`
// depth), keeping `\(...)` interpolations as code. Comments are stripped
// before every check, and string contents only count where a literal is the
// subject of the rule, so a commented-out argument never satisfies a rule.
// Regex literals are not lexed; neither file has one.
//
// E2eePlugin.swift:
//   I1. `e2ee_decrypt` appears exactly once outside comments, as the label
//       `case "e2ee_decrypt":` (alone, first on its line) of the switch that
//       sits directly in the body of `runGeneric`, which is defined once:
//       one arm, no command held in a variable, no second arm.
//   I2. That arm, up to the next `case` / `default` label at its depth,
//       calls `engine.decrypt(` exactly once, with exactly two arguments:
//       `envelopeJson: <an expression naming no self id>` and
//       `selfUserId: args.optionalString("selfUserId")`. No self id
//       (`selfUserId`, `self_user_id`, any case) is named anywhere else in
//       the arm. `args` is the call's own arguments: `runGeneric` declares
//       `args: E2eeCallArgs`, never rebinds it, and every call of
//       `runGeneric` passes `E2eeCallArgs(call)`.
// E2eeCommands.swift:
//   I3. `e2ee_decrypt` appears exactly once outside comments, on a line that
//       reads `("e2ee_decrypt", .generic),` inside `static let table`: the
//       command runs on the engine worker, never on a dialog thread.
//
// The lexer is checked against small inputs and the scanners against inline
// fixtures first (a conforming file passes; each mutation fails exactly its
// own rule), so a green scan is never a scanner that cannot fail.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SWIFT_DIR = "../../ios/App/SlogaE2ee/Sources/SlogaE2ee/";
const PLUGIN_FILE =
  process.env.E2EE_DECRYPT_SELF_SWIFT ||
  new URL(`${SWIFT_DIR}E2eePlugin.swift`, import.meta.url);
const COMMANDS_FILE =
  process.env.E2EE_DECRYPT_SELF_SWIFT_COMMANDS ||
  new URL(`${SWIFT_DIR}E2eeCommands.swift`, import.meta.url);

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
 * `[start, end)` of each top-level comma-separated item between the bracket
 * at `open` and its match (brackets matched on `m.code`); blank items are
 * dropped.
 */
function itemRanges(m: Masked, open: number): [number, number][] {
  const close = matchClose(m.code, open);
  const out: [number, number][] = [];
  let start = open + 1;
  for (let i = open + 1; i < close; i++) {
    const c = m.code[i];
    if (c === "(" || c === "[" || c === "{") i = matchClose(m.code, i);
    else if (c === ",") {
      out.push([start, i]);
      start = i + 1;
    }
  }
  out.push([start, close]);
  return out.filter(([s, e]) => squash(m.text.slice(s, e)) !== "");
}

/** The items at `open`, sliced from `m.text` (string contents kept), squashed. */
function items(m: Masked, open: number): string[] {
  return itemRanges(m, open).map(([s, e]) => squash(m.text.slice(s, e)));
}

function skipWs(code: string, i: number): number {
  while (i < code.length && /\s/.test(code[i])) i++;
  return i;
}

/** The `{` of the innermost block holding `at` (masked code), or -1. */
function enclosingBrace(code: string, at: number): number {
  const stack: number[] = [];
  for (let i = 0; i < at; i++) {
    if (code[i] === "{") stack.push(i);
    else if (code[i] === "}") stack.pop();
  }
  return stack.length > 0 ? stack[stack.length - 1] : -1;
}

// ---- Swift lexer ------------------------------------------------------------

/** A raw string opener: one or more `#` then `"`. */
const RAW_OPEN = /#+"/y;

/**
 * Blanks Swift comments (block comments nest) and string contents with
 * spaces (newlines kept), so every index is the same index in `src`. Raw
 * strings close on `"` plus their own `#`s and escape with `\` plus them;
 * `\(...)` (`\#(...)` in a raw string) interpolations are scanned as code.
 */
function maskSwift(src: string): Masked {
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

  /** Scans a string literal opening at `i`; returns the index just past it. */
  const scanString = (i: number): number => {
    let hashes = 0;
    while (src[i + hashes] === "#") hashes++;
    const pounds = "#".repeat(hashes);
    const multi = src.startsWith('"""', i + hashes);
    const closer = (multi ? '"""' : '"') + pounds;
    const escape = "\\" + pounds;
    let j = i + hashes + (multi ? 3 : 1);
    while (j < n) {
      if (src.startsWith(closer, j)) return j + closer.length;
      if (!multi && src[j] === "\n") return j;
      if (src.startsWith(escape, j)) {
        const after = j + escape.length;
        while (j < after) blank(code, j++);
        if (src[after] === "(") j = scanCode(after + 1, true) + 1;
        else if (j < n) blank(code, j++);
        continue;
      }
      blank(code, j++);
    }
    return n;
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
      RAW_OPEN.lastIndex = i;
      if (c === '"' || (c === "#" && RAW_OPEN.test(src))) {
        i = scanString(i);
        continue;
      }
      if (c === "(") depth++;
      if (c === ")") {
        if (untilParen && depth === 0) return i;
        depth--;
      }
      i++;
    }
    return n;
  };

  scanCode(0, false);
  return { code: code.join(""), text: text.join("") };
}

// ---- E2eePlugin.swift rules -------------------------------------------------

const COMMAND = "e2ee_decrypt";
const COMMAND_WORD = /\be2ee_decrypt\b/g;
const SELF_ID = /self_?user_?id/gi;
const DECRYPT_CALL = /\bengine\s*(?:\(\s*\))?\s*[?!]?\s*\.\s*decrypt\s*\(/g;
const SELF_ARG = 'selfUserId:args.optionalString("selfUserId")';
const RUN_GENERIC_DEF = /\bfunc\s+runGeneric\s*(?:<[^()]*>)?\s*\(/g;
const RUN_GENERIC_CALL = /(?<!\bfunc\s+)\brunGeneric\s*\(/g;
const ARGS_PARAM = /(?:^|,)\s*(?:\w+\s+)?args\s*:\s*E2eeCallArgs\s*(?:,|$)/;
/** A new binding of, or an assignment to, `args`. */
const ARGS_REBOUND = [
  /\b(?:let|var)\s+[^=\n;{}]*\bargs\b/g,
  /(?<![.\w])args\s*=(?!=)/g,
  /\bfor\s+args\b/g,
  /\bargs\s+in\b/g,
];

/** End (exclusive) of the switch arm whose label's `:` is at `colon`. */
function armEnd(code: string, colon: number): number {
  const label = /\n[ \t]*(?:case\b|(?:@unknown[ \t]+)?default[ \t]*:)/y;
  for (let i = colon + 1; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") i = matchClose(code, i);
    else if (c === "}" || c === ")" || c === "]") return i;
    else {
      label.lastIndex = i;
      if (label.test(code)) return i;
    }
  }
  return code.length;
}

function pluginViolations(src: string): string[] {
  const m = maskSwift(src);
  const out: string[] = [];

  // runGeneric, defined once: its parameters and body.
  const defs = [...m.code.matchAll(RUN_GENERIC_DEF)];
  if (defs.length !== 1) {
    out.push(`I1 runGeneric is defined ${defs.length} times, want 1`);
  }
  let params = "";
  let body: [number, number] | null = null;
  if (defs.length === 1) {
    const open = defs[0].index! + defs[0][0].length - 1;
    const close = matchClose(m.code, open);
    params = m.text.slice(open + 1, close).replace(/\s+/g, " ");
    const bodyOpen = m.code.indexOf("{", close);
    if (bodyOpen >= 0) body = [bodyOpen, matchClose(m.code, bodyOpen)];
  }

  // I1: the one `case "e2ee_decrypt":` label, in runGeneric's switch.
  const hits = [...m.text.matchAll(COMMAND_WORD)];
  if (hits.length !== 1) {
    out.push(
      `I1 ${COMMAND} appears ${hits.length} times outside comments` +
        ` (lines ${hits.map((h) => lineOf(src, h.index!)).join(", ")})`,
    );
  }
  if (hits.length === 0) return out;
  const at = hits[0].index!;
  const line = lineOf(src, at);
  const quoted = m.text[at - 1] === '"' && m.text[at + COMMAND.length] === '"';
  const colon = quoted ? skipWs(m.code, at + COMMAND.length + 1) : -1;
  const before = m.code.slice(m.code.lastIndexOf("\n", at - 1) + 1, at - 1);
  if (!quoted || !/^[ \t]*case[ \t]*$/.test(before) || m.code[colon] !== ":") {
    out.push(
      `I1 line ${line}: ${COMMAND} is not a lone \`case "${COMMAND}":\` label`,
    );
    return out;
  }
  const brace = enclosingBrace(m.code, at);
  const braceLine = m.code.lastIndexOf("\n", brace - 1) + 1;
  const head = /^\s*switch\b/.exec(m.code.slice(braceLine, brace));
  const switchAt = head ? braceLine + head[0].length - 1 : -1;
  if (
    brace < 0 ||
    !head ||
    !body ||
    enclosingBrace(m.code, switchAt) !== body[0]
  ) {
    out.push(
      `I1 line ${line}: the ${COMMAND} arm is not in the switch of` +
        " runGeneric's body",
    );
    return out;
  }

  // I2: the arm's one engine.decrypt(envelopeJson:, selfUserId:).
  const end = armEnd(m.code, colon);
  const calls = [...m.code.slice(colon + 1, end).matchAll(DECRYPT_CALL)];
  if (calls.length !== 1) {
    out.push(
      `I2 line ${line}: the arm calls engine.decrypt( ${calls.length} times`,
    );
  } else {
    const paren = colon + 1 + calls[0].index! + calls[0][0].length - 1;
    const ranges = itemRanges(m, paren);
    const args = ranges.map(([s, e]) => squash(m.text.slice(s, e)));
    if (args.length !== 2) {
      out.push(
        `I2 line ${line}: engine.decrypt has ${args.length} arguments,` +
          ` want 2: ${JSON.stringify(args)}`,
      );
    } else {
      if (!args[0].startsWith("envelopeJson:")) {
        out.push(
          `I2 line ${line}: first argument is \`${args[0]}\`, not` +
            " envelopeJson:",
        );
      } else if (new RegExp(SELF_ID.source, "i").test(args[0])) {
        out.push(`I2 line ${line}: the envelopeJson argument names a self id`);
      }
      if (args[1] !== SELF_ARG) {
        out.push(
          `I2 line ${line}: second argument is \`${args[1]}\`, not ${SELF_ARG}`,
        );
      }
      // Nothing else in the arm names a self id.
      const [selfStart, selfEnd] = ranges[1];
      for (const hit of m.text.slice(colon + 1, end).matchAll(SELF_ID)) {
        const pos = colon + 1 + hit.index!;
        if (pos < selfStart || pos >= selfEnd) {
          out.push(
            `I2 line ${lineOf(src, pos)}: \`${hit[0]}\` named outside the` +
              " selfUserId argument",
          );
        }
      }
    }
  }

  // I2: `args` is the call's own arguments.
  if (!ARGS_PARAM.test(params)) {
    out.push(
      `I2 runGeneric's parameters (\`${squash(params)}\`) declare no` +
        " `args: E2eeCallArgs`",
    );
  }
  for (const re of ARGS_REBOUND) {
    for (const hit of m.code.slice(body[0], body[1]).matchAll(re)) {
      out.push(
        `I2 line ${lineOf(src, body[0] + hit.index!)}: \`args\` is rebound` +
          " inside runGeneric",
      );
    }
  }
  const sites = [...m.code.matchAll(RUN_GENERIC_CALL)];
  if (sites.length === 0) out.push("I2 runGeneric is never called");
  for (const site of sites) {
    const given = items(m, site.index! + site[0].length - 1);
    if (given.length !== 2 || given[1] !== "E2eeCallArgs(call)") {
      out.push(
        `I2 line ${lineOf(src, site.index!)}: runGeneric is called with` +
          ` ${JSON.stringify(given)}, not (name, E2eeCallArgs(call))`,
      );
    }
  }
  return out;
}

// ---- E2eeCommands.swift rules -----------------------------------------------

const TABLE = /\bstatic\s+let\s+table\b[^=]*=\s*\[/g;
const TABLE_ENTRY = '("e2ee_decrypt",.generic),';

function commandsViolations(src: string): string[] {
  const m = maskSwift(src);
  const out: string[] = [];

  // I3: one entry, `("e2ee_decrypt", .generic),`, inside the table.
  const hits = [...m.text.matchAll(COMMAND_WORD)];
  if (hits.length !== 1) {
    out.push(
      `I3 ${COMMAND} appears ${hits.length} times outside comments` +
        ` (lines ${hits.map((h) => lineOf(src, h.index!)).join(", ")})`,
    );
  }
  if (hits.length === 0) return out;
  const at = hits[0].index!;
  const line = lineOf(src, at);
  const stop = m.text.indexOf("\n", at);
  const entry = squash(
    m.text.slice(
      m.text.lastIndexOf("\n", at) + 1,
      stop < 0 ? m.text.length : stop,
    ),
  );
  if (entry !== TABLE_ENTRY) {
    out.push(
      `I3 line ${line}: the entry reads \`${entry}\`, not` +
        ' ("e2ee_decrypt", .generic),',
    );
  }
  const tables = [...m.code.matchAll(TABLE)];
  if (tables.length !== 1) {
    out.push(`I3 static let table is defined ${tables.length} times, want 1`);
  } else {
    const open = tables[0].index! + tables[0][0].length - 1;
    if (at < open || at > matchClose(m.code, open)) {
      out.push(`I3 line ${line}: the entry is not inside E2eeCommands.table`);
    }
  }
  return out;
}

// ---- The lexer itself -------------------------------------------------------

/** `[label, source, squashed masked code]`. */
const LEXER_CASES: [string, string, string][] = [
  ["a nested block comment", "a /* x /* y */ z */ b", "ab"],
  ["a line comment", 'a // "e2ee_decrypt" {\nb', "ab"],
  ["an escaped quote", 'f("x\\")y") + g', 'f("")+g'],
  ["a raw string", 'f(#"x"y)"#)', 'f(#""#)'],
  ["a raw string with two #", 'f(##"a"#b)"##)', 'f(##""##)'],
  ["a multi-line string", 'f("""\n  a ) " b\n  """)', 'f("""""")'],
  ["an interpolation stays code", '"a\\(g("b)"))c"', '"(g(""))"'],
  ["a raw string's interpolation", '#"a\\#(x)b\\(y)"#', '#"(x)"#'],
];

for (const [label, src, want] of LEXER_CASES) {
  test(`lexer: ${label}`, () => {
    const m = maskSwift(src);
    assert.equal(m.code.length, src.length);
    assert.equal(m.text.length, src.length);
    for (let i = 0; i < src.length; i++) {
      assert.equal(m.code[i] === "\n", src[i] === "\n", `newline at ${i}`);
    }
    assert.equal(squash(m.code), want);
  });
}

test("lexer: text keeps string contents and drops comments", () => {
  const m = maskSwift('a /* c "d" */ "s ( {" // e\n#"r"#');
  assert.equal(squash(m.text), 'a"s({"#"r"#');
  assert.equal(squash(m.code), 'a""#""#');
});

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

/** The decrypt arm, as in the conforming E2eePlugin.swift. */
const DECRYPT_ARM = `        case "e2ee_decrypt":
            // The self id is its own argument, never read from the
            // server-built envelope. Absent (an older frontend) is nil.
            return try engine.decrypt(
                envelopeJson: args.objectJSON("envelope"),
                selfUserId: args.optionalString("selfUserId")
            )
`;

/** A conforming plugin: the `call` mux and the generic switch. */
const SWIFT_FIXTURE = `
// "e2ee_decrypt" in a line comment does not count
/* Nor in a block comment /* that nests */ case "e2ee_decrypt": */
@objc(E2eePlugin)
public final class E2eePlugin: CAPPlugin, CAPBridgedPlugin {
    @objc func call(_ call: CAPPluginCall) {
        guard let name = Self.validated(call, { try E2eeCallArgs(call).string("__cmd") }) else {
            return
        }
        switch E2eeCommands.route(for: name) {
        case .generic:
            E2eeRuntime.shared.engineWorker.submit {
                Self.settle(call) {
                    .json(try Self.runGeneric(name, E2eeCallArgs(call)))
                }
            }
        default:
            call.reject(E2eeReject.invalidArgument("name").json)
        }
    }
}

private extension E2eePlugin {
    static func runGeneric(_ name: String, _ args: E2eeCallArgs) throws -> String {
        let engine = try E2eeRuntime.shared.engine()
        switch name {
        case "e2ee_encrypt":
            return try engine.encrypt(
                peerUserId: args.string("peerUserId"),
                selfUserId: args.string("selfUserId"),
                content: args.string("content")
            )
${DECRYPT_ARM}        case "e2ee_history":
            let note = """
                text { ( here
                """
            let raw = #"a raw "string" ) } stays text"#
            return try engine.history(peerUserId: args.string("peerUserId"), note: note + raw)
        default:
            throw E2eeReject.invalidArgument("name")
        }
    }
}
`;

/** A conforming command table. */
const COMMANDS_FIXTURE = `
enum E2eeCommands {
    // ("e2ee_decrypt", .dedicated("decrypt")), in a comment does not count
    static let table: [(name: String, route: E2eeRoute)] = [
        ("e2ee_encrypt", .generic),
        ("e2ee_decrypt", .generic),
        ("e2ee_history", .generic),
        ("e2ee_wipe", .dedicated("wipe")),
    ]

    static let dedicatedMethods: [String] = [
        "wipe",
    ]
}
`;

const BEFORE_CALL = "            return try engine.decrypt(\n";
const ENVELOPE_LINE =
  '                envelopeJson: args.objectJSON("envelope"),\n';
const SELF_LINE =
  '                selfUserId: args.optionalString("selfUserId")\n';

test("fixture: the conforming plugin passes", () => {
  assert.deepEqual(pluginViolations(SWIFT_FIXTURE), []);
});

test("fixture: comment and string decoys inside the arm pass", () => {
  const decoyed = swapped(SWIFT_FIXTURE, [
    [
      BEFORE_CALL,
      "            /* engine.decrypt( /* nested */ selfUserId */\n" +
        '            let note = """\n' +
        "                engine.decrypt( { (\n" +
        '                """\n' +
        '            let raw = #"a raw "engine.decrypt(" ) } stays text"#\n' +
        BEFORE_CALL,
    ],
  ]);
  assert.deepEqual(pluginViolations(decoyed), []);
});

test("fixture: the conforming command table passes", () => {
  assert.deepEqual(commandsViolations(COMMANDS_FIXTURE), []);
});

const SWIFT_MUTATIONS: {
  label: string;
  swaps: [string, string][];
  rules: string[];
  expected: RegExp;
}[] = [
  {
    label: "the one-argument decrypt (the 03ab5d03 shape)",
    swaps: [
      [
        ENVELOPE_LINE + SELF_LINE,
        '                envelopeJson: args.objectJSON("envelope")\n',
      ],
    ],
    rules: ["I2"],
    expected: /1 arguments, want 2/,
  },
  {
    label: "the self id only in a comment",
    swaps: [[SELF_LINE, `                //${SELF_LINE.trimStart()}`]],
    rules: ["I2"],
    expected: /1 arguments, want 2/,
  },
  {
    label: "the self id read out of the envelope",
    swaps: [
      [
        'selfUserId: args.optionalString("selfUserId")',
        'selfUserId: Self.recipient(args.objectJSON("envelope"))',
      ],
    ],
    rules: ["I2"],
    expected: /second argument is .* not selfUserId:args\.optionalString/,
  },
  {
    label: "the self id read from an envelope field",
    swaps: [
      [
        'selfUserId: args.optionalString("selfUserId")',
        'selfUserId: args.envelopeString("envelope", "self_user_id")',
      ],
    ],
    rules: ["I2"],
    expected: /second argument is/,
  },
  {
    label: "the wrong key",
    swaps: [
      [
        'args.optionalString("selfUserId")',
        'args.optionalString("self_user_id")',
      ],
    ],
    rules: ["I2"],
    expected: /second argument is/,
  },
  {
    label: "the Android getter instead of the strict reader",
    swaps: [
      ['args.optionalString("selfUserId")', 'call.getString("selfUserId")'],
    ],
    rules: ["I2"],
    expected: /second argument is/,
  },
  {
    label: "a required self id (an older frontend rejected)",
    swaps: [['args.optionalString("selfUserId")', 'args.string("selfUserId")']],
    rules: ["I2"],
    expected: /second argument is/,
  },
  {
    label: "a mistyped self id swallowed to nil",
    swaps: [
      [
        'selfUserId: args.optionalString("selfUserId")',
        'selfUserId: try? args.optionalString("selfUserId")',
      ],
    ],
    rules: ["I2"],
    expected: /second argument is/,
  },
  {
    label: "the envelope argument names a self id",
    swaps: [
      [
        'envelopeJson: args.objectJSON("envelope"),',
        'envelopeJson: args.objectJSON("envelope", adding: "selfUserId"),',
      ],
    ],
    rules: ["I2"],
    expected: /the envelopeJson argument names a self id/,
  },
  {
    label: "the arguments swapped",
    swaps: [
      [
        ENVELOPE_LINE + SELF_LINE,
        '                selfUserId: args.optionalString("selfUserId"),\n' +
          '                envelopeJson: args.objectJSON("envelope")\n',
      ],
    ],
    rules: ["I2"],
    expected: /first argument is .*, not envelopeJson:/,
  },
  {
    label: "an unlabeled envelope",
    swaps: [
      [
        'envelopeJson: args.objectJSON("envelope"),',
        'args.objectJSON("envelope"),',
      ],
    ],
    rules: ["I2"],
    expected: /first argument is/,
  },
  {
    label: "a third argument rides along",
    swaps: [
      [
        SELF_LINE,
        '                selfUserId: args.optionalString("selfUserId"),\n' +
          '                hint: args.optionalString("owner")\n',
      ],
    ],
    rules: ["I2"],
    expected: /3 arguments, want 2/,
  },
  {
    label: "the arm no longer calls engine.decrypt",
    swaps: [["try engine.decrypt(", "try engine.decryptLegacy("]],
    rules: ["I2"],
    expected: /calls engine\.decrypt\( 0 times/,
  },
  {
    label: "a second decrypt hidden in an interpolation",
    swaps: [
      [
        BEFORE_CALL,
        '            _ = "\\(try engine.decrypt(envelopeJson: "{}", hint: nil))"\n' +
          BEFORE_CALL,
      ],
    ],
    rules: ["I2"],
    expected: /calls engine\.decrypt\( 2 times/,
  },
  {
    label: "a self id read elsewhere in the arm",
    swaps: [
      [
        BEFORE_CALL,
        '            _ = try args.optionalString("selfUserId")\n' + BEFORE_CALL,
      ],
    ],
    rules: ["I2"],
    expected: /named outside the selfUserId argument/,
  },
  {
    label: "args rebound in the arm",
    swaps: [
      [
        BEFORE_CALL,
        "            let args = E2eeCallArgs(envelopeCall)\n" + BEFORE_CALL,
      ],
    ],
    rules: ["I2"],
    expected: /`args` is rebound inside runGeneric/,
  },
  {
    label: "runGeneric fed something other than the call's arguments",
    swaps: [
      [
        "Self.runGeneric(name, E2eeCallArgs(call))",
        "Self.runGeneric(name, E2eeCallArgs(envelopeCall))",
      ],
    ],
    rules: ["I2"],
    expected: /not \(name, E2eeCallArgs\(call\)\)/,
  },
  {
    label: "runGeneric's args are not E2eeCallArgs",
    swaps: [["_ args: E2eeCallArgs)", "_ args: EnvelopeArgs)"]],
    rules: ["I2"],
    expected: /declare no `args: E2eeCallArgs`/,
  },
  {
    label: "a second decrypt arm",
    swaps: [
      [
        "        default:\n            throw",
        '        case "e2ee_decrypt":\n            return "null"\n' +
          "        default:\n            throw",
      ],
    ],
    rules: ["I1"],
    expected: /appears 2 times/,
  },
  {
    label: "the command held in a variable",
    swaps: [
      ['        case "e2ee_decrypt":\n', "        case decryptCommand:\n"],
      [
        "        let engine = try",
        '        let decryptCommand = "e2ee_decrypt"\n        let engine = try',
      ],
    ],
    rules: ["I1"],
    expected: /not a lone `case "e2ee_decrypt":` label/,
  },
  {
    label: "a combined label",
    swaps: [
      [
        '        case "e2ee_decrypt":\n',
        '        case "e2ee_decrypt", "e2ee_decrypt_v2":\n',
      ],
    ],
    rules: ["I1"],
    expected: /not a lone/,
  },
  {
    label: "the arm only inside a nested block comment",
    swaps: [
      [
        DECRYPT_ARM,
        `        /* gone /* for now */\n${DECRYPT_ARM}        */\n`,
      ],
    ],
    rules: ["I1"],
    expected: /appears 0 times/,
  },
  {
    label: "the arm in the dispatcher instead of runGeneric",
    swaps: [
      [DECRYPT_ARM, ""],
      [
        "        default:\n            call.reject",
        `${DECRYPT_ARM}        default:\n            call.reject`,
      ],
    ],
    rules: ["I1"],
    expected: /not in the switch of runGeneric's body/,
  },
];

for (const { label, swaps, rules, expected } of SWIFT_MUTATIONS) {
  test(`fixture mutation (E2eePlugin.swift): ${label}`, () => {
    assertOnly(
      label,
      pluginViolations(swapped(SWIFT_FIXTURE, swaps)),
      rules,
      expected,
    );
  });
}

const DECRYPT_ENTRY = '        ("e2ee_decrypt", .generic),\n';

const COMMANDS_MUTATIONS: typeof SWIFT_MUTATIONS = [
  {
    label: "decrypt on a dedicated thread",
    swaps: [
      [
        '("e2ee_decrypt", .generic),',
        '("e2ee_decrypt", .dedicated("decrypt")),',
      ],
    ],
    rules: ["I3"],
    expected: /the entry reads/,
  },
  {
    label: "decrypt routed native",
    swaps: [['("e2ee_decrypt", .generic),', '("e2ee_decrypt", .native),']],
    rules: ["I3"],
    expected: /the entry reads/,
  },
  {
    label: "decrypt routed out",
    swaps: [['("e2ee_decrypt", .generic),', '("e2ee_decrypt", .out),']],
    rules: ["I3"],
    expected: /the entry reads/,
  },
  {
    label: "generic only in a trailing comment",
    swaps: [
      [
        '("e2ee_decrypt", .generic),',
        '("e2ee_decrypt", .out), // ("e2ee_decrypt", .generic),',
      ],
    ],
    rules: ["I3"],
    expected: /the entry reads/,
  },
  {
    label: "dropped from the table",
    swaps: [[DECRYPT_ENTRY, ""]],
    rules: ["I3"],
    expected: /appears 0 times/,
  },
  {
    label: "a second entry later in the table",
    swaps: [
      [
        '        ("e2ee_wipe", .dedicated("wipe")),\n',
        '        ("e2ee_wipe", .dedicated("wipe")),\n' +
          '        ("e2ee_decrypt", .dedicated("decrypt")),\n',
      ],
    ],
    rules: ["I3"],
    expected: /appears 2 times/,
  },
  {
    label: "listed outside the table",
    swaps: [
      [DECRYPT_ENTRY, ""],
      ['        "wipe",\n', `        "wipe",\n${DECRYPT_ENTRY}`],
    ],
    rules: ["I3"],
    expected: /not inside E2eeCommands\.table/,
  },
];

for (const { label, swaps, rules, expected } of COMMANDS_MUTATIONS) {
  test(`fixture mutation (E2eeCommands.swift): ${label}`, () => {
    assertOnly(
      label,
      commandsViolations(swapped(COMMANDS_FIXTURE, swaps)),
      rules,
      expected,
    );
  });
}

// ---- The real sources -------------------------------------------------------

test("E2eePlugin.swift: the decrypt arm forwards selfUserId beside the envelope, never from it", () => {
  assert.deepEqual(pluginViolations(readFileSync(PLUGIN_FILE, "utf8")), []);
});

test("E2eeCommands.swift: e2ee_decrypt is a generic command on the engine worker", () => {
  assert.deepEqual(commandsViolations(readFileSync(COMMANDS_FILE, "utf8")), []);
});
