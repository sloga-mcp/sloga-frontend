import {
  BiSolidFile,
  BiSolidFileImage,
  BiSolidFileTxt,
  BiSolidVideoRecording,
} from "solid-icons/bi";
import {
  Match,
  Show,
  Switch,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { Portal } from "solid-js/web";
import { Motion } from "solid-motionone";

import { Plural } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { type WindowCtx, MAIN_CTX } from "@revolt/client/windowCtx";
import { useModals } from "@revolt/modal";

// import { typography } from "../../design";
import { PreviewStack } from "../PreviewStack";
import { isFileDrag } from "./FileDropGuard";

interface Props {
  /**
   * Callback for dropped files
   * @param files List of files
   */
  onFiles: (files: File[]) => void;

  /**
   * Whether to allow dropping files while in a modal
   */
  allowInModal?: boolean;

  /**
   * Window to collect drops in (defaults to the main window). Read once at
   * mount; a chat window's composer passes its own so the listeners and the
   * overlay land in that window's document.
   */
  ctx?: WindowCtx;

  /**
   * Whether drops should currently be collected (defaults to always)
   */
  active?: () => boolean;
}

/**
 * Stack container
 */
const Container = styled("div", {
  base: {
    width: "100%",
    height: "100%",
    display: "grid",
    position: "fixed",
    placeItems: "center",
    pointerEvents: "none",

    // on dim background
    color: "white",
  },
});

/**
 * Dim the screen when dropping files
 */
const DimScreen = styled("div", {
  base: {
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    position: "fixed",
    background: "rgba(0, 0, 0, 0.8)",

    // purely decorative: if it took the pointer it would become the drag
    // target the instant it appeared, firing a dragleave at whatever was
    // under the cursor and making the overlay flicker
    pointerEvents: "none",
  },
});

/**
 * File drop information
 */
const DropText = styled("div", {
  base: {
    marginTop: "48px",
    whiteSpace: "nowrap",

    // ...typography.raw({ class: "label" }),
  },
});

/**
 * Collect files that are dropped anywhere in the page
 */
export function FileDropAnywhereCollector(props: Props) {
  const { isOpen } = useModals();
  const [showIndicator, setShowIndicator] = createSignal(false);
  const [hideIndicator, setHideIndicator] = createSignal(false);
  const [items, setItems] = createSignal<DataTransferItem[]>([]);

  const ctx = () => props.ctx ?? MAIN_CTX;
  const active = () => props.active?.() ?? true;

  /**
   * Timers run on the window the listeners are bound to: a hidden main
   * window gets its timers throttled while a chat window is in front.
   */
  let win: Window = MAIN_CTX.win;

  /**
   * Since we get events from the whole DOM tree, we want to
   * check if we get a dragOver event immediately after dragLeave,
   * if so: cancel the update to prevent updating preview.
   */
  let deferredHide: number | undefined;

  /**
   * Handle item drag event
   * @param event Drag event
   */
  function onDragOver(event: DragEvent) {
    // Dragging a server around the rail, a selection out of a message or a
    // chat tab between windows (text/plain) is not an attachment — don't dim
    // the screen and offer to eat it.
    if (!isFileDrag(event) || !active() || isOpen()) return;

    event.preventDefault();
    win.clearTimeout(deferredHide);

    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";

      if (!showIndicator()) {
        setShowIndicator(true);
        setHideIndicator(false);
        setItems([...event.dataTransfer.items]);
      }
    }
  }

  /**
   * Handle cancelled drag event
   */
  function onDragLeave(event: DragEvent) {
    // Deliberately not gated on active(): hiding is always safe, and an
    // overlay raised just before the window went inactive must still clear.
    if (!isFileDrag(event)) return;

    deferredHide = win.setTimeout(() => {
      setHideIndicator(true);

      win.setTimeout(() => {
        setShowIndicator(false);
      }, 300);
    });
  }

  /**
   * Handle item drop event
   * @param event Drag event
   */
  function onDrop(event: DragEvent) {
    // Same gate as the dragover: a file dropped onto an open modal is
    // swallowed by FileDropGuard rather than silently landing in the draft
    // of whatever channel is behind it.
    if (!isFileDrag(event) || isOpen()) return;

    // Inactive: leave the drop to FileDropGuard, but don't strand an
    // overlay that was raised while we were still active.
    if (!active()) {
      setShowIndicator(false);
      return;
    }

    event.preventDefault();

    const files = event.dataTransfer?.files;
    if (files?.length) {
      props.onFiles([...files]);
    }

    setShowIndicator(false);
  }

  onMount(() => {
    // Bound once: the ctx is fixed for this collector's lifetime.
    const { doc } = ctx();
    win = ctx().win;

    doc.addEventListener("dragover", onDragOver);
    doc.addEventListener("dragleave", onDragLeave);
    doc.addEventListener("drop", onDrop);

    onCleanup(() => {
      doc.removeEventListener("dragover", onDragOver);
      doc.removeEventListener("dragleave", onDragLeave);
      doc.removeEventListener("drop", onDrop);
    });
  });

  /**
   * Generate list of preview items
   */
  const previewItems = () =>
    items().map(
      (item, index) =>
        [
          item,
          index * (80 / items().length) -
            (items().length - 1) * (40 / items().length),
        ] as [DataTransferItem, number],
    );

  return (
    <Show when={showIndicator()}>
      {/* the ctx body, not #floating: for main this is Portal's default */}
      <Portal mount={ctx().doc.body}>
        <Show when={!hideIndicator()}>
          <DimScreen />
        </Show>
        <Container>
          <PreviewStack
            items={previewItems()}
            hideStack={hideIndicator}
            overlay={
              <DropText>
                <Motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.2 }}
                >
                  <Plural
                    value={items().length}
                    one="Drop a file"
                    other="Drop # files"
                  />
                </Motion.div>
              </DropText>
            }
          >
            {(item) => (
              <Switch fallback={<BiSolidFile size={64} />}>
                <Match when={item.type.startsWith("text/")}>
                  <BiSolidFileTxt size={64} />
                </Match>
                <Match when={item.type.startsWith("image/")}>
                  <BiSolidFileImage size={64} />
                </Match>
                <Match when={item.type.startsWith("video/")}>
                  <BiSolidVideoRecording size={64} />
                </Match>
              </Switch>
            )}
          </PreviewStack>
        </Container>
      </Portal>
    </Show>
  );
}
