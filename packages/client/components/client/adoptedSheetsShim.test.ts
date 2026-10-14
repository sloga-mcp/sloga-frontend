// Unit spec for the chat-window adoptedStyleSheets shim. Run with Node's
// built-in runner from packages/client:
//   node --test --conditions=browser components/client/adoptedSheetsShim.test.ts
// Declared test count: 9 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
//
// Focus: an assignment the engine accepts is passed through untouched (no
// copy); on NotAllowedError, foreign sheets are copied with the target
// realm's CSSStyleSheet once per (sheet, document) and reused, while
// same-realm sheets and earlier copies keep their identity; any other error
// rethrows without a retry; the getter is untouched; patching and install are
// idempotent. Realms are faked: each fake window has its own CSSStyleSheet
// class, and the fake engine setter rejects sheets of another realm the way
// Chromium does.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type SheetCache,
  copySheetFor,
  installAdoptedSheetsShim,
  patchAdoptedSheets,
  patchedSetter,
} from "./adoptedSheetsShim.ts";

/** A realm: its own CSSStyleSheet class plus a document whose window has it. */
function fakeRealm(name: string) {
  const made: FakeSheet[] = [];
  class FakeSheet {
    realm = name;
    rules: { cssText: string }[] = [];
    media: { mediaText: string };
    disabled: boolean;
    text: string | undefined;
    constructor(opts: { media?: string; disabled?: boolean } = {}) {
      this.media = { mediaText: opts.media ?? "" };
      this.disabled = opts.disabled ?? false;
      made.push(this);
    }
    get cssRules() {
      return this.rules;
    }
    replaceSync(text: string) {
      this.text = text;
    }
  }
  const doc = {
    realm: name,
    defaultView: { CSSStyleSheet: FakeSheet },
  } as unknown as Document;

  /** A sheet "constructed" in this realm, with the given rules. */
  function sheet(...rules: string[]) {
    const s = new FakeSheet();
    s.rules = rules.map((cssText) => ({ cssText }));
    made.length = 0; // fixtures don't count as copies
    return s as unknown as CSSStyleSheet;
  }
  return { name, doc, FakeSheet, made, sheet };
}

type Root = { doc: Document; stored?: readonly CSSStyleSheet[] };

function notAllowed() {
  return Object.assign(new Error("Sharing constructed stylesheets"), {
    name: "NotAllowedError",
  });
}

/** An engine setter that refuses sheets from another realm, like Chromium. */
function fakeEngine() {
  const calls: (readonly CSSStyleSheet[])[] = [];
  function origSet(this: unknown, value: readonly CSSStyleSheet[]) {
    const root = this as Root;
    calls.push(value);
    const Ctor = (
      root.doc.defaultView as unknown as {
        CSSStyleSheet: new () => unknown;
      }
    ).CSSStyleSheet;
    for (const s of value) if (!(s instanceof Ctor)) throw notAllowed();
    root.stored = value;
  }
  return { calls, origSet };
}

const docOfRoot = (root: unknown) => (root as Root).doc;

test("an accepted assignment passes through untouched, with no copy", () => {
  const main = fakeRealm("main");
  const engine = fakeEngine();
  const set = patchedSetter(engine.origSet, docOfRoot, new WeakMap());

  const sheets = [main.sheet("a{}"), main.sheet("b{}")];
  const root: Root = { doc: main.doc };
  set.call(root, sheets);

  assert.equal(root.stored, sheets, "the very same array reaches the engine");
  assert.equal(engine.calls.length, 1, "no retry");
  assert.equal(main.made.length, 0, "nothing constructed");
});

