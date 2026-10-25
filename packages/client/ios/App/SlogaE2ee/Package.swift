// swift-tools-version: 5.9
//
// SlogaE2ee: the iOS shell's native E2EE (IE plan D2, D5, D6).
//
// Added to App.xcodeproj ONCE as an XCLocalSwiftPackageReference. It is NOT
// part of CapApp-SPM, whose Package.swift `cap sync` regenerates.
//
// Targets:
//   AcutestE2ee           the Rust static library (XCFramework, ios-arm64 +
//                         ios-arm64-simulator), built on the Mac mini by the
//                         desktop repo's e2ee-ios/build-ios.sh
//   AcutestE2eeBindings   the uniffi Swift bindings generated from the SAME
//                         build (PROVENANCE.txt pins both; never hand-edit)
//   SlogaE2ee             the Capacitor plugin, consent dialogs, recovery
//                         sheet, e2ee-att:// scheme handler, attachment
//                         transfer, store protection and the bridge VC
//
// The app-hosted XCTests (Tests/AppTests) are a target of App.xcodeproj, not
// of this package: they need the app's keychain-access-groups entitlement and
// a live window.
import PackageDescription

let package = Package(
    name: "SlogaE2ee",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "SlogaE2ee", targets: ["SlogaE2ee"])
    ],
    dependencies: [
        // The SAME exact version CapApp-SPM pins, so SwiftPM resolves one copy.
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.4.3")
    ],
    targets: [
        .binaryTarget(
            name: "AcutestE2ee",
            path: "AcutestE2ee.xcframework"
        ),
        .target(
            name: "AcutestE2eeBindings",
            dependencies: ["AcutestE2ee"],
            path: "Bindings",
            linkerSettings: [
                // The Rust protector (e2ee-core protect/ios_keychain.rs) calls
                // SecItem* and CoreFoundation; a Rust staticlib carries no
                // autolink entries, so the frameworks are named here.
                .linkedFramework("Security"),
                .linkedFramework("CoreFoundation"),
            ]
        ),
        .target(
            name: "SlogaE2ee",
            dependencies: [
                "AcutestE2eeBindings",
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                // Capacitor.framework's module imports Cordova.
                .product(name: "Cordova", package: "capacitor-swift-pm"),
            ],
            path: "Sources/SlogaE2ee"
        ),
    ]
)
