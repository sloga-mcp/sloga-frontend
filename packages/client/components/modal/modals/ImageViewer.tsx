import { useWindowCtx } from "@revolt/client/windowCtx";
import {
  createEffect,
  createSignal,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import { Portal } from "solid-js/web";
import { Motion, Presence } from "solid-motionone";

import { useLingui } from "@lingui-solid/solid/macro";
import Panzoom, { PanzoomObject } from "@panzoom/panzoom";
import { css } from "styled-system/css";
import { styled } from "styled-system/jsx";

import {
  canCopyImageToClipboard,
  Column,
  copyImageToClipboard,
  Dialog,
  DialogProps,
  IconButton,
  Text,
} from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { Modals } from "../types";

export function ImageViewerModal(
  props: DialogProps & Modals & { type: "image_viewer" },
) {
  const { t } = useLingui();
  const [ref, setRef] = createSignal<HTMLElement>();

  /**
   * Outcome of the last copy, shown on the button itself — an error dialog
   * stacked over a fullscreen viewer would be worse than the icon saying so.
   */
  const [copied, setCopied] = createSignal<"idle" | "done" | "failed">("idle");
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  onCleanup(() => clearTimeout(copiedTimer));

  /**
   * The copy action for whatever this viewer is showing, or undefined when
   * there isn't one. An E2EE attachment brings its own (the shell decrypts
   * and writes the clipboard natively); a plain one is fetched here.
   */
  const copyAction = (): (() => Promise<void>) | undefined => {
    if (props.encrypted) return props.encrypted.onCopyImage;
    if (props.file?.metadata.type === "Image" && canCopyImageToClipboard()) {
      return () => copyImageToClipboard(props.file!.originalUrl);
    }
    return undefined;
  };

  function copyImage() {
    copyAction()?.()
      .then(() => setCopied("done"))
      .catch((error) => {
        console.error("[clipboard] copy image failed", error);
        setCopied("failed");
      })
      .finally(() => {
        clearTimeout(copiedTimer);
        copiedTimer = setTimeout(() => setCopied("idle"), 2000);
      });
  }

  let panzoom: PanzoomObject;

  createEffect(
    on(
      () => ref(),
      (ref) => {
        if (ref) {
          ref.addEventListener("mousedown", (e) => {
            // prevent panzoom from panning when
            // context menu is triggered (or other
            // non-dragging buttons are used!)
            if (e.button !== 0) {
              e.preventDefault();
            }
          });

          const zoom = Panzoom(ref, {
            minScale: 0.1,
            maxScale: 5,
          });

          panzoom = zoom;

          function onMouseWheel(event: WheelEvent) {
            zoom.zoom(zoom.getScale() - event.deltaY / 1000);
          }

          // The viewer may be open in a chat window, a different document
          const viewerDoc = ref.ownerDocument;
          viewerDoc.addEventListener("mousewheel", onMouseWheel as never);

          onCleanup(() => {
            viewerDoc.removeEventListener("mousewheel", onMouseWheel as never);
            zoom.destroy();
          });
        }
      },
    ),
  );

  return (
    <Portal mount={useWindowCtx().floatingMount()}>
      <Dialog.Scrim
        dark
        padding={false}
        overflow={false}
        show={props.show}
        onClick={props.onClose}
      >
        <Presence>
          <Show when={props?.show}>
            <Motion.div
              class={css({
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",

                minHeight: 0,
                width: "100%",
                height: "100%",

                paddingInline: "20px",
              })}
              initial={{ opacity: 0, scale: 1.1 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 1.1 }}
              transition={{
                duration: 0.3,
                easing: [0.17, 0.67, 0.58, 0.98],
              }}
            >
              <Relative>
                <Bar>
                  <Switch fallback={<div />}>
                    <Match when={props.file}>
                      <Card shrink onClick={(e) => e.stopPropagation()}>
                        <Column class={css({ minWidth: 0 })}>
                          <Filename>
                            <Text class="title">{props.file!.filename}</Text>
                          </Filename>
                          <Text class="label">
                            {props.file!.humanReadableSize}
                          </Text>
                        </Column>
                      </Card>
                    </Match>
                    <Match when={props.encrypted}>
                      <Card shrink onClick={(e) => e.stopPropagation()}>
                        <Column class={css({ minWidth: 0 })}>
                          <Filename>
                            <Text class="title">
                              {props.encrypted!.filename}
                            </Text>
                          </Filename>
                          <Text class="label">
                            {props.encrypted!.humanReadableSize}
                          </Text>
                        </Column>
                      </Card>
                    </Match>
                  </Switch>
                  <Card onClick={(e) => e.stopPropagation()}>
                    <IconButton onPress={() => panzoom?.zoomOut()}>
                      <Symbol>zoom_out</Symbol>
                    </IconButton>
                    <IconButton onPress={() => panzoom?.zoomIn()}>
                      <Symbol>zoom_in</Symbol>
                    </IconButton>
                    <Show when={copyAction()}>
                      <IconButton
                        aria-label={t`Copy image`}
                        onPress={copyImage}
                      >
                        <Switch fallback={<Symbol>content_copy</Symbol>}>
                          <Match when={copied() === "done"}>
                            <Symbol>check</Symbol>
                          </Match>
                          <Match when={copied() === "failed"}>
                            <Symbol>error</Symbol>
                          </Match>
                        </Switch>
                      </IconButton>
                    </Show>
                    <Show when={props.file}>
                      <a
                        target="_blank"
                        href={props.file?.originalUrl}
                        download={props.file?.filename}
                      >
                        <IconButton>
                          <Symbol>download</Symbol>
                        </IconButton>
                      </a>
                    </Show>
                    <Show when={props.encrypted}>
                      <IconButton onPress={() => props.encrypted!.onSave()}>
                        <Symbol>download</Symbol>
                      </IconButton>
                    </Show>
                    <Show when={props.embed || props.gif}>
                      <a
                        target="_blank"
                        rel="noreferrer"
                        href={props.embed?.url || props.gif?.url}
                      >
                        <IconButton>
                          <Symbol>open_in_new</Symbol>
                        </IconButton>
                      </a>
                    </Show>
                    <IconButton onPress={props.onClose}>
                      <Symbol>close</Symbol>
                    </IconButton>
                  </Card>
                </Bar>
              </Relative>
              <Switch>
                <Match when={props.file}>
                  <Image
                    ref={setRef}
                    style={{
                      "aspect-ratio": `${(props.file!.metadata as { width: number }).width}/${(props.file!.metadata as { height: number }).height}`,
                    }}
                    src={props.file!.originalUrl}
                    onClick={(e) => e.stopPropagation()}
                  />
                </Match>
                <Match when={props.embed}>
                  <Image
                    ref={setRef}
                    style={{
                      "aspect-ratio": `${props.embed!.width}/${props.embed!.height}`,
                    }}
                    src={props.embed!.proxiedURL}
                    onClick={(e) => e.stopPropagation()}
                  />
                </Match>
                <Match when={props.encrypted}>
                  <Image
                    ref={setRef}
                    src={props.encrypted!.url}
                    onClick={(e) => e.stopPropagation()}
                  />
                </Match>
                <Match when={props.gif}>
                  <Video
                    ref={setRef}
                    playsinline
                    loop
                    muted
                    autoplay
                    style={{
                      "aspect-ratio": `${props.gif!.width}/${props.gif!.height}`,
                    }}
                    src={props.gif!.url}
                    onClick={(e) => e.stopPropagation()}
                  />
                </Match>
              </Switch>
              <div />
            </Motion.div>
          </Show>
        </Presence>
      </Dialog.Scrim>
    </Portal>
  );
}

const Image = styled("img", {
  base: {
    minHeight: 0,
    alignSelf: "center",
    objectFit: "contain",

    background: "rgba(0, 0, 0, 0.6)",
  },
});

const Video = styled("video", {
  base: {
    minHeight: 0,
    alignSelf: "center",
    objectFit: "contain",

    background: "rgba(0, 0, 0, 0.6)",
  },
});

const Relative = styled("div", {
  base: {
    position: "relative",
  },
});

const Bar = styled("div", {
  base: {
    width: "100%",
    position: "absolute",

    height: "120px",
    flexShrink: 0,

    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
});

const Card = styled("div", {
  base: {
    zIndex: 999,
    display: "flex",
    gap: "var(--gap-md)",
    padding: "var(--gap-md)",
    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-surface)",
    color: "var(--md-sys-color-on-surface)",
  },
  variants: {
    /**
     * Allow the card to shrink past its min-content width.
     *
     * Without this the filename sets the card's automatic minimum, the flex
     * line overflows and the button card on the other end walks off screen.
     *
     * `overflow: hidden` clips whatever the shrink leaves too wide. The
     * filename line ellipsises itself, but the size line under it is a plain
     * `Text class="label"` — only the `body` typography recipes carry
     * `overflowWrap`, so at the narrowest widths that line would otherwise
     * paint outside the card's rounded background. Only the two filename
     * cards take this variant; the button card on the other end does not.
     */
    shrink: {
      true: {
        minWidth: 0,
        overflow: "hidden",
      },
    },
  },
});

/**
 * Single line that ellipsises instead of setting a width floor.
 *
 * Text renders a span, and overflow / text-overflow do not apply to an inline
 * box, so the filename needs a block wrapper of its own.
 */
const Filename = styled("div", {
  base: {
    display: "block",
    minWidth: 0,
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  },
});
