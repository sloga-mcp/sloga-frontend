package com.acutest.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URL;

/**
 * Tells the server that the user pressed Decline on a ringing notification.
 *
 * The press can arrive when this broadcast is the only part of the app that
 * is running, so the web layer cannot be relied on to send it. Without it the
 * user's other devices keep ringing and, in a direct message, the caller
 * never learns that the call was declined.
 *
 * The request is PUT {api_url}/channels/{channelId}/decline_call with the
 * session token the web layer stored at its last push subscribe, and no
 * body. It is sent once and whatever the server answers is final. A running
 * web layer sends the same request itself; the server acts on the first of
 * the two and answers the other with an error, which is expected.
 *
 * No method here throws, and nothing here logs the token, the chat id or the
 * address.
 */
final class CallDeclinePoster {
    private static final String TAG = "SlogaCalls";

    private static final String PREFS = "sloga_push";
    private static final int CHANNEL_ID_LENGTH = 26;
    private static final int CONNECT_TIMEOUT_MS = 4000;
    private static final int READ_TIMEOUT_MS = 4000;
    // A broadcast receiver has about ten seconds after goAsync(). The two
    // timeouts above do not bound the whole request: a name lookup has no
    // timeout of its own, the connect timeout starts again for every address
    // a host has, and the read timeout starts again with every byte that
    // arrives. So the broadcast is finished after this long whatever the
    // request is doing.
    private static final long DEADLINE_MS = 8500L;

    private CallDeclinePoster() {}

    /**
     * Send the decline for this chat, off the caller's thread.
     *
     * pendingResult is the broadcast kept open by goAsync(), or null when
     * there is none. It is finished exactly once on every path: before this
     * method returns when nothing is sent (no usable chat id, no stored
     * address or token, an address that is not allowed), and otherwise when
     * the request is over or DEADLINE_MS has passed.
     */
    static void post(
            Context ctx, String channelId, BroadcastReceiver.PendingResult pendingResult) {
        boolean handedOver = false;
        try {
            if (ctx == null || !isChannelId(channelId)) return;
            SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String sessionToken = prefs.getString("session_token", null);
            String target = declineUrl(prefs.getString("api_url", null), channelId);
            if (target == null || sessionToken == null || sessionToken.isEmpty()) return;

            new Thread(
                    () -> sendWithinDeadline(target, sessionToken, pendingResult),
                    "sloga-decline").start();
            handedOver = true;
        } catch (Throwable e) {
            // Throwable, because starting a thread fails with an Error when
            // the process cannot have another one.
            Log.w(TAG, "decline post failed: " + e.getClass().getSimpleName());
        } finally {
            if (!handedOver) finish(pendingResult);
        }
    }

    /** A chat id is 26 characters, each one a digit or an upper-case letter. */
    static boolean isChannelId(String id) {
        if (id == null || id.length() != CHANNEL_ID_LENGTH) return false;
        for (int i = 0; i < CHANNEL_ID_LENGTH; i++) {
            char c = id.charAt(i);
            boolean digit = c >= '0' && c <= '9';
            boolean upper = c >= 'A' && c <= 'Z';
            if (!digit && !upper) return false;
        }
        return true;
    }

    /**
     * Whether the session token may be sent to this API address.
     *
     * Only https is allowed, so the token never travels in the clear. Plain
     * http is allowed for the three names a development server on the same
     * machine goes by, which are also the only ones the debug build permits
     * cleartext to.
     */
    static boolean isAllowedApiUrl(String apiUrl) {
        if (apiUrl == null || apiUrl.isEmpty()) return false;
        // URL parsers disagree about where the host ends once one of these
        // characters is involved, and an API address has no sign-in part, no
        // query and no fragment. Refusing them keeps the host checked below
        // the same as the host the request is sent to.
        for (int i = 0; i < apiUrl.length(); i++) {
            char c = apiUrl.charAt(i);
            if (c <= ' ' || c >= 0x7f || c == '\\' || c == '@' || c == '?' || c == '#') {
                return false;
            }
        }
        try {
            URI uri = new URI(apiUrl);
            String scheme = uri.getScheme();
            String host = uri.getHost();
            if (scheme == null || host == null || host.isEmpty()) return false;
            if (uri.getRawUserInfo() != null) return false;
            if ("https".equalsIgnoreCase(scheme)) return true;
            if (!"http".equalsIgnoreCase(scheme)) return false;
            return "localhost".equalsIgnoreCase(host)
                    || "127.0.0.1".equals(host)
                    || "10.0.2.2".equals(host);
        } catch (URISyntaxException | RuntimeException e) {
            return false;
        }
    }

