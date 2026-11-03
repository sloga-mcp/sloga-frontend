/**
 * Gate (d)'s listener — the pure core of the E2EE worker's decode witness,
 * split out of `state.tsx` for the house reason: that module pulls in Solid,
 * LiveKit and the Tauri bridge and cannot be loaded by `node --test`, so
 * anything worth pinning with a spec has to live here (same rule as
 * `mlsRosterPolicy` / `mlsCallModePolicy` / `mlsAdmitGracePolicy`).
 *
 * 🔴 Why it was split. A `media-e2ee-reviewer` round found that `state.tsx`
 * has no spec at all, so the listener, the staleness path and the signal's
 * initial value were unmutated: flipping the witness signal's initial value to
 * an AVAILABLE one restored green-by-default — the exact posture gate (d)
 * exists to remove — with every spec still green and every mutation still red.
 * An evidence system that cannot reach the fix is not evidence. Everything
 * here is therefore reachable from `decodeWitnessListener.test.ts` and covered
 * by `scripts/rtc-mutations.py`; `state.tsx` keeps only the wiring that has to
 * touch a `Worker` and a Solid setter.
 *
 * What the worker posts: the patched livekit worker sends `slogaDecodeWitness`
 * once a second, whether or not it has anything to report, naming per sender
 * the key indexes frames ARRIVED at and how many it threw away for an index it
 * had marked invalid. We attach with `addEventListener`, so livekit's own
 * `worker.onmessage` handler keeps running untouched; the worker ignores
 * message kinds it does not know, and we ignore its.
 *
 * 🔴 The heartbeat is the point. `available` goes false as soon as one stops
 * arriving, and the chip reads that as amber. A build that lost the pnpm
 * patch, a worker that died, a listener that was never armed — each of them
 * silences the witness, and each must degrade the chip rather than quietly
 * remove the gate. That is the whole inversion: gates (a)-(c) all read objects
 * whose ABSENCE means "fine", which is how a destroyed or never-created
 * verdict read green through every one of them.
 *
 * 🔴 Amber is not enough on iOS, and that is what `onDead` is for. Spike S3
 * killed the e2ee worker mid-call on WebKit: the device stopped sending and
 * stopped decoding, so it failed CLOSED — but SILENTLY. The only trace was
 * this heartbeat stopping, and amber is a chip the user can read as "probably
 * fine". A worker that is gone for the rest of the call is a call the user
 * believes is encrypted and is not getting media from, so it has to become
 * loud. `onDead` is the loud hook (R7): it fires ONCE per listener when the
 * heartbeat has been silent for {@link DECODE_WITNESS_DEAD_MS}, or when a
 * heartbeat says its worker has no `RTCTransformEvent` (the `rte` field —
 * a worker that cannot transform is not protecting anything, whatever else it
 * reports). Without `onDead` the listener behaves exactly as it did before
 * the hook existed; Chromium keeps the amber.
 *
 * 🔴 Silence is judged at TWO ticks, never one. iOS throttles the page's main
 * thread (S2: one heartbeat per two seconds while hidden) and may freeze it
 * outright. When a stalled thread resumes, its queued interval callbacks and
 * queued worker messages are delivered in a burst, and the event loop does
 * not promise the timers run after the messages. A single late tick therefore
 * reads a worker as dead whose next heartbeat is already sitting in the queue
 * behind it. So a dead verdict needs two consecutive ticks that both saw the
 * silence AND are at least half a sweep apart in `now()` — two callbacks
 * fired back to back out of a burst are one observation, not two — and a
 * heartbeat landing between them breaks the pair.
 *
 * 🔴 ONE-WAY. This may withhold a green. It never resolves a hold, cancels an
 * escalation, clears a latch or promotes anything. `onDead` only ever moves a
 * call LOUDER, and nothing here takes it back: a heartbeat after it still
 * feeds the chip, but the dead verdict stands.
 */

import {
  type DecodeIndexTally,
  type DecodeWitness,
  type DecodeWitnessSample,
  DECODE_WITNESS_UNAVAILABLE,
  summarizeDecodeWitness,
} from "./mlsCallModePolicy.ts";

/** The one message kind this listener answers to. */
export const DECODE_WITNESS_KIND = "slogaDecodeWitness";

