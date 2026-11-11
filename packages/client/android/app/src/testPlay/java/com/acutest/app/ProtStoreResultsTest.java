package com.acutest.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import com.android.billingclient.api.BillingClient.BillingResponseCode;
import com.android.billingclient.api.Purchase.PurchaseState;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.junit.Test;

/**
 * JVM tests for {@link ProtStoreResults} (play flavor; run by
 * testPlayDebugUnitTest), plus source scans of ProtStorePlugin.java for the
 * rules a host test cannot drive: the plugin never consumes or acknowledges a
 * purchase, and it tells listeners only through deliverUpdate.
 */
public class ProtStoreResultsTest {

    private static final String TOKEN_43 = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";

    private static ProtStoreResults.Sale sale(String product, String token, int state,
            String orderId) {
        return new ProtStoreResults.Sale(Collections.singletonList(product), token, state,
                orderId);
    }

    /** Exactly the ProtStorePurchased fields of contracts 20.1; no quantity (R41) */
    private static Map<String, Object> playPurchase(String product, String token,
            String orderId) {
        Map<String, Object> purchase = new LinkedHashMap<>();
        purchase.put("store", "play");
        purchase.put("product_id", product);
        purchase.put("purchase_token", token);
        if (orderId != null) purchase.put("order_id", orderId);
        return purchase;
    }

    /** Records every Delivery call as one line, in order */
    private static final class Recorder implements ProtStoreResults.Delivery {
        final List<String> calls = new ArrayList<>();
        final List<Map<String, Object>> resolved = new ArrayList<>();
        final List<Map<String, Object>> notified = new ArrayList<>();

        @Override
        public void resolvePurchase(Map<String, Object> result) {
            calls.add("resolve:" + result.get("result"));
            resolved.add(result);
        }

        @Override
        public void transactionUpdated(Map<String, Object> purchase) {
            calls.add("notify:" + purchase.get("purchase_token"));
            notified.add(purchase);
        }
    }

    // ---- failCode / resultFor (contracts 20.3) ----

    @Test
    public void failCodeTable() {
        assertEquals("already_owned", ProtStoreResults.failCode(BillingResponseCode.ITEM_ALREADY_OWNED));
        assertEquals("product_not_found", ProtStoreResults.failCode(BillingResponseCode.ITEM_UNAVAILABLE));
        assertEquals("not_available", ProtStoreResults.failCode(BillingResponseCode.BILLING_UNAVAILABLE));
        assertEquals("not_available", ProtStoreResults.failCode(BillingResponseCode.SERVICE_UNAVAILABLE));
        assertEquals("store_error", ProtStoreResults.failCode(BillingResponseCode.ERROR));
        assertEquals("store_error", ProtStoreResults.failCode(BillingResponseCode.DEVELOPER_ERROR));
        assertEquals("store_error", ProtStoreResults.failCode(BillingResponseCode.NETWORK_ERROR));
        assertEquals("store_error", ProtStoreResults.failCode(BillingResponseCode.SERVICE_DISCONNECTED));
        assertEquals("store_error", ProtStoreResults.failCode(BillingResponseCode.FEATURE_NOT_SUPPORTED));
        assertEquals("store_error", ProtStoreResults.failCode(BillingResponseCode.ITEM_NOT_OWNED));
        assertEquals("store_error", ProtStoreResults.failCode(12345));
    }

    @Test
    public void resultForTable() {
        assertEquals("purchased", ProtStoreResults.resultFor(BillingResponseCode.OK, PurchaseState.PURCHASED));
        assertEquals("pending", ProtStoreResults.resultFor(BillingResponseCode.OK, PurchaseState.PENDING));
        assertEquals("failed", ProtStoreResults.resultFor(BillingResponseCode.OK, PurchaseState.UNSPECIFIED_STATE));
        assertEquals("cancelled", ProtStoreResults.resultFor(BillingResponseCode.USER_CANCELED, PurchaseState.PURCHASED));
        assertEquals("cancelled", ProtStoreResults.resultFor(BillingResponseCode.USER_CANCELED, PurchaseState.UNSPECIFIED_STATE));
        // A PURCHASED state never wins over a failed code
        assertEquals("failed", ProtStoreResults.resultFor(BillingResponseCode.ERROR, PurchaseState.PURCHASED));
        assertEquals("failed", ProtStoreResults.resultFor(BillingResponseCode.ITEM_ALREADY_OWNED, PurchaseState.PURCHASED));
        assertEquals("failed", ProtStoreResults.resultFor(BillingResponseCode.BILLING_UNAVAILABLE, PurchaseState.PENDING));
    }

