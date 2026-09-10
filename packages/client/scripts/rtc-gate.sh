#!/bin/bash
# The RTC/MLS branch gate.
#
#   packages/client/scripts/rtc-gate.sh [spec-glob ...]
#
# Runs the node:test specs plus tsc, prettier --check and eslint, and judges
# each check on THE EXIT STATUS OF THAT CHECK — never on a grep of its summary
# line, and never on the exit status of something it was piped into.
#
# Why this file exists. On 2026-09-07 a gate that grepped a summary line
# reported "132/132 policy specs green" for a commit at which one spec was
# failing. Three live encrypted-call legs were then run on a build from that
# commit, and none of them was evidence about the code they were meant to
# prove. The two shapes that cause it:
#
#   node --test … | tail -20;  [ $? -eq 0 ]     # $? is tail's, always 0
#   node --test … | grep -q "fail 0"            # matches a partial summary
#
# So: run the check bare, capture its status immediately into a variable, and
# only then look at the output. `node --test` exits non-zero on any failure,
# which is the whole signal — nothing needs to be parsed.
#
# 🔴 EXCEPT THAT AN EXIT STATUS IS NOT ENOUGH ON ITS OWN, which is the second
# reason this file exists. `node --test` exits 0 on ZERO tests; an EMPTY spec
# file reports `pass 1`; and a test that becomes `it.skip` keeps the run at
# exit 0 while asserting nothing. The `ran` counter below proves only that a
# FILE existed. So every spec also has a COMMITTED expected count (see
# EXPECTED) that its own run must reproduce exactly — read out of the captured
# LOG FILE, never out of the 12-line tail, and never out of a `grep test(` of
# the source (nested `t.test`, `describe` and loop-generated tests all break
# that: `publishGate.test.ts` declares 40 top-level `test(` and executes 50).
set -uo pipefail

ARGC=$# # captured before anything can shift it

cd "$(dirname "$0")/.." || exit 99
ROOT=../..
LOG=$(mktemp -d)
trap 'rm -rf "$LOG"' EXIT
fails=0

#: Set by `run` to the FULL captured log of the check it just ran. The tail
#: printed to the console is for a human; every assertion reads this file.
LAST_LOG=""

note_fail() { # note_fail <message…> — a failing check that is not a command
  echo ">>> GATE FAIL: $*"
  fails=$((fails + 1))
}

run() { # run <label> <tail-lines> <cmd...>
  local label="$1" lines="$2"
  shift 2
  local out
  out="$LOG/$(echo "$label" | tr -c 'A-Za-z0-9' '_')"
  LAST_LOG="$out"
  echo "=============== $label ==============="
  "$@" >"$out" 2>&1
  local rc=$? # the CHECK's status, captured before anything else runs
  tail -n "$lines" "$out"
  if [ $rc -ne 0 ]; then
    echo ">>> GATE FAIL: $label (exit $rc)"
    fails=$((fails + 1))
  else
    echo ">>> GATE PASS: $label (exit 0)"
  fi
}

