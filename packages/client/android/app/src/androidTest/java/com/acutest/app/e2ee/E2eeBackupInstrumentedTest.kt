package com.acutest.app.e2ee

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import uniffi.acutest_e2ee.E2eeEngine
import uniffi.acutest_e2ee.E2eeException
import uniffi.acutest_e2ee.KeyProtector
import uniffi.acutest_e2ee.ProtectorException

/**
 * ON-DEVICE smoke test for the E2EE native layer, with the slice-5.5 key
 * backup surface. Host tests (the `e2ee-android` `tests/binding.rs` suite)
 * cover the JSON boundary with a stand-in protector, but two failure classes
 * are INVISIBLE to them and only appear on a real device/emulator — the
 * slice-4 lesson:
 *
 *  1. uniffi FFI-lift aborts ("Can't lift flat errors") — only reproduce when
 *     a foreign callback (the Keystore protector) actually crosses JNI.
 *  2. Android Keystore key-generation policy failures (e.g. the missing
 *     lock-screen "User ECDH key missing").
 *
 * These tests run the REAL `KeystoreProtector` across the real JNI/uniffi
 * boundary and exercise the new backup FFI (a real 64 MiB Argon2id, and the
 * restore re-wrap that mints a fresh master through the Keystore).
 */
@RunWith(AndroidJUnit4::class)
class E2eeBackupInstrumentedTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val dirs = mutableListOf<File>()

    private fun freshEngine(name: String): E2eeEngine {
        val dir = File(context.filesDir, "e2ee-test-$name-${System.nanoTime()}")
        dir.deleteRecursively()
        dir.mkdirs()
        dirs.add(dir)
        return E2eeEngine(dir.absolutePath, KeystoreProtector(context))
    }

    private fun blobsJson(bundle: JSONObject): String =
        JSONArray()
            .put(
                JSONObject()
                    .put("header", bundle.getString("header"))
                    .put("ciphertext", bundle.getString("ciphertext"))
                    .put("server_generation", bundle.getLong("generation")),
            )
            .toString()

    @After
    fun cleanup() {
        dirs.forEach { it.deleteRecursively() }
        // Drop the shared Keystore wrapping key so a rerun starts clean.
        KeystoreProtector(context).deleteWrappingKey()
    }

    /**
     * Native `.so` loads, the real Keystore protector protects (the key-
     * creation path), and provisioning crosses the uniffi boundary without the
     * "Can't lift flat errors" abort.
     */
    @Test
    fun nativeLibLoadsAndKeystoreProtectorProvisions() {
        val engine = freshEngine("provision")
        val payload = JSONObject(engine.enable())
        assertEquals(1, payload.getInt("protocol_version"))
        assertEquals(32, payload.getString("device_id").length)

        val status = JSONObject(engine.status())
        assertTrue(status.getBoolean("enabled"))

        // The master was wrapped THROUGH the Keystore (not written raw).
        val master = dirs.first().resolve("master.key")
        assertTrue(master.exists())
    }

    /**
     * Full backup → restore round-trip on device: `backup_create` runs a real
     * 64 MiB Argon2id and returns the code + opaque ciphertext bundle; restore
     * mints a FRESH master, re-wraps it through the real Keystore, and rebuilds
     * the store. Same blob format the desktop shell produces, so a desktop-made
     * backup restores here and an Android-made one restores on desktop.
     */
    @Test
    fun backupCreateAndRestoreRoundTripOnDevice() {
        val source = freshEngine("src")
        val sourceDeviceId = JSONObject(source.enable()).getString("device_id")

        val creation = JSONObject(source.backupCreate("UDEVICE"))
        val code = creation.getString("code")
        assertEquals(60, code.count { it != '-' })
        val bundle = creation.getJSONObject("bundle")
        // Android profile → 64 MiB (65536 KiB) Argon2id in the header.
        assertTrue(bundle.getString("header").contains("65536"))
        // The code must NOT leak into the webview-couriered ciphertext bundle.
        assertFalse(bundle.toString().contains(code))
        val generation = bundle.getLong("generation")

        // Fresh device (new dir): restore over the FFI with the entered code.
        val target = freshEngine("dst")
        val report = JSONObject(target.restore("UDEVICE", blobsJson(bundle), code))
        assertEquals(sourceDeviceId, report.getString("device_id"))
        assertEquals(generation, report.getLong("generation"))

        // Same identity restored; the engine is live and can mint fresh OTKs.
        val status = JSONObject(target.status())
        assertTrue(status.getBoolean("enabled"))
        assertEquals(sourceDeviceId, status.getString("device_id"))
        val republish = JSONObject(target.postRestoreRekey())
        assertTrue(republish.getJSONArray("one_time_keys").length() > 0)

        // Store rebuilt under a fresh master; no restore marker lingers.
        assertTrue(dirs.last().resolve("store.db").exists())
        assertTrue(dirs.last().resolve("master.key").exists())
        assertFalse(dirs.last().resolve("restore.pending").exists())
    }

    /**
     * A wrong code is the single "try again" signal: a typed, scrubbed error
     * crosses the FFI (never an abort), and no partial store is left behind.
     */
    @Test
    fun restoreWithWrongCodeFailsCleanOnDevice() {
        val source = freshEngine("wc-src")
        source.enable()
        val bundle = JSONObject(source.backupCreate("UDEVICE")).getJSONObject("bundle")

        val target = freshEngine("wc-dst")
        val wrong = "00000-00000-00000-00000-00000-00000-00000-00000-00000-00000-00000-00000"
        try {
            target.restore("UDEVICE", blobsJson(bundle), wrong)
            fail("wrong code must not restore")
        } catch (error: E2eeException) {
            assertEquals("backup_code_mismatch", JSONObject(error.message!!).getString("type"))
        }
        assertFalse(dirs.last().resolve("store.db").exists())
        assertFalse(dirs.last().resolve("master.key").exists())
    }

    /**
     * A FOREIGN protector that fails during the restore RE-WRAP crosses the
     * uniffi callback boundary (Kotlin → Rust) — the exact FFI-LIFT path that
     * aborted the process in slice-4 ("Can't lift flat errors") and is
     * invisible to host tests. With the correct non-flat `ProtectorException`,
     * a valid code that gets past the AEAD but hits a failing `protect()` on
     * the fresh master must surface a TYPED `protector` error (never an abort)
     * and leave no partial store.
     */
    @Test
    fun restoreWithFailingProtectorFailsClosedNoAbortOnDevice() {
        val source = freshEngine("fp-src")
        source.enable()
        val creation = JSONObject(source.backupCreate("UDEVICE"))
        val code = creation.getString("code")
        val bundle = creation.getJSONObject("bundle")

        val failing =
            object : KeyProtector {
                override fun protect(plaintext: ByteArray): ByteArray =
                    throw ProtectorException.Failed()

                override fun unprotect(blob: ByteArray): ByteArray =
                    throw ProtectorException.Failed()
            }
        val dir = File(context.filesDir, "e2ee-test-fp-dst-${System.nanoTime()}")
        dir.deleteRecursively()
        dir.mkdirs()
        dirs.add(dir)
        val target = E2eeEngine(dir.absolutePath, failing)

        try {
            // A VALID code opens the AEAD; the re-wrap `protect()` then throws
            // across the FFI. Must be a clean typed error, not a native abort.
            target.restore("UDEVICE", blobsJson(bundle), code)
            fail("a failing protector must fail the restore")
        } catch (error: E2eeException) {
            assertEquals("protector", JSONObject(error.message!!).getString("type"))
        }
        // No partial store survives the failed re-wrap.
        assertFalse(dir.resolve("store.db").exists())
        assertFalse(dir.resolve("master.key").exists())
        assertFalse(dir.resolve("restore.pending").exists())
    }
}