    // ---- purchase() answers ----

    @Test
    public void purchasedShapeCarriesTokenProductAndOrder() {
        Map<String, Object> result = ProtStoreResults.purchaseResult(BillingResponseCode.OK,
                sale("prot_550", "tok-1", PurchaseState.PURCHASED, "GPA.1234"), "prot_550", null);
        Map<String, Object> expected = new LinkedHashMap<>();
        expected.put("result", "purchased");
        expected.put("purchase", playPurchase("prot_550", "tok-1", "GPA.1234"));
        assertEquals(expected, result);
        @SuppressWarnings("unchecked")
        Map<String, Object> purchase = (Map<String, Object>) result.get("purchase");
        assertFalse("quantity is not in the payload (R41)", purchase.containsKey("quantity"));
    }

    @Test
    public void noQuantityAndAMissingOrderIdIsOmitted() {
        Map<String, Object> purchase = ProtStoreResults.purchased(
                sale("prot_550", "tok-2", PurchaseState.PURCHASED, null), "prot_550");
        assertEquals(playPurchase("prot_550", "tok-2", null), purchase);
        assertFalse(purchase.containsKey("order_id"));
        assertFalse(purchase.containsKey("quantity"));
        Map<String, Object> empty = ProtStoreResults.purchased(
                sale("prot_550", "tok-2", PurchaseState.PURCHASED, ""), "prot_550");
        assertFalse(empty.containsKey("order_id"));
    }

    @Test
    public void pendingSaleIsPendingNotPurchased() {
        Map<String, Object> result = ProtStoreResults.purchaseResult(BillingResponseCode.OK,
                sale("prot_550", "tok-3", PurchaseState.PENDING, null), "prot_550", null);
        assertEquals(Collections.singletonMap("result", "pending"), result);
        assertFalse(result.containsKey("purchase"));
    }

    @Test
    public void cancelledAndFailedShapes() {
        assertEquals(Collections.singletonMap("result", "cancelled"),
                ProtStoreResults.purchaseResult(BillingResponseCode.USER_CANCELED, null, "prot_550", "x"));

        Map<String, Object> owned = ProtStoreResults.purchaseResult(
                BillingResponseCode.ITEM_ALREADY_OWNED, null, "prot_550", "owned");
        assertEquals("failed", owned.get("result"));
        assertEquals("already_owned", owned.get("code"));
        assertEquals("owned", owned.get("message"));

        Map<String, Object> blocked = ProtStoreResults.purchaseResult(
                BillingResponseCode.BILLING_UNAVAILABLE, null, "prot_550", null);
        assertEquals("not_available", blocked.get("code"));
        assertFalse(blocked.containsKey("message"));
    }

    @Test
    public void okWithoutAUsablePurchaseIsAStoreError() {
        // OK but no sale, an unknown state, or no token: never "purchased"
        assertEquals("store_error", ProtStoreResults.purchaseResult(
                BillingResponseCode.OK, null, "prot_550", null).get("code"));
        assertEquals("store_error", ProtStoreResults.purchaseResult(BillingResponseCode.OK,
                sale("prot_550", "tok", PurchaseState.UNSPECIFIED_STATE, null), "prot_550", null)
                .get("code"));
        assertEquals("store_error", ProtStoreResults.purchaseResult(BillingResponseCode.OK,
                sale("prot_550", "", PurchaseState.PURCHASED, null), "prot_550", null)
                .get("code"));
        assertEquals("store_error", ProtStoreResults.purchaseResult(BillingResponseCode.OK,
                sale("prot_550", null, PurchaseState.PURCHASED, null), "prot_550", null)
                .get("code"));
    }

    @Test
    public void accountTokenIsBase64UrlUpTo64() {
        assertTrue(ProtStoreResults.isAccountToken(TOKEN_43));
        assertTrue(ProtStoreResults.isAccountToken("a"));
        assertTrue(ProtStoreResults.isAccountToken(repeat('x', 64)));
        assertFalse(ProtStoreResults.isAccountToken(repeat('x', 65)));
        assertFalse(ProtStoreResults.isAccountToken(null));
        assertFalse(ProtStoreResults.isAccountToken(""));
        assertFalse(ProtStoreResults.isAccountToken("abc+def"));
        assertFalse(ProtStoreResults.isAccountToken("abc/def"));
        assertFalse(ProtStoreResults.isAccountToken("abc="));
        assertFalse(ProtStoreResults.isAccountToken("abc def"));
        assertFalse(ProtStoreResults.isAccountToken("someone@example.com"));
    }

