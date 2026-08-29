// Unit spec for the screen-share-audio wire contract — run with Node's
// built-in runner:
//   node --test --conditions=browser components/rtc/screenAudioWire.test.ts
// Focus: the header layout matches the Rust side byte for byte, the timing
// guards FAIL CLOSED on a shell that sends nothing, and the liveness decision
// refuses to tear down the one stall the design measured as survivable.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FLAG_GATED,
  FLAG_SENTINEL,
  FLAG_SYNTHETIC,
  HEADER_BYTES,
  WIRE_VERSION,
  evaluateLiveness,
  readHeader,
  validateTimings,
} from "./screenAudioWire.ts";

// -- header ----------------------------------------------------------------

/** Build a header the way `frame.rs` writes one: little-endian throughout. */
function header(
  fields: {
    version?: number;
    flags?: number;
    generation?: number;
    seq?: bigint;
    sendMicros?: bigint;
  },
  totalBytes = HEADER_BYTES,
): ArrayBuffer {
  const buffer = new ArrayBuffer(totalBytes);
  const view = new DataView(buffer);
  view.setUint16(0, fields.version ?? WIRE_VERSION, true);
  view.setUint16(2, fields.flags ?? 0, true);
  view.setUint32(4, fields.generation ?? 1, true);
  view.setBigUint64(8, fields.seq ?? 0n, true);
  view.setBigUint64(16, fields.sendMicros ?? 0n, true);
  return buffer;
}

test("the header is 24 bytes and the field offsets match the Rust encoder", () => {
  const parsed = readHeader(
    header({ version: 1, flags: 0b101, generation: 0xdeadbeef, seq: 1234n }),
  );
  assert.deepEqual(parsed, {
    version: 1,
    flags: 0b101,
    generation: 0xdeadbeef,
    seq: 1234,
  });
});

test("a full-size frame parses the same as a bare header", () => {
  // 1944 bytes on the wire: 24-byte header + 480 stereo 16-bit sample-frames.
  const parsed = readHeader(header({ seq: 7n }, 1944));
  assert.equal(parsed?.seq, 7);
});

test("a truncated frame is refused rather than read past the end", () => {
  assert.equal(readHeader(new ArrayBuffer(0)), undefined);
  assert.equal(readHeader(new ArrayBuffer(HEADER_BYTES - 1)), undefined);
});

test("a large sequence number survives the u64 conversion", () => {
  // At 100 frames/s, 2^53 is ~2.8 million years — this asserts the Number
  // conversion does not silently lose the top bits before then.
  const seq = 9_007_199_254_740_991n; // Number.MAX_SAFE_INTEGER
  assert.equal(readHeader(header({ seq }))?.seq, 9_007_199_254_740_991);
});

test("the flag bits do not overlap", () => {
  assert.notEqual(FLAG_SENTINEL & FLAG_SYNTHETIC, FLAG_SENTINEL);
  assert.notEqual(FLAG_SYNTHETIC & FLAG_GATED, FLAG_SYNTHETIC);
  assert.equal(FLAG_SENTINEL | FLAG_SYNTHETIC | FLAG_GATED, 0b111);
});

test("a sentinel is distinguishable from a gated keepalive", () => {
  // Both are frames with no useful audio; only one ends the share.
  const sentinel = readHeader(header({ flags: FLAG_SENTINEL }));
  const keepalive = readHeader(header({ flags: FLAG_GATED | FLAG_SYNTHETIC }));
  assert.ok((sentinel!.flags & FLAG_SENTINEL) !== 0);
  assert.ok((keepalive!.flags & FLAG_SENTINEL) === 0);
});

// -- timings ---------------------------------------------------------------

test("timings from a shell that sends nothing fall back, never to undefined", () => {
  // 🔴 The failure this prevents: `x > undefined` is false, so BOTH watchdogs
  // would be permanently and silently disabled while the worklet kept ticking
  // and kept refreshing the shell's credit.
  const t = validateTimings(undefined);
  assert.ok(t.frameWatchdogMs > 0);
  assert.ok(t.relayWatchdogMs > 0);
  assert.ok(t.jitterTargetMs > 0);
  assert.ok(t.quantaPerTick > 0);
  assert.ok(t.heartbeatQuanta > 0);
});

test("the frame watchdog default clears the measured survivable wedge", () => {
  // Slice 0: a 2 s main-thread wedge produced 2430 ms of underrun. A deadline
  // at or under that fires on the stall it was sized to survive.
  assert.ok(validateTimings(undefined).frameWatchdogMs > 2430);
});

test("garbage from a mismatched shell is replaced, not adopted", () => {
  const t = validateTimings({
    frameWatchdogMs: 0,
    relayWatchdogMs: -1,
    jitterTargetMs: Number.NaN,
    quantaPerTick: Number.POSITIVE_INFINITY,
    heartbeatQuanta: "940" as unknown as number,
  });
  assert.equal(t.frameWatchdogMs, 2500);
  assert.equal(t.relayWatchdogMs, 2500);
  assert.equal(t.jitterTargetMs, 100);
  assert.equal(t.quantaPerTick, 94);
  assert.equal(t.heartbeatQuanta, 940);
});

test("real values from the shell are passed through untouched", () => {
  const t = validateTimings({
    tickCadenceMs: 250,
    quantaPerTick: 94,
    frameWatchdogMs: 2500,
    relayWatchdogMs: 2500,
    heartbeatQuanta: 940,
    jitterTargetMs: 100,
    frameMs: 10,
  });
  assert.equal(t.frameWatchdogMs, 2500);
  assert.equal(t.frameMs, 10);
});

// -- liveness --------------------------------------------------------------

const DEADLINES = { frameWatchdogMs: 2500, relayWatchdogMs: 2500 };

test("a healthy feed is healthy", () => {
  assert.equal(evaluateLiveness(10, 250, DEADLINES), "healthy");
});

test("frames stale while ticks are fresh means the producer died", () => {
  assert.equal(evaluateLiveness(3000, 250, DEADLINES), "producer-dead");
});

test("ticks stale while frames are fresh means the audio graph died", () => {
  assert.equal(evaluateLiveness(10, 3000, DEADLINES), "graph-dead");
});

test("🔴 both stale is a survivable wedge and must NOT tear down", () => {
  // §3.6.4 invariant 2. Nothing was delivered because nothing was running;
  // slice 0 measured this recovering to target depth within ~608 ms.
  assert.equal(evaluateLiveness(3000, 3000, DEADLINES), "wedged");
});

test("the boundary is exclusive, so a stall exactly at the deadline survives", () => {
  assert.equal(evaluateLiveness(2500, 250, DEADLINES), "healthy");
  assert.equal(evaluateLiveness(2501, 250, DEADLINES), "producer-dead");
});
