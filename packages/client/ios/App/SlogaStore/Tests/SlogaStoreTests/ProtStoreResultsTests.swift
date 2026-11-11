// ProtStoreResultsTests.swift: the pure mappings and argument checks
// (contracts §20). No StoreKit session needed; any iOS destination.
import StoreKit
import XCTest
@testable import SlogaStore

final class ProtStoreResultsTests: XCTestCase {
    // MARK: PurchaseResult → result union

    func testPendingMapsToPending() {
        XCTAssertEqual(ProtStoreResultMapping.outcome(for: .pending), .pending)
        let object = ProtStoreResultMapping.result(for: .pending)
        XCTAssertEqual(object["result"] as? String, "pending")
        XCTAssertEqual(object.count, 1)
    }

    func testUserCancelledMapsToCancelled() {
        XCTAssertEqual(ProtStoreResultMapping.outcome(for: .userCancelled), .cancelled)
        let object = ProtStoreResultMapping.result(for: .userCancelled)
        XCTAssertEqual(object["result"] as? String, "cancelled")
        XCTAssertEqual(object.count, 1)
    }

    func testPurchasedObjectMatchesTheTsShape() throws {
        let purchase = ProtStoreResultMapping.purchased(
            transactionId: 2_000_000_123_456_789,
            productId: "gg.sloga.prot.p5",
            signedTransaction: "eyJhbGciOiJFUzI1NiJ9.e30.c2ln"
        )
        let object = ProtStoreOutcome.purchased(purchase).jsObject
        XCTAssertEqual(Set(object.keys), ["result", "purchase"])
        XCTAssertEqual(object["result"] as? String, "purchased")
        let inner = try XCTUnwrap(object["purchase"] as? [String: Any])
        XCTAssertEqual(Set(inner.keys), ["store", "transaction_id", "product_id", "signed_transaction"])
        XCTAssertEqual(inner["store"] as? String, "apple")
        XCTAssertEqual(inner["transaction_id"] as? String, "2000000123456789")
        XCTAssertEqual(inner["product_id"] as? String, "gg.sloga.prot.p5")
        XCTAssertEqual(inner["signed_transaction"] as? String, "eyJhbGciOiJFUzI1NiJ9.e30.c2ln")
    }

    func testFailedObjectCarriesCodeAndAnOptionalMessage() {
        let bare = ProtStoreOutcome.failed(.invalidToken, nil).jsObject
        XCTAssertEqual(Set(bare.keys), ["result", "code"])
        XCTAssertEqual(bare["result"] as? String, "failed")
        XCTAssertEqual(bare["code"] as? String, "invalid_token")

        let withMessage = ProtStoreOutcome.failed(.storeError, "network_error").jsObject
        XCTAssertEqual(Set(withMessage.keys), ["result", "code", "message"])
        XCTAssertEqual(withMessage["message"] as? String, "network_error")
    }

    func testPurchaseOpenIsAStoreErrorWithItsMessage() {
        let object = ProtStoreOutcome.purchaseOpen.jsObject
        XCTAssertEqual(Set(object.keys), ["result", "code", "message"])
        XCTAssertEqual(object["result"] as? String, "failed")
        XCTAssertEqual(object["code"] as? String, "store_error")
        XCTAssertEqual(object["message"] as? String, "purchase_open")
    }

    func testFailCodesAreExactlyTheTsUnion() {
        XCTAssertEqual(
            Set(ProtStoreFailCode.allCases.map(\.rawValue)),
            ["not_available", "product_not_found", "already_owned", "invalid_token", "store_error"]
        )
    }

    func testProductObjectMatchesTheTsShape() {
        let object = ProtStoreProduct(id: "gg.sloga.prot.p10", displayPrice: "$11.99").jsObject
        XCTAssertEqual(Set(object.keys), ["id", "displayPrice"])
        XCTAssertEqual(object["id"] as? String, "gg.sloga.prot.p10")
        XCTAssertEqual(object["displayPrice"] as? String, "$11.99")
    }

    // MARK: thrown errors

