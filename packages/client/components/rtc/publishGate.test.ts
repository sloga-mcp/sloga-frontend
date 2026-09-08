// The publish gate's other half: that a HELD gate actually reaches the wire.
//
// `mlsCallSession.falsered.test.ts` covers the session side — that the ME-10
// banner only renders over a held reason set. That is necessary and was never
// sufficient: during the 2026-09-08 join-race legs the reason set WAS non-empty
// and the wire was not quiet, so no spec over the reason set alone could have
// failed for the leg's reason.
//
// So these specs drive the REAL sweep (`applyPublishGate`) against a fake that
// reproduces livekit-client 2.15.13's pause bookkeeping and its republish
// verbatim, and ask the one question the banner answers: is anything still on
// the wire? Driving the real sweep rather than re-implementing its mapping in
// the spec is deliberate — the op-to-call mapping, the order inside `repause`,
// the mid-sequence gate re-check and the post-condition are all only covered if
// the code under test owns them.
import assert from "node:assert/strict";
import test from "node:test";

import {
  type GatedPublication,
  applyPublishGate,
  publishGateOp,
} from "./publishGate.ts";

// ---- The pure table ---------------------------------------------------------

test("an empty gate always resumes", () => {
  for (const upstreamPaused of [true, false]) {
    for (const onTheWire of [true, false]) {
      assert.equal(
        publishGateOp({ gateHeld: false, upstreamPaused, onTheWire }),
        "resume",
      );
    }
  }
});

test("a held gate pauses what is on the wire", () => {
  assert.equal(
    publishGateOp({ gateHeld: true, upstreamPaused: false, onTheWire: true }),
    "pause",
  );
});

test("a held gate RE-pauses a live sender that livekit thinks is paused", () => {
  assert.equal(
    publishGateOp({ gateHeld: true, upstreamPaused: true, onTheWire: true }),
    "repause",
  );
});

test("a held gate leaves an OBSERVED-quiet publication alone", () => {
  for (const upstreamPaused of [true, false]) {
    assert.equal(
      publishGateOp({ gateHeld: true, upstreamPaused, onTheWire: false }),
      "none",
    );
  }
});

// ---- livekit 2.15.13 fidelity ----------------------------------------------

class FakeSender {
  track: string | null;
  transportState: "connected" | "closed" = "connected";
  /** Every `replaceTrack` argument, in order — the wire's history. */
  readonly writes: (string | null)[] = [];
  /** Set to make `replaceTrack(null)` reject, as a closing transport can. */
  rejectDetach = false;

  constructor(track: string | null) {
    this.track = track;
  }

  async replaceTrack(track: string | null): Promise<void> {
    if (track === null && this.rejectDetach) {
      throw new Error("InvalidStateError: sender is closed");
    }
    this.writes.push(track);
    this.track = track;
  }
}

/**
 * `LocalTrack`'s upstream half (2.15.13), plus livekit's own republish. The
 * details that matter, all verbatim from the pinned ESM build:
 *
 *  - the guard reads the FLAG, and the flag is set BEFORE the detach;
 *  - the detach is skipped when the transport is closed;
 *  - `mediaStreamTrack` is a GETTER returning the PROCESSED track when a
 *    processor is attached, so a resume re-attaches processed, not raw;
 *  - `republish()` (`unpublishTrack` + `publishOrRepublishTrack`) builds a new
 *    sender carrying the live track and never touches the flag.
 */
class FakeLocalTrack {
  raw = "mic";
  processed: string | null = null;
  sender: FakeSender | undefined;
  paused = false;

  constructor() {
    this.sender = new FakeSender(this.mediaStreamTrack);
  }

  get mediaStreamTrack(): string {
    return this.processed ?? this.raw;
  }

  get isUpstreamPaused(): boolean {
    return this.paused;
  }

  onTheWire(): boolean {
    const sender = this.sender;
    if (!sender?.track) return false;
    return sender.transportState !== "closed";
  }

  async pauseUpstream(): Promise<void> {
    if (this.paused === true) return;
    if (!this.sender) return;
    this.paused = true;
    if (this.sender.transportState !== "closed") {
      await this.sender.replaceTrack(null);
    }
  }

