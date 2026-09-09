#!/bin/bash
# Build preflight for the media-E2EE decode witness (gate d).
#
#   packages/client/scripts/rtc-build-preflight.sh
#
# Separate from rtc-gate.sh on purpose. That gate judges TREE state and every
# check in it can be fixed by editing the commit. This judges ENVIRONMENT
# state — whether the node_modules this tree resolves actually carries the
# livekit worker patch — which no commit can fix, and which is therefore the
# wrong thing to wire into a per-commit gate.
#
# Why it exists at all: gate (d) reads a heartbeat the PATCHED worker posts. An
# unpatched worker posts nothing, so the chip sits AMBER for every call, for
# every user — which is indistinguishable from a working gate that is
# withholding. Without this check, "the feature is inert" and "the feature is
# doing its job" look identical, and no live leg can prove anything either way.
#
# Judged on EXIT STATUS. Exit 0 = safe to build. Non-zero = the witness would
# not ship.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 99
fails=0

W=node_modules/livekit-client/dist/livekit-client.e2ee.worker.mjs

echo "=============== resolved livekit e2ee worker ==============="
if [ ! -f "$W" ]; then
  echo "FAIL: $W does not exist."
  exit 1
fi
RESOLVED=$(readlink -f "$W")
echo "      $RESOLVED"

# 🔴 TWO assertions, and the path one is the load-bearing half.
#
# pnpm materialises a patched package into a store directory whose name carries
# a `patch_hash` segment. Its ABSENCE is proof that pnpm resolved an UNPATCHED
# entry, and unlike a marker string inside the file it cannot be manufactured
# by appending a line — which a review pointed out `echo '// slogaDecodeWitness'
# >> worker.mjs` would otherwise do.
case "$RESOLVED" in
  *patch_hash*)
    echo "ok:   pnpm resolved a PATCHED store entry"
    ;;
  *)
    echo "FAIL: the resolved store entry carries no patch_hash segment, so pnpm"
    echo "      has applied NO patch to livekit-client. pnpm-workspace.yaml"
    echo "      declaring patchedDependencies is not the same as an install"
    echo "      having applied it: moving that declaration does not re-resolve"
    echo "      an entry that is already on disk."
    fails=$((fails + 1))
    ;;
esac

# The content assertion. Weaker on its own — it is satisfied by any occurrence,
# including a comment — but together with the path assertion it catches a
# patched entry whose patch no longer emits the witness.
if grep -qF 'slogaDecodeWitness' "$W"; then
  echo "ok:   the resolved worker mentions the decode witness"
else
  echo "FAIL: the resolved worker contains no decode witness. Every build from"
  echo "      this tree ships a worker that never posts slogaDecodeWitness, so"
  echo "      gate (d) is pinned AMBER for every call and no live leg can"
  echo "      exercise it."
  fails=$((fails + 1))
fi

echo
if [ $fails -ne 0 ]; then
  echo "########## PREFLIGHT FAIL: the decode witness would NOT ship ##########"
  echo
  echo "The fix is an install that applies patches/livekit-client@2.15.13.patch."
  echo "🔴 On the shared-worktree box, node_modules is a SYMLINK into another"
  echo "   worktree and is shared by every checkout on the machine, so a"
  echo "   pnpm install there is not a local decision — confirm before running"
  echo "   one, and never hand-edit the store to make this check pass."
fi
exit $fails
