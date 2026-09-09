// Specs for gate (d)'s decode-witness listener — run with Node's built-in
// runner:
//   node --test --conditions=browser components/rtc/decodeWitnessListener.test.ts
//
// Every assertion here is about ONE posture: the witness is amber until a
// well-formed sample says otherwise, and it goes back to amber the moment
// samples stop. The holes these pin, each of which read GREEN in a review
// round or would have:
//
//   initial     — the signal's starting value lived inline in `state.tsx`,
//                 which no spec can load. Flipping it to an available witness
//                 restored green-by-default with all 13 spec files green and
//                 all 24 mutations still red.
//   malformed   — a missing or non-array `participants` was coerced to `[]`
//                 and summarized, and `summarizeDecodeWitness([])` returns
//                 `available: true`. A worker posting the right kind with the
//                 wrong shape therefore PROMOTED the gate on garbage.
//   kind        — livekit's own worker messages flow through this same
//                 listener and carry a `data` payload of their own; without
//                 the kind guard one of them can be read as a witness.
//   staleness   — the heartbeat IS the evidence. A witness that never expires
//                 is a green that outlives the worker that earned it.
//   teardown    — the last sample must not keep standing after the listener
//                 is detached.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DECODE_WITNESS_CHECK_MS,
  DECODE_WITNESS_INITIAL,
  DECODE_WITNESS_KIND,
  DECODE_WITNESS_STALE_MS,
  createDecodeWitnessListener,
  parseDecodeWitnessMessage,
  sameWitness,
} from "./decodeWitnessListener.ts";
import { type DecodeWitness } from "./mlsCallModePolicy.ts";

/** A well-formed worker post: `jeff` is being read, nothing is being dropped. */
const sample = (
  participants: unknown = [
    { identity: "jeff", indexes: [{ keyIndex: 2, seen: 30, dropped: 0 }] },
  ],
) => ({ kind: DECODE_WITNESS_KIND, data: { participants } });

/** A sender whose frames arrive at an index this device silenced. */
const droppingSample = () =>
  sample([
    {
      identity: "velvetfly",
      indexes: [{ keyIndex: 1, seen: 12, dropped: 12 }],
    },
  ]);

interface Rig {
  listener: ReturnType<typeof createDecodeWitnessListener>;
  /** Every witness handed to `onWitness`, in order. */
  written: DecodeWitness[];
  warns: string[];
  infos: string[];
  advance: (ms: number) => void;
  current: { value: boolean };
}

function rig(options: { staleMs?: number; checkMs?: number } = {}): Rig {
  let clock = 1_000;
  const written: DecodeWitness[] = [];
  const warns: string[] = [];
  const infos: string[] = [];
  const current = { value: true };
  const listener = createDecodeWitnessListener({
    now: () => clock,
    onWitness: (witness) => written.push(witness),
    isCurrentSession: () => current.value,
    log: { warn: (m) => warns.push(m), info: (m) => infos.push(m) },
    ...options,
  });
  return {
    listener,
    written,
    warns,
    infos,
    current,
    advance: (ms) => {
      clock += ms;
    },
  };
}

/**
 * The witness the chip would be reading right now.
 *
 * 🔴 It ASSERTS rather than falling back to `DECODE_WITNESS_INITIAL`. The
 * fallback made four specs pass through the rig's own copy of what
 * `state.tsx` seeds `createSignal` with — so they caught a mutation of the
 * constant while proving nothing about the call site, which is the only place
 * it matters. Whether `state.tsx` actually seeds from the constant is checked
 * by `rtc-gate.sh`, which can assert about a file it cannot load.
 */
const latest = (r: Rig): DecodeWitness => {
  const last = r.written.at(-1);
  assert.ok(last, "expected a witness to have been written");
  return last;
};

// --- the initial value ------------------------------------------------------

test("🔴 the witness signal's initial value is UNAVAILABLE", () => {
  // The whole inversion in one assertion: a call that never arms the witness
  // reads amber. This is the constant `state.tsx` seeds `createSignal` with.
  assert.equal(DECODE_WITNESS_INITIAL.available, false);
  assert.deepEqual(DECODE_WITNESS_INITIAL.dropping, []);
  assert.deepEqual(DECODE_WITNESS_INITIAL.live, []);
});

test("a freshly built listener has not promoted anything", () => {
  const r = rig();
  assert.deepEqual(r.written, []);
});

test("a fresh listener is not stale yet, so an early tick writes nothing", () => {
  const r = rig();
  r.advance(DECODE_WITNESS_STALE_MS);
  r.listener.tick();
  assert.deepEqual(r.written, []);
  assert.deepEqual(r.warns, []);
});

