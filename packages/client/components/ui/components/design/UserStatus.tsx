import { Show } from "solid-js";

import type { API } from "stoat.js";
import { styled } from "styled-system/jsx";

import { usePresenceText } from "./presenceText";

/**
 * Presence values we render.
 *
 * `stoat-api` is a published package, so its `Presence` union still only knows
 * the five upstream presences; the two Sloga-only ones are added here. Values
 * coming off `User.presence` are typed as the narrow union but may carry these
 * at runtime.
 */
export type PresenceValue = API.Presence | "LookingForGroup" | "LookingForMore";

export type Props = {
  /**
   * User we are dealing with
   * @default Invisible
   */
  status?: PresenceValue;

  /**
   * Do not explain the dot on hover: for places that already name the
   * presence next to it (your own presence picker) or where the dot is
   * decoration rather than someone's status
   */
  noTooltip?: boolean;
};

/**
 * Overlays user status in current SVG
 *
 * Hovering the dot shows the presence name and what it means. The tooltip
 * goes through the `use:floating` directive, never the `Tooltip` component:
 * that would import `floating/Tooltip`, which imports this barrel back, and
 * the cycle blanks the page.
 */
const UserStatusGraphic = (props: Props) => {
  const presence = usePresenceText();

  /**
   * Convert status to lower case
   */
  const statusLowercase = () => props.status?.toLowerCase() ?? "invisible";

  /**
   * The visible dot
   */
  const dot = () => (
    <circle
      cx="27"
      cy="27"
      r="5"
      fill={`var(--brand-presence-${statusLowercase()})`}
      mask={`url(#accessible-status-${statusLowercase()})`}
    />
  );

  return (
    <Show when={!props.noTooltip} fallback={dot()}>
      <g
        use:floating={{
          tooltip: {
            placement: "top",
            content: () => (
              <PresenceTooltip>
                <PresenceName>{presence.label(props.status)}</PresenceName>
                <span>{presence.description(props.status)}</span>
              </PresenceTooltip>
            ),
            aria: `${presence.label(props.status)}, ${presence.description(props.status)}`,
          },
        }}
      >
        {/* Transparent hit area the size of the avatar's cut-out, so the
            5px dot is not a pixel hunt */}
        <circle cx="27" cy="27" r="7" fill="transparent" />
        {dot()}
      </g>
    </Show>
  );
};

/**
 * Stand-alone user status element
 */
export function UserStatus(props: Props & { size: string }) {
  return (
    <svg viewBox="22 22 10 10" height={props.size}>
      <UserStatusGraphic {...props} />
    </svg>
  );
}

UserStatus.Graphic = UserStatusGraphic;

/**
 * Tooltip body: presence name over its meaning
 */
const PresenceTooltip = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    maxWidth: "240px",
  },
});

/**
 * Presence name in the tooltip
 */
const PresenceName = styled("span", {
  base: {
    fontWeight: 600,
  },
});
