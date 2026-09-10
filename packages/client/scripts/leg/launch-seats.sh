#!/bin/bash
# launch-seats.sh — non-interactive seat launcher for the consent-rejoin media
# leak leg (rejoin-leak-plan.md §2.1 / §2.4, wave 0, lane W0-C).
#
#   packages/client/scripts/leg/launch-seats.sh <command> [options]
#
#   check      verify every rig assumption and exit non-zero if any fails
#   steps      print the OPERATOR-ONLY steps (this script never performs them)
#   subject    launch the PACKAGED media-E2EE seat with the Chromium trace on
#   observer   launch an UNPACKAGED media-E2EE seat (shape (a) observer)
#   carrier    launch an UNPACKAGED seat with fake capture, for the carrier
#
# 🔴 THIS SCRIPT NEVER HANDLES CREDENTIALS. Login, MFA, and the native blocking
# "Turn off encryption" confirm dialog are operator-only BY DESIGN — the
# renderer can neither render nor dismiss that dialog. `steps` prints them; the
# script does not attempt them and has no code path that could.
#
# 🔴 IT IS NOT A BUILD. It never invokes electron-builder, never runs pnpm, and
# never runs mise. An unpackaged `electron .` run is already a genuine
# media-E2EE seat: `--sloga-media-e2ee=1` is injected on
# `process.platform === "linux"` plus command-table membership, NOT on
# `app.isPackaged`.
#
# Verified facts it nonetheless RE-CHECKS at runtime, because a fact that is
# only true at contract-writing time is how a leg gets run on the wrong build:
#   - the shell worktree and its detached commit
#   - frontend-dist staged from frontend 9610166e (BUILD_INFO.txt)
#   - the packaged AppImage exists and is executable
#   - main.js's strip list is still exactly the four remote-debugging names,
#     so --enable-logging / ELECTRON_ENABLE_LOGGING survive into a packaged run
#   - main.js still gates --sloga-media-e2ee on the platform, not on isPackaged
#   - SLOGA_PROFILE is set for any seat that is not the first one, because
#     productName is "Sloga" and an unprofiled run shares ~/.config/Sloga with
#     the packaged install: same login, same e2ee store, one shared
#     requestSingleInstanceLock

set -uo pipefail

SHELL_DIR="${SLOGA_SHELL_DIR:-/home/mcp/sloga-desktop-el4/electron-shell}"
EXPECT_SHELL_COMMIT="${SLOGA_EXPECT_SHELL_COMMIT:-fc4855e4c1b544b8bbaef6fe39317b127a1c95a4}"
EXPECT_FRONTEND_COMMIT="${SLOGA_EXPECT_FRONTEND_COMMIT:-9610166e5be84213dd27f3a61646f0b36f40081e}"
APPIMAGE="${SLOGA_APPIMAGE:-$SHELL_DIR/out/Sloga-0.58.3-linux-x86_64.AppImage}"
LOGDIR="${SLOGA_LEG_LOGDIR:-$HOME/leg-logs}"

fails=0
fail() {
  echo ">>> RIG FAIL: $*" >&2
  fails=$((fails + 1))
}
ok() { echo "    ok: $*"; }

# --- assumption checks -------------------------------------------------------

check_shell_dir() {
  if [ ! -d "$SHELL_DIR" ]; then
    fail "shell worktree $SHELL_DIR does not exist"
    return
  fi
  ok "shell worktree $SHELL_DIR"
  local head
  head=$(git -C "$SHELL_DIR" rev-parse HEAD 2>/dev/null)
  local rc=$?
  if [ $rc -ne 0 ] || [ -z "$head" ]; then
    fail "$SHELL_DIR is not a git checkout (git rev-parse exited $rc)"
  elif [ "$head" != "$EXPECT_SHELL_COMMIT" ]; then
    fail "shell HEAD is $head, expected $EXPECT_SHELL_COMMIT — this is a DIFFERENT shell than the plan pinned"
  else
    ok "shell HEAD $head"
  fi
}

