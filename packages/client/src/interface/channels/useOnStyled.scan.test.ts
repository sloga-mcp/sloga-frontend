// Source scan: no Solid directive (`use:floating`, `use:autoComplete`, ...)
// on a Panda `styled()` component, anywhere in packages/client.
//
// Solid compiles `use:X` into a directive call ONLY on a native element. On a
// component it becomes a plain `"use:X"` prop, which a styled() component
// spreads as a junk attribute: no error, no warning, and the menu, tooltip
// or panel never opens. tsc, eslint and review all pass it (the Home card
// menu, 2026-10-26, and the Protected channel pill, S1 final audit F1).
// Components that forward directives through `// @codegen directives`
// (Button, IconButton) are not styled() identifiers, so they never match.
//
// Rule: in each .tsx file, a JSX element whose tag is an identifier defined
// in that same file by `= styled(` / `= styled.x`, or a `<styled.x>` tag,
// must not carry a `use:` attribute.
//
// Run: node --test --conditions=browser \
//   src/interface/channels/useOnStyled.scan.test.ts
// `USE_ON_STYLED_ROOT=<dir>` scans another tree instead (named control).

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CLIENT_ROOT = resolve(HERE, "../../..");
const ROOT = process.env.USE_ON_STYLED_ROOT || CLIENT_ROOT;

/**
 * Known existing cases, `<path relative to ROOT>:<tag>`. Both are fixed by
 * FE a5f0ab37 (`fix/home-card-menu`, queued, not yet on main). An entry
 * that no longer matches is only reported (a test diagnostic), so landing
 * that fix never turns this spec red; remove the entries then.
 */
const ALLOWLIST: readonly string[] = [
  "components/app/interface/settings/channel/ForumSettings.tsx:EmojiButton",
  "src/interface/home/HomeBlock.tsx:ControlButton",
];

const SKIP_DIRS = new Set([
  "node_modules",
  "styled-system",
  "dist",
  "android",
  "ios",
  "public",
  ".git",
]);

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) tsxFiles(path, out);
    else if (name.endsWith(".tsx")) out.push(path);
  }
  return out;
}

/** Drop block and whole-line comments (prose may mention `use:`). */
function code(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Identifiers this file defines through `styled(` or `styled.x`. */
export function styledIdents(src: string): Set<string> {
  const out = new Set<string>();
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*styled\s*[(.<]/g;
  for (const m of src.matchAll(re)) out.add(m[1]);
  return out;
}

/**
 * The attribute text of the JSX opening tag that starts at `from` (just past
 * the tag name), at brace depth 0 only, up to its closing `>`.
 */
function attrsAtDepth0(src: string, from: number): string {
  let depth = 0;
  let quote: string | null = null;
  let top = "";
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) return top;
    else if (depth === 0) top += ch;
  }
  return top;
}

export interface Hit {
  file: string;
  tag: string;
  line: number;
  directive: string;
}

/** Every `use:` attribute on a styled() tag in one file's source. */
export function scanSource(file: string, raw: string): Hit[] {
  const src = code(raw);
  const styled = styledIdents(src);
  const hits: Hit[] = [];
  for (const m of src.matchAll(/<([A-Za-z_$][\w$]*(?:\.[\w$]+)?)(?=[\s/>])/g)) {
    const tag = m[1];
    if (!styled.has(tag) && !/^styled\.[\w$]+$/.test(tag)) continue;
    const attrs = attrsAtDepth0(src, m.index! + m[0].length);
    const d = attrs.match(/(?:^|\s)(use:[A-Za-z_$][\w$]*)/);
    if (!d) continue;
    hits.push({
      file,
      tag,
      line: src.slice(0, m.index).split("\n").length,
      directive: d[1],
    });
  }
  return hits;
}

describe("use: directives never sit on a styled() component", () => {
  it("the matcher catches a known-bad snippet and passes a native one", () => {
    const bad = [
      'const Pill = styled("button", { base: {} });',
      'const x = <Pill type="button" use:floating={{ contextMenu: () => <div /> }}>a</Pill>;',
      'const y = <styled.span use:floating={{ tooltip: { content: "a" } }} />;',
    ].join("\n");
    const good = [
      'const Pill = styled("button", { base: {} });',
      'const x = <button class={c} use:floating={{ contextMenu: () => <Pill a="use:x" /> }}>a</button>;',
      "const y = <Pill title={`use:floating`} onClick={() => 1 > 0} />;",
    ].join("\n");
    assert.deepEqual(
      scanSource("bad.tsx", bad).map((h) => `${h.tag}:${h.directive}`),
      ["Pill:use:floating", "styled.span:use:floating"],
    );
    assert.deepEqual(scanSource("good.tsx", good), []);
  });

  it("no hit across packages/client (outside the allowlist)", (t) => {
    const files = tsxFiles(ROOT);
    assert.ok(files.length > 0, `no .tsx files under ${ROOT} (vacuous)`);
    const hits = files.flatMap((f) =>
      scanSource(relative(ROOT, f), readFileSync(f, "utf8")),
    );
    const found = hits.map((h) => `${h.file}:${h.tag}`);
    const unexpected = hits.filter(
      (h) => !ALLOWLIST.includes(`${h.file}:${h.tag}`),
    );
    assert.deepEqual(
      unexpected.map((h) => `${h.file}:${h.line} <${h.tag} ${h.directive}>`),
      [],
    );
    for (const entry of ALLOWLIST) {
      if (!found.includes(entry))
        t.diagnostic(`stale allowlist entry ${entry}`);
    }
  });
});
