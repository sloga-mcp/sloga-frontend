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
#: No entry targets `state.tsx` any more — wave 1 moved everything a mutation
#: could reach into `publishGateEpisode.ts`. What is LEFT in `state.tsx` is
#: WIRING, and it is still unreachable here: that `beginDrive` is passed as
#: `coalescingSweeper`'s FOURTH positional argument (a three-argument call
#: still compiles and silently degrades drive scope to no scope), that the
#: `EpisodeDeps` thunks are bound to the right room, and that `scheduleConfirm`
#: is a `setTimeout` rather than a microtask. A mutation cannot reach any of
#: it, because `node --test` cannot import the file. Recorded here rather than
#: as an `expect="green"` entry, which would be an admission dressed as a
#: measurement.
#:
#: 🔴 ZERO entries carry `file=STATE`, and the wave-1 fix round ADDED to what
#: that leaves unmeasured. `#gateGen` plus the per-sweeper `stillCurrent`
#: closure (`gen === this.#gateGen && this.room() === room`, captured when the
#: sweeper is BUILT) is now the only thing keeping a sweep parked on an awaited
#: livekit op from spending publications in the NEXT call's episode. The
#: `publishGateEpisode.ts` specs pin what the episode DOES when `stillCurrent()`
#: answers false; nothing pins that the closure ANSWERS false for a disposed
#: sweeper, and nothing in this table can. Do not paper over it with a
#: source-text assertion: a `grep -qF` over a file no runner can load does not
#: converge — one comment line defeats it. Closing this needs a further
#: extraction or a live leg, not another entry here.
STATE = "state.tsx"
GATE = "publishGate.ts"
EPISODE = "publishGateEpisode.ts"

JOINRACE_SPEC = "components/rtc/mlsCallSession.joinrace.test.ts"
HEAL_SPEC = "components/rtc/mlsCallSession.heal.test.ts"
POLICY_SPEC = "components/rtc/mlsCallModePolicy.test.ts"
FALSERED_SPEC = "components/rtc/mlsCallSession.falsered.test.ts"
GATE_SPEC = "components/rtc/publishGate.test.ts"
EPISODE_SPEC = "components/rtc/publishGateEpisode.test.ts"
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


# A mutant that HANGS is not a result. `node --test`'s own `--test-timeout`
# cannot fire on a loop that never yields to the event loop (a runaway
# `while`/`do-while` over awaited microtasks), so the only reliable bound is
# wall-clock on the process. Sized well above the slowest honest spec file —
# measured 2026-09-09: `mlsCallSession.joinrace.test.ts` at 1.7 s wall, next
# falsered 1.0 s — and well below anything a human would sit through. The whole
# suite is ~55 s. Keep these numbers honest: a stale runtime estimate is how a
# suite stops getting run (an earlier version of this comment guessed 15 s and
# "20+ minutes", both wrong by an order of magnitude).
SPEC_TIMEOUT_S = 120


def run_specs(specs: list[str]) -> bool:
    """True when every named spec file passes. The runner's OWN exit status.

    A timeout counts as FAILING, deliberately: under a mutation a hang means the
    mutant broke termination, which is a defect the specs caught; on a clean
    tree it means something is wrong that must not be reported as a pass.
    """
    for spec in specs:
        try:
            proc = subprocess.run(
                [NODE, "--test", "--conditions=browser", spec],
                cwd=CLIENT,
                capture_output=True,
                text=True,
                timeout=SPEC_TIMEOUT_S,
            )
        except subprocess.TimeoutExpired:
            print(f"    (spec {spec} timed out after {SPEC_TIMEOUT_S}s)")
            return False
        if proc.returncode != 0:
            return False
    return True


