// The publish gate's EPISODE state — the region that had no spec at all.
//
// `state.tsx` cannot be imported under `node --test` (Solid, livekit,
// `@revolt/client`), so every rule that spans passes lived where no spec and no
// mutation could reach it: `scripts/rtc-mutations.py`'s
// `wiring-upstream-always-quiet` entry is carried `expect="green"` with a
// `why_green` naming exactly what was uncovered — the `GatedPublication`
// adapter, the confirm-then-report re-sweep, four episode flags and
// `callPauseDisproved`'s whole lifecycle — and TWO fifth-review findings lived
// in it.
//
// These specs drive the extracted module. Where a rule is about the SWEEP they
// drive the real `applyPublishGate` through the real `gatedPublicationsFrom`,
// so the adapter is covered by the module that consumes it rather than by a
// re-implementation.
//
// 🔴 WHAT THIS FILE DOES NOT MODEL, stated so it is not read as coverage it
// lacks. `publishGate.test.ts` owns the faithful livekit-client 2.15.13 fake —
// the per-track FIFO mutex, the republish, and the fact that `replaceTrack`
// sets `sender.track` in a queued TASK immediately before resolving. The fake
// here is deliberately simpler and reproduces only what the adapter reads
// (`isUpstreamPaused`, `sender`, `sender.track`, `sender.transport.state`).
// Anything about the WINDOW in which the observation lies belongs there, not
// here.
import assert from "node:assert/strict";
import test from "node:test";

import {
  type PublishGateSweep,
  applyPublishGate,
  coalescingSweeper,
} from "./publishGate.ts";
import {
  type LocalPublicationLike,
  CONFIRM_BUDGET,
  PublishGateEpisode,
  gatedPublicationsFrom,
} from "./publishGateEpisode.ts";

// ---- Fakes ------------------------------------------------------------------

/** Only what the adapter reads. See the file header for what this is NOT. */
class FakeSender {
  track: string | null = "raw";
  transport: { state: string } | undefined;
  constructor(transportState?: string) {
    if (transportState !== undefined)
      this.transport = { state: transportState };
  }
}

class FakeTrack {
  isUpstreamPaused = false;
  sender: FakeSender | undefined = new FakeSender();
}

/**
 * One local publication, structurally. livekit's `LocalTrackPublication`
 * satisfies the same interface; nothing here imports livekit.
 *
 * `pauseUpstream` / `resumeUpstream` reproduce the ONE bookkeeping detail every
 * episode rule turns on: livekit's flag is written BEFORE the detach, and both
 * methods early-return on it.
 */
class FakePub implements LocalPublicationLike {
  readonly source: string;
  readonly trackSid: string;
  track: FakeTrack | null;
  pauseCalls = 0;
  resumeCalls = 0;
  /**
   * Something else re-attaches the sender as soon as the detach lands
   * (`setProcessor`, `setMediaStreamTrack`, `handleTrackUnmuteEvent`), so the
   * post-condition reads live over a pause that RESOLVED.
   */
  reattaches = false;

  constructor(source = "microphone", trackSid = "TR_1") {
    this.source = source;
    this.trackSid = trackSid;
    this.track = new FakeTrack();
  }

  get name(): string {
    return `${this.source}/${this.trackSid}`;
  }

  async pauseUpstream(): Promise<void> {
    this.pauseCalls++;
    const track = this.track;
    const sender = track?.sender;
    if (!track || !sender || track.isUpstreamPaused) return;
    track.isUpstreamPaused = true;
    await Promise.resolve();
    sender.track = null;
    if (this.reattaches) sender.track = "raw";
  }

  async resumeUpstream(): Promise<void> {
    this.resumeCalls++;
    const track = this.track;
    const sender = track?.sender;
    if (!track || !sender || !track.isUpstreamPaused) return;
    track.isUpstreamPaused = false;
    await Promise.resolve();
    sender.track = "raw";
  }
}

/**
 * A complete {@link PublishGateSweep}. Every field is REQUIRED on the real
 * type, so a fake result that omits one is asserting against a shape
 * `applyPublishGate` cannot produce.
 */
function sweepOf(partial: Partial<PublishGateSweep> = {}): PublishGateSweep {
  return {
    unproven: [],
    failed: [],
    repauseFailed: [],
    repauseThrew: [],
    proven: [],
    ...partial,
  };
}

/**
 * The episode plus the five deps, driven exactly as `state.tsx` will drive
 * them: `scheduleConfirm` QUEUES `run` (a macrotask deferral, never
 * synchronous), and firing it is the spec's job — which is what makes the
 * confirm's macrotask boundary observable instead of assumed.
 */
function makeEpisode(options: { gateHeld?: boolean } = {}) {
  const state = {
    gateHeld: options.gateHeld ?? true,
    stillCurrent: true,
    disproved: [] as boolean[],
    reports: [] as { kind: string; detail: Record<string, unknown> }[],
    deferred: [] as (() => void)[],
  };
  const episode = new PublishGateEpisode({
    gateHeld: () => state.gateHeld,
    stillCurrent: () => state.stillCurrent,
    scheduleConfirm: (run) => {
      state.deferred.push(run);
    },
    setPauseDisproved: (v) => {
      state.disproved.push(v);
    },
    report: (kind, detail) => {
      state.reports.push({ kind, detail: detail as Record<string, unknown> });
    },
  });
  return {
    episode,
    state,
    /** The caller's deferral: run the episode's callback, then sweep. */
    fireConfirm(): boolean {
      const run = state.deferred.shift();
      if (!run) return false;
      run();
      return true;
    },
    /** `state.tsx`'s `#sweepPublishGate`, minus the room and the reason set. */
    async sweep(pubs: LocalPublicationLike[]): Promise<PublishGateSweep> {
      const result = await applyPublishGate(
        gatedPublicationsFrom(pubs),
        () => state.gateHeld,
        {
          repauseSpent: episode.repauseSpent(),
          repausePending: episode.repausePending(),
        },
      );
      episode.consume(result);
      return result;
    },
  };
}

// ---- gatedPublicationsFrom: the adapter that had no coverage ---------------

test("a publication with no track is SKIPPED, and the rest are presented", () => {
  const mic = new FakePub("microphone", "TR_1");
  const cam = new FakePub("camera", "TR_2");
  // Mid-republish: `unpublishTrack` clears this for a whole offer/answer.
  const republishing = new FakePub("screenshare", "TR_3");
  republishing.track = null;
  // 🔴 UNFILTERED on purpose: the caller must not pre-filter, or this line is
  // the caller's and goes uncovered again.
  const gated = gatedPublicationsFrom([mic, republishing, cam]);
  assert.deepEqual(
    gated.map((g) => g.name),
    ["microphone/TR_1", "camera/TR_2"],
  );
});

