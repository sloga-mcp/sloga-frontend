/**
 * The publish gate's EPISODE state — everything `state.tsx` used to hold in
 * five private fields around {@link applyPublishGate} (R2-7, banner-honesty
 * D6).
 *
 * `publishGate.ts` owns ONE PASS: what to do to a publication and what that
 * pass could prove. Nothing in it remembers anything. Every rule that spans
 * passes — which publication is disarmed and for how long, whether this pass
 * is a confirming one, whether a dropped pass means the last clean bill was a
 * lie, when the banner may stop claiming a pause — lived in `state.tsx`, which
 * CANNOT be imported under `node --test` (Solid, livekit, `@revolt/client`).
 * So none of it had a spec, and `scripts/rtc-mutations.py`'s
 * `wiring-upstream-always-quiet` entry was carried `expect="green"` with a
 * `why_green` that says so outright: the `GatedPublication` adapter, the
 * confirm-then-report re-sweep, four episode flags and `callPauseDisproved`'s
 * whole lifecycle were unreachable by any mutation, and TWO fifth-review
 * findings lived in exactly that region.
 *
 * This module is that region, extracted, with no runtime import at all — only
 * types from `publishGate.ts`.
 *
 * 🔴 FOUR SCOPES, and collapsing any two of them is a defect that has already
 * shipped once in each direction:
 *
 *  1. DRIVE — {@link PublishGateEpisode.beginDrive}, wired to
 *     {@link coalescingSweeper}'s `onDriveStart` hook and to NOTHING else. It
 *     clears {@link PublishGateEpisode.repausePending} and nothing else.
 *     An episode-scoped pending set is not a smaller version of drive scope:
 *     it is mechanically identical to `repauseSpent` at a strictly weaker
 *     trigger, i.e. a PERMANENT per-name disarm, because a suppression is
 *     unreachable-to-lift — once a name is suppressed and its wire is live no
 *     pause is issued, so nothing is ever `proven`, so the un-spend never
 *     fires. Measured on the microtask wire model, that turns the documented
 *     mirror window from `wire=quiet` into `wire=live` with the name latched
 *     for the rest of the call (`publishGate.ts`, module comment; plan D1 (A)).
 *  2. EPISODE-START — {@link PublishGateEpisode.beginEpisode}, at the gate's
 *     0→1 reason transition. Clears the spent and pending sets, resets the
 *     confirm budget, takes back any outstanding confirm request, AND demotes
 *     the pass already in flight from confirming. Whatever failed last episode
 *     is not evidence about this one — including a confirm the last one asked
 *     for, which otherwise lands on the NEW episode's first pass and turns it
 *     into a verdict, and including the SWEEP the last one already had in the
 *     air, which otherwise lands as that verdict directly.
 *  3. EPISODE-END — {@link PublishGateEpisode.endEpisode}, at the gate's 1→0
 *     transition. Clears the same two sets and takes back the same request,
 *     resets the budget, AND withdraws `pauseDisproved` (nothing promises a
 *     pause any more, so there is no claim to withdraw), and deliberately NOT
 *     `sweepDropped`: a pass that was dropped still was not run, and the next
 *     episode's first sweep must not report a clean bill over it. And
 *     deliberately NOT the in-flight confirming phase either, unlike (2): a
 *     confirming pass landing under the gate this boundary just emptied is
 *     already refused both writes by `consume`'s `gateHeld()` check, which
 *     REPORTS instead, and demoting it here would trade that report for a
 *     confirm request its own deferral then throws away.
 *  4. CALL — {@link PublishGateEpisode.resetForCall}, at connect and at
 *     disconnect. Clears EVERYTHING. A single `reset()` covering all three of
 *     (2), (3) and (4) silently changes two of them.
 *
 * 🔴 AND ONE RULE ABOUT WHAT MAY BE SPENT, restated here because getting it
 * wrong is invisible: {@link PublishGateEpisode.repauseSpent} is fed ONLY from
 * {@link PublishGateSweep.repauseThrew}, never from
 * {@link PublishGateSweep.repauseFailed}. A spend is a permanent per-episode
 * disarm whose lift is unreachable while the wire is live, so the only failure
 * that may feed it is one a retry CANNOT fix: `pauseUpstream()`'s own promise
 * rejecting, after livekit set its flag over a sender it never detached.
 * `state.tsx:3415` fed it from `repauseFailed`; that is the line this module
 * exists to make impossible to write.
 *
 * 🔴 AND THE CONFIRM BUDGET, which is new here and is not in `publishGate.ts`.
 * Every bound that module has is PER DRIVE (`maxPasses`, `repausePending`
 * cleared at `onDriveStart`) or contingent on a detach that REJECTED. Nothing
 * bounded the number of DRIVES, and the confirm chain schedules one per
 * report: measured through the production caller shape in
 * `publishGate.test.ts` against a silent external re-attacher (application
 * code calling `sender.replaceTrack(liveTrack)` after every detach and
 * emitting nothing), the cost is exactly `2 * (confirms + 1)` attaches with no
 * termination — 102 attaches at a harness cap of 50, growing linearly. It is
 * LOUD throughout (`pauseDisproved` latches true, so the banner withdraws its
 * pause claim), so it is a resource and telemetry live-lock rather than silent
 * plaintext — which is the only reason it was allowed to ship out of wave 0
 * with the obligation named instead of fixed.
 *
 * {@link CONFIRM_BUDGET} is that bound, and it is deliberately a bound on
 * CONSECUTIVE failing confirm rounds, reset by any sweep that SAW EVERYTHING
 * IT COULD ACT ON. A plain per-episode counter of all confirms would exhaust
 * itself over a long healthy episode with four transient windows in it, and
 * the fifth transient window would then be reported as a verdict off a SINGLE
 * unconfirmed observation — the 2026-09-08 false red, re-armed one level up.
 *
 * 🔴 "Saw everything it could act on" is NOT "found nothing unproven", and
 * writing the reset the second way put the same false red back one level down.
 * A publication in {@link PublishGateEpisode.repauseSpent} over a live wire is
 * issued nothing, reads `live` in its post-condition and so lands in
 * `unproven` on EVERY pass for the rest of the episode — the spend's lift is
 * unreachable while the wire is live, which is what makes it permanent. So
 * `unproven.length === 0` is unreachable the moment anything is spent, the
 * counter never resets, and the next transient window on a DIFFERENT
 * publication is verdicted off one observation. The reset test therefore
 * excludes spent names; see {@link PublishGateEpisode.consume} for why it does
 * NOT also exclude the drive-scoped set.
 *
 * Exhausting it never makes anything quieter. The gate keeps sweeping on every
 * livekit event and every reason change exactly as before; what stops is the
 * self-driven confirm chain, and the pass that finds the budget gone is
 * promoted to a VERDICT (`pauseDisproved(true)` plus a report carrying
 * `confirmBudgetExhausted`) rather than returning with nothing said.
 */
