import { Show, createEffect, createSignal, on, onCleanup } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";

import { LocalVideoTrack } from "livekit-client";

import type { CameraBackgroundStatus } from "@revolt/rtc";
import { CameraEffectsController, useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { Button, CategoryButton, Column, Text } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/**
 * Face-filter status of the IDLE settings preview's own effects controller
 * (the in-call controller reports through voice.cameraFaceFilterStatus — this
 * covers the not-in-a-call "Test camera" path so a landmarker failure is
 * visible in settings too; diff-review finding 3). Module-scope signal so the
 * sibling CameraOptions section can render the shared failure badge.
 */
const [previewFaceFilterStatusSignal, setPreviewFaceFilterStatus] =
  createSignal<CameraBackgroundStatus>("idle");
export const previewFaceFilterStatus = previewFaceFilterStatusSignal;

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
  // The last effects apply on the idle preview reported a failure. Drives the
  // notice under the video; without it a dropped effect looks like a setting
  // that silently does nothing.
  const [effectFailed, setEffectFailed] = createSignal(false);
  const [previewTrack, setPreviewTrack] = createSignal<MediaStreamTrack>();

  let videoEl: HTMLVideoElement | undefined;
  let stream: MediaStream | undefined;
  let track: LocalVideoTrack | undefined;
  // Generation token — bumped on every teardown so an in-flight getUserMedia
  // that resolves after we've stopped/switched can detect it's stale.
  let gen = 0;
  // Counts applyEffects() calls. The controller runs applies in call order, so
  // only the newest call's result describes what the track ends up with.
  let applySeq = 0;
  const effects = new CameraEffectsController();
  effects.onImageMissing = () => {
    settings.cameraBackgroundMode = "none";
  };
  effects.onFaceFilterStatus = (s) => {
    setPreviewFaceFilterStatus(s.landmarksFailed ? "failed" : "active");
  };

  /** The live in-call camera track, if any (reactive via voice.video()). */
  const liveTrack = () =>
    voice.video() ? voice.localCameraTrack() : undefined;

  function stopIdlePreview() {
    gen++; // invalidate any pending acquire
    setPreviewFaceFilterStatus("idle");
    setEffectFailed(false);
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
    const t = track;
    if (!t) return;
    const seq = ++applySeq;
    // apply() never throws; the outcome is the result it resolves with.
    const result = await effects.apply(t, {
      backgroundMode: settings.cameraBackgroundMode,
      blurRadius: settings.cameraBlurRadius,
      backgroundImageId: settings.cameraBackgroundImageId,
      brightness: settings.cameraBrightness,
      faceFilterId: settings.cameraFaceFilterId,
      beautify: settings.cameraBeautify,
      colorLookId: settings.cameraColorLookId,
    });
    // Torn down while the apply ran (stop / device change / call took over /
    // unmount): stopIdlePreview() already detached and stopped this track.
    if (t !== track) return;
    // A newer apply is queued behind this one and its result replaces this
    // one. Detaching here would pull the processor out from under it.
    if (seq !== applySeq) return;

    // "gate" needs an opGuard, which the preview never passes.
    const failed = !result.ok && result.failed !== "gate";
    if (!result.ok && failed) {
      console.warn(
        "[camera] preview effect failed:",
        result.failed,
        result.error,
      );
      if (result.failed === "background") {
        // A failed background stays attached and outputs black frames until
        // it is detached. The controller leaves that to the caller because
        // an in-call camera must be muted first. This preview is local and
        // nothing is published, so the raw picture can come straight back.
        // A failed face filter or brightness fallback is already out of the
        // slot and needs no detach.
        try {
          await effects.detach(t);
        } catch (e) {
          console.warn("[camera] preview effect detach failed:", e);
        }
        if (t !== track || seq !== applySeq) return;
      }
    }
    // No retry: the next settings change re-applies and re-decides this.
    setEffectFailed(failed);
    // The processed output track may have changed (processor added/removed).
    setPreviewTrack(t.mediaStreamTrack);
  }

  // Acquire / release the idle preview capture. Keyed ONLY on testing + device
  // + whether the call took over — NOT on effect settings (those re-apply
  // without reacquiring, below).
  createEffect(
    on(
      [testing, () => settings.preferredVideoDevice, liveTrack],
      ([isTesting, deviceId, live]) => {
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
      },
    ),
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
    const current = (
      videoEl.srcObject as MediaStream | null
    )?.getVideoTracks()[0];
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
                variant={testing() ? "tonal" : "filled"}
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
                      Turn on your camera to check it works and preview
                      brightness and background effects.
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
              <Show when={effectFailed() && !liveTrack()}>
                <div role="status" style={{ "margin-top": "8px" }}>
                  <Text class="label">
                    <Trans>
                      A camera effect could not start and was turned off.
                    </Trans>
                  </Text>
                </div>
              </Show>
            </Show>
          }
        >
          <Trans>Camera Preview</Trans>
        </CategoryButton>
      </CategoryButton.Group>
    </Column>
  );
}
