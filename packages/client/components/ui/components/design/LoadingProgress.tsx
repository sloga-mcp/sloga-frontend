import { onMount } from "solid-js";

import { cva } from "styled-system/css";
import { styled } from "styled-system/jsx";

/**
 * Sloga brand palette — sampled from the "O" logo (assets/web/sloga-icon.png).
 * Green core in the middle, each satellite its own color, clockwise from top.
 */
const GREEN = "#27A163";
const DOT_COLORS = [
  "#3BB8ED",
  "#F5870D",
  "#CF2A27",
  "#E3CF1B",
  "#3BB8ED",
  "#F5870D",
  "#2B2BD8",
  "#C05FC8",
];

/**
 * Geometry in a 512×512 viewBox. The resting ring of the brand animation is
 * slightly tighter than the static mark (ring 121 vs 148, balls 40 vs 44).
 */
const CENTER = 256;
const RING_RADIUS = 121;
const CORE_RADIUS = 52;
const BALL_RADIUS = 40;

/**
 * Master timeline (percent of one 5.6s loop), traced frame-by-frame from the
 * brand animation video ("Sloga O Mark.mp4"):
 *  - a still beat with everything tucked inside the green core,
 *  - all eight balls burst out together, spiralling ~253° clockwise with a
 *    strong ease-out while they grow to full size,
 *  - the ring holds perfectly still,
 *  - the balls unwind counter-clockwise and get pulled back into the core
 *    (the burst in reverse, slightly faster),
 *  - the core swells as it swallows them, then settles before the loop repeats.
 */
const IDLE_END = 11.6;
const OUT_END = 40.2;
const HOLD_END = 62.5;
const IN_END = 79.5;
const PULSE_START = 83;
const PULSE_PEAK = 91;
const PULSE_END = 99;

/** Degrees each ball spirals while bursting out (and unwinds coming back). */
const SPIN = 253;

/**
 * Motion curves sampled from the video. Each entry is
 * [fraction of the phase, angle progress 0..1, ring radius, ball scale].
 * The return leg is not a plain mirror of the burst — it pulls in and
 * unwinds harder mid-phase — so it gets its own samples.
 */
const OUT_CURVE: [number, number, number, number][] = [
  [0, 0, CORE_RADIUS, 0],
  [0.06, 0, 64, 0.4],
  [0.16, 0.27, 76, 0.65],
  [0.25, 0.46, 84, 0.79],
  [0.34, 0.64, 92, 0.94],
  [0.44, 0.74, 99, 0.98],
  [0.53, 0.85, 107, 1],
  [0.63, 0.9, 113, 1],
  [0.72, 0.96, 116, 1],
  [0.81, 0.98, 119, 1],
  [0.91, 1, 120, 1],
  [1, 1, RING_RADIUS, 1],
];

const IN_CURVE: [number, number, number, number][] = [
  [0, 1, RING_RADIUS, 1],
  [0.105, 0.97, 119, 1],
  [0.26, 0.92, 114, 1],
  [0.42, 0.79, 103, 1],
  [0.58, 0.61, 90, 0.92],
  [0.74, 0.26, 75, 0.63],
  [0.89, 0.02, 62, 0.35],
  [1, 0, CORE_RADIUS, 0],
];

/**
 * One transform stop for a ball. Every ball shares the same keyframes; its
 * resting direction comes in via --sloga-ball-angle so a single @keyframes
 * rule animates all eight.
 */
function ballTransform(angleProgress: number, r: number, s: number) {
  const offset = -SPIN * (1 - angleProgress);
  return `transform: rotate(calc(var(--sloga-ball-angle) + ${offset}deg)) translateY(-${r}px) scale(${s});`;
}

const HIDDEN = ballTransform(0, CORE_RADIUS, 0);

const ballStops: string[] = [`  0% { ${HIDDEN} }`];
for (const [p, ap, r, s] of OUT_CURVE) {
  const pct = IDLE_END + (OUT_END - IDLE_END) * p;
  ballStops.push(`  ${pct.toFixed(1)}% { ${ballTransform(ap, r, s)} }`);
}
for (const [p, ap, r, s] of IN_CURVE) {
  const pct = HOLD_END + (IN_END - HOLD_END) * p;
  ballStops.push(`  ${pct.toFixed(1)}% { ${ballTransform(ap, r, s)} }`);
}
ballStops.push(`  100% { ${HIDDEN} }`);

