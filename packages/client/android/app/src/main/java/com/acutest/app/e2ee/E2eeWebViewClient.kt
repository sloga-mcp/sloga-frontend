package com.acutest.app.e2ee

import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import com.getcapacitor.Bridge
import com.getcapacitor.BridgeWebViewClient
import java.io.ByteArrayInputStream

/**
 * Serves decrypted E2EE attachments to the WebView — the Android analog of
 * the desktop `e2ee-att` custom protocol handler.
 *
 * `https://localhost/_e2ee-att/{message_id}/{idx}` (the Capacitor app
 * origin) is intercepted BEFORE Capacitor's asset server and answered with
 * natively-decrypted bytes. This is the ONLY path on which decrypted
 * attachment bytes reach the WebView; key material stays in the Rust core
 * (invariant 6). Path validation and the render-mime whitelist (SVG and
 * non-media types degraded to octet-stream) are enforced in the Rust
 * binding (`open_attachment_for_render`), mirroring desktop exactly — this
 * class serves the result verbatim and only adds the same hardening
 * headers the desktop handler sets. Every failure is an opaque 404.
 */
class E2eeWebViewClient(private val bridge: Bridge) : BridgeWebViewClient(bridge) {
    override fun shouldInterceptRequest(
        view: WebView?,
        request: WebResourceRequest?,
    ): WebResourceResponse? {
        val url = request?.url
        if (
            url != null &&
            url.host == "localhost" &&
            url.path?.startsWith("/_e2ee-att/") == true
        ) {
            // Subresource loads only (an <img>/<video> src): never a
            // top-level navigation, so a decrypted attachment can't be
            // opened as its own page (slice-4 gate LOW #7). The message
            // renderer must additionally never emit an interceptor URL from
            // peer-supplied markdown — attachments render solely through
            // EncryptedAttachment off the bridge's reactive metadata map,
            // not from message text.
            if (request.isForMainFrame) return notFound()
            return serve(url.pathSegments)
        }
        return super.shouldInterceptRequest(view, request)
    }

    private fun serve(segments: List<String>): WebResourceResponse {
        try {
            // segments: ["_e2ee-att", messageId, idx] — anything else is 404
            if (segments.size != 3) return notFound()
            val idx = segments[2].toUIntOrNull() ?: return notFound()

            val content =
                E2eeNative.engine(bridge.context)
                    .openAttachmentForRender(segments[1], idx)

            val response =
                WebResourceResponse(content.mime, null, ByteArrayInputStream(content.data))
            response.responseHeaders =
                mapOf(
                    "Cache-Control" to "no-store",
                    "X-Content-Type-Options" to "nosniff",
                    "Content-Security-Policy" to "sandbox",
                )
            return response
        } catch (error: Throwable) {
            // Opaque: no distinction between missing, not-ready, and
            // failed-digest at this surface (no existence oracle)
            return notFound()
        }
    }

    private fun notFound(): WebResourceResponse {
        val response =
            WebResourceResponse("text/plain", null, ByteArrayInputStream(ByteArray(0)))
        response.setStatusCodeAndReasonPhrase(404, "Not Found")
        return response
    }
}