import type {
  GatedPublication,
  PublishGateSweep,
  UpstreamState,
} from "./publishGate.ts";

/**
 * How many CONSECUTIVE confirming rounds one episode may drive before the next
 * unconfirmed observation is promoted to a verdict instead of scheduling
 * another. Reset by any sweep that saw everything it could act on, and at all
 * three lifecycle boundaries — episode start, episode end and the call.
 *
 * Four, matching {@link coalescingSweeper}'s `maxPasses`: each round is a
 * macrotask apart and drives a whole coalescing drive inside it, so four
 * rounds is far more settling time than any in-flight `replaceTrack` needs,
 * and the cost of being wrong is a louder banner rather than a quieter one.
 *
 * 🔴 "A sweep that finds nothing unproven" is not the same as "a sweep that
 * saw everything", and only the second may restore the budget. A pass the
 * cap DROPPED means the drive was cut short, so the reset sits BELOW the
 * dropped-pass check in {@link PublishGateEpisode.consume} — above it, a
 * dropped pass could restore the bound indefinitely, and the dropped arm's own
 * escalation was unreachable.
 */
export const CONFIRM_BUDGET = 4;

/**
 * Everything the episode needs from `state.tsx`, as thunks so a spec can drive
 * every branch. Deliberately narrow: the episode never sees the Room, the
 * reason set, or livekit.
 */