// --- the happy path ---------------------------------------------------------

test("a valid sample produces the summarized witness", () => {
  const r = rig();
  r.listener.onMessage(sample());
  assert.deepEqual(latest(r), {
    available: true,
    dropping: [],
    live: ["jeff"],
  });
});

test("a sender dropping at a silenced index is named", () => {
  const r = rig();
  r.listener.onMessage(droppingSample());
  assert.deepEqual(latest(r), {
    available: true,
    dropping: ["velvetfly"],
    live: [],
  });
});

test("an EMPTY participants array is a quiet window, not a malformed one", () => {
  // The worker posts once a second whether or not it has anything to report,
  // so this is the normal state of a call nobody is talking in. It promotes:
  // `available` means "the patched worker is in this bundle", nothing more.
  const r = rig();
  r.listener.onMessage(sample([]));
  assert.deepEqual(latest(r), { available: true, dropping: [], live: [] });
});

// --- the guards -------------------------------------------------------------

test("🔴 a foreign message kind is ignored even when it carries a payload", () => {
  // livekit's own worker messages come through this listener and have a `data`
  // field of their own. Without the kind guard, one shaped like ours is read
  // as a witness and promotes the gate.
  const r = rig();
  r.listener.onMessage({
    kind: "cryptorError",
    data: { participants: [{ identity: "jeff", indexes: [] }] },
  });
  assert.deepEqual(r.written, []);
});

test("non-object and empty messages are ignored", () => {
  const r = rig();
  for (const data of [undefined, null, "slogaDecodeWitness", 7, {}, []]) {
    r.listener.onMessage(data);
  }
  assert.deepEqual(r.written, []);
});

test("🔴 a message for a superseded session is ignored", () => {
  // A disposed session's worker can still deliver a queued post after a newer
  // call has armed its own listener; it must not write the new call's chip.
  const r = rig();
  r.current.value = false;
  r.listener.onMessage(sample());
  assert.deepEqual(r.written, []);
});

test("🔴 a superseded session's post does not refresh the staleness clock", () => {
  // Otherwise a dead session's worker holds a live call's witness alive.
  const r = rig();
  r.current.value = false;
  r.advance(DECODE_WITNESS_STALE_MS);
  r.listener.onMessage(sample());
  r.advance(1);
  r.listener.tick();
  assert.equal(latest(r).available, false);
});

// --- malformed samples ------------------------------------------------------

test("🔴 a sample with NO participants field does not throw and does not promote", () => {
  const r = rig();
  assert.doesNotThrow(() =>
    r.listener.onMessage({ kind: DECODE_WITNESS_KIND }),
  );
  assert.doesNotThrow(() =>
    r.listener.onMessage({ kind: DECODE_WITNESS_KIND, data: {} }),
  );
  assert.deepEqual(r.written, []);
});

test("🔴 a NON-ARRAY participants field does not throw and does not promote", () => {
  const r = rig();
  for (const participants of [null, "jeff", 3, { identity: "jeff" }]) {
    assert.doesNotThrow(() => r.listener.onMessage(sample(participants)));
  }
  assert.deepEqual(r.written, []);
});

test("🔴 a participant entry missing `indexes` does not throw and does not promote", () => {
  // This one used to throw out of the message handler — AFTER the staleness
  // clock had been refreshed — freezing the chip on the last good sample.
  const r = rig();
  assert.doesNotThrow(() =>
    r.listener.onMessage(sample([{ identity: "jeff" }])),
  );
  assert.doesNotThrow(() =>
    r.listener.onMessage(sample([{ identity: "jeff", indexes: null }])),
  );
  assert.doesNotThrow(() => r.listener.onMessage(sample([null])));
  assert.doesNotThrow(() => r.listener.onMessage(sample([{ indexes: [] }])));
  assert.deepEqual(r.written, []);
});

test("🔴 a tally with negative or fractional counts does not promote", () => {
  // `{seen: -10, dropped: -10}` used to parse and summarize to available with
  // no drops — a CLEAN read manufactured out of garbage.
  const r = rig();
  for (const indexes of [
    [{ keyIndex: 1, seen: -10, dropped: -10 }],
    [{ keyIndex: 1, seen: 10, dropped: -1 }],
    [{ keyIndex: 1, seen: 1.5, dropped: 0 }],
    // More thrown away than ever arrived is not a window we can read.
    [{ keyIndex: 1, seen: 2, dropped: 3 }],
  ]) {
    r.listener.onMessage(sample([{ identity: "jeff", indexes }]));
  }
  assert.deepEqual(r.written, []);
});

