import { Match, Show, Switch, createSignal, onCleanup } from "solid-js";

import { useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { IconButton } from "@revolt/ui/components/design";
import { Tooltip } from "@revolt/ui/components/floating";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

interface Props {
  /**
   * Receive the finished recording as a file ready to attach
   */
  onFile: (file: File) => void;

  /**
   * Surface a recording failure (e.g. microphone permission denied)
   */
  onError?: (error: Error) => void;
}

/**
 * Recordings are cut off after half an hour — chunks are buffered in
 * memory for the whole take
 */
const MAX_DURATION_S = 30 * 60;

/**
 * Container formats we can ask MediaRecorder for, in order of preference
 */
const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

/**
 * The .weba extension is load-bearing: the file server classifies
 * audio-only WebM by extension because the container's magic bytes
 * read as video
 */
function fileNameFor(mimeType: string) {
  if (mimeType.startsWith("audio/webm")) return "Voice Message.weba";
  if (mimeType.startsWith("audio/mp4")) return "Voice Message.m4a";
  if (mimeType.startsWith("audio/ogg")) return "Voice Message.oga";
  return "Voice Message";
}

/**
 * Composer action to record and attach a voice message
 */
export function VoiceMessageButton(props: Props) {
  const { t } = useLingui();

  const [recording, setRecording] = createSignal(false);
  const [elapsed, setElapsed] = createSignal(0);

  let recorder: MediaRecorder | undefined;
  let stream: MediaStream | undefined;
  let chunks: Blob[] = [];
  let discard = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  function cleanup() {
    if (timer) clearInterval(timer);
    timer = undefined;
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
    recorder = undefined;
    chunks = [];
    setRecording(false);
    setElapsed(0);
  }

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      props.onError?.(
        new Error(
          t`Microphone access was denied. Check your microphone permissions and try again.`,
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
      if (!discard && chunks.length) {
        // Strip codec parameters — the attachment pipeline and the E2EE
        // envelope both want the bare container type
        const containerType = (recorder?.mimeType || "audio/webm").split(
          ";",
        )[0];
        props.onFile(
          new File(chunks, fileNameFor(containerType), {
            type: containerType,
          }),
        );
      }

      cleanup();
    });

    recorder.start(1000);
    setRecording(true);
    setElapsed(0);
    timer = setInterval(() => {
      setElapsed((seconds) => seconds + 1);
      if (elapsed() >= MAX_DURATION_S) accept();
    }, 1000);
  }

  function accept() {
    if (recorder?.state === "recording") recorder.stop();
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
    <Anchor>
      <Switch
        fallback={
          <Tooltip content={t`Record a voice message`} placement="top">
            <IconButton onPress={start}>
              <Symbol>mic</Symbol>
            </IconButton>
          </Tooltip>
        }
      >
        <Match when={recording()}>
          <Tooltip content={t`Finish recording`} placement="top">
            <IconButton onPress={accept}>
              <Symbol style={{ color: "var(--md-sys-color-error)" }}>
                stop_circle
              </Symbol>
            </IconButton>
          </Tooltip>
          <Panel>
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
          </Panel>
        </Match>
      </Switch>
      <Show when={recording()}>
        <span aria-live="polite" style={{ display: "none" }}>
          {t`Recording a voice message`}
        </span>
      </Show>
    </Anchor>
  );
}

const Anchor = styled("div", {
  base: {
    position: "relative",
    display: "flex",
  },
});

const Panel = styled("div", {
  base: {
    position: "absolute",
    bottom: "calc(100% + 8px)",
    right: 0,
    zIndex: 1000,

    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    padding: "var(--gap-sm) var(--gap-md)",

    borderRadius: "var(--borderRadius-md)",
    background: "var(--md-sys-color-surface-container-high)",
    border: "1px solid var(--md-sys-color-outline-variant)",
    boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
  },
});

const Elapsed = styled("span", {
  base: {
    fontSize: "0.85em",
    fontWeight: 600,
    fontVariantNumeric: "tabular-nums",
    userSelect: "none",
  },
});
