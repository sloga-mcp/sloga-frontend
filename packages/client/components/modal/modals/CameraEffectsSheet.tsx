import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";
import { Portal } from "solid-js/web";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { css } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { useWindowCtx } from "@revolt/client/windowCtx";
import type { CameraToneStats } from "@revolt/rtc";
import {
  COLOR_LOOKS,
  FACE_FILTERS,
  addUpload,
  cameraBackgroundSupported,
  cameraGlamProbeState,
  cameraGlamSupported,
  cameraToneSupported,
  faceFiltersSupported,
  listBackgrounds,
  probeCameraGlam,
  resolveBackgroundUrl,
  useVoice,
} from "@revolt/rtc";
import { TOUCH_UP_SWITCH_STRENGTH } from "@revolt/rtc/cameraTonePolicy";
import { toneStageSupported } from "@revolt/rtc/cameraToneStage";
import type { GlamState, GlamStats } from "@revolt/rtc/faceFilterProcessor";
import {
  GLAM_SWITCH_STRENGTH,
  frameHealthText,
  glamBrowserToken,
  glamCapabilityText,
  glamDelegateText,
  glamLoadText,
} from "@revolt/rtc/glamPolicy";
import { useState } from "@revolt/state";
import {
  CameraColorLookIds,
  CameraFaceFilterIds,
} from "@revolt/state/stores/Voice";
import { DialogProps, Slider } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * The in-call camera effects panel: low light, touch up, background, filters
 * and brightness. It reads and writes the same Voice store and call methods
 * as Settings → Voice, and every change applies to the picture being sent.
 *
 * It is a registered modal, so Escape and the Android Back press close it
 * through the modal stack like any dialog, but it does not use `Dialog`:
 * that draws a dark scrim over the whole window and takes every click, and
 * the point of this panel is that the call stays visible and usable while a
 * setting is tried. So it is its own surface, with no scrim: a panel at the
 * bottom edge, or down the right side on a wide and short screen (a phone
 * held sideways). A press anywhere outside it closes it and still reaches
 * what was pressed. It also closes when the camera goes off or the call
 * ends, since there is then no picture for it to change.
 *
 * Drawn above the Slim view call screen (50) and the settings page (100),
 * under the dialogs (998) and the menus (999).
 */
export function CameraEffectsSheet(
  props: DialogProps & Modals & { type: "camera_effects" },
) {
  return (
    <Portal mount={useWindowCtx().floatingMount()}>
      {/* A closed modal stays in the stack for a moment. The panel is gone
          at once, and with it its listener and its hold on the focus. */}
      <Show when={props.show}>
        <Sheet onClose={() => props.onClose()} />
      </Show>
    </Portal>
  );
}

/** The panel's place in the stack (see the component's note). */
const SHEET_Z_INDEX = 900;

/**
 * On the buttons that open the panel. A press on one is left to the button,
 * which closes the panel itself when it is open; if the panel closed on that
 * press too, the button would find it closed and open it again.
 */
const TOGGLE_ATTRIBUTE = "data-camera-effects-toggle";

/** The elements a press went through, innermost first. */
function pressChain(event: Event): Element[] {
  const path =
    typeof event.composedPath === "function" ? event.composedPath() : [];
  if (path.length) {
    return path.filter(
      (node): node is Element => (node as Node).nodeType === 1,
    );
  }

  // No composed path: walk up from the target, as `closest()` would
  const chain: Element[] = [];
  let node = event.target as Node | null;
  while (node) {
    if (node.nodeType === 1) chain.push(node as Element);
    node = node.parentNode;
  }
  return chain;
}

/**
 * Whether a press outside the panel should close it. Not when it landed on
 * a button that opens the panel, and not when it landed in something drawn
 * over the panel: a dialog (its scrim is marked `data-scrim`), a menu or a
 * popover. Those have no mark in common, so inside the floating layer they
 * are told apart by what puts them on top, a higher `z-index`.
 */
