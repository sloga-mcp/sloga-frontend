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
    components/rtc/publishGate.test.ts)
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
  components/rtc/mlsCallModePolicy.test.ts src/sentry.ts)
ran=0
for f in "${SPECS[@]}"; do
  [ -e "$f" ] || continue
  run "node --test $f" 12 node --test --conditions=browser "$f"
  ran=$((ran + 1))
done
if [ $ran -eq 0 ]; then
  echo ">>> GATE FAIL: no spec file existed — refusing to report a pass"
  exit 98
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
