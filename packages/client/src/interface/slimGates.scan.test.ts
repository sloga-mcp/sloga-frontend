// Source-scan spec for the Slim view gates (Sloga Slim M1, lane L14), run
// with Node's built-in runner from packages/client:
//   node --conditions=browser --test src/interface/slimGates.scan.test.ts
//
// Slim view shows chats and calls and hides servers. No single place
// enforces that: it is a set of separate gates in files Node cannot load
// (Solid, the client context, the UI kit), and a merge or refactor that
// drops one still builds and still type-checks. This spec reads those files
// as text and fails when a gate is gone, commented out, or moved to where it
// no longer covers what it covered. One test per gate site, so a failure
// names the site:
//
//  G0   the scanner itself (strings, comments, JSX nesting, route paths);
//  G1   src/index.tsx: every `<Route>` is in BLOCKED or ALLOWED below. A new
//       route fails here until someone decides whether Slim view shows it;
//  G2   components/client/slimRoutePolicy.ts (the real module, loaded) gives
//       the same answer as those two lists, so they cannot drift apart;
//  G3   src/index.tsx: the saved last path goes through the policy, /dev and
//       the invite, discover and bot links redirect and open no dialog;
//  G4   src/Interface.tsx: the route gate effect, and the drawer rest;
//  G5   src/Interface.tsx: the Slim-only error boundary with its way out;
//  G6   ChannelPage.tsx: a server channel redirects ahead of every view;
//  G7   Sidebar.tsx: no server rail, no server channel list;
//  G8   Home.tsx: "Select a chat" in place of the hub, which is not built;
//  G9   UserSettings.tsx: the nine server-facing pages hide;
//  G10  UserSettings.tsx: safety, legal and the way out stay (R13, R15);
//  G11  NotificationsWorker.tsx: server messages are not announced, and a
//       tapped notification goes through the route policy;
//  G12  NotificationsWorker.tsx: report notifications are untouched (R14);
//  G13  AppearanceMenu.tsx + SlimViewChoice.tsx: one toggle, off in a call;
//  G14  Sync.ts: the settings store is not synced (R11);
//  G15  Settings.ts: `appearance:slim_view` is a boolean, off by default;
//  G16  AndroidBackWorker.tsx: Back at the Slim view root does not slide to
//       the placeholder pane.
//
// WHAT THIS SPEC CANNOT CATCH. It matches text; it never runs the app.
//  - Wrong polarity inside an expression it does not parse. A few short
//    conditions are pinned whole; anything else can be inverted unseen.
//  - A non-reactive read: `slim()` read once outside an effect, a memo or
//    JSX reads the same as a reactive one here.
//  - A redirect loop, or any other fault that only shows at runtime.
//  - A new server surface that is not a route (a dialog, a context menu, a
//    button on a page Slim view keeps), and a gate site that this file
//    does not list.
// The DEV browser leg (`?slim_dev=1`; plan "M1 in detail", Verification)
// covers those. A green run here does not stand in for it.
//
// Negative control: set `SLIM_GATES_ROOT` to a directory laid out like
// packages/client that holds a copy of every scanned file (the paths
// below; a missing copy fails the tests that read it), change one copy, and
// run the spec. It must fail in the test for that site.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.env.SLIM_GATES_ROOT || join(here, "..", ".."));

const SETTINGS_UI = "components/app/interface/settings";

const INDEX = "src/index.tsx";
const INTERFACE = "src/Interface.tsx";
const CHANNEL_PAGE = "src/interface/channels/ChannelPage.tsx";
const SIDEBAR = "src/interface/Sidebar.tsx";
const HOME = "src/interface/Home.tsx";
const USER_SETTINGS = `${SETTINGS_UI}/UserSettings.tsx`;
const APPEARANCE_MENU = `${SETTINGS_UI}/user/appearance/AppearanceMenu.tsx`;
const SLIM_VIEW_CHOICE = `${SETTINGS_UI}/user/appearance/SlimViewChoice.tsx`;
const NOTIFICATIONS = "components/client/NotificationsWorker.tsx";
const ANDROID_BACK = "components/client/AndroidBackWorker.tsx";
const POLICY = "components/client/slimRoutePolicy.ts";
const SYNC = "components/state/stores/Sync.ts";
const SETTINGS = "components/state/stores/Settings.ts";

/**
 * First path segments of the routes in src/index.tsx that Slim view does
 * not show. Kept here on purpose, and not read out of slimRoutePolicy.ts:
 * G2 checks the policy against this list.
 */
const BLOCKED = ["server", "discover", "streamers", "invite", "bot", "dev"];

/**
 * First path segments of the routes Slim view may show. "" is the root
 * route itself and "*" its catch-all, which is where /app lands.
 */
const ALLOWED = [
  "",
  "*",
  "login",
  "r",
  "pwa",
  "settings",
  "friends",
  "channel",
  "friends-popout",
  "voice-overlay",
];

/** Settings pages hidden in Slim view (plan, "M1 in detail"). */
const HIDDEN_PAGES = [
  "referrals",
  "cipher",
  "prot",
  "connections",
  "bots",
  "overlay",
  "keybinds",
  "feedback",
  "streamer",
];

