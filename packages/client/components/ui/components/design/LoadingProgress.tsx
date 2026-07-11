import { onMount } from "solid-js";

import { cva } from "styled-system/css";
import { styled } from "styled-system/jsx";

/**
 * Sloga brand palette — sampled from the "O" logo (assets/web/sloga-icon.png).
 * Green core in the middle, orange on the cardinals, blue on the diagonals.
 */
const GREEN = "#3ABF7E";
const ORANGE = "#FF8A00";
const BLUE = "#00B2FF";

/**
 * Logo geometry in a 512×512 viewBox (matches assets/web/monochrome.svg):
 * a green core with eight satellites evenly spaced on a ring around it.
 */
const CENTER = 256;
const RING_RADIUS = 148; // centre → satellite distance
const CORE_RADIUS = 52;
const BALL_RADIUS = 44;

/**
 * The eight satellites. Orange sits on the cardinals (top/right/bottom/left),
 * blue on the diagonals — exactly like the logo. `sweep` is the fan-out order,
 * starting on the right (90°) and going clockwise so the balls appear to stream
 * out of the core on the right side and chase each other around the ring.
 */
const BALLS = Array.from({ length: 8 }, (_, i) => {
  const angle = i * 45; // clockwise from the top
  return {
    i,
    angle,
    color: i % 2 === 0 ? ORANGE : BLUE,
    sweep: ((angle - 90 + 360) % 360) / 45,
  };
});

/**
 * Master timeline (percent of one loop):
 *  - a brief "everything tucked inside the green core" beat at both ends,
 *  - a staggered fan-out from the core to the ring,
 *  - one shared full rotation while extended,
 *  - a staggered fan-in back into the core,
 * so the animation visibly collapses into the green ball before it repeats.
 */
const EMERGE_START = 6;
const EMERGE_STAGGER = 2.5;
const EMERGE_DUR = 13;
const RETRACT_START = 66;
const RETRACT_STAGGER = 2.5;
const RETRACT_DUR = 13;

const POP = "cubic-bezier(0.34, 1.56, 0.64, 1)"; // slight overshoot on the way out
const SUCK = "cubic-bezier(0.5, 0, 0.75, 0)"; // accelerate on the way back in

const ballKeyframes = BALLS.map((b) => {
  const emergeStart = EMERGE_START + b.sweep * EMERGE_STAGGER;
  const emergeEnd = emergeStart + EMERGE_DUR;
  const retractStart = RETRACT_START + b.sweep * RETRACT_STAGGER;
  const retractEnd = retractStart + RETRACT_DUR;

  // Inside the core (hidden under the green ball) vs. out on the ring.
  const inCore = `transform: rotate(${b.angle}deg) translateY(0) scale(0);`;
  const onRing = `transform: rotate(${b.angle}deg) translateY(-${RING_RADIUS}px) scale(1);`;

  return `@keyframes sloga-ball-${b.i} {
  0%, ${emergeStart}% { ${inCore} animation-timing-function: ${POP}; }
  ${emergeEnd}%, ${retractStart}% { ${onRing} animation-timing-function: ${SUCK}; }
  ${retractEnd}%, 100% { ${inCore} }
}`;
}).join("\n");

const STYLE_SHEET = `
@keyframes sloga-ring-spin { to { transform: rotate(360deg); } }
${ballKeyframes}
.sloga-loader .sloga-ring {
  transform-box: view-box;
  transform-origin: ${CENTER}px ${CENTER}px;
  animation: sloga-ring-spin var(--sloga-loader-duration, 2.6s) linear infinite;
}
.sloga-loader .sloga-ball {
  transform-box: view-box;
  transform-origin: ${CENTER}px ${CENTER}px;
  will-change: transform;
  animation-name: var(--sloga-ball-name);
  animation-duration: var(--sloga-loader-duration, 2.6s);
  animation-timing-function: linear;
  animation-iteration-count: infinite;
}
@media (prefers-reduced-motion: reduce) {
  .sloga-loader .sloga-ring { animation: none; }
  .sloga-loader .sloga-ball {
    animation: none;
    transform: rotate(var(--sloga-ball-angle)) translateY(-${RING_RADIUS}px);
  }
}`;

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
 * Renders the animated Sloga "O" logo: the green core stays put while the orange
 * and blue balls fan out of it, orbit around it once, then get pulled back in.
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
        <g class="sloga-ring">
          {BALLS.map((b) => (
            <circle
              class="sloga-ball"
              cx={CENTER}
              cy={CENTER}
              r={BALL_RADIUS}
              fill={b.color}
              style={{
                "--sloga-ball-name": `sloga-ball-${b.i}`,
                "--sloga-ball-angle": `${b.angle}deg`,
              }}
            />
          ))}
        </g>
        <circle cx={CENTER} cy={CENTER} r={CORE_RADIUS} fill={GREEN} />
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
