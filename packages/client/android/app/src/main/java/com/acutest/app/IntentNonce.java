package com.acutest.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;

import java.security.SecureRandom;

/**
 * Per-install secret proving a notification Intent was minted by Sloga itself.
 *
 * MainActivity is exported — it carries the LAUNCHER intent-filter, so it
 * cannot be anything else — which means ANY installed app, with zero
 * permissions, can start it with arbitrary extras. Those extras were
 * concatenated straight into a JavaScript source string and handed to
 * WebView.evaluateJavascript, so a single quote in one of them escaped into
 * executable code running in the app's own origin: session token, decrypted
 * E2EE message content, everything. The meta-CSP does not help here —
 * evaluateJavascript is embedder-initiated and exempt from it.
 *
 * The value lives in MODE_PRIVATE SharedPreferences, which the Android sandbox
 * keeps unreadable by other apps. It must SURVIVE PROCESS DEATH: a
 * PendingIntent minted before the process was killed is routinely tapped
 * afterwards, so a per-process value would silently stop notification taps
 * from opening the right channel. It is excluded from backup and device
 * transfer alongside the push token.
 */
public final class IntentNonce {
    /** Extra carrying the nonce on Sloga's own notification Intents. */
    public static final String EXTRA = "sloga_nonce";

    private static final String PREFS = "sloga_ipc";
    private static final String KEY = "intent_nonce";

    private IntentNonce() {}

    /** This install's nonce, minting one on first use. */
    public static synchronized String get(Context context) {
        SharedPreferences prefs =
                context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String existing = prefs.getString(KEY, null);
        if (existing != null) return existing;

        byte[] bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        String minted = Base64.encodeToString(bytes, Base64.NO_WRAP | Base64.URL_SAFE);
        // commit(), not apply(): if the process dies before an async write
        // lands, every already-posted notification would fail its nonce check.
        prefs.edit().putString(KEY, minted).commit();
        return minted;
    }

    /** Constant-time comparison of a supplied extra against this install's nonce. */
    public static boolean matches(Context context, String supplied) {
        if (supplied == null) return false;
        String expected = get(context);
        if (supplied.length() != expected.length()) return false;
        int diff = 0;
        for (int i = 0; i < expected.length(); i++) {
            diff |= expected.charAt(i) ^ supplied.charAt(i);
        }
        return diff == 0;
    }
}