test("the name is source/sid — an identifier, never user content", () => {
  const gated = gatedPublicationsFrom([new FakePub("screenshare", "TR_9")]);
  assert.equal(gated[0]!.name, "screenshare/TR_9");
});

test("no sender at all is `unpublished`, and a detached one is `quiet`", () => {
  const pub = new FakePub();
  pub.track!.sender = undefined;
  assert.equal(gatedPublicationsFrom([pub])[0]!.upstream(), "unpublished");
  pub.track!.sender = new FakeSender();
  pub.track!.sender.track = null;
  assert.equal(gatedPublicationsFrom([pub])[0]!.upstream(), "quiet");
});

test("only a CLOSED transport is quiet", () => {
  const pub = new FakePub();
  pub.track!.sender = new FakeSender("closed");
  assert.equal(gatedPublicationsFrom([pub])[0]!.upstream(), "quiet");
});

test("`new`, `connecting`, `failed` and an ABSENT transport all read live", () => {
  // The conservative direction, and livekit's own test: `replaceTrack(null)`
  // still succeeds on a failed transport, so calling any of these quiet would
  // skip the op and then call the result proven.
  for (const state of [undefined, "new", "connecting", "failed"]) {
    const pub = new FakePub();
    pub.track!.sender = new FakeSender(state);
    assert.equal(
      gatedPublicationsFrom([pub])[0]!.upstream(),
      "live",
      `transport state ${String(state)} was not treated as live`,
    );
  }
});

test("the reads are LAZY, so the post-condition sees the wire the op left", () => {
  // Snapshotting either read here would turn `applyPublishGate`'s
  // post-condition into a re-assertion of its pre-condition and delete the only
  // observation of the wire in the whole stack.
  const pub = new FakePub();
  const gated = gatedPublicationsFrom([pub])[0]!;
  assert.equal(gated.upstream(), "live");
  assert.equal(gated.upstreamPaused, false);
  pub.track!.sender!.track = null;
  pub.track!.isUpstreamPaused = true;
  assert.equal(gated.upstream(), "quiet");
  assert.equal(gated.upstreamPaused, true);
});

test("the adapter drives the REAL sweep: a held gate pauses a live sender", async () => {
  const h = makeEpisode();
  const pub = new FakePub();
  const result = await h.sweep([pub]);
  assert.equal(pub.pauseCalls, 1);
  assert.deepEqual(result.unproven, []);
  assert.equal(pub.track!.sender!.track, null, "the wire is not quiet");
});

// ---- The confirm phase ------------------------------------------------------

test("a first unproven sweep schedules a confirm and does NOT disprove the pause", () => {
  const h = makeEpisode();
  h.episode.beginPass();
  h.episode.consume(sweepOf({ unproven: ["microphone/TR_1"] }));
  assert.equal(h.state.deferred.length, 1, "no confirm was requested");
  assert.deepEqual(
    h.state.disproved,
    [],
    "the banner withdrew its pause claim off a SINGLE observation",
  );
  assert.deepEqual(h.state.reports, [], "and reported before confirming");
});

test("the confirming sweep disproves the pause and reports", () => {
  const h = makeEpisode();
  h.episode.beginPass();
  h.episode.consume(sweepOf({ unproven: ["microphone/TR_1"] }));
  h.fireConfirm();
  assert.deepEqual(h.episode.beginPass(), { confirming: true });
  h.episode.consume(sweepOf({ unproven: ["microphone/TR_1"] }));
  assert.deepEqual(h.state.disproved, [true]);
  assert.deepEqual(h.state.reports, [
    { kind: "unproven", detail: { publications: ["microphone/TR_1"] } },
  ]);
});

test("a confirming sweep that finds nothing unproven RESTORES the claim", () => {
  const h = makeEpisode();
  h.episode.beginPass();
  h.episode.consume(sweepOf({ unproven: ["microphone/TR_1"] }));
  h.fireConfirm();
  h.episode.beginPass();
  h.episode.consume(sweepOf({ proven: ["microphone/TR_1"] }));
  assert.deepEqual(h.state.disproved, [false]);
  assert.deepEqual(h.state.reports, []);
});

test("an EMPTY gate never restores a claim it does not make", () => {
  const h = makeEpisode({ gateHeld: false });
  h.episode.beginPass();
  h.episode.consume(sweepOf());
  assert.deepEqual(h.state.disproved, []);
});

// ---- The verdict's precondition: a HELD gate -------------------------------

test("the verdict never fires under an EMPTY gate, where it would LATCH", () => {
  // Reachable, and it latches. `callPauseDisproved` goes false only via
  // `endEpisode()`, `resetForCall()` and the quiet arm — and the quiet arm is
  // itself `gateHeld()`-conditioned while `endEpisode` fires on a 1→0
  // transition that has already happened. So a TRUE written with the gate
  // already empty has no path back to false until the next episode ends or the
  // call does. Wave 2 makes this signal a `chipState` input, at which point
  // that is a permanently wrong chip in an otherwise healthy call.
  const h = makeEpisode();
  h.episode.beginPass();
  h.episode.consume(sweepOf({ unproven: ["microphone/TR_1"] }));
  h.fireConfirm();
  h.episode.beginPass();
  // The gate drains while the confirming sweep is in flight. An empty gate can
  // still produce `unproven`: `publishGate.ts` reports a post-condition read
  // that throws in the `resume` arm as `unproven`, not `failed`.
  h.state.gateHeld = false;
  h.episode.consume(
    sweepOf({
      unproven: ["microphone/TR_1"],
      repauseFailed: ["microphone/TR_1"],
      repauseThrew: ["microphone/TR_1"],
    }),
  );
  assert.deepEqual(
    h.state.disproved,
    [],
    "an empty gate withdrew a pause claim it was not making, and it sticks",
  );
  assert.deepEqual(
    [...h.episode.repauseSpent()],
    [],
    "an empty gate wrote the episode's PERMANENT disarm",
  );
  // 🔴 And it is not quieter for being ungated: the observation is still
  // reported on the same channel. Only the two writes are withheld.
  assert.deepEqual(h.state.reports, [
    { kind: "unproven", detail: { publications: ["microphone/TR_1"] } },
  ]);
});

