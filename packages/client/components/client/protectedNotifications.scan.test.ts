// Source-scan spec for the Protected channels wiring in
// `NotificationsWorker.tsx` (W4 lane C18; plan D22, D25; W4b audit M3).
// The worker cannot load under Node (Solid JSX, lingui macros, stoat.js), so
// this reads it as text. Where a rule is a decision, the snippet that makes
// it is lifted out of the source, its types are stripped, and it runs with
// stubs, so the asserted behaviour is the code in the file:
//
//  N1  a Protected channel row (carries `encrypted`, or its channel is
//      protected/pinned) never shows server content, a forwarded snapshot,
//      a system message, attachments or an image; its body is the fixed
//      `notificationCopy.body()` and it offers no reply. Other rows keep
//      their body (C-C18a);
//  N2  signing out disposes the bridge's Protected channel manager through
//      the lifecycle's `onSignOut` hook (C-C18b);
//  N3  the draft store is bound to the current client from an effect
//      (C-C18c);
//  N4  each `protectedToast` entry shows once, through the snackbar, as
//      `toastCopy(kind)` only (C-C18d).
//
// Run: node --test --conditions=browser components/client/protectedNotifications.scan.test.ts
// `PROTECTED_NOTIFICATIONS_TSX=<path>` scans another copy (named controls;
// the 7a1e03ca worker is the known-bad baseline and fails N1-N4).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

const FILE =
  process.env.PROTECTED_NOTIFICATIONS_TSX ||
  new URL("./NotificationsWorker.tsx", import.meta.url);
const SRC = readFileSync(FILE, "utf8");

const E2EE = readFileSync(new URL("./e2ee.ts", import.meta.url), "utf8");
const CONTROLLER = readFileSync(
  new URL("./Controller.ts", import.meta.url),
  "utf8",
);
const DRAFT = readFileSync(
  new URL("../state/stores/Draft.ts", import.meta.url),
  "utf8",
);

// ---- Source helpers ---------------------------------------------------------

/** The text from `start` up to (not including) `end`; each exactly once. */
function between(src: string, start: string, end: string): string {
  const count = src.split(start).length - 1;
  assert.equal(count, 1, `expected exactly one ${JSON.stringify(start)}`);
  const from = src.indexOf(start);
  const to = src.indexOf(end, from + start.length);
  assert.ok(to > from, `no ${JSON.stringify(end)} after ${start}`);
  return src.slice(from, to);
}

/** A module-level function's source, from `function name(` to its `\n}`. */
function moduleFunction(name: string): string {
  return between(SRC, `\nfunction ${name}(`, "\n}\n") + "\n}";
}

/** Run TypeScript `code` as a function body over `scope`. */
function run(code: string, scope: Record<string, unknown>): unknown {
  // Wrapped first: the stripper parses a module, where `return` is invalid
  const js = stripTypeScriptTypes(`function __body() {\n${code}\n}`);
  return new Function(...Object.keys(scope), `${js}\nreturn __body();`)(
    ...Object.values(scope),
  );
}

/** The lingui `t` macro as a plain template tag. */
const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
  String.raw({ raw: strings }, ...values);

const PROTECTED_BODY = "PROTECTED-BODY";
const notificationCopy = { body: () => PROTECTED_BODY };

const SECRET = "SERVER-TEXT";

/** A message stub; every field that could carry server text holds SECRET. */
function message(overrides: Record<string, unknown> = {}) {
  return {
    id: "m1",
    channelId: "c1",
    encrypted: undefined,
    content: SECRET,
    contentPlain: SECRET,
    forwarded: { content: SECRET },
    systemMessage: { type: "text", content: SECRET },
    attachments: [
      { metadata: { type: "Image" }, previewUrl: `https://cdn/${SECRET}` },
    ],
    avatarURL: "https://avatar",
    ...overrides,
  };
}

