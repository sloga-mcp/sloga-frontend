/**
 * What a captcha-capable auth form should do about the captcha.
 *
 * Pure on purpose, so `node --test` can load it (`captchaDecision.test.ts`);
 * `Form.tsx` feeds it the shell check, the server's answer and its props.
 *
 * Native shells (Tauri, Electron, Capacitor) never load the hCaptcha script:
 * those shells render decrypted E2EE content, so no third-party script runs in
 * them. When the server wants a captcha they hand the flow off to the system
 * browser instead. The web client mounts the widget with the server's sitekey,
 * falling back to the build-time key only when the server does not ask.
 */
import { type ServerCaptcha, resolveSitekey } from "./captchaConfig.ts";

/** Inputs to {@link decideCaptcha}. */
export interface CaptchaDecisionInput {
  /** Whether the app runs inside a native shell (`isNativeShell()`). */
  native: boolean;
  /** The server's captcha setting, or `undefined` while it is still loading. */
  server: ServerCaptcha | undefined;
  /** Build-time sitekey, used only when the server does not ask for one. */
  buildTimeKey?: string;
  /** App path the browser handoff opens, e.g. `/login/create`. */
  handoffPath?: string;
}

/** What the form should do; see {@link decideCaptcha}. */
export type CaptchaDecision =
  | { kind: "loading" }
  | { kind: "handoff"; path: string }
  | { kind: "widget"; sitekey: string }
  | { kind: "none" }
  | { kind: "unavailable" };

/**
 * Decide how the form handles the captcha.
 *
 * - `loading`: the server has not answered yet; do not submit.
 * - `handoff`: replace the form with a link that opens `path` in the browser.
 * - `widget`: mount the invisible widget with `sitekey`, execute on submit.
 * - `none`: no captcha; submit as usual.
 * - `unavailable`: a captcha is required but cannot be shown here; refuse to
 *   submit and tell the user. Never submit without a token in this state.
 */
export function decideCaptcha(input: CaptchaDecisionInput): CaptchaDecision {
  const { native, server, buildTimeKey, handoffPath } = input;
  if (!server) return { kind: "loading" };

  if (native) {
    // Never load hCaptcha in a native shell, not even with a build-time key.
    if (!server.enabled) return { kind: "none" };

    // The path is appended to the app origin, so it must be absolute.
    return handoffPath?.startsWith("/")
      ? { kind: "handoff", path: handoffPath }
      : { kind: "unavailable" };
  }

  const sitekey = resolveSitekey(server, buildTimeKey);
  if (sitekey) return { kind: "widget", sitekey };

  // Enabled without a key is "required but unavailable", never "skip it".
  return server.enabled ? { kind: "unavailable" } : { kind: "none" };
}
