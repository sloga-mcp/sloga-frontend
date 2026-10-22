// Unit spec for the chat-window clipboard shim. Run with Node's built-in
// runner from packages/client:
//   node --test --conditions=browser components/client/clipboardShim.test.ts
// Declared test count: 11 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
//
// Focus: a main-realm clipboard call goes to main's original methods while
// main has focus, and to the focused (else last-focused) chat window's own
// clipboard otherwise - never back to main's wrapped object; `write` items are
// rebuilt with the TARGET realm's `ClipboardItem`; originals keep their
// receiver; a router failure rejects instead of throwing; wrapping is
// idempotent. The last test drives `installClipboardShim` through the real
// windowCtx registry with fake globals.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ClipboardWindow,
  clipboardTarget,
  installClipboardShim,
  wrapClipboard,
} from "./clipboardShim.ts";
import { type WindowCtx, MAIN_CTX, registerWindowCtx } from "./windowCtx.ts";

type Call = { method: string; self: unknown; args: unknown[] };

/** A clipboard whose methods record their receiver and arguments. */
function fakeClipboard(
  tag: string,
  methods: readonly string[] = ["writeText", "readText", "write", "read"],
) {
  const calls: Call[] = [];
  const clip: Record<string, unknown> = {};
  for (const method of methods) {
    clip[method] = function (this: unknown, ...args: unknown[]) {
      calls.push({ method, self: this, args });
      return Promise.resolve(`${tag}:${method}`);
    };
  }
  return { calls, clip: clip as unknown as Clipboard };
}

/** A realm-local ClipboardItem stand-in, so tests can tell realms apart. */
function fakeItemClass(realm: string) {
  return class FakeItem {
    realm = realm;
    data: Record<string, Promise<Blob>>;
    options: unknown;
    constructor(data: Record<string, Promise<Blob>>, options?: unknown) {
      this.data = data;
      this.options = options;
    }
    get types() {
      return Object.keys(this.data);
    }
    getType(type: string) {
      return this.data[type];
    }
  };
}

function fakeWindow(
  id: string,
  opts: { focused?: boolean; closed?: boolean; clipboard?: Clipboard } = {},
) {
  const state = {
    focused: opts.focused ?? false,
    closed: opts.closed ?? false,
  };
  const win = {
    get closed() {
      return state.closed;
    },
    navigator: { clipboard: opts.clipboard },
    addEventListener() {},
    removeEventListener() {},
  };
  const ctx = {
    id,
    doc: { hasFocus: () => state.focused } as unknown as Document,
    win: win as unknown as Window,
    floatingMount: () => ({}) as HTMLElement,
    isActive: () => state.focused,
  } satisfies WindowCtx;
  return { state, ctx, win };
}

const MAIN_WIN = { main: true };
const mainEntry = (): ClipboardWindow => ({
  id: "main",
  doc: { hasFocus: () => false } as unknown as Document,
  win: MAIN_WIN as unknown as Window,
});

test("clipboardTarget: main focused uses main's originals", () => {
  const child = fakeWindow("chat-1", { focused: true }).ctx;
  assert.equal(
    clipboardTarget(true, [mainEntry(), child], () => child, MAIN_WIN),
    null,
  );
});

test("clipboardTarget: the first focused child wins over last-focused", () => {
  const a = fakeWindow("chat-1").ctx;
  const b = fakeWindow("chat-2", { focused: true }).ctx;
  const c = fakeWindow("chat-3", { focused: true }).ctx;
  assert.equal(
    clipboardTarget(false, [mainEntry(), a, b, c], () => a, MAIN_WIN),
    b,
  );
});

