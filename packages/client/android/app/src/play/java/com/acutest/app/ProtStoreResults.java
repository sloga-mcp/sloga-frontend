package com.acutest.app;

import com.android.billingclient.api.BillingClient.BillingResponseCode;
import com.android.billingclient.api.Purchase.PurchaseState;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Pure result shaping for {@link ProtStorePlugin}: Play Billing response codes
 * and purchase facts in, the JS shapes of `components/client/protStorePlugin.ts`
 * out. No Android or Capacitor types (plain maps and lists only), so
 * ProtStoreResultsTest runs on the JVM without a device; the plugin converts
 * the maps to JSObject at the bridge.
 *
 * Nothing here decides whether a purchase counts. A `purchased` result only
 * hands the purchase token to the web layer, which sends it to the server; the
 * server verifies it with Google and consumes it.
 */
final class ProtStoreResults {
    private ProtStoreResults() {}

    /**
     * The intent token the server issues for Play (43 chars base64url).
     * Checked here as base64url of 1..64 chars, Play's limit for
     * obfuscatedAccountId; anything else never opens the sheet.
     */
    private static final Pattern ACCOUNT_TOKEN = Pattern.compile("[A-Za-z0-9_-]{1,64}");

    /** Play product ids are at most 64 chars (the server's validator agrees). */
    private static final int MAX_PRODUCT_ID_LENGTH = 64;

    /** One Play purchase, reduced to what the JS side may see. */
    static final class Sale {
        final List<String> productIds;
        final String purchaseToken;
        final int purchaseState;
        final String orderId;

        Sale(List<String> productIds, String purchaseToken, int purchaseState, String orderId) {
            this.productIds = productIds == null
                    ? Collections.<String>emptyList()
                    : productIds;
            this.purchaseToken = purchaseToken;
            this.purchaseState = purchaseState;
            this.orderId = orderId;
        }
    }

    /** Where {@link #deliverUpdate} sends its output, in call order. */
    interface Delivery {
        /** Settles the open purchase() call. Called at most once per update. */
        void resolvePurchase(Map<String, Object> result);

        /** One `transactionUpdated` event; the payload is a ProtStorePurchased. */
        void transactionUpdated(Map<String, Object> purchase);
    }

    /** BillingResult code of a failed call → the JS ProtStoreFailCode */
    static String failCode(int billingResponseCode) {
        switch (billingResponseCode) {
            case BillingResponseCode.ITEM_ALREADY_OWNED:
                return "already_owned";
            case BillingResponseCode.ITEM_UNAVAILABLE:
                return "product_not_found";
            case BillingResponseCode.BILLING_UNAVAILABLE:
            case BillingResponseCode.SERVICE_UNAVAILABLE:
                return "not_available";
            default:
                return "store_error";
        }
    }

    /**
     * The `result` of a purchase() answer. Only OK with a PURCHASED purchase
     * is "purchased"; OK with a PENDING purchase is "pending" (never sent to
     * the server); USER_CANCELED is "cancelled"; everything else, including
     * OK with an unknown purchase state, is "failed".
     */
    static String resultFor(int billingResponseCode, int purchaseState) {
        if (billingResponseCode == BillingResponseCode.USER_CANCELED) return "cancelled";
        if (billingResponseCode != BillingResponseCode.OK) return "failed";
        if (purchaseState == PurchaseState.PURCHASED) return "purchased";
        if (purchaseState == PurchaseState.PENDING) return "pending";
        return "failed";
    }

    /** Whether purchase() may hand this token to Play as obfuscatedAccountId. */
    static boolean isAccountToken(String token) {
        return token != null && ACCOUNT_TOKEN.matcher(token).matches();
    }

    /** Whether a product id from JS is worth asking Play about. */
    static boolean isProductId(String productId) {
        return productId != null
                && !productId.isEmpty()
                && productId.length() <= MAX_PRODUCT_ID_LENGTH;
    }

    /**
     * A ProtStorePurchased for a sale that names the product and carries a
     * token; null otherwise. Exactly the fields of contracts 20.1: no
     * `quantity` (R41; the server reads it from Google), and `order_id`
     * only when Play gave one.
     */
    static Map<String, Object> purchased(Sale sale, String productId) {
        if (sale == null || productId == null || productId.isEmpty()) return null;
        if (sale.purchaseToken == null || sale.purchaseToken.isEmpty()) return null;
        Map<String, Object> purchase = new LinkedHashMap<>();
        purchase.put("store", "play");
        purchase.put("product_id", productId);
        purchase.put("purchase_token", sale.purchaseToken);
        if (sale.orderId != null && !sale.orderId.isEmpty()) {
            purchase.put("order_id", sale.orderId);
        }
        return purchase;
    }

