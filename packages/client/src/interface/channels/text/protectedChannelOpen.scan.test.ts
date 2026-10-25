// Source-scan spec for the Protected channel open/refresh lifecycle mount
// (W4 lane C17, plan D8 and D27, product choice 7). `TextChannel.tsx` cannot
// load under Node (Solid, lingui, stoat.js), so this reads it as text and
// pins:
//
//  O1  `TextChannel.tsx` calls `useProtectedChannelOpen(` exactly once, with
//      the reactive `() => props.channel` accessor, imported from the B6
//      module;
//  O2  the call sits in the setup of `TextChannel` itself, at the top level
//      of its body (not in a nested function, effect, the JSX or
//      `ThreadBanner`), before the returned view;
//  O3  no file under `components/chatWindows/` calls it (chat windows are
//      read-only);
//  O4  no other client source file calls it (one mount, not one per view;
//      the pins and search sidebar included).
//
// Run: node --test --conditions=browser \
//   src/interface/channels/text/protectedChannelOpen.scan.test.ts
// `PROTECTED_TEXTCHANNEL_TSX=<path>` scans another copy of TextChannel.tsx,
// `PROTECTED_CHATWINDOWS_DIR=<dir>` another chat windows tree (named
// controls C-C17a/b/c).

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CLIENT_ROOT = resolve(HERE, "../../../..");
const TEXT_CHANNEL_PATH = resolve(HERE, "TextChannel.tsx");
const HOOK_PATH = resolve(
  CLIENT_ROOT,
  "components/client/useProtectedChannel.ts",
);

const TEXT_CHANNEL = readFileSync(
  process.env.PROTECTED_TEXTCHANNEL_TSX || TEXT_CHANNEL_PATH,
  "utf8",
);
const CHAT_WINDOWS_DIR =
  process.env.PROTECTED_CHATWINDOWS_DIR ||
  resolve(CLIENT_ROOT, "components/chatWindows");

const CALL = /\buseProtectedChannelOpen\s*\(/g;

// ---- Source helpers ---------------------------------------------------------

/** Drop comments (block and whole-line) so prose never counts as a call. */
function code(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function callCount(src: string): number {
  return (code(src).match(CALL) ?? []).length;
}

/**
 * Index just past the closer matching the opener at `open`, skipping
 * strings, template literals and comments (good enough for this file).
 */
function matchPair(src: string, open: number, a = "{", b = "}"): number {
  assert.equal(src[open], a, `matchPair: not at ${a}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      i = src.indexOf("\n", i);
      if (i < 0) return src.length;
      continue;
    }
    if (c === "/" && n === "*") {
      i = src.indexOf("*/", i + 2) + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) {
        if (src[i] === "\\") i++;
      }
      continue;
    }
    if (c === a) depth++;
    if (c === b) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  assert.fail(`matchPair: unbalanced ${a}${b}`);
}

/** Every .ts / .tsx source under `dir` (no specs, no build output). */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "catalogs") {
      continue;
    }
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...sources(path));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

// ---- O1 ---------------------------------------------------------------------

test("O1 TextChannel calls useProtectedChannelOpen exactly once", () => {
  assert.equal(
    callCount(TEXT_CHANNEL),
    1,
    "TextChannel.tsx must call useProtectedChannelOpen( exactly once",
  );
  assert.match(
    code(TEXT_CHANNEL),
    /\buseProtectedChannelOpen\(\(\) => props\.channel\);/,
    "the hook must get the reactive () => props.channel accessor",
  );
  assert.match(
    TEXT_CHANNEL,
    /^import \{ useProtectedChannelOpen \} from "@revolt\/client\/useProtectedChannel";$/m,
  );
});

// ---- O2 ---------------------------------------------------------------------

test("O2 the call is top-level setup of TextChannel, before the view", () => {
  const header = "export function TextChannel(props: ChannelPageProps) {";
  const at = TEXT_CHANNEL.indexOf(header);
  assert.ok(at >= 0, `missing ${header}`);
  const open = at + header.length - 1;
  const close = matchPair(TEXT_CHANNEL, open);
  const body = TEXT_CHANNEL.slice(open + 1, close - 1);

  const call = code(body).search(CALL);
  assert.ok(call >= 0, "the call is not inside TextChannel");
  // Depth of the call within the (comment-free) body: 0 = top level.
  const flat = code(body);
  let depth = 0;
  for (let i = 0; i < call; i++) {
    const c = flat[i];
    if (c === "{" || c === "(" || c === "[") depth++;
    if (c === "}" || c === ")" || c === "]") depth--;
  }
  assert.equal(depth, 0, "the call must be at the top level of TextChannel");
  const view = flat.search(/^ {2}return \(/m);
  assert.ok(view > call, "the call must come before the returned view");
});

// ---- O3 ---------------------------------------------------------------------

test("O3 no chat window file calls useProtectedChannelOpen", () => {
  const files = sources(CHAT_WINDOWS_DIR);
  assert.ok(files.length > 0, `no sources under ${CHAT_WINDOWS_DIR}`);
  for (const file of files) {
    assert.equal(
      callCount(readFileSync(file, "utf8")),
      0,
      `${file} mounts the open lifecycle (chat windows are read-only)`,
    );
  }
});

// ---- O4 ---------------------------------------------------------------------

test("O4 no other client source calls useProtectedChannelOpen", () => {
  const files = [
    ...sources(resolve(CLIENT_ROOT, "components")),
    ...sources(resolve(CLIENT_ROOT, "src")),
  ].filter((f) => f !== TEXT_CHANNEL_PATH && f !== HOOK_PATH);
  assert.ok(files.length > 100, `only ${files.length} client sources found`);
  const callers = files.filter((f) => callCount(readFileSync(f, "utf8")) > 0);
  assert.deepEqual(callers, [], "useProtectedChannelOpen mounted elsewhere");
  // The definition is where the spec expects it (a renamed hook would make
  // O1-O4 vacuous).
  assert.match(
    readFileSync(HOOK_PATH, "utf8"),
    /export function useProtectedChannelOpen\(/,
  );
});
