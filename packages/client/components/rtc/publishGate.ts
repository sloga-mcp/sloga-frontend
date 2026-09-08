/**
 * The publish gate's PER-PUBLICATION decision and the sweep that executes it
 * (R2-1 / R2-7).
 *
 * `state.tsx` holds the gate as a reason SET and sweeps every local
 * publication to match it. The sweep used to apply that verdict bare, on the
 * documented premise that "`pauseUpstream` is idempotent". It is — and that is
 * exactly the problem, because livekit's idempotency guard reads a FLAG, not
 * the sender:
 *
 *     if (this._isUpstreamPaused === true) return;          // 2.15.13
 *     if (!this.sender) { …warn…; return; }
 *     this._isUpstreamPaused = true;
 *     this.emit(TrackEvent.UpstreamPaused, this);
 *     if (this.sender.transport?.state !== 'closed') {
 *       await this.sender.replaceTrack(null);
 *     }
 *
 * Note the order: the flag goes true, and the detach is both conditional and
 * awaited AFTER it. So the flag means "someone called pauseUpstream", not "this
 * sender is quiet", and at least four things can separate the two:
 *
 *  1. `LocalParticipant.setE2EEEnabled()` → `republishAllTracks(undefined,
 *     false)` → `unpublishTrack()` (which clears `sender` and leaves the flag)
 *     + `publishOrRepublishTrack()` onto a NEW sender carrying the live track.
 *     `restartTracks` is `false`, so the `restartTrack()` →
 *     `setMediaStreamTrack()` → `resumeUpstream()` path that WOULD have cleared
 *     the flag never runs. This is not an edge case: the session's own
 *     `#enable()` calls it INSIDE its `enable-window` pause, so every E2EE call
 *     passes through it once, and it becomes unbounded whenever
 *     `#assertLocalDeclarations("enable")` fails and `#enable()` returns with
 *     the gate still held.
 *  2. The signal-reconnect republish (`republishAllTracks(undefined, true)`),
 *     for every track it skips `restartTrack()` on — a muted one, a
 *     screen-share, a screen-share-audio.
 *  3. The app's own `republishLocalPublications` (`state.tsx`), the local-
 *     declaration seam's GCM re-declaration.
 *  4. `setProcessor()` (denoise / gain / camera effects), which calls
 *     `sender.replaceTrack(processedTrack)` directly. It also emits
 *     `TrackProcessorUpdate` unconditionally while only replacing the track
 *     `if (processor.processedTrack)`, so the event does not imply a rebuild.
 *
 * …plus two that are not rebuilds at all:
 *
 *  5. `replaceTrack(null)` REJECTING, or being skipped because the transport
 *     was closing. The flag is already true by then, so nothing would ever
 *     pause that sender again.
 *  6. `handleTrackUnmuteEvent`, which `LocalTrack`'s constructor binds to the
 *     native MediaStreamTrack `unmute` event and which calls `resumeUpstream()`
 *     unconditionally — a device wake, a PipeWire source change, an
 *     exclusive-mode release. Here the flag and the wire agree; it is the
 *     GATE they both disagree with.
 *
 * Enumerating those was the first version of this fix, and it was the wrong
 * shape — a list of livekit internals to keep in sync, which the next release
 * or the next `videoCodec` change invalidates silently. So the gate does not
 * infer whether the sender was rebuilt. It OBSERVES whether the sender can
 * still send, the same way livekit's own guards do (`sender.track`,
 * `sender.transport?.state`), and acts on that. Found as the false-red half of
 * the 2026-09-08 join-race sitting: a seat showing ME-10 ("Your audio and video
 * stay paused") whose encrypted frames the other seat decrypted throughout.
 *
 * The residual, stated rather than hidden: between
 * `publishOrRepublishTrack`'s sender creation and the `LocalTrackPublished`
 * that triggers a sweep sits one offer/answer, and no sweep runs inside it. The
 * observation cannot close that window — only publishing an already-paused
 * track could — but it does mean any LATER sweep, for any reason, catches a
 * sender that survived it.
 */

/** What to apply to ONE local publication to make its upstream match the gate. */
export type PublishGateOp =
  /** Live, and livekit agrees it is live: a bare `pauseUpstream()` lands. */
  | "pause"
  /**
   * Live, but livekit's flag already says paused — so `pauseUpstream()` would
   * return on its guard. Clear the flag first (`resumeUpstream()`), then pause.
   * Not a leak: the sender is ALREADY sending, so the resume changes nothing on
   * the wire and only the pause does. `resumeUpstream()` re-attaches
   * `mediaStreamTrack`, which is a GETTER returning
   * `processor?.processedTrack ?? _mediaStreamTrack` — so a processed
   * publication gets its processed track back, not the raw camera or mic.
   */
  | "repause"
  /** The gate is empty: `resumeUpstream()` (livekit no-ops if already live). */
  | "resume"
  /** Observed quiet. Nothing to do, and nothing assumed. */
  | "none";

