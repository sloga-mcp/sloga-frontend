/**
 * Keeps the server's activity status in step with what the desktop app
 * detects. PURE and dependency-free so `node --test` can load it; the
 * ActivityWorker feeds it and supplies the request.
 *
 * The detector re-sends the same value every 30 s and the worker only reacts
 * to a change, so a request that fails cannot wait for "the next change" to
 * be retried: if clearing the activity failed when the game closed, there is
 * no next change until another game starts, and the profile keeps showing the
 * old game. A failed request is therefore retried on a timer with backoff
 * until it succeeds or the wanted value changes.
 *
 * Only one request is in flight at a time. A value that arrives while one is
 * in flight is sent once it settles; a value that arrives while a retry is
 * waiting is sent at once and resets the backoff.
 */

/** Delays between retries of a failed request. The last one repeats. */
export const ACTIVITY_RETRY_BACKOFF_MS: readonly number[] = [
  2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000,
];

export type ActivitySyncOptions = {
  /** Set the activity to `target`, or clear it when `target` is null. */
  push: (target: string | null) => Promise<unknown>;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  backoffMs?: readonly number[];
};

export type ActivitySync = {
  /**
   * The value the server should hold now. `serverHasActivity` is read only
   * on the first call, to skip a pointless clear when there is nothing to
   * clear.
   */
  update(target: string | null, serverHasActivity: () => boolean): void;
  dispose(): void;
};

export function createActivitySync(options: ActivitySyncOptions): ActivitySync {
  const schedule =
    options.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel =
    options.cancel ??
    ((handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
  const backoff = options.backoffMs?.length
    ? options.backoffMs
    : ACTIVITY_RETRY_BACKOFF_MS;

  /** What the server should hold. `undefined` until the first update. */
  let wanted: string | null | undefined;
  /**
   * What the server holds as far as we know: the last value a request
   * succeeded with. `undefined` when unknown (never sent, or the last
   * request failed and may or may not have applied).
   */
  let confirmed: string | null | undefined;
  let inFlight = false;
  let retryTimer: unknown;
  let failures = 0;
  let disposed = false;

  function clearRetry() {
    if (retryTimer !== undefined) {
      cancel(retryTimer);
      retryTimer = undefined;
    }
  }

  function flush() {
    if (disposed || inFlight || retryTimer !== undefined) return;
    if (wanted === undefined || wanted === confirmed) return;

    const target = wanted;
    inFlight = true;
    let request: Promise<unknown>;
    try {
      request = options.push(target);
    } catch (error) {
      request = Promise.reject(error);
    }

    request.then(
      () => {
        inFlight = false;
        confirmed = target;
        failures = 0;
        flush();
      },
      () => {
        inFlight = false;
        confirmed = undefined;
        if (disposed) return;
        const delay = backoff[Math.min(failures, backoff.length - 1)];
        failures++;
        retryTimer = schedule(() => {
          retryTimer = undefined;
          flush();
        }, delay);
      },
    );
  }

  return {
    update(target, serverHasActivity) {
      if (disposed) return;
      if (wanted === undefined && target === null && !serverHasActivity()) {
        // nothing to clear on first run
        wanted = confirmed = null;
        return;
      }
      if (target === wanted) return;

      wanted = target;
      if (retryTimer !== undefined) {
        // A new value is worth sending now, not after the old backoff.
        clearRetry();
        failures = 0;
      }
      flush();
    },
    dispose() {
      disposed = true;
      clearRetry();
    },
  };
}
