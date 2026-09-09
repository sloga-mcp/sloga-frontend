// The publish gate's other half: that a HELD gate actually reaches the wire.
//
// `mlsCallSession.falsered.test.ts` covers the session side — that the ME-10
// banner only renders over a held reason set. That is necessary and was never
// sufficient: during the 2026-09-08 join-race legs the reason set WAS non-empty
// and the wire was not quiet, so no spec over the reason set alone could have
// failed for the leg's reason.
//
// So these specs drive the REAL sweep (`applyPublishGate`) against a fake that
// reproduces livekit-client 2.15.13's pause bookkeeping, its per-track FIFO
// mutex, its republish, and — the detail a first version of this fake got wrong
// — the fact that `replaceTrack` sets `sender.track` in a queued task
// immediately BEFORE resolving. A fake that mutates `sender.track` synchronously
// cannot express the window in which the observation lies, which is exactly
// where the interesting failures are.
import assert from "node:assert/strict";
import test from "node:test";

import {
  type GatedPublication,
  type UpstreamState,
  applyPublishGate,
  coalescingSweeper,
  publishGateOp,
} from "./publishGate.ts";

// ---- The pure table ---------------------------------------------------------

const STATES: UpstreamState[] = ["live", "quiet", "unpublished"];

test("an empty gate always resumes", () => {
  for (const upstreamPaused of [true, false]) {
    for (const upstream of STATES) {
      assert.equal(
        publishGateOp({ gateHeld: false, upstreamPaused, upstream }),
        "resume",
      );
    }
  }
});

test("a held gate pauses a live sender, re-pausing under a stale flag", () => {
  assert.equal(
    publishGateOp({ gateHeld: true, upstreamPaused: false, upstream: "live" }),
    "pause",
  );
  assert.equal(
    publishGateOp({ gateHeld: true, upstreamPaused: true, upstream: "live" }),
    "repause",
  );
});

test("a quiet wire is proven only when livekit's flag AGREES", () => {
  // Flag says paused and the wire is detached: a settled pause.
  assert.equal(
    publishGateOp({ gateHeld: true, upstreamPaused: true, upstream: "quiet" }),
    "none",
  );
  // Flag CLEARED over a detached wire: nothing produces that but an attach in
  // flight (`resumeUpstream` clears the flag before awaiting `replaceTrack`).
  // Trusting it is the fail-open this three-valued state exists to kill.
  assert.equal(
    publishGateOp({ gateHeld: true, upstreamPaused: false, upstream: "quiet" }),
    "pause",
  );
});

test("nothing published means nothing to pause", () => {
  for (const upstreamPaused of [true, false]) {
    assert.equal(
      publishGateOp({
        gateHeld: true,
        upstreamPaused,
        upstream: "unpublished",
      }),
      "none",
    );
  }
});

// ---- livekit 2.15.13 fidelity ----------------------------------------------

/** livekit's `Mutex`: a strict-FIFO promise chain, so lock order is call order. */
class FifoMutex {
  #locking: Promise<void> = Promise.resolve();

  lock(): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const acquired = this.#locking.then(() => release);
    this.#locking = this.#locking.then(() => held);
    return acquired;
  }
}

class FakeSender {
  track: string | null;
  transportState: "connected" | "closed" | "failed" = "connected";
  /** Every `replaceTrack` argument, in order — the wire's history. */
  readonly writes: (string | null)[] = [];
  /** Set to make `replaceTrack(null)` reject, as a closing transport can. */
  rejectDetach = false;
  /** When set, an ATTACH blocks here — the in-flight `replaceTrack` window. */
  #attachHeld: Promise<void> | null = null;
  /** The same for a DETACH: the mirror window the residual reasons about. */
  #detachHeld: Promise<void> | null = null;

  constructor(track: string | null) {
    this.track = track;
  }

  /** Hold the next attach open. The returned function lets it complete. */
  holdAttach(): () => void {
    let release!: () => void;
    this.#attachHeld = new Promise<void>((resolve) => (release = resolve));
    return () => {
      this.#attachHeld = null;
      release();
    };
  }

  /** Hold the next detach open. The returned function lets it complete. */
  holdDetach(): () => void {
    let release!: () => void;
    this.#detachHeld = new Promise<void>((resolve) => (release = resolve));
    return () => {
      this.#detachHeld = null;
      release();
    };
  }