# --- declared vs executed ----------------------------------------------------
#
# One row per spec file: `<path> <tests> <skipped>`.
#
#   tests   — every test the runner EXECUTED, nested and loop-generated ones
#             included. This is the runner's own `tests` counter, so it is the
#             number that actually ran, not the number the source appears to
#             declare.
#   skipped — pinned SEPARATELY and EXACTLY, and never counted as a pass. That
#             is the whole point: `node --test` exits 0 with skips, so a spec
#             quietly becoming `{ skip: true }` keeps `tests` on its pin, keeps
#             the exit status at 0, and stops asserting anything. Pinning both
#             numbers means such a change moves `skipped` off its pin and the
#             gate goes red. `pass` is then asserted to be exactly
#             `tests - skipped`, and `fail` to be 0.
#
# A spec that runs with NO row is a failure, not a skip — that is how a new
# spec file is forced to declare its count instead of drifting in unmeasured.
# And on a BARE run (no spec arguments) every row must have been reached, so a
# spec that is deleted, renamed, or falls out of the glob cannot go quiet.
#
# 🔴 THESE NUMBERS ARE MEANT TO GO STALE. Adding a test to a spec here turns
# this gate red until the row is bumped in the same commit. That is the
# contract, not an inconvenience: it is what makes "the suite is green" mean
# "the suite ran the tests we agreed it runs". Bump the row, never widen the
# check.
EXPECTED=(
  "components/rtc/mlsAdmitGracePolicy.test.ts 18 0"
  "components/rtc/mlsAdmitPolicy.test.ts 15 0"
  "components/rtc/mlsCallModePolicy.test.ts 74 0"
  "components/rtc/mlsCallSession.falsered.test.ts 5 0"
  "components/rtc/mlsCallSession.heal.test.ts 7 0"
  "components/rtc/mlsCallSession.joinrace.test.ts 30 0"
  "components/rtc/mlsDrainPolicy.test.ts 14 0"
  "components/rtc/mlsJoinRequestPolicy.test.ts 4 0"
  "components/rtc/mlsNegotiatingFailsafe.test.ts 13 0"
  "components/rtc/mlsRejoinPolicy.test.ts 18 0"
  "components/rtc/mlsSessionSetupPolicy.test.ts 17 0"
  "components/rtc/rosterReconcile.test.ts 25 0"
  "components/rtc/localPublicationEncryption.test.ts 10 0"
  "components/rtc/plaintextCryptorPolicy.test.ts 12 0"
  "components/rtc/publishGate.test.ts 50 0"
  "components/rtc/publishGateEpisode.test.ts 51 0"
)

counter() { # counter <log> <name> — the runner's own summary counter, or ""
  # node:test's default reporter closes with a block of `ℹ <name> <n>` lines.
  # The leading glyph is not ASCII and differs between reporters, so match "any
  # run of non-alphanumerics" and anchor the number at end of line — a test
  # TITLED "pass 3" prints a `(0.4ms)` duration and cannot collide. Take the
  # LAST match so nothing printed earlier can shadow the summary.
  sed -n "s/^[^A-Za-z0-9]*$2 \([0-9][0-9]*\)\$/\1/p" "$1" | tail -1
}

expected_for() { # expected_for <spec> — prints "<tests> <skipped>", or fails
  local spec="$1" row
  for row in "${EXPECTED[@]}"; do
    case "$row" in
    "$spec "*)
      echo "${row#"$spec" }"
      return 0
      ;;
    esac
  done
  return 1
}

