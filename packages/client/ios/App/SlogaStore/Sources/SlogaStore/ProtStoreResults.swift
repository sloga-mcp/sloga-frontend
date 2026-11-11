// ProtStoreResults.swift: the pure half of the ProtStore plugin (Prot S6
// contracts §20). Everything here turns StoreKit values and plugin arguments
// into exactly the objects components/client/protStorePlugin.ts declares.
// Nothing here talks to the store, so XCTest covers it without a session.
//
// Rules this file keeps:
//   - the client never decides whether a purchase counts: a verified and an
//     unverified StoreKit result map to the SAME `purchased` object carrying
//     the JWS, and the server verifies it (contracts §20.2, §9.4). Nothing
//     here matches on the verification case;
//   - nothing here finishes a transaction;
//   - a `message` comes from a fixed vocabulary, never from StoreKit error
//     text, and no JWS or account token is ever logged.
import Foundation
import StoreKit

/// `ProtStoreFailCode` in protStorePlugin.ts, value for value.
enum ProtStoreFailCode: String, CaseIterable {
    case notAvailable = "not_available"
    case productNotFound = "product_not_found"
    /// Play only (ITEM_ALREADY_OWNED). StoreKit 2 has no such answer for a
    /// consumable, so iOS never sends it; kept for the shared union.
    case alreadyOwned = "already_owned"
    case invalidToken = "invalid_token"
    case storeError = "store_error"
}

/// The apple arm of `ProtStorePurchased`.
struct ProtStorePurchasedTransaction: Equatable, Sendable {
    /// Transaction.id in decimal (a UInt64)
    let transactionId: String
    let productId: String
    /// The JWS exactly as StoreKit delivered it. Never logged.
    let signedTransaction: String

    var jsObject: [String: Any] {
        [
            "store": "apple",
            "transaction_id": transactionId,
            "product_id": productId,
            "signed_transaction": signedTransaction,
        ]
    }
}

/// `ProtStorePurchaseResult` in protStorePlugin.ts.
enum ProtStoreOutcome: Equatable {
    case purchased(ProtStorePurchasedTransaction)
    case pending
    case cancelled
    case failed(ProtStoreFailCode, String?)

    /// A second purchase() while one is open (R44, Android parity).
    static let purchaseOpen = ProtStoreOutcome.failed(.storeError, "purchase_open")

    var jsObject: [String: Any] {
        switch self {
        case .purchased(let purchase):
            return ["result": "purchased", "purchase": purchase.jsObject]
        case .pending:
            return ["result": "pending"]
        case .cancelled:
            return ["result": "cancelled"]
        case .failed(let code, let message):
            var object: [String: Any] = ["result": "failed", "code": code.rawValue]
            if let message = message {
                object["message"] = message
            }
            return object
        }
    }
}

/// `ProtStoreProduct` in protStorePlugin.ts.
struct ProtStoreProduct: Equatable {
    let id: String
    /// Localized by StoreKit for the user's storefront. The page shows it as
    /// is; it never formats a price of its own.
    let displayPrice: String

    var jsObject: [String: Any] {
        ["id": id, "displayPrice": displayPrice]
    }
}

/// Pure mapping, unit-tested: PurchaseResult / VerificationResult / thrown
/// errors → the JS result object (contracts §20.2).
enum ProtStoreResultMapping {
    static func result(for purchaseResult: Product.PurchaseResult) -> [String: Any] {
        outcome(for: purchaseResult).jsObject
    }

    static func outcome(for purchaseResult: Product.PurchaseResult) -> ProtStoreOutcome {
        switch purchaseResult {
        case .success(let verification):
            // Verified or not, the JWS goes to the server, which decides. The
            // transaction stays UNFINISHED: the page finishes it only after
            // the server answered (protStoreFlow.ts shouldFinish).
            return .purchased(purchased(from: verification))
        case .pending:
            // Ask to Buy or an interrupted purchase: no money yet, nothing to
            // verify. The approved transaction arrives on Transaction.updates.
            return .pending
        case .userCancelled:
            return .cancelled
        @unknown default:
            return .failed(.storeError, "unknown_purchase_result")
        }
    }

    /// Both verification cases alike: `unsafePayloadValue` is the payload
    /// whether or not StoreKit's local check passed, and the JWS is forwarded
    /// for the server's own check.
    static func purchased(from verification: VerificationResult<Transaction>) -> ProtStorePurchasedTransaction {
        let transaction = verification.unsafePayloadValue
        return purchased(
            transactionId: transaction.id,
            productId: transaction.productID,
            signedTransaction: verification.jwsRepresentation
        )
    }

