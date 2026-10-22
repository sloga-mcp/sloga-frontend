/**
 * Inject the Android main-document Content-Security-Policy (media E2EE
 * slice 6.7b, closes audit MED-1) into the SYNCED Capacitor web assets —
 * android/app/src/main/assets/public/index.html — never into dist/ (the web
 * deploy must not carry this policy; web is served behind Caddy, and the
 * desktop shell gets its own CSP from tauri.conf.json `app.security.csp`).
 * The iOS shell gets the same policy with one delta (see "iOS" below) in
 * ios/App/App/public/index.html.
 *
 * Wired as the `capacitor:copy:after` npm hook so EVERY `cap copy`/`cap sync`
 * produces a CSP-carrying Android bundle (build:android included) — a manual
 * `cap sync android` cannot silently ship an unpoliced APK.
 *
 * Placement contract (load-bearing): the <meta> is inserted immediately after
 * the literal `<head>`. At runtime Capacitor Android's JSInjector inserts its
 * inline native-bridge <script> at indexOf("<head>") + 6 — i.e. BEFORE this
 * meta — and a meta-delivered CSP does not apply to script elements parsed
 * before it. That is the ONLY inline script the policy exempts, and it is
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
 *    supply-chain risk is the documented invariant-6 tradeoff). The foss
 *    build omits these origins from all four directives that carry them
 *    (script-src, style-src, connect-src, frame-src). That is harmless ONLY
 *    while VITE_HCAPTCHA_SITEKEY is blank: the widget renders only for a
 *    non-empty build-time sitekey (the `props.captcha` Show in
 *    auth/src/flows/Form.tsx; env.ts HCAPTCHA_SITEKEY), and the live .env
 *    sets it empty. The foss wave gate asserts `HCAPTCHA_SITEKEY:""` in its
 *    dist; a foss build with a sitekey would load a login captcha this
 *    policy blocks;
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
 *    the foss build omits it (its translation is off by the build flag
 *    VITE_CFG_ENABLE_GOOGLE_TRANSLATE=false, and this is the second fence);
 *  - + connect-src https://api.drand.sh (timelock messages): tlock only ever
 *    GETs public beacon values — chain info and a round's randomness — with
 *    the round number in the PATH and no request body. It is strictly lower
 *    risk than the translate origin already allowed above: no user content is
 *    sent, and the response is a global public value identical for everyone,
 *    so it is not an attacker-READABLE exfil sink the way Stripe/Sentry would
 *    be. Read-only, no account, no back-channel;
 *  - + manifest-src 'self' (index.html links the PWA manifest);
 *  - Sentry ingest is DELIBERATELY absent from connect-src: a *.ingest
 *    allowance would hand an XSS foothold a data-exfil channel. If Sentry is
 *    enabled on Android, route it through a SERVER-SIDE same-origin proxy at
 *    app.sloga.gg (a relative VITE_SENTRY_TUNNEL cannot reach Sentry — 'self'
 *    is the static asset origin https://localhost, not a proxy).
 *
 * script-src rule (gate item): NO attacker-reachable origin — only 'self',
 * wasm, and the fixed hCaptcha vendor hosts (the foss build: only 'self' and
 * wasm). worker-src 'self' blob: is REQUIRED (livekit e2ee worker + PWA SW
 * ride 'self'; blob workers from vendored libs ride blob:).
 *
 * Foss variant (F-Droid build): with SLOGA_FDROID=1 exactly in the
 * environment of `cap sync android` (Capacitor spreads process.env into this
 * hook), the Google-free policy drops FOSS_OMITTED_ORIGINS from every
 * directive that carries them. YouTube stays in frame-src for embeds the user
 * taps to load. Unset, or any other value, injects the standard policy
 * byte-for-byte unchanged. The foss variant is Android-only: SLOGA_FDROID=1
 * with the ios platform is a FATAL, since no iOS foss build exists and the
 * mix can only be a mistaken invocation (fail closed rather than guess).
 *
 * iOS: the standard (non-foss) policy plus ONE source, `e2ee-att:`, appended
 * to img-src and media-src only. The iOS E2EE attachment renderer is a
 * WKURLSchemeHandler on the custom scheme e2ee-att
 * (e2ee-att://att/<ULID>/<idx>), a separate origin that 'self' does not
 * cover. The token is deliberately absent from every other directive:
 *  - connect-src: the webview never fetches attachment plaintext; it only
 *    hands an <img>/<video>/<audio> a URL the native handler answers;
 *  - frame-src: an embed must never be able to frame an attachment (plan D6);
 *  - default-src, script-src, style-src, worker-src, object-src and the rest:
 *    decrypted bytes are never code, styles, workers or plugins.
 * The iOS app origin is capacitor://localhost (Capacitor's default scheme and
 * hostname, CAPInstanceDescriptor.swift; capacitor.config.ts sets neither
 * server.iosScheme nor server.hostname), and 'self' is that origin, so the
 * bundle, the manifest and the workers ride 'self' as they do on Android.
 * Placement on iOS differs from the Android contract above: Capacitor iOS
 * (@capacitor/ios 8.4.3, JSExport.swift) does not splice its bridge into the
 * HTML; it installs it as WKUserScripts at .atDocumentStart,
 * forMainFrameOnly: true. On iOS the literal <head> is only this script's
 * insertion anchor, and no inline script is exempted by placement. That
 * WebKit runs those user scripts outside the page CSP (so script-src still
 * needs no 'unsafe-inline') is WebKit behavior, not something these sources
 * show; it is verified on the Simulator in G12.
 *
 * Platform: CAPACITOR_PLATFORM_NAME ("android" | "ios"), which Capacitor sets
 * for the hook and capCopyAfter.mjs passes through. Unset = "android" (the
 * legacy bare invocation); set to anything else, empty included = FATAL. The
 * target path is cross-checked: an `ios` path segment with a non-ios
 * platform, an `android` segment with a non-android platform, or both
 * segments at once = FATAL, so neither policy can land in the other bundle.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const DIRECTIVES = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval' https://hcaptcha.com https://*.hcaptcha.com",
  "style-src 'self' 'unsafe-inline' https://hcaptcha.com https://*.hcaptcha.com",
  "img-src 'self' data: blob: https://app.sloga.gg",
  "media-src 'self' blob: https://app.sloga.gg",
  "font-src 'self' data:",
  // *.sloga.gg: regional LiveKit media nodes (br1.sloga.gg first) are
  // separate origins the voice node picker probes and then signals to. Every
  // name under sloga.gg is Sloga-operated — no attacker-readable sink is
  // added — and a wildcard means a new region never needs a shell release.
  "connect-src 'self' blob: https://app.sloga.gg wss://app.sloga.gg https://*.sloga.gg wss://*.sloga.gg https://translate.googleapis.com https://api.drand.sh https://hcaptcha.com https://*.hcaptcha.com",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "frame-src https://hcaptcha.com https://*.hcaptcha.com https://www.youtube.com https://www.youtube-nocookie.com https://player.twitch.tv https://open.spotify.com https://w.soundcloud.com https://bandcamp.com https://new.lightspeed.tv",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
];

// Only the exact value "1" selects the foss policy.
const FOSS = process.env.SLOGA_FDROID === "1";
// Google (translate) and hCaptcha origins, dropped from EVERY directive in
// the foss policy. Matched as whole source tokens, never as substrings.
const FOSS_OMITTED_ORIGINS = new Set([
  "https://translate.googleapis.com",
  "https://hcaptcha.com",
  "https://*.hcaptcha.com",
]);

// iOS only: the e2ee-att scheme handler's source, and the ONLY directives it
// may appear in (see "iOS" above).
const IOS_ATTACHMENT_SOURCE = "e2ee-att:";
const IOS_ATTACHMENT_DIRECTIVES = new Set(["img-src", "media-src"]);

const PLATFORMS = ["android", "ios"];
const requested = process.env.CAPACITOR_PLATFORM_NAME;
// Unset = the legacy bare-invocation default. Empty or unknown = fail closed.
const platform = requested === undefined ? "android" : requested;
if (!PLATFORMS.includes(platform)) {
  console.error(
    `[inject-csp] FATAL: unsupported CAPACITOR_PLATFORM_NAME=${requested} — expected android or ios`,
  );
  process.exit(1);
}
const tag = `[${platform}-csp]`;

if (platform === "ios" && FOSS) {
  console.error(
    `${tag} FATAL: SLOGA_FDROID=1 with CAPACITOR_PLATFORM_NAME=ios — the foss policy is Android-only; unset SLOGA_FDROID for an iOS sync`,
  );
  process.exit(1);
}

function platformDirectives() {
  if (platform === "ios") {
    return DIRECTIVES.map((directive) =>
      IOS_ATTACHMENT_DIRECTIVES.has(directive.split(" ")[0])
        ? `${directive} ${IOS_ATTACHMENT_SOURCE}`
        : directive,
    );
  }
  if (FOSS) {
    return DIRECTIVES.map((directive) =>
      directive
        .split(" ")
        .filter((source) => !FOSS_OMITTED_ORIGINS.has(source))
        .join(" "),
    );
  }
  return DIRECTIVES;
}

const CSP = platformDirectives().join("; ");

// The markers stay `android-csp` on every platform: the idempotent strip
// below must find blocks written by earlier runs, and the Android packaging
// gate (android/app/build.gradle) counts this exact start marker.
const MARKER_START = "<!-- android-csp:start -->";
const MARKER_END = "<!-- android-csp:end -->";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Target = the platform's synced index.html. Passed explicitly by
// scripts/capCopyAfter.mjs (android or ios); the bare-invocation default keeps
// the Android path so older call sites stay correct.
const target = process.argv[2]
  ? join(root, process.argv[2])
  : join(
      root,
      "android",
      "app",
      "src",
      "main",
      "assets",
      "public",
      "index.html",
    );

// Cross-check the target against the platform, by path segment
// (case-insensitive: the macOS filesystem is).
const segments = relative(root, target).toLowerCase().split(/[\\/]/);
const pathPlatforms = PLATFORMS.filter((name) => segments.includes(name));
if (
  pathPlatforms.length > 1 ||
  (pathPlatforms.length === 1 && pathPlatforms[0] !== platform)
) {
  console.error(
    `${tag} FATAL: target ${target} does not belong to platform ${platform} — refusing to inject this policy there`,
  );
  process.exit(1);
}

if (!existsSync(target)) {
  console.error(`${tag} FATAL: ${target} not found — run after cap copy/sync`);
  process.exit(1);
}

let html = readFileSync(target, "utf8");

// Idempotent: strip a previously injected block before re-inserting.
const start = html.indexOf(MARKER_START);
if (start !== -1) {
  const end = html.indexOf(MARKER_END);
  if (end === -1) {
    console.error(
      `${tag} FATAL: found start marker without end marker — refusing to edit`,
    );
    process.exit(1);
  }
  html = html.slice(0, start) + html.slice(end + MARKER_END.length);
}

const headIdx = html.indexOf("<head>");
if (headIdx === -1) {
  console.error(
    `${tag} FATAL: no literal <head> in index.html — Capacitor injection anchor missing`,
  );
  process.exit(1);
}

const meta = `${MARKER_START}<meta http-equiv="Content-Security-Policy" content="${CSP}">${MARKER_END}`;
html =
  html.slice(0, headIdx + "<head>".length) +
  meta +
  html.slice(headIdx + "<head>".length);

writeFileSync(target, html);
if (platform === "ios") {
  console.log(`${tag} injected main-document CSP into ios public index.html`);
} else {
  console.log(
    FOSS
      ? "[android-csp] injected foss (SLOGA_FDROID=1) main-document CSP into android assets index.html"
      : "[android-csp] injected main-document CSP into android assets index.html",
  );
}
