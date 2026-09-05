import { createEffect } from "solid-js";

import { useState } from "@revolt/state";

import {
  createMaterialColourVariables,
  createMduiColourTriplets,
  createStoatWebVariables,
} from ".";
import { Masks } from "./Masks";
import { FONTS, MONOSPACE_FONTS } from "./fonts";
import { legacyThemeUnsetShim } from "./legacyThemeGeneratorCode";

/**
 * Component for loading theme variables into root
 */
export function LoadTheme() {
  const state = useState();

  createEffect(() => {
    const activeTheme = state.theme.activeTheme;

    // load fonts
    FONTS[state.theme.interfaceFont].load();
    MONOSPACE_FONTS[state.theme.monospaceFont].load();

    for (const [key, value] of Object.entries({
      // create unset variables to indicate where colours need replacing
      ...Object.keys(legacyThemeUnsetShim().colours).reduce(
        (d, k) => ({
          ...d,
          [`--colours-${k}`]: k.includes("background")
            ? "var(--unset-bg)"
            : "var(--unset-fg)",
        }),
        {},
      ),
      // mount Stoat for Web variables
      ...createStoatWebVariables(activeTheme),
      // mount --md-sys-color variables
      ...createMaterialColourVariables(activeTheme, "--md-sys-color-"),
      // mount --mdui-color triplet variables
      ...createMduiColourTriplets(activeTheme, "--mdui-color-"),
      // The Sloga brand palette used to be pinned here, as a block of literals
      // written over the generated scheme after the fact. That is what broke
      // the appearance menu: the pins ignored light/dark, so light mode kept a
      // dark canvas under its now-dark text, and they ignored the accent, so
      // every swatch, contrast level and variant regenerated a scheme whose
      // visible roles were immediately overwritten. The palette now lives in
      // materialTheme as the "stoat" preset, which folds it into the scheme
      // per-mode. --sloga-highlight stays because it is a brand constant with
      // no Material role behind it.
      "--sloga-highlight": "#FF8A00",
      // The sidebar call-out colour (unread channel, online member, joined
      // voice channel). User-chosen, so it is read off the store directly
      // rather than folded into the generated scheme.
      "--sloga-rail-accent": state.theme.railAccent,
    })) {
      // Mounted on <html>, not <body>: styles.css paints the page canvas from
      // `html:root` (it has to — iOS Safari draws overscroll from <html>), and
      // a variable set on <body> is invisible to <html>, which is its parent.
      // Everything under <body> still sees these by inheritance, and an inline
      // style on the root element outranks mdui.css's own `:root` defaults.
      document.documentElement.style.setProperty(key, value);
    }
  });

  return <Masks />;
}