    @Test
    public void productIdBounds() {
        assertTrue(ProtStoreResults.isProductId("prot_550"));
        assertTrue(ProtStoreResults.isProductId(repeat('p', 64)));
        assertFalse(ProtStoreResults.isProductId(repeat('p', 65)));
        assertFalse(ProtStoreResults.isProductId(""));
        assertFalse(ProtStoreResults.isProductId(null));
    }

    // ---- pendingTransactions() ----

    @Test
    public void pendingTransactionsListsPurchasedOnly() {
        List<ProtStoreResults.Sale> sales = Arrays.asList(
                sale("prot_550", "tok-a", PurchaseState.PURCHASED, "GPA.1"),
                sale("prot_1200", "tok-b", PurchaseState.PENDING, null),
                sale("prot_1200", "tok-c", PurchaseState.UNSPECIFIED_STATE, null),
                sale("prot_2500", "", PurchaseState.PURCHASED, null),
                new ProtStoreResults.Sale(Collections.<String>emptyList(), "tok-d",
                        PurchaseState.PURCHASED, null),
                null,
                sale("prot_2500", "tok-e", PurchaseState.PURCHASED, null));
        List<Map<String, Object>> expected = Arrays.asList(
                playPurchase("prot_550", "tok-a", "GPA.1"),
                playPurchase("prot_2500", "tok-e", null));
        assertEquals(expected, ProtStoreResults.pendingList(sales));
        assertTrue(ProtStoreResults.pendingList(null).isEmpty());
    }

    // ---- onPurchasesUpdated (contracts 20.3 + 35) ----

    @Test
    public void updateResolvesThePendingCallBeforeNotifying() {
        Recorder out = new Recorder();
        boolean settled = ProtStoreResults.deliverUpdate(BillingResponseCode.OK,
                Collections.singletonList(sale("prot_550", "tok-1", PurchaseState.PURCHASED, "GPA.9")),
                "prot_550", null, out);
        assertTrue(settled);
        assertEquals(Arrays.asList("resolve:purchased", "notify:tok-1"), out.calls);
        assertEquals(playPurchase("prot_550", "tok-1", "GPA.9"), out.resolved.get(0).get("purchase"));
        assertEquals(playPurchase("prot_550", "tok-1", "GPA.9"), out.notified.get(0));
    }

    @Test
    public void resolveComesFirstEvenWhenOtherSalesAreListedBeforeTheMatch() {
        Recorder out = new Recorder();
        ProtStoreResults.deliverUpdate(BillingResponseCode.OK, Arrays.asList(
                sale("prot_1200", "tok-other", PurchaseState.PURCHASED, null),
                sale("prot_550", "tok-mine", PurchaseState.PURCHASED, null)),
                "prot_550", null, out);
        assertEquals(Arrays.asList("resolve:purchased", "notify:tok-other", "notify:tok-mine"),
                out.calls);
        @SuppressWarnings("unchecked")
        Map<String, Object> mine = (Map<String, Object>) out.resolved.get(0).get("purchase");
        assertEquals("tok-mine", mine.get("purchase_token"));
    }

    @Test
    public void pendingIsNeverNotified() {
        Recorder out = new Recorder();
        boolean settled = ProtStoreResults.deliverUpdate(BillingResponseCode.OK,
                Collections.singletonList(sale("prot_550", "tok-p", PurchaseState.PENDING, null)),
                "prot_550", null, out);
        assertTrue(settled);
        assertEquals(Collections.singletonList("resolve:pending"), out.calls);

        Recorder background = new Recorder();
        assertFalse(ProtStoreResults.deliverUpdate(BillingResponseCode.OK,
                Collections.singletonList(sale("prot_550", "tok-p", PurchaseState.PENDING, null)),
                null, null, background));
        assertTrue(background.calls.isEmpty());
    }

    @Test
    public void cancelledFlowResolvesAndNotifiesNothing() {
        Recorder out = new Recorder();
        assertTrue(ProtStoreResults.deliverUpdate(BillingResponseCode.USER_CANCELED, null,
                "prot_550", null, out));
        assertEquals(Collections.singletonList("resolve:cancelled"), out.calls);
    }

