// Unit spec for push to talk's "muted unless the key is held" on every path
// that turns the microphone on — run with Node's built-in runner, from
// packages/client:
//   node --test --conditions=browser components/rtc/pttMicPolicy.test.ts
// Focus: joining, Unmute, Undeafen and a whisper's restore under push to talk
// must not publish a live microphone, a press made while that muted publish
// is landing must not open the mic after its release, and state.tsx must
// actually route those paths through the policy. Also: the muted capture is
// bounded, a live open that lands after its release is muted again, the talk
// key does nothing while Muted or Deafened, and a blur mid-hold without the
// native hook mutes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  MUTED_CAPTURE_TIMEOUT_MS,
  captureWithin,
  isMicCaptureTimeout,
  micEnableMode,
  micEnableTook,
  mutedWhileLanding,
  pttBlurMutes,
  pttLiveStays,
  pttPressOpens,
} from "./pttMicPolicy.ts";
import {
  bodiesAfter,
  codeOf,
  countWired,
  wiredAsserter,
  wiredAt,
} from "./sourcePins.harness.ts";

const BOOLS = [true, false] as const;

test("micEnableMode: push to talk with no key held publishes muted", () => {
  // The reported bug: the join published a live mic under push to talk.
  assert.equal(micEnableMode({ pushToTalk: true, pttHeld: false }), "muted");
});

test("micEnableMode: a held talk key turns the mic on live", () => {
  assert.equal(micEnableMode({ pushToTalk: true, pttHeld: true }), "live");
});

test("micEnableMode: open mic and voice activity turn it on live", () => {
  for (const pttHeld of BOOLS)
    assert.equal(micEnableMode({ pushToTalk: false, pttHeld }), "live");
});

test("micEnableMode: only push to talk with no key held is ever muted", () => {
  for (const pushToTalk of BOOLS)
    for (const pttHeld of BOOLS)
      assert.equal(
        micEnableMode({ pushToTalk, pttHeld }) === "muted",
        pushToTalk && !pttHeld,
      );
});

test("micEnableTook: under push to talk a turn-on worked when captured", () => {
  // Reading `isMicrophoneEnabled` here wrote micOn = false on every push to
  // talk Unmute, and on a held-key Unmute released before it landed.
  for (const live of BOOLS) {
    assert.equal(
      micEnableTook({ pushToTalk: true, live, captured: true }),
      true,
    );
    assert.equal(
      micEnableTook({ pushToTalk: true, live, captured: false }),
      false,
    );
  }
});

test("micEnableTook: otherwise a turn-on worked only when the mic is live", () => {
  // A capture that failed must not read as live.
  for (const captured of BOOLS) {
    assert.equal(
      micEnableTook({ pushToTalk: false, live: true, captured }),
      true,
    );
    assert.equal(
      micEnableTook({ pushToTalk: false, live: false, captured }),
      false,
    );
  }
});

const OPEN = {
  held: true,
  whispering: false,
  micLive: false,
  userMuted: false,
};

test("pttPressOpens: a press opens the mic while the key is still down", () => {
  assert.equal(pttPressOpens(OPEN), true);
});

test("pttPressOpens: a key released while the publish landed opens nothing", () => {
  // A tap during the join: the release came before the muted publish landed.
  assert.equal(pttPressOpens({ ...OPEN, held: false }), false);
});

test("pttPressOpens: a whisper or an already-live mic is left alone", () => {
  assert.equal(pttPressOpens({ ...OPEN, whispering: true }), false);
  assert.equal(pttPressOpens({ ...OPEN, micLive: true }), false);
});

test("pttPressOpens: Muted or Deafened, the talk key opens nothing", () => {
  // It used to: a Muted user went on the wire while the button read Muted.
  assert.equal(pttPressOpens({ ...OPEN, userMuted: true }), false);
});