test("a keyIndex of -1 is the worker's 'no index on this frame', not garbage", () => {
  const r = rig();
  r.listener.onMessage(
    sample([
      { identity: "jeff", indexes: [{ keyIndex: -1, seen: 4, dropped: 4 }] },
    ]),
  );
  assert.deepEqual(latest(r).dropping, ["jeff"]);
});

test("🔴 a tally that is not an object at all does not promote", () => {
  const r = rig();
  for (const indexes of [[null], ["1:30:0"], [7]]) {
    r.listener.onMessage(sample([{ identity: "jeff", indexes }]));
  }
  assert.deepEqual(r.written, []);
});

test("🔴 a tally with non-numeric counts does not promote", () => {
  const r = rig();
  r.listener.onMessage(
    sample([
      { identity: "jeff", indexes: [{ keyIndex: 1, seen: "30", dropped: 0 }] },
    ]),
  );
  r.listener.onMessage(
    sample([{ identity: "jeff", indexes: [{ keyIndex: 1, seen: 30 }] }]),
  );
  r.listener.onMessage(
    sample([
      { identity: "jeff", indexes: [{ keyIndex: 1, seen: NaN, dropped: 0 }] },
    ]),
  );
  assert.deepEqual(r.written, []);
});

test("🔴 a malformed sample does not refresh the staleness clock", () => {
  // A worker posting the right kind with the wrong shape is not a heartbeat.
  // If garbage kept the clock alive, a broken worker would hold the last good
  // witness — and its green — forever.
  const r = rig();
  r.listener.onMessage(sample());
  assert.equal(latest(r).available, true);
  r.advance(DECODE_WITNESS_STALE_MS + 1);
  r.listener.onMessage(sample("not-an-array"));
  r.listener.tick();
  assert.equal(latest(r).available, false);
});

// --- staleness --------------------------------------------------------------

test("🔴 the witness goes UNAVAILABLE once the threshold is passed", () => {
  const r = rig();
  r.listener.onMessage(sample());
  assert.equal(latest(r).available, true);

  // Exactly at the threshold is still fresh — three beats means three.
  r.advance(DECODE_WITNESS_STALE_MS);
  r.listener.tick();
  assert.equal(latest(r).available, true);

  r.advance(1);
  r.listener.tick();
  assert.deepEqual(latest(r), { available: false, dropping: [], live: [] });
});

test("🔴 the stale write repeats on every tick; only the warning is once", () => {
  const r = rig();
  r.listener.onMessage(sample());
  r.advance(DECODE_WITNESS_STALE_MS + 1);
  r.listener.tick();
  r.advance(DECODE_WITNESS_CHECK_MS);
  r.listener.tick();
  r.advance(DECODE_WITNESS_CHECK_MS);
  r.listener.tick();

  const stale = r.written.filter((w) => !w.available);
  assert.equal(stale.length, 3);
  assert.equal(r.warns.length, 1);
  assert.match(r.warns[0], /no decode witness from the e2ee worker/);
});

test("🔴 the witness recovers on the next sample, and says so once", () => {
  const r = rig();
  r.listener.onMessage(sample());
  r.advance(DECODE_WITNESS_STALE_MS + 1);
  r.listener.tick();
  assert.equal(latest(r).available, false);

  r.listener.onMessage(sample());
  assert.deepEqual(latest(r), {
    available: true,
    dropping: [],
    live: ["jeff"],
  });
  assert.equal(r.infos.length, 1);
  assert.match(r.infos[0], /reporting again/);

  // ...and the warning can fire again the next time it goes quiet.
  r.advance(DECODE_WITNESS_STALE_MS + 1);
  r.listener.tick();
  assert.equal(r.warns.length, 2);
});

test("a recovery that was never preceded by a warning stays silent", () => {
  const r = rig();
  r.listener.onMessage(sample());
  r.advance(DECODE_WITNESS_CHECK_MS);
  r.listener.onMessage(sample());
  assert.deepEqual(r.infos, []);
});

test("🔴 a witness three seconds old is fresh; three seconds and a millisecond is not", () => {
  // Hardcoded on purpose. Every other staleness spec advances by
  // `DECODE_WITNESS_STALE_MS + 1`, which SCALES with the constant — widen the
  // threshold to a minute and they all stay green while detection latency
  // blows out. This one is the only assertion about wall-clock time.
  const r = rig();
  r.listener.onMessage(sample());
  r.advance(3_000);
  r.listener.tick();
  assert.equal(latest(r).available, true);
  r.advance(1);
  r.listener.tick();
  assert.equal(latest(r).available, false);
});

