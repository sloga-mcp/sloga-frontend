package com.acutest.app.e2ee

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Host tests for the split and restore wiring of [E2eePlugin].
 *
 * The invariant: `e2ee_split_begin` stages a new device identity through the engine's
 * `splitStage`, which Rust does NOT confirm-gate on Android, so the only way to reach it is the
 * positive button of the dialog in the dedicated `splitBegin` method. The generic `call()` refuses
 * the name before it dispatches anything and has no arm for it; `e2ee_split_commit` and
 * `e2ee_split_discard` are generic arms.
 *
 * The plugin needs an Activity, a Capacitor bridge and the native core, none of which load on the
 * host JVM, so the dispatch-shape rules read the plugin's source (comments blanked, string literals
 * kept for the arm checks, braces matched on a copy with string contents blanked). The refusal
 * predicate itself is called directly.
 */
class E2eeGenericCallTest {
    private companion object {
        const val PLUGIN_REL = "src/main/java/com/acutest/app/e2ee/E2eePlugin.kt"

        /** The plugin source; the unit-test working directory is the app module. */
        val source: String by lazy {
            val candidates = listOf(File(PLUGIN_REL), File("app/$PLUGIN_REL"))
            val file =
                candidates.firstOrNull { it.isFile }
                    ?: throw AssertionError(
                        "E2eePlugin.kt not found from ${File(".").absolutePath} (tried $candidates)",
                    )
            file.readText()
        }

        /** [source] with comments blanked to spaces (same length; strings kept). */
        val code: String by lazy { lex(source, blankStrings = false) }

        /** [source] with comments AND string-literal contents blanked (for brace matching). */
        val masked: String by lazy { lex(source, blankStrings = true) }

        /**
         * One pass over Kotlin source: line and block comments become spaces; with [blankStrings],
         * every character between a string's quotes becomes '_'. Newlines are kept and the length
         * never changes, so an index into the result is an index into [src]. Handles escapes and
         * char literals; the plugin has no raw strings or `${` templates (asserted).
         */
        fun lex(src: String, blankStrings: Boolean): String {
            val out = StringBuilder(src)
            var i = 0
            while (i < src.length) {
                val c = src[i]
                val next = if (i + 1 < src.length) src[i + 1] else '\u0000'
                when {
                    c == '/' && next == '/' -> {
                        while (i < src.length && src[i] != '\n') {
                            out.setCharAt(i, ' ')
                            i++
                        }
                    }
                    c == '/' && next == '*' -> {
                        val end = src.indexOf("*/", i + 2)
                        val stop = if (end < 0) src.length else end + 2
                        while (i < stop) {
                            if (src[i] != '\n') out.setCharAt(i, ' ')
                            i++
                        }
                    }
                    c == '"' || c == '\'' -> {
                        i++
                        while (i < src.length && src[i] != c) {
                            if (src[i] == '\\') {
                                if (blankStrings) out.setCharAt(i, '_')
                                i++
                            }
                            if (i < src.length && blankStrings) out.setCharAt(i, '_')
                            i++
                        }
                        i++
                    }
                    else -> i++
                }
            }
            return out.toString()
        }

        /** The `{...}` body (braces included) of the function declared by [signature]. */
        fun body(signature: String): IntRange {
            val at = code.indexOf(signature)
            assertTrue("declaration '$signature' not found in E2eePlugin.kt", at >= 0)
            assertEquals(
                "'$signature' is declared more than once",
                -1,
                code.indexOf(signature, at + signature.length),
            )
            val open = masked.indexOf('{', at)
            var depth = 0
            for (i in open until masked.length) {
                when (masked[i]) {
                    '{' -> depth++
                    '}' -> {
                        depth--
                        if (depth == 0) return open..i
                    }
                }
            }
            throw AssertionError("unbalanced braces after '$signature'")
        }

        fun count(text: String, needle: String): Int =
            Regex(Regex.escape(needle)).findAll(text).count()
    }

    @Test
    fun lexerPreconditionsHold() {
        assertFalse("raw strings would defeat the lexer", source.contains("\"\"\""))
        assertFalse("string templates would defeat the lexer", source.contains("\${"))
    }

    @Test
    fun genericPathRefusesSplitBeginByName() {
        assertTrue(genericCallRefuses("e2ee_split_begin"))
    }

    @Test
    fun genericPathDoesNotRefuseSplitCommitOrDiscard() {
        assertFalse(genericCallRefuses("e2ee_split_commit"))
        assertFalse(genericCallRefuses("e2ee_split_discard"))
    }

    @Test
    fun callChecksTheRefusalBeforeItDispatches() {
        val range = body("fun call(call: PluginCall)")
        val call = code.substring(range)
        val guard = call.indexOf("if (genericCallRefuses(name))")
        val dispatch = call.indexOf("run(call) {")
        assertTrue("call() never consults genericCallRefuses(name)", guard >= 0)
        assertTrue("call() has no run(call) dispatch", dispatch >= 0)
        assertTrue("the refusal must come before the dispatch", guard < dispatch)
        // The refusal block rejects and returns. Its closing brace is found on the
        // string-blanked copy: the reject literal itself contains braces.
        val start = range.first + guard
        val end = masked.indexOf('}', masked.indexOf('{', start))
        val block = code.substring(start, end)
        assertTrue("the refusal must reject", block.contains("call.reject("))
        assertTrue("the refusal must return", Regex("\\breturn\\b").containsMatchIn(block))
    }

