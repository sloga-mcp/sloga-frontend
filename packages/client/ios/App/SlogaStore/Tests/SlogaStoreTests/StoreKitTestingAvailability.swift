// StoreKitTestingAvailability.swift: may this test process use StoreKit
// testing (SKTestSession) at all?
//
// storekitd refuses every StoreKit-testing call from a client that lacks the
// iOS `get-task-allow` entitlement ("<client> is not installed for
// development", SKInternalErrorDomain code 3; seen on the iOS 26.5
// simulator). The hostless package tests run inside the xctest agent, and
// Xcode signs simulator apps ad hoc without that key, so a plain
// `xcodebuild test` here is refused and every product list comes back empty.
// The session cases then SKIP, loudly, instead of failing for a reason that
// is not the code's. SLOGA_REQUIRE_STOREKIT_SESSION=1 turns that skip into a
// failure (for runs that do carry the entitlement). Only that one error can
// skip: a probe that returns, or throws anything else, means the session is
// usable and the case runs.
import Foundation
import StoreKitTest
import XCTest

enum StoreKitTestingAvailability {
    static let skipMessage = "StoreKit testing unavailable: storekitd refused this test process (no get-task-allow; Xcode signs simulator builds ad-hoc). To fail instead of skip, set SLOGA_REQUIRE_STOREKIT_SESSION=1 in the test process (xcodebuild: TEST_RUNNER_SLOGA_REQUIRE_STOREKIT_SESSION=1). Purchase-never-finishes is still covered by testPurchaseSourceNeverFinishes. See followups-inbox S6 iOS."
    static let requireKey = "SLOGA_REQUIRE_STOREKIT_SESSION"

    /// A refusal the environment requires to be a failure, not a skip.
    struct RequiredSessionRefused: Error, CustomStringConvertible {
        let underlying: Error
        var description: String {
            "\(StoreKitTestingAvailability.requireKey)=1 but storekitd refused StoreKit testing: \(underlying)"
        }
    }

    /// True ONLY for storekitd's refusal: SKInternalErrorDomain code 3.
    static func isRefusal(_ error: Error) -> Bool {
        let ns = error as NSError
        return ns.domain == "SKInternalErrorDomain" && ns.code == 3
    }

    /// Runs `probe` (one cheap session call). A refusal throws XCTSkip, or
    /// RequiredSessionRefused when the environment sets requireKey to "1".
    /// Any other probe error (e.g. "no such transaction" on a session
    /// storekitd accepts) returns normally: the session is usable, so the
    /// case runs and its own assertions decide.
    static func check(
        probe: () async throws -> Void,
        environment: (String) -> String? = { ProcessInfo.processInfo.environment[$0] }
    ) async throws {
        do {
            try await probe()
        } catch {
            guard isRefusal(error) else { return }
            if environment(requireKey) == "1" {
                throw RequiredSessionRefused(underlying: error)
            }
            throw XCTSkip(skipMessage)
        }
    }

    /// The probe: delete a transaction id no session ever creates. Measured
    /// on the iOS 26.5 simulator with storekitd refusing: this throws
    /// SKInternalErrorDomain code 3 (so do refundTransaction and
    /// approveAskToBuyTransaction), while setSimulatedError(nil, forAPI:)
    /// returns normally even when refused. On a session storekitd accepts
    /// (hosted, `get-task-allow`, measured on the same simulator) it throws
    /// SKTestErrorDomain code 6 instead, which is not a refusal, so check()
    /// lets the case run.
    static func probe(_ session: SKTestSession) throws {
        try session.deleteTransaction(identifier: 999_999_999)
    }
}
