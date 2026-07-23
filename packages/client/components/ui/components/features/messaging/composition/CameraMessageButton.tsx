import { Match, Show, Switch, createSignal, onCleanup } from "solid-js";

import { useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { IconButton } from "@revolt/ui/components/design";
import { Tooltip } from "@revolt/ui/components/floating";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { ComposerPopover } from "./ComposerPopover";
import { fixBlobDuration } from "./fixBlobDuration";

interface Props {
  /**
   * Receive the finished recording as a file ready to attach
   */
  onFile: (file: File) => void;

  /**
   * Surface a recording failure (e.g. camera permission denied)
   */
  onError?: (error: Error) => void;
}

/**
 * Recordings are cut off after three minutes — at ~1 Mbps the take stays
 * within the default attachment size limit, and chunks are buffered in
 * memory for the whole take
 */
const MAX_DURATION_S = 3 * 60;

/**
 * Container formats we can ask MediaRecorder for, in order of preference
 */
const MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4",
];

function fileNameFor(mimeType: string) {
  if (mimeType.startsWith("video/webm")) return "Video Message.webm";
  if (mimeType.startsWith("video/mp4")) return "Video Message.mp4";
  return "Video Message";
}

type Mode = "idle" | "recording" | "review";

/**
 * Composer action to record and attach a video message using the
 * camera and microphone
 */
