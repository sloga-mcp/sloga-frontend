import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { createFormControl, createFormGroup } from "solid-forms";

import {
  screenAudioPickerAudioSuppressed,
  screenAudioSupported,
  useVoice,
} from "@revolt/rtc";
import { useState } from "@revolt/state";
import { ScreenShareQualityName } from "@revolt/state/stores/Voice";
import { Column, Dialog, DialogProps, Form2 } from "@revolt/ui";
import { VideoTrack } from "solid-livekit-components";

import { createResource, Match, Show, Switch } from "solid-js";
import { ScreenShareQualityLabel } from "./ScreenShareQualityLabel";
import { Modals } from "../types";

// Why the capture came back without audio differs by OS, and the old
// one-liner ("Audio disabled by browser") read as breakage everywhere.
// Android's WebView reports platform "Linux armv8l", so exclude it rather
// than tell phone users about desktop Linux.
const isLinux =
  navigator.platform.includes("Linux") && !/Android/i.test(navigator.userAgent);
const isMac = navigator.platform.startsWith("Mac");

export function ScreenShareSettingsModal(
  props: DialogProps & Modals & { type: "screen_share_settings" },
) {
  const { voice } = useState();
  const voiceContext = useVoice();
  const { t } = useLingui();

  // 🔴 CAPABILITY, not platform — and TWO questions, kept apart exactly as the
  // share path keeps them apart, because they have different answers and the
  // old copy is wrong on the difference.
  //
  // (1) Is there still a checkbox to tick? `getDisplayMedia` is called with
  //     `audio: false` on this shell, which REMOVES the browser's "Share system
  //     audio" checkbox rather than unticking it. That is decided by
  //     `screenAudioPickerAudioSuppressed()` alone — build flag, platform,
  //     Tauri bridge — and it is SYNCHRONOUS, so a slow shell cannot answer
  //     "no" and hand the checkbox back.
  // (2) Can the native capture actually run? That needs the shell's probe.
  //
  // 🔴 The gap between them is real and is the whole reason the fallback copy
  // is keyed on (1): a shell where the probe has not settled, or has failed,
  // answers NO to (2) while the checkbox is still gone. Keying the "restart and
  // tick it" instruction on (2) would print it to a user who has nothing to
  // tick — the very bug this matrix exists to remove.
  //
  // (2) is async only because the probe is. It settled long before this dialog,
  // which opens only once a share is already publishing, so this resolves on
  // the first microtask; the help block waits on it rather than rendering one
  // answer and swapping, because a help text that changes its mind in front of
  // the user is worse than one that appears a frame late.
  const pickerAudioGone = screenAudioPickerAudioSuppressed();
  const [nativeAudio] = createResource(() => screenAudioSupported());

  // 🔴 Whether this share can carry audio at all is a PREFERENCE question on a
  // capable shell, not just a live-track question. `props.audio` is false
  // whenever there is no audio publication — including when the user turned
  // "Share audio" off — and hiding the checkbox in that state made the setting
  // a ONE-WAY DOOR: this component is the only writer of `screenShareAudio` in
  // the client, the browser checkbox that used to offer it is gone on this
  // shell, and Settings has no toggle for it. So the checkbox stays visible and
  // usable whenever the shell is one where it is the only lever.
  const audioIsPreference = () => props.audio || pickerAudioGone;

  // The state the checkbox exists to escape: capable shell, no audio
  // publication. There is no live track to untick here, so the control has no
  // per-share meaning left and its only coherent meaning is the stored
  // preference — which is why it writes through on submit without requiring
  // "Don't ask me again".
  const recoveringPreference = () => pickerAudioGone && !props.audio;

  const group = createFormGroup({
    qualityName: createFormControl<ScreenShareQualityName>(
      voice.screenShareQuality || "low",
      { required: true },
    ),
    audio: createFormControl(audioIsPreference() && voice.screenShareAudio, {
      disabled: !audioIsPreference(),
    }),
    shield: createFormControl(voice.screenShareShield),
    dontAsk: createFormControl(false),
  });

  async function onSubmit() {
    if (group.controls.dontAsk.value) {
      voice.screenShareQuality = group.controls.qualityName.value;
      voice.screenShareQualityAsk = false;
      // 🔴 Only when the control was actually usable. Otherwise "don't ask me
      // again" writes a DISABLED, forced-false checkbox over the setting and
      // cements screen-share audio off — on a shell where nothing else can
      // turn it back on.
      if (audioIsPreference()) {
        voice.screenShareAudio = group.controls.audio.value;
      }
    }

    // The recovery case writes through WITHOUT "don't ask me again": there is
    // no audio publication for the checkbox to govern this time round, so the
    // preference is the only thing it can mean, and requiring a second,
    // unrelated checkbox to make it stick is what made the setting a one-way
    // door in the first place.
    if (recoveringPreference()) {
      voice.screenShareAudio = group.controls.audio.value;
    }

    // The shield persists unconditionally (unlike quality, it is a privacy
    // preference, not a per-share tweak) and syncs the LIVE track — this
    // modal opens after the track has already published.
    voice.screenShareShield = group.controls.shield.value;
    void voiceContext.applyScreenShareShield();

    props.callback(
      group.controls.qualityName.value,
      group.controls.audio.value && props.audio,
    );
    props.onClose();
  }

  const submit = Form2.useSubmitHandler(group, onSubmit);

  return (
    // 820 is deliberately past Dialog's own 560px maxWidth -- an inline
    // min-width beats max-width in CSS, which is the only way to widen this.
    // It has to be wide: Form2.ButtonGroup renders its Row with
    // justify="stretch", i.e. `& * { flex: 1 }`, so every tier button is
    // forced to an identical flex-basis:0 width no matter what it says.
    // Content width is ignored, so total dialog width is the ONLY lever;
    // below ~117px/button the button is narrower than "Source" and splits
    // the word. 700 covered six tiers; the Game tier makes seven.
    <Dialog
      minWidth={820}
      show={props.show}
      onClose={() => {
        props.onCancel();
        props.onClose();
      }}
      title={t`Screen Share Settings`}
      actions={[
        { text: <Trans>Cancel</Trans> },
        {
          text: <Trans>Go</Trans>,
          onClick: () => {
            onSubmit();
            return false;
          },
        },
      ]}
    >
      <VideoTrack
        trackRef={props.trackReference}
        style={{
          padding: "var(--gap-md)",
          "border-radius": "var(--borderRadius-lg)",
          "max-height": "440px",
          "justify-self": "center",
        }}
      />
      <form onSubmit={submit}>
        <Column>
          <Form2.ButtonGroup
            control={group.controls.qualityName}
            buttonDefinitions={props.qualities.map((quality) => {
              return {
                children: (
                  <ScreenShareQualityLabel fullName={quality.fullName} />
                ),
                value: quality.name,
              };
            })}
          />
          <Show when={audioIsPreference()}>
            <Form2.Checkbox control={group.controls.audio}>
              <Trans>Share audio</Trans>
            </Form2.Checkbox>
          </Show>
          <Form2.Checkbox control={group.controls.shield}>
            <Trans>
              Privacy shield — hide pop-up notifications (pixelates the corner
              of full-screen shares when something appears there)
            </Trans>
          </Form2.Checkbox>
          <Form2.Checkbox control={group.controls.dontAsk}>
            <Trans>Don't ask me again</Trans>
          </Form2.Checkbox>
          {/* The capability resource is only consulted on shells that could
              be capable, so a Linux or macOS user's help text is never a
              hostage of a Windows probe. */}
          <Show
            when={!props.audio && (!pickerAudioGone || !nativeAudio.loading)}
          >
            <small>
              <Switch
                fallback={
                  <Trans>
                    This share has no audio. To include sound, restart the share
                    and pick a tab or your entire screen with "Share system
                    audio" enabled.
                  </Trans>
                }
              >
                <Match when={isLinux}>
                  <Trans>
                    System audio capture isn't supported on Linux yet.
                  </Trans>
                </Match>
                <Match when={isMac}>
                  <Trans>
                    On macOS the browser can only capture audio when sharing a
                    tab — restart the share and pick a tab to include its sound.
                  </Trans>
                </Match>
                {/* The shells with no checkbox. Order matters: each branch
                    rules out the reason above it. The first two are the ones
                    the user can act on; the last is the catch-all, and it is
                    keyed on the checkbox being GONE rather than on the capture
                    being available, so a shell whose probe never settled lands
                    here instead of on the fallback's tick-the-box advice. */}
                <Match when={nativeAudio() && !props.entireScreen}>
                  <Trans>
                    Only entire-screen shares carry your computer's audio.
                    Restart the share and pick a whole screen instead of a
                    window.
                  </Trans>
                </Match>
                <Match when={nativeAudio() && !voice.screenShareAudio}>
                  <Trans>
                    This share is silent because "Share audio" is turned off.
                    Tick it above and restart the share to include your
                    computer's sound.
                  </Trans>
                </Match>
                {/* 🔴 No "your screen is still being shared" reassurance
                    here. This branch is also what renders after an E2EE
                    teardown stopped the audio, and in that case the cause is
                    a missing transform — which livekit installs per sender
                    from the same worker, so the screen VIDEO is in the same
                    state. Telling the user the screen is still going out
                    would be presenting the bad half as good news. The
                    encryption failure raises its own blocking modal, which is
                    where that story belongs; this line stays narrow. */}
                <Match when={pickerAudioGone}>
                  <Trans>
                    Sloga couldn't capture your computer's audio for this share.
                  </Trans>
                </Match>
              </Switch>
            </small>
          </Show>
        </Column>
      </form>
    </Dialog>
  );
}
