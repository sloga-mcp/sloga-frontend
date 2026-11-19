// Unit spec for the camera tone policy (low light, touch up, watchdog).
//   node --test --conditions=browser components/rtc/cameraTonePolicy.test.ts
// Focus: the low-light meter never flaps between its two thresholds, never
// reacts to one dark frame, never exceeds the gain cap and never steps the
// gain; the watchdog sheds one stage per full window in cost order and never
// re-arms it; a hidden page and a lost WebGL context degrade to raw video
// instead of stalling; a context lost on a hidden page costs nothing and a
// steady run of draws earns the one rebuild back; a stage that draws black
// from a lit frame is called blind. These rules live in a dependency-free module
// precisely so they are reachable by `node --test`; the WebGL stage and the
// wiring in `cameraEffects.ts` are live-only.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ContextLossAction,
  type ToneConfig,
  type TonePageMode,
  type ToneStageName,
  type ToneWants,
  CONTEXT_LOSS_REARM_MAX_GAP_MS,
  CONTEXT_LOSS_REARM_MS,
  ContextLossLadder,
  LOW_LIGHT_ENGAGE_LUMA,
  LOW_LIGHT_MAX_GAIN,
  LOW_LIGHT_MAX_STEP_MS,
  LOW_LIGHT_RELEASE_LUMA,
  LOW_LIGHT_SAMPLE_EVERY_FRAMES,
  LOW_LIGHT_SMOOTHING_MS,
  LOW_LIGHT_TARGET_LUMA,
  LowLightMeter,
  NEUTRAL_TONE,
  TONE_BLIND_SOURCE_FLOOR,
  TONE_SHED_ORDER,
  TONE_TIMER_STALL_MS,
  TOUCH_UP_PLAIN_MAX,
  TOUCH_UP_SWITCH_STRENGTH,
  ToneWatchdog,
  meanLuma,
  plainTouchUpStrength,
  toneAllowedOnPlatform,
  toneIsNeutral,
  tonePageMode,
  toneStageBlind,
  toneTimerHolds,
  toneTurnedOn,
} from "./cameraTonePolicy.ts";

const EPS = 1e-9;

const close = (actual: number, expected: number, message?: string) =>
  assert.ok(
    Math.abs(actual - expected) <= EPS,
    `${message ?? "value"}: expected ${expected}, got ${actual}`,
  );

// ---- Constants -------------------------------------------------------------

test("the contract constants", () => {
  assert.equal(LOW_LIGHT_SAMPLE_EVERY_FRAMES, 12);
  assert.equal(LOW_LIGHT_MAX_GAIN, 2);
  assert.equal(LOW_LIGHT_ENGAGE_LUMA, 0.3);
  assert.equal(LOW_LIGHT_RELEASE_LUMA, 0.4);
  assert.equal(LOW_LIGHT_TARGET_LUMA, 0.45);
  assert.equal(LOW_LIGHT_SMOOTHING_MS, 1000);
  assert.equal(LOW_LIGHT_MAX_STEP_MS, 500);
  assert.equal(TONE_TIMER_STALL_MS, 1500);
  assert.equal(TOUCH_UP_SWITCH_STRENGTH, 40);
  assert.equal(TOUCH_UP_PLAIN_MAX, 0.9);
  // The hysteresis band exists, and the target sits above it: a gain that
  // only just reaches the target must not be what releases the meter (it
  // measures the source, but the ordering is what the stage relies on).
  assert.ok(LOW_LIGHT_ENGAGE_LUMA < LOW_LIGHT_RELEASE_LUMA);
  assert.ok(LOW_LIGHT_RELEASE_LUMA < LOW_LIGHT_TARGET_LUMA);
});

// ---- meanLuma --------------------------------------------------------------

const pixels = (...rgba: Array<readonly [number, number, number, number]>) =>
  rgba.flat();

const BLACK = [0, 0, 0, 255] as const;
const WHITE = [255, 255, 255, 255] as const;

test("meanLuma: black is 0 and white is 1", () => {
  assert.equal(meanLuma(pixels(BLACK, BLACK, BLACK, BLACK)), 0);
  const white = meanLuma(pixels(WHITE, WHITE, WHITE, WHITE));
  close(white, 1, "white");
  assert.ok(white <= 1, "never above 1");
});

test("meanLuma: known mixes use the Rec.601 weights and ignore alpha", () => {
  close(meanLuma(pixels([255, 0, 0, 255])), 0.299, "red");
  close(meanLuma(pixels([0, 255, 0, 255])), 0.587, "green");
  close(meanLuma(pixels([0, 0, 255, 255])), 0.114, "blue");
  close(meanLuma(pixels(BLACK, WHITE)), 0.5, "half black, half white");
  close(
    meanLuma(pixels([255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255])),
    1 / 3,
    "one of each primary",
  );
  // Alpha carries no light.
  close(meanLuma(pixels([255, 255, 255, 0])), 1, "transparent white");
  close(meanLuma(pixels([0, 0, 0, 0], [0, 0, 0, 255])), 0, "alpha only");
  // The readback type the stage hands over.
  close(
    meanLuma(new Uint8Array([128, 128, 128, 255])),
    128 / 255,
    "mid gray bytes",
  );
});

test("meanLuma: empty input is 0, never NaN", () => {
  assert.equal(meanLuma([]), 0);
  assert.equal(meanLuma(new Uint8Array(0)), 0);
  assert.equal(meanLuma(new Uint8ClampedArray(0)), 0);
  // Fewer bytes than one pixel is still no pixel.
  assert.equal(meanLuma([255, 255, 255]), 0);
  // A trailing partial pixel does not count.
  close(meanLuma([...WHITE, 255, 255]), 1, "partial tail");
});

// ---- LowLightMeter ---------------------------------------------------------

/** Push `luma` every `stepMs` over (fromMs, toMs]; returns the end time. */
function feed(
  meter: LowLightMeter,
  luma: number,
  fromMs: number,
  toMs: number,
  stepMs = 100,
  each?: (nowMs: number) => void,
): number {
  let now = fromMs;
  while (now + stepMs <= toMs) {
    now += stepMs;
    meter.push(luma, now);
    each?.(now);
  }
  return now;
}

/** The private slew rate, restated: gain per second. */
const GAIN_RATE_PER_S = 0.5;

test("LowLightMeter: starts released at gain 1", () => {
  const meter = new LowLightMeter();
  assert.equal(meter.engaged, false);
  assert.equal(meter.gain, 1);
});

test("LowLightMeter: a bright room never engages and the gain stays exactly 1", () => {
  const meter = new LowLightMeter();
  meter.push(0.6, 0);
  feed(meter, 0.6, 0, 10_000, 100, () => {
    assert.equal(meter.engaged, false);
    assert.equal(meter.gain, 1);
  });
});

test("LowLightMeter: one dark sample does not engage; sustained dark does", () => {
  const meter = new LowLightMeter();
  meter.push(0.6, 0);
  let now = feed(meter, 0.6, 0, 2000);

  // A hand over the lens for one sample.
  now += 100;
  meter.push(0, now);
  assert.equal(meter.engaged, false, "one black sample must not engage");
  assert.equal(meter.gain, 1);
  now = feed(meter, 0.6, now, now + 2000);
  assert.equal(meter.engaged, false);

  // The room goes dark and stays dark: still released half a second in
  // (the smoothing has not caught up), engaged within two seconds.
  now = feed(meter, 0.05, now, now + 500);
  assert.equal(meter.engaged, false, "engaged before the smoothing caught up");
  feed(meter, 0.05, now, now + 1500);
  assert.equal(meter.engaged, true, "sustained dark must engage");
});

