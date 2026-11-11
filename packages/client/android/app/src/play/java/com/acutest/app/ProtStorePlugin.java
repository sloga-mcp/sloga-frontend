package com.acutest.app;

import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClient.BillingResponseCode;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingConfig;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.GetBillingConfigParams;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.PurchasesUpdatedListener;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryPurchasesParams;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Prot packs bought through Google Play Billing (S6). Registered only in the
 * `play` flavor (FlavorPlugins in this source set); the JS side is
 * components/client/protStorePlugin.ts, which sees no plugin anywhere else.
 *
 * The plugin never decides whether a purchase counts and never consumes or
 * acknowledges one: it hands the purchase token to the web layer, the server
 * verifies it with Google, credits it and consumes it. `finish()` therefore
 * always answers `{ finished: false }`. PENDING purchases (cash and other
 * delayed payment methods) answer `pending` and are never handed over; Play
 * reports them again once they are paid.
 *
 * Every purchase is bound to the server's intent token through
 * setObfuscatedAccountId, so the server can tell whose purchase it is.
 *
 * Threading: Capacitor runs plugin methods on its own handler thread, and
 * Play Billing may call back on any thread. Every method and every billing
 * callback is posted to the main looper, and all state below is touched only
 * there, so it needs no locks and calls are settled in the order they happen.
 *
 * Purchase tokens are never logged; the log lines carry response codes only.
 */
@CapacitorPlugin(name = "ProtStore")
public class ProtStorePlugin extends Plugin implements PurchasesUpdatedListener {
    private static final String TAG = "ProtStore";
    private static final String EVENT_TRANSACTION_UPDATED = "transactionUpdated";

    /** Reconnect after a lost billing service: 1 s, 2 s, 4 s … capped at 60 s, 6 tries */
    private static final long RECONNECT_FIRST_MS = 1_000L;
    private static final long RECONNECT_MAX_MS = 60_000L;
    private static final int RECONNECT_MAX_TRIES = 6;

    /**
     * R40: how long a launched sheet may stay unanswered after the activity
     * resumes before purchase() answers `pending`
     */
    private static final long STALE_SHEET_MS = 10_000L;

    /** One unit of billing work, run once the client is connected. */
    private interface BillingOp {
        void run(BillingClient client);

        /** The connection failed; `code` is a BillingResponseCode. */
        void unavailable(int code, String message);
    }

    // Main looper only, from here down.
    private final Handler main = new Handler(Looper.getMainLooper());
    private final List<BillingOp> waiting = new ArrayList<>();
    private final Map<String, ProductDetails> details = new HashMap<>();
    private BillingClient billing;
    private boolean connecting;
    private boolean destroyed;
    private int reconnectTries;

    /** The open purchase() call, its product, and whether its flow launched */
    private PluginCall purchaseCall;
    private String purchaseProduct;
    private boolean purchaseLaunched;

    private final Runnable reconnect = () -> {
        if (destroyed || billing == null || billing.isReady() || connecting) return;
        connect();
    };

    /**
     * R40: the activity came back from Play's sheet but Play never answered
     * (for example the billing service dropped meanwhile). The open call is
     * answered `pending`, never failed: the flow then neither verifies nor
     * cancels the intent, so a payment that did go through stays bound. A
     * late onPurchasesUpdated finds no open call and reaches the worker
     * through `transactionUpdated`; otherwise the next pendingTransactions()
     * recovers it.
     */
    private final Runnable staleSheet = () -> {
        if (destroyed || purchaseCall == null || !purchaseLaunched) return;
        settlePurchase(ProtStoreResults.pendingResult());
    };

