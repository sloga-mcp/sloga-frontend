// Which field of a `PauseDisproofVerdict` feeds which public reader — the one
// derivation the banner's `<Show>` discriminator is built out of.
//
// 🔴 THIS FILE EXISTS BECAUSE THE SWAP WAS MEASURED GREEN. A completion audit
// transposed the two `createMemo` bodies in `state.tsx` and ran the full bare
// gate: `tsc`, `prettier`, `eslint`, the whole suite and both scripts exited 0
// with zero failing checks. `state.tsx` has no spec, no mutation entry and no
// import that loads under `node --test`, so nothing in the repo could pin it.
// The derivation moved to `pauseVerdict.ts` so that this file can.
//
// 🔴 WHAT IT PINS AND WHAT IT DOES NOT. It pins the READ direction and the
// laziness. It does NOT make a transposition a compile error, and nothing here
// should be read as claiming so: both fields are `boolean` and both accessors
// are `() => boolean`, so `{ disproved: () => verdict().confirmed }`
// typechecks, lints and formats exactly as cleanly as the correct body. The
// only wall is this file plus a `rtc-mutations.py` entry that re-introduces the
// swap — and that entry is owned by whoever owns that table, so read this
// sentence as the requirement it is rather than as a report that it exists.
//
// 🔴 NOT MODELLED HERE: the `createMemo` wrapping. `state.tsx` keeps it, so
// each reader still notifies only when its OWN boolean changes, and that
// notification shape is a Solid property no `node --test` spec in this package
// can observe. This file asserts the derivation and the fact that each read
// happens at CALL time — the precondition a memo needs — and claims no more.
import assert from "node:assert/strict";
import test from "node:test";

import { pauseVerdictReaders } from "./pauseVerdict.ts";
import type { PauseDisproofVerdict } from "./publishGateEpisode.ts";

// ---- The four states, by name -----------------------------------------------

/** No live disproof. Never "proven paused" — see `PauseDisproofVerdict.value`. */
const QUIET: PauseDisproofVerdict = { value: false, confirmed: false };

/**
 * 🔴 THE LOAD-BEARING ONE. A disproof reached off a SINGLE observation because
 * the confirm bound was already spent — an unconfirmed alarm on a genuinely
 * live wire. This is the state a swapped derivation inverts, and inverting it
 * leaves the downgrade banner promising a pause that is not happening.
 */
const UNCONFIRMED_DISPROOF: PauseDisproofVerdict = {
  value: true,
  confirmed: false,
};

/** A disproof that survived a confirming re-sweep: two observations, a macrotask apart. */
const CONFIRMED_DISPROOF: PauseDisproofVerdict = {
  value: true,
  confirmed: true,
};

/**
 * The fourth corner. `publishGateEpisode.ts` writes every FALSE with
 * `confirmed: false`, because there is no claim to grade — so the producer does
 * not emit this today. It is asserted anyway, unnormalized: this module's
 * obligation is to transpose NOTHING, not to re-derive the producer's rule, and
 * this corner is the second of the two states that catch a swap.
 */
const CONFIRMED_NON_DISPROOF: PauseDisproofVerdict = {
  value: false,
  confirmed: true,
};

const ALL_FOUR = [
  QUIET,
  UNCONFIRMED_DISPROOF,
  CONFIRMED_DISPROOF,
  CONFIRMED_NON_DISPROOF,
] as const;

/** Both accessors of a constant verdict, as one object to compare. */
function read(verdict: PauseDisproofVerdict) {
  const readers = pauseVerdictReaders(() => verdict);
  return {
    disproved: readers.disproved(),
    disproofConfirmed: readers.disproofConfirmed(),
  };
}

// ---- The derivation, over all four states -----------------------------------

test("QUIET — { value: false, confirmed: false } reads false / false", () => {
  assert.deepEqual(read(QUIET), {
    disproved: false,
    disproofConfirmed: false,
  });
});

test("CONFIRMED_DISPROOF — { value: true, confirmed: true } reads true / true", () => {
  assert.deepEqual(read(CONFIRMED_DISPROOF), {
    disproved: true,
    disproofConfirmed: true,
  });
});

test("🔴 UNCONFIRMED_DISPROOF — { value: true, confirmed: false } reads true / false", () => {
  // The state Control C inverted. A swapped derivation answers
  // `disproved: false` here, `VoiceCallDowngradeBanner`'s `<Show>` takes its
  // fallback arm, and the user is told their audio and video stay paused while
  // media is on the wire.
  assert.deepEqual(read(UNCONFIRMED_DISPROOF), {
    disproved: true,
    disproofConfirmed: false,
  });
});

