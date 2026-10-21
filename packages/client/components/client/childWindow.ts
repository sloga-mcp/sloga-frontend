/**
 * Opens a chat window: a same-realm child (`window.open("about:blank")`) that
 * the MAIN app renders into through a `<Portal>`. This module only prepares
 * the child document and tracks its life; it renders nothing.
 *
 * A fresh about:blank document has none of main's styles, no Solid event
 * delegation and no `#floating`, and a click on a link inside it would load
 * the whole app a second time in the child. Everything here exists to close
 * those gaps without ever running app code in the child realm: no script is
 * copied across, and the child's own `__TAURI__` / `slogaShell` are never
 * touched (it has no capability, so they would only fail).
 *
 * The pure decisions (features string, window id, link routing, which head
 * nodes to mirror) are exported for `childWindow.test.ts`.
 */
import { DelegatedEvents, delegateEvents } from "solid-js/web";

import { installAdoptedSheetsShim } from "./adoptedSheetsShim.ts";
import * as chatShell from "./chatShell.ts";
import { installClipboardShim } from "./clipboardShim.ts";
import { type WindowCtx, registerWindowCtx } from "./windowCtx.ts";

export type ChildWindowKind = "friends" | "chat";

export type ChildWindowHandle = {
  /** Unique, also the window.open name (never reused). */
  id: string;
  kind: ChildWindowKind;
  /** Label returned by chatShell.arm (undefined on web). */
  shellLabel?: string;
  /**
   * What the shell built around the window, from chatShell.arm: `buttons`
   * (no OS title bar; the window draws minimize, maximize and close),
   * `inset` (macOS traffic lights over the window's own bar), or `native`
   * (the OS frame; also web and older shells).
   */
  frame: chatShell.ChatWindowFrame;
  ctx: WindowCtx;
  focus(): void;
  close(): void;
  closed(): boolean;
  onClose(cb: () => void): () => void;
};

export type ChildWindowOptions = {
  left?: number;
  top?: number;
  width: number;
  height: number;
  title?: string;
};

/* ------------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------------ */

/**
 * `window.open` features in CSS px, in the shape the spike proved on both
 * shells. A missing or non-finite position is left out so the shell can
 * restore the saved bounds for that kind instead.
 */
export function childWindowFeatures(
  opts: Pick<ChildWindowOptions, "left" | "top" | "width" | "height">,
): string {
  const parts: string[] = [];
  const size = (key: string, value: number) => {
    if (Number.isFinite(value))
      parts.push(`${key}=${Math.max(1, Math.round(value))}`);
  };
  const position = (key: string, value: number | undefined) => {
    if (value !== undefined && Number.isFinite(value))
      parts.push(`${key}=${Math.round(value)}`);
  };

  size("width", opts.width);
  size("height", opts.height);
  position("left", opts.left);
  position("top", opts.top);
  return parts.join(",");
}

/**
 * The window id, which is also its `window.open` name. Opening with a name
 * that is still in use would blank that window, so ids are never reused: the
 * counter is per session and the timestamp separates sessions.
 */
export function childWindowId(
  kind: ChildWindowKind,
  counter: number,
  now: number,
): string {
  return `${kind}-${counter}-${now.toString(36)}`;
}

let windowCounter = 0;

/** The next unused window id for this session. */
export function nextChildWindowId(kind: ChildWindowKind): string {
  windowCounter += 1;
  return childWindowId(kind, windowCounter, Date.now());
}

export type ChildLinkRoute =
  | { kind: "internal"; href: string }
  | { kind: "external"; href: string }
  | { kind: "download"; href: string }
  | { kind: "ignore" };

/**
 * Schemes allowed to leave for the system browser; the same list
 * `RenderAnchor` renders as links. Anything else (`javascript:`, `data:`,
 * `blob:`, `file:`) is dropped: opening it from main would run or show it
 * with main's origin.
 */
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

/**
 * Same origin as main. Compared by protocol and host rather than `origin`,
 * because a custom scheme (Electron's `app://`) has the opaque origin `"null"`
 * in WHATWG URL parsing, and every other custom-scheme URL would match it.
 */
