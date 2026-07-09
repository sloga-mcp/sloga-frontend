# Camera Effects & Settings — Implementation Plan (rev 2, audit-folded)

Status: REVISED after 3-reviewer panel audit of rev 1. Awaiting approval. Implementer = main thread.
Verdicts: all three reviewers **SHIP WITH FIXES**. Every finding below is folded in.

## Goal

Camera features for the Sloga SolidJS client (`packages/client`), all behind `CONFIGURATION.ENABLE_VIDEO`:

1. **Webcam preview in Settings** — opt-in self-view (like the existing mic test), WYSIWYG with brightness + background.
2. **In-call camera controls** — brightness + background from within a call.
3. **Webcam quality** — resolution/fps + max bitrate, clamped to the server `video_resolution` limit.
4. **Camera brightness** — hardware-first (`applyConstraints`), canvas fallback.
5. **Background effects** — blur + virtual (image) backgrounds via self-hosted MediaPipe. Desktop-first, off by default.

## KEY CORRECTIONS FROM AUDIT (these invalidate rev-1 assumptions)

- **C1 — Brightness must target the camera SOURCE, not `videoTrack.mediaStreamTrack`.** Once a `BackgroundProcessor` is attached, LiveKit's `LocalVideoTrack.mediaStreamTrack` getter returns the *processed* track (`livekit-client` `mediaStreamTrack => processor?.processedTrack ?? _mediaStreamTrack`). Applying `applyConstraints({advanced:[{brightness}]})` there hits the generated canvas track (no `brightness` capability) → silently ignored / `OverconstrainedError`. **Fix:** apply brightness to the source the processor reads: use `videoTrack.mediaStreamTrack` only when NO processor is attached; when a background processor is active, apply to the wrapper's `.source` (`ProcessorWrapper.source`). Capability-detect via `getCapabilities().brightness`. Documented gap (now correctly narrowed): brightness is unavailable only on cameras lacking hardware-brightness support **while** a background effect is active.
- **C2 — PWA precache is a hard build blocker.** `vision_wasm_internal.wasm` ≈ 9.4 MB and `vision_wasm_nosimd_internal.wasm` ≈ 9.3 MB. workbox's default `globPatterns` includes `**/*.{js,wasm,css,html}`, and vite-plugin-pwa **throws** when a globbed asset exceeds `maximumFileSizeToCacheInBytes: 4000000`. **Fix:** add `globIgnores: ["**/mediapipe/**"]` to the `injectManifest` block in `vite.config.ts` (that block currently has none). The `.tflite` model is NOT globbed by default → no precache concern.
- **C3 — Bitrate `0` freezes video + unit trap.** `VideoEncoding.maxBitrate` is required and in **bps**. `maxBitrate: 0` caps the encoder at zero → black/frozen outbound video. **Fix:** omit `videoEncoding` entirely when quality is "auto"; store bitrate in **kbps** (`0 = auto`), convert to bps (`kbps*1000`) at the LiveKit boundary, show Mbps in UI (`kbps/1000`). Comment the units at every conversion.
- **C4 — The screenshare quality helper does NOT clamp its high tiers.** `getEnabledScreenShareQualities()` gates only `high`/`text`; `fhd`/`qhd`/`uhd` are appended unconditionally, and it mutates the shared `ScreenSharePresets.original` singleton. Copying it would let the camera exceed the server `video_resolution` limit. **Fix:** extract a shared `clampResolutionToServerLimit(res)` util (reads `configuration.features.limits.default.video_resolution`); gate EVERY camera tier through it; clone presets before mutating. Fix the screenshare bug in the same pass.
- **C5 — No reusable interactive popover primitive.** The `floating` directive offers only `tooltip/userCard/contextMenu/autoComplete`; `contextMenu` self-dismisses on the first click and anchors to the mouse (a slider inside it closes instantly). **Fix:** the in-call control reuses the **modal system** (mirror the existing `screen_share_settings` modal) — a `camera_settings` modal opened from a caret button beside the camera `IconButton`. No new floating primitive.
- **C6 — Preview must not be a divergent second effect path, must be opt-in, and must not double-open the camera.** A raw `getUserMedia` `MediaStreamTrack` has no `setProcessor`. **Fix:** (a) preview is **opt-in** via a "Test camera" toggle (mirror `MicrophoneTest`), not auto-started on mount; (b) when a call is live with the camera on, the preview attaches to the **existing published `LocalVideoTrack`** (true WYSIWYG, no second open, no second segmenter); (c) when idle, wrap the gUM track in a LiveKit `LocalVideoTrack` and run the identical `#applyCameraEffects` path so preview and transmit share ONE implementation.

## Architecture

