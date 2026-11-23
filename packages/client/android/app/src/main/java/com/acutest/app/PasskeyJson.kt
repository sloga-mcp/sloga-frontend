package com.acutest.app

import org.json.JSONException
import org.json.JSONObject

/**
 * The three rebuilds every passkey ceremony goes through (passkeys plan, rule
 * R1). Nothing the webview sent reaches the system as sent, and nothing the
 * system answered reaches the webview as answered: each function parses the
 * text, copies the members on its list into a new object and writes that
 * object out. A member that is not on the list is not copied, whatever it is
 * called, so `extensions` (PRF above all), `hints`, a `publicKey` wrapper or
 * a member invented later never gets through, and neither does a second copy
 * of a member, a comment or trailing text in the original bytes.
 *
 * The two option rebuilds also pin the relying party: the caller names the
 * one relying-party ID this build signs in to, and options for any other are
 * refused. The check reads the rebuilt object, the one that is written out.
 * A future backup-only passkey lives under a different relying-party ID, so
 * a page can never reach it through these functions.
 *
 * Plain String to String with no Android type in sight, so the host JVM tests
 * (PasskeyJsonTest) call them directly.
 */

/**
 * The text was not a JSON object, lacked a required member, or named the
 * wrong relying party. Carries no detail on purpose: the parser's own message
 * quotes its input, which here is passkey options or a credential.
 */
internal class PasskeyJsonException : Exception("malformed passkey JSON")

/** The largest `optionsJson` a ceremony accepts, in UTF-8 bytes (64 KiB). */
internal const val PASSKEY_MAX_OPTIONS_BYTES = 64 * 1024

/** Whether [optionsJson] is within [PASSKEY_MAX_OPTIONS_BYTES] once encoded as UTF-8. */
internal fun passkeyOptionsFit(optionsJson: String): Boolean {
    // Every char encodes to at least one byte, so a longer string cannot fit
    // and is never encoded.
    if (optionsJson.length > PASSKEY_MAX_OPTIONS_BYTES) return false
    return optionsJson.toByteArray(Charsets.UTF_8).size <= PASSKEY_MAX_OPTIONS_BYTES
}

private val CREATE_REQUIRED = listOf("rp", "user", "challenge", "pubKeyCredParams")
private val CREATE_OPTIONAL = listOf("timeout", "excludeCredentials", "authenticatorSelection", "attestation")

private val GET_REQUIRED = listOf("challenge", "rpId")
private val GET_OPTIONAL = listOf("timeout", "allowCredentials", "userVerification")

private val ANSWER_REQUIRED = listOf("id", "type")
private val ANSWER_OPTIONAL = listOf("rawId", "authenticatorAttachment")
private val ANSWER_RESPONSE_OPTIONAL =
    listOf(
        "clientDataJSON",
        "attestationObject",
        "authenticatorData",
        "signature",
        "userHandle",
        "transports",
        "publicKey",
        "publicKeyAlgorithm",
    )

/**
 * WebAuthn creation options rebuilt from `rp`, `user`, `challenge`,
 * `pubKeyCredParams` (all four required), `timeout`, `excludeCredentials`,
 * `authenticatorSelection` and `attestation`, and nothing else. Refused
 * unless `rp` is an object whose `id` is a string equal to [expectedRpId],
 * character for character. An empty [expectedRpId] refuses everything.
 */
@Throws(PasskeyJsonException::class)
internal fun rebuildCreateOptions(optionsJson: String, expectedRpId: String): String {
    if (expectedRpId.isEmpty()) throw PasskeyJsonException()
    val rebuilt = JSONObject()
    copyMembers(parsePasskeyObject(optionsJson), rebuilt, CREATE_REQUIRED, CREATE_OPTIONAL)
    val rp = rebuilt.opt("rp") as? JSONObject ?: throw PasskeyJsonException()
    requirePinnedRpId(rp.opt("id"), expectedRpId)
    return writePasskeyObject(rebuilt)
}

