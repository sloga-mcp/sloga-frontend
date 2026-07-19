# Camera Face Filters — Design Plan (rev 3)

**Feature:** Instagram/TikTok/Snapchat-style webcam filters for video calls:
1. **AR stickers** ("silly overlays") — dog ears, cat ears + whiskers, sunglasses, mustache, party hat, heart eyes, tracked to the user's face.
2. **Beautify** ("look better") — adjustable skin-smoothing slider, subtle and off by default.
3. **Color looks** — one-tap color grades (Warm, Cool, Vintage, Mono, Vivid) à la Instagram.

**Scope:** frontend-only (`packages/client`). No backend, no migration, no stoat.js change. Desktop/web first; Capacitor (Android) excluded exactly like background effects. Composes with media E2EE trivially: processors run pre-encryption on the local track, same as the shipped background blur.

**Rev 2:** folds the full rev-1 audit (frontend-code-reviewer, NEEDS-REVISION: 1 CRITICAL, 3 HIGH, 4 MEDIUM, 2 LOW).
**Rev 3:** folds the rev-2 re-verify (APPROVE-WITH-CHANGES: all 10 resolved; 1 new MEDIUM + 3 LOW, all spec-text). Ledgers in §12.

---

## 1. Where this sits in the existing architecture

The shipped camera-effects engine (`components/rtc/cameraEffects.ts`, plan doc `docs/camera-effects-plan.md`) established:

- **One LiveKit processor slot per LocalVideoTrack.** `CameraEffectsController` currently puts EITHER a `BackgroundProcessor` (blur/virtual bg, MediaPipe selfie segmenter) OR the `BrightnessVideoProcessor` canvas fallback there — never both.
- **Brightness targets the camera SOURCE** (`wrapper.source` when a processor is attached; once ANY processor is attached, `track.mediaStreamTrack` returns the PROCESSED track), so hardware brightness composes with whatever occupies the slot.
- **Generation token (`#gen`)** so a teardown during the ~1s MediaPipe init destroys the just-built processor instead of resurrecting a leaked WebGL/WASM wrapper.
- **Serialized `apply()`** via an internal promise chain.
- **Self-hosted MediaPipe** under `public/mediapipe/` (`tasks-vision` wasm fileset + `selfie_segmenter.tflite`); `SEGMENTATION_ASSET_PATHS` + optional `VITE_SEGMENTATION_ASSETS_URL` override; PWA `globIgnores: ["**/mediapipe/**"]` (verified `vite.config.ts:48`); `build:android` prunes `dist/mediapipe` (verified `package.json:7` — covers the new `.task`).
- **Fail-safe rule:** an effect failure must never stop the raw track from publishing; surface a `failed` status instead.
- Used by BOTH the in-call path and the settings preview (`CameraPreview.tsx`), single shared controller class, one controller per consumer.

This feature extends that engine; it does not fork it.

## 2. New processor: `FaceFilterProcessor`

A new canvas-pipeline processor implementing all three filter families in one per-frame pass:

```
source video frame
  → [color look + non-HW brightness]  ctx.filter = "sepia(.35) saturate(1.1) … brightness(x%)"
  → draw to canvas
  → [beautify]                        masked skin-smoothing pass (§4)
  → [AR stickers]                     drawImage(bitmap) transformed by face landmarks (§3)
  → canvas.captureStream(30) → processedTrack
```

**TrackProcessor contract (full — audit finding 2):** LiveKit's `TrackProcessor` interface requires `init`, `restart`, AND `destroy`; `LocalTrack.restart()` (device switch, constraint restart) calls `processor.restart({track, kind, element})` unconditionally BEFORE any `activeDeviceChanged` handler runs. Therefore:

