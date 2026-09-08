#!/usr/bin/env python3
"""Mutation-verify the RTC/MLS specs.

    packages/client/scripts/rtc-mutations.py [--list] [--only ID[,ID...]]

A green suite is weak evidence on this branch: five of the six defects six
`media-e2ee-reviewer` rounds found passed a green gate, and three of them were
introduced by the previous round's own fix. The specs' job is to stop a FIXED
defect coming back, and this list is the only evidence they can do it.

Each mutation re-introduces exactly one reviewed failure mode by an EXACT
string replacement in a source file, runs the spec files that should catch it,
and reverts. A mutation whose search string is not found is a HARD ERROR, not a
skip: a mutation that silently fails to apply leaves the suite green and reads
as "uncaught", which is the same silent pass `rtc-gate.sh` exists to kill.

Judged on the runner's OWN exit status — never a grep of its summary, never
through a pipe (`cmd | tail` makes `$?` tail's).

Exit 0 iff every mutation marked `expect="red"` turned its specs red and every
mutation marked `expect="green"` left them green.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

CLIENT = Path(__file__).resolve().parent.parent
RTC = CLIENT / "components" / "rtc"
NODE = "node"

SESSION = "mlsCallSession.ts"
POLICY = "mlsCallModePolicy.ts"
HARNESS = "mlsCallSession.harness.ts"
STATE = "state.tsx"
WITNESS = "decodeWitnessListener.ts"

JOINRACE_SPEC = "components/rtc/mlsCallSession.joinrace.test.ts"
HEAL_SPEC = "components/rtc/mlsCallSession.heal.test.ts"
POLICY_SPEC = "components/rtc/mlsCallModePolicy.test.ts"
WITNESS_SPEC = "components/rtc/decodeWitnessListener.test.ts"
ALL_SPECS = [POLICY_SPEC, HEAL_SPEC, JOINRACE_SPEC]


@dataclass
class Mutation:
    id: str
    """The reviewed failure mode this re-introduces."""
    what: str
    file: str
    search: str
    replace: str
    specs: list[str] = field(default_factory=lambda: list(ALL_SPECS))
    #: "red"   — the specs MUST fail (the defect is caught)
    #: "green" — the specs must still pass (a deliberate non-assertion, with a
    #:           reason: the mutation is a UX/behaviour choice, not a posture)
    expect: str = "red"
    why_green: str = ""


MUTATIONS: list[Mutation] = []


def run_specs(specs: list[str]) -> bool:
    """True when every named spec file passes. The runner's OWN exit status."""
    for spec in specs:
        proc = subprocess.run(
            [NODE, "--test", "--conditions=browser", spec],
            cwd=CLIENT,
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            return False
    return True


def apply(mutation: Mutation) -> str:
    path = RTC / mutation.file
    original = path.read_text(encoding="utf-8")
    count = original.count(mutation.search)
    if count == 0:
        raise SystemExit(
            f"MUTATION {mutation.id}: search string not found in "
            f"{mutation.file} — refusing to report a result.\n"
            f"  looked for: {mutation.search!r}"
        )
    if count > 1:
        raise SystemExit(
            f"MUTATION {mutation.id}: search string is ambiguous "
            f"({count} matches) in {mutation.file} — refusing to guess."
        )
    path.write_text(
        original.replace(mutation.search, mutation.replace), encoding="utf-8"
    )
    return original


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--only", default="")
    args = ap.parse_args()

    if args.list:
        for m in MUTATIONS:
            print(f"{m.id:<28} [{m.expect:>5}] {m.what}")
        return 0

    wanted = {s for s in args.only.split(",") if s}
    selected = [m for m in MUTATIONS if not wanted or m.id in wanted]
    if wanted:
        missing = wanted - {m.id for m in selected}
        if missing:
            raise SystemExit(f"no such mutation(s): {', '.join(sorted(missing))}")
    if not selected:
        raise SystemExit("no mutations selected — refusing to report a pass")

    failures: list[str] = []
    for i, m in enumerate(selected, 1):
        print(f"=============== [{i}/{len(selected)}] {m.id} ===============")
        print(f"    {m.what}")
        path = RTC / m.file
        original = apply(m)
        try:
            passed = run_specs(m.specs)
        finally:
            path.write_text(original, encoding="utf-8")
        got = "green" if passed else "red"
        ok = got == m.expect
        print(f">>> {'OK  ' if ok else 'FAIL'}: expected {m.expect}, specs went {got}")
        if not ok:
            failures.append(m.id)

    print()
    print(f"################ MUTATIONS: {len(selected)} run, "
          f"{len(failures)} unexpected ################")
    for f in failures:
        print(f"    unexpected: {f}")
    return 1 if failures else 0


# --- The reviewed failure modes, one mutation each ---------------------------
#
# Each entry re-introduces exactly one defect a `media-e2ee-reviewer` round
# found on `fix/mls-joinrace-window` or on this branch. `expect="red"` means the
# specs MUST catch it.

MUTATIONS += [
    # ---- the deferred verdict itself ---------------------------------------
    Mutation(
        id="no-deferral",
        what="a decode missing key during an observed membership change is not held at all",
        file=SESSION,
        search="""    if (
      cls.kind === "missing_key" &&
      (this.#rotationWindow || this.#membershipChangeObserved())
    ) {""",
        replace="""    if (
      false &&
      (this.#rotationWindow || this.#membershipChangeObserved())
    ) {""",
    ),
    Mutation(
        id="rotation-arm-shadows-hold",
        what="a missing key INSIDE a rotation window takes the cancellable escalation instead of the hold",
        file=SESSION,
        search="""      cls.kind === "missing_key" &&
      (this.#rotationWindow || this.#membershipChangeObserved())""",
        replace="""      cls.kind === "missing_key" &&
      !this.#rotationWindow &&
      (this.#rotationWindow || this.#membershipChangeObserved())""",
    ),
    Mutation(
        id="advance-without-fill-resolves",
        what="the hold resolves on an install that ADVANCED past the index without FILLING it",
        file=SESSION,
        search="""        if (
          this.#mediaErrors.pairFilledAtSeq(hold.identity, pair) !== undefined
        ) {""",
        replace="""        if (!this.#mediaErrors.uncoveredPairs().includes(pair)) {""",
    ),
    Mutation(
        id="refreshing-deadline",
        what="a second error for the same pair walks the hold's bound forward",
        file=SESSION,
        search="""    if (this.#joinRaceHolds.has(pair)) return true; // the first deadline stands""",
        replace="""    const open = this.#joinRaceHolds.get(pair);
    if (open) {
      this.#cancelHoldTimer(open);
      open.remainingMs = JOIN_RACE_DEFER_MS;
      open.armedAt = performance.now();
      open.timer = this.#armHoldDeadline(pair, error, JOIN_RACE_DEFER_MS);
      return true;
    }""",
    ),
    Mutation(
        id="rearm-takes-fresh-bound",
        what="a suspended hold re-arms with a FRESH bound instead of its banked budget",
        file=SESSION,
        search="""          hold.timer = this.#armHoldDeadline(
            pair,
            hold.error,
            hold.remainingMs,
          );""",
        replace="""          hold.timer = this.#armHoldDeadline(
            pair,
            hold.error,
            JOIN_RACE_DEFER_MS,
          );""",
    ),
    Mutation(
        id="roster-resolve-without-sfu-conjunct",
        what="a sender out of the GROUP but still SFU-present and publishing resolves the hold",
        file=SESSION,
        search="""        if (
          readable &&
          !present.has(hold.identity) &&
          this.#lastRosterIdentities.size > 0 &&""",
        replace="""        if (
          readable &&
          this.#lastRosterIdentities.size > 0 &&""",
    ),
    # ---- the amber the deferral rests on ------------------------------------
    Mutation(
        id="amber-never-surfaced",
        what="an open join-race hold does not drive the chip amber",
        file=SESSION,
        search="""    const active = this.#joinRaceHolds.size > 0 || this.#resecure.size > 0;""",
        replace="""    const active = this.#resecure.size > 0;""",
    ),
    Mutation(
        id="amber-dropped-before-loud",
        what="the amber is dropped BEFORE the loud is reported, so the chip computes a green in between",
        file=SESSION,
        search="""    this.#media?.onEncryptionState?.("loud", error);
    // The strictest reading has now been taken about the MEDIA plane, so""",
        replace="""    this.#clearJoinRaceHolds();
    this.#media?.onEncryptionState?.("loud", error);
    // The strictest reading has now been taken about the MEDIA plane, so""",
    ),
    # ---- who may cancel what ------------------------------------------------
    Mutation(
        id="recovery-echo-cancels-hold",
        what="an SFU-declared encryption status cancels an open join-race hold",
        file=SESSION,
        search="""    if (!this.#hasLocalKey) return;
    // ...and a MEDIA-plane escalation is not this signal's to cancel at all.""",
        replace="""    if (!this.#hasLocalKey) return;
    this.#clearJoinRaceHolds();
    // ...and a MEDIA-plane escalation is not this signal's to cancel at all.""",
    ),
    Mutation(
        id="recovery-echo-force-clears",
        what="an SFU-declared encryption status force-clears every pending escalation",
        file=SESSION,
        search="""    if (!this.#hasLocalKey) return;
    // ...and a MEDIA-plane escalation is not this signal's to cancel at all.""",
        replace="""    if (!this.#hasLocalKey) return;
    this.#clearResecureTimer();
    // ...and a MEDIA-plane escalation is not this signal's to cancel at all.""",
    ),
    Mutation(
        id="token-blind-clear",
        what="#clearResecureTimer ignores the cancel token and clears every reason",
        file=SESSION,
        search="""      reason !== undefined ? [reason] : [...this.#resecure.keys()];""",
        replace="""      [...this.#resecure.keys()];""",
    ),
    Mutation(
        id="latch-force-clears-control",
        what="a media loud latch subsumes the control seam's escalation",
        file=SESSION,
        search="""    this.#clearResecureTimer("joiner");
    this.#clearResecureTimer("media");""",
        replace="""    this.#clearResecureTimer();""",
    ),
    Mutation(
        id="unscoped-joiner-clear",
        what="our own first key clears every escalation, not just the joiner one",
        file=SESSION,
        search="""    this.#clearResecureTimer("joiner");
    // ...and the errors it covered are re-judged now that we hold keys.""",
        replace="""    this.#clearResecureTimer();
    // ...and the errors it covered are re-judged now that we hold keys.""",
    ),
    # ---- the heal's witnesses ----------------------------------------------
    Mutation(
        id="heal-accepts-pre-latch-fill",
        what="the heal's refilled-pair witness asks whether the pair was EVER pushed, not pushed since the latch",
        file=SESSION,
        search="""        ) ?? -1) > this.#loudLatchedInstallSeq &&""",
        replace="""        ) ?? -1) >= 0 &&""",
    ),
    Mutation(
        id="heal-clause-jumps-empty-witness-hold",
        what="the refilled-pair clause runs IN FRONT of the empty-witness hold",
        file=POLICY,
        search="""  if (inputs.peers.length === 0) return "hold";
  if (inputs.unfilledElsewhere) return "hold";
  // Behind the empty-witness hold, never in front of it.
  if (inputs.originatingPairRefilled) return "heal";""",
        replace="""  if (inputs.originatingPairRefilled) return "heal";
  if (inputs.peers.length === 0) return "hold";
  if (inputs.unfilledElsewhere) return "hold";""",
    ),
    Mutation(
        id="heal-ignores-other-unfilled",
        what="the heal ignores an index a DIFFERENT present sender was silenced at",
        file=POLICY,
        search="""  if (inputs.unfilledElsewhere) return "hold";
  // Behind the empty-witness hold, never in front of it.""",
        replace="""  // Behind the empty-witness hold, never in front of it.""",
    ),
    Mutation(
        id="unfilled-counts-pre-first-key",
        what="unfilledPairs counts pairs heard before this device held any key of the group",
        file=POLICY,
        search="""      .filter(([pair, beforeFirstKey]) => !beforeFirstKey && !filled?.has(pair))""",
        replace="""      .filter(([pair]) => !filled?.has(pair))""",
    ),
    Mutation(
        id="first-fill-only-install-stamp",
        what="noteInstalled records only a pair's FIRST fill, so the bystander heal expires at the ring wrap",
        file=POLICY,
        search="""        if (!rec.pairs.has(pair)) advanced = true;
        rec.pairs.set(pair, installSeq);""",
        replace="""        if (!rec.pairs.has(pair)) {
          advanced = true;
          rec.pairs.set(pair, installSeq);
        }""",
    ),
]

# --- Gate (d): the decode witness -------------------------------------------

MUTATIONS += [
    Mutation(
        id="gate-d-removed",
        what="chipState ignores the decode witness entirely (green by default again)",
        file=POLICY,
        search="""  if (
    !mediaObserved ||
    !inputs.localPublicationsEncrypted ||
    !decodeWitnessed
  ) {""",
        replace="""  if (!mediaObserved || !inputs.localPublicationsEncrypted) {""",
    ),
    Mutation(
        id="witness-unavailable-is-green",
        what="a missing worker heartbeat is treated as a witness that passed",
        file=POLICY,
        search="""  const decodeWitnessed =
    inputs.decodeWitness.available &&
    inputs.decodeWitness.dropping.length === 0;""",
        replace="""  const decodeWitnessed =
    !inputs.decodeWitness.available ||
    inputs.decodeWitness.dropping.length === 0;""",
    ),
    Mutation(
        id="dropping-ignored",
        what="the gate checks only that a sample arrived, not what it said",
        file=POLICY,
        search="""  const decodeWitnessed =
    inputs.decodeWitness.available &&
    inputs.decodeWitness.dropping.length === 0;""",
        replace="""  const decodeWitnessed = inputs.decodeWitness.available;""",
    ),
    Mutation(
        id="summarize-ignores-drops",
        what="summarizeDecodeWitness never reports a sender as dropping",
        file=POLICY,
        search="""      if (tally.dropped > 0) drop = true;""",
        replace="""      if (tally.dropped < 0) drop = true;""",
    ),
    Mutation(
        id="live-excuses-drop",
        what="a sender with ANY index getting through is excused its dropped one",
        file=POLICY,
        search="""    if (drop) dropping.push(participant.identity);
    if (ok) live.push(participant.identity);""",
        replace="""    if (drop && !ok) dropping.push(participant.identity);
    if (ok) live.push(participant.identity);""",
    ),
    Mutation(
        id="witness-arms-a-verdict",
        what="gate (d) is allowed to produce a red instead of only withholding green",
        file=POLICY,
        search="""  const decodeWitnessed =
    inputs.decodeWitness.available &&
    inputs.decodeWitness.dropping.length === 0;""",
        replace="""  const decodeWitnessed =
    inputs.decodeWitness.available &&
    inputs.decodeWitness.dropping.length === 0;
  if (inputs.decodeWitness.dropping.length > 0) return "not_encrypted";""",
    ),
]

# --- Gate (d): the listener that FEEDS the witness ---------------------------
#
# Everything above mutates the POLICY that reads the witness. These mutate the
# listener that produces it, and they exist because a `media-e2ee-reviewer`
# round found the producer unreachable: it lived in `state.tsx`, which has no
# spec file and which `node --test` cannot load, so the listener, the staleness
# path and the signal's initial value were all unmutated. Flipping the initial
# value to an AVAILABLE witness restored green-by-default — the exact posture
# gate (d) exists to remove — with all 13 spec files green and all 24 mutations
# still red. Each of these re-introduces one of the holes that hid there.
#
# Scoped to WITNESS_SPEC on purpose: it is the only spec that loads this
# module, so running the others would be time spent proving nothing.

MUTATIONS += [
    Mutation(
        id="witness-initial-available",
        what="the chip's witness signal starts AVAILABLE, so a call that never armed the witness reads green",
        file=WITNESS,
        search="""export const DECODE_WITNESS_INITIAL: DecodeWitness = DECODE_WITNESS_UNAVAILABLE;""",
        replace="""export const DECODE_WITNESS_INITIAL: DecodeWitness = {
  available: true,
  dropping: [],
  live: [],
};""",
        specs=[WITNESS_SPEC],
    ),
    Mutation(
        id="witness-never-goes-stale",
        what="the staleness comparison has its operands the wrong way round, so the witness never expires",
        file=WITNESS,
        search="""      if (now() - lastAt <= staleMs) return;""",
        replace="""      if (lastAt - now() <= staleMs) return;""",
        specs=[WITNESS_SPEC],
    ),
    Mutation(
        id="witness-stale-threshold-widened",
        what="the staleness threshold is a hundred times the three-beat bound, so a dead worker holds its green for minutes",
        file=WITNESS,
        search="""export const DECODE_WITNESS_STALE_MS = 3 * DECODE_WITNESS_CHECK_MS;""",
        replace="""export const DECODE_WITNESS_STALE_MS = 300 * DECODE_WITNESS_CHECK_MS;""",
        specs=[WITNESS_SPEC],
    ),
    Mutation(
        id="witness-teardown-keeps-standing",
        what="teardown leaves the last sample standing instead of writing UNAVAILABLE",
        file=WITNESS,
        search="""      // The listener is being detached, so no further sample can arrive and
      // the last one must not keep standing as live evidence.
      onWitness(DECODE_WITNESS_UNAVAILABLE);""",
        replace="""      // The listener is being detached, so no further sample can arrive and
      // the last one must not keep standing as live evidence.""",
        specs=[WITNESS_SPEC],
    ),
    Mutation(
        id="witness-kind-guard-presence-only",
        what="the message-kind guard checks that a kind is PRESENT, not that it is ours — livekit's own worker posts are read as witnesses",
        file=WITNESS,
        search="""  if (data.kind !== DECODE_WITNESS_KIND) return null;""",
        replace="""  if (data.kind === undefined) return null;""",
        specs=[WITNESS_SPEC],
    ),
    Mutation(
        id="witness-malformed-promotes",
        what="a malformed sample is coerced to an EMPTY window, and summarizing an empty window returns available:true",
        file=WITNESS,
        search="""  if (!Array.isArray(participants)) return null;""",
        replace="""  if (!Array.isArray(participants)) return [];""",
        specs=[WITNESS_SPEC],
    ),
    Mutation(
        id="witness-session-guard-removed",
        what="a disposed session's queued post writes the newer call's witness",
        file=WITNESS,
        search="""      if (!isCurrentSession()) return;""",
        replace="""      isCurrentSession();""",
        specs=[WITNESS_SPEC],
    ),
]


if __name__ == "__main__":
    sys.exit(main())