export interface EpisodeDeps {
  /** The reason set is non-empty. `() => this.#publishGate.size > 0`. */
  gateHeld(): boolean;
  /**
   * The stale-writer guard, in the WEAKER form this object is able to ask for:
   * "is there a live gate sweeper for the current call at all". `state.tsx`
   * binds `() => this.#gateStillCurrent?.() ?? false`, where
   * `#gateStillCurrent` is the LIVE sweeper's own captured predicate —
   * `gen === this.#gateGen && this.room() === room`, built from a monotonic
   * `#gateGen` token plus the Room that sweeper captured — and is `undefined`
   * until a sweeper exists.
   *
   * 🔴 It is NOT `() => this.room() === room` for the sweep that is ASKING,
   * and a doc claiming an equivalence that does not hold is how the original
   * `stillCurrent` regression survived review once already. This object is
   * per-Voice and outlives every sweeper, so it cannot tell a resumed call-N
   * sweep from a call-N+1 one. `state.tsx` therefore applies the PER-SWEEP
   * identity predicate at the call sites — `beginPass`, `noteDropped` and
   * `consume` are each wrapped in that sweeper's own captured closure — and
   * this dep is the second layer under them, plus the only guard available to
   * the deferred confirm, which has no sweep to ask with.
   *
   * Inside this module it gates the `proven` UN-SPEND as well as the
   * reporting: `state.tsx:3380` un-spent before its room check, so an
   * in-flight sweep for a disposed call could un-spend in the live episode.
   *
   * 🔴 Per-CALL in BOTH forms, so it cannot see an EPISODE boundary at all.
   * {@link PublishGateEpisode.beginEpisode} is what does.
   */
  stillCurrent(): boolean;
  /**
   * Defer `run` by exactly one MACROTASK and then start a sweep. A bare
   * deferral: the dedupe, the budget and the guards all live in this module,
   * and `run` is what marks the deferred pass as the CONFIRMING one.
   *
   * 🔴 The macrotask matters and is not an implementation detail. The whole
   * re-entrant burst a sweep's own `UpstreamResumed` produces runs on
   * MICROTASKS, so a confirm deferred on a microtask lands inside the burst it
   * is supposed to observe after. `setTimeout(run, 0)`, never
   * `queueMicrotask` and never a synchronous call — a synchronous `run` would
   * arm the confirming flag inside the drive that requested it.
   *
   * The caller starts the sweep after `run()` returns whether or not this
   * module armed the flag; a sweep for a disposed room is already a no-op on
   * `state.tsx`'s own room guard, and a sweep under an emptied gate is a
   * resume sweep, which is what an empty gate wants.
   */
  scheduleConfirm(run: () => void): void;
  /**
   * `callPauseDisproved` — TRUE withdraws the banner's "your audio and video
   * stay paused" claim. Only ever a withdrawal of a claim this module just
   * disproved, never a claim of its own.
   *
   * 🔴 PRECONDITION, stated because wave 2 makes this a `chipState` input:
   * TRUE is only ever written while {@link gateHeld} is true, and is only
   * MEANINGFUL while the gate is held. An empty gate makes no pause claim, so
   * there is nothing under one to withdraw — and there is no path back to
   * false under one either (`endEpisode` fires on a 1→0 transition that has
   * already happened, and the quiet arm is itself `gateHeld()`-conditioned),
   * so a TRUE written under an empty gate is a latch, not a reading.
   */
  setPauseDisproved(v: boolean): void;
  /**
   * The two console channels, kept separate because they want opposite
   * responses: `"failed"` is a call that should be publishing and may be stuck
   * muted; `"unproven"` is a held gate that could not prove the wire quiet.
   *
   * `detail` carries only what this module knows — publication NAMES
   * (`${source}/${trackSid}`, never user content) plus the flags below. The
   * caller adds the gate's reason set, which this module deliberately cannot
   * see.
   */
  report(kind: "unproven" | "failed", detail: object): void;
}

/**
 * One local publication as the sweep needs to see it, structurally — livekit's
 * `LocalTrackPublication` satisfies this, and so does a spec fake, which is
 * the point: `gatedPublicationsFrom` had no coverage while it lived inline in
 * `#sweepPublishGate`.
 */
