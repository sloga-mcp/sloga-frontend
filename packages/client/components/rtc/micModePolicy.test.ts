// Unit spec for switching the microphone mode mid-call — run with Node's
// built-in runner, from packages/client:
//   node --test --conditions=browser components/rtc/micModePolicy.test.ts
// Focus: push to talk -> voice activity must not leave the microphone muted
// for the rest of the call, open mic -> voice activity must not leave it hot,
// a switch made mid-whisper must survive the whisper's restore, and state.tsx
// must actually run the plan when the mode changes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  type MicModeSwitchInputs,
  micModeOf,
  micModeSwitchPlan,
} from "./micModePolicy.ts";
import { codeOf, wiredAsserter } from "./sourcePins.harness.ts";

/** A plain switch: the user wants the mic on, nothing suppresses it. */
function inputs(over: Partial<MicModeSwitchInputs> = {}): MicModeSwitchInputs {
  return {
    next: "vad",
    intentOn: true,
    whispering: false,
    publishRefused: false,
    pttHeld: false,
    ...over,
  };
}

const MODES = ["vad", "pushToTalk", "openMic"] as const;

/** Every combination of the boolean inputs, for each mode. */
function* everyInput(): Generator<MicModeSwitchInputs> {
  for (const next of MODES) {
    for (const intentOn of [true, false]) {
      for (const whispering of [true, false]) {
        for (const publishRefused of [true, false]) {
          for (const pttHeld of [true, false]) {
            yield { next, intentOn, whispering, publishRefused, pttHeld };
          }
        }
      }
    }
  }
}

test("micModeOf: push to talk outranks voice activity, as clean() does", () => {
  assert.equal(micModeOf({ vadEnabled: false, pushToTalk: false }), "openMic");
  assert.equal(micModeOf({ vadEnabled: true, pushToTalk: false }), "vad");
  assert.equal(
    micModeOf({ vadEnabled: false, pushToTalk: true }),
    "pushToTalk",
  );
  assert.equal(micModeOf({ vadEnabled: true, pushToTalk: true }), "pushToTalk");
});

test("voice activity starts the gate and leaves the mic for it to drive", () => {
  // The reported bug: coming from push to talk the mic is muted, and nothing
  // started the gate that would open it.
  assert.deepEqual(micModeSwitchPlan(inputs({ next: "vad" })), {
    vad: "start",
    nativePtt: "disarm",
    mic: "keep",
    afterWhisper: undefined,
  });
});

test("voice activity keeps the mic even when the user has muted", () => {
  // The gate already defers to the user's mute; the switch must not unmute.
  const plan = micModeSwitchPlan(inputs({ next: "vad", intentOn: false }));
  assert.equal(plan.vad, "start");
  assert.equal(plan.mic, "keep");
});

test("push to talk stops the gate and mutes when no key is held", () => {
  assert.deepEqual(micModeSwitchPlan(inputs({ next: "pushToTalk" })), {
    vad: "stop",
    nativePtt: "arm",
    mic: "off",
    afterWhisper: false,
  });
});

test("push to talk leaves a held mic for the release to close", () => {
  const plan = micModeSwitchPlan(inputs({ next: "pushToTalk", pttHeld: true }));
  assert.equal(plan.mic, "keep");
  assert.equal(plan.nativePtt, "arm");
});

test("open mic turns the mic on when the user wants it on", () => {
  // Coming from push to talk or a closed voice-activity gate, the mic is off.
  assert.deepEqual(micModeSwitchPlan(inputs({ next: "openMic" })), {
    vad: "stop",
    nativePtt: "disarm",
    mic: "on",
    afterWhisper: true,
  });
});

test("open mic mutes when the user does not want the mic on", () => {
  const plan = micModeSwitchPlan(inputs({ next: "openMic", intentOn: false }));
  assert.equal(plan.mic, "off");
  assert.equal(plan.vad, "stop");
  assert.equal(plan.afterWhisper, false);
});

test("open mic never unmutes the room mic under a whisper", () => {
  const plan = micModeSwitchPlan(inputs({ next: "openMic", whispering: true }));
  assert.equal(plan.mic, "keep");
});

test("open mic never enables a refused publish (AFK, no Speak)", () => {
  const plan = micModeSwitchPlan(
    inputs({ next: "openMic", publishRefused: true }),
  );
  assert.equal(plan.mic, "keep");
  assert.equal(plan.afterWhisper, false);
});