/** Settings pages Slim view must never hide (R13, R15). */
const KEPT_PAGES = [
  "account",
  "sessions",
  "appearance",
  "security",
  "privacy",
  "terms",
  "privacy_policy",
  "logout",
];

/** `value`, or a failure that says why it was needed. */
function must<T>(value: T | null | undefined, why: string): T {
  if (value === null || value === undefined) assert.fail(why);
  return value;
}

/** Line number of index `at`, for failure messages. */
function lineOf(s: string, at: number): number {
  return s.slice(0, at).split("\n").length;
}

/**
 * Index just past the string or template literal that opens at `at`. A
 * quote with no partner on its line is an apostrophe in JSX text, and ends
 * at the line break.
 */
function skipString(s: string, at: number): number {
  const quote = s[at];
  let i = at + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") i += 2;
    else if (c === quote) return i + 1;
    else if (quote !== "`" && c === "\n") return i;
    else if (quote === "`" && c === "$" && s[i + 1] === "{")
      i = matchClose(s, i + 1) + 1;
    else i++;
  }
  if (quote === "`")
    assert.fail(`scanner: open template literal, line ${lineOf(s, at)}`);
  return s.length;
}

/** Index of the bracket that closes the `(`, `[` or `{` at `at`. */
function matchClose(s: string, at: number): number {
  let depth = 0;
  let i = at;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(s, i);
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  assert.fail(`scanner: unclosed bracket, line ${lineOf(s, at)}`);
}

/**
 * Source with its comments removed (block, JSX block and line), so prose
 * and a commented-out gate never count. Strings and template literals are
 * copied as they are: the route path "/*" does not open a comment. A JSX
 * comment goes together with its braces.
 */
function code(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(s, i);
      out += s.slice(i, end);
      i = end;
    } else if (c === "/" && s[i + 1] === "*") {
      const close = s.indexOf("*/", i + 2);
      i = close === -1 ? s.length : close + 2;
      const after = /^\s*\}/.exec(s.slice(i));
      if (after && /\{\s*$/.test(out)) {
        out = out.replace(/\{\s*$/, "");
        i += after[0].length;
      }
    } else if (
      c === "/" &&
      s[i + 1] === "/" &&
      s[i - 1] !== ":" &&
      s[i - 1] !== "\\"
    ) {
      // Not after a colon: "https://" in JSX text is not a comment
      const close = s.indexOf("\n", i);
      i = close === -1 ? s.length : close;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const loaded = new Map<string, string>();

/**
 * A scanned file with its comments removed. Read on first use, so a file
 * missing from a control directory fails the tests that need it and no
 * others.
 */
function load(rel: string): string {
  let text = loaded.get(rel);
  if (text === undefined) {
    text = code(readFileSync(join(ROOT, rel), "utf8"));
    assert.doesNotMatch(
      text,
      /^\s*\/\/|\{\s*\/\*/m,
      `scanner: a comment survived in ${rel}, so it has lost its place`,
    );
    loaded.set(rel, text);
  }
  return text;
}

/**
 * Whitespace out, and the trailing comma prettier adds when it breaks a
 * list over several lines, so a reformatted gate still matches.
 */
function squash(s: string): string {
  return s.replace(/\s+/g, "").replace(/,(?=[)\]}])/g, "");
}

/** How many times `needle` occurs in `hay`, both squashed. */
function count(hay: string, needle: string): number {
  return squash(hay).split(squash(needle)).length - 1;
}

/** Fails unless `needle` occurs in `hay`, both squashed. */
function has(hay: string, needle: string, why = "missing"): void {
  assert.ok(squash(hay).includes(squash(needle)), `${why}: ${needle}`);
}

/** Start index of every match of `re` in `src`. */
function indexes(src: string, re: RegExp): number[] {
  const out: number[] = [];
  const all = new RegExp(re.source, "g");
  for (let m = all.exec(src); m; m = all.exec(src)) out.push(m.index);
  return out;
}

/** Start index of the only match of `re` in `src`. */
function only(src: string, re: RegExp, what: string): number {
  const found = indexes(src, re);
  assert.equal(found.length, 1, `expected one ${what}, found ${found.length}`);
  return found[0];
}

/** Every string literal in `s`, without its quotes. */
function stringsIn(s: string): string[] {
  const out: string[] = [];
  const all = /"([^"]*)"/g;
  for (let m = all.exec(s); m; m = all.exec(s)) out.push(m[1]);
  return out;
}

/** Body, braces included, of `function name(...) {...}`. */
function functionBody(src: string, name: string): string {
  const head = must(
    new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(src),
    `function ${name} is missing`,
  );
  const params = matchClose(src, head.index + head[0].length - 1);
  const open = src.indexOf("{", params);
  assert.ok(open !== -1, `function ${name} has no body`);
  return src.slice(open, matchClose(src, open) + 1);
}