export interface LocalPublicationLike {
  /** livekit's `Track.Source` string enum. */
  readonly source: string;
  readonly trackSid: string;
  /**
   * ABSENT for a publication mid-republish. Passed in UNFILTERED on purpose,
   * so the skip below is this module's line and is covered by this module's
   * spec.
   *
   * 🔴 OPTIONAL, not `| undefined`, because livekit's `LocalTrackPublication`
   * declares it optional and a required-but-undefined property is not
   * assignable to one — which is a compile error at the ONE call site that
   * matters and at none of the fakes.
   */
  readonly track?: LocalTrackLike | null;
  pauseUpstream(): Promise<void>;
  resumeUpstream(): Promise<void>;
}

export interface LocalTrackLike {
  readonly isUpstreamPaused: boolean;
  /** Optional for the same reason as `track` above: livekit's is. */
  readonly sender?: SenderLike | null;
}

export interface SenderLike {
  /** `RTCRtpSender.track` — `null` while detached OR while an attach is in flight. */
  readonly track: unknown;
  readonly transport?: { readonly state?: string } | null;
}

/**
 * Present livekit's local publications to the sweep. Three-valued
 * {@link UpstreamState}, from the same triple livekit's own guards read.
 *
 * 🔴 The reads are LAZY — `upstreamPaused` is a getter and `upstream` is a
 * thunk — because `applyPublishGate` reads them itself, inside its own
 * per-publication try, and reads them AGAIN after the op as the
 * post-condition. Snapshotting either here would turn the post-condition into
 * a re-assertion of the pre-condition and silently delete the only thing in
 * the stack that observes the wire.
 */
export function gatedPublicationsFrom(
  publications: Iterable<LocalPublicationLike>,
): GatedPublication[] {
  const gated: GatedPublication[] = [];
  for (const pub of publications) {
    const track = pub.track;
    // Nothing to pause and nothing to read: `unpublishTrack` clears this for a
    // whole offer/answer during every republish.
    if (!track) continue;
    gated.push({
      // Source + SID: enough to identify it in a log, never user content.
      name: `${pub.source}/${pub.trackSid}`,
      get upstreamPaused() {
        return track.isUpstreamPaused;
      },
      upstream: (): UpstreamState => {
        const sender = track.sender;
        if (!sender) return "unpublished";
        if (!sender.track) return "quiet";
        // `new` / `connecting` / `failed` and an absent transport all read as
        // live: the conservative direction, and `replaceTrack(null)` still
        // succeeds on a failed transport. Only `closed` (terminal) is quiet,
        // which is livekit's own test.
        return sender.transport?.state === "closed" ? "quiet" : "live";
      },
      pauseUpstream: () => pub.pauseUpstream(),
      resumeUpstream: () => pub.resumeUpstream(),
    });
  }
  return gated;
}

/**
 * The state one held-gate episode carries across passes, drives and sweeps.
 *
 * Wiring, which is the half a green suite cannot check — `state.tsx` must pass
 * `beginDrive` as {@link coalescingSweeper}'s FOURTH positional argument. The
 * three-argument call still compiles, and drive scope then silently degrades
 * to no scope at all.
 *
 * ```ts
 * const episode = new PublishGateEpisode(deps);
 * const sweeper = coalescingSweeper(
 *   () => this.#sweepPublishGate(room, episode.beginPass().confirming),
 *   undefined,
 *   () => episode.noteDropped(),
 *   () => episode.beginDrive(),
 * );
 * // …and inside #sweepPublishGate:
 * const result = await applyPublishGate(
 *   gatedPublicationsFrom(room.localParticipant.trackPublications.values()),
 *   () => this.#publishGate.size > 0,
 *   {
 *     repauseSpent: episode.repauseSpent(),
 *     repausePending: episode.repausePending(),
 *   },
 * );
 * episode.consume(result);
 * ```
 */
export class PublishGateEpisode {
  readonly #deps: EpisodeDeps;

  /**
   * PERMANENT per-episode disarm: publications whose `repause` REJECTED. Fed
   * only from {@link PublishGateSweep.repauseThrew}; lifted only by an
   * observation of the wire going quiet on its own, or by a lifecycle
   * boundary.
   */
  readonly #spent = new Set<string>();
  /** DRIVE-scoped disarm. Fed from `repauseFailed`; cleared by `beginDrive`. */
  readonly #pending = new Set<string>();

