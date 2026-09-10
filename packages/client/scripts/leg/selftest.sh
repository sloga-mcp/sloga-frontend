#!/bin/bash
# selftest.sh — the known-bad-control harness for lane W0-C's three leg tools.
#
#   packages/client/scripts/leg/selftest.sh [workdir]
#
# 🔴 THE CONTROL COMES FIRST. Every check below is run against a deliberately
# corrupted, truncated or dead-carrier input BEFORE it is trusted on a good
# one. A check that has never failed is not evidence — five control attempts in
# this slice passed when they should have failed.
#
# It judges each case on the tool's EXIT STATUS and on a required substring of
# its OUTPUT, never on a grep of a summary line, and never through a pipe (a
# `cmd | tail` makes $? tail's, and `set -o pipefail` plus `grep -q` inverts an
# assertion so that it fails BECAUSE it matched). Output is captured to a file
# first; the status is captured immediately; only then is the output read.
#
# Exit status: the number of failing controls. 0 means every known-bad input
# was rejected AND every good input was accepted.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${1:-${TMPDIR:-/tmp}/w0c_selftest.$$}"
mkdir -p "$WORK" || exit 99
REDUCE="$HERE/gate-trace-reduce.mjs"
fails=0

note_fail() {
  echo ">>> CONTROL FAIL: $*"
  fails=$((fails + 1))
}

# case <name> <expected-exit> <expected-substring|-> -- <cmd...>
case_run() {
  local name="$1" want="$2" needle="$3"
  shift 4 # name, want, needle, "--"
  local out="$WORK/$(echo "$name" | tr -c 'A-Za-z0-9' '_').out"
  "$@" >"$out" 2>&1
  local rc=$?
  local verdict="ok"
  if [ "$rc" -ne "$want" ]; then
    verdict="bad"
    note_fail "$name: exit $rc, expected $want"
  fi
  if [ "$needle" != "-" ] && ! grep -qF -- "$needle" "$out"; then
    verdict="bad"
    note_fail "$name: output does not contain $needle (see $out)"
  fi
  if [ "$verdict" = "ok" ]; then
    echo "  CONTROL PASS  $name (exit $rc)"
  else
    echo "  ---- captured output of $name ----"
    sed -n '1,40p' "$out"
    echo "  ----------------------------------"
  fi
}

echo "############ W0-C self-test — workdir $WORK ############"
echo
echo "=== stage 1: drive observer-sampler.js and emit the fixtures ==="
node "$HERE/selftest-sampler.mjs" "$WORK"
rc=$?
if [ $rc -ne 0 ]; then
  note_fail "selftest-sampler.mjs exited $rc — the sampler's own refusals did not all hold"
fi
echo

# The controls must DIFFER from the real input. A control that is byte-identical
# to the good input proves nothing at all.
echo "=== stage 2: prove each control differs from the good input ==="
for f in sampler-truncated.json sampler-empty.json sampler-wrongschema.json sampler-zeroticks.json sampler-deadcarrier.json sampler-bytesonly.json; do
  if [ ! -f "$WORK/$f" ]; then
    note_fail "fixture $f was not produced"
    continue
  fi
  if cmp -s "$WORK/sampler-plaintext.json" "$WORK/$f"; then
    note_fail "$f is BYTE-IDENTICAL to the good input — it is not a control"
  else
    echo "  CONTROL PASS  $f differs from the good input"
  fi
done
echo

echo "=== stage 3: the reducer must REJECT known-bad inputs ==="

case_run "R1 empty sampler file" 3 "is EMPTY" -- \
  node "$REDUCE" --sampler "$WORK/sampler-empty.json" --shape b

case_run "R2 truncated sampler JSON" 3 "not valid JSON" -- \
  node "$REDUCE" --sampler "$WORK/sampler-truncated.json" --shape b

case_run "R3 wrong sampler schema" 3 "expected sloga-leg-sampler/1" -- \
  node "$REDUCE" --sampler "$WORK/sampler-wrongschema.json" --shape b

case_run "R4 zero ticks" 3 "ZERO ticks" -- \
  node "$REDUCE" --sampler "$WORK/sampler-zeroticks.json" --shape b

case_run "R5 missing sampler file" 3 "cannot read sampler dump" -- \
  node "$REDUCE" --sampler "$WORK/does-not-exist.json" --shape b

