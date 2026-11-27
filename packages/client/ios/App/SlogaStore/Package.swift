// swift-tools-version: 5.9
//
// SlogaStore: the iOS app's in-app Prot purchases (Prot S6, StoreKit 2).
// Holds the Capacitor plugin `ProtStore` (contracts §20, §25); the page's
// side is packages/client/components/client/protStorePlugin.ts.
//
// Like SlogaE2ee it is a local Swift package, NOT part of CapApp-SPM (whose
// Package.swift `cap sync` regenerates). SlogaE2ee depends on it, because the
// bridge view controller that registers the plugin behind the main-frame
// guard lives there (contracts §25, R18; wired by lane L4d).
//
// Targets:
//   SlogaStore       the plugin, the StoreKit calls and the pure mappings
//   SlogaStoreTests  XCTests: pure mappings and the update/promise ordering
//                    (any destination), plus StoreKit-testing cases run
//                    against Tests/SlogaStoreTests/Prot.storekit (iOS
//                    Simulator via xcodebuild; see README.md)
import PackageDescription

let package = Package(
    name: "SlogaStore",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "SlogaStore", targets: ["SlogaStore"])
    ],
    dependencies: [
        // The SAME exact version SlogaE2ee and CapApp-SPM pin, so SwiftPM
        // resolves one copy.
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.4.3")
    ],
    targets: [
        .target(
            name: "SlogaStore",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                // Capacitor.framework's module imports Cordova.
                .product(name: "Cordova", package: "capacitor-swift-pm"),
            ],
            path: "Sources/SlogaStore",
            linkerSettings: [
                .linkedFramework("StoreKit")
            ]
        ),
        .testTarget(
            name: "SlogaStoreTests",
            dependencies: ["SlogaStore"],
            path: "Tests/SlogaStoreTests",
            resources: [
                .copy("Prot.storekit")
            ],
            linkerSettings: [
                .linkedFramework("StoreKitTest")
            ]
        ),
    ],
    swiftLanguageVersions: [.v5]
)
