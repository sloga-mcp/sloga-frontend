import CONFIGURATION from "./env";

/**
 * Shared derivation of the origin that user-shareable app links must be built
 * from — invite links above all.
 *
 * **Do not build a shareable link out of `window.location` directly.** The web
 * client is only one of four shells:
 *
 * - Tauri desktop serves the app from `tauri://localhost` (Windows/Linux) or
 *   `http://tauri.localhost`, so `location.origin` yields a link that is dead
 *   for everyone who receives it.
 * - Electron desktop serves the app from `app://bundle`, a custom scheme that
 *   means nothing outside the shell.
 * - Capacitor Android serves from `https://localhost` — a valid-looking https
 *   origin that resolves to nothing off-device.
 *
 * Order of preference:
 *  1. an explicit `VITE_APP_URL` build override,
 *  2. the current page origin, but only on a real web page (never in a native
 *     shell) — this keeps self-hosted deployments and `vite dev` correct,
 *  3. the origin of the configured API URL (`https://app.sloga.gg/api` →
 *     `https://app.sloga.gg`), which is what every native shell talks to.
 */

/**
 * Whether the app is running inside a native shell (Tauri desktop, Electron
 * desktop or Capacitor mobile) whose document origin is a local scheme rather
 * than the public web origin.
 *
 * Besides picking the origin for shareable links, this is also used to hand
 * the sign-up and password-reset flows off to the system browser instead of
 * running them inside the shell.
 */
export function isNativeShell(): boolean {
  if (typeof window === "undefined") return false;

  // Read every shell global off one alias: an `in`-narrowed `window` loses
  // its own members for the rest of the function.
  const shell = window as Window & {
    __TAURI__?: unknown;
    // Electron's preload bridge. Only its presence matters here, so it is not
    // tied to the full declaration the desktop settings page relies on.
    native?: unknown;
    // Capacitor's global, read rather than imported from `@capacitor/core` so
    // this module stays dependency-free.
    Capacitor?: { isNativePlatform?: () => boolean };
  };

  // Tauri desktop: the global is injected before any app code runs, and the
  // scheme/host differ per platform, so check all three.
  if (shell.__TAURI__) return true;
  if (shell.location.protocol === "tauri:") return true;
  if (shell.location.hostname === "tauri.localhost") return true;

  // Electron desktop: the preload script exposes `window.native` before any
  // app code runs. Its `app://bundle` origin is already excluded below by the
  // http(s) check in `appOrigin`, but other callers have no such fallback.
  if (shell.native) return true;

  return shell.Capacitor?.isNativePlatform?.() === true;
}

/**
 * Origin of the configured API, with any path (`/api`) dropped.
 */
function apiOrigin(): string | undefined {
  try {
    return new URL(CONFIGURATION.DEFAULT_API_URL).origin;
  } catch {
    return undefined;
  }
}

/**
 * Origin to build shareable links from. Never ends with a slash.
 */
export function appOrigin(): string {
  const configured = (CONFIGURATION.APP_URL ?? "").trim();
  if (configured) return configured.replace(/\/+$/, "");

  if (
    typeof window !== "undefined" &&
    !isNativeShell() &&
    (window.location.protocol === "http:" ||
      window.location.protocol === "https:")
  ) {
    return window.location.origin;
  }

  // Native shells (and anything else without a usable document origin) fall
  // back to whatever host the API lives on — the same host that serves the
  // web app in every deployment we ship.
  return apiOrigin() ?? "https://app.sloga.gg";
}

/**
 * Build the shareable link for an invite code.
 *
 * The single place invite URLs are constructed — used by the create-invite
 * modal, the invite-friends flow and the Discord import's done screen.
 * @param code Invite code
 */
export function inviteUrl(code: string): string {
  return CONFIGURATION.IS_STOAT
    ? `https://stt.gg/${code}`
    : `${appOrigin()}/invite/${code}`;
}
