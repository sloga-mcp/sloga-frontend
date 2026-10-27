// Source-scan spec for search and the pinned listing on Protected channels
// (W4 lane C15, plan D22/D25, design 7.4/7.5). `TextSearchSidebar.tsx`
// cannot load under Node (Solid, lingui, stoat.js), so this reads it as text
// and pins:
//
//  S1  the guard predicate blocks a text query (any `query`, even empty) on a
//      Protected channel and nothing else: the pinned listing (no `query`)
//      and every non-protected search pass (evaluated, not just matched);
//  S2  the query is never sent while blocked: `enabled` is the negated
//      predicate and the query function checks it before its one server
//      call;
//  S3  a blocked query shows C0's search notice in place of the results
//      (cached results included) and hides the sort buttons;
//  S4  results render only through the shared `Message` component (which
//      shows the decrypted view or a marker on Protected rows) and this file
//      never reads server text (`content`, embeds, attachments);
//  S5  that `Message` component still routes Protected rows to the view or
//      marker before its server-content branch (the path S4 relies on);
//  S6  no other client source searches messages (no second scope to guard).
//
// Run: node --test --conditions=browser \
//   src/interface/channels/text/protectedSearch.scan.test.ts
// `PROTECTED_SEARCH_SIDEBAR_TSX=<path>` scans another copy of the sidebar
// (named controls C-C15a/b/c).

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CLIENT_ROOT = resolve(HERE, "../../../..");
const SIDEBAR_PATH = resolve(HERE, "TextSearchSidebar.tsx");
const MESSAGE_PATH = resolve(
  CLIENT_ROOT,
  "components/app/interface/channels/text/Message.tsx",
);

const SIDEBAR_RAW = readFileSync(
  process.env.PROTECTED_SEARCH_SIDEBAR_TSX || SIDEBAR_PATH,
  "utf8",
);