  /** A confirm is deferred and has not reached `beginPass` yet. */
  #confirmScheduled = false;
  /** The deferred confirm fired: the NEXT pass is the confirming one. */
  #confirmPass = false;
  /**
   * `beginPass` read `#confirmPass`; `consume` acts on it. EPISODE-scoped:
   * cleared by `beginEpisode` and by `resetForCall`, so a pass that began in
   * one episode is never consumed as confirming in the next.
   */
  #confirming = false;
  /** {@link coalescingSweeper}'s cap ended a drive with a trigger pending. */
  #sweepDropped = false;
  /** Consecutive confirming rounds since the last sweep that proved quiet. */
  #confirmRounds = 0;

  constructor(deps: EpisodeDeps) {
    this.#deps = deps;
  }

  /**
   * {@link coalescingSweeper}'s `onDriveStart` — the boundary between one
   * re-entrant burst and the next.
   *
   * 🔴 It clears the DRIVE-scoped pending set and nothing else, and it is the
   * only thing that defines that set's scope. Clearing it from a lifecycle
   * method INSTEAD is the rejected episode-scoped design: a permanent per-name
   * disarm (see the module comment). Lifecycle methods may clear it as a
   * harmless superset; none of them may be the only thing that does.
   */
  beginDrive(): void {
    this.#pending.clear();
  }

  /**
   * Start one pass of the sweeper.
   *
   * 🔴 The phase flag and the outstanding confirm REQUEST are consumed
   * TOGETHER (P9). `#confirmPass` used to be read-and-cleared only inside the
   * sweeper closure, so a trailing pass the cap DROPPED never consumed it and
   * the next sweep from any trigger — arbitrarily later — ran as `confirming`
   * without the macrotask boundary the confirm exists to provide, which under
   * D1 spends a publication off a single unconfirmed observation.
   *
   * A NON-confirming pass leaves `#confirmScheduled` alone: an ordinary
   * event-driven pass can run while a confirm is still deferred, and clearing
   * the request there would cancel a confirm that is genuinely coming.
   */
  beginPass(): { confirming: boolean } {
    const confirming = this.#confirmPass;
    this.#confirmPass = false;
    if (confirming) {
      this.#confirmScheduled = false;
      this.#confirmRounds++;
    }
    this.#confirming = confirming;
    return { confirming };
  }

  /**
   * 🔴 The LIVE set, by reference, not a copy. `applyPublishGate` re-reads both
   * option sets on every pass against the set the caller supplies, which is
   * what lets a pass arm the next one from its own report. Returning a
   * snapshot would work only for as long as every caller re-fetched it per
   * pass, and that is not a property a type can hold.
   */
  repauseSpent(): ReadonlySet<string> {
    return this.#spent;
  }

  /** The live DRIVE-scoped set. Same by-reference reasoning as above. */
  repausePending(): ReadonlySet<string> {
    return this.#pending;
  }

