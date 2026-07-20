package com.acutest.app;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(VoiceCallServicePlugin.class);
        registerPlugin(PushTokenPlugin.class);
        registerPlugin(ApkUpdaterPlugin.class);
        registerPlugin(SpeechToTextPlugin.class);
        registerPlugin(com.acutest.app.e2ee.E2eePlugin.class);
        super.onCreate(savedInstanceState);
        // Serve decrypted E2EE attachments from the native layer (the
        // Android analog of the desktop e2ee-att protocol handler)
        bridge.setWebViewClient(new com.acutest.app.e2ee.E2eeWebViewClient(bridge));

        // DEBUG-ONLY WebView conveniences (slice-4 gate HIGH #1 / MEDIUM #2):
        // release ships with these OFF via capacitor.config so a local
        // attacker cannot attach devtools to read decrypted E2EE plaintext
        // or inject cleartext subresources into the plaintext-capable
        // origin. Re-enabled here strictly for debug builds.
        if (com.acutest.app.BuildConfig.DEBUG && bridge.getWebView() != null) {
            android.webkit.WebView.setWebContentsDebuggingEnabled(true);
            bridge.getWebView().getSettings().setMixedContentMode(
                    android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        handleNotificationIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleNotificationIntent(intent);
    }

    /** Route notification taps (message / answer call) into the web app */
    private void handleNotificationIntent(Intent intent) {
        if (intent == null) return;
        String path = intent.getStringExtra("sloga_path");
        if (path == null) return;
        boolean answer = intent.getBooleanExtra("sloga_answer_call", false);
        intent.removeExtra("sloga_path");

        // Action-button taps don't auto-dismiss notifications — clear the
        // call notification once we're handling the answer.
        if (answer) {
            String channelId = path.substring(path.lastIndexOf('/') + 1);
            androidx.core.app.NotificationManagerCompat.from(this)
                    .cancel(channelId.hashCode());
        }

        PushTokenPlugin.setPendingAction(path, answer);
        if (bridge != null) {
            bridge.triggerWindowJSEvent(
                    "slogaNotificationAction",
                    "{\"path\":\"" + path + "\",\"answer\":" + answer + "}");
        }
    }
}
