package com.acutest.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * On-device speech-to-text for live call captions — the Android-native analog
 * of the web `WebSpeechCaptionEngine`. Wraps the platform [SpeechRecognizer]
 * and streams interim + final transcripts to the webview as `partialResult` /
 * `finalResult` events, which `CapacitorSpeechCaptionEngine` maps onto the
 * shared `CaptionEngine` contract. It exists because the Android System WebView
 * exposes `webkitSpeechRecognition` but cannot actually run it (no speech
 * backend) — so the web engine silently fails on the app and captions could
 * only ever be RECEIVED, never broadcast.
 *
 * PRIVACY: prefers the on-device recognizer (`createOnDeviceSpeechRecognizer`
 * on API 31+, plus `EXTRA_PREFER_OFFLINE`) so microphone audio and the
 * transcript never leave the phone — a STRONGER guarantee than the web Web
 * Speech path, which streams mic audio to the browser vendor (Google). Only the
 * resulting caption TEXT is forwarded to the webview, and it rides the same
 * unencrypted LiveKit data channel, so the caller keeps captions OFF on E2EE
 * calls (that gate lives in `CaptionPublisher`, unchanged). The diagnostic logs
 * here record lifecycle + result LENGTHS and error codes only, never the
 * recognized text.
 *
 * The recognizer is single-utterance and MUST be driven from the main thread;
 * this plugin restarts it on each end-of-utterance / benign error so one
 * `start()` behaves like a continuous stream for the life of a call, with
 * exponential backoff on a hard-failing loop (mirrors the web engine's
 * `onend` restart discipline).
 *
 * CAVEAT (validate on-device): captions run DURING an active call, where
 * WebRTC/LiveKit already holds the microphone. Android's concurrent-capture
 * rules decide whether `SpeechRecognizer` can also open the mic at the same
 * time; on some devices/OEMs the VoIP capture may take priority and recognition
 * yields `ERROR_NO_MATCH` / no audio. If that proves widespread the fallback is
 * a cloud STT fed from the WebRTC track (a larger change) behind this same
 * `CaptionEngine` seam. `RECORD_AUDIO` is already granted for the call, so no
 * separate permission request is issued here.
 */
@CapacitorPlugin(name = "SpeechToText")
class SpeechToTextPlugin : Plugin() {
    private val main = Handler(Looper.getMainLooper())
    private var recognizer: SpeechRecognizer? = null

    /** All of the following are touched ONLY on the main thread. */
    private var active = false
    private var lang = "en-US"

    /** Consecutive restarts that produced no recognition — drives backoff. */
    private var failures = 0
    private var restartTask: Runnable? = null

    /** Whether on-device speech recognition can run in this install. */
    @PluginMethod
    fun available(call: PluginCall) {
        val result = JSObject()
        result.put("available", isRecognitionAvailable())
        call.resolve(result)
    }

    /**
     * Begin continuous recognition in `lang` (BCP-47). Interim results arrive
     * as `partialResult`, finalized utterances as `finalResult`. Idempotent:
     * calling again while running just re-targets the language.
     */
    @PluginMethod
    fun start(call: PluginCall) {
        val requested = call.getString("lang") ?: "en-US"
        val mic = hasMicPermission()
        val available = isRecognitionAvailable()
        Log.i(TAG, "start lang=$requested mic=$mic available=$available")
        if (!mic) {
            // Captions run inside a call that already holds RECORD_AUDIO; if it
            // is somehow absent we surface it rather than crash, and the webview
            // stays receive-only.
            emitError("not-allowed")
            call.resolve()
            return
        }
        if (!available) {
            emitError("unsupported")
            call.resolve()
            return
        }
        main.post {
            lang = requested
            if (active) return@post // already running; `lang` applies on the next restart
            active = true
            failures = 0
            spinUp()
        }
        call.resolve()
    }

    /** Stop recognition and release the recognizer. */
    @PluginMethod
    fun stop(call: PluginCall) {
        main.post { teardown() }
        call.resolve()
    }

    override fun handleOnDestroy() {
        main.post { teardown() }
        super.handleOnDestroy()
    }

    private fun hasMicPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED

    private fun isRecognitionAvailable(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            SpeechRecognizer.isOnDeviceRecognitionAvailable(context) ||
                SpeechRecognizer.isRecognitionAvailable(context)
        } else {
            SpeechRecognizer.isRecognitionAvailable(context)
        }

