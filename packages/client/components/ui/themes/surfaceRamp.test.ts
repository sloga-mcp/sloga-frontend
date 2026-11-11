/**
 * Run with:
 *
 *     node --conditions=browser --test components/ui/themes/surfaceRamp.test.ts
 *
 * The Sloga preset's background. What it must hold:
 * - with no background picked and the brand accent, every colour is what it
 *   was before the background existed (the default look cannot drift);
 * - the accent never moves a surface or the text on it, in either mode
 *   (a green button must not turn the page green);
 * - a picked background reaches the page as picked, and the panels on it
 *   still step apart;
 * - the stored value is validated like the accent.
 *
 * Known-bad controls: making `slogaColours` return `accentRoles` alone (the
 * behaviour before this change) turns the "accent never moves a surface" and
 * "a picked background" cases red; dropping the clamp in `surfaceRoles`
 * turns the "out-of-range pick" case red; `cleanSurface` returning its input
 * turns the validator case red.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BRAND_ACCENT,
  createMaterialColourVariables,
} from "./materialTheme.ts";
import {
  SURFACE_PRESETS,
  SURFACE_ROLE_KEYS,
  cleanSurface,
  contrastRatio,
  surfaceRoles,
} from "./surfaceRamp.ts";

const common = {
  style: "modern",
  blur: true,
  interfaceFont: "Inter",
  monospaceFont: "Fira Code",
  messageSize: 14,
  messageGroupSpacing: 12,
  messageAvatarSize: 36,
  contrast: 0,
  variant: "tonal_spot",
} as const;

function theme(accent: string, darkMode: boolean, surface = "") {
  return { ...common, preset: "stoat", accent, darkMode, surface } as never;
}

function colours(accent: string, darkMode: boolean, surface = "") {
  return createMaterialColourVariables(
    theme(accent, darkMode, surface),
    "",
  ) as Record<string, string>;
}

const SIX_DIGIT = /^#[0-9a-fA-F]{6}$/;

/**
 * The colours before this change, for the brand accent: the accent's scheme
 * with the brand pins over it. Rebuilt from the Material You preset (which
 * is unpinned) plus the pins, so the spec does not depend on a stored copy.
 */
describe("no background picked, brand accent: unchanged", () => {
  for (const darkMode of [true, false]) {
    it(darkMode ? "dark" : "light", () => {
      const now = colours(BRAND_ACCENT, darkMode);
      const you = createMaterialColourVariables(
        {
          ...common,
          preset: "you",
          accent: BRAND_ACCENT,
          darkMode,
          surface: "",
        } as never,
        "",
      ) as Record<string, string>;

      for (const key of SURFACE_ROLE_KEYS) {
        if (darkMode && key.startsWith("surface")) continue; // the navy pins
        if (darkMode && key.startsWith("secondary-container")) continue;
        if (darkMode && key === "on-secondary-container") continue;
        assert.equal(now[key], you[key], key);
      }
      if (darkMode) {
        assert.equal(now.surface, "#05090F");
        assert.equal(now["surface-container-lowest"], "#030608");
        assert.equal(now["secondary-container"], "#0d1825");
      }
    });
  }
});

describe("the accent never moves a surface or the text on it", () => {
  const ACCENTS = [BRAND_ACCENT, "#9bf088", "#FF5733", "#8C5FD3"];

  for (const darkMode of [true, false]) {
    for (const surface of ["", darkMode ? "#000000" : "#f7f5f0"]) {
      it(`${darkMode ? "dark" : "light"}, background ${surface || "default"}`, () => {
        const reference = colours(ACCENTS[0], darkMode, surface);
        for (const accent of ACCENTS.slice(1)) {
          const other = colours(accent, darkMode, surface);
          for (const key of SURFACE_ROLE_KEYS) {
            assert.equal(other[key], reference[key], `${accent} moved ${key}`);
          }
          // and the accent itself still reaches the accent roles
          assert.notEqual(other.primary, reference.primary, accent);
        }
      });
    }
  }
});