/** `isProtectedRow` from the worker. */
function isProtectedRow(
  msg: ReturnType<typeof message>,
  protectedChannels: string[],
): boolean {
  const fn = run(
    `${moduleFunction("isProtectedRow")}\nreturn isProtectedRow;`,
    {},
  ) as (m: unknown, c: unknown) => boolean;
  return fn(msg, {
    isProtectedChannel: (id: string) => protectedChannels.includes(id),
  });
}

/** The body/icon chain of `onMessage`, run over a message. */
function bodyFor(msg: ReturnType<typeof message>, protectedRow: boolean) {
  const chain = between(
    SRC,
    "    let body, icon;\n",
    "\n    // Don't continue if we don't have notification permissions",
  );
  return run(`${chain}\nreturn { body, icon };`, {
    message: msg,
    protectedRow,
    t,
    notificationCopy,
  }) as { body: unknown; icon: unknown };
}

/** The image expression of `onMessage`, run over a message. */
function imageFor(msg: ReturnType<typeof message>, protectedRow: boolean) {
  const decl = between(SRC, "    const image = ", "\n\n    // Find body/icon");
  return run(`${decl}\nreturn image;`, { message: msg, protectedRow });
}

/** `onMessage`'s `decide`, over a permissive policy decision. */
function decideFor(protectedRow: boolean, e2eeGate = "notify") {
  const decl = between(
    SRC,
    "    const decide = ",
    "\n    // Our toast is for direct messages",
  );
  const decide = run(`${decl}\nreturn decide;`, {
    protectedRow,
    e2eeGate,
    policy: {},
    decidePreview: () => ({
      show: true,
      playSound: true,
      showBody: true,
      showImage: true,
      allowReply: true,
    }),
  }) as (surface: string) => Record<string, boolean>;
  return decide("sloga_toast");
}

// ---- N1: protected rows never show server text --------------------------------

test("N1 a protected row is recognised by `encrypted` or by its channel", () => {
  assert.equal(
    isProtectedRow(message({ encrypted: { ciphertext: "x" } }), []),
    true,
  );
  assert.equal(isProtectedRow(message(), ["c1"]), true);
  assert.equal(isProtectedRow(message(), ["other"]), false);
});

test("N1 onMessage decides the row on the receiving client, before the policy", () => {
  const onMessage = between(
    SRC,
    "  async function onMessage(message: Message) {",
    "\n  /**\n   * Handle incoming voice call",
  );
  assert.match(onMessage, /const receiver = client\(\);/);
  const decided = onMessage.indexOf(
    "const protectedRow = isProtectedRow(message, receiver);",
  );
  assert.ok(decided > 0, "protectedRow must come from isProtectedRow");
  assert.ok(
    decided < onMessage.indexOf("const policy"),
    "protectedRow must be decided before the preview policy",
  );
  assert.ok(
    decided > onMessage.lastIndexOf("await conversationE2EEMode"),
    "protectedRow must be decided after the E2EE lookup's await",
  );
});

test("N1 a protected row's body is the fixed copy, never server text", () => {
  for (const msg of [
    message(),
    message({ content: "", contentPlain: "" }),
    message({ content: "", forwarded: undefined }),
    message({ content: "", forwarded: undefined, systemMessage: undefined }),
  ]) {
    const { body, icon } = bodyFor(msg, true);
    assert.equal(body, PROTECTED_BODY);
    assert.equal(icon, "https://avatar");
    assert.ok(!String(body).includes(SECRET));
  }
  assert.equal(imageFor(message(), true), undefined);
});

test("N1 a protected row offers no image and no reply, and keeps its body", () => {
  const decision = decideFor(true);
  assert.equal(decision.showImage, false);
  assert.equal(decision.allowReply, false);
  assert.equal(decision.showBody, true);
});

