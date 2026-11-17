/**
 * Answer policy for a ringing call (a sibling of `outgoingRingPolicy` and
 * `joinRefusalPolicy`, pure so it is unit-testable in isolation).
 *
 * Why this exists. Three places can press Answer on a ringing call: the
 * in-app popup, a keybind and the Android call notification. Each one used
 * to start the join by itself, so a rule added to one was missing from the
 * other two. This module is the one decision they share: given the channel
 * that is ringing and the state of the device at the moment of the press,
 * what should Answer do.
 *
 * Only "connect" may lead to a join. Every other verdict means this press
 * starts no join:
 *
 *  - "blocked_slim": the channel belongs to a server and Slim view is on.
 *    Slim view has no servers, so there is no screen that could show the
 *    call.
 *  - "not_a_call": the channel is not a direct message or a group. Only
 *    those two ring anybody (the same pair `isRingableChannelType` names for
 *    the ringing side), so an Answer for anything else has nothing to
 *    answer.
 *  - "unlock_first": the phone is locked. The join waits until the device is
 *    unlocked, because a call is set up with keys from a store that is
 *    closed while the lock screen is up, and no choice about how a call is
 *    protected may be offered on a lock screen.
 *
 * The rules are checked in that order, and the lock is checked last on
 * purpose: a press that will never join must not ask the user to unlock the
 * phone for nothing.
 *
 * `isCallEnded` is the other half of answering: by the time the join reaches
 * the server the caller may have given up, and the server says so with a
 * `CallEnded` error. That is the ring being over, not a failed call.
 *
 * `driveAnswer` is the whole press, from the lock query to the join. The
 * order of its steps is itself a rule (ask the lock, decide, unlock, ask and
 * decide again, join, then take the ring down), so it lives here with every
 * effect passed in, where the order can be tested, and not inside the code
 * that owns the phone and the call.
 */

import { apiErrorType } from "../client/apiErrorType.ts";

/** What pressing Answer should do. Only "connect" may lead to a join. */
export type AnswerDecision =
  | "connect"
  | "unlock_first"
  | "blocked_slim"
  | "not_a_call";

/**
 * What pressing Answer should do. `locked` is the phone's lock state asked at
 * the moment of the press (never a remembered value).
 *
 * `serverId` counts as present when it is a non-empty string, the same test
 * stoat.js uses for a channel's path. `locked` counts as locked unless it is
 * exactly `false`: a lock state that could not be read must not be taken as
 * an unlocked phone.
 */
export function answerDecision(input: {
  channelType: string;
  serverId?: string;
  slim: boolean;
  locked: boolean;
}): AnswerDecision {
  if (input.serverId && input.slim) return "blocked_slim";

  if (input.channelType !== "DirectMessage" && input.channelType !== "Group") {
    return "not_a_call";
  }

  if (input.locked !== false) return "unlock_first";

  return "connect";
}

/**
 * Whether a rejected join is the server saying the ring is over
 * (`{ type: "CallEnded" }`).
 *
 * stoat.js rejects with the raw response body as a string, so both the JSON
 * text and an already-parsed body are read. Anything else (a network error,
 * a proxy's HTML page, another error type) is not the ring ending.
 */
export function isCallEnded(error: unknown): boolean {
  return apiErrorType(error) === "CallEnded";
}

/**
 * How one press of Answer ended.
 *
 *  - "joined": the join connected and the ring was taken down.
 *  - "ended": the server said the ring was already over. The ring was taken
 *    down.
 *  - "unlock_cancelled": the phone was locked and is still locked. The ring
 *    is left as it is, so Answer can be pressed again.
 *  - "blocked": the verdict was "blocked_slim" or "not_a_call". Nothing was
 *    started.
 *  - "failed": the join did not connect for any other reason. The ring is
 *    left as it is, because the call may still be there to answer.
 */
export type AnswerResult =
  | "joined"
  | "ended"
  | "unlock_cancelled"
  | "blocked"
  | "failed";

/**
 * The lock state to decide on. Anything but a plain `false` counts as locked,
 * and so does a lock query that fails: a lock screen that could not be read
 * must not be taken as an unlocked phone.
 */
async function lockedNow(fx: {
  isLocked(): Promise<boolean>;
}): Promise<boolean> {
  try {
    return (await fx.isLocked()) !== false;
  } catch {
    return true;
  }
}