test("…and a held gate still gets the verdict on the same input", () => {
  // The other half of the control: without this, gating the verdict on
  // `gateHeld()` could be deleted entirely and the spec above stays green.
  const h = makeEpisode();
  h.episode.beginPass();
  h.episode.consume(sweepOf({ unproven: ["microphone/TR_1"] }));
  h.fireConfirm();
  h.episode.beginPass();
  h.episode.consume(
    sweepOf({
      unproven: ["microphone/TR_1"],
      repauseFailed: ["microphone/TR_1"],
      repauseThrew: ["microphone/TR_1"],
    }),
  );
  assert.deepEqual(h.state.disproved, [true]);
  assert.deepEqual([...h.episode.repauseSpent()], ["microphone/TR_1"]);
});

test("beginPass consumes the phase flag AND the outstanding request together", () => {
  // P9. The flag used to be read-and-cleared only inside the sweeper closure,
  // so it could survive onto an arbitrary later pass.
  const h = makeEpisode();
  h.episode.beginPass();
  h.episode.consume(sweepOf({ unproven: ["microphone/TR_1"] }));
  h.fireConfirm();
  assert.deepEqual(h.episode.beginPass(), { confirming: true });
  assert.deepEqual(
    h.episode.beginPass(),
    { confirming: false },
    "the phase flag survived the pass that consumed it",
  );
  // The request went with it, so the next unproven pass may ask again.
  h.episode.consume(sweepOf({ unproven: ["microphone/TR_1"] }));
  assert.equal(h.state.deferred.length, 1, "the request was not consumed");
});

test("a NON-confirming pass leaves a deferred confirm alone", () => {
  // An ordinary event-driven sweep runs between the request and the deferral
  // all the time; cancelling the request there loses a confirm that is coming.
  const h = makeEpisode();
  h.episode.beginPass();
  h.episode.consume(sweepOf({ unproven: ["microphone/TR_1"] }));
  h.episode.beginPass();
  h.episode.consume(sweepOf({ unproven: ["microphone/TR_1"] }));
  assert.equal(h.state.deferred.length, 1, "a second confirm was requested");
  h.fireConfirm();
  assert.deepEqual(h.episode.beginPass(), { confirming: true });
});

test("at most ONE confirm is outstanding, however many passes ask", () => {
  const h = makeEpisode();
  for (let i = 0; i < 5; i++) {
    h.episode.beginPass();
    h.episode.consume(sweepOf({ unproven: ["microphone/TR_1"] }));
  }
  assert.equal(h.state.deferred.length, 1);
});

test("a deferred confirm that lands under an EMPTY gate arms nothing", () => {
  const h = makeEpisode();
  h.episode.beginPass();
  h.episode.consume(sweepOf({ unproven: ["microphone/TR_1"] }));
  h.state.gateHeld = false;
  h.fireConfirm();
  assert.deepEqual(h.episode.beginPass(), { confirming: false });
  // …and the request must not stay outstanding, or every later confirm in this
  // episode is blocked by a dedupe flag nothing will ever clear.
  h.state.gateHeld = true;
  h.episode.consume(sweepOf({ unproven: ["microphone/TR_1"] }));
  assert.equal(h.state.deferred.length, 1);
});

test("a deferred confirm that lands for a DISPOSED call arms nothing", () => {
  const h = makeEpisode();
  h.episode.beginPass();
  h.episode.consume(sweepOf({ unproven: ["microphone/TR_1"] }));
  h.state.stillCurrent = false;
  h.fireConfirm();
  assert.deepEqual(h.episode.beginPass(), { confirming: false });
});

// ---- A dropped pass is not a clean bill ------------------------------------

test("a dropped pass RE-ARMS the confirm instead of leaking a naked flag", () => {
  // P9. The dropped trailing pass never reaches `beginPass`, so the flag the
  // deferral already armed would land on an arbitrary later sweep — which,
  // under D1, spends a publication off a single unconfirmed observation.
  const h = makeEpisode();
  h.episode.beginPass();
  h.episode.consume(sweepOf({ unproven: ["microphone/TR_1"] }));
  h.fireConfirm(); // the confirming flag is armed…
  h.episode.noteDropped(); // …and the pass that would consume it is dropped
  assert.deepEqual(
    h.episode.beginPass(),
    { confirming: false },
    "a dropped pass left the confirming flag on the next sweep",
  );
  assert.equal(h.state.deferred.length, 1, "the confirm was not re-armed");
});

test("sweepDropped is consumed on EVERY exit path, not only the quiet one", () => {
  // P9's sibling: cleared only inside the `unproven.length === 0` arm, so the
  // first genuinely-quiet sweep after a failure returned without withdrawing
  // `callPauseDisproved`.
  const h = makeEpisode();
  h.episode.noteDropped();
  // An unproven pass: the drop is consumed here, on the reporting path.
  h.episode.beginPass();
  h.episode.consume(sweepOf({ unproven: ["microphone/TR_1"] }));
  // Now a genuinely quiet sweep. If the drop had survived it, this would
  // schedule instead of restoring the claim.
  h.episode.beginPass();
  h.episode.consume(sweepOf());
  assert.deepEqual(h.state.disproved, [false]);
});

test("a quiet sweep over a DROPPED pass is not a clean bill", () => {
  const h = makeEpisode();
  h.episode.noteDropped();
  assert.equal(h.state.deferred.length, 1, "the drop did not re-arm a confirm");
  h.episode.beginPass();
  h.episode.consume(sweepOf());
  assert.deepEqual(
    h.state.disproved,
    [],
    "the sweep did not see everything, so it may not restore the claim",
  );
  // Once the confirm runs over a sweep that DID see everything, it comes back.
  h.fireConfirm();
  h.episode.beginPass();
  h.episode.consume(sweepOf());
  assert.deepEqual(h.state.disproved, [false]);
});

// ---- What may be spent, and for how long -----------------------------------

test("ONLY repauseThrew spends — repauseFailed never does", () => {
  // A spend is a PERMANENT per-episode disarm whose lift is unreachable while
  // the wire is live. `state.tsx:3415` fed it from `repauseFailed`, i.e. from a
  // pause that RESOLVED over a re-attached wire, which a retry can fix.
  const h = makeEpisode();
  h.episode.beginPass();
  h.episode.consume(sweepOf({ unproven: ["microphone/TR_1"] }));
  h.fireConfirm();
  h.episode.beginPass();
  h.episode.consume(
    sweepOf({
      unproven: ["microphone/TR_1"],
      repauseFailed: ["microphone/TR_1"],
    }),
  );
  assert.deepEqual(
    [...h.episode.repauseSpent()],
    [],
    "a repause that RESOLVED over a re-attached wire was spent permanently",
  );
});

