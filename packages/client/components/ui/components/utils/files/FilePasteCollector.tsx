import { type WindowCtx, MAIN_CTX } from "@revolt/client/windowCtx";
import { onCleanup, onMount } from "solid-js";

import { takeDroppedItems } from "./folderAttachments";
import { useDroppedItems } from "./useDroppedItems";

interface Props {
  /**
   * Callback for pasted files
   * @param files List of files
   */
  onFiles: (files: File[]) => void;

  /**
   * Window whose document receives the paste (defaults to the main window)
   */
  ctx?: WindowCtx;

  /**
   * Whether this collector may take the paste right now (defaults to always)
   */
  active?: () => boolean;

  /**
   * Composer whose attachment strip shows a folder zipping (read once)
   */
  zipOwner?: object;
}

/**
 * Utility for capturing pasted files
 */
export function FilePasteCollector(props: Props) {
  // eslint-disable-next-line solid/reactivity -- fixed for the collector lifetime
  const resolveDropped = useDroppedItems(props.zipOwner);

  /**
   * Handle document paste event
   * @param event Event
   */
  function onPaste(event: ClipboardEvent) {
    // Several composers can be mounted at once (chat windows); an inactive one
    // must neither attach the files nor preventDefault on another's paste.
    if (props.active && !props.active()) return;

    const data = event.clipboardData;
    if (!data?.items) return;

    // Files only (text pastes into the composer as usual). Taken now: the
    // clipboard items are emptied once this handler returns. A copied folder
    // arrives as a 0-byte phantom File; it is zipped instead.
    const items = takeDroppedItems(data).filter(
      (item) => item.kind === "folder" || !item.file.type.startsWith("text/"),
    );

    if (items.length) {
      event.preventDefault();
      void resolveDropped(items).then((files) => {
        if (files.length) props.onFiles(files);
      });
    }
  }

  onMount(() => {
    // Resolved once so removal hits the same document the listener went on.
    const doc = (props.ctx ?? MAIN_CTX).doc;
    doc.addEventListener("paste", onPaste);
    onCleanup(() => doc.removeEventListener("paste", onPaste));
  });

  return <></>;
}