export function isSameOriginHref(url: URL, main: URL): boolean {
  return url.protocol === main.protocol && url.host === main.host;
}

/** Schemes a `download` link may carry; a `blob:` must also be main's own. */
const DOWNLOAD_PROTOCOLS = new Set(["http:", "https:"]);

function isOwnBlob(url: URL, main: URL): boolean {
  if (url.protocol !== "blob:") return false;
  try {
    return isSameOriginHref(new URL(url.pathname), main);
  } catch {
    return false;
  }
}

/**
 * Where a link clicked inside a chat window goes. `rawHref` is the `href`
 * attribute as written; it is resolved against main's URL, never the child's
 * about:blank. `download` is whether the anchor has a `download` attribute:
 * those stay downloads (same-origin, main's own `blob:`, or http(s)) and are
 * never handed to the router or the system browser by this decision.
 */
export function classifyChildLink(
  rawHref: string | null,
  mainHref: string,
  download = false,
): ChildLinkRoute {
  const trimmed = rawHref?.trim();
  // A bare fragment means nothing in main; it is a button dressed as a link.
  if (!trimmed || trimmed.startsWith("#")) return { kind: "ignore" };

  let url: URL;
  let main: URL;
  try {
    main = new URL(mainHref);
    url = new URL(trimmed, main);
  } catch {
    return { kind: "ignore" };
  }

  if (download) {
    return isSameOriginHref(url, main) ||
      isOwnBlob(url, main) ||
      DOWNLOAD_PROTOCOLS.has(url.protocol)
      ? { kind: "download", href: url.href }
      : { kind: "ignore" };
  }

  if (isSameOriginHref(url, main)) return { kind: "internal", href: url.href };
  if (EXTERNAL_PROTOCOLS.has(url.protocol))
    return { kind: "external", href: url.href };
  return { kind: "ignore" };
}

/**
 * Only stylesheets cross into the child: `<style>` and
 * `<link rel="stylesheet">`. Never `<script>`, and no other `<link>`
 * (modulepreload, icons), so no app code ever runs in the child realm.
 */
export function isMirroredHeadNode(node: Node): node is HTMLElement {
  if (node.nodeType !== 1) return false;
  const name = node.nodeName.toLowerCase();
  if (name === "style") return true;
  if (name !== "link") return false;
  const rel = (node as Element).getAttribute("rel") ?? "";
  return rel.toLowerCase().split(/\s+/).includes("stylesheet");
}

/** `<html>` / `<body>` attributes mirrored into the child (theme, layout, locale). */
export function isMirroredRootAttribute(name: string): boolean {
  return (
    name === "class" ||
    name === "style" ||
    name === "lang" ||
    name.startsWith("data-")
  );
}

export type ReloadKeyEvent = Pick<
  KeyboardEvent,
  "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey"
>;

/**
 * The browser's reload keys: F5 (with Ctrl or Shift too), Ctrl/Cmd+R and
 * Ctrl/Cmd+Shift+R. A reloaded child is a blank about:blank that nothing
 * renders into, so these are cancelled in the child. The R is matched by
 * `key`, or by its physical key when the layout types a non-Latin letter
 * there (Chromium still reloads on Ctrl + that key); a Latin layout that puts
 * another letter on the physical R (Dvorak) keeps it.
 */
export function isReloadShortcut(event: ReloadKeyEvent): boolean {
  if (event.altKey) return false;
  if (event.key === "F5" || event.key === "BrowserRefresh") return true;
  if (!event.ctrlKey && !event.metaKey) return false;
  const key = event.key ?? "";
  return (
    key.toLowerCase() === "r" ||
    (event.code === "KeyR" && !/^[a-z]$/i.test(key))
  );
}

/**
 * Whether a close main made still needs the shell to finish it
 * (`chatShell.closeWindow`): for a window the shell labelled, unless main is
 * unloading. Then the shells close every child themselves, and a call from
 * the dying realm could land on a window the reloaded main opened under the
 * same label (the friends window's label never changes).
 */
export function shellCloseNeeded(
  shellLabel: string | undefined,
  mainUnloading: boolean,
): boolean {
  return shellLabel !== undefined && !mainUnloading;
}

