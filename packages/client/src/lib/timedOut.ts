/**
 * Member timeouts: a reactive view of "is this member timed out right now".
 *
 * The SDK answers that question with `ServerMember.timedOutUntil()` and the
 * permission calculator, and both compare against a fresh `new Date()` each
 * time they are called. Nothing re-runs them when the clock passes the expiry,
 * so a UI that reads them once keeps showing the timeout after it lapsed.
 * `createTimedOutUntil` fixes that with a tick signal bumped by a timer armed
 * for the expiry.
 *
 * A 28-day timeout is about 2.4e9 ms, past setTimeout's signed 32-bit
 * maximum (2_147_483_647 ms). A larger delay does not wait longer: browsers
 * treat it as 0 and fire immediately. `nextExpiryDelay` clamps the delay and
 * the timer re-arms until the expiry has actually passed.
 */
import { createEffect, createSignal, onCleanup } from "solid-js";

import type { ServerMember } from "stoat.js";

/** Largest delay setTimeout honours (signed 32-bit milliseconds). */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Milliseconds to wait before re-checking a timeout, clamped to setTimeout's
 * maximum.
 * @param untilMs Expiry, in epoch milliseconds
 * @param nowMs Current time, in epoch milliseconds
 * @returns The delay, or undefined if the timeout has already expired
 *   (an expiry exactly at `nowMs` counts as expired, matching
 *   `timedOutUntil()`); also undefined for a NaN expiry (an invalid date)
 */
export function nextExpiryDelay(
  untilMs: number,
  nowMs: number,
): number | undefined {
  const remaining = untilMs - nowMs;
  // Written as !(x > 0) so NaN lands here too.
  if (!(remaining > 0)) {
    return undefined;
  }

  return Math.min(remaining, MAX_TIMER_DELAY_MS);
}

/**
 * Reactive `member.timedOutUntil()`: re-evaluated when the timeout expires,
 * as well as whenever the member or its timeout changes.
 *
 * Must be called inside a reactive owner (a component or `createRoot`); the
 * timer is cleared when that owner is disposed.
 * @param member Accessor for the member to watch
 * @returns Accessor for the expiry of the active timeout, or undefined
 */
export function createTimedOutUntil(
  member: () => ServerMember | undefined,
): () => Date | undefined {
  const [tick, setTick] = createSignal(0);

  createEffect(() => {
    // Re-runs (and the previous timer is cleared) whenever the timeout changes.
    const untilMs = member()?.timeout?.getTime();
    if (untilMs === undefined) {
      return;
    }

    let handle: ReturnType<typeof setTimeout> | undefined;

    /**
     * Arm a timer for the expiry, or for the clamped maximum if the expiry is
     * further away than that.
     * @returns Whether a timer was armed (false once the expiry has passed)
     */
    const arm = (): boolean => {
      const delay = nextExpiryDelay(untilMs, Date.now());
      if (delay === undefined) {
        return false;
      }

      handle = setTimeout(() => {
        handle = undefined;
        if (!arm()) {
          setTick((n) => n + 1);
        }
      }, delay);
      return true;
    };

    arm();

    onCleanup(() => {
      if (handle !== undefined) {
        clearTimeout(handle);
      }
    });
  });

  // An accessor by design: callers read it inside their own tracked scopes.
  // eslint-disable-next-line solid/reactivity
  return () => {
    tick();
    return member()?.timedOutUntil();
  };
}