- **Brightness → source constraint** (per C1). Hardware `applyConstraints` on the source track; canvas `BrightnessVideoProcessor` fallback used only when no background is active. Re-apply brightness after any `stopProcessor`/background-off transition (LiveKit's `internalStopProcessor` re-applies the track's original `_constraints`, which drops an imperatively-set brightness — see H-lifecycle below).
- **Background → single LiveKit processor** via `@livekit/track-processors` `BackgroundProcessor({mode, blurRadius|imagePath, assetPaths})`; `switchTo()` for mode changes **within a live track session only**. Bind wrapper lifetime to the camera-track lifetime: recreate (`new BackgroundProcessor` + `setProcessor`) on each camera enable; null the reference on camera-off/disconnect (camera-off destroys the attached processor, so a cached wrapper is stale).
- **Single source of truth:** user intent lives ONLY in the reactive Voice store (read reactively in preview + modal). New RTC-`Voice`-class signals are added ONLY for runtime-only facts: `cameraBrightnessHardwareSupported`, background-processor status (`idle|initializing|active|failed`).
- **Zero overhead at default:** when brightness === 100 AND background === none, `setProcessor(undefined)` + `destroy()` the processor and revert to the raw track (fixes the existing bug at `state.tsx:451` that nulls the ref without `destroy()`, leaking a rAF + `captureStream(30)` loop).
- **Fail-safe:** each `setProcessor`/`switchTo`/`applyConstraints` is individually try/caught; one effect failing (e.g. WASM blocked) must not skip the other, and the raw camera stays published.

## Self-hosted assets (no runtime CDN — mandatory)

`@livekit/track-processors` defaults to `cdn.jsdelivr.net` (fileset) + `storage.googleapis.com` (model); both overridden via `assetPaths`.

