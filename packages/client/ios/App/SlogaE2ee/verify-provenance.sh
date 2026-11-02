#!/usr/bin/env bash
# verify-provenance.sh: prove the committed native artifacts are the ones
# PROVENANCE.txt describes (IE plan D2 regen rule). Recomputes the sha256 of
# both XCFramework slices, the Swift bindings, the FFI header and module map
# (inside each slice's Headers/acutest_e2ee_iosFFI/) and the XCFramework
# Info.plist, and compares each with PROVENANCE.txt. Exit 0 only when all
# seven match. Runs on macOS (shasum) and Linux (sha256sum).
#
#     bash packages/client/ios/App/SlogaE2ee/verify-provenance.sh
set -eu
cd "$(dirname "$0")"

if command -v sha256sum >/dev/null 2>&1; then
    sha() { sha256sum "$1" | cut -d' ' -f1; }
else
    sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
fi

want() {
    local v
    v=$(awk -F': ' -v k="$1" '$1 == k { print $2; n++ } END { if (n != 1) exit 1 }' PROVENANCE.txt) ||
        { echo "verify-provenance: PROVENANCE.txt has no single '$1' line" >&2; exit 1; }
    printf '%s' "$v"
}

fails=0
check() { # <label> <file> <expected sha>
    local got
    if [ ! -f "$2" ]; then
        echo "FAIL $1: $2 is missing"
        fails=$((fails + 1))
        return
    fi
    got=$(sha "$2")
    if [ "$got" = "$3" ]; then
        echo "ok   $1"
    else
        echo "FAIL $1: $2 is $got, PROVENANCE says $3"
        fails=$((fails + 1))
    fi
}

check "device slice" "$(want slice.aarch64-apple-ios.path)" "$(want slice.aarch64-apple-ios.sha256)"
check "simulator slice" "$(want slice.aarch64-apple-ios-sim.path)" "$(want slice.aarch64-apple-ios-sim.sha256)"
check "swift bindings" Bindings/acutest_e2ee_ios.swift "$(want bindings.swift.sha256)"
for slice in ios-arm64 ios-arm64-simulator; do
    check "$slice header" "AcutestE2ee.xcframework/$slice/Headers/acutest_e2ee_iosFFI/acutest_e2ee_iosFFI.h" "$(want bindings.header.sha256)"
    check "$slice module map" "AcutestE2ee.xcframework/$slice/Headers/acutest_e2ee_iosFFI/module.modulemap" "$(want bindings.modulemap.sha256)"
done
check "xcframework Info.plist" AcutestE2ee.xcframework/Info.plist "$(want xcframework.info_plist.sha256)"

echo "desktop_sha: $(want desktop_sha)"
if [ "$fails" -ne 0 ]; then
    echo "verify-provenance: $fails mismatch(es)" >&2
    exit 1
fi
echo "verify-provenance: all artifacts match PROVENANCE.txt"
