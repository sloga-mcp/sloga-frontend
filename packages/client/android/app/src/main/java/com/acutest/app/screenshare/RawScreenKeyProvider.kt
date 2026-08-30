package com.acutest.app.screenshare

import io.livekit.android.e2ee.KeyProvider
import livekit.org.webrtc.FrameCryptorFactory
import livekit.org.webrtc.FrameCryptorKeyDerivationAlgorithm
import livekit.org.webrtc.FrameCryptorKeyProvider

/**
 * Raw-byte key provider for the screen leg's send key (plan §4.3 step 2).
 *
 * The SDK's `BaseKeyProvider.setKey(key: String, …)` takes UTF-8 TEXT and is
 * useless for HKDF material — but the `KeyProvider` INTERFACE is public, so
 * this implements its own provider whose [setRawKey] feeds the 32 raw bytes
 * straight into `FrameCryptorKeyProvider.setKey(participantId, index, bytes)`
 * (probe (a): no fork needed for installs). [getLatestKeyIndex] is consulted
 * by `E2EEManager` when a sender cryptor is CREATED, so tracking the index
 * here fixes the at-creation and at-reconnect index for free; only the
 * MID-STREAM switch needs the cryptor-handle `setKeyIndex` (§0-R.6, done by
 * the plugin).
 *
 * Options mirror the WebView's `MlsKeyProvider` (`rtc/mlsCallKeys.ts` header)
 * plus the fail-closed frame discard:
 *  - `sharedKey = false` — per-participant keys;
 *  - `ratchetWindowSize = 0`, `failureTolerance = 0` — LiveKit's sframe
 *    self-ratchet disabled; MLS epochs are the ONLY rotation mechanism, so a
 *    ratcheted key can never diverge from MLS-derived truth;
 *  - `keyRingSize = 16` — matches `key_index = epoch % 16`;
 *  - `discardFrameWhenCryptorNotReady = true` — nothing leaves the phone
 *    before the sender cryptor holds a key (probe (c-i): zero frames, not
 *    plaintext, with no key installed);
 *  - `keyDerivationAlgorithm = HKDF` — 🔴 the SDK DEFAULT IS PBKDF2 (probe
 *    (c) plan correction): without this, sender and receivers derive
 *    different AES keys from identical material and every frame drops.
 *
 * The ratchet salt and magic bytes stay the SDK/worker defaults
 * (`LKFrameEncryptionKey` / `LK-ROCKS`) — the JS receiver's worker uses the
 * same fixed public salt.
 */
class RawScreenKeyProvider : KeyProvider {

    private val latestSetIndex = mutableMapOf<String, Int>()

    /** Per-participant keys only — shared-key mode is never used. */
    override var enableSharedKey: Boolean = false

    override val rtcKeyProvider: FrameCryptorKeyProvider =
        FrameCryptorFactory.createFrameCryptorKeyProvider(
            /* sharedKey = */ false,
            /* ratchetSalt = */ "LKFrameEncryptionKey".toByteArray(),
            /* ratchetWindowSize = */ 0,
            /* uncryptedMagicBytes = */ "LK-ROCKS".toByteArray(),
            /* failureTolerance = */ 0,
            /* keyRingSize = */ 16,
            /* discardFrameWhenCryptorNotReady = */ true,
            FrameCryptorKeyDerivationAlgorithm.HKDF,
        )

    /** Install raw HKDF material at (participant, index). */
    fun setRawKey(participantId: String, keyIndex: Int, key: ByteArray) {
        latestSetIndex[participantId] = keyIndex
        if (!rtcKeyProvider.setKey(participantId, keyIndex, key)) {
            throw IllegalStateException("native key install refused")
        }
    }

    /** Drop the native keyring (§4.2 hygiene) — called on leg teardown. */
    fun dispose() {
        latestSetIndex.clear()
        rtcKeyProvider.dispose()
    }

    override fun getLatestKeyIndex(participantId: String): Int =
        latestSetIndex[participantId] ?: 0

    // The string-key surface exists only to satisfy the interface; the leg
    // never installs text keys and never uses shared-key mode. Deliberately
    // inert rather than throwing: the SDK consults some of these on paths we
    // do not control, and a fail here must not take the WebView call with it.
    override fun setSharedKey(key: String, keyIndex: Int?): Boolean = false

    override fun ratchetSharedKey(keyIndex: Int?): ByteArray = ByteArray(0)

    override fun exportSharedKey(keyIndex: Int?): ByteArray = ByteArray(0)

    override fun setKey(key: String, participantId: String?, keyIndex: Int?) {
        // Raw material only — see setRawKey. A silent text-key install would
        // be a wrong-key share, which reads on viewers as the loud path.
    }

    override fun ratchetKey(participantId: String, keyIndex: Int?): ByteArray = ByteArray(0)

    override fun exportKey(participantId: String, keyIndex: Int?): ByteArray = ByteArray(0)

    override fun setSifTrailer(trailer: ByteArray) {
        rtcKeyProvider.setSifTrailer(trailer)
    }
}