/**
 * How often the staleness threshold is CHECKED. Polling at the threshold
 * instead would make detection latency up to twice it — several seconds of
 * green over a witness that had already stopped.
 */
export const DECODE_WITNESS_CHECK_MS = 1_000;

/**
 * How long without a worker heartbeat before the decode witness is treated as
 * absent. Three of the worker's one-second posts, so a single late flush under
 * load does not flap the chip.
 */
export const DECODE_WITNESS_STALE_MS = 3 * DECODE_WITNESS_CHECK_MS;

/**
 * How long without a worker heartbeat before `onDead` may fire. Twice the
 * staleness threshold: the chip has already been amber for three seconds by
 * then, and a thread that iOS throttled to one post every two seconds (S2) is
 * still three posts short of it. The first tick to see six seconds of silence
 * lands up to a sweep after the six, and the verdict needs the next one, so a
 * dead worker reads amber for seven to eight seconds before the call goes
 * loud.
 */
export const DECODE_WITNESS_DEAD_MS = 6 * DECODE_WITNESS_CHECK_MS;

/** What a worker that CAN transform says `typeof self.RTCTransformEvent` is. */
const TRANSFORM_EVENT_TYPE = "function";

/**
 * 🔴 What the chip's witness signal MUST start at, and the reason this
 * constant is exported rather than written inline at the `createSignal` call:
 * a call that never arms the witness — no patched worker, no session, an early
 * throw between construction and `#armDecodeWitness` — has to read AMBER, not
 * green. Inline at the call site it lived in a file no spec can load, and a
 * one-word edit there silently restored green-by-default. Here it is pinned by
 * `decodeWitnessListener.test.ts` and mutated by `rtc-mutations.py`.
 */
export const DECODE_WITNESS_INITIAL: DecodeWitness = DECODE_WITNESS_UNAVAILABLE;

/**
 * Whether two witnesses SAY the same thing — the signal's equality.
 *
 * 🔴 It lives here, not inline at the `createSignal` call, because Solid skips
 * the write ENTIRELY when this returns true. Simplify it to
 * `a.available === b.available` — a plausible tidy-up — and a transition from
 * `dropping: []` to `dropping: [peer]` counts as no change: the accessor keeps
 * handing out the stale clean object and the chip stays GREEN for the rest of
 * the call while the worker discards that peer's frames. Inline in `state.tsx`
 * that was unspecced, unmutated, and asserted only up to the opening brace.
 *
 * `live` is deliberately not compared: nothing reads it, and the worker posts
 * a new object every second, so including it would defeat the whole point of
 * the comparator.
 */
export function sameWitness(a: DecodeWitness, b: DecodeWitness): boolean {
  return (
    a.available === b.available &&
    a.dropping.length === b.dropping.length &&
    a.dropping.every((id, i) => id === b.dropping[i])
  );
}

/** Just the two console levels the listener uses, so specs can observe them. */
export interface DecodeWitnessLog {
  warn(message: string): void;
  info(message: string): void;
}

export interface DecodeWitnessListenerOptions {
  /** Monotonic clock, injected so staleness is testable without timers. */
  now: () => number;
  /** Where a judged witness goes — in `state.tsx`, the Solid setter. */
  onWitness: (witness: DecodeWitness) => void;
  /**
   * The session-identity guard. A disposed session's worker can still deliver
   * a queued message after a newer call has armed its own listener, and that
   * late post must not write the new call's chip.
   *
   * Required, not defaulted: a default would be "no guard", and every defect
   * these six review rounds found was some form of a missing guard reading as
   * a pass.
   */
  isCurrentSession: () => boolean;
  staleMs?: number;
  checkMs?: number;
  log?: DecodeWitnessLog;
  /**
   * The loud hook (R7): called ONCE per listener when the worker is judged
   * dead — silent for {@link DecodeWitnessListenerOptions.deadAfterMs} at two
   * consecutive ticks, or posting a heartbeat whose `rte` is not
   * `"function"`. Absent, none of the dead-worker judgement runs and the
   * listener is exactly what it was before the hook (Chromium).
   *
   * A throw out of it is not a delivery: it is called again at the next
   * qualifying tick or heartbeat until one call returns.
   */
  onDead?: () => void;
  /** Silence before `onDead`; read only with `onDead`. Must exceed `staleMs`. */
  deadAfterMs?: number;
}

