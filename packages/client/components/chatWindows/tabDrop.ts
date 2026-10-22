/**
 * Drag-and-drop decisions for the chat-window tab strip (plan D7): tear a tab
 * off into a new window, or drop it on any chat window's strip to move it.
 *
 * Every chat window is a same-realm child of main, so one module-level drag
 * source is visible to the strip the drag starts in AND to the strip in
 * another window it lands on. `dataTransfer` cannot carry that: during
 * `dragover` only its `types` are readable, and any text drag from anywhere
 * has a `text/plain` type. A strip therefore only accepts a drag while a tab
 * drag is recorded here, and a drop only moves a tab that the payload and the
 * recorded source both name. Text dragged in from another app, or from
 * another instance of the app, is never a tab.
 *
 * A drag lives from the source tab's `dragstart` to its `dragend`, not just
 * to the drop: a drop on another window can empty the source window, and the
 * host keeps that window open while `tabDragSource()` reports a drag, so the
 * source still gets its `dragend` (closing it mid-drag can abort the native
 * drag loop). Once a strip took the drop, the drag is marked dropped: it is
 * still reported, but no strip accepts it again.
 *
 * Kept free of the DOM, Solid and lingui so `node --test` can load it.
 */

export const TAB_DRAG_PREFIX = "sloga-tab:";

/** Same cap as the chat-window store's channel ids. */
const MAX_CHANNEL_ID_LENGTH = 128;

/** Where a torn-off window opens relative to the cursor (plan D7). */
const TEAR_OFF_OFFSET = { left: 40, top: 20 };

/**
 * How long a dropped drag is still reported while its `dragend` is awaited.
 * That event normally follows the drop at once; an engine that never fires
 * it at a source tab the drop removed must not leave a drag reported for
 * good, which would hold back every later window close. Below the host's
 * `DRAG_CLOSE_MAX_DEFER_MS`, so it is this bound that ends such a drag.
 */
export const DROPPED_DRAG_TTL_MS = 5_000;

export type TabDragSource = { channelId: string; windowId: string };

let source: TabDragSource | null = null;
/** When a strip took the drop of `source`; null while it is still live. */
let droppedAt: number | null = null;

/** `dragstart`: record the tab being dragged and from which window. */
export function beginTabDrag(channelId: string, windowId: string): void {
  source = { channelId, windowId };
  droppedAt = null;
}

/**
 * The tab drag in progress, if any: from `dragstart` until `dragend`, so
 * also after its drop, though no longer than `DROPPED_DRAG_TTL_MS` past it.
 */
export function tabDragSource(now: number = Date.now()): TabDragSource | null {
  if (droppedAt !== null && !(now - droppedAt < DROPPED_DRAG_TTL_MS)) {
    source = null;
    droppedAt = null;
  }
  return source;
}

/** Whether a tab drag is in progress and no strip has taken its drop yet. */
export function tabDragLive(): boolean {
  return source !== null && droppedAt === null;
}

/**
 * `drop` on a strip: mark the live drag of `channelId` dropped. Call it
 * before moving the tab, so the move does not end the drag. Returns whether
 * it was that drag.
 */
export function markTabDropped(
  channelId: string,
  now: number = Date.now(),
): boolean {
  if (!tabDragLive() || source?.channelId !== channelId) return false;
  droppedAt = now;
  return true;
}

/**
 * `dragend`: forget the drag. With a channel id, only that drag is
 * forgotten, so a late `dragend` from an older drag cannot clear a newer one.
 */
export function endTabDrag(channelId?: string): void {
  if (channelId === undefined || source?.channelId === channelId) {
    source = null;
    droppedAt = null;
  }
}

/**
 * The tab of `channelId` left its strip. Closed (`stillOpen` false), or gone
 * with its window before any drop, it ends its drag: it is no longer a valid
 * drop. Moved by the drop a strip just took (dropped, and still open in
 * another window), it keeps the drag until its own `dragend`.
 */
export function endTabDragOnRemoval(
  channelId: string,
  stillOpen: boolean,
): void {
  if (source?.channelId !== channelId) return;
  if (droppedAt !== null && stillOpen) return;
  endTabDrag(channelId);
}

