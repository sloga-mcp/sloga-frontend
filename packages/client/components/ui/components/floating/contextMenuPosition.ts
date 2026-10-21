import {
  type Middleware,
  type MiddlewareState,
  detectOverflow,
  flip,
  offset,
  shift,
  size,
} from "@floating-ui/dom";

/**
 * Space kept between a context menu and the window edge
 */
const EDGE_PADDING = 8;

/**
 * CSS variable the context menu reads as its max-height
 */
export const CONTEXT_MENU_MAX_HEIGHT = "--context-menu-max-height";

/**
 * Records whether the menu fits beside the pointer, left or right of it,
 * without covering it
 */
const besidePointer: Middleware = {
  name: "besidePointer",
  async fn(state) {
    const overflow = await detectOverflow(state, { padding: EDGE_PADDING });
    return { data: { fits: overflow.left <= 0 && overflow.right <= 0 } };
  },
};

function fitsBeside(state: MiddlewareState) {
  return state.middlewareData.besidePointer?.fits === true;
}

/**
 * Positioning for a context menu opened at the pointer.
 *
 * A menu that fits beside the pointer slides up or down into view at full
 * height, as menus always have: beside the pointer, no vertical position can
 * put an item under it.
 *
 * A menu that does not fit beside it (a narrow window, like the 300px
 * friends window) must move sideways over the pointer. Then its top or
 * bottom edge stays exactly at the pointer, so the pointer can only rest on
 * the menu's padding, never on an item, and a menu taller than the room on
 * that side scrolls instead of sliding up over the pointer.
 */
export function contextMenuMiddleware(): Middleware[] {
  return [
    offset(5),
    // Right or left, then below or above the pointer, whichever has room
    flip({ padding: EDGE_PADDING }),
    besidePointer,
    shift((state) => ({
      mainAxis: fitsBeside(state),
      crossAxis: true,
      padding: EDGE_PADDING,
    })),
    // After shift: with the vertical shift on, the room is the whole window
    // height; with it off, only the side of the pointer the menu opens on
    size({
      padding: EDGE_PADDING,
      apply({ availableHeight, elements }) {
        elements.floating.style.setProperty(
          CONTEXT_MENU_MAX_HEIGHT,
          `${Math.max(0, Math.floor(availableHeight))}px`,
        );
      },
    }),
  ];
}
