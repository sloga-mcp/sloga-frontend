import { Capacitor } from "@capacitor/core";

import { createLongPress, isIosTouch } from "./longPress";

let iosTouchCached: boolean | undefined;

/**
 * Whether press-and-hold has to be emulated here: the iPhone app, or Safari
 * on an iPhone or iPad. Read once; none of the inputs change at runtime.
 */
export function needsLongPressEmulation(): boolean {
  if (iosTouchCached === undefined) {
    iosTouchCached =
      typeof navigator !== "undefined" &&
      isIosTouch(
        Capacitor.getPlatform(),
        navigator.userAgent,
        navigator.platform,
        navigator.maxTouchPoints ?? 0,
      );
  }
  return iosTouchCached;
}

/**
 * Text fields keep the system's own press-and-hold (the caret loupe, Paste).
 * @param target Where the finger went down
 */
function isEditable(target: Element): boolean {
  return !!target.closest(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
  );
}

/**
 * Turn a held finger into the `contextmenu` event Android would have sent,
 * so every element using `use:floating={{ contextMenu }}` opens its menu.
 *
 * Dispatching the real event, rather than opening a menu directly, keeps
 * every existing rule in force: the innermost element's menu wins because
 * `floating.ts` stops propagation, and a drag that has picked the row up
 * vetoes the menu the same way it does on Android (`Draggable.tsx` cancels
 * `contextmenu` in the capture phase). A `mousemove` goes first so
 * `FloatingManager`, which places menus at the last pointer position, opens
 * this one under the finger.
 *
 * Mounted once per window, from `FloatingManager`.
 * @param doc Document to listen on
 * @returns Removes the listeners
 */
export function installLongPressMenus(doc: Document): () => void {
  const press = createLongPress<Element>({
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
    fire(target, x, y) {
      if (!target.isConnected) return false;

      const init: MouseEventInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: x,
        clientY: y,
      };

      target.dispatchEvent(new MouseEvent("mousemove", init));
      const menu = new MouseEvent("contextmenu", init);
      target.dispatchEvent(menu);
      return menu.defaultPrevented;
    },
  });

  // Draggable picks a row up by replaying a synthetic `touchstart`; only a
  // real finger may start, move or end a press.
  const onStart = (event: TouchEvent) => {
    if (!event.isTrusted) return;
    const touch = event.touches[0];
    const target = event.target;
    if (!touch || !(target instanceof Element) || isEditable(target)) {
      press.cancel();
      return;
    }
    press.start(target, touch.clientX, touch.clientY, event.touches.length);
  };

  const onMove = (event: TouchEvent) => {
    if (!event.isTrusted) return;
    const touch = event.touches[0];
    if (!touch) return press.cancel();
    press.move(touch.clientX, touch.clientY, event.touches.length);
  };

  // Once a menu is open, the tap the browser would deliver on release (a
  // `mousedown` and `click`) would close it again straight away: the
  // FloatingManager dismisses menus on both. Cancelling `touchend` stops
  // those compatibility events, so this listener cannot be passive.
  const onEnd = (event: TouchEvent) => {
    if (!event.isTrusted) return;
    if (press.end() && event.cancelable) event.preventDefault();
  };

  const onCancel = () => press.end();
  const onScroll = () => press.cancel();

  // Capture phase, so a handler that stops propagation further down (the
  // slide drawers) cannot hide a press from us.
  const passive = { capture: true, passive: true };
  const active = { capture: true, passive: false };

  doc.addEventListener("touchstart", onStart, passive);
  doc.addEventListener("touchmove", onMove, passive);
  doc.addEventListener("touchend", onEnd, active);
  doc.addEventListener("touchcancel", onCancel, passive);
  doc.addEventListener("scroll", onScroll, passive);

  return () => {
    press.cancel();
    doc.removeEventListener("touchstart", onStart, passive);
    doc.removeEventListener("touchmove", onMove, passive);
    doc.removeEventListener("touchend", onEnd, active);
    doc.removeEventListener("touchcancel", onCancel, passive);
    doc.removeEventListener("scroll", onScroll, passive);
  };
}

/**
 * Stop iOS starting text selection or the link callout on an element that
 * opens a menu on press-and-hold; otherwise both happen at once. Text stays
 * copyable through the menu ("Copy text").
 * @param element Element with a context menu
 * @returns Puts back the element's own values
 */
export function suppressNativePress(element: HTMLElement): () => void {
  const props = ["-webkit-user-select", "user-select", "-webkit-touch-callout"];
  const before = props.map((prop) => [
    prop,
    element.style.getPropertyValue(prop),
    element.style.getPropertyPriority(prop),
  ]);

  for (const prop of props) element.style.setProperty(prop, "none");

  return () => {
    for (const [prop, value, priority] of before) {
      if (value) element.style.setProperty(prop, value, priority);
      else element.style.removeProperty(prop);
    }
  };
}
