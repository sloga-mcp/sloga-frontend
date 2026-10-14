import { type WindowCtx, MAIN_CTX } from "@revolt/client/windowCtx";
import { onCleanup, onMount } from "solid-js";

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
}

/**
 * Utility for capturing pasted files
 */
export function FilePasteCollector(props: Props) {
  /**
   * Handle document paste event
   * @param event Event
   */
  function onPaste(event: ClipboardEvent) {
    // Several composers can be mounted at once (chat windows); an inactive one
    // must neither attach the files nor preventDefault on another's paste.
    if (props.active && !props.active()) return;

    const items = event.clipboardData?.items;
    if (typeof items === "undefined") return;

    // Filter for files
    const files: File[] = [...items]
      .filter((item) => !item.type.startsWith("text/"))
      .map((item) => item.getAsFile()!)
      .filter((item) => item);

    if (files.length) {
      event.preventDefault();
      props.onFiles(files);
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
