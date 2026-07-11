import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import { useMediaDeviceSelect } from "solid-livekit-components";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { CONFIGURATION } from "@revolt/common";
import { useState } from "@revolt/state";
import { IconButton } from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/**
 * In-call quick device switcher: a bar button that opens a popover letting the
 * user swap the active microphone, speaker and camera without leaving the call.
 * Switching applies live to the room and persists the preference (same logic as
 * the Voice & Video settings page).
 */
export function VoiceDeviceSelector(props: { size: "xs" | "sm" }) {
  const { t } = useLingui();
  const [open, setOpen] = createSignal(false);

  let container: HTMLDivElement | undefined;

  function onPointerDown(event: PointerEvent) {
    if (container && !container.contains(event.target as Node)) {
      setOpen(false);
    }
  }

  function toggle() {
    if (open()) {
      setOpen(false);
    } else {
      setOpen(true);
      document.addEventListener("pointerdown", onPointerDown);
    }
  }

  onCleanup(() => document.removeEventListener("pointerdown", onPointerDown));

  return (
    <Container ref={container}>
      <Show when={open()}>
        <Overlay>
          <DeviceSection kind="audioinput" />
          <DeviceSection kind="audiooutput" />
          <Show when={CONFIGURATION.ENABLE_VIDEO}>
            <DeviceSection kind="videoinput" />
          </Show>
        </Overlay>
      </Show>
      <IconButton
        size={props.size}
        variant={open() ? "filled" : "tonal"}
        onPress={toggle}
        use:floating={{
          tooltip: {
            placement: "top",
            content: t`Switch devices`,
          },
        }}
      >
        <Symbol>settings_input_component</Symbol>
      </IconButton>
    </Container>
  );
}

/**
 * A single device kind's picker (mic / speaker / camera). Mirrors the selection
 * logic of the Voice & Video settings page so the choice is applied to the live
 * room and remembered for future calls.
 */
function DeviceSection(props: { kind: MediaDeviceKind }) {
  const state = useState();
  const media = createMemo(() => useMediaDeviceSelect({ kind: props.kind }));

  const setKey = () =>
    props.kind === "videoinput"
      ? "preferredVideoDevice"
      : props.kind === "audioinput"
        ? "preferredAudioInputDevice"
        : "preferredAudioOutputDevice";

  const icon = () =>
    props.kind === "videoinput"
      ? "camera_video"
      : props.kind === "audioinput"
        ? "mic"
        : "speaker";

  const activeId = createMemo(() => state.voice[setKey()] ?? "default");

  const options = createMemo(() => {
    const devs = media().devices();
    const opts: { id: string; title: string }[] = [];

    // Ensure default is at the top
    const d = devs.find((dev) => dev.deviceId === "default");
    opts.push({ id: "default", title: d?.label ?? "Default" });

    for (const dev of devs)
      if (dev.deviceId !== "default")
        opts.push({ id: dev.deviceId, title: dev.label });

    return opts;
  });

  function select(id: string) {
    const mMedia = media();
    if (id === "default" || mMedia.devices().find((d) => d.deviceId === id)) {
      // Can't setActiveMediaDevice to "default" for video, only audio — but it
      // is applied on livekit init, so the choice is still remembered.
      if (props.kind !== "videoinput" || id !== "default")
        mMedia.setActiveMediaDevice(id);
      state.voice[setKey()] = id === "default" ? undefined : id;
    }
  }

  return (
    <Section>
      <SectionHeader>
        <Symbol>{icon()}</Symbol>
        <span>
          <Show
            when={props.kind === "videoinput"}
            fallback={
              <Show
                when={props.kind === "audioinput"}
                fallback={<Trans>Audio output</Trans>}
              >
                <Trans>Microphone</Trans>
              </Show>
            }
          >
            <Trans>Camera</Trans>
          </Show>
        </span>
      </SectionHeader>
      <For each={options()}>
        {(opt) => (
          <DeviceRow
            aria-selected={activeId() === opt.id}
            onClick={() => select(opt.id)}
          >
            <DeviceLabel>{opt.title}</DeviceLabel>
            <Symbol>
              {activeId() === opt.id
                ? "radio_button_checked"
                : "radio_button_unchecked"}
            </Symbol>
          </DeviceRow>
        )}
      </For>
    </Section>
  );
}

// NOTE: intentionally NOT position:relative. The call bar lives inside a
// `VoiceCallControls` box with `overflow: hidden`; if the popover were anchored
// to a positioned wrapper *inside* that box it would be clipped. Leaving this
// static lets the absolute Overlay resolve its containing block to the call
// Card (an ancestor above the clipping box) — the same trick VoiceStatsOverlay
// uses. The wrapper still groups button + overlay for click-outside detection.
const Container = styled("div", {
  base: {
    display: "flex",
  },
});

const Overlay = styled("div", {
  base: {
    position: "absolute",
    // Fixed offset (not `100%`) because the containing block is the call Card,
    // not this wrapper — sit just above the controls bar and grow upward.
    bottom: "64px",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 10,

    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-md)",

    padding: "var(--gap-md)",
    maxHeight: "min(420px, 60vh)",
    minWidth: "260px",
    overflowY: "auto",

    borderRadius: "var(--borderRadius-md)",
    background: "var(--md-sys-color-surface-container-highest)",
    color: "var(--md-sys-color-on-surface)",
    boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
  },
});

const Section = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
  },
});

const SectionHeader = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",

    padding: "var(--gap-sm) var(--gap-sm) 2px",
    fontSize: "0.7rem",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    opacity: 0.6,
  },
});

const DeviceRow = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--gap-md)",

    padding: "var(--gap-sm) var(--gap-md)",
    borderRadius: "var(--borderRadius-md)",
    cursor: "pointer",
    userSelect: "none",

    transition: "background 0.1s",

    "&:hover": {
      background: "var(--md-sys-color-surface-container-high)",
    },

    "&[aria-selected='true']": {
      background: "var(--md-sys-color-secondary-container)",
      color: "var(--md-sys-color-on-secondary-container)",
    },
  },
});

const DeviceLabel = styled("span", {
  base: {
    fontSize: "0.85rem",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});
