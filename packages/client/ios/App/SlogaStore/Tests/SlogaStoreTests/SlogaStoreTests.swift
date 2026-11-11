// SlogaStoreTests.swift: StoreKit-testing XCTests (SKTestSession with
// Tests/SlogaStoreTests/Prot.storekit, the five packs of contracts §4).
//
// 🔴 SIMULATOR ONLY, via xcodebuild on the Mac mini (contracts §25 gate):
//     xcodebuild -scheme SlogaStore test \
//       -destination 'platform=iOS Simulator,name=<an iPhone simulator>'
// They drive the very functions the plugin calls (ProtStoreKit), with
// dialogs disabled, so no sheet appears. `swift test` on macOS does not
// build this package (iOS-only Capacitor binary). A failing session setup
// FAILS the test; nothing here skips.
import StoreKit
import StoreKitTest
import XCTest
@testable import SlogaStore

final class SlogaStoreTests: XCTestCase {
    static let packs: [(id: String, price: String)] = [
        ("gg.sloga.prot.p5", "5.99"),
        ("gg.sloga.prot.p10", "11.99"),
        ("gg.sloga.prot.p25", "29.99"),
        ("gg.sloga.prot.p50", "58.99"),
        ("gg.sloga.prot.p100", "117.99"),
    ]
    static var ids: [String] { packs.map { $0.id } }

    private var session: SKTestSession!

