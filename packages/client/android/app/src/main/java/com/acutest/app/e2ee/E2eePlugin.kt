package com.acutest.app.e2ee

import android.app.AlertDialog
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.DataOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import uniffi.acutest_e2ee.E2eeException

/**
 * Capacitor bridge for the native E2EE layer (slice 4) — the Android analog
 * of the desktop Tauri command surface (`src-tauri/src/e2ee.rs`).
 *
 * The webview is a COURIER: commands accept/return only public bundles,
 * envelopes, ciphertext ids and decrypted-for-display content; key material
 * never crosses the JS bridge in either direction. Errors are the core's
 * typed, scrubbed JSON, rejected verbatim so the webview bridge sees the
 * same error objects as on desktop.
 *
 * `call()` is the COMPLETE command allowlist — one explicit `when` arm per
 * command, mirroring the desktop allowlist; anything not listed does not
 * exist. Three operations are NOT routed through `call()`:
 *  - `wipe` has its own method because it must show a BLOCKING NATIVE
 *    confirmation dialog (design §9a / slice-2 gate MEDIUM #4): the webview
 *    can only REQUEST a wipe; destruction requires a physical tap on an OS
 *    dialog this plugin owns.
 *  - `attachmentUpload` / `attachmentFetch` move attachment CIPHERTEXT
 *    between the Rust core and Autumn natively, so multi-megabyte payloads
 *    never transit the JS bridge (and fetched bytes go straight into the
 *    core's mandatory digest verification).
 */
@CapacitorPlugin(name = "E2ee")
class E2eePlugin : Plugin() {
    /**
     * Engine calls run off Capacitor's single plugin-handler thread so a
     * slow upload cannot starve decrypts. The engine's internal mutex gives
     * mutual EXCLUSION, not FIFO ordering — decrypt ordering (ratchet order
     * = delivery order) is guaranteed by the JS-side `#decryptQueue` in
     * `e2ee.ts`, which chains and awaits each envelope before dispatching
     * the next. Any future caller invoking `e2ee_decrypt` outside that
     * queue would race the ratchet, so decrypts MUST stay serialized there.
     */
    private val executor: ExecutorService = Executors.newCachedThreadPool()

    private fun engine() = E2eeNative.engine(context)

    /** Resolve with the engine's JSON payload under a single `json` key. */
    private fun resolveJson(call: PluginCall, json: String) {
        val result = JSObject()
        result.put("json", json)
        call.resolve(result)
    }

    /**
     * Reject with the core's scrubbed error JSON (the message IS the JSON;
     * the webview transport parses it back into the desktop-identical
     * error object). Anything that is not a typed core error degrades to
     * the least-informative variant — never a raw exception message.
     */
    private fun rejectScrubbed(call: PluginCall, error: Throwable) {
        val message = (error as? E2eeException)?.message
        val json =
            if (message != null && message.startsWith("{")) message
            else "{\"type\":\"crypto_failure\"}"
        call.reject(json)
    }

    private fun run(call: PluginCall, body: () -> Unit) {
        executor.execute {
            try {
                body()
            } catch (error: Throwable) {
                rejectScrubbed(call, error)
            }
        }
    }

    private fun requireString(call: PluginCall, key: String): String =
        call.getString(key) ?: throw E2eeException.Failure("{\"type\":\"invalid_argument\",\"field\":\"$key\"}")

    /** A structured argument, re-serialized for the JSON FFI boundary. */
    private fun objectJson(call: PluginCall, key: String): String =
        call.getObject(key)?.toString()
            ?: throw E2eeException.Failure("{\"type\":\"invalid_argument\",\"field\":\"$key\"}")

    private fun arrayJson(call: PluginCall, key: String): String =
        call.getArray(key)?.toString()
            ?: throw E2eeException.Failure("{\"type\":\"invalid_argument\",\"field\":\"$key\"}")