/** Body, braces included, of `const name = (...) => {...}`. */
function arrowBody(src: string, name: string): string {
  const head = must(
    new RegExp(`\\bconst\\s+${name}\\s*=\\s*\\(`).exec(src),
    `const ${name} = (...) => {...} is missing`,
  );
  const params = matchClose(src, head.index + head[0].length - 1);
  const arrow = must(
    /^\s*=>\s*\{/.exec(src.slice(params + 1)),
    `${name} is no longer an arrow function with a block body`,
  );
  const open = params + arrow[0].length;
  return src.slice(open, matchClose(src, open) + 1);
}

/** Every bare `name(...)` call in `src`, from the name to its `)`. */
function calls(src: string, name: string): string[] {
  return indexes(src, new RegExp(`(?<![\\w.$])${name}\\(`)).map((at) =>
    src.slice(at, matchClose(src, at + name.length) + 1),
  );
}

/** The innermost `{...}` block that holds index `at`. */
function blockAround(src: string, at: number): string {
  let depth = 0;
  for (let i = at; i >= 0; i--) {
    const c = src[i];
    if (c === "}") depth++;
    else if (c === "{") {
      if (depth === 0) return src.slice(i, matchClose(src, i) + 1);
      depth--;
    }
  }
  assert.fail(`scanner: no block around line ${lineOf(src, at)}`);
}

type Tag = { at: number; text: string; end: number; selfClosing: boolean };

/** The opening JSX tag that starts at `at`; `end` is just past its `>`. */
function openTag(src: string, at: number): Tag {
  let i = at + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") i = skipString(src, i);
    else if (c === "(" || c === "[" || c === "{") i = matchClose(src, i) + 1;
    else if (c === ">") {
      const text = src.slice(at, i + 1);
      return { at, text, end: i + 1, selfClosing: src[i - 1] === "/" };
    } else i++;
  }
  assert.fail(`scanner: unclosed tag, line ${lineOf(src, at)}`);
}

/** Matches the opening and the closing tag of the JSX element `tag`. */
function tagPattern(tag: string): RegExp {
  return new RegExp(`<${tag}(?![\\w.])|</${tag}>`, "g");
}

/** Every opening tag of `tag` in `src`, in source order. */
function openTags(src: string, tag: string): Tag[] {
  return indexes(src, new RegExp(`<${tag}(?![\\w.])`)).map((at) =>
    openTag(src, at),
  );
}

/**
 * Opening tags (squashed) of the `tag` elements that hold index `at` among
 * their children, outermost first. An element whose own opening tag holds
 * `at`, inside an attribute such as `fallback`, does not count: that is
 * the other branch.
 */
function enclosing(src: string, at: number, tag: string): string[] {
  const stack: Tag[] = [];
  const all = tagPattern(tag);
  for (let m = all.exec(src); m && m.index < at; m = all.exec(src)) {
    if (m[0].startsWith("</")) stack.pop();
    else {
      const open = openTag(src, m.index);
      if (!open.selfClosing) stack.push(open);
    }
  }
  return stack.filter((open) => open.end <= at).map((o) => squash(o.text));
}

/** The whole `tag` element whose opening tag starts at `at`. */
function element(src: string, at: number, tag: string): string {
  const all = tagPattern(tag);
  all.lastIndex = at;
  let depth = 0;
  for (let m = all.exec(src); m; m = all.exec(src)) {
    if (m[0].startsWith("</")) depth--;
    else if (!openTag(src, m.index).selfClosing) depth++;
    if (depth === 0) {
      const end = m[0].startsWith("</")
        ? m.index + m[0].length
        : openTag(src, m.index).end;
      return src.slice(at, end);
    }
  }
  assert.fail(`scanner: unclosed <${tag}>, line ${lineOf(src, at)}`);
}

type RouteDecl = { full: string; segment: string; component: string };

/** The path or paths one `<Route>` opening tag declares. */
function routePaths(tag: string): string[] {
  const one = /\bpath=(?:"([^"]*)"|\{\s*"([^"]*)"\s*\})/.exec(tag);
  if (one) return [one[1] ?? one[2]];

  const many = /\bpath=\{\s*\[([^\]]*)\]\s*\}/.exec(tag);
  if (many) {
    const paths = stringsIn(many[1]);
    const rest = many[1].replace(/"[^"]*"/g, "").replace(/[\s,]/g, "");
    if (paths.length > 0 && rest === "") return paths;
  }

  assert.fail(
    `this spec cannot read the path of ${squash(tag)}. Write it as a ` +
      `string or an array of strings, or teach routePaths the new form: ` +
      `a route it cannot read is a route Slim view was never asked about.`,
  );
}

/** A child route's path under its parent's. */
function joinPath(parent: string, child: string): string {
  const above = parent.split("/").filter(Boolean);
  // A parent's trailing wildcard only makes room for its children
  if (above.at(-1)?.startsWith("*")) above.pop();
  return "/" + [...above, ...child.split("/").filter(Boolean)].join("/");
}

/**
 * First segment of a route path the way slimRoutePolicy.ts reads one: ""
 * for the root, lower-cased, and "*" for a catch-all whatever its name.
 */
function firstSegment(full: string): string {
  const first = full.split("/").filter(Boolean)[0] ?? "";
  return first.startsWith("*") ? "*" : first.toLowerCase();
}

