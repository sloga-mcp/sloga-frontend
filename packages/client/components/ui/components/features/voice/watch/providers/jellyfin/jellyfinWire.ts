/**
 * Jellyfin wire facts for the watch-together provider (plan §5) — PURE:
 * no DOM, no Solid, no fetch, so it runs under `node --test`
 * (`jellyfinWire.test.ts`). Everything that touches the network lives in
 * `api.ts`/`transport.ts`; everything that decides a URL, a header, a
 * profile or a unit conversion lives here.
 *
 * Facts below were measured against Jellyfin 10.11.11 (plan §7.1):
 * - ticks are 100 ns; convert ONCE at this boundary;
 * - `Authorization: MediaBrowser Client=…, Device=…, DeviceId=…, Version=…
 *   [, Token=…]` — Quick Connect `Initiate` needs the token-less form;
 * - `TranscodingUrl` is relative to the server base and carries the token
 *   (`ApiKey=`) in its query, so manifests/segments need no header;
 * - with direct play disabled, PlaybackInfo's `TranscodeReasons` is noise —
 *   `GET /Sessions?deviceId=` → `TranscodingInfo` is the real answer.
 */

/** Jellyfin ticks are 100-nanosecond units. */
export const TICKS_PER_MS = 10_000;

export function ticksToMs(ticks: number | null | undefined): number {
  if (ticks == null || !Number.isFinite(ticks)) return 0;
  return Math.round(ticks / TICKS_PER_MS);
}

export function msToTicks(ms: number): number {
  return Math.max(0, Math.round(ms * TICKS_PER_MS));
}

/**
 * Accept `http(s)://host[:port][/path]` only — no credentials, query or
 * fragment — and return it without a trailing slash. Null for anything
 * else. The shells validate again natively (second gate); this is the one
 * users see.
 */
export function normalizeServerUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  let url: URL;
  try {
    // Bare "nas:8096" → "http://nas:8096" (what people type on a LAN).
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;
  if (!url.hostname) return null;
  url.pathname = url.pathname.replace(/\/+$/, "");
  let out = url.toString();
  while (out.endsWith("/")) out = out.slice(0, -1);
  // 512 is the backend's cap on `server_url` (watch.rs validate_media).
  if (out.length > 512) return null;
  return out;
}

export interface AuthHeaderInput {
  deviceId: string;
  /** Human-readable device name Jellyfin shows in its dashboard. */
  deviceName: string;
  /** App version string. */
  version: string;
  token?: string | null;
}

/** The `MediaBrowser` scheme Jellyfin expects on every call (plan §5.1). */
export function authorizationHeader(input: AuthHeaderInput): string {
  const q = (v: string) => `"${v.replace(/["\\\r\n]/g, "")}"`;
  let h = `MediaBrowser Client=${q("Sloga")}, Device=${q(input.deviceName)}, DeviceId=${q(
    input.deviceId,
  )}, Version=${q(input.version)}`;
  if (input.token) h += `, Token=${q(input.token)}`;
  return h;
}

export type ShellKind = "web" | "tauri" | "electron" | "android";

/**
 * Where a Jellyfin path is fetched from, per shell (plan §5.3). Web goes
 * direct; the desktop shells go through their `jf` scheme and Android
 * through the same-origin `/_jf/` WebView interceptor (slice 3) — all
 * three forward ONLY to servers the user saved (by server id).
 */
export function transportUrl(
  kind: ShellKind,
  server: { id: string; baseUrl: string },
  path: string,
): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  switch (kind) {
    case "web":
      return `${server.baseUrl}${p}`;
    case "tauri":
      return `https://jf.localhost/${server.id}${p}`;
    case "electron":
      return `jf://${server.id.toLowerCase()}${p}`;
    case "android":
      // Relative to the Capacitor origin (https://localhost): the request
      // is answered natively by the `/_jf/` WebView interceptor, so the
      // page CSP sees only 'self' (plan §5.4 — no CSP widening).
      return `/_jf/${server.id}${p}`;
  }
}

/**
 * Why a web page can't reach this server, if it can't: an `https:` page
 * may not fetch `http:` (mixed content), and nothing in a browser can reach
 * a LAN address from the public origin without the desktop app. Null = fine.
 */
