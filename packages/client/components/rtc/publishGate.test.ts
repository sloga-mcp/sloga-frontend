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
import { readFileSync } from "node:fs";
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

/**
 * WHEN `replaceTrack` settles, which a spec has to state rather than inherit.
 * `macro` is WebRTC 1.0 §5.2 — the promise settles from a QUEUED TASK — and is
 * the faithful one; `micro` is what this file's fake has always done and what
 * every spec above asserts. It is not a detail: the as-shipped live-lock
 * measures 7 passes / 5 re-attaches / a dropped pass on `micro`, and 4 / 3 /
 * none on `macro`.
 */
type WireModel = "micro" | "macro";

class FakeSender {
  track: string | null;
  readonly wire: WireModel;
  /** Fired when a DETACH is CALLED, before it lands. */
  onDetachCall: (() => void) | null = null;
  transportState: "connected" | "closed" | "failed" = "connected";
  /** Every `replaceTrack` argument, in order — the wire's history. */
  readonly writes: (string | null)[] = [];
  /** Set to make `replaceTrack(null)` reject, as a closing transport can. */
  rejectDetach = false;
  /** When set, an ATTACH blocks here — the in-flight `replaceTrack` window. */
  #attachHeld: Promise<void> | null = null;
  /** The same for a DETACH: the mirror window the residual reasons about. */
  #detachHeld: Promise<void> | null = null;

  constructor(track: string | null, wire: WireModel = "micro") {
    this.track = track;
    this.wire = wire;
  }

  #tick(): Promise<void> {
    return this.wire === "macro"
      ? new Promise<void>((resolve) => setTimeout(resolve, 0))
      : Promise.resolve();
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
    if (track === null) this.onDetachCall?.();
    if (track === null && this.rejectDetach) {
      throw new Error("InvalidStateError: sender is closed");
    }
    if (track !== null && this.#attachHeld) {
      // ONE-SHOT: only the attach that was ALREADY in flight parks here. In the
      // mirror-window spec the release is the sweep's own detach, so a hold
      // that also caught the sweep's own resume would deadlock the scenario
      // instead of modelling it.
      const held = this.#attachHeld;
      this.#attachHeld = null;
      await held;
    }
    if (track === null && this.#detachHeld) await this.#detachHeld;
    await this.#tick();
    this.writes.push(track);
    this.track = track;
  }
}

/** `LocalTrack`'s upstream half (2.15.13), plus livekit's own republish. */
class FakeLocalTrack {
  raw = "mic";
  wire: WireModel = "micro";
  processed: string | null = null;
  sender: FakeSender | undefined;
  paused = false;
  /** How many times the sweep called into livekit at all. */
  pauseCalls = 0;
  readonly #lock = new FifoMutex();
  /** `TrackEvent.UpstreamResumed` / `UpstreamPaused` listeners. */
  readonly #listeners = new Map<string, (() => void)[]>();

