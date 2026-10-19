/**
 * Shared state for the chat windows' own title bars (friends and chat).
 *
 * - Maximized, per window label: the Windows shell pushes it as
 *   `chatWindowState` whenever a frameless window's maximized state changes
 *   (button, double-click, snap, Win+arrows), and ShellBridgeWorker stores it
 *   here, so the maximize button shows maximize or restore.
 * - Whether a tab drag is live: while one is, the bar's drag spacer turns
 *   no-drag so an HTML5 drop still lands on the tab strip (a caption region
 *   never sees it). A drag that ends without `dragend` reaching us (the
 *   source window closed, the OS ate it) must not leave the bar undraggable,
 *   so the flag clears itself after {@link TAB_DRAG_FLAG_TTL_MS}, and on
 *   {@link clearStaleTabDrag}, which the bars call on any pointerdown and on
 *   a pointermove with no button held: neither happens during an HTML5 drag.
 *
 * Kept free of lingui and the app contexts so `node --test` can load it; the
 * only Solid use is signals.
 */
import { createSignal } from "solid-js";

export { CHAT_WINDOW_LABEL_RE } from "../client/shellToMain.ts";

/** Height of a chat window's own title bar, in CSS px. */
export const TITLEBAR_HEIGHT = 32;

/**
 * Left space kept clear for the macOS traffic lights when the
 * `titlebar-area-x` environment variable is unavailable, in CSS px.
 */
export const MAC_INSET_FALLBACK_PX = 78;

/** How long a tab drag flag may live without a matching end, in ms. */
export const TAB_DRAG_FLAG_TTL_MS = 10_000;

/* ------------------------------------------------------------------------ *
 * Maximized state, per label
 * ------------------------------------------------------------------------ */

/** Labels of the windows the shell last reported maximized. */
const [maximized, setMaximized] = createSignal<ReadonlySet<string>>(new Set());

/** Whether the shell last reported the window `label` maximized (reactive). */
export function windowMaximized(label: string): boolean {
  return maximized().has(label);
}

/** Record the shell's maximized state for the window `label`. */
export function setWindowMaximized(label: string, value: boolean): void {
  const current = maximized();
  if (current.has(label) === value) return;
  const next = new Set(current);
  if (value) next.add(label);
  else next.delete(label);
  setMaximized(next);
}

/**
 * Drop what is known about the window `label`. Labels are reused:
 * `friends-window` is the label of every friends window, not just the
 * first. The shell starts each new window not maximized and pushes only
 * changes, so a new window would otherwise inherit the last one's state;
 * the host calls this when it adopts a new handle for a label.
 */
export function forgetWindow(label: string): void {
  setWindowMaximized(label, false);
}

/* ------------------------------------------------------------------------ *
 * Tab drag flag
 * ------------------------------------------------------------------------ */

const [dragActive, setDragActive] = createSignal(false);
let dragTimer: ReturnType<typeof setTimeout> | undefined;

function stopDragTimer() {
  if (dragTimer !== undefined) clearTimeout(dragTimer);
  dragTimer = undefined;
}

/** Whether a tab drag is live in any chat window (reactive). */
export function tabDragActive(): boolean {
  return dragActive();
}

/** A tab drag started; restarts the TTL if one was already live. */
export function markTabDragStart(): void {
  stopDragTimer();
  setDragActive(true);
  dragTimer = setTimeout(() => {
    dragTimer = undefined;
    setDragActive(false);
  }, TAB_DRAG_FLAG_TTL_MS);
}

/** The tab drag ended (dropped or cancelled). */
export function markTabDragEnd(): void {
  stopDragTimer();
  setDragActive(false);
}

/**
 * Clear a flag left behind by a drag whose end never arrived. Called on a
 * pointerdown, or a pointermove with no button held, in any chat window:
 * the browser sends neither while an HTML5 drag is live, so any flag still
 * set at that point is stale.
 */
export function clearStaleTabDrag(): void {
  if (dragActive()) markTabDragEnd();
}
