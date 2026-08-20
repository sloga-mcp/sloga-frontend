/**
 * Movie-ducking policy (plan §7.3 4d) — PURE: no Solid, no LiveKit, so it
 * runs under `node --test`:
 *   node --test components/ui/components/features/voice/watch/duckPolicy.test.ts
 *
 * The signal is LiveKit's active-speaker list (the `attenuation.ts` shape),
 * REMOTE speakers only: the local participant's "speaking" is energy
 * detection, and with speakers + an open mic the movie's own audio marks
 * the local side active → duck → leak drops → release → volume back — a
 * 1-2 s pump forever (§7.3 rev-2 finding 2). Self-duck is not offered.
 *
 * The hold keeps the movie from pumping between words, mirroring
 * attenuation's release behavior. The multiplier composes with the user's
 * volume at ONE seam in the store (`volume × duckMult`) — never through the
 * persisted volume, so the slider shows the user's setting throughout.
 */

/** Multiplier applied to the watch volume while someone is talking. */
export const WATCH_DUCK_MULT = 0.6;

/** Hold-off after the last remote speaker before the movie comes back up. */
export const WATCH_DUCK_RELEASE_MS = 600;

export interface DuckTracker {
  /** While set, keep ducking until this local-ms even with nobody talking. */
  holdUntilMs: number | null;
}

export function duckTracker(): DuckTracker {
  return { holdUntilMs: null };
}

/**
 * One evaluation: the multiplier to apply now, and the tracker to carry to
 * the next evaluation. Callers re-evaluate on every speaker change and once
 * when the hold lapses.
 */
export function duckDecision(
  tracker: DuckTracker,
  i: { enabled: boolean; remoteSpeaking: boolean; nowMs: number },
): { tracker: DuckTracker; mult: number } {
  if (!i.enabled) {
    // Off releases immediately and forgets any hold.
    return { tracker: { holdUntilMs: null }, mult: 1 };
  }
  if (i.remoteSpeaking) {
    return {
      tracker: { holdUntilMs: i.nowMs + WATCH_DUCK_RELEASE_MS },
      mult: WATCH_DUCK_MULT,
    };
  }
  if (tracker.holdUntilMs !== null && i.nowMs < tracker.holdUntilMs) {
    return { tracker, mult: WATCH_DUCK_MULT };
  }
  return { tracker: { holdUntilMs: null }, mult: 1 };
}
