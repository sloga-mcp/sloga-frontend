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
 *                         +--fail--> failed(half_done | declined | terminal)
 *   failed(half_done | declined) --retry--> committing (retrying)
 *   failed(any)                  --dismiss--> (none)
 *
 * A committing flight is never dropped from outside: closing the modal does
 * not cut the steps after the server add.
 *
 * Kept free of Solid and the DOM so it loads under `node --test`.
 */

import type { GroupGrowthOutcome } from "@revolt/client/e2ee";

import { isTerminalIncludeError } from "../../client/groupInclude.ts";

/**
 * After the server add, so the friend is in the group either way.
 * - "half_done": not included yet; Retry allowed.
 * - "declined": the user pressed Cancel on the native confirm dialog. The
 *   friend stays `announced` (plan D5); Retry allowed, and it prompts again.
 * - "terminal": no Retry.
 */
export type IncludeFailureKind = "half_done" | "declined" | "terminal";

/** The failure kinds a Retry may start from: every one but "terminal". */
export type RetryableIncludeFailureKind = Exclude<
  IncludeFailureKind,
  "terminal"
>;

/**
 * Why the include failed, when the copy says more than the kind does.
 * - "busy": another growth dialog is open, or this group's prompt is locked
 *   for a while after a decline.
 * - "roster_changed": the member set changed while the dialog was open.
 * - "roster_mismatch": native refused the roster as not this group's.
 * - "self_user_id": this device is not an active member of the group's
 *   encryption.
 * - "other_account": the native store belongs to another account.
 */
export type IncludeFailureDetail =
  | "busy"
  | "roster_changed"
  | "roster_mismatch"
  | "self_user_id"
  | "other_account";

export type IncludeFailure = {
  kind: IncludeFailureKind;
  detail?: IncludeFailureDetail;
};

/**
 * `retrying`: the run started from a Retry, so the failure it retries stays
 * on screen while it runs. `retried` is that failure's kind, present only
 * while retrying.
 */
export type IncludeFlight =
  | {
      channelId: string;
      userId: string;
      phase: "committing";
      retrying: boolean;
      retried?: RetryableIncludeFailureKind;
    }
  | {
      channelId: string;
      userId: string;
      phase: "failed";
      kind: IncludeFailureKind;
      detail?: IncludeFailureDetail;
    };

export type IncludeFlightEvent =
  | { key: string; type: "committing" }
  | {
      key: string;
      type: "failed";
      kind: IncludeFailureKind;
      detail?: IncludeFailureDetail;
    }
  | { key: string; type: "done" }
  | { key: string; type: "abandoned"; message?: string }
  | { key: string; type: "dismissed" };

export function includeFlightKey(channelId: string, userId: string): string {
  return `${channelId}:${userId}`;
}

/**
 * The failure for an `addGroupMemberEncrypted` outcome other than "ok".
 * Neither is terminal: nothing was sent, and a Retry prompts again.
 */
export function includeFailureForOutcome(
  outcome: Exclude<GroupGrowthOutcome, "ok">,
): IncludeFailure {
  switch (outcome) {
    case "declined":
      return { kind: "declined" };
    case "busy":
      return { kind: "half_done", detail: "busy" };
    default: {
      // An outcome this build does not know is no success: retryable.
      const unknown: never = outcome;
      void unknown;
      return { kind: "half_done" };
    }
  }
}

/** `invalid_argument` fields the native growth gate refuses with */
const ROSTER_FIELDS: ReadonlySet<string> = new Set([
  "roster_changed",
  "roster_mismatch",
  "self_user_id",
]);

/**
 * The failure for an error `addGroupMemberEncrypted` threw. Reads the
 * native `type` tag (and an `invalid_argument`'s `field`), which the
 * wrapped errors keep. Never throws.
 *
 * - `declined` / `busy` arriving as a throw instead of an outcome are still
 *   that outcome: a Cancel is never a terminal failure.
 * - `mls_store_owned_by_another_account` is terminal: the store belongs to
 *   another account, nothing a Retry in this session does changes that, and
 *   every Retry would still spend one of the friend's one-time keys on its
 *   fresh bundle.
 * - `roster_changed`, `roster_mismatch` and `self_user_id` stay retryable:
 *   the member list can settle, and another member can re-send it.
 * - Anything else is terminal only when `isTerminalIncludeError` says so.
 */
export function includeFailureForError(error: unknown): IncludeFailure {
  let type: unknown;
  let field: unknown;
  try {
    const shape = error as { type?: unknown; field?: unknown } | null;
    type = shape?.type;
    field = shape?.field;
  } catch {
    // a throwing getter is no evidence of a terminal failure
    return { kind: "half_done" };
  }
  if (type === "declined") return includeFailureForOutcome("declined");
  if (type === "busy") return includeFailureForOutcome("busy");
  if (type === "mls_store_owned_by_another_account") {
    return { kind: "terminal", detail: "other_account" };
  }
  if (
    type === "invalid_argument" &&
    typeof field === "string" &&
    ROSTER_FIELDS.has(field)
  ) {
    return {
      kind: "half_done",
      detail: field as "roster_changed" | "roster_mismatch" | "self_user_id",
    };
  }
  return { kind: isTerminalIncludeError(error) ? "terminal" : "half_done" };
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

  /**
   * Go again from a failure that is not terminal (half-done or declined).
   * True when the caller owns the run.
   */
  retry(key: string): boolean {
    const flight = this.#flights.get(key);
    if (flight?.phase !== "failed" || flight.kind === "terminal") {
      return false;
    }
    this.#flights.set(key, {
      channelId: flight.channelId,
      userId: flight.userId,
      phase: "committing",
      retrying: true,
      retried: flight.kind,
    });
    this.#emit({ key, type: "committing" });
    return true;
  }

  /**
   * The run failed after the server add: the friend may be in the group.
   * `detail` says why, when the copy says more than the kind does.
   */
  fail(
    key: string,
    kind: IncludeFailureKind,
    detail?: IncludeFailureDetail,
  ): boolean {
    const flight = this.#flights.get(key);
    if (flight?.phase !== "committing") return false;
    this.#flights.set(key, {
      channelId: flight.channelId,
      userId: flight.userId,
      phase: "failed",
      kind,
      ...(detail ? { detail } : {}),
    });
    this.#emit({ key, type: "failed", kind, ...(detail ? { detail } : {}) });
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