test("pttPressOpens: nothing but a held key over a shut, unmuted mic opens it", () => {
  for (const held of BOOLS)
    for (const whispering of BOOLS)
      for (const micLive of BOOLS)
        for (const userMuted of BOOLS)
          assert.equal(
            pttPressOpens({ held, whispering, micLive, userMuted }),
            held && !whispering && !micLive && !userMuted,
          );
});

const STAYS = {
  pushToTalk: true,
  held: true,
  whispering: false,
  userMuted: false,
};

test("pttLiveStays: a release, Mute or whisper during the landing mutes it", () => {
  // livekit's disable gives up on a capture still at a permission prompt, so
  // each of these could land the mic live with no key held.
  assert.equal(pttLiveStays({ ...STAYS, held: false }), false);
  assert.equal(pttLiveStays({ ...STAYS, userMuted: true }), false);
  assert.equal(pttLiveStays({ ...STAYS, whispering: true }), false);
});

test("pttLiveStays: a key still held keeps it, and outside push to talk it is left alone", () => {
  assert.equal(pttLiveStays(STAYS), true);
  for (const held of BOOLS)
    for (const whispering of BOOLS)
      for (const userMuted of BOOLS)
        assert.equal(
          pttLiveStays({ pushToTalk: false, held, whispering, userMuted }),
          true,
        );
});

test("pttLiveStays: under push to talk only a held key over no mute or whisper stays", () => {
  for (const held of BOOLS)
    for (const whispering of BOOLS)
      for (const userMuted of BOOLS)
        assert.equal(
          pttLiveStays({ pushToTalk: true, held, whispering, userMuted }),
          held && !whispering && !userMuted,
        );
});

test("pttBlurMutes: a blur mid-hold the native hook did not deliver mutes", () => {
  // Web, Electron, and a Tauri hold begun while Sloga had focus (the hook is
  // blind then): the release goes to another app and never arrives.
  assert.equal(
    pttBlurMutes({ pushToTalk: true, held: true, nativeSawHold: false }),
    true,
  );
  // A hold the hook delivered gets its `ptt:up` from the hook.
  assert.equal(
    pttBlurMutes({ pushToTalk: true, held: true, nativeSawHold: true }),
    false,
  );
});

test("pttBlurMutes: only push to talk, a hold and no native delivery together mute", () => {
  for (const pushToTalk of BOOLS)
    for (const held of BOOLS)
      for (const nativeSawHold of BOOLS)
        assert.equal(
          pttBlurMutes({ pushToTalk, held, nativeSawHold }),
          pushToTalk && held && !nativeSawHold,
        );
});

test("mutedWhileLanding: a Mute or Deafen pressed while it landed counts", () => {
  // The join: micOn was true, the user pressed Mute during the landing.
  assert.equal(
    mutedWhileLanding(
      { micOn: true, deafen: false },
      { micOn: false, deafen: false },
    ),
    true,
  );
  // An Unmute, then Deafen during the landing.
  assert.equal(
    mutedWhileLanding(
      { micOn: false, deafen: false },
      { micOn: false, deafen: true },
    ),
    true,
  );
});

test("mutedWhileLanding: the caller's own unwritten state is not a mute", () => {
  // Unmute still reads micOn false, Undeafen still reads deafen true: both
  // write theirs after the turn-on returns.
  for (const micOn of BOOLS)
    for (const deafen of BOOLS)
      assert.equal(
        mutedWhileLanding({ micOn, deafen }, { micOn, deafen }),
        false,
      );
});

test("mutedWhileLanding: only micOn going off or deafen going on counts", () => {
  for (const a of BOOLS)
    for (const b of BOOLS)
      for (const c of BOOLS)
        for (const d of BOOLS)
          assert.equal(
            mutedWhileLanding({ micOn: a, deafen: b }, { micOn: c, deafen: d }),
            (a && !c) || (!b && d),
          );
});

// --- captureWithin ------------------------------------------------------------

/** Lets settled promises run their handlers (setImmediate is not mocked). */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * A capture the test lands or fails by hand, and the `expired` it was
 * handed.
 */