test("LowLightMeter: the first sample seeds the average", () => {
  // A meter that starts in a dark room has nothing brighter to average
  // against, so it engages at once; the gain still ramps (see below).
  const dark = new LowLightMeter();
  dark.push(0.1, 5000);
  assert.equal(dark.engaged, true);
  assert.equal(dark.gain, 1, "no gain step on the seeding sample");

  // And the seed is the sample itself, not a blend with some dark default:
  // a bright first sample is released, and it carries its full weight, so
  // one black sample right behind it does not engage either.
  const bright = new LowLightMeter();
  bright.push(0.9, 5000);
  assert.equal(bright.engaged, false);
  assert.equal(bright.gain, 1);
  bright.push(0, 5100);
  assert.equal(bright.engaged, false);
  assert.equal(bright.gain, 1);
});

test("LowLightMeter: the thresholds are ENGAGE and RELEASE, to within 0.01", () => {
  // A steady room settles the average on the room, so a hundredth either
  // side of each threshold decides.
  const justAbove = new LowLightMeter();
  justAbove.push(0.6, 0);
  feed(justAbove, LOW_LIGHT_ENGAGE_LUMA + 0.01, 0, 30_000, 100, () =>
    assert.equal(justAbove.engaged, false, "engaged above ENGAGE"),
  );

  const justBelow = new LowLightMeter();
  justBelow.push(0.6, 0);
  feed(justBelow, LOW_LIGHT_ENGAGE_LUMA - 0.01, 0, 30_000);
  assert.equal(justBelow.engaged, true, "not engaged below ENGAGE");

  const held = new LowLightMeter();
  held.push(0.1, 0);
  assert.equal(held.engaged, true);
  feed(held, LOW_LIGHT_RELEASE_LUMA - 0.01, 0, 30_000, 100, () =>
    assert.equal(held.engaged, true, "released below RELEASE"),
  );

  const letGo = new LowLightMeter();
  letGo.push(0.1, 0);
  assert.equal(letGo.engaged, true);
  feed(letGo, LOW_LIGHT_RELEASE_LUMA + 0.01, 0, 30_000);
  assert.equal(letGo.engaged, false, "not released above RELEASE");
});

test("LowLightMeter: smoothing follows wall time, not the sample count", () => {
  // From 0.6 into a 0.05 room the average is 0.05 + 0.55 * exp(-t / 1000),
  // which crosses ENGAGE at 1000 * ln(2.2), about 788 ms, whatever the
  // sampling rate. A fixed blend per sample would engage after a fixed
  // number of samples instead.
  for (const stepMs of [10, 50, 100, 250, 500]) {
    const meter = new LowLightMeter();
    meter.push(0.6, 0);
    const now = feed(meter, 0.05, 0, 500, stepMs);
    assert.equal(now, 500);
    assert.equal(meter.engaged, false, `engaged by 500 ms at ${stepMs} ms`);
    feed(meter, 0.05, now, 1000, stepMs);
    assert.equal(meter.engaged, true, `not engaged by 1 s at ${stepMs} ms`);
  }

  // At 10 ms resolution the crossing pins the time constant itself.
  const meter = new LowLightMeter();
  meter.push(0.6, 0);
  let engagedAt: number | undefined;
  feed(meter, 0.05, 0, 3000, 10, (now) => {
    if (meter.engaged) engagedAt ??= now;
  });
  assert.equal(engagedAt, 790);
});

test("LowLightMeter: one sample after a long gap counts as one step", () => {
  const step = (GAIN_RATE_PER_S * LOW_LIGHT_MAX_STEP_MS) / 1000;

  // Bright, the page is hidden for 30 s, then one black sample.
  const bright = new LowLightMeter();
  bright.push(0.6, 0);
  let now = feed(bright, 0.6, 0, 3000);
  bright.push(0, now + 30_000);
  assert.equal(bright.engaged, false, "one sample after a gap engaged");
  assert.equal(bright.gain, 1);

  // The mirror: dark at full gain, a 30 s gap, then one bright sample.
  const dark = new LowLightMeter();
  dark.push(0.05, 0);
  now = feed(dark, 0.05, 0, 10_000);
  assert.equal(dark.gain, LOW_LIGHT_MAX_GAIN);
  dark.push(0.9, now + 30_000);
  assert.equal(dark.engaged, true, "one sample after a gap released");
  close(dark.gain, LOW_LIGHT_MAX_GAIN - step, "gain after the gap");

  // The gain slew is clamped by the same ceiling as the smoothing: still
  // dark after the gap, the gain rises by one step's worth, not to the cap.
  const ramp = new LowLightMeter();
  ramp.push(0.02, 0);
  assert.equal(ramp.gain, 1);
  ramp.push(0.02, 30_000);
  assert.equal(ramp.engaged, true);
  close(ramp.gain, 1 + step, "gain one sample after the gap");
});

test("LowLightMeter: a clock that steps backwards moves nothing", () => {
  // Seeded dark: engaged, gain still 1, heading for the cap. A negative
  // time delta must not push the gain the other way, below 1.
  const meter = new LowLightMeter();
  meter.push(0.02, 10_000);
  meter.push(0.02, 5000);
  assert.equal(meter.engaged, true);
  assert.equal(meter.gain, 1, "gain moved on a backwards clock");

  // Time carries on from the new clock. Part of the way up the ramp, a
  // backwards sample changes neither the gain nor the state, whatever its
  // luma. Each one is earlier than the last, so every delta is negative.
  let now = feed(meter, 0.02, 5000, 6000);
  const gain = meter.gain;
  assert.ok(gain > 1 && gain < LOW_LIGHT_MAX_GAIN, `mid-ramp, got ${gain}`);
  for (const luma of [0, 0.02, 0.9, 1]) {
    now -= 1000;
    meter.push(luma, now);
    assert.equal(meter.gain, gain, `gain moved (luma ${luma})`);
    assert.equal(meter.engaged, true, `state changed (luma ${luma})`);
  }

  // A released meter stays released at gain 1, and still works afterwards.
  const bright = new LowLightMeter();
  bright.push(0.6, 10_000);
  feed(bright, 0.6, 10_000, 12_000);
  bright.push(0, 1000);
  assert.equal(bright.engaged, false);
  assert.equal(bright.gain, 1);
  feed(bright, 0.02, 1000, 9000);
  assert.equal(bright.engaged, true);
  assert.equal(bright.gain, LOW_LIGHT_MAX_GAIN);
});

test("LowLightMeter: hysteresis, no flapping between ENGAGE and RELEASE", () => {
  const meter = new LowLightMeter();
  const between = (LOW_LIGHT_ENGAGE_LUMA + LOW_LIGHT_RELEASE_LUMA) / 2;
  let toggles = 0;
  let last = meter.engaged;
  const watch = () => {
    if (meter.engaged !== last) {
      toggles++;
      last = meter.engaged;
    }
  };

  // Released, then a room that sits in the band: stays released.
  meter.push(0.6, 0);
  let now = feed(meter, 0.6, 0, 3000, 100, watch);
  now = feed(meter, between, now, now + 15_000, 100, watch);
  assert.equal(meter.engaged, false, "the band must not engage");
  assert.equal(toggles, 0);

  // Dark: engages once.
  now = feed(meter, 0.1, now, now + 8000, 100, watch);
  assert.equal(meter.engaged, true);
  assert.equal(toggles, 1);

  // Back into the band, including a wobble across most of it: stays
  // engaged, and the gain keeps doing its job.
  now = feed(meter, between, now, now + 15_000, 100, watch);
  for (let i = 0; i < 100; i++) {
    now += 100;
    meter.push(i % 2 === 0 ? 0.31 : 0.39, now);
    watch();
  }
  assert.equal(meter.engaged, true, "the band must not release");
  assert.equal(toggles, 1);
  assert.ok(meter.gain > 1);

  // Bright: releases once.
  now = feed(meter, 0.7, now, now + 8000, 100, watch);
  assert.equal(meter.engaged, false);
  assert.equal(toggles, 2);

  // And the band again does not re-engage.
  feed(meter, between, now, now + 15_000, 100, watch);
  assert.equal(meter.engaged, false);
  assert.equal(toggles, 2);
});

