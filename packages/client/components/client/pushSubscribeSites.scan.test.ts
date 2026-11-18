// Source-scan spec for the places the client posts a push subscription
// (Sloga Slim M2, FW2 fix round, lane C2), run with Node's built-in runner
// from packages/client:
//   node --conditions=browser --test components/client/pushSubscribeSites.scan.test.ts
//
// `/push/subscribe` replaces the session's stored subscription, and with it
// the two per-device preferences (`chats_only`, `no_ring`) the previous body
// carried. A body posted without them turns both off for that device without
// a word: a phone in Slim view gets server pushes again, and a phone with
// ringing turned off rings. So every body goes through one function,
// `postSubscription` in NotificationsController.ts, which adds them with
// `withPushPrefs`. A new call site that posts directly still builds, still
// type-checks and still subscribes, so this spec reads the client's sources
// and fails when:
//
//  P0  the scanner itself is broken: it must find a site in a string or a
//      template, never one in a comment, and must have read the tree;
//  P1  the endpoint is named anywhere but once, in NotificationsController.ts;
//  P2  that one site is not
//        client.api.post("/push/subscribe", withPushPrefs(body, prefs))
//      inside the top-level function `postSubscription(client, body)`, with
//      `const prefs = currentPushPrefs(client)` there, neither `body` nor
//      `prefs` assigned again, and `withPushPrefs` the one from
//      pushPolicy.ts (not shadowed);
//  P3  `postSubscription` is exported, or declared more than once;
//  P4  stoat.js's `webPushSubscribe`, which posts a body exactly as given,
//      is used anywhere;
//  P5  the path is put together from pieces ("/push/" + "subscribe", or a
//      template `/push/${...}`).
//
// What is scanned: every .ts, .tsx, .mts, .cts, .js, .jsx, .mjs and .cjs
// file under packages/client except tests (`*.test.*`, `*.spec.*`) and the
// directories in SKIP_DIRS. A file is parsed with the TypeScript compiler
// when its text mentions `push`, `subscribe` and a slash, or
// `webPushSubscribe`; the parser tells strings from comments, so a comment
// never counts. A parsed file the parser cannot read fails the spec.
//
// WHAT THIS SPEC CANNOT CATCH. It reads literals; it never runs the app.
//  - A path that is not in the source as a literal: read from config or the
//    network, or decoded at runtime.
//  - A request sent another way with a URL it cannot see, for example
//    `fetch` with a computed URL.
//  - The native sides. On Android `PushResubscriber` posts on its own with
//    the preferences `PushToken.setPushPrefs` stored; on iOS nothing posts
//    natively. stoat.js itself is not scanned, only the client's use of it.
//  - What `withPushPrefs` and `currentPushPrefs` compute. pushPolicy.test.ts
//    and the controller harness cover those.
//
// Negative control: set `PUSH_SUBSCRIBE_ROOT` to a directory laid out like
// packages/client (a copy of its sources; node_modules is not needed),
// change one file, and run the spec. It must fail in the test for that rule.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.env.PUSH_SUBSCRIBE_ROOT || join(here, "..", ".."));

const CONTROLLER = "components/client/NotificationsController.ts";
const POLICY_IMPORT = "./pushPolicy.ts";
const ENDPOINT = "push/subscribe";

/** Build output, dependencies, native projects and browser tests. */
const SKIP_DIRS = new Set([
  "node_modules",
  "android",
  "ios",
  "public",
  "styled-system",
  "dist",
  "dev-dist",
  "e2e",
]);
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/;

// ---- Scanner ----------------------------------------------------------------

/** Every source file under `root`, as paths relative to it with "/". */
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const entries = readdirSync(join(root, rel), { withFileTypes: true });
    for (const entry of entries) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        walk(path);
      } else if (
        entry.isFile() &&
        SOURCE_FILE.test(entry.name) &&
        !TEST_FILE.test(entry.name)
      ) {
        out.push(path);
      }
    }
  };
  walk("");
  return out.sort();
}

/** Whether a file's text could hold anything the rules look at. */
function worthParsing(text: string): boolean {
  return (
    text.includes("webPushSubscribe") ||
    (text.includes("push") && text.includes("subscribe") && text.includes("/"))
  );
}

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Parse `text`. A file the parser had to recover from cannot be trusted to
 * tell strings from comments, so it fails here instead of being scanned.
 */