  /**
   * WebRTC 1.0 §5.2: the promise settles only after a queued task sets
   * `[[SenderTrack]]`. So `sender.track` lags the call, and during that lag
   * livekit has ALREADY cleared `_isUpstreamPaused` and emitted
   * `UpstreamResumed`.
   */
  async replaceTrack(track: string | null): Promise<void> {
    if (track === null && this.rejectDetach) {
      throw new Error("InvalidStateError: sender is closed");
    }
    if (track !== null && this.#attachHeld) await this.#attachHeld;
    if (track === null && this.#detachHeld) await this.#detachHeld;
    await Promise.resolve();
    this.writes.push(track);
    this.track = track;
  }
}

/** `LocalTrack`'s upstream half (2.15.13), plus livekit's own republish. */
class FakeLocalTrack {
  raw = "mic";
  processed: string | null = null;
  sender: FakeSender | undefined;
  paused = false;
  /** How many times the sweep called into livekit at all. */
  pauseCalls = 0;
  readonly #lock = new FifoMutex();
  /** `TrackEvent.UpstreamResumed` / `UpstreamPaused` listeners. */
  readonly #listeners = new Map<string, (() => void)[]>();

  on(event: "UpstreamResumed" | "UpstreamPaused", fn: () => void): void {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), fn]);
  }

  #emit(event: string): void {
    for (const fn of this.#listeners.get(event) ?? []) fn();
  }

  constructor(raw = "mic") {
    this.raw = raw;
    this.sender = new FakeSender(raw);
  }

  get mediaStreamTrack(): string {
    return this.processed ?? this.raw;
  }

  get isUpstreamPaused(): boolean {
    return this.paused;
  }

  /** What `state.tsx`'s adapter reads off a real `LocalTrack`. */
  upstream(): UpstreamState {
    const sender = this.sender;
    if (!sender) return "unpublished";
    if (!sender.track) return "quiet";
    return sender.transportState === "closed" ? "quiet" : "live";
  }

  async pauseUpstream(): Promise<void> {
    this.pauseCalls++;
    const unlock = await this.#lock.lock();
    try {
      if (this.paused === true) return;
      if (!this.sender) return;
      this.paused = true;
      this.#emit("UpstreamPaused");
      if (this.sender.transportState !== "closed") {
        await this.sender.replaceTrack(null);
      }
    } finally {
      unlock();
    }
  }

  async resumeUpstream(): Promise<void> {
    const unlock = await this.#lock.lock();
    try {
      if (this.paused === false) return;
      if (!this.sender) return;
      // Flag cleared and `UpstreamResumed` emitted BEFORE the attach lands.
      this.paused = false;
      this.#emit("UpstreamResumed");
      if (this.sender.transportState !== "closed") {
        await this.sender.replaceTrack(this.mediaStreamTrack);
      }
    } finally {
      unlock();
    }
  }

  /**
   * `republishAllTracks(undefined, false)` — what `setE2EEEnabled()` runs, and
   * what the signal-reconnect republish runs for a muted or screen-share track.
   * `restartTracks` is false, so `restartTrack()` → `setMediaStreamTrack()` →
   * `resumeUpstream()` never runs and `paused` is left exactly as it was.
   */
  republish(): void {
    this.sender = undefined; // unpublishTrack
    this.sender = new FakeSender(this.mediaStreamTrack); // publishOrRepublish
  }

  /** `setProcessor`: replaces the sender's track directly, flag untouched. */
  attachProcessor(): void {
    this.processed = "mic+denoise";
    void this.sender?.replaceTrack(this.processed);
  }
}

function gated(
  track: FakeLocalTrack,
  name = "microphone/TR_1",
): GatedPublication {
  return {
    name,
    get upstreamPaused() {
      return track.isUpstreamPaused;
    },
    upstream: () => track.upstream(),
    pauseUpstream: () => track.pauseUpstream(),
    resumeUpstream: () => track.resumeUpstream(),
  };
}

const held = () => true;
const empty = () => false;

/** Nothing to report: a held gate proved every publication quiet. */
function assertClean(result: {
  unproven: string[];
  failed: string[];
  repauseFailed: string[];
}): void {
  assert.deepEqual(
    { unproven: result.unproven, failed: result.failed },
    { unproven: [], failed: [] },
  );
}

