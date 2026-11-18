import {
  For,
  Show,
  createResource,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import {
  COLOR_LOOKS,
  FACE_FILTERS,
  FILTER_ASSETS_BASE,
  addUpload,
  cameraBackgroundSupported,
  cameraGlamSupported,
  cameraToneSupported,
  faceFiltersSupported,
  listBackgrounds,
  probeCameraGlam,
  removeUpload,
  resolveBackgroundUrl,
  useVoice,
} from "@revolt/rtc";
import { TOUCH_UP_SWITCH_STRENGTH } from "@revolt/rtc/cameraTonePolicy";
import { GLAM_SWITCH_STRENGTH } from "@revolt/rtc/glamPolicy";
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
  CategoryButton,
  CategorySelectOption,
  Checkbox,
  Column,
  Slider,
  Text,
} from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { CameraPreview, previewFaceFilterStatus } from "./CameraPreview";

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
  const faceSupported = faceFiltersSupported();
  const toneSupported = cameraToneSupported();

  return (
    <Column>
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

      <Show when={faceSupported || toneSupported}>
        <CameraToneOptions
          faceSupported={faceSupported}
          toneSupported={toneSupported}
          backgroundSupported={bgSupported}
        />
      </Show>

      <Show when={faceSupported}>
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
        {/* 🔴 THE ONLY UNCONDITIONAL WRITER of `screenShareAudio`, and that is
            why it exists rather than being a nicety.

            The other writer is the screen-share settings dialog, which only
            opens when `screenShareQualityAsk` is on AND more than one quality
            tier is available. On a shell where the browser's own "share system
            audio" checkbox has been removed in favour of a native capture
            (Windows), turning audio off and then turning the ask-dialog off —
            or simply arriving with one quality tier, or with the setting
            already off and synced from another device — left a user with NO
            control anywhere that could turn screen-share audio back on.

            Routing them to "Always Ask for Screen Share Quality" was the only
            way back, which is a control labelled entirely about quality. */}
        <CategoryButton
          icon="blank"
          description={
            <Trans>
              Send your computer's sound when you share your screen, where the
              app supports it.
            </Trans>
          }
          action={<Checkbox checked={voice.screenShareAudio} />}
          onClick={() => (voice.screenShareAudio = !voice.screenShareAudio)}
        >
          <Trans>Share Computer Sound</Trans>
        </CategoryButton>
      </CategoryButton.Group>
    </Column>
  );
}

/**
 * Low light, Glam and Touch up. Touch up is the `cameraBeautify` setting: a
 * strength slider where face tracking is available, and a plain switch (a
 * fixed strength, or off) where only the whole-picture smooth can run. Glam
 * is the `cameraGlam` setting: a switch and, while it is on, a strength
 * slider. All of them write through the call's setters, so a change made
 * here during a call reaches the published camera as well as the preview.
 */
