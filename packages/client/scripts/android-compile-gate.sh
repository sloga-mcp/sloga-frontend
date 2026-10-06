#!/bin/bash
# The Android compile gate.
#
#   bash packages/client/scripts/android-compile-gate.sh
#
# Compiles the Kotlin AND the Java of the Android app (packages/client/android)
# for every distribution flavor (sideload, play, foss) and judges the run on
# GRADLE'S OWN EXIT STATUS, never on a grep of its output and never on the
# status of something it was piped into.
#
# Why this file exists. node --test, tsc, eslint and prettier cover NONE of
# packages/client/android/**. On a slice whose weight is in Kotlin (the screen
# leg, E2eePlugin, the speech and updater plugins) every JS gate can be green
# while the app does not compile. Before this script "the compiler prevents
# it" held only when someone remembered to compile, on the one machine that
# had hand-copied scaffolding. Compiling by hand has caught real defects no
# reviewer and no JS gate saw: a `val` declared inside a `try` and read from
# its `catch`, and `this.room` inside a `scope.launch` lambda resolving to the
# CoroutineScope instead of the plugin.
#
# What it does, in order:
#   1. Creates an EMPTY android/app/src/main/assets/public. See the comment at
#      that step: it is for compile checks only.
#   2. `cap update android` generates the gitignored scaffolding gradle cannot
#      configure without (capacitor-cordova-android-plugins/, including
#      cordova.variables.gradle). No web build is needed.
#   3. Drift alarm on the two COMMITTED files `cap update` rewrites.
#   3b. Source pin: the Capacitor MessageHandler.java gradle is about to
#      compile must carry patches/@capacitor__android@8.4.1.patch.
#   4. gradle compile{Sideload,Play,Foss}DebugJavaWithJavac. In each variant
#      javac runs after kotlinc (it depends on it), so one task per flavor
#      checks both languages, and every flavor-only source set (src/sideload,
#      src/play, src/foss, src/gms) is compiled by at least one variant.
#   5. Anti-vacuity: a compiled Kotlin class (ScreenSharePlugin.class) and a
#      compiled Java class (MainActivity.class) must exist for every flavor.
#      A green run that produced neither compiled nothing.
#
# How CI uses it. The `android-compile` job in
# .github/workflows/build-and-test.yml checks out with submodules, installs
# the node deps through mise, sets up Temurin 21, gradle and the android-36
# platform, then runs this script with `shell: bash`. The job's status IS this
# script's exit status.
#
# Prove it is live before trusting a green: append
#   private val negativeControl: Int = "not an int"
# to android/app/src/main/java/com/acutest/app/screenshare/ScreenSharePlugin.kt
# and the run must fail AT that file:line; same for a Java type error appended
# to a file under android/app/src/main/java. Restore the file afterwards.
#
# Environment. An existing JAVA_HOME is honored. If it is unset and
# $HOME/tools/jdk-21 exists (the home dev box), that JDK is used. ANDROID_HOME
# is honored; if it is unset, android/local.properties is absent and
# $HOME/Android/Sdk exists, that SDK is used. An existing local.properties is
# never written to.
#
# Exit status: gradle's own when gradle fails; otherwise 0 on success and
# non-zero, after a line starting `>>> ANDROID GATE FAIL:`, on any other
# failure.
set -euo pipefail

fail() { # fail <exit-status> <message...>
  local rc="$1"
  shift
  echo ">>> ANDROID GATE FAIL: $*" >&2
  exit "$rc"
}

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
[ -f packages/client/capacitor.config.ts ] ||
  fail 2 "cannot find packages/client/capacitor.config.ts under $ROOT"

CLIENT=packages/client
ANDROID="$CLIENT/android"
FLAVORS=(sideload play foss)

# --- toolchain -----------------------------------------------------------------

if [ -z "${JAVA_HOME:-}" ] && [ -d "$HOME/tools/jdk-21" ]; then
  export JAVA_HOME="$HOME/tools/jdk-21"
fi
if [ -n "${JAVA_HOME:-}" ]; then
  export PATH="$JAVA_HOME/bin:$PATH"
fi

if [ -z "${ANDROID_HOME:-}" ] && [ -z "${ANDROID_SDK_ROOT:-}" ] &&
  [ ! -f "$ANDROID/local.properties" ] && [ -d "$HOME/Android/Sdk" ]; then
  export ANDROID_HOME="$HOME/Android/Sdk"
