/**
 * The READ direction of {@link PauseDisproofVerdict}: which field feeds which
 * public accessor of `Voice`.
 *
 * `state.tsx` holds ONE signal for the whole verdict and derives the two public
 * readers off it, so the alarm and its confidence are written together or not
 * at all. That much is settled. What was NOT settled is the derivation itself —
 * two one-line `createMemo` bodies in a file with no spec, no mutation entry
 * and no import that loads under `node --test`.
 *
 * 🔴 THIS IS A MEASURED DEFECT, not a hypothesis. A completion audit swapped
 * those two bodies in place and ran the whole bare gate: `tsc`, `prettier`,
 * `eslint`, the whole suite and both scripts returned exit 0, with zero failing
 * checks. In production that swap inverts exactly one of the four verdict
 * states, and it is the state this slice exists for — `{ value: true,
 * confirmed: false }`, a disproof reached off a single budget-exhausted
 * observation on a genuinely live wire — into `callPauseDisproved() === false`.
 * `VoiceCallDowngradeBanner.tsx`'s `<Show>` then takes its fallback arm and
 * goes on promising the user that their audio and video stay paused, while
 * media is on the wire. Silent false-green, in the one direction the whole
 * banner-honesty slice is about.
 *
 * So the derivation lives HERE, in a module a runner can load, where
 * `pauseVerdict.test.ts` asserts it over all four states by name and
 * `scripts/rtc-mutations.py` can re-introduce the swap and demand a red.
 *
 * 🔴 WHAT THIS DOES NOT DO, stated because the opposite claim was written into
 * this slice once and had to be removed from a plan doc and three source files:
 * it does NOT make a transposition a compile error. `disproved` and
 * `disproofConfirmed` are both `() => boolean` and `value` and `confirmed` are
 * both `boolean`, so two same-typed named fields transpose exactly as silently
 * as the two positional parameters they replaced did — measured at the producer
 * (`setPauseDisproved({ value: confirmed, confirmed: true })` compiles) and at
 * every reader alike. There is no type here doing that work, and a comment
 * claiming there is would be the same defect one level up.
 *
 * What stands in its place is `pauseVerdict.test.ts`, which asserts this
 * derivation over all four states, and a `scripts/rtc-mutations.py` entry that
 * re-plants the swap against this file and demands a red. The spec landed with
 * this module; the mutation entry is owned by whoever owns that table, and this
 * comment asserts that it is REQUIRED, not that it is present.
 *
 * 🔴 NO FRAMEWORK IMPORT, deliberately. `state.tsx` keeps the `createMemo`
 * wrapping around these two accessors: a memo's `===` equality is what gives
 * each reader the notification shape the two original separate boolean signals
 * had, so each notifies only when its OWN boolean changes. Moving the memo in
 * here would change when the banner's `<Show>` re-runs, and pulling `solid-js`
 * into this module would put it right back out of reach of `node --test`, which
 * is the entire point of the extraction.
 */
import type { PauseDisproofVerdict } from "./publishGateEpisode";

/**
 * The two public readers of `Voice`, under the names `state.tsx` binds them to:
 * `disproved` becomes `callPauseDisproved`, `disproofConfirmed` becomes
 * `callPauseDisproofConfirmed`.
 */
export interface PauseVerdictReaders {
  /** {@link PauseDisproofVerdict.value} — the one-directional alarm. */
  readonly disproved: () => boolean;
  /** {@link PauseDisproofVerdict.confirmed} — how much evidence it rests on. */
  readonly disproofConfirmed: () => boolean;
}

/**
 * Split one verdict accessor into its two field accessors, and nothing else.
 *
 * 🔴 LAZY, per accessor call. `verdict` is not read here, and neither accessor
 * caches: each reads `verdict()` afresh every time it is called. Under Solid
 * that is what makes the read a TRACKED dependency of whatever is calling —
 * `state.tsx` wraps each of these in a `createMemo`, and a value captured at
 * construction time (or memoized in here) would be read once, outside any
 * reactive scope, and never update again. The spec pins both halves.
 */
export function pauseVerdictReaders(
  verdict: () => PauseDisproofVerdict,
): PauseVerdictReaders {
  return {
    disproved: () => verdict().value,
    disproofConfirmed: () => verdict().confirmed,
  };
}
