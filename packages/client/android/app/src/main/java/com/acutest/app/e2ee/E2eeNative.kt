package com.acutest.app.e2ee

import android.content.Context
import java.io.File
import uniffi.acutest_e2ee.E2eeEngine

/**
 * Process-wide E2EE engine handle (the Android analog of the desktop's
 * managed `E2eeState`). Construction is cheap and does NOT open the store —
 * the engine opens lazily on first command, so a Keystore failure cannot
 * block app startup for users who never enabled E2EE.
 *
 * Shared by the Capacitor plugin (commands) and the WebView interceptor
 * (attachment rendering).
 */
object E2eeNative {
    @Volatile
    private var engine: E2eeEngine? = null

    fun engine(context: Context): E2eeEngine {
        return engine ?: synchronized(this) {
            engine ?: run {
                // App-private storage: files/e2ee — the OS sandbox is the
                // outer boundary, the Keystore-wrapped master key + AEAD
                // column encryption the inner one (same layering as desktop)
                val appContext = context.applicationContext
                val dir = File(appContext.filesDir, "e2ee")
                E2eeEngine(dir.absolutePath, KeystoreProtector(appContext)).also {
                    engine = it
                }
            }
        }
    }
}