/* ------------------------------------------------------------------------ *
 * Internal link routing
 * ------------------------------------------------------------------------ */

let internalLinkHandler: ((href: string, from: WindowCtx) => void) | null =
  null;

/**
 * Who handles a same-origin link clicked in a chat window (e.g. opening a
 * DM as a tab). `null` restores the default: focus main and let main's router
 * navigate there ({@link openInMain}, which a handler can fall back to).
 */
export function setInternalLinkHandler(
  fn: ((href: string, from: WindowCtx) => void) | null,
): void {
  internalLinkHandler = fn;
}

/**
 * Hand the link to main's router. A temporary anchor clicked in MAIN's
 * document goes through the router's document-level anchor handler, exactly
 * like a link in main, so there is no reload.
 */
export async function openInMain(href: string): Promise<void> {
  const focused = await chatShell.focusMain();
  if (!focused.ok) window.focus();

  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
  }
}

/**
 * A download link cannot run in the child (nav-locked to about:blank), so it
 * is recreated in MAIN with the same href, `download`, `target` and `rel`, and
 * clicked there: it downloads exactly as the same link in main would.
 */
function downloadInMain(href: string, source: Element) {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.setAttribute("download", source.getAttribute("download") ?? "");
  for (const name of ["target", "rel"]) {
    const value = source.getAttribute(name);
    if (value !== null) anchor.setAttribute(name, value);
  }
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
  }
}

function routeChildLink(anchor: Element, ctx: WindowCtx) {
  const route = classifyChildLink(
    anchor.getAttribute("href"),
    window.location.href,
    anchor.hasAttribute("download"),
  );
  switch (route.kind) {
    case "download":
      downloadInMain(route.href, anchor);
      return;
    case "internal": {
      const handler = internalLinkHandler;
      try {
        if (handler) handler(route.href, ctx);
        else
          void openInMain(route.href).catch((err) =>
            console.error("[chat-window] internal link failed", err),
          );
      } catch (err) {
        console.error("[chat-window] internal link handler threw", err);
      }
      return;
    }
    case "external":
      // From main: the shells send it to the system browser.
      window.open(route.href, "_blank", "noopener,noreferrer");
      return;
    case "ignore":
      return;
  }
}

function anchorFromEvent(event: Event): Element | undefined {
  for (const node of event.composedPath()) {
    const el = node as Element;
    if (
      el.nodeType === 1 &&
      el.nodeName.toLowerCase() === "a" &&
      el.hasAttribute("href")
    )
      return el;
  }
  return undefined;
}

/**
 * Every link click in the child is cancelled in the capture phase, before any
 * app handler runs, so nothing can let the child navigate away from
 * about:blank (not even a handler that stops propagation).
 *
 * The click is only ROUTED once the event has finished propagating, and only
 * if no app handler claimed it. Handlers such as `RenderAnchor`'s link warning
 * and the sidebar's edit mode call `preventDefault()` to say "I handled this";
 * routing in the capture phase would open an untrusted link without its
 * warning, or navigate anyway. So after cancelling, the event's
 * `preventDefault` / `defaultPrevented` are shadowed: app code sees an
 * untouched event, and a call is recorded as a claim. A handler that stops
 * propagation never reaches the routing listener on the child window; the
 * link stays inert rather than navigating.
 */
function installLinkCapture(ctx: WindowCtx): () => void {
  const pending = new WeakMap<Event, { anchor: Element; claimed: boolean }>();

  const onCapture = (event: MouseEvent) => {
    if (event.button !== 0 || event.defaultPrevented) return;
    const anchor = anchorFromEvent(event);
    if (!anchor) return;

    event.preventDefault();
    const entry = { anchor, claimed: false };
    pending.set(event, entry);
    Object.defineProperty(event, "defaultPrevented", {
      configurable: true,
      get: () => entry.claimed,
    });
    Object.defineProperty(event, "preventDefault", {
      configurable: true,
      value: () => {
        entry.claimed = true;
      },
    });
  };

  const onBubble = (event: MouseEvent) => {
    const entry = pending.get(event);
    if (!entry) return;
    pending.delete(event);
    if (entry.claimed) return;
    routeChildLink(entry.anchor, ctx);
  };

  ctx.doc.addEventListener("click", onCapture, true);
  ctx.win.addEventListener("click", onBubble);
  return () => {
    ctx.doc.removeEventListener("click", onCapture, true);
    ctx.win.removeEventListener("click", onBubble);
  };
}

