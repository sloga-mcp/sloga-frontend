/**
 * The DOM half of the press-to-photon probe. Lazy chunk: only imported when
 * `CONFIGURATION.RC_LATENCY_PROBE` is on, so a production bundle never
 * fetches it. All measurement logic lives in `rcLatencyProbe.ts`; this file
 * is wiring and a readout.
 *
 * The readout is drawn as a plain fixed `<div>` rather than a Solid
 * component, and that is deliberate: a RELEASE-configuration build has no
 * devtools and writes no log file, so `console.log` is unreachable in the
 * only configuration whose timings are worth trusting. The numbers have to be
 * on the glass. Keeping it out of the component tree also means this module
 * has no reactive dependencies to leak.
 */
import {
  DEFAULT_PROBE_CONFIG,
  PressToChange,
  type ProbeSample,
  sampleLuma,
  summarise,
} from "./rcLatencyProbe";

type VideoWithRVFC = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    cb: (now: number, meta: { expectedDisplayTime: number }) => void,
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

const SAMPLE_W = 32;
const SAMPLE_H = 18;

export type ProbeHandle = {
  detach: () => void;
  /**
   * Feed one actuation from OUTSIDE the DOM — the gamepad leg's rising
   * edges. Same arming path as a keydown, so the busy/settling refusals and
   * the miss accounting apply identically.
   */
  press: (pressAt: number, key: string) => void;
  /** Replace the persistent status line under the header (pad state, ICE pair). */
  status: (line: string | undefined) => void;
};

export type ProbeOptions = {
  /** Header label for what an actuation is. Default `"keydown"`. */
  pressLabel?: string;
  /**
   * Whether a window keydown arms the machine (default true). The gamepad
   * leg turns this OFF: on a pad-class session keydowns are not forwarded
   * at all, so arming on them would only manufacture misses. The F-key
   * controls keep working either way.
   */
  keydownArms?: boolean;
};

/**
 * Attach the probe to a screen-share tile.
 *
 * Keydown is taken on `window` in the capture phase with the SAME shape the
 * capture surface uses, so the probe sees exactly the events that get
 * forwarded — including when focus has drifted to `body`.
 */