fi

command -v node >/dev/null ||
  fail 2 "node is not on PATH (the cap CLI is a node script)"
[ -x "$CLIENT/node_modules/.bin/cap" ] ||
  fail 2 "$CLIENT/node_modules/.bin/cap is missing; install the node deps first"

# --- 1. the empty webDir ---------------------------------------------------------
#
# COMPILE CHECKS ONLY. NEVER COPY THIS STEP INTO A RELEASE OR SIDELOAD RECIPE.
#
# `cap update` calls copy() only when android/app/src/main/assets/public (the
# android webDir) is MISSING; see @capacitor/cli dist/android/update.js:31-33,
# `if (!(await pathExists(config.android.webDirAbs))) await copy(config, ...)`.
# copy() demands a real web build in packages/client/dist and then runs the
# `capacitor:copy:after` hook (injectAndroidCsp.mjs and the transcription-model
# staging), neither of which a compile check needs or can satisfy in CI. An
# empty directory skips all of it. An APK built on top of this directory would
# ship WITHOUT the web app, the CSP or the models, so release builds go through
# `build:android` (vite build + cap sync), which replaces it.
mkdir -p "$ANDROID/app/src/main/assets/public"

# --- 2. generate the gitignored scaffolding --------------------------------------
#
# Call the binary directly. NEVER `pnpm exec`: it can trigger a no-TTY
# reinstall of the shared node_modules, which kills a running vite.
cap_rc=0
(cd "$CLIENT" && node_modules/.bin/cap update android) || cap_rc=$?
[ "$cap_rc" -eq 0 ] || fail "$cap_rc" "cap update android exited $cap_rc"

[ -s "$ANDROID/capacitor-cordova-android-plugins/cordova.variables.gradle" ] ||
  fail 3 "cap update did not produce a non-empty" \
    "$ANDROID/capacitor-cordova-android-plugins/cordova.variables.gradle"

# --- 3. drift alarm ----------------------------------------------------------------
#
# `cap update` regenerates these two COMMITTED files from node_modules. A diff
# here means the committed copies no longer match what the installed
# @capacitor packages generate, almost always a capacitor bump (or a plugin
# added or removed) whose regenerated files were never committed.
#
# --no-pager: git (2.53, measured) already skips the pager for
# `diff --exit-code`, even with pager.diff set, but that is a special case
# inside git rather than a contract. A pager on an interactive terminal would
# hold a long diff waiting for a keypress instead of failing, so never page
# here. The exit status is git's own either way.
drift_rc=0
git --no-pager diff --exit-code -- \
  "$ANDROID/capacitor.settings.gradle" \
  "$ANDROID/app/capacitor.build.gradle" || drift_rc=$?
[ "$drift_rc" -eq 0 ] ||
  fail 3 "cap update changed committed files (diff above). The committed" \
    "capacitor.settings.gradle / app/capacitor.build.gradle do not match the" \
    "installed @capacitor packages: after a capacitor bump or a plugin change," \
    "run 'cap update android' and commit the regenerated files."

# --- 3b. the patched Capacitor bridge ----------------------------------------------
#
# patches/@capacitor__android@8.4.1.patch (pnpm patchedDependencies) makes
# MessageHandler.java store the sending page's reply proxy BEFORE it dispatches
# the call, and declares that field volatile. Unpatched, the first plugin call
# after a WebView reload could be answered to the dead page and never settle
# (wave 4h: the share button said "not supported" for a whole session). An
# install made before the patch compiles the UNPATCHED file and gradle still
# exits 0, and the drift alarm above only proves the committed settings match
# the install, not that the install is patched. So pin the source itself, in
# the :capacitor-android projectDir the drift-checked settings name (relative
# to $ANDROID, as gradle resolves it).
#
# Control: an unpatched copy of the 8.4.1 file, the swap alone and the
# volatile alone each fail this step; the patched copy passes.
CAP_SETTINGS="$ANDROID/capacitor.settings.gradle"
CAP_PATCH="patches/@capacitor__android@8.4.1.patch"
cap_dir=$(sed -n "s/^project(':capacitor-android')\.projectDir = new File('\(.*\)')\$/\1/p" \
  "$CAP_SETTINGS")
