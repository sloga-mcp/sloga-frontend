/**
 * Per-platform E2EE capability rules - pure and dependency-free so
 * `node --test` can load it (the house no-vitest split). `e2ee.ts`,
 * `rtc/state.tsx` and the prejoin hook pass in what they read from
 * Capacitor, the window and the iOS worker probe; the decisions live here,
 * where every platform's answer can be pinned. This module imports neither
 * Capacitor nor the probe.
 *
 * The Capacitor rules fail closed: a platform string this file does not
 * name gets no native E2EE and no webview clipboard access.
 */

/**
 * Whether THIS platform's shell has an AUDITED media-E2EE path (EL1 audit
 * S7, hard exit criterion; EL4 flip, mechanism A). TRUE with no Electron
 * shell at all (Windows Tauri / Android and iOS Capacitor / web —
 * unchanged; iOS is gated by `iosMediaE2EEReady` through its key push), or
 * when the shell's nonce-gated e2ee surface itself advertises the audited
 * capability: `slogaShell.e2ee.mediaE2EE === true`, set only by the Linux
 * shell's preload (platform-gated there, so a future mac build from the
 * shared shell source cannot inherit it — I6). FALSE for any other
 * `slogaShell` (older Linux shells, any unaudited shell) even though
 * insertable streams and the key-push channel both probe TRUE there.
 * Skew fails closed: a new dist over an old shell finds no flag and stays
 * closed, an old dist over a new shell never consults it (I9
 * defense-in-depth beyond the one-artifact rule). The real trust boundary
 * is contextIsolation on Electron (a page cannot mint the preload flag);
 * on web, fabricating the whole surface — flag included — requires
 * page-script execution, which is already total renderer compromise, and
 * the failure direction of a fabricated-but-dead bridge is a broken loud
 * call, never a false "encrypted" claim (chips derive from the
 * media-plane witness, I10).
 */
export function platformMediaE2EESupported(): boolean {
  if (!("slogaShell" in window)) return true;
  const shell = (window as { slogaShell?: { e2ee?: { mediaE2EE?: unknown } } })
    .slogaShell;
  return shell?.e2ee?.mediaE2EE === true;
}

/**
 * Whether this shell could carry encrypted calls: it can receive native
 * call-key pushes AND its media path is audited. This is the ONE predicate
 * for that question (plan D7, audit MINOR 17). `shellSupported` in
 * `rtc/state.tsx` and the bridge's MLS KeyPackage prepublish both call it,
 * so a shell that cannot encrypt calls never publishes KeyPackages either.
 *
 * iOS passes `platformMediaE2EESupported()` (no `slogaShell` there, so it
 * is true), which leaves the whole iOS answer to `keyPushAvailable`. The
 * iOS transport's key push is `iosMediaE2EEReady(...)` below: true only
 * for a build that carries the call surface, with the guard installed, on a
 * WebKit that has script transforms, after the worker probe passed. Any
 * term missing reads false, and the call is honestly unsupported.
 */
export function mediaE2EEPlatformSupported(keyPushAvailable: boolean): boolean {
  return keyPushAvailable && platformMediaE2EESupported();
}

/** What the iOS shell and webview report, read by the caller (plan D6/D8). */
export interface IosMediaE2EEInput {
  capsMediaE2EE: unknown;
  pluginPresent: boolean;
  scriptTransform: boolean;
  probe: "pending" | "pass" | "fail";
}

/**
 * Whether an iOS build may carry encrypted calls (plan D6 + D8, C4, W3
 * MUST 1). All four terms are required; each one fails closed:
 *
 * - `capsMediaE2EE` is `window.__slogaIosCaps?.mediaE2EE`, the frozen
 *   document-start page script the shell installs from Info.plist
 *   `SlogaMediaE2EE` (C4). It says what the BUILD carries (Debug yes,
 *   Release no until the release go). A phase-1 build has no caps object
 *   (undefined). Only the literal `true` counts; `1`, `"true"` or an object
 *   read false.
 * - `pluginPresent` is `Capacitor.isPluginAvailable("E2ee")`. The caps flag
 *   only describes the build; the plugin being registered is what says the
 *   native guard actually installed.
 * - `scriptTransform` is `typeof RTCRtpScriptTransform !== "undefined"`.
 *   The deployment target stays iOS 15.0, and 15.0-15.3 have no script
 *   transform, so those devices read "unsupported" honestly instead of
 *   building an E2EE Room that cannot encrypt.
 * - `probe` is the cached D8 worker probe run at app start: the shipped
 *   worker must answer `initAck` and its first decode-witness heartbeat
 *   with `rte === "function"`. Only `"pass"` counts. Capability is fixed
 *   synchronously at Room construction and at KeyPackage pre-publish, so a
 *   probe that has not finished (`"pending"`) is a no, the same as
 *   `"fail"`: the copy says not available on this device, never plaintext
 *   under an encrypted claim. Inside a call the existing fail-safe stays.
 */
