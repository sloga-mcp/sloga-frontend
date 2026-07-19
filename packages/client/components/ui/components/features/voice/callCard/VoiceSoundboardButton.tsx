import {
  For,
  Match,
  Show,
  Switch,
  createResource,
  createSignal,
  onCleanup,
} from "solid-js";

import { useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { CONFIGURATION } from "@revolt/common";
import { useVoice } from "@revolt/rtc";
import { CircularProgress } from "@revolt/ui";
import { IconButton } from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

interface Sound {
  _id: string;
  name: string;
  file_id: string;
  emoji?: string;
}

/**
 * Global preconfigured sound ("Sloga Sounds") — NOTE the server serializes
 * these with a plain `id`, unlike server sounds' `_id` (not a DB document).
 */
interface DefaultSound {
  id: string;
  name: string;
  emoji?: string;
}

// The default-sound list only changes when the server operator redeploys
// config, so fetch it once per app lifetime and share across popover opens.
// A failed fetch clears the cache so the next open retries.
let defaultSoundsPromise: Promise<DefaultSound[]> | undefined;

function fetchDefaultSounds(header: [string, string]): Promise<DefaultSound[]> {
  if (!defaultSoundsPromise) {
    defaultSoundsPromise = (async () => {
      const res = await fetch(
        `${CONFIGURATION.DEFAULT_API_URL}/custom/sounds/default`,
        { headers: { [header[0]]: header[1] } },
      );
      if (!res.ok) throw new Error(`default sounds fetch ${res.status}`);
      return (await res.json()) as DefaultSound[];
    })().catch((error) => {
      defaultSoundsPromise = undefined;
      throw error;
    });
  }
  return defaultSoundsPromise;
}

/**
 * In-call soundboard picker: a bar button that opens a popover of the server's
 * soundboard sounds. Clicking one hits the trigger REST route — the server
 * fans a `SoundboardSound` event to everyone in the call, who each play the
 * clip locally (no LiveKit track, no MLS). Gated on `UseSoundboard`; only
 * shown in a server voice channel.
 */
export function VoiceSoundboardButton(props: { size: "xs" | "sm" }) {
  const { t } = useLingui();
  const voice = useVoice();
  const client = useClient();

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

  // Fetch the server's sounds each time the popover opens (so a just-uploaded
  // sound appears without a reload); the global default list rides the
  // app-lifetime cache. Either list failing renders that section empty.
  const [sounds] = createResource(open, async (isOpen) => {
    if (!isOpen) return { server: [] as Sound[], defaults: [] as DefaultSound[] };
    const [key, value] = client().authenticationHeader;
    const header: [string, string] = [key, value];
    const serverId = voice?.channel()?.serverId;
    const serverSounds: Promise<Sound[]> = serverId
      ? fetch(
          `${CONFIGURATION.DEFAULT_API_URL}/custom/server/${serverId}/sounds`,
          { headers: { [key]: value } },
        ).then((res) => (res.ok ? (res.json() as Promise<Sound[]>) : []))
      : Promise.resolve([]);
    const [server, defaults] = await Promise.all([
      serverSounds.catch(() => [] as Sound[]),
      fetchDefaultSounds(header).catch(() => [] as DefaultSound[]),
    ]);
    return { server, defaults };
  });

  function trigger(soundId: string) {
    void voice?.channel()?.triggerSound(soundId);
  }

  return (
    <Container ref={container}>
      <Show when={open()}>
        <Overlay>
          <Switch fallback={<Empty>{t`No sounds in this server yet`}</Empty>}>
            <Match when={sounds.loading}>
              <CircularProgress />
            </Match>
            <Match
              when={
                sounds() &&
                (sounds()!.server.length || sounds()!.defaults.length)
              }
            >
              <Show when={sounds()!.server.length}>
                {/* Header is the server's name (data, not a msgid — the
                    catalog toolchain is frozen); hidden if uncached. */}
                <Show
                  when={
                    client().servers.get(voice?.channel()?.serverId ?? "")?.name
                  }
                >
                  {(name) => <SectionHeader>{name()}</SectionHeader>}
                </Show>
                <Grid>
                  <For each={sounds()!.server}>
                    {(sound) => (
                      <SoundButton
                        onClick={() => trigger(sound._id)}
                        title={sound.name}
                      >
                        <span>{sound.emoji || "🔊"}</span>
                        <Label>{sound.name}</Label>
                      </SoundButton>
                    )}
                  </For>
                </Grid>
              </Show>
              <Show when={sounds()!.defaults.length}>
                <SectionHeader>Sloga Sounds</SectionHeader>
                <Grid>
                  <For each={sounds()!.defaults}>
                    {(sound) => (
                      <SoundButton
                        onClick={() => trigger(sound.id)}
                        title={sound.name}
                      >
                        <span>{sound.emoji || "🔊"}</span>
                        <Label>{sound.name}</Label>
                      </SoundButton>
                    )}
                  </For>
                </Grid>
              </Show>
            </Match>
          </Switch>
        </Overlay>
      </Show>
      <IconButton
        size={props.size}
        variant={open() ? "filled" : "tonal"}
        onPress={toggle}
        use:floating={{
          tooltip: {
            placement: "top",
            content: t`Soundboard`,
          },
        }}
      >
        <Symbol>graphic_eq</Symbol>
      </IconButton>
    </Container>
  );
}

const Container = styled("div", {
  base: {
    display: "flex",
  },
});

const Overlay = styled("div", {
  base: {
    position: "absolute",
    // Fixed offset (not `100%`) because the containing block is the call Card,
    // not this wrapper — sit just above the controls bar and grow upward, so
    // the rounded controls bar doesn't clip the popover (matches
    // VoiceDeviceSelector).
    bottom: "64px",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 10,

    minWidth: "240px",
    maxWidth: "320px",
    maxHeight: "min(420px, 60vh)",
    overflowY: "auto",
    padding: "var(--gap-md)",

    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-surface-container-high)",
    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.35)",
  },
});

const Grid = styled("div", {
  base: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))",
    gap: "var(--gap-sm)",
  },
});

const SectionHeader = styled("div", {
  base: {
    fontSize: "0.65em",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "var(--md-sys-color-on-surface-variant)",
    padding: "var(--gap-sm) var(--gap-sm) var(--gap-xs)",
    textAlign: "start",
  },
});

const SoundButton = styled("button", {
  base: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "2px",
    padding: "var(--gap-sm)",

    cursor: "pointer",
    borderRadius: "var(--borderRadius-md)",
    background: "var(--md-sys-color-surface-container)",
    color: "var(--md-sys-color-on-surface)",
    fontSize: "1.4em",
    border: "none",

    transition: "background 0.1s",
    _hover: {
      background: "var(--md-sys-color-surface-container-highest)",
    },
  },
});

const Label = styled("span", {
  base: {
    fontSize: "0.6em",
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Empty = styled("div", {
  base: {
    padding: "var(--gap-md)",
    fontSize: "0.85em",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});