    @Test
    public void failedCodeNeverNotifiesEvenWithPurchases() {
        Recorder out = new Recorder();
        assertTrue(ProtStoreResults.deliverUpdate(BillingResponseCode.ITEM_ALREADY_OWNED,
                Collections.singletonList(sale("prot_550", "tok-o", PurchaseState.PURCHASED, null)),
                "prot_550", "owned", out));
        assertEquals(Collections.singletonList("resolve:failed"), out.calls);
        assertEquals("already_owned", out.resolved.get(0).get("code"));
    }

    @Test
    public void unrelatedSaleLeavesTheCallOpenAndIsNotified() {
        Recorder out = new Recorder();
        boolean settled = ProtStoreResults.deliverUpdate(BillingResponseCode.OK,
                Collections.singletonList(sale("prot_1200", "tok-late", PurchaseState.PURCHASED, null)),
                "prot_550", null, out);
        assertFalse(settled);
        assertEquals(Collections.singletonList("notify:tok-late"), out.calls);
    }

    @Test
    public void okWithNoSaleSettlesAsStoreError() {
        Recorder out = new Recorder();
        assertTrue(ProtStoreResults.deliverUpdate(BillingResponseCode.OK, null, "prot_550", null, out));
        assertEquals(Collections.singletonList("resolve:failed"), out.calls);
        assertEquals("store_error", out.resolved.get(0).get("code"));
    }

    @Test
    public void noOpenCallOnlyNotifiesPurchased() {
        Recorder out = new Recorder();
        assertFalse(ProtStoreResults.deliverUpdate(BillingResponseCode.OK, Arrays.asList(
                sale("prot_550", "tok-x", PurchaseState.PURCHASED, null),
                sale("prot_550", "tok-y", PurchaseState.PENDING, null),
                sale("prot_550", "", PurchaseState.PURCHASED, null)),
                null, null, out));
        assertEquals(Collections.singletonList("notify:tok-x"), out.calls);

        Recorder failedNoCall = new Recorder();
        assertFalse(ProtStoreResults.deliverUpdate(BillingResponseCode.ERROR, null, null, null,
                failedNoCall));
        assertTrue(failedNoCall.calls.isEmpty());
    }

    // ---- finish() and source scans of the plugin ----

    @Test
    public void finishNeverConsumes() throws IOException {
        assertEquals(Collections.singletonMap("finished", false), ProtStoreResults.finishResult());

        String code = pluginCode();
        for (String banned : new String[] {
                "consumeAsync", "ConsumeParams", "acknowledgePurchase",
                "AcknowledgePurchaseParams", "consumePurchase"}) {
            assertFalse("ProtStorePlugin must never call " + banned + " (the server consumes)",
                    code.contains(banned));
        }
        String finish = methodBody(code, "public void finish(PluginCall call)");
        assertEquals("call.resolve(js(ProtStoreResults.finishResult()));",
                finish.replaceAll("\\s+", ""));
    }

    @Test
    public void pluginNotifiesOnlyThroughDeliverUpdate() throws IOException {
        String code = pluginCode();
        assertEquals("exactly one notifyListeners( call site", 1, count(code, "notifyListeners("));
        assertEquals(1, count(code, "ProtStoreResults.deliverUpdate("));
        String update = methodBody(code, "public void onPurchasesUpdated(");
        assertTrue(update.contains("ProtStoreResults.deliverUpdate("));
        String notify = methodBody(update, "public void transactionUpdated(");
        assertTrue("the only notifyListeners( is the Delivery's transactionUpdated",
                notify.contains("notifyListeners("));
    }

    @Test
    public void pluginLogsNoPurchaseData() throws IOException {
        String code = pluginCode();
        for (String banned : new String[] {
                "getOriginalJson", "getSignature", "purchase.toString", "Log.d(", "Log.i(",
                "Log.v(", "Log.e("}) {
            assertFalse("ProtStorePlugin must not log or expose " + banned, code.contains(banned));
        }
        int from = 0;
        while ((from = code.indexOf("Log.w(", from)) >= 0) {
            int end = code.indexOf(';', from);
            String line = code.substring(from, end);
            assertFalse("a log line names a token: " + line, line.toLowerCase().contains("token"));
            from = end;
        }
    }