- Copy `@mediapipe/tasks-vision/wasm/*` → `public/mediapipe/wasm/`. **Copy only the SIMD build actually used** where possible (gate via `supportsModernBackgroundProcessors()`); avoid shipping ~19 MB (both SIMD + no-SIMD) in git and the APK.
- Model: `public/mediapipe/models/selfie_segmenter.tflite` (~250 KB general model — NOT the ~16 MB multiclass). Committed for reproducible/offline builds.
- Bundled preset backgrounds: `public/mediapipe/backgrounds/`.
- `vite.config.ts`: add `globIgnores: ["**/mediapipe/**"]` to `injectManifest` (per C2).
- `common/lib/env.ts`: `SEGMENTATION_ASSETS_URL: (import.meta.env.VITE_SEGMENTATION_ASSETS_URL as string) ?? ""`. Consumption site uses a **truthy** fallback: `CONFIGURATION.SEGMENTATION_ASSETS_URL || \`${import.meta.env.BASE_URL}mediapipe\`` (a leftover `__VITE_...__` placeholder is truthy, so `||` still routes to it — but see Docker note). Pass `assetPaths.tasksVisionFileSet = <base>/wasm`, `assetPaths.modelAssetPath = <base>/models/selfie_segmenter.tflite`.
- Docker: add the var in **all three** places — `Dockerfile` build-stage ENV, `Dockerfile` runtime-stage ENV default (`""`), and `docker/inject.js` REPLACEMENTS — mirroring RNNOISE. (If `inject.js` is missed, the placeholder stays and is truthy → broken fetch; enumerate all three.)
- **Android:** exclude `mediapipe/**` from the Capacitor `dist` bundle (background effects are desktop-first/disabled on Android — don't ship the WASM in the APK).
- **CSP (document, don't silently regress):** MediaPipe needs `script-src 'wasm-unsafe-eval'`, `blob:` (worker/child/img as applicable), and `connect-src 'self'` for the local assets. The main app webview has no CSP today (Tauri `csp: null`, remote origin), so it runs now; record these directives so a future CSP tightening (the E2EE path already sets a strict CSP) is coordinated.

## Store — `state/stores/Voice.ts`

New `TypeVoice` fields (each with `default()`, validated/clamped `clean()`, AND both getter+setter — several existing fields are setter-only; new ones must be readable reactively):
- `cameraQuality: CameraQualityName` (`"auto"|"sd"|"hd"|"fhd"`), default `"auto"`; validate against a `CameraQualityNames` array.
- `cameraMaxBitrateKbps: number` (`0 = auto`), default `0`; clamp `[0, 20000]`.
- `cameraBackgroundMode: "none"|"blur"|"image"`, default `"none"`; enum-validated.
- `cameraBlurRadius: number`, default `10`; clamp `[1, 20]`.
- `cameraBackgroundImageId?: string` (uploads = generated id; presets = `preset:<name>`).

Back-compat: `clean()` seeds from `default()` and only overrides present fields → missing new fields ⇒ defaults. **Dangling id:** on load/apply, if `cameraBackgroundImageId` no longer resolves (deleted blob), fall back to `"none"`.

Virtual backgrounds: `cameraBackgrounds.ts` helper — localforage Blob store (list/add/remove) + bundled presets; produces object URLs and **revokes the specific prior URL** on change and on teardown (no per-render create).

## State — `components/rtc/state.tsx`

- `#applyCameraEffects(videoTrack)`: idempotent; applies brightness (source-targeted per C1) + background (recreate-per-enable per lifecycle) with per-effect try/catch. Called on camera enable and after live device switch.
- `setCameraBrightness(n)`: source-targeted hardware path; canvas fallback only when no background; re-apply after stopProcessor; teardown at 100+none.
- `setCameraBackground(mode, {blurRadius?, imageId?})`: manage the single processor (create/`switchTo`/teardown); persist to store; update runtime status signal.
- Camera quality: `getEnabledCameraQualities()` using the shared `clampResolutionToServerLimit`; apply resolution at **camera-enable** time (pass constraints to the enable path, not only `connect()`), and via `restartTrack`/`applyConstraints` on live change; `publishDefaults.videoEncoding` only when bitrate ≠ auto (per C3). Document/verify interaction with simulcast.
- Live device switch (`preferredVideoDevice` change during a call): re-invoke `#applyCameraEffects`.
- Cleanup: `disconnect()` + camera-off destroy processor, revoke URLs, cancel rAF, null wrapper.

## UI

- **`CameraPreview.tsx`** (settings): opt-in "Test camera" toggle (mirror `MicrophoneTest` start/stop + `onCleanup`); one effect keyed on `preferredVideoDevice` (stops the previous stream in its own `onCleanup` — no LED leak on device change); effect/brightness changes update the processor/constraints WITHOUT reacquiring; when a call is live, bind to the published track instead of a second open; shows permission-denied/unavailable state.
- **`ScreenShareOptions.tsx` → `CameraOptions.tsx`** (update `VoiceSettings.tsx` import): preview + background picker (None / Blur[strength] / image gallery: presets + upload + delete) + camera-quality selector (resolution/fps + max-bitrate Mbps). Background section gated on `ENABLE_VIDEO && supportsBackgroundProcessors() && !isNativePlatform()`, off by default, with a perf note. Quality labels via lingui macros (not raw template strings).
- **In-call:** caret button beside the camera `IconButton` in `VoiceCallCardActions.tsx` opens a `camera_settings` modal (reuse the modal system, mirror `screen_share_settings`) with brightness + background controls calling the live `voice.*` methods.
- All strings via `Trans`/`t`.

## Platform / perf

Desktop-first; background gated + off by default. Optional `onFrameProcessed` stats to guard against frame-time blowups. Brightness hardware path on web+Tauri (Chromium); canvas fallback everywhere.

## Verification

- `mise exec -- pnpm` typecheck + **`vite build`** (proves the PWA/globIgnores fix — C2).
- Dev drive: opt-in preview renders; blur/image + brightness visibly change the preview; leaving/stopping preview turns the camera LED off; no second camera open while in a call.
- In a call: modal changes apply to the **transmitted** track (verify via a second client/loopback), brightness composes with background on a HW-capable cam, quality never exceeds the server limit, bitrate=auto publishes normal video.

## Risks / residual

- Brightness+background on a no-HW-brightness camera: unavailable while background active (documented, narrowed).
- Live quality change interaction with simulcast — verify `publishDefaults`/`restartTrack` applies to the camera track.
- Future CSP tightening would break background effects unless the documented directives are added (coordinated, not silent).

## Scope decision to confirm at approval

Virtual-background **uploads** (localforage + object-URL lifecycle) are the most leak-prone surface. Options: (A) full scope now — blur + presets + user uploads; (B) phase 1 = blur + bundled presets only, defer uploads to phase 2 (smaller/safer v1). User previously chose "blur + virtual backgrounds"; confirm A vs B.

## rev 3 — final-audit fixes applied (2026-07-08)

3-reviewer final audit of the diff returned DO NOT SHIP (2 HIGH) + SHIP WITH FIXES.
All folded in; `vite build` passes; camera strings extracted into catalogs.

- **HIGH — preview gUM cancellation:** `CameraPreview` now uses a `gen` token; a
  `getUserMedia` that resolves after stop/device-change/live-takeover/unmount is
  detected stale and its tracks stopped immediately (no leaked camera LED, no
  double-open during a call).
- **HIGH — background-init fail-safe:** `CameraEffectsController` assigns `#bg`
  only AFTER `setProcessor` resolves; `#applyInner` catches a background failure,
  tears it down, and STILL applies brightness (never a poisoned wrapper / skipped
  brightness).
- **HIGH — in-call preview WYSIWYG:** the `<video>` binding effect now depends on
  `cameraBackgroundStatus()` + brightness/mode, so a live-track effect change
  re-reads the processed track.
- **HIGH — APK bloat:** `build:android` prunes `dist/mediapipe/**` before
  `cap sync` (background effects are gated off on native).
- **MEDIUM:** apply pipeline serialized via an internal promise chain (no
  segmenter race on slider drag); `ScreenSharePresets.original` cloned before
  mutation; live camera device-switch re-applies effects (`reapplyCameraEffects`
  + watcher in `VoiceContext`); `lingui extract` run.
- **LOW:** image→blur revokes the prior object URL; gallery uses per-run revoke
  lists + disposed guard; deleting the selected background clears the id;
  `CameraBackgroundMode` consolidated to the store type.

**Decision — WASM variants:** both SIMD + no-SIMD are shipped for web (MediaPipe
feature-detects SIMD; no-SIMD browsers fall back). This deviates from rev-1
"SIMD only" but is safe: the Android prune keeps the ~19 MB out of the APK, and
web hosting cost is one-time. Follow-up (LOW): no build-time copy ties the
committed WASM to the installed `@mediapipe/tasks-vision` version (byte-identical
today at 0.10.14) — add a sync/CI-hash check before a dependency bump.

**Still owed:** runtime verification with a real camera (preview, blur/virtual
bg, brightness compose, LED-off on leave, in-call modal, transmitted-track
change) — needs the dev server + a webcam; a re-verify pass on the HIGH fixes.

## rev 4 — re-verify pass fixes (2026-07-08)

A 2-reviewer re-verify of the rev-3 fixes returned FIXES INCOMPLETE (rev-3 closed
every headline finding, but the HIGH-2 fix opened a new window + two fixes were
partial). All folded; `vite build` green:

- **HIGH — teardown-during-init leak:** `CameraEffectsController` now carries a
  `#gen` token bumped by `reset()`/`detach()`. If `setProcessor` is still
  initializing when torn down, the resolved processor is `destroy()`-ed instead
  of resurrecting a stale `#bg` (was leaking the WebGL context + WASM segmenter,
  and in the preview showing raw video while reporting "active").
- **MEDIUM — brightness-only live WYSIWYG:** new `cameraEffectsApplied()` tick
  bumped after each live apply settles; the preview binding depends on it, so a
  canvas-fallback brightness change (async track swap) refreshes the self-view.
- **MEDIUM — device-switch timing:** re-apply now runs off LiveKit's
  `activeDeviceChanged` event (after the track restart completes), not the sync
  store write — so hardware brightness (dropped by restart) is re-established on
  the new source. The old `VoiceContext` watcher was removed.
- **MEDIUM — preview flicker:** binding effect has a track-identity guard (no
  `srcObject` reassign when unchanged).
- **MEDIUM — preview clobber:** dropped the redundant post-`applyEffects` stale
  check that could tear down a newer acquire.
- **LOW — gallery overlap:** per-fetch `fetchSeq` guard prevents an out-of-order
  refetch from revoking the displayed thumbnails' URLs.

Confirmed sound across the re-verify: HIGH-1 gen token, HIGH-2 fail-safe, the
serialization chain, image→blur revoke, APK prune, singleton clone, lingui,
store, env/Docker. **Only runtime verification with a real webcam remains.**

## Runtime verification — DONE on real hardware (2026-07-08)

Driven end-to-end on a real webcam at `localhost:5174`. All confirmed working:
- Preview renders; **camera LED goes off** on Stop / leaving settings (the gUM
  cancellation / leak fix).
- **Blur** segmentation renders on a live person.
- **Virtual backgrounds** — presets + upload + delete all work.
- **In-call two-tab test** — a second client sees the blur on the *transmitted*
  track (WYSIWYG on the sent path, not just local preview).

Bugs found & fixed during verification (in this commit):
- Selecting **Image** with nothing chosen yet reverted to None (hid the picker);
  now stays in Image mode unless a *selected* image is missing (`cameraEffects.ts`
  `#ensureBackground`).
- Gallery thumbnails now lazy-load only in Image mode (`CameraOptions.tsx`).
- Preview effect failures now log instead of swallowing silently (`CameraPreview.tsx`).

**Dev-environment caveat (NOT a product bug):** the Vite dev server (WSL polling
watcher) serves the 9 MB MediaPipe WASM at ~15 KB/s, so blur/virtual-bg can't
initialize through `mise dev`/the tunnel — segmentation stalls with no error. To
verify locally, serve `public/mediapipe` from a fast static server and point
`VITE_SEGMENTATION_ASSETS_URL` at it. **Production follow-up:** ensure the static
host serves `.wasm` with brotli/gzip (~3 MB) so real users get a fast one-time load.

## Out of scope

Android background effects, beautify/touch-up filters, per-server background policies.
