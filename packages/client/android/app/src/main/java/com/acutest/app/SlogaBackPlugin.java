package com.acutest.app;

import android.graphics.Rect;
import android.view.View;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.view.ViewCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * The return leg of the Android back key.
 *
 * MainActivity consumes every back press and fires `slogaBackPressed` at the
 * window. The web layer (components/client/AndroidBackWorker.tsx) walks the
 * dismissal ladder — native fullscreen, the Escape group of floating elements
 * and modals and the channel side column, the phone slide drawer, then history
 * — and calls {@link #exitApp(PluginCall)} here only when every rung declined:
 * there was no overlay to close and nowhere left to navigate back to.
 *
 * That round trip exists because the native side cannot wait for the answer.
 * The press has to be consumed synchronously, and what it means is only
 * knowable in the web layer, so "nothing was open, actually leave" has to come
 * back across the bridge as a separate call.
 *
 * Registered in MainActivity.onCreate exactly like PushTokenPlugin and
 * AppFlavorPlugin, and the plugin name here must stay `SlogaBack` — it is what
 * the web layer passes to registerPlugin(). No new dependency: `@capacitor/app`
 * is deliberately not added, and it would not have removed the predictive-back
 * work anyway.
 */
@CapacitorPlugin(name = "SlogaBack")
public class SlogaBackPlugin extends Plugin {

    @PluginMethod
    public void exitApp(PluginCall call) {
        AppCompatActivity activity = getActivity();
        if (!(activity instanceof MainActivity)) {
            call.reject("No MainActivity to leave");
            return;
        }
        // exitFromWebLayer hops to the UI thread itself: Capacitor may deliver
        // a plugin call on a background thread, and moveTaskToBack/finish are
        // main-thread only.
        ((MainActivity) activity).exitFromWebLayer();
        call.resolve();
    }

    /**
     * Parts of the web view where a swipe in from the side of the screen is
     * not Back. With gesture navigation the system takes any touch that
     * starts in its edge strip, and the page only hears a cancelled pointer;
     * something small that sits at the edge and is dragged by finger (the
     * corner tile of a Slim video call) could not be picked up from that side.
     *
     * `rects` is a list of {x, y, width, height} in device pixels of the web
     * view, and replaces the list from the call before; an empty or missing
     * list gives the edges back. The system honours at most 200dp of height
     * per edge and ignores the rest, and before Android 10 there is no such
     * strip, where ViewCompat makes this a no-op.
     */
    @PluginMethod
    public void setGestureExclusion(PluginCall call) {
        final List<Rect> rects = new ArrayList<>();
        JSArray list = call.getArray("rects");
        if (list != null) {
            for (int i = 0; i < list.length(); i++) {
                JSONObject item = list.optJSONObject(i);
                if (item == null) continue;
                int x = item.optInt("x", 0);
                int y = item.optInt("y", 0);
                int width = item.optInt("width", 0);
                int height = item.optInt("height", 0);
                if (width <= 0 || height <= 0) continue;
                rects.add(new Rect(x, y, x + width, y + height));
            }
        }
        final View webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView == null) {
            call.reject("No web view");
            return;
        }
        // Capacitor may deliver a plugin call on a background thread; a view
        // is only touched on its own.
        webView.post(() -> ViewCompat.setSystemGestureExclusionRects(webView, rects));
        call.resolve();
    }
}