  on(
    event: "UpstreamResumed" | "UpstreamPaused" | "TrackProcessorUpdate",
    fn: () => void,
  ): void {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), fn]);
  }

  #emit(event: string): void {
    for (const fn of this.#listeners.get(event) ?? []) fn();
  }

  constructor(raw = "mic", wire: WireModel = "micro") {
    this.raw = raw;
    this.wire = wire;
    this.sender = new FakeSender(raw, wire);
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
    // publishOrRepublish
    this.sender = new FakeSender(this.mediaStreamTrack, this.wire);
  }

  /**
   * `setProcessor`: replaces the sender's track directly, flag untouched, and
   * emits `TrackProcessorUpdate` only AFTER the attach lands (2.15.13
   * `:18032-18034` awaits `replaceTrack`, then emits).
   *
   * 🔴 The OTHER re-attacher emits the other way round: `handleTrackUnmuteEvent`
   * → `resumeUpstream` emits `UpstreamResumed` BEFORE its attach (`:17941`).
   * The two do not behave alike — the first re-enters the sweep with the wire
   * already live, the second with the attach still in flight — and a review
   * round withdrew its measurements for having them backwards.
   */
  attachProcessor(label = "mic+denoise"): void {
    this.processed = label;
    void this.sender?.replaceTrack(label).then(
      () => this.#emit("TrackProcessorUpdate"),
      () => {},
    );
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

// ---- The caller production ACTUALLY has (sixth review) ---------------------
//
// The previous version of the live-lock spec drove a caller `state.tsx` does
// not have: it spent any `unproven`, on any pass, with no confirm gate. The
// real one (`#sweepPublishGate`) returns early on `if (!confirming)` BEFORE any
// spend and then spends only `repauseFailed`. Measured against the real module
// through the real shape, under a persistently rejecting `replaceTrack(null)`:
// `passes=7 attaches=5 reports=2 dropped=true wire=live` on a microtask wire,
// `4 / 3 / 2 / false / live` on a macrotask one. Green spec throughout.
//
// So the two specs below drive the production shape instead: ONE persistent
// `coalescingSweeper`, `confirming` consumed at pass start, the confirm on a
// real `setTimeout(0)` behind a single-outstanding guard, the spend gated on
// `confirming`, the un-spend on `proven`, `onDropped` recorded, and the
// drive-scoped `repausePending` cleared from `onDriveStart`.
//
// 🔴 BOTH TIMING AXES ARE PINNED, and both matter:
//
//  - the CONFIRM is a MACROTASK against ONE persistent sweeper. Modelling it as
//    a same-drive re-entrant pass under-reports the live-lock by about 2x and
//    goes green.
//  - the WIRE is {@link WireModel}. Every spec runs on both, because the
//    as-shipped numbers differ by nearly 2x between them and a spec that does
//    not say which it asserts is asserting the fake.

/** livekit's own `pauseUpstreamLock` and `trackChangeLock` are SEPARATE mutexes
 * (2.15.13 `:17905` / `:17932` vs `:17984`), so an issued repause does NOT
 * queue behind a `setProcessor`. Nothing here may assume it does. */
const WIRES: WireModel[] = ["micro", "macro"];

/** Let every queued macrotask — `replaceTrack` on a `macro` wire, and the
 * confirm's `setTimeout(0)` — run, plus the microtasks each one unblocks. */
const drainMacro = async (rounds = 20) => {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await settle();
  }
};

/**
 * `state.tsx`'s three methods, in one place so both specs drive the same shape:
 * `#applyPublishGate` (ONE sweeper, created once), `#sweepPublishGate`
 * (un-spend on `proven`, arm the drive-scoped pending set from `repauseFailed`
 * on ANY pass, confirm-then-report, spend only `repauseThrew`) and
 * `#scheduleGateConfirm` (a macrotask, at most one outstanding).
 */
function productionCaller(
  track: FakeLocalTrack,
  name = "microphone/TR_1",
  /**
   * The HARNESS's confirm cap — see `scheduleConfirm` below. Parameterised
   * because a measurement taken at ONE value of it cannot tell "the design
   * bounds this" from "my harness stopped driving": the re-attacher spec at the
   * end of this file raises it precisely to separate the two, and a review
   * round read a number off this harness as a property of the design.
   */
  confirmCap = 8,
) {
  const spent = new Set<string>();
  const pendingRepause = new Set<string>();
  let confirmPass = false;
  let confirmScheduled = false;
  let sweepDropped = false;
  let dropped = 0;
  let confirms = 0;
  let reports = 0;
  let disproved = false;
  let repauseFailures = 0;

  const sweepOnce = async (confirming: boolean): Promise<void> => {
    const { unproven, repauseFailed, repauseThrew, proven } =
      await applyPublishGate([gated(track, name)], held, {
        repauseSpent: spent,
        repausePending: pendingRepause,
      });
    // A repause that failed once must not be a life sentence.
    for (const n of proven) spent.delete(n);
    repauseFailures += repauseFailed.length;
    // (A) Armed on ANY pass, not gated on `confirming`: the whole re-entrant
    // burst happens on microtasks BEFORE a confirming pass can exist, so a
    // bound that waits for the confirm cannot act inside the burst at all.
    // Cleared at the next drive boundary — see `onDriveStart` below.
    for (const n of repauseFailed) pendingRepause.add(n);
    if (unproven.length === 0) {
      if (sweepDropped) {
        sweepDropped = false;
        scheduleConfirm();
        return;
      }
      disproved = false;
      return;
    }
    if (!confirming) {
      scheduleConfirm();
      return;
    }
    // (B) A spend is a PERMANENT per-episode disarm, so only a detach that
    // THREW may feed it. A pause that resolved over a re-attached wire keeps
    // being swept.
    for (const n of repauseThrew) spent.add(n);
    disproved = true;
    reports++;
  };

  const sweeper = coalescingSweeper(
    () => {
      const confirming = confirmPass;
      confirmPass = false;
      return sweepOnce(confirming);
    },
    undefined,
    () => {
      sweepDropped = true;
      dropped++;
    },
    () => pendingRepause.clear(),
  );

  function scheduleConfirm(): void {
    if (confirmScheduled) return;
    confirmScheduled = true;
    setTimeout(() => {
      confirmScheduled = false;
      // The HARNESS's terminator, not production's — `#scheduleGateConfirm` has
      // no cap. Without it a broken bound would chain confirms forever and HANG
      // the suite, and a hang is a non-result, neither red nor green. Same
      // reasoning as the pass-cap spec above: the spec must stop driving and
      // ASSERT.
      //
      // 🔴 So every count this harness produces is capped by a number that is
      // NOT in the design. Any spec asserting a bound must either assert a
      // number strictly below what `confirmCap` alone would produce, or vary
      // `confirmCap` and assert the count does not follow it.
      if (confirms++ >= confirmCap) return;
      confirmPass = true;
      void sweeper.sweep();
    }, 0);
  }

  return {
    sweep: (): Promise<void> => sweeper.sweep(),
    passes: () => sweeper.passes(),
    attaches: () => track.sender!.writes.filter((w) => w !== null).length,
    spent: () => [...spent],
    pending: () => [...pendingRepause],
    reports: () => reports,
    repauseFailures: () => repauseFailures,
    dropped: () => dropped,
    disproved: () => disproved,
  };
}

