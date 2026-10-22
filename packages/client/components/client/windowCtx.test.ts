/**
 * Run with:
 *
 *     node --conditions=browser --test components/client/windowCtx.test.ts
 *
 * (`--conditions=browser` matters here: without it Node resolves solid-js's
 * server build, whose signals do not propagate, and the reactivity cases
 * below would pass or fail for the wrong reason.)
 *
 * `windowCtx.ts` decides which window a modal opens in (`lastFocusedCtx`),
 * whether an orphaned modal falls back to main (`windowCtxById`), and which
 * conversations suppress notifications (`focusedConversations`). Windows are
 * faked: a `focus` / `blur` listener surface, `closed`, and `doc.hasFocus()`.
 *
 * The static import below is evaluated before any DOM global is stubbed, so
 * merely loading this file pins that the module never reads `document` /
 * `window` at init.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { createComponent, createComputed, createRoot } from "solid-js";

import {
  type WindowCtx,
  MAIN_CTX,
  WindowCtxProvider,
  allWindowCtxs,
  focusedConversations,
  lastFocusedCtx,
  registerWindowCtx,
  setFocusedConversation,
  useWindowCtx,
  windowCtxById,
} from "./windowCtx.ts";

type Fake = {
  ctx: WindowCtx;
  focus(): void;
  blur(): void;
  close(): void;
  listenerCount(): number;
};

function fakeWindow(id: string): Fake {
  const listeners = new Map<string, Set<() => void>>();
  let focused = false;
  let closed = false;
  const fire = (type: string) => {
    for (const fn of listeners.get(type) ?? []) fn();
  };
  const win = {
    get closed() {
      return closed;
    },
    addEventListener(type: string, fn: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.get(type)?.delete(fn);
    },
  };
  const doc = { hasFocus: () => focused };
  return {
    ctx: {
      id,
      doc: doc as unknown as Document,
      win: win as unknown as Window,
      floatingMount: () => {
        throw new Error("not used");
      },
      isActive: () => focused,
    },
    focus() {
      focused = true;
      fire("focus");
    },
    blur() {
      focused = false;
      fire("blur");
    },
    close() {
      focused = false;
      closed = true;
    },
    listenerCount() {
      let n = 0;
      for (const set of listeners.values()) n += set.size;
      return n;
    },
  };
}

// The main window, stubbed after module load. MAIN_CTX resolves the globals
// lazily, and main focus tracking starts at the first registration.
const main = fakeWindow("main-fake");
(globalThis as Record<string, unknown>).window = main.ctx.win;
(globalThis as Record<string, unknown>).document = main.ctx.doc;

const cleanups: (() => void)[] = [];
function register(f: Fake) {
  const off = registerWindowCtx(f.ctx);
  cleanups.push(off);
  return off;
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  main.blur();
});

describe("context", () => {
  it("useWindowCtx is MAIN_CTX outside any provider", () => {
    assert.equal(useWindowCtx(), MAIN_CTX);
    createRoot((dispose) => {
      assert.equal(useWindowCtx(), MAIN_CTX);
      dispose();
    });
  });

  it("WindowCtxProvider hands its value to descendants", () => {
    const child = fakeWindow("chat-p");
    let seen: WindowCtx | undefined;
    createRoot((dispose) => {
      createComponent(WindowCtxProvider, {
        value: child.ctx,
        get children() {
          seen = useWindowCtx();
          return undefined;
        },
      });
      dispose();
    });
    assert.equal(seen, child.ctx);
  });

  it("MAIN_CTX resolves the live globals", () => {
    assert.equal(MAIN_CTX.id, "main");
    assert.equal(MAIN_CTX.win, main.ctx.win);
    assert.equal(MAIN_CTX.doc, main.ctx.doc);
  });
});

describe("lookups", () => {
  it('windowCtxById("main") is MAIN_CTX, unknown ids are undefined', () => {
    assert.equal(windowCtxById("main"), MAIN_CTX);
    assert.equal(windowCtxById("chat-nope"), undefined);
  });

  it("registered children resolve until unregistered or closed", () => {
    const a = fakeWindow("chat-a");
    const b = fakeWindow("chat-b");
    const offA = register(a);
    register(b);

    assert.equal(windowCtxById("chat-a"), a.ctx);
    assert.deepEqual(allWindowCtxs(), [MAIN_CTX, a.ctx, b.ctx]);

    offA();
    assert.equal(windowCtxById("chat-a"), undefined);

    b.close();
    assert.equal(
      windowCtxById("chat-b"),
      undefined,
      "a closed child is gone before its unregister runs",
    );
    assert.deepEqual(allWindowCtxs(), [MAIN_CTX]);
  });

  it('registering id "main" is a no-op', () => {
    const impostor = fakeWindow("main");
    register(impostor);
    assert.equal(windowCtxById("main"), MAIN_CTX);
    assert.deepEqual(allWindowCtxs(), [MAIN_CTX]);
    assert.equal(impostor.listenerCount(), 0);
  });

  it("windowCtxById is reactive on register / unregister", () => {
    const a = fakeWindow("chat-r");
    const seen: (WindowCtx | undefined)[] = [];
    createRoot((dispose) => {
      createComputed(() => seen.push(windowCtxById("chat-r")));
      const off = register(a);
      off();
      dispose();
    });
    assert.deepEqual(seen, [undefined, a.ctx, undefined]);
  });

  it("unregister removes the focus listeners and is idempotent", () => {
    const a = fakeWindow("chat-l");
    const off = register(a);
    assert.equal(a.listenerCount(), 2);
    off();
    off();
    assert.equal(a.listenerCount(), 0);
  });
});

describe("lastFocusedCtx", () => {
  it("is MAIN_CTX with no children", () => {
    assert.equal(lastFocusedCtx(), MAIN_CTX);
  });

  it("is MAIN_CTX when a registered child was never focused", () => {
    register(fakeWindow("chat-idle"));
    assert.equal(lastFocusedCtx(), MAIN_CTX);
  });

  it("follows focus, and keeps the last one once everything blurs", () => {
    const a = fakeWindow("chat-f1");
    const b = fakeWindow("chat-f2");
    register(a);
    register(b);

    a.focus();
    assert.equal(lastFocusedCtx(), a.ctx);
    a.blur();
    b.focus();
    assert.equal(lastFocusedCtx(), b.ctx);
    b.blur();
    assert.equal(lastFocusedCtx(), b.ctx, "app in background: last one wins");

    main.focus();
    assert.equal(lastFocusedCtx(), MAIN_CTX);
    main.blur();
    assert.equal(lastFocusedCtx(), MAIN_CTX);
  });

  it("falls back to MAIN_CTX when the last-focused child closes", () => {
    const a = fakeWindow("chat-c");
    const off = register(a);
    a.focus();
    a.close();
    assert.equal(lastFocusedCtx(), MAIN_CTX, "closed, not yet unregistered");
    off();
    assert.equal(lastFocusedCtx(), MAIN_CTX);
  });

  it("counts a child that already had focus when it was registered", () => {
    const a = fakeWindow("chat-pre");
    a.focus(); // before any listener exists
    register(a);
    a.blur();
    assert.equal(lastFocusedCtx(), a.ctx);
  });
});

describe("focusedConversations", () => {
  it("holds a channel only while its window is focused", () => {
    const a = fakeWindow("chat-fc");
    register(a);
    setFocusedConversation("chat-fc", "C1");
    assert.equal(focusedConversations().size, 0, "unfocused window");

    a.focus();
    assert.deepEqual([...focusedConversations()], ["C1"]);

    a.blur();
    assert.equal(focusedConversations().size, 0);

    a.focus();
    setFocusedConversation("chat-fc", "C2");
    assert.deepEqual([...focusedConversations()], ["C2"]);

    setFocusedConversation("chat-fc", null);
    assert.equal(focusedConversations().size, 0);
  });

  it("is cleared when the window unregisters", () => {
    const a = fakeWindow("chat-fu");
    const off = register(a);
    a.focus();
    setFocusedConversation("chat-fu", "C3");
    assert.ok(focusedConversations().has("C3"));
    off();
    assert.equal(focusedConversations().size, 0);

    // The entry itself is dropped, not just hidden: the same id coming back
    // must not resurrect the old window's conversation.
    const again = fakeWindow("chat-fu");
    register(again);
    again.focus();
    assert.equal(focusedConversations().size, 0);
  });

  it("ignores main and unregistered ids", () => {
    main.focus();
    setFocusedConversation("main", "CM");
    setFocusedConversation("chat-ghost", "CG");
    assert.equal(focusedConversations().size, 0);
    setFocusedConversation("main", null);
    setFocusedConversation("chat-ghost", null);
  });

  it("is reactive, and only notifies when the set changes", () => {
    const a = fakeWindow("chat-rx");
    register(a);
    const seen: string[][] = [];
    createRoot((dispose) => {
      createComputed(() => seen.push([...focusedConversations()].sort()));
      setFocusedConversation("chat-rx", "C4");
      a.focus();
      a.blur();
      a.blur(); // no change: no notification
      a.focus();
      setFocusedConversation("chat-rx", null);
      dispose();
    });
    assert.deepEqual(seen, [[], ["C4"], [], ["C4"], []]);
  });
});