def baseline_green(mutations: list[Mutation]) -> bool:
    """Every spec file any mutation relies on must pass on the UNMUTATED tree.

    Without this the run is vacuous in the dangerous direction: EVERY mutation
    expects RED, so a spec set already failing — for a reason having nothing to
    do with any mutation — makes every one of them report OK and the run prints
    "N run, 0 unexpected". Same silent-pass class `rtc-gate.sh` exists to kill.

    This used to lean partly on the one `expect="green"` entry as a canary.
    There is no green entry any more (wave 1 flipped the last one), so this
    function is now the ONLY thing standing between a broken spec file and a
    completely vacuous green run. Do not weaken it.
    """
    specs = sorted({spec for m in mutations for spec in m.specs})
    print(f"=============== baseline: {len(specs)} spec file(s) ===============")
    for spec in specs:
        if not run_specs([spec]):
            print(f">>> BASELINE FAIL: {spec} is not green before any mutation")
            return False
    print(">>> BASELINE OK: every spec green on the unmutated tree")
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

    if not baseline_green(selected):
        print("################ MUTATIONS: refusing to run ################")
        return 97

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
# `publishGate.ts` + `mlsCallSession.falsered.test.ts`. Group 1 is the pure
# decision, group 2 the sweep BODY (reachable as mutations only because the
# executor is injectable — `publishGate.test.ts` drives the real one against a
# fake of livekit's bookkeeping, including the DEFERRED `sender.track` write and
# the per-track FIFO mutex, rather than re-implementing the mapping), group 3 the
# session-level invariant and the loud's own reachability.

