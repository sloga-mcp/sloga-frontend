package com.acutest.app;

import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The web layer's window onto the app lock. The lock itself lives in
 * AppLockState and works without this plugin. Nothing here decides
 * whether the app is locked, and there is no call that sets it unlocked.
 *
 * Every call into AppLockState runs on the main thread. A call that cannot
 * reach the state is rejected, never answered with a made-up value, so the
 * web layer can treat any failure as locked.
 */
@CapacitorPlugin(name = "AppLock")
public class AppLockPlugin extends Plugin {
    private static final String EVENT_LOCK_CHANGED = "lockChanged";

    private static final String CODE_LOCKED = "LOCKED";
    private static final String CODE_FAILED = "FAILED";

    /**
     * The plugin whose listener is set on the state right now. Main thread
     * only. A new activity can be created before the old one is destroyed,
     * and the old plugin must not clear the new plugin's listener.
     */
    private static AppLockPlugin listenerOwner;

    private final AppLockState.Listener listener = (locked, enabled) -> {
        JSObject data = new JSObject();
        data.put("locked", locked);
        data.put("enabled", enabled);
        notifyListeners(EVENT_LOCK_CHANGED, data);
    };

    /** Tells the state that the web view began loading a new page. */
    private final WebViewListener pageListener = new WebViewListener() {
        @Override
        public void onPageStarted(WebView webView) {
            onMain(() -> {
                try {
                    AppLockState.get(getContext()).onPageStarted();
                } catch (Exception e) {
                    // The state is unreachable. A kept lock stays kept.
                }
            });
        }
    };

    /** Whether pageListener is on the bridge. Main thread only. */
    private boolean pageListenerAdded;

    /** One call into the state, run on the main thread. */
    private interface StateCall {
        void run(AppLockState state, MainActivity activity);
    }

    @Override
    public void load() {
        onMain(() -> {
            try {
                AppLockState.get(getContext()).setListener(listener);
                listenerOwner = this;
            } catch (Exception e) {
                // No events then. getState still reports the real state.
            }
        });
    }

    /**
     * The page listener is added here and not in load(). load() runs inside
     * the Bridge constructor, and Bridge.Builder.create() swaps in its own
     * listener list afterwards, so a listener added in load() is lost.
     * This runs on every start, so it adds the listener once.
     */
    @Override
    protected void handleOnStart() {
        super.handleOnStart();
        if (pageListenerAdded) return;
        pageListenerAdded = true;
        bridge.addWebViewListener(pageListener);
    }

    @Override
    protected void handleOnDestroy() {
        onMain(() -> {
            try {
                if (pageListenerAdded) {
                    pageListenerAdded = false;
                    bridge.removeWebViewListener(pageListener);
                }
            } catch (Exception e) {
                // The bridge is gone, and its listener list with it.
            }
            try {
                if (listenerOwner == this) {
                    listenerOwner = null;
                    AppLockState.get(getContext()).setListener(null);
                }
            } catch (Exception e) {
                // The state is unreachable, so there is nothing to clear.
            }
        });
        super.handleOnDestroy();
    }

    @PluginMethod
    public void getState(PluginCall call) {
        withState(call, (state, activity) -> {
            // Everything is read before anything is answered. A read that
            // throws rejects the call in withState.
            boolean enabled = state.isEnabled();
            boolean locked = state.isLocked();
            int timeoutSec = state.timeoutSec();
            boolean hideText = state.hideText();
            boolean deviceSecure = state.isDeviceSecure();
            boolean autoDisabled = state.consumeAutoDisabled();
            JSObject result = new JSObject();
            result.put("enabled", enabled);
            result.put("locked", locked);
            result.put("timeoutSec", timeoutSec);
            result.put("hideNotificationText", hideText);
            result.put("deviceSecure", deviceSecure);
            result.put("autoDisabled", autoDisabled);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void enable(PluginCall call) {
        withState(call, (state, activity) ->
                state.enable(activity, code -> answerEnabled(call, state, code)));
    }

    @PluginMethod
    public void disable(PluginCall call) {
        withState(call, (state, activity) ->
                state.disable(activity, code -> answerEnabled(call, state, code)));
    }

    @PluginMethod
    public void authenticate(PluginCall call) {
        final boolean auto = Boolean.TRUE.equals(call.getBoolean("auto", Boolean.FALSE));
        withState(call, (state, activity) ->
                state.authenticate(activity, auto, unlocked -> {
                    try {
                        JSObject result = new JSObject();
                        result.put("unlocked", Boolean.TRUE.equals(unlocked));
                        call.resolve(result);
                    } catch (Exception e) {
                        fail(call);
                    }
                }));
    }

    @PluginMethod
    public void setTimeout(PluginCall call) {
        // Null when sec is missing or is not a whole number.
        final Integer sec = call.getInt("sec");
        if (sec == null) {
            fail(call);
            return;
        }
        withState(call, (state, activity) -> {
            if (state.setTimeoutSec(sec)) {
                call.resolve(new JSObject());
            } else if (state.isLocked()) {
                call.reject(CODE_LOCKED, CODE_LOCKED);
            } else {
                fail(call);
            }
        });
    }

    @PluginMethod
    public void setHideNotificationText(PluginCall call) {
        // Null when hide is missing or is not a boolean.
        final Boolean hide = call.getBoolean("hide");
        if (hide == null) {
            fail(call);
            return;
        }
        withState(call, (state, activity) -> {
            if (state.setHideNotificationText(hide)) {
                call.resolve(new JSObject());
            } else if (state.isLocked()) {
                call.reject(CODE_LOCKED, CODE_LOCKED);
            } else {
                fail(call);
            }
        });
    }

    @PluginMethod
    public void gateShown(PluginCall call) {
        withState(call, (state, activity) -> {
            state.gateShown();
            call.resolve(new JSObject());
        });
    }

    @PluginMethod
    public void reset(PluginCall call) {
        withState(call, (state, activity) -> {
            state.reset();
            call.resolve(new JSObject());
        });
    }

    /** The answer of enable and disable: a null code is success. */
    private static void answerEnabled(PluginCall call, AppLockState state, String code) {
        try {
            if (code != null) {
                call.reject(code, code);
                return;
            }
            JSObject result = new JSObject();
            result.put("enabled", state.isEnabled());
            call.resolve(result);
        } catch (Exception e) {
            fail(call);
        }
    }

    /**
     * Run one call into the state on the main thread. Without a MainActivity,
     * or when the call throws, the plugin call is rejected with FAILED.
     */
    private void withState(final PluginCall call, final StateCall body) {
        try {
            Activity activity = getActivity();
            if (!(activity instanceof MainActivity)) {
                fail(call);
                return;
            }
            final MainActivity main = (MainActivity) activity;
            main.runOnUiThread(() -> {
                try {
                    body.run(AppLockState.get(main), main);
                } catch (Exception e) {
                    fail(call);
                }
            });
        } catch (Exception e) {
            fail(call);
        }
    }

    private static void fail(PluginCall call) {
        call.reject(CODE_FAILED, CODE_FAILED);
    }

    /** Run now when already on the main thread, otherwise post there. */
    private static void onMain(Runnable task) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            task.run();
        } else {
            new Handler(Looper.getMainLooper()).post(task);
        }
    }
}