test("LowLightMeter: the gain is capped at LOW_LIGHT_MAX_GAIN", () => {
  for (const luma of [0, 0.001, 0.01, 0.1, 0.2]) {
    const meter = new LowLightMeter();
    meter.push(luma, 0);
    feed(meter, luma, 0, 30_000, 100, () => {
      assert.ok(meter.gain >= 1, `gain ${meter.gain} below 1`);
      assert.ok(
        meter.gain <= LOW_LIGHT_MAX_GAIN,
        `gain ${meter.gain} above the cap at luma ${luma}`,
      );
    });
    assert.equal(meter.engaged, true);
    assert.equal(
      meter.gain,
      LOW_LIGHT_MAX_GAIN,
      `settles on the cap (${luma})`,
    );
  }
});

test("LowLightMeter: under the cap the gain settles on TARGET / smoothed", () => {
  const meter = new LowLightMeter();
  meter.push(0.25, 0);
  feed(meter, 0.25, 0, 30_000);
  assert.equal(meter.engaged, true);
  close(meter.gain, LOW_LIGHT_TARGET_LUMA / 0.25, "gain at luma 0.25");
});

test("LowLightMeter: the gain is exactly 1 again once released", () => {
  const meter = new LowLightMeter();
  meter.push(0.05, 0);
  let now = feed(meter, 0.05, 0, 10_000);
  assert.equal(meter.gain, LOW_LIGHT_MAX_GAIN);

  // Just above RELEASE, where TARGET / smoothed is still above 1: a released
  // meter must not keep applying it.
  now = feed(meter, 0.42, now, now + 20_000);
  assert.equal(meter.engaged, false);
  assert.equal(meter.gain, 1);
  feed(meter, 0.42, now, now + 5000, 100, () => assert.equal(meter.gain, 1));
});

test("LowLightMeter: the gain moves smoothly, up, down and across the release", () => {
  for (const stepMs of [33, 100, 400]) {
    const meter = new LowLightMeter();
    const maxStep = (GAIN_RATE_PER_S * stepMs) / 1000 + EPS;
    let previous = meter.gain;
    let largest = 0;
    let releasedAbove1 = false;
    const check = () => {
      const step = Math.abs(meter.gain - previous);
      assert.ok(
        step <= maxStep,
        `gain stepped ${step} in ${stepMs} ms (limit ${maxStep})`,
      );
      largest = Math.max(largest, step);
      if (!meter.engaged && meter.gain > 1) releasedAbove1 = true;
      previous = meter.gain;
    };

    // Starts in the dark (engaged on the seed), lights on, lights off.
    meter.push(0.02, 0);
    check();
    let now = feed(meter, 0.02, 0, 8000, stepMs, check);
    assert.equal(meter.gain, LOW_LIGHT_MAX_GAIN);
    now = feed(meter, 0.9, now, now + 8000, stepMs, check);
    assert.equal(meter.engaged, false);
    assert.equal(meter.gain, 1);
    now = feed(meter, 0.02, now, now + 8000, stepMs, check);
    assert.equal(meter.gain, LOW_LIGHT_MAX_GAIN);

    // The gain really moved at the limited rate, not in smaller hops that
    // would make the limit above vacuous.
    assert.ok(largest > maxStep / 2, `largest step ${largest}`);
    // Lights on releases the meter while the gain is still well above 1; it
    // ramps down from there instead of snapping (the snap is the pump).
    assert.ok(releasedAbove1, "release did not ramp");
  }
});

test("LowLightMeter: non-finite input is ignored", () => {
  const meter = new LowLightMeter();
  const twin = new LowLightMeter();
  const both = (luma: number, nowMs: number) => {
    meter.push(luma, nowMs);
    twin.push(luma, nowMs);
  };

  // Before the seed: a NaN must not become the average.
  meter.push(Number.NaN, 0);
  meter.push(Number.POSITIVE_INFINITY, 0);
  meter.push(0.5, Number.NaN);
  assert.equal(meter.engaged, false);
  assert.equal(meter.gain, 1);

  both(0.6, 1000);
  both(0.6, 1100);
  for (const bad of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]) {
    meter.push(bad, 1200);
    meter.push(0, bad);
  }
  assert.equal(meter.engaged, false);
  assert.equal(meter.gain, 1);

  // From here on the two meters must agree sample for sample.
  let now = 1200;
  for (const luma of [0.05, 0.9, 0.05]) {
    for (let i = 0; i < 60; i++) {
      now += 100;
      both(luma, now);
      meter.push(Number.NaN, now);
      assert.equal(meter.engaged, twin.engaged);
      assert.equal(meter.gain, twin.gain);
      assert.ok(Number.isFinite(meter.gain));
    }
  }
  assert.equal(twin.gain, LOW_LIGHT_MAX_GAIN);
});

test("LowLightMeter: reset returns a new meter", () => {
  const meter = new LowLightMeter();
  meter.push(0.02, 0);
  const now = feed(meter, 0.02, 0, 10_000);
  assert.equal(meter.engaged, true);
  assert.equal(meter.gain, LOW_LIGHT_MAX_GAIN);

  meter.reset();
  assert.equal(meter.engaged, false);
  assert.equal(meter.gain, 1);

  // The dark average is gone too: the next sample seeds, so a bright one
  // right after the reset stays released at gain 1.
  meter.push(0.9, now + 100);
  assert.equal(meter.engaged, false);
  assert.equal(meter.gain, 1);
  meter.push(0.9, now + 200);
  assert.equal(meter.engaged, false);
  assert.equal(meter.gain, 1);

  // And a reset meter still works.
  feed(meter, 0.02, now + 200, now + 10_000);
  assert.equal(meter.engaged, true);
  assert.equal(meter.gain, LOW_LIGHT_MAX_GAIN);
});

// ---- Touch up and the tone config ------------------------------------------

test("plainTouchUpStrength: 0 is off, and the strength is capped", () => {
  assert.equal(plainTouchUpStrength(0), 0);
  assert.equal(plainTouchUpStrength(-20), 0);
  assert.equal(plainTouchUpStrength(Number.NaN), 0);
  assert.equal(plainTouchUpStrength(Number.POSITIVE_INFINITY), 0);

  // Twice the stored fraction, up to the cap.
  close(plainTouchUpStrength(10), 0.2, "10");
  close(plainTouchUpStrength(40), 0.8, "40");
  close(plainTouchUpStrength(44), 0.88, "44");
  assert.equal(plainTouchUpStrength(45), TOUCH_UP_PLAIN_MAX);
  assert.equal(plainTouchUpStrength(46), TOUCH_UP_PLAIN_MAX);
  assert.equal(plainTouchUpStrength(50), TOUCH_UP_PLAIN_MAX);
  assert.equal(plainTouchUpStrength(100), TOUCH_UP_PLAIN_MAX);
  assert.equal(plainTouchUpStrength(1000), TOUCH_UP_PLAIN_MAX);

  // Monotone over the whole stored range, and never above the cap.
  let previous = 0;
  for (let beautify = 0; beautify <= 100; beautify++) {
    const strength = plainTouchUpStrength(beautify);
    assert.ok(strength >= previous, `not monotone at ${beautify}`);
    assert.ok(strength <= TOUCH_UP_PLAIN_MAX, `above the cap at ${beautify}`);
    previous = strength;
  }

  // What the in-call switch writes is strong enough to be seen, and inside
  // the cap.
  const switched = plainTouchUpStrength(TOUCH_UP_SWITCH_STRENGTH);
  close(switched, 0.8, "the switch value");
  assert.ok(switched <= TOUCH_UP_PLAIN_MAX);
});