test("a detach that THREW is spent, on the confirming pass", () => {
  const h = makeEpisode();
  h.episode.beginPass();
  h.episode.consume(sweepOf({ unproven: ["microphone/TR_1"] }));
  h.fireConfirm();
  h.episode.beginPass();
  h.episode.consume(
    sweepOf({
      unproven: ["microphone/TR_1"],
      repauseFailed: ["microphone/TR_1"],
      repauseThrew: ["microphone/TR_1"],
    }),
  );
  assert.deepEqual([...h.episode.repauseSpent()], ["microphone/TR_1"]);
  assert.deepEqual(
    [...h.episode.repausePending()],
    [],
    "a spent name was left in the drive-scoped set as well",
  );
});

test("an UNCONFIRMED pass spends nothing, however it failed", () => {
  const h = makeEpisode();
  h.episode.beginPass();
  h.episode.consume(
    sweepOf({
      unproven: ["microphone/TR_1"],
      repauseFailed: ["microphone/TR_1"],
      repauseThrew: ["microphone/TR_1"],
    }),
  );
  assert.deepEqual([...h.episode.repauseSpent()], []);
});

test("repauseFailed arms the DRIVE-scoped set on ANY pass, confirming or not", () => {
  // The whole re-entrant burst is microtasks and the confirm is a macrotask, so
  // a bound that waits for `confirming` cannot act inside the burst at all.
  const h = makeEpisode();
  h.episode.beginPass();
  h.episode.consume(
    sweepOf({
      unproven: ["microphone/TR_1"],
      repauseFailed: ["microphone/TR_1"],
    }),
  );
  assert.deepEqual([...h.episode.repausePending()], ["microphone/TR_1"]);
});

test("a later `proven` un-spends BOTH sets, and the next sweep issues again", async () => {
  // The un-spend is the only lift a permanent disarm has, so a spec that stops
  // at the set's contents has not shown the gate recovered. This one runs the
  // real sweep before and after and counts the ops that reached livekit.
  const h = makeEpisode();
  const pub = new FakePub();
  // {flag: true, live} — the enable flip's republish. Sweeps to `repause`.
  pub.track!.isUpstreamPaused = true;
  pub.reattaches = true;

  h.episode.beginPass();
  h.episode.consume(sweepOf({ unproven: [pub.name] }));
  h.fireConfirm();
  h.episode.beginPass();
  h.episode.consume(
    sweepOf({
      unproven: [pub.name],
      repauseFailed: [pub.name],
      repauseThrew: [pub.name],
    }),
  );
  assert.deepEqual([...h.episode.repauseSpent()], [pub.name]);

  h.episode.beginPass();
  const suppressed = await h.sweep([pub]);
  assert.equal(pub.resumeCalls, 0, "a spent repause issued its resume anyway");
  assert.deepEqual(suppressed.unproven, [pub.name], "…and it still reports");

  // The wire settles on its own — someone else's detach, a device change.
  h.episode.beginPass();
  h.episode.consume(sweepOf({ proven: [pub.name] }));
  assert.deepEqual([...h.episode.repauseSpent()], []);
  assert.deepEqual([...h.episode.repausePending()], []);

  h.episode.beginPass();
  await h.sweep([pub]);
  assert.equal(pub.resumeCalls, 1, "the un-spend did not re-arm the op");
});

// ---- Drive scope, which IS the mechanism -----------------------------------

test("beginDrive clears repausePending and NOT repauseSpent", () => {
  // 🔴 Clearing the pending set anywhere coarser than the drive makes it
  // mechanically identical to `repauseSpent` at a weaker trigger — a permanent
  // per-name disarm, because a suppression is unreachable to lift.
  const h = makeEpisode();
  h.episode.beginPass();
  h.episode.consume(sweepOf({ unproven: ["a/1"] }));
  h.fireConfirm();
  h.episode.beginPass();
  h.episode.consume(
    sweepOf({
      unproven: ["a/1", "b/2"],
      repauseFailed: ["a/1", "b/2"],
      repauseThrew: ["a/1"],
    }),
  );
  assert.deepEqual([...h.episode.repauseSpent()], ["a/1"]);
  assert.deepEqual([...h.episode.repausePending()], ["b/2"]);
  h.episode.beginDrive();
  assert.deepEqual([...h.episode.repausePending()], []);
  assert.deepEqual(
    [...h.episode.repauseSpent()],
    ["a/1"],
    "the drive boundary cleared the PERMANENT set",
  );
});

test("the pending set survives every pass WITHIN one drive", async () => {
  // Wired exactly as `state.tsx` must wire it: `beginDrive` is
  // `coalescingSweeper`'s FOURTH positional argument. The three-argument call
  // still compiles, and drive scope then degrades to no scope at all.
  const h = makeEpisode();
  const starts: number[] = [];
  let burst = true;
  const sweeper = coalescingSweeper(
    async () => {
      h.episode.beginPass();
      h.episode.consume(sweepOf({ unproven: ["a/1"], repauseFailed: ["a/1"] }));
      if (burst) {
        burst = false;
        void sweeper.sweep();
      }
      await Promise.resolve();
    },
    4,
    () => h.episode.noteDropped(),
    () => {
      starts.push(sweeper.passes());
      h.episode.beginDrive();
    },
  );
  await sweeper.sweep();
  assert.deepEqual(starts, [0], "one drive");
  assert.equal(sweeper.passes(), 2, "two passes in it");
  assert.deepEqual(
    [...h.episode.repausePending()],
    ["a/1"],
    "the suppression was lifted inside the burst it exists to bound",
  );
  await sweeper.sweep();
  assert.deepEqual(starts, [0, 2], "a second drive re-armed it");
});

// ---- The stale-call guard ---------------------------------------------------

test("a consume for a DISPOSED call reports nothing and mutates nothing", () => {
  // 🔴 Including the un-spend, which ran BEFORE the room guard at
  // `state.tsx:3380` — so an in-flight sweep for a disposed call could un-spend
  // in the live episode.
  const h = makeEpisode();
  h.episode.beginPass();
  h.episode.consume(sweepOf({ unproven: ["a/1"] }));
  h.fireConfirm();
  h.episode.beginPass();
  h.episode.consume(
    sweepOf({
      unproven: ["a/1"],
      repauseFailed: ["a/1"],
      repauseThrew: ["a/1"],
    }),
  );
  const reportsBefore = h.state.reports.length;
  const disprovedBefore = h.state.disproved.length;

  h.state.stillCurrent = false;
  h.episode.beginPass();
  h.episode.consume(
    sweepOf({
      proven: ["a/1"],
      failed: ["b/2"],
      unproven: ["c/3"],
      repauseFailed: ["c/3"],
    }),
  );
  assert.deepEqual(
    [...h.episode.repauseSpent()],
    ["a/1"],
    "a disposed call's sweep un-spent in the live episode",
  );
  assert.deepEqual([...h.episode.repausePending()], []);
  assert.equal(h.state.reports.length, reportsBefore, "and it reported");
  assert.equal(h.state.disproved.length, disprovedBefore);
});

