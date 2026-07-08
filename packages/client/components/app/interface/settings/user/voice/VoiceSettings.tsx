import { Show } from "solid-js";

import { CONFIGURATION } from "@revolt/common";
import { Column } from "@revolt/ui";

import { CameraOptions } from "./CameraOptions";
import { MicrophoneLevelMeter } from "./MicrophoneLevelMeter";
import { MicrophoneTest } from "./MicrophoneTest";
import { VoiceInputOptions } from "./VoiceInputOptions";
import { VoiceProcessingOptions } from "./VoiceProcessingOptions";
/**
 * Configure voice options
 */
export function VoiceSettings() {
  return (
    <Column gap="lg">
      <VoiceInputOptions />
      <MicrophoneLevelMeter />
      <MicrophoneTest />
      <VoiceProcessingOptions />
      <Show when={CONFIGURATION.ENABLE_VIDEO}>
        <CameraOptions />
      </Show>
    </Column>
  );
}
