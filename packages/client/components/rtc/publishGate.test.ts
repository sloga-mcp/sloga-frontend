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
  assert.deepEqual(await applyPublishGate([gated(track)], held), {
    unproven: [],
    failed: [],
  });
  assert.equal(track.upstream(), "quiet");

  track.republish();
  assert.equal(track.upstream(), "live");

  assert.deepEqual(await applyPublishGate([gated(track)], held), {
    unproven: [],
    failed: [],
  });
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
  assert.deepEqual(await applyPublishGate([gated(track)], held), {
    unproven: [],
    failed: [],
  });
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
  assert.deepEqual(result, {
    unproven: [],
    failed: ["microphone/TR_1"],
  });
});

test("a closed transport counts as quiet, and does not go loud", async () => {
  const track = new FakeLocalTrack();
  track.sender!.transportState = "closed";
  assert.deepEqual(await applyPublishGate([gated(track)], held), {
    unproven: [],
    failed: [],
  });
});

test("a FAILED transport still counts as live, so the pause is attempted", async () => {
  // The conservative direction: `replaceTrack(null)` still succeeds on a failed
  // transport, so the pause lands and the post-condition passes. Reading
  // `failed` as quiet would skip the op and call it proven.
  const track = new FakeLocalTrack();
  track.sender!.transportState = "failed";
  assert.equal(track.upstream(), "live");
  assert.deepEqual(await applyPublishGate([gated(track)], held), {
    unproven: [],
    failed: [],
  });
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