test("a whisper ending after a switch to push to talk leaves the mic shut", () => {
  // Open Mic, whisper, switch to push to talk, stop the whisper: the restore
  // used to turn the room mic back on with no key held.
  const plan = micModeSwitchPlan(
    inputs({ next: "pushToTalk", whispering: true }),
  );
  assert.equal(plan.afterWhisper, false);
});

test("a whisper ending after a switch to open mic turns the mic back on", () => {
  // Push to talk, whisper, switch to Open Mic, stop the whisper: the restore
  // used to leave the mic off while the button read live.
  const plan = micModeSwitchPlan(inputs({ next: "openMic", whispering: true }));
  assert.equal(plan.afterWhisper, true);
});

test("a switch to voice activity keeps the whisper's own restore", () => {
  const plan = micModeSwitchPlan(inputs({ next: "vad", whispering: true }));
  assert.equal(plan.afterWhisper, undefined);
});

test("no mode ever turns the mic on except open mic", () => {
  for (const input of everyInput()) {
    const plan = micModeSwitchPlan(input);
    if (plan.mic !== "on") continue;
    assert.equal(input.next, "openMic");
    assert.equal(input.intentOn, true);
    assert.equal(input.whispering, false);
    assert.equal(input.publishRefused, false);
  }
});

test("no whisper ever ends into a mic the user or the server refused", () => {
  for (const input of everyInput()) {
    if (micModeSwitchPlan(input).afterWhisper !== true) continue;
    assert.equal(input.next, "openMic");
    assert.equal(input.intentOn, true);
    assert.equal(input.publishRefused, false);
  }
});

test("only voice activity runs the gate, only push to talk arms the hook", () => {
  for (const next of MODES) {
    const plan = micModeSwitchPlan(inputs({ next }));
    assert.equal(plan.vad === "start", next === "vad");
    assert.equal(plan.nativePtt === "arm", next === "pushToTalk");
  }
});

// --- state.tsx wiring ---------------------------------------------------------
//
// `node --test` cannot load state.tsx, so these hold it to calling the policy.
// Matched as code text with comments stripped (`sourcePins.harness.ts`).

const STATE_CODE = codeOf(
  readFileSync(new URL("./state.tsx", import.meta.url), "utf8"),
);
const assertWired = wiredAsserter("state.tsx", STATE_CODE);

test("state.tsx re-applies the mode on every change, from the settings", () => {
  assertWired(
    "the mode is read from the settings and remembered",
    "const mode = micModeOf({ vadEnabled: this.#settings.vadEnabled, pushToTalk: this.#settings.pushToTalk, }); const previous = lastMicMode; lastMicMode = mode;",
  );
  assertWired(
    "a change is applied",
    "if (previous === undefined || previous === mode) return; untrack(() => this.#applyMicMode(mode));",
  );
});

test("state.tsx feeds the plan the user's intent and the call's state", () => {
  assertWired(
    "the connected-call guard",
    '#applyMicMode(mode: MicMode) { const room = this.room(); if (!room || this.state() !== "CONNECTED") return; const whispering = !!this.whisper.target(); const plan = micModeSwitchPlan({',
  );
  assertWired(
    "the plan's inputs",
    "next: mode, intentOn: this.#settings.micOn && !this.#settings.deafen, whispering, publishRefused: !!publishToggleRefusal({ enabling: true, isAfkChannel: this.isAfkChannel, permitted: this.speakingPermission, }), pttHeld: this.#pttHeld,",
  );
});

test("state.tsx carries out every part of the plan", () => {
  assertWired(
    "the gate follows the plan",
    'if (plan.vad === "start") void this.#startVAD(room); else this.#stopVAD();',
  );
  assertWired(
    "the native hook follows the plan",
    'if (plan.nativePtt === "arm") void this.#ensureNativePtt(room); else void this.#disarmNativePtt();',
  );
  assertWired(
    "the whisper restores what the switch chose",
    "if (whispering && plan.afterWhisper !== undefined) this.#whisperPriorMic = plan.afterWhisper;",
  );
  assertWired(
    "the mic follows the plan, the mute unconditionally and behind a muted publish",
    'if (plan.mic === "on") { void this.#setMicEnabled(room, true).catch(() => {}); } else if (plan.mic === "off") { void this.#setMicEnabled(room, false).catch(() => {}); }',
  );
});
