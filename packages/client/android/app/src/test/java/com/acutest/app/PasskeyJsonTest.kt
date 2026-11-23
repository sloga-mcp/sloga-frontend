package com.acutest.app

import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialNoCreateOptionException
import androidx.credentials.exceptions.CreateCredentialProviderConfigurationException
import androidx.credentials.exceptions.CreateCredentialUnknownException
import androidx.credentials.exceptions.CreateCredentialUnsupportedException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialProviderConfigurationException
import androidx.credentials.exceptions.GetCredentialUnknownException
import androidx.credentials.exceptions.GetCredentialUnsupportedException
import androidx.credentials.exceptions.NoCredentialException
import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Host tests for rule R1 of the passkeys plan on Android: a sign-in passkey
 * never uses PRF, and a page can only ask for the one relying party the build
 * names. [rebuildCreateOptions] and [rebuildGetOptions] are what the system
 * is handed and [rebuildCredentialResponse] is what the webview gets back;
 * the last tests read the module's sources to pin that PasskeyPlugin has no
 * other route for either, and that nothing else in the app has a route at all.
 *
 * The plugin itself needs an Activity and a Capacitor bridge, neither of
 * which loads on the host JVM. org.json here is the real library
 * (testImplementation), not the throwing android.jar stub.
 */
class PasskeyJsonTest {
    private companion object {
        const val PLUGIN_REL = "src/main/java/com/acutest/app/PasskeyPlugin.kt"
        const val JSON_REL = "src/main/java/com/acutest/app/PasskeyJson.kt"
        const val TEST_REL = "src/test/java/com/acutest/app/PasskeyJsonTest.kt"

        /** The relying-party ID the tests pin to; the build's own value is read from build.gradle. */
        const val RP = "app.sloga.gg"
        const val GOOD_RP = """{"id":"app.sloga.gg","name":"Sloga"}"""

        /** A value that must never appear in any output. */
        const val SECRET = "c2VjcmV0LXByZi1vdXRwdXQ"

        val CREATE_REQUIRED = setOf("rp", "user", "challenge", "pubKeyCredParams")
        val GET_REQUIRED = setOf("challenge", "rpId")

        /** The app module; the unit-test working directory is the module or its parent. */
        val moduleDir: File by lazy {
            val candidates = listOf(File("."), File("app"))
            candidates.firstOrNull { File(it, PLUGIN_REL).isFile }
                ?: throw AssertionError(
                    "PasskeyPlugin.kt not found from ${File(".").absolutePath} (tried $candidates)",
                )
        }

        /** The plugin source. */
        val source: String by lazy { File(moduleDir, PLUGIN_REL).readText() }

        /** The plugin source with all whitespace removed, for calls that span lines. */
        val compact: String by lazy { source.filterNot { it.isWhitespace() } }

        /** Every .kt and .java under app/src/<source set>/java, by path from the module. */
        val sourceFiles: Map<String, String> by lazy {
            val found = sortedMapOf<String, String>()
            val sets = File(moduleDir, "src").listFiles() ?: emptyArray()
            for (set in sets) {
                val root = File(set, "java")
                if (!root.isDirectory) continue
                root.walkTopDown()
                    .filter { it.isFile && (it.extension == "kt" || it.extension == "java") }
                    .forEach { found[it.relativeTo(moduleDir).invariantSeparatorsPath] = it.readText() }
            }
            found
        }

        fun occurrences(haystack: String, needle: String): Int {
            var count = 0
            var at = haystack.indexOf(needle)
            while (at >= 0) {
                count++
                at = haystack.indexOf(needle, at + needle.length)
            }
            return count
        }

        fun assertMalformed(label: String, block: () -> String) {
            try {
                val out = block()
                fail("$label: expected PasskeyJsonException, got output of length ${out.length}")
            } catch (e: PasskeyJsonException) {
                assertEquals("malformed passkey JSON", e.message)
                assertNull("the parser's own error quotes its input and must not be attached", e.cause)
            }
        }

        /** Creation options with [rp] as the raw JSON of `rp` and [extra] appended as further members. */
        fun createJson(rp: String = GOOD_RP, extra: String = ""): String =
            """{"rp":$rp,"user":{"id":"dXNlcg","name":"a","displayName":"A"},"challenge":"Y2hhbGxlbmdl",""" +
                """"pubKeyCredParams":[{"type":"public-key","alg":-7}]$extra}"""

        /** Request options with [rpId] as the raw JSON of `rpId` and [extra] appended as further members. */
        fun getJson(rpId: String = "\"app.sloga.gg\"", extra: String = ""): String =
            """{"challenge":"Y2hhbGxlbmdl","rpId":$rpId$extra}"""

        fun without(json: String, name: String): String {
            val parsed = JSONObject(json)
            assertTrue("$name is in the fixture", parsed.has(name))
            parsed.remove(name)
            return parsed.toString()
        }

        fun withNull(json: String, name: String): String = JSONObject(json).put(name, JSONObject.NULL).toString()
    }

