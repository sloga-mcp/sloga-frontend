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
GATE = "publishGate.ts"

JOINRACE_SPEC = "components/rtc/mlsCallSession.joinrace.test.ts"
HEAL_SPEC = "components/rtc/mlsCallSession.heal.test.ts"
POLICY_SPEC = "components/rtc/mlsCallModePolicy.test.ts"
FALSERED_SPEC = "components/rtc/mlsCallSession.falsered.test.ts"
GATE_SPEC = "components/rtc/publishGate.test.ts"
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

# --- The false-red / false-pause fix (join-race legs, 2026-09-08) ------------
#
# `publishGate.ts` + `mlsCallSession.falsered.test.ts`. The first three are the
# defect itself and its two nearest wrong fixes; the rest pin the session-level
# invariant "the ME-10 banner renders only over a held gate" and the harness
# fidelity the invariant rests on.

MUTATIONS += [
    Mutation(
        id="gate-trusts-stale-pause-flag",
        what="the sweep trusts livekit's isUpstreamPaused over a rebuilt sender (the defect)",
        file=GATE,
        search="""  return inputs.senderRebuilt ? "repause" : "none";""",
        replace="""  return "none";""",
        specs=[GATE_SPEC],
    ),
    Mutation(
        id="repause-sweeps-untouched-publications",
        what="every paused publication takes the resume-first repause, not just the rebuilt one",
        file=GATE,
        search="""  if (!inputs.upstreamPaused) return "pause";
  return inputs.senderRebuilt ? "repause" : "none";""",
        replace="""  if (!inputs.upstreamPaused) return "pause";
  return "repause";""",
        specs=[GATE_SPEC],
    ),
    Mutation(
        id="held-gate-resumes",
        what="the gate's sense is inverted — a held gate resumes publishing",
        file=GATE,
        search="""  if (!inputs.gateHeld) return "resume";""",
        replace="""  if (inputs.gateHeld) return "resume";""",
        specs=[GATE_SPEC],
    ),
    Mutation(
        id="latch-skips-the-negotiating-fold",
        what="a loud verdict after the mode reached e2ee never folds back to negotiating, so the banner promises a pause over an empty gate",
        file=SESSION,
        search="""    const fallback = loudModeFallback(this.#callMode);
    if (fallback) this.#setModeChained(fallback);""",
        replace="""    const fallback = loudModeFallback(this.#callMode);
    if (false && fallback) this.#setModeChained(fallback!);""",
        specs=[FALSERED_SPEC],
    ),
    Mutation(
        id="setmode-lockstep-drops-the-pause",
        what="#setMode stops re-asserting the negotiating gate when the mode drops back",
        file=SESSION,
        search="""    if (mode.kind === "negotiating" && !wasNegotiating) {
      void this.#media?.pausePublishing?.("negotiating");""",
        replace="""    if (false && mode.kind === "negotiating" && !wasNegotiating) {
      void this.#media?.pausePublishing?.("negotiating");""",
        specs=[FALSERED_SPEC],
    ),
    Mutation(
        id="fold-lands-after-the-mixed-release",
        what="the T2 warm resume releases `mixed` before the fold asserts `negotiating`, emptying the gate for a microtask",
        file=SESSION,
        search="""    if (next.kind === "negotiating" && this.#callMode.kind !== "negotiating") {
      this.#setMode(next);
    }""",
        replace="""    if (false && next.kind === "negotiating") {
      this.#setMode(next);
    }""",
        specs=[FALSERED_SPEC],
    ),
    Mutation(
        id="harness-gate-unseeded",
        what="the harness starts with an EMPTY gate, so every pre-verdict pause assertion is vacuous",
        file=HARNESS,
        search="""  gate = new Set<PublishGateReason>(["negotiating"]);""",
        replace="""  gate = new Set<PublishGateReason>();""",
        specs=[FALSERED_SPEC],
    ),
    Mutation(
        id="wiring-drops-the-rebuilt-track",
        what="state.tsx stops naming the rebuilt publication, so the sweep is bare again",
        file=STATE,
        search="""      if (this.#publishGate.size > 0)
        void this.#applyPublishGate(room, pub.track);""",
        replace="""      if (this.#publishGate.size > 0) void this.#applyPublishGate(room);""",
        specs=[GATE_SPEC, FALSERED_SPEC],
        expect="green",
        why_green=(
            "state.tsx has no spec harness — the session specs replace the whole "
            "media binding, and `publishGate.ts` is reached only through it. So the "
            "DECISION is covered and the WIRING is not: which call site names the "
            "rebuilt publication is verified by reading it against the pinned "
            "livekit-client 2.15.13 source, and would otherwise need a live leg. "
            "Recorded rather than hidden: this is the one un-asserted seam in the fix."
        ),
    ),
]


if __name__ == "__main__":
    sys.exit(main())