/**
 * WebAuthn request options rebuilt from `challenge`, `rpId` (both required),
 * `timeout`, `allowCredentials` and `userVerification`, and nothing else.
 * Refused unless `rpId` is a string equal to [expectedRpId], character for
 * character. An empty [expectedRpId] refuses everything.
 */
@Throws(PasskeyJsonException::class)
internal fun rebuildGetOptions(optionsJson: String, expectedRpId: String): String {
    if (expectedRpId.isEmpty()) throw PasskeyJsonException()
    val rebuilt = JSONObject()
    copyMembers(parsePasskeyObject(optionsJson), rebuilt, GET_REQUIRED, GET_OPTIONAL)
    requirePinnedRpId(rebuilt.opt("rpId"), expectedRpId)
    return writePasskeyObject(rebuilt)
}

/**
 * A registration or authentication response rebuilt from `id`, `type` (both
 * required), `rawId`, `authenticatorAttachment` and `response` (required, an
 * object), with `response` itself rebuilt from `clientDataJSON`,
 * `attestationObject`, `authenticatorData`, `signature`, `userHandle`,
 * `transports`, `publicKey` and `publicKeyAlgorithm`. `clientExtensionResults`
 * is always the empty object written here: the key stays because the WebAuthn
 * JSON form lists it as required, and what the provider put in it never
 * leaves native code.
 */
@Throws(PasskeyJsonException::class)
internal fun rebuildCredentialResponse(credentialJson: String): String {
    val answer = parsePasskeyObject(credentialJson)
    val response = answer.opt("response") as? JSONObject ?: throw PasskeyJsonException()
    val rebuilt = JSONObject()
    copyMembers(answer, rebuilt, ANSWER_REQUIRED, ANSWER_OPTIONAL)
    val rebuiltResponse = JSONObject()
    copyMembers(response, rebuiltResponse, emptyList(), ANSWER_RESPONSE_OPTIONAL)
    try {
        rebuilt.put("response", rebuiltResponse)
        rebuilt.put("clientExtensionResults", JSONObject())
    } catch (e: JSONException) {
        throw PasskeyJsonException()
    }
    return writePasskeyObject(rebuilt)
}

/**
 * `is String` and not `getString`: the platform's `getString` turns a number
 * or a boolean into text, and a relying-party ID must have been text.
 */
private fun requirePinnedRpId(value: Any?, expectedRpId: String) {
    if (value !is String || value != expectedRpId) throw PasskeyJsonException()
}

/**
 * Copy the named members of [from] into [to]. A [required] member that is
 * absent or JSON null refuses the whole text; an [optional] one is left out.
 */
private fun copyMembers(from: JSONObject, to: JSONObject, required: List<String>, optional: List<String>) {
    try {
        for (name in required) {
            val value = from.opt(name)
            if (value == null || JSONObject.NULL == value) throw PasskeyJsonException()
            to.put(name, value)
        }
        for (name in optional) {
            val value = from.opt(name)
            if (value == null || JSONObject.NULL == value) continue
            to.put(name, value)
        }
    } catch (e: JSONException) {
        throw PasskeyJsonException()
    }
}

private fun parsePasskeyObject(text: String): JSONObject =
    try {
        JSONObject(text)
    } catch (e: JSONException) {
        throw PasskeyJsonException()
    } catch (e: RuntimeException) {
        throw PasskeyJsonException()
    } catch (e: StackOverflowError) {
        // Deeply nested input; the parser recurses.
        throw PasskeyJsonException()
    }

private fun writePasskeyObject(value: JSONObject): String {
    // toString() answers null instead of throwing when a value cannot be
    // written (a non-finite number).
    val text: String? =
        try {
            value.toString()
        } catch (e: RuntimeException) {
            null
        } catch (e: StackOverflowError) {
            null
        }
    return text ?: throw PasskeyJsonException()
}