[ -n "$cap_dir" ] && [ "$(printf '%s\n' "$cap_dir" | wc -l)" -eq 1 ] ||
  fail 5 "expected exactly one :capacitor-android projectDir line in $CAP_SETTINGS"
case "$cap_dir" in
/*) ;;
*) cap_dir="$ANDROID/$cap_dir" ;;
esac
MH="$cap_dir/src/main/java/com/getcapacitor/MessageHandler.java"
[ -s "$MH" ] || fail 5 "$MH (from $CAP_SETTINGS) is missing or empty"

# grep -c prints 0 and exits 1 on no match; `|| true` keeps set -e out of it.
mh_count() { grep -cE "$1" "$MH" || true; }
mh_line() { grep -nE "$1" "$MH" | cut -d: -f1; }
re_field='^    private volatile JavaScriptReplyProxy javaScriptReplyProxy;$'
re_main='^ +if \(isMainFrame\) \{$'
re_assign='^ +javaScriptReplyProxy = replyProxy;$'
re_post='^ +postMessage\(message\.getData\(\)\);$'
n_field=$(mh_count "$re_field")
n_main=$(mh_count "$re_main")
n_assign=$(mh_count "$re_assign")
n_post=$(mh_count "$re_post")
mh_fix="$CAP_PATCH is not applied to this install: reinstall with the frozen"
mh_fix="$mh_fix lockfile (pnpm install --frozen-lockfile), then rerun this gate."
[ "$n_field" = 1 ] && [ "$n_main" = 1 ] && [ "$n_assign" = 1 ] &&
  [ "$n_post" = 1 ] ||
  fail 5 "$MH: volatile reply-proxy field x$n_field, 'if (isMainFrame) {'" \
    "x$n_main, proxy assignment x$n_assign, postMessage(message.getData())" \
    "x$n_post (each must be exactly 1). $mh_fix"
# Each pattern matched exactly once above, so each line number is one integer.
l_main=$(mh_line "$re_main")
l_assign=$(mh_line "$re_assign")
l_post=$(mh_line "$re_post")
[ "$l_main" -lt "$l_assign" ] && [ "$l_assign" -lt "$l_post" ] ||
  fail 5 "$MH: the reply proxy is not stored before the call is dispatched" \
    "(isMainFrame line $l_main, assignment line $l_assign, postMessage line" \
    "$l_post). $mh_fix"
echo "capacitor bridge pin: $MH is patched"

# --- 4. compile ----------------------------------------------------------------------
TASKS=()
for f in "${FLAVORS[@]}"; do
  TASKS+=("compile${f^}DebugJavaWithJavac")
done

echo "=============== gradle ${TASKS[*]} ==============="
gradle_rc=0
(cd "$ANDROID" && ./gradlew --console=plain "${TASKS[@]}") || gradle_rc=$?
if [ "$gradle_rc" -ne 0 ]; then
  echo ">>> ANDROID GATE FAIL: gradle exited $gradle_rc" >&2
  exit "$gradle_rc"
fi

# --- 5. anti-vacuity -------------------------------------------------------------------
#
# Output paths as produced by AGP 8.13 + kotlin-android 2.0.21. If a toolchain
# bump moves them, this fails loudly; find the new location with
#   find packages/client/android/app/build -name ScreenSharePlugin.class
# and update the paths here. Never relax this check to make it pass.
BUILD="$ANDROID/app/build"
for f in "${FLAVORS[@]}"; do
  v="${f}Debug"
  kt="$BUILD/tmp/kotlin-classes/$v/com/acutest/app/screenshare/ScreenSharePlugin.class"
  jv="$BUILD/intermediates/javac/$v/compile${f^}DebugJavaWithJavac/classes/com/acutest/app/MainActivity.class"
  [ -s "$kt" ] ||
    fail 4 "gradle exited 0 but the Kotlin output $kt is missing: nothing proves kotlinc compiled $v"
  [ -s "$jv" ] ||
    fail 4 "gradle exited 0 but the Java output $jv is missing: nothing proves javac compiled $v"
done

echo ">>> ANDROID GATE PASS: Kotlin + Java compiled for ${FLAVORS[*]} (debug)"