    // ---- creation options: what the system is handed ----

    @Test
    fun createOptionsKeepExactlyTheListedMembers() {
        val out =
            rebuildCreateOptions(
                createJson(
                    extra =
                        ""","timeout":60000,"excludeCredentials":[{"type":"public-key","id":"Y3JlZA"}],""" +
                            """"authenticatorSelection":{"residentKey":"required","userVerification":"required"},""" +
                            """"attestation":"none","extensions":{"prf":{"eval":{"first":"$SECRET"}}},""" +
                            """"hints":["security-key"],"attestationFormats":["packed"]""",
                ),
                RP,
            )
        val parsed = JSONObject(out)
        assertEquals(
            setOf(
                "rp",
                "user",
                "challenge",
                "pubKeyCredParams",
                "timeout",
                "excludeCredentials",
                "authenticatorSelection",
                "attestation",
            ),
            parsed.keySet(),
        )
        assertFalse(out.contains("prf"))
        assertFalse(out.contains(SECRET))
        assertEquals(RP, parsed.getJSONObject("rp").getString("id"))
        assertEquals("Sloga", parsed.getJSONObject("rp").getString("name"))
        assertEquals("dXNlcg", parsed.getJSONObject("user").getString("id"))
        assertEquals("Y2hhbGxlbmdl", parsed.getString("challenge"))
        assertEquals(-7, parsed.getJSONArray("pubKeyCredParams").getJSONObject(0).getInt("alg"))
        assertEquals(60000, parsed.getInt("timeout"))
        assertEquals("Y3JlZA", parsed.getJSONArray("excludeCredentials").getJSONObject(0).getString("id"))
        assertEquals("required", parsed.getJSONObject("authenticatorSelection").getString("residentKey"))
        assertEquals("none", parsed.getString("attestation"))
    }

    @Test
    fun createOptionsDropEveryMemberNotOnTheList() {
        val unknown =
            listOf(
                """"extensions":{"prf":{"eval":{"first":"$SECRET"}}}""",
                """"extensions":{"credProps":true,"largeBlob":{"support":"required"},"hmacCreateSecret":true}""",
                """"extensions":"$SECRET"""",
                """"extensions":null""",
                """"Extensions":{"prf":{"eval":{"first":"$SECRET"}}}""",
                """"EXTENSIONS":{"prf":{}}""",
                """"hints":["security-key"]""",
                """"attestationFormats":["packed"]""",
                """"publicKey":{"extensions":{"prf":{"eval":{"first":"$SECRET"}}}}""",
                """"rpId":"evil.example"""",
                """"allowCredentials":[{"type":"public-key","id":"Y3JlZA"}]""",
                """"userVerification":"required"""",
                """"clientExtensionResults":{"prf":{"results":{"first":"$SECRET"}}}""",
            )
        for (member in unknown) {
            val out = rebuildCreateOptions(createJson(extra = ",$member"), RP)
            assertEquals(member, CREATE_REQUIRED, JSONObject(out).keySet())
            assertFalse(member, out.contains(SECRET))
        }
    }

    @Test
    fun createRefusesARelyingPartyThatIsNotThePinnedOne() {
        val refused =
            listOf(
                // Another host, a parent, a child, and near misses of the right one.
                """{"id":"evil.example"}""",
                """{"id":"sloga.gg"}""",
                """{"id":"x.app.sloga.gg"}""",
                """{"id":"APP.SLOGA.GG"}""",
                """{"id":"App.sloga.gg"}""",
                """{"id":"app.sloga.gg."}""",
                """{"id":" app.sloga.gg"}""",
                """{"id":"app.sloga.gg "}""",
                """{"id":"https://app.sloga.gg"}""",
                """{"id":""}""",
                // No id, or an id that is not text. getString would turn 7 and true into text.
                """{"name":"Sloga"}""",
                """{"ID":"app.sloga.gg"}""",
                """{"id":null}""",
                """{"id":7}""",
                """{"id":true}""",
                """{"id":["app.sloga.gg"]}""",
                """{"id":{"id":"app.sloga.gg"}}""",
                """{}""",
                // An rp that is not an object.
                """"app.sloga.gg"""",
                """[{"id":"app.sloga.gg"}]""",
                """7""",
            )
        for (rp in refused) {
            assertMalformed("rp $rp") { rebuildCreateOptions(createJson(rp = rp), RP) }
        }
    }

