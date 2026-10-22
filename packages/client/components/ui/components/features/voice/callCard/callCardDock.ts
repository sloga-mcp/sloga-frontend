/**
 * Where the docked call card may sit (PURE, so the rules are unit-testable
 * away from the DOM and the call).
 *
 * The docked card is drawn in a fixed-position float over whatever rect its
 * channel's mount marker measures. Two measurements are never a dock target:
 *
 * - A ZERO or near-zero width. `getBoundingClientRect()` on a node that is not
 *   laid out (detached, under `display: none`, or not yet inserted by a
 *   pending route transition) returns all zeros, and docking to that drew the
 *   card at the top-left with no width: buttons stacked in a column, text one
 *   letter per line, or nothing visible at all while still in the call.
 * - A rect that is not on screen. While the phone's slide drawer shows the
 *   channel list, the channel pane is parked a full viewport to the right, so
 *   its rect is real but off-screen.
 *
 * Anything else that fails these checks falls back to the PiP, which always
 * has a fixed size and an on-screen position.
 */

/** The subset of `DOMRect` these rules read. */
export type DockRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Narrowest mount the docked card will fill. Well under any phone width (the
 * card's own preview is 360px wide and shrinks to fit), well over the zero
 * width a not-laid-out node reports.
 */
export const MIN_DOCK_WIDTH = 160;

/**
 * Slack, in px, for sub-pixel rounding at the viewport edges, so a mount that
 * is flush with the right edge is not rejected for being 0.5px over.
 */
const EDGE_SLACK = 1;

/**
 * Whether the docked card may be drawn over this rect in a viewport of the
 * given size.
 */
export function usableDockRect(
  rect: DockRect | undefined,
  viewport: { width: number; height: number },
): rect is DockRect {
  if (!rect) return false;
  if (!(rect.width >= MIN_DOCK_WIDTH)) return false;
  if (rect.x < -EDGE_SLACK) return false;
  if (rect.x + rect.width > viewport.width + EDGE_SLACK) return false;
  if (rect.y < -EDGE_SLACK) return false;
  if (rect.y >= viewport.height) return false;
  return true;
}

/**
 * The page the docked card is drawn over, or nothing (then the PiP while in a
 * call, and no card otherwise). Docked only when ALL of these hold:
 *
 * - A channel page has registered its mount marker.
 * - The phone drawer is absent (desktop) or settled on the channel pane. While
 *   it is opening, closing or showing the channel list, the pane is moving or
 *   parked off screen, and a rect read now is wrong by the next frame. `drawer`
 *   is the drawer's state and `drawerShown` the value that means "settled on
 *   the pane"; they are passed in because the enum lives in a component file a
 *   spec cannot load.
 * - There is no call (the card is this channel's join preview), or the call is
 *   on this very channel. A call elsewhere is never drawn over this page.
 * - The measured rect is one the card can be drawn in (`usableDockRect`).
 */
export function dockDecision<C extends { id: string }, S>(input: {
  mount: { channel: C } | undefined;
  rect: DockRect | undefined;
  viewport: { width: number; height: number };
  drawer: S | undefined;
  drawerShown: S;
  callChannelId: string | undefined;
}): { channel: C; rect: DockRect } | undefined {
  const { mount, rect } = input;
  if (!mount) return;
  if (input.drawer !== undefined && input.drawer !== input.drawerShown) return;
  if (
    input.callChannelId !== undefined &&
    input.callChannelId !== mount.channel.id
  )
    return;
  if (!usableDockRect(rect, input.viewport)) return;
  return { channel: mount.channel, rect };
}

/**
 * Whether two measured rects are the same to the pixel (both absent counts as
 * the same).
 */
export function sameRect(
  a: DockRect | undefined,
  b: DockRect | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    Math.round(a.x) === Math.round(b.x) &&
    Math.round(a.y) === Math.round(b.y) &&
    Math.round(a.width) === Math.round(b.width) &&
    Math.round(a.height) === Math.round(b.height)
  );
}

/**
 * Memo comparator for the dock target: the same channel object over the same
 * rect.
 *
 * A comparator that returns true makes Solid SKIP the write entirely, so this
 * compares everything the card is drawn from. Leaving a field out would freeze
 * the card on that field's old value.
 */
export function sameDock<C>(
  a: { channel: C; rect: DockRect } | undefined,
  b: { channel: C; rect: DockRect } | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.channel === b.channel && sameRect(a.rect, b.rect);
}
