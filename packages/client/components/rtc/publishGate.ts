/**
 * The publish gate's PER-PUBLICATION decision and the sweep that executes it
 * (R2-1 / R2-7).
 *
 * `state.tsx` holds the gate as a reason SET and sweeps every local publication
 * to match it. The sweep used to apply that verdict bare, on the documented
 * premise that "`pauseUpstream` is idempotent". It is — and that is exactly the
 * problem, because livekit's idempotency guard reads a FLAG, not the sender:
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
 * sender is quiet", and at least six things can separate the two:
 *
 *  1. `LocalParticipant.setE2EEEnabled()` → `republishAllTracks(undefined,
 *     false)` → `unpublishTrack()` (which clears `sender` and leaves the flag)
 *     + `publishOrRepublishTrack()` onto a NEW sender carrying the live track.
 *     `restartTracks` is `false`, so the `restartTrack()` →
 *     `setMediaStreamTrack()` → `resumeUpstream()` path that WOULD have cleared
 *     the flag never runs. Not an edge case: the session's own `#enable()` calls
 *     it INSIDE its `enable-window` pause, so every E2EE call passes through it
 *     once, and it becomes unbounded whenever
 *     `#assertLocalDeclarations("enable")` fails and `#enable()` returns with
 *     the gate still held.
 *  2. The signal-reconnect republish (`republishAllTracks(undefined, true)`),
 *     for every track it skips `restartTrack()` on — a muted one, a
 *     screen-share, a screen-share-audio.
 *  3. The app's own `republishLocalPublications` (`state.tsx`), the
 *     local-declaration seam's GCM re-declaration.
 *  4. `setProcessor()` (denoise / gain / camera effects), which calls
 *     `sender.replaceTrack(processedTrack)` directly. It also emits
 *     `TrackProcessorUpdate` unconditionally while only replacing the track
 *     `if (processor.processedTrack)`, so the event does not imply a rebuild.
 *  5. `replaceTrack(null)` REJECTING, or being skipped because the transport was
 *     closing. The flag is already true by then, so nothing would ever pause
 *     that sender again.
 *  6. `handleTrackUnmuteEvent`, which `LocalTrack`'s constructor binds to the
 *     native MediaStreamTrack `unmute` event and which calls `resumeUpstream()`
 *     unconditionally — a device wake, a source change, an exclusive-mode
 *     release. Here the flag and the wire agree; it is the GATE they disagree
 *     with.
 *
 * Enumerating those was the first version of this fix, and it was the wrong
 * shape — a list of another package's internals to keep in sync, which the next
 * release invalidates silently, and which cannot cover (5) or (6) at all. So the
 * gate does not infer whether the sender was rebuilt. It OBSERVES whether the
 * sender can still send, the same way livekit's own guards do.
 *
 * 🔴 But the observation has a WINDOW where it lies, and getting that wrong is
 * how the first version of this rework introduced a fail-open of its own.
 * `replaceTrack` sets `sender.track` in a queued task immediately BEFORE it
 * resolves (WebRTC 1.0 §5.2), while livekit clears `_isUpstreamPaused` and
 * emits `UpstreamResumed` BEFORE awaiting it. So all through an in-flight
 * `resumeUpstream()` the sender reads `{flag: false, track: null}` — which,
 * read as a boolean "is it on the wire", says QUIET. A sweep that trusted that
 * reported "publishing is stopped" and issued nothing; the resume then landed
 * and RTP flowed under a held gate, with `UpstreamResumed` already fired and no
 * further sweep coming. The old bare-pause sweep was correct here by accident:
 * an unconditional `pauseUpstream()` takes livekit's strict-FIFO
 * `pauseUpstreamLock` behind the resume and wins.
 *
 * Hence {@link UpstreamState} is three-valued, and a quiet wire is trusted only
 * when livekit's flag AGREES that it is paused. A quiet wire under a CLEARED
 * flag is that in-flight window (nothing else produces it) and takes a pause —
 * harmless, because `pauseUpstream` on an already-detached sender just sets the
 * flag and `replaceTrack(null)` is idempotent.
 *
 * Two residuals, stated rather than hidden:
 *
 *  - Between `publishOrRepublishTrack`'s `emit(LocalSenderCreated)` and the
 *    `LocalTrackPublished` that triggers a sweep sits one offer/answer, and the
 *    publication is ABSENT from `localParticipant.trackPublications` for all of
 *    it (`unpublishTrack` deletes it; `addTrackPublication` re-adds it at the
 *    end). So no sweep can even see a survivor until the window closes — the
 *    observation bounds it, it does not close it. Closing it needs a
 *    `LocalSenderCreated` hook or a publish path that never publishes unpaused.
 *  - `LocalVideoTrack.pauseUpstream`/`resumeUpstream` run their
 *    `simulcastCodecs` loops OUTSIDE the flag guard, so an op this policy skips
 *    also skips livekit's unconditional backup-codec detach, and `onTheWire`
 *    cannot see those senders (`simulcastCodecs` is not on the public type).
 *    PRECONDITION: `simulcastCodecs` is empty. It is — `videoCodec` is vp8 and
 *    `publishAdditionalCodecForTrack` refuses when `encryptionType !== NONE` —
 *    but note the second only holds AFTER `setEncryptionEnabled(true)`, so a
 *    non-vp8 `videoCodec` would break this during `negotiating`/`mixed`. The
 *    screenshare-quality work is what would do that.
 *
 * Found as the false-red half of the 2026-09-08 join-race sitting: a seat
 * showing ME-10 ("Your audio and video stay paused") whose encrypted frames the
 * other seat decrypted throughout.
 */

