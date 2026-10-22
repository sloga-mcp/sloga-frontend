// Gate G10's iOS spec (plan ios-e2ee-messaging-port D7 + D10 G10). Run with
// Node's built-in runner:
//   node --conditions=browser --test components/client/e2eeIosGate.test.ts
// iOS turns native E2EE on for messages and attachments, but calls on iPhone
// stay plaintext in phase 1. What keeps that honest is one chain: on iOS
// `platformMediaE2EESupported()` is TRUE (no `slogaShell`), so
// `mediaE2EEPlatformSupported(keyPush)` is false ONLY because
// `CapacitorTransport.keyPushAvailable()` answers false there. That one
// predicate feeds both `shellSupported` (rtc/state.tsx) and the bridge's MLS
// KeyPackage prepublish, so an iOS device neither builds an "encrypted" Room
// nor stocks the KeyPackage directory.
//
// `e2eePlatform.ts` and `e2eeProtectorCopy.ts` load under Node and are tested
// by behavior. `e2ee.ts`, `rtc/state.tsx`, `Controller.ts` and
// `Encryption.tsx` do not (Solid, Capacitor, stoat.js), so their wiring is
// pinned by reading the sources. Point `E2EE_IOS_GATE_TS`,
// `E2EE_IOS_GATE_STATE`, `E2EE_IOS_GATE_CONTROLLER` (files) and
// `E2EE_IOS_GATE_COMPONENTS` (a components root) at other copies to scan
// those instead (the known-bad control: the 8821aac9 files, which fail
// G4-G9, F1, C1, C2 and D1-D2; G1-G3 hold there, the keyPush body being
// unchanged by design).
//
// The TS lexer is the one in e2eeDecryptSelf.scan.test.ts (that file exports
// nothing), plus one change for .tsx: a quote right after a letter or digit
// is JSX text (`aren't`), not a string opener. Comments are stripped before
// every check; a file whose braces do not balance after masking fails its
// "0" rule (G0, C0, D0, E0) rather than being scoped wrongly.
//
// e2ee.ts:
//   G0. The file lexes to balanced braces.
//   G1. Exactly one `class CapacitorTransport`, and no other
//       `class Capacitor*Transport` (C4: one class, per-platform values).
//   G2. Its only top-level `nativeBlobTransfer` is
//       `readonly nativeBlobTransfer = true;`.
//   G3. Its one `keyPushAvailable()` body is exactly
//       `return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";`
//       (wrapping parens allowed): the D7 media gate pin, iOS false. Never
//       "fix" it to true in phase 1.
//   G4. Its only top-level `clipboardImageInWebview` is
//       `readonly clipboardImageInWebview = capacitorClipboardImageInWebview(Capacitor.getPlatform());`.
//   G5. Its one `attachmentUrl(messageId, idx)` body is exactly
//       `return capacitorAttachmentUrl(Capacitor.getPlatform(), messageId, idx);`
//       and no string in the class names `e2ee-att`.
//   G6. `function nativeE2EEAvailable` (one) ends with
//       `return capacitorNativeE2EE(Capacitor.isNativePlatform(), Capacitor.getPlatform(), (x) => Capacitor.isPluginAvailable(x));`,
//       calls `capacitorNativeE2EE(` once and compares no
//       `Capacitor.getPlatform()` itself.
//   G7. `#prepublishMlsKeyPackages` (one) starts with
//       `if (!this.mediaE2EEPlatformSupported()) return;` and still holds
//       `if (!this.#callsEnabled()) return;`.
//   G8. `class E2EEBridge` (one) has one `mediaE2EEPlatformSupported()`
//       returning `mediaE2EEPlatformSupported(this.nativeKeyPushAvailable())`
//       and one `nativeKeyPushAvailable()` returning
//       `this.#transport.keyPushAvailable()`.
//   G9. One source: the four Capacitor/media helpers are imported unaliased
//       from `./e2eePlatform`, and e2ee.ts defines none of the five
//       e2eePlatform functions itself.
//   F1. Every `new E2EESendError(` whose message is "Encryption status could
//       not be verified. ..." and that sits in a `catch` (same function) binds
//       the error and reads
//       `protectorSendErrorCopy(<the binding>, Capacitor.getPlatform()) ?? "<the old text>"`,
//       the old text being one of the two existing messages, kind "native".
//   F2. There are exactly PROTECTOR_SITES such catch sites (L4a wired 6).
// rtc/state.tsx:
//   C0. The file lexes to balanced braces.
//   C1. `const shellSupported =` (one): a pure `&&` chain with the term
//       `!!bridge?.mediaE2EEPlatformSupported()` and no separate
//       `nativeKeyPushAvailable(` or `platformMediaE2EESupported(` term.
//   C2. state.tsx defines no `platformMediaE2EESupported` and re-exports it
//       from `../client/e2eePlatform` (one source).
// Controller.ts:
//   D0. The file lexes to balanced braces.
//   D1. `Capacitor` is imported from `@capacitor/core`.
//   D2. "Sloga for iOS" appears once, as `friendly_name = "Sloga for iOS";`.
//   D3. That assignment sits directly in the then-block of
//       `if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios")`.
//   D4. That block is followed by `else if (browser)`: iOS is decided before
//       the web/UA branch.
// components/** (W2 carry-in: the core OPENS, so provisions, the store on
// `e2ee_backup_status`, so the webview may ask only once E2EE is on):
//   E0. Every file with a hit lexes to balanced braces.
//   E1. `e2ee_backup_status` appears once, inside `backupStatus()`'s body.
//   E2. `backupStatus(` appears un-dotted once, as the method in
//       client/e2ee.ts (a bare call through a destructured alias, or a
//       second definition, is a second hit and fails).
//   E3. At least one `.backupStatus(` call exists, none by bracket access,
//       and each call's enclosing function starts with
//       `if (... || !enabled() ...) return`, where the nearest `enabled` in
//       scope is
//       `const enabled = () => { const s = <x>.status.get("state"); return !!s?.enabled && !!s?.published; };`.
//
// The scanners are checked against inline fixtures first (a conforming file
// passes; each mutation fails exactly its own rule), so a green scan is never
// a scanner that cannot fail.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  capacitorAttachmentUrl,
  capacitorClipboardImageInWebview,
  capacitorNativeE2EE,
  mediaE2EEPlatformSupported,
  platformMediaE2EESupported,
} from "./e2eePlatform.ts";
import { protectorSendErrorCopy } from "./e2eeProtectorCopy.ts";

const TS_FILE =
  process.env.E2EE_IOS_GATE_TS || new URL("./e2ee.ts", import.meta.url);
const STATE_FILE =
  process.env.E2EE_IOS_GATE_STATE ||
  new URL("../rtc/state.tsx", import.meta.url);
const CONTROLLER_FILE =
  process.env.E2EE_IOS_GATE_CONTROLLER ||
  new URL("./Controller.ts", import.meta.url);
const COMPONENTS_DIR =
  process.env.E2EE_IOS_GATE_COMPONENTS ||
  fileURLToPath(new URL("../", import.meta.url));

/** The catch sites L4a wired to the protector copy (F2). */
const PROTECTOR_SITES = 6;

// ---- A. Behavior: e2eePlatform.ts -------------------------------------------

/** Runs `fn` with `globalThis.window` set to `win`, then restores it. */
function withWindow<T>(win: object, fn: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const had = "window" in g;
  const previous = g.window;
  g.window = win;
  try {
    return fn();
  } finally {
    if (had) g.window = previous;
    else delete g.window;
  }
}

const ID = "01JB0000000000000000000000";

test("capacitorNativeE2EE: iOS needs the plugin named exactly E2ee", () => {
  const asked: string[] = [];
  const probe = (answer: (name: string) => boolean) => (name: string) => {
    asked.push(name);
    return answer(name);
  };
  assert.equal(
    capacitorNativeE2EE(
      true,
      "ios",
      probe(() => false),
    ),
    false,
  );
  assert.equal(
    capacitorNativeE2EE(
      true,
      "ios",
      probe((name) => name === "E2ee"),
    ),
    true,
  );
  assert.equal(
    capacitorNativeE2EE(
      true,
      "ios",
      probe((name) => name === "e2ee" || name === "E2EE"),
    ),
    false,
  );
  assert.deepEqual(asked, ["E2ee", "E2ee", "E2ee"]);
});

test("capacitorNativeE2EE: Android is native regardless of the plugin probe", () => {
  assert.equal(
    capacitorNativeE2EE(true, "android", () => false),
    true,
  );
  assert.equal(
    capacitorNativeE2EE(true, "android", () => true),
    true,
  );
});

test("capacitorNativeE2EE: web, empty and unknown platforms have none", () => {
  for (const platform of ["web", "", "electron", "IOS", "Android"]) {
    assert.equal(
      capacitorNativeE2EE(true, platform, () => true),
      false,
      platform,
    );
  }
});

test("capacitorNativeE2EE: not native means no native E2EE on every platform", () => {
  for (const platform of ["ios", "android", "web", ""]) {
    assert.equal(
      capacitorNativeE2EE(false, platform, () => true),
      false,
      platform,
    );
  }
});

test("capacitorAttachmentUrl: iOS uses the e2ee-att scheme (C3), Android the same-origin path", () => {
  assert.equal(capacitorAttachmentUrl("ios", ID, 3), `e2ee-att://att/${ID}/3`);
  assert.equal(capacitorAttachmentUrl("android", ID, 0), `/_e2ee-att/${ID}/0`);
});

