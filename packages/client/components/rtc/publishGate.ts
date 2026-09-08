/**
 * The publish gate's PER-PUBLICATION decision (R2-1 / R2-7).
 *
 * `state.tsx` holds the gate as a reason SET and sweeps every local
 * publication to match it: held ⇒ `pauseUpstream()`, empty ⇒
 * `resumeUpstream()`. The sweep used to apply that verdict bare, on the
 * documented premise that "`pauseUpstream` is idempotent". It is — and that is
 * exactly the problem, because livekit's idempotency guard reads a FLAG, not
 * the sender:
 *
 *     if (this._isUpstreamPaused === true) return;          // 2.15.13
 *     if (!this.sender) { …warn…; return; }
 *     this._isUpstreamPaused = true;
 *     …
 *     await this.sender.replaceTrack(null);
 *
 * and three livekit paths REBUILD the sender without ever clearing that flag:
 *
 *  1. `LocalParticipant.setE2EEEnabled()` → `republishAllTracks(undefined,
 *     false)` → `unpublishTrack()` + `publishOrRepublishTrack()`. This is what
 *     the session's own enable flip calls, INSIDE its `enable-window` pause —
 *     so the flip itself hands the gate a brand-new, live sender under a
 *     stale-true flag. `restartTracks` is `false`, so the
 *     `setMediaStreamTrack` → `resumeUpstream()` path that WOULD have cleared
 *     the flag never runs.
 *  2. The signal-reconnect republish (`republishAllTracks(undefined, true)`),
 *     for every track it skips `restartTrack()` on — a muted one, a
 *     screen-share, a screen-share-audio.
 *  3. `setProcessor()` (denoise / gain / camera effects), which calls
 *     `sender.replaceTrack(processedTrack)` directly.
 *
 * In all three the publication re-registers, `state.tsx` re-runs the sweep,
 * and the bare `pauseUpstream()` returns on the flag while real RTP flows out
 * of the new sender — with the reason set, the chip and the banner all saying
 * publishing is paused. Found as the false-red half of the 2026-09-08
 * join-race sitting: a seat showing ME-10 ("Your audio and video stay paused")
 * whose encrypted frames the other seat decrypted throughout.
 *
 * So the flag is only trustworthy when nothing has rebuilt the sender since it
 * was set. When something HAS, the pause must be re-applied through a
 * resume-first sequence (`repause`) that clears the flag before pausing the
 * new sender. That sequence is not a leak: the rebuilt sender is already
 * sending, so the resume changes nothing on the wire and only the pause does.
 * A publication whose sender was NOT rebuilt is left alone (`none`) — running
 * `repause` over the whole roster would briefly re-attach tracks that are
 * correctly paused, which is the one thing the gate exists to prevent.
 */
export type PublishGateOp =
  /** Not paused yet: a bare `pauseUpstream()` lands. */
  | "pause"
  /** Paused-by-flag over a REBUILT sender: `resumeUpstream()`, then pause. */
  | "repause"
  /** The gate is empty: `resumeUpstream()` (livekit no-ops if already live). */
  | "resume"
  /** Paused, and nothing has invalidated that since. */
  | "none";

export interface PublishGateInputs {
  /** The reason set is non-empty — publishing must not leave this device. */
  gateHeld: boolean;
  /** livekit's own `isUpstreamPaused` for this publication's track. */
  upstreamPaused: boolean;
  /**
   * This publication's sender was rebuilt underneath the flag: the sweep is
   * running FOR it, off `localTrackPublished` (a republish) or
   * `TrackProcessorUpdate` (a direct `replaceTrack`). Never assumed — a sweep
   * that cannot name a rebuilt publication passes false for every one.
   */
  senderRebuilt: boolean;
}

export function publishGateOp(inputs: PublishGateInputs): PublishGateOp {
  if (!inputs.gateHeld) return "resume";
  if (!inputs.upstreamPaused) return "pause";
  return inputs.senderRebuilt ? "repause" : "none";
}
