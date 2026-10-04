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
   * Origin the web app is served from, used to build shareable links (invites)
   * that must work for the recipient regardless of which shell created them.
   *
   * Blank ⇒ derived at call time by `appOrigin()`: the page origin on web, the
   * API host inside Tauri/Capacitor (whose document origins — `tauri://` and
   * `https://localhost` — are dead links off-device).
   */
  APP_URL: (import.meta.env.VITE_APP_URL as string) ?? "",
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
   * Files above `CHUNKED_UPLOAD_THRESHOLD` avoid this wall entirely by going
   * through the chunked upload path (each chunk its own sub-100 MB request) —
   * see the stoatchat repo's `docs/chunked-uploads-implementation-plan.md`.
   * This constant now only governs the single-POST path.
   */
  MAX_UPLOAD_REQUEST_SIZE:
    (import.meta.env.VITE_CFG_MAX_UPLOAD_REQUEST_SIZE as number) ?? 95_000_000,
  /**
   * Files larger than this take the chunked/resumable upload path instead of
   * a single POST. Must stay above the server's one-chunk floor (32 MiB —
   * `create` rejects anything smaller, so the scanned/stripped single-POST
   * pipeline cannot be bypassed) and below `MAX_UPLOAD_REQUEST_SIZE` (so the
   * single-POST path never hits the CDN's 100 MB wall). In an emergency this
   * can be floored via env to effectively re-clamp uploads at the old limit.
   */
  CHUNKED_UPLOAD_THRESHOLD:
    (import.meta.env.VITE_CFG_CHUNKED_UPLOAD_THRESHOLD as number) ?? 90_000_000,
  /**
   * Client-side cap for attachments in E2EE conversations. The binding limit
   * is native: e2ee-core encrypts and decrypts one-shot, whole-buffer, and
   * rejects plaintext above `MAX_ATTACHMENT_PLAINTEXT` (20 MiB = 20_971_520).
   * Autumn's E2EE blob route is NOT the constraint (it accepts ciphertext up
   * to `MAX_E2EE_BLOB_SIZE` = 91_000_000). 20_000_000 sits just under the
   * native 20 MiB so the picker refuses before the core would. Chunked
   * uploads do NOT apply to this path yet. Raise this only together with
   * the native constant and autumn's ceiling, never alone.
   */
  E2EE_MAX_ATTACHMENT_SIZE:
    (import.meta.env.VITE_CFG_E2EE_MAX_ATTACHMENT_SIZE as number) ?? 20_000_000,
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
   * Enable the remote desktop control affordances (give/take control).
   *
   * DEFAULT OFF, and deliberately opt-in rather than opt-out: the feature is
   * still in its live-test matrix, and `rc_status().supported` alone is not a
   * release gate — it answers "can this shell inject input", which is true of
   * every published Windows build. Without this flag a public installer shows
   * "Give control" to everyone who screenshares.
   *
   * Read it at `RemoteControl.supported()`, which is the choke point the
   * offer button, the inbound-offer listeners and `setLocalUser` all pass
   * through — the handshake commands fail closed when the local user is
   * never set, so one flag darkens both directions.
   *
   * Set `VITE_CFG_ENABLE_REMOTE_CONTROL=true` for the side-load matrix builds.
   */
  ENABLE_REMOTE_CONTROL:
    (
      (import.meta.env.VITE_CFG_ENABLE_REMOTE_CONTROL as string) ?? ""
    ).toLowerCase() == "true",
  /**
   * Enable on-device call transcription (the Transcribe button and its panel).
   *
   * DEFAULT OFF, opt-in, for the reason recording taught us: call recording
   * shipped with no build-time gate at all and went live lit to every web user
   * the moment its bundle was swapped, with rollback meaning a dist swap rather
   * than a flag. This one has more reason to be gated, not less — the first
   * press downloads ~44MB of speech model, inference runs continuously on the
   * user's own machine for the length of the call, and the transcript is a
   * durable artifact of what people said.
   *
   * It also fails in the desktop and Android shells today: they serve a bundled
   * dist, so `/models/` has nothing behind it and the button would appear and
   * then error. Until the assets ship with those installers, this flag is what
   * keeps it out of them.
   *
   * Read at `transcriptionSupported()` so one flag darkens the button, the
   * panel and the engine together.
   *
   * Set `VITE_CFG_ENABLE_CALL_TRANSCRIPTION=true` for builds that should have
   * it.
   */
  ENABLE_CALL_TRANSCRIPTION:
    (
      (import.meta.env.VITE_CFG_ENABLE_CALL_TRANSCRIPTION as string) ?? ""
    ).toLowerCase() == "true",
  /**
   * Enable the "play while you wait" call minigame (Slogaball).
   *
   * DEFAULT OFF, same posture as transcription above: nothing in a call card
   * lights up in a public build just because its bundle arrived. Unlike
   * transcription there is no platform reason — the game is one lazy chunk,
   * canvas-drawn, zero shipped assets, so a bundled desktop/Android dist can
   * run it fine — the flag is purely the release decision.
   *
   * Read in `minigameChipVisible()` (the policy the chip, the overlay and the
   * lazy engine chunk all sit behind), so one flag darkens the lot.
   *
   * Set `VITE_CFG_ENABLE_CALL_MINIGAME=true` for builds that should have it.
   */
  ENABLE_CALL_MINIGAME:
    (
      (import.meta.env.VITE_CFG_ENABLE_CALL_MINIGAME as string) ?? ""
    ).toLowerCase() == "true",
  /**
   * The publish-gate leg instrument. When on, `components/rtc/state.tsx`
   * emits `console.error("[gate-trace] " + JSON)` records at the seven
   * fiducials of the born-paused acceptance — `connect.add`,
   * `disconnect.entry`, `localSenderCreated`, `localTrackPublished.entry`,
   * `resumeGate`, `track.upstreamResumed`, `track.processorUpdate` — which
   * `scripts/leg/toc-reduce.mjs` reads back out of the seat logs.
   *
   * DEFAULT OFF, and build-time on purpose: the flag's inlined VALUE is what
   * a build artifact carries — an instrumented entry chunk reads
   * `ENABLE_GATE_TRACE:"true".toLowerCase()==` and a production one
   * `ENABLE_GATE_TRACE:"".toLowerCase()==` — and
   * `scripts/leg/launch-seats.sh check` greps the staged dist for
   * `ENABLE_GATE_TRACE:"true"` to refuse a non-instrumented dist before a
   * leg is driven against it. The emitter code itself stays in every bundle
   * behind the runtime guard, which costs one property read per fiducial;
   * the `[gate-trace]` literal is NOT dead-code-eliminated.
   *
   * Should an on-build ever ship by accident, the Sentry breadcrumb filter in
   * `src/sentry.ts` (`beforeBreadcrumb`) drops every `[gate-trace]` console
   * line at the boundary, so the records cannot reach Sentry.
   *
   * Set `VITE_CFG_GATE_TRACE=true` only for a leg dist. Never in the prod
   * `.env`.
   */
  ENABLE_GATE_TRACE:
    ((import.meta.env.VITE_CFG_GATE_TRACE as string) ?? "").toLowerCase() ==
    "true",
  /**
   * Watch together — synced YouTube (slice 1) / Jellyfin (slice 2) playback
   * in a voice call. Sloga carries only the control state over the existing
   * WebSocket; the media never touches a Sloga server.
   *
   * DEFAULT OFF. Read in `watchPolicy.ts` (`watchOverlayVisible` /
   * `watchButtonVisible`), the single point the actions-bar button, the
   * overlay and the player host all sit behind — one flag darkens the lot.
   * Bundled shells ship it lit only once their own CSP/scheme work is in the
   * same build (the RC release-gate rule); YouTube needs no CSP change in
   * any shell (frame-src already carries youtube-nocookie.com).
   *
   * Set `VITE_CFG_ENABLE_WATCH_TOGETHER=true` for builds that should have it.
   */
  ENABLE_WATCH_TOGETHER:
    (
      (import.meta.env.VITE_CFG_ENABLE_WATCH_TOGETHER as string) ?? ""
    ).toLowerCase() == "true",
  /**
   * Google Translate — message translation and call-caption translation,
   * both of which send text to `translate.googleapis.com`.
   *
   * DEFAULT ON, unlike the flags around it: only `false` (any case) turns it
   * off, so play, sideload, web and desktop builds, whose `.env` never sets
   * it, keep translation. The F-Droid (foss) Android build passes
   * `VITE_CFG_ENABLE_GOOGLE_TRANSLATE=false` in the `vite build` environment
   * (never in a `.env` file) so its Google-free claim holds.
   *
   * This key is the flag's registry entry and the artifact-literal anchor
   * for the foss release gate, which counts this key's inlined, minified
   * value in the built dist. It is NOT the runtime gate. That is
   * `translationAvailable()` in `translation.ts`, which reads the SAME
   * variable with the SAME parse, because that module must stay
   * import-free: `translation.test.ts` loads it under `node --test`, where
   * this file dies at module load on `import.meta.env.DEV`. Change the
   * parse in both places or neither.
   *
   * Set `VITE_CFG_ENABLE_GOOGLE_TRANSLATE=false` for builds that must never
   * reach Google Translate.
   */
  ENABLE_GOOGLE_TRANSLATE:
    (
      (import.meta.env.VITE_CFG_ENABLE_GOOGLE_TRANSLATE as string) ?? ""
    ).toLowerCase() !== "false",
  /**
   * Click-to-load special embeds — the YouTube, Twitch, Lightspeed, Spotify,
   * SoundCloud and Bandcamp players. When on, each embed shows a local
   * "Load <provider>" button and mounts the third-party iframe only after a
   * tap, so opening a channel contacts none of those hosts.
   *
   * DEFAULT OFF: unset, the iframe mounts immediately, as it always has. The
   * F-Droid (foss) Android build passes `VITE_CFG_EMBEDS_CLICK_TO_LOAD=true`
   * in the `vite build` environment (never in a `.env` file).
   *
   * Read once per embed in `SpecialEmbed.tsx`, its only reader, negated as
   * the initial value of the `loaded` signal; the foss release gate counts
   * that single negated read in the dist, so don't add another reader.
   *
   * Set `VITE_CFG_EMBEDS_CLICK_TO_LOAD=true` for builds that should have it.
   */
  EMBEDS_CLICK_TO_LOAD:
    (
      (import.meta.env.VITE_CFG_EMBEDS_CLICK_TO_LOAD as string) ?? ""
    ).toLowerCase() == "true",
  /**
   * Native Android screen share (the "screen leg" publisher, screen-leg plan
   * §7). DEFAULT OFF, baked at APK BUILD time — this is the `.env` worktree
   * landmine (§0.8), NOT an `inject.js` runtime flag: verify the flag ON THE
   * ARTIFACT, never the source tree.
   *
   * Read in `nativeScreenShareAvailable()` (rtc/androidScreenShare.ts), the
   * single point the call-card button, the context-menu entry and
   * `toggleScreenshare`'s Android branch all sit behind. The backend
   * `Features.screen_leg` flag gates the token route independently — both
   * must be lit for a share to start, and the client copy for the
   * `FeatureDisabled` refusal assumes exactly that split.
   *
   * Set `VITE_CFG_ENABLE_ANDROID_SCREEN_SHARE=true` for Android builds that
   * should have it.
   */
  ENABLE_ANDROID_SCREEN_SHARE:
    (
      (import.meta.env.VITE_CFG_ENABLE_ANDROID_SCREEN_SHARE as string) ?? ""
    ).toLowerCase() == "true",
  /**
   * Linux screen-share audio — system audio for Entire Screen shares from
   * the Linux desktop shell, captured through a native PipeWire virtual
   * source that excludes Sloga's own playback (the echo-loop defense; see
   * discord-features-plans/linux-pipewire-screenshare-audio.md).
   *
   * DEFAULT OFF. The code paths also gate on `slogaShell.screenAudio` and
   * a runtime PipeWire probe, so this flag leaking into another surface is
   * inert — but only Linux shell builds should ever set it, and lighting
   * it is a Linux-only release decision that additionally requires the
   * slice-3 copy matrix (a capable shell whose capture failed must not get
   * the generic "pick a tab" retry copy).
   *
   * Read in `screenAudioSupported()` (rtc/screenAudioNative.ts), the single
   * point the capture path and the settings-modal copy sit behind.
   *
   * Set `VITE_CFG_ENABLE_LINUX_SCREEN_AUDIO=true` for Linux shell builds
   * that should have it.
   */
  ENABLE_LINUX_SCREEN_AUDIO:
    (
      (import.meta.env.VITE_CFG_ENABLE_LINUX_SCREEN_AUDIO as string) ?? ""
    ).toLowerCase() == "true",
  /**
   * Windows screen-share audio — system audio for Entire Screen shares from
   * the Windows desktop shell, captured natively through WASAPI process
   * loopback with Sloga's own render tree excluded (the echo-loop defense),
   * because the browser loopback this replaces is a measured no-op there.
   *
   * DEFAULT OFF. The code paths also gate on the shell's `screen_audio_probe`
   * and on the picker's audio-suppression check, so this flag leaking into
   * another surface is inert — but only Windows shell builds should ever set
   * it (`dist_rclit`; the web and Android dists stay dark and the Linux dist
   * must not carry it), and lighting it is a Windows-only release decision
   * that additionally requires the slice-3 copy matrix (a capable shell whose
   * capture failed must not get the generic "pick a tab" retry copy).
   *
   * Read in `screenAudioSupported()` (rtc/screenAudioNativeWin.ts), the single
   * point the capture path and the settings-modal copy sit behind;
   * `SLOGA_NO_SCREEN_AUDIO=1` is the shell-side runtime escape below the flag
   * and makes that probe answer false.
   *
   * Set `VITE_CFG_ENABLE_WIN_NATIVE_SCREEN_AUDIO=true` for Windows shell
   * builds that should have it.
   */
  ENABLE_WIN_NATIVE_SCREEN_AUDIO:
    (
      (import.meta.env.VITE_CFG_ENABLE_WIN_NATIVE_SCREEN_AUDIO as string) ?? ""
    ).toLowerCase() == "true",
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
