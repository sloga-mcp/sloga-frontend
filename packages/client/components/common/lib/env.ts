const DEFAULT_API_URL =
  (import.meta.env.DEV ? import.meta.env.VITE_DEV_API_URL : undefined) ??
  (import.meta.env.VITE_API_URL as string) ??
  "https://stoat.chat/api";

export default {
  /**
   * Whether to emit additional debug information
   */
  DEBUG: import.meta.env.DEV || true,
  /**
   * What API server to connect to by default.
   */
  DEFAULT_API_URL,
  /**
   * Whether this is Stoat
   */
  IS_STOAT: [
    // historically...
    "https://api.revolt.chat",
    "https://beta.revolt.chat/api",
    "https://revolt.chat/api",
    // ... and now:
    "https://stoat.chat/api",
  ].includes(DEFAULT_API_URL),
  /**
   * What WS server to connect to by default.
   */
  DEFAULT_WS_URL:
    (import.meta.env.DEV ? import.meta.env.VITE_DEV_WS_URL : undefined) ??
    (import.meta.env.VITE_WS_URL as string) ??
    "wss://stoat.chat/events",
  /**
   * What media server to connect to by default.
   */
  DEFAULT_MEDIA_URL:
    (import.meta.env.DEV ? import.meta.env.VITE_DEV_MEDIA_URL : undefined) ??
    (import.meta.env.VITE_MEDIA_URL as string) ??
    "https://cdn.stoatusercontent.com",
  /**
   * What proxy server to connect to by default.
   */
  DEFAULT_PROXY_URL:
    (import.meta.env.DEV ? import.meta.env.VITE_DEV_PROXY_URL : undefined) ??
    (import.meta.env.VITE_PROXY_URL as string) ??
    "https://proxy.stoatusercontent.com",
  /**
   * What gifbox server to connect to by default.
   */
  DEFAULT_GIFBOX_URL:
    (import.meta.env.DEV ? import.meta.env.VITE_DEV_GIFBOX_URL : undefined) ??
    (import.meta.env.VITE_GIFBOX_URL as string) ??
    // our own delta /gifs proxy — the public gifbox (api.gifbox.me) only
    // accepts upstream sessions and its Tenor backend shut down 2026-06-30
    "https://app.sloga.gg/api/gifs",
  /**
   * Base URL for unicode-emoji SVG packs. Routed through the app origin
   * (proxied to the upstream pack host by Caddy) so the client never hits an
   * external CDN directly — required by the desktop shell CSP (`img-src` has
   * no external host) and the no-CDN policy. Blank ⇒ the upstream host, as a
   * dev fallback. See unicodeEmojiUrl in markdown/emoji/UnicodeEmoji.tsx.
   */
  DEFAULT_EMOJI_URL:
    (import.meta.env.VITE_EMOJI_URL as string) ??
    "https://static.stoat.chat/emoji",
  /**
   * hCaptcha site key to use if enabled
   */
  HCAPTCHA_SITEKEY: import.meta.env.VITE_HCAPTCHA_SITEKEY as string,
  /**
   * Maximum number of replies a message can have
   */
  MAX_REPLIES: (import.meta.env.VITE_CFG_MAX_REPLIES as number) ?? 5,
  /**
   * Maximum number of attachments a message can have
   */
  MAX_ATTACHMENTS: (import.meta.env.VITE_CFG_MAX_ATTACHMENTS as number) ?? 5,
  /**
   * Maximum number of emoji a server can have
   */
  MAX_EMOJI: (import.meta.env.VITE_CFG_MAX_EMOJI as number) ?? 100,
  /**
   * Max file size allowed for uploads (in bytes)
   * 20 MB = 20 * 1024 * 1024 = 20,971,520 bytes
   * I kinda wonder if this should be a setting, or something fetched from the backend dynamically.
   */
  MAX_FILE_SIZE:
    (import.meta.env.VITE_CFG_MAX_FILE_SIZE as number) ?? 20_000_000,
  /**
   * Hard ceiling on a single upload request, regardless of what the server
   * advertises as its file size limit.
   *
   * The CDN in front of the API rejects any single request body over 100 MB —
   * it returns 413 at the edge after only a couple of MB, so the file never
   * reaches the file server at all and the upload appears to freeze at a low
   * percentage. Anything above this can therefore never succeed, however high
   * `file_upload_size_limits` is set server-side.
   *
   * Raising this requires chunked/resumable uploads (each chunk its own
   * sub-100 MB request) — see the stoatchat repo's
   * `docs/chunked-resumable-uploads-design.md`.
   */
  MAX_UPLOAD_REQUEST_SIZE:
    (import.meta.env.VITE_CFG_MAX_UPLOAD_REQUEST_SIZE as number) ?? 95_000_000,
  /**
   * RNNoise worklet asset base. Blank ⇒ the self-hosted copy under
   * `${BASE_URL}rnnoise/` (see the DenoiseTrackProcessor call site in
   * rtc/state.tsx) — the package's jsdelivr default is never used (no-CDN
   * policy; blocked by the desktop shell CSP).
   */
  RNNOISE_WORKLET_CDN_URL:
    (import.meta.env.VITE_RNNOISE_WORKLET_CDN_URL as string) ?? "",
  /**
   * Base URL for the self-hosted MediaPipe segmentation assets used by camera
   * background effects (blur / virtual background). Blank ⇒ use the bundled
   * assets under `${BASE_URL}mediapipe`. Consume with `||` (NOT `??`): a
   * leftover `__VITE_...__` docker placeholder is truthy, so `||` still routes
   * through the intended value. See camera background effects in rtc/state.tsx.
   */
  SEGMENTATION_ASSETS_URL:
    (import.meta.env.VITE_SEGMENTATION_ASSETS_URL as string) ?? "",
  /**
   * Enable video allows the web client to enable video and screensharing
   */
  ENABLE_VIDEO:
    ((import.meta.env.VITE_CFG_ENABLE_VIDEO as string) ?? "").toLowerCase() ==
    "true",
  /**
   * Session ID to set during development.
   */
  DEVELOPMENT_SESSION_ID: import.meta.env.DEV
    ? (import.meta.env.VITE_SESSION_ID as string)
    : undefined,
  /**
   * Token to set during development.
   */
  DEVELOPMENT_TOKEN: import.meta.env.DEV
    ? (import.meta.env.VITE_TOKEN as string)
    : undefined,
  /**
   * User ID to set during development.
   */
  DEVELOPMENT_USER_ID: import.meta.env.DEV
    ? (import.meta.env.VITE_USER_ID as string)
    : undefined,
};
