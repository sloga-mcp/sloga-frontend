import { Show, createEffect, createSignal, on, onCleanup } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";

import { LocalVideoTrack } from "livekit-client";

import { CameraEffectsController, useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { Button, CategoryButton, Column, Text } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/**
 * Opt-in webcam self-view for the Voice settings page.
 *
 * - While a call is live with the camera on, binds directly to the transmitted
 *   `LocalVideoTrack` — true WYSIWYG, no second camera open.
 * - Otherwise, an explicit "Test camera" toggle opens a preview capture, wraps
 *   it in a `LocalVideoTrack`, and runs the SAME {@link CameraEffectsController}
 *   the call uses so preview effects match what would be sent.
 * - Stops the capture (camera LED off) on stop, device change, live-takeover,
 *   and unmount.
 */
export function CameraPreview() {
  const { voice: settings } = useState();
  const voice = useVoice();

  const [testing, setTesting] = createSignal(false);
  const [error, setError] = createSignal(false);
  const [previewTrack, setPreviewTrack] = createSignal<MediaStreamTrack>();

  let videoEl: HTMLVideoElement | undefined;
  let stream: MediaStream | undefined;
  let track: LocalVideoTrack | undefined;
  // Generation token — bumped on every teardown so an in-flight getUserMedia
  // that resolves after we've stopped/switched can detect it's stale.
  let gen = 0;
  const effects = new CameraEffectsController();
  effects.onImageMissing = () => {
    settings.cameraBackgroundMode = "none";
  };

  /** The live in-call camera track, if any (reactive via voice.video()). */
  const liveTrack = () => (voice.video() ? voice.localCameraTrack() : undefined);

  function stopIdlePreview() {
    gen++; // invalidate any pending acquire
    const t = track;
    track = undefined;
    if (t) {
      // Fire-and-forget processor teardown; stop the track immediately (LED off).
      effects.detach(t).catch(() => {});
      t.stop();
    }
    effects.reset();
    stream?.getTracks().forEach((x) => x.stop());
    stream = undefined;
    setPreviewTrack(undefined);
  }

  async function applyEffects() {
    if (!track) return;
    try {
      await effects.apply(track, {
        backgroundMode: settings.cameraBackgroundMode,
        blurRadius: settings.cameraBlurRadius,
        backgroundImageId: settings.cameraBackgroundImageId,
        brightness: settings.cameraBrightness,
        faceFilterId: settings.cameraFaceFilterId,
        beautify: settings.cameraBeautify,
        colorLookId: settings.cameraColorLookId,
      });
    } catch (e) {
      // Fail-safe: raw preview — but surface WHY (segmenter/asset init, CSP…).
      console.error("[camera] preview effects failed", e);
    }
    // The processed output track may have changed (processor added/removed).
    setPreviewTrack(track?.mediaStreamTrack);
  }

  // Acquire / release the idle preview capture. Keyed ONLY on testing + device
  // + whether the call took over — NOT on effect settings (those re-apply
  // without reacquiring, below).
  createEffect(
    on([testing, () => settings.preferredVideoDevice, liveTrack], ([isTesting, deviceId, live]) => {
      stopIdlePreview(); // bumps gen, invalidating any in-flight acquire
      if (!isTesting || live) return;
      const myGen = gen;
      void (async () => {
        let s: MediaStream;
        try {
          s = await navigator.mediaDevices.getUserMedia({
            video: deviceId ? { deviceId: { exact: deviceId } } : true,
          });
        } catch {
          if (myGen === gen) setError(true);
          return;
        }
        // Stale while gUM was pending (stopped / device change / call took over
        // / unmounted) → drop this capture immediately, no leaked camera LED.
        if (myGen !== gen) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        track = new LocalVideoTrack(s.getVideoTracks()[0]);
        setError(false);
        await applyEffects();
        // No stale re-check here: if we were superseded, stopIdlePreview() has
        // already torn this run down and started the newer one — re-running it
        // would clobber that newer acquire (blank preview).
      })();
    }),
  );

  // Re-apply effects when settings change, without reacquiring the camera.
  createEffect(
    on(
      [
        () => settings.cameraBrightness,
        () => settings.cameraBackgroundMode,
        () => settings.cameraBlurRadius,
        () => settings.cameraBackgroundImageId,
        () => settings.cameraFaceFilterId,
        () => settings.cameraBeautify,
        () => settings.cameraColorLookId,
      ],
      () => {
        if (track && testing() && !liveTrack()) void applyEffects();
      },
      { defer: true },
    ),
  );

  // Bind the <video> to whichever source is active (live track wins). Depends on
  // `cameraEffectsApplied()` so a background/brightness change on the LIVE track
  // (which swaps its processed output only AFTER the async apply settles) causes
  // a re-read of mediaStreamTrack — otherwise the in-call self-view shows raw
  // camera while the sent track has the effect (WYSIWYG divergence). The idle
  // path re-runs via previewTrack().
  createEffect(() => {
    const live = liveTrack();
    void voice.cameraEffectsApplied();
    const mst = live ? live.mediaStreamTrack : previewTrack();
    if (!videoEl) return;
    // Identity guard: only rebind when the track actually changed, else a slider
    // drag reassigns srcObject every tick and the <video> reloads (black-flash).
    const current = (videoEl.srcObject as MediaStream | null)?.getVideoTracks()[0];
    if (current === mst) return;
    videoEl.srcObject = mst ? new MediaStream([mst]) : null;
    if (mst) videoEl.play?.().catch(() => {});
  });

  onCleanup(stopIdlePreview);

  const showVideo = () => !!liveTrack() || (testing() && !error());

  return (
    <Column>
      <Text class="title">
        <Trans>Camera Preview</Trans>
      </Text>
      <CategoryButton.Group>
        <CategoryButton
          icon={<Symbol>{showVideo() ? "videocam" : "videocam_off"}</Symbol>}
          action={
            <Show
              when={!liveTrack()}
              fallback={
                <span style={{ "font-size": "0.85em", opacity: "0.7" }}>
                  <Trans>Live</Trans>
                </span>
              }
            >
              <Button
                variant={testing() ? "secondary" : "filled"}
                onPress={() => setTesting((v) => !v)}
              >
                <Show when={testing()} fallback={<Trans>Test camera</Trans>}>
                  <Trans>Stop</Trans>
                </Show>
              </Button>
            </Show>
          }
          description={
            <Show
              when={showVideo()}
              fallback={
                <Show
                  when={error()}
                  fallback={
                    <Trans>
                      Turn on your camera to check it works and preview brightness
                      and background effects.
                    </Trans>
                  }
                >
                  <Trans>
                    Camera unavailable — check permissions and that no other app
                    is using it.
                  </Trans>
                </Show>
              }
            >
              <video
                ref={videoEl}
                autoplay
                muted
                playsinline
                style={{
                  width: "100%",
                  "max-width": "480px",
                  "aspect-ratio": "16 / 9",
                  "border-radius": "8px",
                  background: "#000",
                  "object-fit": "cover",
                  transform: "scaleX(-1)",
                }}
              />
            </Show>
          }
        >
          <Trans>Camera Preview</Trans>
        </CategoryButton>
      </CategoryButton.Group>
    </Column>
  );
}