    /**
     * The address the decline goes to, or null when nothing may be sent: the
     * chat id is not a chat id, or the stored API address is missing or not
     * allowed. Trailing slashes on the API address are dropped first.
     */
    static String declineUrl(String apiUrl, String channelId) {
        if (apiUrl == null || !isChannelId(channelId)) return null;
        int end = apiUrl.length();
        while (end > 0 && apiUrl.charAt(end - 1) == '/') end--;
        String base = apiUrl.substring(0, end);
        if (!isAllowedApiUrl(base)) return null;
        return base + "/channels/" + channelId + "/decline_call";
    }

    /**
     * Runs the request on a thread of its own and waits for it, but no longer
     * than DEADLINE_MS. This is the one place a handed-over broadcast is
     * finished, so it is finished once however the request ends.
     */
    private static void sendWithinDeadline(
            String target, String sessionToken, BroadcastReceiver.PendingResult pendingResult) {
        try {
            Request request = new Request(target, sessionToken);
            Thread sender = new Thread(request, "sloga-decline-put");
            sender.start();
            sender.join(DEADLINE_MS);
            if (sender.isAlive()) {
                request.abandon();
                Log.w(TAG, "decline post failed: no answer in time");
            }
        } catch (Throwable e) {
            Log.w(TAG, "decline post failed: " + e.getClass().getSimpleName());
        } finally {
            finish(pendingResult);
        }
    }

    private static void finish(BroadcastReceiver.PendingResult pendingResult) {
        if (pendingResult == null) return;
        try {
            pendingResult.finish();
        } catch (RuntimeException e) {
            // finish() throws when the broadcast is already finished, and
            // then there is nothing left to do.
        }
    }

    /** One PUT. It reads the status and nothing else, and never retries. */
    private static final class Request implements Runnable {
        private final String target;
        private final String sessionToken;
        private volatile HttpURLConnection connection;
        private volatile boolean abandoned;

        Request(String target, String sessionToken) {
            this.target = target;
            this.sessionToken = sessionToken;
        }

        @Override
        public void run() {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(target).openConnection();
                connection = conn;
                if (abandoned) return;
                conn.setRequestMethod("PUT");
                conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
                conn.setReadTimeout(READ_TIMEOUT_MS);
                // A redirect would add a second connect and read on top of
                // the first, and Android sends custom headers along to the
                // host it is redirected to, which would hand that host the
                // session token.
                conn.setInstanceFollowRedirects(false);
                conn.setRequestProperty("X-Session-Token", sessionToken);
                // A PUT has to say how long its body is. This one is empty,
                // so the stream is opened and closed with nothing written.
                conn.setDoOutput(true);
                conn.setFixedLengthStreamingMode(0);
                conn.getOutputStream().close();
                int status = conn.getResponseCode();
                if (status < 200 || status >= 300) {
                    Log.w(TAG, "decline post answered HTTP " + status);
                }
            } catch (Exception e) {
                // The class name only. An exception message from the network
                // stack can carry the host name.
                if (!abandoned) {
                    Log.w(TAG, "decline post failed: " + e.getClass().getSimpleName());
                }
            } finally {
                if (conn != null) conn.disconnect();
            }
        }

        /**
         * Stop a request that ran past the deadline. Disconnecting closes the
         * socket under a blocked connect or read. It is also there so that a
         * request still waiting for its name lookup is dropped rather than
         * sent late, when it could land on a newer ring in the same chat.
         * How far a late request is stopped is up to the platform's HTTP
         * stack, so this is an effort and not a promise.
         */
        void abandon() {
            abandoned = true;
            HttpURLConnection conn = connection;
            if (conn == null) return;
            try {
                conn.disconnect();
            } catch (RuntimeException e) {
                // Best effort. The broadcast is finished either way.
            }
        }
    }
}