- `FaceFilterProcessor` implements **`restart(opts)`**: LIVE REBIND ONLY — rebind the hidden `<video>.srcObject` to the new source track, update `this.source` (§5), keep the landmarker + canvas + decoded bitmaps alive (no re-init, no flicker), resume the frame loop. `restart` is only ever called by LiveKit on a live (non-destroyed) processor.
- `init()` is a **FULL BUILD from scratch**, callable again after `destroy()` on the same instance (LiveKit reuses the processor object): it resets `#disposed` and `#stopped`, (re)builds the canvas/video elements, CLEARS and re-decodes the sticker bitmap cache, and leaves the landmarker to the lazy-init rules below. It must never resume prior state — after `destroy()` the landmarker is closed/nulled and the bitmap cache cleared, so nothing survives to resume (a set `#disposed` flag left unreset would make every later `setConfig` continuation self-discard forever; a stale bitmap cache would hold CLOSED ImageBitmaps whose `drawImage` throws and kills the loop).
- `destroy()` closes AND **clears** the bitmap cache (never close-in-place leaving entries behind), cancels the frame callback, closes+nulls the landmarker, sets `#disposed`.
- **Same pass fixes the latent existing bug:** `BrightnessVideoProcessor` also lacks `restart` today (device switch with canvas-brightness active would throw `restart is not a function` and reject `restartTrack`) — add `restart` there too.
- `this.source: MediaStreamTrack` — public readonly reference to the RAW camera track (set in `init`/`restart`), mirroring `BackgroundProcessorWrapper.source`. The controller's brightness logic depends on it (§5).

**Face tracking:** MediaPipe **`FaceLandmarker`** from `@mediapipe/tasks-vision`, which must be added as a **direct dependency of `packages/client`, exact-pinned `0.10.14`** (audit finding 4 — today it is only a transitive dep of `@livekit/track-processors` and does not resolve under pnpm strict layout; exact pin because the committed `public/mediapipe/wasm` fileset is byte-tied to that version and nothing else guards the coupling). It shares the SAME self-hosted wasm fileset already in `public/mediapipe/wasm` — the only new model asset is `models/face_landmarker.task` (~3.7 MB) fetched from `SEGMENTATION_BASE/models/`, never a CDN. `numFaces: 1`, `runningMode: "VIDEO"` (pass `performance.now()` timestamps, monotonic).

**Delegate fallback is explicit (audit finding 5):** tasks-vision does NOT fall back internally. Init tries `delegate: "GPU"`; on rejection, retry once with `delegate: "CPU"` before declaring failure. CPU mode feeds the §8 degrade ladder (start CPU sessions at landmark-every-2nd-frame).

**Detection runs only when needed:** stickers or beautify require landmarks; a look-only config skips FaceLandmarker init entirely (pure `ctx.filter`, works even where init would fail).

**Internal config generation (audit finding 3):** live `setConfig` can trigger the LAZY landmarker init (look-only → user taps a sticker), which is invisible to the controller's `#gen`/serialized chain. The processor therefore keeps its own `#cfgGen` + `#disposed` flag: every async continuation inside `setConfig`/lazy-init re-checks them on resolve; a stale or post-`destroy()` resolve calls `faceLandmarker.close()` immediately and discards the instance.

**Failure taxonomy (re-verify NEW-3 — which failures reject `init` vs degrade internally):**
- **Landmarker failures** (`.task` fetch, `createFromOptions` after the GPU→CPU retry, per-frame detect throwing) are **non-fatal inside the processor**: it degrades to look-only rendering, keeps drawing, and reports the landmark-dependent parts as `failed` through the status callback. They never reject `init`.
- **Pipeline failures** (canvas creation/2d context, `captureStream`, hidden-video `play()`) **reject `init`/`restart`** → the controller's fail-safe path runs (teardown, `failed` status, raw track publishes).
The §5 carried-over invariant ("filter failure → teardown → brightness still applied → rethrow") applies to the pipeline class only.

**Frame loop:** `video.requestVideoFrameCallback` when available (cancel via `video.cancelVideoFrameCallback(id)` — not `cancelAnimationFrame`), rAF fallback; `#stopped` guard as in `BrightnessVideoProcessor`.

**No face detected:** draw the frame with color look + no stickers/beautify (never freeze/blank). Keep the last landmark result ≤3 frames to bridge dropouts, then drop overlays.