test("🔴 the threshold is three of the worker's beats, checked once a beat", () => {
  // Polling AT the threshold would make detection latency up to twice it —
  // several seconds of green over a witness that had already stopped.
  assert.equal(DECODE_WITNESS_CHECK_MS, 1_000);
  assert.equal(DECODE_WITNESS_STALE_MS, 3_000);
  assert.equal(DECODE_WITNESS_STALE_MS, 3 * DECODE_WITNESS_CHECK_MS);
  assert.equal(rig().listener.checkMs, DECODE_WITNESS_CHECK_MS);
});

test("the staleness threshold is overridable and the default is not hardcoded twice", () => {
  const r = rig({ staleMs: 50, checkMs: 20 });
  r.listener.onMessage(sample());
  r.advance(51);
  r.listener.tick();
  assert.equal(latest(r).available, false);
});

test("🔴 a sweep slower than half the threshold is refused at construction", () => {
  // `checkMs: 60_000` against the default 3 s threshold held a dead worker's
  // green for 57 seconds, and passed every spec, every mutation AND the gate's
  // source-text assertion — the line that starts the interval is byte-identical
  // either way. Detection latency is bounded by the sweep, so the threshold has
  // to be worth at least two of them.
  assert.throws(() => rig({ checkMs: 60_000 }), /at least two check intervals/);
  assert.throws(() => rig({ staleMs: 1_000, checkMs: 1_000 }), RangeError);
  // The defaults satisfy it, and so does an equal-and-doubled pair.
  assert.doesNotThrow(() => rig());
  assert.doesNotThrow(() => rig({ staleMs: 2_000, checkMs: 1_000 }));
});

// --- teardown ---------------------------------------------------------------

test("🔴 stop() writes UNAVAILABLE so the last sample stops standing", () => {
  const r = rig();
  r.listener.onMessage(sample());
  assert.equal(latest(r).available, true);
  r.listener.stop();
  assert.deepEqual(latest(r), { available: false, dropping: [], live: [] });
});

test("🔴 stop() writes UNAVAILABLE even when no sample ever arrived", () => {
  const r = rig();
  r.listener.stop();
  assert.equal(r.written.length, 1);
  assert.equal(latest(r).available, false);
});

// --- an undelivered witness is not a heartbeat (F2) -------------------------

test("🔴 a witness that could NOT be delivered does not refresh the clock", () => {
  // `onWitness` is a Solid setter, and it synchronously drives the chip
  // derivation, which walks the SFU's participants and publications. One throw
  // out of a half-disposed room used to refresh the clock anyway — so `tick`
  // never fired and the last green stood for the life of the call, once a
  // second, forever.
  let clock = 1_000;
  const written: DecodeWitness[] = [];
  let explode = false;
  const listener = createDecodeWitnessListener({
    now: () => clock,
    onWitness: (witness) => {
      if (explode) throw new Error("chip derivation threw");
      written.push(witness);
    },
    isCurrentSession: () => true,
    log: { warn: () => {}, info: () => {} },
  });
  listener.onMessage(sample());
  assert.equal(written.at(-1)?.available, true);

  explode = true;
  for (let beat = 0; beat < 10; beat += 1) {
    clock += DECODE_WITNESS_CHECK_MS;
    assert.throws(() => listener.onMessage(sample()));
  }

  explode = false;
  clock += 1;
  listener.tick();
  assert.equal(written.at(-1)?.available, false);
});

// --- teardown is terminal (F7) ----------------------------------------------

test("🔴 stop() is terminal: a later sample cannot promote the witness again", () => {
  // `state.tsx` removes the event listener before calling stop(), so this is
  // unreachable there today. The guarantee must not rest on one caller's
  // statement ordering.
  const r = rig();
  r.listener.onMessage(sample());
  r.listener.stop();
  r.listener.onMessage(sample());
  assert.equal(latest(r).available, false);
  assert.equal(r.written.length, 2);
});

test("🔴 stop() latches only AFTER the write actually happened", () => {
  // Latching first treats an undelivered UNAVAILABLE as delivered and leaves
  // the listener permanently inert having never written the amber it exists to
  // write — the mirror of the clock-credit defect in onMessage, introduced by
  // the very commit that fixed that one.
  const clock = 1_000;
  const written: DecodeWitness[] = [];
  let explode = true;
  const listener = createDecodeWitnessListener({
    now: () => clock,
    onWitness: (witness) => {
      if (explode) throw new Error("chip derivation threw");
      written.push(witness);
    },
    isCurrentSession: () => true,
    log: { warn: () => {}, info: () => {} },
  });

  assert.throws(() => listener.stop());
  assert.deepEqual(written, []);

  // Not latched by a write that never landed: the retry still writes amber.
  explode = false;
  listener.stop();
  assert.deepEqual(written, [{ available: false, dropping: [], live: [] }]);
});

