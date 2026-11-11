// ProtStoreUpdateGate.swift: the order between a purchase() promise and the
// `transactionUpdated` event (Prot S6 contracts §35, the §20.3 addition).
//
// While a purchase sheet is open, StoreKit may deliver the purchased
// transaction (or another one) on Transaction.updates as well. The page must
// see the purchase() promise settle FIRST, so the purchase sheet's flow, not
// the recovery worker, normally takes the claim on that transaction (R29 and
// R30 keep the page correct either way). The gate holds every update that
// arrives while any purchase is open, settles the purchase, and only then
// releases what it held, one entry per transaction, in arrival order.
//
// Main thread only: the plugin drives it from @MainActor tasks (each method
// checks). Capacitor posts a promise result and an event to the web view in
// the order they are made, so "resolve, then notify" here is the order the
// page sees.
import Foundation

final class ProtStoreUpdateGate: @unchecked Sendable {
    // @unchecked: every member is touched on the main thread only, which
    // dispatchPrecondition enforces at run time.
    private let notify: (ProtStorePurchasedTransaction) -> Void
    private var openPurchases = 0
    private var held: [ProtStorePurchasedTransaction] = []

    init(notify: @escaping (ProtStorePurchasedTransaction) -> Void) {
        self.notify = notify
    }

    /// Whether a purchase sheet is open. The plugin refuses a second
    /// purchase() while this is true (R44, Android parity).
    var hasOpenPurchase: Bool {
        dispatchPrecondition(condition: .onQueue(.main))
        return openPurchases > 0
    }

    /// Updates arriving from now on wait for `endPurchase`.
    func beginPurchase() {
        dispatchPrecondition(condition: .onQueue(.main))
        openPurchases += 1
    }

    /// Settles one purchase: `resolve` (the promise) runs FIRST, then, once no
    /// purchase is open, every held update is notified.
    func endPurchase(resolve: () -> Void) {
        dispatchPrecondition(condition: .onQueue(.main))
        // 🔴 This order is the contract (§35): settle the promise, THEN
        // release the updates held while it was open.
        resolve()
        if openPurchases > 0 {
            openPurchases -= 1
        }
        guard openPurchases == 0 else {
            return
        }
        let released = held
        held.removeAll()
        for update in released {
            notify(update)
        }
    }

    /// A transaction from Transaction.updates: notified now, or held while a
    /// purchase is open.
    func offer(_ update: ProtStorePurchasedTransaction) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard openPurchases > 0 else {
            notify(update)
            return
        }
        if let index = held.firstIndex(where: { $0.transactionId == update.transactionId }) {
            held[index] = update
        } else {
            held.append(update)
        }
    }

    /// For tests: updates waiting on an open purchase.
    var heldCount: Int {
        dispatchPrecondition(condition: .onQueue(.main))
        return held.count
    }
}