// ---- The opposite failure ---------------------------------------------------

test("a failed RESUME is reported on its own channel and spends nothing", () => {
  // Folding it into `unproven` meant a caller that (correctly) acts only on a
  // held gate discarded it entirely: silently muted, no telemetry.
  const h = makeEpisode({ gateHeld: false });
  h.episode.beginPass();
  h.episode.consume(sweepOf({ failed: ["microphone/TR_1"] }));
  assert.deepEqual(h.state.reports, [
    { kind: "failed", detail: { publications: ["microphone/TR_1"] } },
  ]);
  assert.deepEqual([...h.episode.repauseSpent()], []);
  assert.equal(h.state.deferred.length, 0, "a resume failure asked to confirm");
});

// ---- Three lifecycle scopes, plus the drive as a fourth --------------------

function loaded() {
  const h = makeEpisode();
  h.episode.beginPass();
  h.episode.consume(sweepOf({ unproven: ["a/1"] }));
  h.fireConfirm();
  h.episode.beginPass();
  h.episode.consume(
    sweepOf({
      unproven: ["a/1", "b/2"],
      repauseFailed: ["a/1", "b/2"],
      repauseThrew: ["a/1"],
    }),
  );
  // A dropped trailing pass, with the confirm it re-armed consumed cleanly, so
  // the ONLY flag still set when a lifecycle method runs is `sweepDropped`.
  h.episode.noteDropped();
  h.fireConfirm();
  h.episode.beginPass();
  h.state.disproved.length = 0;
  h.state.reports.length = 0;
  return h;
}

test("beginEpisode clears the two disarm sets, and only those", () => {
  const h = loaded();
  h.episode.beginEpisode();
  assert.deepEqual([...h.episode.repauseSpent()], []);
  assert.deepEqual([...h.episode.repausePending()], []);
  assert.deepEqual(
    h.state.disproved,
    [],
    "episode START withdrew a claim it is not making yet",
  );
  // `sweepDropped` survives: the pass still was not run.
  h.episode.beginPass();
  h.episode.consume(sweepOf());
  assert.deepEqual(h.state.disproved, [], "the dropped pass was forgotten");
});

test("endEpisode also withdraws the pause claim, and NOT sweepDropped", () => {
  const h = loaded();
  h.episode.endEpisode();
  assert.deepEqual([...h.episode.repauseSpent()], []);
  assert.deepEqual([...h.episode.repausePending()], []);
  assert.deepEqual(h.state.disproved, [false]);
  h.episode.beginPass();
  h.episode.consume(sweepOf());
  assert.deepEqual(
    h.state.disproved,
    [false],
    "a dropped pass was cleared at the episode boundary",
  );
  assert.equal(h.state.deferred.length, 1, "it must confirm instead");
});

test("resetForCall clears EVERYTHING, including what the two others keep", () => {
  const h = loaded();
  h.episode.resetForCall();
  assert.deepEqual([...h.episode.repauseSpent()], []);
  assert.deepEqual([...h.episode.repausePending()], []);
  assert.deepEqual(h.state.disproved, [false]);
  h.episode.beginPass();
  h.episode.consume(sweepOf());
  assert.deepEqual(
    h.state.disproved,
    [false, false],
    "the dropped-pass flag crossed the call boundary",
  );
});

test("resetForCall cancels a confirm already deferred", () => {
  const h = makeEpisode();
  h.episode.beginPass();
  h.episode.consume(sweepOf({ unproven: ["a/1"] }));
  h.episode.resetForCall();
  h.fireConfirm();
  assert.deepEqual(
    h.episode.beginPass(),
    { confirming: false },
    "a confirm deferred before the call boundary armed a pass after it",
  );
});

test("beginEpisode cancels a confirm already deferred", () => {
  const h = makeEpisode();
  h.episode.beginPass();
  h.episode.consume(sweepOf({ unproven: ["a/1"] }));
  h.episode.beginEpisode();
  h.fireConfirm();
  assert.deepEqual(
    h.episode.beginPass(),
    { confirming: false },
    "a confirm deferred before the episode boundary armed a pass after it",
  );
});

test("endEpisode cancels a confirm already deferred", () => {
  const h = makeEpisode();
  h.episode.beginPass();
  h.episode.consume(sweepOf({ unproven: ["a/1"] }));
  h.episode.endEpisode();
  h.fireConfirm();
  assert.deepEqual(
    h.episode.beginPass(),
    { confirming: false },
    "a confirm deferred before the episode boundary armed a pass after it",
  );
});

test("a confirm deferred in one episode never arms the NEXT episode's pass", () => {
  // 🔴 P9 at the EPISODE site. `#requestConfirm`'s deferred closure justifies
  // its first guard with "a lifecycle boundary cleared the request while it was
  // deferred" — a claim only `resetForCall` honoured. Both of the closure's
  // other guards PASS across a 1→0→1: the gate is held again and the call is
  // unchanged. So the stale macrotask armed the new episode's FIRST pass as
  // confirming, which skips the confirm arm in `consume` and goes straight to
  // the verdict — spending a publication, for the rest of the new episode, off
  // one unconfirmed observation.
  const h = makeEpisode();
  h.episode.beginPass();
  h.episode.consume(sweepOf({ unproven: ["b/2"] }));
  assert.equal(h.state.deferred.length, 1, "no confirm was deferred");
  h.episode.endEpisode(); // the gate goes 1→0…
  h.episode.beginEpisode(); // …and refills before the macrotask lands
  h.state.disproved.length = 0;
  h.fireConfirm();
  assert.deepEqual(
    h.episode.beginPass(),
    { confirming: false },
    "the new episode's FIRST pass ran as confirming",
  );
  h.episode.consume(sweepOf({ unproven: ["b/2"], repauseThrew: ["b/2"] }));
  assert.deepEqual(
    [...h.episode.repauseSpent()],
    [],
    "one observation disarmed the gate for a publication for the episode",
  );
  assert.deepEqual(h.state.disproved, []);
  assert.deepEqual(h.state.reports, []);
  assert.equal(h.state.deferred.length, 1, "it must confirm first instead");
});

