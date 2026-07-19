import { For, Show, createResource, createSignal, onCleanup } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import {
  COLOR_LOOKS,
  FACE_FILTERS,
  addUpload,
  cameraBackgroundSupported,
  faceFiltersSupported,
  listBackgrounds,
  removeUpload,
  resolveBackgroundUrl,
  useVoice,
} from "@revolt/rtc";
import { useState } from "@revolt/state";
import {
  CameraBackgroundMode,
  CameraColorLookIds,
  CameraFaceFilterIds,
  CameraQualityName,
  CameraQualityNames,
  ScreenShareQualityName,
} from "@revolt/state/stores/Voice";
import {
  Button,
  CategoryButton,
  CategorySelectOption,
  Checkbox,
  Column,
  Slider,
  Text,
} from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { CameraPreview } from "./CameraPreview";

/**
 * Camera + screen-share settings. Camera section adds a live preview, brightness,
 * background effects (blur / virtual background), and capture quality.
 */
export function CameraOptions() {
  const { voice } = useState();
  const voiceContext = useVoice();
  const { t } = useLingui();

  const screenQualities = voiceContext.getEnabledScreenShareQualities();
  const cameraQualities = voiceContext.getEnabledCameraQualities();

  const bgSupported = cameraBackgroundSupported();

  return (
    <Column>
      <Text class="title">
        <Trans>Camera Settings</Trans>
      </Text>

      <CameraPreview />

      <CategoryButton.Group>
        <CategoryButton
          icon={<Symbol>brightness_6</Symbol>}
          description={
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
              <Show
                when={
                  voice.cameraBackgroundMode !== "none" &&
                  !voiceContext.cameraHwBrightness() &&
                  voiceContext.video()
                }
              >
                <Text class="label">
                  <Trans>
                    Brightness is unavailable on this camera while a background
                    effect is active.
                  </Trans>
                </Text>
              </Show>
            </Column>
          }
        >
          <Trans>Camera Brightness</Trans>
        </CategoryButton>
      </CategoryButton.Group>

      <Show
        when={bgSupported}
        fallback={
          <Text class="label">
            <Trans>Background effects aren't supported on this device.</Trans>
          </Text>
        }
      >
        <CameraBackgroundOptions />
      </Show>

      <Show when={faceFiltersSupported()}>
        <CameraFilterOptions />
      </Show>

      <CategoryButton.Group>
        <CategoryButton.Select
          icon={<Symbol>hd</Symbol>}
          title={<Trans>Camera quality</Trans>}
          options={
            Object.fromEntries(
              CameraQualityNames.map((name) => [
                name,
                {
                  title:
                    name === "auto"
                      ? t`Auto`
                      : cameraQualities[name].fullName,
                },
              ]),
            ) as { [key in CameraQualityName]: CategorySelectOption }
          }
          value={voice.cameraQuality}
          onUpdate={(ns) => (voice.cameraQuality = ns as CameraQualityName)}
        />
        <CategoryButton
          icon={<Symbol>speed</Symbol>}
          description={
            <Column gap="sm">
              <Text class="label">
                <Show
                  when={voice.cameraMaxBitrateKbps > 0}
                  fallback={<Trans>Max bitrate: Auto</Trans>}
                >
                  <Trans>
                    Max bitrate: {(voice.cameraMaxBitrateKbps / 1000).toFixed(1)}{" "}
                    Mbps
                  </Trans>
                </Show>
              </Text>
              <Slider
                min={0}
                max={20}
                step={0.5}
                value={voice.cameraMaxBitrateKbps / 1000}
                onInput={(e) =>
                  (voice.cameraMaxBitrateKbps = Math.round(
                    Number(e.currentTarget.value) * 1000,
                  ))
                }
                labelFormatter={(v) => (v === 0 ? t`Auto` : t`${v} Mbps`)}
              />
            </Column>
          }
        >
          <Trans>Camera Quality</Trans>
        </CategoryButton>
      </CategoryButton.Group>
      <Text class="label">
        <Trans>Quality and bitrate changes apply the next time you turn on your camera.</Trans>
      </Text>

      <Text class="title">
        <Trans>Screen Share Settings</Trans>
      </Text>
      <CategoryButton.Group>
        <CategoryButton.Select
          icon={<Symbol>screen_share</Symbol>}
          title={<Trans>Select screen share quality</Trans>}
          options={
            Object.fromEntries(
              Object.keys(screenQualities).map((name) => [
                name,
                {
                  title:
                    screenQualities[name as ScreenShareQualityName]!.fullName,
                },
              ]),
            ) as { [key in ScreenShareQualityName]: CategorySelectOption }
          }
          value={voice.screenShareQuality}
          onUpdate={(ns) => (voice.screenShareQuality = ns)}
        />
        <CategoryButton
          icon="blank"
          action={<Checkbox checked={voice.screenShareQualityAsk} />}
          onClick={() =>
            (voice.screenShareQualityAsk = !voice.screenShareQualityAsk)
          }
        >
          <Trans>Always Ask for Screen Share Quality</Trans>
        </CategoryButton>
      </CategoryButton.Group>
    </Column>
  );
}