case_run "R6 no --shape" 3 "--shape a|b is required" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json"

case_run "R7 shape declared b, reduced as a" 3 "refusing to reduce a run under the wrong shape" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape a

case_run "R8 empty log file" 3 "refusing to report" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --log /dev/null

echo
echo "=== stage 4: a DEAD CARRIER is discarded, not interpreted ==="
case_run "R9 dead carrier => exit 4, DISCARDED" 4 "DISCARDED          : YES" -- \
  node "$REDUCE" --sampler "$WORK/sampler-deadcarrier.json" --shape b --audible-subject yes
case_run "R9b dead carrier selects NO row even with the operator saying 'audible'" 4 "selects no row" -- \
  node "$REDUCE" --sampler "$WORK/sampler-deadcarrier.json" --shape b --audible-subject yes

echo
echo "=== stage 5: bytes ALONE can never establish plaintext ==="
# Identical byte series to the plaintext run; the energy fields are ABSENT.
case_run "R10 bytes flowing, energy fields missing => M1 unknown" 0 "M1 (plaintext?)   : unknown" -- \
  node "$REDUCE" --sampler "$WORK/sampler-bytesonly.json" --shape b --audible-subject unknown
case_run "R10b the same run under --require-verdict => exit 5" 5 "-" -- \
  node "$REDUCE" --sampler "$WORK/sampler-bytesonly.json" --shape b --audible-subject unknown --require-verdict
case_run "R10c a missing field is reported as missing, not as flat" 0 "A missing field is not flatness" -- \
  node "$REDUCE" --sampler "$WORK/sampler-bytesonly.json" --shape b --audible-subject unknown

echo
echo "=== stage 6: ciphertext needs a SAME-TICK POSITIVE CONTROL ==="
case_run "R11 flat energy + climbing concealment + rising carrier => ciphertext" 0 "M1 (plaintext?)   : ciphertext" -- \
  node "$REDUCE" --sampler "$WORK/sampler-ciphertext.json" --shape b --audible-subject no
case_run "R11b the SAME shape with a FLAT carrier (no positive control) => unknown" 0 "M1 (plaintext?)   : unknown" -- \
  node "$REDUCE" --sampler "$WORK/sampler-nocontrol.json" --shape b --audible-subject no

echo
echo "=== stage 7: shape (a) can never select a row ==="
case_run "R12 shape (a) => M1 unknown" 0 "M1 (plaintext?)   : unknown" -- \
  node "$REDUCE" --sampler "$WORK/sampler-shapea.json" --shape a --audible-subject yes
case_run "R12b shape (a) => no row" 0 "never SELECT one" -- \
  node "$REDUCE" --sampler "$WORK/sampler-shapea.json" --shape a --audible-subject yes

echo
echo "=== stage 8: a degraded / truncated [gate-trace] log yields unknown, not a guess ==="
case_run "R13 [object Object] payloads => M2 unknown" 0 "M2 (real leave?)  : unknown" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --audible-subject yes \
  --log "$WORK/trace-objectobject.log"
case_run "R13b and the degradation is REPORTED, not silent" 0 "collapsed the object argument" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --audible-subject yes \
  --log "$WORK/trace-objectobject.log"
case_run "R13c a degraded log selects NO row" 0 "no row" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --audible-subject yes \
  --log "$WORK/trace-objectobject.log"
case_run "R14 a truncated log line is reported as unrecoverable" 0 "DEGRADED [gate-trace] lines" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --audible-subject yes \
  --log "$WORK/trace-truncated.log"
case_run "R15 a log with no records at all still yields no M2 guess" 0 "M2 (real leave?)  : unknown" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --audible-subject yes \
  --log "$WORK/trace-empty-of-records.log"

echo
echo "=== stage 8b: fiducial disagreement discards the run ==="
# Same capture, same records — only the -negotiating edge is moved 900 ms off
# the observer's SSRC change. The run must be discarded rather than aligned by
# assumption.
case_run "R16 fiducials disagree beyond one sampling interval => exit 4" 4 "unaligned" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --audible-subject yes \
  --log "$WORK/trace-unaligned.log"
case_run "R16b an UNVERIFIED alignment is NOT treated as unaligned" 0 "UNVERIFIED" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --audible-subject yes \
  --log "$WORK/trace-empty-of-records.log"