test("an in-flight sweep never verdicts in the episode that began after it", () => {
  // 🔴 The IN-FLIGHT sibling of the spec above, landing on the same two writes.
  // That one closes the DEFERRED confirm across an episode boundary; this one
  // closes the SWEEP that was already in the air when the boundary happened.
  //
  // `beginPass` arms the confirming phase, the sweep parks on an awaited
  // livekit op, the gate goes 1→0→1, and episode 1's `consume` lands inside
  // episode 2. Nothing else stops it: `stillCurrent()` is per-CALL in both of
  // the forms `state.tsx` can bind (the episode dep answers "is there a live
  // gate sweeper for the current call at all", and the per-sweep predicate at
  // the call site is `gen === #gateGen && room() === room`) so neither can see
  // an episode boundary; the pass still reads as confirming, so the confirm
  // arm is SKIPPED; and the gate is held again, so the `gateHeld()` check
  // passes too. Measured against the unfixed module, with exactly this script:
  // `repauseSpent() === ["microphone/TR_1"]`, `disproved === [true]` and one
  // `unproven` report carrying no `confirmBudgetExhausted` — i.e. a full,
  // confident verdict in a brand-new episode off the PREVIOUS episode's single
  // observation. Wave 2 makes `callPauseDisproved` a `chipState` input, so that
  // is a wrong chip in a call that is fine.
  const h = makeEpisode();
  h.episode.beginPass();
  h.episode.consume(sweepOf({ unproven: ["microphone/TR_1"] }));
  assert.equal(h.state.deferred.length, 1, "no confirm was deferred");
  assert.equal(h.fireConfirm(), true);
  assert.deepEqual(
    h.episode.beginPass(),
    { confirming: true },
    "the confirming pass never started, so nothing is in flight to straddle",
  );

  // …and while its sweep is parked, the gate drains and refills.
  h.state.gateHeld = false;
  h.episode.endEpisode();
  h.state.gateHeld = true;
  h.episode.beginEpisode();
  h.state.disproved.length = 0;
  h.state.reports.length = 0;

  // Episode 1's sweep lands, in episode 2.
  h.episode.consume(
    sweepOf({
      unproven: ["microphone/TR_1"],
      repauseThrew: ["microphone/TR_1"],
    }),
  );

  assert.deepEqual(
    [...h.episode.repauseSpent()],
    [],
    "the previous episode's sweep wrote this episode's PERMANENT disarm",
  );
  assert.deepEqual(
    h.state.disproved,
    [],
    "the previous episode's sweep withdrew this episode's pause claim",
  );
  assert.deepEqual(
    h.state.reports,
    [],
    "the previous episode's sweep reported a verdict against this one",
  );
  assert.equal(
    h.state.deferred.length,
    1,
    "the demoted pass must ask for a fresh look inside the new episode",
  );
});

test("…but a confirming pass with NO boundary under it still spends and verdicts", () => {
  // 🔴 THE POSITIVE COUNTERPART, and the reason it exists: the spec above goes
  // green not only when the leak is closed but also when the path is DISABLED
  // — clear `#confirming` in `beginPass`, or never set it, or make `consume`
  // refuse a confirming pass outright, and the leak spec passes while the only
  // escalation this module has is gone, leaving the banner promising a pause it
  // has already disproved. This is the same script with the two boundary calls
  // deleted and nothing else changed, so the difference between the two specs
  // is exactly the episode boundary.
  const h = makeEpisode();
  h.episode.beginPass();
  h.episode.consume(sweepOf({ unproven: ["microphone/TR_1"] }));
  assert.equal(h.fireConfirm(), true);
  assert.deepEqual(h.episode.beginPass(), { confirming: true });
  h.state.disproved.length = 0;
  h.state.reports.length = 0;

  h.episode.consume(
    sweepOf({
      unproven: ["microphone/TR_1"],
      repauseThrew: ["microphone/TR_1"],
    }),
  );

  assert.deepEqual([...h.episode.repauseSpent()], ["microphone/TR_1"]);
  assert.deepEqual(h.state.disproved, [true]);
  assert.deepEqual(h.state.reports, [
    { kind: "unproven", detail: { publications: ["microphone/TR_1"] } },
  ]);
  assert.equal(
    h.state.deferred.length,
    0,
    "a confirmed verdict asked to confirm all over again",
  );
});

test("endEpisode does NOT demote the pass in flight, and the empty gate REPORTS", () => {
  // 🔴 The asymmetry is load-bearing, so it is pinned rather than left to be
  // tidied into symmetry. `beginEpisode` demotes an in-flight confirming pass;
  // `endEpisode` deliberately does not, even though both call `#cancelConfirm`.
  //
  // A confirming pass landing under the EMPTY gate `endEpisode` left is already
  // refused the spend and the verdict by `consume`'s `gateHeld()` check, which
  // REPORTS instead. Demote it there too and it takes the confirm-request arm
  // and returns silently, and the deferral it schedules then dies on its own
  // `gateHeld()` guard — a loud report traded for silence, in a module whose
  // stated posture is that the observation is reported and never swallowed.
  //
  // "the verdict never fires under an EMPTY gate" drains the gate without the
  // boundary call; this is the production-shaped version, because in
  // `state.tsx` a 1→0 transition always runs `endEpisode()`.
  const h = makeEpisode();
  h.episode.beginPass();
  h.episode.consume(sweepOf({ unproven: ["microphone/TR_1"] }));
  assert.equal(h.fireConfirm(), true);
  assert.deepEqual(h.episode.beginPass(), { confirming: true });
  h.state.gateHeld = false;
  h.episode.endEpisode();
  h.state.disproved.length = 0;
  h.state.reports.length = 0;

  h.episode.consume(
    sweepOf({
      unproven: ["microphone/TR_1"],
      repauseThrew: ["microphone/TR_1"],
    }),
  );

  assert.deepEqual(
    h.state.reports,
    [{ kind: "unproven", detail: { publications: ["microphone/TR_1"] } }],
    "the empty gate swallowed the observation instead of reporting it",
  );
  assert.deepEqual(
    [...h.episode.repauseSpent()],
    [],
    "an empty gate wrote the episode's PERMANENT disarm",
  );
  assert.deepEqual(
    h.state.disproved,
    [],
    "an empty gate latched a withdrawal of a claim it was not making",
  );
});