/**
 * Face filters: AR sticker gallery + beautify slider + color looks. Settings
 * write through even while a background effect holds the processor slot —
 * they sit INERT with the "paused" badge until the background is turned off
 * (camera-face-filters plan §5).
 */
function CameraFilterOptions() {
  const { voice } = useState();
  const voiceContext = useVoice();
  const { t } = useLingui();

  const filterAssetBase = `${import.meta.env.BASE_URL}filters`.replace(
    /\/$/,
    "",
  );
  const pausedByBackground = () => voice.cameraBackgroundMode !== "none";

  const thumbStyle = (selected: boolean) => ({
    width: "72px",
    height: "72px",
    display: "flex",
    "flex-direction": "column" as const,
    "align-items": "center",
    "justify-content": "center",
    gap: "4px",
    "border-radius": "8px",
    cursor: "pointer",
    border: "none",
    padding: "4px",
    background: "var(--md-sys-color-surface-container-high)",
    outline: selected ? "2px solid var(--md-sys-color-primary)" : "none",
    "font-size": "0.7em",
    color: "var(--md-sys-color-on-surface)",
  });

  return (
    <CategoryButton.Group>
      <CategoryButton
        icon={<Symbol>face_retouching_natural</Symbol>}
        description={
          <Column gap="sm">
            <Show when={pausedByBackground()}>
              <Text class="label">
                <Trans>
                  Filters are paused while background effects are on.
                </Trans>
              </Text>
            </Show>

            <div style={{ display: "flex", "flex-wrap": "wrap", gap: "8px" }}>
              <button
                style={thumbStyle(!voice.cameraFaceFilterId)}
                onClick={() =>
                  voiceContext.setCameraFaceFilter({ filterId: null })
                }
              >
                <Symbol>block</Symbol>
                {t`None`}
              </button>
              <For each={CameraFaceFilterIds}>
                {(id) => (
                  <button
                    style={thumbStyle(voice.cameraFaceFilterId === id)}
                    onClick={() =>
                      voiceContext.setCameraFaceFilter({ filterId: id })
                    }
                  >
                    <img
                      src={`${filterAssetBase}/${FACE_FILTERS[id].thumb}`}
                      alt={FACE_FILTERS[id].name}
                      style={{
                        width: "40px",
                        height: "40px",
                        "object-fit": "contain",
                      }}
                    />
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
              <Button
                variant={!voice.cameraColorLookId ? "filled" : "secondary"}
                onPress={() =>
                  voiceContext.setCameraFaceFilter({ colorLookId: null })
                }
              >
                {t`None`}
              </Button>
              <For each={CameraColorLookIds}>
                {(id) => (
                  <Button
                    variant={
                      voice.cameraColorLookId === id ? "filled" : "secondary"
                    }
                    onPress={() =>
                      voiceContext.setCameraFaceFilter({ colorLookId: id })
                    }
                  >
                    {COLOR_LOOKS[id].name}
                  </Button>
                )}
              </For>
            </div>

            <Show when={voiceContext.cameraFaceFilterStatus() === "failed"}>
              <Text class="label">
                <Trans>
                  Face tracking failed — stickers and beautify are unavailable.
                </Trans>
              </Text>
            </Show>
          </Column>
        }
      >
        <Trans>Filters</Trans>
      </CategoryButton>
    </CategoryButton.Group>
  );
}

/**
 * Background mode selector + blur strength + virtual-background gallery.
 */
function CameraBackgroundOptions() {
  const { voice } = useState();
  const voiceContext = useVoice();
  const { t } = useLingui();

  // Gallery items resolved to (revocable) thumbnail URLs. Each fetch builds its
  // own local revoke list, then swaps it in — so an in-flight fetch that settles
  // after unmount or after a newer fetch never leaks its URLs.
  let revokes: (() => void)[] = [];
  let disposed = false;
  let fetchSeq = 0;
  const [refetchKey, setRefetchKey] = createSignal(0);

  // Only fetch/render the gallery thumbnails while Image mode is active — a
  // falsy source skips the fetcher, so scrolling through settings (or using
  // None/Blur) does zero canvas/localforage work. `+ 1` keeps the source truthy
  // even at refetchKey 0, while still re-fetching when the key changes.
  const [items] = createResource(
    () => (voice.cameraBackgroundMode === "image" ? refetchKey() + 1 : false),
    async () => {
      const myFetch = ++fetchSeq;
      const localRevokes: (() => void)[] = [];
      const list = await listBackgrounds();
      const resolved = await Promise.all(
        list.map(async (item) => {
          const r = await resolveBackgroundUrl(item.id);
          if (r) localRevokes.push(r.revoke);
          return { ...item, url: r?.url };
        }),
      );
      if (disposed || myFetch !== fetchSeq) {
        // Superseded by a newer refetch (or unmounted): free only our own URLs;
        // never revoke the committed set (would blank the displayed thumbnails).
        localRevokes.forEach((r) => r());
        return [];
      }
      revokes.forEach((r) => r()); // release the previous run's URLs
      revokes = localRevokes;
      return resolved.filter((i) => i.url);
    },
  );

  onCleanup(() => {
    disposed = true;
    revokes.forEach((r) => r());
  });

  let fileInput: HTMLInputElement | undefined;

  async function onUpload(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    const item = await addUpload(file, file.name);
    setRefetchKey((k) => k + 1);
    voiceContext.setCameraBackground("image", { imageId: item.id });
    if (fileInput) fileInput.value = "";
  }

  async function onDelete(id: string) {
    await removeUpload(id);
    if (voice.cameraBackgroundImageId === id) {
      voice.cameraBackgroundImageId = undefined;
      voiceContext.setCameraBackground("none");
    }
    setRefetchKey((k) => k + 1);
  }

  const modeOptions = {
    none: { title: t`None` },
    blur: { title: t`Blur` },
    image: { title: t`Image` },
  } as { [key in CameraBackgroundMode]: CategorySelectOption };

  return (
    <CategoryButton.Group>
      <CategoryButton.Select
        icon={<Symbol>blur_on</Symbol>}
        title={<Trans>Background effect</Trans>}
        options={modeOptions}
        value={voice.cameraBackgroundMode}
        onUpdate={(ns) =>
          voiceContext.setCameraBackground(ns as CameraBackgroundMode)
        }
      />

      <Show when={voice.cameraBackgroundMode === "blur"}>
        <CategoryButton
          icon={<Symbol>blur_on</Symbol>}
          description={
            <Column gap="sm">
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
            </Column>
          }
        >
          <Trans>Blur strength</Trans>
        </CategoryButton>
      </Show>

      <Show when={voice.cameraBackgroundMode === "image"}>
        <CategoryButton
          icon={<Symbol>wallpaper</Symbol>}
          description={
            <Column gap="sm">
              <div
                style={{
                  display: "flex",
                  "flex-wrap": "wrap",
                  gap: "8px",
                }}
              >
                <For each={items() ?? []}>
                  {(item) => (
                    <div style={{ position: "relative" }}>
                      <img
                        src={item.url}
                        alt={item.name}
                        onClick={() =>
                          voiceContext.setCameraBackground("image", {
                            imageId: item.id,
                          })
                        }
                        style={{
                          width: "96px",
                          height: "54px",
                          "object-fit": "cover",
                          "border-radius": "6px",
                          cursor: "pointer",
                          outline:
                            voice.cameraBackgroundImageId === item.id
                              ? "2px solid var(--md-sys-color-primary)"
                              : "none",
                        }}
                      />
                      <Show when={item.kind === "upload"}>
                        <button
                          title={t`Remove`}
                          onClick={() => onDelete(item.id)}
                          style={{
                            position: "absolute",
                            top: "2px",
                            right: "2px",
                            border: "none",
                            "border-radius": "50%",
                            width: "20px",
                            height: "20px",
                            cursor: "pointer",
                            background: "rgba(0,0,0,0.6)",
                            color: "#fff",
                            "line-height": "1",
                          }}
                        >
                          ×
                        </button>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                onChange={onUpload}
                style={{ "font-size": "0.85em" }}
              />
            </Column>
          }
        >
          <Trans>Virtual background</Trans>
        </CategoryButton>
      </Show>
    </CategoryButton.Group>
  );
}
