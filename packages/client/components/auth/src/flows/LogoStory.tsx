import { onCleanup, onMount } from "solid-js";

/**
 * Animated Sloga logo — Solid port of the website's brand animation
 * (sloga-website/logo-anim.js "hero logo story"): the letters start in the
 * brand colors, the colors drain out as balls and merge into the green O,
 * then the ring bursts out clockwise. Plays once on mount; click to replay.
 * Respects prefers-reduced-motion (renders the settled frame).
 *
 * Differences from the website version: no "Hop on" tagline (the auth card
 * has its own copy directly below) and no frozen-frame debug hook.
 */

const GREEN = "#27A163";
// Ring, clockwise from top (matches the static SVG's circle order)
const RING = [
  "#3BB8ED",
  "#F5870D",
  "#CF2A27",
  "#E3CF1B",
  "#3BB8ED",
  "#F5870D",
  "#2B2BD8",
  "#C05FC8",
];
// Letter base colors: S, l, g, a
const LETTER_COLORS: [number, number, number][] = [
  [59, 184, 237],
  [245, 135, 13],
  [207, 42, 39],
  [192, 95, 200],
];

// Timeline (seconds) — same beats as the brand animation
const T_IN = 0.2;
const DRAIN = [2.3, 2.45, 2.6, 2.75];
const DRAIN_DUR = 0.95;
const T_BURST = 3.95;
const T_PULSE = 5.7;
const DUR = 7.2;

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}
function easeOutQuad(t: number) {
  return t * (2 - t);
}
function easeOutCubic(t: number) {
  return --t * t * t + 1;
}
function easeInOutQuad(t: number) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}
function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1;
}
function tween(
  from: number,
  to: number,
  start: number,
  end: number,
  ease: (t: number) => number,
  t: number,
) {
  if (t <= start) return from;
  if (t >= end) return to;
  return from + (to - from) * ease((t - start) / (end - start));
}
function mix(a: number[], b: number[], p: number) {
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * p)},${Math.round(
    a[1] + (b[1] - a[1]) * p,
  )},${Math.round(a[2] + (b[2] - a[2]) * p)})`;
}
function parseRgb(str: string) {
  const m = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(str || "");
  return m ? [+m[1], +m[2], +m[3]] : [236, 238, 242];
}

export function LogoStory() {
  let container: HTMLDivElement | undefined;

  onMount(() => {
    if (!container) return;
    const reducedMotion =
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Drain to the color the letters actually sit on (the auth card's
    // on-surface text color), not document.body which the theme never styles.
    const textColor = () =>
      parseRgb(getComputedStyle(container!).color);

    const lockup = document.createElement("div");
    lockup.style.cssText = "position:relative;display:flex;align-items:center;";

    const letterSpan = (ch: string) => {
      const el = document.createElement("span");
      el.textContent = ch;
      el.style.cssText =
        "font-family:'Figtree','Segoe UI',sans-serif;font-weight:700;line-height:1;white-space:pre;";
      return el;
    };
    const letters = [
      letterSpan("S"),
      letterSpan("l"),
      letterSpan("g"),
      letterSpan("a"),
    ];

    const mark = document.createElement("div");
    mark.style.cssText = "position:relative;";
    const dots = RING.map((color) => {
      const d = document.createElement("div");
      d.style.cssText = `position:absolute;border-radius:50%;background:${color};`;
      mark.appendChild(d);
      return d;
    });
    const center = document.createElement("div");
    center.style.cssText = `position:absolute;border-radius:50%;background:${GREEN};`;
    mark.appendChild(center);

    lockup.appendChild(letters[0]);
    lockup.appendChild(letters[1]);
    lockup.appendChild(mark);
    lockup.appendChild(letters[2]);
    lockup.appendChild(letters[3]);
    container.appendChild(lockup);

    const balls = LETTER_COLORS.map((c) => {
      const b = document.createElement("div");
      b.style.cssText = `position:absolute;border-radius:50%;display:none;background:rgb(${c.join(",")});`;
      container!.appendChild(b);
      return b;
    });

    let F = 96;
    let s = F / 180; // font size + scale factor vs the 180px design

    function applySizes() {
      const w = container!.clientWidth || 340;
      F = clamp(w / 6.5, 40, 72);
      s = F / 180;
      container!.style.minHeight = `${F * 1.2}px`;
      letters.forEach((el, i) => {
        el.style.fontSize = `${i === 1 ? 176 * s : F}px`;
        el.style.letterSpacing = `${-4 * s}px`;
      });
      mark.style.height = `${150 * s}px`;
      mark.style.margin = `${16 * s}px ${4 * s}px 0 ${8 * s}px`;
      dots.forEach((d) => {
        d.style.width = d.style.height = `${36 * s}px`;
      });
      center.style.width = center.style.height = `${46 * s}px`;
      center.style.top = `${52 * s}px`;
      balls.forEach((b) => {
        b.style.width = b.style.height = `${36 * s}px`;
      });
    }

    let drainTarget = textColor();
    let rafId: number | null = null;
    let finished = false;

    function render(t: number) {
      // Word entrance
      lockup.style.opacity = String(tween(0, 1, T_IN, T_IN + 0.6, easeOutQuad, t));
      lockup.style.transform = `translateY(${tween(14 * s, 0, T_IN, T_IN + 0.7, easeOutCubic, t)}px)`;

      // Letter colors drain to the page text color as each ball departs
      letters.forEach((el, i) => {
        const p = clamp((t - (DRAIN[i] + 0.05)) / 0.55, 0, 1);
        el.style.color = mix(LETTER_COLORS[i], drainTarget, easeInOutQuad(p));
      });

      // Green O: swell while absorbing, pulse at the end
      let oScale = 1;
      if (t > 3.15 && t < 3.95)
        oScale = 1 + 0.22 * Math.sin(((t - 3.15) / 0.8) * Math.PI);
      if (t > T_PULSE && t < T_PULSE + 0.9)
        oScale = 1 + 0.1 * Math.sin(((t - T_PULSE) / 0.9) * Math.PI);
      center.style.transform = `scale(${oScale})`;

      // Compact lockup until the ring appears, then expand to make room
      const markW = tween(62 * s, 150 * s, T_BURST - 0.1, T_BURST + 0.9, easeInOutCubic, t);
      mark.style.width = `${markW}px`;
      const cx = markW / 2;
      center.style.left = `${cx - 23 * s}px`;

      // Ring bursts out of the O, one clockwise turn
      const burstP = easeOutCubic(clamp((t - T_BURST) / 1.4, 0, 1));
      dots.forEach((d, i) => {
        const theta = ((i * 45 - 360 * (1 - burstP)) * Math.PI) / 180;
        const r = 53 * s * burstP;
        d.style.left = `${cx + r * Math.sin(theta) - 18 * s}px`;
        d.style.top = `${75 * s - r * Math.cos(theta) - 18 * s}px`;
        d.style.transform = `scale(${clamp(burstP * 3, 0, 1)})`;
      });

      // Travelling drain balls (letter centre -> O centre, arcing up)
      const cRect = container!.getBoundingClientRect();
      const mRect = mark.getBoundingClientRect();
      const ox = mRect.left + mRect.width / 2 - cRect.left;
      const oy = mRect.top + mRect.height / 2 - cRect.top;
      balls.forEach((b, i) => {
        const p = clamp((t - DRAIN[i]) / DRAIN_DUR, 0, 1);
        if (p <= 0 || p >= 1) {
          b.style.display = "none";
          return;
        }
        const lr = letters[i].getBoundingClientRect();
        const fx = lr.left + lr.width / 2 - cRect.left;
        const fy = lr.top + lr.height / 2 - cRect.top;
        const e = easeInOutCubic(p);
        const x = fx + (ox - fx) * e;
        const y = fy + (oy - fy) * e - 70 * s * Math.sin(Math.PI * e);
        let sc = 1;
        if (p < 0.18) sc = p / 0.18;
        else if (p > 0.82) sc = (1 - p) / 0.18;
        b.style.display = "block";
        b.style.left = `${x - 18 * s}px`;
        b.style.top = `${y - 18 * s}px`;
        b.style.transform = `scale(${sc})`;
      });
    }

    function play() {
      if (rafId) cancelAnimationFrame(rafId);
      finished = false;
      drainTarget = textColor();
      let t0: number | null = null; // clock starts at the first painted frame
      const frame = (now: number) => {
        if (t0 === null) t0 = now;
        const t = (now - t0) / 1000;
        if (t >= DUR) {
          render(DUR);
          finished = true;
          rafId = null;
          return;
        }
        render(t);
        rafId = requestAnimationFrame(frame);
      };
      rafId = requestAnimationFrame(frame);
    }

    applySizes();
    render(reducedMotion ? DUR : 0);

    if (reducedMotion) {
      finished = true;
      render(DUR);
    } else {
      // Wait for fonts so letter measurement and rendering are correct
      let started = false;
      const start = () => {
        if (!started) {
          started = true;
          applySizes();
          play();
        }
      };
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(start);
        setTimeout(start, 1500); // fallback if the font promise stalls
      } else {
        start();
      }
      container.style.cursor = "pointer";
      container.title = "Replay";
      container.addEventListener("click", () => {
        if (finished) play();
      });
    }

    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
              applySizes();
              if (finished) render(DUR);
            }, 120);
          })
        : undefined;
    ro?.observe(container);

    onCleanup(() => {
      if (rafId) cancelAnimationFrame(rafId);
      ro?.disconnect();
      clearTimeout(resizeTimer);
    });
  });

  return (
    <div
      ref={container}
      style={{
        position: "relative",
        width: "100%",
        display: "flex",
        "justify-content": "center",
      }}
    />
  );
}