test("foreign sheets are copied into the target realm on NotAllowedError", () => {
  const main = fakeRealm("main");
  const child = fakeRealm("child");
  const engine = fakeEngine();
  const set = patchedSetter(engine.origSet, docOfRoot, new WeakMap());

  const foreign = main.sheet(":host{display:block}", ".x{color:red}");
  Object.assign(foreign, { media: { mediaText: "screen" }, disabled: true });
  const own = child.sheet("c{}");
  const root: Root = { doc: child.doc };
  set.call(root, [foreign, own]);

  assert.equal(engine.calls.length, 2, "original tried, then the retry");
  const [copy, kept] = root.stored!;
  assert.ok(copy instanceof child.FakeSheet, "copy is of the child's realm");
  assert.notEqual(copy, foreign);
  const c = copy as unknown as InstanceType<typeof child.FakeSheet>;
  assert.equal(c.text, ":host{display:block}\n.x{color:red}");
  assert.equal(c.media.mediaText, "screen");
  assert.equal(c.disabled, true);
  assert.equal(kept, own, "a same-realm sheet keeps its identity and order");
  assert.equal(child.made.length, 1, "only the foreign sheet was copied");
});

test("a copy is made once per (sheet, document) and reused", () => {
  const main = fakeRealm("main");
  const childA = fakeRealm("a");
  const childB = fakeRealm("b");
  const engine = fakeEngine();
  const set = patchedSetter(engine.origSet, docOfRoot, new WeakMap());

  const foreign = main.sheet("a{}");
  const r1: Root = { doc: childA.doc };
  const r2: Root = { doc: childA.doc };
  const r3: Root = { doc: childB.doc };
  set.call(r1, [foreign]);
  set.call(r2, [foreign]);
  set.call(r3, [foreign]);

  assert.equal(r1.stored![0], r2.stored![0], "same document shares the copy");
  assert.equal(childA.made.length, 1);
  assert.notEqual(
    r3.stored![0],
    r1.stored![0],
    "another document gets its own",
  );
  assert.equal(childB.made.length, 1);
});

test("re-assigning earlier copies plus a new sheet copies only the new one", () => {
  const main = fakeRealm("main");
  const child = fakeRealm("child");
  const engine = fakeEngine();
  const set = patchedSetter(engine.origSet, docOfRoot, new WeakMap());

  const root: Root = { doc: child.doc };
  set.call(root, [main.sheet("a{}")]);
  const first = root.stored![0];
  set.call(root, [...root.stored!, main.sheet("b{}")]);

  assert.equal(root.stored![0], first, "the earlier copy is passed as is");
  assert.equal(child.made.length, 2, "one copy per foreign sheet, no re-copy");
});

test("an error other than NotAllowedError rethrows without a retry", () => {
  const child = fakeRealm("child");
  const main = fakeRealm("main");
  let calls = 0;
  const boom = new TypeError("not a sequence");
  const set = patchedSetter(
    () => {
      calls++;
      throw boom;
    },
    docOfRoot,
    new WeakMap(),
  );

  assert.throws(
    () => set.call({ doc: child.doc }, [main.sheet("a{}")]),
    (err) => err === boom,
  );
  assert.equal(calls, 1);
  assert.equal(child.made.length, 0);
});

test("a NotAllowedError with no usable window rethrows the original", () => {
  const main = fakeRealm("main");
  const engine = fakeEngine();
  const closed = { defaultView: null } as unknown as Document;
  const set = patchedSetter(
    function (this: unknown, value) {
      engine.calls.push(value);
      throw notAllowed();
    },
    () => closed,
    new WeakMap(),
  );

  assert.throws(
    () => set.call({}, [main.sheet("a{}")]),
    (err: Error) => err.name === "NotAllowedError",
  );
  assert.equal(engine.calls.length, 1, "no retry without copies");
});

test("copySheetFor caches in the given map and passes own-realm sheets", () => {
  const main = fakeRealm("main");
  const child = fakeRealm("child");
  const cache: SheetCache = new WeakMap();
  const foreign = main.sheet("a{}");

  const copy = copySheetFor(foreign, child.doc, cache);
  assert.equal(cache.get(foreign)?.get(child.doc), copy);
  assert.equal(copySheetFor(foreign, child.doc, cache), copy);
  assert.equal(copySheetFor(copy, child.doc, cache), copy);
  assert.equal(child.made.length, 1);
});