/** Let every queued `replaceTrack` task and lock continuation run. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

// ---- The original defect ---------------------------------------------------

test("the enable flip's republish defeats a BARE re-pause", async () => {
  // The pre-fix sweep, kept as the record of what regressed: one bare op per
  // publication, trusting livekit's idempotency.
  const track = new FakeLocalTrack();
  await track.pauseUpstream();
  assert.equal(track.upstream(), "quiet", "the gate did not pause the mic");

  track.republish(); // setEncryptionEnabled(true)
  assert.equal(track.upstream(), "live", "the republish revived the sender");
  assert.equal(track.isUpstreamPaused, true, "the pause flag went stale-true");

  await track.pauseUpstream(); // the bare re-assert
  assert.equal(
    track.upstream(),
    "live",
    "expected the bare re-assert to be defeated by the stale flag",
  );
});

test("the sweep closes it, and reports nothing left over", async () => {
  const track = new FakeLocalTrack();
  assertClean(await applyPublishGate([gated(track)], held));
  assert.equal(track.upstream(), "quiet");

  track.republish();
  assert.equal(track.upstream(), "live");

  assertClean(await applyPublishGate([gated(track)], held));
  assert.equal(track.upstream(), "quiet", "a held gate left the mic live");
});

// ---- The fail-open the two-valued observable had ---------------------------

test("a sweep during an IN-FLIGHT resume must not report proven quiet", async () => {
  const track = new FakeLocalTrack();
  await applyPublishGate([gated(track)], held);
  assert.equal(track.upstream(), "quiet");

  // The gate emptied and a resume was issued — then the gate refilled before
  // the attach landed. This is the window: livekit has already cleared its flag
  // and emitted `UpstreamResumed` (so no backstop is coming), while
  // `sender.track` is still null.
  const release = track.sender!.holdAttach();
  const resuming = track.resumeUpstream();
  await settle(); // now parked inside `replaceTrack`, holding livekit's lock
  assert.equal(track.isUpstreamPaused, false, "livekit cleared its flag early");
  assert.equal(track.upstream(), "quiet", "the wire lags the call");

  // The sweep reads that window and must issue a pause, which queues behind the
  // resume on livekit's FIFO lock.
  const sweeping = applyPublishGate([gated(track)], held);
  release();
  const result = await sweeping;
  await resuming;
  await settle();

  assert.deepEqual(result.unproven, [], "the pause queued behind and won");
  assert.equal(
    track.upstream(),
    "quiet",
    "the resume landed and stayed on the wire under a held gate",
  );
});

test("...and reading that window as a boolean is the fail-open", async () => {
  // The two-valued rule this replaced: `onTheWire ? … : "none"`. Issued nothing
  // in the window above, so the resume landed unopposed.
  const track = new FakeLocalTrack();
  await track.pauseUpstream();
  const release = track.sender!.holdAttach();
  const resuming = track.resumeUpstream();
  await settle();
  const onTheWire = track.upstream() === "live";
  const acting = onTheWire ? track.pauseUpstream() : Promise.resolve();
  release();
  await acting; // the old rule's only branch
  await resuming;
  await settle();
  assert.equal(
    track.upstream(),
    "live",
    "expected the two-valued rule to leave the mic live under a held gate",
  );
});

// ---- The other stale-flag paths -------------------------------------------

test("setProcessor's direct replaceTrack is caught by the same observation", async () => {
  const track = new FakeLocalTrack();
  await applyPublishGate([gated(track)], held);
  assert.equal(track.upstream(), "quiet");

  track.attachProcessor();
  await settle();
  assert.equal(track.upstream(), "live");
  assert.equal(
    track.isUpstreamPaused,
    true,
    "flag stale-true, as livekit leaves it",
  );

  await applyPublishGate([gated(track)], held);
  await settle();
  assert.equal(track.upstream(), "quiet");
  // The resume re-attached the PROCESSED track, not the raw mic — livekit's
  // `mediaStreamTrack` is a getter. If it re-attached raw, a denoised call
  // would leak un-denoised audio for the length of the repause.
  assert.ok(
    !track.sender!.writes.includes("mic"),
    `the repause re-attached the raw track: ${track.sender!.writes.join(",")}`,
  );
});

test("a settled pause is left alone — never re-attached", async () => {
  const track = new FakeLocalTrack();
  await applyPublishGate([gated(track)], held);
  const writesBefore = [...track.sender!.writes];

  // Another publication's event sweeps the whole roster. This one is proven
  // quiet (wire detached AND flag agrees), so nothing may touch it: a
  // resume-then-pause here would put it briefly back on the wire, which is the
  // one thing the gate exists to prevent.
  await applyPublishGate([gated(track)], held);
  await settle();
  assert.deepEqual(track.sender!.writes, writesBefore);
  assert.equal(track.upstream(), "quiet");
});

test("a publication with no sender is not pause-spammed", async () => {
  const track = new FakeLocalTrack();
  track.sender = undefined;
  const result = await applyPublishGate([gated(track)], held);
  assert.deepEqual(result.unproven, []);
  assert.equal(
    track.pauseCalls,
    0,
    "an unpublished track must not be pause-spammed on every sweep",
  );
});

// ---- The seams the old spec could not see ---------------------------------

test("a detach that REJECTS is reported, not swallowed", async () => {
  const track = new FakeLocalTrack();
  track.sender!.rejectDetach = true;
  const result = await applyPublishGate([gated(track)], held);
  assert.deepEqual(
    result.unproven,
    ["microphone/TR_1"],
    "a pause that threw must reach the caller",
  );
  // And why it must: livekit set the flag before the detach, so the sender is
  // live under a flag that says paused.
  assert.equal(track.isUpstreamPaused, true);
  assert.equal(track.upstream(), "live");
});

test("a rejecting detach recovers on the next sweep instead of wedging", async () => {
  const track = new FakeLocalTrack();
  track.sender!.rejectDetach = true;
  await applyPublishGate([gated(track)], held);
  track.sender!.rejectDetach = false;
  // `none` would leave it live forever. The observation makes it `repause`.
  assertClean(await applyPublishGate([gated(track)], held));
  assert.equal(track.upstream(), "quiet");
});

test("a pause that RESOLVES over a re-attached wire is still reported", async () => {
  // `LocalTrack`'s constructor binds `handleTrackUnmuteEvent` to the native
  // MediaStreamTrack `unmute` event, and it calls `resumeUpstream()`
  // UNCONDITIONALLY — a device wake, a source change, an exclusive-mode
  // release. Nothing in the pause's own return value can say the wire came
  // back; only re-reading it can.
  const track = new FakeLocalTrack();
  const result = await applyPublishGate(
    [
      {
        name: "microphone/TR_1",
        upstreamPaused: false,
        upstream: () => track.upstream(),
        pauseUpstream: async () => {
          await track.pauseUpstream();
          await track.resumeUpstream(); // livekit's unmute handler
        },
        resumeUpstream: () => track.resumeUpstream(),
      },
    ],
    held,
  );
  assert.deepEqual(
    result.unproven,
    ["microphone/TR_1"],
    "a pause that resolved over a live wire was reported as success",
  );
  assert.equal(track.upstream(), "live");
});

test("a resume that throws is reported on its OWN channel", async () => {
  // The opposite failure: an EMPTY gate wants this publishing and it did not
  // come back. Folding it into `unproven` meant a caller that (correctly) only
  // acts while the gate is held discarded it — silently muted, no telemetry.
  const track = new FakeLocalTrack();
  await applyPublishGate([gated(track)], held);
  const result = await applyPublishGate(
    [
      {
        ...gated(track),
        resumeUpstream: async () => {
          throw new Error("OverconstrainedError");
        },
      },
    ],
    empty,
  );
  assert.deepEqual(result.unproven, []);
  assert.deepEqual(result.failed, ["microphone/TR_1"]);
});

test("a closed transport counts as quiet, and does not go loud", async () => {
  const track = new FakeLocalTrack();
  track.sender!.transportState = "closed";
  assertClean(await applyPublishGate([gated(track)], held));
});

test("a FAILED transport still counts as live, so the pause is attempted", async () => {
  // The conservative direction: `replaceTrack(null)` still succeeds on a failed
  // transport, so the pause lands and the post-condition passes. Reading
  // `failed` as quiet would skip the op and call it proven.
  const track = new FakeLocalTrack();
  track.sender!.transportState = "failed";
  assert.equal(track.upstream(), "live");
  assertClean(await applyPublishGate([gated(track)], held));
  assert.equal(track.upstream(), "quiet");
});

test("the gate emptying mid-repause leaves the publication LIVE", async () => {
  const track = new FakeLocalTrack();
  await applyPublishGate([gated(track)], held);
  track.republish();

  // Held when the sweep reads it, empty by the time `repause` gets its lock:
  // the trailing pause must be abandoned, or a healthy call ends up silently
  // muted with nothing left to resume it.
  let reads = 0;
  const emptiesAfterFirstRead = () => ++reads === 1;
  await applyPublishGate([gated(track)], emptiesAfterFirstRead);
  await settle();
  assert.equal(
    track.upstream(),
    "live",
    "the mic was left muted with no reason held",
  );
});

test("an empty gate resumes a rebuilt publication", async () => {
  const track = new FakeLocalTrack();
  await applyPublishGate([gated(track)], held);
  track.republish();
  await applyPublishGate([gated(track)], held);
  await settle();
  assert.equal(track.upstream(), "quiet");

  await applyPublishGate([gated(track)], empty);
  await settle();
  assert.equal(track.upstream(), "live", "a healthy call ended up muted");
  assert.equal(track.isUpstreamPaused, false);
});

test("every publication is judged on its own wire", async () => {
  const mic = new FakeLocalTrack("mic");
  const cam = new FakeLocalTrack("camera");
  await applyPublishGate([gated(mic, "microphone/TR_1")], held);
  // The camera was rebuilt under a stale flag; the mic is settled.
  cam.paused = true;

  const result = await applyPublishGate(
    [gated(mic, "microphone/TR_1"), gated(cam, "camera/TR_2")],
    held,
  );
  await settle();
  assert.deepEqual(result.unproven, []);
  assert.equal(mic.upstream(), "quiet");
  assert.equal(cam.upstream(), "quiet", "the camera was left on the wire");
});

test("ops are ISSUED before the first await, so livekit's FIFO lock orders them", async () => {
  // livekit serializes each track's pause/resume on a strict-FIFO mutex, so
  // issue order IS execution order — but only if the sweep issues everything
  // before suspending. A sweep that awaited inside its loop would let a later
  // publication's op take the lock ahead of an earlier one's.
  //
  // ISSUE and COMPLETION are recorded separately on purpose: recording only at
  // call time cannot tell the two shapes apart, because the call itself is
  // synchronous either way.
  const order: string[] = [];
  const op = (name: string) => async () => {
    order.push(`issue:${name}`);
    await Promise.resolve();
    order.push(`done:${name}`);
  };
  const slow = (name: string): GatedPublication => ({
    name,
    upstreamPaused: false,
    upstream: () => "quiet",
    pauseUpstream: op(name),
    resumeUpstream: op(name),
  });
  await applyPublishGate([slow("a"), slow("b")], empty);
  // All issued, THEN all completed. Awaiting in the loop would interleave them
  // as issue:a, done:a, issue:b, done:b.
  assert.deepEqual(order, ["issue:a", "issue:b", "done:a", "done:b"]);
});

test("a post-condition read that throws is reported, not an unhandled rejection", async () => {
  const track = new FakeLocalTrack();
  let reads = 0;
  const result = await applyPublishGate(
    [
      {
        name: "microphone/TR_1",
        upstreamPaused: false,
        upstream: () => {
          if (++reads > 1) throw new Error("torn down mid-sweep");
          return track.upstream();
        },
        pauseUpstream: () => track.pauseUpstream(),
        resumeUpstream: () => track.resumeUpstream(),
      },
    ],
    held,
  );
  assert.deepEqual(result.unproven, ["microphone/TR_1"]);
});

// ---- The confirm/reassert loop ---------------------------------------------

test("the coalescing sweeper never nests, and collapses a burst into one pass", async () => {
  const order: string[] = [];
  let burst = true;
  const sweeper = coalescingSweeper(async () => {
    order.push("start");
    if (burst) {
      // A sweep's own ops re-enter through `UpstreamResumed` — three events in
      // one pass, from three publications, must not become three sweeps.
      burst = false;
      void sweeper.sweep();
      void sweeper.sweep();
      void sweeper.sweep();
    }
    await Promise.resolve();
    order.push("end");
  });
  await sweeper.sweep();
  // Two passes: the original, plus ONE trailing pass for the whole burst.
  assert.deepEqual(order, ["start", "end", "start", "end"]);
  assert.equal(sweeper.passes(), 2);
});

test("every caller of a coalesced sweep awaits the work in flight", async () => {
  // `#enable()` awaits its pause before flipping E2EE on, so a re-entrant
  // caller receiving an already-resolved promise would break that guard.
  let done = false;
  const sweeper = coalescingSweeper(async () => {
    await Promise.resolve();
    done = true;
  });
  const first = sweeper.sweep();
  const second = sweeper.sweep();
  await second;
  assert.equal(done, true);
  await first;
});

test("the sweeper's pass cap stops a run whose every pass re-triggers", async () => {
  let runs = 0;
  // The re-trigger stops at 20 so this spec TERMINATES whether or not the cap
  // works: relying on the production cap to end the loop meant the mutation
  // that removes the cap hung the suite instead of failing it, and a hang is a
  // non-result — neither red nor green — which is the whole thing `rtc-gate.sh`
  // exists to prevent.
  const sweeper = coalescingSweeper(async () => {
    runs++;
    if (runs < 20) void sweeper.sweep();
    await Promise.resolve();
  }, 4);
  await sweeper.sweep();
  assert.equal(runs, 4, "the cap is a hard stop, not a heuristic");
});

test("a persistently failing detach does not live-lock the sweep", async () => {
  // The scenario the post-condition exists for, and the one the fourth review
  // found spinning: `repause` resumes, its `UpstreamResumed` re-enters the
  // sweep, the pause throws, and the wire is live again — forever, re-attaching
  // the sender on every pass.
  const track = new FakeLocalTrack();
  await applyPublishGate([gated(track)], held);
  track.republish(); // stale-true flag over a live sender
  track.sender!.rejectDetach = true; // the detach will never land

  const repauseSpent = new Set<string>();
  let reports = 0;
  const sweeper = coalescingSweeper(async () => {
    const { unproven } = await applyPublishGate([gated(track)], held, {
      repauseSpent,
    });
    if (unproven.length > 0) {
      reports++;
      for (const name of unproven) repauseSpent.add(name);
    }
  });
  // livekit's event, wired the way `state.tsx` wires it.
  track.on("UpstreamResumed", () => void sweeper.sweep());

  await sweeper.sweep();
  await settle();

  assert.ok(
    sweeper.passes() <= 4,
    `the sweep spun: ${sweeper.passes()} passes`,
  );
  assert.ok(reports >= 1, "the failure must still be reported");
  // And the crucial part: it stopped re-attaching. One repause attempt, then
  // report-only — otherwise every pass puts the sender back on the wire.
  const attaches = track.sender!.writes.filter((w) => w !== null).length;
  assert.ok(
    attaches <= 1,
    `the sweep re-attached the sender ${attaches} times while gated`,
  );
});

test("a spent repause still reports, and still issues nothing", async () => {
  const track = new FakeLocalTrack();
  await applyPublishGate([gated(track)], held);
  track.republish();
  const before = track.pauseCalls;
  const result = await applyPublishGate([gated(track)], held, {
    repauseSpent: new Set(["microphone/TR_1"]),
  });
  assert.deepEqual(result.unproven, ["microphone/TR_1"]);
  assert.equal(track.pauseCalls, before, "a spent repause called into livekit");
  assert.equal(track.upstream(), "live", "and it did not touch the wire");
});

test("a held-gate detach in flight reads live, and the pause still lands", async () => {
  // The mirror window the residual reasons about, now pinned rather than prose:
  // livekit sets the flag before awaiting the detach, so mid-detach the state is
  // {flag: true, live}. The policy calls that `repause`, whose resume queues
  // behind the detach on the FIFO lock — so the wire ends quiet either way.
  const track = new FakeLocalTrack();
  const release = track.sender!.holdDetach();
  const pausing = track.pauseUpstream();
  await settle();
  assert.equal(
    track.isUpstreamPaused,
    true,
    "flag set before the detach lands",
  );
  assert.equal(track.upstream(), "live", "the wire has not caught up");

  const sweeping = applyPublishGate([gated(track)], held);
  release();
  const result = await sweeping;
  await pausing;
  await settle();
  assert.deepEqual(result.unproven, []);
  assert.equal(track.upstream(), "quiet");
});

// ---- What may mark a publication SPENT (fifth review) ----------------------

test("a failed PAUSE is not a failed repause, and must not spend the publication", async () => {
  // The distinction that matters: `repauseSpent` disarms the gate for a
  // publication, so only a repause that RAN and still left the wire live may
  // feed it. Marking on any `unproven` turns one transient detach failure into
  // a publication the gate never touches again — the 2026-09-08 defect re-armed.
  const track = new FakeLocalTrack();
  track.sender!.rejectDetach = true;
  const result = await applyPublishGate([gated(track)], held);
  assert.deepEqual(result.unproven, ["microphone/TR_1"]);
  assert.deepEqual(
    result.repauseFailed,
    [],
    "a plain pause failure was reported as a repause failure",
  );
});

test("a failed REPAUSE is reported as one", async () => {
  const track = new FakeLocalTrack();
  await applyPublishGate([gated(track)], held);
  track.republish(); // stale-true flag over a live sender ⇒ repause
  track.sender!.rejectDetach = true;
  const result = await applyPublishGate([gated(track)], held);
  assert.deepEqual(result.repauseFailed, ["microphone/TR_1"]);
});

test("a held gate reports what it PROVED quiet, so a spend can be lifted", async () => {
  const track = new FakeLocalTrack();
  const result = await applyPublishGate([gated(track)], held);
  assert.deepEqual(result.proven, ["microphone/TR_1"]);
  // An empty gate proves nothing about quiet — it wants the opposite.
  const resumed = await applyPublishGate([gated(track)], empty);
  assert.deepEqual(resumed.proven, []);
});

test("the recovery path works under the options production actually passes", async () => {
  // The earlier version of this spec called `applyPublishGate` with no
  // `repauseSpent`, a configuration production never uses — so it asserted
  // recovery while the real wiring could not recover.
  const track = new FakeLocalTrack();
  await applyPublishGate([gated(track)], held);
  track.republish();
  track.sender!.rejectDetach = true;
  const spent = new Set<string>();
  const first = await applyPublishGate([gated(track)], held, {
    repauseSpent: spent,
  });
  for (const name of first.repauseFailed) spent.add(name);
  assert.deepEqual([...spent], ["microphone/TR_1"]);

  // The detach starts working again. The publication is spent, so this sweep
  // issues nothing — but it must still REPORT, and the caller lifts the spend
  // as soon as any sweep proves it quiet.
  track.sender!.rejectDetach = false;
  const second = await applyPublishGate([gated(track)], held, {
    repauseSpent: spent,
  });
  assert.deepEqual(second.unproven, ["microphone/TR_1"]);
  for (const name of second.proven) spent.delete(name);

  // A device switch clears livekit's flag; now a plain `pause` lands.
  track.paused = false;
  const third = await applyPublishGate([gated(track)], held, {
    repauseSpent: spent,
  });
  assert.deepEqual(third.unproven, []);
  assert.deepEqual(third.proven, ["microphone/TR_1"]);
  for (const name of third.proven) spent.delete(name);
  assert.deepEqual([...spent], [], "the spend was never lifted");
  assert.equal(track.upstream(), "quiet");
});

// ---- One publication must not cancel the sweep (fifth review) -------------

test("a throwing PRE-read costs one publication, not the whole sweep", async () => {
  // The adapter reads `track.sender` / `sender.track` off a livekit LocalTrack
  // that can be torn down between the `trackPublications` snapshot and the
  // read. Reading outside the try let one such publication reject the whole
  // sweep — every other publication unswept, and an unhandled rejection at four
  // `void`ed call sites.
  const healthy = new FakeLocalTrack("mic");
  const torn: GatedPublication = {
    name: "screen/TR_2",
    get upstreamPaused(): boolean {
      throw new Error("track torn down");
    },
    upstream: () => "live",
    pauseUpstream: async () => {},
    resumeUpstream: async () => {},
  };
  const result = await applyPublishGate(
    [torn, gated(healthy, "microphone/TR_1")],
    held,
  );
  assert.deepEqual(result.unproven, ["screen/TR_2"]);
  assert.equal(
    healthy.upstream(),
    "quiet",
    "the healthy publication was never swept",
  );
});

// ---- A dropped trailing pass is not a clean bill (fifth review) -----------

test("the cap reports the pass it dropped", async () => {
  let runs = 0;
  let dropped = 0;
  const sweeper = coalescingSweeper(
    async () => {
      runs++;
      if (runs < 20) void sweeper.sweep();
      await Promise.resolve();
    },
    4,
    () => dropped++,
  );
  await sweeper.sweep();
  assert.equal(runs, 4);
  assert.equal(dropped, 1, "a dropped sweep was discarded silently");
});

test("a drive that settles reports no drop", async () => {
  let burst = true;
  let dropped = 0;
  const sweeper = coalescingSweeper(
    async () => {
      if (burst) {
        burst = false;
        void sweeper.sweep();
      }
      await Promise.resolve();
    },
    4,
    () => dropped++,
  );
  await sweeper.sweep();
  assert.equal(dropped, 0);
});
