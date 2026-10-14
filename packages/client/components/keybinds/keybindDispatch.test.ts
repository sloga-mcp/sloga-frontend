/**
 * The chat-window dispatch rule behind `KeybindContext`
 * (`./keybindHandler.tsx`): which window's callbacks a key event may fire.
 *
 * `keybindHandler.tsx` is a `.tsx` that `node --test` cannot load, so the
 * rule lives there as one pure, import-free function inside a marked region.
 * This spec lifts that region out of the source, strips its types and runs
 * it, then pins the few lines of wiring that make the handler obey it.
 *
 * Run: `node --test --conditions=browser components/keybinds/keybindDispatch.test.ts`
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

const SOURCE = readFileSync(
  new URL("./keybindHandler.tsx", import.meta.url),
  "utf8",
);

const START = "// #region keybind-dispatch-rule";
const END = "// #endregion keybind-dispatch-rule";

function region(): string {
  const start = SOURCE.indexOf(START);
  const end = SOURCE.indexOf(END);
  assert.ok(start >= 0, "keybindHandler.tsx has the dispatch-rule region");
  assert.ok(end > start, "the dispatch-rule region is closed");
  return SOURCE.slice(start + START.length, end);
}

const REGION = region();

const { keybindCallbackFires } = (await import(
  "data:text/javascript," + encodeURIComponent(stripTypeScriptTypes(REGION))
)) as {
  keybindCallbackFires: (callbackCtxId: string, eventCtxId: string) => boolean;
};

const MAIN = "main";

test("the region is import-free, so lifting it out cannot silently drop a dependency", () => {
  assert.equal(typeof keybindCallbackFires, "function");
  assert.doesNotMatch(REGION, /^\s*import\s|\bimport\(|\brequire\(/m);
});

test("main's events fire main-tagged callbacks", () => {
  assert.equal(keybindCallbackFires(MAIN, MAIN), true);
});

test("a chat window's events fire that window's callbacks", () => {
  assert.equal(keybindCallbackFires("chat-1", "chat-1"), true);
});

test("no fallback: main-tagged callbacks never fire for a chat window's events", () => {
  assert.equal(keybindCallbackFires(MAIN, "chat-1"), false);
  assert.equal(keybindCallbackFires(MAIN, "friends-window"), false);
});

test("no fallback the other way: a chat window's callbacks never fire for main's events", () => {
  assert.equal(keybindCallbackFires("chat-1", MAIN), false);
});

test("a chat window's callbacks never fire for another chat window's events", () => {
  assert.equal(keybindCallbackFires("chat-1", "chat-2"), false);
  assert.equal(keybindCallbackFires("chat-2", "chat-1"), false);
});

/*
 * Wiring pins. Kept to the lines that decide WHICH callbacks fire; the rest
 * of the handler is covered by type-checking and the browser harness.
 */

/** Body of `createKeybind(keybind, callback) {` inside the provider. */
function createKeybindBody(): string {
  const start = SOURCE.indexOf("createKeybind(keybind, callback) {");
  assert.ok(start >= 0, "the provider's createKeybind exists");
  const end = SOURCE.indexOf("dismissTopmost,\n", start);
  assert.ok(end > start, "the provider's createKeybind has an end");
  return SOURCE.slice(start, end);
}

test("createKeybind tags each registration with the caller's window", () => {
  assert.match(createKeybindBody(), /const ctxId = useWindowCtx\(\)\.id;/);
});

test("the main-window effect is gated by the rule", () => {
  const body = createKeybindBody();
  const guard = body.indexOf("if (keybindCallbackFires(ctxId, MAIN_CTX.id)) {");
  const fired = body.indexOf("if (isFired(keybind)) {");
  assert.ok(guard >= 0, "the main effect is gated by the rule");
  assert.ok(fired > guard, "the main effect sits inside that gate");
});

test("chat-window effects are created only for windows the rule selects", () => {
  assert.match(
    createKeybindBody(),
    /childSources\(\)\.filter\(\(source\) =>\s*keybindCallbackFires\(ctxId, source\.ctx\.id\),?\s*\)/,
  );
});

test("a chat window's firing() counts only callbacks tagged with that window", () => {
  assert.match(
    SOURCE,
    /firing\(source\.activeKeys, source\.target, countsFor\(source\.ctx\.id\)\)/,
  );
  // Main's evaluation reads main's own counter record, never a merged one.
  assert.match(SOURCE, /const currentlyBound = countsFor\(MAIN_CTX\.id\);/);
  assert.match(
    SOURCE,
    /firing\(activeKeys, target, currentlyBound\) === keybind/,
  );
});