function pressCloses(chain: Element[], floatingLayer: Element): boolean {
  if (chain.some((el) => el.hasAttribute(TOGGLE_ATTRIBUTE))) return false;

  const layerAt = chain.indexOf(floatingLayer);
  if (layerAt === -1) return true;

  const view = floatingLayer.ownerDocument.defaultView;
  return !chain.slice(0, layerAt).some((el) => {
    if (el.hasAttribute("data-scrim")) return true;
    const zIndex = Number(view?.getComputedStyle(el).zIndex);
    return Number.isFinite(zIndex) && zIndex > SHEET_Z_INDEX;
  });
}

/**
 * The tone stage's state as one line, in the words of the call stats
 * overlay. Technical text for a test on a phone, not translated, and so not
 * shown until it is asked for (see `diagnosticShown`).
 */
function describeTone(stats: CameraToneStats | undefined): string {
  if (!stats) return "effects pipeline off";

  return [
    stats.toneLive ? "tone live" : "tone not live",
    stats.stages.length ? stats.stages.join("+") : "no stages",
    `src ${stats.sourceFps.toFixed(1)} / out ${stats.processedFps.toFixed(1)} fps`,
    `page ${stats.pageMode}`,
    `gain ${stats.lowLightGain.toFixed(2)}`,
  ].join(" · ");
}

/**
 * Under the tone line: how the frame loop is doing (the frame rates above
 * only say "0" when nothing is drawn, this says why), and why tone failed
 * when it did.
 */
function describeFrames(stats: CameraToneStats | undefined): string {
  if (!stats) return "";

  const frames = frameHealthText(stats.frame);
  return stats.reason ? `${frames} · ${stats.reason}` : frames;
}

/** One capability check's answer right now; undefined if it cannot be asked. */
function capability(check: () => boolean): boolean | undefined {
  try {
    return check();
  } catch {
    return undefined;
  }
}

/**
 * What the readout cannot be read without: which browser engine this is,
 * whether the phone app's check found the face tracker's files, and what
 * the capability checks answer right now, so that a look that is switched
 * off and a look this device is refused do not read the same.
 */
function describeEnvironment(): string {
  let browser = "browser unknown";
  let files = "unknown";
  try {
    browser = glamBrowserToken(navigator.userAgent);
    files = cameraGlamProbeState();
  } catch {
    // Said as unknown
  }

  const capabilities = glamCapabilityText({
    tone: capability(cameraToneSupported),
    glam: capability(cameraGlamSupported),
    webgl2: capability(toneStageSupported),
  });
  return `${browser} · tracker files ${files} · ${capabilities}`;
}

/** Where the face-tracked look stands in the call, and its tracking numbers. */
type GlamInfo = { state: GlamState; stats: GlamStats } | undefined;

/** The face-tracked look's state as a second line of the same kind. */
function describeGlam(info: GlamInfo): string {
  if (!info) return "glam: no face pipeline";

  const { state, stats } = info;
  return [
    `glam ${state}`,
    `detect ${stats.detectMeanMs.toFixed(1)} / ${stats.detectMaxMs.toFixed(1)} ms`,
    `every ${stats.every}`,
    `delegate ${glamDelegateText(stats.delegate, stats.gpuError)}`,
    `init ${Math.round(stats.initMs)} ms`,
    glamLoadText(stats.loadPhase, stats.loadPhaseMs),
  ].join(" · ");
}

/** Why the look failed, in the words of the step that failed. */
function describeGlamReason(info: GlamInfo): string {
  return info?.stats.reason ? `glam reason: ${info.stats.reason}` : "";
}

/** Presses on the panel's title, and the time they must fall within. */
const DIAGNOSTIC_PRESSES = 5;
const DIAGNOSTIC_PRESS_WINDOW_MS = 3000;