// ---- The episode-level confirm budget --------------------------------------
//
// 🔴 THE ANTI-VACUITY ASSERTION, moved here from `publishGate.test.ts` by the
// wave-0 completion audit (W1-1). It could never work there: that file's
// `productionCaller` is a self-contained re-implementation of `state.tsx`'s
// three methods importing only `applyPublishGate` and `coalescingSweeper`, so
// no budget landing in THIS module could change one number it produces. The
// assertion was carried as a skip that would have stayed red forever.
//
// The defect it bounds, measured in `publishGate.test.ts` against the real
// module: a silent external re-attacher (application code calling
// `sender.replaceTrack(liveTrack)` after every detach and emitting nothing)
// costs exactly `2 * (confirms + 1)` attaches with no termination — 102 at a
// harness cap of 50. Loud throughout, so a resource and telemetry live-lock
// rather than silent plaintext.
//
// 🔴 WHAT THIS MODELS AND WHAT IT DOES NOT. The chain below is the episode's
// CONTROL FLOW given a stream of sweep results, not the wire: each cycle is one
// deferred confirm, the confirming pass it arms, and the re-attacher's own
// event-driven pass after it (`resumeUpstream` emits `UpstreamResumed`
// synchronously and `#reassertPublishGate` sweeps on it). The detach RESOLVES
// every time, so `repauseThrew` is empty and the permanent spend correctly
// never arms. Nothing here asserts an ATTACH count — `publishGate.test.ts` owns
// the wire model, and its two characterisation specs stay pinned to the
// unbudgeted module.

/**
 * Drive the confirm chain until it stops or `harnessCap` deferrals have fired.
 *
 * `harnessCap` is the HARNESS's terminator, not the design's: without it a
 * broken bound would chain forever and HANG the suite, and a hang is a
 * non-result — neither red nor green. Every count this produces is therefore
 * capped by a number that is NOT in the design, which is exactly why the
 * assertion below varies it.
 */
function driveConfirmChain(harnessCap: number) {
  const h = makeEpisode();
  const unproven = sweepOf({
    unproven: ["microphone/TR_1"],
    repauseFailed: ["microphone/TR_1"],
  });
  let passes = 0;
  let confirmingPasses = 0;
  const pass = (): void => {
    passes++;
    if (h.episode.beginPass().confirming) confirmingPasses++;
    h.episode.consume(unproven);
  };
  pass(); // the event-driven sweep that finds the wire live
  let fired = 0;
  while (h.state.deferred.length > 0 && fired < harnessCap) {
    fired++;
    h.fireConfirm(); // the deferral arms the flag…
    pass(); // …and the caller then sweeps: the confirming pass
    pass(); // the re-attacher's own `UpstreamResumed` sweep
  }
  return { passes, confirmingPasses, fired, state: h.state };
}

test("the confirm chain is bounded at CONFIRM_BUDGET consecutive rounds", () => {
  const run = driveConfirmChain(50);
  assert.equal(run.confirmingPasses, CONFIRM_BUDGET);
  assert.ok(
    run.fired < 50,
    `the chain ran until the HARNESS stopped it (${run.fired} deferrals), so nothing in the design bounds it`,
  );
});

test("the cost does not follow the harness's confirm cap", () => {
  // W1-1's assertion, at the level where the budget actually lives. Compare
  // caps well above the budget on both sides: if the numbers move with the cap,
  // the bound is the harness and not the design.
  const small = driveConfirmChain(6);
  const large = driveConfirmChain(20);
  assert.deepEqual(
    {
      confirms: [small.confirmingPasses, large.confirmingPasses],
      passes: [small.passes, large.passes],
    },
    {
      confirms: [CONFIRM_BUDGET, CONFIRM_BUDGET],
      passes: [1 + 2 * CONFIRM_BUDGET, 1 + 2 * CONFIRM_BUDGET],
    },
    `the confirm chain followed the harness cap (${small.confirmingPasses} at 6, ${large.confirmingPasses} at 20), so nothing in the DESIGN bounds it`,
  );
});

test("an exhausted budget promotes the observation to a LOUD verdict", () => {
  // Never a silent return: the pass that finds the budget gone reports and
  // withdraws the pause claim rather than asking for a confirm it cannot get.
  const run = driveConfirmChain(20);
  assert.equal(
    run.state.disproved.at(-1),
    true,
    "the banner kept promising a pause the sweep could not prove",
  );
  const last = run.state.reports.at(-1);
  assert.deepEqual(last, {
    kind: "unproven",
    detail: {
      publications: ["microphone/TR_1"],
      confirmBudgetExhausted: true,
    },
  });
  assert.equal(run.state.deferred.length, 0, "it asked for another confirm");
});

test("a sweep that proves quiet RESTORES the budget", () => {
  // 🔴 The budget counts CONSECUTIVE failing rounds on purpose. A plain
  // per-episode counter would exhaust itself over a long healthy episode with
  // four transient windows in it, and the fifth transient window would then be
  // reported as a verdict off a SINGLE unconfirmed observation — the 2026-09-08
  // false red, re-armed one level up.
  const run = driveConfirmChain(20);
  const h = makeEpisode();
  // Reproduce the exhausted state, then let one sweep come back clean.
  for (let i = 0; i < CONFIRM_BUDGET; i++) {
    h.episode.beginPass();
    h.episode.consume(sweepOf({ unproven: ["microphone/TR_1"] }));
    h.fireConfirm();
    h.episode.beginPass();
    h.episode.consume(sweepOf({ unproven: ["microphone/TR_1"] }));
  }
  h.state.deferred.length = 0;
  h.episode.beginPass();
  h.episode.consume(sweepOf({ proven: ["microphone/TR_1"] }));
  h.episode.beginPass();
  h.episode.consume(sweepOf({ unproven: ["microphone/TR_1"] }));
  assert.equal(
    h.state.deferred.length,
    1,
    "a transient window after a healthy stretch was reported without confirming",
  );
  assert.equal(
    run.confirmingPasses,
    CONFIRM_BUDGET,
    "and the bound still holds",
  );
});

test("a dropped pass with the budget spent is REPORTED, never swallowed", () => {
  // The escalation the dropped arm exists for, and the reason the budget reset
  // sits BELOW the drop check: above it this branch could not be reached at
  // all, because the reset had just made the budget whole.
  const h = makeEpisode();
  for (let i = 0; i < CONFIRM_BUDGET; i++) {
    h.episode.beginPass();
    h.episode.consume(sweepOf({ unproven: ["microphone/TR_1"] }));
    h.fireConfirm();
    h.episode.beginPass();
    h.episode.consume(sweepOf({ unproven: ["microphone/TR_1"] }));
  }
  h.state.disproved.length = 0;
  h.state.reports.length = 0;
  h.episode.noteDropped();
  assert.equal(
    h.state.deferred.length,
    0,
    "the budget is spent, so no confirm",
  );
  h.episode.beginPass();
  h.episode.consume(sweepOf());
  assert.deepEqual(h.state.reports, [
    {
      kind: "unproven",
      detail: {
        publications: [],
        droppedPass: true,
        confirmBudgetExhausted: true,
      },
    },
  ]);
  // 🔴 And NOT a red: nothing here observed the wire live, so the pause claim
  // is neither restored nor withdrawn. A dropped pass is missing evidence, not
  // counter-evidence.
  assert.deepEqual(h.state.disproved, []);
});

