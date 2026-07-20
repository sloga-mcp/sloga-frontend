import { For, Show } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import {
  COLOR_LOOKS,
  FACE_FILTERS,
  cameraBackgroundSupported,
  faceFiltersSupported,
  useVoice,
} from "@revolt/rtc";
import { useState } from "@revolt/state";
import {
  CameraBackgroundMode,
  CameraColorLookIds,
  CameraFaceFilterIds,
} from "@revolt/state/stores/Voice";
import { Column, Dialog, DialogProps, Slider, Text } from "@revolt/ui";

/**
 * Solid theme-token chip for the dense selector rows in this modal. The shared
 * Button "secondary" variant renders a gradient that is illegible in rows of
 * small pills (user report 2026-07-19) — these stay on flat md-sys colors.
 */
function chipStyle(selected: boolean) {
  return {
    padding: "6px 14px",
    "border-radius": "999px",
    border: "1px solid var(--md-sys-color-outline-variant)",
    cursor: "pointer",
    "font-size": "0.9em",
    "font-weight": "600",
    background: selected
      ? "var(--md-sys-color-primary)"
      : "var(--md-sys-color-surface-container-high)",
    color: selected
      ? "var(--md-sys-color-on-primary)"
      : "var(--md-sys-color-on-surface)",
  } as const;
}

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
            <div style={{ display: "flex", "flex-wrap": "wrap", gap: "8px" }}>
              <For each={modes}>
                {(m) => (
                  <button
                    style={chipStyle(voice.cameraBackgroundMode === m.value)}
                    onClick={() => voiceContext.setCameraBackground(m.value)}
                  >
                    {m.label}
                  </button>
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

        <Show when={faceFiltersSupported()}>
          <Column gap="sm">
            <Text class="label">
              <Trans>Filters</Trans>
            </Text>
            <Show when={voice.cameraBackgroundMode !== "none"}>
              <Text class="label">
                <Trans>
                  Filters are paused while background effects are on.
                </Trans>
              </Text>
            </Show>
            <div style={{ display: "flex", "flex-wrap": "wrap", gap: "8px" }}>
              <button
                style={chipStyle(!voice.cameraFaceFilterId)}
                onClick={() =>
                  voiceContext.setCameraFaceFilter({ filterId: null })
                }
              >
                {t`None`}
              </button>
              <For each={CameraFaceFilterIds}>
                {(id) => (
                  <button
                    style={chipStyle(voice.cameraFaceFilterId === id)}
                    onClick={() =>
                      voiceContext.setCameraFaceFilter({ filterId: id })
                    }
                  >
                    {FACE_FILTERS[id].name}
                  </button>
                )}
              </For>
            </div>

            <Text class="label">
              <Trans>Beautify: {voice.cameraBeautify}%</Trans>
            </Text>
            <Slider
              min={0}
              max={100}
              step={1}
              value={voice.cameraBeautify}
              onInput={(e) =>
                voiceContext.setCameraFaceFilter({
                  beautify: Number(e.currentTarget.value),
                })
              }
              labelFormatter={(v) => `${v}%`}
            />

            <Text class="label">
              <Trans>Color filter</Trans>
            </Text>
            <div style={{ display: "flex", "flex-wrap": "wrap", gap: "8px" }}>
              <button
                style={chipStyle(!voice.cameraColorLookId)}
                onClick={() =>
                  voiceContext.setCameraFaceFilter({ colorLookId: null })
                }
              >
                {t`None`}
              </button>
              <For each={CameraColorLookIds}>
                {(id) => (
                  <button
                    style={chipStyle(voice.cameraColorLookId === id)}
                    onClick={() =>
                      voiceContext.setCameraFaceFilter({ colorLookId: id })
                    }
                  >
                    {COLOR_LOOKS[id].name}
                  </button>
                )}
              </For>
            </div>

            <Show
              when={voiceContext.cameraFaceFilterStatus() === "failed"}
            >
              <Text class="label">
                <Trans>
                  Face tracking failed — stickers and beautify are unavailable.
                </Trans>
              </Text>
            </Show>
          </Column>
        </Show>
      </Column>
    </Dialog>
  );
}
