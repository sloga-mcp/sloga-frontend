import { onCleanup, onMount } from "solid-js";

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
 */
export function FileDropGuard() {
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
    window.addEventListener("dragenter", onDragOver, true);
    window.addEventListener("dragover", onDragOver, true);
    window.addEventListener("drop", onDrop, true);
  });

  onCleanup(() => {
    window.removeEventListener("dragenter", onDragOver, true);
    window.removeEventListener("dragover", onDragOver, true);
    window.removeEventListener("drop", onDrop, true);
  });

  return <></>;
}
