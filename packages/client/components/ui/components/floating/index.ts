import { allWindowCtxs } from "@revolt/client/windowCtx";

export { FloatingManager } from "./FloatingManager";
export { Tooltip } from "./Tooltip";
export { UserCard } from "./UserCard";

/**
 * Trigger a global mousedown running the floating close logic, in every
 * window: each chat window's FloatingManager listens on its own document
 */
export function dismissFloatingElements() {
  for (const ctx of allWindowCtxs()) {
    const win = ctx.win as Window & typeof globalThis;
    ctx.doc.dispatchEvent(new win.Event("mousedown"));
  }
}