    @Test
    fun callHasNoSplitBeginArmAndNeverStages() {
        val call = code.substring(body("fun call(call: PluginCall)"))
        assertFalse(
            "call() has an arm naming e2ee_split_begin",
            Regex("\"e2ee_split_begin\"\\s*(->|,)").containsMatchIn(call),
        )
        assertFalse("call() reaches splitStage", call.contains("splitStage"))
    }

    @Test
    fun callHasSplitCommitAndDiscardArms() {
        val call = code.substring(body("fun call(call: PluginCall)"))
        assertTrue(Regex("\"e2ee_split_commit\"\\s*->").containsMatchIn(call))
        assertTrue(Regex("\"e2ee_split_discard\"\\s*->").containsMatchIn(call))
        assertEquals(1, count(call, "engine.splitCommit()"))
        assertEquals(1, count(call, "engine.splitDiscard()"))
    }

    @Test
    fun splitStageIsReachedOnlyFromTheSplitDialogConfirm() {
        assertEquals("splitStage( must appear exactly once in the plugin", 1, count(code, "splitStage("))
        val range = body("fun splitBegin(call: PluginCall)")
        val at = code.indexOf("splitStage(")
        assertTrue("splitStage( is outside splitBegin", at in range)
        val method = code.substring(range)
        val positive = method.indexOf(".setPositiveButton(prompt.confirmLabel)")
        val negative = method.indexOf(".setNegativeButton(prompt.cancelLabel")
        val stage = method.indexOf("splitStage(")
        assertTrue("splitBegin has no core-labelled confirm button", positive >= 0)
        assertTrue("splitBegin has no core-labelled cancel button", negative >= 0)
        assertTrue("splitStage must sit inside the confirm listener", stage in (positive + 1) until negative)
        val fn = code.indexOf("fun splitBegin(call: PluginCall)")
        val annotation = code.lastIndexOf("@PluginMethod", fn)
        assertTrue(
            "splitBegin must be a @PluginMethod",
            annotation >= 0 && code.substring(annotation + "@PluginMethod".length, fn).isBlank(),
        )
    }

    @Test
    fun splitDialogCopyComesFromTheCore() {
        val method = code.substring(body("fun splitBegin(call: PluginCall)"))
        assertTrue("splitBegin does not read splitConfirmCopy()", method.contains("splitConfirmCopy()"))
        assertTrue(method.contains(".setTitle(prompt.title)"))
        assertTrue(method.contains(".setMessage(prompt.message)"))
        val literal = Regex("\\.set(Title|Message|PositiveButton|NegativeButton)\\(\\s*\"")
        assertFalse("splitBegin hardcodes dialog copy", literal.containsMatchIn(method))
        // Every way out of the dialog other than confirm declines, and Cancel takes focus.
        assertTrue(method.contains("setOnDismissListener"))
        assertTrue(method.contains("call.reject(\"{\\\"type\\\":\\\"declined\\\"}\")"))
        assertTrue(method.contains("cancel.requestFocus()"))
    }

    @Test
    fun restoreReturnsTheReportAndNeverRekeys() {
        val restore = code.substring(body("private fun showRestoreDialog("))
        assertFalse("the restore dialog still calls postRestoreRekey", restore.contains("postRestoreRekey"))
        val bound = Regex("val (\\w+) = engine\\(\\)\\.restore\\(").find(restore)
        if (bound == null) fail("the restore dialog does not keep engine().restore(...)'s result")
        val name = bound!!.groupValues[1]
        assertTrue(
            "the restore dialog must resolve the RestoreReport it got from engine().restore",
            restore.contains("resolveJson(call, $name)"),
        )
        // The legacy re-derive arm is the one remaining caller (stores older builds restored).
        assertEquals(1, count(code, "postRestoreRekey("))
        val call = code.substring(body("fun call(call: PluginCall)"))
        assertTrue(call.contains("engine.postRestoreRekey()"))
    }

    // ---- A locked phone confirms nothing in the plaintext direction ----

    @Test
    fun keyguardBlocksUnlessThePhoneIsKnownToBeUnlocked() {
        assertTrue(keyguardBlocks(true))
        assertTrue("an unreadable keyguard must count as locked", keyguardBlocks(null))
        assertFalse(keyguardBlocks(false))
    }