export function CameraMessageButton(props: Props) {
  const { t } = useLingui();

  const [mode, setMode] = createSignal<Mode>("idle");
  const [elapsed, setElapsed] = createSignal(0);
  const [previewUrl, setPreviewUrl] = createSignal<string>();

  let recorder: MediaRecorder | undefined;
  let stream: MediaStream | undefined;
  let chunks: Blob[] = [];
  let pendingFile: File | undefined;
  let discard = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  function releaseDevices() {
    if (timer) clearInterval(timer);
    timer = undefined;
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
  }

  function cleanup() {
    releaseDevices();
    recorder = undefined;
    chunks = [];
    pendingFile = undefined;
    const url = previewUrl();
    if (url) URL.revokeObjectURL(url);
    setPreviewUrl(undefined);
    setMode("idle");
    setElapsed(0);
  }

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: true,
      });
    } catch {
      props.onError?.(
        new Error(
          t`Camera or microphone access was denied. Check your device permissions and try again.`,
        ),
      );
      return;
    }

    const mimeType = MIME_CANDIDATES.find((candidate) =>
      MediaRecorder.isTypeSupported(candidate),
    );

    try {
      recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 1_000_000,
        audioBitsPerSecond: 64_000,
      });
    } catch (error) {
      cleanup();
      props.onError?.(
        error instanceof Error ? error : new Error(String(error)),
      );
      return;
    }

    discard = false;
    chunks = [];

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) chunks.push(event.data);
    });

    recorder.addEventListener("stop", () => {
      // The camera light goes off as soon as the take ends — the
      // devices are not needed while the user reviews the recording
      releaseDevices();

      if (!discard && chunks.length) {
        // Strip codec parameters — the attachment pipeline and the E2EE
        // envelope both want the bare container type
        const containerType = (recorder?.mimeType || "video/webm").split(
          ";",
        )[0];
        pendingFile = new File(chunks, fileNameFor(containerType), {
          type: containerType,
        });
        setPreviewUrl(URL.createObjectURL(pendingFile));
        setMode("review");
      } else {
        cleanup();
      }
    });

    recorder.start(1000);
    setMode("recording");
    setElapsed(0);
    timer = setInterval(() => {
      setElapsed((seconds) => seconds + 1);
      if (elapsed() >= MAX_DURATION_S) finishTake();
    }, 1000);
  }

  function finishTake() {
    if (recorder?.state === "recording") recorder.stop();
  }

  function attach() {
    if (pendingFile) props.onFile(pendingFile);
    cleanup();
  }

  function cancel() {
    discard = true;
    if (recorder?.state === "recording") recorder.stop();
    else cleanup();
  }

  onCleanup(() => {
    discard = true;
    if (recorder?.state === "recording") recorder.stop();
    else cleanup();
  });

  const elapsedText = () => {
    const m = Math.floor(elapsed() / 60);
    const s = elapsed() % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  return (
    <ComposerPopover
      open={mode() !== "idle"}
      panel={
        <Switch>
          <Match when={mode() === "recording"}>
            <Panel>
              <LivePreview
                ref={(el) => {
                  el.srcObject = stream ?? null;
                }}
                autoplay
                muted
                playsinline
              />
              <PanelRow>
                <Symbol
                  size={16}
                  style={{ color: "var(--md-sys-color-error)" }}
                >
                  fiber_manual_record
                </Symbol>
                <Elapsed>{elapsedText()}</Elapsed>
                <Tooltip content={t`Discard recording`} placement="top">
                  <IconButton size="sm" onPress={cancel}>
                    <Symbol>delete</Symbol>
                  </IconButton>
                </Tooltip>
              </PanelRow>
            </Panel>
          </Match>
          <Match when={mode() === "review"}>
            <Panel>
              <PlaybackPreview
                ref={fixBlobDuration}
                controls
                playsinline
                src={previewUrl()}
              />
              <PanelRow>
                <Elapsed>{elapsedText()}</Elapsed>
                <Tooltip content={t`Discard recording`} placement="top">
                  <IconButton size="sm" onPress={cancel}>
                    <Symbol>delete</Symbol>
                  </IconButton>
                </Tooltip>
              </PanelRow>
            </Panel>
          </Match>
        </Switch>
      }
    >
      <Switch
        fallback={
          <Tooltip content={t`Record a video message`} placement="top">
            <IconButton onPress={start}>
              <Symbol>videocam</Symbol>
            </IconButton>
          </Tooltip>
        }
      >
        <Match when={mode() === "recording"}>
          <Tooltip content={t`Finish recording`} placement="top">
            <IconButton onPress={finishTake}>
              <Symbol style={{ color: "var(--md-sys-color-error)" }}>
                stop_circle
              </Symbol>
            </IconButton>
          </Tooltip>
        </Match>
        <Match when={mode() === "review"}>
          <Tooltip content={t`Attach video message`} placement="top">
            <IconButton onPress={attach}>
              <Symbol style={{ color: "var(--md-sys-color-primary)" }}>
                check
              </Symbol>
            </IconButton>
          </Tooltip>
        </Match>
      </Switch>
      <Show when={mode() === "recording"}>
        <span aria-live="polite" style={{ display: "none" }}>
          {t`Recording a video message`}
        </span>
      </Show>
    </ComposerPopover>
  );
}

const Panel = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: "var(--gap-sm)",
    padding: "var(--gap-sm)",

    borderRadius: "var(--borderRadius-md)",
    background: "var(--md-sys-color-surface-container-high)",
    border: "1px solid var(--md-sys-color-outline-variant)",
    boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
  },
});

/**
 * Live camera preview — mirrored like a selfie camera; the actual
 * recording is not mirrored
 */
const LivePreview = styled("video", {
  base: {
    width: "min(400px, 80vw)",
    aspectRatio: "16 / 9",
    objectFit: "cover",
    borderRadius: "var(--borderRadius-sm)",
    background: "black",
    transform: "scaleX(-1)",
  },
});

/**
 * Playback of the finished take — unmirrored, exactly what will be sent
 */
const PlaybackPreview = styled("video", {
  base: {
    width: "min(400px, 80vw)",
    aspectRatio: "16 / 9",
    objectFit: "contain",
    borderRadius: "var(--borderRadius-sm)",
    background: "black",
  },
});

const PanelRow = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    padding: "0 var(--gap-sm)",
  },
});

const Elapsed = styled("span", {
  base: {
    fontSize: "0.85em",
    fontWeight: 600,
    fontVariantNumeric: "tabular-nums",
    userSelect: "none",
    flexGrow: 1,
  },
});