    @Test
    fun createRefusesOptionsWrappedUnderPublicKey() {
        val good = createJson()
        assertMalformed("wrapper only") { rebuildCreateOptions("""{"publicKey":$good}""", RP) }
        // The wrapper cannot lend its rp to options that have none of their own.
        assertMalformed("wrapper beside rp-less options") {
            rebuildCreateOptions(without(good, "rp").dropLast(1) + ""","publicKey":$good}""", RP)
        }
        // Request options are not creation options, however right their rpId is.
        assertMalformed("request options") { rebuildCreateOptions(getJson(), RP) }
    }

    @Test
    fun createRefusesAMissingRequiredMember() {
        for (name in CREATE_REQUIRED) {
            assertMalformed("without $name") { rebuildCreateOptions(without(createJson(), name), RP) }
            assertMalformed("null $name") { rebuildCreateOptions(withNull(createJson(), name), RP) }
        }
    }

    // ---- request options: what the system is handed ----

    @Test
    fun getOptionsKeepExactlyTheListedMembers() {
        val out =
            rebuildGetOptions(
                getJson(
                    extra =
                        ""","timeout":60000,"userVerification":"required",""" +
                            """"allowCredentials":[{"type":"public-key","id":"Y3JlZA"}],""" +
                            """"extensions":{"prf":{"evalByCredential":{"Y3JlZA":{"first":"$SECRET"}}}},""" +
                            """"hints":["client-device"]""",
                ),
                RP,
            )
        val parsed = JSONObject(out)
        assertEquals(setOf("challenge", "rpId", "timeout", "allowCredentials", "userVerification"), parsed.keySet())
        assertFalse(out.contains("prf"))
        assertFalse(out.contains(SECRET))
        assertEquals("Y2hhbGxlbmdl", parsed.getString("challenge"))
        assertEquals(RP, parsed.getString("rpId"))
        assertEquals(60000, parsed.getInt("timeout"))
        assertEquals("required", parsed.getString("userVerification"))
        assertEquals("Y3JlZA", parsed.getJSONArray("allowCredentials").getJSONObject(0).getString("id"))
    }

    @Test
    fun getOptionsDropEveryMemberNotOnTheList() {
        val unknown =
            listOf(
                """"extensions":{"prf":{"evalByCredential":{"Y3JlZA":{"first":"$SECRET"}}}}""",
                """"extensions":["$SECRET"]""",
                """"Extensions":{"prf":{"eval":{"first":"$SECRET"}}}""",
                """"hints":["security-key"]""",
                """"publicKey":{"rpId":"evil.example","extensions":{"prf":{}}}""",
                """"rp":{"id":"evil.example"}""",
                """"user":{"id":"dXNlcg"}""",
                """"attestation":"direct"""",
                """"RpId":"evil.example"""",
            )
        for (member in unknown) {
            val out = rebuildGetOptions(getJson(extra = ",$member"), RP)
            assertEquals(member, GET_REQUIRED, JSONObject(out).keySet())
            assertFalse(member, out.contains(SECRET))
            assertFalse(member, out.contains("evil"))
        }
    }

    @Test
    fun getRefusesARelyingPartyThatIsNotThePinnedOne() {
        val refused =
            listOf(
                """"evil.example"""",
                """"sloga.gg"""",
                """"x.app.sloga.gg"""",
                """"APP.SLOGA.GG"""",
                """"App.sloga.gg"""",
                """"app.sloga.gg."""",
                """" app.sloga.gg"""",
                """"https://app.sloga.gg"""",
                "\"\"",
                // Not text. getString would turn 7 and true into text.
                """7""",
                """true""",
                """["app.sloga.gg"]""",
                """{"id":"app.sloga.gg"}""",
            )
        for (rpId in refused) {
            assertMalformed("rpId $rpId") { rebuildGetOptions(getJson(rpId = rpId), RP) }
        }
    }

