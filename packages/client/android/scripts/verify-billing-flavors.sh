#!/usr/bin/env bash
# Play Billing flavor check for Sloga Android artifacts (Prot in-app purchase,
# S6). Inspects already-built output; builds nothing.
#
#   play     release APK + release AAB: com.android.vending.BILLING in the
#            manifest AND Play Billing classes in the dex.
#   sideload release APK, foss release APK: neither.
#
# Asserts against SHIPPED ARTIFACTS only, never build/intermediates/: the
# manifest merger keeps XML comments, so a merged intermediate manifest can
# name a permission it does not declare.
#
# Every dump goes to a file with its exit status checked and its stderr left on
# stderr. A failed or empty dump is an ERROR, never "marker absent", and every
# verdict comes from an exit status (grep -F ... >/dev/null), never from
# printed text. No pipefail plus grep -q anywhere.
#
# Usage: verify-billing-flavors.sh [<tree>]
#   no argument: the outputs of the android project this script lives in;
#   <tree>: <tree>/packages/client/android/app/build/outputs.
# Env: ANDROID_HOME (default $HOME/Android/Sdk), AAPT2 (default
#   $ANDROID_HOME/build-tools/36.0.0/aapt2).
# Exit: 0 every artifact PASS; 1 any FAIL or ERROR; 2 an artifact or tool is
#   missing, or an artifact is not newer than app/build.gradle (refuses, never
#   passes vacuously or on a stale build); 64 usage.
set -u

die() { local rc="$1"; shift; printf '!! %s\n' "$*" >&2; exit "$rc"; }
[ "$#" -le 1 ] || die 64 "usage: verify-billing-flavors.sh [<tree>]"
if [ "$#" -eq 1 ]; then
  [ -n "$1" ] || die 64 "empty <tree> argument"
  OUT="$1/packages/client/android/app/build/outputs"
else
  here=$(cd "$(dirname "$0")" && pwd) || die 2 "cannot resolve the script directory"
  OUT="$here/../app/build/outputs"
fi
[ -d "$OUT" ] || die 2 "no build outputs at $OUT"

ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
AAPT2="${AAPT2:-$ANDROID_HOME/build-tools/36.0.0/aapt2}"
[ -x "$AAPT2" ] || die 2 "aapt2 not found or not executable: $AAPT2"
for tool in unzip strings grep; do
  command -v "$tool" >/dev/null || die 2 "$tool not found"
done

PERM=com.android.vending.BILLING
# A class Play Billing always defines (play must carry it) and the package
# prefix no other flavor may carry at all, both as dex type descriptors.
CLASS_PLAY='Lcom/android/billingclient/api/BillingClient;'
PKG_ANY='Lcom/android/billingclient/'

# Collect the artifacts first: every row must exist, else refuse (exit 2).
# Each glob may match more than one file; every match is checked.
missing=0
collect() { # <varname> <dir> <glob>
  local var="$1" dir="$2" glob="$3" f found=()
  for f in "$dir"/$glob; do
    [ -f "$f" ] && found+=("$f")
  done
  if [ "${#found[@]}" -eq 0 ]; then
    printf '!! missing: %s/%s\n' "$dir" "$glob" >&2
    missing=1
  fi
  eval "$var=(\"\${found[@]}\")"
}
collect PLAY_APKS     "$OUT/apk/play/release"     '*.apk'
collect PLAY_AABS     "$OUT/bundle/playRelease"   '*.aab'
collect SIDELOAD_APKS "$OUT/apk/sideload/release" '*.apk'
collect FOSS_APKS     "$OUT/apk/foss/release"     '*.apk'
[ "$missing" -eq 0 ] || die 2 "refusing: at least one release artifact is missing (build play APK + AAB, sideload, foss first)"

# Fresh artifacts only: each must be strictly newer than app/build.gradle (the
# file that scopes billing to play), so an APK left over from before a gradle
# change can never stand in for the current build. outputs is app/build/outputs.
GRADLE_DIR=$(cd "$OUT/../.." && pwd -P) || die 2 "cannot resolve the app directory from $OUT"
GRADLE="$GRADLE_DIR/build.gradle"
[ -f "$GRADLE" ] || die 2 "no app/build.gradle at $GRADLE; cannot judge artifact freshness"
stale=0
for f in "${PLAY_APKS[@]}" "${PLAY_AABS[@]}" "${SIDELOAD_APKS[@]}" "${FOSS_APKS[@]}"; do
  if ! [ "$f" -nt "$GRADLE" ]; then
    printf '!! stale: %s is not newer than %s\n' "$f" "$GRADLE" >&2
    stale=1
  fi
