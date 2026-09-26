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
# that: `publishGate.test.ts` declares 42 top-level `test(`
# — `grep -c '^test(' components/rtc/publishGate.test.ts` — and EXECUTES 70;
# the executed count moves with every loop-generated spec, EXPECTED is the truth).
set -uo pipefail

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
  "components/rtc/mlsCallKeys.test.ts 23 0"
  "components/rtc/mlsCallModePolicy.test.ts 117 0"
  "components/rtc/mlsCallSession.drainfail.test.ts 33 0"
  # Out of alphabetical order on purpose: its sorted slot abuts the
  # `mlsRejoinPolicy` row the rejoin-resume branch bumps, and adjacent edits
  # conflict on merge. Kept beside the late-drain guard's other spec instead.
  "components/rtc/mlsRefetchPolicy.test.ts 39 0"
  "components/rtc/mlsCallSession.escape.test.ts 17 0"
  "components/rtc/mlsCallSession.falsered.test.ts 11 0"
  "components/rtc/mlsCallSession.fleet.test.ts 31 0"
  "components/rtc/mlsCallSession.groupscope.test.ts 19 0"
  "components/rtc/mlsCallSession.heal.test.ts 7 0"
  "components/rtc/mlsCallSession.joinrace.test.ts 37 0"
  "components/rtc/mlsCallSession.resecure.test.ts 23 0"
  "components/rtc/mlsCallSession.serveguard.test.ts 3 0"
  "components/rtc/mlsCallSession.timeline.test.ts 4 0"
  "components/rtc/mlsDrainPolicy.test.ts 14 0"
  "components/rtc/mlsJoinRequestPolicy.test.ts 4 0"
  "components/rtc/mlsJoinTimeline.test.ts 9 0"
  "components/rtc/mlsNegotiatingFailsafe.test.ts 13 0"
  "components/rtc/mlsRejoinPolicy.test.ts 22 0"
  "components/rtc/mlsSessionSetupPolicy.test.ts 19 0"
  "components/rtc/rosterReconcile.test.ts 27 0"
  "components/rtc/localPublicationEncryption.test.ts 10 0"
  "components/rtc/plaintextCryptorPolicy.test.ts 12 0"
  "components/rtc/publishGate.test.ts 70 0"
  "components/rtc/publishGateEpisode.test.ts 76 0"
  "components/rtc/pauseVerdict.test.ts 10 0"
  "components/rtc/micPipelinePolicy.test.ts 4 0"
  "components/rtc/publishKickPolicy.test.ts 4 0"
  "components/rtc/decodeWitnessListener.test.ts 42 0"
  "components/rtc/chipInputs.test.ts 31 0"
  "components/rtc/screenAudioWire.test.ts 17 0"
  "components/rtc/screenAudioNativeWin.test.ts 51 0"
  "components/rtc/pauseClauseHold.test.ts 7 0"
  "components/client/mlsInboundBuffer.test.ts 11 0"
  "components/client/mlsEnvelopeClassify.test.ts 12 0"
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
# Wider than the files this branch edits: a change to the session's error
# classification reaches the admit, rejoin, roster and publication-encryption
# policies too, and two reviewed defects ran through exactly those.
SPECS=(components/rtc/mls*.test.ts components/rtc/rosterReconcile.test.ts
  components/rtc/localPublicationEncryption.test.ts
  components/rtc/plaintextCryptorPolicy.test.ts
  components/rtc/publishGate.test.ts
  components/rtc/publishGateEpisode.test.ts
  components/rtc/pauseVerdict.test.ts
  components/rtc/micPipelinePolicy.test.ts
  components/rtc/publishKickPolicy.test.ts
  components/rtc/decodeWitnessListener.test.ts
  components/rtc/chipInputs.test.ts
  components/rtc/screenAudioWire.test.ts
  components/rtc/screenAudioNativeWin.test.ts
  # 🔴 NOT matched by the mls*.test.ts glob above — a literal, or the
  # banner's pause-clause hold (wave 3) runs nowhere and its EXPECTED row
  # trips "never ran" instead of measuring anything.
  components/rtc/pauseClauseHold.test.ts
  # 🔴 Outside components/rtc, so no glob above reaches them. The inbound
  # buffer is what keeps a connect-time mailbox drain of MLS envelopes off the
  # Olm path until a call session's sink exists; the classifier maps a native
  # `e2ee_call_process` rejection to the ack / park / drop disposition the
  # session's drain acts on. The classifier's spec ran nowhere before these
  # two lines.
  components/client/mlsInboundBuffer.test.ts
  components/client/mlsEnvelopeClassify.test.ts)
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
    note_fail "spec argument '$arg' matches no file under $(pwd)"
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
  components/rtc/mlsCallSession.falsered.test.ts
  components/rtc/mlsCallSession.resecure.test.ts
  components/rtc/publishGate.ts components/rtc/publishGate.test.ts
  components/rtc/publishGateEpisode.ts
  components/rtc/publishGateEpisode.test.ts
  components/rtc/pauseVerdict.ts components/rtc/pauseVerdict.test.ts
  components/rtc/micPipelinePolicy.ts components/rtc/micPipelinePolicy.test.ts
  components/rtc/publishKickPolicy.ts components/rtc/publishKickPolicy.test.ts
  components/rtc/mlsCallModePolicy.test.ts
  components/rtc/decodeWitnessListener.ts
  components/rtc/decodeWitnessListener.test.ts
  components/rtc/chipInputs.ts
  components/rtc/chipInputs.test.ts src/sentry.ts
  components/rtc/mlsCallSession.escape.test.ts
  components/rtc/screenAudioWire.ts components/rtc/screenAudioWire.test.ts
  components/rtc/screenAudioNativeWin.ts
  components/rtc/screenAudioNativeWin.test.ts
  components/ui/components/features/voice/callCard/VoiceCallDowngradeBanner.tsx
  components/ui/components/features/voice/callCard/VoiceCallCardStatus.tsx
  components/rtc/pauseClauseHold.ts components/rtc/pauseClauseHold.test.ts
  components/rtc/mlsJoinTimeline.ts components/rtc/mlsJoinTimeline.test.ts
  components/rtc/mlsCallSession.timeline.test.ts
  components/rtc/mlsCallSession.fleet.test.ts
  components/rtc/mlsCallSession.groupscope.test.ts
  components/rtc/mlsCallSession.serveguard.test.ts
  # Enrolled because all three are clean: `prettier --check` and eslint each
  # exit 0 on them, with no warnings (measured when the late-drain guard added
  # the refetch policy, its spec and the session's drain-failure spec).
  components/rtc/mlsRefetchPolicy.ts components/rtc/mlsRefetchPolicy.test.ts
  components/rtc/mlsCallSession.drainfail.test.ts
  # Enrolled because both are clean: `prettier --check` and eslint each exit
  # 0 on them, with no warnings (measured when the rejoin-resume plan's wave
  # 1.5 added `serveTargetStillStale` and its cases).
  components/rtc/mlsRejoinPolicy.ts components/rtc/mlsRejoinPolicy.test.ts
  components/client/mlsInboundBuffer.ts
  components/client/mlsInboundBuffer.test.ts
  # Enrolled because it is clean: `prettier --check` passes on it (and passed
  # at base c219c107), and eslint exits 0 on it with ONE pre-existing warning
  # (see the eslint step below).
  components/client/e2ee.ts)