function parse(path: string, text: string): ts.SourceFile {
  const file = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(path),
  );
  const { parseDiagnostics } = file as unknown as {
    parseDiagnostics?: readonly ts.Diagnostic[];
  };
  assert.ok(
    Array.isArray(parseDiagnostics),
    "typescript no longer exposes parseDiagnostics on a SourceFile",
  );
  assert.deepEqual(
    parseDiagnostics.map((d) =>
      ts.flattenDiagnosticMessageText(d.messageText, " "),
    ),
    [],
    `${path} does not parse, so its strings can't be told from its comments`,
  );
  return file;
}

type Literal = { path: string; node: ts.Node; text: string };

type Scan = {
  files: string[];
  parsed: Map<string, ts.SourceFile>;
  literals: Literal[];
  /** Every identifier named `webPushSubscribe`, as `path:line`. */
  stoatHelper: string[];
};

function isStringish(node: ts.Node): node is ts.LiteralLikeNode {
  return (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  );
}

function line(file: ts.SourceFile, node: ts.Node): number {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}

/** Scan source texts keyed by their relative path. */
function scanTexts(texts: Map<string, string>): Scan {
  const scan: Scan = {
    files: [...texts.keys()],
    parsed: new Map(),
    literals: [],
    stoatHelper: [],
  };
  for (const [path, text] of texts) {
    if (!worthParsing(text)) continue;
    const file = parse(path, text);
    scan.parsed.set(path, file);
    const visit = (node: ts.Node) => {
      if (isStringish(node)) {
        scan.literals.push({ path, node, text: node.text });
      }
      if (
        (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) &&
        node.text === "webPushSubscribe"
      ) {
        scan.stoatHelper.push(`${path}:${line(file, node)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return scan;
}

let scanned: Scan | undefined;

/** The tree under ROOT, scanned once for every test. */
function tree(): Scan {
  if (!scanned) {
    const texts = new Map<string, string>();
    for (const path of sourceFiles(ROOT)) {
      texts.set(path, readFileSync(join(ROOT, path), "utf8"));
    }
    scanned = scanTexts(texts);
  }
  return scanned;
}

/** Literals that hold the whole endpoint. */
function endpointSites(scan: Scan): Literal[] {
  return scan.literals.filter((l) => l.text.includes(ENDPOINT));
}

/** Literals that look like one piece of the endpoint. */
function endpointPieces(scan: Scan): Literal[] {
  return scan.literals.filter(
    (l) =>
      !l.text.includes(ENDPOINT) &&
      (/\/push\/?$/.test(l.text) ||
        l.text === "push/" ||
        l.text.startsWith("/subscribe")),
  );
}

function where(l: Literal): string {
  const file = l.node.getSourceFile();
  return `${l.path}:${line(file, l.node)}`;
}

function controller(): ts.SourceFile {
  const file = tree().parsed.get(CONTROLLER);
  assert.ok(file, `${CONTROLLER} was not found or not parsed`);
  return file;
}

/** The top-level function declarations of `file` named `name`. */
function topLevelFunctions(
  file: ts.SourceFile,
  name: string,
): ts.FunctionDeclaration[] {
  return file.statements.filter(
    (s): s is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(s) && s.name?.text === name,
  );
}

/** Every node under `root`, depth first. */
function descendants(root: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    out.push(node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(root, visit);
  return out;
}

/** Whether `node` assigns to the plain name `name` (`=`, `+=`, `++`, ...). */
function assignsTo(node: ts.Node, name: string): boolean {
  const named = (n: ts.Node) => ts.isIdentifier(n) && n.text === name;
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return named(node.left);
  }
  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return named(node.operand);
  }
  return false;
}

/** Whether `node` declares the name `name` (a variable, function or parameter). */
function declares(node: ts.Node, name: string): boolean {
  return (
    (ts.isVariableDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isParameter(node) ||
      ts.isClassDeclaration(node)) &&
    !!node.name &&
    ts.isIdentifier(node.name) &&
    node.name.text === name
  );
}

// ---- P0: the scanner --------------------------------------------------------

test("P0: strings and templates count, comments never do", () => {
  const scan = scanTexts(
    new Map([
      [
        "a.ts",
        [
          '// client.api.post("/push/subscribe", body)',
          '/* "/push/subscribe" */',
          "/** `/push/subscribe` */",
          'const a = "/push/subscribe";',
          "const b = `/push/subscribe`;",
          "const c = `${base}/push/subscribe`;",
          'const d = "/push/" + "subscribe";',
          "const e = `/push/${x}`;",
          'const f = "/push/unsubscribe";',
          'const g = "subscribe";',
          "client.account.webPushSubscribe(sub);",
        ].join("\n"),
      ],
      [
        "b.tsx",
        "const v = <p>can't see /push/subscribe here</p>;\n" +
          'const w = <a href="/push/subscribe" />;',
      ],
      ["c.mjs", "// push/subscribe webPushSubscribe\nexport {};"],
    ]),
  );
  assert.deepEqual(
    endpointSites(scan).map((l) => `${l.path}:${l.text}`),
    [
      "a.ts:/push/subscribe",
      "a.ts:/push/subscribe",
      "a.ts:/push/subscribe",
      "b.tsx:/push/subscribe",
    ],
  );
  assert.deepEqual(
    endpointPieces(scan).map((l) => l.text),
    ["/push/", "/push/"],
  );
  assert.deepEqual(scan.stoatHelper, ["a.ts:11"]);
  // Text that never mentions the endpoint is not parsed at all
  const plain = scanTexts(new Map([["d.ts", 'const x = "push";']]));
  assert.equal(plain.parsed.size, 0);
  // A file the parser cannot read fails instead of passing unread
  assert.throws(
    () =>
      scanTexts(
        new Map([["e.ts", 'const x = "/push/subscribe";\nfunction (']]),
      ),
    /does not parse/,
  );
});

test("P0: the tree was read, tests and dependencies were not", () => {
  const scan = tree();
  assert.ok(
    scan.files.length >= 500,
    `only ${scan.files.length} source files under ${ROOT}`,
  );
  for (const path of [
    CONTROLLER,
    "components/client/Controller.ts",
    "components/client/pushPolicy.ts",
    "src/index.tsx",
  ]) {
    assert.ok(scan.files.includes(path), `${path} was not scanned`);
  }
  assert.ok(scan.parsed.has(CONTROLLER), `${CONTROLLER} was not parsed`);
  assert.deepEqual(
    scan.files.filter(
      (p) => TEST_FILE.test(p) || p.split("/").some((d) => SKIP_DIRS.has(d)),
    ),
    [],
  );
});

// ---- P1: one site -----------------------------------------------------------

test("P1: the endpoint is named exactly once, in NotificationsController.ts", () => {
  const sites = endpointSites(tree());
  assert.deepEqual(
    sites.map((l) => l.path),
    [CONTROLLER],
    `every /push/subscribe body must be posted by postSubscription; found ${
      sites.map(where).join(", ") || "none"
    }`,
  );
  assert.equal(sites[0].text, "/push/subscribe");
});

// ---- P2: the site is postSubscription's, with the preferences ---------------

test("P2: the one site is postSubscription's post, through withPushPrefs", () => {
  const [site] = endpointSites(tree());
  assert.ok(site, "no /push/subscribe site at all");
  assert.equal(site.path, CONTROLLER);

  // client.api.post("/push/subscribe", withPushPrefs(body, prefs))
  const call = site.node.parent;
  assert.ok(ts.isCallExpression(call), "the path is not a call's argument");
  const file = controller();
  assert.equal(call.expression.getText(file), "client.api.post");
  assert.equal(call.arguments.length, 2);
  assert.equal(call.arguments[0], site.node);
  const wrapped = call.arguments[1];
  assert.ok(
    ts.isCallExpression(wrapped),
    "the body is not wrapped in withPushPrefs(...)",
  );
  assert.equal(wrapped.expression.getText(file), "withPushPrefs");
  assert.deepEqual(
    wrapped.arguments.map((a) => a.getText(file)),
    ["body", "prefs"],
  );

  // ... inside the top-level function postSubscription(client, body)
  let fn: ts.Node = call;
  while (!ts.isFunctionLike(fn) && !ts.isSourceFile(fn)) fn = fn.parent;
  assert.ok(
    ts.isFunctionDeclaration(fn) && fn.name?.text === "postSubscription",
    "the post is not directly inside postSubscription",
  );
  assert.equal(fn.parent, file, "postSubscription is not top-level");
  assert.deepEqual(
    fn.parameters.map((p) => p.name.getText(file)),
    ["client", "body"],
  );
  assert.ok(fn.body);

  // ... where prefs is read fresh, once, and neither name is assigned again
  const inside = descendants(fn.body);
  const prefsDecls = inside.filter((n) => declares(n, "prefs"));
  assert.equal(prefsDecls.length, 1, "prefs is declared more than once");
  const [prefs] = prefsDecls;
  assert.ok(ts.isVariableDeclaration(prefs));
  assert.equal(prefs.initializer?.getText(file), "currentPushPrefs(client)");
  assert.ok(
    ts.isVariableDeclarationList(prefs.parent) &&
      (prefs.parent.flags & ts.NodeFlags.Const) !== 0,
    "prefs is not a const",
  );
  assert.deepEqual(
    inside.filter((n) => declares(n, "body") || declares(n, "client")),
    [],
    "body or client is declared again inside postSubscription",
  );
  for (const name of ["body", "prefs", "client"]) {
    assert.deepEqual(
      inside.filter((n) => assignsTo(n, name)).map((n) => n.getText(file)),
      [],
      `${name} is assigned inside postSubscription`,
    );
  }

  // ... and withPushPrefs is pushPolicy.ts's, not a local stand-in
  const imported = file.statements.filter(
    (s): s is ts.ImportDeclaration =>
      ts.isImportDeclaration(s) &&
      !!s.importClause?.namedBindings &&
      ts.isNamedImports(s.importClause.namedBindings) &&
      s.importClause.namedBindings.elements.some(
        (e) => e.name.text === "withPushPrefs",
      ),
  );
  assert.deepEqual(
    imported.map((s) => (s.moduleSpecifier as ts.StringLiteral).text),
    [POLICY_IMPORT],
  );
  const binding = (
    imported[0].importClause!.namedBindings as ts.NamedImports
  ).elements.find((e) => e.name.text === "withPushPrefs")!;
  assert.equal(
    binding.propertyName,
    undefined,
    "withPushPrefs is imported under another name",
  );
  assert.deepEqual(
    descendants(file)
      .filter((n) => declares(n, "withPushPrefs"))
      .map((n) => n.getText(file).slice(0, 60)),
    [],
    "withPushPrefs is declared in the controller, shadowing the import",
  );
  assert.equal(
    topLevelFunctions(file, "currentPushPrefs").length,
    1,
    "currentPushPrefs is not declared exactly once",
  );
});

// ---- P3: nobody else calls postSubscription --------------------------------

test("P3: postSubscription is declared once and not exported", () => {
  const file = controller();
  const decls = descendants(file).filter((n) =>
    declares(n, "postSubscription"),
  );
  assert.equal(decls.length, 1, "postSubscription is declared more than once");
  const [fn] = topLevelFunctions(file, "postSubscription");
  assert.ok(fn, "postSubscription is not a top-level function");
  assert.equal(
    ts.getCombinedModifierFlags(fn) &
      (ts.ModifierFlags.Export | ts.ModifierFlags.Default),
    0,
    "postSubscription is exported",
  );
  const reExports = file.statements.filter(
    (s) =>
      (ts.isExportDeclaration(s) &&
        !!s.exportClause &&
        ts.isNamedExports(s.exportClause) &&
        s.exportClause.elements.some(
          (e) =>
            (e.propertyName ?? e.name).getText(file) === "postSubscription",
        )) ||
      (ts.isExportAssignment(s) &&
        s.expression.getText(file) === "postSubscription"),
  );
  assert.deepEqual(
    reExports.map((s) => s.getText(file)),
    [],
    "postSubscription is exported",
  );
});

// ---- P4: no stoat.js helper -------------------------------------------------

test("P4: stoat.js's webPushSubscribe is never used", () => {
  assert.deepEqual(
    tree().stoatHelper,
    [],
    "webPushSubscribe posts a body without the preferences; use postSubscription",
  );
});

// ---- P5: no pieces ----------------------------------------------------------

test("P5: the path is never put together from pieces", () => {
  assert.deepEqual(endpointPieces(tree()).map(where), []);
});
