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
 * when livekit's flag AGREES that it is paused. A quiet wire under a CLEARED flag
 * takes a pause — harmless, because `pauseUpstream` on an already-detached sender
 * just sets the flag and `replaceTrack(null)` is idempotent.
 *
 * That leaves the MIRROR window, which this policy does NOT close: `{flag: true,
 * quiet}` while a non-`pauseUpstream` attach is in flight. `setProcessor` and
 * `setMediaStreamTrack` both `await sender.replaceTrack(…)` directly, bypassing
 * `pauseUpstreamLock` and leaving the flag untouched, so both reads agree on
 * "settled pause" while an attach is pending. It is a transient lie, not a hole:
 * both emit (`TrackProcessorUpdate` / `UpstreamResumed`) after the attach lands,
 * and `#reassertPublishGate` sweeps on either.
 *
 * It is reachable on a normal join — `#syncMicPipeline` runs inside the
 * `negotiating` gate for anyone with denoise, non-unity gain or a tone preset —
 * and that reachability is itself an unimplemented contract clause, not a limit
 * of the observation. R2-1 in the 6.5 breakdown specifies TWO halves: re-assert
 * on the events (done), AND defer effect attachment while the gate is held
 * (never built — `#syncMicPipeline` has no gate check). Closing half (ii) would
 * remove the window rather than race it.
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
 *  - `repause`'s resume can re-attach a sender that a `pauseUpstream` already
 *    in flight was about to detach: a `debouncedTrackMuteHandler` pause (5 s
 *    debounce) sets the flag true BEFORE its await, so this policy reads
 *    `{flag: true, live}` and resumes after that detach lands. Bounded to the
 *    length of the resume-then-pause, over frames the gate is holding for
 *    anyway, and every interleaving settles quiet — but the number of brief
 *    re-attach windows went UP with the `{flag: false, quiet} → pause` rule,
 *    because each `repause` now reliably spawns a re-entrant pause.
 *  - `LocalVideoTrack.pauseUpstream`/`resumeUpstream` run their
 *    `simulcastCodecs` loops OUTSIDE the flag guard, so an op this policy skips
 *    also skips livekit's unconditional backup-codec detach, and `upstream()`
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
 *
 * 🔴 AND WHY THE SWEEP MUST NOT SPIN. `repause`'s `resumeUpstream()` emits
 * `UpstreamResumed` synchronously, BEFORE awaiting its attach, and `state.tsx`
 * re-asserts the gate on that event. So a sweep's own remedy re-enters the
 * sweep. While the detach eventually lands that is bounded and convergent, but
 * when it persistently does NOT — a rejecting `replaceTrack(null)`, which is
 * exactly the case the post-condition exists for — every pass re-attaches the
 * sender and schedules another pass: a renderer live-lock that keeps media on
 * the wire, found by the fourth media-E2EE review with a probe of the real
 * wiring. Two things bound it, and both live here so a spec can drive them:
 * {@link coalescingSweeper} (re-entrant triggers collapse into ONE trailing
 * pass, never a nested one) and {@link PublishGateOptions.repauseSpent} (a
 * publication whose repause already failed is reported, never resumed again —
 * retrying cannot help and each retry re-attaches).
 *
 * THREE, in fact, because those two were MEASURED insufficient. The entire
 * re-entrant burst is MICROTASKS and the caller's confirm is a MACROTASK:
 * `resumeUpstream` emits `UpstreamResumed` synchronously before its await,
 * `state.tsx#reassertPublishGate` sweeps on it, and {@link coalescingSweeper}'s
 * `while (pending && --budget > 0)` re-loops on a microtask, while
 * `#scheduleGateConfirm` is a `setTimeout(0)`. So the burst is over before a
 * confirming pass exists, and NO policy keyed on the confirm — which is where
 * the spend is decided — can bound the re-attaches inside it. Measured against
 * this module through the production caller shape, under a persistently
 * rejecting `replaceTrack(null)`: 7 passes, 5 re-attaches, 2 reports and a
 * DROPPED pass on a microtask wire; 4 / 3 / 2 / no drop on a macrotask wire.
 * Hence {@link PublishGateOptions.repausePending} — the same suppression as
 * `repauseSpent` at a strictly weaker trigger and a strictly smaller scope.
 *
 * 🔴 AND THE SCOPE IS THE WHOLE MECHANISM. `repausePending` is scoped to ONE
 * DRIVE of {@link coalescingSweeper} — the caller clears it from the
 * `onDriveStart` hook. An EPISODE-scoped pending set is not a smaller version
 * of this: it is mechanically identical to `repauseSpent` at a weaker trigger,
 * i.e. a permanent per-name disarm, because a suppression is
 * unreachable-to-lift. Once a name is suppressed and its wire is live no pause
 * is issued, so nothing can ever be `proven`, so the un-spend never fires.
 * Measured ON THE MICROTASK-WIRE MODEL: episode scope turns the mirror window
 * above from `wire=quiet` into `wire=live`, with the name latched for the rest
 * of the call. The axis matters and is not averaged over: on a MACROTASK wire
 * that scenario cannot even produce the failing repause, because the competing
 * attach cannot land inside the microtask gap between the detach resolving and
 * the post-condition read — so it is the microtask model that discriminates
 * this, and `publishGate.test.ts` says so per axis. Drive scope keeps the
 * disarm inside the burst that caused it, and the confirm — a NEW drive —
 * re-arms it.
 *
 * The property that makes that work, and that a refactor must preserve:
 * {@link applyPublishGate} re-reads BOTH option sets on every pass, against the
 * live `Set` the caller re-supplies by reference, so the caller can arm the
 * NEXT pass from this pass's report; while WITHIN one pass every publication is
 * decided against one pre-await snapshot taken in the synchronous issue loop.
 * Per-pass freshness, per-pass consistency.
 *
 * 🔴 WHAT MAY BE SPENT: ONLY A DETACH THAT THREW. A spend is a PERMANENT
 * per-episode disarm, for the reason just given, so the only failure that may
 * feed it is one a retry CANNOT fix — `pauseUpstream()` itself rejecting
 * ({@link PublishGateSweep.repauseThrew}). A pause that RESOLVED over a wire
 * the post-condition reads live means something else re-attached the sender
 * (`setProcessor`, `setMediaStreamTrack`, `handleTrackUnmuteEvent`); a retry
 * CAN help, so it is never in `repauseThrew`, and it keeps being swept exactly
 * as before.
 *
 * INVARIANT, not an implementation detail: `threw` is only ever read AND-ed
 * with `op === "repause"`. Loosening it to "any op that threw" would let a
 * plain `pause` failure spend the publication — the 2026-09-08 defect re-armed
 * under a narrower precondition, and the thing `publishGate.test.ts`'s "a
 * failed PAUSE is not a failed repause" exists to stop.
 *
 * And the THIRD event the single outer catch used to fold into those two: a
 * READ that threw ({@link OneResult.unreadable}). A `pauseUpstream()` that
 * RESOLVED followed by a `publication.upstream()` that threw says nothing
 * whatsoever about the wire, so it feeds neither set. `repauseFailed` means "an
 * issued repause did not end quiet", NOT "the op failed" — which is why it is
 * safe to feed a DRIVE-scoped suppression and not safe to feed anything
 * permanent. The disarm would outlive the read failure, and durably: a name is
 * `${source}/${trackSid}` and every re-attacher preserves `trackSid`.
 *
 * 🔴 AND A FOURTH, which is why the attribution is no longer a REGION FLAG.
 * `pauseUpstream()` can fail in two ways that a flag spanning the call cannot
 * tell apart, and only one of them may be permanent:
 *
 *  - the promise livekit returned REJECTED — flag set, `UpstreamPaused`
 *    emitted, `replaceTrack(null)` rejected. `threw`. Permanent.
 *  - `publication.pauseUpstream()` threw SYNCHRONOUSLY. livekit's method is
 *    `async` and cannot; this is `state.tsx`'s adapter over a `LocalTrack`
 *    torn down since the `trackPublications` snapshot. Nothing was written, no
 *    later pause early-returns, a retry can help. NOT `threw`.
 *
 * The region flag also mis-attributed the `gateHeld()` re-check that sits
 * between the resume and the pause: it reported `repauseThrew` for a detach
 * that was never even called. That was unreachable only because `state.tsx`
 * passes `() => this.#publishGate.size > 0` TODAY; the 6.5 breakdown has wave 1
 * replace it with `EpisodeDeps.gateHeld()`. So the arm catches its own detach,
 * twice, and the module has exactly ONE site that assigns `threw`.
 *
 * One pre-existing oddity, recorded so the next review does not re-find it: in
 * the `resume` arm (an EMPTY gate) a post-condition read that throws is
 * reported as `unproven`, not `failed`, because it lands in the same outer
 * catch — and `unproven` is documented as "publications a HELD gate could not
 * prove quiet". Harmless, because every consumer of `unproven` acts only on a
 * held gate or on `op === "repause"` and this carries neither, but it is a
 * mis-labelled report rather than a designed one.
 *
 * WHY THE POST-CONDITION IS MANDATORY, not defensive. Two clauses of
 * `docs/e2ee-media-mls-plan.md` are unqualified absolutes — §1.4: a desynced
 * member "publishes nothing (its old frame keys are stale)", and: "this device
 * must never publish under a key it should no longer hold". Both are implemented
 * by ONE mechanism: `#resetEnableState` asserting `pausePublishing`. So a pause
 * that silently fails to land is not an accuracy defect, it is that invariant
 * broken — this device publishing under keys a re-establish has rotated away,
 * with the gate believing it is held. And before the observation was added, a
 * single swallowed failure left livekit's flag lying for the rest of the call,
 * so EVERY later gate reason from ANY caller no-oped on it too. That is what the
 * post-condition exists to catch, and why a survivor may be logged or surfaced
 * but never dropped.
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