# 🔴 NOT in FILES: components/ui/components/features/voice/watch/WatchOverlay.tsx.
# Wave 3 changes ONE line of it (`bannerParksFloat(voice.callBanner())`), but
# the file carries 101 pre-existing prettier/prettier warnings and fails
# `prettier --check` at base a59257eb, so enrolling it would either turn this
# gate permanently red or force a whole-file reformat of code this branch
# never touched (the sweep the comment above forbids). Its one edit is
# prettier-stable in its own window; tsc still type-checks it.
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

# The EXPECTED table is the manifest: every row must have been reached.
# Arguments only ever ADD to the default set, so this holds on every run.
for row in "${EXPECTED[@]}"; do
  spec=${row%% *}
  case " ${RAN_SPECS[*]} " in
  *" $spec "*) ;;
  *) note_fail "$spec has an EXPECTED row but never ran" ;;
  esac
done
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
# Count occurrences of a literal in LIVE code: line comments are skipped, and
# two occurrences on one line count as two.
#
# 🔴 Both properties were bugs. A review defeated every assertion below by
# commenting the required line out and putting the fake one under it —
# `grep -qF` matched the comment and the gate printed `ok:`. And `require_count`
# used `grep -cF`, a LINE count, while its own comment and the commit message
# both said occurrences.
#
# 🔴 What this still does NOT catch: a dead guard. `if (false) this.#arm...();`
# is live code by this definition and counts. That is not fixable by reading
# source text, and it is the reason the real answer is to move this assembly
# into a module a spec can load rather than to keep adding assertions here.
#
# 🔴 This was awk, and awk cannot lex JavaScript. It skipped a line whose
# FIRST non-space characters were `//`, which caught exactly one of the three
# comment placements — a review defeated it with a trailing `//` on a live line
# and again with a block comment whose interior lines are not `*`-prefixed. It
# also skipped LIVE continuation lines beginning with `*`.
#
# Node is already a hard dependency of this gate (it runs every spec), so use
# it: blank out comments with a scanner that understands strings, template
# literals and regex-free JS well enough not to be fooled by `//` inside a
# string, then count occurrences in what is left.
count_live() { # count_live <file> <literal>
  node -e '
    const src = require("fs").readFileSync(process.argv[1], "utf8");
    const needle = process.argv[2];
    let out = "";
    let i = 0;
    while (i < src.length) {
      const two = src.slice(i, i + 2);
      if (two === "//") {
        while (i < src.length && src[i] !== "\n") i++;
        continue;
      }
      if (two === "/*") {
        i += 2;
        while (i < src.length && src.slice(i, i + 2) !== "*/") {
          if (src[i] === "\n") out += "\n";
          i++;
        }
        i += 2;
        continue;
      }
      const q = src[i];
      if (q === "\"" || q === "\x27" || q === "`") {
        i++;
        while (i < src.length && src[i] !== q) {
          if (src[i] === "\\") i++;
          i++;
        }
        i++;
        continue;
      }
      out += src[i++];
    }
    let n = 0;
    let at = out.indexOf(needle);
    while (at !== -1) {
      n++;
      at = out.indexOf(needle, at + needle.length);
    }
    console.log(n);
  ' "$1" "$2"
}

