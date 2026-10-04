import { onMount } from "solid-js";

/**
 * Brand balls dropped into the bag, in the logo's own colors. The logo's dark
 * blue is left out: it disappears against the dark rail.
 */
const BALLS = [
  { color: "#3BB8ED", dx: -3 },
  { color: "#CF2A27", dx: 2.6 },
  { color: "#E3CF1B", dx: -1.6 },
  { color: "#C05FC8", dx: 3 },
  { color: "#27A163", dx: -2.6 },
  { color: "#F5870D", dx: 1.6 },
];

/**
 * One ball lands every STEP seconds and each ball loops over the whole set,
 * so the bag's gulp (one per landing) runs on STEP and stays in time with the
 * balls without any script.
 */
const STEP = 0.8;
const CYCLE = STEP * BALLS.length;

const STYLE_SHEET = `
.sloga-support-ball {
  transform-box: fill-box;
  transform-origin: center;
  opacity: 0;
  animation: sloga-support-drop ${CYCLE}s linear infinite;
}
.sloga-support-bag {
  transform-box: view-box;
  transform-origin: 12px 22.6px;
  animation: sloga-support-gulp ${STEP}s ease-out infinite;
}
@keyframes sloga-support-drop {
  0% { opacity: 0; transform: translate(var(--sloga-support-dx), 0) scale(0.4); }
  5% { opacity: 1; transform: translate(var(--sloga-support-dx), 0) scale(1); animation-timing-function: ease-in; }
  27% { opacity: 1; transform: translate(0, 6.6px) scale(1); }
  33%, 100% { opacity: 0; transform: translate(0, 8.4px) scale(0.2); }
}
@keyframes sloga-support-gulp {
  0%, 55% { transform: scale(1); }
  68% { transform: scale(1.07, 0.94); }
  82% { transform: scale(0.98, 1.03); }
  100% { transform: scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .sloga-support-ball, .sloga-support-bag { animation: none; }
  .sloga-support-ball { opacity: 0; }
  .sloga-support-ball:nth-of-type(-n + 3) {
    opacity: 1;
    transform: translate(var(--sloga-support-dx), 2px);
  }
}`;

/**
 * Inject the keyframes once, shared by every copy of the icon on the page.
 */
let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected || typeof document === "undefined") return;
  stylesInjected = true;
  const el = document.createElement("style");
  el.setAttribute("data-sloga-support-icon", "");
  el.textContent = STYLE_SHEET;
  document.head.appendChild(el);
}

/**
 * Animated "Support Sloga" icon: the logo's colored balls drop one after
 * another into a money bag, which gulps as each one lands. Still under
 * reduced motion.
 */
export function SupportSlogaIcon(props: {
  /** Width and height in px (default 24) */
  size?: number;
  /** Bag color (default brand orange) */
  bag?: string;
  /** Color of the tie and the $ (default near-black) */
  sign?: string;
}) {
  onMount(ensureStyles);

  return (
    <svg
      viewBox="0 0 24 24"
      width={props.size ?? 24}
      height={props.size ?? 24}
      aria-hidden="true"
      style={{ "flex-shrink": 0 }}
    >
      {/* eslint-disable-next-line solid/prefer-for -- BALLS is a module-level
          constant; nothing here is reactive. */}
      {BALLS.map((ball, i) => (
        <circle
          class="sloga-support-ball"
          cx={12}
          cy={1.9}
          r={1.8}
          fill={ball.color}
          style={{
            "--sloga-support-dx": `${ball.dx}px`,
            // Negative delays start every ball mid-flight, so the first
            // frame already shows the stream instead of an empty sky.
            "animation-delay": `${-i * STEP}s`,
          }}
        />
      ))}
      <g class="sloga-support-bag">
        <g transform="translate(1.2 2.4) scale(0.9)">
          <path
            fill={props.bag ?? "#FF8A00"}
            d="M9.3 9 L7.7 5.9 Q9.9 6.9 12 6.4 Q14.1 6.9 16.3 5.9 L14.7 9 Z M9.2 9.6 C5.6 11.6 3.6 15 4.3 18.4 C4.9 21.3 7.9 22.6 12 22.6 C16.1 22.6 19.1 21.3 19.7 18.4 C20.4 15 18.4 11.6 14.8 9.6 Z"
          />
          <rect
            x={8.7}
            y={8.4}
            width={6.6}
            height={1.7}
            rx={0.85}
            fill={props.sign ?? "#05090F"}
          />
          <path
            fill="none"
            stroke={props.sign ?? "#05090F"}
            stroke-width={1.5}
            stroke-linecap="round"
            d="M14.3 14.3 C14 13.5 13.1 13.1 12 13.1 C10.7 13.1 9.8 13.7 9.8 14.7 C9.8 16.9 14.4 15.9 14.4 18.2 C14.4 19.3 13.4 19.9 12 19.9 C10.8 19.9 9.8 19.4 9.5 18.5 M12 11.9 V21.1"
          />
        </g>
      </g>
    </svg>
  );
}
