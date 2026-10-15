/**
 * Clipboard routing for chat windows.
 *
 * A chat window is a same-realm child that the main realm renders into, so a
 * copy button inside one still calls MAIN's `navigator.clipboard`. Browsers
 * reject async-clipboard calls from a document without focus ("Document is
 * not focused"), and while the user is in a chat window the main document
 * never has it, so every copy from a chat window would fail. The shim wraps
 * main's clipboard once and, whenever main is not focused, forwards each call
 * to the clipboard of the window the user is actually in.
 *
 * The routing decision ({@link clipboardTarget}) and the wrapping
 * ({@link wrapClipboard}) take their windows as arguments, so `node --test`
 * covers both with fakes; only {@link installClipboardShim} reads globals.
 */
import {
  type WindowCtx,
  allWindowCtxs,
  lastFocusedCtx,
  MAIN_CTX,
} from "./windowCtx.ts";

/** The slice of a window the router reads. */
export type ClipboardWindow = Pick<WindowCtx, "id" | "doc" | "win">;

type ClipboardMethod = "writeText" | "readText" | "write" | "read";

const METHODS: readonly ClipboardMethod[] = [
  "writeText",
  "readText",
  "write",
  "read",
];

/**
 * Marks a clipboard object as wrapped. Lives on the object rather than only
 * in module state, so a re-evaluated module (HMR) cannot wrap the wrappers.
 */
const WRAPPED = Symbol.for("sloga.clipboardShim.wrapped");

let installed = false;

function isMain(ctx: ClipboardWindow, mainWin: unknown): boolean {
  return ctx.id === MAIN_CTX.id || ctx.win === mainWin;
}

/** A window that closed, or whose document throws, counts as unfocused. */
function hasFocus(ctx: ClipboardWindow): boolean {
  try {
    return !ctx.win.closed && ctx.doc.hasFocus();
  } catch {
    return false;
  }
}

function isOpen(ctx: ClipboardWindow): boolean {
  try {
    return !ctx.win.closed;
  } catch {
    return false;
  }
}

/**
 * Which window should serve a clipboard call made from the main realm:
 * `null` means main's own clipboard (the original methods), anything else is
 * the child to forward to. Main wins whenever it has focus; otherwise the
 * first child that has focus, else the most recently focused one.
 *
 * A main entry is never returned: main's `navigator.clipboard` IS the wrapped
 * object, so forwarding to it would recurse.
 */
export function clipboardTarget(
  mainHasFocus: boolean,
  ctxs: readonly ClipboardWindow[],
  lastFocused: () => ClipboardWindow,
  mainWin: unknown,
): ClipboardWindow | null {
  if (mainHasFocus) return null;

  for (const ctx of ctxs) {
    if (!isMain(ctx, mainWin) && hasFocus(ctx)) return ctx;
  }

  const last = lastFocused();
  return isMain(last, mainWin) || !isOpen(last) ? null : last;
}

/**
 * Rebuild each item with the target realm's `ClipboardItem`, so the child's
 * clipboard is handed objects of its own realm. `getType` promises are passed
 * through unawaited and the items are built synchronously: Safari rejects a
 * write whose item was constructed after the user gesture was spent (see
 * `copyImageToClipboard`).
 */
function rebuildItems(items: ClipboardItems, win: Window): ClipboardItem[] {
  const Item = (win as Window & typeof globalThis).ClipboardItem;
  if (typeof Item !== "function") return Array.from(items);

  return Array.from(items, (item) => {
    const data: Record<string, Promise<Blob>> = {};
    for (const type of item.types) data[type] = item.getType(type);
    return item.presentationStyle
      ? new Item(data, { presentationStyle: item.presentationStyle })
      : new Item(data);
  });
}

/** Run `call`, turning a synchronous throw into a rejection like the originals. */
function settle<T>(call: () => Promise<T>): Promise<T> {
  try {
    return call();
  } catch (err) {
    return Promise.reject(err);
  }
}

/**
 * Replace `clipboard`'s methods with routing wrappers. Only methods the
 * engine has are wrapped (Firefox long lacked `read` / `write`). The
 * originals are kept bound to `clipboard`, so they keep their receiver no
 * matter how the wrapper is called; a forwarded call is a method call on the
 * child's own clipboard. A clipboard that is already wrapped is left alone.
 */
export function wrapClipboard(
  clipboard: Clipboard,
  route: () => ClipboardWindow | null,
): void {
  const marked = clipboard as Clipboard & { [WRAPPED]?: true };
  if (marked[WRAPPED]) return;

  const original: Partial<Clipboard> = {};
  for (const name of METHODS) {
    if (typeof clipboard[name] === "function") {
      Object.assign(original, { [name]: clipboard[name].bind(clipboard) });
    }
  }

  /** The child's clipboard for this call, or undefined to use main's. */
  function target(name: ClipboardMethod) {
    const ctx = route();
    if (!ctx) return undefined;
    const child = ctx.win.navigator?.clipboard;
    // Without the method in the child, main's original raises the engine's
    // own error instead of a made-up one.
    return child && typeof child[name] === "function"
      ? { ctx, child }
      : undefined;
  }

  const wrappers: Partial<Clipboard> = {
    writeText: (data: string) =>
      settle(() => {
        const to = target("writeText");
        return to ? to.child.writeText(data) : original.writeText!(data);
      }),
    readText: () =>
      settle(() => {
        const to = target("readText");
        return to ? to.child.readText() : original.readText!();
      }),
    write: (data: ClipboardItems) =>
      settle(() => {
        const to = target("write");
        return to
          ? to.child.write(rebuildItems(data, to.ctx.win))
          : original.write!(data);
      }),
    read: () =>
      settle(() => {
        const to = target("read");
        return to ? to.child.read() : original.read!();
      }),
  };

  for (const name of METHODS) {
    if (!original[name]) continue;
    Object.defineProperty(clipboard, name, {
      value: wrappers[name],
      configurable: true,
      writable: true,
    });
  }
  Object.defineProperty(clipboard, WRAPPED, { value: true });
}

/**
 * Wrap the MAIN realm's `navigator.clipboard` so calls made while a chat
 * window has focus reach that window's clipboard. Idempotent; a no-op where
 * there is no async clipboard (insecure context).
 */
export function installClipboardShim(): void {
  if (installed) return;
  installed = true;

  const clipboard =
    typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!clipboard) return;

  const mainWin = typeof window === "undefined" ? undefined : window;
  wrapClipboard(clipboard, () =>
    clipboardTarget(
      document.hasFocus(),
      allWindowCtxs(),
      lastFocusedCtx,
      mainWin,
    ),
  );
}
