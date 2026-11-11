/**
 * Mic pipeline attach — the PURE decision core for reconciling the mic's
 * one processor slot with the settings while the publish gate may be held,
 * extracted so `node --test` can load it (the house no-vitest split; this
 * module must stay dependency-free).
 *
 * Why this exists: `#syncMicPipeline` in state.tsx attaches the
 * `VoiceAudioPipeline` with livekit's `LocalAudioTrack.setProcessor`, and
 * that attach is NOT covered by the publish gate. In the pinned
 * livekit-client 2.15.13 `setProcessor` takes `trackChangeLock` — never
 * `pauseUpstreamLock`, the lock the gate's `pauseUpstream()` serialises on —
 * runs `processor.init()`, then does `await sender.replaceTrack(processedTrack)`
 * and only AFTER that emits `TrackProcessorUpdate`, the event the gate's
 * re-assert listens to. So a processor attached inside a held gate puts the
 * processed mic on the wire from the `replaceTrack` until the re-assert's
 * `pauseUpstream()` lands — the processor mirror window. Measured live as the
 * 1.4–2.8 s of seat audio leaving under a held gate on every join
 * (rejoin-leak handoff §7.9, runs 1 and 3: the join-time RNNoise attach).
 *
 * The fix is to DEFER the attach while the gate is held and re-run the sync
 * at the gate's single 1→0 edge. Nothing is stored while deferred: the caller
 * re-reads `#micPipelineWants()` when it fires. The re-run site is
 * `#resumeGate`, AFTER its awaited `#applyPublishGate(room)` sweep: the
 * caller's `size === 0` re-check is only meaningful once that drive has
 * settled (a refill during the sweep must suppress the attach), and an
 * attach must not be issued while the sweep's own repause (resume-then-
 * pause) may still be mid-flight on the same sender. It is NOT a
 * last-writer-wins race over the raw track — livekit's `mediaStreamTrack`
 * getter prefers `processor.processedTrack` and `setProcessor` assigns
 * `processor` before its `replaceTrack`, so a resume landing in either
 * order converges on the processed track (2.15.13).
 */

/** What `#syncMicPipeline` does with the mic processor slot this pass. */
export type MicPipelineAction =
  /** A pipeline is attached: tune it in place, gate held or not. */
  | "tune"
  /** All-default settings: run the raw capture, no Web Audio hop, no attach. */
  | "none"
  /**
   * A stage is wanted, no pipeline, gate held: do NOT attach now. The
   * caller re-runs at the gate's 1→0 edge and re-decides from live state.
   */
  | "defer"
  /** A stage is wanted, no pipeline, gate empty: attach now. */
  | "attach";

export interface MicPipelineInput {
  /**
   * `#gateHeld()` — the publish-gate reason set is non-empty, so every
   * publication is (being) swept paused and nothing may reach the sender.
   */
  gateHeld: boolean;
  /**
   * `!!this.#micPipeline` — a `VoiceAudioPipeline` is already attached (or
   * is mid-`setProcessor`: the field is assigned synchronously before the
   * attach is issued, so a second sync during `init` reads it as present).
   */
  hasPipeline: boolean;
  /**
   * `#micPipelineWants()` is all-default: no noise filter, unity gain,
   * shaper off, voice changer pitch 0. The raw capture is what the settings
   * ask for.
   */
  wantsDefault: boolean;
}

/**
 * Decide, in this order:
 *
 * 1. `hasPipeline` → `"tune"`, REGARDLESS of the gate. Tuning is state-only:
 *    `setGain` writes a field, `setTonePreset` / `setDenoiseEnabled` act on
 *    the pipeline's own graph and never touch the sender, so there is no
 *    window to open. Deferring a tune would instead LOSE a mid-hold settings
 *    change on an existing pipeline — nothing is stored while deferred and
 *    the re-run at the edge only sees the wants current at that moment,
 *    which is the same value the tune would have applied, but the user's
 *    change sat unapplied for the whole hold (plan, Approach/D6).
 * 2. `wantsDefault` → `"none"`. There is nothing to attach; the raw capture
 *    already is the requested pipeline.
 * 3. `gateHeld` → `"defer"`. The attach would `sender.replaceTrack(processed)`
 *    inside a held gate — the mirror window described above.
 * 4. Otherwise `"attach"`.
 *
 * The gate is consulted ONLY for the attach: a held gate must never block a
 * tune (arm 1) and must never turn an all-default sync into a deferred
 * attach that the edge would then wrongly perform (arm 2 precedes arm 3).
 */
export function micPipelineAction(input: MicPipelineInput): MicPipelineAction {
  if (input.hasPipeline) return "tune";
  if (input.wantsDefault) return "none";
  if (input.gateHeld) return "defer";
  return "attach";
}