/**
 * Whether the diagnostic line is shown. Off until the title is pressed
 * `DIAGNOSTIC_PRESSES` times in a row; the same again turns it back off.
 * Held here and nowhere else, so it lasts across the panel closing and
 * opening and is gone when the app is loaded again.
 */
const [diagnosticShown, setDiagnosticShown] = createSignal(false);

/** Logs a setter that rejected; what failed in the call has its own notice. */
function settle(change: Promise<unknown>) {
  change.catch((error) =>
    console.error("[rtc] camera effect change failed", error),
  );
}

function Sheet(props: { onClose: () => void }) {
  const { voice } = useState();
  const voiceContext = useVoice();
  const windowCtx = useWindowCtx();
  const { t } = useLingui();

  // What this device can do. None of the three changes during a call.
  const tone = cameraToneSupported();
  const background = cameraBackgroundSupported();
  const faceFilters = faceFiltersSupported();

  // The face-tracked look is the exception: a phone has to find the face
  // tracker's files before it can say yes, so the answer may arrive after
  // the panel has opened.
  const [glam, setGlam] = createSignal(cameraGlamSupported());
  let open = true;
  onCleanup(() => {
    open = false;
  });
  onMount(() => {
    probeCameraGlam().then(
      (ok) => {
        if (open) setGlam(ok);
      },
      () => {
        // No answer: the row stays as it was
      },
    );
  });

  /** The stored switch, apart from the strength it is stored with. */
  const glamOn = createMemo(() => voice.cameraGlam > 0);

  const readGlam = (): GlamInfo => {
    try {
      return untrack(() => voiceContext.cameraGlamInfo());
    } catch {
      return undefined;
    }
  };

  // Where the look stands in this call, read on a timer while it is switched
  // on: nothing announces a change. The first read is taken at the moment
  // the switch went on (or the panel opened), when the picture may not have
  // caught up yet, so an "off" there says nothing and is left out.
  const [glamState, setGlamState] = createSignal<GlamState>();
  createEffect(() => {
    if (!glam() || !glamOn()) {
      setGlamState(undefined);
      return;
    }

    const first = readGlam()?.state;
    setGlamState(first === "off" ? undefined : first);
    const timer = setInterval(() => setGlamState(readGlam()?.state), 1000);
    onCleanup(() => clearInterval(timer));
  });

  /**
   * Whether the look is standing in for touch up. It does while it is
   * switched on, until it is no longer drawn in this call: turned off for
   * being slow, failed, or left out of the picture although the switch is on
   * (what a failure leaves behind). Touch up is then drawn again by itself.
   */
  const touchUpInGlam = () => {
    if (!glam() || !glamOn()) return false;
    const state = glamState();
    return state !== "shed" && state !== "failed" && state !== "off";
  };

  let panel: HTMLDivElement | undefined;

  // The panel changes the picture being sent. With the camera off or the
  // call over there is none, and the buttons that open it are gone too. A
  // reconnect keeps the call, so the panel stays through one.
  createEffect(() => {
    const state = voiceContext.state();
    const inCall = state === "CONNECTED" || state === "RECONNECTING";
    if (!voiceContext.video() || !voiceContext.room() || !inCall) {
      props.onClose();
    }
  });

  // The times of the latest presses on the title, oldest first
  let titlePresses: number[] = [];
  const onTitlePress = () => {
    const now = Date.now();
    titlePresses = [
      ...titlePresses.filter((at) => now - at < DIAGNOSTIC_PRESS_WINDOW_MS),
      now,
    ];
    if (titlePresses.length >= DIAGNOSTIC_PRESSES) {
      titlePresses = [];
      setDiagnosticShown((shown) => !shown);
    }
  };

  // Read on a timer: the stats are a plain read, nothing announces a change
  const readTone = (): CameraToneStats | undefined => {
    try {
      return untrack(() => voiceContext.cameraToneStats());
    } catch {
      return undefined;
    }
  };
  const [toneLine, setToneLine] = createSignal("");
  const [framesLine, setFramesLine] = createSignal("");
  const [glamLine, setGlamLine] = createSignal("");
  const [glamReasonLine, setGlamReasonLine] = createSignal("");
  const [environmentLine, setEnvironmentLine] = createSignal("");

  // The timer runs only while the lines are shown
  createEffect(() => {
    if (!diagnosticShown()) return;

    const read = () => {
      const tone = readTone();
      const look = readGlam();
      setToneLine(describeTone(tone));
      setFramesLine(describeFrames(tone));
      setGlamLine(describeGlam(look));
      setGlamReasonLine(describeGlamReason(look));
      setEnvironmentLine(describeEnvironment());
    };
    read();
    const timer = setInterval(read, 1000);
    onCleanup(() => clearInterval(timer));
  });

  onMount(() => {
    // The panel's own window: a chat window has its own document.
    const doc = windowCtx.doc;
    const opener = doc.activeElement as HTMLElement | null;

    panel?.focus({ preventScroll: true });

    // Capture phase, so a control that stops the event still closes the
    // panel. Nothing is prevented: the press goes on to what was pressed.
    const onPointerDown = (event: PointerEvent) => {
      if (!panel) return;
      const chain = pressChain(event);
      if (chain.includes(panel)) return;
      if (pressCloses(chain, windowCtx.floatingMount())) props.onClose();
    };
    doc.addEventListener("pointerdown", onPointerDown, true);

    onCleanup(() => {
      doc.removeEventListener("pointerdown", onPointerDown, true);

      // Focus goes back to where it was, unless the user has already put it
      // somewhere else (the press outside that closed the panel).
      const active = doc.activeElement;
      const focusLeftBehind =
        !active || active === doc.body || !!panel?.contains(active);
      if (
        focusLeftBehind &&
        opener?.isConnected &&
        typeof opener.focus === "function"
      ) {
        opener.focus({ preventScroll: true });
      }
    });
  });

  return (
    <Panel
      ref={panel}
      role="dialog"
      aria-label={t`Camera effects`}
      tabIndex={-1}
    >
      <Header>
        <Heading onClick={onTitlePress}>
          <Trans>Camera effects</Trans>
        </Heading>
        <button
          type="button"
          class={closeButton}
          onClick={() => props.onClose()}
        >
          <Trans>Close</Trans>
        </button>
      </Header>

      <Body>
        <Show when={tone}>
          <SwitchRow
            title={t`Low light`}
            description={t`Brightens your picture when the room is dark.`}
            checked={voice.cameraLowLight}
            onToggle={() =>
              voiceContext.setCameraLowLight(!voice.cameraLowLight)
            }
          />
        </Show>

        <Show when={tone || faceFilters}>
          <SwitchRow
            title={t`Touch up`}
            description={t`Gently smooths your picture.`}
            // The stored touch up is left alone while the look stands in
            // for it, and is drawn again by itself when the look stops
            checked={!touchUpInGlam() && voice.cameraBeautify > 0}
            disabled={touchUpInGlam()}
            onToggle={() =>
              settle(
                voiceContext.setCameraFaceFilter({
                  beautify:
                    voice.cameraBeautify > 0 ? 0 : TOUCH_UP_SWITCH_STRENGTH,
                }),
              )
            }
          />
          <Show when={touchUpInGlam()}>
            <Muted>
              <Trans>Touch up is part of Glam.</Trans>
            </Muted>
          </Show>
        </Show>

        <Show when={glam()}>
          <SwitchRow
            title={t`Glam`}
            description={t`Follows your face: smooth skin, soft makeup.`}
            checked={glamOn()}
            onToggle={() =>
              voiceContext.setCameraGlam(glamOn() ? 0 : GLAM_SWITCH_STRENGTH)
            }
          />
          <Show when={glamOn()}>
            <Label>
              <Trans>Strength</Trans>
            </Label>
            <Slider
              min={1}
              max={100}
              step={1}
              value={voice.cameraGlam}
              onInput={(e) =>
                voiceContext.setCameraGlam(Number(e.currentTarget.value))
              }
            />
            <Show when={glamState() === "failed"}>
              <Muted>
                <Trans>Glam could not start on this device.</Trans>
              </Muted>
            </Show>
          </Show>
        </Show>

        <Show
          when={tone && background && voice.cameraBackgroundMode !== "none"}
        >
          <Muted>
            <Show
              when={glam()}
              fallback={
                <Trans>
                  Low light and touch up pause while a background is on.
                </Trans>
              }
            >
              <Trans>
                Low light, touch up and Glam pause while a background is on.
              </Trans>
            </Show>
          </Muted>
        </Show>

        <Show when={background}>
          <BackgroundSection />
        </Show>

        <Show when={faceFilters}>
          <Section>
            <SectionTitle>
              <Trans>Filters</Trans>
            </SectionTitle>
            <Show when={voice.cameraBackgroundMode !== "none"}>
              <Muted>
                <Trans>
                  Filters are paused while background effects are on.
                </Trans>
              </Muted>
            </Show>
            <Chips>
              <button
                type="button"
                class={chip}
                aria-pressed={!voice.cameraFaceFilterId}
                onClick={() =>
                  settle(voiceContext.setCameraFaceFilter({ filterId: null }))
                }
              >
                {t`None`}
              </button>
              <For each={CameraFaceFilterIds}>
                {(id) => (
                  <button
                    type="button"
                    class={chip}
                    aria-pressed={voice.cameraFaceFilterId === id}
                    onClick={() =>
                      settle(voiceContext.setCameraFaceFilter({ filterId: id }))
                    }
                  >
                    {FACE_FILTERS[id].name}
                  </button>
                )}
              </For>
            </Chips>

            <Label>
              <Trans>Color filter</Trans>
            </Label>
            <Chips>
              <button
                type="button"
                class={chip}
                aria-pressed={!voice.cameraColorLookId}
                onClick={() =>
                  settle(
                    voiceContext.setCameraFaceFilter({ colorLookId: null }),
                  )
                }
              >
                {t`None`}
              </button>
              <For each={CameraColorLookIds}>
                {(id) => (
                  <button
                    type="button"
                    class={chip}
                    aria-pressed={voice.cameraColorLookId === id}
                    onClick={() =>
                      settle(
                        voiceContext.setCameraFaceFilter({ colorLookId: id }),
                      )
                    }
                  >
                    {COLOR_LOOKS[id].name}
                  </button>
                )}
              </For>
            </Chips>

            {/* Only a sticker or touch up needs face tracking */}
            <Show
              when={
                (!!voice.cameraFaceFilterId || voice.cameraBeautify > 0) &&
                voiceContext.cameraFaceFilterStatus() === "failed"
              }
            >
              <Muted>
                <Trans>
                  Face tracking failed — stickers and beautify are unavailable.
                </Trans>
              </Muted>
            </Show>
          </Section>
        </Show>

        <Section>
          <SectionTitle>
            <Trans>Brightness</Trans>
          </SectionTitle>
          <Slider
            min={0}
            max={200}
            step={1}
            value={voice.cameraBrightness}
            onInput={(e) =>
              settle(
                voiceContext.setCameraBrightness(Number(e.currentTarget.value)),
              )
            }
            labelFormatter={(v) => `${v}%`}
          />
        </Section>

        <Show when={diagnosticShown()}>
          <Diagnostic aria-hidden="true">{toneLine()}</Diagnostic>
          <Show when={framesLine()}>
            <Diagnostic aria-hidden="true">{framesLine()}</Diagnostic>
          </Show>
          <Show when={glam()}>
            <Diagnostic aria-hidden="true">{glamLine()}</Diagnostic>
          </Show>
          {/* Not behind `glam()`: a look that is not offered is the case
              these two lines are most needed for. */}
          <Show when={glamReasonLine()}>
            <Diagnostic aria-hidden="true">{glamReasonLine()}</Diagnostic>
          </Show>
          <Diagnostic aria-hidden="true">{environmentLine()}</Diagnostic>
        </Show>
      </Body>
    </Panel>
  );
}

