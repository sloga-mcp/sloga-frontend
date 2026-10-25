import { For, Show, createMemo } from "solid-js";
import { Portal } from "solid-js/web";

import { styled } from "styled-system/jsx";

import { useClientLifecycle } from "@revolt/client";
import { State, TransitionType } from "@revolt/client/Controller";

import { titleBarStatusSlot } from "./desktop/MainTitleBar";

/**
 * The eight orbiting dots of the Sloga mark, taken verbatim from
 * `scripts/assets_fallback/web/favicon.svg`, so this is the brand mark itself
 * rather than an approximation of it. The centre dot is drawn separately
 * because it carries the state colour.
 */
const ORBIT = [
  { cx: 50, cy: 22.5, fill: "#3BB8ED" },
  { cx: 69.5, cy: 30.5, fill: "#F5870D" },
  { cx: 77.5, cy: 50, fill: "#CF2A27" },
  { cx: 69.5, cy: 69.5, fill: "#E3CF1B" },
  { cx: 50, cy: 77.5, fill: "#3BB8ED" },
  { cx: 30.5, cy: 69.5, fill: "#F5870D" },
  { cx: 22.5, cy: 50, fill: "#2B2BD8" },
  { cx: 30.5, cy: 30.5, fill: "#C05FC8" },
];

/** Brand green, the mark's own core colour. */
const CORE_OK = "#27A163";

/**
 * One full pulse. The per-dot stagger is deliberately DUR_MS / ORBIT.length —
 * the last dot begins exactly as the first one restarts, so the wave wraps
 * seamlessly instead of stuttering once per cycle.
 */
const DUR_MS = 1200;

/**
 * Connection state, drawn as the brand mark instead of a bar.
 *
 * Four things here are deliberate:
 *
 * 1. `position: fixed`, reserving NO layout space. The full-width bar this
 *    replaces is what exposed the MainBar containing-block bug — anything that
 *    changes the height of the app column can push absolutely positioned
 *    descendants off the bottom of the screen. An overlay cannot.
 * 2. A real `<button>`. Recovery is automatic now that the `online` event is
 *    wired up, but WebViews are not uniformly reliable about firing it, so the
 *    manual retry stays as the backstop — it was the ONLY escape from the
 *    offline state until that listener existed.
 * 3. Transient and lost do not look alike. An indicator that means both "hang
 *    on" and "your network is gone" cannot tell you whether to go check your
 *    router, so the dots chase while there is hope, and drain to grey around a
 *    red core once there is not.
 * 4. The greyscale filter wraps ONLY the orbit. Applied to the whole mark it
 *    desaturated the red core too, and the lost state lost the one colour that
 *    was carrying its meaning.
 *
 * While the desktop main window draws its own title bar (MainTitleBar), the
 * fixed dot is not shown: the same mark, states and retry sit inline in the
 * bar's status slot instead, portalled there from this tree, which has the
 * client lifecycle the bar's own root lacks. The slot exists exactly while
 * the bar is drawn, so the dot comes back the moment the bar goes. Web,
 * Android, iOS and Linux never have the bar and always get the dot.
 */
