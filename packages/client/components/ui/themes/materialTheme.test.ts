/**
 * Run with:
 *
 *     node --conditions=browser --test components/ui/themes/materialTheme.test.ts
 *
 * The Sloga preset's accent. Before it existed, picking a colour under the
 * default preset did nothing: the scheme was always seeded from the brand
 * blue and the swatches were hidden. These pin the three things the fix must
 * not break: the default look is byte-for-byte the hand-tuned brand tables,
 * a custom accent actually reaches the accent roles, and whatever the store
 * hands over comes out in a form the rest of the theme code can parse.
 *
 * Known-bad control: making `brandPins` return the brand tables for every
 * accent (the behaviour before the fix) turns every "a custom accent reaches
 * the accent roles" case red.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isDeepStrictEqual } from "node:util";

import {
  BRAND_ACCENT,
  BRAND_VARIANT,
  DISCORD_ACCENT,
  accentHasEffect,
  brandPins,
  createMaterialColourVariables,
  createMduiColourTriplets,
} from "./materialTheme.ts";

const common = {
  blur: true,
  interfaceFont: "Inter",
  monospaceFont: "Fira Code",
  messageSize: 14,
  messageGroupSpacing: 12,
  messageAvatarSize: 36,
  contrast: 0,
  variant: "tonal_spot",
} as const;

function colours(
  preset: "stoat" | "discord" | "you",
  accent: string,
  darkMode: boolean,
) {
  return createMaterialColourVariables(
    { ...common, preset, accent, darkMode } as never,
    "",
  ) as Record<string, string>;
}

const SIX_DIGIT = /^#[0-9a-fA-F]{6}$/;

describe("the default look is unchanged", () => {
  it("brand blue renders the hand-tuned dark table", () => {
    const dark = colours("stoat", BRAND_ACCENT, true);
    assert.equal(dark.primary, "#00B2FF");
    assert.equal(dark["on-primary"], "#05090F");
    assert.equal(dark.surface, "#05090F");
  });

  it("brand blue renders the hand-tuned light table", () => {
    const light = colours("stoat", BRAND_ACCENT, false);
    assert.equal(light.primary, "#006492");
    assert.equal(light["on-primary"], "#ffffff");
  });

  it("brand blue is recognised whatever its case", () => {
    assert.deepEqual(brandPins("#00b2ff", true), brandPins(BRAND_ACCENT, true));
  });
});

describe("a custom accent reaches the accent roles", () => {
  it("dark mode fills with the colour as picked on the navy chrome", () => {
    const dark = colours("stoat", "#ff5733", true);
    assert.equal(dark.primary, "#ff5733");
    assert.equal(dark["primary-container"], "#ff5733");
    assert.equal(dark["on-primary"], "#05090F");
    assert.equal(dark.surface, "#05090F");
  });

  it("dark mode lifts a colour too dark to read as a button", () => {
    const dark = colours("stoat", "#1a1a40", true);
    assert.notEqual(dark.primary, "#1a1a40");
    assert.notEqual(dark.primary, "#00B2FF");
    assert.match(dark.primary, SIX_DIGIT);
  });

  it("light mode takes the colour at the tone that gives the brand #006492", () => {
    const light = colours("stoat", "#ff5733", false);
    assert.notEqual(light.primary, "#006492");
    assert.notEqual(light.primary, "#ff5733");
    assert.equal(light["on-primary"], "#ffffff");
  });
});

describe("the output stays parseable", () => {
  it("a three-digit accent comes out as six digits", () => {
    assert.match(colours("stoat", "#f00", true).primary, SIX_DIGIT);
    assert.match(colours("stoat", "#f00", false).primary, SIX_DIGIT);
  });

  it("the MDUI triplets do not throw on a three-digit accent", () => {
    assert.doesNotThrow(() =>
      createMduiColourTriplets(
        { ...common, preset: "stoat", accent: "#f00", darkMode: true } as never,
        "x-",
      ),
    );
  });
});

describe("Material You is untouched", () => {
  it("does not pin the brand tables", () => {
    assert.notEqual(colours("you", BRAND_ACCENT, true).primary, "#00B2FF");
    assert.notEqual(colours("you", BRAND_ACCENT, true).surface, "#05090F");
  });
});

/**
 * The appearance menu greys out the accent swatches when `accentHasEffect`
 * says picking a colour changes nothing. That is only honest while the helper
 * agrees with the generator, so these compare it with the colours two
 * different accents actually produce, for every variant, contrast and mode.
 *
 * Known-bad controls: `return true` turns the Monochrome case red (two accents
 * give identical greys), and dropping the preset check turns the Sloga case
 * red (a stale "monochrome" would lock swatches that still work).
 */
