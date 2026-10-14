/**
 * Constructed-stylesheet sharing for chat windows.
 *
 * A chat window is a same-origin child document that the main realm renders
 * into. mdui (Lit) builds each component's styles ONCE as constructed
 * stylesheets in the main document and adopts them into every shadow root,
 * but Chromium refuses to adopt a constructed sheet into a root of another
 * document ("NotAllowedError: Sharing constructed stylesheets in multiple
 * documents is not allowed"). The element then renders unstyled at 0x0
 * (mdui-checkbox, mdui-text-field).
 *
 * The shim wraps the `adoptedStyleSheets` SETTER (the getter is untouched):
 * it tries the original first, and only when that throws NotAllowedError does
 * it retry with per-document copies of the foreign sheets, built with the
 * target window's own `CSSStyleSheet` and cached per (sheet, document) so a
 * hundred checkboxes share one copy. Copies are snapshots: a later
 * `replaceSync` on the main sheet does not reach them, which is fine for
 * Lit's static component styles.
 *
 * Limitation: only assignment is covered. An in-place
 * `root.adoptedStyleSheets.push(sheet)` goes through the observable array,
 * not this setter; Lit assigns.
 *
 * {@link copySheetFor}, {@link patchedSetter} and {@link patchAdoptedSheets}
 * take their collaborators as arguments, so `node --test` drives them with
 * fakes (jsdom has no constructable stylesheets); only
 * {@link installAdoptedSheetsShim} reads globals.
 */

/** Per original sheet, its copy for each foreign document. */
export type SheetCache = WeakMap<
  CSSStyleSheet,
  WeakMap<Document, CSSStyleSheet>
>;

type Setter = (this: unknown, value: readonly CSSStyleSheet[]) => void;

/** Marks a patched setter, so a re-evaluated module (HMR) cannot wrap it twice. */
const PATCHED = Symbol.for("sloga.adoptedSheetsShim.patched");

let installed = false;

/** Name check, not `instanceof`: the error may come from the child's realm. */
function isNotAllowed(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "NotAllowedError"
  );
}

/** The `CSSStyleSheet` constructor of `doc`'s realm, if it has a live window. */
function sheetCtorOf(doc: Document): typeof CSSStyleSheet | undefined {
  const ctor = (doc.defaultView as (Window & typeof globalThis) | null)
    ?.CSSStyleSheet;
  return typeof ctor === "function" ? ctor : undefined;
}

/**
 * A copy of `sheet` that `doc` may adopt, made once per (sheet, doc). A sheet
 * that already belongs to `doc`'s realm (including an earlier copy, which
 * Lit hands back when it re-assigns `[...adoptedStyleSheets, next]`) is
 * returned as is.
 */
export function copySheetFor(
  sheet: CSSStyleSheet,
  doc: Document,
  cache: SheetCache,
): CSSStyleSheet {
  const Ctor = sheetCtorOf(doc);
  if (!Ctor) throw new Error("adoptedSheetsShim: document has no window");
  // Realm check, cast so TS does not narrow the foreign path to `never`.
  if ((sheet as unknown) instanceof Ctor) return sheet;

  let perDoc = cache.get(sheet);
  const cached = perDoc?.get(doc);
  if (cached) return cached;

  const copy = new Ctor({
    media: sheet.media?.mediaText ?? "",
    disabled: sheet.disabled,
  });
  copy.replaceSync(
    Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n"),
  );

  if (!perDoc) {
    perDoc = new WeakMap();
    cache.set(sheet, perDoc);
  }
  perDoc.set(doc, copy);
  return copy;
}

/**
 * Wrap an `adoptedStyleSheets` setter. `docOf` maps the receiver to the
 * document whose realm the sheets must belong to (a shadow root's
 * `ownerDocument`, or the document itself). Any error other than
 * NotAllowedError, or a failure while copying, rethrows the ORIGINAL error so
 * the engine's message is what surfaces.
 */
export function patchedSetter(
  origSet: Setter,
  docOf: (target: unknown) => Document | null | undefined,
  cache: SheetCache,
): Setter {
  const setter: Setter = function (this: unknown, value) {
    try {
      origSet.call(this, value);
      return;
    } catch (err) {
      if (!isNotAllowed(err)) throw err;

      let local: CSSStyleSheet[];
      try {
        const doc = docOf(this);
        if (!doc) throw err;
        local = Array.from(value, (sheet) => copySheetFor(sheet, doc, cache));
      } catch {
        throw err;
      }
      origSet.call(this, local);
    }
  };
  Object.defineProperty(setter, PATCHED, { value: true });
  return setter;
}

/**
 * Replace the `adoptedStyleSheets` setter on `proto`, keeping its getter.
 * Returns whether the property is (now) patched; a missing, setter-less or
 * non-configurable descriptor is left alone.
 */
export function patchAdoptedSheets(
  proto: object,
  docOf: (target: unknown) => Document | null | undefined,
  cache: SheetCache,
): boolean {
  const desc = Object.getOwnPropertyDescriptor(proto, "adoptedStyleSheets");
  if (!desc?.set || !desc.configurable) return false;
  if ((desc.set as Setter & { [PATCHED]?: true })[PATCHED]) return true;

  Object.defineProperty(proto, "adoptedStyleSheets", {
    get: desc.get,
    set: patchedSetter(desc.set as Setter, docOf, cache),
    enumerable: desc.enumerable,
    configurable: true,
  });
  return true;
}

/**
 * Let main-realm constructed stylesheets be adopted into chat-window
 * documents and their shadow roots. Idempotent; a no-op where the engine has
 * no `adoptedStyleSheets`.
 */
export function installAdoptedSheetsShim(): void {
  if (installed) return;
  installed = true;

  const cache: SheetCache = new WeakMap();
  if (typeof ShadowRoot !== "undefined") {
    patchAdoptedSheets(
      ShadowRoot.prototype,
      (root) => (root as ShadowRoot).ownerDocument,
      cache,
    );
  }
  if (typeof Document !== "undefined") {
    patchAdoptedSheets(Document.prototype, (doc) => doc as Document, cache);
  }
}
