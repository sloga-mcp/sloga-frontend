/**
 * The DOM half of the gamepad leg (couch co-op §2.6 part 2). Lazy chunk:
 * imported from one call site guarded on `import.meta.env
 * .VITE_CFG_RC_GAMEPAD_LEG` read DIRECTLY, so a production bundle neither
 * fetches nor even CONTAINS it — same const-fold rule, and the same audit
 * method (grep a dist for this file's own strings), as the latency probe.
 *
 * What it is: the controller-side pad capture loop the product does not
 * have until G2, built only far enough to run the gate. It polls the first
 * connected Gamepad on a TIMER (never rAF — a hidden or throttled window
 * freezes rAF, and a frozen capture loop reads as a dead session on the
 * sharer's watchdog), shapes each frame through the tested W3C→XInput
 * mapping, and hands it to `RemoteControl.sendPadFrame`, which seals it
 * natively and publishes it over the real LiveKit data channel. Rising
 * button edges also arm the press-to-photon probe, so the same readout that
 * measured keydowns measures pad presses.
 *
 * Blur handling (§2.1): `getGamepads()` freezes when the window loses
 * focus, so a held stick would replay its last state forever. On blur this
 * sends ONE neutral frame and stops; on focus it resumes. The sharer's own
 * watchdog covers the gap regardless — this is politeness, that is the
 * guarantee.
 */
import type { Room } from "livekit-client";

import type { RemoteControl } from "./remoteControl";
import { NEUTRAL_PAD, pressedEdges, readPad } from "./rcPadLeg";
import { attachProbe } from "./rcLatencyProbeRuntime";

/**
 * 16 ms ≈ the display cadence the injected pad is consumed at. A pad frame
 * is complete state on the lossy stream, so a faster loop buys nothing and
 * a slower one adds quantization to exactly the number under measurement.
 */
const PAD_SEND_INTERVAL_MS = 16;

export type PadLegHandle = { detach: () => void };

/**
 * Best-effort active ICE candidate pair, via livekit-client internals.
 *
 * Measurement builds only, so a miss degrades to "unavailable" rather than
 * failing the leg — but §2.6a's lesson is that a run whose network path is
 * unrecorded cannot be compared with anything, so this is displayed on the
 * readout where the operator's photos capture it.
 */
async function icePairLine(room: Room | undefined): Promise<string> {
  try {
    if (!room) return "ICE: no room";
    // Internal shape as of the pinned livekit-client; probed defensively.
    const engine = (
      room as unknown as {
        engine?: {
          pcManager?: {
            publisher?: { _pc?: RTCPeerConnection; pc?: RTCPeerConnection };
            subscriber?: { _pc?: RTCPeerConnection; pc?: RTCPeerConnection };
          };
        };
      }
    ).engine;
    const pads: string[] = [];
    for (const [label, wrapper] of [
      ["pub", engine?.pcManager?.publisher],
      ["sub", engine?.pcManager?.subscriber],
    ] as const) {
      const pc = wrapper?._pc ?? wrapper?.pc;
      if (!pc) continue;
      const stats = await pc.getStats();
      const byId = new Map<string, Record<string, unknown>>();
      stats.forEach((s: Record<string, unknown>) =>
        byId.set(s.id as string, s),
      );
      for (const s of byId.values()) {
        if (
          s.type === "candidate-pair" &&
          (s.nominated === true || s.selected === true) &&
          s.state === "succeeded"
        ) {
          const local = byId.get(s.localCandidateId as string);
          const remote = byId.get(s.remoteCandidateId as string);
          const fmt = (c?: Record<string, unknown>) =>
            c ? `${c.address ?? c.ip}:${c.port}` : "?";
          pads.push(`${label} ${fmt(local)} ⇄ ${fmt(remote)}`);
          break;
        }
      }
    }
    return pads.length ? `ICE: ${pads.join("  ·  ")}` : "ICE: pair unavailable";
  } catch {
    return "ICE: pair unavailable";
  }
}

/**
 * Attach the pad capture loop + probe to a screen-share tile the local user
 * is controlling over a GAMEPAD-class session.
 */
export function attachPadLeg(
  video: HTMLVideoElement,
  rc: RemoteControl,
  sharerIdentity: string,
): PadLegHandle {
  const probe = attachProbe(video, {
    pressLabel: "pad press",
    keydownArms: false,
  });

  let stopped = false;
  let paused = false;
  let padSeen: string | undefined;
  let framesSent = 0;
  let prevButtons = 0;

  function status(note?: string) {
    probe.status(
      [
        padSeen ? `pad: ${padSeen}` : "pad: NONE — press a button on it",
        `frames sent ${framesSent}`,
        note,
      ]
        .filter(Boolean)
        .join("  ·  "),
    );
  }
  status();

  // The topology record, refreshed occasionally: the pair can change on an
  // ICE restart mid-run, and a stale line silently mislabels every sample
  // after it.
  let iceTimer: number | undefined;
  let lastIce = "";
  async function refreshIce() {
    const line = await icePairLine(rc.padLegRoom());
    if (stopped) return;
    if (line !== lastIce) {
      lastIce = line;
      status(line);
    }
  }
  void refreshIce();
  iceTimer = window.setInterval(() => void refreshIce(), 10_000);

  const onBlur = () => {
    paused = true;
    prevButtons = 0;
    // One neutral frame so nothing is left deflected while we cannot see
    // the pad. Fire-and-forget: the sharer's watchdog is the guarantee.
    void rc.sendPadFrame({ ...NEUTRAL_PAD }, sharerIdentity);
    status("window blurred — pad paused, neutral sent");
  };
  const onFocus = () => {
    paused = false;
    status();
  };
  window.addEventListener("blur", onBlur);
  window.addEventListener("focus", onFocus);

  const timer = window.setInterval(() => {
    if (stopped || paused) return;
    const gp = [...navigator.getGamepads()].find(Boolean);
    if (!gp) {
      if (padSeen) {
        // A pad that WAS here and vanished mid-run: neutralize, then wait.
        padSeen = undefined;
        prevButtons = 0;
        void rc.sendPadFrame({ ...NEUTRAL_PAD }, sharerIdentity);
      }
      status();
      return;
    }
    if (padSeen !== gp.id) {
      padSeen = gp.id;
      status();
    }

    const frame = readPad(gp);
    // Arm the probe BEFORE the frame is handed off, with the browser's own
    // stamp for when the pad state changed — `gp.timestamp` is on the same
    // clock as `performance.now()` and earlier than this tick, so using it
    // over the tick time removes up to one poll interval of arming error.
    for (const name of pressedEdges(prevButtons, frame.buttons)) {
      probe.press(gp.timestamp || performance.now(), `pad:${name}`);
    }
    prevButtons = frame.buttons;

    void rc.sendPadFrame(frame, sharerIdentity).then((sent) => {
      if (sent) {
        framesSent++;
        // Cheap cadence indicator without a render per tick.
        if (framesSent % 60 === 0) status();
      }
    });
  }, PAD_SEND_INTERVAL_MS);

  return {
    detach() {
      stopped = true;
      window.clearInterval(timer);
      if (iceTimer !== undefined) window.clearInterval(iceTimer);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      // Leave the sharer's virtual pad neutral rather than however the last
      // frame held it — same obligation `release_all` owes natively.
      void rc.sendPadFrame({ ...NEUTRAL_PAD }, sharerIdentity);
      probe.detach();
    },
  };
}
