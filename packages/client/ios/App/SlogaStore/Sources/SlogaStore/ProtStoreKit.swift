// ProtStoreKit.swift: every StoreKit 2 call the ProtStore plugin makes, in
// one place, so the StoreKit-testing XCTests drive exactly the code the
// plugin runs (Prot S6 contracts §20.2, §25).
//
// Rules:
//   - purchase() never finishes a transaction. finish(transactionId:) is the
//     ONLY finish call in this package, and it runs only when the page asks
//     (after the server answered, protStoreFlow.ts shouldFinish);
//   - every transaction read (unfinished, updates, finish lookup) takes
//     `unsafePayloadValue`: local verification never filters what reaches
//     the server, and never decides a credit;
//   - nothing is logged.
import Foundation
import StoreKit

enum ProtStoreKit {
    /// AppStore.canMakePayments (false under Screen Time restrictions)
    static func canMakePayments() -> Bool {
        AppStore.canMakePayments
    }

    /// Product.products(for:) → [{id, displayPrice}] in the order asked.
    /// Only consumables: every Prot pack is one (contracts §4); a product the
    /// console misconfigured is left out rather than sold.
    static func products(ids: [String]) async throws -> [ProtStoreProduct] {
        guard !ids.isEmpty else {
            return []
        }
        let found = try await Product.products(for: ids)
        return ids.compactMap { id in
            found.first { $0.id == id && $0.type == .consumable }
        }.map { ProtStoreProduct(id: $0.id, displayPrice: $0.displayPrice) }
    }

    /// One purchase sheet. The caller has already checked the account token
    /// (ProtStoreRequests.purchase), so the sheet never opens without one.
    /// The purchased transaction is returned UNFINISHED.
    static func purchase(productId: String, accountToken: UUID) async -> ProtStoreOutcome {
        let product: Product
        do {
            guard let found = try await Product.products(for: [productId]).first(where: { $0.id == productId }),
                  found.type == .consumable
            else {
                return .failed(.productNotFound, nil)
            }
            product = found
        } catch {
            return ProtStoreResultMapping.outcome(forThrown: error)
        }
        do {
            let result = try await product.purchase(options: [.appAccountToken(accountToken)])
            return ProtStoreResultMapping.outcome(for: result)
        } catch {
            return ProtStoreResultMapping.outcome(forThrown: error)
        }
    }

    /// Transaction.unfinished, drained (the recovery worker's list).
    static func unfinished() async -> [ProtStorePurchasedTransaction] {
        var purchases: [ProtStorePurchasedTransaction] = []
        for await verification in Transaction.unfinished {
            purchases.append(ProtStoreResultMapping.purchased(from: verification))
        }
        return purchases
    }

    /// Finishes the unfinished transaction with this id. False when no
    /// unfinished transaction has it (already finished, or unknown).
    static func finish(transactionId: UInt64) async -> Bool {
        for await verification in Transaction.unfinished {
            let transaction = verification.unsafePayloadValue
            if transaction.id == transactionId {
                await transaction.finish()
                return true
            }
        }
        return false
    }

    /// Storefront.current?.countryCode: ISO 3166-1 alpha-3, raw.
    static func storefrontCountry() async -> String? {
        await Storefront.current?.countryCode
    }

    /// Feeds every Transaction.updates element to `deliver` on the main
    /// actor until the returned task is cancelled.
    static func listenForUpdates(
        _ deliver: @escaping @Sendable @MainActor (ProtStorePurchasedTransaction) -> Void
    ) -> Task<Void, Never> {
        Task.detached(priority: .utility) {
            for await verification in Transaction.updates {
                await deliver(ProtStoreResultMapping.purchased(from: verification))
            }
        }
    }
}