export interface DecodeWitnessListener {
  /** Feed it `MessageEvent.data`. Anything it does not recognize is ignored. */
  onMessage(data: unknown): void;
  /** Run every {@link DecodeWitnessListener.checkMs} — the staleness sweep. */
  tick(): void;
  /**
   * Teardown: the witness is gone, so the chip must stop reading it. Terminal
   * and idempotent — after it, `onMessage` and `tick` do nothing.
   */
  stop(): void;
  /** The interval the caller must run {@link DecodeWitnessListener.tick} at. */
  checkMs: number;
}

const isInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value);

const isCount = (value: unknown): value is number =>
  isInteger(value) && value >= 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Parse a worker message into a witness window, or `null` if this message is
 * not one.
 *
 * 🔴 `null` for a MALFORMED `slogaDecodeWitness`, not an empty window. The
 * listener used to coerce a missing or non-array `participants` to `[]` and
 * hand that to `summarizeDecodeWitness`, which returns `available: true` — so
 * a worker posting the right kind with the wrong shape PROMOTED the gate on
 * garbage, and a participant entry missing `indexes` threw out of the message
 * handler after the staleness clock had already been refreshed, freezing the
 * chip at whatever the last good sample said. Both are the "absence of
 * evidence means fine" read that gate (d) exists to delete, so the rule here
 * is one rule: a message either parses whole as a witness or is not a witness.
 *
 * An EMPTY `participants` array is not malformed — it is the normal quiet
 * window, and it promotes exactly as before, because the worker posts on its
 * interval whether or not any frame arrived.
 */
export function isDecodeWitnessKind(data: unknown): boolean {
  return isRecord(data) && data.kind === DECODE_WITNESS_KIND;
}

export function parseDecodeWitnessMessage(
  data: unknown,
): readonly DecodeWitnessSample[] | null {
  if (!isDecodeWitnessKind(data)) return null;
  // Narrowing only — `isDecodeWitnessKind` already established this, but its
  // `boolean` return does not carry the narrowing out. Not defense in depth.
  if (!isRecord(data)) return null;
  const body = data.data;
  if (!isRecord(body)) return null;
  const participants = body.participants;
  if (!Array.isArray(participants)) return null;

  const samples: DecodeWitnessSample[] = [];
  for (const entry of participants) {
    if (!isRecord(entry)) return null;
    const { identity, indexes } = entry;
    if (typeof identity !== "string") return null;
    if (!Array.isArray(indexes)) return null;
    const tallies: DecodeIndexTally[] = [];
    for (const tally of indexes) {
      if (!isRecord(tally)) return null;
      const { keyIndex, seen, dropped } = tally;
      // 🔴 Counts, not just numbers. `{seen: -10, dropped: -10}` used to parse
      // and summarize to available/no-drops — a CLEAN read out of garbage,
      // which is the posture this gate exists to delete. `keyIndex` is left
      // signed on purpose: the worker posts -1 for "no index on this frame".
      if (!isCount(seen)) return null;
      if (!isCount(dropped)) return null;
      if (dropped > seen) return null;
      if (!isInteger(keyIndex)) return null;
      tallies.push({ keyIndex, seen, dropped });
    }
    samples.push({ identity, indexes: tallies });
  }
  return samples;
}

/**
 * The heartbeat's `rte` — the worker's own `typeof self.RTCTransformEvent` —
 * or `undefined` when the message is not ours, or carries no `rte`, or a
 * non-string one.
 *
 * Separate from {@link parseDecodeWitnessMessage} on purpose: that one's
 * return is the chip's input and its shape is pinned, and `rte` is not a
 * decode window. `undefined` is not "fine": a worker built without the field
 * is a worker nobody checked, and with `onDead` armed it reads as one that
 * cannot transform.
 */
export function parseDecodeWitnessRte(data: unknown): string | undefined {
  if (!isDecodeWitnessKind(data)) return undefined;
  // Narrowing only, as in `parseDecodeWitnessMessage`.
  if (!isRecord(data)) return undefined;
  const body = data.data;
  if (!isRecord(body)) return undefined;
  return typeof body.rte === "string" ? body.rte : undefined;
}