export interface PublishGateOptions {
  /**
   * Publications whose `repause` has ALREADY failed to leave the wire quiet
   * during this held-gate episode, by name. They are re-checked and reported,
   * but never resumed again: the resume exists only to clear livekit's flag so
   * the pause can proceed, so once the pause is known to fail the resume is pure
   * harm — it re-attaches the sender the gate is trying to detach, and its
   * `UpstreamResumed` is what feeds the loop. Cleared when the gate empties.
   *
   * 🔴 May be fed ONLY from {@link PublishGateSweep.repauseThrew}: this is a
   * permanent per-episode disarm and its lift is unreachable while the wire is
   * live, so a failure a retry could have fixed must never reach it.
   */
  repauseSpent?: ReadonlySet<string>;
  /**
   * Publications whose issued `repause` already failed inside THIS DRIVE of
   * {@link coalescingSweeper}, by name. Treated exactly as
   * {@link repauseSpent} at the op-issue point — verify and report, issue
   * nothing — and existing for the timing reason in the module comment: the
   * re-entrant burst is microtasks and the confirm is a macrotask, so the
   * spend cannot bound the re-attaches inside a burst and this does.
   *
   * 🔴 DRIVE-scoped, never episode-scoped. The caller clears it from
   * {@link coalescingSweeper}'s `onDriveStart`. An episode-scoped population is
   * a permanent per-name disarm — see the module comment; it is forbidden, and
   * it regresses the mirror window from a converging `quiet` to a latched
   * `live`.
   */
  repausePending?: ReadonlySet<string>;
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
  /**
   * Publications whose RESUME threw, under an empty gate. The opposite failure
   * — a call that should be publishing and may be stuck muted — and kept
   * separate because it wants the opposite response. Folding it into `unproven`
   * meant a caller that (correctly) only acts on a held gate discarded it
   * entirely: silently muted, no telemetry.
   */
  failed: string[];
  /**
   * The subset of `unproven` whose op was an ISSUED `repause` — i.e. the
   * resume-then-pause actually ran and STILL did not leave the wire quiet.
   *
   * 🔴 This, and only this, may feed {@link PublishGateOptions.repausePending}.
   * Marking a publication on any other `unproven` disarms the gate for it over
   * a failure a retry could have fixed: the next pass computes `repause`, sees
   * it suppressed, issues nothing, and the sender stays live — the 2026-09-08
   * defect re-armed under a narrower precondition (media-E2EE review, fifth
   * pass). A repause SUPPRESSED by `repauseSpent` / `repausePending` is
   * excluded here by construction (`issued`), so a suppression can never feed
   * itself; so is a verdict reached by a READ that threw
   * ({@link OneResult.unreadable}), which knows nothing about the wire.
   *
   * What it may NOT feed is the permanent {@link
   * PublishGateOptions.repauseSpent} — that takes {@link repauseThrew} only.
   */
  repauseFailed: string[];
  /**
   * The subset of `repauseFailed` whose `pauseUpstream()` itself REJECTED —
   * the narrowest of the events the sweep's outer catch used to conflate, and
   * the only one a PERMANENT disarm may be built on: livekit's flag is true
   * over a sender it never detached, and every later pause on that track
   * early-returns on the flag, so a retry cannot help.
   *
   * 🔴 This, and only this, may feed {@link PublishGateOptions.repauseSpent}.
   * Three things are deliberately absent because a retry CAN help and they
   * keep being swept: a pause that RESOLVED over a re-attached wire; a
   * `pauseUpstream()` that threw SYNCHRONOUSLY, i.e. before livekit's `async`
   * body ran, so its flag was never written; and a `gateHeld()` re-check that
   * threw, where no detach was even attempted.
   */
  repauseThrew: string[];
  /**
   * Publications a HELD gate ended this sweep having OBSERVED quiet. The
   * caller uses it to un-spend: a repause that failed once must not be a life
   * sentence when the wire later goes quiet on its own.
   */
  proven: string[];
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
/**
 * What one publication's sweep concluded. `proven` is only emitted under a HELD
 * gate — an empty gate proves nothing about quiet, it wants the opposite.
 */
type OneResult = {
  kind: "unproven" | "failed" | "proven";
  name: string;
  op: PublishGateOp;
  /**
   * An op actually reached livekit for this publication. FALSE when the
   * `repause` arm was suppressed by {@link PublishGateOptions.repauseSpent} or
   * {@link PublishGateOptions.repausePending} — which is what keeps a
   * SUPPRESSED publication out of {@link PublishGateSweep.repauseFailed} by
   * construction rather than by every caller remembering to.
   */
  issued?: boolean;
  /**
   * The promise `pauseUpstream()` RETURNED rejected. Not "the wire still reads
   * live", not "a read threw", and not "`pauseUpstream()` threw synchronously"
   * — livekit's is `async` and cannot, so that is the adapter over a torn-down
   * track, with livekit's body never entered and a retry still able to help.
   *
   * Set at exactly ONE point in this file, from a catch wrapped around exactly
   * one awaited promise, because it is the only input to a PERMANENT per-name
   * disarm ({@link PublishGateSweep.repauseThrew}). It was previously derived
   * from a region flag that also spanned the `gateHeld()` re-check.
   */
  threw?: boolean;
  /**
   * A READ threw — the pre-read, either `gateHeld()`, or the post-condition.
   * This verdict says nothing at all about the wire, so it feeds neither
   * {@link PublishGateSweep.repauseThrew} nor
   * {@link PublishGateSweep.repauseFailed}.
   */
  unreadable?: boolean;
} | null;

// All three are OPTIONAL, and the absent value is the never-a-PERMANENT-disarm
// direction — which is narrower than "never a disarm", and the difference is
// worth stating because a review round asserted the wider claim:
//
//  - `threw` and `issued` are filtered `=== true`, so absence EXCLUDES. A
//    verdict that forgets either can never reach `repauseThrew`, and
//    `repauseThrew` is the only input to the permanent per-episode spend.
//  - `unreadable` is filtered `!== true`, so absence INCLUDES. A future
//    `unproven` return in the repause arm that omits it gets the DRIVE-scoped
//    `repauseFailed`, i.e. a suppression lifted at the next `onDriveStart`.
//    That is deliberate for the one such path there is — a `pauseUpstream()`
//    that threw synchronously, where livekit never ran and the wire is still
//    live — but it does mean the safe direction here is "sweep it again next
//    drive", not "sweep it again next pass".
//
// A `failed` (empty-gate) or `proven` verdict carries none of the three;
// neither has a repause to attribute.

export async function applyPublishGate(
  publications: Iterable<GatedPublication>,
  gateHeld: () => boolean,
  options: PublishGateOptions = {},
): Promise<PublishGateSweep> {
  const held = gateHeld();
  const pending: Promise<OneResult>[] = [];
  for (const publication of publications) {
    // NB `runOne` reads `upstreamPaused` / `upstream()` itself, inside its own
    // try. Both go through an adapter over a livekit `LocalTrack` that can be
    // torn down between the `trackPublications` snapshot and the read, and
    // reading them HERE let one throwing publication reject the whole sweep —
    // cancelling every other publication's op and, because the call sites are
    // `void`ed, surfacing as an unhandled rejection with no report at all.
    pending.push(
      runOne(
        publication,
        held,
        gateHeld,
        options.repauseSpent?.has(publication.name) ?? false,
        options.repausePending?.has(publication.name) ?? false,
      ),
    );
  }
  const settled = await Promise.all(pending);
  const named = (kind: string) =>
    settled.filter((r) => r?.kind === kind).map((r) => r!.name);
  return {
    unproven: named("unproven"),
    failed: named("failed"),
    repauseFailed: settled
      .filter(
        (r) =>
          r?.kind === "unproven" &&
          r.op === "repause" &&
          r.issued === true &&
          r.unreadable !== true,
      )
      .map((r) => r!.name),
    repauseThrew: settled
      .filter(
        (r) =>
          r?.kind === "unproven" &&
          r.op === "repause" &&
          r.issued === true &&
          r.threw === true,
      )
      .map((r) => r!.name),
    proven: named("proven"),
  };
}

/** Read the publication, decide, apply, and verify — all inside one try. */
async function runOne(
  publication: GatedPublication,
  held: boolean,
  gateHeld: () => boolean,
  repauseSpent: boolean,
  repausePending: boolean,
): Promise<OneResult> {
  /** An op reached livekit. See {@link OneResult.issued}. */
  let issued = false;
  let op: PublishGateOp = "none";
  try {
    op = publishGateOp({
      gateHeld: held,
      upstreamPaused: publication.upstreamPaused,
      upstream: publication.upstream(),
    });
    switch (op) {
      case "resume":
        // An empty gate wants this live, so the proof runs the other way — and
        // it needs one for the same reason the pause does. `resumeUpstream`
        // clears `_isUpstreamPaused` BEFORE awaiting its attach and guards on
        // `if (this._isUpstreamPaused === false) return;`, so an attach that
        // rejects leaves {flag: false, wire quiet} — after which every later
        // resume early-returns and the track is muted upstream for the rest of
        // the call. Only a `setMediaStreamTrack` (a device switch) recovers it.
        issued = true;
        try {
          await publication.resumeUpstream();
        } catch {
          return { kind: "failed", name: publication.name, op };
        }
        if (gateHeld()) return null; // the gate refilled under us
        // `unpublished` is not a failure: there is nothing to put back.
        return publication.upstream() === "quiet"
          ? { kind: "failed", name: publication.name, op }
          : null;
      case "repause": {
        // Already tried and failed this episode: verify and report, but issue
        // nothing. Retrying cannot help, and the resume would re-attach the
        // sender and re-enter this sweep through `UpstreamResumed`.
        if (repauseSpent) break;
        // Already tried and failed inside THIS DRIVE of the sweeper: the same
        // reasoning at a weaker trigger and a smaller scope, and the one bound
        // that acts INSIDE a re-entrant burst. `issued` stays false, so a
        // suppressed publication is reported and never fed back into either
        // set — a suppression that fed itself would be a permanent disarm.
        if (repausePending) break;
        // Issued before any await, so it takes livekit's lock in turn.
        const resumed = publication.resumeUpstream();
        issued = true;
        try {
          await resumed;
        } catch {
          // Unsupported / torn-down: the pause below is still worth trying,
          // and the post-condition decides whether it worked.
        }
        if (!gateHeld()) return null;
        // 🔴 THE ONE SITE THAT MAY PRODUCE `threw`, and why it is two
        // statements and two catches rather than one region flag spanning
        // them. `threw` is the sole input to a PERMANENT per-name disarm, so
        // it must be provably the DETACH's own rejection and nothing else.
        //
        // A previous version set a `pausing` flag BEFORE the `gateHeld()`
        // re-check and reported `threw: pausing` from the single outer catch.
        // That flag is a REGION, not the call: a `gateHeld()` that threw was
        // reported as a failed detach — `repauseThrew` populated with
        // `pauseUpstream()` never having been called at all — and the whole
        // justification for permanence ("livekit's flag is true over a sender
        // it never detached, so every later pause early-returns") is then
        // false, over a failure a retry could have fixed. Unreachable while
        // `state.tsx` passes `() => this.#publishGate.size > 0`; reachable the
        // moment wave 1 passes `EpisodeDeps.gateHeld()`. An invariant held by
        // prose across a wave boundary is not held.
        //
        // The split is NOT cosmetic either. livekit's `pauseUpstream` is
        // `async`, so it cannot throw synchronously; a synchronous throw here
        // is `state.tsx`'s ADAPTER over a `LocalTrack` torn down since the
        // `trackPublications` snapshot. livekit's body never ran,
        // `_isUpstreamPaused` was never written, no later pause early-returns,
        // and a retry CAN help — so it is a `repauseFailed` (drive-scoped,
        // lifted at the next drive) and must never be a `repauseThrew`.
        let detaching: Promise<void>;
        try {
          detaching = publication.pauseUpstream();
        } catch {
          return { kind: "unproven", name: publication.name, op, issued };
        }
        try {
          await detaching;
        } catch {
          // The only failure a retry cannot fix: livekit set the flag, emitted
          // `UpstreamPaused`, and THEN its `replaceTrack(null)` rejected.
          return {
            kind: "unproven",
            name: publication.name,
            op,
            issued,
            threw: true,
          };
        }
        break;
      }
      case "pause":
        issued = true;
        try {
          await publication.pauseUpstream();
        } catch {
          // Caught here, but deliberately with NO attribution and no split
          // into sync-throw vs rejection: `threw` is only ever read AND-ed
          // with `op === "repause"`, so nothing a `pause` failure could carry
          // would ever be read, and inventing a field for it is how a later
          // reader talks themselves into loosening the AND. The catch exists
          // only so this failure is not mis-labelled `unreadable` by the outer
          // one — it is not a read, and the outer catch says so.
          return { kind: "unproven", name: publication.name, op, issued };
        }
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
    // Everything from here down is OBSERVATION, so a rejection below is a read
    // that threw and not the op — see {@link OneResult.unreadable}.

    // The gate emptied under us: whatever the wire says now, this sweep is not
    // the one making a promise about it.
    if (!gateHeld()) return null;
    if (publication.upstream() !== "live") {
      return { kind: "proven", name: publication.name, op };
    }
    return { kind: "unproven", name: publication.name, op, issued };
  } catch {
    // WHAT REACHES HERE, exhaustively, now that both pausing arms catch their
    // own detach: a READ — `upstreamPaused`, `upstream()`, or either
    // `gateHeld()` — or a `resumeUpstream()` that threw SYNCHRONOUSLY in the
    // repause arm (which carries `issued: false`, and is excluded from both
    // narrow sets by that). No detach failure reaches here from any arm. So
    // `unreadable` is unconditional, and `threw` is unreachable from this
    // catch: the module has exactly ONE site that assigns `threw`, and it is a
    // catch wrapped around exactly one awaited `pauseUpstream()` promise.
    //
    // Reported, never swallowed — this is the seam that turns a one-off failure
    // into a permanent silent false pause. The reads live inside this try so
    // that one torn-down publication costs its own report, not the whole
    // sweep.
    return {
      kind: "unproven",
      name: publication.name,
      op,
      issued,
      unreadable: true,
    };
  }
}

/**
 * Serialize sweeps and collapse re-entrant triggers.
 *
 * A sweep's own livekit ops emit events that `state.tsx` re-asserts the gate on,
 * so a trigger can arrive WHILE a sweep is running. Nesting there is what turns
 * one failing detach into a live-lock (see the module comment), and dropping the
 * trigger outright would miss a genuine change that landed mid-sweep. So: one
 * pass at a time, at most one TRAILING pass no matter how many triggers arrive
 * during it, and every caller gets a promise covering the work in flight —
 * `#enable()` awaits its pause before flipping E2EE on, so the await has to mean
 * something.
 *
 * `maxPasses` is the backstop for a pathological run where each trailing pass
 * triggers another: a hard cap, not a heuristic, because the alternative is a
 * renderer that cannot be hung up.
 */
export function coalescingSweeper(
  run: () => Promise<void>,
  maxPasses = 4,
  /**
   * Called when the cap ends a drive with a trigger still pending — i.e. a
   * sweep that something asked for was DROPPED. Silently discarding it is the
   * same shape as the flag that started all this: the caller's `await` resolves
   * and it is told the work completed. `#enable()` awaits its pause and then
   * flips E2EE on, so it has to be able to find out.
   */
  onDropped: () => void = () => {},
  /**
   * Called once at the START of each drive, before its first pass — i.e. at
   * every boundary between one re-entrant burst and the next. The seam
   * {@link PublishGateOptions.repausePending} is scoped by: the caller clears
   * the set here, so a repause suppressed inside a burst is re-armed for the
   * next drive rather than for the rest of the call. Clearing it anywhere
   * coarser (per episode) is a permanent per-name disarm — see the module
   * comment. It runs INSIDE the drive's try, so a throwing hook cannot strand
   * `active` and wedge every later sweep.
   */
  onDriveStart: () => void = () => {},
): { sweep(): Promise<void>; passes(): number } {
  let active: Promise<void> | null = null;
  let pending = false;
  let passes = 0;

  const drive = async (): Promise<void> => {
    try {
      onDriveStart();
      let budget = maxPasses;
      do {
        pending = false;
        passes++;
        await run();
      } while (pending && --budget > 0);
      if (pending) onDropped();
    } finally {
      pending = false;
      active = null;
    }
  };

  return {
    sweep(): Promise<void> {
      if (active) {
        pending = true;
        return active;
      }
      // The promise has to EXIST before `drive()` is invoked. `run()` executes
      // synchronously up to its first await and re-enters this method from
      // there, so `active = drive()` would still be unassigned at that point —
      // the re-entrant call would see no sweep in flight and start its own,
      // which is the very live-lock this function exists to stop. (Measured:
      // 3060 nested passes in 28 ms before this was a deferred promise.)
      let settle!: () => void;
      let fail!: (error: unknown) => void;
      const done = new Promise<void>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      });
      active = done;
      drive().then(settle, fail);
      return done;
    },
    /** Total passes run, for specs and for the cap's own assertions. */
    passes(): number {
      return passes;
    },
  };
}
