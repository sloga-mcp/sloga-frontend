/**
 * The YouTube embed's postMessage protocol, spoken directly (plan §4.2) —
 * no `iframe_api` script (blocked by `script-src 'self'` in all three
 * shells). Pure: message parsing + command/URL builders only, so it runs
 * under `node --test`:
 *   node --test components/ui/components/features/voice/watch/providers/youtubeWire.test.ts
 *
 * Wire facts pinned by the 2026-08-19 probe (plan §7.1):
 * - `infoDelivery` is a PARTIAL object stream (~264 ms cadence while
 *   playing): `currentTime` in ~80 % of them, `playerState` only on change.
 *   Merge into a running state; never treat a missing field as a change.
 * - There is NO separate `onStateChange` over raw postMessage; state rides
 *   in `infoDelivery.playerState`. `onReady` / `onError` ARE separate.
 * - `initialDelivery` and `apiInfoDelivery` (a ~30 KB captions blob) also
 *   arrive — ignore unknown events, never throw on them.
 * - Fractional `setPlaybackRate` (0.95 / 1.05) is accepted and effective.
 * - Error codes: 2 / 5 / 100 / 101 / 150 (an unknown id gave 150, not 100)
 *   — all mean "can't be watched together here".
 */
import type { ProviderState } from "../syncController.ts";

export const YOUTUBE_EMBED_ORIGIN = "https://www.youtube-nocookie.com";

/** YouTube player states (`playerState` / YT.PlayerState). */
export const YT_STATE = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
} as const;

export function providerStateFromYt(playerState: number | undefined): ProviderState | null {
  switch (playerState) {
    case YT_STATE.UNSTARTED:
      return "unstarted";
    case YT_STATE.ENDED:
      return "ended";
    case YT_STATE.PLAYING:
      return "playing";
    case YT_STATE.PAUSED:
      return "paused";
    case YT_STATE.BUFFERING:
      return "buffering";
    case YT_STATE.CUED:
      return "cued";
    default:
      return null;
  }
}

/**
 * Stuck-state repair (bug §7.2a A): `infoDelivery` carries `playerState`
 * ONLY on change, so a missed transition (listener raced the user's click
 * on the embed itself) leaves the merged state at `unstarted`/`cued`
 * forever while `currentTime` streams on. The sync controller treats those
 * states as "no opinion", so such a viewer would never be corrected.
 *
 * Repair rule, pure so it runs under `node --test`: while the claimed
 * state is one that CANNOT legitimately have an advancing clock, count
 * consecutive reports whose `currentTime` moved forward by more than
 * report jitter; at two in a row (~500 ms of real playback at the ~264 ms
 * cadence), the claim is stale — report `playing`. Any report that does
 * not advance resets the count, so a genuinely parked player never trips
 * it. `paused`/`buffering`/`ended` are NOT repaired: their frozen clock is
 * the normal case, and `buffering` advancing briefly is a real state the
 * corrector's post-seek hold relies on.
 */
export interface StuckStateTracker {
  lastMs: number | null;
  advances: number;
}

export const stuckStateTracker = (): StuckStateTracker => ({ lastMs: null, advances: 0 });

/** More than inter-report jitter, less than one report interval of playback. */
export const STUCK_ADVANCE_MIN_MS = 100;
export const STUCK_ADVANCES_NEEDED = 2;

const STALE_WHEN_ADVANCING: ReadonlySet<ProviderState> = new Set([
  "unstarted",
  "cued",
  "idle",
]);

export function trackStuckState(
  t: StuckStateTracker,
  state: ProviderState,
  currentTimeMs: number | null | undefined,
): { tracker: StuckStateTracker; state: ProviderState } {
  if (currentTimeMs == null) return { tracker: t, state };
  if (!STALE_WHEN_ADVANCING.has(state)) {
    return { tracker: { lastMs: currentTimeMs, advances: 0 }, state };
  }
  const advanced = t.lastMs != null && currentTimeMs >= t.lastMs + STUCK_ADVANCE_MIN_MS;
  const advances = advanced ? t.advances + 1 : 0;
  return {
    tracker: { lastMs: currentTimeMs, advances },
    state: advances >= STUCK_ADVANCES_NEEDED ? "playing" : state,
  };
}

/** Human text for an `onError` code (plan §4.3). */
export function youtubeErrorText(code: number): string {
  switch (code) {
    case 2:
      return "That doesn't look like a valid YouTube video.";
    case 5:
      return "YouTube's player failed to load this video.";
    case 100:
      return "This video was not found, or it is private.";
    case 101:
    case 150:
      return "This video can't be watched together — the uploader disabled embedding.";
    default:
      return `YouTube reported an error (${code}).`;
  }
}

/** 11 chars of [A-Za-z0-9_-]. */
export const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Extract a video id from anything a user might paste: a bare id,
 * youtube.com/watch?v=, youtu.be/, /shorts/, /embed/, /live/, with or
 * without extra params. Returns null when nothing id-shaped is found.
 */
export function parseYouTubeInput(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (YOUTUBE_ID_RE.test(s)) return s;
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\.|^m\.|^music\./, "");
  const idOk = (v: string | null) => (v && YOUTUBE_ID_RE.test(v) ? v : null);
  if (host === "youtu.be") return idOk(url.pathname.split("/")[1] ?? null);
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const v = url.searchParams.get("v");
    if (idOk(v)) return v;
    const m = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/);
    if (m) return idOk(m[1]);
  }
  return null;
}

/** Playlist id shape (PL/UU/RD/OL…, lengths vary — bound, don't enumerate). */
export const YOUTUBE_LIST_RE = /^[A-Za-z0-9_-]{10,128}$/;