    @Test
    fun getRefusesOptionsWithoutARelyingParty() {
        assertMalformed("no rpId") { rebuildGetOptions(without(getJson(), "rpId"), RP) }
        assertMalformed("null rpId") { rebuildGetOptions(withNull(getJson(), "rpId"), RP) }
        assertMalformed("another case") { rebuildGetOptions("""{"challenge":"Yw","rpid":"app.sloga.gg"}""", RP) }
        assertMalformed("wrapper only") { rebuildGetOptions("""{"publicKey":${getJson()}}""", RP) }
        assertMalformed("wrapper beside a challenge") {
            rebuildGetOptions("""{"challenge":"Yw","publicKey":${getJson()}}""", RP)
        }
        // Creation options are not request options, however right their rp is.
        assertMalformed("creation options") { rebuildGetOptions(createJson(), RP) }
    }

    @Test
    fun getRefusesAMissingChallenge() {
        assertMalformed("no challenge") { rebuildGetOptions(without(getJson(), "challenge"), RP) }
        assertMalformed("null challenge") { rebuildGetOptions(withNull(getJson(), "challenge"), RP) }
    }

    // ---- the pin itself ----

    @Test
    fun thePinIsTheCallersNotThePages() {
        // The same options pass or fail by the expected ID alone.
        assertEquals(RP, JSONObject(rebuildCreateOptions(createJson(), RP)).getJSONObject("rp").getString("id"))
        assertEquals(RP, JSONObject(rebuildGetOptions(getJson(), RP)).getString("rpId"))
        for (other in listOf("sloga.gg", "backup.sloga.gg", "APP.SLOGA.GG", "app.sloga.gg.")) {
            assertMalformed("create, expecting $other") { rebuildCreateOptions(createJson(), other) }
            assertMalformed("get, expecting $other") { rebuildGetOptions(getJson(), other) }
        }
    }

    @Test
    fun anEmptyPinRefusesEverything() {
        assertMalformed("create, good options") { rebuildCreateOptions(createJson(), "") }
        assertMalformed("get, good options") { rebuildGetOptions(getJson(), "") }
        // Not even options whose relying party is the empty string match it.
        assertMalformed("create, empty rp id") { rebuildCreateOptions(createJson(rp = """{"id":""}"""), "") }
        assertMalformed("get, empty rpId") { rebuildGetOptions(getJson(rpId = "\"\""), "") }
    }

    // ---- the size cap ----

    @Test
    fun optionsFitUpToSixtyFourKibibytesOfUtf8() {
        assertEquals(65536, PASSKEY_MAX_OPTIONS_BYTES)
        assertTrue(passkeyOptionsFit(""))
        assertTrue(passkeyOptionsFit(createJson()))
        assertTrue(passkeyOptionsFit("a".repeat(65536)))
        assertFalse(passkeyOptionsFit("a".repeat(65537)))
        // Bytes, not chars: the euro sign is one char and three bytes.
        val euro = 0x20AC.toChar()
        assertTrue(passkeyOptionsFit(String(CharArray(21845) { euro })))
        assertFalse(passkeyOptionsFit(String(CharArray(21846) { euro })))
    }

    @Test
    fun thePluginChecksTheSizeBeforeItAcceptsARequest() {
        val begin = source.indexOf("private fun begin(call: PluginCall)")
        assertTrue(begin >= 0)
        val read = source.indexOf("call.getString(", begin)
        val check = source.indexOf("if (!passkeyOptionsFit(optionsJson)) {", begin)
        val slot = source.indexOf("inFlight.compareAndSet(false, true)", begin)
        val accept = source.indexOf("Ceremony(call, optionsJson)", begin)
        assertTrue("begin() reads the argument", read > begin)
        assertTrue("begin() checks the size after reading it", check > read)
        assertTrue("the size check comes before the slot is taken", check < slot)
        assertTrue("the size check comes before the request is accepted", check < accept)
        assertEquals(1, occurrences(source, "passkeyOptionsFit("))
        val rejection = source.indexOf("call.reject(\"optionsJson is too large\", PASSKEY_FAILED)", check)
        assertTrue("an oversized argument rejects failed", rejection > check && rejection < slot)
    }

    // ---- answers: what the webview gets back ----