check_witness_call_site() {
  local f=components/rtc/state.tsx rc=0
  require() { # require <exact source text> <what it guarantees>
    if [ "$(count_live "$f" "$1")" -ge 1 ]; then
      echo "ok:   $2"
    else
      echo "FAIL: $2"
      echo "      $f has no LIVE occurrence of: $1"
      rc=1
    fi
  }
  # 🔴 `require` pins a DEFINITION. `require_count` pins the INVOCATIONS, and
  # the difference is not academic: a review deleted the `#armDecodeWitness`
  # and `#disarmDecodeWitness` CALLS while every definition-shaped assertion
  # here still printed `ok:`. An assertion that reports a guarantee it does not
  # check is worse than no assertion.
  require_count() { # require_count <what it guarantees> <exact source text> <n>
    local n
    n=$(count_live "$f" "$2")
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
  # 🔴 Solid SKIPS the write when the comparator returns true, so a loosened
  # one freezes the chip on its last value — green, over a peer whose frames
  # are being discarded. Pinned by NAME so the implementation stays in a file
  # a spec can load.
  require 'equals: sameWitness,' \
    "the witness signal's equality is the spec'd comparator"
  # 🔴 The seed is not the read. A round-4 review replaced the chip's read of
  # the signal with an available literal and the gate, every mutation, tsc,
  # eslint and prettier stayed green. Round 5 then measured EIGHT more one-line
  # edits in the same literal that each turned an honest amber or red green.
  #
  # That literal is gone: the derivation now lives in `chipInputs.ts`, which
  # `node --test` loads and `rtc-mutations.py` breaks. What is left in this
  # file is one binding per field with nothing computed among them, so these
  # two assertions are what remains of the six — the assembly is actually used,
  # and gate (d)'s field is bound to the signal.
  #
  # 🔴 NOT closed, and not claimed to be: a lying binding (`rosterVerified:
  # () => []`) is still unreachable by any spec. Taking accessors makes that a
  # function somebody has to write rather than a literal they type, and the
  # surface is 14 one-line bindings instead of 45 lines of derivation — but it
  # is a smaller last mile, not no last mile.
  # 🔴 The composition, not just the call. Asserting `chipInputsFrom({` left
  # the returned object unwatched, and spreading it into a literal that
  # overrode `decodeWitness` and `rosterVerified` passed every assertion here.
  # `chipStateFrom` assembles and judges in one call, so this one literal
  # covers both halves and there is no value in `state.tsx` to intercept.
  require_count "the chip is assembled AND judged by the spec'd module" \
    'return chipStateFrom({' 1
  require 'decodeWitness: () => this.callDecodeWitness(),' \
    "gate (d)'s input is bound to the witness signal, not to a literal"
  require 'const stale = setInterval(() => listener.tick(), listener.checkMs);' \
    "the staleness sweep is started, at the listener's own interval"
  require 'listener.stop();' \
    "teardown tells the listener, so the last sample stops standing"
  require_count "the listener is ARMED when a session is created" \
    'this.#armDecodeWitness(session);' 1
  # THREE sites: the head of #armDecodeWitness, disconnect(), and the room's
  # "disconnected" listener — the last because the SFU dropping us does not run
  # disconnect(), and the witness would otherwise keep refreshing a green over
  # a dead room. Deleting any one of them leaves every definition-shaped
  # assertion above happy, which is why this is a count.
  require_count "re-arm, disconnect() and the SFU drop all DISARM the witness" \
    'this.#disarmDecodeWitness();' 3
  return $rc
}
run "gate (d) call site in state.tsx" 12 check_witness_call_site

# 🔴 The e2ee-worker patch check does NOT live here — see
# scripts/rtc-build-preflight.sh, and run it before any build or live leg.
#
# It was here for one round and that was wrong. This gate judges TREE state:
# every check it runs can be made to pass by editing the commit. Whether the
# shared node_modules resolved a patched package is ENVIRONMENT state, which no
# commit can fix — so parking it here made the gate permanently exit 1 on the
# only box that runs it, and a gate that is always red teaches everyone to read
# "1 failing check" as "the worker thing" and skip past a real second failure.
# That is the same learned-blindness this script's header exists to prevent,
# arrived at from the other direction.

run "tsc --noEmit" 25 "$ROOT/node_modules/.pnpm/node_modules/.bin/tsc" --noEmit
# --check, never --write: reformatting a tracked file sweeps up code this
# branch did not touch.
run "prettier --check" 12 "$ROOT/node_modules/.bin/prettier" --check "${FILES[@]}"
# 0 errors required. THREE solid/reactivity warnings are expected: two in
# state.tsx (one pre-existing, one on the `pauseVerdictReaders(pauseVerdict)`
# call, a false positive — the readers are arrow closures invoked inside
# `createMemo`, so the accessor IS read in a tracked scope) and one in
# VoiceCallDowngradeBanner.tsx, pre-existing and newly VISIBLE because that
# file was only enrolled in FILES after an audit found this branch modifies it
# while nothing linted or formatted it. All left unsuppressed on purpose:
# neither file carries an eslint-disable and a suppression would hide the next
# real one. A FOURTH, not solid/reactivity, arrived with `e2ee.ts` (wave 1 of
# the rejoin-resume plan): @typescript-eslint/no-unused-vars on the unused
# `catch (error)` binding in the encrypted-send path, pre-existing at base
# c219c107 and in no line that wave touched.
#
# 🔴 This gate reads eslint's EXIT STATUS and eslint exits 0 on warnings, so
# this step is WARNING-BLIND by construction. Do not read the count above as
# something enforced — nothing checks it. If you add --max-warnings, four is
# the baseline; until then, this comment is prose and goes stale like all the
# others this file has carried.
run "eslint" 30 "$ROOT/node_modules/.bin/eslint" "${FILES[@]}"

echo
echo "################ GATE SUMMARY: $fails failing check(s) ################"
# Printed unconditionally, pass or fail: this gate cannot see whether the build
# would actually carry the decode witness, and a green tree over an unpatched
# worker is gate (d) silently absent.
echo "NOTE: tree state only. Before any build or live leg, also run:"
echo "      bash scripts/rtc-build-preflight.sh"
exit $fails
