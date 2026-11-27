// ProtStorePluginTests.swift: the plugin's bridged surface (contracts §20.2)
// and the arm latch. No bridge, no StoreKit session: the instance is built
// and inspected, never loaded. No test in this target may call arm().
import Capacitor
import XCTest
@testable import SlogaStore

final class ProtStorePluginTests: XCTestCase {
    func testBridgedSurfaceMatchesTheContract() {
        let plugin = ProtStorePlugin()
        XCTAssertEqual(plugin.jsName, "ProtStore")
        XCTAssertEqual(plugin.identifier, "ProtStorePlugin")
        XCTAssertEqual(
            plugin.pluginMethods.compactMap { $0.name },
            ["isAvailable", "products", "purchase", "pendingTransactions", "finish", "storefront"]
        )
        XCTAssertEqual(ProtStorePlugin.transactionUpdatedEvent, "transactionUpdated")
    }

    /// An instance Capacitor creates by class name, without the bridge view
    /// controller's arm() behind the main-frame guard, stays inert: it
    /// answers "not available" (synchronously, before any StoreKit call) and
    /// load() starts no Transaction.updates listener (NIT 8).
    func testPluginIsInertUntilArmed() throws {
        XCTAssertFalse(ProtStorePlugin.isArmed())
        let plugin = ProtStorePlugin()

        plugin.load()
        XCTAssertNil(plugin.updatesTask, "an unarmed load() started the updates listener")

        let purchase = answer { plugin.purchase($0) }
        XCTAssertEqual(purchase?["result"] as? String, "failed")
        XCTAssertEqual(purchase?["code"] as? String, "not_available")

        let available = answer { plugin.isAvailable($0) }
        XCTAssertEqual(available?["available"] as? Bool, false)
    }

    /// Runs one plugin method with a valid purchase request and returns the
    /// object it resolved synchronously (nil if it did not).
    private func answer(_ method: (CAPPluginCall) -> Void) -> [String: Any]? {
        var resolved: [String: Any]?
        // Typed annotations so this reads the same whether Capacitor's ObjC
        // headers declare these nonnull or implicitly unwrapped.
        let call: CAPPluginCall = CAPPluginCall(
            callbackId: "test",
            options: [
                "product_id": "gg.sloga.prot.p5",
                "account_token": "6f1c2b7e-4d2a-4c8e-9b1f-0a3d5e7f9b21",
                "ids": ["gg.sloga.prot.p5"],
            ],
            success: { result, _ in resolved = (result as CAPPluginCallResult?)?.data as? [String: Any] },
            error: { _ in XCTFail("an unarmed call was rejected instead of answered") }
        )
        method(call)
        return resolved
    }
}