/** What to apply to ONE local publication to make its upstream match the gate. */
export type PublishGateOp =
  /** Nothing has paused this sender yet: a bare `pauseUpstream()` lands. */
  | "pause"
  /**
   * Live, but livekit's flag already says paused — so `pauseUpstream()` would
   * return on its guard. Clear the flag first (`resumeUpstream()`), then pause.
   * Not a leak on a sender that is already sending: the resume changes nothing
   * on the wire and only the pause does. `resumeUpstream()` re-attaches
   * `mediaStreamTrack`, a GETTER returning
   * `processor?.processedTrack ?? _mediaStreamTrack`, so a processed
   * publication gets its processed track back, not the raw camera or mic.
   */
  | "repause"
  /** The gate is empty: `resumeUpstream()` (livekit no-ops if already live). */
  | "resume"
  /** Proven quiet — the wire AND livekit's flag agree — or nothing published. */
  | "none";

/**
 * What the sweep can actually see about one sender. Three-valued because the
 * two-valued version had a fail-open: see the module comment on the in-flight
 * `replaceTrack` window.
 */
export type UpstreamState =
  /** A sender exists, carries a track, and its transport is not closed. */
  | "live"
  /**
   * A sender exists and carries no track. Either genuinely detached, or an
   * attach is in flight — indistinguishable from outside, which is why this is
   * only trusted alongside livekit's flag.
   */
  | "quiet"
  /** No sender at all: never published, or mid-republish. Nothing can leave. */
  | "unpublished";

export interface PublishGateInputs {
  /** The reason set is non-empty — publishing must not leave this device. */
  gateHeld: boolean;
  /** livekit's own `isUpstreamPaused` for this publication's track. */
  upstreamPaused: boolean;
  /** OBSERVED, not inferred. See {@link UpstreamState}. */
  upstream: UpstreamState;
}

export function publishGateOp(inputs: PublishGateInputs): PublishGateOp {
  if (!inputs.gateHeld) return "resume";
  // Nothing to pause, and pausing would only log livekit's "unable to pause
  // upstream for an unpublished track" on every sweep.
  if (inputs.upstream === "unpublished") return "none";
  if (inputs.upstream === "live") {
    return inputs.upstreamPaused ? "repause" : "pause";
  }
  // Quiet. Trustworthy only when livekit agrees it is paused; a cleared flag
  // over a quiet wire is an attach in flight, and the pause must queue behind
  // it on livekit's lock.
  return inputs.upstreamPaused ? "none" : "pause";
}

/**
 * One local publication as the sweep needs to see it. `state.tsx` implements
 * this over a livekit `LocalTrackPublication`; the specs implement it over a
 * fake reproducing 2.15.13's bookkeeping — including the deferred
 * `sender.track` write — so the sweep BODY (the op-to-call mapping, the order
 * inside `repause`, the mid-sequence re-check, the post-condition) is covered
 * rather than re-implemented in a spec.
 */
export interface GatedPublication {
  /** For the log line. Never carries user content. */
  readonly name: string;
  /** livekit's `LocalTrack.isUpstreamPaused`. */
  readonly upstreamPaused: boolean;
  /** Read BEFORE and AFTER acting; the second read is the post-condition. */
  upstream(): UpstreamState;
  pauseUpstream(): Promise<void>;
  resumeUpstream(): Promise<void>;
}

export interface PublishGateSweep {
  /**
   * Publications a HELD gate could not prove quiet, by name — a pause that
   * threw, or one that returned with the sender still live. Empty is the only
   * result that means "publishing is stopped".
   *
   * 🔴 A survivor here is NOT yet a verdict. livekit ops can leave the wire live
   * for a few microtasks, so the caller must confirm with a bounded re-sweep
   * before treating it as a failure — see `state.tsx`. What the caller must not
   * do is DROP it: nothing else in the stack ever reads the wire, so a discarded
   * survivor makes the banner's "your audio and video stay paused"
   * unfalsifiable.
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
 * promise chain — serializes the ops in issue order. An await placed inside the
 * loop would let a later publication's op take the lock ahead of an earlier
 * one's.
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
          upstream: publication.upstream(),
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
      default: {
        // A new op with no arm here would issue nothing, and the post-condition
        // below would turn that into a user-facing red rather than a build
        // failure. Keep it a build failure.
        const exhaustive: never = op;
        return exhaustive;
      }
    }
    // The gate emptied under us: whatever the wire says now, this sweep is not
    // the one making a promise about it.
    if (!gateHeld()) return null;
    return publication.upstream() === "live" ? publication.name : null;
  } catch {
    // A pause that THREW left livekit's flag true over a sender it never
    // detached; a post-condition read that threw tells us nothing. Reported,
    // never swallowed — this is the seam that turns a one-off failure into a
    // permanent silent false pause.
    return publication.name;
  }
}
