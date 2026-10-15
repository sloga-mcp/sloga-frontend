import { onCleanup, onMount } from "solid-js";

import { useWindowCtx } from "@revolt/client/windowCtx";

/**
 * Whether a drag event is carrying files in from outside the app.
 *
 * Everything else — dragging a server around the rail, a text selection out
 * of a message, an image within the composer — must be left completely
 * alone, so we only ever look at drags whose payload is actual files.
 * @param event Drag event
 */
export function isFileDrag(event: DragEvent) {
  const types = event.dataTransfer?.types;
  // `types` is a plain array today but a DOMStringList in older engines
  return types ? Array.prototype.includes.call(types, "Files") : false;
}

/**
 * Stop the browser from ever navigating to a dropped file.
 *
 * Anywhere a file drop isn't cancelled, the browser falls back to its own
 * handler and opens the file in a new tab/window, tearing down the app. The
 * collector that actually attaches files only lives next to a composer and
 * stands down while a modal is open, which left the login page, the friends
 * popout, the titlebar, every portalled modal and any composer-less channel
 * navigating away instead.
 *
 * So the cancel lives here instead: on `window`, in the CAPTURE phase, for
 * the whole lifetime of the app. It never stops propagation, so
 * FileDropAnywhereCollector still receives the very same events and attaches
 * wherever the files can genuinely be accepted; anywhere else the drop is
 * simply swallowed.
 *
 * Mounted once for the main window and once inside every chat window, each
 * guarding the window it renders in. Chat windows share the main realm, so
 * the global `window` would be the wrong one there; the target is captured
 * once here so cleanup detaches from the same window it attached to.
 */
export function FileDropGuard() {
  const win = useWindowCtx().win;

  /**
   * Claim the drag so the browser doesn't
   * @param event Drag event
   *
   * Deliberately leaves `dropEffect` alone: forcing it to "none" here and
   * expecting the collector to raise it back to "copy" later in the same
   * dispatch means a browser that reads the effect early would suppress the
   * drop event outright, and nothing would ever attach.
   */
  function onDragOver(event: DragEvent) {
    if (isFileDrag(event)) event.preventDefault();
  }

  /**
   * Swallow any drop that no collector claimed
   * @param event Drag event
   */
  function onDrop(event: DragEvent) {
    if (isFileDrag(event)) event.preventDefault();
  }

  onMount(() => {
    win.addEventListener("dragenter", onDragOver, true);
    win.addEventListener("dragover", onDragOver, true);
    win.addEventListener("drop", onDrop, true);
  });

  onCleanup(() => {
    try {
      win.removeEventListener("dragenter", onDragOver, true);
      win.removeEventListener("dragover", onDragOver, true);
      win.removeEventListener("drop", onDrop, true);
    } catch {
      // A closed chat window's listeners die with it.
    }
  });

  return <></>;
}