MUTATIONS += [
    # ---- the decision ------------------------------------------------------
    Mutation(
        id="gate-trusts-a-quiet-wire-under-a-cleared-flag",
        what="a detached sender is called proven quiet even with livekit's flag CLEARED — i.e. mid-attach (the fail-open the two-valued observable had)",
        file=GATE,
        search="""  return inputs.upstreamPaused ? "none" : "pause";""",
        replace="""  return "none";""",
        specs=[GATE_SPEC],
    ),
    Mutation(
        id="gate-trusts-stale-pause-flag",
        what="a live sender whose pause FLAG says paused takes a bare pause, which early-returns (the original defect)",
        file=GATE,
        search="""    return inputs.upstreamPaused ? "repause" : "pause";""",
        replace="""    return "pause";""",
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
        id="gate-pause-spams-an-unpublished-track",
        what="a publication with no sender is pause-called on every sweep, spamming livekit's unpublished-track warning",
        file=GATE,
        search="""  if (inputs.upstream === "unpublished") return "none";""",
        replace="""  if (inputs.upstream === "unpublished") return "pause";""",
        specs=[GATE_SPEC],
    ),
    # ---- the sweep body ----------------------------------------------------
    Mutation(
        id="repause-order-inverted",
        what="repause resumes twice instead of resume-then-pause, leaving the sender live",
        file=GATE,
        # Retargeted 2026-09-09 (wave 1): the repause arm's detach is now a
        # named promise with its own two catches, so the old
        # `await publication.pauseUpstream();` line no longer exists. Same
        # site, same defect — `detaching` is now fed by a RESUME.
        search="""        detaching = publication.pauseUpstream();""",
        replace="""        detaching = publication.resumeUpstream();""",
        specs=[GATE_SPEC],
    ),
    Mutation(
        id="repause-drops-the-gate-recheck",
        what="repause pauses even after the gate emptied, muting a healthy call with nothing left to resume it",
        file=GATE,
        # Retargeted 2026-09-09 (wave 1). `if (!gateHeld()) return null;` now
        # occurs twice in the file, so it cannot anchor on its own; the
        # comment banner immediately below it is the unique discriminator and
        # is itself load-bearing prose about this exact re-check.
        search="""        if (!gateHeld()) return null;
        // \U0001f534 THE ONE SITE""",
        replace="""        // \U0001f534 THE ONE SITE""",
        specs=[GATE_SPEC],
    ),
    Mutation(
        id="sweep-swallows-a-failed-pause",
        what="the outer catch discards a read that threw, so a publication nothing could observe is reported as swept",
        file=GATE,
        # Retargeted 2026-09-09 (wave 1) at the SAME site — runOne's outer
        # catch — whose return grew the `issued` / `unreadable` fields. The
        # `what` is narrowed to match what wave 0 left reaching this catch:
        # both pausing arms now catch their own detach, so a failed pause no
        # longer lands here. Discarding it is still the same fail-open shape
        # (a publication that could not be observed reported as fine).
        search="""    return {
      kind: "unproven",
      name: publication.name,
      op,
      issued,
      unreadable: true,
    };
  }
}""",
        replace="""    return null;
  }
}""",
        specs=[GATE_SPEC],
    ),
    Mutation(
        id="sweep-skips-the-post-condition",
        what="the sweep reports success without re-reading the wire",
        file=GATE,
        # Retargeted 2026-09-09 (wave 1): the unproven return grew `issued`.
        search="""    if (publication.upstream() !== "live") {
      return { kind: "proven", name: publication.name, op };
    }
    return { kind: "unproven", name: publication.name, op, issued };""",
        replace="""    return null;""",
        specs=[GATE_SPEC],
    ),
    Mutation(
        id="sweep-awaits-inside-its-loop",
        what="ops are no longer all issued before the first await, so livekit's FIFO lock no longer reflects issue order",
        file=GATE,
        search="""    pending.push(
      runOne(
        publication,
        held,""",
        replace="""    await Promise.resolve();
    pending.push(
      runOne(
        publication,
        held,""",
        specs=[GATE_SPEC],
    ),
    Mutation(
        id="resume-failure-folded-into-unproven",
        what="a resume that threw is reported as an unproven PAUSE, so a caller acting only on a held gate discards it — silently muted, no telemetry",
        file=GATE,
        search="""        try {
          await publication.resumeUpstream();
        } catch {
          return { kind: "failed", name: publication.name, op };
        }
        if (gateHeld()) return null; // the gate refilled under us
        // `unpublished` is not a failure: there is nothing to put back.
        return publication.upstream() === "quiet"
          ? { kind: "failed", name: publication.name, op }
          : null;""",
        replace="""        await publication.resumeUpstream();
        return null;""",
        specs=[GATE_SPEC],
    ),
    # ---- the live-lock bound (fourth review) -------------------------------
    Mutation(
        id="sweeper-nests-on-re-entry",
        what="the coalescing sweeper assigns its promise AFTER starting the run, so a re-entrant trigger sees no sweep in flight and starts its own — 3060 nested passes in 28 ms when this was first written",
        file=GATE,
        search="""      let settle!: () => void;
      let fail!: (error: unknown) => void;
      const done = new Promise<void>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      });
      active = done;
      drive().then(settle, fail);
      return done;""",
        replace="""      active = drive();
      return active;""",
        specs=[GATE_SPEC],
    ),
    Mutation(
        id="sweeper-pass-cap-removed",
        what="a run whose every pass re-triggers is unbounded",
        file=GATE,
        search="""      } while (pending && --budget > 0);""",
        replace="""      } while (pending);""",
        specs=[GATE_SPEC],
    ),
    Mutation(
        id="spent-repause-retried-forever",
        what="a repause that already failed is attempted again on every pass, re-attaching the sender each time — the live-lock's energy source",
        file=GATE,
        search="""        if (repauseSpent) break;""",
        replace="""        if (false && repauseSpent) break;""",
        specs=[GATE_SPEC],
    ),
    # ---- what may spend a publication, and what may cancel a sweep --------
    Mutation(
        id="any-unproven-spends-the-publication",
        what="a plain failed PAUSE lands in repauseFailed, so a publication the gate must keep sweeping is suppressed for the rest of the drive",
        file=GATE,
        # Retargeted 2026-09-09 (wave 1): the filter grew the `issued` and
        # `unreadable` conjuncts, and `repauseFailed` now feeds the
        # DRIVE-scoped `repausePending` rather than the permanent spend. The
        # permanent spend moved to `repauseThrew`, which is the entry below.
        search="""    repauseFailed: settled
      .filter(
        (r) =>
          r?.kind === "unproven" &&
          r.op === "repause" &&
          r.issued === true &&
          r.unreadable !== true,
      )
      .map((r) => r!.name),""",
        replace="""    repauseFailed: named("unproven"),""",
        specs=[GATE_SPEC],
    ),
    Mutation(
        id="any-unproven-threw-spends-the-publication",
        what="a plain failed PAUSE marks the publication SPENT — a permanent per-episode disarm — so the gate never touches it again this episode: the 2026-09-08 defect re-armed at its new site",
        file=GATE,
        # New 2026-09-09 (wave 1). `repauseThrew` is the sole input to the
        # PERMANENT spend, so this — not `repauseFailed` above — is where the
        # 2026-09-08 fail-open now lives. Loosening the filter to "any
        # unproven" is exactly the "any op that threw" loosening the module
        # comment names as the invariant that must not be relaxed.
        search="""    repauseThrew: settled
      .filter(
        (r) =>
          r?.kind === "unproven" &&
          r.op === "repause" &&
          r.issued === true &&
          r.threw === true,
      )
      .map((r) => r!.name),""",
        replace="""    repauseThrew: named("unproven"),""",
        specs=[GATE_SPEC],
    ),
    Mutation(
        id="held-gate-proves-nothing",
        what="a held-gate sweep stops reporting what it observed quiet, so a spent publication can never be un-spent",
        file=GATE,
        search="""    if (publication.upstream() !== "live") {
      return { kind: "proven", name: publication.name, op };
    }""",
        replace="""    if (publication.upstream() !== "live") return null;""",
        specs=[GATE_SPEC],
    ),
    Mutation(
        id="pre-read-outside-the-try",
        what="the publication's state is read before runOne's try, so one torn-down track rejects the whole sweep and every other publication goes unswept",
        file=GATE,
        search="""  let op: PublishGateOp = "none";
  try {
    op = publishGateOp({
      gateHeld: held,
      upstreamPaused: publication.upstreamPaused,
      upstream: publication.upstream(),
    });""",
        replace="""  const op: PublishGateOp = publishGateOp({
    gateHeld: held,
    upstreamPaused: publication.upstreamPaused,
    upstream: publication.upstream(),
  });
  try {""",
        specs=[GATE_SPEC],
    ),
    Mutation(
        id="drive-start-outside-the-try",
        what="`onDriveStart` runs before the drive's try, so a hook that throws leaves `active` set forever and every later sweep returns a promise that never settles — the gate stops sweeping and nothing says so",
        file=GATE,
        # New 2026-09-09 (wave 1). Recorded as a KNOWN GAP by the wave-0 audit
        # (this mutation was green then); `publishGateEpisode.test.ts`'s
        # extraction gave `beginDrive` a real caller and wave 1 specs the wedge,
        # so it is a measurement now rather than an admission.
        search="""  const drive = async (): Promise<void> => {
    try {
      onDriveStart();""",
        replace="""  const drive = async (): Promise<void> => {
    onDriveStart();
    try {""",
        # EPISODE_SPEC and not GATE_SPEC: measured 2026-09-09, the gate spec
        # stays 50/50 green under this mutation and only the episode spec's
        # "a throwing onDriveStart does not strand `active`" catches it. Naming
        # a spec that cannot reach a mutation is how an entry reports a vacuous
        # green, so the list says where the evidence actually is.
        specs=[EPISODE_SPEC],
    ),
    Mutation(
        id="dropped-pass-is-silent",
        what="the cap discards a pending sweep without telling anyone, so the awaiting caller is told the work completed",
        file=GATE,
        search="""      if (pending) onDropped();""",
        replace="""""",
        specs=[GATE_SPEC],
    ),
    # ---- the session-level invariant ---------------------------------------
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
    # ---- the residual, no longer a residual --------------------------------
    #
    # This entry was carried `expect="green"` with a `why_green` that was an
    # admission rather than a reason: the `GatedPublication` adapter lived
    # inline in `state.tsx`, which `node --test` cannot import (Solid, livekit,
    # `@revolt/client`), so no mutation could reach it — and TWO fifth-review
    # findings lived in exactly that region. Wave 1 extracted the adapter and
    # the whole episode state into `publishGateEpisode.ts`, which loads under
    # `node --test`. The flip to `expect="red"` below IS the measurement that
    # the blind spot closed; the admission is deleted rather than reworded.
    Mutation(
        id="wiring-upstream-always-quiet",
        what="the GatedPublication adapter reports every sender detached, which re-creates the 2026-09-08 defect AND disables the fail-closed report entirely (`upstream() === 'live'` becomes universally false, so the post-condition can never fire)",
        file=EPISODE,
        search="""        if (!sender) return "unpublished";
        if (!sender.track) return "quiet";""",
        replace="""        if (!sender) return "unpublished";
        return "quiet";""",
        specs=[EPISODE_SPEC],
    ),
]

