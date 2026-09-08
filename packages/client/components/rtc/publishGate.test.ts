import assert from "node:assert/strict";
import test from "node:test";

import { publishGateOp } from "./publishGate.ts";

// ---- The pure table ---------------------------------------------------------

test("an empty gate always resumes", () => {
  for (const upstreamPaused of [true, false]) {
    for (const senderRebuilt of [true, false]) {
      assert.equal(
        publishGateOp({ gateHeld: false, upstreamPaused, senderRebuilt }),
        "resume",
      );
    }
  }
});

test("a held gate pauses a live publication", () => {
  assert.equal(
    publishGateOp({
      gateHeld: true,
      upstreamPaused: false,
      senderRebuilt: false,
    }),
    "pause",
  );
  // Rebuilt but not flagged: the bare pause lands, so nothing extra is needed.
  assert.equal(
    publishGateOp({
      gateHeld: true,
      upstreamPaused: false,
      senderRebuilt: true,
    }),
    "pause",
  );
});

test("a held gate leaves an untouched paused publication alone", () => {
  assert.equal(
    publishGateOp({
      gateHeld: true,
      upstreamPaused: true,
      senderRebuilt: false,
    }),
    "none",
  );
});

test("a held gate RE-pauses a rebuilt sender under a stale pause flag", () => {
  assert.equal(
    publishGateOp({
      gateHeld: true,
      upstreamPaused: true,
      senderRebuilt: true,
    }),
    "repause",
  );
});

// ---- livekit 2.15.13 fidelity ----------------------------------------------
//
// The defect lives in livekit's bookkeeping, so a spec that only exercises the
// pure table would pass just as happily with the old bare rule. This fake
// reproduces `LocalTrack`'s pause/resume and the republish that
// `setE2EEEnabled` performs, verbatim from the pinned
// `livekit-client@2.15.13` ESM build, and asks the ONE question the user's
// banner answers: is anything on the wire?

class FakeSender {
  track: string | null;
  constructor(track: string | null) {
    this.track = track;
  }
  replaceTrack(track: string | null): void {
    this.track = track;
  }
}

/** `LocalTrack`'s upstream half (2.15.13), plus livekit's own republish. */
class FakeLocalTrack {
  mediaStreamTrack = "mic";
  sender: FakeSender | undefined;
  /** livekit's `_isUpstreamPaused` — the flag its idempotency guard reads. */
  paused = false;

  constructor() {
    this.sender = new FakeSender(this.mediaStreamTrack);
  }

  get isUpstreamPaused(): boolean {
    return this.paused;
  }

  /** Whether real RTP is leaving this device right now. */
  onTheWire(): boolean {
    return this.sender?.track !== null && this.sender?.track !== undefined;
  }

  pauseUpstream(): void {
    if (this.paused === true) return; // the guard the sweep used to trust
    if (!this.sender) return;
    this.paused = true;
    this.sender.replaceTrack(null);
  }

  resumeUpstream(): void {
    if (this.paused === false) return;
    if (!this.sender) return;
    this.paused = false;
    this.sender.replaceTrack(this.mediaStreamTrack);
  }

  /**
   * `LocalParticipant.republishAllTracks(undefined, false)` — what
   * `setE2EEEnabled()` runs: unpublish, then publish onto a NEW sender that
   * carries the live track. `restartTracks` is false, so `restartTrack()` →
   * `setMediaStreamTrack()` → `resumeUpstream()` never runs and `paused` is
   * left exactly as it was.
   */
  republish(): void {
    this.sender = undefined; // unpublishTrack
    this.sender = new FakeSender(this.mediaStreamTrack); // publishOrRepublish
  }
}

/** The sweep as it was: one bare op per publication. */
function sweepBare(track: FakeLocalTrack, gateHeld: boolean): void {
  if (gateHeld) track.pauseUpstream();
  else track.resumeUpstream();
}

/** The sweep as `state.tsx` runs it now, through the policy. */
function sweepPolicy(
  track: FakeLocalTrack,
  gateHeld: boolean,
  senderRebuilt: boolean,
): void {
  switch (
    publishGateOp({
      gateHeld,
      upstreamPaused: track.isUpstreamPaused,
      senderRebuilt,
    })
  ) {
    case "pause":
      track.pauseUpstream();
      break;
    case "repause":
      track.resumeUpstream();
      track.pauseUpstream();
      break;
    case "resume":
      track.resumeUpstream();
      break;
    case "none":
      break;
  }
}

test("the enable flip's republish defeats a bare re-pause", () => {
  const track = new FakeLocalTrack();
  // `#enable()`: pausePublishing("enable-window") → the sweep pauses.
  sweepBare(track, true);
  assert.equal(track.onTheWire(), false, "the gate did not pause the mic");
  // `setEncryptionEnabled(true)` → `setE2EEEnabled` → republish.
  track.republish();
  assert.equal(track.onTheWire(), true, "the republish revived the sender");
  assert.equal(track.isUpstreamPaused, true, "the pause flag went stale-true");
  // `localTrackPublished` re-asserts the still-held gate.
  sweepBare(track, true);
  // THE DEFECT: every layer says paused, and the mic is live.
  assert.equal(
    track.onTheWire(),
    true,
    "expected the bare re-assert to be defeated by the stale flag",
  );
});

test("the policy's repause closes it", () => {
  const track = new FakeLocalTrack();
  sweepPolicy(track, true, false);
  assert.equal(track.onTheWire(), false);
  track.republish();
  assert.equal(track.onTheWire(), true);
  // `localTrackPublished` names the rebuilt publication.
  sweepPolicy(track, true, true);
  assert.equal(
    track.onTheWire(),
    false,
    "a held gate must leave nothing on the wire",
  );
  assert.equal(track.isUpstreamPaused, true);
});

test("repause is not a leak for a publication nothing rebuilt", () => {
  const track = new FakeLocalTrack();
  sweepPolicy(track, true, false);
  assert.equal(track.onTheWire(), false);
  // Another publication's republish sweeps the whole roster; this one is not
  // the rebuilt one, so it must not be re-attached even momentarily.
  const wire: boolean[] = [];
  const sender = track.sender!;
  const original = sender.replaceTrack.bind(sender);
  sender.replaceTrack = (t) => {
    original(t);
    wire.push(track.onTheWire());
  };
  sweepPolicy(track, true, false);
  assert.deepEqual(wire, [], "an untouched paused publication was re-attached");
});

test("the gate emptying still resumes a rebuilt publication", () => {
  const track = new FakeLocalTrack();
  sweepPolicy(track, true, false);
  track.republish();
  sweepPolicy(track, true, true);
  assert.equal(track.onTheWire(), false);
  sweepPolicy(track, false, false); // the session released its last reason
  assert.equal(track.onTheWire(), true, "a healthy call ended up muted");
});