    @Override
    public void load() {
        billing = BillingClient.newBuilder(getContext())
                .setListener(this)
                .enablePendingPurchases(
                        PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
                .build();
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        main.post(() -> withBilling(new BillingOp() {
            @Override
            public void run(BillingClient client) {
                JSObject result = new JSObject();
                result.put("available", true);
                call.resolve(result);
            }

            @Override
            public void unavailable(int code, String message) {
                JSObject result = new JSObject();
                result.put("available", false);
                call.resolve(result);
            }
        }));
    }

    @PluginMethod
    public void products(PluginCall call) {
        JSArray raw = call.getArray("ids");
        Set<String> wanted = new LinkedHashSet<>();
        if (raw != null) {
            for (int i = 0; i < raw.length(); i++) {
                String id = raw.optString(i, null);
                if (ProtStoreResults.isProductId(id)) wanted.add(id);
            }
        }
        final List<String> ids = new ArrayList<>(wanted);
        main.post(() -> {
            if (ids.isEmpty()) {
                call.resolve(productsResult(Collections.<ProductDetails>emptyList()));
                return;
            }
            withBilling(new BillingOp() {
                @Override
                public void run(BillingClient client) {
                    queryDetails(client, ids, (code, message, list) -> {
                        if (code == BillingResponseCode.OK) {
                            call.resolve(productsResult(list));
                        } else {
                            call.reject("Play products failed: " + code,
                                    ProtStoreResults.failCode(code));
                        }
                    });
                }

                @Override
                public void unavailable(int code, String message) {
                    call.reject("Play billing unavailable: " + code,
                            ProtStoreResults.failCode(code));
                }
            });
        });
    }

    @PluginMethod
    public void purchase(PluginCall call) {
        final String productId = call.getString("product_id");
        final String token = call.getString("account_token");
        main.post(() -> {
            if (!ProtStoreResults.isAccountToken(token)) {
                // Never opens the sheet without a usable binding token
                call.resolve(js(ProtStoreResults.failed("invalid_token", null)));
                return;
            }
            if (!ProtStoreResults.isProductId(productId)) {
                call.resolve(js(ProtStoreResults.failed("product_not_found", null)));
                return;
            }
            if (purchaseCall != null) {
                call.resolve(js(ProtStoreResults.failed("store_error", "purchase_open")));
                return;
            }
            purchaseCall = call;
            purchaseProduct = productId;
            purchaseLaunched = false;
            withBilling(new BillingOp() {
                @Override
                public void run(BillingClient client) {
                    ProductDetails known = details.get(productId);
                    if (known != null) {
                        launch(client, call, known, token);
                        return;
                    }
                    queryDetails(client, Collections.singletonList(productId),
                            (code, message, list) -> {
                                if (purchaseCall != call) return;
                                ProductDetails found = details.get(productId);
                                if (code != BillingResponseCode.OK) {
                                    settlePurchase(ProtStoreResults.purchaseResult(code, null,
                                            productId, message));
                                } else if (found == null) {
                                    settlePurchase(ProtStoreResults.failed("product_not_found",
                                            null));
                                } else {
                                    launch(client, call, found, token);
                                }
                            });
                }

                @Override
                public void unavailable(int code, String message) {
                    if (purchaseCall != call) return;
                    settlePurchase(ProtStoreResults.purchaseResult(code, null, productId,
                            message));
                }
            });
        });
    }

    @PluginMethod
    public void pendingTransactions(PluginCall call) {
        main.post(() -> withBilling(new BillingOp() {
            @Override
            public void run(BillingClient client) {
                QueryPurchasesParams params = QueryPurchasesParams.newBuilder()
                        .setProductType(BillingClient.ProductType.INAPP)
                        .build();
                client.queryPurchasesAsync(params, (result, purchases) -> {
                    final int code = result.getResponseCode();
                    final List<ProtStoreResults.Sale> sales = sales(purchases);
                    main.post(() -> {
                        if (code != BillingResponseCode.OK) {
                            call.reject("Play purchases failed: " + code,
                                    ProtStoreResults.failCode(code));
                            return;
                        }
                        JSArray list = new JSArray();
                        for (Map<String, Object> purchase : ProtStoreResults.pendingList(sales)) {
                            list.put(js(purchase));
                        }
                        JSObject answer = new JSObject();
                        answer.put("purchases", list);
                        call.resolve(answer);
                    });
                });
            }

            @Override
            public void unavailable(int code, String message) {
                call.reject("Play billing unavailable: " + code,
                        ProtStoreResults.failCode(code));
            }
        }));
    }

    /**
     * Play purchases are consumed by the server once it has credited them,
     * never here. Answers `{ finished: false }` for any id, touching nothing.
     */
    @PluginMethod
    public void finish(PluginCall call) {
        call.resolve(js(ProtStoreResults.finishResult()));
    }

    /** The Play account's billing country (ISO 3166-1 alpha-2), when Play gives one */
    @PluginMethod
    public void storefront(PluginCall call) {
        main.post(() -> withBilling(new BillingOp() {
            @Override
            public void run(BillingClient client) {
                client.getBillingConfigAsync(GetBillingConfigParams.newBuilder().build(),
                        (result, config) -> {
                            final int code = result.getResponseCode();
                            final String country = code == BillingResponseCode.OK
                                    ? countryOf(config)
                                    : null;
                            main.post(() -> {
                                JSObject answer = new JSObject();
                                if (country != null && !country.isEmpty()) {
                                    answer.put("storefront", country);
                                }
                                call.resolve(answer);
                            });
                        });
            }

            @Override
            public void unavailable(int code, String message) {
                call.resolve(new JSObject());
            }
        }));
    }

    /**
     * Every purchase update: the answer to an open billing flow and purchases
     * completed outside it (a pending payment settling). Settled through
     * {@link ProtStoreResults#deliverUpdate}, which resolves the open
     * purchase() call before it notifies `transactionUpdated` listeners.
     *
     * Play may also report a launchBillingFlow failure here after
     * launchBillingFlow returned it; the call is settled by whichever comes
     * first and the other finds no open call.
     */
    @Override
    public void onPurchasesUpdated(BillingResult result, List<Purchase> purchases) {
        final int code = result.getResponseCode();
        final String message = result.getDebugMessage();
        final List<ProtStoreResults.Sale> sales = sales(purchases);
        Runnable deliver = () -> {
            if (destroyed) return;
            final PluginCall call = purchaseCall;
            String awaiting = call != null && purchaseLaunched ? purchaseProduct : null;
            ProtStoreResults.deliverUpdate(code, sales, awaiting, message,
                    new ProtStoreResults.Delivery() {
                        @Override
                        public void resolvePurchase(Map<String, Object> answer) {
                            if (purchaseCall == call) settlePurchase(answer);
                        }

                        @Override
                        public void transactionUpdated(Map<String, Object> purchase) {
                            notifyListeners(EVENT_TRANSACTION_UPDATED, js(purchase));
                        }
                    });
        };
        // Play calls back on the main thread today: run inline then, so the
        // answer is not queued behind later work
        if (Looper.myLooper() == Looper.getMainLooper()) {
            deliver.run();
        } else {
            main.post(deliver);
        }
    }

    /** R40: arms the stale-sheet answer when we come back with a sheet still open */
    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        main.removeCallbacks(staleSheet);
        if (purchaseCall != null && purchaseLaunched) {
            main.postDelayed(staleSheet, STALE_SHEET_MS);
        }
    }

