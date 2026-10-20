/**
 * `capacitor:copy:after` dispatcher. Capacitor runs this hook for EVERY
 * platform (`cap copy android`, `cap sync ios`, ...) with the platform in
 * CAPACITOR_PLATFORM_NAME. Both post-copy steps — the main-document CSP
 * injection and the offline transcription-model staging — act on the
 * platform's SYNCED copy of the web assets, so the path must follow the
 * platform. Unknown platform = fail closed (never ship an unpoliced bundle).
 */
import { execFileSync } from "node:child_process";

const PUBLIC_DIR = {
  android: "android/app/src/main/assets/public",
  ios: "ios/App/App/public",
};

const platform = process.env.CAPACITOR_PLATFORM_NAME;
const pub = PUBLIC_DIR[platform];
if (!pub) {
  console.error(
    `[cap-copy-after] FATAL: unsupported CAPACITOR_PLATFORM_NAME=${platform} — add it to PUBLIC_DIR`,
  );
  process.exit(1);
}

const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });
run("node", ["scripts/injectAndroidCsp.mjs", `${pub}/index.html`]);
run("bash", ["scripts/stage-transcription-models.sh", pub]);