test("clipboardTarget: no focused child falls back to lastFocused, never to main", () => {
  const a = fakeWindow("chat-1").ctx;
  const ctxs = [mainEntry(), a];
  assert.equal(
    clipboardTarget(false, ctxs, () => a, MAIN_WIN),
    a,
  );
  assert.equal(clipboardTarget(false, ctxs, mainEntry, MAIN_WIN), null);
  // A main window under another id is still main (recursion guard).
  const mainAlias = { ...mainEntry(), id: "not-main" };
  assert.equal(
    clipboardTarget(false, ctxs, () => mainAlias, MAIN_WIN),
    null,
  );
  const gone = fakeWindow("chat-9", { closed: true }).ctx;
  assert.equal(
    clipboardTarget(false, ctxs, () => gone, MAIN_WIN),
    null,
  );
});

test("clipboardTarget: a closed or throwing child is not focused", () => {
  const closed = fakeWindow("chat-1", { focused: true, closed: true }).ctx;
  const throwing: ClipboardWindow = {
    id: "chat-2",
    doc: {
      hasFocus() {
        throw new Error("dead document");
      },
    } as unknown as Document,
    win: { closed: false } as unknown as Window,
  };
  assert.equal(
    clipboardTarget(false, [closed, throwing], mainEntry, MAIN_WIN),
    null,
  );
  // Main's own entry with a lying hasFocus is skipped, not forwarded to.
  const lyingMain = { ...mainEntry(), doc: { hasFocus: () => true } };
  assert.equal(
    clipboardTarget(
      false,
      [lyingMain as unknown as ClipboardWindow],
      mainEntry,
      MAIN_WIN,
    ),
    null,
  );
});

test("wrapClipboard: route null calls the original with main as receiver", async () => {
  const main = fakeClipboard("main");
  const child = fakeClipboard("child");
  wrapClipboard(main.clip, () => null);

  // Detached call: the bound original still gets main as `this`.
  const { writeText } = main.clip;
  assert.equal(await writeText("hi"), "main:writeText");
  assert.equal(await main.clip.readText(), "main:readText");
  assert.deepEqual(
    main.calls.map((c) => [c.method, c.self === main.clip, c.args]),
    [
      ["writeText", true, ["hi"]],
      ["readText", true, []],
    ],
  );
  assert.equal(child.calls.length, 0);
});

test("wrapClipboard: a child route goes to the child's clipboard, not main's", async () => {
  const main = fakeClipboard("main");
  const child = fakeClipboard("child");
  const { ctx } = fakeWindow("chat-1", { clipboard: child.clip });
  wrapClipboard(main.clip, () => ctx);

  assert.equal(await main.clip.writeText("x"), "child:writeText");
  assert.equal(await main.clip.readText(), "child:readText");
  assert.equal(await main.clip.read(), "child:read");
  assert.equal(main.calls.length, 0);
  assert.deepEqual(
    child.calls.map((c) => [c.method, c.self === child.clip]),
    [
      ["writeText", true],
      ["readText", true],
      ["read", true],
    ],
  );
});

test("wrapClipboard: write rebuilds each item with the target realm's ClipboardItem", async () => {
  const MainItem = fakeItemClass("main");
  const ChildItem = fakeItemClass("child");
  const main = fakeClipboard("main");
  const child = fakeClipboard("child");
  const { ctx, win } = fakeWindow("chat-1", { clipboard: child.clip });
  Object.assign(win, { ClipboardItem: ChildItem });
  wrapClipboard(main.clip, () => ctx);

  // A lazy blob that never settles, like copyImageToClipboard's fetch.
  const png = new Promise<Blob>(() => {});
  const text = Promise.resolve(new Blob(["text"]));
  const styled = new MainItem({ "text/plain": text });
  Object.assign(styled, { presentationStyle: "inline" });
  const items = [
    new MainItem({ "image/png": png, "text/plain": text }),
    styled,
  ] as unknown as ClipboardItem[];

  const pending = main.clip.write(items);
  // The child's write ran synchronously, inside the gesture, with a blob
  // still pending: nothing awaited getType first.
  assert.equal(child.calls.length, 1);
  assert.equal(await pending, "child:write");
  assert.equal(main.calls.length, 0);
  const [written] = child.calls[0].args as [InstanceType<typeof ChildItem>[]];
  assert.equal(written.length, 2);
  for (const item of written) assert.ok(item instanceof ChildItem);
  assert.deepEqual(written[0].types, ["image/png", "text/plain"]);
  // The getType promises pass through unawaited (Safari's gesture rule).
  assert.equal(written[0].data["image/png"], png);
  assert.equal(written[0].options, undefined);
  assert.deepEqual(written[1].options, { presentationStyle: "inline" });
});