function pending<T>() {
  let land!: (tracks: T[]) => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<T[]>((resolve, reject) => {
    land = resolve;
    fail = reject;
  });
  let handed: (() => boolean) | undefined;
  const capture = (expired: () => boolean) => {
    handed = expired;
    return promise;
  };
  const expired = () => {
    assert.ok(handed, "captureWithin never started the capture");
    return handed();
  };
  return { capture, land, fail, expired };
}

test("captureWithin: the bound is livekit's 10 s", () => {
  assert.equal(MUTED_CAPTURE_TIMEOUT_MS, 10_000);
});

/**
 * How `promise` has settled so far, read without awaiting it: a mutant that
 * never settles must fail its assertion, not hang the run.
 */
function watch<T>(promise: Promise<T>) {
  const seen: { state: "pending" | "resolved" | "rejected"; value?: unknown } =
    { state: "pending" };
  promise.then(
    (value) => Object.assign(seen, { state: "resolved", value }),
    (value) => Object.assign(seen, { state: "rejected", value }),
  );
  return seen;
}

test("captureWithin: a capture inside the bound is handed over, and nothing is stopped", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stopped: string[] = [];
  const { capture, land } = pending<string>();
  const result = watch(captureWithin(capture, 100, (x) => stopped.push(x)));
  t.mock.timers.tick(99);
  land(["mic"]);
  await flush();
  assert.deepEqual(result, { state: "resolved", value: ["mic"] });
  t.mock.timers.tick(100);
  await flush();
  assert.deepEqual(stopped, []);
});

test("captureWithin: a capture still waiting at the bound is given up on", async (t) => {
  // A permission prompt left open held every Mute, Deafen and talk-key write.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { capture } = pending<string>();
  const result = watch(captureWithin(capture, 100, () => {}));
  t.mock.timers.tick(99);
  await flush();
  assert.equal(result.state, "pending", "given up on before the bound");
  t.mock.timers.tick(1);
  await flush();
  assert.equal(result.state, "rejected", "still waiting at the bound");
  assert.ok(isMicCaptureTimeout(result.value));
});

test("captureWithin: a capture that lands after the bound is stopped, never handed over", async (t) => {
  // Published, it would be a second mic track, or a live one.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stopped: string[] = [];
  const { capture, land } = pending<string>();
  const result = watch(captureWithin(capture, 100, (x) => stopped.push(x)));
  t.mock.timers.tick(100);
  land(["mic", "second"]);
  await flush();
  assert.equal(result.state, "rejected", "the late capture was handed over");
  assert.ok(isMicCaptureTimeout(result.value));
  assert.deepEqual(stopped, ["mic", "second"]);
});

test("captureWithin: a failure inside the bound is passed on, and one after it is swallowed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const denied = Object.assign(new Error("denied"), {
    name: "NotAllowedError",
  });
  const early = pending<string>();
  const first = watch(captureWithin(early.capture, 100, () => {}));
  early.fail(denied);
  await flush();
  assert.deepEqual(first, { state: "rejected", value: denied });

  const late = pending<string>();
  const second = watch(captureWithin(late.capture, 100, () => {}));
  t.mock.timers.tick(100);
  late.fail(denied);
  await flush();
  assert.equal(second.state, "rejected");
  assert.ok(isMicCaptureTimeout(second.value), "the late failure won");
  assert.equal(isMicCaptureTimeout(denied), false);
});

test("captureWithin: the capture is told once it has been given up on", (t) => {
  // So a late failure skips the un-pin and the retry: the pin is shared, and
  // the user may have rejoined since.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { capture, expired } = pending<string>();
  watch(captureWithin(capture, 100, () => {}));
  t.mock.timers.tick(99);
  assert.equal(expired(), false, "expired inside the bound");
  t.mock.timers.tick(1);
  assert.equal(expired(), true, "not expired at the bound");
});

// --- state.tsx wiring ---------------------------------------------------------
//
// `node --test` cannot load state.tsx, so these hold it to calling the policy.
// Matched as code text with comments stripped (`sourcePins.harness.ts`).