export function attachProbe(
  video: HTMLVideoElement,
  opts: ProbeOptions = {},
): ProbeHandle {
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE_W;
  canvas.height = SAMPLE_H;
  // `willReadFrequently` — every frame does a `getImageData`, and without it
  // Chromium keeps the surface on the GPU and each readback stalls the
  // pipeline. That stall lands inside the measurement window.
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  // A mutable copy so F7/F8 can move the threshold mid-run: a busy game
  // scene needs more than the static-scene default, and rebuilding the rig
  // to change a constant is how a run ends up taken at the wrong one.
  // `PressToChange` holds its config by reference, so the edit takes effect
  // on the next frame.
  const config = { ...DEFAULT_PROBE_CONFIG };
  const machine = new PressToChange(config);
  const samples: ProbeSample[] = [];
  let misses = 0;
  let rejected = 0;
  let showAll = false;
  let statusLine: string | undefined;

  const readout = document.createElement("div");
  readout.setAttribute("data-rc-latency-probe", "");
  Object.assign(readout.style, {
    position: "fixed",
    top: "8px",
    left: "8px",
    zIndex: "2147483647",
    font: "12px/1.45 ui-monospace, Consolas, monospace",
    background: "rgba(8,8,12,0.9)",
    color: "#d8d8e0",
    border: "1px solid #3a3a48",
    borderRadius: "6px",
    padding: "8px 10px",
    whiteSpace: "pre",
    pointerEvents: "none",
    maxHeight: "90vh",
    overflow: "hidden",
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(readout);

  function render(note?: string) {
    const ms = samples.map((s) => s.ms);
    const stats = summarise(ms);
    const lines = [
      `RC press-to-photon probe  (${opts.pressLabel ?? "keydown"} → changed frame)`,
      `threshold ${config.threshold} (F7−/F8+)  ·  F9 reset  ·  F10 list  ·  misses ${misses}  rejected ${rejected}`,
    ];
    if (statusLine) lines.push(statusLine);
    if (!stats) {
      lines.push(
        "",
        `no samples yet — ${
          opts.pressLabel ? "actuate something" : "press a key"
        } that changes the screen`,
      );
    } else {
      lines.push(
        "",
        `n     ${stats.n}`,
        `min   ${stats.min.toFixed(1)} ms`,
        `p25   ${stats.p25.toFixed(1)} ms`,
        `p50   ${stats.p50.toFixed(1)} ms   <-- the number`,
        `p75   ${stats.p75.toFixed(1)} ms`,
        `p95   ${stats.p95.toFixed(1)} ms`,
        `max   ${stats.max.toFixed(1)} ms`,
        `mean  ${stats.mean.toFixed(1)} ms`,
      );
      const recent = samples.slice(-8).map((s) => s.ms.toFixed(0));
      lines.push("", `last 8: ${recent.join(" ")}`);
      if (showAll) {
        lines.push("", "all samples (ms, in order):");
        for (let i = 0; i < ms.length; i += 12) {
          lines.push(
            "  " + ms.slice(i, i + 12).map((v) => v.toFixed(0).padStart(4)).join(" "),
          );
        }
      }
    }
    if (note) lines.push("", note);
    readout.textContent = lines.join("\n");
  }
  render();

  // ---- frame loop --------------------------------------------------------

  const v = video as VideoWithRVFC;
  let rvfc: number | undefined;
  let raf: number | undefined;
  let stopped = false;

  /** Mirror of `machine.timeouts`, so growth in it can be reported. */
  let seenTimeouts = 0;

  function noteTimeouts() {
    if (machine.timeouts === seenTimeouts) return false;
    misses += machine.timeouts - seenTimeouts;
    seenTimeouts = machine.timeouts;
    return true;
  }

  function onSample(luma: number | undefined, displayAt: number) {
    if (luma === undefined) return;
    const sample = machine.onFrame(luma, displayAt);
    if (sample) {
      samples.push(sample);
      render();
    } else if (noteTimeouts()) {
      render("a press produced no visible change — counted as a miss");
    }
  }

  function pumpRVFC() {
    if (stopped || !v.requestVideoFrameCallback) return;
    rvfc = v.requestVideoFrameCallback((now, meta) => {
      // `expectedDisplayTime` is the compositor's estimate of scan-out, which
      // is the closest thing to a photon available in-page. Fall back to
      // `now` (the callback time) if a browser omits it — that is EARLIER
      // than display, so it under-reports rather than over-reports, and the
      // readout says which was used.
      onSample(ctx ? sampleLuma(v, canvas, ctx) : undefined, meta?.expectedDisplayTime ?? now);
      pumpRVFC();
    });
  }

  function pumpRAF() {
    if (stopped) return;
    raf = requestAnimationFrame((t) => {
      onSample(ctx ? sampleLuma(v, canvas, ctx) : undefined, t);
      pumpRAF();
    });
  }

  const usingRVFC = typeof v.requestVideoFrameCallback === "function";
  if (usingRVFC) pumpRVFC();
  else pumpRAF();

  // ---- press ------------------------------------------------------------

  /** One arming path for BOTH sources, so their accounting cannot diverge. */
  function armPress(pressAt: number, key: string) {
    const verdict = machine.onPress(pressAt, key);
    if (verdict === "armed") {
      render(`armed on "${key}" — waiting for the frame to change`);
    } else {
      rejected++;
      render(
        verdict === "settling"
          ? "ignored: scene has not returned to baseline yet — press slower"
          : verdict === "busy"
            ? "ignored: previous press still outstanding"
            : "ignored: no video frames sampled yet",
      );
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "F9") {
      samples.length = 0;
      misses = 0;
      rejected = 0;
      machine.reset();
      render("reset");
      return;
    }
    if (event.key === "F10") {
      showAll = !showAll;
      render();
      return;
    }
    // Threshold nudges, clamped to stay a usable detector: below 2 sensor
    // noise trips it on nothing (reporting a latency SHORTER than the
    // truth, the dangerous direction), and a run that needs more than 60
    // has no localized change to measure at all.
    if (event.key === "F7" || event.key === "F8") {
      config.threshold = Math.max(
        2,
        Math.min(60, config.threshold + (event.key === "F8" ? 1 : -1)),
      );
      render();
      return;
    }
    if (opts.keydownArms === false) return;
    // Auto-repeat is not an actuation.
    if (event.repeat) return;
    // `event.timeStamp`, not `performance.now()`: the former is when the
    // event happened, the latter is when this handler got to run. On a busy
    // renderer that difference is several ms of pure measurement error, and
    // it biases the result LOW-to-HIGH unpredictably.
    armPress(event.timeStamp, event.key);
  }
  window.addEventListener("keydown", onKeyDown, true);

  // A press whose change never arrives has to be counted, or a run that
  // silently drops half its presses looks like a clean run with fewer
  // samples. Polled rather than timed off the press so a total video stall
  // still resolves.
  const sweep = window.setInterval(() => {
    // Wall-clock, because a total video stall delivers no frames at all and
    // the frame-time timeout inside `onFrame` therefore never runs. Without
    // this an armed press would block every later press for the rest of the
    // session, and the run would end with a plausible-looking handful of
    // samples taken before the stall.
    if (machine.checkTimeout(performance.now()) && noteTimeouts()) {
      render("press timed out with no frames at all — video feed stalled?");
    }
  }, 250);

  render(
    usingRVFC
      ? undefined
      : "requestVideoFrameCallback unavailable — using rAF, timings UNDER-report",
  );

  return {
    detach() {
      stopped = true;
      window.removeEventListener("keydown", onKeyDown, true);
      window.clearInterval(sweep);
      if (rvfc !== undefined) v.cancelVideoFrameCallback?.(rvfc);
      if (raf !== undefined) cancelAnimationFrame(raf);
      machine.reset();
      readout.remove();
    },
    press(pressAt, key) {
      if (stopped) return;
      armPress(pressAt, key);
    },
    status(line) {
      statusLine = line;
      render();
    },
  };
}
