import { For, JSX, Match, Switch, createMemo } from "solid-js";

import type { ServerMember, User } from "stoat.js";

import { resolveNameLayers } from "@revolt/common/lib/nameLayers";
import {
  nameStyleClass,
  permittedNameStyle,
} from "@revolt/common/lib/nameStyle";
import { useState } from "@revolt/state";

import { ColouredText } from "../utils/ColouredText";
import {
  FOUNDING_STREAMER_COLOUR,
  isFoundingStreamer,
} from "../utils/foundingStreamer";

/**
 * Sloga brand palette, in wordmark order (S l • g a)
 */
const BRAND_COLOURS = ["#3BB8ED", "#F5870D", "#27A163", "#CF2A27", "#C05FC8"];

/**
 * A user's name with every applicable layer of styling
 *
 * Precedence: a masquerade shows the name in its own color (if any) with
 * nothing personal; staff get the brand letters; otherwise the role color
 * wins over the user's own color, and a Founding Streamer with neither gets
 * the violet. Font and effect apply everywhere except under a masquerade.
 *
 * The user's name style is trusted as sent: the server only includes the
 * parts their perks allow, and `User.perks` is not known for anyone but the
 * session user.
 *
 * Typography is inherited from the surrounding element.
 */
export function DisplayName(props: {
  /**
   * User the name belongs to, source of the personal name style
   */
  user?: User;

  /**
   * Server member, source of the role color
   */
  member?: ServerMember;

  /**
   * Text to render
   */
  name: string;

  /**
   * Name comes from a masquerade: no personal style, only its own color
   */
  masquerade?: boolean;

  /**
   * Masquerade color; used only when `masquerade` is set
   */
  colour?: string | null;

  /**
   * Render each letter in the Sloga brand palette (staff accounts)
   */
  brand?: boolean;

  /**
   * Allow the effect to animate (still subject to the user's setting)
   */
  animate?: boolean;
}): JSX.Element {
  const state = useState();

  const layers = createMemo(() =>
    resolveNameLayers({
      masquerade: props.masquerade,
      brand: props.brand,
      roleColour: props.member?.roleColour,
      style: permittedNameStyle(props.user?.nameStyle),
      fallbackColour: isFoundingStreamer(props.user)
        ? FOUNDING_STREAMER_COLOUR
        : undefined,
    }),
  );

  const animate = () =>
    props.animate === true &&
    state.settings.getValue("appearance:name_effects") === true;

  const classList = () => nameStyleClass(layers().style, undefined, animate());

  return (
    <span class={classList() || undefined}>
      <Switch
        fallback={
          <ColouredText colour={layers().colour}>{props.name}</ColouredText>
        }
      >
        <Match when={layers().mode === "plain"}>
          <ColouredText colour={props.colour ?? undefined}>
            {props.name}
          </ColouredText>
        </Match>
        <Match when={layers().mode === "brand"}>
          <For each={[...props.name]}>
            {(character, index) => (
              <span
                style={{
                  color: BRAND_COLOURS[index() % BRAND_COLOURS.length],
                }}
              >
                {character}
              </span>
            )}
          </For>
        </Match>
      </Switch>
    </span>
  );
}
