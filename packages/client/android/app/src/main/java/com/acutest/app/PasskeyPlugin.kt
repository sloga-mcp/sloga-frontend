package com.acutest.app

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.CancellationSignal
import android.webkit.WebView
import androidx.credentials.CreateCredentialResponse
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.CredentialProvider
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.CreateCredentialNoCreateOptionException
import androidx.credentials.exceptions.CreateCredentialProviderConfigurationException
import androidx.credentials.exceptions.CreateCredentialUnsupportedException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.GetCredentialProviderConfigurationException
import androidx.credentials.exceptions.GetCredentialUnsupportedException
import androidx.credentials.exceptions.NoCredentialException
import androidx.credentials.exceptions.publickeycredential.CreatePublicKeyCredentialDomException
import androidx.credentials.exceptions.publickeycredential.GetPublicKeyCredentialDomException
import com.getcapacitor.JSObject
import com.getcapacitor.MessageHandler
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.WebViewListener
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean

/** The `code` of every rejection. The web layer switches on these four. */
internal const val PASSKEY_CANCELLED = "cancelled"
internal const val PASSKEY_NO_CREDENTIAL = "no_credential"
internal const val PASSKEY_UNAVAILABLE = "unavailable"
internal const val PASSKEY_FAILED = "failed"

/**
 * The rejection code for a failed creation. Only the exception's class
 * decides; its message comes from the provider and is never read.
 */
internal fun passkeyCreateErrorCode(error: CreateCredentialException): String =
    when (error) {
        is CreateCredentialCancellationException -> PASSKEY_CANCELLED
        // No provider on the device can store a passkey.
        is CreateCredentialNoCreateOptionException -> PASSKEY_UNAVAILABLE
        // The provider library is missing (foss below Android 14) or Google
        // Play services is absent or too old.
        is CreateCredentialProviderConfigurationException -> PASSKEY_UNAVAILABLE
        is CreateCredentialUnsupportedException -> PASSKEY_UNAVAILABLE
        // CreateCredentialInterruptedException, CreateCredentialUnknownException,
        // CreateCredentialCustomException and every WebAuthn DOM error
        // (CreatePublicKeyCredentialDomException).
        else -> PASSKEY_FAILED
    }

/** The rejection code for a failed sign-in. Same rule as [passkeyCreateErrorCode]. */
internal fun passkeyGetErrorCode(error: GetCredentialException): String =
    when (error) {
        is GetCredentialCancellationException -> PASSKEY_CANCELLED
        is NoCredentialException -> PASSKEY_NO_CREDENTIAL
        is GetCredentialProviderConfigurationException -> PASSKEY_UNAVAILABLE
        is GetCredentialUnsupportedException -> PASSKEY_UNAVAILABLE
        // GetCredentialInterruptedException, GetCredentialUnknownException,
        // GetCredentialCustomException and every WebAuthn DOM error
        // (GetPublicKeyCredentialDomException).
        else -> PASSKEY_FAILED
    }

/**
 * The rejection message: fixed words, plus the WebAuthn error's class name
 * (`NotAllowedError`, `InvalidStateError`, ...) when there is one, so a
 * failure can be told apart in a bug report. Never the exception's own
 * message, which the provider wrote.
 */
internal fun passkeyErrorMessage(error: Throwable): String {
    val dom =
        when (error) {
            is CreatePublicKeyCredentialDomException -> error.domError
            is GetPublicKeyCredentialDomException -> error.domError
            else -> null
        }
    val name = dom?.javaClass?.simpleName?.filter { it in 'A'..'Z' || it in 'a'..'z' }
    return if (name.isNullOrEmpty()) "passkey request did not complete" else "passkey request did not complete ($name)"
}