  async resumeUpstream(): Promise<void> {
    if (this.paused === false) return;
    if (!this.sender) return;
    this.paused = false;
    if (this.sender.transportState !== "closed") {
      await this.sender.replaceTrack(this.mediaStreamTrack);
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
    this.sender?.replaceTrack(this.processed);
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
    onTheWire: () => track.onTheWire(),
    pauseUpstream: () => track.pauseUpstream(),
    resumeUpstream: () => track.resumeUpstream(),
  };
}

const held = () => true;
const empty = () => false;

// ---- The defect, and the fix ----------------------------------------------

test("the enable flip's republish defeats a BARE re-pause", async () => {
  // The pre-fix sweep, kept here as the record of what regressed: one bare op
  // per publication, trusting livekit's idempotency.
  const track = new FakeLocalTrack();
  await track.pauseUpstream();
  assert.equal(track.onTheWire(), false, "the gate did not pause the mic");

  track.republish(); // setEncryptionEnabled(true)
  assert.equal(track.onTheWire(), true, "the republish revived the sender");
  assert.equal(track.isUpstreamPaused, true, "the pause flag went stale-true");

  await track.pauseUpstream(); // the bare re-assert
  assert.equal(
    track.onTheWire(),
    true,
    "expected the bare re-assert to be defeated by the stale flag",
  );
});

test("the sweep closes it, and reports nothing left over", async () => {
  const track = new FakeLocalTrack();
  assert.deepEqual(await applyPublishGate([gated(track)], held), {
    unproven: [],
  });
  assert.equal(track.onTheWire(), false);

  track.republish();
  assert.equal(track.onTheWire(), true);

  // No hint about which publication was rebuilt: the sweep observes it.
  assert.deepEqual(await applyPublishGate([gated(track)], held), {
    unproven: [],
  });
  assert.equal(
    track.onTheWire(),
    false,
    "a held gate left the mic on the wire",
  );
});

test("setProcessor's direct replaceTrack is caught by the same observation", async () => {
  const track = new FakeLocalTrack();
  await applyPublishGate([gated(track)], held);
  assert.equal(track.onTheWire(), false);

  track.attachProcessor();
  assert.equal(track.onTheWire(), true);
  assert.equal(
    track.isUpstreamPaused,
    true,
    "flag stale-true, as livekit leaves it",
  );

  await applyPublishGate([gated(track)], held);
  assert.equal(track.onTheWire(), false);
  // The resume re-attached the PROCESSED track, not the raw mic — livekit's
  // `mediaStreamTrack` is a getter. If it re-attached raw, a denoised call
  // would leak un-denoised audio for the length of the repause.
  assert.ok(
    !track.sender!.writes.includes("mic"),
    `the repause re-attached the raw track: ${track.sender!.writes.join(",")}`,
  );
});

test("an already-quiet publication is never re-attached", async () => {
  const track = new FakeLocalTrack();
  await applyPublishGate([gated(track)], held);
  const writesBefore = [...track.sender!.writes];

  // Another publication's event sweeps the whole roster. This one is quiet, so
  // nothing may touch it — a resume-then-pause here would put it briefly back
  // on the wire, which is the one thing the gate exists to prevent.
  await applyPublishGate([gated(track)], held);
  assert.deepEqual(track.sender!.writes, writesBefore);
  assert.equal(track.onTheWire(), false);
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
  // And the reason it must: livekit set the flag before the detach, so the
  // sender is live under a flag that says paused.
  assert.equal(track.isUpstreamPaused, true);
  assert.equal(track.onTheWire(), true);
});

test("a pause that RESOLVES over a re-attached wire is still reported", async () => {
  // `LocalTrack`'s constructor binds `handleTrackUnmuteEvent` to the native
  // MediaStreamTrack `unmute` event, and it calls `resumeUpstream()`
  // UNCONDITIONALLY — a device wake, a PipeWire source change, an
  // exclusive-mode release. If that wins livekit's per-track lock just after
  // our pause, the pause resolved and the wire is live again. Nothing in the
  // pause's own return value can say so; only re-reading the wire can. (The
  // `UpstreamResumed` listener in state.tsx is the primary cover for this; the
  // post-condition is what makes its absence visible rather than silent.)
  const track = new FakeLocalTrack();
  const result = await applyPublishGate(
    [
      {
        name: "microphone/TR_1",
        upstreamPaused: false,
        onTheWire: () => track.onTheWire(),
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
  assert.equal(track.onTheWire(), true);
});

test("a rejecting detach recovers on the next sweep instead of wedging", async () => {
  const track = new FakeLocalTrack();
  track.sender!.rejectDetach = true;
  await applyPublishGate([gated(track)], held);
  track.sender!.rejectDetach = false;
  // `none` would leave it live forever. The observation makes it `repause`.
  assert.deepEqual(await applyPublishGate([gated(track)], held), {
    unproven: [],
  });
  assert.equal(track.onTheWire(), false);
});

test("a closed transport counts as quiet, and does not go loud", async () => {
  const track = new FakeLocalTrack();
  track.sender!.transportState = "closed";
  assert.deepEqual(await applyPublishGate([gated(track)], held), {
    unproven: [],
  });
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
  assert.equal(
    track.onTheWire(),
    true,
    "the mic was left muted with no reason held",
  );
});

test("an empty gate resumes a rebuilt publication", async () => {
  const track = new FakeLocalTrack();
  await applyPublishGate([gated(track)], held);
  track.republish();
  await applyPublishGate([gated(track)], held);
  assert.equal(track.onTheWire(), false);

  await applyPublishGate([gated(track)], empty);
  assert.equal(track.onTheWire(), true, "a healthy call ended up muted");
  assert.equal(track.isUpstreamPaused, false);
});

test("every publication is acted on, and each is judged on its own wire", async () => {
  const mic = new FakeLocalTrack();
  const cam = new FakeLocalTrack();
  cam.raw = "camera";
  cam.sender = new FakeSender("camera");
  // The mic is quiet already; the camera was just rebuilt under a stale flag.
  await applyPublishGate([gated(mic, "microphone/TR_1")], held);
  cam.paused = true;

  const result = await applyPublishGate(
    [gated(mic, "microphone/TR_1"), gated(cam, "camera/TR_2")],
    held,
  );
  assert.deepEqual(result.unproven, []);
  assert.equal(mic.onTheWire(), false);
  assert.equal(cam.onTheWire(), false, "the camera was left on the wire");
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
    onTheWire: () => false,
    pauseUpstream: op(name),
    resumeUpstream: op(name),
  });
  await applyPublishGate([slow("a"), slow("b")], empty);
  // All issued, THEN all completed. Awaiting in the loop would interleave them
  // as issue:a, done:a, issue:b, done:b.
  assert.deepEqual(order, ["issue:a", "issue:b", "done:a", "done:b"]);
});
