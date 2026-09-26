/**
 * The late-drain guard's two decisions, as pure functions.
 *
 * Split out of `mlsCallSession.ts` for the same reason every other policy here
 * is (`mlsAdmitPolicy`, `mlsCallModePolicy`, `mlsDrainPolicy`,
 * `mlsNegotiatingFailsafe`): the session class cannot be imported under
 * `node --test`, and a rule with no test is a rule nobody can control.
 *
 * Both rules fail CLOSED. Anything they cannot positively recognize lands on
 * the answer that keeps the publish gate held and ends in a DS-verified state
 * or a loud one: an unrecognized refetch failure is `"transient"` (retried,
 * bounded, then loud), and an unrecognized Welcome is `"rejoin"`. Neither
 * function can produce an answer that releases the gate on its own.
 */

/**
 * Why a gap refetch (`GET /mls/groups/<id>/commits?from_epoch=N`) threw.
 *
 * - `"not_member"`: the Delivery Service answered 404 — the group or channel
 *   is gone, or no device of this user is in its roster.
 * - `"transient"`: everything else (5xx, 403, a 429 past the bound, the
 *   per-request deadline, an abort, anything unrecognized).
 */
export type RefetchFailure = "not_member" | "transient";

/**
 * The exact message `#apiMls` throws for a bare 404 (e2ee.ts, the final
 * `throw` of `#apiMls`: `E2EE MLS ${method} ${path} failed: ${status}`), and
 * the one the harness's `dsFailure` mirrors. Anchored at both ends: `path` is
 * `/mls/groups/<64 hex>/commits?from_epoch=<n>` (no spaces), and the 400/409
 * variants append a type after the status, so none of them match.
 */
const NOT_MEMBER_MESSAGE = /^E2EE MLS \S+ \S+ failed: 404$/;

/**
 * Classify a thrown gap-refetch failure (W2-M1).
 *
 * Before the late-drain guard, `#gapRefetchInline` let this throw escape
 * `#consume` and `#pump` as an unhandled rejection: the envelope was never
 * acked, retried or escalated, and the rejection carried the group id and the
 * lost membership into Sentry. The session now catches it and needs to know
 * which kind it caught.
 *
 * `mlsFetchCommits` passes no `notFoundOutcome`, so a 404 reaches the session
 * only as a plain `Error` whose status lives in its message — hence an
 * ANCHORED match on the full message, not a status field and not a bare
 * `/404/` (a group id or an epoch can contain "404").
 *
 * Fail-closed direction: `"not_member"` triggers re-securing plus a fresh
 * rejoin; `"transient"` triggers a bounded retry that ends loud. If the
 * transport's message format ever drifts, a real 404 is misread as
 * `"transient"` — slower to resolve, still resolved, never plaintext. Nothing
 * here can turn a failure into "caught up".
 */
export function classifyRefetchFailure(err: unknown): RefetchFailure {
  if (err instanceof Error && NOT_MEMBER_MESSAGE.test(err.message)) {
    return "not_member";
  }
  return "transient";
}

/**
 * What the session does with a Welcome it just adopted, once the Delivery
 * Service has said where the group is now.
 *
 * - `"current"`: the Welcome's epoch IS the DS's current epoch — go active.
 * - `"catch_up"`: the DS returned exactly the commits between the Welcome's
 *   epoch and its current one — apply them, then confirm natively.
 * - `"rejoin"`: anything else — discard the adoption and rejoin fresh.
 */
export type WelcomeCurrency = "current" | "catch_up" | "rejoin";

/**
 * The Welcome currency verdict (W2-M2).
 *
 * Native `process_welcome` accepts a Welcome for ANY outstanding intent on the
 * group id, sealed to ANY held KeyPackage. A Welcome that was never processed
 * and drains late (a WS reconnect while a fresh intent is out) is adopted at
 * a stale epoch, and nothing turned that red: the device went green at an
 * epoch the group had already left. The session now asks the DS for the
 * commits after the Welcome's epoch before enrolment counts, and this decides
 * what the answer means.
 *
 * Rules, in order:
 * 1. any non-finite input → `"rejoin"`;
 * 2. `currentEpoch < welcomeEpoch` → `"rejoin"` (the DS has never seen that
 *    epoch: the Welcome is not from this group's history);
 * 3. `lag = currentEpoch − welcomeEpoch`; `lag === 0` with no commits →
 *    `"current"`;
 * 4. `lag >= lagLimit` → `"rejoin"` (too far behind to replay);
 * 5. exactly `lag` commits, contiguous from `welcomeEpoch + 1` →
 *    `"catch_up"`;
 * 6. anything else (a gap, a duplicate, a short or long page, commits with
 *    `lag === 0`) → `"rejoin"`.
 *
 * Fail-closed direction: only an exact match reaches `"current"` or
 * `"catch_up"`, and `"catch_up"` is not itself a green — the session still
 * requires the final native `callState` to report self present at
 * `currentEpoch`. Every unrecognized shape rejoins, which holds the gate.
 */
export function welcomeCurrencyVerdict(i: {
  welcomeEpoch: number;
  currentEpoch: number;
  commits: readonly { epoch: number }[];
  lagLimit: number;
}): WelcomeCurrency {
  const { welcomeEpoch, currentEpoch, commits, lagLimit } = i;
  if (
    !Number.isFinite(welcomeEpoch) ||
    !Number.isFinite(currentEpoch) ||
    !Number.isFinite(lagLimit) ||
    commits.some((commit) => !Number.isFinite(commit.epoch))
  ) {
    return "rejoin";
  }
  if (currentEpoch < welcomeEpoch) return "rejoin";

  const lag = currentEpoch - welcomeEpoch;
  if (lag === 0 && commits.length === 0) return "current";
  if (lag >= lagLimit) return "rejoin";

  if (
    commits.length === lag &&
    commits.every((commit, index) => commit.epoch === welcomeEpoch + 1 + index)
  ) {
    return "catch_up";
  }
  return "rejoin";
}

/**
 * The waits before each retry of a Welcome currency check whose fetch failed
 * `"transient"` (LDP-M5), all inside the check's own deadline. Exhausting
 * them latches LOUD — never a rejoin, which would add DS load
 * (intent + claim + commits) to a DS that is already failing.
 */
export const WELCOME_CURRENCY_BACKOFF_MS: readonly number[] = [
  1_000, 2_000, 4_000,
];