/**
 * A setting that is on or off. The whole row is the button, so the target
 * is as wide as the panel.
 */
function SwitchRow(props: {
  title: string;
  description: string;
  checked: boolean;
  /** Shown but not pressable: something else decides it for now. */
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      class={switchRow}
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={() => {
        if (!props.disabled) props.onToggle();
      }}
    >
      <SwitchText>
        <SwitchTitle>{props.title}</SwitchTitle>
        <SwitchDescription>{props.description}</SwitchDescription>
      </SwitchText>
      <SwitchTrack aria-hidden="true">
        <SwitchThumb />
      </SwitchTrack>
    </button>
  );
}

/**
 * None, blur, or a picture: one of the built-in ones or one of the user's
 * own. A picture can be added here; removing one stays in Settings → Voice.
 */
function BackgroundSection() {
  const { voice } = useState();
  const voiceContext = useVoice();
  const { showError } = useModals();
  const { t } = useLingui();

  // Each load keeps its own list of thumbnail URLs to release and swaps it
  // in when it lands, so a load that lands after the panel closed, or after
  // a newer one, releases only its own.
  let revokes: (() => void)[] = [];
  let disposed = false;
  let loadSeq = 0;
  const [reloadKey, setReloadKey] = createSignal(0);

  // `+ 1`: a source of 0 would skip the first load
  const [pictures] = createResource(
    () => reloadKey() + 1,
    async () => {
      const myLoad = ++loadSeq;
      const localRevokes: (() => void)[] = [];
      const list = await listBackgrounds();
      const resolved = await Promise.all(
        list.map(async (item) => {
          const r = await resolveBackgroundUrl(item.id);
          if (r) localRevokes.push(r.revoke);
          return { ...item, url: r?.url };
        }),
      );
      if (disposed || myLoad !== loadSeq) {
        localRevokes.forEach((r) => r());
        return [];
      }
      revokes.forEach((r) => r());
      revokes = localRevokes;
      return resolved.filter((i) => i.url);
    },
  );

  onCleanup(() => {
    disposed = true;
    revokes.forEach((r) => r());
  });

  let fileInput: HTMLInputElement | undefined;

  async function onUpload(
    event: Event & { currentTarget: HTMLInputElement },
  ): Promise<void> {
    // Held now: an event's `currentTarget` is gone after the first await.
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const item = await addUpload(file, file.name);
      setReloadKey((k) => k + 1);
      await voiceContext.setCameraBackground("image", { imageId: item.id });
    } catch (error) {
      showError(error);
    } finally {
      // So that choosing the same file again is still a change
      input.value = "";
    }
  }

  return (
    <Section>
      <SectionTitle>
        <Trans>Background</Trans>
      </SectionTitle>
      <Chips>
        <button
          type="button"
          class={chip}
          aria-pressed={voice.cameraBackgroundMode === "none"}
          onClick={() => settle(voiceContext.setCameraBackground("none"))}
        >
          {t`None`}
        </button>
        <button
          type="button"
          class={chip}
          aria-pressed={voice.cameraBackgroundMode === "blur"}
          onClick={() => settle(voiceContext.setCameraBackground("blur"))}
        >
          {t`Blur`}
        </button>
        <For each={pictures() ?? []}>
          {(item) => (
            <button
              type="button"
              class={pictureTile}
              aria-label={item.name}
              title={item.name}
              aria-pressed={
                voice.cameraBackgroundMode === "image" &&
                voice.cameraBackgroundImageId === item.id
              }
              onClick={() =>
                settle(
                  voiceContext.setCameraBackground("image", {
                    imageId: item.id,
                  }),
                )
              }
            >
              <img class={pictureImage} src={item.url} alt="" />
            </button>
          )}
        </For>
        <button
          type="button"
          class={pictureTile}
          aria-label={t`Upload Files`}
          title={t`Upload Files`}
          onClick={() => fileInput?.click()}
        >
          <Symbol>add_photo_alternate</Symbol>
        </button>
      </Chips>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => void onUpload(event)}
      />

      <Show when={voice.cameraBackgroundMode === "blur"}>
        <Label>
          <Trans>Blur strength: {voice.cameraBlurRadius}</Trans>
        </Label>
        <Slider
          min={1}
          max={20}
          step={1}
          value={voice.cameraBlurRadius}
          onInput={(e) =>
            settle(
              voiceContext.setCameraBackground("blur", {
                blurRadius: Number(e.currentTarget.value),
              }),
            )
          }
        />
      </Show>
    </Section>
  );
}

