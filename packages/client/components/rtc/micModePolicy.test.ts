// Unit spec for switching the microphone mode mid-call — run with Node's
// built-in runner, from packages/client:
//   node --test --conditions=browser components/rtc/micModePolicy.test.ts
// Focus: push to talk -> voice activity must not leave the microphone muted
// for the rest of the call, open mic -> voice activity must not leave it hot,
// and state.tsx must actually run the plan when the mode changes.
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

test("micModeOf: push to talk outranks voice activity, as clean() does", () => {
  assert.equal(micModeOf({ vadEnabled: false, pushToTalk: false }), "openMic");
  assert.equal(micModeOf({ vadEnabled: true, pushToTalk: false }), "vad");
  assert.equal(micModeOf({ vadEnabled: false, pushToTalk: true }), "pushToTalk");
  assert.equal(micModeOf({ vadEnabled: true, pushToTalk: true }), "pushToTalk");
});

test("voice activity starts the gate and leaves the mic for it to drive", () => {
  // The reported bug: coming from push to talk the mic is muted, and nothing
  // started the gate that would open it.
  assert.deepEqual(micModeSwitchPlan(inputs({ next: "vad" })), {
    vad: "start",
    nativePtt: "disarm",
    mic: "keep",
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
  });
});

test("push to talk leaves a held mic for the release to close", () => {
  const plan = micModeSwitchPlan(
    inputs({ next: "pushToTalk", pttHeld: true }),
  );
  assert.equal(plan.mic, "keep");
  assert.equal(plan.nativePtt, "arm");
});

test("open mic turns the mic on when the user wants it on", () => {
  // Coming from push to talk or a closed voice-activity gate, the mic is off.
  assert.deepEqual(micModeSwitchPlan(inputs({ next: "openMic" })), {
    vad: "stop",
    nativePtt: "disarm",
    mic: "on",
  });
});

test("open mic mutes when the user does not want the mic on", () => {
  const plan = micModeSwitchPlan(inputs({ next: "openMic", intentOn: false }));
  assert.equal(plan.mic, "off");
  assert.equal(plan.vad, "stop");
});

test("open mic never unmutes the room mic under a whisper", () => {
  const plan = micModeSwitchPlan(
    inputs({ next: "openMic", whispering: true }),
  );
  assert.equal(plan.mic, "keep");
});

test("open mic never enables a refused publish (AFK, no Speak)", () => {
  const plan = micModeSwitchPlan(
    inputs({ next: "openMic", publishRefused: true }),
  );
  assert.equal(plan.mic, "keep");
});

test("no mode ever turns the mic on except open mic", () => {
  for (const next of ["vad", "pushToTalk", "openMic"] as const) {
    for (const intentOn of [true, false]) {
      for (const whispering of [true, false]) {
        for (const publishRefused of [true, false]) {
          for (const pttHeld of [true, false]) {
            const plan = micModeSwitchPlan({
              next,
              intentOn,
              whispering,
              publishRefused,
              pttHeld,
            });
            if (plan.mic !== "on") continue;
            assert.equal(next, "openMic");
            assert.equal(intentOn, true);
            assert.equal(whispering, false);
            assert.equal(publishRefused, false);
          }
        }
      }
    }
  }
});

test("only voice activity runs the gate, only push to talk arms the hook", () => {
  for (const next of ["vad", "pushToTalk", "openMic"] as const) {
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
    "the mode is read from the settings",
    "const mode = micModeOf({ vadEnabled: this.#settings.vadEnabled, pushToTalk: this.#settings.pushToTalk, });",
  );
  assertWired(
    "a change is applied",
    "if (previous === undefined || previous === mode) return; untrack(() => this.#applyMicMode(mode));",
  );
});

test("state.tsx applies the plan only to a connected call", () => {
  assertWired(
    "the connected-call guard",
    '#applyMicMode(mode: MicMode) { const room = this.room(); if (!room || this.state() !== "CONNECTED") return; const plan = micModeSwitchPlan({',
  );
  assertWired(
    "the gate follows the plan",
    'if (plan.vad === "start") void this.#startVAD(room); else this.#stopVAD();',
  );
  assertWired(
    "the native hook follows the plan",
    'if (plan.nativePtt === "arm") void this.#ensureNativePtt(room); else void this.#disarmNativePtt();',
  );
});
