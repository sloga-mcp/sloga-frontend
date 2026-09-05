/**
 * The colour the sidebars use to call something out: an unread channel, a
 * member who is online, the voice channel you are sitting in, a ringing DM.
 *
 * Historically a literal pinned inside MenuButton; the appearance menu now
 * lets the user pick it, so it lives here as a named default with the preset
 * swatches the menu offers next to it.
 */
export const RAIL_ACCENT_DEFAULT = "#FF8A00";

/**
 * Preset swatches, in the order the appearance menu shows them.
 *
 * Brand orange first because it is the default, white second because it is
 * the request that started this ("just make the names white"), then the
 * satellites of the O mark, clockwise from the top, with its green core last.
 * The mark's own orange (#F5870D) is left out: beside the default it reads as
 * the same swatch twice.
 */
export const RAIL_ACCENT_PRESETS: readonly string[] = [
  RAIL_ACCENT_DEFAULT,
  "#FFFFFF",
  "#3BB8ED",
  "#CF2A27",
  "#E3CF1B",
  "#2B2BD8",
  "#C05FC8",
  "#27A163",
];

/**
 * Hex colours only, in the three forms the picker and the presets produce.
 * Anything else is refused rather than mounted as a CSS variable, since an
 * arbitrary string here would reach `--color` on every sidebar row.
 */
export const RAIL_ACCENT_PATTERN =
  /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
