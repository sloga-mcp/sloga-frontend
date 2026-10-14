/**
 * Run with:
 *
 *     node --conditions=browser --test components/client/childWindow.test.ts
 *
 * Covers `openChildWindow` end to end against two jsdom windows (main and the
 * about:blank child), plus its pure helpers: the features string, window ids
 * that are never reused, the link-routing decision, and which head nodes and
 * root attributes are mirrored.
 *
 * Sibling modules and `solid-js/web` are swapped for recording stand-ins via
 * `module.registerHooks` (the approach `../state/stores/draftUpload.test.ts`
 * documents). Only imports whose parent is the module under test are
 * substituted.
 *
 * Known-bad control: point `CHILD_UNDER_TEST` at an absolute path to a broken
 * copy of `childWindow.ts` and the matching specs fail.
 */
import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";

import type * as ChildWindowModule from "./childWindow.ts";

type WindowCtxLike = {
  id: string;
  doc: Document;
  win: Window;
  floatingMount: () => HTMLElement;
  isActive: () => boolean;
};

type ShellResult = { ok: true; label?: string } | { ok: false; err: string };

type Recorder = {
  arm: (kind: string) => Promise<ShellResult>;
  focusMain: () => Promise<ShellResult>;
  discard: (label: string) => Promise<ShellResult>;
  armCalls: string[];
  focusMainCalls: number;
  discardCalls: string[];
  delegated: { names: string[]; doc: Document }[];
  clipboardInstalls: number;
  adoptedInstalls: number;
  registered: WindowCtxLike[];
  unregistered: string[];
};

const recorder: Recorder = {
  arm: async (kind) => ({ ok: true, label: `${kind}-label` }),
  focusMain: async () => ({ ok: true }),
  discard: async () => ({ ok: true }),
  armCalls: [],
  focusMainCalls: 0,
  discardCalls: [],
  delegated: [],
  clipboardInstalls: 0,
  adoptedInstalls: 0,
  registered: [],
  unregistered: [],
};
(globalThis as unknown as { __childWindowTest: Recorder }).__childWindowTest =
  recorder;

const UNDER_TEST_URL = process.env.CHILD_UNDER_TEST
  ? pathToFileURL(process.env.CHILD_UNDER_TEST).href
  : new URL("./childWindow.ts", import.meta.url).href;