const Panel = styled("div", {
  base: {
    position: "fixed",
    zIndex: SHEET_Z_INDEX,
    left: "env(safe-area-inset-left, 0px)",
    right: "env(safe-area-inset-right, 0px)",
    bottom: 0,

    // Centered on a wide window: with both sides set and the width capped,
    // the automatic margins share what is left over
    maxWidth: "480px",
    marginInline: "auto",
    maxHeight: "60vh",
    paddingBottom: "env(safe-area-inset-bottom, 0px)",

    display: "flex",
    flexDirection: "column",

    outline: "none",
    pointerEvents: "auto",
    userSelect: "none",

    borderRadius: "var(--borderRadius-xl) var(--borderRadius-xl) 0 0",
    color: "var(--md-sys-color-on-surface)",
    background: "var(--md-sys-color-surface-container)",
    boxShadow: "0 -2px 16px #00000059",

    // A phone held sideways has no height to give a bottom panel, so it
    // goes down the right side instead
    "@media (orientation: landscape) and (max-height: 500px)": {
      top: "calc(env(safe-area-inset-top, 0px) + var(--titlebar-height, 0px))",
      left: "auto",
      width: "320px",
      maxWidth: "100vw",
      marginInline: 0,
      maxHeight: "none",

      borderRadius: "var(--borderRadius-xl) 0 0 var(--borderRadius-xl)",
      boxShadow: "-2px 0 16px #00000059",
    },
  },
});

