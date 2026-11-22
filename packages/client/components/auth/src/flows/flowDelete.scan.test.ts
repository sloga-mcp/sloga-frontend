// Source-scan spec for the account deletion confirm page (account-deletion
// plan F-c), run with Node's built-in runner from packages/client:
//   node --conditions=browser --test components/auth/src/flows/flowDelete.scan.test.ts
//
// FlowDelete.tsx imports Solid, lingui and the UI kit, so Node cannot load
// it. The rules are pinned by reading its source:
//
//  D1  nothing runs on load: no `onMount`, and no `createEffect`,
//      `createRenderEffect`, `createComputed` or `createResource` either
//      (an email link scanner that runs JS must not be able to delete);
//  D2  every `api.put(` sits inside an event handler: either inline in an
//      `onPress={…}` / `onClick={…}` / `onSubmit={…}` attribute, or in a
//      named function whose name is used ONLY as such an attribute value
//      (never called directly, never handed to a timer or effect);
//  D3  the PUT body carries `confirm: true`.
//
// A failed PUT is mapped to the right outcome (account-deletion wave 2, F3b):
//
//  E1  `deleteFailure(error)` is lifted out of the source (it must stay
//      self-contained), its types stripped, and run against what stoat-api
//      and fetch actually throw: the error body as text, or a TypeError.
//      InvalidOperation (400, owned servers) is "owns-servers"; no answer,
//      429 `{ retry_after }`, a 5xx type or a non-JSON (gateway) body is
//      "retry"; InvalidToken and anything else is "invalid";
//  E2  the PUT handler's catch hands its error to `deleteFailure`, stores
//      the result with `setFailure`, and makes one `setState` call, which
//      moves to "error" only for "invalid" and back to "idle" otherwise;
//  E3  the owned-servers and retry copy each sit in a Match on
//      `failure() === kind`, inside the idle/pending Match that also holds
//      the button, and the terminal copy sits in the `state() === "error"`
//      Match;
//  E4  the handler still opens with the double-press guard
//      `if (state() !== "idle") return;`.
//
// The scanner is checked against inline fixtures first, so a green scan is
// never a scanner that cannot fail. Point `FLOW_DELETE_FILE` at another copy
// (the known-bad control: the 68653961 FlowDelete.tsx) to scan that instead;
// it must fail.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { describe, it } from "node:test";

const SCAN_FILE =
  process.env.FLOW_DELETE_FILE || new URL("./FlowDelete.tsx", import.meta.url);

/**
 * Blank out comments and double-quoted / template string contents (keeping
 * offsets), so braces and words inside them do not confuse the scan.
 * Single quotes are left alone: JSX text uses apostrophes freely and the
 * house style quotes strings with double quotes. With `keepStrings`, only
 * comments are blanked (for rules that read string values).
 */
function mask(src: string, keepStrings = false): string {
  const out = src.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      if (!keepStrings) blank(i + 1, j);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

/**
 * Index of the bracket matching the one at `open`, or -1
 */
function matching(src: string, open: number): number {
  const pairs: Record<string, string> = { "{": "}", "(": ")" };
  const close = pairs[src[open]];
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === src[open]) depth++;
    else if (src[k] === close && --depth === 0) return k;
  }
  return -1;
}

interface Body {
  name: string;
  start: number;
  end: number;
}

/**
 * Bodies of named functions: `function name(…) {…}` and
 * `const name = (async) (…) => {…}`
 */