/** Both livekit re-attachers, wired exactly where `state.tsx` wires them. */
function wireReassert(
  track: FakeLocalTrack,
  caller: ReturnType<typeof productionCaller>,
): void {
  track.on("UpstreamResumed", () => void caller.sweep());
  track.on("TrackProcessorUpdate", () => void caller.sweep());
}

for (const wire of WIRES) {
  test(`a persistently failing detach does not live-lock the sweep (${wire} wire)`, async () => {
    // The scenario the post-condition exists for, and the one the fourth review
    // found spinning: `repause` resumes, its `UpstreamResumed` re-enters the
    // sweep, the pause throws, and the wire is live again — forever,
    // re-attaching the sender on every pass.
    const track = new FakeLocalTrack("mic", wire);
    await applyPublishGate([gated(track)], held);
    await drainMacro(2);
    track.republish(); // stale-true flag over a live sender
    track.sender!.rejectDetach = true; // the detach will never land

    const caller = productionCaller(track);
    wireReassert(track, caller);
    await caller.sweep();
    await drainMacro();

    // The crucial number: it stopped re-attaching. Measured as-shipped through
    // this same harness: 5 re-attaches on a micro wire, 3 on a macro one.
    assert.ok(
      caller.attaches() <= 2,
      `the sweep re-attached the sender ${caller.attaches()} times while gated`,
    );
    assert.ok(
      caller.passes() <= 6,
      `the sweep spun: ${caller.passes()} passes`,
    );
    // As-shipped the cap dropped a trailing pass on the micro wire — a sweep
    // something asked for and did not get, under a live wire.
    assert.equal(caller.dropped(), 0, "the cap dropped a pass");
    assert.ok(caller.reports() >= 1, "the failure must still be reported");
    // 🔴 And the spend must stay REACHABLE. Two earlier designs bounded the
    // re-attaches by making it unreachable, which reads identically on every
    // other assertion here and silently removes the episode-level bound.
    assert.deepEqual(
      caller.spent(),
      ["microphone/TR_1"],
      "a detach that THREW never reached the spent set",
    );
    // Honest about what is NOT fixed: the wire really is still live, because
    // `replaceTrack(null)` really does keep rejecting. The gate reports it
    // (`reports`), withdraws the banner's pause claim, and stops re-attaching.
    assert.equal(track.upstream(), "live");
    assert.equal(caller.disproved(), true);
  });

  test(`the mirror window converges instead of latching (${wire} wire)`, async () => {
    // The window the module comment calls reachable on EVERY normal join for
    // anyone with denoise, non-unity gain or a tone preset: `#syncMicPipeline`
    // runs `setProcessor` inside the `negotiating` gate, and `setProcessor`
    // takes `trackChangeLock`, NOT `pauseUpstreamLock`, so its attach races the
    // sweep's detach instead of queueing behind it.
    //
    // Here the in-flight attach is released BY the sweep's own detach, so it
    // writes last: the repause's `pauseUpstream()` RESOLVED and the
    // post-condition still reads live. That is a `repauseFailed` no retry
    // needs to give up on — and the case that dies if the drive-scoped
    // suppression is scoped to the EPISODE instead, which latches the name and
    // leaves the mic on the wire for the rest of the call.
    const track = new FakeLocalTrack("mic", wire);
    await applyPublishGate([gated(track)], held);
    await drainMacro(2);
    track.republish(); // the enable-window republish: {flag: true, live}

    const caller = productionCaller(track);
    wireReassert(track, caller);

    const release = track.sender!.holdAttach();
    let released = false;
    track.sender!.onDetachCall = () => {
      if (released) return;
      released = true;
      release();
    };
    track.attachProcessor();

    await caller.sweep();
    await drainMacro();

    // Identical to as-shipped, which is the whole assertion: converges quiet,
    // nothing latched, nothing reported.
    assert.equal(
      track.upstream(),
      "quiet",
      "the mirror window left the mic on the wire",
    );
    assert.deepEqual(
      caller.spent(),
      [],
      "a pause that RESOLVED spent the publication — a permanent disarm over a failure a retry fixes",
    );
    assert.deepEqual(
      caller.pending(),
      [],
      "the drive-scoped suppression outlived its drive",
    );
    assert.equal(caller.reports(), 0, "reported a failure it went on to fix");
    // 🔴 ANTI-VACUITY, and an honest statement of what each axis covers here.
    // On the MICRO wire the released attach lands inside the microtask gap
    // between the detach resolving and the post-condition read, so the repause
    // RESOLVES and still reads live — the `repauseFailed` this spec is about,
    // and the input an EPISODE-scoped pending set latches on. On the MACRO wire
    // that gap is a microtask and an attach costs a macrotask, so it cannot
    // land inside it: measured `repauseFailed = 0`, and this instance asserts
    // convergence only, NOT the scoping. Stated per axis rather than averaged,
    // because averaging is how a spec goes quietly vacuous on one of them.
    assert.equal(
      caller.repauseFailures(),
      wire === "micro" ? 1 : 0,
      "the mirror-window scenario no longer produces the failing repause it is about",
    );
    assert.equal(
      caller.disproved(),
      false,
      "the banner withdrew its pause claim over a window that converged",
    );
    //
    // 🔴 SCOPE, so this spec is not read as coverage it does not have. None of
    // this CLOSES the mirror window: a sweep during the in-flight attach still
    // reads `{flag: true, quiet}` and still calls that a settled pause, and it
    // is still a lie for as long as the attach takes. All that is asserted here
    // is that the window CONVERGES rather than latching. The fix is R2-1 half
    // (ii) — defer effect attachment while the gate is held — specified in the
    // 6.5 breakdown and never built (`publishGate.ts`, module comment).
  });
}