/**
 * Parse a paste for the watch picker (plan §7.3 4f): the video id plus, if
 * the URL carries one, a playlist id. v1 rule: a playlist plays only from a
 * link that ALSO names a video (`v=` + `list=`) — a bare playlist link has
 * no knowable first video without the Data API (§8 non-goal), so the
 * picker rejects it with a hint. Null = nothing YouTube-ish at all.
 */
export function parseYouTubeWatchInput(
  raw: string,
): { videoId: string | null; listId: string | null } | null {
  const videoId = parseYouTubeInput(raw);
  let listId: string | null = null;
  const s = raw.trim();
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
    const host = url.hostname.replace(/^www\.|^m\.|^music\./, "");
    if (host === "youtu.be" || host === "youtube.com" || host === "youtube-nocookie.com") {
      const l = url.searchParams.get("list");
      if (l && YOUTUBE_LIST_RE.test(l)) listId = l;
    }
  } catch {
    /* bare id or garbage — no list either way */
  }
  if (!videoId && !listId) return null;
  return { videoId, listId };
}

export interface YouTubeEmbedOptions {
  videoId: string;
  /** `location.origin` of the embedding document — YouTube checks it. */
  origin: string;
  autoplay?: boolean;
  /** Viewers get `controls=0` so scrubbing the YouTube bar can't desync them. */
  controls?: boolean;
  mute?: boolean;
  /**
   * HOST ONLY (plan §7.3 4f): load the video as part of this playlist so
   * the embed auto-advances on `ended`. The playlist is host-local state —
   * the session only ever names the current video, and viewers' embeds
   * never see the list.
   */
  listId?: string;
}

export function youtubeEmbedUrl(o: YouTubeEmbedOptions): string {
  const params = new URLSearchParams({
    enablejsapi: "1",
    origin: o.origin,
    autoplay: o.autoplay === false ? "0" : "1",
    playsinline: "1",
    rel: "0",
    controls: o.controls ? "1" : "0",
    disablekb: "1",
    // Keep YouTube's own end-screen / annotations quiet: this is a synced
    // surface, not a discovery surface.
    iv_load_policy: "3",
  });
  if (o.mute) params.set("mute", "1");
  if (o.listId) {
    params.set("listType", "playlist");
    params.set("list", o.listId);
  }
  return `${YOUTUBE_EMBED_ORIGIN}/embed/${encodeURIComponent(o.videoId)}?${params}`;
}

/** Outbound messages. `id`/`channel` are echoed back, letting two embeds coexist. */
export function listeningMessage(id: string): string {
  return JSON.stringify({ event: "listening", id, channel: "widget" });
}

export type YouTubeCommand =
  | "playVideo"
  | "pauseVideo"
  | "seekTo"
  | "setPlaybackRate"
  | "mute"
  | "unMute"
  | "setVolume"
  | "stopVideo";

export function commandMessage(id: string, func: YouTubeCommand, args: unknown[] = []): string {
  return JSON.stringify({ event: "command", func, args, id, channel: "widget" });
}

/** What one inbound message contributes to the running player state. */
export interface YouTubeInfo {
  currentTimeMs?: number;
  durationMs?: number;
  playerState?: number;
  playbackRate?: number;
  muted?: boolean;
  volume?: number;
  title?: string;
  /** The id the embed is actually playing — how a host's playlist advance
   * is observed (plan §7.3 4f). */
  videoId?: string;
}

export type YouTubeInbound =
  | { kind: "ready" }
  | { kind: "info"; info: YouTubeInfo }
  | { kind: "error"; code: number }
  | { kind: "ignore" };

/**
 * Parse an inbound `message` event's data for OUR embed. `expectedId` is
 * the id we handshook with; messages for another embed (the message-embed
 * iframe in chat, say) are ignored. The caller has already checked
 * `e.origin === YOUTUBE_EMBED_ORIGIN` and `e.source === iframe.contentWindow`.
 */
export function parseYouTubeMessage(data: unknown, expectedId: string): YouTubeInbound {
  let d: unknown = data;
  if (typeof d === "string") {
    try {
      d = JSON.parse(d);
    } catch {
      return { kind: "ignore" };
    }
  }
  if (!d || typeof d !== "object") return { kind: "ignore" };
  const m = d as { event?: unknown; id?: unknown; info?: unknown };
  if (m.id !== undefined && m.id !== expectedId) return { kind: "ignore" };
  switch (m.event) {
    case "onReady":
      return { kind: "ready" };
    case "onError": {
      const code = typeof m.info === "number" ? m.info : Number((m.info as { data?: unknown })?.data);
      return { kind: "error", code: Number.isFinite(code) ? code : -1 };
    }
    case "infoDelivery": {
      const raw = (m.info ?? {}) as Record<string, unknown>;
      const info: YouTubeInfo = {};
      if (typeof raw.currentTime === "number") info.currentTimeMs = raw.currentTime * 1000;
      if (typeof raw.duration === "number") info.durationMs = raw.duration * 1000;
      if (typeof raw.playerState === "number") info.playerState = raw.playerState;
      if (typeof raw.playbackRate === "number") info.playbackRate = raw.playbackRate;
      if (typeof raw.muted === "boolean") info.muted = raw.muted;
      if (typeof raw.volume === "number") info.volume = raw.volume;
      const vd = raw.videoData as { title?: unknown; video_id?: unknown } | undefined;
      if (vd && typeof vd.title === "string" && vd.title) info.title = vd.title;
      if (vd && typeof vd.video_id === "string" && YOUTUBE_ID_RE.test(vd.video_id)) {
        info.videoId = vd.video_id;
      }
      return { kind: "info", info };
    }
    default:
      // initialDelivery, apiInfoDelivery, anything new — ignored, never thrown on.
      return { kind: "ignore" };
  }
}
