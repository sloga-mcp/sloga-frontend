package com.acutest.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;
import org.unifiedpush.android.connector.UnifiedPush;

import java.util.List;
import java.util.regex.Pattern;

/**
 * JS bridge for UnifiedPush, the background push of the foss flavor: pick a
 * distributor app, register this device's "default" instance with it and
 * report what is stored. The endpoint arrives later in SlogaPushService, which
 * hands it back through deliverEndpoint to settle the waiting register call.
 *
 * State lives in the "sloga_push" preferences beside PushTokenPlugin's
 * credentials. up_endpoint, up_p256dh and up_auth describe the current
 * registration, up_vapid is the key it was made with, and up_vapid_requested
 * is set while a register call waits on the distributor. Every clear drops
 * all five together.
 */
@CapacitorPlugin(name = "UnifiedPush")
public class UnifiedPushPlugin extends Plugin {
    private static final String TAG = "SlogaPush";
    private static final String INSTANCE = "default";

    private static final String KEY_ENDPOINT = "up_endpoint";
    private static final String KEY_P256DH = "up_p256dh";
    private static final String KEY_AUTH = "up_auth";
    private static final String KEY_VAPID = "up_vapid";
    private static final String KEY_VAPID_REQUESTED = "up_vapid_requested";

    private static final String NO_DISTRIBUTOR = "NO_DISTRIBUTOR";
    private static final String VAPID_INVALID = "VAPID_INVALID";
    private static final String SUPERSEDED = "SUPERSEDED";
    private static final String REGISTRATION_FAILED = "REGISTRATION_FAILED";

    /** An uncompressed P-256 public key, base64url without padding. */
    private static final Pattern VAPID = Pattern.compile("^[A-Za-z0-9_-]{87}$");

    private static final Object LOCK = new Object();

    /**
     * Settles calls from outside the plugin thread. The WebView's reply proxy
     * is annotated @UiThread, and the distributor's answer reaches us on
     * whatever thread the push service runs, so post there instead.
     */
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    /** The register call waiting for the distributor's answer. Guarded by LOCK. */
    private static PluginCall pendingRegister;

    /** The distributor picker while it is on screen. UI thread only. */
    private AlertDialog picker;

    @PluginMethod
    public void status(PluginCall call) {
        Context ctx = getContext();
        SharedPreferences prefs = prefs(ctx);
        JSArray distributors = new JSArray();
        for (String distributor : UnifiedPush.getDistributors(ctx)) {
            distributors.put(distributor);
        }
        JSObject result = new JSObject();
        result.put("distributors", distributors);
        result.put("acked", orNull(UnifiedPush.getAckDistributor(ctx)));
        // Reported whether or not a distributor is acked: once the distributor
        // is uninstalled, the web layer still needs the stored endpoint to
        // unsubscribe it from the server.
        result.put("endpoint", orNull(prefs.getString(KEY_ENDPOINT, null)));
        result.put("p256dh", orNull(prefs.getString(KEY_P256DH, null)));
        result.put("auth", orNull(prefs.getString(KEY_AUTH, null)));
        result.put("vapid", orNull(prefs.getString(KEY_VAPID, null)));
        call.resolve(result);
    }

    @PluginMethod
    public void pickDistributor(PluginCall call) {
        Context ctx = getContext();
        String acked = UnifiedPush.getAckDistributor(ctx);
        if (acked != null) {
            resolveDistributor(call, acked);
            return;
        }
        List<String> distributors = UnifiedPush.getDistributors(ctx);
        if (distributors.isEmpty()) {
            call.reject("No UnifiedPush distributor is installed", NO_DISTRIBUTOR);
            return;
        }
        if (distributors.size() == 1) {
            UnifiedPush.saveDistributor(ctx, distributors.get(0));
            resolveDistributor(call, distributors.get(0));
            return;
        }
        showPicker(call, distributors);
    }