export interface PublishGateInputs {
  /** The reason set is non-empty — publishing must not leave this device. */
  gateHeld: boolean;
  /** livekit's own `isUpstreamPaused` for this publication's track. */
  upstreamPaused: boolean;
  /**
   * OBSERVED, not inferred: this publication's sender still carries a track
   * over a transport that is not closed. The whole point of the fix — see the
   * module comment for why the flag alone cannot answer this.
   */
  onTheWire: boolean;
}

export function publishGateOp(inputs: PublishGateInputs): PublishGateOp {
  if (!inputs.gateHeld) return "resume";
  if (!inputs.onTheWire) return "none";
  return inputs.upstreamPaused ? "repause" : "pause";
}

/**
 * One local publication as the sweep needs to see it. `state.tsx` implements
 * this over a livekit `LocalTrackPublication`; the specs implement it over a
 * fake reproducing 2.15.13's bookkeeping, so the sweep BODY — the op-to-call
 * mapping, the order inside `repause`, the mid-sequence re-check and the
 * post-condition — is covered rather than re-implemented in a spec.
 */
export interface GatedPublication {
  /** For the log line and the loud report. Never carries user content. */
  readonly name: string;
  /** livekit's `LocalTrack.isUpstreamPaused`. */
  readonly upstreamPaused: boolean;
  /**
   * Whether RTP can still leave this sender: a sender exists, it carries a
   * track, and its transport is not closed. Read BEFORE and AFTER acting — the
   * second read is the post-condition that makes the gate's promise checkable.
   */
  onTheWire(): boolean;
  pauseUpstream(): Promise<void>;
  resumeUpstream(): Promise<void>;
}

export interface PublishGateSweep {
  /**
   * Publications a HELD gate could not prove quiet, by name — a pause that
   * threw, or one that returned with the sender still live. Empty is the only
   * result that means "publishing is stopped". The caller must treat a
   * non-empty list as a fail-closed failure and surface it: nothing else in the
   * stack ever reads the wire, so if this is dropped the banner's "your audio
   * and video stay paused" becomes unfalsifiable.
   */
  unproven: string[];
}

/**
 * Sweep every publication to match the gate, and report what it could not
 * prove. `gateHeld` is a THUNK, deliberately: the gate can empty while a
 * `repause` serializes behind livekit's per-track lock (the session settling
 * plaintext, say), and resuming into a pause that is no longer wanted leaves a
 * healthy call silently muted with nothing left to resume it.
 *
 * Every livekit call is ISSUED synchronously, before this function's first
 * await, so that livekit's per-track `pauseUpstreamLock` — a strict-FIFO
 * promise chain — serializes the ops in issue order. An await placed above the
 * loop would let a later sweep's resume overtake an earlier sweep's pause.
 */
export async function applyPublishGate(
  publications: Iterable<GatedPublication>,
  gateHeld: () => boolean,
): Promise<PublishGateSweep> {
  const held = gateHeld();
  const pending: Promise<string | null>[] = [];
  for (const publication of publications) {
    pending.push(
      runOne(
        publishGateOp({
          gateHeld: held,
          upstreamPaused: publication.upstreamPaused,
          onTheWire: publication.onTheWire(),
        }),
        publication,
        gateHeld,
      ),
    );
  }
  const settled = await Promise.all(pending);
  return { unproven: settled.filter((name): name is string => name !== null) };
}

/** Apply one op and verify it. Resolves to the publication's name if unproven. */
async function runOne(
  op: PublishGateOp,
  publication: GatedPublication,
  gateHeld: () => boolean,
): Promise<string | null> {
  try {
    switch (op) {
      case "resume":
        await publication.resumeUpstream();
        return null; // nothing to prove: an empty gate wants it live
      case "repause": {
        // Issued before any await, so it takes livekit's lock in turn.
        const resumed = publication.resumeUpstream();
        try {
          await resumed;
        } catch {
          // Unsupported / torn-down: the pause below is still worth trying,
          // and the post-condition decides whether it worked.
        }
        if (!gateHeld()) return null;
        await publication.pauseUpstream();
        break;
      }
      case "pause":
        await publication.pauseUpstream();
        break;
      case "none":
        break;
    }
  } catch {
    // A pause that THREW left livekit's flag true over a sender it never
    // detached. Reported, never swallowed — this is the seam that turns a
    // one-off failure into a permanent silent false pause.
    return publication.name;
  }
  // The gate emptied under us: whatever the wire says now, this sweep is not
  // the one making a promise about it.
  if (!gateHeld()) return null;
  return publication.onTheWire() ? publication.name : null;
}