test("wrapClipboard: write passes items through when the child has no ClipboardItem", async () => {
  const main = fakeClipboard("main");
  const child = fakeClipboard("child");
  const { ctx } = fakeWindow("chat-1", { clipboard: child.clip });
  wrapClipboard(main.clip, () => ctx);

  const items = [{ types: [], getType() {} }] as unknown as ClipboardItem[];
  await main.clip.write(items);
  assert.deepEqual(child.calls[0].args, [items]);
});

test("wrapClipboard: a router failure rejects, and a child without the method uses main's", async () => {
  const main = fakeClipboard("main");
  wrapClipboard(main.clip, () => {
    throw new Error("router broke");
  });
  const pending = main.clip.writeText("x");
  assert.ok(pending instanceof Promise);
  await assert.rejects(pending, /router broke/);

  const main2 = fakeClipboard("main");
  const partial = fakeClipboard("child", ["writeText"]);
  const { ctx } = fakeWindow("chat-1", { clipboard: partial.clip });
  wrapClipboard(main2.clip, () => ctx);
  assert.equal(await main2.clip.readText(), "main:readText");
  assert.equal(await main2.clip.writeText("y"), "child:writeText");
});

test("wrapClipboard: wraps only existing methods, and only once", async () => {
  const main = fakeClipboard("main", ["writeText", "readText"]);
  wrapClipboard(main.clip, () => null);
  assert.equal("write" in main.clip, false);
  assert.equal("read" in main.clip, false);

  const first = main.clip.writeText;
  wrapClipboard(main.clip, () => {
    throw new Error("second wrap must not apply");
  });
  assert.equal(main.clip.writeText, first);
  assert.equal(await main.clip.writeText("z"), "main:writeText");
  assert.equal(main.calls.length, 1);
});

test("installClipboardShim: routes main's navigator.clipboard through the windowCtx registry", async () => {
  const g = globalThis as Record<string, unknown>;
  const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const main = fakeClipboard("main");
  const child = fakeClipboard("child");
  const mainState = { focused: true };
  g.window = { addEventListener() {}, removeEventListener() {} };
  g.document = { hasFocus: () => mainState.focused };
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: main.clip },
    configurable: true,
    writable: true,
  });

  const chat = fakeWindow("w1-clip-chat", { clipboard: child.clip });
  const unregister = registerWindowCtx(chat.ctx);
  try {
    installClipboardShim();
    const wrapped = main.clip.writeText;
    installClipboardShim();
    assert.equal(main.clip.writeText, wrapped, "second install is a no-op");

    assert.equal(await main.clip.writeText("a"), "main:writeText");

    mainState.focused = false;
    chat.state.focused = true;
    assert.equal(await main.clip.writeText("b"), "child:writeText");

    // Nobody focused: lastFocusedCtx has no focus stamps here, so it is main.
    chat.state.focused = false;
    assert.equal(await main.clip.writeText("c"), "main:writeText");
    assert.equal(MAIN_CTX.id, "main");
    assert.deepEqual(
      [
        ...main.calls.map((c) => c.args[0]),
        ...child.calls.map((c) => c.args[0]),
      ],
      ["a", "c", "b"],
    );
  } finally {
    unregister();
    delete g.window;
    delete g.document;
    if (saved) Object.defineProperty(globalThis, "navigator", saved);
    else delete g.navigator;
  }
});