/**
 * Passkey ceremonies for the webview, over the system credential manager
 * (`androidx.credentials`). The webview origin (`https://localhost`) cannot
 * run WebAuthn itself, so the web layer fetches the options from the server,
 * hands them here as WebAuthn JSON, and posts the JSON answer back.
 *
 *  - `isAvailable()` resolves `{ available }` and never rejects.
 *  - `create({ optionsJson })` resolves `{ credentialJson }` (registration).
 *  - `get({ optionsJson })` resolves `{ credentialJson }` (authentication).
 *
 * Rejections carry `code`: `cancelled`, `no_credential`, `unavailable` or
 * `failed`.
 *
 * Rule R1 of the passkeys plan holds here and nowhere else on Android: the
 * options go to the system only through [rebuildCreateOptions] or
 * [rebuildGetOptions], and the answer goes to the webview only through
 * [rebuildCredentialResponse]. Each copies a fixed list of members and drops
 * the rest, so no extension (PRF above all) is ever requested or returned
 * for a sign-in passkey, whatever the page asked for.
 *
 * The relying party is not the page's to choose either. Both option rebuilds
 * refuse anything but the one relying-party ID compiled into this build
 * (PASSKEY_RP_ID in app/build.gradle), before the system sees a byte. This
 * file names no host itself. A backup-only passkey, when one exists, lives
 * under another relying-party ID and is reached from native code only, never
 * through this plugin.
 *
 * A ceremony ends with its page: when the webview starts loading a new page,
 * or the activity goes away, the open sheet is closed and the call settles
 * `cancelled`.
 *
 * Only the app's own main frame may call this plugin. The patched Capacitor
 * bridge records whether it is the main-frame-only WebMessageListener
 * (`MessageHandler.usingWebMessageListener`); on the older
 * `addJavascriptInterface` bridge, which takes calls from every frame,
 * `isAvailable()` answers false and both ceremonies reject `unavailable`
 * before reading an argument.
 *
 * Nothing here logs: options hold the challenge and the account's user
 * handle, and answers hold the credential.
 */
@CapacitorPlugin(name = "Passkey")
class PasskeyPlugin : Plugin() {
    /**
     * Off Capacitor's single plugin thread: parsing, the call into the
     * credential manager and its callback all run here. A cached pool, like
     * E2eePlugin's: idle threads end by themselves, so it is never shut down,
     * and a late callback from the system always has somewhere to run.
     */
    private val executor: ExecutorService = Executors.newCachedThreadPool()

    /** One system sheet at a time. A second request is refused, never queued. */
    private val inFlight = AtomicBoolean(false)

    /** The open ceremony, so [cancelOpenCeremony] can settle it and close its sheet. */
    @Volatile private var current: Ceremony? = null

    /** Set once [handleOnStart] has added the page listener. Main thread only. */
    private var pageListenerRegistered = false

    /** One accepted request. Settles its call once and frees the slot with it. */
    private inner class Ceremony(private val call: PluginCall, val optionsJson: String) {
        val signal = CancellationSignal()
        private val settled = AtomicBoolean(false)

        /** True once the call has been answered; nothing more may start for it. */
        val isSettled: Boolean
            get() = settled.get()

        fun resolve(credentialJson: String) {
            if (!settled.compareAndSet(false, true)) return
            release()
            val result = JSObject()
            result.put("credentialJson", credentialJson)
            call.resolve(result)
        }

        fun reject(code: String, message: String) {
            if (!settled.compareAndSet(false, true)) return
            release()
            call.reject(message, code)
        }

        private fun release() {
            if (current === this) current = null
            inFlight.set(false)
        }
    }

    @PluginMethod
    fun isAvailable(call: PluginCall) {
        val available =
            try {
                passkeysAvailable()
            } catch (e: Throwable) {
                false
            }
        val result = JSObject()
        result.put("available", available)
        call.resolve(result)
    }

    @PluginMethod
    fun create(call: PluginCall) {
        val ceremony = begin(call) ?: return
        val host = activity
        launch(ceremony) {
            val request =
                CreatePublicKeyCredentialRequest(
                    rebuildCreateOptions(ceremony.optionsJson, BuildConfig.PASSKEY_RP_ID),
                )
            CredentialManager.create(host).createCredentialAsync(
                host,
                request,
                ceremony.signal,
                executor,
                object : CredentialManagerCallback<CreateCredentialResponse, CreateCredentialException> {
                    override fun onResult(result: CreateCredentialResponse) {
                        finish(ceremony, (result as? CreatePublicKeyCredentialResponse)?.registrationResponseJson)
                    }

                    override fun onError(e: CreateCredentialException) {
                        ceremony.reject(passkeyCreateErrorCode(e), passkeyErrorMessage(e))
                    }
                },
            )
        }
    }

