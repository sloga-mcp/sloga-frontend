import { For, Show } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import { cameraBackgroundSupported, useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { CameraBackgroundMode } from "@revolt/state/stores/Voice";
import { Button, Column, Dialog, DialogProps, Slider, Text } from "@revolt/ui";

import { Modals } from "../types";

/**
 * In-call quick camera controls: brightness + background effect. Reads/writes
 * the same Voice store + methods as the settings page (single source of truth);
 * changes apply live to the transmitted track.
 */
export function CameraSettingsModal(
  props: DialogProps & Modals & { type: "camera_settings" },
) {
  const { voice } = useState();
  const voiceContext = useVoice();
  const { t } = useLingui();

  const modes: { value: CameraBackgroundMode; label: string }[] = [
    { value: "none", label: t`None` },
    { value: "blur", label: t`Blur` },
    { value: "image", label: t`Image` },
  ];

  return (
    <Dialog
      minWidth={380}
      show={props.show}
      onClose={() => props.onClose()}
      title={t`Camera`}
      actions={[{ text: <Trans>Done</Trans> }]}
    >
      <Column gap="lg">
        <Column gap="sm">
          <Text class="label">
            <Trans>Brightness: {voice.cameraBrightness}%</Trans>
          </Text>
          <Slider
            min={0}
            max={200}
            step={1}
            value={voice.cameraBrightness}
            onInput={(e) =>
              voiceContext.setCameraBrightness(Number(e.currentTarget.value))
            }
            labelFormatter={(v) => `${v}%`}
          />
        </Column>

        <Show
          when={cameraBackgroundSupported()}
          fallback={
            <Text class="label">
              <Trans>Background effects aren't supported on this device.</Trans>
            </Text>
          }
        >
          <Column gap="sm">
            <Text class="label">
              <Trans>Background</Trans>
            </Text>
            <div style={{ display: "flex", gap: "8px" }}>
              <For each={modes}>
                {(m) => (
                  <Button
                    variant={
                      voice.cameraBackgroundMode === m.value
                        ? "filled"
                        : "secondary"
                    }
                    onPress={() => voiceContext.setCameraBackground(m.value)}
                  >
                    {m.label}
                  </Button>
                )}
              </For>
            </div>

            <Show when={voice.cameraBackgroundMode === "blur"}>
              <Text class="label">
                <Trans>Blur strength: {voice.cameraBlurRadius}</Trans>
              </Text>
              <Slider
                min={1}
                max={20}
                step={1}
                value={voice.cameraBlurRadius}
                onInput={(e) =>
                  voiceContext.setCameraBackground("blur", {
                    blurRadius: Number(e.currentTarget.value),
                  })
                }
              />
            </Show>

            <Show when={voice.cameraBackgroundMode === "image"}>
              <Text class="label">
                <Trans>Choose a background image in Settings → Voice.</Trans>
              </Text>
            </Show>
          </Column>
        </Show>
      </Column>
    </Dialog>
  );
}
