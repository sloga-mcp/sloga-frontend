#!/bin/bash
# The Android compile gate.
#
#   bash packages/client/scripts/android-compile-gate.sh
#
# Compiles the Kotlin AND the Java of the Android app (packages/client/android)
# for every distribution flavor (sideload, play, foss), runs the screen-share
# JVM unit tests listed in GATE_TESTS for each of them, and judges the run on
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
#      compile must carry patches/@capacitor__android@8.4.3.patch, including
#      its usingWebMessageListener field.
#   3c. check-android-e2ee-libs.mjs: the native E2EE libraries and their
#      uniffi bindings must match e2ee-native-PROVENANCE.txt. A missing
#      checker fails the gate.
#   4. gradle compile{Sideload,Play,Foss}DebugJavaWithJavac. In each variant
#      javac runs after kotlinc (it depends on it), so one task per flavor
#      checks both languages, and every flavor-only source set (src/sideload,
#      src/play, src/foss, src/gms) is compiled by at least one variant.
#      The same invocation runs test{Sideload,Play,Foss}DebugUnitTest, each
#      filtered to the GATE_TESTS classes in com.acutest.app.screenshare
#      (ScreenVideoGateTest, ScreenAudioSenderGateTest,
#      ScreenUnpublishGuardTest).
#   5. Anti-vacuity: a compiled Kotlin class (ScreenSharePlugin.class) and a
#      compiled Java class (MainActivity.class) must exist for every flavor.
#      A green run that produced neither compiled nothing.
#   6. Anti-vacuity for the tests: for every flavor AND every GATE_TESTS
#      class, the JUnit XML report must exist, written by THIS run, with at
#      least that class's minimum number of tests and no failure, error or
#      skipped test.
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

# The screen-share JVM unit tests (step 4 runs them for every flavor, step 6
# reads their reports). One row per test class in GATE_TEST_PKG, written
# <class>:<min>, where <min> is the number of @Test methods in
# android/app/src/test/java/com/acutest/app/screenshare/<class>.kt.
# Raise a minimum when tests are added; never lower one to make a run pass.
GATE_TEST_PKG=com.acutest.app.screenshare
GATE_TESTS=(
  ScreenVideoGateTest:22
  ScreenAudioSenderGateTest:19
  ScreenUnpublishGuardTest:12
)
TEST_RESULTS="$ANDROID/app/build/test-results"

[ "${#GATE_TESTS[@]}" -ge 1 ] ||
  fail 2 "GATE_TESTS has no rows (expected at least one <class>:<min> row)"
for row in "${GATE_TESTS[@]}"; do
  [[ "$row" =~ ^[A-Za-z][A-Za-z0-9_]*:[1-9][0-9]*$ ]] ||
    fail 2 "malformed GATE_TESTS row '$row' (expected <class>:<min>, min >= 1)"
done

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
# patches/@capacitor__android@8.4.3.patch (pnpm patchedDependencies) makes
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
# The same patch adds `public static volatile boolean usingWebMessageListener`.
# E2eePlugin refuses the protected-text commands while it is false, because the
# fallback bridge (addJavascriptInterface, taken when the WebView lacks
# WEB_MESSAGE_LISTENER, when the config asks for the legacy bridge, or when
# addWebMessageListener throws) takes calls from every frame of the page. It
# must be declared once with `= false`, reset to false in the constructor
# before the bridge is chosen, and set true exactly once: on the line right
# after the addWebMessageListener call and right before its catch, so that
# only a registration that returned can set it. The identifier may appear on
# those three lines only, so any other assignment, in any branch, fails here.
#
# Control: an unpatched copy of the 8.4.1 file (byte-identical in 8.4.3), the swap alone and the
# volatile alone each fail this step; the patched copy passes. So do the patched copy without
# the field, with the field set true before the addWebMessageListener call, and with a second
# true assignment in the catch.
CAP_SETTINGS="$ANDROID/capacitor.settings.gradle"
CAP_PATCH="patches/@capacitor__android@8.4.3.patch"
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