// ---- The class that had no spec at all (wave-0 completion audit) ----------
//
// Wave 0's report claimed "18 attaches" for an external re-attacher and read it
// as a bound. It is not a bound: 18 is `productionCaller`'s own `confirmCap`
// (8) showing through. Measured against THIS module through THIS harness, with
// the confirm cap the only thing varied:
//
//     cap= 4 -> passes=10  attaches=10  reports= 4  spent=[] wire=live
//     cap= 8 -> passes=18  attaches=18  reports= 8  spent=[] wire=live
//     cap=20 -> passes=42  attaches=42  reports=20  spent=[] wire=live
//     cap=50 -> passes=102 attaches=102 reports=50  spent=[] wire=live
//
// identical on both wires, and unchanged when the drain length is held fixed
// instead of scaled with the cap. Exactly `2 * (cap + 1)`: two attaches and two
// passes per confirm, one drive per confirm, no termination.
//
// 🔴 WHY NOTHING HERE CATCHES IT. Every bound this module has is PER DRIVE —
// `coalescingSweeper`'s `maxPasses`, and `repausePending`, which `onDriveStart`
// clears — or contingent on `threw`, and this re-attacher makes the detach
// RESOLVE, so `repauseThrew` is empty and the permanent spend never arms (which
// is correct: a retry genuinely could fix this). Nothing anywhere bounds the
// number of DRIVES, and the confirm chain schedules one per report.
//
// It is a resource/telemetry live-lock, not a silent-plaintext path: `disproved`
// latches TRUE and stays true, so the banner withdraws its pause claim and the
// user sees the failure. That is the only reason this was a known red rather
// than a stop-ship.
//
// 🔴 BOTH SPECS BELOW ARE PERMANENT CHARACTERISATIONS OF THE UNBUDGETED MODULE,
// not tripwires waiting for a fix (wave-0 completion audit, W1-1). The bound is
// an EPISODE-LEVEL CONFIRM BUDGET and it landed in `publishGateEpisode.ts` in
// wave 1 — but it cannot move one number here, and the earlier version of this
// block claimed it would. `productionCaller` is a self-contained
// re-implementation of `state.tsx`'s three methods living inside THIS FILE,
// importing only `applyPublishGate` and `coalescingSweeper`; no budget in
// another module can reach it, so the skip it carried would have stayed red
// forever while its green sibling claimed to be a tripwire. These two specs
// therefore characterise `publishGate.ts` as it is and will stay, and the
// anti-vacuity assertion — that the cost does NOT follow the harness's confirm
// cap — lives in `publishGateEpisode.test.ts`, where a budget actually is. Do
// not "restore" it here.
//
// 🔴 THE COUPLING NOBODY WROTE DOWN, recorded because the earlier plan for this
// pair rested on it silently: the comparison below is cap 4 against cap 12, so
// an assertion that the cost is FLAT across it could only ever have passed for
// a budget of N <= 4 confirms. `publishGateEpisode.ts` ships
// `CONFIRM_BUDGET = 4`, and its own spec deliberately compares caps 6 and 20
// rather than inheriting this file's, so the two are not coupled any more.
//
// 🔴 AND THE JUSTIFICATION THE SKIP CARRIED WAS WRONG ON MECHANISM AND ON
// COUNT, which is worth correcting rather than deleting because the conclusion
// it reached is right. It said a permanently red spec file would make the gate
// mutations "vacuously red" and destroy their evidence, and put the number at
// 15. `rtc-mutations.py`'s `baseline_green()` runs every spec any SELECTED
// mutation relies on before mutating anything and returns 97 without running a
// single mutation if one of them is red — so a red spec file yields ZERO
// mutations, loudly, not vacuous ones. Do not ship this file red: the reason is
// that it buys nothing at all, not that it buys a false green.
//
// The count was wrong too, and so is any replacement for it: the entries at risk
// are the `file=GATE` ones, of which there were 17 at this branch's base
// (`2b781b6f`) and 19 while wave 1 was retargeting them — never 15. The
// derivation is one line and it is the only thing worth committing: count the
// entries in `rtc-mutations.py` whose `file=` is `GATE`. Do not trust this
// sentence's arithmetic; re-run it.