/**
 * Cancels the reload keys in the child, in the capture phase. Only the
 * default action is cancelled: app keybinds still see the event. A reload the
 * page cannot veto (a native menu item, macOS key equivalents) is handled by
 * closing the reloaded window on its pagehide instead.
 */
function installReloadGuard(ctx: WindowCtx): () => void {
  const onKeydown = (event: KeyboardEvent) => {
    if (isReloadShortcut(event)) event.preventDefault();
  };
  ctx.doc.addEventListener("keydown", onKeydown, true);
  return () => ctx.doc.removeEventListener("keydown", onKeydown, true);
}

/* ------------------------------------------------------------------------ *
 * Document mirroring
 * ------------------------------------------------------------------------ */

function cloneHeadNode(node: HTMLElement, childDoc: Document): HTMLElement {
  const clone = childDoc.importNode(node, true);
  // Absolute, so it never depends on how the child resolves relative URLs.
  if (node.nodeName.toLowerCase() === "link" && node.hasAttribute("href"))
    clone.setAttribute("href", (node as HTMLLinkElement).href);
  return clone;
}

/**
 * Copy main's stylesheets into the child head in document order (cascade
 * order is DOM order, whatever order they load in), then keep the copy in
 * step: chunks loaded later append `<link>`s, the dev server rewrites
 * `<style>` text. Returns the observer's disconnect.
 */
function mirrorHead(childDoc: Document): () => void {
  const sourceHead = document.head;
  const targetHead = childDoc.head;
  const clones = new Map<Node, HTMLElement>();

  /** Insert before the clone of the next mirrored source sibling, keeping order. */
  const insert = (node: HTMLElement) => {
    const clone = cloneHeadNode(node, childDoc);
    let anchor: HTMLElement | null = null;
    for (let s = node.nextSibling; s; s = s.nextSibling) {
      const c = clones.get(s);
      if (c && c.parentNode === targetHead) {
        anchor = c;
        break;
      }
    }
    targetHead.insertBefore(clone, anchor);
    clones.set(node, clone);
  };

  const remove = (node: Node) => {
    clones.get(node)?.remove();
    clones.delete(node);
  };

  /** The mirrored head node `node` belongs to (itself or its `<style>`'s text). */
  const owner = (node: Node | null): Node | undefined => {
    for (let n = node; n && n !== sourceHead; n = n.parentNode) {
      if (clones.has(n)) return n;
    }
    return undefined;
  };

  for (const node of Array.from(sourceHead.children)) {
    if (isMirroredHeadNode(node)) insert(node);
  }

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "childList" && record.target === sourceHead) {
        record.removedNodes.forEach(remove);
        record.addedNodes.forEach((node) => {
          if (
            node.parentNode === sourceHead &&
            !clones.has(node) &&
            isMirroredHeadNode(node)
          )
            insert(node);
        });
        continue;
      }

      if (
        record.type === "attributes" &&
        record.target.parentNode === sourceHead
      ) {
        const node = record.target as Element;
        const mirrored = clones.has(node);
        const mirrorable = isMirroredHeadNode(node);
        if (mirrored && !mirrorable) remove(node);
        else if (!mirrored && mirrorable) insert(node);
        else if (mirrored) {
          // Re-cloning a <link> would refetch it and flash unstyled.
          const clone = clones.get(node)!;
          const name = record.attributeName!;
          const value = node.getAttribute(name);
          if (value === null) clone.removeAttribute(name);
          else if (name === "href" && node.nodeName.toLowerCase() === "link")
            clone.setAttribute(name, (node as HTMLLinkElement).href);
          else clone.setAttribute(name, value);
        }
        continue;
      }

      // Text inside a mirrored <style> changed (dev server hot update).
      const source = owner(record.target);
      if (source) clones.get(source)!.textContent = source.textContent;
    }
  });

  observer.observe(sourceHead, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });
  return () => observer.disconnect();
}