    @Test
    fun aRegistrationAnswerKeepsOnlyTheListedMembers() {
        val out =
            rebuildCredentialResponse(
                """{"id":"Y3JlZA","rawId":"Y3JlZA","type":"public-key","authenticatorAttachment":"platform",""" +
                    """"response":{"clientDataJSON":"Y2Rq","attestationObject":"YXR0","authenticatorData":"YXV0aA",""" +
                    """"transports":["internal","hybrid"],"publicKey":"cGs","publicKeyAlgorithm":-7,""" +
                    """"prf":{"results":{"first":"$SECRET"}},"clientExtensionResults":{"prf":{"enabled":true}}},""" +
                    """"clientExtensionResults":{"prf":{"enabled":true,"results":{"first":"$SECRET"}},"credProps":{"rk":true}},""" +
                    """"prf":{"results":{"first":"$SECRET"}},"extensions":{"prf":{}},"debug":"$SECRET"}""",
            )
        val parsed = JSONObject(out)
        assertEquals(
            setOf("id", "rawId", "type", "authenticatorAttachment", "response", "clientExtensionResults"),
            parsed.keySet(),
        )
        val response = parsed.getJSONObject("response")
        assertEquals(
            setOf(
                "clientDataJSON",
                "attestationObject",
                "authenticatorData",
                "transports",
                "publicKey",
                "publicKeyAlgorithm",
            ),
            response.keySet(),
        )
        assertEquals(0, parsed.getJSONObject("clientExtensionResults").length())
        assertFalse(out.contains(SECRET))
        assertFalse(out.contains("prf"))
        assertFalse(out.contains("credProps"))
        assertEquals("Y3JlZA", parsed.getString("id"))
        assertEquals("Y3JlZA", parsed.getString("rawId"))
        assertEquals("public-key", parsed.getString("type"))
        assertEquals("platform", parsed.getString("authenticatorAttachment"))
        assertEquals("Y2Rq", response.getString("clientDataJSON"))
        assertEquals("YXR0", response.getString("attestationObject"))
        assertEquals("YXV0aA", response.getString("authenticatorData"))
        assertEquals("hybrid", response.getJSONArray("transports").getString(1))
        assertEquals("cGs", response.getString("publicKey"))
        assertEquals(-7, response.getInt("publicKeyAlgorithm"))
    }

    @Test
    fun anAuthenticationAnswerKeepsOnlyTheListedMembers() {
        val out =
            rebuildCredentialResponse(
                """{"id":"Y3JlZA","rawId":"Y3JlZA","type":"public-key",""" +
                    """"response":{"clientDataJSON":"Y2Rq","authenticatorData":"YXV0aA","signature":"c2ln",""" +
                    """"userHandle":"dXNlcg","prfOutput":"$SECRET"},""" +
                    """"clientExtensionResults":{"prf":{"results":{"first":"$SECRET","second":"$SECRET"}}},""" +
                    """"ClientExtensionResults":{"prf":{"results":{"first":"$SECRET"}}}}""",
            )
        val parsed = JSONObject(out)
        assertEquals(setOf("id", "rawId", "type", "response", "clientExtensionResults"), parsed.keySet())
        val response = parsed.getJSONObject("response")
        assertEquals(setOf("clientDataJSON", "authenticatorData", "signature", "userHandle"), response.keySet())
        assertEquals(0, parsed.getJSONObject("clientExtensionResults").length())
        assertFalse(out.contains(SECRET))
        assertFalse(out.contains("prf"))
        assertEquals("Y2Rq", response.getString("clientDataJSON"))
        assertEquals("YXV0aA", response.getString("authenticatorData"))
        assertEquals("c2ln", response.getString("signature"))
        assertEquals("dXNlcg", response.getString("userHandle"))
    }

    @Test
    fun extensionResultsAreAlwaysTheEmptyObjectWrittenHere() {
        val sent =
            listOf(
                "",
                ""","clientExtensionResults":{"prf":{"results":{"first":"$SECRET"}}}""",
                ""","clientExtensionResults":{"prf":{"enabled":true},"credProps":{"rk":true}}""",
                ""","clientExtensionResults":"$SECRET"""",
                ""","clientExtensionResults":["$SECRET"]""",
                ""","clientExtensionResults":null""",
                ""","clientExtensionResults":{}""",
            )
        for (member in sent) {
            val out = rebuildCredentialResponse("""{"id":"Yw","type":"public-key","response":{}$member}""")
            val parsed = JSONObject(out)
            assertTrue(member, parsed.has("clientExtensionResults"))
            assertEquals(member, 0, parsed.getJSONObject("clientExtensionResults").length())
            assertEquals(member, setOf("id", "type", "response", "clientExtensionResults"), parsed.keySet())
            assertFalse(member, out.contains(SECRET))
        }
    }

