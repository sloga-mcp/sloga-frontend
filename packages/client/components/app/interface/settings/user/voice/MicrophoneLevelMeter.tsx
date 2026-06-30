import { createSignal, onCleanup } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";

import { CategoryButton, Column, Text } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/**
 * On-demand real-time microphone input level meter
 */
export function MicrophoneLevelMeter() {
  const [active, setActive] = createSignal(false);
  const [level, setLevel] = createSignal(0);
  const [peak, setPeak] = createSignal(0);
  const [error, setError] = createSignal(false);

  let animFrame: number | undefined;
  let stream: MediaStream | undefined;
  let audioCtx: AudioContext | undefined;
  let peakTimeout: ReturnType<typeof setTimeout> | undefined;

  async function start() {
    setError(false);
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      audioCtx = new AudioContext();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      audioCtx.createMediaStreamSource(stream).connect(analyser);

      const buf = new Uint8Array(analyser.frequencyBinCount);
      function tick() {
        analyser.getByteFrequencyData(buf);
        const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
        const lvl = Math.min(100, avg * 2.5);
        setLevel(lvl);
        if (lvl > peak()) {
          setPeak(lvl);
          clearTimeout(peakTimeout);
          peakTimeout = setTimeout(() => setPeak(0), 1500);
        }
        animFrame = requestAnimationFrame(tick);
      }
      tick();
      setActive(true);
    } catch {
      setError(true);
    }
  }

  function stop() {
    if (animFrame !== undefined) cancelAnimationFrame(animFrame);
    animFrame = undefined;
    stream?.getTracks().forEach((t) => t.stop());
    stream = undefined;
    audioCtx?.close();
    audioCtx = undefined;
    clearTimeout(peakTimeout);
    setLevel(0);
    setPeak(0);
    setActive(false);
  }

  onCleanup(stop);

  const bars = 20;

  return (
    <Column>
      <Text class="title">
        <Trans>Input Level</Trans>
      </Text>
      <CategoryButton.Group>
        <CategoryButton
          icon={<Symbol>{active() ? "graphic_eq" : "mic"}</Symbol>}
          onClick={() => (active() ? stop() : start())}
          description={
            error() ? (
              <span style={{ color: "var(--md-sys-color-error)", "font-size": "0.85em" }}>
                <Trans>Microphone access denied.</Trans>
              </span>
            ) : active() ? (
              <div style={{ display: "flex", gap: "3px", "align-items": "flex-end", height: "28px", width: "100%" }}>
                {Array.from({ length: bars }, (_, i) => {
                  const threshold = (i / bars) * 100;
                  const isActive = () => level() > threshold;
                  const isPeak = () => Math.abs(peak() - threshold) < 100 / bars && peak() > 5;
                  const color = () =>
                    isPeak()
                      ? "#ffffff"
                      : isActive()
                        ? threshold < 60
                          ? "#4caf50"
                          : threshold < 80
                            ? "#ff9800"
                            : "#f44336"
                        : "rgba(255,255,255,0.1)";
                  return (
                    <div style={{
                      flex: 1,
                      height: `${40 + (i / bars) * 60}%`,
                      "border-radius": "2px",
                      background: color(),
                      transition: "background 0.05s",
                    }} />
                  );
                })}
              </div>
            ) : (
              <Trans>Click to test your microphone input level.</Trans>
            )
          }
        >
          {active() ? <Trans>Click to stop</Trans> : <Trans>Test Input Level</Trans>}
        </CategoryButton>
      </CategoryButton.Group>
    </Column>
  );
}