export function webTransportProblem(
  pageProtocol: string,
  baseUrl: string,
): "mixed-content" | null {
  if (pageProtocol === "https:" && baseUrl.startsWith("http://")) {
    let host = "";
    try {
      host = new URL(baseUrl).hostname;
    } catch {
      /* normalized already */
    }
    // Loopback is "potentially trustworthy" — browsers allow it from https.
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return null;
    return "mixed-content";
  }
  return null;
}

/**
 * The status every shell answers a TLS/certificate failure with (the
 * Cloudflare "invalid SSL certificate" code): desktop `jellyfin.rs`,
 * Electron `jellyfin.js` and the Android plugin all map their stack's
 * cert errors to it, and everything ELSE stays an opaque 502/0. The
 * connect flow offers per-server trust ONLY on this status — a typo'd
 * port must never train the user to trust-click (plan §7.3 4e).
 */
export const TLS_ERROR_STATUS = 526;

/**
 * The forwarding table pushed to a native shell: the saved servers plus,
 * while a connect flow is running, the provisional probe entry — WITH the
 * trust choice the user made for it. Pure so the re-push behavior (a
 * concurrent registerServers must carry the probe's trust through, §7.2b
 * item 3 + §7.3 4e) is testable under `node --test`.
 */
export function composeSpecList(
  saved: Array<{ id: string; baseUrl: string; trustSelfSigned?: boolean }>,
  probe: { id: string; url: string; trust: boolean } | null,
): Array<{ id: string; baseUrl: string; trustSelfSigned: boolean }> {
  const list = saved.map((s) => ({
    id: s.id,
    baseUrl: s.baseUrl,
    trustSelfSigned: s.trustSelfSigned === true,
  }));
  if (probe !== null) {
    list.push({ id: probe.id, baseUrl: probe.url, trustSelfSigned: probe.trust === true });
  }
  return list;
}

export interface CodecSupport {
  h264: boolean;
  vp9: boolean;
  av1: boolean;
  hevc: boolean;
}

/**
 * `MediaSource.isTypeSupported` probes for the DeviceProfile. Injected so
 * the builder stays pure; the provider passes the real one.
 */
export function probeCodecs(isTypeSupported: (mime: string) => boolean): CodecSupport {
  const t = (m: string) => {
    try {
      return isTypeSupported(m);
    } catch {
      return false;
    }
  };
  return {
    h264: t('video/mp4; codecs="avc1.640033"') || t('video/mp2t; codecs="avc1.640033"'),
    vp9: t('video/mp4; codecs="vp09.00.10.08"'),
    av1: t('video/mp4; codecs="av01.0.08M.08"'),
    // WebView2 on a box without the OS HEVC extension says no (probe 0(d)).
    hevc: t('video/mp4; codecs="hvc1.1.6.L93.B0"') || t('video/mp4; codecs="hev1.1.6.L93.B0"'),
  };
}

/** Quality presets, bits per second. */
export const QUALITY_PRESETS: ReadonlyArray<{ id: string; bps: number }> = [
  { id: "20", bps: 20_000_000 },
  { id: "10", bps: 10_000_000 },
  { id: "4", bps: 4_000_000 },
];
export const DEFAULT_QUALITY = "20";

export function qualityBps(id: string | null | undefined): number {
  return QUALITY_PRESETS.find((q) => q.id === id)?.bps ?? QUALITY_PRESETS[0].bps;
}

/**
 * The DeviceProfile we POST to PlaybackInfo (plan §5.5). v1 ALWAYS plays
 * the returned `TranscodingUrl` (HLS/ts): no direct-play profiles, so
 * Jellyfin decides remux vs re-encode and we never touch progressive
 * direct play (Range plumbing + codec gambling). Video codecs offered for
 * the HLS stream are H.264 plus whatever MSE says it can decode.
 */
export function buildDeviceProfile(maxBitrateBps: number, codecs: CodecSupport) {
  const video = ["h264"];
  if (codecs.hevc) video.push("hevc");
  if (codecs.vp9) video.push("vp9");
  if (codecs.av1) video.push("av1");
  return {
    Name: "Sloga",
    MaxStreamingBitrate: maxBitrateBps,
    MaxStaticBitrate: maxBitrateBps,
    MusicStreamingTranscodingBitrate: 192_000,
    DirectPlayProfiles: [],
    TranscodingProfiles: [
      {
        Container: "ts",
        Type: "Video",
        VideoCodec: video.join(","),
        AudioCodec: "aac,mp3",
        Protocol: "hls",
        Context: "Streaming",
        MaxAudioChannels: "2",
        MinSegments: 1,
        BreakOnNonKeyFrames: true,
      },
    ],
    CodecProfiles: [
      {
        Type: "Video",
        Codec: "h264",
        Conditions: [
          { Condition: "LessThanEqual", Property: "VideoLevel", Value: "51", IsRequired: false },
          {
            Condition: "EqualsAny",
            Property: "VideoProfile",
            Value: "high|main|baseline|constrained baseline",
            IsRequired: false,
          },
        ],
      },
    ],
    SubtitleProfiles: [{ Format: "vtt", Method: "External" }],
    ResponseProfiles: [],
  };
}