/** Drop comments (block, JSX block and whole-line) so prose never counts. */
function code(s: string): string {
  return s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const SIDEBAR = code(SIDEBAR_RAW);

/** Text of the `const protectedTextQuery = () => …;` arrow body. */
function predicateBody(): string {
  const m = SIDEBAR.match(
    /const\s+protectedTextQuery\s*=\s*\(\s*\)\s*=>\s*([\s\S]*?);\s*\n/,
  );
  assert.ok(m, "TextSearchSidebar defines `const protectedTextQuery = () =>`");
  return m[1];
}

/** Evaluate the predicate against fake props and a fake client. */
function blocked(
  query: Record<string, unknown>,
  protectedIds: string[],
  channelId = "C1",
): boolean {
  const body = predicateBody();
  const asked: string[] = [];
  const client = () => ({
    isProtectedChannel: (id: string) => {
      asked.push(id);
      return protectedIds.includes(id);
    },
  });
  const fn = new Function("props", "client", `return (${body});`) as (
    p: unknown,
    c: unknown,
  ) => unknown;
  const out = fn({ query, channel: { id: channelId } }, client);
  assert.equal(typeof out, "boolean", "the predicate yields a boolean");
  for (const id of asked)
    assert.equal(id, channelId, "asks about this channel");
  return out as boolean;
}

/** The object literal passed to `useQuery(() => ({ … }))`. */
function useQueryOptions(): string {
  const at = SIDEBAR.search(/useQuery\(\s*\(\s*\)\s*=>\s*\(\{/);
  assert.ok(at >= 0, "TextSearchSidebar calls useQuery(() => ({ … }))");
  const end = SIDEBAR.indexOf("}));", at);
  assert.ok(end > at, "the useQuery options close");
  return SIDEBAR.slice(at, end);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "catalogs") {
      continue;
    }
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

// ---- S1 ---------------------------------------------------------------------

test("S1: a text query on a Protected channel is blocked", () => {
  assert.equal(blocked({ query: "hello" }, ["C1"]), true);
  assert.equal(blocked({ query: "" }, ["C1"]), true, "an empty query too");
  assert.equal(
    blocked({ query: "hello", pinned: true }, ["C1"]),
    true,
    "a query is blocked even alongside pinned",
  );
});

test("S1: the pinned listing on a Protected channel is not blocked", () => {
  assert.equal(blocked({ pinned: true, sort: "Latest" }, ["C1"]), false);
});

test("S1: non-protected searches are never blocked", () => {
  assert.equal(blocked({ query: "hello" }, []), false);
  assert.equal(blocked({ query: "hello" }, ["C2"]), false, "another channel");
  assert.equal(blocked({ pinned: true, sort: "Latest" }, []), false);
});

test("S1: the predicate uses the SDK's isProtectedChannel", () => {
  assert.match(
    predicateBody(),
    /client\(\)\.isProtectedChannel\(\s*props\.channel\.id\s*\)/,
  );
});

// ---- S2 ---------------------------------------------------------------------

test("S2: the query is disabled while blocked", () => {
  assert.match(
    useQueryOptions(),
    /\benabled:\s*!protectedTextQuery\(\)\s*,/,
    "useQuery `enabled: !protectedTextQuery()`",
  );
});

test("S2: the query function checks the guard before its one server call", () => {
  const opts = useQueryOptions();
  const fnAt = opts.search(/\bqueryFn:\s*\(\s*\)\s*=>/);
  assert.ok(fnAt >= 0, "queryFn is an arrow");
  const fnBody = opts.slice(fnAt);
  const guard = fnBody.search(
    /protectedTextQuery\(\)\s*\?\s*Promise\.resolve\(\s*\[\s*\]\s*\)\s*:/,
  );
  const call = fnBody.search(/\.searchWithUsers\(/);
  assert.ok(
    guard >= 0,
    "queryFn: protectedTextQuery() ? Promise.resolve([]) :",
  );
  assert.ok(call > guard, "the server call sits in the not-blocked arm");
  const calls = SIDEBAR.match(/\.(searchWithUsers|search)\(/g) ?? [];
  assert.equal(calls.length, 1, "exactly one server search call in the file");
});

// ---- S3 ---------------------------------------------------------------------

test("S3: a blocked query shows C0's notice in place of the results", () => {
  assert.match(
    SIDEBAR,
    /import\s*\{[^}]*\bsearchCopy\b[^}]*\}\s*from\s*"@revolt\/client\/protectedCopy"/,
  );
  const show = SIDEBAR.search(/<Show\s+when=\{!protectedTextQuery\(\)\}/);
  assert.ok(show >= 0, "<Show when={!protectedTextQuery()} …>");
  const fallback = SIDEBAR.indexOf("fallback=", show);
  const notice = SIDEBAR.indexOf("searchCopy.textSearchUnavailable()", show);
  const results = SIDEBAR.indexOf("<For each={query.data}>", show);
  const close = SIDEBAR.indexOf("</Show>", results);
  assert.ok(fallback > show && notice > fallback, "the notice is the fallback");
  assert.ok(results > notice, "the results are the guarded children");
  assert.ok(close > results, "the results close inside that Show");
  assert.equal(
    (SIDEBAR.match(/<For each=\{query\.data\}>/g) ?? []).length,
    1,
    "results render in one place only",
  );
});

test("S3: the sort buttons hide while blocked", () => {
  assert.match(
    SIDEBAR,
    /<Show when=\{!props\.query\.sort && !protectedTextQuery\(\)\}>/,
  );
});

// ---- S4 ---------------------------------------------------------------------

test("S4: results render through the shared Message component", () => {
  assert.match(SIDEBAR, /import\s*\{\s*Message\s*\}\s*from\s*"@revolt\/app"/);
  assert.match(
    SIDEBAR,
    /<For each=\{query\.data\}>\s*\{\(message\)\s*=>\s*\(\s*<a href=\{message\.path\}>\s*<Message message=\{message\} isLink \/>\s*<\/a>/,
  );
});

test("S4: the sidebar never reads server text", () => {
  for (const field of [
    "content",
    "embeds",
    "attachments",
    "systemMessage",
    "masquerade",
  ]) {
    assert.doesNotMatch(
      SIDEBAR,
      new RegExp(`\\.${field}\\b`),
      `no .${field} read`,
    );
  }
  assert.doesNotMatch(SIDEBAR, /@revolt\/markdown/, "no Markdown render");
});

// ---- S5 ---------------------------------------------------------------------

test("S5: Message routes Protected rows before server content", () => {
  const msg = code(readFileSync(MESSAGE_PATH, "utf8"));
  assert.match(msg, /isProtectedChannel\(\s*props\.message\.channelId\s*\)/);
  assert.match(msg, /useProtectedMessage\(/);
  const marker = msg.search(/<Match when=\{protectedMarker\(\)\}>/);
  const ok = msg.search(/<Match when=\{protectedOk\(\)\}>/);
  const content = msg.search(/<Match when=\{props\.message\.content && /);
  assert.ok(marker >= 0 && ok >= 0 && content >= 0, "all three branches");
  assert.ok(marker < content && ok < content, "Protected branches come first");
});

// ---- S6 ---------------------------------------------------------------------

test("S6: no other client source searches messages", () => {
  const offenders: string[] = [];
  for (const root of ["src", "components"]) {
    for (const file of walk(resolve(CLIENT_ROOT, root))) {
      if (resolve(file) === SIDEBAR_PATH) continue;
      const src = code(readFileSync(file, "utf8"));
      if (
        /\.searchWithUsers\(/.test(src) ||
        /\.search\(\s*\{/.test(src) ||
        /\/search[`"']/.test(src)
      ) {
        offenders.push(relative(CLIENT_ROOT, file));
      }
    }
  }
  assert.deepEqual(offenders, [], "message search lives in the sidebar only");
});
