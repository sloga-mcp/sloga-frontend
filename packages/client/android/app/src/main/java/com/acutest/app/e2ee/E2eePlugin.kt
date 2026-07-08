package com.acutest.app.e2ee

import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Typeface
import android.os.Build
import android.os.PersistableBundle
import android.text.InputType
import android.util.Base64
import android.view.View
import android.view.WindowManager
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
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
                // Pure filesystem check — does NOT open/provision the engine
                // (mirrors desktop `e2ee_is_provisioned`). The webview calls
                // this on connect before any status query so a fresh install
                // is not provisioned before key-backup RESTORE can run (design
                // §6.1). `engine()` only returns the lazy handle; the store is
                // opened by the FIRST engine op, and this is deliberately not
                // one of them.
                "e2ee_is_provisioned" ->
                    resolveJson(call, if (engine.isProvisioned()) "true" else "false")
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
                // ---- Group DMs, verification, downgrade (slice 5) ----
                "e2ee_send_mode_group" ->
                    resolveJson(call, engine.sendModeGroup(requireString(call, "conversationId")))
                "e2ee_encrypt_group" ->
                    resolveJson(
                        call,
                        engine.encryptGroup(
                            requireString(call, "conversationId"),
                            requireString(call, "selfUserId"),
                            call.getArray("bundles")?.toString(),
                            requireString(call, "content"),
                            call.getArray("attachments")?.toList<String>() ?: emptyList(),
                        ),
                    )
                "e2ee_enable_group" ->
                    resolveJson(
                        call,
                        engine.enableGroup(
                            requireString(call, "conversationId"),
                            call.getArray("roster")?.toList<String>() ?: emptyList(),
                            requireString(call, "selfUserId"),
                            call.getArray("bundles")?.toString(),
                        ),
                    )
                "e2ee_add_group_member" ->
                    resolveJson(
                        call,
                        engine.addGroupMember(
                            requireString(call, "conversationId"),
                            requireString(call, "userId"),
                            requireString(call, "selfUserId"),
                            call.getArray("bundles")?.toString(),
                        ),
                    )
                "e2ee_group_reconcile" ->
                    resolveJson(
                        call,
                        engine.groupReconcile(
                            requireString(call, "conversationId"),
                            call.getArray("displayed")?.toList<String>() ?: emptyList(),
                            requireString(call, "selfUserId"),
                        ),
                    )
                "e2ee_group_state" ->
                    resolveJson(call, engine.groupState(requireString(call, "conversationId")))
                "e2ee_safety_number" ->
                    resolveJson(
                        call,
                        engine.safetyNumber(
                            requireString(call, "selfUserId"),
                            requireString(call, "peerUserId"),
                            requireString(call, "deviceId"),
                        ),
                    )
                "e2ee_mark_verified" -> {
                    engine.markVerified(
                        requireString(call, "peerUserId"),
                        requireString(call, "deviceId"),
                    )
                    resolveJson(call, "null")
                }
                "e2ee_confirm_peer_downgrade" -> {
                    engine.confirmPeerDowngrade(
                        requireString(call, "conversationId"),
                        call.getBoolean("accept") ?: false,
                    )
                    resolveJson(call, "null")
                }
                "e2ee_resend_downgrade" ->
                    resolveJson(
                        call,
                        engine.resendDowngrade(
                            requireString(call, "conversationId"),
                            requireString(call, "selfUserId"),
                            call.getArray("bundles")?.toString(),
                        ),
                    )
                "e2ee_mark_downgrade_delivered" -> {
                    engine.markDowngradeDelivered(requireString(call, "conversationId"))
                    resolveJson(call, "null")
                }
                "e2ee_pending_downgrades" ->
                    resolveJson(call, engine.pendingDowngrades())
                "e2ee_attachment_recipients_group" ->
                    resolveJson(
                        call,
                        engine.attachmentRecipientsGroup(
                            requireString(call, "conversationId"),
                            requireString(call, "selfUserId"),
                        ),
                    )
                // ---- Key backup & recovery (slice 5.5) ----
                // Ciphertext-only / no-code commands go through the generic
                // allowlist, exactly like the desktop main-window commands. The
                // code-BEARING flows (create / rotate / restore) are NOT here —
                // they are dedicated native-dialog methods below (wipe parity),
                // so the recovery code never reaches the generic `call()` path
                // and never crosses back to the webview.
                "e2ee_backup_status" -> resolveJson(call, engine.backupStatus())
                "e2ee_backup_refresh_if_due" ->
                    resolveJson(call, engine.backupRefreshIfDue(requireString(call, "userId")))
                "e2ee_backup_mark_uploaded" -> {
                    val generation =
                        call.getInt("generation")
                            ?: throw E2eeException.Failure(
                                "{\"type\":\"invalid_argument\",\"field\":\"generation\"}",
                            )
                    engine.backupMarkUploaded(generation.toLong())
                    resolveJson(call, "null")
                }
                "e2ee_backup_forget_local" -> {
                    engine.backupForgetLocal()
                    resolveJson(call, "null")
                }
                // NOT here by design: e2ee_wipe + e2ee_downgrade +
                // e2ee_confirm_peer_downgrade-ACCEPT (native dialog methods;
                // the generic `confirm_peer_downgrade` arm above only handles
                // DECLINE — the JS transport routes accept + downgrade to the
                // dedicated dialog methods below);
                // e2ee_attachment_ciphertext / e2ee_attachment_store (bytes
                // stay native — see attachmentUpload / attachmentFetch),
                // open_attachment_for_render (WebView interceptor only);
                // backupCreate / backupRotate / backupRestore (the recovery
                // CODE is displayed/entered in a native dialog — dedicated
                // methods below, wipe parity; never routed through call()).
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
     * Turn off encryption for a conversation — behind a BLOCKING NATIVE
     * dialog (slice 5, design §5.2). Mirrors the desktop `e2ee_downgrade`:
     * the webview can only REQUEST; the plaintext-direction transition needs
     * a physical tap. Decline rejects with the typed `declined` error.
     */
    @PluginMethod
    fun downgrade(call: PluginCall) {
        val conversationId = call.getString("conversationId") ?: run {
            call.reject("{\"type\":\"invalid_argument\",\"field\":\"conversationId\"}")
            return
        }
        val selfUserId = call.getString("selfUserId") ?: run {
            call.reject("{\"type\":\"invalid_argument\",\"field\":\"selfUserId\"}")
            return
        }
        val bundles = call.getArray("bundles")?.toString()
        activity.runOnUiThread {
            AlertDialog.Builder(activity)
                .setTitle("Turn off encryption")
                .setMessage(
                    "New messages you send in this conversation will be readable by " +
                        "the server and are no longer end-to-end encrypted. Existing " +
                        "encrypted messages stay encrypted.\n\nTurn off encryption for " +
                        "this conversation?",
                )
                .setPositiveButton("Turn off") { _, _ ->
                    run(call) {
                        resolveJson(call, engine().downgrade(conversationId, selfUserId, bundles))
                    }
                }
                .setNegativeButton("Cancel") { _, _ -> call.reject("{\"type\":\"declined\"}") }
                .setOnCancelListener { call.reject("{\"type\":\"declined\"}") }
                .show()
        }
    }

    /**
     * ACCEPT a peer's downgrade — behind a BLOCKING NATIVE dialog (final-audit
     * MEDIUM). The receiver's move to plaintext must be a physical tap, not a
     * webview boolean. (The DECLINE path is handled by the generic
     * `e2ee_confirm_peer_downgrade` dispatch arm without a dialog.)
     */
    @PluginMethod
    fun confirmPeerDowngradeAccept(call: PluginCall) {
        val conversationId = call.getString("conversationId") ?: run {
            call.reject("{\"type\":\"invalid_argument\",\"field\":\"conversationId\"}")
            return
        }
        activity.runOnUiThread {
            AlertDialog.Builder(activity)
                .setTitle("Encryption was turned off")
                .setMessage(
                    "The other side turned off end-to-end encryption for this " +
                        "conversation. If you continue, new messages you send will be " +
                        "readable by the server.\n\nSend unencrypted from now on?",
                )
                .setPositiveButton("Send unencrypted") { _, _ ->
                    run(call) {
                        engine().confirmPeerDowngrade(conversationId, true)
                        resolveJson(call, "null")
                    }
                }
                .setNegativeButton("Keep encrypted") { _, _ ->
                    run(call) {
                        engine().confirmPeerDowngrade(conversationId, false)
                        resolveJson(call, "null")
                    }
                }
                .setOnCancelListener {
                    run(call) {
                        engine().confirmPeerDowngrade(conversationId, false)
                        resolveJson(call, "null")
                    }
                }
                .show()
        }
    }

    // ================================================================
    // Key backup & recovery (slice 5.5)
    //
    // The recovery CODE is the one secret that must reach a UI surface. On
    // Android there is NO webview in this path (design §7.2): the code is
    // minted/entered in a BLOCKING NATIVE `AlertDialog` owned by this plugin —
    // exactly the wipe/downgrade trust pattern. The engine returns the code to
    // THIS native code (Rust ↔ Kotlin, both installer-bundled and signed —
    // same trust class); the plugin displays it and forwards ONLY the opaque
    // ciphertext bundle (create/rotate) or the post-restore republish payload
    // (restore) to the webview courier, which PUT/GETs it like any envelope.
    // The webview can REQUEST these flows and nothing else — it never sees the
    // code in either direction.
    // ================================================================

    /**
     * Copy the recovery code to the OS clipboard at the user's explicit
     * request. Flagged sensitive (`IS_SENSITIVE`, honored on Android 13+) so
     * the system suppresses the clipboard-content toast/preview; the same
     * exposure Signal accepts and documents (design §7.2). Older platforms
     * ignore the extra harmlessly.
     *
     * The clipboard is shared with the remote (`app.sloga.gg`) WebView, but
     * Android WebView denies JS clipboard-READ by default and the app installs
     * NO `WebChromeClient.onPermissionRequest` override that grants it — so a
     * compromised remote page cannot `navigator.clipboard.readText()` the code
     * back to the server. Keeping clipboard-read denied is a REQUIRED control
     * for this affordance (gate LOW).
     */
    private fun copyCodeToClipboard(code: String) {
        val clipboard =
            activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = ClipData.newPlainText("Sloga recovery code", code)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            clip.description.extras =
                PersistableBundle().apply {
                    putBoolean("android.content.extra.IS_SENSITIVE", true)
                }
        }
        clipboard.setPrimaryClip(clip)
    }

    /**
     * CREATE a recovery code + first backup. Mirrors desktop
     * `e2ee_recovery_create`: the code is minted natively (a multi-second
     * Argon2id runs off the UI thread), shown once in a native dialog with a
     * copy affordance, and on acknowledgement ONLY the opaque ciphertext
     * bundle is returned to the webview for `PUT /e2ee/backup`.
     */
    @PluginMethod
    fun backupCreate(call: PluginCall) {
        val userId = call.getString("userId") ?: run {
            call.reject("{\"type\":\"invalid_argument\",\"field\":\"userId\"}")
            return
        }
        mintAndShowCode(call, userId, rotate = false)
    }

    /**
     * ROTATE the recovery code (mint a new one; the generation counter
     * continues, never resets). Re-auth is enforced in the UI, like the wipe
     * flow. Same native-display path as [backupCreate].
     */
    @PluginMethod
    fun backupRotate(call: PluginCall) {
        val userId = call.getString("userId") ?: run {
            call.reject("{\"type\":\"invalid_argument\",\"field\":\"userId\"}")
            return
        }
        mintAndShowCode(call, userId, rotate = true)
    }

    private fun mintAndShowCode(call: PluginCall, userId: String, rotate: Boolean) {
        // Argon2id (64 MiB) runs on the executor, never the UI thread.
        executor.execute {
            try {
                val json =
                    if (rotate) engine().backupRotate(userId) else engine().backupCreate(userId)
                val creation = org.json.JSONObject(json)
                val code = creation.getString("code")
                val bundle = creation.getJSONObject("bundle")
                val truncated = bundle.optBoolean("truncated", false)
                // The code is displayed natively; only `bundle` (opaque
                // ciphertext) is ever handed back to the webview. A fresh
                // CREATE that the user cancels rolls the just-minted local
                // state back (see rollbackOnCancel) so the settings card never
                // shows a phantom "backed up" state for a code the user never
                // saved. ROTATE cannot cleanly roll back (the prior key is gone
                // once a new one is minted) and matches desktop's window-close
                // semantics — an accepted §4.5/§8 durability residual.
                activity.runOnUiThread {
                    showRecoveryCodeDialog(
                        call,
                        code,
                        bundle.toString(),
                        truncated,
                        rollbackOnCancel = !rotate,
                    )
                }
            } catch (error: Throwable) {
                rejectScrubbed(call, error)
            }
        }
    }

    private fun dpToPx(dp: Int): Int =
        (dp * activity.resources.displayMetrics.density).toInt()

    /** Exclude the window's surface from screenshots / screen recording / the
     *  recents (app-switcher) snapshot — the recovery code must never be
     *  cached to disk or captured off-screen (gate MEDIUM; design §7.1's
     *  "never persisted on device" property).
     *
     *  Must be re-asserted from `setOnShowListener` (not only before `show()`):
     *  on-device (Retroid, Android 13) a pre-attach `setFlags` did NOT propagate
     *  to the live window — dumpsys showed no FLAG_SECURE and `screencap` still
     *  captured the code. Applying it once the window is attached makes it stick.
     *  Called in BOTH spots (belt-and-suspenders) so OEMs where the early call
     *  works have no unprotected first frame. Idempotent. */
    private fun secureWindow(dialog: AlertDialog) {
        dialog.window?.setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE,
        )
    }

    private fun showRecoveryCodeDialog(
        call: PluginCall,
        code: String,
        bundleJson: String,
        truncated: Boolean,
        rollbackOnCancel: Boolean,
    ) {
        val pad = dpToPx(24)
        val layout =
            LinearLayout(activity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(pad, pad, pad, dpToPx(8))
            }
        val warning =
            TextView(activity).apply {
                text =
                    "Save this recovery code somewhere safe. It is shown only once. " +
                        "Anyone with this code and access to your account can read your " +
                        "message history — and Sloga cannot recover it for you." +
                        if (truncated) {
                            "\n\nYour history is large, so the oldest messages will not be " +
                                "included in this backup."
                        } else {
                            ""
                        }
                setPadding(0, 0, 0, dpToPx(16))
            }
        val codeView =
            TextView(activity).apply {
                text = code
                typeface = Typeface.MONOSPACE
                textSize = 18f
                // Deliberately NOT selectable: text selection exposes a
                // "Share" action-mode that would route the code to an
                // arbitrary app, bypassing the sanctioned Copy path (gate
                // MEDIUM). Copy is the only export affordance.
            }
        layout.addView(warning)
        layout.addView(codeView)

        val cancel: () -> Unit = {
            if (rollbackOnCancel) {
                // Undo the just-minted local backup_state (there was no prior
                // backup on the create path — the card only offers Create when
                // none exists), so a cancel leaves NO phantom backup.
                executor.execute {
                    try {
                        engine().backupForgetLocal()
                    } catch (error: Throwable) {
                        // Best-effort; a lingering local row only over-nags.
                    }
                    call.reject("{\"type\":\"declined\"}")
                }
            } else {
                call.reject("{\"type\":\"declined\"}")
            }
        }

        val dialog =
            AlertDialog.Builder(activity)
                .setTitle("Your recovery code")
                .setView(layout)
                .setCancelable(false)
                // Neutral "Copy" must NOT dismiss the dialog — overridden below.
                .setNeutralButton("Copy", null)
                .setPositiveButton("I've saved it") { _, _ ->
                    resolveJson(call, bundleJson)
                }
                .setNegativeButton("Cancel") { _, _ -> cancel() }
                .create()
        secureWindow(dialog)
        dialog.setOnShowListener {
            // Re-assert once the window is attached — the pre-show call does not
            // stick on all OEMs (see secureWindow).
            secureWindow(dialog)
            dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener {
                copyCodeToClipboard(code)
            }
        }
        dialog.show()
    }

    /**
     * RESTORE from the account's backup blobs using the code the user types
     * into a native dialog. Mirrors desktop `e2ee_recovery_restore`: the
     * webview has already fetched the opaque blobs (MFA-ticketed) and passes
     * them down as JSON; the code is entered natively and never leaves this
     * process. On success the store is rebuilt atomically under a fresh
     * Keystore-wrapped master and the post-restore republish payload (fresh
     * OTKs) is returned for the webview to `PUT /e2ee/keys`
     * (`replace_one_time_keys`). A wrong code keeps the dialog open to retry.
     */
    @PluginMethod
    fun backupRestore(call: PluginCall) {
        val userId = call.getString("userId") ?: run {
            call.reject("{\"type\":\"invalid_argument\",\"field\":\"userId\"}")
            return
        }
        val blobsJson = call.getString("blobsJson") ?: run {
            call.reject("{\"type\":\"invalid_argument\",\"field\":\"blobs\"}")
            return
        }
        activity.runOnUiThread { showRestoreDialog(call, userId, blobsJson) }
    }

    private fun showRestoreDialog(call: PluginCall, userId: String, blobsJson: String) {
        val pad = dpToPx(24)
        val layout =
            LinearLayout(activity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(pad, pad, pad, dpToPx(8))
            }
        val prompt =
            TextView(activity).apply {
                text =
                    "Enter your recovery code to restore your encrypted message history " +
                        "on this device."
                setPadding(0, 0, 0, dpToPx(16))
            }
        val input =
            EditText(activity).apply {
                hint = "XXXXX-XXXXX-…"
                // Visible-password variation: shows the code so the user can
                // verify it while typing, but keeps it out of the IME's
                // learned dictionary / autofill / keystroke history (gate
                // MEDIUM), and upper-cased single-line for a Crockford code.
                inputType =
                    InputType.TYPE_CLASS_TEXT or
                        InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD or
                        InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
                setSingleLine(true)
            }
        val errorView =
            TextView(activity).apply {
                visibility = View.GONE
                setPadding(0, dpToPx(8), 0, 0)
            }
        layout.addView(prompt)
        layout.addView(input)
        layout.addView(errorView)

        val dialog =
            AlertDialog.Builder(activity)
                .setTitle("Restore from recovery code")
                .setView(layout)
                .setCancelable(false)
                // Positive action overridden so a wrong code does NOT dismiss.
                .setPositiveButton("Restore", null)
                .setNegativeButton("Cancel") { _, _ -> call.reject("{\"type\":\"declined\"}") }
                .create()
        secureWindow(dialog)
        dialog.setOnShowListener {
            // Re-assert once the window is attached — the pre-show call does not
            // stick on all OEMs (see secureWindow).
            secureWindow(dialog)
            val restoreButton = dialog.getButton(AlertDialog.BUTTON_POSITIVE)
            restoreButton.setOnClickListener {
                val code = input.text.toString()
                if (code.isBlank()) {
                    errorView.text = "Enter your recovery code."
                    errorView.visibility = View.VISIBLE
                    return@setOnClickListener
                }
                restoreButton.isEnabled = false
                errorView.visibility = View.GONE
                // Restore runs Argon2id per blob — off the UI thread.
                executor.execute {
                    try {
                        // Rebuild the store (also re-wraps a fresh master via
                        // the Keystore protector) and open the engine on it.
                        engine().restore(userId, blobsJson, code)
                        // Mint fresh OTKs + fallback for the webview to publish.
                        val republishJson = engine().postRestoreRekey()
                        activity.runOnUiThread { dialog.dismiss() }
                        resolveJson(call, republishJson)
                    } catch (error: E2eeException) {
                        val type = errorType(error.message)
                        if (type == "backup_code_mismatch") {
                            // The one "try again" signal — keep the dialog open.
                            activity.runOnUiThread {
                                errorView.text =
                                    "That code didn't match. Check it and try again."
                                errorView.visibility = View.VISIBLE
                                restoreButton.isEnabled = true
                            }
                        } else {
                            activity.runOnUiThread { dialog.dismiss() }
                            rejectScrubbed(call, error)
                        }
                    } catch (error: Throwable) {
                        activity.runOnUiThread { dialog.dismiss() }
                        rejectScrubbed(call, error)
                    }
                }
            }
        }
        dialog.show()
    }

    /** Parse the `type` tag out of a core error's scrubbed JSON message. */
    private fun errorType(message: String?): String {
        if (message == null || !message.startsWith("{")) return ""
        return try {
            org.json.JSONObject(message).optString("type", "")
        } catch (error: Exception) {
            ""
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