/** The `text/plain` payload of a tab drag. */
export function tabDragPayload(channelId: string): string {
  return TAB_DRAG_PREFIX + channelId;
}

/** The channel id in a tab drag payload, or null when it is not one. */
export function parseTabDragPayload(text: unknown): string | null {
  if (typeof text !== "string" || !text.startsWith(TAB_DRAG_PREFIX)) {
    return null;
  }
  const channelId = text.slice(TAB_DRAG_PREFIX.length);
  return channelId.length > 0 &&
    channelId.length <= MAX_CHANNEL_ID_LENGTH &&
    !/\s/.test(channelId)
    ? channelId
    : null;
}

/** `types` is an array today but a DOMStringList in older engines. */
function hasPlainText(types: ArrayLike<string> | null | undefined): boolean {
  return types ? Array.prototype.includes.call(types, "text/plain") : false;
}

/**
 * `dragover`: whether a strip should accept this drag (and so call
 * `preventDefault`). Only while a live tab drag is recorded (not one a strip
 * already took), and only for a drag that carries text, which every tab
 * drag does.
 */
export function acceptsTabDrag(
  types: ArrayLike<string> | null | undefined,
): boolean {
  return tabDragLive() && hasPlainText(types);
}

/**
 * `drop`: the channel to move, or null to ignore the drop. The payload must
 * name the recorded drag source: the source proves the drag started on one
 * of our tabs, the payload proves this drop is that drag. A drag already
 * dropped moves nothing again.
 */
export function droppedTab(text: unknown): string | null {
  const channelId = parseTabDragPayload(text);
  return channelId !== null && tabDragLive() && source?.channelId === channelId
    ? channelId
    : null;
}

/**
 * The slot a drop at `x` lands in, as drawn: the index of the first tab whose
 * horizontal middle is right of `x`, or `tabs.length` past the last one.
 * `tabs` are the strip's tab boxes in DOM order (left to right), including
 * the dragged tab itself when it is in this strip; the store's `moveTab`
 * accounts for that.
 */
export function dropIndex(
  tabs: readonly { left: number; width: number }[],
  x: number,
): number {
  if (!Number.isFinite(x)) return tabs.length;
  for (let i = 0; i < tabs.length; i++) {
    if (x < tabs[i].left + tabs[i].width / 2) return i;
  }
  return tabs.length;
}

/** A window's outer bounds in screen pixels. */
export type ScreenRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/**
 * Whether a screen point lies inside any of the windows. A rect with a
 * non-finite or empty extent covers nothing.
 */
export function insideAnyWindow(
  screenX: number,
  screenY: number,
  windows: readonly ScreenRect[],
): boolean {
  return windows.some(
    (w) =>
      Number.isFinite(w.left) &&
      Number.isFinite(w.top) &&
      Number.isFinite(w.width) &&
      Number.isFinite(w.height) &&
      w.width > 0 &&
      w.height > 0 &&
      screenX >= w.left &&
      screenX < w.left + w.width &&
      screenY >= w.top &&
      screenY < w.top + w.height,
  );
}

/**
 * `dragend`: where to open a torn-off window, or null when the tab should
 * stay put. Only a drag that nothing accepted (`dropEffect` "none") AND that
 * was released outside every app window tears off. `dropEffect` alone cannot
 * tell a release over empty desktop from Escape or a refused drop inside a
 * window, which all report "none"; the release point can. A drop on a strip,
 * or on another app that took the text, does not tear off either.
 * Coordinates are screen pixels, and a non-finite pair is refused rather than
 * opening a window somewhere arbitrary.
 */
export function tearOffAt(
  dropEffect: string | null | undefined,
  screenX: number,
  screenY: number,
  windows: readonly ScreenRect[],
): { left: number; top: number } | null {
  if (dropEffect !== "none") return null;
  if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return null;
  if (insideAnyWindow(screenX, screenY, windows)) return null;
  return {
    left: Math.round(screenX - TEAR_OFF_OFFSET.left),
    top: Math.round(screenY - TEAR_OFF_OFFSET.top),
  };
}
