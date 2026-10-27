package com.acutest.app.e2ee

import android.app.Activity
import android.app.AlertDialog
import android.os.Looper
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import uniffi.acutest_e2ee.TextConfirm
import uniffi.acutest_e2ee.TextConfirmException
import uniffi.acutest_e2ee.TextConfirmPayload

/**
 * How long a protected-text dialog's confirm button stays disabled after the
 * dialog shows (tapjacking). Equal to the plugin's `GROWTH_CONFIRM_DELAY_MS`,
 * under its own name so tuning one is a visible decision about the other.
 */
private const val TEXT_CONFIRM_DELAY_MS: Long = 700L

/**
 * The open protected-text dialogs of one [E2eePlugin] and its teardown flag.
 *
 * [destroyed] is set once, by `E2eePlugin.handleOnDestroy` on the UI thread,
 * and never cleared. Every dialog runnable reads it on the UI thread right
 * before `show()`, so a runnable still queued behind the teardown never shows
 * a dialog on a dead activity (it answers `Err` instead). The set is UI
 * thread only.
 */
internal class TextDialogs {
    @Volatile var destroyed = false

    private val open = LinkedHashSet<AlertDialog>()

    fun add(dialog: AlertDialog) {
        open.add(dialog)
    }

    fun remove(dialog: AlertDialog) {
        open.remove(dialog)
    }

    /**
     * Dismiss every open dialog. Each one's dismiss listener answers
     * Declined to the worker waiting on it. UI thread only.
     */
    fun dismissAll() {
        for (dialog in open.toList()) dialog.dismiss()
        open.clear()
    }
}

/**
 * The native dialog behind the three protected-text dialog commands
 * (`e2ee_text_seat_list_sign`, `e2ee_text_owner_confirm_change`,
 * `e2ee_text_owner_handover_sign`; S7 D2). The Rust method runs the whole
 * gated flow (preview, decline lockout, copy, this callback, the commit bound
 * to that preview) and calls back here, with no Rust lock held, only when the
 * user must answer. Kotlin decides nothing: it renders the core-written copy
 * verbatim and reports which button was pressed.
 *
 * Blocking, on the plugin's executor thread (uniffi runs the callback on the
 * thread that called the engine). The dialog is posted to the UI thread and
 * the worker waits on a latch, never inside `synchronized`.
 *
 * Answers:
 *  - `true` only from the positive button's listener, after it wins the
 *    settle-once claim;
 *  - `false` (Declined) on any dismissal: the cancel button, back, an outside
 *    tap, or [TextDialogs.dismissAll] at activity teardown;
 *  - `Err` ([TextConfirmException.Failed]) when called on the main looper,
 *    when the activity is null, finishing or destroyed, when the copy is
 *    blank, or when building or showing the dialog throws.
 * Rust treats `false` and every `Err` alike: no consent, nothing committed,
 * and the decline lockout starts.
 *
 * [inform] (the different-user owner change) shows ONE button labelled
 * `confirmLabel` (core writes the same non-affirmative "Close" in both
 * labels for it), whose press decides nothing.
 */
