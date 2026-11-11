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
#             `tests - skipped`, and `fail` to be 0. This column is 0 on
#             every row, and must be: the only skip this gate accepts is an
#             opt-in one, pinned in OPT_IN_SKIPS below.
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
  "components/rtc/mlsAdmitGracePolicy.test.ts 36 0"
  "components/rtc/mlsAdmitPolicy.test.ts 15 0"
  # Re-measured (32 -> 45) by iOS call E2EE phase 2 wave 3: the raw key
  # bytes, the ack-gated local install and its zeroing (L3n).
  "components/rtc/mlsCallKeys.test.ts 45 0"
  # Re-measured (117 -> 132) by wave J: the witness-only amber escalation,
  # the join-window ledger and readiness "paused" (WJ1); 132 -> 139 by Stage
  # 5 fix round F2 (the chip's pausedByServer, M1's unresolved identities,
  # m1's re-arm).
  "components/rtc/mlsCallModePolicy.test.ts 139 0"
  "components/rtc/mlsCallSession.drainfail.test.ts 33 0"
  # Out of alphabetical order on purpose: its sorted slot abuts the
  # `mlsRejoinPolicy` row the rejoin-resume branch bumps, and adjacent edits
  # conflict on merge. Kept beside the late-drain guard's other spec instead.
  "components/rtc/mlsRefetchPolicy.test.ts 39 0"
  "components/rtc/mlsCallSession.escape.test.ts 17 0"
  "components/rtc/mlsCallSession.falsered.test.ts 11 0"
  "components/rtc/mlsCallSession.fleet.test.ts 31 0"
  "components/rtc/mlsCallSession.groupscope.test.ts 19 0"
  # Out of alphabetical order on purpose: its sorted slot sits between the
  # `resume` row (the most often bumped) and the `serveguard` row another
  # branch inserts after. A refused roster leaf: removed, re-pinned, or this
  # device's own removal ending the call, and the bounds at which a leaf
  # that can be neither pinned nor removed replaces the group. First
  # measured at 10; 12 with those two bounds.
  "components/rtc/mlsCallSession.revokedleaf.test.ts 12 0"
  "components/rtc/mlsCallSession.heal.test.ts 7 0"
  "components/rtc/mlsCallSession.joinrace.test.ts 37 0"
  "components/rtc/mlsCallSession.leggrace.test.ts 25 0"
  "components/rtc/mlsCallSession.mailbox.test.ts 13 0"
  "components/rtc/mlsCallSession.resecure.test.ts 23 0"
  "components/rtc/mlsCallSession.resume.test.ts 75 0"
  "components/rtc/mlsCallSession.serveguard.test.ts 7 0"
  "components/rtc/mlsCallSession.sibling.test.ts 5 0"
  "components/rtc/mlsCallSession.timeline.test.ts 4 0"
  # iOS call E2EE phase 2 (wave J + wave 3): the welcome window's drop
  # count, the iOS confirm with no in-app plaintext fallback (R14), the
  # LocalKeyAckError route (R17) and the locked store's hold. All four are
  # matched by the mls*.test.ts glob; first measured at 11, 9, 3 and 5.
  "components/rtc/mlsCallSession.welcomedrop.test.ts 11 0"
  "components/rtc/mlsCallSession.iosconfirm.test.ts 9 0"
  "components/rtc/mlsCallSession.keyack.test.ts 3 0"
  "components/rtc/mlsCallSession.locked.test.ts 5 0"
  # Fix round F3: noteFatalMediaError, the control-origin latch remote
  # evidence never heals. First measured at 6; 9 after the re-review's
  # MAJOR-2 (the fatal latch survives #resetRotationState).
  "components/rtc/mlsCallSession.fatal.test.ts 9 0"
  # Re-measured (14 -> 16) by wave 3: a locked-store envelope is held, not
  # acked and dropped (L3v).
  "components/rtc/mlsDrainPolicy.test.ts 16 0"
  "components/rtc/mlsJoinRequestPolicy.test.ts 4 0"
  "components/rtc/mlsJoinTimeline.test.ts 10 0"
  # Which refused roster leaves a session may remove or re-pin. First
  # measured at 26.
  "components/rtc/mlsLeafRejectionPolicy.test.ts 26 0"
  "components/rtc/mlsNegotiatingFailsafe.test.ts 13 0"
  "components/rtc/mlsRejoinPolicy.test.ts 54 0"
  "components/rtc/mlsSessionSetupPolicy.test.ts 19 0"
  "components/rtc/rosterReconcile.test.ts 34 0"
  "components/rtc/localPublicationEncryption.test.ts 10 0"
  "components/rtc/plaintextCryptorPolicy.test.ts 12 0"
  "components/rtc/publishGate.test.ts 70 0"
  "components/rtc/publishGateEpisode.test.ts 76 0"
  "components/rtc/pauseVerdict.test.ts 10 0"
  "components/rtc/micPipelinePolicy.test.ts 4 0"
  # Push to talk's "muted unless the key is held" on the join, Unmute,
  # Undeafen and the whisper restore, and its state.tsx pins. First measured
  # at 19; 21 after its review added the muted capture's stop and clear pins;
  # 41 with the capture bound, the post-landing re-check, the Muted/Deafened
  # talk key and the blur release (fix/ptt-followups, after its review).
  "components/rtc/pttMicPolicy.test.ts 41 0"
  "components/rtc/publishKickPolicy.test.ts 4 0"
  # Re-measured (42 -> 63) by wave 3: the heartbeat's rte and the dead
  # worker path, onDead (L3j).
  "components/rtc/decodeWitnessListener.test.ts 63 0"
  # Re-measured (50 -> 52) by fix round F2: pausedByServer and the present
  # identities.
  "components/rtc/chipInputs.test.ts 52 0"
  "components/rtc/screenAudioWire.test.ts 17 0"
  "components/rtc/screenAudioNativeWin.test.ts 51 0"
  "components/rtc/pauseClauseHold.test.ts 7 0"
  "components/client/mlsInboundBuffer.test.ts 17 0"
  "components/client/mlsEnvelopeClassify.test.ts 13 0"
  "components/client/mlsResumeKeep.test.ts 64 0"
  # Whose device a device deletion removed, as far as a call is concerned
  # (own / peer / ignore). First measured at 13.
  "components/client/deviceDeleteClassifier.test.ts 13 0"
  # Voice changer: the pitch range helpers and the worklet DSP, including the
  # level floors that catch an unaligned (warbling) splice.
  "components/rtc/voicePitch.test.ts 26 0"
  # Call-view suggestions (opt-in screen shares, video-only grid, member
  # moves, opt-in share recording), first measured at 0c672a54; the watch,
  # move and chip counts were re-measured after the final-audit fix rounds.
  # The move, redaction, moderation and wiring rows were re-measured again
  # when the AFK channel merged with member moves (FE-2). The watch row was
  # re-measured (66 -> 68) when Android screen-share audio (slice 4, wave 3a)
  # pinned RoomAudioManager's `isSelfLeg:` so the phone never subscribes to
  # its own leg's audio.
  "components/rtc/screenShareWatchPolicy.test.ts 68 0"
  "components/rtc/voiceMovePolicy.test.ts 53 0"
  "components/rtc/moveEventRedaction.test.ts 7 0"
  "components/rtc/callModerationPolicy.test.ts 22 0"
  "components/rtc/callRecorder.test.ts 25 0"
  "components/ui/components/features/voice/callCard/callTileSelection.test.ts 23 0"
  # Where the call card docks (the Android stuck-card fix and its follow-ups):
  # usable rects, the memo comparators, the docking decision, and the source
  # pins over VoiceCallCard.tsx. First measured at 24.
  "components/ui/components/features/voice/callCard/callCardDock.test.ts 24 0"
  # Source pins over the state.tsx wiring of member moves and the chip's
  # publication read (wave 7): no spec can load state.tsx itself. Re-measured
  # (44 -> 48) by slice 4 wave 3a: the leg connect tail now carries `audio`,
  # and the share sheet's audio offer, request and notices are pinned.
  # Re-measured (48 -> 65) by iOS call E2EE phase 2 wave 3: the probe, the
  # kill switch, the webkit hold, the worker binding and tick, the dead
  # worker, the amber escalation, the backstop and the call audio (L3t).
  # 65 -> 72 by fix round F7: the fetched switch, the chip's pause, the
  # overdue hold, the fatal producers, the pre-session replay, the re-arm,
  # the zeroing and the no-session press; 73 after the re-review's NEW-1 (a
  # wrapped publish in flight stops the overdue clock).
  "components/rtc/stateWiring.test.ts 73 0"
  # The AFK channel and its merge with member moves (FE-2). Before it this
  # gate ran NO AFK spec, and none of the ladder that decides whether a
  # client follows a move. memberGate's opt-in skip is not in its row: see
  # OPT_IN_SKIPS.
  "components/rtc/movePolicy.test.ts 108 0"
  "components/rtc/voiceRejoinPolicy.test.ts 32 0"
  "components/rtc/moveSurfacePins.test.ts 10 0"
  "components/rtc/idlePolicy.test.ts 54 0"
  "components/rtc/afkPolicy.test.ts 20 0"
  "src/interface/channels/memberGate.test.ts 13 0"
  "src/lib/afkChannelSettings.test.ts 51 0"
  # The Android screen-share leg: when a leg may start, and the share tiers.
  # Neither spec ran anywhere before these rows. The start-policy row was
  # re-measured (68 -> 83) by slice 4 wave 3a: the screen-audio truth tables
  # and the TS and Kotlin source pins on the leg's audio track; then 83 -> 85
  # for the screen-audio build flag and the self-mute skip; then 85 -> 97 for
  # the screen track's capture order, its frame gate and its single sender;
  # then 97 -> 105 for the key provider, the SDK version and the stop paths;
  # then 105 -> 118 for the screen unpublish that keeps its transceiver, the
  # leg's participant listener, the audio source's sender check, and the
  # compile gate's JVM test table.
  "components/rtc/androidLegStartPolicy.test.ts 118 0"
  "components/rtc/androidScreenShareTiers.test.ts 3 0"
  # Android screen-share audio (slice 4, wave 3a): the tile's share-audio
  # badge truth table and its ParticipantTile.tsx source pins. First measured
  # at 10.
  "components/rtc/shareAudioBadge.test.ts 10 0"
  # Mid-call microphone-mode switch (push to talk -> voice activity left the
  # mic muted for the rest of the call). First measured at 18.
  "components/rtc/micModePolicy.test.ts 18 0"
  # iOS call E2EE phase 2, wave 3: the new pure modules (the WebKit sender
  # hold and its worker acks, the worker probe, the key-freshness tick, the
  # kill switch, the key-push backstop, the iOS call audio bracket), the
  # livekit patch's hunks, the device readiness's "paused", and the iOS
  # media-E2EE predicates, call-plane locked mapping and gate pins in
  # components/client. None of these ran in this gate before; each row is
  # its first measurement.
  # webkitSenderHold 39 -> 57 (F4: the hold assembly and overdue clock) and
  # iosCallSwitch 7 -> 20 (F1: the fetched switch and the offer helper) in
  # Stage 5 fix round F.
  "components/rtc/webkitSenderHold.test.ts 57 0"
  "components/rtc/workerProbe.test.ts 16 0"
  "components/rtc/keyFreshnessTick.test.ts 10 0"
  "components/rtc/iosCallSwitch.test.ts 20 0"
  "components/rtc/keyPushBackstop.test.ts 35 0"
  "components/rtc/iosCallAudio.test.ts 20 0"
  "components/rtc/livekitPatchHunks.test.ts 23 0"
  "components/rtc/e2eeDeviceReadiness.test.ts 13 0"
  "components/client/e2eePlatform.test.ts 12 0"
  "components/client/e2eeCallPlaneIos.test.ts 8 0"
  # 181 -> 218 by fix round F (L3q: the fetched switch, the offer helper,
  # the prejoin and Settings readers); 218 -> 220 for the Settings card's
  # behaviour (no Always-on before the switch answers; the paused copy),
  # which two `settings-*` mutations survived until then.
  "components/client/e2eeIosGate.test.ts 220 0"
)