    @Test
    fun anAnswerMissingARequiredMemberIsRefused() {
        val good = """{"id":"Yw","type":"public-key","response":{"clientDataJSON":"Y2Rq"}}"""
        assertEquals("Y2Rq", JSONObject(rebuildCredentialResponse(good)).getJSONObject("response").getString("clientDataJSON"))
        for (name in listOf("id", "type", "response")) {
            assertMalformed("without $name") { rebuildCredentialResponse(without(good, name)) }
            assertMalformed("null $name") { rebuildCredentialResponse(withNull(good, name)) }
        }
        for (response in listOf("\"Y2Rq\"", "[{\"clientDataJSON\":\"Y2Rq\"}]", "7", "true")) {
            assertMalformed("response $response") {
                rebuildCredentialResponse("""{"id":"Yw","type":"public-key","response":$response}""")
            }
        }
    }

    // ---- malformed input ----

    @Test
    fun malformedOptionsAreRefused() {
        for (text in listOf("", "   ", "not json", "{\"challenge\":", "[1,2]", "null", "\"text\"", "42", "{\"a\":1", "{}")) {
            assertMalformed("create '$text'") { rebuildCreateOptions(text, RP) }
            assertMalformed("get '$text'") { rebuildGetOptions(text, RP) }
        }
        // An array of good options is still not an object.
        assertMalformed("create array") { rebuildCreateOptions("[${createJson()}]", RP) }
        assertMalformed("get array") { rebuildGetOptions("[${getJson()}]", RP) }
    }

    @Test
    fun malformedAnswersAreRefused() {
        for (text in listOf("", "not json", "{\"id\":", "[{\"clientExtensionResults\":{}}]", "null", "{}")) {
            assertMalformed("answer '$text'") { rebuildCredentialResponse(text) }
        }
    }

    @Test
    fun theRefusalNeverQuotesItsInput() {
        val refusals =
            listOf<() -> String>(
                // Not JSON.
                { rebuildCreateOptions("{\"challenge\":\"$SECRET\",", RP) },
                { rebuildGetOptions("{\"challenge\":\"$SECRET\",", RP) },
                { rebuildCredentialResponse("{\"id\":\"$SECRET\",") },
                // The wrong relying party.
                { rebuildCreateOptions(createJson(rp = """{"id":"$SECRET"}"""), RP) },
                { rebuildGetOptions(getJson(rpId = "\"$SECRET\""), RP) },
                // A missing member.
                { rebuildCreateOptions("""{"rp":$GOOD_RP,"challenge":"$SECRET"}""", RP) },
                { rebuildGetOptions("""{"challenge":"$SECRET"}""", RP) },
                { rebuildCredentialResponse("""{"id":"$SECRET","response":{}}""") },
            )
        for ((index, refusal) in refusals.withIndex()) {
            try {
                refusal()
                fail("refusal $index: expected PasskeyJsonException")
            } catch (e: PasskeyJsonException) {
                assertFalse("refusal $index", e.toString().contains(SECRET))
                assertEquals("refusal $index", "malformed passkey JSON", e.message)
                assertNull("refusal $index", e.cause)
            }
        }
    }

    // ---- rejection codes ----

    @Test
    fun createErrorsMapToTheStableCodes() {
        assertEquals("cancelled", passkeyCreateErrorCode(CreateCredentialCancellationException()))
        assertEquals("unavailable", passkeyCreateErrorCode(CreateCredentialNoCreateOptionException()))
        assertEquals("unavailable", passkeyCreateErrorCode(CreateCredentialProviderConfigurationException()))
        assertEquals("unavailable", passkeyCreateErrorCode(CreateCredentialUnsupportedException()))
        assertEquals("failed", passkeyCreateErrorCode(CreateCredentialUnknownException()))
    }