/**
 * The production caller against a SILENT external re-attacher, at a given
 * confirm cap. Returns the caller so the assertions can read its counters.
 *
 * The re-attacher is application code calling `sender.replaceTrack(liveTrack)`
 * DIRECTLY after every detach and emitting nothing — `setProcessor`'s own inner
 * call minus the `TrackProcessorUpdate` that would have triggered a sweep.
 * livekit's `_isUpstreamPaused` is untouched, so every later sweep reads
 * `{flag: true, live}` and computes `repause` all over again.
 */
async function externalReattacher(
  wire: WireModel,
  confirmCap: number,
): Promise<{
  track: FakeLocalTrack;
  caller: ReturnType<typeof productionCaller>;
  reattaches: number;
}> {
  const track = new FakeLocalTrack("mic", wire);
  await applyPublishGate([gated(track)], held);
  await drainMacro(2);
  track.republish(); // the enable-window republish: {flag: true, live}

  const caller = productionCaller(track, "microphone/TR_1", confirmCap);
  wireReassert(track, caller);

  let reattaches = 0;
  const sender = track.sender!;
  const inner = sender.replaceTrack.bind(sender);
  sender.replaceTrack = async (t: string | null): Promise<void> => {
    await inner(t);
    if (t !== null) return;
    reattaches++;
    await inner(track.raw);
  };

  await caller.sweep();
  // Long enough that the confirm chain, not the drain, is what ends the run —
  // verified by re-measuring at a FIXED drain and getting the same numbers.
  await drainMacro(confirmCap * 8 + 40);
  return { track, caller, reattaches };
}