test("capacitorClipboardImageInWebview: only Android copies in the webview", () => {
  assert.equal(capacitorClipboardImageInWebview("ios"), false);
  assert.equal(capacitorClipboardImageInWebview("android"), true);
  for (const platform of ["web", "", "electron", "IOS", "Android"]) {
    assert.equal(capacitorClipboardImageInWebview(platform), false, platform);
  }
});

test("media gate pin (D7): on iOS the platform term is TRUE, so the key-push false is all that keeps calls honest", () => {
  // A Capacitor iOS webview: no `slogaShell`, no `__TAURI__`.
  withWindow({}, () => {
    assert.equal(platformMediaE2EESupported(), true);
    // iOS: CapacitorTransport.keyPushAvailable() is false (G3).
    assert.equal(mediaE2EEPlatformSupported(false), false);
    // The same window with a key push WOULD arm media E2EE, which is why G3
    // must never be "fixed" to true for iOS.
    assert.equal(mediaE2EEPlatformSupported(true), true);
  });
});

test("media predicate per platform: Tauri, Android and audited Electron arm; unaudited Electron never does", () => {
  const rows: [string, object, boolean, boolean][] = [
    // [label, window, keyPushAvailable, expected]
    ["Windows Tauri", { __TAURI__: { core: {} } }, true, true],
    ["Android", {}, true, true],
    ["iOS", {}, false, false],
    ["web (no bridge)", {}, false, false],
    [
      "Linux Electron, audited",
      { slogaShell: { e2ee: { mediaE2EE: true } } },
      true,
      true,
    ],
    [
      "audited Electron, no key push",
      { slogaShell: { e2ee: { mediaE2EE: true } } },
      false,
      false,
    ],
    ["Electron, unaudited", { slogaShell: { e2ee: {} } }, true, false],
    ["Electron, older shell", { slogaShell: {} }, true, false],
    [
      "Electron, truthy non-true flag",
      { slogaShell: { e2ee: { mediaE2EE: "true" } } },
      true,
      false,
    ],
  ];
  for (const [label, win, keyPush, expected] of rows) {
    withWindow(win, () => {
      assert.equal(mediaE2EEPlatformSupported(keyPush), expected, label);
    });
  }
  withWindow({ slogaShell: { e2ee: {} } }, () => {
    assert.equal(platformMediaE2EESupported(), false, "unaudited Electron");
  });
  withWindow({ slogaShell: { e2ee: { mediaE2EE: true } } }, () => {
    assert.equal(platformMediaE2EESupported(), true, "audited Electron");
  });
});

// ---- Shared helpers ---------------------------------------------------------

interface Masked {
  /** Comments and string contents blanked. */
  code: string;
  /** Comments blanked; string contents kept. */
  text: string;
}

const squash = (s: string) => s.replace(/\s+/g, "");
/** Squashed, with a trailing comma before a closing bracket dropped. */
const norm = (s: string) => squash(s).replace(/,(?=[)\]}])/g, "");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

/**
 * The top-level comma-separated items between the bracket at `open` and its
 * match: brackets are matched on `m.code`, items are sliced from `m.text`
 * (string contents kept) and normalized.
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
  return out.map(norm).filter((a) => a !== "");
}

/** The top-level `op`-separated parts of `[from, to)`, normalized. */
function splitTop(m: Masked, from: number, to: number, op: string): string[] {
  const out: string[] = [];
  let start = from;
  for (let i = from; i < to; i++) {
    const c = m.code[i];
    if (c === "(" || c === "[" || c === "{") i = matchClose(m.code, i);
    else if (m.code.startsWith(op, i)) {
      out.push(m.text.slice(start, i));
      start = i + op.length;
      i += op.length - 1;
    }
  }
  out.push(m.text.slice(start, to));
  return out.map(norm).filter((a) => a !== "");
}

function skipWs(code: string, i: number): number {
  while (i < code.length && /\s/.test(code[i])) i++;
  return i;
}

/** Index of the last non-space character at or before `i`. */
function skipBack(code: string, i: number): number {
  while (i >= 0 && /\s/.test(code[i])) i--;
  return i;
}

/** Index of the `;` ending the statement that runs from `from`, or -1. */
function stmtEnd(code: string, from: number): number {
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") i = matchClose(code, i);
    else if (c === ";") return i;
    else if (c === ")" || c === "]" || c === "}") return -1;
  }
  return -1;
}

