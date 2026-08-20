package com.acutest.app.watch

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.InputStream
import java.nio.charset.Charset
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Watch-together Jellyfin API carrier for Android (plan §5.4, slice 3).
 *
 * `setServers` is the analog of the desktop `jf_set_servers` command:
 * replace-all from the webview's per-device saved-server store, second-gate
 * validated in [JellyfinServers].
 *
 * `request` carries the JSON API half of the transport (auth, PlaybackInfo,
 * playstate): Android's `shouldInterceptRequest` never exposes a request
 * BODY, so POSTs cannot ride the `/_jf/` interceptor — and these responses
 * are small JSON, so a bridge round-trip is fine. Media (HLS manifests,
 * segments, posters) never crosses this bridge: it streams natively through
 * [JellyfinWebViewClient].
 *
 * Forwards ONLY to servers in the registered table (§5.1) — an unknown id
 * rejects the call. Sloga is never on the path.
 */
@CapacitorPlugin(name = "Jellyfin")
class JellyfinPlugin : Plugin() {
    private val executor: ExecutorService = Executors.newCachedThreadPool()

    /** Request headers that cross to the Jellyfin; everything else stays here. */
    private val forwardRequest =
        setOf("authorization", "content-type", "accept", "x-emby-authorization")

    private val allowedMethods = setOf("GET", "HEAD", "POST", "DELETE")

    @PluginMethod
    fun setServers(call: PluginCall) {
        val list = call.getArray("servers")
        if (list == null) {
            call.reject("servers required")
            return
        }
        val specs = ArrayList<JellyfinServers.Spec>()
        for (i in 0 until list.length()) {
            val o = list.optJSONObject(i) ?: continue
            specs.add(
                JellyfinServers.Spec(
                    o.optString("id", ""),
                    o.optString("baseUrl", ""),
                    o.optBoolean("trustSelfSigned", false),
                ),
            )
        }
        val count = JellyfinServers.replace(specs)
        val ret = JSObject()
        ret.put("count", count)
        call.resolve(ret)
    }

    @PluginMethod
    fun request(call: PluginCall) {
        val serverId = call.getString("serverId")
        val path = call.getString("path")
        if (serverId == null || path == null || !path.startsWith("/")) {
            call.reject("bad request")
            return
        }
        val method = (call.getString("method") ?: "GET").uppercase()
        if (method !in allowedMethods) {
            call.reject("method not allowed")
            return
        }
        val entry = JellyfinServers.get(serverId)
        if (entry == null) {
            // Same opaque shape as the interceptor's unknown-id 404.
            call.reject("unknown server")
            return
        }
        val headers = HashMap<String, String>()
        val given = call.getObject("headers")
        if (given != null) {
            for (key in given.keys()) {
                if (key.lowercase() in forwardRequest) {
                    given.getString(key)?.let { headers[key] = it }
                }
            }
        }
        val body = call.getString("body")
        executor.execute {
            var conn: java.net.HttpURLConnection? = null
            try {
                val c = JellyfinServers.open(entry, path)
                conn = c
                c.requestMethod = method
                for ((k, v) in headers) c.setRequestProperty(k, v)
                if (body != null && (method == "POST" || method == "DELETE")) {
                    c.doOutput = true
                    c.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                }
                val status = c.responseCode
                // An unfollowed redirect must not surface: following it
                // natively would escape the saved-servers rule, and handing
                // the Location to the webview would invite the same.
                if (status in 300..399) {
                    c.disconnect()
                    val ret = JSObject()
                    ret.put("status", 502)
                    ret.put("body", "")
                    call.resolve(ret)
                    return@execute
                }
                val stream: InputStream? =
                    try {
                        if (status >= 400) c.errorStream else c.inputStream
                    } catch (e: Exception) {
                        null
                    }
                val text =
                    stream?.use { it.readBytes().toString(charsetOf(c.contentType)) } ?: ""
                c.disconnect()
                val ret = JSObject()
                ret.put("status", status)
                ret.put("body", text)
                call.resolve(ret)
            } catch (e: Exception) {
                try {
                    conn?.disconnect()
                } catch (ignored: Exception) {
                    /* already dead */
                }
                // 526 marks a TLS/certificate failure specifically (the
                // desktop shells' code for the same thing), so the connect
                // flow can offer per-server trust only when trusting would
                // help. Everything else (DNS/refused/timeout) stays opaque.
                if (e is javax.net.ssl.SSLException) {
                    val ret = JSObject()
                    ret.put("status", 526)
                    ret.put("body", "")
                    call.resolve(ret)
                } else {
                    call.reject("network")
                }
            }
        }
    }

    private fun charsetOf(contentType: String?): Charset {
        val marker = "charset="
        val idx = contentType?.lowercase()?.indexOf(marker) ?: -1
        if (idx >= 0) {
            val name = contentType!!.substring(idx + marker.length).substringBefore(';').trim()
            try {
                return Charset.forName(name)
            } catch (e: Exception) {
                /* fall through */
            }
        }
        return Charsets.UTF_8
    }
}