/**
 * Asks the system to unlock the phone. Only a plain `true` counts as
 * unlocked, so a cancelled, failed or unreadable unlock is no unlock.
 */
async function unlockedNow(fx: {
  ensureUnlocked(): Promise<boolean>;
}): Promise<boolean> {
  try {
    return (await fx.ensureUnlocked()) === true;
  } catch {
    return false;
  }
}

/**
 * Runs an effect whose failure must not change how the press ended. By the
 * time one of these runs the join has already connected or been refused, and
 * a throw from the code that takes the ring down cannot undo that.
 */
function quietly(effect: () => void): void {
  try {
    effect();
  } catch {
    // The result of the press is already settled.
  }
}

/**
 * Runs one press of Answer, from the lock query to the join, and says how it
 * ended. Every effect is passed in, so the sequence can be tested without a
 * phone, a call or a server.
 *
 * The sequence:
 *
 *  1. Ask the lock and decide. "blocked_slim" and "not_a_call" end the press
 *     as "blocked" and nothing else runs.
 *  2. On "unlock_first", ask the system to unlock, once. If that does not
 *     leave the phone unlocked the press ends as "unlock_cancelled". After an
 *     unlock the lock is asked again and decided again, because the unlock's
 *     own answer is not the lock state: the phone can lock again, and the
 *     facts behind the verdict can change, while the unlock screen is up.
 *     Only a fresh "connect" goes on. A phone that is still locked ends the
 *     press as "unlock_cancelled", and the unlock is not asked for twice.
 *  3. On "connect", start the join in the same turn as the verdict. Nothing
 *     is awaited in between, so nothing the verdict was based on can change
 *     before the join starts.
 *  4. A join that connected takes the ring down as "answered". A join the
 *     server refused with `CallEnded` reports the ring as over and takes it
 *     down as "ended". Every other outcome is "failed".
 *
 * The ring is never taken down before the join has connected. Until then the
 * ring is the only way back to the call, so every result but "joined" and
 * "ended" leaves it up.
 *
 * The returned promise never rejects. A `decide` that throws ends the press
 * as "failed" with no join, and a throw from `onEnded` or `dismiss` does not
 * change the result.
 */
export async function driveAnswer(fx: {
  /**
   * Whether the phone's lock screen is up right now. The caller supplies a
   * function that already answers false on platforms without a lock screen,
   * and true when an Android query fails.
   */
  isLocked(): Promise<boolean>;
  /** `answerDecision` with the channel and Slim facts already bound. */
  decide(locked: boolean): AnswerDecision;
  /**
   * Ask the system to unlock. True only when the device is unlocked
   * afterwards.
   */
  ensureUnlocked(): Promise<boolean>;
  /**
   * The join itself. Resolves true when connected, false when the store
   * refused or was superseded, rejects with the server's refusal.
   */
  connect(): Promise<boolean>;
  /** The ring was already over when we answered. */
  onEnded(): void;
  /** Take the ring down. */
  dismiss(reason: "answered" | "ended"): void;
}): Promise<AnswerResult> {
  try {
    let verdict = fx.decide(await lockedNow(fx));

    if (verdict === "unlock_first") {
      if (!(await unlockedNow(fx))) return "unlock_cancelled";

      // The unlock saying it worked is not the lock state. Ask and decide
      // again, and go on only if the fresh verdict says so.
      verdict = fx.decide(await lockedNow(fx));
      if (verdict === "unlock_first") return "unlock_cancelled";
    }

    if (verdict !== "connect") return "blocked";
  } catch {
    // The lock query and the unlock catch their own failures, so only
    // `decide` can throw here. Without a verdict there is no join.
    return "failed";
  }

  // The verdict is "connect" and the join starts now, in the same turn.
  // Nothing may be awaited between the verdict above and this call.
  let connected: boolean;
  try {
    connected = (await fx.connect()) === true;
  } catch (error) {
    let ended = false;
    try {
      ended = isCallEnded(error);
    } catch {
      // A refusal that cannot even be read is not the ring ending.
    }
    if (!ended) return "failed";

    quietly(() => fx.onEnded());
    quietly(() => fx.dismiss("ended"));
    return "ended";
  }

  if (!connected) return "failed";

  quietly(() => fx.dismiss("answered"));
  return "joined";
}
