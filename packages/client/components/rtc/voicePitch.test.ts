/**
 * Specs for the voice changer: the pure range helpers in `voicePitch.ts` and
 * the DSP in the self-hosted worklet `public/voice-pitch/VoicePitchWorklet.js`.
 *
 * Run with:
 *   node --conditions=browser --test components/rtc/voicePitch.test.ts
 *
 * The worklet is loaded for real: the file is imported with the three
 * AudioWorkletGlobalScope names it uses (`AudioWorkletProcessor`,
 * `registerProcessor`, `sampleRate`) stubbed on globalThis, and the class it
 * registers is driven with 128-frame render quanta like the audio thread.
 */
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

import {
  VOICE_PITCH_DEFAULT,
  VOICE_PITCH_MAX,
  VOICE_PITCH_MIN,
  clampVoicePitch,
  formatVoicePitch,
  voicePitchIsActive,
  voicePitchRatio,
} from "./voicePitch.ts";

describe("voicePitch range", () => {
  test("is one octave each way, off in the middle", () => {
    assert.equal(VOICE_PITCH_MIN, -12);
    assert.equal(VOICE_PITCH_MAX, 12);
    assert.equal(VOICE_PITCH_DEFAULT, 0);
  });

  test("clamps to whole semitones inside the range", () => {
    assert.equal(clampVoicePitch(3), 3);
    assert.equal(clampVoicePitch(-7), -7);
    assert.equal(clampVoicePitch(2.6), 3);
    assert.equal(clampVoicePitch(40), 12);
    assert.equal(clampVoicePitch(-40), -12);
  });

  test("never stores -0", () => {
    assert.ok(Object.is(clampVoicePitch(-0.4), 0));
    assert.ok(Object.is(clampVoicePitch(-0), 0));
  });

  test("garbage falls back to off", () => {
    for (const bad of [NaN, Infinity, -Infinity, "5", null, undefined, {}]) {
      assert.equal(clampVoicePitch(bad), 0, String(bad));
    }
  });

  test("is active exactly when the clamped value is non-zero", () => {
    assert.equal(voicePitchIsActive(0), false);
    assert.equal(voicePitchIsActive(0.3), false);
    assert.equal(voicePitchIsActive(NaN), false);
    assert.equal(voicePitchIsActive(1), true);
    assert.equal(voicePitchIsActive(-1), true);
  });

  test("ratio doubles per octave", () => {
    assert.equal(voicePitchRatio(0), 1);
    assert.equal(voicePitchRatio(12), 2);
    assert.equal(voicePitchRatio(-12), 0.5);
    assert.ok(Math.abs(voicePitchRatio(7) - 1.4983) < 1e-4);
  });

  test("formats with an explicit sign above zero", () => {
    assert.equal(formatVoicePitch(0), "0");
    assert.equal(formatVoicePitch(4), "+4");
    assert.equal(formatVoicePitch(-5), "-5");
  });
});

// --- worklet --------------------------------------------------------------

const SAMPLE_RATE = 48000;
const QUANTUM = 128;

interface FakePort {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(data: unknown): void;
}