/**
 * Build the listener. It owns no timer and no worker: the caller attaches
 * {@link DecodeWitnessListener.onMessage} to the worker, runs
 * {@link DecodeWitnessListener.tick} on an interval of
 * {@link DecodeWitnessListener.checkMs}, and calls
 * {@link DecodeWitnessListener.stop} when it detaches both.
 */
export function createDecodeWitnessListener(
  options: DecodeWitnessListenerOptions,
): DecodeWitnessListener {
  const {
    now,
    onWitness,
    isCurrentSession,
    staleMs = DECODE_WITNESS_STALE_MS,
    checkMs = DECODE_WITNESS_CHECK_MS,
    log = console,
    onDead,
    deadAfterMs = DECODE_WITNESS_DEAD_MS,
  } = options;

  // 🔴 The sweep interval and the staleness threshold were independently
  // injectable with no relationship between them, so `checkMs: 60_000` against
  // the default 3 s threshold held a dead worker's green for 57 seconds — and
  // passed every spec, every mutation and the gate's source-text assertion,
  // because the line that starts the interval is byte-identical either way.
  // Detection latency is bounded by checkMs, so the threshold has to be worth
  // at least two sweeps.
  if (!(staleMs >= 2 * checkMs)) {
    throw new RangeError(
      `decode witness: staleMs (${staleMs}) must be at least two check ` +
        `intervals (2 x ${checkMs}), or a dead worker holds its green for ` +
        `most of the threshold`,
    );
  }

  // 🔴 Checked only when the hook is armed, so a caller without it keeps
  // every construction it had (a `staleMs` above the dead default included).
  // Strictly ABOVE the staleness threshold: dead has to imply stale, or the
  // tick that reaches the verdict could return before it delivers it. And
  // finite, because `Infinity` is a hook that is armed and can never fire —
  // the "present, so fine" read this file exists to delete.
  if (
    onDead !== undefined &&
    !(Number.isFinite(deadAfterMs) && deadAfterMs > staleMs)
  ) {
    throw new RangeError(
      `decode witness: deadAfterMs (${deadAfterMs}) must be finite and ` +
        `above staleMs (${staleMs}), or a dead worker is never called dead`,
    );
  }

  let lastAt = now();
  /** Gates the console noise ONLY. The witness write below is unconditional. */
  let warned = false;
  /** Same, for the worker-skew warning, which names a different cause. */
  let skewWarned = false;
  /**
   * 🔴 Terminal. `stop()` is the caller saying the witness is gone, and a
   * listener that keeps promoting after that is a green outliving its
   * evidence. `state.tsx` happens to remove the event listener before calling
   * stop(), so this is unreachable there today — but the guarantee must not
   * rest on one caller's statement ordering, which is how three of the six
   * defects on this branch were introduced.
   */
  let stopped = false;
  /** `onDead` has RETURNED once. Latched after the call, never before it. */
  let deadDelivered = false;
  /**
   * `now()` at the previous tick that found the heartbeat at least
   * `deadAfterMs` old, or `undefined` when the previous tick did not — or a
   * heartbeat has been credited since. One half of the two-tick pair.
   */
  let deadSeenAt: number | undefined;

  /**
   * Record this tick's view of the silence and say whether it completes a
   * dead pair. Never calls `onDead` itself, so the tick's amber write cannot
   * be skipped by it.
   */
  const deadTick = (): boolean => {
    const at = now();
    if (at - lastAt < deadAfterMs) {
      deadSeenAt = undefined;
      return false;
    }
    const previous = deadSeenAt;
    deadSeenAt = at;
    // Two observations, half a sweep apart. A burst of queued callbacks after
    // a frozen thread resumes lands within a few milliseconds and counts once.
    return previous !== undefined && at - previous >= checkMs / 2;
  };

  const fireDead = (cause: string): void => {
    if (onDead === undefined || deadDelivered) return;
    // A superseded session's listener is not this call's evidence, in either
    // direction — the same guard that keeps its posts off the new call's chip.
    if (!isCurrentSession()) return;
    // 🔴 CALL FIRST, LATCH AFTER — the rule `stop()` follows below. Latching
    // first treats a throw as a delivery and leaves a dead worker quiet.
    onDead();
    deadDelivered = true;
    log.warn(
      `[mls] the e2ee worker is ${cause} — reported dead; this call is ` +
        "not protected.",
    );
  };

  return {
    checkMs,

    onMessage(data: unknown): void {
      if (stopped) return;
      const participants = parseDecodeWitnessMessage(data);
      if (participants === null) {
        // Ours by kind, unreadable by shape — a worker/client version skew.
        // Without this the only signal is the staleness warning three beats
        // later, which asks whether the patch is applied: the wrong diagnosis
        // for a worker that is present and posting once a second.
        if (isDecodeWitnessKind(data) && !skewWarned) {
          skewWarned = true;
          log.warn(
            "[mls] the e2ee worker is posting a decode witness this build " +
              "cannot read — a worker/client version skew. The chip cannot " +
              "go green.",
          );
        }
        return;
      }
      if (!isCurrentSession()) return;
      // 🔴 A worker that cannot transform is not a heartbeat, whatever its
      // windows say: with the hook armed it is the dead verdict, and the
      // sample is NOT handed to the chip or credited to the clock — the
      // witness may withhold a green, never take one from a worker like that.
      // `undefined` counts: a worker that does not say is a worker that has
      // not been checked.
      if (
        onDead !== undefined &&
        parseDecodeWitnessRte(data) !== TRANSFORM_EVENT_TYPE
      ) {
        fireDead("running without RTCTransformEvent");
        return;
      }
      onWitness(summarizeDecodeWitness(participants));
      // 🔴 Credited AFTER the write, never before it. `onWitness` is a Solid
      // setter that synchronously drives the chip derivation, and that walks
      // the SFU's participants and publications — one throw out of a
      // half-disposed room and a `lastAt` credited up front would refresh the
      // clock forever on a witness the chip never received, holding the last
      // green for the life of the call. An undelivered witness is not a
      // heartbeat, for the same reason an unreadable one is not.
      lastAt = now();
      // A heartbeat between two late ticks is the thread resuming, not the
      // worker dying: the silence the earlier tick saw has ended, so it is
      // not half of any pair.
      deadSeenAt = undefined;
      if (warned || skewWarned) {
        warned = false;
        skewWarned = false;
        log.info("[mls] decode witness is reporting again");
      }
    },

    tick(): void {
      if (stopped) return;
      // Judged before the staleness return below and delivered after the
      // amber write. Dead implies stale (`deadAfterMs > staleMs`, checked at
      // construction, and the clock is monotonic), so a dead tick always
      // reaches the delivery.
      const dead = onDead !== undefined && deadTick();
      if (now() - lastAt <= staleMs) return;
      if (!warned) {
        warned = true;
        log.warn(
          "[mls] no decode witness from the e2ee worker — the chip cannot go " +
            "green. Is the livekit-client patch applied in this build?",
        );
      }
      // Written on EVERY stale tick, not just the first: `warned` exists to
      // stop the console repeating, never to stop the chip being told.
      //
      // 🔴 The verdict is delivered in `finally`, because each of the two must
      // survive the other throwing: `onWitness` is the Solid setter that can
      // throw out of the chip derivation on every tick of a half-disposed
      // room, and a dead worker that never goes loud because the chip threw
      // is the silent failure this hook exists to end.
      try {
        onWitness(DECODE_WITNESS_UNAVAILABLE);
      } finally {
        if (dead) fireDead("silent during the call");
      }
    },

    stop(): void {
      if (stopped) return;
      // The listener is being detached, so no further sample can arrive and
      // the last one must not keep standing as live evidence.
      //
      // 🔴 WRITE FIRST, LATCH AFTER. Latching first treats an undelivered
      // UNAVAILABLE as delivered: `onWitness` is a Solid setter that can throw
      // out of the chip derivation, and the listener would then be permanently
      // inert having never written the amber it exists to write. That is the
      // exact mirror of the clock-credit defect in `onMessage` above — and it
      // was introduced by the commit that fixed that one, which is this
      // branch's whole documented failure mode.
      onWitness(DECODE_WITNESS_UNAVAILABLE);
      stopped = true;
    },
  };
}