for (const wire of WIRES) {
  test(`an external re-attacher costs 2 attaches per CONFIRM, and nothing bounds the confirms (${wire} wire)`, async () => {
    // CHARACTERISATION of a known defect, not approval of it. The assertion is
    // `2 * (cap + 1)` — i.e. the cost follows the harness's cap exactly, which
    // is what "nothing in this module bounds the number of drives" looks like
    // from outside. Pinned as an equality so a change to `applyPublishGate` or
    // `coalescingSweeper` that moves the cost has to be re-derived rather than
    // quietly absorbed. The episode-level budget cannot move it — see the block
    // above — so a green here is not the defect surviving the fix.
    const small = await externalReattacher(wire, 4);
    const large = await externalReattacher(wire, 12);

    assert.deepEqual(
      {
        small: small.caller.attaches(),
        large: large.caller.attaches(),
      },
      { small: 10, large: 26 },
      "the re-attach cost is no longer exactly 2 per confirm — re-derive it",
    );
    assert.deepEqual(
      { small: small.caller.passes(), large: large.caller.passes() },
      { small: 10, large: 26 },
      "the pass count is no longer 2 per confirm — re-derive it",
    );
    assert.equal(
      large.caller.reports(),
      12,
      "one report per confirm: the telemetry storm is part of the class",
    );

    // 🔴 The half that keeps this out of stop-ship territory, asserted so a
    // future change cannot quietly turn a LOUD live-lock into a silent one.
    assert.equal(
      large.track.upstream(),
      "live",
      "the wire really is live throughout — that is what makes this a defect",
    );
    assert.equal(
      large.caller.disproved(),
      true,
      "the banner must WITHDRAW its pause claim while this is happening",
    );
    // And the permanent disarm must NOT arm here: the detach RESOLVED every
    // time, so a retry genuinely could fix it. Spending would be the
    // 2026-09-08 defect re-armed.
    assert.deepEqual(large.caller.spent(), []);
  });

  test(`the cost rises with the harness cap, so the bound is elsewhere (${wire} wire)`, async () => {
    // The other half of the characterisation, and the reason the anti-vacuity
    // assertion had to move out of this file: driven through `productionCaller`
    // the cost rises with the harness's willingness to keep confirming, without
    // limit. That is a statement about `applyPublishGate` +
    // `coalescingSweeper` and about nothing else. Its counterpart — that the
    // cost is FLAT across two harness caps once an episode-level budget exists
    // — is `the cost does not follow the harness's confirm cap` in
    // `publishGateEpisode.test.ts`, and it is green there.
    //
    // Running, not skipped: a skip here could never go green, because nothing
    // this file imports will ever hold a budget.
    const small = await externalReattacher(wire, 4);
    const large = await externalReattacher(wire, 12);
    assert.ok(
      small.reattaches > 0 && large.reattaches > 0,
      "the external re-attacher never ran, so neither number means anything",
    );
    assert.ok(
      large.caller.attaches() > small.caller.attaches(),
      `the cost stopped following the harness confirm cap (${small.caller.attaches()} at cap 4, ${large.caller.attaches()} at cap 12) — if a bound landed inside publishGate.ts then this characterisation is stale and must be re-derived, not deleted`,
    );
  });
}

test("onDriveStart fires once per DRIVE, never once per pass", async () => {
  // The seam the drive-scoping depends on. Clearing the pending set per PASS
  // would disarm the suppression inside the burst it exists to bound; clearing
  // it per EPISODE makes it a permanent per-name disarm. Only the drive
  // boundary is correct, so it is the boundary that gets a spec.
  const starts: number[] = [];
  let burst = true;
  const sweeper = coalescingSweeper(
    async () => {
      if (burst) {
        burst = false;
        void sweeper.sweep(); // a sweep's own op, re-entering
      }
      await Promise.resolve();
    },
    4,
    () => {},
    () => starts.push(sweeper.passes()),
  );
  await sweeper.sweep(); // one drive, two passes (the burst collapses)
  await sweeper.sweep(); // a second drive
  assert.deepEqual(
    starts,
    [0, 2],
    "the pending set is cleared somewhere other than the drive boundary",
  );
});