interface PitchProcessor {
  port: FakePort;
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

type ProcessorCtor = (new () => PitchProcessor) & {
  parameterDescriptors: {
    name: string;
    defaultValue: number;
    minValue: number;
    maxValue: number;
    automationRate: string;
  }[];
};

let Processor: ProcessorCtor;
let registeredName: string | undefined;

before(async () => {
  const g = globalThis as Record<string, unknown>;
  g.sampleRate = SAMPLE_RATE;
  g.AudioWorkletProcessor = class {
    port: FakePort = {
      onmessage: null,
      postMessage() {},
    };
  };
  g.registerProcessor = (name: string, ctor: ProcessorCtor) => {
    registeredName = name;
    Processor = ctor;
  };
  // A URL, not a bare literal: the worklet is plain JS with no typings, and
  // tsc must not try to resolve it as a module of the app.
  await import(
    new URL("../../public/voice-pitch/VoicePitchWorklet.js", import.meta.url)
      .href
  );
});

/** Run `seconds` of `source(sampleIndex)` through a fresh processor. */
function renderSignal(
  source: (n: number) => number,
  semitones: number,
  seconds: number,
) {
  const node = new Processor();
  const total = Math.floor((SAMPLE_RATE * seconds) / QUANTUM) * QUANTUM;
  const out = new Float32Array(total);
  const param = { semitones: new Float32Array([semitones]) };
  for (let offset = 0; offset < total; offset += QUANTUM) {
    const input = new Float32Array(QUANTUM);
    for (let i = 0; i < QUANTUM; i++) input[i] = source(offset + i);
    const output = [new Float32Array(QUANTUM)];
    assert.equal(node.process([[input]], [output], param), true);
    out.set(output[0], offset);
  }
  return out;
}

/** Run `seconds` of a 0.5-amplitude sine through a fresh processor. */
function render(freqHz: number, semitones: number, seconds: number) {
  return renderSignal(
    (n) => 0.5 * Math.sin((2 * Math.PI * freqHz * n) / SAMPLE_RATE),
    semitones,
    seconds,
  );
}

/**
 * A voice-like test signal: a fundamental gliding 100 → 210 Hz with five
 * harmonics rolling off at 1/h. Every lag the splice search could pick is
 * exercised, unlike a single fixed tone.
 */
function voiceLike(n: number): number {
  const t = n / SAMPLE_RATE;
  // Instantaneous f0 = 100 + 110·t (t ≤ 1 s): phase is its integral.
  const phase = 2 * Math.PI * (100 * t + 55 * t * t);
  let s = 0;
  for (let h = 1; h <= 5; h++) s += Math.sin(h * phase) / h;
  return 0.25 * s;
}

/**
 * Smallest 10 ms block RMS over the median one, after the first 100 ms.
 * 10 ms spans a full period of everything rendered here, so a steady input
 * reads ~0.9 (the dry signals score 0.87–0.92). An unaligned two-tap shifter
 * drops below 0.1 on a tone whose period does not divide the head spacing.
 */
function envelopeFloor(signal: Float32Array): number {
  const block = Math.round(SAMPLE_RATE * 0.01);
  const rms: number[] = [];
  for (let s = Math.round(SAMPLE_RATE * 0.1); s + block <= signal.length; ) {
    let sum = 0;
    for (let k = 0; k < block; k++) sum += signal[s + k] ** 2;
    rms.push(Math.sqrt(sum / block));
    s += block;
  }
  const sorted = [...rms].sort((a, b) => a - b);
  return sorted[0] / sorted[Math.floor(sorted.length / 2)];
}

/**
 * Dominant frequency by single-bin DFT magnitude over a candidate grid. Zero
 * crossings would be fooled by the grain crossfade; a spectral peak is not.
 */
function dominantHz(signal: Float32Array, candidates: number[]): number {
  // Skip the first window so the ring buffer is full of real signal.
  const start = Math.round(SAMPLE_RATE * 0.1);
  let best = candidates[0];
  let bestMag = -1;
  for (const f of candidates) {
    let re = 0;
    let im = 0;
    for (let n = start; n < signal.length; n++) {
      const w = (2 * Math.PI * f * n) / SAMPLE_RATE;
      re += signal[n] * Math.cos(w);
      im -= signal[n] * Math.sin(w);
    }
    const mag = re * re + im * im;
    if (mag > bestMag) {
      bestMag = mag;
      best = f;
    }
  }
  return best;
}

/**
 * Level floors (see `envelopeFloor`), from measurement with margin. Measured
 * aligned: tones ≥ 0.91; the voice-like glide 0.85–0.91, except an octave
 * down at 0.61. The same worklet with the splice search switched off scores
 * 0.09 on tones and fails both.
 */
const FLOOR_TONE = 0.8;
const FLOOR_VOICE = 0.75;
const FLOOR_VOICE_OCTAVE_DOWN = 0.5;

const GRID = Array.from({ length: 141 }, (_, i) => 100 + i * 10); // 100…1500 Hz

describe("VoicePitchWorklet", () => {
  test("registers under the name the pipeline instantiates", () => {
    assert.equal(registeredName, "VoicePitchShift");
  });

  test("declares one k-rate semitones param over the same range", () => {
    const [param, ...rest] = Processor.parameterDescriptors;
    assert.equal(rest.length, 0);
    assert.equal(param.name, "semitones");
    assert.equal(param.defaultValue, 0);
    assert.equal(param.minValue, VOICE_PITCH_MIN);
    assert.equal(param.maxValue, VOICE_PITCH_MAX);
    assert.equal(param.automationRate, "k-rate");
  });

  for (const semitones of [12, 7, -5, -12]) {
    test(`moves a 400 Hz tone by ${semitones} semitones`, () => {
      const out = render(400, semitones, 0.6);
      const expected = 400 * voicePitchRatio(semitones);
      const got = dominantHz(out, GRID);
      assert.ok(
        Math.abs(got - expected) <= 15,
        `expected ~${expected.toFixed(1)} Hz, got ${got} Hz`,
      );
    });
  }

  test("moves a 220 Hz tone too (a pitch that is not 400 Hz-friendly)", () => {
    const got = dominantHz(render(220, 7, 0.6), GRID);
    assert.ok(Math.abs(got - 220 * voicePitchRatio(7)) <= 15, `got ${got}`);
  });

  // The two heads sit 25 ms apart: 400 Hz is exactly 10 cycles there and
  // can never cancel, so the level checks use pitches that can.
  for (const freq of [140, 180, 220, 260]) {
    test(`keeps a steady level on a ${freq} Hz tone`, () => {
      for (const semitones of [-12, -5, 3, 7, 12]) {
        const floor = envelopeFloor(render(freq, semitones, 0.8));
        assert.ok(floor >= FLOOR_TONE, `${semitones}: floor ${floor}`);
      }
    });
  }

  test("keeps a steady level on a gliding, harmonic voice-like signal", () => {
    for (const semitones of [-12, -5, 3, 7, 12]) {
      const floor = envelopeFloor(renderSignal(voiceLike, semitones, 1));
      const min = semitones === -12 ? FLOOR_VOICE_OCTAVE_DOWN : FLOOR_VOICE;
      assert.ok(floor >= min, `${semitones}: floor ${floor}`);
    }
  });

  test("wired back in after a gap, it does not replay old audio", () => {
    const node = new Processor();
    const param = { semitones: new Float32Array([5]) };
    const loud = new Float32Array(QUANTUM).fill(0.5);
    for (let i = 0; i < 40; i++) {
      node.process([[loud]], [[new Float32Array(QUANTUM)]], param);
    }
    // Wired past (no input), then back in with silence at the mic.
    node.process([[]], [[new Float32Array(QUANTUM)]], param);
    for (let i = 0; i < 40; i++) {
      const output = [new Float32Array(QUANTUM)];
      node.process([[new Float32Array(QUANTUM)]], [output], param);
      assert.ok(
        output[0].every((s) => s === 0),
        `quantum ${i} replayed`,
      );
    }
  });

  test("at 0 semitones the tone is unchanged", () => {
    assert.equal(dominantHz(render(400, 0, 0.6), GRID), 400);
  });

  test("never amplifies: output stays within the input's peak", () => {
    for (const semitones of [-12, -3, 5, 12]) {
      const out = render(220, semitones, 0.5);
      let peak = 0;
      for (const s of out) peak = Math.max(peak, Math.abs(s));
      assert.ok(peak <= 0.5 + 1e-6, `${semitones}: peak ${peak}`);
      assert.ok(peak > 0.25, `${semitones}: suspiciously quiet (${peak})`);
    }
  });

  test("out-of-range and NaN params are clamped, never NaN out", () => {
    for (const semitones of [99, -99, NaN]) {
      const out = render(300, semitones, 0.2);
      assert.ok(out.every(Number.isFinite), String(semitones));
    }
  });

  test("with no input it renders silence and stays alive", () => {
    const node = new Processor();
    const output = [new Float32Array(QUANTUM).fill(1)];
    const alive = node.process([[]], [output], {
      semitones: new Float32Array([5]),
    });
    assert.equal(alive, true);
    assert.ok(output[0].every((s) => s === 0));
  });

  test("copies the mono result to every output channel", () => {
    const node = new Processor();
    const input = new Float32Array(QUANTUM).map((_, i) => Math.sin(i / 5));
    const output = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
    for (let i = 0; i < 40; i++) {
      node.process([[input]], [output], { semitones: new Float32Array([3]) });
    }
    assert.deepEqual(output[1], output[0]);
  });

  test('"stop" ends processing so the node can be collected', () => {
    const node = new Processor();
    node.port.onmessage?.({ data: "stop" });
    const alive = node.process(
      [[new Float32Array(QUANTUM)]],
      [[new Float32Array(QUANTUM)]],
      { semitones: new Float32Array([0]) },
    );
    assert.equal(alive, false);
  });
});
