import {
  Hct,
  SchemeContent,
  SchemeExpressive,
  SchemeFidelity,
  SchemeFruitSalad,
  SchemeMonochrome,
  SchemeNeutral,
  SchemeRainbow,
  SchemeTonalSpot,
  SchemeVibrant,
  argbFromHex,
  hexFromArgb,
} from "@material/material-color-utilities";

import type { SelectedTheme, TypeTheme } from "@revolt/state/stores/Theme";

/**
 * Default accent for both presets: Sloga blue.
 */
export const BRAND_ACCENT = "#00B2FF";

/**
 * Variant the Sloga preset generates its base scheme from.
 *
 * Also the Material You default: the previous default, "expressive", turns a
 * blue seed into a yellow-green primary (#bdcf77), and it is not one of the
 * variants the appearance menu offers, so it left every fresh profile with no
 * variant button selected.
 */
export const BRAND_VARIANT: TypeTheme["m3Variant"] = "tonal_spot";

/**
 * Whether picking an accent changes anything under the given preset and
 * variant. The appearance menu greys out the accent swatches when it does not.
 *
 * Material You's Monochrome scheme ignores the accent entirely: it builds every
 * role from greys, so every accent gives the same colours. The Sloga preset
 * ignores the stored `m3Variant` instead — it always generates from
 * `BRAND_VARIANT` (see `activeTheme` in Theme.ts) — so a stale "monochrome"
 * left over from Material You must not lock the Sloga swatches.
 */
export function accentHasEffect(
  preset: TypeTheme["preset"],
  variant: TypeTheme["m3Variant"],
): boolean {
  return preset === "stoat" || variant !== "monochrome";
}

/**
 * Sloga's hand-tuned palette, applied over a generated scheme rather than
 * replacing it: every role these tables do not name — error, outline, inverse,
 * the fixed roles — still comes from Material, so the result stays internally
 * consistent and mode-correct.
 *
 * Only dark has a hand-picked surface ramp; the navy chrome is the brand.
 * Light deliberately keeps Material's generated surfaces, because pinning a
 * dark canvas in both modes is exactly what used to leave light mode painting
 * near-black text on a near-black page.
 */
const BRAND_DARK: Partial<MaterialColours> = {
  surface: "#05090F",
  "surface-dim": "#05090F",
  "surface-bright": "#0d1825",
  "surface-container-lowest": "#030608",
  "surface-container-low": "#070d15",
  "surface-container": "#090f1a",
  "surface-container-high": "#0d1825",
  "surface-container-highest": "#111e2e",

  primary: BRAND_ACCENT,
  "primary-container": BRAND_ACCENT,
  // Near-black, not white. #00B2FF is a tone-69 blue: white on it is 2.38:1,
  // which fails WCAG AA (4.5:1) and even AA-large (3:1) — every filled button,
  // mention pill, unread divider and selected-channel label in the default
  // theme was text you had to squint at. The brand navy is 8.37:1 on the same
  // blue and is already the surface colour, so the pairing stays in-palette.
  // Light mode keeps white: #006492 is dark enough to carry it at 6.49:1.
  "on-primary": "#05090F",
  "on-primary-container": "#05090F",

  "secondary-container": "#0d1825",
  "on-secondary-container": "#c8d8e8",
};

/**
 * Light counterpart. The accent roles keep the brand's own hue (241.8) and
 * chroma (58.8) but take the tone Material wants for a light-mode primary
 * (40), which lands on #006492 — still recognisably Sloga blue, and 6.49:1
 * against its white label where the raw #00B2FF manages only 2.38:1.
 */
const BRAND_LIGHT: Partial<MaterialColours> = {
  primary: "#006492",
  "primary-container": "#006492",
  "on-primary": "#ffffff",
  "on-primary-container": "#ffffff",
};

/**
 * The navy chrome and brand-blue accent roles, as a colour the user picked
 * under the Sloga preset would re-derive them.
 *
 * The brand blue itself returns the hand-tuned tables above untouched, so the
 * default look cannot drift. Any other accent keeps the navy surfaces and takes
 * the brand's treatment of the accent roles instead:
 * - dark mode fills with the colour as picked, lifted to tone 60 if it is
 *   darker than that (a tone-20 accent on a tone-3 canvas is not a button),
 *   and labels it navy like the brand blue. Tone 60 is what makes navy always
 *   the right label: it is at least 6.3:1 there, and white at most 3.2:1;
 * - light mode fills with the colour's own hue and chroma at tone 40, the same
 *   rule that gives the brand #006492, which always carries a white label.
 *
 * Normalised through Hct so the result is always six-digit hex: the triplet
 * parser in `createMduiColourTriplets` throws on the three-digit form.
 */
