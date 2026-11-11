import {
  Hct,
  TonalPalette,
  argbFromHex,
  hexFromArgb,
} from "@material/material-color-utilities";

/**
 * Roles the Sloga preset takes from the background rather than the accent
 *
 * The page and panel surfaces, plus every neutral that sits on them (text,
 * dividers, the tonal button fill). Picking an accent never moves any of
 * these, and picking a background never moves the accent roles.
 */
export const SURFACE_ROLE_KEYS = [
  "surface-dim",
  "surface",
  "surface-bright",
  "surface-container-lowest",
  "surface-container-low",
  "surface-container",
  "surface-container-high",
  "surface-container-highest",
  "on-surface",
  "on-surface-variant",
  "outline",
  "outline-variant",
  "inverse-surface",
  "inverse-on-surface",
  "secondary-container",
  "on-secondary-container",
] as const;

export type SurfaceRole = (typeof SURFACE_ROLE_KEYS)[number];

/**
 * Background swatches offered under the Sloga preset, per mode
 *
 * `""` is the brand default (navy in dark mode, Material's generated light
 * surfaces in light mode) and stays first: it is the only way back to it.
 * The values are stored ids as much as colours: renaming one strands every
 * account that picked it on a custom colour that no swatch lights.
 */
export const SURFACE_PRESETS = {
  dark: ["", "#000000", "#121212", "#12161c", "#140a18", "#08130e"],
  light: ["", "#ffffff", "#f7f5f0", "#eef2f6", "#fbf1f3"],
} as const;

/**
 * Darkest tone a light-mode background may have, and the lightest a dark-mode
 * one may have. Past these the default text roles stop being readable on it,
 * so a pick outside the range keeps its hue and chroma at the limit instead.
 */
const LIGHT_MIN_TONE = 85;
const DARK_MAX_TONE = 20;

/**
 * Validate a stored background colour
 *
 * Anchored and six-digit like `slogaAccent` (the only form
 * `<input type="color">` accepts); a three-digit value is expanded. Anything
 * else is the brand default, `""`.
 * @param value Stored value
 * @returns Six-digit lowercase hex, or `""`
 */
export function cleanSurface(value: unknown): string {
  if (typeof value !== "string") return "";
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(value)) {
    return ("#" + [...value.slice(1)].map((c) => c + c).join("")).toLowerCase();
  }
  return "";
}

/**
 * Build the surface ramp and neutral roles from a background colour
 *
 * The picked colour is the page itself, kept as picked (black stays #000000);
 * the containers step up from it in tone, by about what the brand navy ramp
 * steps, so cards, sidebars and popovers still separate. The neutrals take
 * the background's hue at a low chroma, so text and dividers lean the same
 * way as the page instead of towards the accent.
 * @param background Six-digit hex
 * @param darkMode Dark mode
 * @returns Every role in `SURFACE_ROLE_KEYS`
 */
export function surfaceRoles(
  background: string,
  darkMode: boolean,
): Record<SurfaceRole, string> {
  const picked = Hct.fromInt(argbFromHex(background));
  const hue = picked.hue;
  const chroma = picked.chroma;

  const base = darkMode
    ? Math.min(picked.tone, DARK_MAX_TONE)
    : Math.max(picked.tone, LIGHT_MIN_TONE);
  const asPicked = base === picked.tone;

  const at = (tone: number) =>
    hexFromArgb(
      Hct.from(hue, chroma, Math.max(0, Math.min(100, tone))).toInt(),
    );
  const surface = asPicked ? hexFromArgb(argbFromHex(background)) : at(base);

  const neutral = TonalPalette.fromHueAndChroma(hue, Math.min(chroma, 6));
  const variant = TonalPalette.fromHueAndChroma(hue, Math.min(chroma, 8));
  const tint = TonalPalette.fromHueAndChroma(hue, Math.min(chroma, 10));
  const n = (tone: number) => hexFromArgb(neutral.tone(tone));
  const nv = (tone: number) => hexFromArgb(variant.tone(tone));

  if (darkMode) {
    const high = at(base + 5.5);
    return {
      "surface-dim": surface,
      surface,
      "surface-bright": high,
      "surface-container-lowest": at(base - 1.5),
      "surface-container-low": at(base + 1.5),
      "surface-container": at(base + 2.5),
      "surface-container-high": high,
      "surface-container-highest": at(base + 8.5),
      "on-surface": n(90),
      "on-surface-variant": nv(80),
      outline: nv(60),
      "outline-variant": nv(30),
      "inverse-surface": n(90),
      "inverse-on-surface": n(20),
      "secondary-container": high,
      "on-secondary-container": hexFromArgb(tint.tone(86)),
    };
  }

  const highest = at(base - 8);
  return {
    "surface-dim": at(base - 11),
    surface,
    "surface-bright": surface,
    "surface-container-lowest": at(base + 2),
    "surface-container-low": at(base - 2),
    "surface-container": at(base - 4),
    "surface-container-high": at(base - 6),
    "surface-container-highest": highest,
    "on-surface": n(10),
    "on-surface-variant": nv(30),
    outline: nv(50),
    "outline-variant": nv(80),
    "inverse-surface": n(20),
    "inverse-on-surface": n(95),
    "secondary-container": highest,
    "on-secondary-container": n(10),
  };
}

/**
 * WCAG relative luminance of a six-digit hex colour
 */
function luminance(hex: string): number {
  const channel = (offset: number) => {
    const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/**
 * WCAG contrast ratio between two six-digit hex colours
 * @returns Ratio from 1 to 21
 */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
