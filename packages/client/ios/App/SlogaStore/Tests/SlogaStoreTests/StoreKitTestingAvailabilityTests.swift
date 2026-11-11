// StoreKitTestingAvailabilityTests.swift: the skip decision itself. No
// session and nothing here skips: these run on every destination.
import Foundation
import XCTest

final class StoreKitTestingAvailabilityTests: XCTestCase {
    private struct OtherError: Error {}

    private static let refusal = NSError(domain: "SKInternalErrorDomain", code: 3)
    private static let others: [Error] = [
        NSError(domain: "SKInternalErrorDomain", code: 2),
        NSError(domain: "SKErrorDomain", code: 3),
        NSError(domain: NSCocoaErrorDomain, code: 3),
        OtherError(),
    ]

    func testOnlySKInternalErrorDomainCode3IsARefusal() {
        XCTAssertTrue(StoreKitTestingAvailability.isRefusal(Self.refusal))
        for error in Self.others {
            XCTAssertFalse(StoreKitTestingAvailability.isRefusal(error), "\(error) counted as a refusal")
        }
    }

    /// A probe that returns normally runs the case (even when required).
    func testAPassingProbeRunsTheCase() async throws {
        try await StoreKitTestingAvailability.check(probe: {}, environment: { _ in nil })
        try await StoreKitTestingAvailability.check(probe: {}, environment: { _ in "1" })
    }

    func testARefusalSkips() async {
        do {
            try await StoreKitTestingAvailability.check(probe: { throw Self.refusal }, environment: { _ in nil })
            XCTFail("a refused probe passed")
        } catch is XCTSkip {
            // expected
        } catch {
            XCTFail("a refusal did not skip: \(error)")
        }
    }

    /// Only a refusal may skip: any other probe error (an accepted session
    /// answering "no such transaction") means the session is usable, so the
    /// case runs: no skip, no throw, with or without the requirement.
    func testOtherProbeErrorsRunTheCase() async {
        for other in Self.others {
            for required in [nil, "1"] as [String?] {
                do {
                    try await StoreKitTestingAvailability.check(probe: { throw other }, environment: { _ in required })
                } catch is XCTSkip {
                    XCTFail("\(other) was skipped; only a refusal may skip")
                } catch {
                    XCTFail("\(other) stopped the case: \(error)")
                }
            }
        }
    }

    /// SLOGA_REQUIRE_STOREKIT_SESSION=1: a refusal fails instead of skipping.
    func testRequiredSessionTurnsARefusalIntoAFailure() async {
        var asked: [String] = []
        do {
            try await StoreKitTestingAvailability.check(
                probe: { throw Self.refusal },
                environment: { key in
                    asked.append(key)
                    return key == StoreKitTestingAvailability.requireKey ? "1" : nil
                }
            )
            XCTFail("a refused probe passed")
        } catch is XCTSkip {
            XCTFail("the refusal was skipped although the session is required")
        } catch {
            XCTAssertTrue(error is StoreKitTestingAvailability.RequiredSessionRefused, "\(error)")
        }
        XCTAssertEqual(asked, ["SLOGA_REQUIRE_STOREKIT_SESSION"])
    }
}
