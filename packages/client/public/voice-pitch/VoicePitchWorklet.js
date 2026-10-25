/**
 * Voice changer pitch shift for the local microphone.
 *
 * A two-tap delay-line ("Doppler") pitch shifter: the input is written into a
 * ring buffer and read back by two heads whose delay sweeps across a short
 * window at the speed the pitch ratio asks for. A head that reads faster than
 * the writer raises the pitch, slower lowers it. When a head's delay wraps
 * from one end of the window to the other it would click, so the two heads
 * sit half a window apart and are crossfaded with complementary sin² / cos²
 * weights: each head is silent exactly at its own wrap point, and the two
 * weights always sum to 1.
 *
 * Splice alignment. Two copies of a voice half a window apart are, in
 * general, out of phase, and mixing them mid-crossfade cancels: a plain
 * two-tap shifter warbles and phases on most voice pitches. So whenever a
 * head wraps (its weight is 0, nothing audible changes) it picks an extra
 * delay of 0 … SEARCH_SECONDS that best lines its signal up with the other
 * head's, by normalized cross-correlation. Both heads move at the same speed,
 * so the alignment holds for the whole grain. SEARCH_SECONDS covers one
 * period of a fundamental down to 50 Hz.
 *
 * Chosen over an FFT phase vocoder for a call: no block latency beyond the
 * window, no allocation on the audio thread, and a few multiply-adds per
 * sample plus one short correlation search per grain. Formants move with the
 * pitch, which is the chipmunk / monster sound people want from a voice
 * changer.
 *
 * Mono in, the same signal on every output channel: the mic is captured
 * mono and the pipeline creates this node with `channelCount: 1`.
 *
 * `semitones` is a k-rate AudioParam (-12 … +12). The pipeline sends "stop"
 * on teardown so `process` returns false and the node can be collected.
 * While the pipeline has wired past this stage (0 semitones) the node gets no
 * input; when it is wired back in, the old buffer is dropped so no audio from
 * before the gap is replayed.
 *
 * Served self-hosted from public/ — never a CDN; the desktop shell CSP
 * blocks external script origins outright.
 */

/** Grain window. With the splice alignment below, 30 ms holds the level
 *  steadier than 50 ms did and adds less delay to the call (~25 ms mean). */
const WINDOW_SECONDS = 0.03;

/** How far a head may shift its splice point to line up with the other. */
const SEARCH_SECONDS = 0.02;

/** Length of the stretch of signal compared when lining heads up. */
const MATCH_SECONDS = 0.01;

/** Never read closer to the writer than this, so the linear interpolation's
 *  second sample has always already been written. */
const MIN_DELAY = 1;

const MAX_SEMITONES = 12;

