/**
 * Press-and-hold for platforms that never turn one into `contextmenu`.
 *
 * Android raises `contextmenu` from a long press of its own, so every Sloga
 * menu (message, user, channel, server) opens there with no extra code. iOS
 * does not: WKWebView and Safari turn the same press into text selection or
 * the link callout, and the menu never opens. On the iPhone app that left no
 * way to report a message at all, since the message toolbar is hidden on
 * phones.
 *
 * This file holds the pure parts so they can be tested without a DOM: the
 * platform check and the gesture's timing. `iosLongPress.ts` wires them to
 * the document.
 */

/** How long a finger has to stay down before the menu opens. */
export const LONG_PRESS_MS = 500;

/**
 * How far a finger may drift before the press counts as a scroll. Matches
 * `LONG_PRESS_SLOP_PX` in `Draggable.tsx`, so both gestures give up together.
 */
export const LONG_PRESS_SLOP_PX = 10;

/**
 * Whether this is an iPhone or iPad, the one place a long press has to be
 * emulated. Never true on Android: it raises `contextmenu` itself, and doing
 * both would open every menu twice.
 * @param capacitorPlatform `Capacitor.getPlatform()`: "ios" in the iPhone app
 * @param userAgent `navigator.userAgent`, for Safari on an iPhone
 * @param navPlatform `navigator.platform`
 * @param maxTouchPoints `navigator.maxTouchPoints`
 */
export function isIosTouch(
  capacitorPlatform: string,
  userAgent: string,
  navPlatform: string,
  maxTouchPoints: number,
): boolean {
  if (capacitorPlatform === "ios") return true;
  if (/\b(iPhone|iPad|iPod)\b/.test(userAgent)) return true;
  // iPadOS Safari reports itself as a Mac; a Mac has no touch points
  return navPlatform === "MacIntel" && maxTouchPoints > 1;
}

export type LongPressHooks<T> = {
  /**
   * Open the menu for a press that was held long enough.
   * @returns whether something claimed the press (a menu opened, or a drag
   * vetoed it), which decides whether the trailing tap is swallowed
   */
  fire(target: T, x: number, y: number): boolean;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
};

export type LongPress<T> = {
  /** A finger went down; `touches` is how many are down now */
  start(target: T, x: number, y: number, touches: number): void;
  /** A finger moved; `touches` is how many are down now */
  move(x: number, y: number, touches: number): void;
  /** Give up on the current press without opening anything */
  cancel(): void;
  /**
   * The finger lifted (or the touch was cancelled).
   * @returns true when the press opened something, so the caller should
   * cancel the tap the browser would otherwise deliver on release
   */
  end(): boolean;
};

/**
 * Track one press at a time: one finger, held still for `LONG_PRESS_MS`.
 * A second finger, a drift past `LONG_PRESS_SLOP_PX`, or lifting early all
 * cancel it.
 * @param hooks What to run and how to schedule it
 */
export function createLongPress<T>(hooks: LongPressHooks<T>): LongPress<T> {
  let timer: unknown;
  let pending: { target: T; x: number; y: number } | undefined;
  let claimed = false;

  function cancel() {
    if (timer !== undefined) hooks.clearTimer(timer);
    timer = undefined;
    pending = undefined;
  }

  return {
    start(target, x, y, touches) {
      cancel();
      claimed = false;
      if (touches !== 1) return;

      pending = { target, x, y };
      timer = hooks.setTimer(() => {
        timer = undefined;
        const press = pending;
        pending = undefined;
        if (press) claimed = hooks.fire(press.target, press.x, press.y);
      }, LONG_PRESS_MS);
    },

    move(x, y, touches) {
      if (!pending) return;
      if (
        touches !== 1 ||
        !(Math.abs(x - pending.x) <= LONG_PRESS_SLOP_PX) ||
        !(Math.abs(y - pending.y) <= LONG_PRESS_SLOP_PX)
      )
        cancel();
    },

    cancel,

    end() {
      cancel();
      const wasClaimed = claimed;
      claimed = false;
      return wasClaimed;
    },
  };
}
