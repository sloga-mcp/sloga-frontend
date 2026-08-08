import { SelectedTheme } from "@revolt/state/stores/Theme";

/**
 * Generate Stoat for Web variables
 * @param theme Theme
 * @returns CSS Variables
 */
export function createStoatWebVariables(theme: SelectedTheme) {
  return {
    // helper variables
    "--unset-fg": "red",
    "--unset-bg": "linear-gradient(to right, red, blue)",

    // message size
    "--message-size": `${theme.messageSize}px`,
    "--message-group-spacing": `${theme.messageGroupSpacing}px`,

    // emoji size
    "--emoji-size": "1.4em",
    "--emoji-size-medium": "48px",
    "--emoji-size-large": "96px",

    // effects
    "--effects-blur-md": theme.blur ? "blur(20px)" : "unset",
    "--effects-invert-black": theme.darkMode ? "invert(100%)" : "invert(0%)",
    "--effects-invert-light": theme.darkMode ? "invert(0%)" : "invert(1000%)",

    // transitions
    "--transitions-fast": ".1s ease-in-out",
    "--transitions-medium": ".2s ease",

    // brand
    "--brand-presence-online": "#3ABF7E",
    "--brand-presence-idle": "#F39F00",
    "--brand-presence-busy": "#F84848",
    "--brand-presence-focus": "#4799F0",
    "--brand-presence-invisible": "#A5A5A5",

    // semantic state
    // The legacy generator builds a `customColours` table holding success /
    // warning / error and then drops it on the floor -- it never reaches the
    // returned object, so nothing mounts it and
    // `var(--customColours-success-color)` resolves to nothing. The
    // declaration is then thrown away silently, which no type-check can see.
    // These are the real tokens. Anchored on the presence palette so a
    // success green is the same green as an online dot; both hues fail
    // contrast against white, hence the near-black `on-` pairs (8.5:1 and
    // 9.3:1 respectively). Error deliberately has no token here --
    // `--md-sys-color-error` is already real and already carries it.
    "--brand-success": "#3ABF7E",
    "--brand-on-success": "#05090F",
    "--brand-warning": "#F39F00",
    "--brand-on-warning": "#05090F",

    // font
    "--fonts-primary": `"${theme.interfaceFont}", "Inter", sans-serif`,
    "--fonts-monospace": `"${theme.monospaceFont}", "Jetbrains Mono", sans-serif`,

    // load constants
    ...reduceWithPrefix(themeConstants.borderRadius, "--borderRadius-"),
    ...reduceWithPrefix(themeConstants.gap, "--gap-"),
    ...reduceWithPrefix(themeConstants.layout, "--layout-"),
  };
}

/**
 * Add prefix to all keys in an object
 * @param object Object
 * @param prefix Prefix
 * @returns New object
 */
function reduceWithPrefix(object: Record<string, string>, prefix: string) {
  return Object.entries(object).reduce(
    (d, [k, v]) => ({ ...d, [`${prefix}${k}`]: v }),
    {},
  );
}

const themeConstants = {
  borderRadius: {
    // Material 3 Expressive ten-level shape scale
    // https://m3.material.io/styles/shape/corner-radius-scale
    none: "0px",
    xs: "4px",
    sm: "8px",
    md: "12px",
    lg: "16px",
    li: "20px",
    xl: "28px",
    xli: "32px",
    xxl: "48px",
    full: "calc(infinity * 1px)",
    circle: "100%",
  },
  /**
   * @deprecated decide this at a component level
   */
  gap: {
    none: "0",
    xxs: "1px",
    xs: "2px",
    s: "6px",
    sm: "4px",
    md: "8px",
    l: "12px",
    lg: "15px",
    x: "28px",
    xl: "32px",
    xxl: "64px",
  },
  layout: {
    "width-channel-sidebar": "248px",
    "width-user-context-menu-truncate": "300px",
    "height-message-box": "32vh",
    /**
     * Space the floating user bar needs at the bottom of whatever it overlays.
     * Covers the pill itself plus its 10px offset from the edge; every
     * container that reserves room for it reads this, so the bar can only ever
     * be resized in one place.
     */
    "height-user-footer": "64px",
  },
};