function namedBodies(src: string): Body[] {
  const bodies: Body[] = [];
  const decl = /\bfunction\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g;
  const arrow = /\bconst\s+(\w+)\s*=\s*(?:async\s*)?\(/g;
  for (const re of [decl, arrow]) {
    for (const m of src.matchAll(re)) {
      const paren = m.index + m[0].length - 1;
      const parenEnd = matching(src, paren);
      if (parenEnd === -1) continue;
      const rest = src.slice(parenEnd + 1);
      const head =
        re === arrow ? /^\s*(?::[^=]*)?=>\s*\{/ : /^\s*(?::[^{]*)?\{/;
      const hm = rest.match(head);
      if (!hm) continue;
      const open = parenEnd + 1 + hm[0].length - 1;
      const end = matching(src, open);
      if (end !== -1) bodies.push({ name: m[1], start: open, end });
    }
  }
  return bodies;
}

/**
 * Ranges of inline `onPress={…}` / `onClick={…}` / `onSubmit={…}` values
 */
function handlerAttrs(src: string): { start: number; end: number }[] {
  const ranges = [];
  for (const m of src.matchAll(/\bon(?:Press|Click|Submit)\s*=\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    const end = matching(src, open);
    if (end !== -1) ranges.push({ start: open, end });
  }
  return ranges;
}

/**
 * Every rule violation in `raw` (empty means conforming)
 */
function scan(raw: string): string[] {
  const src = mask(raw);
  const problems: string[] = [];

  for (const word of [
    "onMount",
    "createEffect",
    "createRenderEffect",
    "createComputed",
    "createResource",
  ]) {
    if (new RegExp(`\\b${word}\\b`).test(src)) {
      problems.push(`D1: uses ${word}, which runs on load`);
    }
  }

  const puts = [...src.matchAll(/\bapi\s*\.\s*put\s*\(/g)];
  if (puts.length === 0) problems.push("D2: no api.put( call found");

  const bodies = namedBodies(src);
  const attrs = handlerAttrs(src);
  for (const put of puts) {
    const at = put.index;
    if (attrs.some((r) => r.start < at && at < r.end)) continue;

    const enclosing = bodies
      .filter((b) => b.start < at && at < b.end)
      .sort((a, b) => b.start - a.start)[0];
    if (!enclosing) {
      problems.push(`D2: api.put at ${at} is not inside any named function`);
      continue;
    }

    const name = enclosing.name;
    const uses = [...src.matchAll(new RegExp(`\\b${name}\\b`, "g"))];
    const asHandler = new RegExp(
      `\\bon(?:Press|Click|Submit)\\s*=\\s*\\{\\s*${name}\\s*\\}`,
      "g",
    );
    const handlerUses = [...src.matchAll(asHandler)].length;
    const definitions = bodies.filter((b) => b.name === name).length;
    if (handlerUses === 0) {
      problems.push(
        `D2: api.put sits in ${name}, which is not an event handler`,
      );
    } else if (uses.length !== handlerUses + definitions) {
      problems.push(
        `D2: ${name} holds api.put but is also used outside an event handler`,
      );
    }

    const call = src.slice(at, matching(src, at + put[0].length - 1) + 1);
    if (!/\bconfirm\s*:\s*true\b/.test(call)) {
      problems.push("D3: the api.put body has no `confirm: true`");
    }
  }

  return problems;
}

/**
 * Lift the self-contained function `name` out of `raw`, strip its types and
 * return it as a callable. Throws if it is missing.
 */
function lift(raw: string, name: string): (error: unknown) => unknown {
  const src = mask(raw);
  const decl = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(src);
  const body = namedBodies(src).find((b) => b.name === name);
  if (!decl || !body) throw new Error(`E1: no function ${name} found`);
  const code = stripTypeScriptTypes(raw.slice(decl.index, body.end + 1));
  return new Function(`"use strict";\n${code}\nreturn ${name};`)();
}

/**
 * What stoat-api / fetch throw for each response, and the outcome it must
 * map to. stoat-api 0.13.5 throws the error body as text; the parsed-object
 * rows cover a client that hands the body over already parsed.
 */
const CLASSIFY_CASES: [label: string, thrown: unknown, want: string][] = [
  ["400 InvalidOperation", '{"type":"InvalidOperation"}', "owns-servers"],
  ["InvalidOperation, parsed", { type: "InvalidOperation" }, "owns-servers"],
  ["network failure", new TypeError("Failed to fetch"), "retry"],
  ["nothing thrown", undefined, "retry"],
  ["429 from the rate limiter", '{"retry_after":4200}', "retry"],
  ["500 InternalError", '{"type":"InternalError"}', "retry"],
  [
    "500 DatabaseError",
    '{"type":"DatabaseError","operation":"find_one","collection":"accounts"}',
    "retry",
  ],
  ["500 OperationFailed", '{"type":"OperationFailed"}', "retry"],
  ["500 LabelMe", '{"type":"LabelMe"}', "retry"],
  ["empty gateway body", "", "retry"],
  ["HTML gateway page", "<html><body>502 Bad Gateway</body></html>", "retry"],
  ["401 InvalidToken", '{"type":"InvalidToken"}', "invalid"],
  ["InvalidToken, parsed", { type: "InvalidToken" }, "invalid"],
  [
    "400 FailedValidation",
    '{"type":"FailedValidation","error":"x"}',
    "invalid",
  ],
  ["404 NotFound", '{"type":"NotFound"}', "invalid"],
  ["JSON with no type", "{}", "invalid"],
];

/**
 * Labels of the CLASSIFY_CASES rows `classify` gets wrong
 */
function misclassified(classify: (error: unknown) => unknown): string[] {
  return CLASSIFY_CASES.filter(([, thrown, want]) => {
    try {
      return classify(thrown) !== want;
    } catch {
      return true;
    }
  }).map(([label]) => label);
}

/**
 * E2 and E4 violations in `raw` (empty means conforming)
 */
function failureWiring(raw: string): string[] {
  const src = mask(raw);
  const code = mask(raw, true);
  const problems: string[] = [];

  const put = /\bapi\s*\.\s*put\s*\(/.exec(src);
  if (!put) return ["E2: no api.put( call found"];
  const handler = namedBodies(src)
    .filter((b) => b.start < put.index && put.index < b.end)
    .sort((a, b) => b.start - a.start)[0];
  if (!handler) return ["E2: api.put is not inside a named function"];
  const body = code.slice(handler.start, handler.end + 1);

  if (
    !/^\{\s*if\s*\(\s*state\(\)\s*!==\s*"idle"\s*\)\s*return\s*;/.test(body)
  ) {
    problems.push("E4: the handler does not open with the double-press guard");
  }

  const catches = [...body.matchAll(/\bcatch\s*(?:\(\s*(\w+)\s*\))?\s*\{/g)];
  if (catches.length !== 1) {
    problems.push(`E2: expected one catch in ${handler.name}`);
    return problems;
  }
  const [clause, err] = catches[0];
  if (!err) {
    problems.push("E2: the catch does not bind the error");
    return problems;
  }
  const open = catches[0].index + clause.length - 1;
  const block = body.slice(open, matching(body, open) + 1);

  const call = new RegExp(
    `\\bconst\\s+(\\w+)\\s*=\\s*deleteFailure\\(\\s*${err}\\s*\\)`,
  ).exec(block);
  if (!call) {
    problems.push(`E2: the catch does not pass ${err} to deleteFailure`);
    return problems;
  }
  const kind = call[1];
  if (!new RegExp(`\\bsetFailure\\(\\s*${kind}\\s*\\)`).test(block)) {
    problems.push("E2: the catch does not store the failure with setFailure");
  }
  const mapped = new RegExp(
    `\\bsetState\\(\\s*${kind}\\s*===\\s*"invalid"\\s*\\?\\s*"error"\\s*:\\s*"idle"\\s*\\)`,
  );
  if (
    [...block.matchAll(/\bsetState\(/g)].length !== 1 ||
    !mapped.test(block)
  ) {
    problems.push(
      'E2: the catch must make one setState call: "error" for "invalid", else "idle"',
    );
  }

  return problems;
}

const OWNER_COPY =
  "You still own one or more servers. Transfer or delete them in Sloga, then come back to this link.";
const RETRY_COPY = "Something went wrong. Check your connection and try again.";
const INVALID_COPY =
  "This link is invalid or has expired, or the request was cancelled because you signed in.";

interface MatchBlock {
  when: string;
  start: number;
  end: number;
}

/**
 * Every `<Match when={…}>…</Match>`, nesting-aware, with its `when`
 * expression whitespace-normalised
 */
function matchBlocks(code: string): MatchBlock[] {
  const blocks: MatchBlock[] = [];
  const stack: { when: string; start: number }[] = [];
  for (const m of code.matchAll(/<Match\s+when=\{|<\/Match>/g)) {
    if (m[0] === "</Match>") {
      const top = stack.pop();
      if (top) blocks.push({ ...top, end: m.index });
    } else {
      const brace = m.index + m[0].length - 1;
      const when = code.slice(brace + 1, matching(code, brace));
      stack.push({ when: when.replace(/\s+/g, " ").trim(), start: m.index });
    }
  }
  return blocks;
}

/**
 * E3 violations in `raw` (empty means conforming)
 */
function copyPlacement(raw: string): string[] {
  const code = mask(raw, true);
  const blocks = matchBlocks(code);
  const problems: string[] = [];

  const expect = (
    label: string,
    text: string,
    inner: string,
    idle: boolean,
  ) => {
    const words = text
      .split(/\s+/)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const found = new RegExp(words.join("\\s+")).exec(code);
    if (!found) {
      problems.push(`E3: the ${label} copy is missing`);
      return;
    }
    const chain = blocks
      .filter((b) => b.start < found.index && found.index < b.end)
      .sort((a, b) => b.start - a.start);
    if (chain[0]?.when !== inner) {
      problems.push(
        `E3: the ${label} copy sits in Match {${chain[0]?.when}}, not {${inner}}`,
      );
    }
    const withButton = chain
      .slice(1)
      .some(
        (b) =>
          b.when.includes('state() === "idle"') &&
          /\bonPress\s*=/.test(code.slice(b.start, b.end)),
      );
    if (idle && !withButton) {
      problems.push(
        `E3: the ${label} copy is not inside the idle Match with the button`,
      );
    }
  };

  expect("owned-servers", OWNER_COPY, 'failure() === "owns-servers"', true);
  expect("retry", RETRY_COPY, 'failure() === "retry"', true);
  expect("invalid-link", INVALID_COPY, 'state() === "error"', false);
  return problems;
}

describe("flowDelete failure-mapping scanner self-check (fixtures)", () => {
  const good = `
    function deleteFailure(error: unknown): string {
      return typeof error === "string" ? "invalid" : "retry";
    }
    export default function F() {
      async function go() {
        if (state() !== "idle") return;
        setState("pending");
        try {
          await api.put("/x", { confirm: true });
        } catch (err) {
          const kind = deleteFailure(err);
          setFailure(kind);
          setState(kind === "invalid" ? "error" : "idle");
        }
      }
      return (
        <Switch>
          <Match when={state() === "idle" || state() === "pending"}>
            <Switch>
              <Match when={failure() === "owns-servers"}>${OWNER_COPY}</Match>
              <Match when={failure() === "retry"}>${RETRY_COPY}</Match>
            </Switch>
            <Button onPress={go} />
          </Match>
          <Match when={state() === "error"}>${INVALID_COPY}</Match>
        </Switch>
      );
    }`;

  it("passes a conforming source", () => {
    assert.deepEqual(failureWiring(good), []);
    assert.deepEqual(copyPlacement(good), []);
    assert.equal(lift(good, "deleteFailure")("x"), "invalid");
  });

  it("E1: throws when the classifier is missing", () => {
    assert.throws(() => lift("const x = 1;", "deleteFailure"), /E1/);
  });

  it("E1: a lifted classifier that reads an outer name throws", () => {
    const leaky = lift(
      "function deleteFailure(e: unknown) { return outer; }",
      "deleteFailure",
    );
    assert.throws(() => leaky(""), ReferenceError);
  });

  it("E1: the case table catches a wrong classifier", () => {
    assert.ok(misclassified(() => "invalid").length > 0);
    assert.ok(
      misclassified((e) => (e === "" ? "invalid" : "retry")).length > 0,
    );
  });

  it("E2: flags an unconditional terminal state", () => {
    const src = good.replace(
      'setState(kind === "invalid" ? "error" : "idle");',
      'setState("error");',
    );
    assert.ok(failureWiring(src).some((p) => p.startsWith("E2")));
  });

  it("E2: flags a catch that does not classify", () => {
    const src = good.replace("deleteFailure(err)", '"invalid"');
    assert.ok(failureWiring(src).some((p) => p.startsWith("E2")));
  });

  it("E2: flags a bare catch", () => {
    const src = good.replace("catch (err)", "catch");
    assert.ok(failureWiring(src).some((p) => p.startsWith("E2")));
  });

  it("E2: flags a missing setFailure", () => {
    const src = good.replace("setFailure(kind);", "");
    assert.ok(failureWiring(src).some((p) => p.includes("setFailure")));
  });

  it("E4: flags a missing double-press guard", () => {
    const src = good.replace('if (state() !== "idle") return;', "");
    assert.ok(failureWiring(src).some((p) => p.startsWith("E4")));
  });

  it("E3: flags copy in the wrong Match", () => {
    const src = good
      .replace(`>${OWNER_COPY}<`, ">SWAP<")
      .replace(`>${RETRY_COPY}<`, `>${OWNER_COPY}<`)
      .replace(">SWAP<", `>${RETRY_COPY}<`);
    assert.equal(copyPlacement(src).length, 2);
  });

  it("E3: flags owner copy outside the idle Match", () => {
    const src = good.replace(
      'state() === "idle" || state() === "pending"',
      'state() === "deleted"',
    );
    assert.ok(copyPlacement(src).some((p) => p.includes("idle Match")));
  });

  it("E3: is not fooled by copy in a comment", () => {
    const src = good.replace(
      `<Match when={failure() === "retry"}>${RETRY_COPY}</Match>`,
      `{/* ${RETRY_COPY} */}`,
    );
    assert.ok(
      copyPlacement(src).some((p) => p.includes("retry copy is missing")),
    );
  });
});

describe("flowDelete scanner self-check (fixtures)", () => {
  const good = `
    export default function F() {
      async function go() {
        await api.put("/x", { token: params.token, confirm: true });
      }
      return <Button onPress={go}>x</Button>;
    }`;

  it("passes a conforming source", () => {
    assert.deepEqual(scan(good), []);
  });

  it("passes an inline onPress handler", () => {
    const src = `
      export default function F() {
        return <Button onPress={() => api.put("/x", { confirm: true })} />;
      }`;
    assert.deepEqual(scan(src), []);
  });

  it("flags onMount", () => {
    const src = good.replace("return", "onMount(() => {});\n return");
    assert.ok(scan(src).some((p) => p.startsWith("D1")));
  });

  it("flags a put in the component body", () => {
    const src = `
      export default function F() {
        api.put("/x", { confirm: true });
        return <div />;
      }`;
    assert.ok(scan(src).some((p) => p.startsWith("D2")));
  });

  it("flags a handler that is also called directly", () => {
    const src = good.replace("return", "setTimeout(go, 0);\n return");
    assert.ok(scan(src).some((p) => p.includes("outside an event handler")));
  });

  it("flags a missing confirm: true", () => {
    const src = good.replace("confirm: true", "confirm: false");
    assert.ok(scan(src).some((p) => p.startsWith("D3")));
  });

  it("is not fooled by confirm: true in a comment", () => {
    const src = good.replace("confirm: true });", "/* confirm: true */ });");
    assert.ok(scan(src).some((p) => p.startsWith("D3")));
  });
});

describe("FlowDelete.tsx", () => {
  it("sends nothing on load, PUTs only from a handler, with confirm: true", () => {
    const source = readFileSync(SCAN_FILE, "utf8");
    assert.deepEqual(scan(source), []);
  });

  it("E1: deleteFailure maps each thrown error to the right outcome", () => {
    const source = readFileSync(SCAN_FILE, "utf8");
    assert.deepEqual(misclassified(lift(source, "deleteFailure")), []);
  });

  it("E2/E4: the catch maps the failure, and the guard stays", () => {
    const source = readFileSync(SCAN_FILE, "utf8");
    assert.deepEqual(failureWiring(source), []);
  });

  it("E3: each failure's copy shows in the right place", () => {
    const source = readFileSync(SCAN_FILE, "utf8");
    assert.deepEqual(copyPlacement(source), []);
  });
});
