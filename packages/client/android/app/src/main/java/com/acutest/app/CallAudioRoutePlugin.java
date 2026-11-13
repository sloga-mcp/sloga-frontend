package com.acutest.app;

import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.annotation.RequiresApi;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.List;

/**
 * The speaker / earpiece switch for a call on a phone.
 *
 * The call's sound is played by the WebView, not by this class. All this
 * plugin does is tell Android which built-in output the app would like for
 * call sound, and report which one is selected now. It never changes the audio
 * mode, never asks for audio focus and never starts or stops a Bluetooth
 * link. Those belong to whatever is playing the call, and a second owner
 * would work against it.
 *
 * The switch is offered only on a device that has both a built-in earpiece
 * and a built-in speaker, and only while the sound is on one of those two.
 * While a wired, USB or Bluetooth headset has the sound, the plugin reports
 * the switch as unsupported and changes nothing, so it can never pull a call
 * off a headset.
 *
 * Every method resolves and none rejects. A failure is an ordinary answer,
 * { supported: false } or { ok: false }, and the web layer hides the button
 * when it gets one.
 *
 * Registered in MainActivity.onCreate like the other plugins. The plugin name
 * must stay `CallAudioRoute`: it is what the web layer passes to
 * registerPlugin().
 */
@CapacitorPlugin(name = "CallAudioRoute")
public class CallAudioRoutePlugin extends Plugin {
    private static final String TAG = "SlogaCalls";

    private static final String ROUTE_SPEAKER = "speaker";
    private static final String ROUTE_EARPIECE = "earpiece";

    /**
     * Answers { supported, route? }. route is "speaker" or "earpiece" and is
     * present only when supported is true.
     */
    @PluginMethod
    public void getRoutes(PluginCall call) {
        String route = null;
        try {
            AudioManager audio = audioManager();
            if (audio != null) route = currentRoute(audio);
        } catch (Exception e) {
            // Only the kind of failure is logged.
            Log.w(TAG, "Could not read the call audio route: " + e.getClass().getSimpleName());
            route = null;
        }
        JSObject result = new JSObject();
        result.put("supported", route != null);
        if (route != null) result.put("route", route);
        call.resolve(result);
    }

    /**
     * Takes { route: "speaker" | "earpiece" } and answers { ok }. ok is false,
     * and nothing was changed, for any other route, on a device without the
     * switch, while a headset has the sound, and on any error.
     */
    @PluginMethod
    public void setRoute(PluginCall call) {
        boolean ok = false;
        try {
            String route = call.getString("route");
            boolean speaker = ROUTE_SPEAKER.equals(route);
            AudioManager audio = audioManager();
            if (audio != null && (speaker || ROUTE_EARPIECE.equals(route))) {
                ok = applyRoute(audio, speaker);
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not set the call audio route: " + e.getClass().getSimpleName());
            ok = false;
        }
        JSObject result = new JSObject();
        result.put("ok", ok);
        call.resolve(result);
    }

    @Nullable
    private AudioManager audioManager() {
        Context ctx = getContext();
        if (ctx == null) return null;
        Object service = ctx.getSystemService(Context.AUDIO_SERVICE);
        return service instanceof AudioManager ? (AudioManager) service : null;
    }

    /**
     * Which built-in output has the call sound, or null when the switch is not
     * available right now. Both methods go through this one check, so setRoute
     * can never act in a state that getRoutes reports as unsupported.
     */
    @Nullable
    private static String currentRoute(AudioManager audio) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return currentRouteS(audio);
        return currentRouteLegacy(audio);
    }

    /**
     * Android 12 and later name the device that has communication sound, so
     * the answer is read from it directly.
     */
    @RequiresApi(Build.VERSION_CODES.S)
    @Nullable
    private static String currentRouteS(AudioManager audio) {
        List<AudioDeviceInfo> available = audio.getAvailableCommunicationDevices();
        if (builtIn(available, AudioDeviceInfo.TYPE_BUILTIN_EARPIECE) == null
                || builtIn(available, AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) == null) {
            return null;
        }
        // No current device means it is not known where the sound is going,
        // and that is treated like a headset: no switch.
        AudioDeviceInfo current = audio.getCommunicationDevice();
        if (current == null) return null;
        switch (current.getType()) {
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER:
                return ROUTE_SPEAKER;
            case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE:
                return ROUTE_EARPIECE;
            default:
                // A headset of any kind, or a device this code does not know.
                return null;
        }
    }

    /**
     * Before Android 12 there is no way to ask which device has communication
     * sound. So a connected headset of any kind counts as in use, and without
     * one the speakerphone flag says which built-in output is selected.
     */
    @SuppressWarnings("deprecation")
    @Nullable
    private static String currentRouteLegacy(AudioManager audio) {
        boolean earpiece = false;
        boolean speaker = false;
        for (AudioDeviceInfo device : audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            int type = device.getType();
            if (type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE) {
                earpiece = true;
            } else if (type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
                speaker = true;
            } else if (isHeadset(type)) {
                return null;
            }
        }
        if (!earpiece || !speaker) return null;
        if (audio.isWiredHeadsetOn() || audio.isBluetoothScoOn() || audio.isBluetoothA2dpOn()) {
            return null;
        }
        return audio.isSpeakerphoneOn() ? ROUTE_SPEAKER : ROUTE_EARPIECE;
    }

    /**
     * Whether an output type is a wired, USB or Bluetooth listening device.
     * TYPE_USB_HEADSET and TYPE_HEARING_AID were added after Android 7, but
     * they are plain numbers fixed when this file is compiled, so comparing
     * against them on an older phone is safe.
     */
    private static boolean isHeadset(int type) {
        switch (type) {
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
            case AudioDeviceInfo.TYPE_USB_HEADSET:
            case AudioDeviceInfo.TYPE_USB_DEVICE:
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
            case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP:
            case AudioDeviceInfo.TYPE_HEARING_AID:
                return true;
            default:
                return false;
        }
    }

    private static boolean applyRoute(AudioManager audio, boolean speaker) {
        // The state is read again here instead of trusting an earlier
        // getRoutes: a headset may have been connected since.
        if (currentRoute(audio) == null) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return applyRouteS(audio, speaker);
        return applyRouteLegacy(audio, speaker);
    }

    @SuppressWarnings("deprecation")
    private static boolean applyRouteLegacy(AudioManager audio, boolean speaker) {
        // Android gives no answer to this call, so ok means the route was
        // asked for, not that it was confirmed.
        audio.setSpeakerphoneOn(speaker);
        return true;
    }

    @RequiresApi(Build.VERSION_CODES.S)
    private static boolean applyRouteS(AudioManager audio, boolean speaker) {
        int type = speaker
                ? AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
                : AudioDeviceInfo.TYPE_BUILTIN_EARPIECE;
        AudioDeviceInfo device = builtIn(audio.getAvailableCommunicationDevices(), type);
        // Android's own answer is the result: false means it did not take
        // the device, and then nothing was changed.
        return device != null && audio.setCommunicationDevice(device);
    }

    /** The first device of the given type in the list, or null. */
    @Nullable
    private static AudioDeviceInfo builtIn(@Nullable List<AudioDeviceInfo> devices, int type) {
        if (devices == null) return null;
        for (AudioDeviceInfo device : devices) {
            if (device != null && device.getType() == type) return device;
        }
        return null;
    }
}
