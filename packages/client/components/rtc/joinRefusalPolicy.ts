/**
 * Join-refusal policy for `Voice.connect()` (a sibling of `outgoingRingPolicy`
 * — PURE so it is unit-testable in isolation).
 *
 * WHY THIS EXISTS. 2026-09-06, Windows shell 0.57.0: a fresh group DM whose
 * owner had not turned calling on answered every
 * `POST /channels/<id>/join_call` with 400 `NotAVoiceChannel`. The join path
 * had no notion of a refusal that a retry cannot change — the rejection
 * reached the caller as an unhandled promise (no dialog), the header call
 * buttons vanished for the ~200 ms the attempt lived (CONNECTING hides them
 * behind the call card) and came straight back, so every press looked like
 * nothing had happened, and the console filled with dozens of identical
 * attempts, one per press. No code path re-drives a failed join (every
 * caller is a user action); the amplifier was the silent failure plus an
 * affordance that re-rendered as if untouched. The first attempt also tore
 * down the call the user was already in, because `connect()` leaves the
 * current call before it asks the server anything.
 *
 * This module is the decision shared by every join affordance and by
 * `connect()` itself:
 *
 *  - `classifyJoinRefusal` — which `join_call` answers are TERMINAL: the
 *    server's verdict for this user + channel is fixed until the channel's
 *    configuration or roster changes (owner opt-in, permissions, capacity).
 *    Everything else (network, the SFU token expiring, LiveKit unreachable)
 *    is left alone: a fresh press is the retry, as before.
 *  - `joinBlockedReason` — whether a new attempt for a channel should even
 *    start: not while one is already in flight for it, and not while a
 *    terminal refusal for it still holds.
 *  - `refusalHolds` — a latch releases on any update to the channel (the
 *    version bumps on `channelUpdate` / `voiceChannelLeave`, the events that
 *    can change the server's answer) or after `JOIN_REFUSAL_HOLD_MS`, the
 *    safety net for a missed event — a stale latch must never brick calling
 *    for a channel.
 */

/**
 * `join_call` error types (delta `routes/channels/voice_join.rs`) whose answer
 * a retry cannot change. NOT here on purpose: `LiveKitUnavailable` (a server
 * outage, not a verdict about this channel) and everything the route does not
 * produce itself — session/device errors, the SFU's own connect failures.
 */
export type JoinRefusalReason =
  | "NotAVoiceChannel"
  | "MissingPermission"
  | "CannotJoinCall"
  | "IsBot"
  | "FailedValidation"
  | "UnknownNode";

const TERMINAL_JOIN_REFUSALS: ReadonlySet<string> = new Set<JoinRefusalReason>([
  "NotAVoiceChannel",
  "MissingPermission",
  "CannotJoinCall",
  "IsBot",
  "FailedValidation",
  "UnknownNode",
]);

/**
 * Classify a rejection from `Channel.joinCall`. stoat.js rejects with the raw
 * API error body (`{ type, ... }`); anything else — a network `TypeError`, a
 * LiveKit error, nothing at all — is not a refusal.
 */
export function classifyJoinRefusal(
  error: unknown,
): JoinRefusalReason | undefined {
  const type = (error as { type?: unknown } | null | undefined)?.type;
  return typeof type === "string" && TERMINAL_JOIN_REFUSALS.has(type)
    ? (type as JoinRefusalReason)
    : undefined;
}

/**
 * How long a terminal refusal keeps a channel's join affordances inert when
 * no channel event releases it first. Long enough that no storm is possible,
 * short enough that a missed `channelUpdate` costs the user one wait.
 */
export const JOIN_REFUSAL_HOLD_MS = 30_000;

/** A terminal refusal the server gave for one channel. */
export interface JoinRefusalLatch {
  channelId: string;
  reason: JoinRefusalReason;
  /** `Date.now()` when the server answered. */
  at: number;
  /**
   * The channel's update version when it answered — any later update to the
   * channel (config, roster) releases the latch, see `refusalHolds`.
   */
  channelVersion: number;
}

/**
 * Whether a latch still applies: same channel version and inside the hold.
 * `now - at >= JOIN_REFUSAL_HOLD_MS` releases, so a hold of exactly the
 * constant is over (the store's release timer fires at that instant).
 */
export function refusalHolds(
  latch: JoinRefusalLatch,
  current: { now: number; channelVersion: number },
): boolean {
  if (current.channelVersion !== latch.channelVersion) return false;
  return current.now - latch.at < JOIN_REFUSAL_HOLD_MS;
}

/**
 * Why a new join attempt for a channel must not start right now.
 *  - "in-flight": a `connect()` for THIS channel has started and not settled.
 *    A second press must not restart it (the restart is what made every
 *    press look like a retry). A join in flight for ANOTHER channel does not
 *    block: switching channels mid-join is supersession by design.
 *  - "refused": the server's last answer for this channel was terminal and
 *    still holds.
 */
export type JoinBlockedReason = "in-flight" | "refused";

export function joinBlockedReason(input: {
  channelId: string;
  now: number;
  channelVersion: number;
  /** Channel id of a `connect()` that has started and not settled, if any. */
  inFlightChannelId: string | undefined;
  /** The latch recorded for THIS channel, if any. */
  latch: JoinRefusalLatch | undefined;
}): JoinBlockedReason | undefined {
  if (input.inFlightChannelId === input.channelId) return "in-flight";
  if (
    input.latch &&
    input.latch.channelId === input.channelId &&
    refusalHolds(input.latch, input)
  )
    return "refused";
  return undefined;
}