# --- The extracted episode (banner-honesty wave 1) ---------------------------
#
# `publishGateEpisode.ts` + `publishGateEpisode.test.ts`. Everything here was
# unreachable by any mutation until wave 1 moved it out of `state.tsx`: the
# livekit adapter, the confirm-then-report re-sweep, the four episode flags,
# the rule that populates the spend set, `callPauseDisproved`'s lifecycle, and
# the four scopes (drive / episode-start / episode-end / call) whose collapse
# has already shipped once in each direction.

MUTATIONS += [
    # ---- the four scopes ----------------------------------------------------
    Mutation(
        id="episode-pending-is-episode-scoped",
        what="`repausePending` is cleared at beginEpisode instead of beginDrive — the REJECTED design: mechanically a permanent per-name disarm, measured to leave the mic live and the name latched through the mirror window for the rest of the call",
        file=EPISODE,
        search="""  beginDrive(): void {
    this.#pending.clear();
  }""",
        replace="""  beginDrive(): void {
    // (cleared at beginEpisode instead)
  }""",
        specs=[EPISODE_SPEC],
    ),
    Mutation(
        id="episode-endepisode-forgets-a-dropped-pass",
        what="endEpisode also clears `sweepDropped`, so the next episode's first sweep reports a clean bill over a pass that never ran",
        file=EPISODE,
        search="""  endEpisode(): void {
    this.#spent.clear();
    this.#pending.clear();
    this.#cancelConfirm();""",
        replace="""  endEpisode(): void {
    this.#spent.clear();
    this.#pending.clear();
    this.#sweepDropped = false;
    this.#cancelConfirm();""",
        specs=[EPISODE_SPEC],
    ),
    # ---- what may be spent, and for how long -------------------------------
    Mutation(
        id="episode-spends-from-repause-failed",
        what="the PERMANENT per-episode spend is fed from `repauseFailed` instead of `repauseThrew`, disarming the gate over a failure a retry could have fixed — `state.tsx:3415`, the fifth-review finding this module exists to make unwritable",
        file=EPISODE,
        search="""    for (const name of result.repauseThrew) {
      this.#spent.add(name);""",
        replace="""    for (const name of result.repauseFailed) {
      this.#spent.add(name);""",
        specs=[EPISODE_SPEC],
    ),
    Mutation(
        id="episode-never-unspends",
        what="the `proven` un-spend is dropped, so one failed repause disarms the publication for the rest of the episode even after the wire settles quiet on its own",
        file=EPISODE,
        search="""    for (const name of result.proven) {
      this.#spent.delete(name);
      this.#pending.delete(name);
    }""",
        replace="""    void result.proven;""",
        specs=[EPISODE_SPEC],
    ),
    # ---- confirm before verdict --------------------------------------------
    Mutation(
        id="episode-reports-without-confirming",
        what="the FIRST unproven sweep withdraws the banner's pause claim and spends, with no confirming re-sweep — a verdict off a single observation taken microtasks after the op, i.e. the 2026-09-08 false red",
        file=EPISODE,
        search="""    if (!confirming && this.#requestConfirm()) return;""",
        replace="""    if (false && this.#requestConfirm()) return;""",
        specs=[EPISODE_SPEC],
    ),
    Mutation(
        id="episode-dropped-pass-clears",
        what="a quiet sweep that ran over a DROPPED pass is treated as a clean bill — it restores the pause claim instead of re-scheduling, reporting on work that never ran",
        file=EPISODE,
        search="""      if (dropped) {
        // This sweep did not see everything, so it is not a clean bill.
        if (!this.#requestConfirm())
          this.#deps.report("unproven", {
            publications: [],
            droppedPass: true,
            confirmBudgetExhausted: true,
          });
        return;
      }
""",
        replace="""""",
        specs=[EPISODE_SPEC],
    ),
    Mutation(
        id="episode-confirm-budget-never-restored",
        what="a sweep that proves quiet does not restore the consecutive-confirm budget, so a long healthy episode exhausts it and the next transient window is reported as a verdict off ONE unconfirmed observation",
        file=EPISODE,
        search="""      // Everything this pass saw is quiet, so the confirm chain has served its
      // purpose and the budget is whole again.
      this.#confirmRounds = 0;""",
        replace="""      // (budget not restored)""",
        specs=[EPISODE_SPEC],
    ),
    # ---- the stale-room guard ----------------------------------------------
    Mutation(
        id="episode-ignores-stillcurrent",
        what="`consume` acts on a sweep belonging to a DISPOSED call: it mutates the live episode's disarm sets and reports into the live UI",
        file=EPISODE,
        search="""    if (!this.#deps.stillCurrent()) return;
""",
        replace="""""",
        specs=[EPISODE_SPEC],
    ),
    Mutation(
        id="episode-unspends-before-the-room-check",
        what="the room check sits BELOW the `proven` un-spend, so an in-flight sweep for a disposed call un-spends in the live episode — `state.tsx:3380` exactly",
        file=EPISODE,
        search="""    if (!this.#deps.stillCurrent()) return;

    const confirming = this.#confirming;""",
        replace="""    for (const name of result.proven) {
      this.#spent.delete(name);
      this.#pending.delete(name);
    }
    if (!this.#deps.stillCurrent()) return;

    const confirming = this.#confirming;""",
        specs=[EPISODE_SPEC],
    ),
    # ---- the deferred confirm across a lifecycle boundary (wave-1 FIX A) ----
    #
    # `#requestConfirm`'s deferred closure justifies its first guard with "a
    # lifecycle boundary cleared the request while it was deferred". Only
    # `resetForCall` honoured that until the fix round: a confirm deferred in
    # episode 1 survived a 1→0 and a 0→1, passed both of the closure's landing
    # guards (the gate is held again, the call is unchanged) and armed the NEXT
    # episode's FIRST pass as confirming — which skips the confirm arm in
    # `consume` entirely. The measured consequence is a verdict AND a permanent
    # per-episode spend off ONE unconfirmed observation, which is the 2026-09-08
    # false red re-armed at the episode boundary. One entry per boundary,
    # because each boundary is a separate call site that can be dropped alone.
    #
    # 🔴 The third entry below is the IN-FLIGHT sibling, and it deliberately
    # shares its `search` window with the first: `beginEpisode` closes the
    # deferred path (`#cancelConfirm`) and the sweep path (`#confirming =
    # false`) with two adjacent statements, and each has to be droppable on its
    # own for the pair to be measured. Same window, different `replace`; both
    # still match exactly once, which `apply()` enforces. The window is the
    # three contiguous statements rather than the whole method body because
    # `this.#cancelConfirm();` alone occurs at all THREE lifecycle boundaries —
    # the ambiguity that would make this a hard error instead of a mutation.
    Mutation(
        id="episode-beginepisode-keeps-a-deferred-confirm",
        what="beginEpisode stops taking back an outstanding confirm, so a confirm deferred in the LAST episode arms this one's first pass as confirming — verdict and permanent spend off one unconfirmed observation",
        file=EPISODE,
        search="""    this.#cancelConfirm();
    this.#confirming = false;
    this.#confirmRounds = 0;""",
        replace="""    this.#confirming = false;
    this.#confirmRounds = 0;""",
        specs=[EPISODE_SPEC],
    ),
    Mutation(
        id="episode-endepisode-keeps-a-deferred-confirm",
        what="endEpisode stops taking back an outstanding confirm, so a request made under the gate that just drained stays outstanding — and blocks every later confirm in the call, since `#confirmScheduled` is the one-outstanding dedupe",
        file=EPISODE,
        search="""    this.#cancelConfirm();
    // Consistent with both siblings: the resume sweep this boundary drives
    // must not run on the previous episode's counter.
    this.#confirmRounds = 0;
    this.#deps.setPauseDisproved(false);""",
        replace="""    this.#confirmRounds = 0;
    this.#deps.setPauseDisproved(false);""",
        specs=[EPISODE_SPEC],
    ),
    Mutation(
        id="episode-beginepisode-keeps-the-inflight-confirming-pass",
        what="beginEpisode stops DEMOTING the sweep already in flight, so a pass that armed `#confirming` in the LAST episode skips the confirm arm and verdicts in THIS one — the deferred-confirm defect's in-flight sibling, which `#cancelConfirm` alone does not close",
        file=EPISODE,
        search="""    this.#cancelConfirm();
    this.#confirming = false;
    this.#confirmRounds = 0;""",
        replace="""    this.#cancelConfirm();
    this.#confirmRounds = 0;""",
        specs=[EPISODE_SPEC],
    ),
    # ---- what restores the confirm budget (wave-1 FIX B) --------------------
    #
    # TWO entries, in opposite directions, because this line has exactly two
    # ways to be wrong and the specs must hold both walls:
    #
    #   too narrow — `result.unproven.length === 0`, the pre-fix condition. A
    #     spent publication is issued nothing, reads `live` at its
    #     post-condition and lands in `unproven` on every later pass, so the
    #     moment anything is spent that reset is UNREACHABLE: four rounds burn
    #     and a brand-new transient window on a DIFFERENT publication is
    #     verdicted off a single observation.
    #
    #   too wide — also excluding `#pending`. That set is DRIVE-scoped, so a
    #     trailing pass inside the very drive a live-lock is feeding would
    #     restore the bound that drive is burning: the unbounded confirm chain,
    #     verbatim. This one is the REJECTED alternative, and pinning a
    #     rejected design is worth more than pinning the accepted one — nothing
    #     else in the tree stops the next reader "simplifying" the asymmetry.
    Mutation(
        id="episode-budget-reset-ignores-a-spend",
        what="the consecutive-confirm budget resets on `unproven.length === 0` again instead of on ACTIONABLE unproven, which a single spend makes permanently unreachable",
        file=EPISODE,
        search="""    if (actionable.length === 0 && !dropped) this.#confirmRounds = 0;""",
        replace="""    if (result.unproven.length === 0 && !dropped) this.#confirmRounds = 0;""",
        specs=[EPISODE_SPEC],
    ),
    Mutation(
        id="episode-budget-reset-excludes-the-drive-set",
        what="the REJECTED widening: `#pending` is excluded from `actionable` too, so a trailing pass inside a live-locked drive restores the bound that drive is burning — the unbounded confirm chain back",
        file=EPISODE,
        search="""    const actionable = result.unproven.filter((n) => !this.#spent.has(n));""",
        replace="""    const actionable = result.unproven.filter(
      (n) => !this.#spent.has(n) && !this.#pending.has(n),
    );""",
        specs=[EPISODE_SPEC],
    ),
    # ---- the verdict's precondition (wave-1 FIX C) --------------------------
    Mutation(
        id="episode-verdict-fires-under-an-empty-gate",
        what="the `gateHeld()` guard before the verdict is bypassed, so a confirm deferred under a held gate that lands after the gate DRAINED writes `callPauseDisproved` true — where it latches, because every path back to false is itself gate- or boundary-conditioned",
        file=EPISODE,
        search="""    if (!this.#deps.gateHeld()) {""",
        replace="""    if (false) {""",
        specs=[EPISODE_SPEC],
    ),
    # ---- the budget at the episode boundary (wave-1 FIX D) ------------------
    Mutation(
        id="episode-endepisode-keeps-a-spent-budget",
        what="endEpisode leaves `#confirmRounds` where the last episode left it, so the resume sweep this very boundary drives runs on the PREVIOUS episode's exhausted counter and takes its first observation as a verdict",
        file=EPISODE,
        search="""    this.#cancelConfirm();
    // Consistent with both siblings: the resume sweep this boundary drives
    // must not run on the previous episode's counter.
    this.#confirmRounds = 0;
    this.#deps.setPauseDisproved(false);
  }""",
        replace="""    this.#cancelConfirm();
    this.#deps.setPauseDisproved(false);
  }""",
        specs=[EPISODE_SPEC],
    ),
    # ---- the livekit adapter ------------------------------------------------
    Mutation(
        id="episode-adapter-snapshots-the-wire",
        what="`gatedPublicationsFrom` SNAPSHOTS the pause flag instead of exposing a getter, so the sweep's post-condition re-asserts its own pre-condition — deleting the only read in the stack that observes what the op actually did",
        file=EPISODE,
        search="""      get upstreamPaused() {
        return track.isUpstreamPaused;
      },""",
        replace="""      upstreamPaused: track.isUpstreamPaused,""",
        specs=[EPISODE_SPEC],
    ),
    Mutation(
        id="episode-adapter-keeps-a-trackless-publication",
        what="a publication mid-republish (no `track`) is presented to the sweep anyway, so every read in the adapter dereferences undefined and one republish costs the whole sweep",
        file=EPISODE,
        search="""    if (!track) continue;""",
        replace="""    if (!track && false) continue;""",
        specs=[EPISODE_SPEC],
    ),
]


if __name__ == "__main__":
    sys.exit(main())