test("patchAdoptedSheets keeps the getter, is idempotent, skips bad descriptors", () => {
  const getter = () => [];
  const setter = () => {};
  const proto = {};
  Object.defineProperty(proto, "adoptedStyleSheets", {
    get: getter,
    set: setter,
    configurable: true,
    enumerable: true,
  });

  assert.equal(patchAdoptedSheets(proto, docOfRoot, new WeakMap()), true);
  const once = Object.getOwnPropertyDescriptor(proto, "adoptedStyleSheets")!;
  assert.equal(once.get, getter, "getter untouched");
  assert.notEqual(once.set, setter, "setter wrapped");
  assert.equal(once.enumerable, true);

  assert.equal(patchAdoptedSheets(proto, docOfRoot, new WeakMap()), true);
  const twice = Object.getOwnPropertyDescriptor(proto, "adoptedStyleSheets")!;
  assert.equal(twice.set, once.set, "not wrapped a second time");

  const locked = {};
  Object.defineProperty(locked, "adoptedStyleSheets", {
    get: getter,
    set: setter,
    configurable: false,
  });
  assert.equal(patchAdoptedSheets(locked, docOfRoot, new WeakMap()), false);
  assert.equal(
    Object.getOwnPropertyDescriptor(locked, "adoptedStyleSheets")!.set,
    setter,
  );
  assert.equal(patchAdoptedSheets({}, docOfRoot, new WeakMap()), false);
});

test("installAdoptedSheetsShim patches ShadowRoot and Document once", () => {
  const main = fakeRealm("main");
  const child = fakeRealm("child");
  const engine = fakeEngine();
  const g = globalThis as Record<string, unknown>;
  const saved = { ShadowRoot: g.ShadowRoot, Document: g.Document };

  class FakeShadowRoot {
    ownerDocument: Document;
    stored?: readonly CSSStyleSheet[];
    constructor(doc: Document) {
      this.ownerDocument = doc;
    }
  }
  class FakeDocument {}
  const rootGet = function (this: FakeShadowRoot) {
    return this.stored ?? [];
  };
  Object.defineProperty(FakeShadowRoot.prototype, "adoptedStyleSheets", {
    get: rootGet,
    set(this: FakeShadowRoot, value: readonly CSSStyleSheet[]) {
      // Realm check against the owner document, as the engine does.
      engine.origSet.call({ doc: this.ownerDocument }, value);
      this.stored = value;
    },
    configurable: true,
  });
  const docSet = () => {};
  Object.defineProperty(FakeDocument.prototype, "adoptedStyleSheets", {
    get: () => [],
    set: docSet,
    configurable: true,
  });

  g.ShadowRoot = FakeShadowRoot;
  g.Document = FakeDocument;
  try {
    installAdoptedSheetsShim();
    const rootSet = Object.getOwnPropertyDescriptor(
      FakeShadowRoot.prototype,
      "adoptedStyleSheets",
    )!;
    const docDesc = Object.getOwnPropertyDescriptor(
      FakeDocument.prototype,
      "adoptedStyleSheets",
    )!;
    assert.equal(rootSet.get, rootGet, "getter untouched");
    assert.notEqual(docDesc.set, docSet, "Document setter wrapped too");

    installAdoptedSheetsShim();
    assert.equal(
      Object.getOwnPropertyDescriptor(
        FakeShadowRoot.prototype,
        "adoptedStyleSheets",
      )!.set,
      rootSet.set,
      "second install is a no-op",
    );

    const root = new FakeShadowRoot(child.doc);
    const foreign = main.sheet("a{}");
    (
      root as unknown as { adoptedStyleSheets: CSSStyleSheet[] }
    ).adoptedStyleSheets = [foreign];
    assert.ok(
      root.stored![0] instanceof child.FakeSheet,
      "copied via ownerDocument",
    );
  } finally {
    g.ShadowRoot = saved.ShadowRoot;
    g.Document = saved.Document;
  }
});
