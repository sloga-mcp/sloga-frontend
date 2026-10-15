import { onCleanup, onMount } from "solid-js";

import { useWindowCtx } from "@revolt/client/windowCtx";

/**
 * `<input>` types that hold no text, so the native menu offers them nothing.
 */
const NON_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

type Realm = Window & typeof globalThis;

/**
 * `instanceof` against both the main realm and the window the event came
 * from. In a chat window most nodes are main-realm (Solid builds them from
 * main's `document` and the portal adopts them, keeping their prototype), but
 * anything created through that window's own `document` carries its realm's
 * constructors and would fail a main-only check.
 * @param node Node from the composed path
 * @param name Constructor name
 * @param win Window the guard is listening on
 */
function isA<
  K extends "HTMLElement" | "HTMLTextAreaElement" | "HTMLInputElement",
>(node: EventTarget, name: K, win: Window): node is InstanceType<Realm[K]> {
  return node instanceof window[name] || node instanceof (win as Realm)[name];
}

/**
 * Whether the browser's own menu is the only thing that can serve this
 * right-click, so the guard has to stand down.
 * @param event Context menu event
 * @param win Window the guard is listening on
 * @param isMain Whether that window is the main window
 */
function nativeMenuIsTheOnlyOption(
  event: MouseEvent,
  win: Window,
  isMain: boolean,
) {
  // Shift+right-click is the browser-wide "page, keep out of it" gesture —
  // Firefox honours it natively — and here it is the only way to reach the
  // affordances Sloga has no menu of its own for: Save image as…, Picture in
  // picture on a screenshare tile, View source, Inspect.
  // Main only: in a chat window that menu's Reload blanks the about:blank child.
  if (isMain && event.shiftKey) return true;

  // Paste, spellcheck suggestions and Undo live only in the native menu, and
  // right-click → Paste is how a good number of people paste at all, so every
  // text field keeps it.
  //
  // This walks `composedPath` rather than looking at `event.target`, because
  // every text field in the app is an `<input>` inside an `mdui-*` element's
  // shadow root and events retarget to the host on the way out: `event.target`
  // is `<mdui-text-field>`, and no amount of `closest("input")` will ever find
  // the input. `composedPath` is the only view that still contains it.
  return event
    .composedPath()
    .some(
      (node) =>
        isA(node, "HTMLElement", win) &&
        (node.isContentEditable ||
          isA(node, "HTMLTextAreaElement", win) ||
          (isA(node, "HTMLInputElement", win) &&
            !NON_TEXT_INPUTS.has(node.type))),
    );
}

/**
 * Stop the browser from offering its own context menu where Sloga has nothing
 * to say.
 *
 * `use:floating` already cancels the event on everything it is attached to —
 * a message, a member, a channel, a server — so those right-clicks only ever
 * showed Sloga's menu. Everywhere else (the background behind the channel
 * list, sidebar padding, the member list's empty space, call chrome) the
 * browser's menu came up instead, complete with the host's extensions and
 * Ask Gemini, which is not something an app window should be handing out.
 *
 * Three things about the shape of this are load-bearing:
 *
 * - **Bubble phase, on `window`.** `floating.ts` bails out of opening Sloga's
 *   menu when it sees `defaultPrevented` (it has to: an overlay that claimed
 *   the right-click must not get a Sloga menu painted over it). A
 *   capture-phase guard therefore inverts the whole feature — it would cancel
 *   the event before the element handler ran and suppress every Sloga menu
 *   while the browser's stayed. Running last, after the element handlers that
 *   `stopPropagation`, means this only ever sees the right-clicks nobody
 *   claimed.
 * - **Mouse only.** A long-press on Android and the keyboard Menu key both
 *   arrive as `contextmenu` with `button` 0. Swallowing those would cost
 *   mobile text selection and keyboard access, and neither one is the
 *   browser-chrome menu this is here to hide.
 * - **It never stops propagation.** Anything downstream that wants the event
 *   still gets it; the only effect is on the browser's default action.
 *
 * Mounted once per window: in the main tree, and inside each chat window's
 * chrome, where the global `window` is still main's and the WebView2 menu
 * (Reload included) would otherwise come up in the child.
 */
export function ContextMenuGuard() {
  // Resolved once so add and remove hit the same window.
  const ctx = useWindowCtx();
  const win = ctx.win;
  const isMain = ctx.id === "main";

  /**
   * Deny the browser its menu
   * @param event Context menu event
   */
  function onContextMenu(event: MouseEvent) {
    if (event.defaultPrevented) return;
    if (event.button !== 2) return;
    if (nativeMenuIsTheOnlyOption(event, win, isMain)) return;

    event.preventDefault();
  }

  onMount(() => win.addEventListener("contextmenu", onContextMenu));
  onCleanup(() => win.removeEventListener("contextmenu", onContextMenu));

  return <></>;
}
