import { createMemo } from "solid-js";

import { styled } from "styled-system/jsx";

import {
  type ProtectedShieldState,
  shieldPresentation,
} from "../../../../client/protectedShield";
import { Symbol } from "../../utils/Symbol";

/**
 * Protected channel shield glyph (W4 plan D14, lane C1).
 *
 * Glyph and hue come only from `shieldPresentation`; nothing is re-derived
 * here. The hue is a CSS variable defined once in `LoadTheme.tsx` (C14).
 * Static by design: no animation and no transition in any state.
 *
 * Imports are file paths, never a barrel (an import cycle inside
 * `components/ui` would blank the app), and the only `styled` call uses a
 * string tag.
 */
interface Props {
  state: ProtectedShieldState;
  /** A number is pixels; a string is any CSS length. Default: inherit. */
  size?: number | string;
  /** Passed to `shieldPresentation`; it never changes the glyph. */
  tauriE2eeOff?: boolean;
  /**
   * Accessible name and tooltip. Without it the icon is decorative and the
   * caller must convey the state in text.
   */
  title?: string;
}

export function ProtectedShieldIcon(props: Props) {
  const presentation = createMemo(() =>
    shieldPresentation(props.state, { tauriE2eeOff: props.tauriE2eeOff }),
  );

  const fontSize = () =>
    typeof props.size === "number" ? `${props.size}px` : props.size;

  return (
    <Shield
      data-protected-shield={props.state}
      role={props.title ? "img" : undefined}
      aria-label={props.title || undefined}
      aria-hidden={props.title ? undefined : "true"}
      title={props.title || undefined}
      style={{
        color: `var(${presentation().hueVar})`,
        "font-size": fontSize(),
      }}
    >
      <Symbol>{presentation().glyph}</Symbol>
    </Shield>
  );
}

const Shield = styled("span", {
  base: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    lineHeight: 1,
    animation: "none",
    transition: "none",
  },
});