test("a PENDING repause reports, issues nothing, and never feeds itself", async () => {
  // The v1 shape of this fix suppressed the op but left `op === "repause"` on
  // the report, so a SUPPRESSED publication came back in `repauseFailed` and
  // the caller re-armed the suppression from it — a self-feeding permanent
  // per-name disarm, which is exactly what `publishGate.ts` forbids. `issued`
  // makes that impossible by construction rather than by the caller's care.
  const track = new FakeLocalTrack();
  await applyPublishGate([gated(track)], held);
  track.republish();
  const before = track.pauseCalls;
  const result = await applyPublishGate([gated(track)], held, {
    repausePending: new Set(["microphone/TR_1"]),
  });
  assert.deepEqual(result.unproven, ["microphone/TR_1"]);
  assert.deepEqual(
    result.repauseFailed,
    [],
    "a suppressed repause was reported as a FAILED repause, so the suppression feeds itself",
  );
  assert.deepEqual(result.repauseThrew, []);
  assert.equal(
    track.pauseCalls,
    before,
    "a pending repause called into livekit",
  );
  assert.equal(track.upstream(), "live", "and it did not touch the wire");
});

test("a SPENT repause does not feed either set either", async () => {
  const track = new FakeLocalTrack();
  await applyPublishGate([gated(track)], held);
  track.republish();
  const result = await applyPublishGate([gated(track)], held, {
    repauseSpent: new Set(["microphone/TR_1"]),
  });
  assert.deepEqual(result.unproven, ["microphone/TR_1"]);
  assert.deepEqual(result.repauseFailed, []);
  assert.deepEqual(result.repauseThrew, []);
});

test("only a detach that THREW is a repauseThrew", async () => {
  // (B). `repauseThrew` is the only thing that may feed the PERMANENT spend,
  // because a spend is unreachable to lift: once a name is suppressed and its
  // wire is live nothing issues a pause, so nothing is ever `proven`, so the
  // un-spend never fires. A pause that REJECTED is the one failure a retry
  // cannot fix — livekit's flag is true over a sender it never detached.
  const threw = new FakeLocalTrack();
  await applyPublishGate([gated(threw)], held);
  threw.republish();
  threw.sender!.rejectDetach = true;
  const rejected = await applyPublishGate([gated(threw)], held);
  assert.deepEqual(rejected.repauseFailed, ["microphone/TR_1"]);
  assert.deepEqual(rejected.repauseThrew, ["microphone/TR_1"]);

  // The other shape: the pause RESOLVED, and something else re-attached the
  // sender (`handleTrackUnmuteEvent` here). A retry CAN help, so this is a
  // `repauseFailed` and must NEVER be a `repauseThrew`.
  const resolved = new FakeLocalTrack();
  await applyPublishGate([gated(resolved)], held);
  resolved.republish();
  const raced = await applyPublishGate(
    [
      {
        ...gated(resolved),
        pauseUpstream: async () => {
          await resolved.pauseUpstream();
          await resolved.resumeUpstream(); // livekit's unmute handler
        },
      },
    ],
    held,
  );
  assert.deepEqual(raced.repauseFailed, ["microphone/TR_1"]);
  assert.deepEqual(
    raced.repauseThrew,
    [],
    "a pause that RESOLVED was called a throw, which spends the publication forever",
  );
});

test("a gateHeld() that THROWS is not a failed detach", async () => {
  // The wave-0 audit's FIX 1. `threw` is the sole input to a PERMANENT per-name
  // disarm, and its justification is specifically "livekit's flag is true over a
  // sender it never detached, so every later pause early-returns". A
  // `gateHeld()` that threw satisfies none of that: `pauseUpstream()` was not
  // called at all, no flag was written, and a retry can help.
  //
  // 🔴 It was reported as `repauseThrew` for one round because the attribution
  // was a REGION flag set before the repause arm's `gateHeld()` re-check rather
  // than a catch around the detach. Unreachable while `state.tsx` passes
  // `() => this.#publishGate.size > 0`; reachable the moment wave 1 passes
  // `EpisodeDeps.gateHeld()`, which the 6.5 breakdown specifies. A spec, not a
  // comment, is what holds that across the wave boundary.
  const track = new FakeLocalTrack();
  await applyPublishGate([gated(track)], held);
  track.republish(); // {flag: true, live} ⇒ repause
  const pausesBefore = track.pauseCalls;

  // Throws on every call after the FIRST — deliberately not "on the 2nd call",
  // which would go vacuous the moment a refactor adds a `gateHeld()` anywhere.
  let calls = 0;
  const throwingGate = (): boolean => {
    if (++calls > 1) throw new Error("gateHeld threw (wave-1 EpisodeDeps)");
    return true;
  };

  const result = await applyPublishGate([gated(track)], throwingGate);
  assert.deepEqual(result.unproven, ["microphone/TR_1"]);
  assert.deepEqual(
    result.repauseThrew,
    [],
    "a gateHeld() that threw spent the publication PERMANENTLY, over a detach that was never called",
  );
  assert.deepEqual(
    result.repauseFailed,
    [],
    "a gateHeld() that threw disarmed the gate for the rest of the drive",
  );
  assert.equal(
    track.pauseCalls,
    pausesBefore,
    "pauseUpstream() must not even have been reached — that is the whole point",
  );
});