test("CONFIRMED_NON_DISPROOF — { value: false, confirmed: true } reads false / true", () => {
  // Not a state the episode writes today. The reader still transposes nothing.
  assert.deepEqual(read(CONFIRMED_NON_DISPROOF), {
    disproved: false,
    disproofConfirmed: true,
  });
});

test("the four states above are the whole boolean square, and two of them DISCRIMINATE a transposition", () => {
  // Anti-vacuity, aimed at this file rather than at the module: a table trimmed
  // to the two SYMMETRIC states would pass every assertion above while proving
  // nothing at all about direction, because a swap is invisible on them.
  const corners = new Set(ALL_FOUR.map((v) => `${v.value}/${v.confirmed}`));
  assert.equal(
    corners.size,
    4,
    "four DISTINCT states, not four spellings of two",
  );

  const asymmetric = ALL_FOUR.filter((v) => v.value !== v.confirmed);
  assert.equal(asymmetric.length, 2, "two corners where the fields differ");
  for (const verdict of asymmetric) {
    assert.notDeepEqual(
      read(verdict),
      { disproved: verdict.confirmed, disproofConfirmed: verdict.value },
      "a swapped derivation must disagree with the real one on this state",
    );
  }
});

test("each accessor reads its OWN field and nothing else", () => {
  // Sharper than the table: the other field THROWS when touched, so a swapped
  // body cannot merely disagree, it explodes. Property getters are the only way
  // to observe which field was read.
  const valueOnly: PauseDisproofVerdict = {
    value: true,
    get confirmed(): boolean {
      throw new Error("`disproved` read `confirmed`");
    },
  };
  assert.equal(pauseVerdictReaders(() => valueOnly).disproved(), true);

  const confirmedOnly: PauseDisproofVerdict = {
    get value(): boolean {
      throw new Error("`disproofConfirmed` read `value`");
    },
    confirmed: true,
  };
  assert.equal(
    pauseVerdictReaders(() => confirmedOnly).disproofConfirmed(),
    true,
  );
});

// ---- Laziness: the precondition Solid's tracking needs ----------------------

test("the verdict is NOT read at construction", () => {
  // An eager implementation reads once, outside any reactive scope, and the
  // memos in `state.tsx` would then never see a change again — a banner frozen
  // on whatever the verdict was when the Voice was constructed, which is
  // `{ value: false, confirmed: false }`: permanently green.
  let reads = 0;
  const readers = pauseVerdictReaders(() => {
    reads++;
    throw new Error("the verdict was read at construction time");
  });
  assert.equal(reads, 0, "construction touched the verdict");
  assert.equal(typeof readers.disproved, "function");
  assert.equal(typeof readers.disproofConfirmed, "function");
});

test("each accessor reads the verdict at CALL time, once per call, with no cache", () => {
  let reads = 0;
  const readers = pauseVerdictReaders(() => {
    reads++;
    return UNCONFIRMED_DISPROOF;
  });
  assert.equal(reads, 0);
  assert.equal(readers.disproved(), true);
  assert.equal(reads, 1, "`disproved()` read the verdict exactly once");
  assert.equal(readers.disproofConfirmed(), false);
  assert.equal(
    reads,
    2,
    "`disproofConfirmed()` read it itself — no shared read",
  );
  assert.equal(readers.disproved(), true);
  assert.equal(reads, 3, "a second call reads AGAIN: nothing is memoized here");
});

test("a later verdict is the one that is read", () => {
  let current: PauseDisproofVerdict = QUIET;
  const readers = pauseVerdictReaders(() => current);
  assert.equal(readers.disproved(), false);
  assert.equal(readers.disproofConfirmed(), false);

  current = UNCONFIRMED_DISPROOF;
  assert.equal(readers.disproved(), true, "the alarm followed the verdict");
  assert.equal(readers.disproofConfirmed(), false, "and so did its confidence");

  current = CONFIRMED_DISPROOF;
  assert.equal(readers.disproved(), true);
  assert.equal(readers.disproofConfirmed(), true);
});

test("the readers object exposes exactly the two accessors", () => {
  // `state.tsx` binds these two names onto `Voice`; a rename here is a silently
  // `undefined` reader there, and `callPauseDisproved()` would throw rather
  // than lie — but only at render time, in a build nobody ran a spec against.
  const readers = pauseVerdictReaders(() => QUIET);
  assert.deepEqual(Object.keys(readers).sort(), [
    "disproofConfirmed",
    "disproved",
  ]);
});