export function brandPins(
  accent: string,
  darkMode: boolean,
): Partial<MaterialColours> {
  if (accent.toLowerCase() === BRAND_ACCENT.toLowerCase()) {
    return darkMode ? BRAND_DARK : BRAND_LIGHT;
  }

  const hct = Hct.fromInt(argbFromHex(accent));

  if (!darkMode) {
    const fill = hexFromArgb(Hct.from(hct.hue, hct.chroma, 40).toInt());
    return {
      primary: fill,
      "primary-container": fill,
      "on-primary": "#ffffff",
      "on-primary-container": "#ffffff",
    };
  }

  const fill = hexFromArgb(
    (hct.tone < 60 ? Hct.from(hct.hue, hct.chroma, 60) : hct).toInt(),
  );

  return {
    ...BRAND_DARK,
    primary: fill,
    "primary-container": fill,
  };
}

/**
 * Generate the Material variables from the given properties
 *
 * Currently only generates color keys
 */
export function createMaterialColourVariables<P extends string>(
  theme: SelectedTheme,
  prefix: P,
): addPrefixToObject<MaterialColours, P> {
  const scheme = generateMaterialYouScheme(
    theme.accent,
    theme.darkMode,
    theme.contrast,
    theme.variant,
  );

  const colours =
    theme.preset === "stoat"
      ? { ...scheme, ...brandPins(theme.accent, theme.darkMode) }
      : scheme;

  return Object.entries(colours).reduce(
    (d, [key, value]) => ({
      ...d,
      [`${prefix}${key}`]: value,
    }),
    {} as addPrefixToObject<MaterialColours, P>,
  );
}

/**
 * Create R,G,B triplets for MDUI variables
 */
export function createMduiColourTriplets<P extends string>(
  theme: SelectedTheme,
  prefix: P,
): addPrefixToObject<MaterialColours, P> {
  const variables = createMaterialColourVariables(theme, prefix);

  for (const key in variables) {
    const [_, r, g, b] = /#([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})/i.exec(
      variables[key as keyof typeof variables] as string,
    )!;

    variables[key as keyof typeof variables] =
      `${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)}` as never;
  }

  return variables;
}

type addPrefixToObject<T, P extends string> = {
  [K in keyof T as K extends string ? `${P}${K}` : never]: T[K];
};

type _addSuffixToObject<T, S extends string> = {
  [K in keyof T as K extends string ? `${K}${S}` : never]: T[K];
};

type MaterialColours = {
  primary: string;
  "on-primary": string;
  "primary-container": string;
  "on-primary-container": string;
  secondary: string;
  "on-secondary": string;
  "secondary-container": string;
  "on-secondary-container": string;
  tertiary: string;
  "on-tertiary": string;
  "tertiary-container": string;
  "on-tertiary-container": string;
  error: string;
  "on-error": string;
  "error-container": string;
  "on-error-container": string;

  "primary-fixed": string;
  "primary-fixed-dim": string;
  "on-primary-fixed": string;
  "on-primary-fixed-variant": string;
  "secondary-fixed": string;
  "secondary-fixed-dim": string;
  "on-secondary-fixed": string;
  "on-secondary-fixed-variant": string;
  "tertiary-fixed": string;
  "tertiary-fixed-dim": string;
  "on-tertiary-fixed": string;
  "on-tertiary-fixed-variant": string;

  "surface-dim": string;
  surface: string;
  "surface-bright": string;

  "surface-container-lowest": string;
  "surface-container-low": string;
  "surface-container": string;
  "surface-container-high": string;
  "surface-container-highest": string;

  "on-surface": string;
  "on-surface-variant": string;
  outline: string;
  "outline-variant": string;

  "inverse-surface": string;
  "inverse-on-surface": string;
  "inverse-primary": string;

  scrim: string;
  shadow: string;
};

/**
 * Generate a Material You colour scheme
 * @param accent Accent colour in hex format
 * @param darkMode Dark mode
 * @param constrat Constrast level
 * @returns Material colours
 */
