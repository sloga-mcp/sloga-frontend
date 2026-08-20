/**
 * Jellyfin transport (plan §5.3): the ONE place a Jellyfin URL is built and
 * the ONE place a request is issued, so providers/api never hard-code an
 * origin. The carrier differs per shell:
 *
 * - **Web** — direct to the (HTTPS-or-loopback) server; relies on
 *   Jellyfin's `Access-Control-Allow-Origin: *` (verified 10.11, §7.1).
 * - **Tauri (Windows)** — `https://jf.localhost/{server_id}/…`, forwarded
 *   natively to the SAVED server (src-tauri/src/jellyfin.rs). Handles
 *   `http://`, LAN, self-signed.
 * - **Electron (Linux)** — `jf://{server_id}/…`, same forwarding
 *   (electron-shell/src/jellyfin.js).
 * - **Android** — split carrier (plan §5.4, slice 3). Media GETs (HLS
 *   manifests/segments via hls.js, `<img>` posters) ride the same-origin
 *   path `/_jf/{server_id}/…`, intercepted natively by
 *   `JellyfinWebViewClient` and streamed — CSP sees only 'self'. API calls
 *   go over the `Jellyfin` Capacitor plugin (`request`), because Android's
 *   `shouldInterceptRequest` never exposes a POST body, so PlaybackInfo /
 *   auth / playstate cannot ride the interceptor.
 *
 * Every native carrier forwards ONLY to servers the viewer saved. This
 * module pushes the saved-server list down to the shell
 * (`registerServers`) whenever it changes; an id the shell doesn't know is
 * a 404, so a watch session naming a server the viewer never added cannot
 * make their client contact an arbitrary URL (plan §5.1). The one
 * deliberate addition is `registerProbeServer`: the connect flow's
 * pre-save probe/sign-in registers the typed URL under a fixed provisional
 * id — that is still viewer-initiated contact (they typed the address and
 * clicked Connect), and the next `registerServers` replaces the table and
 * drops it.
 *
 * Sloga is never on the media path: this is the viewer's own machine
 * fetching from the viewer's own Jellyfin.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";

import { tauriInvoke } from "@revolt/common";

import {
  composeSpecList,
  type ShellKind,
  transportUrl,
  webTransportProblem,
} from "./jellyfinWire";
import type { SavedServer } from "./servers";

interface TauriGlobal {
  core?: { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> };
}
interface ElectronJellyfin {
  setServers(servers: unknown): Promise<number>;
}
interface SlogaShell {
  jellyfin?: ElectronJellyfin;
}

/** The Android `Jellyfin` Capacitor plugin (JellyfinPlugin.kt). */
interface JellyfinNativePlugin {
  setServers(options: { servers: unknown[] }): Promise<{ count: number }>;
  request(options: {
    serverId: string;
    path: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{ status: number; body: string }>;
}

let androidPlugin: JellyfinNativePlugin | undefined;
function jellyfinPlugin(): JellyfinNativePlugin {
  if (!androidPlugin) androidPlugin = registerPlugin<JellyfinNativePlugin>("Jellyfin");
  return androidPlugin;
}

/** Which shell we run in (plan §5.3). Frozen per document. */
export function shellKind(): ShellKind {
  if (typeof window === "undefined") return "web";
  if ((window as { __TAURI__?: TauriGlobal }).__TAURI__?.core?.invoke) return "tauri";
  if ((window as { slogaShell?: SlogaShell }).slogaShell?.jellyfin) return "electron";
  try {
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android") return "android";
  } catch {
    /* not in a Capacitor build */
  }
  return "web";
}

/**
 * Can this shell reach `baseUrl` at all? Web can't do mixed content or a
 * LAN address from the public origin. The native shells can reach anything
 * the user saved.
 */
export function transportProblem(baseUrl: string): "mixed-content" | null {
  const kind = shellKind();
  if (kind === "web") {
    const proto = typeof location !== "undefined" ? location.protocol : "https:";
    return webTransportProblem(proto, baseUrl);
  }
  return null;
}

/**
 * The provisional forwarding id used by the connect flow BEFORE a server
 * is saved (probe, Quick Connect, password sign-in). Fixed and 8-64
 * `[A-Za-z0-9_-]` so it passes every shell's second-gate id validation.
 */
export const PROBE_SERVER_ID = "connect-probe-0";

/**
 * The connect flow's in-flight probe URL. Kept here so EVERY push appends
 * it: a concurrent `registerServers` (host media-swap, `JellyfinBrowser`
 * mount) is a replace-all on the shell side, and without this it would
 * silently drop the provisional entry mid-connect — the Quick Connect poll
 * would then dead-end on unknown-server errors with no visible failure.
 */
let activeProbe: { url: string; trust: boolean } | null = null;

function toSpecList(servers: SavedServer[]) {
  // Module STATE, not a call parameter (§7.3 4e acceptance criterion): a
  // concurrent replace-all re-push must carry the probe's trust choice
  // through, or it silently drops mid-Quick-Connect against a self-signed
  // server.
  return composeSpecList(
    servers,
    activeProbe === null
      ? null
      : { id: PROBE_SERVER_ID, url: activeProbe.url, trust: activeProbe.trust },
  );
}

async function pushServers(
  list: Array<{ id: string; baseUrl: string; trustSelfSigned: boolean }>,
): Promise<void> {
  const kind = shellKind();
  if (kind === "tauri") {
    const invoke = tauriInvoke();
    if (invoke) {
      try {
        await invoke("jf_set_servers", { servers: list });
      } catch {
        /* ACL/absent — provider will surface fetch failures */
      }
    }
    return;
  }
  if (kind === "electron") {
    const jf = (window as { slogaShell?: SlogaShell }).slogaShell?.jellyfin;
    if (jf) {
      try {
        await jf.setServers(list);
      } catch {
        /* swallowed like the shell's other fire-and-forget verbs */
      }
    }
    return;
  }
  if (kind === "android") {
    try {
      await jellyfinPlugin().setServers({ servers: list });
    } catch {
      /* plugin absent (old APK) — provider will surface fetch failures */
    }
  }
}

/** Push the saved-server list to the native shell's forwarder. No-op on web. */
export async function registerServers(servers: SavedServer[]): Promise<void> {
  await pushServers(toSpecList(servers));
}

/**
 * Register the connect flow's typed-but-unsaved URL under
 * `PROBE_SERVER_ID`, alongside the saved list, so the pre-save probe and
 * sign-in calls can cross a native shell's forwarder at all. The entry
 * survives concurrent `registerServers` pushes (they re-append it) until
 * `clearProbeServer` — the connect flow calls that on finish/cancel.
 */
export async function registerProbeServer(
  baseUrl: string,
  saved: SavedServer[],
  trustSelfSigned = false,
): Promise<void> {
  activeProbe = { url: baseUrl, trust: trustSelfSigned === true };
  await pushServers(toSpecList(saved));
}

/** Drop the provisional connect-flow entry from every future push. */
export function clearProbeServer(): void {
  activeProbe = null;
}

/** Build a fetchable URL for a Jellyfin path against a saved server. */
export function mediaUrl(server: SavedServer, path: string): string {
  return transportUrl(shellKind(), { id: server.id, baseUrl: server.baseUrl }, path);
}

/**
 * Issue a request to a Jellyfin path. `credentials: "omit"` always — the
 * token rides in the Authorization header or the query, never in a cookie
 * (Jellyfin's ACAO is `*`, which forbids credentialed CORS anyway).
 */
export async function fetchJellyfin(
  server: SavedServer,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  if (shellKind() === "android") {
    // API calls go over the plugin bridge: shouldInterceptRequest cannot
    // see a POST body, and the responses here are small JSON (§5.4).
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const { status, body } = await jellyfinPlugin().request({
      serverId: server.id,
      path: path.startsWith("/") ? path : `/${path}`,
      method: typeof init.method === "string" ? init.method : "GET",
      headers,
      ...(typeof init.body === "string" ? { body: init.body } : {}),
    });
    // status 0 = the native side could not reach the server at all.
    if (status < 200) throw new Error("Couldn't reach the server");
    // These statuses forbid a Response body by spec.
    const bodyless = status === 204 || status === 205 || status === 304;
    return new Response(bodyless ? null : body, { status });
  }
  return fetch(mediaUrl(server, path), { ...init, credentials: "omit" });
}