    @Test
    fun getErrorsMapToTheStableCodes() {
        assertEquals("cancelled", passkeyGetErrorCode(GetCredentialCancellationException()))
        assertEquals("no_credential", passkeyGetErrorCode(NoCredentialException()))
        assertEquals("unavailable", passkeyGetErrorCode(GetCredentialProviderConfigurationException()))
        assertEquals("unavailable", passkeyGetErrorCode(GetCredentialUnsupportedException()))
        assertEquals("failed", passkeyGetErrorCode(GetCredentialUnknownException()))
    }

    @Test
    fun theRejectionMessageNeverRepeatsTheProvidersWords() {
        val message = passkeyErrorMessage(GetCredentialUnknownException("provider said $SECRET"))
        assertFalse(message.contains(SECRET))
        assertEquals("passkey request did not complete", message)
    }

    // ---- the plugin has no route around the rebuilds ----

    @Test
    fun optionsReachTheSystemOnlyThroughTheRebuildsWithTheBuildsRelyingParty() {
        assertEquals(1, occurrences(source, "CreatePublicKeyCredentialRequest("))
        assertEquals(1, occurrences(source, "GetPublicKeyCredentialOption("))
        assertEquals(
            "creation options go through rebuildCreateOptions with the build's relying party",
            1,
            occurrences(
                compact,
                "CreatePublicKeyCredentialRequest(rebuildCreateOptions(ceremony.optionsJson,BuildConfig.PASSKEY_RP_ID),)",
            ),
        )
        assertEquals(
            "request options go through rebuildGetOptions with the build's relying party",
            1,
            occurrences(
                compact,
                "GetPublicKeyCredentialOption(rebuildGetOptions(ceremony.optionsJson,BuildConfig.PASSKEY_RP_ID),)",
            ),
        )
        // Each rebuild is called once, and the build constant is read for nothing else.
        assertEquals(1, occurrences(source, "rebuildCreateOptions("))
        assertEquals(1, occurrences(source, "rebuildGetOptions("))
        assertEquals(2, occurrences(source, "BuildConfig."))
        // The raw options are read in those two places and nowhere else.
        assertEquals(2, occurrences(source, "ceremony.optionsJson"))
        assertEquals(2, occurrences(source, ".optionsJson"))
    }

    @Test
    fun answersReachTheWebviewOnlyThroughTheRebuild() {
        assertEquals(1, occurrences(source, "ceremony.resolve("))
        assertEquals(1, occurrences(source, "ceremony.resolve(rebuildCredentialResponse(responseJson))"))
        assertEquals(1, occurrences(source, "rebuildCredentialResponse("))
        // One place writes the result key, inside Ceremony.resolve.
        assertEquals(1, occurrences(source, "\"credentialJson\""))
        assertEquals(1, occurrences(source, "result.put(\"credentialJson\", credentialJson)"))
    }

    @Test
    fun bothCeremoniesCheckTheMainFrameBridgeBeforeReadingAnArgument() {
        val begin = source.indexOf("private fun begin(call: PluginCall)")
        assertTrue(begin >= 0)
        val guard = source.indexOf("if (!MessageHandler.usingWebMessageListener) {", begin)
        val firstRead = source.indexOf("call.getString(", begin)
        assertTrue("begin() checks the bridge", guard > begin)
        assertTrue("the bridge check comes before the first argument read", guard < firstRead)
        // begin() is the only reader of call arguments, and both methods start with it.
        assertEquals(1, occurrences(source, "call.getString("))
        assertEquals(0, occurrences(source, "call.data"))
        assertEquals(0, occurrences(source, "call.getObject("))
        assertEquals(2, occurrences(source, "val ceremony = begin(call) ?: return"))
    }

    @Test
    fun thePluginNeverLogs() {
        for (token in listOf("android.util.Log", "Log.", "println(", "Logger.", "printStackTrace")) {
            assertEquals("found $token in PasskeyPlugin.kt", 0, occurrences(source, token))
        }
    }

