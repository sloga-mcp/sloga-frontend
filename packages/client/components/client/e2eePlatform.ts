/**
 * Per-platform E2EE capability rules - pure and dependency-free so
 * `node --test` can load it (the house no-vitest split). `e2ee.ts` and
 * `rtc/state.tsx` pass in what they read from Capacitor and the window; the
 * decisions live here, where every platform's answer can be pinned.
 *
 * The Capacitor rules fail closed: a platform string this file does not
 * name gets no native E2EE and no webview clipboard access.
 */

/**
 * Whether THIS platform's shell has an AUDITED media-E2EE path (EL1 audit
 * S7, hard exit criterion; EL4 flip, mechanism A). TRUE with no Electron
 * shell at all (Windows Tauri / Android Capacitor / web — unchanged), or
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
 * iOS passes `platformMediaE2EESupported()` (no `slogaShell` there), so on
 * iOS the answer rests on `keyPushAvailable` being false. Keep it false
 * there until iOS media E2EE is built and audited.
 */
export function mediaE2EEPlatformSupported(keyPushAvailable: boolean): boolean {
  return keyPushAvailable && platformMediaE2EESupported();
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
