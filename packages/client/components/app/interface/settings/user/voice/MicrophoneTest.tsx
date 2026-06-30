import { createSignal, onCleanup } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";

import { Button, CategoryButton, Column, Text } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/**
 * Microphone test — record for up to 5s then play back
 */
export function MicrophoneTest() {
  const [state, setState] = createSignal<"idle" | "recording" | "playing">("idle");
  const [level, setLevel] = createSignal(0);

  let mediaRecorder: MediaRecorder | undefined;
  let chunks: Blob[] = [];
  let audioCtx: AudioContext | undefined;
  let analyser: AnalyserNode | undefined;
  let animFrame: number | undefined;
  let stream: MediaStream | undefined;

  function stopAnimFrame() {
    if (animFrame !== undefined) cancelAnimationFrame(animFrame);
    animFrame = undefined;
  }

  function startLevelMeter(src: MediaStream) {
    audioCtx = new AudioContext();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    audioCtx.createMediaStreamSource(src).connect(analyser);

    const buf = new Uint8Array(analyser.frequencyBinCount);
    function tick() {
      analyser!.getByteFrequencyData(buf);
      const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
      setLevel(Math.min(100, avg * 2));
      animFrame = requestAnimationFrame(tick);
    }
    tick();
  }

  async function startRecording() {
    chunks = [];
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return;
    }

    startLevelMeter(stream);
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => chunks.push(e.data);
    mediaRecorder.onstop = () => {
      stopAnimFrame();
      setLevel(0);
      stream?.getTracks().forEach((t) => t.stop());
      audioCtx?.close();
      playBack();
    };
    mediaRecorder.start();
    setState("recording");

    // Auto-stop after 5s
    setTimeout(() => {
      if (mediaRecorder?.state === "recording") stopRecording();
    }, 5000);
  }

  function stopRecording() {
    mediaRecorder?.stop();
  }

  function playBack() {
    if (!chunks.length) { setState("idle"); return; }
    setState("playing");
    const blob = new Blob(chunks, { type: chunks[0].type });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => { setState("idle"); URL.revokeObjectURL(url); };
    audio.play();
  }

  onCleanup(() => {
    stopAnimFrame();
    mediaRecorder?.stop();
    stream?.getTracks().forEach((t) => t.stop());
    audioCtx?.close();
  });

  return (
    <Column>
      <Text class="title">
        <Trans>Microphone Test</Trans>
      </Text>
      <CategoryButton.Group>
        <CategoryButton
          icon={<Symbol>{state() === "recording" ? "stop" : "mic"}</Symbol>}
          action={
            state() === "idle" ? (
              <Button variant="filled" bg="#FF6B00" onPress={startRecording}>
                <Trans>Record</Trans>
              </Button>
            ) : state() === "recording" ? (
              <Button variant="filled" bg="#e53935" onPress={stopRecording}>
                <Trans>Stop</Trans>
              </Button>
            ) : (
              <span style={{ "font-size": "0.85em", opacity: "0.7" }}>
                <Trans>Playing back…</Trans>
              </span>
            )
          }
          description={
            state() === "recording" ? (
              <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                <div style={{
                  flex: 1,
                  height: "6px",
                  background: "rgba(255,255,255,0.15)",
                  "border-radius": "3px",
                  overflow: "hidden",
                }}>
                  <div style={{
                    height: "100%",
                    width: `${level()}%`,
                    background: "#FF6B00",
                    "border-radius": "3px",
                    transition: "width 0.05s",
                  }} />
                </div>
              </div>
            ) : (
              <Trans>Click Record, speak for up to 5 seconds, then hear yourself played back.</Trans>
            )
          }
        >
          {state() === "idle" && <Trans>Test Microphone</Trans>}
          {state() === "recording" && <Trans>Recording… (max 5s)</Trans>}
          {state() === "playing" && <Trans>Playing back…</Trans>}
        </CategoryButton>
      </CategoryButton.Group>
    </Column>
  );
}