const STATE_CODE = codeOf(
  readFileSync(new URL("./state.tsx", import.meta.url), "utf8"),
);
const assertWired = wiredAsserter("state.tsx", STATE_CODE);

/** The body of the ONE method `head` opens. */
function bodyOf(head: string): string {
  const bodies = bodiesAfter(STATE_CODE, head);
  assert.equal(bodies.length, 1, `state.tsx must contain ${head} once`);
  return bodies[0];
}

test("state.tsx: the join turns the mic on through #enableMic", () => {
  assertWired(
    "the join's turn-on",
    "(wantMic ? this.#enableMic(room) : this.#setMicEnabled(room, false).then(() => false))",
  );
  assertWired(
    "the join reconciles micOn to what took",
    "if (wantMic) this.#settings.micOn = took;",
  );
});

test("state.tsx: #enableMic asks the policy, from the setting and the hold", () => {
  // The wait comes FIRST: a live mode chosen before it, with the key released
  // during it, unmuted with no key down.
  assertWired(
    "the snapshot, the wait and the mode",
    "const before = { micOn: this.#settings.micOn, deafen: this.#settings.deafen, }; await this.#mutedMicLanded(room); const mode = micEnableMode({ pushToTalk: this.#settings.pushToTalk, pttHeld: this.#pttHeld, });",
  );
  assertWired(
    "the muted path, with a capture given up on read as not taken",
    'if (mode === "muted") { try { await this.#publishMicMuted(room); } catch (error) { if (!isMicCaptureTimeout(error)) throw error; return false; } }',
  );
  assertWired(
    "the live path, re-checked for a Mute or Deafen made while it landed",
    "else { await this.#setMicEnabled(room, true); const mutedMeanwhile = mutedWhileLanding(before, { micOn: this.#settings.micOn, deafen: this.#settings.deafen, }); await this.#keepPttMicLiveOnlyIfWanted(room, mutedMeanwhile); if (mutedMeanwhile && this.#settings.pushToTalk) return false; }",
  );
  assertWired(
    "the reconcile",
    "return micEnableTook({ pushToTalk: this.#settings.pushToTalk, live: room.localParticipant.isMicrophoneEnabled, captured: !!room.localParticipant.getTrackPublication( Track.Source.Microphone, )?.track, });",
  );
});

test("state.tsx: a failed or hung-up muted capture stops what it captured", () => {
  // Without the stop the mic stays captured (the indicator stays on).
  const body = bodyOf("async #captureMutedMic(room: Room) {");
  assert.equal(
    countWired(body, 'if (this.room() !== room) throw "invalid state";'),
    1,
    "the hang-up check before the publish",
  );
  assert.equal(
    countWired(
      body,
      "} catch (error) { for (const track of tracks) track.stop(); throw error;",
    ),
    1,
    "the stop on failure",
  );
});

test("state.tsx: a settled muted publish clears its record", () => {
  // Left set, every `#mutedMicLanded` loop spins forever on a settled promise.
  assertWired(
    "the clear",
    "return done.finally(() => { if (this.#micMutedPublish === entry) this.#micMutedPublish = undefined; });",
  );
  assert.equal(
    bodyOf("async #mutedMicLanded(room: Room) {"),
    codeOf(
      "for (let p = this.#micMutedLanding(room); p; p = this.#micMutedLanding(room)) await p",
    ),
  );
});

test("state.tsx: the muted publish mutes the track BEFORE it publishes it", () => {
  // Muted after publishing, the first RTP packets leave live.
  const body = bodyOf("async #captureMutedMic(room: Room) {");
  const mute = wiredAt(body, "await track.mute();");
  const publish = wiredAt(body, "await lp.publishTrack(track);");
  assert.equal(mute.length, 1, "the mute");
  assert.equal(publish.length, 1, "the publish");
  assert.ok(
    mute[0] < publish[0],
    "the track must be muted before it is published",
  );
});