test("beginEpisode restores the budget for the next held-gate episode", () => {
  const h = makeEpisode();
  for (let i = 0; i < CONFIRM_BUDGET; i++) {
    h.episode.beginPass();
    h.episode.consume(sweepOf({ unproven: ["microphone/TR_1"] }));
    h.fireConfirm();
    h.episode.beginPass();
    h.episode.consume(sweepOf({ unproven: ["microphone/TR_1"] }));
  }
  h.state.deferred.length = 0;
  h.episode.beginEpisode();
  h.episode.beginPass();
  h.episode.consume(sweepOf({ unproven: ["microphone/TR_1"] }));
  assert.equal(h.state.deferred.length, 1);
});

test("a SPENT name over a live wire may not burn the confirm budget", () => {
  // 🔴 The consecutive scoping above, defeated one level down. `publishGate.ts`
  // issues NOTHING for a suppressed publication, its post-condition then reads
  // `live`, and it lands in `unproven` on EVERY pass for the rest of the
  // episode — the spend's lift is unreachable while the wire is live, which is
  // what makes it permanent. So `unproven.length === 0` is unreachable the
  // moment anything is spent, and a reset conditioned on it never fires again.
  const h = makeEpisode();
  const failing = sweepOf({
    unproven: ["a/1"],
    repauseFailed: ["a/1"],
    repauseThrew: ["a/1"],
  });
  h.episode.beginPass();
  h.episode.consume(failing);
  h.fireConfirm();
  h.episode.beginPass();
  h.episode.consume(failing);
  assert.deepEqual([...h.episode.repauseSpent()], ["a/1"], "a/1 is not spent");

  // A long stretch in which the ONLY unproven name is the spent one. Twice the
  // budget, so a counter that still counts these is provably exhausted.
  for (let i = 0; i < CONFIRM_BUDGET * 2; i++) {
    h.episode.beginPass();
    h.episode.consume(sweepOf({ unproven: ["a/1"] }));
    h.fireConfirm();
    h.episode.beginPass();
    h.episode.consume(sweepOf({ unproven: ["a/1"] }));
  }
  h.state.deferred.length = 0;
  h.state.disproved.length = 0;
  h.state.reports.length = 0;

  // A brand-new transient window on a DIFFERENT publication.
  h.episode.beginPass();
  h.episode.consume(
    sweepOf({ unproven: ["a/1", "b/2"], repauseFailed: ["b/2"] }),
  );
  assert.equal(
    h.state.deferred.length,
    1,
    "b/2 was verdicted off a SINGLE unconfirmed observation",
  );
  assert.deepEqual(h.state.disproved, []);
  assert.deepEqual(h.state.reports, []);
});

test("the DRIVE-scoped set does not restore the budget the way a spend does", () => {
  // 🔴 The asymmetry is the mechanism, not an oversight. `repausePending` is
  // emptied by `beginDrive` before every drive's first pass, so it can never
  // make the reset permanently unreachable; excluding it too would let a
  // trailing pass inside the very drive a live-lock is feeding restore the
  // bound that drive is burning — the unbounded chain back verbatim.
  //
  // `driveConfirmChain` is the measurement (its result carries `repauseFailed`
  // on every pass, so the name is in the pending set from pass 1 onward). This
  // spec states the rule the number above is evidence for.
  const run = driveConfirmChain(20);
  assert.equal(
    run.confirmingPasses,
    CONFIRM_BUDGET,
    "a drive-scoped suppression restored the bound it was burning",
  );
});

test("endEpisode restores the budget too, and not only the two disarm sets", () => {
  // FIX D. Inconsistent with both siblings otherwise: the resume sweep this
  // boundary drives ran on the PREVIOUS episode's counter.
  const h = makeEpisode();
  for (let i = 0; i < CONFIRM_BUDGET; i++) {
    h.episode.beginPass();
    h.episode.consume(sweepOf({ unproven: ["microphone/TR_1"] }));
    h.fireConfirm();
    h.episode.beginPass();
    h.episode.consume(sweepOf({ unproven: ["microphone/TR_1"] }));
  }
  h.state.deferred.length = 0;
  // The gate is empty from here: that is what `endEpisode` means.
  h.state.gateHeld = false;
  h.episode.endEpisode();
  h.state.disproved.length = 0;
  h.state.reports.length = 0;
  h.episode.beginPass();
  h.episode.consume(sweepOf({ unproven: ["microphone/TR_1"] }));
  assert.equal(
    h.state.deferred.length,
    1,
    "the resume sweep ran on the previous episode's counter",
  );
});

// ---- The hook `beginDrive` is wired to (W1-2) ------------------------------

test("a throwing onDriveStart does not strand `active` and wedge every sweep", async () => {
  // `publishGate.ts` claims in prose that the hook runs inside the drive's try
  // so a throwing hook cannot wedge the sweeper. The wave-0 audit moved it
  // OUTSIDE and the whole suite stayed green, so the claim had no spec — and
  // wave 1 is what puts real code (`beginDrive`) behind it.
  let throwOnce = true;
  let runs = 0;
  const sweeper = coalescingSweeper(
    async () => {
      runs++;
    },
    undefined,
    () => {},
    () => {
      if (throwOnce) {
        throwOnce = false;
        throw new Error("beginDrive threw");
      }
    },
  );
  await assert.rejects(sweeper.sweep(), /beginDrive threw/);
  assert.equal(runs, 0, "the hook runs before the drive's first pass");
  await sweeper.sweep();
  assert.equal(runs, 1, "`active` was stranded: no later sweep could drive");
});

test("…but the throw REJECTS the drive, which every caller `void`s (RECORDED)", async () => {
  // 🔴 A KNOWN DEFECT this lane cannot fix: the fix is in `publishGate.ts`,
  // which is frozen after wave 0 and is not this lane's file. `state.tsx` calls
  // `void this.#applyPublishGate(room)` in four places, so this rejection is an
  // UNHANDLED REJECTION, and `#enable()`'s `await` on it throws in the middle of
  // the E2EE flip. `beginDrive()` is `Set.clear()` and cannot throw today, so
  // this is reachable only through a future hook — which is precisely when a
  // reader needs to find it. Asserted as-is, not weakened.
  const sweeper = coalescingSweeper(
    async () => {},
    undefined,
    () => {},
    () => {
      throw new Error("hook");
    },
  );
  await assert.rejects(sweeper.sweep(), /hook/);
});