re_wml_decl='^    public static volatile boolean usingWebMessageListener = false;$'
re_wml_reset='^ +usingWebMessageListener = false;$'
re_wml_true='^ +usingWebMessageListener = true;$'
re_ctor='^    public MessageHandler\(Bridge bridge, WebView webView, PluginManager cordovaPluginManager\) \{$'
re_if='^ +if \(WebViewFeature\.isFeatureSupported\(WebViewFeature\.WEB_MESSAGE_LISTENER\) && !bridge\.getConfig\(\)\.isUsingLegacyBridge\(\)\) \{$'
re_listen='^ +WebViewCompat\.addWebMessageListener\(webView, "androidBridge", bridge\.getAllowedOriginRules\(\), capListener\);$'
re_catch='^ +\} catch \(Exception ex\) \{$'
n_wml_decl=$(mh_count "$re_wml_decl")
n_wml_reset=$(mh_count "$re_wml_reset")
n_wml_true=$(mh_count "$re_wml_true")
n_wml_any=$(mh_count 'usingWebMessageListener')
n_ctor=$(mh_count "$re_ctor")
n_if=$(mh_count "$re_if")
n_listen=$(mh_count "$re_listen")
[ "$n_wml_decl" = 1 ] && [ "$n_wml_reset" = 1 ] && [ "$n_wml_true" = 1 ] &&
  [ "$n_wml_any" = 3 ] && [ "$n_ctor" = 1 ] && [ "$n_if" = 1 ] &&
  [ "$n_listen" = 1 ] ||
  fail 5 "$MH: usingWebMessageListener declaration x$n_wml_decl, reset to" \
    "false x$n_wml_reset, set true x$n_wml_true (each must be exactly 1)," \
    "lines naming it x$n_wml_any (must be exactly 3); constructor" \
    "x$n_ctor, WEB_MESSAGE_LISTENER branch x$n_if, addWebMessageListener" \
    "call x$n_listen (each must be exactly 1). $mh_fix"
# Each pattern matched exactly once above, so each line number is one integer.
# The file has other `} catch (Exception ex) {` lines, so the catch is read
# from the line right after the true assignment rather than searched for.
l_ctor=$(mh_line "$re_ctor")
l_wml_reset=$(mh_line "$re_wml_reset")
l_if=$(mh_line "$re_if")
l_listen=$(mh_line "$re_listen")
l_wml_true=$(mh_line "$re_wml_true")
after_true=$(sed -n "$((l_wml_true + 1))p" "$MH")
[ "$l_ctor" -lt "$l_wml_reset" ] && [ "$l_wml_reset" -lt "$l_if" ] &&
  [ "$l_wml_true" -eq "$((l_listen + 1))" ] &&
  grep -qE "$re_catch" <<<"$after_true" ||
  fail 5 "$MH: usingWebMessageListener must be reset to false in the" \
    "constructor before the bridge is chosen and set true only on the line" \
    "between the addWebMessageListener call and its catch (constructor line" \
    "$l_ctor, reset line $l_wml_reset, branch line $l_if, listener call line" \
    "$l_listen, true line $l_wml_true, next line '$after_true'). $mh_fix"
echo "capacitor bridge pin: $MH is patched"

# --- 3c. the native E2EE libraries ---------------------------------------------------
#
# check-android-e2ee-libs.mjs checks the shipped libacutest_e2ee.so files and
# the uniffi acutest_e2ee.kt against e2ee-native-PROVENANCE.txt. kotlinc
# compiles a .kt that does not match its .so without complaint (uniffi
# compares the two only at runtime, when the library loads), so nothing else
# in this gate would notice stale or mismatched bindings. A missing or empty
# checker fails the gate; it is never skipped. Judged on node's own exit
# status.
LIBS_CHECK="$CLIENT/scripts/check-android-e2ee-libs.mjs"
[ -s "$LIBS_CHECK" ] ||
  fail 7 "$LIBS_CHECK is missing or empty: the native E2EE libraries are unchecked"
libs_rc=0
node "$LIBS_CHECK" || libs_rc=$?
[ "$libs_rc" -eq 0 ] ||
  fail 7 "$LIBS_CHECK exited $libs_rc: the native E2EE libraries or their" \
    "bindings do not match $ANDROID/app/e2ee-native-PROVENANCE.txt (output above)"
echo "native E2EE libraries: $LIBS_CHECK passed"

# --- 4. compile ----------------------------------------------------------------------
TASKS=()
for f in "${FLAVORS[@]}"; do
  TASKS+=("compile${f^}DebugJavaWithJavac")
done

