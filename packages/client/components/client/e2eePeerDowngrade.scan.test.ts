// Source-scan spec for accepting a peer's downgrade on Android: the move to
// plaintext must take a tap on the native dialog, never a webview boolean.
// Run with Node's built-in runner:
//   node --conditions=browser --test components/client/e2eePeerDowngrade.scan.test.ts
// `E2eePlugin.kt` is Kotlin and does not load under Node, so the wiring is
// pinned by reading the source. Point `E2EE_DOWNGRADE_KT` at another copy
// (the known-bad control: the arm that forwarded `accept`) to scan that
// instead; it must fail.
//
// Comments are stripped first, so a commented-out call never satisfies (or
// trips) a rule. String contents are kept: one rule reads the "accept" key.
//
//   D1. The generic `call()` arm for `e2ee_confirm_peer_downgrade` refuses
//       `accept == true` (a `throw`) before it commits, and every
//       `confirmPeerDowngrade(` in that arm passes the literal `false`.
//   D2. Anywhere in the file, a `confirmPeerDowngrade(` whose second argument
//       is not the literal `false` sits inside `fun confirmPeerDowngradeAccept(`
//       and inside a `setPositiveButton` listener there.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const KT_FILE =
  process.env.E2EE_DOWNGRADE_KT ??
  new URL(
    "../../android/app/src/main/java/com/acutest/app/e2ee/E2eePlugin.kt",
    import.meta.url,
  );

/**
 * Kotlin with comments blanked to spaces (offsets kept). Strings, raw
 * strings and char literals are skipped over so a `//` inside one survives.
 */
function stripComments(src: string): string {
  const out = src.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let j = from; j < to; j++) if (out[j] !== "\n") out[j] = " ";
  };
  while (i < src.length) {
    if (src.startsWith('"""', i)) {
      const end = src.indexOf('"""', i + 3);
      i = end === -1 ? src.length : end + 3;
    } else if (src[i] === '"' || src[i] === "'") {
      const q = src[i];
      i++;
      while (i < src.length && src[i] !== q && src[i] !== "\n") {
        i += src[i] === "\\" ? 2 : 1;
      }
      i++;
    } else if (src.startsWith("//", i)) {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (src.startsWith("/*", i)) {
      // Kotlin block comments nest
      let depth = 0;
      let j = i;
      do {
        if (src.startsWith("/*", j)) {
          depth++;
          j += 2;
        } else if (src.startsWith("*/", j)) {
          depth--;
          j += 2;
        } else j++;
      } while (depth > 0 && j < src.length);
      blank(i, j);
      i = j;
    } else i++;
  }
  return out.join("");
}

/** Index just past the bracket matching the one at `open` (strings skipped) */
function matchClose(s: string, open: number): number {
  const pair: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const stack = [pair[s[open]]];
  let i = open + 1;
  while (i < s.length && stack.length) {
    const c = s[i];
    if (c === '"' || c === "'") {
      i++;
      while (i < s.length && s[i] !== c && s[i] !== "\n") {
        i += s[i] === "\\" ? 2 : 1;
      }
    } else if (pair[c]) stack.push(pair[c]);
    else if (c === stack[stack.length - 1]) stack.pop();
    i++;
  }
  assert.equal(stack.length, 0, `unbalanced from offset ${open}`);
  return i;
}

/** Top-level arguments of the call whose `(` is at `open`, trimmed */
function args(s: string, open: number): string[] {
  const close = matchClose(s, open) - 1;
  const out: string[] = [];
  let depth = 0;
  let from = open + 1;
  for (let i = open + 1; i < close; i++) {
    const c = s[i];
    if (c === '"' || c === "'") {
      i++;
      while (i < close && s[i] !== c) i += s[i] === "\\" ? 2 : 1;
    } else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      out.push(s.slice(from, i).trim());
      from = i + 1;
    }
  }
  const last = s.slice(from, close).trim();
  if (last) out.push(last);
  return out;
}

/** Start offsets of every `confirmPeerDowngrade(` call's `(` */
function commitCalls(s: string): number[] {
  return [...s.matchAll(/\bconfirmPeerDowngrade\s*\(/g)].map(
    (m) => m.index! + m[0].length - 1,
  );
}

/** [start, end) of the block body following `marker` */
function blockAfter(s: string, marker: RegExp): [number, number] {
  const m = marker.exec(s);
  assert.ok(m, `${marker} not found`);
  const open = s.indexOf("{", m.index + m[0].length - 1);
  assert.notEqual(open, -1, `${marker} has no block`);
  return [open, matchClose(s, open)];
}

const src = stripComments(readFileSync(KT_FILE, "utf8"));

test("D1: the generic arm refuses accept and only ever declines", () => {
  const [callFrom, callTo] = blockAfter(src, /\bfun call\s*\(\s*call\s*:/);
  const callBody = src.slice(callFrom, callTo);
  const [from, to] = blockAfter(
    callBody,
    /"e2ee_confirm_peer_downgrade"\s*->\s*\{/,
  );
  const arm = callBody.slice(from, to);

  const refuse = arm.search(
    /if\s*\(\s*call\.getBoolean\(\s*"accept"\s*\)\s*==\s*true\s*\)\s*\{\s*throw\b/,
  );
  assert.notEqual(refuse, -1, "the arm must throw on accept == true");

  const calls = commitCalls(arm);
  assert.ok(calls.length >= 1, "the arm must still record the decline");
  for (const open of calls) {
    assert.ok(open > refuse, "the refusal must come before any commit");
    const a = args(arm, open);
    assert.equal(a.length, 2, `confirmPeerDowngrade args: ${a.join(" | ")}`);
    assert.equal(a[1], "false", "the generic arm may only pass false");
  }
});

test("D2: anything but a literal false commits only from the dialog's positive button", () => {
  const [accFrom, accTo] = blockAfter(
    src,
    /\bfun confirmPeerDowngradeAccept\s*\(\s*call\s*:/,
  );
  const accept = src.slice(accFrom, accTo);
  const positive = [...accept.matchAll(/\.setPositiveButton\s*\(/g)].map(
    (m) => {
      const open = m.index! + m[0].length - 1;
      let end = matchClose(accept, open);
      // A trailing lambda after the call's parentheses belongs to it
      const rest = accept.slice(end).match(/^\s*\{/);
      if (rest) end = matchClose(accept, end + rest[0].length - 1);
      return [accFrom + open, accFrom + end] as const;
    },
  );
  assert.ok(positive.length >= 1, "the accept dialog has no positive button");

  let accepts = 0;
  for (const open of commitCalls(src)) {
    const a = args(src, open);
    if (a[1] === "false") continue;
    accepts++;
    assert.ok(
      positive.some(([f, t]) => open > f && open < t),
      `confirmPeerDowngrade(${a.join(", ")}) at offset ${open} is outside the accept dialog's positive button`,
    );
  }
  assert.ok(accepts >= 1, "the dialog must still be able to accept");
});