test("toneIsNeutral: only the exact neutral config", () => {
  assert.deepEqual(NEUTRAL_TONE, { lowLightGain: 1, brightness: 1, smooth: 0 });
  assert.ok(Object.isFrozen(NEUTRAL_TONE));
  assert.equal(toneIsNeutral(NEUTRAL_TONE), true);
  assert.equal(toneIsNeutral({ ...NEUTRAL_TONE }), true);

  const off: ReadonlyArray<Partial<ToneConfig>> = [
    { lowLightGain: 1.001 },
    { lowLightGain: 2 },
    { brightness: 0.99 },
    { brightness: 1.5 },
    { smooth: 0.01 },
    { smooth: 1 },
    { lowLightGain: Number.NaN },
    { brightness: Number.NaN },
    { smooth: Number.NaN },
  ];
  for (const over of off) {
    assert.equal(
      toneIsNeutral({ ...NEUTRAL_TONE, ...over }),
      false,
      JSON.stringify(over),
    );
  }

  // What the other policies produce when everything is off is neutral.
  assert.equal(
    toneIsNeutral({
      lowLightGain: new LowLightMeter().gain,
      brightness: 1,
      smooth: plainTouchUpStrength(0),
    }),
    true,
  );
});

// ---- ToneWatchdog ----------------------------------------------------------

const ALL_STAGES: readonly ToneStageName[] = [
  "brightness",
  "lowLight",
  "touchUp",
];

type Shed = readonly [number, ToneStageName];

/** Sample every `stepMs` over [fromMs, toMs]; returns what was shed, when. */
function run(
  dog: ToneWatchdog,
  fps: readonly [source: number, processed: number],
  fromMs: number,
  toMs: number,
  active: readonly ToneStageName[] = ALL_STAGES,
  stepMs = 500,
): Shed[] {
  const sheds: Shed[] = [];
  for (let now = fromMs; now <= toMs; now += stepMs) {
    const stage = dog.sample(fps[0], fps[1], now, active);
    if (stage !== undefined) sheds.push([now, stage]);
  }
  return sheds;
}

const SLOW = [30, 10] as const;
const HEALTHY = [30, 29] as const;

test("ToneWatchdog: sheds only after the full window of slow samples", () => {
  const dog = new ToneWatchdog();
  assert.equal(dog.shed.size, 0);
  // 0..4500 ms: ten slow samples, not yet five seconds.
  assert.deepEqual(run(dog, SLOW, 0, 4500), []);
  assert.equal(dog.shed.size, 0);
  // The sample that completes the window sheds.
  assert.equal(dog.sample(...SLOW, 5000, ALL_STAGES), "touchUp");
  assert.deepEqual([...dog.shed], ["touchUp"]);
});

test("ToneWatchdog: the ratio is strict and healthy video never sheds", () => {
  // Exactly ratio * source is not slow.
  const edge = new ToneWatchdog();
  assert.deepEqual(run(edge, [30, 0.6 * 30], 0, 60_000), []);
  const healthy = new ToneWatchdog();
  assert.deepEqual(run(healthy, HEALTHY, 0, 60_000), []);
  // Just under it is.
  const under = new ToneWatchdog();
  assert.deepEqual(run(under, [30, 17.9], 0, 5000), [[5000, "touchUp"]]);
  // A dark room where the camera itself slows down is judged by ratio only.
  const dark = new ToneWatchdog();
  assert.deepEqual(run(dark, [8, 7], 0, 60_000), []);
});

test("ToneWatchdog: one healthy sample closes the window", () => {
  const dog = new ToneWatchdog();
  assert.deepEqual(run(dog, SLOW, 0, 4500), []);
  assert.equal(dog.sample(...HEALTHY, 4750, ALL_STAGES), undefined);
  // A new window opens at 5000 and completes at 10000, not before.
  assert.deepEqual(run(dog, SLOW, 5000, 12_000), [[10_000, "touchUp"]]);
});

test("ToneWatchdog: cost order, one stage per window, then nothing", () => {
  const dog = new ToneWatchdog();
  // The caller keeps passing every stage, in the wrong order, for a minute.
  assert.deepEqual(run(dog, SLOW, 0, 60_000), [
    [5000, "touchUp"],
    [10_000, "lowLight"],
    [15_000, "brightness"],
  ]);
  assert.deepEqual([...dog.shed].sort(), [...ALL_STAGES].sort());

  // Only the active stages are candidates, still costliest first.
  const partial = new ToneWatchdog();
  assert.deepEqual(run(partial, SLOW, 0, 60_000, ["brightness", "lowLight"]), [
    [5000, "lowLight"],
    [10_000, "brightness"],
  ]);
  assert.equal(partial.shed.has("touchUp"), false);
});

test("ToneWatchdog: a shed stage is never re-armed", () => {
  const dog = new ToneWatchdog();
  const only: readonly ToneStageName[] = ["touchUp"];
  assert.deepEqual(run(dog, SLOW, 0, 5000, only), [[5000, "touchUp"]]);
  // Still slow for a minute with the same stage reported active.
  assert.deepEqual(run(dog, SLOW, 5500, 65_000, only), []);
  // The video recovers, then slows down again: still nothing.
  assert.deepEqual(run(dog, HEALTHY, 65_500, 80_000, only), []);
  assert.deepEqual(run(dog, SLOW, 80_500, 140_000, only), []);
  assert.deepEqual([...dog.shed], ["touchUp"]);

  // The next stage is shed in its place, never the same one twice.
  assert.deepEqual(run(dog, SLOW, 140_500, 200_000), [
    [145_500, "lowLight"],
    [150_500, "brightness"],
  ]);
});

test("ToneWatchdog: a gap longer than the window restarts it", () => {
  const dog = new ToneWatchdog();
  assert.deepEqual(run(dog, SLOW, 0, 3000), []);
  // Nothing for six seconds (a hidden page, a stalled main thread). The
  // window opened at 0, but what happened in the gap was not measured.
  assert.equal(dog.sample(...SLOW, 9000, ALL_STAGES), undefined);
  assert.deepEqual(run(dog, SLOW, 9500, 20_000), [
    [14_000, "touchUp"],
    [19_000, "lowLight"],
  ]);

  // A gap of exactly the window is still inside it.
  const sparse = new ToneWatchdog();
  assert.equal(sparse.sample(...SLOW, 0, ALL_STAGES), undefined);
  assert.equal(sparse.sample(...SLOW, 5000, ALL_STAGES), "touchUp");
  // One millisecond more is not.
  const sparser = new ToneWatchdog();
  assert.equal(sparser.sample(...SLOW, 0, ALL_STAGES), undefined);
  assert.equal(sparser.sample(...SLOW, 5001, ALL_STAGES), undefined);
  assert.equal(sparser.sample(...SLOW, 10_000, ALL_STAGES), undefined);
  assert.equal(sparser.sample(...SLOW, 10_001, ALL_STAGES), "touchUp");
});

