/**
 * Outgoing-ring decision for DM/Group calls (a sibling of `mlsAdmitPolicy` —
 * PURE so it is unit-testable in isolation). It also holds the caller's
 * decision to hang up a direct-message call that nobody answered, and the
 * answerer's decision to leave a call that the caller has already left.
 *
 * WHY THIS EXISTS. The sound controller has synthesized BOTH ringtone legs
 * since ringtones shipped, and the outgoing leg was even user-configurable in
 * Settings → Notifications — but nothing ever called
 * `playSound("ringtoneOutgoing")` outside that settings preview. The caller
 * sat in silence with no feedback that peers were being rung, while the
 * callee's side rang normally. This module is the missing decision: given a
 * voice-channel membership event, should the OUTGOING ring start, stop, or be
 * left alone.
 *
 * Model. There is no separate "ringing" signalling: starting a call IS
 * joining the empty voice channel of a DM/Group, and peers ring off the
 * resulting `VoiceChannelJoin` fan-out (`NotificationsWorker`). So the
 * outgoing-ring state is fully derivable from the same events:
 *
 * - OUR join that OPENS the call (we are the sole participant) — we are the
 *   caller, waiting: ring.
 * - Our join made by pressing Answer never rings, whatever the roster looks
 *   like. If the caller left between the press and the join we end up alone
 *   in the call, but we are still the one who answered, and there is nobody
 *   for us to ring: stop.
 * - Any remote join while we are a participant — the callee answered (or a
 *   later group member joined an ongoing call, where stopping is a no-op):
 *   stop.
 * - OUR join into an already-populated call — we are the answerer, not the
 *   caller: stop (this also kills the INCOMING ring, as before).
 * - OUR leave — we hung up before anyone answered: stop. (The local
 *   `disconnect()` path stops the ring synchronously as well; this event
 *   covers server-driven removals, e.g. being kicked from the call.)
 *
 * How ringing ends when nobody picks up. In a direct message the client
 * receives a declined event for the call's channel when the callee declines,
 * and a ring that has run its full length without an answer is over as well.
 * `callerRingOutcome` turns those two facts into a decision to hang up. It
 * holds no timer and reads no clock: whoever owns the call passes in how long
 * the ring has run and how long it may run. It answers a hang-up only for a
 * call this device opened itself, and only when every fact it is given is
 * exactly the expected value. A group call is never ended this way, because
 * one member declining or not answering says nothing about the others. There
 * the outgoing ring still ends at the synthesized ringtone's natural stop
 * (30 rings, about 45 s).
 *
 * The answering side has the opposite problem. Someone who presses Answer
 * just as the caller hangs up joins an empty call that rings nobody.
 * `answererAloneOutcome` decides when that person is taken out of it.
 *
 * The inputs describe the channel state AFTER the event was applied:
 * stoat.js mutates `voiceParticipants` before emitting, so on a join the
 * joiner is already counted, and on a leave the leaver is already gone.
 */

/** What the sound controller should do with the outgoing ring. */
export type OutgoingRingAction = "play" | "stop" | "none";

/**
 * Only DM and Group calls ring anybody — joining a server voice channel
 * summons no one, so it plays no outgoing ring (mirroring the incoming
 * side's gate).
 */
export function isRingableChannelType(channelType: string): boolean {
  return channelType === "DirectMessage" || channelType === "Group";
}

/**
 * Decide the outgoing-ring action for a `voiceChannelJoin` event.
 *
 * `participantCount` and `selfIsParticipant` reflect the roster WITH the
 * joiner already in it (see module doc). "We joined and the call has exactly
 * one participant" therefore means we opened the call — the only case that
 * rings. Whether the ring is actually audible stays the sound controller's
 * business (`canPlay` honors the user's "Outgoing Call Ringtone" toggle).
 *
 * The one exception is a join we made by pressing Answer. That join can
 * leave us as the only participant when the caller hangs up at the same
 * moment, and it must not be mistaken for opening a call, so it always
 * answers "stop".
 *
 * Note the asymmetry with the incoming leg: incoming is suppressed on native
 * platforms because the Android call notification already rings, but there
 * is no native ringer for the outgoing leg, so "play" applies on every
 * platform.
 */