    @Override
    protected void handleOnDestroy() {
        destroyed = true;
        main.removeCallbacks(reconnect);
        main.removeCallbacks(staleSheet);
        // A purchase() call whose sheet launched is dropped, not settled: its
        // WebView goes with this activity, and a terminal answer would let
        // the flow cancel an intent whose payment may already have gone
        // through. The next launch's pendingTransactions() recovers that
        // purchase. A call still waiting for the connection opened no sheet
        // and fails below like any other waiting call.
        if (purchaseLaunched) {
            purchaseCall = null;
        }
        List<BillingOp> stranded = new ArrayList<>(waiting);
        waiting.clear();
        for (BillingOp op : stranded) {
            op.unavailable(BillingResponseCode.SERVICE_DISCONNECTED, "Activity destroyed");
        }
        purchaseCall = null;
        purchaseProduct = null;
        purchaseLaunched = false;
        if (billing != null) {
            billing.endConnection();
            billing = null;
        }
        super.handleOnDestroy();
    }

    // ---- main looper helpers ----

    /** Runs `op` on a connected client, connecting (once) when needed. */
    private void withBilling(BillingOp op) {
        if (destroyed || billing == null) {
            op.unavailable(BillingResponseCode.SERVICE_DISCONNECTED, "Billing closed");
            return;
        }
        if (billing.isReady()) {
            op.run(billing);
            return;
        }
        waiting.add(op);
        if (!connecting) connect();
    }

    private void connect() {
        connecting = true;
        main.removeCallbacks(reconnect);
        final BillingClient client = billing;
        client.startConnection(new BillingClientStateListener() {
            @Override
            public void onBillingSetupFinished(BillingResult result) {
                final int code = result.getResponseCode();
                final String message = result.getDebugMessage();
                main.post(() -> setupFinished(client, code, message));
            }

            @Override
            public void onBillingServiceDisconnected() {
                main.post(() -> disconnected(client));
            }
        });
    }

    private void setupFinished(BillingClient client, int code, String message) {
        if (destroyed || client != billing) return;
        connecting = false;
        if (code == BillingResponseCode.OK) {
            reconnectTries = 0;
        } else {
            Log.w(TAG, "Play billing setup failed: " + code);
        }
        List<BillingOp> ready = new ArrayList<>(waiting);
        waiting.clear();
        for (BillingOp op : ready) {
            if (code == BillingResponseCode.OK && client.isReady()) {
                op.run(client);
            } else {
                op.unavailable(code, message);
            }
        }
    }

    /**
     * The billing service went away. Work waiting for a connection fails now;
     * the client reconnects with backoff so purchase updates keep arriving,
     * and any later call reconnects on its own.
     */
    private void disconnected(BillingClient client) {
        if (destroyed || client != billing) return;
        connecting = false;
        List<BillingOp> stranded = new ArrayList<>(waiting);
        waiting.clear();
        for (BillingOp op : stranded) {
            op.unavailable(BillingResponseCode.SERVICE_DISCONNECTED, "Billing disconnected");
        }
        if (reconnectTries < RECONNECT_MAX_TRIES) {
            long delay = Math.min(RECONNECT_FIRST_MS << reconnectTries, RECONNECT_MAX_MS);
            reconnectTries++;
            main.postDelayed(reconnect, delay);
        }
    }