test("ToneWatchdog: sourceFps 0 is ignored and restarts the window", () => {
  for (const source of [0, -30, Number.NaN, Number.POSITIVE_INFINITY]) {
    const never = new ToneWatchdog();
    assert.deepEqual(run(never, [source, 0], 0, 60_000), [], `${source}`);
    assert.deepEqual(run(never, [source, 10], 60_500, 120_000), []);
    assert.equal(never.shed.size, 0);

    const dog = new ToneWatchdog();
    assert.deepEqual(run(dog, SLOW, 0, 4500), []);
    // The camera stops delivering for one sample (a flip, a restart).
    assert.equal(dog.sample(source, 0, 4750, ALL_STAGES), undefined);
    assert.deepEqual(
      run(dog, SLOW, 5000, 12_000),
      [[10_000, "touchUp"]],
      `window not restarted by sourceFps ${source}`,
    );
  }
});

test("ToneWatchdog: no active stage does nothing and restarts the window", () => {
  const never = new ToneWatchdog();
  assert.deepEqual(run(never, SLOW, 0, 60_000, []), []);
  assert.equal(never.shed.size, 0);

  const dog = new ToneWatchdog();
  assert.deepEqual(run(dog, SLOW, 0, 4500), []);
  assert.equal(dog.sample(...SLOW, 4750, []), undefined);
  assert.deepEqual(run(dog, SLOW, 5000, 12_000), [[10_000, "touchUp"]]);
});

test("ToneWatchdog: an unusable sample is idle and restarts the window", () => {
  const INF = Number.POSITIVE_INFINITY;
  const idle: ReadonlyArray<
    readonly [string, (dog: ToneWatchdog) => ToneStageName | undefined]
  > = [
    ["NaN processedFps", (d) => d.sample(30, Number.NaN, 4750, ALL_STAGES)],
    ["-Infinity processedFps", (d) => d.sample(30, -INF, 4750, ALL_STAGES)],
    ["Infinity processedFps", (d) => d.sample(30, INF, 4750, ALL_STAGES)],
    ["Infinity sourceFps", (d) => d.sample(INF, 10, 4750, ALL_STAGES)],
    ["NaN nowMs", (d) => d.sample(...SLOW, Number.NaN, ALL_STAGES)],
    ["Infinity nowMs", (d) => d.sample(...SLOW, INF, ALL_STAGES)],
    ["-Infinity nowMs", (d) => d.sample(...SLOW, -INF, ALL_STAGES)],
    ["backwards clock", (d) => d.sample(...SLOW, 2000, ALL_STAGES)],
  ];
  for (const [name, sample] of idle) {
    const dog = new ToneWatchdog();
    assert.deepEqual(run(dog, SLOW, 0, 4500), []);
    assert.equal(sample(dog), undefined, name);
    assert.equal(dog.shed.size, 0, name);
    // The window that was open is gone: a full one from 5000 is needed.
    assert.deepEqual(
      run(dog, SLOW, 5000, 12_000),
      [[10_000, "touchUp"]],
      `window not restarted by ${name}`,
    );
  }

  // And a stream of nothing but unusable samples never sheds.
  for (const fps of [
    [INF, 10],
    [30, -INF],
    [30, Number.NaN],
  ] as const) {
    const dog = new ToneWatchdog();
    assert.deepEqual(run(dog, fps, 0, 60_000), [], `${fps}`);
  }
});

test("ToneWatchdog: `shed` survives further samples of every kind", () => {
  const dog = new ToneWatchdog();
  assert.deepEqual(run(dog, SLOW, 0, 5000), [[5000, "touchUp"]]);
  const shed = dog.shed;

  run(dog, HEALTHY, 5500, 20_000);
  assert.deepEqual([...dog.shed], ["touchUp"]);
  run(dog, [0, 0], 20_500, 30_000);
  assert.deepEqual([...dog.shed], ["touchUp"]);
  run(dog, SLOW, 30_500, 34_000, []);
  assert.deepEqual([...dog.shed], ["touchUp"]);
  // A long gap, as after a processor rebuild.
  assert.equal(dog.sample(...HEALTHY, 600_000, ALL_STAGES), undefined);
  assert.deepEqual([...dog.shed], ["touchUp"]);
  // The set a caller read earlier is still the live one.
  assert.equal(dog.shed, shed);
  assert.equal(shed.has("touchUp"), true);
});

test("ToneWatchdog: reset is a new call", () => {
  const dog = new ToneWatchdog();
  assert.deepEqual(run(dog, SLOW, 0, 5000), [[5000, "touchUp"]]);
  // Part of the way into the next window.
  assert.deepEqual(run(dog, SLOW, 5500, 9000), []);

  dog.reset();
  assert.equal(dog.shed.size, 0);
  // The open window is gone as well: a full one is needed again, and the
  // stage shed in the last call is a candidate again.
  assert.deepEqual(run(dog, SLOW, 9500, 20_000), [
    [14_500, "touchUp"],
    [19_500, "lowLight"],
  ]);
});

test("ToneWatchdog: options override the defaults; bad ones fall back", () => {
  const strict = new ToneWatchdog({ ratio: 0.9, windowMs: 1000 });
  // 26 of 30 is fine at 0.6 and slow at 0.9.
  assert.deepEqual(run(strict, [30, 26], 0, 1000, ALL_STAGES, 250), [
    [1000, "touchUp"],
  ]);
  const byDefault = new ToneWatchdog();
  assert.deepEqual(run(byDefault, [30, 26], 0, 60_000), []);

  for (const opts of [
    {},
    { ratio: Number.NaN, windowMs: Number.NaN },
    { ratio: 0, windowMs: 0 },
    { ratio: -1, windowMs: -1 },
  ]) {
    const dog = new ToneWatchdog(opts);
    assert.deepEqual(
      run(dog, SLOW, 0, 5000),
      [[5000, "touchUp"]],
      JSON.stringify(opts),
    );
    assert.deepEqual(run(new ToneWatchdog(opts), [30, 18], 0, 60_000), []);
  }
});

// ---- ToneWatchdog: glam and sheds decided elsewhere ------------------------

/** Every stage with glam among them, in the wrong order on purpose. */
const GLAM_STAGES: readonly ToneStageName[] = [...ALL_STAGES, "glam"];

test("TONE_SHED_ORDER: glam is first, then the rest in cost order", () => {
  assert.equal(TONE_SHED_ORDER[0], "glam");
  assert.deepEqual(
    [...TONE_SHED_ORDER],
    ["glam", "touchUp", "lowLight", "brightness"],
  );
  // Each stage once, and nobody can reorder the list at run time.
  assert.equal(new Set(TONE_SHED_ORDER).size, TONE_SHED_ORDER.length);
  assert.ok(Object.isFrozen(TONE_SHED_ORDER));
});

test("ToneWatchdog: glam is shed before touchUp when both are active", () => {
  const dog = new ToneWatchdog();
  assert.deepEqual(run(dog, SLOW, 0, 60_000, GLAM_STAGES), [
    [5000, "glam"],
    [10_000, "touchUp"],
    [15_000, "lowLight"],
    [20_000, "brightness"],
  ]);
  assert.deepEqual([...dog.shed].sort(), [...GLAM_STAGES].sort());

  // Just the two of them, touchUp named first by the caller.
  const pair = new ToneWatchdog();
  assert.deepEqual(run(pair, SLOW, 0, 4500, ["touchUp", "glam"]), []);
  assert.equal(pair.sample(...SLOW, 5000, ["touchUp", "glam"]), "glam");
  assert.deepEqual([...pair.shed], ["glam"]);
  assert.equal(pair.sample(...SLOW, 10_000, ["touchUp", "glam"]), "touchUp");

  // Glam is a candidate only while it is active.
  const without = new ToneWatchdog();
  assert.deepEqual(run(without, SLOW, 0, 5000), [[5000, "touchUp"]]);
  assert.equal(without.shed.has("glam"), false);
});