    @Test
    public void pendingResultShape() {
        assertEquals(Collections.singletonMap("result", "pending"), ProtStoreResults.pendingResult());
    }

    /**
     * R40: a launched sheet still open 10 s after the activity resumes is
     * answered `pending` (never failed, so the flow neither verifies nor
     * cancels the intent); a late onPurchasesUpdated then reaches the worker
     * through transactionUpdated.
     */
    @Test
    public void staleSheetSettlesAsPendingAfterResume() throws IOException {
        String code = pluginCode();
        assertTrue(code.contains("STALE_SHEET_MS = 10_000L"));
        String resume = methodBody(code, "void handleOnResume(");
        assertTrue(resume.contains("purchaseLaunched"));
        assertTrue(resume.contains("postDelayed(staleSheet, STALE_SHEET_MS)"));
        String stale = methodBody(code, "private final Runnable staleSheet =");
        assertTrue("the stale sheet resolves the open call as pending",
                stale.contains("settlePurchase(ProtStoreResults.pendingResult())"));
        assertFalse(stale.contains("failed"));
        assertFalse(stale.contains("cancel"));
        assertEquals(1, count(code, "settlePurchase(ProtStoreResults.pendingResult())"));
        assertTrue(methodBody(code, "private void settlePurchase(")
                .contains("removeCallbacks(staleSheet)"));
        assertTrue(methodBody(code, "void handleOnDestroy(")
                .contains("removeCallbacks(staleSheet)"));
    }

    // ---- helpers ----

    private static String repeat(char c, int n) {
        char[] chars = new char[n];
        Arrays.fill(chars, c);
        return new String(chars);
    }

    private static int count(String haystack, String needle) {
        int n = 0;
        int from = 0;
        while ((from = haystack.indexOf(needle, from)) >= 0) {
            n++;
            from += needle.length();
        }
        return n;
    }

    /**
     * ProtStorePlugin.java with comments removed. Gradle runs unit tests from
     * the module directory (android/app); the other candidates cover a run
     * from android/ or the repo. A missing file fails, never passes.
     */
    private static String pluginCode() throws IOException {
        String rel = "src/play/java/com/acutest/app/ProtStorePlugin.java";
        String[] candidates = {
                rel,
                "app/" + rel,
                "android/app/" + rel,
                "packages/client/android/app/" + rel};
        for (String candidate : candidates) {
            File file = new File(candidate);
            if (file.isFile()) {
                String source = new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
                String code = stripComments(source);
                assertTrue("ProtStorePlugin.java looks empty", code.contains("class ProtStorePlugin"));
                return code;
            }
        }
        fail("ProtStorePlugin.java not found from " + new File(".").getAbsolutePath());
        return "";
    }

    /** Removes // and block comments, leaving string and char literals intact */
    private static String stripComments(String source) {
        StringBuilder out = new StringBuilder(source.length());
        int i = 0;
        int n = source.length();
        while (i < n) {
            char c = source.charAt(i);
            char next = i + 1 < n ? source.charAt(i + 1) : '\0';
            if (c == '/' && next == '/') {
                while (i < n && source.charAt(i) != '\n') i++;
            } else if (c == '/' && next == '*') {
                int end = source.indexOf("*/", i + 2);
                i = end < 0 ? n : end + 2;
                out.append(' ');
            } else if (c == '"' || c == '\'') {
                char quote = c;
                out.append(c);
                i++;
                while (i < n) {
                    char d = source.charAt(i);
                    out.append(d);
                    i++;
                    if (d == '\\' && i < n) {
                        out.append(source.charAt(i));
                        i++;
                    } else if (d == quote) {
                        break;
                    }
                }
            } else {
                out.append(c);
                i++;
            }
        }
        return out.toString();
    }

    /** The text between the braces of the first method whose header contains `header` */
    private static String methodBody(String code, String header) {
        int at = code.indexOf(header);
        assertTrue("method not found: " + header, at >= 0);
        int open = code.indexOf('{', at);
        assertTrue("no body for: " + header, open >= 0);
        int depth = 0;
        for (int i = open; i < code.length(); i++) {
            char c = code.charAt(i);
            if (c == '{') depth++;
            if (c == '}') {
                depth--;
                if (depth == 0) return code.substring(open + 1, i);
            }
        }
        fail("unbalanced body for: " + header);
        return "";
    }
}