test("state.tsx: the muted publish reuses a mic that exists, and is recorded", () => {
  assertWired(
    "an existing or livekit-pending mic is muted, not captured again",
    "await before; const existing = await room.localParticipant.setMicrophoneEnabled(false); if (existing?.track) return; await this.#captureMutedMic(room);",
  );
  assertWired("the in-flight record", "this.#micMutedPublish = entry;");
});

test("state.tsx: every enable waits behind a muted publish in flight", () => {
  // Alongside it, livekit would capture and publish a second mic track.
  const body = bodyOf("async #setMicEnabled(room: Room, enabled: boolean) {");
  assert.ok(
    body.startsWith(
      codeOf(
        "await this.#mutedMicLanded(room); try { return await room.localParticipant.setMicrophoneEnabled(enabled)",
      ),
    ),
    "#setMicEnabled must wait before it calls livekit",
  );
});

test("state.tsx: Unmute, Undeafen and the whisper restore use #enableMic", () => {
  for (const head of [
    "async toggleMute() {",
    "async toggleDeafen(fromMute?: boolean) {",
    "async #restoreWhisperMic(room: Room) {",
  ]) {
    const body = bodyOf(head);
    assert.equal(
      countWired(body, "this.#enableMic(room)"),
      1,
      `${head} must turn the mic on through #enableMic`,
    );
    for (const live of [
      "this.#setMicEnabled(room, true)",
      "this.#setMicEnabled(room, want)",
      "this.#setMicEnabled(room, wantMic)",
    ])
      assert.equal(countWired(body, live), 0, `${head} still calls ${live}`);
  }
  assertWired(
    "Unmute reconciles micOn to what took",
    "if (want) took = await this.#enableMic(room); else await this.#setMicEnabled(room, false);",
  );
  assertWired(
    "Undeafen reconciles micOn to what took",
    "if (wantMic) took = await this.#enableMic(room); else await this.#setMicEnabled(room, false);",
  );
});

test("state.tsx: both talk-key presses open through #pttOpen", () => {
  assert.equal(
    countWired(STATE_CODE, "void this.#pttOpen(room);"),
    2,
    "the focused keydown and the native ptt:down",
  );
  for (const head of [
    "#startPushToTalk(room: Room) {",
    "async #ensureNativePtt(room: Room) {",
  ])
    assert.equal(
      countWired(bodyOf(head), "this.#setMicEnabled(room, true)"),
      0,
      `${head} opens the mic around #pttOpen`,
    );
});

test("state.tsx: #pttOpen waits for the landing, asks the policy, then re-checks", () => {
  // The user's mute is read from the settings at both points: Muted or
  // Deafened, the press opens nothing, and a Mute made while it landed mutes
  // it again.
  assert.equal(
    bodyOf("async #pttOpen(room: Room) {"),
    codeOf(
      "await this.#mutedMicLanded(room); if ( !pttPressOpens({ held: this.#pttHeld, whispering: !!this.whisper.target(), micLive: room.localParticipant.isMicrophoneEnabled, userMuted: !this.#settings.micOn || this.#settings.deafen, }) ) return; await this.#setMicEnabled(room, true).catch(() => {}); await this.#keepPttMicLiveOnlyIfWanted( room, !this.#settings.micOn || this.#settings.deafen, ).catch(() => {})",
    ),
  );
});

test("state.tsx: a landed live open is muted unless the policy keeps it", () => {
  assert.equal(
    bodyOf(
      "async #keepPttMicLiveOnlyIfWanted(room: Room, userMuted: boolean) {",
    ),
    codeOf(
      "if ( pttLiveStays({ pushToTalk: this.#settings.pushToTalk, held: this.#pttHeld, whispering: !!this.whisper.target(), userMuted, }) ) return; await this.#setMicEnabled(room, false)",
    ),
  );
});