test("ToneWatchdog: shedNow is true the first time and false after", () => {
  const dog = new ToneWatchdog();
  const shed = dog.shed;
  assert.equal(dog.shedNow("glam"), true);
  // Visible through the very set a caller already holds.
  assert.equal(shed.has("glam"), true);
  assert.deepEqual([...dog.shed], ["glam"]);
  assert.equal(dog.shedNow("glam"), false);
  assert.equal(dog.shedNow("glam"), false);
  assert.deepEqual([...dog.shed], ["glam"]);

  // Any stage can be recorded, each newly shed once.
  for (const stage of ALL_STAGES) {
    assert.equal(dog.shedNow(stage), true, stage);
    assert.equal(dog.shedNow(stage), false, stage);
  }
  assert.deepEqual([...dog.shed].sort(), [...GLAM_STAGES].sort());

  // A stage the frame rate already cost is not newly shed either.
  const slow = new ToneWatchdog();
  assert.deepEqual(run(slow, SLOW, 0, 5000, GLAM_STAGES), [[5000, "glam"]]);
  assert.equal(slow.shedNow("glam"), false);
  assert.deepEqual([...slow.shed], ["glam"]);
});

test("ToneWatchdog: a shedNow stage is never re-armed; reset clears it", () => {
  const dog = new ToneWatchdog();
  assert.equal(dog.shedNow("glam"), true);

  // Slow for a minute with glam still reported active: the others go in
  // cost order and glam is never picked.
  assert.deepEqual(run(dog, SLOW, 0, 60_000, GLAM_STAGES), [
    [5000, "touchUp"],
    [10_000, "lowLight"],
    [15_000, "brightness"],
  ]);
  // Healthy, idle, nothing active, a long gap: it stays shed through all.
  run(dog, HEALTHY, 60_500, 70_000, GLAM_STAGES);
  run(dog, [0, 0], 70_500, 80_000, GLAM_STAGES);
  run(dog, SLOW, 80_500, 90_000, []);
  assert.equal(dog.sample(...SLOW, 600_000, GLAM_STAGES), undefined);
  assert.equal(dog.shed.has("glam"), true);
  assert.equal(dog.shed.size, 4);

  // Glam alone, slow for a minute: nothing to shed.
  const only = new ToneWatchdog();
  assert.equal(only.shedNow("glam"), true);
  assert.deepEqual(run(only, SLOW, 0, 60_000, ["glam"]), []);
  assert.deepEqual([...only.shed], ["glam"]);

  // A new call: nothing is shed, and glam is a candidate again both ways.
  only.reset();
  assert.equal(only.shed.size, 0);
  assert.deepEqual(run(only, SLOW, 60_500, 70_000, ["glam"]), [
    [65_500, "glam"],
  ]);
  only.reset();
  assert.equal(only.shed.has("glam"), false);
  assert.equal(only.shedNow("glam"), true);
});

test("ToneWatchdog: a new shedNow closes the open window, so it costs one stage", () => {
  // Without it, the sample that completes the window sheds glam.
  const twin = new ToneWatchdog();
  assert.deepEqual(run(twin, SLOW, 0, 4500, GLAM_STAGES), []);
  assert.equal(twin.sample(...SLOW, 5000, GLAM_STAGES), "glam");

  // Glam given up at 4.9 s into the window that opened at 0: the sample
  // that would have completed that window sheds nothing more.
  const dog = new ToneWatchdog();
  assert.deepEqual(run(dog, SLOW, 0, 4500, GLAM_STAGES), []);
  assert.equal(dog.sample(...SLOW, 4900, GLAM_STAGES), undefined);
  assert.equal(dog.shedNow("glam"), true);
  assert.equal(dog.sample(...SLOW, 5000, GLAM_STAGES), undefined);
  assert.deepEqual([...dog.shed], ["glam"]);
  // The next stage needs a full window of its own, counted from the first
  // slow sample after the shed, and the ones after it go one window each.
  assert.deepEqual(run(dog, SLOW, 5500, 9500, GLAM_STAGES), []);
  assert.equal(dog.sample(...SLOW, 9900, GLAM_STAGES), undefined);
  assert.equal(dog.sample(...SLOW, 10_000, GLAM_STAGES), "touchUp");
  assert.deepEqual(run(dog, SLOW, 10_500, 20_000, GLAM_STAGES), [
    [15_000, "lowLight"],
    [20_000, "brightness"],
  ]);

  // The same when the stage recorded is not the one next in line.
  const other = new ToneWatchdog();
  assert.deepEqual(run(other, SLOW, 0, 4500, GLAM_STAGES), []);
  assert.equal(other.shedNow("lowLight"), true);
  assert.deepEqual(run(other, SLOW, 5000, 20_000, GLAM_STAGES), [
    [10_000, "glam"],
    [15_000, "touchUp"],
    [20_000, "brightness"],
  ]);

  // It does not open a window either: a full one is still needed, and a
  // healthy spell around it sheds nothing.
  const fresh = new ToneWatchdog();
  assert.equal(fresh.shedNow("glam"), true);
  assert.deepEqual(run(fresh, HEALTHY, 0, 30_000, GLAM_STAGES), []);
  assert.deepEqual(run(fresh, SLOW, 30_500, 35_000, GLAM_STAGES), []);
  assert.equal(fresh.sample(...SLOW, 35_500, GLAM_STAGES), "touchUp");
});

test("ToneWatchdog: a shedNow for a stage already shed keeps the open window", () => {
  // Shed by shedNow before the window opened, then asked for again 4.5 s
  // into it: nothing is newly shed, so the window completes on time.
  const dog = new ToneWatchdog();
  assert.equal(dog.shedNow("glam"), true);
  assert.deepEqual(run(dog, SLOW, 0, 4500, GLAM_STAGES), []);
  assert.equal(dog.shedNow("glam"), false);
  assert.equal(dog.sample(...SLOW, 5000, GLAM_STAGES), "touchUp");

  // Shed by the frame rate at 5000, which starts the next window there. A
  // repeat part of the way into that one does not push it back.
  const slow = new ToneWatchdog();
  assert.deepEqual(run(slow, SLOW, 0, 9500, GLAM_STAGES), [[5000, "glam"]]);
  assert.equal(slow.shedNow("glam"), false);
  assert.equal(slow.sample(...SLOW, 10_000, GLAM_STAGES), "touchUp");
  assert.deepEqual([...slow.shed].sort(), ["glam", "touchUp"]);
});

// ---- tonePageMode ----------------------------------------------------------

test("tonePageMode: the whole table", () => {
  const table: ReadonlyArray<
    readonly [{ hidden: boolean; timerHolds: boolean }, TonePageMode]
  > = [
    [{ hidden: false, timerHolds: false }, "frame"],
    [{ hidden: false, timerHolds: true }, "frame"],
    [{ hidden: true, timerHolds: true }, "timer"],
    [{ hidden: true, timerHolds: false }, "bypass"],
  ];
  assert.equal(new Set(table.map(([i]) => JSON.stringify(i))).size, 4);
  for (const [input, expected] of table) {
    assert.equal(tonePageMode(input), expected, JSON.stringify(input));
  }
});