function generateMaterialYouScheme(
  accent: string,
  darkMode: boolean,
  contrast: number,
  variant: TypeTheme["m3Variant"],
): MaterialColours {
  const hct = Hct.fromInt(argbFromHex(accent));

  let scheme;
  switch (variant) {
    case "content":
      scheme = new SchemeContent(hct, darkMode, contrast);
      break;
    case "expressive":
      scheme = new SchemeExpressive(hct, darkMode, contrast);
      break;
    case "fidelity":
      scheme = new SchemeFidelity(hct, darkMode, contrast);
      break;
    case "fruit_salad":
      scheme = new SchemeFruitSalad(hct, darkMode, contrast);
      break;
    case "monochrome":
      scheme = new SchemeMonochrome(hct, darkMode, contrast);
      break;
    case "neutral":
      scheme = new SchemeNeutral(hct, darkMode, contrast);
      break;
    case "rainbow":
      scheme = new SchemeRainbow(hct, darkMode, contrast);
      break;
    case "vibrant":
      scheme = new SchemeVibrant(hct, darkMode, contrast);
      break;
    case "tonal_spot":
    default:
      scheme = new SchemeTonalSpot(hct, darkMode, contrast);
      break;
  }

  return {
    primary: hexFromArgb(scheme.primary),
    "on-primary": hexFromArgb(scheme.onPrimary),
    "primary-container": hexFromArgb(scheme.primaryContainer),
    "on-primary-container": hexFromArgb(scheme.onPrimaryContainer),
    secondary: hexFromArgb(scheme.secondary),
    "on-secondary": hexFromArgb(scheme.onSecondary),
    "secondary-container": hexFromArgb(scheme.secondaryContainer),
    "on-secondary-container": hexFromArgb(scheme.onSecondaryContainer),
    tertiary: hexFromArgb(scheme.tertiary),
    "on-tertiary": hexFromArgb(scheme.onTertiary),
    "tertiary-container": hexFromArgb(scheme.tertiaryContainer),
    "on-tertiary-container": hexFromArgb(scheme.onTertiaryContainer),
    error: hexFromArgb(scheme.error),
    "on-error": hexFromArgb(scheme.onError),
    "error-container": hexFromArgb(scheme.errorContainer),
    "on-error-container": hexFromArgb(scheme.onErrorContainer),

    "primary-fixed": hexFromArgb(scheme.primaryFixed),
    "primary-fixed-dim": hexFromArgb(scheme.primaryFixedDim),
    "on-primary-fixed": hexFromArgb(scheme.onPrimaryFixed),
    "on-primary-fixed-variant": hexFromArgb(scheme.onPrimaryFixedVariant),
    "secondary-fixed": hexFromArgb(scheme.secondaryFixed),
    "secondary-fixed-dim": hexFromArgb(scheme.onSecondaryFixed),
    "on-secondary-fixed": hexFromArgb(scheme.onSecondaryFixed),
    "on-secondary-fixed-variant": hexFromArgb(scheme.onSecondaryFixedVariant),
    "tertiary-fixed": hexFromArgb(scheme.tertiaryFixed),
    "tertiary-fixed-dim": hexFromArgb(scheme.tertiaryFixedDim),
    "on-tertiary-fixed": hexFromArgb(scheme.onTertiaryFixed),
    "on-tertiary-fixed-variant": hexFromArgb(scheme.onTertiaryFixedVariant),

    "surface-dim": hexFromArgb(scheme.surfaceDim),
    surface: hexFromArgb(scheme.surface),
    "surface-bright": hexFromArgb(scheme.surfaceBright),

    "surface-container-lowest": hexFromArgb(scheme.surfaceContainerLowest),
    "surface-container-low": hexFromArgb(scheme.surfaceContainerLow),
    "surface-container": hexFromArgb(scheme.surfaceContainer),
    "surface-container-high": hexFromArgb(scheme.surfaceContainerHigh),
    "surface-container-highest": hexFromArgb(scheme.surfaceContainerHighest),

    "on-surface": hexFromArgb(scheme.onSurface),
    "on-surface-variant": hexFromArgb(scheme.onSurfaceVariant),
    outline: hexFromArgb(scheme.outline),
    "outline-variant": hexFromArgb(scheme.outlineVariant),

    "inverse-surface": hexFromArgb(scheme.inverseSurface),
    "inverse-on-surface": hexFromArgb(scheme.inverseOnSurface),
    "inverse-primary": hexFromArgb(scheme.inversePrimary),

    scrim: hexFromArgb(scheme.scrim),
    shadow: hexFromArgb(scheme.shadow),
  };
}