export function ConnectionIndicator() {
  const { lifecycle } = useClientLifecycle();

  const visible = createMemo(() =>
    [
      State.Connecting,
      State.Disconnected,
      State.Reconnecting,
      State.Offline,
    ].includes(lifecycle.state()),
  );

  /** Trouble the user may have to act on, versus trouble that clears itself. */
  const lost = createMemo(
    () =>
      lifecycle.state() === State.Disconnected ||
      lifecycle.state() === State.Offline,
  );

  const label = createMemo(() => {
    switch (lifecycle.state()) {
      case State.Connecting:
        return "Connecting";
      case State.Reconnecting:
        return "Reconnecting";
      case State.Offline:
        return "Device is offline — tap to retry";
      default:
        return "Disconnected — tap to retry";
    }
  });

  // SMIL animation ignores prefers-reduced-motion, so the <animate> elements
  // are simply not rendered when it is set; the state stays legible in colour.
  const still =
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const retry = () => lifecycle.transition({ type: TransitionType.Retry });

  /** The mark, drawn for the state; a fresh copy on every call. */
  const mark = () => (
    <svg viewBox="0 0 100 100" width="100%" height="100%">
      <g style={lost() ? { filter: "grayscale(1)", opacity: 0.55 } : undefined}>
        <For each={ORBIT}>
          {(dot, i) => (
            <circle cx={dot.cx} cy={dot.cy} r="10" fill={dot.fill}>
              <Show when={!still && !lost()}>
                {/* Staggered around the ring so the shrink reads as one
                    wave travelling the orbit, not eight dots blinking at
                    once. */}
                <animate
                  attributeName="r"
                  values="10;5.5;10"
                  dur={`${DUR_MS / 1000}s`}
                  begin={`${((i() * DUR_MS) / ORBIT.length / 1000).toFixed(3)}s`}
                  repeatCount="indefinite"
                />
              </Show>
            </circle>
          )}
        </For>
      </g>
      <circle
        cx="50"
        cy="50"
        r="14.5"
        fill={lost() ? "var(--md-sys-color-error)" : CORE_OK}
      />
    </svg>
  );

  return (
    <Show
      when={titleBarStatusSlot()}
      keyed
      fallback={
        <Show when={visible()}>
          <Dock
            lost={lost()}
            type="button"
            title={label()}
            aria-label={label()}
            role="status"
            aria-live="polite"
            onClick={retry}
          >
            {mark()}
          </Dock>
        </Show>
      }
    >
      {(slot) => (
        <Portal mount={slot}>
          <Show when={visible()}>
            {/* no-drag: the bar around it is a caption region, which would
                take the press as a window move */}
            <Inline
              lost={lost()}
              type="button"
              data-app-region="no-drag"
              title={label()}
              aria-label={label()}
              role="status"
              aria-live="polite"
              onClick={retry}
            >
              {mark()}
            </Inline>
          </Show>
        </Portal>
      )}
    </Show>
  );
}

const Dock = styled("button", {
  base: {
    position: "fixed",
    top: "var(--gap-sm)",
    left: "50%",
    translate: "-50% 0",

    // Below the remote-control panels (200): those are how a live control
    // session gets stopped and must never be covered by chrome. Above the
    // floating user bar (30) and the call card (10).
    zIndex: 150,

    width: "34px",
    height: "34px",
    padding: "5px",
    borderRadius: "50%",
    cursor: "pointer",

    display: "grid",
    placeItems: "center",

    background: "var(--md-sys-color-surface-container-high)",
    boxShadow: "0 2px 10px rgba(0,0,0,0.45)",
    transition: "opacity .3s, border-color .3s",

    // On a pointer device the mark stays small and unobtrusive, but 34px is
    // well under the 44px minimum touch target — so the hit area is grown
    // invisibly rather than by making the dot bigger.
    "&::after": {
      content: '""',
      position: "absolute",
      inset: "-5px",
      borderRadius: "50%",
    },

    // Phones get a genuinely bigger mark: at 34px on a high-density screen the
    // eight dots are too small to read as the brand, and this is the platform
    // where the indicator matters most. Same condition MainBar uses, so it
    // also covers a phone held in landscape.
    _phone: {
      width: "46px",
      height: "46px",
      padding: "7px",

      // 46px already clears the touch-target minimum on its own, so the
      // invisible growth is dropped here. Left in, it would put a ~56px
      // transparent circle over the top-centre of the screen — right where the
      // channel title sits — and silently eat taps meant for it.
      "&::after": {
        inset: "0",
      },
    },
  },
  variants: {
    lost: {
      true: {
        border: "1px solid var(--md-sys-color-error)",
      },
      false: {
        border: "1px solid var(--md-sys-color-outline-variant)",
      },
    },
  },
});

/**
 * The same mark inline in main's title bar (32px tall): sized to the bar,
 * flat, and with no invisible hit-area growth, which would spill over the
 * bar's caption region.
 */
const Inline = styled("button", {
  base: {
    width: "22px",
    height: "22px",
    padding: "3px",
    borderRadius: "50%",
    cursor: "pointer",

    display: "grid",
    placeItems: "center",

    background: "var(--md-sys-color-surface-container-high)",
    transition: "opacity .3s, border-color .3s",

    "&:focus-visible": {
      outline: "2px solid var(--md-sys-color-primary)",
      outlineOffset: "1px",
    },
  },
  variants: {
    lost: {
      true: {
        border: "1px solid var(--md-sys-color-error)",
      },
      false: {
        border: "1px solid var(--md-sys-color-outline-variant)",
      },
    },
  },
});