test("toneTimerHolds: a frame within the stall limit, and nothing else", () => {
  const rows: ReadonlyArray<readonly [number, boolean]> = [
    [0, true],
    [16, true],
    [999, true],
    // A tab throttled to one timer tick a second still holds.
    [1000, true],
    [1100, true],
    [1500, true],
    [1501, false],
    [TONE_TIMER_STALL_MS, true],
    [TONE_TIMER_STALL_MS + 1, false],
    [5000, false],
    [30_000, false],
    [-1, false],
    [-0.001, false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
    [Number.NEGATIVE_INFINITY, false],
  ];
  for (const [age, expected] of rows) {
    assert.equal(toneTimerHolds(age), expected, `${age} ms`);
  }

  // Composed with the table above: a hidden page keeps its effects only
  // while the timer delivers.
  const hiddenMode = (age: number) =>
    tonePageMode({ hidden: true, timerHolds: toneTimerHolds(age) });
  assert.equal(hiddenMode(40), "timer");
  assert.equal(hiddenMode(4000), "bypass");
  assert.equal(hiddenMode(Number.NaN), "bypass");
});

// ---- toneAllowedOnPlatform -------------------------------------------------

test("toneAllowedOnPlatform: the whole table", () => {
  type Platform = Parameters<typeof toneAllowedOnPlatform>[0];
  // Written out by hand; only a non-Apple-gated platform with canvas
  // capture gets low light and touch up.
  const table: ReadonlyArray<readonly [Platform, boolean]> = [
    [{ ios: false, macTauri: false, canvasCapture: false }, false],
    [{ ios: false, macTauri: false, canvasCapture: true }, true],
    [{ ios: false, macTauri: true, canvasCapture: false }, false],
    [{ ios: false, macTauri: true, canvasCapture: true }, false],
    [{ ios: true, macTauri: false, canvasCapture: false }, false],
    [{ ios: true, macTauri: false, canvasCapture: true }, false],
    [{ ios: true, macTauri: true, canvasCapture: false }, false],
    [{ ios: true, macTauri: true, canvasCapture: true }, false],
  ];
  // Complete and duplicate-free, checked against generated inputs.
  const key = (p: Platform) => `${p.ios}/${p.macTauri}/${p.canvasCapture}`;
  const all = [false, true].flatMap((ios) =>
    [false, true].flatMap((macTauri) =>
      [false, true].map((canvasCapture) => ({ ios, macTauri, canvasCapture })),
    ),
  );
  assert.equal(table.length, 8);
  assert.deepEqual(table.map(([p]) => key(p)).sort(), all.map(key).sort());

  for (const [platform, expected] of table) {
    assert.equal(toneAllowedOnPlatform(platform), expected, key(platform));
  }
  assert.equal(table.filter(([, allowed]) => allowed).length, 1);
});

// ---- ContextLossLadder -----------------------------------------------------

const REBUILD: ContextLossAction = "rebuild";
const FAIL_OPEN: ContextLossAction = "fail-open";

test("ContextLossLadder: the first loss rebuilds, every later one fails open", () => {
  const ladder = new ContextLossLadder();
  assert.equal(ladder.onLost(), REBUILD);
  assert.equal(ladder.onLost(), FAIL_OPEN);
  assert.equal(ladder.onLost(), FAIL_OPEN);
});

test("ContextLossLadder: a failed rebuild fails open, and stays there", () => {
  const ladder = new ContextLossLadder();
  assert.equal(ladder.onLost(), REBUILD);
  assert.equal(ladder.onRebuildFailed(), FAIL_OPEN);
  assert.equal(ladder.onRebuildFailed(), FAIL_OPEN);
  assert.equal(ladder.onLost(), FAIL_OPEN);

  // Also when the failure is reported before any loss was: the rebuild is
  // forfeited either way.
  const early = new ContextLossLadder();
  assert.equal(early.onRebuildFailed(), FAIL_OPEN);
  assert.equal(early.onLost(), FAIL_OPEN);
});

test("ContextLossLadder: reset hands the one rebuild back", () => {
  const ladder = new ContextLossLadder();
  assert.equal(ladder.onLost(), REBUILD);
  assert.equal(ladder.onLost(), FAIL_OPEN);
  ladder.reset();
  assert.equal(ladder.onLost(), REBUILD);
  assert.equal(ladder.onLost(), FAIL_OPEN);

  ladder.reset();
  assert.equal(ladder.onRebuildFailed(), FAIL_OPEN);
  ladder.reset();
  assert.equal(ladder.onLost(), REBUILD);
});

/** A ladder whose one rebuild is out: the next counted loss fails open. */
const spentLadder = () => {
  const ladder = new ContextLossLadder();
  assert.equal(ladder.onLost(), REBUILD);
  return ladder;
};

/** Successful draws every `stepMs` from `fromMs` to `toMs`, both included. */
const drawSteadily = (
  ladder: ContextLossLadder,
  fromMs: number,
  toMs: number,
  stepMs = 500,
) => {
  for (let t = fromMs; t <= toMs; t += stepMs) ladder.onDraw(true, t);
};

test("ContextLossLadder: a loss on a hidden page is never counted", () => {
  // Every app switch may drop the context: none of them spends the rebuild.
  const ladder = new ContextLossLadder();
  for (let i = 0; i < 5; i++) assert.equal(ladder.onLost(true), REBUILD);
  // The one counted rebuild is still there afterwards...
  assert.equal(ladder.onLost(), REBUILD);
  assert.equal(ladder.onLost(), FAIL_OPEN);
  // ...and a hidden loss is still free once it has been spent.
  assert.equal(ladder.onLost(true), REBUILD);
  assert.equal(ladder.onLost(false), FAIL_OPEN);
});

test("ContextLossLadder: a steady run of draws earns the rebuild back", () => {
  assert.equal(CONTEXT_LOSS_REARM_MS, 10_000);

  // One millisecond short of the period: still spent.
  const short = spentLadder();
  drawSteadily(short, 1000, 1000 + CONTEXT_LOSS_REARM_MS - 500);
  short.onDraw(true, 1000 + CONTEXT_LOSS_REARM_MS - 1);
  assert.equal(short.onLost(), FAIL_OPEN);

  // The full period, counted from the first successful draw after the loss.
  const full = spentLadder();
  drawSteadily(full, 1000, 1000 + CONTEXT_LOSS_REARM_MS);
  assert.equal(full.onLost(), REBUILD);
  // It is one rebuild again, not an unlimited supply...
  assert.equal(full.onLost(), FAIL_OPEN);
  // ...and it can be earned back a second time the same way.
  drawSteadily(full, 50_000, 50_000 + CONTEXT_LOSS_REARM_MS);
  assert.equal(full.onLost(), REBUILD);
  assert.equal(full.onLost(), FAIL_OPEN);
});

test("ContextLossLadder: a refused draw restarts the steady run", () => {
  const ladder = spentLadder();
  drawSteadily(ladder, 0, 6000);
  ladder.onDraw(false, 6500);
  // The run now starts after the refusal: 3.5 s long, not 10.5 s.
  drawSteadily(ladder, 7000, 10_500);
  assert.equal(ladder.onLost(), FAIL_OPEN);

  // From the refusal on, a full period does earn it back.
  const patient = spentLadder();
  drawSteadily(patient, 0, 6000);
  patient.onDraw(false, 6500);
  drawSteadily(patient, 7000, 7000 + CONTEXT_LOSS_REARM_MS);
  assert.equal(patient.onLost(), REBUILD);
});

test("ContextLossLadder: a gap between draws restarts the steady run", () => {
  assert.equal(CONTEXT_LOSS_REARM_MAX_GAP_MS, 2000);

  // Two draws 10 s apart are not 10 s of drawing.
  const sparse = spentLadder();
  sparse.onDraw(true, 0);
  sparse.onDraw(true, CONTEXT_LOSS_REARM_MS);
  assert.equal(sparse.onLost(), FAIL_OPEN);

  // A gap of exactly the limit keeps the run; one millisecond more ends it.
  const atLimit = spentLadder();
  drawSteadily(
    atLimit,
    0,
    CONTEXT_LOSS_REARM_MS,
    CONTEXT_LOSS_REARM_MAX_GAP_MS,
  );
  assert.equal(atLimit.onLost(), REBUILD);

  const overLimit = spentLadder();
  drawSteadily(overLimit, 0, 4000);
  drawSteadily(overLimit, 4000 + CONTEXT_LOSS_REARM_MAX_GAP_MS + 1, 10_500);
  assert.equal(overLimit.onLost(), FAIL_OPEN);
});

test("ContextLossLadder: a bad clock restarts the steady run", () => {
  // A clock that stepped backwards: the run starts again at the new time.
  const backwards = spentLadder();
  drawSteadily(backwards, 0, 9000);
  backwards.onDraw(true, 500);
  drawSteadily(backwards, 1000, 10_000);
  assert.equal(backwards.onLost(), FAIL_OPEN);

  // A non-finite time is not a draw anyone can date.
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const ladder = spentLadder();
    drawSteadily(ladder, 0, 6000);
    ladder.onDraw(true, bad);
    drawSteadily(ladder, 6500, 10_500);
    assert.equal(ladder.onLost(), FAIL_OPEN, String(bad));
  }
});