  /**
   * Act on one pass's report: arm, disarm, confirm, and decide whether the
   * banner may keep claiming a pause.
   */
  consume(result: PublishGateSweep): void {
    // 🔴 FIRST, before anything is read or written. A sweep for a PREVIOUS call
    // must neither report against the current one nor mutate its sets — and
    // the un-spend is a mutation, which is why this guard moved ABOVE it.
    if (!this.#deps.stillCurrent()) return;

    const confirming = this.#confirming;
    this.#confirming = false;
    // Consumed on EVERY exit path this episode takes, not only the quiet one.
    // Clearing it only inside the `unproven.length === 0` arm meant the first
    // genuinely-quiet sweep after a failure returned without withdrawing
    // `pauseDisproved` (P9's sibling).
    const dropped = this.#sweepDropped;
    this.#sweepDropped = false;

    // 🔴 WHAT THIS PASS COULD ACT ON — read BEFORE the loops below rewrite the
    // disarm sets, because it is a fact about the pass that has already run.
    //
    // A publication in `#spent` is issued NOTHING (`publishGate.ts` breaks out
    // of the repause arm with `issued` still false), its post-condition then
    // reads `live`, and it therefore lands in `unproven` on EVERY pass for the
    // rest of the episode — the spend's lift is unreachable while the wire is
    // live, which is exactly what makes a spend permanent. So the moment
    // anything is spent, `unproven.length === 0` is unreachable and a budget
    // reset conditioned on it can never fire again: four rounds burn, and then
    // a brand-new transient window on a DIFFERENT publication is verdicted off
    // a single unconfirmed observation. That is the outcome consecutive
    // scoping was chosen to prevent, reached by another route.
    //
    // 🔴 `#pending` is deliberately NOT excluded here, and the asymmetry is the
    // mechanism rather than an oversight. It is DRIVE-scoped — `beginDrive`
    // empties it before every drive's first pass — so it can never make the
    // reset permanently unreachable. Excluding it would instead let a TRAILING
    // pass inside the very drive a live-lock is feeding restore the bound that
    // drive is burning, which is the unbounded confirm chain back verbatim.
    // "the confirm chain is bounded at CONFIRM_BUDGET consecutive rounds" is
    // the spec that measures that, and it goes red if this line widens.
    const actionable = result.unproven.filter((n) => !this.#spent.has(n));

    // A repause that failed once must not be a life sentence when the wire
    // later settles on its own — per name, from both sets.
    for (const name of result.proven) {
      this.#spent.delete(name);
      this.#pending.delete(name);
    }
    // Armed on ANY pass, not gated on `confirming`: the whole re-entrant burst
    // is microtasks and the confirm is a macrotask, so a bound that waits for
    // the confirm cannot act inside the burst at all. Cleared at the next
    // drive boundary, never here.
    for (const name of result.repauseFailed) this.#pending.add(name);

    // The OPPOSITE failure: an empty gate that could not put publishing back.
    // Nothing recovers it automatically, so at least make it findable.
    if (result.failed.length > 0)
      this.#deps.report("failed", { publications: [...result.failed] });

    if (result.unproven.length === 0) {
      if (dropped) {
        // This sweep did not see everything, so it is not a clean bill.
        if (!this.#requestConfirm())
          this.#deps.report("unproven", {
            publications: [],
            droppedPass: true,
            confirmBudgetExhausted: true,
          });
        return;
      }
      // Everything this pass saw is quiet, so the confirm chain has served its
      // purpose and the budget is whole again.
      this.#confirmRounds = 0;
      // Nothing is on the wire, so the banner's pause promise is true again.
      if (this.#deps.gateHeld()) this.#deps.setPauseDisproved(false);
      return;
    }

    // Every unproven name is one this pass ISSUED NOTHING for, so it saw
    // everything it could act on and the confirm chain has nothing left to
    // drive. The budget bounds a chain the sweep itself FEEDS; an op that is
    // never issued cannot feed it, so it may not burn it either. `dropped`
    // still forbids the reset, for the same reason as in the arm above: a pass
    // the cap cut short did not see everything, full stop.
    if (actionable.length === 0 && !dropped) this.#confirmRounds = 0;

    // A single observation is not a verdict: livekit ops legitimately leave the
    // wire live for a few microtasks. Confirm on a macrotask first — unless
    // this episode has already spent its consecutive-confirm budget, in which
    // case the observation IS the verdict and falls through.
    if (!confirming && this.#requestConfirm()) return;

    const detail = {
      publications: [...result.unproven],
      ...(confirming ? {} : { confirmBudgetExhausted: true }),
    };
    // 🔴 THE VERDICT'S PRECONDITION, checked and not assumed. This block is
    // reachable with the gate ALREADY EMPTIED: a confirm deferred under a held
    // gate, the gate drains, and the confirming pass consumes an `unproven`
    // result — which an empty gate can produce, because `publishGate.ts`
    // reports a post-condition read that throws in the `resume` arm as
    // `unproven` rather than `failed`.
    //
    // Written true there it STICKS. `callPauseDisproved` goes false only via
    // `endEpisode()`, `resetForCall()` and the quiet arm above; the quiet arm
    // is itself `gateHeld()`-conditioned, and `endEpisode` fires on a 1→0
    // transition that has already happened. So there is no path back to false
    // until the next episode ends or the call does — a permanently withdrawn
    // pause claim in an otherwise healthy call.
    if (!this.#deps.gateHeld()) {
      // Still LOUD: the observation is reported, never swallowed. What an
      // empty gate may not do is write this episode's PERMANENT disarm, or a
      // signal only a held gate gives meaning to.
      this.#deps.report("unproven", detail);
      return;
    }

    // Confirmed (or out of confirms). A repause whose detach REJECTED is spent
    // for this episode: retrying cannot help, and its resume would re-attach
    // the sender and re-enter the sweep. `repauseThrew` and nothing else —
    // `repauseFailed` here would disarm the gate permanently over a failure a
    // retry could have fixed (media-E2EE review, fifth pass).
    for (const name of result.repauseThrew) {
      this.#spent.add(name);
      this.#pending.delete(name);
    }
    // The gate is held and the wire is still live. Publishing is escaping a
    // gate every layer above believes is closed, so the banner stops promising
    // a pause. That is a WITHDRAWAL of a false claim, not a new claim.
    this.#deps.setPauseDisproved(true);
    this.#deps.report("unproven", detail);
  }

  /**
   * {@link coalescingSweeper}'s `onDropped` — the cap ended a drive with a
   * trigger still pending, i.e. a sweep something asked for did not run.
   *
   * 🔴 It RE-ARMS the confirm rather than leaving a naked flag. The dropped
   * pass never reached {@link beginPass}, so a confirm the deferral already
   * armed would otherwise leak onto an arbitrary later sweep (P9); it is taken
   * back here and requested again, keeping its macrotask boundary.
   */
  noteDropped(): void {
    this.#sweepDropped = true;
    // 🔴 Only when the deferral has already FIRED. A request still outstanding
    // is a confirm that is genuinely coming; taking that one back here would
    // let the re-request below slip past the dedupe and schedule a SECOND
    // deferral.
    if (this.#confirmPass) this.#cancelConfirm();
    this.#requestConfirm();
  }

  /**
   * The gate went 0→1: a new episode. Clears the two disarm sets, restores the
   * confirm budget, takes back any outstanding confirm request, and DEMOTES
   * the pass already in flight. Whatever failed last episode is not evidence
   * about this one — including a confirm the last one asked for, and including
   * the sweep it already had in the air.
   *
   * 🔴 The `#confirming` clear is the IN-FLIGHT sibling of the `#cancelConfirm`
   * one, not a tidy-up. `#cancelConfirm` closes the DEFERRED path across this
   * boundary; without this line the SWEEP path is still open. Measured:
   * episode 1's `beginPass` arms `#confirming`, its sweep parks on an awaited
   * livekit op, the gate goes 1→0→1, and the old sweep's `consume` then lands
   * here. Nothing else stops it: {@link EpisodeDeps.stillCurrent} is per-CALL
   * in both of its forms so it passes, the pass still reads as confirming so
   * `consume` SKIPS the confirm arm, and the gate is held again so the
   * `gateHeld()` check does not stop it either. The result was `#spent` populated (a PERMANENT per-episode disarm)
   * and `setPauseDisproved(true)`, both in a brand-new episode, off the
   * previous episode's single observation. Wave 2 promotes
   * `callPauseDisproved` to a `chipState` input: that is a wrong chip in a
   * call that is fine.
   *
   * 🔴 DEMOTED, not refused, and the difference was chosen rather than
   * defaulted into. The alternative — an episode generation token compared in
   * `consume`, mirroring what `state.tsx` does per-sweeper for CALLS — refuses
   * the straddling pass outright, and that discards more than it protects. An
   * episode boundary is not a disposed Room: it is the same call, the same
   * Room and the same publications, so the pass's `failed` list (the "this
   * call should be publishing and may be stuck muted" channel), its `proven`
   * un-spend and its report are all true statements about wires that are still
   * live. A token would swallow every one of them, and would swallow every
   * NON-confirming straddling pass as well, on every gate-reason churn — a
   * much larger behaviour change than the defect asks for, in the fail-QUIET
   * direction, against a module whose stated posture where a write must be
   * withheld is "still LOUD: the observation is reported, never swallowed".
   * Demotion withholds exactly the two writes an episode owns — the spend and
   * the verdict — and turns the straddling pass into a REQUEST for a fresh
   * look inside the new episode, which is the escalation discipline the
   * confirm exists for.
   *
   * 🔴 AND IT IS `beginEpisode` ALONE, unlike `#cancelConfirm`, which all three
   * boundaries call. `endEpisode` has no next episode to protect: a confirming
   * pass landing under the EMPTY gate it left is already refused the spend and
   * the verdict by `consume`'s `gateHeld()` check, which REPORTS instead.
   * Clearing the flag there would send that pass down the confirm-request arm
   * and its deferral would then die on its own `gateHeld()` guard — a loud
   * report traded for silence. "endEpisode does NOT demote the pass in flight,
   * and the empty gate still REPORTS" is the spec that stops this asymmetry
   * being tidied into symmetry.
   */
  beginEpisode(): void {
    this.#spent.clear();
    this.#pending.clear();
    this.#cancelConfirm();
    this.#confirming = false;
    this.#confirmRounds = 0;
  }

  /**
   * The gate went 1→0. Clears the same two sets, takes back any outstanding
   * confirm request, restores the confirm budget, and withdraws the pause
   * claim — nothing promises a pause any more.
   *
   * 🔴 Deliberately does NOT clear `sweepDropped`: a pass that was dropped
   * still was not run, and the next episode's first sweep must not report a
   * clean bill over it.
   */
  endEpisode(): void {
    this.#spent.clear();
    this.#pending.clear();
    this.#cancelConfirm();
    // Consistent with both siblings: the resume sweep this boundary drives
    // must not run on the previous episode's counter.
    this.#confirmRounds = 0;
    this.#deps.setPauseDisproved(false);
  }

  /**
   * Connect and disconnect. EVERYTHING, including the flags the two episode
   * boundaries deliberately leave alone: none of this state may cross from a
   * disposed Room into a new call.
   */
  resetForCall(): void {
    this.#spent.clear();
    this.#pending.clear();
    this.#cancelConfirm();
    // 🔴 The comment that used to sit here stated the defect as its own
    // justification: "`#confirming` is an IN-FLIGHT pass's phase rather than a
    // deferred request, and the consume that reads it is guarded by
    // `stillCurrent()` — which a call boundary invalidates and an episode
    // boundary does not". Every clause of that is true, and it is exactly why
    // `beginEpisode` must clear the flag TOO rather than a reason it need not:
    // nothing `stillCurrent()` can answer sees an episode. See `beginEpisode`.
    this.#confirming = false;
    this.#sweepDropped = false;
    this.#confirmRounds = 0;
    this.#deps.setPauseDisproved(false);
  }

  /**
   * Take back an outstanding confirm: the REQUEST (`#confirmScheduled`) and the
   * flag a deferral has already armed (`#confirmPass`), together.
   *
   * 🔴 ALL THREE lifecycle boundaries call this, and that is the whole point.
   * `#requestConfirm`'s deferred closure justifies its first guard with "a
   * lifecycle boundary cleared the request while it was deferred" — a claim
   * only `resetForCall` honoured. A confirm deferred in episode 1 survived a
   * 1→0 (`endEpisode`) and a 0→1 (`beginEpisode`), passed both of the
   * closure's guards on landing (the gate is held again, the call is
   * unchanged) and armed the NEW episode's FIRST pass as confirming — which
   * skips the confirm arm in {@link consume} and goes straight to the verdict,
   * spending a publication for the rest of that episode off ONE unconfirmed
   * observation. That is P9, the defect {@link beginPass} fixed at the
   * dropped-pass site, re-armed at the episode site.
   */
  #cancelConfirm(): void {
    this.#confirmScheduled = false;
    this.#confirmPass = false;
  }

  /**
   * Ask for one confirming re-sweep. Returns whether one is coming — FALSE
   * only when this episode has spent {@link CONFIRM_BUDGET} consecutive
   * confirming rounds without a sweep proving quiet, which is the caller's cue
   * to treat the observation it has as the verdict.
   */
  #requestConfirm(): boolean {
    // At most one outstanding: every pass would otherwise schedule another.
    if (this.#confirmScheduled) return true;
    if (this.#confirmRounds >= CONFIRM_BUDGET) return false;
    this.#confirmScheduled = true;
    this.#deps.scheduleConfirm(() => {
      // A lifecycle boundary cleared the request while it was deferred.
      if (!this.#confirmScheduled) return;
      if (!this.#deps.gateHeld() || !this.#deps.stillCurrent()) {
        // Nothing is coming, so the request must not stay outstanding — it
        // would block every later confirm in this episode.
        this.#confirmScheduled = false;
        return;
      }
      // Consumed together with the request, in `beginPass`.
      this.#confirmPass = true;
    });
    return true;
  }
}