    private void showPicker(PluginCall call, List<String> distributors) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("No activity to show the distributor picker on");
            return;
        }
        activity.runOnUiThread(() -> {
            if (activity.isFinishing() || activity.isDestroyed()) {
                call.reject("No activity to show the distributor picker on");
                return;
            }
            PackageManager pm = activity.getPackageManager();
            CharSequence[] labels = new CharSequence[distributors.size()];
            for (int i = 0; i < labels.length; i++) {
                labels[i] = appLabel(pm, distributors.get(i));
            }
            // Settled exactly once: by a pick, or by any dismissal without
            // one (the cancel button, back, a tap outside, activity teardown).
            boolean[] picked = { false };
            picker = new AlertDialog.Builder(activity)
                    .setTitle(R.string.sloga_unifiedpush_picker_title)
                    .setSingleChoiceItems(labels, -1, (dialog, which) -> {
                        picked[0] = true;
                        String distributor = distributors.get(which);
                        UnifiedPush.saveDistributor(activity, distributor);
                        dialog.dismiss();
                        resolveDistributor(call, distributor);
                    })
                    .setNegativeButton(android.R.string.cancel, null)
                    .setOnDismissListener(dialog -> {
                        picker = null;
                        if (!picked[0]) {
                            call.reject("No UnifiedPush distributor was chosen", NO_DISTRIBUTOR);
                        }
                    })
                    .show();
        });
    }

    /**
     * A dialog still up when the activity goes away would leak its window and
     * never call its dismiss listener, leaving pickDistributor unsettled.
     */
    @Override
    protected void handleOnDestroy() {
        if (picker != null) {
            picker.dismiss();
        }
    }

    @PluginMethod
    public void register(PluginCall call) {
        String vapid = call.getString("vapid");
        if (vapid == null || !VAPID.matcher(vapid).matches()) {
            call.reject("The VAPID key is not a base64url P-256 public key", VAPID_INVALID);
            return;
        }
        Context ctx = getContext();
        // The saved distributor, not the acked one: saveDistributor clears the
        // ack for a new pick, and it only comes back with the first endpoint.
        // This is the same lookup the connector makes before registering, and
        // it returns silently when that finds nothing, which would leave this
        // call waiting for an answer that never comes.
        if (UnifiedPush.getSavedDistributor(ctx) == null) {
            call.reject("No UnifiedPush distributor is selected", NO_DISTRIBUTOR);
            return;
        }

        PluginCall previous;
        synchronized (LOCK) {
            previous = pendingRegister;
            pendingRegister = call;
        }
        if (previous != null) {
            previous.reject("Replaced by a newer registration", SUPERSEDED);
        }

        // Written before the connector call so SlogaPushService can tell the
        // endpoint answers this request. commit rather than apply: the answer
        // may arrive in a new process if this one dies while waiting.
        prefs(ctx).edit().putString(KEY_VAPID_REQUESTED, vapid).commit();

        try {
            UnifiedPush.register(ctx, INSTANCE, null, vapid);
        } catch (Exception e) {
            // VapidNotValidException is checked, but register declares no
            // throws clause, so javac rejects catching it by type.
            prefs(ctx).edit().remove(KEY_VAPID_REQUESTED).apply();
            boolean ours;
            synchronized (LOCK) {
                ours = pendingRegister == call;
                if (ours) pendingRegister = null;
            }
            if (!ours) return;
            if (e instanceof UnifiedPush.VapidNotValidException) {
                call.reject("The distributor connector rejected the VAPID key", VAPID_INVALID);
            } else {
                call.reject(String.valueOf(e.getMessage()), REGISTRATION_FAILED, e);
            }
        }
    }

    @PluginMethod
    public void unregister(PluginCall call) {
        Context ctx = getContext();
        // A register the web layer already gave up on would otherwise be
        // settled by an endpoint for the registration being removed here.
        PluginCall pending = takePending();
        if (pending != null) {
            pending.reject("Unregistered while waiting for the distributor", SUPERSEDED);
        }
        try {
            UnifiedPush.unregister(ctx, INSTANCE);
        } catch (Exception e) {
            Log.w(TAG, "UnifiedPush unregister failed: " + e.getMessage());
        }
        clearUpKeys(ctx);
        call.resolve();
    }

    /** SlogaPushService: the distributor answered with a new endpoint. */
    static void deliverEndpoint(String endpoint, String p256dh, String auth) {
        PluginCall call = takePending();
        if (call == null) return;
        JSObject result = new JSObject();
        result.put("endpoint", orNull(endpoint));
        result.put("p256dh", orNull(p256dh));
        result.put("auth", orNull(auth));
        MAIN.post(() -> call.resolve(result));
    }

    /** SlogaPushService: the distributor refused or could not register us. */
    static void deliverRegistrationFailed(String reason) {
        PluginCall call = takePending();
        if (call == null) return;
        String message = reason != null ? reason : "UnifiedPush registration failed";
        MAIN.post(() -> call.reject(message, REGISTRATION_FAILED));
    }

    private static PluginCall takePending() {
        synchronized (LOCK) {
            PluginCall call = pendingRegister;
            pendingRegister = null;
            return call;
        }
    }

    private static void resolveDistributor(PluginCall call, String distributor) {
        JSObject result = new JSObject();
        result.put("distributor", distributor);
        call.resolve(result);
    }

    private static CharSequence appLabel(PackageManager pm, String packageName) {
        try {
            return pm.getApplicationLabel(pm.getApplicationInfo(packageName, 0));
        } catch (PackageManager.NameNotFoundException e) {
            return packageName;
        }
    }

    /** JSONObject drops a key put with null; the web layer expects null itself. */
    private static Object orNull(String value) {
        return value != null ? value : JSONObject.NULL;
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences("sloga_push", Context.MODE_PRIVATE);
    }

    private static void clearUpKeys(Context ctx) {
        prefs(ctx).edit()
                .remove(KEY_ENDPOINT)
                .remove(KEY_P256DH)
                .remove(KEY_AUTH)
                .remove(KEY_VAPID)
                .remove(KEY_VAPID_REQUESTED)
                .apply();
    }
}
