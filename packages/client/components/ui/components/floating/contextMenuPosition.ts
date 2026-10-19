import { type Middleware, flip, offset, shift, size } from "@floating-ui/dom";

/**
 * Space kept between a context menu and the window edge
 */
const EDGE_PADDING = 8;

/**
 * CSS variable the context menu reads as its max-height
 */
export const CONTEXT_MENU_MAX_HEIGHT = "--context-menu-max-height";

/**
 * Positioning for a context menu opened at the pointer.
 *
 * The menu's top or bottom edge stays exactly at the pointer, so the pointer
 * can only ever rest on the menu's padding, never on an item. A menu taller
 * than the room on that side scrolls instead of sliding up over the pointer
 * (the default `shift()` moves it vertically). Only then may the menu move
 * sideways to stay inside a narrow window, like the 300px friends window.
 */
export function contextMenuMiddleware(): Middleware[] {
  return [
    offset(5),
    // Below or above the pointer, whichever side has more room
    flip({ padding: EDGE_PADDING }),
    size({
      padding: EDGE_PADDING,
      apply({ availableHeight, elements }) {
        elements.floating.style.setProperty(
          CONTEXT_MENU_MAX_HEIGHT,
          `${Math.max(0, Math.floor(availableHeight))}px`,
        );
      },
    }),
    // Sideways only: a vertical shift would move an item under the pointer
    shift({ mainAxis: false, crossAxis: true, padding: EDGE_PADDING }),
  ];
}