export function iosMediaE2EEReady(input: IosMediaE2EEInput): boolean {
  return (
    input.capsMediaE2EE === true &&
    input.pluginPresent === true &&
    input.scriptTransform === true &&
    input.probe === "pass"
  );
}

/**
 * Whether this SHELL could carry encrypted calls, independent of this
 * install's encryption setup and of the "Encrypt my calls" toggle. THE one
 * predicate for that question (plan D6): `shellSupported` in
 * `rtc/state.tsx` (before it folds in `e2eeCallsEnabled`) and the prejoin
 * hook's `wouldEncrypt` both call it, so the prejoin copy can no longer
 * disagree with the Room it is describing.
 *
 * - `e2eeSupported` is livekit's `isE2EESupported()` (insertable streams or
 *   `RTCRtpScriptTransform`).
 * - `nativeE2EEAvailable` is whether a native E2EE layer is present.
 * - `bridgePlatformSupported` is the bridge's `mediaE2EEPlatformSupported()`
 *   (key push AND an audited media path; on iOS `iosMediaE2EEReady`). A
 *   missing bridge passes false.
 *
 * Device and toggle terms stay with the callers, so the call chrome can
 * still tell "this shell can never encrypt" from "not set up here"
 * (`e2eeDeviceReadiness`).
 */
export function shellMediaE2EESupported(input: {
  e2eeSupported: boolean;
  nativeE2EEAvailable: boolean;
  bridgePlatformSupported: boolean;
}): boolean {
  return (
    input.e2eeSupported === true &&
    input.nativeE2EEAvailable === true &&
    input.bridgePlatformSupported === true
  );
}

/**
 * Whether a Capacitor build has a native E2EE layer. Android always ships
 * the plugin. iOS has it only when the native E2ee plugin is compiled in,
 * so an iOS build without it stays web-mode instead of failing every call.
 * Any other platform, and the plain web build, has none.
 */
export function capacitorNativeE2EE(
  isNative: boolean,
  platform: string,
  pluginAvailable: (name: string) => boolean,
): boolean {
  if (!isNative) return false;
  if (platform === "android") return true;
  if (platform === "ios") return pluginAvailable("E2ee");
  return false;
}

/**
 * The webview URL a decrypted attachment renders from (never carries keys).
 * iOS uses the `e2ee-att://att/<id>/<idx>` custom scheme, served natively by
 * a WKURLSchemeHandler (the same shape as the Electron shell). Android uses
 * the same-origin `/_e2ee-att/...` path its WebViewClient intercepts before
 * the asset server.
 */
export function capacitorAttachmentUrl(
  platform: string,
  messageId: string,
  idx: number,
): string {
  if (platform === "ios") return `e2ee-att://att/${messageId}/${idx}`;
  return `/_e2ee-att/${messageId}/${idx}`;
}

/**
 * Whether the webview may copy a decrypted attachment image to the
 * clipboard itself. Only Android, whose attachment URL is same-origin. Not
 * iOS: the webview clipboard there is the general pasteboard, which
 * Universal Clipboard syncs to the user's other Apple devices (plan D6), so
 * the copy goes through the native `e2ee_attachment_copy_image` command and
 * its local-only pasteboard instead. Any other platform gets false.
 */
export function capacitorClipboardImageInWebview(platform: string): boolean {
  return platform === "android";
}

/**
 * Whether the webview couriers a recovery bundle that the native recovery
 * surface kept after the page that opened it went away (audit M2). Only
 * iOS: the recovery sheet can outlive a WebContent reload, and the plugin
 * then keeps the minted bundle and emits `backupBundleWaiting`. Android is
 * left as it was (no event, no new native call); the desktop shells courier
 * through their own `e2ee:recovery-complete` event. Any other platform gets
 * false.
 */
export function capacitorCouriersOrphanedRecovery(platform: string): boolean {
  return platform === "ios";
}