    func testThrownErrorsMapToTheContractCodes() {
        XCTAssertEqual(ProtStoreResultMapping.outcome(forThrown: StoreKitError.userCancelled), .cancelled)
        XCTAssertEqual(
            ProtStoreResultMapping.outcome(forThrown: StoreKitError.notAvailableInStorefront),
            .failed(.productNotFound, "not_available_in_storefront")
        )
        XCTAssertEqual(
            ProtStoreResultMapping.outcome(forThrown: StoreKitError.networkError(URLError(.notConnectedToInternet))),
            .failed(.storeError, "network_error")
        )
        XCTAssertEqual(
            ProtStoreResultMapping.outcome(forThrown: StoreKitError.systemError(NSError(domain: "x", code: 1))),
            .failed(.storeError, "system_error")
        )
        XCTAssertEqual(
            ProtStoreResultMapping.outcome(forThrown: StoreKitError.unknown),
            .failed(.storeError, "storekit_error")
        )
        XCTAssertEqual(
            ProtStoreResultMapping.outcome(forThrown: Product.PurchaseError.productUnavailable),
            .failed(.productNotFound, "product_unavailable")
        )
        XCTAssertEqual(
            ProtStoreResultMapping.outcome(forThrown: Product.PurchaseError.purchaseNotAllowed),
            .failed(.notAvailable, "purchase_not_allowed")
        )
        XCTAssertEqual(
            ProtStoreResultMapping.outcome(forThrown: Product.PurchaseError.invalidQuantity),
            .failed(.storeError, "purchase_error")
        )
        XCTAssertEqual(
            ProtStoreResultMapping.outcome(forThrown: NSError(domain: "x", code: 2)),
            .failed(.storeError, "store_error")
        )
    }

    // MARK: argument checks

    func testAccountTokenMustBeACanonicalUuid() {
        let lower = "6f1c2b7e-4d2a-4c8e-9b1f-0a3d5e7f9b21"
        XCTAssertEqual(ProtStoreRequests.accountToken(lower), UUID(uuidString: lower))
        XCTAssertNotNil(ProtStoreRequests.accountToken(lower.uppercased()))
        for bad in [
            nil, "", "not-a-uuid", "6f1c2b7e4d2a4c8e9b1f0a3d5e7f9b21",
            "{6f1c2b7e-4d2a-4c8e-9b1f-0a3d5e7f9b21}", " 6f1c2b7e-4d2a-4c8e-9b1f-0a3d5e7f9b21",
            "6f1c2b7e-4d2a-4c8e-9b1f-0a3d5e7f9b2g", "6f1c2b7e-4d2a-4c8e-9b1f-0a3d5e7f9b21\n",
            // a Play-style obfuscated account id (43 chars base64url)
            "q2bQyM0hY8Jf2l0mFq1oK3cT9xV7nW4sR6eA5uD8pZk",
        ] as [String?] {
            XCTAssertNil(ProtStoreRequests.accountToken(bad), "accepted \(String(describing: bad))")
        }
    }

    func testInvalidTokenIsRefusedBeforeTheSheet() {
        XCTAssertEqual(
            ProtStoreRequests.purchase(productId: "gg.sloga.prot.p5", accountToken: "nope"),
            .refused(.failed(.invalidToken, nil))
        )
        XCTAssertEqual(
            ProtStoreRequests.purchase(productId: "gg.sloga.prot.p5", accountToken: nil),
            .refused(.failed(.invalidToken, nil))
        )
        // token checked first
        XCTAssertEqual(
            ProtStoreRequests.purchase(productId: nil, accountToken: "nope"),
            .refused(.failed(.invalidToken, nil))
        )
        XCTAssertEqual(
            ProtStoreRequests.purchase(productId: "", accountToken: "6f1c2b7e-4d2a-4c8e-9b1f-0a3d5e7f9b21"),
            .refused(.failed(.productNotFound, nil))
        )
        let token = "6f1c2b7e-4d2a-4c8e-9b1f-0a3d5e7f9b21"
        XCTAssertEqual(
            ProtStoreRequests.purchase(productId: "gg.sloga.prot.p100", accountToken: token),
            .valid(productId: "gg.sloga.prot.p100", accountToken: UUID(uuidString: token)!)
        )
    }

    /// R45: invalid ids are dropped silently and the valid ones returned;
    /// the call is never rejected as a whole.
    func testProductIdsDropInvalidOnesSilently() {
        XCTAssertEqual(
            ProtStoreRequests.productIds(["gg.sloga.prot.p5", "gg.sloga.prot.p10", "gg.sloga.prot.p5"]),
            ["gg.sloga.prot.p5", "gg.sloga.prot.p10"]
        )
        XCTAssertEqual(ProtStoreRequests.productIds([]), [])
        XCTAssertEqual(ProtStoreRequests.productIds(nil), [])
        XCTAssertEqual(
            ProtStoreRequests.productIds([
                "gg.sloga.prot.p5", 5, "", NSNull(), String(repeating: "a", count: 65), "gg.sloga.prot.p100",
            ]),
            ["gg.sloga.prot.p5", "gg.sloga.prot.p100"]
        )
        XCTAssertEqual(
            ProtStoreRequests.productIds([String(repeating: "a", count: 64)]),
            [String(repeating: "a", count: 64)]
        )
        // At most the first 20 valid ids; invalid ones do not use up the cap.
        XCTAssertEqual(
            ProtStoreRequests.productIds([7 as Any] + (0...20).map { "id\($0)" as Any }),
            (0..<20).map { "id\($0)" }
        )
    }

