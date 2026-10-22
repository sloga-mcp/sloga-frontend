import {
  type Accessor,
  type JSX,
  createEffect,
  createSignal,
  on,
  onCleanup,
} from "solid-js";

import { useWindowCtx } from "@revolt/client/windowCtx";

type Props = JSX.Directives["floating"] & object;

export type FloatingElement = {
  config: () => Props;
  element: HTMLElement;
  hide: () => void;
  show: Accessor<Props | undefined>;
  /**
   * Window the element lives in; only that window's FloatingManager renders it
   */
  ctxId: string;
};

const [floatingElements, setFloatingElements] = createSignal<FloatingElement[]>(
  [],
);

export { floatingElements };

/**
 * Register a new floating element
 *
 * Without an explicit `ctxId` the window is read from context, so call this
 * synchronously from the directive, where the element's owner is current.
 * @param element element
 */
export function registerFloatingElement(
  element: Omit<FloatingElement, "ctxId"> & { ctxId?: string },
) {
  const entry = { ...element, ctxId: element.ctxId ?? useWindowCtx().id };
  setFloatingElements((elements) => [...elements, entry]);
}

/**
 * Un register floating element
 * @param element DOM Element
 */
export function unregisterFloatingElement(element: HTMLElement) {
  setFloatingElements((elements) =>
    elements.filter((entry) => entry.element !== element),
  );
}

/**
 * Add floating elements
 * @param element Element
 * @param accessor Parameters
 */
export function floating(element: HTMLElement, accessor: Accessor<Props>) {
  const config = accessor();
  if (!config) return;

  const [show, setShow] = createSignal<Props | undefined>();
  // DEBUG: createEffect(() => console.info("show:", show()));

  registerFloatingElement({
    config: accessor,
    element,
    show,
    ctxId: useWindowCtx().id,
    /**
     * Hide the element
     */
    hide() {
      setShow(undefined);
    },
  });

  /**
   * Trigger a floating element
   */
  function trigger(target: keyof Props, desiredState?: boolean) {
    const current = show();
    const config = accessor();

    if (target === "userCard" && config.userCard) {
      if (current?.userCard) {
        setShow(undefined);
      } else if (!current) {
        setShow({ userCard: config.userCard });
      } else {
        setShow(undefined);
        setShow({ userCard: config.userCard });
      }
    }

    if (target === "tooltip" && config.tooltip) {
      if (current?.tooltip) {
        if (desiredState !== true) {
          setShow(undefined);
        }
      } else if (!current) {
        if (desiredState !== false) {
          setShow({ tooltip: config.tooltip });
        }
      }
    }

    if (target === "contextMenu" && config.contextMenu) {
      if (current?.contextMenu) {
        setShow(undefined);
      } else if (!current) {
        setShow({ contextMenu: config.contextMenu });
      } else {
        setShow(undefined);
        setShow({ contextMenu: config.contextMenu });
      }
    }
  }

  /**
   * Handle click events
   */
  function onClick() {
    // TODO: handle shift+click for mention
    trigger("userCard");
  }

  /**
   * Handle context menu click
   */
  function onContextMenu(event: MouseEvent) {
    // Respect an overlay that has already claimed this right-click. This
    // listener is bubble-phase and previously ignored `defaultPrevented`
    // entirely, so anything painting over an element with `use:floating`
    // could suppress the browser menu and still get Sloga's context menu
    // opened on top of it — `preventDefault` is not `stopPropagation`, and
    // per spec it does not suppress `contextmenu` delivery. The remote
    // -control capture surface is the first overlay to hit this, but it is a
    // latent hazard for any future one.
    if (event.defaultPrevented) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    trigger("contextMenu");
  }

  let isTouching = false,
    tTmr: NodeJS.Timeout | undefined;

  /**
   * Handle mouse entering
   */
  function onMouseEnter() {
    if (!isTouching) trigger("tooltip", true);
  }

  /**
   * Handle mouse leaving
   */
  function onMouseLeave() {
    trigger("tooltip", false);
  }

  function onTouch() {
    isTouching = true;
    clearTimeout(tTmr);
    tTmr = setTimeout(() => {
      isTouching = false;
      tTmr = undefined;
    }, 100);
  }

  createEffect(
    on(
      () => accessor().userCard,
      (userCard) => {
        if (userCard) {
          element.style.cursor = "pointer";
          element.style.userSelect = "none";
          element.addEventListener("click", onClick);

          onCleanup(() => element.removeEventListener("click", onClick));
        }
      },
    ),
  );

  createEffect(
    on(
      () => accessor().tooltip,
      (tooltip, prevTooltip) => {
        if (tooltip) {
          element.ariaLabel =
            typeof tooltip.content === "string"
              ? tooltip.content
              : tooltip!.aria!;

          // A showing tooltip renders the config it opened with. Swap in the
          // new one so changed content updates while hovered, rather than on
          // the next mouseenter.
          if (show()?.tooltip) setShow({ tooltip });

          element.addEventListener("mouseenter", onMouseEnter);
          element.addEventListener("mouseleave", onMouseLeave);
          element.addEventListener("touchstart", onTouch);
          element.addEventListener("touchend", onTouch);

          onCleanup(() => {
            element.removeEventListener("mouseenter", onMouseEnter);
            element.removeEventListener("mouseleave", onMouseLeave);
            element.removeEventListener("touchstart", onTouch);
            element.removeEventListener("touchend", onTouch);
          });
        } else if (prevTooltip) {
          // The tooltip was taken away (callers pass it conditionally): drop
          // the label set above, and hide it if it is showing, since its
          // mouseleave listener is gone and nothing else hides tooltips.
          // Not in onCleanup: callers may return a new config object on every
          // evaluation, which would hide a visible tooltip each time. Gated on
          // prevTooltip so an aria-label the caller set is left alone.
          element.removeAttribute("aria-label");
          if (show()?.tooltip) setShow(undefined);
        }
      },
    ),
  );

  createEffect(
    on(
      () => accessor().contextMenu,
      (contextMenu) => {
        if (contextMenu) {
          element.addEventListener(
            accessor().contextMenuHandler ?? "contextmenu",
            onContextMenu,
          );

          // TODO: iOS events for touch

          onCleanup(() => {
            element.removeEventListener(
              config.contextMenuHandler ?? "contextmenu",
              onContextMenu,
            );
          });
        }
      },
    ),
  );

  onCleanup(() => unregisterFloatingElement(element));
}