class VoicePitchShift extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: "semitones",
        defaultValue: 0,
        minValue: -MAX_SEMITONES,
        maxValue: MAX_SEMITONES,
        automationRate: "k-rate",
      },
    ];
  }

  constructor() {
    super();
    this._window = Math.max(256, Math.round(sampleRate * WINDOW_SECONDS));
    this._search = Math.round(sampleRate * SEARCH_SECONDS);
    this._match = Math.round(sampleRate * MATCH_SECONDS);
    let size = 1;
    while (size < MIN_DELAY + this._window + this._search + this._match + 4) {
      size <<= 1;
    }
    this._buffer = new Float32Array(size);
    this._mask = size - 1;
    this._reset();
    this._stopped = false;
    this.port.onmessage = (event) => {
      if (event.data === "stop") this._stopped = true;
    };
  }

  _reset() {
    this._buffer.fill(0);
    this._write = 0;
    // Head A's position in the window, 0 … 1. Head B is half a window on.
    this._phase = 0;
    // Each head's splice alignment, in samples (see the file comment).
    this._offsetA = 0;
    this._offsetB = 0;
    this._idle = false;
  }

  _read(delay) {
    const pos = this._write - delay;
    const index = Math.floor(pos);
    const frac = pos - index;
    const a = this._buffer[index & this._mask];
    const b = this._buffer[(index + 1) & this._mask];
    return a + (b - a) * frac;
  }

  /** Normalized correlation of the `match` samples behind two read points,
   *  every `stride`-th sample. */
  _score(start, other, stride) {
    const buffer = this._buffer;
    const mask = this._mask;
    let dot = 0;
    let energy = 0;
    for (let k = 0; k < this._match; k += stride) {
      const a = buffer[(start - k) & mask];
      dot += a * buffer[(other - k) & mask];
      energy += a * a;
    }
    return energy > 0 ? dot / Math.sqrt(energy) : 0;
  }

  /**
   * The extra delay (0 … search) at which a head restarting at `baseDelay`
   * best matches the head currently reading at `otherDelay`. Compares the
   * `match` samples just behind each read point — the heads advance at the
   * same rate, so matching the recent past lines up what comes next.
   * Coarse to fine (every 4th lag on every 4th sample, then ±3 lags around
   * the winner) so one search stays a small slice of a render quantum even
   * on a slow phone.
   */
  _bestOffset(baseDelay, otherDelay) {
    const end = this._write;
    const other = end - Math.round(otherDelay);
    const base = end - Math.round(baseDelay);
    let coarse = 0;
    let bestScore = -Infinity;
    for (let lag = 0; lag <= this._search; lag += 4) {
      const score = this._score(base - lag, other, 4);
      if (score > bestScore) {
        bestScore = score;
        coarse = lag;
      }
    }
    let best = coarse;
    bestScore = -Infinity;
    const from = Math.max(0, coarse - 3);
    const to = Math.min(this._search, coarse + 3);
    for (let lag = from; lag <= to; lag++) {
      const score = this._score(base - lag, other, 2);
      if (score > bestScore) {
        bestScore = score;
        best = lag;
      }
    }
    return best;
  }

  process(inputs, outputs, parameters) {
    if (this._stopped) return false;
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const input = inputs[0] && inputs[0][0];
    const out = output[0];

    if (!input) {
      // Disconnected (the pipeline wired past this stage): stay silent and
      // cheap until it is wired back in, then start from a clean buffer.
      out.fill(0);
      for (let c = 1; c < output.length; c++) output[c].fill(0);
      this._idle = true;
      return true;
    }
    if (this._idle) this._reset();

    let semitones = parameters.semitones[0];
    if (!(semitones >= -MAX_SEMITONES)) semitones = 0;
    if (semitones > MAX_SEMITONES) semitones = MAX_SEMITONES;
    const ratio = Math.pow(2, semitones / 12);
    const window = this._window;
    // d(delay)/d(sample) = 1 - ratio, expressed as a phase step.
    const step = (1 - ratio) / window;
    const buffer = this._buffer;
    const mask = this._mask;
    let phase = this._phase;

    for (let i = 0; i < out.length; i++) {
      buffer[this._write] = input[i];
      let phaseB = phase + 0.5;
      if (phaseB >= 1) phaseB -= 1;
      const s = Math.sin(Math.PI * phase);
      const gainA = s * s;
      const delayB = MIN_DELAY + phaseB * window + this._offsetB;
      out[i] =
        this._read(MIN_DELAY + phase * window + this._offsetA) * gainA +
        this._read(delayB) * (1 - gainA);

      const nextA = phase + step;
      const nextB = phaseB + step;
      phase = nextA - Math.floor(nextA);
      this._write = (this._write + 1) & mask;
      // A head wraps exactly where its weight is 0: re-align it there.
      if (nextA < 0 || nextA >= 1) {
        this._offsetA = this._bestOffset(MIN_DELAY + phase * window, delayB);
      } else if (nextB < 0 || nextB >= 1) {
        let wrappedB = phase + 0.5;
        if (wrappedB >= 1) wrappedB -= 1;
        this._offsetB = this._bestOffset(
          MIN_DELAY + wrappedB * window,
          MIN_DELAY + phase * window + this._offsetA,
        );
      }
    }

    this._phase = phase;
    for (let c = 1; c < output.length; c++) output[c].set(out);
    return true;
  }
}

registerProcessor("VoicePitchShift", VoicePitchShift);
