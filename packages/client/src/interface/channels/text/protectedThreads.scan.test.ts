// Source-scan spec: no thread can be created on a protected channel from the
// client UI (W4d final audit F#1; plan D11). A thread title is server
// plaintext, so every opener of thread creation is gated by the protected
// predicate; the stoat.js `Channel.createThread` guard is the second key.
//
//  T1  the "Create Thread" button in `ThreadsListSidebar.tsx` sits under
//      `!protectedActionsBlocked(client().isProtectedChannel(…), "create_thread")`;
//  T2  every thread-create opener in client source (`type: "create_thread"`
//      modal opens, `.createThread(` calls, raw `/threads` POSTs) is in the
//      allowlist below, each opener gated by its file's protected predicate.
//  T3  (W4e) a protected channel the server relabels as a forum: the forum
//      view shows only a notice (no toolbar, no post list) and "New Post" is
//      gated by the protected predicate as a second key;
//  T4  (W4e) every forum-post opener (`type: "create_forum_post"`,
//      `.createPost(`, raw `/posts` POSTs) is allowlisted and gated.
//
// Run: node --test --conditions=browser \
//   src/interface/channels/text/protectedThreads.scan.test.ts
// `PROTECTED_THREADS_SIDEBAR_TSX=<path>` / `PROTECTED_THREADS_FORUM_TSX=<path>`
// scan another copy of the sidebar / forum view (controls C-F1ui, C-W4e*);
// `PROTECTED_THREADS_EXTRA_FILE=<path>` adds a file to the inventory
// (control C-F1inv).

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLIENT_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SIDEBAR_REL = "src/interface/channels/text/ThreadsListSidebar.tsx";
const MENU_REL = "components/app/menus/MessageContextMenu.tsx";
const MODAL_REL = "components/modal/modals/CreateThread.tsx";
const FORUM_REL = "src/interface/channels/forum/ForumChannel.tsx";
const POST_MODAL_REL = "components/modal/modals/CreateForumPost.tsx";

// ---- Source helpers ---------------------------------------------------------