    private interface DetailsAnswer {
        void answer(int code, String message, List<ProductDetails> list);
    }

    /** queryProductDetailsAsync(INAPP); caches what Play returns, answers on main */
    private void queryDetails(BillingClient client, List<String> ids, DetailsAnswer then) {
        List<QueryProductDetailsParams.Product> products = new ArrayList<>();
        for (String id : ids) {
            products.add(QueryProductDetailsParams.Product.newBuilder()
                    .setProductId(id)
                    .setProductType(BillingClient.ProductType.INAPP)
                    .build());
        }
        QueryProductDetailsParams params = QueryProductDetailsParams.newBuilder()
                .setProductList(products)
                .build();
        client.queryProductDetailsAsync(params, (result, queried) -> {
            final int code = result.getResponseCode();
            final String message = result.getDebugMessage();
            final List<ProductDetails> list = new ArrayList<>();
            if (code == BillingResponseCode.OK && queried != null
                    && queried.getProductDetailsList() != null) {
                list.addAll(queried.getProductDetailsList());
            }
            main.post(() -> {
                for (ProductDetails product : list) {
                    if (product != null) details.put(product.getProductId(), product);
                }
                then.answer(code, message, list);
            });
        });
    }

    /** Opens Play's purchase sheet for the open purchase() call */
    private void launch(BillingClient client, PluginCall call, ProductDetails product,
            String token) {
        if (purchaseCall != call) return;
        Activity activity = getActivity();
        if (activity == null || activity.isFinishing()) {
            settlePurchase(ProtStoreResults.failed("not_available", null));
            return;
        }
        BillingFlowParams params = BillingFlowParams.newBuilder()
                .setProductDetailsParamsList(Collections.singletonList(
                        BillingFlowParams.ProductDetailsParams.newBuilder()
                                .setProductDetails(product)
                                .build()))
                .setObfuscatedAccountId(token)
                .build();
        // Before launching: Play may answer through onPurchasesUpdated, which
        // only settles a call whose flow launched
        purchaseLaunched = true;
        BillingResult result = client.launchBillingFlow(activity, params);
        final int code = result.getResponseCode();
        if (code != BillingResponseCode.OK && purchaseCall == call) {
            settlePurchase(ProtStoreResults.purchaseResult(code, null, purchaseProduct,
                    result.getDebugMessage()));
        }
    }

    /** Resolves the open purchase() call (it never rejects: see protStoreFlow.ts) */
    private void settlePurchase(Map<String, Object> answer) {
        main.removeCallbacks(staleSheet);
        PluginCall call = purchaseCall;
        purchaseCall = null;
        purchaseProduct = null;
        purchaseLaunched = false;
        if (call != null) call.resolve(js(answer));
    }

    // ---- pure-ish conversions (any thread) ----

    private static List<ProtStoreResults.Sale> sales(List<Purchase> purchases) {
        List<ProtStoreResults.Sale> out = new ArrayList<>();
        if (purchases == null) return out;
        for (Purchase purchase : purchases) {
            if (purchase == null) continue;
            out.add(new ProtStoreResults.Sale(
                    purchase.getProducts(),
                    purchase.getPurchaseToken(),
                    purchase.getPurchaseState(),
                    purchase.getOrderId()));
        }
        return out;
    }

    private static String countryOf(BillingConfig config) {
        return config == null ? null : config.getCountryCode();
    }

    private static JSObject productsResult(List<ProductDetails> list) {
        JSArray products = new JSArray();
        for (ProductDetails product : list) {
            if (product == null) continue;
            ProductDetails.OneTimePurchaseOfferDetails offer =
                    product.getOneTimePurchaseOfferDetails();
            if (offer == null) continue;
            JSObject entry = new JSObject();
            entry.put("id", product.getProductId());
            entry.put("displayPrice", offer.getFormattedPrice());
            products.put(entry);
        }
        JSObject answer = new JSObject();
        answer.put("products", products);
        return answer;
    }

    @SuppressWarnings("unchecked")
    private static JSObject js(Map<String, Object> map) {
        JSObject out = new JSObject();
        if (map == null) return out;
        for (Map.Entry<String, Object> entry : map.entrySet()) {
            Object value = entry.getValue();
            if (value instanceof Map) {
                out.put(entry.getKey(), js((Map<String, Object>) value));
            } else {
                out.put(entry.getKey(), value);
            }
        }
        return out;
    }
}