    override func setUpWithError() throws {
        try super.setUpWithError()
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: "Prot", withExtension: "storekit"),
            "Prot.storekit is missing from the test bundle"
        )
        session = try SKTestSession(contentsOf: url)
        session.resetToDefaultState()
        session.disableDialogs = true
        session.askToBuyEnabled = false
        session.storefront = "USA"
        session.clearTransactions()
    }

    override func tearDownWithError() throws {
        session?.clearTransactions()
        session = nil
        try super.tearDownWithError()
    }

    private func unfinishedTransactions() async -> [Transaction] {
        var transactions: [Transaction] = []
        for await verification in Transaction.unfinished {
            transactions.append(verification.unsafePayloadValue)
        }
        return transactions
    }

    // MARK: products

    func testFivePacksAtTheContractPrices() async throws {
        let products = try await ProtStoreKit.products(ids: Self.ids)
        XCTAssertEqual(products.map(\.id), Self.ids, "request order, every pack")
        for product in products {
            XCTAssertFalse(product.displayPrice.isEmpty)
        }
        let raw = try await Product.products(for: Self.ids)
        for pack in Self.packs {
            let product = try XCTUnwrap(raw.first { $0.id == pack.id }, "\(pack.id) missing")
            XCTAssertEqual(product.type, .consumable, pack.id)
            XCTAssertEqual(product.price, Decimal(string: pack.price), pack.id)
        }
    }

    func testUnknownProductsAreLeftOut() async throws {
        let products = try await ProtStoreKit.products(ids: ["gg.sloga.prot.p5", "gg.sloga.prot.nope"])
        XCTAssertEqual(products.map(\.id), ["gg.sloga.prot.p5"])
    }

    // MARK: purchase

    /// Contracts §28 L4c control: finishing inside purchase() must fail this.
    func testPurchaseNeverFinishes() async throws {
        let token = UUID()
        let outcome = await ProtStoreKit.purchase(productId: "gg.sloga.prot.p5", accountToken: token)
        guard case .purchased(let purchase) = outcome else {
            return XCTFail("expected purchased, got \(outcome)")
        }
        let id = try XCTUnwrap(UInt64(purchase.transactionId))
        let unfinished = await unfinishedTransactions()
        let match = unfinished.first { $0.id == id }
        XCTAssertNotNil(match, "purchase() finished the transaction; only finish() may")
        XCTAssertEqual(match?.appAccountToken, token)
        XCTAssertEqual(match?.productID, "gg.sloga.prot.p5")

        // finish() is the one way out, and it reports what it did.
        let finished = await ProtStoreKit.finish(transactionId: id)
        XCTAssertTrue(finished)
        let after = await unfinishedTransactions()
        XCTAssertFalse(after.contains { $0.id == id })
        let again = await ProtStoreKit.finish(transactionId: id)
        XCTAssertFalse(again, "finishing an already finished transaction reported true")
    }

    /// Backstop for testPurchaseNeverFinishes that needs no session: no
    /// finish call in either purchase path (comment lines excluded).
    func testPurchaseSourceNeverFinishes() throws {
        let kit = try SourceScan.region("ProtStoreKit.swift", from: "static func purchase(", to: "static func ")
        XCTAssertFalse(kit.isEmpty)
        XCTAssertFalse(kit.contains("finish("), "ProtStoreKit.purchase calls finish")
        let plugin = try SourceScan.region("ProtStorePlugin.swift", from: "@objc func purchase(", to: "@objc func ")
        XCTAssertFalse(plugin.isEmpty)
        XCTAssertFalse(plugin.contains("finish("), "the plugin's purchase() calls finish")
        // The only finish call in the package is ProtStoreKit.finish's.
        var finishCalls = 0
        for file in ["ProtStoreResults.swift", "ProtStoreKit.swift", "ProtStorePlugin.swift", "ProtStoreUpdateGate.swift"] {
            finishCalls += try SourceScan.code(file).filter { $0.contains(".finish()") }.count
        }
        XCTAssertEqual(finishCalls, 1)
    }

    func testPurchasedResultCarriesTheJwsAndId() async throws {
        let outcome = await ProtStoreKit.purchase(productId: "gg.sloga.prot.p25", accountToken: UUID())
        guard case .purchased(let purchase) = outcome else {
            return XCTFail("expected purchased, got \(outcome)")
        }
        XCTAssertEqual(purchase.productId, "gg.sloga.prot.p25")
        XCTAssertNotNil(UInt64(purchase.transactionId))
        XCTAssertEqual(purchase.signedTransaction.split(separator: ".", omittingEmptySubsequences: false).count, 3)
        let object = outcome.jsObject
        XCTAssertEqual(object["result"] as? String, "purchased")
    }

    func testAskToBuyIsPendingAndLeavesNothingUnfinished() async throws {
        session.askToBuyEnabled = true
        let outcome = await ProtStoreKit.purchase(productId: "gg.sloga.prot.p10", accountToken: UUID())
        XCTAssertEqual(outcome, .pending)
        let unfinished = await unfinishedTransactions()
        XCTAssertTrue(unfinished.isEmpty, "a pending Ask to Buy produced a transaction")
    }

    func testUnknownProductIsProductNotFound() async {
        let outcome = await ProtStoreKit.purchase(productId: "gg.sloga.prot.nope", accountToken: UUID())
        XCTAssertEqual(outcome, .failed(.productNotFound, nil))
    }

    // MARK: recovery

    func testPendingTransactionsListEveryUnfinishedPurchase() async throws {
        var ids: Set<String> = []
        for product in ["gg.sloga.prot.p5", "gg.sloga.prot.p50"] {
            let outcome = await ProtStoreKit.purchase(productId: product, accountToken: UUID())
            guard case .purchased(let purchase) = outcome else {
                return XCTFail("\(product) not purchased")
            }
            ids.insert(purchase.transactionId)
        }
        let listed = await ProtStoreKit.unfinished()
        XCTAssertEqual(Set(listed.map(\.transactionId)), ids)
        for purchase in listed {
            XCTAssertFalse(purchase.signedTransaction.isEmpty)
            XCTAssertEqual(purchase.jsObject["store"] as? String, "apple")
        }
    }

    func testFinishOfAnUnknownIdIsFalse() async {
        let finished = await ProtStoreKit.finish(transactionId: 999_999_999_999)
        XCTAssertFalse(finished)
    }

    // MARK: storefront

    func testStorefrontIsRawAlpha3() async {
        session.storefront = "DEU"
        let country = await ProtStoreKit.storefrontCountry()
        XCTAssertEqual(country, "DEU")
    }
}