# --- skips -------------------------------------------------------------------
#
# A skip is never a pass, and exactly one kind is allowed: an OPT-IN
# cross-check, which a spec runs only when the environment names what it
# checks against, and otherwise skips with that variable's name in the reason.
# One row per spec that has any: `<path> <count> <VARIABLE>`.
#
#   VARIABLE unset or empty — the spec must skip exactly <count> test(s), and
#       every skipped test's reason must name VARIABLE.
#   VARIABLE set — it must skip NONE: the cross-checks ran.
#
# Every other skip fails the gate. EXPECTED's skipped column is 0 on every row
# and a non-zero one is refused (below), so a skip cannot be pinned there to
# make it pass; and the reason check stops an ordinary test skipping in the
# opt-in's place with the count unchanged.
#
# D9: afkWireContract.test.ts (two opt-in skips of the same kind) stays out of
# this gate, by ruling; the AFK lanes run it with the variable set.
OPT_IN_SKIPS=(
  "src/interface/channels/memberGate.test.ts 1 SLOGA_BACKEND_DIR"
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

opt_in_for() { # opt_in_for <spec> — prints "<count> <VARIABLE>", or fails
  local spec="$1" row
  for row in "${OPT_IN_SKIPS[@]}"; do
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
  local opt opt_count opt_var opt_named
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
  # See OPT_IN_SKIPS. The reason check reads the reporter's own skip line,
  # `﹣ <name> (<duration>) # <reason>`, out of the full log.
  if opt=$(opt_in_for "$spec"); then
    opt_count=${opt%% *}
    opt_var=${opt##* }
    opt_named=$(grep -c -E "\) # .*\<${opt_var}\>" "$log")
    if [ -z "${!opt_var:-}" ]; then
      echo "    opt-in: $opt_var is unset, so exactly $opt_count skip(s)" \
        "naming it are expected"
      want_skipped=$((want_skipped + opt_count))
      if [ "$opt_named" -ne "$opt_count" ]; then
        note_fail "$spec: $opt_named skipped test(s) name $opt_var in their" \
          "reason, EXPECTED $opt_count — a skip that is not the opt-in"
      fi
    else
      echo "    opt-in: $opt_var is set, so its cross-check(s) must RUN"
      if [ "$opt_named" -ne 0 ]; then
        note_fail "$spec: $opt_var is set, yet $opt_named test(s) skipped" \
          "naming it"
      fi
    fi
  fi
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

# The manifest itself, before anything runs: no EXPECTED row may pin a skip
# (only OPT_IN_SKIPS allows one), and every opt-in row names a counted spec.
for row in "${EXPECTED[@]}"; do
  case "$row" in
  *" 0") ;;
  *)
    note_fail "EXPECTED row '$row' pins a non-zero skip — a skip is never" \
      "a pass; only OPT_IN_SKIPS may allow one"
    ;;
  esac
done
for row in "${OPT_IN_SKIPS[@]}"; do
  expected_for "${row%% *}" >/dev/null ||
    note_fail "OPT_IN_SKIPS row '$row' names a spec with no EXPECTED row"
done

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
  components/rtc/pttMicPolicy.test.ts
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
  components/client/mlsEnvelopeClassify.test.ts
  components/rtc/voicePitch.test.ts
  # 🔴 Same reason, and the same directory. The kept-group registry decides
  # when a hung-up call's local group is finally deleted and whether a resume
  # may ever claim it; without this literal its spec runs nowhere and its
  # EXPECTED row trips "never ran".
  components/client/mlsResumeKeep.test.ts
  # 🔴 Same reason, and the same directory. The device-deletion classifier
  # decides whether a deletion event ends THIS device's call, removes a
  # peer's leaf, or is ignored; without this literal its spec runs nowhere
  # and its EXPECTED row trips "never ran".
  components/client/deviceDeleteClassifier.test.ts
  # Call-view suggestions. The watch policy decides which remote shares we
  # subscribe to (a share nobody chose to watch must never be pulled); the
  # voice-move policy decides whether a move token is usable here, how a
  # refused move reads, and who may be dragged; the redaction spec keeps the
  # move token (a live SFU credential) out of the SDK's debug event log. It
  # imports the stoat.js SOURCE module, but it is a client spec and runs from
  # here.
  components/rtc/screenShareWatchPolicy.test.ts
  components/rtc/voiceMovePolicy.test.ts
  components/rtc/moveEventRedaction.test.ts
  # Moderation (disconnect / move offer) and opt-in share recording both
  # changed shape in this work and had no gate running them.
  components/rtc/callModerationPolicy.test.ts
  components/rtc/callRecorder.test.ts
  # Outside components/rtc: which tiles the video-only grid shows.
  components/ui/components/features/voice/callCard/callTileSelection.test.ts
  # Same directory: where the call card docks, and the pins holding
  # VoiceCallCard.tsx to that decision.
  components/ui/components/features/voice/callCard/callCardDock.test.ts
  # The state.tsx move and chip wiring, pinned as comment-stripped source.
  components/rtc/stateWiring.test.ts
  # The AFK channel and its merge with member moves (FE-2). The move ladder
  # (whether this client follows a move at all, and how) and the pins over
  # the handler feeding it; the rejoin path the move shares `connect()` with;
  # the member surfaces a move starts from; the idle beacon and AFK policies.
  components/rtc/movePolicy.test.ts
  components/rtc/voiceRejoinPolicy.test.ts
  components/rtc/moveSurfacePins.test.ts
  components/rtc/idlePolicy.test.ts
  components/rtc/afkPolicy.test.ts
  # 🔴 Outside components/rtc, so no glob reaches them: the client-side check
  # gate a move must never walk past, and the AFK settings surfaces (whose
  # spec also pins Overview.tsx's check rules). D9: afkWireContract.test.ts
  # is NOT here, by ruling.
  src/interface/channels/memberGate.test.ts
  src/lib/afkChannelSettings.test.ts
  # 🔴 NOT matched by the mls*.test.ts glob above: the Android screen-share
  # leg's start policy and share tiers. Without these literals both run nowhere.
  components/rtc/androidLegStartPolicy.test.ts
  components/rtc/androidScreenShareTiers.test.ts
  # NOT matched by any glob either: the share-audio badge's spec (slice 4).
  # Without this literal it runs nowhere and its EXPECTED row trips "never
  # ran".
  components/rtc/shareAudioBadge.test.ts
  # NOT matched by any glob: the mid-call microphone-mode switch and its pins
  # over the state.tsx effect that runs it.
  components/rtc/micModePolicy.test.ts
  # 🔴 NOT matched by the mls*.test.ts glob: iOS call E2EE phase 2's pure
  # modules. `mlsCallKeys.test.ts` and `keyFreshnessTick.test.ts` both leave
  # the worker's side of their contract to `livekitPatchHunks.test.ts`, so
  # without these literals that half runs nowhere.
  #
  # 🔴 livekitPatchHunks.test.ts reads ENVIRONMENT state as well as tree
  # state: besides the committed patch text it drives the INSTALLED livekit
  # dist under ../../node_modules. In a worktree whose node_modules resolves
  # an unpatched livekit-client (a symlink into a shared tree that predates
  # the patch) its dist half goes red, and that red is TRUE for any build made
  # from that tree: re-install, do not read past it. Here it runs because no
  # other spec reaches those hunks; see also scripts/rtc-build-preflight.sh.
  components/rtc/webkitSenderHold.test.ts
  components/rtc/workerProbe.test.ts
  components/rtc/keyFreshnessTick.test.ts
  components/rtc/iosCallSwitch.test.ts
  components/rtc/keyPushBackstop.test.ts
  components/rtc/iosCallAudio.test.ts
  components/rtc/livekitPatchHunks.test.ts
  components/rtc/e2eeDeviceReadiness.test.ts
  # 🔴 Outside components/rtc: the iOS media-E2EE predicates, the call-plane
  # locked-phone mapping, and the iOS gate pins over e2ee.ts, the prejoin
  # and the probe.
  components/client/e2eePlatform.test.ts
  components/client/e2eeCallPlaneIos.test.ts
  components/client/e2eeIosGate.test.ts)
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
  components/rtc/pttMicPolicy.ts components/rtc/pttMicPolicy.test.ts
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
  # Enrolled because all three are clean: `prettier --check` and eslint each
  # exit 0 on them, with no warnings (measured when the rejoin-resume plan's
  # wave 2 added the kept-group registry, its spec and the mailbox spec).
  components/client/mlsResumeKeep.ts
  components/client/mlsResumeKeep.test.ts
  components/rtc/mlsCallSession.mailbox.test.ts
  # Enrolled because it is clean: `prettier --check` passes on it (and passed
  # at base c219c107), and eslint exits 0 on it with ONE pre-existing warning
  # (see the eslint step below).
  components/client/e2ee.ts
  # The refused-leaf work's new modules and specs. Enrolled because each is
  # clean: `prettier --check` and `eslint --max-warnings 0` both exit 0 on
  # it, one file at a time (measured at base 41039f32 plus that work).
  # mlsCallSession.ts, its harness and e2ee.ts, which it also edits, were
  # already enrolled above.
  components/rtc/mlsLeafRejectionPolicy.ts
  components/rtc/mlsLeafRejectionPolicy.test.ts
  components/rtc/mlsCallSession.revokedleaf.test.ts
  components/client/deviceDeleteClassifier.ts
  components/client/deviceDeleteClassifier.test.ts
  # Enrolled because it is clean: `prettier --check` and eslint each exit 0
  # on it, with no warnings (measured when the rejoin-resume plan's wave 3
  # added the resume spec).
  components/rtc/mlsCallSession.resume.test.ts
  # Call-view suggestions. Enrolled because every file here is clean:
  # `prettier --check` exits 0 and `eslint --max-warnings 0` exits 0 on each,
  # one file at a time (measured at 0c672a54). The policies and their specs:
  components/rtc/screenShareWatchPolicy.ts
  components/rtc/screenShareWatchPolicy.test.ts
  components/rtc/voiceMovePolicy.ts components/rtc/voiceMovePolicy.test.ts
  components/rtc/voiceMoveDrag.ts components/rtc/moveEventRedaction.test.ts
  components/rtc/callModerationPolicy.ts
  components/rtc/callModerationPolicy.test.ts
  # Voice changer. Enrolled because both are clean: `prettier --check` and
  # eslint each exit 0 on them, with no warnings.
  components/rtc/voicePitch.ts components/rtc/voicePitch.test.ts
  components/rtc/callRecorder.ts components/rtc/callRecorder.test.ts
  components/rtc/stateWiring.test.ts components/rtc/sourcePins.harness.ts
  components/ui/components/features/voice/callCard/callTileSelection.ts
  components/ui/components/features/voice/callCard/callTileSelection.test.ts
  # The call card's dock module, its spec, and the card that uses both.
  # Enrolled because each is clean: `prettier --check` and `eslint
  # --max-warnings 0` both exit 0 on it, one file at a time (measured on the
  # stuck-card follow-ups branch).
  components/ui/components/features/voice/callCard/callCardDock.ts
  components/ui/components/features/voice/callCard/callCardDock.test.ts
  components/ui/components/features/voice/callCard/VoiceCallCard.tsx
  # The files this work edits to wire those policies in. Same rule as
  # VoiceCallDowngradeBanner.tsx above: a file the branch modifies is linted
  # and formatted, or nothing is. RoomAudioManager.tsx failed `prettier
  # --check` before 0c672a54 fixed it; it is clean now.
  components/rtc/components/RoomAudioManager.tsx components/rtc/index.ts
  components/ui/components/features/voice/callCard/ParticipantTile.tsx
  components/ui/components/features/voice/callCard/VoiceCallCardActiveRoom.tsx
  components/ui/components/features/voice/callCard/VoiceCallCardPiP.tsx
  components/ui/components/features/voice/callCard/VoiceMoveNotices.tsx
  components/ui/components/features/voice/VoiceChannelPreview.tsx
  components/app/menus/UserContextMenu.tsx
  components/state/stores/Voice.ts
  src/interface/navigation/channels/ServerSidebar.tsx
  # The AFK channel and its merge with member moves (FE-2): the pure modules
  # and specs that work added or edited. Enrolled because each is clean:
  # `prettier --check` and `eslint --max-warnings 0` both exit 0 on it, one
  # file at a time (measured in FE-2 wave C).
  components/rtc/movePolicy.ts components/rtc/movePolicy.test.ts
  components/rtc/voiceRejoinPolicy.test.ts
  components/rtc/idlePolicy.ts components/rtc/idlePolicy.test.ts
  components/rtc/moveSurfacePins.test.ts
  src/interface/channels/memberGate.ts
  src/interface/channels/memberGate.test.ts
  src/lib/afkChannelSettings.test.ts
  # The Android screen-share leg's modules and specs, added, edited or newly
  # enrolled (the tiers pair is unedited). Enrolled because each is clean:
  # `prettier --check` and `eslint --max-warnings 0` both exit 0 on it, one
  # file at a time (measured in the leg plan's wave 2, over waves 1a/1b).
  components/rtc/androidLegStartPolicy.ts
  components/rtc/androidLegStartPolicy.test.ts
  components/rtc/androidScreenShare.ts
  components/rtc/androidScreenShareTiers.ts
  components/rtc/androidScreenShareTiers.test.ts
  components/rtc/mlsAdmitGracePolicy.ts
  components/rtc/mlsAdmitGracePolicy.test.ts
  components/rtc/mlsCallKeys.ts components/rtc/mlsCallKeys.test.ts
  components/rtc/mlsCallSession.leggrace.test.ts
  # The roster policy and its spec, edited by the leg plan's wave 4 (an
  # unfolded leg with zero publications is inert). Enrolled because both are
  # clean: `prettier --check` and `eslint --max-warnings 0` both exit 0 on
  # each, one file at a time (measured in wave 4c-ii).
  components/rtc/mlsRosterPolicy.ts components/rtc/rosterReconcile.test.ts
  # Android screen-share audio (slice 4): the share sheet's audio offer, the
  # modal props carrying it, the build flag in env.ts, and the tile badge's
  # pure module and spec. Enrolled because each is clean: `prettier --check`
  # and `eslint --max-warnings 0` both exit 0 on it, one file at a time
  # (measured in slice 4 wave 3b, over waves 1-3a). state.tsx,
  # androidScreenShare.ts, ParticipantTile.tsx and RoomAudioManager.tsx, which
  # the slice also edits or pins, were already enrolled above.
  components/modal/modals/AndroidScreenShareSheet.tsx
  components/modal/types.ts components/common/lib/env.ts
  components/rtc/shareAudioBadge.ts components/rtc/shareAudioBadge.test.ts
  # Mid-call microphone-mode switch: the pure plan and its spec.
  components/rtc/micModePolicy.ts components/rtc/micModePolicy.test.ts
  # iOS call E2EE phase 2 (wave 3 + wave J): every new or changed call-plane
  # .ts file not already enrolled above. Enrolled because each is clean:
  # `prettier --check` and `eslint --max-warnings 0` both exit 0 on it, one
  # file at a time (measured in wave 3c, L3u). mlsCallSession.ts, its
  # harness, mlsCallModePolicy.ts, mlsCallKeys.ts, decodeWitnessListener.ts,
  # state.tsx, e2ee.ts, the banner and their specs were already enrolled.
  components/rtc/webkitSenderHold.ts components/rtc/webkitSenderHold.test.ts
  components/rtc/workerProbe.ts components/rtc/workerProbe.test.ts
  components/rtc/keyFreshnessTick.ts components/rtc/keyFreshnessTick.test.ts
  components/rtc/iosCallSwitch.ts components/rtc/iosCallSwitch.test.ts
  components/rtc/keyPushBackstop.ts components/rtc/keyPushBackstop.test.ts
  components/rtc/iosCallAudio.ts components/rtc/iosCallAudio.test.ts
  components/rtc/livekitPatchHunks.test.ts
  components/rtc/e2eeDeviceReadiness.ts
  components/rtc/e2eeDeviceReadiness.test.ts
  components/rtc/mlsDrainPolicy.ts
  components/rtc/mlsCallSession.welcomedrop.test.ts
  components/rtc/mlsCallSession.iosconfirm.test.ts
  components/rtc/mlsCallSession.keyack.test.ts
  components/rtc/mlsCallSession.locked.test.ts
  components/rtc/mlsCallSession.fatal.test.ts
  components/client/e2eePlatform.ts components/client/e2eePlatform.test.ts
  components/client/e2eeCallPlaneIos.ts
  components/client/e2eeCallPlaneIos.test.ts
  components/client/e2eeIosGate.test.ts
  components/ui/components/features/voice/useCallPrejoinMode.ts)