test("🔴 stop() is idempotent, and tick() is inert after it", () => {
  const r = rig();
  r.listener.stop();
  r.listener.stop();
  r.advance(10 * DECODE_WITNESS_STALE_MS);
  r.listener.tick();
  assert.equal(r.written.length, 1);
});

// --- the skew warning names the right cause (F10) ---------------------------

test("🔴 an unreadable witness warns about SKEW, not about a missing patch", () => {
  const r = rig();
  r.listener.onMessage(sample("not-an-array"));
  assert.equal(r.warns.length, 1);
  assert.match(r.warns[0], /version skew/);
  // The staleness warning asks whether the patch is applied. That is the wrong
  // diagnosis for a worker that is present and posting once a second.
  assert.doesNotMatch(r.warns[0], /patch applied in this build/);

  // Once, not once a second.
  r.listener.onMessage(sample(7));
  assert.equal(r.warns.length, 1);
  assert.deepEqual(r.written, []);
});

test("a foreign kind does not trip the skew warning", () => {
  const r = rig();
  r.listener.onMessage({ kind: "cryptorError", data: { participants: 3 } });
  assert.deepEqual(r.warns, []);
});

test("a readable sample after a skew clears the skew warning", () => {
  const r = rig();
  r.listener.onMessage(sample("not-an-array"));
  r.listener.onMessage(sample());
  assert.equal(r.infos.length, 1);
  r.listener.onMessage(sample(null));
  assert.equal(r.warns.length, 2);
});

// --- the signal's equality (Solid SKIPS the write when this is true) --------

test("🔴 a witness that starts DROPPING a sender is not 'the same'", () => {
  // The whole hazard in one assertion. Solid skips the write when this returns
  // true, so treating this transition as equal freezes the accessor on the
  // stale clean object and the chip stays GREEN for the rest of the call while
  // the worker discards that peer's frames.
  const clean = { available: true, dropping: [], live: ["bob"] };
  const dropping = { available: true, dropping: ["bob"], live: [] };
  assert.equal(sameWitness(clean, dropping), false);
  assert.equal(sameWitness(dropping, clean), false);
});

test("🔴 losing the heartbeat is not 'the same'", () => {
  assert.equal(
    sameWitness(
      { available: true, dropping: [], live: [] },
      { available: false, dropping: [], live: [] },
    ),
    false,
  );
});

test("🔴 a DIFFERENT sender dropping is not 'the same'", () => {
  // Same length, different contents — a comparator that only checked
  // `dropping.length` would freeze the chip on the wrong peer's name.
  assert.equal(
    sameWitness(
      { available: true, dropping: ["bob"], live: [] },
      { available: true, dropping: ["carol"], live: [] },
    ),
    false,
  );
});

test("an identical report IS the same, so the chip does not re-run once a second", () => {
  // The reason the comparator exists: the worker posts a NEW object every
  // second and the chip walks every participant and every publication.
  assert.equal(
    sameWitness(
      { available: true, dropping: ["bob"], live: ["carol"] },
      { available: true, dropping: ["bob"], live: ["carol"] },
    ),
    true,
  );
});

test("`live` is deliberately NOT compared", () => {
  // Nothing reads it, and comparing it would defeat the comparator entirely.
  assert.equal(
    sameWitness(
      { available: true, dropping: [], live: ["bob"] },
      { available: true, dropping: [], live: [] },
    ),
    true,
  );
});

// --- the parser on its own --------------------------------------------------

test("parseDecodeWitnessMessage returns null for anything that is not a witness", () => {
  assert.equal(parseDecodeWitnessMessage(undefined), null);
  assert.equal(parseDecodeWitnessMessage({ kind: "other", data: {} }), null);
  assert.equal(parseDecodeWitnessMessage({ kind: DECODE_WITNESS_KIND }), null);
  assert.equal(
    parseDecodeWitnessMessage({
      kind: DECODE_WITNESS_KIND,
      data: { participants: undefined },
    }),
    null,
  );
});

test("parseDecodeWitnessMessage keeps the tallies it was given", () => {
  assert.deepEqual(parseDecodeWitnessMessage(droppingSample()), [
    {
      identity: "velvetfly",
      indexes: [{ keyIndex: 1, seen: 12, dropped: 12 }],
    },
  ]);
  assert.deepEqual(parseDecodeWitnessMessage(sample([])), []);
});