const Header = styled("div", {
  base: {
    flexShrink: 0,

    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--gap-md)",

    padding: "var(--gap-sm) var(--gap-md) var(--gap-sm) var(--gap-lg)",
  },
});

const Heading = styled("div", {
  base: {
    minWidth: 0,
    fontSize: "1rem",
    fontWeight: 600,
  },
});

const Body = styled("div", {
  base: {
    flex: "1 1 auto",
    minHeight: 0,
    overflowX: "hidden",
    overflowY: "auto",
    overscrollBehavior: "contain",

    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-md)",

    padding: "0 var(--gap-lg) var(--gap-lg)",
  },
});

const Section = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-md)",
  },
});

const SectionTitle = styled("div", {
  base: {
    fontSize: "0.875rem",
    fontWeight: 600,
  },
});

const Label = styled("div", {
  base: {
    fontSize: "0.8125rem",
    fontWeight: 500,
  },
});

const Muted = styled("div", {
  base: {
    fontSize: "0.8125rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Diagnostic = styled("div", {
  base: {
    fontFamily: "var(--fonts-monospace)",
    fontSize: "0.6875rem",
    lineHeight: 1.4,
    overflowWrap: "anywhere",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Chips = styled("div", {
  base: {
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--gap-md)",
  },
});

const SwitchText = styled("span", {
  base: {
    flex: "1 1 auto",
    minWidth: 0,

    display: "flex",
    flexDirection: "column",
    gap: "2px",
  },
});

const SwitchTitle = styled("span", {
  base: {
    fontSize: "0.9375rem",
    fontWeight: 600,
  },
});

const SwitchDescription = styled("span", {
  base: {
    fontSize: "0.8125rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

// The track and its thumb follow the row's `aria-checked`, the one place the
// state is written
const SwitchTrack = styled("span", {
  base: {
    flexShrink: 0,
    width: "52px",
    height: "32px",
    padding: "4px",
    borderRadius: "var(--borderRadius-full)",

    display: "flex",
    alignItems: "center",

    background: "var(--md-sys-color-surface-container-highest)",
    boxShadow: "inset 0 0 0 2px var(--md-sys-color-outline)",
    transition: "var(--transitions-fast) background",

    "[aria-checked=true] > &": {
      background: "var(--md-sys-color-primary)",
      boxShadow: "none",
    },
  },
});

const SwitchThumb = styled("span", {
  base: {
    width: "24px",
    height: "24px",
    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-outline)",
    transition: "var(--transitions-fast) transform",

    "[aria-checked=true] > * > &": {
      background: "var(--md-sys-color-on-primary)",
      transform: "translateX(20px)",
    },
  },
});

const focusRing = {
  outline: "2px solid var(--md-sys-color-primary)",
  outlineOffset: "2px",
} as const;

const closeButton = css({
  flexShrink: 0,
  minWidth: "44px",
  minHeight: "44px",
  padding: "0 var(--gap-md)",
  borderRadius: "var(--borderRadius-full)",

  cursor: "pointer",
  fontSize: "0.875rem",
  fontWeight: 600,
  color: "var(--md-sys-color-primary)",
  border: "none",
  background: "transparent",

  "&:focus-visible": focusRing,
});

const switchRow = css({
  width: "100%",
  minHeight: "44px",
  padding: "var(--gap-sm) 0",

  display: "flex",
  alignItems: "center",
  gap: "var(--gap-md)",

  cursor: "pointer",
  textAlign: "start",
  color: "inherit",
  border: "none",
  background: "transparent",
  borderRadius: "var(--borderRadius-md)",

  "&:disabled": {
    cursor: "default",
    opacity: 0.5,
  },
  "&:focus-visible": focusRing,
});

// Flat theme colors: the shared Button's "secondary" look is a gradient that
// is hard to read in a row of small pills
const chip = css({
  minWidth: "44px",
  minHeight: "44px",
  padding: "0 var(--gap-lg)",
  borderRadius: "var(--borderRadius-full)",
  border: "1px solid var(--md-sys-color-outline-variant)",

  cursor: "pointer",
  fontSize: "0.875rem",
  fontWeight: 600,
  color: "var(--md-sys-color-on-surface)",
  background: "var(--md-sys-color-surface-container-high)",

  "&[aria-pressed=true]": {
    color: "var(--md-sys-color-on-primary)",
    background: "var(--md-sys-color-primary)",
  },
  "&:focus-visible": focusRing,
});

const pictureTile = css({
  width: "96px",
  height: "54px",
  padding: 0,
  overflow: "hidden",
  borderRadius: "var(--borderRadius-md)",
  border: "1px dashed var(--md-sys-color-outline-variant)",

  display: "flex",
  alignItems: "center",
  justifyContent: "center",

  cursor: "pointer",
  color: "var(--md-sys-color-on-surface-variant)",
  background: "var(--md-sys-color-surface-container-high)",

  "&[aria-pressed]": {
    borderStyle: "solid",
  },
  "&[aria-pressed=true]": {
    outline: "2px solid var(--md-sys-color-primary)",
    outlineOffset: "1px",
  },
  "&:focus-visible": focusRing,
});

const pictureImage = css({
  width: "100%",
  height: "100%",
  objectFit: "cover",
});