/**
 * Index just past the closer matching the opener at `open`, skipping
 * strings, template literals and comments (good enough for these files).
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

/** Drop comments and collapse whitespace. */
function code(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The `when={...}` conditions of every `<Show>` / `<Match>` enclosing
 * `at`, nearest first.
 */
function enclosingConditions(src: string, at: number): string[] {
  const tag = /<\/?(Show|Match)\b/g;
  const tags: { index: number; close: boolean }[] = [];
  for (const m of src.slice(0, at).matchAll(tag)) {
    tags.push({ index: m.index!, close: m[0].startsWith("</") });
  }
  const out: string[] = [];
  let depth = 0;
  for (let k = tags.length - 1; k >= 0; k--) {
    if (tags[k].close) {
      depth++;
      continue;
    }
    if (depth > 0) {
      depth--;
      continue;
    }
    const when = src.indexOf("when={", tags[k].index);
    const open = when + "when=".length;
    out.push(code(src.slice(open + 1, matchPair(src, open) - 1)));
  }
  return out;
}

// ---- Inventory --------------------------------------------------------------

/** Client source files (no specs, catalogs, builds or generated code). */
function sourceFiles(): Map<string, string> {
  const out = new Map<string, string>();
  for (const top of ["components", "src"]) {
    const entries = readdirSync(join(CLIENT_ROOT, top), {
      recursive: true,
      withFileTypes: true,
    });
    for (const e of entries) {
      if (!e.isFile() || !/\.tsx?$/.test(e.name)) continue;
      if (/\.test\.tsx?$/.test(e.name) || e.name.endsWith(".d.ts")) continue;
      const full = join(e.parentPath, e.name);
      const rel = relative(CLIENT_ROOT, full).split("\\").join("/");
      if (/(^|\/)(node_modules|dist|catalogs|styled-system)\//.test(rel)) {
        continue;
      }
      out.set(rel, readFileSync(full, "utf8"));
    }
  }
  if (process.env.PROTECTED_THREADS_SIDEBAR_TSX) {
    out.set(
      SIDEBAR_REL,
      readFileSync(process.env.PROTECTED_THREADS_SIDEBAR_TSX, "utf8"),
    );
  }
  if (process.env.PROTECTED_THREADS_FORUM_TSX) {
    out.set(
      FORUM_REL,
      readFileSync(process.env.PROTECTED_THREADS_FORUM_TSX, "utf8"),
    );
  }
  if (process.env.PROTECTED_THREADS_EXTRA_FILE) {
    out.set(
      `extra:${process.env.PROTECTED_THREADS_EXTRA_FILE}`,
      readFileSync(process.env.PROTECTED_THREADS_EXTRA_FILE, "utf8"),
    );
  }
  return out;
}

const FILES = sourceFiles();

/** A thread-create modal open (not the `type:` declaration in types.ts). */
const OPENER = /type:\s*"create_thread"\s*,/g;
/** A direct SDK call. */
const SDK_CALL = /\.createThread\(/g;
/** A raw thread POST that bypasses the SDK. */
const RAW_POST = /\.post\(\s*[`"'][^`"']*\/threads\b/g;

/** Each file's opener count and the gate every opener must sit under. */
const OPENER_ALLOWLIST: Record<string, { count: number; gate: RegExp }> = {
  [SIDEBAR_REL]: {
    count: 1,
    gate: /^!protectedActionsBlocked\( client\(\)\.isProtectedChannel\(props\.channel\.id\), "create_thread",? \) && /,
  },
  [MENU_REL]: { count: 1, gate: /^!hidden\("create_thread"\) && / },
};

/** A forum-post modal open (not the `type:` declaration in types.ts). */
const POST_OPENER = /type:\s*"create_forum_post"\s*,/g;
/** A direct SDK call. */
const POST_SDK_CALL = /\.createPost\(/g;
/** A raw post POST that bypasses the SDK. */
const POST_RAW_POST = /\.post\(\s*[`"'][^`"']*\/posts\b/g;

/** The forum view's own predicate, as the gates below name it. */
const FORUM_GATE =
  /^!protectedActionsBlocked\(protectedChannel\(\), "create_thread"\) && /;

const POST_OPENERS: Record<string, { count: number; gate: RegExp }> = {
  [FORUM_REL]: { count: 1, gate: FORUM_GATE },
};

function indexesOf(src: string, re: RegExp): number[] {
  return [...src.matchAll(re)].map((m) => m.index!);
}

// ---- T1 ---------------------------------------------------------------------

test("T1 Create Thread in the threads sidebar is hidden on protected", () => {
  const src = FILES.get(SIDEBAR_REL);
  assert.ok(src, `missing ${SIDEBAR_REL}`);
  const at = src.indexOf('type: "create_thread",');
  assert.ok(at >= 0, "the sidebar no longer opens create_thread");
  const conditions = enclosingConditions(src, at);
  assert.ok(
    conditions.some((c) => OPENER_ALLOWLIST[SIDEBAR_REL].gate.test(c)),
    `Create Thread is not gated by the protected predicate: ${JSON.stringify(conditions)}`,
  );
  assert.match(
    src,
    /import \{ protectedActionsBlocked \} from "@revolt\/client\/protectedShield";/,
  );
});

// ---- T2 ---------------------------------------------------------------------

test("T2 every thread-create opener is allowlisted and protected-gated", () => {
  assert.ok(FILES.size > 100, `inventory too small: ${FILES.size}`);

  const openers = new Map<string, number[]>();
  for (const [rel, src] of FILES) {
    const at = indexesOf(src, OPENER);
    if (at.length) openers.set(rel, at);
  }
  assert.deepEqual(
    [...openers.keys()].sort(),
    Object.keys(OPENER_ALLOWLIST).sort(),
    "a thread-create opener outside the allowlist: gate it on " +
      '`protectedActionsBlocked(…, "create_thread")` and add it here',
  );
  for (const [rel, at] of openers) {
    const { count, gate } = OPENER_ALLOWLIST[rel];
    assert.equal(at.length, count, `${rel}: opener count changed`);
    const src = FILES.get(rel)!;
    for (const i of at) {
      const conditions = enclosingConditions(src, i);
      assert.ok(
        conditions.some((c) => gate.test(c)),
        `${rel}: opener at ${i} not gated by ${gate}: ${JSON.stringify(conditions)}`,
      );
    }
  }

  // The menu's `hidden` is the protected predicate for its row's channel
  assert.ok(
    code(FILES.get(MENU_REL)!).includes(
      "const hidden = (action: ProtectedAction) => " +
        "protectedActionsBlocked(protectedRow(), action);",
    ),
    "MessageContextMenu `hidden` is no longer the protected predicate",
  );

  // Only the modal (reached through the gated openers) calls the SDK, and
  // nothing POSTs a thread around the SDK guard
  const callers = [...FILES]
    .filter(([, src]) => indexesOf(src, SDK_CALL).length > 0)
    .map(([rel]) => rel);
  assert.deepEqual(callers, [MODAL_REL], "unexpected createThread caller");
  const raw = [...FILES]
    .filter(([, src]) => indexesOf(src, RAW_POST).length > 0)
    .map(([rel]) => rel);
  assert.deepEqual(raw, [], "raw thread POST bypasses the SDK guard");
});

// ---- T3 (W4e) ---------------------------------------------------------------

test("T3 a protected channel relabelled as a forum shows only a notice", () => {
  const src = FILES.get(FORUM_REL);
  assert.ok(src, `missing ${FORUM_REL}`);
  const memo = src.indexOf("const protectedChannel = createMemo(");
  assert.ok(memo >= 0, "the forum view has no protected predicate");
  const open = src.indexOf("(", memo);
  assert.equal(
    code(src.slice(open + 1, matchPair(src, open, "(", ")") - 1)),
    "() => client().isProtectedChannel(props.channel.id),",
  );

  // The toolbar and the post list render only off a protected channel
  for (const marker of ["<Toolbar>", "<Scroll>"]) {
    const at = src.indexOf(marker);
    assert.ok(at >= 0, `missing ${marker}`);
    assert.ok(
      enclosingConditions(src, at).includes("!protectedChannel()"),
      `${marker} renders on a protected channel`,
    );
  }
  // ... and the fallback is the loud notice, with C0 copy
  const show = src.indexOf("<Show\n        when={!protectedChannel()}");
  assert.ok(show >= 0, "missing the protected Show");
  const head = code(src.slice(show, src.indexOf("<Toolbar>", show)));
  assert.ok(
    head.includes(
      '<ProtectedForumNotice role="alert"> ' +
        '<ProtectedShieldIcon state="unverified" size={16} /> ' +
        '<span>{noticeCopy("channel_protected")}</span> ' +
        "</ProtectedForumNotice>",
    ),
    `no protected notice fallback: ${head}`,
  );
});

// ---- T4 (W4e) ---------------------------------------------------------------

test("T4 every forum-post opener is allowlisted and protected-gated", () => {
  const openers = new Map<string, number[]>();
  for (const [rel, src] of FILES) {
    const at = indexesOf(src, POST_OPENER);
    if (at.length) openers.set(rel, at);
  }
  assert.deepEqual(
    [...openers.keys()].sort(),
    Object.keys(POST_OPENERS).sort(),
    "a forum-post opener outside the allowlist: gate it on the protected " +
      "predicate and add it here",
  );
  for (const [rel, at] of openers) {
    const { count, gate } = POST_OPENERS[rel];
    assert.equal(at.length, count, `${rel}: opener count changed`);
    const src = FILES.get(rel)!;
    for (const i of at) {
      const conditions = enclosingConditions(src, i);
      assert.ok(
        conditions.some((c) => gate.test(c)),
        `${rel}: opener at ${i} not gated by ${gate}: ${JSON.stringify(conditions)}`,
      );
    }
  }

  // Only the post modal (reached through the gated opener) calls the SDK,
  // and nothing POSTs a forum post around the SDK guard
  const callers = [...FILES]
    .filter(([, src]) => indexesOf(src, POST_SDK_CALL).length > 0)
    .map(([rel]) => rel);
  assert.deepEqual(callers, [POST_MODAL_REL], "unexpected createPost caller");
  const raw = [...FILES]
    .filter(([, src]) => indexesOf(src, POST_RAW_POST).length > 0)
    .map(([rel]) => rel);
  assert.deepEqual(raw, [], "raw forum-post POST bypasses the SDK guard");
});