check_frontend_dist() {
  local info="$SHELL_DIR/frontend-dist/BUILD_INFO.txt"
  if [ ! -f "$info" ]; then
    fail "no $info — frontend-dist provenance is unknown, and a leg on an unknown dist proves nothing"
    return
  fi
  local fc
  fc=$(sed -n 's/^frontend_commit=//p' "$info" | head -1)
  if [ "$fc" != "$EXPECT_FRONTEND_COMMIT" ]; then
    fail "frontend-dist was staged from $fc, expected $EXPECT_FRONTEND_COMMIT"
  else
    ok "frontend-dist staged from $fc"
  fi
  local dirty
  dirty=$(sed -n 's/^dirty=//p' "$info" | head -1)
  if [ "$dirty" != "false" ]; then
    fail "frontend-dist was staged from a DIRTY tree (dirty=$dirty) — the bundle does not correspond to a commit"
  else
    ok "frontend-dist staged clean"
  fi
}

check_main_js() {
  local m="$SHELL_DIR/src/main.js"
  if [ ! -f "$m" ]; then
    fail "no $m"
    return
  fi
  # The strip list must still be EXACTLY the four remote-debugging names. If a
  # logging switch ever joins it, the packaged trace route below is dead and
  # this script must not pretend otherwise. Read the array itself, not a count
  # of matches anywhere in the file.
  local strip expect
  strip=$(sed -n '/for (const sw of \[/,/\]) {/p' "$m" | grep -o '"[a-z][a-z-]*"' | tr -d '"' | sort | tr '\n' ' ')
  expect="remote-allow-origins remote-debugging-address remote-debugging-pipe remote-debugging-port "
  if [ "$strip" != "$expect" ]; then
    fail "main.js's strip list is [$strip], expected [$expect] — re-derive the packaged trace route before running a leg"
  else
    ok "strip list is exactly the 4 remote-debugging names, so --enable-logging / ELECTRON_ENABLE_LOGGING survive a packaged run"
  fi
  if grep -q 'process.platform === "linux"' "$m" && grep -q -- '--sloga-media-e2ee=1' "$m"; then
    ok "--sloga-media-e2ee=1 is platform-gated (so an UNPACKAGED run is still a media-E2EE seat)"
  else
    fail "could not find the platform-gated --sloga-media-e2ee=1 injection in main.js — an unpackaged seat may NOT be a media-E2EE seat"
  fi
  if grep -q 'app.isPackaged' "$m" && grep -q -- '--sloga-media-e2ee=1' "$m"; then
    local ctx
    ctx=$(grep -n -B6 -- '--sloga-media-e2ee=1' "$m" | grep -c 'app.isPackaged')
    if [ "$ctx" -ne 0 ]; then
      fail "app.isPackaged now appears within 6 lines above the --sloga-media-e2ee=1 injection — the unpackaged seat assumption must be re-derived"
    fi
  fi
}

check_appimage() {
  if [ ! -f "$APPIMAGE" ]; then
    fail "packaged seat $APPIMAGE does not exist"
    return
  fi
  if [ ! -x "$APPIMAGE" ]; then
    fail "packaged seat $APPIMAGE is not executable"
    return
  fi
  ok "packaged seat $APPIMAGE"
}

check_electron() {
  if [ ! -x "$SHELL_DIR/node_modules/.bin/electron" ]; then
    fail "no $SHELL_DIR/node_modules/.bin/electron — the unpackaged seats cannot start. Do NOT run pnpm or mise to fix this; report it."
  else
    ok "unpackaged runner $SHELL_DIR/node_modules/.bin/electron"
  fi
}

check_display() {
  if [ -z "${DISPLAY:-}" ]; then
    fail "DISPLAY is unset — under WSLg it must be :0"
  else
    ok "DISPLAY=$DISPLAY"
  fi
}

cmd_check() {
  echo "=============== rig check ==============="
  check_shell_dir
  check_frontend_dist
  check_main_js
  check_appimage
  check_electron
  check_display
  echo
  if [ $fails -ne 0 ]; then
    echo "################ RIG CHECK: $fails failing assumption(s) ################" >&2
    return 1
  fi
  echo "################ RIG CHECK: all assumptions hold ################"
  return 0
}

require_ok() {
  cmd_check >/dev/null 2>&1
  local rc=$?
  if [ $rc -ne 0 ]; then
    # `fails` is a global that the silenced run already incremented; reset it
    # so the visible re-run reports the true count rather than double it.
    fails=0
    cmd_check
    echo ">>> refusing to launch a seat on a rig whose assumptions do not hold" >&2
    exit 1
  fi
}

# --- seats -------------------------------------------------------------------

