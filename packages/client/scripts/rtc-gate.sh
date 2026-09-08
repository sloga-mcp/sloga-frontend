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
set -uo pipefail

cd "$(dirname "$0")/.." || exit 99
ROOT=../..
LOG=$(mktemp -d)
trap 'rm -rf "$LOG"' EXIT
fails=0

run() { # run <label> <tail-lines> <cmd...>
  local label="$1" lines="$2"
  shift 2
  local out
  out="$LOG/$(echo "$label" | tr -c 'A-Za-z0-9' '_')"
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

# 🔴 An ADDITIONAL floor, never the verdict. `node --test` exits 0 on a file
# containing ZERO tests, so a spec emptied by a bad merge — or one whose
# `test(` became `test.skip(` — reports GATE PASS having asserted nothing:
# the same silent pass as the summary-grep this script was written to replace.
# The VERDICT is still the runner's own exit status, captured in `run` above.
#
# 🔴 "pass > 0" does NOT catch it. Measured on node 24.18.0: a spec file with
# no tests reports `tests 1 / pass 1`, counting the FILE ITSELF as a passing
# test. So compare what the SOURCE declares against what the runner executed —
# an emptied file declares nothing, and a skipped one declares more than it
# ran. Both greps read a file directly; there is no pipeline and no `$?` to
# lose, which is the whole reason this script exists.
assert_tests_ran() { # assert_tests_ran <label> <spec-file>
  local label="$1" f="$2"
  local out="$LOG/$(echo "$label" | tr -c 'A-Za-z0-9' '_')"
  local declared executed
  # `test(`, `test.skip(` and `test.only(`, but not `testSomething(`.
  declared=$(grep -c '^test[(.]' "$f")
  # Matches the spec reporter's "ℹ pass 34" and TAP's "# pass 34" alike.
  executed=$(awk '/(^|[^a-zA-Z])pass [0-9]+$/{n=$NF} END{print n+0}' "$out")
  if [ "$declared" -eq 0 ]; then
    echo ">>> GATE FAIL: $f declares no top-level tests — refusing to report a pass"
    fails=$((fails + 1))
  elif [ "$executed" -lt "$declared" ]; then
    echo ">>> GATE FAIL: $f declares $declared test(s), only $executed ran" \
      "— skipped or emptied"
    fails=$((fails + 1))
  fi
}

# An unmatched glob stays literal in bash, and `[ -e "$f" ] || continue` would
# then skip it and report a clean gate with ZERO specs run — the same silent
# pass this script exists to kill.
shopt -s nullglob
# Wider than the files this branch edits: a change to the session's error
# classification reaches the admit, rejoin, roster and publication-encryption
# policies too, and two reviewed defects ran through exactly those.
SPECS=(components/rtc/mls*.test.ts components/rtc/rosterReconcile.test.ts
  components/rtc/localPublicationEncryption.test.ts
  components/rtc/plaintextCryptorPolicy.test.ts
  components/rtc/decodeWitnessListener.test.ts)
# 🔴 Arguments ADD to that set; they do not replace it. They used to replace
# it, so the natural invocation for this branch —
#   rtc-gate.sh components/rtc/mls*.test.ts
# — silently skipped decodeWitnessListener.test.ts, the ONLY spec that loads
# the decode-witness listener, and printed a green gate over a gate (d) that
# had not been exercised at all. Narrowing what runs is exactly the silent pass
# this script exists to kill, so the narrowing is gone: pass a spec to make
# sure it runs, never to make the others stop.
for arg in "$@"; do
  seen=0
  for s in "${SPECS[@]}"; do
    if [ "$s" = "$arg" ]; then seen=1; fi
  done
  if [ $seen -eq 0 ]; then SPECS+=("$arg"); fi
done
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
  components/rtc/mlsCallModePolicy.test.ts
  components/rtc/decodeWitnessListener.ts
  components/rtc/decodeWitnessListener.test.ts src/sentry.ts)
ran=0
for f in "${SPECS[@]}"; do
  [ -e "$f" ] || continue
  run "node --test $f" 12 node --test --conditions=browser "$f"
  assert_tests_ran "node --test $f" "$f"
  ran=$((ran + 1))
done
if [ $ran -eq 0 ]; then
  echo ">>> GATE FAIL: no spec file existed — refusing to report a pass"
  exit 98
fi

# 🔴 Gate (d)'s call site. `decodeWitnessListener.test.ts` pins the VALUE of
# DECODE_WITNESS_INITIAL and rtc-mutations.py flips it, but neither can see
# whether `state.tsx` actually PASSES it to createSignal — that file imports
# extensionless paths, Solid and LiveKit, and no spec can load it. Writing the
# literal `{ available: true, dropping: [], live: [] }` there type-checks,
# lints, formats and leaves every spec and every mutation green while restoring
# green-by-default: the exact defect review round 2 found, which survived the
# extraction because moving the constant did not guard the argument.
#
# Same reason the listener's two caller obligations are asserted here. The
# module owns no timer and no worker, so "tick() is actually run" and "stop()
# is actually called" are guarantees only this file can make, and only source
# text can check.
#
# grep reads each file DIRECTLY. Never `cat "$f" | grep -q`: under `pipefail`
# grep -q exits on the first match, the writer takes SIGPIPE, and the pipeline
# reports failure BECAUSE the assertion matched.
check_witness_call_site() {
  local f=components/rtc/state.tsx rc=0
  require() { # require <exact source text> <what it guarantees>
    if grep -qF "$1" "$f"; then
      echo "ok:   $2"
    else
      echo "FAIL: $2"
      echo "      $f no longer contains: $1"
      rc=1
    fi
  }
  require 'createSignal<DecodeWitness>(DECODE_WITNESS_INITIAL, {' \
    "the witness signal is seeded UNAVAILABLE, from the spec'd constant"
  require 'const stale = setInterval(() => listener.tick(), listener.checkMs);' \
    "the staleness sweep is actually started, at the listener's own interval"
  require 'listener.stop();' \
    "teardown tells the listener, so the last sample stops standing"
  return $rc
}
run "gate (d) call site in state.tsx" 12 check_witness_call_site

run "tsc --noEmit" 25 "$ROOT/node_modules/.pnpm/node_modules/.bin/tsc" --noEmit
# --check, never --write: reformatting a tracked file sweeps up code this
# branch did not touch.
run "prettier --check" 12 "$ROOT/node_modules/.bin/prettier" --check "${FILES[@]}"
# 0 errors required; the solid/reactivity warning in state.tsx is pre-existing.
run "eslint" 30 "$ROOT/node_modules/.bin/eslint" "${FILES[@]}"

echo
echo "################ GATE SUMMARY: $fails failing check(s) ################"
exit $fails