const STYLE_SHEET = `
@keyframes sloga-ball {
${ballStops.join("\n")}
}
@keyframes sloga-core-pulse {
  0%, ${PULSE_START}% { transform: scale(1); animation-timing-function: ease-in-out; }
  ${PULSE_PEAK}% { transform: scale(1.16); animation-timing-function: ease-in-out; }
  ${PULSE_END}%, 100% { transform: scale(1); }
}
.sloga-loader .sloga-core {
  transform-box: view-box;
  transform-origin: ${CENTER}px ${CENTER}px;
  animation: sloga-core-pulse var(--sloga-loader-duration, 5.6s) linear infinite;
}
.sloga-loader .sloga-ball {
  transform-box: view-box;
  transform-origin: ${CENTER}px ${CENTER}px;
  will-change: transform;
  animation: sloga-ball var(--sloga-loader-duration, 5.6s) linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .sloga-loader .sloga-core { animation: none; }
  .sloga-loader .sloga-ball {
    animation: none;
    transform: rotate(var(--sloga-ball-angle)) translateY(-${RING_RADIUS}px);
  }
}`;

/**
 * One-shot "click" keyframes for the home wordmark's O, built from the very same
 * motion curves traced from the brand video — only rearranged. Instead of the
 * loader's idle → burst → hold → unwind, the balls first unwind *into* the green
 * core, the core gulps, then they burst back *out* to reform the ring. Because it
 * starts and ends on the resting ring, it drops seamlessly onto the static logo.
 *
 * `name` scopes the @keyframes; `geo` rescales the loader's radii to the smaller
 * wordmark ring so a single set of curves serves both sizes.
 */
export function slogaBurstKeyframes(
  name: string,
  geo: { core: number; ring: number },
): string {
  const rescale = (r: number) =>
    geo.core +
    ((r - CORE_RADIUS) / (RING_RADIUS - CORE_RADIUS)) * (geo.ring - geo.core);
  const tf = (angleProgress: number, r: number, s: number) => {
    const offset = -SPIN * (1 - angleProgress);
    return `transform: rotate(calc(var(--sloga-ball-angle) + ${offset.toFixed(1)}deg)) translateY(-${rescale(r).toFixed(2)}px) scale(${s});`;
  };

  // Balls unwind in over the first 42%, rest hidden in the core while it gulps,
  // then burst back out over the final 42%.
  const IN_STOP = 42;
  const OUT_START = 58;
  const stops: string[] = [];
  for (const [p, ap, r, s] of IN_CURVE) {
    stops.push(`  ${(IN_STOP * p).toFixed(1)}% { ${tf(ap, r, s)} }`);
  }
  for (const [p, ap, r, s] of OUT_CURVE) {
    const pct = OUT_START + (100 - OUT_START) * p;
    stops.push(`  ${pct.toFixed(1)}% { ${tf(ap, r, s)} }`);
  }

  return `
@keyframes ${name}-ball {
${stops.join("\n")}
}
@keyframes ${name}-core {
  0%, 34% { transform: scale(1); animation-timing-function: ease-in-out; }
  50% { transform: scale(1.18); animation-timing-function: ease-in-out; }
  66%, 100% { transform: scale(1); }
}`;
}

/**
 * Inject the keyframes once, shared across every spinner on the page.
 */
let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected || typeof document === "undefined") return;
  stylesInjected = true;
  const el = document.createElement("style");
  el.setAttribute("data-sloga-loader", "");
  el.textContent = STYLE_SHEET;
  document.head.appendChild(el);
}

/**
 * Progress indicators express an unspecified wait time or display the duration of a process.
 *
 * Renders the animated Sloga "O" logo, matching the brand animation video: the
 * colored balls burst out of the green core in a clockwise spiral, rest as the
 * logo ring, unwind back inside, and the core gulps as it takes them in.
 */
export function CircularProgress(props: { size?: number }) {
  onMount(ensureStyles);

  return (
    <Base>
      <svg
        class={`sloga-loader ${loader()}`}
        viewBox="0 0 512 512"
        width={props.size ?? 48}
        height={props.size ?? 48}
        role="img"
        aria-label="Loading"
      >
        {DOT_COLORS.map((color, i) => (
          <circle
            class="sloga-ball"
            cx={CENTER}
            cy={CENTER}
            r={BALL_RADIUS}
            fill={color}
            style={{ "--sloga-ball-angle": `${i * 45}deg` }}
          />
        ))}
        <circle
          class="sloga-core"
          cx={CENTER}
          cy={CENTER}
          r={CORE_RADIUS}
          fill={GREEN}
        />
      </svg>
    </Base>
  );
}

const Base = styled("div", {
  base: {
    position: "relative",
    width: "100%",
    height: "100%",
    minWidth: "40px",
    minHeight: "40px",
  },
});

const loader = cva({
  base: {
    position: "absolute",
    left: "50%",
    top: "50%",
    transform: "translate(-50%, -50%)",
  },
});
