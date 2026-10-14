// Unit spec for which ModalRenderer draws a modal — run with Node's built-in
// runner from packages/client:
//   node --conditions=browser --test components/modal/modalWindow.test.ts
// Declared test count: 7 (compare against the runner's pass count, since the
// runner also exits 0 when it finds no tests at all).
// Focus: a modal is drawn by exactly one renderer for every combination of
// stamped window, renderer and window availability; a modal for a closed (or
// renderer-less) chat window falls back to main; and an unstamped modal or an
// unnamed renderer means main.
import assert from "node:assert/strict";
import { test } from "node:test";

import { MAIN_WINDOW_ID, modalRendersIn } from "./modalWindow.ts";

const RENDERERS = [undefined, "main", "chat-1", "chat-2"] as const;

/** Renderers that would draw a modal stamped `target`, given `open` windows. */
function drawnBy(target: string | undefined, open: ReadonlySet<string>) {
  return RENDERERS.filter(
    (renderer) =>
      // `undefined` and "main" are the same renderer; count it once.
      renderer !== "main" &&
      modalRendersIn(target, renderer, (id) => {
        assert.notEqual(id, MAIN_WINDOW_ID, "main is never looked up");
        return open.has(id);
      }),
  ).map((renderer) => renderer ?? MAIN_WINDOW_ID);
}

test("an unstamped modal and the unnamed renderer both mean main", () => {
  assert.equal(
    modalRendersIn(undefined, undefined, () => false),
    true,
  );
  assert.equal(
    modalRendersIn(undefined, "main", () => false),
    true,
  );
  assert.equal(
    modalRendersIn("main", undefined, () => false),
    true,
  );
  assert.equal(
    modalRendersIn(undefined, "chat-1", () => true),
    false,
  );
});

test("a modal for an open chat window is drawn there and not in main", () => {
  const open = new Set(["chat-1"]);
  assert.deepEqual(drawnBy("chat-1", open), ["chat-1"]);
});

test("a modal for a closed chat window falls back to main", () => {
  assert.deepEqual(drawnBy("chat-1", new Set()), ["main"]);
  assert.deepEqual(drawnBy("chat-1", new Set(["chat-2"])), ["main"]);
});

test("a chat window's renderer never draws another window's modal", () => {
  const open = new Set(["chat-1", "chat-2"]);
  assert.equal(
    modalRendersIn("chat-2", "chat-1", (id) => open.has(id)),
    false,
  );
  assert.equal(
    modalRendersIn("main", "chat-1", (id) => open.has(id)),
    false,
  );
});

test("a renderer outliving its window lets go so main is the only one", () => {
  // The window is unregistered while its renderer is still mounted.
  assert.equal(
    modalRendersIn("chat-1", "chat-1", () => false),
    false,
  );
  assert.deepEqual(drawnBy("chat-1", new Set()), ["main"]);
});

test("a stamp for a window that never existed falls back to main", () => {
  assert.deepEqual(drawnBy("chat-99", new Set(["chat-1"])), ["main"]);
});

test("every modal is drawn by exactly one renderer", () => {
  const targets = [undefined, "main", "chat-1", "chat-2", "chat-3"];
  const worlds = [
    new Set<string>(),
    new Set(["chat-1"]),
    new Set(["chat-2"]),
    new Set(["chat-1", "chat-2"]),
  ];
  for (const open of worlds) {
    for (const target of targets) {
      assert.equal(
        drawnBy(target, open).length,
        1,
        `target ${target} with open [${[...open]}]`,
      );
    }
  }
});