if cmp -s "$WORK/trace-c0.log" "$WORK/trace-unaligned.log"; then
  note_fail "R16 control trace-unaligned.log is BYTE-IDENTICAL to trace-c0.log — it is not a control"
else
  echo "  CONTROL PASS  trace-unaligned.log differs from trace-c0.log"
fi

echo
echo "=== stage 9: the GOOD inputs must now be ACCEPTED (otherwise the checks above are vacuous) ==="
case_run "G1 plaintext + C0 trace => plaintext" 0 "M1 (plaintext?)   : plaintext" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --audible-subject yes \
  --log "$WORK/trace-c0.log"
case_run "G2 plaintext + C0 trace => C0 selected" 0 "DECISION (§2.5)   : C0" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --audible-subject yes \
  --log "$WORK/trace-c0.log"
case_run "G3 plaintext + C0 trace => M2 positively witnessed as a real disconnect" 0 "M2 (real leave?)  : disconnect-ran" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --audible-subject yes \
  --log "$WORK/trace-c0.log"
case_run "G4 in-place arm + empty set => C1 selected" 0 "DECISION (§2.5)   : C1" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --audible-subject yes \
  --log "$WORK/trace-c1.log"
case_run "G5 in-place arm is positively witnessed, not inferred from silence" 0 "M2 (real leave?)  : no-disconnect" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --audible-subject yes \
  --log "$WORK/trace-c1.log"
case_run "G6 --out writes a report" 0 "-" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --audible-subject yes \
  --log "$WORK/trace-c0.log" --out "$WORK/report.json"
if [ ! -s "$WORK/report.json" ]; then
  note_fail "G6 --out produced a MISSING or ZERO-BYTE report"
else
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$WORK/report.json"
  rc=$?
  if [ $rc -ne 0 ]; then
    note_fail "G6 --out produced a report that is not valid JSON (exit $rc)"
  else
    echo "  CONTROL PASS  G6 --out wrote $(wc -c <"$WORK/report.json") bytes of valid JSON"
  fi
fi

# The M3 coverage table is the one output that says which fields were
# UNREADABLE. It is built with Sets, and JSON.stringify renders a Set as `{}` —
# which would silently empty exactly that table in the machine-readable report.
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const cov = r.M3 && r.M3.coverage;
if (!cov || Object.keys(cov).length === 0) { console.error("coverage table is EMPTY in the JSON report"); process.exit(1); }
for (const [k, v] of Object.entries(cov)) {
  if (!Array.isArray(v.via)) { console.error("coverage." + k + ".via is not an array: " + JSON.stringify(v)); process.exit(1); }
}
console.log("  coverage keys in the JSON report: " + Object.keys(cov).join(", "));
' "$WORK/report.json"
rc=$?
if [ $rc -ne 0 ]; then
  note_fail "G7 the JSON report's M3 coverage table did not survive serialization (exit $rc)"
else
  echo "  CONTROL PASS  G7 the JSON report's M3 coverage table survives serialization"
fi

echo
echo "=== stage 10: the launcher must FAIL LOUDLY on a broken rig ==="
FAKESHELL="$WORK/fakeshell"
mkdir -p "$FAKESHELL"
case_run "L1 nonexistent shell worktree => exit 1" 1 "does not exist" -- \
  env SLOGA_SHELL_DIR="$WORK/no-such-dir" SLOGA_APPIMAGE="$WORK/no-such.AppImage" \
  bash "$HERE/launch-seats.sh" check
case_run "L2 shell dir with no BUILD_INFO / no AppImage => exit 1" 1 "frontend-dist provenance is unknown" -- \
  env SLOGA_SHELL_DIR="$FAKESHELL" SLOGA_APPIMAGE="$FAKESHELL/nope.AppImage" \
  bash "$HERE/launch-seats.sh" check
case_run "L3 an unpackaged seat with NO --profile is refused" 1 "--profile is REQUIRED" -- \
  bash "$HERE/launch-seats.sh" carrier --dry-run
case_run "L4 steps names the native confirm dialog as operator-only" 0 "Turn off encryption" -- \
  bash "$HERE/launch-seats.sh" steps
case_run "L5 steps never asks anyone to hand credentials to a script" 0 "All credential entry" -- \
  bash "$HERE/launch-seats.sh" steps

echo
echo "############ W0-C self-test: $fails failing control(s) ############"
exit $fails