internal class TextConfirmDialog(
    private val activity: () -> Activity?,
    private val dialogs: TextDialogs,
) : TextConfirm {
    override fun confirm(payload: TextConfirmPayload): Boolean {
        // The one-button information copy cannot answer a question.
        if (payload.single) throw TextConfirmException.Failed()
        return ask(payload, single = false)
    }

    override fun inform(payload: TextConfirmPayload) {
        ask(payload, single = true)
    }

    private fun ask(payload: TextConfirmPayload, single: Boolean): Boolean {
        // Waiting on the main looper would block the very thread that has to
        // show the dialog.
        if (Looper.myLooper() == Looper.getMainLooper()) throw TextConfirmException.Failed()
        // A dialog with no copy or no button label the core wrote is no
        // consent: fail closed.
        if (
            payload.title.isBlank() ||
                payload.message.isBlank() ||
                payload.confirmLabel.isBlank() ||
                payload.cancelLabel.isBlank()
        ) {
            throw TextConfirmException.Failed()
        }
        val host = activity() ?: throw TextConfirmException.Failed()
        if (dialogs.destroyed || host.isFinishing || host.isDestroyed) {
            throw TextConfirmException.Failed()
        }

        val latch = CountDownLatch(1)
        val settled = AtomicBoolean(false)
        // null = no answer, which this method turns into `Err`.
        val answer = AtomicReference<Boolean?>(null)
        val shown = AtomicReference<AlertDialog?>(null)
        // Settle once: the first of the positive button, the dismiss
        // listener, a build or show failure, or an interrupted wait wins.
        fun settle(value: Boolean?) {
            if (settled.compareAndSet(false, true)) {
                answer.set(value)
                latch.countDown()
            }
        }

        try {
            host.runOnUiThread {
                var built: AlertDialog? = null
                try {
                    // Checked HERE, on the UI thread, where handleOnDestroy
                    // also runs: torn down (or already settled by an
                    // interrupted worker) since the post means no dialog.
                    if (settled.get() || dialogs.destroyed || host.isFinishing || host.isDestroyed) {
                        settle(null)
                        return@runOnUiThread
                    }
                    val builder =
                        AlertDialog.Builder(host).setTitle(payload.title).setMessage(payload.message)
                    if (single) {
                        // No listener: the press dismisses, and the dismiss
                        // listener settles. No positive button exists.
                        builder.setNegativeButton(payload.confirmLabel, null)
                    } else {
                        builder
                            .setPositiveButton(payload.confirmLabel) { _, _ -> settle(true) }
                            // No listener: the button dismisses the dialog,
                            // and the dismiss listener declines.
                            .setNegativeButton(payload.cancelLabel, null)
                    }
                    val dialog = builder.create()
                    built = dialog
                    // Back and an outside tap cancel, and a cancel dismisses:
                    // both reach the dismiss listener.
                    dialog.setCanceledOnTouchOutside(true)
                    dialog.setOnDismissListener {
                        dialogs.remove(dialog)
                        // Lost the race to a confirm: already settled.
                        settle(false)
                    }
                    dialogs.add(dialog)
                    dialog.show()
                    shown.set(dialog)
                    // Tapjacking, applied right after show() (which has built
                    // the buttons) and before this runnable returns, so no
                    // input event reaches an enabled confirm button: confirm
                    // ignores touches while another window covers it and
                    // stays disabled for TEXT_CONFIRM_DELAY_MS; the other
                    // button ignores obscured touches too and takes focus
                    // (cancel is the default; `defaultButton` and `kind` are
                    // not rendered).
                    dialog.getButton(AlertDialog.BUTTON_POSITIVE)?.let { confirm ->
                        confirm.isEnabled = false
                        confirm.filterTouchesWhenObscured = true
                        confirm.postDelayed({ confirm.isEnabled = true }, TEXT_CONFIRM_DELAY_MS)
                    }
                    dialog.getButton(AlertDialog.BUTTON_NEGATIVE)?.let { cancel ->
                        cancel.filterTouchesWhenObscured = true
                        cancel.requestFocus()
                    }
                } catch (error: Throwable) {
                    settle(null)
                    built?.let { dialog ->
                        dialogs.remove(dialog)
                        try {
                            dialog.dismiss()
                        } catch (ignored: Throwable) {
                            // Never shown: nothing to take down.
                        }
                    }
                }
            }
        } catch (error: Throwable) {
            settle(null)
        }

        try {
            latch.await()
        } catch (error: InterruptedException) {
            // No answer: settle first, so a later tap counts for nothing,
            // then take down a dialog that is already up.
            settle(null)
            Thread.currentThread().interrupt()
            try {
                host.runOnUiThread { shown.get()?.dismiss() }
            } catch (ignored: Throwable) {
                // The activity is gone; so is its window.
            }
        }
        return answer.get() ?: throw TextConfirmException.Failed()
    }
}
