/**
 * The page half of the E2EE worker's dead-man switch (plan D9, C7). This is
 * the pure core; `state.tsx` owns only the wiring, which has to touch the
 * Room's `Worker`. It is split out for the house reason: `state.tsx` pulls in
 * Solid, LiveKit and the bridge and cannot be loaded by `node --test`, so a
 * rule worth pinning has to live here (same rule as `decodeWitnessListener`).
 *
 * What it guards against (audit M4, the lopsided case): WebRTC and the e2ee
 * worker keep running while the main JS thread and the websocket are
 * suspended. The iPhone then keeps encrypting under epoch N after another
 * member's Remove, and nobody notices, because peers still hold N during the
 * overlap. So while a call session is live the main thread posts a
 * `slogaKeyTick` to the worker every {@link KEY_TICK_INTERVAL_MS}. Once the
 * worker has seen a tick, it DROPS local encode frames whenever the last one is
 * too old, and resumes on the next tick. Decode is untouched.
 *
 * 🔴 iOS only ({@link keyTickEnabled}). The switch is unarmed until the first
 * tick arrives, and only an iOS page ever sends one. A minimised WebView2 or
 * Electron window has its timers throttled; an armed switch there would mute
 * desktop callers whenever they minimise the window. Chromium shells must never
 * start this.
 *
 * 🔴 The worker uses ITS OWN clock. It records its own `performance.now()` when
 * a tick arrives and judges staleness from that. `data.at` is informational
 * only: the page and the worker have different time origins, and a suspended
 * main thread is exactly the case where the page clock cannot be trusted.
 * Nothing in the worker may compare `at` against its own clock.
 *
 * The bound: the worker's `SLOGA_KEY_TICK_STALE_MS` is 8000 ms against this
 * 2000 ms interval, so three ticks can be lost or late (timer jitter, a GC
 * pause, a busy main thread) before encode stops. The two constants live on
 * opposite sides of the worker boundary. Changing either one means re-checking
 * that margin.
 *
 * 🔴 A throwing `post` does not stop the timer. The worker can go away or be
 * replaced under us, and one failed post must not stop every later one. A
 * timer that dies on the first throw would leave an armed worker with no
 * ticks, so it mutes for the rest of the call and cannot recover. The failure
 * is swallowed here on purpose. If posts keep failing, the worker stops getting
 * ticks and drops encode frames, which is the closed side. Nothing in the
 * message is secret (`kind` plus a timestamp).
 */

/** How often the page posts a tick while a call session is live. */
export const KEY_TICK_INTERVAL_MS = 2_000;

/** The worker message kind. It must match the patched worker exactly. */
export const KEY_TICK_KIND = "slogaKeyTick";

/** The one message shape this module posts. */
export type KeyTickMessage = { kind: "slogaKeyTick"; data: { at: number } };

/**
 * Whether this platform runs the tick. True only on a script-transform engine
 * (iOS WebKit, `isScriptTransformEngine` in `webkitSenderHold.ts`). Every other
 * shell returns false, which keeps the worker's switch unarmed for the life of
 * the call.
 */
export function keyTickEnabled(scriptTransformEngine: boolean): boolean {
  return scriptTransformEngine === true;
}

export interface KeyFreshnessTickDeps<H> {
  /** Posts to the Room's e2ee worker. It may throw (the worker is gone). */
  post: (message: KeyTickMessage) => void;
  /** Page clock, for the informational `at` only. */
  now: () => number;
  setInterval: (callback: () => void, ms: number) => H;
  clearInterval: (handle: H) => void;
}

/**
 * Start ticking: one post now, then one every {@link KEY_TICK_INTERVAL_MS}.
 * Returns `stop`, which is idempotent. After `stop`, no further post goes out,
 * even from an interval callback that was already queued when it ran.
 *
 * The immediate post arms the worker straight away instead of 2 s later. It
 * runs AFTER the interval is scheduled, so a throw from the first post cannot
 * leave the call without a timer.
 */
export function startKeyFreshnessTick<H>(
  deps: KeyFreshnessTickDeps<H>,
): () => void {
  const { post, now, setInterval, clearInterval } = deps;
  let stopped = false;

  const tick = (): void => {
    if (stopped) return;
    try {
      post({ kind: KEY_TICK_KIND, data: { at: now() } });
    } catch {
      // Swallowed on purpose; see the header. The next tick tries again.
    }
  };

  const handle = setInterval(tick, KEY_TICK_INTERVAL_MS);
  tick();

  return (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(handle);
  };
}
