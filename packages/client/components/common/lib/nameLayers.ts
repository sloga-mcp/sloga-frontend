import type { NameStyle } from "stoat.js";

/**
 * What a rendered name should look like once every source of styling has been
 * weighed against the others
 *
 * - `plain`: the bare name, no personal styling at all
 * - `brand`: the staff brand-letter rendering, plus font and effect
 * - `styled`: an optional fill color, plus font and effect
 */
export type NameLayers = {
  mode: "plain" | "brand" | "styled";
  /** Fill color; only ever set in `styled` mode */
  colour?: string;
  /** Font and effect only; the fill color lives in `colour` */
  style?: NameStyle;
};

/**
 * Decide how a name renders: masquerade > brand > role color > personal
 * color > fallback color. Font and effect are kept at every level except
 * masquerade, where the message is presented as someone else and nothing
 * personal may leak through.
 *
 * `style` is trusted as-is: the server only sends the parts the user's perks
 * allow, so no perk check happens here.
 *
 * `fallbackColour` is a badge color (the Founding Streamer violet): it never
 * beats a role or a color the user picked, and a masquerade or the staff
 * brand ignores it.
 */
export function resolveNameLayers(input: {
  masquerade?: boolean;
  brand?: boolean;
  roleColour?: string | null;
  style?: NameStyle;
  fallbackColour?: string;
}): NameLayers {
  if (input.masquerade) return { mode: "plain" };

  const style: NameStyle = {};
  if (input.style?.font) style.font = input.style.font;
  if (input.style?.effect) style.effect = input.style.effect;
  const hasStyle = style.font !== undefined || style.effect !== undefined;

  if (input.brand) {
    return hasStyle ? { mode: "brand", style } : { mode: "brand" };
  }

  const layers: NameLayers = { mode: "styled" };
  const colour =
    input.roleColour || input.style?.colour || input.fallbackColour;
  if (colour) layers.colour = colour;
  if (hasStyle) layers.style = style;
  return layers;
}