# 🔴 NOT in FILES: components/rtc/mlsDrainPolicy.test.ts. Wave 3 edits it
# (L3v), but it fails `prettier --check` at base 7de02a68 (18 prettier/prettier
# warnings, in lines that wave did not touch), so enrolling it would either
# turn this gate permanently red or force a whole-file reformat. Its policy,
# mlsDrainPolicy.ts, is clean and enrolled; tsc still type-checks the spec,
# and its EXPECTED row above still runs and counts it.
# 🔴 NOT in FILES: components/app/interface/settings/user/Encryption.tsx. Fix
# round F6 (L3w) edits it, but eslint reports four solid/components-return-once
# warnings on it, the same four present at base 7de02a68 in lines that round
# did not touch. `prettier --check` is clean on it, tsc type-checks it, and
# e2eeIosGate.test.ts pins its switch reading (and rtc-mutations.py's
# `settings-*` entries break it).
# 🔴 NOT in FILES: components/app/interface/settings/channel/Overview.tsx.
# FE-2 edits it (the AFK channel's check rules), but eslint reports two
# pre-existing solid/reactivity warnings on it, present before that edit in
# lines it did not touch. Same call as src/Interface.tsx below: enrolling it
# would only raise the prose baseline. `prettier --check` is clean on it, tsc
# still type-checks it, and afkChannelSettings.test.ts pins its rules.
# 🔴 NOT in FILES: src/lib/afkWireContract.test.ts, edited by FE-2 but kept
# out of this gate entirely by ruling (D9), specs and formatting alike.
# 🔴 NOT in FILES: src/Interface.tsx. This work adds 4 lines to it, but eslint
# reports two pre-existing solid/components-return-once warnings on it (both
# present at base 3e9df3e8, in lines the work did not touch). The eslint step
# below is warning-blind, so enrolling it would only raise the prose baseline;
# `prettier --check` is clean on it and tsc still type-checks it.
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
  # `chipStateFrom` assembled and judged in one call, so one literal covered
  # both halves and there was no value in `state.tsx` to intercept.
  #
  # Wave J (iOS call E2EE phase 2) put gate (d)'s time bound on top: the chip
  # is now `WitnessAmberEscalation.judge(chipInputsFrom(sources), now)`, over
  # an accessor bag NAMED `sources` (the literal, nothing derived). So the
  # pins are the bag's declaration, the one return that judges it, and ONE
  # live `chipInputsFrom(` call: a second call elsewhere, or a spread at this
  # one, is a second chip nobody judged.
  #
  # 🔴 NOT closed: `ChipSources` is not readonly, so a property write
  # (`sources.decodeWitness = …`) between the two pinned lines passes all
  # three. Same last-mile class as the lying binding above.
  require_count "the accessor bag is declared once, as a literal" \
    'const sources: ChipSources = {' 1
  require_count "the chip is assembled AND judged by the spec'd modules" \
    'return this.#witnessAmber.judge(chipInputsFrom(sources), performance.now());' 1
  require_count "nothing else assembles chip inputs" 'chipInputsFrom(' 1
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