usage_seat() {
  cat <<'USAGE'
  --profile <name>     SLOGA_PROFILE for this seat. REQUIRED for every seat
                       except the first: productName is "Sloga", so an
                       unprofiled run shares ~/.config/Sloga with the packaged
                       install (same login, same e2ee store, one shared
                       requestSingleInstanceLock). 🔴 A profiled seat is CLEAN
                       but UNPROVISIONED and needs an operator login.
  --log <path>         Chromium log file (subject seat; default under
                       $SLOGA_LEG_LOGDIR).
  --log-mode file|stderr
                       Current Chromium needs --enable-logging=file for
                       --log-file to apply; =stderr is the fallback.
  --audio-file <wav>   Loop a wav into the fake capture device (carrier seat).
  --no-fake-device     Do not pass the fake-device flags.
  --dry-run            Print the exact command and env, launch nothing.
USAGE
}

launch() {
  local label="$1"
  shift
  echo "=============== launching $label ==============="
  echo "  env : $LAUNCH_ENV"
  echo "  cmd : $*"
  if [ "${DRY_RUN:-0}" = "1" ]; then
    echo "  (dry run — nothing launched)"
    return 0
  fi
  # shellcheck disable=SC2086
  env $LAUNCH_ENV "$@" &
  echo "  pid : $!"
}

cmd_subject() {
  local profile="" log="" mode="file"
  DRY_RUN=0
  while [ $# -gt 0 ]; do
    case "$1" in
    --profile) profile="$2"; shift 2 ;;
    --log) log="$2"; shift 2 ;;
    --log-mode) mode="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
    esac
  done
  require_ok
  mkdir -p "$LOGDIR" || { echo "cannot create $LOGDIR" >&2; exit 1; }
  [ -n "$log" ] || log="$LOGDIR/subject-$(date +%Y%m%d-%H%M%S).log"
  if [ "$mode" != "file" ] && [ "$mode" != "stderr" ]; then
    echo ">>> --log-mode must be file or stderr" >&2
    exit 2
  fi
  LAUNCH_ENV="ELECTRON_ENABLE_LOGGING=1"
  [ -n "$profile" ] && LAUNCH_ENV="$LAUNCH_ENV SLOGA_PROFILE=$profile"
  echo "  trace: $log"
  echo "  🔴 the SUBJECT seat is PACKAGED: no DevTools, no CDP, no sampler."
  echo "     Its only instrument is this [gate-trace] log. If the log has no"
  echo "     [gate-trace] lines after the leg, the run has no M2/M3 and the"
  echo "     reducer will say so — do not fill it in from the timeline."
  if [ "$mode" = "file" ]; then
    launch "SUBJECT (packaged)" "$APPIMAGE" "--enable-logging=file" "--log-file=$log" "--v=1"
  else
    launch "SUBJECT (packaged, stderr)" "$APPIMAGE" "--enable-logging=stderr" "--v=1"
  fi
}

cmd_unpackaged() {
  local label="$1" devtools="$2"
  shift 2
  local profile="" fake=1 audio=""
  DRY_RUN=0
  while [ $# -gt 0 ]; do
    case "$1" in
    --profile) profile="$2"; shift 2 ;;
    --audio-file) audio="$2"; shift 2 ;;
    --no-fake-device) fake=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
    esac
  done
  require_ok
  if [ -z "$profile" ]; then
    echo ">>> RIG FAIL: --profile is REQUIRED for a $label seat. productName is \"Sloga\", so an unprofiled unpackaged run shares ~/.config/Sloga with the packaged install (same login, same e2ee store) and collides on requestSingleInstanceLock." >&2
    exit 1
  fi
  LAUNCH_ENV="SLOGA_PROFILE=$profile"
  [ "$devtools" = "devtools" ] && LAUNCH_ENV="$LAUNCH_ENV SLOGA_DEVTOOLS=1"
  local -a flags=()
  if [ "$fake" = "1" ]; then
    flags+=("--use-fake-device-for-media-stream" "--use-fake-ui-for-media-stream")
    if [ -n "$audio" ]; then
      if [ ! -f "$audio" ]; then
        echo ">>> RIG FAIL: --audio-file $audio does not exist" >&2
        exit 1
      fi
      flags+=("--use-file-for-fake-audio-capture=$audio")
      echo "  carrier audio: $audio (looped by Chromium)"
    fi
    echo "  🔴 fake-device flags are for NON-SUBJECT seats only."
    echo "     Carrier continuity is NOT assumed from these flags — it is"
    echo "     MEASURED from the carrier byte series by the sampler, and a run"
    echo "     whose carrier series is not continuous is discarded."
  fi
  echo "  🔴 this seat is CLEAN but UNPROVISIONED: it needs an operator login."
  ( cd "$SHELL_DIR" && launch "$label (unpackaged)" "./node_modules/.bin/electron" "." "${flags[@]}" )
}

