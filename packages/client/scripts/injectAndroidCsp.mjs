/**
 * Inject the Android main-document Content-Security-Policy (media E2EE
 * slice 6.7b, closes audit MED-1) into the SYNCED Capacitor web assets —
 * android/app/src/main/assets/public/index.html — never into dist/ (the web
 * deploy must not carry this policy; web is served behind Caddy, and the
 * desktop shell gets its own CSP from tauri.conf.json `app.security.csp`).
 *
 * Wired as the `capacitor:copy:after` npm hook so EVERY `cap copy`/`cap sync`
 * produces a CSP-carrying Android bundle (build:android included) — a manual
 * `cap sync android` cannot silently ship an unpoliced APK.
 *
 * Placement contract (load-bearing): the <meta> is inserted immediately after
 * the literal `<head>`. At runtime Capacitor's JSInjector inserts its inline
 * native-bridge <script> at indexOf("<head>") + 6 — i.e. BEFORE this meta —
 * and a meta-delivered CSP does not apply to script elements parsed before
 * it. That is the ONLY inline script the policy exempts, and it is
 * installer-signed native-owned content (the same trust class as the shell).
 * Everything parsed after the meta — the app bundle, DOM-injected scripts
 * from any XSS foothold, all runtime fetches — is policed. This is why
 * script-src carries NO 'unsafe-inline'.
 *
 * Policy provenance: modeled on the desktop 6.2b policy (acutest-desktop
 * src-tauri/tauri.conf.json), Android deltas:
 *  - no ipc:/ipc.localhost (Tauri-only) and no e2ee-att.localhost — Android's
 *    E2EE attachment renderer is the same-origin /_e2ee-att/ interceptor
 *    (E2eeWebViewClient.kt), covered by 'self';
 *  - no frame-ancestors (ignored in meta-delivered CSP; the WebView is always
 *    top-level);
 *  - + hCaptcha vendor origins (login captcha loads remote script by design).
 *    The sitekey may be blank today, but captcha is a CONFIG-flippable server
 *    feature (`VITE_HCAPTCHA_SITEKEY`) reachable with no code change, so the
 *    shared Android build must not white-screen when it is enabled. hCaptcha
 *    is a verification service, not an attacker-account data store, so its
 *    connect-src carries no useful key read-back channel (the residual
 *    supply-chain risk is the documented invariant-6 tradeoff);
 *  - NO Stripe origins (crypto gate 6.7b MED-1): the Subscriptions settings
 *    section is `hidden: true` (UserSettings.tsx) on EVERY platform, so
 *    Stripe.js never mounts — matching the desktop 6.2b CSP, which also omits
 *    Stripe. Allowing `api.stripe.com` in connect-src would be an
 *    attacker-READABLE exfil sink (POST frame keys under the attacker's own
 *    publishable key, read back from their Stripe account) — the exact channel
 *    the Sentry exclusion below forbids, for a feature with zero live function.
 *    If subscriptions are ever un-hidden on Android, re-add js.stripe.com
 *    (script-src), api.stripe.com (connect-src), js/hooks.stripe.com
 *    (frame-src) AND re-run this gate on that exposure;
 *  - + connect-src https://translate.googleapis.com (message translation);
 *  - + manifest-src 'self' (index.html links the PWA manifest);
 *  - Sentry ingest is DELIBERATELY absent from connect-src: a *.ingest
 *    allowance would hand an XSS foothold a data-exfil channel. If Sentry is
 *    enabled on Android, route it through a SERVER-SIDE same-origin proxy at
 *    app.sloga.gg (a relative VITE_SENTRY_TUNNEL cannot reach Sentry — 'self'
 *    is the static asset origin https://localhost, not a proxy).
 *
 * script-src rule (gate item): NO attacker-reachable origin — only 'self',
 * wasm, and the fixed hCaptcha vendor hosts. worker-src 'self' blob:
 * is REQUIRED (livekit e2ee worker + PWA SW ride 'self'; blob workers from
 * vendored libs ride blob:).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval' https://hcaptcha.com https://*.hcaptcha.com",
  "style-src 'self' 'unsafe-inline' https://hcaptcha.com https://*.hcaptcha.com",
  "img-src 'self' data: blob: https://app.sloga.gg",
  "media-src 'self' blob: https://app.sloga.gg",
  "font-src 'self' data:",
  "connect-src 'self' blob: https://app.sloga.gg wss://app.sloga.gg https://translate.googleapis.com https://hcaptcha.com https://*.hcaptcha.com",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "frame-src https://hcaptcha.com https://*.hcaptcha.com https://www.youtube.com https://www.youtube-nocookie.com https://player.twitch.tv https://open.spotify.com https://w.soundcloud.com https://bandcamp.com https://new.lightspeed.tv",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const MARKER_START = "<!-- android-csp:start -->";
const MARKER_END = "<!-- android-csp:end -->";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(
  root,
  "android",
  "app",
  "src",
  "main",
  "assets",
  "public",
  "index.html",
);

if (!existsSync(target)) {
  console.error(
    `[android-csp] FATAL: ${target} not found — run after cap copy/sync`,
  );
  process.exit(1);
}

let html = readFileSync(target, "utf8");

// Idempotent: strip a previously injected block before re-inserting.
const start = html.indexOf(MARKER_START);
if (start !== -1) {
  const end = html.indexOf(MARKER_END);
  if (end === -1) {
    console.error(
      "[android-csp] FATAL: found start marker without end marker — refusing to edit",
    );
    process.exit(1);
  }
  html = html.slice(0, start) + html.slice(end + MARKER_END.length);
}

const headIdx = html.indexOf("<head>");
if (headIdx === -1) {
  console.error(
    "[android-csp] FATAL: no literal <head> in index.html — Capacitor injection anchor missing",
  );
  process.exit(1);
}

const meta = `${MARKER_START}<meta http-equiv="Content-Security-Policy" content="${CSP}">${MARKER_END}`;
html =
  html.slice(0, headIdx + "<head>".length) +
  meta +
  html.slice(headIdx + "<head>".length);

writeFileSync(target, html);
console.log(
  "[android-csp] injected main-document CSP into android assets index.html",
);