    /** The sale's first product id, or null (one-time products carry one) */
    static String firstProduct(Sale sale) {
        if (sale == null) return null;
        for (String id : sale.productIds) {
            if (id != null && !id.isEmpty()) return id;
        }
        return null;
    }

    /** `{ result: "failed", code, message? }` */
    static Map<String, Object> failed(String code, String message) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("result", "failed");
        result.put("code", code);
        if (message != null && !message.isEmpty()) result.put("message", message);
        return result;
    }

    /**
     * The purchase() answer for a billing code and the sale that matched the
     * product (null when Play returned none). `message` is Play's debug text;
     * the web layer logs it and never shows it.
     */
    static Map<String, Object> purchaseResult(int billingResponseCode, Sale sale,
            String productId, String message) {
        int state = sale == null ? PurchaseState.UNSPECIFIED_STATE : sale.purchaseState;
        String kind = resultFor(billingResponseCode, state);
        Map<String, Object> result = new LinkedHashMap<>();
        switch (kind) {
            case "purchased": {
                Map<String, Object> purchase = purchased(sale, productId);
                if (purchase == null) return failed("store_error", message);
                result.put("result", "purchased");
                result.put("purchase", purchase);
                return result;
            }
            case "pending":
                return pendingResult();
            case "cancelled":
                result.put("result", "cancelled");
                return result;
            default:
                return failed(
                        billingResponseCode == BillingResponseCode.OK
                                ? "store_error"
                                : failCode(billingResponseCode),
                        message);
        }
    }

    /** `{ result: "pending" }`: a PENDING sale, or a stale sheet (R40) */
    static Map<String, Object> pendingResult() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("result", "pending");
        return result;
    }

    /** `pendingTransactions()`: PURCHASED sales only, malformed ones dropped */
    static List<Map<String, Object>> pendingList(List<Sale> sales) {
        List<Map<String, Object>> out = new ArrayList<>();
        if (sales == null) return out;
        for (Sale sale : sales) {
            if (sale == null || sale.purchaseState != PurchaseState.PURCHASED) continue;
            Map<String, Object> purchase = purchased(sale, firstProduct(sale));
            if (purchase != null) out.add(purchase);
        }
        return out;
    }

    /** `finish()` on Play: never finishes anything; the server consumes. */
    static Map<String, Object> finishResult() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("finished", false);
        return result;
    }

    /**
     * One onPurchasesUpdated delivery.
     *
     * `awaitingProductId` is the product of the open purchase() call whose
     * billing flow has launched, or null. That call is settled FIRST, and
     * only then are `transactionUpdated` listeners told about PURCHASED
     * sales (the matched one included), so the purchase sheet, not the
     * recovery worker, normally claims the transaction (contracts 20.3/35).
     *
     * With OK, the call is settled by the sale that names its product; an OK
     * update that only carries other sales (a pending purchase completing
     * meanwhile) leaves it open for the flow's own result. An OK update with
     * no sale at all settles it as failed. Any other code settles it at once.
     * PENDING sales are never notified, and nothing is notified on a non-OK
     * code.
     *
     * @return whether the purchase() call was settled
     */
    static boolean deliverUpdate(int billingResponseCode, List<Sale> sales,
            String awaitingProductId, String message, Delivery out) {
        List<Sale> list = sales == null ? Collections.<Sale>emptyList() : sales;
        boolean settled = false;

        if (awaitingProductId != null) {
            if (billingResponseCode != BillingResponseCode.OK) {
                out.resolvePurchase(purchaseResult(billingResponseCode, null, awaitingProductId,
                        message));
                settled = true;
            } else {
                Sale match = null;
                for (Sale sale : list) {
                    if (sale != null && sale.productIds.contains(awaitingProductId)) {
                        match = sale;
                        break;
                    }
                }
                if (match != null) {
                    out.resolvePurchase(purchaseResult(billingResponseCode, match,
                            awaitingProductId, message));
                    settled = true;
                } else if (list.isEmpty()) {
                    out.resolvePurchase(failed("store_error", message));
                    settled = true;
                }
            }
        }

        if (billingResponseCode == BillingResponseCode.OK) {
            for (Sale sale : list) {
                if (sale == null || sale.purchaseState != PurchaseState.PURCHASED) continue;
                Map<String, Object> purchase = purchased(sale, firstProduct(sale));
                if (purchase != null) out.transactionUpdated(purchase);
            }
        }
        return settled;
    }
}