function syncRootAttributes(source: Element, target: Element) {
  for (const attr of Array.from(target.attributes)) {
    if (isMirroredRootAttribute(attr.name) && !source.hasAttribute(attr.name))
      target.removeAttribute(attr.name);
  }
  for (const attr of Array.from(source.attributes)) {
    if (isMirroredRootAttribute(attr.name))
      target.setAttribute(attr.name, attr.value);
  }
}

/** Theme variables and classes live on main's `<html>` / `<body>`. */
function mirrorRootAttributes(childDoc: Document): () => void {
  const pairs: [Element, Element][] = [
    [document.documentElement, childDoc.documentElement],
    [document.body, childDoc.body],
  ];
  for (const [source, target] of pairs) syncRootAttributes(source, target);

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const name = record.attributeName;
      if (!name || !isMirroredRootAttribute(name)) continue;
      const pair = pairs.find(([source]) => source === record.target);
      if (!pair) continue;
      const value = pair[0].getAttribute(name);
      if (value === null) pair[1].removeAttribute(name);
      else pair[1].setAttribute(name, value);
    }
  });
  for (const [source] of pairs) observer.observe(source, { attributes: true });
  return () => observer.disconnect();
}

/**
 * In main, `#floating` follows `#root`, so floating UI paints above the app.
 * Callers portal into the child body AFTER this module appends `#floating`,
 * so it is moved back to the end, but only while it is empty: moving a node
 * that holds an open menu or dialog would drop its focus.
 */
function keepFloatingLast(body: HTMLElement, floating: HTMLElement) {
  const observer = new MutationObserver(() => {
    if (floating.nextSibling && !floating.firstChild)
      body.appendChild(floating);
  });
  observer.observe(body, { childList: true });
  return () => observer.disconnect();
}

/* ------------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------------ */

const live = new Set<ChildWindowHandle>();
let mainPagehideBound = false;
let mainUnloading = false;

/** A main reload or close takes every chat window with it. */
function bindMainPagehide() {
  if (mainPagehideBound) return;
  mainPagehideBound = true;
  // Capture, so any close made during the unload already sees it.
  window.addEventListener(
    "pagehide",
    () => {
      mainUnloading = true;
    },
    true,
  );
  // Back from the back/forward cache: not unloading after all.
  window.addEventListener("pageshow", () => {
    mainUnloading = false;
  });
  window.addEventListener("pagehide", () => {
    for (const handle of Array.from(live)) handle.close();
  });
}

/**
 * Standards-mode behaviour the quirks-mode child lacks: tables inherit font
 * and color, and `html` / `body` fill the window for percentage heights.
 */
export const QUIRKS_CSS =
  "table { font: inherit; color: inherit; line-height: inherit; }\n" +
  "html, body { height: 100%; }";

function prepareChildDocument(
  childWin: Window,
  title: string,
): { doc: Document; floating: HTMLElement } {
  const doc = childWin.document;
  if (!doc.head)
    doc.documentElement.insertBefore(
      doc.createElement("head"),
      doc.documentElement.firstChild,
    );
  if (!doc.body) doc.documentElement.appendChild(doc.createElement("body"));

  doc.title = title;
  // Relative URLs in copied CSS (fonts, images) and in rendered markup
  // resolve against main, not about:blank.
  const base = doc.createElement("base");
  base.href = document.baseURI;
  doc.head.insertBefore(base, doc.head.firstChild);

  // An about:blank child is in quirks mode, and document.open/write would
  // change its URL (and trip the shells' nav locks). Undo the quirks that
  // matter here, first in the head so main's mirrored CSS still wins.
  const quirks = doc.createElement("style");
  quirks.setAttribute("data-chatwin-quirks", "");
  quirks.textContent = QUIRKS_CSS;
  doc.head.insertBefore(quirks, doc.head.firstChild);

  const floating = doc.createElement("div");
  floating.id = "floating";
  doc.body.appendChild(floating);
  return { doc, floating };
}

