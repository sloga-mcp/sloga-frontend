import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.acutest.app",
  appName: "Sloga",
  webDir: "dist",
  android: {
    // E2EE (slice-4 gate): the WebView origin can reach decrypted DM
    // history and the /_e2ee-att attachment renderer, so the release build
    // must NOT be debuggable and must not load cleartext subresources — a
    // local attacker with ADB/devtools would otherwise read exactly the
    // plaintext E2EE exists to protect. Both are re-enabled for DEBUG
    // builds only, in MainActivity under BuildConfig.DEBUG.
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
    // Never log plugin call data (would leak attachment plaintext, the
    // session token, AND — since media E2EE 6.7a — the `e2ee_call_frame_keys`
    // HKDF key material that rides the resolve payload) to logcat. Both this
    // and webContentsDebuggingEnabled:false are REQUIRED controls on the
    // frame-key egress path — do not flip them "temporarily" to debug.
    loggingBehavior: "none",
  },
};

export default config;