# 🔴 Every native call-state read in the session goes through
# `#callStateClassified`. Native refuses the WHOLE roster at the first leaf
# its pins reject, so a read that skips the wrapper sees that refusal and
# never feeds it to the leaf classifier: the leaf is never removed or
# re-pinned through that path, and every read of the group keeps failing
# while every spec that happens to take another path stays green. The
# wrapper itself holds the ONE direct read, so the live count is exactly 1.
#
# Two needles, both required at exactly 1. `bridge.callState(` is the direct
# call. `.callState` also counts an optional call (`bridge?.callState(`) and
# a method taken without calling it (`const read = bridge.callState`), and it
# does not match `this.#callStateClassified` (a `#` follows the dot). Comments
# and strings are blanked first (`count_live`), so a commented-out read or the
# `E2EEBridge["callState"]` type does not count.
#
# NOT caught, and not claimed: destructuring (`const { callState } =
# this.#deps.bridge`), a computed key, or the read moved into another module.
# Nor does a count of 1 prove the remaining read is the wrapper's; tsc does,
# because every caller names the wrapper.
check_call_state_reads() {
  local f=components/rtc/mlsCallSession.ts needle n
  echo "=============== native callState reads go through the classifier ==============="
  for needle in 'bridge.callState(' '.callState'; do
    if ! n=$(count_live "$f" "$needle"); then
      note_fail "$f: could not count live '$needle' — refusing to report a" \
        "pass on an unreadable file"
      continue
    fi
    if [ "$n" = 1 ]; then
      echo "ok:   $f has exactly 1 live '$needle' (the wrapper's)"
    else
      note_fail "$f has $n live '$needle', EXPECTED exactly 1 (the read" \
        "inside #callStateClassified) — route the read through the wrapper"
    fi
  done
}
check_call_state_reads

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
# c219c107 and in no line that wave touched. The call-view suggestions files
# enrolled in FILES add none: each was measured at `--max-warnings 0`. Nor do
# the FE-2 files, measured the same way, nor the iOS call E2EE phase 2 files
# (still four at wave 3c: the three above and e2ee.ts's, at moved lines).
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
