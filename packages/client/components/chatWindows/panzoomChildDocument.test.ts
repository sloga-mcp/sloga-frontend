/**
 * Run with:
 *
 *     node --conditions=browser --test components/chatWindows/panzoomChildDocument.test.ts
 *
 * Pins the `@panzoom/panzoom` patch (`patches/@panzoom__panzoom@4.6.0.patch`).
 *
 * The image viewer hands its `<img>` to Panzoom. Panzoom refused any element
 * not attached to the GLOBAL `document`, and in a chat window (a same-realm
 * child the main realm renders into) the image belongs to the child's
 * document, so `Panzoom()` threw. The throw aborted the effects queued after
 * the viewer's own, the fade-in among them, and the window showed only the
 * dark scrim. The patch checks the element's own document, and binds the
 * drag listeners there too, so panning works in a chat window as well.
 *
 * The DOM is faked: just enough of a node tree, two documents and a style
 * object for Panzoom's init and bind/destroy.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

type Listeners = Map<string, Set<unknown>>;

class FakeTarget {
  listeners: Listeners = new Map();
  addEventListener(name: string, handler: unknown) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(handler);
  }
  removeEventListener(name: string, handler: unknown) {
    this.listeners.get(name)?.delete(handler);
  }
  /** Event names that currently have a listener. */
  bound(): string[] {
    return [...this.listeners]
      .filter(([, handlers]) => handlers.size > 0)
      .map(([name]) => name)
      .sort();
  }
}

class FakeDocument extends FakeTarget {
  nodeType = 9;
  createElement() {
    return { style: { transform: "", transformOrigin: "" } };
  }
}

class FakeElement extends FakeTarget {
  nodeType = 1;
  nodeName = "IMG";
  namespaceURI = "http://www.w3.org/1999/xhtml";
  style: Record<string, string> = {};
  ownerDocument: FakeDocument;
  parentNode: FakeElement | FakeDocument | null;
  constructor(
    ownerDocument: FakeDocument,
    parentNode: FakeElement | FakeDocument | null,
  ) {
    super();
    this.ownerDocument = ownerDocument;
    this.parentNode = parentNode;
  }
}

/** An `<img>` inside a `<div>` attached to `doc`. */
function imageIn(doc: FakeDocument): FakeElement {
  const wrapper = new FakeElement(doc, doc);
  return new FakeElement(doc, wrapper);
}

type PanzoomFn = (
  elem: unknown,
  options?: object,
) => { destroy(): void; bind(): void };

const mainDoc = new FakeDocument();
let Panzoom: PanzoomFn;

before(async () => {
  // Panzoom reads these at import (pointer event names, IE sniffing).
  const g = globalThis as Record<string, unknown>;
  g.document = mainDoc;
  g.ShadowRoot = class {};
  // Init schedules its first transform; the spec never needs it to run.
  g.requestAnimationFrame = () => 0;
  g.window = {
    PointerEvent: function PointerEvent() {},
    getComputedStyle: () => ({}),
  };

  // The ES build is what vite bundles.
  const main = createRequire(import.meta.url).resolve("@panzoom/panzoom");
  const es = join(dirname(main), "panzoom.es.js");
  Panzoom = (await import(pathToFileURL(es).href)).default;
});

describe("Panzoom in a chat window", () => {
  it("accepts an image attached to a chat window's document", () => {
    const childDoc = new FakeDocument();
    assert.doesNotThrow(() => Panzoom(imageIn(childDoc)));
  });

  it("still accepts an image in the main document", () => {
    assert.doesNotThrow(() => Panzoom(imageIn(mainDoc)));
  });

  it("still refuses an element that is not attached to any document", () => {
    const loose = new FakeElement(new FakeDocument(), null);
    assert.throws(() => Panzoom(loose), /attached to the DOM/);
  });

  it("drags on the image's own document and unbinds from it", () => {
    const childDoc = new FakeDocument();
    const before = mainDoc.bound();
    const zoom = Panzoom(imageIn(childDoc));

    assert.deepEqual(childDoc.bound(), [
      "pointercancel",
      "pointerleave",
      "pointermove",
      "pointerup",
    ]);
    assert.deepEqual(mainDoc.bound(), before, "nothing new on main");

    zoom.destroy();
    assert.deepEqual(childDoc.bound(), []);
  });

  it("is patched in the UMD build too", () => {
    const main = createRequire(import.meta.url).resolve("@panzoom/panzoom");
    const umd = readFileSync(join(dirname(main), "panzoom.js"), "utf8");
    assert.match(umd, /currentNode\.parentNode === node\.ownerDocument/);
    assert.match(umd, /onPointer\('move', boundDoc, handleMove/);
  });
});
