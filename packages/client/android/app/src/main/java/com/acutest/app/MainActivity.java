package com.acutest.app;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(VoiceCallServicePlugin.class);
        registerPlugin(PushTokenPlugin.class);
        super.onCreate(savedInstanceState);
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
        String path = intent.getStringExtra("acutest_path");
        if (path == null) return;
        boolean answer = intent.getBooleanExtra("acutest_answer_call", false);
        intent.removeExtra("acutest_path");

        PushTokenPlugin.setPendingAction(path, answer);
        if (bridge != null) {
            bridge.triggerWindowJSEvent(
                    "acutestNotificationAction",
                    "{\"path\":\"" + path + "\",\"answer\":" + answer + "}");
        }
    }
}