    func testTransactionIdIsADecimalUInt64() {
        XCTAssertEqual(ProtStoreRequests.transactionId("2000000123456789"), 2_000_000_123_456_789)
        XCTAssertEqual(ProtStoreRequests.transactionId("18446744073709551615"), UInt64.max)
        for bad in [nil, "", "18446744073709551616", "123456789012345678901", "-1", "+1", "12a", " 1", "1.0", "١٢"] as [String?] {
            XCTAssertNil(ProtStoreRequests.transactionId(bad), "accepted \(String(describing: bad))")
        }
    }

    func testStorefrontIsPassedRaw() {
        XCTAssertEqual(ProtStoreResultMapping.storefrontObject("USA") as? [String: String], ["storefront": "USA"])
        XCTAssertEqual(ProtStoreResultMapping.storefrontObject("DEU") as? [String: String], ["storefront": "DEU"])
        XCTAssertTrue(ProtStoreResultMapping.storefrontObject(nil).isEmpty)
        XCTAssertTrue(ProtStoreResultMapping.storefrontObject("").isEmpty)
    }

    // MARK: source scans (simulator host; see SourceScan.swift)

    /// Local verification never filters or decides: no source file matches
    /// on the verification case or reads the throwing `payloadValue`.
    func testMappingNeverBranchesOnLocalVerification() throws {
        for file in ["ProtStoreResults.swift", "ProtStoreKit.swift", "ProtStorePlugin.swift"] {
            let code = try SourceScan.code(file).joined(separator: "\n")
            XCTAssertFalse(code.contains(".verified"), "\(file) branches on .verified")
            XCTAssertFalse(code.contains(".unverified"), "\(file) branches on .unverified")
            XCTAssertFalse(code.contains(".payloadValue"), "\(file) reads the throwing payloadValue")
        }
        let results = try SourceScan.code("ProtStoreResults.swift").joined(separator: "\n")
        XCTAssertTrue(results.contains("verification.unsafePayloadValue"))
        XCTAssertTrue(results.contains("verification.jwsRepresentation"))
    }

    /// No web purchase link or external-purchase API anywhere (E8 owner
    /// decision), no logging of any kind, and no script evaluation or
    /// dynamic (selector / key-value) dispatch. Scans EVERY .swift file under
    /// Sources/SlogaStore, enumerated, so a new source file is covered too.
    func testNoWebLinkAndNoLogging() throws {
        let sources = SourceScan.packageRoot.appendingPathComponent("Sources/SlogaStore")
        let enumerator = try XCTUnwrap(
            FileManager.default.enumerator(atPath: sources.path),
            "cannot enumerate \(sources.path)"
        )
        let files = enumerator.compactMap { $0 as? String }.filter { $0.hasSuffix(".swift") }.sorted()
        XCTAssertFalse(files.isEmpty, "found no .swift files under \(sources.path)")
        for known in ["ProtStoreResults.swift", "ProtStoreKit.swift", "ProtStorePlugin.swift", "ProtStoreUpdateGate.swift"] {
            XCTAssertTrue(files.contains(known), "the enumeration missed \(known)")
        }
        for file in files {
            let code = try SourceScan.code(file).joined(separator: "\n")
            // PurchaseIntent / SKPaymentQueue / shouldAddStorePayment: promoted
            // IAP is not supported (E10), and StoreKit 1 is never used.
            // evaluateJavaScript / evalWithPlugin / eval(: the plugin never runs
            // script in the page. Selector / perform / KVC: no dynamic dispatch.
            for banned in ["ExternalPurchase", "openURL", "UIApplication.shared.open", "http://", "https://",
                           "PurchaseIntent", "SKPaymentQueue", "shouldAddStorePayment",
                           "print(", "NSLog(", "os_log(", "Logger(", "debugPrint(", "dump(",
                           "evaluateJavaScript", "evalWithPlugin", "eval(",
                           "Selector(", "#selector(", "perform(", "value(forKey", "setValue("] {
                XCTAssertFalse(code.contains(banned), "\(file) contains \(banned)")
            }
        }
    }
}
