/**
 * Shared state for the chat windows' own title bars (friends and chat).
 *
 * - Maximized, per window label: the Windows shell pushes it as
 *   `chatWindowState` whenever a frameless window's maximized state changes
 *   (button, double-click, snap, Win+arrows), and ShellBridgeWorker stores it
 *   here, so the maximize button shows maximize or restore.
 * - Whether a drag is live: a tab drag, or files dragged in from Explorer or
 *   Finder. While one is, the bar's free space (the drag spacer, the macOS
 *   inset, the friends window's bar) turns no-drag so an HTML5 drop still
 *   lands there (a caption region never sees it). A drag that ends without
 *   `dragend` or `drop` reaching us (the source window closed, the OS ate
 *   it, the files left the window) must not leave the bar undraggable, so
 *   the flag clears itself after {@link TAB_DRAG_FLAG_TTL_MS}, and on
 *   {@link clearStaleTabDrag}, which each window calls on the pointer events
 *   {@link isStaleDragPointer} picks: none happens during an HTML5 drag.
 * - The layout of a bar, by frame ({@link titleBarLayout}).
 *
 * Kept free of lingui and the app contexts so `node --test` can load it; the
 * only Solid use is signals.
 */
import { createSignal } from "solid-js";

import type { ChatWindowFrame } from "../client/chatShell.ts";

export { CHAT_WINDOW_LABEL_RE } from "../client/shellToMain.ts";

/** Height of a chat window's own title bar, in CSS px. */
export const TITLEBAR_HEIGHT = 32;

/**
 * Left space kept clear for the macOS traffic lights when the
 * `titlebar-area-x` environment variable is unavailable, in CSS px.
 */
export const MAC_INSET_FALLBACK_PX = 78;

/**
 * Left padding for a title bar under the macOS traffic lights (the `inset`
 * frame): the space the overlay reports, or a fixed fallback where the
 * environment variable is unavailable.
 */
export const MAC_INSET_PADDING = `env(titlebar-area-x, ${MAC_INSET_FALLBACK_PX}px)`;

/** How long a drag flag may live without a matching end, in ms. */
export const TAB_DRAG_FLAG_TTL_MS = 10_000;

/* ------------------------------------------------------------------------ *
 * Bar layout
 * ------------------------------------------------------------------------ */

/** How a window's own title bar is drawn, from its frame. */
export interface TitleBarLayout {
  /** The window has no OS title bar, so it draws its own. */
  bar: boolean;
  /** Draw minimize, maximize / restore and close at the bar's right end. */
  controls: boolean;
  /** Inline style for the bar, or undefined for none. */
  style: { "padding-left": string } | undefined;
}

/**
 * The bar of a window built with `frame`, whose shell label is `label`.
 *
 * - `native`: the OS draws the title bar, so there is no bar of our own.
 * - `buttons` (Tauri on Windows): a bar with the window controls, which need
 *   the label to address the window; without one the bar is drawn but the
 *   controls are not (the OS keeps Alt+F4 and the taskbar).
 * - `inset` (Electron on macOS): a bar whose left end is kept clear for the
 *   traffic lights, which the OS draws. The padding is physical, not
 *   `padding-inline-start`: the lights sit on the left whatever the page's
 *   direction, so an RTL page must not move the space to the right.
 */
export function titleBarLayout(
  frame: ChatWindowFrame,
  label: string | undefined,
): TitleBarLayout {
  if (frame === "buttons") {
    return { bar: true, controls: label !== undefined, style: undefined };
  }
  if (frame === "inset") {
    return {
      bar: true,
      controls: false,
      style: { "padding-left": MAC_INSET_PADDING },
    };
  }
  return { bar: false, controls: false, style: undefined };
}

/**
 * The `data-app-region` of a bar's free space while a drag is `active` or
 * not: a caption region normally, so a press there moves the window, and
 * no-drag during a drag, as a caption region never receives an HTML5 drop.
 */
export function spacerRegion(active: boolean): "drag" | "no-drag" {
  return active ? "no-drag" : "drag";
}