test("a pauseUpstream() that throws SYNCHRONOUSLY is not a failed detach", async () => {
  // The second half of FIX 1, and the reason a bare `try { await
  // publication.pauseUpstream() }` would not have been enough. livekit's
  // `pauseUpstream` is `async`, so it cannot throw synchronously — a
  // synchronous throw is `state.tsx`'s ADAPTER over a `LocalTrack` torn down
  // since the `trackPublications` snapshot. livekit's body never ran,
  // `_isUpstreamPaused` was never written, no later pause early-returns.
  const track = new FakeLocalTrack();
  await applyPublishGate([gated(track)], held);
  track.republish();
  const pausesBefore = track.pauseCalls;

  const result = await applyPublishGate(
    [
      {
        ...gated(track),
        pauseUpstream: (): Promise<void> => {
          throw new Error("adapter: LocalTrack torn down");
        },
      },
    ],
    held,
  );
  assert.deepEqual(result.unproven, ["microphone/TR_1"]);
  assert.deepEqual(
    result.repauseThrew,
    [],
    "a synchronous adapter throw spent the publication PERMANENTLY, over a livekit call that never happened",
  );
  // But it IS a `repauseFailed`: the resume ran and re-attached the sender, the
  // pause did not, so this drive's burst must stop re-issuing it. Drive-scoped,
  // lifted at the next `onDriveStart` — the only disarm this may feed.
  assert.deepEqual(result.repauseFailed, ["microphone/TR_1"]);
  assert.equal(
    track.pauseCalls,
    pausesBefore,
    "livekit's pauseUpstream was never entered",
  );
});

test("a post-condition read that throws feeds NEITHER set", async () => {
  // The third event the single outer catch conflates. `pauseUpstream()`
  // resolved; the read after it threw. That says nothing at all about the wire,
  // so it may not feed the drive-scoped suppression and certainly not the
  // permanent spend — and the disarm would be durable, because a name is
  // `${source}/${trackSid}` and every re-attacher preserves `trackSid`.
  const track = new FakeLocalTrack();
  await applyPublishGate([gated(track)], held);
  track.republish(); // {flag: true, live} ⇒ repause
  let reads = 0;
  const result = await applyPublishGate(
    [
      {
        ...gated(track),
        upstream: () => {
          if (++reads > 1) throw new Error("torn down mid-sweep");
          return track.upstream();
        },
      },
    ],
    held,
  );
  assert.deepEqual(result.unproven, ["microphone/TR_1"]);
  assert.deepEqual(
    result.repauseFailed,
    [],
    "a read that threw was reported as an issued repause that did not end quiet",
  );
  assert.deepEqual(result.repauseThrew, []);
});

test("the fake reproduces the PINNED livekit-client, and fails when the pin moves", () => {
  // Every claim this file makes about livekit — the flag set BEFORE the detach,
  // the deferred `sender.track` write, `resumeUpstream` emitting before its
  // attach, `setProcessor` emitting after its own, two independent mutexes —
  // was read off 2.15.13's source. A version bump does not invalidate them, but
  // it does make them UNVERIFIED, and an unverified fake is a spec asserting
  // itself.
  const pkg = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { dependencies: Record<string, string> };
  assert.equal(
    pkg.dependencies["livekit-client"],
    "2.15.13",
    "livekit-client moved: re-read pauseUpstream / resumeUpstream / setProcessor / the two mutexes before trusting this fake",
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
  // And the same for the narrower channel: `threw` is only ever read AND-ed
  // with `op === "repause"`. Loosening it to "any op that threw" spends the
  // publication over a plain `pause` failure — this defect, re-armed.
  assert.deepEqual(
    result.repauseThrew,
    [],
    "a plain pause failure spent the publication",
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