/** A path the route `full` matches: parameters and wildcards filled in. */
function samplePath(full: string): string {
  const filled = full
    .split("/")
    .filter(Boolean)
    .map((s) => (s.startsWith(":") ? "x1" : s.startsWith("*") ? "app" : s));
  return "/" + filled.join("/");
}

/**
 * Every `<Route>` declared in `src` with its full path: nested routes are
 * joined onto their parents, and the array form gives one entry per path.
 */
function routes(src: string): RouteDecl[] {
  const out: RouteDecl[] = [];
  const stack: string[][] = [];
  const all = tagPattern("Route");
  for (let m = all.exec(src); m; m = all.exec(src)) {
    if (m[0] === "</Route>") {
      assert.ok(stack.pop(), `stray </Route>, line ${lineOf(src, m.index)}`);
      continue;
    }

    const open = openTag(src, m.index);
    const above = stack.at(-1) ?? [""];
    const fulls = above.flatMap((parent) =>
      routePaths(open.text).map((path) => joinPath(parent, path)),
    );
    const component = /\bcomponent=\{\s*(\w+)/.exec(open.text)?.[1] ?? "";
    for (const full of fulls)
      out.push({ full, segment: firstSegment(full), component });
    if (!open.selfClosing) stack.push(fulls);
  }
  assert.equal(stack.length, 0, "a <Route> is never closed");
  return out;
}

/** The whole settings list entry (`{ id: "...", ... }`) for one page id. */
function settingsEntry(src: string, id: string): string {
  const at = only(src, new RegExp(`\\bid:\\s*"${id}"`), `entry id "${id}"`);
  const entry = blockAround(src, at);
  assert.equal(
    indexes(entry, /\bid:\s*"/).length,
    1,
    `scanner: the block around id "${id}" is not one entry`,
  );
  return entry;
}

test("G0 the scanner reads strings, comments, JSX and routes as the gates need", () => {
  assert.equal(
    code('a("/*"); // gone\n{/* gone */}<b c="https://d">https://e</b>'),
    'a("/*"); \n<b c="https://d">https://e</b>',
  );
  assert.equal(
    code("/* gone */x(`${y /* kept */}`);"),
    "x(`${y /* kept */}`);",
  );
  // An apostrophe in JSX text ends at its line break
  assert.equal(
    code("<i>don't</i>\n// gone\n'//kept'"),
    "<i>don't</i>\n\n'//kept'",
  );
  assert.equal(squash("f(\n  a,\n  [b, c,],\n)"), "f(a,[b,c])");

  const jsx =
    "<Show when={a()} fallback={<X />}><Show when={b}><Y /></Show><Z /></Show>";
  assert.deepEqual(enclosing(jsx, jsx.indexOf("<Y"), "Show"), [
    "<Showwhen={a()}fallback={<X/>}>",
    "<Showwhen={b}>",
  ]);
  assert.deepEqual(enclosing(jsx, jsx.indexOf("<Z"), "Show"), [
    "<Showwhen={a()}fallback={<X/>}>",
  ]);
  // In `fallback`: the other branch, not a child
  assert.deepEqual(enclosing(jsx, jsx.indexOf("<X"), "Show"), []);
  assert.equal(
    element(jsx, jsx.indexOf("<Show when={b}"), "Show"),
    "<Show when={b}><Y /></Show>",
  );

  const table =
    '<Router root={R}><Route path="/a" component={A}><Route path="/*" />' +
    '</Route><Route path={["/B", "/b/c"]} component={B} />' +
    '<Route path="/" component={I}><Route path="/d/:id/*">' +
    '<Route path="/e" component={E} /></Route><Route path="/*rest" />' +
    "</Route></Router>";
  assert.deepEqual(
    routes(table).map((r) => `${r.full} ${r.segment} ${r.component}`),
    [
      "/a a A",
      "/a/* a ",
      "/B b B",
      "/b/c b B",
      "/  I",
      "/d/:id/* d ",
      "/d/:id/e d E",
      "/*rest * ",
    ],
  );
  assert.throws(() => routes("<Route path={somewhere} />"), /cannot read/);
  assert.equal(samplePath("/d/:id/*"), "/d/x1/app");
  assert.equal(samplePath("/"), "/");
});

test("G1 index.tsx: every route is BLOCKED or ALLOWED for Slim view", () => {
  const declared = routes(load(INDEX));

  assert.deepEqual(
    BLOCKED.filter((segment) => ALLOWED.includes(segment)),
    [],
    "a segment is in both BLOCKED and ALLOWED",
  );

  for (const route of declared) {
    assert.ok(
      BLOCKED.includes(route.segment) || ALLOWED.includes(route.segment),
      `<Route path="${route.full}"> is new to this spec (first segment ` +
        `"${route.segment}"). Decide whether Slim view may show it. If it ` +
        `may not, add the segment to BLOCKED in this spec AND to ` +
        `BLOCKED_SEGMENTS in components/client/slimRoutePolicy.ts. If it ` +
        `may, add it to ALLOWED in this spec.`,
    );
  }

  // A stale entry, or a route table this spec has stopped being able to read
  const seen = new Set(declared.map((route) => route.segment));
  for (const segment of [...BLOCKED, ...ALLOWED]) {
    assert.ok(
      seen.has(segment),
      `no <Route> in src/index.tsx starts with "${segment}" any more. ` +
        `Take it out of this spec's lists (and out of slimRoutePolicy.ts ` +
        `if it was blocked).`,
    );
  }
});

test("G2 slimRoutePolicy.ts: agrees with this spec's route lists", async () => {
  const policy = (await import(pathToFileURL(join(ROOT, POLICY)).href)) as {
    SLIM_ROOT?: unknown;
    slimRedirectFor?: (path: string) => string | null;
  };
  assert.equal(policy.SLIM_ROOT, "/", "SLIM_ROOT");
  const redirect = must(policy.slimRedirectFor, "slimRedirectFor is missing");

  for (const segment of BLOCKED) {
    assert.equal(
      redirect("/" + segment),
      "/",
      `this spec blocks "${segment}" and slimRoutePolicy.ts does not`,
    );
  }
  for (const segment of ALLOWED) {
    assert.equal(
      redirect("/" + segment),
      null,
      `slimRoutePolicy.ts blocks "${segment}" and this spec allows it`,
    );
  }
  assert.equal(redirect("/app"), null, "/app is where login lands");

  // The same question for a real path of every declared route
  for (const route of routes(load(INDEX))) {
    const blocked = BLOCKED.includes(route.segment);
    // G1 reports a route that is in neither list
    if (!blocked && !ALLOWED.includes(route.segment)) continue;
    assert.equal(
      redirect(samplePath(route.full)),
      blocked ? "/" : null,
      `slimRoutePolicy.ts and this spec disagree about ${route.full}`,
    );
  }
});

test("G3 index.tsx: blocked links redirect and open nothing in Slim view", () => {
  const src = load(INDEX);

  for (const name of [
    "PWARedirect",
    "DevelopmentRoute",
    "InviteRedirect",
    "DiscoverRedirect",
    "BotRedirect",
  ]) {
    has(
      functionBody(src, name),
      "const slim = useSlimMode();",
      `${name} must ask useSlimMode`,
    );
  }

  // The saved last path goes through the policy before the redirect
  const pwa = functionBody(src, "PWARedirect");
  has(pwa, "const path = state.layout.getLastActivePath();");
  assert.match(
    squash(pwa),
    /returnslim\(\)\?\(?slimRedirectFor\(path\)\?\?path\)?:path;/,
    "PWARedirect must pass the saved path through slimRedirectFor",
  );
  has(pwa, "return <Navigate href={href} />;");

  // /dev
  has(
    functionBody(src, "DevelopmentRoute"),
    "<Show when={!slim()} fallback={<Navigate href={SLIM_ROOT} />}>" +
      "<DevelopmentPage /></Show>",
  );
  assert.equal(
    openTags(src, "DevelopmentPage").length,
    1,
    "DevelopmentPage is mounted outside DevelopmentRoute's gate",
  );

  // The three links that look something up and open a dialog
  for (const name of ["InviteRedirect", "DiscoverRedirect", "BotRedirect"]) {
    const body = functionBody(src, name);
    const mounts = calls(body, "onMount");
    assert.equal(mounts.length, 1, `${name}: expected one onMount`);
    const mount = mounts[0];

    const guard = must(
      /^onMount\(\s*\(\)\s*=>\s*\{\s*if\s*\(\s*slim\(\)\s*\)\s*/.exec(mount),
      `${name}: onMount must begin with \`if (slim())\``,
    );
    const then = mount.slice(guard[0].length);
    const returns = then.startsWith("{")
      ? squash(then.slice(0, matchClose(then, 0) + 1)).endsWith("return;}")
      : /^return\s*;/.test(then);
    assert.ok(returns, `${name}: the Slim view branch of onMount must return`);

    // Nothing is looked up or opened anywhere but behind that return
    assert.ok(count(mount, "openModal(") > 0, `${name}: scan is stale`);
    assert.equal(
      count(body, "openModal("),
      count(mount, "openModal("),
      `${name}: openModal is called outside the guarded onMount`,
    );
    assert.equal(
      count(body, "client()"),
      count(mount, "client()"),
      `${name}: the client is used outside the guarded onMount`,
    );

    has(
      body,
      "<Show when={slim()} fallback={<PWARedirect />}>" +
        "<Navigate href={SLIM_ROOT} /></Show>",
      `${name} must go to the Slim view root`,
    );
  }

  const notice = "Server invites are hidden in Slim view.";
  assert.equal(count(src, notice), 1, "the invite notice, exactly once");
  has(calls(functionBody(src, "InviteRedirect"), "onMount")[0], notice);

  // The routes still mount the gated components
  const want: Record<string, string> = {
    "/pwa": "PWARedirect",
    "/dev": "DevelopmentRoute",
    "/invite/:code": "InviteRedirect",
    "/discover/server/:id": "DiscoverRedirect",
    "/bot/:code": "BotRedirect",
  };
  const declared = routes(src);
  for (const [full, component] of Object.entries(want)) {
    assert.deepEqual(
      declared.filter((route) => route.full === full).map((r) => r.component),
      [component],
      `the ${full} route must mount ${component}`,
    );
  }
});

test("G4 Interface.tsx: the route gate effect and the drawer rest", () => {
  const src = load(INTERFACE);
  has(src, "const slim = useSlimMode();");
  const effects = calls(src, "createEffect").map(squash);

  // The gate: any blocked path, reached any way, goes to the Slim view root
  const gates = effects.filter((effect) => effect.includes("slimRedirectFor("));
  assert.equal(gates.length, 1, "one effect must call slimRedirectFor(");
  const gate = gates[0];
  const guard = must(
    /^createEffect\(\(\)=>\{if\(([^;{}]*)\)return;/.exec(gate),
    "the gate effect must begin with its guard",
  );
  const terms = guard[1].split("||");
  for (const term of ["!lifecycle.loadedOnce()", "!slim()"]) {
    assert.ok(terms.includes(term), `the gate effect must return on ${term}`);
  }
  // `routeLocation.pathname` follows the route; the destructured `pathname`
  // is the path the component mounted on
  const asked = gate.indexOf("slimRedirectFor(routeLocation.pathname)");
  assert.ok(asked > 0, "the gate must ask about routeLocation.pathname");
  assert.ok(
    gate.indexOf("navigate(target,{replace:true})") > asked,
    "the gate must navigate to the policy's answer, replacing the entry",
  );

  // The drawer rests on the chat list at the Slim view root
  const rests = effects.filter((effect) => effect.includes("slimIsRoot("));
  assert.equal(rests.length, 1, "one effect must call slimIsRoot(");
  const rest = rests[0];
  const whenSlim = rest.indexOf("!slim())return;");
  const atRoot = rest.indexOf("if(!slimIsRoot(routeLocation.pathname))return;");
  const shown = rest.indexOf("drawer.setShown(false)");
  assert.ok(whenSlim !== -1, "the drawer rest must return unless slim()");
  assert.ok(atRoot > whenSlim, "the drawer rest must return off the root");
  assert.ok(shown > atRoot, "the drawer rest must show the chat list");
});

test("G5 Interface.tsx: a crash in Slim view offers the way out (R15)", () => {
  const src = load(INTERFACE);

  const at = only(src, /<ErrorBoundary(?![\w.])/, "<ErrorBoundary>");
  assert.equal(
    enclosing(src, at, "Show").at(-1),
    squash("<Show when={slim()} fallback={props.children}>"),
    "the error boundary must sit inside <Show when={slim()}>",
  );

  const boundary = element(src, at, "ErrorBoundary");
  has(
    boundary,
    "{props.children}",
    "the boundary must wrap the routed content",
  );
  has(
    boundary,
    '<SlimCrashed error={error} onTurnOff={() => { state.settings.setValue("appearance:slim_view", false);',
    "the turn-off handler must switch the setting off",
  );

  const crashed = functionBody(src, "SlimCrashed");
  has(crashed, "<Trans>Something went wrong in Slim view.</Trans>");
  has(
    crashed,
    "<Button onPress={props.onTurnOff}><Trans>Turn off Slim view</Trans></Button>",
  );
});

test("G6 ChannelPage.tsx: a server channel redirects ahead of every view", () => {
  const src = load(CHANNEL_PAGE);
  has(src, "const slim = useSlimMode();");
  has(
    src,
    "const slimBlocked = createMemo(() => slim() && !slimAllowsChannel(channel()));",
  );

  const slimMatch = squash("<Match when={slimBlocked()}>");
  const matches = openTags(src, "Match");
  const order = matches.map((match) => squash(match.text));
  const slimAt = order.indexOf(slimMatch);
  const textAt = order.findIndex((text) =>
    text.startsWith("<Matchwhen={TEXT_CHANNEL_TYPES.includes("),
  );
  assert.ok(slimAt !== -1, "the Slim view <Match> is missing");
  assert.ok(textAt !== -1, "scan is stale: no TEXT_CHANNEL_TYPES <Match>");

  assert.equal(
    squash(element(src, matches[slimAt].at, "Match")),
    squash(`${slimMatch}<Navigate href={SLIM_ROOT} /></Match>`),
    "the Slim view <Match> must render only the redirect",
  );

  assert.ok(
    slimAt < textAt,
    "the Slim view <Match> must come before the text channel <Match>",
  );
  // Only "not loaded" and "not found" may come first
  for (const earlier of order.slice(0, slimAt)) {
    assert.ok(
      earlier.startsWith("<Matchwhen={!channel()"),
      `a <Match> ahead of the Slim view one can mount a channel: ${earlier}`,
    );
  }
  assert.deepEqual(
    enclosing(src, matches[slimAt].at, "Switch"),
    enclosing(src, matches[textAt].at, "Switch"),
    "the Slim view <Match> must be in the channel <Switch>",
  );
});

test("G7 Sidebar.tsx: no server rail and no server channel list", () => {
  const src = load(SIDEBAR);
  has(src, "const slim = useSlimMode();");

  const rail = only(src, /<ServerList(?![\w.])/, "<ServerList>");
  assert.ok(
    enclosing(src, rail, "Show").includes(squash("<Show when={!slim()}>")),
    "<ServerList> must be mounted inside <Show when={!slim()}>",
  );

  const list = only(src, /<Server\s*\/>/, "<Server />");
  assert.deepEqual(
    enclosing(src, list, "Match"),
    [squash("<Match when={!slim() && params.server}>")],
    "the server channel list must match on `!slim() && params.server`",
  );
});

test('G8 Home.tsx: the root shows "Select a chat", and no hub is built', () => {
  const src = load(HOME);
  const page = functionBody(src, "HomePage");
  has(page, "const slim = useSlimMode();");

  const hub = squash("<Show when={slim()} fallback={<HomeHub />}>");
  const shows = openTags(page, "Show").map((show) => squash(show.text));
  assert.ok(shows.includes(hub), "HomePage must switch on slim()");
  assert.equal(
    openTags(src, "HomeHub").length,
    1,
    "HomeHub must be mounted once, as that fallback",
  );

  const empty = page.indexOf("<Trans>Select a chat</Trans>");
  assert.ok(empty !== -1, 'the "Select a chat" state is missing');
  assert.ok(
    enclosing(page, empty, "Show").includes(hub),
    '"Select a chat" must be what Slim view shows',
  );

  // The hub's fetching and polling live in HomeHub, never here
  for (const work of ["createResource", "setInterval"]) {
    assert.ok(!page.includes(work), `HomePage itself must not ${work}`);
  }
});

test("G9 UserSettings.tsx: the server-facing pages hide in Slim view", () => {
  const src = load(USER_SETTINGS);
  has(src, "const slim = useSlimMode();");

  for (const id of HIDDEN_PAGES) {
    const entry = settingsEntry(src, id);
    // A getter, so the open settings list follows the toggle
    const getter = must(
      /\bget\s+hidden\s*\(\s*\)\s*\{/.exec(entry),
      `"${id}" has no \`get hidden()\`, so Slim view no longer hides it`,
    );
    const open = getter.index + getter[0].length - 1;
    const body = squash(entry.slice(open, matchClose(entry, open) + 1));
    assert.match(
      body,
      id === "streamer"
        ? // Kept while Streamer Mode is on, so it can be turned off
          /^\{returnslim\(\)&&!streamerModeActive\(state\.settings\);\}$/
        : /^\{return\(?slim\(\)(;|\|\|)/,
      `"${id}" must be hidden whenever slim() is true`,
    );
  }
});

test("G10 UserSettings.tsx: safety, legal and the way out stay (R13, R15)", () => {
  const src = load(USER_SETTINGS);

  for (const id of KEPT_PAGES) {
    assert.doesNotMatch(
      settingsEntry(src, id),
      /\bslim\b/,
      `"${id}" must stay reachable in Slim view`,
    );
  }

  // A read anywhere else (a whole section's `hidden`, say) could take a
  // kept page with it
  const reads = /\bslim\(\)/;
  const inHiddenPages = HIDDEN_PAGES.map(
    (id) => indexes(settingsEntry(src, id), reads).length,
  ).reduce((sum, n) => sum + n, 0);
  assert.equal(
    indexes(src, reads).length,
    inHiddenPages,
    "slim() must be read inside the hidden pages' entries and nowhere else",
  );
});

test("G11 NotificationsWorker.tsx: no server message alerts, taps go through the policy", () => {
  const src = load(NOTIFICATIONS);
  has(src, "const slim = useSlimMode();");

  // The filter sits ahead of every way a message is presented
  const onMessage = squash(functionBody(src, "onMessage"));
  const filter = onMessage.indexOf(
    "if(slim()&&!slimAllowsChannel(message.channel))return;",
  );
  assert.ok(filter !== -1, "onMessage must skip server messages in Slim view");
  for (const shown of [
    "sound.playSound(",
    "toastShell.show(",
    "showNotification(",
  ]) {
    const at = onMessage.indexOf(shown);
    assert.ok(at !== -1, `scan is stale: onMessage has no ${shown}`);
    assert.ok(filter < at, `the Slim view filter must come before ${shown}`);
  }

  // Where a tap lands
  const tap = arrowBody(src, "tapTarget");
  has(tap, "if (!slim()) return path;");
  has(tap, "return slimRedirectFor(path) ?? path;");
  has(arrowBody(src, "handleAction"), "navigate(tapTarget(path));");
  has(functionBody(src, "onMessage"), "navigate(tapTarget(message.path));");

  // Every other navigation in the worker is one of two that cannot reach a
  // server: the friends list, and the ringing notification of a DM or group
  const direct = ['navigate("/friends")', "navigate(channel.path)"];
  for (const call of calls(src, "navigate").map(squash)) {
    assert.ok(
      call.startsWith("navigate(tapTarget(") || direct.includes(call),
      `${call} does not go through tapTarget: Slim view may not show it`,
    );
  }
  assert.equal(count(src, "navigate(channel.path)"), 1);
  const ring = squash(functionBody(src, "onVoiceChannelJoin"));
  const dmOrGroup = ring.indexOf(
    'if(channel.type!=="DirectMessage"&&channel.type!=="Group")return;',
  );
  assert.ok(
    dmOrGroup !== -1 && dmOrGroup < ring.indexOf("navigate(channel.path)"),
    "navigate(channel.path) is only safe behind the DM-or-group return",
  );
});

test("G12 NotificationsWorker.tsx: report notifications are never filtered (R14)", () => {
  const src = load(NOTIFICATIONS);

  const onReport = functionBody(src, "onReport");
  has(onReport, "showNotification(", "scan is stale");
  assert.doesNotMatch(onReport, /slim/i, "onReport must not know Slim view");

  // Nor may what it consults before it shows one
  const head = must(
    /\bconst\s+notificationsSuppressed\s*=\s*\(\s*\)\s*=>\s*/.exec(src),
    "scan is stale: notificationsSuppressed is missing",
  );
  const from = head.index + head[0].length;
  const suppressed = src.slice(
    from,
    src[from] === "{" ? matchClose(src, from) + 1 : src.indexOf(";", from),
  );
  has(onReport, "notificationsSuppressed()", "scan is stale");
  assert.doesNotMatch(suppressed, /slim/i, "notificationsSuppressed");

  // And the listener is attached whatever Slim view says
  const listeners = calls(src, "createEffect").filter((effect) =>
    effect.includes('"reportCreate"'),
  );
  assert.equal(listeners.length, 1, "one effect attaches the listeners");
  has(listeners[0], 'client().addListener("reportCreate", onReport);');
  assert.doesNotMatch(listeners[0], /slim/i, "the listener effect");
});

test("G13 AppearanceMenu.tsx, SlimViewChoice.tsx: one toggle, off during a call", () => {
  const menu = load(APPEARANCE_MENU);
  has(menu, 'import { SlimViewChoice } from "./SlimViewChoice";');
  const mounted = openTags(menu, "SlimViewChoice");
  assert.equal(mounted.length, 1, "<SlimViewChoice /> is mounted once");
  assert.equal(squash(mounted[0].text), "<SlimViewChoice/>");

  const choice = functionBody(load(SLIM_VIEW_CHOICE), "SlimViewChoice");
  has(choice, "const inCall = () => !!voice.channel();");
  has(choice, "disabled={inCall()}");
  has(choice, 'state.settings.getValue("appearance:slim_view") === true');

  // One write, and only past the in-call refusal
  const write = 'state.settings.setValue("appearance:slim_view",';
  assert.equal(count(choice, "state.settings.setValue("), 1);
  has(choice, `${write} event.currentTarget.checked);`);
  const refusal = squash(choice).indexOf("if(inCall()){");
  assert.ok(
    refusal !== -1 && refusal < squash(choice).indexOf(squash(write)),
    "the write must come after the in-call refusal",
  );
});

test("G14 Sync.ts: the settings store stays on the device (R11)", () => {
  const src = load(SYNC);

  const keys = must(
    /\bconst\s+STORE_KEYS\b[^=]*=\s*\[([^\]]*)\]/.exec(src),
    "STORE_KEYS is missing",
  );
  const stores = stringsIn(keys[1]);
  assert.ok(stores.includes("ordering"), "scan is stale: no ordering store");
  assert.ok(
    !stores.includes("settings"),
    "the settings store must not sync: Slim view is per device",
  );

  const union = must(
    /\btype\s+SynchronisedStores\s*=([^;]*);/.exec(src),
    "SynchronisedStores is missing",
  );
  assert.ok(!stringsIn(union[1]).includes("settings"), "SynchronisedStores");
});

test("G15 Settings.ts: appearance:slim_view is a boolean, off by default", () => {
  const src = load(SETTINGS);

  // The type, EXPECTED_TYPES, DEFAULT_VALUES and default()
  const values: string[] = [];
  const all = /"appearance:slim_view"\s*:\s*([^,;}\s]+)/g;
  for (let m = all.exec(src); m; m = all.exec(src)) values.push(m[1]);
  assert.deepEqual(values.sort(), ['"boolean"', "boolean", "false", "false"]);
});

test("G16 AndroidBackWorker.tsx: Back at the Slim view root skips the drawer step", () => {
  const src = load(ANDROID_BACK);

  assert.match(
    src,
    /\bconst\s+slim\s*=\s*useSlimMode\(\);/,
    "Slim view must be resolved at setup: a back press has no owner",
  );

  // Pinned whole, polarity included: the account has loaded, Slim view is
  // on, and the path is the Slim view root
  assert.equal(
    count(
      src,
      "const atSlimRoot = lifecycle.loadedOnce() && slim() && slimIsRoot(window.location.pathname);",
    ),
    1,
    "atSlimRoot is missing or has changed",
  );

  // The drawer step is skipped there, and nowhere else
  assert.equal(
    count(src, "if (!atSlimRoot && drawer?.enabled &&"),
    1,
    "the drawer step must not run at the Slim view root",
  );
  assert.equal(count(src, "atSlimRoot"), 2, "atSlimRoot is read once");
});