describe("a picked background", () => {
  it("black reaches the page as black, with panels stepping up from it", () => {
    const dark = colours(BRAND_ACCENT, true, "#000000");
    assert.equal(dark.surface, "#000000");
    const ramp = [
      dark.surface,
      dark["surface-container-low"],
      dark["surface-container"],
      dark["surface-container-high"],
      dark["surface-container-highest"],
    ];
    for (let i = 1; i < ramp.length; i++) {
      assert.ok(
        contrastRatio(ramp[i], "#000000") >
          contrastRatio(ramp[i - 1], "#000000"),
        `step ${i} does not separate: ${ramp.join(" ")}`,
      );
    }
    // a pure grey page gets pure grey text, not blue-tinted text
    const [r, g, b] = [1, 3, 5].map((o) =>
      parseInt(dark["on-surface"].slice(o, o + 2), 16),
    );
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 2, dark["on-surface"]);
  });

  it("does not move the accent roles", () => {
    for (const darkMode of [true, false]) {
      const plain = colours("#9bf088", darkMode);
      const picked = colours(
        "#9bf088",
        darkMode,
        darkMode ? "#000000" : "#fbf1f3",
      );
      assert.equal(picked.primary, plain.primary);
      assert.equal(picked["on-primary"], plain["on-primary"]);
    }
  });

  it("text stays readable on every preset swatch", () => {
    for (const darkMode of [true, false]) {
      const list = SURFACE_PRESETS[darkMode ? "dark" : "light"];
      for (const surface of list) {
        const c = colours(BRAND_ACCENT, darkMode, surface);
        for (const bg of [
          "surface",
          "surface-container",
          "surface-container-highest",
        ]) {
          assert.ok(
            contrastRatio(c["on-surface"], c[bg]) >= 7,
            `${surface || "default"} ${bg}: ${c["on-surface"]} on ${c[bg]}`,
          );
          assert.ok(
            contrastRatio(c["on-surface-variant"], c[bg]) >= 4.5,
            `${surface || "default"} ${bg} variant`,
          );
        }
      }
    }
  });

  it("an out-of-range pick keeps its hue at the limit instead", () => {
    // a light colour picked for dark mode, and a dark one for light mode
    const dark = surfaceRoles("#e0e0ff", true);
    assert.notEqual(dark.surface, "#e0e0ff");
    assert.ok(contrastRatio(dark["on-surface"], dark.surface) >= 7);

    const light = surfaceRoles("#202040", false);
    assert.notEqual(light.surface, "#202040");
    assert.ok(contrastRatio(light["on-surface"], light.surface) >= 7);
  });

  it("every role comes out as six-digit hex", () => {
    for (const darkMode of [true, false]) {
      const c = colours("#f00", darkMode, darkMode ? "#140a18" : "#eef2f6");
      for (const key of SURFACE_ROLE_KEYS) assert.match(c[key], SIX_DIGIT, key);
    }
  });
});

describe("Material You ignores the background", () => {
  it("the same accent gives the same colours with or without one", () => {
    const make = (surface: string) =>
      createMaterialColourVariables(
        {
          ...common,
          preset: "you",
          accent: "#9bf088",
          darkMode: true,
          surface,
        } as never,
        "",
      );
    assert.deepEqual(make("#000000"), make(""));
  });
});

/**
 * Why there is no "low contrast" note under the pickers: `brandPins` already
 * lifts a dark-mode accent to tone 60 and takes a light-mode one at tone 40,
 * and the background is held at tone 20 or under (dark) and 85 or over
 * (light). These sweep accents across the hue wheel and every lightness,
 * including the user's worst case (a dark green on black).
 */
describe("a button always stands out from the page", () => {
  const ACCENTS = [
    "#000000",
    "#ffffff",
    "#0b3d0b",
    "#003300",
    "#1a1a40",
    "#ffff00",
    "#9bf088",
    "#ff5733",
    "#8c5fd3",
    "#00b2ff",
    "#121212",
    "#f4f4f4",
  ];

  for (const darkMode of [true, false]) {
    it(darkMode ? "dark" : "light", () => {
      const pages = [
        ...SURFACE_PRESETS[darkMode ? "dark" : "light"],
        darkMode ? "#0b3d0b" : "#ffff99",
      ];
      for (const surface of pages) {
        for (const accent of ACCENTS) {
          const c = colours(accent, darkMode, surface);
          const ratio = contrastRatio(c.primary, c.surface);
          assert.ok(
            ratio >= 3,
            `${accent} on ${surface || "default"}: ${c.primary} vs ${c.surface} = ${ratio.toFixed(2)}`,
          );
          assert.ok(
            contrastRatio(c["on-primary"], c.primary) >= 4.5,
            `label on ${accent} (${c.primary})`,
          );
        }
      }
    });
  }
});

describe("contrastRatio()", () => {
  it("matches the WCAG reference points", () => {
    assert.equal(contrastRatio("#000000", "#ffffff"), 21);
    assert.equal(contrastRatio("#777777", "#777777"), 1);
    assert.ok(Math.abs(contrastRatio("#00B2FF", "#ffffff") - 2.38) < 0.01);
  });
});

describe("cleanSurface()", () => {
  it("keeps six-digit hex, expands three, refuses the rest", () => {
    assert.equal(cleanSurface("#000000"), "#000000");
    assert.equal(cleanSurface("#ABCDEF"), "#abcdef");
    assert.equal(cleanSurface("#f0a"), "#ff00aa");
    for (const bad of [
      "",
      "000000",
      "#0000000f",
      "#zzzzzz",
      "red",
      42,
      null,
      undefined,
      {},
    ]) {
      assert.equal(cleanSurface(bad), "", JSON.stringify(bad));
    }
  });
});