    @Test
    fun aPageLoadAndTeardownSettleTheOpenCeremonyAsCancelled() {
        // The definition, the page listener and handleOnDestroy.
        assertEquals(3, occurrences(source, "cancelOpenCeremony()"))
        assertEquals(1, occurrences(source, "bridge.addWebViewListener("))
        assertEquals(
            "a new page cancels the open ceremony",
            1,
            occurrences(compact, "overridefunonPageStarted(webView:WebView){cancelOpenCeremony()}"),
        )
        val destroy = source.indexOf("override fun handleOnDestroy()")
        assertTrue(destroy >= 0)
        val destroyCancel = source.indexOf("cancelOpenCeremony()", destroy)
        val destroySuper = source.indexOf("super.handleOnDestroy()", destroy)
        assertTrue("teardown cancels the open ceremony", destroyCancel > destroy && destroyCancel < destroySuper)
        // The call is settled cancelled before the signal is cancelled, so the code is fixed.
        val definition = source.indexOf("private fun cancelOpenCeremony()")
        assertTrue(definition >= 0)
        val settle = source.indexOf("open.reject(PASSKEY_CANCELLED,", definition)
        val signal = source.indexOf("open.signal.cancel()", definition)
        assertTrue("the open call is settled cancelled", settle > definition)
        assertTrue("the signal is cancelled after the call is settled", signal > settle)
        assertEquals(1, occurrences(source, ".signal.cancel()"))
    }

    // ---- the relying party lives in the build, and only the plugin reaches the system ----

    @Test
    fun thePluginNamesNoHost() {
        assertEquals("the app's domain is named in PasskeyPlugin.kt", 0, occurrences(source.lowercase(), "sloga"))
        // Every string literal on a code line that holds dot-separated labels.
        // The two allowed are an intent action and a manifest meta-data key.
        val literal = Regex("\"((?:[^\"\\\\]|\\\\.)*)\"")
        val hostShaped = Regex("[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+")
        val found = sortedSetOf<String>()
        var codeLines = 0
        for (line in source.lines()) {
            val trimmed = line.trim()
            if (trimmed.isEmpty() || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
                continue
            }
            codeLines++
            for (match in literal.findAll(line)) {
                val text = match.groupValues[1]
                if (hostShaped.containsMatchIn(text)) found.add(text)
            }
        }
        assertTrue("the scan read the plugin ($codeLines code lines)", codeLines > 100)
        assertEquals(
            sortedSetOf(
                "android.service.credentials.CredentialProviderService",
                "androidx.credentials.CREDENTIAL_PROVIDER_KEY",
            ),
            found,
        )
    }

    @Test
    fun onlyThePluginNamesTheCredentialLibrary() {
        assertWalkIsReal()
        val naming = sourceFiles.filterValues { it.contains("androidx.credentials") }.keys
        // This file is the second: it builds the library's exceptions for the
        // rejection-code tests above, and it spells the name to search for it.
        assertEquals(sortedSetOf(PLUGIN_REL, TEST_REL), naming.toSortedSet())
    }

    @Test
    fun onlyThePluginCallsTheRebuilds() {
        assertWalkIsReal()
        for (name in listOf("rebuildCreateOptions", "rebuildGetOptions", "rebuildCredentialResponse")) {
            val naming = sourceFiles.filterValues { it.contains(name) }.keys
            assertEquals(name, sortedSetOf(JSON_REL, PLUGIN_REL, TEST_REL), naming.toSortedSet())
        }
    }

    @Test
    fun theRelyingPartyIsDefinedExactlyOnceInTheBuild() {
        val gradle = File(moduleDir, "build.gradle").readText()
        val definition = "buildConfigField \"String\", \"PASSKEY_RP_ID\", \"\\\"$RP\\\"\""
        assertEquals("definitions of PASSKEY_RP_ID in build.gradle", 1, occurrences(gradle, "\"PASSKEY_RP_ID\""))
        assertEquals("PASSKEY_RP_ID is the string $RP", 1, occurrences(gradle, definition))
        // In defaultConfig, so no flavor has its own.
        val defaultConfig = gradle.indexOf("    defaultConfig {")
        val signingConfigs = gradle.indexOf("    signingConfigs {")
        val at = gradle.indexOf(definition)
        assertTrue(defaultConfig >= 0 && signingConfigs > defaultConfig)
        assertTrue("PASSKEY_RP_ID is defined in defaultConfig", at > defaultConfig && at < signingConfigs)
    }

    /** The walk found the module's sources, in more than one source set. */
    private fun assertWalkIsReal() {
        assertTrue("walked ${sourceFiles.size} source files", sourceFiles.size >= 40)
        for (known in listOf(
            PLUGIN_REL,
            JSON_REL,
            TEST_REL,
            "src/main/java/com/acutest/app/MainActivity.java",
            "src/gms/java/com/acutest/app/PushTokenSource.java",
            "src/foss/java/com/acutest/app/PushTokenSource.java",
        )) {
            assertTrue("the walk found $known", sourceFiles.containsKey(known))
        }
    }
}