test("N1 other rows are unchanged", () => {
  assert.equal(bodyFor(message(), false).body, SECRET);
  assert.equal(
    bodyFor(message({ content: "" }), false).body,
    SECRET,
    "forwarded snapshot",
  );
  assert.equal(
    bodyFor(
      message({
        content: "",
        forwarded: undefined,
        systemMessage: undefined,
        attachments: [{ metadata: { type: "File" } }, { metadata: {} }],
      }),
      false,
    ).body,
    "Sent 2 attachments",
  );
  assert.equal(imageFor(message(), false), `https://cdn/${SECRET}`);
  const decision = decideFor(false);
  assert.equal(decision.showImage, true);
  assert.equal(decision.allowReply, true);
  const sealed = decideFor(false, "sender_only");
  assert.equal(sealed.showBody, false);
});

// ---- N2: sign-out disposes the manager ----------------------------------------

test("N2 sign-out disposes the Protected channel manager", () => {
  assert.match(
    SRC,
    /\n {2}const bridge = \(\) => client\(\)\?\.e2ee as E2EEBridge \| undefined;\n/,
  );
  assert.match(
    SRC,
    /\n {2}onCleanup\(lifecycle\.onSignOut\(\(\) => bridge\(\)\?\.disposeProtected\?\.\(\)\)\);\n/,
    "registered at component scope, unsubscribed on cleanup",
  );
  // The names this relies on, so a rename fails here and not in production.
  assert.match(
    CONTROLLER,
    /\n {2}onSignOut\(hook: \(\) => void\): \(\) => void \{/,
  );
  assert.match(E2EE, /\n {2}disposeProtected\(\): void \{/);
});

// ---- N3: the draft store follows the client -----------------------------------

test("N3 the draft store is bound to the current client", () => {
  assert.match(
    SRC,
    /\n {2}createEffect\(\(\) => \{\n {4}const c = client\(\);\n {4}if \(c\) untrack\(\(\) => state\.draft\.bindClient\(c\)\);\n {2}\}\);\n/,
  );
  assert.match(DRAFT, /\n {2}bindClient\(client: Client\) \{/);
});

// ---- N4: each toast entry shows once ------------------------------------------

test("N4 takeNewProtectedToasts yields each entry once", () => {
  const take = run(
    `${moduleFunction("takeNewProtectedToasts")}\nreturn takeNewProtectedToasts;`,
    {},
  ) as (
    shown: Map<string, number>,
    entries: Iterable<[string, { kind: string; at: number }]>,
  ) => string[];
  const shown = new Map<string, number>();
  const first = [["state", { kind: "unsolicited_welcome", at: 1 }]] as [
    string,
    { kind: string; at: number },
  ][];
  assert.deepEqual(take(shown, first), ["unsolicited_welcome"]);
  assert.deepEqual(take(shown, first), [], "the same entry again");
  assert.deepEqual(take(shown, []), [], "a cleared map");
  assert.deepEqual(
    take(shown, [["state", { kind: "unsolicited_welcome", at: 2 }]]),
    ["unsolicited_welcome"],
    "a new entry under the same key",
  );
});

test("N4 the toast effect shows toastCopy(kind) only, through the snackbar", () => {
  assert.match(
    SRC,
    /\nconst shownProtectedToasts = new WeakMap<object, Map<string, number>>\(\);\n/,
    "shown entries survive a remount (module scope)",
  );
  const effect = between(
    SRC,
    "    const toasts = e2ee?.protectedToast;",
    "\n  // Tell the native layer",
  );
  assert.match(
    effect,
    /const fresh = takeNewProtectedToasts\(shown, toasts\.entries\(\)\);/,
  );
  assert.match(effect, /message: toastCopy\(kind\),/);
  assert.equal(
    SRC.split("snackbar.show(").length - 1,
    1,
    "the toast effect is the worker's only snackbar",
  );
  const show = between(effect, "snackbar.show({", "});");
  assert.doesNotMatch(show, /\bid\b|content|text|channel/i);
});
