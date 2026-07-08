package com.acutest.app.e2ee

import android.app.KeyguardManager
import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import uniffi.acutest_e2ee.KeyProtector
import uniffi.acutest_e2ee.ProtectorException

/**
 * Android Keystore key protector — the Keystore analog of the desktop DPAPI
 * protector (`acutest-desktop/src-tauri/src/dpapi.rs`).
 *
 * Wraps the E2EE master storage key with an AES-256-GCM key that RESIDES in
 * the Android Keystore (non-exportable; hardware-backed where the device
 * supports it). The wrapped blob only unwraps on this device for this app —
 * protection against offline storage access and other apps; NOT against
 * code running inside this app's sandbox (that boundary is the OS's, same
 * stance as DPAPI user scope). The AAD namespaces the blob to this
 * application's E2EE master key, mirroring the DPAPI entropy string.
 *
 * Fail closed (core contract): any Keystore failure — missing alias on
 * unwrap, GCM tag mismatch, malformed blob — throws, the store is not
 * opened, and NOTHING is silently regenerated (a regenerated wrapping key
 * would permanently orphan the encrypted store). The wrapping key is only
 * ever created inside [protect], never on the unwrap path.
 *
 * Failure surfaces as `ProtectorException.Failed`, which carries NO detail
 * — the Rust adapter collapses every foreign failure to the core's scrubbed
 * `Error::Protector` anyway, and no Keystore exception detail (which we
 * cannot vet) leaves this class. (This is a NON-flat uniffi error: a flat
 * error thrown from a foreign callback aborts the process with "Can't lift
 * flat errors" — found on device, slice-4.)
 *
 * `context` is needed only to detect a secure lock screen (see the key-gen
 * hardening); no persistent state is held.
 */
class KeystoreProtector(private val context: Context) : KeyProtector {
    private companion object {
        const val ALIAS = "acutest-e2ee-master-wrap-v1"
        const val AAD = "acutest:e2ee:master-key:v1"
        const val VERSION: Byte = 1
        const val GCM_TAG_BITS = 128
    }

    private fun protectorError(): ProtectorException = ProtectorException.Failed()

    /**
     * The Keystore-resident wrapping key. Created ONLY when
     * [createIfMissing] (the protect path); the unwrap path treats absence
     * as a hard failure.
     */
    private fun wrappingKey(createIfMissing: Boolean): SecretKey {
        val keystore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keystore.getKey(ALIAS, null) as? SecretKey)?.let { return it }

        if (!createIfMissing) throw protectorError()

        val generator =
            KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")

        // Prefer StrongBox (dedicated secure element) where present; fall
        // back to the TEE-backed key on devices without it (API 28+).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try {
                generator.init(buildSpec(strongBox = true))
                return generator.generateKey()
            } catch (e: Exception) {
                // No StrongBox on this device — fall through to TEE
            }
        }
        generator.init(buildSpec(strongBox = false))
        return generator.generateKey()
    }

    private fun buildSpec(strongBox: Boolean): KeyGenParameterSpec {
        val builder =
            KeyGenParameterSpec.Builder(
                ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                // Fresh random IV per protect(), enforced by the Keystore
                .setRandomizedEncryptionRequired(true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            // Narrow the stolen-locked-device window: unwrap only while the
            // device is unlocked (gate LOW #5). ONLY when a secure lock
            // screen exists — without one, Keystore has no per-user key to
            // gate on and key generation hard-fails ("User ECDH key missing",
            // found on a device with no PIN/pattern). No lock screen ⇒ the
            // "locked" state never occurs anyway, so nothing is lost.
            val keyguard = context.getSystemService(KeyguardManager::class.java)
            if (keyguard?.isDeviceSecure == true) {
                builder.setUnlockedDeviceRequired(true)
            }
            if (strongBox) builder.setIsStrongBoxBacked(true)
        }
        return builder.build()
    }

    /**
     * Blob layout: version byte | IV length byte | IV | GCM ciphertext+tag.
     *
     * Best-effort zeroization (gate LOW #4): the master-key plaintext is a
     * GC-managed `ByteArray` that the JVM may relocate before we wipe it,
     * so this narrows but cannot eliminate heap exposure — a residual
     * inherent to the Java Keystore API (the Rust core zeroizes its own
     * copy). On a non-debuggable release build (gate HIGH #1, now fixed)
     * heap access already implies root/instrumentation.
     */
    override fun protect(plaintext: ByteArray): ByteArray {
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, wrappingKey(createIfMissing = true))
            cipher.updateAAD(AAD.toByteArray(Charsets.UTF_8))
            val ciphertext = cipher.doFinal(plaintext)
            val iv = cipher.iv
            return byteArrayOf(VERSION, iv.size.toByte()) + iv + ciphertext
        } catch (e: ProtectorException) {
            throw e
        } catch (e: Exception) {
            throw protectorError()
        } finally {
            // Wipe the caller's plaintext copy; the core hands us an owned
            // buffer (uniffi ByteArray) it no longer needs after this call.
            plaintext.fill(0)
        }
    }

    override fun unprotect(blob: ByteArray): ByteArray {
        try {
            if (blob.size < 3 || blob[0] != VERSION) throw protectorError()
            val ivLength = blob[1].toInt()
            if (ivLength < 12 || ivLength > 16 || blob.size <= 2 + ivLength) {
                throw protectorError()
            }
            val iv = blob.copyOfRange(2, 2 + ivLength)
            val ciphertext = blob.copyOfRange(2 + ivLength, blob.size)

            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(
                Cipher.DECRYPT_MODE,
                wrappingKey(createIfMissing = false),
                GCMParameterSpec(GCM_TAG_BITS, iv),
            )
            cipher.updateAAD(AAD.toByteArray(Charsets.UTF_8))
            // The unwrapped master key crosses back to the core, which
            // zeroizes it; this returned copy is the caller's to consume.
            return cipher.doFinal(ciphertext)
        } catch (e: ProtectorException) {
            throw e
        } catch (e: Exception) {
            // Includes AEADBadTagException (tampered blob) — fail closed
            throw protectorError()
        }
    }

    /**
     * Delete the Keystore wrapping-key entry (hygiene, gate LOW #6). Called
     * from the wipe success path AFTER the core has destroyed the store the
     * key wrapped — the orphaned alias protects nothing, but leaving it
     * would silently reuse it on re-enable. Best-effort: a failure here
     * cannot un-wipe anything.
     */
    fun deleteWrappingKey() {
        try {
            KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(ALIAS)
        } catch (e: Exception) {
            // Nothing to protect; a lingering unused alias is harmless
        }
    }
}