test("ContextLossLadder: any loss restarts the steady run, and draws before a loss bank nothing", () => {
  // A long healthy spell before the first loss does not pre-pay a second.
  const fresh = new ContextLossLadder();
  drawSteadily(fresh, 0, 60_000);
  assert.equal(fresh.onLost(), REBUILD);
  assert.equal(fresh.onLost(), FAIL_OPEN);

  // A hidden loss in the middle of the run is free but ends the run.
  const ladder = spentLadder();
  drawSteadily(ladder, 0, 6000);
  assert.equal(ladder.onLost(true), REBUILD);
  drawSteadily(ladder, 6500, 10_500);
  assert.equal(ladder.onLost(), FAIL_OPEN);
});

test("ContextLossLadder: a failed rebuild is final, hidden or steady", () => {
  const ladder = spentLadder();
  assert.equal(ladder.onRebuildFailed(), FAIL_OPEN);
  // No run of draws earns anything back...
  drawSteadily(ladder, 0, 5 * CONTEXT_LOSS_REARM_MS);
  assert.equal(ladder.onLost(), FAIL_OPEN);
  // ...and a hidden page is no excuse any more.
  assert.equal(ladder.onLost(true), FAIL_OPEN);
  // Only a reset (a full build, or the user switching tone on again) is.
  ladder.reset();
  assert.equal(ladder.onLost(), REBUILD);
});

// ---- toneStageBlind --------------------------------------------------------

test("toneStageBlind: black output from a frame that is not black", () => {
  assert.equal(TONE_BLIND_SOURCE_FLOOR, 0.02);
  const blind = (sourceLuma: number, outputLuma: number, brightness = 1) =>
    toneStageBlind({ sourceLuma, outputLuma, brightness });

  // The failure: the camera shows a room and the stage drew pure black.
  assert.equal(blind(0.5, 0), true);
  assert.equal(blind(TONE_BLIND_SOURCE_FLOOR, 0), true);
  // Any output at all is a picture, however dark.
  assert.equal(blind(0.5, 1 / 255), false);
  assert.equal(blind(0.5, 0.5), false);
  // A covered lens is black in and black out: not a failure.
  assert.equal(blind(0, 0), false);
  assert.equal(blind(TONE_BLIND_SOURCE_FLOOR - 0.001, 0), false);
  // Brightness scales what the output should be: at 0 black is correct.
  assert.equal(blind(0.5, 0, 0), false);
  assert.equal(blind(0.03, 0, 0.5), false);
  assert.equal(blind(0.03, 0, 1.5), true);
  // An input nobody measured never condemns the stage.
  assert.equal(blind(Number.NaN, 0), false);
  assert.equal(blind(0.5, Number.NaN), false);
  assert.equal(blind(0.5, 0, Number.NaN), false);
});

// ---- toneTurnedOn ----------------------------------------------------------

test("toneTurnedOn: the whole table", () => {
  const wants = (lowLight: boolean, touchUp: boolean): ToneWants => ({
    lowLight,
    touchUp,
  });
  const OFF = wants(false, false);
  const LOW = wants(true, false);
  const TOUCH = wants(false, true);
  const BOTH = wants(true, true);

  const table: Array<[was: ToneWants, now: ToneWants, expected: boolean]> = [
    // Nothing changed.
    [OFF, OFF, false],
    [LOW, LOW, false],
    [TOUCH, TOUCH, false],
    [BOTH, BOTH, false],
    // Something came on.
    [OFF, LOW, true],
    [OFF, TOUCH, true],
    [OFF, BOTH, true],
    [LOW, BOTH, true],
    [TOUCH, BOTH, true],
    // Something only went off.
    [LOW, OFF, false],
    [TOUCH, OFF, false],
    [BOTH, OFF, false],
    [BOTH, LOW, false],
    [BOTH, TOUCH, false],
    // A swap: one off, the other on.
    [LOW, TOUCH, true],
    [TOUCH, LOW, true],
  ];
  assert.equal(table.length, 16);
  for (const [was, now, expected] of table) {
    assert.equal(
      toneTurnedOn(was, now),
      expected,
      `${JSON.stringify(was)} -> ${JSON.stringify(now)}`,
    );
  }
});

test("toneTurnedOn: glam coming on counts, like the others", () => {
  const OFF: ToneWants = { lowLight: false, touchUp: false };
  const glam = (value: boolean | undefined): ToneWants =>
    value === undefined ? { ...OFF } : { ...OFF, glam: value };

  const table: Array<
    [was: boolean | undefined, now: boolean | undefined, expected: boolean]
  > = [
    [undefined, true, true],
    [false, true, true],
    [true, true, false],
    [true, false, false],
    // Left out is off, on either side.
    [true, undefined, false],
    [undefined, undefined, false],
    [undefined, false, false],
    [false, undefined, false],
    [false, false, false],
  ];
  assert.equal(table.length, 9);
  for (const [was, now, expected] of table) {
    assert.equal(
      toneTurnedOn(glam(was), glam(now)),
      expected,
      `${String(was)} -> ${String(now)}`,
    );
  }

  // Glam staying on does not hide another setting coming on, and another
  // setting staying on does not hide glam coming on.
  const on = (wants: Partial<ToneWants>): ToneWants => ({ ...OFF, ...wants });
  assert.equal(
    toneTurnedOn(on({ glam: true }), on({ glam: true, lowLight: true })),
    true,
  );
  assert.equal(
    toneTurnedOn(on({ touchUp: true }), on({ touchUp: true, glam: true })),
    true,
  );
  // Glam going off while nothing comes on is not a turn-on.
  assert.equal(
    toneTurnedOn(on({ glam: true, lowLight: true }), on({ lowLight: true })),
    false,
  );
  // A swap is: glam off, touch up on.
  assert.equal(toneTurnedOn(on({ glam: true }), on({ touchUp: true })), true);
});