/**
 * Whether the pointer event `e` shows that no HTML5 drag is live: a press,
 * or a move with no button held. The browser sends neither during a drag,
 * so a drag flag still set at that point is stale.
 */
export function isStaleDragPointer(e: {
  type: string;
  buttons: number;
}): boolean {
  return (
    e.type === "pointerdown" || (e.type === "pointermove" && e.buttons === 0)
  );
}

/**
 * Whether the drag event `e` is files from outside the app (Explorer,
 * Finder) entering or moving over a window: a `dragenter` or `dragover`
 * whose payload includes `Files`. Tab drags carry only `text/plain`.
 */
export function isFileDragOver(e: {
  type: string;
  dataTransfer?: { types: ArrayLike<string> } | null;
}): boolean {
  if (e.type !== "dragenter" && e.type !== "dragover") return false;
  const types = e.dataTransfer?.types;
  // `types` is a plain array today but a DOMStringList in older engines
  return types ? Array.prototype.includes.call(types, "Files") : false;
}

/** The events a chat window's document reports to {@link dragFlagAction}. */
export const DRAG_FLAG_EVENTS = [
  "dragenter",
  "dragover",
  "drop",
  "dragend",
  "pointerdown",
  "pointermove",
] as const;

/**
 * What the event `e`, seen in a chat window's document, does to the drag
 * flag:
 *
 * - `raise`: files from outside are over the window
 *   ({@link isFileDragOver}), so the bars' free space stops refusing them.
 *   `dragover` keeps restarting the TTL while they hover; a drag that
 *   enters across the bar itself is unseen until it reaches the page, as a
 *   caption region gets no drag events.
 * - `end`: a `drop` or `dragend`; the drag is over.
 * - `stale`: a pointer event that proves no drag is live
 *   ({@link isStaleDragPointer}).
 * - null: nothing.
 */
export function dragFlagAction(e: {
  type: string;
  buttons?: number;
  dataTransfer?: { types: ArrayLike<string> } | null;
}): "raise" | "end" | "stale" | null {
  if (isFileDragOver(e)) return "raise";
  const { type, buttons } = e;
  if (type === "drop" || type === "dragend") return "end";
  if (buttons !== undefined && isStaleDragPointer({ type, buttons })) {
    return "stale";
  }
  return null;
}

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
 * the host calls this when a window closes, so closed labels do not linger,
 * and again when it adopts a new handle for a label, in case a close was
 * missed.
 */
export function forgetWindow(label: string): void {
  setWindowMaximized(label, false);
}

/* ------------------------------------------------------------------------ *
 * Drag flag (tab drags, and files from outside the app)
 * ------------------------------------------------------------------------ */

const [dragActive, setDragActive] = createSignal(false);
let dragTimer: ReturnType<typeof setTimeout> | undefined;

function stopDragTimer() {
  if (dragTimer !== undefined) clearTimeout(dragTimer);
  dragTimer = undefined;
}

/**
 * Whether a tab drag, or a drag of files from outside the app, is live in
 * any chat window (reactive).
 */
export function tabDragActive(): boolean {
  return dragActive();
}

/**
 * A tab drag started, or files entered a chat window
 * ({@link isFileDragOver}); restarts the TTL if a drag was already live.
 */
export function markTabDragStart(): void {
  stopDragTimer();
  setDragActive(true);
  dragTimer = setTimeout(() => {
    dragTimer = undefined;
    setDragActive(false);
  }, TAB_DRAG_FLAG_TTL_MS);
}

/** The drag ended (dropped or cancelled). */
export function markTabDragEnd(): void {
  stopDragTimer();
  setDragActive(false);
}

/**
 * Clear a flag left behind by a drag whose end never arrived. Called on the
 * pointer events {@link isStaleDragPointer} picks, in any chat window: the
 * browser sends none while an HTML5 drag is live, so any flag still set at
 * that point is stale.
 */
export function clearStaleTabDrag(): void {
  if (dragActive()) markTabDragEnd();
}