# `--tests` is an option of the task named right before it on the command
# line and filters that task only, so every test task carries its own copy
# of every class filter (gradle 8.14.3, measured: a test task listed without
# one ran every test class of its variant). Several `--tests` on one task
# add up. A filter that matches no test at all fails the task; step 6 still
# checks every class on its own.
TEST_FILTER=()
for row in "${GATE_TESTS[@]}"; do
  TEST_FILTER+=(--tests "$GATE_TEST_PKG.${row%%:*}")
done
for f in "${FLAVORS[@]}"; do
  TASKS+=("test${f^}DebugUnitTest" "${TEST_FILTER[@]}")
done

# A report left by an earlier run must never satisfy step 6. Removing them
# also makes gradle rerun a test task it would otherwise skip as up to date,
# so the only reports step 6 can find are ones this invocation wrote.
for f in "${FLAVORS[@]}"; do
  for row in "${GATE_TESTS[@]}"; do
    rm -f "$TEST_RESULTS/test${f^}DebugUnitTest/TEST-$GATE_TEST_PKG.${row%%:*}.xml"
  done
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

# --- 6. anti-vacuity for the screen-share tests ----------------------------------------
#
# gradle already fails the run on a failing test and on a filter that matches
# nothing. This step proves every GATE_TESTS class RAN, for every flavor, in
# this invocation: each flavor's JUnit XML report for each class (the AGP 8.13
# location; after a toolchain bump, find it with
#   find packages/client/android/app/build -name 'TEST-*Screen*Test.xml'
# and update TEST_RESULTS) must name the suite, count at least that class's
# minimum of tests with one <testcase> element each, and report no failure,
# error or skipped test. A test task dropped from the list, a class dropped
# from the filter, deleted or ignored tests, or a missing report all end
# here. Never relax this check to make it pass.
#
# xml_attr <name> <testsuite-line>: the attribute's value when it is a
# non-negative integer, else empty.
xml_attr() { printf '%s\n' "$2" | sed -n "s/.* $1=\"\([0-9][0-9]*\)\".*/\1/p"; }
class_results=()
for row in "${GATE_TESTS[@]}"; do
  cls="$GATE_TEST_PKG.${row%%:*}"
  min="${row##*:}"
  test_counts=()
  for f in "${FLAVORS[@]}"; do
    v="${f}Debug"
    xml="$TEST_RESULTS/test${f^}DebugUnitTest/TEST-$cls.xml"
    [ -s "$xml" ] ||
      fail 6 "gradle exited 0 but the test report $xml is missing or empty: nothing proves $cls ran for $v"
    suite=$(grep -E '^<testsuite ' "$xml" || true)
    [ -n "$suite" ] && [ "$(printf '%s\n' "$suite" | wc -l)" -eq 1 ] ||
      fail 6 "$xml: expected exactly one <testsuite> line"
    case "$suite" in
    "<testsuite name=\"$cls\" "*) ;;
    *) fail 6 "$xml: the report's suite is not $cls" ;;
    esac
    n_tests=$(xml_attr tests "$suite")
    n_fail=$(xml_attr failures "$suite")
    n_err=$(xml_attr errors "$suite")
    n_skip=$(xml_attr skipped "$suite")
    # grep -c prints 0 and exits 1 on no match; `|| true` keeps set -e out of it.
    n_case=$(grep -c '<testcase ' "$xml" || true)
    [ -n "$n_tests" ] && [ -n "$n_fail" ] && [ -n "$n_err" ] && [ -n "$n_skip" ] &&
      [ "$n_tests" -ge "$min" ] && [ "$n_case" -eq "$n_tests" ] &&
      [ "$n_fail" -eq 0 ] && [ "$n_err" -eq 0 ] && [ "$n_skip" -eq 0 ] ||
      fail 6 "$xml: tests='$n_tests' (at least $min), <testcase>" \
        "x$n_case (must equal tests), failures='$n_fail', errors='$n_err'," \
        "skipped='$n_skip' (each must be 0): $cls did not pass in" \
        "full for $v"
    test_counts+=("$f=$n_tests")
  done
  class_results+=("$cls passed (tests: ${test_counts[*]})")
done

pass_summary=""
for r in "${class_results[@]}"; do
  pass_summary="${pass_summary:+$pass_summary; }$r"
done
echo ">>> ANDROID GATE PASS: Kotlin + Java compiled for ${FLAVORS[*]} (debug);" \
  "$pass_summary"