export function outgoingRingOnVoiceJoin(input: {
  channelType: string;
  joinerIsSelf: boolean;
  /** Whether WE are in the call, after the join was applied. */
  selfIsParticipant: boolean;
  /** Roster size after the join was applied (>= 1 by construction). */
  participantCount: number;
  /**
   * Whether our own join was made by pressing Answer. It is only read when
   * the joiner is us.
   */
  joinedAsAnswer: boolean;
}): OutgoingRingAction {
  if (!isRingableChannelType(input.channelType)) return "none";

  if (input.joinerIsSelf) {
    // We pressed Answer. Even when the caller has already left and we are
    // alone, we are not ringing anybody, so the outgoing ring must not start.
    if (input.joinedAsAnswer) return "stop";

    // Sole participant: our join opened the call, so we are ringing peers.
    // Anything else: we answered (or rejoined) an ongoing call — make sure
    // no ring (incoming OR a stale outgoing) survives into it.
    return input.participantCount === 1 ? "play" : "stop";
  }

  // A remote join is only our business while we are in the call — that is
  // the callee answering (or a later group joiner, where stop is a no-op).
  // Otherwise it is the INCOMING side's event, not ours.
  return input.selfIsParticipant ? "stop" : "none";
}

/**
 * Decide the outgoing-ring action for a `voiceChannelLeave` event.
 *
 * Only OUR OWN leave stops the ring here: it is the caller cancelling (or
 * being removed). A remote leave never affects the outgoing ring — while we
 * ring we are the sole participant, so there is no remote to leave; and the
 * incoming side's own "caller gave up" stop (roster emptied) already lives
 * in `NotificationsWorker`.
 */
export function outgoingRingOnVoiceLeave(input: {
  channelType: string;
  leaverIsSelf: boolean;
}): OutgoingRingAction {
  if (!isRingableChannelType(input.channelType)) return "none";
  return input.leaverIsSelf ? "stop" : "none";
}

/**
 * Whether a value is a finite number. The time inputs below are typed as
 * numbers, but a value that was never set arrives as undefined at run time,
 * and a subtraction with one side missing gives NaN.
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * How much longer than the ring length the caller's own timer waits before
 * it hangs up. An Answer pressed in the last second of the ring still has to
 * unlock the phone and join, and that join has to arrive before the caller
 * gives up. `callerRingOutcome` does not add this itself: whoever owns the
 * call passes a `ringMs` that already includes it.
 */
export const CALLER_HANGUP_GRACE_MS = 10_000;

/**
 * What the caller's side should do about a call it may still be ringing:
 * hang up because nobody answered, hang up because the callee declined, keep
 * waiting, or nothing at all because there is no ring of ours to end.
 */
export type CallerRingOutcome =
  | "hangup_no_answer"
  | "hangup_declined"
  | "wait"
  | "none";

/**
 * Decide whether the caller should give up on a call nobody has answered.
 *
 * The answer is a hang-up only for a direct-message call that this device
 * opened itself, that we did not join by answering, that nobody else has
 * ever joined, and that we are not in the middle of rejoining automatically.
 * In every other case it is "none".
 *
 * Every fact has to be exactly the expected value. A flag that is missing or
 * is not a boolean is never read as false, and a time that is missing or out
 * of range is never compared, so a bad value answers "none" and the call is
 * left alone. Ending a call that somebody answered is the worse mistake, so
 * every doubt is settled that way.
 *
 * The rules are checked in this order, and the order matters:
 *
 * 1. The channel type is not exactly "DirectMessage": "none". A group call
 *    never hangs up by itself.
 * 2. `openedCall` is not exactly true: "none". The remaining facts cannot
 *    tell a ringing caller from a device that never rang anyone. When an
 *    answered call drops on both sides and both rejoin, each side holds a
 *    fresh call that was not joined by answering, has nobody else in it yet
 *    and is no longer rejoining once it connects.
 * 3. `joinedAsAnswer`, `remoteEverJoined` or `rejoining` is not exactly
 *    false: "none". This is checked before the decline so that a decline
 *    arriving late can never end a call that was answered.
 * 4. `ringMs` is not a finite number above 0, or `elapsedMs` is not a finite
 *    number of at least 0: "none". This is checked before the decline too,
 *    so a decline is acted on only when both times are sound.
 * 5. `declined` is exactly true: "hangup_declined", at once and without
 *    waiting for the ring length.
 * 6. The ring has run its full length (`elapsedMs >= ringMs`):
 *    "hangup_no_answer".
 * 7. Otherwise "wait": keep ringing and ask again later.
 */
