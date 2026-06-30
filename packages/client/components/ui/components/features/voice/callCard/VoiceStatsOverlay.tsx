import { createSignal, onCleanup, Show } from "solid-js";

import { css } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { useVoice } from "@revolt/rtc";
import { IconButton } from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

interface Stats {
  rtt: number | null;
  jitter: number | null;
  packetsLost: number | null;
  bitrate: number | null;
}

/**
 * Toggle button + overlay showing live WebRTC stats (RTT, jitter, packet loss, bitrate)
 */
export function VoiceStatsOverlay(props: { size: "xs" | "sm" }) {
  const voice = useVoice();
  const [visible, setVisible] = createSignal(false);
  const [stats, setStats] = createSignal<Stats>({
    rtt: null,
    jitter: null,
    packetsLost: null,
    bitrate: null,
  });

  let interval: ReturnType<typeof setInterval> | undefined;
  let prevBytes = 0;
  let prevTime = 0;

  async function poll() {
    const room = voice.room();
    if (!room) return;

    try {
      const reports = await room.localParticipant
        .getTrackPublication("microphone")
        ?.track?.getRTCStatsReport?.();

      let rtt: number | null = null;
      let jitter: number | null = null;
      let packetsLost: number | null = null;
      let bytes = 0;

      if (reports) {
        reports.forEach((report: RTCStats) => {
          const r = report as any;
          if (r.type === "remote-inbound-rtp") {
            if (typeof r.roundTripTime === "number") rtt = Math.round(r.roundTripTime * 1000);
            if (typeof r.jitter === "number") jitter = Math.round(r.jitter * 1000);
            if (typeof r.packetsLost === "number") packetsLost = r.packetsLost;
          }
          if (r.type === "outbound-rtp") {
            if (typeof r.bytesSent === "number") bytes = r.bytesSent;
          }
        });
      }

      const now = Date.now();
      let bitrate: number | null = null;
      if (prevTime && bytes > prevBytes) {
        bitrate = Math.round(((bytes - prevBytes) * 8) / ((now - prevTime) / 1000) / 1000);
      }
      prevBytes = bytes;
      prevTime = now;

      setStats({ rtt, jitter, packetsLost, bitrate });
    } catch {
      // stats not available yet
    }
  }

  function toggle() {
    if (visible()) {
      setVisible(false);
      clearInterval(interval);
      interval = undefined;
    } else {
      setVisible(true);
      prevBytes = 0;
      prevTime = 0;
      poll();
      interval = setInterval(poll, 1000);
    }
  }

  onCleanup(() => clearInterval(interval));

  const row = css({ display: "flex", justifyContent: "space-between", gap: "12px" });
  const label = css({ opacity: "0.6", fontSize: "0.75rem" });
  const value = css({ fontWeight: "600", fontSize: "0.75rem", fontFamily: "monospace" });

  function fmt(v: number | null, unit: string) {
    return v === null ? "—" : `${v} ${unit}`;
  }

  return (
    <>
      <Show when={visible()}>
        <Overlay>
          <div class={row}>
            <span class={label}>RTT</span>
            <span class={value}>{fmt(stats().rtt, "ms")}</span>
          </div>
          <div class={row}>
            <span class={label}>Jitter</span>
            <span class={value}>{fmt(stats().jitter, "ms")}</span>
          </div>
          <div class={row}>
            <span class={label}>Packet loss</span>
            <span class={value}>{fmt(stats().packetsLost, "")}</span>
          </div>
          <div class={row}>
            <span class={label}>Bitrate</span>
            <span class={value}>{fmt(stats().bitrate, "kbps")}</span>
          </div>
        </Overlay>
      </Show>
      <IconButton
        size={props.size}
        variant={visible() ? "filled" : "tonal"}
        onPress={toggle}
      >
        <Symbol>network_check</Symbol>
      </IconButton>
    </>
  );
}

const Overlay = styled("div", {
  base: {
    position: "absolute",
    bottom: "60px",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 10,
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    padding: "10px 14px",
    borderRadius: "var(--borderRadius-md)",
    background: "var(--md-sys-color-surface-container-highest)",
    color: "var(--md-sys-color-on-surface)",
    minWidth: "180px",
    boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
    pointerEvents: "none",
  },
});
