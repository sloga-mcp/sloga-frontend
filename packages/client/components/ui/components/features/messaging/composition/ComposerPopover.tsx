import { useFloating } from "solid-floating-ui";
import { JSX, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";

import { autoUpdate, flip, offset, shift, size } from "@floating-ui/dom";
import { styled } from "styled-system/jsx";

interface Props {
  /**
   * Whether the floating panel is currently shown
   */
  open: boolean;

  /**
   * Dismiss the panel — called when the user taps outside it or presses
   * Escape.
   *
   * Leave this out for panels that shouldn't be dismissible by tapping away
   * (an in-progress recording, say); doing so also drops the backdrop.
   */
  onDismiss?: () => void;

  /**
   * Trigger, rendered inline in the composer
   */
  children: JSX.Element;

  /**
   * Panel contents, rendered into the floating layer
   */
  panel: JSX.Element;
}

/**
 * Anchor a floating panel to a composer action button.
 *
 * The panel has to live in the floating layer rather than beside its trigger:
 * on phones and tablets every composer action moves into an action bar that
 * scrolls horizontally (`overflow-x: auto` in MessageBox), and per spec that
 * also computes `overflow-y` to `auto`. A panel positioned above the bar with
 * `position: absolute` therefore falls outside the bar's scrollport and gets
 * clipped away completely — invisible and untappable, which is exactly how
 * these panels behaved on Android.
 */
export function ComposerPopover(props: Props) {
  const [anchor, setAnchor] = createSignal<HTMLElement>();
  const [floating, setFloating] = createSignal<HTMLElement>();

  const position = useFloating(anchor, floating, {
    placement: "top-end",
    strategy: "fixed",
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(8),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      // Never taller or wider than the space actually available — phones in
      // landscape leave very little room above the composer.
      size({
        padding: 8,
        apply({ availableHeight, availableWidth, elements }) {
          Object.assign(elements.floating.style, {
            maxHeight: `${Math.max(120, availableHeight)}px`,
            maxWidth: `${Math.max(160, availableWidth)}px`,
          });
        },
      }),
    ],
  });

  /**
   * Dismiss on Escape as well as on a backdrop tap
   */
  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape" && props.open) props.onDismiss?.();
  }

  onMount(() => document.addEventListener("keydown", onKeyDown));
  onCleanup(() => document.removeEventListener("keydown", onKeyDown));

  return (
    <>
      <Anchor ref={setAnchor}>{props.children}</Anchor>
      <Show when={props.open}>
        <Portal mount={document.getElementById("floating")!}>
          {/* Sits above the trigger too, so tapping the trigger while the
              panel is open closes it instead of re-toggling it open. */}
          <Show when={props.onDismiss}>
            <Backdrop onClick={() => props.onDismiss!()} />
          </Show>
          <Panel
            ref={(element) => {
              // Clear on close, otherwise `autoUpdate` keeps observing the
              // detached panel for as long as the popover stays shut.
              setFloating(element);
              onCleanup(() => setFloating(undefined));
            }}
            style={{
              position: position.strategy,
              top: `${position.y ?? 0}px`,
              left: `${position.x ?? 0}px`,
            }}
          >
            {props.panel}
          </Panel>
        </Portal>
      </Show>
    </>
  );
}

const Anchor = styled("div", {
  base: {
    display: "flex",
    flexShrink: 0,
  },
});

const Backdrop = styled("div", {
  base: {
    position: "fixed",
    inset: 0,
    zIndex: 999,
  },
});

const Panel = styled("div", {
  base: {
    zIndex: 1000,
    overflowY: "auto",
    scrollbarWidth: "none",
    "&::-webkit-scrollbar": { display: "none" },
  },
});
