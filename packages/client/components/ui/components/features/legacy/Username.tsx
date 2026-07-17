import { For, Show, splitProps } from "solid-js";

import { User, UserBadges } from "stoat.js";

import { typography } from "../../design/Text";
import { ColouredText } from "../../utils/ColouredText";

/**
 * Sloga brand palette, in wordmark order (S l • g a)
 */
const BRAND_COLOURS = ["#3BB8ED", "#F5870D", "#27A163", "#CF2A27", "#C05FC8"];

/**
 * Whether this user's name should render in the Sloga brand colours
 * (staff accounts carrying the Developer or Founder badge)
 */
export function isSlogaStaff(user?: User | null) {
  return (
    ((user?.badges ?? 0) & (UserBadges.Developer | UserBadges.Founder)) !== 0
  );
}

type Props = {
  /**
   * Username
   */
  username?: string;

  /**
   * Text colour
   */
  colour?: string;

  /**
   * Render each letter in the Sloga brand palette (staff accounts)
   */
  brand?: boolean;
};

/**
 * Username
 *
 * @deprecated this seems unideal
 */
export function Username(props: Props) {
  const [local, remote] = splitProps(props, ["username", "colour", "brand"]);

  return (
    <span {...remote} class={typography({ class: "label", size: "large" })}>
      <Show
        when={local.brand}
        fallback={
          <ColouredText colour={local.colour!}>{local.username}</ColouredText>
        }
      >
        <For each={[...(local.username ?? "")]}>
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
      </Show>
    </span>
  );
}