/**
 * The shells hold ONE arm slot, consumed by the first new window (a new arm
 * replaces the old). Two opens whose arm → window.open steps interleaved
 * would swap labels, or leave one window unarmed, so opens run one at a time.
 */
let openQueue: Promise<void> = Promise.resolve();

/**
 * How long an arm (or a discard) may take before the open gives up. A bridge
 * that never answers would otherwise hold the queue, and every later open,
 * forever.
 */
export const ARM_TIMEOUT_MS = 5000;

/**
 * `call`, or `{ ok: false, err: "timeout" }` after {@link ARM_TIMEOUT_MS}.
 * When the timeout wins, `late` (if given) gets the answer the call still
 * comes back with, if it ever does; a late rejection is dropped.
 */
function withShellTimeout<T>(
  call: () => Promise<chatShell.ShellResult<T>>,
  late?: (result: chatShell.ShellResult<T>) => void,
): Promise<chatShell.ShellResult<T>> {
  // A synchronous throw becomes a rejection here, so the timer below is
  // always cleared.
  const pending = new Promise<chatShell.ShellResult<T>>((resolve) =>
    resolve(call()),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<chatShell.ShellResult<T>>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve({ ok: false, err: "timeout" });
    }, ARM_TIMEOUT_MS);
  });
  if (late) {
    void pending.then(
      (result) => {
        if (timedOut) late(result);
      },
      () => {
        // The race below reports a rejection that beats the timeout.
      },
    );
  }
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Arm the shell, giving up after {@link ARM_TIMEOUT_MS}. An arm that answers
 * after the open gave up has still armed the shell, possibly for a frameless
 * window. On Tauri, left alone, the next `about:blank` open from main's realm
 * (an embed's iframe) would become a chat window main never tracks. So a late
 * success is discarded, best effort and without holding the queue: the open
 * that gave up has already resolved null. The discard only matters on Tauri:
 * Electron already destroys any child main's own frame did not open, so its
 * `discard` answers ok without doing anything.
 */
function armWithTimeout(kind: ChildWindowKind): Promise<chatShell.ArmResult> {
  return withShellTimeout(
    () => chatShell.arm(kind),
    (late) => {
      if (late.ok) void discardUnusedArm(late.label);
    },
  );
}

/**
 * The frame an arm reported, normalized: only `buttons` and `inset` change
 * how the window draws, and anything else (no shell, a refused arm, a
 * malformed answer) is the OS frame.
 */
function armedFrame(armed: chatShell.ArmResult): chatShell.ChatWindowFrame {
  if (!armed.ok) return "native";
  return armed.frame === "buttons" || armed.frame === "inset"
    ? armed.frame
    : "native";
}

/**
 * The window opened but could not be prepared, and main has closed it. On
 * Tauri that close leaves the native window open and blank, and a frameless
 * one has no close button of its own, so the shell finishes it. Best effort:
 * a failure is logged, never raised, and the open still resolves null.
 */
async function closeUnpreparedWindow(label: string): Promise<void> {
  try {
    const result = await withShellTimeout(() => chatShell.closeWindow(label));
    if (!result.ok)
      console.warn("[chat-window] shell could not close", label, result.err);
  } catch (err) {
    console.warn("[chat-window] shell could not close", label, err);
  }
}

/**
 * Main's `window.open` came back null after a successful arm: another frame
 * (an embed) opened first and consumed the arm, so the shell may have built
 * the window carrying `label` for it. Nothing renders into that window, and
 * it must not outlive this open. Also used for an arm that answered after its
 * open timed out ({@link armWithTimeout}). Best effort: a failure is logged,
 * never raised, and the open still resolves null.
 */
async function discardUnusedArm(label: string): Promise<void> {
  try {
    const result = await withShellTimeout(() => chatShell.discard(label));
    if (!result.ok)
      console.warn("[chat-window] could not discard an unused arm", result.err);
  } catch (err) {
    console.warn("[chat-window] could not discard an unused arm", err);
  }
}

/**
 * Shell closes main started for its own closes (a handle's `close()`), still
 * in flight. They run outside the open queue, so a close never waits for an
 * open.
 */
const shellCloses = new Set<Promise<void>>();

/**
 * Wait for the shell closes in flight, each bounded by
 * {@link ARM_TIMEOUT_MS}. A friends window reopened right after the host
 * closed the last one would otherwise arm before that close's discard
 * reaches the shell. The shell may still be destroying the old window after
 * the discard answers, so the host also retries an `exists` refusal once.
 */
async function settleShellCloses(): Promise<void> {
  if (shellCloses.size) await Promise.all([...shellCloses]);
}

/**
 * How an open came out: the window, or why there is none. `err` is the
 * shell's own error when it refused the arm (`exists`, `timeout`, ...),
 * `blocked` when `window.open` came back null, `prepare` when the window
 * opened but could not be prepared, and `failed` for anything that threw.
 */
export type ChildWindowOpen =
  | { ok: true; handle: ChildWindowHandle }
  | { ok: false; err: string };

/**
 * Open a chat window and prepare its document for rendering. Resolves null if
 * the shell refuses the arm or the window does not open. Render into it with
 * `<Portal mount={handle.ctx.doc.body}><ChildWindowChrome ctx={handle.ctx}>`
 * from inside the main app tree.
 */
export function openChildWindow(
  kind: ChildWindowKind,
  opts: ChildWindowOptions,
): Promise<ChildWindowHandle | null> {
  return tryOpenChildWindow(kind, opts).then((result) =>
    result.ok ? result.handle : null,
  );
}

/**
 * {@link openChildWindow}, saying why when there is no window, so a caller
 * can tell a refusal worth retrying from one that is not.
 */
export function tryOpenChildWindow(
  kind: ChildWindowKind,
  opts: ChildWindowOptions,
): Promise<ChildWindowOpen> {
  const run = openQueue
    .then(() => openNow(kind, opts))
    .catch((err): ChildWindowOpen => {
      console.error("[chat-window] open failed", err);
      return { ok: false, err: "failed" };
    });
  // The queue only orders opens; it must not keep the last handle alive.
  openQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function openNow(
  kind: ChildWindowKind,
  opts: ChildWindowOptions,
): Promise<ChildWindowOpen> {
  // 0. The friends window's label is reused, so its arm is refused (`exists`)
  // while the previous one is still closing.
  if (kind === "friends") await settleShellCloses();

  // 1. Arm the shell. Without a shell (web dev harness) open a plain popup.
  // A timed-out arm is a refusal, never "unsupported".
  const armed = await armWithTimeout(kind);
  if (!armed.ok && armed.err !== "unsupported") {
    console.warn("[chat-window] shell refused to arm", armed.err);
    return { ok: false, err: armed.err };
  }
  const shellLabel = armed.ok ? armed.label : undefined;
  const frame = armedFrame(armed);

  // 2. Open. The shell turns an armed about:blank request into a chat window.
  const id = nextChildWindowId(kind);
  const childWin = window.open("about:blank", id, childWindowFeatures(opts));
  if (!childWin) {
    // Awaited, so the next open in the queue cannot arm before this settles.
    if (shellLabel !== undefined) await discardUnusedArm(shellLabel);
    return { ok: false, err: "blocked" };
  }

  const cleanups: (() => void)[] = [];
  const runCleanups = () => {
    for (const fn of cleanups.splice(0).reverse()) {
      try {
        fn();
      } catch {
        // A closed window's document may already be gone.
      }
    }
  };

  let ctx: WindowCtx;
  try {
    // 2b. Cut the child's way back to main before anything renders into it.
    // Embeds in a chat window are iframes; through `top.opener` one could
    // reach main and navigate it. Main keeps its own handle (`childWin`), and
    // nothing reads the child's opener. A shell that ignores the write is a
    // failure: the window is closed rather than kept with the link.
    childWin.opener = null;
    if (childWin.opener !== null) throw new Error("opener not cleared");

    // 3. Document: title, base, styles, root attributes, events, #floating.
    const { doc, floating } = prepareChildDocument(
      childWin,
      opts.title ?? document.title,
    );
    cleanups.push(mirrorHead(doc));
    cleanups.push(mirrorRootAttributes(doc));
    delegateEvents([...DelegatedEvents], doc);
    cleanups.push(keepFloatingLast(doc.body, floating));

    ctx = {
      id,
      doc,
      win: childWin,
      floatingMount: () => floating,
      isActive: () => doc.hasFocus(),
    };

    // 4. Links never navigate the child, and neither do the reload keys.
    cleanups.push(installLinkCapture(ctx));
    cleanups.push(installReloadGuard(ctx));

    // 5. Register for focus tracking, lookups and clipboard routing.
    cleanups.push(registerWindowCtx(ctx));
    installClipboardShim();
    // Lit (mdui) elements adopt constructed sheets, which another document
    // rejects; without this they render 0x0 in the child.
    installAdoptedSheetsShim();
  } catch (err) {
    console.error("[chat-window] could not prepare the window", err);
    runCleanups();
    try {
      childWin.close();
    } catch {
      // Already gone.
    }
    // Awaited like the discard above, so the queue stays ordered.
    if (shellLabel !== undefined && shellCloseNeeded(shellLabel, mainUnloading))
      await closeUnpreparedWindow(shellLabel);
    return { ok: false, err: "prepare" };
  }

  // 6. Close tracking.
  const callbacks = new Set<() => void>();
  let finished = false;

  const isClosed = () => {
    try {
      return childWin.closed;
    } catch {
      return true;
    }
  };

  const finish = () => {
    if (finished) return;
    finished = true;
    live.delete(handle);
    runCleanups();
    for (const cb of Array.from(callbacks)) {
      try {
        cb();
      } catch (err) {
        console.error("[chat-window] onClose callback threw", err);
      }
    }
    callbacks.clear();
  };

  // On Tauri, `childWin.close()` takes down only the webview and leaves the
  // native window open and blank, so the shell finishes the close.
  const closeInShell = () => {
    const label = shellLabel;
    if (label === undefined || !shellCloseNeeded(label, mainUnloading)) return;
    // Bounded, as a friends open waits for it (settleShellCloses).
    const closing = withShellTimeout(() => chatShell.closeWindow(label)).then(
      (result) => {
        if (!result.ok)
          console.warn(
            "[chat-window] shell could not close",
            label,
            result.err,
          );
      },
      (err) => console.warn("[chat-window] shell could not close", label, err),
    );
    shellCloses.add(closing);
    void closing.finally(() => shellCloses.delete(closing));
  };

  const handle: ChildWindowHandle = {
    id,
    kind,
    shellLabel,
    frame,
    ctx,
    focus() {
      if (!finished && !isClosed()) childWin.focus();
    },
    close() {
      if (finished) return;
      try {
        childWin.close();
      } catch {
        // Already gone.
      }
      finish();
      closeInShell();
    },
    closed() {
      return finished || isClosed();
    },
    onClose(cb) {
      if (finished) {
        // Late subscribers still hear about it, but never re-entrantly.
        queueMicrotask(cb);
        return () => {};
      }
      callbacks.add(cb);
      return () => {
        callbacks.delete(cb);
      };
    },
  };

  // pagehide fires in the child as it closes; the poll covers a close the
  // child never reported (crash, shell teardown). A reload fires pagehide too
  // but leaves the window open on a blank page this realm no longer renders
  // into, so a window still open afterwards is closed; whoever owns it decides
  // whether to reopen. The timer is main's, since the child's realm is the one
  // being torn down.
  const onPagehide = () => {
    finish();
    setTimeout(() => {
      if (isClosed()) return;
      try {
        childWin.close();
      } catch {
        // Already gone.
      }
      closeInShell();
    }, 0);
  };
  childWin.addEventListener("pagehide", onPagehide);
  cleanups.push(() => childWin.removeEventListener("pagehide", onPagehide));
  const poll = setInterval(() => {
    if (isClosed()) finish();
  }, 1000);
  cleanups.push(() => clearInterval(poll));

  live.add(handle);
  bindMainPagehide();
  return { ok: true, handle };
}
