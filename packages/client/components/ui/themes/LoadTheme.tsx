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
      // Acutest brand overrides
      "--md-sys-color-surface": "#05090F",
      "--md-sys-color-surface-dim": "#05090F",
      "--md-sys-color-surface-bright": "#0d1825",
      "--md-sys-color-surface-container-lowest": "#030608",
      "--md-sys-color-surface-container-low": "#070d15",
      "--md-sys-color-surface-container": "#090f1a",
      "--md-sys-color-surface-container-high": "#0d1825",
      "--md-sys-color-surface-container-highest": "#111e2e",
      "--md-sys-color-primary": "#00B2FF",
      "--md-sys-color-primary-container": "#00B2FF",
      "--md-sys-color-on-primary": "#ffffff",
      "--md-sys-color-on-primary-container": "#ffffff",
      "--acutest-highlight": "#FF8A00",
    })) {
      document.body.style.setProperty(key, value);
    }
  });

  return <Masks />;
}
