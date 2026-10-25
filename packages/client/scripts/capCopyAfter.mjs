/**
 * `capacitor:copy:after` dispatcher. Capacitor runs this hook for EVERY
 * platform (`cap copy android`, `cap sync ios`, ...) with the platform in
 * CAPACITOR_PLATFORM_NAME. Both post-copy steps — the main-document CSP
 * injection and the offline transcription-model staging — act on the
 * platform's SYNCED copy of the web assets, so the path must follow the
 * platform. Unknown platform = fail closed (never ship an unpoliced bundle).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

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

// iOS only: `viewport-fit=cover` makes WKWebView extend under the status bar
// and home indicator, so `env(safe-area-inset-*)` (which #root uses) resolves
// to real values; without it they are 0 and the UI sits under the clock.
// It goes into the SYNCED iOS copy only. In the shared index.html it would
// also reach Android, where Capacitor 8 on WebView >= 140 then stops padding
// the WebView by the system bars — an untested layout change there.
if (platform === "ios") {
  const file = `${pub}/index.html`;
  const html = readFileSync(file, "utf8");
  const viewport = /(<meta name="viewport" content=")([^"]*)(")/;
  const match = html.match(viewport);
  if (!match) {
    console.error(
      `[cap-copy-after] FATAL: no viewport meta in ${file} — cannot add viewport-fit=cover`,
    );
    process.exit(1);
  }
  if (!/\bviewport-fit=cover\b/.test(match[2])) {
    writeFileSync(
      file,
      html.replace(viewport, `$1$2, viewport-fit=cover$3`),
      "utf8",
    );
    console.log(`[cap-copy-after] added viewport-fit=cover to ${file}`);
  }
}
