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

    // Classic or Modern. An attribute rather than variables: the Modern
    // overrides are `_modern` blocks in each component's own styles, which
    // match `[data-style=modern] &`. On <html>, which chat windows copy their
    // attributes from, so they follow it too.
    document.documentElement.dataset.style = activeTheme.style;

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
      // Protected channel shield states (ProtectedHueVar in
      // protectedShield.ts). Fixed hues, the same in light and dark. The
      // unavailable grey is the invisible presence grey.
      "--sloga-protected-ok": "#27A163",
      "--sloga-protected-resecuring": "#F5870D",
      "--sloga-protected-alert": "#CF2A27",
      "--sloga-protected-unavailable": "#A5A5A5",
      "--sloga-protected-grace": "#E3CF1B",
      "--sloga-protected-frozen": "#3BB8ED",
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
