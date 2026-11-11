// ProtStoreUpdateGateTests.swift: purchase() settles BEFORE any
// `transactionUpdated` held while it was open (contracts §35). Synchronous
// tests: XCTest runs them on the main thread, which the gate requires.
import XCTest
@testable import SlogaStore

final class ProtStoreUpdateGateTests: XCTestCase {
    private var log: [String] = []

    override func setUp() {
        super.setUp()
        log = []
    }

    private func makeGate() -> ProtStoreUpdateGate {
        ProtStoreUpdateGate { [unowned self] update in
            self.log.append("notify:\(update.transactionId):\(update.signedTransaction)")
        }
    }

    private func tx(_ id: UInt64, _ jws: String = "j") -> ProtStorePurchasedTransaction {
        ProtStoreResultMapping.purchased(transactionId: id, productId: "gg.sloga.prot.p5", signedTransaction: jws)
    }

    func testUpdateWithNoOpenPurchaseIsNotifiedAtOnce() {
        let gate = makeGate()
        gate.offer(tx(1))
        XCTAssertEqual(log, ["notify:1:j"])
        XCTAssertEqual(gate.heldCount, 0)
    }

    func testUpdateDuringPurchaseWaitsUntilResolved() {
        let gate = makeGate()
        gate.beginPurchase()
        gate.offer(tx(7))
        XCTAssertEqual(log, [], "an update was notified while the purchase was open")
        XCTAssertEqual(gate.heldCount, 1)
        gate.endPurchase { log.append("resolve") }
        XCTAssertEqual(log, ["resolve", "notify:7:j"])
        XCTAssertEqual(gate.heldCount, 0)
    }

    /// The §35 rule itself: the same transaction arrives on
    /// Transaction.updates while its own purchase() is open; the promise
    /// settles first.
    func testResolveComesBeforeHeldUpdate() {
        let gate = makeGate()
        gate.beginPurchase()
        gate.offer(tx(42))
        gate.endPurchase { log.append("resolve:42") }
        XCTAssertEqual(log, ["resolve:42", "notify:42:j"])
    }

    func testHeldUntilEveryOpenPurchaseSettles() {
        let gate = makeGate()
        gate.beginPurchase()
        gate.beginPurchase()
        gate.offer(tx(1))
        gate.endPurchase { log.append("resolve:a") }
        XCTAssertEqual(log, ["resolve:a"])
        gate.offer(tx(2))
        gate.endPurchase { log.append("resolve:b") }
        XCTAssertEqual(log, ["resolve:a", "resolve:b", "notify:1:j", "notify:2:j"])
    }

    func testHeldUpdatesKeepOneEntryPerTransactionInArrivalOrder() {
        let gate = makeGate()
        gate.beginPurchase()
        gate.offer(tx(1, "old"))
        gate.offer(tx(2))
        gate.offer(tx(1, "new"))
        XCTAssertEqual(gate.heldCount, 2)
        gate.endPurchase { log.append("resolve") }
        XCTAssertEqual(log, ["resolve", "notify:1:new", "notify:2:j"])
    }

    func testHasOpenPurchaseTracksBeginAndEnd() {
        let gate = makeGate()
        XCTAssertFalse(gate.hasOpenPurchase)
        gate.beginPurchase()
        XCTAssertTrue(gate.hasOpenPurchase)
        gate.endPurchase { log.append("resolve") }
        XCTAssertFalse(gate.hasOpenPurchase)
    }

    func testUnbalancedEndNeverUnderflows() {
        let gate = makeGate()
        gate.endPurchase { log.append("resolve") }
        gate.offer(tx(3))
        XCTAssertEqual(log, ["resolve", "notify:3:j"])
        gate.beginPurchase()
        gate.offer(tx(4))
        XCTAssertEqual(log, ["resolve", "notify:3:j"], "a stray end left the gate open")
    }

    /// The plugin's purchase path settles through the gate: beginPurchase
    /// before the StoreKit call, and the purchase result resolved INSIDE
    /// endPurchase's closure (its only statement), never beside it.
    func testPluginPurchaseResolvesThroughTheGate() throws {
        let lines = try SourceScan.region("ProtStorePlugin.swift", from: "@objc func purchase(", to: "@objc func ")
            .components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
        let begin = try XCTUnwrap(lines.firstIndex(of: "gate.beginPurchase()"), "purchase() never opens the gate")
        let storeCall = try XCTUnwrap(
            lines.firstIndex { $0.contains("await ProtStoreKit.purchase(") },
            "purchase() never calls ProtStoreKit.purchase"
        )
        let end = try XCTUnwrap(lines.firstIndex(of: "gate.endPurchase {"), "purchase() never settles through the gate")
        XCTAssertLessThan(begin, storeCall)
        XCTAssertLessThan(storeCall, end)
        // R44: a second purchase() while one is open is refused, checked
        // right before beginPurchase with nothing (no await) in between.
        let refuse = try XCTUnwrap(
            lines.firstIndex(of: "guard !gate.hasOpenPurchase else {"),
            "purchase() never refuses a second open purchase"
        )
        XCTAssertEqual(Array(lines[(refuse + 1)...(refuse + 4)]), [
            "call.resolve(ProtStoreOutcome.purchaseOpen.jsObject)", "return", "}", "gate.beginPurchase()",
        ])
        XCTAssertEqual(refuse + 4, begin)
        XCTAssertGreaterThan(lines.count, end + 2)
        XCTAssertEqual(lines[end + 1], "call.resolve(outcome.jsObject)", "the result is not resolved inside endPurchase")
        XCTAssertEqual(lines[end + 2], "}")
        // Exactly two outcome resolves: the refused-arguments one (before the
        // gate opens) and the gated one.
        let resolves = lines.indices.filter { lines[$0] == "call.resolve(outcome.jsObject)" }
        XCTAssertEqual(resolves.count, 2)
        XCTAssertLessThan(resolves[0], begin)
        XCTAssertEqual(resolves.last, end + 1)
    }
}