/** The identifier ending just before index `i` (masked code), or "". */
function wordBefore(code: string, i: number): string {
  let j = skipBack(code, i - 1);
  const end = j + 1;
  while (j >= 0 && /[\w$#]/.test(code[j])) j--;
  return code.slice(j + 1, end);
}

/** `{` positions enclosing index `at` (masked code), innermost last. */
function enclosingBlocks(code: string, at: number): number[] {
  const stack: number[] = [];
  for (let i = 0; i < at; i++) {
    if (code[i] === "{") stack.push(i);
    else if (code[i] === "}") stack.pop();
  }
  return stack;
}

const CONTROL_WORDS = new Set(["if", "for", "while", "switch", "catch"]);

/**
 * Whether the `{` at `open` starts a function body: `=> {`, or
 * `name(...) {` / `name(...): T {` with `name` not a control keyword.
 */
function isFunctionBody(code: string, open: number): boolean {
  const before = code.slice(Math.max(0, open - 400), open);
  if (/=>\s*$/.test(before)) return true;
  const sig = /\)\s*(?::[^(){};=]*)?$/.exec(before);
  if (!sig) return false;
  const paren = matchOpen(code, open - before.length + sig.index);
  const word = wordBefore(code, paren);
  return word !== "" && !CONTROL_WORDS.has(word);
}

/**
 * When the `{` at `open` is a catch body: its binding ("" when it binds
 * nothing). Otherwise null.
 */
function catchBinding(code: string, open: number): string | null {
  const j = skipBack(code, open - 1);
  if (wordBefore(code, j + 1) === "catch") return "";
  if (code[j] !== ")") return null;
  const paren = matchOpen(code, j);
  if (wordBefore(code, paren) !== "catch") return null;
  const binding = /^\(\s*([\w$]+)/.exec(code.slice(paren, j + 1));
  return binding ? binding[1] : "";
}

/** `[open, close]` of each `class NAME` body. */
function classBodies(code: string, name: string): [number, number][] {
  const out: [number, number][] = [];
  for (const hit of code.matchAll(
    new RegExp(`\\bclass\\s+${escapeRe(name)}(?![\\w$])`, "g"),
  )) {
    const open = code.indexOf("{", hit.index!);
    if (open >= 0) out.push([open, matchClose(code, open)]);
  }
  return out;
}

/**
 * Where `name` appears at the top level of the class body `[open, close]`
 * (bracket depth 0, not after a `.`): its member declarations.
 */
function topLevelHits(
  code: string,
  open: number,
  close: number,
  name: string,
): number[] {
  const re = new RegExp(`(?<![.\\w$#])${escapeRe(name)}(?![\\w$])`, "g");
  const out: number[] = [];
  let depth = 0;
  let at = open + 1;
  for (const hit of code.slice(open + 1, close).matchAll(re)) {
    const index = open + 1 + hit.index!;
    for (; at < index; at++) {
      if ("({[".includes(code[at])) depth++;
      else if (")}]".includes(code[at])) depth--;
    }
    if (depth === 0) out.push(index);
  }
  return out;
}

/** The body `[open, close]` of the method named at `at`, or null. */
function methodBodyAt(
  code: string,
  at: number,
  name: string,
): [number, number] | null {
  const paren = skipWs(code, at + name.length);
  if (code[paren] !== "(") return null;
  const params = matchClose(code, paren);
  const open = code.indexOf("{", params);
  if (open < 0) return null;
  if (!/^\s*(?::[^(){};=]*)?$/.test(code.slice(params + 1, open))) return null;
  return [open, matchClose(code, open)];
}

/** `[open, close]` of the body of each definition of private method `#name`. */
function privateMethodBodies(code: string, name: string): [number, number][] {
  const def = new RegExp(
    `(?<!\\.\\s*)#${escapeRe(name)}\\s*(?:<[^()]*>)?\\s*\\(`,
    "g",
  );
  const out: [number, number][] = [];
  for (const hit of code.matchAll(def)) {
    const params = matchClose(code, hit.index! + hit[0].length - 1);
    const open = code.indexOf("{", params);
    if (open >= 0) out.push([open, matchClose(code, open)]);
  }
  return out;
}

/** The class statement holding the top-level member at `at`, normalized. */
function memberStatement(m: Masked, at: number): string {
  let start = at;
  while (start > 0 && !/[;{}]/.test(m.code[start - 1])) start--;
  const end = stmtEnd(m.code, at);
  return end < 0 ? "" : norm(m.text.slice(start, end + 1));
}

/** A normalized body, with `return (x);` unwrapped to `return x;`. */
function unwrapReturn(body: string): string {
  const wrapped = /^return\((.*)\);$/.exec(body);
  if (!wrapped) return body;
  let depth = 0;
  for (const c of wrapped[1]) {
    if (c === "(") depth++;
    else if (c === ")" && --depth < 0) return body;
  }
  return depth === 0 ? `return${wrapped[1]};` : body;
}

/** Whether the braces of the masked code balance. */
function balanced(code: string): boolean {
  let depth = 0;
  for (const c of code) {
    if (c === "{") depth++;
    else if (c === "}" && --depth < 0) return false;
  }
  return depth === 0;
}

// ---- TypeScript lexer (as in e2eeDecryptSelf.scan.test.ts) -----------------

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
 * index in the result is the same index in `src`. A quote right after a
 * letter or digit is JSX text (`aren't`), not a string opener.
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
      if ((c === '"' || c === "'") && !/[A-Za-z0-9]/.test(src[i - 1] ?? "")) {
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
      // `</Tag>` and `/>` close JSX; they never open a regex.
      const jsxSlash = next === ">" || code[prevSignificant(i)] === "<";
      if (c === "/" && !jsxSlash && regexAllowed(i)) {
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

// ---- e2ee.ts rules: the transport, the gate and the prepublish (G) ---------

const KEY_PUSH_BODY =
  'returnCapacitor.isNativePlatform()&&Capacitor.getPlatform()==="android";';
const CLIPBOARD_DECL =
  "readonlyclipboardImageInWebview=capacitorClipboardImageInWebview(Capacitor.getPlatform());";
const ATTACHMENT_BODY =
  "returncapacitorAttachmentUrl(Capacitor.getPlatform(),messageId,idx);";
const NATIVE_RETURN =
  /returncapacitorNativeE2EE\(Capacitor\.isNativePlatform\(\),Capacitor\.getPlatform\(\),(?:\(([\w$]+)\)|([\w$]+))=>Capacitor\.isPluginAvailable\((?:\1|\2)\)\);$/;
const PREPUBLISH_GATE = "if(!this.mediaE2EEPlatformSupported())return;";
const CALLS_GATE = "if(!this.#callsEnabled())return;";
const BRIDGE_MEDIA_BODY =
  "returnmediaE2EEPlatformSupported(this.nativeKeyPushAvailable());";
const BRIDGE_KEY_PUSH_BODY = "returnthis.#transport.keyPushAvailable();";
const PLATFORM_IMPORTS = [
  "capacitorAttachmentUrl",
  "capacitorClipboardImageInWebview",
  "capacitorNativeE2EE",
  "mediaE2EEPlatformSupported",
];
const PLATFORM_FUNCTIONS = [...PLATFORM_IMPORTS, "platformMediaE2EESupported"];

/** Index of the one top-level `name` member of a class body, or a violation. */
function oneMember(
  m: Masked,
  body: [number, number],
  name: string,
): number | string {
  const hits = topLevelHits(m.code, body[0], body[1], name);
  return hits.length === 1
    ? hits[0]
    : `${hits.length} top-level \`${name}\` members, want 1`;
}

function transportViolations(src: string, m: Masked): string[] {
  const out: string[] = [];

  // G1: one class, not split per platform.
  const names = [
    ...m.code.matchAll(/\bclass\s+(Capacitor[\w$]*Transport)(?![\w$])/g),
  ].map((h) => h[1]);
  const bodies = classBodies(m.code, "CapacitorTransport");
  if (bodies.length !== 1 || names.length !== 1) {
    out.push(
      `G1 ${bodies.length} \`class CapacitorTransport\`, Capacitor transport` +
        ` classes ${JSON.stringify(names)}; want exactly CapacitorTransport`,
    );
  }
  if (bodies.length !== 1) return out;
  const body = bodies[0];
  const line = lineOf(src, body[0]);

  // G2: nativeBlobTransfer = true.
  const blob = oneMember(m, body, "nativeBlobTransfer");
  if (typeof blob === "string") out.push(`G2 line ${line}: ${blob}`);
  else if (memberStatement(m, blob) !== "readonlynativeBlobTransfer=true;") {
    out.push(
      `G2 line ${lineOf(src, blob)}: \`${memberStatement(m, blob)}\`, want` +
        " readonly nativeBlobTransfer = true;",
    );
  }

  // G3: keyPushAvailable() stays android-only.
  const keyPush = oneMember(m, body, "keyPushAvailable");
  if (typeof keyPush === "string") out.push(`G3 line ${line}: ${keyPush}`);
  else {
    const at = methodBodyAt(m.code, keyPush, "keyPushAvailable");
    const got = at ? unwrapReturn(norm(m.text.slice(at[0] + 1, at[1]))) : "";
    if (got !== KEY_PUSH_BODY) {
      out.push(
        `G3 line ${lineOf(src, keyPush)}: keyPushAvailable() is \`${got}\`,` +
          ` want \`${KEY_PUSH_BODY}\` (iOS false, D7 media gate pin)`,
      );
    }
  }

  // G4: clipboardImageInWebview from e2eePlatform.
  const clip = oneMember(m, body, "clipboardImageInWebview");
  if (typeof clip === "string") out.push(`G4 line ${line}: ${clip}`);
  else if (memberStatement(m, clip) !== CLIPBOARD_DECL) {
    out.push(
      `G4 line ${lineOf(src, clip)}: \`${memberStatement(m, clip)}\`, want` +
        ` \`${CLIPBOARD_DECL}\``,
    );
  }

  // G5: attachmentUrl from e2eePlatform; no URL literal in the class.
  const url = oneMember(m, body, "attachmentUrl");
  if (typeof url === "string") out.push(`G5 line ${line}: ${url}`);
  else {
    const at = methodBodyAt(m.code, url, "attachmentUrl");
    const got = at ? norm(m.text.slice(at[0] + 1, at[1])) : "";
    if (got !== ATTACHMENT_BODY) {
      out.push(
        `G5 line ${lineOf(src, url)}: attachmentUrl() is \`${got}\`, want` +
          ` \`${ATTACHMENT_BODY}\``,
      );
    }
  }
  const classText = m.text.slice(body[0], body[1]);
  for (const hit of classText.matchAll(/e2ee-att/g)) {
    out.push(
      `G5 line ${lineOf(src, body[0] + hit.index!)}: a hard-coded e2ee-att` +
        " URL in CapacitorTransport",
    );
  }
  return out;
}

function gateViolations(src: string, m: Masked): string[] {
  const out: string[] = [];

  // G6: nativeE2EEAvailable defers the Capacitor answer.
  const defs = [...m.code.matchAll(/\bfunction\s+nativeE2EEAvailable\s*\(/g)];
  if (defs.length !== 1) {
    out.push(`G6 function nativeE2EEAvailable defined ${defs.length} times`);
  } else {
    const at = defs[0].index!;
    const params = matchClose(m.code, at + defs[0][0].length - 1);
    const open = m.code.indexOf("{", params);
    const body = norm(m.text.slice(open + 1, matchClose(m.code, open)));
    const line = lineOf(src, at);
    if (!NATIVE_RETURN.test(body)) {
      out.push(
        `G6 line ${line}: nativeE2EEAvailable does not end with return` +
          " capacitorNativeE2EE(isNativePlatform, getPlatform, name =>" +
          " Capacitor.isPluginAvailable(name))",
      );
    }
    if (body.split("capacitorNativeE2EE(").length !== 2) {
      out.push(`G6 line ${line}: capacitorNativeE2EE( is not called once`);
    }
    if (/Capacitor\.getPlatform\(\)[!=]==/.test(body)) {
      out.push(
        `G6 line ${line}: nativeE2EEAvailable compares Capacitor.getPlatform()` +
          " itself instead of leaving it to capacitorNativeE2EE",
      );
    }
  }

  // G7: the prepublish platform gate comes first.
  const pre = privateMethodBodies(m.code, "prepublishMlsKeyPackages");
  if (pre.length !== 1) {
    out.push(`G7 #prepublishMlsKeyPackages defined ${pre.length} times`);
  } else {
    const [open, close] = pre[0];
    const body = norm(m.text.slice(open + 1, close));
    const line = lineOf(src, open);
    if (!body.startsWith(PREPUBLISH_GATE)) {
      out.push(
        `G7 line ${line}: #prepublishMlsKeyPackages does not start with` +
          " if (!this.mediaE2EEPlatformSupported()) return;",
      );
    }
    if (!body.includes(CALLS_GATE)) {
      out.push(
        `G7 line ${line}: #prepublishMlsKeyPackages lost` +
          " if (!this.#callsEnabled()) return;",
      );
    }
  }

  // G8: the bridge's one predicate.
  const bridges = classBodies(m.code, "E2EEBridge");
  if (bridges.length !== 1) {
    out.push(`G8 class E2EEBridge defined ${bridges.length} times`);
  } else {
    const rows: [string, string][] = [
      ["mediaE2EEPlatformSupported", BRIDGE_MEDIA_BODY],
      ["nativeKeyPushAvailable", BRIDGE_KEY_PUSH_BODY],
    ];
    for (const [name, want] of rows) {
      const hit = oneMember(m, bridges[0], name);
      if (typeof hit === "string") {
        out.push(`G8 E2EEBridge: ${hit}`);
        continue;
      }
      const at = methodBodyAt(m.code, hit, name);
      const got = at ? norm(m.text.slice(at[0] + 1, at[1])) : "";
      if (got !== want) {
        out.push(
          `G8 line ${lineOf(src, hit)}: ${name}() is \`${got}\`, want \`${want}\``,
        );
      }
    }
  }

  // G9: one source for the platform rules.
  const imported = new Set<string>();
  const from =
    /\bimport\s*\{([^}]*)\}\s*from\s*["']\.\/e2eePlatform(?:\.ts)?["']/g;
  for (const hit of m.text.matchAll(from)) {
    for (const name of hit[1].split(",")) imported.add(squash(name));
  }
  for (const name of PLATFORM_IMPORTS) {
    if (!imported.has(name)) {
      out.push(`G9 ${name} is not imported (unaliased) from ./e2eePlatform`);
    }
  }
  for (const name of PLATFORM_FUNCTIONS) {
    const local = new RegExp(
      `\\b(?:function|const|let|var)\\s+${name}(?![\\w$])`,
    );
    if (local.test(m.code)) out.push(`G9 e2ee.ts defines ${name} itself`);
  }
  return out;
}

// ---- e2ee.ts rules: the protector copy on unverifiable status (F) ----------

const STATUS_TEXT = "Encryptionstatuscouldnotbeverified.";
const STATUS_FALLBACKS = [
  '"Encryptionstatuscouldnotbeverified.ThemessagewasNOTsent."',
  '"Encryptionstatuscouldnotbeverified.Nothingwassent."',
];

function protectorViolations(
  src: string,
  m: Masked,
  expectedSites: number,
): string[] {
  const out: string[] = [];
  let sites = 0;
  for (const hit of m.code.matchAll(/\bnew\s+E2EESendError\s*\(/g)) {
    const paren = hit.index! + hit[0].length - 1;
    const args = items(m, paren);
    if (!args[0]?.includes(STATUS_TEXT)) continue;
    // The nearest catch body, without leaving the function.
    let binding: string | null = null;
    for (const open of enclosingBlocks(m.code, hit.index!).reverse()) {
      binding = catchBinding(m.code, open);
      if (binding !== null || isFunctionBody(m.code, open)) break;
    }
    if (binding === null) continue;
    sites++;
    const line = lineOf(src, hit.index!);
    if (binding === "") {
      out.push(
        `F1 line ${line}: the catch binds no error, so the protector copy` +
          " cannot read it",
      );
      continue;
    }
    const want = new RegExp(
      `^protectorSendErrorCopy\\(${escapeRe(binding)},Capacitor\\.getPlatform\\(\\)\\)\\?\\?(.*)$`,
    );
    const got = want.exec(args[0]);
    if (!got || !STATUS_FALLBACKS.includes(got[1])) {
      out.push(
        `F1 line ${line}: message is \`${args[0]}\`, want` +
          ` protectorSendErrorCopy(${binding}, Capacitor.getPlatform()) ??` +
          " the existing text",
      );
    }
    if (args.length !== 2 || args[1] !== '"native"') {
      out.push(`F1 line ${line}: kind is ${JSON.stringify(args.slice(1))}`);
    }
  }
  if (sites !== expectedSites) {
    out.push(
      `F2 ${sites} unverifiable-status E2EESendError sites in a catch,` +
        ` want ${expectedSites}`,
    );
  }
  return out;
}

function tsViolations(src: string, expectedSites: number): string[] {
  const m = maskTs(src);
  return [
    ...(balanced(m.code) ? [] : ["G0 e2ee.ts does not lex to balanced braces"]),
    ...transportViolations(src, m),
    ...gateViolations(src, m),
    ...protectorViolations(src, m, expectedSites),
  ];
}

// ---- rtc/state.tsx rules (C) ------------------------------------------------

const MEDIA_TERM = "!!bridge?.mediaE2EEPlatformSupported()";

function stateViolations(src: string): string[] {
  const m = maskTs(src);
  const out: string[] = [];
  if (!balanced(m.code)) {
    out.push("C0 state.tsx does not lex to balanced braces");
  }

  // C1: one shared predicate in shellSupported.
  const decls = [...m.code.matchAll(/\bconst\s+shellSupported\s*=/g)];
  if (decls.length !== 1) {
    out.push(`C1 const shellSupported declared ${decls.length} times, want 1`);
  } else {
    const from = decls[0].index! + decls[0][0].length;
    const end = stmtEnd(m.code, from);
    const line = lineOf(src, from);
    if (end < 0) {
      out.push(`C1 line ${line}: shellSupported's initializer has no end`);
    } else {
      for (const op of ["||", "??"]) {
        if (splitTop(m, from, end, op).length > 1) {
          out.push(`C1 line ${line}: a top-level ${op} in shellSupported`);
        }
      }
      const terms = splitTop(m, from, end, "&&");
      if (!terms.includes(MEDIA_TERM)) {
        out.push(
          `C1 line ${line}: no \`${MEDIA_TERM}\` term in` +
            ` ${JSON.stringify(terms)}`,
        );
      }
      const init = squash(m.text.slice(from, end));
      for (const old of [
        "nativeKeyPushAvailable(",
        "platformMediaE2EESupported(",
      ]) {
        if (init.includes(old)) {
          out.push(`C1 line ${line}: shellSupported has its own ${old}) term`);
        }
      }
    }
  }

  // C2: the rule lives in e2eePlatform only.
  if (
    /\b(?:function|const|let|var)\s+platformMediaE2EESupported(?![\w$])/.test(
      m.code,
    )
  ) {
    out.push("C2 state.tsx defines platformMediaE2EESupported itself");
  }
  const reexport =
    /\bexport\s*\{([^}]*)\}\s*from\s*["']\.\.\/client\/e2eePlatform(?:\.ts)?["']/g;
  if (
    ![...m.text.matchAll(reexport)].some((h) =>
      h[1].split(",").map(squash).includes("platformMediaE2EESupported"),
    )
  ) {
    out.push(
      'C2 no export { platformMediaE2EESupported } from "../client/e2eePlatform"',
    );
  }
  return out;
}

// ---- Controller.ts rules (D) ------------------------------------------------

const IOS_CONDITION =
  'Capacitor.isNativePlatform()&&Capacitor.getPlatform()==="ios"';

function controllerViolations(src: string): string[] {
  const m = maskTs(src);
  const out: string[] = [];
  if (!balanced(m.code)) {
    out.push("D0 Controller.ts does not lex to balanced braces");
  }

  // D1
  const imports = /\bimport\s*\{([^}]*)\}\s*from\s*["']@capacitor\/core["']/g;
  if (
    ![...m.text.matchAll(imports)].some((h) =>
      h[1].split(",").map(squash).includes("Capacitor"),
    )
  ) {
    out.push("D1 Controller.ts does not import Capacitor from @capacitor/core");
  }

  // D2
  const names = [...m.text.matchAll(/["'`]Sloga for iOS["'`]/g)];
  const assigns = [
    ...m.text.matchAll(/\bfriendly_name\s*=\s*["'`]Sloga for iOS["'`]\s*;/g),
  ];
  if (names.length !== 1 || assigns.length !== 1) {
    out.push(
      `D2 "Sloga for iOS" appears ${names.length} times, assigned to` +
        ` friendly_name ${assigns.length} times; want 1 and 1`,
    );
    return out;
  }
  const at = assigns[0].index!;
  const line = lineOf(src, at);

  // D3: directly under the iOS-native condition.
  const blocks = enclosingBlocks(m.code, at);
  const inner = blocks[blocks.length - 1] ?? -1;
  const close = inner < 0 ? -1 : skipBack(m.code, inner - 1);
  let thenClose = -1;
  if (close >= 0 && m.code[close] === ")") {
    const open = matchOpen(m.code, close);
    if (
      wordBefore(m.code, open) === "if" &&
      norm(m.text.slice(open + 1, close)) === IOS_CONDITION
    ) {
      thenClose = matchClose(m.code, inner);
    }
  }
  if (thenClose < 0) {
    out.push(
      `D3 line ${line}: "Sloga for iOS" is not assigned directly under` +
        ` if (${IOS_CONDITION})`,
    );
    return out;
  }

  // D4: the web/UA branch comes after it.
  const next = skipWs(m.code, thenClose + 1);
  if (!/^else\s+if\s*\(\s*browser\s*\)/.test(m.code.slice(next, next + 40))) {
    out.push(
      `D4 line ${line}: the iOS branch is not followed by else if (browser),` +
        " so it is not decided before the web/UA name",
    );
  }
  return out;
}

// ---- components/** rules: backup_status gating (E) --------------------------

interface Source {
  path: string;
  src: string;
}

const BACKUP_COMMAND = "e2ee_backup_status";
const ENABLED_DEF =
  /^constenabled=\(\)=>\{const([\w$]+)=[\w$]+\??\.status\.get\("state"\);return!!\1\?\.enabled&&!!\1\?\.published;\};$/;

/** E3 for one `.backupStatus(` call at `at`: a violation, or null. */
function backupGuardViolation(f: Source, m: Masked, at: number): string | null {
  const where = `${f.path}:${lineOf(f.src, at)}`;
  const fns = enclosingBlocks(m.code, at).filter((o) =>
    isFunctionBody(m.code, o),
  );
  if (fns.length === 0) return `E3 ${where}: backupStatus() outside a function`;
  const body = fns[fns.length - 1];
  const first = skipWs(m.code, body + 1);
  const head = /^if\s*\(/.exec(m.code.slice(first, first + 20));
  if (!head) {
    return `E3 ${where}: the enclosing function does not start with an if guard`;
  }
  const paren = first + head[0].length - 1;
  const parenClose = matchClose(m.code, paren);
  if (!/^\s*\{?\s*return\b[^;]*;/.test(m.code.slice(parenClose + 1))) {
    return `E3 ${where}: the first if does not return`;
  }
  const terms = splitTop(m, paren + 1, parenClose, "||");
  if (!terms.includes("!enabled()")) {
    return `E3 ${where}: the guard ${JSON.stringify(terms)} does not test !enabled()`;
  }
  // The nearest `const enabled` declared at the top of an enclosing function.
  for (let k = fns.length - 1; k >= 0; k--) {
    const open = fns[k];
    const close = matchClose(m.code, open);
    const decl = [
      ...m.code.slice(open, close).matchAll(/\bconst\s+enabled\s*=/g),
    ]
      .map((h) => open + h.index!)
      .find((d) => enclosingBlocks(m.code, d).at(-1) === open);
    if (decl === undefined) continue;
    const stmt = norm(m.text.slice(decl, stmtEnd(m.code, decl) + 1));
    return ENABLED_DEF.test(stmt)
      ? null
      : `E3 ${where}: enabled is \`${stmt}\`, not state.enabled && state.published`;
  }
  return `E3 ${where}: no enabled() in scope of the guard`;
}

function backupViolations(files: Source[]): string[] {
  const out: string[] = [];
  const defs: { f: Source; m: Masked; at: number }[] = [];
  const commands: { f: Source; at: number }[] = [];
  let calls = 0;
  for (const f of files) {
    if (!f.src.includes("backupStatus") && !f.src.includes(BACKUP_COMMAND)) {
      continue;
    }
    const m = maskTs(f.src);
    if (!balanced(m.code)) {
      out.push(`E0 ${f.path} does not lex to balanced braces`);
      continue;
    }
    for (const hit of m.text.matchAll(new RegExp(BACKUP_COMMAND, "g"))) {
      commands.push({ f, at: hit.index! });
    }
    for (const hit of m.code.matchAll(/(?<![.\w$#])backupStatus\s*\(/g)) {
      defs.push({ f, m, at: hit.index! });
    }
    for (const hit of m.text.matchAll(/\[\s*["'`]backupStatus["'`]\s*\]/g)) {
      out.push(
        `E3 ${f.path}:${lineOf(f.src, hit.index!)}: backupStatus by bracket access`,
      );
    }
    for (const hit of m.code.matchAll(/\.\s*backupStatus\s*\(/g)) {
      calls++;
      const bad = backupGuardViolation(f, m, hit.index!);
      if (bad) out.push(bad);
    }
  }
  if (calls === 0) out.push("E3 no backupStatus() caller found");

  // E2: the one definition, in client/e2ee.ts.
  const bridgeDefs = defs.filter((d) => d.f.path.endsWith("client/e2ee.ts"));
  if (defs.length !== 1 || bridgeDefs.length !== 1) {
    out.push(
      `E2 backupStatus( defined (or called bare) at` +
        ` ${JSON.stringify(defs.map((d) => `${d.f.path}:${lineOf(d.f.src, d.at)}`))};` +
        " want one definition in client/e2ee.ts",
    );
  }
  const def = bridgeDefs.length === 1 ? bridgeDefs[0] : null;
  const body = def ? methodBodyAt(def.m.code, def.at, "backupStatus") : null;
  if (def && !body) {
    out.push("E2 backupStatus( in client/e2ee.ts is not a method");
  }

  // E1: the command only inside it.
  const inside = commands.filter(
    (c) => body !== null && c.f === def?.f && body[0] < c.at && c.at < body[1],
  );
  if (commands.length !== 1 || inside.length !== 1) {
    out.push(
      `E1 ${BACKUP_COMMAND} at` +
        ` ${JSON.stringify(commands.map((c) => `${c.f.path}:${lineOf(c.f.src, c.at)}`))};` +
        " want once, inside backupStatus()",
    );
  }
  return out;
}

/** Every non-test .ts/.tsx under `root`, path relative with `/`. */
function componentSources(root: string): Source[] {
  const out: Source[] = [];
  for (const file of readdirSync(root, { encoding: "utf8", recursive: true })) {
    const path = file.replaceAll("\\", "/");
    if (!/\.tsx?$/.test(path) || /\.(?:test|spec)\.tsx?$/.test(path)) continue;
    if (path.split("/").includes("node_modules")) continue;
    out.push({ path, src: readFileSync(`${root}/${path}`, "utf8") });
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

interface Mutation {
  label: string;
  swaps: [string, string][];
  rules: string[];
  expected: RegExp;
}

/** A conforming e2ee.ts; it holds two protector sites. */
const TS_FIXTURE = `
import { Capacitor, registerPlugin } from "@capacitor/core";

import {
  capacitorAttachmentUrl,
  capacitorClipboardImageInWebview,
  capacitorNativeE2EE,
  mediaE2EEPlatformSupported,
} from "./e2eePlatform";
import { protectorSendErrorCopy } from "./e2eeProtectorCopy";

// A comment does not count: return Capacitor.getPlatform() === "android";
export function nativeE2EEAvailable(): boolean {
  if (IS_POPOUT_WINDOW || IS_OVERLAY_WINDOW) return false;
  if ((window as { slogaShell?: SlogaShellGlobal }).slogaShell?.e2ee)
    return true;
  return capacitorNativeE2EE(
    Capacitor.isNativePlatform(),
    Capacitor.getPlatform(),
    (name) => Capacitor.isPluginAvailable(name),
  );
}

class ElectronTransport implements NativeTransport {
  readonly nativeBlobTransfer = false;
  readonly clipboardImageInWebview = false;

  attachmentUrl(messageId: string, idx: number): string {
    return "e2ee-att://att/" + messageId + "/" + idx;
  }

  keyPushAvailable(): boolean {
    return true;
  }
}

class CapacitorTransport implements NativeTransport {
  readonly nativeBlobTransfer = true;
  // readonly clipboardImageInWebview = true;
  readonly clipboardImageInWebview = capacitorClipboardImageInWebview(
    Capacitor.getPlatform(),
  );
  #plugin = registerPlugin<E2eeCapacitorPlugin>("E2ee");

  async invoke<T>(command: string): Promise<T> {
    try {
      const { json } = await this.#plugin.call({ __cmd: command });
      return JSON.parse(json) as T;
    } catch (error) {
      this.#rethrow(error);
    }
  }

  attachmentUrl(messageId: string, idx: number): string {
    return capacitorAttachmentUrl(Capacitor.getPlatform(), messageId, idx);
  }

  keyPushAvailable(): boolean {
    // iOS answers false on purpose; never "fix" it to true.
    return (
      Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android"
    );
  }
}

export class E2EEBridge implements E2EEAdapter {
  async sendDm(peerId: string): Promise<void> {
    let verdict: SendModeVerdict;
    try {
      verdict = await this.#invoke<SendModeVerdict>("e2ee_send_mode", {
        peerUserId: peerId,
      });
    } catch (error) {
      throw new E2EESendError(
        protectorSendErrorCopy(error, Capacitor.getPlatform()) ??
          "Encryption status could not be verified. The message was NOT sent.",
        "native",
      );
    }
    const gateError = this.#groupGateError(
      verdict,
      "Encryption status could not be verified. The message was NOT sent.",
    );
    if (gateError) throw gateError;
  }

  async sendGroup(conversationId: string): Promise<void> {
    let mode: SendMode;
    try {
      mode = await this.sendModeNow(conversationId);
    } catch (failure) {
      if (failure) {
        throw new E2EESendError(
          protectorSendErrorCopy(failure, Capacitor.getPlatform()) ??
            "Encryption status could not be verified. Nothing was sent.",
          "native",
        );
      }
      throw failure;
    }
    if (mode === "unknown") {
      throw new E2EESendError(
        "Encryption status could not be verified. Nothing was sent.",
        "native",
      );
    }
  }

  async #prepublishMlsKeyPackages(): Promise<void> {
    // Platform gate first (plan D7).
    if (!this.mediaE2EEPlatformSupported()) return;
    if (!this.#callsEnabled()) return;
    await this.mlsPutKeyPackages(await this.mlsPublishKeyPackages());
  }

  nativeKeyPushAvailable(): boolean {
    return this.#transport.keyPushAvailable();
  }

  mediaE2EEPlatformSupported(): boolean {
    return mediaE2EEPlatformSupported(this.nativeKeyPushAvailable());
  }
}
`;

const TS_FIXTURE_SITES = 2;

const KEY_PUSH_RETURN = `    return (
      Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android"
    );`;
const CLIPBOARD_INIT = `capacitorClipboardImageInWebview(
    Capacitor.getPlatform(),
  )`;
const NATIVE_TAIL = `  return capacitorNativeE2EE(
    Capacitor.isNativePlatform(),
    Capacitor.getPlatform(),
    (name) => Capacitor.isPluginAvailable(name),
  );`;
const BRIDGE_MEDIA_METHOD = `
  mediaE2EEPlatformSupported(): boolean {
    return mediaE2EEPlatformSupported(this.nativeKeyPushAvailable());
  }
`;
const DM_SITE = `    } catch (error) {
      throw new E2EESendError(
        protectorSendErrorCopy(error, Capacitor.getPlatform()) ??
          "Encryption status could not be verified. The message was NOT sent.",`;

const TS_MUTATIONS: Mutation[] = [
  {
    label: "the file does not lex to balanced braces",
    swaps: [
      [
        "this.nativeKeyPushAvailable());\n  }\n}\n",
        "this.nativeKeyPushAvailable());\n  }\n}\n\nconst broken = {\n",
      ],
    ],
    rules: ["G0"],
    expected: /G0 e2ee\.ts does not lex/,
  },
  {
    label: "CapacitorTransport split per platform",
    swaps: [
      [
        "export class E2EEBridge",
        "class CapacitorIosTransport extends CapacitorTransport {}\n\n" +
          "export class E2EEBridge",
      ],
    ],
    rules: ["G1"],
    expected: /CapacitorIosTransport/,
  },
  {
    label: "CapacitorTransport renamed",
    swaps: [["class CapacitorTransport", "class CapacitorAndroidTransport"]],
    rules: ["G1"],
    expected: /0 `class CapacitorTransport`/,
  },
  {
    label: "nativeBlobTransfer computed per platform",
    swaps: [
      [
        "readonly nativeBlobTransfer = true;",
        'readonly nativeBlobTransfer = Capacitor.getPlatform() === "android";',
      ],
    ],
    rules: ["G2"],
    expected: /want readonly nativeBlobTransfer = true/,
  },
  {
    label: "keyPushAvailable widened to every native platform",
    swaps: [
      [
        'Capacitor.getPlatform() === "android"\n    );',
        'Capacitor.getPlatform() !== "web"\n    );',
      ],
    ],
    rules: ["G3"],
    expected: /keyPushAvailable\(\) is/,
  },
  {
    label: "keyPushAvailable 'fixed' to true for iOS",
    swaps: [
      [
        'Capacitor.getPlatform() === "android"\n    );',
        '(Capacitor.getPlatform() === "android" ||\n' +
          '        Capacitor.getPlatform() === "ios")\n    );',
      ],
    ],
    rules: ["G3"],
    expected: /iOS false/,
  },
  {
    label: "keyPushAvailable returns true, the old body left in a comment",
    swaps: [
      [
        KEY_PUSH_RETURN,
        "    // return Capacitor.isNativePlatform() && Capacitor.getPlatform()" +
          ' === "android";\n    return true;',
      ],
    ],
    rules: ["G3"],
    expected: /is `returntrue;`/,
  },
  {
    label: "a second keyPushAvailable member",
    swaps: [
      [
        "  attachmentUrl(messageId: string, idx: number): string {\n" +
          "    return capacitorAttachmentUrl",
        "  keyPushAvailable = () => true;\n\n" +
          "  attachmentUrl(messageId: string, idx: number): string {\n" +
          "    return capacitorAttachmentUrl",
      ],
    ],
    rules: ["G3"],
    expected: /2 top-level `keyPushAvailable` members/,
  },
  {
    label: "clipboardImageInWebview hard-coded true (the 8821aac9 value)",
    swaps: [[CLIPBOARD_INIT, "true"]],
    rules: ["G4"],
    expected: /clipboardImageInWebview=true/,
  },
  {
    label: "clipboardImageInWebview asked for a fixed platform",
    swaps: [[CLIPBOARD_INIT, 'capacitorClipboardImageInWebview("android")']],
    rules: ["G4"],
    expected: /want `readonlyclipboardImageInWebview/,
  },
  {
    label: "attachmentUrl hard-codes the Android path (the 8821aac9 body)",
    swaps: [
      [
        "return capacitorAttachmentUrl(Capacitor.getPlatform(), messageId, idx);",
        'return "/_e2ee-att/" + messageId + "/" + idx;',
      ],
    ],
    rules: ["G5"],
    expected: /hard-coded e2ee-att URL/,
  },
  {
    label: "attachmentUrl asked for a fixed platform",
    swaps: [
      [
        "capacitorAttachmentUrl(Capacitor.getPlatform(), messageId, idx)",
        'capacitorAttachmentUrl("android", messageId, idx)',
      ],
    ],
    rules: ["G5"],
    expected: /attachmentUrl\(\) is/,
  },
  {
    label: "an e2ee-att literal elsewhere in the class",
    swaps: [
      [
        '  #plugin = registerPlugin<E2eeCapacitorPlugin>("E2ee");\n',
        '  #plugin = registerPlugin<E2eeCapacitorPlugin>("E2ee");\n' +
          '  #base = "/_e2ee-att/";\n',
      ],
    ],
    rules: ["G5"],
    expected: /hard-coded e2ee-att URL/,
  },
  {
    label: "nativeE2EEAvailable keeps the Android-only return (8821aac9)",
    swaps: [
      [
        NATIVE_TAIL,
        '  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";',
      ],
    ],
    rules: ["G6"],
    expected: /does not end with return capacitorNativeE2EE/,
  },
  {
    label: "the plugin probe stubbed to true",
    swaps: [["(name) => Capacitor.isPluginAvailable(name),", "() => true,"]],
    rules: ["G6"],
    expected: /does not end with return/,
  },
  {
    label: "an iOS short-circuit before the shared rule",
    swaps: [
      [
        NATIVE_TAIL,
        '  if (Capacitor.getPlatform() === "ios") return true;\n' + NATIVE_TAIL,
      ],
    ],
    rules: ["G6"],
    expected: /compares Capacitor\.getPlatform\(\) itself/,
  },
  {
    label: "the prepublish platform gate removed (8821aac9)",
    swaps: [["    if (!this.mediaE2EEPlatformSupported()) return;\n", ""]],
    rules: ["G7"],
    expected: /does not start with/,
  },
  {
    label: "the prepublish platform gate after the calls toggle",
    swaps: [
      [
        "    if (!this.mediaE2EEPlatformSupported()) return;\n" +
          "    if (!this.#callsEnabled()) return;\n",
        "    if (!this.#callsEnabled()) return;\n" +
          "    if (!this.mediaE2EEPlatformSupported()) return;\n",
      ],
    ],
    rules: ["G7"],
    expected: /does not start with/,
  },
  {
    label: "the prepublish platform gate only in a comment",
    swaps: [
      [
        "    if (!this.mediaE2EEPlatformSupported()) return;\n",
        "    // if (!this.mediaE2EEPlatformSupported()) return;\n",
      ],
    ],
    rules: ["G7"],
    expected: /does not start with/,
  },
  {
    label: "the prepublish gated on key push alone (MINOR 17)",
    swaps: [
      [
        "if (!this.mediaE2EEPlatformSupported()) return;",
        "if (!this.nativeKeyPushAvailable()) return;",
      ],
    ],
    rules: ["G7"],
    expected: /does not start with/,
  },
  {
    label: "the calls toggle dropped from the prepublish",
    swaps: [["    if (!this.#callsEnabled()) return;\n", ""]],
    rules: ["G7"],
    expected: /lost if \(!this\.#callsEnabled/,
  },
  {
    label: "the bridge predicate reads key push alone",
    swaps: [
      [
        "return mediaE2EEPlatformSupported(this.nativeKeyPushAvailable());",
        "return this.nativeKeyPushAvailable();",
      ],
    ],
    rules: ["G8"],
    expected: /mediaE2EEPlatformSupported\(\) is/,
  },
  {
    label: "the bridge predicate passes a constant",
    swaps: [
      [
        "mediaE2EEPlatformSupported(this.nativeKeyPushAvailable());",
        "mediaE2EEPlatformSupported(true);",
      ],
    ],
    rules: ["G8"],
    expected: /mediaE2EEPlatformSupported\(\) is/,
  },
  {
    label: "the bridge key push no longer asks the transport",
    swaps: [["return this.#transport.keyPushAvailable();", "return true;"]],
    rules: ["G8"],
    expected: /nativeKeyPushAvailable\(\) is/,
  },
  {
    label: "the bridge predicate missing (8821aac9)",
    swaps: [[BRIDGE_MEDIA_METHOD, ""]],
    rules: ["G8"],
    expected: /0 top-level `mediaE2EEPlatformSupported` members/,
  },
  {
    label: "the media predicate no longer imported",
    swaps: [
      [
        '  mediaE2EEPlatformSupported,\n} from "./e2eePlatform";',
        '} from "./e2eePlatform";',
      ],
    ],
    rules: ["G9"],
    expected: /mediaE2EEPlatformSupported is not imported/,
  },
  {
    label: "the media predicate imported under another name",
    swaps: [
      [
        '  mediaE2EEPlatformSupported,\n} from "./e2eePlatform";',
        '  mediaE2EEPlatformSupported as mediaGate,\n} from "./e2eePlatform";',
      ],
    ],
    rules: ["G9"],
    expected: /mediaE2EEPlatformSupported is not imported/,
  },
  {
    label: "a local copy of a platform rule",
    swaps: [
      [
        "class ElectronTransport implements NativeTransport {",
        "function platformMediaE2EESupported(): boolean {\n  return true;\n}\n\n" +
          "class ElectronTransport implements NativeTransport {",
      ],
    ],
    rules: ["G9"],
    expected: /defines platformMediaE2EESupported itself/,
  },
  {
    label: "a catch that binds nothing (the 8821aac9 shape)",
    swaps: [
      [
        DM_SITE,
        "    } catch {\n      throw new E2EESendError(\n" +
          '        "Encryption status could not be verified. The message was NOT sent.",',
      ],
    ],
    rules: ["F1"],
    expected: /binds no error/,
  },
  {
    label: "the protector copy reads something other than the caught error",
    swaps: [
      [
        "protectorSendErrorCopy(failure, Capacitor.getPlatform())",
        "protectorSendErrorCopy(this.#lastError, Capacitor.getPlatform())",
      ],
    ],
    rules: ["F1"],
    expected: /want protectorSendErrorCopy\(failure/,
  },
  {
    label: "the protector copy asked for a fixed platform",
    swaps: [
      [
        "protectorSendErrorCopy(error, Capacitor.getPlatform())",
        'protectorSendErrorCopy(error, "ios")',
      ],
    ],
    rules: ["F1"],
    expected: /want protectorSendErrorCopy\(error/,
  },
  {
    label: "the old text tried first",
    swaps: [
      [
        "        protectorSendErrorCopy(error, Capacitor.getPlatform()) ??\n" +
          '          "Encryption status could not be verified. The message was NOT sent.",',
        '        "Encryption status could not be verified. The message was NOT sent." ||\n' +
          "          protectorSendErrorCopy(error, Capacitor.getPlatform()),",
      ],
    ],
    rules: ["F1"],
    expected: /want protectorSendErrorCopy/,
  },
  {
    label: "the fallback text changed",
    swaps: [
      [
        '            "Encryption status could not be verified. Nothing was sent.",',
        '            "Encryption status could not be verified. Try again.",',
      ],
    ],
    rules: ["F1"],
    expected: /the existing text/,
  },
  {
    label: "the kind changed",
    swaps: [
      [
        '          "native",\n        );\n      }\n      throw failure;',
        '          "transport",\n        );\n      }\n      throw failure;',
      ],
    ],
    rules: ["F1"],
    expected: /kind is \["\\"transport\\""\]/,
  },
  {
    label: "a site moved out of its catch",
    swaps: [
      [
        "    } catch (failure) {\n      if (failure) {",
        "    } catch (failure) {\n      void failure;\n    }\n    {\n      if (failure) {",
      ],
    ],
    rules: ["F2"],
    expected: /1 unverifiable-status E2EESendError sites in a catch, want 2/,
  },
  {
    label: "a new unwired site",
    swaps: [
      [
        "    if (gateError) throw gateError;\n",
        "    if (gateError) throw gateError;\n    try {\n      await this.#recheck();\n" +
          "    } catch (again) {\n      throw new E2EESendError(\n" +
          '        "Encryption status could not be verified. Nothing was sent.",\n' +
          '        "native",\n      );\n    }\n',
      ],
    ],
    rules: ["F1", "F2"],
    expected: /F1 .*want protectorSendErrorCopy\(again/,
  },
];

/** A conforming rtc/state.tsx excerpt. */
const STATE_FIXTURE = `
import { nativeE2EEAvailable, type E2EEBridge } from "../client/e2ee";

export { platformMediaE2EESupported } from "../client/e2eePlatform";

class Voice {
  #connect() {
    const bridge = this.getClient()?.e2ee as E2EEBridge | undefined;
    bridge?.setCallsEnabled(() => this.#settings.e2eeCallsEnabled);
    const shellSupported =
      isE2EESupported() &&
      nativeE2EEAvailable() &&
      // !!bridge?.nativeKeyPushAvailable() in a comment does not count
      !!bridge?.mediaE2EEPlatformSupported() &&
      this.#settings.e2eeCallsEnabled;
    return <Chip>{shellSupported ? "on" : <Trans>Calls aren't encrypted</Trans>}</Chip>;
  }
}
`;

const STATE_MUTATIONS: Mutation[] = [
  {
    label: "the file does not lex to balanced braces",
    swaps: [
      [
        'export { platformMediaE2EESupported } from "../client/e2eePlatform";\n',
        'export { platformMediaE2EESupported } from "../client/e2eePlatform";\n' +
          "const broken = {\n",
      ],
    ],
    rules: ["C0"],
    expected: /C0 state\.tsx does not lex/,
  },
  {
    label: "the two-term shellSupported (8821aac9)",
    swaps: [
      [
        "      !!bridge?.mediaE2EEPlatformSupported() &&\n",
        "      !!bridge?.nativeKeyPushAvailable() &&\n" +
          "      platformMediaE2EESupported() &&\n",
      ],
    ],
    rules: ["C1"],
    expected: /no `!!bridge\?\.mediaE2EEPlatformSupported\(\)` term/,
  },
  {
    label: "a separate platform term beside the shared one",
    swaps: [
      [
        "      !!bridge?.mediaE2EEPlatformSupported() &&\n",
        "      !!bridge?.mediaE2EEPlatformSupported() &&\n" +
          "      platformMediaE2EESupported() &&\n",
      ],
    ],
    rules: ["C1"],
    expected: /own platformMediaE2EESupported\(\) term/,
  },
  {
    label: "a top-level || in shellSupported",
    swaps: [
      ["      nativeE2EEAvailable() &&\n", "      nativeE2EEAvailable() ||\n"],
    ],
    rules: ["C1"],
    expected: /top-level \|\|/,
  },
  {
    label: "the shared term negated",
    swaps: [
      [
        "      !!bridge?.mediaE2EEPlatformSupported() &&\n",
        "      !bridge?.mediaE2EEPlatformSupported() &&\n",
      ],
    ],
    rules: ["C1"],
    expected: /no `!!bridge/,
  },
  {
    label: "the shared term only in a comment",
    swaps: [
      [
        "      !!bridge?.mediaE2EEPlatformSupported() &&\n",
        "      // !!bridge?.mediaE2EEPlatformSupported() &&\n",
      ],
    ],
    rules: ["C1"],
    expected: /no `!!bridge/,
  },
  {
    label: "a local platformMediaE2EESupported again (8821aac9)",
    swaps: [
      [
        'export { platformMediaE2EESupported } from "../client/e2eePlatform";',
        "export function platformMediaE2EESupported(): boolean {\n" +
          '  return !("slogaShell" in window);\n}',
      ],
    ],
    rules: ["C2"],
    expected: /defines platformMediaE2EESupported itself/,
  },
  {
    label: "the re-export dropped",
    swaps: [
      [
        'export { platformMediaE2EESupported } from "../client/e2eePlatform";',
        "",
      ],
    ],
    rules: ["C2"],
    expected: /no export \{ platformMediaE2EESupported \}/,
  },
];

/** A conforming Controller.ts login excerpt. */
const CONTROLLER_FIXTURE = `
import { Capacitor } from "@capacitor/core";
import { detect } from "detect-browser";

export default class ClientController {
  async login(credentials: API.DataLogin, modals: ModalControllerExtended) {
    const browser = detect();
    let friendly_name;
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios") {
      // A native shell, not a browser.
      friendly_name = "Sloga for iOS";
    } else if (browser) {
      const { name, os } = browser as { name: string; os: string };
      friendly_name = "Sloga for Web (" + name + " on " + os + ")";
    } else {
      friendly_name = "Sloga for Web (Unknown Device)";
    }
    await this.completeLoginResponse(credentials, modals, friendly_name);
  }
}
`;

const IOS_BRANCH = `    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios") {
      // A native shell, not a browser.
      friendly_name = "Sloga for iOS";
    } else if (browser) {`;

const CONTROLLER_MUTATIONS: Mutation[] = [
  {
    label: "the file does not lex to balanced braces",
    swaps: [
      [
        'import { detect } from "detect-browser";\n',
        'import { detect } from "detect-browser";\nconst broken = {\n',
      ],
    ],
    rules: ["D0"],
    expected: /D0 Controller\.ts does not lex/,
  },
  {
    label: "Capacitor not imported (8821aac9)",
    swaps: [['import { Capacitor } from "@capacitor/core";\n', ""]],
    rules: ["D1"],
    expected: /does not import Capacitor/,
  },
  {
    label: "the iOS name changed to a web name",
    swaps: [['"Sloga for iOS"', '"Sloga for Web (iOS)"']],
    rules: ["D2"],
    expected: /appears 0 times/,
  },
  {
    label: "the name gated on the wrong platform",
    swaps: [
      [
        'Capacitor.getPlatform() === "ios"',
        'Capacitor.getPlatform() === "android"',
      ],
    ],
    rules: ["D3"],
    expected: /not assigned directly under/,
  },
  {
    label: "the name gated on the UA string instead of the native platform",
    swaps: [
      [
        'if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios") {',
        'if (Capacitor.isNativePlatform() && browser?.os === "iOS") {',
      ],
    ],
    rules: ["D3"],
    expected: /not assigned directly under/,
  },
  {
    label: "the name assigned in a nested block",
    swaps: [
      [
        '      friendly_name = "Sloga for iOS";\n',
        '      if (modals) {\n        friendly_name = "Sloga for iOS";\n      }\n',
      ],
    ],
    rules: ["D3"],
    expected: /not assigned directly under/,
  },
  {
    label: "the UA branch decided first",
    swaps: [
      [
        IOS_BRANCH,
        "    if (browser) {\n      friendly_name = String(browser);\n" +
          '    } else if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios") {\n' +
          '      friendly_name = "Sloga for iOS";\n    } else if (modals) {',
      ],
    ],
    rules: ["D4"],
    expected: /not followed by else if \(browser\)/,
  },
];

/** A conforming components tree: the bridge and the settings card. */
const BACKUP_BRIDGE = `
export class E2EEBridge {
  /** Backup status (\`e2ee_backup_status\` in a comment does not count). */
  async backupStatus(): Promise<BackupStatusView> {
    const local = await this.#invoke<{ exists: boolean }>("e2ee_backup_status");
    return { local };
  }
}
`;

const BACKUP_CARD = `
function EncryptionCard() {
  const e2ee = useE2EE();
  const enabled = () => !!e2ee?.status.get("state")?.enabled;
  return (
    <CategoryButton>
      {enabled() ? <Trans>It's on</Trans> : <Trans>Calls aren't here</Trans>}
    </CategoryButton>
  );
}

function RecoveryBackupCard() {
  const e2ee = useE2EE();
  if (!e2ee) return null;

  const enabled = () => {
    const state = e2ee.status.get("state");
    return !!state?.enabled && !!state?.published;
  };

  const [status, setStatus] = createSignal<BackupStatusView | undefined>();

  async function reload() {
    if (!e2ee || !enabled()) return;
    try {
      setStatus(await e2ee.backupStatus());
    } catch (error) {
      console.error("[e2ee] backup status failed", error);
    }
  }

  onMount(reload);
  return <div>{status()?.exists ? <Trans>Backed up</Trans> : null}</div>;
}
`;

const BRIDGE_PATH = "client/e2ee.ts";
const CARD_PATH = "app/interface/settings/user/Encryption.tsx";

function backupFixture(
  bridgeSwaps: [string, string][],
  cardSwaps: [string, string][],
): Source[] {
  return [
    { path: BRIDGE_PATH, src: swapped(BACKUP_BRIDGE, bridgeSwaps) },
    { path: CARD_PATH, src: swapped(BACKUP_CARD, cardSwaps) },
  ];
}

const BACKUP_MUTATIONS: (Mutation & { bridge?: boolean })[] = [
  {
    label: "the guard no longer tests enabled()",
    swaps: [
      ["    if (!e2ee || !enabled()) return;\n", "    if (!e2ee) return;\n"],
    ],
    rules: ["E3"],
    expected: /does not test !enabled\(\)/,
  },
  {
    label: "the guard only in a comment",
    swaps: [
      [
        "    if (!e2ee || !enabled()) return;\n",
        "    // if (!e2ee || !enabled()) return;\n",
      ],
    ],
    rules: ["E3"],
    expected: /does not start with an if guard/,
  },
  {
    label: "the guard after the call",
    swaps: [
      ["    if (!e2ee || !enabled()) return;\n    try {\n", "    try {\n"],
      [
        '      console.error("[e2ee] backup status failed", error);\n    }\n',
        '      console.error("[e2ee] backup status failed", error);\n    }\n' +
          "    if (!e2ee || !enabled()) return;\n",
      ],
    ],
    rules: ["E3"],
    expected: /does not start with an if guard/,
  },
  {
    label: "the guard does not return",
    swaps: [
      [
        "    if (!e2ee || !enabled()) return;\n",
        '    if (!e2ee || !enabled()) console.warn("off");\n',
      ],
    ],
    rules: ["E3"],
    expected: /does not return/,
  },
  {
    label: "enabled() no longer requires published",
    swaps: [
      [
        "    return !!state?.enabled && !!state?.published;\n",
        "    return !!state?.enabled;\n",
      ],
    ],
    rules: ["E3"],
    expected: /not state\.enabled && state\.published/,
  },
  {
    label: "only a non-enclosing enabled() left in the file",
    swaps: [
      [
        '  const enabled = () => {\n    const state = e2ee.status.get("state");\n' +
          "    return !!state?.enabled && !!state?.published;\n  };\n",
        "",
      ],
    ],
    rules: ["E3"],
    expected: /no enabled\(\) in scope/,
  },
  {
    label: "an unguarded second caller",
    swaps: [
      [
        "  onMount(reload);\n",
        "  onMount(reload);\n  onMount(async () => setStatus(await e2ee.backupStatus()));\n",
      ],
    ],
    rules: ["E3"],
    expected: /does not start with an if guard/,
  },
  {
    label: "a caller by bracket access",
    swaps: [
      [
        "  onMount(reload);\n",
        '  onMount(reload);\n  void e2ee["backupStatus"]();\n',
      ],
    ],
    rules: ["E3"],
    expected: /bracket access/,
  },
  {
    label: "no caller at all",
    swaps: [["      setStatus(await e2ee.backupStatus());\n", ""]],
    rules: ["E3"],
    expected: /no backupStatus\(\) caller found/,
  },
  {
    label: "the command invoked directly from the card",
    swaps: [
      [
        "  onMount(reload);\n",
        '  onMount(reload);\n  void invoke("e2ee_backup_status");\n',
      ],
    ],
    rules: ["E1"],
    expected: /E1 e2ee_backup_status at .*Encryption\.tsx/,
  },
  {
    label: "the command held outside backupStatus()",
    bridge: true,
    swaps: [
      [
        'this.#invoke<{ exists: boolean }>("e2ee_backup_status")',
        "this.#invoke<{ exists: boolean }>(BACKUP)",
      ],
      [
        "export class E2EEBridge {",
        'const BACKUP = "e2ee_backup_status";\n\nexport class E2EEBridge {',
      ],
    ],
    rules: ["E1"],
    expected: /want once, inside backupStatus\(\)/,
  },
  {
    label: "a second backupStatus definition",
    swaps: [
      [
        "function RecoveryBackupCard() {",
        "async function backupStatus() {\n  return null;\n}\n\n" +
          "function RecoveryBackupCard() {",
      ],
    ],
    rules: ["E2"],
    expected: /want one definition in client\/e2ee\.ts/,
  },
  {
    label: "the card does not lex to balanced braces",
    swaps: [
      ["  onMount(reload);\n", "  onMount(reload);\n  const broken = {\n"],
    ],
    rules: ["E0", "E1", "E2", "E3"],
    expected: /E0 .*Encryption\.tsx does not lex/,
  },
];

test("fixture: the conforming e2ee.ts passes", () => {
  assert.deepEqual(tsViolations(TS_FIXTURE, TS_FIXTURE_SITES), []);
});

test("fixture: the conforming state.tsx passes", () => {
  assert.deepEqual(stateViolations(STATE_FIXTURE), []);
});

test("fixture: the conforming Controller.ts passes", () => {
  assert.deepEqual(controllerViolations(CONTROLLER_FIXTURE), []);
});

test("fixture: the conforming backup_status callers pass", () => {
  assert.deepEqual(backupViolations(backupFixture([], [])), []);
});

for (const { label, swaps, rules, expected } of TS_MUTATIONS) {
  test(`fixture mutation (e2ee.ts): ${label}`, () => {
    assertOnly(
      label,
      tsViolations(swapped(TS_FIXTURE, swaps), TS_FIXTURE_SITES),
      rules,
      expected,
    );
  });
}

for (const { label, swaps, rules, expected } of STATE_MUTATIONS) {
  test(`fixture mutation (state.tsx): ${label}`, () => {
    assertOnly(
      label,
      stateViolations(swapped(STATE_FIXTURE, swaps)),
      rules,
      expected,
    );
  });
}

for (const { label, swaps, rules, expected } of CONTROLLER_MUTATIONS) {
  test(`fixture mutation (Controller.ts): ${label}`, () => {
    assertOnly(
      label,
      controllerViolations(swapped(CONTROLLER_FIXTURE, swaps)),
      rules,
      expected,
    );
  });
}

for (const { label, swaps, rules, expected, bridge } of BACKUP_MUTATIONS) {
  test(`fixture mutation (backup_status): ${label}`, () => {
    const files = bridge ? backupFixture(swaps, []) : backupFixture([], swaps);
    assertOnly(label, backupViolations(files), rules, expected);
  });
}

// ---- F. Behavior: the protector copy never offers a wipe ---------------------

test("protector copy: both tags give non-null copy that never offers wipe, reset, turn off or restore", () => {
  const forbidden =
    /wipe|reset|turn\s*off|disable|restore|recover|back\s*up|delete|erase/i;
  for (const type of ["protector", "protector_locked"]) {
    for (const platform of ["ios", "android", "web", "electron", ""]) {
      const copy = protectorSendErrorCopy({ type }, platform);
      assert.ok(copy, `${type}/${platform}: no copy`);
      assert.doesNotMatch(copy, forbidden, `${type}/${platform}`);
    }
  }
  assert.equal(protectorSendErrorCopy({ type: "storage" }, "ios"), null);
});

// ---- The real sources -------------------------------------------------------

const ruleFilter = (found: string[], rules: string[]) =>
  found.filter((v) => rules.includes(ruleOf(v)));

const realTs = () =>
  tsViolations(readFileSync(TS_FILE, "utf8"), PROTECTOR_SITES);

test("e2ee.ts: CapacitorTransport is one class, moves blobs natively, and keeps keyPushAvailable android-only (iOS false)", () => {
  assert.deepEqual(ruleFilter(realTs(), ["G1", "G2", "G3"]), []);
});

test("e2ee.ts: the iOS clipboard and attachment URL come from e2eePlatform", () => {
  assert.deepEqual(ruleFilter(realTs(), ["G4", "G5"]), []);
});

test("e2ee.ts: nativeE2EEAvailable leaves Capacitor to capacitorNativeE2EE with the plugin probe", () => {
  assert.deepEqual(ruleFilter(realTs(), ["G6"]), []);
});

test("e2ee.ts: the KeyPackage prepublish is skipped first on a shell without the media predicate", () => {
  assert.deepEqual(ruleFilter(realTs(), ["G7", "G8"]), []);
});

test("e2ee.ts: the platform rules have one source, e2eePlatform", () => {
  assert.deepEqual(ruleFilter(realTs(), ["G9"]), []);
});

test(`e2ee.ts: all ${PROTECTOR_SITES} unverifiable-status catches try the protector copy first`, () => {
  assert.deepEqual(ruleFilter(realTs(), ["F1", "F2"]), []);
});

test("e2ee.ts: the whole scan is clean (G0-G9, F1-F2; G0 = it lexed)", () => {
  assert.deepEqual(realTs(), []);
});

test("state.tsx: shellSupported uses the one shared predicate, defined only in e2eePlatform", () => {
  assert.deepEqual(stateViolations(readFileSync(STATE_FILE, "utf8")), []);
});

test("Controller.ts: an iOS native login is named Sloga for iOS, decided before the web/UA name", () => {
  assert.deepEqual(
    controllerViolations(readFileSync(CONTROLLER_FILE, "utf8")),
    [],
  );
});

test("components: e2ee_backup_status is reached only behind enabled && published", () => {
  const files = componentSources(COMPONENTS_DIR);
  assert.ok(
    files.length > 50,
    `only ${files.length} sources under ${COMPONENTS_DIR}`,
  );
  assert.deepEqual(backupViolations(files), []);
});

test("iOS: shellSupported and the KeyPackage prepublish both read false (the D7 chain)", () => {
  // keyPushAvailable() is android-only (G3), the bridge feeds it into the
  // one predicate (G8, G9), shellSupported and the prepublish both use that
  // predicate (C1, G7), and on an iOS window it is false for a false key push.
  const chain = [
    ...ruleFilter(realTs(), ["G3", "G7", "G8", "G9"]),
    ...stateViolations(readFileSync(STATE_FILE, "utf8")).filter(
      (v) => ruleOf(v) === "C1",
    ),
  ];
  assert.deepEqual(chain, []);
  withWindow({}, () => {
    assert.equal(mediaE2EEPlatformSupported(false), false);
  });
});
