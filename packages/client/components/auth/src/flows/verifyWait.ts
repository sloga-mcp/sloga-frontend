/**
 * Waiting for a new account's email to be confirmed, inside a native shell.
 *
 * The confirmation link in the email opens in the system browser, which the
 * shell cannot see. So while the "Check your mail" step is showing, the shell
 * retries the sign-in with the email and password the person just registered
 * with: the server answers `UnverifiedAccount` until the link is opened, and
 * a session after that.
 *
 * Pure on purpose, so `node --test` can load it (`verifyWait.test.ts`);
 * `FlowCheck.tsx` supplies the sign-in call, the clock and the timers.
 */
import { apiErrorType } from "../../../client/apiErrorType.ts";

/** Gap between checks while the wait is young */
export const VERIFY_WAIT_FAST_MS = 5000;

/** How long the wait counts as young */
export const VERIFY_WAIT_FAST_PHASE_MS = 2 * 60_000;

/** Gap between checks after that */
export const VERIFY_WAIT_SLOW_MS = 15_000;

/**
 * When the timed checks end. Coming back to the app still checks after this,
 * for as long as the step is showing.
 */
export const VERIFY_WAIT_TIMEOUT_MS = 15 * 60_000;

/**
 * Shortest gap between two checks, whatever asks for them. Each check costs
 * the server a password hash, and the `auth` bucket allows 15 requests per
 * 10 s for the whole device.
 */
export const VERIFY_WAIT_MIN_GAP_MS = 3000;

/**
 * Delay before the next timed check.
 * @param elapsedMs Time since the wait started
 * @returns The delay, or undefined once the timed checks have ended
 */
export function nextCheckDelay(elapsedMs: number): number | undefined {
  if (elapsedMs >= VERIFY_WAIT_TIMEOUT_MS) return undefined;
  return elapsedMs < VERIFY_WAIT_FAST_PHASE_MS
    ? VERIFY_WAIT_FAST_MS
    : VERIFY_WAIT_SLOW_MS;
}

/**
 * What a failed check means for the wait:
 * - `pending`: the email is not confirmed yet, keep waiting;
 * - `retry`: nothing was learned (offline, rate limited, a proxy error page),
 *   keep waiting;
 * - `stop`: the server refused these credentials for another reason (a wrong
 *   password because the email already had an account, that account asking
 *   for MFA, a lockout, a disabled account). Trying again cannot help and
 *   would count against the account,
 *   so the wait ends and the person signs in by hand.
 */
export type CheckFailure = "pending" | "retry" | "stop";

/**
 * Classify the error a failed check threw.
 * @param error Thrown value
 */
export function classifyCheckFailure(error: unknown): CheckFailure {
  const type = apiErrorType(error);
  if (type === "UnverifiedAccount") return "pending";
  return type === undefined ? "retry" : "stop";
}

/** What {@link createVerifyWait} needs from its host */
export interface VerifyWaitDeps {
  /** Try to sign in: resolves once signed in, throws the API error if not */
  attempt: () => Promise<void>;
  /** Called once, after a check signed the person in */
  onSignedIn: () => void;
  /** Called once, when a refusal ended the wait without a sign-in */
  onGaveUp: () => void;
  /** Current time, epoch ms */
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

/** Handle returned by {@link createVerifyWait} */
export interface VerifyWait {
  /** Begin the timed checks. The first one runs after the first delay. */
  start(): void;
  /** Check now (the app came back to the foreground), gap permitting */
  poke(): void;
  /**
   * End the wait. A check already in flight is not cancelled (if it signs
   * in, the app is signed in), but it no longer calls `onSignedIn`.
   */
  stop(): void;
}

/**
 * The wait itself: timed checks that slow down and then end, plus checks on
 * demand, never two at once and never closer than the minimum gap.
 */
export function createVerifyWait(deps: VerifyWaitDeps): VerifyWait {
  let startedAt: number | undefined;
  let stopped = false;
  let inFlight = false;
  let lastCheckEndedAt: number | undefined;
  let timer: unknown;

  function schedule() {
    if (stopped || startedAt === undefined) return;
    const delay = nextCheckDelay(deps.now() - startedAt);
    if (delay === undefined) return;
    timer = deps.setTimer(() => {
      timer = undefined;
      void check();
    }, delay);
  }

  async function check() {
    if (stopped || inFlight || startedAt === undefined) return;

    inFlight = true;
    if (timer !== undefined) {
      deps.clearTimer(timer);
      timer = undefined;
    }

    let failure: CheckFailure | undefined;
    try {
      await deps.attempt();
    } catch (error) {
      failure = classifyCheckFailure(error);
    }

    inFlight = false;
    lastCheckEndedAt = deps.now();
    if (stopped) return;

    if (failure === undefined) {
      stopped = true;
      deps.onSignedIn();
    } else if (failure === "stop") {
      stopped = true;
      deps.onGaveUp();
    } else {
      schedule();
    }
  }

  return {
    start() {
      if (stopped || startedAt !== undefined) return;
      startedAt = deps.now();
      schedule();
    },
    poke() {
      if (
        lastCheckEndedAt !== undefined &&
        deps.now() - lastCheckEndedAt < VERIFY_WAIT_MIN_GAP_MS
      ) {
        return;
      }
      void check();
    },
    stop() {
      stopped = true;
      if (timer !== undefined) {
        deps.clearTimer(timer);
        timer = undefined;
      }
    },
  };
}
