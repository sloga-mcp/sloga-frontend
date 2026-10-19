/* eslint-disable solid/reactivity */
import { useFloating } from "solid-floating-ui";
import {
  For,
  Match,
  Show,
  Switch,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { Portal } from "solid-js/web";
import { Motion, Presence } from "solid-motionone";

import { autoUpdate, flip, offset, shift } from "@floating-ui/dom";

import { useWindowCtx } from "@revolt/client/windowCtx";
import { Keybind, KeybindAction } from "@revolt/keybinds";

import { FloatingElement, floatingElements } from "../../directives";

import { AutoComplete } from "./AutoComplete";
import { contextMenuMiddleware } from "./contextMenuPosition";
import { TooltipBase } from "./Tooltip";
import { UserCard } from "./UserCard";

/**
 * Render the actual floating elements
 *
 * One instance runs per window; each renders only the elements registered
 * from its own window, into that window's #floating.
 */
export function FloatingManager() {
  const ctx = useWindowCtx();

  let mouseX = 0,
    mouseY = 0;

  /**
   * Keep track of last mouse position at all times
   */
  function onMouseMove({ clientX, clientY }: MouseEvent) {
    mouseX = clientX;
    mouseY = clientY;
  }

  onMount(() => ctx.doc.addEventListener("mousemove", onMouseMove));
  onCleanup(() => ctx.doc.removeEventListener("mousemove", onMouseMove));

  const elements = createMemo(() =>
    floatingElements().filter((el) => el.ctxId === ctx.id),
  );

  /**
   * Whether a floating element is visible
   */
  function anyVisible() {
    return elements().find((el) => el.show());
  }

  /**
   * Run the close logic of this window's floating elements; the same as
   * `dismissFloatingElements`, but on this window's document
   */
  function dismiss() {
    ctx.doc.dispatchEvent(new Event("mousedown"));
  }

  return (
    <Portal mount={ctx.floatingMount()}>
      <For each={elements()}>
        {(element) => (
          <Presence>
            <Show when={element.show()}>
              <Floating {...element} mouseX={mouseX} mouseY={mouseY} />
            </Show>
          </Presence>
        )}
      </For>

      <Show when={anyVisible()}>
        <Keybind keybind={KeybindAction.CLOSE_FLOATING} onPressed={dismiss} />
      </Show>
    </Portal>
  );
}

/**
 * Render a floating element
 */
function Floating(props: FloatingElement & { mouseX: number; mouseY: number }) {
  const [floating, setFloating] = createSignal<HTMLDivElement>();

  /**
   * Figure out placement of the floating element
   */
  const placement = () => {
    const current = props.show();
    if (!current) return;

    if (current.tooltip) {
      return current.tooltip.placement;
    } else if (current.userCard) {
      return "right-start";
    } else if (current.contextMenu) {
      return "right-start";
    } else if (current.autoComplete) {
      return "top-start";
    }
  };

  /**
   * Determine element to provide
   */
  const element = () => {
    const current = props.show();

    if (current?.contextMenu) {
      return {
        /**
         * Determine client rectangle for virtual element
         */
        getBoundingClientRect() {
          return {
            width: 0,
            height: 0,
            x: props.mouseX,
            y: props.mouseY,
            left: props.mouseX,
            right: props.mouseX,
            top: props.mouseY,
            bottom: props.mouseY,
          };
        },
      };
    } else {
      return props.element;
    }
  };

  const position = useFloating(element, floating, {
    placement: placement(),
    middleware: props.show()?.contextMenu
      ? contextMenuMiddleware()
      : [offset(5), flip(), shift()],
    whileElementsMounted:
      props.show()?.tooltip || props.show()?.autoComplete
        ? autoUpdate
        : undefined,
  });

  /**
   * Dismiss floating element when clicking elsewhere
   */
  function onMouseDown() {
    const currentlyShown = props.show();
    if (!currentlyShown?.contextMenu && !currentlyShown?.userCard) return;

    props.hide();
  }

  // Rendered by its own window's FloatingManager, so this is that window
  const { doc } = useWindowCtx();

  if (props.config().contextMenu || props.config().userCard) {
    onMount(() => doc.addEventListener("mousedown", onMouseDown));
    onCleanup(() => doc.removeEventListener("mousedown", onMouseDown));
  }

  /**
   * Always dismiss context menu on click
   */
  function onClick() {
    const currentlyShown = props.show();
    if (!currentlyShown?.contextMenu) return;

    props.hide();
  }

  if (props.config().contextMenu) {
    onMount(() => doc.addEventListener("click", onClick));
    onCleanup(() => doc.removeEventListener("click", onClick));
  }

  return (
    <Motion
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.1, easing: [0.87, 0, 0.13, 1] }}
    >
      <div
        ref={setFloating}
        style={{
          position: position.strategy,
          top: `${position.y ?? 0}px`,
          left: `${position.x ?? 0}px`,
          "z-index": props.show()?.userCard ? "99" : "999",
        }}
      >
        <Switch>
          <Match when={props.show()?.tooltip}>
            <TooltipBase>
              {typeof props.show()!.tooltip!.content === "function"
                ? (props.show()!.tooltip!.content as (arg1: object) => void)({})
                : props.show()!.tooltip!.content}
            </TooltipBase>
          </Match>
          <Match when={props.show()?.userCard}>
            <UserCard
              user={props.show()!.userCard!.user}
              member={props.show()!.userCard!.member}
              onClose={props.hide}
            />
          </Match>
          <Match when={props.show()?.contextMenu}>
            {props.show()!.contextMenu!({})}
          </Match>
          <Match when={props.show()?.autoComplete}>
            <AutoComplete {...props.show()!.autoComplete!} />
          </Match>
        </Switch>
      </div>
    </Motion>
  );
}