cmd_steps() {
  cat <<'STEPS'
=============== OPERATOR-ONLY STEPS — this script performs NONE of them ===============

Automatable (this script does these): launching the seats, the fake-capture
flags on non-subject seats, the carrier audio loop, the packaged [gate-trace]
log, and the post-hoc reduction.

🔴 OPERATOR-ONLY, BY DESIGN. Claude never does any of these and this script has
no code path that could:

  O1. All credential entry on every seat (username, password).
  O2. The MFA ticket prompt.
  O3. The native blocking "Turn off encryption" confirm dialog. The renderer
      can NEITHER render NOR dismiss it — that is the whole point of it being
      native. Only a human at the machine can answer it.
  O4. Pressing leave, and pressing rejoin.
  O5. SPEAKING on the subject seat, continuously, from before the rejoin is
      pressed until well after it completes. The leak window is 1-3 s wide; a
      subject who starts talking after the rejoin lands measures nothing.
  O6. Listening on the shape-(b) manager-free web observer and reporting
      honestly whether the subject was INTELLIGIBLE. That ear is the primary
      M1 instrument. "I think I heard something" is `unknown`, not `yes`.

--------------------------------------------------------------------------------
RUN ORDER

  1. ./launch-seats.sh check                      (must exit 0)
  2. ./launch-seats.sh subject --log <path>
       operator: O1, O2 on the subject seat.
  3. ./launch-seats.sh carrier --profile carrier --audio-file <wav>
       operator: O1, O2 on the carrier seat (it is unprovisioned).
  4. shape (a): ./launch-seats.sh observer --profile observer
     shape (b): the operator opens the WEB client in Chrome. 🔴 Shape (b)'s
       observer MUST be the browser: a browser has e2eeCapable === false, so it
       has NO e2eeManager and NO decode transform, and it is the ONLY seat on
       which M1 can be answered at all. Shape (b) therefore needs THREE seats;
       carrier and observer cannot be the same seat there.
  5. In the OBSERVER's devtools console, BEFORE it joins the call, paste
     observer-sampler.js. Then join, then:
       SLOGA_LEG.roles()
       SLOGA_LEG.carrier("<the sid whose energy is rising while the subject is silent>")
       SLOGA_LEG.start({ label: "<shape>-<consent|noconsent>-run<N>", shape: "a"|"b" })
  6. Operator runs the leg: O3 (consent runs only), O4, O5.
  7. SLOGA_LEG.stop(); SLOGA_LEG.summary(); SLOGA_LEG.save()
  8. node gate-trace-reduce.mjs --sampler <dump.json> --log <subject.log> \
       --shape a|b --audible-subject yes|no|unknown

--------------------------------------------------------------------------------
🔴 RULES THAT DECIDE WHETHER THE LEG MEANS ANYTHING

  - The carrier MUST talk continuously for the whole leg. Any run whose carrier
    byte series is not continuous across the measurement window is DISCARDED,
    NOT INTERPRETED. Two runs this session were discarded for this and one was
    reported as a PASS before the operator revealed the carrier had stopped.
  - "Is it paused" is read from BYTES ONLY. A held gate pauses via
    pauseUpstream() and the remote track then reads muted:false, enabled:false
    with zero RTP. The mute flag has already produced one false PASS here.
  - bytesReceived can NEVER establish plaintext. The discriminator is audio
    energy on a manager-free seat.
  - 5 runs with consent and 5 without, in EACH shape. The two series are never
    pooled and their byte series are never compared across shapes. If operator
    budget forces a cut, cut shape (a) — never shape (b).
  - Record the run label on the sampler dump AND in the subject log filename so
    the two can be paired afterwards without guessing.
STEPS
}

case "${1:-}" in
check) shift; cmd_check ;;
steps) shift; cmd_steps ;;
subject) shift; cmd_subject "$@" ;;
observer) shift; cmd_unpackaged "OBSERVER" devtools "$@" ;;
carrier) shift; cmd_unpackaged "CARRIER" nodevtools "$@" ;;
*)
  cat <<EOF
launch-seats.sh <check|steps|subject|observer|carrier> [options]
EOF
  usage_seat
  exit 2
  ;;
esac
