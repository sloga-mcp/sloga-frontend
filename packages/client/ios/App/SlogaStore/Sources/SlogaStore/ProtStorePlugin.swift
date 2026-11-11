// ProtStorePlugin.swift: the Capacitor plugin `ProtStore` of the iOS app
// (Prot S6: Prot packs sold as App Store consumables, StoreKit 2). The
// page's side is packages/client/components/client/protStorePlugin.ts; the
// contract is S6 contracts §20 (TS ↔ Swift ↔ Java), §25 and §35.
//
// What it does, and what it never does:
//   - purchase() opens the App Store sheet for one Prot pack with the
//     server's one-time account token as appAccountToken and hands the
//     signed transaction (JWS) back UNFINISHED. The server verifies it; the
//     page calls finish() only after the server answered. Nothing here
//     finishes a transaction on its own, and a transaction StoreKit could not
//     verify locally is forwarded exactly like a verified one: local
//     verification never decides a credit.
//   - An account token that is not a UUID is refused (`invalid_token`)
//     before the sheet opens; it is never force-unwrapped.
//   - Transaction.updates is listened to for the plugin's life (started in
//     load) and fed to the page as `transactionUpdated`. An update arriving
//     while a purchase sheet is open waits until that purchase() promise has
//     settled (ProtStoreUpdateGate, contracts §35).
//   - pendingTransactions() lists Transaction.unfinished for the recovery
//     worker; storefront() returns the RAW alpha-3 storefront (the server maps
//     it, contracts §8.5 / R6).
//   - Promoted in-app purchases are not supported (E10), and there is no web
//     purchase link or external-purchase code here (owner decision on E8).
//   - Nothing is logged: no JWS, no account token, no StoreKit error text.
//
// Registration (lane L4d, contracts §25): SlogaBridgeViewController arms the
// plugin and registers one instance only after MainFrameBridgeGuard is in
// place, so an embed frame can never open a store sheet:
//
//     ProtStorePlugin.arm()
//     bridge.registerPluginInstance(ProtStorePlugin())
//
// An instance Capacitor creates by class name without that (its
// NSClassFromString fallback for an unknown plugin id) stays inert: every
// method answers "not available" and load() starts no listener.
//
// Threads: Capacitor calls the methods below on its plugin queue. Each one
// only reads its arguments, then hands the StoreKit work to a @MainActor
// task, so every promise result and every event is made on the main thread
// (the gate's ordering depends on that).
import Capacitor
import Foundation
import StoreKit

@objc(ProtStorePlugin)
public final class ProtStorePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ProtStorePlugin"
    public let jsName = "ProtStore"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "products", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pendingTransactions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finish", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "storefront", returnType: CAPPluginReturnPromise),
    ]

    /// The event ProtStoreWorker.tsx listens to.
    static let transactionUpdatedEvent = "transactionUpdated"

    // Same pattern as E2eePlugin.arm(): armed only by the bridge view
    // controller, right after the main-frame guard is installed.
    private static let armLock = NSLock()
    private static var armed = false

    /// Called once by SlogaBridgeViewController after MainFrameBridgeGuard is
    /// in place and before it registers the instance (contracts §25).
    public static func arm() {
        armLock.lock()
        armed = true
        armLock.unlock()
    }

    static func isArmed() -> Bool {
        armLock.lock()
        defer { armLock.unlock() }
        return armed
    }

    /// The Transaction.updates task, kept for the plugin's life. Readable by
    /// the tests (an unarmed load() must leave it nil).
    private(set) var updatesTask: Task<Void, Never>?

    private lazy var gate: ProtStoreUpdateGate = ProtStoreUpdateGate(notify: { [weak self] update in
        self?.notifyListeners(ProtStorePlugin.transactionUpdatedEvent, data: update.jsObject)
    })

    deinit {
        updatesTask?.cancel()
    }

    override public func load() {
        super.load()
        guard Self.isArmed(), updatesTask == nil else {
            return
        }
        let gate = self.gate
        updatesTask = ProtStoreKit.listenForUpdates { update in
            gate.offer(update)
        }
    }

    /// AppStore.canMakePayments (false when not armed)
    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": Self.isArmed() && ProtStoreKit.canMakePayments()])
    }

    /// Product.products(for:) → { products: [{id, displayPrice}] }
    @objc func products(_ call: CAPPluginCall) {
        guard Self.isArmed() else {
            call.resolve(["products": [Any]()])
            return
        }
        // Invalid ids are dropped, never a whole-call rejection (R45).
        let ids = ProtStoreRequests.productIds(call.getArray("ids")?.map { $0 as Any })
        Task { @MainActor in
            do {
                let products = try await ProtStoreKit.products(ids: ids)
                call.resolve(["products": products.map { $0.jsObject }])
            } catch {
                call.reject("store_error", "store_error")
            }
        }
    }

    /// product.purchase(options: [.appAccountToken(token)]) → the
    /// ProtStorePurchaseResult union. Never finishes the transaction.
    @objc func purchase(_ call: CAPPluginCall) {
        guard Self.isArmed() else {
            call.resolve(ProtStoreOutcome.failed(.notAvailable, nil).jsObject)
            return
        }
        let productId: String
        let accountToken: UUID
        switch ProtStoreRequests.purchase(
            productId: call.getString("product_id"),
            accountToken: call.getString("account_token")
        ) {
        case .refused(let outcome):
            // The sheet never opens (contracts §20.2).
            call.resolve(outcome.jsObject)
            return
        case .valid(let id, let token):
            productId = id
            accountToken = token
        }
        Task { @MainActor [weak self] in
            guard let gate = self?.gate else {
                call.resolve(ProtStoreOutcome.failed(.notAvailable, nil).jsObject)
                return
            }
            // One open purchase at a time (R44, Android parity). No await
            // between this check and beginPurchase, so on the main actor the
            // pair is atomic.
            guard !gate.hasOpenPurchase else {
                call.resolve(ProtStoreOutcome.purchaseOpen.jsObject)
                return
            }
            gate.beginPurchase()
            let outcome = await ProtStoreKit.purchase(productId: productId, accountToken: accountToken)
            // Resolve FIRST, then release updates held meanwhile (§35).
            gate.endPurchase {
                call.resolve(outcome.jsObject)
            }
        }
    }

    /// Transaction.unfinished → { purchases: [...] }
    @objc func pendingTransactions(_ call: CAPPluginCall) {
        guard Self.isArmed() else {
            call.resolve(["purchases": [Any]()])
            return
        }
        Task { @MainActor in
            let purchases = await ProtStoreKit.unfinished()
            call.resolve(["purchases": purchases.map { $0.jsObject }])
        }
    }

    /// Finishes the unfinished transaction with this id, which the page asks
    /// for only after the server answered. Never called from anywhere else.
    @objc func finish(_ call: CAPPluginCall) {
        guard Self.isArmed() else {
            call.resolve(["finished": false])
            return
        }
        guard let transactionId = ProtStoreRequests.transactionId(call.getString("transaction_id")) else {
            call.reject("invalid_argument", "invalid_argument")
            return
        }
        Task { @MainActor in
            let finished = await ProtStoreKit.finish(transactionId: transactionId)
            call.resolve(["finished": finished])
        }
    }

    /// Storefront.current?.countryCode, raw alpha-3 → { storefront? }
    @objc func storefront(_ call: CAPPluginCall) {
        guard Self.isArmed() else {
            call.resolve([:])
            return
        }
        Task { @MainActor in
            let country = await ProtStoreKit.storefrontCountry()
            call.resolve(ProtStoreResultMapping.storefrontObject(country))
        }
    }
}
