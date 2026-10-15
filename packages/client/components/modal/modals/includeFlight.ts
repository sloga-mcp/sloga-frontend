/**
 * Encrypted group include flights (plan D6), one per group + friend pair.
 *
 * From the server add on, an include has to reach the user as done or
 * failed, whatever happens to the modal that started it. That modal can be
 * torn down mid-commit (its chat window closed) and drawn again by main's
 * renderer as a fresh instance, so the commit's state lives here rather than
 * in the component: a re-created modal reads it back and resumes, a second
 * confirm for the same pair joins the running flight instead of adding
 * twice, and a failure stays until the user dismisses it.
 *
 *   (none) --begin--> committing --succeed--> (none, "done")
 *                         |      --abandon--> (none, nobody was added)
 *                         +--fail--> failed(half_done | terminal)
 *   failed(half_done) --retry--> committing (retrying)
 *   failed(any)       --dismiss--> (none)
 *
 * A committing flight is never dropped from outside: closing the modal does
 * not cut the steps after the server add.
 *
 * Kept free of Solid and the DOM so it loads under `node --test`.
 */

/** "half_done": added but not included yet, Retry allowed. "terminal": no Retry. */
export type IncludeFailureKind = "half_done" | "terminal";

/**
 * `retrying`: the run started from a Retry, so the half-done failure it
 * retries stays on screen while it runs.
 */
export type IncludeFlight =
  | {
      channelId: string;
      userId: string;
      phase: "committing";
      retrying: boolean;
    }
  | {
      channelId: string;
      userId: string;
      phase: "failed";
      kind: IncludeFailureKind;
    };

export type IncludeFlightEvent =
  | { key: string; type: "committing" }
  | { key: string; type: "failed"; kind: IncludeFailureKind }
  | { key: string; type: "done" }
  | { key: string; type: "abandoned"; message?: string }
  | { key: string; type: "dismissed" };

export function includeFlightKey(channelId: string, userId: string): string {
  return `${channelId}:${userId}`;
}

export class IncludeFlights {
  readonly #flights = new Map<string, IncludeFlight>();
  readonly #listeners = new Set<(event: IncludeFlightEvent) => void>();

  get(key: string): IncludeFlight | undefined {
    return this.#flights.get(key);
  }

  /**
   * Start committing an include. True when the caller now owns the run;
   * false when a flight for the pair already exists (committing: join it;
   * failed: the failure is shown, and only a Retry goes on from there).
   */
  begin(channelId: string, userId: string): boolean {
    const key = includeFlightKey(channelId, userId);
    if (this.#flights.has(key)) return false;
    this.#flights.set(key, {
      channelId,
      userId,
      phase: "committing",
      retrying: false,
    });
    this.#emit({ key, type: "committing" });
    return true;
  }

  /** Go again from a half-done failure. True when the caller owns the run. */
  retry(key: string): boolean {
    const flight = this.#flights.get(key);
    if (flight?.phase !== "failed" || flight.kind !== "half_done") {
      return false;
    }
    this.#flights.set(key, {
      channelId: flight.channelId,
      userId: flight.userId,
      phase: "committing",
      retrying: true,
    });
    this.#emit({ key, type: "committing" });
    return true;
  }

  /** The run failed after the server add: the friend may be in the group. */
  fail(key: string, kind: IncludeFailureKind): boolean {
    const flight = this.#flights.get(key);
    if (flight?.phase !== "committing") return false;
    this.#flights.set(key, {
      channelId: flight.channelId,
      userId: flight.userId,
      phase: "failed",
      kind,
    });
    this.#emit({ key, type: "failed", kind });
    return true;
  }

  /** Added and included: the flight is over. */
  succeed(key: string): boolean {
    if (this.#flights.get(key)?.phase !== "committing") return false;
    this.#flights.delete(key);
    this.#emit({ key, type: "done" });
    return true;
  }

  /**
   * The server add failed and the friend never showed up in the group:
   * nobody was added, so there is nothing to retry. `message` says why.
   */
  abandon(key: string, message?: string): boolean {
    if (this.#flights.get(key)?.phase !== "committing") return false;
    this.#flights.delete(key);
    this.#emit({ key, type: "abandoned", message });
    return true;
  }

  /** The user closed a failure panel. A committing flight is never cut. */
  dismiss(key: string): boolean {
    if (this.#flights.get(key)?.phase !== "failed") return false;
    this.#flights.delete(key);
    this.#emit({ key, type: "dismissed" });
    return true;
  }

  /**
   * The flight a modal for `userId` should show when it mounts: a failed
   * one first (it waits on the user), then a committing one, oldest first.
   */
  pickFor(userId: string): string | undefined {
    let committing: string | undefined;
    for (const [key, flight] of this.#flights) {
      if (flight.userId !== userId) continue;
      if (flight.phase === "failed") return key;
      committing ??= key;
    }
    return committing;
  }

  subscribe(listener: (event: IncludeFlightEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #emit(event: IncludeFlightEvent) {
    // A listener that throws must not stop the others from hearing about
    // the state they now have to show.
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error(error);
      }
    }
  }
}

/** The app's flights, shared by every window's modals (one JS realm). */
export const includeFlights = new IncludeFlights();
