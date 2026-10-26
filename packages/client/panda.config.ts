import { defineConfig } from "@pandacss/dev";
import Breakpoint from "./components/common/Breakpoint";

const condExt: Record<string, string> = {};

//Load breakpoint conditions
for (const bp in Breakpoint) {
  condExt[bp] = `@media ${Breakpoint[bp as keyof typeof Breakpoint]}`;
}

// The Modern style (Settings → Appearance), set on <html> by LoadTheme.
// `_modern` blocks only ever add to a component's Classic styles.
condExt.modern = "[data-style=modern] &";

export default defineConfig({
  // Whether to use css reset
  preflight: true,

  // Where to look for your css declarations
  include: ["./src/**/*.{js,jsx,ts,tsx}", "./components/**/*.{js,jsx,ts,tsx}"],

  conditions: { extend: condExt },

  // Useful for theme customization
  theme: {
    extend: {
      keyframes: {
        materialPhysicsButtonSelect: {
          "0%": {
            paddingInline: "var(--padding-inline)",
          },
          "50%": {
            paddingInline: "calc(var(--padding-inline) + 8px)",
          },
          "100%": {
            paddingInline: "var(--padding-inline)",
          },
        },
        // Live-recording indicator. A slow opacity fade, NOT a blink: this
        // runs for the whole recording in a call bar the user is looking past,
        // and a hard flash there is genuinely unpleasant over an hour. Never
        // the sole carrier of the state — the filled button and icon say it
        // too, so `prefers-reduced-motion` can drop this entirely.
        voiceRecordingPulse: {
          "0%": { opacity: "1" },
          "50%": { opacity: "0.45" },
          "100%": { opacity: "1" },
        },
        incomingCallPulse: {
          "0%": {
            boxShadow: "0 0 0 0 var(--md-sys-color-primary)",
          },
          "70%": {
            boxShadow: "0 0 0 10px transparent",
          },
          "100%": {
            boxShadow: "0 0 0 0 transparent",
          },
        },
        scrimFadeIn: {
          "0%": {
            background: "transparent",
          },
          "100%": {
            background: "var(--background)",
            backgroundSize: "cover",
            backgroundPosition: "center",
            backgroundRepeat: "no-repeat",
          },
        },
        slideIn: {
          "0%": {
            transform: "translateY(var(--translateY))",
          },
          "100%": {
            transform: "translateY(0px)",
          },
        },
        highlightMessage: {
          "0%": {
            background: "transparent",
          },
          "5%": {
            background: "var(--md-sys-color-primary-container)",
          },
          "95%": {
            background: "var(--md-sys-color-primary-container)",
          },
          "100%": {
            background: "transparent",
          },
        },
        skeletonShimmer: {
          "0%": {
            backgroundPosition: "200% 0",
          },
          "100%": {
            backgroundPosition: "-200% 0",
          },
        },
        // Full lifecycle of an in-call dice-roll toast: slide+fade in, hold for
        // ~3s, fade out. Duration is DICE_TOAST_MS (rtc/state.tsx) — the node is
        // unmounted as this finishes, so keep the two in sync.
        diceRollToast: {
          "0%": {
            opacity: "0",
            transform: "translateY(-10px) scale(0.96)",
          },
          "8%": {
            opacity: "1",
            transform: "translateY(0) scale(1)",
          },
          "90%": {
            opacity: "1",
            transform: "translateY(0) scale(1)",
          },
          "100%": {
            opacity: "0",
            transform: "translateY(-6px) scale(0.98)",
          },
        },
      },
    },
  },

  // The output directory for your css system
  outdir: "styled-system",

  // Enable jsx code gen
  jsxFramework: "solid",

  // Use template style
  // syntax: "template-literal",
});