const R = "globalThis.__childWindowTest";
const STUBS: Record<string, string> = {
  "solid-js/web": `
    export const DelegatedEvents = new Set(["click", "input", "keydown"]);
    export function delegateEvents(names, doc) {
      ${R}.delegated.push({ names, doc });
    }`,
  "./chatShell.ts": `
    export const supported = () => false;
    export function arm(kind) { ${R}.armCalls.push(kind); return ${R}.arm(kind); }
    export function focusMain() { ${R}.focusMainCalls++; return ${R}.focusMain(); }
    export function discard(label) { ${R}.discardCalls.push(label); return ${R}.discard(label); }
    export const setPin = async () => ({ ok: false, err: "unsupported" });
    export const saveBounds = async () => ({ ok: false, err: "unsupported" });`,
  "./clipboardShim.ts": `
    export function installClipboardShim() { ${R}.clipboardInstalls++; }`,
  "./adoptedSheetsShim.ts": `
    export function installAdoptedSheetsShim() { ${R}.adoptedInstalls++; }`,
  "./windowCtx.ts": `
    export function registerWindowCtx(ctx) {
      ${R}.registered.push(ctx);
      return () => { ${R}.unregistered.push(ctx.id); };
    }`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in STUBS && context.parentURL === UNDER_TEST_URL) {
      return { url: `child-window-test:${specifier}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("child-window-test:")) {
      return {
        format: "module",
        shortCircuit: true,
        source: STUBS[url.slice("child-window-test:".length)],
      };
    }
    return nextLoad(url, context);
  },
});

/* jsdom ships no types here; this is the slice the spec uses. */
type JsdomWindow = Window & typeof globalThis;
type Jsdom = { window: JsdomWindow };
type JsdomModule = {
  JSDOM: new (
    html: string,
    opts: { url: string; virtualConsole?: unknown },
  ) => Jsdom;
  VirtualConsole: new () => {
    on(event: "jsdomError", cb: (err: Error) => void): void;
  };
};
const { JSDOM, VirtualConsole } = createRequire(import.meta.url)(
  "jsdom",
) as JsdomModule;

const MAIN_HTML = `<!doctype html><html lang="en" class="theme-dark" data-mode="x" id="mainhtml" style="--accent: red"><head>
<title>Sloga</title>
<link rel="icon" href="/assets/icon.ico">
<link rel="stylesheet" href="/assets/a.css">
<script src="/assets/app.js"></script>
<style id="s1">.a { color: red; }</style>
<link rel="modulepreload" href="/assets/chunk.js">
<link rel="stylesheet" href="/assets/b.css">
</head><body class="b" data-layout="wide" onclick="evil()"><div id="root"></div><div id="floating"></div></body></html>`;

const main = new JSDOM(MAIN_HTML, { url: "https://app.test/channel/abc" });
const mainWin = main.window;
Object.assign(globalThis, {
  window: mainWin,
  document: mainWin.document,
  MutationObserver: mainWin.MutationObserver,
});

type FakeChild = {
  win: JsdomWindow;
  setClosed(v: boolean): void;
  closeCalls: number;
  /** jsdom reports a navigation attempt as a "not implemented" error. */
  jsdomErrors: string[];
  /** Every value written to the child's `opener`. */
  openerWrites: unknown[];
  /** When true, `opener` writes are recorded but do not take. */
  stickyOpener: boolean;
};

let opened: { url: string; name: string; features: string }[] = [];
let nextChild: FakeChild | null = null;
const externalOpens: { url: string; target: string; features: string }[] = [];

function makeChild(): FakeChild {
  const errors: string[] = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (err) => errors.push(String(err.message)));
  const dom = new JSDOM("", { url: "about:blank", virtualConsole: vc });
  let closed = false;
  const child: FakeChild = {
    win: dom.window,
    setClosed: (v) => (closed = v),
    closeCalls: 0,
    jsdomErrors: errors,
    openerWrites: [],
    stickyOpener: false,
  };
  // A window from window.open starts with main as its opener.
  let opener: unknown = mainWin;
  Object.defineProperty(dom.window, "opener", {
    configurable: true,
    get: () => opener,
    set: (v: unknown) => {
      child.openerWrites.push(v);
      if (!child.stickyOpener) opener = v;
    },
  });
  Object.defineProperty(dom.window, "closed", {
    configurable: true,
    get: () => closed,
  });
  Object.defineProperty(dom.window, "close", {
    configurable: true,
    value: () => {
      child.closeCalls++;
      closed = true;
    },
  });
  return child;
}

mainWin.open = ((url: string, target: string, features: string) => {
  if (url === "about:blank") {
    opened.push({ url, name: target, features });
    const child = nextChild;
    nextChild = null;
    return child ? child.win : null;
  }
  externalOpens.push({ url, target, features });
  return null;
}) as typeof window.open;

const mod: typeof ChildWindowModule = await import(UNDER_TEST_URL);

function reset() {
  opened = [];
  externalOpens.length = 0;
  recorder.arm = async (kind) => ({ ok: true, label: `${kind}-label` });
  recorder.focusMain = async () => ({ ok: true });
  recorder.discard = async () => ({ ok: true });
  recorder.armCalls = [];
  recorder.focusMainCalls = 0;
  recorder.discardCalls = [];
  recorder.delegated = [];
  recorder.clipboardInstalls = 0;
  recorder.adoptedInstalls = 0;
  recorder.registered = [];
  recorder.unregistered = [];
  mod.setInternalLinkHandler(null);
}

async function openWithChild(
  opts: Parameters<typeof mod.openChildWindow>[1] = { width: 520, height: 640 },
) {
  const child = makeChild();
  nextChild = child;
  const handle = await mod.openChildWindow("chat", opts);
  assert.ok(handle, "openChildWindow resolved null");
  return { child, handle };
}

/** Let MutationObserver callbacks (microtasks) run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

function headSummary(doc: Document) {
  return Array.from(doc.head.children).map((el) => {
    const name = el.nodeName.toLowerCase();
    if (name === "link") return `link:${el.getAttribute("href")}`;
    if (name === "style")
      return el.hasAttribute("data-chatwin-quirks")
        ? "quirks"
        : `style:${el.textContent}`;
    if (name === "base") return `base:${el.getAttribute("href")}`;
    return name;
  });
}

function clickIn(doc: Document, el: Element) {
  const event = new doc.defaultView!.MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    button: 0,
  });
  const notCancelled = el.dispatchEvent(event);
  return { event, notCancelled };
}

describe("childWindowFeatures", () => {
  it("emits width, height, left, top in CSS px, rounded", () => {
    assert.equal(
      mod.childWindowFeatures({
        width: 520.4,
        height: 639.6,
        left: 10.5,
        top: -20.2,
      }),
      "width=520,height=640,left=11,top=-20",
    );
  });

  it("leaves out a missing or non-finite position so the shell restores bounds", () => {
    assert.equal(
      mod.childWindowFeatures({ width: 400, height: 300 }),
      "width=400,height=300",
    );
    assert.equal(
      mod.childWindowFeatures({
        width: 400,
        height: 300,
        left: Number.NaN,
        top: Infinity,
      }),
      "width=400,height=300",
    );
  });

  it("never emits a zero, negative or non-finite size", () => {
    assert.equal(
      mod.childWindowFeatures({ width: 0, height: -5 }),
      "width=1,height=1",
    );
    assert.equal(
      mod.childWindowFeatures({ width: Number.NaN, height: 300, left: 0 }),
      "height=300,left=0",
    );
  });

  it("never asks for noopener (window.open would return null)", () => {
    assert.ok(
      !mod
        .childWindowFeatures({ width: 1, height: 1, left: 1, top: 1 })
        .includes("noopener"),
    );
  });
});

describe("window ids", () => {
  it("has the pinned shape", () => {
    assert.equal(mod.childWindowId("chat", 3, 36 * 36), "chat-3-100");
    assert.equal(mod.childWindowId("friends", 1, 0), "friends-1-0");
  });

  it("is never reused within a session, even in the same millisecond", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) ids.add(mod.nextChildWindowId("chat"));
    assert.equal(ids.size, 200);
    assert.match(mod.nextChildWindowId("friends"), /^friends-\d+-[0-9a-z]+$/);
  });
});

describe("classifyChildLink", () => {
  const MAIN = "https://app.test/channel/abc";

  it("routes same-origin links internally, resolved against main", () => {
    assert.deepEqual(mod.classifyChildLink("/server/1/channel/2", MAIN), {
      kind: "internal",
      href: "https://app.test/server/1/channel/2",
    });
    assert.deepEqual(mod.classifyChildLink("https://app.test/invite/x", MAIN), {
      kind: "internal",
      href: "https://app.test/invite/x",
    });
    assert.deepEqual(mod.classifyChildLink("  ../settings  ", MAIN), {
      kind: "internal",
      href: "https://app.test/settings",
    });
  });

  it("sends other origins out, for http(s), mailto and tel only", () => {
    for (const href of [
      "https://example.com/a?b#c",
      "http://example.com/",
      "mailto:a@example.com",
      "tel:+15550100",
      "http://app.test/x", // other scheme, so other origin
      "https://app.test:8443/x", // other port
    ]) {
      assert.equal(mod.classifyChildLink(href, MAIN).kind, "external", href);
    }
  });

  it("drops script, data, blob and file URLs, bare fragments and junk", () => {
    for (const href of [
      "javascript:alert(1)",
      " JavaScript:alert(1)",
      "data:text/html,<script>1</script>",
      "blob:https://app.test/0b2c",
      "file:///etc/passwd",
      "#",
      "#section",
      "",
      "   ",
      null,
      "https://[bad",
    ]) {
      assert.deepEqual(
        mod.classifyChildLink(href, MAIN),
        { kind: "ignore" },
        String(href),
      );
    }
  });

  it("compares custom schemes by host, not the opaque 'null' origin", () => {
    const APP = "app://bundle/channel/abc";
    assert.deepEqual(mod.classifyChildLink("/friends", APP), {
      kind: "internal",
      href: "app://bundle/friends",
    });
    assert.deepEqual(mod.classifyChildLink("app://other/x", APP), {
      kind: "ignore",
    });
    assert.deepEqual(mod.classifyChildLink("foo://bundle/x", APP), {
      kind: "ignore",
    });
  });

  it("keeps download links as downloads, never router or browser routes", () => {
    for (const [href, expected] of [
      [
        "https://cdn.example/attachments/1/a.png",
        "https://cdn.example/attachments/1/a.png",
      ],
      ["http://cdn.example/a", "http://cdn.example/a"],
      ["/assets/file.txt", "https://app.test/assets/file.txt"],
      ["blob:https://app.test/0b2c", "blob:https://app.test/0b2c"],
    ] as const) {
      assert.deepEqual(
        mod.classifyChildLink(href, MAIN, true),
        { kind: "download", href: expected },
        href,
      );
    }
    for (const href of [
      "javascript:alert(1)",
      "data:text/plain,hi",
      "blob:https://evil.test/0b2c",
      "blob:junk",
      "file:///etc/passwd",
      "mailto:a@example.com",
      "#",
      "",
      null,
    ]) {
      assert.deepEqual(
        mod.classifyChildLink(href, MAIN, true),
        { kind: "ignore" },
        String(href),
      );
    }
    // Without the attribute the same hrefs route as plain links.
    assert.equal(
      mod.classifyChildLink("https://cdn.example/a", MAIN, false).kind,
      "external",
    );
    assert.equal(mod.classifyChildLink("/assets/f", MAIN).kind, "internal");
  });

  it("isSameOriginHref matches protocol and host only", () => {
    const m = new URL("https://app.test/a");
    assert.equal(
      mod.isSameOriginHref(new URL("https://app.test/b?q"), m),
      true,
    );
    assert.equal(mod.isSameOriginHref(new URL("http://app.test/b"), m), false);
    assert.equal(mod.isSameOriginHref(new URL("https://evil.test/"), m), false);
    assert.equal(
      mod.isSameOriginHref(new URL("https://app.test.evil.test/"), m),
      false,
    );
  });
});

describe("mirror selection", () => {
  const doc = mainWin.document;
  const el = (html: string) => {
    const t = doc.createElement("template");
    t.innerHTML = html;
    return t.content.firstChild as Node;
  };

  it("mirrors only <style> and stylesheet links, never scripts", () => {
    assert.equal(mod.isMirroredHeadNode(el("<style></style>")), true);
    assert.equal(
      mod.isMirroredHeadNode(el('<link rel="stylesheet" href="/a.css">')),
      true,
    );
    assert.equal(
      mod.isMirroredHeadNode(
        el('<link rel="Alternate  StyleSheet" href="/a">'),
      ),
      true,
    );
    for (const html of [
      '<script src="/a.js"></script>',
      "<script>1</script>",
      '<link rel="modulepreload" href="/a.js">',
      '<link rel="icon" href="/a.ico">',
      '<link rel="preload" as="style" href="/a.css">',
      "<link>",
      "<meta charset=utf-8>",
      "<title>x</title>",
    ]) {
      assert.equal(mod.isMirroredHeadNode(el(html)), false, html);
    }
    assert.equal(mod.isMirroredHeadNode(doc.createTextNode("x")), false);
  });

  it("mirrors class, style, lang and data-* root attributes only", () => {
    for (const name of ["class", "style", "lang", "data-theme", "data-x-y"])
      assert.equal(mod.isMirroredRootAttribute(name), true, name);
    for (const name of ["id", "onclick", "dir", "hidden", "datax", "src"])
      assert.equal(mod.isMirroredRootAttribute(name), false, name);
  });
});

describe("isReloadShortcut", () => {
  const key = (
    k: string,
    mods: Partial<Omit<ChildWindowModule.ReloadKeyEvent, "key">> = {},
  ): ChildWindowModule.ReloadKeyEvent => ({
    key: k,
    code: mods.code ?? "",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  });

  it("matches F5, Ctrl+F5, Ctrl/Cmd+R and Ctrl/Cmd+Shift+R", () => {
    for (const event of [
      key("F5", { code: "F5" }),
      key("F5", { code: "F5", ctrlKey: true }),
      key("F5", { code: "F5", shiftKey: true }),
      key("BrowserRefresh"),
      key("r", { code: "KeyR", ctrlKey: true }),
      key("r", { code: "KeyR", metaKey: true }),
      key("R", { code: "KeyR", ctrlKey: true, shiftKey: true }),
      key("R", { code: "KeyR", metaKey: true, shiftKey: true }),
    ])
      assert.equal(mod.isReloadShortcut(event), true, JSON.stringify(event));
  });

  it("matches the physical R on a non-Latin layout, not Dvorak's P", () => {
    assert.equal(
      mod.isReloadShortcut(key("к", { code: "KeyR", ctrlKey: true })),
      true,
    );
    assert.equal(
      mod.isReloadShortcut(key("p", { code: "KeyR", ctrlKey: true })),
      false,
    );
  });

  it("leaves typing, other shortcuts and Alt chords alone", () => {
    for (const event of [
      key("r", { code: "KeyR" }),
      key("R", { code: "KeyR", shiftKey: true }),
      key("t", { code: "KeyT", ctrlKey: true }),
      key("F4", { code: "F4" }),
      key("F5", { code: "F5", altKey: true }),
      key("r", { code: "KeyR", ctrlKey: true, altKey: true }),
      key("Enter", { code: "Enter", ctrlKey: true }),
    ])
      assert.equal(mod.isReloadShortcut(event), false, JSON.stringify(event));
  });
});

describe("openChildWindow", () => {
  it("arms the shell, then opens about:blank under the unique id", async () => {
    reset();
    const { handle } = await openWithChild({
      width: 520,
      height: 640,
      left: 5,
      top: 6,
    });
    assert.deepEqual(recorder.armCalls, ["chat"]);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].url, "about:blank");
    assert.equal(opened[0].name, handle.id);
    assert.match(handle.id, /^chat-\d+-[0-9a-z]+$/);
    assert.equal(opened[0].features, "width=520,height=640,left=5,top=6");
    assert.equal(handle.kind, "chat");
    assert.equal(handle.shellLabel, "chat-label");
    handle.close();
  });

  it("never reuses a window name across opens", async () => {
    reset();
    const a = await openWithChild();
    const b = await openWithChild();
    assert.notEqual(a.handle.id, b.handle.id);
    assert.notEqual(opened[0].name, opened[1].name);
    a.handle.close();
    b.handle.close();
  });

  it("serializes concurrent opens: each arm is followed by its own window.open", async () => {
    reset();
    const log: string[] = [];
    let n = 0;
    recorder.arm = async (kind) => {
      const label = `${kind}-${++n}`;
      log.push(`arm:${label}`);
      // The first arm answers slowest, so unserialized opens would interleave.
      if (n === 1) await new Promise((r) => setTimeout(r, 30));
      return { ok: true, label };
    };
    const children = [makeChild(), makeChild()];
    const realOpen = mainWin.open;
    mainWin.open = ((url: string, name: string, features: string) => {
      log.push(`open:${name}`);
      opened.push({ url, name, features });
      return children.shift()!.win;
    }) as typeof window.open;

    try {
      const [a, b] = await Promise.all([
        mod.openChildWindow("chat", { width: 1, height: 1 }),
        mod.openChildWindow("chat", { width: 1, height: 1 }),
      ]);
      assert.ok(a && b);
      assert.deepEqual(log, [
        "arm:chat-1",
        `open:${a.id}`,
        "arm:chat-2",
        `open:${b.id}`,
      ]);
      assert.equal(a.shellLabel, "chat-1");
      assert.equal(b.shellLabel, "chat-2");
      a.close();
      b.close();
    } finally {
      mainWin.open = realOpen;
    }
  });

  it("resolves null for an open that threw, and keeps the queue going", async () => {
    reset();
    recorder.arm = async () => {
      throw new Error("bridge exploded");
    };
    const errors = mock.method(console, "error", () => {});
    const failed = await mod.openChildWindow("chat", { width: 1, height: 1 });
    errors.mock.restore();
    assert.equal(failed, null);
    assert.equal(opened.length, 0);
    recorder.arm = async (kind) => ({ ok: true, label: `${kind}-label` });
    const { handle } = await openWithChild();
    assert.equal(handle.shellLabel, "chat-label");
    handle.close();
  });

  // An arm that never answers resolves null, and later opens still run. The
  // test timeout makes a regression fail instead of hanging the suite.
  it("times out a hung arm", { timeout: 10_000 }, async (t) => {
    reset();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    recorder.arm = () => new Promise<ShellResult>(() => {});
    nextChild = makeChild();
    const warn = mock.method(console, "warn", () => {});
    const microtasks = async (n: number) => {
      for (let i = 0; i < n; i++) await Promise.resolve();
    };

    let settled = false;
    const pending = mod.openChildWindow("chat", { width: 1, height: 1 });
    void pending.then(() => (settled = true));
    await microtasks(20);
    assert.deepEqual(recorder.armCalls, ["chat"]);
    t.mock.timers.tick(mod.ARM_TIMEOUT_MS - 1);
    await microtasks(20);
    assert.equal(settled, false, "gave up before the timeout");

    t.mock.timers.tick(1);
    assert.equal(await pending, null);
    warn.mock.restore();
    assert.equal(opened.length, 0, "window.open was called after a timeout");
    nextChild = null;
    t.mock.timers.reset();

    recorder.arm = async (kind) => ({ ok: true, label: `${kind}-label` });
    const { handle } = await openWithChild();
    assert.equal(handle.shellLabel, "chat-label");
    handle.close();
  });

  it("continues without a shell (web) and has no shell label", async () => {
    reset();
    recorder.arm = async () => ({ ok: false, err: "unsupported" });
    const { handle } = await openWithChild();
    assert.equal(handle.shellLabel, undefined);
    handle.close();
  });

  it("resolves null without opening when the shell refuses the arm", async () => {
    reset();
    recorder.arm = async () => ({ ok: false, err: "exists" });
    nextChild = makeChild();
    const warn = mock.method(console, "warn", () => {});
    const handle = await mod.openChildWindow("friends", {
      width: 1,
      height: 1,
    });
    warn.mock.restore();
    assert.equal(handle, null);
    assert.equal(opened.length, 0, "window.open was called after a refusal");
    nextChild = null;
  });

  it("resolves null when window.open returns null", async () => {
    reset();
    nextChild = null;
    const handle = await mod.openChildWindow("chat", { width: 1, height: 1 });
    assert.equal(handle, null);
    assert.equal(recorder.registered.length, 0);
  });

  // Identity checks on windows, handles and nodes are asserted as booleans in
  // the specs below: a failing `assert.equal(win, null)` formats the whole
  // jsdom window into its message, which runs the process out of memory.
  it("severs the child's opener before preparing it; main keeps its handle", async () => {
    reset();
    const child = makeChild();
    nextChild = child;
    assert.ok(child.win.opener === mainWin, "fake child starts without main");
    const handle = await mod.openChildWindow("chat", { width: 1, height: 1 });
    try {
      assert.ok(handle !== null, "openChildWindow resolved null");
      assert.deepEqual(child.openerWrites, [null]);
      assert.ok(child.win.opener === null, "child can still reach main");
      assert.ok(handle.ctx.win === child.win, "main lost its child handle");
    } finally {
      handle?.close();
    }
  });

  it("closes the window and resolves null when the opener will not clear", async () => {
    reset();
    const child = makeChild();
    child.stickyOpener = true;
    nextChild = child;
    const errors = mock.method(console, "error", () => {});
    const handle = await mod.openChildWindow("chat", { width: 1, height: 1 });
    errors.mock.restore();
    try {
      assert.ok(handle === null, "kept a window that can reach main");
      assert.deepEqual(child.openerWrites, [null]);
      assert.equal(child.closeCalls, 1);
      assert.equal(recorder.registered.length, 0);
      assert.ok(
        child.win.document.getElementById("floating") === null,
        "prepared the document before clearing the opener",
      );
    } finally {
      handle?.close();
    }
  });

  it("discards the armed label when window.open returns null", async () => {
    reset();
    nextChild = null;
    const handle = await mod.openChildWindow("chat", { width: 1, height: 1 });
    assert.ok(handle === null, "resolved a handle without a window");
    assert.deepEqual(recorder.discardCalls, ["chat-label"]);
  });

  it("never discards on a successful open", async () => {
    reset();
    const { handle } = await openWithChild();
    assert.deepEqual(recorder.discardCalls, []);
    handle.close();
    assert.deepEqual(recorder.discardCalls, []);
  });

  it("never discards without an arm (web) or after a refused arm", async () => {
    reset();
    recorder.arm = async () => ({ ok: false, err: "unsupported" });
    nextChild = null;
    const web = await mod.openChildWindow("chat", { width: 1, height: 1 });
    assert.ok(web === null, "resolved a handle without a window");
    assert.equal(opened.length, 1);

    recorder.arm = async () => ({ ok: false, err: "exists" });
    const warn = mock.method(console, "warn", () => {});
    const refused = await mod.openChildWindow("chat", { width: 1, height: 1 });
    warn.mock.restore();
    assert.ok(refused === null, "opened after a refused arm");
    assert.deepEqual(recorder.discardCalls, []);
  });

  it("holds the open, and the queue, until the discard settles", async () => {
    reset();
    const log: string[] = [];
    let settle: (() => void) | undefined;
    recorder.discard = (label) => {
      log.push(`discard:${label}`);
      return new Promise((resolve) => {
        settle = () => {
          log.push("discarded");
          resolve({ ok: true });
        };
      });
    };
    let n = 0;
    recorder.arm = async (kind) => {
      const label = `${kind}-${++n}`;
      log.push(`arm:${label}`);
      return { ok: true, label };
    };
    nextChild = null;

    let firstSettled = false;
    const first = mod.openChildWindow("chat", { width: 1, height: 1 });
    void first.then(() => (firstSettled = true));
    const second = mod.openChildWindow("chat", { width: 1, height: 1 });
    await flush();
    assert.equal(firstSettled, false, "resolved before the discard settled");
    assert.deepEqual(log, ["arm:chat-1", "discard:chat-1"]);

    nextChild = makeChild();
    settle!();
    assert.ok((await first) === null, "resolved a handle without a window");
    const handle = await second;
    try {
      assert.ok(handle !== null, "the queued open resolved null");
      assert.equal(handle.shellLabel, "chat-2");
      assert.deepEqual(log, [
        "arm:chat-1",
        "discard:chat-1",
        "discarded",
        "arm:chat-2",
      ]);
    } finally {
      handle?.close();
    }
  });

  it("a failed, throwing or rejected discard still resolves null and frees the queue", async () => {
    const answers: (() => Promise<ShellResult>)[] = [
      async () => ({ ok: false, err: "not main" }),
      () => Promise.reject(new Error("bridge down")),
      () => {
        throw new Error("sync");
      },
    ];
    for (const answer of answers) {
      reset();
      recorder.discard = answer;
      nextChild = null;
      const warn = mock.method(console, "warn", () => {});
      const handle = await mod
        .openChildWindow("chat", { width: 1, height: 1 })
        .finally(() => warn.mock.restore());
      assert.equal(warn.mock.callCount(), 1);
      assert.ok(handle === null, "resolved a handle without a window");
      assert.deepEqual(recorder.discardCalls, ["chat-label"]);

      const next = await openWithChild();
      next.handle.close();
    }
  });

  it("times out a hung discard", { timeout: 10_000 }, async (t) => {
    reset();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    recorder.discard = () => new Promise<ShellResult>(() => {});
    nextChild = null;
    const warn = mock.method(console, "warn", () => {});
    const microtasks = async (n: number) => {
      for (let i = 0; i < n; i++) await Promise.resolve();
    };

    try {
      let settled = false;
      const pending = mod.openChildWindow("chat", { width: 1, height: 1 });
      void pending.then(() => (settled = true));
      await microtasks(20);
      assert.deepEqual(recorder.discardCalls, ["chat-label"]);
      t.mock.timers.tick(mod.ARM_TIMEOUT_MS - 1);
      await microtasks(20);
      assert.equal(settled, false, "gave up before the timeout");

      t.mock.timers.tick(1);
      assert.ok((await pending) === null, "resolved a handle without a window");
      assert.equal(warn.mock.callCount(), 1);
    } finally {
      warn.mock.restore();
      t.mock.timers.reset();
    }

    const { handle } = await openWithChild();
    handle.close();
  });

  it("prepares the document: title, base, styles in order, no scripts", async () => {
    reset();
    const { child, handle } = await openWithChild({
      width: 1,
      height: 1,
      title: "Chat",
    });
    const doc = child.win.document;
    assert.equal(handle.ctx.doc, doc);
    assert.equal(handle.ctx.win, child.win);
    assert.equal(doc.title, "Chat");
    assert.deepEqual(headSummary(doc), [
      "quirks",
      "base:https://app.test/channel/abc",
      "title",
      "link:https://app.test/assets/a.css",
      "style:.a { color: red; }",
      "link:https://app.test/assets/b.css",
    ]);
    assert.equal(doc.querySelectorAll("script").length, 0);
    handle.close();
  });

  it("defaults the title to main's", async () => {
    reset();
    const { child, handle } = await openWithChild();
    assert.equal(child.win.document.title, "Sloga");
    handle.close();
  });

  it("puts the quirks-mode fix first, so main's mirrored CSS still wins", async () => {
    reset();
    const { child, handle } = await openWithChild();
    const first = child.win.document.head.firstElementChild!;
    assert.equal(first.nodeName.toLowerCase(), "style");
    assert.equal(first.hasAttribute("data-chatwin-quirks"), true);
    assert.equal(first.textContent, mod.QUIRKS_CSS);
    assert.match(mod.QUIRKS_CSS, /table \{[^}]*font: inherit/);
    assert.match(mod.QUIRKS_CSS, /html, body \{ height: 100%; \}/);
    assert.equal(
      child.win.document.querySelectorAll("style[data-chatwin-quirks]").length,
      1,
    );
    handle.close();
  });

  it("mirrors later head additions in place, removals and style text", async () => {
    reset();
    const { child, handle } = await openWithChild();
    const head = mainWin.document.head;
    const b = head.querySelector('link[href="/assets/b.css"]')!;

    const late = mainWin.document.createElement("link");
    late.rel = "stylesheet";
    late.href = "/assets/late.css";
    head.insertBefore(late, b);
    const tail = mainWin.document.createElement("style");
    tail.textContent = ".t{}";
    head.appendChild(tail);
    const script = mainWin.document.createElement("script");
    script.src = "/assets/late.js";
    head.appendChild(script);
    await flush();

    assert.deepEqual(headSummary(child.win.document).slice(3), [
      "link:https://app.test/assets/a.css",
      "style:.a { color: red; }",
      "link:https://app.test/assets/late.css",
      "link:https://app.test/assets/b.css",
      "style:.t{}",
    ]);
    assert.equal(child.win.document.querySelectorAll("script").length, 0);

    tail.textContent = ".t{color:blue}";
    late.setAttribute("media", "print");
    await flush();
    const childHead = child.win.document.head;
    assert.equal(childHead.lastElementChild!.textContent, ".t{color:blue}");
    assert.equal(
      childHead
        .querySelector('link[href="https://app.test/assets/late.css"]')!
        .getAttribute("media"),
      "print",
    );

    late.remove();
    tail.remove();
    script.remove();
    await flush();
    assert.deepEqual(headSummary(child.win.document).slice(3), [
      "link:https://app.test/assets/a.css",
      "style:.a { color: red; }",
      "link:https://app.test/assets/b.css",
    ]);
    handle.close();
  });

  it("mirrors <html> and <body> theme attributes, live, and nothing else", async () => {
    reset();
    const { child, handle } = await openWithChild();
    const html = child.win.document.documentElement;
    const body = child.win.document.body;
    assert.equal(html.getAttribute("class"), "theme-dark");
    assert.equal(html.getAttribute("lang"), "en");
    assert.equal(html.getAttribute("data-mode"), "x");
    assert.equal(html.getAttribute("style"), "--accent: red");
    assert.equal(html.hasAttribute("id"), false);
    assert.equal(body.getAttribute("class"), "b");
    assert.equal(body.getAttribute("data-layout"), "wide");
    assert.equal(body.hasAttribute("onclick"), false);

    const mainHtml = mainWin.document.documentElement;
    mainHtml.style.setProperty("--accent", "blue");
    mainHtml.removeAttribute("data-mode");
    mainWin.document.body.setAttribute("data-new", "1");
    mainWin.document.body.setAttribute("onmouseover", "evil()");
    await flush();
    assert.equal(html.getAttribute("style"), "--accent: blue;");
    assert.equal(html.hasAttribute("data-mode"), false);
    assert.equal(body.getAttribute("data-new"), "1");
    assert.equal(body.hasAttribute("onmouseover"), false);

    mainHtml.setAttribute("style", "--accent: red");
    mainHtml.setAttribute("data-mode", "x");
    mainWin.document.body.removeAttribute("data-new");
    mainWin.document.body.removeAttribute("onmouseover");
    handle.close();
  });

  it("delegates Solid's events on the child, mounts #floating, registers", async () => {
    reset();
    const { child, handle } = await openWithChild();
    const doc = child.win.document;
    assert.equal(recorder.delegated.length, 1);
    assert.equal(recorder.delegated[0].doc, doc);
    assert.deepEqual(recorder.delegated[0].names, [
      "click",
      "input",
      "keydown",
    ]);

    const floating = handle.ctx.floatingMount();
    assert.equal(floating.id, "floating");
    assert.equal(floating.ownerDocument, doc);
    assert.equal(floating.parentNode, doc.body);
    assert.equal(handle.ctx.id, handle.id);
    assert.equal(typeof handle.ctx.isActive(), "boolean");

    assert.deepEqual(recorder.registered, [handle.ctx]);
    assert.equal(recorder.clipboardInstalls, 1);
    assert.equal(recorder.adoptedInstalls, 1);
    handle.close();
  });

  it("keeps an empty #floating after content portalled into the body", async () => {
    reset();
    const { child, handle } = await openWithChild();
    const doc = child.win.document;
    const portal = doc.createElement("div");
    doc.body.appendChild(portal);
    await flush();
    assert.equal(doc.body.lastElementChild, handle.ctx.floatingMount());

    // Not moved while it holds something (that would drop focus).
    handle.ctx.floatingMount().appendChild(doc.createElement("div"));
    const second = doc.body.appendChild(doc.createElement("div"));
    await flush();
    assert.equal(doc.body.lastElementChild, second);
    handle.close();
  });
});

describe("link capture", () => {
  it("routes a same-origin link to the registered handler, child never navigates", async () => {
    reset();
    const { child, handle } = await openWithChild();
    const calls: { href: string; from: WindowCtxLike }[] = [];
    mod.setInternalLinkHandler((href, from) => calls.push({ href, from }));

    const doc = child.win.document;
    const a = doc.createElement("a");
    a.setAttribute("href", "/channel/xyz");
    const inner = doc.createElement("span");
    a.appendChild(inner);
    doc.body.appendChild(a);

    let seenByApp: boolean | undefined;
    doc.addEventListener("click", (e) => (seenByApp = e.defaultPrevented));
    const { notCancelled } = clickIn(doc, inner);

    assert.equal(notCancelled, false, "the child's default action ran");
    assert.equal(seenByApp, false, "app code saw a pre-cancelled event");
    assert.deepEqual(
      calls.map((c) => c.href),
      ["https://app.test/channel/xyz"],
    );
    assert.equal(calls[0].from, handle.ctx);
    assert.deepEqual(child.jsdomErrors, []);
    handle.close();
  });

  it("does not route a click an app handler claimed (e.g. the link warning)", async () => {
    reset();
    const { child, handle } = await openWithChild();
    const calls: string[] = [];
    mod.setInternalLinkHandler((href) => calls.push(href));

    const doc = child.win.document;
    const ext = doc.createElement("a");
    ext.setAttribute("href", "https://untrusted.example/");
    const internal = doc.createElement("a");
    internal.setAttribute("href", "/channel/1");
    doc.body.append(ext, internal);
    // Solid's delegated handler runs as a bubble listener on the document.
    doc.addEventListener("click", (e) => {
      e.preventDefault();
    });

    assert.equal(clickIn(doc, ext).notCancelled, false);
    assert.equal(clickIn(doc, internal).notCancelled, false);
    assert.deepEqual(externalOpens, []);
    assert.deepEqual(calls, []);
    assert.deepEqual(child.jsdomErrors, []);
    handle.close();
  });

  it("keeps a link inert when a handler stops propagation without claiming", async () => {
    reset();
    const { child, handle } = await openWithChild();
    const calls: string[] = [];
    mod.setInternalLinkHandler((href) => calls.push(href));
    const doc = child.win.document;
    const a = doc.createElement("a");
    a.setAttribute("href", "/channel/1");
    doc.body.appendChild(a);
    a.addEventListener("click", (e) => e.stopPropagation());

    assert.equal(clickIn(doc, a).notCancelled, false);
    assert.deepEqual(calls, []);
    assert.deepEqual(child.jsdomErrors, []);
    handle.close();
  });

  it("opens other origins from main with noopener,noreferrer", async () => {
    reset();
    const { child, handle } = await openWithChild();
    const doc = child.win.document;
    const a = doc.createElement("a");
    a.setAttribute("href", "https://example.com/page");
    a.setAttribute("target", "_blank");
    doc.body.appendChild(a);

    assert.equal(clickIn(doc, a).notCancelled, false);
    assert.deepEqual(externalOpens, [
      {
        url: "https://example.com/page",
        target: "_blank",
        features: "noopener,noreferrer",
      },
    ]);
    assert.deepEqual(child.jsdomErrors, []);
    handle.close();
  });

  it("drops javascript: links without opening anything", async () => {
    reset();
    const { child, handle } = await openWithChild();
    const calls: string[] = [];
    mod.setInternalLinkHandler((href) => calls.push(href));
    const doc = child.win.document;
    const a = doc.createElement("a");
    a.setAttribute("href", "javascript:alert(1)");
    doc.body.appendChild(a);

    assert.equal(clickIn(doc, a).notCancelled, false);
    assert.deepEqual(externalOpens, []);
    assert.deepEqual(calls, []);
    handle.close();
  });

  it("ignores clicks that are not on a link", async () => {
    reset();
    const { child, handle } = await openWithChild();
    const doc = child.win.document;
    const button = doc.body.appendChild(doc.createElement("button"));
    const nohref = doc.body.appendChild(doc.createElement("a"));
    assert.equal(clickIn(doc, button).notCancelled, true);
    assert.equal(clickIn(doc, nohref).notCancelled, true);
    handle.close();
  });

  it("by default focuses main, then clicks a temporary anchor in main", async () => {
    reset();
    const { child, handle } = await openWithChild();
    const order: string[] = [];
    recorder.focusMain = async () => {
      order.push("focusMain");
      return { ok: true };
    };
    const seen: { href: string; inBody: boolean }[] = [];
    const onMainClick = (e: Event) => {
      const a = e.target as HTMLAnchorElement;
      order.push("click");
      seen.push({
        href: a.href,
        inBody: a.parentNode === mainWin.document.body,
      });
      e.preventDefault(); // stands in for the router; jsdom cannot navigate
    };
    mainWin.document.addEventListener("click", onMainClick);

    const doc = child.win.document;
    const a = doc.createElement("a");
    a.setAttribute("href", "/server/9/channel/8");
    doc.body.appendChild(a);
    clickIn(doc, a);
    await flush();

    mainWin.document.removeEventListener("click", onMainClick);
    assert.deepEqual(order, ["focusMain", "click"]);
    assert.deepEqual(seen, [
      { href: "https://app.test/server/9/channel/8", inBody: true },
    ]);
    assert.equal(
      mainWin.document.querySelectorAll('a[href*="/server/9/"]').length,
      0,
      "the temporary anchor was left in main",
    );
    handle.close();
  });

  it("recreates a download link in main and clicks it there", async () => {
    reset();
    const { child, handle } = await openWithChild();
    const calls: string[] = [];
    mod.setInternalLinkHandler((href) => calls.push(href));
    const seen: Record<string, string | null>[] = [];
    const onMainClick = (e: Event) => {
      const a = e.target as HTMLAnchorElement;
      seen.push({
        href: a.href,
        download: a.getAttribute("download"),
        target: a.getAttribute("target"),
        rel: a.getAttribute("rel"),
        inBody: String(a.parentNode === mainWin.document.body),
      });
      e.preventDefault(); // jsdom cannot download
    };
    mainWin.document.addEventListener("click", onMainClick);

    const doc = child.win.document;
    const remote = doc.createElement("a");
    remote.setAttribute("href", "https://cdn.example/a.png");
    remote.setAttribute("download", "a.png");
    remote.setAttribute("target", "_blank");
    const local = doc.createElement("a");
    local.setAttribute("href", "/assets/notes.txt");
    local.setAttribute("download", "");
    local.setAttribute("rel", "noreferrer");
    doc.body.append(remote, local);
    assert.equal(clickIn(doc, remote).notCancelled, false);
    assert.equal(clickIn(doc, local).notCancelled, false);
    mainWin.document.removeEventListener("click", onMainClick);

    assert.deepEqual(seen, [
      {
        href: "https://cdn.example/a.png",
        download: "a.png",
        target: "_blank",
        rel: null,
        inBody: "true",
      },
      {
        href: "https://app.test/assets/notes.txt",
        download: "",
        target: null,
        rel: "noreferrer",
        inBody: "true",
      },
    ]);
    assert.deepEqual(calls, [], "a download went to the router");
    assert.deepEqual(externalOpens, [], "a download went to window.open");
    assert.equal(recorder.focusMainCalls, 0);
    assert.equal(mainWin.document.querySelectorAll("a[download]").length, 0);
    assert.deepEqual(child.jsdomErrors, []);
    handle.close();
  });

  it("stops capturing once the window is closed", async () => {
    reset();
    const { child, handle } = await openWithChild();
    const calls: string[] = [];
    mod.setInternalLinkHandler((href) => calls.push(href));
    handle.close();
    const doc = child.win.document;
    const a = doc.body.appendChild(doc.createElement("a"));
    a.setAttribute("href", "/channel/1");
    // Cancelled here only so jsdom does not log a navigation attempt.
    child.win.addEventListener("click", (e) => e.preventDefault());
    let cancelledBeforeApp: boolean | undefined;
    doc.addEventListener(
      "click",
      (e) => (cancelledBeforeApp = e.defaultPrevented),
    );
    clickIn(doc, a);
    assert.equal(cancelledBeforeApp, false, "capture listener still attached");
    assert.deepEqual(calls, []);
  });
});

describe("reload guard", () => {
  function press(doc: Document, init: KeyboardEventInit) {
    const event = new doc.defaultView!.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    doc.body.dispatchEvent(event);
    return event;
  }

  it("cancels the reload keys in the child; app handlers still see them", async () => {
    reset();
    const { child, handle } = await openWithChild();
    const doc = child.win.document;
    const seen: string[] = [];
    doc.addEventListener("keydown", (e) => seen.push(e.key));

    assert.equal(press(doc, { key: "F5", code: "F5" }).defaultPrevented, true);
    assert.equal(
      press(doc, { key: "r", code: "KeyR", ctrlKey: true }).defaultPrevented,
      true,
    );
    assert.equal(
      press(doc, { key: "R", code: "KeyR", metaKey: true, shiftKey: true })
        .defaultPrevented,
      true,
    );
    assert.equal(
      press(doc, { key: "r", code: "KeyR" }).defaultPrevented,
      false,
    );
    assert.deepEqual(seen, ["F5", "r", "R", "r"]);
    handle.close();
  });

  it("stops guarding once the window is closed", async () => {
    reset();
    const { child, handle } = await openWithChild();
    handle.close();
    assert.equal(
      press(child.win.document, { key: "F5", code: "F5" }).defaultPrevented,
      false,
    );
  });
});

describe("close tracking", () => {
  it("child pagehide: unregisters, stops mirroring, runs callbacks once", async () => {
    reset();
    const { child, handle } = await openWithChild();
    let runs = 0;
    handle.onClose(() => runs++);
    const off = handle.onClose(() => assert.fail("unsubscribed callback ran"));
    off();

    child.setClosed(true);
    child.win.dispatchEvent(new child.win.Event("pagehide"));
    child.win.dispatchEvent(new child.win.Event("pagehide"));
    assert.equal(runs, 1);
    assert.deepEqual(recorder.unregistered, [handle.id]);
    assert.equal(handle.closed(), true);

    const before = headSummary(child.win.document);
    const extra = mainWin.document.createElement("style");
    mainWin.document.head.appendChild(extra);
    mainWin.document.documentElement.setAttribute("data-after", "1");
    await flush();
    assert.deepEqual(headSummary(child.win.document), before);
    assert.equal(
      child.win.document.documentElement.hasAttribute("data-after"),
      false,
    );
    extra.remove();
    mainWin.document.documentElement.removeAttribute("data-after");

    handle.close();
    assert.equal(runs, 1);
  });

  it("polls win.closed every second for a close the child never reported", async (t) => {
    reset();
    t.mock.timers.enable({ apis: ["setInterval"] });
    const { child, handle } = await openWithChild();
    let runs = 0;
    handle.onClose(() => runs++);

    t.mock.timers.tick(1000);
    assert.equal(runs, 0, "closed an open window");
    child.setClosed(true);
    t.mock.timers.tick(999);
    assert.equal(runs, 0);
    t.mock.timers.tick(1);
    assert.equal(runs, 1);
    t.mock.timers.tick(5000);
    assert.equal(runs, 1);
    assert.deepEqual(recorder.unregistered, [handle.id]);
  });

  it("close() closes the window and runs callbacks once; late subscribers still hear", async () => {
    reset();
    const { child, handle } = await openWithChild();
    let runs = 0;
    handle.onClose(() => runs++);
    assert.equal(handle.closed(), false);
    handle.close();
    handle.close();
    assert.equal(child.closeCalls, 1);
    assert.equal(runs, 1);
    assert.equal(handle.closed(), true);

    let late = 0;
    handle.onClose(() => late++);
    assert.equal(late, 0, "a late callback ran re-entrantly");
    await flush();
    assert.equal(late, 1);
  });

  it("one throwing callback does not stop the others", async () => {
    reset();
    const { handle } = await openWithChild();
    const errors = mock.method(console, "error", () => {});
    let ran = false;
    handle.onClose(() => {
      throw new Error("boom");
    });
    handle.onClose(() => (ran = true));
    handle.close();
    errors.mock.restore();
    assert.equal(ran, true);
  });

  it("main pagehide closes every open child", async () => {
    reset();
    const a = await openWithChild();
    const b = await openWithChild();
    const done = await openWithChild();
    done.handle.close();
    const closes = [0, 0];
    a.handle.onClose(() => closes[0]++);
    b.handle.onClose(() => closes[1]++);

    mainWin.dispatchEvent(new mainWin.Event("pagehide"));
    assert.deepEqual(closes, [1, 1]);
    assert.equal(a.child.closeCalls, 1);
    assert.equal(b.child.closeCalls, 1);
    assert.equal(done.child.closeCalls, 1);
  });

  it("a reloaded child (pagehide, still open) is closed on main's next task", async () => {
    reset();
    const { child, handle } = await openWithChild();
    let runs = 0;
    handle.onClose(() => runs++);

    child.win.dispatchEvent(new child.win.Event("pagehide"));
    assert.equal(runs, 1);
    assert.deepEqual(recorder.unregistered, [handle.id]);
    assert.equal(child.closeCalls, 0, "closed inside the child's pagehide");
    await flush();
    assert.equal(child.closeCalls, 1);
    assert.equal(runs, 1);
  });

  it("a child that really closed is not closed a second time", async () => {
    reset();
    const { child, handle } = await openWithChild();
    child.setClosed(true);
    child.win.dispatchEvent(new child.win.Event("pagehide"));
    await flush();
    assert.equal(child.closeCalls, 0);
    assert.equal(handle.closed(), true);
  });
});