**Landmarker init failure with a mixed config (audit finding 10):** degrade to look-only rendering (looks don't need landmarks) + `failed` status for the landmark-dependent parts, instead of full teardown — the fail-safe rule still guarantees the raw track publishes if even that fails.

## 3. AR sticker system

**Assets:** original in-house SVG-drawn sticker art rasterized to PNG at author time (no third-party IP — we must NOT ship Snapchat/Instagram assets). Stored under `public/filters/`; SVG sources in `assets/filters-src/` with a small node rasterize script; commit both. Launch set (6): `dog` (ears + nose + tongue), `cat` (ears + whiskers), `sunglasses`, `mustache`, `party-hat`, `heart-eyes`.

**Manifest** (`rtc/faceFilterCatalog.ts`): each filter = list of anchored layers:

```ts
interface StickerLayer {
  src: string;                    // catalog-relative name, resolved via FILTER_ASSETS_BASE
  anchor: "head-top" | "eyes" | "nose" | "upper-lip" | "left-eye" | "right-eye";
  widthFactor: number;            // sticker width as multiple of inter-ocular or face width
  offset: { x: number; y: number }; // in face-width units, along the face's local axes
}
```

- **BASE_URL-aware (audit finding 9):** assets resolve through `FILTER_ASSETS_BASE = \`${import.meta.env.BASE_URL}filters\`` (same pattern as `SEGMENTATION_BASE`) so non-root deployments and the Tauri remote origin work.
- **Decode once (audit finding 9):** on `setConfig`, `createImageBitmap` each layer once and cache; the frame loop only `drawImage`s bitmaps — no per-frame fetch/decode/allocation. Bitmaps `.close()`d on config change away / `destroy()`.

**Placement math per frame:** from the 478-landmark result take right/left eye outer corners (33, 263) and nose tip (1): position = anchor landmark(s); scale = distance(33,263) × widthFactor; roll = atan2 of the eye line. `ctx.setTransform`-rotate, draw, reset. Yaw/pitch foreshortening is out of scope for v1 (flat stickers) — correct for typical webcam head poses.

**Mirroring:** the self-view is CSS-mirrored, but the processor draws on the UNMIRRORED transmitted frame; anchors are defined on the unmirrored frame so remote viewers see stickers correctly and the mirrored self-view stays self-consistent. No special-casing.

## 4. Beautify (skin smoothing)

Cheap, robust canvas approach — no custom WebGL shaders in v1:

1. Draw the current frame to an offscreen canvas at **half resolution** with `ctx.filter = blur(Npx)` → smoothed layer (downscale is part of the design, not just a fallback — blur hides it).
2. Build a face-region mask from the FaceLandmarker face-oval landmark path (path-fill on a mask canvas, feathered edge via mask-canvas blur), minus eye/mouth cutout paths so eyes and lips stay sharp.
3. Composite: main frame, then smoothed layer through the mask at `strength` (slider 0–100 → blend alpha 0–0.65, blur radius 2–6 px scaled by face size).

Strength 0 skips the pass entirely. This is the "webcam beautify" class (Zoom touch-up), not a makeup engine.

## 5. Slot composition & controller changes

The single processor slot now has three candidates. The occupant decision is an extracted **pure function** `pickSlotOccupant(settings, caps): "background" | "face" | "brightness-fallback" | "none"` (unit-testable):

| Active settings | Slot holds |
|---|---|
| background (blur/image) on | `BackgroundProcessor` — filters INERT (v1 gap, see below) |
| filters on (sticker/beautify/look), background off | `FaceFilterProcessor` |
| neither; brightness≠100 and no HW brightness | `BrightnessVideoProcessor` |
| neither; brightness HW or =100 | none |

**Inert semantics (audit finding 6c — pinned):** filter settings WRITE THROUGH to the store even while a background is active; they are rendered inert. Both UI surfaces show a persistent badge on the Filters subsection while inert — "Paused while background effects are on" — and the moment-of-toggle inline note. Predictable resume, no destroyed settings, no surprise dog-ears (the badge is always visible when the state exists). [Operator may flip this to auto-clear; default is paused-badge.]

**Brightness × filters (audit finding 1 — CRITICAL rework).** The rev-1 rule was wrong: with `FaceFilterProcessor` attached, `track.mediaStreamTrack` returns the processed canvas track, so the old `#applyBrightness` would (a) mis-detect HW support against the canvas track, firing a spurious `onHwSupportChange(false)`, (b) double-apply brightness (source constraint still active + ctx.filter), and (c) its non-HW branch would `setProcessor(BrightnessVideoProcessor)`, evicting the filter processor. Rev-2 spec:

- `#applyBrightness` resolves the RAW source as `this.#bg?.source ?? this.#face?.source ?? track.mediaStreamTrack` — HW capability detection and `applyConstraints` ALWAYS target the raw camera track, under any occupant.
- **Probe before build (re-verify NEW-2):** when the face occupant is about to be built, the HW-brightness capability is probed on the raw track FIRST (it is available pre-attach), and that single verdict decides the `brightness` value in the filter config handed to `setProcessor` — store brightness only when the source lacks HW support, else `100`. No build-then-correct `setConfig`, so there is no transient double-brighten (HW) or under-brighten (non-HW) frame window. `#hasHwBrightness` + `onHwSupportChange` stay SINGLE-SOURCED in `#applyBrightness`-shared helpers — the build path calls the same probe, never duplicates it.
- If HW brightness exists on the source: apply the constraint there; `FaceFilterProcessor` receives `brightness: 100` (neutral) in its config. Exactly one brightness mechanism active.
- If no HW brightness AND `#face` holds the slot: pass `brightness` into the filter config (applied in its ctx.filter chain). The `BrightnessVideoProcessor` fallback is NEVER attached while `#face` (or `#bg`) holds the slot — the fallback branch is guarded on occupant === none. This is an improvement over the background gap: non-HW users keep brightness under filters.
- **Slot handoffs cross-null all occupant references** (`#bg`/`#face`/`#brightness`): whenever one is (re)built the other two are torn down/nulled first, extending the existing `this.#brightness = undefined; // slot goes to the background` line into a single `#takeSlot(kind)` helper.

**Occupant transitions (audit finding 6a/6b — enumerated):** every `apply` computes `pickSlotOccupant` and, if the occupant KIND changed, performs teardown-then-build in that order (`stopProcessor` old → `setProcessor` new), each side under the existing `#gen` supersession checks. Specifically specced: background→face (bg disabled mid-call with filter settings present), face→brightness-fallback (filters cleared, brightness≠100 non-HW), face→none, and the reverse of each. Same-kind occupant + changed settings = live `setConfig`/`switchTo`, no rebuild.

**Status signals (audit finding 6a):** `state.tsx` currently derives camera-effect status from `backgroundActive` alone; add a parallel `faceFilterStatus: idle/initializing/active/failed` signal fed by the controller (`onFaceFilterStatus` callback, symmetric with the background status surface), consumed by both the preview and in-call UI.

All existing invariants carry over: serialized chain, `#gen` re-check after every await that can straddle reset/detach, assign-`#face`-only-after-`setProcessor`-resolves, destroy-on-superseded-init, fail-safe ordering (filter failure → teardown → brightness still applied → rethrow as `failed`).

## 6. Settings, state, UI

**Voice store** (`state/stores/Voice.ts`) — new persisted fields following the store's established contract (audit finding 7): defaults in `default()`, validation in `clean()`, getter+setter pairs, and the store's optional-`undefined` convention (NOT `null`):

```ts
cameraFaceFilterId?: string;   // undefined = none; clean(): must be a catalog id, else undefined
cameraBeautify: number;        // 0–100, default 0; clean(): clamp + non-finite → 0
cameraColorLookId?: string;    // undefined = none; clean(): must be a look id, else undefined
```

Catalog lookup misses at render time (e.g. a filter removed in a later release) render as None and are cleaned to `undefined` on next `clean()`. Sync-store round-trips `undefined` by omission, matching `cameraBackgroundImageId`. **Do NOT under-stage `Voice.ts`** (camera-effects merge gotcha).

**Settings UI** (Voice settings → Camera section, below background effects): "Filters" subsection —
- sticker gallery: thumbnail grid (None + 6), single-select;
- Beautify slider (0–100);
- Looks: horizontal chip row (None, Warm, Cool, Vintage, Mono, Vivid) with preview swatches;
- the inert "paused" badge per §5.
Gated by `faceFiltersSupported()` = same gate as `cameraBackgroundSupported()` (processor support && !Capacitor), under the existing `ENABLE_VIDEO` flag. Preview reuses `CameraPreview.tsx` + its controller — filters show live in the preview exactly like backgrounds.

**In-call:** the existing `camera_settings` modal (tune button) gets the same Filters subsection.

**i18n:** all new strings through lingui with real msgids (missing msgids render 6-char hashes — known landmine); catalogs are precompiled `messages.ts`, follow the established recipe.

## 7. Assets & build plumbing

- `public/mediapipe/models/face_landmarker.task` (~3.7 MB) — same self-host + `VITE_SEGMENTATION_ASSETS_URL` override; PWA `globIgnores` and android prune verified to cover it (§1).
- `public/filters/*.png` + thumbnails — small; INCLUDED in PWA precache; verify total <200 KB.
- `package.json`: add `@mediapipe/tasks-vision` **exact** `0.10.14` (§2). **Residual (re-verify NEW-4):** the exact pin does NOT stop a future `@livekit/track-processors` bump from pulling a NEWER transitive tasks-vision for the background path (dual-version install; new JS against the committed 0.10.14 wasm = subtle background-blur breakage while filters keep working). The wasm↔version guard already owed by the camera-effects plan (rev-3 ledger LOW: build-time hash/CI check tying `public/mediapipe` to the package version) is a HARD PREREQUISITE for any future bump of either package — until it exists, bumping `@livekit/track-processors` requires manually re-vendoring the wasm fileset.
- Dev-env gotcha carried over: Vite dev serves mediapipe assets at ~15 KB/s through the WSL polling watcher — local verification of the landmarker uses the `VITE_SEGMENTATION_ASSETS_URL` fast-static-server recipe.

## 8. Performance budget & degrade ladder (audit finding 8 — measurable spec)

- Target: 30 fps at ≤720p typical; FaceLandmarker GPU ~3–8 ms/frame on desktop.
- **Measurement:** per-frame cost = wall time of (detect if run + full draw pass), rolling mean over the last 60 processed frames, computed inside the frame loop.
- **Ladder (in order), trigger = rolling mean > 22 ms:**
  1. landmark cadence → every 2nd frame (reuse last result; stickers tolerate 15 Hz);
  2. smoothed-layer resolution → quarter (from the default half);
  3. beautify pass off (stickers/looks stay), `degraded` surfaced.
- **Hysteresis / re-upgrade:** one ladder step back up after the rolling mean stays < 14 ms for 10 s; no oscillation faster than that.
- CPU-delegate sessions (§2 fallback) START at step 1.
- **Observable:** current ladder step exposed on the processor (debug getter + fed into the status callback as `degraded: 0–3`) so the runtime gate can assert it.
- Idle cost: all three settings at defaults → controller tears the processor down entirely (zero overhead, same rule as brightness 100).

## 9. Failure modes & edge cases

1. `face_landmarker.task` fetch/init fails (after GPU→CPU retry) → landmarker-class failure (§2 taxonomy): processor degrades to look-only + `failed` for landmark features, never rejects `init`. Pipeline-class failure (canvas/captureStream/video) → `init` rejects → controller teardown, raw track publishes.
2. Teardown during ~1s landmarker init → controller `#gen` supersession AND processor-internal `#cfgGen`/`#disposed` (lazy-init path) both destroy the fresh landmarker (§2).
3. Camera device switch mid-call → LiveKit calls `processor.restart()` (now implemented, §2); `activeDeviceChanged` re-apply then reconciles settings as today.
4. Track resolution change → processor re-reads `videoWidth/Height` per frame, resizes canvases when changed.
5. Multiple faces: `numFaces: 1` — most-prominent face gets the filter. Documented.
6. Screen-share tracks: filters apply ONLY to the camera track (controller is camera-scoped).
7. E2EE media (MLS): unchanged — the processed track is what gets encrypted, same as blur.

## 10. Testing & gates

- **Unit:** `pickSlotOccupant` full transition table (incl. inert combinations); placement math with fixture landmark sets; catalog/manifest validation; store `clean()` rules; brightness-resolution logic (raw-source selection per occupant).
- **Build:** `vite build` green; `build:android` prune verified; pnpm resolution of the new direct dep.
- **Runtime gate (real webcam, like the camera-effects gate):** stickers track (move/tilt head); beautify smooths without haloing eyes/mouth; looks apply; **two-tab in-call test confirms the TRANSMITTED track carries the filter**; **mid-call camera device switch with a sticker active** (finding-2 regression leg); background↔filter handoff both directions incl. paused badge; brightness under filters on a HW and a non-HW camera (finding-1 regression leg: no double-brighten, no spurious hw flip); LED-off on close; failed-init path (rename `.task`) → look-only degrade; degrade-ladder observable check.
- **Review flow:** this doc rev 2 → reviewer re-verify → user approval → implement → diff review → runtime gate.

## 11. Explicitly out of scope (v1)

- Combining background blur/image WITH face filters (composite processor — v2; v1 = paused-badge mutual exclusion).
- 3D/deforming face effects (face-swap, big-mouth warp — mesh warping, v2+).
- Makeup-grade beautify, yaw/pitch-foreshortened stickers.
- Android/Capacitor (same exclusion as backgrounds).
- Filter picker directly on the call card (v1 entry points: settings preview + in-call camera_settings modal).

## 12. Rev-1 → rev-2 audit ledger

| # | Sev | Finding | Resolution (section) |
|---|---|---|---|
| 1 | CRITICAL | Brightness rule double-applies on HW cameras; spurious hw flip; fallback could evict filter processor | §5 rework: raw-source resolution via `#bg?.source ?? #face?.source`, single-mechanism rule, occupant-guarded fallback, `#takeSlot` cross-nulling |
| 2 | HIGH | `restart()` required by LiveKit, unimplemented in template processor | §2 contract: `restart` on FaceFilterProcessor AND BrightnessVideoProcessor; re-entrant `init` |
| 3 | HIGH | Lazy landmarker init via `setConfig` escapes `#gen` | §2 `#cfgGen`/`#disposed` internal tokens; stale resolve → `close()` |
| 4 | HIGH | tasks-vision not actually a direct dep | §2/§7: direct dep, exact-pin 0.10.14 (wasm byte-coupling) |
| 5 | MEDIUM | No internal GPU→CPU fallback in tasks-vision | §2 explicit GPU-then-CPU retry; CPU starts degraded |
| 6 | MEDIUM | Transitions/inert semantics/status signal unpinned | §5: transition enumeration, paused-badge write-through, `faceFilterStatus` signal |
| 7 | MEDIUM | Store contract (default/clean/getters, null vs undefined) | §6: full contract, `undefined` convention, catalog validation |
| 8 | MEDIUM | Degrade ladder unmeasurable; beautify/canvas cost unguarded | §8: rolling-mean spec, 3-step ladder, hysteresis, observable |
| 9 | LOW | Sticker paths not BASE_URL-aware; per-frame decode | §3: `FILTER_ASSETS_BASE`, `createImageBitmap` once, `.close()` lifecycle |
| 10 | LOW | rVFC cancel API; landmarker nulling; full-teardown too aggressive | §2/§9: `cancelVideoFrameCallback`, null-on-destroy, look-only degrade |

## 13. Rev-2 → rev-3 ledger (re-verify: APPROVE-WITH-CHANGES; all rev-1 findings RESOLVED)

| # | Sev | Finding | Resolution (section) |
|---|---|---|---|
| NEW-1 | MEDIUM | "second `init` behaves like `restart`" contradicts `destroy()` teardown (closed-bitmap `drawImage` throw → dead loop; unreset `#disposed` poisons `setConfig`) | §2: `init` = full build from scratch (resets flags, clears+redecodes bitmaps), `restart` = live rebind only, `destroy` clears the cache |
| NEW-2 | LOW | First-attach brightness config: build-vs-detect ordering could double-/under-brighten transiently | §5: HW probe on the raw track BEFORE building the filter config; probe single-sourced |
| NEW-3 | LOW | §5 teardown invariant vs §9.1 look-only degrade governed the same failure | §2 failure taxonomy: landmarker-class = internal degrade, pipeline-class = reject `init` → teardown |
| NEW-4 | LOW | Exact pin doesn't prevent dual-version tasks-vision skew on future track-processors bump | §7: wasm↔version guard = hard prerequisite for any bump; manual re-vendor until then |

## 14. Implementation notes (deviations from spec, recorded at build time)

1. **Sticker assets ship as SVG, rasterized at CONFIG time, not author time (§3 change).** `public/filters/*.svg` are both source and shipped asset; `decodeStickerBitmap` rasterizes each layer ONCE per config via HTMLImageElement → canvas → `createImageBitmap` (Chromium's `createImageBitmap(blob)` rejects SVG blobs, hence the img/canvas hop). The §3 decode-once/no-per-frame-allocation rule is preserved; the PNG toolchain, `assets/filters-src/`, and the rasterize script are dropped (smaller repo, resolution-independent art). Gallery thumbnails reuse a representative layer via a `thumb` field on `FaceFilterDef`.
2. **Canonical id arrays live in the Voice store, not the catalogue (§6 refinement).** `clean()` needs the valid id lists but `@revolt/state` cannot import `@revolt/rtc` (cycle). `CameraFaceFilterIds`/`CameraColorLookIds` live in Voice.ts (mirroring `CameraBackgroundModes`); the rtc catalogue is typed `Record<CameraFaceFilterId, …>`, so tsc statically enforces the 1:1 correspondence, plus a runtime pin in faceFilterPolicy.test.ts (hardcoded copies — the store module graph pulls browser deps node's test runner can't load).
3. **i18n:** 5 new strings appended to en `messages.po` + precompiled `messages.ts` per the established recipe (lingui extract still broken); non-en locales get the strings at the next catalog resync, same as every recent feature.
4. **`pickSlotOccupant` takes an explicit caps struct** (`backgroundSupported`/`faceFiltersSupported`/`hwBrightness`) rather than probing inside — keeps it pure/testable and makes the §5 probe-before-build ordering explicit at the call site.
5. **§8 degrade observability is devtools/signal-only in v1** (diff-review finding 10, accepted): the ladder step is exposed via `cameraFaceFilterDegraded` + the processor's `degradeStep` getter for the runtime gate; no end-user "reduced quality" chrome yet.

## 15. Diff-review record (commit `4b5c7e89`)

frontend-code-reviewer verdict: **SHIP WITH FIXES** — 1 HIGH, 3 MEDIUM, 7 LOW; all §5/§2 seams, leak/race audit, per-frame path, store contract, reactivity, assets/CSP, i18n verified conformant. Fixes folded in the follow-up commit:
- **F1 HIGH** late post-destroy landmarker failure flipped UI to "failed" after teardown → `#reportStatus` no-ops on `#disposed`; controller forwards only from current/`#facePending` proc; `onStatus` nulled on every teardown path.
- **F2 MED** `#rawSource` missed the brightness-fallback occupant (probe read its canvas track after a device switch) → `BrightnessVideoProcessor.source` added, included in `#rawSource`.
- **F3 MED** settings-preview controller never wired `onFaceFilterStatus` → module-scope `previewFaceFilterStatus` signal; badge = in-call OR preview failed.
- **F4 MED** background failure with inert filters mis-set filter status "failed" → catch attributes by built occupant (`mode === "none"`).
- **F5/F6 LOW** `#gen` re-check between teardown-await and build; brightness-fallback assign-after-resolve + gen check.
- **F7/F8 LOW** landmarker init no longer discarded on config-only `#cfgGen` bumps (config-independent); landmarker closed when config drops to look-only.
- **F9 LOW** `destroy()` stops `processedTrack`. **F10 LOW** accepted as §14.5. **F11 LOW** `FILTER_ASSETS_BASE` exported, UI reuses it.

Remaining before release: **real-webcam runtime gate (§10)** — two-tab transmitted-track, mid-call device switch with sticker, background↔filter handoff, brightness HW/non-HW legs, LED-off, failed-init look-only degrade.
