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
    // Never log plugin call data (would leak attachment plaintext + the
    // session token to logcat).
    loggingBehavior: "none",
  },
};

export default config;