check_counts() { # check_counts <spec> <log>
  local spec="$1" log="$2" row want_tests want_skipped
  local got_tests got_pass got_fail got_skipped
  got_tests=$(counter "$log" tests)
  got_pass=$(counter "$log" pass)
  got_fail=$(counter "$log" fail)
  got_skipped=$(counter "$log" skipped)
  if [ -z "$got_tests" ] || [ -z "$got_pass" ] || [ -z "$got_fail" ] ||
    [ -z "$got_skipped" ]; then
    note_fail "$spec: the run printed no summary counters — refusing to" \
      "report a pass on an unreadable result"
    return
  fi
  echo "    counted: tests $got_tests pass $got_pass fail $got_fail" \
    "skipped $got_skipped"
  if [ "$got_tests" -eq 0 ]; then
    note_fail "$spec: the runner EXECUTED ZERO TESTS (and still exited 0)"
    return
  fi
  if ! row=$(expected_for "$spec"); then
    note_fail "$spec: no committed expected count — add a row to EXPECTED in" \
      "$(basename "$0") rather than letting a spec run unmeasured"
    return
  fi
  want_tests=${row%% *}
  want_skipped=${row##* }
  if [ "$got_tests" -ne "$want_tests" ]; then
    note_fail "$spec: executed $got_tests test(s), EXPECTED $want_tests" \
      "— bump the EXPECTED row in the same commit as the spec change"
  fi
  if [ "$got_skipped" -ne "$want_skipped" ]; then
    note_fail "$spec: $got_skipped skipped, EXPECTED $want_skipped" \
      "— a skip is never a pass"
  fi
  if [ "$got_fail" -ne 0 ]; then
    note_fail "$spec: $got_fail failing test(s) in the summary"
  fi
  if [ "$got_pass" -ne $((got_tests - got_skipped)) ]; then
    note_fail "$spec: pass $got_pass != tests $got_tests - skipped" \
      "$got_skipped — the run did not account for every test"
  fi
}

# An unmatched glob stays literal in bash, and `[ -e "$f" ] || continue` would
# then skip it and report a clean gate with ZERO specs run — the same silent
# pass this script exists to kill.
shopt -s nullglob
SPECS=("$@")
if [ ${#SPECS[@]} -eq 0 ]; then
  # Wider than the files this branch edits: a change to the session's error
  # classification reaches the admit, rejoin, roster and publication-encryption
  # policies too, and two reviewed defects ran through exactly those.
  SPECS=(components/rtc/mls*.test.ts components/rtc/rosterReconcile.test.ts
    components/rtc/localPublicationEncryption.test.ts
    components/rtc/plaintextCryptorPolicy.test.ts
    components/rtc/publishGate.test.ts
    components/rtc/publishGateEpisode.test.ts)
fi
if [ ${#SPECS[@]} -eq 0 ]; then
  echo ">>> GATE FAIL: no spec files matched — refusing to report a pass"
  exit 98
fi

# The specs are RUN wide, but prettier/eslint are scoped to what this work
# owns. Formatting a tracked file this branch never touched sweeps up code it
# has no business changing, and several existing specs predate the current
# prettier config.
FILES=(components/rtc/mlsCallSession.ts components/rtc/mlsCallModePolicy.ts
  components/rtc/state.tsx components/rtc/mlsCallSession.harness.ts
  components/rtc/mlsCallSession.heal.test.ts
  components/rtc/mlsCallSession.joinrace.test.ts
  components/rtc/mlsCallSession.falsered.test.ts
  components/rtc/publishGate.ts components/rtc/publishGate.test.ts
  components/rtc/publishGateEpisode.ts
  components/rtc/publishGateEpisode.test.ts
  components/rtc/mlsCallModePolicy.test.ts src/sentry.ts)
ran=0
RAN_SPECS=()
for f in "${SPECS[@]}"; do
  # A spec file that does not exist is NOT a skip. Every path here is either a
  # glob (which nullglob already dropped if it matched nothing) or a literal
  # this gate committed to running, so a missing literal means the file was
  # deleted, renamed, or never landed — all of which must be loud.
  if [ ! -e "$f" ]; then
    note_fail "spec file $f does not exist — refusing to report a pass for a" \
      "spec that never ran"
    continue
  fi
  run "node --test $f" 12 node --test --conditions=browser "$f"
  check_counts "$f" "$LAST_LOG"
  RAN_SPECS+=("$f")
  ran=$((ran + 1))
done
if [ $ran -eq 0 ]; then
  echo ">>> GATE FAIL: no spec file existed — refusing to report a pass"
  exit 98
fi

# On a bare run the EXPECTED table is the manifest: every row must have been
# reached. (With explicit spec arguments the caller has deliberately narrowed
# the run, so only the rows they hit are checked — and arguments REPLACE the
# list rather than adding to it, which is why CI must invoke this bare.)
if [ "$ARGC" -eq 0 ]; then
  for row in "${EXPECTED[@]}"; do
    spec=${row%% *}
    case " ${RAN_SPECS[*]} " in
    *" $spec "*) ;;
    *) note_fail "$spec has an EXPECTED row but never ran on a bare gate" ;;
    esac
  done
fi

run "tsc --noEmit" 25 "$ROOT/node_modules/.pnpm/node_modules/.bin/tsc" --noEmit
# --check, never --write: reformatting a tracked file sweeps up code this
# branch did not touch.
run "prettier --check" 12 "$ROOT/node_modules/.bin/prettier" --check "${FILES[@]}"
# 0 errors required; the solid/reactivity warning in state.tsx is pre-existing.
run "eslint" 30 "$ROOT/node_modules/.bin/eslint" "${FILES[@]}"

echo
echo "################ GATE SUMMARY: $fails failing check(s) ################"
exit $fails
