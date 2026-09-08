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
# 🔴 Neither "pass > 0" NOR a pass/declared comparison works. Both were tried
# and both were wrong. Measured on node 24.18.0, per spec file:
#
#   shape        rc  tests  pass  skipped   declared
#   empty         0      1     1        0          0   <- file counts ITSELF
#   3 normal      0      3     3        0          3
#   3 skipped     0      3     0        3          3
#   1 of 3 fails  1      3     2        0          3
#   describe/it   0      2     2        0          2
#
# So: `pass > 0` passes an empty file (1 > 0). And comparing `pass` against
# `declared` reports a genuine FAILURE as "skipped or emptied" — the wrong
# diagnosis at the moment the gate matters, and the fastest route to somebody
# deleting the floor. Read `tests` and `skipped` instead, and leave failures
# entirely to the runner's exit status, which `run` already captured.
#
# Every grep reads a file directly: no pipeline, no `$?` to lose.
assert_tests_ran() { # assert_tests_ran <label> <spec-file>
  local label="$1" f="$2"
  local out="$LOG/$(echo "$label" | tr -c 'A-Za-z0-9' '_')"
  local declared ran skipped todo
  # `test(` / `it(` and their `.skip`/`.only`/`.todo` forms, counted as
  # OCCURRENCES rather than lines: a line-anchored pattern misses
  # `describe("g", () => { it("a", ...) })`, and measurably hard-failed a
  # legitimate spec for declaring nothing. The leading class rejects
  # `submit(` and `unit(`; requiring the `(` rejects prose like "only test.".
  # Measured exact (declared == tests) on all 14 spec files in the default set.
  # `wc -l` consumes its whole input, so this pipe cannot lose a status the way
  # `| grep -q` does.
  declared=$(grep -oE '(^|[^A-Za-z0-9_.])(test|it)(\.(skip|only|todo))?\(' "$f" | wc -l)
  ran=$(awk '/(^|[^a-zA-Z])tests [0-9]+$/{n=$NF} END{print n+0}' "$out")
  skipped=$(awk '/(^|[^a-zA-Z])skipped [0-9]+$/{n=$NF} END{print n+0}' "$out")
  todo=$(awk '/(^|[^a-zA-Z])todo [0-9]+$/{n=$NF} END{print n+0}' "$out")
  if [ "$declared" -eq 0 ]; then
    # Either the file is empty (node reports `tests 1 / pass 1`, counting the
    # FILE as a passing test) or it uses a shape this pattern cannot read.
    # Both mean the floor cannot vouch for it, and a floor that cannot vouch
    # must not stay quiet.
    echo ">>> GATE FAIL: $f declares no recognizable tests — refusing to" \
      "report a pass"
    fails=$((fails + 1))
  elif [ "$ran" -lt "$declared" ]; then
    echo ">>> GATE FAIL: $f declares $declared test(s) but the runner saw" \
      "$ran — refusing to report a pass"
    fails=$((fails + 1))
  elif [ "$skipped" -gt 0 ] || [ "$todo" -gt 0 ]; then
    echo ">>> GATE FAIL: $f has $skipped skipped and $todo todo — a spec that" \
      "does not run is not evidence"
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
  # 🔴 Paths are relative to packages/client, because this script cd'd there.
  # `rtc-gate.sh packages/client/components/rtc/x.test.ts` — the same prefix as
  # the command itself — used to match nothing and be silently dropped, so
  # "pass a spec to make sure it runs" was not true.
  if [ ! -e "$arg" ]; then
    echo ">>> GATE FAIL: spec argument '$arg' matches no file under $(pwd)"
    fails=$((fails + 1))
    continue
  fi
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
  # 🔴 `require` pins a DEFINITION. `require_count` pins the INVOCATIONS, and
  # the difference is not academic: a review deleted the `#armDecodeWitness`
  # and `#disarmDecodeWitness` CALLS while every definition-shaped assertion
  # here still printed `ok:`. An assertion that reports a guarantee it does not
  # check is worse than no assertion.
  require_count() { # require_count <exact source text> <n> <what it guarantees>
    local n
    n=$(grep -cF "$2" "$f")
    if [ "$n" -eq "$3" ]; then
      echo "ok:   $1"
    else
      echo "FAIL: $1"
      echo "      $f contains $n of: $2"
      echo "      expected exactly $3"
      rc=1
    fi
  }
  require 'createSignal<DecodeWitness>(DECODE_WITNESS_INITIAL, {' \
    "the witness signal is seeded UNAVAILABLE, from the spec'd constant"
  # 🔴 The seed is not the read. A round-4 review replaced this line with an
  # available literal and the gate, all 41 mutations, tsc, eslint and prettier
  # stayed green — green-by-default restored, one line below the line the gate
  # was watching. This is a BACKSTOP: the real fix is to move the chip's input
  # assembly into a module a spec can load.
  require 'decodeWitness: this.callDecodeWitness(),' \
    "the chip READS the witness signal rather than a literal"
  require 'const stale = setInterval(() => listener.tick(), listener.checkMs);' \
    "the staleness sweep is started, at the listener's own interval"
  require 'listener.stop();' \
    "teardown tells the listener, so the last sample stops standing"
  require_count "the listener is ARMED when a session is created" \
    'this.#armDecodeWitness(session);' 1
  # Twice: once in disconnect(), once at the head of #armDecodeWitness. Deleting
  # the disconnect() one leaves the definition-shaped assertions above happy.
  require_count "teardown AND re-arm both DISARM the witness" \
    'this.#disarmDecodeWitness();' 2
  return $rc
}
run "gate (d) call site in state.tsx" 12 check_witness_call_site

# 🔴 The gate (d) evidence chain is worth nothing if the shipped worker never
# posts a witness. `pnpm-workspace.yaml` declaring the patch is NOT the same as
# the resolved package carrying it — the package.json key was ignored from pnpm
# 10 on, and moving the declaration does not re-resolve an already-installed
# store entry. A build from an unpatched tree pins gate (d) AMBER for every
# call, for every user, and looks exactly like a working gate that is
# withholding. This is the only check that can tell those apart.
check_e2ee_worker_patch() {
  local w=node_modules/livekit-client/dist/livekit-client.e2ee.worker.mjs
  if [ ! -f "$w" ]; then
    echo "FAIL: $w does not exist — cannot tell whether the witness ships"
    return 1
  fi
  if grep -qF 'slogaDecodeWitness' "$w"; then
    echo "ok:   the resolved e2ee worker posts the decode witness"
    return 0
  fi
  echo "FAIL: the RESOLVED livekit e2ee worker contains no decode witness."
  echo "      resolved: $(readlink -f "$w")"
  echo "      The patch is declared in pnpm-workspace.yaml but this store entry"
  echo "      predates it. Every build from this tree ships a worker that never"
  echo "      posts slogaDecodeWitness, so gate (d) is pinned AMBER — and no"
  echo "      live leg has ever exercised the witness."
  return 1
}
run "e2ee worker carries the witness" 12 check_e2ee_worker_patch

run "tsc --noEmit" 25 "$ROOT/node_modules/.pnpm/node_modules/.bin/tsc" --noEmit
# --check, never --write: reformatting a tracked file sweeps up code this
# branch did not touch.
run "prettier --check" 12 "$ROOT/node_modules/.bin/prettier" --check "${FILES[@]}"
# 0 errors required; the solid/reactivity warning in state.tsx is pre-existing.
run "eslint" 30 "$ROOT/node_modules/.bin/eslint" "${FILES[@]}"

echo
echo "################ GATE SUMMARY: $fails failing check(s) ################"
exit $fails