    /** Create a recognizer (prefer on-device) and start listening. Main thread. */
    private fun spinUp() {
        val onDevice =
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
        Log.i(TAG, "spinUp onDevice=$onDevice lang=$lang")
        val rec =
            if (onDevice) {
                SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
            } else {
                SpeechRecognizer.createSpeechRecognizer(context)
            }
        rec.setRecognitionListener(listener)
        recognizer = rec
        try {
            rec.startListening(buildIntent())
        } catch (error: Exception) {
            Log.w(TAG, "startListening threw: ${error.message}")
            scheduleRestart()
        }
    }

    private fun buildIntent(): Intent =
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(
                RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                RecognizerIntent.LANGUAGE_MODEL_FREE_FORM,
            )
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            // Keep recognition on-device wherever the platform supports it.
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
            // Some OEM recognizers require the caller package; the constant is
            // hidden in RecognizerIntent, so pass the literal key.
            putExtra("calling_package", context.packageName)
        }

    private fun teardown() {
        Log.i(TAG, "teardown")
        active = false
        restartTask?.let { main.removeCallbacks(it) }
        restartTask = null
        recognizer?.let {
            try {
                it.stopListening()
            } catch (_: Exception) {}
            try {
                it.destroy()
            } catch (_: Exception) {}
        }
        recognizer = null
    }

    /**
     * Recreate + restart after a bounded backoff (250ms → 30s, self-healing).
     * Used for hard errors (recognizer busy/client/server/network) where the
     * current instance is unhealthy; `onResults` and benign no-speech errors
     * take the cheaper same-instance restart path.
     */
    private fun scheduleRestart() {
        recognizer?.let {
            try {
                it.destroy()
            } catch (_: Exception) {}
        }
        recognizer = null
        if (!active) return
        failures += 1
        // Cap the exponent BEFORE shifting so the Long never overflows;
        // 250 << 7 = 32000 already exceeds the 30s ceiling.
        val shift = (failures - 1).coerceIn(0, 7)
        val delay = minOf(250L shl shift, 30_000L)
        Log.d(TAG, "scheduleRestart failures=$failures delay=${delay}ms")
        val task = Runnable { if (active) spinUp() }
        restartTask = task
        main.postDelayed(task, delay)
    }

    /** Restart the SAME recognizer after a clean end-of-utterance / no-match. */
    private fun restartListening() {
        if (!active) return
        val rec = recognizer
        if (rec == null) {
            spinUp()
            return
        }
        try {
            rec.startListening(buildIntent())
        } catch (error: Exception) {
            // Typically ERROR_RECOGNIZER_BUSY if we restarted too eagerly —
            // fall back to a fresh instance with backoff.
            scheduleRestart()
        }
    }

    private fun emitText(event: String, text: String) {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return
        Log.d(TAG, "$event ${trimmed.length} chars")
        val payload = JSObject()
        payload.put("text", trimmed)
        notifyListeners(event, payload)
    }

    private fun emitError(error: String) {
        val payload = JSObject()
        payload.put("error", error)
        notifyListeners("error", payload)
    }

    private val listener =
        object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {}

            override fun onBeginningOfSpeech() {}

            override fun onRmsChanged(rmsdB: Float) {}

            override fun onBufferReceived(buffer: ByteArray?) {}

            override fun onEndOfSpeech() {}

            override fun onPartialResults(partialResults: Bundle?) {
                // Any recognition means the service is reachable — reset backoff.
                failures = 0
                firstMatch(partialResults)?.let { emitText("partialResult", it) }
            }

            override fun onResults(results: Bundle?) {
                failures = 0
                firstMatch(results)?.let { emitText("finalResult", it) }
                // Single-utterance recognizer: restart promptly to stay live.
                main.post { restartListening() }
            }

            override fun onError(error: Int) {
                Log.w(TAG, "onError code=$error")
                when (error) {
                    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> {
                        emitError("not-allowed")
                        teardown()
                    }
                    // No speech captured this window — benign; restart on the
                    // same instance after a short beat to avoid ERROR_RECOGNIZER_BUSY.
                    SpeechRecognizer.ERROR_NO_MATCH,
                    SpeechRecognizer.ERROR_SPEECH_TIMEOUT,
                    -> {
                        if (active) {
                            val task = Runnable { restartListening() }
                            restartTask = task
                            main.postDelayed(task, 150L)
                        }
                    }
                    // Recognizer/network in a bad state — recreate with backoff.
                    else -> scheduleRestart()
                }
            }

            override fun onEvent(eventType: Int, params: Bundle?) {}
        }

    private fun firstMatch(bundle: Bundle?): String? =
        bundle
            ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            ?.firstOrNull()
            ?.takeIf { it.isNotBlank() }

    private companion object {
        const val TAG = "SlogaCaptions"
    }
}
