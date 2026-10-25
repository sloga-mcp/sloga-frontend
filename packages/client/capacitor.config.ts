import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "gg.sloga.app",
  appName: "Sloga",
  webDir: "dist",
  android: {
    // No npm Capacitor plugin ships on Android. The iOS shell depends on
    // @capacitor/push-notifications (APNs), whose Android module brings in
    // firebase-messaging and a second FCM MessagingService: it would compete
    // with SlogaMessagingService and put Firebase into the Google-free build.
    // Android's native plugins are registered in MainActivity, not from npm.
    includePlugins: [],
    // E2EE (slice-4 gate): the WebView origin can reach decrypted DM
    // history and the /_e2ee-att attachment renderer, so the release build
    // must NOT be debuggable and must not load cleartext subresources — a
    // local attacker with ADB/devtools would otherwise read exactly the
    // plaintext E2EE exists to protect. Both are re-enabled for DEBUG
    // builds only, in MainActivity under BuildConfig.DEBUG.
    allowMixedContent: false,
    // MUST stay false, and it is NOT one of the E2EE controls above/below.
    // `captureInput: true` makes Capacitor hand the IME a bare
    // `BaseInputConnection(webView, false)` instead of the WebView's real one
    // and never fills in the EditorInfo, so the keyboard sees a TYPE_NULL,
    // non-editor field. Tap typing survives because it degrades to raw key
    // events, but anything needing a real editor connection does not —
    // Gboard/SwiftKey gesture ("swipe") typing committed only the last key
    // under the finger. Arrived with the initial Capacitor scaffold in
    // ab91f939, never as a deliberate choice.
    captureInput: false,
    webContentsDebuggingEnabled: false,
    // Never log plugin call data (would leak attachment plaintext, the
    // session token, AND — since media E2EE 6.7a — the `e2ee_call_frame_keys`
    // HKDF key material that rides the resolve payload) to logcat. Both this
    // and webContentsDebuggingEnabled:false are REQUIRED controls on the
    // frame-key egress path — do not flip them "temporarily" to debug.
    loggingBehavior: "none",
  },
  ios: {
    // E2EE: the WebView origin can reach decrypted DM history, the e2ee-att:
    // attachment renderer output and the session token, so it must not be
    // Web-Inspector-able: Safari Web Inspector would read exactly the
    // plaintext E2EE exists to protect. Set explicitly, false also wins in
    // Debug builds (Capacitor only turns inspection on for DEBUG /
    // CAPACITOR_DEBUG when this key is unset). Device legs run on a Debug
    // build are recorded as such in the leg record.
    webContentsDebuggingEnabled: false,
    // Never log plugin call data (attachment plaintext, the session token)
    // to the device console. Both this and webContentsDebuggingEnabled:false
    // are REQUIRED controls — do not flip them "temporarily" to debug.
    loggingBehavior: "none",
  },
};

export default config;