    @PluginMethod
    fun get(call: PluginCall) {
        val ceremony = begin(call) ?: return
        val host = activity
        launch(ceremony) {
            val option =
                GetPublicKeyCredentialOption(
                    rebuildGetOptions(ceremony.optionsJson, BuildConfig.PASSKEY_RP_ID),
                )
            CredentialManager.create(host).getCredentialAsync(
                host,
                GetCredentialRequest(listOf(option)),
                ceremony.signal,
                executor,
                object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
                    override fun onResult(result: GetCredentialResponse) {
                        finish(ceremony, (result.credential as? PublicKeyCredential)?.authenticationResponseJson)
                    }

                    override fun onError(e: GetCredentialException) {
                        ceremony.reject(passkeyGetErrorCode(e), passkeyErrorMessage(e))
                    }
                },
            )
        }
    }

    /**
     * The checks every ceremony passes before anything is parsed, in order:
     * main-frame bridge, API level, argument, its size (64 KiB of UTF-8 at
     * most), a live activity for the system sheet, and the single slot.
     * Rejects and returns null when one fails.
     */
    private fun begin(call: PluginCall): Ceremony? {
        if (!MessageHandler.usingWebMessageListener) {
            call.reject("passkeys need the main-frame bridge", PASSKEY_UNAVAILABLE)
            return null
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            call.reject("passkeys need Android 9 or later", PASSKEY_UNAVAILABLE)
            return null
        }
        val optionsJson = call.getString("optionsJson")
        if (optionsJson == null) {
            call.reject("optionsJson is required", PASSKEY_FAILED)
            return null
        }
        if (!passkeyOptionsFit(optionsJson)) {
            call.reject("optionsJson is too large", PASSKEY_FAILED)
            return null
        }
        val host: Activity? = activity
        if (host == null || host.isFinishing || host.isDestroyed) {
            call.reject("no screen to show the passkey sheet on", PASSKEY_FAILED)
            return null
        }
        if (!inFlight.compareAndSet(false, true)) {
            call.reject("another passkey request is open", PASSKEY_FAILED)
            return null
        }
        val ceremony = Ceremony(call, optionsJson)
        current = ceremony
        return ceremony
    }

    /**
     * Run [body] on [executor]. Options that are not a JSON object, that
     * lack a required member or that name another relying party, options
     * the library refuses, and any other failure to start reject `failed`;
     * in each case the system was handed nothing. A ceremony already settled
     * (its page went away before this ran) starts nothing.
     */
    private fun launch(ceremony: Ceremony, body: () -> Unit) {
        try {
            executor.execute {
                if (ceremony.isSettled) return@execute
                try {
                    body()
                } catch (e: PasskeyJsonException) {
                    ceremony.reject(PASSKEY_FAILED, "passkey options were refused")
                } catch (e: Throwable) {
                    ceremony.reject(PASSKEY_FAILED, "passkey request could not start")
                }
            }
        } catch (e: RejectedExecutionException) {
            ceremony.reject(PASSKEY_FAILED, "passkey request could not start")
        }
    }

    /**
     * Hand the system's answer to the webview, rebuilt: the listed members
     * only, and no extension results. Null means the system answered with
     * something that is not a passkey; an answer without `id`, `type` or
     * `response` rejects `failed` too.
     */
    private fun finish(ceremony: Ceremony, responseJson: String?) {
        if (responseJson == null) {
            ceremony.reject(PASSKEY_FAILED, "the answer was not a passkey")
            return
        }
        try {
            ceremony.resolve(rebuildCredentialResponse(responseJson))
        } catch (e: Throwable) {
            ceremony.reject(PASSKEY_FAILED, "the passkey answer could not be read")
        }
    }

    /**
     * End the open ceremony, if there is one: settle its call `cancelled`
     * (which frees the slot), then cancel its signal so the system closes the
     * sheet. Settling comes first so the code is `cancelled` whatever the
     * library reports for the cancellation afterwards; that later report
     * finds the call settled and does nothing. Safe from any thread.
     */
    private fun cancelOpenCeremony() {
        val open = current ?: return
        open.reject(PASSKEY_CANCELLED, "the page that asked for the passkey went away")
        try {
            open.signal.cancel()
        } catch (e: RuntimeException) {
            // The call is settled and the slot is free; a sheet the system
            // would not close is the user's to dismiss.
        }
    }

    /**
     * Closes the sheet whenever a new page starts loading in the webview: a
     * reload or a full navigation replaces the JS that asked, and a sheet
     * left open would answer a page that no longer exists.
     *
     * Registered here and not in `load()`, as ScreenSharePlugin does and for
     * its reason: Capacitor calls `load()` inside the `Bridge` constructor
     * and `Bridge.Builder.create()` then replaces the listener list, so a
     * listener added there is dropped. The listener fires for main-frame
     * loads only, on the main thread. Missing the cold-start page is
     * harmless: no ceremony exists yet.
     */
    override fun handleOnStart() {
        super.handleOnStart()
        if (pageListenerRegistered) return
        pageListenerRegistered = true
        bridge.addWebViewListener(
            object : WebViewListener() {
                override fun onPageStarted(webView: WebView) {
                    cancelOpenCeremony()
                }
            },
        )
    }

    override fun handleOnDestroy() {
        // The sheet belongs to the activity that is going away. Settle the
        // call here instead of waiting for the library to report the
        // cancellation: the slot is freed now, and the call is answered even
        // if that report never comes.
        cancelOpenCeremony()
        super.handleOnDestroy()
    }

    /**
     * Whether a ceremony can work on this install. False on the bridge that
     * serves every frame and below Android 9. On Android 14 and later the
     * system credential manager serves passkeys once any provider app is
     * installed (Google Password Manager or another password manager); this
     * is the only route the foss build has. Below Android 14 the only route
     * is the Google Play services provider, which the play and sideload
     * builds bundle and the foss build does not.
     */
    private fun passkeysAvailable(): Boolean {
        if (!MessageHandler.usingWebMessageListener) return false
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE &&
            context.getSystemService(Context.CREDENTIAL_SERVICE) != null
        ) {
            // The library always takes the system route here, so an install
            // with no provider app has nothing to offer.
            return credentialProviderInstalled()
        }
        return playServicesProviderAvailable()
    }

    /**
     * Whether any app on the device declares a credential provider service
     * (Android 14+). Installed, not necessarily switched on in Settings: an
     * app cannot read which providers the user enabled. Needs the matching
     * `<queries>` entry in AndroidManifest.xml to see other packages.
     */
    private fun credentialProviderInstalled(): Boolean {
        val intent = Intent("android.service.credentials.CredentialProviderService")
        return context.packageManager
            .queryIntentServices(intent, PackageManager.MATCH_DISABLED_COMPONENTS)
            .isNotEmpty()
    }

    /**
     * Whether the bundled Google Play services provider can run, found the
     * way the library finds it: the provider aar merges a service into the
     * manifest whose meta-data names the provider class. The foss build has
     * no such entry (and no Google class), so this is false there. No Google
     * type is named in this file, so it compiles the same for every flavor.
     */
    private fun playServicesProviderAvailable(): Boolean {
        val info =
            context.packageManager.getPackageInfo(
                context.packageName,
                PackageManager.GET_SERVICES or PackageManager.GET_META_DATA,
            )
        val services = info.services ?: return false
        val classNames =
            services.mapNotNull { it.metaData?.getString("androidx.credentials.CREDENTIAL_PROVIDER_KEY") }
        // The library refuses to choose between two providers; so does this.
        if (classNames.size != 1) return false
        val instance: Any? =
            Class.forName(classNames[0]).getConstructor(Context::class.java).newInstance(context)
        return instance is CredentialProvider && instance.isAvailableOnDevice()
    }
}