    static func purchased(
        transactionId: UInt64,
        productId: String,
        signedTransaction: String
    ) -> ProtStorePurchasedTransaction {
        ProtStorePurchasedTransaction(
            transactionId: String(transactionId),
            productId: productId,
            signedTransaction: signedTransaction
        )
    }

    /// An error thrown by Product.products(for:) or product.purchase(...).
    /// A cancel reported as an error is still `cancelled`.
    static func outcome(forThrown error: Error) -> ProtStoreOutcome {
        if let storeKitError = error as? StoreKitError {
            switch storeKitError {
            case .userCancelled:
                return .cancelled
            case .notAvailableInStorefront:
                return .failed(.productNotFound, "not_available_in_storefront")
            case .networkError:
                return .failed(.storeError, "network_error")
            case .systemError:
                return .failed(.storeError, "system_error")
            case .notEntitled:
                return .failed(.storeError, "not_entitled")
            default:
                return .failed(.storeError, "storekit_error")
            }
        }
        if let purchaseError = error as? Product.PurchaseError {
            switch purchaseError {
            case .productUnavailable:
                return .failed(.productNotFound, "product_unavailable")
            case .purchaseNotAllowed:
                // Screen Time / device restrictions
                return .failed(.notAvailable, "purchase_not_allowed")
            default:
                return .failed(.storeError, "purchase_error")
            }
        }
        return .failed(.storeError, "store_error")
    }

    /// `storefront()`'s answer: the RAW alpha-3 country code (contracts §20.1
    /// "iOS alpha-3"; the server maps it to alpha-2, §8.5 / R6). Absent when
    /// StoreKit has no storefront.
    static func storefrontObject(_ countryCode: String?) -> [String: Any] {
        guard let code = countryCode, !code.isEmpty else {
            return [:]
        }
        return ["storefront": code]
    }
}

/// A checked `purchase()` request.
enum ProtStorePurchaseCheck: Equatable {
    case valid(productId: String, accountToken: UUID)
    /// Answered at once; the purchase sheet is never opened.
    case refused(ProtStoreOutcome)
}

/// Argument checks for the plugin methods (pure, unit-tested).
enum ProtStoreRequests {
    /// The five packs today (contracts §4); room for a larger table, never an
    /// unbounded list.
    static let maxProductIds = 20
    /// v0 `DataProtStoreIntent.product_id` length bound (contracts §3)
    static let maxProductIdLength = 64

    /// `account_token` → appAccountToken. Only a canonical 8-4-4-4-12 UUID
    /// (the server issues lowercase UUID v4) passes. Never force-unwrapped:
    /// anything else is refused before the sheet opens (contracts §20.2).
    static func accountToken(_ raw: String?) -> UUID? {
        guard let raw = raw, raw.utf8.count == 36 else {
            return nil
        }
        return UUID(uuidString: raw)
    }

    static func productId(_ raw: String?) -> String? {
        guard let raw = raw, !raw.isEmpty, raw.utf8.count <= maxProductIdLength else {
            return nil
        }
        return raw
    }

    /// Token first: a bad token is `invalid_token` whatever the product.
    static func purchase(productId rawProductId: String?, accountToken rawToken: String?) -> ProtStorePurchaseCheck {
        guard let token = accountToken(rawToken) else {
            return .refused(.failed(.invalidToken, nil))
        }
        guard let id = productId(rawProductId) else {
            return .refused(.failed(.productNotFound, nil))
        }
        return .valid(productId: id, accountToken: token)
    }

    /// `products({ids})`: the valid ids, in order. An element that is not a
    /// non-empty string of at most 64 bytes, and any duplicate, is dropped
    /// silently; at most the first 20 valid ids are kept; a missing or
    /// non-array `ids` gives none. Never a whole-call rejection (R45, both
    /// platforms).
    static func productIds(_ raw: [Any]?) -> [String] {
        var ids: [String] = []
        for value in raw ?? [] {
            guard ids.count < maxProductIds else {
                break
            }
            if let id = productId(value as? String), !ids.contains(id) {
                ids.append(id)
            }
        }
        return ids
    }

    /// `finish({transaction_id})`: 1 to 20 ASCII digits that fit a UInt64
    /// (the shape of a StoreKit transaction id, contracts §4).
    static func transactionId(_ raw: String?) -> UInt64? {
        guard let raw = raw,
              (1...20).contains(raw.utf8.count),
              raw.utf8.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 })
        else {
            return nil
        }
        return UInt64(raw)
    }
}
