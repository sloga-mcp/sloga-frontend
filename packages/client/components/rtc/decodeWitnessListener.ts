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
 * 🔴 ONE-WAY. This may withhold a green. It never resolves a hold, cancels an
 * escalation, clears a latch or promotes anything.
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
 * 🔴 What the chip's witness signal MUST start at, and the reason this
 * constant is exported rather than written inline at the `createSignal` call:
 * a call that never arms the witness — no patched worker, no session, an early
 * throw between construction and `#armDecodeWitness` — has to read AMBER, not
 * green. Inline at the call site it lived in a file no spec can load, and a
 * one-word edit there silently restored green-by-default. Here it is pinned by
 * `decodeWitnessListener.test.ts` and mutated by `rtc-mutations.py`.
 */
export const DECODE_WITNESS_INITIAL: DecodeWitness = DECODE_WITNESS_UNAVAILABLE;

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
  } = options;

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
      onWitness(summarizeDecodeWitness(participants));
      // 🔴 Credited AFTER the write, never before it. `onWitness` is a Solid
      // setter that synchronously drives the chip derivation, and that walks
      // the SFU's participants and publications — one throw out of a
      // half-disposed room and a `lastAt` credited up front would refresh the
      // clock forever on a witness the chip never received, holding the last
      // green for the life of the call. An undelivered witness is not a
      // heartbeat, for the same reason an unreadable one is not.
      lastAt = now();
      if (warned || skewWarned) {
        warned = false;
        skewWarned = false;
        log.info("[mls] decode witness is reporting again");
      }
    },

    tick(): void {
      if (stopped) return;
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
      onWitness(DECODE_WITNESS_UNAVAILABLE);
    },

    stop(): void {
      if (stopped) return;
      stopped = true;
      // The listener is being detached, so no further sample can arrive and
      // the last one must not keep standing as live evidence.
      onWitness(DECODE_WITNESS_UNAVAILABLE);
    },
  };
}