type Variant = Parameters<typeof accentHasEffect>[1];

describe("accentHasEffect agrees with the generated colours", () => {
  const ACCENT_A = "#FF5733";
  const ACCENT_B = "#549bec";
  const CONTRASTS = [-1, 0, 0.5, 1];

  // A Record, so the type check fails here if the store gains a variant this
  // list does not cover.
  const ALL_VARIANTS: Record<Variant, true> = {
    monochrome: true,
    neutral: true,
    tonal_spot: true,
    vibrant: true,
    expressive: true,
    fidelity: true,
    content: true,
    rainbow: true,
    fruit_salad: true,
  };

  // `colours` above hard-codes the variant and contrast from `common`, so
  // these are spread after it.
  function generated(
    preset: "stoat" | "you",
    accent: string,
    darkMode: boolean,
    variant: Variant,
    contrast: number,
  ) {
    return createMaterialColourVariables(
      { ...common, preset, accent, darkMode, variant, contrast } as never,
      "",
    ) as Record<string, string>;
  }

  for (const variant of Object.keys(ALL_VARIANTS) as Variant[]) {
    it(`Material You "${variant}": locked exactly when two accents give the same colours`, () => {
      for (const contrast of CONTRASTS) {
        for (const darkMode of [true, false]) {
          const accentChangesColours = !isDeepStrictEqual(
            generated("you", ACCENT_A, darkMode, variant, contrast),
            generated("you", ACCENT_B, darkMode, variant, contrast),
          );

          assert.equal(
            accentHasEffect("you", variant),
            accentChangesColours,
            `${variant}, contrast ${contrast}, ${darkMode ? "dark" : "light"}`,
          );
        }
      }
    });
  }

  it("Sloga is never locked by a stale Material You monochrome", () => {
    // The store keeps the Material You variant while Sloga is active, but
    // `activeTheme` hands the generator BRAND_VARIANT and contrast 0 instead.
    const storedVariant: Variant = "monochrome";
    assert.equal(accentHasEffect("stoat", storedVariant), true);

    for (const darkMode of [true, false]) {
      assert.notDeepEqual(
        generated("stoat", ACCENT_A, darkMode, BRAND_VARIANT, 0),
        generated("stoat", ACCENT_B, darkMode, BRAND_VARIANT, 0),
        darkMode ? "dark" : "light",
      );
    }
  });
});

describe("the Discord preset", () => {
  it("dark mode paints Discord's three backgrounds where Discord has them", () => {
    const dark = colours("discord", DISCORD_ACCENT, true);
    assert.equal(dark.surface, "#1E1F22");
    assert.equal(dark["surface-container-low"], "#2B2D31");
    assert.equal(dark["surface-container-lowest"], "#313338");
    assert.equal(dark["surface-container-high"], "#383A40");
    assert.equal(dark["on-surface"], "#DBDEE1");
    assert.equal(dark.primary, "#5865F2");
    assert.equal(dark["on-primary"], "#FFFFFF");
  });

  it("light mode keeps a light canvas under dark text", () => {
    const light = colours("discord", DISCORD_ACCENT, false);
    assert.equal(light.surface, "#E3E5E8");
    assert.equal(light["surface-container-lowest"], "#FFFFFF");
    assert.equal(light["on-surface"], "#313338");
    assert.equal(light.primary, "#5865F2");
  });

  it("is locked whatever variant is stored, and ignores the accent", () => {
    for (const variant of ["tonal_spot", "monochrome"] as const) {
      assert.equal(accentHasEffect("discord", variant), false);
    }
    for (const darkMode of [true, false]) {
      // only the pinned roles are checked: the generated ones are seeded from
      // whatever accent `activeTheme` hands over, which is always blurple
      const a = colours("discord", "#FF5733", darkMode);
      const b = colours("discord", "#9bf088", darkMode);
      for (const role of ["surface", "primary", "on-surface"]) {
        assert.equal(
          a[role],
          b[role],
          `${role}, ${darkMode ? "dark" : "light"}`,
        );
      }
    }
  });

  it("comes out as six-digit hex the triplet parser accepts", () => {
    for (const darkMode of [true, false]) {
      const vars = colours("discord", DISCORD_ACCENT, darkMode);
      for (const [role, value] of Object.entries(vars)) {
        assert.match(value, SIX_DIGIT, role);
      }
      assert.doesNotThrow(() =>
        createMduiColourTriplets(
          {
            ...common,
            preset: "discord",
            accent: DISCORD_ACCENT,
            darkMode,
          } as never,
          "",
        ),
      );
    }
  });
});
