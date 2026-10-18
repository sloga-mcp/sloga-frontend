// Unit spec for push to talk's "muted unless the key is held" on every path
// that turns the microphone on — run with Node's built-in runner, from
// packages/client:
//   node --test --conditions=browser components/rtc/pttMicPolicy.test.ts
// Focus: joining, Unmute, Undeafen and a whisper's restore under push to talk
// must not publish a live microphone, a press made while that muted publish
// is landing must not open the mic after its release, and state.tsx must
// actually route those paths through the policy.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { micEnableMode, micEnableTook, pttPressOpens } from "./pttMicPolicy.ts";
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

test("micEnableTook: a muted turn-on worked when the mic was captured", () => {
  // Reading `isMicrophoneEnabled` here wrote micOn = false on every push to
  // talk Unmute.
  assert.equal(
    micEnableTook({ mode: "muted", live: false, captured: true }),
    true,
  );
  assert.equal(
    micEnableTook({ mode: "muted", live: false, captured: false }),
    false,
  );
});

test("micEnableTook: a live turn-on worked only when the mic is live", () => {
  // A capture that failed must not read as live.
  for (const captured of BOOLS) {
    assert.equal(micEnableTook({ mode: "live", live: true, captured }), true);
    assert.equal(micEnableTook({ mode: "live", live: false, captured }), false);
  }
});

test("pttPressOpens: a press opens the mic while the key is still down", () => {
  assert.equal(
    pttPressOpens({ held: true, whispering: false, micLive: false }),
    true,
  );
});

test("pttPressOpens: a key released while the publish landed opens nothing", () => {
  // A tap during the join: the release came before the muted publish landed.
  assert.equal(
    pttPressOpens({ held: false, whispering: false, micLive: false }),
    false,
  );
});

test("pttPressOpens: a whisper or an already-live mic is left alone", () => {
  assert.equal(
    pttPressOpens({ held: true, whispering: true, micLive: false }),
    false,
  );
  assert.equal(
    pttPressOpens({ held: true, whispering: false, micLive: true }),
    false,
  );
});

test("pttPressOpens: nothing but a held key over a shut mic opens it", () => {
  for (const held of BOOLS)
    for (const whispering of BOOLS)
      for (const micLive of BOOLS)
        assert.equal(
          pttPressOpens({ held, whispering, micLive }),
          held && !whispering && !micLive,
        );
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
  assertWired(
    "the mode and its two paths",
    'const mode = micEnableMode({ pushToTalk: this.#settings.pushToTalk, pttHeld: this.#pttHeld, }); if (mode === "muted") await this.#publishMicMuted(room); else await this.#setMicEnabled(room, true);',
  );
  assertWired(
    "the reconcile",
    "return micEnableTook({ mode, live: room.localParticipant.isMicrophoneEnabled, captured: !!room.localParticipant.getTrackPublication( Track.Source.Microphone, )?.track, });",
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
        "for (let p = this.#micMutedLanding(room); p; p = this.#micMutedLanding(room)) await p; try { return await room.localParticipant.setMicrophoneEnabled(enabled)",
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

test("state.tsx: #pttOpen waits for the landing, then asks the policy", () => {
  assert.equal(
    bodyOf("async #pttOpen(room: Room) {"),
    codeOf(
      "for (let p = this.#micMutedLanding(room); p; p = this.#micMutedLanding(room)) await p; if ( !pttPressOpens({ held: this.#pttHeld, whispering: !!this.whisper.target(), micLive: room.localParticipant.isMicrophoneEnabled, }) ) return; await this.#setMicEnabled(room, true).catch(() => {})",
    ),
  );
});

test("state.tsx: both talk-key releases mute whatever the mic reads", () => {
  // Guarded on `isMicrophoneEnabled`, a release during a press's publish was
  // skipped and the mic landed live.
  assertWired(
    "the focused keyup",
    "if (e.code !== this.#settings.pushToTalkKey) return; void room.localParticipant.setMicrophoneEnabled(false).catch(() => {});",
  );
  assertWired(
    "the native ptt:up",
    "if (!this.#settings.pushToTalk) return; void room.localParticipant.setMicrophoneEnabled(false).catch(() => {});",
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