done
[ "$stale" -eq 0 ] || die 2 "refusing: at least one artifact predates app/build.gradle; rebuild every flavor first"

T=$(mktemp -d "${TMPDIR:-/tmp}/verify-billing.XXXXXX") || die 2 "mktemp failed"
trap 'rm -rf "$T"' EXIT

ANY_BAD=0

# check <label> <apk|aab> <want PRESENT|ABSENT> <artifact>
check() {
  local label="$1" kind="$2" want="$3" artifact="$4"
  local err=0 bad=0 results=() rcs perm_state dex_state dex_count

  # dumped <file> <rc...>: 0 when the dump is usable
  dumped() {
    local name="$1" r; shift
    for r in "$@"; do
      if [ "$r" -ne 0 ]; then
        results+=("  dump:$name ERROR rc=$*"); err=1; return 1
      fi
    done
    if [ ! -s "$T/$name" ]; then
      results+=("  dump:$name ERROR empty output"); err=1; return 1
    fi
    return 0
  }
  # state <file> <literal>: echoes PRESENT, ABSENT or ERROR from grep's status
  state() {
    local g
    grep -F -- "$2" "$T/$1" >/dev/null
    g=$?
    case "$g" in
      0) echo PRESENT ;;
      1) echo ABSENT ;;
      *) echo ERROR ;;
    esac
  }

  rm -f "$T/perm" "$T/dex"
  if [ "$kind" = aab ]; then
    unzip -p "$artifact" base/manifest/AndroidManifest.xml | strings -a > "$T/perm"
    rcs=("${PIPESTATUS[@]}")
    dumped perm "${rcs[@]}"
    unzip -p "$artifact" 'base/dex/*.dex' | strings -a > "$T/dex"
    rcs=("${PIPESTATUS[@]}")
    dumped dex "${rcs[@]}"
  else
    "$AAPT2" dump permissions "$artifact" > "$T/perm"
    dumped perm "$?"
    unzip -p "$artifact" 'classes*.dex' | strings -a > "$T/dex"
    rcs=("${PIPESTATUS[@]}")
    dumped dex "${rcs[@]}"
  fi

  perm_state=ERROR dex_state=ERROR dex_count=?
  if [ "$err" -eq 0 ]; then
    perm_state=$(state perm "$PERM")
    if [ "$want" = PRESENT ]; then
      dex_state=$(state dex "$CLASS_PLAY")
    else
      dex_state=$(state dex "$PKG_ANY")
    fi
    dex_count=$(grep -F -c -- "$PKG_ANY" "$T/dex")
    [ "$perm_state" = ERROR ] && { results+=("  grep:perm ERROR"); err=1; }
    [ "$dex_state" = ERROR ] && { results+=("  grep:dex ERROR"); err=1; }
  fi
  [ "$err" -eq 0 ] && [ "$perm_state" != "$want" ] && bad=1
  [ "$err" -eq 0 ] && [ "$dex_state" != "$want" ] && bad=1

  local verdict=PASS
  [ "$bad" -eq 0 ] || verdict=FAIL
  [ "$err" -eq 0 ] || verdict=ERROR
  printf '%-18s %s=%-8s billing-classes=%-8s (%s dex strings under %s) want=%-8s %s\n' \
    "$label" "$PERM" "$perm_state" "$dex_state" "$dex_count" "$PKG_ANY" "$want" "$verdict"
  printf '  file=%s\n' "$artifact"
  [ "${#results[@]}" -eq 0 ] || printf '%s\n' "${results[@]}"
  [ "$verdict" = PASS ] || ANY_BAD=1
  return 0
}

echo "expected: play (APK + AAB) => BILLING + billing classes PRESENT"
echo "          sideload, foss   => both ABSENT"
echo
for f in "${PLAY_APKS[@]}";     do check "play/release"     apk PRESENT "$f"; done
for f in "${PLAY_AABS[@]}";     do check "play/release(aab)" aab PRESENT "$f"; done
for f in "${SIDELOAD_APKS[@]}"; do check "sideload/release" apk ABSENT  "$f"; done
for f in "${FOSS_APKS[@]}";     do check "foss/release"     apk ABSENT  "$f"; done

if [ "$ANY_BAD" -ne 0 ]; then
  printf '!! %s\n' "at least one artifact is not PASS (FAIL or ERROR)" >&2
  exit 1
fi
echo "OK: every artifact PASS"
exit 0