    @PluginMethod
    fun call(call: PluginCall) {
        // `__cmd` (not `name`): command args spread at the top level, and
        // `name` is a legitimate argument of e2ee_attachment_prepare
        val name = call.getString("__cmd") ?: run {
            call.reject("{\"type\":\"invalid_argument\",\"field\":\"__cmd\"}")
            return
        }

        run(call) {
            val engine = engine()
            when (name) {
                "e2ee_status" -> resolveJson(call, engine.status())
                "e2ee_enable" -> resolveJson(call, engine.enable())
                "e2ee_mark_published" -> {
                    engine.markPublished()
                    resolveJson(call, "null")
                }
                "e2ee_replenish" ->
                    resolveJson(
                        call,
                        engine.replenish(
                            call.getInt("serverRemaining")?.toULong()
                                ?: throw E2eeException.Failure(
                                    "{\"type\":\"invalid_argument\",\"field\":\"serverRemaining\"}",
                                ),
                        ),
                    )
                "e2ee_sign_claim" ->
                    resolveJson(
                        call,
                        // sign_claim returns a bare string — JSON-quote it so
                        // the transport can uniformly JSON.parse the payload
                        org.json.JSONObject.quote(
                            engine.signClaim(
                                requireString(call, "sessionId"),
                                requireString(call, "nonce"),
                            ),
                        ),
                    )
                "e2ee_encrypt" ->
                    resolveJson(
                        call,
                        engine.encrypt(
                            requireString(call, "peerUserId"),
                            requireString(call, "selfUserId"),
                            call.getObject("peerBundle")?.toString(),
                            call.getObject("selfBundle")?.toString(),
                            requireString(call, "content"),
                            call.getArray("attachments")?.toList<String>() ?: emptyList(),
                        ),
                    )
                "e2ee_decrypt" -> resolveJson(call, engine.decrypt(objectJson(call, "envelope")))
                "e2ee_history" ->
                    resolveJson(
                        call,
                        engine.history(
                            requireString(call, "peerUserId"),
                            call.getString("before"),
                            (call.getInt("limit") ?: 50).toUInt(),
                        ),
                    )
                "e2ee_send_mode" ->
                    resolveJson(call, engine.sendMode(requireString(call, "peerUserId")))
                "e2ee_conversation_state" ->
                    resolveJson(call, engine.conversationState(requireString(call, "peerUserId")))
                "e2ee_accept_identity_change" -> {
                    engine.acceptIdentityChange(
                        requireString(call, "peerUserId"),
                        requireString(call, "deviceId"),
                    )
                    resolveJson(call, "null")
                }
                "e2ee_reconcile_devices" ->
                    resolveJson(
                        call,
                        engine.reconcileDevices(
                            requireString(call, "userId"),
                            arrayJson(call, "devices"),
                        ),
                    )
                "e2ee_handle_receipts" ->
                    resolveJson(call, engine.handleReceipts(arrayJson(call, "receipts")))
                "e2ee_device_removed" -> {
                    engine.deviceRemoved(
                        requireString(call, "userId"),
                        requireString(call, "deviceId"),
                    )
                    resolveJson(call, "null")
                }
                "e2ee_attachment_prepare" ->
                    resolveJson(
                        call,
                        engine.attachmentPrepare(
                            requireString(call, "peerUserId"),
                            requireString(call, "name"),
                            requireString(call, "mime"),
                            Base64.decode(requireString(call, "plaintextBase64"), Base64.DEFAULT),
                        ),
                    )
                "e2ee_attachment_attach_blob" -> {
                    engine.attachmentAttachBlob(
                        requireString(call, "localId"),
                        requireString(call, "blobId"),
                    )
                    resolveJson(call, "null")
                }
                "e2ee_attachment_mark_unavailable" -> {
                    engine.attachmentMarkUnavailable(
                        requireString(call, "localId"),
                        call.getBoolean("expired") ?: false,
                    )
                    resolveJson(call, "null")
                }
                "e2ee_attachment_recipients" ->
                    resolveJson(
                        call,
                        engine.attachmentRecipients(
                            requireString(call, "peerUserId"),
                            requireString(call, "selfUserId"),
                        ),
                    )
                // NOT here by design: e2ee_wipe (native dialog method),
                // e2ee_attachment_ciphertext / e2ee_attachment_store (bytes
                // stay native — see attachmentUpload / attachmentFetch),
                // open_attachment_for_render (WebView interceptor only).
                else ->
                    call.reject("{\"type\":\"invalid_argument\",\"field\":\"name\"}")
            }
        }
    }

    /**
     * Destroy ALL local E2EE state — behind a BLOCKING NATIVE dialog.
     * Mirrors the desktop `e2ee_wipe`: decline rejects with the typed
     * `declined` error and nothing changes; a compromised webview calling
     * this in a loop gets a dialog the user must physically tap.
     */
    @PluginMethod
    fun wipe(call: PluginCall) {
        activity.runOnUiThread {
            AlertDialog.Builder(activity)
                .setTitle("Log out and destroy encrypted data")
                .setMessage(
                    "This permanently destroys the encrypted message history and " +
                        "encryption keys stored on THIS device. Messages that were only " +
                        "delivered here cannot be recovered.\n\nDestroy encrypted data?",
                )
                .setPositiveButton("Destroy") { _, _ ->
                    run(call) {
                        engine().wipe()
                        // Delete the now-orphaned Keystore wrapping key
                        // AFTER the store it wrapped is gone (gate LOW #6)
                        KeystoreProtector(context.applicationContext).deleteWrappingKey()
                        resolveJson(call, "null")
                    }
                }
                .setNegativeButton("Cancel") { _, _ ->
                    call.reject("{\"type\":\"declined\"}")
                }
                .setOnCancelListener { call.reject("{\"type\":\"declined\"}") }
                .show()
        }
    }

