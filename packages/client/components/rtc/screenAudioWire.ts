/**
 * The screen-share-audio wire contract and the timing guards — the pure half
 * of `screenAudioNative.ts`, split out so it can be unit-tested without a
 * browser or a Tauri shell.
 *
 * 🔴 Everything here MUST match `acutest-desktop/src-tauri/screen-audio/
 * src/frame.rs`. The two are separate repos, so nothing but these tests and
 * the version field stands between a header-layout change on one side and a
 * renderer silently misreading every frame on the other.
 */

/** Bumped only for a wire-format change; a frame with an unknown version is
 *  refused rather than reinterpreted. */
export const WIRE_VERSION = 1;

/** Fixed 24-byte header: version, flags, generation, seq, send timestamp. */
export const HEADER_BYTES = 24;

/** Terminal `end` frame. Carries no payload. */
export const FLAG_SENTINEL = 1 << 0;
/** Synthesized silence — a gap fill, or the keepalive a gated session emits. */
export const FLAG_SYNTHETIC = 1 << 1;
/** The shell's send gate is closed: seq advances, no audio. */
export const FLAG_GATED = 1 << 2;

export interface FrameHeader {
  version: number;
  flags: number;
  generation: number;
  seq: number;
}

/**
 * Parse a frame header. `undefined` for anything too short to be one.
 *
 * The caller must also check `version`: a frame from a newer shell may lay its
 * bytes out differently, and reading it anyway is worse than dropping it.
 */
export function readHeader(buffer: ArrayBuffer): FrameHeader | undefined {
  if (buffer.byteLength < HEADER_BYTES) return undefined;
  const view = new DataView(buffer);
  return {
    version: view.getUint16(0, true),
    flags: view.getUint16(2, true),
    generation: view.getUint32(4, true),
    // Safe as a Number: at 100 frames/s a 2^53 sequence is ~2.8 million years.
    seq: Number(view.getBigUint64(8, true)),
  };
}

/** §3.6.5's numbers, as the shell hands them over. */
export interface Timings {
  tickCadenceMs: number;
  quantaPerTick: number;
  frameWatchdogMs: number;
  relayWatchdogMs: number;
  heartbeatQuanta: number;
  jitterTargetMs: number;
  frameMs: number;
}

/**
 * 🔴 The deadlines arrive from the shell and must FAIL CLOSED.
 *
 * Unvalidated, a shell that omits them — the dark/lit skew matrix explicitly
 * contemplates version-mismatched pairs — makes every `x > undefined`
 * comparison false, so BOTH watchdogs are permanently and silently disabled
 * while the worklet keeps ticking and keeps refreshing the shell's liveness
 * credit. The renderer is then left with no death detector at all.
 *
 * The fallbacks are §3.6.5's shipped values; `frameWatchdogMs` in particular
 * must stay above the 2430 ms underrun slice 0 measured from a 2 s wedge, or
 * the watchdog fires on the stall it was sized to survive.
 */
export function validateTimings(raw: Partial<Timings> | undefined): Timings {
  const positive = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : fallback;
  return {
    tickCadenceMs: positive(raw?.tickCadenceMs, 250),
    quantaPerTick: positive(raw?.quantaPerTick, 94),
    frameWatchdogMs: positive(raw?.frameWatchdogMs, 2500),
    relayWatchdogMs: positive(raw?.relayWatchdogMs, 2500),
    heartbeatQuanta: positive(raw?.heartbeatQuanta, 940),
    jitterTargetMs: positive(raw?.jitterTargetMs, 100),
    frameMs: positive(raw?.frameMs, 10),
  };
}

/**
 * §3.6.4 invariant 2, as a decision rather than two ifs.
 *
 * Both loops are conditioned on the OTHER's freshness. Both stamps stale is a
 * main-thread wedge — nothing was delivered because nothing was running —
 * which slice 0 measured as survivable (a 2 s wedge produced one silent gap
 * and the queue was back at target within ~608 ms). Tearing down there kills
 * a share that was about to recover on its own.
 */
export type LivenessVerdict =
  | "healthy"
  | "wedged"
  | "producer-dead"
  | "graph-dead";

export function evaluateLiveness(
  sinceFrameMs: number,
  sinceTickMs: number,
  timings: Pick<Timings, "frameWatchdogMs" | "relayWatchdogMs">,
): LivenessVerdict {
  const framesStale = sinceFrameMs > timings.frameWatchdogMs;
  const ticksStale = sinceTickMs > timings.relayWatchdogMs;
  if (framesStale && ticksStale) return "wedged";
  if (framesStale) return "producer-dead";
  if (ticksStale) return "graph-dead";
  return "healthy";
}