    @Test
    fun lockedRefusalIsTheDeclinedErrorAndReadsTheKeyguardEachTime() {
        val refuse = code.substring(body("private fun rejectedWhileLocked(call: PluginCall): Boolean"))
        assertTrue(refuse.contains("if (!keyguardBlocksNow()) return false"))
        assertEquals("the refusal rejects exactly once", 1, count(refuse, "call.reject("))
        assertTrue(
            "the refusal must be the typed declined error, the one Cancel gives",
            refuse.contains("call.reject(\"{\\\"type\\\":\\\"declined\\\"}\")"),
        )
        val read = code.substring(body("private fun keyguardBlocksNow(): Boolean"))
        assertTrue(read.contains("Context.KEYGUARD_SERVICE"))
        assertTrue(read.contains("isKeyguardLocked"))
        assertTrue("a failed read must reach keyguardBlocks as null", read.contains("null"))
        assertTrue(read.contains("return keyguardBlocks(locked)"))
    }

    @Test
    fun plaintextConfirmsRefuseALockedPhoneBeforeTheyReadAnything() {
        val signatures =
            listOf(
                "fun downgrade(call: PluginCall)",
                "fun confirmPeerDowngradeAccept(call: PluginCall)",
                "fun callConfirmDowngrade(call: PluginCall)",
                // The roster is computed on another thread, so the dialog asks again.
                "private fun showConfirmDowngradeDialog(",
            )
        for (signature in signatures) {
            val method = code.substring(body(signature))
            val guard = method.indexOf("if (rejectedWhileLocked(call)) return")
            assertTrue("$signature has no keyguard check", guard >= 0)
            // Comments are blanked in `code`, so only code can sit between the brace and the guard.
            assertTrue(
                "$signature must ask the keyguard before anything else",
                method.substring(1, guard).isBlank(),
            )
            assertFalse(
                "$signature: the first check must leave the method, not a listener",
                method.startsWith("if (rejectedWhileLocked(call)) return@", guard),
            )
        }
    }

    @Test
    fun plaintextConfirmButtonsAskTheKeyguardAgainBeforeTheyCommit() {
        // The dialog's method, and the one engine call that moves toward plaintext.
        val dialogs =
            listOf(
                "fun downgrade(call: PluginCall)" to "engine().downgrade(",
                "fun confirmPeerDowngradeAccept(call: PluginCall)" to
                    "engine().confirmPeerDowngrade(conversationId, true)",
                "private fun showConfirmDowngradeDialog(" to "engine().mlsCallMarkDowngradeConfirmed(",
            )
        for ((signature, commit) in dialogs) {
            assertEquals("$commit must appear exactly once in the plugin", 1, count(code, commit))
            val method = code.substring(body(signature))
            val positive = method.indexOf(".setPositiveButton(")
            val negative = method.indexOf(".setNegativeButton(")
            assertTrue("$signature has no confirm button", positive >= 0)
            assertTrue("$signature has no cancel button after it", negative > positive)
            val listener = method.substring(positive, negative)
            val recheck = listener.indexOf("if (rejectedWhileLocked(call)) return@setPositiveButton")
            val dispatch = listener.indexOf("run(call) {")
            val committed = listener.indexOf(commit)
            assertTrue("$signature: the confirm button does not ask the keyguard", recheck >= 0)
            assertTrue("$signature: $commit is outside the confirm button", committed >= 0)
            assertTrue("$signature: the confirm button dispatches nothing", dispatch >= 0)
            assertTrue("$signature: the keyguard must be asked before the dispatch", recheck < dispatch)
            assertTrue("$signature: the commit must come after the keyguard check", recheck < committed)
        }
    }

    @Test
    fun groupPlaintextAckRefusesALockedPhoneBeforeTheCore() {
        val call = code.substring(body("fun call(call: PluginCall)"))
        val arm = call.indexOf("\"e2ee_acknowledge_group_plaintext\" -> {")
        assertTrue("call() has no e2ee_acknowledge_group_plaintext arm", arm >= 0)
        assertEquals(1, count(code, "acknowledgeGroupPlaintext("))
        val core = call.indexOf("engine.acknowledgeGroupPlaintext(", arm)
        assertTrue("the arm never reaches the core", core >= 0)
        val before = call.substring(arm, core)
        assertEquals("only this arm may sit between its label and its core call", 1, count(before, " -> "))
        assertTrue("the arm does not ask the keyguard", before.contains("if (keyguardBlocksNow()) {"))
        assertTrue(
            "a locked phone must be refused with the typed declined error",
            before.contains("throw E2eeException.Failure(\"{\\\"type\\\":\\\"declined\\\"}\")"),
        )
    }

    @Test
    fun clearingACallDowngradeIsNeverKeyguardChecked() {
        // Clearing only forces a fresh confirm. Refusing it would keep a grant alive.
        val call = code.substring(body("fun call(call: PluginCall)"))
        val arm = call.indexOf("\"e2ee_call_clear_downgrade\" -> {")
        assertTrue("call() has no e2ee_call_clear_downgrade arm", arm >= 0)
        val core = call.indexOf("engine.mlsCallClearDowngradeConfirmed(", arm)
        assertTrue("the arm never reaches the core", core >= 0)
        val before = call.substring(arm, core)
        assertEquals(1, count(before, " -> "))
        assertFalse(before.contains("keyguardBlocksNow"))
        assertFalse(before.contains("rejectedWhileLocked"))
    }
}