    /**
     * Open a hardened connection to an Autumn URL (slice-4 gate MEDIUM #3 /
     * #4 / #6). The session token rides on custom headers that Android does
     * NOT strip across a cross-host redirect, so:
     *  - redirects are DISABLED (an open-redirect on the honest Autumn host
     *    can't bounce the token/ciphertext to an attacker host);
     *  - the URL must be https (no cleartext token);
     *  - connect/read timeouts bound slow-loris thread exhaustion.
     * The auth header is the session token the webview already holds — the
     * same credential it sends on every API request.
     */
    private fun openAutumn(url: String): HttpURLConnection {
        val parsed = URL(url)
        if (!parsed.protocol.equals("https", ignoreCase = true)) {
            throw E2eeException.Failure("{\"type\":\"invalid_argument\",\"field\":\"url\"}")
        }
        val connection = parsed.openConnection() as HttpURLConnection
        connection.instanceFollowRedirects = false
        connection.connectTimeout = 15_000
        connection.readTimeout = 30_000
        return connection
    }

    /** Read at most [max] bytes; a larger body is a hostile server (#4). */
    private fun readBounded(input: java.io.InputStream, max: Long): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            total += read
            if (total > max) {
                throw E2eeException.Failure(
                    "{\"type\":\"attachment_unavailable\",\"state\":\"oversized\"}",
                )
            }
            out.write(buffer, 0, read)
        }
        return out.toByteArray()
    }

    /**
     * Upload a prepared outbound attachment's CIPHERTEXT to Autumn's
     * opaque-blob route and record the returned blob id — entirely native,
     * so the ciphertext never transits the JS bridge.
     */
    @PluginMethod
    fun attachmentUpload(call: PluginCall) {
        run(call) {
            val localId = requireString(call, "localId")
            val url = requireString(call, "url")
            val authHeader = requireString(call, "authHeader")
            val authValue = requireString(call, "authValue")
            val recipientsJson = requireString(call, "recipientsJson")

            val ciphertext = engine().attachmentCiphertext(localId)

            val boundary = "acutest-e2ee-" + System.nanoTime()
            val connection = openAutumn(url)
            connection.requestMethod = "POST"
            connection.doOutput = true
            connection.setRequestProperty(authHeader, authValue)
            connection.setRequestProperty(
                "Content-Type",
                "multipart/form-data; boundary=$boundary",
            )

            DataOutputStream(connection.outputStream).use { out ->
                out.writeBytes("--$boundary\r\n")
                out.writeBytes(
                    "Content-Disposition: form-data; name=\"file\"; filename=\"blob\"\r\n",
                )
                out.writeBytes("Content-Type: application/octet-stream\r\n\r\n")
                out.write(ciphertext)
                out.writeBytes("\r\n--$boundary\r\n")
                out.writeBytes("Content-Disposition: form-data; name=\"recipients\"\r\n\r\n")
                out.writeBytes(recipientsJson)
                out.writeBytes("\r\n--$boundary--\r\n")
            }

            val status = connection.responseCode
            if (status != 200) {
                connection.disconnect()
                throw E2eeException.Failure("{\"type\":\"attachment_unavailable\",\"state\":\"upload_failed\"}")
            }

            // The upload response is a tiny JSON `{id}` — 64 KiB is ample
            val body =
                connection.inputStream.use { readBounded(it, 64 * 1024) }
                    .toString(Charsets.UTF_8)
            connection.disconnect()
            val blobId = org.json.JSONObject(body).optString("id", "")
            if (blobId.isEmpty()) {
                throw E2eeException.Failure("{\"type\":\"attachment_unavailable\",\"state\":\"upload_failed\"}")
            }

            engine().attachmentAttachBlob(localId, blobId)
            resolveJson(call, org.json.JSONObject.quote(blobId))
        }
    }

    /**
     * Fetch a pending inbound attachment's ciphertext and hand it straight
     * to the core (digest verification MANDATORY there before anything is
     * persisted). Resolves with the resulting state: `ready`, `expired`
     * (404/410 — marked natively), `failed` (digest mismatch — marked by
     * the core), or `pending` (transient error; the next sync retries).
     */
    @PluginMethod
    fun attachmentFetch(call: PluginCall) {
        run(call) {
            val localId = requireString(call, "localId")
            val url = requireString(call, "url")
            val authHeader = requireString(call, "authHeader")
            val authValue = requireString(call, "authValue")

            val state: String = try {
                val connection = openAutumn(url)
                connection.setRequestProperty(authHeader, authValue)
                when (val status = connection.responseCode) {
                    200 -> {
                        // Ciphertext ceiling: Autumn caps uploads at 21 MiB;
                        // a larger GET body is a hostile server (OOM DoS #4)
                        val bytes =
                            connection.inputStream.use {
                                readBounded(it, 21L * 1024 * 1024)
                            }
                        connection.disconnect()
                        try {
                            engine().attachmentStore(localId, bytes)
                            "ready"
                        } catch (error: E2eeException) {
                            // Digest mismatch / undecryptable — the core
                            // already marked the row failed (terminal)
                            "failed"
                        }
                    }
                    404, 410 -> {
                        connection.disconnect()
                        engine().attachmentMarkUnavailable(localId, true)
                        "expired"
                    }
                    else -> {
                        connection.disconnect()
                        "pending"
                    }
                }
            } catch (error: E2eeException) {
                throw error
            } catch (error: Exception) {
                // Network failure: stay pending, retried on the next sync
                "pending"
            }

            resolveJson(call, org.json.JSONObject.quote(state))
        }
    }
}