export interface TranscodeState {
  isVideoDirect: boolean | null;
  videoCodec: string | null;
  audioCodec: string | null;
  reasons: string[];
}

/**
 * Pull OUR device's transcode state out of `GET /Sessions?deviceId=`
 * (plan §7.1: PlaybackInfo's `TranscodeReasons` is empty/`DirectPlayError`
 * when direct play is disabled; this is the real answer).
 */
export function parseTranscodeState(
  sessions: unknown,
  deviceId: string,
): TranscodeState | null {
  if (!Array.isArray(sessions)) return null;
  for (const s of sessions) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    if (o.DeviceId !== deviceId) continue;
    const ti = o.TranscodingInfo as Record<string, unknown> | null | undefined;
    if (!ti || typeof ti !== "object") return null;
    return {
      isVideoDirect: typeof ti.IsVideoDirect === "boolean" ? ti.IsVideoDirect : null,
      videoCodec: typeof ti.VideoCodec === "string" ? ti.VideoCodec : null,
      audioCodec: typeof ti.AudioCodec === "string" ? ti.AudioCodec : null,
      reasons: Array.isArray(ti.TranscodeReasons)
        ? ti.TranscodeReasons.filter((r): r is string => typeof r === "string")
        : [],
    };
  }
  return null;
}

/** One short line for the stats overlay: "remux" vs what the server re-encodes. */
export function describeTranscode(t: TranscodeState | null): string | null {
  if (!t) return null;
  if (t.isVideoDirect === true) return "server: remux (video copied)";
  if (t.isVideoDirect === false) {
    const parts = [t.videoCodec && `video→${t.videoCodec}`, t.audioCodec && `audio→${t.audioCodec}`]
      .filter(Boolean)
      .join(", ");
    return `server: transcoding${parts ? ` (${parts})` : ""}`;
  }
  return null;
}

/** Jellyfin item kinds we list and start (plan §5.5). */
export const WATCHABLE_KINDS = ["Movie", "Episode", "Video", "MusicVideo"] as const;
export const BROWSE_KINDS = ["Movie", "Series", "Season", "Episode", "Video", "MusicVideo", "Folder", "BoxSet", "CollectionFolder"] as const;

export function isWatchableKind(kind: string | undefined): boolean {
  return !!kind && (WATCHABLE_KINDS as readonly string[]).includes(kind);
}

/** Item primary image URL (images need no auth on Jellyfin — §7.1). */
export function imagePath(itemId: string, opts: { maxWidth: number; tag?: string | null }): string {
  const q = new URLSearchParams({ maxWidth: String(opts.maxWidth) });
  if (opts.tag) q.set("tag", opts.tag);
  return `/Items/${encodeURIComponent(itemId)}/Images/Primary?${q}`;
}

/** Human label for an item in a list: "S2E3 · Title" for episodes. */
export function itemLabel(item: {
  Name?: string;
  Type?: string;
  SeriesName?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  ProductionYear?: number;
}): string {
  const name = item.Name ?? "";
  if (item.Type === "Episode") {
    const se =
      item.ParentIndexNumber != null && item.IndexNumber != null
        ? `S${item.ParentIndexNumber}E${item.IndexNumber} · `
        : "";
    return `${item.SeriesName ? `${item.SeriesName} — ` : ""}${se}${name}`;
  }
  if (item.ProductionYear) return `${name} (${item.ProductionYear})`;
  return name;
}

/** Error text for an HTTP status from a Jellyfin, for the connect flow. */
export function statusText(status: number): string {
  switch (status) {
    case 401:
      return "Sign-in rejected (401)";
    case 403:
      return "Not allowed on this server (403)";
    case 404:
      return "Not found on this server (404)";
    case 0:
      return "Couldn't reach the server";
    default:
      return `Server answered ${status}`;
  }
}