function CameraToneOptions(props: {
  faceSupported: boolean;
  toneSupported: boolean;
  backgroundSupported: boolean;
}) {
  const { voice } = useState();
  const voiceContext = useVoice();
  const { t } = useLingui();

  // On a phone the answer is only known once the face tracker's files have
  // been looked for, so the first read can be a "no" that turns into a "yes".
  const [glam, setGlam] = createSignal(cameraGlamSupported());
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  onMount(() => {
    // Never rejects. The page may be gone by the time it answers.
    void probeCameraGlam().then((supported) => {
      if (!disposed) setGlam(supported);
    });
  });

  // A strength synced from a device that can run Glam must not lock Touch up
  // on one that cannot.
  const glamOn = () => glam() && voice.cameraGlam > 0;

  // A background only takes the camera's processor slot where backgrounds
  // can run; a mode synced from another device does not pause anything here.
  const pausedByBackground = () =>
    props.backgroundSupported && voice.cameraBackgroundMode !== "none";

  return (
    <>
      <CategoryButton.Group>
        <Show when={props.toneSupported}>
          <CategoryButton
            icon={<Symbol>nightlight</Symbol>}
            description={
              <Trans>Brightens your picture when the room is dark.</Trans>
            }
            action={<Checkbox checked={voice.cameraLowLight} />}
            onClick={() =>
              voiceContext.setCameraLowLight(!voice.cameraLowLight)
            }
          >
            <Trans>Low light</Trans>
          </CategoryButton>
        </Show>
        <Show when={glam()}>
          <CategoryButton
            icon={<Symbol>spa</Symbol>}
            description={t`Follows your face: smooth skin, soft makeup.`}
            action={<Checkbox checked={voice.cameraGlam > 0} />}
            onClick={() =>
              voiceContext.setCameraGlam(
                voice.cameraGlam > 0 ? 0 : GLAM_SWITCH_STRENGTH,
              )
            }
          >
            {t`Glam`}
          </CategoryButton>
          {/* Its own row: a click anywhere on the switch row above toggles
              the switch, and dragging the slider must not. */}
          <Show when={voice.cameraGlam > 0}>
            <CategoryButton
              icon="blank"
              description={
                <Slider
                  min={1}
                  max={100}
                  step={1}
                  value={voice.cameraGlam}
                  onInput={(e) =>
                    voiceContext.setCameraGlam(Number(e.currentTarget.value))
                  }
                  labelFormatter={(v) => `${v}%`}
                />
              }
            >
              {t`Strength`}
            </CategoryButton>
          </Show>
        </Show>
        <Show
          when={props.faceSupported}
          fallback={
            <CategoryButton
              icon={<Symbol>wand_stars</Symbol>}
              description={
                <Column gap="sm">
                  <Trans>Gently smooths your picture.</Trans>
                  <Show when={glamOn()}>
                    <Text class="label">{t`Touch up is part of Glam.`}</Text>
                  </Show>
                </Column>
              }
              disabled={glamOn()}
              action={
                <Checkbox
                  checked={voice.cameraBeautify > 0}
                  disabled={glamOn()}
                />
              }
              onClick={() =>
                voiceContext.setCameraFaceFilter({
                  beautify:
                    voice.cameraBeautify > 0 ? 0 : TOUCH_UP_SWITCH_STRENGTH,
                })
              }
            >
              <Trans>Touch up</Trans>
            </CategoryButton>
          }
        >
          <CategoryButton
            icon={<Symbol>wand_stars</Symbol>}
            description={
              <Column gap="sm">
                <Text class="label">
                  <Trans>Gently smooths your picture.</Trans>
                </Text>
                {/* The slider has no disabled state of its own. `inert` takes
                    it out of pointer and keyboard reach; the stored strength
                    is left alone and shows again when Glam is turned off. */}
                <div
                  inert={glamOn()}
                  style={{ opacity: glamOn() ? "0.5" : undefined }}
                >
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
                </div>
                <Show when={glamOn()}>
                  <Text class="label">{t`Touch up is part of Glam.`}</Text>
                </Show>
              </Column>
            }
          >
            <Trans>Touch up</Trans>
          </CategoryButton>
        </Show>
      </CategoryButton.Group>
      <Show when={pausedByBackground()}>
        <Text class="label">
          <Show
            when={glam()}
            fallback={
              <Trans>
                Low light and touch up pause while a background is on.
              </Trans>
            }
          >
            {t`Low light, touch up and Glam pause while a background is on.`}
          </Show>
        </Text>
      </Show>
    </>
  );
}

/**
 * Face filters: AR sticker gallery + color looks. Settings write through even
 * while a background effect holds the processor slot — they sit INERT with the
 * "paused" badge until the background is turned off (camera-face-filters plan
 * §5). Only rendered where face tracking is available.
 */
function CameraFilterOptions() {
  const { voice } = useState();
  const voiceContext = useVoice();
  const { t } = useLingui();

  const pausedByBackground = () => voice.cameraBackgroundMode !== "none";
  // Failure can come from the in-call controller OR the idle settings preview.
  // Only a sticker or Touch up needs face tracking, so a color look on its own
  // never shows the notice.
  const trackingFailed = () =>
    (!!voice.cameraFaceFilterId || voice.cameraBeautify > 0) &&
    (voiceContext.cameraFaceFilterStatus() === "failed" ||
      previewFaceFilterStatus() === "failed");

  // Solid theme-token chip (the shared Button "secondary" gradient is
  // illegible in dense pill rows — user report 2026-07-19).
  const chipStyle = (selected: boolean) =>
    ({
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
    }) as const;

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
                      src={`${FILTER_ASSETS_BASE}/${FACE_FILTERS[id].thumb}`}
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

            <Show when={trackingFailed()}>
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
                <button
                  title={t`Upload Files`}
                  onClick={(e) => {
                    // CategoryButton preventDefault()s bubbled clicks (which
                    // kills a native file input's picker) — so the input stays
                    // hidden and this tile opens it programmatically.
                    e.stopPropagation();
                    fileInput?.click();
                  }}
                  style={{
                    width: "96px",
                    height: "54px",
                    "border-radius": "6px",
                    cursor: "pointer",
                    border: "1px dashed var(--md-sys-color-outline-variant)",
                    background: "var(--md-sys-color-surface-container-high)",
                    color: "var(--md-sys-color-on-surface-variant)",
                    display: "flex",
                    "align-items": "center",
                    "justify-content": "center",
                  }}
                >
                  <Symbol>add_photo_alternate</Symbol>
                </button>
              </div>
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                onChange={onUpload}
                onClick={(e) => e.stopPropagation()}
                style={{ display: "none" }}
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