test("state.tsx: the muted capture is bounded, and a late one is stopped", () => {
  const body = bodyOf("async #captureMutedMic(room: Room) {");
  assert.equal(
    countWired(
      body,
      "const tracks = await captureWithin( async (expired) => { try { return await lp.createTracks({ audio: true }); } catch (error) { if (expired() || !this.#unpinMicAfterFailure(room)) throw error; return lp.createTracks({ audio: true }); } }, MUTED_CAPTURE_TIMEOUT_MS, (track) => track.stop(), );",
    ),
    1,
    "both capture attempts inside captureWithin, the retry skipped once expired, with the bound and the stop",
  );
  assert.equal(
    countWired(body, "await lp.createTracks"),
    1,
    "a capture outside the bound",
  );
});

test("state.tsx: a capture given up on is not reported as blocked access", () => {
  // The prompt is still on screen: "blocked, change your settings" would be
  // wrong. `#enableMic` reads it as not taken instead (pinned above), and
  // nothing else looks at it.
  assert.equal(countWired(STATE_CODE, "isMicCaptureTimeout("), 1);
  assert.equal(countWired(STATE_CODE, "isPermissionDeniedError(error) ||"), 0);
});

test("state.tsx: the native hold flag is set by ptt:down alone, and every hold end clears it", () => {
  const native = bodyOf("async #ensureNativePtt(room: Room) {");
  assert.equal(
    countWired(
      native,
      "this.#pttHeld = true; this.#noteIdleActivity(); this.#pttNativeHeld = true;",
    ),
    1,
    "ptt:down records a hold the hook delivered",
  );
  assert.equal(
    countWired(native, "this.#pttHeld = false; this.#pttNativeHeld = false;"),
    1,
    "ptt:up clears it",
  );
  assert.equal(countWired(STATE_CODE, "this.#pttNativeHeld = true;"), 1);
  const focused = bodyOf("#startPushToTalk(room: Room) {");
  assert.equal(
    countWired(focused, "this.#pttHeld = true; this.#pttNativeHeld = false;"),
    1,
    "a focused press is a hold the hook never saw",
  );
  assert.equal(
    countWired(
      focused,
      "if (e.code === this.#settings.pushToTalkKey) { this.#pttHeld = false; this.#pttNativeHeld = false; }",
    ),
    1,
    "a focused release ends the hold",
  );
  assert.equal(
    countWired(
      bodyOf("async #disarmNativePtt() {"),
      "this.#pttHeld = false; this.#pttNativeHeld = false;",
    ),
    1,
    "a disarm sends no ptt:up",
  );
});

test("state.tsx: every blur goes through #pttBlur, which mutes as the policy says", () => {
  assertWired(
    "main's blur",
    'window.addEventListener("blur", () => this.#pttBlur());',
  );
  assertWired(
    "each chat window's blur",
    "const onBlur = () => this.#pttBlur();",
  );
  assert.equal(
    bodyOf("#pttBlur() {"),
    codeOf(
      "const held = this.#pttHeld; this.#pttHeld = false; const room = this.room(); if ( !room || !pttBlurMutes({ pushToTalk: this.#settings.pushToTalk, held, nativeSawHold: this.#pttNativeHeld, }) ) return; void this.#setMicEnabled(room, false).catch(() => {})",
    ),
  );
});

test("state.tsx: both talk-key releases mute whatever the mic reads", () => {
  // Guarded on `isMicrophoneEnabled`, a release during a press's publish was
  // skipped and the mic landed live. Through `#setMicEnabled`, so a release
  // queues behind an enable already waiting on a muted publish.
  assertWired(
    "the focused keyup",
    "if (e.code !== this.#settings.pushToTalkKey) return; void this.#setMicEnabled(room, false).catch(() => {});",
  );
  assertWired(
    "the native ptt:up",
    "if (!this.#settings.pushToTalk) return; void this.#setMicEnabled(room, false).catch(() => {});",
  );
  assert.equal(
    countWired(
      STATE_CODE,
      "if (!room.localParticipant.isMicrophoneEnabled) return; room.localParticipant.setMicrophoneEnabled(false);",
    ),
    0,
    "a guarded release mute is back",
  );
});
