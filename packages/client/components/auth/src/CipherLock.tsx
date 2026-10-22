import { onMount } from "solid-js";

/**
 * The logo's ring, clockwise from the top, with each dot's offset to the
 * center (where it starts and ends every loop).
 */
const RING = [
  { cx: 50, cy: 22.5, color: "#3BB8ED" },
  { cx: 69.5, cy: 30.5, color: "#F5870D" },
  { cx: 77.5, cy: 50, color: "#CF2A27" },
  { cx: 69.5, cy: 69.5, color: "#E3CF1B" },
  { cx: 50, cy: 77.5, color: "#3BB8ED" },
  { cx: 30.5, cy: 69.5, color: "#F5870D" },
  { cx: 22.5, cy: 50, color: "#2B2BD8" },
  { cx: 30.5, cy: 30.5, color: "#C05FC8" },
];

const GREEN = "#27A163";

/** One loop: the ring settles, the core becomes a padlock, holds, resets */
const CYCLE = 8;

const STYLE_SHEET = `
.sloga-cipher-dot {
  transform-box: fill-box;
  transform-origin: center;
  animation: sloga-cipher-dot ${CYCLE}s cubic-bezier(0.22, 1.1, 0.4, 1) infinite;
}
.sloga-cipher-core {
  transform-box: fill-box;
  transform-origin: center;
  animation: sloga-cipher-core ${CYCLE}s ease infinite;
}
.sloga-cipher-lock {
  transform-box: fill-box;
  transform-origin: center bottom;
  animation: sloga-cipher-lock ${CYCLE}s ease infinite;
}
.sloga-cipher-shackle {
  animation: sloga-cipher-shackle ${CYCLE}s ease-in infinite;
}
.sloga-cipher-ping {
  transform-box: fill-box;
  transform-origin: center;
  opacity: 0;
  animation: sloga-cipher-ping ${CYCLE}s ease-out infinite;
}
@keyframes sloga-cipher-dot {
  0% { transform: translate(var(--sloga-cipher-dx), var(--sloga-cipher-dy)) scale(0.2); opacity: 0; }
  18%, 82% { transform: none; opacity: 1; }
  94% { transform: translate(calc(var(--sloga-cipher-dx) * -0.25), calc(var(--sloga-cipher-dy) * -0.25)) scale(0.9); opacity: 0.6; }
  100% { transform: translate(var(--sloga-cipher-dx), var(--sloga-cipher-dy)) scale(0.2); opacity: 0; }
}
@keyframes sloga-cipher-core {
  0%, 26% { transform: scale(1); opacity: 1; }
  33%, 86% { transform: scale(0); opacity: 0; }
  94%, 100% { transform: scale(1); opacity: 1; }
}
@keyframes sloga-cipher-lock {
  0%, 32% { opacity: 0; transform: scale(0.7); }
  40%, 84% { opacity: 1; transform: none; }
  90%, 100% { opacity: 0; transform: scale(0.85); }
}
@keyframes sloga-cipher-shackle {
  0%, 44% { transform: translateY(-4px); }
  48%, 100% { transform: none; }
}
@keyframes sloga-cipher-ping {
  0%, 48% { opacity: 0; transform: scale(0.8); }
  50% { opacity: 0.7; }
  64%, 100% { opacity: 0; transform: scale(1.6); }
}
@media (prefers-reduced-motion: reduce) {
  .sloga-cipher-dot, .sloga-cipher-core, .sloga-cipher-lock, .sloga-cipher-shackle, .sloga-cipher-ping { animation: none; }
  .sloga-cipher-core { opacity: 0; }
}`;

/**
 * Inject the keyframes once, shared by every copy of the lock on the page.
 */
let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected || typeof document === "undefined") return;
  stylesInjected = true;
  const el = document.createElement("style");
  el.setAttribute("data-sloga-cipher-lock", "");
  el.textContent = STYLE_SHEET;
  document.head.appendChild(el);
}

/**
 * The Sloga logo locking itself, on a loop: the ring dots settle into place,
 * the green core turns into a padlock and its shackle clicks shut, it holds,
 * then everything eases back to the center. Still under reduced motion.
 */
export function CipherLock(props: {
  /** Width and height in px */
  size: number;
}) {
  onMount(ensureStyles);

  return (
    <svg
      viewBox="0 0 100 100"
      width={props.size}
      height={props.size}
      aria-hidden="true"
      style={{ overflow: "visible", "flex-shrink": 0 }}
    >
      {/* eslint-disable-next-line solid/prefer-for -- RING is a module-level
          constant; nothing here is reactive. */}
      {RING.map((dot, i) => (
        <circle
          class="sloga-cipher-dot"
          cx={dot.cx}
          cy={dot.cy}
          r={10}
          fill={dot.color}
          style={{
            "--sloga-cipher-dx": `${50 - dot.cx}px`,
            "--sloga-cipher-dy": `${50 - dot.cy}px`,
            "animation-delay": `${(i * 0.09).toFixed(2)}s`,
          }}
        />
      ))}
      <circle class="sloga-cipher-core" cx={50} cy={50} r={14.5} fill={GREEN} />
      <circle
        class="sloga-cipher-ping"
        cx={50}
        cy={55}
        r={16}
        fill="none"
        stroke={GREEN}
        stroke-width={1.4}
      />
      <g class="sloga-cipher-lock">
        <path
          class="sloga-cipher-shackle"
          d="M43.6 49v-4.6a6.4 6.4 0 0 1 12.8 0V49"
          fill="none"
          stroke="var(--md-sys-color-on-surface)"
          stroke-width={4.2}
          stroke-linecap="round"
        />
        <rect x={39.5} y={47.5} width={21} height={16} rx={3.5} fill={GREEN} />
      </g>
    </svg>
  );
}