export function callerRingOutcome(input: {
  channelType: string;
  /**
   * Whether this device itself started this call. It is true only for a join
   * the user started, that was not an Answer, in a direct message that had
   * nobody else in it when the join connected. Whoever owns the call decides
   * this once, when the call connects, and never from the other inputs.
   */
  openedCall: boolean;
  /** Whether we joined this call by pressing Answer. */
  joinedAsAnswer: boolean;
  /** Whether anyone other than us has been in this call at any point. */
  remoteEverJoined: boolean;
  /** Whether we are in the middle of an automatic rejoin. */
  rejoining: boolean;
  /** How long the ring has run, in milliseconds. At least 0. */
  elapsedMs: number;
  /**
   * How long the caller waits before giving up, in milliseconds. Above 0.
   * This is the ring length with `CALLER_HANGUP_GRACE_MS` already added by
   * whoever passes it. Nothing is added to it here.
   */
  ringMs: number;
  /** Whether the callee declined the call. */
  declined: boolean;
}): CallerRingOutcome {
  if (input.channelType !== "DirectMessage") return "none";

  if (input.openedCall !== true) return "none";

  if (input.joinedAsAnswer !== false) return "none";
  if (input.remoteEverJoined !== false) return "none";
  if (input.rejoining !== false) return "none";

  if (!isFiniteNumber(input.ringMs) || input.ringMs <= 0) return "none";
  if (!isFiniteNumber(input.elapsedMs) || input.elapsedMs < 0) return "none";

  if (input.declined === true) return "hangup_declined";

  return input.elapsedMs >= input.ringMs ? "hangup_no_answer" : "wait";
}

/**
 * How long someone who joined by pressing Answer may be alone in the call
 * before they are taken out of it. The wait is there because the other side
 * can take a moment to show up after our own join connects.
 */
export const ANSWER_ALONE_GRACE_MS = 8_000;

/**
 * What the answering side should do about a call it may be alone in: leave
 * because the call is over, keep waiting, or nothing at all.
 */
export type AnswererAloneOutcome = "hangup_ended" | "wait" | "none";

/**
 * Decide whether someone who answered a call should leave it because nobody
 * else is there.
 *
 * When the caller hangs up between the Answer press and the join, the
 * answerer lands in an empty call. No ring goes out from it, so nobody will
 * ever join, and without this the answerer would sit in it until they hang
 * up by hand.
 *
 * As in `callerRingOutcome`, every fact has to be exactly the expected
 * value, and a missing or malformed one answers "none":
 *
 * 1. `joinedAsAnswer` is not exactly true: "none". Only a join made by
 *    pressing Answer is ended this way. A caller alone in a call is ringing.
 * 2. `remoteEverJoined` is not exactly false: "none". Once anyone else has
 *    been in the call it is a real call, and being alone later is not this
 *    case.
 * 3. `elapsedMs` is not a finite number of at least 0: "none".
 * 4. `elapsedMs >= ANSWER_ALONE_GRACE_MS`: "hangup_ended".
 * 5. Otherwise "wait": stay in the call and ask again later.
 */
export function answererAloneOutcome(input: {
  /** Whether we joined this call by pressing Answer. */
  joinedAsAnswer: boolean;
  /** Whether anyone other than us has been in this call at any point. */
  remoteEverJoined: boolean;
  /** Milliseconds since this call reached connected. At least 0. */
  elapsedMs: number;
}): AnswererAloneOutcome {
  if (input.joinedAsAnswer !== true) return "none";
  if (input.remoteEverJoined !== false) return "none";

  if (!isFiniteNumber(input.elapsedMs) || input.elapsedMs < 0) return "none";

  return input.elapsedMs >= ANSWER_ALONE_GRACE_MS ? "hangup_ended" : "wait";
}
